/**
 * プライベート API 系の Zod スキーマ。
 * src/schemas.ts から re-export され、単一ソースの原則を維持する。
 */

import { z } from 'zod';

// FailResultSchema を直接定義（schemas.ts からの循環参照を避けるため）
const PrivateFailResultSchema = z.object({
	ok: z.literal(false),
	summary: z.string(),
	data: z.object({}).passthrough(),
	meta: z.object({ errorType: z.string() }).passthrough(),
});

// ── get_my_assets ──

export const GetMyAssetsInputSchema = z.object({
	include_jpy_valuation: z.boolean().default(true).describe('各通貨の日本円評価額を含めるか'),
});

const AssetItemSchema = z.object({
	asset: z.string().describe('通貨コード（例: btc, jpy）'),
	amount: z.string().describe('総保有量'),
	available_amount: z.string().describe('利用可能量'),
	locked_amount: z.string().describe('ロック中の量'),
	jpy_value: z.number().optional().describe('日本円評価額'),
	allocation_pct: z.number().optional().describe('構成比（%）'),
});

export const GetMyAssetsDataSchema = z.object({
	assets: z.array(AssetItemSchema),
	total_jpy_value: z.number().optional(),
	timestamp: z.string(),
});

export const GetMyAssetsMetaSchema = z.object({
	fetchedAt: z.string(),
	assetCount: z.number().int(),
	hasJpyValuation: z.boolean(),
});

export const GetMyAssetsOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: GetMyAssetsDataSchema,
		meta: GetMyAssetsMetaSchema,
	}),
	PrivateFailResultSchema,
]);

// ── get_my_trade_history ──

export const GetMyTradeHistoryInputSchema = z.object({
	pair: z.string().optional().describe('通貨ペア（例: btc_jpy）。省略で全ペア'),
	count: z.number().max(10000).default(100).describe('取得件数（最大10000、1000超は自動ページネーション）'),
	order: z.enum(['asc', 'desc']).default('desc').describe('ソート順（asc: 古い順, desc: 新しい順）'),
	since: z.string().optional().describe('開始日時（ISO8601、例: 2025-01-01T00:00:00+09:00）'),
	end: z.string().optional().describe('終了日時（ISO8601、例: 2025-12-31T23:59:59+09:00）'),
});

const TradeItemSchema = z.object({
	trade_id: z.number().describe('約定ID'),
	pair: z.string().describe('通貨ペア'),
	order_id: z.number().describe('注文ID'),
	side: z.string().describe('売買（buy / sell）'),
	position_side: z
		.string()
		.optional()
		.describe(
			'建玉方向（long / short）。現物約定では通常 undefined。値がある場合は信用約定が混入している（本ツールは現物専用のため通常は出ない。詳細は get_margin_trade_history を参照）',
		),
	type: z.string().describe('注文タイプ（limit / market）'),
	amount: z.string().describe('約定数量'),
	price: z.string().describe('約定価格'),
	maker_taker: z.string().describe('メイカー / テイカー'),
	fee_amount_base: z.string().describe('手数料（基軸通貨）'),
	fee_amount_quote: z.string().describe('手数料（決済通貨）'),
	fee_occurred_amount_quote: z
		.string()
		.optional()
		.describe('実際に発生した決済通貨手数料（現物では fee_amount_quote と同値、信用で乖離する可能性）'),
	executed_at: z.string().describe('約定日時（ISO8601）'),
});

export const GetMyTradeHistoryDataSchema = z.object({
	trades: z.array(TradeItemSchema),
	timestamp: z.string(),
});

export const GetMyTradeHistoryMetaSchema = z.object({
	fetchedAt: z.string(),
	tradeCount: z.number().int(),
	pair: z.string().optional(),
	isComplete: z
		.boolean()
		.optional()
		.describe(
			'期間内全件を取得できたか。count 制限で打ち切られた場合や MAX_PAGES 到達時は false（取得範囲外に未取得レコードがある可能性）',
		),
});

export const GetMyTradeHistoryOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: GetMyTradeHistoryDataSchema,
		meta: GetMyTradeHistoryMetaSchema,
	}),
	PrivateFailResultSchema,
]);

// ── get_my_orders ──

export const GetMyOrdersInputSchema = z.object({
	pair: z.string().optional().describe('通貨ペア（例: btc_jpy）。省略で全ペア'),
	count: z.number().max(1000).default(100).describe('取得件数（最大1000）'),
	since: z.string().optional().describe('開始日時（ISO8601）'),
	end: z.string().optional().describe('終了日時（ISO8601）'),
});

const OrderItemSchema = z.object({
	order_id: z.number().describe('注文ID'),
	pair: z.string().describe('通貨ペア'),
	side: z.string().describe('売買（buy / sell）'),
	type: z.string().describe('注文タイプ（limit / market / stop 等）'),
	start_amount: z.string().optional().describe('注文数量'),
	remaining_amount: z.string().optional().describe('未約定数量'),
	executed_amount: z.string().optional().describe('約定済み数量'),
	price: z.string().optional().describe('指値価格'),
	average_price: z.string().optional().describe('平均約定価格'),
	status: z.string().describe('注文ステータス'),
	ordered_at: z.string().describe('注文日時（ISO8601）'),
	expire_at: z.string().optional().describe('有効期限（ISO8601）'),
});

export const GetMyOrdersDataSchema = z.object({
	orders: z.array(OrderItemSchema),
	timestamp: z.string(),
});

export const GetMyOrdersMetaSchema = z.object({
	fetchedAt: z.string(),
	orderCount: z.number().int(),
	pair: z.string().optional(),
});

export const GetMyOrdersOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: GetMyOrdersDataSchema,
		meta: GetMyOrdersMetaSchema,
	}),
	PrivateFailResultSchema,
]);

// ── analyze_my_portfolio（Phase 3） ──

export const AnalyzeMyPortfolioInputSchema = z.object({
	include_technical: z.boolean().default(true).describe('保有銘柄のテクニカル分析を含めるか'),
	include_pnl: z.boolean().default(true).describe('損益分析を含めるか（約定履歴から平均取得単価・損益を算出）'),
	include_deposit_withdrawal: z
		.boolean()
		.default(true)
		.describe(
			'入出金データを含めるか（true の場合、総入金額 vs 現在評価額で口座全体のリターンを算出。ページネーション対応で最大1000件/チャネル取得）',
		),
});

const HoldingPnlSchema = z.object({
	asset: z.string().describe('通貨コード'),
	pair: z.string().describe('通貨ペア（例: btc_jpy）'),
	amount: z.string().describe('保有数量'),
	avg_buy_price: z.number().optional().describe('平均取得単価（JPY）'),
	current_price: z.number().optional().describe('現在価格（JPY）'),
	jpy_value: z.number().optional().describe('現在の評価額（JPY）'),
	cost_basis: z.number().optional().describe('取得原価合計（JPY）'),
	unrealized_pnl: z.number().optional().describe('評価損益（JPY）'),
	unrealized_pnl_pct: z.number().optional().describe('評価損益率（%）'),
	realized_pnl: z.number().optional().describe('実現損益（JPY）'),
	trade_count: z.number().optional().describe('約定件数'),
});

const HoldingPerformanceSchema = z.object({
	asset: z.string().describe('通貨コード'),
	pair: z.string().describe('通貨ペア（例: btc_jpy）'),
	current_price: z.number().optional().describe('現在価格（JPY）'),
	monthly_change_pct: z
		.number()
		.optional()
		.describe('月初比騰落率（%）。月初始値 → 現在価格の変動率。月初の価格データがない場合は undefined'),
	yearly_change_pct: z
		.number()
		.optional()
		.describe('年初比騰落率（%）。年初始値 → 現在価格の変動率。年初の価格データがない場合は undefined'),
	jpy_value: z.number().optional().describe('現在の評価額（JPY）'),
	amount: z.string().describe('保有数量'),
});

const TechnicalSummarySchema = z.object({
	pair: z.string().describe('通貨ペア'),
	trend: z.string().optional().describe('トレンド判定'),
	rsi_14: z.number().optional().describe('RSI(14)'),
	sma_deviation_pct: z.number().optional().describe('SMA(25)乖離率（%）'),
	signal: z.string().optional().describe('総合判定'),
});

const DepositWithdrawalSummarySchema = z
	.object({
		total_jpy_deposited: z.number().describe('JPY 入金合計'),
		total_jpy_withdrawn: z.number().describe('JPY 出金合計'),
		net_jpy_invested: z
			.number()
			.describe(
				'純投入額（JPY入金 - JPY出金 + 暗号資産入庫の現在価格での仮評価）。暗号資産入庫がある場合は JPY 純入金だけでなく仮評価分も含む',
			),
		crypto_deposit_count: z.number().describe('暗号資産入庫件数'),
		crypto_deposit_estimated_jpy: z
			.number()
			.optional()
			.describe('暗号資産入庫の推定 JPY 評価額（現在の市場価格で仮評価。入庫時点の価格ではない）'),
		crypto_withdrawal_count: z.number().describe('暗号資産出庫件数'),
		account_return_pct: z.number().optional().describe('口座全体リターン率（%）: (現在評価額 - 純投入額) / 純投入額'),
		account_return_jpy: z.number().optional().describe('口座全体リターン額（JPY）'),
		is_complete: z
			.boolean()
			.describe('全履歴を取得できたか（false の場合は API 件数上限により一部のみ取得。リターンは概算値）'),
		analysis_basis: z
			.enum(['deposit_withdrawal', 'trade_only'])
			.describe('分析基準（deposit_withdrawal: 入出金込み, trade_only: 約定ベース）'),
	})
	.optional()
	.describe(
		'入出金ベースのリターン分析。available: 実データ（analysis_basis=deposit_withdrawal）、fallback: 常にplaceholder（analysis_basis=trade_only）、no_history/not_requested: undefined',
	);

const PeriodDWSummarySchema = z
	.object({
		jpy_deposited: z.number().describe('期間中のJPY入金合計'),
		jpy_withdrawn: z.number().describe('期間中のJPY出金合計'),
		net_jpy: z.number().describe('純入出金（JPY入金 - JPY出金）'),
		crypto_deposit_count: z.number().int().describe('期間中の暗号資産入庫件数'),
		crypto_deposit_estimated_jpy: z
			.number()
			.optional()
			.describe('期間中の暗号資産入庫の推定JPY評価額（現在価格で仮評価）'),
		crypto_withdrawal_count: z.number().int().describe('期間中の暗号資産出庫件数'),
		crypto_withdrawal_estimated_jpy: z
			.number()
			.optional()
			.describe('期間中の暗号資産出庫の推定JPY評価額（現在価格で仮評価）'),
		period_start: z.string().describe('期間の開始日時（ISO8601 JST）'),
		period_end: z.string().describe('期間の終了日時（ISO8601 JST）'),
	})
	.optional()
	.describe('期間内の入出金サマリー');

const PeriodRealizedPnlSchema = z
	.object({
		realized_pnl: z.number().describe('期間内の合計実現損益（JPY）'),
		sell_count: z.number().int().describe('期間内の売却約定件数'),
		period_start: z.string().describe('期間の開始日時（ISO8601 JST）'),
		period_end: z.string().describe('期間の終了日時（ISO8601 JST）'),
	})
	.optional();

const AccountPnlSchema = z.object({
	spot_realized_pnl: z.number().describe('現物の実現損益（JPY）'),
	margin_realized_pnl: z.number().describe('信用の決済済み損益（JPY、グロス: 利息・手数料控除前）'),
	margin_interest: z.number().describe('信用の支払利息合計（JPY、コスト = 正値）'),
	margin_fee: z.number().describe('信用の発生手数料合計（JPY、fee_occurred_amount_quote の合算。コスト = 正値）'),
	total: z.number().describe('口座全体 PnL = spot + margin - interest - fee'),
});

const PeriodAccountPnlSchema = AccountPnlSchema.extend({
	period_start: z.string().describe('期間の開始日時（ISO8601 JST）'),
	period_end: z.string().describe('期間の終了日時（ISO8601 JST）'),
});

const PeriodPerformanceSchema = z
	.object({
		start_value_jpy: z
			.number()
			.describe('期初の口座評価額（JPY）。現在の保有状態から約定・入出金を逆算して復元し、期初時点の始値で評価'),
		current_value_jpy: z.number().describe('現在の口座評価額（JPY）'),
		change_jpy: z.number().describe('単純増減額 = current_value_jpy - start_value_jpy'),
		change_pct: z.number().optional().describe('単純増減率（%）。start_value_jpy が 0 の場合は undefined'),
		net_flow_jpy: z
			.number()
			.describe(
				'期間中の純入出金額（JPY、元本移動のみ）。正=純入金、負=純出金。出金手数料は含まない。暗号資産の入出庫は現在価格で仮評価',
			),
		withdrawal_fee_jpy: z
			.number()
			.describe(
				'期間中の出金手数料合計（JPY）。出金元本は外部フローとして net_flow_jpy に含め performance から除外するが、手数料はコストとして adjusted_change_jpy に残る',
			),
		adjusted_change_jpy: z
			.number()
			.describe('調整後増減額 = change_jpy - net_flow_jpy（入出金元本の影響を除いた成績。出金手数料コストは含む）'),
		adjusted_change_pct: z.number().optional().describe('調整後増減率（%）。start_value_jpy が 0 の場合は undefined'),
		period_start: z.string().describe('期間の開始日時（ISO8601 JST）'),
		period_end: z.string().describe('期間の終了日時（ISO8601 JST）'),
		note: z.string().describe('計算方法・注意事項の説明'),
	})
	.optional();

const EquityPointSchema = z.object({
	timestamp: z.string().describe('時点の日時（ISO8601 JST）'),
	value_jpy: z.number().describe('その時点のJPY建て総資産額（円）'),
});

export const AnalyzeMyPortfolioDataSchema = z.object({
	holdings: z.array(HoldingPnlSchema).describe('保有銘柄一覧（JPY評価額降順）'),
	total_jpy_value: z.number().optional().describe('ポートフォリオ合計評価額'),
	total_cost_basis: z.number().optional().describe('ポートフォリオ合計取得原価'),
	total_unrealized_pnl: z.number().optional().describe('合計評価損益'),
	total_unrealized_pnl_pct: z.number().optional().describe('合計評価損益率（%）'),
	total_realized_pnl: z.number().optional().describe('合計実現損益（全履歴ベース）'),
	daily_performance: PeriodPerformanceSchema.describe('前日比パフォーマンス（当日0:00 JST〜現在の口座評価額増減）'),
	yearly_performance: PeriodPerformanceSchema.describe(
		'年初比パフォーマンス（当年1/1 00:00 JST〜現在の口座評価額増減）',
	),
	monthly_performance: PeriodPerformanceSchema.describe(
		'月初比パフォーマンス（当月1日 00:00 JST〜現在の口座評価額増減）',
	),
	monthly_equity_series: z
		.array(EquityPointSchema)
		.optional()
		.describe(
			'当月1日 00:00 JSTから現在までの日次JPY建て総資産推移。各点はその日00:00 JST時点の復元評価額。最終点は現在のリアルタイム評価額',
		),
	yearly_equity_series: z
		.array(EquityPointSchema)
		.optional()
		.describe(
			'当年1/1 00:00 JSTから現在までの月次JPY建て総資産推移。各点はその月1日 00:00 JST時点の復元評価額。最終点は現在のリアルタイム評価額',
		),
	yearly_realized_pnl: PeriodRealizedPnlSchema.describe('年初来実現損益（現物単独、補助指標）'),
	monthly_realized_pnl: PeriodRealizedPnlSchema.describe('月初来実現損益（現物単独、補助指標）'),
	account_pnl: AccountPnlSchema.optional().describe(
		'全履歴の口座全体 PnL（現物実現損益 + 信用決済損益 - 信用支払利息 - 信用発生手数料）の約定ベース集計',
	),
	yearly_account_pnl: PeriodAccountPnlSchema.optional().describe(
		'年初来の口座全体 PnL（現物 + 信用決済損益 - 利息 - 手数料）',
	),
	monthly_account_pnl: PeriodAccountPnlSchema.optional().describe(
		'月初来の口座全体 PnL（現物 + 信用決済損益 - 利息 - 手数料）',
	),
	deposit_withdrawal_summary: DepositWithdrawalSummarySchema,
	yearly_dw_summary: PeriodDWSummarySchema.describe('年初来の入出金サマリー（当年1/1 00:00 JST〜現在）'),
	monthly_dw_summary: PeriodDWSummarySchema.describe('月初来の入出金サマリー（当月1日 00:00 JST〜現在）'),
	holdings_performance: z
		.array(HoldingPerformanceSchema)
		.optional()
		.describe('保有銘柄の月初比・年初比の価格騰落率（暗号資産のみ。JPY評価額降順）'),
	technical: z.array(TechnicalSummarySchema).optional().describe('テクニカル分析サマリー'),
	timestamp: z.string(),
});

export const AnalyzeMyPortfolioMetaSchema = z.object({
	fetchedAt: z.string(),
	holdingCount: z.number().int(),
	hasPnl: z.boolean(),
	hasTechnical: z.boolean(),
	depositWithdrawalStatus: z
		.enum(['available', 'fallback', 'no_history', 'not_requested'])
		.describe(
			'入出金分析の状態: available=入出金データ取得成功で分析実行（deposit_withdrawal_summaryあり）, fallback=API取得失敗またはpartial failureにより約定ベースにフォールバック（deposit_withdrawal_summaryはtrade_only placeholder）, no_history=API取得成功・警告なし・履歴0件（deposit_withdrawal_summaryはundefined）, not_requested=未リクエスト（deposit_withdrawal_summaryはundefined）',
		),
	periodBasis: z.enum(['jst']).default('jst').describe('年次・月次の期間基準タイムゾーン（jst = Asia/Tokyo）'),
	tradesTruncated: z
		.boolean()
		.describe(
			'現物約定履歴の取得が不完全（paginateTrades が MAX_PAGES / API エラー / lastTs 欠損などで途中終了）。true のとき損益計算が不正確な可能性。',
		),
	marginTradesTruncated: z
		.boolean()
		.describe(
			'信用約定履歴の取得が不完全（paginateMarginTrades が MAX_PAGES / API エラー / lastTs 欠損などで途中終了）。true のとき信用 PnL が不正確な可能性。',
		),
	marginFetchFailed: z
		.boolean()
		.describe(
			'信用約定 API（type=margin）が途中で失敗した。true のとき margin_realized_pnl=0 が「信用未使用」ではなく「取得失敗による欠落」を意味する点に注意。',
		),
});

export const AnalyzeMyPortfolioOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: AnalyzeMyPortfolioDataSchema,
		meta: AnalyzeMyPortfolioMetaSchema,
	}),
	PrivateFailResultSchema,
]);

// ── get_my_deposit_withdrawal（Phase 4） ──

export const GetMyDepositWithdrawalInputSchema = z.object({
	asset: z
		.string()
		.optional()
		.describe('通貨コード（例: btc, jpy）。省略で全通貨。JPY入出金を取得するには "jpy" を指定'),
	type: z
		.enum(['deposit', 'withdrawal', 'all'])
		.default('all')
		.describe('取得タイプ（deposit: 入金/入庫のみ, withdrawal: 出金/出庫のみ, all: 両方）'),
	count: z.number().max(100).default(25).describe('各履歴の取得件数（最大100）'),
	since: z.string().optional().describe('開始日時（ISO8601、例: 2025-01-01T00:00:00+09:00）'),
	end: z.string().optional().describe('終了日時（ISO8601、例: 2025-12-31T23:59:59+09:00）'),
});

const DepositItemSchema = z.object({
	uuid: z.string().describe('入金/入庫ID'),
	asset: z.string().describe('通貨コード'),
	amount: z.string().describe('金額/数量'),
	network: z.string().optional().describe('ネットワーク（暗号資産のみ）'),
	txid: z.string().optional().describe('トランザクションID（暗号資産のみ）'),
	status: z.string().describe('ステータス（FOUND / CONFIRMED / DONE）'),
	found_at: z.string().optional().describe('検出日時（ISO8601）'),
	confirmed_at: z.string().optional().describe('確認日時（ISO8601）'),
});

const WithdrawalItemSchema = z.object({
	uuid: z.string().describe('出金/出庫ID'),
	asset: z.string().describe('通貨コード'),
	amount: z.string().describe('金額/数量'),
	fee: z.string().optional().describe('手数料'),
	network: z.string().optional().describe('ネットワーク（暗号資産のみ）'),
	txid: z.string().optional().describe('トランザクションID（暗号資産のみ）'),
	label: z.string().optional().describe('ラベル'),
	address: z.string().optional().describe('送金先アドレス（暗号資産のみ）'),
	bank_name: z.string().optional().describe('銀行名（JPY出金のみ）'),
	status: z.string().describe('ステータス（CONFIRMING / EXAMINING / SENDING / DONE / REJECTED / CANCELED）'),
	requested_at: z.string().optional().describe('リクエスト日時（ISO8601）'),
});

export const GetMyDepositWithdrawalDataSchema = z.object({
	deposits: z.array(DepositItemSchema),
	withdrawals: z.array(WithdrawalItemSchema),
	timestamp: z.string(),
});

export const GetMyDepositWithdrawalMetaSchema = z.object({
	fetchedAt: z.string(),
	depositCount: z.number().int(),
	withdrawalCount: z.number().int(),
	asset: z.string().optional(),
	isComplete: z.boolean().describe('全履歴を取得できたか（false の場合は API 件数上限に達し一部のみ取得）'),
	hasWarnings: z.boolean().describe('一部の API リクエストが失敗した警告があるか'),
	warnings: z.array(z.string()).describe('警告メッセージ一覧（partial failure 時の詳細。空配列 = 警告なし）'),
});

export const GetMyDepositWithdrawalOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: GetMyDepositWithdrawalDataSchema,
		meta: GetMyDepositWithdrawalMetaSchema,
	}),
	PrivateFailResultSchema,
]);

// ── get_margin_status ──

export const GetMarginStatusInputSchema = z.object({});

const MarginAccountStatus = z.enum(['NORMAL', 'LOSSCUT', 'CALL', 'DEBT', 'SETTLED']);

export const GetMarginStatusDataSchema = z.object({
	status: MarginAccountStatus,
	total_margin_balance: z.string().describe('保証金合計額'),
	total_margin_balance_percentage: z.string().nullable().describe('保証金率（%、建玉なし時は null）'),
	margin_position_profit_loss: z.string().describe('建玉含み損益'),
	unrealized_cost: z.string().describe('未実現コスト（未収手数料・未収利息）'),
	total_margin_position_product: z.string().describe('建玉総評価額'),
	open_margin_position_product: z.string().describe('保有建玉評価額'),
	open_margin_order_product: z.string().describe('注文中建玉評価額'),
	total_position_maintenance_margin: z.string().describe('維持保証金合計'),
	total_long_position_maintenance_margin: z.string().describe('ロング維持保証金'),
	total_short_position_maintenance_margin: z.string().describe('ショート維持保証金'),
	total_open_order_maintenance_margin: z.string().describe('注文維持保証金'),
	total_long_open_order_maintenance_margin: z.string().describe('ロング注文維持保証金'),
	total_short_open_order_maintenance_margin: z.string().describe('ショート注文維持保証金'),
	losscut_rate: z.string().nullable().describe('強制決済率（%、建玉なし時は null）'),
	available_long_margin: z.string().describe('ロング新規建てご利用可能額'),
	available_short_margin: z.string().describe('ショート新規建てご利用可能額'),
	timestamp: z.string(),
});

export const GetMarginStatusMetaSchema = z.object({
	fetchedAt: z.string(),
	hasWarning: z.boolean(),
});

export const GetMarginStatusOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: GetMarginStatusDataSchema,
		meta: GetMarginStatusMetaSchema,
	}),
	PrivateFailResultSchema,
]);

// ── get_margin_positions ──

export const GetMarginPositionsInputSchema = z.object({
	pair: z.string().optional().describe('通貨ペア（例: btc_jpy）。省略で全ペア'),
});

const MarginPositionSchema = z.object({
	pair: z.string().describe('通貨ペア'),
	position_side: z.enum(['long', 'short']).describe('ロング / ショート'),
	open_amount: z.string().describe('建玉数量'),
	product: z.string().describe('建玉評価額'),
	average_price: z.string().describe('平均取得価格'),
	unrealized_fee_amount: z.string().describe('未収手数料'),
	unrealized_interest_amount: z.string().describe('未収利息'),
});

const MarginNoticeSchema = z
	.object({
		what: z.string().describe('追証・不足金の種別'),
		occurred_at: z.number().describe('発生日時（unix ms）'),
		amount: z.string().describe('追証・不足金額'),
		due_date_at: z.number().describe('期日（unix ms）'),
	})
	.nullable();

export const GetMarginPositionsDataSchema = z.object({
	positions: z.array(MarginPositionSchema),
	notice: MarginNoticeSchema.describe('追証・不足金情報（なければ null）'),
	payables: z.object({ amount: z.string() }).describe('不足金額'),
	losscut_threshold: z.object({
		individual: z.string().describe('個人強制決済閾値'),
		company: z.string().describe('法人強制決済閾値'),
	}),
	timestamp: z.string(),
});

export const GetMarginPositionsMetaSchema = z.object({
	fetchedAt: z.string(),
	positionCount: z.number().int(),
	pair: z.string().optional(),
	hasNotice: z.boolean(),
});

export const GetMarginPositionsOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: GetMarginPositionsDataSchema,
		meta: GetMarginPositionsMetaSchema,
	}),
	PrivateFailResultSchema,
]);

// ── get_margin_trade_history ──

export const GetMarginTradeHistoryInputSchema = z.object({
	pair: z.string().optional().describe('通貨ペア（例: btc_jpy）。省略で全ペア'),
	count: z.number().max(10000).default(20).describe('取得件数（最大10000、1000超は自動ページネーション）'),
	order: z.enum(['asc', 'desc']).default('desc').describe('ソート順（asc: 古い順, desc: 新しい順）'),
	since: z.string().optional().describe('開始日時（ISO8601、例: 2025-01-01T00:00:00+09:00）'),
	end: z.string().optional().describe('終了日時（ISO8601、例: 2025-12-31T23:59:59+09:00）'),
});

const MarginTradeItemSchema = z.object({
	trade_id: z.number().describe('約定ID'),
	pair: z.string().describe('通貨ペア'),
	order_id: z.number().describe('注文ID'),
	side: z.string().describe('売買（buy / sell）'),
	position_side: z.string().optional().describe('建玉方向（long / short）'),
	type: z.string().describe('注文タイプ'),
	amount: z.string().describe('約定数量'),
	price: z.string().describe('約定価格'),
	maker_taker: z.string().describe('メイカー / テイカー'),
	fee_amount_base: z.string().describe('手数料（基軸通貨）'),
	fee_amount_quote: z.string().describe('手数料（決済通貨）'),
	fee_occurred_amount_quote: z
		.string()
		.optional()
		.describe('実際に発生した決済通貨手数料（現物では fee_amount_quote と同値、信用で乖離する可能性）'),
	profit_loss: z.string().optional().describe('実現損益（決済時のみ）'),
	interest: z.string().optional().describe('利息（決済時のみ）'),
	executed_at: z.string().describe('約定日時（ISO8601）'),
});

export const GetMarginTradeHistoryDataSchema = z.object({
	trades: z.array(MarginTradeItemSchema),
	timestamp: z.string(),
});

export const GetMarginTradeHistoryMetaSchema = z.object({
	fetchedAt: z.string(),
	tradeCount: z.number().int(),
	pair: z.string().optional(),
	isComplete: z
		.boolean()
		.optional()
		.describe('期間内全件を取得できたか。count 制限で打ち切られた場合や MAX_PAGES 到達時、cursor 進捗停止時は false'),
});

export const GetMarginTradeHistoryOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: GetMarginTradeHistoryDataSchema,
		meta: GetMarginTradeHistoryMetaSchema,
	}),
	PrivateFailResultSchema,
]);

// ── Trading: 注文レスポンス共通スキーマ ──

/**
 * bitbank 注文ステータス（公式 REST API spec 準拠）
 *
 * - INACTIVE: stop / stop_limit のトリガー前
 * - UNFILLED: 未約定
 * - PARTIALLY_FILLED: 部分約定
 * - FULLY_FILLED: 全量約定（終端）
 * - CANCELED_UNFILLED: 未約定のままキャンセル（終端）
 * - CANCELED_PARTIALLY_FILLED: 部分約定後にキャンセル（終端）
 * - REJECTED: システムに拒否された（終端、例: 信用取引のリスク制限超過）
 * - TRIGGERED: stop がトリガー発動済みで後続注文の処理待ち
 */
export const OrderStatusEnum = z.enum([
	'INACTIVE',
	'UNFILLED',
	'PARTIALLY_FILLED',
	'FULLY_FILLED',
	'CANCELED_UNFILLED',
	'CANCELED_PARTIALLY_FILLED',
	'REJECTED',
	'TRIGGERED',
]);

/**
 * 注文タイプ（現物・信用共通）。
 *
 * bitbank 公式 spec の `POST /v1/user/spot/order` では `take_profit` / `stop_loss` / `losscut`
 * も列挙されているが、本実装では意図的に未対応（理由は docs/private-api.md と
 * docs/api-contract-checklist.md §3.4 を参照）。
 *
 * - `take_profit` / `stop_loss`: 公式 docs が動作仕様を明記していない
 *   （発動方向、amount 省略時の決済範囲、現物 vs 信用の適用可否がすべて未定義）。
 *   誤実装による建玉の意図しない決済リスクを避けるため未対応。
 * - `losscut`: システム発動の強制決済タイプ。ユーザー入力対象ではない。
 */
export const SpotOrderTypeEnum = z.enum(['limit', 'market', 'stop', 'stop_limit']);

/** 信用取引の建玉方向 */
export const PositionSideEnum = z.enum(['long', 'short']);

/** 注文レスポンス（単一） — bitbank API が返す注文オブジェクト */
const OrderResponseSchema = z.object({
	order_id: z.number().describe('注文ID'),
	pair: z.string().describe('通貨ペア'),
	side: z.enum(['buy', 'sell']).describe('売買方向'),
	type: z.string().describe('注文タイプ'),
	start_amount: z.string().nullable().describe('注文数量'),
	remaining_amount: z.string().nullable().describe('未約定数量'),
	executed_amount: z.string().describe('約定済み数量'),
	price: z.string().optional().describe('指値価格'),
	post_only: z.boolean().optional().describe('Post Only フラグ'),
	user_cancelable: z.boolean().optional().describe('キャンセル可能か'),
	average_price: z.string().describe('平均約定価格'),
	ordered_at: z.number().describe('注文日時（unix ms）'),
	expire_at: z.number().nullable().optional().describe('有効期限（unix ms）'),
	triggered_at: z.union([z.number(), z.string()]).optional().describe('トリガー発動日時（unix ms or ISO 8601）'),
	trigger_price: z.string().optional().describe('トリガー価格'),
	canceled_at: z.number().optional().describe('キャンセル日時（unix ms）'),
	status: OrderStatusEnum.describe('注文ステータス'),
});

export type OrderResponse = z.infer<typeof OrderResponseSchema>;

// ── preview_order（注文プレビュー・確認トークン発行） ──

export const PreviewOrderInputSchema = z
	.object({
		pair: z.string().describe('通貨ペア（例: btc_jpy）'),
		amount: z.string().describe('注文数量'),
		price: z.string().optional().describe('指値価格。limit / stop_limit で必須'),
		side: z.enum(['buy', 'sell']).describe('売買方向'),
		type: SpotOrderTypeEnum.describe(
			'注文タイプ（limit / market / stop / stop_limit）。' +
				'※ take_profit / stop_loss / losscut は本実装では未対応（公式 docs の動作仕様が曖昧なため意図的に除外）。',
		),
		post_only: z.boolean().optional().describe('Post Only（limit のみ有効。Maker 手数料を確保）'),
		trigger_price: z.string().optional().describe('トリガー価格。stop / stop_limit で必須'),
		position_side: PositionSideEnum.optional().describe(
			'信用取引の建玉方向。指定時は信用注文として扱う。' +
				'ロング新規=buy+long, ロング決済=sell+long, ショート新規=sell+short, ショート決済=buy+short。' +
				'⚠️ 信用取引です。損失が保証金を超える可能性があります',
		),
	})
	.describe('注文内容をプレビューし、確認トークンを発行する。実際の発注は行わない');

export const PreviewOrderDataSchema = z.object({
	confirmation_token: z.string().describe('create_order に渡す確認トークン'),
	expires_at: z.number().describe('トークン有効期限（unix ms）'),
	preview: z.object({
		pair: z.string(),
		amount: z.string(),
		side: z.enum(['buy', 'sell']),
		type: z.string(),
		price: z.string().optional(),
		trigger_price: z.string().optional(),
		post_only: z.boolean().optional(),
		position_side: PositionSideEnum.optional(),
	}),
});

export const PreviewOrderMetaSchema = z.object({
	action: z.literal('create_order'),
	/** 事前バリデーションで発生した警告（例: /spot/pairs 取得失敗で最小数量・桁数チェックを省略） */
	warnings: z.array(z.string()).optional(),
});

export const PreviewOrderOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: PreviewOrderDataSchema,
		meta: PreviewOrderMetaSchema,
	}),
	PrivateFailResultSchema,
]);

// ── create_order（注文発注） ──

export const CreateOrderInputSchema = z
	.object({
		pair: z.string().describe('通貨ペア（例: btc_jpy）'),
		amount: z.string().describe('注文数量'),
		price: z.string().optional().describe('指値価格。limit / stop_limit で必須'),
		side: z.enum(['buy', 'sell']).describe('売買方向'),
		type: SpotOrderTypeEnum.describe(
			'注文タイプ（limit / market / stop / stop_limit）。' +
				'※ take_profit / stop_loss / losscut は本実装では未対応（公式 docs の動作仕様が曖昧なため意図的に除外）。',
		),
		post_only: z.boolean().optional().describe('Post Only（limit のみ有効。Maker 手数料を確保）'),
		trigger_price: z.string().optional().describe('トリガー価格。stop / stop_limit で必須'),
		position_side: PositionSideEnum.optional().describe('信用取引の建玉方向。preview_order で指定した値をそのまま渡す'),
		confirmation_token: z.string().describe('preview_order が発行した確認トークン'),
		token_expires_at: z
			.number()
			.describe('確認トークンの有効期限（unix ms）。preview_order の expires_at をそのまま渡す'),
	})
	.describe('注文を発注する（現物または信用）。事前に preview_order で確認トークンを取得すること');

export const CreateOrderDataSchema = z.object({
	order: OrderResponseSchema,
	timestamp: z.string(),
});

export const CreateOrderMetaSchema = z.object({
	fetchedAt: z.string(),
	orderId: z.number(),
	pair: z.string(),
	side: z.enum(['buy', 'sell']),
	type: z.string(),
});

export const CreateOrderOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: CreateOrderDataSchema,
		meta: CreateOrderMetaSchema,
	}),
	PrivateFailResultSchema,
]);

// ── preview_cancel_order（キャンセルプレビュー・確認トークン発行） ──

export const PreviewCancelOrderInputSchema = z.object({
	pair: z.string().describe('通貨ペア（例: btc_jpy）'),
	order_id: z.number().describe('キャンセルする注文ID'),
});

export const PreviewCancelOrderDataSchema = z.object({
	confirmation_token: z.string().describe('cancel_order に渡す確認トークン'),
	expires_at: z.number().describe('トークン有効期限（unix ms）'),
	preview: z.object({
		pair: z.string(),
		order_id: z.number(),
	}),
	/** 注文詳細（get_order で取得できた場合のみ）。UI / サマリ表示用で、トークン検証には使わない */
	order: OrderResponseSchema.optional(),
});

export const PreviewCancelOrderMetaSchema = z.object({
	action: z.literal('cancel_order'),
});

export const PreviewCancelOrderOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: PreviewCancelOrderDataSchema,
		meta: PreviewCancelOrderMetaSchema,
	}),
	PrivateFailResultSchema,
]);

// ── cancel_order（注文キャンセル・単一） ──

export const CancelOrderInputSchema = z.object({
	pair: z.string().describe('通貨ペア（例: btc_jpy）'),
	order_id: z.number().describe('キャンセルする注文ID'),
	confirmation_token: z.string().describe('preview_cancel_order が発行した確認トークン'),
	token_expires_at: z.number().describe('確認トークンの有効期限（unix ms）'),
});

export const CancelOrderDataSchema = z.object({
	order: OrderResponseSchema,
	timestamp: z.string(),
});

export const CancelOrderMetaSchema = z.object({
	fetchedAt: z.string(),
	orderId: z.number(),
	pair: z.string(),
});

export const CancelOrderOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: CancelOrderDataSchema,
		meta: CancelOrderMetaSchema,
	}),
	PrivateFailResultSchema,
]);

// ── preview_cancel_orders（一括キャンセルプレビュー・確認トークン発行） ──

export const PreviewCancelOrdersInputSchema = z.object({
	pair: z.string().describe('通貨ペア（例: btc_jpy）'),
	order_ids: z.array(z.number()).min(1).max(30).describe('キャンセルする注文IDの配列（最大30件）'),
});

export const PreviewCancelOrdersDataSchema = z.object({
	confirmation_token: z.string().describe('cancel_orders に渡す確認トークン'),
	expires_at: z.number().describe('トークン有効期限（unix ms）'),
	preview: z.object({
		pair: z.string(),
		order_ids: z.array(z.number()),
	}),
});

export const PreviewCancelOrdersMetaSchema = z.object({
	action: z.literal('cancel_orders'),
});

export const PreviewCancelOrdersOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: PreviewCancelOrdersDataSchema,
		meta: PreviewCancelOrdersMetaSchema,
	}),
	PrivateFailResultSchema,
]);

// ── cancel_orders（注文キャンセル・複数） ──

export const CancelOrdersInputSchema = z.object({
	pair: z.string().describe('通貨ペア（例: btc_jpy）'),
	order_ids: z.array(z.number()).min(1).max(30).describe('キャンセルする注文IDの配列（最大30件）'),
	confirmation_token: z.string().describe('preview_cancel_orders が発行した確認トークン'),
	token_expires_at: z.number().describe('確認トークンの有効期限（unix ms）'),
});

export const CancelOrdersDataSchema = z.object({
	orders: z.array(OrderResponseSchema),
	timestamp: z.string(),
});

export const CancelOrdersMetaSchema = z.object({
	fetchedAt: z.string(),
	canceledCount: z.number().int(),
	pair: z.string(),
});

export const CancelOrdersOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: CancelOrdersDataSchema,
		meta: CancelOrdersMetaSchema,
	}),
	PrivateFailResultSchema,
]);

// ── get_order（注文照会・単一） ──

export const GetOrderInputSchema = z.object({
	pair: z.string().describe('通貨ペア（例: btc_jpy）'),
	order_id: z.number().describe('照会する注文ID'),
});

export const GetOrderDataSchema = z.object({
	order: OrderResponseSchema,
	timestamp: z.string(),
});

export const GetOrderMetaSchema = z.object({
	fetchedAt: z.string(),
	orderId: z.number(),
	pair: z.string(),
});

export const GetOrderOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: GetOrderDataSchema,
		meta: GetOrderMetaSchema,
	}),
	PrivateFailResultSchema,
]);

// ── get_orders_info（注文照会・複数） ──

export const GetOrdersInfoInputSchema = z.object({
	pair: z.string().describe('通貨ペア（例: btc_jpy）'),
	order_ids: z.array(z.number()).min(1).describe('照会する注文IDの配列'),
});

export const GetOrdersInfoDataSchema = z.object({
	orders: z.array(OrderResponseSchema),
	timestamp: z.string(),
});

export const GetOrdersInfoMetaSchema = z.object({
	fetchedAt: z.string(),
	orderCount: z.number().int(),
	pair: z.string(),
});

export const GetOrdersInfoOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: GetOrdersInfoDataSchema,
		meta: GetOrdersInfoMetaSchema,
	}),
	PrivateFailResultSchema,
]);
