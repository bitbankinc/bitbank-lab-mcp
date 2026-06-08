/**
 * Private API レスポンスのフィクスチャ集
 * ユニットテストで再利用する
 */

import type { HttpFetcher } from '../../src/private/client.js';

// ── 資産 ──

// 実 API（/v1/user/assets）の assets[] 形に準拠。
// withdrawing_amount / network_list / collateral_ratio は公式 rest-api_JP.md の
// レスポンス例どおりに含める（jpy は network_list を持たない点も再現）。
// 社内一次ソース: docs/internal/bitbank-api-fields.md
export const rawAssetsResponse = {
	assets: [
		{
			asset: 'btc',
			free_amount: '0.5',
			amount_precision: 8,
			onhand_amount: '0.6',
			locked_amount: '0.1',
			withdrawing_amount: '0',
			withdrawal_fee: { min: '0.0006', max: '0.0006' },
			stop_deposit: false,
			stop_withdrawal: false,
			network_list: [
				{ asset: 'btc', network: 'btc', stop_deposit: false, stop_withdrawal: false, withdrawal_fee: '0.0006' },
			],
			collateral_ratio: '0.95',
		},
		{
			asset: 'eth',
			free_amount: '2.0',
			amount_precision: 8,
			onhand_amount: '2.0',
			locked_amount: '0',
			withdrawing_amount: '0',
			withdrawal_fee: { min: '0.005', max: '0.005' },
			stop_deposit: false,
			stop_withdrawal: false,
			network_list: [
				{ asset: 'eth', network: 'eth(erc20)', stop_deposit: false, stop_withdrawal: false, withdrawal_fee: '0.005' },
			],
			collateral_ratio: '0.90',
		},
		{
			asset: 'xrp',
			free_amount: '1000',
			amount_precision: 6,
			onhand_amount: '1000',
			locked_amount: '0',
			withdrawing_amount: '0',
			withdrawal_fee: { min: '0.15', max: '0.15' },
			stop_deposit: false,
			stop_withdrawal: false,
			network_list: [
				{ asset: 'xrp', network: 'xrp', stop_deposit: false, stop_withdrawal: false, withdrawal_fee: '0.15' },
			],
			collateral_ratio: '0.80',
		},
		{
			asset: 'jpy',
			free_amount: '500000',
			amount_precision: 0,
			onhand_amount: '500000',
			locked_amount: '0',
			withdrawing_amount: '0',
			withdrawal_fee: { under: '550', over: '770', threshold: '30000' },
			stop_deposit: false,
			stop_withdrawal: false,
			collateral_ratio: '1',
		},
		{
			asset: 'doge',
			free_amount: '0',
			amount_precision: 8,
			onhand_amount: '0',
			locked_amount: '0',
			withdrawing_amount: '0',
			withdrawal_fee: { min: '5', max: '5' },
			stop_deposit: false,
			stop_withdrawal: false,
			network_list: [
				{ asset: 'doge', network: 'doge', stop_deposit: false, stop_withdrawal: false, withdrawal_fee: '5' },
			],
			collateral_ratio: '0.70',
		},
	],
};

// ── 約定履歴 ──

export const rawTradeHistoryResponse = {
	trades: [
		{
			trade_id: 101,
			pair: 'btc_jpy',
			order_id: 1001,
			side: 'buy',
			type: 'limit',
			amount: '0.01',
			price: '15000000',
			maker_taker: 'maker',
			fee_amount_base: '0.00001',
			fee_amount_quote: '0',
			fee_occurred_amount_quote: '0',
			executed_at: 1710000000000,
		},
		{
			trade_id: 102,
			pair: 'btc_jpy',
			order_id: 1002,
			side: 'sell',
			type: 'market',
			amount: '0.005',
			price: '15500000',
			maker_taker: 'taker',
			fee_amount_base: '0',
			fee_amount_quote: '77.5',
			fee_occurred_amount_quote: '77.5',
			executed_at: 1710000100000,
		},
		{
			trade_id: 103,
			pair: 'eth_jpy',
			order_id: 1003,
			side: 'buy',
			type: 'limit',
			amount: '1.0',
			price: '380000',
			maker_taker: 'maker',
			fee_amount_base: '0.001',
			fee_amount_quote: '0',
			fee_occurred_amount_quote: '0',
			executed_at: 1710000200000,
		},
	],
};

// ── アクティブ注文 ──

export const rawActiveOrdersResponse = {
	orders: [
		{
			order_id: 2001,
			pair: 'btc_jpy',
			side: 'buy',
			type: 'limit',
			start_amount: '0.01',
			remaining_amount: '0.01',
			executed_amount: '0',
			price: '14000000',
			post_only: true,
			user_cancelable: true,
			average_price: '0',
			status: 'UNFILLED',
			ordered_at: 1710000000000,
			expire_at: 1717776000000,
		},
		{
			order_id: 2002,
			pair: 'eth_jpy',
			side: 'sell',
			type: 'limit',
			start_amount: '1.0',
			remaining_amount: '0.5',
			executed_amount: '0.5',
			price: '400000',
			post_only: false,
			user_cancelable: true,
			average_price: '400000',
			status: 'PARTIALLY_FILLED',
			ordered_at: 1710000100000,
		},
		{
			order_id: 2003,
			pair: 'btc_jpy',
			side: 'sell',
			type: 'stop',
			start_amount: '0.02',
			remaining_amount: '0.02',
			executed_amount: '0',
			user_cancelable: true,
			trigger_price: '13000000',
			average_price: '0',
			status: 'INACTIVE',
			ordered_at: 1710000200000,
		},
	],
};

// ── 入金履歴 ──

export const rawDepositHistoryResponse = {
	deposits: [
		{
			uuid: 'dep-001',
			asset: 'jpy',
			amount: '1000000',
			status: 'DONE',
			found_at: 1709900000000,
			confirmed_at: 1709900100000,
		},
		{
			uuid: 'dep-002',
			asset: 'btc',
			network: 'BTC',
			// 実 API（暗号資産入金）が返す入金先アドレス。jpy 入金（dep-001）には付かない。
			address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
			amount: '0.5',
			txid: '0xabc123',
			status: 'CONFIRMED',
			found_at: 1709950000000,
			confirmed_at: 1709950100000,
		},
	],
};

// ── 出金履歴 ──

export const rawWithdrawalHistoryResponse = {
	withdrawals: [
		{
			uuid: 'wd-001',
			asset: 'jpy',
			amount: '200000',
			fee: '550',
			bank_name: 'テスト銀行',
			// 実 API（fiat 出金）が返す禁止フィールド。
			// ツール出力から除外されることを検証するため敢えて含める。
			account_uuid: 'acc-uuid-001',
			branch_name: 'テスト支店',
			account_type: '普通',
			account_number: '1234567',
			account_owner: 'タナカ タロウ',
			status: 'DONE',
			requested_at: 1709800000000,
		},
		{
			uuid: 'wd-002',
			asset: 'eth',
			amount: '1.0',
			fee: '0.005',
			network: 'ETH',
			txid: '0xdef456',
			address: '0x1234567890abcdef',
			status: 'DONE',
			requested_at: 1709850000000,
		},
	],
};

// ── 信用取引ステータス ──

export const rawMarginStatusResponse = {
	status: 'NORMAL',
	total_margin_balance: '1000000',
	total_margin_balance_percentage: '250.00',
	margin_position_profit_loss: '50000',
	unrealized_cost: '1200',
	total_margin_position_product: '400000',
	open_margin_position_product: '300000',
	open_margin_order_product: '100000',
	total_position_maintenance_margin: '120000',
	total_long_position_maintenance_margin: '80000',
	total_short_position_maintenance_margin: '40000',
	total_open_order_maintenance_margin: '30000',
	total_long_open_order_maintenance_margin: '20000',
	total_short_open_order_maintenance_margin: '10000',
	margin_call_percentage: '150.00',
	losscut_percentage: '110.00',
	buy_credit: '500000',
	sell_credit: '450000',
	available_balances: [
		{ pair: 'btc_jpy', long: '500000', short: '450000' },
		{ pair: 'eth_jpy', long: '300000', short: '250000' },
	],
};

// ── 信用建玉 ──

export const rawMarginPositionsResponse = {
	notice: { what: null, occurred_at: null, amount: null, due_date_at: null },
	payables: { amount: '0' },
	positions: [
		{
			pair: 'btc_jpy',
			position_side: 'long',
			open_amount: '0.01',
			product: '150000',
			average_price: '15000000',
			unrealized_fee_amount: '150',
			unrealized_interest_amount: '30',
		},
		{
			pair: 'eth_jpy',
			position_side: 'short',
			open_amount: '1.0',
			product: '400000',
			average_price: '400000',
			unrealized_fee_amount: '400',
			unrealized_interest_amount: '80',
		},
	],
	losscut_threshold: {
		individual: '110',
		company: '120',
	},
};

// ── 信用約定履歴 ──

export const rawMarginTradeHistoryResponse = {
	trades: [
		{
			trade_id: 301,
			pair: 'btc_jpy',
			order_id: 3001,
			side: 'buy',
			position_side: 'long',
			type: 'limit',
			amount: '0.01',
			price: '15000000',
			maker_taker: 'maker',
			fee_amount_base: '0.00001',
			fee_amount_quote: '0',
			fee_occurred_amount_quote: '0',
			executed_at: 1710000000000,
		},
		{
			trade_id: 302,
			pair: 'btc_jpy',
			order_id: 3002,
			side: 'sell',
			position_side: 'long',
			type: 'market',
			amount: '0.01',
			price: '15500000',
			maker_taker: 'taker',
			fee_amount_base: '0',
			fee_amount_quote: '155',
			fee_occurred_amount_quote: '155',
			profit_loss: '5000',
			interest: '30',
			executed_at: 1710000100000,
		},
		{
			trade_id: 303,
			pair: 'eth_jpy',
			order_id: 3003,
			side: 'sell',
			position_side: 'short',
			type: 'limit',
			amount: '1.0',
			price: '400000',
			maker_taker: 'maker',
			fee_amount_base: '0.001',
			fee_amount_quote: '0',
			fee_occurred_amount_quote: '0',
			executed_at: 1710000200000,
		},
	],
};

// ── /spot/pairs フィクスチャ ──

/**
 * /spot/pairs ペア仕様のデフォルト値（btc_jpy 相当）。
 * テストごとに overrides で上書きできる。
 */
export function mockSpotPairSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: 'btc_jpy',
		base_asset: 'btc',
		quote_asset: 'jpy',
		maker_fee_rate_base: '0',
		taker_fee_rate_base: '0',
		maker_fee_rate_quote: '-0.0002',
		taker_fee_rate_quote: '0.0012',
		margin_open_maker_fee_rate_quote: null,
		margin_open_taker_fee_rate_quote: null,
		margin_close_maker_fee_rate_quote: null,
		margin_close_taker_fee_rate_quote: null,
		margin_long_interest: null,
		margin_short_interest: null,
		margin_current_individual_ratio: null,
		margin_current_individual_until: null,
		margin_current_company_ratio: null,
		margin_current_company_until: null,
		margin_next_individual_ratio: null,
		margin_next_individual_until: null,
		margin_next_company_ratio: null,
		margin_next_company_until: null,
		unit_amount: '0.0001',
		limit_max_amount: '1000',
		market_max_amount: '0.5',
		market_allowance_rate: '0.1',
		price_digits: 0,
		amount_digits: 8,
		is_enabled: true,
		stop_order: false,
		stop_order_and_cancel: false,
		stop_market_order: false,
		stop_stop_order: false,
		stop_stop_limit_order: false,
		stop_margin_long_order: false,
		stop_margin_short_order: false,
		stop_buy_order: false,
		stop_sell_order: false,
		...overrides,
	};
}

/**
 * /spot/pairs レスポンス全体（btc_jpy + eth_jpy を含むデフォルト）。
 * extraPairs で追加 / 上書きできる。
 */
export function mockSpotPairsResponse(extraPairs: Array<Record<string, unknown>> = []): {
	success: 1;
	data: { pairs: Array<Record<string, unknown>> };
} {
	return {
		success: 1,
		data: {
			pairs: [
				mockSpotPairSpec({ name: 'btc_jpy', base_asset: 'btc', quote_asset: 'jpy', price_digits: 0, amount_digits: 8 }),
				mockSpotPairSpec({
					name: 'eth_jpy',
					base_asset: 'eth',
					quote_asset: 'jpy',
					unit_amount: '0.0001',
					price_digits: 0,
					amount_digits: 8,
					limit_max_amount: '5000',
					market_max_amount: '50',
				}),
				...extraPairs,
			],
		},
	};
}

// ── ヘルパー ──

/** bitbank 成功レスポンスラッパー */
export function mockBitbankSuccess<T>(data: T): { success: 1; data: T } {
	return { success: 1, data };
}

/** bitbank エラーレスポンスラッパー */
export function mockBitbankError(code: number): { success: 0; data: { code: number } } {
	return { success: 0, data: { code } };
}

/** Response オブジェクトを生成するヘルパー */
export function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers },
	});
}

/**
 * 順次レスポンスを返す HttpFetcher モック。
 * 呼び出しごとに responses 配列を順に消費する。
 */
export function createMockFetcher(
	responses: Response[],
): HttpFetcher & { calls: Array<{ url: string; init: RequestInit }> } {
	let index = 0;
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetcher = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		if (index >= responses.length) {
			throw new Error(`Unexpected fetch call #${index + 1}: ${url}`);
		}
		return responses[index++];
	}) as HttpFetcher & { calls: Array<{ url: string; init: RequestInit }> };
	fetcher.calls = calls;
	return fetcher;
}

/**
 * URL 部分一致でルーティングする fetch モック。
 * analyze_my_portfolio のような複数 API 並列呼び出しのテストに有用。
 */
export function createUrlRouter(
	routes: Record<string, () => Response>,
	fallback?: () => Response,
): HttpFetcher & { calls: Array<{ url: string; init: RequestInit }> } {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetcher = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		for (const [pattern, handler] of Object.entries(routes)) {
			if (url.includes(pattern)) {
				return handler();
			}
		}
		if (fallback) return fallback();
		throw new Error(`No route matched: ${url}`);
	}) as HttpFetcher & { calls: Array<{ url: string; init: RequestInit }> };
	fetcher.calls = calls;
	return fetcher;
}
