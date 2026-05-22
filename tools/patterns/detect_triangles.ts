/**
 * Triangle detection — swing-point + R²-regression, multi-scale.
 * + Trendoscope-style pennant reclassification (2-stage).
 *
 * Architecture:
 * 1. Relaxed swing detection (swingDepth=1) for peaks/valleys
 * 2. Multi-scale sliding window scan (geometric progression ×1.5)
 * 3. R²-based regression on peaks and valleys within each window
 * 4. Classify: ascending (upper ≈ flat, lower rising),
 *              descending (upper falling, lower ≈ flat),
 *              symmetrical (upper falling, lower rising)
 * 5. Convergence check (gap narrows ≥ 10%)
 * 6. Breakout detection with ATR × 0.3 buffer
 * 7. Pole detection: if impulsive move precedes the triangle → reclassify as pennant
 * 8. deduplicatePatterns() before returning
 */

import { barsPerDay, calcATR, deduplicatePatterns, finalizeConf } from './helpers.js';
import { clamp01 } from './regression.js';
import type { CandDebugEntry, DetectContext, DetectResult, PatternEntry } from './types.js';

// ---------------------------------------------------------------------------
// Time-frame dependent parameters
// ---------------------------------------------------------------------------
function getTriangleParams(tf: string) {
	const bpd = barsPerDay(tf);
	const maxDurationDays = 90; // triangles > 90 days → different pattern
	const minWindowBars = 15; // absolute minimum bars
	const maxWindowBars = Math.max(minWindowBars, Math.round(maxDurationDays * bpd));
	const minR2 = 0.6; // 収束形状なので多少の揺れは許容 — 0.25 では偽陽性が多すぎた
	const flatThreshold = 0.03; // |relSlope| < 3% over window → "flat"
	const moveThreshold = 0.015; // |relSlope| > 1.5% over window → "rising/falling"
	const minConvergence = 0.9; // gap must narrow by ≥ 10%

	return { minWindowBars, maxWindowBars, minR2, flatThreshold, moveThreshold, minConvergence };
}

// ---------------------------------------------------------------------------
// Pole detection parameters for pennant reclassification (Trendoscope 2-stage)
// ---------------------------------------------------------------------------
function getPoleParams(tf: string) {
	const bpd = barsPerDay(tf);
	const poleMinBars = Math.max(2, Math.round(1 * bpd));
	const poleMaxBars = Math.max(5, Math.round(15 * bpd));

	const t = String(tf);
	let minPoleATRMult = 1.5;
	let minPolePct = 0.03;
	if (t === '1day') {
		minPoleATRMult = 2.0;
		minPolePct = 0.05;
	}
	if (t === '1week') {
		minPoleATRMult = 2.0;
		minPolePct = 0.06;
	}
	if (t === '1month') {
		minPoleATRMult = 2.5;
		minPolePct = 0.08;
	}
	if (t === '1min' || t === '5min') {
		minPolePct = 0.01;
	}
	if (t === '15min' || t === '30min') {
		minPolePct = 0.015;
	}
	if (t === '1hour') {
		minPolePct = 0.02;
	}

	return { poleMinBars, poleMaxBars, minPoleATRMult, minPolePct };
}

/**
 * Detect if there is an impulsive move (flagpole) immediately before winStart.
 * Returns pole info if found, null otherwise.
 */
function detectPole(
	candles: readonly { open: number; close: number; high: number; low: number; isoTime?: string }[],
	winStart: number,
	tf: string,
): { poleStart: number; poleEnd: number; poleDirection: 'up' | 'down'; atrMult: number; poleHeight: number } | null {
	const pp = getPoleParams(tf);

	let bestPoleStart = -1;
	let bestPoleMag = 0;
	let bestPoleATRMult = 0;

	// Pole ends just before the triangle window starts
	const poleEnd = winStart - 1;
	if (poleEnd < pp.poleMinBars) return null;

	for (let poleLen = pp.poleMinBars; poleLen <= Math.min(pp.poleMaxBars, poleEnd); poleLen++) {
		const ps = poleEnd - poleLen;
		if (ps < 0) continue;
		const startPrice = candles[ps].close;
		const endPrice = candles[poleEnd].close;
		const magnitude = endPrice - startPrice;
		const changePct = Math.abs(magnitude) / Math.max(1e-12, startPrice);

		const localATR = calcATR(candles, Math.max(1, ps), poleEnd, 14);
		if (localATR <= 0) continue;

		const atrMult = Math.abs(magnitude) / localATR;
		if (atrMult < pp.minPoleATRMult || changePct < pp.minPolePct) continue;

		if (atrMult > bestPoleATRMult) {
			bestPoleStart = ps;
			bestPoleMag = magnitude;
			bestPoleATRMult = atrMult;
		}
	}

	if (bestPoleStart < 0) return null;

	// Consolidation (triangle) range should be contained within pole range
	// Skip if triangle is too wide relative to pole
	const poleRange = Math.abs(bestPoleMag);
	const triangleHigh = Math.max(...candles.slice(winStart, winStart + 10).map((c) => c.high));
	const triangleLow = Math.min(...candles.slice(winStart, winStart + 10).map((c) => c.low));
	const triRange = triangleHigh - triangleLow;
	if (triRange > poleRange * 0.9) return null;

	return {
		poleStart: bestPoleStart,
		poleEnd,
		poleDirection: bestPoleMag > 0 ? 'up' : 'down',
		atrMult: bestPoleATRMult,
		poleHeight: poleRange,
	};
}

// ---------------------------------------------------------------------------
// Shared type aliases
// ---------------------------------------------------------------------------
type RegLine = { slope: number; intercept: number; r2: number; valueAt: (x: number) => number };
type SwingPoint = { idx: number; price: number };
type LrWithR2Fn = (pts: Array<{ x: number; y: number }>) => RegLine;

// ---------------------------------------------------------------------------
// Robust regression helpers (extracted from detectTriangles inner function)
// ---------------------------------------------------------------------------

/** Find the index of the point with the largest absolute residual. */
function findWorstResidualIdx(current: readonly SwingPoint[], line: Pick<RegLine, 'valueAt'>): number {
	let worstIdx = 0;
	let worstResidual = 0;
	for (let j = 0; j < current.length; j++) {
		const residual = Math.abs(current[j].price - line.valueAt(current[j].idx));
		if (residual > worstResidual) {
			worstResidual = residual;
			worstIdx = j;
		}
	}
	return worstIdx;
}

/**
 * R²-based regression with robust outlier removal fallback.
 * When initial R² is below threshold, iteratively remove the point
 * with the largest residual and re-fit, keeping at least minPoints.
 */
function robustFit(
	pts: SwingPoint[],
	minPoints: number,
	lrWithR2: LrWithR2Fn,
	minR2: number,
): { line: RegLine; filtered: SwingPoint[] } {
	let current = [...pts];
	let line = lrWithR2(current.map((p) => ({ x: p.idx, y: p.price })));
	const maxRemovals = Math.max(0, pts.length - minPoints);
	for (let r = 0; r < maxRemovals && line.r2 < minR2; r++) {
		const worstIdx = findWorstResidualIdx(current, line);
		current = current.filter((_, j) => j !== worstIdx);
		if (current.length < minPoints) break;
		line = lrWithR2(current.map((p) => ({ x: p.idx, y: p.price })));
	}
	return { line, filtered: current };
}

/**
 * Flat-line fallback: when R² is low but points cluster around the same
 * price level (low relative std deviation), use a horizontal line instead.
 * Critical for descending triangles (flat support) and ascending triangles
 * (flat resistance) where non-monotonic oscillation produces low R².
 */
function tryFlatFallback(line: RegLine, pts: readonly SwingPoint[], minR2: number, flatThreshold: number): RegLine {
	if (line.r2 >= minR2) return line;
	if (pts.length < 3) return line;
	const mean = pts.reduce((s, p) => s + p.price, 0) / pts.length;
	const variance = pts.reduce((s, p) => s + (p.price - mean) ** 2, 0) / pts.length;
	const relStd = Math.sqrt(variance) / mean;
	if (relStd >= flatThreshold) return line;
	return {
		slope: 0,
		intercept: mean,
		r2: clamp01(1 - relStd / flatThreshold),
		valueAt: (_x: number) => mean,
	};
}

// ---------------------------------------------------------------------------
// Breakout detection
// ---------------------------------------------------------------------------
interface BreakoutResult {
	breakoutIdx: number;
	breakoutDirection: 'up' | 'down' | null;
}

/** Scan for triangle breakout (close exceeding trendline + ATR buffer). */
function findTriangleBreakout(
	candles: readonly { close: number }[],
	upperLine: Pick<RegLine, 'valueAt'>,
	lowerLine: Pick<RegLine, 'valueAt'>,
	localATR: number,
	scanStart: number,
	lastIdx: number,
): BreakoutResult {
	for (let i = scanStart; i <= lastIdx; i++) {
		const close = candles[i].close;
		const uVal = upperLine.valueAt(i);
		const lVal = lowerLine.valueAt(i);
		if (close > uVal + localATR * 0.3) {
			return { breakoutIdx: i, breakoutDirection: 'up' };
		}
		if (close < lVal - localATR * 0.3) {
			return { breakoutIdx: i, breakoutDirection: 'down' };
		}
	}
	return { breakoutIdx: -1, breakoutDirection: null };
}

// ---------------------------------------------------------------------------
// Status determination (whipsaw + forming + apex proximity)
// ---------------------------------------------------------------------------
interface StatusResult {
	status: 'completed' | 'invalid' | 'forming' | 'near_completion';
	hasBreakout: boolean;
	breakoutIdx: number;
	breakoutDirection: 'up' | 'down' | null;
	isExpectedBreakout: boolean;
	resultEndIdx: number;
	skip: boolean;
}

function determineTriangleStatus(
	breakout: BreakoutResult,
	candles: readonly { close: number }[],
	upperLine: RegLine,
	lowerLine: RegLine,
	triangleType: 'triangle_ascending' | 'triangle_descending' | 'triangle_symmetrical',
	patternEndIdx: number,
	lastIdx: number,
	winEnd: number,
	windowSize: number,
	includeForming: boolean,
): StatusResult {
	let { breakoutIdx, breakoutDirection } = breakout;
	let hasBreakout = breakoutIdx !== -1;

	// Whipsaw / false-breakout detection: if the breakout occurred but the
	// latest candle's close is back inside the triangle boundaries, treat
	// the breakout as a whipsaw and consider the pattern still forming.
	if (hasBreakout && lastIdx > breakoutIdx) {
		const latestClose = candles[lastIdx].close;
		const uLatest = upperLine.valueAt(lastIdx);
		const lLatest = lowerLine.valueAt(lastIdx);
		if (latestClose > lLatest && latestClose < uLatest) {
			hasBreakout = false;
			breakoutIdx = -1;
			breakoutDirection = null;
		}
	}

	const resultEndIdx = hasBreakout ? breakoutIdx : patternEndIdx;
	const expectedDirection: 'up' | 'down' | null =
		triangleType === 'triangle_ascending' ? 'up' : triangleType === 'triangle_descending' ? 'down' : null;
	const isExpectedBreakout = hasBreakout && (expectedDirection === null || breakoutDirection === expectedDirection);
	const base = { hasBreakout, breakoutIdx, breakoutDirection, isExpectedBreakout, resultEndIdx };

	if (hasBreakout) {
		return { ...base, status: isExpectedBreakout ? 'completed' : 'invalid', skip: false };
	}

	// No breakout — skip old historical patterns that never broke out
	if (lastIdx - winEnd > windowSize * 0.5) {
		return { ...base, status: 'forming', skip: true };
	}

	// Check apex proximity for forming status
	const slopeDiff = upperLine.slope - lowerLine.slope;
	let status: StatusResult['status'] = 'forming';
	if (Math.abs(slopeDiff) > 1e-12) {
		const apexIdx = Math.round((lowerLine.intercept - upperLine.intercept) / slopeDiff);
		const barsToApex = Math.max(0, apexIdx - lastIdx);
		status = barsToApex <= 5 ? 'near_completion' : 'forming';
	}

	const skip = (status === 'forming' || status === 'near_completion') && !includeForming;
	return { ...base, status, skip };
}

// ---------------------------------------------------------------------------
// Pennant reclassification (Trendoscope 2-stage)
// ---------------------------------------------------------------------------
interface PennantInfo {
	poleDirection: 'up' | 'down';
	poleATRMult: number;
	flagpoleHeight: number;
	reclassifiedStartIso: string;
	retracementRatio: number | undefined;
	isTrendContinuation: boolean | undefined;
}

function buildPennantInfo(
	candles: readonly { open: number; close: number; high: number; low: number; isoTime?: string }[],
	peaks: readonly SwingPoint[],
	valleys: readonly SwingPoint[],
	winStart: number,
	startIso: string,
	tf: string,
	hasBreakout: boolean,
	breakoutDirection: 'up' | 'down' | null,
): PennantInfo | null {
	const pole = detectPole(candles, winStart, tf);
	if (!pole) return null;

	let reclassifiedStartIso = startIso;
	const poleStartIso = candles[pole.poleStart]?.isoTime;
	if (poleStartIso) reclassifiedStartIso = poleStartIso;

	// Calculate retracement ratio: how much of the pole move has been retraced
	const poleEndPrice = candles[pole.poleEnd].close;
	const triHigh = Math.max(...peaks.map((p) => p.price));
	const triLow = Math.min(...valleys.map((p) => p.price));

	let retracementRatio: number | undefined;
	if (pole.poleHeight > 0) {
		retracementRatio =
			pole.poleDirection === 'up'
				? (poleEndPrice - triLow) / pole.poleHeight
				: (triHigh - poleEndPrice) / pole.poleHeight;
		retracementRatio = Math.max(0, Math.min(1, retracementRatio));
	}

	// ペナント失敗（ダマシ）は構造的には有効なパターンなので status は 'completed' のまま維持
	// outcome で success/failure を区別する（'invalid' にすると includeInvalid フィルタで除外されてしまう）
	let isTrendContinuation: boolean | undefined;
	if (hasBreakout) {
		isTrendContinuation = pole.poleDirection === breakoutDirection;
	}

	return {
		poleDirection: pole.poleDirection,
		poleATRMult: pole.atrMult,
		flagpoleHeight: pole.poleHeight,
		reclassifiedStartIso,
		retracementRatio,
		isTrendContinuation,
	};
}

// ---------------------------------------------------------------------------
// Result construction (scoring, pennant, target, entry, debug)
// ---------------------------------------------------------------------------
interface TriangleCandidateCtx {
	candles: readonly { open: number; close: number; high: number; low: number; isoTime?: string }[];
	triangleType: 'triangle_ascending' | 'triangle_descending' | 'triangle_symmetrical';
	upperLine: RegLine;
	lowerLine: RegLine;
	upperRelSlope: number;
	lowerRelSlope: number;
	convergenceRatio: number;
	gapStart: number;
	peaks: SwingPoint[];
	valleys: SwingPoint[];
	filteredPeaks: SwingPoint[];
	filteredValleys: SwingPoint[];
	winStart: number;
	winEnd: number;
	startIso: string;
	endIso: string;
	status: StatusResult['status'];
	hasBreakout: boolean;
	breakoutIdx: number;
	breakoutDirection: 'up' | 'down' | null;
	isExpectedBreakout: boolean;
	resultEndIdx: number;
	lastIdx: number;
	wantPennant: boolean;
	tf: string;
}

function buildTriangleResult(c: TriangleCandidateCtx): { pattern: PatternEntry; debug: CandDebugEntry } {
	const {
		candles,
		triangleType,
		upperLine,
		lowerLine,
		upperRelSlope,
		lowerRelSlope,
		convergenceRatio,
		gapStart,
		peaks,
		valleys,
		filteredPeaks,
		filteredValleys,
		winStart,
		winEnd,
		startIso,
		endIso,
		status,
		hasBreakout,
		breakoutIdx,
		breakoutDirection,
		resultEndIdx,
		lastIdx,
		wantPennant,
		tf,
	} = c;

	// --- Neckline for aftermath ---
	const necklineLine =
		triangleType === 'triangle_ascending'
			? upperLine
			: triangleType === 'triangle_descending'
				? lowerLine
				: breakoutDirection === 'down'
					? lowerLine
					: upperLine;
	const neckline = [
		{ x: winStart, y: Number(necklineLine.valueAt(winStart).toFixed(2)) },
		{ x: winEnd, y: Number(necklineLine.valueAt(winEnd).toFixed(2)) },
	];

	// --- Scoring ---
	const fitScore = (upperLine.r2 + lowerLine.r2) / 2;
	const convScore = clamp01((1 - convergenceRatio) / 0.5);
	const touchScore = clamp01((filteredPeaks.length + filteredValleys.length) / 8);
	const symScore =
		triangleType === 'triangle_symmetrical'
			? clamp01(
					1 -
						Math.abs(Math.abs(upperRelSlope) - Math.abs(lowerRelSlope)) /
							Math.max(1e-12, Math.abs(upperRelSlope) + Math.abs(lowerRelSlope)),
				)
			: 0.5;
	const baseScore = fitScore * 0.25 + convScore * 0.25 + touchScore * 0.3 + symScore * 0.2;
	const confidence = finalizeConf(baseScore, triangleType);

	// Pivot points
	const allPivots = [
		...peaks.map((p) => ({ idx: p.idx, price: p.price, kind: 'H' as const })),
		...valleys.map((p) => ({ idx: p.idx, price: p.price, kind: 'L' as const })),
	].sort((a, b) => a.idx - b.idx);

	// --- Pennant reclassification ---
	const pennant = wantPennant
		? buildPennantInfo(candles, peaks, valleys, winStart, startIso, tf, hasBreakout, breakoutDirection)
		: null;
	const finalType: string = pennant ? 'pennant' : triangleType;
	const reclassifiedStartIso = pennant?.reclassifiedStartIso ?? startIso;
	const poleDirection = pennant?.poleDirection;
	const poleATRMult = pennant?.poleATRMult;
	const flagpoleHeight = pennant?.flagpoleHeight;
	const retracementRatio = pennant?.retracementRatio;
	const isTrendContinuation = pennant?.isTrendContinuation;

	// Confidence adjustment for pennants
	let finalConfidence: number;
	if (finalType === 'pennant') {
		let pennantScore = baseScore * 0.9 + clamp01((poleATRMult ?? 0) / 6) * 0.05;
		if (retracementRatio !== undefined && retracementRatio > 0.38) {
			const penalty = Math.min(0.15, (retracementRatio - 0.38) * 0.25);
			pennantScore -= penalty;
		}
		finalConfidence = finalizeConf(Math.max(0, pennantScore), 'pennant');
	} else {
		finalConfidence = confidence;
	}

	// --- ターゲット価格計算 ---
	const patternHeight = gapStart;
	let breakoutTarget: number | undefined;
	let targetReachedPct: number | undefined;
	let targetMethod: 'flagpole_projection' | 'pattern_height' | undefined;
	if (hasBreakout && breakoutDirection) {
		const bp = candles[breakoutIdx].close;
		if (finalType === 'pennant' && flagpoleHeight !== undefined) {
			breakoutTarget = breakoutDirection === 'up' ? bp + flagpoleHeight : bp - flagpoleHeight;
			targetMethod = 'flagpole_projection';
		} else {
			breakoutTarget = breakoutDirection === 'up' ? bp + patternHeight : bp - patternHeight;
			targetMethod = 'pattern_height';
		}
		breakoutTarget = Math.round(breakoutTarget);
		const curPrice = Number(candles[lastIdx]?.close);
		if (Number.isFinite(curPrice) && Math.abs(breakoutTarget - bp) > 1e-12) {
			targetReachedPct = Math.round(((curPrice - bp) / (breakoutTarget - bp)) * 100);
		}
	}

	// --- 用語正規化ラベル ---
	let trendlineLabel: string | undefined;
	if (finalType === 'pennant') {
		trendlineLabel = 'コンソリデーション境界線';
	} else if (triangleType === 'triangle_ascending') {
		trendlineLabel = '上限トレンドライン（レジスタンス）';
	} else if (triangleType === 'triangle_descending') {
		trendlineLabel = '下限トレンドライン（サポート）';
	} else {
		trendlineLabel = 'トレンドライン（ブレイク側）';
	}

	const pattern: PatternEntry = {
		type: finalType,
		confidence: finalConfidence,
		range: { start: reclassifiedStartIso, end: endIso },
		status,
		pivots: allPivots,
		neckline,
		trendlineLabel,
		breakoutDirection: breakoutDirection ?? undefined,
		outcome: hasBreakout
			? finalType === 'pennant'
				? isTrendContinuation
					? 'success'
					: 'failure'
				: status === 'completed'
					? 'success'
					: 'failure'
			: undefined,
		breakoutBarIndex: hasBreakout ? breakoutIdx : undefined,
		...(breakoutTarget !== undefined ? { breakoutTarget, targetMethod } : {}),
		...(targetReachedPct !== undefined ? { targetReachedPct } : {}),
		...(poleDirection
			? {
					poleDirection,
					priorTrendDirection: poleDirection === 'up' ? 'bullish' : 'bearish',
					...(flagpoleHeight !== undefined ? { flagpoleHeight: Math.round(flagpoleHeight) } : {}),
					...(retracementRatio !== undefined ? { retracementRatio: Number(retracementRatio.toFixed(2)) } : {}),
					...(isTrendContinuation !== undefined ? { isTrendContinuation } : {}),
				}
			: {}),
	};

	const debug: CandDebugEntry = {
		type: finalType,
		accepted: true,
		reason: finalType === 'pennant' ? 'reclassified_from_triangle' : 'detected',
		indices: [winStart, resultEndIdx],
		details: {
			convergenceRatio: Number(convergenceRatio.toFixed(3)),
			r2Upper: Number(upperLine.r2.toFixed(3)),
			r2Lower: Number(lowerLine.r2.toFixed(3)),
			upperRelSlope: Number(upperRelSlope.toFixed(4)),
			lowerRelSlope: Number(lowerRelSlope.toFixed(4)),
			touchCount: filteredPeaks.length + filteredValleys.length,
			outlierPeaksRemoved: peaks.length - filteredPeaks.length,
			outlierValleysRemoved: valleys.length - filteredValleys.length,
			breakout: hasBreakout ? { idx: breakoutIdx, direction: breakoutDirection } : null,
			status,
			confidence: finalConfidence,
			...(poleDirection
				? {
						poleDirection,
						poleATRMult: Number((poleATRMult ?? 0).toFixed(2)),
						...(flagpoleHeight !== undefined ? { flagpoleHeight: Math.round(flagpoleHeight) } : {}),
						...(retracementRatio !== undefined ? { retracementRatio: Number(retracementRatio.toFixed(2)) } : {}),
						...(isTrendContinuation !== undefined ? { isTrendContinuation } : {}),
					}
				: {}),
		},
	};

	return { pattern, debug };
}

export function detectTriangles(ctx: DetectContext): DetectResult {
	const { candles, want, includeForming, debugCandidates, lrWithR2 } = ctx;
	const type = ctx.type;
	let patterns: PatternEntry[] = [];

	const wantPennant = want.size === 0 || want.has('pennant');
	const wantAsc = want.size === 0 || want.has('triangle') || want.has('triangle_ascending') || wantPennant;
	const wantDesc = want.size === 0 || want.has('triangle') || want.has('triangle_descending') || wantPennant;
	const wantSym = want.size === 0 || want.has('triangle') || want.has('triangle_symmetrical') || wantPennant;
	if (!wantAsc && !wantDesc && !wantSym) return { patterns: [] };

	const lastIdx = candles.length - 1;
	if (lastIdx < 15) return { patterns: [] };

	const params = getTriangleParams(type);

	// --- Relaxed swing detection (swingDepth=1) ---
	const relaxedPeaks: Array<{ idx: number; price: number }> = [];
	const relaxedValleys: Array<{ idx: number; price: number }> = [];
	for (let i = 1; i < candles.length - 1; i++) {
		const c = candles[i],
			prev = candles[i - 1],
			next = candles[i + 1];
		if (c.high > prev.high && c.high > next.high) {
			relaxedPeaks.push({ idx: i, price: c.high });
		}
		if (c.low < prev.low && c.low < next.low) {
			relaxedValleys.push({ idx: i, price: c.low });
		}
	}

	// --- Generate multi-scale window sizes (geometric ×1.5) ---
	const effectiveMax = Math.min(lastIdx - 5, params.maxWindowBars);
	const windowSizes: number[] = [];
	{
		let w = params.minWindowBars;
		while (w <= effectiveMax) {
			windowSizes.push(Math.round(w));
			w = Math.round(w * 1.5);
		}
	}
	if (!windowSizes.length) return { patterns: [] };

	// --- Sliding window scan ---
	for (const windowSize of windowSizes) {
		const posStep = Math.max(1, Math.floor(windowSize / 6));

		for (let winEnd = windowSize; winEnd <= lastIdx; winEnd += posStep) {
			const winStart = winEnd - windowSize;

			// Collect peaks/valleys in window
			const peaks = relaxedPeaks.filter((p) => p.idx >= winStart && p.idx <= winEnd);
			const valleys = relaxedValleys.filter((p) => p.idx >= winStart && p.idx <= winEnd);

			if (peaks.length < 2 || valleys.length < 2) continue;

			const minPtsForFit = 3;
			let { line: upperLine, filtered: filteredPeaks } = robustFit(peaks, minPtsForFit, lrWithR2, params.minR2);
			let { line: lowerLine, filtered: filteredValleys } = robustFit(valleys, minPtsForFit, lrWithR2, params.minR2);

			upperLine = tryFlatFallback(upperLine, filteredPeaks, params.minR2, params.flatThreshold);
			lowerLine = tryFlatFallback(lowerLine, filteredValleys, params.minR2, params.flatThreshold);

			if (upperLine.r2 < params.minR2 || lowerLine.r2 < params.minR2) {
				debugCandidates.push({
					type: 'triangle_symmetrical',
					accepted: false,
					reason: 'poor_trendline_fit',
					indices: [winStart, winEnd],
					details: {
						r2Upper: Number(upperLine.r2.toFixed(3)),
						r2Lower: Number(lowerLine.r2.toFixed(3)),
						peaksUsed: filteredPeaks.length,
						valleysUsed: filteredValleys.length,
						peaksTotal: peaks.length,
						valleysTotal: valleys.length,
					},
				});
				continue;
			}

			// Convergence check
			const gapStart = upperLine.valueAt(winStart) - lowerLine.valueAt(winStart);
			const gapEnd = upperLine.valueAt(winEnd) - lowerLine.valueAt(winEnd);
			if (gapStart <= 0 || gapEnd <= 0) continue; // lines cross → invalid

			const convergenceRatio = gapEnd / gapStart;
			if (convergenceRatio >= params.minConvergence) continue; // not converging enough

			// Slope classification (relative slope over window)
			// Use filtered points (post outlier-removal) for slope analysis
			const barsSpan = Math.max(1, winEnd - winStart);
			const avgHigh = filteredPeaks.reduce((s, p) => s + p.price, 0) / filteredPeaks.length;
			const avgLow = filteredValleys.reduce((s, p) => s + p.price, 0) / filteredValleys.length;
			const upperRelSlope = (upperLine.slope * barsSpan) / Math.max(1e-12, avgHigh);
			const lowerRelSlope = (lowerLine.slope * barsSpan) / Math.max(1e-12, avgLow);

			// Both meaningfully same direction → likely wedge, skip
			if (upperRelSlope > params.moveThreshold && lowerRelSlope > params.moveThreshold) continue;
			if (upperRelSlope < -params.moveThreshold && lowerRelSlope < -params.moveThreshold) continue;

			const upperFlat = Math.abs(upperRelSlope) < params.flatThreshold;
			const upperFalling = upperRelSlope < -params.moveThreshold;
			const lowerFlat = Math.abs(lowerRelSlope) < params.flatThreshold;
			const lowerRising = lowerRelSlope > params.moveThreshold;

			// Classify
			let triangleType: 'triangle_ascending' | 'triangle_descending' | 'triangle_symmetrical' | null = null;

			if (wantAsc && upperFlat && lowerRising) {
				triangleType = 'triangle_ascending';
			} else if (wantDesc && upperFalling && lowerFlat) {
				triangleType = 'triangle_descending';
			} else if (wantSym && upperFalling && lowerRising) {
				triangleType = 'triangle_symmetrical';
			}

			if (!triangleType) {
				debugCandidates.push({
					type: 'triangle_symmetrical',
					accepted: false,
					reason: 'classification_failed',
					indices: [winStart, winEnd],
					details: {
						upperRelSlope: Number(upperRelSlope.toFixed(4)),
						lowerRelSlope: Number(lowerRelSlope.toFixed(4)),
						convergenceRatio: Number(convergenceRatio.toFixed(3)),
						upperFlat,
						upperFalling,
						lowerFlat,
						lowerRising,
					},
				});
				continue;
			}

			// --- Breakout detection (ATR × 0.3 buffer) ---
			const localATR = calcATR(candles, Math.max(1, winStart), winEnd, 14);

			const patternEndIdx = Math.max(
				filteredPeaks[filteredPeaks.length - 1].idx,
				filteredValleys[filteredValleys.length - 1].idx,
			);

			// Scan for breakout only AFTER the last valid touch point on either trendline.
			// Scanning earlier picks up normal in-pattern oscillations as fake breakouts.
			const scanStart = patternEndIdx + 1;
			let { breakoutIdx, breakoutDirection } = findTriangleBreakout(
				candles,
				upperLine,
				lowerLine,
				localATR,
				scanStart,
				lastIdx,
			);

			const statusResult = determineTriangleStatus(
				{ breakoutIdx, breakoutDirection },
				candles,
				upperLine,
				lowerLine,
				triangleType,
				patternEndIdx,
				lastIdx,
				winEnd,
				windowSize,
				includeForming,
			);
			if (statusResult.skip) continue;
			const { status, hasBreakout, isExpectedBreakout, resultEndIdx } = statusResult;
			({ breakoutIdx, breakoutDirection } = statusResult);

			const startIso = candles[winStart]?.isoTime;
			const endIso = candles[resultEndIdx]?.isoTime;
			if (!startIso || !endIso) continue;

			const { pattern, debug } = buildTriangleResult({
				candles,
				triangleType,
				upperLine,
				lowerLine,
				upperRelSlope,
				lowerRelSlope,
				convergenceRatio,
				gapStart,
				peaks,
				valleys,
				filteredPeaks,
				filteredValleys,
				winStart,
				winEnd,
				startIso,
				endIso,
				status,
				hasBreakout,
				breakoutIdx,
				breakoutDirection,
				isExpectedBreakout,
				resultEndIdx,
				lastIdx,
				wantPennant,
				tf: type,
			});
			patterns.push(pattern);
			debugCandidates.push(debug);
		}
	}

	patterns = deduplicatePatterns(patterns);

	return { patterns };
}
