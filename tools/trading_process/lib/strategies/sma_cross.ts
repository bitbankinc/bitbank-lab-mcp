import type { Candle } from '../../types.js';
import { calculateSMA } from '../sma.js';
import { describeEntryFilters, entryFilterStartIdx, isEntryBlockedBySmaRsi } from './filters.js';
import { calculateRSI } from './rsi.js';
import type { Overlay, ParamValidationResult, Signal, Strategy } from './types.js';

const DEFAULT_PARAMS: Record<string, number> = {
	short: 5,
	long: 20,
	// フィルター（0 = 無効）
	sma_filter_period: 0,
	rsi_filter_period: 0,
	rsi_filter_max: 100, // RSI < この値 の場合のみ買い（100=フィルター無効）
};

export function validateParams(params: Record<string, number>): ParamValidationResult {
	const errors: string[] = [];
	const normalized = { ...DEFAULT_PARAMS, ...params };

	if (normalized.short >= normalized.long) {
		errors.push('short must be less than long');
	}
	if (normalized.short < 2) {
		errors.push('short must be at least 2');
	}
	if (normalized.long < 3) {
		errors.push('long must be at least 3');
	}
	if (normalized.sma_filter_period < 0) {
		errors.push('sma_filter_period must be >= 0');
	}
	if (normalized.rsi_filter_period < 0) {
		errors.push('rsi_filter_period must be >= 0');
	}
	if (normalized.rsi_filter_max < 0 || normalized.rsi_filter_max > 100) {
		errors.push('rsi_filter_max must be 0-100');
	}

	return {
		valid: errors.length === 0,
		errors,
		normalizedParams: normalized,
	};
}

// SMA(long) は index >= long-1 で有効で、クロス判定に prev / curr が要るので最低 long+1 本。
function computeRequiredBarsImpl(params: Record<string, number>): number {
	const p = { ...DEFAULT_PARAMS, ...params };
	return Math.max(p.long, entryFilterStartIdx(p)) + 10;
}

export const smaCrossStrategy: Strategy = {
	name: 'SMA Crossover',
	type: 'sma_cross',
	requiredBars: computeRequiredBarsImpl(DEFAULT_PARAMS),
	defaultParams: DEFAULT_PARAMS,
	computeRequiredBars: computeRequiredBarsImpl,
	validate: validateParams,

	generate(candles: Candle[], params: Record<string, number>): Signal[] {
		const p = { ...DEFAULT_PARAMS, ...params };
		const { short: shortPeriod, long: longPeriod } = p;
		const closes = candles.map((c) => c.close);

		const smaShort = calculateSMA(closes, shortPeriod);
		const smaLong = calculateSMA(closes, longPeriod);

		const smaFilter = p.sma_filter_period > 0 ? calculateSMA(closes, p.sma_filter_period) : null;
		const rsi = p.rsi_filter_period > 0 ? calculateRSI(closes, p.rsi_filter_period) : null;

		const signals: Signal[] = [];
		const startIdx = Math.max(longPeriod, entryFilterStartIdx(p));

		for (let i = 0; i < candles.length; i++) {
			if (i < startIdx) {
				signals.push({ time: candles[i].time, action: 'hold' });
				continue;
			}

			const prevShort = smaShort[i - 1];
			const prevLong = smaLong[i - 1];
			const currShort = smaShort[i];
			const currLong = smaLong[i];

			if (Number.isNaN(prevShort) || Number.isNaN(prevLong) || Number.isNaN(currShort) || Number.isNaN(currLong)) {
				signals.push({ time: candles[i].time, action: 'hold' });
				continue;
			}

			if (prevShort <= prevLong && currShort > currLong) {
				if (isEntryBlockedBySmaRsi(i, closes, smaFilter, rsi, p.rsi_filter_max)) {
					signals.push({ time: candles[i].time, action: 'hold' });
				} else {
					const filterDesc = describeEntryFilters(p);
					signals.push({
						time: candles[i].time,
						action: 'buy',
						reason: `Golden Cross: SMA(${shortPeriod}) > SMA(${longPeriod})${filterDesc}`,
					});
				}
			}
			// デッドクロス: short が long を下抜け（エグジットなのでフィルター適用しない）
			else if (prevShort >= prevLong && currShort < currLong) {
				signals.push({
					time: candles[i].time,
					action: 'sell',
					reason: `Dead Cross: SMA(${shortPeriod}) < SMA(${longPeriod})`,
				});
			}
			// シグナルなし
			else {
				signals.push({ time: candles[i].time, action: 'hold' });
			}
		}

		return signals;
	},

	getOverlays(candles: Candle[], params: Record<string, number>): Overlay[] {
		const p = { ...DEFAULT_PARAMS, ...params };
		const { short: shortPeriod, long: longPeriod } = p;
		const closes = candles.map((c) => c.close);

		const smaShort = calculateSMA(closes, shortPeriod);
		const smaLong = calculateSMA(closes, longPeriod);

		const overlays: Overlay[] = [
			{
				type: 'line' as const,
				name: `SMA(${shortPeriod})`,
				color: '#fbbf24', // yellow（Closeの青と区別）
				data: smaShort,
			},
			{
				type: 'line' as const,
				name: `SMA(${longPeriod})`,
				color: '#ef4444', // red
				data: smaLong,
			},
		];

		if (p.sma_filter_period > 0) {
			const smaFilter = calculateSMA(closes, p.sma_filter_period);
			overlays.push({
				type: 'line' as const,
				name: `SMA${p.sma_filter_period} (filter)`,
				color: '#8b5cf6', // purple
				data: smaFilter,
				panel: 'price' as const,
			});
		}

		if (p.rsi_filter_period > 0 && p.rsi_filter_max < 100) {
			const rsi = calculateRSI(closes, p.rsi_filter_period);
			overlays.push({
				type: 'line' as const,
				name: `RSI(${p.rsi_filter_period})`,
				color: '#a78bfa',
				data: rsi,
				panel: 'indicator' as const,
			});
		}

		return overlays;
	},
};

export default smaCrossStrategy;
