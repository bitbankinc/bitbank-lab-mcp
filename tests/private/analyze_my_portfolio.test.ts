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
	mockSpotPairSpec,
	mockSpotPairsResponse,
	rawAssetsResponse,
	rawDepositHistoryResponse,
	rawMarginPositionsResponse,
	rawMarginStatusResponse,
	rawMarginTradeHistoryResponse,
	rawTradeHistoryResponse,
	rawWithdrawalHistoryResponse,
} from '../fixtures/private-api.js';

/** rawAssetsResponse から指定 asset のエントリを取り出す（整合 fixture の組み立て用） */
function assetFixture(asset: string) {
	const found = rawAssetsResponse.assets.find((a) => a.asset === asset);
	if (!found) throw new Error(`fixture asset not found: ${asset}`);
	return found;
}

/**
 * 既定の約定・出庫履歴から calcPnl が復元する数量と onhand を整合させた assets レスポンス。
 * btc: 買 0.01（fee 0.00001 BTC）→ 売 0.005 → 0.00499、eth: 買 1.0（fee 0.001 ETH）→ 0.999
 * （既定 fixture の eth 出庫は約定より前で保有 0 のため数量に影響しない）。
 *
 * rawAssetsResponse は onhand が履歴と乖離しており、数量不変条件（cost_basis_reliable）で
 * 原価が抑止される。乖離検出そのものを検証するテスト以外では本フィクスチャを既定にする。
 * xrp は約定履歴が無く、正の残高が常に復元数量 0 と乖離するため含めない。
 */
const consistentAssetsResponse = {
	assets: [
		{ ...assetFixture('btc'), free_amount: '0.00499', onhand_amount: '0.00499', locked_amount: '0' },
		{ ...assetFixture('eth'), free_amount: '0.999', onhand_amount: '0.999' },
		assetFixture('jpy'),
		assetFixture('doge'),
	],
};

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

/**
 * 本テストの assets / tickers フィクスチャに出てくるペアを網羅した /spot/pairs レスポンス。
 * price_digits は bitbank の実値に寄せる（btc/eth は整数刻み、xrp/doge/xlm は小数刻み）。
 * 価格フィールドの丸めはこの桁数を単一ソースにするため、低価格ペアを含めておく。
 */
const defaultSpotPairsResponse = mockSpotPairsResponse([
	mockSpotPairSpec({ name: 'xrp_jpy', base_asset: 'xrp', quote_asset: 'jpy', price_digits: 3, amount_digits: 6 }),
	mockSpotPairSpec({ name: 'doge_jpy', base_asset: 'doge', quote_asset: 'jpy', price_digits: 4, amount_digits: 8 }),
	mockSpotPairSpec({ name: 'xlm_jpy', base_asset: 'xlm', quote_asset: 'jpy', price_digits: 4, amount_digits: 4 }),
]);

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
	trades?: unknown;
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
	/** tickers_jpy のレスポンス差し替え（現在価格を振って評価額の相場連動を見るテスト用） */
	tickers?: unknown;
	/** candlestick のレスポンス差し替え。既定は 2024-03-08 起点の 120 本 */
	candles?: unknown;
	/** /spot/pairs のレスポンス差し替え（価格の丸め桁 price_digits を振るテスト用） */
	pairs?: unknown;
	/** /spot/pairs を失敗させる（丸め桁が解決できない経路の検証用） */
	pairsFail?: boolean;
}) {
	globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
		const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;

		// Public API: /spot/pairs（価格フィールドの丸め桁 price_digits の供給元）
		if (urlStr.includes('/spot/pairs')) {
			if (opts?.pairsFail) {
				return new Response(JSON.stringify(mockBitbankError(10000)), { status: 500 });
			}
			return new Response(JSON.stringify(opts?.pairs ?? defaultSpotPairsResponse), { status: 200 });
		}

		// Public API: tickers
		if (urlStr.includes('tickers_jpy')) {
			return new Response(JSON.stringify(opts?.tickers ?? tickersJpy), { status: 200 });
		}

		// Public API: candlestick
		if (urlStr.includes('candlestick')) {
			return new Response(JSON.stringify(opts?.candles ?? candlesBtcJpy1day120), { status: 200 });
		}

		// Private API: assets（既定は履歴と数量整合した consistentAssetsResponse）
		if (urlStr.includes('/v1/user/assets')) {
			if (opts?.assetsFail) {
				return new Response(JSON.stringify(mockBitbankError(20001)), { status: 400 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess(opts?.assets ?? consistentAssetsResponse)), {
				status: 200,
			});
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
			return new Response(JSON.stringify(mockBitbankSuccess(opts?.trades ?? rawTradeHistoryResponse)), {
				status: 200,
			});
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
			// onhand を復元数量（買 1 - 売 0.5 = 0.5 BTC）と整合させ、数量不変条件に掛けない
			const consistentAssets = {
				assets: [
					{ ...assetFixture('btc'), free_amount: '0.5', onhand_amount: '0.5', locked_amount: '0' },
					assetFixture('jpy'),
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
					return new Response(JSON.stringify(mockBitbankSuccess(consistentAssets)), { status: 200 });
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
			expect(h.cost_basis_reliable).toBe(false);
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

	/** 出庫按分後の残数量（0.00499 - 0.0026 = 0.00239 BTC）と onhand を整合させた assets */
	const assetsAfterWithdrawal = {
		assets: [
			{ ...assetFixture('btc'), free_amount: '0.00239', onhand_amount: '0.00239', locked_amount: '0' },
			{ ...assetFixture('eth'), free_amount: '0.999', onhand_amount: '0.999' },
			assetFixture('jpy'),
		],
	};

	/** モックに記録された fetch 呼び出しの URL 一覧 */
	function fetchedUrls(): string[] {
		const mock = globalThis.fetch as unknown as { mock: { calls: Array<[string | URL | Request]> } };
		return mock.mock.calls.map(([u]) => (typeof u === 'string' ? u : u instanceof URL ? u.href : u.url));
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it('include_deposit_withdrawal=false + include_pnl=true: 出庫が calcPnl に渡り cost_basis が按分済みになる', async () => {
		setupFetchMock({ assets: assetsAfterWithdrawal, withdrawals: btcWithdrawalAfterTrades });

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

		setupFetchMock({ assets: assetsAfterWithdrawal, withdrawals: btcWithdrawalAfterTrades });
		const withSection = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});
		setupFetchMock({ assets: assetsAfterWithdrawal, withdrawals: btcWithdrawalAfterTrades });
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
		setupFetchMock({ assets: assetsAfterWithdrawal, withdrawals: btcWithdrawalAfterTrades });

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
		expect(result.data.daily_performance?.unpriced_flow_assets).toBeUndefined();
		expect(result.data.yearly_performance?.unpriced_flow_assets).toBeUndefined();
		expect(result.summary).not.toContain('純入出金に計上できませんでした');
		// candle fixture は 2024 年分しか無く 2026 年の入庫日価格を解決できないため、
		// 現在価格フォールバックの申告だけが残る（#57 (a) の 3 経路目。unpriced とは別系統）。
		expect(result.meta.warnings).toHaveLength(1);
		expect(result.meta.warnings?.[0]).toContain('現在価格で仮評価');
		// 入庫は現在価格で引けているので net_flow に載る（0.1 BTC * 15_500_000 = 1_550_000）
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

/**
 * 暗号資産入出庫の JPY 換算を入出庫日の 1day open で固定する（#57 (a)）。
 *
 * 本 issue の眼目は「相場が動いても入出庫の評価額が動かないこと」なので、
 * **現在価格（tickers）だけを差し替えた 2 回の実行で同じ値が返ること**を軸に据える。
 * 経路は 3 つ: 直近 400 日窓の日次価格で解ける / 400 日超で年 chunk を追加取得して解ける /
 * どちらでも解けず現在価格にフォールバックする。
 */
describe('analyze_my_portfolio — 入出庫日価格での評価', () => {
	/** 2026-05-16 12:00 JST */
	const fixedNowMs = Date.UTC(2026, 4, 16, 3, 0, 0, 0);
	/** 2026-05-16 10:00 JST（当日・当月・当年のいずれの期間にも入る） */
	const recentFlowMs = Date.UTC(2026, 4, 16, 1, 0, 0, 0);
	/** 2023-04-20 12:00 JST（直近 400 日窓の外。年 chunk の追加取得が要る） */
	const oldFlowMs = Date.UTC(2023, 3, 20, 3, 0, 0, 0);

	/** 入庫日の 1day open。現在価格（15,500,000 / 31,000,000）とは意図的に離す */
	const FLOW_DAY_OPEN = 8_000_000;

	/**
	 * 指定した UTC 時刻の 1day 足だけを返す candlestick レスポンス。
	 * `portfolioDayStartMs` は JST 暦日に丸めるため、UTC 0:00 の足は同じ日付の JST 暦日キーになる。
	 */
	function candles1day(rows: Array<{ tsMs: number; open: number }>) {
		return {
			success: 1,
			data: {
				candlestick: [
					{
						type: '1day',
						ohlcv: rows.map(({ tsMs, open }) => [
							String(open),
							String(open + 100_000),
							String(open - 100_000),
							String(open + 50_000),
							'10',
							tsMs,
						]),
					},
				],
			},
		};
	}

	/** btc の現在価格だけを差し替えた tickers_jpy レスポンス */
	function tickersWithBtc(last: number) {
		return {
			success: 1,
			data: [
				{
					pair: 'btc_jpy',
					sell: String(last),
					buy: String(last),
					high: String(last),
					low: String(last),
					open: String(last),
					last: String(last),
					vol: '100',
					timestamp: fixedNowMs,
				},
			],
		};
	}

	/** btc を 0.1 だけ入庫した履歴（confirmed_at を引数で振る） */
	function btcDeposit(confirmedAt: number) {
		return {
			deposits: [
				{
					uuid: 'dep-btc',
					asset: 'btc',
					amount: '0.1',
					status: 'DONE',
					found_at: confirmedAt,
					confirmed_at: confirmedAt,
				},
			],
		};
	}

	/** 現在価格だけを振って 2 回実行する */
	async function runWithBtcPrice(last: number, opts: Parameters<typeof setupFetchMock>[0]) {
		setupFetchMock({ ...opts, tickers: tickersWithBtc(last) });
		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		return handler({ include_technical: false, include_pnl: true, include_deposit_withdrawal: true });
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it('直近 400 日窓の日次価格で解ける: 現在価格を 2 倍にしても入庫の評価額が動かない', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);
		const mockOpts = {
			deposits: btcDeposit(recentFlowMs),
			withdrawals: { withdrawals: [] },
			// 入庫当日（JST 2026-05-16）の足を持つ
			candles: candles1day([{ tsMs: Date.UTC(2026, 4, 16), open: FLOW_DAY_OPEN }]),
		};

		const cheap = await runWithBtcPrice(15_500_000, mockOpts);
		const rich = await runWithBtcPrice(31_000_000, mockOpts);

		assertOk(cheap);
		assertOk(rich);
		// 本 issue の眼目: 現在価格が 2 倍でも入庫の評価額は 1 円も動かない
		expect(cheap.data.daily_performance?.net_flow_jpy).toBe(rich.data.daily_performance?.net_flow_jpy);
		expect(cheap.data.deposit_withdrawal_summary?.crypto_deposit_estimated_jpy).toBe(
			rich.data.deposit_withdrawal_summary?.crypto_deposit_estimated_jpy,
		);
		// 0.1 BTC × 入庫日の始値
		expect(cheap.data.daily_performance?.net_flow_jpy).toBe(Math.round(0.1 * FLOW_DAY_OPEN));
		expect(cheap.data.deposit_withdrawal_summary?.crypto_deposit_estimated_jpy).toBe(Math.round(0.1 * FLOW_DAY_OPEN));

		// 評価方式が出力から判別できる（受け入れ条件）
		expect(cheap.meta.flowValuationBasis).toBe('deposit_date_price');
		expect(cheap.meta.flowValuationFallbackCount).toBeUndefined();
		expect(cheap.data.daily_performance?.flow_valuation).toEqual({
			deposit_date_price_count: 1,
			current_price_fallback_count: 0,
			basis: 'deposit_date_price',
		});
		expect(cheap.data.deposit_withdrawal_summary?.crypto_deposit_valuation?.basis).toBe('deposit_date_price');
		// 仮評価に落ちていないので警告も出ない
		expect((cheap.meta.warnings ?? []).some((w: string) => w.includes('現在価格で仮評価'))).toBe(false);
	});

	it('400 日超: 年 chunk を追加取得して入庫日価格で評価する', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);
		// 直近窓（date 未指定）には入庫日の足が無く、2023 年 chunk（date='2023'）にだけ在る状況を作る。
		// setupFetchMock は URL で分岐できないため、candlestick の URL から年 chunk を読み取る。
		const mockOpts = {
			deposits: btcDeposit(oldFlowMs),
			withdrawals: { withdrawals: [] },
		};
		const recentCandles = candles1day([{ tsMs: Date.UTC(2026, 4, 15), open: 20_000_000 }]);
		const oldCandles = candles1day([{ tsMs: Date.UTC(2023, 3, 20), open: FLOW_DAY_OPEN }]);

		/** candlestick の URL は `/candlestick/{pair}/{type}/{yearOrDay}` 形式 */
		const runWithYearChunks = async (last: number) => {
			setupFetchMock({ ...mockOpts, tickers: tickersWithBtc(last) });
			const routed = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
			const base = routed.getMockImplementation();
			const candleUrls: string[] = [];
			globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
				const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
				if (urlStr.includes('candlestick')) {
					candleUrls.push(urlStr);
					const body = urlStr.includes('/2023') ? oldCandles : recentCandles;
					return new Response(JSON.stringify(body), { status: 200 });
				}
				return base?.(url);
			}) as unknown as typeof fetch;
			const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
			const result = await handler({
				include_technical: false,
				include_pnl: true,
				include_deposit_withdrawal: true,
			});
			return { result, candleUrls };
		};

		const cheap = await runWithYearChunks(15_500_000);
		const rich = await runWithYearChunks(31_000_000);

		// 直近窓（当年 / 前年）だけでなく、入庫年の chunk を実際に叩いている
		expect(cheap.candleUrls.some((u) => u.includes('/2023'))).toBe(true);
		assertOk(cheap.result);
		assertOk(rich.result);
		// 全履歴を集計する入出金サマリーで、年 chunk 由来の入庫日価格が使われる
		expect(cheap.result.data.deposit_withdrawal_summary?.crypto_deposit_estimated_jpy).toBe(
			Math.round(0.1 * FLOW_DAY_OPEN),
		);
		expect(cheap.result.data.deposit_withdrawal_summary?.crypto_deposit_estimated_jpy).toBe(
			rich.result.data.deposit_withdrawal_summary?.crypto_deposit_estimated_jpy,
		);
		expect(cheap.result.meta.flowValuationBasis).toBe('deposit_date_price');
		expect(cheap.result.meta.flowValuationFallbackCount).toBeUndefined();
	});

	it('全く解決できない: 現在価格フォールバックに落ち、件数を meta / summary で申告する', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);
		const mockOpts = {
			deposits: btcDeposit(oldFlowMs),
			withdrawals: { withdrawals: [] },
			// 入庫日（2023-04-20）を含まない足しか返さない → 追加取得しても解決できない
			candles: candles1day([{ tsMs: Date.UTC(2026, 4, 15), open: 20_000_000 }]),
		};

		const cheap = await runWithBtcPrice(15_500_000, mockOpts);
		const rich = await runWithBtcPrice(31_000_000, mockOpts);

		assertOk(cheap);
		assertOk(rich);
		// フォールバックは相場連動する（だからこそ黙って混ぜず申告する）
		expect(cheap.data.deposit_withdrawal_summary?.crypto_deposit_estimated_jpy).toBe(Math.round(0.1 * 15_500_000));
		expect(rich.data.deposit_withdrawal_summary?.crypto_deposit_estimated_jpy).toBe(Math.round(0.1 * 31_000_000));

		expect(cheap.meta.flowValuationBasis).toBe('current_price_fallback');
		expect(cheap.meta.flowValuationFallbackCount).toBe(1);
		expect(cheap.data.deposit_withdrawal_summary?.crypto_deposit_valuation).toEqual({
			deposit_date_price_count: 0,
			current_price_fallback_count: 1,
			basis: 'current_price_fallback',
		});
		// 計算層 warning（content 先頭）と入出金セクションの両方で申告する
		expect((cheap.meta.warnings ?? []).some((w: string) => w.includes('1件'))).toBe(true);
		expect(cheap.summary).toContain('現在価格で仮評価');
	});

	it('JPY のみの入出金では換算方式を申告しない（換算対象が無い）', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);
		const result = await runWithBtcPrice(15_500_000, {
			deposits: {
				deposits: [
					{
						uuid: 'dep-jpy',
						asset: 'jpy',
						amount: '1000000',
						status: 'DONE',
						found_at: recentFlowMs,
						confirmed_at: recentFlowMs,
					},
				],
			},
			withdrawals: { withdrawals: [] },
		});

		assertOk(result);
		expect(result.meta.flowValuationBasis).toBeUndefined();
		expect(result.meta.flowValuationFallbackCount).toBeUndefined();
		expect(result.data.daily_performance?.flow_valuation).toBeUndefined();
		expect(result.data.daily_performance?.net_flow_jpy).toBe(1_000_000);
	});

	/**
	 * 換算結果を出力するセクションが 1 つも無い構成では、価格解決自体を走らせない。
	 *
	 * `include_deposit_withdrawal=false`（入出金セクションを閉じる）かつ入出金履歴の部分失敗で
	 * 純入出金が未計測（`buildPeriodPerformance` が `unmeasuredNetFlow` に短絡）になると、
	 * 換算値はどの出力にも現れない。それでも candle を追加取得すると、
	 * (1) 出力に出ない値のためにレイテンシを払い、(2) meta / summary が
	 * 「どこにも出ていない評価額」を申告してしまう（読み手が探しても見つからない）。
	 */
	it('換算結果を出力するセクションが無い構成では価格解決も申告も行わない', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);

		// 暗号資産出庫チャネルだけ落として部分失敗にする（allFailed=false / warnings あり
		// → flowUnavailableReason=dw_fetch_failed で純入出金が未計測になる）。
		globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			const marginResponse = maybeMarginAccountResponse(urlStr);
			if (marginResponse) return marginResponse;
			if (urlStr.includes('tickers_jpy')) {
				return new Response(JSON.stringify(tickersWithBtc(15_500_000)), { status: 200 });
			}
			if (urlStr.includes('candlestick')) {
				return new Response(JSON.stringify(candles1day([{ tsMs: Date.UTC(2026, 4, 15), open: 20_000_000 }])), {
					status: 200,
				});
			}
			if (urlStr.includes('/v1/user/assets')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawAssetsResponse)), { status: 200 });
			}
			if (urlStr.includes('trade_history')) {
				const payload = urlStr.includes('type=margin') ? { trades: [] } : rawTradeHistoryResponse;
				return new Response(JSON.stringify(mockBitbankSuccess(payload)), { status: 200 });
			}
			if (urlStr.includes('deposit_history')) {
				// 年初以降（= 純入出金の母集合に入る）の DONE 暗号資産入庫。
				// candle は当日を含まないので、解決を試みれば現在価格フォールバックに落ちる。
				return new Response(JSON.stringify(mockBitbankSuccess(btcDeposit(recentFlowMs))), { status: 200 });
			}
			if (urlStr.includes('withdrawal_history')) {
				if (!urlStr.includes('asset=jpy')) {
					return new Response(JSON.stringify(mockBitbankError(10007)), { status: 200 });
				}
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
		// 前提: 純入出金は未計測で、入出金セクションも出ていない = 換算値の出力先が無い
		expect(result.meta.flowDataUnavailableReason).toBe('dw_fetch_failed');
		expect(result.data.daily_performance?.flow_measured).toBe(false);
		expect(result.data.daily_performance?.flow_valuation).toBeUndefined();
		expect(result.data.deposit_withdrawal_summary).toBeUndefined();

		// 出力に現れない換算を申告しない
		expect(result.meta.flowValuationBasis).toBeUndefined();
		expect(result.meta.flowValuationFallbackCount).toBeUndefined();
		expect((result.meta.warnings ?? []).some((w: string) => w.includes('現在価格で仮評価'))).toBe(false);
		expect(result.summary).not.toContain('現在価格で仮評価');
	});

	/**
	 * 年初より前の暗号資産**出庫**は換算対象にしない。
	 *
	 * 出庫を金額換算する消費者は期間集計だけ（`yearly_dw_summary` / 期間ネットフロー）で、
	 * 全履歴を集計する `calcDepositWithdrawalSummary` は暗号資産出庫を
	 * `crypto_withdrawal_count` として**件数しか出さない**。したがって年初より前の出庫を
	 * 解決しても反映先が無く、candle の追加取得と `flowValuationBasis` / フォールバック件数 /
	 * 警告だけが動いてしまう（入庫と出庫で下限時刻を分けている理由）。
	 */
	it('年初より前の暗号資産出庫は追加取得も換算方式の申告も引き起こさない', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);

		const candleUrls: string[] = [];
		globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			const marginResponse = maybeMarginAccountResponse(urlStr);
			if (marginResponse) return marginResponse;
			if (urlStr.includes('tickers_jpy')) {
				return new Response(JSON.stringify(tickersWithBtc(15_500_000)), { status: 200 });
			}
			if (urlStr.includes('candlestick')) {
				candleUrls.push(urlStr);
				return new Response(JSON.stringify(candles1day([{ tsMs: Date.UTC(2026, 4, 15), open: 20_000_000 }])), {
					status: 200,
				});
			}
			if (urlStr.includes('/v1/user/assets')) {
				return new Response(JSON.stringify(mockBitbankSuccess(rawAssetsResponse)), { status: 200 });
			}
			if (urlStr.includes('trade_history')) {
				const payload = urlStr.includes('type=margin') ? { trades: [] } : rawTradeHistoryResponse;
				return new Response(JSON.stringify(mockBitbankSuccess(payload)), { status: 200 });
			}
			if (urlStr.includes('deposit_history')) {
				// 当年の暗号資産入庫は無い（JPY 入金のみ）
				return new Response(
					JSON.stringify(
						mockBitbankSuccess({
							deposits: [
								{
									uuid: 'dep-jpy',
									asset: 'jpy',
									amount: '1000000',
									status: 'DONE',
									found_at: recentFlowMs,
									confirmed_at: recentFlowMs,
								},
							],
						}),
					),
					{ status: 200 },
				);
			}
			if (urlStr.includes('withdrawal_history')) {
				// 2023 年の暗号資産出庫。全履歴を母集合にすると /2023 の chunk を取りに行ってしまう
				return new Response(
					JSON.stringify(
						mockBitbankSuccess({
							withdrawals: [
								{
									uuid: 'wd-btc-old',
									asset: 'btc',
									amount: '0.2',
									fee: '0.0006',
									status: 'DONE',
									requested_at: oldFlowMs,
								},
							],
						}),
					),
					{ status: 200 },
				);
			}
			return new Response(JSON.stringify(mockBitbankSuccess({})), { status: 200 });
		}) as unknown as typeof fetch;

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			// 全履歴を母集合にする構成（入出金分析セクションあり）でも出庫は年初来に絞る
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		// 出庫は件数だけ出る（金額換算の消費者がいない）
		expect(result.data.deposit_withdrawal_summary?.crypto_withdrawal_count).toBe(1);
		expect(result.data.deposit_withdrawal_summary?.crypto_deposit_estimated_jpy).toBeUndefined();

		// 出庫年（2023）の chunk を取りに行かない
		expect(candleUrls.some((u) => u.includes('/2023'))).toBe(false);
		// 換算した入出庫が 1 件も無いので方式の申告も出ない
		expect(result.meta.flowValuationBasis).toBeUndefined();
		expect(result.meta.flowValuationFallbackCount).toBeUndefined();
		expect((result.meta.warnings ?? []).some((w: string) => w.includes('現在価格で仮評価'))).toBe(false);
	});

	/**
	 * 新設フィールドは既存キーの後ろに出す（既存消費者の JSON を頭から崩さない）。
	 *
	 * **キー順を決めるのはハンドラの代入順ではなく Zod スキーマの宣言順**——`z.object` の
	 * parse はスキーマ順でオブジェクトを組み直すため、代入順だけ末尾にしても wire では
	 * 中間に入る。人手のレビューでは見えない差なので、実際の出力順で機械的に固定する。
	 */
	it('新設の *_valuation は既存キーの後ろに出る（既存キーの相対順も不変）', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);
		const result = await runWithBtcPrice(15_500_000, {
			deposits: btcDeposit(recentFlowMs),
			withdrawals: { withdrawals: [] },
			candles: candles1day([{ tsMs: Date.UTC(2026, 4, 16), open: FLOW_DAY_OPEN }]),
		});

		assertOk(result);

		const dwKeys = Object.keys(result.data.deposit_withdrawal_summary ?? {});
		expect(dwKeys).toEqual([
			'total_jpy_deposited',
			'total_jpy_withdrawn',
			'net_jpy_invested',
			'crypto_deposit_count',
			'crypto_deposit_estimated_jpy',
			'crypto_withdrawal_count',
			'account_return_pct',
			'account_return_jpy',
			'is_complete',
			'analysis_basis',
			'crypto_deposit_valuation',
		]);

		// performance 側も同様に、新設 2 フィールドが既存キーの後ろに並ぶ
		const perfKeys = Object.keys(result.data.daily_performance ?? {});
		expect(perfKeys.at(-1)).toBe('flow_valuation');
		expect(perfKeys.indexOf('note')).toBeLessThan(perfKeys.indexOf('flow_valuation'));

		// 期間 DW サマリーも同様
		const periodKeys = Object.keys(result.data.yearly_dw_summary ?? {});
		expect(periodKeys.indexOf('period_end')).toBeLessThan(periodKeys.indexOf('crypto_deposit_valuation'));
	});

	/**
	 * `PERFORMANCE_NOTE` と summary の注記行は LLM が評価方式を読む唯一のチャネル
	 * （`structuredContent` は見えない）。文言が現在価格ベースのまま取り残されないよう固定する。
	 */
	it('note / summary の注記が入出庫日ベースであることを明示する', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);
		const result = await runWithBtcPrice(15_500_000, {
			deposits: btcDeposit(recentFlowMs),
			withdrawals: { withdrawals: [] },
			candles: candles1day([{ tsMs: Date.UTC(2026, 4, 16), open: FLOW_DAY_OPEN }]),
		});

		assertOk(result);
		expect(result.data.daily_performance?.note).toContain('入出庫日');
		expect(result.data.daily_performance?.note).not.toContain('暗号資産の入出庫は現在価格で仮評価');
		expect(result.summary).toContain('暗号資産入出庫は入出庫日');
		expect(result.summary).not.toContain('暗号資産入出庫は現在価格で仮評価');
		expect(result.summary).toContain('暗号資産入庫の評価');
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
		// BTC 入出庫は価格解決できるので unpriced 系 warning は出ない。一方 onhand 0.6 は
		// 復元数量（出庫按分後 0）と乖離しているため、数量不変条件の warning が出る。
		// 大文字レスポンスの入庫（'BTC', DONE）が正規化されて has_crypto_deposits に一致することも兼ねて固定する。
		// 2 本目は入出庫日価格の申告: candle fixture が 2024 年分のみで 2026 年の入出庫日を
		// 解決できず現在価格フォールバックに落ちるため（#57 (a)）。
		expect(result.meta.warnings).toHaveLength(2);
		expect(result.meta.warnings?.[0]).toContain('BTC（入庫日の価格を解決できない暗号資産の入庫あり）');
		expect(result.meta.warnings?.[1]).toContain('現在価格で仮評価');
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
		// 残るのは入出庫日価格を解決できなかった申告のみ（candle fixture が 2024 年分だけのため）
		expect(result.meta.warnings).toHaveLength(1);
		expect(result.meta.warnings?.[0]).toContain('現在価格で仮評価');
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

/**
 * 数量不変条件（issue #56）: calcPnl が復元した保有数量と assets API の実残高（onhand_amount）を
 * 突き合わせ、許容誤差 max(10^-amount_precision × 5, 実残高 × 0.1%) を超える乖離があれば
 * 確定値を出さず cost_basis_reliable=false + 理由コードで申告する。
 * フィードバックの ETH 型（約 1000 倍乖離）は何の検知にも掛からず確定値として出ていた。
 */
describe('analyze_my_portfolio — 復元数量 vs 実残高の不変条件', () => {
	/** eth 買い 0.002 のみの約定。onhand 2.0 と約 1000 倍乖離する（ETH 型フィードバックの再現） */
	const tinyEthBuy = {
		trades: [
			{
				trade_id: 9001,
				pair: 'eth_jpy',
				order_id: 9001,
				side: 'buy',
				type: 'limit',
				amount: '0.002',
				price: '400000',
				maker_taker: 'maker',
				fee_amount_base: '0',
				fee_amount_quote: '0',
				executed_at: 1710000000000,
			},
		],
	};

	function ethAssets(onhand: string) {
		return {
			assets: [{ ...assetFixture('eth'), free_amount: onhand, onhand_amount: onhand }, assetFixture('jpy')],
		};
	}

	const emptyDw = { deposits: { deposits: [] }, withdrawals: { withdrawals: [] } };

	it('受け入れ: ETH 型（約 1000 倍乖離）で確定値ではなく cost_basis_reliable=false + 理由コードが出る', async () => {
		// 出庫は withdrawals に無い（入出金取得は成功・complete）ので入出金起因の抑止は掛からず、
		// 数量不変条件だけが乖離を検出する。原因の手掛かりが無いので unknown。
		setupFetchMock({ assets: ethAssets('2.0'), trades: tinyEthBuy, ...emptyDw });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		const eth = result.data.holdings.find((h: { asset: string }) => h.asset === 'eth');
		expect(eth.cost_basis_reliable).toBe(false);
		expect(eth.cost_basis_unavailable_reason).toBe('unknown');
		// 原価から派生する 4 フィールドは #54 と同じ null 化経路で抑止される
		expect(eth.cost_basis).toBeUndefined();
		expect(eth.avg_buy_price).toBeUndefined();
		expect(eth.unrealized_pnl).toBeUndefined();
		expect(eth.unrealized_pnl_pct).toBeUndefined();
		// 原価に依存しない値は残す
		expect(eth.jpy_value).toBeGreaterThan(0);
		expect(eth.realized_pnl).toBe(0);
		expect(eth.trade_count).toBe(1);
		// 唯一の暗号資産が除外されるので合計は立たない。入出金起因ではないため
		// total 側・meta 側の理由コードは立たない（銘柄単位の申告 + warning で伝える）
		expect(result.data.total_cost_basis).toBeUndefined();
		expect(result.data.total_unrealized_pnl).toBeUndefined();
		expect(result.data.total_cost_basis_unavailable_reason).toBeUndefined();
		expect(result.meta.flowDataUnavailableReason).toBeUndefined();
		// 警告は銘柄名のみで、数量・金額を含めない（完全一致で固定する）
		expect(result.meta.warnings).toEqual([
			'ETH（原因不明） は約定・出庫から復元した保有数量が実残高と一致しないため、取得原価・評価損益を算出せず合計評価損益からも除外しています',
		]);
		expect(result.summary).toContain('ETH は復元数量が実残高と乖離しているため合計評価損益に含めていません');
	});

	/**
	 * 入庫 1 件（1.998 ETH, confirmed_at = 2024-03-10 JST）の fixture。
	 * 既定 candle（generateOhlcv 起点 2024-03-08）の 3 本目 = JST 2024-03-10 の始値 15,100,000 で
	 * 解決できるので、(b) では原価に算入され復元数量が onhand 2.0 と一致する。
	 */
	const ethDeposit = {
		deposits: {
			deposits: [
				{
					uuid: 'dep-eth',
					asset: 'eth',
					amount: '1.998',
					status: 'DONE',
					found_at: 1710000100000,
					confirmed_at: 1710000100000,
				},
			],
		},
		withdrawals: { withdrawals: [] },
	};
	/** 上の入庫日（JST 2024-03-10）の 1day open。既定 fixture の 3 本目 */
	const ETH_DEPOSIT_DAY_OPEN = 15_100_000;

	it('入庫は入庫日の始値で原価に算入され、数量不変条件が成立する', async () => {
		setupFetchMock({ assets: ethAssets('2.0'), trades: tinyEthBuy, ...ethDeposit });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		const eth = result.data.holdings.find((h: { asset: string }) => h.asset === 'eth');
		// (b) の眼目: 入庫ぶんの数量が復元に入るので、乖離は解消し原価が確定値として出る
		expect(eth.cost_basis_reliable).toBe(true);
		expect(eth.cost_basis_unavailable_reason).toBeUndefined();
		// 買い 0.002 × 400,000 = 800 に、入庫 1.998 × 入庫日始値 を積む。
		// 現在価格（380,000）で評価していたらこの値にはならない = 入庫日ベースの根拠。
		expect(eth.cost_basis).toBe(Math.round(800 + 1.998 * ETH_DEPOSIT_DAY_OPEN));
		expect(eth.avg_buy_price).toBe(Math.round((800 + 1.998 * ETH_DEPOSIT_DAY_OPEN) / 2));
		expect(
			(result.meta.warnings ?? []).some((w: string) => w.includes('入庫日の価格を解決できない暗号資産の入庫あり')),
		).toBe(false);
		expect(result.meta.flowDataUnavailableReason).toBeUndefined();
		expect(result.meta.depositWithdrawalStatus).toBe('available');
	});

	it('入庫日の始値を解決できない入庫は原価に算入せず has_crypto_deposits で申告する', async () => {
		// candle が空 → 入庫日の始値が引けず、resolveFlowPrice は現在価格フォールバックしか返せない。
		// 現在価格で原価を作ると評価損益が常にゼロ付近に貼り付く（相場連動の誤差を cost_basis に
		// 持ち込む）ので算入しない。結果として数量が復元されず理由コード経路に載る。
		setupFetchMock({
			assets: ethAssets('2.0'),
			trades: tinyEthBuy,
			...ethDeposit,
			candles: { success: 1, data: { candlestick: [{ type: '1day', ohlcv: [] }] } },
		});

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		const eth = result.data.holdings.find((h: { asset: string }) => h.asset === 'eth');
		expect(eth.cost_basis_reliable).toBe(false);
		expect(eth.cost_basis_unavailable_reason).toBe('has_crypto_deposits');
		expect(eth.cost_basis).toBeUndefined();
		expect(
			result.meta.warnings?.some((w: string) => w.includes('ETH（入庫日の価格を解決できない暗号資産の入庫あり）')),
		).toBe(true);
		// DONE 入庫があるだけでは入出金起因の抑止は掛からない
		expect(result.meta.flowDataUnavailableReason).toBeUndefined();
		expect(result.meta.depositWithdrawalStatus).toBe('available');
	});

	it('乖離 + 約定履歴の打ち切り: history_truncated', async () => {
		// 同一ページ（1000 件フルページ・同一 executed_at）を返し続けると、2 ページ目で
		// cursor が進まず paginateTrades が truncated=true で終了する。
		// 復元数量は 0.002 × 1000 = 2.0（dedupe 後）で onhand 5.0 と乖離する。
		const fullPage = {
			trades: Array.from({ length: 1000 }, (_, i) => ({
				...tinyEthBuy.trades[0],
				trade_id: 10000 + i,
				order_id: 10000 + i,
			})),
		};
		setupFetchMock({ assets: ethAssets('5.0'), trades: fullPage, ...emptyDw });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		expect(result.meta.tradesTruncated).toBe(true);
		const eth = result.data.holdings.find((h: { asset: string }) => h.asset === 'eth');
		expect(eth.cost_basis_reliable).toBe(false);
		expect(eth.cost_basis_unavailable_reason).toBe('history_truncated');
		expect(result.meta.warnings?.[0]).toContain('ETH（約定履歴の打ち切り）');
	});

	it('回帰: 整合した銘柄は cost_basis_reliable=true で数値がそのまま出る', async () => {
		// 既定 fixture（consistentAssetsResponse + 既定履歴）は数量整合している
		setupFetchMock();

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		const btc = result.data.holdings.find((h: { asset: string }) => h.asset === 'btc');
		expect(btc.cost_basis_reliable).toBe(true);
		expect(btc.cost_basis_unavailable_reason).toBeUndefined();
		expect(btc.cost_basis).toBe(74_925);
		// btc_jpy は price_digits=0 だが、avg_buy_price は板の刻みに縛られない加重平均なので
		// +2 桁の余裕を持たせて丸める（整数丸めではない）。
		expect(btc.avg_buy_price).toBe(15_015_015.02);
		const eth = result.data.holdings.find((h: { asset: string }) => h.asset === 'eth');
		expect(eth.cost_basis_reliable).toBe(true);
		expect(eth.cost_basis).toBe(380_000);
		// JPY は原価計算の対象外なので省略
		const jpy = result.data.holdings.find((h: { asset: string }) => h.asset === 'jpy');
		expect(jpy.cost_basis_reliable).toBeUndefined();
		// 数量整合の warning・除外注記は出ない
		expect(result.meta.warnings).toBeUndefined();
		expect(result.summary).not.toContain('合計評価損益に含めていません');
	});

	it('include_pnl=false: 原価計算の対象外なので cost_basis_reliable は省略', async () => {
		setupFetchMock({ assets: ethAssets('2.0'), trades: tinyEthBuy });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: false,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		const eth = result.data.holdings.find((h: { asset: string }) => h.asset === 'eth');
		expect(eth.cost_basis_reliable).toBeUndefined();
		expect(eth.cost_basis_unavailable_reason).toBeUndefined();
	});

	it('境界: 許容誤差内の微小乖離は成立し数値が出る', async () => {
		// eth 買 0.002 → 復元 0.002。onhand 0.0020005 の乖離 5e-7 は
		// 許容誤差 max(5e-8, 0.0020005 × 0.1% ≈ 2.0005e-6) に収まる。
		// 許容誤差「ちょうど」の等号は qtyInvariantHolds の単体テストで固定している
		setupFetchMock({ assets: ethAssets('0.0020005'), trades: tinyEthBuy, ...emptyDw });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		const eth = result.data.holdings.find((h: { asset: string }) => h.asset === 'eth');
		expect(eth.cost_basis_reliable).toBe(true);
		expect(eth.cost_basis).toBe(800); // 0.002 * 400_000
	});

	it('境界: 許容誤差をわずかに超えると乖離扱いになる', async () => {
		// onhand 0.0021 → 乖離 1e-4 > max(5e-8, 0.0021 × 0.1% = 2.1e-6)
		setupFetchMock({ assets: ethAssets('0.0021'), trades: tinyEthBuy, ...emptyDw });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		const eth = result.data.holdings.find((h: { asset: string }) => h.asset === 'eth');
		expect(eth.cost_basis_reliable).toBe(false);
		expect(eth.cost_basis).toBeUndefined();
	});

	it('ダスト保有: 売り切り後の微小残高（最小単位数カウント以内）は乖離にしない', async () => {
		// 買 0.002 → 売 0.002 で復元数量 0。onhand 4e-8 は許容誤差 5e-8（precision 8）以内
		const buyThenSellAll = {
			trades: [
				tinyEthBuy.trades[0],
				{
					...tinyEthBuy.trades[0],
					trade_id: 9002,
					order_id: 9002,
					side: 'sell',
					executed_at: 1710000200000,
				},
			],
		};
		setupFetchMock({ assets: ethAssets('0.00000004'), trades: buyThenSellAll, ...emptyDw });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		const eth = result.data.holdings.find((h: { asset: string }) => h.asset === 'eth');
		expect(eth.cost_basis_reliable).toBe(true);
		expect(eth.cost_basis_unavailable_reason).toBeUndefined();
		// 売り切りなので原価は無いが、それは乖離ではない
		expect(eth.cost_basis).toBeUndefined();
		expect(result.meta.warnings).toBeUndefined();
	});

	it('入出金取得失敗時は #54 の理由コードが優先され、数量乖離の warning は重ねない', async () => {
		// 出庫履歴が欠けた状態の復元数量は当てにならないので、数量不変条件は判定しない
		setupFetchMock({ assets: ethAssets('2.0'), trades: tinyEthBuy, dwFail: true });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		const eth = result.data.holdings.find((h: { asset: string }) => h.asset === 'eth');
		expect(eth.cost_basis_unavailable_reason).toBe('dw_fetch_failed');
		expect(eth.cost_basis_reliable).toBe(false);
		expect(result.meta.warnings?.some((w) => w.includes('復元した保有数量'))).toBe(false);
	});

	it('乖離銘柄は合計から除外され、整合銘柄の合計だけが出る（銘柄名は summary に出る）', async () => {
		// btc は既定履歴と整合、eth は onhand 5.0 で乖離（既定 eth 買 1.0 → 復元 0.999）
		setupFetchMock({
			assets: {
				assets: [
					{ ...assetFixture('btc'), free_amount: '0.00499', onhand_amount: '0.00499', locked_amount: '0' },
					{ ...assetFixture('eth'), free_amount: '5.0', onhand_amount: '5.0' },
					assetFixture('jpy'),
				],
			},
		});

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		assertOk(result);
		const btc = result.data.holdings.find((h: { asset: string }) => h.asset === 'btc');
		const eth = result.data.holdings.find((h: { asset: string }) => h.asset === 'eth');
		expect(btc.cost_basis_reliable).toBe(true);
		expect(eth.cost_basis_reliable).toBe(false);
		// 合計は btc のみから算出される（eth の評価額・原価は入らない）
		expect(result.data.total_cost_basis).toBe(btc.cost_basis);
		expect(result.data.total_unrealized_pnl).toBe(btc.jpy_value - btc.cost_basis);
		expect(result.summary).toContain('合計評価損益（全履歴の約定ベース）');
		expect(result.summary).toContain('ETH は復元数量が実残高と乖離しているため合計評価損益に含めていません');
	});

	it('toolDef: 数量乖離の warning 行が content の JSON より前に出る', async () => {
		setupFetchMock({ assets: ethAssets('2.0'), trades: tinyEthBuy, ...emptyDw });

		const { toolDef } = await import('../../tools/private/analyze_my_portfolio.js');
		const result = await toolDef.handler({
			include_technical: false,
			include_pnl: true,
			include_deposit_withdrawal: true,
		});

		const text = (result as { content: Array<{ type: string; text: string }> }).content[0].text;
		const warningIndex = text.indexOf('ETH（原因不明）');
		const jsonIndex = text.indexOf('\n{');
		expect(warningIndex).toBeGreaterThanOrEqual(0);
		expect(jsonIndex).toBeGreaterThan(0);
		expect(warningIndex).toBeLessThan(jsonIndex);
		expect(text.split('\n')[0]).toContain('⚠️');

		const structured = (result as { structuredContent: { meta: { warnings?: string[] } } }).structuredContent;
		expect(structured.meta.warnings?.some((w) => w.includes('ETH（原因不明）'))).toBe(true);
	});
});

/**
 * 価格フィールドの丸め（issue #58）: `avg_buy_price` / `current_price` はかつて無条件に
 * `Math.round` で整数化されており、低価格ペアを壊していた（XLM: 実勢 26.686 → 27、
 * 29.59 → 30 で誤差 1.4%。建値ストップ判断で損益の符号が変わる水準）。
 * /spot/pairs の `price_digits`（最小値刻み = 10^-price_digits）を単一ソースにして丸める。
 */
describe('analyze_my_portfolio — 価格の price_digits 準拠の丸め', () => {
	/** xrp のみ保有（fixture の onhand は 1000、amount_precision は 6） */
	const xrpOnlyAssets = {
		assets: [assetFixture('xrp'), assetFixture('jpy')],
	};

	/** 復元数量 1000 が onhand と一致する xrp 買い 1 件。price を差し替えて平均取得単価を作る */
	function xrpBuy(price: string) {
		return {
			trades: [
				{
					trade_id: 5801,
					pair: 'xrp_jpy',
					order_id: 5801,
					side: 'buy',
					type: 'limit',
					amount: '1000',
					price,
					maker_taker: 'maker',
					fee_amount_base: '0',
					fee_amount_quote: '0',
					fee_occurred_amount_quote: '0',
					executed_at: 1710000000000,
				},
			],
		};
	}

	/** xrp_jpy の現在値だけ差し替えた tickers レスポンス */
	function tickersWithXrpLast(last: string) {
		return {
			success: 1,
			data: tickersJpy.data.map((t) => (t.pair === 'xrp_jpy' ? { ...t, last, sell: last, buy: last } : t)),
		};
	}

	const emptyDw = { deposits: { deposits: [] }, withdrawals: { withdrawals: [] } };

	function callHandler() {
		return import('../../src/handlers/analyzeMyPortfolioHandler.js').then(({ default: handler }) =>
			handler({ include_technical: false, include_pnl: true, include_deposit_withdrawal: true }),
		);
	}

	it('受け入れ: 低価格ペア（price_digits=3）で小数が保持される — 26.686 → 26.686 / 29.59 → 29.59', async () => {
		setupFetchMock({
			assets: xrpOnlyAssets,
			trades: xrpBuy('26.686'),
			tickers: tickersWithXrpLast('29.59'),
			...emptyDw,
		});

		const result = await callHandler();

		assertOk(result);
		const xrp = result.data.holdings.find((h: { asset: string }) => h.asset === 'xrp');
		expect(xrp.cost_basis_reliable).toBe(true);
		// 旧実装ではここが 27 / 30 になっていた（誤差 1.4%）
		expect(xrp.avg_buy_price).toBe(26.686);
		expect(xrp.current_price).toBe(29.59);
	});

	it('回帰: 高価格ペア（price_digits=0）の current_price は従来どおり整数', async () => {
		setupFetchMock({
			trades: rawTradeHistoryResponse,
			tickers: {
				success: 1,
				data: tickersJpy.data.map((t) => (t.pair === 'btc_jpy' ? { ...t, last: '15500000.4' } : t)),
			},
			...emptyDw,
		});

		const result = await callHandler();

		assertOk(result);
		const btc = result.data.holdings.find((h: { asset: string }) => h.asset === 'btc');
		expect(btc.current_price).toBe(15_500_000);
	});

	it('avg_buy_price は price_digits + 2 桁で丸める（板の刻みには縛らない）', async () => {
		// 平均取得単価 = 26686.1234567 / 1000 = 26.6861234567 → price_digits=3 + 2 で 26.68612
		setupFetchMock({
			assets: xrpOnlyAssets,
			trades: xrpBuy('26.6861234567'),
			tickers: tickersWithXrpLast('29.5912345'),
			...emptyDw,
		});

		const result = await callHandler();

		assertOk(result);
		const xrp = result.data.holdings.find((h: { asset: string }) => h.asset === 'xrp');
		expect(xrp.avg_buy_price).toBe(26.68612);
		// current_price は板の刻みちょうど（price_digits=3）
		expect(xrp.current_price).toBe(29.591);
	});

	it('/spot/pairs 取得失敗時は丸めずに生値を出す（整数丸めにフォールバックしない）', async () => {
		setupFetchMock({
			assets: xrpOnlyAssets,
			trades: xrpBuy('26.6861234567'),
			tickers: tickersWithXrpLast('29.5912345'),
			pairsFail: true,
			...emptyDw,
		});

		const result = await callHandler();

		assertOk(result);
		const xrp = result.data.holdings.find((h: { asset: string }) => h.asset === 'xrp');
		// 丸め桁が分からないので素通し。整数（27 / 30）に落ちないことが要点
		expect(xrp.current_price).toBe(29.5912345);
		expect(xrp.avg_buy_price).toBeCloseTo(26.6861234567, 9);
		expect(xrp.avg_buy_price).not.toBe(Math.round(xrp.avg_buy_price));
	});

	it('/spot/pairs に無いペアも丸めずに生値を出す', async () => {
		setupFetchMock({
			assets: xrpOnlyAssets,
			trades: xrpBuy('26.6861234567'),
			tickers: tickersWithXrpLast('29.5912345'),
			// btc_jpy / eth_jpy のみ（xrp_jpy を含まない）
			pairs: mockSpotPairsResponse(),
			...emptyDw,
		});

		const result = await callHandler();

		assertOk(result);
		const xrp = result.data.holdings.find((h: { asset: string }) => h.asset === 'xrp');
		expect(xrp.current_price).toBe(29.5912345);
		expect(xrp.avg_buy_price).toBeCloseTo(26.6861234567, 9);
	});

	it('holdings_performance.current_price も同じ丸めになる', async () => {
		setupFetchMock({
			assets: xrpOnlyAssets,
			trades: xrpBuy('26.686'),
			tickers: tickersWithXrpLast('29.59'),
			...emptyDw,
		});

		const result = await callHandler();

		assertOk(result);
		const hp = result.data.holdings_performance?.find((h: { asset: string }) => h.asset === 'xrp');
		expect(hp?.current_price).toBe(29.59);
	});

	it('回帰: ticker 未取得の銘柄は current_price が undefined のまま（丸めが値を作らない）', async () => {
		setupFetchMock({
			assets: xrpOnlyAssets,
			trades: xrpBuy('26.686'),
			// xrp_jpy を落とした tickers
			tickers: { success: 1, data: tickersJpy.data.filter((t) => t.pair !== 'xrp_jpy') },
			...emptyDw,
		});

		const result = await callHandler();

		assertOk(result);
		const xrp = result.data.holdings.find((h: { asset: string }) => h.asset === 'xrp');
		expect(xrp.current_price).toBeUndefined();
		expect(xrp.jpy_value).toBeUndefined();
	});

	it('回帰: 取得原価が抑止される経路では avg_buy_price が undefined のまま（current_price は丸めて出る）', async () => {
		// 出庫履歴の取得失敗 → flowUnavailableReason=dw_fetch_failed で原価由来 4 フィールドを抑止
		setupFetchMock({
			assets: xrpOnlyAssets,
			trades: xrpBuy('26.686'),
			tickers: tickersWithXrpLast('29.59'),
			dwFail: true,
		});

		const result = await callHandler();

		assertOk(result);
		const xrp = result.data.holdings.find((h: { asset: string }) => h.asset === 'xrp');
		expect(xrp.cost_basis_unavailable_reason).toBe('dw_fetch_failed');
		expect(xrp.avg_buy_price).toBeUndefined();
		expect(xrp.current_price).toBe(29.59);
	});

	it('回帰: 数量乖離で抑止される経路でも current_price は丸めて出る', async () => {
		setupFetchMock({
			// onhand 1000 に対し約定は 1 のみ（1000 倍乖離）
			assets: xrpOnlyAssets,
			trades: {
				trades: [{ ...xrpBuy('26.686').trades[0], amount: '1' }],
			},
			tickers: tickersWithXrpLast('29.59'),
			...emptyDw,
		});

		const result = await callHandler();

		assertOk(result);
		const xrp = result.data.holdings.find((h: { asset: string }) => h.asset === 'xrp');
		expect(xrp.cost_basis_reliable).toBe(false);
		expect(xrp.avg_buy_price).toBeUndefined();
		expect(xrp.current_price).toBe(29.59);
	});

	it('円建て金額の整数丸めは変えない（jpy_value / cost_basis は整数のまま）', async () => {
		setupFetchMock({
			assets: xrpOnlyAssets,
			trades: xrpBuy('26.6861234567'),
			tickers: tickersWithXrpLast('29.5912345'),
			...emptyDw,
		});

		const result = await callHandler();

		assertOk(result);
		const xrp = result.data.holdings.find((h: { asset: string }) => h.asset === 'xrp');
		expect(xrp.jpy_value).toBe(Math.round(xrp.jpy_value));
		expect(xrp.cost_basis).toBe(Math.round(xrp.cost_basis));
		expect(result.data.total_jpy_value).toBe(Math.round(result.data.total_jpy_value));
	});
});

/**
 * #59 6-1: Realized PnL 3 系統のスコープ明示。
 *
 * 同一出力に「全履歴・全銘柄（account_pnl.spot_realized_pnl / total_realized_pnl）」
 * 「年初来・月初来（yearly_/monthly_）」「全履歴だが現在保有中の銘柄のみ（holdings[].realized_pnl の合計）」
 * が併存する。差分は売り切り銘柄ぶんなので、その内訳を closed_position_realized_pnl として出し、
 * 検算式が出力上で閉じることをここで固定する。
 */
describe('analyze_my_portfolio — Realized PnL のスコープと売り切り銘柄の内訳', () => {
	/** xrp のみ保有（onhand 1000）+ JPY。doge / xlm は保有せず「売り切り銘柄」になる */
	const xrpOnlyAssets = {
		assets: [assetFixture('xrp'), assetFixture('jpy')],
	};

	const emptyDw = { deposits: { deposits: [] }, withdrawals: { withdrawals: [] } };

	/** 手数料ゼロの約定 1 件（原価・実現損益を暗算できる形にそろえる） */
	function trade(id: number, pair: string, side: 'buy' | 'sell', amount: string, price: string, executedAt: number) {
		return {
			trade_id: id,
			pair,
			order_id: id,
			side,
			type: 'limit',
			amount,
			price,
			maker_taker: 'maker',
			fee_amount_base: '0',
			fee_amount_quote: '0',
			fee_occurred_amount_quote: '0',
			executed_at: executedAt,
		};
	}

	/**
	 * 保有中銘柄（xrp）: 買 1200 @20 → 売 200 @30 で realized +2,000、残 1000（onhand と一致）。
	 * 売り切り銘柄（doge）: 買 1000 @10 → 売 1000 @15 で realized +5,000、残 0（holdings に載らない）。
	 */
	const heldAndClosedTrades = {
		trades: [
			trade(5901, 'xrp_jpy', 'buy', '1200', '20', 1710000000000),
			trade(5902, 'xrp_jpy', 'sell', '200', '30', 1710000100000),
			trade(5903, 'doge_jpy', 'buy', '1000', '10', 1710000200000),
			trade(5904, 'doge_jpy', 'sell', '1000', '15', 1710000300000),
		],
	};

	/** 保有中銘柄（xrp）だけ。売り切り銘柄は 1 件も無い */
	const heldOnlyTrades = {
		trades: [
			trade(5901, 'xrp_jpy', 'buy', '1200', '20', 1710000000000),
			trade(5902, 'xrp_jpy', 'sell', '200', '30', 1710000100000),
		],
	};

	function callHandler() {
		return import('../../src/handlers/analyzeMyPortfolioHandler.js').then(({ default: handler }) =>
			handler({ include_technical: false, include_pnl: true, include_deposit_withdrawal: false }),
		);
	}

	/** holdings[].realized_pnl の合計（undefined の JPY 行は除外） */
	function sumHoldingsRealizedPnl(holdings: Array<{ realized_pnl?: number }>): number {
		return holdings.reduce((acc, h) => acc + (h.realized_pnl ?? 0), 0);
	}

	it('受け入れ: 検算式 Σ holdings[].realized_pnl + closed_position_realized_pnl = account_pnl.spot_realized_pnl が成立する', async () => {
		setupFetchMock({ assets: xrpOnlyAssets, trades: heldAndClosedTrades, ...emptyDw });

		const result = await callHandler();

		assertOk(result);
		// 保有中銘柄ぶん（xrp のみ。doge は保有ゼロなので holdings に載らない）
		const heldSum = sumHoldingsRealizedPnl(result.data.holdings);
		expect(heldSum).toBeCloseTo(2000, 6);
		expect(result.data.holdings.some((h: { asset: string }) => h.asset === 'doge')).toBe(false);

		// 売り切り銘柄ぶん（doge）
		expect(result.data.closed_position_realized_pnl).toBeCloseTo(5000, 6);
		expect(result.data.closed_position_asset_count).toBe(1);

		// 検算式が閉じる
		expect(heldSum + result.data.closed_position_realized_pnl).toBeCloseTo(
			result.data.account_pnl.spot_realized_pnl,
			6,
		);
		expect(result.data.account_pnl.spot_realized_pnl).toBeCloseTo(7000, 6);
		// total_realized_pnl は account_pnl.spot_realized_pnl と同値（3 系統の対応関係）
		expect(result.data.total_realized_pnl).toBeCloseTo(result.data.account_pnl.spot_realized_pnl, 6);
	});

	it('受け入れ: summary のラベルにスコープが載り、内訳行で保有中 / 売り切りが分かれる', async () => {
		setupFetchMock({ assets: xrpOnlyAssets, trades: heldAndClosedTrades, ...emptyDw });

		const result = await callHandler();

		assertOk(result);
		// 旧実装は 'Realized PnL (Spot): ' のみでスコープが読めなかった
		expect(result.summary).toContain('Realized PnL (Spot, 全履歴・売り切り銘柄含む): +7,000円');
		expect(result.summary).toContain(
			'内訳: 現在保有銘柄（holdings[].realized_pnl の合計）+2,000円 / 売り切り銘柄 1銘柄 +5,000円',
		);
		expect(result.summary).toContain('Account PnL (全履歴):');
		// 年初来 / 月初来が data 側にしか無いことを text だけの LLM に伝える
		expect(result.summary).toContain('yearly_account_pnl / monthly_account_pnl');
	});

	it('売り切り銘柄ゼロ件: closed_position_realized_pnl は 0（未集計の undefined とは区別）で検算式も成立', async () => {
		setupFetchMock({ assets: xrpOnlyAssets, trades: heldOnlyTrades, ...emptyDw });

		const result = await callHandler();

		assertOk(result);
		expect(result.data.closed_position_realized_pnl).toBe(0);
		expect(result.data.closed_position_asset_count).toBe(0);
		const heldSum = sumHoldingsRealizedPnl(result.data.holdings);
		expect(heldSum).toBeCloseTo(result.data.account_pnl.spot_realized_pnl, 6);
		expect(result.summary).toContain(
			'内訳: 現在保有銘柄（holdings[].realized_pnl の合計）+2,000円 / 売り切り銘柄なし（0円）',
		);
	});

	it('実現損益ちょうど 0 の売り切り銘柄は件数に数えない（合計にも寄与しない）', async () => {
		setupFetchMock({
			assets: xrpOnlyAssets,
			trades: {
				trades: [
					...heldAndClosedTrades.trades,
					// xlm: 買 100 @10 → 売 100 @10 で realized ちょうど 0 の売り切り銘柄
					trade(5905, 'xlm_jpy', 'buy', '100', '10', 1710000400000),
					trade(5906, 'xlm_jpy', 'sell', '100', '10', 1710000500000),
				],
			},
			...emptyDw,
		});

		const result = await callHandler();

		assertOk(result);
		expect(result.data.closed_position_realized_pnl).toBeCloseTo(5000, 6);
		// doge の 1 件のみ。xlm は 0 円なので合計に寄与せず件数にも入らない
		expect(result.data.closed_position_asset_count).toBe(1);
	});

	it('売り切り銘柄が複数: 合計と件数が両方積み上がる', async () => {
		setupFetchMock({
			assets: xrpOnlyAssets,
			trades: {
				trades: [
					...heldAndClosedTrades.trades,
					// xlm: 買 100 @10 → 売 100 @7 で realized -300 の売り切り銘柄
					trade(5905, 'xlm_jpy', 'buy', '100', '10', 1710000400000),
					trade(5906, 'xlm_jpy', 'sell', '100', '7', 1710000500000),
				],
			},
			...emptyDw,
		});

		const result = await callHandler();

		assertOk(result);
		expect(result.data.closed_position_realized_pnl).toBeCloseTo(4700, 6);
		expect(result.data.closed_position_asset_count).toBe(2);
		const heldSum = sumHoldingsRealizedPnl(result.data.holdings);
		expect(heldSum + result.data.closed_position_realized_pnl).toBeCloseTo(
			result.data.account_pnl.spot_realized_pnl,
			6,
		);
	});

	it('約定履歴 0 件: 集計していないので closed_position_* は undefined（0 ではない）で内訳行も出ない', async () => {
		setupFetchMock({ assets: xrpOnlyAssets, trades: { trades: [] }, ...emptyDw });

		const result = await callHandler();

		assertOk(result);
		expect(result.data.closed_position_realized_pnl).toBeUndefined();
		expect(result.data.closed_position_asset_count).toBeUndefined();
		expect(result.summary).not.toContain('内訳: 現在保有銘柄');
	});

	it('include_pnl=false: 損益出力自体が無いので closed_position_* も Realized PnL 行も出ない', async () => {
		setupFetchMock({ assets: xrpOnlyAssets, trades: heldAndClosedTrades, ...emptyDw });

		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		const result = await handler({
			include_technical: false,
			include_pnl: false,
			include_deposit_withdrawal: false,
		});

		assertOk(result);
		expect(result.data.closed_position_realized_pnl).toBeUndefined();
		expect(result.data.closed_position_asset_count).toBeUndefined();
		expect(result.summary).not.toContain('Realized PnL (Spot');
	});
});

/**
 * #59 6-2: ゼロ建玉の表示抑制。
 *
 * 実口座では決済済みペアのゼロ建玉が居座り、実建玉が埋もれる（#53 症状 7 前半）。
 * 明細行からは落とすが、省略件数は集計行に必ず出す（黙って消さない）。
 * structuredContent 側には元から建玉データを載せていないため、変更は表示テキストのみ。
 */
describe('analyze_my_portfolio — ゼロ建玉の表示抑制', () => {
	/** 建玉数量・評価額ともゼロの行（決済済みペアの残骸） */
	function zeroPosition(pair: string, side: 'long' | 'short') {
		return {
			pair,
			position_side: side,
			open_amount: '0',
			product: '0',
			average_price: '0',
			unrealized_fee_amount: '0',
			unrealized_interest_amount: '0',
		};
	}

	function positionsResponse(positions: unknown[]) {
		return {
			notice: null,
			payables: { amount: '0' },
			positions,
			losscut_threshold: { individual: '110', company: '120' },
		};
	}

	function callHandler() {
		return import('../../src/handlers/analyzeMyPortfolioHandler.js').then(({ default: handler }) =>
			handler({ include_technical: false, include_pnl: true, include_deposit_withdrawal: false }),
		);
	}

	it('受け入れ: 実建玉とゼロ建玉の混在では実建玉のみ表示し、省略件数を集計行に併記する', async () => {
		setupFetchMock({
			marginPositions: positionsResponse([
				rawMarginPositionsResponse.positions[0], // btc ロング 0.01（実建玉）
				zeroPosition('xrp_jpy', 'long'),
				zeroPosition('ltc_jpy', 'short'),
			]),
		});

		const result = await callHandler();

		assertOk(result);
		expect(result.summary).toContain('信用建玉:');
		expect(result.summary).toContain('BTC/JPY ロング 0.01');
		// ゼロ建玉の明細行は出ない
		expect(result.summary).not.toContain('XRP/JPY ロング 0');
		expect(result.summary).not.toContain('LTC/JPY ショート 0');
		// 件数は実建玉のみを数え、省略件数を併記する
		expect(result.summary).toContain('集計: ロング 1件 / ショート 0件 / ゼロ建玉 2件省略');
	});

	it('全建玉がゼロ: セクションは出すが明細行は 0 行、集計行で省略件数を申告する', async () => {
		setupFetchMock({
			marginPositions: positionsResponse([
				zeroPosition('btc_jpy', 'long'),
				zeroPosition('eth_jpy', 'short'),
				zeroPosition('xrp_jpy', 'long'),
			]),
		});

		const result = await callHandler();

		assertOk(result);
		// セクションごと消すと省略件数の申告先が無くなり「建玉なし」と区別できなくなる
		expect(result.summary).toContain('信用建玉:');
		expect(result.summary).toContain('集計: ロング 0件 / ショート 0件 / ゼロ建玉 3件省略');
		// 明細行は 1 行も出ない
		expect(result.summary).not.toContain('BTC/JPY ロング 0');
		expect(result.summary).not.toContain('ETH/JPY ショート 0');
		expect(result.summary).not.toContain('XRP/JPY ロング 0');
	});

	it('回帰: 建玉そのものが 0 件ならセクション自体を出さない（省略注記も出ない）', async () => {
		setupFetchMock({ marginPositions: positionsResponse([]) });

		const result = await callHandler();

		assertOk(result);
		expect(result.summary).not.toContain('信用建玉:');
		expect(result.summary).not.toContain('ゼロ建玉');
	});

	it('回帰: 実建玉のみなら従来どおり全件表示し、省略注記は付かない', async () => {
		setupFetchMock({ marginPositions: rawMarginPositionsResponse });

		const result = await callHandler();

		assertOk(result);
		expect(result.summary).toContain('BTC/JPY ロング 0.01');
		expect(result.summary).toContain('ETH/JPY ショート 1.0');
		expect(result.summary).toContain('集計: ロング 1件 / ショート 1件');
		expect(result.summary).not.toContain('ゼロ建玉');
	});

	it('open_amount=0 でも評価額が非ゼロなら抑制しない（ゼロと断定できる行だけ落とす）', async () => {
		setupFetchMock({
			marginPositions: positionsResponse([
				{ ...zeroPosition('btc_jpy', 'long'), product: '150000' },
				zeroPosition('eth_jpy', 'short'),
			]),
		});

		const result = await callHandler();

		assertOk(result);
		expect(result.summary).toContain('BTC/JPY ロング 0 (評価額: ¥150,000円)');
		expect(result.summary).toContain('集計: ロング 1件 / ショート 0件 / ゼロ建玉 1件省略');
	});
});

/**
 * 資産推移シリーズの入出金フローマーカー（#60）。
 *
 * 月次・年次の資産推移は入出金があった期間でも単一の連続線として出るため、大口入金のある
 * 口座では「ずっと同額を保有していた」ように誤読される（#53 の症状 7 後半）。グラフ化されると
 * 注記行は消える前提なので、フロー発生点を `EquityPoint.flow_jpy` として**データで**返し、
 * summary にも読み方を添える。
 *
 * 現在時刻は JST 2026-05-16 12:00 に固定する。シリーズの点は `Date.now()` 由来の
 * JST 暦日境界から生えるため、固定しないと「当月内の入金」を仕込めない。
 */
describe('analyze_my_portfolio — 資産推移の入出金フローマーカー', () => {
	/** 2026-05-16T03:00:00Z = JST 2026-05-16 12:00 */
	const fixedNowMs = Date.UTC(2026, 4, 16, 3);
	/** JST 2026-05-10 10:00（当月内・当年内） */
	const depositAtMs = Date.UTC(2026, 4, 10, 1);
	/** JST 2026-05-12 18:00（同じ当月内、入金より後） */
	const withdrawalAtMs = Date.UTC(2026, 4, 12, 9);

	/** JPY のみ保有。価格解決を挟まずフローの寄せ方と表示だけを見るための最小構成。 */
	function jpyOnlyAssets(onhand: string) {
		return {
			assets: [
				{
					asset: 'jpy',
					free_amount: onhand,
					amount_precision: 0,
					onhand_amount: onhand,
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

	/** 約定・信用なし、入出金だけを差し込める JPY 単独口座の fetch モック */
	function setupJpyOnlyMock(opts: { onhand: string; deposits?: unknown[]; withdrawals?: unknown[] }) {
		globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			const maybeMargin = maybeMarginAccountResponse(urlStr);
			if (maybeMargin) return maybeMargin;
			if (urlStr.includes('tickers_jpy')) {
				return new Response(JSON.stringify(tickersJpy), { status: 200 });
			}
			if (urlStr.includes('/v1/user/assets')) {
				return new Response(JSON.stringify(mockBitbankSuccess(jpyOnlyAssets(opts.onhand))), { status: 200 });
			}
			if (urlStr.includes('trade_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ trades: [] })), { status: 200 });
			}
			if (urlStr.includes('deposit_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ deposits: opts.deposits ?? [] })), { status: 200 });
			}
			if (urlStr.includes('withdrawal_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: opts.withdrawals ?? [] })), {
					status: 200,
				});
			}
			return new Response(JSON.stringify(mockBitbankSuccess({})), { status: 200 });
		}) as unknown as typeof fetch;
	}

	async function analyze() {
		const { default: handler } = await import('../../src/handlers/analyzeMyPortfolioHandler.js');
		return handler({ include_technical: false, include_pnl: true, include_deposit_withdrawal: true });
	}

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(fixedNowMs);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('大口入金があった日の点から機械的にフロー発生点を判別できる', async () => {
		// 現在 1,500,000 円。うち 500,000 円は 5/10 の入金。
		setupJpyOnlyMock({
			onhand: '1500000',
			deposits: [
				{
					uuid: 'dep-1',
					asset: 'jpy',
					amount: '500000',
					status: 'DONE',
					found_at: depositAtMs,
					confirmed_at: depositAtMs,
				},
			],
		});

		const result = await analyze();
		assertOk(result);

		const monthly = result.data.monthly_equity_series ?? [];
		const flowPoints = monthly.filter((p: { flow_jpy?: number }) => p.flow_jpy != null);
		expect(flowPoints).toHaveLength(1);
		expect(flowPoints[0].timestamp).toBe('2026-05-10T00:00:00+09:00');
		expect(flowPoints[0].flow_jpy).toBe(500_000);

		// 年次シリーズ（月次点）では 5 月の点に寄る
		const yearly = result.data.yearly_equity_series ?? [];
		const yearlyFlowPoints = yearly.filter((p: { flow_jpy?: number }) => p.flow_jpy != null);
		expect(yearlyFlowPoints).toHaveLength(1);
		expect(yearlyFlowPoints[0].timestamp).toBe('2026-05-01T00:00:00+09:00');
		expect(yearlyFlowPoints[0].flow_jpy).toBe(500_000);
	});

	/**
	 * フローマーカーの存在理由そのもの。入金による段差を「運用成績」と読ませないために、
	 * 増減からフローを引いた残りがゼロ（JPY のみ保有なので市場変動が無い）になることを固定する。
	 */
	it('増減からフローを引くと市場変動が残る（JPY のみ保有なら全区間ゼロ）', async () => {
		setupJpyOnlyMock({
			onhand: '1500000',
			deposits: [
				{
					uuid: 'dep-1',
					asset: 'jpy',
					amount: '500000',
					status: 'DONE',
					found_at: depositAtMs,
					confirmed_at: depositAtMs,
				},
			],
		});

		const result = await analyze();
		assertOk(result);

		const monthly: Array<{ value_jpy: number; flow_jpy?: number }> = result.data.monthly_equity_series ?? [];
		expect(monthly.length).toBeGreaterThan(1);
		for (let i = 0; i < monthly.length - 1; i++) {
			expect(monthly[i + 1].value_jpy - monthly[i].value_jpy - (monthly[i].flow_jpy ?? 0)).toBe(0);
		}
		// 段差そのものは実在する（フローを引くとゼロになるだけで、線は動いている）
		expect(monthly[0].value_jpy).toBe(1_000_000);
		expect(monthly[monthly.length - 1].value_jpy).toBe(1_500_000);
	});

	it('同じ日の入金と出金は純額で 1 点に集約される', async () => {
		// 5/12 に 300,000 入金 + 100,000 出金（手数料 550）→ 純額 +200,000
		setupJpyOnlyMock({
			onhand: '1200000',
			deposits: [
				{
					uuid: 'dep-1',
					asset: 'jpy',
					amount: '300000',
					status: 'DONE',
					found_at: withdrawalAtMs,
					confirmed_at: withdrawalAtMs,
				},
			],
			withdrawals: [
				{ uuid: 'wd-1', asset: 'jpy', amount: '100000', fee: '550', status: 'DONE', requested_at: withdrawalAtMs },
			],
		});

		const result = await analyze();
		assertOk(result);

		const monthly = result.data.monthly_equity_series ?? [];
		const flowPoints = monthly.filter((p: { flow_jpy?: number }) => p.flow_jpy != null);
		expect(flowPoints).toHaveLength(1);
		expect(flowPoints[0].timestamp).toBe('2026-05-12T00:00:00+09:00');
		// 出金手数料 550 円は含まない（*_performance.net_flow_jpy と同一定義）
		expect(flowPoints[0].flow_jpy).toBe(200_000);
	});

	it('summary にフロー発生点のマーカーと読み方が出る', async () => {
		setupJpyOnlyMock({
			onhand: '1500000',
			deposits: [
				{
					uuid: 'dep-1',
					asset: 'jpy',
					amount: '500000',
					status: 'DONE',
					found_at: depositAtMs,
					confirmed_at: depositAtMs,
				},
			],
		});

		const result = await analyze();
		assertOk(result);

		expect(result.summary).toContain('2026-05-10T00:00:00+09:00: 1,000,000円 ← 純入出金 +500,000円');
		expect(result.summary).toContain('マーカーとして扱い、線の変動として説明しない');
		// 見出しに読み方が乗る（月次・年次それぞれ）
		const headings = result.summary.split('\n').filter((l: string) => l.includes('資産推移（'));
		expect(headings).toHaveLength(2);
		for (const h of headings) expect(h).toContain('「← 純入出金」');
	});

	it('出金は summary で負値のマーカーになる', async () => {
		setupJpyOnlyMock({
			onhand: '800000',
			withdrawals: [
				{ uuid: 'wd-1', asset: 'jpy', amount: '200000', fee: '550', status: 'DONE', requested_at: withdrawalAtMs },
			],
		});

		const result = await analyze();
		assertOk(result);
		expect(result.summary).toContain('2026-05-12T00:00:00+09:00: 1,000,550円 ← 純入出金 -200,000円');
	});

	/**
	 * 回帰。フローが無い期間では従来と JSON レベルで一致し、summary の見出しも変わらない。
	 * `toEqual` は undefined のプロパティを無視するため `JSON.stringify` で確かめる。
	 */
	it('フローが無い期間の出力は従来と一致する（JSON / 見出しとも）', async () => {
		setupJpyOnlyMock({ onhand: '1000000' });

		const result = await analyze();
		assertOk(result);

		expect(JSON.stringify(result.data.monthly_equity_series)).not.toContain('flow_jpy');
		expect(JSON.stringify(result.data.yearly_equity_series)).not.toContain('flow_jpy');
		expect(result.summary).toContain('月次資産推移（日次, 17点）— グラフ「月次推移」タブ専用。年次タブでは使わない:');
		expect(result.summary).toContain('年次資産推移（月次, 6点）— グラフ「年次推移」タブ専用。月次タブでは使わない:');
		expect(result.summary).not.toContain('純入出金 +');
	});

	it('入出金履歴の取得に失敗した場合はフローを載せない（未計測は performance 側で申告済み）', async () => {
		globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
			const maybeMargin = maybeMarginAccountResponse(urlStr);
			if (maybeMargin) return maybeMargin;
			if (urlStr.includes('tickers_jpy')) return new Response(JSON.stringify(tickersJpy), { status: 200 });
			if (urlStr.includes('/v1/user/assets')) {
				return new Response(JSON.stringify(mockBitbankSuccess(jpyOnlyAssets('1500000'))), { status: 200 });
			}
			if (urlStr.includes('trade_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ trades: [] })), { status: 200 });
			}
			if (urlStr.includes('deposit_history') || urlStr.includes('withdrawal_history')) {
				return new Response(JSON.stringify(mockBitbankError(10007)), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess({})), { status: 200 });
		}) as unknown as typeof fetch;

		const result = await analyze();
		assertOk(result);

		expect(JSON.stringify(result.data.monthly_equity_series)).not.toContain('flow_jpy');
		// 「フローがゼロ」ではなく「未計測」であることは既存の申告経路が担う
		expect(result.data.monthly_performance.flow_measured).toBe(false);
		expect(result.data.monthly_performance.flow_unavailable_reason).toBeDefined();
	});
});
