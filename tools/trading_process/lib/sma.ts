import { sma } from '../../../lib/indicators.js';

export function calculateSMA(prices: number[], period: number): number[] {
	return sma(prices, period);
}

export function getFirstValidIndex(period: number): number {
	return period - 1;
}

// クロス判定に sma[i-1] と sma[i] が要るので period から開始する（period-1 は有効だが period-2 は NaN）。
export function getSafeStartIndex(period: number): number {
	return period;
}
