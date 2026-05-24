import type { z } from 'zod';
import { toIsoTime } from '../../lib/datetime.js';
import {
	formatCurrency,
	formatCurrencyShort,
	formatPercent,
	formatPriceJPY,
	formatTrendArrow,
} from '../../lib/formatter.js';
import { stddev } from '../../lib/math.js';
import getVolatilityMetrics, { WILDER_ATR_PERIOD } from '../../tools/get_volatility_metrics.js';
import { GetVolMetricsInputSchema } from '../schemas.js';
import type { ToolDefinition } from '../tool-definition.js';

/**
 * meta.warning（上流 get_candles の fetchWarning + 不正OHLCスキップ件数 + isoTime欠損件数）を
 * body の先頭に別行で連結する。LLM がデータの不完全性を見落とさないようにするため。
 */
export function prependVolWarning(body: string, meta: { warning?: string }): string {
	const w = meta?.warning;
	if (!w) return body;
	const head = w.startsWith('⚠️') ? w : `⚠️ ${w}`;
	return `${head}\n\n${body}`;
}

export interface VolViewInput {
	pair: string;
	type: string;
	lastClose: number | null;
	ann: boolean;
	annFactor: number;
	annFactorFull: number;
	sampleSize: number | string;
	rvAnn: number | null;
	pkAnn: number | null;
	gkAnn: number | null;
	rsAnn: number | null;
	atrAbs: number | null;
	atrPct: number | null;
	tagsAll: string[];
	rolling: Array<{
		window: number;
		rv_std: number;
		rv_std_ann?: number;
		parkinson?: number;
		garmanKlass?: number;
		rogersSatchell?: number;
	}>;
}

/** beginner ビューのテキスト組み立て */
export function buildVolatilityBeginnerText(input: VolViewInput): string {
	const { pair, type, lastClose, atrAbs, atrPct, rvAnn, tagsAll } = input;
	const rvPct = formatPercent(rvAnn, { multiply: true, digits: 0 });
	const atrJpy = formatPriceJPY(atrAbs);
	const atrPctStr = formatPercent(atrPct, { multiply: true });
	const closeStr = formatPriceJPY(lastClose);
	return [
		`${String(pair).toUpperCase()} [${String(type)}] 現在価格: ${closeStr}`,
		`・年間のおおよその動き: 約${rvPct}（1年でこのくらい上下しやすい目安）`,
		`・1日の平均的な動き: 約${atrJpy}（約${atrPctStr}）`,
		tagsAll.length ? `・今の傾向: ${tagsAll.map((t) => t.replaceAll('_', ' ')).join(', ')}` : null,
	]
		.filter(Boolean)
		.join('\n');
}

/** summary ビューのテキスト組み立て */
export function buildVolatilitySummaryText(input: VolViewInput): string {
	const { pair, type, sampleSize, rvAnn, pkAnn, gkAnn, rsAnn, atrAbs, tagsAll } = input;
	const fp = (x: number | null) => formatPercent(x, { multiply: true });
	const fmtCurrShort = (p: string, v: number | null) => formatCurrencyShort(v, p);
	return `${String(pair).toUpperCase()} [${String(type)}] samples=${sampleSize ?? 'n/a'} RV=${fp(rvAnn)} ATR=${fmtCurrShort(pair, atrAbs)} PK=${fp(pkAnn)} GK=${fp(gkAnn)} RS=${fp(rsAnn)} Tags: ${tagsAll.join(', ')}`;
}

export interface VolDetailedInput extends VolViewInput {
	series?: {
		ts: number[];
		close: number[];
		ret: number[];
	};
}

/** detailed/full ビューのテキスト組み立て */
export function buildVolatilityDetailedText(input: VolDetailedInput, view: 'detailed' | 'full'): string {
	const { pair, type, lastClose, ann, annFactor, sampleSize, rvAnn, pkAnn, gkAnn, rsAnn, atrAbs, tagsAll, rolling } =
		input;
	const fp = (x: number | null | undefined) => formatPercent(x, { multiply: true });
	const fmtCurr = (p: string, v: number | null) => formatCurrency(v, p);

	const windowsList = rolling.map((r) => r.window).join('/');
	const header = `${String(pair).toUpperCase()} [${String(type)}] close=${lastClose != null ? Number(lastClose).toLocaleString('ja-JP') : 'n/a'}\n`;
	const block1 = `【Volatility Metrics${ann ? ' (annualized)' : ''}, ${sampleSize ?? 'n/a'} samples】\nRV (std): ${fp(rvAnn)}\nATR: ${fmtCurr(pair, atrAbs)}\nParkinson: ${fp(pkAnn)}\nGarman-Klass: ${fp(gkAnn)}\nRogers-Satchell: ${fp(rsAnn)}`;

	const maxW = rolling.length ? Math.max(...rolling.map((r) => r.window)) : null;
	const baseVal =
		maxW != null
			? (rolling.find((r) => r.window === maxW)?.rv_std_ann ??
				((rolling.find((r) => r.window === maxW)?.rv_std ?? null) as number) * (ann ? annFactor : 1))
			: null;
	const trendLines = rolling.map((r) => {
		const now = r.rv_std_ann ?? (r.rv_std != null ? r.rv_std * (ann ? annFactor : 1) : null);
		return `${r.window}-day RV: ${fp(now)} ${formatTrendArrow(now, baseVal)}`;
	});

	let text =
		header +
		'\n' +
		block1 +
		'\n\n' +
		`【Rolling Trends (${windowsList}-day windows)】\n` +
		trendLines.join('\n') +
		'\n\n' +
		`【Assessment】\nTags: ${tagsAll.join(', ')}`;

	if (view === 'full' && input.series) {
		const { ts: tsArr, close: cArr, ret: retArr } = input.series;
		const firstIso = tsArr.length ? (toIsoTime(tsArr[0]) ?? 'n/a') : 'n/a';
		const lastIso = tsArr.length ? (toIsoTime(tsArr[tsArr.length - 1]) ?? 'n/a') : 'n/a';
		const minClose = cArr.length ? Math.min(...cArr) : null;
		const maxClose = cArr.length ? Math.max(...cArr) : null;
		const mean = retArr.length ? retArr.reduce((s, v) => s + v, 0) / retArr.length : null;
		const std = retArr.length ? stddev(retArr) : null;
		text += `\n\n【Series】\nTotal: ${sampleSize ?? cArr.length} candles\nFirst: ${firstIso} , Last: ${lastIso}\nClose range: ${minClose != null ? Number(minClose).toLocaleString('ja-JP') : 'n/a'} - ${maxClose != null ? Number(maxClose).toLocaleString('ja-JP') : 'n/a'} JPY\nReturns: mean=${formatPercent(mean, { multiply: true, digits: 2 })}, std=${formatPercent(std, { multiply: true, digits: 2 })}${ann ? ' (base interval)' : ''}`;
	}
	return text;
}

export const toolDef: ToolDefinition = {
	name: 'get_volatility_metrics',
	description: `[Volatility / ATR / RV] ボラティリティ指標（volatility / ATR / realized vol）を算出。RV・ATR・Parkinson・Garman-Klass・Rogers-Satchell。年率換算対応。aggregates.atr は Wilder ATR（RMA ベース、period=${WILDER_ATR_PERIOD}、TradingView・MT4 標準と一致）。ローリングではボラ変化を RV / Parkinson で追跡してください。`,
	inputSchema: GetVolMetricsInputSchema,
	handler: async ({
		pair,
		type,
		limit,
		windows,
		useLogReturns,
		annualize,
		view,
	}: z.infer<typeof GetVolMetricsInputSchema>) => {
		const res = await getVolatilityMetrics(pair, type, limit, windows, { useLogReturns, annualize });
		if (!res?.ok) return res;
		const meta = res?.data?.meta || {};
		const a = res?.data?.aggregates || {};
		const roll: VolViewInput['rolling'] = Array.isArray(res?.data?.rolling) ? res.data.rolling : [];
		const closeSeries: number[] = Array.isArray(res?.data?.series?.close) ? res.data.series.close : [];
		const lastClose = closeSeries.at(-1) ?? null;
		const ann = !!meta.annualize;
		const baseMs = Number(meta.baseIntervalMs ?? 0);
		const annFactorFull = baseMs > 0 ? Math.sqrt((365 * 24 * 3600 * 1000) / baseMs) : 1;
		const annFactor = ann ? annFactorFull : 1;
		const rvAnn = a.rv_std_ann != null ? a.rv_std_ann : a.rv_std != null ? a.rv_std * annFactor : null;
		const pkAnn = a.parkinson != null ? a.parkinson * (ann ? annFactor : 1) : null;
		const gkAnn = a.garmanKlass != null ? a.garmanKlass * (ann ? annFactor : 1) : null;
		const rsAnn = a.rogersSatchell != null ? a.rogersSatchell * (ann ? annFactor : 1) : null;
		const atrAbs = a.atr != null ? a.atr : null;
		const atrPct = lastClose ? (atrAbs as number) / lastClose : null;

		// tags: base + derived
		const tagsBase: string[] = Array.isArray(res?.data?.tags) ? [...res.data.tags] : [];
		const tagsDerived: string[] = [];
		// Always use annualized values for tag thresholds (consistent regardless of annualize flag)
		if (Array.isArray(roll) && roll.length >= 2) {
			const minW = Math.min(...roll.map((r) => r.window));
			const maxW = Math.max(...roll.map((r) => r.window));
			const short = roll.find((r) => r.window === minW);
			const long = roll.find((r) => r.window === maxW);
			const shortVal = short
				? (short.rv_std_ann ?? (short.rv_std != null ? short.rv_std * annFactorFull : null))
				: null;
			const longVal = long ? (long.rv_std_ann ?? (long.rv_std != null ? long.rv_std * annFactorFull : null)) : null;
			if (shortVal != null && longVal != null) {
				if (shortVal > longVal * 1.05) tagsDerived.push('expanding_vol');
				else if (shortVal < longVal * 0.95) tagsDerived.push('contracting_vol');
				if (shortVal > 0.4) tagsDerived.push('high_short_term_vol');
			}
		}
		// Use annualized RV for threshold comparison even when annualize=false
		const rvAnnForTags = a.rv_std_ann ?? (a.rv_std != null ? a.rv_std * annFactorFull : null);
		if (rvAnnForTags != null) {
			if (rvAnnForTags > 0.5) tagsDerived.push('high_vol');
			if (rvAnnForTags < 0.2) tagsDerived.push('low_vol');
		}
		if (rvAnn != null && atrPct != null && rvAnn > 0) {
			const diff = Math.abs(atrPct - rvAnn) / rvAnn;
			if (diff > 0.2) tagsDerived.push('atr_divergence');
		}
		const tagsAll = [...new Set([...(tagsBase || []), ...tagsDerived])];

		const viewInput: VolViewInput = {
			pair,
			type,
			lastClose,
			ann,
			annFactor,
			annFactorFull,
			sampleSize: meta.sampleSize ?? 'n/a',
			rvAnn,
			pkAnn,
			gkAnn,
			rsAnn,
			atrAbs,
			atrPct,
			tagsAll,
			rolling: roll,
		};

		// beginner view (plain language for non-experts)
		if (view === 'beginner') {
			const body = buildVolatilityBeginnerText(viewInput);
			const text = prependVolWarning(body, res.meta as { warning?: string });
			return {
				content: [{ type: 'text', text }],
				structuredContent: { ...res, data: { ...res.data, tags: tagsAll } } as Record<string, unknown>,
			};
		}

		// summary view — res.summary に aggregates + rolling 行が含まれるので、
		// ここでは buildVolatilitySummaryText の一行要約ではなく上流 summary をそのまま流す
		// （LLM が default view で rolling window 別 RV/ATR を読めるようにするため）
		if (view === 'summary') {
			return {
				content: [{ type: 'text', text: res.summary }],
				structuredContent: { ...res, data: { ...res.data, tags: tagsAll } } as Record<string, unknown>,
			};
		}

		// detailed/full
		const series = res?.data?.series || {};
		const detailedInput: VolDetailedInput = {
			...viewInput,
			series: {
				ts: Array.isArray(series.ts) ? series.ts : [],
				close: Array.isArray(series.close) ? series.close : [],
				ret: Array.isArray(series.ret) ? series.ret : [],
			},
		};
		const body = buildVolatilityDetailedText(detailedInput, view === 'full' ? 'full' : 'detailed');
		const text = prependVolWarning(body, res.meta as { warning?: string });
		return {
			content: [{ type: 'text', text }],
			structuredContent: { ...res, data: { ...res.data, tags: tagsAll } } as Record<string, unknown>,
		};
	},
};
