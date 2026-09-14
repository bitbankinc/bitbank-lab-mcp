/**
 * ツール間「同一量」整合の固定値テスト。
 *
 * 提示層監査で「要追加確認」となった、別ツールが返す同一概念の量が一致するか
 * （あるいは一致条件と許容差が何か）を固定モックで実証/担保する。
 * いずれも値の破壊ではなく、検証の空白を埋めるのが目的。
 *
 * 設計は tests/mid-rounding-consistency.test.ts / tests/fee-source-consistency.test.ts
 * （別経路の同一量一致を固定する）に倣う。
 *
 * 対象:
 *  (1) volume 整合   : get_candles（/candlestick の OHLCV[4]）↔ get_flow_metrics（/transactions の amount 合算）
 *  (2) price 高安整合 : get_candles の priceRange ↔ 同一 normalized 由来 high/low ↔ analyze_indicators の chart.stats
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatPrice } from '../lib/formatter.js';
import analyzeIndicators, { clearIndicatorCache } from '../tools/analyze_indicators.js';
import getCandles from '../tools/get_candles.js';
import getFlowMetrics from '../tools/get_flow_metrics.js';
import { asMockResult, assertOk } from './_assertResult.js';

type OhlcvRow = [string, string, string, string, string, string];
type TxRow = { transaction_id: number; price: string; amount: string; side: 'buy' | 'sell'; executed_at: number };

/**
 * normalized 足から volume を取り出す。CandleSchema 上 volume は optional なので、
 * 欠損を 0 に畳まず明示的に失敗させる（畳むと数量整合の主張が黙って緩む）。
 */
function candleVolumes(candles: readonly { volume?: number }[]): number[] {
	return candles.map((c, i) => {
		if (c.volume === undefined) throw new Error(`normalized[${i}].volume が欠損している`);
		return c.volume;
	});
}

/** 1 本の Response を返す共通 JSON モック。複数回 fetch に同一スナップショットで応答する。 */
function mockJson(payload: unknown) {
	return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		asMockResult<Response>({
			ok: true,
			status: 200,
			statusText: 'OK',
			headers: new Headers(),
			json: async () => payload,
		}),
	);
}

/**
 * URL に応じて candlestick / transactions を出し分ける fetch モック。
 * get_candles は /candlestick、get_flow_metrics(→get_transactions) は /transactions を引く。
 */
function mockCandlesAndTx(candleRows: OhlcvRow[], txRows: TxRow[], candleType = '1min') {
	const candlePayload = { success: 1, data: { candlestick: [{ type: candleType, ohlcv: candleRows }] } };
	const txPayload = { success: 1, data: { transactions: txRows } };
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
		const u = String(url);
		const payload = u.includes('/candlestick/') ? candlePayload : txPayload;
		return asMockResult<Response>({
			ok: true,
			status: 200,
			statusText: 'OK',
			headers: new Headers(),
			json: async () => payload,
		});
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

// ── (1) volume 整合: get_candles ↔ get_flow_metrics ───────────────────────────
//
// 一致条件（無条件には一致しない点が重要）:
//   - データソースが異なる: candle volume は取引所が確定した OHLCV[4]、flow は /transactions の amount 合算。
//   - 取得窓が異なる: candle は時間足アンカー、flow は件数/時間ベース。
//   - 下記をすべて満たすときに限り Σ totalVolume ≈ candle volume となる:
//       (a) bucketMs を足幅（1min = 60_000ms）に揃える
//       (b) 約定をローソク足と同一の時間窓に限定する（= その足に属する約定のみ）
//       (c) 取得上限内（約定が間引かれていない = 全件取得できている）
// 本テストは (c) を「candle.volume を Σ(約定 amount) と一致させた固定フィクスチャ」で再現する
// （実データでは /transactions の間引きで (c) が崩れ、過小評価になりうる）。
//
// 許容差（tolerance）:
//   get_flow_metrics は totalVolume / buyVolume / sellVolume を Number(x.toFixed(8)) で量子化するため、
//   浮動小数の加算誤差と合わせて 1e-8 オーダーの差が出うる。よって厳密等値ではなく
//   toBeCloseTo(_, 8)（|Δ| < 5e-9）で固定する。
describe('(1) volume 整合: get_candles(OHLCV[4]) ↔ get_flow_metrics(Σ amount)', () => {
	// 2024-01-15 10:00:00Z を起点に 1 分足 3 本。
	const BAR0 = Date.UTC(2024, 0, 15, 10, 0, 0);
	const MIN = 60_000;

	// 各足の volume は「その足に属する約定 amount の合計」に一致させる（条件 (c) の再現）。
	// bar0: 0.1 + 0.2 = 0.3 / bar1: 0.125 + 0.375 = 0.5 / bar2: 0.25
	const candleRows: OhlcvRow[] = [
		['100', '110', '90', '105', '0.3', String(BAR0)],
		['105', '115', '95', '108', '0.5', String(BAR0 + MIN)],
		['108', '112', '100', '110', '0.25', String(BAR0 + 2 * MIN)],
	];

	// 約定は各足の時間窓内に配置する（最初の約定を bar0 の先頭に置き、bucket 境界を足境界に揃える）。
	const txRows: TxRow[] = [
		{ transaction_id: 1, price: '100', amount: '0.1', side: 'buy', executed_at: BAR0 },
		{ transaction_id: 2, price: '105', amount: '0.2', side: 'sell', executed_at: BAR0 + 30_000 },
		{ transaction_id: 3, price: '108', amount: '0.125', side: 'buy', executed_at: BAR0 + MIN },
		{ transaction_id: 4, price: '109', amount: '0.375', side: 'sell', executed_at: BAR0 + MIN + 30_000 },
		{ transaction_id: 5, price: '110', amount: '0.25', side: 'buy', executed_at: BAR0 + 2 * MIN },
	];

	const expectedPerBar = [0.3, 0.5, 0.25];
	const expectedTotal = expectedPerBar.reduce((a, b) => a + b, 0); // 1.05

	it('bucketMs=足幅・同一窓: バケット毎/総和ともに candle volume と一致する', async () => {
		mockCandlesAndTx(candleRows, txRows);

		// tz='UTC' で 1 UTC 日内に収め、単一 fetch（multi-day 回避）でアンカー取得する。
		const gc = await getCandles('btc_jpy', '1min', '20240115', 3, 'UTC');
		assertOk(gc);
		// limit=5（=約定件数）で latest 経路のみ（補完 fetch なし）。bucketMs=60_000=足幅。
		const fm = await getFlowMetrics('btc_jpy', 5, undefined, MIN);
		assertOk(fm);

		const candleVols = candleVolumes(gc.data.normalized);
		expect(candleVols).toEqual(expectedPerBar);

		const buckets = fm.data.series.buckets;
		// 足幅と bucketMs が一致するので、バケット数 = ローソク足数。
		expect(buckets.length).toBe(candleVols.length);

		// バケット毎の totalVolume が対応する足の volume に一致する。
		for (let i = 0; i < candleVols.length; i++) {
			expect(buckets[i].totalVolume).toBeCloseTo(candleVols[i], 8);
		}

		// 総和の一致（Σ totalVolume ≈ Σ candle volume）。
		const flowTotal = buckets.reduce((s: number, b: { totalVolume: number }) => s + b.totalVolume, 0);
		const candleTotal = candleVols.reduce((a: number, b: number) => a + b, 0);
		expect(flowTotal).toBeCloseTo(candleTotal, 8);
		expect(candleTotal).toBeCloseTo(expectedTotal, 8);

		// aggregates 経由（buyVolume + sellVolume = Σ amount）でも総和が一致する。
		const aggTotal = fm.data.aggregates.buyVolume + fm.data.aggregates.sellVolume;
		expect(aggTotal).toBeCloseTo(candleTotal, 8);
	});

	it('条件が崩れる例（bucketMs≠足幅）: バケット毎では一致しないが、総和は不変（同一約定集合のため）', async () => {
		mockCandlesAndTx(candleRows, txRows);

		const gc = await getCandles('btc_jpy', '1min', '20240115', 3, 'UTC');
		assertOk(gc);
		// bucketMs=30_000（足幅の半分）。同一窓に揃えていないので per-bucket 整合は崩れる。
		const fm = await getFlowMetrics('btc_jpy', 5, undefined, 30_000);
		assertOk(fm);

		const candleVols = candleVolumes(gc.data.normalized);
		const buckets = fm.data.series.buckets;

		// バケット数がローソク足数と一致しない（足幅に揃っていない）。
		expect(buckets.length).not.toBe(candleVols.length);

		// それでも総和（= Σ amount）は bucketMs に依らず candle volume 総和と一致する。
		const flowTotal = buckets.reduce((s: number, b: { totalVolume: number }) => s + b.totalVolume, 0);
		const candleTotal = candleVols.reduce((a: number, b: number) => a + b, 0);
		expect(flowTotal).toBeCloseTo(candleTotal, 8);
	});
});

// ── (2) price 高安整合: get_candles priceRange ↔ 指標 high/low ────────────────
describe('(2) price 高安整合: get_candles priceRange ↔ normalized 由来 high/low', () => {
	const BASE_TS = Date.UTC(2024, 0, 1);
	const DAY = 86_400_000;

	// 高値の最大・安値の最小をいずれも内側の足（先頭/末尾以外）に置き、
	// off-by-one / 端寄せのバグを検出できるようにする。
	const highs = [10100, 10200, 10500, 10300, 10250, 10150, 10180, 10120];
	const lows = [9900, 9800, 9700, 9600, 9500, 9400, 9750, 9850];
	const rows: OhlcvRow[] = highs.map((h, i) => {
		const l = lows[i];
		// open/close は [low, high] 内に収める。
		return [String(l + 20), String(h), String(l), String(h - 20), '1.0', String(BASE_TS + i * DAY)];
	});

	it('priceRange.high/low（summary 表示）が normalized 由来の max(high)/min(low) と一致する', async () => {
		mockJson({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } });

		const gc = await getCandles('btc_jpy', '1day', '2024', 8, 'UTC');
		assertOk(gc);

		// 同一 normalized から high/low を直接導出する（priceRange の単一ソース）。
		const expectedHigh = Math.max(...gc.data.normalized.map((c: { high: number }) => c.high));
		const expectedLow = Math.min(...gc.data.normalized.map((c: { low: number }) => c.low));

		// フィクスチャの内側に置いた極値であることを固定（idx2 高値 / idx5 安値）。
		expect(expectedHigh).toBe(10500);
		expect(expectedLow).toBe(9400);

		// priceRange は summary にのみ出る（formatSummary の 高値/安値 行）。
		// 同一 window 由来の high/low で一致することを固定する。
		expect(gc.summary).toContain(`高値: ${formatPrice(expectedHigh)}`);
		expect(gc.summary).toContain(`安値: ${formatPrice(expectedLow)}`);
	});
});

describe('(2) price 高安整合: get_candles priceRange ↔ analyze_indicators chart.stats（同一 window）', () => {
	const BASE_TS = Date.UTC(2024, 0, 1);
	const DAY = 86_400_000;
	const COUNT = 30;

	// 30 本。内側（idx12 / idx19）に一意な大域 max-high / min-low を置く。
	function build30Rows(): OhlcvRow[] {
		const rows: OhlcvRow[] = [];
		for (let i = 0; i < COUNT; i++) {
			const base = 10_000_000 + i * 1_000;
			let high = base + 2_000;
			let low = base - 2_000;
			if (i === 12) high = 10_500_000; // 大域最大の高値（内側）
			if (i === 19) low = 9_500_000; // 大域最小の安値（内側）
			const open = base;
			const close = base + 500;
			rows.push([String(open), String(high), String(low), String(close), '1.0', String(BASE_TS + i * DAY)]);
		}
		return rows;
	}

	beforeEach(() => {
		// analyze_indicators は pair:type でキャッシュするため、テスト毎にクリアする。
		clearIndicatorCache();
	});

	it('同一足集合に対し get_candles の high/low と analyze_indicators の chart.stats.max/min が一致する', async () => {
		// get_candles も analyze_indicators(→get_candles) も /candlestick のみを引くため、
		// 同一フィクスチャを返す単一モックで両経路が同一スナップショットを共有する。
		// （analyze_indicators は warmup で fetchCount 本要求し multi-year 取得しうるが、
		//   同一 timestamp の重複は dedupe され、末尾 30 本は両ツールで同一になる。）
		mockJson({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: build30Rows() }] } });

		// 同一 window（realtime, limit=30）で両ツールを呼ぶ。
		const gc = await getCandles('btc_jpy', '1day', undefined, COUNT);
		assertOk(gc);
		const ai = await analyzeIndicators('btc_jpy', '1day', COUNT);
		assertOk(ai);

		const gcHigh = Math.max(...gc.data.normalized.map((c: { high: number }) => c.high));
		const gcLow = Math.min(...gc.data.normalized.map((c: { low: number }) => c.low));
		expect(gcHigh).toBe(10_500_000);
		expect(gcLow).toBe(9_500_000);

		// 指標ツールの chart.stats（recent = normalized.slice(-limit) 由来の max/min）が一致する。
		const stats = ai.data.chart.stats as { max: number; min: number };
		expect(stats.max).toBe(gcHigh);
		expect(stats.min).toBe(gcLow);

		// get_candles 側 priceRange（summary）とも一致する。
		expect(gc.summary).toContain(`高値: ${formatPrice(gcHigh)}`);
		expect(gc.summary).toContain(`安値: ${formatPrice(gcLow)}`);
	});
});
