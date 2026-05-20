import type { z } from 'zod';
import { formatSummary } from '../lib/formatter.js';
import {
	buildMaLines,
	buildMaSnapshotText,
	type CrossStatus,
	computeMaExt,
	detectAlignment,
	detectCrossStatuses,
	detectPosition,
	detectRecentCrosses,
	generateCrossPairs,
	getSeries,
	type MaExtEntry,
	type MaLineEntry,
	type RecentCrossEntry,
} from '../lib/ma-snapshot-utils.js';
import { fail, failFromError, failFromValidation, ok } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { extractUpstreamWarning, prependWarnings } from '../lib/warning-propagation.js';
import {
	type AnalyzeEmaSnapshotDataSchemaOut,
	AnalyzeEmaSnapshotInputSchema,
	AnalyzeEmaSnapshotOutputSchema,
} from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import analyzeIndicators, { ema } from './analyze_indicators.js';
import getCandles from './get_candles.js';

const FIXED_EMA_PERIODS = [12, 26, 50, 200] as const;

export type { CrossStatus, MaLineEntry, RecentCrossEntry };

export interface BuildEmaSnapshotTextInput {
	baseSummary: string;
	type: string;
	maLines: MaLineEntry[];
	crossStatuses: CrossStatus[];
	recentCrosses: RecentCrossEntry[];
}

const EMA_FOOTER = [
	'📌 含まれるもの: EMA値・傾き・クロス状態・配列パターン・価格との乖離',
	'📌 含まれないもの: SMA・RSI・MACD・BB・一目均衡表、出来高フロー、板情報',
	'📌 補完ツール: analyze_sma_snapshot（SMA）, analyze_indicators（他指標）, analyze_bb_snapshot（BB）, get_flow_metrics（出来高）',
];

/** テキスト組み立て（EMAスナップショット）— テスト可能な純粋関数 */
export function buildEmaSnapshotText(input: BuildEmaSnapshotTextInput): string {
	return buildMaSnapshotText({ ...input, prefix: 'EMA', footerLines: EMA_FOOTER });
}

export default async function analyzeEmaSnapshot(
	pair: string = 'btc_jpy',
	type: string = '1day',
	limit: number = 220,
	periods: number[] = [12, 26, 50, 200],
) {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk, AnalyzeEmaSnapshotOutputSchema);
	try {
		const maxPeriod = Math.max(...periods, 200);
		const fetchLimit = Math.max(maxPeriod, limit);

		const hasCustomPeriods = periods.some((p) => !(FIXED_EMA_PERIODS as readonly number[]).includes(p));

		let close: number | null = null;
		let chartInd: Record<string, unknown> = {};
		let candles: Array<{ isoTime?: string | null }> = [];
		let normalizedLen = 0;
		const map: Record<string, number | null> = {};
		// 上流 warning（取得層）と warnings（計算層）は path ごとに別ソースから抽出する。
		// - hasCustomPeriods=true: getCandles の meta.warning のみ（warnings は出ない）
		// - hasCustomPeriods=false: analyzeIndicators の meta.warning / meta.warnings 両方
		let warning: string | undefined;
		let warnings: string[] | undefined;

		if (hasCustomPeriods) {
			const candlesResult = await getCandles(chk.pair, type, undefined, fetchLimit);
			if (!candlesResult.ok)
				return AnalyzeEmaSnapshotOutputSchema.parse(
					fail(candlesResult.summary || 'candles failed', candlesResult.meta.errorType || 'internal'),
				);
			const upstream = extractUpstreamWarning(candlesResult.meta);
			warning = upstream.warning;
			// getCandles path は取得層のみ。計算層 warnings は contract 上出ないため明示的に undefined にする。
			warnings = undefined;
			const normalized = candlesResult.data.normalized;
			const allCloses = normalized.map((c) => c.close);
			close = allCloses.at(-1) ?? null;
			candles = normalized;
			normalizedLen = normalized.length;

			for (const p of periods) {
				const series = ema(allCloses, p);
				const key = `EMA_${p}`;
				map[key] = series.at(-1) ?? null;
				chartInd[key] = series;
			}
		} else {
			const indRes = await analyzeIndicators(chk.pair, type, fetchLimit);
			if (!indRes.ok)
				return AnalyzeEmaSnapshotOutputSchema.parse(
					fail(indRes.summary || 'indicators failed', indRes.meta.errorType || 'internal'),
				);
			const upstream = extractUpstreamWarning(indRes.meta);
			warning = upstream.warning;
			warnings = upstream.warnings;
			close = indRes.data.normalized.at(-1)?.close ?? null;
			chartInd = indRes?.data?.chart?.indicators ?? {};
			candles = Array.isArray(indRes?.data?.chart?.candles)
				? indRes.data.chart.candles
				: Array.isArray(indRes?.data?.normalized)
					? indRes.data.normalized
					: [];
			normalizedLen = indRes.data.normalized.length;

			const indRecord = indRes.data.indicators as Record<string, number[] | number | null>;
			for (const p of periods) {
				const key = `EMA_${p}`;
				map[key] = (indRecord[key] as number | null) ?? null;
				if (!chartInd[key]) {
					chartInd[key] = indRecord[`ema_${p}_series`] ?? [];
				}
			}
		}

		const crossPairs = generateCrossPairs(periods);
		const crosses = detectCrossStatuses(crossPairs, map, 'EMA');
		const recentCrosses = detectRecentCrosses(crossPairs, chartInd, candles, 'EMA');

		const sorted = [...new Set(periods)].sort((a, b) => a - b);
		const vals = sorted.map((p) => map[`EMA_${p}`]);
		const alignment = detectAlignment(vals, { minPeriods: 3, strict: false });

		const tags: string[] = [];
		if (alignment === 'bullish') tags.push('ema_bullish_alignment');
		if (alignment === 'bearish') tags.push('ema_bearish_alignment');

		const emaVals = periods.map((p) => map[`EMA_${p}`]).filter((v): v is number => v != null);
		const position = detectPosition(close, emaVals);

		const emasExt: Record<string, MaExtEntry> = {};
		for (const p of periods) {
			const val = map[`EMA_${p}`];
			const series = getSeries(chartInd, 'EMA', p);
			emasExt[String(p)] = computeMaExt(close, val, series, type);
		}

		const maLines = buildMaLines(periods, emasExt);
		const baseSummaryText = buildEmaSnapshotText({
			baseSummary: formatSummary({
				pair: chk.pair,
				latest: close ?? undefined,
				extra: `align=${alignment} pos=${position}`,
			}),
			type,
			maLines,
			crossStatuses: crosses,
			recentCrosses,
		});
		const summaryText = prependWarnings(baseSummaryText, { warning, warnings }, { separator: '\n' });

		const data: z.infer<typeof AnalyzeEmaSnapshotDataSchemaOut> = {
			latest: { close },
			ema: map,
			crosses,
			alignment,
			tags,
			summary: { close, align: alignment, position },
			emas: emasExt,
			recentCrosses,
		};
		const meta = createMeta(chk.pair, {
			type,
			count: normalizedLen,
			periods,
			...(warning ? { warning } : {}),
			...(warnings && warnings.length > 0 ? { warnings } : {}),
		});
		return AnalyzeEmaSnapshotOutputSchema.parse(ok(summaryText, data, meta));
	} catch (e: unknown) {
		return failFromError(e, { schema: AnalyzeEmaSnapshotOutputSchema });
	}
}

export const toolDef: ToolDefinition = {
	name: 'analyze_ema_snapshot',
	description:
		'[EMA / Exponential Moving Average] EMA（exponential moving average / trend / slope）の最新値・整列・クロス・傾きを返す（既定: 12/26/50/200）。\n\n⚠️ 最新値のみ。時系列チャート描画 → prepare_chart_data（indicators: ["EMA_12","EMA_26"] 等）。',
	inputSchema: AnalyzeEmaSnapshotInputSchema,
	handler: async ({
		pair,
		type,
		limit,
		periods,
	}: {
		pair?: string;
		type?: string;
		limit?: number;
		periods?: number[];
	}) => analyzeEmaSnapshot(pair, type, limit, periods),
};
