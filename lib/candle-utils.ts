import type { Candle } from '../src/schemas.js';

export function isBullish(c: Candle): boolean {
	return c.close > c.open;
}

export function isBearish(c: Candle): boolean {
	return c.close < c.open;
}

export function bodySize(c: Candle): number {
	return Math.abs(c.close - c.open);
}

export function bodyTop(c: Candle): number {
	return Math.max(c.open, c.close);
}

export function bodyBottom(c: Candle): number {
	return Math.min(c.open, c.close);
}

export function upperShadow(c: Candle): number {
	return c.high - bodyTop(c);
}

export function lowerShadow(c: Candle): number {
	return bodyBottom(c) - c.low;
}

export function totalRange(c: Candle): number {
	return c.high - c.low;
}
