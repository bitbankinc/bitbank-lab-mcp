import { describe, expect, it } from 'vitest';
import {
	describeEntryFilters,
	entryFilterStartIdx,
	isEntryBlockedBySmaRsi,
} from '../../../../tools/trading_process/lib/strategies/filters.js';

const NO_FILTER = { sma_filter_period: 0, rsi_filter_period: 0, rsi_filter_max: 100 };

describe('describeEntryFilters', () => {
	it('フィルタが無ければ空文字', () => {
		expect(describeEntryFilters(NO_FILTER)).toBe('');
	});

	it('SMA → 戦略固有 → RSI の順に並べる', () => {
		const p = { sma_filter_period: 20, rsi_filter_period: 14, rsi_filter_max: 70 };
		expect(describeEntryFilters(p, ['zero-line: above only'])).toBe(
			' [SMA20 trend filter, zero-line: above only, RSI(14)<70]',
		);
	});

	it('RSI は期間があっても上限が 100 なら出さない', () => {
		expect(describeEntryFilters({ ...NO_FILTER, rsi_filter_period: 14 })).toBe('');
	});
});

describe('entryFilterStartIdx', () => {
	it('SMA は period - 1、RSI は period + 1 本目から使え、大きい方を返す', () => {
		expect(entryFilterStartIdx(NO_FILTER)).toBe(0);
		expect(entryFilterStartIdx({ ...NO_FILTER, sma_filter_period: 20 })).toBe(19);
		expect(entryFilterStartIdx({ ...NO_FILTER, rsi_filter_period: 14 })).toBe(15);
		expect(entryFilterStartIdx({ ...NO_FILTER, sma_filter_period: 10, rsi_filter_period: 14 })).toBe(15);
	});
});

describe('isEntryBlockedBySmaRsi', () => {
	const closes = [100, 100, 100];

	it('終値が SMA を下回ると止める（同値は止めない）', () => {
		expect(isEntryBlockedBySmaRsi(0, closes, [101, 100, 100], null, 100)).toBe(true);
		expect(isEntryBlockedBySmaRsi(1, closes, [101, 100, 100], null, 100)).toBe(false);
	});

	it('RSI が上限以上なら止める', () => {
		expect(isEntryBlockedBySmaRsi(0, closes, null, [70, 69.9, 0], 70)).toBe(true);
		expect(isEntryBlockedBySmaRsi(1, closes, null, [70, 69.9, 0], 70)).toBe(false);
	});

	it('NaN の指標とフィルタ無し（null）は止めない', () => {
		expect(isEntryBlockedBySmaRsi(2, closes, [0, 0, Number.NaN], [0, 0, Number.NaN], 70)).toBe(false);
		expect(isEntryBlockedBySmaRsi(0, closes, null, null, 0)).toBe(false);
	});
});
