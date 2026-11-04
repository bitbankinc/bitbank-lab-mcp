import { EPSILON } from '../../lib/math.js';
import { generatePatternDiagram, type PatternDiagramData } from '../../lib/pattern-diagrams.js';
import { roundPriceAtLevel } from '../../lib/price.js';
import { MIN_CONFIDENCE } from '../patterns/config.js';
import { patternBarRange } from './bar-thresholds.js';
import { finalizeConf, periodScoreBars } from './helpers.js';
import { clamp01, near, relDev } from './regression.js';
import { applyPostBreakoutGates, applyReversalGate, buildStructureGate } from './reversal-gate.js';
import { averageDefinedAxes, breakoutQualityScore, retracementScore } from './scoring.js';
import {
	buildPrecedingTrend,
	findBreakoutIdx,
	formingNecklineSideReason,
	levelSpreadDetailsFrom,
	levelSpreadMetrics,
	necklineSideDetailsFrom,
	type PriorTrendResult,
	type ReversalSide,
	validateLevelSpread,
	validateMainPointsNecklineSide,
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
	PatternPrecedingTrend,
	PatternScoreBreakdown,
} from './types.js';
import { pushCand } from './types.js';

function validateTriplePriorTrend(
	ctx: DetectContext,
	type: 'triple_top' | 'triple_bottom',
	indices: [number, number, number],
): { trend: PriorTrendResult; precedingTrend?: PatternPrecedingTrend } | null {
	const { candles, debugCandidates, priorTrendParams } = ctx;
	const [startIdx, , endIdx] = indices;
	const expected = type === 'triple_top' ? 'up' : 'down';
	const trend = validatePriorTrend(candles, startIdx, endIdx - startIdx, expected, priorTrendParams);
	if (!trend.ok) {
		debugCandidates.push({
			type,
			accepted: false,
			reason: `prior_trend_mismatch:${trend.classification}`,
			indices,
		});
		return null;
	}
	if (trend.classification === 'insufficient_data') {
		debugCandidates.push({ type, accepted: true, reason: 'prior_trend_insufficient_data', indices });
	}
	return { trend, precedingTrend: buildPrecedingTrend(candles, trend, startIdx) };
}

// ネックライン 2 点の水平性はこの 1 本だけで測る。tolerancePct でも測ると常にこちらが律速し、理由コードが効かないつまみを指す（#186）。
const NECKLINE_SLOPE_LIMIT = 0.02;
// 実効値はバー数。日数は getTripleFormingBarParams がバー数へ換算する元の値。
export const FORMING_MIN_DAYS = 21;
const FORMING_MAX_DAYS = 90;

const FORMING_TOLERANCE_MULTIPLIER = 1.2;
const FORMING_MIN_COMPLETION = 0.4;
const FORMING_MIN_CONFIDENCE = 0.5;
// 3 点目が暫定なので、detectPatternsViewsHandler の低信頼ラベル（< 0.6）に入るよう抑える。
const FORMING_MAX_CONFIDENCE = 0.59;
// 形成中に validateLevelSpread を入れていないのは不採用の決定で、未配線ではない（#178）。
const FORMING_LEVEL_SPREAD_FACTOR = 1.0; // tripleTolerancePct × 1.0
// 完成済みの NECKLINE_SLOPE_LIMIT（2%）ではなく tolerancePct 基準にする。3 点目が暫定で、2% では形成中を拾えないため。
const FORMING_NECKLINE_SPREAD_FACTOR = 1.0; // tolerancePct × 1.0
const FORMING_STAIR_STEP_LIMIT = 0.02;

type StairStepDirection = 'up' | 'down';

function stairStepDirection(main1: number, main2: number, main3: number): StairStepDirection | null {
	if (main1 < main2 && main2 < main3) return 'up';
	if (main1 > main2 && main2 > main3) return 'down';
	return null;
}
const RELAXED_TOLERANCE_FACTORS = [1.25, 2.0];
const RELAXED_CONFIDENCE_PENALTY = 0.95;

export function getTripleFormingBarParams(tf: string): { minBars: number; maxBars: number } {
	return patternBarRange(tf, FORMING_MIN_DAYS, FORMING_MAX_DAYS);
}

type Pcand = (arg: Parameters<typeof pushCand>[1]) => void;

function levelSpreadDetails(
	mainPoints: ReadonlyArray<Pivot>,
	allPoints: ReadonlyArray<Pivot | null>,
	levelTolerancePct: number,
): Record<string, unknown> {
	return levelSpreadDetailsFrom(levelSpreadMetrics(mainPoints, allPoints), levelTolerancePct);
}

// double と違い symmetry ではなく levelMargin を残す。triple の symmetry はほぼ定数で情報が無い（#199）。
// duration は triple だけバー数基準（periodScoreBars）。暦日版は triple でだけほぼ定数になるため（#199）。
function buildTripleScore(opts: {
	points: readonly [number, number, number];
	levelTolerancePct: number;
	necklinePrice: number;
	breakoutClose: number;
	side: ReversalSide;
	retracementRatio?: number;
	durationScore: number;
}): { components: PatternScoreBreakdown; base: number } {
	const [p1, p2, p3] = opts.points;
	const devs = [relDev(p1, p2), relDev(p2, p3), relDev(p1, p3)];
	const levelMargin = clamp01(
		1 - devs.reduce((s, v) => s + v, 0) / devs.length / Math.max(1e-12, opts.levelTolerancePct),
	);
	const retracement = retracementScore(opts.retracementRatio);
	// パターン高さは double と同じく、主構成点の平均とネックラインの距離。
	const avgLevel = (p1 + p2 + p3) / 3;
	const patternHeight = opts.side === 'bottom' ? opts.necklinePrice - avgLevel : avgLevel - opts.necklinePrice;
	const breakoutQuality = breakoutQualityScore(opts.necklinePrice, opts.breakoutClose, patternHeight, opts.side);
	const components: PatternScoreBreakdown = {
		levelMargin: Number(levelMargin.toFixed(4)),
		...(retracement !== undefined ? { retracement: Number(retracement.toFixed(4)) } : {}),
		...(breakoutQuality !== undefined ? { breakoutQuality: Number(breakoutQuality.toFixed(4)) } : {}),
		duration: Number(opts.durationScore.toFixed(4)),
	};
	// levelMargin は常に数値なので averageDefinedAxes は undefined を返さない（?? には届かない）。
	const base = averageDefinedAxes([levelMargin, retracement, breakoutQuality, opts.durationScore]) ?? levelMargin;
	return { components, base };
}

function tripleCompletionFields(opts: {
	isCompleted: boolean;
	candles: CandleData[];
	breakoutIdx: number;
	breakoutPrice: number;
	rangeEnd: string;
	target: number;
	direction: 'up' | 'down';
	patternHeight: number;
}) {
	const { isCompleted, candles, breakoutIdx, breakoutPrice, rangeEnd, target, direction, patternHeight } = opts;
	if (!isCompleted) {
		return {
			status: 'near_completion' as const,
			confirmation: { type: 'not_confirmed' as const },
			// 測れない理由を名乗る。breakoutTarget だけを出すと LLM が「進捗 0%」と読み違える（#224）。
			...targetReachFields(omittedTargetReach('not_broken_out')),
		};
	}
	return {
		status: 'completed' as const,
		confirmation: {
			type: 'neckline_breakout' as const,
			date: rangeEnd,
			idx: breakoutIdx,
			price: breakoutPrice,
		},
		breakout: { idx: breakoutIdx, price: breakoutPrice },
		breakoutBarIndex: breakoutIdx,
		// 入力不正は computeTargetReach が理由コードで名乗るので、ここで Number.isFinite を重ねない。
		...targetReachFields(computeTargetReach(candles, breakoutIdx, breakoutPrice, target, direction, patternHeight)),
		breakoutDate: rangeEnd,
		breakoutDirection: direction,
		outcome: 'success' as const,
	};
}

interface TripleSide {
	type: 'triple_top' | 'triple_bottom';
	mainKind: Pivot['kind'];
	neckKind: Pivot['kind'];
	mainRole: 'peak' | 'valley';
	neckRole: 'valley' | 'peak';
	notLevelReason: 'three_peaks_not_level' | 'three_valleys_not_level';
	notEqualRelaxedReason: 'peaks_not_equal_relaxed' | 'valleys_not_equal_relaxed';
	neckMissingReason: 'valleys_missing' | 'peaks_missing';
	formingNotLevelReason: 'forming_peaks_not_level' | 'forming_valleys_not_level';
	breakoutDirection: 'below' | 'above';
	targetDirection: 'down' | 'up';
}

const TRIPLE_SIDES: Record<ReversalSide, TripleSide> = {
	top: {
		type: 'triple_top',
		mainKind: 'H',
		neckKind: 'L',
		mainRole: 'peak',
		neckRole: 'valley',
		notLevelReason: 'three_peaks_not_level',
		notEqualRelaxedReason: 'peaks_not_equal_relaxed',
		neckMissingReason: 'valleys_missing',
		formingNotLevelReason: 'forming_peaks_not_level',
		breakoutDirection: 'below',
		targetDirection: 'down',
	},
	bottom: {
		type: 'triple_bottom',
		mainKind: 'L',
		neckKind: 'H',
		mainRole: 'valley',
		neckRole: 'peak',
		notLevelReason: 'three_valleys_not_level',
		notEqualRelaxedReason: 'valleys_not_equal_relaxed',
		neckMissingReason: 'peaks_missing',
		formingNotLevelReason: 'forming_valleys_not_level',
		breakoutDirection: 'above',
		targetDirection: 'up',
	},
};

// 区間内のネックライン候補のうち、top は最安値、bottom は最高値を採る。
function necklinePoint(ctx: DetectContext, side: ReversalSide, fromIdx: number, toIdx: number): Pivot | null {
	const pool = side === 'top' ? ctx.allValleys : ctx.allPeaks;
	const cands = pool.filter((p) => p.idx > fromIdx && p.idx < toIdx);
	if (cands.length === 0) return null;
	return cands.reduce((m, p) => ((side === 'top' ? p.price < m.price : p.price > m.price) ? p : m));
}

function evaluateCompletedTriple(
	ctx: DetectContext,
	side: ReversalSide,
	a: Pivot,
	b: Pivot,
	c: Pivot,
	relaxedFactor: number | null,
): DeduplicablePattern | null {
	const { candles, pivots, tolerancePct } = ctx;
	const spec = TRIPLE_SIDES[side];
	const { type } = spec;
	const pcand: Pcand = (arg) => pushCand(ctx, arg);
	const relaxed = relaxedFactor !== null;
	const suffix = relaxed ? '_relaxed' : '';
	const tol = relaxed ? tolerancePct * relaxedFactor : tolerancePct;
	const mainPts = () => [
		{ role: `${spec.mainRole}1`, idx: a.idx, price: a.price },
		{ role: `${spec.mainRole}2`, idx: b.idx, price: b.price },
		{ role: `${spec.mainRole}3`, idx: c.idx, price: c.price },
	];

	// ネックラインの点を同水準判定より先に探すのは、strict の棄却エントリにパターン高さを載せるため。
	const n1 = necklinePoint(ctx, side, a.idx, b.idx);
	const n2 = necklinePoint(ctx, side, b.idx, c.idx);

	if (relaxed) {
		const nearTriple = (x: number, y: number) => relDev(x, y) <= tol;
		if (!(nearTriple(a.price, b.price) && nearTriple(b.price, c.price))) {
			pcand({
				type,
				accepted: false,
				reason: spec.notEqualRelaxedReason,
				idxs: [a.idx, b.idx, c.idx],
				pts: mainPts(),
			});
			return null;
		}
	} else if (!(near(a.price, b.price, tol) && near(b.price, c.price, tol) && near(a.price, c.price, tol))) {
		pcand({
			type,
			accepted: false,
			reason: spec.notLevelReason,
			idxs: [a.idx, b.idx, c.idx],
			details: levelSpreadDetails([a, b, c], [a, n1, b, n2, c], tol),
		});
		return null;
	}
	const start = candles[a.idx].isoTime;
	const structureEnd = candles[c.idx].isoTime;
	if (!(start && structureEnd)) return null;

	if (!(n1 && n2)) {
		pcand({ type, accepted: false, reason: `${spec.neckMissingReason}${suffix}`, idxs: [a.idx, b.idx, c.idx] });
		return null;
	}
	const necklineSlope = relDev(n1.price, n2.price);
	if (necklineSlope > NECKLINE_SLOPE_LIMIT) {
		pcand({ type, accepted: false, reason: `neckline_slope_excess${suffix}`, idxs: [a.idx, b.idx, c.idx] });
		return null;
	}
	const priorTrend = validateTriplePriorTrend(ctx, type, [a.idx, b.idx, c.idx]);
	if (!priorTrend) return null;
	if (rejectCompletedStairStep(type, a, b, c, pcand)) return null;

	const sizeReason = validatePatternSize(side, [a, n1, b, n2, c], ctx.sizeThresholds);
	if (sizeReason) {
		pcand({ type, accepted: false, reason: sizeReason, idxs: [a.idx, b.idx, c.idx] });
		return null;
	}

	const nlAvg = (n1.price + n2.price) / 2;

	const gate = applyReversalGate({
		candles,
		pivots,
		side,
		first: a,
		mid: n1,
		necklinePrice: nlAvg,
		type,
		indices: [a.idx, b.idx, c.idx],
		debugCandidates: ctx.debugCandidates,
	});
	if (!gate) return null;

	// relaxed にも掛ける。strict が 0 件だと relaxed が同じ 3 点を拾い直すので、strict だけでは素通りする。
	const spread = levelSpreadMetrics([a, b, c], [a, n1, b, n2, c]);
	const spreadReason = validateLevelSpread(side, spread);
	if (spreadReason) {
		pcand({
			type,
			accepted: false,
			reason: spreadReason,
			idxs: [a.idx, b.idx, c.idx],
			details: levelSpreadDetailsFrom(spread, tol),
		});
		return null;
	}

	// 誤側に来るのは最後の点だけではないので、中間点も含めた 3 点すべてを検査する（#216）。
	const sideCheck = validateMainPointsNecklineSide(side, [a, b, c], nlAvg);
	if (sideCheck.reason) {
		pcand({
			type,
			accepted: false,
			reason: sideCheck.reason,
			idxs: [a.idx, b.idx, c.idx],
			details: necklineSideDetailsFrom(nlAvg, sideCheck.offenders),
		});
		return null;
	}

	const structureGate = buildStructureGate(gate);

	const breakoutIdx = findBreakoutIdx(candles, c.idx, nlAvg, spec.breakoutDirection);
	const isCompleted = breakoutIdx >= 0;
	const rangeEnd = isCompleted ? candles[breakoutIdx]?.isoTime : structureEnd;
	if (!rangeEnd) return null;
	const breakoutPrice = isCompleted ? Number(candles[breakoutIdx]?.close ?? NaN) : NaN;

	// 整合度はブレイク検出の後で算出する。breakoutQuality 軸がブレイク足の終値を要るため（#199）。
	// relaxed の levelMargin は判定に使った幅で正規化する。strict の幅で測ると、緩めた判定に strict の物差しを当てることになる。
	const per = periodScoreBars(c.idx - a.idx);
	const { components: scoreComponents, base } = buildTripleScore({
		points: [a.price, b.price, c.price],
		levelTolerancePct: tol,
		necklinePrice: nlAvg,
		breakoutClose: breakoutPrice,
		side,
		retracementRatio: gate.retracementRatio,
		durationScore: per,
	});
	const confidence = finalizeConf(relaxed ? base * RELAXED_CONFIDENCE_PENALTY : base, type);
	if (confidence < (MIN_CONFIDENCE[type] ?? 0)) {
		pcand({
			type,
			accepted: false,
			reason: `confidence_below_min${suffix}`,
			idxs: [a.idx, b.idx, c.idx],
			details: { confidence, threshold: MIN_CONFIDENCE[type] ?? 0, ...scoreComponents },
		});
		return null;
	}

	const postGate = isCompleted
		? applyPostBreakoutGates({
				candles,
				pivots,
				side,
				first: a,
				mid: n1,
				last: c,
				breakoutIdx,
				type,
				indices: [a.idx, b.idx, c.idx],
				debugCandidates: ctx.debugCandidates,
			})
		: null;

	const neckline = [
		{ x: a.idx, y: nlAvg },
		{ x: isCompleted ? breakoutIdx : c.idx, y: nlAvg },
	];
	const diagram: PatternDiagramData = generatePatternDiagram(
		type,
		[
			{ ...a, date: candles[a.idx]?.isoTime },
			{ ...n1, date: candles[n1.idx]?.isoTime },
			{ ...b, date: candles[b.idx]?.isoTime },
			{ ...n2, date: candles[n2.idx]?.isoTime },
			{ ...c, date: candles[c.idx]?.isoTime },
		],
		{ price: nlAvg },
		{ start, end: rangeEnd },
		{ tz: ctx.tz, type: ctx.type },
	);
	const avgMain = (a.price + b.price + c.price) / 3;
	const patternHeight = side === 'top' ? avgMain - nlAvg : nlAvg - avgMain;
	const target = roundPriceAtLevel(side === 'top' ? nlAvg - patternHeight : nlAvg + patternHeight, nlAvg);
	const completionFields = tripleCompletionFields({
		isCompleted,
		candles,
		breakoutIdx,
		breakoutPrice,
		rangeEnd,
		target,
		direction: spec.targetDirection,
		patternHeight,
	});

	const entry: DeduplicablePattern = {
		type,
		confidence,
		scoreComponents,
		range: { start, end: rangeEnd },
		structureRange: { start, end: structureEnd },
		...completionFields,
		// completionFields より後ろに置く。#242 のゲートに当たると status を invalid で上書きするため。
		...postGate,
		// 主構成点は位置ではなく kind で取る規約（mainPointIdxs() と同じ）。間の 2 点はネックラインの定義点。
		pivots: [a, n1, b, n2, c],
		neckline,
		...(structureGate ? { structureGate } : {}),
		...(priorTrend.precedingTrend ? { precedingTrend: priorTrend.precedingTrend } : {}),
		trendlineLabel: 'ネックライン',
		breakoutTarget: target,
		targetMethod: 'neckline_projection' as const,
		...(diagram ? { structureDiagram: diagram } : {}),
		...(relaxed ? { _fallback: `relaxed_triple_x${relaxedFactor}` } : {}),
	};
	// postGate に当たった候補は棄却として記録済みなので、成功としては積まない。relaxed は採用の候補を積まない。
	if (!relaxed && !postGate)
		pcand({
			type,
			accepted: true,
			idxs: isCompleted ? [a.idx, b.idx, c.idx, breakoutIdx] : [a.idx, b.idx, c.idx],
			pts: [...mainPts(), ...(isCompleted ? [{ role: 'breakout', idx: breakoutIdx, price: breakoutPrice }] : [])],
		});
	return entry;
}

function findStrictTriples(ctx: DetectContext, side: ReversalSide): DeduplicablePattern[] {
	const mains = ctx.pivots.filter((p) => p.kind === TRIPLE_SIDES[side].mainKind);
	const patterns: DeduplicablePattern[] = [];
	for (let i = 0; i <= mains.length - 3; i++) {
		const a = mains[i];
		const b = mains[i + 1];
		const c = mains[i + 2];
		if (b.idx - a.idx < ctx.minDist || c.idx - b.idx < ctx.minDist) continue;
		const entry = evaluateCompletedTriple(ctx, side, a, b, c, null);
		if (entry) patterns.push(entry);
	}
	return patterns;
}

function findRelaxedTriple(ctx: DetectContext, side: ReversalSide, factor: number): DeduplicablePattern | null {
	const mains = ctx.pivots.filter((p) => p.kind === TRIPLE_SIDES[side].mainKind);
	// invalid で打ち切ると、後ろにある成立した候補まで失われるので退避して走査を続ける（#242）。
	let terminalFallback: DeduplicablePattern | null = null;
	for (let i = 0; i <= mains.length - 3; i++) {
		const a = mains[i];
		const b = mains[i + 1];
		const c = mains[i + 2];
		if (b.idx - a.idx < ctx.minDist || c.idx - b.idx < ctx.minDist) continue;
		const entry = evaluateCompletedTriple(ctx, side, a, b, c, factor);
		if (!entry) continue;
		if (entry.status === 'invalid') {
			terminalFallback ??= entry;
			continue;
		}
		return entry;
	}
	return terminalFallback;
}

function rejectFormingNecklineSide(
	side: ReversalSide,
	type: 'triple_top' | 'triple_bottom',
	mainPoints: ReadonlyArray<Pick<Pivot, 'idx' | 'price'>>,
	necklinePrice: number,
	idxs: number[],
	pts: Array<{ role: string; idx: number; price: number }>,
	pcand: Pcand,
): boolean {
	const { reason, offenders } = validateMainPointsNecklineSide(side, mainPoints, necklinePrice);
	if (!reason) return false;
	pcand({
		type,
		accepted: false,
		reason: formingNecklineSideReason(reason),
		idxs,
		pts,
		details: necklineSideDetailsFrom(necklinePrice, offenders),
	});
	return true;
}

// type ごとに片側だけでなく両向きを見る。理由コードは type ではなく向きの名前（#263）。
// 呼び出しは同水準判定より前に置く。単調な階段は forming_*_not_level より stair_step のほうが形を言い当てる。
function rejectFormingStairStep(
	type: 'triple_top' | 'triple_bottom',
	main1: Pivot,
	main2: Pivot,
	currentPrice: number,
	lastIdx: number,
	pcand: Pcand,
): boolean {
	const direction = stairStepDirection(main1.price, main2.price, currentPrice);
	if (!direction) return false;

	const totalStep = Math.abs(currentPrice - main1.price) / Math.max(EPSILON, main1.price);
	if (totalStep <= FORMING_STAIR_STEP_LIMIT) return false;

	const role = type === 'triple_top' ? 'peak' : 'valley';
	pcand({
		type,
		accepted: false,
		reason: `forming_stair_step_${direction}`,
		idxs: [main1.idx, main2.idx, lastIdx],
		pts: [
			{ role: `${role}1`, idx: main1.idx, price: main1.price },
			{ role: `${role}2`, idx: main2.idx, price: main2.price },
			{ role: 'current', idx: lastIdx, price: currentPrice },
		],
	});
	return true;
}

// 形成中と違い 3 点とも確定ピボットなので、累積差の閾値を設けずに棄却する。
function rejectCompletedStairStep(
	type: 'triple_top' | 'triple_bottom',
	main1: Pivot,
	main2: Pivot,
	main3: Pivot,
	pcand: Pcand,
): boolean {
	const direction = stairStepDirection(main1.price, main2.price, main3.price);
	if (!direction) return false;

	const role = type === 'triple_top' ? 'peak' : 'valley';
	pcand({
		type,
		accepted: false,
		reason: `stair_step_${direction}`,
		idxs: [main1.idx, main2.idx, main3.idx],
		pts: [
			{ role: `${role}1`, idx: main1.idx, price: main1.price },
			{ role: `${role}2`, idx: main2.idx, price: main2.price },
			{ role: `${role}3`, idx: main3.idx, price: main3.price },
		],
	});
	return true;
}

// 棄却理由は構成点が揃った後でだけ積む。揃う前の continue はペアの数だけ起き、debug の上限を食い潰すため（#155）。
function tryFormingTriple(ctx: DetectContext, side: ReversalSide): DeduplicablePattern | null {
	const { candles, pivots, tolerancePct, minDist } = ctx;
	const spec = TRIPLE_SIDES[side];
	const { type } = spec;
	const top = side === 'top';
	const pcand: Pcand = (arg) => pushCand(ctx, arg);
	const lastIdx = candles.length - 1;
	const currentPrice = Number(candles[lastIdx]?.close ?? NaN);
	const isoAt = (i: number) => candles[i]?.isoTime || '';
	const formingBars = getTripleFormingBarParams(ctx.type);
	const tripleTolerancePct = tolerancePct * FORMING_TOLERANCE_MULTIPLIER;
	const levelSpreadLimit = tripleTolerancePct * FORMING_LEVEL_SPREAD_FACTOR;
	const necklineSpreadLimit = tolerancePct * FORMING_NECKLINE_SPREAD_FACTOR;

	const mains = top ? ctx.allPeaks : ctx.allValleys;
	if (mains.length < 2) return null;
	const confirmedMains = mains.filter((p) => p.idx < lastIdx - 2);

	for (let i = confirmedMains.length - 1; i >= 1; i--) {
		const main2 = confirmedMains[i];
		const main1 = confirmedMains[i - 1];
		if (main2.idx - main1.idx < minDist) continue;

		const mainDiff = relDev(main1.price, main2.price);
		if (mainDiff > tripleTolerancePct) continue;

		const avgMain = (main1.price + main2.price) / 2;
		const currentDiff = Math.abs(currentPrice - avgMain) / Math.max(EPSILON, avgMain);
		const pastLevel = top ? currentPrice < avgMain * 0.95 : currentPrice > avgMain * 1.05;
		if (currentDiff > tripleTolerancePct || pastLevel) continue;

		if (rejectFormingStairStep(type, main1, main2, currentPrice, lastIdx, pcand)) continue;

		const idxs = [main1.idx, main2.idx, lastIdx];
		const levelPts = () => [
			{ role: `${spec.mainRole}1`, idx: main1.idx, price: main1.price },
			{ role: `${spec.mainRole}2`, idx: main2.idx, price: main2.price },
			{ role: 'current', idx: lastIdx, price: currentPrice },
		];

		// 2 点ずつの判定だけでは非単調な配置（100 → 95 → 100 など）で累積したばらつきを捉えられないので、3 点の max-min でも見る。
		const levelMax = Math.max(main1.price, main2.price, currentPrice);
		const levelMin = Math.min(main1.price, main2.price, currentPrice);
		const levelSpread = (levelMax - levelMin) / Math.max(EPSILON, levelMax);
		if (levelSpread > levelSpreadLimit) {
			pcand({ type, accepted: false, reason: spec.formingNotLevelReason, idxs: [...idxs], pts: levelPts() });
			continue;
		}

		const formationBars = Math.max(0, lastIdx - main1.idx);
		if (formationBars < formingBars.minBars || formationBars > formingBars.maxBars) {
			pcand({ type, accepted: false, reason: 'forming_bars_out_of_range', idxs: [...idxs], pts: levelPts() });
			continue;
		}
		const priorTrend = validateTriplePriorTrend(ctx, type, [main1.idx, main2.idx, lastIdx]);
		if (!priorTrend) continue;

		// ネックラインの点は区間ごとに要求する。合計数だけ見ると、2 点とも main1-main2 間にある H-L-L-H が通ってしまう。
		const n1 = necklinePoint(ctx, side, main1.idx, main2.idx);
		const n2 = necklinePoint(ctx, side, main2.idx, lastIdx);
		if (!n1 || !n2) {
			pcand({ type, accepted: false, reason: 'forming_neckline_points_insufficient', idxs: [...idxs] });
			continue;
		}

		const neckMax = Math.max(n1.price, n2.price);
		const neckMin = Math.min(n1.price, n2.price);
		const neckSpread = (neckMax - neckMin) / Math.max(EPSILON, neckMax);
		if (neckSpread > necklineSpreadLimit) {
			pcand({ type, accepted: false, reason: 'forming_neckline_not_horizontal', idxs: [...idxs] });
			continue;
		}

		const avgNeck = (n1.price + n2.price) / 2;
		const height = top ? avgMain - avgNeck : avgNeck - avgMain;
		const progress = (top ? avgMain - currentPrice : currentPrice - avgMain) / Math.max(1e-12, height);
		const completion = Math.min(1, 0.66 + Math.min(1, progress) * 0.34);
		const rawConfidence = Math.round((1 - mainDiff / tripleTolerancePct) * 0.8 * 100) / 100;
		const confidence = Math.min(rawConfidence, FORMING_MAX_CONFIDENCE);

		const structurePts = () => [
			{ role: `${spec.mainRole}1`, idx: main1.idx, price: main1.price },
			{ role: `${spec.neckRole}1`, idx: n1.idx, price: n1.price },
			{ role: `${spec.mainRole}2`, idx: main2.idx, price: main2.price },
			{ role: `${spec.neckRole}2`, idx: n2.idx, price: n2.price },
			{ role: 'current', idx: lastIdx, price: currentPrice },
		];

		if (completion < FORMING_MIN_COMPLETION || confidence < FORMING_MIN_CONFIDENCE) {
			pcand({
				type,
				accepted: false,
				reason: completion < FORMING_MIN_COMPLETION ? 'forming_completion_below_min' : 'forming_confidence_below_min',
				idxs: [...idxs],
				pts: structurePts(),
			});
			continue;
		}

		const sizeReason = validatePatternSize(
			side,
			[main1, n1, main2, n2, { extremePrice: currentPrice }],
			ctx.sizeThresholds,
		);
		if (sizeReason) {
			pcand({ type, accepted: false, reason: sizeReason, idxs: [...idxs] });
			continue;
		}

		const gate = applyReversalGate({
			candles,
			pivots,
			side,
			first: main1,
			mid: n1,
			necklinePrice: avgNeck,
			type,
			indices: [main1.idx, main2.idx, lastIdx],
			debugCandidates: ctx.debugCandidates,
		});
		if (!gate) continue;

		if (
			rejectFormingNecklineSide(
				side,
				type,
				[main1, main2, { idx: lastIdx, price: currentPrice }],
				avgNeck,
				[...idxs],
				structurePts(),
				pcand,
			)
		) {
			continue;
		}

		const structureGate = buildStructureGate(gate);

		const neckline = [
			{ x: main1.idx, y: avgNeck },
			{ x: lastIdx, y: avgNeck },
		];

		const target = roundPriceAtLevel(top ? avgNeck - height : avgNeck + height, avgNeck);

		// idxs は棄却エントリと同じ 3 点にそろえ、ネックラインの 2 点は pts にだけ載せる。
		pcand({ type, accepted: true, status: 'forming', idxs: [...idxs], pts: structurePts() });

		return {
			type,
			confidence,
			range: { start: isoAt(main1.idx), end: isoAt(lastIdx) },
			status: 'forming',
			// 3 点目は現在価格の暫定値なので pivots に含めない。
			pivots: [
				{ idx: main1.idx, price: main1.price, kind: spec.mainKind, extremePrice: main1.extremePrice },
				{ idx: n1.idx, price: n1.price, kind: spec.neckKind, extremePrice: n1.extremePrice },
				{ idx: main2.idx, price: main2.price, kind: spec.mainKind, extremePrice: main2.extremePrice },
				{ idx: n2.idx, price: n2.price, kind: spec.neckKind, extremePrice: n2.extremePrice },
			],
			neckline,
			...(structureGate ? { structureGate } : {}),
			...(priorTrend.precedingTrend ? { precedingTrend: priorTrend.precedingTrend } : {}),
			trendlineLabel: 'ネックライン',
			breakoutTarget: target,
			targetMethod: 'neckline_projection' as const,
			...targetReachFields(omittedTargetReach('not_broken_out')),
			completionPct: Math.round(completion * 100),
			_method: `forming_${type}`,
		};
	}
	return null;
}

export function detectTriples(ctx: DetectContext): DetectResult {
	const { want, includeForming } = ctx;
	const patterns: DeduplicablePattern[] = [];
	const sides = (['top', 'bottom'] as const).filter((side) => want.size === 0 || want.has(TRIPLE_SIDES[side].type));

	for (const side of sides) patterns.push(...findStrictTriples(ctx, side));
	for (const f of RELAXED_TOLERANCE_FACTORS) {
		for (const side of sides) {
			if (patterns.some((p) => p.type === TRIPLE_SIDES[side].type)) continue;
			const relaxed = findRelaxedTriple(ctx, side, f);
			if (relaxed) patterns.push(relaxed);
		}
	}
	if (includeForming) {
		for (const side of sides) {
			const forming = tryFormingTriple(ctx, side);
			if (forming) patterns.push(forming);
		}
	}

	// dedup に要求外の status を混ぜないよう、detect_wedges.ts と同じく検出器内で先に落とす。
	const filtered = includeForming
		? patterns
		: patterns.filter((p) => p.status !== 'forming' && p.status !== 'near_completion');

	return { patterns: filtered };
}
