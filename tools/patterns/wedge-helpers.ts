import type { CandleData, TouchPoint, TouchResult, TrendLine } from './types.js';

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
