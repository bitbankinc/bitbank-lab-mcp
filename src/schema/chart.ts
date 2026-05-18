import { z } from 'zod';
import { BaseMetaSchema, CandleSchema, CandleTypeEnum, NumericSeriesSchema, toolResultSchema } from './base.js';

// ChartIndicators shape
export const IchimokuSeriesSchema = z.object({
	ICHI_tenkan: NumericSeriesSchema,
	ICHI_kijun: NumericSeriesSchema,
	ICHI_spanA: NumericSeriesSchema,
	ICHI_spanB: NumericSeriesSchema,
	ICHI_chikou: NumericSeriesSchema,
});

export const BollingerBandsSeriesSchema = z.object({
	BB_upper: NumericSeriesSchema,
	BB_middle: NumericSeriesSchema,
	BB_lower: NumericSeriesSchema,
	BB1_upper: NumericSeriesSchema,
	BB1_middle: NumericSeriesSchema,
	BB1_lower: NumericSeriesSchema,
	BB2_upper: NumericSeriesSchema,
	BB2_middle: NumericSeriesSchema,
	BB2_lower: NumericSeriesSchema,
	BB3_upper: NumericSeriesSchema,
	BB3_middle: NumericSeriesSchema,
	BB3_lower: NumericSeriesSchema,
});

export const SmaSeriesFixedSchema = z.object({
	SMA_5: NumericSeriesSchema,
	SMA_20: NumericSeriesSchema,
	SMA_25: NumericSeriesSchema,
	SMA_50: NumericSeriesSchema,
	SMA_75: NumericSeriesSchema,
	SMA_200: NumericSeriesSchema,
});

export const EmaSeriesFixedSchema = z.object({
	EMA_12: NumericSeriesSchema,
	EMA_26: NumericSeriesSchema,
	EMA_50: NumericSeriesSchema,
	EMA_200: NumericSeriesSchema,
});

export const ChartIndicatorsSchema = IchimokuSeriesSchema.merge(BollingerBandsSeriesSchema)
	.merge(SmaSeriesFixedSchema)
	.merge(EmaSeriesFixedSchema)
	.extend({
		RSI_14: z.number().nullable().optional(),
		RSI_14_series: NumericSeriesSchema.optional(),
		macd_series: z
			.object({
				line: NumericSeriesSchema,
				signal: NumericSeriesSchema,
				hist: NumericSeriesSchema,
			})
			.optional(),
		stoch_k_series: NumericSeriesSchema.optional(),
		stoch_d_series: NumericSeriesSchema.optional(),
	});

export const ChartMetaSchema = z.object({
	pastBuffer: z.number().optional(),
	shift: z.number().optional(),
});

export const ChartStatsSchema = z.object({
	min: z.number(),
	max: z.number(),
	avg: z.number(),
	volume_avg: z.number(),
});

export const ChartPayloadSchema = z
	.object({
		candles: z.array(CandleSchema),
		indicators: ChartIndicatorsSchema,
		meta: ChartMetaSchema.optional(),
		stats: ChartStatsSchema.optional(),
	})
	.superRefine((val, ctx) => {
		const len = val.candles.length;
		const seriesKeys = [
			'SMA_5',
			'SMA_20',
			'SMA_25',
			'SMA_50',
			'SMA_75',
			'SMA_200',
			'EMA_12',
			'EMA_26',
			'EMA_50',
			'EMA_200',
			'BB_upper',
			'BB_middle',
			'BB_lower',
			'BB1_upper',
			'BB1_middle',
			'BB1_lower',
			'BB2_upper',
			'BB2_middle',
			'BB2_lower',
			'BB3_upper',
			'BB3_middle',
			'BB3_lower',
			'ICHI_tenkan',
			'ICHI_kijun',
			'ICHI_spanA',
			'ICHI_spanB',
			'ICHI_chikou',
		];
		for (const key of seriesKeys) {
			const indicators = val.indicators as Record<string, unknown>;
			const arr = indicators[key];
			if (!Array.isArray(arr) || arr.length !== len) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Indicator series '${key}' must have length ${len}`,
					path: ['indicators', key],
				});
			}
		}
	});

// ── prepare_chart_data ──

/** 選択可能な指標グループ */
export const ChartIndicatorGroupEnum = z.enum([
	'SMA_5',
	'SMA_20',
	'SMA_25',
	'SMA_50',
	'SMA_75',
	'SMA_200',
	'EMA_12',
	'EMA_26',
	'EMA_50',
	'EMA_200',
	'BB',
	'ICHIMOKU',
	'RSI',
	'MACD',
	'STOCH',
]);

export const PrepareChartDataInputSchema = z.object({
	pair: z.string().optional().default('btc_jpy'),
	type: CandleTypeEnum.optional().default('1day'),
	limit: z.number().int().min(5).max(500).optional().default(30),
	indicators: z.array(ChartIndicatorGroupEnum).optional(),
	tz: z
		.string()
		.optional()
		.default('Asia/Tokyo')
		.describe(
			'タイムゾーン（デフォルト: Asia/Tokyo）。times をローカル時刻に変換し、labels（短縮表示文字列）も付加する。空文字でUTCのみ',
		),
});

/** コンパクトな数値配列（null 許容） */
const CompactSeriesSchema = z.array(z.union([z.number(), z.null()]));

/** MACD サブパネル（コンパクト形式） */
const CompactMacdSubPanelSchema = z.object({
	line: CompactSeriesSchema,
	signal: CompactSeriesSchema,
	hist: CompactSeriesSchema,
});

export const PrepareChartDataOutputSchema = z.object({
	ok: z.literal(true),
	summary: z.string(),
	data: z.object({
		/** 共有タイムスタンプ配列 */
		times: z.array(z.string()),
		/** 表示用短縮ラベル（tz 指定時のみ）。例: ["17:00", "18:00", ...] or ["03/16 17:00", ...] */
		labels: z.array(z.string()).optional(),
		/** candles 配列の各要素の意味: ["open","high","low","close","volume"] */
		candleFormat: z.array(z.string()),
		/** OHLCV タプル配列: [[open, high, low, close, volume], ...] */
		candles: z.array(z.array(z.number())),
		/** メインパネル指標（indicators 指定時のみ） */
		series: z.record(z.string(), CompactSeriesSchema).optional(),
		/** サブパネル指標（indicators 指定時のみ） */
		subPanels: z
			.object({
				RSI_14: CompactSeriesSchema.optional(),
				MACD: CompactMacdSubPanelSchema.optional(),
				STOCH_K: CompactSeriesSchema.optional(),
				STOCH_D: CompactSeriesSchema.optional(),
			})
			.optional(),
	}),
	meta: z.object({
		pair: z.string(),
		type: CandleTypeEnum,
		count: z.number(),
		indicators: z.array(z.string()),
		/** 出来高の単位（ペアのベース通貨。例: btc_jpy → "BTC"） */
		volumeUnit: z.string(),
	}),
});

// ── prepare_depth_data ──

export const PrepareDepthDataInputSchema = z.object({
	pair: z.string().optional().default('btc_jpy'),
	levels: z
		.number()
		.int()
		.min(10)
		.max(1000)
		.optional()
		.default(200)
		.describe('取得する最大レベル数（片側）。10〜1000 の整数、デフォルト 200'),
	bandPct: z
		.number()
		.positive()
		.max(1)
		.optional()
		.default(0.01)
		.describe('mid を中心とした ±range 比率。0.01 = ±1%。デフォルト 0.01'),
});

/** [price, cumulativeVolume] のタプル */
const DepthStepTupleSchema = z.tuple([z.number(), z.number()]);

export const PrepareDepthDataDataSchemaOut = z.object({
	bids: z.array(DepthStepTupleSchema),
	asks: z.array(DepthStepTupleSchema),
	bestBid: z.number().nullable(),
	bestAsk: z.number().nullable(),
	mid: z.number().nullable(),
	spread: z.number().nullable(),
	spreadPct: z.number().nullable(),
	totalBidVolume: z.number(),
	totalAskVolume: z.number(),
	band: z.object({
		pct: z.number(),
		bidVolume: z.number(),
		askVolume: z.number(),
		ratio: z.number().nullable(),
	}),
	timestamp: z.number(),
	isoTime: z.string().nullable(),
});

export const PrepareDepthDataMetaSchemaOut = BaseMetaSchema.extend({
	levels: z.object({ bids: z.number().int(), asks: z.number().int() }),
	volumeUnit: z.string(),
	/** Number() 変換で NaN/非有限になった行数。0 の場合は省略可。 */
	droppedRows: z.object({ bids: z.number().int(), asks: z.number().int() }).optional(),
	/** drop が発生した場合の警告メッセージ */
	warning: z.string().optional(),
});

export const PrepareDepthDataOutputSchema = toolResultSchema(
	PrepareDepthDataDataSchemaOut,
	PrepareDepthDataMetaSchemaOut,
);

/** render_chart_svg で使用可能なインジケーター */
export const RenderChartSvgIndicatorEnum = z.enum([
	'SMA_5',
	'SMA_20',
	'SMA_25',
	'SMA_50',
	'SMA_75',
	'SMA_200',
	'EMA_12',
	'EMA_26',
	'EMA_50',
	'EMA_200',
	'BB',
	'BB_EXTENDED',
	'ICHIMOKU',
	'ICHIMOKU_EXTENDED',
]);

export const RenderChartSvgInputSchema = z
	.object({
		pair: z.string().optional().default('btc_jpy'),
		type: CandleTypeEnum.optional().default('1day'),
		// impl default is 60; align contract to tool behavior
		limit: z.number().int().min(5).max(365).optional().default(60),
		// main series style: candles (default) or line (close-only)
		style: z.enum(['candles', 'line', 'depth']).optional().default('candles'),
		depth: z.object({ levels: z.number().int().min(10).max(500).optional().default(200) }).optional(),
		// ── 統一インジケーター指定（推奨） ──
		indicators: z
			.array(RenderChartSvgIndicatorEnum)
			.optional()
			.default([])
			.describe(
				'Indicators to overlay. Do NOT set unless the user explicitly requests them. Default: [] (none).\n' +
					'Available: SMA_5, SMA_20, SMA_25, SMA_50, SMA_75, SMA_200, EMA_12, EMA_26, EMA_50, EMA_200, BB, BB_EXTENDED, ICHIMOKU, ICHIMOKU_EXTENDED',
			),
		// ── 後方互換（deprecated: 新規利用は indicators を使用） ──
		withSMA: z.array(z.number().int()).optional().default([]),
		withEMA: z.array(z.number().int()).optional().default([]),
		withBB: z.boolean().optional().default(false),
		bbMode: z.enum(['default', 'extended', 'light', 'full']).optional().default('default'),
		withIchimoku: z.boolean().optional().default(false),
		ichimoku: z
			.object({
				mode: z.enum(['default', 'extended']).optional().default('default'),
				withChikou: z.boolean().optional(),
			})
			.optional(),
		// 軽量化のため凡例は既定でオフ
		withLegend: z.boolean().optional().default(false),
		// 軽量化オプション
		svgPrecision: z.number().int().min(0).max(3).optional().default(1).describe('Coordinate rounding decimals (0-3).'),
		svgMinify: z.boolean().optional().default(true).describe('Minify SVG text by stripping whitespace where safe.'),
		simplifyTolerance: z
			.number()
			.min(0)
			.optional()
			.default(0.5)
			.describe('Line simplification tolerance in pixels (0 disables).'),
		viewBoxTight: z.boolean().optional().default(true).describe('Use tighter paddings to reduce empty margins.'),
		barWidthRatio: z.number().min(0.1).max(0.9).optional().describe('Width ratio of each candle body (slot fraction).'),
		yPaddingPct: z.number().min(0).max(0.2).optional().describe('Vertical padding ratio to expand y-range.'),
		// サブパネル（価格パネルの下に独立Y軸で描画）
		subPanels: z
			.array(z.enum(['macd', 'rsi', 'volume']))
			.optional()
			.default([])
			.describe('サブパネル: macd(MACD線+シグナル+ヒストグラム), rsi(RSI 14 + 70/30ゾーン), volume(出来高バー)'),
		// X軸ラベルのタイムゾーン
		tz: z.string().optional().default('Asia/Tokyo').describe('X軸ラベルのタイムゾーン（例: Asia/Tokyo, UTC）'),
		// Optional pattern overlays (ranges/annotations)
		overlays: z
			.object({
				ranges: z
					.array(
						z.object({
							start: z.string(),
							end: z.string(),
							color: z.string().optional(),
							label: z.string().optional(),
						}),
					)
					.optional(),
				annotations: z.array(z.object({ isoTime: z.string(), text: z.string() })).optional(),
				depth_zones: z
					.array(
						z.object({ low: z.number(), high: z.number(), color: z.string().optional(), label: z.string().optional() }),
					)
					.optional(),
			})
			.optional(),
	})
	.superRefine((val, ctx) => {
		// indicators 配列から一目均衡表の有無を判定
		const hasIchimokuViaIndicators =
			val.indicators?.includes('ICHIMOKU') || val.indicators?.includes('ICHIMOKU_EXTENDED');
		const hasIchimoku = val.withIchimoku || hasIchimokuViaIndicators;
		const hasBBViaIndicators = val.indicators?.includes('BB') || val.indicators?.includes('BB_EXTENDED');
		const hasSMAViaIndicators = val.indicators?.some((i: string) => i.startsWith('SMA_'));

		if (hasIchimoku) {
			if ((Array.isArray(val.withSMA) && val.withSMA.length > 0) || hasSMAViaIndicators) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['indicators'],
					message: 'ICHIMOKU と SMA は同時に指定できません',
				});
			}
			if (val.withBB === true || hasBBViaIndicators) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['indicators'],
					message: 'ICHIMOKU と BB は同時に指定できません',
				});
			}
		}
	});

// Optional: output contract (not enforced by SDK at runtime, but useful for validation/tests)
export const RenderChartSvgOutputSchema = z.object({
	ok: z.literal(true).or(z.literal(false)),
	summary: z.string(),
	data: z
		.object({
			svg: z.string().optional(),
			legend: z.record(z.string(), z.string()).optional(),
		})
		.or(z.object({})),
	meta: z
		.object({
			pair: z.string(),
			type: CandleTypeEnum,
			limit: z.number().optional(),
			indicators: z.array(z.string()).optional(),
			bbMode: z.enum(['default', 'extended']).optional(),
			range: z.object({ start: z.string(), end: z.string() }).optional(),
			sizeBytes: z.number().optional(),
			layerCount: z.number().optional(),
			fallback: z.string().optional(),
			warnings: z.array(z.string()).optional(),
		})
		.optional(),
});
