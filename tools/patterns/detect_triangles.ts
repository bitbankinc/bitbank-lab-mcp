import { patternBarsCap, structuralFloorBars } from './bar-thresholds.js';
import { barsPerDay, calcATR, deduplicatePatterns, finalizeConf } from './helpers.js';
import { clamp01, robustFit } from './regression.js';
import { BREAKOUT_AGAINST_EXPECTATION } from './structural.js';
import { detectRelaxedSwings } from './swing.js';
import { computeTargetReach, omittedTargetReach, type TargetReachResult, targetReachFields } from './target-reach.js';
import type { CandDebugEntry, DetectContext, DetectResult, PatternEntry } from './types.js';

export function getTriangleParams(tf: string) {
	const bpd = barsPerDay(tf);
	const maxDurationDays = 90; // triangles > 90 days → different pattern
	const minWindowBars = structuralFloorBars(tf);
	// patternBarsCap は頭打ちではなく下駄（Math.max）。頭打ちにすると 1hour の窓が [17, 26] だけになり、40〜84 本の三角形を拾えない。
	const maxWindowBars = Math.max(patternBarsCap(tf), Math.round(maxDurationDays * bpd));
	const minR2 = 0.6; // 収束形状なので多少の揺れは許容 — 0.25 では偽陽性が多すぎた
	const maxOutlierRemovalRate = 0.5;
	const flatThreshold = 0.03; // |relSlope| < 3% over window → "flat"
	const moveThreshold = 0.015; // |relSlope| > 1.5% over window → "rising/falling"
	const minConvergence = 0.9; // gap must narrow by ≥ 10%

	return {
		minWindowBars,
		maxWindowBars,
		minR2,
		maxOutlierRemovalRate,
		flatThreshold,
		moveThreshold,
		minConvergence,
	};
}

type RegLine = { slope: number; intercept: number; r2: number; valueAt: (x: number) => number };
type SwingPoint = { idx: number; price: number };
type TriangleType = 'triangle_ascending' | 'triangle_descending' | 'triangle_symmetrical';

// ちょうど上限（6 点中 3 点など）は通す。実測で良質な候補が 50% に達しており、厳密な過半数にすると巻き添えにする。
function exceedsRemovalCap(total: number, kept: number, maxRate: number): boolean {
	if (total <= 0) return false;
	return (total - kept) / total > maxRate;
}

// 水平なラインは非単調に振動すると R² が低く出るので、同じ水準に集まっていれば水平線に置き換える。
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

interface BreakoutResult {
	breakoutIdx: number;
	breakoutDirection: 'up' | 'down' | null;
}

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
	triangleType: TriangleType,
	patternEndIdx: number,
	lastIdx: number,
	winEnd: number,
	windowSize: number,
	includeForming: boolean,
): StatusResult {
	let { breakoutIdx, breakoutDirection } = breakout;
	let hasBreakout = breakoutIdx !== -1;

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

	if (lastIdx - winEnd > windowSize * 0.5) {
		return { ...base, status: 'forming', skip: true };
	}

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

interface TriangleCandidateCtx {
	candles: readonly { open: number; close: number; high: number; low: number; isoTime?: string }[];
	triangleType: TriangleType;
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
	} = c;

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

	// この検出器の swing の price は既に high / low なので、extremePrice は price と同じ値になる。
	// 外側バーは高値と安値の両方で極値になり、同じ idx が H と L で 2 回入る。重複ではないので dedup しない（#141）。
	const allPivots = [
		...peaks.map((p) => ({ idx: p.idx, price: p.price, kind: 'H' as const, extremePrice: p.price })),
		...valleys.map((p) => ({ idx: p.idx, price: p.price, kind: 'L' as const, extremePrice: p.price })),
	].sort((a, b) => a.idx - b.idx);

	const patternHeight = gapStart;
	let breakoutTarget: number | undefined;
	let targetReach: TargetReachResult = omittedTargetReach('not_broken_out');
	const targetMethod: 'pattern_height' | undefined = 'pattern_height';
	if (hasBreakout && breakoutDirection) {
		const bp = candles[breakoutIdx].close;
		breakoutTarget = breakoutDirection === 'up' ? bp + patternHeight : bp - patternHeight;
		breakoutTarget = Math.round(breakoutTarget);
		targetReach = computeTargetReach(candles, breakoutIdx, bp, breakoutTarget, breakoutDirection, patternHeight);
	}

	let trendlineLabel: string | undefined;
	if (triangleType === 'triangle_ascending') {
		trendlineLabel = '上限トレンドライン（レジスタンス）';
	} else if (triangleType === 'triangle_descending') {
		trendlineLabel = '下限トレンドライン（サポート）';
	} else {
		trendlineLabel = 'トレンドライン（ブレイク側）';
	}

	const pattern: PatternEntry = {
		type: triangleType,
		confidence,
		range: { start: startIso, end: endIso },
		status,
		...(status === 'invalid' ? { invalidReason: BREAKOUT_AGAINST_EXPECTATION } : {}),
		pivots: allPivots,
		neckline,
		trendlineLabel,
		breakoutDirection: breakoutDirection ?? undefined,
		outcome: hasBreakout ? (status === 'completed' ? 'success' : 'failure') : undefined,
		breakoutBarIndex: hasBreakout ? breakoutIdx : undefined,
		...(breakoutTarget !== undefined ? { breakoutTarget, targetMethod } : {}),
		...targetReachFields(targetReach),
	};

	const debug: CandDebugEntry = {
		type: triangleType,
		accepted: true,
		reason: 'detected',
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
			peaksTotal: peaks.length,
			valleysTotal: valleys.length,
			breakout: hasBreakout ? { idx: breakoutIdx, direction: breakoutDirection } : null,
			status,
			confidence,
		},
	};

	return { pattern, debug };
}

const ANY_TRIANGLE_TYPE: Record<TriangleType, boolean> = {
	triangle_ascending: true,
	triangle_descending: true,
	triangle_symmetrical: true,
};

// 上から順に試す。順序を変えると、flat と falling が同時に真のときに選ばれる型が変わる。
export function classifyTriangle(
	shape: { upperFlat: boolean; upperFalling: boolean; lowerFlat: boolean; lowerRising: boolean },
	allowed: Record<TriangleType, boolean>,
): TriangleType | null {
	if (allowed.triangle_ascending && shape.upperFlat && shape.lowerRising) return 'triangle_ascending';
	if (allowed.triangle_descending && shape.upperFalling && shape.lowerFlat) return 'triangle_descending';
	if (allowed.triangle_symmetrical && shape.upperFalling && shape.lowerRising) return 'triangle_symmetrical';
	return null;
}

export function detectTriangles(ctx: DetectContext): DetectResult {
	const { candles, want, includeForming, debugCandidates, lrWithR2 } = ctx;
	const type = ctx.type;
	let patterns: PatternEntry[] = [];

	// pennant は detect_pennants.ts で処理。このモジュールは triangle のみ扱う。
	const wantAsc = want.size === 0 || want.has('triangle') || want.has('triangle_ascending');
	const wantDesc = want.size === 0 || want.has('triangle') || want.has('triangle_descending');
	const wantSym = want.size === 0 || want.has('triangle') || want.has('triangle_symmetrical');
	if (!wantAsc && !wantDesc && !wantSym) return { patterns: [] };

	const lastIdx = candles.length - 1;
	if (lastIdx < 15) return { patterns: [] };

	const params = getTriangleParams(type);

	const { peaks: relaxedPeaks, valleys: relaxedValleys } = detectRelaxedSwings(candles);

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

	for (const windowSize of windowSizes) {
		const posStep = Math.max(1, Math.floor(windowSize / 6));

		for (let winEnd = windowSize; winEnd <= lastIdx; winEnd += posStep) {
			const winStart = winEnd - windowSize;

			const peaks = relaxedPeaks.filter((p) => p.idx >= winStart && p.idx <= winEnd);
			const valleys = relaxedValleys.filter((p) => p.idx >= winStart && p.idx <= winEnd);

			if (peaks.length < 2 || valleys.length < 2) continue;

			const minPtsForFit = 3;
			let { line: upperLine, filtered: filteredPeaks } = robustFit(peaks, minPtsForFit, lrWithR2, params.minR2);
			let { line: lowerLine, filtered: filteredValleys } = robustFit(valleys, minPtsForFit, lrWithR2, params.minR2);

			// tryFlatFallback より前に置く。fallback が見るのは除去後に残った点だけなので、同じ問題を引き継ぐ。
			// 除去率は上下のラインで別々に見る。合算すると、当てはまりの良いラインが破綻したラインを覆い隠す。
			const upperExceeds = exceedsRemovalCap(peaks.length, filteredPeaks.length, params.maxOutlierRemovalRate);
			const lowerExceeds = exceedsRemovalCap(valleys.length, filteredValleys.length, params.maxOutlierRemovalRate);
			if (upperExceeds || lowerExceeds) {
				debugCandidates.push({
					// 分類前の棄却は型が決まらないので umbrella ラベルで積む（candidate-filter.ts の CANDIDATE_LABEL_COVERAGE.triangle が 3 種を覆う）。
					type: 'triangle',
					accepted: false,
					reason: 'excessive_outlier_removal',
					indices: [winStart, winEnd],
					details: {
						peaksRemoved: peaks.length - filteredPeaks.length,
						peaksTotal: peaks.length,
						valleysRemoved: valleys.length - filteredValleys.length,
						valleysTotal: valleys.length,
						upperRemovalRate: Number(((peaks.length - filteredPeaks.length) / peaks.length).toFixed(3)),
						lowerRemovalRate: Number(((valleys.length - filteredValleys.length) / valleys.length).toFixed(3)),
						maxOutlierRemovalRate: params.maxOutlierRemovalRate,
						exceededSide: upperExceeds && lowerExceeds ? 'both' : upperExceeds ? 'upper' : 'lower',
						r2Upper: Number(upperLine.r2.toFixed(3)),
						r2Lower: Number(lowerLine.r2.toFixed(3)),
					},
				});
				continue;
			}

			upperLine = tryFlatFallback(upperLine, filteredPeaks, params.minR2, params.flatThreshold);
			lowerLine = tryFlatFallback(lowerLine, filteredValleys, params.minR2, params.flatThreshold);

			if (upperLine.r2 < params.minR2 || lowerLine.r2 < params.minR2) {
				debugCandidates.push({
					type: 'triangle',
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

			const gapStart = upperLine.valueAt(winStart) - lowerLine.valueAt(winStart);
			const gapEnd = upperLine.valueAt(winEnd) - lowerLine.valueAt(winEnd);
			if (gapStart <= 0 || gapEnd <= 0) continue; // lines cross → invalid

			const convergenceRatio = gapEnd / gapStart;
			if (convergenceRatio >= params.minConvergence) continue; // not converging enough

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

			const shape = { upperFlat, upperFalling, lowerFlat, lowerRising };
			// want をゲートに含むのは意図的。flat と falling が同時に真になりうるので、want を外すと選ばれる型が変わる。
			const triangleType = classifyTriangle(shape, {
				triangle_ascending: wantAsc,
				triangle_descending: wantDesc,
				triangle_symmetrical: wantSym,
			});

			if (!triangleType) {
				// 要求外の形を classification_failed と報告しないよう、want を外した分類を別に取って type_not_requested と分ける。検出結果には使わない。
				const unrestrictedType = classifyTriangle(shape, ANY_TRIANGLE_TYPE);

				debugCandidates.push({
					type: unrestrictedType ?? 'triangle',
					accepted: false,
					reason: unrestrictedType ? 'type_not_requested' : 'classification_failed',
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

			const localATR = calcATR(candles, Math.max(1, winStart), winEnd, 14);

			const patternEndIdx = Math.max(
				filteredPeaks[filteredPeaks.length - 1].idx,
				filteredValleys[filteredValleys.length - 1].idx,
			);

			// ブレイクは最後のタッチ点より後だけを探す。前から探すとパターン内の振動を偽のブレイクとして拾う。
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
			});
			patterns.push(pattern);
			debugCandidates.push(debug);
		}
	}

	patterns = deduplicatePatterns(patterns);

	return { patterns };
}
