// 接続先は https://api.bitbank.cc（public.bitbank.cc とは別）。差し替えは研究用の起動口（`lab/`）だけで、環境変数や設定からは変えられない（ADR-0008）。

import { extractRateLimit, type RateLimitInfo } from '../../lib/http.js';
import { getBitbankErrorMessage } from '../lib/bitbank-errors.js';
import { createGetAuthHeaders, createPostAuthHeaders } from './auth.js';

export type HttpFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface BitbankApiResponse<T = unknown> {
	success: number;
	data: T;
}

export class PrivateApiError extends Error {
	constructor(
		message: string,
		public readonly errorType: string,
		public readonly statusCode?: number,
		public readonly bitbankCode?: number,
	) {
		super(message);
		this.name = 'PrivateApiError';
	}
}

const AUTH_ERROR_CODES = new Set([20001, 20002, 20003, 20004, 20005]);
const RATE_LIMIT_CODES = new Set([10009]);
const MAINTENANCE_CODES = new Set([10007, 10008]);
const NOT_FOUND_CODES = new Set([50009]);

const DEFAULT_ORIGIN = 'https://api.bitbank.cc';

/** 差し替え先として許すホスト名（`URL#hostname` の正規化後の値と完全一致で比べる） */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost']);

const INVALID_ORIGIN_MESSAGE =
	'private API の接続先として受け付けるのは、ループバック（127.0.0.1 / [::1] / localhost）の ' +
	'http(s) origin だけです（例: http://127.0.0.1:14000）。パス・末尾の /・クエリ・userinfo は付けられません（ADR-0008）';

// 通らなければ throw し、既定の接続先へは戻さない（ADR-0008）。
// パスの接頭辞を受けないのは、GET の署名が「パス + クエリ」に対して作られるため（`auth.ts`）。接頭辞を付けると、署名したパスと実際に送るパスがずれる。
// エラーメッセージに入力値を載せない（userinfo に秘密が入っていても stderr やログに残さないため）。
function assertLoopbackOrigin(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(INVALID_ORIGIN_MESSAGE);
	}
	const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
	if (!isHttp || value !== url.origin || !LOOPBACK_HOSTNAMES.has(url.hostname)) {
		throw new Error(INVALID_ORIGIN_MESSAGE);
	}
	return url.origin;
}

export interface PrivateClientOptions {
	fetcher?: HttpFetcher;
	timeoutMs?: number;
	maxRetries?: number;
	/** 配布物の中からは渡さない。渡すのは `lab/` の起動口だけ（ADR-0008）。 */
	origin?: string;
}

export class BitbankPrivateClient {
	private readonly origin: string;
	// 既定の接続先では空で、要求は 1 文字も変わらない。
	// 差し替え先のリダイレクトには従わない（`redirect: 'error'`）。fetch は 307 / 308 で POST の本文も `ACCESS-*` ヘッダーも転送先へ送るので、ループバックに限った検査を差し替え先が外へ迂回させられる。
	private readonly overrideInit: RequestInit;
	private readonly fetcher: HttpFetcher;
	private readonly timeoutMs: number;
	private readonly maxRetries: number;

	lastRateLimit: RateLimitInfo | null = null;

	constructor(opts: PrivateClientOptions = {}) {
		// 既定に戻すのは「指定なし」のときだけ。空文字や null も検査に通して落とす。
		this.origin = opts.origin === undefined ? DEFAULT_ORIGIN : assertLoopbackOrigin(opts.origin);
		this.overrideInit = opts.origin === undefined ? {} : { redirect: 'error' };
		this.fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis);
		this.timeoutMs = opts.timeoutMs ?? 5000;
		this.maxRetries = opts.maxRetries ?? 2;
	}

	async get<T>(path: string, params?: Record<string, string>): Promise<T> {
		let fullPath = path;
		if (params) {
			const qs = new URLSearchParams(params).toString();
			if (qs) fullPath = `${path}?${qs}`;
		}

		const url = `${this.origin}${fullPath}`;
		const headers = createGetAuthHeaders(fullPath);

		return this.request<T>(url, {
			method: 'GET',
			headers: {
				...headers,
				'Content-Type': 'application/json',
			},
		});
	}

	/** 状態変化を伴う POST（注文発注・キャンセル等）は、リトライ時の二重注文を防ぐため全経路で自動リトライしない（`retries: 0`）。 */
	async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
		const url = `${this.origin}${path}`;
		const jsonBody = JSON.stringify(body);
		const headers = createPostAuthHeaders(jsonBody);

		return this.request<T>(
			url,
			{
				method: 'POST',
				headers: {
					...headers,
					'Content-Type': 'application/json',
				},
				body: jsonBody,
			},
			{ retries: 0 },
		);
	}

	private async request<T>(url: string, init: RequestInit, opts: { retries?: number } = {}): Promise<T> {
		const maxRetries = opts.retries ?? this.maxRetries;
		let lastErr: unknown;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);

			try {
				const res = await this.fetcher(url, { ...init, ...this.overrideInit, signal: ctrl.signal });
				clearTimeout(timer);

				if (res.status === 429) {
					const retryAfter = res.headers.get('Retry-After');
					// 秒数として解釈できない場合は 1000ms フォールバック（NaN を setTimeout に渡すと 0ms 即リトライになる）
					const retryAfterSec = retryAfter ? parseInt(retryAfter, 10) : Number.NaN;
					const hasRetryAfterSec = Number.isFinite(retryAfterSec) && retryAfterSec >= 0;
					const waitMs = hasRetryAfterSec ? retryAfterSec * 1000 : 1000;
					if (attempt < maxRetries) {
						await new Promise((r) => setTimeout(r, waitMs));
						continue;
					}
					throw new PrivateApiError(
						`レート制限超過。${hasRetryAfterSec ? `${retryAfterSec}秒` : 'しばらく'}待ってから再試行してください`,
						'rate_limit_error',
						429,
					);
				}

				if (res.status >= 500) {
					if (attempt < maxRetries) {
						await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
						continue;
					}
					throw new PrivateApiError(
						`bitbank サーバーエラー (HTTP ${res.status})。一時的な障害の可能性があります`,
						'upstream_error',
						res.status,
					);
				}

				const body = await res.text().catch(() => '');

				if (!res.ok) {
					const errorCode = this.extractErrorCode(body);
					throw this.classifyBitbankError(res.status, errorCode);
				}

				let json: BitbankApiResponse<T>;
				try {
					json = JSON.parse(body) as BitbankApiResponse<T>;
				} catch {
					throw new PrivateApiError('レスポンスの JSON パースに失敗しました', 'upstream_error');
				}

				this.lastRateLimit = extractRateLimit(res.headers);

				// success: 0 の場合（HTTP 200 でもエラー）
				if (json.success !== 1) {
					const errorCode = (json.data as Record<string, unknown>)?.code as number | undefined;

					if (errorCode != null && RATE_LIMIT_CODES.has(errorCode)) {
						if (attempt < maxRetries) {
							await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
							continue;
						}
					}

					throw this.classifyBitbankError(200, errorCode ?? null);
				}

				return json.data;
			} catch (err) {
				clearTimeout(timer);
				if (err instanceof PrivateApiError) throw err;

				if (err instanceof Error && err.name === 'AbortError') {
					lastErr = new PrivateApiError(`タイムアウト (${this.timeoutMs}ms)`, 'upstream_error');
				} else {
					lastErr = err;
				}

				if (attempt < maxRetries) {
					await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
				}
			}
		}

		if (lastErr instanceof PrivateApiError) throw lastErr;
		throw new PrivateApiError(lastErr instanceof Error ? lastErr.message : 'ネットワークエラー', 'upstream_error');
	}

	private extractErrorCode(body: string): number | null {
		try {
			const parsed = JSON.parse(body);
			return parsed?.data?.code ?? null;
		} catch {
			return null;
		}
	}

	private classifyBitbankError(httpStatus: number, errorCode: number | null): PrivateApiError {
		if (errorCode != null && AUTH_ERROR_CODES.has(errorCode)) {
			const details: Record<number, string> = {
				20001: 'API 認証に失敗しました',
				20002: 'API キーが無効です',
				20003: 'API キーが見つかりません',
				20004: 'ACCESS-NONCE / ACCESS-REQUEST-TIME が未指定です',
				20005: '署名が無効です。API シークレットを確認してください',
			};
			return new PrivateApiError(details[errorCode] ?? 'API 認証エラー', 'authentication_error', httpStatus, errorCode);
		}

		if (errorCode != null && RATE_LIMIT_CODES.has(errorCode)) {
			return new PrivateApiError(
				'リクエスト頻度が高すぎます。しばらく待ってから再試行してください',
				'rate_limit_error',
				httpStatus,
				errorCode,
			);
		}

		if (errorCode != null && MAINTENANCE_CODES.has(errorCode)) {
			return new PrivateApiError(
				errorCode === 10007
					? 'bitbank はメンテナンス中です'
					: 'bitbank サーバーが過負荷状態です。しばらく待ってから再試行してください',
				'upstream_error',
				httpStatus,
				errorCode,
			);
		}

		if (httpStatus === 401 || httpStatus === 403) {
			return new PrivateApiError(
				'API キーまたは署名が不正です。bitbank 管理画面でキーを確認してください',
				'authentication_error',
				httpStatus,
				errorCode ?? undefined,
			);
		}

		if (errorCode != null) {
			const libMessage = getBitbankErrorMessage(errorCode);
			if (NOT_FOUND_CODES.has(errorCode)) {
				return new PrivateApiError(
					libMessage ?? '指定されたデータが見つかりません',
					'not_found',
					httpStatus,
					errorCode,
				);
			}
			// パラメータ系（30000番台=必須不足 / 40000番台=不正）
			if (errorCode >= 30000 && errorCode < 50000) {
				return new PrivateApiError(
					libMessage ?? 'リクエストパラメータが不正です',
					'validation_error',
					httpStatus,
					errorCode,
				);
			}
			if (libMessage) {
				return new PrivateApiError(libMessage, 'upstream_error', httpStatus, errorCode);
			}
		}

		return new PrivateApiError(
			`bitbank API エラー (HTTP ${httpStatus}${errorCode ? `, code: ${errorCode}` : ''})`,
			'upstream_error',
			httpStatus,
			errorCode ?? undefined,
		);
	}
}

let defaultClient: BitbankPrivateClient | null = null;

export function getDefaultClient(): BitbankPrivateClient {
	if (!defaultClient) {
		defaultClient = new BitbankPrivateClient();
	}
	return defaultClient;
}

// 研究用の起動口（`lab/`）専用で、配布物の中からは呼ばない（ADR-0008。ガードは `tests/private-api-origin-tripwire.test.ts`）。
// 既に作られていたら throw するのは、同じプロセスの中で一部の要求は既定の接続先へ、残りは差し替え先へ、と送り先が途中で変わるのを防ぐため。
export function setDefaultClient(client: BitbankPrivateClient): void {
	if (defaultClient) {
		throw new Error(
			'既定の private API クライアントは既に初期化されています。差し替えはサーバー起動前に 1 回だけ行えます',
		);
	}
	defaultClient = client;
}
