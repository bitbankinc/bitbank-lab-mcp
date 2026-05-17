import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../../lib/datetime.js';

vi.mock('../../../tools/get_candles.js', () => ({
	default: vi.fn(),
}));

import getCandles from '../../../tools/get_candles.js';
import { fetchCandlesForBacktest, getPeriodBars } from '../../../tools/trading_process/lib/fetch_candles.js';
import type { Timeframe } from '../../../tools/trading_process/types.js';

afterEach(() => {
	vi.resetAllMocks();
});

describe('getPeriodBars', () => {
	it('1D / 1M は 30 を返す', () => {
		expect(getPeriodBars('1D', '1M')).toBe(30);
	});

	it('1D / 3M は 90 を返す', () => {
		expect(getPeriodBars('1D', '3M')).toBe(90);
	});

	it('1D / 6M は 180 を返す', () => {
		expect(getPeriodBars('1D', '6M')).toBe(180);
	});

	it('4H / 1M は 180 を返す', () => {
		expect(getPeriodBars('4H', '1M')).toBe(180);
	});

	it('4H / 3M は 540 を返す', () => {
		expect(getPeriodBars('4H', '3M')).toBe(540);
	});

	it('1H / 6M は 4320 を返す', () => {
		expect(getPeriodBars('1H', '6M')).toBe(4320);
	});

	it('1H / 1M は 720 を返す', () => {
		expect(getPeriodBars('1H', '1M')).toBe(720);
	});

	it('1D / 1Y は 365 を返す', () => {
		expect(getPeriodBars('1D', '1Y')).toBe(365);
	});

	it('1D / 2Y は 730 を返す', () => {
		expect(getPeriodBars('1D', '2Y')).toBe(730);
	});

	it('1D / 3Y は 1095 を返す', () => {
		expect(getPeriodBars('1D', '3Y')).toBe(1095);
	});

	it('4H / 1Y は 2190 を返す', () => {
		expect(getPeriodBars('4H', '1Y')).toBe(2190);
	});

	it('1H / 3Y は 26280 を返す', () => {
		expect(getPeriodBars('1H', '3Y')).toBe(26280);
	});
});

function makeNormalized(n: number, startDate = '2024-01-01') {
	const base = dayjs(startDate);
	return Array.from({ length: n }, (_, i) => ({
		isoTime: base.add(i, 'day').format('YYYY-MM-DD'),
		open: 100,
		high: 101,
		low: 99,
		close: 100,
		volume: 1000,
	}));
}

describe('fetchCandlesForBacktest', () => {
	it('正常取得: 有効なローソク足を返す', async () => {
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: { normalized: makeNormalized(100) },
		} as never);
		const result = await fetchCandlesForBacktest('btc_jpy', '1D', { type: 'period', value: '1M' }, 10);
		// neededBars = 30 + 10 + 10 = 50; 100 > 50 → slice last 50
		expect(result).toHaveLength(50);
		expect(result[0].close).toBe(100);
	});

	it('未対応 timeframe/period → エラー', async () => {
		await expect(
			fetchCandlesForBacktest('btc_jpy', '5M' as Timeframe, { type: 'period', value: '1M' }, 50),
		).rejects.toThrow('Unsupported timeframe/period');
	});

	it('API 失敗 → エラー', async () => {
		vi.mocked(getCandles).mockResolvedValue({
			ok: false,
			summary: 'API error',
		} as never);
		await expect(fetchCandlesForBacktest('btc_jpy', '1D', { type: 'period', value: '1M' }, 10)).rejects.toThrow(
			'Failed to fetch candles',
		);
	});

	it('空データ → エラー', async () => {
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: { normalized: [] },
		} as never);
		await expect(fetchCandlesForBacktest('btc_jpy', '1D', { type: 'period', value: '1M' }, 10)).rejects.toThrow(
			'No candle data returned',
		);
	});

	it('有効ローソク 0 件 → エラー', async () => {
		// All candles have empty isoTime → all filtered out
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: {
				normalized: [
					{ isoTime: '', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
					{ isoTime: null, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
				],
			},
		} as never);
		await expect(fetchCandlesForBacktest('btc_jpy', '1D', { type: 'period', value: '1M' }, 10)).rejects.toThrow(
			'No valid candle data after filtering',
		);
	});

	it('データ不足で全件返却', async () => {
		// neededBars = 30 + 5 + 10 = 45; return only 20 candles → all 20 returned
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: { normalized: makeNormalized(20) },
		} as never);
		const result = await fetchCandlesForBacktest('btc_jpy', '1D', { type: 'period', value: '1M' }, 5);
		expect(result).toHaveLength(20);
	});

	it('重複排除: 同一 time のローソク足が 1 本に絞られる', async () => {
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: {
				normalized: [
					{ isoTime: '2024-01-01', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
					{ isoTime: '2024-01-01', open: 110, high: 111, low: 109, close: 110, volume: 2000 },
					{ isoTime: '2024-01-02', open: 105, high: 106, low: 104, close: 105, volume: 500 },
				],
			},
		} as never);
		const result = await fetchCandlesForBacktest('btc_jpy', '4H', { type: 'period', value: '1M' }, 5);
		const jan1 = result.filter((c) => c.time === '2024-01-01');
		expect(jan1).toHaveLength(1);
	});

	it('isValidCandle: NaN OHLC は除外される', async () => {
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: {
				normalized: [
					{ isoTime: '2024-01-01', open: Number.NaN, high: 101, low: 99, close: 100, volume: 1000 },
					{ isoTime: '2024-01-02', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
				],
			},
		} as never);
		const result = await fetchCandlesForBacktest('btc_jpy', '4H', { type: 'period', value: '1M' }, 5);
		// Only the valid candle passes
		expect(result.every((c) => !Number.isNaN(c.open))).toBe(true);
	});

	it('isValidCandle: price <= 0 は除外される', async () => {
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: {
				normalized: [
					{ isoTime: '2024-01-01', open: -10, high: 101, low: 99, close: 100, volume: 1000 },
					{ isoTime: '2024-01-02', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
				],
			},
		} as never);
		const result = await fetchCandlesForBacktest('btc_jpy', '4H', { type: 'period', value: '1M' }, 5);
		expect(result.every((c) => c.open > 0)).toBe(true);
	});

	it('結果は time で昇順ソートされている', async () => {
		// Provide candles in reverse order
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: {
				normalized: [
					{ isoTime: '2024-01-03', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
					{ isoTime: '2024-01-01', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
					{ isoTime: '2024-01-02', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
				],
			},
		} as never);
		const result = await fetchCandlesForBacktest('btc_jpy', '4H', { type: 'period', value: '1M' }, 5);
		expect(result[0].time).toBe('2024-01-01');
		expect(result[1].time).toBe('2024-01-02');
		expect(result[2].time).toBe('2024-01-03');
	});

	it('period: 1D × 1Y は 365 本前後（+ウォームアップ）を返す', async () => {
		// 十分なデータを返し、365 + warmup + buffer に切詰められることを確認
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: { normalized: makeNormalized(500) },
		} as never);
		const warmup = 200;
		const result = await fetchCandlesForBacktest('btc_jpy', '1D', { type: 'period', value: '1Y' }, warmup);
		// neededBars = 365 + 200 + 10 = 575 → データ不足 (500 < 575) なので全件返却
		expect(result).toHaveLength(500);
	});

	it('period: 1D × 1Y は十分なデータがあれば 365 + warmup + buffer に切詰める', async () => {
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: { normalized: makeNormalized(1000) },
		} as never);
		const warmup = 50;
		const result = await fetchCandlesForBacktest('btc_jpy', '1D', { type: 'period', value: '1Y' }, warmup);
		// neededBars = 365 + 50 + 10 = 425
		expect(result).toHaveLength(425);
	});

	it('absolute: end_date より後のデータを除外する', async () => {
		// 2024-01-01 から 50 日分のデータ
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: { normalized: makeNormalized(50, '2024-01-01') },
		} as never);
		const result = await fetchCandlesForBacktest(
			'btc_jpy',
			'1D',
			{ type: 'absolute', start: '2024-01-10', end: '2024-01-20' },
			0,
		);
		// end より後 (2024-01-21+) は除外
		for (const c of result) {
			expect(dayjs(c.time).valueOf()).toBeLessThanOrEqual(dayjs('2024-01-20').endOf('day').valueOf());
		}
	});

	it('absolute: start_date 以降のシグナル評価用に warmup 分を含めて返す', async () => {
		// 2024-01-01 から 50 日分のデータ
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: { normalized: makeNormalized(50, '2024-01-01') },
		} as never);
		const warmup = 5;
		const result = await fetchCandlesForBacktest(
			'btc_jpy',
			'1D',
			{ type: 'absolute', start: '2024-01-10', end: '2024-01-20' },
			warmup,
		);
		// 最初の候補は start_date より warmup 本前 = 2024-01-05 のはず
		expect(result[0].time).toBe('2024-01-05');
		// 最後は end_date 以下
		expect(dayjs(result[result.length - 1].time).valueOf()).toBeLessThanOrEqual(
			dayjs('2024-01-20').endOf('day').valueOf(),
		);
	});

	it('absolute: 範囲内データなし → エラー', async () => {
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: { normalized: makeNormalized(10, '2024-01-01') },
		} as never);
		await expect(
			fetchCandlesForBacktest('btc_jpy', '1D', { type: 'absolute', start: '2025-01-01', end: '2025-02-01' }, 0),
		).rejects.toThrow('No candle data');
	});

	it('absolute: start > end → エラー', async () => {
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: { normalized: makeNormalized(10) },
		} as never);
		await expect(
			fetchCandlesForBacktest('btc_jpy', '1D', { type: 'absolute', start: '2024-02-01', end: '2024-01-01' }, 0),
		).rejects.toThrow('must be on or before');
	});

	it('absolute: 取得上限に達し最古足が start_date より新しい → 明示エラー', async () => {
		// 1D の MAX_FETCHABLE_BARS = 5000 ぶんを返すが、最古足は start_date (2010-01-01) より大幅に新しい
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: { normalized: makeNormalized(5000, '2020-01-01') },
		} as never);
		await expect(
			fetchCandlesForBacktest('btc_jpy', '1D', { type: 'absolute', start: '2010-01-01', end: '2025-12-31' }, 10),
		).rejects.toThrow(/Insufficient historical data.*hit API fetch cap/);
	});

	it('absolute: warmup 分の本数が start_date 直前に足りない → 明示エラー', async () => {
		// start=2024-01-10, warmup=20 だが、2024-01-01 から始まるので start 直前は 9 本しかない
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: { normalized: makeNormalized(50, '2024-01-01') },
		} as never);
		await expect(
			fetchCandlesForBacktest('btc_jpy', '1D', { type: 'absolute', start: '2024-01-10', end: '2024-01-20' }, 20),
		).rejects.toThrow(/Insufficient warmup data.*need 20 bars before 2024-01-10/);
	});

	it('absolute: 取得上限未達でも最古足が start_date より新しい → 明示エラー', async () => {
		// fetchLimit は maxBars (5000) より遥かに小さく fetchHitCap=false。
		// 最古足 (2024-01-15) は start_date (2024-01-10) より新しい。
		// 以前は黙って 2024-01-15 から返していたが、要求レンジ不足は常にエラーにする。
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: { normalized: makeNormalized(20, '2024-01-15') },
		} as never);
		await expect(
			fetchCandlesForBacktest('btc_jpy', '1D', { type: 'absolute', start: '2024-01-10', end: '2024-01-20' }, 0),
		).rejects.toThrow(/Insufficient historical data.*earliest available is 2024-01-15/);
	});

	it('absolute: 最古足が start_date と完全一致 → 通過する（off-by-one 境界）', async () => {
		// 最古足 (2024-01-10) が start_date (2024-01-10) と一致するケース。
		// earliestFetchedMs > startMs ではない（== なので >ではない）ので通過する。
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: { normalized: makeNormalized(20, '2024-01-10') },
		} as never);
		const result = await fetchCandlesForBacktest(
			'btc_jpy',
			'1D',
			{ type: 'absolute', start: '2024-01-10', end: '2024-01-20' },
			0,
		);
		expect(result[0].time).toBe('2024-01-10');
	});

	it('absolute: 空レスポンス → 「No candle data returned」エラー', async () => {
		// API が 0 件を返した場合は normalizeAndClean に到達する前に弾かれる。
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: { normalized: [] },
		} as never);
		await expect(
			fetchCandlesForBacktest('btc_jpy', '1D', { type: 'absolute', start: '2024-01-10', end: '2024-01-20' }, 0),
		).rejects.toThrow('No candle data returned');
	});

	it('absolute: 取得上限到達でも最古足が start_date と一致 → 通過する', async () => {
		// fetchHitCap=true でも earliestFetchedMs === startMs なら不足エラーは出ない。
		vi.mocked(getCandles).mockResolvedValue({
			ok: true,
			summary: 'ok',
			data: { normalized: makeNormalized(5000, '2024-01-10') },
		} as never);
		const result = await fetchCandlesForBacktest(
			'btc_jpy',
			'1D',
			{ type: 'absolute', start: '2024-01-10', end: '2024-01-20' },
			0,
		);
		expect(result[0].time).toBe('2024-01-10');
	});
});
