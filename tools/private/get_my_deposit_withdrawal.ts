import { normalizeAssetCodes } from '../../lib/asset-code.js';
import { nowIso, parseIso8601, toIsoMs } from '../../lib/datetime.js';
import { formatPrice } from '../../lib/formatter.js';
import { fail, ok } from '../../lib/result.js';
import {
	type PaginatedDeposits as PaginatedDepositsOf,
	type PaginatedWithdrawals as PaginatedWithdrawalsOf,
	paginateDeposits,
	paginateWithdrawals,
} from '../../src/handlers/portfolio/pagination.js';
import { tryGet } from '../../src/handlers/portfolio/types.js';
import { type BitbankPrivateClient, getDefaultClient } from '../../src/private/client.js';
import { GetMyDepositWithdrawalInputSchema, GetMyDepositWithdrawalOutputSchema } from '../../src/private/schemas.js';
import { failPrivateToolError } from '../../src/private/tool-error.js';
import type { ToolDefinition } from '../../src/tool-definition.js';

interface RawDeposit {
	uuid: string;
	asset: string;
	network?: string;
	address?: string;
	amount: string;
	txid?: string | null;
	status: string;
	found_at: number;
	confirmed_at: number;
}

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

type PaginatedDeposits = PaginatedDepositsOf<RawDeposit>;
type PaginatedWithdrawals = PaginatedWithdrawalsOf<RawWithdrawal>;

async function singleFetchDeposits(
	client: BitbankPrivateClient,
	params: Record<string, string>,
): Promise<PaginatedDeposits> {
	const result = await tryGet<{ deposits: RawDeposit[] }>(client, '/v1/user/deposit_history', params);
	if (!result.ok) {
		return { deposits: [], complete: false, error: result.error, cause: result.cause };
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
		return { withdrawals: [], complete: false, error: result.error, cause: result.cause };
	}
	const batch = result.data.withdrawals || [];
	const count = Number(params.count) || 100;
	return { withdrawals: batch, complete: batch.length < count };
}

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
		const baseParams: Record<string, string> = {};

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

		// ユーザーが期間を指定した場合は count を尊重して単発取得し、未指定ならページネーションで取得する（MAX_PAGES で打ち切ったら isComplete を false にする）。
		const hasSinceEnd = !!since || !!end;

		let allDeposits: RawDeposit[] = [];
		let allWithdrawals: RawWithdrawal[] = [];
		const warnings: string[] = [];
		let isComplete = true;
		// 実際に呼んだ取得だけを入れる（type で呼ばなかった側は失敗の判定に含めない）。
		const requested: Array<{ error?: string; cause?: unknown }> = [];

		if (asset) {
			const params: Record<string, string> = { ...baseParams, asset };
			if (hasSinceEnd) {
				params.count = String(count);
			}

			const [depResult, wdResult] = await Promise.all([
				fetchDeposits
					? hasSinceEnd
						? singleFetchDeposits(client, params)
						: paginateDeposits<RawDeposit>(client, { asset })
					: Promise.resolve({ deposits: [] as RawDeposit[], complete: true } as PaginatedDeposits),
				fetchWithdrawals
					? hasSinceEnd
						? singleFetchWithdrawals(client, params)
						: paginateWithdrawals<RawWithdrawal>(client, { asset })
					: Promise.resolve({ withdrawals: [] as RawWithdrawal[], complete: true } as PaginatedWithdrawals),
			]);

			if (fetchDeposits) requested.push(depResult);
			if (fetchWithdrawals) requested.push(wdResult);
			if (depResult.error) warnings.push(`入金/入庫履歴の取得に失敗: ${depResult.error}`);
			if (wdResult.error) warnings.push(`出金/出庫履歴の取得に失敗: ${wdResult.error}`);
			allDeposits = depResult.deposits;
			allWithdrawals = wdResult.withdrawals;
			isComplete = depResult.complete && wdResult.complete;
		} else {
			if (hasSinceEnd) {
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

				if (fetchDeposits) requested.push(cryptoDepResult, jpyDepResult);
				if (fetchWithdrawals) requested.push(cryptoWdResult, jpyWdResult);
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
				const [cryptoDepResult, jpyDepResult, cryptoWdResult, jpyWdResult] = await Promise.all([
					fetchDeposits
						? paginateDeposits<RawDeposit>(client, {})
						: Promise.resolve({ deposits: [], complete: true } as PaginatedDeposits),
					fetchDeposits
						? paginateDeposits<RawDeposit>(client, { asset: 'jpy' })
						: Promise.resolve({ deposits: [], complete: true } as PaginatedDeposits),
					fetchWithdrawals
						? paginateWithdrawals<RawWithdrawal>(client, {})
						: Promise.resolve({ withdrawals: [], complete: true } as PaginatedWithdrawals),
					fetchWithdrawals
						? paginateWithdrawals<RawWithdrawal>(client, { asset: 'jpy' })
						: Promise.resolve({ withdrawals: [], complete: true } as PaginatedWithdrawals),
				]);

				if (fetchDeposits) requested.push(cryptoDepResult, jpyDepResult);
				if (fetchWithdrawals) requested.push(cryptoWdResult, jpyWdResult);
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

		// 取得できなかったことを「入出金 0 件」と読ませないよう、1 件も取れずに全部失敗したら失敗として返す。
		const failures = requested.filter((r) => r.error);
		if (failures.length === requested.length && allDeposits.length + allWithdrawals.length === 0) {
			return GetMyDepositWithdrawalOutputSchema.parse(
				failPrivateToolError(failures[0]?.cause, '入出金履歴の取得に失敗しました'),
			);
		}

		// 全フェッチ経路がここに合流するので、UUID の重複排除（暗号資産クエリに JPY が含まれるケース）と asset 正規化をこの 1 箇所で行う。
		allDeposits = normalizeAssetCodes(deduplicateByUuid(allDeposits));
		allWithdrawals = normalizeAssetCodes(deduplicateByUuid(allWithdrawals));

		const timestamp = nowIso();

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
		return GetMyDepositWithdrawalOutputSchema.parse(
			failPrivateToolError(err, '入出金履歴取得中に予期しないエラーが発生しました'),
		);
	}
}

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

function deduplicateByUuid<T extends { uuid: string }>(items: T[]): T[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		if (seen.has(item.uuid)) return false;
		seen.add(item.uuid);
		return true;
	});
}

export const toolDef: ToolDefinition = {
	name: 'get_my_deposit_withdrawal',
	description:
		'[Deposit / Withdrawal / Transfer History] 入出金・入出庫の履歴（deposit / withdrawal / transfer / funding history）を取得。JPY入出金+暗号資産入出庫に対応。期間を指定しないときは入金・出金ごとに最大 1,000 件までさかのぼる（上限に達したら取得状態が partial になる）。Private API。',
	inputSchema: GetMyDepositWithdrawalInputSchema,
	handler: async (args: {
		asset?: string;
		type?: 'deposit' | 'withdrawal' | 'all';
		count?: number;
		since?: string;
		end?: string;
	}) => getMyDepositWithdrawal(args),
};
