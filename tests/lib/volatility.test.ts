import { describe, expect, it } from 'vitest';
import {
	componentMeanToVol,
	garmanKlassComponents,
	logReturns,
	parkinsonComponents,
	rogersSatchellComponents,
} from '../../lib/volatility.js';

describe('logReturns', () => {
	it('対数リターンを計算する', () => {
		const closes = [100, 110, 105];
		const result = logReturns(closes, true);
		expect(result).toHaveLength(2);
		expect(result[0]).toBeCloseTo(Math.log(110 / 100), 10);
		expect(result[1]).toBeCloseTo(Math.log(105 / 110), 10);
	});

	it('単純リターンを計算する（useLog=false）', () => {
		const closes = [100, 110, 105];
		const result = logReturns(closes, false);
		expect(result).toHaveLength(2);
		expect(result[0]).toBeCloseTo(0.1, 10); // (110-100)/100
		expect(result[1]).toBeCloseTo(-5 / 110, 10); // (105-110)/110
	});

	it('空配列は空配列を返す', () => {
		expect(logReturns([], true)).toEqual([]);
	});

	it('1 要素は空配列を返す', () => {
		expect(logReturns([100], true)).toEqual([]);
	});

	it('ゼロ価格は 0 を返す', () => {
		const result = logReturns([0, 100], true);
		expect(result[0]).toBe(0);
	});
});

describe('parkinsonComponents', () => {
	it('(ln(H/L))^2 を計算する', () => {
		const highs = [110, 120];
		const lows = [100, 100];
		const result = parkinsonComponents(highs, lows);
		expect(result).toHaveLength(2);
		expect(result[0]).toBeCloseTo(Math.log(110 / 100) ** 2, 10);
		expect(result[1]).toBeCloseTo(Math.log(120 / 100) ** 2, 10);
	});

	it('H=L のとき 0', () => {
		const result = parkinsonComponents([100], [100]);
		expect(result[0]).toBeCloseTo(0, 10);
	});

	it('空配列は空配列を返す', () => {
		expect(parkinsonComponents([], [])).toEqual([]);
	});
});

describe('garmanKlassComponents', () => {
	it('GK コンポーネントを計算する', () => {
		const opens = [100];
		const highs = [110];
		const lows = [95];
		const closes = [105];
		const result = garmanKlassComponents(opens, highs, lows, closes);
		expect(result).toHaveLength(1);
		const logHL = Math.log(110 / 95);
		const logCO = Math.log(105 / 100);
		const expected = 0.5 * logHL * logHL - (2 * Math.log(2) - 1) * logCO * logCO;
		expect(result[0]).toBeCloseTo(expected, 10);
	});
});

describe('rogersSatchellComponents', () => {
	it('RS コンポーネントを計算する', () => {
		const opens = [100];
		const highs = [110];
		const lows = [95];
		const closes = [105];
		const result = rogersSatchellComponents(opens, highs, lows, closes);
		expect(result).toHaveLength(1);
		const expected = Math.log(110 / 105) * Math.log(110 / 100) + Math.log(95 / 105) * Math.log(95 / 100);
		expect(result[0]).toBeCloseTo(expected, 10);
	});
});

describe('componentMeanToVol', () => {
	it('Parkinson: sqrt(mean / (4*ln2))', () => {
		const mean = 0.04;
		const expected = Math.sqrt(mean / (4 * Math.log(2)));
		expect(componentMeanToVol(mean, 'parkinson')).toBeCloseTo(expected, 10);
	});

	it('Garman-Klass: sqrt(mean)', () => {
		const mean = 0.04;
		expect(componentMeanToVol(mean, 'garmanKlass')).toBeCloseTo(Math.sqrt(mean), 10);
	});

	it('Rogers-Satchell: sqrt(mean)', () => {
		const mean = 0.04;
		expect(componentMeanToVol(mean, 'rogersSatchell')).toBeCloseTo(Math.sqrt(mean), 10);
	});

	it('負の値は 0 を返す', () => {
		expect(componentMeanToVol(-0.01, 'parkinson')).toBe(0);
		expect(componentMeanToVol(-0.01, 'garmanKlass')).toBe(0);
	});
});
