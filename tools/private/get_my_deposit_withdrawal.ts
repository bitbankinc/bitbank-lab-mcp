/**
 * get_my_deposit_withdrawal — 入出金（入庫/出庫）履歴を取得する Private API ツール。
 *
 * bitbank Private API `/v1/user/deposit_history` および `/v1/user/withdrawal_history` を呼び出し、
 * LLM が分析しやすい形に整形して返す。
 *
 * - JPY 入出金: asset=jpy で取得
 * - 暗号資産入出庫: asset 省略または通貨コード指定で取得
 * - 両方を統合して返す（デフォルト動作: 全通貨 + JPY の入出金を統合取得）
 * - ページネーション対応: 100件上限を超えるデータも自動取得（最大10ページ=1000件/チャネル）
 */

import { nowIso, parseIso8601, toIsoMs } from '../../lib/datetime.js';
import { getErrorMessage } from '../../lib/error.js';
import { formatPrice } from '../../lib/formatter.js';
import { fail, ok } from '../../lib/result.js';
import { type BitbankPrivateClient, getDefaultClient, PrivateApiError } from '../../src/private/client.js';
import { GetMyDepositWithdrawalInputSchema, GetMyDepositWithdrawalOutputSchema } from '../../src/private/schemas.js';
import type { ToolDefinition } from '../../src/tool-definition.js';

// ── API レスポンス型 ──

/** 個別 API リクエストの結果をラップ */
type FetchResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function tryGet<T>(
	client: BitbankPrivateClient,
	path: string,
	params?: Record<string, string>,
): Promise<FetchResult<T>> {
	try {
		const data = await client.get<T>(path, params);
		return { ok: true, data };
	} catch (err) {
		return { ok: false, error: getErrorMessage(err) };
	}
}

/** bitbank /v1/user/deposit_history のレスポンス型 */
interface RawDeposit {
	uuid: string;
	asset: string;
	network?: string;
	/** 入金先アドレス（暗号資産入金のみ。jpy 入金は持たないため optional） */
	address?: string;
	amount: string;
	txid?: string | null;
	status: string;
	found_at: number;
	confirmed_at: number;
}

/** bitbank /v1/user/withdrawal_history のレスポンス型 */
interface RawWithdrawal {
	uuid: string;
	asset: string;
	account_uuid?: string;
	amount: string;
	fee?: string;
	label?: string;
	address?: string;
	network?: string;
	txid?: string | null;
	destination_tag?: number | string | null;
	bank_name?: string;
	branch_name?: string;
	account_type?: string;
	account_number?: string;
	account_owner?: string;
	status: string;
	requested_at: number;
}

// ── ページネーション（analyze_my_portfolio と同方式） ──

const MAX_PAGES = 10;

interface PaginatedDeposits {
	deposits: RawDeposit[];
	complete: boolean;
	error?: string;
}
interface PaginatedWithdrawals {
	withdrawals: RawWithdrawal[];
	complete: boolean;
	error?: string;
}

async function paginateDeposits(
	client: BitbankPrivateClient,
	baseParams: Record<string, string>,
): Promise<PaginatedDeposits> {
	const all: RawDeposit[] = [];
	let since: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const params = { ...baseParams, count: '100', ...(since ? { since } : {}) };
		const result = await tryGet<{ deposits: RawDeposit[] }>(client, '/v1/user/deposit_history', params);
		if (!result.ok) {
			return { deposits: all, complete: all.length !== 0, error: result.error };
		}
		const batch = result.data.deposits || [];
		all.push(...batch);
		if (batch.length < 100) {
			return { deposits: all, complete: true };
		}
		// confirmed_at は確認済の入金にのみ存在する（docs: "exists only for confirmed one"）。
		// 末尾が未確認入金（status:'FOUND'）だと confirmed_at が欠落しカーソルが進まないため、
		// 常在する found_at にフォールバックして早期終了を防ぐ。
		const last = batch[batch.length - 1];
		const lastTs = last?.confirmed_at ?? last?.found_at;
		if (!lastTs) break;
		since = String(lastTs + 1);
	}
	return { deposits: all, complete: false };
}

async function paginateWithdrawals(
	client: BitbankPrivateClient,
	baseParams: Record<string, string>,
): Promise<PaginatedWithdrawals> {
	const all: RawWithdrawal[] = [];
	let since: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const params = { ...baseParams, count: '100', ...(since ? { since } : {}) };
		const result = await tryGet<{ withdrawals: RawWithdrawal[] }>(client, '/v1/user/withdrawal_history', params);
		if (!result.ok) {
			return { withdrawals: all, complete: all.length !== 0, error: result.error };
		}
		const batch = result.data.withdrawals || [];
		all.push(...batch);
		if (batch.length < 100) {
			return { withdrawals: all, complete: true };
		}
		const lastTs = batch[batch.length - 1]?.requested_at;
		if (!lastTs) break;
		since = String(lastTs + 1);
	}
	return { withdrawals: all, complete: false };
}

/** 単発取得（count <= 100 かつ since/end 指定時） */
async function singleFetchDeposits(
	client: BitbankPrivateClient,
	params: Record<string, string>,
): Promise<PaginatedDeposits> {
	const result = await tryGet<{ deposits: RawDeposit[] }>(client, '/v1/user/deposit_history', params);
	if (!result.ok) {
		return { deposits: [], complete: false, error: result.error };
	}
	const batch = result.data.deposits || [];
	const count = Number(params.count) || 100;
	return { deposits: batch, complete: batch.length < count };
}

async function singleFetchWithdrawals(
	client: BitbankPrivateClient,
	params: Record<string, string>,
): Promise<PaginatedWithdrawals> {
	const result = await tryGet<{ withdrawals: RawWithdrawal[] }>(client, '/v1/user/withdrawal_history', params);
	if (!result.ok) {
		return { withdrawals: [], complete: false, error: result.error };
	}
	const batch = result.data.withdrawals || [];
	const count = Number(params.count) || 100;
	return { withdrawals: batch, complete: batch.length < count };
}

// ── メインハンドラ ──

export default async function getMyDepositWithdrawal(args: {
	asset?: string;
	type?: 'deposit' | 'withdrawal' | 'all';
	count?: number;
	since?: string;
	end?: string;
}) {
	const { asset, type = 'all', count = 25, since, end } = args;
	const client = getDefaultClient();

	try {
		// クエリパラメータを組み立て
		const baseParams: Record<string, string> = {};

		// ISO8601 → unix ms 変換
		if (since) {
			const parsed = parseIso8601(since);
			if (!parsed) {
				return GetMyDepositWithdrawalOutputSchema.parse(
					fail(`since の日時形式が不正です: ${since}`, 'validation_error'),
				);
			}
			baseParams.since = String(parsed.valueOf());
		}
		if (end) {
			const parsed = parseIso8601(end);
			if (!parsed) {
				return GetMyDepositWithdrawalOutputSchema.parse(fail(`end の日時形式が不正です: ${end}`, 'validation_error'));
			}
			baseParams.end = String(parsed.valueOf());
		}

		const fetchDeposits = type === 'deposit' || type === 'all';
		const fetchWithdrawals = type === 'withdrawal' || type === 'all';

		// since/end が指定されている場合: 単発取得（ユーザーが期間を指定した場合は count を尊重）
		// since/end が未指定の場合: ページネーションで全件取得
		const hasSinceEnd = !!since || !!end;

		let allDeposits: RawDeposit[] = [];
		let allWithdrawals: RawWithdrawal[] = [];
		const warnings: string[] = [];
		let isComplete = true;

		if (asset) {
			// 特定通貨の場合
			const params: Record<string, string> = { ...baseParams, asset };
			if (hasSinceEnd) {
				params.count = String(count);
			}

			const [depResult, wdResult] = await Promise.all([
				fetchDeposits
					? hasSinceEnd
						? singleFetchDeposits(client, params)
						: paginateDeposits(client, { asset })
					: Promise.resolve({ deposits: [] as RawDeposit[], complete: true } as PaginatedDeposits),
				fetchWithdrawals
					? hasSinceEnd
						? singleFetchWithdrawals(client, params)
						: paginateWithdrawals(client, { asset })
					: Promise.resolve({ withdrawals: [] as RawWithdrawal[], complete: true } as PaginatedWithdrawals),
			]);

			if (depResult.error) warnings.push(`入金/入庫履歴の取得に失敗: ${depResult.error}`);
			if (wdResult.error) warnings.push(`出金/出庫履歴の取得に失敗: ${wdResult.error}`);
			allDeposits = depResult.deposits;
			allWithdrawals = wdResult.withdrawals;
			isComplete = depResult.complete && wdResult.complete;
		} else {
			// 全通貨: 暗号資産 + JPY を並列取得（ページネーション）
			if (hasSinceEnd) {
				// since/end 指定時: 単発取得
				const cryptoParams = { ...baseParams, count: String(count) };
				const jpyParams = { ...baseParams, asset: 'jpy', count: String(count) };

				const [cryptoDepResult, jpyDepResult, cryptoWdResult, jpyWdResult] = await Promise.all([
					fetchDeposits
						? singleFetchDeposits(client, cryptoParams)
						: Promise.resolve({ deposits: [], complete: true } as PaginatedDeposits),
					fetchDeposits
						? singleFetchDeposits(client, jpyParams)
						: Promise.resolve({ deposits: [], complete: true } as PaginatedDeposits),
					fetchWithdrawals
						? singleFetchWithdrawals(client, cryptoParams)
						: Promise.resolve({ withdrawals: [], complete: true } as PaginatedWithdrawals),
					fetchWithdrawals
						? singleFetchWithdrawals(client, jpyParams)
						: Promise.resolve({ withdrawals: [], complete: true } as PaginatedWithdrawals),
				]);

				collectResults(
					cryptoDepResult,
					jpyDepResult,
					cryptoWdResult,
					jpyWdResult,
					warnings,
					(d) => {
						allDeposits = d;
					},
					(w) => {
						allWithdrawals = w;
					},
				);
				isComplete =
					cryptoDepResult.complete && jpyDepResult.complete && cryptoWdResult.complete && jpyWdResult.complete;
			} else {
				// since/end 未指定: ページネーションで全件取得
				const [cryptoDepResult, jpyDepResult, cryptoWdResult, jpyWdResult] = await Promise.all([
					fetchDeposits
						? paginateDeposits(client, {})
						: Promise.resolve({ deposits: [], complete: true } as PaginatedDeposits),
					fetchDeposits
						? paginateDeposits(client, { asset: 'jpy' })
						: Promise.resolve({ deposits: [], complete: true } as PaginatedDeposits),
					fetchWithdrawals
						? paginateWithdrawals(client, {})
						: Promise.resolve({ withdrawals: [], complete: true } as PaginatedWithdrawals),
					fetchWithdrawals
						? paginateWithdrawals(client, { asset: 'jpy' })
						: Promise.resolve({ withdrawals: [], complete: true } as PaginatedWithdrawals),
				]);

				collectResults(
					cryptoDepResult,
					jpyDepResult,
					cryptoWdResult,
					jpyWdResult,
					warnings,
					(d) => {
						allDeposits = d;
					},
					(w) => {
						allWithdrawals = w;
					},
				);
				isComplete =
					cryptoDepResult.complete && jpyDepResult.complete && cryptoWdResult.complete && jpyWdResult.complete;
			}
		}

		// UUID で重複排除（暗号資産クエリに JPY が含まれるケースに備える）
		allDeposits = deduplicateByUuid(allDeposits);
		allWithdrawals = deduplicateByUuid(allWithdrawals);

		const timestamp = nowIso();

		// 入金データの整形
		const deposits = allDeposits.map((d) => ({
			uuid: d.uuid,
			asset: d.asset,
			amount: d.amount,
			network: d.network || undefined,
			txid: d.txid || undefined,
			status: d.status,
			found_at: toIsoMs(d.found_at) ?? undefined,
			confirmed_at: toIsoMs(d.confirmed_at) ?? undefined,
		}));

		// 出金データの整形
		const withdrawals = allWithdrawals.map((w) => ({
			uuid: w.uuid,
			asset: w.asset,
			amount: w.amount,
			fee: w.fee || undefined,
			network: w.network || undefined,
			txid: w.txid || undefined,
			label: w.label || undefined,
			address: w.address || undefined,
			bank_name: w.bank_name || undefined,
			status: w.status,
			requested_at: toIsoMs(w.requested_at) ?? undefined,
		}));

		// サマリー文字列の生成
		const lines: string[] = [];
		const assetLabel = asset ? asset.toUpperCase() : '全通貨';
		lines.push(`入出金履歴: ${assetLabel}`);
		lines.push(`取得時刻: ${timestamp}`);
		lines.push(`取得状態: ${isComplete ? 'complete' : 'partial'}`);
		lines.push(`警告有無: ${warnings.length > 0 ? 'yes' : 'no'}`);
		if (warnings.length > 0) {
			lines.push('※ 一部API取得失敗あり（詳細は末尾の警告を参照）');
		}
		if (!isComplete) {
			lines.push('※ 全件ではなく一部のみ取得されています。API件数上限に達した可能性があります');
		}
		lines.push('');

		// 入金サマリー
		if (deposits.length > 0) {
			lines.push(`入金/入庫: ${deposits.length}件`);
			const jpyDeposits = deposits.filter((d) => d.asset === 'jpy');
			const cryptoDeposits = deposits.filter((d) => d.asset !== 'jpy');
			if (jpyDeposits.length > 0) {
				const totalJpy = jpyDeposits.reduce((sum, d) => sum + Number(d.amount), 0);
				lines.push(`  JPY 入金: ${jpyDeposits.length}件 合計 ${formatPrice(Math.round(totalJpy))}`);
				for (const d of jpyDeposits.slice(0, 5)) {
					lines.push(
						`    [${d.uuid}] JPY ${formatPrice(Math.round(Number(d.amount)))} (${d.status})${d.found_at ? ` ${d.found_at}` : ''}`,
					);
				}
				if (jpyDeposits.length > 5) lines.push(`    ... 他 ${jpyDeposits.length - 5}件`);
			}
			if (cryptoDeposits.length > 0) {
				lines.push(`  暗号資産入庫: ${cryptoDeposits.length}件（明細表示は先頭5件のみ）`);
				for (const d of cryptoDeposits.slice(0, 5)) {
					lines.push(
						`    [${d.uuid}] ${d.asset.toUpperCase()} ${d.amount} (${d.status})${d.found_at ? ` ${d.found_at}` : ''}`,
					);
				}
				if (cryptoDeposits.length > 5) lines.push(`    ... 他 ${cryptoDeposits.length - 5}件`);
			}
		} else {
			lines.push('入金/入庫: 0件');
		}

		lines.push('');

		// 出金サマリー
		if (withdrawals.length > 0) {
			lines.push(`出金/出庫: ${withdrawals.length}件`);
			const jpyWithdrawals = withdrawals.filter((w) => w.asset === 'jpy');
			const cryptoWithdrawals = withdrawals.filter((w) => w.asset !== 'jpy');
			if (jpyWithdrawals.length > 0) {
				const totalJpy = jpyWithdrawals.reduce((sum, w) => sum + Number(w.amount), 0);
				lines.push(`  JPY 出金: ${jpyWithdrawals.length}件 合計 ${formatPrice(Math.round(totalJpy))}`);
				for (const w of jpyWithdrawals.slice(0, 5)) {
					lines.push(
						`    [${w.uuid}] JPY ${formatPrice(Math.round(Number(w.amount)))} (${w.status})${w.requested_at ? ` ${w.requested_at}` : ''}`,
					);
				}
				if (jpyWithdrawals.length > 5) lines.push(`    ... 他 ${jpyWithdrawals.length - 5}件`);
			}
			if (cryptoWithdrawals.length > 0) {
				lines.push(`  暗号資産出庫: ${cryptoWithdrawals.length}件（明細表示は先頭5件のみ）`);
				for (const w of cryptoWithdrawals.slice(0, 5)) {
					lines.push(
						`    [${w.uuid}] ${w.asset.toUpperCase()} ${w.amount} (${w.status})${w.requested_at ? ` ${w.requested_at}` : ''}`,
					);
				}
				if (cryptoWithdrawals.length > 5) lines.push(`    ... 他 ${cryptoWithdrawals.length - 5}件`);
			}
		} else {
			lines.push('出金/出庫: 0件');
		}

		// 警告（partial failure）
		if (warnings.length > 0) {
			lines.push('');
			for (const w of warnings) {
				lines.push(`警告: ${w}`);
			}
		}

		const summary = lines.join('\n');

		const data = {
			deposits,
			withdrawals,
			timestamp,
		};

		const meta = {
			fetchedAt: timestamp,
			depositCount: deposits.length,
			withdrawalCount: withdrawals.length,
			asset: asset || undefined,
			isComplete,
			hasWarnings: warnings.length > 0,
			warnings,
			...(client.lastRateLimit ? { rateLimit: client.lastRateLimit } : {}),
		};

		return GetMyDepositWithdrawalOutputSchema.parse(ok(summary, data, meta));
	} catch (err) {
		if (err instanceof PrivateApiError) {
			return GetMyDepositWithdrawalOutputSchema.parse(fail(err.message, err.errorType));
		}
		return GetMyDepositWithdrawalOutputSchema.parse(
			fail(err instanceof Error ? err.message : '入出金履歴取得中に予期しないエラーが発生しました', 'upstream_error'),
		);
	}
}

// ── ヘルパー ──

/** 4チャネルの結果を集約 */
function collectResults(
	cryptoDepResult: PaginatedDeposits,
	jpyDepResult: PaginatedDeposits,
	cryptoWdResult: PaginatedWithdrawals,
	jpyWdResult: PaginatedWithdrawals,
	warnings: string[],
	setDeposits: (d: RawDeposit[]) => void,
	setWithdrawals: (w: RawWithdrawal[]) => void,
) {
	const apiResults = [
		{ error: cryptoDepResult.error, label: '暗号資産入庫履歴' },
		{ error: jpyDepResult.error, label: 'JPY入金履歴' },
		{ error: cryptoWdResult.error, label: '暗号資産出庫履歴' },
		{ error: jpyWdResult.error, label: 'JPY出金履歴' },
	];
	for (const { error, label } of apiResults) {
		if (error) {
			warnings.push(`${label}の取得に失敗: ${error}`);
		}
	}

	setDeposits([...cryptoDepResult.deposits, ...jpyDepResult.deposits]);
	setWithdrawals([...cryptoWdResult.withdrawals, ...jpyWdResult.withdrawals]);
}

/** UUID で重複排除 */
function deduplicateByUuid<T extends { uuid: string }>(items: T[]): T[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		if (seen.has(item.uuid)) return false;
		seen.add(item.uuid);
		return true;
	});
}

// ── MCP ツール定義（tool-registry から自動収集） ──
export const toolDef: ToolDefinition = {
	name: 'get_my_deposit_withdrawal',
	description:
		'[Deposit / Withdrawal / Transfer History] 入出金・入出庫の履歴（deposit / withdrawal / transfer / funding history）を取得。JPY入出金+暗号資産入出庫に対応。全件取得可能。Private API。',
	inputSchema: GetMyDepositWithdrawalInputSchema,
	handler: async (args: {
		asset?: string;
		type?: 'deposit' | 'withdrawal' | 'all';
		count?: number;
		since?: string;
		end?: string;
	}) => getMyDepositWithdrawal(args),
};
