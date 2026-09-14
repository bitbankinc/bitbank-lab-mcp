import { afterEach, describe, expect, it, vi } from 'vitest';
import validateCandleData from '../tools/validate_candle_data.js';
import { assertFail, assertOk } from './_assertResult.js';

/** 1day 間隔の正常な OHLCV を N 本生成 */
function makeOhlcv(n: number, baseTs = 1704067200000) {
	return Array.from({ length: n }, (_, i) => [
		String(100 + i), // open
		String(110 + i), // high
		String(90 + i), // low
		String(105 + i), // close
		String(1 + i * 0.1), // volume
		String(baseTs + i * 86_400_000), // timestamp ms (1day interval)
	]);
}

function mockFetchOk(ohlcv: unknown[]) {
	return vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		statusText: 'OK',
		json: async () => ({
			success: 1,
			data: { candlestick: [{ ohlcv }] },
		}),
	});
}

describe('validateCandleData', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('不正なペアは user エラーを返す', async () => {
		const res = await validateCandleData('invalid_xxx', '1day', undefined);
		assertFail(res);
		expect(res.meta?.errorType).toBe('user');
	});

	it('正常なデータに対して品質スコアを算出する', async () => {
		globalThis.fetch = mockFetchOk(makeOhlcv(100)) as unknown as typeof fetch;

		const res = await validateCandleData('btc_jpy', '1day', '2024', 100);
		assertOk(res);

		expect(res.data.qualityScore.score).toBeGreaterThanOrEqual(90);
		expect(res.data.qualityScore.grade).toBe('A');
		expect(res.data.completeness.ratio).toBe(1);
		expect(res.data.duplicates.count).toBe(0);
		expect(res.data.integrity.invalidCount).toBe(0);
	});

	it('summary テキストに品質スコアが含まれる', async () => {
		globalThis.fetch = mockFetchOk(makeOhlcv(50)) as unknown as typeof fetch;

		const res = await validateCandleData('btc_jpy', '1day', '2024', 50);
		assertOk(res);

		expect(res.summary).toContain('品質スコア');
		expect(res.summary).toContain('BTC/JPY');
	});

	it('OHLCV 整合性エラーを検出する', async () => {
		const ohlcv = makeOhlcv(20);
		// high < low にする（壊れたレコード）
		ohlcv[5] = ['100', '80', '90', '85', '1', String(1704067200000 + 5 * 86_400_000)];
		globalThis.fetch = mockFetchOk(ohlcv) as unknown as typeof fetch;

		const res = await validateCandleData('btc_jpy', '1day', '2024', 20);
		assertOk(res);

		expect(res.data.integrity.invalidCount).toBeGreaterThan(0);
	});

	it('ネットワークエラー時は fail を返す', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

		const res = await validateCandleData('btc_jpy', '1day', '2024', 50);
		assertFail(res);
	});

	it('空データは user エラーを返す', async () => {
		globalThis.fetch = mockFetchOk([]) as unknown as typeof fetch;

		const res = await validateCandleData('btc_jpy', '1day', '2024', 50);
		assertFail(res);
	});

	it('meta にユーザー指定の thresholds と tier が含まれる', async () => {
		globalThis.fetch = mockFetchOk(makeOhlcv(30)) as unknown as typeof fetch;

		const res = await validateCandleData('btc_jpy', '1day', '2024', 30, 2.5, 5);
		assertOk(res);

		expect(res.meta.tier).toBe('major');
		expect(res.meta.thresholds.priceSigma).toBe(2.5);
		expect(res.meta.thresholds.volumeMultiplier).toBe(5);
	});

	it('閾値省略時はティアに応じたデフォルトが適用される', async () => {
		globalThis.fetch = mockFetchOk(makeOhlcv(30)) as unknown as typeof fetch;

		// btc_jpy = major → priceSigma=4, volumeMultiplier=15
		const res = await validateCandleData('btc_jpy', '1day', '2024', 30);
		assertOk(res);

		expect(res.meta.tier).toBe('major');
		expect(res.meta.thresholds.priceSigma).toBe(4);
		expect(res.meta.thresholds.volumeMultiplier).toBe(15);
	});

	it('summary にペアティアが表示される', async () => {
		globalThis.fetch = mockFetchOk(makeOhlcv(30)) as unknown as typeof fetch;

		const res = await validateCandleData('btc_jpy', '1day', '2024', 30);
		assertOk(res);

		expect(res.summary).toContain('major');
	});
});
