/**
 * detectPatternsHandler のビュー別フォーマッタ
 * debug / summary / full / detailed の4モードを分離
 *
 * 表示日付の TZ:
 * - すべての日付表示は呼び出し側が渡す `tz` 引数で整形する（既定 'Asia/Tokyo'）。
 * - 構造化データ（PatternEntry.range / structureRange / precedingTrend / confirmation.date 等）は
 *   後方互換のため UTC ISO 文字列のまま不変。
 */
import { formatDateOrTimeInTz } from '../../lib/datetime.js';
import { formatFixed, formatInt, formatPctFromRatio, formatRounded } from '../../lib/formatter.js';
import { toStructured } from '../../lib/result.js';
import { BREAKOUT_AGAINST_EXPECTATION, levelSpreadMetrics } from '../../tools/patterns/structural.js';
import type { Pivot } from '../../tools/patterns/swing.js';
import { formatTargetProgressLine } from '../../tools/patterns/target-reach.js';
import type { PatternEntry } from '../../tools/patterns/types.js';
import type { McpResponse } from '../tool-definition.js';

/** デバッグスイング情報 */
interface SwingDebug {
	kind: string;
	idx: number;
	price: number;
	isoTime?: string;
}

/**
 * デバッグ候補エントリ。
 *
 * `status` / `breakoutDirection` は `CandDebugEntry`（`tools/patterns/types.ts`）が元から持つが、
 * **検出器によって置き場所が 2 系統に割れている**:
 * - top-level: `detect_wedges` の形成中パス、`detect_hs` の形成中成功エントリ（#155）
 * - `details` 配下: `detect_triangles` / `detect_pennants`（`details.status` / `details.breakout.direction`）
 *
 * 読む側（`candLines`）で両方を 1 回だけ解決する。置き場所の統一は検出器 6 ファイルに
 * 手が入るため別件（issue #160「やらないこと」）。
 */
interface CandidateDebug {
	type: string;
	accepted: boolean;
	reason?: string;
	status?: string;
	/** ブレイク方向。未ブレイクの候補では `null` が入りうる（`CandDebugEntry` と同じ形）。 */
	breakoutDirection?: string | null;
	indices?: number[];
	points?: Array<{ role: string; idx: number; price: number }>;
	details?: Record<string, unknown>;
}

/** パターン検出メタデータ */
interface PatternMeta {
	debug?: {
		swings?: SwingDebug[];
		candidates?: CandidateDebug[];
		/**
		 * cap トリムの申告（issue #180）。**`detect_patterns` の出力では常に埋まる**が、
		 * ハンドラを直接呼ぶ経路（テスト等）では欠けうるので optional。
		 * 欠損は「トリムが無かった」ではなく「件数が分からない」なので、表示側では
		 * 「省略なし」と書かずに行ごと落とす。
		 */
		candidatesTotal?: number;
		candidatesOmitted?: number;
		swingsTotal?: number;
		swingsOmitted?: number;
	};
	effective_params?: EffectiveParams;
	reduction?: ReductionCounts;
	[key: string]: unknown;
}

/**
 * `meta.reduction`（issue #200 要件 E）。`src/schema/patterns.ts` の `ReductionSchema` と対。
 * `PatternMeta.reduction` 自体が optional なのは、ハンドラを直接呼ぶテスト経路で欠けうるため
 * （`effective_params` 等と同じ事情）。存在するときは 5 つとも `tools/detect_patterns.ts` が
 * 1 箇所でまとめて設定するので、フィールド単位では optional にしない
 * （一部だけ欠けた不完全な reduction を型で許容しない）。
 */
interface ReductionCounts {
	detected: number;
	dedupMerged: number;
	currentFiltered: number;
	lifecycleExcluded: number;
	/** triple × H&S の型間排他（issue #218 Phase 2）で落ちた件数。**減るのは `triple_*` だけ**。 */
	tripleHsExcluded: number;
	/**
	 * 排他の段で比較対象になった H&S の件数（issue #224 症状 1）。0 なら `tripleHsExcluded` の 0 は
	 * 「比較対象が無かった」の意味。waterfall の等式には入らない。
	 */
	tripleHsCandidateCount: number;
	output: number;
}

/** 実効パラメータ 1 件（解決後の値 + 由来）。`src/schema/patterns.ts` の EffectiveParamsSchema と対。 */
interface EffectiveParam {
	value: number;
	source: 'auto' | 'explicit';
}

/**
 * `meta.effective_params`。**入力値ではなく解決後の実効値**（#182 の sentinel 置換適用済み）。
 *
 * 各フィールドが optional なのは、ハンドラを直接呼ぶテスト経路で欠けうるため。
 * `detect_patterns` の出力では 4 つとも常に埋まる（`tools/detect_patterns.ts`）。
 */
interface EffectiveParams {
	swingDepth?: EffectiveParam;
	minBarsBetweenSwings?: EffectiveParam;
	tolerancePct?: EffectiveParam;
	headProminencePct?: EffectiveParam;
}

/**
 * flag / pennant 系パターンに付与される検証メタデータ。
 * `PatternEntry` には optional フィールドとして既に定義されているが、
 * view ハンドラからは `unknown` 経由のキャストでアクセスするためここでも形を保持する。
 */
interface FlagFamilyViewFields {
	poleStartDate?: string;
	poleEndDate?: string;
	poleChangePct?: number;
	poleBars?: number;
	poleATRMult?: number;
	flagUpperSlope?: number;
	flagLowerSlope?: number;
	spreadAvg?: number;
	spreadStability?: number;
	expectedBreakoutDirection?: 'up' | 'down';
}

/** パターン検出結果（res パラメータ用） */
interface PatternResult {
	ok?: boolean;
	data?: { patterns?: PatternEntry[]; overlays?: unknown };
	meta?: Record<string, unknown>;
	summary?: string;
	[key: string]: unknown;
}

/** fmtPointList 用のポイント */
interface IndexedPoint {
	index: number;
	price: number;
}

// ── helpers ──

const toTs = (s?: string): number => {
	try {
		return s ? Date.parse(s) : NaN;
	} catch {
		return NaN;
	}
};

const fmtPointList = (arr: unknown): string =>
	Array.isArray(arr) ? arr.map((p: IndexedPoint) => `[${p.index}:${formatRounded(p.price)}]`).join(', ') : 'n/a';

/** キーの昇順比較。`localeCompare` は ICU の有無で並びが揺れるので使わない（並びはテストで固定する）。 */
const byKeyAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** default ケースで details から列挙するフィールド数の上限（content 肥大の抑制）。 */
const GENERIC_DETAILS_MAX_FIELDS = 16;
/** ネストしたオブジェクト値を JSON 化するときの最大長。 */
const GENERIC_DETAILS_MAX_JSON = 160;

// ── shared ──

/**
 * 種別別件数集計
 * @param _tz 現状の集計ロジックでは TZ を使わないが、view formatter 群と signature を揃える。
 */
export function buildTypeSummary(pats: PatternEntry[], _tz: string = 'Asia/Tokyo'): string {
	const byType = pats.reduce(
		(m: Record<string, number>, p: PatternEntry) => {
			const k = String(p?.type || 'unknown');
			m[k] = (m[k] || 0) + 1;
			return m;
		},
		{} as Record<string, number>,
	);
	return Object.entries(byType)
		.map(([k, v]) => `${k}×${v}`)
		.join(', ');
}

/**
 * `content` の「実効パラメータ:」行のラベル（行頭の識別子）。
 * `tests/view-content-superset.test.ts` が定型要素の抽出に使うので、変えるなら向こうも直す。
 */
export const EFFECTIVE_PARAMS_LABEL = '実効パラメータ（入力値ではない）';

/** 行に出す順番。swing 系 2 つ → 許容誤差系 2 つ。schema / meta の宣言順と揃える。 */
const EFFECTIVE_PARAM_ORDER = ['swingDepth', 'minBarsBetweenSwings', 'tolerancePct', 'headProminencePct'] as const;

/**
 * 実効パラメータ行を組み立てる（issue #184 欠陥 C）。
 *
 * **なぜ content に出すか**: `meta.effective_params` は `structuredContent` にしか無く、
 * LLM は `content[0].text` しか読めない（`.claude/rules/tools.md`）。実効値が見えないと
 * 「`tolerancePct` を 0.04 → 0.05 に緩めて再検出した」（1hour では前後とも実効 0.05 で no-op）
 * のような誤報告が起きる（#182 の実害）。
 *
 * **常に出す。** 「行が無い = 渡した値がそのまま効いた」を LLM に推論させるのは不確実なため。
 * 全 4 view（`summary` / `detailed` / `full` / `debug`）に同一の文字列を通す
 * ——`summary` に出さないと上位集合規約（`.claude/rules/tools.md` §3）違反になる。
 *
 * `meta.effective_params` を持たない meta（ハンドラ直呼びのテスト等）では**空文字を返す**。
 * 実効値を持っていないときに入力値で代用すると、まさに #184 欠陥 E の誤表示になる。
 */
export function buildEffectiveParamsLine(meta: PatternMeta | undefined, type: string): string {
	const eff = meta?.effective_params;
	if (!eff) return '';
	const parts: string[] = [];
	let hasAuto = false;
	for (const key of EFFECTIVE_PARAM_ORDER) {
		const entry = eff[key];
		if (!entry || !Number.isFinite(entry.value)) continue;
		const auto = entry.source !== 'explicit';
		if (auto) hasAuto = true;
		parts.push(`${key}=${entry.value}(${auto ? 'auto' : '指定'})`);
	}
	if (parts.length === 0) return '';
	// sentinel 置換が起きたことの明示（#184 決定事項 2）。`auto` が 1 つも無い呼び出しでは
	// 置換が起きていないので注記ごと落とす（読み手に存在しない印の説明をしない）。
	const note = hasAuto ? ` ※auto=${type} の時間軸オート値（スキーマ既定値 7/5/0.04 の明示指定も auto）` : '';
	return `${EFFECTIVE_PARAMS_LABEL}: ${parts.join(' / ')}${note}`;
}

/**
 * `content` の「検出経路:」行のラベル（行頭の識別子）。
 * `tests/view-content-superset.test.ts` が定型要素の抽出に使うので、変えるなら向こうも直す。
 */
export const DETECTION_ROUTE_LABEL = '検出経路';

/**
 * 検出経路（strict / relaxed）の申告行（issue #191 B。#189 / PR #190 の残り半分）。
 *
 * **なぜ content に出すか**: relaxed フォールバック由来の provenance `_fallback` は PR #190 で
 * 出力スキーマに宣言され機械クライアントには届くようになったが、`content` には出ていなかった。
 * LLM は `content[0].text` しか読めない（`.claude/rules/tools.md`）ため、ライブテストで LLM は
 * 「`structuredContent.data.patterns[]` は読めないので relaxed 由来かどうかは答えられない。
 * 『なし』とも書けない（値が無いのか、自分に見えていないだけなのかを区別できないため）」と回答した。
 * **推測で埋めることを拒否したのは正しい判断**で、実際 confidence からの逆算もできない
 * （relaxed のペナルティ係数が検出器ごとに違い、`finalizeConf` の種別別係数と丸めも通る）。
 *
 * **relaxed が 0 件でも行を出す。** 「行が無い = relaxed なし」を LLM に推論させると、
 * 上記の「値が無いのか出していないのか区別できない」がそのまま残る（実効パラメータ行と同じ理由）。
 *
 * **summary / detailed / full の 3 view に同一の文字列で出す。** 個々のパターンの詳細を出さない
 * `summary` に provenance を載せる手段は件数の集計しかなく、これを `detailed` / `full` だけに
 * 出すと上位集合規約（`.claude/rules/tools.md` §3）違反になる。パターン単位の印
 * （見出し行末尾の `[relaxed_…]`）は `detailed` / `full` への**追加**なので規約上は問題ない（§2「足す」）。
 *
 * @param pats `data.patterns`。**0 件なら空文字**（ヘッダが `0件を検出` と言うので帰属の対象が無い）
 */
export function buildDetectionRouteLine(pats: PatternEntry[]): string {
	if (!Array.isArray(pats) || pats.length === 0) return '';
	const byTag = new Map<string, number>();
	for (const p of pats) {
		const tag = typeof p?._fallback === 'string' ? p._fallback.trim() : '';
		if (!tag) continue;
		byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
	}
	const relaxed = [...byTag.values()].reduce((sum, n) => sum + n, 0);
	if (relaxed === 0) {
		return `${DETECTION_ROUTE_LABEL}: 全 ${formatInt(pats.length)} 件とも strict（relaxed フォールバック由来は 0 件）`;
	}
	const breakdown = [...byTag.entries()]
		.sort((a, b) => b[1] - a[1] || byKeyAsc(a[0], b[0]))
		.map(([tag, n]) => `${tag}×${formatInt(n)}`)
		.join(', ');
	return (
		`${DETECTION_ROUTE_LABEL}: strict ${formatInt(pats.length - relaxed)} 件 / relaxed フォールバック由来 ${formatInt(relaxed)} 件` +
		`（${breakdown}）※該当パターンは見出し行の末尾に同じ値が [ ] 付きで出る（summary はパターン行を出さないので件数のみ）`
	);
}

/**
 * `content` の「検出内訳:」行のラベル（行頭の識別子）。
 * `tests/view-content-superset.test.ts` が定型要素の抽出に使うので、変えるなら向こうも直す。
 */
export const REDUCTION_LABEL = '検出内訳';
/**
 * `triple×H&S排他 -0` に付ける注記（issue #224 症状 1）。比較対象の H&S が出力集合に 1 件も
 * 無く、排他を**試せなかった**ことを示す。テストが文言を固定するのでここで一元管理する。
 */
export const TRIPLE_HS_NO_CANDIDATE_NOTE = '（比較対象 H&S 無し）';

/**
 * 縮小段の件数申告行（issue #200 要件 E）。
 *
 * **なぜ content に出すか**: 1hour の H&S で accepted 76 件 → data.patterns 2 件のように、
 * `detect_patterns` は複数の段（globalDedup / requireCurrentInPattern / ライフサイクル絞り込み）を
 * 経て最終件数まで縮小するが、どこで何件減ったかは `content[0].text` のどこにも出ておらず、
 * LLM は「74 件がどこで消えたか」を説明できなかった。減ること自体は正常な挙動で、
 * **理由（内訳）が見えないことが不具合**。
 *
 * **件数はここで再集計しない。** `tools/detect_patterns.ts` が単一箇所で数えて
 * `meta.reduction` に載せたものをそのまま文字列化するだけ——`resolveTrimCounts`
 * （#180）と同じ理由で、2 箇所で計算すると見出しと集計が食い違う事故になる。
 *
 * **`currentFiltered`（requireCurrentInPattern。既定 false）は 0 のとき区間ごと省く。**
 * 他の 3 段と違い、このフィルタは無効時でも必ず評価されて
 * 確定的に 0 を返す（`buildDetectionRouteLine` の relaxed 0 件のような「試したかどうか
 * 分からない」曖昧さが無い）ため、省いても `検出 - 重複統合 - ライフサイクル除外 - triple×H&S排他 = 出力` の
 * 対応は崩れない。一方 `dedupMerged` / `lifecycleExcluded` / `tripleHsExcluded` は 0 でも省かない——
 * 本 issue の主眼（各段でどれだけ減ったか）を呼び出しごとに揺らさず答えるため
 * （`buildDetectionRouteLine` の「relaxed 0 件でも明示する」と同じ方針）。
 * `tripleHsExcluded`（issue #218 Phase 2）も同じ扱いで 0 でも省かない。
 *
 * **ただし `tripleHsExcluded` の 0 は 2 通りある**（issue #224 症状 1）。関数呼び出し自体は
 * 常に行われるが、判定は出力集合の中だけで閉じている（`tools/patterns/mutual-exclusion.ts` 冒頭
 * 「根拠は『実際に出力される H&S』だけ」）ので、`patterns: ['triple_bottom']` のように H&S を
 * 要求しない呼び出しでは根拠になる H&S が集合に無く**比較そのものが起きない**。
 * 「比較したが該当なし」と「比較できなかった」の区別は `tripleHsCandidateCount` で行い、
 * 0（比較対象無し）のときだけ `triple×H&S排他 -0（比較対象 H&S 無し）` と注記する。
 * 比較対象が 1 件以上あるときは今までの表示に曖昧さが無いので変えない。
 *
 * @param meta `meta.reduction` を持たない meta（ハンドラ直呼びのテスト等）では空文字を返す。
 */
export function buildReductionLine(meta: PatternMeta | undefined): string {
	const r = meta?.reduction;
	if (!r) return '';
	const {
		detected,
		dedupMerged,
		currentFiltered,
		lifecycleExcluded,
		tripleHsExcluded,
		tripleHsCandidateCount,
		output,
	} = r;
	if (![detected, dedupMerged, currentFiltered, lifecycleExcluded, tripleHsExcluded, output].every(Number.isFinite))
		return '';
	const parts = [`検出 ${formatInt(detected)}件`, `重複統合 -${formatInt(dedupMerged)}`];
	if (currentFiltered > 0) parts.push(`現在時点フィルタ -${formatInt(currentFiltered)}`);
	// 比較対象の H&S が 0 件なら「排他を試せなかった」ので注記する（issue #224 症状 1）。
	// `tripleHsCandidateCount` が無い古い meta（ハンドラ直呼びのテスト等）では注記を出さない
	// ——無いことを「比較対象無し」と読ませない。
	const hsNote = tripleHsCandidateCount === 0 ? TRIPLE_HS_NO_CANDIDATE_NOTE : '';
	parts.push(
		`ライフサイクル除外 -${formatInt(lifecycleExcluded)}`,
		`triple×H&S排他 -${formatInt(tripleHsExcluded)}${hsNote}`,
		`出力 ${formatInt(output)}件`,
	);
	return `${REDUCTION_LABEL}: ${parts.join(' → ')}`;
}

// ── debug view: candidate details ──

function formatCandidateDetails(c: CandidateDebug): string {
	if (!c.details) return '\n   details: none';
	const d: Record<string, unknown> = c.details;
	const reason = String(c?.reason ?? '');

	if (reason === 'type_classification_failed') {
		return (
			`\n   failureReason: ${d?.failureReason || 'n/a'}` +
			`\n   slopes: hi=${formatFixed(d?.slopeHigh)} lo=${formatFixed(d?.slopeLow)}` +
			`\n   slopeRatio: ${Number.isFinite(Number(d?.slopeRatio)) ? Number(d.slopeRatio).toFixed(3) : 'n/a'}`
		);
	}

	if (reason === 'probe_window') {
		return (
			`\n   upper.slope: ${formatFixed(d?.slopeHigh)}` +
			`\n   lower.slope: ${formatFixed(d?.slopeLow)}` +
			`\n   priceRange: ${formatRounded(d?.priceRange)}` +
			`\n   barsSpan: ${formatInt(d?.barsSpan)}` +
			`\n   minMeaningfulSlope: ${formatFixed(d?.minMeaningfulSlope)}` +
			`\n   highsIn: ${fmtPointList(d?.highsIn)}` +
			`\n   lowsIn: ${fmtPointList(d?.lowsIn)}`
		);
	}

	if (reason === 'declining_highs' || reason === 'declining_highs_probe') {
		return (
			`\n   ${reason === 'declining_highs' ? 'declining_highs: true' : 'declining_highs_probe: metrics'}` +
			`\n   highsIn.count: ${formatInt(d?.highsCount)}` +
			`\n   1st half avg: ${formatRounded(d?.firstAvg)}` +
			`\n   2nd half avg: ${formatRounded(d?.secondAvg)}` +
			`\n   ratio: ${formatPctFromRatio(d?.ratio)}`
		);
	}

	if (reason === 'rising_probe') {
		return (
			`\n   r2: hi=${Number.isFinite(Number(d?.r2High)) ? Number(d.r2High).toFixed(3) : 'n/a'}, lo=${Number.isFinite(Number(d?.r2Low)) ? Number(d.r2Low).toFixed(3) : 'n/a'}` +
			`\n   slopes: hi=${Number.isFinite(Number(d?.slopeHigh)) ? Number(d.slopeHigh).toFixed(6) : 'n/a'} lo=${Number.isFinite(Number(d?.slopeLow)) ? Number(d.slopeLow).toFixed(6) : 'n/a'}` +
			`\n   slopeRatioLH: ${Number.isFinite(Number(d?.slopeRatioLH)) ? Number(d.slopeRatioLH).toFixed(3) : 'n/a'}` +
			`\n   priceRange: ${formatRounded(d?.priceRange)}, barsSpan: ${formatInt(d?.barsSpan)}` +
			`\n   minMeaningfulSlope: ${Number.isFinite(Number(d?.minMeaningfulSlope)) ? Number(d.minMeaningfulSlope).toFixed(6) : 'n/a'}` +
			`\n   highsIn: ${fmtPointList(d?.highsIn)}` +
			`\n   lowsIn: ${fmtPointList(d?.lowsIn)}` +
			`\n   declining_highs metrics: firstAvg=${formatRounded(d?.firstAvg)}, secondAvg=${formatRounded(d?.secondAvg)}, ratio=${formatPctFromRatio(d?.ratio)}`
		);
	}

	if (reason === 'post_filter_rising_highs_not_declining') {
		return (
			`\n   post_filter: rising highs not declining` +
			`\n   highsIn.count: ${formatInt(d?.highsCount)}` +
			`\n   1st half avg: ${formatRounded(d?.firstAvg)}` +
			`\n   2nd half avg: ${formatRounded(d?.secondAvg)}` +
			`\n   ratio: ${formatPctFromRatio(d?.ratio)}`
		);
	}

	if (reason === 'post_filter_falling_lows_not_rising') {
		return (
			`\n   post_filter: falling lows not rising` +
			`\n   lowsIn.count: ${formatInt(d?.lowsCount)}` +
			`\n   1st half avg: ${formatRounded(d?.firstAvg)}` +
			`\n   2nd half avg: ${formatRounded(d?.secondAvg)}` +
			`\n   ratio: ${formatPctFromRatio(d?.ratio)}`
		);
	}

	// flag / pennant: pole 検証・チャネル幾何・spread 統計を構造化表示
	const flagReasons = new Set([
		'detected',
		'classification_failed',
		'spread_invalid',
		'broadening_channel',
		'spread_unstable',
		'slope_same_as_pole',
		'symmetric_convergence',
		'parallel_counter_trend',
		'insufficient_consolidation_swings',
		'trendline_span_too_short',
		'poor_trendline_fit',
		'consolidation_too_wide',
		'dedup_summary',
	]);
	if (flagReasons.has(reason)) {
		const lines: string[] = [];
		// Pole 検証結果
		if (d?.poleATRMult != null || d?.polePerBarImpulse != null || d?.poleChangePct != null) {
			const poleAtr = d?.poleATRMult != null ? Number(d.poleATRMult).toFixed(2) : 'n/a';
			const poleImpulse = d?.polePerBarImpulse != null ? Number(d.polePerBarImpulse).toFixed(2) : 'n/a';
			const polePct = d?.poleChangePct != null ? `${(Number(d.poleChangePct) * 100).toFixed(1)}%` : 'n/a';
			const poleBars = d?.poleBars != null ? `${formatInt(d.poleBars)}本` : 'n/a';
			const poleDir = d?.poleDirection ? `(${d.poleDirection})` : '';
			lines.push(
				`   pole: atrMult=${poleAtr}, perBarImpulse=${poleImpulse}, change=${polePct}, bars=${poleBars} ${poleDir}`,
			);
		}
		// チャネル幾何 (spread)
		if (d?.spreadAvg != null || d?.spreadStability != null || d?.spreadStart != null) {
			const spAvg = d?.spreadAvg != null ? formatRounded(d.spreadAvg) : 'n/a';
			const spStab = d?.spreadStability != null ? `${(Number(d.spreadStability) * 100).toFixed(0)}%` : 'n/a';
			const spStart = d?.spreadStart != null ? formatRounded(d.spreadStart) : null;
			const spEnd = d?.spreadEnd != null ? formatRounded(d.spreadEnd) : null;
			const seg = spStart && spEnd ? `, start→end=${spStart}→${spEnd}` : '';
			lines.push(`   spread: avg=${spAvg}, stability=${spStab}${seg}`);
		}
		// 傾き
		if (d?.upperSlope != null || d?.lowerSlope != null) {
			const us = d?.upperSlope != null ? Number(d.upperSlope).toFixed(4) : 'n/a';
			const ls = d?.lowerSlope != null ? Number(d.lowerSlope).toFixed(4) : 'n/a';
			const conv = d?.convergenceRatio != null ? Number(d.convergenceRatio).toFixed(3) : 'n/a';
			lines.push(`   slopes: upper=${us}, lower=${ls}, convergenceRatio=${conv}`);
		}
		// R²
		if (d?.r2Upper != null || d?.r2Lower != null) {
			const r2U = d?.r2Upper != null ? Number(d.r2Upper).toFixed(3) : 'n/a';
			const r2L = d?.r2Lower != null ? Number(d.r2Lower).toFixed(3) : 'n/a';
			lines.push(`   r2: upper=${r2U}, lower=${r2L}`);
		}
		// 期待ブレイク方向
		if (d?.expectedBreakoutDirection) {
			lines.push(`   expectedBreakoutDirection: ${d.expectedBreakoutDirection}`);
		}
		// dedup_summary 特殊
		if (reason === 'dedup_summary') {
			lines.push(
				`   dedup: before=${formatInt(d?.beforeDedup)}, after=${formatInt(d?.afterDedup)}, removed=${formatInt(d?.removed)}`,
			);
		}
		// その他 reject 系の補足
		if (reason === 'insufficient_consolidation_swings' && (d?.highs != null || d?.lows != null)) {
			lines.push(`   swings: highs=${formatInt(d?.highs)}, lows=${formatInt(d?.lows)}`);
		}
		if (reason === 'trendline_span_too_short') {
			lines.push(
				`   spans: upper=${formatInt(d?.upperSpan)}/${formatInt(d?.consZoneWidth)} (${(Number(d?.upperRatio) * 100).toFixed(0)}%), lower=${formatInt(d?.lowerSpan)}/${formatInt(d?.consZoneWidth)} (${(Number(d?.lowerRatio) * 100).toFixed(0)}%), minRatio=${(Number(d?.minSpanRatio) * 100).toFixed(0)}%`,
			);
		}
		if (reason === 'consolidation_too_wide') {
			lines.push(
				`   geometry: consRange=${formatRounded(d?.consRange)}, poleRange=${formatRounded(d?.poleRange)}, ratio=${(Number(d?.ratio) * 100).toFixed(0)}%`,
			);
		}
		if (reason === 'detected' && d?.touchCount != null) {
			// `status` はここで出さない。triangle / pennant は `details.status` に、wedge / 形成中 H&S は
			// top-level に置いており、置き場所ごとに別行が出ると同じ事実が 2 通りの書式で散る。
			// 解決は `candLines` の 1 箇所に寄せてヘッダ行へ出す（issue #160）。
			lines.push(`   touchCount: ${formatInt(d.touchCount)}, confidence: ${d?.confidence ?? 'n/a'}`);
		}
		return lines.length > 0 ? `\n${lines.join('\n')}` : '\n   details: (no fields)';
	}

	// default: 専用フォーマッタを持たない reason（r2_below_threshold / insufficient_touches /
	// score_below_threshold / containment_violated 等、棄却理由の大半がここに来る）。
	//
	// 以前はここで `spreadStart` / `spreadEnd` / `hiSlope` / `loSlope` を決め打ちで読んでいたが、
	// **この 4 つを details に入れる検出器は 1 つも無い**（`spreadStart` を持つ reason は
	// すべて上の flagReasons 側で処理される）。結果、どの候補でも `spread: n/a` としか出ず、
	// 実際に入っている診断値（r2 / touches / score / ratio …）は 1 つも表示されていなかった。
	// 存在しないフィールドを名指しするのをやめ、details が実際に持つフィールドを列挙する。
	return formatGenericDetails(d);
}

/** details に載っている値を 1 行 1 フィールドで列挙する（default ケース用）。 */
function formatGenericDetails(d: Record<string, unknown>): string {
	const entries = Object.entries(d).filter(([, v]) => v != null);
	if (entries.length === 0) return '\n   details: (no fields)';
	const shown = entries.slice(0, GENERIC_DETAILS_MAX_FIELDS);
	const lines = shown.map(([k, v]) => `   ${k}: ${formatDetailValue(v)}`);
	if (entries.length > shown.length) {
		lines.push(`   … 他 ${entries.length - shown.length} フィールド（structuredContent.data.candidates 参照）`);
	}
	return `\n${lines.join('\n')}`;
}

/** details の 1 値を表示用に整形する。数値は桁を潰さず、オブジェクトは短縮 JSON にする。 */
function formatDetailValue(v: unknown): string {
	if (typeof v === 'number') {
		if (!Number.isFinite(v)) return String(v);
		if (Number.isInteger(v)) return String(v);
		// 価格帯の値（数百万円）を toFixed(6) で出すと読めないので、大きい値だけ丸める。
		return Math.abs(v) >= 1000 ? formatRounded(v) : String(Number(v.toFixed(6)));
	}
	if (typeof v === 'string' || typeof v === 'boolean') return String(v);
	try {
		const json = JSON.stringify(v);
		if (typeof json !== 'string') return String(v);
		return json.length > GENERIC_DETAILS_MAX_JSON ? `${json.slice(0, GENERIC_DETAILS_MAX_JSON)}…` : json;
	} catch {
		return String(v);
	}
}

/**
 * `details` 側に置かれたブレイク記録から方向を読む。系統は 2 つある。
 *
 * - `details.breakout` — triangle / pennant。未ブレイクは `breakout: null`
 * - `details.breakInfo` — wedge の完成済みパス（`reason: 'revamped_ok'`）。未ブレイクは `breakInfo: null`
 *
 * **キーが在ること自体が「この検出器が答えた」印**なので、先に見つかった系統で打ち切り、
 * 値が `null`（＝未ブレイク）でも次の系統へフォールバックしない。top-level の `null` を
 * 欠損と畳まないのと同じ理由で、畳むと「未ブレイクなのに方向がある」行が出る。
 * 検出器が違うので実際に両方を持つエントリは無いが、優先順を暗黙にしない。
 *
 * @returns 方向 / 答えはあるが方向が無いなら `null` / どちらのキーも無いなら `undefined`
 */
function breakDirectionFromDetails(details?: Record<string, unknown>): string | null | undefined {
	if (!details) return undefined;
	for (const key of ['breakout', 'breakInfo'] as const) {
		if (!(key in details)) continue;
		return (details[key] as { direction?: string | null } | null | undefined)?.direction ?? null;
	}
	return undefined;
}

/**
 * cap トリムの申告行（issue #180）。`【Swings】` / `【Candidates】` の見出しに連結する。
 *
 * 配列を黙って切り詰めると、受け取った 200 件が全件なのか一部なのか呼び出し側から判別できない。
 * **LLM は `structuredContent` を読まない**（`.claude/rules/tools.md`）ので、`meta.debug` に
 * 件数を足すだけでは目的を達しない。ここが唯一のチャネル。
 *
 * - `total` が数値でないとき（申告前の実装 / 手組みの meta）は**行ごと出さない**。
 *   件数が分からない状態で「省略なし」と書くと、まさに本 issue の嘘を再導入することになる。
 * - 省略 0 でも `省略なし` を明示する。`200 件` だけだと飽和しているのか偶然 200 なのか読めない。
 *
 * @param kept 実際に配列に入っている件数
 * @param total トリム前の総数（`meta.debug.*Total`）
 * @param omitted 申告された省略件数（`meta.debug.*Omitted`）。欠けていれば `total - kept` で補う
 * @param omittedNote 省略が起きているときだけ添える注記（何が落ちたのかの説明）
 */
function formatTrimNote(kept: number, total?: number, omitted?: number, omittedNote?: string): string {
	const trim = resolveTrimCounts(kept, total, omitted);
	if (!trim) return '';
	const tail =
		trim.dropped > 0 ? `${formatInt(trim.dropped)} 件省略${omittedNote ? `。${omittedNote}` : ''}` : '省略なし';
	return ` ${formatInt(kept)} / 全 ${formatInt(trim.total)} 件（${tail}）`;
}

/**
 * cap トリムの申告値（総数 / 省略件数）を解決する。**`formatTrimNote`（見出し行）と
 * `formatRejectionSummary`（集計ブロック）の単一ソース。**
 *
 * 2 箇所で別々に計算すると、見出しが「89 件省略」と言いながら集計が全件の内訳を名乗る、
 * という食い違いが生じうる——issue #191 要件 2 / 3 が禁じているのがまさにそれ。
 *
 * @returns 総数が申告されていなければ `null`（＝件数が分からない。「省略なし」と書いてはいけない状態）
 */
function resolveTrimCounts(kept: number, total?: number, omitted?: number): { total: number; dropped: number } | null {
	if (typeof total !== 'number' || !Number.isFinite(total)) return null;
	const dropped =
		typeof omitted === 'number' && Number.isFinite(omitted) ? Math.max(0, omitted) : Math.max(0, total - kept);
	return { total, dropped };
}

/**
 * 棄却理由の集計ブロックの 2 つの見出し（issue #191 A）。
 * `tests/detectPatternsViewsHandler.test.ts` / `tests/view-content-superset.test.ts` が
 * 抽出に使うので、変えるならテスト側も直す。
 */
export const CANDIDATE_BREAKDOWN_LABEL = '▼ 候補の内訳';
export const REJECTION_SUMMARY_LABEL = '▼ 棄却理由の内訳';
/**
 * reason 単独（type 横断）の合計行の見出し（issue #193 B-1）。**`REJECTION_SUMMARY_LABEL` の
 * 接頭辞と重ならない語にしてある**——テスト側が `startsWith` で 2 つの見出しを抽出しており、
 * 同じ接頭辞にすると type 別ブロックと区別できなくなる。
 */
export const REJECTION_CROSS_TOTAL_LABEL = '▼ reason 横断合計';

/** 集計ブロックに並べる type 行の上限。超過分は残余行 1 本に畳む（**合計は必ず一致させる**）。 */
const REJECTION_SUMMARY_MAX_TYPES = 20;
/**
 * 1 行に並べる reason の上限。超過分は行内の残余に畳む（同上）。
 * **type 行と横断合計行の両方に同じ上限を掛ける**（畳み方の形も揃える）。
 */
const REJECTION_SUMMARY_MAX_REASONS = 10;

/**
 * 棄却理由の集計ブロック（issue #191 A）。`【Candidates】` の見出し行の**直後**に置く。
 *
 * **なぜツール側で数えるか**: `view=debug` の目的は「なぜ検出されなかったかを理由コードで追う」
 * （#144 / #145）ことで、それには数える必要がある。ところが候補の列挙だけを返すと、LLM は
 * 数十行の手集計を外す——ライブの btc_jpy 1hour（候補 69 件 = accepted 7 / rejected 62）で
 * **「62 件」と宣言しながら提示した表の合計は 57 件**になり、順位も飛んだ。
 * `meta.debug.candidates` に集計元は既にあるので、これは表示層だけで消せる失敗モードである。
 *
 * 設計上の約束（#191 要件 1〜3）:
 * 1. **分母を書き切る。** 総数 / accepted / rejected の 3 つを出し、読み手に引き算をさせない
 *    （上記の失敗は「69 件中 7 件が accepted」から 62 を導くところで起きた）。
 * 2. **cap で切られているときは「表示分の集計」であることを明記する。** censored な内訳から
 *    母集団を語る誤帰属は #152 → #167 / #172 で実際に起きている。
 * 3. **見出し行（`formatTrimNote`）と数字が食い違わない。** 申告値は `resolveTrimCounts` で共有する。
 *
 * **`type:reason` の 2 軸で数える**（`reason` だけに畳まない）。`patterns` で絞らない実行では
 * 13 種別が混ざり、`rising_wedge:slopes_not_same_direction` と
 * `falling_wedge:slopes_not_same_direction`（`detect_wedges.ts:949` が両 type に出す同じコード）が
 * 同じ行に潰れると帰属が読めなくなる。type ごとに 1 行へまとめることで、
 * type 別の合計と reason 別の内訳の**どちらも引き算なしで読める**（行数は type 数で頭打ち）。
 *
 * **その上で reason 単独の横断合計を 1 行足す**（issue #193 B-1）。2 軸で出しても LLM は
 * 「棄却理由を多い順に」と問われれば横断で合算しようとし、実測で 2 回外している——
 * ライブの btc_jpy 1hour（`patterns` 無指定 / cap 飽和 200 件）で
 * (1) type 別の数値（`slopes_not_same_direction 58` = falling_wedge の分だけ）を横断合計として提示し、
 * (2) `no_convergence(41) > slopes_not_same_direction(66)` という**不等号が成立しない**式を書いた。
 * 同じ日の `patterns` を絞った実行（62 件。reason と type がほぼ 1 対 1）では成功しているので、
 * これは「LLM が弱い」ではなく **`reason` が `type` を跨ぐほど再集計が難しくなる**条件付きの現象。
 * 出さなければ手集計され、手集計は外れる。**足す**のであって type 別を置き換えるのではない。
 *
 * @param cands `meta.debug.candidates`（cap トリム後に**実際に返した**配列）
 * @param total トリム前の総数（`meta.debug.candidatesTotal`）。欠けていれば分母を「受け取った N 件」と書く
 * @param omitted 押し出された件数（`meta.debug.candidatesOmitted`）
 * @returns 集計ブロックの行。候補 0 件なら空配列（列挙側が「なし（…）」を出すので二重に言わない）
 */
function formatRejectionSummary(cands: CandidateDebug[], total?: number, omitted?: number): string[] {
	if (cands.length === 0) return [];
	const accepted = cands.filter((c) => c.accepted).length;
	const rejected = cands.length - accepted;
	const trim = resolveTrimCounts(cands.length, total, omitted);
	const censored = !!trim && trim.dropped > 0;

	// 分母。`表示` / `全` / `受け取った` の 3 語で「この集計が何の内訳か」を先に確定させる。
	const scope = !trim
		? `受け取った ${formatInt(cands.length)} 件`
		: censored
			? `表示 ${formatInt(cands.length)} 件`
			: `全 ${formatInt(cands.length)} 件`;
	const scopeNote = !trim
		? '（総数の申告が無いため cap 省略の有無は不明。この集計は受け取った分のみ）'
		: censored
			? `（全 ${formatInt(trim.total)} 件のうち ${formatInt(trim.dropped)} 件は cap で省略されており、**この集計に入っていない**）`
			: '（cap 省略なし＝全候補の内訳）';
	const lines = [
		`${CANDIDATE_BREAKDOWN_LABEL}: ${scope} = accepted ${formatInt(accepted)} 件 + rejected ${formatInt(rejected)} 件${scopeNote}`,
	];

	if (rejected === 0) {
		// 「棄却が 0 件」と「集計を出していない」を区別できるように、行ごと落とさず明示する。
		lines.push(`${REJECTION_SUMMARY_LABEL}: なし（rejected 0 件）`);
		return lines;
	}

	const byType = new Map<string, { count: number; reasons: Map<string, number> }>();
	// type を畳んだ reason 単独の集計（#193 B-1）。type 行とは**独立に全 rejected から数える**ので、
	// type 行が上限で残余に畳まれていても横断合計は rejected と一致し続ける。
	const byReason = new Map<string, number>();
	for (const c of cands) {
		if (c.accepted) continue;
		const type = String(c.type || 'unknown');
		// 理由なしの棄却も数から落とさない（落とすと行の合計が rejected と合わなくなる）。
		const reason = c.reason ? String(c.reason) : '(reason なし)';
		const entry = byType.get(type) ?? { count: 0, reasons: new Map<string, number>() };
		entry.count += 1;
		entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + 1);
		byType.set(type, entry);
		byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
	}
	const sortedTypes = [...byType.entries()].sort((a, b) => b[1].count - a[1].count || byKeyAsc(a[0], b[0]));
	const shownTypes = sortedTypes.slice(0, REJECTION_SUMMARY_MAX_TYPES);
	const restTypes = sortedTypes.slice(REJECTION_SUMMARY_MAX_TYPES);

	lines.push(
		`${REJECTION_SUMMARY_LABEL}（type 別 → reason 別。合計は上の rejected ${formatInt(rejected)} 件と一致する${
			censored ? `。**全 ${formatInt(trim.total)} 件の内訳ではない**` : ''
		}）`,
	);
	for (const [type, entry] of shownTypes) {
		lines.push(`   - ${type} ${formatInt(entry.count)} 件: ${formatReasonParts(entry.reasons)}`);
	}
	if (restTypes.length > 0) {
		const restCount = restTypes.reduce((sum, [, entry]) => sum + entry.count, 0);
		lines.push(`   - （他 ${formatInt(restTypes.length)} 種別）${formatInt(restCount)} 件`);
	}

	// reason 単独の横断合計（#193 B-1）。**type が 1 種別しかないときは出さない**——
	// その場合 type 行がそのまま横断合計で、同じ数字を 2 度書くだけになる（跨ぎも起こりえない）。
	if (byType.size > 1) {
		lines.push(
			`${REJECTION_CROSS_TOTAL_LABEL}（type を跨いで reason だけで合算。同じ reason でも type ごとに意味が違いうるので帰属は上の type 別行で見る。合計は上の rejected ${formatInt(
				rejected,
			)} 件と一致する${censored ? `。**全 ${formatInt(trim.total)} 件の内訳ではない**` : ''}）`,
		);
		lines.push(`   - ${formatReasonParts(byReason)}`);
	}
	return lines;
}

/**
 * reason → 件数の Map を `a 21 / b 12 / 他 3 種 6` の 1 行に畳む。type 行と横断合計行で共有する
 * （**畳み方が 2 通りあると、どちらかだけ合計が合わなくなる**）。
 *
 * 並びは件数降順 → reason 名昇順。上限超過分は種類数と件数の両方を残す——落とすと
 * 「行の合計 = 上に書いた件数」という本ブロック唯一の不変条件が崩れる。
 */
function formatReasonParts(reasons: ReadonlyMap<string, number>): string {
	const sorted = [...reasons.entries()].sort((a, b) => b[1] - a[1] || byKeyAsc(a[0], b[0]));
	const parts = sorted.slice(0, REJECTION_SUMMARY_MAX_REASONS).map(([reason, n]) => `${reason} ${formatInt(n)}`);
	const rest = sorted.slice(REJECTION_SUMMARY_MAX_REASONS);
	if (rest.length > 0) {
		const restCount = rest.reduce((sum, [, n]) => sum + n, 0);
		parts.push(`他 ${formatInt(rest.length)} 種 ${formatInt(restCount)}`);
	}
	return parts.join(' / ');
}

export function formatDebugView(
	hdr: string,
	meta: PatternMeta,
	_pats: PatternEntry[],
	res: PatternResult,
	tz: string = 'Asia/Tokyo',
	// 実効パラメータ行（#184 欠陥 C）。**シグネチャ末尾に足してある**——本 formatter は
	// positional 呼び出しがテストだけで 30 箇所超あり、先頭寄りに入れると全て黙ってずれるため。
	// 4 formatter とも同じ規則（新しい表示行は末尾）で揃えてある。
	effectiveParamsLine: string = '',
	// 時刻表示（issue #200 要件 F-1）。同上の理由で末尾に足す。
	type: string = '1day',
): McpResponse {
	const swings: SwingDebug[] = Array.isArray(meta?.debug?.swings) ? meta.debug.swings : [];
	const cands: CandidateDebug[] = Array.isArray(meta?.debug?.candidates) ? meta.debug.candidates : [];
	const reductionLine = buildReductionLine(meta);

	const swingLines = swings.map((s) => {
		// intraday では時刻まで出す（issue #200）。1hour 等は 24 本が同じ日付ラベルに潰れて
		// 任意の足の高安を特定できなかった。日足以上は暦日のみで足りる。
		const dateStr = s.isoTime ? toDateOrTime(s.isoTime, tz, type) : 'n/a';
		return `- ${s.kind} idx=${s.idx} price=${Math.round(Number(s.price)).toLocaleString('ja-JP')} (${dateStr})`;
	});

	const candLines = cands.map((c, i: number) => {
		const tag = c.accepted ? '✅' : '❌';
		const reason = c.accepted ? (c.reason ? ` (${c.reason})` : '') : c.reason ? ` [${c.reason}]` : '';
		// status / breakoutDirection は検出器ごとに top-level と `details` に割れている（型注釈参照）。
		// **ここが唯一の解決点**。`formatCandidateDetails` 側では出さないので、書式は 1 通りに揃う。
		// `status` は `CandDebugEntry` 側が `string | undefined` で null を取らないため `??` でよい。
		const status = c.status ?? (c.details?.status as string | undefined);
		// `breakoutDirection` は `string | null` で、**`null` は「この検出器が未ブレイクと判定した」**
		// という値のある答え。`??` で書くと欠損と同じ扱いになり details 側に上書きされるので、
		// キーの有無（`undefined`）だけで分岐する。出力スキーマの `z.string().nullish()` は
		// 欠損と `null` を畳まないので、parse を通した後もこの区別は残る。
		const dir = c.breakoutDirection !== undefined ? c.breakoutDirection : breakDirectionFromDetails(c.details);
		const statusStr = status ? ` status=${status}` : '';
		// 未ブレイクは `null`（wedge 形成中）、`details.breakout: null`（triangle / pennant）、
		// `details.breakInfo: null`（wedge 完成済み）のいずれかで来る。
		// 「方向が無い」を `null` と書いても読み手に情報が増えないので、その場合は行ごと出さない。
		const dirStr = dir ? ` breakoutDirection=${dir}` : '';
		const pts = Array.isArray(c.points)
			? c.points.map((p) => `${p.role}@${p.idx}:${Math.round(Number(p.price)).toLocaleString('ja-JP')}`).join(', ')
			: '';
		const indices = Array.isArray(c.indices) ? ` indices=[${c.indices.join(',')}]` : '';
		const detailsStr = formatCandidateDetails(c);
		return `${i + 1}. ${tag} ${c.type}${reason}${statusStr}${dirStr}${indices}${pts ? `\n   ${pts}` : ''}${detailsStr}`;
	});

	// cap トリムの申告（#180）。見出しに直付けするのは、凡例の下に置くと候補行との間に
	// 埋もれるため。**`swings` は先頭から残す**ので落ちるのは直近側で、`candidates` とは
	// 落ちる側が逆になる（どちらを残すかの変更は #180 の対象外）。
	const swingsNote = formatTrimNote(
		swings.length,
		meta?.debug?.swingsTotal,
		meta?.debug?.swingsOmitted,
		// `slice(0, cap)` なので落ちるのは必ず末尾側＝新しいほう。条件分岐は要らない。
		'先頭から残すため省略分はすべて直近側のスイング',
	);
	// **「省略分はすべて棄却理由」は無条件には言えない。** トリムは `[...accepted, ...rejected]`
	// を `slice(0, cap)` するだけなので、accepted が cap を超えれば accepted も押し出される。
	// ただし**返した配列に `accepted: false` が 1 件でも残っていれば、accepted は全件収まった**
	// ことが確定する（収まらなければ rejected は 1 件も入らない）。そこで文言を分ける。
	// 逆側（全件 accepted）では `accepted === cap` ちょうどの場合に実際は rejected しか
	// 押し出されていないので、「含まれうる」と可能性で書く——**過小申告はするが嘘はつかない**。
	const keptHasRejected = cands.some((c) => !c.accepted);
	const candsNote = formatTrimNote(
		cands.length,
		meta?.debug?.candidatesTotal,
		meta?.debug?.candidatesOmitted,
		keptHasRejected
			? 'accepted は全件残っているため省略分はすべて棄却理由'
			: 'accepted が cap を埋めており省略分に accepted も含まれうる',
	);

	const text = [
		hdr,
		// 階梯外の view だが、診断が目的である以上ここでこそ実効値が要る（#184 決定事項 3）。
		...(effectiveParamsLine ? [effectiveParamsLine] : []),
		// 縮小段の内訳（issue #200 要件 E）。debug は「accepted 76 件 → data.patterns 2 件」の
		// ような疑問が最も生じやすい view なので、実効パラメータ行と同じく階梯外でも出す。
		...(reductionLine ? [reductionLine] : []),
		'',
		`【Swings】${swingsNote}`,
		swingLines.length ? swingLines.join('\n') : 'なし',
		'',
		`【Candidates】${candsNote}`,
		// 棄却理由の集計（#191 A）。**列挙より前**に置く——長いリストを読み切る前に全体像が要る。
		// 見出しの申告値（`candsNote`）と同じ `resolveTrimCounts` を通しているので数字は食い違わない。
		...formatRejectionSummary(cands, meta?.debug?.candidatesTotal, meta?.debug?.candidatesOmitted),
		// ❌ は候補生成の時点での棄却で、status を持たないため includeInvalid では拾えない
		// （issue #149）。一度パターンとして成立してから無効化されたものは data.patterns 側で
		// status=invalid/expired として別に出る。
		// ✅ 側は #155 以降 status を持つ（形成中パスの成功エントリ等）が、これは**候補を組み立てた
		// 時点**の status であって、その後 invalid / expired になったかは candidates からは分からない。
		'❌ = 候補段階の棄却（status なし。理由は [reason]。includeInvalid では拾えない）',
		'✅ の status = 候補を組み立てた時点の状態。成立後に invalid/expired になったかは data.patterns 側で見る',
		candLines.length
			? candLines.join('\n')
			: // 候補ゼロは「この窓でどの検出器も候補を組めなかった」の意。
				// candidates は入力 `patterns` で絞られる（#124）ので、種別を指定して呼んだ場合は
				// 「他種別なら候補があったかもしれない」を読み手が区別できるよう明記する。
				'なし（この窓では要求種別の候補が 1 つも組まれていない。candidates は入力 patterns で絞り込まれる）',
	].join('\n');

	try {
		return {
			content: [{ type: 'text', text }],
			structuredContent: {
				data: { ...res?.data, candidates: cands },
				meta: res?.meta ?? {},
				ok: res?.ok ?? true,
				summary: res?.summary ?? hdr,
			} as Record<string, unknown>,
		};
	} catch {
		return { content: [{ type: 'text', text }], structuredContent: toStructured(res) };
	}
}

// ── pattern line formatter (shared by full / detailed) ──

function buildIdxToIso(meta: PatternMeta): Record<number, string> {
	const map: Record<number, string> = {};
	try {
		const swings = meta?.debug?.swings;
		if (Array.isArray(swings)) {
			for (const s of swings) {
				const i = Number(s?.idx);
				const t = String(s?.isoTime || '');
				if (Number.isFinite(i) && t) map[i] = t;
			}
		}
	} catch {
		/* noop */
	}
	return map;
}

/**
 * UTC ISO 文字列を、指定 tz の暦日 YYYY-MM-DD（日足以上）または分単位 YYYY-MM-DD HH:mm
 * （intraday）として整形する（issue #200 要件 F-1）。
 *
 * 旧実装は時間足に関わらず暦日のみだったため、1hour 等では 24 本が同じ日付ラベルに潰れて
 * どの足かを特定できなかった（`tools/patterns/period.ts` の `buildScanRangeLine` が
 * スキャン範囲の 2 点で既に同じ判定をしており、こちらはパターン詳細側への横展開）。
 * 値が空 / parse 失敗時は 'n/a' を返す。
 */
function toDateOrTime(iso: string | undefined, tz: string, type: string): string {
	// 判定そのものは `lib/datetime.ts` が単一ソース（#288 Phase 2 のレビュー指摘で 1 本化した）。
	// ここはこのファイルの表示規約である `'n/a'` フォールバックを足すだけ。
	return formatDateOrTimeInTz(iso, tz, type) ?? 'n/a';
}

/**
 * structureRange / confirmation / precedingTrend が揃っている場合に
 * 文脈期間 / 形成期間 / ブレイク確認 / 先行トレンド の行を組み立てる。
 * いずれも未設定の場合は legacy「期間」行をフォールバックとして返す。
 */
function buildPeriodLines(p: PatternEntry, legacyRange: string, tz: string, type: string): string[] {
	const hasNew = !!(p?.structureRange || p?.confirmation || p?.precedingTrend);
	if (!hasNew) return [`   - 期間: ${legacyRange}`];

	const lines: string[] = [];

	const ctxStart = p.precedingTrend?.start ?? p.structureRange?.start ?? p.range?.start;
	const confirmedDate = p.confirmation?.type === 'neckline_breakout' ? p.confirmation.date : undefined;
	const ctxEnd = confirmedDate ?? p.structureRange?.end ?? p.range?.end;
	if (ctxStart && ctxEnd) {
		const suffix = confirmedDate
			? '（先行トレンド〜ブレイク確認日）'
			: p.precedingTrend
				? '（先行トレンド〜構成終了）'
				: '';
		lines.push(`   - 文脈期間: ${toDateOrTime(ctxStart, tz, type)} ~ ${toDateOrTime(ctxEnd, tz, type)}${suffix}`);
	}

	if (p.structureRange) {
		lines.push(
			`   - 形成期間: ${toDateOrTime(p.structureRange.start, tz, type)} ~ ${toDateOrTime(p.structureRange.end, tz, type)}（構成点）`,
		);
	}

	if (p.confirmation?.type === 'neckline_breakout') {
		const priceStr = Number.isFinite(p.confirmation.price)
			? `${Math.round(p.confirmation.price).toLocaleString('ja-JP')}円`
			: 'n/a';
		lines.push(`   - ブレイク確認: ${toDateOrTime(p.confirmation.date, tz, type)}（${priceStr}）`);
	} else if (p.confirmation?.type === 'not_confirmed') {
		lines.push('   - ブレイク確認: なし（検出器ではネックライン突破を確認していません）');
	}

	if (p.precedingTrend) {
		const dirJa: Record<string, string> = {
			up: '上昇',
			down: '下降',
			sideways: '横ばい',
			insufficient_data: 'データ不足',
		};
		const t = p.precedingTrend;
		const sign = t.returnPct > 0 ? '+' : '';
		lines.push(
			`   - 先行トレンド: ${toDateOrTime(t.start, tz, type)} ~ ${toDateOrTime(t.end, tz, type)}（${dirJa[t.direction] || t.direction}、${sign}${t.returnPct}%、lookback=${t.lookbackBars}本）`,
		);
	}

	return lines.length > 0 ? lines : [`   - 期間: ${legacyRange}`];
}

/**
 * pivot の価格を「報告値」と「判定に使った極値」の両方で出す（issue #125）。
 *
 * `price` は終値、極値判定は high / low で行われている（`tools/patterns/swing.ts`）。
 * 片方だけ出すと出力から判定を検算できず、実際に外部レビューが
 * 「終値基準で極値を取っている＝ピボット抽出器のバグ」と誤読した経緯がある。
 * 両方が同値のとき（triangle_* の relaxed swing、ヒゲの無い足）は 1 つにまとめて出す。
 */
function formatPivotPrices(pv: Pivot): string {
	const yen = (v: number) => `${Math.round(v).toLocaleString('ja-JP')}円`;
	const close = Number(pv?.price);
	const extreme = Number(pv?.extremePrice);
	const basisLabel = pv?.kind === 'L' ? '安値' : '高値';
	if (!Number.isFinite(close)) return 'n/a';
	if (!Number.isFinite(extreme)) return `(${yen(close)})`;
	if (Math.round(close) === Math.round(extreme)) return `${basisLabel} ${yen(extreme)}（判定は${basisLabel}基準）`;
	return `終値 ${yen(close)} / ${basisLabel} ${yen(extreme)}（判定は${basisLabel}基準）`;
}

/**
 * double 2 型の「山2 / 谷2 の位置」行（issue #245）。該当しない形は `null`（＝行を出さない）。
 *
 * ## 何のための行か
 *
 * 極値判定は高安（`tools/patterns/swing.ts` の `detectSwingPoints`）、同水準判定は終値
 * （`Pivot.price`）という混合基準なので、**「高値では山1 と同水準、終値ではネックラインの
 * すぐ上」という足がそのまま山2 になる**（#245 の発端の形。上ヒゲがパターン高さの 73.3%）。
 * `content[0].text` は LLM への唯一のチャネル（`.claude/rules/tools.md`）なので、この行が
 * 無いと「山2 は終値では存在せずヒゲだけだった」ことを読み手が知る手段が無い——#245 の症状は
 * 「報告が間違っている」ではなく「報告に情報が足りない」だった。
 *
 * **閾値を持たず、double なら常に出す。** PR #276 の計測で「ヒゲだけの山2 の直後に再上昇
 * せずそのまま割る形」が 12,104 ケースで 0 件だったため、検出側（減点 / hard reject）は
 * 変えない（#245 の決定コメント: 案 B + 案 C）。閾値を置かないので #214 の「非恣意性を
 * 主張できない境界を入れない」基準にも触れない。
 *
 * ## 量（PR #276 / tjackiet/bitbank-lab-mcp#245 の計測記録と同じ定義）
 *
 * `pivots = [a, b, c]`（`c` が山2 / 谷2、`b` がネックライン定義点で `necklinePrice = b.price`）:
 *
 * | 量 | top | bottom |
 * |---|---|---|
 * | `heightAbs` | `levelSpreadMetrics([a, c], [a, b, c]).heightAbs`（全構成点の `extremePrice` の全振幅） | 同左 |
 * | `closeGap` | `(c.price − b.price) / heightAbs` | `(b.price − c.price) / heightAbs` |
 * | `wickShare` | `(c.extremePrice − c.price) / heightAbs` | `(c.price − c.extremePrice) / heightAbs` |
 *
 * **分母は再実装せず {@link levelSpreadMetrics} を import して使う。** 表示層で式を写すと、
 * 検出器側の「パターン高さ」の定義が動いたときに同じ語が 2 つの量を指すようになる。
 *
 * ## 値は `pivots` から導出する（`structuredContent` は変えない）
 *
 * 検出器に新しいフィールドを足していない。`data.patterns` は 1 バイトも動かないので、
 * ベースライン回帰（`tests/detect_patterns_data_patterns_regression.test.ts`）と
 * `tests/view-structured-content-invariance.test.ts` は無差分のまま通る。
 *
 * ## 符号は価格の向きに固定する（`+` が上、`-` が下）
 *
 * `closeGap` は「正常な向き」を正に取る量（bottom は谷2 の終値がネックラインより**下**に
 * あるのが正常）だが、**表示にはその符号を使わない**。`+` を「上」と読むのは読み手の既定の
 * 期待で、パターン種別で符号の意味が反転する表示は #245 が問題にしている読み違いを
 * もう 1 つ増やすだけになる。よって bottom は `-x%`（＝ ネックラインより x% 下）と出す。
 * `ヒゲ` は向きを持たない量なので符号を付けない。
 *
 * ## 出さない条件（`n/a` は出さない）
 *
 * `pivots` が 3 点でない / `extremePrice` 欠損（`heightAbs` が `null`）/ `heightAbs` が 0 /
 * 終値が非有限。{@link formatPivotPrices} の `n/a` は「**この点の価格が読めない**」という
 * 観測の申告だが、本行が出せないのは「**この形では量が定義できない**」であって申告すべき
 * 観測値が存在しない。1 行まるごと黙る方が読み手を誤らせない。
 *
 * ## triple / H&S には出さない
 *
 * H&S は `heightAbs` の端点が頭と谷で、肩は端点にならないため同じ量が意味を持たない
 * （#178 項目 3 が「不要」で決着済み）。triple は PR #276 の計測で該当 0 件。必要になれば
 * 別 issue で足す。
 */
function formatSecondExtremePositionLine(p: PatternEntry): string | null {
	const side = p?.type === 'double_top' ? 'top' : p?.type === 'double_bottom' ? 'bottom' : null;
	if (!side) return null;
	const pivots = p?.pivots;
	// **`>= 3` ではなく `=== 3`。** double の `pivots` は常に 3 点（`docs/tools.md`）で、
	// 点数が変わったなら `b` がネックライン定義点だという前提そのものを検算し直す必要がある。
	if (!Array.isArray(pivots) || pivots.length !== 3) return null;
	const [a, b, c] = pivots;
	if (!a || !b || !c) return null;
	const necklinePrice = Number(b.price);
	const close = Number(c.price);
	const extreme = Number(c.extremePrice);
	if (!Number.isFinite(necklinePrice) || !Number.isFinite(close) || !Number.isFinite(extreme)) return null;
	const { heightAbs } = levelSpreadMetrics([a, c], [a, b, c]);
	if (heightAbs === null || !(heightAbs > 0)) return null;
	// 価格の向きの符号を持つ差（`closeGap` の符号ではない。docstring「符号は価格の向きに固定する」）。
	const gapByPrice = (close - necklinePrice) / heightAbs;
	const wickShare = side === 'top' ? (extreme - close) / heightAbs : (close - extreme) / heightAbs;
	const label = side === 'top' ? '山2' : '谷2';
	// `formatPctFromRatio` は負値にだけ符号を付けるので、正のときだけ `+` を補う。
	const sign = gapByPrice > 0 ? '+' : '';
	return `   - ${label} の位置: 終値はネックラインの ${sign}${formatPctFromRatio(gapByPrice)}（パターン高さ比）/ ヒゲ ${formatPctFromRatio(wickShare)}`;
}

/**
 * pivot 明細行の役割ラベル表（issue #234）。キーは **`type` と `pivots.length` の組**。
 *
 * **`kind` から役割を導出してはいけない。** 形成中 H&S の 4 点は `H, H, L, H`（逆 H&S は
 * `L, L, H, L`）で左肩と頭が同じ `kind` になり、`kind` だけでは 2 点を区別できない。
 *
 * 点数ごとに別エントリを置いているのは、**形成中 H&S の 4 点配列が完成版 5 点配列の
 * 先頭 4 点ではない**ため（`tools/patterns/detect_hs.ts` の早期形成パス）。
 * 完成版は `[左肩, 谷1, 頭, 谷2, 右肩]` だが、形成中は `[左肩, 頭, 谷（頭後）, 右肩]` で
 * **頭が 2 番目に来る**（先行谷 `preHeadValley` は `pivots` に載らず debug の `points` にだけ出る）。
 * 5 点版のラベルを先頭 4 つ流用すると頭を「谷1」と誤表示する。
 *
 * triple は逆に素直で、形成中 4 点（`tools/patterns/detect_triples.ts`）は完成版 5 点
 * `[a, v1, b, v2, c]` の先頭 4 点と同じ並び（3 点目のピークが未確定で末尾が無いだけ）。
 * それでも**表を先頭切り詰めで導出せず 4 点版を明記する**——H&S と同じ表を引く以上、
 * 「切り詰めれば済む」という前提をコードに埋め込まないため。
 */
const PIVOT_ROLE_LABELS: Readonly<Record<string, readonly string[]>> = {
	'triple_top:5': ['山1', '谷1', '山2', '谷2', '山3'],
	'triple_top:4': ['山1', '谷1', '山2', '谷2'],
	'triple_bottom:5': ['谷1', '山1', '谷2', '山2', '谷3'],
	'triple_bottom:4': ['谷1', '山1', '谷2', '山2'],
	'head_and_shoulders:5': ['左肩', '谷1', '頭', '谷2', '右肩'],
	'head_and_shoulders:4': ['左肩', '頭', '谷（頭後）', '右肩(暫定)'],
	'inverse_head_and_shoulders:5': ['左肩', '山1', '頭', '山2', '右肩'],
	'inverse_head_and_shoulders:4': ['左肩', '頭', '山（頭後）', '右肩(暫定)'],
};

/**
 * `(type, pivots.length)` → pivot 明細行の役割ラベル配列。該当が無ければ `null`
 * （＝明細行を 1 行も出さない）。
 *
 * **double 2 型だけは点数で引かない。** 従来から「`pivots.length >= 3` なら先頭 3 点」で
 * 出しており、点数を鍵にすると `pivots` の構成が変わった瞬間に表示が黙って消える。
 * issue #234 は triple / H&S を足す変更なので、double の表示は完全に据え置く。
 */
function pivotRoleLabels(type: string, pivotCount: number): readonly string[] | null {
	if (type === 'double_top') return ['山1', '谷', '山2'];
	if (type === 'double_bottom') return ['谷1', '山', '谷2'];
	return PIVOT_ROLE_LABELS[`${type}:${pivotCount}`] ?? null;
}

// ── 状態行（`- 状態: …`）の表引き（issue #286） ──────────────────────

/**
 * 反転系（ネックラインを持つ）パターン種別の語彙。**`last`（最終構成点の呼び名）と
 * `zone`（ゾーンの向き）を 1 つの表に同居させてある**——2 表に分けると片方だけ埋め忘れた
 * ときに「山2 の確定後、谷ゾーンへ戻った」のような混線した文が黙って出る。
 *
 * `zone` は `re_entered_trough_zone`（issue #286）用。理由コードの名前は `trough`（谷）固定だが、
 * `detectTroughZoneReentry`（`tools/patterns/structural.ts`）が張るゾーンは
 * **`side='top'` では山側**なので、コード名のまま「谷ゾーン」と書くと逆になる。
 *
 * ここに無い type（継続系・未知）では日本語を方向なしの言い回しに落とす。
 */
const REVERSAL_STATUS_WORDS: Readonly<Record<string, { last: string; zone: '山' | '谷' }>> = {
	double_top: { last: '山2', zone: '山' },
	double_bottom: { last: '谷2', zone: '谷' },
	triple_top: { last: '山3', zone: '山' },
	triple_bottom: { last: '谷3', zone: '谷' },
	head_and_shoulders: { last: '右肩', zone: '山' },
	inverse_head_and_shoulders: { last: '右肩', zone: '谷' },
};

/**
 * 継続系（apex / 収束を持つ）パターン種別。`near_completion` を「apex 接近」と言ってよいのは
 * この集合だけ。legacy umbrella alias（`pennant` / `flag`）も含める——出力 type としては
 * 返らないが、`PatternEntry.type` は `string` なので表示層に届きうる。
 */
const CONTINUATION_STATUS_TYPES: ReadonlySet<string> = new Set([
	'triangle_ascending',
	'triangle_descending',
	'triangle_symmetrical',
	'falling_wedge',
	'rising_wedge',
	'bull_flag',
	'bear_flag',
	'bull_pennant',
	'bear_pennant',
	'pennant',
	'flag',
]);

/**
 * `status` そのものの日本語。`invalid` / `expired` / `near_completion` はここでは
 * **理由や種別を含めない裸のラベル**だけを持ち、括弧の中身は
 * {@link invalidReasonJa} / {@link nearCompletionJa} が足す。
 */
const STATUS_JA: Readonly<Record<string, string>> = {
	forming: '形成中',
	near_completion: 'ほぼ完成',
	completed: '完成（ブレイクアウト確認済み）',
	invalid: '無効',
	expired: '期限切れ',
};

/**
 * `invalidReason`（`status='invalid' | 'expired'` の理由コード）の日本語。
 * **表に無いコードには日本語を当てない（`null` を返す）。** issue #286 の教訓そのもので、
 * 旧実装は理由を問わず「無効（期待と逆方向にブレイク）」と書いており、
 * **その文言に対応する理由コードは検出器に 1 つも存在しなかった**（実機で
 * `invalidReason: 'peak_after_last_pivot'` の `double_top`——下方ブレイクは期待どおり——が
 * 「期待と逆方向にブレイク」と表示され、LLM がそのまま誤って説明した）。
 *
 * 新しい理由コードを検出器に足したらここにも足すこと。網羅は
 * `tests/detectPatternsViewsHandler.test.ts` の「status × 理由コードの網羅」が固定している。
 */
function invalidReasonJa(reason: string, type: string): string | null {
	const words = REVERSAL_STATUS_WORDS[type];
	const last = words?.last ?? '最終構成点';
	switch (reason) {
		case 're_entered_trough_zone':
			// 種別が引けないときは方向を持たない言い回しに落とす（「山」「谷」を推測しない）。
			return words
				? `${last} の確定後、突破前に${words.zone}ゾーンへ戻った`
				: '最終構成点の確定後、突破前に最終構成点のゾーンへ戻った';
		case 'peak_after_last_pivot':
			return `${last} の後に別の山を作ってから割った`;
		case 'trough_after_last_pivot':
			return `${last} の後に別の谷を作ってから抜けた`;
		case 'forming_expired':
			return '突破確認窓を過ぎてもネックラインを突破しなかった';
		case BREAKOUT_AGAINST_EXPECTATION:
			// 継続系専用。**`words` 由来の語（山2 / 谷3 / 右肩）を混ぜない**——継続系に
			// 最終構成点の概念が無く、当てはめると存在しない構造を名乗ることになる（issue #291）。
			// 方向の具体値は本行では言わない（「ブレイク方向」「パターン結果」の 2 行が持つ）。
			return '期待と逆方向にブレイク';
		default:
			return null;
	}
}

/**
 * `near_completion` の日本語。**同じ status が系統で別の事実を指す**ため種別で分ける:
 * 反転系は「構造は揃ってネックライン突破を待っている」、継続系は「apex に近い」。
 * どちらにも属さない type では apex とも未突破とも言わず「ほぼ完成」だけを出す。
 */
function nearCompletionJa(type: string): string {
	if (REVERSAL_STATUS_WORDS[type]) return 'ほぼ完成（構造成立・ネックライン未突破）';
	if (CONTINUATION_STATUS_TYPES.has(type)) return 'ほぼ完成（apex接近）';
	return 'ほぼ完成';
}

/**
 * パターン 1 件の状態行（`   - 状態: …`）。`status` が無ければ `null`（行を出さない）。
 *
 * `invalid` / `expired` では**`invalidReason` があれば必ず理由コードを併記する**（`無効（…: peak_after_last_pivot）`）。
 * 日本語は補助で、コードが LLM と利用者の共通語彙——`structuredContent` は LLM から見えないので、
 * `content` にコードを出さない限り理由は誰にも届かない。`invalidReason` が欠損なら裸のラベルだけ。
 */
export function formatStatusLine(p: Pick<PatternEntry, 'status' | 'invalidReason' | 'type'>): string | null {
	const status = p?.status;
	if (!status) return null;
	const base = STATUS_JA[status];
	// 未知の status は生の値をそのまま出す（誤った日本語を当てない）。
	if (!base) return `   - 状態: ${status}`;

	const type = String(p?.type ?? '');
	if (status === 'near_completion') return `   - 状態: ${nearCompletionJa(type)}`;
	if (status === 'invalid' || status === 'expired') {
		const reason = p?.invalidReason;
		if (!reason) return `   - 状態: ${base}`;
		const ja = invalidReasonJa(reason, type);
		return `   - 状態: ${base}（${ja ? `${ja}: ` : ''}${reason}）`;
	}
	return `   - 状態: ${base}`;
}

/**
 * `data.patterns[i]` 1 件を content 用の複数行テキストに整形する（summary / detailed / full / debug 共通）。
 * `価格範囲` は `pivots` 全点の min / max（反転系はネックライン定義点を含む。#224 症状 3）、
 * 形成中 triple の暫定注記は `status === 'forming'` で判定する（`pivots.length` には依存しない）。
 */
export function formatPatternLine(
	p: PatternEntry,
	idx: number,
	view: string,
	meta: PatternMeta,
	tz: string = 'Asia/Tokyo',
	// 時刻表示（issue #200 要件 F-1）。**シグネチャ末尾に足してある**——`effectiveParamsLine` と
	// 同じ理由（本 formatter は positional 呼び出しがテストだけで 30 箇所超あり、
	// 先頭寄りに入れると全て黙ってずれるため）。
	type: string = '1day',
): string {
	const name = String(p?.type || 'unknown');
	const conf = p?.confidence != null ? Number(p.confidence).toFixed(2) : 'n/a';
	// range.start/end は UTC ISO のまま構造化データに残す。表示のみ tz で整形する。
	const range = p?.range ? `${toDateOrTime(p.range.start, tz, type)} ~ ${toDateOrTime(p.range.end, tz, type)}` : 'n/a';
	const periodLines = buildPeriodLines(p, range, tz, type);

	// 低 confidence の警告ラベル。confidence < 0.6 は形状不十分、< 0.3 は除外候補レベル。
	// 「重要」「強いシグナル」「参考材料」扱いを防ぐため明示的に警告する。
	const confNum = Number(p?.confidence ?? NaN);
	let lowConfWarning: string | null = null;
	if (Number.isFinite(confNum) && confNum < 0.6) {
		lowConfWarning =
			confNum < 0.3
				? '   - ⚠️ 信頼度: 非常に低い（形状不十分・除外候補レベル、単独判断不可）'
				: '   - ⚠️ 信頼度: 低い（形状不十分・単独判断不可、他指標と必ず併用）';
	}

	// price range
	let priceRange: string | null = null;
	if (Array.isArray(p?.pivots) && p.pivots.length) {
		const prices = p.pivots.map((v) => Number(v?.price)).filter(Number.isFinite);
		if (prices.length)
			priceRange = `${Math.min(...prices).toLocaleString('ja-JP')}円 - ${Math.max(...prices).toLocaleString('ja-JP')}円`;
	}

	// neckline
	let neckline: string | null = null;
	if (Array.isArray(p?.neckline) && p.neckline.length === 2) {
		const [a, b] = p.neckline;
		const y1 = Number(a?.y),
			y2 = Number(b?.y);
		if (Number.isFinite(y1) && Number.isFinite(y2)) {
			neckline =
				y1 === y2
					? `${y1.toLocaleString('ja-JP')}円（水平）`
					: `${y1.toLocaleString('ja-JP')}円 → ${y2.toLocaleString('ja-JP')}円`;
		}
	}

	const idxToIso = buildIdxToIso(meta);

	// pivot detail lines（full / debug。triple 2 型 / H&S 2 型 × {4,5} 点 + double 2 型。issue #234）
	const pivotLines: string[] = [];
	if ((view === 'full' || view === 'debug') && Array.isArray(p?.pivots) && p.pivots.length >= 3) {
		const pivs = p.pivots;
		const roleLabels = pivotRoleLabels(String(p?.type ?? ''), pivs.length);
		// **`pivs.length` ではなく `roleLabels.length` で回す。** 表引きに失敗した型
		// （`roleLabels === null`）は 1 行も出さずに抜ける——ラベル配列と実際の点数が
		// 食い違ったまま添字で引くと、別の役割のラベルを黙って貼ることになる。
		if (roleLabels) {
			for (let i = 0; i < roleLabels.length; i++) {
				const pv = pivs[i];
				if (!pv) continue;
				const d = idxToIso[Number(pv.idx)] || '';
				const date = toDateOrTime(d || undefined, tz, type);
				pivotLines.push(`   - ${roleLabels[i]}: ${date} ${formatPivotPrices(pv)}`);
			}
		}
	}

	// breakout
	let breakoutLine: string | null = null;
	try {
		if ((view === 'full' || view === 'debug') && p?.breakout?.idx != null) {
			const bidx = Number(p.breakout.idx);
			const bpx = Number(p.breakout.price);
			const bIso = idxToIso[bidx];
			const bdate = bIso ? toDateOrTime(String(bIso), tz, type) : 'n/a';
			const bprice = Number.isFinite(bpx) ? Math.round(bpx).toLocaleString('ja-JP') : 'n/a';
			breakoutLine = `   - ブレイク: ${bdate} (${bprice}円)`;
		}
	} catch {
		/* ignore */
	}

	// status（`status` × `invalidReason` の表引き。issue #286）
	const statusLine = formatStatusLine(p);

	// forming triple: 3 点目が確定していないことを LLM に明示する。
	// 確定した主構成点は 2 点だけ（3 点目は現在価格の暫定値で `pivots` に入らない）なので、
	// pivots 配列だけ見ると 3 山構造を勘違いされる。
	// **`pivots.length` では判定しない**（#224 症状 3 で v1 / v2 のネックライン定義点を足したとき、
	// `length === 2` の条件が黙って注記を消した）。形成中 triple の 3 点目が暫定であることは
	// `status === 'forming'` そのものが表す事実なので、それだけで判定する——`pivots` の構成を
	// 再び変えても壊れない。
	let formingTripleNote: string | null = null;
	if ((p?.type === 'triple_top' || p?.type === 'triple_bottom') && p?.status === 'forming') {
		const role = p.type === 'triple_top' ? '3 山目' : '3 谷目';
		formingTripleNote = `   - 注: ${role}は現在価格を暫定（未確定）。2 確定ピボット + 現在価格で評価しているため、参考材料として扱う`;
	}

	// breakout direction & outcome
	let outcomeLine: string | null = null;
	try {
		if (p?.breakoutDirection && p?.outcome) {
			const directionJa = p.breakoutDirection === 'up' ? '上方' : '下方';
			const outcomeJa = p.outcome === 'success' ? '成功' : '失敗';
			const expectedDirMap: Record<string, string | undefined> = {
				falling_wedge: '上方',
				rising_wedge: '下方',
				triangle_ascending: '上方',
				triangle_descending: '下方',
				pennant: p.poleDirection === 'up' ? '上方' : p.poleDirection === 'down' ? '下方' : undefined,
				bull_flag: '上方',
				bear_flag: '下方',
				bull_pennant: '上方',
				bear_pennant: '下方',
			};
			const expectedDir = p.type ? expectedDirMap[p.type] : undefined;
			const meaningMap: Record<string, Record<string, string>> = {
				falling_wedge: { success: '強気転換', failure: '弱気継続' },
				rising_wedge: { success: '弱気転換', failure: '強気継続' },
				triangle_ascending: { success: '上方ブレイク（強気）', failure: '下方ブレイク（弱気転換）' },
				triangle_descending: { success: '下方ブレイク（弱気）', failure: '上方ブレイク（強気転換）' },
				pennant: {
					success: `トレンド継続（${p.poleDirection === 'up' ? '強気' : '弱気'}）`,
					failure: `ダマシ（${p.poleDirection === 'up' ? '弱気転換' : '強気転換'}）`,
				},
				bull_flag: { success: 'トレンド継続（強気）', failure: 'ダマシ（弱気転換）' },
				bear_flag: { success: 'トレンド継続（弱気）', failure: 'ダマシ（強気転換）' },
				bull_pennant: { success: 'トレンド継続（強気）', failure: 'ダマシ（弱気転換）' },
				bear_pennant: { success: 'トレンド継続（弱気）', failure: 'ダマシ（強気転換）' },
			};
			const meaning = (p.type && p.outcome ? meaningMap[p.type]?.[p.outcome] : undefined) || `${directionJa}ブレイク`;
			let dirLine = `   - ブレイク方向: ${directionJa}ブレイク`;
			if (expectedDir) dirLine += `（本来は${expectedDir}ブレイクが期待されるパターン）`;
			outcomeLine = `${dirLine}\n   - パターン結果: ${outcomeJa}（${meaning}）`;
		}
	} catch {
		/* ignore */
	}

	// flag / pennant fields (legacy 'pennant' + bull/bear flag/pennant)
	let pennantLine: string | null = null;
	try {
		const isFlagFamily =
			p?.type === 'pennant' ||
			p?.type === 'flag' ||
			p?.type === 'bull_flag' ||
			p?.type === 'bear_flag' ||
			p?.type === 'bull_pennant' ||
			p?.type === 'bear_pennant';
		if (isFlagFamily) {
			const parts: string[] = [];
			if (p.poleDirection) parts.push(`フラッグポール方向: ${p.poleDirection === 'up' ? '上昇' : '下降'}`);
			if (p.priorTrendDirection)
				parts.push(
					`先行トレンド: ${p.priorTrendDirection === 'bullish' ? '強気（上昇トレンド）' : '弱気（下降トレンド）'}`,
				);
			if (p.flagpoleHeight != null)
				parts.push(`フラッグポール値幅: ${Math.round(Number(p.flagpoleHeight)).toLocaleString('ja-JP')}円`);
			// pole の検証情報（bull/bear flag/pennant 用の新規フィールド）
			const pAny = p as PatternEntry & FlagFamilyViewFields;
			if (pAny.poleStartDate && pAny.poleEndDate && pAny.poleChangePct != null) {
				const psd = toDateOrTime(pAny.poleStartDate, tz, type);
				const ped = toDateOrTime(pAny.poleEndDate, tz, type);
				const sign = pAny.poleChangePct >= 0 ? '+' : '';
				const pctStr = `${sign}${(pAny.poleChangePct * 100).toFixed(1)}%`;
				const barsStr = pAny.poleBars ? `, ${pAny.poleBars}本` : '';
				parts.push(`旗竿期間: ${psd} ~ ${ped}（${pctStr}${barsStr}）`);
			}
			if (pAny.poleATRMult != null) {
				parts.push(`旗竿 ATR 倍率: ${pAny.poleATRMult.toFixed(2)}x`);
			}
			if (pAny.flagUpperSlope != null && pAny.flagLowerSlope != null) {
				parts.push(
					`チャネル傾き: 上限=${pAny.flagUpperSlope.toFixed(2)}, 下限=${pAny.flagLowerSlope.toFixed(2)}（円/本）`,
				);
			}
			if (pAny.spreadAvg != null && pAny.spreadStability != null) {
				const stabPct = (pAny.spreadStability * 100).toFixed(0);
				parts.push(`平均チャネル幅: ${Math.round(pAny.spreadAvg).toLocaleString('ja-JP')}円（平行度: ${stabPct}%）`);
			}
			if (pAny.expectedBreakoutDirection) {
				parts.push(`期待ブレイク方向: ${pAny.expectedBreakoutDirection === 'up' ? '上方' : '下方'}`);
			}
			if (p.retracementRatio != null) {
				const pctStr = (Number(p.retracementRatio) * 100).toFixed(0);
				parts.push(
					`戻し比率: ${pctStr}%${Number(p.retracementRatio) > 0.38 ? '（高め — トライアングル寄り）' : '（正常範囲）'}`,
				);
			}
			if (p.isTrendContinuation !== undefined)
				parts.push(`トレンド継続: ${p.isTrendContinuation ? 'はい（成功）' : 'いいえ（ダマシ）'}`);
			if (parts.length) pennantLine = parts.map((s) => `   - ${s}`).join('\n');
		}
	} catch {
		/* ignore */
	}

	// structure diagram
	let diagramBlock: string | null = null;
	try {
		if ((view === 'full' || view === 'detailed') && p?.structureDiagram?.svg) {
			const diagram = p.structureDiagram;
			const id = String(diagram?.artifact?.identifier || 'pattern-diagram');
			const title = String(diagram?.artifact?.title || 'パターン構造図');
			diagramBlock = [
				'--- Structure Diagram (SVG) ---',
				`identifier: ${id}`,
				`title: ${title}`,
				'type: image/svg+xml',
				'',
				String(diagram.svg),
			].join('\n');
		}
	} catch {
		/* noop */
	}

	// target price
	//
	// **ターゲット行は `breakoutTarget` の有無で握り潰さない。** `targetProgressOmittedReason:
	// 'no_target'` は「ターゲット価格そのものが出せなかった」ことの申告なので、
	// **理由を出すべき唯一のケースで `breakoutTarget` が必ず無い。** 価格行のガードの中に
	// 進捗行を入れていると、その 1 経路だけが content から消える（#224 症状 2 と同じ形が
	// 呼び出し側に残っていた。#288 Phase 2 のレビュー指摘）。
	let targetLine: string | null = null;
	// 日時は同ファイルの他の行（ブレイク確認・pivot 明細）と同じ整形に合わせる
	// （intraday は分まで、日足以上は暦日）。
	const progressLine = formatTargetProgressLine(p, { formatDate: (iso) => toDateOrTime(iso, tz, type) });
	if (p?.breakoutTarget != null) {
		const methodJa: Record<string, string> = {
			flagpole_projection: 'フラッグポール値幅投影',
			pattern_height: 'パターン高さ投影',
			neckline_projection: 'ネックライン投影',
		};
		targetLine = `   - ターゲット価格: ${Math.round(Number(p.breakoutTarget)).toLocaleString('ja-JP')}円（${(p.targetMethod && methodJa[p.targetMethod]) || p.targetMethod}）`;
		if (progressLine) targetLine += `\n${progressLine}`;
	} else if (progressLine) {
		targetLine = progressLine;
	}

	// relaxed フォールバック由来の provenance（#191 B。値は `data.patterns[]._fallback` と同一）。
	// **見出し行の末尾に付ける**——行数を増やさずに済み、`検出経路:` 行の集計と同じ語彙で照合できる。
	// strict 由来（`_fallback` なし）には何も付けない。「印が無い = strict」は
	// ヘッダ直下の `検出経路:` 行が件数で裏づけるので、ここでの黙りは推測にならない。
	const fallbackTag = typeof p?._fallback === 'string' && p._fallback.trim() ? ` [${p._fallback.trim()}]` : '';

	const lines = [
		`${idx + 1}. ${name} (パターン整合度: ${conf})${fallbackTag}`,
		lowConfWarning,
		...periodLines,
		statusLine,
		formingTripleNote,
		priceRange ? `   - 価格範囲: ${priceRange}` : null,
		...(pivotLines.length ? pivotLines : []),
		// 山2 / 谷2 の位置（issue #245）。**`view` で分岐しない**——`pivotLines` は full / debug
		// 限定だが、本行は 1 行で、軽い view でも「山2 がヒゲだけ」を LLM が読めるべきなので
		// 全 view に出す（規約 3 の上位集合もこれで保たれる）。
		formatSecondExtremePositionLine(p),
		neckline ? `   - ${p?.trendlineLabel || 'ネックライン'}: ${neckline}` : null,
		breakoutLine,
		outcomeLine,
		targetLine,
		pennantLine,
		diagramBlock,
	].filter(Boolean);
	return lines.join('\n');
}

// ── summary view ──

export function formatSummaryView(
	hdr: string,
	pats: PatternEntry[],
	periodBlock: string,
	typeSummary: string,
	patterns: string[] | undefined,
	includeForming: boolean | undefined,
	res: PatternResult,
	_tz: string = 'Asia/Tokyo',
	effectiveParamsLine: string = '',
): McpResponse {
	const now = Date.now();
	const within = (ms: number) =>
		pats.filter((p) => Number.isFinite(toTs(p?.range?.end)) && now - toTs(p.range?.end) <= ms).length;
	const in30 = within(30 * 86400000);
	const in90 = within(90 * 86400000);
	const formingHint = includeForming ? '' : '\n※形成中は includeForming=true を指定してください。';
	// 検出経路行（#191 B）。**3 view で同じ関数から組む**ので文言がずれない（= 上位集合テストが意味を持つ）。
	const routeLine = buildDetectionRouteLine(pats);
	// 縮小段の内訳（issue #200 要件 E）。他 3 view と同じく `buildReductionLine` から組む
	// （routeLine と同じパターンで、view 間の文言ずれを防ぐ）。本 formatter は `meta` を
	// 引数に取らないため `res.meta` から読む（`res` は常に渡ってくる）。
	const reductionLine = buildReductionLine(res?.meta as PatternMeta | undefined);
	const text = `${hdr}（${typeSummary || '分類なし'}、直近30日: ${in30}件、直近90日: ${in90}件）\n${periodBlock ? `${periodBlock}\n` : ''}${effectiveParamsLine ? `${effectiveParamsLine}\n` : ''}${routeLine ? `${routeLine}\n` : ''}${reductionLine ? `${reductionLine}\n` : ''}検討パターン: ${patterns?.length ? patterns.join(', ') : '既定セット'}${formingHint}\n詳細は structuredContent.data.patterns を参照。`;
	return { content: [{ type: 'text', text }], structuredContent: toStructured(res) };
}

// ── full view ──

export function formatFullView(
	hdr: string,
	pats: PatternEntry[],
	periodBlock: string,
	typeSummary: string,
	meta: PatternMeta,
	res: PatternResult,
	tz: string = 'Asia/Tokyo',
	effectiveParamsLine: string = '',
	// 時刻表示（issue #200 要件 F-1）。同上の理由で末尾に足す。
	type: string = '1day',
): McpResponse {
	const body = pats.map((p, i) => formatPatternLine(p, i, 'full', meta, tz, type)).join('\n\n');
	const overlayNote = res?.data?.overlays
		? '\n\nチャート連携: structuredContent.data.overlays を render_chart_svg.overlays に渡すと注釈/範囲を描画できます。'
		: '';
	const trustNote =
		'\n\nパターン整合度について（構成点の水準の揃い方・戻り率・ブレイク品質・期間から算出。軸の構成は種別で異なる）:\n  0.8以上 = 理想的な形状（教科書的パターン）\n  0.7-0.8 = 標準的な形状（他指標と併用推奨）\n  0.6-0.7 = やや不明瞭（慎重に判断）\n  0.6未満 = 形状不十分\n  ※ status=forming は最終構成点が未確定のため、整合度に関わらず「参考材料」として扱う';
	const routeLine = buildDetectionRouteLine(pats);
	const reductionLine = buildReductionLine(meta);
	const text = `${hdr}（${typeSummary || '分類なし'}）\n${periodBlock ? `${periodBlock}\n` : ''}${effectiveParamsLine ? `${effectiveParamsLine}\n` : ''}${routeLine ? `${routeLine}\n` : ''}${reductionLine ? `${reductionLine}\n` : ''}\n【検出パターン（全件）】\n${body}${overlayNote}${trustNote}`;
	return { content: [{ type: 'text', text }], structuredContent: toStructured(res) };
}

// ── detailed view (default) ──

/**
 * detailed view で明細を表示する上限件数（issue #196）。`top = pats.slice(0, …)` と
 * トリム申告行の閾値判定の両方がこの値を参照する——同じ値を 2 箇所に書くと、片方だけ変えた
 * ときに申告行の数字が実際の表示件数とずれる。
 */
const DETAILED_VIEW_PATTERN_LIMIT = 5;

export function formatDetailedView(
	hdr: string,
	pats: PatternEntry[],
	periodBlock: string,
	typeSummary: string,
	meta: PatternMeta,
	patterns: string[] | undefined,
	res: PatternResult,
	tz: string = 'Asia/Tokyo',
	effectiveParamsLine: string = '',
	// 時刻表示（issue #200 要件 F-1）。同上の理由で末尾に足す。
	type: string = '1day',
): McpResponse {
	const top = pats.slice(0, DETAILED_VIEW_PATTERN_LIMIT);
	const body = top.length ? top.map((p, i) => formatPatternLine(p, i, 'detailed', meta, tz, type)).join('\n\n') : '';
	// cap トリムの申告（issue #196）。`pats` は cap 前の data.patterns そのもの（不変）なので、
	// swings/candidates と違い meta 側の総数は要らず pats.length がそのまま total になる。
	// **`pats.length < 上限` のときは行ごと出さない**（`slice` が構造的に全件を返すため省略が
	// 起こり得ず、`formatTrimNote` の「省略なし」を毎回出すと明細の前に定型文が積み重なるだけの
	// ノイズになる）。ちょうど上限件数のときだけ「たまたま上限と同じ件数」と「cap で切られた」の
	// 区別がつかない（swings/candidates の 200 件と同じ曖昧さ）ので、その境界でだけ明示する。
	const patternsNote =
		pats.length >= DETAILED_VIEW_PATTERN_LIMIT
			? formatTrimNote(top.length, pats.length, undefined, '全件は view=full')
			: '';

	let none = '';
	if (!top.length) {
		const resSummary = String(res?.summary ?? '');
		if (resSummary === 'insufficient data') {
			none = `\n${resSummary}`;
		} else {
			// **入力値へのフォールバックはしない**（#184 欠陥 E）。旧実装は
			// `meta.effective_params?.tolerancePct ?? tolerancePct ?? 'default'` と書いており、
			// `effective_params` が出力スキーマ未宣言で常に strip されていた（欠陥 D）ため
			// 第 2 項の**生入力値**に落ちていた。1hour・未指定では `tolerancePct=0.04` と表示され
			// （実効値は 0.05）、その 0.04 を基準に緩和を助言していた——#182 の誤報告の誘発元。
			// 値そのものはヘッダ直下の実効パラメータ行（`effectiveParamsLine`）に一本化したので、
			// ここは助言だけを持つ。実効値が無いときは数値を主張しない。
			const effTol = meta?.effective_params?.tolerancePct?.value;
			// 緩める / 締めるの基準は**実効値**。旧文言「0.03-0.06 に緩和」は 1hour（実効 0.05）では
			// 半分が締める方向を指していた。
			const loosenHint = Number.isFinite(effTol as number)
				? `・緩めるなら tolerancePct に実効値 ${effTol} より大きい値を指定してください（上限 0.1）。${effTol} 以下は締める方向です（スキーマ既定値 0.04 は sentinel なので時間軸オート値に戻ります）`
				: '・緩めるなら tolerancePct を実効値より大きい値に上げてください（上限 0.1。実効値は上の実効パラメータ行を参照）。スキーマ既定値 0.04 は sentinel なので時間軸オート値に置換されます';
			none = `\nパターンは検出されませんでした。\n・検討パターン: ${patterns?.length ? patterns.join(', ') : '既定セット'}\n${loosenHint}`;
		}
	}

	const overlayNote = res?.data?.overlays
		? '\n\nチャート連携: structuredContent.data.overlays を render_chart_svg.overlays に渡すと注釈/範囲を描画できます。'
		: '';
	const trustNote =
		'\n\nパターン整合度について（構成点の水準の揃い方・戻り率・ブレイク品質・期間から算出。軸の構成は種別で異なる）:\n  0.8以上 = 理想的な形状（教科書的パターン）\n  0.7-0.8 = 標準的な形状（他指標と併用推奨）\n  0.6-0.7 = やや不明瞭（慎重に判断）\n  0.6未満 = 形状不十分\n  ※ status=forming は最終構成点が未確定のため、整合度に関わらず「参考材料」として扱う';
	const usage = `\n\nusage_example:\n  step1: detect_patterns を実行\n  step2: structuredContent.data.overlays を取得\n  step3: render_chart_svg の overlays に渡す`;
	const routeLine = buildDetectionRouteLine(pats);
	const reductionLine = buildReductionLine(meta);
	const text = `${hdr}（${typeSummary || '分類なし'}）\n${periodBlock ? `${periodBlock}\n` : ''}${effectiveParamsLine ? `${effectiveParamsLine}\n` : ''}${routeLine ? `${routeLine}\n` : ''}${reductionLine ? `${reductionLine}\n` : ''}\n${top.length ? `【検出パターン】${patternsNote}\n${body}` : ''}${none}${overlayNote}${trustNote}${usage}`;
	return {
		content: [{ type: 'text', text }],
		structuredContent: {
			...res,
			usage_example: {
				step1: 'detect_patterns を実行',
				step2: 'data.overlays を取得',
				step3: 'render_chart_svg の overlays に渡す',
			},
		},
	};
}
