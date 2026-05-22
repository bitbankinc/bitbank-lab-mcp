import type { z } from 'zod';
import { timeframeLabel } from '../../lib/formatter.js';
import { failFromValidation } from '../../lib/result.js';
import { ensurePair } from '../../lib/validate.js';
import { prependWarnings } from '../../lib/warning-propagation.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { DetectPatternsInputSchema, DetectPatternsOutputSchema } from '../schemas.js';
import type { McpResponse, ToolDefinition } from '../tool-definition.js';
import {
	buildPeriodLine,
	buildTypeSummary,
	formatDebugView,
	formatDetailedView,
	formatFullView,
	formatSummaryView,
} from './detectPatternsViewsHandler.js';

type DetectPatternsInput = z.infer<typeof DetectPatternsInputSchema>;
type DetectPatternsOutput = z.infer<typeof DetectPatternsOutputSchema>;

/**
 * 上流 warning（取得層 / 計算層）を view formatter が返す content[0].text の先頭に連結する。
 * 各 view（debug / summary / full / detailed）で warning 行が消えないように handler 側で統一して付与する。
 */
function prependWarningToResponse(
	response: McpResponse,
	meta: { warning?: string; warnings?: string[] } | undefined,
): McpResponse {
	if (!meta || (!meta.warning && (!meta.warnings || meta.warnings.length === 0))) return response;
	const first = response.content?.[0];
	if (!first || first.type !== 'text' || typeof first.text !== 'string') return response;
	const wrapped = prependWarnings(first.text, meta, { separator: '\n' });
	return {
		...response,
		content: [{ type: 'text', text: wrapped }, ...response.content.slice(1)],
	};
}

export const toolDef: ToolDefinition = {
	name: 'detect_patterns',
	description:
		'[Chart Patterns / Double Top / Head and Shoulders / Triangle] チャートパターン検出（chart patterns / double top / double bottom / head and shoulders / triangle / wedge / flag）。形成中+完成済みを統合検出。\n\n視覚確認: 結果の overlays を render_chart_svg に渡して描画可能。\n描画結果は必ずビジュアルとしてレンダリングして表示すること。\nチャット本文へのSVGコード直接出力は禁止。',
	inputSchema: DetectPatternsInputSchema,
	handler: async ({
		pair,
		type,
		limit,
		patterns,
		swingDepth,
		tolerancePct,
		minBarsBetweenSwings,
		view,
		requireCurrentInPattern,
		currentRelevanceDays,
		includeForming,
		includeCompleted,
		includeInvalid,
		tz,
	}: DetectPatternsInput) => {
		const chk = ensurePair(pair);
		if (!chk.ok) return failFromValidation(chk);
		const effectiveTz = tz ?? 'Asia/Tokyo';
		const out = await detectPatterns(chk.pair, type, limit, {
			patterns,
			swingDepth,
			tolerancePct,
			minBarsBetweenSwings,
			requireCurrentInPattern,
			currentRelevanceDays,
			includeForming,
			includeCompleted,
			includeInvalid,
			tz: effectiveTz,
		});
		const res: DetectPatternsOutput = DetectPatternsOutputSchema.parse(out);
		if (!res.ok) return res;
		const pats = Array.isArray(res.data.patterns) ? res.data.patterns : [];
		const meta = res.meta;
		const count = Number(meta.count ?? pats.length ?? 0);
		const tfLabel = timeframeLabel(String(type));
		const hdr = `${String(pair).toUpperCase()} ${tfLabel}（${String(type)}） ${limit ?? count}本から${pats.length}件を検出`;
		const upstream = { warning: meta.warning, warnings: meta.warnings };

		if (view === 'debug') {
			return prependWarningToResponse(formatDebugView(hdr, meta, pats, res, effectiveTz), upstream);
		}

		const periodLine = buildPeriodLine(pats, effectiveTz);
		const typeSummary = buildTypeSummary(pats, effectiveTz);

		if ((view || 'detailed') === 'summary') {
			return prependWarningToResponse(
				formatSummaryView(hdr, pats, periodLine, typeSummary, patterns, includeForming, res, effectiveTz),
				upstream,
			);
		}
		if ((view || 'detailed') === 'full') {
			return prependWarningToResponse(
				formatFullView(hdr, pats, periodLine, typeSummary, meta, res, effectiveTz),
				upstream,
			);
		}
		// detailed (default)
		return prependWarningToResponse(
			formatDetailedView(hdr, pats, periodLine, typeSummary, meta, tolerancePct, patterns, res, effectiveTz),
			upstream,
		);
	},
};
