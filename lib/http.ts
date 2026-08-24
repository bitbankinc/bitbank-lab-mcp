/** bitbank Public API ベースURL */
export const BITBANK_API_BASE = 'https://public.bitbank.cc';

/** fetchJson のデフォルトリトライ回数（初回 + N回） */
export const DEFAULT_RETRIES = 2;

/** レートリミット情報（レスポンスヘッダから抽出） */
export interface RateLimitInfo {
	/** 残りリクエスト数 */
	remaining: number;
	/** 期間あたりの上限数 */
	limit: number;
	/** リセット時刻（Unix epoch 秒） */
	reset: number;
}

/**
 * レスポンスヘッダからレートリミット情報を抽出する。
 * ヘッダが存在しない場合は null を返す。
 */
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
	/** Zod スキーマ等の parse 互換オブジェクト。指定時はレスポンスをランタイム検証する。 */
	schema?: { parse: (data: unknown) => unknown };
}

/** リトライ待機の上限（30秒） */
const MAX_RETRY_WAIT_MS = 30_000;

/**
 * HTTP ステータス由来の失敗。**リトライしてよいかを呼び出し側が判定できる**ようにするため、
 * ステータスコードを保持する（`message` は従来どおり `HTTP <status> <statusText>`。
 * `get_candles` 等が本文の `404` を正規表現で拾っているので文言は変えない）。
 */
export class HttpStatusError extends Error {
	readonly status: number;

	constructor(status: number, statusText: string) {
		super(`HTTP ${status} ${statusText}`);
		this.name = 'HttpStatusError';
		this.status = status;
	}
}

/**
 * この HTTP ステータスをもう一度叩く価値があるか。
 *
 * 4xx は上流の「その資源は無い / 要求が不正」の表明で、**同じ URL を叩き直しても永久に同じ結果**
 * になる。bitbank `/candlestick` は上場前・未来の期間キーに 404 を返すため
 * （`docs/internal/bitbank-candle-tz.md`）、ここをリトライすると上場前の 1 chunk につき
 * リクエストが 3 倍になり、レート制限を自分で誘発して**他の chunk の成功率を下げる**（#84）。
 *
 * 例外は 2 つだけ:
 * - 408 Request Timeout: 一時的な遅延なので再試行の価値がある
 * - 429 Too Many Requests: `Retry-After` を解釈する専用経路で扱う（ここには到達しない）
 */
export function isRetriableHttpStatus(status: number): boolean {
	if (status === 408 || status === 429) return true;
	return status < 400 || status >= 500;
}

/** 汎用リトライの待機ベース（ms）。試行回数 i に対して BASE * 2^i を待つ */
const RETRY_BACKOFF_BASE_MS = 200;

/**
 * i 回目（0 始まり）の試行が失敗したあとの待機ミリ秒。
 * bitbank API へのリトライ待機はすべてこの 1 か所に揃える（呼び出し側で式を書き起こさない）。
 */
export function retryBackoffMs(attemptIndex: number): number {
	return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** attemptIndex, MAX_RETRY_WAIT_MS);
}

export interface RetryAsyncOptions<T> {
	/** 再試行回数（初回 + N 回）。既定は `DEFAULT_RETRIES` */
	retries?: number;
	/**
	 * 戻り値を見て「もう一度やる価値があるか」を判定する。
	 * 恒久的な失敗（何度叩いても同じ結果になるもの）で `true` を返すと無駄な負荷になるため、
	 * **一時的な失敗だけ** `true` を返すこと。
	 */
	shouldRetry: (value: T) => boolean;
}

/**
 * `Result` のように**戻り値で失敗を表す**非同期処理をリトライする汎用ヘルパー。
 *
 * `fetchJson` / `fetchJsonWithRateLimit` は HTTP 1 本のリトライを担当するが、
 * 「ツール呼び出し 1 回（＝複数 chunk の取得と成否判定）」の単位でやり直したい層
 * （例: `fetchFlowDatePrices` の年 chunk 取得）は戻り値で失敗を受け取るため、そちらでは使えない。
 * 待機スケジュールを各所で書き起こさないよう `retryBackoffMs` を共有する。
 *
 * semantics:
 * - `operation` が throw した場合は一時的な失敗とみなして再試行し、
 *   使い切ったら最後の例外をそのまま再 throw する（`fetchJson` と同じ）
 * - `operation` が値を返し `shouldRetry(value)` が `true` なら再試行し、
 *   使い切ったら**最後の値をそのまま返す**（失敗の分類は呼び出し側の責務）
 *
 * 注意: `Retry-After` の解釈は HTTP レイヤ（`fetchJsonWithRateLimit`）が担当する。
 * 本ヘルパーはその外側でもう一度試すだけで、ヘッダを二重に解釈しない。
 */
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

/**
 * Retry-After ヘッダから待機ミリ秒を算出する。
 * 未指定・不正値の場合はフォールバック値を返す。いずれも MAX_RETRY_WAIT_MS でキャップ。
 */
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
			// 恒久的な HTTP 失敗（404 等）はリトライしない。何度叩いても同じ結果で、
			// 待ち時間とレート制限枠だけを消費する（#84）。
			if (e instanceof HttpStatusError && !isRetriableHttpStatus(e.status)) break;
			if (i < retries) await new Promise((r) => setTimeout(r, retryBackoffMs(i)));
		}
	}
	throw lastErr;
}

/** fetchJson の戻り値 + レートリミット情報 */
export interface FetchJsonResult<T> {
	data: T;
	rateLimit: RateLimitInfo | null;
}

/**
 * fetchJson と同等だが、レスポンスヘッダからレートリミット情報も抽出して返す。
 * ヘッダが存在しない場合は rateLimit: null。
 */
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
			// 恒久的な HTTP 失敗（404 等）はリトライしない。何度叩いても同じ結果で、
			// 待ち時間とレート制限枠だけを消費する（#84）。
			if (e instanceof HttpStatusError && !isRetriableHttpStatus(e.status)) break;
			if (i < retries) await new Promise((r) => setTimeout(r, retryBackoffMs(i)));
		}
	}
	throw lastErr;
}
