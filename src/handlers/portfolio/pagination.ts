import { normalizeAssetCodes } from '../../../lib/asset-code.js';
import type { BitbankPrivateClient } from '../../private/client.js';
import { type RawDeposit, type RawWithdrawal, tryGet } from './types.js';

export const MAX_PAGES = 10;
// 入出金履歴は公式上限 100（GET /v1/user/{deposit,withdrawal}_history）。
const DW_PAGE_SIZE = 100;

// count は期間を指定した単発取得（get_my_deposit_withdrawal）だけが入れる。
export type FlowStopReason = 'count' | 'page_limit' | 'stalled' | 'no_timestamp';

export interface PaginatedDeposits<T extends RawDeposit = RawDeposit> {
	deposits: T[];
	complete: boolean;
	stopReason?: FlowStopReason;
	error?: string;
	cause?: unknown;
}

export interface PaginatedWithdrawals<T extends RawWithdrawal = RawWithdrawal> {
	withdrawals: T[];
	complete: boolean;
	stopReason?: FlowStopReason;
	error?: string;
	cause?: unknown;
}

interface PaginatedHistory<T> {
	records: T[];
	complete: boolean;
	stopReason?: FlowStopReason;
	error?: string;
	cause?: unknown;
}

// confirmed_at は確認済の入金にしか無いので found_at にフォールバックする。
export const depositTime = (d: RawDeposit): number | undefined => d.confirmed_at ?? d.found_at;
export const withdrawalTime = (w: RawWithdrawal): number | undefined => w.requested_at;

// 入出金履歴 API は期間の中で新しい順に count 件を返す（実口座で確認。fork の issue 458 項目 1）。
async function paginateFlowHistory<T extends { uuid: string; asset: string }>(
	client: BitbankPrivateClient,
	path: string,
	key: 'deposits' | 'withdrawals',
	baseParams: Record<string, string>,
	sinceMs: number | undefined,
	timeOf: (record: T) => number | undefined,
): Promise<PaginatedHistory<T>> {
	const all: T[] = [];
	const seenIds = new Set<string>();
	let end: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const params: Record<string, string> = {
			...baseParams,
			count: String(DW_PAGE_SIZE),
			...(sinceMs != null ? { since: String(sinceMs) } : {}),
			...(end ? { end } : {}),
		};
		const result = await tryGet<Record<typeof key, T[]>>(client, path, params);
		if (!result.ok) {
			return { records: all, complete: false, error: result.error, cause: result.cause };
		}
		// 現行 API は小文字を返すが、calc.ts が小文字前提で JPY 判定・prices 検索・holdings キーを組むので取得境界で正規化しておく。
		const batch = normalizeAssetCodes(result.data[key] || []);
		const newRecords = batch.filter((r) => !seenIds.has(r.uuid));
		for (const r of newRecords) seenIds.add(r.uuid);
		all.push(...newRecords);
		if (batch.length < DW_PAGE_SIZE) {
			return { records: all, complete: true };
		}
		// 同じ時刻の履歴が DW_PAGE_SIZE 件以上あると end が進まないので、そこで打ち切る。
		if (newRecords.length === 0) return { records: all, complete: false, stopReason: 'stalled' };
		const times = batch.map(timeOf).filter((t): t is number => t != null && Number.isFinite(t));
		if (times.length === 0) return { records: all, complete: false, stopReason: 'no_timestamp' };
		// end は境界の時刻を含む（fork の issue 458 項目 7）ので 1ms 引かずに同じ時刻を取り直し、uuid で重複を除く。
		end = String(Math.min(...times));
	}
	return { records: all, complete: false, stopReason: 'page_limit' };
}

export async function paginateDeposits<T extends RawDeposit = RawDeposit>(
	client: BitbankPrivateClient,
	baseParams: Record<string, string>,
	sinceMs?: number,
): Promise<PaginatedDeposits<T>> {
	const { records, ...rest } = await paginateFlowHistory<T>(
		client,
		'/v1/user/deposit_history',
		'deposits',
		baseParams,
		sinceMs,
		depositTime,
	);
	return { deposits: records, ...rest };
}

export async function paginateWithdrawals<T extends RawWithdrawal = RawWithdrawal>(
	client: BitbankPrivateClient,
	baseParams: Record<string, string>,
	sinceMs?: number,
): Promise<PaginatedWithdrawals<T>> {
	const { records, ...rest } = await paginateFlowHistory<T>(
		client,
		'/v1/user/withdrawal_history',
		'withdrawals',
		baseParams,
		sinceMs,
		withdrawalTime,
	);
	return { withdrawals: records, ...rest };
}
