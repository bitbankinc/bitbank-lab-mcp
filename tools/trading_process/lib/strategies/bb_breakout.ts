import { bollingerBands } from '../../../../lib/indicators.js';
import { roundPriceAtLevel } from '../../../../lib/price.js';
import type { Candle } from '../../types.js';
import type { Overlay, ParamValidationResult, Signal, Strategy } from './types.js';

const DEFAULT_PARAMS = {
	period: 20,
	stddev: 2,
};

export function validateParams(params: Record<string, number>): ParamValidationResult {
	const errors: string[] = [];
	const normalized = { ...DEFAULT_PARAMS, ...params };

	if (normalized.period < 5) {
		errors.push('period must be at least 5');
	}
	if (normalized.stddev <= 0) {
		errors.push('stddev must be positive');
	}

	return {
		valid: errors.length === 0,
		errors,
		normalizedParams: normalized,
	};
}

// 余裕を持たせて period + 5 を要求する（prev / curr 比較で i >= period が要る）。
function computeRequiredBarsImpl(params: Record<string, number>): number {
	const p = { ...DEFAULT_PARAMS, ...params };
	return p.period + 5;
}

export const bbBreakoutStrategy: Strategy = {
	name: 'Bollinger Bands Breakout',
	type: 'bb_breakout',
	requiredBars: computeRequiredBarsImpl(DEFAULT_PARAMS),
	defaultParams: DEFAULT_PARAMS,
	computeRequiredBars: computeRequiredBarsImpl,
	validate: validateParams,

	generate(candles: Candle[], params: Record<string, number>): Signal[] {
		const { period, stddev } = { ...DEFAULT_PARAMS, ...params };
		const closes = candles.map((c) => c.close);
		const { middle, upper, lower } = bollingerBands(closes, period, stddev);

		const signals: Signal[] = [];
		const startIdx = period + 1;

		let belowLowerBand = false;

		for (let i = 0; i < candles.length; i++) {
			if (i < startIdx) {
				signals.push({ time: candles[i].time, action: 'hold' });
				continue;
			}

			const close = closes[i];
			const prevClose = closes[i - 1];
			const mid = middle[i];
			const prevMid = middle[i - 1];
			const up = upper[i];
			const low = lower[i];
			const prevLow = lower[i - 1];

			if (
				Number.isNaN(mid) ||
				Number.isNaN(up) ||
				Number.isNaN(low) ||
				Number.isNaN(prevMid) ||
				Number.isNaN(prevLow)
			) {
				signals.push({ time: candles[i].time, action: 'hold' });
				continue;
			}

			if (prevClose <= prevLow) {
				belowLowerBand = true;
			}

			if (belowLowerBand && prevClose <= prevMid && close > mid) {
				signals.push({
					time: candles[i].time,
					action: 'buy',
					reason: `BB Breakout: Price crossed above middle band (${roundPriceAtLevel(mid)})`,
				});
				belowLowerBand = false; // リセット
			}
			// エグジット: 上部バンドに到達
			else if (close >= up) {
				signals.push({
					time: candles[i].time,
					action: 'sell',
					reason: `BB Upper Band reached: ${roundPriceAtLevel(up)}`,
				});
				belowLowerBand = false; // リセット
			}
			// シグナルなし
			else {
				signals.push({ time: candles[i].time, action: 'hold' });
			}
		}

		return signals;
	},

	getOverlays(candles: Candle[], params: Record<string, number>): Overlay[] {
		const { period, stddev } = { ...DEFAULT_PARAMS, ...params };
		const closes = candles.map((c) => c.close);
		const { middle, upper, lower } = bollingerBands(closes, period, stddev);

		return [
			{
				type: 'line',
				name: `BB Middle(${period})`,
				color: '#fbbf24', // yellow（Closeの青と区別）
				data: middle,
			},
			{
				type: 'band',
				name: `BB ±${stddev}σ`,
				color: '#a855f7', // purple
				fillColor: 'rgba(168, 85, 247, 0.15)',
				data: { upper, middle, lower },
			},
		];
	},
};

export default bbBreakoutStrategy;
