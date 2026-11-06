import { EPSILON } from '../../lib/math.js';
import { generatePatternDiagram } from '../../lib/pattern-diagrams.js';
import { roundPriceAtLevel } from '../../lib/price.js';
import { patternBarRange } from './bar-thresholds.js';
import { finalizeConf, periodScoreDays } from './helpers.js';
import { clamp01, near, relDev } from './regression.js';
import { applyPostBreakoutGates, applyReversalGate, buildStructureGate } from './reversal-gate.js';
import { averageDefinedAxes, breakoutQualityScore, retracementScore } from './scoring.js';
import {
	BREAKOUT_BUFFER_PCT,
	buildPrecedingTrend,
	HS_NECKLINE_MAX_PCT,
	HS_SHOULDER_MAX_PCT,
	isSameLevel,
	necklineSideDetailsFromAt,
	type ReversalSide,
	validateHorizontalNeckline,
	validateMainPointsAgainstNecklineAt,
	validatePatternSize,
	validatePriorTrend,
} from './structural.js';
import type { Pivot } from './swing.js';
import { computeTargetReach, omittedTargetReach, targetReachFields } from './target-reach.js';
import type {
	CandleData,
	DeduplicablePattern,
	DetectContext,
	DetectResult,
	PatternConfirmation,
	PatternScoreBreakdown,
} from './types.js';

const RELAXED_FACTORS = [
	{ shoulder: 1.6, head: 0.6, tag: 'x1.6_0.6' },
	{ shoulder: 2.0, head: 0.4, tag: 'x2.0_0.4' },
] as const;

type RelaxedFactors = (typeof RELAXED_FACTORS)[number];

// V 字の途中（左肩の深さが頭の 7% など）を H&S と読まないための下限。
const HS_MIN_SHOULDER_DEPTH_RATIO = 0.2;

type HsShoulderDepthCheck =
	| { ok: true }
	| {
			ok: false;
			details: Record<string, number>;
	  };

function checkInverseHsShoulderDepth(
	leftShoulder: Pivot,
	neckline1: Pivot,
	head: Pivot,
	neckline2: Pivot,
	rightShoulder: Pivot,
): HsShoulderDepthCheck {
	const necklinePrice = (neckline1.price + neckline2.price) / 2;
	const headDepth = necklinePrice - head.price;
	const leftDepth = neckline1.price - leftShoulder.price;
	const rightDepth = neckline2.price - rightShoulder.price;
	const leftRatio = headDepth > 0 ? leftDepth / headDepth : Number.NaN;
	const rightRatio = headDepth > 0 ? rightDepth / headDepth : Number.NaN;
	if (
		headDepth > 0 &&
		leftDepth >= headDepth * HS_MIN_SHOULDER_DEPTH_RATIO &&
		rightDepth >= headDepth * HS_MIN_SHOULDER_DEPTH_RATIO
	)
		return { ok: true };
	return {
		ok: false,
		details: {
			leftShoulderDepth: leftDepth,
			rightShoulderDepth: rightDepth,
			headDepth,
			leftShoulderDepthRatio: leftRatio,
			rightShoulderDepthRatio: rightRatio,
			minShoulderDepthRatio: HS_MIN_SHOULDER_DEPTH_RATIO,
		},
	};
}

// relaxed の棄却はこの段でだけ記録する。前の段で落ちた窓も次の段で通りうるので、最終的な棄却ではない（#174）。
function isFinalRelaxedStage(factors: RelaxedFactors): boolean {
	return factors === RELAXED_FACTORS[RELAXED_FACTORS.length - 1];
}

const FORMING_RIGHT_TOLERANCE_PCT = 0.08;
const FORMING_MAX_DAYS = 90;
export const FORMING_MIN_DAYS = 21;
// 現行の重みでは completion の最小値が 0.675 なので発火しない。重みを変えたときのためのガード。
export const FORMING_MIN_COMPLETION = 0.4;
// detect_triples.ts と同じ値にそろえている。
const FORMING_MIN_CONFIDENCE = 0.5;

export function getHsFormingBarParams(tf: string): { minBars: number; maxBars: number } {
	return patternBarRange(tf, FORMING_MIN_DAYS, FORMING_MAX_DAYS);
}

// 新しい順に試すことで、limit を増やして窓を広げても、狭い窓で見つかった検出が消えない（#154）。
function headCandidatesNewestFirst<T extends Pivot>(list: readonly T[]): T[] {
	return [...list].sort((a, b) => b.idx - a.idx);
}

function headIsExtremeInSpan(
	sameKindPivots: readonly Pivot[],
	head: Pivot,
	fromIdx: number,
	toIdx: number,
	isTop: boolean,
): boolean {
	return !sameKindPivots.some(
		(p) =>
			p.idx > fromIdx && p.idx < toIdx && p.idx !== head.idx && (isTop ? p.price > head.price : p.price < head.price),
	);
}

// aftermath.ts と同じ値。時間足別にしないことは #249 で確認済み。
const HS_BREAKOUT_MAX_BARS = 30;

type NecklinePt = { x: number; y: number };

// 定義点の外側は延ばさず、近いほうの定義点の水準で止める（#211）。外側には支持・抵抗の根拠が無いため。
export function necklineAt(neckline: NecklinePt[] | undefined, i: number): number {
	if (!Array.isArray(neckline) || neckline.length < 2) return NaN;
	const [a, b] = neckline;
	if (!(Number.isFinite(a?.x) && Number.isFinite(b?.x) && Number.isFinite(a?.y) && Number.isFinite(b?.y))) return NaN;
	if (!Number.isFinite(i)) return NaN;
	if (b.x === a.x) return a.y;
	const clampedI = Math.min(Math.max(a.x, b.x), Math.max(Math.min(a.x, b.x), i));
	return a.y + ((b.y - a.y) * (clampedI - a.x)) / (b.x - a.x);
}

// 高さは頭の真下で測り、投影の起点だけを anchorIdx にする。両方を anchorIdx で測ると傾きのぶん高さが歪む（#208）。
export function necklineProjectionTarget(args: {
	neckline: NecklinePt[];
	anchorIdx: number;
	headIdx: number;
	headPrice: number;
	direction: 'down' | 'up';
	fallbackNecklinePrice: number;
}): number | undefined {
	const { neckline, anchorIdx, direction, fallbackNecklinePrice } = args;
	// 壊れた anchorIdx でも necklineAtOr は fallback の水準を返してしまうので、先に弾く。
	if (!Number.isFinite(anchorIdx)) return undefined;
	const height = necklineProjectionHeight(args);
	if (height === undefined) return undefined;
	const nlAtAnchor = necklineAtOr(neckline, anchorIdx, fallbackNecklinePrice);
	if (!Number.isFinite(nlAtAnchor)) return undefined;
	return roundPriceAtLevel(direction === 'down' ? nlAtAnchor - height : nlAtAnchor + height, nlAtAnchor);
}

function necklineAtOr(neckline: NecklinePt[], i: number, fallback: number): number {
	const v = necklineAt(neckline, i);
	return Number.isFinite(v) ? v : fallback;
}

export function necklineProjectionHeight(args: {
	neckline: NecklinePt[];
	headIdx: number;
	headPrice: number;
	direction: 'down' | 'up';
	fallbackNecklinePrice: number;
}): number | undefined {
	const { neckline, headIdx, headPrice, direction, fallbackNecklinePrice } = args;
	if (!Number.isFinite(headIdx) || !Number.isFinite(headPrice)) return undefined;
	const nlAtHead = necklineAtOr(neckline, headIdx, fallbackNecklinePrice);
	if (!Number.isFinite(nlAtHead)) return undefined;
	const height = direction === 'down' ? headPrice - nlAtHead : nlAtHead - headPrice;
	if (!(height > 0)) return undefined;
	return height;
}

function buildHsScore(opts: {
	shoulders: readonly [number, number];
	headPrice: number;
	shoulderIdxs: readonly [number, number];
	headIdx: number;
	/** relaxed でも strict のゲートを渡す。緩めた閾値で採点すると、緩めたことが整合度に表れないため（#227）。 */
	headProminenceGate: number;
	necklinePrice: number;
	breakoutClose: number;
	/** necklineProjectionHeight と同じ値を渡す。ブレイク足の位置で測ると高さが歪む（#208）。 */
	patternHeight: number | undefined;
	side: ReversalSide;
	retracementRatio?: number;
	durationScore: number;
}): { components: PatternScoreBreakdown; base: number } {
	const [s1, s2] = opts.shoulders;
	const symmetry = clamp01(1 - relDev(s1, s2));
	const headProminence = headProminenceScore(opts.headPrice, opts.shoulders, opts.side, opts.headProminenceGate);
	const timeSymmetry = timeSymmetryScore(opts.shoulderIdxs, opts.headIdx);
	const retracement = retracementScore(opts.retracementRatio);
	const breakoutQuality = breakoutQualityScore(
		opts.necklinePrice,
		opts.breakoutClose,
		opts.patternHeight ?? Number.NaN,
		opts.side,
	);
	const components: PatternScoreBreakdown = {
		symmetry: Number(symmetry.toFixed(4)),
		...(headProminence !== undefined ? { headProminence: Number(headProminence.toFixed(4)) } : {}),
		...(timeSymmetry !== undefined ? { timeSymmetry: Number(timeSymmetry.toFixed(4)) } : {}),
		...(retracement !== undefined ? { retracement: Number(retracement.toFixed(4)) } : {}),
		...(breakoutQuality !== undefined ? { breakoutQuality: Number(breakoutQuality.toFixed(4)) } : {}),
		duration: Number(opts.durationScore.toFixed(4)),
	};
	// 算出できなかった軸は 0 として混ぜず、平均から外す（欠測を減点にしないため）。
	const base =
		averageDefinedAxes([symmetry, headProminence, timeSymmetry, retracement, breakoutQuality, opts.durationScore]) ??
		symmetry;
	return { components, base };
}

function headProminenceScore(
	headPrice: number,
	shoulders: readonly [number, number],
	side: ReversalSide,
	gate: number,
): number | undefined {
	const [s1, s2] = shoulders;
	const ref = side === 'bottom' ? Math.min(s1, s2) : Math.max(s1, s2);
	if (!(ref > 0) || !Number.isFinite(headPrice)) return undefined;
	const prominence = side === 'bottom' ? 1 - headPrice / ref : headPrice / ref - 1;
	if (!(prominence > 0)) return undefined;
	if (!(gate > 0)) return 1;
	return clamp01(1 - gate / prominence);
}

function timeSymmetryScore(shoulderIdxs: readonly [number, number], headIdx: number): number | undefined {
	const [leftIdx, rightIdx] = shoulderIdxs;
	const left = headIdx - leftIdx;
	const right = rightIdx - headIdx;
	if (!(left > 0) || !(right > 0)) return undefined;
	return clamp01(Math.min(left, right) / Math.max(left, right));
}

function findHsBreakoutIdx(
	candles: CandleData[],
	neckline: NecklinePt[],
	rightShoulderIdx: number,
	direction: 'below' | 'above',
): number {
	const end = Math.min(rightShoulderIdx + HS_BREAKOUT_MAX_BARS + 1, candles.length);
	for (let k = rightShoulderIdx + 1; k < end; k++) {
		const closeK = Number(candles[k]?.close ?? NaN);
		if (!Number.isFinite(closeK)) continue;
		const nlPrice = necklineAt(neckline, k);
		if (!Number.isFinite(nlPrice)) continue;
		if (direction === 'below' && closeK < nlPrice * (1 - BREAKOUT_BUFFER_PCT)) return k;
		if (direction === 'above' && closeK > nlPrice * (1 + BREAKOUT_BUFFER_PCT)) return k;
	}
	return -1;
}

type HsCompletionFields = {
	status: 'completed' | 'near_completion';
	confirmation: PatternConfirmation;
	breakout?: { idx: number; price: number };
	breakoutBarIndex?: number;
	breakoutDate?: string;
	breakoutDirection?: 'up' | 'down';
	outcome?: 'success';
	rangeEnd: string;
};

// 未確認でも status を必ず付ける。detect_patterns は status の無いパターンを completed として扱うため。
function buildHsCompletionFields(
	candles: CandleData[],
	breakoutIdx: number,
	direction: 'down' | 'up',
	structureEndIso: string,
): HsCompletionFields | null {
	if (breakoutIdx < 0) {
		return {
			status: 'near_completion',
			confirmation: { type: 'not_confirmed' },
			rangeEnd: structureEndIso,
		};
	}
	const breakoutDate = candles[breakoutIdx]?.isoTime;
	const breakoutPrice = Number(candles[breakoutIdx]?.close ?? NaN);
	if (!breakoutDate || !Number.isFinite(breakoutPrice)) return null;
	return {
		status: 'completed',
		confirmation: {
			type: 'neckline_breakout',
			date: breakoutDate,
			idx: breakoutIdx,
			price: breakoutPrice,
		},
		breakout: { idx: breakoutIdx, price: breakoutPrice },
		breakoutBarIndex: breakoutIdx,
		breakoutDate,
		breakoutDirection: direction === 'down' ? 'down' : 'up',
		outcome: 'success',
		rangeEnd: breakoutDate,
	};
}

/** 候補 5 点窓。`p0`=左肩 / `p1`=谷1 / `p2`=頭 / `p3`=谷2 / `p4`=右肩（逆 H&S は谷↔山が入れ替わる）。 */
interface HsWindow {
	p0: Pivot;
	p1: Pivot;
	p2: Pivot;
	p3: Pivot;
	p4: Pivot;
}

// 病的な入力で探索が発散しないための上限。通常の入力では到達しない。
const HS_MAX_SHOULDER_PAIRS = 5000;

function extremeBetween(list: ReadonlyArray<Pivot>, loIdx: number, hiIdx: number, lower: boolean): Pivot | null {
	let best: Pivot | null = null;
	for (const p of list) {
		if (p.idx <= loIdx) continue;
		if (p.idx >= hiIdx) break;
		if (!best || (lower ? p.price < best.price : p.price > best.price)) best = p;
	}
	return best;
}

// 肩ゲートと違い、時間足別の ctx.hsShoulderMaxPct ではなく固定の HS_SHOULDER_MAX_PCT を使う（#244）。
// ここで落とすと窓が作られず debug に理由が残らないので、緩く通して肩ゲートで落とす。
function outerShoulderOk(
	shoulders: ReadonlyArray<Pivot>,
	shoulder: Pivot,
	loIdx: number,
	hiIdx: number,
	isTop: boolean,
): boolean {
	const outer = extremeBetween(shoulders, loIdx, hiIdx, !isTop);
	if (!outer) return true;
	const beyond = isTop ? outer.price > shoulder.price : outer.price < shoulder.price;
	if (!beyond) return true;
	return isSameLevel(outer.price, shoulder.price, HS_SHOULDER_MAX_PCT);
}

function shouldersNotNearReason(withinTolerance: boolean, withinCap: boolean): string {
	return `shoulders_not_near:${shouldersNotNearSuffix(withinTolerance, withinCap)}`;
}

function shouldersNotNearSuffix(withinTolerance: boolean, withinCap: boolean): 'both' | 'cap' | 'tolerance' {
	if (!withinTolerance && !withinCap) return 'both';
	return withinTolerance ? 'cap' : 'tolerance';
}

function relaxedShouldersNotNearReason(withinTolerance: boolean, withinCap: boolean): string {
	return `relaxed_shoulders_not_near:${shouldersNotNearSuffix(withinTolerance, withinCap)}`;
}

// relaxed では使わない。relaxed は最初に通った窓で打ち切るので、窓を増やすと完成済みの検出が別の窓に置き換わる（#146）。
// 頭が肩を上回らない組だけを落とし、突出の不足は判定側で head_not_higher として残す。
function enumerateHsWindows(ctx: DetectContext, side: 'top' | 'bottom'): HsWindow[] {
	const { pivots, minDist } = ctx;
	const isTop = side === 'top';
	const shoulders = pivots.filter((p) => p.kind === (isTop ? 'H' : 'L'));
	const mids = pivots.filter((p) => p.kind === (isTop ? 'L' : 'H'));
	const windows: HsWindow[] = [];
	let pairs = 0;

	for (let gap = 2; gap < shoulders.length; gap++) {
		for (let i = 0; i + gap < shoulders.length; i++) {
			if (++pairs > HS_MAX_SHOULDER_PAIRS) return windows;
			const p0 = shoulders[i];
			const p4 = shoulders[i + gap];
			const p2 = extremeBetween(shoulders, p0.idx, p4.idx, !isTop);
			if (!p2) continue;
			if (isTop ? !(p2.price > p0.price && p2.price > p4.price) : !(p2.price < p0.price && p2.price < p4.price))
				continue;
			const p1 = extremeBetween(mids, p0.idx, p2.idx, isTop);
			const p3 = extremeBetween(mids, p2.idx, p4.idx, isTop);
			if (!p1 || !p3) continue;
			// 外側に肩より明確に高い肩があれば肩の取り違え。正しい組は別に列挙される。
			if (!outerShoulderOk(shoulders, p0, p0.idx, p1.idx, isTop)) continue;
			if (!outerShoulderOk(shoulders, p4, p3.idx, p4.idx, isTop)) continue;
			if (
				p1.idx - p0.idx < minDist ||
				p2.idx - p1.idx < minDist ||
				p3.idx - p2.idx < minDist ||
				p4.idx - p3.idx < minDist
			)
				continue;
			windows.push({ p0, p1, p2, p3, p4 });
		}
	}
	return windows;
}

interface HsSide {
	type: 'head_and_shoulders' | 'inverse_head_and_shoulders';
	shoulderKind: 'H' | 'L';
	midKind: 'L' | 'H';
	priorTrend: 'up' | 'down';
	breakoutDirection: 'below' | 'above';
	targetDirection: 'down' | 'up';
	headNotBeyondReason: 'head_not_higher' | 'head_not_lower';
	midRoles: readonly [string, string];
	relaxedTag: 'relaxed_hs' | 'relaxed_ihs';
}

const HS_SIDES: Record<ReversalSide, HsSide> = {
	top: {
		type: 'head_and_shoulders',
		shoulderKind: 'H',
		midKind: 'L',
		priorTrend: 'up',
		breakoutDirection: 'below',
		targetDirection: 'down',
		headNotBeyondReason: 'head_not_higher',
		midRoles: ['valley1', 'valley2'],
		relaxedTag: 'relaxed_hs',
	},
	bottom: {
		type: 'inverse_head_and_shoulders',
		shoulderKind: 'L',
		midKind: 'H',
		priorTrend: 'down',
		breakoutDirection: 'above',
		targetDirection: 'up',
		headNotBeyondReason: 'head_not_lower',
		midRoles: ['peak1', 'peak2'],
		relaxedTag: 'relaxed_ihs',
	},
};

// TODO(#413): ダブルは 0.85。そろえるかは検出結果と順位の変わり方を数えてから決める。
const RELAXED_CONFIDENCE_PENALTY = 0.95;

function hsIndices(w: HsWindow): number[] {
	return [w.p0.idx, w.p1.idx, w.p2.idx, w.p3.idx, w.p4.idx];
}

function headBeyondShoulders(side: ReversalSide, w: HsWindow, prominence: number): boolean {
	const { p0, p2, p4 } = w;
	return side === 'top'
		? p2.price > Math.max(p0.price, p4.price) * (1 + prominence)
		: p2.price < Math.min(p0.price, p4.price) * (1 - prominence);
}

function hsShapeDetails(
	ctx: DetectContext,
	w: HsWindow,
	necklineDiffPct: number,
	relaxed?: { factor: number; tolerancePct: number },
): Record<string, number> {
	const { p0, p1, p2, p3, p4 } = w;
	return {
		leftShoulder: p0.price,
		rightShoulder: p4.price,
		shouldersDiff: Math.abs(p0.price - p4.price),
		shouldersDiffPct: relDev(p0.price, p4.price),
		shoulderMaxPct: ctx.hsShoulderMaxPct,
		tolerancePct: ctx.tolerancePct,
		...(relaxed ? { relaxedShoulderFactor: relaxed.factor, relaxedTolerancePct: relaxed.tolerancePct } : {}),
		head: p2.price,
		headProminencePct: ctx.headProminencePct,
		necklineP1: p1.price,
		necklineP3: p3.price,
		necklineDiffPct,
		necklineMaxPct: HS_NECKLINE_MAX_PCT,
	};
}

// TODO: relaxed の H&S / 逆 H&S とも、strict と同じ傾きつきネックラインにするか検討する。
function flatHsNecklineLevel(ctx: DetectContext, side: ReversalSide, w: HsWindow): number {
	const { p0, p1, p2, p3, p4 } = w;
	const mids = side === 'top' ? ctx.allValleys : ctx.allPeaks;
	const pick = (m: Pivot, v: Pivot) => ((side === 'top' ? v.price < m.price : v.price > m.price) ? v : m);
	const between = mids.filter((v) => v.idx > p0.idx && v.idx < p4.idx);
	const post = mids.filter((v) => v.idx > p2.idx);
	const extreme = between.length ? between.reduce(pick) : post.length ? post.reduce(pick) : null;
	if (extreme) return extreme.price;
	return side === 'top' ? Math.min(p1.price, p3.price) : Math.max(p1.price, p3.price);
}

// relaxedFactors が null なら strict。
function buildHsPattern(
	ctx: DetectContext,
	side: ReversalSide,
	w: HsWindow,
	relaxedFactors: RelaxedFactors | null,
): DeduplicablePattern | null {
	const { candles, pivots, headProminencePct, debugCandidates } = ctx;
	const spec = HS_SIDES[side];
	const { type } = spec;
	const { p0, p1, p2, p3, p4 } = w;

	const start = candles[p0.idx].isoTime;
	const end = candles[p4.idx].isoTime;
	if (!start || !end) return null;
	const trend = validatePriorTrend(candles, p0.idx, p4.idx - p0.idx, spec.priorTrend, ctx.priorTrendParams);
	if (!trend.ok) {
		debugCandidates.push({
			type,
			accepted: false,
			reason: `prior_trend_mismatch:${trend.classification}`,
			indices: hsIndices(w),
		});
		return null;
	}
	if (trend.classification === 'insufficient_data') {
		debugCandidates.push({
			type,
			accepted: true,
			reason: 'prior_trend_insufficient_data',
			indices: hsIndices(w),
		});
	}
	const sizeReason = validatePatternSize(side, [p0, p1, p2, p3, p4], ctx.sizeThresholds);
	if (sizeReason) {
		debugCandidates.push({ type, accepted: false, reason: sizeReason, indices: hsIndices(w) });
		return null;
	}
	// TODO(#412): 天井にも肩の深さの判定を入れるか決める。それまで底だけに当てる。
	if (side === 'bottom') {
		const shoulderDepth = checkInverseHsShoulderDepth(p0, p1, p2, p3, p4);
		if (!shoulderDepth.ok) {
			if (!relaxedFactors || isFinalRelaxedStage(relaxedFactors)) {
				debugCandidates.push({
					type,
					accepted: false,
					reason: 'shoulder_depth_insufficient',
					details: shoulderDepth.details,
					indices: hsIndices(w),
				});
			}
			return null;
		}
	}

	// ゲートは左肩より前へ遡るので、strict でも傾いた線ではなく 2 点の平均を水準として渡す。
	const flatLevel = relaxedFactors ? flatHsNecklineLevel(ctx, side, w) : null;
	const neckline =
		flatLevel !== null
			? [
					{ x: p1.idx, y: flatLevel },
					{ x: p3.idx, y: flatLevel },
				]
			: [
					{ x: p1.idx, y: p1.price },
					{ x: p3.idx, y: p3.price },
				];
	const necklineLevel = flatLevel ?? (Number(p1.price) + Number(p3.price)) / 2;

	const gate = applyReversalGate({
		candles,
		pivots,
		side,
		first: p0,
		mid: p1,
		necklinePrice: necklineLevel,
		type,
		indices: hsIndices(w),
		debugCandidates,
	});
	if (!gate) return null;
	const structureGate = buildStructureGate(gate);

	// p1 / p3 はネックラインを引く点なので渡さない。
	const nlAt = (i: number): number => necklineAt(neckline, i);
	const necklineSide = validateMainPointsAgainstNecklineAt(side, [p0, p2, p4], nlAt);
	if (necklineSide.reason) {
		debugCandidates.push({
			type,
			accepted: false,
			reason: necklineSide.reason,
			details: necklineSideDetailsFromAt(nlAt, necklineSide.offenders),
			indices: hsIndices(w),
		});
		return null;
	}

	const breakoutIdx = findHsBreakoutIdx(candles, neckline, p4.idx, spec.breakoutDirection);
	const completion = buildHsCompletionFields(candles, breakoutIdx, spec.targetDirection, end);
	if (!completion) return null;
	const postGate =
		breakoutIdx >= 0
			? applyPostBreakoutGates({
					candles,
					pivots,
					side,
					first: p0,
					mid: p1,
					last: p4,
					breakoutIdx,
					type,
					indices: hsIndices(w),
					debugCandidates,
				})
			: null;
	const rangeEnd = completion.rangeEnd;
	// relaxed では構造図にもブレイク判定と同じ水準を渡す（#226）。
	const diagram = generatePatternDiagram(
		type,
		[
			{ ...p0, date: candles[p0.idx]?.isoTime },
			{ ...p1, date: candles[p1.idx]?.isoTime },
			{ ...p2, date: candles[p2.idx]?.isoTime },
			{ ...p3, date: candles[p3.idx]?.isoTime },
			{ ...p4, date: candles[p4.idx]?.isoTime },
		],
		{ price: necklineLevel },
		{ start, end: rangeEnd },
		{ tz: ctx.tz, type: ctx.type },
	);
	const target = necklineProjectionTarget({
		neckline,
		anchorIdx: breakoutIdx >= 0 ? breakoutIdx : p4.idx,
		headIdx: p2.idx,
		headPrice: p2.price,
		direction: spec.targetDirection,
		fallbackNecklinePrice: necklineLevel,
	});
	const height = necklineProjectionHeight({
		neckline,
		headIdx: p2.idx,
		headPrice: p2.price,
		direction: spec.targetDirection,
		fallbackNecklinePrice: necklineLevel,
	});
	const reach = !completion.breakout
		? omittedTargetReach('not_broken_out')
		: target === undefined || height === undefined
			? omittedTargetReach('no_target')
			: computeTargetReach(candles, breakoutIdx, completion.breakout.price, target, spec.targetDirection, height);
	const precedingTrend = buildPrecedingTrend(candles, trend, p0.idx);

	const { components: scoreComponents, base } = buildHsScore({
		shoulders: [p0.price, p4.price],
		headPrice: p2.price,
		shoulderIdxs: [p0.idx, p4.idx],
		headIdx: p2.idx,
		headProminenceGate: headProminencePct,
		necklinePrice: necklineAt(neckline, breakoutIdx),
		breakoutClose: completion.breakout?.price ?? Number.NaN,
		patternHeight: height,
		side,
		retracementRatio: gate.retracementRatio,
		durationScore: periodScoreDays(start, end),
	});
	const confidence = finalizeConf(relaxedFactors ? base * RELAXED_CONFIDENCE_PENALTY : base, type);

	// invalid の候補は #242 のゲートが棄却として記録済みなので、成功としては記録しない。
	if (!postGate) {
		debugCandidates.push(
			relaxedFactors
				? { type, accepted: true, reason: 'fallback_relaxed', indices: hsIndices(w) }
				: {
						type,
						accepted: true,
						indices: hsIndices(w),
						points: [
							{ role: 'left_shoulder', idx: p0.idx, price: p0.price, isoTime: candles[p0.idx]?.isoTime },
							{ role: spec.midRoles[0], idx: p1.idx, price: p1.price, isoTime: candles[p1.idx]?.isoTime },
							{ role: 'head', idx: p2.idx, price: p2.price, isoTime: candles[p2.idx]?.isoTime },
							{ role: spec.midRoles[1], idx: p3.idx, price: p3.price, isoTime: candles[p3.idx]?.isoTime },
							{ role: 'right_shoulder', idx: p4.idx, price: p4.price, isoTime: candles[p4.idx]?.isoTime },
						],
					},
		);
	}

	return {
		type,
		confidence,
		scoreComponents,
		range: { start, end: rangeEnd },
		structureRange: { start, end },
		status: completion.status,
		confirmation: completion.confirmation,
		...(completion.breakout ? { breakout: completion.breakout } : {}),
		...(completion.breakoutBarIndex !== undefined ? { breakoutBarIndex: completion.breakoutBarIndex } : {}),
		...(completion.breakoutDate ? { breakoutDate: completion.breakoutDate } : {}),
		...(completion.breakoutDirection ? { breakoutDirection: completion.breakoutDirection } : {}),
		...(completion.outcome ? { outcome: completion.outcome } : {}),
		// status より後ろに置く。#242 のゲートに当たると status を invalid で上書きするため。
		...postGate,
		...(precedingTrend ? { precedingTrend } : {}),
		pivots: [p0, p1, p2, p3, p4],
		neckline,
		...(structureGate ? { structureGate } : {}),
		trendlineLabel: 'ネックライン',
		...(target !== undefined ? { breakoutTarget: target, targetMethod: 'neckline_projection' as const } : {}),
		...targetReachFields(reach),
		structureDiagram: diagram,
		...(relaxedFactors ? { _fallback: `${spec.relaxedTag}_${relaxedFactors.tag}` } : {}),
	};
}

function findStrictHs(ctx: DetectContext, side: ReversalSide): { patterns: DeduplicablePattern[]; found: boolean } {
	const { tolerancePct, headProminencePct, debugCandidates } = ctx;
	const spec = HS_SIDES[side];
	const patterns: DeduplicablePattern[] = [];
	let found = false;

	for (const w of enumerateHsWindows(ctx, side)) {
		const { p0, p1, p3, p4 } = w;
		// reason にどちらのゲートで落ちたかを出すため、短絡させずに別々に評価する（#172）。
		const shouldersWithinTolerance = near(p0.price, p4.price, tolerancePct);
		const shouldersWithinCap = isSameLevel(p0.price, p4.price, ctx.hsShoulderMaxPct);
		const shouldersNear = shouldersWithinTolerance && shouldersWithinCap;
		const headBeyond = headBeyondShoulders(side, w, headProminencePct);
		const necklineCheck = validateHorizontalNeckline(p1.price, p3.price, HS_NECKLINE_MAX_PCT);
		if (!(shouldersNear && headBeyond && necklineCheck.ok)) {
			const reason = !shouldersNear
				? shouldersNotNearReason(shouldersWithinTolerance, shouldersWithinCap)
				: !headBeyond
					? spec.headNotBeyondReason
					: 'neckline_not_horizontal';
			debugCandidates.push({
				type: spec.type,
				accepted: false,
				reason,
				details: hsShapeDetails(ctx, w, necklineCheck.diffPct),
				indices: hsIndices(w),
			});
			continue;
		}
		const pattern = buildHsPattern(ctx, side, w, null);
		if (!pattern) continue;
		patterns.push(pattern);
		found = true;
	}

	return { patterns, found };
}

function findRelaxedHs(ctx: DetectContext, side: ReversalSide): DeduplicablePattern | null {
	const { pivots, tolerancePct, headProminencePct, minDist, debugCandidates } = ctx;
	const spec = HS_SIDES[side];
	const { shoulderKind: s, midKind: m } = spec;

	// invalid の候補で走査を止めると後ろの成立する候補まで失われるので、退避して走査を続ける（#242）。
	let terminalFallback: DeduplicablePattern | null = null;

	for (const factors of RELAXED_FACTORS) {
		for (let i = 0; i < pivots.length - 4; i++) {
			const w: HsWindow = { p0: pivots[i], p1: pivots[i + 1], p2: pivots[i + 2], p3: pivots[i + 3], p4: pivots[i + 4] };
			const { p0, p1, p2, p3, p4 } = w;
			if (!(p0.kind === s && p1.kind === m && p2.kind === s && p3.kind === m && p4.kind === s)) continue;
			if (
				p1.idx - p0.idx < minDist ||
				p2.idx - p1.idx < minDist ||
				p3.idx - p2.idx < minDist ||
				p4.idx - p3.idx < minDist
			)
				continue;
			const relaxedTolerancePct = tolerancePct * factors.shoulder;
			const shouldersWithinRelaxedTolerance = relDev(p0.price, p4.price) <= relaxedTolerancePct;
			const shouldersWithinCap = isSameLevel(p0.price, p4.price, ctx.hsShoulderMaxPct);
			const shouldersNearRelaxed = shouldersWithinRelaxedTolerance && shouldersWithinCap;
			const headBeyondRelaxed = headBeyondShoulders(side, w, headProminencePct * factors.head);
			const necklineCheck = validateHorizontalNeckline(p1.price, p3.price, HS_NECKLINE_MAX_PCT);
			if (!(shouldersNearRelaxed && headBeyondRelaxed && necklineCheck.ok)) {
				// 頭で落ちた窓は記録しない。strict の head_not_higher / head_not_lower とほぼ重なり、relaxed 固有の情報が無いため。
				const reason = !shouldersNearRelaxed
					? relaxedShouldersNotNearReason(shouldersWithinRelaxedTolerance, shouldersWithinCap)
					: headBeyondRelaxed && !necklineCheck.ok
						? 'relaxed_neckline_not_horizontal'
						: null;
				if (reason && isFinalRelaxedStage(factors)) {
					debugCandidates.push({
						type: spec.type,
						accepted: false,
						reason,
						details: hsShapeDetails(ctx, w, necklineCheck.diffPct, {
							factor: factors.shoulder,
							tolerancePct: relaxedTolerancePct,
						}),
						indices: hsIndices(w),
					});
				}
				continue;
			}
			const entry = buildHsPattern(ctx, side, w, factors);
			if (!entry) continue;
			if (entry.status === 'invalid') {
				terminalFallback ??= entry;
				continue;
			}
			return entry;
		}
	}
	return terminalFallback;
}

function tryFormingHS(ctx: DetectContext): DeduplicablePattern[] {
	const lastIdx = ctx.candles.length - 1;
	const confirmedPeaks = ctx.allPeaks.filter((p) => p.idx < lastIdx - 2);
	if (confirmedPeaks.length < 2) return [];

	// 頭候補ごとの重複は後段の globalDedup が畳む。
	const out: DeduplicablePattern[] = [];
	for (const head of headCandidatesNewestFirst(confirmedPeaks)) {
		const found = formingHsForHead(ctx, confirmedPeaks, head);
		if (found) out.push(found);
	}
	return out;
}

// 棄却理由は構成点が揃った後でだけ記録する。それより前の脱落は頭候補の数だけ起き、debug の上限を食い潰すため（#155）。
function formingHsForHead(
	ctx: DetectContext,
	confirmedPeaks: readonly Pivot[],
	head: Pivot,
): DeduplicablePattern | null {
	const { candles, pivots, allPeaks, allValleys } = ctx;
	const lastIdx = candles.length - 1;
	const currentPrice = Number(candles[lastIdx]?.close ?? NaN);
	const isoAt = (i: number) => candles[i]?.isoTime || '';
	const formingBars = getHsFormingBarParams(ctx.type);

	const leftCandidates = confirmedPeaks.filter((p) => p.idx < head.idx && head.price > p.price * 1.03);
	if (leftCandidates.length < 1) return null;
	const left = leftCandidates[leftCandidates.length - 1];

	const postHeadValley = allValleys.find((v) => v.idx > head.idx && v.idx < lastIdx - 1);
	if (!postHeadValley) return null;

	const rightPeakCandidates = allPeaks.filter(
		(p) =>
			p.idx > postHeadValley.idx &&
			p.price < head.price &&
			Math.abs(p.price - left.price) / Math.max(EPSILON, left.price) <= FORMING_RIGHT_TOLERANCE_PCT,
	);

	let rightShoulder: Pivot | null = rightPeakCandidates.length
		? rightPeakCandidates[rightPeakCandidates.length - 1]
		: null;
	let isProvisional = false;

	if (!rightShoulder) {
		const nearLeft = Math.abs(currentPrice - left.price) / Math.max(EPSILON, left.price) <= FORMING_RIGHT_TOLERANCE_PCT;
		if (nearLeft && currentPrice < head.price && currentPrice > postHeadValley.price) {
			rightShoulder = { idx: lastIdx, price: currentPrice, kind: 'H', extremePrice: currentPrice };
			isProvisional = true;
		}
	}
	if (!rightShoulder) return null;

	if (!headIsExtremeInSpan(allPeaks, head, left.idx, rightShoulder.idx, true)) {
		ctx.debugCandidates.push({
			type: 'head_and_shoulders',
			accepted: false,
			reason: 'head_not_extreme_in_span',
			indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
			details: { spanFromIdx: left.idx, spanToIdx: rightShoulder.idx, headIdx: head.idx, headPrice: head.price },
		});
		return null;
	}

	const closeness =
		1 - Math.abs(rightShoulder.price - left.price) / Math.max(1e-12, left.price * FORMING_RIGHT_TOLERANCE_PCT);
	const progress = Math.max(0, Math.min(1, closeness));
	const completion = Math.min(1, (0.75 + 0.25 * progress) * (isProvisional ? 0.9 : 1.0));
	if (completion < FORMING_MIN_COMPLETION) {
		ctx.debugCandidates.push({
			type: 'head_and_shoulders',
			accepted: false,
			reason: 'completion_below_min',
			indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
			details: { completion, threshold: FORMING_MIN_COMPLETION },
		});
		return null;
	}

	const formationBars = Math.max(0, rightShoulder.idx - left.idx);
	if (formationBars < formingBars.minBars || formationBars > formingBars.maxBars) {
		ctx.debugCandidates.push({
			type: 'head_and_shoulders',
			accepted: false,
			reason: 'formation_bars_out_of_range',
			indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
			details: { formationBars, minBars: formingBars.minBars, maxBars: formingBars.maxBars },
		});
		return null;
	}

	const trend = validatePriorTrend(candles, left.idx, rightShoulder.idx - left.idx, 'up', ctx.priorTrendParams);
	if (!trend.ok) {
		ctx.debugCandidates.push({
			type: 'head_and_shoulders',
			accepted: false,
			reason: `prior_trend_mismatch:${trend.classification}`,
			indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
		});
		return null;
	}
	if (trend.classification === 'insufficient_data') {
		ctx.debugCandidates.push({
			type: 'head_and_shoulders',
			accepted: true,
			reason: 'prior_trend_insufficient_data',
			indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
		});
	}

	const preHeadValleys = allValleys.filter((v) => v.idx > left.idx && v.idx < head.idx);
	const preHeadValley = preHeadValleys.length
		? preHeadValleys.reduce((best, v) => (v.price < best.price ? v : best), preHeadValleys[0])
		: null;

	const neckline = preHeadValley
		? [
				{ x: preHeadValley.idx, y: preHeadValley.price },
				{ x: postHeadValley.idx, y: postHeadValley.price },
			]
		: [
				{ x: left.idx, y: postHeadValley.price },
				{ x: postHeadValley.idx, y: postHeadValley.price },
			];

	const confBase = Math.min(1, Math.max(0, 0.6 * closeness + 0.4 * progress));
	const confidence = Math.round(confBase * (isProvisional ? 0.9 : 1.0) * 100) / 100;

	if (confidence < FORMING_MIN_CONFIDENCE) {
		ctx.debugCandidates.push({
			type: 'head_and_shoulders',
			accepted: false,
			reason: 'confidence_below_min_forming',
			indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
			details: { confidence, threshold: FORMING_MIN_CONFIDENCE },
		});
		return null;
	}

	const hsSizeReason = validatePatternSize(
		'top',
		preHeadValley ? [left, preHeadValley, head, postHeadValley, rightShoulder] : [head, postHeadValley, rightShoulder],
		ctx.sizeThresholds,
	);
	if (hsSizeReason) {
		ctx.debugCandidates.push({
			type: 'head_and_shoulders',
			accepted: false,
			reason: hsSizeReason,
			indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
		});
		return null;
	}

	const formHsNl = neckline[0].y;

	const gate = applyReversalGate({
		candles,
		pivots,
		side: 'top',
		first: preHeadValley ? left : head,
		mid: preHeadValley ?? postHeadValley,
		necklinePrice: formHsNl,
		type: 'head_and_shoulders',
		indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
		debugCandidates: ctx.debugCandidates,
	});
	if (!gate) return null;
	const structureGate = buildStructureGate(gate);

	const start = isoAt(left.idx);
	const end = isoAt(rightShoulder.idx);

	const formHsTarget = necklineProjectionTarget({
		neckline,
		anchorIdx: rightShoulder.idx,
		headIdx: head.idx,
		headPrice: head.price,
		direction: 'down',
		fallbackNecklinePrice: formHsNl,
	});
	const formHsStructureRange = start && end ? { start, end } : undefined;
	const formHsPrecedingTrend = buildPrecedingTrend(candles, trend, left.idx);

	// indices は棄却エントリと同じ 4 点の並びにそろえ、先行谷は points にだけ載せる。
	ctx.debugCandidates.push({
		type: 'head_and_shoulders',
		accepted: true,
		status: 'forming',
		indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
		points: [
			{ role: 'left_shoulder', idx: left.idx, price: left.price, isoTime: candles[left.idx]?.isoTime },
			...(preHeadValley
				? [
						{
							role: 'pre_head_valley',
							idx: preHeadValley.idx,
							price: preHeadValley.price,
							isoTime: candles[preHeadValley.idx]?.isoTime,
						},
					]
				: []),
			{ role: 'head', idx: head.idx, price: head.price, isoTime: candles[head.idx]?.isoTime },
			{
				role: 'post_head_valley',
				idx: postHeadValley.idx,
				price: postHeadValley.price,
				isoTime: candles[postHeadValley.idx]?.isoTime,
			},
			{
				role: isProvisional ? 'right_shoulder_provisional' : 'right_shoulder',
				idx: rightShoulder.idx,
				price: rightShoulder.price,
				isoTime: candles[rightShoulder.idx]?.isoTime,
			},
		],
		details: {
			confidence,
			completionPct: Math.round(completion * 100),
			method: isProvisional ? 'forming_hs_provisional' : 'forming_hs',
		},
	});

	return {
		type: 'head_and_shoulders',
		confidence,
		range: { start, end },
		...(formHsStructureRange ? { structureRange: formHsStructureRange } : {}),
		confirmation: { type: 'not_confirmed' },
		...(formHsPrecedingTrend ? { precedingTrend: formHsPrecedingTrend } : {}),
		status: 'forming',
		pivots: [
			{ idx: left.idx, price: left.price, kind: 'H' as const, extremePrice: left.extremePrice },
			{ idx: head.idx, price: head.price, kind: 'H' as const, extremePrice: head.extremePrice },
			{
				idx: postHeadValley.idx,
				price: postHeadValley.price,
				kind: 'L' as const,
				extremePrice: postHeadValley.extremePrice,
			},
			{
				idx: rightShoulder.idx,
				price: rightShoulder.price,
				kind: 'H' as const,
				extremePrice: rightShoulder.extremePrice,
			},
		],
		neckline,
		...(structureGate ? { structureGate } : {}),
		trendlineLabel: 'ネックライン',
		...(formHsTarget !== undefined
			? { breakoutTarget: formHsTarget, targetMethod: 'neckline_projection' as const }
			: {}),
		// 進捗を測れない理由を明示する。breakoutTarget だけを出すと LLM が「進捗 0%」と読み違える（#224）。
		...targetReachFields(omittedTargetReach('not_broken_out')),
		completionPct: Math.round(completion * 100),
		_method: isProvisional ? 'forming_hs_provisional' : 'forming_hs',
	};
}

function tryFormingInverseHS(ctx: DetectContext): DeduplicablePattern[] {
	const lastIdx = ctx.candles.length - 1;
	const confirmedValleys = ctx.allValleys.filter((v) => v.idx < lastIdx - 2);
	if (confirmedValleys.length < 2) return [];

	const out: DeduplicablePattern[] = [];
	for (const head of headCandidatesNewestFirst(confirmedValleys)) {
		const found = formingInverseHsForHead(ctx, confirmedValleys, head);
		if (found) out.push(found);
	}
	return out;
}

function formingInverseHsForHead(
	ctx: DetectContext,
	confirmedValleys: readonly Pivot[],
	head: Pivot,
): DeduplicablePattern | null {
	const { candles, pivots, allPeaks, allValleys } = ctx;
	const lastIdx = candles.length - 1;
	const currentPrice = Number(candles[lastIdx]?.close ?? NaN);
	const isoAt = (i: number) => candles[i]?.isoTime || '';
	const formingBars = getHsFormingBarParams(ctx.type);

	const leftCandidates = confirmedValleys.filter((v) => v.idx < head.idx && head.price < v.price * 0.97);
	if (leftCandidates.length < 1) return null;
	const left = leftCandidates[leftCandidates.length - 1];

	const postHeadPeak = allPeaks.find((p) => p.idx > head.idx && p.idx < lastIdx - 1);
	if (!postHeadPeak) return null;

	const rightValleyCandidates = allValleys.filter(
		(v) =>
			v.idx > postHeadPeak.idx &&
			v.price > head.price &&
			Math.abs(v.price - left.price) / Math.max(EPSILON, left.price) <= FORMING_RIGHT_TOLERANCE_PCT,
	);

	let rightShoulder: Pivot | null = rightValleyCandidates.length
		? rightValleyCandidates[rightValleyCandidates.length - 1]
		: null;
	let isProvisional = false;

	if (!rightShoulder) {
		const nearLeft = Math.abs(currentPrice - left.price) / Math.max(EPSILON, left.price) <= FORMING_RIGHT_TOLERANCE_PCT;
		if (nearLeft && currentPrice > head.price && currentPrice < postHeadPeak.price) {
			rightShoulder = { idx: lastIdx, price: currentPrice, kind: 'L', extremePrice: currentPrice };
			isProvisional = true;
		}
	}
	if (!rightShoulder) return null;

	if (!headIsExtremeInSpan(allValleys, head, left.idx, rightShoulder.idx, false)) {
		ctx.debugCandidates.push({
			type: 'inverse_head_and_shoulders',
			accepted: false,
			reason: 'head_not_extreme_in_span',
			indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
			details: { spanFromIdx: left.idx, spanToIdx: rightShoulder.idx, headIdx: head.idx, headPrice: head.price },
		});
		return null;
	}

	const closeness =
		1 - Math.abs(rightShoulder.price - left.price) / Math.max(1e-12, left.price * FORMING_RIGHT_TOLERANCE_PCT);
	const progress = Math.max(0, Math.min(1, closeness));
	const completion = Math.min(1, (0.75 + 0.25 * progress) * (isProvisional ? 0.9 : 1.0));
	if (completion < FORMING_MIN_COMPLETION) {
		ctx.debugCandidates.push({
			type: 'inverse_head_and_shoulders',
			accepted: false,
			reason: 'completion_below_min',
			indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
			details: { completion, threshold: FORMING_MIN_COMPLETION },
		});
		return null;
	}

	const formationBars = Math.max(0, rightShoulder.idx - left.idx);
	if (formationBars < formingBars.minBars || formationBars > formingBars.maxBars) {
		ctx.debugCandidates.push({
			type: 'inverse_head_and_shoulders',
			accepted: false,
			reason: 'formation_bars_out_of_range',
			indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
			details: { formationBars, minBars: formingBars.minBars, maxBars: formingBars.maxBars },
		});
		return null;
	}

	const trend = validatePriorTrend(candles, left.idx, rightShoulder.idx - left.idx, 'down', ctx.priorTrendParams);
	if (!trend.ok) {
		ctx.debugCandidates.push({
			type: 'inverse_head_and_shoulders',
			accepted: false,
			reason: `prior_trend_mismatch:${trend.classification}`,
			indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
		});
		return null;
	}
	if (trend.classification === 'insufficient_data') {
		ctx.debugCandidates.push({
			type: 'inverse_head_and_shoulders',
			accepted: true,
			reason: 'prior_trend_insufficient_data',
			indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
		});
	}

	const preHeadPeaks = allPeaks.filter((p) => p.idx > left.idx && p.idx < head.idx);
	const preHeadPeak = preHeadPeaks.length
		? preHeadPeaks.reduce((best, p) => (p.price > best.price ? p : best), preHeadPeaks[0])
		: null;

	const neckline = preHeadPeak
		? [
				{ x: preHeadPeak.idx, y: preHeadPeak.price },
				{ x: postHeadPeak.idx, y: postHeadPeak.price },
			]
		: [
				{ x: left.idx, y: postHeadPeak.price },
				{ x: postHeadPeak.idx, y: postHeadPeak.price },
			];

	const confBase = Math.min(1, Math.max(0, 0.6 * closeness + 0.4 * progress));
	const confidence = Math.round(confBase * (isProvisional ? 0.9 : 1.0) * 100) / 100;

	if (confidence < FORMING_MIN_CONFIDENCE) {
		ctx.debugCandidates.push({
			type: 'inverse_head_and_shoulders',
			accepted: false,
			reason: 'confidence_below_min_forming',
			indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
			details: { confidence, threshold: FORMING_MIN_CONFIDENCE },
		});
		return null;
	}

	const ihsSizeReason = validatePatternSize(
		'bottom',
		preHeadPeak ? [left, preHeadPeak, head, postHeadPeak, rightShoulder] : [head, postHeadPeak, rightShoulder],
		ctx.sizeThresholds,
	);
	if (ihsSizeReason) {
		ctx.debugCandidates.push({
			type: 'inverse_head_and_shoulders',
			accepted: false,
			reason: ihsSizeReason,
			indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
		});
		return null;
	}

	const formIhsNl = neckline[0].y;

	const gate = applyReversalGate({
		candles,
		pivots,
		side: 'bottom',
		first: preHeadPeak ? left : head,
		mid: preHeadPeak ?? postHeadPeak,
		necklinePrice: formIhsNl,
		type: 'inverse_head_and_shoulders',
		indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
		debugCandidates: ctx.debugCandidates,
	});
	if (!gate) return null;
	const structureGate = buildStructureGate(gate);

	const start = isoAt(left.idx);
	const end = isoAt(rightShoulder.idx);

	const formIhsTarget = necklineProjectionTarget({
		neckline,
		anchorIdx: rightShoulder.idx,
		headIdx: head.idx,
		headPrice: head.price,
		direction: 'up',
		fallbackNecklinePrice: formIhsNl,
	});
	const formIhsStructureRange = start && end ? { start, end } : undefined;
	const formIhsPrecedingTrend = buildPrecedingTrend(candles, trend, left.idx);

	ctx.debugCandidates.push({
		type: 'inverse_head_and_shoulders',
		accepted: true,
		status: 'forming',
		indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
		points: [
			{ role: 'left_shoulder', idx: left.idx, price: left.price, isoTime: candles[left.idx]?.isoTime },
			...(preHeadPeak
				? [
						{
							role: 'pre_head_peak',
							idx: preHeadPeak.idx,
							price: preHeadPeak.price,
							isoTime: candles[preHeadPeak.idx]?.isoTime,
						},
					]
				: []),
			{ role: 'head', idx: head.idx, price: head.price, isoTime: candles[head.idx]?.isoTime },
			{
				role: 'post_head_peak',
				idx: postHeadPeak.idx,
				price: postHeadPeak.price,
				isoTime: candles[postHeadPeak.idx]?.isoTime,
			},
			{
				role: isProvisional ? 'right_shoulder_provisional' : 'right_shoulder',
				idx: rightShoulder.idx,
				price: rightShoulder.price,
				isoTime: candles[rightShoulder.idx]?.isoTime,
			},
		],
		details: {
			confidence,
			completionPct: Math.round(completion * 100),
			method: isProvisional ? 'forming_ihs_provisional' : 'forming_ihs',
		},
	});

	return {
		type: 'inverse_head_and_shoulders',
		confidence,
		range: { start, end },
		...(formIhsStructureRange ? { structureRange: formIhsStructureRange } : {}),
		confirmation: { type: 'not_confirmed' },
		...(formIhsPrecedingTrend ? { precedingTrend: formIhsPrecedingTrend } : {}),
		status: 'forming',
		pivots: [
			{ idx: left.idx, price: left.price, kind: 'L' as const, extremePrice: left.extremePrice },
			{ idx: head.idx, price: head.price, kind: 'L' as const, extremePrice: head.extremePrice },
			{ idx: postHeadPeak.idx, price: postHeadPeak.price, kind: 'H' as const, extremePrice: postHeadPeak.extremePrice },
			{
				idx: rightShoulder.idx,
				price: rightShoulder.price,
				kind: 'L' as const,
				extremePrice: rightShoulder.extremePrice,
			},
		],
		neckline,
		...(structureGate ? { structureGate } : {}),
		trendlineLabel: 'ネックライン',
		...(formIhsTarget !== undefined
			? { breakoutTarget: formIhsTarget, targetMethod: 'neckline_projection' as const }
			: {}),
		...targetReachFields(omittedTargetReach('not_broken_out')),
		completionPct: Math.round(completion * 100),
		_method: isProvisional ? 'forming_ihs_provisional' : 'forming_ihs',
	};
}

export function detectHeadAndShoulders(ctx: DetectContext): DetectResult {
	const { want, includeForming } = ctx;
	const patterns: DeduplicablePattern[] = [];

	let foundInverseHS = false;
	if (want.size === 0 || want.has('inverse_head_and_shoulders')) {
		const result = findStrictHs(ctx, 'bottom');
		patterns.push(...result.patterns);
		foundInverseHS = result.found;
	}

	let foundHS = false;
	if (want.size === 0 || want.has('head_and_shoulders')) {
		const result = findStrictHs(ctx, 'top');
		patterns.push(...result.patterns);
		foundHS = result.found;
	}

	if (!foundHS && (want.size === 0 || want.has('head_and_shoulders'))) {
		const relaxed = findRelaxedHs(ctx, 'top');
		if (relaxed) {
			patterns.push(relaxed);
			foundHS = true;
		}
	}
	if (!foundInverseHS && (want.size === 0 || want.has('inverse_head_and_shoulders'))) {
		const relaxed = findRelaxedHs(ctx, 'bottom');
		if (relaxed) {
			patterns.push(relaxed);
			foundInverseHS = true;
		}
	}

	if (includeForming && (want.size === 0 || want.has('head_and_shoulders'))) {
		patterns.push(...tryFormingHS(ctx));
	}

	if (includeForming && (want.size === 0 || want.has('inverse_head_and_shoulders'))) {
		patterns.push(...tryFormingInverseHS(ctx));
	}

	return { patterns, found: { head_and_shoulders: foundHS, inverse_head_and_shoulders: foundInverseHS } };
}
