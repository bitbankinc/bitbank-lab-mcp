/**
 * 階梯上の view の `content` は下位 view の上位集合である — の横断テスト。
 *
 * 根拠: docs/internal/view-vocabulary-unification.md §3-2 規約 3
 *   「detailed の content は summary の内容を含み、full は detailed を含む。
 *     フッタ・警告・最終値のような定型情報を上位ビューで落とさない。」
 *
 * なぜ content か（同 §2-0）: `content[0].text` が LLM への唯一のチャネル
 * （`.claude/rules/tools.md`）。上位 view で定型情報が消えるのは「表示が変わる」ではなく
 * 「LLM が情報を失う」に等しい。実際 P3 は
 *   - `get_flow_metrics(buckets/full)`: 最終約定価格・スパイク上位 3 件・4 行フッタが消える
 *   - `get_volatility_metrics(detailed/full)`: 4 行フッタが消える
 * という形で発生していた（§1-3 / §1-5）。本テストはその再発防止。
 *
 * **検証方式は §6-6 に従う。文字列長の比較（len(summary) <= len(detailed) <= len(full)）は使わない。**
 * 長さは上位集合性を検証しない——フッタが落ちても明細が増えれば通ってしまう（P3 はまさにその形）。
 * 逆に文言を 1 語変えただけで落ちる脆いテストにもなる。代わりに
 *   - 定型要素（📌 フッタ行 / ⚠️・ℹ️ 注記行 / ヘッダ主要フィールド）を抽出・正規化した集合の包含
 *   - 列挙されるレコード（バケット行）は識別キー集合の包含
 * で検証する。
 *
 * **階梯外の view は対象にしない**（§3-2 規約 3）。`get_volatility_metrics` の `beginner` と
 * `detect_patterns` の `debug` は定義上「出力の置換」であり、上位集合である必要がない。
 * 平易な言い換えである `beginner` に専門用語のフッタを足すのは、その view の目的に反する。
 *
 * 対象ツールは P3 が指摘した 2 つ（PR 2）＋ `detect_patterns`（PR 3 の受け入れ基準②で、
 * 本ファイルのヘルパをそのまま使って横展開した。§5-5）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// detect_patterns は上流ツールをモックして、パターン件数と warning をフィクスチャで固定する
// （実データ経由だと検出件数が 5 件を超えるか保証できず、detailed ⊊ full を検証できない）。
vi.mock('../tools/detect_patterns.js', () => ({ default: vi.fn() }));

import { dayjs } from '../lib/datetime.js';
import { toolDef as detectPatternsTool } from '../src/handlers/detectPatternsHandler.js';
import {
	CANDIDATE_BREAKDOWN_LABEL,
	DETECTION_ROUTE_LABEL,
	EFFECTIVE_PARAMS_LABEL,
	REDUCTION_LABEL,
	REJECTION_CROSS_TOTAL_LABEL,
	REJECTION_SUMMARY_LABEL,
	TRIPLE_HS_NO_CANDIDATE_NOTE,
} from '../src/handlers/detectPatternsViewsHandler.js';
import { toolDef as volatilityTool } from '../src/handlers/getVolatilityMetricsHandler.js';
import detectPatterns from '../tools/detect_patterns.js';
import { toolDef as flowMetricsTool } from '../tools/get_flow_metrics.js';

// ── 定型要素の抽出・正規化（§6-6） ────────────────────────

/**
 * フッタ行（📌）と警告・注記行（⚠️ / ℹ️）。行そのものを要素とし、正規化は trim のみ。
 * これらは view に依存しない定型文なので、行単位でそのまま突き合わせられる。
 */
function annotationLines(text: string): string[] {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => /^(?:📌|⚠️|ℹ️)/u.test(line));
}

/**
 * ヘッダの主要フィールド（pair / 期間 / 最終値）を**書式非依存のキー**に正規化する。
 * 同じ値が view ごとに違う書式で出るため、ラベルと区切りを落として値だけを比較する:
 *   - pair: `BTC/JPY`（formatSummary）と `BTC_JPY`（各 view の再構築ヘッダ）
 *   - 最終値: `中値=10,377,712.969円`（formatSummary）と `close=10,377,712.969`（volatility detailed）
 */
function headerFields(text: string): string[] {
	const fields: string[] = [];
	const pair = text.match(/\b([A-Z]{2,6})[_/]([A-Z]{2,6})\b/u);
	if (pair) fields.push(`pair=${pair[1]}_${pair[2]}`);
	const timeframe = text.match(/\[(\d+(?:min|hour|day|week|month))\]/u);
	if (timeframe) fields.push(`timeframe=${timeframe[1]}`);
	const lastValue = text.match(/(?:中値|close)=([\d,]+(?:\.\d+)?)/u);
	if (lastValue) fields.push(`lastValue=${lastValue[1].replaceAll(',', '')}`);
	return fields;
}

/**
 * 期間行（`スキャン範囲:` / `検出パターン分布期間:`）。detect_patterns がヘッダ直下に出す定型 2 行で、
 * 2 行はそれぞれ「検出器に渡した足のレンジ」と「検出されたパターンの分布」という**別の量**を指す。
 * 旧ラベル「検出対象期間」が前者と誤読されていたので、両方が全 view に出続けることをここで固定する。
 */
function periodLines(text: string): string[] {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => /^(?:スキャン範囲|検出パターン分布期間):/u.test(line));
}

/**
 * 実効パラメータ行（`実効パラメータ（入力値ではない）: …`）。issue #184 欠陥 C で追加した定型 1 行で、
 * **`content[0].text` が LLM への唯一のチャネルである以上、ここが実効値の唯一の届け先**
 * （`meta.effective_params` は structuredContent 側で LLM からは見えない）。
 * `summary` に出さないと規約 3（上位集合）違反になるので、全 view に出続けることをここで固定する。
 */
function effectiveParamsLines(text: string): string[] {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith(EFFECTIVE_PARAMS_LABEL));
}

/**
 * 検出経路行（`検出経路: strict N 件 / relaxed フォールバック由来 M 件（…）`）。issue #191 B の定型 1 行。
 *
 * relaxed フォールバック由来かどうかの provenance（`data.patterns[]._fallback`）は
 * structuredContent 側にしか無く LLM からは見えない。**`summary` は個々のパターン行を出さない view**
 * なので、この集計行が summary における唯一の provenance のチャネルになる。
 * `detailed` / `full` だけに出すと規約 3（上位集合）違反になるため、全 view に出続けることをここで固定する。
 */
function detectionRouteLines(text: string): string[] {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith(`${DETECTION_ROUTE_LABEL}:`));
}

/**
 * 縮小段の内訳行（`検出内訳: 検出 N 件 → 重複統合 -M → …`）。issue #200 要件 E の定型 1 行。
 *
 * `meta.reduction` は structuredContent 側にしかなく LLM からは見えない。`summary` は
 * 個々のパターン行を出さない view なので、この集計行が summary における唯一の届け先になる。
 * `detailed` / `full` だけに出すと規約 3（上位集合）違反になるため、全 view に出続けることを固定する。
 */
function reductionLines(text: string): string[] {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith(`${REDUCTION_LABEL}:`));
}

/**
 * `debug` の棄却理由の集計ブロック（issue #191 A / #193 B-1）の見出し 3 行。
 * **階梯外の view の要素なので `fixedElements` には入れない**（上位集合の対象ではない。§3-2 規約 3）。
 * 抽出関数だけ他の定型要素と同じ形で置き、`debug` 側の固定に使う。
 *
 * `▼ reason 横断合計`（#193 B-1）も同じ定型要素として数える。**この行が消えると LLM は
 * 横断合計を手で足し、実測で外す**ので、`▼ 候補の内訳` / `▼ 棄却理由の内訳` と同格に扱う。
 */
function rejectionSummaryLines(text: string): string[] {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter(
			(line) =>
				line.startsWith(CANDIDATE_BREAKDOWN_LABEL) ||
				line.startsWith(REJECTION_SUMMARY_LABEL) ||
				line.startsWith(REJECTION_CROSS_TOTAL_LABEL),
		);
}

/**
 * 状態行（`- 状態: …`）。パターン 1 件ごとに出る定型 1 行で、issue #286 以降は
 * **`status` の日本語に理由コードを併記する**（`無効（…: peak_after_last_pivot）`）。
 *
 * `invalidReason` は `structuredContent` 側にしか無く LLM からは見えないので、この行が
 * 「なぜ無効になったか」の唯一のチャネルになる。上位 view で文言が変わる / 落ちると
 * LLM が理由を取り違える（#286 の実機症状そのもの）ため、他の定型要素と同じく包含で固定する。
 *
 * **`summary` はパターン明細を 1 件も出さない view** なので、ここは空集合になる（＝下位集合として常に成立）。
 */
function statusLines(text: string): string[] {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith('- 状態:'));
}

/**
 * ターゲット行（`- ターゲット: …`）。パターン 1 件ごとに出る定型 1 行で、issue #288 Phase 2 以降は
 * **到達 / 未到達（走査完了）/ 未到達（走査中）/ 出力なし**の 4 形のいずれかを事実として書く。
 *
 * `targetFirstReachBars` / `targetScanBars` / 交絡 2 キーは `structuredContent` 側にしか無く
 * LLM からは見えないので、この行が「届いたのか・まだ足が無いのか・帰属が切れているのか」の
 * 唯一のチャネルになる。上位 view で文言が変わる / 落ちると LLM が到達を取り違えるため、
 * 他の定型要素と同じく包含で固定する。
 *
 * **`ターゲット価格:` 行とは別の行。** 前方一致が食い合わないよう `- ターゲット: ` まで見る。
 * **`summary` はパターン明細を 1 件も出さない view** なので、ここは空集合になる。
 */
function targetLines(text: string): string[] {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith('- ターゲット: '));
}

/**
 * view の content から定型要素（注記行 + 期間行 + 実効パラメータ行 + 検出経路行 + 状態行 +
 * ターゲット行 + ヘッダ主要フィールド）を抽出した集合。
 */
function fixedElements(text: string): Set<string> {
	return new Set([
		...annotationLines(text),
		...periodLines(text),
		...effectiveParamsLines(text),
		...detectionRouteLines(text),
		...reductionLines(text),
		...statusLines(text),
		...targetLines(text),
		...headerFields(text),
	]);
}

/**
 * バケット行の識別キー（表示時刻）。行の文言ではなくキー集合で比較するので、
 * 表示形式を変えてもテストは落ちない（§6-6「レコード集合の包含」）。
 * 欠損バケット行（`… データなし（欠損区間）`）も 1 レコードとして数える。
 */
function bucketRowKeys(text: string): Set<string> {
	const keys = new Set<string>();
	for (const line of text.split('\n')) {
		const m = line.match(/^(.+?)\s{2}(?:buy=|データなし)/u);
		if (m) keys.add(m[1]);
	}
	return keys;
}

/**
 * 検出パターン行の識別キー（`type@開始日~終了日`）。§6-6 の「レコード集合の包含」で
 * 指定されている `pattern type + range` をそのまま使う——表示上の連番（`1.` `2.` …）を
 * キーに含めると並び替えや件数変更で落ちる脆いテストになるため。
 *
 * 1 パターンは `N. <type> (パターン整合度: X)` の見出し行と、それに続く
 * `- 期間: YYYY-MM-DD ~ YYYY-MM-DD` 行の組で出る。見出し行が無い view（summary）では
 * 何も抽出されない（= 空集合）。
 */
function patternRowKeys(text: string): Set<string> {
	const keys = new Set<string>();
	let pendingType: string | null = null;
	for (const line of text.split('\n')) {
		const title = line.match(/^\d+\.\s+(\S+)\s+\(パターン整合度:/u);
		if (title) {
			pendingType = title[1];
			continue;
		}
		const period = line.match(/^\s*-\s*期間:\s*(\S+)\s*~\s*(\S+)/u);
		if (period && pendingType) {
			keys.add(`${pendingType}@${period[1]}~${period[2]}`);
			pendingType = null;
		}
	}
	return keys;
}

/**
 * pivot 明細行の識別キー（`役割ラベル@表示日時`）。issue #234 で `triple_*` / H&S 系にも
 * 出るようになった `   - 山1: 2026-09-01 高値 …` 形式の行を拾う。
 *
 * **キーに価格を含めない。** 価格の書式（`終値 X / 高値 Y（判定は高値基準）` と
 * `高値 Y（判定は高値基準）`）は `formatPivotPrices` の分岐で変わるので、
 * 書式を変えただけで落ちる脆いテストになる。役割ラベルと点の同定（日時）で足りる。
 */
function pivotRowKeys(text: string): Set<string> {
	const keys = new Set<string>();
	for (const line of text.split('\n')) {
		const m = line.trim().match(/^-\s*(山\d?|谷\d?|左肩|頭|右肩(?:\(暫定\))?|谷（頭後）|山（頭後）):\s+(\S+)/u);
		if (m) keys.add(`${m[1]}@${m[2]}`);
	}
	return keys;
}

/** `lower` の要素が全て `upper` にあることを検証する（欠けているものを失敗メッセージに出す）。 */
function expectSupersetOf(upper: Set<string>, lower: Set<string>, label: string): void {
	const missing = [...lower].filter((element) => !upper.has(element));
	expect(missing, `${label}: 下位 view にあった要素が上位 view で消えている`).toEqual([]);
}

// ── fixtures ──────────────────────────────────────────────

/**
 * 約定 5 件（0〜4 分）。末尾だけ出来高が大きく、スパイク（z >= 2）が 1 件立つ。
 * 「スパイク上位 3 件の詳細」が上位 view で消えていないことを検証するために必要。
 */
const TX_ROWS = [0, 1, 2, 3, 4].map((i) => ({
	price: String(5_000_000 + i * 100),
	amount: i === 4 ? '1.0' : '0.1',
	side: i % 2 === 0 ? 'buy' : 'sell',
	executed_at: String(1_700_000_000_000 + i * 60_000),
}));

/** OHLCV 行: [open, high, low, close, volume, timestampMs]。1day 足を count 本。 */
function ohlcvRows(count: number): string[][] {
	const startMs = Date.UTC(2025, 0, 1);
	const rows: string[][] = [];
	let prev = 10_000_000;
	for (let i = 0; i < count; i++) {
		const close = prev * (1 + Math.sin(i * 0.5) * 0.02);
		rows.push([
			String(prev),
			String(close * 1.01),
			String(close * 0.99),
			String(close),
			String(100 + i),
			String(startMs + i * 86_400_000),
		]);
		prev = close;
	}
	return rows;
}

const CANDLE_COUNT = 60;
/** ohlcvRows(CANDLE_COUNT) の最終足の開始時刻（= 2025-01-01 + 59 日）。 */
const LAST_BAR_MS = Date.UTC(2025, 0, 1) + (CANDLE_COUNT - 1) * 86_400_000;

function mockFetchJson(payload: unknown) {
	vi.spyOn(globalThis, 'fetch').mockResolvedValue({
		ok: true,
		status: 200,
		statusText: 'OK',
		json: async () => payload,
	} as unknown as Response);
}

const mockTransactions = () => mockFetchJson({ success: 1, data: { transactions: TX_ROWS } });
const mockCandles = () =>
	mockFetchJson({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: ohlcvRows(CANDLE_COUNT) }] } });

/** 同一入力で各 view を実行し、view → content[0].text を返す。 */
async function collectContentByView<V extends string>(
	views: readonly V[],
	run: (view: V) => Promise<unknown>,
): Promise<Map<V, string>> {
	const out = new Map<V, string>();
	for (const view of views) {
		const res = (await run(view)) as { content?: Array<{ text: string }> };
		const text = res?.content?.[0]?.text;
		if (typeof text !== 'string') throw new Error(`view=${view} の content[0].text が取れない`);
		out.set(view, text);
	}
	return out;
}

const runFlow = (view: string, bucketsN = 2) => {
	mockTransactions();
	return flowMetricsTool.handler({ pair: 'btc_jpy', limit: 5, date: '20240101', bucketMs: 60_000, view, bucketsN });
};

/**
 * 検出パターン 7 件（`detailed` の上限 5 件を超える件数）＋ 取得層 / 計算層の warning。
 *
 * - 7 件にするのは `detailed`（上位 5 件）⊊ `full`（全件）を成立させるため。
 *   5 件以下だと両者が同じ集合になり、包含テストが自明に通ってしまう。
 * - warning を入れるのは `fixedElements` の注記行が空集合にならないようにするため
 *   （空集合同士の包含は何も検証していないのと同じ）。
 * - `structureRange` / `confirmation` / `precedingTrend` は持たせない——
 *   持たせると期間行が `文脈期間` / `形成期間` に分岐し、`patternRowKeys` が使う
 *   `- 期間: A ~ B` 行が出なくなる。
 */
const PATTERN_COUNT = 7;
/**
 * 縮小段の `detected`（既定 7 件のときの値）。各段の減算合計 4（-2 dedup / -1 current /
 * -0 lifecycle / -1 triple×H&S）を引くと `PATTERN_COUNT` になる = production の不変条件を満たす。
 */
const REDUCTION_DETECTED_BASE = 11;
/** `debug` view が `【Swings】` に描画するスイング（1 本だけ入れて行の有無を検証可能にする）。 */
const DEBUG_SWING = { kind: 'H', idx: 3, price: 100, isoTime: '2026-01-05T00:00:00.000Z' } as const;

type PatternsFixture = Awaited<ReturnType<typeof detectPatterns>>;
/**
 * `meta.debug.candidates` の 1 件。**production の出力型から導出する**（手書きの shape に落とさない）。
 * `meta` は ok / fail の union なので、`pair` を持つ ok 側だけを取り出してから辿る。
 */
type OkPatternMeta = Extract<PatternsFixture['meta'], { pair: string }>;
type DebugCandidate = NonNullable<NonNullable<OkPatternMeta['debug']>['candidates']>[number];

/**
 * `debug` の集計ブロック（#191 A）を描画させるための候補。**accepted / rejected の両方**を入れる
 * ——片方だけだと分母の書き分け（accepted N 件 + rejected M 件）を検証できない。
 */
const DEBUG_CANDIDATES: DebugCandidate[] = [
	{ type: 'double_top', accepted: true },
	{ type: 'double_top', accepted: false, reason: 'peaks_not_equal' },
	{ type: 'double_top', accepted: false, reason: 'peaks_not_equal' },
	{ type: 'triple_bottom', accepted: false, reason: 'valleys_missing' },
];

/** relaxed フォールバック由来の provenance（#191 B）。既定フィクスチャの 7 件のうち先頭 2 件に付ける。 */
const RELAXED_TAG = 'relaxed_double_x1.3';

/**
 * 反転系 4 件（issue #234）。既定の 7 件（double 2 型）に**追加**する形で使う——
 * 既存 7 件の type / confidence / 並びに依存した assert が多数あり、差し替えると
 * 本 issue と無関係な失敗を撒くため。
 *
 * 4 件の内訳は「完成 5 点」と「形成中 4 点」を triple / H&S で 1 件ずつ:
 *
 * | type | status | 点数 | `pivots` の並び |
 * |---|---|--:|---|
 * | `triple_top` | completed | 5 | `[山1, 谷1, 山2, 谷2, 山3]` |
 * | `triple_bottom` | forming | 4 | `[谷1, 山1, 谷2, 山2]`（5 点版の先頭 4 つ） |
 * | `head_and_shoulders` | forming | 4 | `[左肩, 頭, 谷（頭後）, 右肩]` — **頭が 2 番目** |
 * | `inverse_head_and_shoulders` | completed | 5 | `[左肩, 山1, 頭, 山2, 右肩]` |
 *
 * `kind` は production と同じ並びにしてある。形成中 H&S だけ `H, H, L, H` で
 * 左肩と頭が同じ `kind` になる（`kind` から役割を導けないことの現物）。
 *
 * `confidence` は既定 7 件の最小（0.78）より下げて**末尾に並ぶ**ようにしてある
 * ——`detailed` の上限 5 件は既定 7 件の側で埋まり、反転系は `full` にだけ出る。
 * 0.6 以上に保っているのは低 confidence の ⚠️ 行を混ぜないため（規約 3 の検証対象である
 * 注記行の集合が本 issue と無関係に増えるのを避ける）。
 *
 * `structureRange` / `confirmation` / `precedingTrend` を持たせないのは既定 7 件と同じ理由
 * （持たせると期間行が分岐し `patternRowKeys` が使う `- 期間: A ~ B` 行が出なくなる）。
 */
const REVERSAL_PIVOT_KINDS = {
	triple_top: ['H', 'L', 'H', 'L', 'H'],
	triple_bottom: ['L', 'H', 'L', 'H'],
	head_and_shoulders: ['H', 'H', 'L', 'H'],
	inverse_head_and_shoulders: ['L', 'H', 'L', 'H', 'L'],
} as const satisfies Record<string, readonly ('H' | 'L')[]>;

/** 反転系 4 件の `pivots` の idx。既定 7 件（pivots 無し）と衝突しない帯に置く。 */
const REVERSAL_PIVOT_IDXS = {
	triple_top: [100, 110, 120, 130, 140],
	triple_bottom: [150, 160, 170, 180],
	head_and_shoulders: [200, 210, 220, 230],
	inverse_head_and_shoulders: [250, 260, 270, 280, 290],
} as const satisfies Record<keyof typeof REVERSAL_PIVOT_KINDS, readonly number[]>;

const REVERSAL_STATUS = {
	triple_top: 'completed',
	triple_bottom: 'forming',
	head_and_shoulders: 'forming',
	inverse_head_and_shoulders: 'completed',
} as const satisfies Record<keyof typeof REVERSAL_PIVOT_KINDS, string>;

type ReversalType = keyof typeof REVERSAL_PIVOT_KINDS;
const REVERSAL_TYPES = Object.keys(REVERSAL_PIVOT_KINDS) as ReversalType[];

/** pivot の idx → isoTime。`buildIdxToIso` が読むのは `meta.debug.swings` だけなので、そこに載せる。 */
function reversalSwingIso(idx: number): string {
	// 03:00Z（JST 12:00）に置いて、既定 tz でも UTC でも暦日がずれないようにする。
	return new Date(Date.UTC(2026, 2, 1, 3) + idx * 86_400_000).toISOString();
}

function reversalPatterns() {
	return REVERSAL_TYPES.map((type, i) => ({
		type,
		confidence: 0.7 - i * 0.02,
		timeframe: '1day' as const,
		timeframeLabel: '日足',
		range: {
			start: dayjs.utc('2026-03-01T00:00:00Z').add(i, 'day').toISOString(),
			end: dayjs.utc('2026-03-20T00:00:00Z').add(i, 'day').toISOString(),
		},
		status: REVERSAL_STATUS[type],
		pivots: REVERSAL_PIVOT_IDXS[type].map((idx, j) => ({
			idx,
			price: 10_000_000 + idx * 1_000,
			kind: REVERSAL_PIVOT_KINDS[type][j],
			extremePrice: 10_000_000 + idx * 1_000,
		})),
	}));
}

/** 反転系 4 件の pivot を日付解決させるための swing 群（`meta.debug.swings` に足す）。 */
function reversalSwings() {
	return REVERSAL_TYPES.flatMap((type) =>
		REVERSAL_PIVOT_IDXS[type].map((idx, j) => ({
			kind: REVERSAL_PIVOT_KINDS[type][j],
			idx,
			price: 10_000_000 + idx * 1_000,
			isoTime: reversalSwingIso(idx),
		})),
	);
}

/**
 * ターゲット行の 3 形（到達 / 未到達・走査完了 / 未到達・走査中）を出すための追加フィールド。
 * 添字 0〜2 にだけ付ける。**`breakoutTarget` が無ければ行そのものが出ない**ので、
 * 4 件目以降は「行が出ないパターン」として残す（包含の比較対象が全件になるのを避ける）。
 */
const TARGET_FIXTURE_BY_INDEX: Record<number, Record<string, unknown>> = {
	0: {
		breakoutTarget: 12_930_667,
		targetMethod: 'pattern_height',
		targetReachedPct: 273,
		targetReached: true,
		targetFirstReachBars: 12,
		targetFirstReachDate: '2026-01-15T00:00:00.000Z',
		targetScanBars: 60,
		targetScanComplete: true,
	},
	1: {
		breakoutTarget: 10_149_705,
		targetMethod: 'pattern_height',
		targetReachedPct: 26,
		targetReached: false,
		targetScanBars: 60,
		targetScanComplete: true,
		targetOppositeBreakoutInWindow: [{ type: 'triangle_ascending', direction: 'up' as const, barsAfterBreakout: 28 }],
	},
	2: {
		breakoutTarget: 13_050_465,
		targetMethod: 'pattern_height',
		targetReachedPct: 61,
		targetReached: false,
		targetScanBars: 25,
		targetScanComplete: false,
	},
	// 4 形目（出力なし）。**3 形だけだと、この行が上位 view から消えても包含テストが通る**
	// （`length > 0` も `full ⊇ detailed` も他の 3 形で満たされてしまう）。
	3: {
		breakoutTarget: 11_000_000,
		targetMethod: 'pattern_height',
		targetProgressOmittedReason: 'degenerate_target_distance',
	},
};

// 戻り値を上流ツールの出力型で縛る。手書きフィクスチャが production の shape から
// 黙って drift すると、この層（ツール横断の契約検証）の assert が全て素通りするため。
function patternsFixture(
	opts: { relaxed?: number; candidates?: DebugCandidate[]; reversals?: boolean } = {},
): PatternsFixture {
	const relaxed = opts.relaxed ?? 0;
	const candidates = opts.candidates ?? [];
	// 反転系 4 件（#234）は**追加**。既定 7 件はそのまま残すので、既存の assert は一切動かない。
	const extra = opts.reversals ? reversalPatterns() : [];
	const swings = [{ ...DEBUG_SWING }, ...(opts.reversals ? reversalSwings() : [])];
	const total = PATTERN_COUNT + extra.length;
	// **`detected` も一緒に上げる。** 縮小段は `detected - 各段の減算 === output` が
	// production の不変条件で、`output` だけ増やすと「11 detected から 4 件引いて 11 出力」という
	// 実際には起きない waterfall になる。矛盾したまま置くと、この層（ツール横断の契約検証）が
	// 応答契約の回帰を隠す側に回る。各段の減算値は据え置き（0 のとき省く / 省かない分岐を
	// 1 フィクスチャで見ている構成を壊さないため）。
	const detected = REDUCTION_DETECTED_BASE + extra.length;
	return {
		ok: true,
		summary: 'ok',
		data: {
			patterns: [
				// `as const` は #234 で反転系の spread を足したときに要るようになった——配列リテラルが
				// union の spread になると `PatternsFixture` からの文脈型が効かず、`type` /
				// `status` / `timeframe` が `string` に広がって代入不能になる。値は不変。
				...Array.from({ length: PATTERN_COUNT }, (_, i) => ({
					type: (i % 2 === 0 ? 'double_top' : 'double_bottom') as 'double_top' | 'double_bottom',
					confidence: 0.9 - i * 0.02,
					timeframe: '1day' as const,
					timeframeLabel: '日足',
					range: {
						start: dayjs.utc('2026-01-01T00:00:00Z').add(i, 'day').toISOString(),
						end: dayjs.utc('2026-01-20T00:00:00Z').add(i, 'day').toISOString(),
					},
					status: 'completed' as const,
					// ターゲット行（#288 Phase 2）の 3 形を 1 フィクスチャに揃える。**先頭 3 件だけ**に
					// 付けるので、`breakoutTarget` を持たないパターン（= 行が出ない側）も残る。
					// これが無いと `targetLines` の抽出が空集合同士で自明に通る。
					...TARGET_FIXTURE_BY_INDEX[i],
					...(i < relaxed ? { _fallback: RELAXED_TAG } : {}),
				})),
				...extra,
			],
			overlays: { ranges: [] },
			warnings: [],
			statistics: {},
		},
		meta: {
			pair: 'btc_jpy',
			type: '1day',
			count: total,
			// `スキャン範囲` 行の元データ。bars は runPatterns の limit=180 とわざと食い違わせている
			// ——ヘッダの `{limit}本から` は要求本数であってスキャン本数ではない、という現状を隠さないため。
			scan: { start: '2025-07-21T00:00:00.000Z', end: '2026-01-26T00:00:00.000Z', bars: 190 },
			// 実効パラメータ行の元データ（#184）。1day の時間軸オート値。`swingDepth` だけ
			// 明示指定にしてあるのは、`auto` / `指定` の両方が 1 行に出る状態を固定するため。
			effective_params: {
				swingDepth: { value: 4, source: 'explicit' as const },
				minBarsBetweenSwings: { value: 4, source: 'auto' as const },
				tolerancePct: { value: 0.04, source: 'auto' as const },
				headProminencePct: { value: 0.04, source: 'auto' as const },
			},
			visualization_hints: { preferred_style: 'line', highlight_patterns: [] },
			// 縮小段の内訳行の元データ（issue #200 要件 E / #218 で 1 段追加）。11 detected → -2 dedup
			// → -1 current → -0 lifecycle → -1 triple×H&S 排他 → 7 output（PATTERN_COUNT と一致）。
			// `reversals` を足した場合は `detected` / `output` が同数ずつ増えて等式が保たれる。
			// `currentFiltered` を 0 超にして「0 のとき省く」分岐と両方を 1 フィクスチャで確認できる
			// ようにしてあり、`lifecycleExcluded` は 0 のまま（0 でも省かない側）に残してある。
			// `tripleHsCandidateCount`（#224 症状 1）は 1 以上 = 排他を実際に比較した側。
			reduction: {
				detected,
				dedupMerged: 2,
				currentFiltered: 1,
				lifecycleExcluded: 0,
				tripleHsExcluded: 1,
				tripleHsCandidateCount: 2,
				output: total,
			},
			warning: '取得層: 180本中20本が欠損しています',
			warnings: ['計算層: スイング検出に必要なバー数が不足しています'],
			// **cap トリムの申告 4 つは production（`tools/detect_patterns.ts`）が常に埋める。**
			// ここで省くと「総数の申告が無い」という production では起きない分岐を
			// ツール層のテストが固定してしまう（その分岐は formatter の単体テスト側で見る）。
			debug: {
				swings,
				candidates,
				candidatesTotal: candidates.length,
				candidatesOmitted: 0,
				swingsTotal: swings.length,
				swingsOmitted: 0,
			},
		},
	};
}

const runPatterns = (
	view: string,
	opts: { relaxed?: number; candidates?: DebugCandidate[]; reversals?: boolean } = {},
) => {
	vi.mocked(detectPatterns).mockResolvedValue(patternsFixture(opts));
	return detectPatternsTool.handler({ pair: 'btc_jpy', type: '1day', limit: 180, view });
};

const runVolatility = (view: string) => {
	mockCandles();
	return volatilityTool.handler({
		pair: 'btc_jpy',
		type: '1day',
		limit: 50,
		windows: [14, 20, 30],
		useLogReturns: true,
		annualize: true,
		tz: 'Asia/Tokyo',
		cacheTtlMs: 60_000,
		view,
	});
};

// ── tests ─────────────────────────────────────────────────

describe('階梯上の view の content は下位 view の上位集合（§3-2 規約 3）', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// ── get_flow_metrics: summary < buckets(= detailed) < full ────────
	// PR 3 で `buckets` は `detailed` の、`compact` は `full` + `nonZeroOnly=true` の
	// deprecated alias になった（§4-4）。ここは**旧値のまま**呼び続ける——alias 期間中は
	// 旧値を送るクライアントの content も階梯規約を満たしている必要があるため。
	// 写像そのものは tests/view-alias-mapping.test.ts が検証する。
	// （nonZeroOnly は量ではなく絞り込みなので階梯外。§3-4）

	it('get_flow_metrics: 定型要素が summary ⊆ buckets ⊆ full', async () => {
		const byView = await collectContentByView(['summary', 'buckets', 'full'] as const, (view) => runFlow(view));
		const [summary, buckets, full] = [byView.get('summary'), byView.get('buckets'), byView.get('full')] as string[];

		// 抽出が空振り（空集合同士で自明に通る）していないことを先に固定する
		const summaryElements = fixedElements(summary);
		expect([...summaryElements].filter((e) => e.startsWith('📌'))).toHaveLength(4);
		expect(summaryElements).toContain('pair=BTC_JPY');
		expect([...summaryElements].some((e) => e.startsWith('lastValue='))).toBe(true);

		expectSupersetOf(fixedElements(buckets), fixedElements(summary), 'buckets ⊇ summary');
		expectSupersetOf(fixedElements(full), fixedElements(buckets), 'full ⊇ buckets');
	});

	it('get_flow_metrics: バケット行のキー集合が summary ⊆ buckets ⊆ full', async () => {
		const byView = await collectContentByView(['summary', 'buckets', 'full'] as const, (view) => runFlow(view));
		const keys = {
			summary: bucketRowKeys(byView.get('summary') as string),
			buckets: bucketRowKeys(byView.get('buckets') as string),
			full: bucketRowKeys(byView.get('full') as string),
		};

		// summary はバケット行を出さない（= 空集合）。buckets は直近 N 件、full は全件。
		expect(keys.summary.size).toBe(0);
		expect(keys.buckets.size).toBe(2);
		expect(keys.full.size).toBe(5);
		expectSupersetOf(keys.buckets, keys.summary, 'buckets ⊇ summary（バケット行）');
		expectSupersetOf(keys.full, keys.buckets, 'full ⊇ buckets（バケット行）');
	});

	it('get_flow_metrics: buckets / full で最終約定価格・スパイク詳細・4 行フッタが消えない（P3 の回帰）', async () => {
		const byView = await collectContentByView(['summary', 'buckets', 'full'] as const, (view) => runFlow(view));
		const summary = byView.get('summary') as string;

		// フィクスチャが実際にスパイクを含んでいること（含まなければ以下の assert は無意味）
		expect(summary).toContain('スパイク1件:');

		for (const view of ['buckets', 'full'] as const) {
			const text = byView.get(view) as string;
			// 最終約定価格（formatSummary の 中値=）
			expect(text, `view=${view}`).toContain('中値=5,000,400円');
			// スパイク上位 3 件の詳細（件数と時刻・レベル・方向）
			expect(text, `view=${view}`).toContain('スパイク1件:');
			// 4 行フッタ
			expect(text, `view=${view}`).toContain('📌 含まれるもの:');
			expect(text, `view=${view}`).toContain('📌 含まれないもの:');
			expect(text, `view=${view}`).toContain('📌 補完ツール:');
			expect(text, `view=${view}`).toContain('📌 加工契約:');
			// バケット行の読み方（間隔・実取得範囲・Totals）は従来どおり残っている
			expect(text, `view=${view}`).toContain('Flow Metrics (bucketMs=60000)');
			expect(text, `view=${view}`).toContain('Totals: trades=5');
		}
	});

	it('get_flow_metrics: 取得層 ⚠️/ℹ️ と計算層 ⚠️ の注記行が buckets / full でも残る', async () => {
		const byView = await collectContentByView(['summary', 'buckets', 'full'] as const, (view) => runFlow(view));
		const summaryNotes = annotationLines(byView.get('summary') as string).filter((l) => !l.startsWith('📌'));

		// date 指定（要求 1440 分）に対し実データは 4 分しかないので、取得層・計算層の両方が立つ
		expect(summaryNotes.length).toBeGreaterThanOrEqual(2);
		for (const view of ['buckets', 'full'] as const) {
			const notes = new Set(annotationLines(byView.get(view) as string));
			expectSupersetOf(notes, new Set(summaryNotes), `${view} ⊇ summary（注記行）`);
			// 同じ warning を再掲して LLM のノイズにしない（res.summary 側に 1 度だけ出す）
			const text = byView.get(view) as string;
			expect(text.split('ℹ️ カバレッジ').length - 1, `view=${view} でカバレッジ注記が重複`).toBe(1);
		}
	});

	it('get_flow_metrics: nonZeroOnly（絞り込みの軸）も res.summary の定型要素を保つ', async () => {
		// nonZeroOnly は量ではなく絞り込みの指定なので階梯には乗らない（§3-4）が、
		// 階梯上の view（full）と組み合わせて使う以上、定型要素は落とせない。
		//
		// PR 2 で full に `Flow Metrics (bucketMs=…)` / `Totals:` の 2 行ヘッダが入ったため、
		// `full` + `nonZeroOnly=true` の content は旧 `compact` に対してこの 2 行ぶん増える。
		// §3-3 の「旧 compact と完全一致」は**バケット行（欠損の区間畳み込みを含む）の一致**として
		// 読むこと——ヘッダを削ると今度は §3-2 規約 3（上位集合）に反する。
		// 「バケット行が旧 compact と一致し、差分がヘッダ 2 行ちょうどであること」は
		// tests/view-alias-mapping.test.ts で byte 単位で固定してある。
		const byView = await collectContentByView(['summary', 'compact'] as const, (view) => runFlow(view));
		expectSupersetOf(
			fixedElements(byView.get('compact') as string),
			fixedElements(byView.get('summary') as string),
			'full + nonZeroOnly ⊇ summary',
		);
	});

	// ── get_volatility_metrics: summary < detailed < full ─

	it('get_volatility_metrics: 定型要素が summary ⊆ detailed ⊆ full', async () => {
		const byView = await collectContentByView(['summary', 'detailed', 'full'] as const, (view) => runVolatility(view));
		const [summary, detailed, full] = [byView.get('summary'), byView.get('detailed'), byView.get('full')] as string[];

		// 抽出が空振りしていないことを先に固定する。
		// なお期間（timeframe）は detailed / full のヘッダにしか出ない（summary 側の
		// formatSummary が [1day] を付けるのは totalItems 指定時のみ）。増える方向なので規約上は問題ない。
		const summaryElements = fixedElements(summary);
		expect([...summaryElements].filter((e) => e.startsWith('📌'))).toHaveLength(4);
		expect(summaryElements).toContain('pair=BTC_JPY');
		expect([...summaryElements].some((e) => e.startsWith('lastValue='))).toBe(true);

		expectSupersetOf(fixedElements(detailed), fixedElements(summary), 'detailed ⊇ summary');
		expectSupersetOf(fixedElements(full), fixedElements(detailed), 'full ⊇ detailed');
	});

	it('get_volatility_metrics: detailed / full で 4 行フッタが消えない（P3 の回帰）', async () => {
		const byView = await collectContentByView(['detailed', 'full'] as const, (view) => runVolatility(view));

		for (const view of ['detailed', 'full'] as const) {
			const text = byView.get(view) as string;
			expect(text, `view=${view}`).toContain('📌 含まれるもの:');
			expect(text, `view=${view}`).toContain('📌 含まれないもの:');
			expect(text, `view=${view}`).toContain('📌 ATR の定義:');
			expect(text, `view=${view}`).toContain('📌 補完ツール:');
			// 各 view 固有の本文は従来どおり
			expect(text, `view=${view}`).toContain('【Volatility Metrics');
			expect(text, `view=${view}`).toContain('【Rolling Trends');
		}
		expect(byView.get('full')).toContain('【Series】');
		expect(byView.get('detailed')).not.toContain('【Series】');
	});

	// ── detect_patterns: summary < detailed < full ────────
	// （debug は階梯外。出力を置換するので上位集合である必要がない。§3-2 規約 3）

	it('detect_patterns: 定型要素が summary ⊆ detailed ⊆ full', async () => {
		const byView = await collectContentByView(['summary', 'detailed', 'full'] as const, (view) => runPatterns(view));
		const [summary, detailed, full] = [byView.get('summary'), byView.get('detailed'), byView.get('full')] as string[];

		// 抽出が空振り（空集合同士で自明に通る）していないことを先に固定する。
		// detect_patterns は 📌 フッタを持たないので、注記行は取得層 / 計算層の ⚠️ 2 本。
		const summaryElements = fixedElements(summary);
		expect([...summaryElements].filter((e) => e.startsWith('⚠️'))).toHaveLength(2);
		expect(summaryElements).toContain('pair=BTC_JPY');
		expect(periodLines(summary)).toHaveLength(2);
		expect(effectiveParamsLines(summary)).toHaveLength(1);
		expect(reductionLines(summary)).toHaveLength(1);
		// ターゲット行（#288 Phase 2）と状態行は `summary` には出ない（明細を列挙しない view）ので、
		// **空振りの検出は階梯上の 2 view 側で行う**——ここが 0 のままだと包含が自明に通る。
		expect(targetLines(summary)).toHaveLength(0);
		expect(targetLines(detailed).length).toBeGreaterThan(0);
		expect(targetLines(full).length).toBeGreaterThan(0);
		// **4 形それぞれを名指しで見る。** 件数だけだと 1 形が消えても他の形が埋め合わせて通る。
		for (const [label, text] of [
			['detailed', detailed],
			['full', full],
		] as const) {
			const lines = targetLines(text);
			expect(lines, `${label}: 到達`).toContain('- ターゲット: 到達（ブレイク後 12 本目、2026-01-15）');
			expect(lines, `${label}: 未到達（走査完了）`).toContain(
				'- ターゲット: 未到達（走査 60 本完了、目標幅の 26% まで接近）。走査窓内に逆方向のブレイクあり（triangle_ascending 上方 +28 本）',
			);
			expect(lines, `${label}: 未到達（走査中）`).toContain(
				'- ターゲット: 未到達（ブレイク後 25 本経過 / 走査上限 60 本、目標幅の 61% まで接近）',
			);
			expect(lines, `${label}: 出力なし`).toContain(
				'- ターゲット: 出力なし（ブレイク足が想定値幅の85%以上を消化済みで、残り距離が短く進捗率が意味を持たないため）',
			);
		}

		expectSupersetOf(fixedElements(detailed), fixedElements(summary), 'detailed ⊇ summary');
		expectSupersetOf(fixedElements(full), fixedElements(detailed), 'full ⊇ detailed');
	});

	it('detect_patterns: スキャン範囲 / 検出パターン分布期間の 2 行が summary / detailed / full すべてに出る', async () => {
		const byView = await collectContentByView(['summary', 'detailed', 'full'] as const, (view) => runPatterns(view));

		for (const view of ['summary', 'detailed', 'full'] as const) {
			const text = byView.get(view) as string;
			// スキャン範囲は meta.scan（検出器に渡した足）由来。1day なので暦日表示。
			expect(text, `view=${view}`).toContain('スキャン範囲: 2025-07-21 ~ 2026-01-26（190本）');
			// 分布期間は data.patterns の range 分布由来。旧ラベルは残っていない。
			expect(text, `view=${view}`).toContain('検出パターン分布期間: 2026-01-01 ~ 2026-01-26');
			expect(text, `view=${view}`).not.toContain('検出対象期間');
		}
	});

	it('detect_patterns: 実効パラメータ行が summary / detailed / full / debug すべてに同一文言で出る', async () => {
		// **`debug` も含める。** 階梯外（出力の置換）なので上位集合規約の対象ではないが、
		// 診断が目的の view でこそ実効値が要る（#184 決定事項 3）。規約は「出してはいけない」とは
		// 言っていないので、ここは規約 3 ではなく #184 の設計判断としての固定。
		const byView = await collectContentByView(['summary', 'detailed', 'full', 'debug'] as const, (view) =>
			runPatterns(view),
		);

		const lines = new Set<string>();
		for (const view of ['summary', 'detailed', 'full', 'debug'] as const) {
			const found = effectiveParamsLines(byView.get(view) as string);
			expect(found, `view=${view} に実効パラメータ行が無い`).toHaveLength(1);
			lines.add(found[0]);
		}
		// 4 view で文言が割れていない（handler で 1 回だけ組んでいることの回帰）
		expect(lines.size, 'view ごとに実効パラメータ行の文言が違う').toBe(1);

		const [line] = [...lines];
		// 4 パラメータすべてが実効値と由来つきで出る（`headProminencePct` は #184 欠陥 A の追加分）
		expect(line).toContain('swingDepth=4(指定)');
		expect(line).toContain('minBarsBetweenSwings=4(auto)');
		expect(line).toContain('tolerancePct=0.04(auto)');
		expect(line).toContain('headProminencePct=0.04(auto)');
		// sentinel 置換の明示（#184 決定事項 2）
		expect(line).toContain('スキーマ既定値 7/5/0.04 の明示指定も auto');
	});

	it('detect_patterns: 検出内訳行が summary / detailed / full / debug すべてに同一文言で出る（issue #200 要件 E）', async () => {
		// 実効パラメータ行と同じ理由で debug も含める。「accepted 76 件 → data.patterns 2 件」の
		// ような疑問が最も生じやすいのが debug なので、階梯外でも出す設計判断（#184 決定事項 3 と同種）。
		const byView = await collectContentByView(['summary', 'detailed', 'full', 'debug'] as const, (view) =>
			runPatterns(view),
		);

		const lines = new Set<string>();
		for (const view of ['summary', 'detailed', 'full', 'debug'] as const) {
			const found = reductionLines(byView.get(view) as string);
			expect(found, `view=${view} に検出内訳行が無い`).toHaveLength(1);
			lines.add(found[0]);
		}
		// 4 view で文言が割れていない（各 formatter が同じ meta.reduction から組んでいることの回帰）
		expect(lines.size, 'view ごとに検出内訳行の文言が違う').toBe(1);

		const [line] = [...lines];
		// フィクスチャ: 11 detected → -2 dedup → -1 current（>0 なので出る）→ -0 lifecycle（0 でも出る）
		// → -1 triple×H&S 排他（issue #218）→ 7 output
		expect(line).toBe(
			`${REDUCTION_LABEL}: 検出 11件 → 重複統合 -2 → 現在時点フィルタ -1 → ライフサイクル除外 -0 → triple×H&S排他 -1 → 出力 7件`,
		);
	});

	it('detect_patterns: 検出内訳行は currentFiltered=0 のとき区間を省く（issue #200）', async () => {
		// `patternsFixture()` は常に ok:true 側を返す（関数定義参照）。union のまま spread すると
		// TS が meta の形を fail 側と unify できず型エラーになるため、ok 側と分かるよう明示する。
		const fx = patternsFixture() as Extract<PatternsFixture, { ok: true }>;
		vi.mocked(detectPatterns).mockResolvedValue({
			...fx,
			meta: {
				...fx.meta,
				reduction: {
					detected: 9,
					dedupMerged: 2,
					currentFiltered: 0,
					lifecycleExcluded: 0,
					tripleHsExcluded: 0,
					// 比較対象の H&S はある（1 件以上）が該当が無かった側。注記は付かない（#224 症状 1）。
					tripleHsCandidateCount: 1,
					output: PATTERN_COUNT,
				},
			},
		});
		const res = await detectPatternsTool.handler({ pair: 'btc_jpy', type: '1day', limit: 180, view: 'summary' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		const [line] = reductionLines(text);
		// `triple×H&S排他` は 0 でも省かない側（`ライフサイクル除外` と同じ扱い。issue #218）。
		// 比較対象が 1 件以上あるときは「比較して該当なし」なので注記は出ない（誤って「無し」と言わない）。
		expect(line).toBe(
			`${REDUCTION_LABEL}: 検出 9件 → 重複統合 -2 → ライフサイクル除外 -0 → triple×H&S排他 -0 → 出力 7件`,
		);
		expect(line).not.toContain('現在時点フィルタ');
		expect(line).not.toContain(TRIPLE_HS_NO_CANDIDATE_NOTE);
	});

	it('detect_patterns: 検出内訳行は tripleHsCandidateCount=0 のとき「比較対象 H&S 無し」を注記する（issue #224 症状 1）', async () => {
		// `tripleHsExcluded: 0` は「比較して該当なし」と「比較対象が無く比較できなかった」の 2 通りある。
		// 後者（`patterns: ['triple_bottom']` のように H&S を要求しない呼び出し）だけ注記を付けて区別する。
		const fx = patternsFixture() as Extract<PatternsFixture, { ok: true }>;
		vi.mocked(detectPatterns).mockResolvedValue({
			...fx,
			meta: {
				...fx.meta,
				reduction: {
					detected: 9,
					dedupMerged: 2,
					currentFiltered: 0,
					lifecycleExcluded: 0,
					tripleHsExcluded: 0,
					tripleHsCandidateCount: 0,
					output: PATTERN_COUNT,
				},
			},
		});
		const byView = await collectContentByView(['summary', 'detailed', 'full', 'debug'] as const, (view) =>
			detectPatternsTool.handler({ pair: 'btc_jpy', type: '1day', limit: 180, view }),
		);
		for (const view of ['summary', 'detailed', 'full', 'debug'] as const) {
			const [line] = reductionLines(byView.get(view) as string);
			expect(line, `view=${view}`).toBe(
				`${REDUCTION_LABEL}: 検出 9件 → 重複統合 -2 → ライフサイクル除外 -0 → triple×H&S排他 -0${TRIPLE_HS_NO_CANDIDATE_NOTE} → 出力 7件`,
			);
		}
	});

	it('detect_patterns: 検出経路行が summary / detailed / full すべてに同一文言で出る（#191 B）', async () => {
		// **`summary` に出さないと規約 3 違反。** provenance（`data.patterns[]._fallback`）は
		// structuredContent 側にしかなく、summary は個々のパターン行を出さないので、
		// この集計行が summary における唯一の届け先になる。
		const byView = await collectContentByView(['summary', 'detailed', 'full'] as const, (view) =>
			runPatterns(view, { relaxed: 2 }),
		);

		const lines = new Set<string>();
		for (const view of ['summary', 'detailed', 'full'] as const) {
			const found = detectionRouteLines(byView.get(view) as string);
			expect(found, `view=${view} に検出経路行が無い`).toHaveLength(1);
			lines.add(found[0]);
		}
		// 3 view で文言が割れていない（同じ関数から組んでいることの回帰）
		expect(lines.size, 'view ごとに検出経路行の文言が違う').toBe(1);
		const [line] = [...lines];
		expect(line).toContain('strict 5 件 / relaxed フォールバック由来 2 件');
		expect(line).toContain(`${RELAXED_TAG}×2`);
	});

	it('detect_patterns: relaxed が 0 件でも検出経路行を出す（「行が無い = relaxed なし」を推論させない）', async () => {
		const byView = await collectContentByView(['summary', 'detailed', 'full'] as const, (view) => runPatterns(view));
		for (const view of ['summary', 'detailed', 'full'] as const) {
			const [line] = detectionRouteLines(byView.get(view) as string);
			expect(line, `view=${view}`).toBe(
				`${DETECTION_ROUTE_LABEL}: 全 7 件とも strict（relaxed フォールバック由来は 0 件）`,
			);
		}
	});

	it('detect_patterns: パターン単位の provenance は detailed / full への追加で、summary の定型要素は保たれる（#191 B）', async () => {
		// 「足す」は規約 §2 で許容、「削る」は禁止。summary に無い印を上位 view が足すのは規約内。
		const byView = await collectContentByView(['summary', 'detailed', 'full'] as const, (view) =>
			runPatterns(view, { relaxed: 2 }),
		);
		const summary = byView.get('summary') as string;
		expect(summary).not.toContain(`[${RELAXED_TAG}]`);
		for (const view of ['detailed', 'full'] as const) {
			const text = byView.get(view) as string;
			// 先頭 2 件が relaxed 由来（フィクスチャ）。見出し行の末尾に同じ値が付く
			expect(text, `view=${view}`).toContain(`1. double_top (パターン整合度: 0.90) [${RELAXED_TAG}]`);
			expect(text, `view=${view}`).toContain(`2. double_bottom (パターン整合度: 0.88) [${RELAXED_TAG}]`);
			// strict 由来には付かない
			expect(text, `view=${view}`).toContain('3. double_top (パターン整合度: 0.86)\n');
			expectSupersetOf(fixedElements(text), fixedElements(summary), `${view} ⊇ summary（定型要素）`);
		}
	});

	it('detect_patterns: パターン行のキー集合が summary ⊆ detailed ⊆ full', async () => {
		const byView = await collectContentByView(['summary', 'detailed', 'full'] as const, (view) => runPatterns(view));
		const keys = {
			summary: patternRowKeys(byView.get('summary') as string),
			detailed: patternRowKeys(byView.get('detailed') as string),
			full: patternRowKeys(byView.get('full') as string),
		};

		// summary は個々のパターンを出さない（= 空集合）。detailed は上位 5 件、full は全 7 件。
		// detailed が 5 件で頭打ちになる件数のフィクスチャでないと detailed ⊊ full を検証できない。
		expect(keys.summary.size).toBe(0);
		expect(keys.detailed.size).toBe(5);
		expect(keys.full.size).toBe(PATTERN_COUNT);
		expectSupersetOf(keys.detailed, keys.summary, 'detailed ⊇ summary（パターン行）');
		expectSupersetOf(keys.full, keys.detailed, 'full ⊇ detailed（パターン行）');
	});

	// ── issue #234: triple / H&S の pivot 明細行 ────────────
	// 明細行は `full` / `debug` にしか出ない（＝上位 view への「追加」）。規約 §2 で追加は許容、
	// 削除は禁止なので、ここで見るのは「full が detailed / summary の上位集合のままか」と
	// 「追加された行が正しい役割ラベルで出ているか」の 2 点。

	/** 反転系 4 件それぞれの期待ラベル（`pivots` の並びと 1:1）。 */
	const EXPECTED_PIVOT_ROLES: Record<ReversalType, readonly string[]> = {
		triple_top: ['山1', '谷1', '山2', '谷2', '山3'],
		triple_bottom: ['谷1', '山1', '谷2', '山2'],
		// **完成版 5 点の先頭 4 つ（左肩 / 谷1 / 頭 / 谷2）ではない。** 形成中は頭が 2 番目に来る。
		head_and_shoulders: ['左肩', '頭', '谷（頭後）', '右肩(暫定)'],
		inverse_head_and_shoulders: ['左肩', '山1', '頭', '山2', '右肩'],
	};

	/** `pivotRowKeys` と同じ形（`役割ラベル@表示日時`）の期待キー集合。 */
	function expectedPivotKeys(type: ReversalType): Set<string> {
		// swing の isoTime は 03:00Z（JST 12:00）なので、既定 tz でも暦日は UTC 日付と同じ。
		return new Set(
			EXPECTED_PIVOT_ROLES[type].map(
				(role, j) => `${role}@${reversalSwingIso(REVERSAL_PIVOT_IDXS[type][j]).slice(0, 10)}`,
			),
		);
	}

	it('detect_patterns: triple / H&S の pivot 明細行が full に出る（issue #234）', async () => {
		const byView = await collectContentByView(['full'] as const, (view) => runPatterns(view, { reversals: true }));
		const full = byView.get('full') as string;
		const keys = pivotRowKeys(full);

		for (const type of REVERSAL_TYPES) {
			expectSupersetOf(keys, expectedPivotKeys(type), `full の pivot 明細（${type}）`);
		}
		// 価格も出ている（idx の日時だけでは LLM が検算できない。本 issue の目的）
		const headIso = reversalSwingIso(REVERSAL_PIVOT_IDXS.triple_top[0]).slice(0, 10);
		expect(full).toContain(`   - 山1: ${headIso} 高値 10,100,000円（判定は高値基準）`);
	});

	it('detect_patterns: 形成中 H&S の 2 番目は「頭」（5 点版の「谷1」を流用していない。issue #234）', async () => {
		const byView = await collectContentByView(['full'] as const, (view) => runPatterns(view, { reversals: true }));
		const full = byView.get('full') as string;

		// 形成中 4 点の 2 点目（idx 210）。ここが「谷1」になっていたら頭を谷と誤表示している。
		const secondPointDate = reversalSwingIso(REVERSAL_PIVOT_IDXS.head_and_shoulders[1]).slice(0, 10);
		expect(full).toContain(`   - 頭: ${secondPointDate} `);
		expect(full).not.toContain(`   - 谷1: ${secondPointDate} `);

		// 3 点目は頭の**後ろ**の谷。完成版なら 3 点目が「頭」なので、ここも並びの違いが出る箇所。
		const thirdPointDate = reversalSwingIso(REVERSAL_PIVOT_IDXS.head_and_shoulders[2]).slice(0, 10);
		expect(full).toContain(`   - 谷（頭後）: ${thirdPointDate} `);
		expect(full).not.toContain(`   - 頭: ${thirdPointDate} `);

		// 対照: **完成 5 点**の逆 H&S は 2 点目が「山1」・3 点目が「頭」。同じ H&S 系でも
		// 点数で並びが変わることを 1 テスト内で並べて固定する（表引きの鍵が (type, 点数) である根拠）。
		const invIdxs = REVERSAL_PIVOT_IDXS.inverse_head_and_shoulders;
		expect(full).toContain(`   - 山1: ${reversalSwingIso(invIdxs[1]).slice(0, 10)} `);
		expect(full).toContain(`   - 頭: ${reversalSwingIso(invIdxs[2]).slice(0, 10)} `);
	});

	it('detect_patterns: pivot 明細行のキー集合が summary ⊆ detailed ⊆ full（追加は許容・削除は禁止）', async () => {
		const byView = await collectContentByView(['summary', 'detailed', 'full'] as const, (view) =>
			runPatterns(view, { reversals: true }),
		);
		const keys = {
			summary: pivotRowKeys(byView.get('summary') as string),
			detailed: pivotRowKeys(byView.get('detailed') as string),
			full: pivotRowKeys(byView.get('full') as string),
		};

		// summary / detailed は pivot 明細を出さない view（= 空集合）。full にだけ全 18 点が出る。
		expect(keys.summary.size).toBe(0);
		expect(keys.detailed.size).toBe(0);
		expect(keys.full.size).toBe(REVERSAL_TYPES.reduce((n, t) => n + REVERSAL_PIVOT_IDXS[t].length, 0));
		expectSupersetOf(keys.detailed, keys.summary, 'detailed ⊇ summary（pivot 明細行）');
		expectSupersetOf(keys.full, keys.detailed, 'full ⊇ detailed（pivot 明細行）');
	});

	it('detect_patterns: 反転系 4 件を足しても定型要素とパターン行は summary ⊆ detailed ⊆ full', async () => {
		const byView = await collectContentByView(['summary', 'detailed', 'full'] as const, (view) =>
			runPatterns(view, { reversals: true }),
		);
		const [summary, detailed, full] = [byView.get('summary'), byView.get('detailed'), byView.get('full')] as string[];

		expectSupersetOf(fixedElements(detailed), fixedElements(summary), 'detailed ⊇ summary（定型要素）');
		expectSupersetOf(fixedElements(full), fixedElements(detailed), 'full ⊇ detailed（定型要素）');

		// フィクスチャの縮小段が production の不変条件（`detected - 各段の減算 === output`）を
		// 満たしていること。ここが崩れていると「反転系を足した」フィクスチャ自体が
		// production では起きない応答になり、以下の包含検証の土台が信用できなくなる。
		expect(reductionLines(summary)).toEqual([
			`${REDUCTION_LABEL}: 検出 15件 → 重複統合 -2 → 現在時点フィルタ -1 → ライフサイクル除外 -0 → triple×H&S排他 -1 → 出力 11件`,
		]);

		const keys = {
			summary: patternRowKeys(summary),
			detailed: patternRowKeys(detailed),
			full: patternRowKeys(full),
		};
		expect(keys.summary.size).toBe(0);
		expect(keys.detailed.size).toBe(5);
		expect(keys.full.size).toBe(PATTERN_COUNT + REVERSAL_TYPES.length);
		expectSupersetOf(keys.detailed, keys.summary, 'detailed ⊇ summary（パターン行）');
		expectSupersetOf(keys.full, keys.detailed, 'full ⊇ detailed（パターン行）');
	});

	it('detect_patterns: debug は反転系を足してもパターン明細（pivot 行を含む）を出さない（階梯外）', async () => {
		// `formatPatternLine` の明細行の出力条件は `full` と `debug` で同じだが、`debug` view は
		// そもそも `formatPatternLine` を呼ばない（出力の置換。§3-2 規約 3）。#234 で明細行を
		// 増やしたことが `debug` の中身を変えていないことをここで固定する。
		// **`formatPatternLine(…, 'debug', …)` 単体が明細行を出すこと**は
		// tests/detectPatternsViewsHandler.test.ts 側で見ている。
		const byView = await collectContentByView(['debug'] as const, (view) => runPatterns(view, { reversals: true }));
		const debug = byView.get('debug') as string;
		expect(pivotRowKeys(debug).size).toBe(0);
		expect(patternRowKeys(debug).size).toBe(0);
	});

	it('detect_patterns: 取得層 / 計算層の ⚠️ 注記行が detailed / full でも残る', async () => {
		const byView = await collectContentByView(['summary', 'detailed', 'full'] as const, (view) => runPatterns(view));
		const summaryNotes = annotationLines(byView.get('summary') as string);

		expect(summaryNotes).toHaveLength(2);
		for (const view of ['detailed', 'full'] as const) {
			const text = byView.get(view) as string;
			expectSupersetOf(new Set(annotationLines(text)), new Set(summaryNotes), `${view} ⊇ summary（注記行）`);
			// 同じ warning を再掲して LLM のノイズにしない
			expect(text.split('取得層: 180本中20本が欠損').length - 1, `view=${view} で warning が重複`).toBe(1);
		}
	});

	it('detect_patterns: debug は階梯外なので検出パターンを出さない', async () => {
		// 「出力の置換」であり full の上位集合ではない（§1-4 / §3-4）。
		// P3 の見落としではなく意図した設計であることを、ここで固定しておく。
		const byView = await collectContentByView(['debug'] as const, (view) => runPatterns(view));
		const text = byView.get('debug') as string;

		expect(patternRowKeys(text).size).toBe(0);
		// 見出しは swings が空でも出るので、それだけ見ても「置換された」ことの証明にならない。
		// フィクスチャの swing が実際に描画されているところまで見る。
		expect(text).toContain('【Swings】');
		expect(text).toContain(String(DEBUG_SWING.price));
		expect(text).toMatch(new RegExp(`${DEBUG_SWING.kind}\\b`, 'u'));
	});

	it('detect_patterns: debug の棄却理由の集計ブロックは分母を書き切る（#191 A / #193 B-1。階梯外なので包含の対象外）', async () => {
		// 階梯外の view なので上位集合規約の対象ではないが、`【Candidates】` の申告値（#180）と
		// 集計の数字が食い違わないことは content の唯一のチャネル上の契約なのでここで固定する。
		const byView = await collectContentByView(['debug'] as const, (view) =>
			runPatterns(view, { candidates: [...DEBUG_CANDIDATES] }),
		);
		const text = byView.get('debug') as string;
		const lines = rejectionSummaryLines(text);

		// 申告 4 つが埋まっている production 相当の入力なので、分母は `全 N 件`。
		// 見出しの申告値（#180）と数字が食い違っていないことも同時に見る。
		expect(text).toContain('【Candidates】 4 / 全 4 件（省略なし）');
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe(
			`${CANDIDATE_BREAKDOWN_LABEL}: 全 4 件 = accepted 1 件 + rejected 3 件（cap 省略なし＝全候補の内訳）`,
		);
		expect(lines[1]).toBe(`${REJECTION_SUMMARY_LABEL}（type 別 → reason 別。合計は上の rejected 3 件と一致する）`);
		expect(text).toContain('   - double_top 2 件: peaks_not_equal 2');
		expect(text).toContain('   - triple_bottom 1 件: valleys_missing 1');

		// reason 単独の横断合計（#193 B-1）。type 別行の**下**に出て、合計は同じ rejected 件数と一致する。
		expect(lines[2]).toBe(
			`${REJECTION_CROSS_TOTAL_LABEL}（type を跨いで reason だけで合算。同じ reason でも type ごとに意味が違いうるので帰属は上の type 別行で見る。合計は上の rejected 3 件と一致する）`,
		);
		expect(text).toContain('   - peaks_not_equal 2 / valleys_missing 1');
		expect(text.indexOf(REJECTION_CROSS_TOTAL_LABEL)).toBeGreaterThan(text.indexOf(REJECTION_SUMMARY_LABEL));

		// 検出経路行は debug には出さない（パターンを列挙しない view なので帰属の対象が出ない）
		expect(detectionRouteLines(text)).toEqual([]);
	});

	describe('最新足が形成中（provisional）の場合', () => {
		beforeEach(() => {
			// Date だけ固定する（setTimeout 等は実物のままにして fetch のリトライ待ちを壊さない）。
			// 最終足の途中に現在時刻を置くと provisional = true になる。
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(dayjs.utc(LAST_BAR_MS).add(12, 'hour').valueOf());
		});

		it('get_volatility_metrics: ℹ️ 形成中足注記が detailed / full でも消えない', async () => {
			const byView = await collectContentByView(['summary', 'detailed', 'full'] as const, (view) =>
				runVolatility(view),
			);
			const summaryNotes = annotationLines(byView.get('summary') as string).filter((l) => !l.startsWith('📌'));

			expect(summaryNotes.some((l) => l.startsWith('ℹ️'))).toBe(true);
			for (const view of ['detailed', 'full'] as const) {
				expectSupersetOf(
					new Set(annotationLines(byView.get(view) as string)),
					new Set(summaryNotes),
					`${view} ⊇ summary（注記行）`,
				);
			}
		});
	});

	// ── 階梯外の view は対象外（§3-2 規約 3） ─────────────

	it('get_volatility_metrics: beginner は階梯外なので専門用語のフッタを持たない', async () => {
		// 「出力の置換」であり上位集合である必要がない。平易な言い換えである beginner に
		// 専門用語のフッタを足すのはその view の目的に反する（§5-3 やらないこと）。
		// P3 の見落としではなく意図した設計であることを、ここで固定しておく。
		const byView = await collectContentByView(['beginner'] as const, (view) => runVolatility(view));
		const text = byView.get('beginner') as string;

		expect(text).toContain('1日の平均的な動き');
		expect(annotationLines(text).filter((l) => l.startsWith('📌'))).toEqual([]);
	});
});
