import { roundPriceAtLevel } from '../../lib/price.js';
import { patternBarRange, patternMinBars } from './bar-thresholds.js';
import { deduplicatePatterns, finalizeConf } from './helpers.js';
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
	evaluateTouchesEx,
} from './wedge-helpers.js';

const SG_WINDOW_MAX = 11;

const MIN_WEAKER_SLOPE_RATIO = 0.3;
const MIN_ALTERNATION = 0.25;
const MIN_TOUCH_BALANCE = 0.45;

// 整合度の物差し。削除した回帰経路の strict のゲートで、どの経路のゲートでもなくなったが教科書的な基準として使い続ける（#429）。
const STRICT_MAX_CONVERGENCE = 0.7;
const STRICT_MIN_TOUCHES_PER_LINE = 3;
const STRICT_MIN_CONTAINMENT = 0.85;

const FORMING_MIN_CONTAINMENT = 0.85;
const FORMING_MAX_CONV_RATIO = 0.8;
const FORMING_BREAKOUT_FACTOR = 0.015;
const FORMING_MIN_TOUCHES_PER_LINE = 2;
const FORMING_MIN_TOTAL_TOUCHES = 5;
const FORMING_MIN_TOUCH_SPAN_RATIO = 0.3;

const FORMING_PRICE_TOLERANCE_PCT = 0.01;

// 実効値はバー数。日数は patternBarRange がバー数へ換算する元の値。
const FORMING_WINDOW_MIN_DAYS = 20;
const FORMING_WINDOW_MAX_DAYS = 120;
// 窓の刻みは、削除した回帰経路の最小窓（25 日）の 1/5 のまま。変えると形成中の窓の並びが変わり、検出が動く（#429）。
const WINDOW_STEP_BASE_DAYS = 25;
const WINDOW_STEP_DIVISOR = 5;

export function getWedgeBarParams(tf: string) {
	const forming = patternBarRange(tf, FORMING_WINDOW_MIN_DAYS, FORMING_WINDOW_MAX_DAYS);
	return {
		windowStep: Math.max(1, Math.round(patternMinBars(tf, WINDOW_STEP_BASE_DAYS) / WINDOW_STEP_DIVISOR)),
		formingWindowMin: forming.minBars,
		formingWindowMax: forming.maxBars,
	};
}

type WedgeBarParams = ReturnType<typeof getWedgeBarParams>;

interface PivotData {
	smoothHigh: number[];
	smoothLow: number[];
}

// 物差しは検出のゲートより厳しい strict の基準なので、緩いゲートで拾った分だけ点が下がる（#422）。
function wedgeScore(m: {
	convergenceRatio: number;
	touchCount: number;
	alternation: number;
	containmentRatio: number;
}): { scoreComponents: PatternScoreBreakdown; confidence: number } {
	const convergence = marginUnderGate(m.convergenceRatio, STRICT_MAX_CONVERGENCE);
	const touches = marginOverGate(m.touchCount, STRICT_MIN_TOUCHES_PER_LINE * 2);
	const alternation = marginToOne(m.alternation, MIN_ALTERNATION);
	const containment = marginToOne(m.containmentRatio, STRICT_MIN_CONTAINMENT);
	// 4 軸とも常に数値なので averageDefinedAxes は undefined を返さない（?? には届かない）。
	const base = averageDefinedAxes([convergence, touches, alternation, containment]) ?? convergence;
	return {
		scoreComponents: roundAxes({ convergence, touches, alternation, containment }),
		confidence: finalizeConf(base),
	};
}

function preparePivots(ctx: DetectContext): PivotData {
	// 入力本数で平滑化の幅を変えると limit 次第でピボットが変わるので、固定幅で平滑化する。
	const { smoothHigh, smoothLow } = smoothCandleExtremes(ctx.candles, SG_WINDOW_MAX, 2);
	return { smoothHigh, smoothLow };
}

// ブレイクは形成区間の次の足から探すので、形成区間のタッチ点にブレイク足は混入しない（#281）。
// price は高安で出す。タッチ判定が高安とラインの距離なので、終値だと構成点がトレンドラインに乗らない。
// 外側バーは同じ idx が H と L の両方に入る。重複ではないので dedup しない（detect_triangles と同じ。#141）。
function buildTouchPivots(candles: readonly CandleData[], touches: TouchResult): Pivot[] {
	const pick = (pts: readonly TouchPoint[], kind: 'H' | 'L'): Pivot[] =>
		pts
			.filter((t) => !t.isBreak)
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

	const allPatterns: DeduplicablePattern[] = [];

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

		const fPivots = buildTouchPivots(candles, cleanTouches);

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
	const patterns = detectFormingWedges(preparePivots(ctx), barParams, ctx);
	// 要求外の status を dedup の比較対象に混ぜないよう、dedup より前で落とす。
	const filtered = ctx.includeForming
		? patterns
		: patterns.filter((p) => p.status !== 'forming' && p.status !== 'near_completion');
	return { patterns: deduplicatePatterns(filtered) };
}
