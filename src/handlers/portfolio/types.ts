import type { z } from 'zod';
import { getErrorMessage } from '../../../lib/error.js';
import type { BitbankPrivateClient } from '../../private/client.js';
import type {
	GetMarginPositionsDataSchema,
	GetMarginStatusDataSchema,
	PortfolioChangePctUnavailableReason,
	PortfolioFlowUnavailableReason,
	PortfolioFlowValuationBasis,
	PortfolioUnresolvedDepositReason,
} from '../../private/schemas.js';

/** get_my_assets / analyze_my_portfolio が共有する単一ソース。実 API 形からのドリフトを防ぐため定義はここだけに置く。 */
export interface RawAsset {
	asset: string;
	free_amount: string;
	amount_precision: number;
	onhand_amount: string;
	locked_amount: string;
	withdrawing_amount: string;
	/** 出金手数料。暗号資産は {min,max}、jpy は {under,over,threshold}（カテゴリ C: パススルー） */
	withdrawal_fee: { min: string; max: string } | { under: string; over: string; threshold: string };
	stop_deposit: boolean;
	stop_withdrawal: boolean;
	network_list?: Array<{
		asset: string;
		network: string;
		stop_deposit: boolean;
		stop_withdrawal: boolean;
		withdrawal_fee: string;
	}>;
	collateral_ratio: string;
}

export interface RawTrade {
	trade_id: number;
	pair: string;
	order_id: number;
	side: string;
	/** 信用約定が混入した場合のみ存在。現物 API レスポンスでは通常未定義 */
	position_side?: string;
	type: string;
	amount: string;
	price: string;
	maker_taker: string;
	fee_amount_base: string;
	fee_amount_quote: string;
	fee_occurred_amount_quote?: string;
	executed_at: number;
}

export interface RawMarginTrade {
	trade_id: number;
	pair: string;
	order_id: number;
	side: string;
	position_side?: string;
	type: string;
	amount: string;
	price: string;
	maker_taker: string;
	fee_amount_base: string;
	fee_amount_quote: string;
	fee_occurred_amount_quote?: string;
	/** 決済時のみ。利益で正、損失で負（bitbank API 標準） */
	profit_loss?: string;
	/** 決済時のみ。コスト = 正の値で支払利息を表す */
	interest?: string;
	executed_at: number;
}

/** net-flow の計算に要るフィールドだけの射影。address / txid などは意図的に持たない（完全形は tools/private/get_my_deposit_withdrawal.ts）。 */
export interface RawDeposit {
	uuid: string;
	asset: string;
	amount: string;
	status: string;
	found_at: number;
	confirmed_at: number;
}

export interface RawWithdrawal {
	uuid: string;
	asset: string;
	amount: string;
	fee?: string;
	status: string;
	requested_at: number;
}

export interface DepositWithdrawalData {
	deposits: RawDeposit[];
	withdrawals: RawWithdrawal[];
	warnings: string[];
	allFailed: boolean;
	isComplete: boolean;
}

// cause は元の例外。すべて失敗したときに PrivateApiError の分類（errorType）で fail を返すために残す。
export type FetchResult<T> = { ok: true; data: T } | { ok: false; error: string; cause: unknown };

export interface PnlResult {
	avg_buy_price: number | undefined;
	cost_basis: number | undefined;
	realized_pnl: number;
	trade_count: number;
	/** 代数和なので負になりうる（API に現れない取得の証拠）。原価はクランプ付きの別の数量で出す（#89）。 */
	reconstructed_qty: number;
	priced_deposit_count: number;
	/** 内部判定だけに使って握り潰さない。holdings[].unpriced_deposit_count として出力にも出す（#77）。 */
	unpriced_deposit_count: number;
	/** 超過分は原価ゼロで按分されるので realized_pnl は過大側に寄る。出庫側の同型クランプは数えない（#89）。 */
	qty_clamp_count: number;
	qty_clamp_absorbed_qty: number;
}

export interface PeriodRealizedPnl {
	realized_pnl: number;
	sell_count: number;
	/** 抑止範囲を銘柄単位に絞るための内部フィールドで、wire には出さない（#80）。 */
	sold_assets: string[];
	period_start: string;
	period_end: string;
	/** 期間内ではなく全履歴の件数。wire の旧名 priced_deposit_count は deprecated な別名（#85）。 */
	priced_deposit_count_all_time: number;
	/** 全銘柄の合算。銘柄別の holdings[].unpriced_deposit_count とは別物（#85）。 */
	unpriced_deposit_count_all_time: number;
	/** wire には出さない。期間集計側でも同じ条件が成り立つことをテストで固定するために持つ。 */
	qty_clamp_count: number;
	qty_clamp_absorbed_qty: number;
}

// コスト項は _cost 付きが正（正値で total から引く。#72）。負値で持つ案は、同名で符号が変わると alias で救えないので採らない。
export interface AccountPnl {
	spot_realized_pnl: number | undefined;
	/** 信用の決済済み損益合計（JPY、グロス: 利息・手数料控除前） */
	margin_realized_pnl: number;
	/** @deprecated margin_interest_cost を使う（#72）。 */
	margin_interest: number;
	/** @deprecated margin_fee_cost を使う（#72）。 */
	margin_fee: number;
	/** spot が抑止された実行では undefined（信用側だけの合計を口座全体 PnL として出さない）。 */
	total: number | undefined;
	margin_interest_cost: number;
	/** fee_occurred_amount_quote の合算（実績側）。 */
	margin_fee_cost: number;
	spot_realized_pnl_unavailable_reason: PortfolioUnresolvedDepositReason | undefined;
}

export interface PeriodAccountPnl extends AccountPnl {
	period_start: string;
	period_end: string;
}

// 現在価格だけで換算すると誤差が相場と連動する系統的バイアスになるので、入出庫日の始値を既定にする（#53）。
export interface FlowPricing {
	dailyPrices: Map<string, Map<number, number>>;
	currentPrices: Map<string, number>;
}

export interface FlowValuationTarget {
	asset: string;
	atMs: number;
	kind: 'deposit' | 'withdrawal';
}

export interface FlowValuationBreakdown {
	deposit_date_price_count: number;
	current_price_fallback_count: number;
	basis: PortfolioFlowValuationBasis;
}

export interface DepositWithdrawalSummary {
	total_jpy_deposited: number;
	total_jpy_withdrawn: number;
	net_jpy_invested: number;
	crypto_deposit_count: number;
	crypto_deposit_estimated_jpy: number | undefined;
	crypto_withdrawal_count: number;
	crypto_withdrawal_estimated_jpy: number | undefined;
	account_return_pct: number | undefined;
	account_return_jpy: number | undefined;
	is_complete: boolean;
	analysis_basis: 'deposit_withdrawal' | 'trade_only';
	/** wire 上のキー順は interface や代入順ではなく DepositWithdrawalSummarySchema の宣言順で決まる。 */
	crypto_deposit_valuation?: FlowValuationBreakdown;
	crypto_withdrawal_valuation?: FlowValuationBreakdown;
}

export interface PeriodDWSummary {
	jpy_deposited: number;
	jpy_withdrawn: number;
	net_jpy: number;
	crypto_deposit_count: number;
	crypto_deposit_estimated_jpy: number | undefined;
	crypto_withdrawal_count: number;
	crypto_withdrawal_estimated_jpy: number | undefined;
	period_start: string;
	period_end: string;
	crypto_deposit_valuation?: FlowValuationBreakdown;
	crypto_withdrawal_valuation?: FlowValuationBreakdown;
}

export interface PeriodPerformance {
	start_value_jpy: number;
	current_value_jpy: number;
	change_jpy: number;
	change_pct: number | undefined;
	net_flow_jpy: number | null;
	withdrawal_fee_jpy: number | null;
	adjusted_change_jpy: number | null;
	/** null = 純入出金が未計測、undefined = change_pct と同じ理由で分母が使えない。 */
	adjusted_change_pct: number | undefined | null;
	period_start: string;
	period_end: string;
	note: string;
	/** 「未計測」と「本当にゼロ」を区別できない 0 を返さないための明示フラグ。 */
	flow_measured: boolean;
	flow_unavailable_reason?: PortfolioFlowUnavailableReason;
	unpriced_flow_assets?: string[];
	flow_valuation?: FlowValuationBreakdown;
	unpriced_start_assets?: string[];
	unpriced_current_assets?: string[];
	change_pct_unavailable_reason?: PortfolioChangePctUnavailableReason;
	/** 再計算できる値なので null にせずフラグで申告する（#86）。フラグが無いことは増減額が正しいことを意味しない。 */
	change_jpy_overstated?: boolean;
	/** change_jpy_overstated と同時に true にはならない（両端から落ちる構成では向きが確定しないので立てない）。 */
	change_jpy_understated?: boolean;
}

export interface CandlePriceData {
	boundaryPrices: Map<string, { yearStart?: number; monthStart?: number; dayStart?: number }>;
	dailyPrices: Map<string, Map<number, number>>;
}

export interface EquityPoint {
	timestamp: string;
	value_jpy: number;
	/** この点から次の点までの純入出金（不変条件は value[i+1] - value[i] - flow[i] = 市場変動）。キーが無いことは入出金が無かったことを意味しない。 */
	flow_jpy?: number;
}

export interface PeriodNetFlowResult {
	net_flow_jpy: number | null;
	withdrawal_fee_jpy: number | null;
	measured: boolean;
	/** 資産名だけを申告し、金額は載せない（sensitive-data の HIGH 分類）。該当なしは undefined。 */
	unpriced_assets?: string[];
	valuation?: FlowValuationBreakdown;
}

export interface MarginStatusData extends z.infer<typeof GetMarginStatusDataSchema> {}
export interface MarginPositionsData extends z.infer<typeof GetMarginPositionsDataSchema> {}

export interface MarginAccountInfo {
	status: MarginStatusData | undefined;
	statusFetchFailed: boolean;
	positions: MarginPositionsData | undefined;
	positionsFetchFailed: boolean;
}

export interface TechnicalSummary {
	pair: string;
	trend?: string;
	rsi_14?: number;
	sma_deviation_pct?: number;
	signal?: string;
}

export async function tryGet<T>(
	client: BitbankPrivateClient,
	path: string,
	params?: Record<string, string>,
): Promise<FetchResult<T>> {
	try {
		const data = await client.get<T>(path, params);
		return { ok: true, data };
	} catch (err) {
		return { ok: false, error: getErrorMessage(err), cause: err };
	}
}
