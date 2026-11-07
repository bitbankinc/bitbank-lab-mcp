import { log } from '../../lib/logger.js';
import { EPSILON } from '../../lib/math.js';
import { generatePatternDiagram, type PatternDiagramData } from '../../lib/pattern-diagrams.js';
import { roundPriceAtLevel } from '../../lib/price.js';
import { patternBarRange } from './bar-thresholds.js';
import { calcATR, deduplicatePatterns, finalizeConf } from './helpers.js';
import { linearRegressionWithR2 } from './regression.js';
import { averageDefinedAxes, marginOverGate, marginToOne, marginUnderGate, roundAxes } from './scoring.js';
import { smoothCandleExtremes } from './smoothing.js';
import type { Pivot } from './swing.js';
import { computeTargetReach, omittedTargetReach, type TargetReachResult, targetReachFields } from './target-reach.js';
import type {
	CandDebugEntry,
	CandleData,
	DeduplicablePattern,
	DetectContext,
	DetectResult,
	PatternScoreBreakdown,
	TouchPoint,
	TouchResult,
} from './types.js';
import {
	type ApexResult,
	calcAlternationScoreEx,
	calcApex,
	checkContainment,
	checkConvergenceEx,
	detectWedgeBreak,
	determineWedgeType,
	evaluateTouchesEx,
	generateWindows,
	WEDGE_MAX_CONVERGENCE,
} from './wedge-helpers.js';

const SG_WINDOW_MAX = 11;
const MIN_SG_PIVOTS = 6;

const MIN_SLOPE = 0.00005;
const MAX_SLOPE = 0.08;
const SLOPE_RATIO_MIN = 1.15;
const SLOPE_RATIO_MIN_RISING = 1.2;
const MIN_WEAKER_SLOPE_RATIO = 0.3;
const MIN_TOUCHES_PER_LINE = 3;
const MIN_CONTAINMENT = 0.85;

const MIN_ALTERNATION = 0.25;
const MIN_TOUCH_BALANCE = 0.45;

const MIN_R2_THRESHOLD = 0.55;
const MIN_HIGHS_RATIO = 0.99;

const FORMING_MIN_CONTAINMENT = 0.85;
const FORMING_MAX_CONV_RATIO = 0.8;
const FORMING_BREAKOUT_FACTOR = 0.015;
const FORMING_MIN_TOUCHES_PER_LINE = 2;
const FORMING_MIN_TOTAL_TOUCHES = 5;
const FORMING_MIN_TOUCH_SPAN_RATIO = 0.3;

const ATR_BREAK_THRESHOLD = 0.3;

const MAX_DIAGRAM_POINTS = 6;

const FORMING_PRICE_TOLERANCE_PCT = 0.01;

// 実効値はバー数。日数は patternBarRange がバー数へ換算する元の値。
const WINDOW_MIN_DAYS = 25;
const WINDOW_MAX_DAYS = 90;
const FORMING_WINDOW_MIN_DAYS = 20;
const FORMING_WINDOW_MAX_DAYS = 120;

// パターン内部の比率なので構造的下限は掛けない。掛けると許容ギャップが窓より広くなる。
const WINDOW_STEP_RATIO = 5 / WINDOW_MIN_DAYS;
const MAX_TOUCH_GAP_RATIO = 25 / WINDOW_MIN_DAYS;
const MAX_START_GAP_RATIO = 10 / WINDOW_MIN_DAYS;
const MIN_TOUCH_GAP_BARS = 8;
const MIN_START_GAP_BARS = 3;

export function getWedgeBarParams(tf: string) {
	const { minBars: windowSizeMin, maxBars: windowSizeMax } = patternBarRange(tf, WINDOW_MIN_DAYS, WINDOW_MAX_DAYS);
	const forming = patternBarRange(tf, FORMING_WINDOW_MIN_DAYS, FORMING_WINDOW_MAX_DAYS);
	return {
		windowSizeMin,
		windowSizeMax,
		windowStep: Math.max(1, Math.round(windowSizeMin * WINDOW_STEP_RATIO)),
		maxTouchGap: Math.max(MIN_TOUCH_GAP_BARS, Math.round(windowSizeMin * MAX_TOUCH_GAP_RATIO)),
		maxStartGap: Math.max(MIN_START_GAP_BARS, Math.round(windowSizeMin * MAX_START_GAP_RATIO)),
		formingWindowMin: forming.minBars,
		formingWindowMax: forming.maxBars,
	};
}

type WedgeBarParams = ReturnType<typeof getWedgeBarParams>;

interface PivotData {
	smoothHigh: number[];
	smoothLow: number[];
	sgPeaks: Array<{ index: number; price: number }>;
	sgValleys: Array<{ index: number; price: number }>;
}

interface RegLine {
	slope: number;
	intercept: number;
	r2: number;
	valueAt: (x: number) => number;
}

interface RegressionValidation {
	apex: { isValid: boolean; apexIdx: number; barsToApex: number };
	conv: { isConverging: boolean; gapStart: number; gapEnd: number; ratio: number };
	containment: { closeInsideRatio: number; violations: number; total: number };
	touches: TouchResult;
	alternation: number;
	scoreComponents: PatternScoreBreakdown;
	confidence: number;
}

// 形成中の経路も strict のゲートを物差しにするので、緩めたゲートで拾った分だけ点が下がる（#422）。
function wedgeScore(m: {
	r2?: readonly [number, number];
	convergenceRatio: number;
	touchCount: number;
	alternation: number;
	containmentRatio: number;
}): { scoreComponents: PatternScoreBreakdown; confidence: number } {
	const lineFit = m.r2
		? (marginToOne(m.r2[0], MIN_R2_THRESHOLD) + marginToOne(m.r2[1], MIN_R2_THRESHOLD)) / 2
		: undefined;
	const convergence = marginUnderGate(m.convergenceRatio, WEDGE_MAX_CONVERGENCE);
	const touches = marginOverGate(m.touchCount, MIN_TOUCHES_PER_LINE * 2);
	const alternation = marginToOne(m.alternation, MIN_ALTERNATION);
	const containment = marginToOne(m.containmentRatio, MIN_CONTAINMENT);
	// convergence 以降は常に数値なので averageDefinedAxes は undefined を返さない（?? には届かない）。
	const base = averageDefinedAxes([lineFit, convergence, touches, alternation, containment]) ?? convergence;
	return {
		scoreComponents: roundAxes({ lineFit, convergence, touches, alternation, containment }),
		confidence: finalizeConf(base),
	};
}

function preparePivots(ctx: DetectContext): PivotData {
	const { candles, swingDepth } = ctx;

	// 入力本数で平滑化の幅を変えると limit 次第でピボットが変わるので、固定幅で平滑化する。
	const sgWindowSize = SG_WINDOW_MAX;
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
	barParams: WedgeBarParams,
	debugCandidates: CandDebugEntry[],
): RegressionValidation | null {
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

	const upperMaxGap = calcMaxTouchGap(touches.upperTouches);
	const lowerMaxGap = calcMaxTouchGap(touches.lowerTouches);
	const maxGap = Math.max(upperMaxGap, lowerMaxGap);
	if (maxGap > barParams.maxTouchGap) {
		debugCandidates.push({
			type: wedgeType,
			accepted: false,
			reason: 'touch_gap_too_large',
			indices: [startIdx, endIdx],
			details: { upperMaxGap, lowerMaxGap, maxGap, maxAllowed: barParams.maxTouchGap },
		});
		return null;
	}

	const firstUpperTouch = touches.upperTouches.find((t) => !t.isBreak);
	const firstLowerTouch = touches.lowerTouches.find((t) => !t.isBreak);
	if (firstUpperTouch && firstLowerTouch) {
		const startGap = Math.abs(firstUpperTouch.index - firstLowerTouch.index);
		if (startGap > barParams.maxStartGap) {
			debugCandidates.push({
				type: wedgeType,
				accepted: false,
				reason: 'start_gap_too_large',
				indices: [startIdx, endIdx],
				details: {
					firstUpperIdx: firstUpperTouch.index,
					firstLowerIdx: firstLowerTouch.index,
					startGap,
					maxAllowed: barParams.maxStartGap,
				},
			});
			return null;
		}
	}

	const alternation = calcAlternationScoreEx(touches);

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

	const { scoreComponents, confidence } = wedgeScore({
		r2: [upper.r2, lower.r2],
		convergenceRatio: conv.ratio,
		touchCount: upQ + loQ,
		alternation,
		containmentRatio: containment.closeInsideRatio,
	});
	return { apex, conv, containment, touches, alternation, scoreComponents, confidence };
}

// 線ごとの isBreak だけでは足りないので、idx >= breakIdx の点は線を問わず落とす。evaluateTouchesEx は isBreak を線ごとに独立に立てる（#281）。
// 図用の点（間引き済み、price は終値）とは別に組み、間引かない。
// price は高安で出す。タッチ判定が高安とラインの距離なので、終値だと構成点がトレンドラインに乗らない。
// 外側バーは同じ idx が H と L の両方に入る。重複ではないので dedup しない（detect_triangles と同じ。#141）。
function buildTouchPivots(candles: readonly CandleData[], touches: TouchResult, breakIdx: number | null): Pivot[] {
	const pick = (pts: readonly TouchPoint[], kind: 'H' | 'L'): Pivot[] =>
		pts
			.filter((t) => !t.isBreak)
			.filter((t) => breakIdx === null || t.index < breakIdx)
			.map((t) => {
				const c = candles[t.index];
				const price = Number(kind === 'H' ? c?.high : c?.low);
				return { idx: t.index, price, kind, extremePrice: price };
			})
			.filter((p) => Number.isFinite(p.price));
	return [...pick(touches.upperTouches ?? [], 'H'), ...pick(touches.lowerTouches ?? [], 'L')].sort(
		(a, b) => a.idx - b.idx,
	);
}

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

// aftermath を持つのはこのパスだけで、出力から回帰ベースか形成中かを判別する手がかりになっている。
interface RegressionCandidate {
	wedgeType: 'rising_wedge' | 'falling_wedge';
	upper: RegLine;
	lower: RegLine;
	startIdx: number;
	endIdx: number;
	v: RegressionValidation;
	useSmoothed: boolean;
}

function buildRegressionEntry(
	ctx: Pick<DetectContext, 'candles' | 'debugCandidates' | 'tz' | 'type'>,
	candidate: RegressionCandidate,
): DeduplicablePattern | null {
	const { candles, debugCandidates, tz, type } = ctx;
	const { wedgeType, upper, lower, startIdx, endIdx, v, useSmoothed } = candidate;
	const start = candles[startIdx]?.isoTime;
	const theoreticalEnd = candles[endIdx]?.isoTime;
	if (!start || !theoreticalEnd) return null;

	const lastIdx = candles.length - 1;
	const atr = calcATR(candles, startIdx, endIdx, 14);
	const breakInfo = detectWedgeBreak(candles, wedgeType, upper, lower, startIdx, endIdx, lastIdx, atr);

	const actualEndIdx = breakInfo.detected ? breakInfo.breakIdx : endIdx;
	const end = candles[actualEndIdx]?.isoTime ?? theoreticalEnd;

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
	const expectedBreakoutDirection = wedgeType === 'falling_wedge' ? 'up' : 'down';
	const isSuccessfulBreakout = breakInfo.detected && breakoutDirection === expectedBreakoutDirection;

	const { apex, conv, containment, touches, alternation, scoreComponents, confidence } = v;

	const patternHeight = Math.abs(upper.valueAt(startIdx) - lower.valueAt(startIdx));
	let breakoutTarget: number | undefined;
	let targetReach: TargetReachResult = omittedTargetReach('not_broken_out');
	if (breakInfo.detected && breakoutDirection && isSuccessfulBreakout) {
		if (Number.isFinite(breakInfo.breakPrice)) {
			const bp = breakInfo.breakPrice as number;
			breakoutTarget = breakoutDirection === 'up' ? bp + patternHeight : bp - patternHeight;
			breakoutTarget = roundPriceAtLevel(breakoutTarget, bp);
			targetReach = computeTargetReach(
				candles,
				breakInfo.breakIdx,
				bp,
				breakoutTarget,
				breakoutDirection,
				patternHeight,
			);
		} else {
			targetReach = omittedTargetReach('invalid_breakout_price');
		}
	} else if (breakInfo.detected && breakoutDirection) {
		targetReach = omittedTargetReach('breakout_against_expectation');
	}

	// ブレイク探索は endIdx の次の足からなので通常は効かないが、境界の契約としてブレイク足以降を落とす。
	const pivots = buildTouchPivots(candles, touches, breakInfo.detected ? breakInfo.breakIdx : null);

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
		diagram = generatePatternDiagram(wedgeType, pivForDiagram, { price: 0 }, { start, end }, { tz, type });
	} catch (err) {
		// 図が無くてもパターンは返せるので止めないが、黙って捨てずに記録する。
		log('warn', {
			type: 'pattern_diagram_error',
			pattern: wedgeType,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	const aftermath = breakInfo.detected
		? {
				breakoutDate: breakInfo.breakIsoTime,
				breakoutConfirmed: true,
				// omitted のときは false。boolean 固定で「不明」を表せないので、到達したと名乗らない側に倒す（#210）。
				targetReached: targetReach?.kind === 'measured' ? targetReach.targetReached : false,
				outcome: isSuccessfulBreakout
					? wedgeType === 'falling_wedge'
						? 'bullish_breakout'
						: 'bearish_breakout'
					: wedgeType === 'falling_wedge'
						? 'bearish_breakdown'
						: 'bullish_breakdown',
			}
		: undefined;

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
		// 候補にも status を置く。無いと view=debug で形成中だけ状態が見える（#162）。値は status4b を使い回す。
		status: status4b,
		indices: [startIdx, actualEndIdx],
		details: {
			formationEndIdx: endIdx,
			slopeHigh: upper.slope,
			slopeLow: lower.slope,
			r2High: upper.r2,
			r2Low: lower.r2,
			apex: { idx: apex.apexIdx, barsToApex: apex.barsToApex },
			containment: { ratio: containment.closeInsideRatio, violations: containment.violations },
			converge: conv,
			touches: { up: touches.upperQuality, lo: touches.lowerQuality },
			alternation,
			scoreComponents,
			smoothed: useSmoothed,
			breakInfo: breakInfo.detected ? { ...breakInfo, direction: breakoutDirection } : null,
		},
	});

	return {
		type: wedgeType,
		confidence,
		range: { start, end },
		status: status4b,
		scoreComponents,
		pivots,
		daysToApex: apex.isValid ? Math.max(0, apex.apexIdx - actualEndIdx) : undefined,
		breakoutDirection: breakoutDirection ?? undefined,
		outcome: outcome4b,
		breakoutDate: breakInfo.detected ? breakInfo.breakIsoTime : undefined,
		breakoutBarIndex: breakInfo.detected ? breakInfo.breakIdx : undefined,
		...(breakoutTarget !== undefined ? { breakoutTarget, targetMethod: 'pattern_height' as const } : {}),
		...targetReachFields(targetReach),
		...(aftermath ? { aftermath } : {}),
		...(diagram ? { structureDiagram: diagram } : {}),
	};
}

function detectRegressionWedges(
	pivotData: PivotData,
	barParams: WedgeBarParams,
	ctx: DetectContext,
): DeduplicablePattern[] {
	const { candles, pivots, want, debugCandidates } = ctx;
	const patterns: DeduplicablePattern[] = [];

	const params = {
		swingDepth: ctx.swingDepth,
		minBarsBetweenSwings: ctx.minDist,
		tolerancePct: ctx.tolerancePct,
		windowSizeMin: barParams.windowSizeMin,
		windowSizeMax: barParams.windowSizeMax,
		windowStep: barParams.windowStep,
		minSlope: MIN_SLOPE,
		maxSlope: MAX_SLOPE,
		slopeRatioMin: SLOPE_RATIO_MIN,
		slopeRatioMinRising: SLOPE_RATIO_MIN_RISING,
		minWeakerSlopeRatio: MIN_WEAKER_SLOPE_RATIO,
		minTouchesPerLine: MIN_TOUCHES_PER_LINE,
		minContainment: MIN_CONTAINMENT,
		slopeRatioMinFalling: SLOPE_RATIO_MIN,
	};

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
		const upper = linearRegressionWithR2(highsIn.map((s) => ({ x: s.index, y: s.price })));
		const lower = linearRegressionWithR2(lowsIn.map((s) => ({ x: s.index, y: s.price })));
		if (upper.r2 < MIN_R2_THRESHOLD || lower.r2 < MIN_R2_THRESHOLD) {
			const dbgType =
				upper.slope < 0 && lower.slope < 0
					? 'falling_wedge'
					: upper.slope > 0 && lower.slope > 0
						? 'rising_wedge'
						: 'wedge';
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
			let failureReason:
				| 'slope_ratio_too_small'
				| 'slopes_too_flat'
				| 'wrong_side_steeper'
				| 'slopes_not_same_direction' = 'slope_ratio_too_small';
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
				failureReason = 'slopes_not_same_direction';
			}
			const dbgType =
				upper.slope < 0 && lower.slope < 0
					? 'falling_wedge'
					: upper.slope > 0 && lower.slope > 0
						? 'rising_wedge'
						: 'wedge';
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

		const v = validateRegressionCandidate(
			candles,
			wedgeType,
			upper,
			lower,
			w.startIdx,
			w.endIdx,
			barParams,
			debugCandidates,
		);
		if (!v) continue;
		const entry = buildRegressionEntry(ctx, {
			wedgeType,
			upper,
			lower,
			startIdx: w.startIdx,
			endIdx: w.endIdx,
			v,
			useSmoothed,
		});
		if (entry) patterns.push(entry);
	}

	return patterns;
}

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

type FormingPoint = { idx: number; price: number };

function findFormingPivots(
	candles: readonly CandleData[],
	smoothHigh: readonly number[],
	smoothLow: readonly number[],
): { peaks: FormingPoint[]; valleys: FormingPoint[] } {
	const peaks: FormingPoint[] = [];
	const valleys: FormingPoint[] = [];
	for (let idx = 1; idx < candles.length - 1; idx++) {
		const isPeak = smoothHigh[idx] > smoothHigh[idx - 1] && smoothHigh[idx] > smoothHigh[idx + 1];
		const isValley = smoothLow[idx] < smoothLow[idx - 1] && smoothLow[idx] < smoothLow[idx + 1];
		if (isPeak) peaks.push({ idx, price: candles[idx].close });
		if (isValley) valleys.push({ idx, price: candles[idx].close });
	}
	return { peaks, valleys };
}

// 窓の並び順で採否が変わる（似た形は先に採用された窓だけが残る）。
function buildFormingWindows(
	barParams: WedgeBarParams,
	candleCount: number,
): Array<{ startIdx: number; endIdx: number }> {
	const windows: Array<{ startIdx: number; endIdx: number }> = [];
	for (let size = barParams.formingWindowMin; size <= barParams.formingWindowMax; size += barParams.windowStep) {
		for (let startIdx = 0; startIdx + size < candleCount; startIdx += barParams.windowStep) {
			windows.push({ startIdx, endIdx: startIdx + size });
		}
	}
	const lastIdx = candleCount - 1;
	for (let size = barParams.formingWindowMin; size <= barParams.formingWindowMax; size += barParams.windowStep) {
		const s = Math.max(0, lastIdx - size);
		windows.push({ startIdx: s, endIdx: lastIdx });
	}
	return windows;
}

// debug を持たない棄却は、debug に積まずに次の窓へ進む。
type FormingCheck<T> = { ok: true; value: T } | { ok: false; debug?: CandDebugEntry };

interface FormingShape {
	wedgeType: 'falling_wedge' | 'rising_wedge';
	absU: number;
	absL: number;
	convRatio: number;
	fApex: ApexResult;
	fContainment: ReturnType<typeof checkContainment>;
}

function checkFormingShape(
	candles: CandleData[],
	upperLine: FormingLine,
	lowerLine: FormingLine,
	startIdx: number,
	endIdx: number,
	allow: { falling: boolean; rising: boolean },
): FormingCheck<FormingShape> {
	const bothDown = upperLine.slope < 0 && lowerLine.slope < 0;
	const bothUp = upperLine.slope > 0 && lowerLine.slope > 0;
	if (!bothDown && !bothUp) {
		return {
			ok: false,
			debug: {
				type: 'wedge',
				accepted: false,
				reason: 'slopes_not_same_direction',
				indices: [startIdx, endIdx],
				details: { slopeU: upperLine.slope, slopeL: lowerLine.slope },
			},
		};
	}

	const absU = Math.abs(upperLine.slope),
		absL = Math.abs(lowerLine.slope);
	const weakerRatio = Math.min(absU, absL) / Math.max(absU, absL);
	if (weakerRatio < MIN_WEAKER_SLOPE_RATIO) {
		return {
			ok: false,
			debug: {
				type: bothDown ? 'falling_wedge' : 'rising_wedge',
				accepted: false,
				reason: 'weaker_slope_ratio_low',
				indices: [startIdx, endIdx],
				details: { weakerRatio },
			},
		};
	}

	const wedgeType: 'falling_wedge' | 'rising_wedge' = bothDown ? 'falling_wedge' : 'rising_wedge';
	if ((wedgeType === 'falling_wedge' && !allow.falling) || (wedgeType === 'rising_wedge' && !allow.rising)) {
		return { ok: false };
	}

	const gapStart = upperLine.valueAt(startIdx) - lowerLine.valueAt(startIdx);
	const gapEnd = upperLine.valueAt(endIdx) - lowerLine.valueAt(endIdx);
	if (gapStart <= 0 || gapEnd <= 0 || gapEnd >= gapStart) {
		return {
			ok: false,
			debug: {
				type: wedgeType,
				accepted: false,
				reason: 'no_convergence',
				indices: [startIdx, endIdx],
				details: { gapStart, gapEnd },
			},
		};
	}
	const convRatio = gapEnd / gapStart;
	if (convRatio >= FORMING_MAX_CONV_RATIO) {
		return {
			ok: false,
			debug: {
				type: wedgeType,
				accepted: false,
				reason: 'conv_ratio_too_high',
				indices: [startIdx, endIdx],
				details: { convRatio },
			},
		};
	}

	const fApex = calcApex(
		{ slope: upperLine.slope, intercept: upperLine.intercept, valueAt: upperLine.valueAt },
		{ slope: lowerLine.slope, intercept: lowerLine.intercept, valueAt: lowerLine.valueAt },
		endIdx,
	);
	if (!fApex.isValid) {
		return {
			ok: false,
			debug: {
				type: wedgeType,
				accepted: false,
				reason: 'apex_invalid',
				indices: [startIdx, endIdx],
				details: { apex: fApex },
			},
		};
	}

	const fContainment = checkContainment(candles, upperLine, lowerLine, startIdx, endIdx, 0.005);
	if (fContainment.closeInsideRatio < FORMING_MIN_CONTAINMENT) {
		return {
			ok: false,
			debug: {
				type: wedgeType,
				accepted: false,
				reason: 'containment_low',
				indices: [startIdx, endIdx],
				details: { containment: fContainment.closeInsideRatio },
			},
		};
	}

	return { ok: true, value: { wedgeType, absU, absL, convRatio, fApex, fContainment } };
}

interface FormingTouches {
	validUpper: TouchPoint[];
	validLower: TouchPoint[];
	cleanTouches: TouchResult;
	fAlternation: number;
}

function checkFormingTouches(
	candles: CandleData[],
	upperLine: FormingLine,
	lowerLine: FormingLine,
	startIdx: number,
	endIdx: number,
	wedgeType: 'falling_wedge' | 'rising_wedge',
): FormingCheck<FormingTouches> {
	// 線を引いた 2 点だけでは任意のジグザグを wedge にできるので、出力するタッチ点の数・広がり・交互性も採否に使う。
	const fTouches = evaluateTouchesEx(candles, upperLine, lowerLine, startIdx, endIdx);
	const validUpper = fTouches.upperTouches.filter((t) => !t.isBreak);
	const validLower = fTouches.lowerTouches.filter((t) => !t.isBreak);
	const totalTouches = validUpper.length + validLower.length;
	if (
		validUpper.length < FORMING_MIN_TOUCHES_PER_LINE ||
		validLower.length < FORMING_MIN_TOUCHES_PER_LINE ||
		totalTouches < FORMING_MIN_TOTAL_TOUCHES
	) {
		return {
			ok: false,
			debug: {
				type: wedgeType,
				accepted: false,
				reason: 'insufficient_touches',
				indices: [startIdx, endIdx],
				details: {
					upperTouches: validUpper.length,
					lowerTouches: validLower.length,
					totalTouches,
					minPerLine: FORMING_MIN_TOUCHES_PER_LINE,
					minTotal: FORMING_MIN_TOTAL_TOUCHES,
				},
			},
		};
	}

	const patternBars = Math.max(1, endIdx - startIdx);
	const spanRatio = (touches: readonly TouchPoint[]) => {
		const indices = touches.map((t) => t.index);
		return (Math.max(...indices) - Math.min(...indices)) / patternBars;
	};
	const upperSpanRatio = spanRatio(validUpper);
	const lowerSpanRatio = spanRatio(validLower);
	if (upperSpanRatio < FORMING_MIN_TOUCH_SPAN_RATIO || lowerSpanRatio < FORMING_MIN_TOUCH_SPAN_RATIO) {
		return {
			ok: false,
			debug: {
				type: wedgeType,
				accepted: false,
				reason: 'touch_span_too_short',
				indices: [startIdx, endIdx],
				details: {
					upperSpanRatio: Number(upperSpanRatio.toFixed(3)),
					lowerSpanRatio: Number(lowerSpanRatio.toFixed(3)),
					minRequired: FORMING_MIN_TOUCH_SPAN_RATIO,
				},
			},
		};
	}

	const cleanTouches: TouchResult = {
		upperTouches: validUpper,
		lowerTouches: validLower,
		upperQuality: validUpper.length,
		lowerQuality: validLower.length,
	};
	const fAlternation = calcAlternationScoreEx(cleanTouches);
	if (fAlternation < MIN_ALTERNATION) {
		return {
			ok: false,
			debug: {
				type: wedgeType,
				accepted: false,
				reason: 'insufficient_alternation',
				indices: [startIdx, endIdx],
				details: { alternation: Number(fAlternation.toFixed(3)), minRequired: MIN_ALTERNATION },
			},
		};
	}
	const fTouchBalance = Math.min(validUpper.length, validLower.length) / Math.max(validUpper.length, validLower.length);
	if (fTouchBalance < MIN_TOUCH_BALANCE) {
		return {
			ok: false,
			debug: {
				type: wedgeType,
				accepted: false,
				reason: 'unbalanced_touches',
				indices: [startIdx, endIdx],
				details: { balance: Number(fTouchBalance.toFixed(3)), minRequired: MIN_TOUCH_BALANCE },
			},
		};
	}

	return { ok: true, value: { validUpper, validLower, cleanTouches, fAlternation } };
}

function findFormingBreakout(
	candles: readonly CandleData[],
	upperLine: FormingLine,
	lowerLine: FormingLine,
	endIdx: number,
	breakoutScanEnd: number,
): { breakoutIdx: number; breakoutDirection: 'up' | 'down' | null } {
	// ラインの推定に使った endIdx の次の足からだけ探す。形成窓の内側を遡ると未来参照になる。
	let breakoutIdx = -1;
	let breakoutDirection: 'up' | 'down' | null = null;
	for (let i = endIdx + 1; i <= breakoutScanEnd; i++) {
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

	return { breakoutIdx, breakoutDirection };
}

function formingTarget(
	candles: readonly CandleData[],
	upperLine: FormingLine,
	lowerLine: FormingLine,
	startIdx: number,
	wedgeType: 'falling_wedge' | 'rising_wedge',
	breakoutIdx: number,
	breakoutDirection: 'up' | 'down' | null,
): { fBreakoutTarget: number | undefined; fTargetReach: TargetReachResult } {
	const fPatternHeight = Math.abs(upperLine.valueAt(startIdx) - lowerLine.valueAt(startIdx));
	let fBreakoutTarget: number | undefined;
	let fTargetReach: TargetReachResult = omittedTargetReach('not_broken_out');
	const expectedBreakoutDirection = wedgeType === 'falling_wedge' ? 'up' : 'down';
	const isExpectedBreakout = breakoutDirection === expectedBreakoutDirection;
	if (breakoutDirection && breakoutIdx !== -1 && isExpectedBreakout) {
		const bp = Number(candles[breakoutIdx]?.close);
		if (Number.isFinite(bp)) {
			fBreakoutTarget = breakoutDirection === 'up' ? bp + fPatternHeight : bp - fPatternHeight;
			fBreakoutTarget = roundPriceAtLevel(fBreakoutTarget, bp);
			fTargetReach = computeTargetReach(candles, breakoutIdx, bp, fBreakoutTarget, breakoutDirection, fPatternHeight);
		} else {
			fTargetReach = omittedTargetReach('invalid_breakout_price');
		}
	} else if (breakoutDirection && breakoutIdx !== -1) {
		// 期待と逆向きの突破は wedge の否定なので、目標値を反対側へ機械的に投影しない。
		fTargetReach = omittedTargetReach('breakout_against_expectation');
	}

	return { fBreakoutTarget, fTargetReach };
}

function overlapsExistingWedge(
	patterns: readonly DeduplicablePattern[],
	wedgeType: 'falling_wedge' | 'rising_wedge',
	start: string,
	end: string,
): boolean {
	return patterns.some((p) => {
		if (p.type !== wedgeType) return false;
		const pStart = Date.parse(p.range?.start || '');
		const pEnd = Date.parse(p.range?.end || '');
		const thisStart = Date.parse(start);
		const thisEnd = Date.parse(end);
		if (!Number.isFinite(pStart) || !Number.isFinite(thisStart)) return false;
		return Math.abs(pStart - thisStart) < 5 * 86400000 && Math.abs(pEnd - thisEnd) < 5 * 86400000;
	});
}

// ブレイクを確認できた候補は completed になるので、includeForming: false でも出力に残る（既定で出る wedge_* はほぼこれ）。
function detectFormingWedges(
	pivotData: PivotData,
	barParams: WedgeBarParams,
	existingPatterns: readonly DeduplicablePattern[],
	ctx: DetectContext,
): DeduplicablePattern[] {
	const { candles, want, debugCandidates } = ctx;
	const { smoothHigh, smoothLow } = pivotData;
	const patterns: DeduplicablePattern[] = [];
	const formingWedgeDebug: CandDebugEntry[] = [];

	const fAllowFalling = want.size === 0 || want.has('falling_wedge');
	const fAllowRising = want.size === 0 || want.has('rising_wedge');

	const { peaks: relaxedPeaks, valleys: relaxedValleys } = findFormingPivots(candles, smoothHigh, smoothLow);

	const fWindows = buildFormingWindows(barParams, candles.length);
	const lastIdx = candles.length - 1;

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

		const shape = checkFormingShape(candles, upperLine, lowerLine, startIdx, endIdx, {
			falling: fAllowFalling,
			rising: fAllowRising,
		});
		if (!shape.ok) {
			if (shape.debug) formingWedgeDebug.push(shape.debug);
			continue;
		}
		const { wedgeType, convRatio, fApex, fContainment } = shape.value;

		const touches = checkFormingTouches(candles, upperLine, lowerLine, startIdx, endIdx, wedgeType);
		if (!touches.ok) {
			if (touches.debug) formingWedgeDebug.push(touches.debug);
			continue;
		}
		const { validUpper, validLower, cleanTouches, fAlternation } = touches.value;

		const { breakoutIdx, breakoutDirection } = findFormingBreakout(
			candles,
			upperLine,
			lowerLine,
			endIdx,
			Math.min(lastIdx, fApex.apexIdx - 1),
		);

		const isForming = breakoutIdx === -1;
		const actualEndIdx = isForming ? endIdx : breakoutIdx;
		const start = candles[startIdx]?.isoTime;
		const end = candles[actualEndIdx]?.isoTime;
		if (!start || !end) continue;

		if (overlapsExistingWedge(allPatterns, wedgeType, start, end)) continue;

		// 2 点を通す線なので R² が無く、lineFit は出さない。包含率はゲートより狭い strict の許容（幅の 0.3%）で測り直す。
		const { scoreComponents, confidence } = wedgeScore({
			convergenceRatio: convRatio,
			touchCount: validUpper.length + validLower.length,
			alternation: fAlternation,
			containmentRatio: checkContainment(candles, upperLine, lowerLine, startIdx, endIdx).closeInsideRatio,
		});

		let status: 'forming' | 'near_completion' | 'completed' | 'invalid' = 'forming';
		let outcome: 'success' | 'failure' | undefined;

		if (breakoutDirection) {
			const expected = wedgeType === 'falling_wedge' ? 'up' : 'down';
			status = 'completed';
			outcome = breakoutDirection === expected ? 'success' : 'failure';
		} else if (fApex.barsToApex <= 10) {
			status = 'near_completion';
		}

		const breakoutDate = breakoutIdx !== -1 ? candles[breakoutIdx]?.isoTime : undefined;

		const { fBreakoutTarget, fTargetReach } = formingTarget(
			candles,
			upperLine,
			lowerLine,
			startIdx,
			wedgeType,
			breakoutIdx,
			breakoutDirection,
		);

		// ブレイクは形成区間の次の足から探すので、breakIdx を渡さなくてもブレイク足は混入しない。
		const fPivots = buildTouchPivots(candles, cleanTouches, null);

		const entry: DeduplicablePattern = {
			type: wedgeType,
			confidence,
			range: { start, end },
			status,
			scoreComponents,
			pivots: fPivots,
			daysToApex: fApex.isValid ? Math.max(0, fApex.apexIdx - actualEndIdx) : undefined,
			breakoutDirection: breakoutDirection ?? undefined,
			outcome,
			breakoutDate,
			breakoutBarIndex: breakoutIdx !== -1 ? breakoutIdx : undefined,
			...(fBreakoutTarget !== undefined
				? { breakoutTarget: fBreakoutTarget, targetMethod: 'pattern_height' as const }
				: {}),
			...targetReachFields(fTargetReach),
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
				formationEndIdx: endIdx,
				apex: { idx: fApex.apexIdx, barsToApex: Math.max(0, fApex.apexIdx - actualEndIdx) },
				containment: fContainment.closeInsideRatio,
				touches: { up: validUpper.length, lo: validLower.length },
				alternation: fAlternation,
				scoreComponents,
			},
		});
	}

	for (const d of formingWedgeDebug) {
		debugCandidates.unshift(d);
	}

	return patterns;
}

export function detectWedges(ctx: DetectContext): DetectResult {
	const barParams = getWedgeBarParams(ctx.type);
	const pivotData = preparePivots(ctx);
	const regressionPatterns = detectRegressionWedges(pivotData, barParams, ctx);
	const formingPatterns = detectFormingWedges(pivotData, barParams, regressionPatterns, ctx);
	// 要求外の status を dedup の比較対象に混ぜないよう、dedup より前で落とす。
	const merged = [...regressionPatterns, ...formingPatterns];
	const filtered = ctx.includeForming
		? merged
		: merged.filter((p) => p.status !== 'forming' && p.status !== 'near_completion');
	return { patterns: deduplicatePatterns(filtered) };
}
