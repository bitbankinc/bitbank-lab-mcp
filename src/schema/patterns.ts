import { z } from 'zod';
import { BaseMetaSchema, BasePairInputSchema, CandleTypeEnum, FailResultSchema, toolResultSchema } from './base.js';

// === Pattern Detection ===
export const PatternTypeEnum = z.enum([
	'double_top',
	'double_bottom',
	'triple_top',
	'triple_bottom',
	'head_and_shoulders',
	'inverse_head_and_shoulders',
	// legacy umbrella key (kept for filter-compat)
	'triangle',
	// new explicit triangle variants
	'triangle_ascending',
	'triangle_descending',
	'triangle_symmetrical',
	// wedge patterns
	'falling_wedge',
	'rising_wedge',
	'pennant',
	'flag',
]);

export const DetectPatternsInputSchema = BasePairInputSchema.extend({
	type: CandleTypeEnum.optional().default('1day'),
	limit: z.number().int().min(20).max(365).optional().default(90),
	patterns: z
		.array(PatternTypeEnum)
		.optional()
		.describe(
			[
				'Patterns to detect. Recommended params (guideline):',
				'- double_top/double_bottom: default (swingDepth=7, tolerancePct=0.04, minBarsBetweenSwings=5)',
				'- triple_top/triple_bottom: tolerancePct≈0.05',
				'- triangle_*: tolerancePct≈0.06',
				'- pennant: swingDepth≈5, minBarsBetweenSwings≈3',
			].join('\n'),
		),
	// Heuristics
	swingDepth: z.number().int().min(1).max(10).optional().default(7),
	tolerancePct: z.number().min(0).max(0.1).optional().default(0.04),
	minBarsBetweenSwings: z.number().int().min(1).max(30).optional().default(5),
	view: z.enum(['summary', 'detailed', 'full', 'debug']).optional().default('detailed'),
	// New: relevance filter for "current-involved" long-term patterns
	requireCurrentInPattern: z.boolean().optional().default(false),
	currentRelevanceDays: z.number().int().min(1).max(365).optional().default(7),

	// Unified pattern lifecycle options
	includeForming: z.boolean().optional().default(false).describe('形成中パターンを含める'),
	includeCompleted: z.boolean().optional().default(true).describe('完成済みパターンを含める'),
	includeInvalid: z.boolean().optional().default(false).describe('無効化済みパターンを含める'),
	tz: z
		.string()
		.optional()
		.default('Asia/Tokyo')
		.describe(
			'表示日時のタイムゾーン（既定: Asia/Tokyo）。get_candles の tz と揃える。' +
				'pattern の表示日付（期間 / 形成期間 / 文脈期間 / ブレイク確認 / 先行トレンド / pivot / 検出対象期間 等）に適用される。' +
				'構造化データ（data.patterns[*].range.start/end 等）は後方互換のため UTC ISO 文字列のまま不変。' +
				'空文字も Asia/Tokyo にフォールバック。',
		),
});

export const DetectedPatternSchema = z.object({
	type: PatternTypeEnum,
	confidence: z.number().min(0).max(1),
	/** 検出に使用した時間足（例: '1day', '4hour', '1week'） */
	timeframe: CandleTypeEnum.optional(),
	/** 人間可読な時間足ラベル（例: '日足', '4時間足', '週足'） */
	timeframeLabel: z.string().optional(),
	range: z.object({
		start: z
			.string()
			.describe('UTC ISO 文字列。表示は呼び出し側 tz（既定 Asia/Tokyo）で整形される（後方互換のため値自体は不変）。'),
		end: z
			.string()
			.describe('UTC ISO 文字列。表示は呼び出し側 tz（既定 Asia/Tokyo）で整形される（後方互換のため値自体は不変）。'),
	}),
	/**
	 * パターン構成点のみで張る期間（誤読防止のための追加フィールド）。
	 * double_top: peak1 → peak2 / double_bottom: valley1 → valley2 /
	 * H&S・inverse H&S: 左肩 → 右肩。range はブレイク確認日まで含むことがあるが
	 * こちらは構成点だけで閉じる。
	 */
	structureRange: z
		.object({
			start: z
				.string()
				.describe('UTC ISO 文字列。表示は呼び出し側 tz（既定 Asia/Tokyo）で整形される（後方互換のため値自体は不変）。'),
			end: z
				.string()
				.describe('UTC ISO 文字列。表示は呼び出し側 tz（既定 Asia/Tokyo）で整形される（後方互換のため値自体は不変）。'),
		})
		.optional(),
	/**
	 * 検出器自身が確認したブレイク（ネックライン突破等）。
	 * - double_top / double_bottom completed: type='neckline_breakout' を設定
	 * - H&S / inverse H&S: 検出器はネックラインブレイクを確認しないため type='not_confirmed'
	 * - forming パターン: type='not_confirmed'
	 *
	 * パターン検出後の事後分析（`aftermath.breakoutConfirmed`）とは別概念。
	 */
	confirmation: z
		.union([
			z.object({
				type: z.literal('neckline_breakout'),
				date: z.string(),
				idx: z.number().int(),
				price: z.number(),
			}),
			z.object({ type: z.literal('not_confirmed') }),
		])
		.optional(),
	/**
	 * 先行トレンド（パターン形成直前の lookback window のトレンド情報）。
	 * - start: lookback window 先頭の isoTime
	 * - end:   パターン構成開始点（startIdx）の isoTime
	 * - direction: 'up' / 'down' / 'sideways' / 'insufficient_data'
	 * - returnPct: priorReturn を百分率（小数2桁）に整形した値
	 */
	precedingTrend: z
		.object({
			start: z
				.string()
				.describe('UTC ISO 文字列。表示は呼び出し側 tz（既定 Asia/Tokyo）で整形される（後方互換のため値自体は不変）。'),
			end: z
				.string()
				.describe('UTC ISO 文字列。表示は呼び出し側 tz（既定 Asia/Tokyo）で整形される（後方互換のため値自体は不変）。'),
			direction: z.enum(['up', 'down', 'sideways', 'insufficient_data']),
			returnPct: z.number(),
			lookbackBars: z.number().int(),
		})
		.optional(),
	pivots: z.array(z.object({ idx: z.number().int(), price: z.number() })).optional(),
	neckline: z
		.array(z.object({ x: z.number().int().optional(), y: z.number() }))
		.length(2)
		.optional(),
	// Optional: structure diagram (static SVG artifact to help beginners grok the pattern shape)
	structureDiagram: z
		.object({
			svg: z.string(),
			artifact: z.object({ identifier: z.string(), title: z.string() }),
		})
		.optional(),
	// 統合: パターンのステータス（形成中/完成度近し/完成済み/無効化）
	status: z.enum(['forming', 'near_completion', 'completed', 'invalid']).optional(),
	// 形成中パターン用フィールド
	apexDate: z.string().optional(), // アペックス（頂点）到達予定日
	daysToApex: z.number().int().optional(), // アペックスまでの日数
	completionPct: z.number().int().optional(), // 完成度（%）
	// 完成済みパターン用フィールド
	breakoutDate: z.string().optional(), // ブレイクアウト日
	breakoutBarIndex: z.number().int().optional(), // ブレイクアウトしたローソク足のインデックス
	daysSinceBreakout: z.number().int().optional(), // ブレイクアウトからの経過日数
	// ブレイク方向と結果
	breakoutDirection: z.enum(['up', 'down']).optional(), // ブレイク方向
	outcome: z.enum(['success', 'failure']).optional(), // パターン結果（期待通り=success, 逆方向=failure）
	// ターゲット価格（ブレイクアウト後の想定到達価格）
	breakoutTarget: z.number().optional(), // 想定ターゲット価格（円）
	targetMethod: z.enum(['flagpole_projection', 'pattern_height', 'neckline_projection']).optional(), // 計算根拠
	targetReachedPct: z.number().optional(), // ターゲットまでの進捗率（%）
	// 用語正規化ラベル（neckline フィールドが何を指すかをパターン種別ごとに明示）
	trendlineLabel: z.string().optional(),
	// ペナント用: フラッグポール（旗竿）情報
	poleDirection: z.enum(['up', 'down']).optional(), // フラッグポールの方向
	priorTrendDirection: z.enum(['bullish', 'bearish']).optional(), // 先行トレンド方向
	isTrendContinuation: z.boolean().optional(), // ブレイク方向が先行トレンドと一致しているか
	flagpoleHeight: z.number().optional(), // フラッグポールの値幅
	retracementRatio: z.number().optional(), // フラッグポールに対する戻し比率（0.38未満ならペナント的）
	aftermath: z
		.object({
			breakoutDate: z.string().nullable().optional(),
			breakoutConfirmed: z.boolean(),
			priceMove: z
				.object({
					days3: z.object({ return: z.number(), high: z.number(), low: z.number() }).nullable().optional(),
					days7: z.object({ return: z.number(), high: z.number(), low: z.number() }).nullable().optional(),
					days14: z.object({ return: z.number(), high: z.number(), low: z.number() }).nullable().optional(),
				})
				.optional(),
			targetReached: z.boolean(),
			theoreticalTarget: z.number().nullable().optional(),
			outcome: z.string(),
			// New: number of bars (days for 1day, weeks for 1week, etc.) to reach theoretical target (if reached within evaluation window)
			daysToTarget: z.number().int().nullable().optional(),
		})
		.optional(),
});

export const DetectPatternsOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: z.object({
			patterns: z.array(DetectedPatternSchema),
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
				})
				.optional(),
			warnings: z
				.array(
					z.object({
						type: z.string(),
						message: z.string(),
						suggestedParams: z.record(z.string(), z.any()).optional(),
					}),
				)
				.optional(),
			statistics: z
				.record(
					z.string(),
					z.object({
						detected: z.number().int(),
						withAftermath: z.number().int(),
						successRate: z.number().nullable(),
						avgReturn7d: z.number().nullable(),
						avgReturn14d: z.number().nullable(),
						medianReturn7d: z.number().nullable(),
					}),
				)
				.optional(),
		}),
		meta: z.object({
			pair: z.string(),
			type: CandleTypeEnum,
			count: z.number().int(),
			visualization_hints: z
				.object({
					preferred_style: z.enum(['candles', 'line']).optional(),
					highlight_patterns: z.array(PatternTypeEnum).optional(),
				})
				.optional(),
			debug: z
				.object({
					swings: z
						.array(
							z.object({
								idx: z.number().int(),
								price: z.number(),
								kind: z.enum(['H', 'L']),
								isoTime: z.string().optional(),
							}),
						)
						.optional(),
					candidates: z
						.array(
							z.object({
								type: PatternTypeEnum,
								accepted: z.boolean(),
								reason: z.string().optional(),
								indices: z.array(z.number().int()).optional(),
								points: z
									.array(
										z.object({
											role: z.string(),
											idx: z.number().int(),
											price: z.number(),
											isoTime: z.string().optional(),
										}),
									)
									.optional(),
								details: z.any().optional(),
							}),
						)
						.optional(),
				})
				.optional(),
			warning: z.string().optional(),
			warnings: z.array(z.string()).optional(),
		}),
	}),
	FailResultSchema,
]);

// === Candle Patterns (2-bar patterns: engulfing, harami, etc.) ===

export const CandlePatternTypeEnum = z.enum([
	// 2本足パターン (Phase 1-2)
	'bullish_engulfing',
	'bearish_engulfing',
	'bullish_harami',
	'bearish_harami',
	'tweezer_top',
	'tweezer_bottom',
	'dark_cloud_cover',
	'piercing_line',
	// 1本足パターン (Phase 3)
	'hammer',
	'shooting_star',
	'doji',
	// 3本足パターン (Phase 3)
	'morning_star',
	'evening_star',
	'three_white_soldiers',
	'three_black_crows',
]);

export const AnalyzeCandlePatternsInputSchema = z.object({
	pair: z.string().optional().default('btc_jpy'),
	timeframe: z.literal('1day').optional().default('1day'),
	// as_of: 主要パラメータ名（ISO形式 "2025-11-05" または YYYYMMDD "20251105" を受け付け）
	as_of: z
		.string()
		.optional()
		.describe('Date to analyze (ISO "2025-11-05" or YYYYMMDD "20251105"). If omitted, uses latest data.'),
	// date: 互換性のため残す（as_of が優先）
	date: z
		.string()
		.regex(/^\d{8}$/)
		.optional()
		.describe('DEPRECATED: Use as_of instead. YYYYMMDD format.'),
	window_days: z.number().int().min(3).max(10).optional().default(5),
	focus_last_n: z.number().int().min(2).max(5).optional().default(5),
	patterns: z
		.array(CandlePatternTypeEnum)
		.optional()
		.describe('Patterns to detect. If omitted, all patterns are checked.'),
	history_lookback_days: z.number().int().min(30).max(365).optional().default(180),
	history_horizons: z.array(z.number().int().min(1).max(10)).optional().default([1, 3, 5]),
	allow_partial_patterns: z.boolean().optional().default(true),
});

const HistoryHorizonStatsSchema = z.object({
	avg_return: z.number(),
	win_rate: z.number(),
	sample: z.number().int(),
});

const HistoryStatsSchema = z.object({
	lookback_days: z.number().int(),
	occurrences: z.number().int(),
	horizons: z.record(z.string(), HistoryHorizonStatsSchema),
});

const LocalContextSchema = z.object({
	trend_before: z.enum(['up', 'down', 'neutral']),
	volatility_level: z.enum(['low', 'medium', 'high']),
});

const DetectedCandlePatternSchema = z.object({
	pattern: CandlePatternTypeEnum,
	pattern_jp: z.string(),
	direction: z.enum(['bullish', 'bearish', 'neutral']),
	strength: z.number().min(0).max(1),
	candle_range_index: z.tuple([z.number().int(), z.number().int()]),
	uses_partial_candle: z.boolean(),
	status: z.enum(['confirmed', 'forming']),
	local_context: LocalContextSchema,
	history_stats: HistoryStatsSchema.nullable(),
});

const WindowCandleSchema = z.object({
	timestamp: z.string(),
	open: z.number(),
	high: z.number(),
	low: z.number(),
	close: z.number(),
	volume: z.number(),
	is_partial: z.boolean(),
});

export const AnalyzeCandlePatternsDataSchemaOut = z.object({
	pair: z.string(),
	timeframe: z.string(),
	snapshot_time: z.string(),
	window: z.object({
		from: z.string(),
		to: z.string(),
		candles: z
			.array(WindowCandleSchema)
			.describe(
				'CRITICAL: Array order is [oldest, ..., newest]. index 0 = most distant, index n-1 = latest (possibly partial).',
			),
	}),
	recent_patterns: z.array(DetectedCandlePatternSchema),
	summary: z.string(),
});

export const AnalyzeCandlePatternsMetaSchemaOut = BaseMetaSchema.extend({
	timeframe: z.string(),
	as_of: z.string().nullable().describe('Original input value (ISO or YYYYMMDD)'),
	date: z.string().nullable().describe('YYYYMMDD normalized, null for latest'),
	window_days: z.number().int(),
	patterns_checked: z.array(CandlePatternTypeEnum),
	history_lookback_days: z.number().int(),
	history_horizons: z.array(z.number().int()),
	warning: z.string().optional(),
});

export const AnalyzeCandlePatternsOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		content: z.array(z.object({ type: z.literal('text'), text: z.string() })).optional(),
		data: AnalyzeCandlePatternsDataSchemaOut,
		meta: AnalyzeCandlePatternsMetaSchemaOut,
	}),
	FailResultSchema,
]);

// === Candle Pattern Diagram (2-bar pattern visualization) ===

const DiagramCandleSchema = z.object({
	date: z.string().describe('Display date e.g. "11/6(木)"'),
	open: z.number(),
	high: z.number(),
	low: z.number(),
	close: z.number(),
	type: z.enum(['bullish', 'bearish']),
	isPartial: z.boolean().optional(),
});

const DiagramPatternSchema = z.object({
	name: z.string().describe('Pattern name in Japanese e.g. "陽線包み線"'),
	nameEn: z.string().optional().describe('Pattern name in English e.g. "bullish_engulfing"'),
	confirmedDate: z.string().describe('Confirmed date e.g. "11/9(日)"'),
	involvedIndices: z.tuple([z.number().int().min(0), z.number().int().min(0)]).describe('[prevIndex, confirmedIndex]'),
	direction: z.enum(['bullish', 'bearish']).optional(),
});

export const RenderCandlePatternDiagramInputSchema = z.object({
	candles: z.array(DiagramCandleSchema).min(2).max(10).describe('Candle data array (oldest first)'),
	pattern: DiagramPatternSchema.optional().describe('Pattern to highlight'),
	title: z.string().optional().describe('Chart title (default: pattern name or "ローソク足チャート")'),
	theme: z.enum(['dark', 'light']).optional().default('dark'),
});

export const RenderCandlePatternDiagramDataSchemaOut = z.object({
	svg: z.string().optional(),
	filePath: z.string().optional(),
	url: z.string().optional(),
});

export const RenderCandlePatternDiagramMetaSchemaOut = z.object({
	width: z.number().int(),
	height: z.number().int(),
	candleCount: z.number().int(),
	patternName: z.string().nullable(),
});

export const RenderCandlePatternDiagramOutputSchema = toolResultSchema(
	RenderCandlePatternDiagramDataSchemaOut,
	RenderCandlePatternDiagramMetaSchemaOut,
);
