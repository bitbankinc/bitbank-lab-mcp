import { z } from 'zod';
import {
	BaseMetaSchema,
	BasePairInputSchema,
	CANDLE_DATE_DESCRIPTION,
	CandleSchema,
	CandleTypeEnum,
	NumericSeriesSchema,
	provisionalField,
	TrendLabelEnum,
	toolResultSchema,
	warningField,
	warningsField,
} from './base.js';
import { ChartIndicatorsSchema, ChartMetaSchema, ChartStatsSchema } from './chart.js';

export const IndicatorsInternalSchema = z.object({
	SMA_5: z.number().nullable().optional(),
	SMA_20: z.number().nullable().optional(),
	SMA_25: z.number().nullable().optional(),
	SMA_50: z.number().nullable().optional(),
	SMA_75: z.number().nullable().optional(),
	SMA_200: z.number().nullable().optional(),
	RSI_14: z.number().nullable().optional(),
	RSI_14_series: NumericSeriesSchema.optional(),
	BB_upper: z.number().nullable().optional(),
	BB_middle: z.number().nullable().optional(),
	BB_lower: z.number().nullable().optional(),
	BB1_upper: z.number().nullable().optional(),
	BB1_middle: z.number().nullable().optional(),
	BB1_lower: z.number().nullable().optional(),
	BB2_upper: z.number().nullable().optional(),
	BB2_middle: z.number().nullable().optional(),
	BB2_lower: z.number().nullable().optional(),
	BB3_upper: z.number().nullable().optional(),
	BB3_middle: z.number().nullable().optional(),
	BB3_lower: z.number().nullable().optional(),
	ICHIMOKU_conversion: z.number().nullable().optional(),
	ICHIMOKU_base: z.number().nullable().optional(),
	ICHIMOKU_spanA: z.number().nullable().optional(),
	ICHIMOKU_spanB: z.number().nullable().optional(),
	bb1_series: z
		.object({ upper: NumericSeriesSchema, middle: NumericSeriesSchema, lower: NumericSeriesSchema })
		.optional(),
	bb2_series: z
		.object({ upper: NumericSeriesSchema, middle: NumericSeriesSchema, lower: NumericSeriesSchema })
		.optional(),
	bb3_series: z
		.object({ upper: NumericSeriesSchema, middle: NumericSeriesSchema, lower: NumericSeriesSchema })
		.optional(),
	ichi_series: z
		.object({
			tenkan: NumericSeriesSchema,
			kijun: NumericSeriesSchema,
			spanA: NumericSeriesSchema,
			spanB: NumericSeriesSchema,
			chikou: NumericSeriesSchema,
		})
		.optional(),
	sma_5_series: NumericSeriesSchema.optional(),
	sma_20_series: NumericSeriesSchema.optional(),
	sma_25_series: NumericSeriesSchema.optional(),
	sma_50_series: NumericSeriesSchema.optional(),
	sma_75_series: NumericSeriesSchema.optional(),
	sma_200_series: NumericSeriesSchema.optional(),
	EMA_12: z.number().nullable().optional(),
	EMA_26: z.number().nullable().optional(),
	EMA_50: z.number().nullable().optional(),
	EMA_200: z.number().nullable().optional(),
	ema_12_series: NumericSeriesSchema.optional(),
	ema_26_series: NumericSeriesSchema.optional(),
	ema_50_series: NumericSeriesSchema.optional(),
	ema_200_series: NumericSeriesSchema.optional(),
	MACD_line: z.number().nullable().optional(),
	MACD_signal: z.number().nullable().optional(),
	MACD_hist: z.number().nullable().optional(),
	macd_series: z
		.object({ line: NumericSeriesSchema, signal: NumericSeriesSchema, hist: NumericSeriesSchema })
		.optional(),
	STOCH_K: z.number().nullable().optional(),
	STOCH_D: z.number().nullable().optional(),
	STOCH_prevK: z.number().nullable().optional(),
	STOCH_prevD: z.number().nullable().optional(),
	stoch_k_series: NumericSeriesSchema.optional(),
	stoch_d_series: NumericSeriesSchema.optional(),
	STOCH_RSI_K: z.number().nullable().optional(),
	STOCH_RSI_D: z.number().nullable().optional(),
	STOCH_RSI_prevK: z.number().nullable().optional(),
	STOCH_RSI_prevD: z.number().nullable().optional(),
	OBV: z.number().nullable().optional(),
	OBV_SMA20: z.number().nullable().optional(),
	OBV_prevObv: z.number().nullable().optional(),
	OBV_trend: z.enum(['rising', 'falling', 'flat']).nullable().optional(),
});

export const GetIndicatorsDataSchema = z.object({
	summary: z.string(),
	raw: z.unknown(),
	normalized: z.array(CandleSchema),
	indicators: IndicatorsInternalSchema,
	trend: TrendLabelEnum,
	chart: z.object({
		candles: z.array(CandleSchema),
		indicators: ChartIndicatorsSchema,
		meta: ChartMetaSchema,
		stats: ChartStatsSchema,
	}),
});

export const GetIndicatorsMetaSchema = BaseMetaSchema.extend({
	type: CandleTypeEnum,
	count: z.number(),
	requiredCount: z.number(),
	...warningsField,
	...warningField,
	...provisionalField,
});

export const GetIndicatorsInputSchema = BasePairInputSchema.extend({
	type: CandleTypeEnum.optional().default('1day'),
	date: z.string().optional().describe(`${CANDLE_DATE_DESCRIPTION} 指標計算に使う足を取得します。`),
	tz: z.string().optional().describe('date の暦日解釈と表示に使う IANA タイムゾーン（既定: Asia/Tokyo）。'),
	limit: z.number().int().min(1).max(1000).optional(),
});

export const GetIndicatorsOutputSchema = toolResultSchema(GetIndicatorsDataSchema, GetIndicatorsMetaSchema);
