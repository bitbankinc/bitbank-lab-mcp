/**
 * get_my_assets ツールのユニットテスト。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFail, assertOk } from '../_assertResult.js';
import { tickersJpy } from '../fixtures/bitbank-api.js';
import { mockBitbankError, mockBitbankSuccess, rawAssetsResponse } from '../fixtures/private-api.js';

// getDefaultClient はシングルトンなので、globalThis.fetch をモックする
const originalFetch = globalThis.fetch;

beforeEach(() => {
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env.BITBANK_API_KEY;
	delete process.env.BITBANK_API_SECRET;
	vi.resetModules();
});

/** fetch モックを URL パターンでルーティング */
function setupFetchMock(opts: {
	assetsResponse?: unknown;
	assetsStatus?: number;
	tickerResponse?: unknown;
	tickerFail?: boolean;
}) {
	globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
		const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;

		if (urlStr.includes('tickers_jpy')) {
			if (opts.tickerFail) throw new Error('ticker network error');
			return new Response(JSON.stringify(opts.tickerResponse ?? tickersJpy), { status: 200 });
		}
		if (urlStr.includes('/v1/user/assets')) {
			const body = opts.assetsResponse ?? mockBitbankSuccess(rawAssetsResponse);
			return new Response(JSON.stringify(body), { status: opts.assetsStatus ?? 200 });
		}
		throw new Error(`Unexpected URL: ${urlStr}`);
	}) as unknown as typeof fetch;
}

describe('get_my_assets', () => {
	it('JPY 評価額付きで資産を返す', async () => {
		setupFetchMock({});

		// 動的 import でシングルトンのリセットを回避
		const { default: getMyAssets } = await import('../../tools/private/get_my_assets.js');
		const result = await getMyAssets({ include_jpy_valuation: true });

		assertOk(result);
		expect(result.data.assets.length).toBeGreaterThan(0);
		expect(result.data.total_jpy_value).toBeGreaterThan(0);

		// JPY 評価額降順ソート
		const jpyValues = result.data.assets.map((a) => a.jpy_value ?? 0);
		for (let i = 1; i < jpyValues.length; i++) {
			expect(jpyValues[i]).toBeLessThanOrEqual(jpyValues[i - 1]);
		}
	});

	it('ゼロ残高の資産を除外する', async () => {
		setupFetchMock({});

		const { default: getMyAssets } = await import('../../tools/private/get_my_assets.js');
		const result = await getMyAssets({ include_jpy_valuation: true });

		assertOk(result);
		const assetNames = result.data.assets.map((a) => a.asset);
		expect(assetNames).not.toContain('doge');
	});

	it('include_jpy_valuation=false で円評価なし', async () => {
		setupFetchMock({});

		const { default: getMyAssets } = await import('../../tools/private/get_my_assets.js');
		const result = await getMyAssets({ include_jpy_valuation: false });

		assertOk(result);
		expect(result.data.total_jpy_value).toBeUndefined();
		for (const asset of result.data.assets) {
			expect(asset.jpy_value).toBeUndefined();
		}
	});

	it('ticker 取得失敗時でも資産を返しサマリーに警告を含む', async () => {
		setupFetchMock({ tickerFail: true });

		const { default: getMyAssets } = await import('../../tools/private/get_my_assets.js');
		const result = await getMyAssets({ include_jpy_valuation: true });

		assertOk(result);
		// 資産は返る（JPY はティッカー不要なので評価できる）
		expect(result.data.assets.length).toBeGreaterThan(0);
		// サマリーに警告が含まれる
		expect(result.summary).toContain('ticker');
	});

	/**
	 * API が返す asset は取得境界で小文字へ正規化する（`lib/asset-code.ts`）。
	 * 出力の表記契約は「structuredContent は小文字 / サマリー表示は大文字」で、
	 * 正規化を入れても現行の小文字レスポンスに対しては何も変わらない。
	 */
	describe('API asset の取得境界正規化', () => {
		it('小文字レスポンスでは出力の asset 表記が変わらない', async () => {
			setupFetchMock({});

			const { default: getMyAssets } = await import('../../tools/private/get_my_assets.js');
			const result = await getMyAssets({ include_jpy_valuation: true });

			assertOk(result);
			expect(result.data.assets.map((a) => a.asset)).toEqual(['btc', 'eth', 'jpy', 'xrp']);
			// サマリー表示は従来どおり大文字
			expect(result.summary).toContain('BTC:');
			expect(result.summary).toContain('JPY:');
		});

		it('大文字レスポンスでも structuredContent の asset は小文字契約を保つ', async () => {
			setupFetchMock({
				assetsResponse: mockBitbankSuccess({
					assets: rawAssetsResponse.assets.map((a) => ({ ...a, asset: a.asset.toUpperCase() })),
				}),
			});

			const { default: getMyAssets } = await import('../../tools/private/get_my_assets.js');
			const result = await getMyAssets({ include_jpy_valuation: true });

			assertOk(result);
			expect(result.data.assets.map((a) => a.asset)).toEqual(['btc', 'eth', 'jpy', 'xrp']);
			// JPY 判定 (`a.asset === 'jpy'`) と prices.get(asset) が外れないこと
			expect(result.data.assets.find((a) => a.asset === 'jpy')?.jpy_value).toBe(500_000);
			expect(result.data.assets.find((a) => a.asset === 'btc')?.jpy_value).toBe(0.6 * 15_500_000);
			expect(result.summary).toContain('BTC:');
		});
	});

	it('PrivateApiError で fail を返す', async () => {
		setupFetchMock({
			assetsResponse: mockBitbankError(20001),
			assetsStatus: 400,
		});

		const { default: getMyAssets } = await import('../../tools/private/get_my_assets.js');
		const result = await getMyAssets({ include_jpy_valuation: true });

		assertFail(result);
		expect(result.meta.errorType).toBe('authentication_error');
	});
});
