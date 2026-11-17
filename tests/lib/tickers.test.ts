import { afterEach, describe, expect, it, vi } from 'vitest';
import { BITBANK_API_BASE } from '../../lib/http.js';
import { fetchTickerPricesMap } from '../../lib/tickers.js';

function mockTickerResponse(body: unknown, status = 200) {
	return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.TICKERS_JPY_URL;
});

describe('fetchTickerPricesMap', () => {
	it('success=1 の data から asset→last の Map を構築する（_jpy strip / last<=0 除外）', async () => {
		mockTickerResponse({
			success: 1,
			data: [
				{ pair: 'btc_jpy', last: '15500000' },
				{ pair: 'eth_jpy', last: '380000' },
				{ pair: 'xrp_jpy', last: '0' }, // last == 0 → 除外
				{ pair: 'doge_jpy', last: '-1' }, // last < 0 → 除外
			],
		});

		const result = await fetchTickerPricesMap();

		expect(result.error).toBeUndefined();
		// _jpy が strip され asset シンボルがキーになる
		expect(result.prices.get('btc')).toBe(15500000);
		expect(result.prices.get('eth')).toBe(380000);
		// last <= 0 は除外
		expect(result.prices.has('xrp')).toBe(false);
		expect(result.prices.has('doge')).toBe(false);
		expect(result.prices.size).toBe(2);
	});

	it('数値でない last（toNum が null）は除外する', async () => {
		mockTickerResponse({
			success: 1,
			data: [
				{ pair: 'btc_jpy', last: '15500000' },
				{ pair: 'eth_jpy', last: '' }, // toNum -> null
				{ pair: 'xrp_jpy', last: 'abc' }, // toNum -> null
			],
		});

		const result = await fetchTickerPricesMap();

		expect(result.error).toBeUndefined();
		expect(result.prices.size).toBe(1);
		expect(result.prices.get('btc')).toBe(15500000);
	});

	it('空 data でも error なしで空 Map を返す', async () => {
		mockTickerResponse({ success: 1, data: [] });

		const result = await fetchTickerPricesMap();

		expect(result.error).toBeUndefined();
		expect(result.prices.size).toBe(0);
	});

	it('HTTP !ok のとき空 Map + error', async () => {
		mockTickerResponse({}, 500);

		const result = await fetchTickerPricesMap();

		expect(result.prices.size).toBe(0);
		expect(result.error).toBe('ticker HTTP 500');
	});

	it('success!==1 のとき空 Map + error', async () => {
		mockTickerResponse({ success: 0, data: [] });

		const result = await fetchTickerPricesMap();

		expect(result.prices.size).toBe(0);
		expect(result.error).toBe('ticker レスポンス不正');
	});

	it('data が配列でないとき空 Map + error', async () => {
		mockTickerResponse({ success: 1, data: { not: 'an array' } });

		const result = await fetchTickerPricesMap();

		expect(result.prices.size).toBe(0);
		expect(result.error).toBe('ticker レスポンス不正');
	});

	it('fetch が reject したとき空 Map + error（例外メッセージ）', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

		const result = await fetchTickerPricesMap();

		expect(result.prices.size).toBe(0);
		expect(result.error).toBe('fetch failed');
	});

	it('BITBANK_API_BASE/tickers_jpy で fetch される', async () => {
		const spy = mockTickerResponse({ success: 1, data: [] });

		await fetchTickerPricesMap();

		expect(spy).toHaveBeenCalledTimes(1);
		expect(String(spy.mock.calls[0]?.[0])).toBe(`${BITBANK_API_BASE}/tickers_jpy`);
	});

	it('環境変数 TICKERS_JPY_URL を設定しても取得先は変わらない（評価額の価格を差し替えさせない）', async () => {
		process.env.TICKERS_JPY_URL = 'http://test.local/custom_tickers';
		const spy = mockTickerResponse({ success: 1, data: [] });

		await fetchTickerPricesMap();

		expect(spy).toHaveBeenCalledTimes(1);
		expect(String(spy.mock.calls[0]?.[0])).toBe(`${BITBANK_API_BASE}/tickers_jpy`);
	});
});
