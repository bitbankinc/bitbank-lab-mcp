// 一目均衡表の chikou シフトは適用済み。

import { dayjs, toIsoWithTz } from '../lib/datetime.js';
import { roundPriceAtLevel } from '../lib/price.js';
import { fail, failFromError, ok, parseAsResult, toStructured } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { extractUpstreamWarning, prependWarnings } from '../lib/warning-propagation.js';
import type { Candle, FailResult, NumericSeries, OkResult } from '../src/schemas.js';
import { PrepareChartDataInputSchema, PrepareChartDataOutputSchema } from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import analyzeIndicators from './analyze_indicators.js';

const CANDLE_FORMAT = ['open', 'high', 'low', 'close', 'volume'] as const;

const MAIN_SERIES_KEYS: Record<string, string[]> = {
	SMA_5: ['SMA_5'],
	SMA_20: ['SMA_20'],
	SMA_25: ['SMA_25'],
	SMA_50: ['SMA_50'],
	SMA_75: ['SMA_75'],
	SMA_200: ['SMA_200'],
	EMA_12: ['EMA_12'],
	EMA_26: ['EMA_26'],
	EMA_50: ['EMA_50'],
	EMA_200: ['EMA_200'],
	BB: ['BB_upper', 'BB_middle', 'BB_lower'],
	ICHIMOKU: ['ICHI_tenkan', 'ICHI_kijun', 'ICHI_spanA', 'ICHI_spanB', 'ICHI_chikou'],
};

function isAllNull(series: NumericSeries): boolean {
	return series.every((v) => v === null);
}

function toRoundedArray(series: NumericSeries, round: (v: number) => number): (number | null)[] | undefined {
	if (isAllNull(series)) return undefined;
	return series.map((v) => (v === null ? null : round(v)));
}

const roundTo2 = (v: number) => Number(v.toFixed(2));

interface CompactCandle {
	/** [open, high, low, close, volume] */
	ohlcv: number[];
}

interface CompactSubPanels {
	RSI_14?: (number | null)[];
	MACD?: { line: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] };
	STOCH_K?: (number | null)[];
	STOCH_D?: (number | null)[];
}

interface PrepareChartDataResult {
	times: string[];
	labels?: string[];
	candleFormat: readonly string[];
	candles: CompactCandle['ohlcv'][];
	series?: Record<string, (number | null)[]>;
	subPanels?: CompactSubPanels;
}

interface PrepareChartDataMeta {
	pair: string;
	type: string;
	count: number;
	indicators: string[];
	volumeUnit: string;
	warning?: string;
	warnings?: string[];
}

function labelFormat(candleType: string): string {
	switch (candleType) {
		case '1day':
		case '1week':
		case '1month':
			return 'MM/DD';
		default:
			return 'MM/DD HH:mm';
	}
}

export default async function prepareChartData(
	pair: string = 'btc_jpy',
	type: string = '1day',
	limit: number = 30,
	indicators?: string[],
	tz: string = 'Asia/Tokyo',
): Promise<OkResult<PrepareChartDataResult, PrepareChartDataMeta> | FailResult> {
	const chk = ensurePair(pair);
	if (!chk.ok) return fail(chk.error.message, chk.error.type);

	const MAX_TOTAL_SERIES = 150; // limit × (1 + indicatorCount) の上限
	const indicatorCount = indicators?.length ?? 0;
	const seriesMultiplier = 1 + indicatorCount; // 1 = OHLCV 本体
	let effectiveLimit = limit;
	if (seriesMultiplier > 1 && limit * seriesMultiplier > MAX_TOTAL_SERIES) {
		effectiveLimit = Math.max(5, Math.floor(MAX_TOTAL_SERIES / seriesMultiplier));
	}

	try {
		const res = await analyzeIndicators(chk.pair, type, effectiveLimit);
		if (!res.ok) return fail(res.summary.replace(/^Error: /, ''), res.meta.errorType);

		const chart = res.data.chart;
		const candles = chart.candles.slice(-effectiveLimit);
		const chartIndicators = chart.indicators as Record<string, unknown>;

		const selectedGroups = indicators && indicators.length > 0 ? new Set(indicators) : new Set<string>();

		const useTz = typeof tz === 'string' && tz.length > 0;
		const fmt = labelFormat(type);
		const times: string[] = [];
		const labels: string[] | undefined = useTz ? [] : undefined;

		for (const c of candles) {
			const iso = c.isoTime ?? '';
			if (!useTz || !iso) {
				times.push(iso);
			} else {
				const ms = dayjs.utc(iso).valueOf();
				times.push(toIsoWithTz(ms, tz) ?? iso);
				labels?.push(dayjs(ms).tz(tz).format(fmt));
			}
		}

		// ローソク足は取引所の価格（呼び値の刻み）のままなので丸めない。
		const compactCandles = candles.map((c: Candle) => [c.open, c.high, c.low, c.close, c.volume ?? 0]);
		// MACD は価格の差なので、値自体ではなく価格の水準で桁を決める。
		const priceLevel = candles.at(-1)?.close ?? 0;
		const roundAtPriceLevel = (v: number) => roundPriceAtLevel(v, priceLevel);

		const series: Record<string, (number | null)[]> = {};
		for (const [group, keys] of Object.entries(MAIN_SERIES_KEYS)) {
			if (!selectedGroups.has(group)) continue;
			for (const key of keys) {
				const arr = chartIndicators[key];
				if (!Array.isArray(arr)) continue;
				const sliced = (arr as NumericSeries).slice(-effectiveLimit);
				const rounded = toRoundedArray(sliced, (v) => roundPriceAtLevel(v));
				if (rounded) {
					series[key] = rounded;
				}
			}
		}

		const subPanels: CompactSubPanels = {};

		if (selectedGroups.has('RSI')) {
			const rsiArr = chartIndicators.RSI_14_series;
			if (Array.isArray(rsiArr)) {
				const sliced = (rsiArr as NumericSeries).slice(-effectiveLimit);
				const rounded = toRoundedArray(sliced, roundTo2);
				if (rounded) subPanels.RSI_14 = rounded;
			}
		}

		if (selectedGroups.has('MACD')) {
			const macdData = chartIndicators.macd_series as
				| { line: NumericSeries; signal: NumericSeries; hist: NumericSeries }
				| undefined;
			if (macdData) {
				const line = toRoundedArray(macdData.line.slice(-effectiveLimit), roundAtPriceLevel);
				const signal = toRoundedArray(macdData.signal.slice(-effectiveLimit), roundAtPriceLevel);
				const hist = toRoundedArray(macdData.hist.slice(-effectiveLimit), roundAtPriceLevel);
				if (line || signal || hist) {
					subPanels.MACD = {
						line: line ?? macdData.line.slice(-effectiveLimit),
						signal: signal ?? macdData.signal.slice(-effectiveLimit),
						hist: hist ?? macdData.hist.slice(-effectiveLimit),
					};
				}
			}
		}

		if (selectedGroups.has('STOCH')) {
			const stochK = chartIndicators.stoch_k_series;
			const stochD = chartIndicators.stoch_d_series;
			if (Array.isArray(stochK)) {
				const rounded = toRoundedArray((stochK as NumericSeries).slice(-effectiveLimit), roundTo2);
				if (rounded) subPanels.STOCH_K = rounded;
			}
			if (Array.isArray(stochD)) {
				const rounded = toRoundedArray((stochD as NumericSeries).slice(-effectiveLimit), roundTo2);
				if (rounded) subPanels.STOCH_D = rounded;
			}
		}

		const hasSeries = Object.keys(series).length > 0;
		const hasSubPanels = Object.keys(subPanels).length > 0;
		const indicatorNames = [...Object.keys(series), ...Object.keys(subPanels)];

		const data: PrepareChartDataResult = {
			times,
			...(labels ? { labels } : {}),
			candleFormat: CANDLE_FORMAT,
			candles: compactCandles,
			...(hasSeries ? { series } : {}),
			...(hasSubPanels ? { subPanels } : {}),
		};

		const volumeUnit = chk.pair.split('_')[0].toUpperCase();

		const upstream = extractUpstreamWarning(res.meta);

		// 自動切り詰めでユーザー指定値を黙って書き換えないよう、上流 warning と同じ meta.warning に載せて ⚠️ 行で出す。
		const truncWarning =
			effectiveLimit < limit ? `limit was capped from ${limit} to ${effectiveLimit} to reduce context size` : undefined;
		const mergedWarning = [truncWarning, upstream.warning].filter(Boolean).join('\n') || undefined;
		const mergedUpstream: typeof upstream = {
			...(mergedWarning ? { warning: mergedWarning } : {}),
			...(upstream.warnings ? { warnings: upstream.warnings } : {}),
		};

		const meta: PrepareChartDataMeta = {
			...createMeta(chk.pair),
			type,
			count: candles.length,
			indicators: indicatorNames,
			volumeUnit,
			...mergedUpstream,
		};

		const seriesNote = indicatorNames.length > 0 ? `, indicators: ${indicatorNames.join(', ')}` : '';
		const baseSummary = `${chk.pair} ${type} chart data (${candles.length} candles${seriesNote})`;
		const summary = prependWarnings(baseSummary, mergedUpstream, { separator: '\n' });
		// meta.warning / warnings は schema に含めてあるので parse で strip されない。
		return parseAsResult<PrepareChartDataResult, PrepareChartDataMeta>(
			PrepareChartDataOutputSchema,
			ok(summary, data, meta),
		);
	} catch (err: unknown) {
		return failFromError(err);
	}
}

export const toolDef: ToolDefinition = {
	name: 'prepare_chart_data',
	description:
		'[Chart / Candlestick / Visualization] チャート描画の第一選択ツール。\n\n' +
		'⚠️ limit はデフォルト 30 を推奨。ユーザーが期間を明示した場合のみ増やすこと。\n' +
		'indicators はユーザーが明示的に要求した指標のみ指定すること。分析のついでに追加しない。\n' +
		'indicators の同時指定はコンテキストを大幅に消費するため、必要最小限に留めること。\n\n' +
		'デフォルトはローソク足（OHLCV）のみ返す。indicators 未指定 = ローソク足のみ。\n' +
		'指標が必要な場合は indicators に明示指定: SMA_5, SMA_20, SMA_25, SMA_50, SMA_75, SMA_200, EMA_12, EMA_26, EMA_50, EMA_200, BB, ICHIMOKU, RSI, MACD, STOCH\n\n' +
		'レスポンス形式: { times[], labels?[], candles: [[o,h,l,c,v],...], series?: {指標名: values[]}, subPanels?: {...} }\n' +
		'ローソク足は取引所の価格のまま。指標の値は価格の水準に合わせて丸め済み（10 万円以上は円の整数、安いペアほど小数の桁が増える）。全 null 系列は自動除外。\n\n' +
		'tz パラメータ（例: "Asia/Tokyo"）指定時、times がローカル時刻に変換され、labels（"03/16 17:00" 等の短縮表示文字列）も付加される。\n\n' +
		'SVG/PNG ファイル保存 → render_chart_svg。指標の最新値やトレンド判定 → analyze_indicators。',
	inputSchema: PrepareChartDataInputSchema,
	handler: async ({
		pair,
		type,
		limit,
		indicators,
		tz,
	}: {
		pair?: string;
		type?: string;
		limit?: number;
		indicators?: string[];
		tz?: string;
	}) => {
		const result = await prepareChartData(pair ?? 'btc_jpy', type ?? '1day', limit ?? 30, indicators, tz);
		if (!result.ok) return result;
		const text = `${result.summary}\n${JSON.stringify(result.data)}`;
		return {
			content: [{ type: 'text', text }],
			structuredContent: toStructured(result),
		};
	},
};
