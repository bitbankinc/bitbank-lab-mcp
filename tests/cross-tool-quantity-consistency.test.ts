import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatPrice } from '../lib/formatter.js';
import analyzeIndicators, { clearIndicatorCache } from '../tools/analyze_indicators.js';
import getCandles from '../tools/get_candles.js';
import getFlowMetrics from '../tools/get_flow_metrics.js';
import { asMockResult, assertOk } from './_assertResult.js';

type OhlcvRow = [string, string, string, string, string, string];
type TxRow = { transaction_id: number; price: string; amount: string; side: 'buy' | 'sell'; executed_at: number };

/** CandleSchema 上 volume は optional なので、欠損を 0 に畳まず明示的に失敗させる（畳むと数量整合の主張が黙って緩む）。 */
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

/** get_candles は /candlestick、get_flow_metrics(→get_transactions) は /transactions を引くので、URL で出し分ける。 */
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

// Σ totalVolume ≈ candle volume が成り立つのは、bucketMs を足幅に揃え、約定をローソク足と同一の時間窓に限定し、取得上限内（約定が間引かれていない）のときだけ。本テストは最後の条件を固定フィクスチャで再現する。
// get_flow_metrics は volume を Number(x.toFixed(8)) で量子化し浮動小数の加算誤差も乗るので、厳密等値ではなく toBeCloseTo(_, 8) で見る。
describe('(1) volume 整合: get_candles(OHLCV[4]) ↔ get_flow_metrics(Σ amount)', () => {
	const BAR0 = Date.UTC(2024, 0, 15, 10, 0, 0);
	const MIN = 60_000;

	// 各足の volume は「その足に属する約定 amount の合計」に一致させる（bar0: 0.1 + 0.2 = 0.3 / bar1: 0.125 + 0.375 = 0.5 / bar2: 0.25）。
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

		for (let i = 0; i < candleVols.length; i++) {
			expect(buckets[i].totalVolume).toBeCloseTo(candleVols[i], 8);
		}

		const flowTotal = buckets.reduce((s: number, b: { totalVolume: number }) => s + b.totalVolume, 0);
		const candleTotal = candleVols.reduce((a: number, b: number) => a + b, 0);
		expect(flowTotal).toBeCloseTo(candleTotal, 8);
		expect(candleTotal).toBeCloseTo(expectedTotal, 8);

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

		expect(buckets.length).not.toBe(candleVols.length);

		// それでも総和（= Σ amount）は bucketMs に依らず candle volume 総和と一致する。
		const flowTotal = buckets.reduce((s: number, b: { totalVolume: number }) => s + b.totalVolume, 0);
		const candleTotal = candleVols.reduce((a: number, b: number) => a + b, 0);
		expect(flowTotal).toBeCloseTo(candleTotal, 8);
	});
});

describe('(2) price 高安整合: get_candles priceRange ↔ normalized 由来 high/low', () => {
	const BASE_TS = Date.UTC(2024, 0, 1);
	const DAY = 86_400_000;

	// 高値の最大・安値の最小をいずれも内側の足（先頭/末尾以外）に置き、off-by-one / 端寄せのバグを検出できるようにする。
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
		// get_candles も analyze_indicators も /candlestick のみを引くので、同一フィクスチャの単一モックで両経路が同一スナップショットを共有する（multi-year 取得しても同一 timestamp は dedupe され、末尾 30 本は同一になる）。
		mockJson({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: build30Rows() }] } });

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

		expect(gc.summary).toContain(`高値: ${formatPrice(gcHigh)}`);
		expect(gc.summary).toContain(`安値: ${formatPrice(gcLow)}`);
	});
});
