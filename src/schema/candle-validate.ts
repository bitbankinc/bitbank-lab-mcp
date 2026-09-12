import { z } from 'zod';
import { BaseMetaSchema, CandleTypeEnum, toolResultSchema } from './base.js';

// ── Input ──

export const ValidateCandleDataInputSchema = z.object({
	pair: z.string().optional().default('btc_jpy'),
	type: CandleTypeEnum.optional().default('1day'),
	date: z
		.string()
		.regex(/^\d{4}(\d{4})?$/, 'YYYYMMDD or YYYY format')
		.optional()
		.describe(
			'YYYYMMDD or YYYY format. If omitted, uses latest data. ' +
				'YYYYMMDD は tz 引数（既定 Asia/Tokyo）の暦日として解釈し、その日の終端以前の足を返します（get_candles と同じ基準）。' +
				'get_transactions / get_flow_metrics の date は UTC 暦日で基準が異なります。',
		),
	limit: z.number().int().min(10).max(1000).optional().default(200).describe('検証対象のローソク足本数（10〜1000）'),
	price_sigma: z
		.number()
		.min(1)
		.max(10)
		.optional()
		.describe('価格変化率がこの σ を超えたら異常値とみなす。省略時はペアのティア（major/mid/minor）に応じて自動設定'),
	volume_multiplier: z
		.number()
		.min(2)
		.max(100)
		.optional()
		.describe('出来高が全体平均の何倍を超えたらスパイクとみなすか。省略時はペアのティアに応じて自動設定'),
	tz: z.string().optional().default('Asia/Tokyo').describe('タイムゾーン（デフォルト: Asia/Tokyo）'),
});

// ── Output sub-schemas ──

const CompletenessSchema = z.object({
	expected: z.number(),
	actual: z.number(),
	missing: z.number(),
	missingTimestamps: z.array(z.string()),
	ratio: z.number(),
});

const DuplicatesSchema = z.object({
	count: z.number(),
	timestamps: z.array(z.string()),
});

const IntegrityIssueSchema = z.object({
	index: z.number(),
	isoTime: z.string().nullable(),
	issues: z.array(z.string()),
});

const IntegritySchema = z.object({
	totalChecked: z.number(),
	invalidCount: z.number(),
	issues: z.array(IntegrityIssueSchema),
});

const PriceAnomalySchema = z.object({
	index: z.number(),
	isoTime: z.string().nullable(),
	returnPct: z.number(),
	sigma: z.number(),
});

const PriceAnomalyResultSchema = z.object({
	totalBars: z.number(),
	anomalyCount: z.number(),
	anomalies: z.array(PriceAnomalySchema),
	stats: z
		.object({
			mean: z.number(),
			stddev: z.number(),
			threshold: z.number(),
		})
		.nullable(),
});

const VolumeAnomalySchema = z.object({
	index: z.number(),
	isoTime: z.string().nullable(),
	volume: z.number(),
	reason: z.enum(['zero', 'spike']),
	multiplier: z.number().optional(),
});

const VolumeAnomalyResultSchema = z.object({
	totalBars: z.number(),
	anomalyCount: z.number(),
	zeroCount: z.number(),
	spikeCount: z.number(),
	anomalies: z.array(VolumeAnomalySchema),
	stats: z
		.object({
			avgVolume: z.number(),
			threshold: z.number(),
		})
		.nullable(),
});

const QualityScoreSchema = z.object({
	score: z.number().min(0).max(100),
	breakdown: z.object({
		completeness: z.number(),
		integrity: z.number(),
		priceStability: z.number(),
		volumeHealth: z.number(),
	}),
	grade: z.enum(['A', 'B', 'C', 'D', 'F']),
});

// ── Output ──

export const ValidateCandleDataDataSchema = z.object({
	completeness: CompletenessSchema,
	duplicates: DuplicatesSchema,
	integrity: IntegritySchema,
	priceAnomalies: PriceAnomalyResultSchema,
	volumeAnomalies: VolumeAnomalyResultSchema,
	qualityScore: QualityScoreSchema,
});

export const ValidateCandleDataMetaSchema = BaseMetaSchema.extend({
	type: CandleTypeEnum,
	count: z.number().int(),
	tier: z.enum(['major', 'mid', 'minor']),
	thresholds: z.object({
		priceSigma: z.number(),
		volumeMultiplier: z.number(),
		zeroVolumePenaltyWeight: z.number(),
	}),
});

export const ValidateCandleDataOutputSchema = toolResultSchema(
	ValidateCandleDataDataSchema,
	ValidateCandleDataMetaSchema,
);
