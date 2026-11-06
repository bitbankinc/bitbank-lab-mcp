// 入金種別 STAKING（ステーキング報酬）は元本ではなく成果。数量と取得原価は他の入庫と同じに扱い、純入出金・純投入額・フローマーカーからだけ外す。
import { describe, expect, it } from 'vitest';
import { dayjs } from '../../../lib/datetime.js';
import {
	buildEquitySeries,
	buildPeriodPerformance,
	calcDepositWithdrawalSummary,
	calcPeriodNetFlow,
	isStakingReward,
	type PortfolioPerformanceContext,
	reconstructHoldingsAtDate,
} from '../../../src/handlers/portfolio/calc.js';
import { PORTFOLIO_CALENDAR_TZ } from '../../../src/handlers/portfolio/calendar.js';
import type { DepositWithdrawalData, RawDeposit } from '../../../src/handlers/portfolio/types.js';
import { currentPriceOnly } from '../../_flowPricing.js';
import { jstMs } from '../../helpers/time.js';

function deposit(overrides: Partial<RawDeposit> = {}): RawDeposit {
	return { uuid: 'dep-1', asset: 'eth', amount: '0', status: 'DONE', found_at: 0, confirmed_at: 0, ...overrides };
}

function dwOf(deposits: RawDeposit[]): DepositWithdrawalData {
	return { deposits, withdrawals: [], warnings: [], allFailed: false, isComplete: true };
}

const AT = jstMs(2026, 8, 2, 10);
const ETH_PRICE = new Map([['eth', 400_000]]);

describe('isStakingReward', () => {
	it.each([
		['STAKING', true],
		['NORMAL', false],
		['MANUAL', false],
		[undefined, false],
	])('category=%s → %s', (category, expected) => {
		expect(isStakingReward(deposit({ category }))).toBe(expected);
	});
});

describe('calcPeriodNetFlow — ステーキング報酬', () => {
	it('net_flow_jpy に入れず、staking_reward_jpy に別出しする（flow_valuation にも数えない）', () => {
		const dw = dwOf([
			deposit({ uuid: 'jpy', asset: 'jpy', amount: '100000', category: 'NORMAL', confirmed_at: AT }),
			deposit({ uuid: 'eth-normal', amount: '0.5', category: 'NORMAL', confirmed_at: AT }),
			deposit({ uuid: 'eth-staking', amount: '1', category: 'STAKING', confirmed_at: AT }),
		]);
		const result = calcPeriodNetFlow(dw, AT - 1, currentPriceOnly(ETH_PRICE));

		expect(result.net_flow_jpy).toBe(100_000 + 200_000);
		expect(result.staking_reward_jpy).toBe(400_000);
		expect(result.valuation?.current_price_fallback_count).toBe(1);
		expect(result.staking_reward_unpriced_assets).toBeUndefined();
	});

	it('ステーキング報酬が無ければキーごと出さない', () => {
		const dw = dwOf([deposit({ amount: '1', category: 'NORMAL', confirmed_at: AT })]);
		const result = calcPeriodNetFlow(dw, AT - 1, currentPriceOnly(ETH_PRICE));

		expect('staking_reward_jpy' in result).toBe(false);
		expect('staking_reward_unpriced_assets' in result).toBe(false);
	});

	it('category を返さない入庫は従来どおり元本として数える', () => {
		const dw = dwOf([deposit({ amount: '1', confirmed_at: AT })]);
		const result = calcPeriodNetFlow(dw, AT - 1, currentPriceOnly(ETH_PRICE));

		expect(result.net_flow_jpy).toBe(400_000);
		expect('staking_reward_jpy' in result).toBe(false);
	});

	it('1 件でも換算できなければ額を出さず資産名を申告する。純入出金には影響しない', () => {
		const dw = dwOf([
			deposit({ uuid: 'eth-staking', amount: '1', category: 'STAKING', confirmed_at: AT }),
			deposit({ uuid: 'dot-staking', asset: 'dot', amount: '3', category: 'STAKING', confirmed_at: AT }),
		]);
		const result = calcPeriodNetFlow(dw, AT - 1, currentPriceOnly(ETH_PRICE));

		expect(result.staking_reward_jpy).toBeUndefined();
		expect(result.staking_reward_unpriced_assets).toEqual(['dot']);
		expect(result.net_flow_jpy).toBe(0);
		expect(result.unpriced_assets).toBeUndefined();
	});

	it('期間外・DONE 以外の報酬は数えない', () => {
		const dw = dwOf([
			deposit({ uuid: 'before', amount: '1', category: 'STAKING', confirmed_at: AT - 10 }),
			deposit({ uuid: 'pending', amount: '1', category: 'STAKING', status: 'CONFIRMED', confirmed_at: AT }),
		]);
		const result = calcPeriodNetFlow(dw, AT - 1, currentPriceOnly(ETH_PRICE));

		expect('staking_reward_jpy' in result).toBe(false);
	});
});

describe('buildPeriodPerformance — ステーキング報酬は成果として adjusted_change_jpy に残る', () => {
	function ctxWith(dwData: DepositWithdrawalData, ethHeld: string, currentValue: number): PortfolioPerformanceContext {
		return {
			currentHoldings: [{ asset: 'eth', amount: ethHeld }],
			trades: [],
			dwData,
			candlePriceData: { boundaryPrices: new Map([['eth', { yearStart: 300_000 }]]), dailyPrices: new Map() },
			flowPricing: currentPriceOnly(ETH_PRICE),
			currentValue,
			nowIso: '2026-08-04T12:00:00+09:00',
		};
	}

	it('元本の入庫は差し引き、報酬は差し引かない', () => {
		const dw = dwOf([
			deposit({ uuid: 'eth-normal', amount: '1', category: 'NORMAL', confirmed_at: AT }),
			deposit({ uuid: 'eth-staking', amount: '1', category: 'STAKING', confirmed_at: AT }),
		]);
		const result = buildPeriodPerformance(
			{ key: 'yearly', startMs: AT - 1, startIso: '2026-01-01T00:00:00+09:00' },
			ctxWith(dw, '2', 800_000),
		);

		expect(result.start_value_jpy).toBe(0);
		expect(result.change_jpy).toBe(800_000);
		expect(result.net_flow_jpy).toBe(400_000);
		expect(result.adjusted_change_jpy).toBe(400_000);
		expect(result.staking_reward_jpy).toBe(400_000);
	});

	it('報酬の数量は期初の保有の復元で巻き戻す（取得の経路としては他の入庫と同じ）', () => {
		const dw = dwOf([deposit({ amount: '1', category: 'STAKING', confirmed_at: AT })]);
		expect(reconstructHoldingsAtDate([{ asset: 'eth', amount: '1.5' }], [], AT - 1, dw).get('eth')).toBe(0.5);
	});
});

describe('buildEquitySeries — ステーキング報酬にはフローマーカーを立てない', () => {
	const dates = [1, 2, 3].map((d) => dayjs(jstMs(2026, 8, d)).tz(PORTFOLIO_CALENDAR_TZ));
	const build = (category: string) =>
		buildEquitySeries(
			dates,
			[{ asset: 'eth', amount: '1' }],
			[],
			dwOf([deposit({ amount: '1', category, confirmed_at: AT })]),
			new Map(),
			400_000,
			'2026-08-04T12:00:00+09:00',
			ETH_PRICE,
			currentPriceOnly(ETH_PRICE),
		);

	it('NORMAL の入庫には立つ（対照）', () => {
		expect(build('NORMAL').map((p) => p.flow_jpy)).toEqual([undefined, 400_000, undefined, undefined]);
	});

	it('STAKING の入庫には立たず、評価額の増分は市場変動の側に残る', () => {
		const series = build('STAKING');
		expect(series.map((p) => p.flow_jpy)).toEqual([undefined, undefined, undefined, undefined]);
		expect(series.map((p) => p.value_jpy)).toEqual([0, 0, 400_000, 400_000]);
	});
});

describe('calcDepositWithdrawalSummary — ステーキング報酬', () => {
	it('入庫の件数・評価額には含めたまま、純投入額からだけ除く', () => {
		const dw = dwOf([
			deposit({ uuid: 'jpy', asset: 'jpy', amount: '1000000', category: 'NORMAL' }),
			deposit({ uuid: 'eth-staking', amount: '1', category: 'STAKING' }),
		]);
		const summary = calcDepositWithdrawalSummary(dw, 1_500_000, currentPriceOnly(ETH_PRICE));

		expect(summary.crypto_deposit_count).toBe(1);
		expect(summary.crypto_deposit_estimated_jpy).toBe(400_000);
		expect(summary.staking_reward_count).toBe(1);
		expect(summary.staking_reward_estimated_jpy).toBe(400_000);
		expect(summary.staking_reward_valuation).toEqual({
			deposit_date_price_count: 0,
			current_price_fallback_count: 1,
			basis: 'current_price_fallback',
		});
		expect(summary.net_jpy_invested).toBe(1_000_000);
		expect(summary.account_return_jpy).toBe(500_000);
	});

	it('一部の報酬だけ価格を解決できたとき、件数は全件・換算の内訳は解決できた分だけを数える', () => {
		const dw = dwOf([
			deposit({ uuid: 'eth-staking', amount: '1', category: 'STAKING' }),
			deposit({ uuid: 'dot-staking', asset: 'dot', amount: '3', category: 'STAKING' }),
		]);
		const summary = calcDepositWithdrawalSummary(dw, 400_000, currentPriceOnly(ETH_PRICE));

		expect(summary.staking_reward_count).toBe(2);
		expect(summary.staking_reward_estimated_jpy).toBe(400_000);
		expect(summary.staking_reward_valuation?.current_price_fallback_count).toBe(1);
		expect(summary.net_jpy_invested).toBe(0);
	});

	it('ステーキング報酬が無ければキーごと出さない', () => {
		const dw = dwOf([deposit({ amount: '1', category: 'NORMAL' })]);
		const summary = calcDepositWithdrawalSummary(dw, 400_000, currentPriceOnly(ETH_PRICE));

		expect('staking_reward_count' in summary).toBe(false);
		expect('staking_reward_estimated_jpy' in summary).toBe(false);
		expect(summary.net_jpy_invested).toBe(400_000);
	});
});
