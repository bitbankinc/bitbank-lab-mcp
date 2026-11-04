import { describe, expect, it } from 'vitest';
import { priceDecimals, roundAtDecimalDigits, roundPriceAtLevel } from '../../lib/price.js';

describe('priceDecimals', () => {
	it('10 万円以上は小数 0 桁', () => {
		expect(priceDecimals(100_000)).toBe(0);
		expect(priceDecimals(15_234_567)).toBe(0);
	});

	it('価格が 1 桁下がるごとに小数が 1 桁増える', () => {
		expect(priceDecimals(99_999)).toBe(1);
		expect(priceDecimals(1_234)).toBe(2);
		expect(priceDecimals(1)).toBe(5);
		expect(priceDecimals(0.5)).toBe(6);
		expect(priceDecimals(0.05)).toBe(7);
	});

	it('負の値は絶対値の水準で決める', () => {
		expect(priceDecimals(-0.05)).toBe(priceDecimals(0.05));
	});

	it('0 / NaN / Infinity は 0 桁', () => {
		expect(priceDecimals(0)).toBe(0);
		expect(priceDecimals(Number.NaN)).toBe(0);
		expect(priceDecimals(Number.POSITIVE_INFINITY)).toBe(0);
	});

	it('極端に小さい値でも 12 桁で止める', () => {
		expect(priceDecimals(1e-20)).toBe(12);
	});
});

describe('roundAtDecimalDigits', () => {
	it('2 進の乗算誤差で半刻みを取りこぼさない', () => {
		expect(roundAtDecimalDigits(1.005, 2)).toBe(1.01);
	});

	it('0 桁は Math.round と同じ（負の半刻みは +∞ 方向）', () => {
		expect(roundAtDecimalDigits(15_234_567.5, 0)).toBe(15_234_568);
		expect(roundAtDecimalDigits(-2.5, 0)).toBe(-2);
	});
});

describe('roundPriceAtLevel', () => {
	it('10 万円以上では Math.round と一致する', () => {
		for (const v of [100_000.4, 100_000.5, 9_999_999.49, 15_234_567.6, 123_456_789.5]) {
			expect(roundPriceAtLevel(v)).toBe(Math.round(v));
		}
	});

	it('1 円未満の価格は 0 や 1 に潰さず有効数字 6 桁で丸める', () => {
		expect(roundPriceAtLevel(0.0512345678)).toBe(0.0512346);
		expect(roundPriceAtLevel(0.987654321)).toBe(0.987654);
	});

	it('値幅は値幅自体ではなく価格の水準で桁を決める', () => {
		// 値幅 0.00123456 だけで決めると 8 桁になるが、価格 0.05 の水準（7 桁）にそろえる。
		expect(roundPriceAtLevel(0.00123456, 0.05)).toBe(0.0012346);
	});

	it('minDecimals より桁を減らさない', () => {
		expect(roundPriceAtLevel(15_234_567.678, 15_234_567.678, 2)).toBe(15_234_567.68);
	});

	it('有限でない値はそのまま返す', () => {
		expect(roundPriceAtLevel(Number.NaN)).toBeNaN();
		expect(roundPriceAtLevel(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
	});
});
