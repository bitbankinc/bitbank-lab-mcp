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

interface DoubleSide {
	type: 'double_top' | 'double_bottom';
	shallowReason: 'valley_too_shallow' | 'peak_too_shallow';
	notEqualReason: 'peaks_not_equal' | 'valleys_not_equal';
	reclassifiedReason: 'reclassified_as_triple_top' | 'reclassified_as_triple_bottom';
	breakoutDirection: 'below' | 'above';
	priorTrend: 'up' | 'down';
	targetDirection: 'down' | 'up';
}

const DOUBLE_SIDES: Record<ReversalSide, DoubleSide> = {
	top: {
		type: 'double_top',
		shallowReason: 'valley_too_shallow',
		notEqualReason: 'peaks_not_equal',
		reclassifiedReason: 'reclassified_as_triple_top',
		breakoutDirection: 'below',
		priorTrend: 'up',
		targetDirection: 'down',
	},
	bottom: {
		type: 'double_bottom',
		shallowReason: 'peak_too_shallow',
		notEqualReason: 'valleys_not_equal',
		reclassifiedReason: 'reclassified_as_triple_bottom',
		breakoutDirection: 'above',
		priorTrend: 'down',
		targetDirection: 'up',
	},
};

function doubleSideOf(a: Pivot, b: Pivot, c: Pivot): ReversalSide | null {
	if (a.kind === 'H' && b.kind === 'L' && c.kind === 'H') return 'top';
	if (a.kind === 'L' && b.kind === 'H' && c.kind === 'L') return 'bottom';
	return null;
}

// 値幅は extremePrice で測る（終値だとヒゲの大きい区間で値幅が小さく見える）。同水準判定はヒゲで動かないよう price のまま。
function validateDoubleSize(
	side: ReversalSide,
	a: Pick<Pivot, 'extremePrice'>,
	b: Pick<Pivot, 'extremePrice'>,
	c: Pick<Pivot, 'extremePrice'>,
	thresholds: SizeThresholds,
): PatternSizeRejectReason | null {
	const heightPct = Math.abs(a.extremePrice - b.extremePrice) / Math.max(1, Math.max(a.extremePrice, b.extremePrice));
	if (heightPct < thresholds.heightPct) return 'pattern_too_small';
	const outerAvg = (a.extremePrice + c.extremePrice) / 2;
	const middleDepth = side === 'top' ? outerAvg - b.extremePrice : b.extremePrice - outerAvg;
	if (middleDepth / Math.max(1, outerAvg) < thresholds.depthPct) return DOUBLE_SIDES[side].shallowReason;
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

function evaluateDouble(
	ctx: DetectContext,
	side: ReversalSide,
	a: Pivot,
	b: Pivot,
	c: Pivot,
	relaxedFactor: number | null,
): { entry: PatternEntry; isCompleted: boolean } | null {
	const { candles, pivots, tolerancePct, includeForming } = ctx;
	const spec = DOUBLE_SIDES[side];
	const { type } = spec;
	const pcand: Pcand = (arg) => pushCand(ctx, arg);
	const relaxed = relaxedFactor !== null;
	const suffix = relaxed ? '_relaxed' : '';
	const tol = relaxed ? tolerancePct * relaxedFactor : tolerancePct;
	const lastIdx = candles.length - 1;

	const sizeReason = validateDoubleSize(side, a, b, c, ctx.sizeThresholds);
	if (sizeReason) {
		const reason = relaxed && sizeReason !== 'pattern_too_small' ? `${sizeReason}_relaxed` : sizeReason;
		pcand({ type, accepted: false, reason, idxs: [a.idx, b.idx, c.idx] });
		return null;
	}
	const [outer1, , outer2] = doublePts(side, a, b, c);
	if (!near(a.price, c.price, tol)) {
		const diffPct = Math.abs(a.price - c.price) / Math.max(1, Math.max(a.price, c.price));
		// strict だけ、分母に下限 1 を付けた乖離率でも外れたときに記録する（1 円未満の価格では記録されない候補がある）。
		if (relaxed || diffPct > tol) {
			pcand({
				type,
				accepted: false,
				reason: `${spec.notEqualReason}${suffix}`,
				idxs: [a.idx, b.idx, c.idx],
				pts: [outer1, outer2],
			});
		}
		return null;
	}
	if (!isSameLevel(a.price, c.price, DOUBLE_LEVEL_MAX_PCT)) {
		pcand({
			type,
			accepted: false,
			reason: `${spec.notEqualReason}_structural`,
			idxs: [a.idx, b.idx, c.idx],
			pts: [outer1, outer2],
		});
		return null;
	}

	const necklinePrice = b.price;
	const breakoutIdx = findBreakoutIdx(candles, c.idx, necklinePrice, spec.breakoutDirection);
	const isCompleted = breakoutIdx >= 0;
	// includeForming が false なら未ブレイクは出力されないので組み立てない。組んでも debug の上限を食うだけ。
	if (!isCompleted && !includeForming) {
		pcand({
			type,
			accepted: false,
			reason: `no_breakout${suffix}`,
			idxs: [a.idx, b.idx, c.idx],
			pts: doublePts(side, a, b, c),
		});
		return null;
	}
	const gate = applyStructuralGate(candles, pivots, side, a, b, c, necklinePrice, type, pcand);
	if (!gate) return null;

	const post = checkPostPivotInvalidation({
		candles,
		pivots,
		a,
		b,
		c,
		untilIdx: isCompleted ? breakoutIdx - 1 : lastIdx,
		side,
	});
	if (post.verdict === 'reclassify') {
		pcand({ type, accepted: false, reason: spec.reclassifiedReason, idxs: [a.idx, b.idx, c.idx] });
		return null;
	}
	if (rejectByLevelDiff(side, type, a, b, c, Math.min(tol, DOUBLE_LEVEL_MAX_PCT), pcand)) return null;
	if (rejectByNecklineSide(side, type, a, b, c, necklinePrice, pcand)) return null;
	// 先に付いた invalid の理由を上書きしないよう、post が ok のときだけ掛ける。
	const pathTerminal =
		isCompleted && post.verdict === 'ok'
			? checkBreakoutPath({ pivots, side, type, a, b, c, breakoutIdx, pcand })
			: null;
	// 先行トレンドは構造・再進入・経路のゲートより後に見る。先に止めると debug が構造の不備を報告できない。
	const trend = validatePriorTrend(
		candles,
		a.idx,
		(isCompleted ? breakoutIdx : lastIdx) - a.idx,
		spec.priorTrend,
		ctx.priorTrendParams,
	);
	if (post.verdict === 'ok' && !pathTerminal && !trend.ok) {
		pcand({
			type,
			accepted: false,
			reason: `prior_trend_mismatch:${trend.classification}`,
			idxs: [a.idx, b.idx, c.idx],
			pts: doublePts(side, a, b, c),
		});
		return null;
	}
	if (trend.classification === 'insufficient_data') {
		pcand({ type, accepted: true, reason: 'prior_trend_insufficient_data', idxs: [a.idx, b.idx, c.idx] });
	}

	const start = candles[a.idx].isoTime;
	// 未ブレイクの range.end は第2構成点。detect_triples の near_completion とそろえている。
	const end = isCompleted ? candles[breakoutIdx]?.isoTime : candles[c.idx]?.isoTime;
	if (!start || !end) return null;
	const neckline = [
		{ x: a.idx, y: necklinePrice },
		{ x: isCompleted ? breakoutIdx : c.idx, y: necklinePrice },
	];
	const per = periodScoreDays(start, end);
	const outerAvg = (a.price + c.price) / 2;
	const patternHeight = side === 'top' ? outerAvg - necklinePrice : necklinePrice - outerAvg;
	// 未ブレイクは NaN にして、breakoutQualityScore に軸ごと外させる。
	const breakoutClose = isCompleted ? Number(candles[breakoutIdx]?.close ?? NaN) : NaN;
	const { components: scoreComponents, base } = buildDoubleScore({
		outer1: a.price,
		outer2: c.price,
		necklinePrice,
		breakoutClose,
		patternHeight,
		side,
		retracementRatio: gate.retracementRatio,
		durationScore: per,
	});
	const confidence = finalizeConf(relaxed ? base * RELAXED_CONFIDENCE_PENALTY : base, type);
	const diagram = generatePatternDiagram(
		type,
		[
			{ ...a, date: candles[a.idx]?.isoTime },
			{ ...b, date: candles[b.idx]?.isoTime },
			{ ...c, date: candles[c.idx]?.isoTime },
		],
		{ price: necklinePrice },
		{ start, end },
		{ tz: ctx.tz, type: ctx.type },
	);
	const target = Math.round(side === 'top' ? necklinePrice - patternHeight : necklinePrice + patternHeight);
	// 測れない理由を名乗る。breakoutTarget だけを出すと LLM が「進捗 0%」と読み違える（#224）。
	const reach = !isCompleted
		? omittedTargetReach('not_broken_out')
		: Number.isFinite(breakoutClose)
			? computeTargetReach(candles, breakoutIdx, breakoutClose, target, spec.targetDirection, patternHeight)
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
		type,
		confidence,
		scoreComponents,
		...(structureGate ? { structureGate } : {}),
		range: { start, end },
		...(structureRange ? { structureRange } : {}),
		...(confirmation ? { confirmation } : {}),
		...(precedingTrend ? { precedingTrend } : {}),
		...(unbroken ??
			(post.verdict === 'invalid' ? { status: 'invalid' as const, invalidReason: post.reason } : (pathTerminal ?? {}))),
		pivots: [a, b, c],
		neckline,
		trendlineLabel: 'ネックライン',
		...(isCompleted ? { breakout: { idx: breakoutIdx, price: breakoutClose }, breakoutBarIndex: breakoutIdx } : {}),
		breakoutTarget: target,
		targetMethod: 'neckline_projection' as const,
		...targetReachFields(reach),
		structureDiagram: diagram,
		...(relaxed ? { _fallback: `relaxed_double_x${relaxedFactor}` } : {}),
	};
	if (!relaxed) {
		pcand({
			type,
			accepted: true,
			// 未ブレイクは組み立て時点の status を出す（#158。'completed' と誤読させない）。
			...(unbroken ? { status: unbroken.status } : {}),
			idxs: isCompleted ? [a.idx, b.idx, c.idx, breakoutIdx] : [a.idx, b.idx, c.idx],
			pts: [
				...doublePts(side, a, b, c),
				...(isCompleted ? [{ role: 'breakout', idx: breakoutIdx, price: breakoutClose }] : []),
			],
		});
	}
	return { entry, isCompleted };
}

function findRelaxedDouble(ctx: DetectContext, side: ReversalSide, factor: number): PatternEntry | null {
	const { pivots, minDist } = ctx;
	// 完成済み以外で打ち切ると、後ろにある完成済みの候補まで失われるので退避して走査を続ける（#242）。
	let nonCompletedFallback: PatternEntry | null = null;
	for (let i = 0; i + 2 < pivots.length; i++) {
		const a = pivots[i];
		const b = pivots[i + 1];
		const c = pivots[i + 2];
		if (doubleSideOf(a, b, c) !== side) continue;
		if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;
		const result = evaluateDouble(ctx, side, a, b, c, factor);
		if (!result) continue;
		if (result.entry.status !== undefined) {
			nonCompletedFallback ??= result.entry;
			continue;
		}
		return result.entry;
	}
	return nonCompletedFallback;
}

// double は forming を出さない。最終構成点が 1 つしか無く、暫定値で埋めると double だけの例外が仕様に増えるため（#268）。
export function detectDoubles(ctx: DetectContext): DetectResult {
	const { pivots, want, minDist } = ctx;
	let patterns: PatternEntry[] = [];
	const found: Record<ReversalSide, boolean> = { top: false, bottom: false };

	if (want.size === 0 || want.has('double_top') || want.has('double_bottom')) {
		for (let i = 0; i + 2 < pivots.length; i++) {
			const a = pivots[i];
			const b = pivots[i + 1];
			const c = pivots[i + 2];
			if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;
			const side = doubleSideOf(a, b, c);
			if (!side) continue;
			const result = evaluateDouble(ctx, side, a, b, c, null);
			if (!result) continue;
			patterns.push(result.entry);
			// completed のときだけ立てる。near_completion で立てると relaxed が走らず、別の構成点の completed が消える。
			if (result.isCompleted) found[side] = true;
		}
		for (const side of ['top', 'bottom'] as const) {
			if (found[side] || !(want.size === 0 || want.has(DOUBLE_SIDES[side].type))) continue;
			const result = findRelaxedDouble(ctx, side, RELAXED_TOLERANCE_FACTOR);
			if (result) {
				patterns.push(result);
				found[side] = true;
			}
		}
		patterns = deduplicatePatterns(patterns);
	}

	return { patterns, found: { double_top: found.top, double_bottom: found.bottom } };
}
