import { rsi } from '../../../../lib/indicators.js';
import type { Candle } from '../../types.js';
import type { Overlay, ParamValidationResult, Signal, Strategy } from './types.js';

const DEFAULT_PARAMS = {
	period: 14,
	overbought: 70,
	oversold: 30,
};

export function calculateRSI(closes: number[], period: number): number[] {
	return rsi(closes, period);
}

export function validateParams(params: Record<string, number>): ParamValidationResult {
	const errors: string[] = [];
	const normalized = { ...DEFAULT_PARAMS, ...params };

	if (normalized.period < 2) {
		errors.push('period must be at least 2');
	}
	if (normalized.overbought <= normalized.oversold) {
		errors.push('overbought must be greater than oversold');
	}
	if (normalized.oversold < 0 || normalized.oversold > 100) {
		errors.push('oversold must be between 0 and 100');
	}
	if (normalized.overbought < 0 || normalized.overbought > 100) {
		errors.push('overbought must be between 0 and 100');
	}

	return {
		valid: errors.length === 0,
		errors,
		normalizedParams: normalized,
	};
}

// 余裕を持たせて period + 6 を要求する（prev / curr 比較で i >= period + 1 が要る）。
function computeRequiredBarsImpl(params: Record<string, number>): number {
	const p = { ...DEFAULT_PARAMS, ...params };
	return p.period + 6;
}

export const rsiStrategy: Strategy = {
	name: 'RSI',
	type: 'rsi',
	requiredBars: computeRequiredBarsImpl(DEFAULT_PARAMS),
	defaultParams: DEFAULT_PARAMS,
	computeRequiredBars: computeRequiredBarsImpl,
	validate: validateParams,

	generate(candles: Candle[], params: Record<string, number>): Signal[] {
		const { period, overbought, oversold } = { ...DEFAULT_PARAMS, ...params };
		const closes = candles.map((c) => c.close);
		const rsi = calculateRSI(closes, period);

		const signals: Signal[] = [];
		const startIdx = period + 1; // RSIが有効 + 前日比較用

		for (let i = 0; i < candles.length; i++) {
			if (i < startIdx) {
				signals.push({ time: candles[i].time, action: 'hold' });
				continue;
			}

			const prevRSI = rsi[i - 1];
			const currRSI = rsi[i];

			if (Number.isNaN(prevRSI) || Number.isNaN(currRSI)) {
				signals.push({ time: candles[i].time, action: 'hold' });
				continue;
			}

			if (prevRSI <= oversold && currRSI > oversold) {
				signals.push({
					time: candles[i].time,
					action: 'buy',
					reason: `RSI crossed above ${oversold} (oversold exit): ${currRSI.toFixed(1)}`,
				});
			}
			// エグジット: RSI が overbought 以上に到達
			else if (currRSI >= overbought) {
				signals.push({
					time: candles[i].time,
					action: 'sell',
					reason: `RSI reached overbought (${overbought}): ${currRSI.toFixed(1)}`,
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
		const { period, overbought: _overbought, oversold: _oversold } = { ...DEFAULT_PARAMS, ...params };
		const closes = candles.map((c) => c.close);
		const rsi = calculateRSI(closes, period);

		// RSI は別スケールなので本来はサブチャートに出すべきだが、簡易的にオーバーレイとして返す。
		return [
			{
				type: 'line',
				name: `RSI(${period})`,
				color: '#a855f7', // purple
				data: rsi, // 注: これは0-100のスケールで、価格チャートには直接描画できない
			},
		];
	},
};

export default rsiStrategy;
