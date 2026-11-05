import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BitbankPrivateClient, PrivateApiError } from '../../src/private/client.js';
import { createMockFetcher, jsonResponse, mockBitbankError, mockBitbankSuccess } from '../fixtures/private-api.js';
import { rejectionOf } from '../helpers/assert.js';

// auth.ts が環境変数を参照するため設定
beforeEach(() => {
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
});

afterEach(() => {
	delete process.env.BITBANK_API_KEY;
	delete process.env.BITBANK_API_SECRET;
});

describe('BitbankPrivateClient', () => {
	describe('GET リクエスト', () => {
		it('クエリパラメータ付き URL を正しく構築する', async () => {
			const fetcher = createMockFetcher([jsonResponse(mockBitbankSuccess({ items: [] }))]);
			const client = new BitbankPrivateClient({ fetcher, timeoutMs: 1000 });

			await client.get('/v1/user/assets', { pair: 'btc_jpy', count: '10' });

			expect(fetcher.calls).toHaveLength(1);
			const url = fetcher.calls[0].url;
			expect(url).toContain('/v1/user/assets?');
			expect(url).toContain('pair=btc_jpy');
			expect(url).toContain('count=10');
		});

		it('成功時にデータを返す', async () => {
			const data = { assets: [{ asset: 'btc' }] };
			const fetcher = createMockFetcher([jsonResponse(mockBitbankSuccess(data))]);
			const client = new BitbankPrivateClient({ fetcher, timeoutMs: 1000 });

			const result = await client.get<{ assets: Array<{ asset: string }> }>('/v1/user/assets');
			expect(result.assets[0].asset).toBe('btc');
		});

		it('パラメータなしの場合クエリ文字列を付けない', async () => {
			const fetcher = createMockFetcher([jsonResponse(mockBitbankSuccess({}))]);
			const client = new BitbankPrivateClient({ fetcher, timeoutMs: 1000 });

			await client.get('/v1/user/assets');

			expect(fetcher.calls[0].url).toBe('https://api.bitbank.cc/v1/user/assets');
		});
	});

	describe('POST リクエスト', () => {
		it('JSON body と Content-Type ヘッダーを送信する', async () => {
			const fetcher = createMockFetcher([jsonResponse(mockBitbankSuccess({ order_id: 1 }))]);
			const client = new BitbankPrivateClient({ fetcher, timeoutMs: 1000 });

			await client.post('/v1/user/spot/order', { pair: 'btc_jpy', side: 'buy' });

			expect(fetcher.calls).toHaveLength(1);
			const { init } = fetcher.calls[0];
			expect(init.method).toBe('POST');
			expect(init.body).toBe(JSON.stringify({ pair: 'btc_jpy', side: 'buy' }));
			const headers = init.headers as Record<string, string>;
			expect(headers['Content-Type']).toBe('application/json');
		});
	});

	describe('エラー分類', () => {
		it.each([
			[20001, 'authentication_error', 'API 認証に失敗しました'],
			[20002, 'authentication_error', 'API キーが無効です'],
			[20003, 'authentication_error', 'API キーが見つかりません'],
			[20004, 'authentication_error', 'ACCESS-NONCE / ACCESS-REQUEST-TIME が未指定です'],
			[20005, 'authentication_error', '署名が無効です'],
		])('エラーコード %d → %s', async (code, expectedType, expectedMessagePart) => {
			const fetcher = createMockFetcher([jsonResponse(mockBitbankError(code), 400)]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 0, timeoutMs: 1000 });

			const err = await rejectionOf(client.get('/v1/user/assets'));
			expect(err).toBeInstanceOf(PrivateApiError);
			const e = err as PrivateApiError;
			expect(e.errorType).toBe(expectedType);
			expect(e.message).toContain(expectedMessagePart);
		});

		it('エラーコード 10009 → rate_limit_error', async () => {
			const fetcher = createMockFetcher([jsonResponse(mockBitbankError(10009))]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 0, timeoutMs: 1000 });

			const err = await rejectionOf(client.get('/v1/user/assets'));
			expect(err).toBeInstanceOf(PrivateApiError);
			expect((err as PrivateApiError).errorType).toBe('rate_limit_error');
		});

		it('エラーコード 10007 → upstream_error (メンテナンス)', async () => {
			const fetcher = createMockFetcher([jsonResponse(mockBitbankError(10007))]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 0, timeoutMs: 1000 });

			const err = await rejectionOf(client.get('/v1/user/assets'));
			expect(err).toBeInstanceOf(PrivateApiError);
			const e = err as PrivateApiError;
			expect(e.errorType).toBe('upstream_error');
			expect(e.message).toContain('メンテナンス');
		});

		it('エラーコード 10008 → upstream_error (過負荷)', async () => {
			const fetcher = createMockFetcher([jsonResponse(mockBitbankError(10008))]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 0, timeoutMs: 1000 });

			const err = await rejectionOf(client.get('/v1/user/assets'));
			expect(err).toBeInstanceOf(PrivateApiError);
			const e = err as PrivateApiError;
			expect(e.errorType).toBe('upstream_error');
			expect(e.message).toContain('過負荷');
		});

		it('HTTP 401 (エラーコードなし) → authentication_error', async () => {
			const fetcher = createMockFetcher([new Response('Unauthorized', { status: 401 })]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 0, timeoutMs: 1000 });

			const err = await rejectionOf(client.get('/v1/user/assets'));
			expect(err).toBeInstanceOf(PrivateApiError);
			expect((err as PrivateApiError).errorType).toBe('authentication_error');
		});

		it('HTTP 403 (エラーコードなし) → authentication_error', async () => {
			const fetcher = createMockFetcher([new Response('Forbidden', { status: 403 })]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 0, timeoutMs: 1000 });

			const err = await rejectionOf(client.get('/v1/user/assets'));
			expect(err).toBeInstanceOf(PrivateApiError);
			expect((err as PrivateApiError).errorType).toBe('authentication_error');
		});

		it('エラーコード 50009 → not_found (注文・データなし)', async () => {
			const fetcher = createMockFetcher([jsonResponse(mockBitbankError(50009), 400)]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 0, timeoutMs: 1000 });

			const err = await rejectionOf(client.get('/v1/user/spot/order'));
			expect(err).toBeInstanceOf(PrivateApiError);
			const e = err as PrivateApiError;
			expect(e.errorType).toBe('not_found');
			expect(e.message).toContain('見つかりません');
			expect(e.bitbankCode).toBe(50009);
		});

		it('エラーコード 40000番台 → validation_error (パラメータ不正)', async () => {
			const fetcher = createMockFetcher([jsonResponse(mockBitbankError(40024), 400)]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 0, timeoutMs: 1000 });

			const err = await rejectionOf(client.get('/v1/user/assets'));
			expect(err).toBeInstanceOf(PrivateApiError);
			const e = err as PrivateApiError;
			expect(e.errorType).toBe('validation_error');
			expect(e.bitbankCode).toBe(40024);
		});

		it('エラーコード 60001 (残高不足) → upstream_error (スコープ外: 現状維持)', async () => {
			const fetcher = createMockFetcher([jsonResponse(mockBitbankError(60001), 400)]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 0, timeoutMs: 1000 });

			const err = await rejectionOf(client.get('/v1/user/assets'));
			expect(err).toBeInstanceOf(PrivateApiError);
			expect((err as PrivateApiError).errorType).toBe('upstream_error');
		});

		it('不明なエラーコード → upstream_error', async () => {
			const fetcher = createMockFetcher([jsonResponse(mockBitbankError(99999), 400)]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 0, timeoutMs: 1000 });

			const err = await rejectionOf(client.get('/v1/user/assets'));
			expect(err).toBeInstanceOf(PrivateApiError);
			expect((err as PrivateApiError).errorType).toBe('upstream_error');
		});
	});

	describe('リトライ', () => {
		it('HTTP 429 でリトライし Retry-After ヘッダーを尊重する', async () => {
			const fetcher = createMockFetcher([
				new Response('', { status: 429, headers: { 'Retry-After': '1' } }),
				jsonResponse(mockBitbankSuccess({ ok: true })),
			]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 1, timeoutMs: 5000 });

			const result = await client.get<{ ok: boolean }>('/v1/user/assets');
			expect(result.ok).toBe(true);
			expect(fetcher.calls).toHaveLength(2);
		});

		it('5xx で指数バックオフリトライする', async () => {
			const fetcher = createMockFetcher([
				new Response('', { status: 500 }),
				jsonResponse(mockBitbankSuccess({ ok: true })),
			]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 1, timeoutMs: 5000 });

			const result = await client.get<{ ok: boolean }>('/v1/user/assets');
			expect(result.ok).toBe(true);
			expect(fetcher.calls).toHaveLength(2);
		});

		it('body レベルのレート制限 (code 10009) でリトライする', async () => {
			const fetcher = createMockFetcher([
				jsonResponse(mockBitbankError(10009)),
				jsonResponse(mockBitbankSuccess({ ok: true })),
			]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 1, timeoutMs: 5000 });

			const result = await client.get<{ ok: boolean }>('/v1/user/assets');
			expect(result.ok).toBe(true);
			expect(fetcher.calls).toHaveLength(2);
		});

		it('maxRetries 超過で 429 を throw する', async () => {
			const fetcher = createMockFetcher([
				new Response('', { status: 429, headers: { 'Retry-After': '0' } }),
				new Response('', { status: 429, headers: { 'Retry-After': '0' } }),
			]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 1, timeoutMs: 5000 });

			const err = await rejectionOf(client.get('/v1/user/assets'));
			expect(err).toBeInstanceOf(PrivateApiError);
			expect((err as PrivateApiError).errorType).toBe('rate_limit_error');
		});

		it('maxRetries 超過で 5xx を throw する', async () => {
			const fetcher = createMockFetcher([new Response('', { status: 500 }), new Response('', { status: 502 })]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 1, timeoutMs: 5000 });

			const err = await rejectionOf(client.get('/v1/user/assets'));
			expect(err).toBeInstanceOf(PrivateApiError);
			expect((err as PrivateApiError).errorType).toBe('upstream_error');
		});

		describe('429 Retry-After ヘッダーのパース', () => {
			afterEach(() => {
				vi.restoreAllMocks();
				vi.useRealTimers();
			});

			it("Retry-After: '2'（数値秒）→ 2000ms 待機してからリトライする", async () => {
				vi.useFakeTimers();
				const fetchSpy = vi
					.spyOn(globalThis, 'fetch')
					.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '2' } }))
					.mockResolvedValueOnce(jsonResponse(mockBitbankSuccess({ ok: true })));
				const client = new BitbankPrivateClient({ maxRetries: 1, timeoutMs: 5000 });

				const promise = client.get<{ ok: boolean }>('/v1/user/assets');

				// 1999ms 時点ではまだ待機中
				await vi.advanceTimersByTimeAsync(1999);
				expect(fetchSpy).toHaveBeenCalledTimes(1);
				// 2000ms 経過でリトライされる
				await vi.advanceTimersByTimeAsync(1);
				expect(await promise).toEqual({ ok: true });
				expect(fetchSpy).toHaveBeenCalledTimes(2);
			});

			it('Retry-After が HTTP-date 形式 → NaN にせず 1000ms フォールバックで待機してリトライする', async () => {
				vi.useFakeTimers();
				const fetchSpy = vi
					.spyOn(globalThis, 'fetch')
					.mockResolvedValueOnce(
						new Response('', { status: 429, headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' } }),
					)
					.mockResolvedValueOnce(jsonResponse(mockBitbankSuccess({ ok: true })));
				const client = new BitbankPrivateClient({ maxRetries: 1, timeoutMs: 5000 });

				const promise = client.get<{ ok: boolean }>('/v1/user/assets');

				// parseInt が NaN でも setTimeout(NaN) = 0ms の即リトライにならないこと。999ms 時点ではまだリトライされない
				await vi.advanceTimersByTimeAsync(999);
				expect(fetchSpy).toHaveBeenCalledTimes(1);
				// 1000ms 経過でリトライされる
				await vi.advanceTimersByTimeAsync(1);
				expect(await promise).toEqual({ ok: true });
				expect(fetchSpy).toHaveBeenCalledTimes(2);
			});

			it('Retry-After が負数 → 1000ms フォールバックで待機してリトライする', async () => {
				vi.useFakeTimers();
				const fetchSpy = vi
					.spyOn(globalThis, 'fetch')
					.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '-5' } }))
					.mockResolvedValueOnce(jsonResponse(mockBitbankSuccess({ ok: true })));
				const client = new BitbankPrivateClient({ maxRetries: 1, timeoutMs: 5000 });

				const promise = client.get<{ ok: boolean }>('/v1/user/assets');

				await vi.advanceTimersByTimeAsync(999);
				expect(fetchSpy).toHaveBeenCalledTimes(1);
				await vi.advanceTimersByTimeAsync(1);
				expect(await promise).toEqual({ ok: true });
				expect(fetchSpy).toHaveBeenCalledTimes(2);
			});

			it('Retry-After が HTTP-date 形式で maxRetries 超過 → メッセージに HTTP-date を「秒」として含めない', async () => {
				vi.spyOn(globalThis, 'fetch').mockResolvedValue(
					new Response('', { status: 429, headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' } }),
				);
				const client = new BitbankPrivateClient({ maxRetries: 0, timeoutMs: 5000 });

				const err = await rejectionOf(client.get('/v1/user/assets'));
				expect(err).toBeInstanceOf(PrivateApiError);
				const e = err as PrivateApiError;
				expect(e.errorType).toBe('rate_limit_error');
				expect(e.message).toContain('しばらく待ってから再試行');
				expect(e.message).not.toContain('GMT');
			});
		});

		it('ネットワークエラーでリトライする', async () => {
			let callCount = 0;
			const fetcher = (async () => {
				callCount++;
				if (callCount === 1) throw new TypeError('fetch failed');
				return jsonResponse(mockBitbankSuccess({ ok: true }));
			}) as unknown as typeof fetch;
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 1, timeoutMs: 5000 });

			const result = await client.get<{ ok: boolean }>('/v1/user/assets');
			expect(result.ok).toBe(true);
			expect(callCount).toBe(2);
		});
	});

	describe('POST 系リクエストの自動リトライ無効化', () => {
		// POST は二重発注を防ぐため全経路で自動リトライしない。GET は冪等なので maxRetries まで再試行する。
		it('5xx 時に POST は 1 回しか呼ばれない（maxRetries=2 設定でも）', async () => {
			const fetcher = createMockFetcher([
				new Response('', { status: 500 }),
				new Response('', { status: 500 }),
				new Response('', { status: 500 }),
			]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 2, timeoutMs: 5000 });

			const err = await rejectionOf(client.post('/v1/user/spot/order', { pair: 'btc_jpy' }));
			expect(err).toBeInstanceOf(PrivateApiError);
			expect((err as PrivateApiError).errorType).toBe('upstream_error');
			expect(fetcher.calls).toHaveLength(1);
		});

		it('タイムアウト時に POST は 1 回しか呼ばれない', async () => {
			let callCount = 0;
			const fetcher = (async (_url: string, init: RequestInit) => {
				callCount++;
				return new Promise<Response>((_resolve, reject) => {
					const signal = init.signal;
					if (signal) {
						signal.addEventListener('abort', () => {
							const err = new Error('The operation was aborted');
							err.name = 'AbortError';
							reject(err);
						});
					}
				});
			}) as unknown as typeof fetch;
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 2, timeoutMs: 50 });

			const err = await rejectionOf(client.post('/v1/user/spot/order', { pair: 'btc_jpy' }));
			expect(err).toBeInstanceOf(PrivateApiError);
			expect((err as PrivateApiError).message).toContain('タイムアウト');
			expect(callCount).toBe(1);
		});

		it('ネットワークエラー時に POST は 1 回しか呼ばれない', async () => {
			let callCount = 0;
			const fetcher = (async () => {
				callCount++;
				throw new TypeError('fetch failed');
			}) as unknown as typeof fetch;
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 2, timeoutMs: 5000 });

			const err = await rejectionOf(client.post('/v1/user/spot/order', { pair: 'btc_jpy' }));
			expect(err).toBeInstanceOf(PrivateApiError);
			expect((err as PrivateApiError).errorType).toBe('upstream_error');
			expect(callCount).toBe(1);
		});

		it('429 時にも POST は 1 回しか呼ばれない（rate_limit_error をそのまま throw）', async () => {
			const fetcher = createMockFetcher([new Response('', { status: 429, headers: { 'Retry-After': '0' } })]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 2, timeoutMs: 5000 });

			const err = await rejectionOf(client.post('/v1/user/spot/order', { pair: 'btc_jpy' }));
			expect(err).toBeInstanceOf(PrivateApiError);
			expect((err as PrivateApiError).errorType).toBe('rate_limit_error');
			expect(fetcher.calls).toHaveLength(1);
		});

		it('GET は 5xx で従来通りリトライされる（POST 専用の無効化であることを担保）', async () => {
			const fetcher = createMockFetcher([
				new Response('', { status: 500 }),
				new Response('', { status: 502 }),
				jsonResponse(mockBitbankSuccess({ ok: true })),
			]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 2, timeoutMs: 5000 });

			const result = await client.get<{ ok: boolean }>('/v1/user/assets');
			expect(result.ok).toBe(true);
			expect(fetcher.calls).toHaveLength(3);
		});
	});

	describe('タイムアウト', () => {
		it('timeoutMs 超過でエラーを投げる', async () => {
			const fetcher = (async (_url: string, init: RequestInit) => {
				return new Promise<Response>((_resolve, reject) => {
					const signal = init.signal;
					if (signal) {
						signal.addEventListener('abort', () => {
							const err = new Error('The operation was aborted');
							err.name = 'AbortError';
							reject(err);
						});
					}
				});
			}) as unknown as typeof fetch;
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 0, timeoutMs: 50 });

			const err = await rejectionOf(client.get('/v1/user/assets'));
			expect(err).toBeInstanceOf(PrivateApiError);
			expect((err as PrivateApiError).errorType).toBe('upstream_error');
			expect((err as PrivateApiError).message).toContain('タイムアウト');
		});
	});

	describe('レスポンスパース', () => {
		it('success: 0 + HTTP 200 でエラーを投げる', async () => {
			const fetcher = createMockFetcher([jsonResponse(mockBitbankError(30000))]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 0, timeoutMs: 1000 });

			const err = await rejectionOf(client.get('/v1/user/assets'));
			expect(err).toBeInstanceOf(PrivateApiError);
		});

		it('JSON パース失敗でエラーを投げる', async () => {
			const fetcher = createMockFetcher([new Response('not json', { status: 200 })]);
			const client = new BitbankPrivateClient({ fetcher, maxRetries: 0, timeoutMs: 1000 });

			const err = await rejectionOf(client.get('/v1/user/assets'));
			expect(err).toBeInstanceOf(PrivateApiError);
			expect((err as PrivateApiError).errorType).toBe('upstream_error');
			expect((err as PrivateApiError).message).toContain('JSON パース');
		});
	});
});
