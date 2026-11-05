import type { z } from 'zod';
import { failFromError, failFromValidation, ok } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { collectUpstreamWarnings, extractUpstreamWarning, prependWarnings } from '../lib/warning-propagation.js';
import {
	type AnalyzeMtfSmaDataSchemaOut,
	AnalyzeMtfSmaInputSchema,
	type AnalyzeMtfSmaMetaSchemaOut,
	AnalyzeMtfSmaOutputSchema,
} from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import analyzeSmaSnapshot from './analyze_sma_snapshot.js';

const ALIGNMENT_ICON: Record<string, string> = {
	bullish: '🟢',
	bearish: '🔴',
	mixed: '🟡',
	unknown: '⚪',
};

function deriveSmaOrder(periods: number[], smaMap: Record<string, number | null> | undefined): string {
	if (!smaMap) return 'mixed';
	const uniq = [...new Set(periods)].sort((a, b) => a - b);
	const vals = uniq.map((p) => smaMap[`SMA_${p}`]);
	if (vals.some((v) => v == null || !Number.isFinite(v))) return 'mixed';
	const nums = vals as number[];
	const allDesc = nums.every((v, i) => i === 0 || v < nums[i - 1]);
	const allAsc = nums.every((v, i) => i === 0 || v > nums[i - 1]);
	if (allDesc) return uniq.join('>');
	if (allAsc) return [...uniq].reverse().join('>');
	return 'mixed';
}

export default async function analyzeMtfSma(
	pair: string = 'btc_jpy',
	timeframes: string[] = ['1hour', '4hour', '1day'],
	periods: number[] = [25, 75, 200],
) {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk, AnalyzeMtfSmaOutputSchema);

	try {
		const uniqueTimeframes = [...new Set(timeframes)];

		// analyzeIndicators の TTL キャッシュがあるので、同じ pair + type は再取得しない。
		const results = await Promise.all(
			uniqueTimeframes.map(async (tf) => {
				const res = await analyzeSmaSnapshot(chk.pair, tf, 220, periods);
				return { timeframe: tf, result: res as Record<string, unknown> };
			}),
		);

		const byTimeframe: Record<string, unknown> = {};
		const alignments: string[] = [];

		const warningSources: Array<{ source: string; warning?: string }> = [];
		const aggregatedWarnings: string[] = [];

		for (const { timeframe, result } of results) {
			if (result?.ok && result?.data) {
				const d = result.data as Record<string, unknown>;
				const summary = d.summary as Record<string, unknown> | undefined;
				const alignment = d.alignment as string;
				const latest = d.latest as { close: number | null } | undefined;
				const smaMap = d.sma as Record<string, number | null> | undefined;
				byTimeframe[timeframe] = {
					alignment,
					alignmentIcon: ALIGNMENT_ICON[alignment] ?? '⚪',
					position: (summary?.position as string) ?? 'unknown',
					price: latest?.close ?? null,
					latest: latest ?? { close: null },
					sma: smaMap,
					smas: d.smas,
					smaOrder: deriveSmaOrder(periods, smaMap),
					crosses: d.crosses,
					recentCrosses: d.recentCrosses,
					tags: d.tags,
				};
				alignments.push(alignment);

				const { warning: childWarning, warnings: childWarnings } = extractUpstreamWarning(result.meta);
				if (childWarning) warningSources.push({ source: timeframe, warning: childWarning });
				if (childWarnings) {
					for (const w of childWarnings) aggregatedWarnings.push(`[${timeframe}] ${w}`);
				}
			} else {
				byTimeframe[timeframe] = {
					alignment: 'unknown',
					alignmentIcon: ALIGNMENT_ICON.unknown,
					position: 'unknown',
					price: null,
					latest: { close: null },
					smaOrder: 'mixed',
					recentCrosses: [],
				};
				alignments.push('unknown');

				const failMsg = (result as { summary?: string } | null | undefined)?.summary || 'indicators failed';
				warningSources.push({ source: timeframe, warning: failMsg });
			}
		}

		const warning = collectUpstreamWarnings(warningSources);
		const warnings = aggregatedWarnings.length > 0 ? aggregatedWarnings : undefined;

		let direction: 'bullish' | 'bearish' | 'mixed' | 'unknown';
		let aligned: boolean;

		if (alignments.some((a) => a === 'unknown')) {
			direction = 'unknown';
			aligned = false;
		} else if (alignments.every((a) => a === 'bullish')) {
			direction = 'bullish';
			aligned = true;
		} else if (alignments.every((a) => a === 'bearish')) {
			direction = 'bearish';
			aligned = true;
		} else {
			direction = 'mixed';
			aligned = false;
		}

		const dirLabel = direction === 'bullish' ? '上昇' : direction === 'bearish' ? '下降' : '混合';
		const tfEntry = (tf: string) => byTimeframe[tf] as Record<string, unknown> | undefined;
		const baseConfSummary = aligned
			? `全時間軸が${dirLabel}方向で一致`
			: `時間軸間で方向が分かれている（${timeframes.map((tf) => `${tf}:${tfEntry(tf)?.alignment}`).join(', ')})`;

		const hasUnknown = alignments.some((a) => a === 'unknown');
		const confSummary = hasUnknown ? `⚠️ TF 取得不完全のため信頼度低 — ${baseConfSummary}` : baseConfSummary;

		const baseSummaryText = `${timeframes.map((tf) => `${tf}: ${tfEntry(tf)?.alignment}`).join(' / ')} → ${confSummary}`;
		const summaryText = prependWarnings(baseSummaryText, { warning, warnings }, { separator: '\n' });

		const data: z.infer<typeof AnalyzeMtfSmaDataSchemaOut> = {
			timeframes: byTimeframe as z.infer<typeof AnalyzeMtfSmaDataSchemaOut>['timeframes'],
			confluence: { aligned, direction, summary: confSummary },
		};

		const meta = createMeta(chk.pair, {
			timeframes,
			periods,
			...(warning ? { warning } : {}),
			...(warnings ? { warnings } : {}),
		}) as z.infer<typeof AnalyzeMtfSmaMetaSchemaOut>;
		return AnalyzeMtfSmaOutputSchema.parse(ok(summaryText, data, meta));
	} catch (e: unknown) {
		return failFromError(e, { schema: AnalyzeMtfSmaOutputSchema });
	}
}

type MtfSmaEntry = z.infer<typeof AnalyzeMtfSmaDataSchemaOut>['timeframes'][string];

function buildTimeframeLine(tf: string, entry: MtfSmaEntry | undefined): string {
	if (!entry) return `${tf}: no data`;
	const ent = entry as unknown as Record<string, unknown>;
	const icon = (ent.alignmentIcon as string) ?? '';
	const alignment = ent.alignment as string;
	const price = ent.price as number | null;
	const smaOrder = (ent.smaOrder as string) ?? 'mixed';
	const smas = (ent.smas ?? {}) as Record<string, Record<string, unknown>>;
	const smaParts = Object.entries(smas).map(([period, info]) => {
		const value = info.value;
		const pos = info.pricePosition ? (info.pricePosition === 'above' ? '▲' : '▼') : '=';
		const devStr =
			info.distancePct != null ? ` (${(info.distancePct as number) >= 0 ? '+' : ''}${info.distancePct}%)` : '';
		const slope = info.slope ? ` slope=${info.slope}` : '';
		return `SMA${period}=${value ?? 'n/a'} ${pos}${devStr}${slope}`;
	});
	const recent = (ent.recentCrosses ?? []) as Array<{ type: string; pair: [number, number]; barsAgo: number }>;
	const recentStr =
		recent.length > 0
			? ` / recent: ${recent.map((r) => `${r.type}(${r.pair.join('/')}, ${r.barsAgo}ago)`).join(', ')}`
			: '';
	return `${tf} ${icon} ${alignment} price=${price ?? 'n/a'} order=${smaOrder}\n    ${smaParts.join(' | ')}${recentStr}`;
}

export const toolDef: ToolDefinition = {
	name: 'analyze_mtf_sma',
	description:
		'[Multi-Timeframe SMA / MTF] 複数タイムフレームSMA一括分析（multi-timeframe / MTF / SMA alignment / confluence）。整列方向とコンフルエンスを判定。',
	inputSchema: AnalyzeMtfSmaInputSchema,
	handler: async ({ pair, timeframes, periods }: { pair?: string; timeframes?: string[]; periods?: number[] }) => {
		const res = await analyzeMtfSma(pair, timeframes, periods);
		if (!res?.ok) return res;
		const requestedTfs = timeframes ?? ['1hour', '4hour', '1day'];
		const lines = requestedTfs.map((tf) => buildTimeframeLine(tf, res.data.timeframes[tf]));
		const conf = res.data.confluence;
		const confLine = `Confluence: aligned=${conf.aligned} direction=${conf.direction} — ${conf.summary}`;
		const text = `${res.summary}\n\n${lines.join('\n')}\n\n${confLine}`;
		return { content: [{ type: 'text', text }], structuredContent: res as unknown as Record<string, unknown> };
	},
};
