import { z } from 'zod';
import {
	BaseMetaSchema,
	BasePairInputSchema,
	CandleTypeEnum,
	FailResultSchema,
	TrendLabelEnum,
	toolResultSchema,
} from './base.js';

// === Volatility Metrics ===
export const GetVolMetricsInputSchema = z.object({
	pair: z.string(),
	type: CandleTypeEnum,
	limit: z.number().int().min(20).max(500).optional().default(200),
	windows: z.array(z.number().int().min(2)).optional().default([14, 20, 30]),
	useLogReturns: z.boolean().optional().default(true),
	annualize: z.boolean().optional().default(true),
	tz: z.string().optional().default('Asia/Tokyo'),
	cacheTtlMs: z.number().int().optional().default(60_000),
	view: z.enum(['summary', 'detailed', 'full', 'beginner']).optional().default('summary'),
});

export const GetVolMetricsDataSchemaOut = z.object({
	meta: z.object({
		pair: z.string(),
		type: z.string(),
		fetchedAt: z.string(),
		baseIntervalMs: z.number(),
		sampleSize: z.number(),
		windows: z.array(z.number()),
		annualize: z.boolean(),
		useLogReturns: z.boolean(),
		source: z.literal('bitbank:candlestick'),
	}),
	aggregates: z.object({
		rv_std: z.number(),
		rv_std_ann: z.number().optional(),
		parkinson: z.number(),
		garmanKlass: z.number(),
		rogersSatchell: z.number(),
		atr: z.number(),
		skewness: z.number().optional(),
		kurtosis: z.number().optional(),
		gap_ratio: z.number().optional(),
	}),
	rolling: z.array(
		z.object({
			window: z.number(),
			rv_std: z.number(),
			rv_std_ann: z.number().optional(),
			parkinson: z.number().optional(),
			garmanKlass: z.number().optional(),
			rogersSatchell: z.number().optional(),
		}),
	),
	series: z.object({
		ts: z.array(z.number()),
		close: z.array(z.number()),
		ret: z.array(z.number()),
		rv_inst: z.array(z.number()).optional(),
	}),
	tags: z.array(z.string()),
});

export const GetVolMetricsMetaSchemaOut = BaseMetaSchema.extend({
	type: CandleTypeEnum,
	count: z.number().int(),
	/** 取得層の不完全性を示す警告（上流 get_candles の fetchWarning、不正OHLCスキップ、isoTime欠損等）。 */
	warning: z.string().optional(),
	/** 最新足が形成中（未確定）か。warning（取得層）とは別系統の情報フラグ。 */
	provisional: z.boolean().optional(),
});

export const GetVolMetricsOutputSchema = toolResultSchema(GetVolMetricsDataSchemaOut, GetVolMetricsMetaSchemaOut);

// === Analyze Market Signal ===
export const AnalyzeMarketSignalDataSchemaOut = z.object({
	score: z.number(),
	recommendation: z.enum(['bullish', 'bearish', 'neutral']),
	tags: z.array(z.string()),
	confidence: z.enum(['high', 'medium', 'low']),
	confidenceReason: z.string(),
	nextActions: z.array(
		z.object({
			priority: z.enum(['high', 'medium', 'low']),
			tool: z.string(),
			reason: z.string(),
			suggestedParams: z.record(z.string(), z.any()).optional(),
		}),
	),
	alerts: z.array(z.object({ level: z.enum(['info', 'warning', 'critical']), message: z.string() })).optional(),
	formula: z.string(),
	weights: z.object({
		buyPressure: z.number(),
		cvdTrend: z.number(),
		momentum: z.number(),
		volatility: z.number(),
		smaTrend: z.number(),
	}),
	contributions: z.object({
		buyPressure: z.number(),
		cvdTrend: z.number(),
		momentum: z.number(),
		volatility: z.number(),
		smaTrend: z.number(),
	}),
	breakdown: z.object({
		buyPressure: z.object({
			rawValue: z.number(),
			weight: z.number(),
			contribution: z.number(),
			interpretation: z.enum(['weak', 'moderate', 'strong', 'neutral']),
		}),
		cvdTrend: z.object({
			rawValue: z.number(),
			weight: z.number(),
			contribution: z.number(),
			interpretation: z.enum(['weak', 'moderate', 'strong', 'neutral']),
		}),
		momentum: z.object({
			rawValue: z.number(),
			weight: z.number(),
			contribution: z.number(),
			interpretation: z.enum(['weak', 'moderate', 'strong', 'neutral']),
		}),
		volatility: z.object({
			rawValue: z.number(),
			weight: z.number(),
			contribution: z.number(),
			interpretation: z.enum(['weak', 'moderate', 'strong', 'neutral']),
		}),
		smaTrend: z.object({
			rawValue: z.number(),
			weight: z.number(),
			contribution: z.number(),
			interpretation: z.enum(['weak', 'moderate', 'strong', 'neutral']),
		}),
	}),
	topContributors: z.array(z.enum(['buyPressure', 'cvdTrend', 'momentum', 'volatility', 'smaTrend'])).min(1),
	thresholds: z.object({ bullish: z.number(), bearish: z.number() }),
	metrics: z.object({
		buyPressure: z.number(),
		cvdTrend: z.number(),
		momentumFactor: z.number(),
		volatilityFactor: z.number(),
		smaTrendFactor: z.number(),
		rsi: z.number().nullable(),
		rv_std_ann: z.number(),
		aggressorRatio: z.number(),
		cvdSlope: z.number(),
		horizon: z.number().int(),
	}),
	// Enriched SMA block for LLM-friendly grounding
	sma: z
		.object({
			current: z.number().nullable(),
			values: z.object({
				sma25: z.number().nullable(),
				sma75: z.number().nullable(),
				sma200: z.number().nullable(),
			}),
			deviations: z.object({
				vs25: z.number().nullable(),
				vs75: z.number().nullable(),
				vs200: z.number().nullable(),
			}),
			arrangement: z.enum(['bullish', 'bearish', 'mixed']),
			position: z.enum(['above_all', 'below_all', 'mixed']),
			distanceFromSma25Pct: z.number().nullable().optional(),
			recentCross: z
				.object({
					type: z.enum(['golden_cross', 'death_cross']),
					pair: z.literal('25/75'),
					barsAgo: z.number().int(),
				})
				.nullable()
				.optional(),
		})
		.optional(),
	// Optional helper fields
	recommendedTimeframes: z.array(z.string()).optional(),
	refs: z.object({
		flow: z.object({ aggregates: z.unknown(), lastBuckets: z.array(z.unknown()) }),
		volatility: z.object({ aggregates: z.unknown() }),
		indicators: z.object({ latest: z.unknown(), trend: TrendLabelEnum }),
	}),
});
export const AnalyzeMarketSignalMetaSchemaOut = BaseMetaSchema.extend({
	type: CandleTypeEnum,
	windows: z.array(z.number()),
	bucketMs: z.number().int(),
	flowLimit: z.number().int(),
	/** 取得層の不完全性（上流 get_flow_metrics / get_volatility_metrics / analyze_indicators の meta.warning を集約）。 */
	warning: z.string().optional(),
	/** 計算層の不完全性（analyze_indicators の meta.warnings を継承。SMA_200 データ不足 等）。 */
	warnings: z.array(z.string()).optional(),
});
export const AnalyzeMarketSignalOutputSchema = toolResultSchema(
	AnalyzeMarketSignalDataSchemaOut,
	AnalyzeMarketSignalMetaSchemaOut,
);
export const AnalyzeMarketSignalInputSchema = BasePairInputSchema.extend({
	type: CandleTypeEnum.optional().default('1day'),
	flowLimit: z.number().int().optional().default(300),
	bucketMs: z.number().int().optional().default(60_000),
	windows: z.array(z.number().int()).optional().default([14, 20, 30]),
});

// === Ichimoku numeric snapshot (no visual assumptions) ===
export const AnalyzeIchimokuSnapshotInputSchema = BasePairInputSchema.extend({
	type: CandleTypeEnum.optional().default('1day'),
	limit: z.number().int().min(60).max(365).optional().default(120),
	lookback: z.number().int().min(2).max(120).optional().default(10),
});

export const AnalyzeIchimokuSnapshotDataSchemaOut = z.object({
	latest: z.object({
		close: z.number().nullable(),
		tenkan: z.number().nullable(),
		kijun: z.number().nullable(),
		spanA: z.number().nullable(),
		spanB: z.number().nullable(),
		chikou: z.number().nullable().optional(),
		cloudTop: z.number().nullable(),
		cloudBottom: z.number().nullable(),
	}),
	assessment: z.object({
		pricePosition: z.enum(['above_cloud', 'in_cloud', 'below_cloud', 'unknown']),
		tenkanKijun: z.enum(['bullish', 'bearish', 'neutral', 'unknown']),
		cloudSlope: z.enum(['rising', 'falling', 'flat', 'unknown']),
	}),
	cloud: z
		.object({
			thickness: z.number().nullable(),
			thicknessPct: z.number().nullable(),
			direction: z.enum(['rising', 'falling', 'flat']).nullable(),
			strength: z.enum(['strong', 'moderate', 'weak']).nullable(),
			upperBound: z.number().nullable(),
			lowerBound: z.number().nullable(),
		})
		.optional(),
	tenkanKijunDetail: z
		.object({
			relationship: z.enum(['bullish', 'bearish']).nullable(),
			distance: z.number().nullable(),
			distancePct: z.number().nullable(),
		})
		.optional(),
	chikouSpan: z
		.object({
			position: z.enum(['above', 'below']).nullable(),
			distance: z.number().nullable(),
			clearance: z.number().nullable(),
		})
		.optional(),
	trend: z
		.object({
			cloudHistory: z.array(z.object({ barsAgo: z.number().int(), position: z.enum(['above', 'in', 'below']) })),
			trendStrength: z.object({ shortTerm: z.number(), mediumTerm: z.number() }),
			momentum: z.enum(['accelerating', 'steady', 'decelerating']),
		})
		.optional(),
	signals: z
		.object({
			sanpuku: z.object({
				kouten: z.boolean(),
				gyakuten: z.boolean(),
				conditions: z.object({
					priceAboveCloud: z.boolean(),
					tenkanAboveKijun: z.boolean(),
					chikouAbovePrice: z.boolean(),
				}),
			}),
			recentCrosses: z.array(
				z.object({ type: z.enum(['golden_cross', 'death_cross']), barsAgo: z.number().int(), description: z.string() }),
			),
			kumoTwist: z.object({
				detected: z.boolean(),
				barsAgo: z.number().int().optional(),
				direction: z.enum(['bullish', 'bearish']).optional(),
			}),
			overallSignal: z.enum(['strong_bullish', 'bullish', 'neutral', 'bearish', 'strong_bearish']),
			confidence: z.enum(['high', 'medium', 'low']),
		})
		.optional(),
	scenarios: z
		.object({
			keyLevels: z.object({
				resistance: z.array(z.number()),
				support: z.array(z.number()),
				cloudEntry: z.number(),
				cloudExit: z.number(),
			}),
			scenarios: z.object({
				bullish: z.object({
					condition: z.string(),
					target: z.number(),
					probability: z.enum(['high', 'medium', 'low']),
				}),
				bearish: z.object({
					condition: z.string(),
					target: z.number(),
					probability: z.enum(['high', 'medium', 'low']),
				}),
			}),
			watchPoints: z.array(z.string()),
		})
		.optional(),
	tags: z.array(z.string()),
});

export const AnalyzeIchimokuSnapshotMetaSchemaOut = BaseMetaSchema.extend({
	type: CandleTypeEnum,
	count: z.number().int(),
	/** 取得層の不完全性（上流 get_candles / analyze_indicators の meta.warning を継承）。 */
	warning: z.string().optional(),
	/** 計算層の不完全性（analyze_indicators の meta.warnings を継承）。 */
	warnings: z.array(z.string()).optional(),
});

export const AnalyzeIchimokuSnapshotOutputSchema = toolResultSchema(
	AnalyzeIchimokuSnapshotDataSchemaOut,
	AnalyzeIchimokuSnapshotMetaSchemaOut,
);

// === BB snapshot ===
export const AnalyzeBbSnapshotInputSchema = BasePairInputSchema.extend({
	type: CandleTypeEnum.optional().default('1day'),
	limit: z.number().int().min(40).max(365).optional().default(120),
	mode: z.enum(['default', 'extended']).optional().default('default'),
});

// analyze_bb_snapshot: support legacy (flat) and new (structured) data shapes
const AnalyzeBbSnapshotDataSchemaLegacy = z.object({
	latest: z.object({
		close: z.number().nullable(),
		middle: z.number().nullable(),
		upper: z.number().nullable(),
		lower: z.number().nullable(),
	}),
	zScore: z.number().nullable(),
	bandWidthPct: z.number().nullable(),
	tags: z.array(z.string()),
});

const AnalyzeBbSnapshotDataSchemaStructured = z.object({
	mode: z.enum(['default', 'extended']),
	price: z.number().nullable(),
	bb: z.union([
		// default: middle/upper/lower
		z.object({
			middle: z.number().nullable(),
			upper: z.number().nullable(),
			lower: z.number().nullable(),
			zScore: z.number().nullable(),
			bandWidthPct: z.number().nullable(),
		}),
		// extended: bands map and bandWidthPct per band
		z.object({
			middle: z.number().nullable(),
			bands: z.record(z.string(), z.number().nullable()).optional(),
			zScore: z.number().nullable(),
			bandWidthPct: z.union([z.number().nullable(), z.record(z.string(), z.number().nullable())]),
		}),
	]),
	interpretation: z.unknown().optional(),
	position_analysis: z.unknown().optional(),
	extreme_events: z.unknown().optional(),
	context: z.unknown().optional(),
	signals: z.array(z.string()).optional(),
	next_steps: z.record(z.string(), z.any()).optional(),
	tags: z.array(z.string()).optional(),
});

export const AnalyzeBbSnapshotDataSchemaOut = z.union([
	AnalyzeBbSnapshotDataSchemaLegacy,
	AnalyzeBbSnapshotDataSchemaStructured,
]);

export const AnalyzeBbSnapshotMetaSchemaOut = BaseMetaSchema.extend({
	type: CandleTypeEnum,
	count: z.number().int(),
	mode: z.enum(['default', 'extended']),
	// allow additional meta injected by implementation
	extra: z.object({}).passthrough().optional(),
	/** 取得層の不完全性（上流 get_candles / analyze_indicators の meta.warning を継承）。 */
	warning: z.string().optional(),
	/** 計算層の不完全性（analyze_indicators の meta.warnings を継承）。 */
	warnings: z.array(z.string()).optional(),
});

export const AnalyzeBbSnapshotOutputSchema = toolResultSchema(
	AnalyzeBbSnapshotDataSchemaOut,
	AnalyzeBbSnapshotMetaSchemaOut,
);

// === SMA snapshot ===
export const AnalyzeSmaSnapshotInputSchema = BasePairInputSchema.extend({
	type: CandleTypeEnum.optional().default('1day'),
	limit: z.number().int().min(200).max(365).optional().default(220),
	periods: z.array(z.number().int()).optional().default([25, 75, 200]),
});

export const AnalyzeSmaSnapshotDataSchemaOut = z
	.object({
		latest: z.object({ close: z.number().nullable() }),
		sma: z.record(z.string(), z.number().nullable()),
		crosses: z.array(z.object({ a: z.string(), b: z.string(), type: z.enum(['golden', 'dead']), delta: z.number() })),
		alignment: z.enum(['bullish', 'bearish', 'mixed', 'unknown']),
		tags: z.array(z.string()),
		// Extended (optional): enriched summary and SMA analytics
		summary: z
			.object({
				close: z.number().nullable(),
				align: z.enum(['bullish', 'bearish', 'mixed', 'unknown']),
				position: z.enum(['above_all', 'below_all', 'between', 'unknown']),
			})
			.optional(),
		smas: z
			.record(
				z.string(),
				z.object({
					value: z.number().nullable(),
					distancePct: z.number().nullable(),
					distanceAbs: z.number().nullable(),
					slope: z.enum(['rising', 'falling', 'flat']),
					slopePctPerBar: z.number().nullable(),
					slopePctTotal: z.number().nullable(),
					barsWindow: z.number().nullable(),
					slopePctPerDay: z.number().nullable().optional(),
				}),
			)
			.optional(),
		recentCrosses: z
			.array(
				z.object({
					type: z.enum(['golden_cross', 'dead_cross']),
					pair: z.tuple([z.number(), z.number()]),
					barsAgo: z.number().int(),
					date: z.string(),
				}),
			)
			.optional(),
	})
	.passthrough();

export const AnalyzeSmaSnapshotMetaSchemaOut = BaseMetaSchema.extend({
	type: CandleTypeEnum,
	count: z.number().int(),
	periods: z.array(z.number().int()),
	/** 取得層の不完全性（上流 get_candles / analyze_indicators の meta.warning を継承）。 */
	warning: z.string().optional(),
	/** 計算層の不完全性（analyze_indicators の meta.warnings を継承）。 */
	warnings: z.array(z.string()).optional(),
});

export const AnalyzeSmaSnapshotOutputSchema = toolResultSchema(
	AnalyzeSmaSnapshotDataSchemaOut,
	AnalyzeSmaSnapshotMetaSchemaOut,
);

// === EMA snapshot ===
export const AnalyzeEmaSnapshotInputSchema = BasePairInputSchema.extend({
	type: CandleTypeEnum.optional().default('1day'),
	limit: z.number().int().min(200).max(365).optional().default(220),
	periods: z.array(z.number().int()).optional().default([12, 26, 50, 200]),
});

export const AnalyzeEmaSnapshotDataSchemaOut = z
	.object({
		latest: z.object({ close: z.number().nullable() }),
		ema: z.record(z.string(), z.number().nullable()),
		crosses: z.array(z.object({ a: z.string(), b: z.string(), type: z.enum(['golden', 'dead']), delta: z.number() })),
		alignment: z.enum(['bullish', 'bearish', 'mixed', 'unknown']),
		tags: z.array(z.string()),
		summary: z
			.object({
				close: z.number().nullable(),
				align: z.enum(['bullish', 'bearish', 'mixed', 'unknown']),
				position: z.enum(['above_all', 'below_all', 'between', 'unknown']),
			})
			.optional(),
		emas: z
			.record(
				z.string(),
				z.object({
					value: z.number().nullable(),
					distancePct: z.number().nullable(),
					distanceAbs: z.number().nullable(),
					slope: z.enum(['rising', 'falling', 'flat']),
					slopePctPerBar: z.number().nullable(),
					slopePctTotal: z.number().nullable(),
					barsWindow: z.number().nullable(),
					slopePctPerDay: z.number().nullable().optional(),
				}),
			)
			.optional(),
		recentCrosses: z
			.array(
				z.object({
					type: z.enum(['golden_cross', 'dead_cross']),
					pair: z.tuple([z.number(), z.number()]),
					barsAgo: z.number().int(),
					date: z.string(),
				}),
			)
			.optional(),
	})
	.passthrough();

export const AnalyzeEmaSnapshotMetaSchemaOut = BaseMetaSchema.extend({
	type: CandleTypeEnum,
	count: z.number().int(),
	periods: z.array(z.number().int()),
	/** 取得層の不完全性（上流 get_candles / analyze_indicators の meta.warning を継承）。 */
	warning: z.string().optional(),
	/** 計算層の不完全性（analyze_indicators の meta.warnings を継承）。getCandles 直叩き path では undefined。 */
	warnings: z.array(z.string()).optional(),
});

export const AnalyzeEmaSnapshotOutputSchema = toolResultSchema(
	AnalyzeEmaSnapshotDataSchemaOut,
	AnalyzeEmaSnapshotMetaSchemaOut,
);

// === Stochastic Oscillator snapshot ===
export const AnalyzeStochSnapshotInputSchema = BasePairInputSchema.extend({
	type: CandleTypeEnum.optional().default('1day'),
	limit: z.number().int().min(40).max(365).optional().default(120),
	kPeriod: z.number().int().min(2).max(50).optional().default(14),
	smoothK: z.number().int().min(1).max(10).optional().default(3),
	smoothD: z.number().int().min(1).max(10).optional().default(3),
});

export const AnalyzeStochSnapshotDataSchemaOut = z
	.object({
		latest: z.object({ close: z.number().nullable() }),
		stoch: z.object({
			k: z.number().nullable(),
			d: z.number().nullable(),
			prevK: z.number().nullable(),
			prevD: z.number().nullable(),
		}),
		zone: z.enum(['overbought', 'oversold', 'neutral']),
		crossover: z.object({
			type: z.enum(['bullish_cross', 'bearish_cross', 'none']),
			description: z.string(),
		}),
		recentCrosses: z.array(
			z.object({
				type: z.enum(['bullish_cross', 'bearish_cross']),
				barsAgo: z.number().int(),
				date: z.string(),
				zone: z.enum(['overbought', 'oversold', 'neutral']),
			}),
		),
		divergence: z.object({
			type: z.enum(['bullish', 'bearish', 'none']),
			description: z.string(),
		}),
		tags: z.array(z.string()),
	})
	.passthrough();

export const AnalyzeStochSnapshotMetaSchemaOut = BaseMetaSchema.extend({
	type: CandleTypeEnum,
	count: z.number().int(),
	params: z.object({ kPeriod: z.number().int(), smoothK: z.number().int(), smoothD: z.number().int() }),
	/** 取得層の不完全性（上流 get_candles / analyze_indicators の meta.warning を継承）。 */
	warning: z.string().optional(),
	/** 計算層の不完全性（analyze_indicators の meta.warnings を継承）。getCandles 直叩き path では undefined。 */
	warnings: z.array(z.string()).optional(),
});

export const AnalyzeStochSnapshotOutputSchema = toolResultSchema(
	AnalyzeStochSnapshotDataSchemaOut,
	AnalyzeStochSnapshotMetaSchemaOut,
);

// === MTF SMA (Multi-Timeframe SMA Snapshot) ===
export const AnalyzeMtfSmaInputSchema = BasePairInputSchema.extend({
	timeframes: z.array(CandleTypeEnum).min(1).optional().default(['1hour', '4hour', '1day']),
	periods: z.array(z.number().int()).optional().default([25, 75, 200]),
});

const MtfSmaPerTimeframeSchema = z
	.object({
		alignment: z.enum(['bullish', 'bearish', 'mixed', 'unknown']),
		position: z.enum(['above_all', 'below_all', 'between', 'unknown']).optional(),
		latest: z.object({ close: z.number().nullable() }),
		sma: z.record(z.string(), z.number().nullable()).optional(),
		smas: z
			.record(
				z.string(),
				z.object({
					value: z.number().nullable(),
					distancePct: z.number().nullable(),
					distanceAbs: z.number().nullable().optional(),
					slope: z.enum(['rising', 'falling', 'flat']),
					slopePctPerBar: z.number().nullable().optional(),
					slopePctTotal: z.number().nullable().optional(),
					barsWindow: z.number().int().nullable().optional(),
					slopePctPerDay: z.number().nullable().optional(),
					pricePosition: z.enum(['above', 'below', 'equal']).optional(),
				}),
			)
			.optional(),
		crosses: z
			.array(
				z.object({
					a: z.string(),
					b: z.string(),
					type: z.enum(['golden', 'dead']),
					delta: z.number(),
				}),
			)
			.optional(),
		recentCrosses: z
			.array(
				z.object({
					type: z.enum(['golden_cross', 'dead_cross']),
					pair: z.tuple([z.number(), z.number()]),
					barsAgo: z.number().int(),
					date: z.string(),
				}),
			)
			.optional(),
		tags: z.array(z.string()).optional(),
	})
	.passthrough();

export const AnalyzeMtfSmaDataSchemaOut = z
	.object({
		timeframes: z.record(z.string(), MtfSmaPerTimeframeSchema),
		confluence: z.object({
			aligned: z.boolean(),
			direction: z.enum(['bullish', 'bearish', 'mixed', 'unknown']),
			summary: z.string(),
		}),
	})
	.passthrough();

export const AnalyzeMtfSmaMetaSchemaOut = BaseMetaSchema.extend({
	timeframes: z.array(z.string()),
	periods: z.array(z.number().int()),
	/** 取得層の不完全性。子 analyze_sma_snapshot の meta.warning / 失敗 TF の synthetic message を `[tf]` prefix 付きで集約。 */
	warning: z.string().optional(),
	/** 計算層の不完全性。子 analyze_sma_snapshot の meta.warnings を `[tf]` prefix 付きで継承。 */
	warnings: z.array(z.string()).optional(),
});

export const AnalyzeMtfSmaOutputSchema = toolResultSchema(AnalyzeMtfSmaDataSchemaOut, AnalyzeMtfSmaMetaSchemaOut);

// === Support Resistance Analysis ===
export const AnalyzeSupportResistanceInputSchema = BasePairInputSchema.extend({
	lookbackDays: z.number().int().min(30).max(200).optional().default(90),
	topN: z.number().int().min(1).max(5).optional().default(3),
	tolerance: z.number().min(0.001).max(0.05).optional().default(0.015),
});

const TouchEventSchema = z.object({
	date: z.string(),
	price: z.number(),
	bounceStrength: z.number(),
	type: z.enum(['support', 'resistance']),
});

const SupportResistanceLevelSchema = z.object({
	price: z.number(),
	pctFromCurrent: z.number(),
	strength: z.number().int().min(1).max(3),
	label: z.string(),
	touchCount: z.number().int(),
	touches: z.array(TouchEventSchema),
	recentBreak: z
		.object({
			date: z.string(),
			price: z.number(),
			breakPct: z.number(),
		})
		.optional(),
});

export const AnalyzeSupportResistanceDataSchemaOut = z
	.object({
		currentPrice: z.number(),
		analysisDate: z.string(),
		lookbackDays: z.number().int(),
		supports: z.array(SupportResistanceLevelSchema),
		resistances: z.array(SupportResistanceLevelSchema),
		detectionCriteria: z.object({
			swingDepth: z.number().int(),
			recentBreakWindow: z.number().int(),
			tolerance: z.number(),
		}),
	})
	.passthrough();

export const AnalyzeSupportResistanceMetaSchemaOut = BaseMetaSchema.extend({
	lookbackDays: z.number().int(),
	topN: z.number().int(),
	supportCount: z.number().int(),
	resistanceCount: z.number().int(),
}).passthrough();

export const AnalyzeSupportResistanceOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		content: z.array(z.object({ type: z.literal('text'), text: z.string() })).optional(),
		data: AnalyzeSupportResistanceDataSchemaOut,
		meta: AnalyzeSupportResistanceMetaSchemaOut,
	}),
	FailResultSchema,
]);

// === Fibonacci Retracement/Extension Analysis ===

export const AnalyzeFibonacciInputSchema = BasePairInputSchema.extend({
	type: CandleTypeEnum.optional().default('1day'),
	lookbackDays: z.number().int().min(14).max(365).optional().default(90),
	mode: z.enum(['retracement', 'extension', 'both']).optional().default('both'),
	historyLookbackDays: z.number().int().min(30).max(365).optional().default(180),
});

const FibonacciLevelSchema = z.object({
	ratio: z.number(),
	price: z.number(),
	distancePct: z.number(),
	isNearest: z.boolean(),
});

const FibonacciLevelStatSchema = z.object({
	ratio: z.number(),
	samplesCount: z.number().int(),
	bounceRate: z.number(),
	avgBounceReturnPct: z.number(),
	avgBreakthroughReturnPct: z.number(),
	medianDwellBars: z.number().int(),
	confidence: z.enum(['high', 'medium', 'low']),
});

export const AnalyzeFibonacciDataSchemaOut = z
	.object({
		pair: z.string(),
		timeframe: z.string(),
		currentPrice: z.number(),
		trend: z.enum(['up', 'down']),
		swingHigh: z.object({ price: z.number(), date: z.string(), index: z.number().int() }),
		swingLow: z.object({ price: z.number(), date: z.string(), index: z.number().int() }),
		range: z.number(),
		levels: z.array(FibonacciLevelSchema),
		extensions: z.array(FibonacciLevelSchema),
		position: z.object({
			aboveLevel: FibonacciLevelSchema.nullable(),
			belowLevel: FibonacciLevelSchema.nullable(),
			nearestLevel: FibonacciLevelSchema.nullable(),
		}),
		levelStats: z.array(FibonacciLevelStatSchema).optional(),
	})
	.passthrough();

export const AnalyzeFibonacciMetaSchemaOut = BaseMetaSchema.extend({
	timeframe: z.string(),
	lookbackDays: z.number().int(),
	mode: z.string(),
	historyLookbackDays: z.number().int().optional(),
	/** 取得層の不完全性（上流 get_candles の meta.warning を継承）。getCandles 直叩きのため warnings 配列は無し。 */
	warning: z.string().optional(),
}).passthrough();

export const AnalyzeFibonacciOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		content: z.array(z.object({ type: z.literal('text'), text: z.string() })).optional(),
		data: AnalyzeFibonacciDataSchemaOut,
		meta: AnalyzeFibonacciMetaSchemaOut,
	}),
	FailResultSchema,
]);

// === Multi-Timeframe Fibonacci Analysis ===

export const AnalyzeMtfFibonacciInputSchema = BasePairInputSchema.extend({
	lookbackDays: z.array(z.number().int().min(14).max(365)).optional().default([30, 90, 180]),
});

const MtfFibonacciPerPeriodSchema = z
	.object({
		lookbackDays: z.number().int(),
		trend: z.enum(['up', 'down']),
		swingHigh: z.object({ price: z.number(), date: z.string() }),
		swingLow: z.object({ price: z.number(), date: z.string() }),
		levels: z.array(FibonacciLevelSchema),
	})
	.passthrough();

const ConfluenceZoneSchema = z.object({
	priceZone: z.tuple([z.number(), z.number()]),
	matchedLevels: z.array(
		z.object({
			lookbackDays: z.number().int(),
			ratio: z.number(),
			price: z.number(),
		}),
	),
	strength: z.enum(['strong', 'moderate', 'weak']),
	distancePct: z.number(),
});

export const AnalyzeMtfFibonacciDataSchemaOut = z
	.object({
		pair: z.string(),
		currentPrice: z.number(),
		periods: z.record(z.string(), MtfFibonacciPerPeriodSchema),
		confluence: z.array(ConfluenceZoneSchema),
	})
	.passthrough();

export const AnalyzeMtfFibonacciMetaSchemaOut = BaseMetaSchema.extend({
	lookbackDays: z.array(z.number().int()),
	/** 取得層の不完全性。子 analyze_fibonacci の meta.warning / 失敗期間の synthetic message を `[Nd]` prefix 付きで集約。 */
	warning: z.string().optional(),
}).passthrough();

export const AnalyzeMtfFibonacciOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		content: z.array(z.object({ type: z.literal('text'), text: z.string() })).optional(),
		data: AnalyzeMtfFibonacciDataSchemaOut,
		meta: AnalyzeMtfFibonacciMetaSchemaOut,
	}),
	FailResultSchema,
]);

// === Analyze Volume Profile (VWAP + Volume Profile + Trade Size Distribution) ===
export const AnalyzeVolumeProfileInputSchema = BasePairInputSchema.extend({
	hours: z
		.number()
		.min(0.5)
		.max(24)
		.optional()
		.default(4)
		.describe('直近N時間分の約定を取得（デフォルト4h）。limit より優先'),
	limit: z.number().int().min(50).max(2000).optional().default(500).describe('取得する約定件数。hours 指定時は無視'),
	bins: z.number().int().min(5).max(100).optional().default(20).describe('Volume Profile の価格帯分割数'),
	valueAreaPct: z
		.number()
		.min(0.5)
		.max(0.95)
		.optional()
		.default(0.7)
		.describe('Value Area のカバー率（デフォルト70%）'),
	tz: z.string().optional().default('Asia/Tokyo'),
});

const VwapBandSchema = z.object({
	upper2sigma: z.number(),
	upper1sigma: z.number(),
	lower1sigma: z.number(),
	lower2sigma: z.number(),
});

const VolumeProfileBinSchema = z.object({
	low: z.number(),
	high: z.number(),
	label: z.string(),
	buyVolume: z.number(),
	sellVolume: z.number(),
	totalVolume: z.number(),
	pct: z.number(),
	dominant: z.enum(['buy', 'sell', 'balanced']),
});

const TradeSizeCategorySchema = z.object({
	label: z.string(),
	minSize: z.number(),
	maxSize: z.number().nullable(),
	count: z.number().int(),
	volume: z.number(),
	pct: z.number(),
	buyVolume: z.number(),
	sellVolume: z.number(),
});

export const AnalyzeVolumeProfileDataSchemaOut = z.object({
	vwap: z.object({
		price: z.number(),
		stdDev: z.number(),
		bands: VwapBandSchema,
		currentPrice: z.number(),
		deviationPct: z.number(),
		position: z.enum(['above_2sigma', 'above_1sigma', 'at_vwap', 'below_1sigma', 'below_2sigma']),
		interpretation: z.string(),
	}),
	profile: z.object({
		bins: z.array(VolumeProfileBinSchema),
		poc: z.object({ price: z.number(), volume: z.number(), binIndex: z.number().int() }),
		valueArea: z.object({ high: z.number(), low: z.number(), volume: z.number(), pct: z.number() }),
	}),
	tradeSizes: z.object({
		categories: z.array(TradeSizeCategorySchema),
		thresholds: z.object({ p25: z.number(), p75: z.number(), p95: z.number() }),
		largeTradeBias: z.object({
			buyVolume: z.number(),
			sellVolume: z.number(),
			ratio: z.number().nullable(),
			interpretation: z.string(),
		}),
	}),
	params: z.object({
		totalTrades: z.number().int(),
		totalVolume: z.number(),
		priceRange: z.object({ high: z.number(), low: z.number() }),
		timeRange: z.object({ start: z.string(), end: z.string(), durationMin: z.number() }),
		bins: z.number().int(),
		valueAreaPct: z.number(),
	}),
});

export const AnalyzeVolumeProfileMetaSchemaOut = BaseMetaSchema.extend({
	count: z.number().int(),
});

export const AnalyzeVolumeProfileOutputSchema = toolResultSchema(
	AnalyzeVolumeProfileDataSchemaOut,
	AnalyzeVolumeProfileMetaSchemaOut,
);

// ── analyze_currency_strength ──

export const AnalyzeCurrencyStrengthInputSchema = z.object({
	topN: z.number().int().min(3).max(30).optional().default(10).describe('分析対象の上位ペア数（出来高順で選出）'),
	type: CandleTypeEnum.optional().default('1day').describe('RSI/SMA 算出に使うローソク足の種類'),
});

const CurrencyStrengthItemSchema = z.object({
	pair: z.string(),
	currency: z.string().describe('通貨コード（例: BTC）'),
	score: z.number().describe('総合強弱スコア（-100〜+100）'),
	rank: z.number().int(),
	components: z.object({
		change24h: z.number().nullable().describe('24h変化率 %'),
		rsi: z.number().nullable().describe('RSI(14)'),
		smaDeviation: z.number().nullable().describe('現在価格のSMA25からの乖離率 %'),
		volumeRank: z.number().int().describe('出来高順位（1=最大）'),
	}),
	price: z.number().nullable(),
	volumeJPY: z.number().nullable(),
	interpretation: z.enum(['strong_bullish', 'bullish', 'neutral', 'bearish', 'strong_bearish']),
});

export const AnalyzeCurrencyStrengthDataSchemaOut = z.object({
	rankings: z.array(CurrencyStrengthItemSchema),
	summary: z.object({
		totalPairs: z.number().int(),
		analyzedPairs: z.number().int(),
		strongBullish: z.array(z.string()).describe('強気トップ銘柄'),
		strongBearish: z.array(z.string()).describe('弱気ボトム銘柄'),
		marketBias: z.enum(['bullish', 'bearish', 'neutral']).describe('市場全体のバイアス'),
		avgScore: z.number(),
	}),
});

export const AnalyzeCurrencyStrengthMetaSchemaOut = z.object({
	fetchedAt: z.string(),
	type: z.string(),
	topN: z.number().int(),
});

export const AnalyzeCurrencyStrengthOutputSchema = toolResultSchema(
	AnalyzeCurrencyStrengthDataSchemaOut,
	AnalyzeCurrencyStrengthMetaSchemaOut,
);
