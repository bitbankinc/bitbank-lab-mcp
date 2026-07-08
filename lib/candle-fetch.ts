/**
 * /candlestick エンドポイントの chunk fetcher と merge ロジック。
 *
 * - `fetchCandleChunk` は単一 chunk（年単位 YYYY / 日単位 YYYYMMDD）の取得。
 *   通信エラーは throw せず result.error にラップ、success:0 は UpstreamApiError として記録する。
 * - `mergeChunks` は複数 chunk を並列 / バッチ並列で取得し、timestamp 昇順でマージする。
 *   失敗ハンドリング（full / majority / partial）は呼び出し側に委ねる — 集計に必要な情報を返す。
 */

import { BITBANK_API_BASE, DEFAULT_RETRIES, fetchJsonWithRateLimit, type RateLimitInfo } from './http.js';

/** /candlestick エンドポイントが返す 1 行（[open, high, low, close, volume, timestamp]） */
export type OhlcvRow = [unknown, unknown, unknown, unknown, unknown, unknown];

/** chunk fetcher が返す結果 */
export interface FetchChunkResult {
	rows: OhlcvRow[];
	rateLimit: RateLimitInfo | null;
	error?: unknown;
}

/**
 * chunk fetcher が success:0 を検出したときに記録するエラー。
 * 全チャンク失敗時に network ではなく upstream として明示分類するため
 * instanceof で判定する。
 */
export class UpstreamApiError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UpstreamApiError';
	}
}

/**
 * /candlestick エンドポイントのレスポンス body を OHLCV 行に正規化する。
 * - success !== 1 → UpstreamApiError をエラーとして埋め込んで返す（空 rows）
 * - success === 1 → ohlcv 配列を返す（存在しなければ空）
 *
 * 純粋関数で fetch をモックせず単独でテスト可能。
 */
export function parseCandleChunk(json: unknown, rateLimit: RateLimitInfo | null): FetchChunkResult {
	const jsonObj = json as {
		success?: number;
		data?: { candlestick?: Array<{ ohlcv?: unknown[] }>; code?: number };
	};
	if (jsonObj?.success !== 1) {
		const code = jsonObj?.data?.code;
		const msg = code != null ? `bitbank API error (code: ${code})` : 'bitbank API error';
		return { rows: [], rateLimit, error: new UpstreamApiError(msg) };
	}
	const cs = jsonObj?.data?.candlestick?.[0];
	const ohlcvs = cs?.ohlcv ?? [];
	return { rows: ohlcvs as OhlcvRow[], rateLimit };
}

export interface FetchCandleChunkOptions {
	/** チャンク取得のタイムアウト (ms) */
	timeoutMs?: number;
	/** リトライ回数（初回 + N 回） */
	retries?: number;
}

/**
 * /candlestick の単一 chunk を取得する。
 *
 * @param pair  例: "btc_jpy"
 * @param type  例: "1day", "1hour"
 * @param key   年単位なら "2024"、日単位なら "20240101"
 *
 * 戻り値の semantics:
 * - 成功: rows に OHLCV 行
 * - success:0: rows=[], error=UpstreamApiError（呼び出し側で全 chunk 失敗時に upstream 分類）
 * - 通信エラー / 例外: rows=[], error=原因となった例外（throw しない）
 */
export async function fetchCandleChunk(
	pair: string,
	type: string,
	key: string,
	options: FetchCandleChunkOptions = {},
): Promise<FetchChunkResult> {
	const url = `${BITBANK_API_BASE}/${pair}/candlestick/${type}/${key}`;
	try {
		const { data: json, rateLimit } = await fetchJsonWithRateLimit(url, {
			timeoutMs: options.timeoutMs,
			retries: options.retries ?? DEFAULT_RETRIES,
		});
		return parseCandleChunk(json, rateLimit);
	} catch (e) {
		return { rows: [], rateLimit: null, error: e };
	}
}

export interface MergeChunksOptions {
	/**
	 * 指定時はバッチ並列で取得する（bitbank API レート制限対策）。
	 *   - concurrency: バッチ内の最大同時リクエスト数
	 *   - batchDelayMs: バッチ間に挟む遅延（先頭バッチ前は挟まない）
	 * 未指定なら全 chunk を `Promise.all` で一括並列実行する。
	 */
	batched?: { concurrency: number; batchDelayMs: number };
}

export interface MergedChunkResult {
	/** 全 chunk の OHLCV を timestamp 昇順でマージ・ソートした結果 */
	rows: OhlcvRow[];
	/** keys と同じ順序の per-chunk 結果 */
	results: FetchChunkResult[];
	/** 最後に得た非 null の rateLimit（last-wins） */
	lastRateLimit: RateLimitInfo | null;
	/** 失敗した chunk の key 一覧（keys の元順序を保つ） */
	failedKeys: string[];
}

/**
 * 複数 chunk を fetcher に流して結果をマージする。
 *
 * - 取得失敗（full / majority / partial）の判定は呼び出し側に委ねる。
 *   そのため `results` と `failedKeys` を返すが、自前で fail を生成しない。
 * - `rows` は timestamp 昇順でソート済み。
 *
 * @param keys     各 chunk の URL 末尾要素（年/日）
 * @param fetcher  key を受け取って FetchChunkResult を返す関数
 */
export async function mergeChunks(
	keys: string[],
	fetcher: (key: string) => Promise<FetchChunkResult>,
	options: MergeChunksOptions = {},
): Promise<MergedChunkResult> {
	let results: FetchChunkResult[];
	if (options.batched) {
		const { concurrency, batchDelayMs } = options.batched;
		results = [];
		for (let i = 0; i < keys.length; i += concurrency) {
			if (i > 0) {
				// バッチ間の遅延（先頭バッチ前は挟まない。bitbank API レート制限対策）
				await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
			}
			const batch = keys.slice(i, i + concurrency);
			const batchResults = await Promise.all(batch.map(fetcher));
			results.push(...batchResults);
		}
	} else {
		results = await Promise.all(keys.map(fetcher));
	}

	let lastRateLimit: RateLimitInfo | null = null;
	for (const r of results) {
		if (r.rateLimit) lastRateLimit = r.rateLimit;
	}

	const rows: OhlcvRow[] = [];
	for (const r of results) {
		rows.push(...r.rows);
	}

	// timestamp (index 5) 昇順でソート。Number 変換失敗時は 0 にフォールバック。
	rows.sort((a, b) => (Number(a[5]) || 0) - (Number(b[5]) || 0));

	const failedKeys = keys.filter((_, i) => results[i].error != null);
	return { rows, results, lastRateLimit, failedKeys };
}

/**
 * 失敗した chunk を「key(エラー内容)」形式で列挙する（診断用メッセージ向け）。
 * 例: "20260708(HTTP 404 Not Found), 20260707(bitbank API error (code: 10000))"
 *
 * 「N日中M日失敗」だけではどの日付が何の理由で落ちたか判別できず調査不能になるため、
 * 過半数失敗 fail / 部分失敗 warning のメッセージには必ずこれを含めること。
 */
export function describeFailedChunks(
	keys: string[],
	results: FetchChunkResult[],
	onlyKeys?: ReadonlySet<string>,
): string {
	const parts: string[] = [];
	for (let i = 0; i < keys.length; i++) {
		const err = results[i]?.error;
		if (err == null) continue;
		if (onlyKeys && !onlyKeys.has(keys[i])) continue;
		const msg = err instanceof Error ? err.message : String(err);
		parts.push(`${keys[i]}(${msg})`);
	}
	return parts.join(', ');
}

function isOhlcAllZero(row: OhlcvRow): boolean {
	return Number(row[0]) === 0 && Number(row[1]) === 0 && Number(row[2]) === 0 && Number(row[3]) === 0;
}

/**
 * 同一 ts 内で curr を採用すべきかを判定する。
 * - a) 全 0 OHLC プレースホルダを除外
 * - b) volume が大きい行を優先
 * - c) タイなら後勝ち（配列上で後の行）
 */
function shouldPreferCurr(prev: OhlcvRow, curr: OhlcvRow): boolean {
	const prevAllZero = isOhlcAllZero(prev);
	const currAllZero = isOhlcAllZero(curr);
	if (prevAllZero && !currAllZero) return true;
	if (!prevAllZero && currAllZero) return false;
	const prevV = Number(prev[4]);
	const currV = Number(curr[4]);
	const prevVN = Number.isFinite(prevV) ? prevV : 0;
	const currVN = Number.isFinite(currV) ? currV : 0;
	if (currVN > prevVN) return true;
	if (currVN < prevVN) return false;
	return true;
}

/**
 * 同一 timestamp の重複行を排除する純関数。
 *
 * /candlestick レスポンスで観測される同一 ts 重複（一方は全 0 OHLC のプレースホルダ）を排除し、
 * インジケーター・パターン検出・バックテストへの副作用を防ぐ。
 *
 * 前提: 入力は timestamp 昇順ソート済み。
 *
 * 採用ルール（上から順に評価）:
 *   a) OHLC の全てが 0 ではない行を優先（全 0 プレースホルダ行を除外）
 *   b) 上記タイで残ったら volume が大きい行を優先
 *   c) さらにタイなら後勝ち（配列上で後の行を採用）
 *
 * timestamp が NaN/<=0 の行は dedupe 対象外で素通し（後段の row validation で upstream 分類される）。
 */
export function dedupeByTimestamp(rows: OhlcvRow[]): OhlcvRow[] {
	if (rows.length === 0) return [];
	const result: OhlcvRow[] = [];
	const tsToIndex = new Map<number, number>();
	for (const row of rows) {
		const ts = Number(row[5]);
		if (!Number.isFinite(ts) || ts <= 0) {
			result.push(row);
			continue;
		}
		const existingIdx = tsToIndex.get(ts);
		if (existingIdx === undefined) {
			tsToIndex.set(ts, result.length);
			result.push(row);
			continue;
		}
		if (shouldPreferCurr(result[existingIdx], row)) {
			result[existingIdx] = row;
		}
	}
	return result;
}
