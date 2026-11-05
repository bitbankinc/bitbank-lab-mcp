// zero_line_filter は -1 = ゼロ以下のみ、0 = なし、1 = ゼロ以上のみ。

import { macd as sharedMacd } from '../../../../lib/indicators.js';
import type { Candle } from '../../types.js';
import { calculateSMA } from '../sma.js';
import { describeEntryFilters, entryFilterStartIdx, isEntryBlockedBySmaRsi } from './filters.js';
import { calculateRSI } from './rsi.js';
import type { Overlay, ParamValidationResult, Signal, Strategy } from './types.js';

const DEFAULT_PARAMS: Record<string, number> = {
	fast: 12,
	slow: 26,
	signal: 9,
	// フィルター（0 = 無効）
	sma_filter_period: 0,
	zero_line_filter: 0, // -1=below zero only, 0=none, 1=above zero only
	rsi_filter_period: 0,
	rsi_filter_max: 100, // RSI < この値 の場合のみ買い（100=フィルター無効）
};

function calculateMACD(
	closes: number[],
	fastPeriod: number,
	slowPeriod: number,
	signalPeriod: number,
): { macd: number[]; signal: number[]; histogram: number[] } {
	const result = sharedMacd(closes, fastPeriod, slowPeriod, signalPeriod);
	return { macd: result.line, signal: result.signal, histogram: result.hist };
}

export function validateParams(params: Record<string, number>): ParamValidationResult {
	const errors: string[] = [];
	const normalized = { ...DEFAULT_PARAMS, ...params };

	if (normalized.fast >= normalized.slow) {
		errors.push('fast period must be less than slow period');
	}
	if (normalized.fast < 2) {
		errors.push('fast period must be at least 2');
	}
	if (normalized.signal < 2) {
		errors.push('signal period must be at least 2');
	}
	if (normalized.sma_filter_period < 0) {
		errors.push('sma_filter_period must be >= 0');
	}
	if (![-1, 0, 1].includes(normalized.zero_line_filter)) {
		errors.push('zero_line_filter must be -1, 0, or 1');
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

function zeroLineFilterParts(params: Record<string, number>): string[] {
	if (params.zero_line_filter === 1) return ['zero-line: above only'];
	if (params.zero_line_filter === -1) return ['zero-line: below only'];
	return [];
}

// signal 線は index >= slow + signal - 2 で有効で、クロス判定に prev / curr が要るので最低 slow + signal 本。
function computeRequiredBarsImpl(params: Record<string, number>): number {
	const p = { ...DEFAULT_PARAMS, ...params };
	return Math.max(p.slow + p.signal, entryFilterStartIdx(p));
}

export const macdCrossStrategy: Strategy = {
	name: 'MACD Crossover',
	type: 'macd_cross',
	requiredBars: computeRequiredBarsImpl(DEFAULT_PARAMS),
	defaultParams: DEFAULT_PARAMS,
	computeRequiredBars: computeRequiredBarsImpl,
	validate: validateParams,

	generate(candles: Candle[], params: Record<string, number>): Signal[] {
		const p = { ...DEFAULT_PARAMS, ...params };
		const { fast, slow, signal: signalPeriod } = p;
		const closes = candles.map((c) => c.close);
		const { macd, signal, histogram: _histogram } = calculateMACD(closes, fast, slow, signalPeriod);

		const sma = p.sma_filter_period > 0 ? calculateSMA(closes, p.sma_filter_period) : null;
		const rsi = p.rsi_filter_period > 0 ? calculateRSI(closes, p.rsi_filter_period) : null;

		const signals: Signal[] = [];
		const startIdx = Math.max(slow + signalPeriod - 1, entryFilterStartIdx(p));

		for (let i = 0; i < candles.length; i++) {
			if (i < startIdx) {
				signals.push({ time: candles[i].time, action: 'hold' });
				continue;
			}

			const prevMACD = macd[i - 1];
			const prevSignal = signal[i - 1];
			const currMACD = macd[i];
			const currSignal = signal[i];

			if (Number.isNaN(prevMACD) || Number.isNaN(prevSignal) || Number.isNaN(currMACD) || Number.isNaN(currSignal)) {
				signals.push({ time: candles[i].time, action: 'hold' });
				continue;
			}

			if (prevMACD <= prevSignal && currMACD > currSignal) {
				const blockedByZeroLine =
					(p.zero_line_filter === 1 && currMACD < 0) || (p.zero_line_filter === -1 && currMACD > 0);
				if (isEntryBlockedBySmaRsi(i, closes, sma, rsi, p.rsi_filter_max) || blockedByZeroLine) {
					signals.push({ time: candles[i].time, action: 'hold' });
				} else {
					const filterDesc = describeEntryFilters(p, zeroLineFilterParts(p));
					signals.push({
						time: candles[i].time,
						action: 'buy',
						reason: `MACD Golden Cross: MACD(${currMACD.toFixed(0)}) > Signal(${currSignal.toFixed(0)})${filterDesc}`,
					});
				}
			}
			// デッドクロス: MACDがシグナルを下抜け（エグジットなのでフィルター適用しない）
			else if (prevMACD >= prevSignal && currMACD < currSignal) {
				signals.push({
					time: candles[i].time,
					action: 'sell',
					reason: `MACD Dead Cross: MACD(${currMACD.toFixed(0)}) < Signal(${currSignal.toFixed(0)})`,
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
		const { fast, slow, signal: signalPeriod } = p;
		const closes = candles.map((c) => c.close);
		const { macd, signal, histogram } = calculateMACD(closes, fast, slow, signalPeriod);

		const overlays: Overlay[] = [
			{
				type: 'line' as const,
				name: `MACD(${fast},${slow})`,
				color: '#22c55e',
				data: macd,
				panel: 'indicator' as const,
			},
			{
				type: 'line' as const,
				name: `Signal(${signalPeriod})`,
				color: '#f97316',
				data: signal,
				panel: 'indicator' as const,
			},
			{
				type: 'histogram' as const,
				name: 'Histogram',
				positiveColor: 'rgba(34, 197, 94, 0.7)',
				negativeColor: 'rgba(239, 68, 68, 0.7)',
				data: histogram,
				panel: 'indicator' as const,
			},
		];

		if (p.sma_filter_period > 0) {
			const sma = calculateSMA(closes, p.sma_filter_period);
			overlays.push({
				type: 'line' as const,
				name: `SMA${p.sma_filter_period} (filter)`,
				color: '#facc15',
				data: sma,
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

export default macdCrossStrategy;
