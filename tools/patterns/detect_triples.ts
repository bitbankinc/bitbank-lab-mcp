import { generatePatternDiagram, type PatternDiagramData } from '../../lib/pattern-diagrams.js';
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
// top では completion が 0.66 を下回らないので届かない（重みを変えたときのガード）。bottom は progress が負になりうるので届く。
export const FORMING_MIN_COMPLETION = 0.4;
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

function findStrictTripleTop(ctx: DetectContext): DeduplicablePattern[] {
	const { candles, pivots, allValleys, tolerancePct, minDist } = ctx;
	const pcand: Pcand = (arg) => pushCand(ctx, arg);
	const patterns: DeduplicablePattern[] = [];
	const highsOnly = pivots.filter((p) => p.kind === 'H');
	if (highsOnly.length < 3) return patterns;

	for (let i = 0; i <= highsOnly.length - 3; i++) {
		const a = highsOnly[i],
			b = highsOnly[i + 1],
			c = highsOnly[i + 2];
		if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;

		// 谷を同水準判定より先に探すのは、棄却エントリにパターン高さを載せるため。棄却の順は変えていない。
		const v1cands = allValleys.filter((v: { idx: number }) => v.idx > a.idx && v.idx < b.idx);
		const v2cands = allValleys.filter((v: { idx: number }) => v.idx > b.idx && v.idx < c.idx);
		const v1 = v1cands.length ? v1cands.reduce((m, v) => (v.price < m.price ? v : m)) : null;
		const v2 = v2cands.length ? v2cands.reduce((m, v) => (v.price < m.price ? v : m)) : null;

		const nearAll =
			near(a.price, b.price, tolerancePct) &&
			near(b.price, c.price, tolerancePct) &&
			near(a.price, c.price, tolerancePct);
		if (!nearAll) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: 'three_peaks_not_level',
				idxs: [a.idx, b.idx, c.idx],
				details: levelSpreadDetails([a, b, c], [a, v1, b, v2, c], tolerancePct),
			});
			continue;
		}
		const start = candles[a.idx].isoTime;
		const structureEnd = candles[c.idx].isoTime;
		if (!(start && structureEnd)) continue;

		if (!(v1 && v2)) {
			pcand({ type: 'triple_top', accepted: false, reason: 'valleys_missing', idxs: [a.idx, b.idx, c.idx] });
			continue;
		}
		const necklineSlope = Math.abs(v1.price - v2.price) / Math.max(1, Math.max(v1.price, v2.price));
		if (necklineSlope > NECKLINE_SLOPE_LIMIT) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: 'neckline_slope_excess',
				idxs: [a.idx, b.idx, c.idx],
			});
			continue;
		}
		const priorTrend = validateTriplePriorTrend(ctx, 'triple_top', [a.idx, b.idx, c.idx]);
		if (!priorTrend) continue;
		if (rejectCompletedStairStep('triple_top', a, b, c, pcand)) continue;

		const sizeReason = validatePatternSize('top', [a, v1, b, v2, c], ctx.sizeThresholds);
		if (sizeReason) {
			pcand({ type: 'triple_top', accepted: false, reason: sizeReason, idxs: [a.idx, b.idx, c.idx] });
			continue;
		}

		const nlAvg = (v1.price + v2.price) / 2;

		const gate = applyReversalGate({
			candles,
			pivots,
			side: 'top',
			first: a,
			mid: v1,
			necklinePrice: nlAvg,
			type: 'triple_top',
			indices: [a.idx, b.idx, c.idx],
			debugCandidates: ctx.debugCandidates,
		});
		if (!gate) continue;

		const topSpread = levelSpreadMetrics([a, b, c], [a, v1, b, v2, c]);
		const topSpreadReason = validateLevelSpread('top', topSpread);
		if (topSpreadReason) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: topSpreadReason,
				idxs: [a.idx, b.idx, c.idx],
				details: levelSpreadDetailsFrom(topSpread, tolerancePct),
			});
			continue;
		}

		// 誤側に来るのは最後の点だけではないので、中間点も含めた 3 点すべてを検査する（#216）。
		const strictTopSide = validateMainPointsNecklineSide('top', [a, b, c], nlAvg);
		if (strictTopSide.reason) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: strictTopSide.reason,
				idxs: [a.idx, b.idx, c.idx],
				details: necklineSideDetailsFrom(nlAvg, strictTopSide.offenders),
			});
			continue;
		}

		const structureGate = buildStructureGate(gate);

		const breakoutIdx = findBreakoutIdx(candles, c.idx, nlAvg, 'below');
		const isCompleted = breakoutIdx >= 0;
		const rangeEnd = isCompleted ? candles[breakoutIdx]?.isoTime : structureEnd;
		if (!rangeEnd) continue;
		const breakoutPrice = isCompleted ? Number(candles[breakoutIdx]?.close ?? NaN) : NaN;

		// 整合度はブレイク検出の後で算出する。breakoutQuality 軸がブレイク足の終値を要るため（#199）。
		const per = periodScoreBars(c.idx - a.idx);
		const { components: scoreComponents, base } = buildTripleScore({
			points: [a.price, b.price, c.price],
			levelTolerancePct: tolerancePct,
			necklinePrice: nlAvg,
			breakoutClose: breakoutPrice,
			side: 'top',
			retracementRatio: gate.retracementRatio,
			durationScore: per,
		});
		const confidence = finalizeConf(base, 'triple_top');
		if (confidence < (MIN_CONFIDENCE.triple_top ?? 0)) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: 'confidence_below_min',
				idxs: [a.idx, b.idx, c.idx],
				details: { confidence, threshold: MIN_CONFIDENCE.triple_top ?? 0, ...scoreComponents },
			});
			continue;
		}

		const postGate = isCompleted
			? applyPostBreakoutGates({
					candles,
					pivots,
					side: 'top',
					first: a,
					mid: v1,
					last: c,
					breakoutIdx,
					type: 'triple_top',
					indices: [a.idx, b.idx, c.idx],
					debugCandidates: ctx.debugCandidates,
				})
			: null;

		const neckline = [
			{ x: a.idx, y: nlAvg },
			{ x: isCompleted ? breakoutIdx : c.idx, y: nlAvg },
		];
		const diagram: PatternDiagramData = generatePatternDiagram(
			'triple_top',
			[
				{ ...a, date: candles[a.idx]?.isoTime },
				{ ...v1, date: candles[v1.idx]?.isoTime },
				{ ...b, date: candles[b.idx]?.isoTime },
				{ ...v2, date: candles[v2.idx]?.isoTime },
				{ ...c, date: candles[c.idx]?.isoTime },
			],
			{ price: nlAvg },
			{ start, end: rangeEnd },
			{ tz: ctx.tz, type: ctx.type },
		);
		const ttAvgPeak = (a.price + b.price + c.price) / 3;
		const ttTarget = Math.round(nlAvg - (ttAvgPeak - nlAvg));
		const completionFields = tripleCompletionFields({
			isCompleted,
			candles,
			breakoutIdx,
			breakoutPrice,
			rangeEnd,
			target: ttTarget,
			direction: 'down',
			patternHeight: ttAvgPeak - nlAvg,
		});

		patterns.push({
			type: 'triple_top',
			confidence,
			scoreComponents,
			range: { start, end: rangeEnd },
			structureRange: { start, end: structureEnd },
			...completionFields,
			// completionFields より後ろに置く。#242 のゲートに当たると status を invalid で上書きするため。
			...postGate,
			// 主構成点は位置ではなく kind で取る規約（mainPointIdxs() と同じ）。間の 2 点はネックラインの定義点。
			pivots: [a, v1, b, v2, c],
			neckline,
			...(structureGate ? { structureGate } : {}),
			...(priorTrend.precedingTrend ? { precedingTrend: priorTrend.precedingTrend } : {}),
			trendlineLabel: 'ネックライン',
			breakoutTarget: ttTarget,
			targetMethod: 'neckline_projection' as const,
			...(diagram ? { structureDiagram: diagram } : {}),
		});
		// postGate に当たった候補は棄却として記録済みなので、成功としては積まない。
		if (!postGate)
			pcand({
				type: 'triple_top',
				accepted: true,
				idxs: isCompleted ? [a.idx, b.idx, c.idx, breakoutIdx] : [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'peak1', idx: a.idx, price: a.price },
					{ role: 'peak2', idx: b.idx, price: b.price },
					{ role: 'peak3', idx: c.idx, price: c.price },
					...(isCompleted ? [{ role: 'breakout', idx: breakoutIdx, price: breakoutPrice }] : []),
				],
			});
	}

	return patterns;
}

function findStrictTripleBottom(ctx: DetectContext): DeduplicablePattern[] {
	const { candles, pivots, allPeaks, tolerancePct, minDist } = ctx;
	const pcand: Pcand = (arg) => pushCand(ctx, arg);
	const patterns: DeduplicablePattern[] = [];
	const lowsOnly = pivots.filter((p) => p.kind === 'L');
	if (lowsOnly.length < 3) return patterns;

	for (let i = 0; i <= lowsOnly.length - 3; i++) {
		const a = lowsOnly[i],
			b = lowsOnly[i + 1],
			c = lowsOnly[i + 2];
		if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;

		const p1cands = allPeaks.filter((v: { idx: number }) => v.idx > a.idx && v.idx < b.idx);
		const p2cands = allPeaks.filter((v: { idx: number }) => v.idx > b.idx && v.idx < c.idx);
		const p1 = p1cands.length ? p1cands.reduce((m, v) => (v.price > m.price ? v : m)) : null;
		const p2 = p2cands.length ? p2cands.reduce((m, v) => (v.price > m.price ? v : m)) : null;

		const nearAll =
			near(a.price, b.price, tolerancePct) &&
			near(b.price, c.price, tolerancePct) &&
			near(a.price, c.price, tolerancePct);
		if (!nearAll) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: 'three_valleys_not_level',
				idxs: [a.idx, b.idx, c.idx],
				details: levelSpreadDetails([a, b, c], [a, p1, b, p2, c], tolerancePct),
			});
			continue;
		}
		const start = candles[a.idx].isoTime;
		const structureEnd = candles[c.idx].isoTime;
		if (!(start && structureEnd)) continue;

		if (!(p1 && p2)) {
			pcand({ type: 'triple_bottom', accepted: false, reason: 'peaks_missing', idxs: [a.idx, b.idx, c.idx] });
			continue;
		}
		const necklineSlope = Math.abs(p1.price - p2.price) / Math.max(1, Math.max(p1.price, p2.price));
		if (necklineSlope > NECKLINE_SLOPE_LIMIT) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: 'neckline_slope_excess',
				idxs: [a.idx, b.idx, c.idx],
			});
			continue;
		}
		const priorTrend = validateTriplePriorTrend(ctx, 'triple_bottom', [a.idx, b.idx, c.idx]);
		if (!priorTrend) continue;
		if (rejectCompletedStairStep('triple_bottom', a, b, c, pcand)) continue;

		const sizeReason = validatePatternSize('bottom', [a, p1, b, p2, c], ctx.sizeThresholds);
		if (sizeReason) {
			pcand({ type: 'triple_bottom', accepted: false, reason: sizeReason, idxs: [a.idx, b.idx, c.idx] });
			continue;
		}

		const nlAvg = (p1.price + p2.price) / 2;

		const gate = applyReversalGate({
			candles,
			pivots,
			side: 'bottom',
			first: a,
			mid: p1,
			necklinePrice: nlAvg,
			type: 'triple_bottom',
			indices: [a.idx, b.idx, c.idx],
			debugCandidates: ctx.debugCandidates,
		});
		if (!gate) continue;

		const bottomSpread = levelSpreadMetrics([a, b, c], [a, p1, b, p2, c]);
		const bottomSpreadReason = validateLevelSpread('bottom', bottomSpread);
		if (bottomSpreadReason) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: bottomSpreadReason,
				idxs: [a.idx, b.idx, c.idx],
				details: levelSpreadDetailsFrom(bottomSpread, tolerancePct),
			});
			continue;
		}

		const strictBottomSide = validateMainPointsNecklineSide('bottom', [a, b, c], nlAvg);
		if (strictBottomSide.reason) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: strictBottomSide.reason,
				idxs: [a.idx, b.idx, c.idx],
				details: necklineSideDetailsFrom(nlAvg, strictBottomSide.offenders),
			});
			continue;
		}

		const structureGate = buildStructureGate(gate);

		const breakoutIdx = findBreakoutIdx(candles, c.idx, nlAvg, 'above');
		const isCompleted = breakoutIdx >= 0;
		const rangeEnd = isCompleted ? candles[breakoutIdx]?.isoTime : structureEnd;
		if (!rangeEnd) continue;
		const breakoutPrice = isCompleted ? Number(candles[breakoutIdx]?.close ?? NaN) : NaN;

		const per = periodScoreBars(c.idx - a.idx);
		const { components: scoreComponents, base } = buildTripleScore({
			points: [a.price, b.price, c.price],
			levelTolerancePct: tolerancePct,
			necklinePrice: nlAvg,
			breakoutClose: breakoutPrice,
			side: 'bottom',
			retracementRatio: gate.retracementRatio,
			durationScore: per,
		});
		const confidence = finalizeConf(base, 'triple_bottom');
		if (confidence < (MIN_CONFIDENCE.triple_bottom ?? 0)) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: 'confidence_below_min',
				idxs: [a.idx, b.idx, c.idx],
				details: { confidence, threshold: MIN_CONFIDENCE.triple_bottom ?? 0, ...scoreComponents },
			});
			continue;
		}

		const postGate = isCompleted
			? applyPostBreakoutGates({
					candles,
					pivots,
					side: 'bottom',
					first: a,
					mid: p1,
					last: c,
					breakoutIdx,
					type: 'triple_bottom',
					indices: [a.idx, b.idx, c.idx],
					debugCandidates: ctx.debugCandidates,
				})
			: null;

		const neckline = [
			{ x: a.idx, y: nlAvg },
			{ x: isCompleted ? breakoutIdx : c.idx, y: nlAvg },
		];
		const diagram: PatternDiagramData = generatePatternDiagram(
			'triple_bottom',
			[
				{ ...a, date: candles[a.idx]?.isoTime },
				{ ...p1, date: candles[p1.idx]?.isoTime },
				{ ...b, date: candles[b.idx]?.isoTime },
				{ ...p2, date: candles[p2.idx]?.isoTime },
				{ ...c, date: candles[c.idx]?.isoTime },
			],
			{ price: nlAvg },
			{ start, end: rangeEnd },
			{ tz: ctx.tz, type: ctx.type },
		);
		const tbAvgValley = (a.price + b.price + c.price) / 3;
		const tbTarget = Math.round(nlAvg + (nlAvg - tbAvgValley));
		const completionFields = tripleCompletionFields({
			isCompleted,
			candles,
			breakoutIdx,
			breakoutPrice,
			rangeEnd,
			target: tbTarget,
			direction: 'up',
			patternHeight: nlAvg - tbAvgValley,
		});

		patterns.push({
			type: 'triple_bottom',
			confidence,
			scoreComponents,
			range: { start, end: rangeEnd },
			structureRange: { start, end: structureEnd },
			...completionFields,
			...postGate,
			pivots: [a, p1, b, p2, c],
			neckline,
			...(structureGate ? { structureGate } : {}),
			...(priorTrend.precedingTrend ? { precedingTrend: priorTrend.precedingTrend } : {}),
			trendlineLabel: 'ネックライン',
			breakoutTarget: tbTarget,
			targetMethod: 'neckline_projection' as const,
			...(diagram ? { structureDiagram: diagram } : {}),
		});
		if (!postGate)
			pcand({
				type: 'triple_bottom',
				accepted: true,
				idxs: isCompleted ? [a.idx, b.idx, c.idx, breakoutIdx] : [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'valley1', idx: a.idx, price: a.price },
					{ role: 'valley2', idx: b.idx, price: b.price },
					{ role: 'valley3', idx: c.idx, price: c.price },
					...(isCompleted ? [{ role: 'breakout', idx: breakoutIdx, price: breakoutPrice }] : []),
				],
			});
	}

	return patterns;
}

function findRelaxedTripleTop(ctx: DetectContext, factor: number): DeduplicablePattern | null {
	const { candles, pivots, allValleys, tolerancePct, minDist } = ctx;
	const pcand: Pcand = (arg) => pushCand(ctx, arg);
	const tolTriple = tolerancePct * factor;
	const nearTriple = (x: number, y: number) => Math.abs(x - y) / Math.max(1, Math.max(x, y)) <= tolTriple;
	const highsOnly = pivots.filter((p) => p.kind === 'H');

	// invalid で打ち切ると、後ろにある成立した候補まで失われるので退避して走査を続ける（#242）。
	let terminalFallback: DeduplicablePattern | null = null;

	for (let i = 0; i <= highsOnly.length - 3; i++) {
		const a = highsOnly[i],
			b = highsOnly[i + 1],
			c = highsOnly[i + 2];
		if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;
		if (!(nearTriple(a.price, b.price) && nearTriple(b.price, c.price))) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: 'peaks_not_equal_relaxed',
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'peak1', idx: a.idx, price: a.price },
					{ role: 'peak2', idx: b.idx, price: b.price },
					{ role: 'peak3', idx: c.idx, price: c.price },
				],
			});
			continue;
		}
		const start = candles[a.idx].isoTime,
			structureEnd = candles[c.idx].isoTime;
		if (!start || !structureEnd) continue;
		const v1cands = allValleys.filter((v: { idx: number }) => v.idx > a.idx && v.idx < b.idx);
		const v2cands = allValleys.filter((v: { idx: number }) => v.idx > b.idx && v.idx < c.idx);
		const v1 = v1cands.length ? v1cands.reduce((m, v) => (v.price < m.price ? v : m)) : null;
		const v2 = v2cands.length ? v2cands.reduce((m, v) => (v.price < m.price ? v : m)) : null;
		if (!(v1 && v2)) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: 'valleys_missing_relaxed',
				idxs: [a.idx, b.idx, c.idx],
			});
			continue;
		}
		const necklineSlope = Math.abs(v1.price - v2.price) / Math.max(1, Math.max(v1.price, v2.price));
		if (necklineSlope > NECKLINE_SLOPE_LIMIT) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: 'neckline_slope_excess_relaxed',
				idxs: [a.idx, b.idx, c.idx],
			});
			continue;
		}
		const priorTrend = validateTriplePriorTrend(ctx, 'triple_top', [a.idx, b.idx, c.idx]);
		if (!priorTrend) continue;
		if (rejectCompletedStairStep('triple_top', a, b, c, pcand)) continue;
		const sizeReason = validatePatternSize('top', [a, v1, b, v2, c], ctx.sizeThresholds);
		if (sizeReason) {
			pcand({ type: 'triple_top', accepted: false, reason: sizeReason, idxs: [a.idx, b.idx, c.idx] });
			continue;
		}

		const nlAvg = (v1.price + v2.price) / 2;

		const gate = applyReversalGate({
			candles,
			pivots,
			side: 'top',
			first: a,
			mid: v1,
			necklinePrice: nlAvg,
			type: 'triple_top',
			indices: [a.idx, b.idx, c.idx],
			debugCandidates: ctx.debugCandidates,
		});
		if (!gate) continue;

		// strict と同じ検査を relaxed にも掛ける。strict が 0 件だと relaxed が同じ 3 山を拾い直すので、strict だけでは素通りする。
		const relaxedTopSpread = levelSpreadMetrics([a, b, c], [a, v1, b, v2, c]);
		const relaxedTopSpreadReason = validateLevelSpread('top', relaxedTopSpread);
		if (relaxedTopSpreadReason) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: relaxedTopSpreadReason,
				idxs: [a.idx, b.idx, c.idx],
				details: levelSpreadDetailsFrom(relaxedTopSpread, tolTriple),
			});
			continue;
		}

		const relaxedTopSide = validateMainPointsNecklineSide('top', [a, b, c], nlAvg);
		if (relaxedTopSide.reason) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: relaxedTopSide.reason,
				idxs: [a.idx, b.idx, c.idx],
				details: necklineSideDetailsFrom(nlAvg, relaxedTopSide.offenders),
			});
			continue;
		}

		const structureGate = buildStructureGate(gate);

		const breakoutIdx = findBreakoutIdx(candles, c.idx, nlAvg, 'below');
		const isCompleted = breakoutIdx >= 0;
		const rangeEnd = isCompleted ? candles[breakoutIdx]?.isoTime : structureEnd;
		if (!rangeEnd) continue;
		const breakoutPrice = isCompleted ? Number(candles[breakoutIdx]?.close ?? NaN) : NaN;

		// levelMargin は判定に使った tolTriple で正規化する。strict の幅で測ると、緩めた判定に strict の物差しを当てることになる。
		const per = periodScoreBars(c.idx - a.idx);
		const { components: scoreComponents, base } = buildTripleScore({
			points: [a.price, b.price, c.price],
			levelTolerancePct: tolTriple,
			necklinePrice: nlAvg,
			breakoutClose: breakoutPrice,
			side: 'top',
			retracementRatio: gate.retracementRatio,
			durationScore: per,
		});
		const confidence = finalizeConf(base * RELAXED_CONFIDENCE_PENALTY, 'triple_top');
		if (confidence < (MIN_CONFIDENCE.triple_top ?? 0)) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: 'confidence_below_min_relaxed',
				idxs: [a.idx, b.idx, c.idx],
				details: { confidence, threshold: MIN_CONFIDENCE.triple_top ?? 0, ...scoreComponents },
			});
			continue; // 後続候補で confidence が足りるものを探す
		}

		const postGate = isCompleted
			? applyPostBreakoutGates({
					candles,
					pivots,
					side: 'top',
					first: a,
					mid: v1,
					last: c,
					breakoutIdx,
					type: 'triple_top',
					indices: [a.idx, b.idx, c.idx],
					debugCandidates: ctx.debugCandidates,
				})
			: null;

		const neckline = [
			{ x: a.idx, y: nlAvg },
			{ x: isCompleted ? breakoutIdx : c.idx, y: nlAvg },
		];
		const diagram: PatternDiagramData = generatePatternDiagram(
			'triple_top',
			[
				{ ...a, date: candles[a.idx]?.isoTime },
				{ ...v1, date: candles[v1.idx]?.isoTime },
				{ ...b, date: candles[b.idx]?.isoTime },
				{ ...v2, date: candles[v2.idx]?.isoTime },
				{ ...c, date: candles[c.idx]?.isoTime },
			],
			{ price: nlAvg },
			{ start, end: rangeEnd },
			{ tz: ctx.tz, type: ctx.type },
		);
		const ttRelAvgPeak = (a.price + b.price + c.price) / 3;
		const ttRelTarget = Math.round(nlAvg - (ttRelAvgPeak - nlAvg));
		const completionFields = tripleCompletionFields({
			isCompleted,
			candles,
			breakoutIdx,
			breakoutPrice,
			rangeEnd,
			target: ttRelTarget,
			direction: 'down',
			patternHeight: ttRelAvgPeak - nlAvg,
		});
		const entry: DeduplicablePattern = {
			type: 'triple_top',
			confidence,
			scoreComponents,
			range: { start, end: rangeEnd },
			structureRange: { start, end: structureEnd },
			...completionFields,
			...postGate,
			pivots: [a, v1, b, v2, c],
			neckline,
			...(structureGate ? { structureGate } : {}),
			...(priorTrend.precedingTrend ? { precedingTrend: priorTrend.precedingTrend } : {}),
			trendlineLabel: 'ネックライン',
			breakoutTarget: ttRelTarget,
			targetMethod: 'neckline_projection' as const,
			...(diagram ? { structureDiagram: diagram } : {}),
			_fallback: `relaxed_triple_x${factor}`,
		};
		if (entry.status === 'invalid') {
			terminalFallback ??= entry;
			continue;
		}
		return entry;
	}
	return terminalFallback;
}

function findRelaxedTripleBottom(ctx: DetectContext, factor: number): DeduplicablePattern | null {
	const { candles, pivots, allPeaks, tolerancePct, minDist } = ctx;
	const pcand: Pcand = (arg) => pushCand(ctx, arg);
	const tolTriple = tolerancePct * factor;
	const nearTriple = (x: number, y: number) => Math.abs(x - y) / Math.max(1, Math.max(x, y)) <= tolTriple;
	const lowsOnly = pivots.filter((p) => p.kind === 'L');

	let terminalFallback: DeduplicablePattern | null = null;

	for (let i = 0; i <= lowsOnly.length - 3; i++) {
		const a = lowsOnly[i],
			b = lowsOnly[i + 1],
			c = lowsOnly[i + 2];
		if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;
		if (!(nearTriple(a.price, b.price) && nearTriple(b.price, c.price))) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: 'valleys_not_equal_relaxed',
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'valley1', idx: a.idx, price: a.price },
					{ role: 'valley2', idx: b.idx, price: b.price },
					{ role: 'valley3', idx: c.idx, price: c.price },
				],
			});
			continue;
		}
		const start = candles[a.idx].isoTime,
			structureEnd = candles[c.idx].isoTime;
		if (!start || !structureEnd) continue;
		const p1cands = allPeaks.filter((v: { idx: number }) => v.idx > a.idx && v.idx < b.idx);
		const p2cands = allPeaks.filter((v: { idx: number }) => v.idx > b.idx && v.idx < c.idx);
		const p1 = p1cands.length ? p1cands.reduce((m, v) => (v.price > m.price ? v : m)) : null;
		const p2 = p2cands.length ? p2cands.reduce((m, v) => (v.price > m.price ? v : m)) : null;
		if (!(p1 && p2)) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: 'peaks_missing_relaxed',
				idxs: [a.idx, b.idx, c.idx],
			});
			continue;
		}
		const necklineSlope = Math.abs(p1.price - p2.price) / Math.max(1, Math.max(p1.price, p2.price));
		if (necklineSlope > NECKLINE_SLOPE_LIMIT) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: 'neckline_slope_excess_relaxed',
				idxs: [a.idx, b.idx, c.idx],
			});
			continue;
		}
		const priorTrend = validateTriplePriorTrend(ctx, 'triple_bottom', [a.idx, b.idx, c.idx]);
		if (!priorTrend) continue;
		if (rejectCompletedStairStep('triple_bottom', a, b, c, pcand)) continue;
		const sizeReason = validatePatternSize('bottom', [a, p1, b, p2, c], ctx.sizeThresholds);
		if (sizeReason) {
			pcand({ type: 'triple_bottom', accepted: false, reason: sizeReason, idxs: [a.idx, b.idx, c.idx] });
			continue;
		}

		const nlAvg = (p1.price + p2.price) / 2;

		const gate = applyReversalGate({
			candles,
			pivots,
			side: 'bottom',
			first: a,
			mid: p1,
			necklinePrice: nlAvg,
			type: 'triple_bottom',
			indices: [a.idx, b.idx, c.idx],
			debugCandidates: ctx.debugCandidates,
		});
		if (!gate) continue;

		const relaxedBottomSpread = levelSpreadMetrics([a, b, c], [a, p1, b, p2, c]);
		const relaxedBottomSpreadReason = validateLevelSpread('bottom', relaxedBottomSpread);
		if (relaxedBottomSpreadReason) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: relaxedBottomSpreadReason,
				idxs: [a.idx, b.idx, c.idx],
				details: levelSpreadDetailsFrom(relaxedBottomSpread, tolTriple),
			});
			continue;
		}

		const relaxedBottomSide = validateMainPointsNecklineSide('bottom', [a, b, c], nlAvg);
		if (relaxedBottomSide.reason) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: relaxedBottomSide.reason,
				idxs: [a.idx, b.idx, c.idx],
				details: necklineSideDetailsFrom(nlAvg, relaxedBottomSide.offenders),
			});
			continue;
		}

		const structureGate = buildStructureGate(gate);

		const breakoutIdx = findBreakoutIdx(candles, c.idx, nlAvg, 'above');
		const isCompleted = breakoutIdx >= 0;
		const rangeEnd = isCompleted ? candles[breakoutIdx]?.isoTime : structureEnd;
		if (!rangeEnd) continue;
		const breakoutPrice = isCompleted ? Number(candles[breakoutIdx]?.close ?? NaN) : NaN;

		const per = periodScoreBars(c.idx - a.idx);
		const { components: scoreComponents, base } = buildTripleScore({
			points: [a.price, b.price, c.price],
			levelTolerancePct: tolTriple,
			necklinePrice: nlAvg,
			breakoutClose: breakoutPrice,
			side: 'bottom',
			retracementRatio: gate.retracementRatio,
			durationScore: per,
		});
		const confidence = finalizeConf(base * RELAXED_CONFIDENCE_PENALTY, 'triple_bottom');
		if (confidence < (MIN_CONFIDENCE.triple_bottom ?? 0)) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: 'confidence_below_min_relaxed',
				idxs: [a.idx, b.idx, c.idx],
				details: { confidence, threshold: MIN_CONFIDENCE.triple_bottom ?? 0, ...scoreComponents },
			});
			continue; // 後続候補で confidence が足りるものを探す
		}

		const postGate = isCompleted
			? applyPostBreakoutGates({
					candles,
					pivots,
					side: 'bottom',
					first: a,
					mid: p1,
					last: c,
					breakoutIdx,
					type: 'triple_bottom',
					indices: [a.idx, b.idx, c.idx],
					debugCandidates: ctx.debugCandidates,
				})
			: null;

		const neckline = [
			{ x: a.idx, y: nlAvg },
			{ x: isCompleted ? breakoutIdx : c.idx, y: nlAvg },
		];
		const diagram: PatternDiagramData = generatePatternDiagram(
			'triple_bottom',
			[
				{ ...a, date: candles[a.idx]?.isoTime },
				{ ...p1, date: candles[p1.idx]?.isoTime },
				{ ...b, date: candles[b.idx]?.isoTime },
				{ ...p2, date: candles[p2.idx]?.isoTime },
				{ ...c, date: candles[c.idx]?.isoTime },
			],
			{ price: nlAvg },
			{ start, end: rangeEnd },
			{ tz: ctx.tz, type: ctx.type },
		);
		const tbRelAvgValley = (a.price + b.price + c.price) / 3;
		const tbRelTarget = Math.round(nlAvg + (nlAvg - tbRelAvgValley));
		const completionFields = tripleCompletionFields({
			isCompleted,
			candles,
			breakoutIdx,
			breakoutPrice,
			rangeEnd,
			target: tbRelTarget,
			direction: 'up',
			patternHeight: nlAvg - tbRelAvgValley,
		});
		const entry: DeduplicablePattern = {
			type: 'triple_bottom',
			confidence,
			scoreComponents,
			range: { start, end: rangeEnd },
			structureRange: { start, end: structureEnd },
			...completionFields,
			...postGate,
			pivots: [a, p1, b, p2, c],
			neckline,
			...(structureGate ? { structureGate } : {}),
			...(priorTrend.precedingTrend ? { precedingTrend: priorTrend.precedingTrend } : {}),
			trendlineLabel: 'ネックライン',
			breakoutTarget: tbRelTarget,
			targetMethod: 'neckline_projection' as const,
			...(diagram ? { structureDiagram: diagram } : {}),
			_fallback: `relaxed_triple_x${factor}`,
		};
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

	const totalStep = Math.abs(currentPrice - main1.price) / Math.max(1, main1.price);
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
function tryFormingTripleTop(ctx: DetectContext): DeduplicablePattern | null {
	const { candles, pivots, allPeaks, allValleys, tolerancePct, minDist } = ctx;
	const pcand: Pcand = (arg) => pushCand(ctx, arg);
	const lastIdx = candles.length - 1;
	const currentPrice = Number(candles[lastIdx]?.close ?? NaN);
	const isoAt = (i: number) => candles[i]?.isoTime || '';
	const formingBars = getTripleFormingBarParams(ctx.type);
	const tripleTolerancePct = tolerancePct * FORMING_TOLERANCE_MULTIPLIER;
	const levelSpreadLimit = tripleTolerancePct * FORMING_LEVEL_SPREAD_FACTOR;
	const necklineSpreadLimit = tolerancePct * FORMING_NECKLINE_SPREAD_FACTOR;

	if (allPeaks.length < 2) return null;
	const confirmedPeaks = allPeaks.filter((p: { idx: number }) => p.idx < lastIdx - 2);

	for (let i = confirmedPeaks.length - 1; i >= 1; i--) {
		const peak2 = confirmedPeaks[i];
		const peak1 = confirmedPeaks[i - 1];
		if (peak2.idx - peak1.idx < minDist) continue;

		const peakDiff = Math.abs(peak1.price - peak2.price) / Math.max(1, Math.max(peak1.price, peak2.price));
		if (peakDiff > tripleTolerancePct) continue;

		const avgPeakPrice = (peak1.price + peak2.price) / 2;
		const currentDiff = Math.abs(currentPrice - avgPeakPrice) / Math.max(1, avgPeakPrice);
		if (currentDiff > tripleTolerancePct || currentPrice < avgPeakPrice * 0.95) continue;

		if (rejectFormingStairStep('triple_top', peak1, peak2, currentPrice, lastIdx, pcand)) continue;

		// 2 点ずつの判定だけでは非単調な配置（100 → 95 → 100 など）で累積したばらつきを捉えられないので、3 点の max-min でも見る。
		const levelMax = Math.max(peak1.price, peak2.price, currentPrice);
		const levelMin = Math.min(peak1.price, peak2.price, currentPrice);
		const levelSpread = (levelMax - levelMin) / Math.max(1, levelMax);
		if (levelSpread > levelSpreadLimit) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: 'forming_peaks_not_level',
				idxs: [peak1.idx, peak2.idx, lastIdx],
				pts: [
					{ role: 'peak1', idx: peak1.idx, price: peak1.price },
					{ role: 'peak2', idx: peak2.idx, price: peak2.price },
					{ role: 'current', idx: lastIdx, price: currentPrice },
				],
			});
			continue;
		}

		const formationBars = Math.max(0, lastIdx - peak1.idx);
		if (formationBars < formingBars.minBars || formationBars > formingBars.maxBars) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: 'forming_bars_out_of_range',
				idxs: [peak1.idx, peak2.idx, lastIdx],
				pts: [
					{ role: 'peak1', idx: peak1.idx, price: peak1.price },
					{ role: 'peak2', idx: peak2.idx, price: peak2.price },
					{ role: 'current', idx: lastIdx, price: currentPrice },
				],
			});
			continue;
		}
		const priorTrend = validateTriplePriorTrend(ctx, 'triple_top', [peak1.idx, peak2.idx, lastIdx]);
		if (!priorTrend) continue;

		// 谷は区間ごとに要求する。合計数だけ見ると、2 谷とも peak1-peak2 間にある H-L-L-H が通ってしまう。
		const v1Cands = allValleys.filter((v: { idx: number }) => v.idx > peak1.idx && v.idx < peak2.idx);
		const v2Cands = allValleys.filter((v: { idx: number }) => v.idx > peak2.idx && v.idx < lastIdx);
		if (v1Cands.length === 0 || v2Cands.length === 0) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: 'forming_neckline_points_insufficient',
				idxs: [peak1.idx, peak2.idx, lastIdx],
			});
			continue;
		}
		// strict triple_top と同じ方針で、各区間の最安値を採用する。
		const v1 = v1Cands.reduce((m, v) => (v.price < m.price ? v : m));
		const v2 = v2Cands.reduce((m, v) => (v.price < m.price ? v : m));

		const valleyMax = Math.max(v1.price, v2.price);
		const valleyMin = Math.min(v1.price, v2.price);
		const valleySpread = (valleyMax - valleyMin) / Math.max(1, valleyMax);
		if (valleySpread > necklineSpreadLimit) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: 'forming_neckline_not_horizontal',
				idxs: [peak1.idx, peak2.idx, lastIdx],
			});
			continue;
		}

		const progress = Math.min(1, currentPrice / avgPeakPrice);
		const completion = Math.min(1, 0.66 + progress * 0.34);
		const rawConfidence = Math.round((1 - currentDiff / tripleTolerancePct) * 0.8 * 100) / 100;
		const confidence = Math.min(rawConfidence, FORMING_MAX_CONFIDENCE);

		if (completion < FORMING_MIN_COMPLETION || confidence < FORMING_MIN_CONFIDENCE) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: completion < FORMING_MIN_COMPLETION ? 'forming_completion_below_min' : 'forming_confidence_below_min',
				idxs: [peak1.idx, peak2.idx, lastIdx],
				pts: [
					{ role: 'peak1', idx: peak1.idx, price: peak1.price },
					{ role: 'valley1', idx: v1.idx, price: v1.price },
					{ role: 'peak2', idx: peak2.idx, price: peak2.price },
					{ role: 'valley2', idx: v2.idx, price: v2.price },
					{ role: 'current', idx: lastIdx, price: currentPrice },
				],
			});
			continue;
		}

		const sizeReason = validatePatternSize(
			'top',
			[peak1, v1, peak2, v2, { extremePrice: currentPrice }],
			ctx.sizeThresholds,
		);
		if (sizeReason) {
			pcand({ type: 'triple_top', accepted: false, reason: sizeReason, idxs: [peak1.idx, peak2.idx, lastIdx] });
			continue;
		}

		const avgValley = (v1.price + v2.price) / 2;

		const gate = applyReversalGate({
			candles,
			pivots,
			side: 'top',
			first: peak1,
			mid: v1,
			necklinePrice: avgValley,
			type: 'triple_top',
			indices: [peak1.idx, peak2.idx, lastIdx],
			debugCandidates: ctx.debugCandidates,
		});
		if (!gate) continue;

		if (
			rejectFormingNecklineSide(
				'top',
				'triple_top',
				[peak1, peak2, { idx: lastIdx, price: currentPrice }],
				avgValley,
				[peak1.idx, peak2.idx, lastIdx],
				[
					{ role: 'peak1', idx: peak1.idx, price: peak1.price },
					{ role: 'valley1', idx: v1.idx, price: v1.price },
					{ role: 'peak2', idx: peak2.idx, price: peak2.price },
					{ role: 'valley2', idx: v2.idx, price: v2.price },
					{ role: 'current', idx: lastIdx, price: currentPrice },
				],
				pcand,
			)
		) {
			continue;
		}

		const structureGate = buildStructureGate(gate);

		const neckline = [
			{ x: peak1.idx, y: avgValley },
			{ x: lastIdx, y: avgValley },
		];

		const formTtTarget = Math.round(avgValley - ((peak1.price + peak2.price) / 2 - avgValley));

		// idxs は棄却エントリと同じ 3 点にそろえ、ネックラインの 2 谷は pts にだけ載せる。
		pcand({
			type: 'triple_top',
			accepted: true,
			status: 'forming',
			idxs: [peak1.idx, peak2.idx, lastIdx],
			pts: [
				{ role: 'peak1', idx: peak1.idx, price: peak1.price },
				{ role: 'valley1', idx: v1.idx, price: v1.price },
				{ role: 'peak2', idx: peak2.idx, price: peak2.price },
				{ role: 'valley2', idx: v2.idx, price: v2.price },
				{ role: 'current', idx: lastIdx, price: currentPrice },
			],
		});

		return {
			type: 'triple_top',
			confidence,
			range: { start: isoAt(peak1.idx), end: isoAt(lastIdx) },
			status: 'forming',
			// 3 山目は現在価格の暫定値なので pivots に含めない。
			pivots: [
				{ idx: peak1.idx, price: peak1.price, kind: 'H' as const, extremePrice: peak1.extremePrice },
				{ idx: v1.idx, price: v1.price, kind: 'L' as const, extremePrice: v1.extremePrice },
				{ idx: peak2.idx, price: peak2.price, kind: 'H' as const, extremePrice: peak2.extremePrice },
				{ idx: v2.idx, price: v2.price, kind: 'L' as const, extremePrice: v2.extremePrice },
			],
			neckline,
			...(structureGate ? { structureGate } : {}),
			...(priorTrend.precedingTrend ? { precedingTrend: priorTrend.precedingTrend } : {}),
			trendlineLabel: 'ネックライン',
			breakoutTarget: formTtTarget,
			targetMethod: 'neckline_projection' as const,
			...targetReachFields(omittedTargetReach('not_broken_out')),
			completionPct: Math.round(completion * 100),
			_method: 'forming_triple_top',
		};
	}
	return null;
}

function tryFormingTripleBottom(ctx: DetectContext): DeduplicablePattern | null {
	const { candles, pivots, allPeaks, allValleys, tolerancePct, minDist } = ctx;
	const pcand: Pcand = (arg) => pushCand(ctx, arg);
	const lastIdx = candles.length - 1;
	const currentPrice = Number(candles[lastIdx]?.close ?? NaN);
	const isoAt = (i: number) => candles[i]?.isoTime || '';
	const formingBars = getTripleFormingBarParams(ctx.type);
	const tripleTolerancePct = tolerancePct * FORMING_TOLERANCE_MULTIPLIER;
	const levelSpreadLimit = tripleTolerancePct * FORMING_LEVEL_SPREAD_FACTOR;
	const necklineSpreadLimit = tolerancePct * FORMING_NECKLINE_SPREAD_FACTOR;

	if (allValleys.length < 2) return null;
	const confirmedValleys = allValleys.filter((v: { idx: number }) => v.idx < lastIdx - 2);

	for (let i = confirmedValleys.length - 1; i >= 1; i--) {
		const valley2 = confirmedValleys[i];
		const valley1 = confirmedValleys[i - 1];
		if (valley2.idx - valley1.idx < minDist) continue;

		const valleyDiff = Math.abs(valley1.price - valley2.price) / Math.max(1, Math.max(valley1.price, valley2.price));
		if (valleyDiff > tripleTolerancePct) continue;

		const avgValleyPrice = (valley1.price + valley2.price) / 2;

		const p1Cands = allPeaks.filter((p: { idx: number }) => p.idx > valley1.idx && p.idx < valley2.idx);
		const p2Cands = allPeaks.filter((p: { idx: number }) => p.idx > valley2.idx && p.idx < lastIdx);
		if (p1Cands.length === 0 || p2Cands.length === 0) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: 'forming_neckline_points_insufficient',
				idxs: [valley1.idx, valley2.idx, lastIdx],
			});
			continue;
		}
		const pTop1 = p1Cands.reduce((m, p) => (p.price > m.price ? p : m));
		const pTop2 = p2Cands.reduce((m, p) => (p.price > m.price ? p : m));

		const peakMaxN = Math.max(pTop1.price, pTop2.price);
		const peakMinN = Math.min(pTop1.price, pTop2.price);
		const peakSpread = (peakMaxN - peakMinN) / Math.max(1, peakMaxN);
		if (peakSpread > necklineSpreadLimit) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: 'forming_neckline_not_horizontal',
				idxs: [valley1.idx, valley2.idx, lastIdx],
			});
			continue;
		}

		const avgPeakPrice = (pTop1.price + pTop2.price) / 2;

		const currentDiff = Math.abs(currentPrice - avgValleyPrice) / Math.max(1, avgValleyPrice);
		if (currentDiff > tripleTolerancePct || currentPrice > avgValleyPrice * 1.05) continue;

		if (rejectFormingStairStep('triple_bottom', valley1, valley2, currentPrice, lastIdx, pcand)) continue;

		const levelMax = Math.max(valley1.price, valley2.price, currentPrice);
		const levelMin = Math.min(valley1.price, valley2.price, currentPrice);
		const levelSpread = (levelMax - levelMin) / Math.max(1, levelMax);
		if (levelSpread > levelSpreadLimit) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: 'forming_valleys_not_level',
				idxs: [valley1.idx, valley2.idx, lastIdx],
				pts: [
					{ role: 'valley1', idx: valley1.idx, price: valley1.price },
					{ role: 'valley2', idx: valley2.idx, price: valley2.price },
					{ role: 'current', idx: lastIdx, price: currentPrice },
				],
			});
			continue;
		}

		const formationBars = Math.max(0, lastIdx - valley1.idx);
		if (formationBars < formingBars.minBars || formationBars > formingBars.maxBars) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: 'forming_bars_out_of_range',
				idxs: [valley1.idx, valley2.idx, lastIdx],
				pts: [
					{ role: 'valley1', idx: valley1.idx, price: valley1.price },
					{ role: 'valley2', idx: valley2.idx, price: valley2.price },
					{ role: 'current', idx: lastIdx, price: currentPrice },
				],
			});
			continue;
		}
		const priorTrend = validateTriplePriorTrend(ctx, 'triple_bottom', [valley1.idx, valley2.idx, lastIdx]);
		if (!priorTrend) continue;

		const progress = (currentPrice - avgValleyPrice) / Math.max(1e-12, avgPeakPrice - avgValleyPrice);
		const completion = Math.min(1, 0.66 + Math.min(1, progress) * 0.34);
		const rawConfidence = Math.round((1 - valleyDiff / tripleTolerancePct) * 0.8 * 100) / 100;
		const confidence = Math.min(rawConfidence, FORMING_MAX_CONFIDENCE);

		if (completion < FORMING_MIN_COMPLETION || confidence < FORMING_MIN_CONFIDENCE) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: completion < FORMING_MIN_COMPLETION ? 'forming_completion_below_min' : 'forming_confidence_below_min',
				idxs: [valley1.idx, valley2.idx, lastIdx],
				pts: [
					{ role: 'valley1', idx: valley1.idx, price: valley1.price },
					{ role: 'peak1', idx: pTop1.idx, price: pTop1.price },
					{ role: 'valley2', idx: valley2.idx, price: valley2.price },
					{ role: 'peak2', idx: pTop2.idx, price: pTop2.price },
					{ role: 'current', idx: lastIdx, price: currentPrice },
				],
			});
			continue;
		}

		const sizeReason = validatePatternSize(
			'bottom',
			[valley1, pTop1, valley2, pTop2, { extremePrice: currentPrice }],
			ctx.sizeThresholds,
		);
		if (sizeReason) {
			pcand({ type: 'triple_bottom', accepted: false, reason: sizeReason, idxs: [valley1.idx, valley2.idx, lastIdx] });
			continue;
		}

		const gate = applyReversalGate({
			candles,
			pivots,
			side: 'bottom',
			first: valley1,
			mid: pTop1,
			necklinePrice: avgPeakPrice,
			type: 'triple_bottom',
			indices: [valley1.idx, valley2.idx, lastIdx],
			debugCandidates: ctx.debugCandidates,
		});
		if (!gate) continue;

		if (
			rejectFormingNecklineSide(
				'bottom',
				'triple_bottom',
				[valley1, valley2, { idx: lastIdx, price: currentPrice }],
				avgPeakPrice,
				[valley1.idx, valley2.idx, lastIdx],
				[
					{ role: 'valley1', idx: valley1.idx, price: valley1.price },
					{ role: 'peak1', idx: pTop1.idx, price: pTop1.price },
					{ role: 'valley2', idx: valley2.idx, price: valley2.price },
					{ role: 'peak2', idx: pTop2.idx, price: pTop2.price },
					{ role: 'current', idx: lastIdx, price: currentPrice },
				],
				pcand,
			)
		) {
			continue;
		}

		const structureGate = buildStructureGate(gate);

		const neckline = [
			{ x: valley1.idx, y: avgPeakPrice },
			{ x: lastIdx, y: avgPeakPrice },
		];

		const formTbTarget = Math.round(avgPeakPrice + (avgPeakPrice - avgValleyPrice));

		pcand({
			type: 'triple_bottom',
			accepted: true,
			status: 'forming',
			idxs: [valley1.idx, valley2.idx, lastIdx],
			pts: [
				{ role: 'valley1', idx: valley1.idx, price: valley1.price },
				{ role: 'peak1', idx: pTop1.idx, price: pTop1.price },
				{ role: 'valley2', idx: valley2.idx, price: valley2.price },
				{ role: 'peak2', idx: pTop2.idx, price: pTop2.price },
				{ role: 'current', idx: lastIdx, price: currentPrice },
			],
		});

		return {
			type: 'triple_bottom',
			confidence,
			range: { start: isoAt(valley1.idx), end: isoAt(lastIdx) },
			status: 'forming',
			pivots: [
				{ idx: valley1.idx, price: valley1.price, kind: 'L' as const, extremePrice: valley1.extremePrice },
				{ idx: pTop1.idx, price: pTop1.price, kind: 'H' as const, extremePrice: pTop1.extremePrice },
				{ idx: valley2.idx, price: valley2.price, kind: 'L' as const, extremePrice: valley2.extremePrice },
				{ idx: pTop2.idx, price: pTop2.price, kind: 'H' as const, extremePrice: pTop2.extremePrice },
			],
			neckline,
			...(structureGate ? { structureGate } : {}),
			...(priorTrend.precedingTrend ? { precedingTrend: priorTrend.precedingTrend } : {}),
			trendlineLabel: 'ネックライン',
			breakoutTarget: formTbTarget,
			targetMethod: 'neckline_projection' as const,
			...targetReachFields(omittedTargetReach('not_broken_out')),
			completionPct: Math.round(completion * 100),
			_method: 'forming_triple_bottom',
		};
	}
	return null;
}

export function detectTriples(ctx: DetectContext): DetectResult {
	const { want, includeForming } = ctx;
	const patterns: DeduplicablePattern[] = [];

	const wantTripleTop = want.size === 0 || want.has('triple_top');
	const wantTripleBottom = want.size === 0 || want.has('triple_bottom');

	if (wantTripleTop || wantTripleBottom) {
		if (wantTripleTop) patterns.push(...findStrictTripleTop(ctx));
		if (wantTripleBottom) patterns.push(...findStrictTripleBottom(ctx));

		for (const f of RELAXED_TOLERANCE_FACTORS) {
			if (wantTripleTop && !patterns.some((p) => p.type === 'triple_top')) {
				const relaxed = findRelaxedTripleTop(ctx, f);
				if (relaxed) patterns.push(relaxed);
			}
			if (wantTripleBottom && !patterns.some((p) => p.type === 'triple_bottom')) {
				const relaxed = findRelaxedTripleBottom(ctx, f);
				if (relaxed) patterns.push(relaxed);
			}
		}
	}

	if (includeForming && (wantTripleTop || wantTripleBottom)) {
		if (wantTripleTop) {
			const forming = tryFormingTripleTop(ctx);
			if (forming) patterns.push(forming);
		}
		if (wantTripleBottom) {
			const forming = tryFormingTripleBottom(ctx);
			if (forming) patterns.push(forming);
		}
	}

	// dedup に要求外の status を混ぜないよう、detect_wedges.ts と同じく検出器内で先に落とす。
	const filtered = includeForming
		? patterns
		: patterns.filter((p) => p.status !== 'forming' && p.status !== 'near_completion');

	return { patterns: filtered };
}
