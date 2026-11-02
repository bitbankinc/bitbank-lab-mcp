import type { z } from 'zod';
import { timeframeLabel } from '../../lib/formatter.js';
import { failFromValidation } from '../../lib/result.js';
import { ensurePair } from '../../lib/validate.js';
import { prependWarnings } from '../../lib/warning-propagation.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { buildPeriodBlock } from '../../tools/patterns/period.js';
import { extractScanWindowWarnings } from '../../tools/patterns/scan-window.js';
import { DetectPatternsInputSchema, DetectPatternsOutputSchema } from '../schemas.js';
import type { McpResponse, ToolDefinition } from '../tool-definition.js';
import { formatDebugView } from './detectPatternsDebugView.js';
import {
	buildEffectiveParamsLine,
	buildTypeSummary,
	formatDetailedView,
	formatFullView,
	formatSummaryView,
} from './detectPatternsViewsHandler.js';

type DetectPatternsInput = z.infer<typeof DetectPatternsInputSchema>;
type DetectPatternsOutput = z.infer<typeof DetectPatternsOutputSchema>;

// data.warnings は structuredContent にしか無いので、スキャン窓不足を content に出さないと「0 件検出」としか伝わらない。
function prependWarningToResponse(
	response: McpResponse,
	meta: { warning?: string; warnings?: string[] } | undefined,
): McpResponse {
	if (!meta || (!meta.warning && (!meta.warnings || meta.warnings.length === 0))) return response;
	const first = response.content?.[0];
	if (first?.type !== 'text' || typeof first.text !== 'string') return response;
	const wrapped = prependWarnings(first.text, meta, { separator: '\n' });
	return {
		...response,
		content: [{ type: 'text', text: wrapped }, ...response.content.slice(1)],
	};
}

export const toolDef: ToolDefinition = {
	name: 'detect_patterns',
	description:
		'[Chart Patterns / Double Top / Head and Shoulders / Triangle] チャートパターン検出（chart patterns / double top / double bottom / head and shoulders / triangle / wedge / flag）。形成中+完成済みを統合検出。表示日時は tz（既定 Asia/Tokyo）で整形。\n\n' +
		'検出の意味論:\n' +
		'- 直近の一方向トレンド（上げ続け / 下げ続け）はパターンを構成しないため検出対象に入らない。「直近の値動きが結果に出ない」は多くの場合これであってデータ欠落ではない。実際に走査した範囲は meta.scan（content の「スキャン範囲」行）で確認すること。\n' +
		'- ピボットの確定には前後 swingDepth 本が要るため、スキャン窓の両端 swingDepth 本はピボットにならない（swingDepth は時間足ごとに自動スケールする。例: 1hour の実効値は 3）。\n' +
		'- limit はスキャン窓の本数であり、同時に「何が検出可能か」も決める。小さすぎる場合は data.warnings に limit_too_small_for_timeframe が載る（content 先頭にも警告行を出す）。\n' +
		'- 各検出器はパターンの大きさの下限をバー数で持つ。既定 limit（90）ではどの時間足・どの種別も到達可能だが、limit をこれより小さくすると**特定の種別だけが静かに 0 件になる**ことがある（下限の表は docs/tools.md の「limit の実効下限」）。\n' +
		'- 既定 limit（90）は形成中〜完成直後のパターンを見るための窓。**過去のパターンの統計（data.statistics の成功率 / 平均リターン）や aftermath を調べるなら limit を上げる**（上限 365）。summary / detailed の content 量はほぼ変わらず、増えるのは API 呼び出し回数。\n' +
		'- date を指定すると、その tz の指定日終端以前を limit 本走査する。過去時点を再現する場合は、requireCurrentInPattern の「現在」も走査終端日に固定される。\n' +
		'- 検出が 0 件、または期待した種別が出ない理由を答えるときは **view=debug を使う**。候補ごとの棄却理由コードが candidates に載る（例: poor_trendline_fit / r2_below_threshold / neckline_above_pre_decline_high。コードの意味は docs/tools.md の「detect_patterns 詳細ガイド」）。\n' +
		'- **その理由を推測で説明しないこと。** 「上昇局面だったので構造的に成立しない」のような一般的なテクニカル分析の知識からの説明は、もっともらしくてもツールの出力に基づいていない。debug の実出力（棄却理由コード、候補が 1 件も積まれていないという事実を含む）だけを根拠にする。\n\n' +
		'視覚確認: 結果の overlays を render_chart_svg に渡して描画可能。\n' +
		'描画結果は必ずビジュアルとしてレンダリングして表示すること。\n' +
		'チャット本文へのSVGコード直接出力は禁止。\n\n' +
		'構造化データ (data.patterns[*].range.start/end 等) は後方互換のため UTC ISO 文字列のまま。',
	inputSchema: DetectPatternsInputSchema,
	handler: async ({
		pair,
		type,
		limit,
		patterns,
		swingDepth,
		tolerancePct,
		minBarsBetweenSwings,
		headProminencePct,
		view,
		requireCurrentInPattern,
		currentRelevanceDays,
		date,
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
			headProminencePct,
			requireCurrentInPattern,
			currentRelevanceDays,
			date,
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
		const anchorSuffix = date ? `（終端 date=${date} 指定）` : '';
		const hdr = `${String(pair).toUpperCase()} ${tfLabel}（${String(type)}） ${limit ?? count}本から${pats.length}件を検出${anchorSuffix}`;
		// 4 つの view すべてに同じ文字列を通す。hdr の末尾には足せず、summary に出さないと上位集合規約に反する（#184）。
		const effectiveParamsLine = buildEffectiveParamsLine(meta, String(type));
		const contentWarnings = {
			warning: meta.warning,
			warnings: [...(meta.warnings ?? []), ...extractScanWindowWarnings(res.data.warnings)],
		};

		if (view === 'debug') {
			return prependWarningToResponse(
				formatDebugView(hdr, meta, pats, res, effectiveTz, effectiveParamsLine, String(type)),
				contentWarnings,
			);
		}

		// ヘッダの {limit}本から は要求本数でスキャン本数ではないので、両者が食い違うことがある。
		const periodBlock = buildPeriodBlock(meta.scan, String(type), pats, effectiveTz);
		const typeSummary = buildTypeSummary(pats);

		if ((view || 'detailed') === 'summary') {
			return prependWarningToResponse(
				formatSummaryView(
					hdr,
					pats,
					periodBlock,
					typeSummary,
					patterns,
					includeForming,
					res,
					effectiveTz,
					effectiveParamsLine,
				),
				contentWarnings,
			);
		}
		if ((view || 'detailed') === 'full') {
			return prependWarningToResponse(
				formatFullView(hdr, pats, periodBlock, typeSummary, meta, res, effectiveTz, effectiveParamsLine, String(type)),
				contentWarnings,
			);
		}
		return prependWarningToResponse(
			formatDetailedView(
				hdr,
				pats,
				periodBlock,
				typeSummary,
				meta,
				patterns,
				res,
				effectiveTz,
				effectiveParamsLine,
				String(type),
			),
			contentWarnings,
		);
	},
};
