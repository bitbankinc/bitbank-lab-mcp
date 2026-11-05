import type { z } from 'zod';
import type { CandleSchema, CandleTypeEnum, NumericSeriesSchema, TrendLabelEnum } from './base.js';
import type { ValidateCandleDataDataSchema, ValidateCandleDataMetaSchema } from './candle-validate.js';
import type {
	BollingerBandsSeriesSchema,
	ChartIndicatorsSchema,
	ChartMetaSchema,
	ChartPayloadSchema,
	EmaSeriesFixedSchema,
	IchimokuSeriesSchema,
	RenderChartSvgInputSchema,
	SmaSeriesFixedSchema,
} from './chart.js';
import type { GetIndicatorsDataSchema, GetIndicatorsMetaSchema, IndicatorsInternalSchema } from './indicators.js';
import type {
	GetCandlesDataSchemaOut,
	GetCandlesMetaSchemaOut,
	GetOrderbookDataSchemaOut,
	GetOrderbookMetaSchemaOut,
	GetTickerDataSchemaOut,
	GetTickerMetaSchemaOut,
	KeyPointSchema,
	KeyPointsSchema,
	OrderbookLevelSchema,
	OrderbookLevelWithCumSchema,
	OrderbookNormalizedSchema,
	TickerNormalizedSchema,
	VolumeStatsSchema,
} from './market-data.js';

export type Pair = `${string}_${string}`;

export type CandleType = z.infer<typeof CandleTypeEnum>;
export type Candle = z.infer<typeof CandleSchema>;
export type NumericSeries = z.output<typeof NumericSeriesSchema>;
export type TickerNormalized = z.infer<typeof TickerNormalizedSchema>;
export type OrderbookLevel = z.infer<typeof OrderbookLevelSchema>;
export type OrderbookLevelWithCum = z.infer<typeof OrderbookLevelWithCumSchema>;
export type OrderbookNormalized = z.infer<typeof OrderbookNormalizedSchema>;
export type TrendLabel = z.infer<typeof TrendLabelEnum>;

export type IchimokuSeries = z.infer<typeof IchimokuSeriesSchema>;
export type BollingerBandsSeries = z.infer<typeof BollingerBandsSeriesSchema>;
export type SmaSeriesFixed = z.infer<typeof SmaSeriesFixedSchema>;
export type EmaSeriesFixed = z.infer<typeof EmaSeriesFixedSchema>;
export type ChartIndicators = z.infer<typeof ChartIndicatorsSchema>;
export type ChartMeta = z.infer<typeof ChartMetaSchema>;
export type ChartPayload = z.infer<typeof ChartPayloadSchema>;
export type IndicatorsInternal = z.infer<typeof IndicatorsInternalSchema>;

export type GetIndicatorsData = z.infer<typeof GetIndicatorsDataSchema>;
export type GetIndicatorsMeta = z.infer<typeof GetIndicatorsMetaSchema>;
export type GetTickerData = z.infer<typeof GetTickerDataSchemaOut>;
export type GetTickerMeta = z.infer<typeof GetTickerMetaSchemaOut>;
export type GetOrderbookData = z.infer<typeof GetOrderbookDataSchemaOut>;
export type GetOrderbookMeta = z.infer<typeof GetOrderbookMetaSchemaOut>;
export type GetCandlesData = z.infer<typeof GetCandlesDataSchemaOut>;
export type GetCandlesMeta = z.infer<typeof GetCandlesMetaSchemaOut>;
export type KeyPoint = z.infer<typeof KeyPointSchema>;
export type KeyPoints = z.infer<typeof KeyPointsSchema>;
export type VolumeStats = z.infer<typeof VolumeStatsSchema>;

export type BbMode = 'default' | 'extended';
export type IchimokuMode = 'default' | 'extended';
export type ChartStyle = 'candles' | 'line' | 'depth';
export type IchimokuOptions = { mode?: IchimokuMode };
export type RenderChartSvgOptions = z.input<typeof RenderChartSvgInputSchema>;

export interface OkResult<T = Record<string, unknown>, M = Record<string, unknown>> {
	ok: true;
	summary: string;
	data: T;
	meta: M;
}

export interface FailResult<M = Record<string, unknown>> {
	ok: false;
	summary: string;
	data: Record<string, unknown>;
	meta: { errorType: string } & M;
}

export type Result<T = unknown, M = unknown> = OkResult<T, M> | FailResult<M>;

export type ValidateCandleDataData = z.infer<typeof ValidateCandleDataDataSchema>;
export type ValidateCandleDataMeta = z.infer<typeof ValidateCandleDataMetaSchema>;
