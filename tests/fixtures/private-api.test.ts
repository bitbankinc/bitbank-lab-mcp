import { describe, expect, it } from 'vitest';
import { createMockFetcher, createUrlRouter, jsonResponse, mockBitbankSuccess } from './private-api.js';

describe('createMockFetcher', () => {
	it('レスポンス配列を順に返す', async () => {
		const fetcher = createMockFetcher([
			jsonResponse(mockBitbankSuccess({ a: 1 })),
			jsonResponse(mockBitbankSuccess({ b: 2 })),
		]);

		const r1 = await fetcher('https://api.test/first', { method: 'GET' });
		const r2 = await fetcher('https://api.test/second', { method: 'GET' });

		expect((await r1.json()).data.a).toBe(1);
		expect((await r2.json()).data.b).toBe(2);
		expect(fetcher.calls).toHaveLength(2);
	});

	it('レスポンス配列を超えて呼び出すとエラーを投げる', async () => {
		const fetcher = createMockFetcher([jsonResponse(mockBitbankSuccess({}))]);

		await fetcher('https://api.test/first', { method: 'GET' });

		await expect(fetcher('https://api.test/second', { method: 'GET' })).rejects.toThrow('Unexpected fetch call #2');
	});

	it('呼び出し情報を calls に記録する', async () => {
		const fetcher = createMockFetcher([jsonResponse({})]);
		await fetcher('https://api.test/path', { method: 'POST' });

		expect(fetcher.calls[0].url).toBe('https://api.test/path');
		expect(fetcher.calls[0].init.method).toBe('POST');
	});
});

describe('createUrlRouter', () => {
	it('URL パターンに一致するハンドラを呼ぶ', async () => {
		const fetcher = createUrlRouter({
			'/v1/user/assets': () => jsonResponse(mockBitbankSuccess({ assets: [] })),
			'/v1/user/orders': () => jsonResponse(mockBitbankSuccess({ orders: [] })),
		});

		const r = await fetcher('https://api.test/v1/user/assets', { method: 'GET' });
		const body = await r.json();
		expect(body.data.assets).toEqual([]);
	});

	it('一致するパターンがなく fallback がある場合は fallback を呼ぶ', async () => {
		const fetcher = createUrlRouter({ '/v1/user/assets': () => jsonResponse(mockBitbankSuccess({ assets: [] })) }, () =>
			jsonResponse({ fallback: true }),
		);

		const r = await fetcher('https://api.test/v1/unknown', { method: 'GET' });
		const body = await r.json();
		expect(body.fallback).toBe(true);
	});

	it('一致するパターンがなく fallback もない場合はエラーを投げる', async () => {
		const fetcher = createUrlRouter({
			'/v1/user/assets': () => jsonResponse(mockBitbankSuccess({})),
		});

		await expect(fetcher('https://api.test/v1/unknown', { method: 'GET' })).rejects.toThrow('No route matched');
	});

	it('呼び出し情報を calls に記録する', async () => {
		const fetcher = createUrlRouter({
			'/test': () => jsonResponse({}),
		});

		await fetcher('https://api.test/test', { method: 'PUT' });
		expect(fetcher.calls).toHaveLength(1);
		expect(fetcher.calls[0].url).toContain('/test');
		expect(fetcher.calls[0].init.method).toBe('PUT');
	});
});
