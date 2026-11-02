import { normalizeAssetCodes } from '../../../lib/asset-code.js';
import type { BitbankPrivateClient } from '../../private/client.js';
import { type RawDeposit, type RawWithdrawal, tryGet } from './types.js';

export const MAX_PAGES = 10;
// 入出金履歴は公式上限 100（POST /v1/user/{deposit,withdrawal}_history）。
const DW_PAGE_SIZE = 100;

export interface PaginatedDeposits<T extends RawDeposit = RawDeposit> {
	deposits: T[];
	complete: boolean;
	error?: string;
	cause?: unknown;
}

export interface PaginatedWithdrawals<T extends RawWithdrawal = RawWithdrawal> {
	withdrawals: T[];
	complete: boolean;
	error?: string;
	cause?: unknown;
}

export async function paginateDeposits<T extends RawDeposit = RawDeposit>(
	client: BitbankPrivateClient,
	baseParams: Record<string, string>,
	sinceMs?: number,
): Promise<PaginatedDeposits<T>> {
	const all: T[] = [];
	const seenIds = new Set<string>();
	let since: string | undefined = sinceMs != null ? String(sinceMs) : undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const params = { ...baseParams, count: String(DW_PAGE_SIZE), ...(since ? { since } : {}) };
		const result = await tryGet<{ deposits: T[] }>(client, '/v1/user/deposit_history', params);
		if (!result.ok) {
			return { deposits: all, complete: false, error: result.error, cause: result.cause };
		}
		// 現行 API は小文字を返すが、calc.ts が小文字前提で JPY 判定・prices 検索・holdings キーを組むので取得境界で正規化しておく。
		const batch = normalizeAssetCodes(result.data.deposits || []);
		const newRecords = batch.filter((d) => !seenIds.has(d.uuid));
		for (const d of newRecords) seenIds.add(d.uuid);
		all.push(...newRecords);
		if (batch.length < DW_PAGE_SIZE) {
			return { deposits: all, complete: true };
		}
		// 同一タイムスタンプが DW_PAGE_SIZE 件以上連続して進捗しない場合の保険
		if (newRecords.length === 0) return { deposits: all, complete: false };
		// 同一 ts を次ページで取り直して dedup する。confirmed_at は確認済の入金にしか無いので found_at にフォールバックする。
		const last = batch[batch.length - 1];
		const lastTs = last?.confirmed_at ?? last?.found_at;
		if (!lastTs) break;
		since = String(lastTs);
	}
	return { deposits: all, complete: false };
}

export async function paginateWithdrawals<T extends RawWithdrawal = RawWithdrawal>(
	client: BitbankPrivateClient,
	baseParams: Record<string, string>,
	sinceMs?: number,
): Promise<PaginatedWithdrawals<T>> {
	const all: T[] = [];
	const seenIds = new Set<string>();
	let since: string | undefined = sinceMs != null ? String(sinceMs) : undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const params = { ...baseParams, count: String(DW_PAGE_SIZE), ...(since ? { since } : {}) };
		const result = await tryGet<{ withdrawals: T[] }>(client, '/v1/user/withdrawal_history', params);
		if (!result.ok) {
			return { withdrawals: all, complete: false, error: result.error, cause: result.cause };
		}
		const batch = normalizeAssetCodes(result.data.withdrawals || []);
		const newRecords = batch.filter((w) => !seenIds.has(w.uuid));
		for (const w of newRecords) seenIds.add(w.uuid);
		all.push(...newRecords);
		if (batch.length < DW_PAGE_SIZE) {
			return { withdrawals: all, complete: true };
		}
		if (newRecords.length === 0) return { withdrawals: all, complete: false };
		const lastTs = batch[batch.length - 1]?.requested_at;
		if (!lastTs) break;
		since = String(lastTs);
	}
	return { withdrawals: all, complete: false };
}
