/**
 * Wedge 検出（Rising / Falling — 完成済み＋形成中）
 *
 * v2: UAlgo + TradingPatternScanner ベースの改善
 * - Savitzky-Golay フィルタによるノイズ除去（ピボット品質向上）
 * - Apex（頂点）計算による収束バリデーション（UAlgo 方式）
 * - 包含ルール（Containment）による偽パターン棄却
 * - 収束閾値の緩和（0.30→0.70）とApexベース補完
 * - プローブ用ハードコードの除去
 *
 * 4b) 回帰ベース（完成済みの主力検出）
 * 4d) 形成中ウェッジ検出（緩い条件）
 */
import { EPSILON } from '../../lib/math.js';
import { generatePatternDiagram, type PatternDiagramData } from '../../lib/pattern-diagrams.js';
import {
	calcAlternationScoreEx,
	calcApex,
	calcATR,
	calcDurationScoreEx,
	calcInsideRatioEx,
	calculatePatternScoreEx,
	checkContainment,
	checkConvergenceEx,
	deduplicatePatterns,
	detectWedgeBreak,
	determineWedgeType,
	evaluateTouchesEx,
	generateWindows,
} from './helpers.js';
import { smoothCandleExtremes } from './smoothing.js';
import type {
	CandDebugEntry,
	CandleData,
	DeduplicablePattern,
	DetectContext,
	DetectResult,
	TouchResult,
} from './types.js';

// ── Configuration ──

// SG Filter
const SG_WINDOW_MIN = 5;
const SG_WINDOW_MAX = 11;
const SG_CANDLE_RATIO = 20;
const MIN_SG_PIVOTS = 6;

// Wedge Detection params
const WINDOW_SIZE_MIN = 25;
const WINDOW_SIZE_MAX = 90;
const WINDOW_STEP = 5;
const MIN_SLOPE = 0.00005;
const MAX_SLOPE = 0.08;
const SLOPE_RATIO_MIN = 1.15;
const SLOPE_RATIO_MIN_RISING = 1.2;
const MIN_WEAKER_SLOPE_RATIO = 0.3;
const MIN_TOUCHES_PER_LINE = 3;
const MIN_SCORE = 0.5;
const MIN_CONTAINMENT = 0.85;

// Touch Validation
const MAX_TOUCH_GAP_BARS = 25;
const MAX_START_GAP_BARS = 10;
const MIN_ALTERNATION = 0.25;
const MIN_TOUCH_BALANCE = 0.45;

// R2 threshold
const MIN_R2_THRESHOLD = 0.55;
const MIN_HIGHS_RATIO = 0.99;

// Scoring weights
const CONVERGENCE_WEIGHT = 0.4;
const SLOPE_WEIGHT = 0.3;
const DURATION_WEIGHT = 0.3;

// Confidence bounds
const CONFIDENCE_MIN = 0.65;
const CONFIDENCE_MAX = 0.95;
const CONFIDENCE_BOOST = 0.3;

// Forming wedge params
const FORMING_WINDOW_MIN = 20;
const FORMING_WINDOW_MAX = 120;
const FORMING_MIN_CONTAINMENT = 0.75;
const FORMING_MAX_CONV_RATIO = 0.8;
const FORMING_BREAKOUT_FACTOR = 0.015;

// ATR multiplier for break direction
const ATR_BREAK_THRESHOLD = 0.3;

// Downsample
const MAX_DIAGRAM_POINTS = 6;

// Forming duration
const FORMING_MIN_BARS_BEFORE_BREAK = 15;
const FORMING_PRICE_TOLERANCE_PCT = 0.01;

// ── Intermediate types ──

/** preparePivots の戻り値 */
interface PivotData {
	smoothHigh: number[];
	smoothLow: number[];
	sgPeaks: Array<{ index: number; price: number }>;
	sgValleys: Array<{ index: number; price: number }>;
}

/** lrWithR2 の戻り値互換（TrendLine + r2 必須） */
interface RegLine {
	slope: number;
	intercept: number;
	r2: number;
	valueAt: (x: number) => number;
}

/** validateRegressionCandidate の成功結果 */
interface RegressionValidation {
	apex: { isValid: boolean; apexIdx: number; barsToApex: number };
	conv: { isConverging: boolean; gapStart: number; gapEnd: number; ratio: number; score?: number };
	containment: { closeInsideRatio: number; violations: number; total: number };
	touches: TouchResult;
	alternation: number;
	insideRatio: number;
	score: number;
}

// ── Phase 1: ピボット準備 ──

function preparePivots(ctx: DetectContext): PivotData {
	const { candles, swingDepth } = ctx;

	const sgWindowSize = Math.max(
		SG_WINDOW_MIN,
		Math.min(SG_WINDOW_MAX, Math.floor(candles.length / SG_CANDLE_RATIO) * 2 + 1),
	);
	const { smoothHigh, smoothLow } = smoothCandleExtremes(candles, sgWindowSize, 2);

	const sgPeaks: Array<{ index: number; price: number }> = [];
	const sgValleys: Array<{ index: number; price: number }> = [];
	const sgDepth = Math.max(2, swingDepth);
	for (let i = sgDepth; i < candles.length - sgDepth; i++) {
		let isHigh = true;
		let isLow = true;
		for (let k = 1; k <= sgDepth; k++) {
			if (!(smoothHigh[i] > smoothHigh[i - k] && smoothHigh[i] > smoothHigh[i + k])) isHigh = false;
			if (!(smoothLow[i] < smoothLow[i - k] && smoothLow[i] < smoothLow[i + k])) isLow = false;
			if (!isHigh && !isLow) break;
		}
		if (isHigh) sgPeaks.push({ index: i, price: candles[i].close });
		else if (isLow) sgValleys.push({ index: i, price: candles[i].close });
	}

	return { smoothHigh, smoothLow, sgPeaks, sgValleys };
}

// ── Phase 2a: 回帰ベース候補のバリデーション ──

function calcMaxTouchGap(touchArr: Array<{ index: number; isBreak: boolean }>): number {
	const validTouches = touchArr
		.filter((t) => !t.isBreak)
		.map((t) => t.index)
		.sort((a, b) => a - b);
	if (validTouches.length < 2) return Infinity;
	let maxGap = 0;
	for (let i = 1; i < validTouches.length; i++) {
		maxGap = Math.max(maxGap, validTouches[i] - validTouches[i - 1]);
	}
	return maxGap;
}

function validateRegressionCandidate(
	candles: CandleData[],
	wedgeType: 'rising_wedge' | 'falling_wedge',
	upper: RegLine,
	lower: RegLine,
	startIdx: number,
	endIdx: number,
	debugCandidates: CandDebugEntry[],
): RegressionValidation | null {
	// --- Apex バリデーション（UAlgo 方式） ---
	const apex = calcApex(upper, lower, endIdx);
	if (!apex.isValid) {
		debugCandidates.push({
			type: wedgeType,
			accepted: false,
			reason: 'apex_not_in_future',
			indices: [startIdx, endIdx],
			details: { apexIdx: apex.apexIdx, barsToApex: apex.barsToApex, endIdx },
		});
		return null;
	}

	// --- 収束チェック（Apexベース強化版） ---
	const conv = checkConvergenceEx(upper, lower, startIdx, endIdx);
	if (!conv.isConverging) {
		debugCandidates.push({
			type: wedgeType,
			accepted: false,
			reason: 'convergence_failed',
			indices: [startIdx, endIdx],
			details: { gapStart: conv.gapStart, gapEnd: conv.gapEnd, ratio: conv.ratio },
		});
		return null;
	}

	// --- 包含ルール（UAlgo 方式: 終値が境界内） ---
	const containment = checkContainment(candles, upper, lower, startIdx, endIdx);
	if (containment.closeInsideRatio < MIN_CONTAINMENT) {
		debugCandidates.push({
			type: wedgeType,
			accepted: false,
			reason: 'containment_violated',
			indices: [startIdx, endIdx],
			details: {
				closeInsideRatio: Number(containment.closeInsideRatio.toFixed(3)),
				violations: containment.violations,
				total: containment.total,
				minRequired: MIN_CONTAINMENT,
			},
		});
		return null;
	}

	const touches = evaluateTouchesEx(candles, upper, lower, startIdx, endIdx);
	if (touches.upperQuality < MIN_TOUCHES_PER_LINE || touches.lowerQuality < MIN_TOUCHES_PER_LINE) {
		debugCandidates.push({
			type: wedgeType,
			accepted: false,
			reason: 'insufficient_touches',
			indices: [startIdx, endIdx],
			details: {
				upperTouches: touches.upperQuality,
				lowerTouches: touches.lowerQuality,
				minRequired: MIN_TOUCHES_PER_LINE,
			},
		});
		return null;
	}

	// タッチ間隔チェック（日足で25本以上空いていたら除外）
	const upperMaxGap = calcMaxTouchGap(touches.upperTouches);
	const lowerMaxGap = calcMaxTouchGap(touches.lowerTouches);
	const maxGap = Math.max(upperMaxGap, lowerMaxGap);
	if (maxGap > MAX_TOUCH_GAP_BARS) {
		debugCandidates.push({
			type: wedgeType,
			accepted: false,
			reason: 'touch_gap_too_large',
			indices: [startIdx, endIdx],
			details: { upperMaxGap, lowerMaxGap, maxGap, maxAllowed: MAX_TOUCH_GAP_BARS },
		});
		return null;
	}

	// 開始日ギャップチェック
	const firstUpperTouch = touches.upperTouches.find((t) => !t.isBreak);
	const firstLowerTouch = touches.lowerTouches.find((t) => !t.isBreak);
	if (firstUpperTouch && firstLowerTouch) {
		const startGap = Math.abs(firstUpperTouch.index - firstLowerTouch.index);
		if (startGap > MAX_START_GAP_BARS) {
			debugCandidates.push({
				type: wedgeType,
				accepted: false,
				reason: 'start_gap_too_large',
				indices: [startIdx, endIdx],
				details: {
					firstUpperIdx: firstUpperTouch.index,
					firstLowerIdx: firstLowerTouch.index,
					startGap,
					maxAllowed: MAX_START_GAP_BARS,
				},
			});
			return null;
		}
	}

	const alternation = calcAlternationScoreEx(touches);

	// 上下タッチのバランスチェック
	const upQ = Number(touches?.upperQuality ?? 0);
	const loQ = Number(touches?.lowerQuality ?? 0);
	const denom = Math.max(upQ, loQ, 1);
	const touchBalance = Math.min(upQ, loQ) / denom;
	if (touchBalance < MIN_TOUCH_BALANCE) {
		debugCandidates.push({
			type: wedgeType,
			accepted: false,
			reason: 'unbalanced_touches',
			indices: [startIdx, endIdx],
			details: {
				upperTouches: upQ,
				lowerTouches: loQ,
				balance: Number(touchBalance.toFixed(3)),
				minRequired: MIN_TOUCH_BALANCE,
			},
		});
		return null;
	}

	const insideRatio = calcInsideRatioEx(candles, upper, lower, startIdx, endIdx);
	const durationParams = { windowSizeMin: WINDOW_SIZE_MIN, windowSizeMax: WINDOW_SIZE_MAX };
	const score = calculatePatternScoreEx({
		fitScore: (upper.r2 + lower.r2) / 2,
		convergeScore: conv.score ?? 0,
		touchScore: touches.score,
		alternationScore: alternation,
		insideScore: insideRatio,
		durationScore: calcDurationScoreEx(endIdx - startIdx, durationParams),
	});

	// 最低交互性チェック
	if (Number(alternation ?? 0) < MIN_ALTERNATION) {
		debugCandidates.push({
			type: wedgeType,
			accepted: false,
			reason: 'insufficient_alternation',
			indices: [startIdx, endIdx],
			details: {
				alternation: Number((alternation ?? 0).toFixed(3)),
				minRequired: MIN_ALTERNATION,
				upperTouches: Number(touches?.upperQuality ?? 0),
				lowerTouches: Number(touches?.lowerQuality ?? 0),
			},
		});
		return null;
	}

	if (score < MIN_SCORE) {
		debugCandidates.push({
			type: wedgeType,
			accepted: false,
			reason: 'score_below_threshold',
			indices: [startIdx, endIdx],
			details: {
				score: Number(score.toFixed(3)),
				minScore: MIN_SCORE,
				components: {
					fit: Number(((upper.r2 + lower.r2) / 2).toFixed(3)),
					converge: Number((conv.score ?? 0).toFixed(3)),
					touch: Number((touches.score ?? 0).toFixed(3)),
					alternation: Number((alternation ?? 0).toFixed(3)),
					inside: Number((insideRatio ?? 0).toFixed(3)),
					duration: Number(calcDurationScoreEx(endIdx - startIdx, durationParams).toFixed(3)),
				},
			},
		});
		return null;
	}

	return { apex, conv, containment, touches, alternation, insideRatio, score };
}

// ── Phase 2b: 回帰ベース候補の結果構築 ──

function downsamplePoints(pts: Array<{ idx: number; kind: 'H' | 'L' }>, maxPoints: number) {
	if (pts.length <= maxPoints) return pts;
	const out: typeof pts = [];
	const lastIdxPts = pts.length - 1;
	for (let i = 0; i < maxPoints; i++) {
		const pos = Math.round((i / Math.max(1, maxPoints - 1)) * lastIdxPts);
		out.push(pts[pos]);
	}
	return out.filter((p, i, arr) => arr.findIndex((q) => q.idx === p.idx && q.kind === p.kind) === i);
}

function buildRegressionEntry(
	candles: CandleData[],
	wedgeType: 'rising_wedge' | 'falling_wedge',
	upper: RegLine,
	lower: RegLine,
	startIdx: number,
	endIdx: number,
	v: RegressionValidation,
	useSmoothed: boolean,
	debugCandidates: CandDebugEntry[],
): DeduplicablePattern | null {
	const start = candles[startIdx]?.isoTime;
	const theoreticalEnd = candles[endIdx]?.isoTime;
	if (!start || !theoreticalEnd) return null;

	// ブレイク検出
	const lastIdx = candles.length - 1;
	const atr = calcATR(candles, startIdx, endIdx, 14);
	const breakInfo = detectWedgeBreak(candles, wedgeType, upper, lower, startIdx, endIdx, lastIdx, atr);

	// 終点: ブレイクが検出された場合はブレイク日、そうでなければウィンドウ終端
	const actualEndIdx = breakInfo.detected ? breakInfo.breakIdx : endIdx;
	const end = candles[actualEndIdx]?.isoTime ?? theoreticalEnd;

	// ブレイク方向の判定
	let breakoutDirection: 'up' | 'down' | null = null;
	if (breakInfo.detected && Number.isFinite(breakInfo.breakPrice)) {
		const breakPrice = breakInfo.breakPrice as number;
		const lLineAtBreak = lower.valueAt(breakInfo.breakIdx);
		const uLineAtBreak = upper.valueAt(breakInfo.breakIdx);
		if (breakPrice < lLineAtBreak - atr * ATR_BREAK_THRESHOLD) {
			breakoutDirection = 'down';
		} else if (breakPrice > uLineAtBreak + atr * ATR_BREAK_THRESHOLD) {
			breakoutDirection = 'up';
		}
	}

	const { apex, conv, containment, touches, alternation, insideRatio, score } = v;
	const confidence = Math.max(0, Math.min(1, Number(score.toFixed(2))));

	// --- ターゲット価格計算（pattern_height 方式） ---
	const patternHeight = Math.abs(upper.valueAt(startIdx) - lower.valueAt(startIdx));
	let breakoutTarget: number | undefined;
	let targetReachedPct: number | undefined;
	if (breakInfo.detected && breakoutDirection && Number.isFinite(breakInfo.breakPrice)) {
		const bp = breakInfo.breakPrice as number;
		breakoutTarget = breakoutDirection === 'up' ? bp + patternHeight : bp - patternHeight;
		breakoutTarget = Math.round(breakoutTarget);
		const currentPrice = Number(candles[candles.length - 1]?.close);
		if (Number.isFinite(currentPrice) && Math.abs(breakoutTarget - bp) > EPSILON) {
			targetReachedPct = Math.round(((currentPrice - bp) / (breakoutTarget - bp)) * 100);
		}
	}

	// ダイアグラム用にタッチポイントから主要点を間引きして pivots を構成
	const upTouchPts = (touches.upperTouches || [])
		.filter((t) => !t.isBreak)
		.map((t) => ({ idx: t.index, kind: 'H' as const }));
	const loTouchPts = (touches.lowerTouches || [])
		.filter((t) => !t.isBreak)
		.map((t) => ({ idx: t.index, kind: 'L' as const }));
	const allPts = [...upTouchPts, ...loTouchPts].sort((a, b) => a.idx - b.idx);
	const sel = downsamplePoints(allPts, MAX_DIAGRAM_POINTS);
	const pivForDiagram = sel.map((p) => ({
		idx: p.idx,
		price: Number(candles[p.idx]?.close ?? NaN),
		kind: p.kind,
		date: candles[p.idx]?.isoTime,
	}));
	let diagram: PatternDiagramData | undefined;
	try {
		diagram = generatePatternDiagram(wedgeType, pivForDiagram, { price: 0 }, { start, end });
	} catch {
		/* noop */
	}

	// aftermath情報
	const isSuccessfulBreakout = breakInfo.detected
		? wedgeType === 'falling_wedge'
			? breakoutDirection === 'up'
			: breakoutDirection === 'down'
		: false;

	const aftermath = breakInfo.detected
		? {
				breakoutDate: breakInfo.breakIsoTime,
				breakoutConfirmed: true,
				targetReached: false,
				outcome: isSuccessfulBreakout
					? wedgeType === 'falling_wedge'
						? 'bullish_breakout'
						: 'bearish_breakout'
					: wedgeType === 'falling_wedge'
						? 'bearish_breakdown'
						: 'bullish_breakdown',
			}
		: undefined;

	// status / outcome 判定（4b: 完成済み主力検出）
	const status4b: 'completed' | 'invalid' | 'near_completion' = breakInfo.detected ? 'completed' : 'near_completion';
	let outcome4b: 'success' | 'failure' | undefined;
	if (breakInfo.detected && breakoutDirection) {
		const expected = wedgeType === 'falling_wedge' ? 'up' : 'down';
		outcome4b = breakoutDirection === expected ? 'success' : 'failure';
	}

	debugCandidates.push({
		type: wedgeType,
		accepted: true,
		reason: 'revamped_ok',
		indices: [startIdx, actualEndIdx],
		details: {
			slopeHigh: upper.slope,
			slopeLow: lower.slope,
			r2High: upper.r2,
			r2Low: lower.r2,
			apex: { idx: apex.apexIdx, barsToApex: apex.barsToApex },
			containment: { ratio: containment.closeInsideRatio, violations: containment.violations },
			converge: conv,
			touches: { up: touches.upperQuality, lo: touches.lowerQuality },
			alternation,
			insideRatio,
			score,
			smoothed: useSmoothed,
			breakInfo: breakInfo.detected ? { ...breakInfo, direction: breakoutDirection } : null,
		},
	});

	return {
		type: wedgeType,
		confidence,
		range: { start, end },
		status: status4b,
		daysToApex: apex.isValid ? apex.barsToApex : undefined,
		breakoutDirection: breakoutDirection ?? undefined,
		outcome: outcome4b,
		breakoutDate: breakInfo.detected ? breakInfo.breakIsoTime : undefined,
		breakoutBarIndex: breakInfo.detected ? breakInfo.breakIdx : undefined,
		...(breakoutTarget !== undefined ? { breakoutTarget, targetMethod: 'pattern_height' as const } : {}),
		...(targetReachedPct !== undefined ? { targetReachedPct } : {}),
		...(aftermath ? { aftermath } : {}),
		...(diagram ? { structureDiagram: diagram } : {}),
	};
}

// ── Phase 2: 回帰ベース完成済みウェッジ検出 ──

function detectRegressionWedges(pivotData: PivotData, ctx: DetectContext): DeduplicablePattern[] {
	const { candles, pivots, want, lrWithR2, debugCandidates } = ctx;
	const patterns: DeduplicablePattern[] = [];

	const params = {
		swingDepth: ctx.swingDepth,
		minBarsBetweenSwings: ctx.minDist,
		tolerancePct: ctx.tolerancePct,
		windowSizeMin: WINDOW_SIZE_MIN,
		windowSizeMax: WINDOW_SIZE_MAX,
		windowStep: WINDOW_STEP,
		minSlope: MIN_SLOPE,
		maxSlope: MAX_SLOPE,
		slopeRatioMin: SLOPE_RATIO_MIN,
		slopeRatioMinRising: SLOPE_RATIO_MIN_RISING,
		minWeakerSlopeRatio: MIN_WEAKER_SLOPE_RATIO,
		minTouchesPerLine: MIN_TOUCHES_PER_LINE,
		minScore: MIN_SCORE,
		minContainment: MIN_CONTAINMENT,
		slopeRatioMinFalling: SLOPE_RATIO_MIN,
	};

	// SG ピボットと元ピボットをマージ（SG 優先、元で補完）
	const origHighs = pivots.filter((p) => p.kind === 'H').map((p) => ({ index: p.idx, price: p.price }));
	const origLows = pivots.filter((p) => p.kind === 'L').map((p) => ({ index: p.idx, price: p.price }));

	const useSmoothed = pivotData.sgPeaks.length >= MIN_SG_PIVOTS && pivotData.sgValleys.length >= MIN_SG_PIVOTS;
	const swings = {
		highs: useSmoothed ? pivotData.sgPeaks : origHighs,
		lows: useSmoothed ? pivotData.sgValleys : origLows,
	};

	const allowRising = want.size === 0 || want.has('rising_wedge');
	const allowFalling = want.size === 0 || want.has('falling_wedge');
	const windows = generateWindows(candles.length, params.windowSizeMin, params.windowSizeMax, params.windowStep);
	for (const w of windows) {
		const highsIn = swings.highs.filter((s) => s.index >= w.startIdx && s.index <= w.endIdx);
		const lowsIn = swings.lows.filter((s) => s.index >= w.startIdx && s.index <= w.endIdx);
		if (highsIn.length < 4 || lowsIn.length < 4) continue;
		const upper = lrWithR2(highsIn.map((s) => ({ x: s.index, y: s.price })));
		const lower = lrWithR2(lowsIn.map((s) => ({ x: s.index, y: s.price })));
		if (upper.r2 < MIN_R2_THRESHOLD || lower.r2 < MIN_R2_THRESHOLD) {
			const dbgType =
				upper.slope < 0 && lower.slope < 0
					? 'falling_wedge'
					: upper.slope > 0 && lower.slope > 0
						? 'rising_wedge'
						: 'triangle_symmetrical';
			debugCandidates.push({
				type: dbgType,
				accepted: false,
				reason: 'r2_below_threshold',
				indices: [w.startIdx, w.endIdx],
				details: {
					r2High: upper.r2,
					r2Low: lower.r2,
					slopeHigh: upper.slope,
					slopeLow: lower.slope,
					r2MinRequired: MIN_R2_THRESHOLD,
				},
			});
			continue;
		}
		// Rising Wedge の「有意な上昇」チェック（動的なしきい値）
		if (upper.slope > 0 && lower.slope > 0) {
			let hiMax = -Infinity,
				loMin = Infinity;
			for (let i = w.startIdx; i <= w.endIdx; i++) {
				const hi = Number(candles[i]?.high ?? NaN);
				const lo = Number(candles[i]?.low ?? NaN);
				if (Number.isFinite(hi)) hiMax = Math.max(hiMax, hi);
				if (Number.isFinite(lo)) loMin = Math.min(loMin, lo);
			}
			const priceRange = Number.isFinite(hiMax) && Number.isFinite(loMin) ? hiMax - loMin : 0;
			const barsSpan = Math.max(1, w.endIdx - w.startIdx);
			const minMeaningfulSlope = (priceRange * 0.01) / barsSpan;
			const absHi = Math.abs(upper.slope);
			if (absHi < minMeaningfulSlope) {
				debugCandidates.push({
					type: 'rising_wedge',
					accepted: false,
					reason: 'upper_line_barely_rising',
					indices: [w.startIdx, w.endIdx],
					details: { slopeHigh: upper.slope, slopeLow: lower.slope, minMeaningfulSlope, priceRange, barsSpan },
				});
				continue;
			}
			if (highsIn.length >= 3) {
				const mid = Math.floor(highsIn.length / 2);
				const firstHalf = highsIn.slice(0, mid);
				const secondHalf = highsIn.slice(mid);
				const firstAvg = firstHalf.reduce((s, p) => s + Number(p.price), 0) / Math.max(1, firstHalf.length);
				const secondAvg = secondHalf.reduce((s, p) => s + Number(p.price), 0) / Math.max(1, secondHalf.length);
				const ratio = Number((secondAvg / Math.max(EPSILON, firstAvg)).toFixed(4));
				if (Number.isFinite(firstAvg) && Number.isFinite(secondAvg) && ratio < MIN_HIGHS_RATIO) {
					debugCandidates.push({
						type: 'rising_wedge',
						accepted: false,
						reason: 'declining_highs',
						indices: [w.startIdx, w.endIdx],
						details: { firstAvg, secondAvg, ratio },
					});
					continue;
				}
			}
		}
		const wedgeType = determineWedgeType(upper.slope, lower.slope, params);
		if (!wedgeType) {
			const absHi = Math.abs(upper.slope);
			const absLo = Math.abs(lower.slope);
			const slopeRatioHL = absHi / Math.max(EPSILON, absLo);
			const slopeRatioLH = absLo / Math.max(EPSILON, absHi);
			let failureReason: 'slope_ratio_too_small' | 'slopes_too_flat' | 'wrong_side_steeper' = 'slope_ratio_too_small';
			if (upper.slope > 0 && lower.slope > 0) {
				if (absHi < (params.minSlope ?? 0.0001) || absLo < (params.minSlope ?? 0.0001)) {
					failureReason = 'slopes_too_flat';
				} else if (!(absLo > absHi)) {
					failureReason = 'wrong_side_steeper';
				} else if (!(slopeRatioLH > (params.slopeRatioMinRising ?? 1.2))) {
					failureReason = 'slope_ratio_too_small';
				}
			} else if (upper.slope < 0 && lower.slope < 0) {
				if (absHi < (params.minSlope ?? 0.0001) || absLo < (params.minSlope ?? 0.0001)) {
					failureReason = 'slopes_too_flat';
				} else if (!(absHi > absLo)) {
					failureReason = 'wrong_side_steeper';
				} else if (!(slopeRatioHL > (params.slopeRatioMinFalling ?? params.slopeRatioMin ?? 1.15))) {
					failureReason = 'slope_ratio_too_small';
				}
			} else {
				failureReason = 'slope_ratio_too_small';
			}
			const dbgType =
				upper.slope < 0 && lower.slope < 0
					? 'falling_wedge'
					: upper.slope > 0 && lower.slope > 0
						? 'rising_wedge'
						: 'triangle_symmetrical';
			debugCandidates.push({
				type: dbgType,
				accepted: false,
				reason: 'type_classification_failed',
				indices: [w.startIdx, w.endIdx],
				details: {
					slopeHigh: upper.slope,
					slopeLow: lower.slope,
					slopeRatio: Number((Math.abs(upper.slope) / Math.max(EPSILON, Math.abs(lower.slope))).toFixed(4)),
					minSlope: params.minSlope ?? 0.0001,
					maxSlope: params.maxSlope ?? 0.05,
					slopeRatioMin:
						dbgType === 'rising_wedge'
							? (params.slopeRatioMinRising ?? 1.2)
							: (params.slopeRatioMinFalling ?? params.slopeRatioMin ?? 1.15),
					failureReason,
				},
			});
			continue;
		}
		if ((wedgeType === 'rising_wedge' && !allowRising) || (wedgeType === 'falling_wedge' && !allowFalling)) {
			debugCandidates.push({
				type: wedgeType,
				accepted: false,
				reason: 'type_not_requested',
				indices: [w.startIdx, w.endIdx],
			});
			continue;
		}

		const v = validateRegressionCandidate(candles, wedgeType, upper, lower, w.startIdx, w.endIdx, debugCandidates);
		if (!v) continue;
		const entry = buildRegressionEntry(
			candles,
			wedgeType,
			upper,
			lower,
			w.startIdx,
			w.endIdx,
			v,
			useSmoothed,
			debugCandidates,
		);
		if (entry) patterns.push(entry);
	}

	return patterns;
}

// ── Phase 3: 形成中ウェッジ検出ヘルパー ──

type FormingLine = { slope: number; intercept: number; valueAt: (idx: number) => number };

function makeLineF(p1: { idx: number; price: number }, p2: { idx: number; price: number }): FormingLine {
	const slope = (p2.price - p1.price) / Math.max(1, p2.idx - p1.idx);
	const intercept = p1.price - slope * p1.idx;
	return { slope, intercept, valueAt: (idx: number) => slope * idx + intercept };
}

function findUpperTrendlineF(
	highs: { idx: number; price: number }[],
	startIdx: number,
	endIdx: number,
	tolerance: number,
): FormingLine | null {
	const inRange = highs.filter((h) => h.idx >= startIdx && h.idx <= endIdx);
	if (inRange.length < 2) return null;

	const midPoint = startIdx + (endIdx - startIdx) / 2;
	const firstHalf = inRange.filter((h) => h.idx < midPoint);
	const secondHalf = inRange.filter((h) => h.idx >= midPoint);
	const cand1 = firstHalf.length > 0 ? firstHalf : inRange.slice(0, Math.ceil(inRange.length / 2));
	const cand2 = secondHalf.length > 0 ? secondHalf : inRange.slice(Math.floor(inRange.length / 2));
	if (cand1.length === 0 || cand2.length === 0) return null;

	let bestLine: FormingLine | null = null;
	let bestScore = -Infinity;

	for (const p1 of cand1) {
		for (const p2 of cand2) {
			if (p1.idx >= p2.idx) continue;
			const line = makeLineF(p1, p2);
			let valid = true;
			for (const h of inRange) {
				if (h.price > line.valueAt(h.idx) + tolerance) {
					valid = false;
					break;
				}
			}
			if (valid) {
				const touches = inRange.filter((h) => Math.abs(h.price - line.valueAt(h.idx)) <= tolerance).length;
				const lineScore = touches + (line.slope < 0 ? 1 : 0);
				if (lineScore > bestScore) {
					bestScore = lineScore;
					bestLine = line;
				}
			}
		}
	}
	return bestLine;
}

function findLowerTrendlineF(
	lows: { idx: number; price: number }[],
	startIdx: number,
	endIdx: number,
	tolerance: number,
): FormingLine | null {
	const inRange = lows.filter((l) => l.idx >= startIdx && l.idx <= endIdx);
	if (inRange.length < 2) return null;

	const midPoint = startIdx + (endIdx - startIdx) / 2;
	const firstHalf = inRange.filter((l) => l.idx < midPoint);
	const secondHalf = inRange.filter((l) => l.idx >= midPoint);
	const cand1 = firstHalf.length > 0 ? firstHalf : inRange.slice(0, Math.ceil(inRange.length / 2));
	const cand2 = secondHalf.length > 0 ? secondHalf : inRange.slice(Math.floor(inRange.length / 2));
	if (cand1.length === 0 || cand2.length === 0) return null;

	let bestLine: FormingLine | null = null;
	let bestScore = -Infinity;

	for (const p1 of cand1) {
		for (const p2 of cand2) {
			if (p1.idx >= p2.idx) continue;
			const line = makeLineF(p1, p2);
			let valid = true;
			for (const l of inRange) {
				if (l.price < line.valueAt(l.idx) - tolerance) {
					valid = false;
					break;
				}
			}
			if (valid) {
				const touches = inRange.filter((l) => Math.abs(l.price - line.valueAt(l.idx)) <= tolerance).length;
				const lineScore = touches + (line.slope < 0 ? 1 : 0);
				if (lineScore > bestScore) {
					bestScore = lineScore;
					bestLine = line;
				}
			}
		}
	}
	return bestLine;
}

// ── Phase 3: 形成中ウェッジ検出 ──

function detectFormingWedges(
	pivotData: PivotData,
	existingPatterns: readonly DeduplicablePattern[],
	ctx: DetectContext,
): DeduplicablePattern[] {
	const { candles, want, debugCandidates } = ctx;
	const { smoothHigh, smoothLow } = pivotData;
	const patterns: DeduplicablePattern[] = [];
	const formingWedgeDebug: CandDebugEntry[] = [];

	const fAllowFalling = want.size === 0 || want.has('falling_wedge');
	const fAllowRising = want.size === 0 || want.has('rising_wedge');

	// SG 平滑化データからリラックスピボットを検出（swingDepth=1 相当）
	const relaxedPeaks: Array<{ idx: number; price: number }> = [];
	const relaxedValleys: Array<{ idx: number; price: number }> = [];
	for (let idx = 1; idx < candles.length - 1; idx++) {
		const isPeak = smoothHigh[idx] > smoothHigh[idx - 1] && smoothHigh[idx] > smoothHigh[idx + 1];
		const isValley = smoothLow[idx] < smoothLow[idx - 1] && smoothLow[idx] < smoothLow[idx + 1];
		if (isPeak) relaxedPeaks.push({ idx, price: candles[idx].close });
		if (isValley) relaxedValleys.push({ idx, price: candles[idx].close });
	}

	// ウィンドウスキャン
	const fWindows: Array<{ startIdx: number; endIdx: number }> = [];
	for (let size = FORMING_WINDOW_MIN; size <= FORMING_WINDOW_MAX; size += WINDOW_STEP) {
		for (let startIdx = 0; startIdx + size < candles.length; startIdx += WINDOW_STEP) {
			fWindows.push({ startIdx, endIdx: startIdx + size });
		}
	}
	// 最新に揃えた特別ウィンドウ
	const lastIdx = candles.length - 1;
	for (let size = FORMING_WINDOW_MIN; size <= FORMING_WINDOW_MAX; size += WINDOW_STEP) {
		const s = Math.max(0, lastIdx - size);
		fWindows.push({ startIdx: s, endIdx: lastIdx });
	}

	// 重複チェック用: 既存パターン + この関数内で生成したパターン両方を参照
	const allPatterns = [...existingPatterns];

	for (const w of fWindows) {
		const { startIdx, endIdx } = w;
		const avgPrice = (Number(candles[startIdx]?.close) + Number(candles[endIdx]?.close)) / 2;
		const tolerance = avgPrice * FORMING_PRICE_TOLERANCE_PCT;

		const highsForWindow = relaxedPeaks
			.filter((p) => p.idx >= startIdx && p.idx <= endIdx)
			.map((p) => ({ idx: p.idx, price: Number(candles[p.idx]?.high) }));
		const lowsForWindow = relaxedValleys
			.filter((p) => p.idx >= startIdx && p.idx <= endIdx)
			.map((p) => ({ idx: p.idx, price: Number(candles[p.idx]?.low) }));

		if (highsForWindow.length < 2 || lowsForWindow.length < 2) continue;

		const upperLine = findUpperTrendlineF(highsForWindow, startIdx, endIdx, tolerance);
		const lowerLine = findLowerTrendlineF(lowsForWindow, startIdx, endIdx, tolerance);
		if (!upperLine || !lowerLine) continue;

		// 両方下向き = Falling Wedge、両方上向き = Rising Wedge
		const bothDown = upperLine.slope < 0 && lowerLine.slope < 0;
		const bothUp = upperLine.slope > 0 && lowerLine.slope > 0;
		if (!bothDown && !bothUp) {
			formingWedgeDebug.push({
				type: upperLine.slope < 0 ? 'falling_wedge' : 'rising_wedge',
				accepted: false,
				reason: 'slopes_not_same_direction',
				indices: [startIdx, endIdx],
				details: { slopeU: upperLine.slope, slopeL: lowerLine.slope },
			});
			continue;
		}

		// minWeakerSlopeRatio チェック
		const absU = Math.abs(upperLine.slope),
			absL = Math.abs(lowerLine.slope);
		const weakerRatio = Math.min(absU, absL) / Math.max(absU, absL);
		if (weakerRatio < MIN_WEAKER_SLOPE_RATIO) {
			formingWedgeDebug.push({
				type: bothDown ? 'falling_wedge' : 'rising_wedge',
				accepted: false,
				reason: 'weaker_slope_ratio_low',
				indices: [startIdx, endIdx],
				details: { weakerRatio },
			});
			continue;
		}

		const wedgeType: 'falling_wedge' | 'rising_wedge' = bothDown ? 'falling_wedge' : 'rising_wedge';
		if ((wedgeType === 'falling_wedge' && !fAllowFalling) || (wedgeType === 'rising_wedge' && !fAllowRising)) continue;

		// 収束チェック
		const gapStart = upperLine.valueAt(startIdx) - lowerLine.valueAt(startIdx);
		const gapEnd = upperLine.valueAt(endIdx) - lowerLine.valueAt(endIdx);
		if (gapStart <= 0 || gapEnd <= 0 || gapEnd >= gapStart) {
			formingWedgeDebug.push({
				type: wedgeType,
				accepted: false,
				reason: 'no_convergence',
				indices: [startIdx, endIdx],
				details: { gapStart, gapEnd },
			});
			continue;
		}
		const convRatio = gapEnd / gapStart;
		if (convRatio >= FORMING_MAX_CONV_RATIO) {
			formingWedgeDebug.push({
				type: wedgeType,
				accepted: false,
				reason: 'conv_ratio_too_high',
				indices: [startIdx, endIdx],
				details: { convRatio },
			});
			continue;
		}

		// Apex バリデーション（形成中でも未来にあることを確認）
		const fApex = calcApex(
			{ slope: upperLine.slope, intercept: upperLine.intercept, valueAt: upperLine.valueAt },
			{ slope: lowerLine.slope, intercept: lowerLine.intercept, valueAt: lowerLine.valueAt },
			endIdx,
		);
		if (!fApex.isValid) {
			formingWedgeDebug.push({
				type: wedgeType,
				accepted: false,
				reason: 'apex_invalid',
				indices: [startIdx, endIdx],
				details: { apex: fApex },
			});
			continue;
		}

		// 包含チェック（形成中は緩めに 75%）
		const fContainment = checkContainment(candles, upperLine, lowerLine, startIdx, endIdx, 0.005);
		if (fContainment.closeInsideRatio < FORMING_MIN_CONTAINMENT) {
			formingWedgeDebug.push({
				type: wedgeType,
				accepted: false,
				reason: 'containment_low',
				indices: [startIdx, endIdx],
				details: { containment: fContainment.closeInsideRatio },
			});
			continue;
		}

		// ブレイク検出（終値ベース、トレンドライン乖離1.5%）
		let breakoutIdx = -1;
		let breakoutDirection: 'up' | 'down' | null = null;
		for (
			let i = startIdx + Math.max(FORMING_MIN_BARS_BEFORE_BREAK, Math.floor((endIdx - startIdx) * 0.3));
			i <= lastIdx;
			i++
		) {
			const close = Number(candles[i]?.close);
			const uVal = upperLine.valueAt(i);
			const lVal = lowerLine.valueAt(i);

			if (close > uVal * (1 + FORMING_BREAKOUT_FACTOR)) {
				breakoutIdx = i;
				breakoutDirection = 'up';
				break;
			}
			if (close < lVal * (1 - FORMING_BREAKOUT_FACTOR)) {
				breakoutIdx = i;
				breakoutDirection = 'down';
				break;
			}
		}

		// ブレイクがない場合は形成中
		const isForming = breakoutIdx === -1;
		const actualEndIdx = isForming ? endIdx : breakoutIdx;
		const start = candles[startIdx]?.isoTime;
		const end = candles[actualEndIdx]?.isoTime;
		if (!start || !end) continue;

		// 重複チェック
		const alreadyExists = allPatterns.some((p) => {
			if (p.type !== wedgeType) return false;
			const pStart = Date.parse(p.range?.start || '');
			const pEnd = Date.parse(p.range?.end || '');
			const thisStart = Date.parse(start);
			const thisEnd = Date.parse(end);
			if (!Number.isFinite(pStart) || !Number.isFinite(thisStart)) return false;
			return Math.abs(pStart - thisStart) < 5 * 86400000 && Math.abs(pEnd - thisEnd) < 5 * 86400000;
		});
		if (alreadyExists) continue;

		// スコア計算
		const convergenceScore = 1 - convRatio;
		const slopeScore = Math.min(absU, absL) / Math.max(absU, absL);
		const durationDays = actualEndIdx - startIdx;
		const durationScore = durationDays >= 20 && durationDays <= 60 ? 1.0 : 0.8;
		const score = convergenceScore * CONVERGENCE_WEIGHT + slopeScore * SLOPE_WEIGHT + durationScore * DURATION_WEIGHT;
		const confidence = Math.max(CONFIDENCE_MIN, Math.min(CONFIDENCE_MAX, score + CONFIDENCE_BOOST));

		// ステータス判定
		let status: 'forming' | 'near_completion' | 'completed' | 'invalid' = 'forming';
		let outcome: 'success' | 'failure' | undefined;

		if (breakoutDirection) {
			const expected = wedgeType === 'falling_wedge' ? 'up' : 'down';
			status = 'completed';
			outcome = breakoutDirection === expected ? 'success' : 'failure';
		} else if (fApex.barsToApex <= 10) {
			status = 'near_completion';
		}

		// ブレイク日の取得
		const breakoutDate = breakoutIdx !== -1 ? candles[breakoutIdx]?.isoTime : undefined;

		// --- ターゲット価格計算（pattern_height 方式） ---
		const fPatternHeight = Math.abs(upperLine.valueAt(startIdx) - lowerLine.valueAt(startIdx));
		let fBreakoutTarget: number | undefined;
		let fTargetReachedPct: number | undefined;
		if (breakoutDirection && breakoutIdx !== -1) {
			const bp = Number(candles[breakoutIdx]?.close);
			if (Number.isFinite(bp)) {
				fBreakoutTarget = breakoutDirection === 'up' ? bp + fPatternHeight : bp - fPatternHeight;
				fBreakoutTarget = Math.round(fBreakoutTarget);
				const curPrice = Number(candles[candles.length - 1]?.close);
				if (Number.isFinite(curPrice) && Math.abs(fBreakoutTarget - bp) > EPSILON) {
					fTargetReachedPct = Math.round(((curPrice - bp) / (fBreakoutTarget - bp)) * 100);
				}
			}
		}

		const entry: DeduplicablePattern = {
			type: wedgeType,
			confidence,
			range: { start, end },
			status,
			daysToApex: fApex.isValid ? fApex.barsToApex : undefined,
			breakoutDirection: breakoutDirection ?? undefined,
			outcome,
			breakoutDate,
			breakoutBarIndex: breakoutIdx !== -1 ? breakoutIdx : undefined,
			...(fBreakoutTarget !== undefined
				? { breakoutTarget: fBreakoutTarget, targetMethod: 'pattern_height' as const }
				: {}),
			...(fTargetReachedPct !== undefined ? { targetReachedPct: fTargetReachedPct } : {}),
			_method: 'forming_relaxed',
		};
		patterns.push(entry);
		allPatterns.push(entry);

		formingWedgeDebug.push({
			type: wedgeType,
			accepted: true,
			indices: [startIdx, actualEndIdx],
			status,
			breakoutDirection,
			details: {
				apex: { idx: fApex.apexIdx, barsToApex: fApex.barsToApex },
				containment: fContainment.closeInsideRatio,
			},
		});
	}

	for (const d of formingWedgeDebug) {
		debugCandidates.unshift(d);
	}

	return patterns;
}

// ── Orchestrator ──

export function detectWedges(ctx: DetectContext): DetectResult {
	const pivotData = preparePivots(ctx);
	const regressionPatterns = detectRegressionWedges(pivotData, ctx);
	const formingPatterns = detectFormingWedges(pivotData, regressionPatterns, ctx);
	// includeForming=false のときに forming / near_completion を残すと、
	// 後段 globalDedup で completed が confidence/end-time の比較に負けて
	// 消える可能性があるため、dedup より前で落とす。
	// 形成中ウィンドウでブレイク確認済みのもの（status='completed'）は
	// 通常の完成済みと同列で扱う。
	const merged = [...regressionPatterns, ...formingPatterns];
	const filtered = ctx.includeForming
		? merged
		: merged.filter((p) => p.status !== 'forming' && p.status !== 'near_completion');
	return { patterns: deduplicatePatterns(filtered) };
}
