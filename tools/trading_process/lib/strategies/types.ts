import type { Candle } from '../../types.js';

export interface Signal {
	time: string;
	action: 'buy' | 'sell' | 'hold';
	reason?: string;
}

export type StrategyType = 'sma_cross' | 'rsi' | 'macd_cross' | 'bb_breakout';

export interface StrategyConfig {
	type: StrategyType;
	params: Record<string, number>;
}

export interface OverlayLine {
	type: 'line';
	name: string;
	color: string;
	data: number[];
}

export interface OverlayBand {
	type: 'band';
	name: string;
	color: string;
	fillColor: string;
	data: { upper: number[]; middle?: number[]; lower: number[] };
}

export interface OverlayMarker {
	type: 'marker';
	name: string;
	color: string;
	data: Array<{ index: number; value: number; label?: string }>;
}

export interface OverlayHistogram {
	type: 'histogram';
	name: string;
	positiveColor: string;
	negativeColor: string;
	data: number[];
}

export type OverlayPanel = 'price' | 'indicator';

export type Overlay =
	| (OverlayLine & { panel?: OverlayPanel })
	| (OverlayBand & { panel?: OverlayPanel })
	| (OverlayMarker & { panel?: OverlayPanel })
	| (OverlayHistogram & { panel?: OverlayPanel });

export interface Strategy {
	name: string;
	type: StrategyType;
	requiredBars: number;
	defaultParams: Record<string, number>;
	/** 呼び出し側は requiredBars ではなくこちらを使う（params を大きくしてもウォームアップが足りるように）。 */
	computeRequiredBars(params: Record<string, number>): number;
	generate(candles: Candle[], params: Record<string, number>): Signal[];
	getOverlays(candles: Candle[], params: Record<string, number>): Overlay[];
	/** runBacktest はこの normalizedParams を以降の処理に使う。 */
	validate(params: Record<string, number>): ParamValidationResult;
}

export interface ParamValidationResult {
	valid: boolean;
	errors: string[];
	normalizedParams: Record<string, number>;
}

export type StrategyRegistry = Map<StrategyType, Strategy>;
