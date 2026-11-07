import type { CandleData, TouchPoint, TouchResult, TrendLine, WedgeParams } from './types.js';

// 収束のゲートと convergence の物差しを兼ねる。
export const WEDGE_MAX_CONVERGENCE = 0.7;

export interface WedgeBreakResult {
	detected: boolean;
	breakIdx: number;
	breakIsoTime: string | null;
	breakPrice: number | null;
}

export function detectWedgeBreak(
	candles: CandleData[],
	_wedgeType: 'falling_wedge' | 'rising_wedge',
	upper: { valueAt: (x: number) => number },
	lower: { valueAt: (x: number) => number },
	_startIdx: number,
	endIdx: number,
	lastIdx: number,
	atr: number,
): WedgeBreakResult {
	// 形成区間の内側を再走査すると、後の点で引いた線を過去へ外挿した look-ahead bias になるので、次の足から探す。
	const scanStart = endIdx + 1;
	const scanEnd = Math.min(lastIdx, candles.length - 1);

	let firstBreakIdx = -1;

	// 両方向を見て最初のブレイクを返す。期待方向かどうかは呼び出し側（detect_wedges.ts）が判定する。
	for (let i = scanStart; i <= scanEnd; i++) {
		const close = Number(candles[i]?.close ?? NaN);
		if (!Number.isFinite(close)) continue;

		const uLine = upper.valueAt(i);
		const lLine = lower.valueAt(i);
		if (!Number.isFinite(uLine) || !Number.isFinite(lLine)) continue;

		if (close > uLine + atr * 0.5 || close < lLine - atr * 0.5) {
			firstBreakIdx = i;
			break;
		}
	}

	if (firstBreakIdx !== -1) {
		return {
			detected: true,
			breakIdx: firstBreakIdx,
			breakIsoTime: candles[firstBreakIdx]?.isoTime ?? null,
			breakPrice: Number(candles[firstBreakIdx]?.close ?? NaN),
		};
	}
	return { detected: false, breakIdx: -1, breakIsoTime: null, breakPrice: null };
}

export function generateWindows(
	totalBars: number,
	minSize: number,
	maxSize: number,
	step: number,
): Array<{ startIdx: number; endIdx: number }> {
	const out: Array<{ startIdx: number; endIdx: number }> = [];
	for (let size = minSize; size <= maxSize; size += step) {
		for (let start = 0; start + size < totalBars; start += step) {
			out.push({ startIdx: start, endIdx: start + size });
		}
	}
	return out;
}

export function determineWedgeType(
	slopeHigh: number,
	slopeLow: number,
	params: WedgeParams,
): 'rising_wedge' | 'falling_wedge' | null {
	const minSlope = params?.minSlope ?? 0.0001;
	const ratioMinRising = params?.slopeRatioMinRising ?? 1.2;
	const ratioMinFalling = params?.slopeRatioMinFalling ?? params?.slopeRatioMin ?? 1.15;
	const minWeakerSlopeRatio = params?.minWeakerSlopeRatio ?? 0.3;

	if (slopeHigh > minSlope && slopeLow > minSlope) {
		if (slopeHigh < slopeLow * minWeakerSlopeRatio) return null;
		if (Math.abs(slopeLow) >= Math.abs(slopeHigh) * ratioMinRising) return 'rising_wedge';
	}
	if (slopeHigh < -minSlope && slopeLow < -minSlope) {
		const absHi = Math.abs(slopeHigh);
		const absLo = Math.abs(slopeLow);
		const weakerRatio = Math.min(absHi, absLo) / Math.max(absHi, absLo);
		if (weakerRatio < minWeakerSlopeRatio) return null;
		if (absHi >= absLo * ratioMinFalling) return 'falling_wedge';
		return null;
	}
	const slopeRatio = Math.abs(slopeLow / (slopeHigh || slopeLow * 1e-6));
	if (slopeRatio > 0.9 && slopeRatio < 1.1) return null;
	return null;
}

export interface ApexResult {
	apexIdx: number;
	apexPrice: number;
	isValid: boolean;
	barsToApex: number;
}

export function calcApex(upper: TrendLine, lower: TrendLine, endIdx: number): ApexResult {
	const slopeDiff = upper.slope - lower.slope;
	if (Math.abs(slopeDiff) < 1e-15) {
		return { apexIdx: Infinity, apexPrice: NaN, isValid: false, barsToApex: Infinity };
	}
	const apexIdx = Math.round((lower.intercept - upper.intercept) / slopeDiff);
	const apexPrice = upper.valueAt(apexIdx);
	const barsToApex = apexIdx - endIdx;
	const isValid = barsToApex > 0;
	return { apexIdx, apexPrice, isValid, barsToApex };
}

export function checkContainment(
	candles: CandleData[],
	upper: { valueAt: (x: number) => number },
	lower: { valueAt: (x: number) => number },
	startIdx: number,
	endIdx: number,
	tolerancePct: number = 0.003,
): { closeInsideRatio: number; violations: number; total: number } {
	let inside = 0;
	let total = 0;
	let violations = 0;
	for (let i = startIdx; i <= endIdx; i++) {
		const c = candles[i];
		if (!c) continue;
		total++;
		const close = c.close;
		const u = upper.valueAt(i);
		const l = lower.valueAt(i);
		const tol = Math.abs(u - l) * tolerancePct;
		if (close > u + tol || close < l - tol) {
			violations++;
		} else {
			inside++;
		}
	}
	return { closeInsideRatio: total > 0 ? inside / total : 0, violations, total };
}

export function checkConvergenceEx(upper: TrendLine, lower: TrendLine, startIdx: number, endIdx: number) {
	const gapStart = upper.valueAt(startIdx) - lower.valueAt(startIdx);
	const gapEnd = upper.valueAt(endIdx) - lower.valueAt(endIdx);
	const ratio = gapEnd / Math.max(1e-12, gapStart);
	return { isConverging: gapEnd > 0 && ratio < WEDGE_MAX_CONVERGENCE, gapStart, gapEnd, ratio };
}

export function evaluateTouchesEx(
	candles: readonly CandleData[],
	upper: Pick<TrendLine, 'valueAt'>,
	lower: Pick<TrendLine, 'valueAt'>,
	startIdx: number,
	endIdx: number,
): TouchResult {
	const touchThresholdPct = 0.005;
	const upperTouches: TouchPoint[] = [],
		lowerTouches: TouchPoint[] = [];
	for (let i = startIdx; i <= endIdx; i++) {
		const c = candles[i];
		if (!c) continue;
		const u = upper.valueAt(i),
			l = lower.valueAt(i);
		const thrUp = Math.abs(u) * touchThresholdPct;
		const distU = Math.abs(c.high - u);
		if (distU < thrUp && c.high <= u + thrUp) upperTouches.push({ index: i, distance: distU, isBreak: false });
		else if (c.high > u + thrUp) upperTouches.push({ index: i, distance: distU, isBreak: true });
		const thrLo = Math.abs(l) * touchThresholdPct;
		const distL = Math.abs(c.low - l);
		if (distL < thrLo && c.low >= l - thrLo) lowerTouches.push({ index: i, distance: distL, isBreak: false });
		else if (c.low < l - thrLo) lowerTouches.push({ index: i, distance: distL, isBreak: true });
	}
	const upQ = upperTouches.filter((t) => !t.isBreak).length;
	const loQ = lowerTouches.filter((t) => !t.isBreak).length;
	return { upperTouches, lowerTouches, upperQuality: upQ, lowerQuality: loQ };
}

export function calcAlternationScoreEx(touches: TouchResult): number {
	const all = [
		...touches.upperTouches.map((t) => ({ ...t, type: 'upper' as const })),
		...touches.lowerTouches.map((t) => ({ ...t, type: 'lower' as const })),
	].sort((a, b) => a.index - b.index);
	if (all.length < 2) return 0;
	let alternations = 0;
	for (let i = 1; i < all.length; i++) {
		if (all[i].type !== all[i - 1].type) alternations++;
	}
	return Math.max(0, Math.min(1, alternations / Math.max(1, all.length - 1)));
}
