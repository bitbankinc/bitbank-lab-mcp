/**
 * portfolio/types — analyzeMyPortfolioHandler で使用する型定義。
 */

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
	/**
	 * 約定・入出庫リプレイで復元した保有数量。実残高（onhand_amount）との突き合わせに使う。
	 *
	 * 数量不変条件（`qtyInvariantHolds`）の入力そのものなので、`holdings[].reconstructed_qty`
	 * として許容誤差（`holdings[].qty_invariant_tolerance`）と一緒に出力にも露出する（#87）。
	 * 判定結果（`cost_basis_reliable`）だけを出して入力を握り潰すと、消費者は境界付近の妥当性を
	 * 評価できず、API に現れない取引（販売所での売買など）の存在も推定できない。
	 *
	 * **代数和であって「保有量」ではない（#89）。負になりうる。** 原価側と違いゼロ床で
	 * クランプしないので、可視の履歴で説明できる量を超えて売った口座では負の値が出る。
	 * それは異常値ではなく、**API に現れない取得があったことの直接証拠**（負になった銘柄には
	 * `reconstructed_qty_negative` が載る）。原価由来の値（`cost_basis` / `avg_buy_price`）は
	 * これとは別の、クランプ付きの数量で算出している。
	 */
	reconstructed_qty: number;
	/** 入庫日の始値で原価に算入した DONE 暗号資産入庫の件数 */
	priced_deposit_count: number;
	/**
	 * 入庫日の始値を解決できず原価にも数量にも算入しなかった DONE 暗号資産入庫の件数。
	 *
	 * 数量乖離の理由コード判定（`qtyMismatchReasonFor`）の入力。0 より大きければ
	 * 復元数量は実残高より小さくなり得るので、`has_crypto_deposits` の根拠になる。
	 *
	 * 乖離が許容誤差に収まった銘柄では `cost_basis_reliable: true` のまま確定値が出るが、
	 * その原価は本件数ぶんの入庫を欠いたままなので、`holdings[].unpriced_deposit_count`
	 * として出力にも露出する（#77）。内部判定だけに使って握り潰さないこと。
	 */
	unpriced_deposit_count: number;
	/**
	 * 売りの原価按分がゼロ床でクランプされた件数（#89）。
	 *
	 * 「リプレイ上の保有を超える売りがあった」＝ 履歴から積み上げた保有では賄えなかった、
	 * ということ。超過分は原価ゼロ扱いで按分されるため、発火した銘柄の `realized_pnl` は
	 * その分だけ過大側に寄る。`holdings[].qty_clamp_count` として出力にも露出する。
	 * 出庫側の同型クランプは #89 のスコープ外なので数えない（`QtyClampTally` の doc 参照）。
	 */
	qty_clamp_count: number;
	/**
	 * 上の発火で原価側に吸収された数量の合計（base 建て、正値）。
	 *
	 * 旧実装ではこの量がそのまま `reconstructed_qty` を実残高側へ押し戻して乖離を消していた
	 * （#89 の機序）。今は数量を代数和で追うので押し戻しは起きないが、**どれだけの売りが
	 * 原価ゼロで処理されたか**は実現損益の算出条件なので値として残す。
	 */
	qty_clamp_absorbed_qty: number;
}

export interface PeriodRealizedPnl {
	/** 期間内の合計実現損益（JPY） */
	realized_pnl: number;
	/** 期間内の売却約定件数 */
	sell_count: number;
	/**
	 * 期間内に売却があった銘柄（資産コード小文字、重複なし）。
	 *
	 * 抑止判定専用の内部フィールドで wire には出さない。`realized_pnl` は全銘柄を単一
	 * タイムラインで処理した合算値なので、**どの銘柄の原価が欠けると本値が壊れるか**を
	 * ここでしか判定できない。期間内に売却が無い銘柄の原価が欠けても本値は動かないため、
	 * これを使って抑止範囲を必要最小限に絞る（#80）。
	 */
	sold_assets: string[];
	/** 期間の開始日時（ISO8601 JST） */
	period_start: string;
	/** 期間の終了日時（ISO8601 JST） = 取得時点 */
	period_end: string;
	/**
	 * 平均原価の積み上げ（全履歴・全銘柄）で入庫日の始値により原価に算入した
	 * DONE 暗号資産入庫の件数。期間内の入庫だけではない——移動平均法は期間開始前の
	 * 入庫も原価に積むため、`realized_pnl` の算出条件は全履歴のリプレイで決まる。
	 *
	 * wire では `priced_deposit_count_all_time` として出す（#85）。期間オブジェクト内に
	 * 置くと期間スコープに読めるため、名前で全履歴であることを明示する。旧名
	 * `priced_deposit_count` は同じ値を返す deprecated な別名。
	 */
	priced_deposit_count_all_time: number;
	/**
	 * 同じリプレイで入庫日の始値を解決できず原価にも数量にも算入しなかった
	 * DONE 暗号資産入庫の件数（全履歴・全銘柄）。0 より大きければ `realized_pnl` は
	 * 未算入ぶんを原価ゼロで売った結果を含みうる（＝過大側にずれる）。
	 *
	 * wire では `unpriced_deposit_count_all_time` として出す（#85）。
	 * `holdings[].unpriced_deposit_count` とは別物——あちらは銘柄別・全履歴で、
	 * 配置と意味が一致しているので改名しない。
	 */
	unpriced_deposit_count_all_time: number;
	/**
	 * 同じリプレイで売りの原価按分がゼロ床でクランプされた件数（全履歴・全銘柄）（#89）。
	 * 0 より大きければ `realized_pnl` は原価ゼロで按分した売却を含みうる（＝過大側にずれる）。
	 *
	 * **wire には出さない内部フィールド**（`sold_assets` と同じ扱い）。同じ約定集合を銘柄別に
	 * リプレイする `calcPnl` 側が `holdings[].qty_clamp_count` として申告しており、そちらが
	 * 銘柄の内訳まで読める上位互換になるため。ここで持つのは期間集計側でも同じ条件が
	 * 成立していることをテストで固定するため。
	 */
	qty_clamp_count: number;
	/** 上の発火で原価側に吸収された数量の合計（base 建て、正値、全銘柄合算）。wire には出さない */
	qty_clamp_absorbed_qty: number;
}

// ── 口座全体 PnL（現物 + 信用決済損益 - 利息 - 手数料） ──

/**
 * 信用のコスト項（利息・手数料）は **`_cost` サフィックス付きが正**で、コスト = 正値・
 * `total` では減算という符号規約を名前で表す（#72）。サフィックス無しの
 * `margin_interest` / `margin_fee` は同じ値を出し続ける **deprecated な別名**で、
 * `DEPRECATED_FIELD_REMOVAL_TARGET`（`src/schema/base.ts`）で削除する。
 *
 * 「負値で持つ」案は採らない——同じフィールド名で符号の意味が変わる変更は
 * `.claude/rules/tools.md` §7 のとおり alias では救えず、旧フィールドを読み続ける
 * クライアントに黙って符号反転が届くため。
 */
export interface AccountPnl {
	/**
	 * 現物の実現損益（JPY）。
	 * 入庫日価格の取得失敗・打ち切りで銘柄を抑止した実行では `undefined`
	 * （理由は `spot_realized_pnl_unavailable_reason`）。
	 */
	spot_realized_pnl: number | undefined;
	/** 信用の決済済み損益合計（JPY、グロス: 利息・手数料控除前） */
	margin_realized_pnl: number;
	/**
	 * `margin_interest_cost` の別名（同じ正値）。**非推奨**、`DEPRECATED_FIELD_REMOVAL_TARGET` で削除予定。
	 *
	 * @deprecated `margin_interest_cost` を使うこと（#72: 名前から符号規約が読み取れない）。
	 */
	margin_interest: number;
	/**
	 * `margin_fee_cost` の別名（同じ正値）。**非推奨**、`DEPRECATED_FIELD_REMOVAL_TARGET` で削除予定。
	 *
	 * @deprecated `margin_fee_cost` を使うこと（#72: 名前から符号規約が読み取れない）。
	 */
	margin_fee: number;
	/**
	 * 口座全体 PnL = spot_realized_pnl + margin_realized_pnl - margin_interest_cost - margin_fee_cost。
	 * `spot_realized_pnl` が抑止された実行では `undefined`（信用側だけの合計を口座全体 PnL として出さない）。
	 */
	total: number | undefined;
	/**
	 * 信用の支払利息合計（JPY）。**コスト = 正値**で保持し、`total` では**減算**される。
	 * 素直に足し込むと符号が反転するので、`total` を自前で組み直す場合は必ず引くこと。
	 */
	margin_interest_cost: number;
	/**
	 * 信用の発生手数料合計（JPY、`fee_occurred_amount_quote` の合算）。
	 * **コスト = 正値**で保持し、`total` では**減算**される。
	 */
	margin_fee_cost: number;
	/**
	 * `spot_realized_pnl` / `total` を確定値として出せなかった理由（#80）。
	 * 立っているときその 2 つは `undefined`、信用側の 4 フィールドはそのまま出る。
	 */
	spot_realized_pnl_unavailable_reason: PortfolioUnresolvedDepositReason | undefined;
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
	/**
	 * 入庫か出庫か。`fetchFlowDatePrices` が年 chunk の取得予算を入庫用・出庫用に分けるために使う。
	 *
	 * 消費者の性質が違うので予算も分ける必要がある（#76）:
	 * - 入庫は取得原価に算入されるため、解決できないと**実現損益が静かに変わる**
	 * - 出庫は純投入額の減算（表示）にしか使わず、解決できなくても
	 *   `crypto_withdrawal_valuation` で申告したうえで現在価格に落とせる
	 */
	kind: 'deposit' | 'withdrawal';
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
	crypto_withdrawal_estimated_jpy: number | undefined;
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
	/**
	 * `crypto_withdrawal_estimated_jpy` の換算方式の内訳。
	 *
	 * 該当なし（暗号資産出庫が無い / 全件で価格を解決できなかった）のときは `undefined`。
	 * キー順の扱いは `crypto_deposit_valuation` と同じ（スキーマ側が単一ソース）。
	 */
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
	/**
	 * 単純増減率。`undefined` = 期初評価額が分母として使えない
	 * （`change_pct_unavailable_reason` に理由コードが入る）。
	 */
	change_pct: number | undefined;
	/** 期間中の純入出金（元本移動のみ）。`null` = 未計測（`flow_measured: false`） */
	net_flow_jpy: number | null;
	/** 期間中の出金手数料合計。`null` = 未計測（`flow_measured: false`） */
	withdrawal_fee_jpy: number | null;
	/** 調整後増減額 = change_jpy - net_flow_jpy。`null` = 純入出金が未計測で算出不能 */
	adjusted_change_jpy: number | null;
	/**
	 * 調整後増減率。`null` = 純入出金が未計測、`undefined` = `change_pct` と同じ理由で
	 * 分母が使えない（`change_pct_unavailable_reason`）。分母が共通なので `change_pct` と
	 * 同時にしか抑止されない。
	 */
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
	/**
	 * 期初評価額の算出時に当該期間の始値を解決できなかった暗号資産のシンボル一覧
	 * （小文字・昇順・重複なし）。該当資産は `start_value_jpy` に含まれていない（過小）。
	 *
	 * `boundaryPrices` 未登録・当該期間の始値 undefined・3 境界すべて undefined のいずれも対象。
	 * JPY のみ保有のときは `undefined`。`unpriced_flow_assets` と同じ粒度（資産名のみ、金額は出さない）。
	 * `equitySeriesQuality`（資産推移）は別系統の申告で、本フィールドの有無と独立する。
	 * 既存の出力フィールド順を崩さないため末尾に置き、該当なしのときは `undefined`
	 * （JSON.stringify でキーごと落ちるため従来出力と一致する）。
	 */
	unpriced_start_assets?: string[];
	/**
	 * 現在評価額の算出時に現在 ticker 価格を解決できなかった暗号資産のシンボル一覧
	 * （小文字・昇順・重複なし、#109）。該当資産は `current_value_jpy` に含まれていない（過小）。
	 *
	 * `unpriced_start_assets`（期初側・分母）の**対称形**で、こちらは現在側＝分子が欠ける。
	 * 現在価格は `tickers_jpy` 1 回で全銘柄ぶんを取るため、期初価格のような部分失敗ではなく
	 * **全銘柄が一斉に脱落する**のが最悪ケースになる（現在評価額が JPY 残高だけに縮退する）。
	 *
	 * 現在価格は期間に依存しないので 3 期間で同じ値になる。数量ゼロ・数値不正の保有は元から
	 * 評価に寄与しないため対象外（`unpricedStartAssets` と同じ基準）。JPY のみ保有のときは
	 * `undefined`。`unpriced_start_assets` と同じ粒度（資産名のみ、金額は出さない）。
	 * 既存の出力フィールド順を崩さないため末尾に置き、該当なしのときは `undefined`
	 * （JSON.stringify でキーごと落ちるため従来出力と一致する）。
	 */
	unpriced_current_assets?: string[];
	/**
	 * `change_pct` / `adjusted_change_pct` を出せなかった理由（出せた場合は `undefined`）。
	 *
	 * 両フィールドは抑止条件が同じなので、抑止は必ず同時に起きる。
	 * 複数の理由が同時に成立しうるため、優先順位は
	 * `start_boundary_unpriced` > `current_value_unpriced` > `start_value_zero` >
	 * `start_value_negligible` に固定してある（`PortfolioChangePctUnavailableReasonEnum` の doc）。
	 * 既存の出力フィールド順を崩さないため末尾に置き、該当なしのときは `undefined`
	 * （JSON.stringify でキーごと落ちるため従来出力と一致する）。
	 */
	change_pct_unavailable_reason?: PortfolioChangePctUnavailableReason;
	/**
	 * `change_jpy` / `adjusted_change_jpy` が**過大**であることの申告（#105）。
	 * 立たない期間では `undefined`（キーごと落ちるので従来出力と JSON 一致する）。
	 *
	 * `change_jpy = current_value_jpy - start_value_jpy` なので、`unpriced_start_assets` で
	 * 期初評価額から脱落した分はそのまま増減額の過大分になる。`adjusted_change_jpy` は
	 * `change_jpy - net_flow_jpy` で純入出金が分母側と無関係なため、**同じ額だけ**過大になる。
	 *
	 * ただし立つのは `change_pct_unavailable_reason === 'start_boundary_unpriced'` の
	 * **一部**——現在評価額から脱落した保有が 1 つも無いときだけ（`unpriced_current_assets`
	 * が空）。現在評価額も現在 ticker 価格を引けなかった保有を落とすため、そこに 1 つでも
	 * 該当があるとずれの向きが確定せず、「過大」と申告すると抑止したはずの確定値を別の形で
	 * 出すことになる。**本フラグが無いことは「増減額が正しい」の意味ではない**。
	 * `unpriced_start_assets` がありフラグが無い期間は「ずれの向きが確定しない」であり、
	 * どちらの期間でも増減額を運用成績として読んではいけない。
	 *
	 * ## なぜ値を `null` にせずフラグで申告するのか
	 *
	 * - #86 で `start_value_jpy` は「過小でも金額を出し、過小であることを申告する」と決めた。
	 *   `change_jpy` はその差分なので、片方だけ抑止すると同じ壊れ方の 2 値で方針が割れる。
	 * - `change_jpy` は `current_value_jpy - start_value_jpy` で**消費者が再計算できる**。
	 *   null にしても隠蔽にはならず、契約（`change_jpy: number`）だけが壊れる。
	 * - 抑止の眼目は「壊れた値へ誘導しないこと」であって値を消すことではない。誘導文
	 *   （summary / meta.warnings / note）を理由コードで分岐させ、機械可読な申告を本フラグが担う。
	 *
	 * `start_value_negligible` / `start_value_zero` では**立てない**。あちらは期初評価額が
	 * 本当に小さいのであって分子は正しく、増減額をそのまま成績として読める。
	 *
	 * 既存の出力フィールド順を崩さないため末尾に置く。
	 */
	change_jpy_overstated?: boolean;
	/**
	 * `change_jpy` / `adjusted_change_jpy` が**過小**であることの申告（#109）。
	 * `change_jpy_overstated` の対称形で、立たない期間では `undefined`。
	 *
	 * `change_jpy = current_value_jpy - start_value_jpy` なので、`unpriced_current_assets` で
	 * 現在評価額から脱落した分はそのまま増減額の過小分になる。`adjusted_change_jpy` は
	 * `change_jpy - net_flow_jpy` で純入出金が両端の評価額と無関係なため、**同じ額だけ**過小になる。
	 *
	 * 立つのは `change_pct_unavailable_reason === 'current_value_unpriced'` のとき、つまり
	 * 期初評価額からは何も脱落していない（`unpriced_start_assets` が空）ときだけ。両端から
	 * 落ちる構成では向きが確定しないため立てない（そのとき理由コードは
	 * `start_boundary_unpriced` 側になる）。**`change_jpy_overstated` と同時に true にはならない。**
	 *
	 * 値を `null` にせずフラグで申告する理由は `change_jpy_overstated` と同じ
	 * （#86 の「過小でも金額を出して申告する」方針に揃える。両端の評価額から消費者が
	 * 再計算できるので null 化は隠蔽にならず契約だけを壊す）。
	 *
	 * 既存の出力フィールド順を崩さないため末尾に置く。
	 */
	change_jpy_understated?: boolean;
}

export interface CandlePriceData {
	boundaryPrices: Map<string, { yearStart?: number; monthStart?: number; dayStart?: number }>;
	dailyPrices: Map<string, Map<number, number>>;
}

export interface EquityPoint {
	timestamp: string;
	value_jpy: number;
	/**
	 * この点から**次の点まで**の区間に発生した純入出金（元本移動のみ、JPY）。ゼロならキーごと省略。
	 *
	 * ## なぜ「次の点まで」なのか
	 *
	 * `reconstructHoldingsAtDate` は `confirmed_at >= 点の時刻` の入出金を巻き戻すため、
	 * 点 P の `value_jpy` には **P 以降の入出金が入っていない**。P 当日（月次点なら P の月）に
	 * 入金があると、増えた分が現れるのは次の点の `value_jpy` からになる。
	 * つまり不変条件は `value_jpy[i+1] - value_jpy[i] - flow_jpy[i] = 区間 i の市場変動`
	 * （最終点＝現在のリアルタイム評価額も同じ式に載る）。
	 *
	 * この向きなら「その日（その月）に入出金があった」という**発生日そのもの**が点の
	 * `timestamp` と一致する。逆向き（直前の点からこの点まで）に取ると、月次点
	 * `2026-08-01` が 7 月のフローを載せることになり、日付ラベルと発生日がずれる。
	 *
	 * ## 定義の範囲
	 *
	 * - **元本移動のみ。出金手数料を含まない**（`PeriodPerformance.net_flow_jpy` と同一定義）。
	 *   手数料も口座からは出ていくため、上の残差には市場変動と一緒に手数料コストが残る。
	 *   これは `adjusted_change_jpy` の扱い（`PERFORMANCE_NOTE`）と揃えてある。
	 * - JPY の入出金と、JPY 換算できた暗号資産入出庫の合計。換算は `resolveFlowPrice` に従い、
	 *   **入出庫日の始値を解決できなかった分は現在価格にフォールバックする**（その入出庫も
	 *   `flow_jpy` に載る）。つまり本値は全額が入出庫日で固定された評価額とは限らない。
	 *   フォールバックの件数はレスポンス全体で `meta.flowValuationFallbackCount` /
	 *   `meta.flowValuationBasis` と summary 先頭の「n 件は現在価格で仮評価」が申告する。
	 *   どちらでも解決できなかった入出庫は計上せず、資産名は同じ期間を張る
	 *   `PeriodPerformance.unpriced_flow_assets`（月次シリーズ ↔ `monthly_performance`、
	 *   年次シリーズ ↔ `yearly_performance`）で申告済み。本フィールド専用の申告経路は作らない。
	 * - 同じ区間の入金と出金は**純額で相殺**する（日次点ならその日、月次点ならその月の純額）。
	 * - 最終点（現在のリアルタイム評価額）には常に付かない。次の点が無いため区間が空になる。
	 * - 入出金履歴が欠けている構成（取得失敗 / 一部チャネル失敗 / 件数上限による打ち切り
	 *   ＝ `flowUnavailableReasonFor` が理由コードを返す状態）では**全点で落ちる**。部分集合の
	 *   合計を確定値として出すと、`*_performance` が「純入出金: 未計測」と言っている応答で
	 *   点だけが金額を主張する自己矛盾になるため。
	 *
	 * ## キーが無いことの意味
	 *
	 * **「マーカーを出していない」であって「入出金が無かった」ではない。** 次のいずれか:
	 *
	 * 1. その区間に対象の入出金が無い（最も普通のケース）
	 * 2. 入金と出金が相殺して純額がゼロに丸まった
	 * 3. その区間の入出庫がすべて価格解決できず、計上対象が残らなかった
	 *    （資産名は `PeriodPerformance.unpriced_flow_assets` に出る）
	 * 4. 最終点（区間が空）
	 * 5. 入出金履歴が欠けていて全点で抑止した
	 *
	 * 1〜4 は「計測できたうえでマーカーが立たない」、5 は「そもそも計測していない」で意味が違う。
	 * 区別が要るときは `*_performance.flow_measured`（false なら 5）と
	 * `flow_unavailable_reason` を見る。**本フィールドの有無だけでは両者を区別できない。**
	 */
	flow_jpy?: number;
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
