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
import { isLatestBarProvisional, prependProvisionalNote } from '../lib/provisional-bar.js';
import { fail, failFromError, failFromValidation, ok } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { extractUpstreamWarning, prependWarnings } from '../lib/warning-propagation.js';
import {
	type AnalyzeSmaSnapshotDataSchemaOut,
	AnalyzeSmaSnapshotInputSchema,
	AnalyzeSmaSnapshotOutputSchema,
} from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import analyzeIndicators, { sma } from './analyze_indicators.js';

export type { CrossStatus, MaLineEntry, RecentCrossEntry };

export interface BuildSmaSnapshotTextInput {
	baseSummary: string;
	type: string;
	maLines: MaLineEntry[];
	crossStatuses: CrossStatus[];
	recentCrosses: RecentCrossEntry[];
}

const SMA_FOOTER = [
	'📌 含まれるもの: SMA値・傾き・クロス状態・配列パターン・価格との乖離',
	'📌 含まれないもの: 他のテクニカル指標（RSI・MACD・BB・一目均衡表）、出来高フロー、板情報',
	'📌 補完ツール: analyze_indicators（他指標）, analyze_bb_snapshot（BB）, get_flow_metrics（出来高）, get_orderbook（板情報）',
];

export function buildSmaSnapshotText(input: BuildSmaSnapshotTextInput): string {
	return buildMaSnapshotText({ ...input, prefix: 'SMA', footerLines: SMA_FOOTER });
}

export default async function analyzeSmaSnapshot(
	pair: string = 'btc_jpy',
	type: string = '1day',
	limit: number = 220,
	periods: number[] = [25, 75, 200],
) {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk, AnalyzeSmaSnapshotOutputSchema);
	try {
		const indRes = await analyzeIndicators(chk.pair, type, Math.max(Math.max(...periods, 200), limit));
		if (!indRes.ok)
			return AnalyzeSmaSnapshotOutputSchema.parse(
				fail(indRes.summary || 'indicators failed', indRes.meta.errorType || 'internal'),
			);

		const upstream = extractUpstreamWarning(indRes.meta);
		const warning = upstream.warning;

		// SMA の最新値・配列・乖離は最新足の終値に依存するので、形成中なら注記を出す。
		const provisional = isLatestBarProvisional(indRes.data.normalized.at(-1)?.timestamp, String(type));

		const close = indRes.data.normalized.at(-1)?.close ?? null;
		const closes = indRes.data.normalized.map((c) => c.close);
		const indRecord = indRes.data.indicators as Record<string, number[] | number | null>;
		const chartInd: Record<string, unknown> = { ...indRes?.data?.chart?.indicators };
		const candles: Array<{ isoTime?: string | null }> = Array.isArray(indRes?.data?.chart?.candles)
			? indRes.data.chart.candles
			: indRes.data.normalized;
		// analyze_indicators が持つ SMA は 5 / 20 / 25 / 50 / 75 / 200 だけなので、それ以外は取得した足から同じ sma で計算する（#431）。
		const map: Record<string, number | null> = {};
		const warningSet = new Set(upstream.warnings ?? []);
		for (const p of new Set(periods)) {
			const key = `SMA_${p}`;
			if (Object.hasOwn(indRecord, key)) {
				map[key] = (indRecord[key] as number | null) ?? null;
			} else {
				const series = sma(closes, p);
				map[key] = series.at(-1) ?? null;
				chartInd[key] = series;
				// analyze_indicators が持つ周期の不足は上流の warnings に既に出る。
				if (closes.length < p) warningSet.add(`${key}: データ不足`);
			}
		}
		const warnings = warningSet.size > 0 ? [...warningSet] : undefined;

		const crossPairs = generateCrossPairs(periods);
		const crosses = detectCrossStatuses(crossPairs, map, 'SMA');
		const recentCrosses = detectRecentCrosses(crossPairs, chartInd, candles, 'SMA');

		const sortedPeriods = [...new Set(periods)].sort((a, b) => a - b);
		const sortedVals = sortedPeriods.map((p) => map[`SMA_${p}`]);
		const alignment = detectAlignment(sortedVals, { minPeriods: 2, strict: true });

		const tags: string[] = [];
		if (alignment === 'bullish') tags.push('sma_bullish_alignment');
		if (alignment === 'bearish') tags.push('sma_bearish_alignment');

		const smaVals = periods.map((p) => map[`SMA_${p}`]).filter((v): v is number => v != null);
		const position = detectPosition(close, smaVals);

		const smasExt: Record<string, MaExtEntry> = {};
		for (const p of periods) {
			const val = map[`SMA_${p}`];
			const series = getSeries(chartInd, 'SMA', p);
			smasExt[String(p)] = computeMaExt(close, val, series, type);
		}

		const maLines = buildMaLines(periods, smasExt);
		const baseSummaryText = buildSmaSnapshotText({
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
		// 順序は ⚠️ warning → ℹ️ 注記 → 本文（warning を最優先で見せる）。
		const summaryText = prependWarnings(
			prependProvisionalNote(baseSummaryText, provisional, { separator: '\n' }),
			{ warning, warnings },
			{ separator: '\n' },
		);

		const data: z.infer<typeof AnalyzeSmaSnapshotDataSchemaOut> = {
			latest: { close },
			sma: map,
			crosses,
			alignment,
			tags,
			summary: { close, align: alignment, position },
			smas: smasExt,
			recentCrosses,
		};
		const meta = createMeta(chk.pair, {
			type,
			count: indRes.data.normalized.length,
			periods,
			...(warning ? { warning } : {}),
			...(warnings && warnings.length > 0 ? { warnings } : {}),
			...(provisional ? { provisional: true } : {}),
		});
		return AnalyzeSmaSnapshotOutputSchema.parse(ok(summaryText, data, meta));
	} catch (e: unknown) {
		return failFromError(e, { schema: AnalyzeSmaSnapshotOutputSchema });
	}
}

export const toolDef: ToolDefinition = {
	name: 'analyze_sma_snapshot',
	description:
		'[SMA / Moving Average / Golden Cross] SMA（simple moving average / golden cross / dead cross）の数値スナップショット。最新値・クロス検出・整列状態（bullish/bearish/mixed）。periods は任意の周期を指定できる（既定: 25/75/200）。\n\n⚠️ 最新値のみ。時系列チャート描画 → prepare_chart_data（indicators: ["SMA_25","SMA_75"] 等）。',
	inputSchema: AnalyzeSmaSnapshotInputSchema,
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
	}) => analyzeSmaSnapshot(pair, type, limit, periods),
};
