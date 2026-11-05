export const BITBANK_API_BASE = 'https://public.bitbank.cc';

export const DEFAULT_RETRIES = 2;

export interface RateLimitInfo {
	remaining: number;
	limit: number;
	/** Unix epoch 秒。 */
	reset: number;
}

export function extractRateLimit(
	headers: { get(name: string): string | null } | undefined | null,
): RateLimitInfo | null {
	if (!headers || typeof headers.get !== 'function') return null;
	const remaining = headers.get('X-RateLimit-Remaining');
	const limit = headers.get('X-RateLimit-Limit');
	const reset = headers.get('X-RateLimit-Reset');
	if (remaining == null || limit == null || reset == null) return null;
	const r = parseInt(remaining, 10);
	const l = parseInt(limit, 10);
	const s = parseInt(reset, 10);
	if (Number.isNaN(r) || Number.isNaN(l) || Number.isNaN(s)) return null;
	return { remaining: r, limit: l, reset: s };
}

export interface FetchJsonOptions {
	timeoutMs?: number;
	retries?: number;
	schema?: { parse: (data: unknown) => unknown };
}

const MAX_RETRY_WAIT_MS = 30_000;

// message は HTTP <status> <statusText> のまま変えない（get_candles 等が本文の 404 を正規表現で拾っている）。
export class HttpStatusError extends Error {
	readonly status: number;

	constructor(status: number, statusText: string) {
		super(`HTTP ${status} ${statusText}`);
		this.name = 'HttpStatusError';
		this.status = status;
	}
}

// 4xx は叩き直しても同じ結果なのでリトライしない（上場前の chunk で枠を食い、他の chunk の成功率を下げる。#84）。例外は 408 と、専用経路で扱う 429。
export function isRetriableHttpStatus(status: number): boolean {
	if (status === 408 || status === 429) return true;
	return status < 400 || status >= 500;
}

const RETRY_BACKOFF_BASE_MS = 200;

// bitbank API へのリトライ待機はすべてここに揃える（呼び出し側で式を書き起こさない）。
export function retryBackoffMs(attemptIndex: number): number {
	return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** attemptIndex, MAX_RETRY_WAIT_MS);
}

export interface RetryAsyncOptions<T> {
	retries?: number;
	/** 一時的な失敗だけ true を返す（恒久的な失敗で true だと無駄な負荷になる）。 */
	shouldRetry: (value: T) => boolean;
}

// 戻り値で失敗を表す層のためのリトライ。Retry-After の解釈は HTTP レイヤが担当し、ここでは二重に解釈しない。
export async function retryAsync<T>(operation: () => Promise<T>, options: RetryAsyncOptions<T>): Promise<T> {
	const retries = options.retries ?? DEFAULT_RETRIES;
	let lastErr: unknown;
	let hasValue = false;
	let lastValue: T | undefined;
	for (let i = 0; i <= retries; i++) {
		try {
			const value = await operation();
			if (!options.shouldRetry(value)) return value;
			hasValue = true;
			lastValue = value;
			lastErr = undefined;
		} catch (e) {
			lastErr = e;
			hasValue = false;
		}
		if (i < retries) await new Promise((r) => setTimeout(r, retryBackoffMs(i)));
	}
	if (hasValue) return lastValue as T;
	throw lastErr;
}

function parseRetryAfterMs(headers: { get(name: string): string | null }, fallbackMs: number): number {
	const boundedFallbackMs = Math.min(fallbackMs, MAX_RETRY_WAIT_MS);
	const raw = headers.get('Retry-After');
	if (raw == null) return boundedFallbackMs;
	const secs = parseInt(raw, 10);
	if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, MAX_RETRY_WAIT_MS);
	return boundedFallbackMs;
}

export async function fetchJson<T = unknown>(
	url: string,
	{ timeoutMs = 2500, retries = DEFAULT_RETRIES, schema }: FetchJsonOptions = {},
): Promise<T> {
	let lastErr: unknown;
	for (let i = 0; i <= retries; i++) {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const res = await fetch(url, { signal: ctrl.signal });
			clearTimeout(t);
			if (res.status === 429) {
				const waitMs = parseRetryAfterMs(res.headers, 1000 * 2 ** i);
				if (i < retries) {
					await new Promise((r) => setTimeout(r, waitMs));
					continue;
				}
				throw new Error('レート制限超過 (HTTP 429)。しばらく待ってから再試行してください');
			}
			if (!res.ok) throw new HttpStatusError(res.status, res.statusText);
			const json: unknown = await res.json();
			if (schema) return schema.parse(json) as T;
			return json as T;
		} catch (e) {
			clearTimeout(t);
			lastErr = e;
			// 恒久的な HTTP 失敗（404 等）はリトライしない（#84）。
			if (e instanceof HttpStatusError && !isRetriableHttpStatus(e.status)) break;
			if (i < retries) await new Promise((r) => setTimeout(r, retryBackoffMs(i)));
		}
	}
	throw lastErr;
}

export interface FetchJsonResult<T> {
	data: T;
	rateLimit: RateLimitInfo | null;
}

export async function fetchJsonWithRateLimit<T = unknown>(
	url: string,
	{ timeoutMs = 2500, retries = DEFAULT_RETRIES, schema }: FetchJsonOptions = {},
): Promise<FetchJsonResult<T>> {
	let lastErr: unknown;
	for (let i = 0; i <= retries; i++) {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const res = await fetch(url, { signal: ctrl.signal });
			clearTimeout(t);
			if (res.status === 429) {
				const waitMs = parseRetryAfterMs(res.headers, 1000 * 2 ** i);
				if (i < retries) {
					await new Promise((r) => setTimeout(r, waitMs));
					continue;
				}
				throw new Error('レート制限超過 (HTTP 429)。しばらく待ってから再試行してください');
			}
			if (!res.ok) throw new HttpStatusError(res.status, res.statusText);
			const rateLimit = extractRateLimit(res.headers);
			const json: unknown = await res.json();
			const data = schema ? (schema.parse(json) as T) : (json as T);
			return { data, rateLimit };
		} catch (e) {
			clearTimeout(t);
			lastErr = e;
			if (e instanceof HttpStatusError && !isRetriableHttpStatus(e.status)) break;
			if (i < retries) await new Promise((r) => setTimeout(r, retryBackoffMs(i)));
		}
	}
	throw lastErr;
}
