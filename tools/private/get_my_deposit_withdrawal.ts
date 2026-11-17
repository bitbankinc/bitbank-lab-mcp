import { normalizeAssetCodes } from '../../lib/asset-code.js';
import { nowIso, parseIso8601, toIsoMs } from '../../lib/datetime.js';
import { formatPrice } from '../../lib/formatter.js';
import { fail, ok } from '../../lib/result.js';
import {
	depositTime,
	type FlowStopReason,
	MAX_PAGES,
	type PaginatedDeposits as PaginatedDepositsOf,
	type PaginatedWithdrawals as PaginatedWithdrawalsOf,
	paginateDeposits,
	paginateWithdrawals,
	withdrawalTime,
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
	category?: string;
	found_at: number;
	confirmed_at: number;
}

// NORMAL は通常の入金なので明細に出さない。それ以外は値をそのまま出す（MANUAL は意味が公表されていない）。
const depositCategoryText = (category: string | undefined) =>
	category != null && category !== 'NORMAL' ? ` / 種別: ${category}` : '';

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
	const complete = batch.length < count;
	return { deposits: batch, complete, ...(complete ? {} : { stopReason: 'count' as const }) };
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
	const complete = batch.length < count;
	return { withdrawals: batch, complete, ...(complete ? {} : { stopReason: 'count' as const }) };
}

interface FlowPart {
	label: string;
	complete: boolean;
	stopReason?: FlowStopReason;
	error?: string;
	cause?: unknown;
	oldestMs: number | null;
}

function oldestOf(times: Array<number | undefined>): number | null {
	const valid = times.filter((t): t is number => t != null && Number.isFinite(t));
	return valid.length > 0 ? Math.min(...valid) : null;
}

function depositPart(label: string, r: PaginatedDeposits): FlowPart {
	const { deposits, ...rest } = r;
	return { label, ...rest, oldestMs: oldestOf(deposits.map(depositTime)) };
}

function withdrawalPart(label: string, r: PaginatedWithdrawals): FlowPart {
	const { withdrawals, ...rest } = r;
	return { label, ...rest, oldestMs: oldestOf(withdrawals.map(withdrawalTime)) };
}

// resumable: 一番古い時刻を end に渡せば先へ進める理由か。同じ時刻で詰まったときは同じ結果が返るだけなので案内しない。
const FLOW_STOP_TEXT: Record<FlowStopReason, { text: (count: number) => string; resumable: boolean }> = {
	count: {
		text: (count) => `指定した件数（${count}件）に達したので取得を止めました。これより古い履歴もある可能性があります`,
		resumable: true,
	},
	page_limit: {
		text: () =>
			`取得するページ数の上限（${MAX_PAGES} ページ）まで調べて打ち切りました。これより古い履歴は取得していません`,
		resumable: true,
	},
	stalled: {
		text: () =>
			'同じ時刻の履歴が 1 ページ分を超えて並び、先へ進めずに打ち切りました。これより古い履歴は取得していません',
		resumable: false,
	},
	no_timestamp: {
		text: () => '時刻の無い履歴があり、先へ進めずに打ち切りました。これより古い履歴は取得していません',
		resumable: false,
	},
};

// GetMyDepositWithdrawalInputSchema の count の上限とそろえる。
const DW_COUNT_MAX = 100;

function incompleteLines(parts: FlowPart[], count: number): string[] {
	const lines: string[] = [];
	let resumable = false;
	for (const p of parts) {
		if (p.complete) continue;
		if (p.error) {
			lines.push(`  ${p.label}: 取得に失敗しました（末尾の警告を参照）`);
			continue;
		}
		const stop = p.stopReason != null ? FLOW_STOP_TEXT[p.stopReason] : undefined;
		if (!stop) continue;
		const at = stop.resumable ? toIsoMs(p.oldestMs) : null;
		if (at != null) resumable = true;
		// end は境界を含むので、count のまま取り直すと同じ時刻の行だけが返って先へ進まないことがある。
		const widen = p.stopReason === 'count' && count < DW_COUNT_MAX;
		const how = widen ? `し、count を今回より大きくして（上限 ${DW_COUNT_MAX}）` : 'して';
		const next = at != null ? `。続きは end に ${at}（取得したいちばん古い時刻）を指定${how}取得してください` : '';
		lines.push(`  ${p.label}: ${stop.text(count)}${next}`);
	}
	if (resumable) lines.push('  end は境界の時刻を含むので、同じ時刻の履歴は重複して返ります（uuid で除いてください）');
	return lines;
}

const DW_DISPLAY_LIMIT = 100;

// 続きの end に渡す時刻なので、timeOf はページ送りのカーソル（depositTime / withdrawalTime）と同じ時刻を返す。
function pushDetailRows<T>(
	lines: string[],
	rows: T[],
	timeOf: (row: T) => string | undefined,
	format: (row: T) => string,
): void {
	const sorted = [...rows].sort((a, b) => (timeOf(b) ?? '').localeCompare(timeOf(a) ?? ''));
	const shown = sorted.slice(0, DW_DISPLAY_LIMIT);
	for (const row of shown) lines.push(format(row));
	const hidden = sorted.length - shown.length;
	if (hidden <= 0) return;
	const last = shown[shown.length - 1];
	const at = last != null ? timeOf(last) : undefined;
	const next =
		at != null
			? `残りは ${at} 以前です。明細が必要なら end に ${at} を指定して取得してください。境界の時刻は含まれるので uuid で重複を除いてください`
			: '明細が必要なら since / end で期間を絞って取得してください';
	lines.push(`    ... 他 ${hidden}件（本文の明細は新しいほうから ${DW_DISPLAY_LIMIT}件まで。${next}）`);
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
		// 実際に呼んだ取得だけを入れる（type で呼ばなかった側は失敗や取得状態の判定に含めない）。
		const parts: FlowPart[] = [];

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

			if (fetchDeposits) parts.push(depositPart('入金/入庫履歴', depResult));
			if (fetchWithdrawals) parts.push(withdrawalPart('出金/出庫履歴', wdResult));
			if (depResult.error) warnings.push(`入金/入庫履歴の取得に失敗: ${depResult.error}`);
			if (wdResult.error) warnings.push(`出金/出庫履歴の取得に失敗: ${wdResult.error}`);
			allDeposits = depResult.deposits;
			allWithdrawals = wdResult.withdrawals;
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

				if (fetchDeposits)
					parts.push(depositPart('暗号資産入庫履歴', cryptoDepResult), depositPart('JPY入金履歴', jpyDepResult));
				if (fetchWithdrawals)
					parts.push(withdrawalPart('暗号資産出庫履歴', cryptoWdResult), withdrawalPart('JPY出金履歴', jpyWdResult));
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

				if (fetchDeposits)
					parts.push(depositPart('暗号資産入庫履歴', cryptoDepResult), depositPart('JPY入金履歴', jpyDepResult));
				if (fetchWithdrawals)
					parts.push(withdrawalPart('暗号資産出庫履歴', cryptoWdResult), withdrawalPart('JPY出金履歴', jpyWdResult));
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
			}
		}

		// 取得できなかったことを「入出金 0 件」と読ませないよう、1 件も取れずに全部失敗したら失敗として返す。
		const failures = parts.filter((r) => r.error);
		if (failures.length === parts.length && allDeposits.length + allWithdrawals.length === 0) {
			return GetMyDepositWithdrawalOutputSchema.parse(
				failPrivateToolError(failures[0]?.cause, '入出金履歴の取得に失敗しました'),
			);
		}

		// 全フェッチ経路がここに合流するので、UUID の重複排除（暗号資産クエリに JPY が含まれるケース）と asset 正規化をこの 1 箇所で行う。
		allDeposits = normalizeAssetCodes(deduplicateByUuid(allDeposits));
		allWithdrawals = normalizeAssetCodes(deduplicateByUuid(allWithdrawals));

		const isComplete = parts.every((r) => r.complete);
		const timestamp = nowIso();

		const deposits = allDeposits.map((d) => ({
			uuid: d.uuid,
			asset: d.asset,
			amount: d.amount,
			network: d.network || undefined,
			txid: d.txid || undefined,
			status: d.status,
			category: d.category || undefined,
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

		const depositDisplayTime = (d: (typeof deposits)[number]) => d.confirmed_at ?? d.found_at;
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
			lines.push('※ 全件ではなく一部のみ取得されています。', ...incompleteLines(parts, count));
		}
		lines.push('');

		if (deposits.length > 0) {
			lines.push(`入金/入庫: ${deposits.length}件`);
			const jpyDeposits = deposits.filter((d) => d.asset === 'jpy');
			const cryptoDeposits = deposits.filter((d) => d.asset !== 'jpy');
			if (jpyDeposits.length > 0) {
				const totalJpy = jpyDeposits.reduce((sum, d) => sum + Number(d.amount), 0);
				lines.push(`  JPY 入金: ${jpyDeposits.length}件 合計 ${formatPrice(Math.round(totalJpy))}`);
				pushDetailRows(
					lines,
					jpyDeposits,
					depositDisplayTime,
					(d) =>
						`    [${d.uuid}] JPY ${formatPrice(Math.round(Number(d.amount)))} (${d.status}${depositCategoryText(d.category)})${d.found_at ? ` ${d.found_at}` : ''}`,
				);
			}
			if (cryptoDeposits.length > 0) {
				const stakingCount = cryptoDeposits.filter((d) => d.category === 'STAKING').length;
				const stakingText = stakingCount > 0 ? `、うちステーキング報酬（種別: STAKING）${stakingCount}件` : '';
				lines.push(`  暗号資産入庫: ${cryptoDeposits.length}件${stakingText}`);
				pushDetailRows(
					lines,
					cryptoDeposits,
					depositDisplayTime,
					(d) =>
						`    [${d.uuid}] ${d.asset.toUpperCase()} ${d.amount} (${d.status}${depositCategoryText(d.category)})${d.found_at ? ` ${d.found_at}` : ''}`,
				);
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
				pushDetailRows(
					lines,
					jpyWithdrawals,
					(w) => w.requested_at,
					(w) =>
						`    [${w.uuid}] JPY ${formatPrice(Math.round(Number(w.amount)))} (${w.status})${w.requested_at ? ` ${w.requested_at}` : ''}`,
				);
			}
			if (cryptoWithdrawals.length > 0) {
				lines.push(`  暗号資産出庫: ${cryptoWithdrawals.length}件`);
				pushDetailRows(
					lines,
					cryptoWithdrawals,
					(w) => w.requested_at,
					(w) =>
						`    [${w.uuid}] ${w.asset.toUpperCase()} ${w.amount} (${w.status})${w.requested_at ? ` ${w.requested_at}` : ''}`,
				);
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
		'[Deposit / Withdrawal / Transfer History] 入出金・入出庫の履歴（deposit / withdrawal / transfer / funding history）を取得。JPY入出金+暗号資産入出庫に対応。期間を指定しないときは入金・出金ごとに最大 1,000 件までさかのぼる（上限に達したら取得状態が partial になる）。本文に出す明細は種類（JPY 入金・暗号資産入庫・JPY 出金・暗号資産出庫）ごとに新しいほうから 100 件まで（超えた分は件数と、明細を取るときに end に渡す時刻を書く）。Private API。',
	inputSchema: GetMyDepositWithdrawalInputSchema,
	handler: async (args: {
		asset?: string;
		type?: 'deposit' | 'withdrawal' | 'all';
		count?: number;
		since?: string;
		end?: string;
	}) => getMyDepositWithdrawal(args),
};
