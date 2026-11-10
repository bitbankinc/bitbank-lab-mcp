import type { z } from 'zod';
import { barsAgoLabel, formatExactPrice, formatPriceAtLevel } from '../../lib/formatter.js';
import { rsiZoneLabel } from '../../lib/indicator-zones.js';
import { currentCloudSpans } from '../../lib/indicators.js';
import { extractUpstreamWarning, prependWarnings } from '../../lib/warning-propagation.js';
import analyzeMarketSignal from '../../tools/analyze_market_signal.js';
import { AnalyzeMarketSignalInputSchema, AnalyzeMarketSignalOutputSchema } from '../schemas.js';
import type { ToolDefinition } from '../tool-definition.js';

export type BuildMarketSignalHandlerTextInput = {
	pair: string;
	type: string;
	score: number;
	recommendation: string;
	confidence: string;
	confidenceReason: string;
	scoreRange: { displayMin?: number; displayMax?: number; neutralBandDisplay?: { min: number; max: number } } | null;
	topContributors: string[];
	sma: {
		current: number | null;
		values: { sma25: number | null; sma75: number | null; sma200: number | null };
		deviations: { vs25: number | null; vs75: number | null; vs200: number | null };
		arrangement: string;
		recentCross: { type: string; pair: string; barsAgo: number } | null;
	} | null;
	supplementary: {
		rsi: number | null;
		ichimokuSpanA: number | null;
		ichimokuSpanB: number | null;
		macdHist: number | null;
	};
	breakdownArray: Array<{
		factor: string;
		weight: number;
		rawScore: number;
		contribution: number;
		interpretation: string;
	}>;
	contributions: Record<string, number> | null;
	weights: Record<string, number> | null;
	nextActions: Array<{ priority: string; tool: string; reason: string }>;
};

export function buildMarketSignalHandlerText(input: BuildMarketSignalHandlerTextInput): string {
	const {
		pair,
		type,
		score,
		recommendation,
		confidence,
		confidenceReason,
		scoreRange,
		topContributors,
		sma,
		supplementary,
		breakdownArray,
		contributions,
		weights,
		nextActions,
	} = input;

	const score100 = Math.round(score * 100);
	const range = scoreRange?.displayMin != null ? `${scoreRange.displayMin}〜${scoreRange.displayMax}` : '-100〜+100';
	const neutralLine = scoreRange?.neutralBandDisplay
		? `${scoreRange.neutralBandDisplay.min}〜${scoreRange.neutralBandDisplay.max}`
		: '-10〜+10';

	const lines: string[] = [];
	lines.push(`${String(pair).toUpperCase()} [${String(type || '1day')}]`);
	lines.push(
		`総合スコア: ${score100}（範囲: ${range}、中立域: ${neutralLine}） → 判定: ${recommendation}（信頼度: ${confidence}${confidenceReason ? `: ${confidenceReason}` : ''}）`,
	);
	if (topContributors.length) lines.push(`主要因: ${topContributors.join(', ')}`);

	if (sma) {
		const curPx = sma.current != null && Number.isFinite(sma.current) ? formatExactPrice(sma.current) : null;
		const v = sma.values;
		const dev = sma.deviations;
		const arr = sma.arrangement;
		if (curPx || v.sma25 != null || v.sma75 != null || v.sma200 != null) {
			lines.push('');
			lines.push('【SMA（移動平均線）詳細】');
			if (curPx) lines.push(`現在価格: ${curPx}円`);
			const fmtVs = (x: number | null) => (x == null ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`);
			const dir = (x: number | null) => (x == null ? '' : x >= 0 ? '上' : '下');
			const s25 = v.sma25 != null && Number.isFinite(v.sma25) ? formatPriceAtLevel(v.sma25) : 'n/a';
			const s75 = v.sma75 != null && Number.isFinite(v.sma75) ? formatPriceAtLevel(v.sma75) : 'n/a';
			const s200 = v.sma200 != null && Number.isFinite(v.sma200) ? formatPriceAtLevel(v.sma200) : 'n/a';
			lines.push(`- 短期（SMA25）: ${s25}円（今の価格より ${fmtVs(dev.vs25)} ${dir(dev.vs25)}に位置）`);
			lines.push(`- 中期（SMA75）: ${s75}円（今の価格より ${fmtVs(dev.vs75)} ${dir(dev.vs75)}に位置）`);
			lines.push(`- 長期（SMA200）: ${s200}円（今の価格より ${fmtVs(dev.vs200)} ${dir(dev.vs200)}に位置）`);
			const curVal = Number.isFinite(sma.current) ? Number(sma.current) : null;
			const v25 = Number.isFinite(v.sma25) ? Number(v.sma25) : null;
			const v75 = Number.isFinite(v.sma75) ? Number(v.sma75) : null;
			const v200 = Number.isFinite(v.sma200) ? Number(v.sma200) : null;
			const pts: Array<{ label: string; value: number }> = [];
			if (curVal != null) pts.push({ label: '価格', value: curVal });
			if (v25 != null) pts.push({ label: 'SMA25', value: v25 });
			if (v75 != null) pts.push({ label: 'SMA75', value: v75 });
			if (v200 != null) pts.push({ label: 'SMA200', value: v200 });
			if (pts.length >= 3) {
				const order = [...pts]
					.sort((a, b) => b.value - a.value)
					.map((p) => p.label)
					.join(' > ');
				const arrLabel = arr === 'bullish' ? '上昇順' : arr === 'bearish' ? '下降順' : '混在';
				const struct = arr === 'bullish' ? '上昇トレンド構造' : arr === 'bearish' ? '下落トレンド構造' : '方向感が弱い';
				lines.push(`配置: ${order}（${arrLabel} → ${struct}）`);
			} else {
				const arrLabel = arr === 'bullish' ? '上昇順' : arr === 'bearish' ? '下降順' : '混在';
				lines.push(`配置: ${arrLabel}`);
			}
			if (sma.recentCross?.pair === '25/75') {
				const crossJp = sma.recentCross.type === 'golden_cross' ? 'ゴールデンクロス' : 'デッドクロス';
				const ago = Number(sma.recentCross.barsAgo ?? 0);
				const verb = sma.recentCross.type === 'golden_cross' ? '上抜け' : '下抜け';
				lines.push(`直近クロス: ${barsAgoLabel(ago, String(type || '1day'))} SMA25がSMA75を${verb}（${crossJp}）`);
			}
		}
	}

	const { rsi: rsiVal, ichimokuSpanA: spanA, ichimokuSpanB: spanB, macdHist } = supplementary;
	const hasSupplementary = rsiVal != null || (spanA != null && spanB != null) || macdHist != null;
	if (hasSupplementary) {
		lines.push('');
		lines.push('【補足指標】');
		if (rsiVal != null && Number.isFinite(rsiVal)) {
			const rsiRounded = Number(rsiVal).toFixed(2);
			const rsiLabel = rsiZoneLabel(rsiVal);
			lines.push(`RSI(14): ${rsiRounded}（${rsiLabel}）`);
		}
		const curPx = sma?.current;
		if (spanA != null && spanB != null && curPx != null && Number.isFinite(spanA) && Number.isFinite(spanB)) {
			const cloudTop = Math.max(Number(spanA), Number(spanB));
			const cloudBottom = Math.min(Number(spanA), Number(spanB));
			const cloudThickness = Math.abs(cloudTop - cloudBottom);
			const cloudThicknessPct = curPx > 0 ? ((cloudThickness / curPx) * 100).toFixed(1) : 'n/a';
			let positionLabel = '雲の中';
			let distancePct = 'n/a';
			if (curPx > cloudTop) {
				positionLabel = '雲の上';
				distancePct = `+${(((curPx - cloudTop) / curPx) * 100).toFixed(1)}%`;
			} else if (curPx < cloudBottom) {
				positionLabel = '雲の下';
				distancePct = `+${(((cloudBottom - curPx) / curPx) * 100).toFixed(1)}%`;
			} else {
				distancePct = '0%';
			}
			lines.push(`一目均衡表: ${positionLabel}（距離 ${distancePct}、雲の厚さ ${cloudThicknessPct}%）`);
		}
		if (macdHist != null && Number.isFinite(macdHist)) {
			// MACD は価格の差なので、値自体ではなく価格の水準で桁を決める。
			const histRounded = formatPriceAtLevel(macdHist, sma?.current ?? macdHist);
			const macdLabel = macdHist > 0 ? '強気' : '弱気';
			lines.push(`MACD: ヒストグラム ${histRounded}（${macdLabel}）`);
		}
	}

	if (breakdownArray.length) {
		lines.push('');
		lines.push('【内訳（raw×weight=寄与）】');
		for (const b of breakdownArray) {
			const w = `${(Number(b.weight || 0) * 100).toFixed(0)}%`;
			const raw = Number(b.rawScore || 0).toFixed(2);
			const contrib = Number(b.contribution || 0).toFixed(2);
			const interp = String(b.interpretation || 'neutral');
			lines.push(`- ${b.factor}: ${raw}×${w}=${contrib} （${interp}）`);
		}
	} else if (contributions && weights) {
		lines.push('');
		lines.push('【内訳（contribution）】');
		for (const k of Object.keys(contributions)) {
			const c = Number(contributions[k]).toFixed(2);
			const w = weights[k] != null ? `${Math.round(weights[k] * 100)}%` : '';
			lines.push(`- ${k}: ${c}${w ? `（weight ${w}）` : ''}`);
		}
	}

	if (nextActions.length) {
		lines.push('');
		lines.push('【次の確認候補】');
		for (const a of nextActions.slice(0, 3)) {
			const pri = a.priority === 'high' ? '高' : a.priority === 'medium' ? '中' : '低';
			const reason = a.reason ? ` - ${a.reason}` : '';
			lines.push(`- (${pri}) ${a.tool}${reason}`);
		}
	}

	return lines.join('\n');
}

export const toolDef: ToolDefinition = {
	name: 'analyze_market_signal',
	description:
		'[Market Signal / Score / Triage] 市場の総合シグナル（market signal / composite score / bull-bear / triage）。5要素（板圧力・CVD・モメンタム・ボラティリティ・SMAトレンド）を-100〜+100の単一スコアで瞬時評価。分析の起点・スクリーニングに最適。\n\n⚠️ 最新値スナップショットのみ。時系列チャート描画 → prepare_chart_data（indicators 指定）。\n\n詳細分析には専門ツールを併用: get_flow_metrics / get_volatility_metrics / analyze_indicators / get_orderbook / detect_patterns。',
	inputSchema: AnalyzeMarketSignalInputSchema,
	handler: async ({ pair, type, flowLimit, bucketMs, windows }: z.infer<typeof AnalyzeMarketSignalInputSchema>) => {
		const res = await analyzeMarketSignal(pair, { type, flowLimit, bucketMs, windows });
		try {
			if (!res?.ok) return AnalyzeMarketSignalOutputSchema.parse(res);
			const d = ((res?.data as Record<string, unknown>) || {}) as Record<string, unknown> & {
				score?: number;
				recommendation?: string;
				confidence?: string;
				confidenceReason?: string;
				scoreRange?: { displayMin?: number; displayMax?: number; neutralBandDisplay?: { min: number; max: number } };
				topContributors?: string[];
				sma?: {
					current: number;
					values: { sma25: number | null; sma75: number | null; sma200: number | null };
					deviations: { vs25: number | null; vs75: number | null; vs200: number | null };
					arrangement: string;
					recentCross: { type: string; pair: string; barsAgo: number } | null;
				};
				breakdownArray?: Array<{
					factor: string;
					weight: number;
					rawScore: number;
					contribution: number;
					interpretation: string;
				}>;
				contributions?: Record<string, number>;
				weights?: Record<string, number>;
				nextActions?: Array<{ priority: string; tool: string; reason: string }>;
				refs?: {
					indicators?: {
						latest?: Record<string, number> & {
							ichi_series?: { spanA?: number[]; spanB?: number[] };
						};
					};
				};
			};
			const refs = d?.refs?.indicators?.latest || {};
			// 今日の雲は ichi_series の末尾 26 本前を見る。refs.ICHIMOKU_spanA/B は 26 本後の雲なので使えない。
			const { spanA: currentSpanA, spanB: currentSpanB } = currentCloudSpans(refs?.ichi_series);
			const baseText = buildMarketSignalHandlerText({
				pair: String(pair || ''),
				type: String(type || '1day'),
				score: d?.score ?? 0,
				recommendation: String(d?.recommendation || 'neutral'),
				confidence: String(d?.confidence || 'unknown'),
				confidenceReason: String(d?.confidenceReason || ''),
				scoreRange: d?.scoreRange || null,
				topContributors: Array.isArray(d?.topContributors) ? d.topContributors.slice(0, 2) : [],
				sma: d?.sma
					? {
							current: Number.isFinite(d.sma.current) ? d.sma.current : null,
							values: d.sma.values || { sma25: null, sma75: null, sma200: null },
							deviations: d.sma.deviations || { vs25: null, vs75: null, vs200: null },
							arrangement: String(d.sma.arrangement || ''),
							recentCross: d.sma.recentCross || null,
						}
					: null,
				supplementary: {
					rsi: refs?.RSI_14 ?? null,
					ichimokuSpanA: currentSpanA,
					ichimokuSpanB: currentSpanB,
					macdHist: refs?.MACD_hist ?? null,
				},
				breakdownArray: Array.isArray(d?.breakdownArray) ? d.breakdownArray : [],
				contributions: d?.contributions || null,
				weights: d?.weights || null,
				nextActions: Array.isArray(d?.nextActions) ? d.nextActions : [],
			});
			const text = prependWarnings(baseText, extractUpstreamWarning((res as { meta?: unknown }).meta), {
				separator: '\n',
			});
			return {
				content: [{ type: 'text', text }],
				structuredContent: AnalyzeMarketSignalOutputSchema.parse(res) as Record<string, unknown>,
			};
		} catch {
			return AnalyzeMarketSignalOutputSchema.parse(res);
		}
	},
};
