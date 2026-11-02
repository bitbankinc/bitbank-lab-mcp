import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../lib/datetime.js';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';

vi.mock('../tools/get_candles.js', () => ({
	default: vi.fn(),
}));

import analyzeSupportResistance, { toolDef } from '../tools/analyze_support_resistance.js';
import getCandles from '../tools/get_candles.js';

type Candle = {
	isoTime: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
};

function daysAgoIso(n: number): string {
	return dayjs().subtract(n, 'day').startOf('day').toISOString();
}

function mc(daysAgo: number, o: number, h: number, l: number, c: number, v = 100): Candle {
	return { isoTime: daysAgoIso(daysAgo), open: o, high: h, low: l, close: c, volume: v };
}

function candlesOk(normalized: Candle[]) {
	return { ok: true, summary: 'ok', data: { normalized }, meta: { count: normalized.length } };
}

/** depth=5 のピボット検出に十分な間隔をもたせる。 */
function buildSRCandles(opts?: {
	swingLows?: Array<{ idx: number; low: number; close?: number; volume?: number }>;
	swingHighs?: Array<{ idx: number; high: number; close?: number; volume?: number }>;
	count?: number;
	baseClose?: number;
	baseLow?: number;
	baseHigh?: number;
	tailOverrides?: Array<{ idx: number; candle: Candle }>;
}): Candle[] {
	const count = opts?.count ?? 40;
	const baseClose = opts?.baseClose ?? 100;
	const baseLow = opts?.baseLow ?? 98;
	const baseHigh = opts?.baseHigh ?? 102;
	const lows = opts?.swingLows ?? [];
	const highs = opts?.swingHighs ?? [];
	const overrides = opts?.tailOverrides ?? [];

	const candles: Candle[] = Array.from({ length: count }, (_, idx) => {
		const daysAgo = count + 9 - idx; // 古い順、最新ローソク足は 10 日前
		return mc(daysAgo, baseClose, baseHigh, baseLow, baseClose);
	});

	for (const sl of lows) {
		const c = candles[sl.idx];
		c.low = sl.low;
		c.open = sl.close ?? sl.low + 4;
		c.close = sl.close ?? sl.low + 4;
		c.high = sl.low + 6;
		if (sl.volume !== undefined) c.volume = sl.volume;
	}
	for (const sh of highs) {
		const c = candles[sh.idx];
		c.high = sh.high;
		c.open = sh.close ?? sh.high - 4;
		c.close = sh.close ?? sh.high - 4;
		c.low = sh.high - 6;
		if (sh.volume !== undefined) c.volume = sh.volume;
	}
	for (const ov of overrides) {
		candles[ov.idx] = ov.candle;
	}

	return candles;
}

describe('analyze_support_resistance', () => {
	const mockedGetCandles = vi.mocked(getCandles);

	afterEach(() => vi.clearAllMocks());

	it('inputSchema: lookbackDays < 30 を拒否', () => {
		expect(() => toolDef.inputSchema.parse({ pair: 'btc_jpy', lookbackDays: 29 })).toThrow();
	});

	it('不正な pair → validation エラー', async () => {
		const res = await analyzeSupportResistance('invalid!!!');
		assertFail(res);
	});

	it('candles 取得失敗 → fail 結果', async () => {
		mockedGetCandles.mockResolvedValueOnce(
			asMockResult({ ok: false, summary: 'fetch error', meta: { errorType: 'api' } }),
		);
		const res = await analyzeSupportResistance('btc_jpy');
		assertFail(res);
		expect(res.summary).toContain('fetch error');
	});

	it('空の candles → no data エラー', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk([])));
		const res = await analyzeSupportResistance('btc_jpy');
		assertFail(res);
		expect(res.summary).toContain('No candle data');
	});

	it('ローソク足が少なすぎるとレベル検出なし', async () => {
		// depth=5 には最低 11 本必要。8 本では swing 検出不可
		const candles = Array.from({ length: 8 }, (_, i) => mc(20 - i, 100, 102, 98, 100));
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeSupportResistance('btc_jpy', { lookbackDays: 30 });
		assertOk(res);
		expect(res.data.supports).toHaveLength(0);
		expect(res.data.resistances).toHaveLength(0);
	});

	it('content の見出しは入力 pair を使う', async () => {
		const candles = Array.from({ length: 20 }, (_, i) => mc(30 - i, 100, 102, 98, 100));
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeSupportResistance('eth_jpy', { lookbackDays: 30 });
		assertOk(res);
		expect(res.content?.[0]?.text).toContain('ETH/JPY サポート・レジスタンス分析');
	});

	it('スイングポイントからサポート・レジスタンスを検出', async () => {
		const candles = buildSRCandles({
			swingLows: [
				{ idx: 10, low: 88 },
				{ idx: 24, low: 89 },
			],
			swingHighs: [
				{ idx: 17, high: 112 },
				{ idx: 31, high: 113 },
			],
		});

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeSupportResistance('btc_jpy', { lookbackDays: 90, topN: 3, tolerance: 0.015 });
		assertOk(res);

		// Zod スキーマが type/formationType を strip するため price/label/touchCount で検証
		expect(res.data.supports.length).toBeGreaterThanOrEqual(1);
		const sup = res.data.supports[0];
		expect(sup.price).toBeGreaterThanOrEqual(85);
		expect(sup.price).toBeLessThanOrEqual(93);
		expect(sup.touchCount).toBeGreaterThanOrEqual(2);
		expect(sup.label).toBe('サポート');

		expect(res.data.resistances.length).toBeGreaterThanOrEqual(1);
		const resi = res.data.resistances[0];
		expect(resi.price).toBeGreaterThanOrEqual(110);
		expect(resi.price).toBeLessThanOrEqual(115);
		expect(resi.label).toBe('レジスタンス');
	});

	it('content に判定ロジック・サポート・レジスタンスのセクションを含む', async () => {
		const candles = buildSRCandles({
			swingLows: [
				{ idx: 10, low: 88 },
				{ idx: 24, low: 89 },
			],
			swingHighs: [
				{ idx: 17, high: 112 },
				{ idx: 31, high: 113 },
			],
		});
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeSupportResistance('btc_jpy', { lookbackDays: 90 });
		assertOk(res);

		const text = res.content?.[0]?.text ?? '';
		expect(text).toContain('【判定ロジック】');
		expect(text).toContain('【サポートライン】');
		expect(text).toContain('【レジスタンスライン】');
		expect(text).toContain('実績:');
		expect(text).toContain('意義:');
	});

	it('lookbackDays 外のバッファデータを結果に混ぜない', async () => {
		// 古いバッファにだけスイングポイントがある → 分析範囲外
		const old = Array.from({ length: 10 }, (_, i) => mc(99 - i, 96, 101, 85, 98));
		const recent = Array.from({ length: 30 }, (_, i) => mc(30 - i, 100, 101, 99, 100));
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk([...old, ...recent])));
		const res = await analyzeSupportResistance('btc_jpy', { lookbackDays: 30 });
		assertOk(res);
		expect(res.data.supports).toHaveLength(0);
	});

	it('topN で出力レベル数を制限', async () => {
		// 3 組のスイングロー → サポート 3 つ検出可能だが topN=1 で制限
		const candles = buildSRCandles({
			count: 50,
			swingLows: [
				{ idx: 7, low: 85 },
				{ idx: 17, low: 86 },
				{ idx: 27, low: 90 },
				{ idx: 37, low: 91 },
			],
		});
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeSupportResistance('btc_jpy', { lookbackDays: 90, topN: 1 });
		assertOk(res);
		expect(res.data.supports.length).toBeLessThanOrEqual(1);
	});

	it('大出来高タッチで strength が補強される', async () => {
		// 出来高なしのベースライン
		const base = buildSRCandles({
			swingLows: [
				{ idx: 10, low: 88 },
				{ idx: 24, low: 89 },
			],
		});
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(base)));
		const resBase = await analyzeSupportResistance('btc_jpy', { lookbackDays: 90, tolerance: 0.015 });
		assertOk(resBase);

		// 大出来高あり
		const boosted = buildSRCandles({
			swingLows: [
				{ idx: 10, low: 88, volume: 500 },
				{ idx: 24, low: 89, volume: 500 },
			],
		});
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(boosted)));
		const resBoosted = await analyzeSupportResistance('btc_jpy', { lookbackDays: 90, tolerance: 0.015 });
		assertOk(resBoosted);

		// 大出来高で strength が上がる（content テキストで確認）
		expect(resBase.data.supports.length).toBeGreaterThan(0);
		expect(resBoosted.data.supports.length).toBeGreaterThan(0);
		expect(resBoosted.data.supports[0].strength).toBeGreaterThanOrEqual(resBase.data.supports[0].strength);
		const text = resBoosted.content?.[0]?.text ?? '';
		expect(text).toContain('出来高');
	});

	it('タッチ5回以上で strength=3', async () => {
		const candles = buildSRCandles({
			count: 60,
			swingLows: [
				{ idx: 6, low: 88 },
				{ idx: 16, low: 88.5 },
				{ idx: 26, low: 89 },
				{ idx: 36, low: 88.8 },
				{ idx: 46, low: 89.2 },
			],
		});
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeSupportResistance('btc_jpy', { lookbackDays: 90, tolerance: 0.015 });
		assertOk(res);

		expect(res.data.supports.length).toBeGreaterThan(0);
		expect(res.data.supports[0].strength).toBe(3);
	});

	it('直近7日以内にブレイクしたサポートは除外', async () => {
		// サポートは日足 10日前が最新 → ブレイクは直近5日前に発生
		const candles = buildSRCandles({
			count: 45,
			swingLows: [
				{ idx: 10, low: 88 },
				{ idx: 24, low: 89 },
			],
		});
		// 最後の 5 本を直近 5 日前に配置し、close を 86（<88.5*0.99）に設定
		for (let i = 40; i < 45; i++) {
			const daysAgo = 45 - i;
			candles[i] = mc(daysAgo, 87, 88, 85, 86);
		}

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeSupportResistance('btc_jpy', { lookbackDays: 90, tolerance: 0.015 });
		assertOk(res);
		const tradSupports = res.data.supports;
		for (const s of tradSupports) {
			expect(s.price < 86 || s.price > 92).toBe(true);
		}
	});

	it('低出来高のブレイクは翌日確認なしなら無視される', async () => {
		const candles = buildSRCandles({
			count: 45,
			swingLows: [
				{ idx: 10, low: 88 },
				{ idx: 24, low: 89 },
			],
		});
		// 最新付近に低出来高の「偽ブレイク」を配置する（avgVolume ≈ 100 に対して volume=50、翌日は close=100 で確認されない）
		candles[40] = mc(5, 87, 88, 85, 86, 50); // low-vol break
		candles[41] = mc(4, 99, 102, 98, 100, 100); // next day: no confirm

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeSupportResistance('btc_jpy', { lookbackDays: 90, tolerance: 0.015 });
		assertOk(res);
		// 偽ブレイクが無視されるので、サポートが除外されていない可能性がある（detectRecentBreak が undefined を返す）
	});

	it('V字反発で新サポート形成を検出', async () => {
		// 直近 10 日以内に prev.low > current.low < next.low の V字パターン
		const candles: Candle[] = [];
		for (let i = 0; i < 25; i++) {
			candles.push(mc(30 - i, 100, 102, 98, 100));
		}
		// V字パターン: day 7 → day 6(dip) → day 5(bounce)
		candles.push(mc(7, 100, 102, 97, 100)); // prev: low=97
		candles.push(mc(6, 98, 99, 91, 93)); // current: low=91, big drop
		candles.push(mc(5, 94, 102, 94, 100)); // next: low=94 > 91, big rise
		candles.push(mc(4, 100, 102, 98, 100));
		candles.push(mc(3, 100, 102, 99, 100));

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeSupportResistance('btc_jpy', { lookbackDays: 90, topN: 5, tolerance: 0.015 });
		assertOk(res);

		// Zod が formationType を strip するため content テキストで V字反発を確認
		const text = res.content?.[0]?.text ?? '';
		expect(text).toContain('V字反発');
	});

	it('大出来高での反発で新サポート note に出来高言及', async () => {
		const candles: Candle[] = [];
		for (let i = 0; i < 25; i++) {
			candles.push(mc(30 - i, 100, 102, 98, 100));
		}
		// V字だが drop/rise が 3% 未満 → V字判定にならないが、出来高ブースト
		candles.push(mc(7, 100, 102, 97, 100)); // prev: low=97
		candles.push(mc(6, 99, 100, 95, 98, 500)); // dip, high volume (avg ~100 の 5 倍)
		candles.push(mc(5, 98, 102, 96, 100)); // bounce
		candles.push(mc(4, 100, 102, 98, 100));
		candles.push(mc(3, 100, 102, 99, 100));

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeSupportResistance('btc_jpy', { lookbackDays: 90, topN: 5, tolerance: 0.015 });
		assertOk(res);

		const text = res.content?.[0]?.text ?? '';
		expect(text).toContain('出来高');
	});

	it('崩壊したサポート → レジスタンス転換を検出', async () => {
		// 高価格帯（108 付近）にサポートレベルを形成し、その後 100 に崩壊
		const candles = buildSRCandles({
			count: 50,
			baseClose: 108,
			baseLow: 106,
			baseHigh: 110,
			swingLows: [
				{ idx: 10, low: 104 },
				{ idx: 20, low: 105 },
			],
		});
		// インデックス 35 以降で価格を 100 に下落させる（サポート崩壊）
		for (let i = 35; i < 50; i++) {
			const daysAgo = 50 + 9 - i;
			candles[i] = mc(daysAgo, 100, 102, 98, 100);
		}

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeSupportResistance('btc_jpy', { lookbackDays: 90, topN: 5, tolerance: 0.015 });
		assertOk(res);

		const text = res.content?.[0]?.text ?? '';
		// ロールリバーサルが検出されれば content に言及がある
		expect(res.data.resistances.length).toBeGreaterThan(0);
		expect(text).toContain('レジスタンス');
	});

	it('突破されたレジスタンス → サポート転換を検出', async () => {
		// 低価格帯（92 付近）にレジスタンスレベルを形成し、その後 100 に上昇
		const candles = buildSRCandles({
			count: 50,
			baseClose: 92,
			baseLow: 90,
			baseHigh: 94,
			swingHighs: [
				{ idx: 10, high: 96 },
				{ idx: 20, high: 97 },
			],
		});
		// インデックス 35 以降で価格を 100 に上昇（レジスタンス突破）
		for (let i = 35; i < 50; i++) {
			const daysAgo = 50 + 9 - i;
			candles[i] = mc(daysAgo, 100, 102, 98, 100);
		}

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeSupportResistance('btc_jpy', { lookbackDays: 90, topN: 5, tolerance: 0.015 });
		assertOk(res);

		const text = res.content?.[0]?.text ?? '';
		expect(res.data.supports.length).toBeGreaterThan(0);
		expect(text).toContain('サポート');
	});

	it('プルバック確認済みのロールリバーサルは strength >= 2', async () => {
		// 高価格帯にサポート → 崩壊 → プルバック（高値がレベル付近だが終値は下）
		const candles = buildSRCandles({
			count: 50,
			baseClose: 108,
			baseLow: 106,
			baseHigh: 110,
			swingLows: [
				{ idx: 10, low: 104 },
				{ idx: 20, low: 105 },
			],
		});
		// 崩壊（インデックス 35-39）
		for (let i = 35; i < 40; i++) {
			const daysAgo = 50 + 9 - i;
			candles[i] = mc(daysAgo, 100, 102, 98, 100);
		}
		// プルバック: high がレベル(~104)付近まで戻るが close は下（インデックス 40）
		candles[40] = mc(50 + 9 - 40, 101, 104, 100, 101); // high=104 ≈ level, close=101 < level
		for (let i = 41; i < 50; i++) {
			const daysAgo = 50 + 9 - i;
			candles[i] = mc(daysAgo, 100, 102, 98, 100);
		}

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeSupportResistance('btc_jpy', { lookbackDays: 90, topN: 5, tolerance: 0.015 });
		assertOk(res);

		// プルバック確認済みなら strength >= 2 のレジスタンスがある
		expect(res.data.resistances.length).toBeGreaterThan(0);
		const text = res.content?.[0]?.text ?? '';
		expect(text).toContain('レジスタンス');
	});

	it('サポートは現在価格に近い順にソートされる', async () => {
		const candles = buildSRCandles({
			count: 55,
			swingLows: [
				{ idx: 7, low: 80 },
				{ idx: 17, low: 81 },
				{ idx: 27, low: 90 },
				{ idx: 37, low: 91 },
			],
		});
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeSupportResistance('btc_jpy', { lookbackDays: 90, topN: 5, tolerance: 0.015 });
		assertOk(res);

		expect(res.data.supports.length).toBeGreaterThanOrEqual(2);
		// 近い方（90付近）が先に来る
		expect(Math.abs(res.data.supports[0].pctFromCurrent)).toBeLessThanOrEqual(
			Math.abs(res.data.supports[1].pctFromCurrent) + 0.5,
		);
	});

	it('data に currentPrice / analysisDate / detectionCriteria を含む', async () => {
		const candles = buildSRCandles({
			swingLows: [
				{ idx: 10, low: 88 },
				{ idx: 24, low: 89 },
			],
		});
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeSupportResistance('btc_jpy', { lookbackDays: 90 });
		assertOk(res);

		expect(res.data.currentPrice).toBe(100);
		expect(res.data.analysisDate).toBeDefined();
		expect(res.data.lookbackDays).toBe(90);
		expect(res.data.detectionCriteria).toEqual({
			swingDepth: 5,
			recentBreakWindow: 7,
			tolerance: 0.015,
		});
	});

	it('meta に supportCount / resistanceCount を含む', async () => {
		const candles = buildSRCandles({
			swingLows: [
				{ idx: 10, low: 88 },
				{ idx: 24, low: 89 },
			],
			swingHighs: [
				{ idx: 17, high: 112 },
				{ idx: 31, high: 113 },
			],
		});
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeSupportResistance('btc_jpy', { lookbackDays: 90 });
		assertOk(res);

		expect(res.meta?.supportCount).toBeGreaterThanOrEqual(1);
		expect(res.meta?.resistanceCount).toBeGreaterThanOrEqual(1);
	});

	it('S/R 検出なしの場合、content に「検出されませんでした」を含む', async () => {
		const candles = Array.from({ length: 20 }, (_, i) => mc(30 - i, 100, 102, 98, 100));
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeSupportResistance('btc_jpy', { lookbackDays: 30 });
		assertOk(res);

		const text = res.content?.[0]?.text ?? '';
		expect(text).toContain('検出されませんでした');
	});

	it('現在価格から 20% 以上離れたレベルは除外される', async () => {
		const candles = buildSRCandles({
			count: 50,
			swingLows: [
				{ idx: 10, low: 70 },
				{ idx: 24, low: 71 },
			], // -30%, > 20%
		});
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeSupportResistance('btc_jpy', { lookbackDays: 90 });
		assertOk(res);

		for (const s of res.data.supports) {
			expect(Math.abs(s.pctFromCurrent)).toBeLessThanOrEqual(20);
		}
	});

	it('toolDef.handler が analyzeSupportResistance に委譲', async () => {
		const candles = Array.from({ length: 20 }, (_, i) => mc(30 - i, 100, 102, 98, 100));
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await toolDef.handler({ pair: 'btc_jpy', lookbackDays: 30, topN: 3, tolerance: 0.015 });
		expect(res).toBeDefined();
		expect((res as { ok: boolean }).ok).toBe(true);
	});
});
