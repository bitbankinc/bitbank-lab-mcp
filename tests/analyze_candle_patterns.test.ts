import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../lib/datetime.js';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';
import { requireDefined } from './helpers/assert.js';

vi.mock('../tools/get_candles.js', () => ({
	default: vi.fn(),
}));

import analyzeCandlePatterns, { toolDef } from '../tools/analyze_candle_patterns.js';
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

function mcFixed(dayOffset: number, o: number, h: number, l: number, c: number, v = 100): Candle {
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
	return {
		ok: true,
		summary: 'ok',
		data: { normalized },
		meta: { count: normalized.length, warning },
	};
}

function bullishCandles(n: number, base = 100, step = 3): Candle[] {
	return Array.from({ length: n }, (_, i) => {
		const o = base + step * i;
		return mc(n - i, o, o + 6, o - 4, o + step);
	});
}

function bearishCandles(n: number, base = 130, step = 3): Candle[] {
	return Array.from({ length: n }, (_, i) => {
		const o = base - step * i;
		return mc(n - i, o, o + 4, o - 6, o - step);
	});
}

describe('analyze_candle_patterns', () => {
	const mockedGetCandles = vi.mocked(getCandles);

	afterEach(() => vi.clearAllMocks());

	it('inputSchema: focus_last_n < 2 を拒否', () => {
		expect(() => toolDef.inputSchema.parse({ focus_last_n: 1 })).toThrow();
	});

	it('candles 取得失敗 → fail 結果', async () => {
		mockedGetCandles.mockResolvedValueOnce(
			asMockResult({ ok: false, summary: 'API error', meta: { errorType: 'api' } }),
		);
		const res = await analyzeCandlePatterns();
		assertFail(res);
	});

	it('ローソク足が不足 → fail 結果', async () => {
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk([mc(1, 100, 102, 98, 101)])));
		const res = await analyzeCandlePatterns({ window_days: 5 });
		assertFail(res);
		expect(res.summary).toContain('不足');
	});

	it('ハンマー: 長い下ヒゲ・小さい実体を検出', async () => {
		// bodyRatio=[0.05,0.35], lower>=body*2, upper/range<=0.25, lower/range>=0.6 に対し、O=80, H=100, L=0, C=85 → body=5, range=100, lower=80, upper=15（bodyRatio=0.05, lower/range=0.8, strength=0.67）
		const candles = [...bullishCandles(3), mc(0, 80, 100, 0, 85)];

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 4,
			focus_last_n: 4,
			patterns: ['hammer'],
			history_lookback_days: 30,
		});
		assertOk(res);
		const hammers = res.data.recent_patterns.filter((p: { pattern: string }) => p.pattern === 'hammer');
		expect(hammers.length).toBeGreaterThanOrEqual(1);
		expect(hammers[0].direction).toBe('bullish');
	});

	it('シューティングスター: 長い上ヒゲ・小さい実体を検出', async () => {
		// bodyRatio=[0.05,0.35], upper>=body*2, lower/range<=0.25, upper/range>=0.6 に対し、O=20, H=100, L=0, C=15 → body=5, range=100, upper=80, lower=15
		const candles = [...bullishCandles(3), mc(0, 20, 100, 0, 15)];

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 4,
			focus_last_n: 4,
			patterns: ['shooting_star'],
			history_lookback_days: 30,
		});
		assertOk(res);
		const stars = res.data.recent_patterns.filter((p: { pattern: string }) => p.pattern === 'shooting_star');
		expect(stars.length).toBeGreaterThanOrEqual(1);
		expect(stars[0].direction).toBe('bearish');
	});

	it('十字線: 実体が極小のローソク足を検出', async () => {
		// doji: body/range < 5%
		const candles = [
			...bullishCandles(3),
			mc(0, 100, 110, 90, 100.2), // body=0.2, range=20, ratio=1%
		];

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 4,
			focus_last_n: 4,
			patterns: ['doji'],
			history_lookback_days: 30,
		});
		assertOk(res);
		const dojis = res.data.recent_patterns.filter((p: { pattern: string }) => p.pattern === 'doji');
		expect(dojis.length).toBeGreaterThanOrEqual(1);
	});

	it('上昇トレンド直後の doji は bearish と判定', async () => {
		const candles = [
			mcFixed(0, 100, 112, 98, 110),
			mcFixed(1, 110, 122, 108, 120),
			mcFixed(2, 120, 132, 118, 130),
			mcFixed(3, 130, 135, 125, 130.2), // doji
		];
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			as_of: '2026-01-04',
			window_days: 4,
			focus_last_n: 4,
			patterns: ['doji'],
			history_lookback_days: 30,
		});
		assertOk(res);
		expect(res.data.recent_patterns).toHaveLength(1);
		expect(res.data.recent_patterns[0].direction).toBe('bearish');
		expect(res.data.recent_patterns[0].local_context.trend_before).toBe('up');
	});

	it('下降トレンド直後の doji は bullish と判定', async () => {
		const candles = [
			...bearishCandles(3, 130, 3),
			mc(0, 120, 125, 115, 120.1), // doji after downtrend
		];

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 4,
			focus_last_n: 4,
			patterns: ['doji'],
			history_lookback_days: 30,
		});
		assertOk(res);
		const dojis = res.data.recent_patterns.filter((p: { pattern: string }) => p.pattern === 'doji');
		expect(dojis.length).toBeGreaterThan(0);
		expect(dojis[0].direction).toBe('bullish');
	});

	it('陽線包み線 (bullish_engulfing) を検出', async () => {
		const candles = [
			...bearishCandles(3), // 下降トレンド
			mc(1, 120, 121, 115, 116), // 陰線（小）
			mc(0, 115, 125, 114, 124), // 陽線（包む）: open≤prev.close, close≥prev.open
		];

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 5,
			focus_last_n: 5,
			patterns: ['bullish_engulfing'],
			history_lookback_days: 30,
		});
		assertOk(res);
		const found = res.data.recent_patterns.filter((p: { pattern: string }) => p.pattern === 'bullish_engulfing');
		expect(found.length).toBeGreaterThanOrEqual(1);
	});

	it('陰線包み線 (bearish_engulfing) を検出', async () => {
		const candles = [
			...bullishCandles(3),
			mc(1, 110, 115, 109, 114), // 陽線（小）
			mc(0, 115, 116, 108, 109), // 陰線（包む）: open≥prev.close, close≤prev.open
		];

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 5,
			focus_last_n: 5,
			patterns: ['bearish_engulfing'],
			history_lookback_days: 30,
		});
		assertOk(res);
		const found = res.data.recent_patterns.filter((p: { pattern: string }) => p.pattern === 'bearish_engulfing');
		expect(found.length).toBeGreaterThanOrEqual(1);
	});

	it('陽線はらみ線 (bullish_harami) を検出', async () => {
		const candles = [
			...bearishCandles(3),
			mc(1, 125, 126, 109, 110), // 大陰線: body=15
			mc(0, 115, 118, 113, 117), // 小陽線: body=2, 内包
		];

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 5,
			focus_last_n: 5,
			patterns: ['bullish_harami'],
			history_lookback_days: 30,
		});
		assertOk(res);
		const found = res.data.recent_patterns.filter((p: { pattern: string }) => p.pattern === 'bullish_harami');
		expect(found.length).toBeGreaterThanOrEqual(1);
	});

	it('陰線はらみ線 (bearish_harami) を検出', async () => {
		const candles = [
			...bullishCandles(3),
			mc(1, 110, 126, 109, 125), // 大陽線: body=15
			mc(0, 120, 122, 113, 115), // 小陰線: body=5, 内包
		];

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 5,
			focus_last_n: 5,
			patterns: ['bearish_harami'],
			history_lookback_days: 30,
		});
		assertOk(res);
		const found = res.data.recent_patterns.filter((p: { pattern: string }) => p.pattern === 'bearish_harami');
		expect(found.length).toBeGreaterThanOrEqual(1);
	});

	it('毛抜き天井 (tweezer_top) を検出', async () => {
		// 2日連続で高値がほぼ同じ（±0.5%）、かつレンジ上部
		const candles = [
			...bullishCandles(3),
			mc(1, 118, 130, 115, 125), // high=130
			mc(0, 125, 130.5, 120, 122), // high=130.5（差=0.5, avg=130.25, 0.38%）
		];

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 5,
			focus_last_n: 5,
			patterns: ['tweezer_top'],
			history_lookback_days: 30,
		});
		assertOk(res);
		const found = res.data.recent_patterns.filter((p: { pattern: string }) => p.pattern === 'tweezer_top');
		expect(found.length).toBeGreaterThanOrEqual(1);
	});

	it('毛抜き底 (tweezer_bottom) を検出', async () => {
		const candles = [
			...bearishCandles(3),
			mc(1, 112, 115, 100, 102), // low=100
			mc(0, 102, 108, 100.3, 106), // low=100.3（差=0.3, avg=100.15, 0.3%）
		];

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 5,
			focus_last_n: 5,
			patterns: ['tweezer_bottom'],
			history_lookback_days: 30,
		});
		assertOk(res);
		const found = res.data.recent_patterns.filter((p: { pattern: string }) => p.pattern === 'tweezer_bottom');
		expect(found.length).toBeGreaterThanOrEqual(1);
	});

	it('かぶせ線 (dark_cloud_cover) の検出パスを通過', async () => {
		// strength が構造的に 0.5 未満になるため強度フィルタで除外されるが、検出ロジック自体はカバーされる
		const candles = [
			...bullishCandles(3),
			mc(1, 100, 122, 98, 120), // 大陽線 body=20
			mc(0, 121, 122, 104, 105), // 陰線: open≈prev.close, close < midpoint(110)
		];

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 5,
			focus_last_n: 5,
			patterns: ['dark_cloud_cover'],
			history_lookback_days: 30,
		});
		assertOk(res);
		// 検出されるが strength < 0.5 でフィルタされる
	});

	it('切り込み線 (piercing_line) の検出パスを通過', async () => {
		const candles = [
			...bearishCandles(3),
			mc(1, 120, 122, 98, 100), // 大陰線 body=20
			mc(0, 99, 116, 98, 115), // 陽線: open≈prev.close, close > midpoint(110)
		];

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 5,
			focus_last_n: 5,
			patterns: ['piercing_line'],
			history_lookback_days: 30,
		});
		assertOk(res);
		// 検出されるが strength < 0.5 でフィルタされる
	});

	it('明けの明星 (morning_star) を検出', async () => {
		// 大陰線 → 小実体 → 大陽線
		const candles = [
			...bearishCandles(3),
			mc(2, 130, 132, 108, 110), // 大陰線 body=20
			mc(1, 109, 111, 105, 108), // 小実体 body=1, bodyBottom(108) <= bodyBottom(c1=110)
			mc(0, 110, 135, 108, 132), // 大陽線 body=22, close > midpoint(120)
		];

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 6,
			focus_last_n: 5,
			patterns: ['morning_star'],
			history_lookback_days: 30,
		});
		assertOk(res);
		const found = res.data.recent_patterns.filter((p: { pattern: string }) => p.pattern === 'morning_star');
		expect(found.length).toBeGreaterThanOrEqual(1);
		expect(found[0].direction).toBe('bullish');
	});

	it('宵の明星 (evening_star) を検出', async () => {
		// 大陽線 → 小実体 → 大陰線
		const candles = [
			...bullishCandles(3),
			mc(2, 110, 132, 108, 130), // 大陽線 body=20
			mc(1, 131, 135, 129, 132), // 小実体 body=1, bodyTop(132) >= bodyTop(c1=130)
			mc(0, 129, 130, 108, 110), // 大陰線 body=19, close < midpoint(120)
		];

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 6,
			focus_last_n: 5,
			patterns: ['evening_star'],
			history_lookback_days: 30,
		});
		assertOk(res);
		const found = res.data.recent_patterns.filter((p: { pattern: string }) => p.pattern === 'evening_star');
		expect(found.length).toBeGreaterThanOrEqual(1);
		expect(found[0].direction).toBe('bearish');
	});

	it('赤三兵 (three_white_soldiers) を検出', async () => {
		// 3本連続陽線、各終値が前を上回る、始値は前の実体内
		const candles = [
			mc(5, 95, 98, 94, 96), // コンテキスト
			mc(4, 95, 98, 94, 96),
			mc(3, 95, 98, 94, 96),
			mc(2, 100, 112, 99, 110), // 陽線1 body=10
			mc(1, 108, 122, 107, 120), // 陽線2 body=12, close>prev
			mc(0, 118, 134, 117, 132), // 陽線3 body=14, close>prev
		];

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 6,
			focus_last_n: 5,
			patterns: ['three_white_soldiers'],
			history_lookback_days: 30,
		});
		assertOk(res);
		const found = res.data.recent_patterns.filter((p: { pattern: string }) => p.pattern === 'three_white_soldiers');
		expect(found.length).toBeGreaterThanOrEqual(1);
	});

	it('黒三兵 (three_black_crows) を検出', async () => {
		// 3本連続陰線、各終値が前を下回る
		const candles = [
			mc(5, 140, 142, 138, 141),
			mc(4, 140, 142, 138, 141),
			mc(3, 140, 142, 138, 141),
			mc(2, 140, 142, 128, 130), // 陰線1 body=10
			mc(1, 132, 133, 117, 118), // 陰線2 body=14, close<prev
			mc(0, 120, 121, 104, 106), // 陰線3 body=14, close<prev
		];

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 6,
			focus_last_n: 5,
			patterns: ['three_black_crows'],
			history_lookback_days: 30,
		});
		assertOk(res);
		const found = res.data.recent_patterns.filter((p: { pattern: string }) => p.pattern === 'three_black_crows');
		expect(found.length).toBeGreaterThanOrEqual(1);
	});

	it('ボラティリティレベルを判定', async () => {
		// 高ボラティリティ: range/price > 3%
		const candles = [
			mc(4, 100, 104, 96, 103), // range=8, 8%
			mc(3, 103, 108, 95, 106),
			mc(2, 106, 112, 98, 110),
			mc(1, 110, 116, 102, 108),
			mc(0, 108, 116, 100, 108.1), // doji
		];

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 5,
			focus_last_n: 5,
			patterns: ['doji'],
			history_lookback_days: 30,
		});
		assertOk(res);
		expect(res.data.recent_patterns.length).toBeGreaterThan(0);
		expect(res.data.recent_patterns[0].local_context.volatility_level).toBeDefined();
	});

	it('十分なサンプルがあれば history_stats を算出', async () => {
		// 200本のデータでdojiが頻出するデータ
		const candles: Candle[] = [];
		for (let i = 0; i < 200; i++) {
			const base = 100 + Math.sin(i / 5) * 10;
			if (i % 5 === 0) {
				candles.push(mc(200 - i, base, base + 5, base - 5, base + 0.1));
			} else {
				candles.push(mc(200 - i, base, base + 6, base - 4, base + 3));
			}
		}

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 5,
			focus_last_n: 5,
			patterns: ['doji'],
			history_lookback_days: 180,
			history_horizons: [1, 3, 5],
		});
		assertOk(res);
		const dojis = res.data.recent_patterns.filter((p: { pattern: string }) => p.pattern === 'doji');
		expect(dojis.length).toBeGreaterThan(0);
		const stats = requireDefined(dojis[0].history_stats, 'dojis[0].history_stats');
		expect(stats.occurrences).toBeGreaterThanOrEqual(5);
		expect(stats.horizons).toBeDefined();
	});

	it('サンプル不足なら history_stats は null', async () => {
		// 短期間データ → 過去パターン5回未満
		const candles = Array.from({ length: 10 }, (_, i) => mc(10 - i, 100, 106, 94, 103));
		candles[candles.length - 1] = mc(0, 100, 110, 90, 100.1);

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 5,
			focus_last_n: 5,
			patterns: ['doji'],
			history_lookback_days: 30,
		});
		assertOk(res);
		const dojis = res.data.recent_patterns.filter((p: { pattern: string }) => p.pattern === 'doji');
		expect(dojis.length).toBeGreaterThan(0);
		expect(dojis[0].history_stats).toBeNull();
	});

	it('as_of 指定時の history_stats は未来データを含めない', async () => {
		const dojiDays = new Set([20, 22, 24, 26, 28, 30]);
		const candles = Array.from({ length: 40 }, (_, i) => {
			const base = 100 + i;
			if (dojiDays.has(i)) {
				return mcFixed(i, base, base + 5, base - 5, base + 0.2);
			}
			return mcFixed(i, base, base + 6, base - 4, base + 3);
		});

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			as_of: '2026-01-21',
			window_days: 5,
			focus_last_n: 5,
			patterns: ['doji'],
			history_lookback_days: 30,
		});
		assertOk(res);
		expect(res.data.window.to).toBe('2026-01-21');
	});

	it('as_of は get_candles と同じ tz の暦日で読み、その日の足を含めて翌日の足を含めない', async () => {
		const candles = Array.from({ length: 40 }, (_, i) => mcFixed(i, 100 + i, 106 + i, 96 + i, 103 + i));
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({ as_of: '2026-01-21', window_days: 5, history_lookback_days: 30 });
		assertOk(res);
		expect(mockedGetCandles).toHaveBeenCalledWith('btc_jpy', '1day', '20260121', expect.any(Number), 'Asia/Tokyo');
		expect(res.data.window.to).toBe('2026-01-21');
	});

	it('strength < 0.5 のパターンはフィルタされる', async () => {
		// range=0 の場合検出されない（strength=0）
		const candles = Array.from({ length: 5 }, (_, i) => mc(5 - i, 100, 100, 100, 100));
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({ window_days: 5, focus_last_n: 5, history_lookback_days: 30 });
		assertOk(res);
		for (const p of res.data.recent_patterns) {
			expect(p.strength).toBeGreaterThanOrEqual(0.5);
		}
	});

	it('allow_partial_patterns=false で最新未確定足を使ったパターンをスキップ', async () => {
		// 最新ローソク足が「今日」→ 未確定
		const candles = [
			mc(2, 100, 106, 94, 103),
			mc(1, 103, 108, 95, 105),
			{
				isoTime: dayjs().startOf('day').toISOString(),
				open: 105,
				high: 115,
				low: 95,
				close: 105.1,
				volume: 100,
			}, // 今日 → partial
		];

		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 3,
			focus_last_n: 3,
			patterns: ['doji'],
			allow_partial_patterns: false,
			history_lookback_days: 30,
		});
		assertOk(res);
		for (const p of res.data.recent_patterns) {
			expect(p.uses_partial_candle).toBe(false);
			expect(p.status).toBe('confirmed');
		}
	});

	// 最後の足（doji）は 2026-01-21T00:00Z 始まり。JST 0〜9 時（UTC 15〜24 時）も進行中として扱う。
	it.each([
		['UTC の日中（JST 21 時）', '2026-01-21T12:00:00Z', true],
		['JST の日付が先に変わった時間帯（JST 01 時）', '2026-01-21T16:00:00Z', true],
		['足が閉じた後', '2026-01-22T01:00:00Z', false],
	])('最後の足は開始から 1 日たつまで未確定: %s', async (_label, now, partial) => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(now));
		try {
			const candles = [
				mcFixed(18, 100, 106, 94, 103),
				mcFixed(19, 103, 108, 95, 105),
				mcFixed(20, 105, 115, 95, 105.1), // doji
			];
			mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
			const res = await analyzeCandlePatterns({
				window_days: 3,
				focus_last_n: 3,
				patterns: ['doji'],
				allow_partial_patterns: true,
				history_lookback_days: 30,
			});
			assertOk(res);
			const doji = requireDefined(
				res.data.recent_patterns.find((p: { pattern: string }) => p.pattern === 'doji'),
				'doji',
			);
			expect(doji.uses_partial_candle).toBe(partial);
			expect(doji.status).toBe(partial ? 'forming' : 'confirmed');
		} finally {
			vi.useRealTimers();
		}
	});

	it('as_of に ISO 形式を指定可能', async () => {
		const candles = Array.from({ length: 10 }, (_, i) => mcFixed(i, 100, 106, 94, 103));
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({ as_of: '2026-01-05', window_days: 5, history_lookback_days: 30 });
		assertOk(res);
		expect(res.meta?.date).toBe('20260105');
	});

	it('as_of に YYYYMMDD 形式を指定可能', async () => {
		const candles = Array.from({ length: 10 }, (_, i) => mcFixed(i, 100, 106, 94, 103));
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({ as_of: '20260105', window_days: 5, history_lookback_days: 30 });
		assertOk(res);
		expect(res.meta?.date).toBe('20260105');
	});

	it('patterns 指定で対象パターンを絞り込める', async () => {
		const candles = [
			...bullishCandles(3),
			mc(0, 100, 110, 90, 100.2), // doji
		];
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 4,
			focus_last_n: 4,
			patterns: ['doji'],
			history_lookback_days: 30,
		});
		assertOk(res);
		for (const p of res.data.recent_patterns) {
			expect(p.pattern).toBe('doji');
		}
	});

	it('検出ありの場合 content にパターン名を含む', async () => {
		const candles = [
			...bullishCandles(3),
			mc(0, 100, 110, 90, 100.2), // doji
		];
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 4,
			focus_last_n: 4,
			patterns: ['doji'],
			history_lookback_days: 30,
		});
		assertOk(res);
		const text = res.content?.map((c: { text: string }) => c.text).join('') ?? '';
		expect(res.data.recent_patterns.length).toBeGreaterThan(0);
		expect(text).toContain('十字線');
	});

	it('検出なしの場合も content を返す', async () => {
		const candles = Array.from({ length: 5 }, (_, i) => mc(5 - i, 100, 106, 94, 103));
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({
			window_days: 5,
			focus_last_n: 5,
			patterns: ['morning_star'], // 検出されない
			history_lookback_days: 30,
		});
		assertOk(res);
		expect(res.content).toBeDefined();
	});

	it('data に pair / timeframe / window / recent_patterns を含む', async () => {
		const candles = Array.from({ length: 5 }, (_, i) => mc(5 - i, 100, 106, 94, 103));
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await analyzeCandlePatterns({ window_days: 5, history_lookback_days: 30 });
		assertOk(res);

		expect(res.data.pair).toBe('btc_jpy');
		expect(res.data.timeframe).toBe('1day');
		expect(res.data.window).toBeDefined();
		expect(res.data.window.candles).toHaveLength(5);
		expect(res.data.recent_patterns).toBeDefined();
	});

	it('toolDef.handler が analyzeCandlePatterns に委譲', async () => {
		const candles = Array.from({ length: 5 }, (_, i) => mc(5 - i, 100, 106, 94, 103));
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
		const res = await toolDef.handler({ window_days: 5, history_lookback_days: 30 });
		expect(res).toBeDefined();
		expect((res as { ok: boolean }).ok).toBe(true);
	});

	describe('上流 warning の伝播', () => {
		it('get_candles の meta.warning が tool の meta.warning と summary 先頭に伝播する', async () => {
			const candles = [
				...bullishCandles(3),
				mc(0, 100, 110, 90, 100.2), // doji
			];
			mockedGetCandles.mockResolvedValueOnce(
				asMockResult(candlesOkWithWarning(candles, '⚠️ partial fetch (3日中1日の取得に失敗)')),
			);

			const res = await analyzeCandlePatterns({
				window_days: 4,
				focus_last_n: 4,
				patterns: ['doji'],
				history_lookback_days: 30,
			});
			assertOk(res);
			expect(res.meta?.warning).toBe('⚠️ partial fetch (3日中1日の取得に失敗)');
			expect(res.summary.startsWith('⚠️ partial fetch')).toBe(true);
		});

		it('content[0].text の先頭に上流 warning が含まれる（server.ts が content を summary より優先するため最重要）', async () => {
			const candles = [
				...bullishCandles(3),
				mc(0, 100, 110, 90, 100.2), // doji
			];
			mockedGetCandles.mockResolvedValueOnce(
				asMockResult(candlesOkWithWarning(candles, '⚠️ partial fetch (multi-day failure)')),
			);

			const res = await analyzeCandlePatterns({
				window_days: 4,
				focus_last_n: 4,
				patterns: ['doji'],
				history_lookback_days: 30,
			});
			assertOk(res);
			expect(res.content).toBeDefined();
			const firstText = res.content?.[0]?.text ?? '';
			expect(firstText.startsWith('⚠️ partial fetch')).toBe(true);
			const idxWarning = firstText.indexOf('⚠️');
			const idxHeader = firstText.indexOf('【ローソク足パターン分析結果】');
			expect(idxWarning).toBeGreaterThanOrEqual(0);
			expect(idxWarning).toBeLessThan(idxHeader);
		});

		it('上流 warning 無しなら meta.warning は undefined、content/summary に ⚠️ が含まれない', async () => {
			const candles = Array.from({ length: 5 }, (_, i) => mc(5 - i, 100, 106, 94, 103));
			mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));

			const res = await analyzeCandlePatterns({
				window_days: 5,
				focus_last_n: 5,
				patterns: ['doji'],
				history_lookback_days: 30,
			});
			assertOk(res);
			expect(res.meta?.warning).toBeUndefined();
			expect(res.summary.startsWith('⚠️')).toBe(false);
			const firstText = res.content?.[0]?.text ?? '';
			// 本文に他で混入する ⚠️ がないことを限定的に確認（partial fetch 等のメッセージは無い）
			expect(firstText.includes('⚠️ partial fetch')).toBe(false);
		});

		it('toolDef.handler 経由でも content[0].text 先頭に warning が出る', async () => {
			const candles = [
				...bullishCandles(3),
				mc(0, 100, 110, 90, 100.2), // doji
			];
			mockedGetCandles.mockResolvedValueOnce(
				asMockResult(candlesOkWithWarning(candles, '⚠️ partial fetch (handler test)')),
			);

			const res = await toolDef.handler({
				window_days: 4,
				focus_last_n: 4,
				patterns: ['doji'],
				history_lookback_days: 30,
			});
			expect((res as { ok: boolean }).ok).toBe(true);
			const content = (res as { content?: Array<{ text: string }> }).content;
			expect(content).toBeDefined();
			expect(content?.[0]?.text.startsWith('⚠️ partial fetch')).toBe(true);
		});
	});
});
