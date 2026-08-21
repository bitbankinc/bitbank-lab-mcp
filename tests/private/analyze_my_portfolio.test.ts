/**
 * analyze_my_portfolio ツールのユニットテスト。
 *
 * 複合ツール（assets + trades + tickers + deposits/withdrawals + technical）の
 * 統合動作を検証する。URL ベースのルーティングで複数 API 呼び出しをモック。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFail, assertOk } from '../_assertResult.js';
import { candlesBtcJpy1day120, generateOhlcv, tickersJpy } from '../fixtures/bitbank-api.js';
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
	assets?: unknown;
	assetsFail?: boolean;
	tradesFail?: boolean;
	marginTradesFail?: boolean;
	dwFail?: boolean;
	marginTrades?: unknown;
	marginStatusFail?: boolean;
	marginStatus?: unknown;
	marginPositionsFail?: boolean;
	marginPositions?: unknown;
	deposits?: unknown;
	withdrawals?: unknown;
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
			return new Response(JSON.stringify(mockBitbankSuccess(opts?.assets ?? rawAssetsResponse)), { status: 200 });
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
			return new Response(JSON.stringify(mockBitbankSuccess(opts?.deposits ?? rawDepositHistoryResponse)), {
				status: 200,
			});
		}

		// Private API: withdrawal history
		if (urlStr.includes('withdrawal_history')) {
			if (opts?.dwFail) {
				return new Response(JSON.stringify(mockBitbankError(10007)), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess(opts?.withdrawals ?? rawWithdrawalHistoryResponse)), {
				status: 200,
			});
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
			// cost_basis / avg_buy_price を検証するため入出金履歴ありで呼ぶ。
			// include_deposit_withdrawal=false だと出庫履歴が無く取得原価を確定できないため、
			// これらのフィールドは意図的に出力されない（cost_basis_unavailable_reason を参照）。
			const result = await handler({
				include_technical: false,
				include_pnl: true,
				include_deposit_withdrawal: true,
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

describe('analyze_my_portfolio — 信頼できない損益値の null 化', () => {
	/**
	 * 入出金履歴が無い状態の cost_basis は、出庫済み数量の取得原価が残留して過大になる
	 * （移動平均法で暗号資産出庫を原価の按分減少として処理しているため）。
	 * その原価から出した「合計評価損益 -60.9%」型の確定値を一切出さないことを固定する。
	 */
	const COST_FIELDS = ['avg_buy_price', 'cost_basis', 'unrealized_pnl', 'unrealized_pnl_pct'] as const;

	/**
	 * 全暗号資産銘柄で原価由来の 4 フィールドが出ておらず、理由コードが併記されていること、
	 * および合計側も同様であることをまとめて検証する。
	 * 原価に依存しない値（評価額）は落としていないことも併せて確認する。
	 */
	function expectCostFieldsSuppressed(result: { data: Record<string, unknown> }, reason: string) {
		const holdings = result.data.holdings as Array<Record<string, unknown>>;
		const crypto = holdings.filter((h) => h.asset !== 'jpy');
		expect(crypto.length).toBeGreaterThan(0);
		for (const h of crypto) {
			for (const f of COST_FIELDS) expect(h[f]).toBeUndefined();
			expect(h.cost_basis_unavailable_reason).toBe(reason);
			// 原価に依存しない値は落とさない（評価額・現在価格・実現損益は引き続き使える）
			expect(h.jpy_value).toBeDefined();
		}
		expect(result.data.total_cost_basis).toBeUndefined();
		expect(result.data.total_unrealized_pnl).toBeUndefined();
		expect(result.data.total_unrealized_pnl_pct).toBeUndefined();
		expect(result.data.total_cost_basis_unavailable_reason).toBe(reason);
	}

	it('include_deposit_withdrawal=false でも取得失敗なら抑止される（判定は取得結果だけを見る）', async () => {
		// 表示セクションを閉じていても損益計算のために入出金は読むので、そこが落ちれば
		// 原価は信頼できない。抑止の判定軸が表示フラグではなく取得結果であることを固定する。
		setupFetchMock({ dwFail: true });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expectCostFieldsSuppressed(result, 'dw_fetch_failed');
		expect(result.meta.flowDataUnavailableReason).toBe('dw_fetch_failed');
		// セクション側の状態は表示フラグどおり not_requested のまま（別軸）
		expect(result.meta.depositWithdrawalStatus).toBe('not_requested');
		expect(result.meta.dwFetchedForPnl).toBe(false);
	});

	it('入出金 API 全失敗 (allFailed): 取得原価系が undefined + dw_fetch_failed', async () => {
		setupFetchMock({ dwFail: true });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		expectCostFieldsSuppressed(result, 'dw_fetch_failed');
		expect(result.meta.flowDataUnavailableReason).toBe('dw_fetch_failed');
		expect(result.meta.depositWithdrawalStatus).toBe('fallback');
	});

	it('暗号資産出庫チャネルだけ失敗: available のままでも取得原価は抑止される', async () => {
		// fetchDepositWithdrawal は 暗号資産入庫 / JPY入金 / 暗号資産出庫 / JPY出金 の
		// 4 チャネルを個別に取得する。暗号資産出庫だけ落ちても他にレコードがあれば
		// allFailed=false → status=available になるが、cost_basis を過大化させる当の出庫が
		// 欠けた withdrawals がそのまま calcPnl に渡るため、原価は信頼できない。
		globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			const marginResponse = maybeMarginAccountResponse(urlStr);
			if (marginResponse) return marginResponse;
			if (urlStr.includes('tickers_jpy')) return new Response(JSON.stringify(tickersJpy), { status: 200 });
			if (urlStr.includes('candlestick')) return new Response(JSON.stringify(candlesBtcJpy1day120), { status: 200 });
			if (urlStr.includes('/v1/user/assets')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawAssetsResponse)), { status: 200 });
			}
			if (urlStr.includes('trade_history')) {
				const payload = urlStr.includes('type=margin') ? { trades: [] } : rawTradeHistoryResponse;
				return new Response(JSON.stringify(mockBitbankSuccess(payload)), { status: 200 });
			}
			if (urlStr.includes('deposit_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawDepositHistoryResponse)), { status: 200 });
			}
			if (urlStr.includes('withdrawal_history')) {
				// 暗号資産チャネル（asset 指定なし）だけ失敗させ、JPY チャネルは成功させる
				if (!urlStr.includes('asset=jpy')) {
					return new Response(JSON.stringify(mockBitbankError(10007)), { status: 200 });
				}
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
		// status は「どの分析基準を出力したか」なので available のまま
		expect(result.meta.depositWithdrawalStatus).toBe('available');
		// 「取得原価を信頼してよいか」は別軸で、こちらは閉じる
		expect(result.meta.flowDataUnavailableReason).toBe('dw_fetch_failed');
		expectCostFieldsSuppressed(result, 'dw_fetch_failed');
		// 入出金サマリーは実データのまま残す（原価の信頼性とは別問題）
		expect(result.data.deposit_withdrawal_summary).toBeDefined();
		expect(result.data.deposit_withdrawal_summary.analysis_basis).toBe('deposit_withdrawal');
	});

	it('回帰: include_deposit_withdrawal=true かつ取得成功なら従来どおり数値が出る', async () => {
		setupFetchMock();

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		const btc = result.data.holdings.find((h: { asset: string }) => h.asset === 'btc');
		expect(btc.cost_basis).toBeGreaterThan(0);
		expect(btc.avg_buy_price).toBeGreaterThan(0);
		expect(btc.unrealized_pnl).toBeDefined();
		expect(btc.cost_basis_unavailable_reason).toBeUndefined();
		expect(result.data.total_cost_basis).toBeGreaterThan(0);
		expect(result.data.total_unrealized_pnl).toBeDefined();
		expect(result.data.total_cost_basis_unavailable_reason).toBeUndefined();
		expect(result.meta.flowDataUnavailableReason).toBeUndefined();
		expect(result.summary).toContain('合計評価損益（全履歴の約定ベース）');
		expect(result.summary).not.toContain('算出不能');
	});

	it('境界: 入出金履歴 0 件 (no_history) は「本当に出庫ゼロ」なので数値を出す', async () => {
		// 「未取得」と「取得できて 0 件」は別物。後者まで潰すと使える情報まで失われる。
		setupFetchMock({ deposits: { deposits: [] }, withdrawals: { withdrawals: [] } });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		expect(result.meta.depositWithdrawalStatus).toBe('no_history');
		expect(result.meta.flowDataUnavailableReason).toBeUndefined();
		const btc = result.data.holdings.find((h: { asset: string }) => h.asset === 'btc');
		expect(btc.cost_basis).toBeGreaterThan(0);
		expect(result.data.daily_performance.flow_measured).toBe(true);
		expect(result.data.daily_performance.net_flow_jpy).toBe(0);
	});

	it('期間パフォーマンス: net_flow / adjusted_change が null + flow_measured=false', async () => {
		setupFetchMock({ dwFail: true });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		for (const key of ['daily_performance', 'yearly_performance', 'monthly_performance'] as const) {
			const p = result.data[key];
			expect(p, key).toBeDefined();
			expect(p.net_flow_jpy, key).toBeNull();
			expect(p.withdrawal_fee_jpy, key).toBeNull();
			expect(p.adjusted_change_jpy, key).toBeNull();
			expect(p.adjusted_change_pct, key).toBeNull();
			expect(p.flow_measured, key).toBe(false);
			expect(p.flow_unavailable_reason, key).toBe('dw_fetch_failed');
			// 単純増減は入出金の影響が混ざったままだが値としては残す
			expect(typeof p.change_jpy, key).toBe('number');
		}
	});

	it('summary: 「算出不能」行と「純入出金: 未計測」行が出る（確定値は出ない）', async () => {
		setupFetchMock({ dwFail: true });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		expect(result.summary).toContain('評価損益: 算出不能');
		expect(result.summary).toContain('入出金履歴の取得に失敗したため取得原価を確定できません');
		expect(result.summary).not.toContain('合計評価損益（全履歴の約定ベース）');
		// 3 期間すべてに未計測行が出る（行ごと省くと「調整不要な口座」に見える）
		expect(result.summary.match(/純入出金: 未計測/g)).toHaveLength(3);
		// 資産推移・期初評価額の品質注記
		expect(result.summary).toContain('入出金を巻き戻せていません');
	});

	it('summary: 再取得の案内が include_deposit_withdrawal を切り替えろとは言わない', async () => {
		// 同フラグは表示セクションの制御しかしないので、切り替えても原価は復活しない。
		// 誤った案内を出す経路が残っていないことを固定する。
		setupFetchMock({ dwFail: true });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expect(result.summary).toContain('時間をおいて再実行してください');
		expect(result.summary).not.toContain('include_deposit_withdrawal: true で再実行してください');
	});

	it('warning が meta.warnings と content の JSON より前に出る', async () => {
		setupFetchMock({ dwFail: true });

		const { toolDef } = await import('../../tools/private/analyze_my_portfolio.js');
		const result = await toolDef.handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		const text = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
		const warningIndex = text.indexOf('評価損益・取得原価は算出していません');
		const jsonIndex = text.indexOf('\n{');
		expect(warningIndex).toBeGreaterThanOrEqual(0);
		expect(jsonIndex).toBeGreaterThan(0);
		expect(warningIndex).toBeLessThan(jsonIndex);
		expect(text.split('\n')[0]).toContain('⚠️');

		const structured = (result as { structuredContent: { meta: { warnings?: string[] } } }).structuredContent;
		expect(structured.meta.warnings?.some((w) => w.includes('評価損益・取得原価は算出していません'))).toBe(true);
	});

	it('include_pnl=false: 抑止対象が無いので理由コードは立たない（誤った再実行案内を出さない）', async () => {
		// エッジ: 損益が未リクエストのケースと、入出金欠落で損益を潰したケースを混同しない。
		// 前者で理由コードを立てると「入出金を取れば原価が出る」という誤案内になる。
		setupFetchMock();

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: false,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expect(result.data.daily_performance).toBeUndefined();
		expect(result.data.total_cost_basis).toBeUndefined();
		expect(result.data.total_cost_basis_unavailable_reason).toBeUndefined();
		expect(result.meta.flowDataUnavailableReason).toBeUndefined();
		const btc = result.data.holdings.find((h: { asset: string }) => h.asset === 'btc');
		expect(btc.cost_basis).toBeUndefined();
		expect(btc.realized_pnl).toBeUndefined();
		expect(btc.cost_basis_unavailable_reason).toBeUndefined();
		expect(result.summary).not.toContain('算出不能');
	});
});

/**
 * 入出金履歴の取得を `include_pnl` に紐づけ、`include_deposit_withdrawal` を
 * 「入出金分析セクションを出すか」だけの表示フラグに限定する（フラグの直交化）。
 *
 * 取得原価（移動平均法）は暗号資産出庫を原価の按分減少として処理し、期初評価額と
 * 資産推移シリーズは入出金の巻き戻しを前提にしている。つまり損益を出す時点で入出金履歴は
 * 必須の入力であり、表示フラグでこれを落とすと計算そのものが壊れていた。
 */
describe('analyze_my_portfolio — 入出金取得の include_pnl 紐づけ', () => {
	/**
	 * 現物約定 fixture より後に発生した btc 出庫。
	 * 出庫が約定より前だと holdingQty が 0 で原価に影響せず、テストが素通りしてしまう。
	 */
	const btcWithdrawalAfterTrades = {
		withdrawals: [
			{ uuid: 'wd-btc', asset: 'btc', amount: '0.002', fee: '0.0006', status: 'DONE', requested_at: 1710000300000 },
		],
	};

	/**
	 * 出庫を按分した btc 取得原価。
	 * 約定のみ: 買 0.01 @15,000,000（手数料 0.00001 BTC）→ 売 0.005 @15,500,000（手数料 77.5 JPY）で
	 * 残 0.00499 BTC / 原価 74,925 円。ここから出庫 0.002 + 出庫手数料 0.0006 = 0.0026 BTC を
	 * 平均単価で按分減少させると 0.00239 BTC / 原価 35,886 円になる。
	 * 出庫が calcPnl に渡らないと 74,925 円のまま残り、約 2.1 倍の過大原価になる。
	 */
	const BTC_COST_BASIS_WITH_WITHDRAWAL = 35_886;
	const BTC_COST_BASIS_WITHOUT_WITHDRAWAL = 74_925;

	/** モックに記録された fetch 呼び出しの URL 一覧 */
	function fetchedUrls(): string[] {
		const mock = globalThis.fetch as unknown as { mock: { calls: Array<[string | URL | Request]> } };
		return mock.mock.calls.map(([u]) => (typeof u === 'string' ? u : u instanceof URL ? u.href : u.url));
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it('include_deposit_withdrawal=false + include_pnl=true: 出庫が calcPnl に渡り cost_basis が按分済みになる', async () => {
		setupFetchMock({ withdrawals: btcWithdrawalAfterTrades });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		const btc = result.data.holdings.find((h: { asset: string }) => h.asset === 'btc');
		// P1 で null になっていた値が復活し、かつ出庫を按分した正しい値であること
		expect(btc.cost_basis).toBe(BTC_COST_BASIS_WITH_WITHDRAWAL);
		expect(btc.cost_basis).not.toBe(BTC_COST_BASIS_WITHOUT_WITHDRAWAL);
		expect(btc.avg_buy_price).toBeGreaterThan(0);
		expect(btc.unrealized_pnl).toBeDefined();
		expect(btc.cost_basis_unavailable_reason).toBeUndefined();
		expect(result.data.total_cost_basis_unavailable_reason).toBeUndefined();
		expect(result.meta.flowDataUnavailableReason).toBeUndefined();
		expect(result.meta.dwFetchedForPnl).toBe(true);
		expect(result.summary).toContain('合計評価損益（全履歴の約定ベース）');
		expect(result.summary).not.toContain('算出不能');
	});

	it('include_deposit_withdrawal を切り替えても損益側の出力は変わらない', async () => {
		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');

		setupFetchMock({ withdrawals: btcWithdrawalAfterTrades });
		const withSection = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});
		setupFetchMock({ withdrawals: btcWithdrawalAfterTrades });
		const withoutSection = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(withSection);
		assertOk(withoutSection);
		expect(withoutSection.data.holdings).toEqual(withSection.data.holdings);
		expect(withoutSection.data.total_cost_basis).toEqual(withSection.data.total_cost_basis);
		expect(withoutSection.data.total_unrealized_pnl).toEqual(withSection.data.total_unrealized_pnl);
		expect(withoutSection.meta.dwFetchedForPnl).toBe(true);
		// 変わるのは表示セクション側だけ
		expect(withSection.data.deposit_withdrawal_summary).toBeDefined();
		expect(withoutSection.data.deposit_withdrawal_summary).toBeUndefined();
		expect(withoutSection.data.yearly_dw_summary).toBeUndefined();
		expect(withoutSection.data.monthly_dw_summary).toBeUndefined();
		expect(withSection.meta.depositWithdrawalStatus).toBe('available');
		expect(withoutSection.meta.depositWithdrawalStatus).toBe('not_requested');
	});

	it('include_deposit_withdrawal=false: net_flow_jpy / adjusted_change_jpy が実測値になる', async () => {
		// 2026-05-16 12:00 JST / 期間内 10:00 JST（daily / monthly / yearly すべてに入る）
		const fixedNowMs = Date.UTC(2026, 4, 16, 3, 0, 0, 0);
		const inPeriodMs = Date.UTC(2026, 4, 16, 1, 0, 0, 0);
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);
		setupFetchMock({
			deposits: {
				deposits: [
					{
						uuid: 'dep-jpy',
						asset: 'jpy',
						amount: '500000',
						status: 'DONE',
						found_at: inPeriodMs,
						confirmed_at: inPeriodMs,
					},
				],
			},
			withdrawals: {
				withdrawals: [
					{ uuid: 'wd-jpy', asset: 'jpy', amount: '200000', fee: '550', status: 'DONE', requested_at: inPeriodMs },
				],
			},
		});

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		const daily = result.data.daily_performance;
		expect(daily.flow_measured).toBe(true);
		expect(daily.flow_unavailable_reason).toBeUndefined();
		// 純入出金は元本移動のみ（出金手数料は別建て）
		expect(daily.net_flow_jpy).toBe(300_000);
		expect(daily.withdrawal_fee_jpy).toBe(550);
		expect(daily.adjusted_change_jpy).toBe(daily.change_jpy - 300_000);
		expect(result.summary).toContain('純入出金（元本）');
		expect(result.summary).not.toContain('純入出金: 未計測');
	});

	it('include_pnl=false: 入出金 API を余計に呼ばない（呼び出し増の回帰防止）', async () => {
		setupFetchMock();

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: false,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		const urls = fetchedUrls();
		expect(urls.some((u) => u.includes('deposit_history'))).toBe(false);
		expect(urls.some((u) => u.includes('withdrawal_history'))).toBe(false);
		expect(result.meta.dwFetchedForPnl).toBe(false);
		expect(result.meta.depositWithdrawalStatus).toBe('not_requested');
	});

	it('include_pnl=false + include_deposit_withdrawal=true: 入出金分析だけ欲しい従来動作を維持する', async () => {
		setupFetchMock();

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: false,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		const urls = fetchedUrls();
		expect(urls.some((u) => u.includes('deposit_history'))).toBe(true);
		expect(urls.some((u) => u.includes('withdrawal_history'))).toBe(true);
		// 約定履歴は引き続き取得しない
		expect(urls.some((u) => u.includes('trade_history') && !u.includes('type=margin'))).toBe(false);
		expect(result.data.deposit_withdrawal_summary).toBeDefined();
		expect(result.meta.depositWithdrawalStatus).toBe('available');
		// 損益を出さないので入出金履歴は損益計算に供給されていない
		expect(result.meta.dwFetchedForPnl).toBe(false);
		expect(result.meta.flowDataUnavailableReason).toBeUndefined();
	});

	it('summary: セクション未リクエストでも損益に入出金を使っている旨が content に出る', async () => {
		// content[0].text が LLM への唯一のチャネルなので、not_requested を
		// 「損益も入出金を見ていない」と読まれないようテキスト側で打ち消す。
		setupFetchMock({ withdrawals: btcWithdrawalAfterTrades });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expect(result.summary).toContain('入出金分析状態: not_requested');
		expect(result.summary).toContain('損益計算には入出金履歴を取得して使用している');
		expect(result.summary).not.toContain('※ 入出金分析は未リクエスト。約定ベースの分析のみです');
	});

	it('summary: 部分失敗で原価を抑止したときは「反映済み」と言わない（同一テキスト内の自己矛盾を防ぐ）', async () => {
		// 暗号資産出庫チャネルだけ落ちると allFailed=false のまま warnings が立つので、
		// dwFetchedForPnl は true でも取得原価は抑止される（flowUnavailableReason=dw_fetch_failed）。
		// ここで「取得原価・評価損益は入出金を反映した値です」と言うと、同じ content 内の
		// 「評価損益: 算出不能」と真っ向から矛盾する。text しか読まない LLM には解けない。
		globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			const marginResponse = maybeMarginAccountResponse(urlStr);
			if (marginResponse) return marginResponse;
			if (urlStr.includes('tickers_jpy')) return new Response(JSON.stringify(tickersJpy), { status: 200 });
			if (urlStr.includes('candlestick')) return new Response(JSON.stringify(candlesBtcJpy1day120), { status: 200 });
			if (urlStr.includes('/v1/user/assets')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawAssetsResponse)), { status: 200 });
			}
			if (urlStr.includes('trade_history')) {
				const payload = urlStr.includes('type=margin') ? { trades: [] } : rawTradeHistoryResponse;
				return new Response(JSON.stringify(mockBitbankSuccess(payload)), { status: 200 });
			}
			if (urlStr.includes('deposit_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawDepositHistoryResponse)), { status: 200 });
			}
			if (urlStr.includes('withdrawal_history')) {
				// 暗号資産チャネル（asset 指定なし）だけ失敗させ、JPY チャネルは成功させる
				if (!urlStr.includes('asset=jpy')) {
					return new Response(JSON.stringify(mockBitbankError(10007)), { status: 200 });
				}
				return new Response(JSON.stringify(mockBitbankSuccess(rawWithdrawalHistoryResponse)), { status: 200 });
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
		// 取得自体は成立しているが、欠けたチャネルがあるので原価は抑止されている
		expect(result.meta.dwFetchedForPnl).toBe(true);
		expect(result.meta.flowDataUnavailableReason).toBe('dw_fetch_failed');
		expect(result.summary).toContain('評価損益: 算出不能');
		// その状態で「反映した値です」と断言しない
		expect(result.summary).not.toContain('取得原価・評価損益・純入出金は入出金を反映した値です');
	});

	it('include_pnl=false: 入出金を読まないので未リクエストの文言は従来のまま', async () => {
		setupFetchMock();

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: false,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expect(result.summary).toContain('※ 入出金分析は未リクエスト。約定ベースの分析のみです');
		expect(result.summary).not.toContain('損益計算には入出金履歴を取得して使用している');
	});
});

describe('analyze_my_portfolio — equity series データ品質', () => {
	/** JPY のみ保有: 暗号資産なし → equity series は JPY 残高ベースで構築される */
	it('JPY のみ保有でも equity series が構築される (quality=jpy_only)', async () => {
		const jpyOnlyAssets = {
			assets: [
				{
					asset: 'jpy',
					free_amount: '10560',
					amount_precision: 0,
					onhand_amount: '10560',
					locked_amount: '0',
					withdrawing_amount: '0',
					withdrawal_fee: { under: '550', over: '770', threshold: '30000' },
					stop_deposit: false,
					stop_withdrawal: false,
					collateral_ratio: '1',
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
			if (urlStr.includes('/v1/user/assets')) {
				return new Response(JSON.stringify(mockBitbankSuccess(jpyOnlyAssets)), { status: 200 });
			}
			if (urlStr.includes('trade_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ trades: [] })), { status: 200 });
			}
			if (urlStr.includes('deposit_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [] })), { status: 200 });
			}
			if (urlStr.includes('withdrawal_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
			}
			// candlestick は呼ばれない想定（allRelevantPairs が空のため）
			return new Response(JSON.stringify(mockBitbankSuccess({})), { status: 200 });
		}) as unknown as typeof fetch;

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		expect(result.data.monthly_equity_series).toBeDefined();
		expect(result.data.yearly_equity_series).toBeDefined();
		expect(result.data.monthly_equity_series?.length).toBeGreaterThan(0);
		expect(result.data.yearly_equity_series?.length).toBeGreaterThan(0);
		expect(result.meta.equitySeriesQuality).toBe('jpy_only');
		expect(result.summary).toContain('JPY のみ保有');
		// 最終点は currentValueJpy = 10,560
		const last = result.data.monthly_equity_series?.[result.data.monthly_equity_series.length - 1];
		expect(last?.value_jpy).toBe(10560);
	});

	/** 暗号資産あり・全 candle 取得失敗 → 現在価格にフォールバック (quality=fallback_only) */
	it('candle 取得が全失敗しても equity series が構築される (quality=fallback_only)', async () => {
		globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			const _maybeMargin = maybeMarginAccountResponse(urlStr);
			if (_maybeMargin) return _maybeMargin;
			if (urlStr.includes('tickers_jpy')) {
				return new Response(JSON.stringify(tickersJpy), { status: 200 });
			}
			if (urlStr.includes('candlestick')) {
				// 全 candle fetch を失敗させる
				return new Response(JSON.stringify(mockBitbankError(20001)), { status: 400 });
			}
			if (urlStr.includes('/v1/user/assets')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawAssetsResponse)), { status: 200 });
			}
			if (urlStr.includes('trade_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawTradeHistoryResponse)), { status: 200 });
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
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		expect(result.data.monthly_equity_series).toBeDefined();
		expect(result.data.monthly_equity_series?.length).toBeGreaterThan(0);
		expect(result.meta.equitySeriesQuality).toBe('fallback_only');
		// 全保有暗号資産が fallback の対象（btc/eth/xrp、jpy は対象外）
		expect(result.meta.equitySeriesFallbackAssets).toEqual(expect.arrayContaining(['btc', 'eth', 'xrp']));
		expect(result.summary).toContain('現在価格で全期間を代替');
	});

	/** 正常系: 全ペアで candle 取得済 → quality=complete */
	it('全暗号資産で candle 取得済のとき quality=complete', async () => {
		// 静的フィクスチャ candlesBtcJpy1day120 は 2024 年データなので、年初判定のための
		// 「年初以降の daily candle が存在するか」を満たすために動的に最近の candle を生成する。
		// baseTs = 今日から (count - 1) 日前 → 今日まで連続する 1day 足
		// count は年初（1/1）〜今日を常にカバーする 400 日（うるう年でも 366 日 < 400）。
		// 180 日だと年初から 181 日目（6/30）以降の実行で 1/1 に届かず fallback 判定になる。
		const TODAY_MS = Date.now();
		const ONE_DAY_MS = 86_400_000;
		const recentCandle = (count: number) => ({
			success: 1,
			data: {
				candlestick: [
					{
						type: '1day',
						ohlcv: generateOhlcv(count, ONE_DAY_MS, 15_000_000, TODAY_MS - (count - 1) * ONE_DAY_MS),
					},
				],
			},
		});

		globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			const _maybeMargin = maybeMarginAccountResponse(urlStr);
			if (_maybeMargin) return _maybeMargin;
			if (urlStr.includes('tickers_jpy')) {
				return new Response(JSON.stringify(tickersJpy), { status: 200 });
			}
			if (urlStr.includes('candlestick')) {
				return new Response(JSON.stringify(recentCandle(400)), { status: 200 });
			}
			if (urlStr.includes('/v1/user/assets')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawAssetsResponse)), { status: 200 });
			}
			if (urlStr.includes('trade_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawTradeHistoryResponse)), { status: 200 });
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
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		expect(result.data.monthly_equity_series).toBeDefined();
		expect(result.data.yearly_equity_series).toBeDefined();
		expect(result.meta.equitySeriesQuality).toBe('complete');
		expect(result.meta.equitySeriesFallbackAssets).toBeUndefined();
	});

	/** 一部だけ candle 成功 → 残りは fallback (quality=partial_fallback) */
	it('一部の暗号資産でだけ candle 取得済のとき quality=partial_fallback', async () => {
		// btc は最近の candle データを返し、eth / xrp は error を返す混在モック。
		// equity series 構築側の lookup 日付（monthDates + yearDates）すべてが btc に揃うよう、
		// 年初〜今日までを連続で生成する。
		const TODAY_MS = Date.now();
		const ONE_DAY_MS = 86_400_000;
		// 年初から今日までを十分カバーする日数（例: 400 日）。
		const recentBtcCandle = {
			success: 1,
			data: {
				candlestick: [
					{
						type: '1day',
						ohlcv: generateOhlcv(400, ONE_DAY_MS, 15_000_000, TODAY_MS - 399 * ONE_DAY_MS),
					},
				],
			},
		};

		globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			const _maybeMargin = maybeMarginAccountResponse(urlStr);
			if (_maybeMargin) return _maybeMargin;
			if (urlStr.includes('tickers_jpy')) {
				return new Response(JSON.stringify(tickersJpy), { status: 200 });
			}
			if (urlStr.includes('candlestick')) {
				// URL pattern: https://public.bitbank.cc/{pair}/candlestick/1day/{date}
				// btc_jpy のみ成功、それ以外は upstream error
				if (urlStr.includes('btc_jpy')) {
					return new Response(JSON.stringify(recentBtcCandle), { status: 200 });
				}
				return new Response(JSON.stringify(mockBitbankError(20001)), { status: 400 });
			}
			if (urlStr.includes('/v1/user/assets')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawAssetsResponse)), { status: 200 });
			}
			if (urlStr.includes('trade_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawTradeHistoryResponse)), { status: 200 });
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
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		expect(result.data.monthly_equity_series).toBeDefined();
		expect(result.data.monthly_equity_series?.length).toBeGreaterThan(0);
		expect(result.meta.equitySeriesQuality).toBe('partial_fallback');
		// btc は揃っているので fallback 対象外、eth / xrp は対象
		expect(result.meta.equitySeriesFallbackAssets).toEqual(expect.arrayContaining(['eth', 'xrp']));
		expect(result.meta.equitySeriesFallbackAssets).not.toContain('btc');
		expect(result.summary).toContain('歴史的価格データが取得できなかったため、現在価格で代替');
	});

	/** include_pnl=false のとき equitySeriesQuality は undefined */
	it('include_pnl=false のとき equity series は構築されず quality は undefined', async () => {
		setupFetchMock();
		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: false,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expect(result.data.monthly_equity_series).toBeUndefined();
		expect(result.data.yearly_equity_series).toBeUndefined();
		expect(result.meta.equitySeriesQuality).toBeUndefined();
	});
});

/**
 * 純入出金（calcPeriodNetFlow）で価格を解決できなかった暗号資産の申告。
 *
 * 価格が引けない入出庫は net_flow_jpy から黙って落ちる（= 0 円計上と等価）ため、
 * adjusted_change_jpy も同じ向きにずれる。読み手が欠落に気づけるよう、計算層 warning
 * （`.claude/rules/tools.md` の meta.warnings 系統）として資産名だけを申告する。
 */
describe('analyze_my_portfolio — 純入出金の価格解決 warning', () => {
	/** 2026-05-16 12:00 JST。当日・当月・当年のいずれの期間にも入る入出庫を作れる基準時刻 */
	const fixedNowMs = Date.UTC(2026, 4, 16, 3, 0, 0, 0);
	/** 2026-05-16 10:00 JST（当日 0:00 JST 以降なので daily / monthly / yearly すべてに入る） */
	const inPeriodMs = Date.UTC(2026, 4, 16, 1, 0, 0, 0);

	/** ticker に存在しない資産（doge / mona）の入出庫。tickers_jpy fixture は btc / eth / xrp のみ */
	const unpricedDeposits = {
		deposits: [
			{
				uuid: 'dep-doge',
				asset: 'doge',
				amount: '1000',
				status: 'DONE',
				found_at: inPeriodMs,
				confirmed_at: inPeriodMs,
			},
		],
	};
	const unpricedWithdrawals = {
		withdrawals: [
			{ uuid: 'wd-mona', asset: 'mona', amount: '10', fee: '0.1', status: 'DONE', requested_at: inPeriodMs },
		],
	};

	afterEach(() => {
		vi.useRealTimers();
	});

	it('価格を引けない入出庫がある: 資産名が meta.warnings と summary 先頭に出る', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);
		setupFetchMock({ deposits: unpricedDeposits, withdrawals: unpricedWithdrawals });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		// 計算層 warning（meta.warnings）に資産名が載る。金額は含めない
		expect(result.meta.warnings).toHaveLength(1);
		const warning = result.meta.warnings?.[0] ?? '';
		expect(warning).toContain('DOGE');
		expect(warning).toContain('MONA');
		expect(warning).not.toContain('1000');
		expect(warning).not.toContain('10');

		// data 側にも資産名が残る（3 期間とも同じ入出庫が対象）
		expect(result.data.daily_performance?.unpriced_flow_assets).toEqual(['doge', 'mona']);
		expect(result.data.monthly_performance?.unpriced_flow_assets).toEqual(['doge', 'mona']);
		expect(result.data.yearly_performance?.unpriced_flow_assets).toEqual(['doge', 'mona']);

		// LLM が見落とさないよう summary 先頭付近に出す
		const firstLines = result.summary.split('\n').slice(0, 3).join('\n');
		expect(firstLines).toContain('⚠️');
		expect(firstLines).toContain('DOGE, MONA');
	});

	it('価格を全て引ける場合: warning は出ず unpriced_flow_assets も付かない', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);
		// btc は tickers_jpy fixture に存在するので価格を解決できる
		setupFetchMock({
			deposits: {
				deposits: [
					{
						uuid: 'dep-btc',
						asset: 'btc',
						amount: '0.1',
						status: 'DONE',
						found_at: inPeriodMs,
						confirmed_at: inPeriodMs,
					},
				],
			},
			withdrawals: { withdrawals: [] },
		});

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		expect(result.meta.warnings).toBeUndefined();
		expect(result.data.daily_performance?.unpriced_flow_assets).toBeUndefined();
		expect(result.data.yearly_performance?.unpriced_flow_assets).toBeUndefined();
		expect(result.summary).not.toContain('純入出金に計上できませんでした');
		// 入庫は価格が引けているので net_flow に載る（0.1 BTC * 15_500_000 = 1_550_000）
		expect(result.data.daily_performance?.net_flow_jpy).toBe(1_550_000);
	});

	/**
	 * このツールに `view` / `format` は無く、出力の切り替え軸は 3 つの include_* だけ。
	 * warning が消える組み合わせでは、warning の対象になる値（performance / 純入出金）
	 * 自体が出力されない — 過小な数値だけが warning なしで残る経路が無いことを固定する。
	 */
	it('include_pnl=false / include_deposit_withdrawal=false: 過小な純入出金が warning なしで出ることはない', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);
		setupFetchMock({ deposits: unpricedDeposits, withdrawals: unpricedWithdrawals });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');

		/** 価格解決の warning は資産名を含む。取得原価が確定できない旨の warning とは別系統。 */
		const hasUnpricedWarning = (warnings: string[] | undefined) =>
			(warnings ?? []).some((w) => w.includes('DOGE') || w.includes('MONA'));

		// include_pnl=false: performance を構築しないので純入出金自体が出力されない
		const noPnl = await handler({
			include_technical: false,
			include_pnl: false,
			include_deposit_withdrawal: true,
		});
		assertOk(noPnl);
		expect(hasUnpricedWarning(noPnl.meta.warnings)).toBe(false);
		expect(noPnl.data.daily_performance).toBeUndefined();
		expect(noPnl.data.yearly_performance).toBeUndefined();
		expect(noPnl.data.monthly_performance).toBeUndefined();

		// include_deposit_withdrawal=false: 表示セクションは閉じるが、損益計算のために
		// 入出金は読む。純入出金は実測され、価格を引けない入出庫はその実測値から落ちるので
		// warning も従来どおり出る（黙って過小になる経路を作らない）。
		const noDw = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: false,
		});
		assertOk(noDw);
		expect(hasUnpricedWarning(noDw.meta.warnings)).toBe(true);
		expect(noDw.data.daily_performance?.flow_measured).toBe(true);
		expect(noDw.data.daily_performance?.unpriced_flow_assets).toEqual(['doge', 'mona']);
	});

	it('toolDef: content[0].text の warning 行が JSON より前に出る', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);
		setupFetchMock({ deposits: unpricedDeposits, withdrawals: unpricedWithdrawals });

		const { toolDef } = await import('../../tools/private/analyze_my_portfolio.js');
		const result = await toolDef.handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		const text = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
		const warningIndex = text.indexOf('DOGE, MONA');
		const jsonIndex = text.indexOf('\n{');
		expect(warningIndex).toBeGreaterThanOrEqual(0);
		expect(jsonIndex).toBeGreaterThan(0);
		expect(warningIndex).toBeLessThan(jsonIndex);
		// 先頭付近（1〜3 行目）に出ること
		expect(text.split('\n').slice(0, 3).join('\n')).toContain('⚠️');
		// data の JSON にも資産名が残る（structuredContent を見ないクライアント向け）
		expect(text).toContain('unpriced_flow_assets');
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
		// include_pnl=true のとき equity series は常に content の JSON に含まれる
		expect(Array.isArray(structured.data.monthly_equity_series)).toBe(true);
		expect(Array.isArray(structured.data.yearly_equity_series)).toBe(true);
		expect((structured.data.monthly_equity_series as unknown[]).length).toBeGreaterThan(0);
		expect((structured.data.yearly_equity_series as unknown[]).length).toBeGreaterThan(0);
		expect(text).toContain('monthly_equity_series');
		expect(text).toContain('yearly_equity_series');
	});

	/**
	 * 資産推移の日次点・月次点の終端は、リクエスト開始時に確定した boundaries から導く。
	 *
	 * boundaries は fetchCandlePriceData に渡す取得条件そのものなので、ここで時計を
	 * 読み直すと、API 応答を待っている間に JST 00:00 を跨いだ場合に「取得済みの日次価格に
	 * 存在しない翌日」が 1 点増え、その点だけ現在価格フォールバックに落ちる。
	 */
	it('リクエスト中に JST 00:00 を跨いでも日次点は取得時の暦日で止まる', async () => {
		/** JST の壁時計時刻を epoch ms に変換する（JST は DST を持たないので UTC+9 固定）。 */
		const jstMs = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0) =>
			Date.UTC(y, m - 1, d, h - 9, min, s, ms);
		const beforeMidnight = jstMs(2026, 8, 2, 23, 59, 59, 900);

		vi.useFakeTimers();
		vi.setSystemTime(beforeMidnight);
		try {
			setupFetchMock();
			// candlestick は boundaries 確定後に発行される（handler の fetchCandlePriceData）。
			// その応答を待っている間に JST 00:00 を跨がせる。
			const routed = globalThis.fetch;
			let crossed = false;
			globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
				if (!crossed && urlStr.includes('candlestick')) {
					crossed = true;
					vi.setSystemTime(jstMs(2026, 8, 3, 0, 0, 0, 100));
				}
				return routed(url as string);
			}) as unknown as typeof fetch;

			const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
			const result = await handler({
				include_technical: false,
				include_pnl: true,
				include_deposit_withdrawal: false,
			});

			assertOk(result);
			expect(crossed).toBe(true);

			// 日次点は月初 (8/1) 〜 取得時の当日 (8/2) の 2 点 + 最終点（現在値）。
			// 時計を読み直していると 8/3 が増えて 4 点になる。
			const monthly = result.data.monthly_equity_series ?? [];
			expect(monthly.map((p) => p.timestamp)).toEqual([
				'2026-08-01T00:00:00+09:00',
				'2026-08-02T00:00:00+09:00',
				result.data.monthly_equity_series?.[monthly.length - 1]?.timestamp,
			]);
			// 月次点も同様に取得時の当月 (8月) で止まる。
			const yearly = result.data.yearly_equity_series ?? [];
			expect(yearly.at(-2)?.timestamp).toBe('2026-08-01T00:00:00+09:00');
		} finally {
			vi.useRealTimers();
		}
	});
});

/**
 * API が返す asset コードの取得境界正規化（`lib/asset-code.ts`）のハンドラレベル検証。
 *
 * `/v1/user/assets` と入出金履歴の asset は取得境界で小文字へ揃える。揃えないと
 * `reconstructHoldingsAtDate` の holdings キーが `BTC` / `btc` に割れ、期初評価額・
 * 純入出金・warning が同時に壊れる（`docs/internal/bitbank-api-fields.md` 参照）。
 *
 * 現行 API は小文字を返すため、これは防御的正規化。小文字レスポンスでの出力不変も併せて固定する。
 */
describe('analyze_my_portfolio — API asset の取得境界正規化', () => {
	/** 2026-05-16 12:00 JST。当日・当月・当年のいずれの期間にも入る入出庫を作れる基準時刻 */
	const fixedNowMs = Date.UTC(2026, 4, 16, 3, 0, 0, 0);
	/** 2026-05-16 10:00 JST（当日 0:00 JST 以降なので daily / monthly / yearly すべてに入る） */
	const inPeriodMs = Date.UTC(2026, 4, 16, 1, 0, 0, 0);

	/** btc は tickers_jpy fixture に存在するので価格を解決できる（warning の誤検知を切り分けるため） */
	function assetsResponse(btc: string, jpy: string) {
		return {
			assets: [
				{
					asset: btc,
					free_amount: '0.6',
					amount_precision: 8,
					onhand_amount: '0.6',
					locked_amount: '0',
					withdrawing_amount: '0',
					withdrawal_fee: { min: '0.0006', max: '0.0006' },
					stop_deposit: false,
					stop_withdrawal: false,
					collateral_ratio: '0.95',
				},
				{
					asset: jpy,
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
			],
		};
	}

	/** 期間内の入出庫。出庫は保有復元で巻き戻されるので holdings キーの分裂が観測できる */
	function dwResponses(btc: string, jpy: string) {
		return {
			deposits: {
				deposits: [
					{
						uuid: 'dep-btc',
						asset: btc,
						amount: '0.1',
						status: 'DONE',
						found_at: inPeriodMs,
						confirmed_at: inPeriodMs,
					},
					{
						uuid: 'dep-jpy',
						asset: jpy,
						amount: '300000',
						status: 'DONE',
						found_at: inPeriodMs,
						confirmed_at: inPeriodMs,
					},
				],
			},
			withdrawals: {
				withdrawals: [
					{ uuid: 'wd-btc', asset: btc, amount: '0.2', fee: '0.0006', status: 'DONE', requested_at: inPeriodMs },
				],
			},
		};
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it('大文字混在のレスポンスでも保有が二重計上されず asset は小文字で返る', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);
		const dw = dwResponses('BTC', 'JPY');
		setupFetchMock({ assets: assetsResponse('BTC', 'JPY'), deposits: dw.deposits, withdrawals: dw.withdrawals });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		// holdings キーが BTC / btc に割れず、1 資産 1 エントリ（structuredContent は小文字契約）
		const assets = result.data.holdings.map((h) => h.asset);
		expect(assets).toEqual([...new Set(assets)]);
		expect(assets.sort()).toEqual(['btc', 'jpy']);
		// 保有 0.6 BTC が価格に突き合わさる（大文字のままだと prices.get('BTC') が外れて欠落する）
		expect(result.data.holdings.find((h) => h.asset === 'btc')?.jpy_value).toBe(0.6 * 15_500_000);
		expect(result.data.total_jpy_value).toBe(0.6 * 15_500_000 + 500_000);
		// JPY 入金が fiat として純入出金に載り、BTC 入出庫も価格解決できるので warning は出ない
		expect(result.meta.warnings).toBeUndefined();
		expect(result.data.daily_performance?.unpriced_flow_assets).toBeUndefined();
		expect(result.data.daily_performance?.net_flow_jpy).toBe(Math.round(300_000 + 0.1 * 15_500_000 - 0.2 * 15_500_000));
	});

	it('大文字レスポンスと小文字レスポンスで data / summary が完全一致する', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);

		// getDefaultClient は fetch を構築時に束縛するため、同一 mock 内でレスポンスを切り替える
		// （setupFetchMock を 2 回呼ぶと 2 回目の差し替えがクライアントに届かない）。
		let uppercase = true;
		globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			const margin = maybeMarginAccountResponse(urlStr);
			if (margin) return margin;

			const [btc, jpy] = uppercase ? ['BTC', 'JPY'] : ['btc', 'jpy'];
			const dw = dwResponses(btc, jpy);

			if (urlStr.includes('tickers_jpy')) {
				return new Response(JSON.stringify(tickersJpy), { status: 200 });
			}
			if (urlStr.includes('candlestick')) {
				return new Response(JSON.stringify(candlesBtcJpy1day120), { status: 200 });
			}
			if (urlStr.includes('/v1/user/assets')) {
				return new Response(JSON.stringify(mockBitbankSuccess(assetsResponse(btc, jpy))), { status: 200 });
			}
			if (urlStr.includes('trade_history')) {
				const payload = urlStr.includes('type=margin') ? { trades: [] } : rawTradeHistoryResponse;
				return new Response(JSON.stringify(mockBitbankSuccess(payload)), { status: 200 });
			}
			if (urlStr.includes('deposit_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess(dw.deposits)), { status: 200 });
			}
			if (urlStr.includes('withdrawal_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess(dw.withdrawals)), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess({})), { status: 200 });
		}) as unknown as typeof fetch;

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const args = { include_technical: false, include_pnl: true, include_deposit_withdrawal: true };

		const upperResult = await handler(args);
		uppercase = false;
		const lowerResult = await handler(args);

		assertOk(upperResult);
		assertOk(lowerResult);
		expect(upperResult.data).toEqual(lowerResult.data);
		expect(upperResult.summary).toBe(lowerResult.summary);
	});
});

/**
 * API が返す pair シンボルの取得境界正規化（`lib/pair-code.ts`）のハンドラレベル検証。
 *
 * 約定履歴の `pair` と `tickers_jpy` の `pair` は取得境界で小文字へ揃える。揃えないと
 * `'BTC_JPY'.replace('_jpy', '')` が**何も置換しない**ため、pair 由来の asset が
 * `lib/asset-code.ts` で正規化した小文字 asset と割れ、
 *   - `prices` のキーが `BTC_JPY` になって評価額が算出できない
 *   - `calcPnl` の `t.pair === 'btc_jpy'` が 0 件マッチで平均取得単価・実現損益が消える
 *   - PR #37 の `unpriced_flow_assets` warning が全銘柄に対して誤検知する
 * が同時に起きる（`docs/internal/bitbank-api-fields.md` 参照）。
 *
 * 現行 API は小文字を返すため、これは防御的正規化。小文字レスポンスでの出力不変も併せて固定する。
 */
describe('analyze_my_portfolio — API pair の取得境界正規化', () => {
	/** 2026-05-16 12:00 JST */
	const fixedNowMs = Date.UTC(2026, 4, 16, 3, 0, 0, 0);
	/** 年初より前の買い（期初保有の復元・期間実現損益に影響しない位置） */
	const buyMs = Date.UTC(2025, 5, 1, 0, 0, 0, 0);
	/** 2026-05-16 10:00 JST。当日・当月・当年のいずれの期間にも入る入庫 */
	const inPeriodMs = Date.UTC(2026, 4, 16, 1, 0, 0, 0);

	const assetsResponse = {
		assets: [
			{
				asset: 'btc',
				free_amount: '0.6',
				amount_precision: 8,
				onhand_amount: '0.6',
				locked_amount: '0',
				withdrawing_amount: '0',
				withdrawal_fee: { min: '0.0006', max: '0.0006' },
				stop_deposit: false,
				stop_withdrawal: false,
				collateral_ratio: '0.95',
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
		],
	};

	function tradesResponse(pair: string) {
		return {
			trades: [
				{
					trade_id: 1,
					pair,
					order_id: 1,
					side: 'buy',
					type: 'limit',
					amount: '0.6',
					price: '10000000',
					maker_taker: 'maker',
					fee_amount_base: '0',
					fee_amount_quote: '0',
					fee_occurred_amount_quote: '0',
					executed_at: buyMs,
				},
			],
		};
	}

	/** 期間内の BTC 入庫。価格を解決できないと unpriced_flow_assets に載る */
	const depositsResponse = {
		deposits: [
			{ uuid: 'dep-btc', asset: 'btc', amount: '0.1', status: 'DONE', found_at: inPeriodMs, confirmed_at: inPeriodMs },
		],
	};

	/** tickers_jpy の pair だけ大文字にした版 */
	function tickersWithPairCase(uppercase: boolean) {
		return {
			...tickersJpy,
			data: tickersJpy.data.map((t) => ({ ...t, pair: uppercase ? t.pair.toUpperCase() : t.pair })),
		};
	}

	function mockAll(uppercase: boolean) {
		globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			const margin = maybeMarginAccountResponse(urlStr);
			if (margin) return margin;

			if (urlStr.includes('tickers_jpy')) {
				return new Response(JSON.stringify(tickersWithPairCase(uppercase)), { status: 200 });
			}
			if (urlStr.includes('candlestick')) {
				return new Response(JSON.stringify(candlesBtcJpy1day120), { status: 200 });
			}
			if (urlStr.includes('/v1/user/assets')) {
				return new Response(JSON.stringify(mockBitbankSuccess(assetsResponse)), { status: 200 });
			}
			if (urlStr.includes('trade_history')) {
				const payload = urlStr.includes('type=margin')
					? { trades: [] }
					: tradesResponse(uppercase ? 'BTC_JPY' : 'btc_jpy');
				return new Response(JSON.stringify(mockBitbankSuccess(payload)), { status: 200 });
			}
			if (urlStr.includes('deposit_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess(depositsResponse)), { status: 200 });
			}
			if (urlStr.includes('withdrawal_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess({})), { status: 200 });
		}) as unknown as typeof fetch;
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it('大文字 pair のレスポンスでも評価額・取得原価・warning が壊れない', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);
		mockAll(true);

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		const btc = result.data.holdings.find((h) => h.asset === 'btc');
		// prices のキーが BTC_JPY だと評価額が undefined になる
		expect(btc?.jpy_value).toBe(0.6 * 15_500_000);
		// calcPnl の `t.pair === 'btc_jpy'` が 0 件マッチだと以下が全て消える
		expect(btc?.trade_count).toBe(1);
		expect(btc?.avg_buy_price).toBe(10_000_000);
		expect(btc?.cost_basis).toBe(6_000_000);
		expect(btc?.pair).toBe('btc_jpy');
		// pair 由来の asset が `lib/asset-code.ts` の小文字 asset と割れていない
		expect(result.data.holdings.map((h) => h.asset).sort()).toEqual(['btc', 'jpy']);
		// PR #37 の warning 経路。BTC の価格は引けているので誤検知してはいけない
		expect(result.data.daily_performance?.unpriced_flow_assets).toBeUndefined();
		expect(result.meta.warnings).toBeUndefined();
		expect(result.data.daily_performance?.net_flow_jpy).toBe(Math.round(0.1 * 15_500_000));
	});

	it('大文字レスポンスと小文字レスポンスで data / summary が完全一致する', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const args = { include_technical: false, include_pnl: true, include_deposit_withdrawal: true };

		mockAll(true);
		const upperResult = await handler(args);
		mockAll(false);
		const lowerResult = await handler(args);

		assertOk(upperResult);
		assertOk(lowerResult);
		expect(upperResult.data).toEqual(lowerResult.data);
		expect(upperResult.summary).toBe(lowerResult.summary);
	});
});
