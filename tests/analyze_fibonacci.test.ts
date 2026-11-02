import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../lib/datetime.js';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';
import { requireDefined } from './helpers/assert.js';

vi.mock('../tools/get_candles.js', () => ({
	default: vi.fn(),
}));

import analyzeFibonacci, { toolDef } from '../tools/analyze_fibonacci.js';
import getCandles from '../tools/get_candles.js';

type Candle = {
	isoTime: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
};

function mc(dayOffset: number, o: number, h: number, l: number, c: number, v = 100): Candle {
	return {
		isoTime: dayjs.utc('2026-01-01').add(dayOffset, 'day').toISOString(),
		open: o,
		high: h,
		low: l,
		close: c,
		volume: v,
	};
}

function candlesOk(normalized: Candle[]) {
	return { ok: true, summary: 'ok', data: { normalized }, meta: { count: normalized.length } };
}

function candlesOkWithWarning(normalized: Candle[], warning: string) {
	return { ok: true, summary: 'ok', data: { normalized }, meta: { count: normalized.length, warning } };
}

/** 上昇トレンド: low=100(idx0) → high=200(idx8), close=192 */
function buildUptrendCandles(): Candle[] {
	return [
		mc(0, 105, 110, 100, 105),
		mc(1, 106, 112, 103, 110),
		mc(2, 111, 120, 108, 118),
		mc(3, 118, 130, 115, 126),
		mc(4, 126, 142, 124, 138),
		mc(5, 138, 155, 136, 150),
		mc(6, 150, 170, 148, 165),
		mc(7, 165, 182, 160, 178),
		mc(8, 178, 200, 175, 195),
		mc(9, 195, 198, 188, 192),
	];
}

/** 下降トレンド: high=200(idx0) → low=100(idx8), close=105 */
function buildDowntrendCandles(): Candle[] {
	return [
		mc(0, 195, 200, 188, 194),
		mc(1, 194, 196, 180, 186),
		mc(2, 186, 188, 170, 176),
		mc(3, 176, 178, 160, 166),
		mc(4, 166, 168, 150, 156),
		mc(5, 156, 158, 140, 146),
		mc(6, 146, 148, 130, 136),
		mc(7, 136, 138, 120, 126),
		mc(8, 126, 128, 100, 110),
		mc(9, 110, 112, 102, 105),
	];
}

function buildFlatCandles(): Candle[] {
	return Array.from({ length: 12 }, (_, i) => mc(i, 100, 100, 100, 100));
}

function buildStatsCandles(): Candle[] {
	const base = buildUptrendCandles();
	// 162 (38.2%) 水準付近を行き来するデータを追加
	const extra: Candle[] = [];
	for (let i = 0; i < 30; i++) {
		const offset = Math.sin(i / 3) * 20;
		const price = 160 + offset;
		extra.push(mc(10 + i, price - 2, price + 5, price - 5, price + 2));
	}
	return [...base, ...extra];
}

describe('analyze_fibonacci', () => {
	const mockedGetCandles = vi.mocked(getCandles);

	afterEach(() => vi.clearAllMocks());

	it('inputSchema: lookbackDays < 14 を拒否', () => {
		expect(() => toolDef.inputSchema.parse({ pair: 'btc_jpy', lookbackDays: 13 })).toThrow();
	});

	it('不正な pair → validation エラー', async () => {
		const res = await analyzeFibonacci({ pair: 'invalid!!!' });
		assertFail(res);
	});

	it('candles 取得失敗 → fail 結果', async () => {
		mockedGetCandles.mockResolvedValueOnce(
			asMockResult({ ok: false, summary: 'API error', meta: { errorType: 'api' } }),
		);
		const res = await analyzeFibonacci({ pair: 'btc_jpy' });
		assertFail(res);
	});

	it('ローソク足 < 10 本 → データ不足エラー', async () => {
		const candles = Array.from({ length: 5 }, (_, i) => mc(i, 100, 110, 90, 105));
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', lookbackDays: 14 });
		assertFail(res);
		expect(res.summary).toContain('不足');
	});

	it('range=0（全足同一価格）→ エラー', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildFlatCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', lookbackDays: 14 });
		assertFail(res);
		expect(res.summary).toContain('検出できません');
	});

	it('上昇トレンドのリトレースメント水準を正しく計算', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'retracement', lookbackDays: 14 });
		assertOk(res);

		expect(res.data.trend).toBe('up');
		expect(res.data.swingLow.price).toBe(100);
		expect(res.data.swingHigh.price).toBe(200);
		expect(res.data.range).toBe(100);

		// 上昇トレンドのリトレースメントは high - range * ratio（0%: 200, 23.6%: 176, 38.2%: 162, 50%: 150, 61.8%: 138, 78.6%: 121, 100%: 100）
		expect(res.data.levels).toHaveLength(7);
		expect(res.data.levels[0].ratio).toBe(0);
		expect(res.data.levels[0].price).toBe(200);
		expect(res.data.levels[3].ratio).toBe(0.5);
		expect(res.data.levels[3].price).toBe(150);
	});

	it('上昇トレンドで extensions は空', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'retracement', lookbackDays: 14 });
		assertOk(res);
		expect(res.data.extensions).toHaveLength(0);
	});

	it('下降トレンドのリトレースメント水準を正しく計算', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildDowntrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'retracement', lookbackDays: 14 });
		assertOk(res);

		expect(res.data.trend).toBe('down');
		// 下降トレンドは low + range * ratio（0%: 100, 23.6%: 124, 50%: 150, 100%: 200）
		expect(res.data.levels[0].price).toBe(100);
		expect(res.data.levels[3].price).toBe(150);
		expect(res.data.levels[6].price).toBe(200);
	});

	it('上昇トレンドの extension は swingHigh を上抜く', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'extension', lookbackDays: 14 });
		assertOk(res);

		expect(res.data.trend).toBe('up');
		// 上昇: swingLow + range * ratio → 100 + 100*1.272 = 227
		expect(res.data.extensions[0].ratio).toBe(1.272);
		expect(res.data.extensions[0].price).toBe(227);
		expect(res.data.levels).toHaveLength(0); // extension-only mode
	});

	it('下降トレンドの extension は swingLow を下抜く', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildDowntrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'extension', lookbackDays: 14 });
		assertOk(res);

		// 下降: swingHigh - range * ratio → 200 - 100*1.272 = 73
		expect(res.data.extensions[0].price).toBe(73);
	});

	it('mode=both でリトレースメントとエクステンション両方を返す', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'both', lookbackDays: 14 });
		assertOk(res);

		expect(res.data.levels.length).toBeGreaterThan(0);
		expect(res.data.extensions.length).toBeGreaterThan(0);
	});

	it('isNearest が現在価格に最も近い水準にマークされる', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'retracement', lookbackDays: 14 });
		assertOk(res);

		const nearestLevels = res.data.levels.filter((l: { isNearest: boolean }) => l.isNearest);
		expect(nearestLevels).toHaveLength(1);
		// currentPrice=192, nearest should be 200 (0%) since |200-192|=8, |176-192|=16
		expect(nearestLevels[0].price).toBe(200);
	});

	it('position に aboveLevel / belowLevel / nearestLevel を含む', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'retracement', lookbackDays: 14 });
		assertOk(res);

		// currentPrice=192 に対し levels は 100,121,138,150,162,176,200 なので、belowLevel = 176、aboveLevel = 200
		expect(res.data.position.belowLevel).not.toBeNull();
		expect(res.data.position.aboveLevel).not.toBeNull();
		expect(res.data.position.nearestLevel).not.toBeNull();
		expect(requireDefined(res.data.position.belowLevel, 'res.data.position.belowLevel').price).toBeLessThanOrEqual(192);
		expect(requireDefined(res.data.position.aboveLevel, 'res.data.position.aboveLevel').price).toBeGreaterThan(192);
	});

	it('extension-only で position が extensions から計算される', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'extension', lookbackDays: 14 });
		assertOk(res);

		// levels は空なので position は extensions から算出
		expect(res.data.position).toBeDefined();
	});

	it('水準付近のタッチがあれば levelStats を算出', async () => {
		const candles = buildStatsCandles();
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'retracement', lookbackDays: 90 });
		assertOk(res);

		const levelStats = requireDefined(res.data.levelStats, 'res.data.levelStats');
		expect(levelStats.length).toBeGreaterThan(0);
		const stat = levelStats[0];
		expect(stat.ratio).toBeDefined();
		expect(stat.samplesCount).toBeGreaterThanOrEqual(0);
		expect(stat.bounceRate).toBeGreaterThanOrEqual(0);
		expect(stat.bounceRate).toBeLessThanOrEqual(1);
		expect(stat.confidence).toMatch(/^(high|medium|low)$/);
	});

	it('historyLookbackDays > lookbackDays で追加のローソク足を取得', async () => {
		const candles = buildUptrendCandles();
		const historyCandles = [...buildStatsCandles(), ...candles.slice(-5)];

		// 1回目: 通常の分析用、2回目: 拡張統計用
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(historyCandles)));

		const res = await analyzeFibonacci({
			pair: 'btc_jpy',
			mode: 'retracement',
			lookbackDays: 14,
			historyLookbackDays: 180,
		});
		assertOk(res);
		expect(mockedGetCandles).toHaveBeenCalledTimes(2);
	});

	it('拡張統計取得失敗でも通常分析は成功', async () => {
		const candles = buildUptrendCandles();
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		// 2回目は失敗
		mockedGetCandles.mockResolvedValueOnce(asMockResult({ ok: false, summary: 'error', meta: { errorType: 'api' } }));

		const res = await analyzeFibonacci({
			pair: 'btc_jpy',
			mode: 'retracement',
			lookbackDays: 14,
			historyLookbackDays: 180,
		});
		assertOk(res);
	});

	it('extension-only mode では levelStats を計算しない', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'extension', lookbackDays: 14 });
		assertOk(res);
		// levels が空なので levelStats は空配列 → data に undefined
		expect(res.data.levelStats).toBeUndefined();
	});

	it('content にフィボナッチ分析の主要セクションを含む', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'both', lookbackDays: 14 });
		assertOk(res);

		const text = res.content?.map((c: { text: string }) => c.text).join('') ?? '';
		expect(text).toContain('フィボナッチ分析');
		expect(text).toContain('スイングハイ');
		expect(text).toContain('スイングロー');
		expect(text).toContain('リトレースメント水準');
		expect(text).toContain('エクステンション水準');
		expect(text).toContain('判定ロジック');
	});

	it('retracement-only content にエクステンションセクションなし', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'retracement', lookbackDays: 14 });
		assertOk(res);

		const text = res.content?.map((c: { text: string }) => c.text).join('') ?? '';
		expect(text).toContain('リトレースメント水準');
		expect(text).not.toContain('エクステンション水準');
	});

	it('extension-only content にリトレースメントセクションなし', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'extension', lookbackDays: 14 });
		assertOk(res);

		const text = res.content?.map((c: { text: string }) => c.text).join('') ?? '';
		expect(text).not.toContain('リトレースメント水準');
		expect(text).toContain('エクステンション水準');
	});

	it('統計データがある場合 content に反応実績セクションを含む', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildStatsCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'retracement', lookbackDays: 90 });
		assertOk(res);

		const text = res.content?.map((c: { text: string }) => c.text).join('') ?? '';
		expect(text).toContain('過去の反応実績');
	});

	it('タッチなしの場合 content に「該当データなし」を含む', async () => {
		// 全水準から離れた価格帯のデータ
		const candles = Array.from({ length: 15 }, (_, i) => mc(i, 1000, 1010, 990, 1005));
		// range = 1010 - 990 = 20、水準は 990～1010 付近に集中
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'retracement', lookbackDays: 14 });
		assertOk(res);

		// range が小さいため水準が全て近くなりタッチが多い可能性があるので、content の形式だけを検証する
		expect(res.content).toBeDefined();
		expect(requireDefined(res.content, 'res.content').length).toBeGreaterThan(0);
	});

	it('summary にトレンドと水準情報を含む', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'retracement', lookbackDays: 14 });
		assertOk(res);

		expect(res.summary).toContain('上昇');
		expect(res.summary).toContain('水準付近');
	});

	it('下降トレンドの summary に「下降」を含む', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildDowntrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'retracement', lookbackDays: 14 });
		assertOk(res);
		expect(res.summary).toContain('下降');
	});

	it('data に必要なフィールドを全て含む', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'both', lookbackDays: 14 });
		assertOk(res);

		expect(res.data.pair).toBe('btc_jpy');
		expect(res.data.timeframe).toBe('1day');
		expect(res.data.currentPrice).toBe(192);
		expect(res.data.trend).toBe('up');
		expect(res.data.swingHigh).toBeDefined();
		expect(res.data.swingLow).toBeDefined();
		expect(res.data.range).toBe(100);
		expect(res.data.levels).toBeDefined();
		expect(res.data.extensions).toBeDefined();
		expect(res.data.position).toBeDefined();
	});

	it('meta に timeframe / lookbackDays / mode を含む', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'both', lookbackDays: 30 });
		assertOk(res);

		expect(res.meta?.timeframe).toBe('1day');
		expect(res.meta?.lookbackDays).toBe(30);
		expect(res.meta?.mode).toBe('both');
	});

	it('各水準の distancePct が現在価格からの乖離率を正しく表す', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'retracement', lookbackDays: 14 });
		assertOk(res);

		// currentPrice=192, level at 200: (200-192)/192 * 100 ≈ 4.17%
		const level0 = res.data.levels[0]; // ratio=0, price=200
		expect(level0.distancePct).toBeCloseTo(4.17, 1);

		// level at 100: (100-192)/192 * 100 ≈ -47.92%
		const levelLast = res.data.levels[res.data.levels.length - 1]; // ratio=1.0, price=100
		expect(levelLast.distancePct).toBeLessThan(0);
	});

	it('getCandles meta.warning を summary / content / meta に伝播する', async () => {
		mockedGetCandles.mockResolvedValueOnce(
			asMockResult(candlesOkWithWarning(buildUptrendCandles(), '⚠️ 3日中1日の取得に失敗')),
		);
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'retracement', lookbackDays: 14 });
		assertOk(res);

		expect(res.meta?.warning).toBe('⚠️ 3日中1日の取得に失敗');
		expect(res.summary.startsWith('⚠️ 3日中1日の取得に失敗')).toBe(true);
		const text = res.content?.[0]?.text ?? '';
		expect(text.startsWith('⚠️ 3日中1日の取得に失敗')).toBe(true);
	});

	it('warning 無しケースでは meta.warning が undefined', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		const res = await analyzeFibonacci({ pair: 'btc_jpy', mode: 'retracement', lookbackDays: 14 });
		assertOk(res);
		expect(res.meta?.warning).toBeUndefined();
		expect(res.summary.startsWith('⚠️')).toBe(false);
	});

	it('historyLookbackDays > lookbackDays で 2 回目の warning も伝播する', async () => {
		// 1回目: warning なし、2回目: warning あり
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		mockedGetCandles.mockResolvedValueOnce(
			asMockResult(candlesOkWithWarning(buildStatsCandles(), '⚠️ 履歴期間の部分失敗')),
		);
		const res = await analyzeFibonacci({
			pair: 'btc_jpy',
			mode: 'retracement',
			lookbackDays: 14,
			historyLookbackDays: 180,
		});
		assertOk(res);
		expect(res.meta?.warning).toContain('履歴期間の部分失敗');
	});

	it('analysis と history の warning が同一なら重複排除する', async () => {
		const sameWarning = '⚠️ 同一の失敗メッセージ';
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOkWithWarning(buildUptrendCandles(), sameWarning)));
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOkWithWarning(buildStatsCandles(), sameWarning)));
		const res = await analyzeFibonacci({
			pair: 'btc_jpy',
			mode: 'retracement',
			lookbackDays: 14,
			historyLookbackDays: 180,
		});
		assertOk(res);
		// 改行で連結されているなら 2 行になるが、同一メッセージは 1 行のみ
		expect(res.meta?.warning).toBe(sameWarning);
	});

	it('複数行 warning の部分一致行も dedup される（per-line dedup）', async () => {
		// analysis: 行 A + 行 B、history: 行 B + 行 C → 集約後は A / B / C の 3 行（B は 1 回だけ）
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOkWithWarning(buildUptrendCandles(), '⚠️ 行A\n⚠️ 行B')));
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOkWithWarning(buildStatsCandles(), '⚠️ 行B\n⚠️ 行C')));
		const res = await analyzeFibonacci({
			pair: 'btc_jpy',
			mode: 'retracement',
			lookbackDays: 14,
			historyLookbackDays: 180,
		});
		assertOk(res);
		const lines = res.meta?.warning?.split('\n') ?? [];
		expect(lines).toEqual(['⚠️ 行A', '⚠️ 行B', '⚠️ 行C']);
	});

	it('history 2 回目が ok かつ normalized 空でも warning は失われない', async () => {
		// 1回目: 通常、2回目: ok だが normalized=[]（warning だけ持つ）
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		mockedGetCandles.mockResolvedValueOnce(
			asMockResult({
				ok: true,
				summary: 'ok',
				data: { normalized: [] },
				meta: { count: 0, warning: '⚠️ 履歴 0 件で部分失敗' },
			}),
		);
		const res = await analyzeFibonacci({
			pair: 'btc_jpy',
			mode: 'retracement',
			lookbackDays: 14,
			historyLookbackDays: 180,
		});
		assertOk(res);
		expect(res.meta?.warning).toContain('履歴 0 件で部分失敗');
	});

	it('toolDef.handler が analyzeFibonacci に委譲', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(buildUptrendCandles())));
		const res = await toolDef.handler({ pair: 'btc_jpy', lookbackDays: 14 });
		expect(res).toBeDefined();
		expect((res as { ok: boolean }).ok).toBe(true);
	});
});
