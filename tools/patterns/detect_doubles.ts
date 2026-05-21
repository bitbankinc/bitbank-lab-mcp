/**
 * Double Top / Double Bottom 検出（完成済み＋形成中）
 * detect_patterns.ts Section 2 から抽出
 */
import { EPSILON } from '../../lib/math.js';
import { generatePatternDiagram } from '../../lib/pattern-diagrams.js';
import { deduplicatePatterns, finalizeConf, periodScoreDays } from './helpers.js';
import { clamp01, marginFromRelDev, relDev } from './regression.js';
import { DOUBLE_LEVEL_MAX_PCT, isSameLevel, validatePriorTrend } from './structural.js';
import type { Pivot } from './swing.js';
import { type CandleData, type DetectContext, type DetectResult, type PatternEntry, pushCand } from './types.js';

// ── Configuration ──
const MIN_PIVOT_DISTANCE_BARS = 5;
const MIN_PATTERN_HEIGHT_PCT = 0.03;
const MIN_DEPTH_PCT = 0.05;
const BREAKOUT_BUFFER_PCT = 0.015;
const MAX_BARS_FROM_EXTREMUM = 20;
const RELAXED_TOLERANCE_FACTOR = 1.3;
const RELAXED_CONFIDENCE_PENALTY = 0.85;
const MAX_FORMING_DAYS = 90;
const FORMING_PEAK_TOLERANCE_PCT = 0.05;
const FORMING_BASE_COMPLETION = 0.66;
const FORMING_COMPLETION_RANGE = 0.34;
const MIN_FORMING_COMPLETION = 0.4;
const MIN_PATTERN_DAYS = 14;
const FORMING_TOLERANCE_MULTIPLIER = 1.5;
const FORMING_VALLEY_INVALID_PCT = 0.02;

type Pcand = (arg: Parameters<typeof pushCand>[1]) => void;

// ── Helper: ブレイクアウトインデックス検出 ──

function findBreakoutIdx(
	candles: CandleData[],
	afterIdx: number,
	necklinePrice: number,
	direction: 'below' | 'above',
): number {
	const end = Math.min(afterIdx + MAX_BARS_FROM_EXTREMUM + 1, candles.length);
	for (let k = afterIdx + 1; k < end; k++) {
		const closeK = Number(candles[k]?.close ?? NaN);
		if (!Number.isFinite(closeK)) continue;
		if (direction === 'below' && closeK < necklinePrice * (1 - BREAKOUT_BUFFER_PCT)) return k;
		if (direction === 'above' && closeK > necklinePrice * (1 + BREAKOUT_BUFFER_PCT)) return k;
	}
	return -1;
}

// ── Helper: ダブルトップのサイズ検証（不合格理由 or null） ──

function validateTopSize(a: Pivot, b: Pivot, c: Pivot): string | null {
	const heightPct = Math.abs(a.price - b.price) / Math.max(1, Math.max(a.price, b.price));
	if (heightPct < MIN_PATTERN_HEIGHT_PCT) return 'pattern_too_small';
	const peakAvg = (a.price + c.price) / 2;
	const valleyDepthPct = (peakAvg - b.price) / Math.max(1, peakAvg);
	if (valleyDepthPct < MIN_DEPTH_PCT) return 'valley_too_shallow';
	return null;
}

// ── Helper: ダブルボトムのサイズ検証（不合格理由 or null） ──

function validateBottomSize(a: Pivot, b: Pivot, c: Pivot): string | null {
	const heightPct = Math.abs(a.price - b.price) / Math.max(1, Math.max(a.price, b.price));
	if (heightPct < MIN_PATTERN_HEIGHT_PCT) return 'pattern_too_small';
	const valleyAvg = (a.price + c.price) / 2;
	const peakHeightPct = (b.price - valleyAvg) / Math.max(1, valleyAvg);
	if (peakHeightPct < MIN_DEPTH_PCT) return 'peak_too_shallow';
	return null;
}

// ── Helper: relaxed fallback ダブルトップ検索 ──

function findRelaxedDoubleTop(
	pivots: Pivot[],
	candles: CandleData[],
	tolerancePct: number,
	factor: number,
	minDistDB: number,
	pcand: Pcand,
): PatternEntry | null {
	const tolRelax = tolerancePct * factor;
	const nearRelaxed = (x: number, y: number) => Math.abs(x - y) <= Math.max(x, y) * tolRelax;

	for (let i = 0; i < pivots.length - 3; i++) {
		const a = pivots[i],
			b = pivots[i + 1],
			c = pivots[i + 2];
		if (!(a.kind === 'H' && b.kind === 'L' && c.kind === 'H')) continue;
		if (b.idx - a.idx < minDistDB || c.idx - b.idx < minDistDB) continue;

		const sizeReason = validateTopSize(a, b, c);
		if (sizeReason) {
			const reason = sizeReason === 'valley_too_shallow' ? 'valley_too_shallow_relaxed' : sizeReason;
			pcand({ type: 'double_top', accepted: false, reason, idxs: [a.idx, b.idx, c.idx] });
			continue;
		}
		if (!nearRelaxed(a.price, c.price)) {
			pcand({
				type: 'double_top',
				accepted: false,
				reason: 'peaks_not_equal_relaxed',
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'peak1', idx: a.idx, price: a.price },
					{ role: 'peak2', idx: c.idx, price: c.price },
				],
			});
			continue;
		}
		if (!isSameLevel(a.price, c.price, DOUBLE_LEVEL_MAX_PCT)) {
			pcand({
				type: 'double_top',
				accepted: false,
				reason: 'peaks_not_equal_structural',
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'peak1', idx: a.idx, price: a.price },
					{ role: 'peak2', idx: c.idx, price: c.price },
				],
			});
			continue;
		}

		const necklinePrice = b.price;
		const breakoutIdx = findBreakoutIdx(candles, c.idx, necklinePrice, 'below');
		if (breakoutIdx < 0) {
			pcand({
				type: 'double_top',
				accepted: false,
				reason: 'no_breakout_relaxed',
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'peak1', idx: a.idx, price: a.price },
					{ role: 'valley', idx: b.idx, price: b.price },
					{ role: 'peak2', idx: c.idx, price: c.price },
				],
			});
			continue;
		}
		const trend = validatePriorTrend(candles, a.idx, breakoutIdx - a.idx, 'up_or_sideways');
		if (!trend.ok) {
			pcand({
				type: 'double_top',
				accepted: false,
				reason: `prior_trend_mismatch:${trend.classification}`,
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'peak1', idx: a.idx, price: a.price },
					{ role: 'valley', idx: b.idx, price: b.price },
					{ role: 'peak2', idx: c.idx, price: c.price },
				],
			});
			continue;
		}
		if (trend.classification === 'insufficient_data') {
			pcand({
				type: 'double_top',
				accepted: true,
				reason: 'prior_trend_insufficient_data',
				idxs: [a.idx, b.idx, c.idx],
			});
		}

		const start = candles[a.idx].isoTime,
			end = candles[breakoutIdx].isoTime;
		if (!start || !end) continue;

		const neckline = [
			{ x: a.idx, y: necklinePrice },
			{ x: breakoutIdx, y: necklinePrice },
		];
		const tolMargin = marginFromRelDev(relDev(a.price, c.price), tolRelax);
		const symmetry = clamp01(1 - relDev(a.price, c.price));
		const per = periodScoreDays(start, end);
		const base = (tolMargin + symmetry + per) / 3;
		const confidence = finalizeConf(base * RELAXED_CONFIDENCE_PENALTY, 'double_top');
		const diagram = generatePatternDiagram(
			'double_top',
			[
				{ ...a, date: candles[a.idx]?.isoTime },
				{ ...b, date: candles[b.idx]?.isoTime },
				{ ...c, date: candles[c.idx]?.isoTime },
			],
			{ price: necklinePrice },
			{ start, end },
		);
		const dtRelAvgPeak = (a.price + c.price) / 2;
		const dtRelTarget = Math.round(necklinePrice - (dtRelAvgPeak - necklinePrice));

		return {
			type: 'double_top',
			confidence,
			range: { start, end },
			pivots: [a, b, c],
			neckline,
			trendlineLabel: 'ネックライン',
			breakout: { idx: breakoutIdx, price: Number(candles[breakoutIdx]?.close ?? NaN) },
			breakoutBarIndex: breakoutIdx,
			breakoutTarget: dtRelTarget,
			targetMethod: 'neckline_projection' as const,
			structureDiagram: diagram,
			_fallback: `relaxed_double_x${factor}`,
		};
	}
	return null;
}

// ── Helper: relaxed fallback ダブルボトム検索 ──

function findRelaxedDoubleBottom(
	pivots: Pivot[],
	candles: CandleData[],
	tolerancePct: number,
	factor: number,
	minDistDB: number,
	pcand: Pcand,
): PatternEntry | null {
	const tolRelax = tolerancePct * factor;
	const nearRelaxed = (x: number, y: number) => Math.abs(x - y) <= Math.max(x, y) * tolRelax;

	for (let i = 0; i < pivots.length - 3; i++) {
		const a = pivots[i],
			b = pivots[i + 1],
			c = pivots[i + 2];
		if (!(a.kind === 'L' && b.kind === 'H' && c.kind === 'L')) continue;
		if (b.idx - a.idx < minDistDB || c.idx - b.idx < minDistDB) continue;

		const sizeReason = validateBottomSize(a, b, c);
		if (sizeReason) {
			const reason = sizeReason === 'peak_too_shallow' ? 'peak_too_shallow_relaxed' : sizeReason;
			pcand({ type: 'double_bottom', accepted: false, reason, idxs: [a.idx, b.idx, c.idx] });
			continue;
		}
		if (!nearRelaxed(a.price, c.price)) {
			pcand({
				type: 'double_bottom',
				accepted: false,
				reason: 'valleys_not_equal_relaxed',
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'valley1', idx: a.idx, price: a.price },
					{ role: 'valley2', idx: c.idx, price: c.price },
				],
			});
			continue;
		}
		if (!isSameLevel(a.price, c.price, DOUBLE_LEVEL_MAX_PCT)) {
			pcand({
				type: 'double_bottom',
				accepted: false,
				reason: 'valleys_not_equal_structural',
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'valley1', idx: a.idx, price: a.price },
					{ role: 'valley2', idx: c.idx, price: c.price },
				],
			});
			continue;
		}

		const necklinePrice = b.price;
		const breakoutIdx = findBreakoutIdx(candles, c.idx, necklinePrice, 'above');
		if (breakoutIdx < 0) {
			pcand({
				type: 'double_bottom',
				accepted: false,
				reason: 'no_breakout_relaxed',
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'valley1', idx: a.idx, price: a.price },
					{ role: 'peak', idx: b.idx, price: b.price },
					{ role: 'valley2', idx: c.idx, price: c.price },
				],
			});
			continue;
		}
		const trend = validatePriorTrend(candles, a.idx, breakoutIdx - a.idx, 'down_or_sideways');
		if (!trend.ok) {
			pcand({
				type: 'double_bottom',
				accepted: false,
				reason: `prior_trend_mismatch:${trend.classification}`,
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'valley1', idx: a.idx, price: a.price },
					{ role: 'peak', idx: b.idx, price: b.price },
					{ role: 'valley2', idx: c.idx, price: c.price },
				],
			});
			continue;
		}
		if (trend.classification === 'insufficient_data') {
			pcand({
				type: 'double_bottom',
				accepted: true,
				reason: 'prior_trend_insufficient_data',
				idxs: [a.idx, b.idx, c.idx],
			});
		}

		const start = candles[a.idx].isoTime,
			end = candles[breakoutIdx].isoTime;
		if (!start || !end) continue;

		const neckline = [
			{ x: a.idx, y: necklinePrice },
			{ x: breakoutIdx, y: necklinePrice },
		];
		const tolMargin = marginFromRelDev(relDev(a.price, c.price), tolRelax);
		const symmetry = clamp01(1 - relDev(a.price, c.price));
		const per = periodScoreDays(start, end);
		const base = (tolMargin + symmetry + per) / 3;
		const confidence = finalizeConf(base * 0.85, 'double_bottom');
		const diagram = generatePatternDiagram(
			'double_bottom',
			[
				{ ...a, date: candles[a.idx]?.isoTime },
				{ ...b, date: candles[b.idx]?.isoTime },
				{ ...c, date: candles[c.idx]?.isoTime },
			],
			{ price: necklinePrice },
			{ start, end },
		);
		const dbRelAvgValley = (a.price + c.price) / 2;
		const dbRelTarget = Math.round(necklinePrice + (necklinePrice - dbRelAvgValley));

		return {
			type: 'double_bottom',
			confidence,
			range: { start, end },
			pivots: [a, b, c],
			neckline,
			trendlineLabel: 'ネックライン',
			breakout: { idx: breakoutIdx, price: Number(candles[breakoutIdx]?.close ?? NaN) },
			breakoutBarIndex: breakoutIdx,
			breakoutTarget: dbRelTarget,
			targetMethod: 'neckline_projection' as const,
			structureDiagram: diagram,
			_fallback: `relaxed_double_x${factor}`,
		};
	}
	return null;
}

// ── Helper: 形成中ダブルトップ検索 ──

function tryFormingDoubleTop(ctx: DetectContext): PatternEntry | null {
	const { candles, allPeaks, allValleys, want } = ctx;
	if (!(want.size === 0 || want.has('double_top')) || allPeaks.length < 1 || allValleys.length < 1) return null;

	const lastIdx = candles.length - 1;
	const currentPrice = Number(candles[lastIdx]?.close ?? NaN);
	const isoAt = (i: number) => candles[i]?.isoTime || '';

	const lastConfirmedPeak = [...allPeaks].reverse().find((p) => p.idx < lastIdx - 2);
	if (!lastConfirmedPeak) return null;
	const valleyAfterPeak = allValleys.find((v) => v.idx > lastConfirmedPeak.idx && v.idx < lastIdx - 1);
	if (!valleyAfterPeak || valleyAfterPeak.idx <= lastConfirmedPeak.idx) return null;

	const leftPeak = lastConfirmedPeak;
	const valley = valleyAfterPeak;
	const leftPct = currentPrice / Math.max(1, leftPeak.price);
	if (leftPct < 1 - FORMING_PEAK_TOLERANCE_PCT || leftPct > 1 + FORMING_PEAK_TOLERANCE_PCT) return null;
	if (!isSameLevel(currentPrice, leftPeak.price, DOUBLE_LEVEL_MAX_PCT)) return null;
	if (currentPrice <= valley.price) return null;

	const ratio = (currentPrice - valley.price) / Math.max(EPSILON, leftPeak.price - valley.price);
	const progress = Math.max(0, Math.min(1, ratio));
	const completion = Math.min(1, FORMING_BASE_COMPLETION + progress * FORMING_COMPLETION_RANGE);
	if (completion < MIN_FORMING_COMPLETION) return null;

	const formationBars = Math.max(0, lastIdx - leftPeak.idx);
	const daysPerBar = ctx.type === '1day' ? 1 : ctx.type === '1week' ? 7 : 1;
	const patternDays = Math.round(formationBars * daysPerBar);
	if (patternDays < MIN_PATTERN_DAYS || patternDays > MAX_FORMING_DAYS) return null;

	const trend = validatePriorTrend(candles, leftPeak.idx, lastIdx - leftPeak.idx, 'up_or_sideways');
	if (!trend.ok) {
		ctx.debugCandidates.push({
			type: 'double_top',
			accepted: false,
			reason: `prior_trend_mismatch:${trend.classification}`,
			indices: [leftPeak.idx, valley.idx, lastIdx],
			points: [
				{ role: 'peak1', idx: leftPeak.idx, price: leftPeak.price, isoTime: candles[leftPeak.idx]?.isoTime },
				{ role: 'valley', idx: valley.idx, price: valley.price, isoTime: candles[valley.idx]?.isoTime },
				{ role: 'forming_peak', idx: lastIdx, price: currentPrice, isoTime: candles[lastIdx]?.isoTime },
			],
		});
		return null;
	}
	if (trend.classification === 'insufficient_data') {
		ctx.debugCandidates.push({
			type: 'double_top',
			accepted: true,
			reason: 'prior_trend_insufficient_data',
			indices: [leftPeak.idx, valley.idx, lastIdx],
		});
	}

	const neckline = [
		{ x: leftPeak.idx, y: valley.price },
		{ x: lastIdx, y: valley.price },
	];
	const confBase = Math.min(1, Math.max(0, (1 - Math.abs(leftPct - 1)) * 0.6 + progress * 0.4));
	const confidence = Math.round(confBase * 100) / 100;
	const start = isoAt(leftPeak.idx);
	const end = isoAt(lastIdx);
	const formDtTarget = Math.round(valley.price - (leftPeak.price - valley.price));

	return {
		type: 'double_top',
		confidence,
		range: { start, end },
		status: 'forming',
		pivots: [
			{ idx: leftPeak.idx, price: leftPeak.price, kind: 'H' as const },
			{ idx: valley.idx, price: valley.price, kind: 'L' as const },
		],
		neckline,
		trendlineLabel: 'ネックライン',
		breakoutTarget: formDtTarget,
		targetMethod: 'neckline_projection' as const,
		completionPct: Math.round(completion * 100),
		_method: 'forming_double_top',
	};
}

// ── Helper: 形成中ダブルボトム検索 ──

function tryFormingDoubleBottom(ctx: DetectContext): PatternEntry | null {
	const { candles, allPeaks, allValleys, tolerancePct, want } = ctx;
	if (!(want.size === 0 || want.has('double_bottom')) || allValleys.length < 2) return null;

	const lastIdx = candles.length - 1;
	const currentPrice = Number(candles[lastIdx]?.close ?? NaN);
	const isoAt = (i: number) => candles[i]?.isoTime || '';
	const daysPerBar = ctx.type === '1day' ? 1 : ctx.type === '1week' ? 7 : 1;

	const confirmedValleys = allValleys.filter((v) => v.idx < lastIdx - 2);
	if (confirmedValleys.length < 2) return null;

	for (let j = confirmedValleys.length - 1; j >= 1; j--) {
		const rightValley = confirmedValleys[j];
		const leftValley = confirmedValleys[j - 1];
		if (rightValley.idx - leftValley.idx < MIN_PIVOT_DISTANCE_BARS) continue;

		const peaksBetween = allPeaks.filter((p) => p.idx > leftValley.idx && p.idx < rightValley.idx);
		if (!peaksBetween.length) continue;
		const midPeak = peaksBetween.reduce((best, p) => (p.price > best.price ? p : best), peaksBetween[0]);

		const leftDepth = (midPeak.price - leftValley.price) / Math.max(EPSILON, midPeak.price);
		const rightDepth = (midPeak.price - rightValley.price) / Math.max(EPSILON, midPeak.price);
		if (!(leftDepth >= MIN_PATTERN_HEIGHT_PCT && rightDepth >= MIN_PATTERN_HEIGHT_PCT)) continue;

		const valleyDiff =
			Math.abs(leftValley.price - rightValley.price) / Math.max(1, Math.max(leftValley.price, rightValley.price));
		if (valleyDiff > Math.min(tolerancePct * FORMING_TOLERANCE_MULTIPLIER, DOUBLE_LEVEL_MAX_PCT)) continue;
		if (currentPrice < rightValley.price * (1 - FORMING_VALLEY_INVALID_PCT)) continue;

		const upRatio = (currentPrice - rightValley.price) / Math.max(EPSILON, midPeak.price - rightValley.price);
		const progress = Math.max(0, Math.min(1, upRatio));
		const completion = Math.min(1, 0.66 + 0.34 * progress);
		if (completion < 0.4) continue;

		const formationBars = Math.max(0, lastIdx - leftValley.idx);
		const patternDays = Math.round(formationBars * daysPerBar);
		if (patternDays < 14 || patternDays > MAX_FORMING_DAYS) continue;

		const trend = validatePriorTrend(candles, leftValley.idx, lastIdx - leftValley.idx, 'down_or_sideways');
		if (!trend.ok) {
			ctx.debugCandidates.push({
				type: 'double_bottom',
				accepted: false,
				reason: `prior_trend_mismatch:${trend.classification}`,
				indices: [leftValley.idx, midPeak.idx, rightValley.idx, lastIdx],
				points: [
					{ role: 'valley1', idx: leftValley.idx, price: leftValley.price, isoTime: candles[leftValley.idx]?.isoTime },
					{ role: 'peak', idx: midPeak.idx, price: midPeak.price, isoTime: candles[midPeak.idx]?.isoTime },
					{
						role: 'valley2',
						idx: rightValley.idx,
						price: rightValley.price,
						isoTime: candles[rightValley.idx]?.isoTime,
					},
				],
			});
			continue;
		}
		if (trend.classification === 'insufficient_data') {
			ctx.debugCandidates.push({
				type: 'double_bottom',
				accepted: true,
				reason: 'prior_trend_insufficient_data',
				indices: [leftValley.idx, midPeak.idx, rightValley.idx, lastIdx],
			});
		}

		const neckline = [
			{ x: midPeak.idx, y: midPeak.price },
			{ x: lastIdx, y: midPeak.price },
		];
		const confidence = Number(Math.min(1, 0.5 + 0.5 * progress).toFixed(2));
		const start = isoAt(leftValley.idx);
		const end = isoAt(lastIdx);
		const formDbAvgValley = (leftValley.price + rightValley.price) / 2;
		const formDbTarget = Math.round(midPeak.price + (midPeak.price - formDbAvgValley));

		return {
			type: 'double_bottom',
			confidence,
			range: { start, end },
			status: 'forming',
			pivots: [
				{ idx: leftValley.idx, price: leftValley.price, kind: 'L' as const },
				{ idx: midPeak.idx, price: midPeak.price, kind: 'H' as const },
				{ idx: rightValley.idx, price: rightValley.price, kind: 'L' as const },
			],
			neckline,
			trendlineLabel: 'ネックライン',
			breakoutTarget: formDbTarget,
			targetMethod: 'neckline_projection' as const,
			completionPct: Math.round(completion * 100),
			_method: 'forming_double_bottom',
		};
	}
	return null;
}

// ── Main ──

export function detectDoubles(ctx: DetectContext): DetectResult {
	const { candles, pivots, tolerancePct, want, includeForming, near } = ctx;
	const pcand: Pcand = (arg) => pushCand(ctx, arg);
	const push = (arr: PatternEntry[], item: PatternEntry) => {
		arr.push(item);
	};
	let patterns: PatternEntry[] = [];

	let foundDoubleTop = false,
		foundDoubleBottom = false;
	if (want.size === 0 || want.has('double_top') || want.has('double_bottom')) {
		const minDistDB = MIN_PIVOT_DISTANCE_BARS;
		for (let i = 0; i < pivots.length - 3; i++) {
			const a = pivots[i];
			const b = pivots[i + 1];
			const c = pivots[i + 2];
			if (b.idx - a.idx < minDistDB || c.idx - b.idx < minDistDB) continue;

			// ── double top: H-L-H ──
			if (a.kind === 'H' && b.kind === 'L' && c.kind === 'H') {
				const sizeReason = validateTopSize(a, b, c);
				if (sizeReason) {
					pcand({ type: 'double_top', accepted: false, reason: sizeReason, idxs: [a.idx, b.idx, c.idx] });
					continue;
				}
				if (!near(a.price, c.price)) {
					const diffPct = Math.abs(a.price - c.price) / Math.max(1, Math.max(a.price, c.price));
					if (diffPct > tolerancePct) {
						pcand({
							type: 'double_top',
							accepted: false,
							reason: 'peaks_not_equal',
							idxs: [a.idx, b.idx, c.idx],
							pts: [
								{ role: 'peak1', idx: a.idx, price: a.price },
								{ role: 'peak2', idx: c.idx, price: c.price },
							],
						});
					}
					continue;
				}
				if (!isSameLevel(a.price, c.price, DOUBLE_LEVEL_MAX_PCT)) {
					pcand({
						type: 'double_top',
						accepted: false,
						reason: 'peaks_not_equal_structural',
						idxs: [a.idx, b.idx, c.idx],
						pts: [
							{ role: 'peak1', idx: a.idx, price: a.price },
							{ role: 'peak2', idx: c.idx, price: c.price },
						],
					});
					continue;
				}
				// ネックライン下抜け（終値ベース1.5%バッファ）必須
				const necklinePrice = b.price;
				const breakoutIdx = findBreakoutIdx(candles, c.idx, necklinePrice, 'below');
				if (breakoutIdx < 0) {
					pcand({
						type: 'double_top',
						accepted: false,
						reason: 'no_breakout',
						idxs: [a.idx, b.idx, c.idx],
						pts: [
							{ role: 'peak1', idx: a.idx, price: a.price },
							{ role: 'valley', idx: b.idx, price: b.price },
							{ role: 'peak2', idx: c.idx, price: c.price },
						],
					});
					continue;
				}
				const trend = validatePriorTrend(candles, a.idx, breakoutIdx - a.idx, 'up_or_sideways');
				if (!trend.ok) {
					pcand({
						type: 'double_top',
						accepted: false,
						reason: `prior_trend_mismatch:${trend.classification}`,
						idxs: [a.idx, b.idx, c.idx],
						pts: [
							{ role: 'peak1', idx: a.idx, price: a.price },
							{ role: 'valley', idx: b.idx, price: b.price },
							{ role: 'peak2', idx: c.idx, price: c.price },
						],
					});
					continue;
				}
				if (trend.classification === 'insufficient_data') {
					pcand({
						type: 'double_top',
						accepted: true,
						reason: 'prior_trend_insufficient_data',
						idxs: [a.idx, b.idx, c.idx],
					});
				}
				const start = candles[a.idx].isoTime;
				const end = candles[breakoutIdx].isoTime;
				if (!start || !end) continue;
				const neckline = [
					{ x: a.idx, y: necklinePrice },
					{ x: breakoutIdx, y: necklinePrice },
				];
				const tolMargin = marginFromRelDev(relDev(a.price, c.price), tolerancePct);
				const symmetry = clamp01(1 - relDev(a.price, c.price));
				const per = periodScoreDays(start, end);
				const base = (tolMargin + symmetry + per) / 3;
				const confidence = finalizeConf(base, 'double_top');
				const diagram = generatePatternDiagram(
					'double_top',
					[
						{ ...a, date: candles[a.idx]?.isoTime },
						{ ...b, date: candles[b.idx]?.isoTime },
						{ ...c, date: candles[c.idx]?.isoTime },
					],
					{ price: necklinePrice },
					{ start, end },
				);
				const dtAvgPeak = (a.price + c.price) / 2;
				const dtTarget = Math.round(necklinePrice - (dtAvgPeak - necklinePrice));
				const dtBp = Number(candles[breakoutIdx]?.close ?? NaN);
				let dtTargetPct: number | undefined;
				const dtCurPrice = Number(candles[candles.length - 1]?.close);
				if (Number.isFinite(dtCurPrice) && Number.isFinite(dtBp) && Math.abs(dtTarget - dtBp) > EPSILON) {
					dtTargetPct = Math.round(((dtCurPrice - dtBp) / (dtTarget - dtBp)) * 100);
				}
				push(patterns, {
					type: 'double_top',
					confidence,
					range: { start, end },
					pivots: [a, b, c],
					neckline,
					trendlineLabel: 'ネックライン',
					breakout: { idx: breakoutIdx, price: dtBp },
					breakoutBarIndex: breakoutIdx,
					breakoutTarget: dtTarget,
					targetMethod: 'neckline_projection' as const,
					...(dtTargetPct !== undefined ? { targetReachedPct: dtTargetPct } : {}),
					structureDiagram: diagram,
				});
				foundDoubleTop = true;
				pcand({
					type: 'double_top',
					accepted: true,
					idxs: [a.idx, b.idx, c.idx, breakoutIdx],
					pts: [
						{ role: 'peak1', idx: a.idx, price: a.price },
						{ role: 'valley', idx: b.idx, price: b.price },
						{ role: 'peak2', idx: c.idx, price: c.price },
						{ role: 'breakout', idx: breakoutIdx, price: dtBp },
					],
				});
				continue;
			}

			// ── double bottom: L-H-L ──
			if (a.kind === 'L' && b.kind === 'H' && c.kind === 'L') {
				const sizeReason = validateBottomSize(a, b, c);
				if (sizeReason) {
					pcand({ type: 'double_bottom', accepted: false, reason: sizeReason, idxs: [a.idx, b.idx, c.idx] });
					continue;
				}
				if (!near(a.price, c.price)) {
					const diffPct = Math.abs(a.price - c.price) / Math.max(1, Math.max(a.price, c.price));
					if (diffPct > tolerancePct) {
						pcand({
							type: 'double_bottom',
							accepted: false,
							reason: 'valleys_not_equal',
							idxs: [a.idx, b.idx, c.idx],
							pts: [
								{ role: 'valley1', idx: a.idx, price: a.price },
								{ role: 'valley2', idx: c.idx, price: c.price },
							],
						});
					}
					continue;
				}
				if (!isSameLevel(a.price, c.price, DOUBLE_LEVEL_MAX_PCT)) {
					pcand({
						type: 'double_bottom',
						accepted: false,
						reason: 'valleys_not_equal_structural',
						idxs: [a.idx, b.idx, c.idx],
						pts: [
							{ role: 'valley1', idx: a.idx, price: a.price },
							{ role: 'valley2', idx: c.idx, price: c.price },
						],
					});
					continue;
				}
				// ネックライン突破（終値ベース＋1.5%バッファ）を c 以降で確認
				const necklinePrice = b.price;
				const breakoutIdx = findBreakoutIdx(candles, c.idx, necklinePrice, 'above');
				if (breakoutIdx < 0) {
					pcand({
						type: 'double_bottom',
						accepted: false,
						reason: 'no_breakout',
						idxs: [a.idx, b.idx, c.idx],
						pts: [
							{ role: 'valley1', idx: a.idx, price: a.price },
							{ role: 'peak', idx: b.idx, price: b.price },
							{ role: 'valley2', idx: c.idx, price: c.price },
						],
					});
					continue;
				}
				const trend = validatePriorTrend(candles, a.idx, breakoutIdx - a.idx, 'down_or_sideways');
				if (!trend.ok) {
					pcand({
						type: 'double_bottom',
						accepted: false,
						reason: `prior_trend_mismatch:${trend.classification}`,
						idxs: [a.idx, b.idx, c.idx],
						pts: [
							{ role: 'valley1', idx: a.idx, price: a.price },
							{ role: 'peak', idx: b.idx, price: b.price },
							{ role: 'valley2', idx: c.idx, price: c.price },
						],
					});
					continue;
				}
				if (trend.classification === 'insufficient_data') {
					pcand({
						type: 'double_bottom',
						accepted: true,
						reason: 'prior_trend_insufficient_data',
						idxs: [a.idx, b.idx, c.idx],
					});
				}
				const start = candles[a.idx].isoTime;
				const end = candles[breakoutIdx].isoTime;
				if (!start || !end) continue;
				const neckline = [
					{ x: a.idx, y: necklinePrice },
					{ x: breakoutIdx, y: necklinePrice },
				];
				const tolMargin = marginFromRelDev(relDev(a.price, c.price), tolerancePct);
				const symmetry = clamp01(1 - relDev(a.price, c.price));
				const per = periodScoreDays(start, end);
				const base = (tolMargin + symmetry + per) / 3;
				const confidence = finalizeConf(base, 'double_bottom');
				const diagram = generatePatternDiagram(
					'double_bottom',
					[
						{ ...a, date: candles[a.idx]?.isoTime },
						{ ...b, date: candles[b.idx]?.isoTime },
						{ ...c, date: candles[c.idx]?.isoTime },
					],
					{ price: necklinePrice },
					{ start, end },
				);
				const dbAvgValley = (a.price + c.price) / 2;
				const dbTarget = Math.round(necklinePrice + (necklinePrice - dbAvgValley));
				const dbBp = Number(candles[breakoutIdx]?.close ?? NaN);
				let dbTargetPct: number | undefined;
				const dbCurPrice = Number(candles[candles.length - 1]?.close);
				if (Number.isFinite(dbCurPrice) && Number.isFinite(dbBp) && Math.abs(dbTarget - dbBp) > EPSILON) {
					dbTargetPct = Math.round(((dbCurPrice - dbBp) / (dbTarget - dbBp)) * 100);
				}
				push(patterns, {
					type: 'double_bottom',
					confidence,
					range: { start, end },
					pivots: [a, b, c],
					neckline,
					trendlineLabel: 'ネックライン',
					breakout: { idx: breakoutIdx, price: dbBp },
					breakoutBarIndex: breakoutIdx,
					breakoutTarget: dbTarget,
					targetMethod: 'neckline_projection' as const,
					...(dbTargetPct !== undefined ? { targetReachedPct: dbTargetPct } : {}),
					structureDiagram: diagram,
				});
				foundDoubleBottom = true;
				pcand({
					type: 'double_bottom',
					accepted: true,
					idxs: [a.idx, b.idx, c.idx],
					pts: [
						{ role: 'valley1', idx: a.idx, price: a.price },
						{ role: 'peak', idx: b.idx, price: b.price },
						{ role: 'valley2', idx: c.idx, price: c.price },
					],
				});
			}
		}
		// relaxed fallback for double top/bottom: single-stage factor 1.3
		for (const f of [RELAXED_TOLERANCE_FACTOR]) {
			if (!foundDoubleTop && (want.size === 0 || want.has('double_top'))) {
				const result = findRelaxedDoubleTop(pivots, candles, tolerancePct, f, minDistDB, pcand);
				if (result) {
					push(patterns, result);
					foundDoubleTop = true;
				}
			}
			if (!foundDoubleBottom && (want.size === 0 || want.has('double_bottom'))) {
				const result = findRelaxedDoubleBottom(pivots, candles, tolerancePct, f, minDistDB, pcand);
				if (result) {
					push(patterns, result);
					foundDoubleBottom = true;
				}
			}
		}
		// --- 重複パターンの排除（patterns/helpers.ts へ抽出済み） ---
		patterns = deduplicatePatterns(patterns);
	}

	// 2b) 形成中ダブルトップ/ボトム
	if (includeForming && (want.size === 0 || want.has('double_top') || want.has('double_bottom'))) {
		const formingTop = tryFormingDoubleTop(ctx);
		if (formingTop) push(patterns, formingTop);
		const formingBottom = tryFormingDoubleBottom(ctx);
		if (formingBottom) push(patterns, formingBottom);
	}

	return { patterns, found: { double_top: foundDoubleTop, double_bottom: foundDoubleBottom } };
}
