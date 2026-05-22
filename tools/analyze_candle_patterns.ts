/**
 * analyze_candle_patterns - ローソク足パターン検出（1〜3本足）
 *
 * 設計思想:
 * - 目的: 指定ペアの直近5日間のローソク足から短期反転パターンを検出
 * - 対象:
 *   - 1本足: ハンマー、シューティングスター、十字線
 *   - 2本足: 包み線、はらみ線、毛抜き、かぶせ線、切り込み線
 *   - 3本足: 明けの明星、宵の明星、赤三兵、黒三兵
 * - 用途: 初心者向けの自然言語解説 + 過去統計付与
 *
 * 既存ツールとの違い:
 * - detect_patterns: 数週間〜数ヶ月スケールの大型チャートパターン
 * - 本ツール: 1〜3本足の短期反転パターンに特化
 *
 * 🚨 CRITICAL: 配列順序の明示
 * candles配列の順序は常に [最古, ..., 最新] です
 * - index 0: 最古（5日前）
 * - index n-1: 最新（今日、未確定の可能性）
 */

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

// ----- パターンコンテキスト -----
interface PatternContext {
	rangeHigh: number;
	rangeLow: number;
	avgBodySize: number;
}

// ----- 統一パターン定義 -----
interface PatternConfig {
	span: 1 | 2 | 3;
	direction: 'bullish' | 'bearish' | 'neutral';
	jp_name: string;
	detect: (candles: Candle[], context?: PatternContext) => { detected: boolean; strength: number };
}

// ----- ヘルパー関数 -----

/**
 * トレンド判定（直前n本の終値で判定）
 * CRITICAL: candles配列は [最古, ..., 最新] の順序
 */
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

/**
 * ボラティリティレベルの判定
 */
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

// =====================================================================
// パターン検出関数
// =====================================================================

// ----- 1本足パターン (Phase 3) -----

/**
 * ハンマー (hammer) の検出
 * 条件: 長い下ヒゲ、小さい実体（上部）、短い上ヒゲ
 */
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
	// 下ヒゲが実体の2倍以上
	if (lower < body * 2) return { detected: false, strength: 0 };
	// 上ヒゲがレンジの25%以下
	if (upper / range > 0.25) return { detected: false, strength: 0 };
	// 下ヒゲがレンジの60%以上
	if (lower / range < 0.6) return { detected: false, strength: 0 };

	const strength = Math.min((lower / range - 0.4) / 0.6, 1.0);
	return { detected: true, strength };
}

/**
 * シューティングスター (shooting_star) の検出
 * 条件（ハンマーの逆）: 長い上ヒゲ、小さい実体（下部）、短い下ヒゲ
 */
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

/**
 * 十字線 (doji) の検出
 * 条件: 実体がレンジの5%未満（始値≒終値）
 * ヒゲの偏りで亜種を判別:
 *   - 上下均等 → 通常十字線, 下ヒゲ優勢 → トンボ型, 上ヒゲ優勢 → トウバ型
 */
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

// ----- 2本足パターン (Phase 1-2) -----

/** 陽線包み線 (bullish_engulfing): 陰線 → それを完全に包む陽線 */
function detectBullishEngulfing(candles: Candle[]): { detected: boolean; strength: number } {
	const [c1, c2] = candles;
	if (!isBearish(c1) || !isBullish(c2)) return { detected: false, strength: 0 };
	if (!(c2.open <= c1.close && c2.close >= c1.open)) return { detected: false, strength: 0 };

	const body1 = bodySize(c1);
	const body2 = bodySize(c2);
	const strength = Math.min((body1 > 0 ? body2 / body1 : 1) / 2, 1.0);
	return { detected: true, strength };
}

/** 陰線包み線 (bearish_engulfing): 陽線 → それを完全に包む陰線 */
function detectBearishEngulfing(candles: Candle[]): { detected: boolean; strength: number } {
	const [c1, c2] = candles;
	if (!isBullish(c1) || !isBearish(c2)) return { detected: false, strength: 0 };
	if (!(c2.open >= c1.close && c2.close <= c1.open)) return { detected: false, strength: 0 };

	const body1 = bodySize(c1);
	const body2 = bodySize(c2);
	const strength = Math.min((body1 > 0 ? body2 / body1 : 1) / 2, 1.0);
	return { detected: true, strength };
}

/** 陽線はらみ線 (bullish_harami): 大陰線 → 小さいローソク足が内包 */
function detectBullishHarami(candles: Candle[]): { detected: boolean; strength: number } {
	const [c1, c2] = candles;
	if (!isBearish(c1)) return { detected: false, strength: 0 };
	if (!(bodyTop(c2) <= bodyTop(c1) && bodyBottom(c2) >= bodyBottom(c1))) return { detected: false, strength: 0 };

	const body1 = bodySize(c1);
	const body2 = bodySize(c2);
	if (body1 === 0 || body2 >= body1 * 0.7) return { detected: false, strength: 0 };

	return { detected: true, strength: Math.min(1 - body2 / body1, 1.0) };
}

/** 陰線はらみ線 (bearish_harami): 大陽線 → 小さいローソク足が内包 */
function detectBearishHarami(candles: Candle[]): { detected: boolean; strength: number } {
	const [c1, c2] = candles;
	if (!isBullish(c1)) return { detected: false, strength: 0 };
	if (!(bodyTop(c2) <= bodyTop(c1) && bodyBottom(c2) >= bodyBottom(c1))) return { detected: false, strength: 0 };

	const body1 = bodySize(c1);
	const body2 = bodySize(c2);
	if (body1 === 0 || body2 >= body1 * 0.7) return { detected: false, strength: 0 };

	return { detected: true, strength: Math.min(1 - body2 / body1, 1.0) };
}

/** 毛抜き天井 (tweezer_top): 2日連続で高値がほぼ同じ（±0.5%） */
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

/** 毛抜き底 (tweezer_bottom): 2日連続で安値がほぼ同じ（±0.5%） */
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

/** かぶせ線 (dark_cloud_cover) */
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

/** 切り込み線 (piercing_line) */
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

// ----- 3本足パターン (Phase 3) -----

/**
 * 明けの明星 (morning_star)
 * 大陰線→小さい実体→大陽線で1本目の中心値超え
 */
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

/**
 * 宵の明星 (evening_star)
 * 大陽線→小さい実体→大陰線で1本目の中心値割れ
 */
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

	// BTC24h緩和: 2本目の実体上端が1本目の実体上端以上
	if (bodyTop(c2) < bodyTop(c1)) return { detected: false, strength: 0 };

	const decline = midPointC1 - c3.close;
	return { detected: true, strength: Math.min(decline / body1 + 0.3, 1.0) };
}

/**
 * 赤三兵 (three_white_soldiers)
 * 3本連続陽線、各終値が前を上回る、始値は前の実体内
 */
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

	// 各始値が前の実体内またはその近辺
	const tol2 = body1 * 0.5;
	const tol3 = body2 * 0.5;
	if (c2.open < bodyBottom(c1) - tol2 || c2.open > bodyTop(c1) + tol2) return { detected: false, strength: 0 };
	if (c3.open < bodyBottom(c2) - tol3 || c3.open > bodyTop(c2) + tol3) return { detected: false, strength: 0 };

	// 上ヒゲが短い
	for (const c of [c1, c2, c3]) {
		const r = totalRange(c);
		if (r > 0 && upperShadow(c) / r > 0.4) return { detected: false, strength: 0 };
	}

	const maxBody = Math.max(body1, body2, body3);
	const minBody = Math.min(body1, body2, body3);
	return { detected: true, strength: Math.min(minBody / maxBody + 0.2, 1.0) };
}

/**
 * 黒三兵 (three_black_crows)
 * 3本連続陰線、各終値が前を下回る
 */
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

	// 下ヒゲが短い
	for (const c of [c1, c2, c3]) {
		const r = totalRange(c);
		if (r > 0 && lowerShadow(c) / r > 0.4) return { detected: false, strength: 0 };
	}

	const maxBody = Math.max(body1, body2, body3);
	const minBody = Math.min(body1, body2, body3);
	return { detected: true, strength: Math.min(minBody / maxBody + 0.2, 1.0) };
}

// =====================================================================
// パターン定義レジストリ
// =====================================================================

const PATTERN_CONFIGS: Record<CandlePatternType, PatternConfig> = {
	// 1本足
	hammer: { span: 1, direction: 'bullish', jp_name: 'ハンマー（カラカサ）', detect: detectHammer },
	shooting_star: {
		span: 1,
		direction: 'bearish',
		jp_name: 'シューティングスター（流れ星）',
		detect: detectShootingStar,
	},
	doji: { span: 1, direction: 'neutral', jp_name: '十字線（Doji）', detect: detectDoji },
	// 2本足
	bullish_engulfing: { span: 2, direction: 'bullish', jp_name: '陽線包み線', detect: detectBullishEngulfing },
	bearish_engulfing: { span: 2, direction: 'bearish', jp_name: '陰線包み線', detect: detectBearishEngulfing },
	bullish_harami: { span: 2, direction: 'bullish', jp_name: '陽線はらみ線', detect: detectBullishHarami },
	bearish_harami: { span: 2, direction: 'bearish', jp_name: '陰線はらみ線', detect: detectBearishHarami },
	tweezer_top: { span: 2, direction: 'bearish', jp_name: '毛抜き天井', detect: detectTweezerTop },
	tweezer_bottom: { span: 2, direction: 'bullish', jp_name: '毛抜き底', detect: detectTweezerBottom },
	dark_cloud_cover: { span: 2, direction: 'bearish', jp_name: 'かぶせ線', detect: detectDarkCloudCover },
	piercing_line: { span: 2, direction: 'bullish', jp_name: '切り込み線', detect: detectPiercingLine },
	// 3本足
	morning_star: { span: 3, direction: 'bullish', jp_name: '明けの明星', detect: detectMorningStar },
	evening_star: { span: 3, direction: 'bearish', jp_name: '宵の明星', detect: detectEveningStar },
	three_white_soldiers: { span: 3, direction: 'bullish', jp_name: '赤三兵', detect: detectThreeWhiteSoldiers },
	three_black_crows: { span: 3, direction: 'bearish', jp_name: '黒三兵', detect: detectThreeBlackCrows },
};

// ----- 過去統計計算 -----
interface PatternOccurrence {
	index: number;
	pattern: CandlePatternType;
	basePrice: number;
}

/**
 * 過去のパターン出現を検索（span 対応）
 */
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

/**
 * 過去統計を計算
 */
function calculateHistoryStats(
	candles: Candle[],
	pattern: CandlePatternType,
	horizons: number[],
	lookbackDays: number,
): HistoryStats | null {
	// lookbackDays分のデータがあるか確認
	if (candles.length < lookbackDays) {
		return null;
	}

	// lookbackDays期間内のパターンを検索
	const startIndex = candles.length - lookbackDays;
	const relevantCandles = candles.slice(startIndex);

	const occurrences = findHistoricalPatterns(relevantCandles, pattern, 5);

	if (occurrences.length < 5) {
		// サンプル数が少なすぎる場合はnull
		return null;
	}

	const horizonStats: Record<string, HistoryHorizonStats> = {};

	for (const h of horizons) {
		const returns: number[] = [];

		for (const occ of occurrences) {
			// グローバルインデックスに変換
			const globalIndex = startIndex + occ.index;

			// h本後のデータが存在するか確認
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

// ----- ヘルパー: 日付形式の正規化 -----
/**
 * ISO形式 ("2025-11-05") または YYYYMMDD ("20251105") を YYYYMMDD に正規化
 */
function normalizeDateToYYYYMMDD(dateStr: string | undefined): string | undefined {
	if (!dateStr) return undefined;

	// ISO形式 ("2025-11-05" or "2025-11-05T...") の場合
	if (dateStr.includes('-')) {
		const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
		if (match) {
			return `${match[1]}${match[2]}${match[3]}`;
		}
	}

	// 既にYYYYMMDD形式の場合
	if (/^\d{8}$/.test(dateStr)) {
		return dateStr;
	}

	return undefined;
}

// ----- メイン関数 -----
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
		// 入力の正規化
		const input = AnalyzeCandlePatternsInputSchema.parse(opts);
		const chk = ensurePair(input.pair);
		if (!chk.ok) return failFromValidation(chk);
		const pair = chk.pair;
		const timeframe = input.timeframe;

		// as_of を優先、なければ date を使用（互換性のため）
		// as_of: ISO形式 "2025-11-05" または YYYYMMDD "20251105" を受け付け
		const rawDate = input.as_of || input.date;
		const targetDate = normalizeDateToYYYYMMDD(rawDate);
		const windowDays = input.window_days;
		const focusLastN = input.focus_last_n;
		const targetPatterns = input.patterns || (Object.keys(PATTERN_CONFIGS) as CandlePatternType[]);
		const historyLookbackDays = input.history_lookback_days;
		const historyHorizons = input.history_horizons;
		const allowPartial = input.allow_partial_patterns;

		// 日付指定があるかどうか
		const isHistoricalQuery = !!targetDate;

		// ローソク足データを取得（統計計算用に多めに取得）
		const requiredCandles = Math.max(windowDays, historyLookbackDays + 10);
		const candlesResult = await getCandles(pair, '1day', targetDate, requiredCandles);

		if (!candlesResult.ok) {
			return AnalyzeCandlePatternsOutputSchema.parse(fail(candlesResult.summary, 'internal'));
		}

		// 上流 get_candles の取得層 warning を取り込む（partial fetch / multi-day 失敗等）。
		// server.ts の respond() は content を summary より優先するため、summary だけでなく
		// content[0].text の先頭にも warning を出す必要がある。
		const upstream = extractUpstreamWarning(candlesResult.meta);

		// 全データを保持（統計計算用）
		const allCandlesForStats = candlesResult.data.normalized;
		let allCandles = [...allCandlesForStats];

		// 🚨 CRITICAL: 日付指定時は、その日付以前のデータのみにフィルタリング
		// get_candles は年単位でデータを取得するため、指定日以降のデータも含まれる
		if (isHistoricalQuery && targetDate) {
			// targetDate は YYYYMMDD 形式（例: "20251105"）
			const year = targetDate.slice(0, 4);
			const month = targetDate.slice(4, 6);
			const day = targetDate.slice(6, 8);
			const targetDateMs = dayjs.utc(`${year}-${month}-${day}`).endOf('day').valueOf();

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

		// 直近windowDays分を切り出し
		// CRITICAL: allCandlesは [最古, ..., 最新] の順序
		const windowStart = allCandles.length - windowDays;
		const windowCandles = allCandles.slice(windowStart);

		// 日足確定判定:
		// - 過去日付指定時: すべて確定済み（is_partial = false）
		// - 最新データ時: 最新の日足が今日のデータなら未確定
		const displayTz = 'Asia/Tokyo';
		const todayStr = dayjs().tz(displayTz).format('YYYY-MM-DD');
		const lastCandle = windowCandles[windowCandles.length - 1];
		const lastCandleDate = calendarDateFromIso(lastCandle?.isoTime ?? lastCandle?.time) ?? '';
		const isLastPartial = !isHistoricalQuery && lastCandleDate === todayStr;

		// WindowCandle形式に変換
		const formattedWindowCandles: WindowCandle[] = windowCandles.map((c, idx) => ({
			timestamp: c.isoTime || toIsoTime(c.time || 0) || '',
			open: c.open,
			high: c.high,
			low: c.low,
			close: c.close,
			volume: c.volume || 0,
			is_partial: idx === windowCandles.length - 1 && isLastPartial,
		}));

		// パターン検出
		// CRITICAL: windowCandles配列は [最古, ..., 最新] の順序
		const detectedPatterns: DetectedCandlePattern[] = [];
		// startCheckIndex: 1本足はindex 0から、spanチェックでガード
		const startCheckIndex = Math.max(0, windowCandles.length - focusLastN);

		// パターンコンテキストを計算
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

				// spanに必要な本数があるかチェック
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

		// サマリーとコンテント生成（フィルタ後のパターンを使用）
		const baseSummary = generateSummary(filteredPatterns, formattedWindowCandles);
		const baseContent = generateContent(filteredPatterns, formattedWindowCandles);
		// 上流 get_candles の warning を summary と content[0].text の両方の先頭に連結する。
		// content は server.ts が summary より優先するため、summary だけだと LLM に届かない。
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

// ── MCP ツール定義（tool-registry から自動収集） ──
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
