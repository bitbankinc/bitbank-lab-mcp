import { describe, expect, it } from 'vitest';
import { calculateSMA, getFirstValidIndex, getSafeStartIndex } from '../../../tools/trading_process/lib/sma.js';

describe('calculateSMA', () => {
	it('基本的な SMA 計算', () => {
		const prices = [100, 102, 104, 103, 105];
		const result = calculateSMA(prices, 3);
		expect(result).toHaveLength(5);
		expect(result[0]).toBeNaN();
		expect(result[1]).toBeNaN();
		// result[2] = (100 + 102 + 104) / 3 = 102
		expect(result[2]).toBeCloseTo(102, 5);
		// result[3] = (102 + 104 + 103) / 3 = 103
		expect(result[3]).toBeCloseTo(103, 5);
		// result[4] = (104 + 103 + 105) / 3 = 104
		expect(result[4]).toBeCloseTo(104, 5);
	});

	it('period=1 の場合は元の値と同じ', () => {
		const prices = [10, 20, 30];
		const result = calculateSMA(prices, 1);
		expect(result[0]).toBeCloseTo(10, 5);
		expect(result[1]).toBeCloseTo(20, 5);
		expect(result[2]).toBeCloseTo(30, 5);
	});

	it('period = 配列長の場合は最後の 1 つだけ有効', () => {
		const prices = [10, 20, 30];
		const result = calculateSMA(prices, 3);
		expect(result[0]).toBeNaN();
		expect(result[1]).toBeNaN();
		expect(result[2]).toBeCloseTo(20, 5); // (10+20+30)/3 = 20
	});

	it('空配列は空を返す', () => {
		expect(calculateSMA([], 3)).toEqual([]);
	});
});

describe('getFirstValidIndex', () => {
	it('period - 1 を返す', () => {
		expect(getFirstValidIndex(3)).toBe(2);
		expect(getFirstValidIndex(10)).toBe(9);
		expect(getFirstValidIndex(1)).toBe(0);
	});
});

describe('getSafeStartIndex', () => {
	it('period を返す', () => {
		expect(getSafeStartIndex(3)).toBe(3);
		expect(getSafeStartIndex(10)).toBe(10);
		expect(getSafeStartIndex(1)).toBe(1);
	});
});
