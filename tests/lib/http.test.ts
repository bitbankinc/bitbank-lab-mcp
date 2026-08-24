import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	BITBANK_API_BASE,
	DEFAULT_RETRIES,
	extractRateLimit,
	fetchJson,
	fetchJsonWithRateLimit,
	HttpStatusError,
	isRetriableHttpStatus,
	retryAsync,
	retryBackoffMs,
} from '../../lib/http.js';

describe('定数', () => {
	it('BITBANK_API_BASE が正しい', () => {
		expect(BITBANK_API_BASE).toBe('https://public.bitbank.cc');
	});
	it('DEFAULT_RETRIES が 2', () => {
		expect(DEFAULT_RETRIES).toBe(2);
	});
});

describe('fetchJson', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('成功レスポンスを JSON としてパースする', async () => {
		const mockData = { success: 1, data: { price: 15000000 } };
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockData),
		});

		const result = await fetchJson('https://example.com/api');
		expect(result).toEqual(mockData);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('HTTP エラーで例外を投げる', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
			statusText: 'Internal Server Error',
		});

		await expect(fetchJson('https://example.com/api', { retries: 0 })).rejects.toThrow('HTTP 500');
	});

	it('リトライ後に成功する', async () => {
		let callCount = 0;
		globalThis.fetch = vi.fn().mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				return Promise.reject(new Error('network error'));
			}
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve({ ok: true }),
			});
		});

		const result = await fetchJson('https://example.com/api', { retries: 1 });
		expect(result).toEqual({ ok: true });
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});

	it('全リトライ失敗で最後のエラーを投げる', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error('persistent error'));

		await expect(fetchJson('https://example.com/api', { retries: 1 })).rejects.toThrow('persistent error');
		expect(globalThis.fetch).toHaveBeenCalledTimes(2); // 初回 + 1リトライ
	});

	it('schema 指定時にレスポンスをバリデーションする', async () => {
		const mockData = { success: 1, value: 42 };
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(mockData),
		});
		const schema = { parse: (d: unknown) => d as typeof mockData };
		const result = await fetchJson('https://example.com/api', { schema });
		expect(result).toEqual(mockData);
	});

	it('schema バリデーション失敗時にエラーを投げる', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ bad: 'data' }),
		});
		const schema = {
			parse: () => {
				throw new Error('validation failed');
			},
		};
		await expect(fetchJson('https://example.com/api', { retries: 0, schema })).rejects.toThrow('validation failed');
	});

	it('AbortError（タイムアウト）で例外を投げる', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));

		await expect(fetchJson('https://example.com/api', { retries: 0, timeoutMs: 1 })).rejects.toThrow(
			'The operation was aborted.',
		);
	});
});

describe('extractRateLimit', () => {
	it('ヘッダから RateLimitInfo を抽出する', () => {
		const headers = new Headers({
			'X-RateLimit-Remaining': '99',
			'X-RateLimit-Limit': '100',
			'X-RateLimit-Reset': '1700000000',
		});
		const info = extractRateLimit(headers);
		expect(info).toEqual({ remaining: 99, limit: 100, reset: 1700000000 });
	});

	it('ヘッダが null/undefined なら null を返す', () => {
		expect(extractRateLimit(null)).toBeNull();
		expect(extractRateLimit(undefined)).toBeNull();
	});

	it('必要なヘッダが欠損している場合 null を返す', () => {
		const headers = new Headers({ 'X-RateLimit-Remaining': '99' });
		expect(extractRateLimit(headers)).toBeNull();
	});

	it('ヘッダ値が数値でない場合 null を返す', () => {
		const headers = new Headers({
			'X-RateLimit-Remaining': 'abc',
			'X-RateLimit-Limit': '100',
			'X-RateLimit-Reset': '1700000000',
		});
		expect(extractRateLimit(headers)).toBeNull();
	});
});

describe('fetchJsonWithRateLimit', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('JSON データとレートリミット情報を返す', async () => {
		const mockData = { success: 1 };
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(mockData), {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'X-RateLimit-Remaining': '50',
					'X-RateLimit-Limit': '100',
					'X-RateLimit-Reset': '1700000000',
				},
			}),
		);

		const result = await fetchJsonWithRateLimit('https://example.com/api');
		expect(result.data).toEqual(mockData);
		expect(result.rateLimit).toEqual({ remaining: 50, limit: 100, reset: 1700000000 });
	});

	it('レートリミットヘッダが無い場合 rateLimit が null', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const result = await fetchJsonWithRateLimit('https://example.com/api');
		expect(result.data).toEqual({ ok: true });
		expect(result.rateLimit).toBeNull();
	});

	it('HTTP エラーでリトライ後に例外を投げる', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 503, statusText: 'Service Unavailable' }));

		await expect(fetchJsonWithRateLimit('https://example.com/api', { retries: 0 })).rejects.toThrow('HTTP 503');
	});

	it('schema 指定時にレスポンスをバリデーションする', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ val: 1 }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		const schema = { parse: (d: unknown) => ({ ...(d as Record<string, unknown>), parsed: true }) };

		const result = await fetchJsonWithRateLimit('https://example.com/api', { schema });
		expect(result.data).toEqual({ val: 1, parsed: true });
	});

	it('リトライ後に成功する', async () => {
		let callCount = 0;
		globalThis.fetch = vi.fn().mockImplementation(() => {
			callCount++;
			if (callCount === 1) return Promise.reject(new Error('network error'));
			return Promise.resolve(
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
			);
		});

		const result = await fetchJsonWithRateLimit('https://example.com/api', { retries: 1 });
		expect(result.data).toEqual({ ok: true });
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
	});
});

/**
 * 429 のリトライは `fetchFlowDatePrices` の年 chunk 取得（#81）が土台にしている挙動なので、
 * 「`Retry-After` の秒数を待ってから再試行する」ことをここで固定する。
 * 上位レイヤーは `Retry-After` を二重に解釈しない（待つのは HTTP レイヤーだけ）。
 */
describe('fetchJsonWithRateLimit — 429 と Retry-After', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('Retry-After の秒数だけ待ってから再試行する', async () => {
		vi.useFakeTimers();
		const okResponse = () =>
			new Response(JSON.stringify({ success: 1 }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '5' } }))
			.mockResolvedValue(okResponse());

		const pending = fetchJsonWithRateLimit('https://example.com/api', { retries: 1 });

		// 指定の 5 秒が経つまでは次のリクエストを出さない
		await vi.advanceTimersByTimeAsync(4_000);
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1_000);
		await expect(pending).resolves.toEqual({ data: { success: 1 }, rateLimit: null });
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it('リトライを使い切った 429 はレート制限のエラーになる', async () => {
		vi.useFakeTimers();
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 429 }));

		const pending = fetchJsonWithRateLimit('https://example.com/api', { retries: 1 });
		const assertion = expect(pending).rejects.toThrow('レート制限超過');
		await vi.runAllTimersAsync();
		await assertion;
	});
});

/**
 * `retryAsync` — **戻り値で失敗を表す**処理（`Result` を返すツール呼び出し等）のリトライ。
 *
 * HTTP 1 本のリトライは `fetchJson` 系が担当するが、「ツール呼び出し 1 回」の単位で
 * やり直したい層（`fetchFlowDatePrices` の年 chunk 取得 = #81）は戻り値で失敗を受け取るため
 * そちらでは救えない。待機スケジュールを各所で書き起こさないための共通実装。
 */
describe('retryAsync', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/** 保留中の retryAsync を fake timer で最後まで進める */
	async function drain<T>(pending: Promise<T>): Promise<T> {
		await vi.runAllTimersAsync();
		return pending;
	}

	it('shouldRetry が false なら 1 回で返す（余分な実行をしない）', async () => {
		const op = vi.fn().mockResolvedValue('ok');

		await expect(retryAsync(op, { shouldRetry: () => false })).resolves.toBe('ok');
		expect(op).toHaveBeenCalledTimes(1);
	});

	it('shouldRetry が true の間は再試行し、成功した時点で値を返す', async () => {
		vi.useFakeTimers();
		const op = vi.fn().mockResolvedValueOnce('fail').mockResolvedValue('ok');

		await expect(drain(retryAsync(op, { retries: 2, shouldRetry: (v) => v === 'fail' }))).resolves.toBe('ok');
		expect(op).toHaveBeenCalledTimes(2);
	});

	it('リトライを使い切ったら最後の値をそのまま返す（throw しない）', async () => {
		vi.useFakeTimers();
		const op = vi.fn().mockResolvedValue('fail');

		await expect(drain(retryAsync(op, { retries: 2, shouldRetry: () => true }))).resolves.toBe('fail');
		// 初回 + リトライ 2 回
		expect(op).toHaveBeenCalledTimes(3);
	});

	it('throw は一時的な失敗として再試行し、次で成功すれば値を返す', async () => {
		vi.useFakeTimers();
		const op = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('ok');

		await expect(drain(retryAsync(op, { retries: 2, shouldRetry: () => false }))).resolves.toBe('ok');
		expect(op).toHaveBeenCalledTimes(2);
	});

	it('throw のままリトライを使い切ったら最後の例外を投げる', async () => {
		vi.useFakeTimers();
		const op = vi.fn().mockRejectedValueOnce(new Error('first')).mockRejectedValue(new Error('last'));

		const pending = retryAsync(op, { retries: 1, shouldRetry: () => false });
		const assertion = expect(pending).rejects.toThrow('last');
		await vi.runAllTimersAsync();
		await assertion;
		expect(op).toHaveBeenCalledTimes(2);
	});

	it('retries: 0 なら再試行しない', async () => {
		const op = vi.fn().mockResolvedValue('fail');

		await expect(retryAsync(op, { retries: 0, shouldRetry: () => true })).resolves.toBe('fail');
		expect(op).toHaveBeenCalledTimes(1);
	});

	it('retries 未指定なら DEFAULT_RETRIES 回まで再試行する', async () => {
		vi.useFakeTimers();
		const op = vi.fn().mockResolvedValue('fail');

		await drain(retryAsync(op, { shouldRetry: () => true }));
		expect(op).toHaveBeenCalledTimes(DEFAULT_RETRIES + 1);
	});

	it('throw のあとに値の失敗が続いても最後の値を返す（例外を引きずらない）', async () => {
		vi.useFakeTimers();
		const op = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('fail');

		await expect(drain(retryAsync(op, { retries: 2, shouldRetry: () => true }))).resolves.toBe('fail');
		expect(op).toHaveBeenCalledTimes(3);
	});
});

describe('retryBackoffMs', () => {
	it('試行ごとに倍のバックオフを返す', () => {
		expect(retryBackoffMs(0)).toBe(200);
		expect(retryBackoffMs(1)).toBe(400);
		expect(retryBackoffMs(2)).toBe(800);
	});

	it('待機時間の上限（30秒）でキャップする', () => {
		expect(retryBackoffMs(100)).toBe(30_000);
	});
});

/**
 * 恒久的な HTTP 失敗（404 等）をリトライ対象から外す（#84）。
 *
 * bitbank `/candlestick` は上場前・未来の期間キーに 404 を返す。同じ URL を叩き直しても
 * 永久に 404 なので、リトライは待ち時間とレート制限枠を捨てるだけで、
 * **同時に走っている他 chunk の成功率まで下げる**。
 */
describe('HTTP ステータス由来のリトライ判定（#84）', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('isRetriableHttpStatus', () => {
		it('4xx はリトライしない（408 / 429 を除く）', () => {
			expect(isRetriableHttpStatus(400)).toBe(false);
			expect(isRetriableHttpStatus(404)).toBe(false);
			expect(isRetriableHttpStatus(403)).toBe(false);
			expect(isRetriableHttpStatus(499)).toBe(false);
		});

		it('5xx / 408 / 429 はリトライする', () => {
			expect(isRetriableHttpStatus(500)).toBe(true);
			expect(isRetriableHttpStatus(503)).toBe(true);
			expect(isRetriableHttpStatus(408)).toBe(true);
			expect(isRetriableHttpStatus(429)).toBe(true);
		});
	});

	describe('HttpStatusError', () => {
		it('メッセージは従来の `HTTP <status> <statusText>` 形式のまま（404 の正規表現判定が依存している）', () => {
			const err = new HttpStatusError(404, 'Not Found');
			expect(err.message).toBe('HTTP 404 Not Found');
			expect(err.status).toBe(404);
			expect(err).toBeInstanceOf(Error);
		});
	});

	for (const [label, fn] of [
		['fetchJson', fetchJson],
		['fetchJsonWithRateLimit', fetchJsonWithRateLimit],
	] as Array<[string, (url: string, o?: { retries?: number }) => Promise<unknown>]>) {
		describe(label, () => {
			it('404 は 1 回で諦める（リトライしない）', async () => {
				const fetchMock = vi
					.fn()
					.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found', headers: { get: () => null } });
				globalThis.fetch = fetchMock as unknown as typeof fetch;

				await expect(fn('https://example.com/api', { retries: 2 })).rejects.toThrow('HTTP 404');
				expect(fetchMock).toHaveBeenCalledTimes(1);
			});

			it('5xx は従来どおり初回 + retries 回まで試す', async () => {
				vi.useFakeTimers();
				const fetchMock = vi.fn().mockResolvedValue({
					ok: false,
					status: 503,
					statusText: 'Service Unavailable',
					headers: { get: () => null },
				});
				globalThis.fetch = fetchMock as unknown as typeof fetch;

				const pending = fn('https://example.com/api', { retries: 2 });
				const assertion = expect(pending).rejects.toThrow('HTTP 503');
				await vi.runAllTimersAsync();
				await assertion;
				expect(fetchMock).toHaveBeenCalledTimes(3);
			});
		});
	}
});
