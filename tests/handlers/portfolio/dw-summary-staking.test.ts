import { describe, expect, it } from 'vitest';
import {
	buildPeriodPerformance,
	calcDepositWithdrawalSummary,
	calcPeriodDWSummary,
	calcPeriodNetFlow,
	calcPeriodRealizedPnl,
	calcPnl,
	type PortfolioPerformanceContext,
} from '../../../src/handlers/portfolio/calc.js';
import type {
	DepositWithdrawalData,
	RawDeposit,
	RawTrade,
	RawWithdrawal,
} from '../../../src/handlers/portfolio/types.js';
import { currentPriceOnly, withDailyPrices } from '../../_flowPricing.js';

function makeDeposit(overrides: Partial<RawDeposit> = {}): RawDeposit {
	return { uuid: 'dep-1', asset: 'jpy', amount: '0', status: 'DONE', found_at: 0, confirmed_at: 0, ...overrides };
}

function makeWithdrawal(overrides: Partial<RawWithdrawal> = {}): RawWithdrawal {
	return { uuid: 'wd-1', asset: 'btc', amount: '0', fee: '0', status: 'DONE', requested_at: 0, ...overrides };
}

function makeTrade(overrides: Partial<RawTrade> = {}): RawTrade {
	return {
		trade_id: 1,
		pair: 'eth_jpy',
		order_id: 1,
		side: 'buy',
		type: 'limit',
		amount: '0',
		price: '0',
		maker_taker: 'maker',
		fee_amount_base: '0',
		fee_amount_quote: '0',
		executed_at: 0,
		...overrides,
	};
}

function makeDw(overrides: Partial<DepositWithdrawalData> = {}): DepositWithdrawalData {
	return { deposits: [], withdrawals: [], warnings: [], allFailed: false, isComplete: true, ...overrides };
}

const ETH_PRICE = 500_000;
const ethPricing = currentPriceOnly(new Map([['eth', ETH_PRICE]]));

describe('期間の入出金サマリーのステーキング報酬（issue 448 項目 1）', () => {
	const dw = makeDw({
		deposits: [
			makeDeposit({ uuid: 'n', asset: 'eth', amount: '1', confirmed_at: 2000 }),
			makeDeposit({ uuid: 's', asset: 'eth', amount: '0.1', category: 'STAKING', confirmed_at: 3000 }),
		],
	});

	it('ステーキング報酬の件数と換算額を内訳として出し、入庫の件数・換算額は従来どおり報酬を含む', () => {
		const summary = calcPeriodDWSummary(dw, 1000, 'start', 'end', ethPricing);
		expect(summary.crypto_deposit_count).toBe(2);
		expect(summary.crypto_deposit_estimated_jpy).toBe(550_000);
		expect(summary.staking_reward_count).toBe(1);
		expect(summary.staking_reward_estimated_jpy).toBe(50_000);
		expect(summary.staking_reward_valuation?.basis).toBe('current_price_fallback');
	});

	it('同じ期間の calcPeriodNetFlow と、報酬の額が一致する', () => {
		const summary = calcPeriodDWSummary(dw, 1000, 'start', 'end', ethPricing);
		const flow = calcPeriodNetFlow(dw, 1000, ethPricing);
		expect(flow.staking_reward_jpy).toBe(summary.staking_reward_estimated_jpy);
		expect(flow.net_flow_jpy).toBe(
			(summary.crypto_deposit_estimated_jpy ?? 0) - (summary.staking_reward_estimated_jpy ?? 0),
		);
	});

	it('期間内にステーキング報酬が無ければ、キーごと出さない', () => {
		const summary = calcPeriodDWSummary(
			makeDw({ deposits: [makeDeposit({ asset: 'eth', amount: '1', confirmed_at: 2000 })] }),
			1000,
			'start',
			'end',
			ethPricing,
		);
		expect(summary).not.toHaveProperty('staking_reward_count');
		expect(summary).not.toHaveProperty('staking_reward_estimated_jpy');
	});
});

describe('全期間サマリーの換算できない入出庫（issue 448 項目 2）', () => {
	it('換算できない入庫があると資産名を出し、account_return_* を出さない', () => {
		const dw = makeDw({
			deposits: [
				makeDeposit({ uuid: 'j', asset: 'jpy', amount: '100000', confirmed_at: 1000 }),
				makeDeposit({ uuid: 'x', asset: 'xyz', amount: '10', confirmed_at: 2000 }),
			],
		});
		const summary = calcDepositWithdrawalSummary(dw, 300_000, currentPriceOnly());
		expect(summary.net_jpy_invested).toBe(100_000);
		expect(summary.unpriced_flow_assets).toEqual(['xyz']);
		expect(summary.account_return_pct).toBeUndefined();
		expect(summary.account_return_jpy).toBeUndefined();
	});

	it('換算できない出庫も同じ扱い', () => {
		const dw = makeDw({
			deposits: [makeDeposit({ uuid: 'j', asset: 'jpy', amount: '100000', confirmed_at: 1000 })],
			withdrawals: [makeWithdrawal({ asset: 'abc', amount: '1', requested_at: 2000 })],
		});
		const summary = calcDepositWithdrawalSummary(dw, 300_000, currentPriceOnly());
		expect(summary.unpriced_flow_assets).toEqual(['abc']);
		expect(summary.account_return_pct).toBeUndefined();
	});

	it('換算できないのがステーキング報酬だけなら純投入額はずれないので、account_return_* は出す', () => {
		const dw = makeDw({
			deposits: [
				makeDeposit({ uuid: 'j', asset: 'jpy', amount: '100000', confirmed_at: 1000 }),
				makeDeposit({ uuid: 's', asset: 'xyz', amount: '1', category: 'STAKING', confirmed_at: 2000 }),
			],
		});
		const summary = calcDepositWithdrawalSummary(dw, 300_000, currentPriceOnly());
		expect(summary.unpriced_flow_assets).toBeUndefined();
		expect(summary.account_return_jpy).toBe(200_000);
	});

	it('全件換算できれば unpriced_flow_assets は出さない', () => {
		const dw = makeDw({
			deposits: [makeDeposit({ uuid: 'e', asset: 'eth', amount: '1', confirmed_at: 2000 })],
		});
		const summary = calcDepositWithdrawalSummary(dw, 600_000, ethPricing);
		expect(summary).not.toHaveProperty('unpriced_flow_assets');
		expect(summary.account_return_jpy).toBe(100_000);
	});
});

describe('期間の純入出金のステーキング報酬の部分合計（issue 448 項目 4）', () => {
	it('通常の入出庫と同じく、換算できた分の部分合計を出し、換算できない資産名を併記する', () => {
		const dw = makeDw({
			deposits: [
				makeDeposit({ uuid: 's1', asset: 'eth', amount: '0.1', category: 'STAKING', confirmed_at: 2000 }),
				makeDeposit({ uuid: 's2', asset: 'xyz', amount: '5', category: 'STAKING', confirmed_at: 3000 }),
				makeDeposit({ uuid: 'n', asset: 'abc', amount: '1', confirmed_at: 4000 }),
			],
		});
		const flow = calcPeriodNetFlow(dw, 1000, ethPricing);
		expect(flow.net_flow_jpy).toBe(0);
		expect(flow.unpriced_assets).toEqual(['abc']);
		expect(flow.staking_reward_jpy).toBe(50_000);
		expect(flow.staking_reward_unpriced_assets).toEqual(['xyz']);
	});
});

describe('期初の保有の負の残高（issue 448 項目 5）', () => {
	function makeCtx(overrides: Partial<PortfolioPerformanceContext> = {}): PortfolioPerformanceContext {
		return {
			currentHoldings: [],
			trades: [],
			dwData: makeDw(),
			candlePriceData: { boundaryPrices: new Map(), dailyPrices: new Map() },
			flowPricing: currentPriceOnly(),
			currentValue: 0,
			nowIso: '2026-05-16T12:00:00+09:00',
			...overrides,
		};
	}

	it('巻き戻しで負になった資産を negative_start_assets に出す（黙って消さない）', () => {
		// 現在 0.5 BTC、期間中に 1 BTC を買った（それ以前の入庫が履歴から欠けている）→ 期初は -0.5 BTC。
		const ctx = makeCtx({
			currentHoldings: [
				{ asset: 'btc', amount: '0.5' },
				{ asset: 'jpy', amount: '0' },
			],
			trades: [makeTrade({ pair: 'btc_jpy', side: 'buy', amount: '1', price: '10000000', executed_at: 5000 })],
			candlePriceData: {
				boundaryPrices: new Map([['btc', { monthStart: 10_000_000 }]]),
				dailyPrices: new Map(),
			},
			flowPricing: currentPriceOnly(new Map([['btc', 10_000_000]])),
			currentValue: 5_000_000,
		});
		const result = buildPeriodPerformance({ key: 'monthly', startMs: 1000, startIso: 's' }, ctx);
		expect(result.negative_start_assets).toEqual(['btc']);
		expect(result.start_value_jpy).toBe(10_000_000);
	});

	it('負にならなければ出さない（浮動小数点の誤差程度は負とみなさない）', () => {
		const ctx = makeCtx({
			currentHoldings: [{ asset: 'eth', amount: '0.3' }],
			trades: [
				makeTrade({ side: 'buy', amount: '0.1', price: '500000', executed_at: 5000 }),
				makeTrade({ trade_id: 2, side: 'buy', amount: '0.2', price: '500000', executed_at: 6000 }),
			],
			flowPricing: ethPricing,
			currentValue: 150_000,
		});
		const result = buildPeriodPerformance({ key: 'monthly', startMs: 1000, startIso: 's' }, ctx);
		expect(result).not.toHaveProperty('negative_start_assets');
	});
});

describe('同じ時刻のイベントの処理順（issue 448 項目 6）', () => {
	const T = Date.UTC(2026, 4, 16, 1, 0, 0, 0);
	const pricing = withDailyPrices([{ asset: 'eth', atMs: T, price: 500_000 }], new Map([['eth', 600_000]]));
	const deposit = makeDeposit({ asset: 'eth', amount: '1', confirmed_at: T });
	const sell = makeTrade({ side: 'sell', amount: '1', price: '600000', executed_at: T });

	it('calcPnl: 入庫と同時刻の売りは、入庫の原価で実現損益を出す（原価ゼロの売りにしない）', () => {
		const res = calcPnl([sell], 'eth', [], { deposits: [deposit], pricing });
		expect(res.realized_pnl).toBe(100_000);
		expect(res.qty_clamp_count).toBe(0);
	});

	it('calcPeriodRealizedPnl も同じ順で処理する', () => {
		const res = calcPeriodRealizedPnl([sell], 0, 's', 'e', [], { deposits: [deposit], pricing });
		expect(res.realized_pnl).toBe(100_000);
		expect(res.qty_clamp_count).toBe(0);
	});
});
