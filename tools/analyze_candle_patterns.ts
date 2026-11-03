// candles 配列は常に [最古, ..., 最新] で、最新は未確定の可能性がある。

import { parseDayKeyAllowingOverflow } from '../lib/calendar.js';
import {
	bodyBottom,
	bodySize,
	bodyTop,
	isBearish,
	isBullish,
	lowerShadow,
	totalRange,
	upperShadow,
} from '../lib/candle-utils.js';
import { calendarDateFromIso, dayjs, nowIso, toIsoTime } from '../lib/datetime.js';
import { fail, failFromError, failFromValidation } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { extractUpstreamWarning, prependWarnings } from '../lib/warning-propagation.js';
import type {
	CandlePatternType,
	DetectedCandlePattern,
	HistoryHorizonStats,
	HistoryStats,
	WindowCandle,
} from '../src/handlers/analyzeCandlePatternsHandler.js';
import { generateContent, generateSummary } from '../src/handlers/analyzeCandlePatternsHandler.js';
import type { Candle } from '../src/schemas.js';
import { AnalyzeCandlePatternsInputSchema, AnalyzeCandlePatternsOutputSchema } from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import getCandles from './get_candles.js';

interface PatternContext {
	rangeHigh: number;
	rangeLow: number;
	avgBodySize: number;
}

interface PatternConfig {
	span: 1 | 2 | 3;
	direction: 'bullish' | 'bearish' | 'neutral';
	jp_name: string;
	detect: (candles: Candle[], context?: PatternContext) => { detected: boolean; strength: number };
}

function detectTrendBefore(candles: Candle[], endIndex: number, lookbackCount: number = 3): 'up' | 'down' | 'neutral' {
	if (endIndex < lookbackCount - 1) return 'neutral';

	let upCount = 0;
	let downCount = 0;

	for (let i = endIndex - lookbackCount + 1; i <= endIndex; i++) {
		if (i > 0 && candles[i].close > candles[i - 1].close) {
			upCount++;
		} else if (i > 0 && candles[i].close < candles[i - 1].close) {
			downCount++;
		}
	}

	const threshold = Math.ceil(lookbackCount * 0.6);
	if (upCount >= threshold) return 'up';
	if (downCount >= threshold) return 'down';
	return 'neutral';
}

function detectVolatilityLevel(
	candles: Candle[],
	endIndex: number,
	lookbackCount: number = 5,
): 'low' | 'medium' | 'high' {
	if (endIndex < lookbackCount) return 'medium';

	const recentCandles = candles.slice(Math.max(0, endIndex - lookbackCount + 1), endIndex + 1);
	const avgPrice = recentCandles.reduce((sum, c) => sum + c.close, 0) / recentCandles.length;
	const avgRange = recentCandles.reduce((sum, c) => sum + (c.high - c.low), 0) / recentCandles.length;
	const rangePct = (avgRange / avgPrice) * 100;

	if (rangePct < 1.5) return 'low';
	if (rangePct > 3.0) return 'high';
	return 'medium';
}

function detectHammer(candles: Candle[], _context?: PatternContext): { detected: boolean; strength: number } {
	const c = candles[0];
	const range = totalRange(c);
	if (range === 0) return { detected: false, strength: 0 };

	const body = bodySize(c);
	const lower = lowerShadow(c);
	const upper = upperShadow(c);
	const bodyRatio = body / range;

	// 実体はレンジの5%〜35%（dojiと区別 & 大きすぎない）
	if (bodyRatio < 0.05 || bodyRatio > 0.35) return { detected: false, strength: 0 };
	if (lower < body * 2) return { detected: false, strength: 0 };
	if (upper / range > 0.25) return { detected: false, strength: 0 };
	if (lower / range < 0.6) return { detected: false, strength: 0 };

	const strength = Math.min((lower / range - 0.4) / 0.6, 1.0);
	return { detected: true, strength };
}

function detectShootingStar(candles: Candle[], _context?: PatternContext): { detected: boolean; strength: number } {
	const c = candles[0];
	const range = totalRange(c);
	if (range === 0) return { detected: false, strength: 0 };

	const body = bodySize(c);
	const lower = lowerShadow(c);
	const upper = upperShadow(c);
	const bodyRatio = body / range;

	if (bodyRatio < 0.05 || bodyRatio > 0.35) return { detected: false, strength: 0 };
	if (upper < body * 2) return { detected: false, strength: 0 };
	if (lower / range > 0.25) return { detected: false, strength: 0 };
	if (upper / range < 0.6) return { detected: false, strength: 0 };

	const strength = Math.min((upper / range - 0.4) / 0.6, 1.0);
	return { detected: true, strength };
}

function detectDoji(candles: Candle[], _context?: PatternContext): { detected: boolean; strength: number } {
	const c = candles[0];
	const range = totalRange(c);
	if (range === 0) return { detected: false, strength: 0 };

	const body = bodySize(c);
	if (body / range >= 0.05) return { detected: false, strength: 0 };

	const upper = upperShadow(c);
	const lower = lowerShadow(c);
	const shadowImbalance = Math.abs(upper - lower) / range;
	const strength = Math.min(0.5 + shadowImbalance * 0.5, 1.0);

	return { detected: true, strength };
}

function detectBullishEngulfing(candles: Candle[]): { detected: boolean; strength: number } {
	const [c1, c2] = candles;
	if (!isBearish(c1) || !isBullish(c2)) return { detected: false, strength: 0 };
	if (!(c2.open <= c1.close && c2.close >= c1.open)) return { detected: false, strength: 0 };

	const body1 = bodySize(c1);
	const body2 = bodySize(c2);
	const strength = Math.min((body1 > 0 ? body2 / body1 : 1) / 2, 1.0);
	return { detected: true, strength };
}

function detectBearishEngulfing(candles: Candle[]): { detected: boolean; strength: number } {
	const [c1, c2] = candles;
	if (!isBullish(c1) || !isBearish(c2)) return { detected: false, strength: 0 };
	if (!(c2.open >= c1.close && c2.close <= c1.open)) return { detected: false, strength: 0 };

	const body1 = bodySize(c1);
	const body2 = bodySize(c2);
	const strength = Math.min((body1 > 0 ? body2 / body1 : 1) / 2, 1.0);
	return { detected: true, strength };
}

function detectBullishHarami(candles: Candle[]): { detected: boolean; strength: number } {
	const [c1, c2] = candles;
	if (!isBearish(c1)) return { detected: false, strength: 0 };
	if (!(bodyTop(c2) <= bodyTop(c1) && bodyBottom(c2) >= bodyBottom(c1))) return { detected: false, strength: 0 };

	const body1 = bodySize(c1);
	const body2 = bodySize(c2);
	if (body1 === 0 || body2 >= body1 * 0.7) return { detected: false, strength: 0 };

	return { detected: true, strength: Math.min(1 - body2 / body1, 1.0) };
}

function detectBearishHarami(candles: Candle[]): { detected: boolean; strength: number } {
	const [c1, c2] = candles;
	if (!isBullish(c1)) return { detected: false, strength: 0 };
	if (!(bodyTop(c2) <= bodyTop(c1) && bodyBottom(c2) >= bodyBottom(c1))) return { detected: false, strength: 0 };

	const body1 = bodySize(c1);
	const body2 = bodySize(c2);
	if (body1 === 0 || body2 >= body1 * 0.7) return { detected: false, strength: 0 };

	return { detected: true, strength: Math.min(1 - body2 / body1, 1.0) };
}

function detectTweezerTop(candles: Candle[], context?: PatternContext): { detected: boolean; strength: number } {
	const [c1, c2] = candles;
	const avgHigh = (c1.high + c2.high) / 2;
	const highDiff = Math.abs(c1.high - c2.high);
	if (highDiff > avgHigh * 0.005) return { detected: false, strength: 0 };

	if (context) {
		const range = context.rangeHigh - context.rangeLow;
		const threshold = context.rangeHigh - range * 0.2;
		if (c1.high < threshold && c2.high < threshold) return { detected: false, strength: 0 };
	}

	const strength = Math.max(0, Math.min(1 - (highDiff / avgHigh) * 100, 1.0));
	return { detected: true, strength };
}

function detectTweezerBottom(candles: Candle[], context?: PatternContext): { detected: boolean; strength: number } {
	const [c1, c2] = candles;
	const avgLow = (c1.low + c2.low) / 2;
	const lowDiff = Math.abs(c1.low - c2.low);
	if (lowDiff > avgLow * 0.005) return { detected: false, strength: 0 };

	if (context) {
		const range = context.rangeHigh - context.rangeLow;
		const threshold = context.rangeLow + range * 0.2;
		if (c1.low > threshold && c2.low > threshold) return { detected: false, strength: 0 };
	}

	const strength = Math.max(0, Math.min(1 - (lowDiff / avgLow) * 100, 1.0));
	return { detected: true, strength };
}

function detectDarkCloudCover(candles: Candle[], context?: PatternContext): { detected: boolean; strength: number } {
	const [c1, c2] = candles;
	if (!isBullish(c1) || !isBearish(c2)) return { detected: false, strength: 0 };

	const body1 = bodySize(c1);
	const avgBody = context?.avgBodySize || body1;
	if (body1 < avgBody * 1.5) return { detected: false, strength: 0 };

	const gapTol = body1 * 0.1;
	if (c2.open < c1.close - gapTol) return { detected: false, strength: 0 };

	const midPoint = (c1.open + c1.close) / 2;
	if (c2.close >= midPoint) return { detected: false, strength: 0 };
	if (c2.close <= c1.open) return { detected: false, strength: 0 };

	return { detected: true, strength: Math.min((midPoint - c2.close) / body1, 1.0) };
}

function detectPiercingLine(candles: Candle[], context?: PatternContext): { detected: boolean; strength: number } {
	const [c1, c2] = candles;
	if (!isBearish(c1) || !isBullish(c2)) return { detected: false, strength: 0 };

	const body1 = bodySize(c1);
	const avgBody = context?.avgBodySize || body1;
	if (body1 < avgBody * 1.5) return { detected: false, strength: 0 };

	const gapTol = body1 * 0.1;
	if (c2.open > c1.close + gapTol) return { detected: false, strength: 0 };

	const midPoint = (c1.open + c1.close) / 2;
	if (c2.close <= midPoint) return { detected: false, strength: 0 };
	if (c2.close >= c1.open) return { detected: false, strength: 0 };

	return { detected: true, strength: Math.min((c2.close - midPoint) / body1, 1.0) };
}

function detectMorningStar(candles: Candle[], context?: PatternContext): { detected: boolean; strength: number } {
	const [c1, c2, c3] = candles;
	if (!isBearish(c1) || !isBullish(c3)) return { detected: false, strength: 0 };

	const body1 = bodySize(c1);
	const body2 = bodySize(c2);
	const body3 = bodySize(c3);
	const avgBody = context?.avgBodySize || body1;

	if (body1 < avgBody * 0.8) return { detected: false, strength: 0 };
	if (body2 > body1 * 0.4) return { detected: false, strength: 0 };
	if (body3 < avgBody * 0.8) return { detected: false, strength: 0 };

	const midPointC1 = (c1.open + c1.close) / 2;
	if (c3.close < midPointC1) return { detected: false, strength: 0 };

	// BTC24h緩和: 2本目の実体下端が1本目の実体下端以下
	if (bodyBottom(c2) > bodyBottom(c1)) return { detected: false, strength: 0 };

	const recovery = c3.close - midPointC1;
	return { detected: true, strength: Math.min(recovery / body1 + 0.3, 1.0) };
}

function detectEveningStar(candles: Candle[], context?: PatternContext): { detected: boolean; strength: number } {
	const [c1, c2, c3] = candles;
	if (!isBullish(c1) || !isBearish(c3)) return { detected: false, strength: 0 };

	const body1 = bodySize(c1);
	const body2 = bodySize(c2);
	const body3 = bodySize(c3);
	const avgBody = context?.avgBodySize || body1;

	if (body1 < avgBody * 0.8) return { detected: false, strength: 0 };
	if (body2 > body1 * 0.4) return { detected: false, strength: 0 };
	if (body3 < avgBody * 0.8) return { detected: false, strength: 0 };

	const midPointC1 = (c1.open + c1.close) / 2;
	if (c3.close > midPointC1) return { detected: false, strength: 0 };

	if (bodyTop(c2) < bodyTop(c1)) return { detected: false, strength: 0 };

	const decline = midPointC1 - c3.close;
	return { detected: true, strength: Math.min(decline / body1 + 0.3, 1.0) };
}

function detectThreeWhiteSoldiers(
	candles: Candle[],
	context?: PatternContext,
): { detected: boolean; strength: number } {
	const [c1, c2, c3] = candles;
	if (!isBullish(c1) || !isBullish(c2) || !isBullish(c3)) return { detected: false, strength: 0 };
	if (c2.close <= c1.close || c3.close <= c2.close) return { detected: false, strength: 0 };

	const body1 = bodySize(c1);
	const body2 = bodySize(c2);
	const body3 = bodySize(c3);
	const avgBody = context?.avgBodySize || (body1 + body2 + body3) / 3;

	if (body1 < avgBody * 0.5 || body2 < avgBody * 0.5 || body3 < avgBody * 0.5) return { detected: false, strength: 0 };

	const tol2 = body1 * 0.5;
	const tol3 = body2 * 0.5;
	if (c2.open < bodyBottom(c1) - tol2 || c2.open > bodyTop(c1) + tol2) return { detected: false, strength: 0 };
	if (c3.open < bodyBottom(c2) - tol3 || c3.open > bodyTop(c2) + tol3) return { detected: false, strength: 0 };

	for (const c of [c1, c2, c3]) {
		const r = totalRange(c);
		if (r > 0 && upperShadow(c) / r > 0.4) return { detected: false, strength: 0 };
	}

	const maxBody = Math.max(body1, body2, body3);
	const minBody = Math.min(body1, body2, body3);
	return { detected: true, strength: Math.min(minBody / maxBody + 0.2, 1.0) };
}

function detectThreeBlackCrows(candles: Candle[], context?: PatternContext): { detected: boolean; strength: number } {
	const [c1, c2, c3] = candles;
	if (!isBearish(c1) || !isBearish(c2) || !isBearish(c3)) return { detected: false, strength: 0 };
	if (c2.close >= c1.close || c3.close >= c2.close) return { detected: false, strength: 0 };

	const body1 = bodySize(c1);
	const body2 = bodySize(c2);
	const body3 = bodySize(c3);
	const avgBody = context?.avgBodySize || (body1 + body2 + body3) / 3;

	if (body1 < avgBody * 0.5 || body2 < avgBody * 0.5 || body3 < avgBody * 0.5) return { detected: false, strength: 0 };

	const tol2 = body1 * 0.5;
	const tol3 = body2 * 0.5;
	if (c2.open < bodyBottom(c1) - tol2 || c2.open > bodyTop(c1) + tol2) return { detected: false, strength: 0 };
	if (c3.open < bodyBottom(c2) - tol3 || c3.open > bodyTop(c2) + tol3) return { detected: false, strength: 0 };

	for (const c of [c1, c2, c3]) {
		const r = totalRange(c);
		if (r > 0 && lowerShadow(c) / r > 0.4) return { detected: false, strength: 0 };
	}

	const maxBody = Math.max(body1, body2, body3);
	const minBody = Math.min(body1, body2, body3);
	return { detected: true, strength: Math.min(minBody / maxBody + 0.2, 1.0) };
}

const PATTERN_CONFIGS: Record<CandlePatternType, PatternConfig> = {
	hammer: { span: 1, direction: 'bullish', jp_name: 'ハンマー（カラカサ）', detect: detectHammer },
	shooting_star: {
		span: 1,
		direction: 'bearish',
		jp_name: 'シューティングスター（流れ星）',
		detect: detectShootingStar,
	},
	doji: { span: 1, direction: 'neutral', jp_name: '十字線（Doji）', detect: detectDoji },
	bullish_engulfing: { span: 2, direction: 'bullish', jp_name: '陽線包み線', detect: detectBullishEngulfing },
	bearish_engulfing: { span: 2, direction: 'bearish', jp_name: '陰線包み線', detect: detectBearishEngulfing },
	bullish_harami: { span: 2, direction: 'bullish', jp_name: '陽線はらみ線', detect: detectBullishHarami },
	bearish_harami: { span: 2, direction: 'bearish', jp_name: '陰線はらみ線', detect: detectBearishHarami },
	tweezer_top: { span: 2, direction: 'bearish', jp_name: '毛抜き天井', detect: detectTweezerTop },
	tweezer_bottom: { span: 2, direction: 'bullish', jp_name: '毛抜き底', detect: detectTweezerBottom },
	dark_cloud_cover: { span: 2, direction: 'bearish', jp_name: 'かぶせ線', detect: detectDarkCloudCover },
	piercing_line: { span: 2, direction: 'bullish', jp_name: '切り込み線', detect: detectPiercingLine },
	morning_star: { span: 3, direction: 'bullish', jp_name: '明けの明星', detect: detectMorningStar },
	evening_star: { span: 3, direction: 'bearish', jp_name: '宵の明星', detect: detectEveningStar },
	three_white_soldiers: { span: 3, direction: 'bullish', jp_name: '赤三兵', detect: detectThreeWhiteSoldiers },
	three_black_crows: { span: 3, direction: 'bearish', jp_name: '黒三兵', detect: detectThreeBlackCrows },
};

interface PatternOccurrence {
	index: number;
	pattern: CandlePatternType;
	basePrice: number;
}

function findHistoricalPatterns(
	candles: Candle[],
	pattern: CandlePatternType,
	excludeLastN: number = 1,
): PatternOccurrence[] {
	const config = PATTERN_CONFIGS[pattern];
	const occurrences: PatternOccurrence[] = [];

	const endIndex = candles.length - 1 - excludeLastN;

	for (let i = config.span - 1; i <= endIndex; i++) {
		const slice = candles.slice(i - config.span + 1, i + 1);
		const result = config.detect(slice);
		if (result.detected) {
			occurrences.push({
				index: i,
				pattern,
				basePrice: candles[i].close,
			});
		}
	}

	return occurrences;
}

function calculateHistoryStats(
	candles: Candle[],
	pattern: CandlePatternType,
	horizons: number[],
	lookbackDays: number,
): HistoryStats | null {
	if (candles.length < lookbackDays) {
		return null;
	}

	const startIndex = candles.length - lookbackDays;
	const relevantCandles = candles.slice(startIndex);

	const occurrences = findHistoricalPatterns(relevantCandles, pattern, 5);

	if (occurrences.length < 5) {
		return null;
	}

	const horizonStats: Record<string, HistoryHorizonStats> = {};

	for (const h of horizons) {
		const returns: number[] = [];

		for (const occ of occurrences) {
			const globalIndex = startIndex + occ.index;

			if (globalIndex + h < candles.length) {
				const futureCandle = candles[globalIndex + h];
				const returnPct = ((futureCandle.close - occ.basePrice) / occ.basePrice) * 100;
				returns.push(returnPct);
			}
		}

		if (returns.length > 0) {
			const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
			const winCount = returns.filter((r) => r > 0).length;
			const winRate = winCount / returns.length;

			horizonStats[String(h)] = {
				avg_return: Number(avgReturn.toFixed(2)),
				win_rate: Number(winRate.toFixed(2)),
				sample: returns.length,
			};
		}
	}

	return {
		lookback_days: lookbackDays,
		occurrences: occurrences.length,
		horizons: horizonStats,
	};
}

// get_candles に渡す tz と同じ暦日で絞る。日足の timestamp は UTC 00:00 なので、UTC の暦日で絞っても残る足は同じ。
const AS_OF_TZ = 'Asia/Tokyo';

function normalizeDateToYYYYMMDD(dateStr: string | undefined): string | undefined {
	if (!dateStr) return undefined;

	if (dateStr.includes('-')) {
		const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
		if (match) {
			return `${match[1]}${match[2]}${match[3]}`;
		}
	}

	if (/^\d{8}$/.test(dateStr)) {
		return dateStr;
	}

	return undefined;
}

export default async function analyzeCandlePatterns(
	opts: {
		pair?: string;
		timeframe?: '1day';
		as_of?: string; // ISO "2025-11-05" or YYYYMMDD "20251105"
		date?: string; // DEPRECATED: YYYYMMDD format (for backward compatibility)
		window_days?: number;
		focus_last_n?: number;
		patterns?: CandlePatternType[];
		history_lookback_days?: number;
		history_horizons?: number[];
		allow_partial_patterns?: boolean;
	} = {},
) {
	try {
		const input = AnalyzeCandlePatternsInputSchema.parse(opts);
		const chk = ensurePair(input.pair);
		if (!chk.ok) return failFromValidation(chk);
		const pair = chk.pair;
		const timeframe = input.timeframe;

		// as_of を優先、なければ date を使用（互換性のため）
		const rawDate = input.as_of || input.date;
		const targetDate = normalizeDateToYYYYMMDD(rawDate);
		const windowDays = input.window_days;
		const focusLastN = input.focus_last_n;
		const targetPatterns = input.patterns || (Object.keys(PATTERN_CONFIGS) as CandlePatternType[]);
		const historyLookbackDays = input.history_lookback_days;
		const historyHorizons = input.history_horizons;
		const allowPartial = input.allow_partial_patterns;

		const isHistoricalQuery = !!targetDate;

		const requiredCandles = Math.max(windowDays, historyLookbackDays + 10);
		const candlesResult = await getCandles(pair, '1day', targetDate, requiredCandles, AS_OF_TZ);

		if (!candlesResult.ok) {
			return AnalyzeCandlePatternsOutputSchema.parse(fail(candlesResult.summary, 'internal'));
		}

		// server.ts の respond() は content を summary より優先するので、content[0].text の先頭にも warning を出す。
		const upstream = extractUpstreamWarning(candlesResult.meta);

		const allCandlesForStats = candlesResult.data.normalized;
		let allCandles = [...allCandlesForStats];

		// get_candles は年単位で取得するので指定日以降の足も含まれる。その日付以前だけに絞る。
		if (isHistoricalQuery && targetDate) {
			// 形式しか見ないので実在しない日付が届きうる。従来どおり繰り上げ許容で読み、解釈できない値は NaN のまま「データ不足 fail」に落とす。
			const targetDateMs = parseDayKeyAllowingOverflow(targetDate, AS_OF_TZ)?.endMs ?? Number.NaN;

			allCandles = allCandles.filter((c) => {
				if (!c.isoTime) return false;
				return dayjs(c.isoTime).valueOf() <= targetDateMs;
			});
		}

		if (allCandles.length < windowDays) {
			return AnalyzeCandlePatternsOutputSchema.parse(
				fail(`ローソク足データが不足しています（${allCandles.length}本 < ${windowDays}本）`, 'user'),
			);
		}

		const windowStart = allCandles.length - windowDays;
		const windowCandles = allCandles.slice(windowStart);

		const lastCandle = windowCandles[windowCandles.length - 1];
		const lastOpen = lastCandle?.isoTime ?? lastCandle?.time;
		// 日足は UTC 00:00 始まりなので、JST の暦日で今日と比べると 0〜9 時に進行中の足を確定扱いにしてしまう。
		const isLastPartial = !isHistoricalQuery && lastOpen != null && dayjs().isBefore(dayjs(lastOpen).add(24, 'hour'));

		const formattedWindowCandles: WindowCandle[] = windowCandles.map((c, idx) => ({
			timestamp: c.isoTime || toIsoTime(c.time || 0) || '',
			open: c.open,
			high: c.high,
			low: c.low,
			close: c.close,
			volume: c.volume || 0,
			is_partial: idx === windowCandles.length - 1 && isLastPartial,
		}));

		const detectedPatterns: DetectedCandlePattern[] = [];
		const startCheckIndex = Math.max(0, windowCandles.length - focusLastN);

		const highs = windowCandles.map((c) => c.high);
		const lows = windowCandles.map((c) => c.low);
		const bodies = windowCandles.map((c) => Math.abs(c.close - c.open));
		const patternContext: PatternContext = {
			rangeHigh: Math.max(...highs),
			rangeLow: Math.min(...lows),
			avgBodySize: bodies.reduce((sum, b) => sum + b, 0) / bodies.length,
		};

		for (let i = startCheckIndex; i < windowCandles.length; i++) {
			const usesPartial = i === windowCandles.length - 1 && isLastPartial;

			if (usesPartial && !allowPartial) {
				continue;
			}

			for (const patternType of targetPatterns) {
				const config = PATTERN_CONFIGS[patternType];

				if (i < config.span - 1) continue;

				const slice = windowCandles.slice(i - config.span + 1, i + 1);
				const result = config.detect(slice, patternContext);

				if (result.detected) {
					// トレンドはパターン開始位置より前で判定
					const patternStartIdx = i - config.span + 1;
					const trendBefore = detectTrendBefore(windowCandles, patternStartIdx > 0 ? patternStartIdx - 1 : 0, 3);
					const volatilityLevel = detectVolatilityLevel(windowCandles, i, 5);

					// doji は直前トレンドで方向を動的決定
					let direction = config.direction;
					if (direction === 'neutral' && patternType === 'doji') {
						if (trendBefore === 'up') direction = 'bearish';
						else if (trendBefore === 'down') direction = 'bullish';
					}

					const historyStats = calculateHistoryStats(allCandles, patternType, historyHorizons, historyLookbackDays);

					detectedPatterns.push({
						pattern: patternType,
						pattern_jp: config.jp_name,
						direction,
						strength: Number(result.strength.toFixed(2)),
						candle_range_index: [i - config.span + 1, i] as [number, number],
						uses_partial_candle: usesPartial,
						status: usesPartial ? 'forming' : 'confirmed',
						local_context: {
							trend_before: trendBefore,
							volatility_level: volatilityLevel,
						},
						history_stats: historyStats,
					});
				}
			}
		}

		// 強度フィルタ: 50%未満のパターンを除外（初心者向けにノイズを減らす）
		const MIN_STRENGTH_THRESHOLD = 0.5; // 50%
		const filteredPatterns = detectedPatterns.filter((p) => p.strength >= MIN_STRENGTH_THRESHOLD);

		const baseSummary = generateSummary(filteredPatterns, formattedWindowCandles);
		const baseContent = generateContent(filteredPatterns, formattedWindowCandles);
		const summary = prependWarnings(baseSummary, upstream, { separator: '\n' });
		const content =
			baseContent.length > 0
				? [
						{
							type: 'text' as const,
							text: prependWarnings(baseContent[0].text, upstream, { separator: '\n' }),
						},
						...baseContent.slice(1),
					]
				: baseContent;

		const data = {
			pair,
			timeframe,
			snapshot_time: nowIso(),
			window: {
				from: calendarDateFromIso(formattedWindowCandles[0]?.timestamp) ?? '',
				to: calendarDateFromIso(formattedWindowCandles[formattedWindowCandles.length - 1]?.timestamp) ?? '',
				candles: formattedWindowCandles,
			},
			recent_patterns: filteredPatterns, // 強度50%以上のパターンのみ
			summary,
		};

		const meta = {
			...createMeta(pair, {}),
			timeframe,
			as_of: rawDate || null, // original input value
			date: targetDate || null, // YYYYMMDD normalized or null (latest)
			window_days: windowDays,
			patterns_checked: targetPatterns,
			history_lookback_days: historyLookbackDays,
			history_horizons: historyHorizons,
			...(upstream.warning ? { warning: upstream.warning } : {}),
		};

		const result = {
			ok: true as const,
			summary,
			content,
			data,
			meta,
		};

		return AnalyzeCandlePatternsOutputSchema.parse(result);
	} catch (e: unknown) {
		return failFromError(e, {
			schema: AnalyzeCandlePatternsOutputSchema,
			defaultMessage: 'ローソク足パターン分析中にエラーが発生しました',
		});
	}
}

export const toolDef: ToolDefinition = {
	name: 'analyze_candle_patterns',
	description:
		'[Candlestick Patterns / Doji / Engulfing] ローソク足パターン検出（candle patterns / doji / engulfing / hammer / harami）。1〜3本足パターンを検出し文脈と過去統計を付けて解説。',
	inputSchema: AnalyzeCandlePatternsInputSchema,
	handler: async (args: {
		pair?: string;
		timeframe?: '1day';
		as_of?: string;
		date?: string;
		window_days?: number;
		focus_last_n?: number;
		patterns?: CandlePatternType[];
		history_lookback_days?: number;
		history_horizons?: number[];
		allow_partial_patterns?: boolean;
	}) => analyzeCandlePatterns(args),
};
