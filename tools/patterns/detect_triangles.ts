/**
 * Triangle detection — swing-point + R²-regression, multi-scale.
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
 * 7. deduplicatePatterns() before returning
 *
 * Pennant (bull_pennant / bear_pennant) は `detect_pennants.ts` で
 * pole-first スキャンとして検出する（このモジュールでは扱わない）。
 */

import { patternBarsCap, structuralFloorBars } from './bar-thresholds.js';
import { barsPerDay, calcATR, deduplicatePatterns, finalizeConf } from './helpers.js';
import { clamp01 } from './regression.js';
import { BREAKOUT_AGAINST_EXPECTATION } from './structural.js';
import { computeTargetReach, omittedTargetReach, type TargetReachResult, targetReachFields } from './target-reach.js';
import type { CandDebugEntry, DetectContext, DetectResult, PatternEntry } from './types.js';

// ---------------------------------------------------------------------------
// Time-frame dependent parameters
//
// `patterns/min-bars.ts` が「時間足 → 最小要求バー数」を導出するのに参照するため export する。
// ---------------------------------------------------------------------------
export function getTriangleParams(tf: string) {
	const bpd = barsPerDay(tf);
	const maxDurationDays = 90; // triangles > 90 days → different pattern
	// 旧実装は `15`（時間足でスケールしないマジックナンバー）だった。三角形の窓は
	// 「その時間足で形が成立する最小の窓」そのものなので、`patterns/bar-thresholds.ts` の
	// 構造的下限をそのまま使う（= 日数 0 日を換算したときの clamp 結果と同じ）。
	const minWindowBars = structuralFloorBars(tf);
	// 上限は日数換算値を使いつつ、`patternBarsCap` を**下駄**として履かせる（頭打ちではない）。
	// `1week` / `1month` では日数換算値（13 本 / 3 本）が minWindowBars を割って windowSizes が
	// 空になるため、下から支える値が要る。逆に intraday の大きな値（1hour で 2160 本）は
	// 害が無い——実際に使うのは `effectiveMax = min(lastIdx - 5, maxWindowBars)` で、
	// 走査窓の長さで必ず頭打ちになる。ここを cap で頭打ちにすると `1hour` の窓が
	// [17, 26] だけになり、40〜84 本の三角形が既定 limit で検出できなくなる。
	const maxWindowBars = Math.max(patternBarsCap(tf), Math.round(maxDurationDays * bpd));
	const minR2 = 0.6; // 収束形状なので多少の揺れは許容 — 0.25 では偽陽性が多すぎた
	// `robustFit` が 1 本のラインから捨ててよい極値の割合の上限（#141）。
	// 0.5 = 「各ラインは自分のアンカー点の半分以上を残すこと」。
	// 実測の根拠と、上下ラインを独立に見る理由は `robustFit` の docstring を参照。
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
 *
 * ## 除去率には呼び出し側で上限を課すこと（#141）
 *
 * このループは `line.r2 >= minR2` になった時点で止まる。つまり**閾値をぎりぎり
 * 超えるまで点を捨てた線**が返りうる。ここでの `minPoints`（= 3）だけでは歯止めに
 * ならない——3 点はほぼ常に直線に乗るので、`minPoints` まで捨てれば R² は自動的に
 * 高くなり、閾値そのものが指標として機能しなくなる。実測でも BTC/JPY 日足 90 本の
 * 上ライン 8 点中 5 点を捨てた候補が `r2Upper = 0.961` を得ている。
 *
 * したがって「何点残ったか」ではなく**「何割捨てたか」**を呼び出し側が
 * `params.maxOutlierRemovalRate` で hard reject する（スコア減点ではない。#131 の
 * 「構造として成立していないものは hard reject」の原則）。
 *
 * ## 上下ラインは独立に判定する
 *
 * 本関数は上ライン（peaks）と下ライン（valleys）で**別々に**呼ばれるので、除去率も
 * ライン単位の量になる。合算した除去率で見ると、当てはまりの良いラインが破綻した
 * ラインを覆い隠す: 実測の走査窓 `1day [15,50]` は peaks 5/8（63%）を捨てているのに
 * valleys が 1/8 なので合算 38% に薄まり、上限 50% を素通りする。この候補の
 * 「水平なレジスタンス」は 8 点中 3 点だけを根拠にしている。
 * よって**どちらか一方でも上限を超えたら候補ごと棄却**する。
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
 * 1 本のラインが外れ値除去に頼りすぎているか。
 *
 * `removed / total > maxRate` で true（= 棄却）。境界は**通す**側に倒してある
 * （`total` が 6 で 3 点除去 = ちょうど 50% は通る）。実測で除去数 1〜4 点の
 * 良質な候補が最大 50%（peaks 3/6）に達しており、strict majority を要求すると
 * それらを巻き添えにするため。
 */
function exceedsRemovalCap(total: number, kept: number, maxRate: number): boolean {
	if (total <= 0) return false;
	return (total - kept) / total > maxRate;
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
// Result construction (scoring, target, entry, debug)
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
	// 本検出器の swing は `relaxedPeaks` / `relaxedValleys`（本ファイル内）で作っており、
	// そこでの `price` は **既に high / low そのもの**（swing.ts の Pivot と違い終値ではない）。
	// したがって「判定に使った極値」は price と同値になる。同値であること自体が
	// 「この検出器は終値を経由していない」という情報なので、別値を捏造せずそのまま入れる。
	//
	// **同じ `idx` が 2 回現れることがある。これは重複ではない**（#141 で「重複」として
	// 報告された件）。配列のキーは `idx` ではなく `(idx, kind)`。本検出器の swing は
	// `swingDepth=1` の relaxed 判定なので、**外側バー**（前後 2 本を包む足）は
	// `high > 前後の high` と `low < 前後の low` を同時に満たし、高値としても安値としても
	// 極値になる。BTC/JPY 日足 90 本の idx=38 が実例で、H 側 10,470,583 / L 側 9,952,759 と
	// **価格が違う 2 件**が入る。dedup すると片方の極値が消えるので**しない**。
	// `touchCount` が 2 と数えるのも同じ理由——その足は上ラインを高値で、下ラインを安値で
	// 実際に触っている。
	const allPivots = [
		...peaks.map((p) => ({ idx: p.idx, price: p.price, kind: 'H' as const, extremePrice: p.price })),
		...valleys.map((p) => ({ idx: p.idx, price: p.price, kind: 'L' as const, extremePrice: p.price })),
	].sort((a, b) => a.idx - b.idx);

	// --- ターゲット価格計算 ---
	const patternHeight = gapStart;
	let breakoutTarget: number | undefined;
	// 未ブレイクでも**理由を名乗る**（#224 症状 2）。`undefined` で初期化すると
	// `targetReachFields` が黙って `{}` に畳み、content から進捗行ごと消える。
	let targetReach: TargetReachResult = omittedTargetReach('not_broken_out');
	const targetMethod: 'pattern_height' | undefined = 'pattern_height';
	if (hasBreakout && breakoutDirection) {
		const bp = candles[breakoutIdx].close;
		breakoutTarget = breakoutDirection === 'up' ? bp + patternHeight : bp - patternHeight;
		breakoutTarget = Math.round(breakoutTarget);
		targetReach = computeTargetReach(candles, breakoutIdx, bp, breakoutTarget, breakoutDirection, patternHeight);
	}

	// --- 用語正規化ラベル ---
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
		// 継続系の `invalid` は「期待と逆方向にブレイクした」の 1 条件しか無い
		// （`determineTriangleStatus`: `hasBreakout && !isExpectedBreakout`）ので、
		// `status` が決まれば理由も決まる。**採否にも `status` にも触らない additive な付与**（issue #291）。
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
			// 除去**率**を出すには分母が要る（#141）。これが無かったため issue の実測は
			// `touchCount` から母数を逆算する必要があった。上限はライン単位なので
			// 上下それぞれの母数を出す。
			peaksTotal: peaks.length,
			valleysTotal: valleys.length,
			breakout: hasBreakout ? { idx: breakoutIdx, direction: breakoutDirection } : null,
			status,
			confidence,
		},
	};

	return { pattern, debug };
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

			// --- 外れ値除去の上限（#141）---
			// `robustFit` は R² が閾値を超えるまで点を捨て続けるので、**捨てた割合**に
			// hard reject を課す。`tryFlatFallback` より前に置くのは、fallback が見るのが
			// 除去後の生き残りだけで、同じ「大半を捨てた」問題をそのまま引き継ぐため。
			const upperExceeds = exceedsRemovalCap(peaks.length, filteredPeaks.length, params.maxOutlierRemovalRate);
			const lowerExceeds = exceedsRemovalCap(valleys.length, filteredValleys.length, params.maxOutlierRemovalRate);
			if (upperExceeds || lowerExceeds) {
				debugCandidates.push({
					// 分類前の棄却なので umbrella ラベル（`poor_trendline_fit` と同じ契約）。
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
					// 分類前の棄却。3 種のどれになりえたかはまだ決まっていないので umbrella ラベルで積む
					// （`candidate-filter.ts` の `CANDIDATE_LABEL_COVERAGE.triangle` が 3 種を覆う）。
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
			//
			// **判定は `want` をゲートに含む（意図的）。** `flatThreshold`(0.03) > `moveThreshold`(0.015)
			// なので `upperFlat` と `upperFalling` は (-0.03, -0.015) で同時に真になりうる。つまり
			// 1 つの窓が複数の分岐条件を満たしうるため、`want` を外すと**選ばれる型が変わる**
			// （= `patterns` 指定の有無で検出結果が変わる）。ここを触ると検出セマンティクスの変更に
			// なるので、`want` ゲートはそのまま維持する。
			let triangleType: 'triangle_ascending' | 'triangle_descending' | 'triangle_symmetrical' | null = null;

			if (wantAsc && upperFlat && lowerRising) {
				triangleType = 'triangle_ascending';
			} else if (wantDesc && upperFalling && lowerFlat) {
				triangleType = 'triangle_descending';
			} else if (wantSym && upperFalling && lowerRising) {
				triangleType = 'triangle_symmetrical';
			}

			if (!triangleType) {
				// **棄却理由は「分類できなかった」と「要求されていない」を区別する。**
				// 上の判定は `want` ゲート込みなので、`triangleType === null` には
				// 「形として成立しない」と「形は成立するが要求外」の 2 種類が混ざる。
				// 後者を `classification_failed` として報告すると、実際には正常に分類できる窓を
				// 「分類失敗」と偽って伝えることになる（`patterns=['triangle_ascending']` に
				// 対称三角形の窓が classification_failed で届く）。
				//
				// そこで `want` を外した分類（= `patterns` 未指定なら何になるか）を別に取り、
				//   - 形が成立する → `type_not_requested` を**具体型ラベル**で積む
				//     （`detect_wedges` の `type_not_requested` と同じ idiom。要求外の型なので
				//      候補フィルタで落ち、要求した型のノイズにならない）
				//   - 形も成立しない → `classification_failed` を umbrella ラベルで積む
				// と振り分ける。**検出結果には触らない**——上の `triangleType` は使い回さない。
				const unrestrictedType =
					upperFlat && lowerRising
						? 'triangle_ascending'
						: upperFalling && lowerFlat
							? 'triangle_descending'
							: upperFalling && lowerRising
								? 'triangle_symmetrical'
								: null;

				debugCandidates.push({
					// 分類前 / 分類不能の棄却は具体型が決まらないので umbrella ラベルで積む。
					// 要求外の棄却だけは型が決まっているので具体型で積む。
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
			});
			patterns.push(pattern);
			debugCandidates.push(debug);
		}
	}

	patterns = deduplicatePatterns(patterns);

	return { patterns };
}
