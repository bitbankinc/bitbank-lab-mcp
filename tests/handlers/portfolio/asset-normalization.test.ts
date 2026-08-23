/**
 * portfolio — API が返す asset コードの取得境界正規化（`lib/asset-code.ts`）の統合テスト。
 *
 * `portfolio/calc.ts` の各関数は「asset は小文字」を前提に JPY 判定・`prices` 検索・
 * holdings の Map キーを組んでいる。前提を担保するのは取得境界（`portfolio/fetch.ts`）だけ
 * なので、本テストは **fetch 層を通した結果を calc 層へ流す** 形で検証する。
 * calc 側に `.toLowerCase()` を撒く実装へ退行したらこのテストは意味を失うため、
 * 検証は必ず `fetchDepositWithdrawal` 経由で行うこと。
 *
 * 現行 API は小文字を返す（`docs/internal/bitbank-api-fields.md`）ので、これは防御的正規化。
 * 併せて「小文字レスポンスでは出力が変わらない」回帰ケースも固定する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	calcDepositWithdrawalSummary,
	calcPeriodNetFlow,
	calcPeriodRealizedPnl,
	calcPnl,
	reconstructHoldingsAtDate,
} from '../../../src/handlers/portfolio/calc.js';
import { fetchDepositWithdrawal } from '../../../src/handlers/portfolio/fetch.js';
import type { DepositWithdrawalData, RawTrade } from '../../../src/handlers/portfolio/types.js';
import { BitbankPrivateClient } from '../../../src/private/client.js';
import { currentPriceOnly } from '../../_flowPricing.js';
import { mockBitbankSuccess } from '../../fixtures/private-api.js';

beforeEach(() => {
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
});

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.BITBANK_API_KEY;
	delete process.env.BITBANK_API_SECRET;
});

interface DwFixture {
	cryptoDeposits?: unknown[];
	jpyDeposits?: unknown[];
	cryptoWithdrawals?: unknown[];
	jpyWithdrawals?: unknown[];
}

/**
 * `fetchDepositWithdrawal` の 4 チャネル（暗号資産 / JPY × 入金 / 出金）を
 * URL の `asset=jpy` 有無で振り分けて返す fetcher を組み、取得結果を返す。
 */
async function fetchDw(fixture: DwFixture): Promise<DepositWithdrawalData> {
	const fetcher = (async (url: string) => {
		const isJpyChannel = url.includes('asset=jpy');
		if (url.includes('deposit_history')) {
			const deposits = isJpyChannel ? (fixture.jpyDeposits ?? []) : (fixture.cryptoDeposits ?? []);
			return new Response(JSON.stringify(mockBitbankSuccess({ deposits })), { status: 200 });
		}
		const withdrawals = isJpyChannel ? (fixture.jpyWithdrawals ?? []) : (fixture.cryptoWithdrawals ?? []);
		return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals })), { status: 200 });
	}) as unknown as typeof fetch;

	const result = await fetchDepositWithdrawal(new BitbankPrivateClient({ fetcher }));
	if (!result) throw new Error('fetchDepositWithdrawal returned null');
	return result;
}

const T_DEPOSIT = 1_710_000_000_000;
const T_WITHDRAWAL = 1_710_000_100_000;

/** 大文字 asset を返す API レスポンス（JPY + 暗号資産の入出金 4 件） */
const UPPERCASE_FIXTURE: DwFixture = {
	jpyDeposits: [
		{
			uuid: 'dep-jpy-1',
			asset: 'JPY',
			amount: '1000000',
			status: 'DONE',
			found_at: T_DEPOSIT,
			confirmed_at: T_DEPOSIT,
		},
	],
	cryptoDeposits: [
		{ uuid: 'dep-doge-1', asset: 'DOGE', amount: '1000', status: 'DONE', found_at: T_DEPOSIT, confirmed_at: T_DEPOSIT },
	],
	jpyWithdrawals: [
		{ uuid: 'wd-jpy-1', asset: 'JPY', amount: '200000', fee: '550', status: 'DONE', requested_at: T_WITHDRAWAL },
	],
	cryptoWithdrawals: [
		{ uuid: 'wd-btc-1', asset: 'BTC', amount: '0.5', fee: '0.0006', status: 'DONE', requested_at: T_WITHDRAWAL },
	],
};

/** ticker 由来の価格マップ（キーは常に小文字。`lib/tickers.ts` が pair 文字列から作る） */
const PRICES = new Map<string, number>([
	['btc', 10_000_000],
	['doge', 20],
]);

/**
 * 本ファイルの検証対象は asset コードの正規化なので、価格解決は現在価格 1 経路に固定する。
 * 入出庫日価格を混ぜると、突き合わせ失敗が「大文字のまま」なのか「その日の足が無い」なのか
 * 切り分けられなくなる（入出庫日価格そのものの検証は calc.test.ts / fetch.test.ts の担当）。
 */
const FLOW_PRICING = currentPriceOnly(PRICES);

describe('取得境界での asset 正規化 — 入出金（fetch → calc）', () => {
	it('大文字 JPY の入出金が fiat として net_flow_jpy に計上される', async () => {
		const dw = await fetchDw(UPPERCASE_FIXTURE);

		// 取得境界を抜けた時点で小文字になっている
		expect(dw.deposits.map((d) => d.asset).sort()).toEqual(['doge', 'jpy']);
		expect(dw.withdrawals.map((w) => w.asset).sort()).toEqual(['btc', 'jpy']);

		const flow = calcPeriodNetFlow(dw, 0, FLOW_PRICING);

		// JPY入金 1,000,000 + DOGE入庫 1000*20 - BTC出庫 0.5*10,000,000 - JPY出金 200,000
		expect(flow.net_flow_jpy).toBe(1_000_000 + 20_000 - 5_000_000 - 200_000);
		// 出金手数料: JPY 550 + BTC 0.0006*10,000,000
		expect(flow.withdrawal_fee_jpy).toBe(550 + 6_000);
		// 正規化前は 'JPY' が「価格を引けない暗号資産」として落ち、金額も warning もずれていた
		expect(flow.unpriced_assets).toBeUndefined();
	});

	it('大文字 JPY の入出金が net_jpy_invested に正しく計上される', async () => {
		const dw = await fetchDw(UPPERCASE_FIXTURE);
		const summary = calcDepositWithdrawalSummary(dw, 10_000_000, FLOW_PRICING);

		expect(summary.total_jpy_deposited).toBe(1_000_000);
		expect(summary.total_jpy_withdrawn).toBe(200_000);
		// JPY純入金 800,000 + DOGE入庫の仮評価 20,000
		expect(summary.net_jpy_invested).toBe(820_000);
		expect(summary.crypto_deposit_count).toBe(1);
		expect(summary.crypto_deposit_estimated_jpy).toBe(20_000);
		expect(summary.crypto_withdrawal_count).toBe(1);
		expect(summary.account_return_jpy).toBe(10_000_000 - 820_000);
	});

	it('大文字 DOGE の入出庫が prices と突き合わさり unpriced_assets に載らない', async () => {
		const dw = await fetchDw({
			cryptoDeposits: [
				{
					uuid: 'dep-doge-1',
					asset: 'DOGE',
					amount: '1000',
					status: 'DONE',
					found_at: T_DEPOSIT,
					confirmed_at: T_DEPOSIT,
				},
			],
			cryptoWithdrawals: [
				{ uuid: 'wd-doge-1', asset: 'DOGE', amount: '500', fee: '0', status: 'DONE', requested_at: T_WITHDRAWAL },
			],
		});

		const flow = calcPeriodNetFlow(dw, 0, FLOW_PRICING);

		expect(flow.net_flow_jpy).toBe(1000 * 20 - 500 * 20);
		// warning の誤検知が起きないこと（PR #37 の unpriced_flow_assets 経路）
		expect(flow.unpriced_assets).toBeUndefined();
	});

	it('価格が本当に引けない資産は従来どおり unpriced_assets に載る（検知経路を潰さない）', async () => {
		const dw = await fetchDw({
			cryptoDeposits: [
				{
					uuid: 'dep-xyz-1',
					asset: 'XYZ',
					amount: '10',
					status: 'DONE',
					found_at: T_DEPOSIT,
					confirmed_at: T_DEPOSIT,
				},
			],
		});

		const flow = calcPeriodNetFlow(dw, 0, FLOW_PRICING);

		expect(flow.net_flow_jpy).toBe(0);
		// 申告も小文字（`PeriodNetFlowResult.unpriced_assets` の契約）
		expect(flow.unpriced_assets).toEqual(['xyz']);
	});
});

describe('取得境界での asset 正規化 — 損益・保有復元（fetch → calc）', () => {
	/**
	 * 買い 1 BTC @10,000,000 → 出庫 0.8 BTC（0.7994 + 手数料 0.0006）→ 売り 0.5 BTC @12,000,000。
	 * 出庫が原価按分に反映されると、売り時点の保有は 0.2 BTC しかなく原価は 2,000,000 に減る。
	 * 反映されない（＝大文字 asset がマッチしない）場合は 0.5 BTC 分の原価 5,000,000 が
	 * 引かれ、realized_pnl も cost_basis も別の値になる。
	 */
	const TRADES: RawTrade[] = [
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
			executed_at: 1_000,
		},
		{
			trade_id: 2,
			pair: 'btc_jpy',
			order_id: 2,
			side: 'sell',
			type: 'limit',
			amount: '0.5',
			price: '12000000',
			maker_taker: 'maker',
			fee_amount_base: '0',
			fee_amount_quote: '0',
			executed_at: 3_000,
		},
	];

	const UPPERCASE_BTC_WITHDRAWAL: DwFixture = {
		cryptoWithdrawals: [
			{ uuid: 'wd-btc-1', asset: 'BTC', amount: '0.7994', fee: '0.0006', status: 'DONE', requested_at: 2_000 },
		],
	};

	it('calcPnl が大文字 asset の暗号資産出庫を原価按分に反映する', async () => {
		const dw = await fetchDw(UPPERCASE_BTC_WITHDRAWAL);
		const result = calcPnl(TRADES, 'btc', dw.withdrawals);

		// 出庫後の保有 0.2 BTC（原価 2,000,000）を売り切る → 6,000,000 - 2,000,000
		expect(result.realized_pnl).toBe(4_000_000);
		expect(result.cost_basis).toBeUndefined();
		expect(result.trade_count).toBe(2);
	});

	it('calcPeriodRealizedPnl が大文字 asset の暗号資産出庫を原価按分に反映する', async () => {
		const dw = await fetchDw(UPPERCASE_BTC_WITHDRAWAL);
		const result = calcPeriodRealizedPnl(
			TRADES,
			2_500,
			'2026-01-01T00:00:00+09:00',
			'2026-08-10T00:00:00+09:00',
			dw.withdrawals,
		);

		expect(result.realized_pnl).toBe(4_000_000);
		expect(result.sell_count).toBe(1);
	});

	it('reconstructHoldingsAtDate の holdings キーが BTC / btc に割れない', async () => {
		const dw = await fetchDw({
			cryptoDeposits: [
				{
					uuid: 'dep-btc-1',
					asset: 'BTC',
					amount: '0.4',
					status: 'DONE',
					found_at: T_DEPOSIT,
					confirmed_at: T_DEPOSIT,
				},
			],
		});

		const holdings = reconstructHoldingsAtDate([{ asset: 'btc', amount: '1' }], [], T_DEPOSIT - 1, dw);

		// 期間内の入庫 0.4 BTC を巻き戻して 0.6 BTC。'BTC' の別キーが生えていないこと
		expect([...holdings.keys()]).toEqual(['btc']);
		expect(holdings.get('btc')).toBeCloseTo(0.6, 12);
	});
});

describe('取得境界での asset 正規化 — 小文字レスポンスの回帰防止', () => {
	const LOWERCASE_FIXTURE: DwFixture = {
		jpyDeposits: [
			{
				uuid: 'dep-jpy-1',
				asset: 'jpy',
				amount: '1000000',
				status: 'DONE',
				found_at: T_DEPOSIT,
				confirmed_at: T_DEPOSIT,
			},
		],
		cryptoDeposits: [
			{
				uuid: 'dep-doge-1',
				asset: 'doge',
				amount: '1000',
				status: 'DONE',
				found_at: T_DEPOSIT,
				confirmed_at: T_DEPOSIT,
			},
		],
		jpyWithdrawals: [
			{ uuid: 'wd-jpy-1', asset: 'jpy', amount: '200000', fee: '550', status: 'DONE', requested_at: T_WITHDRAWAL },
		],
		cryptoWithdrawals: [
			{ uuid: 'wd-btc-1', asset: 'btc', amount: '0.5', fee: '0.0006', status: 'DONE', requested_at: T_WITHDRAWAL },
		],
	};

	it('小文字レスポンスは取得結果が API のレコードとバイト等価', async () => {
		const dw = await fetchDw(LOWERCASE_FIXTURE);

		expect(dw.deposits).toEqual([
			...(LOWERCASE_FIXTURE.cryptoDeposits ?? []),
			...(LOWERCASE_FIXTURE.jpyDeposits ?? []),
		]);
		expect(dw.withdrawals).toEqual([
			...(LOWERCASE_FIXTURE.cryptoWithdrawals ?? []),
			...(LOWERCASE_FIXTURE.jpyWithdrawals ?? []),
		]);
	});

	it('小文字レスポンスの集計結果が大文字レスポンスと一致する', async () => {
		const lower = await fetchDw(LOWERCASE_FIXTURE);
		const upper = await fetchDw(UPPERCASE_FIXTURE);

		expect(calcPeriodNetFlow(lower, 0, FLOW_PRICING)).toEqual(calcPeriodNetFlow(upper, 0, FLOW_PRICING));
		expect(calcDepositWithdrawalSummary(lower, 10_000_000, FLOW_PRICING)).toEqual(
			calcDepositWithdrawalSummary(upper, 10_000_000, FLOW_PRICING),
		);
	});
});
