import type { z } from 'zod';
import { nowIso } from '../lib/datetime.js';
import { formatSummary } from '../lib/formatter.js';
import { fail, failFromError, failFromValidation, ok } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { extractUpstreamWarning, prependWarnings } from '../lib/warning-propagation.js';
import {
	type AnalyzeBbSnapshotDataSchemaOut,
	AnalyzeBbSnapshotInputSchema,
	AnalyzeBbSnapshotOutputSchema,
} from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import analyzeIndicators from './analyze_indicators.js';

export interface BbTimeseriesEntry {
	time: string;
	zScore: number | null;
	bandWidthPct: number | null;
}

export interface BuildBbDefaultTextInput {
	baseSummary: string;
	position: string | null;
	bandwidth_state: string | null;
	volatility_trend: string | null;
	bandWidthPct_percentile: number | null;
	current_vs_avg: string | null;
	signals: string[];
	next_steps: {
		if_need_detail: string;
		if_need_visualization: string;
		if_extreme_detected?: string;
	};
	mid: number | null;
	upper: number | null;
	lower: number | null;
	zScore: number | null;
	bandWidthPct: number | null;
	timeseries: BbTimeseriesEntry[] | null;
}

/** テキスト組み立て（BBデフォルトモード表示）— テスト可能な純粋関数 */
export function buildBbDefaultText(input: BuildBbDefaultTextInput): string {
	const {
		baseSummary,
		position,
		bandwidth_state,
		volatility_trend,
		bandWidthPct_percentile,
		current_vs_avg,
		signals,
		next_steps,
		mid,
		upper,
		lower,
		zScore,
		bandWidthPct,
		timeseries,
	} = input;
	return (
		[
			String(baseSummary),
			'',
			`Position: ${position ?? 'n/a'}`,
			`Band State: ${bandwidth_state ?? 'n/a'}`,
			`Volatility Trend: ${volatility_trend ?? 'n/a'}`,
			...(bandWidthPct_percentile != null
				? [`Band Width Percentile: ${bandWidthPct_percentile}th (${current_vs_avg} vs avg)`]
				: []),
			'',
			'Signals:',
			...(signals?.length ? signals.map((s) => `- ${s}`) : ['- None']),
			'',
			'Next Steps:',
			`- ${next_steps.if_need_detail}`,
			`- ${next_steps.if_need_visualization}`,
			'',
			'📊 数値データ:',
			`BB middle:${mid} upper:${upper} lower:${lower} zScore:${zScore?.toFixed(3)} bw:${bandWidthPct?.toFixed(2)}%`,
			...(timeseries
				? [
						'',
						`📋 直近${timeseries.length}本のBB推移:`,
						...timeseries.map((t) => `${t.time.slice(0, 10)} z:${t.zScore} bw:${t.bandWidthPct}%`),
					]
				: []),
		].join('\n') +
		`\n\n---\n📌 含まれるもの: ボリンジャーバンド（±2σ）、Zスコア、バンド幅、直近30本の推移` +
		`\n📌 含まれないもの: 他のテクニカル指標（RSI・MACD・一目均衡表）、出来高フロー、板情報` +
		`\n📌 補完ツール: analyze_indicators（他指標）, analyze_ichimoku_snapshot（一目）, get_flow_metrics（出来高）, get_volatility_metrics（ボラ詳細）`
	);
}

export default async function analyzeBbSnapshot(
	pair: string = 'btc_jpy',
	type: string = '1day',
	limit: number = 120,
	mode: 'default' | 'extended' = 'default',
) {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk, AnalyzeBbSnapshotOutputSchema);
	try {
		const indRes = await analyzeIndicators(chk.pair, type, Math.max(60, limit));
		if (!indRes?.ok)
			return AnalyzeBbSnapshotOutputSchema.parse(
				fail(indRes?.summary || 'indicators failed', (indRes?.meta as { errorType?: string })?.errorType || 'internal'),
			) as ReturnType<typeof fail>;

		// 上流 analyze_indicators の meta.warning（取得層）と meta.warnings（計算層）を別系統で伝播する。
		const { warning, warnings } = extractUpstreamWarning(indRes.meta);

		const close = indRes.data.normalized.at(-1)?.close ?? null;
		const mid = indRes.data.indicators.BB2_middle ?? indRes.data.indicators.BB_middle ?? null;
		const upper = indRes.data.indicators.BB2_upper ?? indRes.data.indicators.BB_upper ?? null;
		const lower = indRes.data.indicators.BB2_lower ?? indRes.data.indicators.BB_lower ?? null;

		let zScore: number | null = null;
		if (close != null && mid != null && upper != null && lower != null) {
			const halfWidth = (upper - lower) / 2;
			if (halfWidth > 0) zScore = (close - mid) / halfWidth;
		}
		let bandWidthPct: number | null = null;
		if (upper != null && lower != null && mid != null && mid !== 0) bandWidthPct = ((upper - lower) / mid) * 100;

		const tags: string[] = [];
		if (zScore != null && zScore > 1) tags.push('above_upper_band_risk');
		if (zScore != null && zScore < -1) tags.push('below_lower_band_risk');

		const summaryBase = formatSummary({
			pair: chk.pair,
			latest: close ?? undefined,
			extra: `z=${zScore?.toFixed(2) ?? 'n/a'} bw=${bandWidthPct?.toFixed(2) ?? 'n/a'}%`,
		});
		// Build helper timeseries (last 30)
		const candles = indRes?.data?.normalized as Array<{ isoTime?: string; close: number }> | undefined;
		const bbSeries = (
			indRes?.data?.indicators as { bb2_series?: { upper: number[]; middle: number[]; lower: number[] } }
		)?.bb2_series;
		const timeseries = (() => {
			try {
				if (!candles || !bbSeries) return null;
				const n = Math.min(30, candles.length, bbSeries.middle.length, bbSeries.upper.length, bbSeries.lower.length);
				const arr: Array<{ time: string; zScore: number | null; bandWidthPct: number | null }> = [];
				for (let i = n; i >= 1; i--) {
					const idx = candles.length - i;
					const t = candles[idx]?.isoTime || '';
					const m = bbSeries.middle[idx];
					const u = bbSeries.upper[idx];
					const l = bbSeries.lower[idx];
					const c = candles[idx]?.close;
					const half = (u - l) / 2;
					const z = m != null && half > 0 ? (c - m) / half : null;
					const bw = m ? ((u - l) / m) * 100 : null;
					arr.push({
						time: t,
						zScore: z == null ? null : Number(z.toFixed(2)),
						bandWidthPct: bw == null ? null : Number(bw.toFixed(2)),
					});
				}
				return arr;
			} catch {
				return null;
			}
		})();

		if (mode === 'default') {
			const position =
				zScore == null
					? null
					: Math.abs(zScore) < 0.3
						? 'near_middle'
						: zScore >= 1.8
							? 'at_upper'
							: zScore <= -1.8
								? 'at_lower'
								: zScore > 0
									? 'upper_zone'
									: 'lower_zone';
			const bw = bandWidthPct ?? 0;
			const bandwidth_state = bw <= 8 ? 'squeeze' : bw <= 18 ? 'normal' : bw <= 30 ? 'expanding' : 'wide';
			// 統計情報の計算（過去30本のバンド幅から）
			const context = (() => {
				if (!timeseries || timeseries.length === 0 || bandWidthPct == null) {
					return {
						bandWidthPct_30d_avg: null as number | null,
						bandWidthPct_percentile: null as number | null,
						current_vs_avg: null as string | null,
					};
				}

				const bandWidths = timeseries.map((t) => t.bandWidthPct).filter((bw): bw is number => bw != null);

				if (bandWidths.length === 0) {
					return {
						bandWidthPct_30d_avg: null as number | null,
						bandWidthPct_percentile: null as number | null,
						current_vs_avg: null as string | null,
					};
				}

				const avg = bandWidths.reduce((a, b) => a + b, 0) / bandWidths.length;
				const sorted = [...bandWidths].sort((a, b) => a - b);
				const below = sorted.filter((bw) => bw < (bandWidthPct as number)).length;
				const percentile = Math.round((below / sorted.length) * 100);
				const diffPct = avg !== 0 ? (((bandWidthPct as number) - avg) / avg) * 100 : 0;
				const current_vs_avg = `${diffPct > 0 ? '+' : ''}${diffPct.toFixed(1)}%`;

				return {
					bandWidthPct_30d_avg: Number(avg.toFixed(2)),
					bandWidthPct_percentile: percentile,
					current_vs_avg,
				};
			})();

			// ボラティリティトレンドの判定（直近5本 vs それ以前）
			const volatility_trend = (() => {
				if (!timeseries || timeseries.length < 10) return 'stable' as const;
				const recent5 = timeseries
					.slice(-5)
					.map((t) => t.bandWidthPct)
					.filter((bw): bw is number => bw != null);
				const prev5 = timeseries
					.slice(-10, -5)
					.map((t) => t.bandWidthPct)
					.filter((bw): bw is number => bw != null);
				if (recent5.length === 0 || prev5.length === 0) return 'stable' as const;
				const recentAvg = recent5.reduce((a, b) => a + b, 0) / recent5.length;
				const prevAvg = prev5.reduce((a, b) => a + b, 0) / prev5.length;
				const change = (recentAvg - prevAvg) / prevAvg;
				if (change > 0.1) return 'increasing' as const;
				if (change < -0.1) return 'decreasing' as const;
				return 'stable' as const;
			})();

			const interpretation = { position, bandwidth_state, volatility_trend } as const;

			const signals: string[] = [];
			if (position === 'near_middle') signals.push('Price consolidating near middle band');
			if (bandwidth_state === 'normal') signals.push('Band width around typical levels');

			// 統計情報を使った追加シグナル
			if (context.bandWidthPct_30d_avg != null && context.current_vs_avg != null) {
				if (context.bandWidthPct_percentile != null) {
					if (context.bandWidthPct_percentile < 20) {
						signals.push(
							`Band width compressed (${context.bandWidthPct_percentile}th percentile) - potential breakout setup`,
						);
					} else if (context.bandWidthPct_percentile > 80) {
						signals.push(
							`Band width expanded (${context.bandWidthPct_percentile}th percentile) - high volatility phase`,
						);
					}
				}
				signals.push(`Band width ${context.current_vs_avg} vs 30-day average`);
			}

			if (volatility_trend === 'increasing') {
				signals.push('Volatility increasing in recent periods');
			} else if (volatility_trend === 'decreasing') {
				signals.push('Volatility decreasing - potential squeeze forming');
			}

			if (!signals.length) signals.push('No extreme positioning detected');
			const next_steps = {
				if_need_detail: "Use mode='extended' for ±1σ/±3σ analysis",
				if_need_visualization: 'Use render_chart_svg with withBB=true',
				if_extreme_detected: 'Consider get_volatility_metrics for deeper analysis',
			};
			const data: z.infer<typeof AnalyzeBbSnapshotDataSchemaOut> = {
				mode,
				price: close ?? null,
				bb: { middle: mid, upper, lower, zScore, bandWidthPct },
				interpretation,
				context,
				signals,
				next_steps,
			};
			// content 強化用: LLM が本文だけ見ても要点が掴めるように複数行の要約を生成
			const baseSummaryLines = buildBbDefaultText({
				baseSummary: summaryBase,
				position: interpretation.position,
				bandwidth_state: interpretation.bandwidth_state,
				volatility_trend: interpretation.volatility_trend,
				bandWidthPct_percentile: context.bandWidthPct_percentile,
				current_vs_avg: context.current_vs_avg,
				signals,
				next_steps,
				mid,
				upper,
				lower,
				zScore,
				bandWidthPct,
				timeseries,
			});
			const summaryLines = prependWarnings(baseSummaryLines, { warning, warnings }, { separator: '\n' });
			const meta = createMeta(chk.pair, {
				type,
				count: indRes.data.normalized.length,
				mode,
				extra: {
					timeseries: timeseries ? { last_30_candles: timeseries } : undefined,
					metadata: {
						calculation_params: { period: 20, std_dev_multiplier: 2 },
						data_quality: 'complete',
						last_updated: nowIso(),
					},
				},
				...(warning ? { warning } : {}),
				...(warnings && warnings.length > 0 ? { warnings } : {}),
			});
			return AnalyzeBbSnapshotOutputSchema.parse(ok(summaryLines, data, meta));
		}

		// extended mode
		const bbBands: Record<string, number | null> = {
			'+3σ': null,
			'+2σ': upper,
			'+1σ': null,
			'-1σ': null,
			'-2σ': lower,
			'-3σ': null,
		};
		const bandWidthAll: Record<string, number | null> = { '±1σ': null, '±2σ': bandWidthPct, '±3σ': null };
		const current_zone =
			zScore == null
				? null
				: Math.abs(zScore) <= 1
					? 'within_1σ'
					: Math.abs(zScore) <= 2
						? '1σ_to_2σ'
						: Math.abs(zScore) <= 3
							? 'beyond_2σ'
							: 'beyond_3σ';
		const data: z.infer<typeof AnalyzeBbSnapshotDataSchemaOut> = {
			mode,
			price: close ?? null,
			bb: { middle: mid, bands: bbBands, zScore, bandWidthPct: bandWidthAll },
			position_analysis: { current_zone },
			extreme_events: {
				touches_3σ_last_30d: null,
				touches_2σ_last_30d: null,
				band_walk_detected: null,
				squeeze_percentile: null,
			},
			interpretation: { volatility_state: null, extreme_risk: null, mean_reversion_potential: null },
			tags,
		};
		const meta = createMeta(chk.pair, {
			type,
			count: indRes.data.normalized.length,
			mode,
			extra: {
				timeseries: timeseries ? { last_30_candles: timeseries } : undefined,
				metadata: {
					calculation_params: { period: 20, std_dev_multiplier: 2 },
					data_quality: 'complete',
					last_updated: nowIso(),
				},
			},
			...(warning ? { warning } : {}),
			...(warnings && warnings.length > 0 ? { warnings } : {}),
		});
		const baseExtSummary =
			summaryBase +
			`\n\n---\n📌 含まれるもの: ボリンジャーバンド拡張（±1σ/±2σ/±3σ）、Zスコア、バンド幅` +
			`\n📌 含まれないもの: 他のテクニカル指標（RSI・MACD・一目均衡表）、出来高フロー、板情報` +
			`\n📌 補完ツール: analyze_indicators（他指標）, get_flow_metrics（出来高）, get_volatility_metrics（ボラ詳細）`;
		const extSummary = prependWarnings(baseExtSummary, { warning, warnings }, { separator: '\n' });
		return AnalyzeBbSnapshotOutputSchema.parse(ok(extSummary, data, meta));
	} catch (e: unknown) {
		return failFromError(e, { schema: AnalyzeBbSnapshotOutputSchema });
	}
}

// ── MCP ツール定義（tool-registry から自動収集） ──
export const toolDef: ToolDefinition = {
	name: 'analyze_bb_snapshot',
	description: `[Bollinger Bands / BB / Squeeze] ボリンジャーバンド（BB / squeeze / bandwidth / zScore）の数値スナップショット。軽量・BB特化。

mode=default: ±2σ帯の基本情報 / mode=extended: ±1σ/±2σ/±3σの詳細分析。

⚠️ 最新値のみ。時系列チャート描画 → prepare_chart_data（indicators: ["BB"]）。`,
	inputSchema: AnalyzeBbSnapshotInputSchema,
	handler: async ({
		pair,
		type,
		limit,
		mode,
	}: {
		pair?: string;
		type?: string;
		limit?: number;
		mode?: 'default' | 'extended';
	}) => analyzeBbSnapshot(pair, type, limit, mode),
};
