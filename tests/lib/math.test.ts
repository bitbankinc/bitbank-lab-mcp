import { describe, expect, it } from 'vitest';
import { avg, median, slidingMean, slidingStddev, stddev } from '../../lib/math.js';

describe('avg', () => {
	it('平均値を計算する', () => {
		expect(avg([1, 2, 3])).toBe(2);
	});
	it('小数を含む配列の平均', () => {
		expect(avg([1.5, 2.5])).toBe(2);
	});
	it('空配列は null を返す', () => {
		expect(avg([])).toBeNull();
	});
	it('単一要素はその値を返す', () => {
		expect(avg([42])).toBe(42);
	});
});

describe('median', () => {
	it('奇数個の中央値を計算する', () => {
		expect(median([3, 1, 2])).toBe(2);
	});
	it('偶数個は中間2値の平均を返す', () => {
		expect(median([1, 2, 3, 4])).toBe(2.5);
	});
	it('空配列は null を返す', () => {
		expect(median([])).toBeNull();
	});
	it('単一要素はその値を返す', () => {
		expect(median([5])).toBe(5);
	});
	it('ソート済みでなくても正しく計算する', () => {
		expect(median([9, 1, 5])).toBe(5);
	});
});

describe('stddev', () => {
	it('標準偏差を計算する', () => {
		const result = stddev([2, 4, 4, 4, 5, 5, 7, 9]);
		expect(result).toBeCloseTo(2.0, 0);
	});
	it('全て同じ値は 0 を返す', () => {
		expect(stddev([5, 5, 5])).toBe(0);
	});
	it('空配列は 0 を返す', () => {
		expect(stddev([])).toBe(0);
	});
	it('単一要素は 0 を返す', () => {
		expect(stddev([42])).toBe(0);
	});
	it('sample=true で標本標準偏差（n-1, Bessel）を計算する', () => {
		// [2,4,4,4,5,5,7,9]: population=2.0, sample=sqrt(32/7)≈2.138
		expect(stddev([2, 4, 4, 4, 5, 5, 7, 9], true)).toBeCloseTo(2.138, 3);
	});
	it('sample=true は population より大きい（小サンプルで過小評価を補正）', () => {
		const v = [1, 2, 3, 4, 5];
		expect(stddev(v, true)).toBeGreaterThan(stddev(v));
	});
	it('sample=true でも全て同じ値は 0 を返す', () => {
		expect(stddev([5, 5, 5], true)).toBe(0);
	});
	it('sample=true で単一要素は 0 を返す（n-1=0 ガード）', () => {
		expect(stddev([42], true)).toBe(0);
	});
	it('sample=true で空配列は 0 を返す', () => {
		expect(stddev([], true)).toBe(0);
	});
});

describe('slidingMean', () => {
	it('ウィンドウ平均を計算する', () => {
		expect(slidingMean([1, 2, 3, 4, 5], 3)).toEqual([2, 3, 4]);
	});
	it('ウィンドウ 1 は元の配列と同じ', () => {
		expect(slidingMean([1, 2, 3], 1)).toEqual([1, 2, 3]);
	});
	it('ウィンドウが配列と同じ長さの場合、単一要素を返す', () => {
		expect(slidingMean([1, 2, 3], 3)).toEqual([2]);
	});
	it('ウィンドウが配列より大きい場合、空配列を返す', () => {
		expect(slidingMean([1, 2], 3)).toEqual([]);
	});
	it('無効なウィンドウは空配列を返す', () => {
		expect(slidingMean([1, 2, 3], 0)).toEqual([]);
		expect(slidingMean([1, 2, 3], -1)).toEqual([]);
	});
});

describe('slidingStddev', () => {
	it('ウィンドウ標準偏差を計算する', () => {
		const result = slidingStddev([1, 2, 3, 4, 5], 3);
		expect(result).toHaveLength(3);
		// [1,2,3] の stddev ≈ 0.816
		expect(result[0]).toBeCloseTo(0.816, 2);
	});
	it('同じ値のウィンドウは 0 を返す', () => {
		const result = slidingStddev([5, 5, 5, 5], 2);
		for (const v of result) expect(v).toBe(0);
	});
	it('ウィンドウ 1 以下は空配列を返す', () => {
		expect(slidingStddev([1, 2, 3], 1)).toEqual([]);
		expect(slidingStddev([1, 2, 3], 0)).toEqual([]);
	});
	it('sample=true で標本標準偏差（window-1）を計算する', () => {
		const result = slidingStddev([1, 2, 3, 4, 5], 3, true);
		expect(result).toHaveLength(3);
		// [1,2,3] の sample stddev = 1.0
		expect(result[0]).toBeCloseTo(1.0, 6);
	});
	it('sample=true は各ウィンドウで population より大きい', () => {
		const v = [1, 2, 3, 4, 5];
		const pop = slidingStddev(v, 3);
		const samp = slidingStddev(v, 3, true);
		samp.forEach((s, i) => {
			expect(s).toBeGreaterThan(pop[i]);
		});
	});
	it('sample=true でも同じ値のウィンドウは 0 を返す', () => {
		const result = slidingStddev([5, 5, 5, 5], 2, true);
		for (const v of result) expect(v).toBe(0);
	});
});
