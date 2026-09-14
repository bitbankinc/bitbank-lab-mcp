/**
 * portfolio — API が返す pair シンボルの取得境界正規化（`lib/pair-code.ts`）の統合テスト。
 *
 * `portfolio/calc.ts` の各関数は「pair は小文字」を前提に、`calcPnl` の
 * `t.pair === \`${asset}_jpy\`` 突き合わせ・`calcPeriodRealizedPnl` /
 * `reconstructHoldingsAtDate` の `t.pair.replace('_jpy', '')` による asset 導出を組んでいる。
 * 前提を担保するのは取得境界（`portfolio/fetch.ts` / `lib/tickers.ts`）だけなので、
 * 本テストは **fetch 層を通した結果を calc 層へ流す** 形で検証する。
 * calc 側に `.toLowerCase()` を撒く実装へ退行したらこのテストは意味を失うため、
 * 検証は必ず `paginateTrades` / `fetchTickerPricesMap` 経由で行うこと。
 *
 * pair 由来の破綻は asset 版より悪い: `'BTC_JPY'.replace('_jpy', '')` は**何も置換しない**ので
 * asset が `BTC_JPY` のまま Map キーになり、`lib/asset-code.ts` で正規化した `btc` と割れる。
 * `calcPnl` に至ってはエラーにならず「取引履歴なし」に見え、平均取得単価・実現損益が静かに消える。
 *
 * 現行 API は小文字を返す（`docs/internal/bitbank-api-fields.md`）ので、これは防御的正規化。
 * 併せて「小文字レスポンスでは出力が変わらない」回帰ケースも固定する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchTickerPricesMap } from '../../../lib/tickers.js';
import {
	calcPeriodRealizedPnl,
	calcPnl,
	calcPortfolioValue,
	reconstructHoldingsAtDate,
} from '../../../src/handlers/portfolio/calc.js';
import { paginateTrades } from '../../../src/handlers/portfolio/fetch.js';
import type { RawTrade } from '../../../src/handlers/portfolio/types.js';
import { BitbankPrivateClient } from '../../../src/private/client.js';
import { currentPriceOnly } from '../../_flowPricing.js';
import { mockBitbankSuccess } from '../../fixtures/private-api.js';

const ORIGINAL_TICKERS_JPY_URL = process.env.TICKERS_JPY_URL;

beforeEach(() => {
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
});

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.BITBANK_API_KEY;
	delete process.env.BITBANK_API_SECRET;
	if (ORIGINAL_TICKERS_JPY_URL === undefined) {
		delete process.env.TICKERS_JPY_URL;
	} else {
		process.env.TICKERS_JPY_URL = ORIGINAL_TICKERS_JPY_URL;
	}
});

const T_BUY = 1_710_000_000_000;
const T_SELL = 1_710_000_100_000;

/** `paginateTrades` を通して現物約定を取得する（取得境界を必ず経由させる）。 */
async function fetchTrades(trades: unknown[]): Promise<RawTrade[]> {
	const fetcher = (async () =>
		new Response(JSON.stringify(mockBitbankSuccess({ trades })), { status: 200 })) as unknown as typeof fetch;
	const result = await paginateTrades(new BitbankPrivateClient({ fetcher }));
	return result.trades;
}

/** 買い 1 BTC @10,000,000 → 売り 0.5 BTC @12,000,000。pair の大文字/小文字だけを差し替える。 */
function tradesWithPair(pair: string) {
	return [
		{
			trade_id: 1,
			pair,
			order_id: 1,
			side: 'buy',
			type: 'limit',
			amount: '1',
			price: '10000000',
			maker_taker: 'maker',
			fee_amount_base: '0',
			fee_amount_quote: '0',
			executed_at: T_BUY,
		},
		{
			trade_id: 2,
			pair,
			order_id: 2,
			side: 'sell',
			type: 'limit',
			amount: '0.5',
			price: '12000000',
			maker_taker: 'maker',
			fee_amount_base: '0',
			fee_amount_quote: '0',
			executed_at: T_SELL,
		},
	];
}

describe('取得境界での pair 正規化 — 損益（fetch → calc）', () => {
	it('大文字 BTC_JPY の約定でも calcPnl が該当約定を拾い、平均取得単価・実現損益が消えない', async () => {
		const trades = await fetchTrades(tradesWithPair('BTC_JPY'));

		// 取得境界を抜けた時点で小文字になっている
		expect(trades.map((t) => t.pair)).toEqual(['btc_jpy', 'btc_jpy']);

		const result = calcPnl(trades, 'btc');

		// 正規化前は `t.pair === 'btc_jpy'` が 0 件マッチで「取引履歴なし」に見えていた
		expect(result.trade_count).toBe(2);
		expect(result.realized_pnl).toBe(1_000_000); // 0.5 * (12,000,000 - 10,000,000)
		expect(result.avg_buy_price).toBe(10_000_000);
		expect(result.cost_basis).toBe(5_000_000);
	});

	/**
	 * `calcPeriodRealizedPnl` は pair から導出した asset をキーに holdings を積む。
	 * 出庫側の asset は `lib/asset-code.ts` が小文字を保証しているので、pair 由来の asset が
	 * 大文字（`BTC_JPY`）のままだと**両者が別キーになり出庫が原価按分に効かない**。
	 * 単独の売買だけではキーが割れても算術が閉じてしまい検知できないため、
	 * asset 側との join を必ず含めて検証する。
	 */
	it('大文字 BTC_JPY の約定でも calcPeriodRealizedPnl が asset 側の出庫と join して集計する', async () => {
		const trades = await fetchTrades(tradesWithPair('BTC_JPY'));

		// 買い 1 BTC の後、売りの前に 0.8 BTC（0.7994 + 手数料 0.0006）を出庫する。
		// 反映されれば売り時点の保有は 0.2 BTC / 原価 2,000,000 → 実現損益 6,000,000 - 2,000,000。
		// キーが割れると 0.5 BTC 分の原価 5,000,000 が引かれて 1,000,000 になる。
		const withdrawals = [
			{
				uuid: 'wd-btc-1',
				asset: 'btc',
				amount: '0.7994',
				fee: '0.0006',
				status: 'DONE',
				requested_at: T_BUY + 1,
			},
		];

		const result = calcPeriodRealizedPnl(
			trades,
			T_BUY + 1,
			'2026-01-01T00:00:00+09:00',
			'2026-08-11T00:00:00+09:00',
			withdrawals as Parameters<typeof calcPeriodRealizedPnl>[4],
		);

		expect(result.realized_pnl).toBe(4_000_000);
		expect(result.sell_count).toBe(1);
	});

	it('大文字 BTC_JPY の約定でも calcPnl が asset 側の出庫と join して原価按分する', async () => {
		const trades = await fetchTrades(tradesWithPair('BTC_JPY'));
		const withdrawals = [
			{
				uuid: 'wd-btc-1',
				asset: 'btc',
				amount: '0.7994',
				fee: '0.0006',
				status: 'DONE',
				requested_at: T_BUY + 1,
			},
		] as Parameters<typeof calcPnl>[2];

		const result = calcPnl(trades, 'btc', withdrawals);

		expect(result.realized_pnl).toBe(4_000_000);
		expect(result.cost_basis).toBeUndefined();
		expect(result.trade_count).toBe(2);
	});

	/**
	 * `calcPeriodRealizedPnl` は `t.pair.replace('_jpy', '')` で asset を導出し
	 * `if (asset === 'jpy') continue` で JPY ペアを弾く。大文字だと `JPY_JPY` のままなので
	 * この除外が外れる——正規化後は従来どおり弾かれることを固定する。
	 */
	it('大文字 JPY_JPY の約定は従来どおり除外される（asset 導出の JPY 判定が外れない）', async () => {
		const trades = await fetchTrades(tradesWithPair('JPY_JPY'));

		const result = calcPeriodRealizedPnl(trades, 0, '2026-01-01T00:00:00+09:00', '2026-08-11T00:00:00+09:00');

		expect(result.realized_pnl).toBe(0);
		expect(result.sell_count).toBe(0);
	});

	it('reconstructHoldingsAtDate の holdings キーが BTC_JPY にならず btc に収まる', async () => {
		const trades = await fetchTrades(tradesWithPair('BTC_JPY'));

		// 現在保有 0.5 BTC + 10,000,000 JPY から、期間内の売り 0.5 BTC を巻き戻す
		const holdings = reconstructHoldingsAtDate(
			[
				{ asset: 'btc', amount: '0.5' },
				{ asset: 'jpy', amount: '10000000' },
			],
			trades,
			T_SELL - 1,
			null,
		);

		// 正規化前は 'BTC_JPY' という別キーが生え、'btc' は 0.5 のまま取り残されていた
		expect([...holdings.keys()].sort()).toEqual(['btc', 'jpy']);
		expect(holdings.get('btc')).toBeCloseTo(1, 12);
		expect(holdings.get('jpy')).toBeCloseTo(4_000_000, 6);
	});

	/**
	 * pair 由来の asset（`replace('_jpy', '')`）が `lib/asset-code.ts` 側の小文字 asset と
	 * 同じ空間に乗ること。乗らないと評価額が 0 円になる（PR #38 との join）。
	 */
	it('pair 由来の asset が ticker 価格マップのキーと join できる', async () => {
		const trades = await fetchTrades(tradesWithPair('BTC_JPY'));
		const holdings = reconstructHoldingsAtDate([{ asset: 'btc', amount: '0.5' }], trades, T_SELL - 1, null);

		process.env.TICKERS_JPY_URL = 'https://example.test/tickers_jpy';
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ success: 1, data: [{ pair: 'BTC_JPY', last: '12000000' }] }), { status: 200 }),
		);
		const { prices } = await fetchTickerPricesMap();

		expect(calcPortfolioValue(holdings, prices)).toBe(1 * 12_000_000);
	});
});

describe('取得境界での pair 正規化 — ticker 価格マップ', () => {
	function mockTickers(data: unknown[]) {
		process.env.TICKERS_JPY_URL = 'https://example.test/tickers_jpy';
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ success: 1, data }), { status: 200 }),
		);
	}

	it('大文字 BTC_JPY の tickers でも prices のキーが btc になる', async () => {
		mockTickers([
			{ pair: 'BTC_JPY', last: '15500000' },
			{ pair: 'ETH_JPY', last: '380000' },
		]);

		const { prices } = await fetchTickerPricesMap();

		// 正規化前は 'BTC_JPY' がキーになり prices.get('btc') が全銘柄で外れていた
		expect([...prices.keys()].sort()).toEqual(['btc', 'eth']);
		expect(prices.get('btc')).toBe(15_500_000);
	});

	it('大文字 tickers でも calcPeriodNetFlow の unpriced_flow_assets を誤検知しない', async () => {
		mockTickers([{ pair: 'BTC_JPY', last: '15500000' }]);
		const { prices } = await fetchTickerPricesMap();

		const { calcPeriodNetFlow } = await import('../../../src/handlers/portfolio/calc.js');
		const flow = calcPeriodNetFlow(
			{
				deposits: [
					{
						uuid: 'dep-btc',
						asset: 'btc',
						amount: '0.1',
						status: 'DONE',
						found_at: 1_000,
						confirmed_at: 1_000,
					},
				],
				withdrawals: [],
				warnings: [],
				allFailed: false,
				isComplete: true,
			},
			0,
			// 本ファイルの対象は pair → asset キーの正規化なので、価格解決は現在価格 1 経路に固定する。
			currentPriceOnly(prices),
		);

		expect(flow.net_flow_jpy).toBe(Math.round(0.1 * 15_500_000));
		// PR #37 の warning 経路。価格が引けているのに申告されたら誤検知
		expect(flow.unpriced_assets).toBeUndefined();
	});
});

describe('取得境界での pair 正規化 — 小文字レスポンスの回帰防止', () => {
	it('小文字レスポンスは取得結果が API のレコードとバイト等価', async () => {
		const raw = tradesWithPair('btc_jpy');
		const trades = await fetchTrades(raw);

		expect(trades).toEqual(raw);
	});

	it('小文字レスポンスの集計結果が大文字レスポンスと一致する', async () => {
		const lower = await fetchTrades(tradesWithPair('btc_jpy'));
		const upper = await fetchTrades(tradesWithPair('BTC_JPY'));

		expect(calcPnl(upper, 'btc')).toEqual(calcPnl(lower, 'btc'));
		expect(calcPeriodRealizedPnl(upper, 0, 'a', 'b')).toEqual(calcPeriodRealizedPnl(lower, 0, 'a', 'b'));
		expect([...reconstructHoldingsAtDate([{ asset: 'btc', amount: '0.5' }], upper, 0, null)]).toEqual([
			...reconstructHoldingsAtDate([{ asset: 'btc', amount: '0.5' }], lower, 0, null),
		]);
	});
});
