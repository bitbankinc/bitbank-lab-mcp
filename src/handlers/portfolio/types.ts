/**
 * portfolio/types — analyzeMyPortfolioHandler で使用する型定義。
 */

import type { z } from 'zod';
import { getErrorMessage } from '../../../lib/error.js';
import type { BitbankPrivateClient } from '../../private/client.js';
import type {
	GetMarginPositionsDataSchema,
	GetMarginStatusDataSchema,
	PortfolioFlowUnavailableReason,
	PortfolioFlowValuationBasis,
} from '../../private/schemas.js';

// ── Private API レスポンス型 ──

/**
 * bitbank `/v1/user/assets` の `assets[]` 要素（公式 rest-api_JP.md 準拠の単一ソース）。
 *
 * get_my_assets / analyze_my_portfolio の両方がこの型を共有する
 * （フィクスチャ・型が実 API 形からドリフトする再発を防ぐため、定義はここ 1 箇所に集約）。
 * フィールド一覧の社内一次ソースは `docs/internal/bitbank-api-fields.md`。
 */
export interface RawAsset {
	asset: string;
	free_amount: string;
	amount_precision: number;
	onhand_amount: string;
	locked_amount: string;
	/** 出金処理中の数量 */
	withdrawing_amount: string;
	/** 出金手数料。暗号資産は {min,max}、jpy は {under,over,threshold}（カテゴリ C: パススルー） */
	withdrawal_fee: { min: string; max: string } | { under: string; over: string; threshold: string };
	stop_deposit: boolean;
	stop_withdrawal: boolean;
	/** ネットワーク別の入出金設定。jpy など対象外の資産では undefined */
	network_list?: Array<{
		asset: string;
		network: string;
		stop_deposit: boolean;
		stop_withdrawal: boolean;
		withdrawal_fee: string;
	}>;
	/** 代用掛け目（信用取引の担保評価率） */
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

/** bitbank /v1/user/spot/trade_history (type=margin) のレスポンス型 */
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

/**
 * bitbank /v1/user/deposit_history の deposits[] のうち net-flow 計算に使う最小射影。
 *
 * 実 API は `network` / `txid` / `address`（暗号資産入金のみ）も返すが、純入出金額の算出には
 * uuid / asset / amount / status / confirmed_at しか参照しないため、意図的にサブセットへ射影する
 * （`RawWithdrawal` も同方針）。完全形は `tools/private/get_my_deposit_withdrawal.ts` の `RawDeposit`、
 * フィールド一覧の一次ソースは `docs/internal/bitbank-api-fields.md` を参照。
 */
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
	/** 一部の API リクエストが失敗した場合の警告メッセージ */
	warnings: string[];
	/** 全リクエストが失敗した場合 true */
	allFailed: boolean;
	/** 全履歴を取得できたか（false = API 件数上限に達した） */
	isComplete: boolean;
}

/** 個別 API リクエストの結果をラップ */
export type FetchResult<T> = { ok: true; data: T } | { ok: false; error: string };

// ── 損益計算 ──

export interface PnlResult {
	avg_buy_price: number | undefined;
	cost_basis: number | undefined;
	realized_pnl: number;
	trade_count: number;
	/** 約定・出庫リプレイで復元した保有数量。実残高（onhand_amount）との突き合わせに使う */
	reconstructed_qty: number;
}

export interface PeriodRealizedPnl {
	/** 期間内の合計実現損益（JPY） */
	realized_pnl: number;
	/** 期間内の売却約定件数 */
	sell_count: number;
	/** 期間の開始日時（ISO8601 JST） */
	period_start: string;
	/** 期間の終了日時（ISO8601 JST） = 取得時点 */
	period_end: string;
}

// ── 口座全体 PnL（現物 + 信用決済損益 - 利息） ──

export interface AccountPnl {
	/** 現物の実現損益（JPY） */
	spot_realized_pnl: number;
	/** 信用の決済済み損益合計（JPY、グロス: 利息・手数料控除前） */
	margin_realized_pnl: number;
	/** 信用の支払利息合計（JPY、コスト = 正値） */
	margin_interest: number;
	/** 信用の発生手数料合計（JPY、fee_occurred_amount_quote の合算。コスト = 正値） */
	margin_fee: number;
	/** 口座全体 PnL = spot_realized + margin_realized - margin_interest - margin_fee */
	total: number;
}

export interface PeriodAccountPnl extends AccountPnl {
	period_start: string;
	period_end: string;
}

// ── 入出庫の JPY 換算 ──

/**
 * 暗号資産入出庫を JPY 換算するための価格ソース。
 *
 * `dailyPrices` を第一候補、`currentPrices` をフォールバックとする 2 段構えで、
 * どちらで換算したかは `FlowValuationBreakdown` で申告する。
 * 現在価格だけで換算すると誤差が相場と連動して動く系統的バイアスになるため
 * （取引ゼロでも相場上昇だけで報告損益が悪化する。#53 の機序）、
 * 入出庫日の始値による固定評価を既定にする。
 */
export interface FlowPricing {
	/**
	 * asset → (JST 暦日 0:00 ms → 1day open)。`fetchCandlePriceData` の `dailyPrices` と同形式で、
	 * 400 日窓の外にある入出庫のぶんは `fetchFlowDatePrices` が年単位 chunk で追加取得して合流させる。
	 */
	dailyPrices: Map<string, Map<number, number>>;
	/** 入出庫日の日次価格を解決できなかったときのフォールバック（現在 ticker 価格） */
	currentPrices: Map<string, number>;
}

/** 価格解決の対象となる入出庫 1 件（入庫は confirmed_at、出庫は requested_at を `atMs` に取る） */
export interface FlowValuationTarget {
	asset: string;
	atMs: number;
}

/**
 * 暗号資産入出庫の JPY 換算方式の内訳。件数は換算**できた**件数のみを数える
 * （価格を全く解決できなかったぶんは `unpriced_assets` 系で別途申告される）。
 */
export interface FlowValuationBreakdown {
	/** 入出庫日の 1day open で換算できた件数 */
	deposit_date_price_count: number;
	/** 入出庫日の価格を解決できず現在価格で仮評価した件数 */
	current_price_fallback_count: number;
	/** 支配的な換算方式。両方の件数が正のときのみ `mixed` */
	basis: PortfolioFlowValuationBasis;
}

// ── 入出金サマリー ──

export interface DepositWithdrawalSummary {
	total_jpy_deposited: number;
	total_jpy_withdrawn: number;
	net_jpy_invested: number;
	crypto_deposit_count: number;
	crypto_deposit_estimated_jpy: number | undefined;
	crypto_withdrawal_count: number;
	account_return_pct: number | undefined;
	account_return_jpy: number | undefined;
	is_complete: boolean;
	analysis_basis: 'deposit_withdrawal' | 'trade_only';
	/**
	 * `crypto_deposit_estimated_jpy` の換算方式の内訳。
	 *
	 * 該当なし（暗号資産入庫が無い / 全件で価格を解決できなかった）のときは `undefined` で、
	 * JSON.stringify でキーごと落ちる。
	 *
	 * **wire 上のキー順を決めるのは本 interface でも代入順でもなく `DepositWithdrawalSummarySchema`
	 * の宣言順**（`z.object` の parse がスキーマ順でオブジェクトを組み直すため）。
	 * 既存キーの後ろに出すための配置はスキーマ側で担保する。
	 */
	crypto_deposit_valuation?: FlowValuationBreakdown;
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
	/** `crypto_deposit_estimated_jpy` の換算方式の内訳（該当なしなら `undefined`） */
	crypto_deposit_valuation?: FlowValuationBreakdown;
	/** `crypto_withdrawal_estimated_jpy` の換算方式の内訳（該当なしなら `undefined`） */
	crypto_withdrawal_valuation?: FlowValuationBreakdown;
}

// ── パフォーマンス ──

export interface PeriodPerformance {
	start_value_jpy: number;
	current_value_jpy: number;
	change_jpy: number;
	change_pct: number | undefined;
	/** 期間中の純入出金（元本移動のみ）。`null` = 未計測（`flow_measured: false`） */
	net_flow_jpy: number | null;
	/** 期間中の出金手数料合計。`null` = 未計測（`flow_measured: false`） */
	withdrawal_fee_jpy: number | null;
	/** 調整後増減額 = change_jpy - net_flow_jpy。`null` = 純入出金が未計測で算出不能 */
	adjusted_change_jpy: number | null;
	/** 調整後増減率。`undefined` = start_value_jpy が 0、`null` = 純入出金が未計測 */
	adjusted_change_pct: number | undefined | null;
	period_start: string;
	period_end: string;
	note: string;
	/**
	 * 期間中の純入出金を実測できたか。
	 *
	 * false のとき net_flow_jpy / withdrawal_fee_jpy / adjusted_change_jpy はすべて `null`。
	 * 「未計測」と「本当にゼロ」を区別できない 0 を返さないための明示フラグで、
	 * 理由は `flow_unavailable_reason` に載る。
	 */
	flow_measured: boolean;
	/**
	 * 純入出金を実測できなかった理由（`flow_measured: false` のときのみ存在）。
	 *
	 * 既存の出力フィールド順を崩さないため `note` の後ろに置き、該当なしのときは `undefined`
	 * （JSON.stringify でキーごと落ちる）。
	 */
	flow_unavailable_reason?: PortfolioFlowUnavailableReason;
	/**
	 * net_flow_jpy の算出時に現在価格を解決できなかった暗号資産のシンボル一覧
	 * （`PeriodNetFlowResult.unpriced_assets` の転記。小文字・昇順・重複なし）。
	 *
	 * この資産の入出庫は net_flow_jpy に計上されていない。ずれの向きは方向で逆になり、
	 * 未計上が入庫なら net_flow_jpy は過小、出庫なら過大。`adjusted_change_jpy` は
	 * `change_jpy - net_flow_jpy` なので常に net_flow_jpy と逆向きにずれる。
	 * 既存の出力フィールド順を崩さないため末尾に置き、該当なしのときは `undefined`
	 * （JSON.stringify でキーごと落ちるため従来出力と一致する）。
	 */
	unpriced_flow_assets?: string[];
	/**
	 * net_flow_jpy に計上した暗号資産入出庫の換算方式の内訳（`PeriodNetFlowResult.valuation` の転記）。
	 *
	 * 期間中に換算した暗号資産入出庫が無いときは `undefined`（JPY のみの入出金は換算不要なので
	 * 数えない）。wire 上のキー順は `PeriodPerformanceSchema` の宣言順が決める
	 * （`crypto_deposit_valuation` と同じ理由。そちらの doc を参照）。
	 */
	flow_valuation?: FlowValuationBreakdown;
}

export interface CandlePriceData {
	boundaryPrices: Map<string, { yearStart?: number; monthStart?: number; dayStart?: number }>;
	dailyPrices: Map<string, Map<number, number>>;
}

export interface EquityPoint {
	timestamp: string;
	value_jpy: number;
}

export interface PeriodNetFlowResult {
	/** 純入出金額（元本移動のみ。出金手数料は含まない）。`null` = 未計測（`measured: false`） */
	net_flow_jpy: number | null;
	/** 期間中の出金手数料合計（JPY）。コストとして performance に残る。`null` = 未計測 */
	withdrawal_fee_jpy: number | null;
	/**
	 * 入出金履歴から実際に集計できたか。
	 *
	 * false のとき net_flow_jpy / withdrawal_fee_jpy は `null`。入出金履歴が無い状態で 0 を
	 * 返すと呼び出し側が「フローゼロ」として扱ってしまうため、値そのものを立てない。
	 */
	measured: boolean;
	/**
	 * 現在価格を解決できず net_flow_jpy に計上できなかった暗号資産のシンボル一覧（小文字・昇順・重複なし）。
	 *
	 * 落ちた入出庫は 0 円計上と等価。入庫を落とすと net_flow_jpy は過小に、出庫を落とすと過大に
	 * なる（出庫では withdrawal_fee_jpy も過小）。読み手が欠落に気づけるよう
	 * 資産名のみを申告する（金額は載せない: `.claude/rules/sensitive-data.md` の HIGH 分類）。
	 * 該当なしのときは `undefined`（空配列を返さないことで従来の出力と JSON 上で完全一致する）。
	 */
	unpriced_assets?: string[];
	/**
	 * net_flow_jpy に計上した暗号資産入出庫の換算方式の内訳。
	 *
	 * 換算対象（DONE・非 JPY・数量が正）が 1 件も無い場合、および全件で価格を解決できなかった
	 * 場合は `undefined`。`unpriced_assets` と同じく、該当なしでキーを落として従来出力と JSON 一致させる。
	 */
	valuation?: FlowValuationBreakdown;
}

// ── 信用口座状態・建玉 ──

export interface MarginStatusData extends z.infer<typeof GetMarginStatusDataSchema> {}
export interface MarginPositionsData extends z.infer<typeof GetMarginPositionsDataSchema> {}

/**
 * 信用口座の状態と建玉サマリ。
 *
 * `get_margin_status` と `get_margin_positions` の結果を集約し、
 * 取得成否を独立フラグで保持する。片方失敗・両方失敗のいずれでも上位は
 * 原因切り分けが可能（PR #2 で導入した marginFetchFailed と同じ思想）。
 */
export interface MarginAccountInfo {
	/** 取得成功時の信用口座状態。失敗・未提供時は undefined */
	status: MarginStatusData | undefined;
	/** get_margin_status の取得失敗フラグ */
	statusFetchFailed: boolean;
	/** 取得成功時の信用建玉一覧 */
	positions: MarginPositionsData | undefined;
	/** get_margin_positions の取得失敗フラグ */
	positionsFetchFailed: boolean;
}

// ── テクニカル ──

export interface TechnicalSummary {
	pair: string;
	trend?: string;
	rsi_14?: number;
	sma_deviation_pct?: number;
	signal?: string;
}

// ── API ヘルパー ──

export async function tryGet<T>(
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
