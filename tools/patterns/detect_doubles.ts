import { generatePatternDiagram } from '../../lib/pattern-diagrams.js';
import { deduplicatePatterns, finalizeConf, periodScoreDays } from './helpers.js';
import { clamp01, near, relDev } from './regression.js';
import { averageDefinedAxes, breakoutQualityScore, retracementScore } from './scoring.js';
import {
	type BreakoutPathRejectReason,
	buildPrecedingTrend,
	DOUBLE_LEVEL_MAX_PCT,
	detectPivotBeforeBreakout,
	detectTroughZoneReentry,
	findBreakoutIdx,
	isSameLevel,
	levelSpreadDetailsFrom,
	levelSpreadMetrics,
	MAX_BARS_FROM_EXTREMUM,
	necklineSideDetailsFrom,
	type PatternSizeRejectReason,
	type ReversalSide,
	type ReversalStructureResult,
	type SizeThresholds,
	validateLevelDiff,
	validateMainPointsNecklineSide,
	validatePriorTrend,
	validateReversalStructure,
} from './structural.js';
import type { Pivot } from './swing.js';
import { computeTargetReach, omittedTargetReach, targetReachFields } from './target-reach.js';
import {
	type CandleData,
	type DetectContext,
	type DetectResult,
	type PatternConfirmation,
	type PatternEntry,
	type PatternScoreBreakdown,
	type PatternStructureGate,
	pushCand,
} from './types.js';

const RELAXED_TOLERANCE_FACTOR = 1.3;
const RELAXED_CONFIDENCE_PENALTY = 0.85;
// findBreakoutIdx が突破を探す窓と同じ長さにする。過ぎた候補は以後 completed にならないため（#126）。
const FORMING_EXPIRY_BARS = MAX_BARS_FROM_EXTREMUM;

type Pcand = (arg: Parameters<typeof pushCand>[1]) => void;

function buildNecklineConfirmation(candles: CandleData[], breakoutIdx: number): PatternConfirmation | undefined {
	const date = candles[breakoutIdx]?.isoTime;
	if (!date) return undefined;
	return {
		type: 'neckline_breakout',
		date,
		idx: breakoutIdx,
		price: Number(candles[breakoutIdx]?.close ?? NaN),
	};
}

// 値幅は extremePrice で測る（終値だとヒゲの大きい区間で値幅が小さく見える）。同水準判定はヒゲで動かないよう price のまま。
function validateTopSize(
	a: Pick<Pivot, 'extremePrice'>,
	b: Pick<Pivot, 'extremePrice'>,
	c: Pick<Pivot, 'extremePrice'>,
	thresholds: SizeThresholds,
): PatternSizeRejectReason | null {
	const heightPct = Math.abs(a.extremePrice - b.extremePrice) / Math.max(1, Math.max(a.extremePrice, b.extremePrice));
	if (heightPct < thresholds.heightPct) return 'pattern_too_small';
	const peakAvg = (a.extremePrice + c.extremePrice) / 2;
	const valleyDepthPct = (peakAvg - b.extremePrice) / Math.max(1, peakAvg);
	if (valleyDepthPct < thresholds.depthPct) return 'valley_too_shallow';
	return null;
}

function validateBottomSize(
	a: Pick<Pivot, 'extremePrice'>,
	b: Pick<Pivot, 'extremePrice'>,
	c: Pick<Pivot, 'extremePrice'>,
	thresholds: SizeThresholds,
): PatternSizeRejectReason | null {
	const heightPct = Math.abs(a.extremePrice - b.extremePrice) / Math.max(1, Math.max(a.extremePrice, b.extremePrice));
	if (heightPct < thresholds.heightPct) return 'pattern_too_small';
	const valleyAvg = (a.extremePrice + c.extremePrice) / 2;
	const peakHeightPct = (b.extremePrice - valleyAvg) / Math.max(1, valleyAvg);
	if (peakHeightPct < thresholds.depthPct) return 'peak_too_shallow';
	return null;
}

function doublePts(
	side: ReversalSide,
	a: Pivot,
	b: Pivot,
	c: Pivot,
): Array<{ role: string; idx: number; price: number }> {
	const outerRole = side === 'top' ? 'peak' : 'valley';
	const midRole = side === 'top' ? 'valley' : 'peak';
	return [
		{ role: `${outerRole}1`, idx: a.idx, price: a.price },
		{ role: midRole, idx: b.idx, price: b.price },
		{ role: `${outerRole}2`, idx: c.idx, price: c.price },
	];
}

// _relaxed は閾値が緩む検査にだけ付ける。この検査は strict / relaxed で同じなので付けない。
function rejectByLevelDiff(
	side: ReversalSide,
	type: 'double_top' | 'double_bottom',
	a: Pivot,
	b: Pivot,
	c: Pivot,
	levelTolerancePct: number,
	pcand: Pcand,
): boolean {
	const metrics = levelSpreadMetrics([a, c], [a, b, c]);
	const reason = validateLevelDiff(side, metrics);
	if (!reason) return false;
	pcand({
		type,
		accepted: false,
		reason,
		idxs: [a.idx, b.idx, c.idx],
		pts: doublePts(side, a, b, c),
		details: levelSpreadDetailsFrom(metrics, levelTolerancePct),
	});
	return true;
}

// b はネックラインの定義点そのものなので渡さない。渡すと deviation が 0 になり全 double が落ちる。
function rejectByNecklineSide(
	side: ReversalSide,
	type: 'double_top' | 'double_bottom',
	a: Pivot,
	b: Pivot,
	c: Pivot,
	necklinePrice: number,
	pcand: Pcand,
): boolean {
	const { reason, offenders } = validateMainPointsNecklineSide(side, [a, c], necklinePrice);
	if (!reason) return false;
	pcand({
		type,
		accepted: false,
		reason,
		idxs: [a.idx, b.idx, c.idx],
		pts: doublePts(side, a, b, c),
		details: necklineSideDetailsFrom(necklinePrice, offenders),
	});
	return true;
}

function applyStructuralGate(
	candles: CandleData[],
	pivots: ReadonlyArray<Pivot>,
	side: ReversalSide,
	a: Pivot,
	b: Pivot,
	c: Pivot,
	necklinePrice: number,
	type: 'double_top' | 'double_bottom',
	pcand: Pcand,
): ReversalStructureResult | null {
	const gate = validateReversalStructure({ candles, pivots, first: a, mid: b, necklinePrice, side });
	if (gate.ok) return gate;
	pcand({
		type,
		accepted: false,
		reason: gate.reason,
		idxs: [a.idx, b.idx, c.idx],
		pts: [
			...(gate.priorExtreme
				? [{ role: 'prior_extreme', idx: gate.priorExtreme.idx, price: gate.priorExtreme.extremePrice }]
				: []),
			...doublePts(side, a, b, c),
		],
	});
	return null;
}

function buildStructureGate(gate: ReversalStructureResult): PatternStructureGate | undefined {
	const out: PatternStructureGate = {};
	if (gate.retracementRatio !== undefined) out.retracementRatio = Number(gate.retracementRatio.toFixed(4));
	if (gate.priorExtreme) {
		out.priorExtremeIdx = gate.priorExtreme.idx;
		out.priorExtremePrice = gate.priorExtreme.extremePrice;
	}
	if (gate.necklineCrossIdx !== undefined) out.necklineCrossIdx = gate.necklineCrossIdx;
	if (gate.skipped !== undefined) out.skipped = gate.skipped;
	return Object.keys(out).length > 0 ? out : undefined;
}

function buildDoubleScore(opts: {
	outer1: number;
	outer2: number;
	necklinePrice: number;
	breakoutClose: number;
	patternHeight: number;
	side: ReversalSide;
	retracementRatio?: number;
	durationScore: number;
}): { components: PatternScoreBreakdown; base: number } {
	const symmetry = clamp01(1 - relDev(opts.outer1, opts.outer2));
	const retracement = retracementScore(opts.retracementRatio);
	const breakoutQuality = breakoutQualityScore(opts.necklinePrice, opts.breakoutClose, opts.patternHeight, opts.side);
	const components: PatternScoreBreakdown = {
		symmetry: Number(symmetry.toFixed(4)),
		...(retracement !== undefined ? { retracement: Number(retracement.toFixed(4)) } : {}),
		...(breakoutQuality !== undefined ? { breakoutQuality: Number(breakoutQuality.toFixed(4)) } : {}),
		duration: Number(opts.durationScore.toFixed(4)),
	};
	// symmetry は常に数値なので averageDefinedAxes は undefined を返さない（?? には届かない）。
	const base = averageDefinedAxes([symmetry, retracement, breakoutQuality, opts.durationScore]) ?? symmetry;
	return { components, base };
}

// 第3構成点がある候補は detect_triples に委ね、ここでは出さない。
function checkPostPivotInvalidation(opts: {
	candles: CandleData[];
	pivots: ReadonlyArray<Pivot>;
	a: Pivot;
	b: Pivot;
	c: Pivot;
	untilIdx: number;
	side: ReversalSide;
}): { verdict: 'ok' } | { verdict: 'reclassify' } | { verdict: 'invalid'; reason: string; idx?: number } {
	const reentry = detectTroughZoneReentry({
		candles: opts.candles,
		first: opts.a,
		mid: opts.b,
		second: opts.c,
		untilIdx: opts.untilIdx,
		side: opts.side,
	});
	if (!reentry.reentered) return { verdict: 'ok' };

	const level = (opts.a.price + opts.c.price) / 2;
	const kind = opts.side === 'bottom' ? 'L' : 'H';
	const hasThird = opts.pivots.some(
		(p) => p.idx > opts.c.idx && p.kind === kind && isSameLevel(p.price, level, DOUBLE_LEVEL_MAX_PCT),
	);
	if (hasThird) return { verdict: 'reclassify' };
	return { verdict: 'invalid', reason: 're_entered_trough_zone', idx: reentry.idx };
}

type DoubleTerminal = { status: 'invalid'; invalidReason: string };

type DoubleUnbrokenStatus =
	| { status: 'near_completion' }
	| { status: 'expired'; invalidReason: string }
	| { status: 'invalid'; invalidReason: string };

function unbrokenStatusFields(opts: {
	post: ReturnType<typeof checkPostPivotInvalidation>;
	lastPivotIdx: number;
	lastIdx: number;
}): DoubleUnbrokenStatus {
	if (opts.post.verdict === 'invalid') return { status: 'invalid', invalidReason: opts.post.reason };
	if (opts.lastIdx - opts.lastPivotIdx > FORMING_EXPIRY_BARS)
		return { status: 'expired', invalidReason: 'forming_expired' };
	return { status: 'near_completion' };
}

// 既定では invalid のエントリが出力から消えるので、理由を debug の候補にも残す。
function checkBreakoutPath(opts: {
	pivots: ReadonlyArray<Pivot>;
	side: ReversalSide;
	type: 'double_top' | 'double_bottom';
	a: Pivot;
	b: Pivot;
	c: Pivot;
	breakoutIdx: number;
	pcand: Pcand;
}): DoubleTerminal | null {
	const { pivots, side, type, a, b, c, breakoutIdx, pcand } = opts;
	const res = detectPivotBeforeBreakout({ pivots, lastPivotIdx: c.idx, breakoutIdx, side });
	if (!res.found || !res.reason) return null;
	const outerRole = side === 'top' ? 'peak' : 'valley';
	pcand({
		type,
		accepted: false,
		reason: res.reason,
		idxs: [a.idx, b.idx, c.idx],
		pts: [
			...doublePts(side, a, b, c),
			...(res.pivot ? [{ role: `${outerRole}_after_last`, idx: res.pivot.idx, price: res.pivot.price }] : []),
		],
		details: breakoutPathDetails(c.idx, breakoutIdx, res.pivot),
	});
	return { status: 'invalid', invalidReason: res.reason satisfies BreakoutPathRejectReason };
}

function breakoutPathDetails(
	lastPivotIdx: number,
	breakoutIdx: number,
	offender: Pivot | undefined,
): Record<string, unknown> {
	return {
		lastPivotIdx,
		breakoutIdx,
		...(offender
			? { offenderIdx: offender.idx, offenderPrice: offender.price, offenderExtremePrice: offender.extremePrice }
			: {}),
	};
}

function findRelaxedDoubleTop(ctx: DetectContext, factor: number): PatternEntry | null {
	const { candles, pivots, tolerancePct, minDist, sizeThresholds, tz, type, includeForming, priorTrendParams } = ctx;
	const pcand: Pcand = (arg) => pushCand(ctx, arg);
	const tolRelax = tolerancePct * factor;
	const lastIdx = candles.length - 1;
	const nearRelaxed = (x: number, y: number) => Math.abs(x - y) <= Math.max(x, y) * tolRelax;

	// 完成済み以外で打ち切ると、後ろにある完成済みの候補まで失われるので退避して走査を続ける（#242）。
	let nonCompletedFallback: PatternEntry | null = null;

	for (let i = 0; i + 2 < pivots.length; i++) {
		const a = pivots[i],
			b = pivots[i + 1],
			c = pivots[i + 2];
		if (!(a.kind === 'H' && b.kind === 'L' && c.kind === 'H')) continue;
		if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;

		const sizeReason = validateTopSize(a, b, c, sizeThresholds);
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
		const isCompleted = breakoutIdx >= 0;
		// includeForming が false なら未ブレイクは出力されないので組み立てない。組んでも debug の上限を食うだけ。
		if (!isCompleted && !includeForming) {
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
		const gate = applyStructuralGate(candles, pivots, 'top', a, b, c, necklinePrice, 'double_top', pcand);
		if (!gate) continue;

		const post = checkPostPivotInvalidation({
			candles,
			pivots,
			a,
			b,
			c,
			untilIdx: isCompleted ? breakoutIdx - 1 : lastIdx,
			side: 'top',
		});
		if (post.verdict === 'reclassify') {
			pcand({
				type: 'double_top',
				accepted: false,
				reason: 'reclassified_as_triple_top',
				idxs: [a.idx, b.idx, c.idx],
			});
			continue;
		}
		if (rejectByLevelDiff('top', 'double_top', a, b, c, Math.min(tolRelax, DOUBLE_LEVEL_MAX_PCT), pcand)) continue;
		if (rejectByNecklineSide('top', 'double_top', a, b, c, necklinePrice, pcand)) continue;
		// 先に付いた invalid の理由を上書きしないよう、post が ok のときだけ掛ける。
		const pathTerminal =
			isCompleted && post.verdict === 'ok'
				? checkBreakoutPath({ pivots, side: 'top', type: 'double_top', a, b, c, breakoutIdx, pcand })
				: null;
		// 先行トレンドは構造・再進入・経路のゲートより後に見る。先に止めると debug が構造の不備を報告できない。
		const trend = validatePriorTrend(
			candles,
			a.idx,
			(isCompleted ? breakoutIdx : lastIdx) - a.idx,
			'up',
			priorTrendParams,
		);
		if (post.verdict === 'ok' && !pathTerminal && !trend.ok) {
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
			end = isCompleted ? candles[breakoutIdx]?.isoTime : candles[c.idx]?.isoTime;
		if (!start || !end) continue;

		const neckline = [
			{ x: a.idx, y: necklinePrice },
			{ x: isCompleted ? breakoutIdx : c.idx, y: necklinePrice },
		];
		const per = periodScoreDays(start, end);
		const dtRelAvgPeak = (a.price + c.price) / 2;
		const dtRelBp = isCompleted ? Number(candles[breakoutIdx]?.close ?? NaN) : NaN;
		const { components: scoreComponents, base } = buildDoubleScore({
			outer1: a.price,
			outer2: c.price,
			necklinePrice,
			breakoutClose: dtRelBp,
			patternHeight: dtRelAvgPeak - necklinePrice,
			side: 'top',
			retracementRatio: gate.retracementRatio,
			durationScore: per,
		});
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
			{ tz, type },
		);
		const dtRelTarget = Math.round(necklinePrice - (dtRelAvgPeak - necklinePrice));
		// 測れない理由を名乗る。breakoutTarget だけを出すと LLM が「進捗 0%」と読み違える（#224）。
		const dtRelReach = !isCompleted
			? omittedTargetReach('not_broken_out')
			: Number.isFinite(dtRelBp)
				? computeTargetReach(candles, breakoutIdx, dtRelBp, dtRelTarget, 'down', dtRelAvgPeak - necklinePrice)
				: omittedTargetReach('invalid_breakout_price');
		const structureRange =
			candles[a.idx]?.isoTime && candles[c.idx]?.isoTime
				? { start: candles[a.idx].isoTime as string, end: candles[c.idx].isoTime as string }
				: undefined;
		const confirmation = isCompleted
			? buildNecklineConfirmation(candles, breakoutIdx)
			: ({ type: 'not_confirmed' } as const);
		const precedingTrend = buildPrecedingTrend(candles, trend, a.idx);

		const structureGate = buildStructureGate(gate);
		const unbroken = isCompleted ? null : unbrokenStatusFields({ post, lastPivotIdx: c.idx, lastIdx });

		const entry: PatternEntry = {
			type: 'double_top',
			confidence,
			scoreComponents,
			...(structureGate ? { structureGate } : {}),
			range: { start, end },
			...(structureRange ? { structureRange } : {}),
			...(confirmation ? { confirmation } : {}),
			...(precedingTrend ? { precedingTrend } : {}),
			...(unbroken ??
				(post.verdict === 'invalid'
					? { status: 'invalid' as const, invalidReason: post.reason }
					: (pathTerminal ?? {}))),
			pivots: [a, b, c],
			neckline,
			trendlineLabel: 'ネックライン',
			...(isCompleted ? { breakout: { idx: breakoutIdx, price: dtRelBp }, breakoutBarIndex: breakoutIdx } : {}),
			breakoutTarget: dtRelTarget,
			targetMethod: 'neckline_projection' as const,
			...targetReachFields(dtRelReach),
			structureDiagram: diagram,
			_fallback: `relaxed_double_x${factor}`,
		};
		if (entry.status !== undefined) {
			nonCompletedFallback ??= entry;
			continue;
		}
		return entry;
	}
	return nonCompletedFallback;
}

function findRelaxedDoubleBottom(ctx: DetectContext, factor: number): PatternEntry | null {
	const { candles, pivots, tolerancePct, minDist, sizeThresholds, tz, type, includeForming, priorTrendParams } = ctx;
	const pcand: Pcand = (arg) => pushCand(ctx, arg);
	const tolRelax = tolerancePct * factor;
	const lastIdx = candles.length - 1;
	const nearRelaxed = (x: number, y: number) => Math.abs(x - y) <= Math.max(x, y) * tolRelax;

	let nonCompletedFallback: PatternEntry | null = null;

	for (let i = 0; i + 2 < pivots.length; i++) {
		const a = pivots[i],
			b = pivots[i + 1],
			c = pivots[i + 2];
		if (!(a.kind === 'L' && b.kind === 'H' && c.kind === 'L')) continue;
		if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;

		const sizeReason = validateBottomSize(a, b, c, sizeThresholds);
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
		const isCompleted = breakoutIdx >= 0;
		if (!isCompleted && !includeForming) {
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
		const gate = applyStructuralGate(candles, pivots, 'bottom', a, b, c, necklinePrice, 'double_bottom', pcand);
		if (!gate) continue;

		const post = checkPostPivotInvalidation({
			candles,
			pivots,
			a,
			b,
			c,
			untilIdx: isCompleted ? breakoutIdx - 1 : lastIdx,
			side: 'bottom',
		});
		if (post.verdict === 'reclassify') {
			pcand({
				type: 'double_bottom',
				accepted: false,
				reason: 'reclassified_as_triple_bottom',
				idxs: [a.idx, b.idx, c.idx],
			});
			continue;
		}
		if (rejectByLevelDiff('bottom', 'double_bottom', a, b, c, Math.min(tolRelax, DOUBLE_LEVEL_MAX_PCT), pcand))
			continue;
		if (rejectByNecklineSide('bottom', 'double_bottom', a, b, c, necklinePrice, pcand)) continue;
		const pathTerminal =
			isCompleted && post.verdict === 'ok'
				? checkBreakoutPath({ pivots, side: 'bottom', type: 'double_bottom', a, b, c, breakoutIdx, pcand })
				: null;
		const trend = validatePriorTrend(
			candles,
			a.idx,
			(isCompleted ? breakoutIdx : lastIdx) - a.idx,
			'down',
			priorTrendParams,
		);
		if (post.verdict === 'ok' && !pathTerminal && !trend.ok) {
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
			end = isCompleted ? candles[breakoutIdx]?.isoTime : candles[c.idx]?.isoTime;
		if (!start || !end) continue;

		const neckline = [
			{ x: a.idx, y: necklinePrice },
			{ x: isCompleted ? breakoutIdx : c.idx, y: necklinePrice },
		];
		const per = periodScoreDays(start, end);
		const dbRelAvgValley = (a.price + c.price) / 2;
		const dbRelBp = isCompleted ? Number(candles[breakoutIdx]?.close ?? NaN) : NaN;
		const { components: scoreComponents, base } = buildDoubleScore({
			outer1: a.price,
			outer2: c.price,
			necklinePrice,
			breakoutClose: dbRelBp,
			patternHeight: necklinePrice - dbRelAvgValley,
			side: 'bottom',
			retracementRatio: gate.retracementRatio,
			durationScore: per,
		});
		const confidence = finalizeConf(base * RELAXED_CONFIDENCE_PENALTY, 'double_bottom');
		const diagram = generatePatternDiagram(
			'double_bottom',
			[
				{ ...a, date: candles[a.idx]?.isoTime },
				{ ...b, date: candles[b.idx]?.isoTime },
				{ ...c, date: candles[c.idx]?.isoTime },
			],
			{ price: necklinePrice },
			{ start, end },
			{ tz, type },
		);
		const dbRelTarget = Math.round(necklinePrice + (necklinePrice - dbRelAvgValley));
		const dbRelReach = !isCompleted
			? omittedTargetReach('not_broken_out')
			: Number.isFinite(dbRelBp)
				? computeTargetReach(candles, breakoutIdx, dbRelBp, dbRelTarget, 'up', necklinePrice - dbRelAvgValley)
				: omittedTargetReach('invalid_breakout_price');
		const structureRange =
			candles[a.idx]?.isoTime && candles[c.idx]?.isoTime
				? { start: candles[a.idx].isoTime as string, end: candles[c.idx].isoTime as string }
				: undefined;
		const confirmation = isCompleted
			? buildNecklineConfirmation(candles, breakoutIdx)
			: ({ type: 'not_confirmed' } as const);
		const precedingTrend = buildPrecedingTrend(candles, trend, a.idx);

		const structureGate = buildStructureGate(gate);
		const unbroken = isCompleted ? null : unbrokenStatusFields({ post, lastPivotIdx: c.idx, lastIdx });

		const entry: PatternEntry = {
			type: 'double_bottom',
			confidence,
			scoreComponents,
			...(structureGate ? { structureGate } : {}),
			range: { start, end },
			...(structureRange ? { structureRange } : {}),
			...(confirmation ? { confirmation } : {}),
			...(precedingTrend ? { precedingTrend } : {}),
			...(unbroken ??
				(post.verdict === 'invalid'
					? { status: 'invalid' as const, invalidReason: post.reason }
					: (pathTerminal ?? {}))),
			pivots: [a, b, c],
			neckline,
			trendlineLabel: 'ネックライン',
			...(isCompleted ? { breakout: { idx: breakoutIdx, price: dbRelBp }, breakoutBarIndex: breakoutIdx } : {}),
			breakoutTarget: dbRelTarget,
			targetMethod: 'neckline_projection' as const,
			...targetReachFields(dbRelReach),
			structureDiagram: diagram,
			_fallback: `relaxed_double_x${factor}`,
		};
		if (entry.status !== undefined) {
			nonCompletedFallback ??= entry;
			continue;
		}
		return entry;
	}
	return nonCompletedFallback;
}

// double は forming を出さない。最終構成点が 1 つしか無く、暫定値で埋めると double だけの例外が仕様に増えるため（#268）。
export function detectDoubles(ctx: DetectContext): DetectResult {
	const { candles, pivots, tolerancePct, want, includeForming, minDist } = ctx;
	const pcand: Pcand = (arg) => pushCand(ctx, arg);
	const lastIdx = candles.length - 1;
	const levelTolerancePct = Math.min(tolerancePct, DOUBLE_LEVEL_MAX_PCT);
	let patterns: PatternEntry[] = [];

	let foundDoubleTop = false,
		foundDoubleBottom = false;
	if (want.size === 0 || want.has('double_top') || want.has('double_bottom')) {
		for (let i = 0; i + 2 < pivots.length; i++) {
			const a = pivots[i];
			const b = pivots[i + 1];
			const c = pivots[i + 2];
			if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;

			if (a.kind === 'H' && b.kind === 'L' && c.kind === 'H') {
				const sizeReason = validateTopSize(a, b, c, ctx.sizeThresholds);
				if (sizeReason) {
					pcand({ type: 'double_top', accepted: false, reason: sizeReason, idxs: [a.idx, b.idx, c.idx] });
					continue;
				}
				if (!near(a.price, c.price, tolerancePct)) {
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
				const necklinePrice = b.price;
				const breakoutIdx = findBreakoutIdx(candles, c.idx, necklinePrice, 'below');
				const isCompleted = breakoutIdx >= 0;
				if (!isCompleted && !includeForming) {
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
				const gate = applyStructuralGate(candles, pivots, 'top', a, b, c, necklinePrice, 'double_top', pcand);
				if (!gate) continue;
				const post = checkPostPivotInvalidation({
					candles,
					pivots,
					a,
					b,
					c,
					untilIdx: isCompleted ? breakoutIdx - 1 : lastIdx,
					side: 'top',
				});
				if (post.verdict === 'reclassify') {
					pcand({
						type: 'double_top',
						accepted: false,
						reason: 'reclassified_as_triple_top',
						idxs: [a.idx, b.idx, c.idx],
					});
					continue;
				}
				if (rejectByLevelDiff('top', 'double_top', a, b, c, levelTolerancePct, pcand)) continue;
				if (rejectByNecklineSide('top', 'double_top', a, b, c, necklinePrice, pcand)) continue;
				const pathTerminal =
					isCompleted && post.verdict === 'ok'
						? checkBreakoutPath({ pivots, side: 'top', type: 'double_top', a, b, c, breakoutIdx, pcand })
						: null;
				const trend = validatePriorTrend(
					candles,
					a.idx,
					(isCompleted ? breakoutIdx : lastIdx) - a.idx,
					'up',
					ctx.priorTrendParams,
				);
				if (post.verdict === 'ok' && !pathTerminal && !trend.ok) {
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
				// 未ブレイクの range.end は第2構成点。detect_triples の near_completion とそろえている。
				const end = isCompleted ? candles[breakoutIdx]?.isoTime : candles[c.idx]?.isoTime;
				if (!start || !end) continue;
				const neckline = [
					{ x: a.idx, y: necklinePrice },
					{ x: isCompleted ? breakoutIdx : c.idx, y: necklinePrice },
				];
				const per = periodScoreDays(start, end);
				const dtAvgPeak = (a.price + c.price) / 2;
				// 未ブレイクは NaN にして、breakoutQualityScore に軸ごと外させる。
				const dtBp = isCompleted ? Number(candles[breakoutIdx]?.close ?? NaN) : NaN;
				const { components: dtScoreComponents, base } = buildDoubleScore({
					outer1: a.price,
					outer2: c.price,
					necklinePrice,
					breakoutClose: dtBp,
					patternHeight: dtAvgPeak - necklinePrice,
					side: 'top',
					retracementRatio: gate.retracementRatio,
					durationScore: per,
				});
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
					{ tz: ctx.tz, type: ctx.type },
				);
				const dtTarget = Math.round(necklinePrice - (dtAvgPeak - necklinePrice));
				const dtReach = !isCompleted
					? omittedTargetReach('not_broken_out')
					: Number.isFinite(dtBp)
						? computeTargetReach(candles, breakoutIdx, dtBp, dtTarget, 'down', dtAvgPeak - necklinePrice)
						: omittedTargetReach('invalid_breakout_price');
				const dtStructureRange =
					candles[a.idx]?.isoTime && candles[c.idx]?.isoTime
						? { start: candles[a.idx].isoTime as string, end: candles[c.idx].isoTime as string }
						: undefined;
				const dtConfirmation = isCompleted
					? buildNecklineConfirmation(candles, breakoutIdx)
					: ({ type: 'not_confirmed' } as const);
				const dtPrecedingTrend = buildPrecedingTrend(candles, trend, a.idx);
				const dtStructureGate = buildStructureGate(gate);
				const dtUnbroken = isCompleted ? null : unbrokenStatusFields({ post, lastPivotIdx: c.idx, lastIdx });
				patterns.push({
					type: 'double_top',
					confidence,
					scoreComponents: dtScoreComponents,
					...(dtStructureGate ? { structureGate: dtStructureGate } : {}),
					range: { start, end },
					...(dtStructureRange ? { structureRange: dtStructureRange } : {}),
					...(dtConfirmation ? { confirmation: dtConfirmation } : {}),
					...(dtPrecedingTrend ? { precedingTrend: dtPrecedingTrend } : {}),
					...(dtUnbroken ??
						(post.verdict === 'invalid'
							? { status: 'invalid' as const, invalidReason: post.reason }
							: (pathTerminal ?? {}))),
					pivots: [a, b, c],
					neckline,
					trendlineLabel: 'ネックライン',
					...(isCompleted ? { breakout: { idx: breakoutIdx, price: dtBp }, breakoutBarIndex: breakoutIdx } : {}),
					breakoutTarget: dtTarget,
					targetMethod: 'neckline_projection' as const,
					...targetReachFields(dtReach),
					structureDiagram: diagram,
				});
				// completed のときだけ立てる。near_completion で立てると relaxed が走らず、別の構成点の completed が消える。
				if (isCompleted) foundDoubleTop = true;
				pcand({
					type: 'double_top',
					accepted: true,
					// 未ブレイクは組み立て時点の status を出す（#158。'completed' と誤読させない）。
					...(dtUnbroken ? { status: dtUnbroken.status } : {}),
					idxs: isCompleted ? [a.idx, b.idx, c.idx, breakoutIdx] : [a.idx, b.idx, c.idx],
					pts: [
						{ role: 'peak1', idx: a.idx, price: a.price },
						{ role: 'valley', idx: b.idx, price: b.price },
						{ role: 'peak2', idx: c.idx, price: c.price },
						...(isCompleted ? [{ role: 'breakout', idx: breakoutIdx, price: dtBp }] : []),
					],
				});
				continue;
			}

			if (a.kind === 'L' && b.kind === 'H' && c.kind === 'L') {
				const sizeReason = validateBottomSize(a, b, c, ctx.sizeThresholds);
				if (sizeReason) {
					pcand({ type: 'double_bottom', accepted: false, reason: sizeReason, idxs: [a.idx, b.idx, c.idx] });
					continue;
				}
				if (!near(a.price, c.price, tolerancePct)) {
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
				const necklinePrice = b.price;
				const breakoutIdx = findBreakoutIdx(candles, c.idx, necklinePrice, 'above');
				const isCompleted = breakoutIdx >= 0;
				if (!isCompleted && !includeForming) {
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
				const gate = applyStructuralGate(candles, pivots, 'bottom', a, b, c, necklinePrice, 'double_bottom', pcand);
				if (!gate) continue;
				const post = checkPostPivotInvalidation({
					candles,
					pivots,
					a,
					b,
					c,
					untilIdx: isCompleted ? breakoutIdx - 1 : lastIdx,
					side: 'bottom',
				});
				if (post.verdict === 'reclassify') {
					pcand({
						type: 'double_bottom',
						accepted: false,
						reason: 'reclassified_as_triple_bottom',
						idxs: [a.idx, b.idx, c.idx],
					});
					continue;
				}
				if (rejectByLevelDiff('bottom', 'double_bottom', a, b, c, levelTolerancePct, pcand)) continue;
				if (rejectByNecklineSide('bottom', 'double_bottom', a, b, c, necklinePrice, pcand)) continue;
				const pathTerminal =
					isCompleted && post.verdict === 'ok'
						? checkBreakoutPath({ pivots, side: 'bottom', type: 'double_bottom', a, b, c, breakoutIdx, pcand })
						: null;
				const trend = validatePriorTrend(
					candles,
					a.idx,
					(isCompleted ? breakoutIdx : lastIdx) - a.idx,
					'down',
					ctx.priorTrendParams,
				);
				if (post.verdict === 'ok' && !pathTerminal && !trend.ok) {
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
				const end = isCompleted ? candles[breakoutIdx]?.isoTime : candles[c.idx]?.isoTime;
				if (!start || !end) continue;
				const neckline = [
					{ x: a.idx, y: necklinePrice },
					{ x: isCompleted ? breakoutIdx : c.idx, y: necklinePrice },
				];
				const per = periodScoreDays(start, end);
				const dbAvgValley = (a.price + c.price) / 2;
				const dbBp = isCompleted ? Number(candles[breakoutIdx]?.close ?? NaN) : NaN;
				const { components: dbScoreComponents, base } = buildDoubleScore({
					outer1: a.price,
					outer2: c.price,
					necklinePrice,
					breakoutClose: dbBp,
					patternHeight: necklinePrice - dbAvgValley,
					side: 'bottom',
					retracementRatio: gate.retracementRatio,
					durationScore: per,
				});
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
					{ tz: ctx.tz, type: ctx.type },
				);
				const dbTarget = Math.round(necklinePrice + (necklinePrice - dbAvgValley));
				const dbReach = !isCompleted
					? omittedTargetReach('not_broken_out')
					: Number.isFinite(dbBp)
						? computeTargetReach(candles, breakoutIdx, dbBp, dbTarget, 'up', necklinePrice - dbAvgValley)
						: omittedTargetReach('invalid_breakout_price');
				const dbStructureRange =
					candles[a.idx]?.isoTime && candles[c.idx]?.isoTime
						? { start: candles[a.idx].isoTime as string, end: candles[c.idx].isoTime as string }
						: undefined;
				const dbConfirmation = isCompleted
					? buildNecklineConfirmation(candles, breakoutIdx)
					: ({ type: 'not_confirmed' } as const);
				const dbPrecedingTrend = buildPrecedingTrend(candles, trend, a.idx);
				const dbStructureGate = buildStructureGate(gate);
				const dbUnbroken = isCompleted ? null : unbrokenStatusFields({ post, lastPivotIdx: c.idx, lastIdx });
				patterns.push({
					type: 'double_bottom',
					confidence,
					scoreComponents: dbScoreComponents,
					...(dbStructureGate ? { structureGate: dbStructureGate } : {}),
					range: { start, end },
					...(dbStructureRange ? { structureRange: dbStructureRange } : {}),
					...(dbConfirmation ? { confirmation: dbConfirmation } : {}),
					...(dbPrecedingTrend ? { precedingTrend: dbPrecedingTrend } : {}),
					...(dbUnbroken ??
						(post.verdict === 'invalid'
							? { status: 'invalid' as const, invalidReason: post.reason }
							: (pathTerminal ?? {}))),
					pivots: [a, b, c],
					neckline,
					trendlineLabel: 'ネックライン',
					...(isCompleted ? { breakout: { idx: breakoutIdx, price: dbBp }, breakoutBarIndex: breakoutIdx } : {}),
					breakoutTarget: dbTarget,
					targetMethod: 'neckline_projection' as const,
					...targetReachFields(dbReach),
					structureDiagram: diagram,
				});
				if (isCompleted) foundDoubleBottom = true;
				pcand({
					type: 'double_bottom',
					accepted: true,
					...(dbUnbroken ? { status: dbUnbroken.status } : {}),
					idxs: isCompleted ? [a.idx, b.idx, c.idx, breakoutIdx] : [a.idx, b.idx, c.idx],
					pts: [
						{ role: 'valley1', idx: a.idx, price: a.price },
						{ role: 'peak', idx: b.idx, price: b.price },
						{ role: 'valley2', idx: c.idx, price: c.price },
						...(isCompleted ? [{ role: 'breakout', idx: breakoutIdx, price: dbBp }] : []),
					],
				});
			}
		}
		if (!foundDoubleTop && (want.size === 0 || want.has('double_top'))) {
			const result = findRelaxedDoubleTop(ctx, RELAXED_TOLERANCE_FACTOR);
			if (result) {
				patterns.push(result);
				foundDoubleTop = true;
			}
		}
		if (!foundDoubleBottom && (want.size === 0 || want.has('double_bottom'))) {
			const result = findRelaxedDoubleBottom(ctx, RELAXED_TOLERANCE_FACTOR);
			if (result) {
				patterns.push(result);
				foundDoubleBottom = true;
			}
		}
		patterns = deduplicatePatterns(patterns);
	}

	return { patterns, found: { double_top: foundDoubleTop, double_bottom: foundDoubleBottom } };
}
