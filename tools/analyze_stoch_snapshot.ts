import type { z } from 'zod';
import { today } from '../lib/datetime.js';
import { formatSummary } from '../lib/formatter.js';
import { fail, failFromError, failFromValidation, ok } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { extractUpstreamWarning, prependWarnings } from '../lib/warning-propagation.js';
import {
	type AnalyzeStochSnapshotDataSchemaOut,
	AnalyzeStochSnapshotInputSchema,
	AnalyzeStochSnapshotOutputSchema,
} from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import analyzeIndicators, { computeClassicStochastic } from './analyze_indicators.js';
import getCandles from './get_candles.js';

const DEFAULT_K_PERIOD = 14;
const DEFAULT_SMOOTH_K = 3;
const DEFAULT_SMOOTH_D = 3;

export interface BuildStochSnapshotTextInput {
	baseSummary: string;
	kStr: string;
	dStr: string;
	zoneJp: string;
	kPeriod: number;
	smoothK: number;
	smoothD: number;
	crossDesc: string;
	divType: 'bullish' | 'bearish' | 'none';
	divDesc: string;
	recentCrosses: Array<{
		type: 'bullish_cross' | 'bearish_cross';
		barsAgo: number;
		date: string;
		zone: 'overbought' | 'oversold' | 'neutral';
	}>;
}

/** テキスト組み立て（Stochスナップショット）— テスト可能な純粋関数 */
export function buildStochSnapshotText(input: BuildStochSnapshotTextInput): string {
	const { baseSummary, kStr, dStr, zoneJp, kPeriod, smoothK, smoothD, crossDesc, divType, divDesc, recentCrosses } =
		input;
	const recentLines = recentCrosses
		.slice(-5)
		.reverse()
		.map((rc) => {
			const zJp =
				rc.zone === 'overbought' ? '買われすぎ圏' : rc.zone === 'oversold' ? '売られすぎ圏' : 'ニュートラル圏';
			return `${rc.type === 'bullish_cross' ? '↑' : '↓'} ${rc.type} - ${rc.barsAgo} bars ago (${rc.date}) [${zJp}]`;
		});
	return [
		baseSummary,
		'',
		`%K: ${kStr}`,
		`%D: ${dStr}`,
		`ゾーン: ${zoneJp}`,
		`パラメータ: (${kPeriod}, ${smoothK}, ${smoothD})`,
		'',
		`クロス: ${crossDesc}`,
		...(divType !== 'none' ? [`ダイバージェンス: ${divDesc}`] : []),
		...(recentLines.length ? ['', 'Recent Crosses:', ...recentLines] : []),
		'',
		'---',
		'📌 含まれるもの: %K・%D の値、ゾーン判定、クロスオーバー、ダイバージェンス',
		'📌 含まれないもの: RSI・SMA・EMA・MACD・BB・一目均衡表、出来高フロー',
		'📌 補完ツール: analyze_indicators（他指標）, analyze_rsi_snapshot（RSI）, analyze_ema_snapshot（EMA）',
	]
		.filter(Boolean)
		.join('\n');
}

function zoneOf(k: number | null): 'overbought' | 'oversold' | 'neutral' {
	if (k == null) return 'neutral';
	if (k >= 80) return 'overbought';
	if (k <= 20) return 'oversold';
	return 'neutral';
}

export default async function analyzeStochSnapshot(
	pair: string = 'btc_jpy',
	type: string = '1day',
	limit: number = 120,
	kPeriod: number = DEFAULT_K_PERIOD,
	smoothK: number = DEFAULT_SMOOTH_K,
	smoothD: number = DEFAULT_SMOOTH_D,
) {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk, AnalyzeStochSnapshotOutputSchema);
	try {
		const isDefault = kPeriod === DEFAULT_K_PERIOD && smoothK === DEFAULT_SMOOTH_K && smoothD === DEFAULT_SMOOTH_D;

		let close: number | null = null;
		let kSeries: (number | null)[] = [];
		let dSeries: (number | null)[] = [];
		let stochK: number | null = null;
		let stochD: number | null = null;
		let prevK: number | null = null;
		let prevD: number | null = null;
		let candles: Array<{ isoTime?: string | null; close: number }> = [];
		let normalizedLen = 0;
		// 上流 warning（取得層）と warnings（計算層）は path ごとに別ソースから抽出する。
		// - isDefault=true: analyzeIndicators の meta.warning / meta.warnings 両方
		// - isDefault=false: getCandles の meta.warning のみ（warnings は出ない）
		let warning: string | undefined;
		let warnings: string[] | undefined;

		if (isDefault) {
			const indRes = await analyzeIndicators(chk.pair, type, limit);
			if (!indRes.ok)
				return AnalyzeStochSnapshotOutputSchema.parse(
					fail(indRes.summary || 'indicators failed', indRes.meta.errorType || 'internal'),
				);
			const upstream = extractUpstreamWarning(indRes.meta);
			warning = upstream.warning;
			warnings = upstream.warnings;
			const ind = indRes.data.indicators;
			close = indRes.data.normalized.at(-1)?.close ?? null;
			stochK = ind.STOCH_K ?? null;
			stochD = ind.STOCH_D ?? null;
			prevK = ind.STOCH_prevK ?? null;
			prevD = ind.STOCH_prevD ?? null;
			kSeries = Array.isArray(ind.stoch_k_series) ? ind.stoch_k_series : [];
			dSeries = Array.isArray(ind.stoch_d_series) ? ind.stoch_d_series : [];
			candles = Array.isArray(indRes?.data?.chart?.candles)
				? indRes.data.chart.candles
				: Array.isArray(indRes?.data?.normalized)
					? indRes.data.normalized
					: [];
			normalizedLen = indRes.data.normalized.length;
		} else {
			const candlesResult = await getCandles(chk.pair, type, undefined, limit);
			if (!candlesResult.ok)
				return AnalyzeStochSnapshotOutputSchema.parse(
					fail(candlesResult.summary || 'candles failed', candlesResult.meta.errorType || 'internal'),
				);
			const upstream = extractUpstreamWarning(candlesResult.meta);
			warning = upstream.warning;
			// getCandles path は取得層のみ。計算層 warnings は contract 上出ないため明示的に undefined にする。
			warnings = undefined;
			const normalized = candlesResult.data.normalized;
			const highs = normalized.map((c) => c.high);
			const lows = normalized.map((c) => c.low);
			const closes = normalized.map((c) => c.close);
			close = closes.at(-1) ?? null;
			candles = normalized;
			normalizedLen = normalized.length;
			const result = computeClassicStochastic(highs, lows, closes, kPeriod, smoothK, smoothD);
			stochK = result.k;
			stochD = result.d;
			prevK = result.prevK;
			prevD = result.prevD;
			kSeries = result.kSeries;
			dSeries = result.dSeries;
		}

		const zone = zoneOf(stochK);

		let crossType: 'bullish_cross' | 'bearish_cross' | 'none' = 'none';
		let crossDesc = 'クロスなし';
		if (stochK != null && stochD != null && prevK != null && prevD != null) {
			const prevDiff = prevK - prevD;
			const currDiff = stochK - stochD;
			const zoneLabel =
				zone === 'overbought' ? '買われすぎ圏' : zone === 'oversold' ? '売られすぎ圏' : 'ニュートラル圏';
			if (prevDiff <= 0 && currDiff > 0) {
				crossType = 'bullish_cross';
				crossDesc = `%K が %D を上抜け（${zone === 'oversold' ? '売られすぎ圏からの反転 → 強いシグナル' : zoneLabel}）`;
			} else if (prevDiff >= 0 && currDiff < 0) {
				crossType = 'bearish_cross';
				crossDesc = `%K が %D を下抜け（${zone === 'overbought' ? '買われすぎ圏からの反転 → 強いシグナル' : zoneLabel}）`;
			}
		}

		const lookback = 30;
		type RecentCross = {
			type: 'bullish_cross' | 'bearish_cross';
			barsAgo: number;
			date: string;
			zone: 'overbought' | 'oversold' | 'neutral';
		};
		const recentCrosses: RecentCross[] = [];
		const n = Math.min(kSeries.length, dSeries.length, candles.length);
		if (n >= 2) {
			const start = Math.max(1, n - lookback);
			for (let i = start; i < n; i++) {
				const pK = kSeries[i - 1];
				const pD = dSeries[i - 1];
				const cK = kSeries[i];
				const cD = dSeries[i];
				if (pK == null || pD == null || cK == null || cD == null) continue;
				const prev = pK - pD;
				const curr = cK - cD;
				if ((prev <= 0 && curr > 0) || (prev >= 0 && curr < 0)) {
					const ct = curr > 0 ? 'bullish_cross' : 'bearish_cross';
					const barsAgo = n - 1 - i;
					const date = String(candles[i]?.isoTime || '').slice(0, 10) || today('YYYY-MM-DD');
					recentCrosses.push({ type: ct, barsAgo, date, zone: zoneOf(cK) });
				}
			}
		}

		let divType: 'bullish' | 'bearish' | 'none' = 'none';
		let divDesc = 'ダイバージェンスなし';
		const divWindow = 14;
		if (n >= divWindow && close != null) {
			const recentCloses = candles.slice(-divWindow).map((c) => c.close);
			const recentK = kSeries.slice(-divWindow).filter((v): v is number => v != null);
			if (recentCloses.length >= 2 && recentK.length >= 2) {
				const priceSlope = recentCloses[recentCloses.length - 1] - recentCloses[0];
				const kSlope = recentK[recentK.length - 1] - recentK[0];
				if (priceSlope > 0 && kSlope < -5) {
					divType = 'bearish';
					divDesc = '価格は上昇しているが %K は下降 → 上昇勢力の弱まりを示唆';
				} else if (priceSlope < 0 && kSlope > 5) {
					divType = 'bullish';
					divDesc = '価格は下降しているが %K は上昇 → 下降勢力の弱まりを示唆';
				}
			}
		}

		const tags: string[] = [];
		if (zone === 'overbought') tags.push('stoch_overbought');
		if (zone === 'oversold') tags.push('stoch_oversold');
		if (crossType === 'bullish_cross') tags.push('stoch_bullish_cross');
		if (crossType === 'bearish_cross') tags.push('stoch_bearish_cross');
		if (crossType === 'bullish_cross' && zone === 'oversold') tags.push('stoch_strong_buy');
		if (crossType === 'bearish_cross' && zone === 'overbought') tags.push('stoch_strong_sell');
		if (divType === 'bullish') tags.push('stoch_bullish_divergence');
		if (divType === 'bearish') tags.push('stoch_bearish_divergence');

		const kStr = stochK != null ? stochK.toFixed(2) : 'n/a';
		const dStr = stochD != null ? stochD.toFixed(2) : 'n/a';
		const zoneJp =
			zone === 'overbought' ? '買われすぎ (>80)' : zone === 'oversold' ? '売られすぎ (<20)' : 'ニュートラル';
		const baseSummaryText = buildStochSnapshotText({
			baseSummary: formatSummary({
				pair: chk.pair,
				latest: close ?? undefined,
				extra: `Stoch(%K/${kStr}, %D/${dStr}) zone=${zone}`,
			}),
			kStr,
			dStr,
			zoneJp,
			kPeriod,
			smoothK,
			smoothD,
			crossDesc,
			divType,
			divDesc,
			recentCrosses,
		});
		const summaryText = prependWarnings(baseSummaryText, { warning, warnings }, { separator: '\n' });

		const data: z.infer<typeof AnalyzeStochSnapshotDataSchemaOut> = {
			latest: { close },
			stoch: { k: stochK, d: stochD, prevK, prevD },
			zone,
			crossover: { type: crossType, description: crossDesc },
			recentCrosses,
			divergence: { type: divType, description: divDesc },
			tags,
		};
		const meta = createMeta(chk.pair, {
			type,
			count: normalizedLen,
			params: { kPeriod, smoothK, smoothD },
			...(warning ? { warning } : {}),
			...(warnings && warnings.length > 0 ? { warnings } : {}),
		});
		return AnalyzeStochSnapshotOutputSchema.parse(ok(summaryText, data, meta));
	} catch (e: unknown) {
		return failFromError(e, { schema: AnalyzeStochSnapshotOutputSchema });
	}
}

export const toolDef: ToolDefinition = {
	name: 'analyze_stoch_snapshot',
	description:
		'[Stochastic / Overbought / Oversold] Stochastic（stochastic / %K / %D / overbought / oversold / divergence）の最新状態。ゾーン・クロス・ダイバージェンスを判定。\n\n⚠️ 最新値のみ。時系列チャート描画 → prepare_chart_data（indicators: ["STOCH"]）。',
	inputSchema: AnalyzeStochSnapshotInputSchema,
	handler: async ({
		pair,
		type,
		limit,
		kPeriod,
		smoothK,
		smoothD,
	}: {
		pair?: string;
		type?: string;
		limit?: number;
		kPeriod?: number;
		smoothK?: number;
		smoothD?: number;
	}) => analyzeStochSnapshot(pair, type, limit, kPeriod, smoothK, smoothD),
};
