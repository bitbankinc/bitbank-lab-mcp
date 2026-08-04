/**
 * deprecated な旧 `view` 値（alias）と新しい指定が同じ応答を返す — の写像テスト。
 *
 * 根拠: docs/internal/view-vocabulary-unification.md §4-4 の alias 写像表
 *
 * | ツール | 旧値 | 新しい指定 |
 * |---|---|---|
 * | `get_candles` | `items` | `view=full` + `format=json` |
 * | `get_transactions` | `summary` | `view=full` |
 * | `get_transactions` | `items` | `view=full` + `format=json` |
 * | `get_flow_metrics` | `compact` | `view=full` + `nonZeroOnly=true` |
 * | `get_flow_metrics` | `buckets` | `view=detailed` |
 *
 * alias は DEPRECATED_VIEW_REMOVAL_TARGET まで受理し続ける（§6-4: 最低 1 リリース かつ 3 ヶ月）。本ファイルは
 * その期間中「旧値を送っているクライアントの応答が変わっていない」ことを固定する。
 *
 * **`content` と `structuredContent` を分けて検証する。** 「不変」を一語で片付けると、
 * `get_candles(items)` のように `structuredContent` だけ意図的に変えた値で嘘になる（§4-4）。
 *
 * 時刻の固定: `meta.fetchedAt` は呼び出しごとの実時刻なので、Date だけを固定して
 * 2 回の呼び出しの deep-equal が壊れないようにする（timer は実物のまま = fetch のリトライ待ちを壊さない）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../lib/datetime.js';
import { toolDef as candlesTool } from '../tools/get_candles.js';
import { toolDef as flowMetricsTool } from '../tools/get_flow_metrics.js';
import { toolDef as transactionsTool } from '../tools/get_transactions.js';

// ── helpers ───────────────────────────────────────────────

type HandlerResponse = {
	content?: Array<{ type: string; text: string }>;
	structuredContent?: Record<string, unknown>;
};

function mockFetchJson(payload: unknown) {
	vi.spyOn(globalThis, 'fetch').mockResolvedValue({
		ok: true,
		status: 200,
		statusText: 'OK',
		json: async () => payload,
	} as unknown as Response);
}

/**
 * ハンドラ応答から MCP クライアントが受け取る `content` / `structuredContent` を取り出す。
 * `src/server.ts` の `respond()` と同じ規則で、生の `Result` を返すハンドラは
 * `content[0].text = summary` / `structuredContent = Result` にフォールバックする。
 */
function responseOf(res: unknown): { content: Array<{ type: string; text: string }>; structured: unknown } {
	const r = res as HandlerResponse & { summary?: string };
	if (Array.isArray(r.content)) {
		return { content: r.content, structured: r.structuredContent ?? r };
	}
	return { content: [{ type: 'text', text: String(r.summary ?? '') }], structured: r };
}

// ── get_flow_metrics ──────────────────────────────────────

/**
 * **ゼロ出来高のバケットが連続して挟まる**フィクスチャ（§5-5 受け入れ基準①）。
 *
 * 約定を 0 分 / 2 分 / 22 分に置くと、bucketMs=60000 で 23 バケットになり:
 *   - index 0 / 2 / 22 … 非ゼロ
 *   - index 1、3〜21   … 出来高ゼロ（約定が 1 件も無かった区間）
 *
 * 旧 `compact` の絞り込みは `buyVolume > 0 || sellVolume > 0` の**素の非ゼロフィルタ**なので、
 * ゼロのバケットは 1 件だろうと 19 件連続だろうと等しく content から落ちる。
 * このフィクスチャは「落とす対象が単発（index 1）と連続（index 3〜21）の両方ある」状態を作り、
 * 写像先（`view=full` + `nonZeroOnly=true`）が同じ絞り込みをしていることを固定する。
 */
/**
 * bitbank `/transactions` の 1 行。**数値も含めて全て文字列**で返る
 * （`price` / `amount` / `executed_at`）。フィクスチャをこの型で縛って、
 * 実 API と乖離したモック（例: `executed_at` を数値で書く）が入らないようにする。
 */
type BitbankTxRow = {
	transaction_id?: number;
	price: string;
	amount: string;
	side: 'buy' | 'sell';
	executed_at: string;
};

const FLOW_T0 = 1_700_000_000_000;
const FLOW_TX_ROWS: BitbankTxRow[] = [
	{ price: '5000000', amount: '0.1', side: 'buy', executed_at: String(FLOW_T0) },
	{ price: '5000100', amount: '0.2', side: 'sell', executed_at: String(FLOW_T0 + 2 * 60_000) },
	{ price: '5000200', amount: '0.3', side: 'buy', executed_at: String(FLOW_T0 + 22 * 60_000) },
];
/** 非ゼロのバケット index（この 3 件だけが nonZeroOnly の content に出る）。 */
const FLOW_NON_ZERO_INDICES = [0, 2, 22] as const;
/** 出来高ゼロのバケット index（単発 1 件 + 連続 19 件）。 */
const FLOW_ZERO_INDICES = [1, ...Array.from({ length: 19 }, (_, i) => 3 + i)] as const;
const FLOW_BUCKET_COUNT = 23;

function runFlow(args: Record<string, unknown>) {
	mockFetchJson({ success: 1, data: { transactions: FLOW_TX_ROWS } });
	return flowMetricsTool.handler({ pair: 'btc_jpy', limit: 10, date: '20240101', bucketMs: 60_000, ...args });
}

/** バケット行ブロック（見出し + 行）を content から切り出す。見出しの直前は必ず空行。 */
function bucketSection(text: string): { heading: string; lines: string[] } {
	const m = text.match(/\n\n((?:Non-zero|Recent|All) [^\n]*:)\n([\s\S]*)$/u);
	if (!m) throw new Error(`バケット行ブロックが見つからない:\n${text}`);
	return { heading: m[1], lines: m[2].split('\n') };
}

/** `PAIR Flow Metrics (bucketMs=…)` + `Totals:` の 2 行ヘッダ（上位集合の保証で full / detailed に入った）。 */
function bucketHeaderBlock(text: string): string {
	const m = text.match(/^[A-Z_]+ Flow Metrics \(bucketMs=\d+\)[^\n]*\nTotals: [^\n]*$/mu);
	if (!m) throw new Error(`バケットヘッダが見つからない:\n${text}`);
	return m[0];
}

describe('deprecated view alias の写像（§4-4）', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(dayjs.utc('2026-03-01T00:00:00Z').valueOf());
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('get_flow_metrics', () => {
		it('compact → view=full + nonZeroOnly=true（content / structuredContent とも完全一致）', async () => {
			const legacy = responseOf(await runFlow({ view: 'compact' }));
			const mapped = responseOf(await runFlow({ view: 'full', nonZeroOnly: true }));

			expect(mapped.content).toEqual(legacy.content);
			expect(mapped.structured).toEqual(legacy.structured);
		});

		it('compact のバケット行: 出来高ゼロのバケットは単発でも連続でも content に出ない', async () => {
			const { content, structured } = responseOf(await runFlow({ view: 'full', nonZeroOnly: true }));
			const buckets = (
				structured as {
					data: { series: { buckets: Array<{ displayTime: string; buyVolume: number; sellVolume: number }> } };
				}
			).data.series.buckets;
			const label = (i: number) => buckets[i].displayTime;
			const { heading, lines } = bucketSection(content[0].text);

			// フィクスチャが意図どおり「非ゼロ 3 件 + ゼロ 20 件（単発 1 + 連続 19）」であること。
			// これが崩れると以下の assert は別のものを検証してしまう。
			expect(buckets).toHaveLength(FLOW_BUCKET_COUNT);
			for (const i of FLOW_ZERO_INDICES) {
				expect(buckets[i].buyVolume === 0 && buckets[i].sellVolume === 0, `index ${i} が非ゼロ`).toBe(true);
			}

			// 見出しは旧 compact と同一文言（分母は全バケット数）
			expect(heading).toBe(`Non-zero 3/${FLOW_BUCKET_COUNT} buckets:`);

			// 非ゼロの 3 行だけ。行の順序も元のバケット順のまま
			expect(lines).toHaveLength(FLOW_NON_ZERO_INDICES.length);
			FLOW_NON_ZERO_INDICES.forEach((bucketIndex, lineIndex) => {
				expect(lines[lineIndex].startsWith(`${label(bucketIndex)}  buy=`)).toBe(true);
			});

			// ゼロのバケットは 1 行も出ない（structuredContent には残っている）
			for (const i of FLOW_ZERO_INDICES) {
				expect(content[0].text, `index ${i} の行が content に出ている`).not.toContain(`${label(i)}  buy=`);
			}
		});

		/**
		 * §3-3 の「旧 `compact` と完全一致」は **上位集合の保証（P3 の修正）以降そのままでは成立しない**。
		 * `full` / `detailed` が `res.summary` ベースになった結果、バケット行の直前に
		 * 2 行ヘッダ（`PAIR Flow Metrics (bucketMs=…)` / `Totals:`）が入るためで、
		 * `compact` は元から `res.summary` ベースでこのヘッダを持たない。
		 *
		 * 正しい要件は「**バケット行**は旧 `compact` と完全一致。ヘッダ・フッタ・注記行は
		 * §3-2 規約 3（上位集合）に従い**増える方向の差分のみ許容**（減ってはならない）」。
		 * ヘッダを削って完全一致させるのは §3-2 規約 3 に反するので誤り。
		 *
		 * ここでは「差分がヘッダ 2 行ちょうどであること」を byte 単位で固定する——
		 * 旧 `compact` の content = `view=summary` の content（= `res.summary`）＋ 空行 ＋ バケット行ブロック。
		 */
		it('compact の content は「ヘッダ 2 行が増えるだけ」で、消えた要素は無い', async () => {
			const summaryText = responseOf(await runFlow({ view: 'summary' })).content[0].text;
			const text = responseOf(await runFlow({ view: 'compact' })).content[0].text;
			const { heading, lines } = bucketSection(text);
			const header = bucketHeaderBlock(text);

			// 旧 compact = res.summary + 空行 + バケット行ブロック（ヘッダ無し）
			const legacyCompactText = `${summaryText}\n\n${heading}\n${lines.join('\n')}`;
			expect(text.replace(`${header}\n\n`, '')).toBe(legacyCompactText);

			// 増えた 2 行は上位集合の保証で detailed / full に入ったヘッダそのもの
			expect(header.split('\n')).toHaveLength(2);
			expect(header).toContain('Flow Metrics (bucketMs=60000)');
			expect(header).toContain('Totals: trades=3');
		});

		it('buckets → view=detailed（content 完全一致）', async () => {
			const legacy = responseOf(await runFlow({ view: 'buckets', bucketsN: 5 }));
			const mapped = responseOf(await runFlow({ view: 'detailed', bucketsN: 5 }));

			expect(mapped.content).toEqual(legacy.content);
			expect(mapped.structured).toEqual(legacy.structured);
			// 旧 buckets の見出しがそのまま（直近 N 件）
			expect(bucketSection(mapped.content[0].text).heading).toBe('Recent 5 buckets:');
		});

		it('buckets + nonZeroOnly=true は写像先が定める false を優先する（compact との自己矛盾を作らない）', async () => {
			// 旧値は「量 + 絞り込み」を 1 語で決めていたので、旧値と nonZeroOnly の同時指定は
			// 写像が決める値を優先する。buckets の写像先は nonZeroOnly=false。
			const withFlag = responseOf(await runFlow({ view: 'buckets', bucketsN: 5, nonZeroOnly: true }));
			const mapped = responseOf(await runFlow({ view: 'detailed', bucketsN: 5 }));
			expect(withFlag.content).toEqual(mapped.content);
			// structuredContent も突き合わせる。content だけ見ていると、レンダリングは false で
			// 行いつつ呼び出し値の true を meta にエコーする実装が素通りしてしまう。
			expect(withFlag.structured).toEqual(mapped.structured);
		});

		it('view=summary + nonZeroOnly=true は no-op（エラーにしない）', async () => {
			// 量（view）と絞り込み（nonZeroOnly）は直交する軸なので、
			// 「絞り込む対象が content に無い」は矛盾ではない（§3-3）。
			const plain = responseOf(await runFlow({ view: 'summary' }));
			const withFlag = responseOf(await runFlow({ view: 'summary', nonZeroOnly: true }));

			expect(withFlag.content).toEqual(plain.content);
			expect(withFlag.structured).toEqual(plain.structured);
			expect(() => bucketSection(withFlag.content[0].text)).toThrow();
		});

		it('detailed + nonZeroOnly=true は旧 enum で表現できなかった組み合わせを表現する', async () => {
			// 直近 N 件に絞ったうえで非ゼロだけを出す（量と絞り込みの 2 軸を分けた結果）。
			const { content } = responseOf(await runFlow({ view: 'detailed', bucketsN: 21, nonZeroOnly: true }));
			const { heading, lines } = bucketSection(content[0].text);

			// 直近 21 バケット（index 2〜22）が候補。うち非ゼロは index 2 / 22 の 2 件。
			// 見出しは full と別文言にして、分母が「直近 N 件」であることを読み取れるようにしている。
			expect(heading).toBe('Recent 21 buckets, non-zero 2:');
			expect(lines).toHaveLength(2);
		});
	});

	// ── get_transactions ──────────────────────────────────

	// executed_at は上流が文字列で返す（FLOW_TX_ROWS と同じ形）。数値で書くと
	// 「モックは実際の API レスポンス構造と乖離しない」に反し、文字列 → 数値の
	// 正規化を素通りさせてしまう。
	const TX_ROWS: BitbankTxRow[] = [
		{ transaction_id: 1, price: '5000000', amount: '0.1', side: 'buy', executed_at: String(FLOW_T0) },
		{ transaction_id: 2, price: '5000100', amount: '0.2', side: 'sell', executed_at: String(FLOW_T0 + 60_000) },
		{ transaction_id: 3, price: '5000200', amount: '0.3', side: 'buy', executed_at: String(FLOW_T0 + 120_000) },
	];

	// rows は `unknown[]`。drop 警告のテストで**意図的に契約違反の行**を混ぜるため、
	// ここだけは BitbankTxRow で縛らない（縛ると異常系が書けなくなる）。
	function runTransactions(args: Record<string, unknown>, rows: unknown[] = TX_ROWS) {
		mockFetchJson({ success: 1, data: { transactions: rows } });
		return transactionsTool.handler({ pair: 'btc_jpy', limit: 10, date: '20240101', ...args });
	}

	describe('get_transactions', () => {
		it('summary → view=full（content / structuredContent とも完全一致）', async () => {
			const legacy = responseOf(await runTransactions({ view: 'summary' }));
			const mapped = responseOf(await runTransactions({ view: 'full' }));

			expect(mapped.content).toEqual(legacy.content);
			expect(mapped.structured).toEqual(legacy.structured);
			// 旧 summary は名前に反して「全件列挙」だった。実体が full なので中身も確認しておく。
			expect(mapped.content[0].text).toContain('📋 全3件の取引');
		});

		it('default（view 未指定）は full で、旧 default の summary と一致する', async () => {
			// default を summary → full に変えたが**挙動は不変**（§3-5）。
			const legacyDefault = responseOf(await runTransactions({ view: 'summary' }));
			const currentDefault = responseOf(await runTransactions({}));

			expect(currentDefault.content).toEqual(legacyDefault.content);
			expect(currentDefault.structured).toEqual(legacyDefault.structured);
		});

		it('items → view=full + format=json（content 完全一致）', async () => {
			const legacy = responseOf(await runTransactions({ view: 'items' }));
			const mapped = responseOf(await runTransactions({ view: 'full', format: 'json' }));

			expect(mapped.content).toEqual(legacy.content);
			expect(mapped.structured).toEqual(legacy.structured);
			expect(JSON.parse(mapped.content[0].text)).toHaveLength(3);
		});

		it('items → view=full + format=json: warning の別ブロックも含めて一致', async () => {
			// 不正行を混ぜて drop 警告（meta.warning）を立てる。content[0] は JSON のまま、
			// warning は content[1] に別ブロックで載る——この構造ごと一致することを見る。
			const rowsWithInvalid = [...TX_ROWS, { transaction_id: 4, price: 'NaN', amount: 'x', side: 'buy' }];
			const legacy = responseOf(await runTransactions({ view: 'items' }, rowsWithInvalid));
			const mapped = responseOf(await runTransactions({ view: 'full', format: 'json' }, rowsWithInvalid));

			expect(legacy.content.length).toBeGreaterThan(1);
			expect(mapped.content).toEqual(legacy.content);
		});
	});

	// ── get_candles ───────────────────────────────────────

	/** 末尾が「今日」の日足。realtime 経路になり最新足が形成中（ℹ️ 注記あり）になる。 */
	function rowsEndingToday(count: number): string[][] {
		const todayStart = dayjs().utc().startOf('day').valueOf();
		return Array.from({ length: count }, (_, i) => {
			const base = 100 + i;
			return [
				String(base),
				String(base + 10),
				String(base - 10),
				String(base + 5),
				'1.0',
				String(todayStart - (count - 1 - i) * 86_400_000),
			];
		});
	}

	/** 2024-01-01 起点の確定足。date='2024' の anchor 経路で使う（形成中足の注記は付かない）。 */
	function pastRows(count: number): string[][] {
		const baseTs = 1_704_067_200_000; // 2024-01-01 UTC
		return Array.from({ length: count }, (_, i) => {
			const base = 100 + i;
			return [
				String(base),
				String(base + 10),
				String(base - 10),
				String(base + 5),
				'1.0',
				String(baseTs + i * 86_400_000),
			];
		});
	}

	function runCandles(args: Record<string, unknown>, rows: string[][]) {
		mockFetchJson({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } });
		return candlesTool.handler({ pair: 'btc_jpy', type: '1day', limit: 14, ...args });
	}

	describe('get_candles', () => {
		it('items → view=full + format=json（content 完全一致）', async () => {
			const rows = pastRows(30);
			const legacy = responseOf(await runCandles({ view: 'items', date: '2024' }, rows));
			const mapped = responseOf(await runCandles({ view: 'full', format: 'json', date: '2024' }, rows));

			expect(mapped.content).toEqual(legacy.content);
			expect(JSON.parse(mapped.content[0].text)).toHaveLength(14);
		});

		it('items + format=text でも JSON が出る（alias が format 指定より優先される）', async () => {
			// `view=items` の写像先は `view=full` + `format=json` なので、同時に渡された
			// `format=text` は写像が決める json に上書きされる（get_flow_metrics の
			// `compact` + `nonZeroOnly=false` と同じ扱い。旧値は「量 + 形式」を 1 語で決めていたため）。
			// alias 期間中に呼び出し側が偶然踏みうる唯一の分岐なので固定しておく。
			const rows = pastRows(30);
			const withText = responseOf(await runCandles({ view: 'items', format: 'text', date: '2024' }, rows));
			const mapped = responseOf(await runCandles({ view: 'full', format: 'json', date: '2024' }, rows));

			expect(withText.content).toEqual(mapped.content);
			expect(withText.structured).toEqual(mapped.structured);
			expect(JSON.parse(withText.content[0].text)).toHaveLength(14);
		});

		it('items → view=full + format=json: 形成中足注記の別ブロックも含めて一致', async () => {
			// date 省略 = realtime 経路。最新足が形成中なので content[1] に ℹ️ 注記が載る。
			const rows = rowsEndingToday(30);
			const legacy = responseOf(await runCandles({ view: 'items' }, rows));
			const mapped = responseOf(await runCandles({ view: 'full', format: 'json' }, rows));

			expect(legacy.content.length).toBeGreaterThan(1);
			expect(legacy.content.some((c) => c.text.includes('未確定（形成中）'))).toBe(true);
			expect(mapped.content).toEqual(legacy.content);
		});

		/**
		 * **`structuredContent` は意図的に変わる**（語彙統一で唯一の shape 破壊。§4-4 / §4-5）。
		 * 旧 `items` は `{ items, meta }` を返し `ok` / `summary` / `data.{raw,keyPoints,volumeStats}` を
		 * 落としていた。新しい形（他ツールと同じ `Result` 封筒）をここで固定する。
		 * 消費者は `structuredContent.items` → `structuredContent.data.normalized` へ読み替える。
		 */
		it('items の structuredContent は Result 封筒に変わる（旧 items.items は data.normalized へ）', async () => {
			const rows = pastRows(30);
			const items = responseOf(await runCandles({ view: 'items', date: '2024' }, rows)).structured as Record<
				string,
				unknown
			>;
			const full = responseOf(await runCandles({ view: 'full', date: '2024' }, rows)).structured as Record<
				string,
				unknown
			>;

			expect(Object.keys(items).sort()).toEqual(['data', 'meta', 'ok', 'summary']);
			expect(items).toEqual(full);
			// 旧 shape はもう返らない
			expect(Object.hasOwn(items, 'items')).toBe(false);
			// 読み替え先に旧 items.items と同じ内容が入っている
			expect((items.data as { normalized: unknown[] }).normalized).toHaveLength(14);
		});
	});
});
