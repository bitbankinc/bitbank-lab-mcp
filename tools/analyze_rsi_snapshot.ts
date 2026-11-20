import type { z } from 'zod';
import { calendarDateFromIso, dayjs } from '../lib/datetime.js';
import { formatSummary } from '../lib/formatter.js';
import { RSI_MIDLINE, RSI_PERIOD } from '../lib/indicator-config.js';
import { rsiZone, rsiZoneLabel } from '../lib/indicator-zones.js';
import { isLatestBarProvisional, prependProvisionalNote } from '../lib/provisional-bar.js';
import { fail, failFromError, failFromValidation, ok } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { extractUpstreamWarning, prependWarnings } from '../lib/warning-propagation.js';
import {
	type AnalyzeRsiSnapshotDataSchemaOut,
	AnalyzeRsiSnapshotInputSchema,
	AnalyzeRsiSnapshotOutputSchema,
} from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import analyzeIndicators, { rsi } from './analyze_indicators.js';
import getCandles from './get_candles.js';

export interface BuildRsiSnapshotTextInput {
	baseSummary: string;
	rsiStr: string;
	prevStr: string;
	zoneJp: string;
	period: number;
	crossDesc: string;
	divType: 'bullish' | 'bearish' | 'none';
	divDesc: string;
	recentCrosses: Array<{
		type: 'bullish_cross' | 'bearish_cross';
		barsAgo: number;
		date: string;
		rsi: number;
	}>;
}

export function buildRsiSnapshotText(input: BuildRsiSnapshotTextInput): string {
	const { baseSummary, rsiStr, prevStr, zoneJp, period, crossDesc, divType, divDesc, recentCrosses } = input;
	const recentLines = recentCrosses
		.slice(-5)
		.reverse()
		.map(
			(rc) =>
				`${rc.type === 'bullish_cross' ? '↑' : '↓'} ${rc.type} - ${rc.barsAgo} bars ago (${rc.date}) [RSI ${rc.rsi.toFixed(2)}]`,
		);
	return [
		baseSummary,
		'',
		`RSI(${period}): ${rsiStr}（前バー: ${prevStr}）`,
		`ゾーン: ${zoneJp}`,
		'',
		`${RSI_MIDLINE} ラインクロス: ${crossDesc}`,
		...(divType !== 'none' ? [`ダイバージェンス: ${divDesc}`] : []),
		...(recentLines.length ? ['', 'Recent Crosses:', ...recentLines] : []),
		'',
		'---',
		`📌 含まれるもの: RSI の値、ゾーン判定、${RSI_MIDLINE} ラインクロス、ダイバージェンス`,
		'📌 含まれないもの: SMA・EMA・MACD・BB・一目均衡表・Stochastic、出来高フロー',
		'📌 補完ツール: analyze_indicators（他指標）, analyze_stoch_snapshot（Stochastic）, analyze_bb_snapshot（BB）',
	]
		.filter(Boolean)
		.join('\n');
}

export default async function analyzeRsiSnapshot(
	pair: string = 'btc_jpy',
	type: string = '1day',
	limit: number = 120,
	period: number = RSI_PERIOD,
) {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk, AnalyzeRsiSnapshotOutputSchema);
	try {
		const isDefault = period === RSI_PERIOD;

		let close: number | null = null;
		let rsiSeries: (number | null)[] = [];
		let candles: Array<{ isoTime?: string | null; close: number }> = [];
		let normalizedLen = 0;
		// isDefault=true は analyzeIndicators 経由なので warning / warnings の両方、false は getCandles 経由なので warning だけを取る。
		let warning: string | undefined;
		let warnings: string[] | undefined;
		// 取得 path に依らず最新足 ts で判定できるよう、両 path の中で代入する。
		let provisional = false;

		if (isDefault) {
			const indRes = await analyzeIndicators(chk.pair, type, limit);
			if (!indRes.ok)
				return AnalyzeRsiSnapshotOutputSchema.parse(
					fail(indRes.summary || 'indicators failed', indRes.meta.errorType || 'internal'),
				);
			const upstream = extractUpstreamWarning(indRes.meta);
			warning = upstream.warning;
			warnings = upstream.warnings;
			const ind = indRes.data.indicators;
			close = indRes.data.normalized.at(-1)?.close ?? null;
			rsiSeries = Array.isArray(ind.RSI_14_series) ? ind.RSI_14_series : [];
			candles = Array.isArray(indRes?.data?.chart?.candles)
				? indRes.data.chart.candles
				: Array.isArray(indRes?.data?.normalized)
					? indRes.data.normalized
					: [];
			normalizedLen = indRes.data.normalized.length;
			provisional = isLatestBarProvisional(indRes.data.normalized.at(-1)?.timestamp, String(type));
		} else {
			const candlesResult = await getCandles(chk.pair, type, undefined, limit);
			if (!candlesResult.ok)
				return AnalyzeRsiSnapshotOutputSchema.parse(
					fail(candlesResult.summary || 'candles failed', candlesResult.meta.errorType || 'internal'),
				);
			const upstream = extractUpstreamWarning(candlesResult.meta);
			warning = upstream.warning;
			// getCandles path は取得層のみ。計算層 warnings は contract 上出ないため明示的に undefined にする。
			warnings = undefined;
			const normalized = candlesResult.data.normalized;
			const closes = normalized.map((c) => c.close);
			close = closes.at(-1) ?? null;
			candles = normalized;
			normalizedLen = normalized.length;
			provisional = isLatestBarProvisional(normalized.at(-1)?.timestamp, String(type));
			rsiSeries = rsi(closes, period);
		}

		const rsiValue = rsiSeries.at(-1) ?? null;
		const prevRsi = rsiSeries.at(-2) ?? null;
		const zone = rsiZone(rsiValue);

		let crossType: 'bullish_cross' | 'bearish_cross' | 'none' = 'none';
		let crossDesc = 'クロスなし';
		if (rsiValue != null && prevRsi != null) {
			const prevDiff = prevRsi - RSI_MIDLINE;
			const currDiff = rsiValue - RSI_MIDLINE;
			if (prevDiff <= 0 && currDiff > 0) {
				crossType = 'bullish_cross';
				crossDesc = `RSI が ${RSI_MIDLINE} ラインを上抜け（モメンタムは強気側）`;
			} else if (prevDiff >= 0 && currDiff < 0) {
				crossType = 'bearish_cross';
				crossDesc = `RSI が ${RSI_MIDLINE} ラインを下抜け（モメンタムは弱気側）`;
			}
		}

		const lookback = 30;
		type RecentCross = {
			type: 'bullish_cross' | 'bearish_cross';
			barsAgo: number;
			date: string;
			rsi: number;
		};
		const recentCrosses: RecentCross[] = [];
		const n = Math.min(rsiSeries.length, candles.length);
		if (n >= 2) {
			const start = Math.max(1, n - lookback);
			for (let i = start; i < n; i++) {
				const p = rsiSeries[i - 1];
				const c = rsiSeries[i];
				if (p == null || c == null) continue;
				const prev = p - RSI_MIDLINE;
				const curr = c - RSI_MIDLINE;
				if ((prev <= 0 && curr > 0) || (prev >= 0 && curr < 0)) {
					const ct = curr > 0 ? 'bullish_cross' : 'bearish_cross';
					const barsAgo = n - 1 - i;
					const date = calendarDateFromIso(candles[i]?.isoTime) ?? dayjs().tz('Asia/Tokyo').format('YYYY-MM-DD');
					recentCrosses.push({ type: ct, barsAgo, date, rsi: c });
				}
			}
		}

		let divType: 'bullish' | 'bearish' | 'none' = 'none';
		let divDesc = 'ダイバージェンスなし';
		const divWindow = 14;
		if (n >= divWindow && close != null) {
			const recentCloses = candles.slice(-divWindow).map((c) => c.close);
			const recentRsi = rsiSeries.slice(-divWindow).filter((v): v is number => v != null);
			if (recentCloses.length >= 2 && recentRsi.length >= 2) {
				const priceSlope = recentCloses[recentCloses.length - 1] - recentCloses[0];
				const rsiSlope = recentRsi[recentRsi.length - 1] - recentRsi[0];
				if (priceSlope > 0 && rsiSlope < -5) {
					divType = 'bearish';
					divDesc = '価格は上昇しているが RSI は下降 → 上昇勢力の弱まりを示唆';
				} else if (priceSlope < 0 && rsiSlope > 5) {
					divType = 'bullish';
					divDesc = '価格は下降しているが RSI は上昇 → 下降勢力の弱まりを示唆';
				}
			}
		}

		const tags: string[] = [];
		if (zone === 'overbought') tags.push('rsi_overbought');
		if (zone === 'oversold') tags.push('rsi_oversold');
		if (crossType === 'bullish_cross') tags.push('rsi_bullish_cross');
		if (crossType === 'bearish_cross') tags.push('rsi_bearish_cross');
		if (divType === 'bullish') tags.push('rsi_bullish_divergence');
		if (divType === 'bearish') tags.push('rsi_bearish_divergence');

		const rsiStr = rsiValue != null ? rsiValue.toFixed(2) : 'n/a';
		const prevStr = prevRsi != null ? prevRsi.toFixed(2) : 'n/a';
		const zoneJp = rsiZoneLabel(rsiValue) ?? 'n/a';
		const baseSummaryText = buildRsiSnapshotText({
			baseSummary: formatSummary({
				pair: chk.pair,
				latest: close ?? undefined,
				extra: `RSI(${period})=${rsiStr} zone=${zone ?? 'n/a'}`,
			}),
			rsiStr,
			prevStr,
			zoneJp,
			period,
			crossDesc,
			divType,
			divDesc,
			recentCrosses,
		});
		// 順序は ⚠️ warning → ℹ️ 注記 → 本文（warning を最優先で見せる）。
		const summaryText = prependWarnings(
			prependProvisionalNote(baseSummaryText, provisional, { separator: '\n' }),
			{ warning, warnings },
			{ separator: '\n' },
		);

		const data: z.infer<typeof AnalyzeRsiSnapshotDataSchemaOut> = {
			latest: { close },
			rsi: { value: rsiValue, prev: prevRsi },
			zone,
			midlineCross: { type: crossType, description: crossDesc },
			recentCrosses,
			divergence: { type: divType, description: divDesc },
			tags,
		};
		const meta = createMeta(chk.pair, {
			type,
			count: normalizedLen,
			params: { period },
			...(warning ? { warning } : {}),
			...(warnings && warnings.length > 0 ? { warnings } : {}),
			...(provisional ? { provisional: true } : {}),
		});
		return AnalyzeRsiSnapshotOutputSchema.parse(ok(summaryText, data, meta));
	} catch (e: unknown) {
		return failFromError(e, { schema: AnalyzeRsiSnapshotOutputSchema });
	}
}

export const toolDef: ToolDefinition = {
	name: 'analyze_rsi_snapshot',
	description:
		'[RSI / Overbought / Oversold] RSI（relative strength index / overbought / oversold / divergence）の最新状態。ゾーン・50ラインクロス・ダイバージェンスを判定。\n\n⚠️ 最新値のみ。時系列チャート描画 → prepare_chart_data（indicators: ["RSI_14"]）。',
	inputSchema: AnalyzeRsiSnapshotInputSchema,
	handler: async ({ pair, type, limit, period }: { pair?: string; type?: string; limit?: number; period?: number }) =>
		analyzeRsiSnapshot(pair, type, limit, period),
};
