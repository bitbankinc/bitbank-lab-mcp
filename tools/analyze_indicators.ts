import { TtlCache } from '../lib/cache.js';
import { formatSummary } from '../lib/formatter.js';
import { getFetchCount } from '../lib/indicator_buffer.js';
import {
	BB_PERIOD,
	BB_STDDEV,
	ICHIMOKU_SHIFT,
	INDICATOR_CACHE_MAX_ENTRIES,
	INDICATOR_CACHE_TTL_MS,
	MACD_FAST,
	MACD_SIGNAL,
	MACD_SLOW,
	OBV_SMA_PERIOD,
	OBV_TREND_THRESHOLD,
	RSI_OVERBOUGHT,
	RSI_OVERSOLD,
	RSI_PERIOD,
	SMA_DEFAULT_PERIOD,
	STOCH_PERIOD,
	STOCH_SMOOTH_D,
	STOCH_SMOOTH_K,
} from '../lib/indicator-config.js';
import {
	ichimokuSnapshot,
	bollingerBands as rawBollingerBands,
	ema as rawEma,
	ichimokuSeries as rawIchimokuSeries,
	macd as rawMacd,
	obv as rawObv,
	rsi as rawRsi,
	shiftChikou as rawShiftChikou,
	sma as rawSma,
	stochastic as rawStochastic,
	stochRSI as rawStochRSI,
	toNumericSeries,
} from '../lib/indicators.js';
import { isLatestBarProvisional, prependProvisionalNote } from '../lib/provisional-bar.js';
import { fail, failFromValidation, ok, parseAsResult } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import type {
	Candle,
	CandleType,
	FailResult,
	GetIndicatorsData,
	GetIndicatorsMeta,
	NumericSeries,
	OkResult,
	TrendLabel,
} from '../src/schemas.js';
import { GetIndicatorsDataSchema, GetIndicatorsMetaSchema, GetIndicatorsOutputSchema } from '../src/schemas.js';
import getCandles from './get_candles.js';

// --- Result cache for analyzeIndicators ---
// Same pair/type within TTL → skip redundant API call & computation.
// Especially effective when snapshot tools (BB/SMA/Ichimoku) are called
// sequentially for the same pair.

interface IndicatorCacheComputed {
	normalized: Candle[];
	raw: unknown;
	indicators: GetIndicatorsData['indicators'];
	allCloses: number[];
	rsi14_series: NumericSeries;
	sma_25_series: NumericSeries;
	sma_75_series: NumericSeries;
	bb2: { upper: NumericSeries; middle: NumericSeries; lower: NumericSeries };
	warnings: string[];
	trend: TrendLabel;
	fetchCount: number;
	// 上流 get_candles の fetchWarning（multi-year/multi-day 部分失敗等）。
	// cache miss 時に candlesResult.meta.warning を保存し、cache hit 時もここから返す。
	// 落とすと 2 回目以降 warning が消えるので必ず cache に乗せる。
	upstreamWarning?: string;
}

const indicatorCache = new TtlCache<IndicatorCacheComputed>({
	ttlMs: INDICATOR_CACHE_TTL_MS,
	maxEntries: INDICATOR_CACHE_MAX_ENTRIES,
});

/** Clear the indicator cache (useful for testing). */
export function clearIndicatorCache(): void {
	indicatorCache.clear();
}

// --- Indicators (delegates to lib/indicators.ts) ---

export function sma(values: number[], period: number = SMA_DEFAULT_PERIOD): NumericSeries {
	return toNumericSeries(rawSma(values, period), 2);
}

export function rsi(values: number[], period: number = RSI_PERIOD): NumericSeries {
	return toNumericSeries(rawRsi(values, period), 2);
}

export function bollingerBands(
	values: number[],
	period: number = BB_PERIOD,
	stdDev: number = BB_STDDEV,
): { upper: NumericSeries; middle: NumericSeries; lower: NumericSeries } {
	const raw = rawBollingerBands(values, period, stdDev);
	return {
		upper: toNumericSeries(raw.upper, 2),
		middle: toNumericSeries(raw.middle, 2),
		lower: toNumericSeries(raw.lower, 2),
	};
}

// Exponential Moving Average
export function ema(values: number[], period: number): NumericSeries {
	if (period <= 1) return values.map((v) => (v != null ? Number(v.toFixed(2)) : null));
	return toNumericSeries(rawEma(values, period), 2);
}

export function macd(
	values: number[],
	fast = MACD_FAST,
	slow = MACD_SLOW,
	signal = MACD_SIGNAL,
): { line: NumericSeries; signal: NumericSeries; hist: NumericSeries } {
	const raw = rawMacd(values, fast, slow, signal);
	return {
		line: toNumericSeries(raw.line, 2),
		signal: toNumericSeries(raw.signal, 2),
		hist: toNumericSeries(raw.hist, 2),
	};
}

export function ichimokuSeries(
	highs: number[],
	lows: number[],
	closes: number[],
): { tenkan: NumericSeries; kijun: NumericSeries; spanA: NumericSeries; spanB: NumericSeries; chikou: NumericSeries } {
	const raw = rawIchimokuSeries(highs, lows, closes);
	return {
		tenkan: toNumericSeries(raw.tenkan, 2),
		kijun: toNumericSeries(raw.kijun, 2),
		spanA: toNumericSeries(raw.spanA, 2),
		spanB: toNumericSeries(raw.spanB, 2),
		chikou: toNumericSeries(raw.chikou, 2),
	};
}

/**
 * Stochastic RSI: RSI値にストキャスティクス計算を適用。
 */
export function computeStochRSI(
	closes: number[],
	rsiPeriod = RSI_PERIOD,
	stochPeriod = STOCH_PERIOD,
	smoothK = STOCH_SMOOTH_K,
	smoothD = STOCH_SMOOTH_D,
): { k: number | null; d: number | null; prevK: number | null; prevD: number | null } {
	const raw = rawStochRSI(closes, rsiPeriod, stochPeriod, smoothK, smoothD);
	const kNs = toNumericSeries(raw.kSeries, 2);
	const dNs = toNumericSeries(raw.dSeries, 2);
	return {
		k: kNs.at(-1) ?? null,
		d: dNs.at(-1) ?? null,
		prevK: kNs.at(-2) ?? null,
		prevD: dNs.at(-2) ?? null,
	};
}

/**
 * Classic Stochastic Oscillator: 価格のレンジ内位置を測定。
 */
export function computeClassicStochastic(
	highs: number[],
	lows: number[],
	closes: number[],
	kPeriod = STOCH_PERIOD,
	smoothK = STOCH_SMOOTH_K,
	smoothD = STOCH_SMOOTH_D,
): {
	kSeries: (number | null)[];
	dSeries: (number | null)[];
	k: number | null;
	d: number | null;
	prevK: number | null;
	prevD: number | null;
} {
	const raw = rawStochastic(highs, lows, closes, kPeriod, smoothK, smoothD);
	const kSeries = toNumericSeries(raw.kSeries, 2);
	const dSeries = toNumericSeries(raw.dSeries, 2);
	return {
		kSeries,
		dSeries,
		k: kSeries.at(-1) ?? null,
		d: dSeries.at(-1) ?? null,
		prevK: kSeries.at(-2) ?? null,
		prevD: dSeries.at(-2) ?? null,
	};
}

/**
 * OBV (On-Balance Volume): 出来高を価格方向に応じて累積加算/減算。
 */
export function computeOBV(
	candles: Candle[],
	smaPeriod = OBV_SMA_PERIOD,
): { obv: number | null; obvSma: number | null; prevObv: number | null; trend: 'rising' | 'falling' | 'flat' | null } {
	if (candles.length < 2) return { obv: null, obvSma: null, prevObv: null, trend: null };

	const closes = candles.map((c) => c.close);
	const volumes = candles.map((c) => c.volume ?? 0);
	const obvSeries = rawObv(closes, volumes);

	const obvVal = obvSeries.at(-1) ?? null;
	const prevObv = obvSeries.at(-2) ?? null;

	// SMA of OBV
	let obvSma: number | null = null;
	if (obvSeries.length >= smaPeriod) {
		const slice = obvSeries.slice(-smaPeriod);
		obvSma = Number((slice.reduce((a, b) => a + b, 0) / smaPeriod).toFixed(2));
	}

	// Trend: compare OBV to its SMA
	let trend: 'rising' | 'falling' | 'flat' | null = null;
	if (obvVal != null && obvSma != null) {
		const diff = obvVal - obvSma;
		const threshold = Math.abs(obvSma) * OBV_TREND_THRESHOLD;
		if (diff > threshold) trend = 'rising';
		else if (diff < -threshold) trend = 'falling';
		else trend = 'flat';
	}

	return { obv: obvVal, obvSma, prevObv, trend };
}

function ichimoku(
	highs: number[],
	lows: number[],
	closes: number[],
): { conversion: number; base: number; spanA: number; spanB: number } | null {
	const snap = ichimokuSnapshot(highs, lows, closes);
	if (!snap) return null;
	return {
		conversion: Number(snap.conversion.toFixed(2)),
		base: Number(snap.base.toFixed(2)),
		spanA: Number(snap.spanA.toFixed(2)),
		spanB: Number(snap.spanB.toFixed(2)),
	};
}

function createChartData(
	normalized: Candle[],
	indicators: GetIndicatorsData['indicators'],
	limit: number = 50,
): GetIndicatorsData['chart'] {
	const fullLength = normalized.length;
	const recent = normalized.slice(-limit);
	const pastBuffer = fullLength - recent.length;
	const shift = ICHIMOKU_SHIFT;

	return {
		candles: normalized,
		indicators: {
			SMA_5: indicators.sma_5_series ?? [],
			SMA_20: indicators.sma_20_series ?? [],
			SMA_25: indicators.sma_25_series ?? [],
			SMA_50: indicators.sma_50_series ?? [],
			SMA_75: indicators.sma_75_series ?? [],
			SMA_200: indicators.sma_200_series ?? [],
			EMA_12: indicators.ema_12_series ?? [],
			EMA_26: indicators.ema_26_series ?? [],
			EMA_50: indicators.ema_50_series ?? [],
			EMA_200: indicators.ema_200_series ?? [],
			RSI_14: indicators.RSI_14,
			BB1_upper: indicators.bb1_series?.upper ?? [],
			BB1_middle: indicators.bb1_series?.middle ?? [],
			BB1_lower: indicators.bb1_series?.lower ?? [],
			BB2_upper: indicators.bb2_series?.upper ?? [],
			BB2_middle: indicators.bb2_series?.middle ?? [],
			BB2_lower: indicators.bb2_series?.lower ?? [],
			BB3_upper: indicators.bb3_series?.upper ?? [],
			BB3_middle: indicators.bb3_series?.middle ?? [],
			BB3_lower: indicators.bb3_series?.lower ?? [],
			BB_upper: indicators.bb2_series?.upper ?? [],
			BB_middle: indicators.bb2_series?.middle ?? [],
			BB_lower: indicators.bb2_series?.lower ?? [],
			ICHI_tenkan: indicators.ichi_series?.tenkan ?? [],
			ICHI_kijun: indicators.ichi_series?.kijun ?? [],
			ICHI_spanA: indicators.ichi_series?.spanA ?? [],
			ICHI_spanB: indicators.ichi_series?.spanB ?? [],
			ICHI_chikou: indicators.ichi_series?.chikou
				? toNumericSeries(
						rawShiftChikou(
							indicators.ichi_series.chikou.map((v) => v ?? NaN),
							shift,
						),
						2,
					)
				: [],
			macd_series: indicators.macd_series,
			RSI_14_series: indicators.RSI_14_series ?? [],
			stoch_k_series: indicators.stoch_k_series ?? [],
			stoch_d_series: indicators.stoch_d_series ?? [],
		},
		meta: { pastBuffer, shift },
		stats: {
			min: Math.min(...recent.map((c) => c.low)),
			max: Math.max(...recent.map((c) => c.high)),
			avg: recent.reduce((sum, c) => sum + c.close, 0) / Math.max(1, recent.length),
			volume_avg: recent.reduce((sum, c) => sum + (c.volume ?? 0), 0) / Math.max(1, recent.length),
		},
	};
}

function computeAllIndicators(normalized: Candle[]): GetIndicatorsData['indicators'] {
	const allHighs = normalized.map((c) => c.high);
	const allLows = normalized.map((c) => c.low);
	const allCloses = normalized.map((c) => c.close);

	const rsi14_series = rsi(allCloses, RSI_PERIOD);
	const macdSeries = macd(allCloses, MACD_FAST, MACD_SLOW, MACD_SIGNAL);
	const bb1 = bollingerBands(allCloses, BB_PERIOD, 1);
	const bb2Val = bollingerBands(allCloses, BB_PERIOD, BB_STDDEV);
	const bb3 = bollingerBands(allCloses, BB_PERIOD, 3);
	const ichi = ichimokuSeries(allHighs, allLows, allCloses);
	const sma_5_series = sma(allCloses, 5);
	const sma_20_series = sma(allCloses, 20);
	const sma_25_series = sma(allCloses, 25);
	const sma_50_series = sma(allCloses, 50);
	const sma_75_series = sma(allCloses, 75);
	const sma_200_series = sma(allCloses, 200);
	const ema_12_series = ema(allCloses, 12);
	const ema_26_series = ema(allCloses, 26);
	const ema_50_series = ema(allCloses, 50);
	const ema_200_series = ema(allCloses, 200);

	const ichiSimple = ichimoku(allHighs, allLows, allCloses);
	const stoch = computeClassicStochastic(allHighs, allLows, allCloses, STOCH_PERIOD, STOCH_SMOOTH_K, STOCH_SMOOTH_D);
	const stochRsi = computeStochRSI(allCloses, RSI_PERIOD, STOCH_PERIOD, STOCH_SMOOTH_K, STOCH_SMOOTH_D);
	const obvResult = computeOBV(normalized, OBV_SMA_PERIOD);

	return {
		SMA_5: sma_5_series.at(-1),
		SMA_20: sma_20_series.at(-1),
		SMA_25: sma_25_series.at(-1),
		SMA_50: sma_50_series.at(-1),
		SMA_75: sma_75_series.at(-1),
		SMA_200: sma_200_series.at(-1),
		RSI_14: rsi14_series.at(-1),
		RSI_14_series: rsi14_series,
		BB_upper: bb2Val.upper.at(-1),
		BB_middle: bb2Val.middle.at(-1),
		BB_lower: bb2Val.lower.at(-1),
		BB1_upper: bb1.upper.at(-1),
		BB1_middle: bb1.middle.at(-1),
		BB1_lower: bb1.lower.at(-1),
		BB2_upper: bb2Val.upper.at(-1),
		BB2_middle: bb2Val.middle.at(-1),
		BB2_lower: bb2Val.lower.at(-1),
		BB3_upper: bb3.upper.at(-1),
		BB3_middle: bb3.middle.at(-1),
		BB3_lower: bb3.lower.at(-1),
		bb1_series: bb1,
		bb2_series: bb2Val,
		bb3_series: bb3,
		ichi_series: ichi,
		macd_series: macdSeries,
		sma_5_series,
		sma_20_series,
		sma_25_series,
		sma_50_series,
		sma_75_series,
		sma_200_series,
		EMA_12: ema_12_series.at(-1),
		EMA_26: ema_26_series.at(-1),
		EMA_50: ema_50_series.at(-1),
		EMA_200: ema_200_series.at(-1),
		ema_12_series,
		ema_26_series,
		ema_50_series,
		ema_200_series,
		MACD_line: macdSeries.line.at(-1),
		MACD_signal: macdSeries.signal.at(-1),
		MACD_hist: macdSeries.hist.at(-1),
		...(ichiSimple
			? {
					ICHIMOKU_conversion: ichiSimple.conversion,
					ICHIMOKU_base: ichiSimple.base,
					ICHIMOKU_spanA: ichiSimple.spanA,
					ICHIMOKU_spanB: ichiSimple.spanB,
				}
			: {}),
		STOCH_K: stoch.k,
		STOCH_D: stoch.d,
		STOCH_prevK: stoch.prevK,
		STOCH_prevD: stoch.prevD,
		stoch_k_series: stoch.kSeries,
		stoch_d_series: stoch.dSeries,
		STOCH_RSI_K: stochRsi.k,
		STOCH_RSI_D: stochRsi.d,
		STOCH_RSI_prevK: stochRsi.prevK,
		STOCH_RSI_prevD: stochRsi.prevD,
		OBV: obvResult.obv,
		OBV_SMA20: obvResult.obvSma,
		OBV_prevObv: obvResult.prevObv,
		OBV_trend: obvResult.trend,
	};
}

function buildWarnings(dataLength: number, candleCount: number): string[] {
	const warnings: string[] = [];
	if (dataLength < 5) warnings.push('SMA_5: データ不足');
	if (dataLength < 20) warnings.push('SMA_20: データ不足');
	if (dataLength < 25) warnings.push('SMA_25: データ不足');
	if (dataLength < 50) warnings.push('SMA_50: データ不足');
	if (dataLength < 75) warnings.push('SMA_75: データ不足');
	if (dataLength < 200) warnings.push('SMA_200: データ不足');
	if (dataLength < 12) warnings.push('EMA_12: データ不足');
	if (dataLength < 26) warnings.push('EMA_26: データ不足');
	if (dataLength < 50) warnings.push('EMA_50: データ不足');
	if (dataLength < 200) warnings.push('EMA_200: データ不足');
	if (dataLength < 15) warnings.push('RSI_14: データ不足');
	if (dataLength < 20) warnings.push('Bollinger_Bands: データ不足');
	if (dataLength < 52) warnings.push('Ichimoku: データ不足');
	// classic Stochastic（kPeriod=14, smoothK=3, smoothD=3）の最新 %D は
	// kPeriod + smoothK + smoothD - 2 = 18 本目で確定する（lib/indicators.ts の早期 return 条件と一致）。
	if (dataLength < 18) warnings.push('Stochastic: データ不足');
	if (dataLength < 34) warnings.push('StochRSI: データ不足');
	if (candleCount < 2) warnings.push('OBV: データ不足');
	return warnings;
}

function padSeriesLengths(chartIndicators: Record<string, unknown>, targetLength: number): void {
	const keys = [
		'SMA_5',
		'SMA_20',
		'SMA_25',
		'SMA_50',
		'SMA_75',
		'SMA_200',
		'EMA_12',
		'EMA_26',
		'EMA_50',
		'EMA_200',
		'BB_upper',
		'BB_middle',
		'BB_lower',
		'BB1_upper',
		'BB1_middle',
		'BB1_lower',
		'BB2_upper',
		'BB2_middle',
		'BB2_lower',
		'BB3_upper',
		'BB3_middle',
		'BB3_lower',
		'ICHI_tenkan',
		'ICHI_kijun',
		'ICHI_spanA',
		'ICHI_spanB',
		'ICHI_chikou',
		'RSI_14_series',
		'stoch_k_series',
		'stoch_d_series',
	];
	keys.forEach((k) => {
		const arr = chartIndicators[k] as NumericSeries | undefined;
		if (!Array.isArray(arr)) return;
		if (arr.length === targetLength) return;
		if (arr.length < targetLength) {
			const pad = Array.from<null>({ length: targetLength - arr.length }).fill(null);
			(chartIndicators[k] as NumericSeries) = [...arr, ...pad];
		} else {
			(chartIndicators[k] as NumericSeries) = arr.slice(-targetLength);
		}
	});
}

function buildIndicatorsSummaryText(opts: {
	pair: string;
	type: string;
	indicators: GetIndicatorsData['indicators'];
	allCloses: number[];
	rsi14_series: NumericSeries;
	sma_25_series: NumericSeries;
	sma_75_series: NumericSeries;
	bb2: { upper: NumericSeries; middle: NumericSeries; lower: NumericSeries };
	trend: TrendLabel;
	normalized: Candle[];
	displayCount: number;
}): string {
	const {
		pair,
		type,
		indicators,
		allCloses,
		rsi14_series: rsi14_s,
		sma_25_series: sma25_s,
		sma_75_series: sma75_s,
		bb2: bb2_s,
		trend,
		normalized,
		displayCount,
	} = opts;

	const latestIndicators: Record<string, number | null | undefined> = {
		SMA_25: indicators.SMA_25,
		SMA_75: indicators.SMA_75,
		SMA_200: indicators.SMA_200,
		RSI_14: indicators.RSI_14,
		MACD_line: indicators.MACD_line,
		MACD_signal: indicators.MACD_signal,
		MACD_hist: indicators.MACD_hist,
	};
	if (indicators.ICHIMOKU_conversion) {
		latestIndicators.ICHIMOKU_conversion = indicators.ICHIMOKU_conversion;
		latestIndicators.ICHIMOKU_base = indicators.ICHIMOKU_base;
		latestIndicators.ICHIMOKU_spanA = indicators.ICHIMOKU_spanA;
		latestIndicators.ICHIMOKU_spanB = indicators.ICHIMOKU_spanB;
	}

	const baseSummary = formatSummary({
		pair,
		timeframe: String(type),
		latest: allCloses.at(-1) ?? undefined,
		extra: `RSI=${latestIndicators.RSI_14} trend=${trend} (count=${allCloses.length})`,
	});

	const indLines: string[] = [];
	for (const [k, v] of Object.entries(latestIndicators)) {
		if (v != null) indLines.push(`${k}:${v}`);
	}
	if (indicators.ICHIMOKU_conversion != null) {
		indLines.push(`ICHI_conv:${indicators.ICHIMOKU_conversion}`);
		indLines.push(`ICHI_base:${indicators.ICHIMOKU_base}`);
		indLines.push(`ICHI_spanA:${indicators.ICHIMOKU_spanA}`);
		indLines.push(`ICHI_spanB:${indicators.ICHIMOKU_spanB}`);
	}

	const recentN = Math.min(displayCount, normalized.length);
	const recentSlice = normalized.slice(-recentN);
	const recentLines = recentSlice.map((c, i) => {
		const idx = normalized.length - recentN + i;
		const t = c.isoTime ? String(c.isoTime).replace(/\.000Z$/, 'Z') : '?';
		const r = rsi14_s[idx] != null ? ` RSI:${rsi14_s[idx]}` : '';
		const s25 = sma25_s[idx] != null ? ` S25:${sma25_s[idx]}` : '';
		const s75 = sma75_s[idx] != null ? ` S75:${sma75_s[idx]}` : '';
		const bbu = bb2_s.upper[idx] != null ? ` BBu:${bb2_s.upper[idx]}` : '';
		const bbl = bb2_s.lower[idx] != null ? ` BBl:${bb2_s.lower[idx]}` : '';
		return `[${idx}] ${t} C:${c.close}${r}${s25}${s75}${bbu}${bbl}`;
	});

	return (
		baseSummary +
		`\n\n📊 最新インジケーター値:\n` +
		indLines.join(' | ') +
		`\n\n📋 直近${recentN}本のデータ:\n` +
		recentLines.join('\n') +
		`\n\n---\n📌 含まれるもの: RSI・MACD・SMA・BB・一目均衡表の計算値と時系列、トレンド判定` +
		`\n📌 含まれないもの: 板情報、出来高フロー（CVD・売買内訳）、大口動向、チャートパターン` +
		`\n📌 補完ツール: get_flow_metrics（フロー・CVD）, get_orderbook（板情報）, detect_whale_events（大口）, detect_patterns（パターン）`
	);
}

function analyzeTrend(
	indicators: GetIndicatorsData['indicators'],
	currentPrice: number | null | undefined,
): TrendLabel {
	if (!indicators.SMA_25 || !indicators.SMA_75 || currentPrice == null) return 'insufficient_data';

	const sma25 = indicators.SMA_25 as number | null;
	const sma75 = indicators.SMA_75 as number | null;
	const sma200 = indicators.SMA_200 as number | null;
	const rsi = indicators.RSI_14 as number | null;

	if (
		currentPrice > (sma25 ?? Number.POSITIVE_INFINITY) &&
		(sma25 ?? Number.POSITIVE_INFINITY) > (sma75 ?? Number.NEGATIVE_INFINITY)
	) {
		if (sma200 && currentPrice > sma200) return 'strong_uptrend';
		return 'uptrend';
	}

	if (
		currentPrice < (sma25 ?? Number.NEGATIVE_INFINITY) &&
		(sma25 ?? Number.NEGATIVE_INFINITY) < (sma75 ?? Number.POSITIVE_INFINITY)
	) {
		if (sma200 && currentPrice < sma200) return 'strong_downtrend';
		return 'downtrend';
	}

	if (rsi != null && rsi >= RSI_OVERBOUGHT) return 'overbought';
	if (rsi != null && rsi <= RSI_OVERSOLD) return 'oversold';
	return 'sideways';
}

export default async function analyzeIndicators(
	pair: string = 'btc_jpy',
	type: CandleType | string = '1day',
	limit: number | null = null,
): Promise<OkResult<GetIndicatorsData, GetIndicatorsMeta> | FailResult> {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk);

	const displayCount = limit || 60;

	const indicatorKeys = [
		'SMA_5',
		'SMA_20',
		'SMA_25',
		'SMA_50',
		'SMA_75',
		'SMA_200',
		'EMA_12',
		'EMA_26',
		'EMA_50',
		'EMA_200',
		'RSI_14',
		'BB_20',
		'STOCH',
		'ICHIMOKU',
	] as const;
	const fetchCount = getFetchCount(displayCount, indicatorKeys);

	// Check cache before fetching & computing
	const cacheKey = `${chk.pair}:${type}`;
	const cached = indicatorCache.get(cacheKey);
	let computed: IndicatorCacheComputed;

	if (cached && cached.fetchCount >= fetchCount) {
		computed = cached;
	} else {
		const candlesResult = await getCandles(chk.pair, type, undefined, fetchCount);
		if (!candlesResult.ok) return fail(candlesResult.summary.replace(/^Error: /, ''), candlesResult.meta.errorType);

		const normalized = candlesResult.data.normalized;
		const allCloses = normalized.map((c) => c.close);

		const indicators = computeAllIndicators(normalized);
		const warnings = buildWarnings(allCloses.length, normalized.length);
		const trend = analyzeTrend(indicators, allCloses.at(-1));

		computed = {
			normalized,
			raw: candlesResult.data.raw,
			indicators,
			allCloses,
			rsi14_series: indicators.RSI_14_series ?? [],
			sma_25_series: indicators.sma_25_series ?? [],
			sma_75_series: indicators.sma_75_series ?? [],
			bb2: indicators.bb2_series ?? { upper: [], middle: [], lower: [] },
			warnings,
			trend,
			fetchCount,
			upstreamWarning: candlesResult.meta.warning,
		};

		indicatorCache.set(cacheKey, computed);
	}

	// --- Build result from computed data (always uses current displayCount/fetchCount) ---
	const { normalized, indicators, allCloses, warnings, trend } = computed;

	const chartData = createChartData(normalized, indicators, displayCount);
	padSeriesLengths(chartData.indicators as Record<string, unknown>, chartData.candles.length);

	// 最新足が形成中（未確定）か。realtime 取得（date 未指定）では最新足は現在形成中の足。
	// now 依存のためキャッシュには載せず、毎回 normalized 末尾 ts から判定する。
	const provisional = isLatestBarProvisional(normalized.at(-1)?.timestamp, String(type));

	const baseSummary = buildIndicatorsSummaryText({
		pair: chk.pair,
		type: String(type),
		indicators,
		allCloses,
		rsi14_series: computed.rsi14_series,
		sma_25_series: computed.sma_25_series,
		sma_75_series: computed.sma_75_series,
		bb2: computed.bb2,
		trend,
		normalized,
		displayCount,
	});
	// 形成中足の注記を summary 先頭に連結（warning 2 系統とは別系統の情報注記）。
	const summary = prependProvisionalNote(baseSummary, provisional, { separator: '\n' });

	const data: GetIndicatorsData = {
		summary,
		raw: computed.raw,
		normalized,
		indicators,
		trend,
		chart: chartData,
	} satisfies GetIndicatorsData;

	const meta = createMeta(chk.pair, {
		type,
		count: allCloses.length,
		requiredCount: fetchCount,
		warnings: warnings.length > 0 ? warnings : undefined,
		// 上流 fetchWarning は warnings[] と別系統。
		// warnings[] に混ぜると指標不足と取得層不完全性の区別がつかなくなる。
		warning: computed.upstreamWarning,
		// 形成中足フラグ（warning / warnings とは別系統）。handler が content に注記を出す。
		provisional: provisional || undefined,
	});

	const parsedData = GetIndicatorsDataSchema.parse(data);
	const parsedMeta = GetIndicatorsMetaSchema.parse(meta);
	return parseAsResult<GetIndicatorsData, GetIndicatorsMeta>(
		GetIndicatorsOutputSchema,
		ok(summary, parsedData, parsedMeta),
	);
}
