import { describe, expect, it } from 'vitest';
import {
	bodyBottom,
	bodySize,
	bodyTop,
	isBearish,
	isBullish,
	lowerShadow,
	totalRange,
	upperShadow,
} from '../../lib/candle-utils.js';
import type { Candle } from '../../src/schemas.js';

function candle(open: number, high: number, low: number, close: number): Candle {
	return { open, high, low, close, timestamp: 1_000_000 };
}

describe('isBullish', () => {
	it('陽線（close > open）で true', () => {
		expect(isBullish(candle(100, 120, 90, 110))).toBe(true);
	});
	it('陰線（close < open）で false', () => {
		expect(isBullish(candle(110, 120, 90, 100))).toBe(false);
	});
	it('同値（close === open）で false', () => {
		expect(isBullish(candle(100, 120, 90, 100))).toBe(false);
	});
});

describe('isBearish', () => {
	it('陰線（close < open）で true', () => {
		expect(isBearish(candle(110, 120, 90, 100))).toBe(true);
	});
	it('陽線（close > open）で false', () => {
		expect(isBearish(candle(100, 120, 90, 110))).toBe(false);
	});
	it('同値（close === open）で false', () => {
		expect(isBearish(candle(100, 120, 90, 100))).toBe(false);
	});
});

describe('bodySize', () => {
	it('陽線の実体サイズ', () => {
		expect(bodySize(candle(100, 120, 90, 110))).toBe(10);
	});
	it('陰線の実体サイズ', () => {
		expect(bodySize(candle(110, 120, 90, 100))).toBe(10);
	});
	it('同値のとき 0', () => {
		expect(bodySize(candle(100, 120, 90, 100))).toBe(0);
	});
});

describe('bodyTop', () => {
	it('陽線では close を返す', () => {
		expect(bodyTop(candle(100, 120, 90, 110))).toBe(110);
	});
	it('陰線では open を返す', () => {
		expect(bodyTop(candle(110, 120, 90, 100))).toBe(110);
	});
});

describe('bodyBottom', () => {
	it('陽線では open を返す', () => {
		expect(bodyBottom(candle(100, 120, 90, 110))).toBe(100);
	});
	it('陰線では close を返す', () => {
		expect(bodyBottom(candle(110, 120, 90, 100))).toBe(100);
	});
});

describe('upperShadow', () => {
	it('上ヒゲの長さを計算する（陽線）', () => {
		expect(upperShadow(candle(100, 130, 90, 110))).toBe(20);
	});
	it('上ヒゲの長さを計算する（陰線）', () => {
		expect(upperShadow(candle(110, 130, 90, 100))).toBe(20);
	});
	it('上ヒゲなし（高値 === bodyTop）で 0', () => {
		expect(upperShadow(candle(100, 110, 90, 110))).toBe(0);
	});
});

describe('lowerShadow', () => {
	it('下ヒゲの長さを計算する（陽線）', () => {
		expect(lowerShadow(candle(100, 130, 80, 110))).toBe(20);
	});
	it('下ヒゲの長さを計算する（陰線）', () => {
		expect(lowerShadow(candle(110, 130, 80, 100))).toBe(20);
	});
	it('下ヒゲなし（安値 === bodyBottom）で 0', () => {
		expect(lowerShadow(candle(100, 130, 100, 110))).toBe(0);
	});
});

describe('totalRange', () => {
	it('高値と安値の差を返す', () => {
		expect(totalRange(candle(100, 150, 80, 110))).toBe(70);
	});
	it('高値と安値が同じなら 0', () => {
		expect(totalRange(candle(100, 100, 100, 100))).toBe(0);
	});
});
