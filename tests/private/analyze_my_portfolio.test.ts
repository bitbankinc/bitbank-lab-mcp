/**
 * analyze_my_portfolio ツールのユニットテスト。
 *
 * 複合ツール（assets + trades + tickers + deposits/withdrawals + technical）の
 * 統合動作を検証する。URL ベースのルーティングで複数 API 呼び出しをモック。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFail, assertOk } from '../_assertResult.js';
import { candlesBtcJpy1day120, tickersJpy } from '../fixtures/bitbank-api.js';
import {
	mockBitbankError,
	mockBitbankSuccess,
	rawAssetsResponse,
	rawDepositHistoryResponse,
	rawMarginTradeHistoryResponse,
	rawTradeHistoryResponse,
	rawWithdrawalHistoryResponse,
} from '../fixtures/private-api.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env.BITBANK_API_KEY;
	delete process.env.BITBANK_API_SECRET;
	vi.resetModules();
});

/** URL パターンでルーティングする fetch モック */
function setupFetchMock(opts?: {
	assetsFail?: boolean;
	tradesFail?: boolean;
	marginTradesFail?: boolean;
	dwFail?: boolean;
	marginTrades?: unknown;
}) {
	globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
		const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;

		// Public API: tickers
		if (urlStr.includes('tickers_jpy')) {
			return new Response(JSON.stringify(tickersJpy), { status: 200 });
		}

		// Public API: candlestick
		if (urlStr.includes('candlestick')) {
			return new Response(JSON.stringify(candlesBtcJpy1day120), { status: 200 });
		}

		// Private API: assets
		if (urlStr.includes('/v1/user/assets')) {
			if (opts?.assetsFail) {
				return new Response(JSON.stringify(mockBitbankError(20001)), { status: 400 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess(rawAssetsResponse)), { status: 200 });
		}

		// Private API: trade history（type=margin を信用約定として分岐）
		if (urlStr.includes('trade_history')) {
			const isMargin = urlStr.includes('type=margin');
			if (isMargin) {
				if (opts?.marginTradesFail) {
					return new Response(JSON.stringify(mockBitbankError(10007)), { status: 200 });
				}
				const marginPayload = opts?.marginTrades ?? { trades: [] };
				return new Response(JSON.stringify(mockBitbankSuccess(marginPayload)), { status: 200 });
			}
			if (opts?.tradesFail) {
				return new Response(JSON.stringify(mockBitbankError(10007)), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess(rawTradeHistoryResponse)), { status: 200 });
		}

		// Private API: deposit history
		if (urlStr.includes('deposit_history')) {
			if (opts?.dwFail) {
				return new Response(JSON.stringify(mockBitbankError(10007)), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess(rawDepositHistoryResponse)), { status: 200 });
		}

		// Private API: withdrawal history
		if (urlStr.includes('withdrawal_history')) {
			if (opts?.dwFail) {
				return new Response(JSON.stringify(mockBitbankError(10007)), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess(rawWithdrawalHistoryResponse)), { status: 200 });
		}

		// fallback
		return new Response(JSON.stringify(mockBitbankSuccess({})), { status: 200 });
	}) as unknown as typeof fetch;
}

describe('analyze_my_portfolio', () => {
	it('全オプション有効で統合結果を返す', async () => {
		setupFetchMock();

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: true,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		expect(result.data.holdings.length).toBeGreaterThan(0);
		expect(result.data.timestamp).toBeDefined();
		expect(result.data.total_jpy_value).toBeGreaterThan(0);
	});

	it('include_pnl=false で約定履歴を取得しない', async () => {
		setupFetchMock();

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: false,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expect(result.data.holdings.length).toBeGreaterThan(0);
		// PnL 関連フィールドが undefined
		const btcHolding = result.data.holdings.find((h) => h.asset === 'btc');
		expect(btcHolding).toBeDefined();
		expect(btcHolding!.cost_basis).toBeUndefined();
	});

	it('include_deposit_withdrawal=false で入出金を取得しない', async () => {
		setupFetchMock();

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expect(result.data.deposit_withdrawal_summary).toBeUndefined();
	});

	it('入出金失敗時に fallback で動作する', async () => {
		setupFetchMock({ dwFail: true });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		// 入出金失敗でも資産情報は返る
		expect(result.data.holdings.length).toBeGreaterThan(0);
	});

	it('アセット取得失敗で fail を返す', async () => {
		setupFetchMock({ assetsFail: true });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({});

		assertFail(result);
		expect(result.meta.errorType).toBe('authentication_error');
	});

	it('信用約定なしのケース: account_pnl.total === spot_realized_pnl、内訳は 0', async () => {
		// marginTrades 未指定 → モックは trades: [] を返す
		setupFetchMock();

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expect(result.data.account_pnl).toBeDefined();
		expect(result.data.account_pnl.margin_realized_pnl).toBe(0);
		expect(result.data.account_pnl.margin_interest).toBe(0);
		expect(result.data.account_pnl.total).toBe(result.data.account_pnl.spot_realized_pnl);
	});

	it('信用約定あり: account_pnl.total が spot + margin - interest と一致', async () => {
		// rawMarginTradeHistoryResponse は決済 1 件（profit_loss=5000, interest=30）+ 建玉 2 件
		setupFetchMock({ marginTrades: rawMarginTradeHistoryResponse });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		const pnl = result.data.account_pnl;
		expect(pnl).toBeDefined();
		expect(pnl.margin_realized_pnl).toBe(5000);
		expect(pnl.margin_interest).toBe(30);
		expect(pnl.total).toBe(pnl.spot_realized_pnl + 5000 - 30);
	});

	it('paginateMarginTrades 失敗時のフォールバック: margin_realized_pnl=0 / margin_interest=0 で ok を返す', async () => {
		setupFetchMock({ marginTradesFail: true });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expect(result.data.account_pnl).toBeDefined();
		expect(result.data.account_pnl.margin_realized_pnl).toBe(0);
		expect(result.data.account_pnl.margin_interest).toBe(0);
	});

	it('yearly_account_pnl / monthly_account_pnl の期間フィルターが正しく効く', async () => {
		// 信用約定 2 件: 1 件は遠い過去（2024 年）、1 件は当年内（rawMarginTradeHistoryResponse のもの）。
		// paginateMarginTrades は yearStartMs 以降のみ取得するため、API レイヤーで当年分のみ返す。
		// その上で月初フィルタが効くことを確認するため、当年内に 2 件配置する。
		const nowMs = Date.now();
		const monthAgoMs = nowMs - 30 * 24 * 60 * 60 * 1000; // 1か月前
		const tenDaysAgoMs = nowMs - 10 * 24 * 60 * 60 * 1000; // 10日前
		const customMargin = {
			trades: [
				{
					trade_id: 901,
					pair: 'btc_jpy',
					order_id: 9001,
					side: 'sell',
					position_side: 'long',
					type: 'limit',
					amount: '0.01',
					price: '15500000',
					maker_taker: 'maker',
					fee_amount_base: '0',
					fee_amount_quote: '0',
					profit_loss: '1000',
					interest: '10',
					executed_at: monthAgoMs,
				},
				{
					trade_id: 902,
					pair: 'btc_jpy',
					order_id: 9002,
					side: 'sell',
					position_side: 'long',
					type: 'limit',
					amount: '0.01',
					price: '15500000',
					maker_taker: 'maker',
					fee_amount_base: '0',
					fee_amount_quote: '0',
					profit_loss: '500',
					interest: '5',
					executed_at: tenDaysAgoMs,
				},
			],
		};
		setupFetchMock({ marginTrades: customMargin });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		// yearly: 両方含む（1000 + 500, 10 + 5）
		expect(result.data.yearly_account_pnl).toBeDefined();
		expect(result.data.yearly_account_pnl.margin_realized_pnl).toBe(1500);
		expect(result.data.yearly_account_pnl.margin_interest).toBe(15);
		// monthly: 10日前のみ（500, 5）。1か月前は月初境界次第だが、当月内の 10 日前は必ず含まれる
		expect(result.data.monthly_account_pnl).toBeDefined();
		expect(result.data.monthly_account_pnl.margin_realized_pnl).toBeGreaterThanOrEqual(500);
		expect(result.data.monthly_account_pnl.margin_interest).toBeGreaterThanOrEqual(5);
		// monthly は yearly 以下
		expect(result.data.monthly_account_pnl.margin_realized_pnl).toBeLessThanOrEqual(
			result.data.yearly_account_pnl.margin_realized_pnl,
		);
	});
});

describe('analyze_my_portfolio — toolDef handler', () => {
	it('handler がデフォルト引数で動作する', async () => {
		// setup URL routing fetch mock
		globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;

			if (urlStr.includes('tickers_jpy')) {
				return new Response(JSON.stringify(tickersJpy), { status: 200 });
			}
			if (urlStr.includes('candlestick')) {
				return new Response(JSON.stringify(candlesBtcJpy1day120), { status: 200 });
			}
			if (urlStr.includes('/v1/user/assets')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawAssetsResponse)), { status: 200 });
			}
			if (urlStr.includes('trade_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawTradeHistoryResponse)), { status: 200 });
			}
			if (urlStr.includes('deposit_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawDepositHistoryResponse)), { status: 200 });
			}
			if (urlStr.includes('withdrawal_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawWithdrawalHistoryResponse)), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess({})), { status: 200 });
		}) as unknown as typeof fetch;

		const { toolDef } = await import('../../tools/private/analyze_my_portfolio.js');
		const result = await toolDef.handler({});

		expect((result as { ok: boolean }).ok).toBe(true);
	});
});
