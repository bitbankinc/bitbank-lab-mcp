import { describe, expect, it } from 'vitest';
import {
	clamp01,
	linearRegression,
	linearRegressionWithR2,
	marginFromRelDev,
	near,
	relDev,
	trendlineFit,
} from '../../tools/patterns/regression.js';

describe('linearRegression', () => {
	it('空配列は slope=0, intercept=0 を返す', () => {
		const result = linearRegression([]);
		expect(result.slope).toBe(0);
		expect(result.intercept).toBe(0);
	});

	it('単一点は slope=0 を返す', () => {
		const result = linearRegression([{ idx: 5, price: 100 }]);
		expect(result.slope).toBe(0);
		expect(result.intercept).toBe(100);
	});

	it('完全な直線を正しく回帰する', () => {
		// y = 2x + 10
		const points = [
			{ idx: 0, price: 10 },
			{ idx: 1, price: 12 },
			{ idx: 2, price: 14 },
			{ idx: 3, price: 16 },
		];
		const result = linearRegression(points);
		expect(result.slope).toBeCloseTo(2, 10);
		expect(result.intercept).toBeCloseTo(10, 10);
	});

	it('ノイズのあるデータでも近似する', () => {
		const points = [
			{ idx: 0, price: 10 },
			{ idx: 1, price: 13 },
			{ idx: 2, price: 14 },
			{ idx: 3, price: 17 },
		];
		const result = linearRegression(points);
		expect(result.slope).toBeGreaterThan(1.5);
		expect(result.slope).toBeLessThan(3);
	});
});

describe('trendlineFit', () => {
	it('空配列は 0 を返す', () => {
		expect(trendlineFit([], { slope: 1, intercept: 0 })).toBe(0);
	});

	it('完全にフィットする場合は 1 を返す', () => {
		const line = { slope: 2, intercept: 10 };
		const points = [
			{ idx: 0, price: 10 },
			{ idx: 1, price: 12 },
			{ idx: 2, price: 14 },
		];
		expect(trendlineFit(points, line)).toBeCloseTo(1, 5);
	});

	it('全くフィットしない場合は低い値を返す', () => {
		const line = { slope: 0, intercept: 100 };
		const points = [
			{ idx: 0, price: 1 },
			{ idx: 1, price: 2 },
			{ idx: 2, price: 3 },
		];
		const fit = trendlineFit(points, line);
		expect(fit).toBeLessThan(0.5);
	});
});

describe('linearRegressionWithR2', () => {
	it('2点未満は全てゼロを返す', () => {
		const result = linearRegressionWithR2([]);
		expect(result.slope).toBe(0);
		expect(result.intercept).toBe(0);
		expect(result.r2).toBe(0);
		expect(result.valueAt(5)).toBe(0);
	});

	it('1点のみでもゼロを返す', () => {
		const result = linearRegressionWithR2([{ x: 1, y: 10 }]);
		expect(result.r2).toBe(0);
	});

	it('完全な直線は R2=1 を返す', () => {
		const points = [
			{ x: 0, y: 10 },
			{ x: 1, y: 20 },
			{ x: 2, y: 30 },
			{ x: 3, y: 40 },
		];
		const result = linearRegressionWithR2(points);
		expect(result.slope).toBeCloseTo(10, 5);
		expect(result.intercept).toBeCloseTo(10, 5);
		expect(result.r2).toBeCloseTo(1, 5);
		expect(result.valueAt(4)).toBeCloseTo(50, 5);
	});

	it('全て同じ y 値の場合は R2=0', () => {
		const points = [
			{ x: 0, y: 5 },
			{ x: 1, y: 5 },
			{ x: 2, y: 5 },
		];
		const result = linearRegressionWithR2(points);
		expect(result.r2).toBe(0);
		expect(result.slope).toBeCloseTo(0, 10);
	});
});

describe('near', () => {
	it('同じ値は true', () => {
		expect(near(100, 100, 0.01)).toBe(true);
	});

	it('許容範囲内は true', () => {
		expect(near(100, 101, 0.02)).toBe(true);
	});

	it('許容範囲外は false', () => {
		expect(near(100, 110, 0.01)).toBe(false);
	});

	it('ゼロ同士は true', () => {
		expect(near(0, 0, 0.01)).toBe(true);
	});
});

describe('clamp01', () => {
	it('範囲内の値はそのまま', () => {
		expect(clamp01(0.5)).toBe(0.5);
	});

	it('負の値は 0 にクランプ', () => {
		expect(clamp01(-1)).toBe(0);
	});

	it('1 を超える値は 1 にクランプ', () => {
		expect(clamp01(2)).toBe(1);
	});

	it('境界値 0 と 1', () => {
		expect(clamp01(0)).toBe(0);
		expect(clamp01(1)).toBe(1);
	});
});

describe('relDev', () => {
	it('同じ値は 0', () => {
		expect(relDev(100, 100)).toBe(0);
	});

	it('異なる値で相対偏差を計算', () => {
		expect(relDev(100, 110)).toBeCloseTo(10 / 110, 10);
	});

	it('順序は関係ない', () => {
		expect(relDev(100, 110)).toBe(relDev(110, 100));
	});
});

describe('marginFromRelDev', () => {
	it('偏差ゼロは 1 を返す', () => {
		expect(marginFromRelDev(0, 0.05)).toBe(1);
	});

	it('偏差が許容値と等しい場合は 0', () => {
		expect(marginFromRelDev(0.05, 0.05)).toBeCloseTo(0, 10);
	});

	it('偏差が許容値を超える場合は 0 にクランプ', () => {
		expect(marginFromRelDev(0.1, 0.05)).toBe(0);
	});

	it('中間値', () => {
		const result = marginFromRelDev(0.025, 0.05);
		expect(result).toBeCloseTo(0.5, 10);
	});
});
