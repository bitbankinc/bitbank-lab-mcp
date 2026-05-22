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
	rawMarginPositionsResponse,
	rawMarginStatusResponse,
	rawMarginTradeHistoryResponse,
	rawTradeHistoryResponse,
	rawWithdrawalHistoryResponse,
} from '../fixtures/private-api.js';

/** 信用建玉なしの margin/positions レスポンス（デフォルト fixture が長短 2 件持ちのため、テスト用に空版を別に用意） */
const rawMarginPositionsEmptyResponse = {
	notice: null,
	payables: { amount: '0' },
	positions: [],
	losscut_threshold: { individual: '110', company: '120' },
};

/**
 * 信用口座系 endpoints のデフォルト success レスポンス。
 * `setupFetchMock` を使わずインライン fetch mock を組むテスト用に、
 * `/v1/user/margin/status` と `/v1/user/margin/positions` を一発でハンドルする。
 * マッチしない URL では null を返すので、呼び出し側は短絡評価で処理を続行できる。
 */
function maybeMarginAccountResponse(urlStr: string): Response | null {
	if (urlStr.includes('/v1/user/margin/status')) {
		return new Response(JSON.stringify(mockBitbankSuccess(rawMarginStatusResponse)), { status: 200 });
	}
	if (urlStr.includes('/v1/user/margin/positions')) {
		return new Response(JSON.stringify(mockBitbankSuccess(rawMarginPositionsEmptyResponse)), { status: 200 });
	}
	return null;
}

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
	marginStatusFail?: boolean;
	marginStatus?: unknown;
	marginPositionsFail?: boolean;
	marginPositions?: unknown;
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

		// Private API: margin status — assets パスに包含されないよう、trade_history より前に判定
		if (urlStr.includes('/v1/user/margin/status')) {
			if (opts?.marginStatusFail) {
				return new Response(JSON.stringify(mockBitbankError(10007)), { status: 200 });
			}
			const payload = opts?.marginStatus ?? rawMarginStatusResponse;
			return new Response(JSON.stringify(mockBitbankSuccess(payload)), { status: 200 });
		}

		// Private API: margin positions
		if (urlStr.includes('/v1/user/margin/positions')) {
			if (opts?.marginPositionsFail) {
				return new Response(JSON.stringify(mockBitbankError(10007)), { status: 200 });
			}
			// 既存テストの assertion を壊さないよう、デフォルトは「建玉なし」。
			// 建玉ありを検証するテストは opts.marginPositions で明示する。
			const payload = opts?.marginPositions ?? rawMarginPositionsEmptyResponse;
			return new Response(JSON.stringify(mockBitbankSuccess(payload)), { status: 200 });
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
		expect(btcHolding?.cost_basis).toBeUndefined();
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
		expect(result.data.account_pnl.margin_fee).toBe(0);
		expect(result.data.account_pnl.total).toBe(result.data.account_pnl.spot_realized_pnl);
	});

	it('信用約定あり: account_pnl.total が spot + margin - interest - fee と一致', async () => {
		// rawMarginTradeHistoryResponse は決済 1 件（profit_loss=5000, interest=30,
		// fee_occurred_amount_quote=155）+ 建玉 2 件（fee_occurred_amount_quote=0）
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
		expect(pnl.margin_fee).toBe(155);
		expect(pnl.total).toBe(pnl.spot_realized_pnl + 5000 - 30 - 155);
	});

	it('信用約定レスポンスに現物 (position_side 欠損) が混入しても margin_fee は信用のみから集計', async () => {
		// 公式 docs に type=margin パラメータの記載がなく、API がそれを無視して
		// 現物約定も返してしまった場合の防御。フィルタが効いていれば、現物の
		// fee_occurred_amount_quote は margin_fee に加算されない（過剰控除を防ぐ）。
		const mixedMargin = {
			trades: [
				// 信用決済: PL=5000, interest=30, fee=155 → これらだけが集計対象
				{
					trade_id: 1001,
					pair: 'btc_jpy',
					order_id: 11001,
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
				// 現物約定（position_side なし）— fee_occurred_amount_quote=9999 だが
				// margin_fee に加算されてはいけない
				{
					trade_id: 1002,
					pair: 'btc_jpy',
					order_id: 11002,
					side: 'buy',
					type: 'limit',
					amount: '0.01',
					price: '15000000',
					maker_taker: 'maker',
					fee_amount_base: '0.00001',
					fee_amount_quote: '9999',
					fee_occurred_amount_quote: '9999',
					executed_at: 1710000000000,
				},
			],
		};
		setupFetchMock({ marginTrades: mixedMargin });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		const pnl = result.data.account_pnl;
		expect(pnl).toBeDefined();
		// 信用約定 1 件のみが集計対象
		expect(pnl.margin_realized_pnl).toBe(5000);
		expect(pnl.margin_interest).toBe(30);
		// 現物の 9999 が混入していたら 9999+155=10154 になるはずだが、フィルタで除外されて 155 のみ
		expect(pnl.margin_fee).toBe(155);
		expect(pnl.total).toBe(pnl.spot_realized_pnl + 5000 - 30 - 155);
	});

	it('信用 fetch 失敗時: ⚠️ 警告 + meta.marginFetchFailed=true + margin pnl 0 で「信用未使用」と区別できる', async () => {
		// Cursor レビュー B: paginateMarginTrades が API エラーで break した場合に
		// 「信用未使用」と区別できない結果を返してしまう問題のリグレ防止。
		// 同シナリオで summary 警告 / meta フラグ / フォールバック値 / truncated 警告の非重複を
		// 一括検証する（assert を別 it に分けると重複テストになる）。
		setupFetchMock({ marginTradesFail: true });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		// ⚠️ 警告 + meta フラグで失敗を明示
		expect(result.summary).toContain('⚠️ 信用約定の取得に失敗');
		expect(result.meta.marginFetchFailed).toBe(true);
		// フォールバック: margin pnl 各種は 0
		expect(result.data.account_pnl).toBeDefined();
		expect(result.data.account_pnl.margin_realized_pnl).toBe(0);
		expect(result.data.account_pnl.margin_interest).toBe(0);
		expect(result.data.account_pnl.margin_fee).toBe(0);
		// 信用 fetch 失敗時は信用側 truncated 警告を抑止（メッセージ重複回避）
		expect(result.summary).not.toContain('※ 約定履歴（信用）');
		expect(result.summary).not.toContain('※ 約定履歴（現物 / 信用）');
	});

	it('打ち切り (現物): summary に ※ 約定履歴（現物） が含まれ、meta.tradesTruncated === true', async () => {
		// Cursor レビュー C/E: 打ち切り警告の文字列 assertion を追加してリグレ検知する。
		// paginateTrades が満杯ページ × 同一カーソルで進捗ゼロを検出 → truncated=true で打ち切る。
		const SAME_TS = 1710000000000;
		const fullSpotPage = Array.from({ length: 1000 }, (_, i) => ({
			trade_id: i + 1,
			pair: 'btc_jpy',
			order_id: 5000 + i,
			side: 'buy',
			type: 'limit',
			amount: '0.001',
			price: '15000000',
			maker_taker: 'maker',
			fee_amount_base: '0',
			fee_amount_quote: '0',
			executed_at: SAME_TS,
		}));

		globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			const _maybeMargin = maybeMarginAccountResponse(urlStr);
			if (_maybeMargin) return _maybeMargin;
			if (urlStr.includes('tickers_jpy')) return new Response(JSON.stringify(tickersJpy), { status: 200 });
			if (urlStr.includes('candlestick')) return new Response(JSON.stringify(candlesBtcJpy1day120), { status: 200 });
			if (urlStr.includes('/v1/user/assets')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawAssetsResponse)), { status: 200 });
			}
			if (urlStr.includes('trade_history')) {
				const isMargin = urlStr.includes('type=margin');
				if (isMargin) return new Response(JSON.stringify(mockBitbankSuccess({ trades: [] })), { status: 200 });
				return new Response(JSON.stringify(mockBitbankSuccess({ trades: fullSpotPage })), { status: 200 });
			}
			if (urlStr.includes('deposit_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [] })), { status: 200 });
			}
			if (urlStr.includes('withdrawal_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess({})), { status: 200 });
		}) as unknown as typeof fetch;

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expect(result.summary).toContain('※ 約定履歴（現物）');
		expect(result.meta.tradesTruncated).toBe(true);
		expect(result.meta.marginTradesTruncated).toBe(false);
		expect(result.meta.marginFetchFailed).toBe(false);
	});

	it('打ち切り (信用): summary に ※ 約定履歴（信用） が含まれ、meta.marginTradesTruncated === true', async () => {
		const SAME_TS = 1710000000000;
		const fullMarginPage = Array.from({ length: 1000 }, (_, i) => ({
			trade_id: 9000 + i,
			pair: 'btc_jpy',
			order_id: 6000 + i,
			side: 'sell',
			position_side: 'long',
			type: 'limit',
			amount: '0.001',
			price: '15500000',
			maker_taker: 'maker',
			fee_amount_base: '0',
			fee_amount_quote: '0',
			fee_occurred_amount_quote: '0',
			profit_loss: '0',
			executed_at: SAME_TS,
		}));

		globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			const _maybeMargin = maybeMarginAccountResponse(urlStr);
			if (_maybeMargin) return _maybeMargin;
			if (urlStr.includes('tickers_jpy')) return new Response(JSON.stringify(tickersJpy), { status: 200 });
			if (urlStr.includes('candlestick')) return new Response(JSON.stringify(candlesBtcJpy1day120), { status: 200 });
			if (urlStr.includes('/v1/user/assets')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawAssetsResponse)), { status: 200 });
			}
			if (urlStr.includes('trade_history')) {
				const isMargin = urlStr.includes('type=margin');
				if (isMargin) {
					return new Response(JSON.stringify(mockBitbankSuccess({ trades: fullMarginPage })), { status: 200 });
				}
				return new Response(JSON.stringify(mockBitbankSuccess({ trades: [] })), { status: 200 });
			}
			if (urlStr.includes('deposit_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [] })), { status: 200 });
			}
			if (urlStr.includes('withdrawal_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess({})), { status: 200 });
		}) as unknown as typeof fetch;

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expect(result.summary).toContain('※ 約定履歴（信用）');
		expect(result.summary).not.toContain('※ 約定履歴（現物 / 信用）');
		expect(result.meta.marginTradesTruncated).toBe(true);
		expect(result.meta.tradesTruncated).toBe(false);
		expect(result.meta.marginFetchFailed).toBe(false);
	});

	it('打ち切り (両方): summary に ※ 約定履歴（現物 / 信用） が含まれ、両 meta フラグが true', async () => {
		const SAME_TS = 1710000000000;
		const fullSpotPage = Array.from({ length: 1000 }, (_, i) => ({
			trade_id: i + 1,
			pair: 'btc_jpy',
			order_id: 5000 + i,
			side: 'buy',
			type: 'limit',
			amount: '0.001',
			price: '15000000',
			maker_taker: 'maker',
			fee_amount_base: '0',
			fee_amount_quote: '0',
			executed_at: SAME_TS,
		}));
		const fullMarginPage = Array.from({ length: 1000 }, (_, i) => ({
			trade_id: 9000 + i,
			pair: 'btc_jpy',
			order_id: 6000 + i,
			side: 'sell',
			position_side: 'long',
			type: 'limit',
			amount: '0.001',
			price: '15500000',
			maker_taker: 'maker',
			fee_amount_base: '0',
			fee_amount_quote: '0',
			fee_occurred_amount_quote: '0',
			profit_loss: '0',
			executed_at: SAME_TS,
		}));

		globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			const _maybeMargin = maybeMarginAccountResponse(urlStr);
			if (_maybeMargin) return _maybeMargin;
			if (urlStr.includes('tickers_jpy')) return new Response(JSON.stringify(tickersJpy), { status: 200 });
			if (urlStr.includes('candlestick')) return new Response(JSON.stringify(candlesBtcJpy1day120), { status: 200 });
			if (urlStr.includes('/v1/user/assets')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawAssetsResponse)), { status: 200 });
			}
			if (urlStr.includes('trade_history')) {
				const isMargin = urlStr.includes('type=margin');
				if (isMargin) {
					return new Response(JSON.stringify(mockBitbankSuccess({ trades: fullMarginPage })), { status: 200 });
				}
				return new Response(JSON.stringify(mockBitbankSuccess({ trades: fullSpotPage })), { status: 200 });
			}
			if (urlStr.includes('deposit_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [] })), { status: 200 });
			}
			if (urlStr.includes('withdrawal_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess({})), { status: 200 });
		}) as unknown as typeof fetch;

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expect(result.summary).toContain('※ 約定履歴（現物 / 信用）');
		expect(result.meta.tradesTruncated).toBe(true);
		expect(result.meta.marginTradesTruncated).toBe(true);
		expect(result.meta.marginFetchFailed).toBe(false);
	});

	it('警告行が summary 先頭付近に出る（タイトル前または直後）— LLM の見落とし防止', async () => {
		// .claude/rules/tools.md: content[0].text の先頭に warning 行が含まれているか目視確認。
		// ハンドラ summary がそのまま content text になるため、先頭付近に warning が出ることを検証。
		setupFetchMock({ marginTradesFail: true });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		const firstFiveLines = result.summary.split('\n').slice(0, 5).join('\n');
		expect(firstFiveLines).toContain('⚠️ 信用約定の取得に失敗');
	});

	it('yearly_account_pnl / monthly_account_pnl の期間フィルターが正しく効く', async () => {
		// 固定の現在時刻（JST 2026-05-16 12:00）を基準に、当月内 / 当月外 / 当年内を確実に振り分ける。
		// vi.useFakeTimers でクロックを固定し、Date.now() ベースの境界計算（getJstPeriodBoundaries）も決定論化する。
		const fixedNowMs = Date.UTC(2026, 4, 16, 3, 0, 0, 0); // 2026-05-16T03:00:00Z = 12:00 JST
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);
		try {
			const yearStartUtcMs = Date.UTC(2026, 0, 1, -9, 0, 0, 0); // 2026-01-01T00:00:00+09:00
			const monthStartUtcMs = Date.UTC(2026, 4, 1, -9, 0, 0, 0); // 2026-05-01T00:00:00+09:00
			// 月初前: 2026-03-15（当年内・当月外）。月初後: 2026-05-10（当年内・当月内）。
			const beforeMonthStartMs = Date.UTC(2026, 2, 15, 0, 0, 0, 0);
			const afterMonthStartMs = Date.UTC(2026, 4, 10, 0, 0, 0, 0);
			expect(beforeMonthStartMs).toBeGreaterThanOrEqual(yearStartUtcMs);
			expect(beforeMonthStartMs).toBeLessThan(monthStartUtcMs);
			expect(afterMonthStartMs).toBeGreaterThanOrEqual(monthStartUtcMs);

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
						fee_amount_quote: '50',
						fee_occurred_amount_quote: '50',
						profit_loss: '1000',
						interest: '10',
						executed_at: beforeMonthStartMs, // 当年内・当月外
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
						fee_amount_quote: '25',
						fee_occurred_amount_quote: '25',
						profit_loss: '500',
						interest: '5',
						executed_at: afterMonthStartMs, // 当年内・当月内
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
			// yearly: 両方含む（1000 + 500, 10 + 5, 50 + 25）
			expect(result.data.yearly_account_pnl).toBeDefined();
			expect(result.data.yearly_account_pnl.margin_realized_pnl).toBe(1500);
			expect(result.data.yearly_account_pnl.margin_interest).toBe(15);
			expect(result.data.yearly_account_pnl.margin_fee).toBe(75);
			// monthly: 月初後のみ（500, 5, 25）
			expect(result.data.monthly_account_pnl).toBeDefined();
			expect(result.data.monthly_account_pnl.margin_realized_pnl).toBe(500);
			expect(result.data.monthly_account_pnl.margin_interest).toBe(5);
			expect(result.data.monthly_account_pnl.margin_fee).toBe(25);
		} finally {
			vi.useRealTimers();
		}
	});

	it('全履歴取得: paginate*/fetchDepositWithdrawal に since クエリパラメータを付与しない', async () => {
		// バグ回帰防止: 旧実装は yearStartMs を since として渡していたため、年初前の買い・入金が
		// 損益計算から欠落していた。全期間取得に戻したことを URL の since 不在で検証する。
		const seenUrls: string[] = [];
		globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			const _maybeMargin = maybeMarginAccountResponse(urlStr);
			if (_maybeMargin) return _maybeMargin;
			seenUrls.push(urlStr);

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

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		// 各 Private API の呼び出しが存在すること
		const tradeUrls = seenUrls.filter((u) => u.includes('trade_history'));
		const depositUrls = seenUrls.filter((u) => u.includes('deposit_history'));
		const withdrawalUrls = seenUrls.filter((u) => u.includes('withdrawal_history'));
		expect(tradeUrls.length).toBeGreaterThan(0);
		expect(depositUrls.length).toBeGreaterThan(0);
		expect(withdrawalUrls.length).toBeGreaterThan(0);
		// 全 URL に since= が含まれない（ハンドラからの全履歴取得）。
		// 注意: paginate*/fetchDepositWithdrawal は 2 ページ目以降で内部的に since を使う。
		// 現フィクスチャは各エンドポイント < PAGE_SIZE のため 1 ページで完結し、追加コールは
		// 発生しない。フィクスチャが PAGE_SIZE 超に拡大した際は、page=0 のみを抜き出して
		// 検証する形にリファクタすること。
		for (const u of [...tradeUrls, ...depositUrls, ...withdrawalUrls]) {
			expect(u).not.toMatch(/[?&]since=/);
		}
	});

	it('年初前入金で形成された保有: account_return_jpy は年初前入金も含めた純投入額に対して計算される', async () => {
		// 固定時刻 2026-05-16 12:00 JST。
		// 入金: 年初前 1_000_000（2025-06-01）+ 年初後 500_000（2026-02-01）= 1_500_000
		// 出金: なし
		// 現在総資産は rawAssetsResponse + tickersJpy から自動計算される（BTC 0.6 + ETH 2 + XRP 1000 + JPY 500_000）
		const fixedNowMs = Date.UTC(2026, 4, 16, 3, 0, 0, 0);
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);
		try {
			const beforeYearStartMs = Date.UTC(2025, 5, 1, 0, 0, 0, 0); // 2025-06-01
			const afterYearStartMs = Date.UTC(2026, 1, 1, 0, 0, 0, 0); // 2026-02-01

			const customDeposits = {
				deposits: [
					{
						uuid: 'd-pre',
						asset: 'jpy',
						amount: '1000000',
						status: 'DONE',
						found_at: beforeYearStartMs,
						confirmed_at: beforeYearStartMs,
					},
					{
						uuid: 'd-post',
						asset: 'jpy',
						amount: '500000',
						status: 'DONE',
						found_at: afterYearStartMs,
						confirmed_at: afterYearStartMs,
					},
				],
			};

			globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
				const _maybeMargin = maybeMarginAccountResponse(urlStr);
				if (_maybeMargin) return _maybeMargin;
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
					return new Response(JSON.stringify(mockBitbankSuccess({ trades: [] })), { status: 200 });
				}
				if (urlStr.includes('deposit_history')) {
					return new Response(JSON.stringify(mockBitbankSuccess(customDeposits)), { status: 200 });
				}
				if (urlStr.includes('withdrawal_history')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
				}
				return new Response(JSON.stringify(mockBitbankSuccess({})), { status: 200 });
			}) as unknown as typeof fetch;

			const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
			const result = await handler({
				include_technical: false,
				include_pnl: true,
				include_deposit_withdrawal: true,
			});

			assertOk(result);
			const dw = result.data.deposit_withdrawal_summary;
			expect(dw).toBeDefined();
			// 純投入額は年初前 1_000_000 + 年初後 500_000 = 1_500_000
			expect(dw.total_jpy_deposited).toBe(1_500_000);
			expect(dw.net_jpy_invested).toBe(1_500_000);
			// account_return = 現在総資産 - 純投入額。総資産 > 純投入額なら正値
			expect(dw.account_return_jpy).toBeDefined();
			const totalValue = result.data.total_jpy_value;
			expect(dw.account_return_jpy).toBe(totalValue - 1_500_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it('年初前買い → 年初後売り: yearly_realized_pnl が「売値 - 平均取得単価」で計算される', async () => {
		// 固定時刻 2026-05-16 12:00 JST。
		// 約定: 年初前買い 1 BTC @ 10_000_000（2025-12-01）+ 年初後売り 0.5 BTC @ 12_000_000（2026-03-01）
		// 旧実装: 年初前買いが欠落 → 売却代金 6_000_000 が realized に積まれる
		// 新実装: 平均原価 10_000_000 で按分 → realized = 0.5 * (12_000_000 - 10_000_000) = 1_000_000
		const fixedNowMs = Date.UTC(2026, 4, 16, 3, 0, 0, 0);
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);
		try {
			const beforeYearStartMs = Date.UTC(2025, 11, 1, 0, 0, 0, 0); // 2025-12-01
			const afterYearStartMs = Date.UTC(2026, 2, 1, 0, 0, 0, 0); // 2026-03-01

			const customTrades = {
				trades: [
					{
						trade_id: 1,
						pair: 'btc_jpy',
						order_id: 1,
						side: 'buy',
						type: 'limit',
						amount: '1',
						price: '10000000',
						maker_taker: 'maker',
						fee_amount_base: '0',
						fee_amount_quote: '0',
						executed_at: beforeYearStartMs,
					},
					{
						trade_id: 2,
						pair: 'btc_jpy',
						order_id: 2,
						side: 'sell',
						type: 'market',
						amount: '0.5',
						price: '12000000',
						maker_taker: 'taker',
						fee_amount_base: '0',
						fee_amount_quote: '0',
						executed_at: afterYearStartMs,
					},
				],
			};

			globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
				const _maybeMargin = maybeMarginAccountResponse(urlStr);
				if (_maybeMargin) return _maybeMargin;
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
					const isMargin = urlStr.includes('type=margin');
					if (isMargin) {
						return new Response(JSON.stringify(mockBitbankSuccess({ trades: [] })), { status: 200 });
					}
					return new Response(JSON.stringify(mockBitbankSuccess(customTrades)), { status: 200 });
				}
				if (urlStr.includes('deposit_history')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [] })), { status: 200 });
				}
				if (urlStr.includes('withdrawal_history')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
				}
				return new Response(JSON.stringify(mockBitbankSuccess({})), { status: 200 });
			}) as unknown as typeof fetch;

			const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
			const result = await handler({
				include_technical: false,
				include_pnl: true,
				include_deposit_withdrawal: false,
			});

			assertOk(result);
			// 年初後の sell が yearly に集計される
			expect(result.data.yearly_realized_pnl).toBeDefined();
			expect(result.data.yearly_realized_pnl.realized_pnl).toBe(1_000_000);
			expect(result.data.yearly_realized_pnl.sell_count).toBe(1);
			// 全履歴の realized_pnl も同じ（年初前 buy のみで sell は 1 件のみ）
			expect(result.data.total_realized_pnl).toBe(1_000_000);
			expect(result.data.account_pnl.spot_realized_pnl).toBe(1_000_000);
			// BTC 残保有 0.5 → cost_basis = 0.5 * 10_000_000 = 5_000_000
			const btcHolding = result.data.holdings.find((h: { asset: string }) => h.asset === 'btc');
			expect(btcHolding).toBeDefined();
			expect(btcHolding.cost_basis).toBe(5_000_000);
			expect(btcHolding.avg_buy_price).toBe(10_000_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it('年初前出庫 + 年初後売却: yearly_realized_pnl が出庫後の平均原価を使う', async () => {
		// バグ回帰防止 (Medium): 旧 calcPeriodRealizedPnl は出庫を無視していたため、
		// 出庫後の売却で残数量・平均原価が calcPnl とズレていた。
		// 買い 1 BTC @ 10_000_000（2025-12-01）→ 出庫 0.3 BTC（2025-12-15, fee 0.001）→ 売り 0.5 BTC @ 12_000_000（2026-03-01）
		// 出庫後: qty=0.699, cost=6_990_000, avgCost=10_000_000
		// 売り 0.5: sellCost=5_000_000, sellRev=6_000_000, realized=1_000_000
		const fixedNowMs = Date.UTC(2026, 4, 16, 3, 0, 0, 0);
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);
		try {
			const buyMs = Date.UTC(2025, 11, 1, 0, 0, 0, 0);
			const wdMs = Date.UTC(2025, 11, 15, 0, 0, 0, 0);
			const sellMs = Date.UTC(2026, 2, 1, 0, 0, 0, 0);

			const customTrades = {
				trades: [
					{
						trade_id: 1,
						pair: 'btc_jpy',
						order_id: 1,
						side: 'buy',
						type: 'limit',
						amount: '1',
						price: '10000000',
						maker_taker: 'maker',
						fee_amount_base: '0',
						fee_amount_quote: '0',
						executed_at: buyMs,
					},
					{
						trade_id: 2,
						pair: 'btc_jpy',
						order_id: 2,
						side: 'sell',
						type: 'market',
						amount: '0.5',
						price: '12000000',
						maker_taker: 'taker',
						fee_amount_base: '0',
						fee_amount_quote: '0',
						executed_at: sellMs,
					},
				],
			};
			const customWithdrawals = {
				withdrawals: [
					{
						uuid: 'wd-btc',
						asset: 'btc',
						amount: '0.3',
						fee: '0.001',
						status: 'DONE',
						requested_at: wdMs,
					},
				],
			};

			globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
				const _maybeMargin = maybeMarginAccountResponse(urlStr);
				if (_maybeMargin) return _maybeMargin;
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
					const isMargin = urlStr.includes('type=margin');
					if (isMargin) {
						return new Response(JSON.stringify(mockBitbankSuccess({ trades: [] })), { status: 200 });
					}
					return new Response(JSON.stringify(mockBitbankSuccess(customTrades)), { status: 200 });
				}
				if (urlStr.includes('deposit_history')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [] })), { status: 200 });
				}
				if (urlStr.includes('withdrawal_history')) {
					const isJpy = urlStr.includes('asset=jpy');
					if (isJpy) {
						return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
					}
					return new Response(JSON.stringify(mockBitbankSuccess(customWithdrawals)), { status: 200 });
				}
				return new Response(JSON.stringify(mockBitbankSuccess({})), { status: 200 });
			}) as unknown as typeof fetch;

			const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
			const result = await handler({
				include_technical: false,
				include_pnl: true,
				include_deposit_withdrawal: true,
			});

			assertOk(result);
			// yearly_realized_pnl: 出庫を反映した平均原価で計算
			expect(result.data.yearly_realized_pnl).toBeDefined();
			expect(result.data.yearly_realized_pnl.realized_pnl).toBe(1_000_000);
			// total_realized_pnl も同じ（calcPnl と calcPeriodRealizedPnl の整合）
			expect(result.data.total_realized_pnl).toBe(1_000_000);
		} finally {
			vi.useRealTimers();
		}
	});

	// ── 信用口座状態・建玉サマリの統合（Cursor レビュー D 対応） ──

	it('信用建玉あり: summary に建玉ブロックが含まれる', async () => {
		// rawMarginPositionsResponse は BTC ロング 0.01 / ETH ショート 1.0 の 2 件。
		setupFetchMock({ marginPositions: rawMarginPositionsResponse });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expect(result.summary).toContain('信用建玉:');
		expect(result.summary).toContain('BTC/JPY ロング 0.01');
		expect(result.summary).toContain('ETH/JPY ショート 1.0');
		expect(result.summary).toContain('集計: ロング 1件 / ショート 1件');
		// rawMarginStatusResponse.margin_position_profit_loss = '50000' を踏襲
		expect(result.summary).toContain('建玉含み損益: +50,000円');
		expect(result.meta.marginPositionsFetchFailed).toBe(false);
		expect(result.meta.marginStatusFetchFailed).toBe(false);
	});

	it('信用建玉なし: summary に建玉ブロックが含まれない', async () => {
		// デフォルトの rawMarginPositionsEmptyResponse は positions=[] を返す。
		setupFetchMock();

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expect(result.summary).not.toContain('信用建玉:');
		expect(result.meta.marginPositionsFetchFailed).toBe(false);
		expect(result.meta.marginStatusFetchFailed).toBe(false);
	});

	it('status = CALL: summary 先頭付近に追証警告 / status = LOSSCUT: ロスカット警告', async () => {
		// CALL ケース
		setupFetchMock({
			marginStatus: { ...rawMarginStatusResponse, status: 'CALL' },
		});
		const { default: handlerCall } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const resultCall = await handlerCall({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});
		assertOk(resultCall);
		expect(resultCall.summary).toContain('⚠ 追証発生中（CALL）');
		// 警告は summary 先頭付近 (先頭 5 行以内) に出ることを確認
		const firstFiveLinesCall = resultCall.summary.split('\n').slice(0, 5).join('\n');
		expect(firstFiveLinesCall).toContain('⚠ 追証発生中（CALL）');

		// LOSSCUT ケース（vi.resetModules で動的 import を再評価する必要があるが、
		// afterEach の resetModules でクリーンに分離される。同 it 内では一度 reset を挟む）
		vi.resetModules();
		setupFetchMock({
			marginStatus: { ...rawMarginStatusResponse, status: 'LOSSCUT' },
		});
		const { default: handlerLc } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const resultLc = await handlerLc({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});
		assertOk(resultLc);
		expect(resultLc.summary).toContain('⚠ 強制決済中（LOSSCUT）');
		const firstFiveLinesLc = resultLc.summary.split('\n').slice(0, 5).join('\n');
		expect(firstFiveLinesLc).toContain('⚠ 強制決済中（LOSSCUT）');
	});

	it('get_margin_status 失敗: ⚠️ 信用口座状態の取得に失敗 warning + meta.marginStatusFetchFailed === true', async () => {
		setupFetchMock({ marginStatusFail: true });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expect(result.summary).toContain('⚠️ 信用口座状態の取得に失敗');
		expect(result.meta.marginStatusFetchFailed).toBe(true);
		expect(result.meta.marginPositionsFetchFailed).toBe(false);
		// 信用約定 fetch とは独立して扱われていること
		expect(result.meta.marginFetchFailed).toBe(false);
		// 信用約定 / 信用建玉 fetch には言及していないこと（原因切り分け確認）
		expect(result.summary).not.toContain('⚠️ 信用建玉の取得に失敗');
		expect(result.summary).not.toContain('⚠️ 信用約定の取得に失敗');
	});

	it('get_margin_positions 失敗: ⚠️ 信用建玉の取得に失敗 warning + meta.marginPositionsFetchFailed === true', async () => {
		setupFetchMock({ marginPositionsFail: true });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expect(result.summary).toContain('⚠️ 信用建玉の取得に失敗');
		expect(result.meta.marginPositionsFetchFailed).toBe(true);
		expect(result.meta.marginStatusFetchFailed).toBe(false);
		// 信用約定 fetch とは独立して扱われていること
		expect(result.meta.marginFetchFailed).toBe(false);
		// 建玉サマリ自体は出力されない（fetch 失敗のため）
		expect(result.summary).not.toContain('信用建玉:\n');
	});

	it('信用約定 / 信用口座状態 / 信用建玉が同時に失敗: warning が 1 行に集約されず別々に出る', async () => {
		// 原因切り分けのため、3 系統の warning が独立して summary に並ぶことを確認。
		setupFetchMock({
			marginTradesFail: true,
			marginStatusFail: true,
			marginPositionsFail: true,
		});

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expect(result.summary).toContain('⚠️ 信用約定の取得に失敗');
		expect(result.summary).toContain('⚠️ 信用口座状態の取得に失敗');
		expect(result.summary).toContain('⚠️ 信用建玉の取得に失敗');
		expect(result.meta.marginFetchFailed).toBe(true);
		expect(result.meta.marginStatusFetchFailed).toBe(true);
		expect(result.meta.marginPositionsFetchFailed).toBe(true);
	});
});

describe('analyze_my_portfolio — toolDef handler', () => {
	it('handler がデフォルト引数で動作する', async () => {
		// setup URL routing fetch mock
		globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			const _maybeMargin = maybeMarginAccountResponse(urlStr);
			if (_maybeMargin) return _maybeMargin;

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
		const result = await toolDef.handler({
			include_pnl: true,
			include_technical: false,
			include_deposit_withdrawal: true,
		});

		expect('content' in result).toBe(true);
		const structured = (
			result as {
				content: Array<{ type: string; text: string }>;
				structuredContent: { ok: boolean; summary: string; data: Record<string, unknown> };
			}
		).structuredContent;
		expect(structured.ok).toBe(true);
		const text = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
		expect(text.startsWith(structured.summary)).toBe(true);
		const jsonStart = text.indexOf('\n{');
		expect(jsonStart).toBeGreaterThan(0);
		const dataInContent = JSON.parse(text.slice(jsonStart + 1)) as Record<string, unknown>;
		expect(dataInContent).toEqual(structured.data);
		if (Array.isArray(structured.data.monthly_equity_series) && structured.data.monthly_equity_series.length > 0) {
			expect(text).toContain('monthly_equity_series');
			expect(text).toContain('yearly_equity_series');
		}
	});
});
