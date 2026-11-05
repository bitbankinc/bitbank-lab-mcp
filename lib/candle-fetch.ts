// 失敗の扱い（full / majority / partial）は呼び出し側に委ねる。集計に必要な情報だけを返す。

import { BITBANK_API_BASE, DEFAULT_RETRIES, fetchJsonWithRateLimit, type RateLimitInfo } from './http.js';

/** /candlestick エンドポイントが返す 1 行（[open, high, low, close, volume, timestamp]） */
export type OhlcvRow = [unknown, unknown, unknown, unknown, unknown, unknown];

export interface FetchChunkResult {
	rows: OhlcvRow[];
	rateLimit: RateLimitInfo | null;
	error?: unknown;
}

/** 全 chunk 失敗時に network ではなく upstream に分類するため instanceof で判定する。 */
export class UpstreamApiError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UpstreamApiError';
	}
}

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
	timeoutMs?: number;
	retries?: number;
}

// throw しない。通信エラーも success:0 も rows=[] と error で返し、分類は呼び出し側で行う。
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
	batched?: { concurrency: number; batchDelayMs: number };
}

export interface MergedChunkResult {
	rows: OhlcvRow[];
	results: FetchChunkResult[];
	lastRateLimit: RateLimitInfo | null;
	failedKeys: string[];
}

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

	rows.sort((a, b) => (Number(a[5]) || 0) - (Number(b[5]) || 0));

	const failedKeys = keys.filter((_, i) => results[i].error != null);
	return { rows, results, lastRateLimit, failedKeys };
}

// どの日付が何の理由で落ちたか調査できるよう、過半数失敗 / 部分失敗のメッセージには必ずこれを含める。
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

// /candlestick で同一 ts の重複（一方は全 0 OHLC のプレースホルダ）が観測されるので排除する。timestamp が不正な行は素通しし、後段の row validation で upstream に分類させる。
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
