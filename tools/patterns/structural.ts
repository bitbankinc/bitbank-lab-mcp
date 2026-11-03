import { EPSILON } from '../../lib/math.js';
import { linearRegressionWithR2, relDev } from './regression.js';
import type { Pivot } from './swing.js';
import type { CandleData, PatternPrecedingTrend } from './types.js';

// 変えると validateLevelDiff に届く spreadRatio の上限（min(tolerancePct, 本定数) / depthPct）も動く。
export const DOUBLE_LEVEL_MAX_PCT = 0.03;

// 1day のアンカー値。肩ゲートは直接読まず、時間足別の ctx.hsShoulderMaxPct を使う（#244）。
export const HS_SHOULDER_MAX_PCT = 0.05;

// tolerancePct にも時間足にも連動させない固定値。schema の tolerancePct の description で公開している。
export const HS_NECKLINE_MAX_PCT = 0.05;

// MIN_DEPTH_PCT と合わせて 1day のアンカー値。検出器は直接読まず、DetectContext.sizeThresholds を使う（#152）。
export const MIN_PATTERN_HEIGHT_PCT = 0.03;
export const MIN_DEPTH_PCT = 0.05;

export const PRIOR_TREND_SIDEWAYS_PCT = 0.05;
export const PRIOR_TREND_LOOKBACK_MIN = 10;
export const PRIOR_TREND_LOOKBACK_MAX = 30;
export const PRIOR_TREND_MIN_EFFICIENCY = 0.55;
export const PRIOR_TREND_MIN_R2 = 0.35;

export interface PriorTrendParams {
	sidewaysPct: number;
	lookbackMin: number;
	lookbackMax: number;
}

export const DEFAULT_PRIOR_TREND_PARAMS: PriorTrendParams = {
	sidewaysPct: PRIOR_TREND_SIDEWAYS_PCT,
	lookbackMin: PRIOR_TREND_LOOKBACK_MIN,
	lookbackMax: PRIOR_TREND_LOOKBACK_MAX,
};

export function isSameLevel(a: number, b: number, maxPct: number): boolean {
	return relDev(a, b) <= maxPct;
}

export interface NecklineHorizontalityResult {
	ok: boolean;
	diffPct: number;
}

export function validateHorizontalNeckline(
	p1Price: number,
	p3Price: number,
	maxPct: number,
): NecklineHorizontalityResult {
	const diffPct = relDev(p1Price, p3Price);
	return { ok: diffPct <= maxPct, diffPct };
}

export type PriorTrendExpected = 'up_or_sideways' | 'down_or_sideways' | 'up' | 'down';

export type PriorTrendClassification = 'up' | 'down' | 'sideways' | 'insufficient_data';

export interface PriorTrendResult {
	ok: boolean;
	priorReturn: number;
	lookbackBars: number;
	priorStartIdx: number;
	classification: PriorTrendClassification;
	reason?: string;
	rangePct?: number;
	efficiency?: number;
	r2?: number;
}

export function validatePriorTrend(
	candles: ReadonlyArray<{ close: number }>,
	startIdx: number,
	patternBars: number,
	expected: PriorTrendExpected,
	params: PriorTrendParams = DEFAULT_PRIOR_TREND_PARAMS,
): PriorTrendResult {
	const matchesExpected = (classification: PriorTrendClassification): boolean => {
		// 履歴不足で棄却すると limit を短くしただけで同じ構造が消えるので、判定を保留する。
		if (classification === 'insufficient_data') return true;
		if (expected === 'up') return classification === 'up';
		if (expected === 'down') return classification === 'down';
		if (expected === 'up_or_sideways') return classification === 'up' || classification === 'sideways';
		return classification === 'down' || classification === 'sideways';
	};
	const lookbackBars = Math.max(params.lookbackMin, Math.min(params.lookbackMax, Math.round(patternBars * 0.5)));
	const priorStart = Math.max(0, startIdx - lookbackBars);
	const startCloseRaw = candles[startIdx]?.close;
	const priorCloseRaw = candles[priorStart]?.close;
	const startClose = typeof startCloseRaw === 'number' && Number.isFinite(startCloseRaw) ? startCloseRaw : 0;
	const priorClose = typeof priorCloseRaw === 'number' && Number.isFinite(priorCloseRaw) ? priorCloseRaw : 0;
	const priorReturn = priorClose === 0 ? 0 : (startClose - priorClose) / priorClose;
	const result = (
		classification: PriorTrendClassification,
		extra: Pick<PriorTrendResult, 'reason' | 'rangePct' | 'efficiency' | 'r2'> = {},
	): PriorTrendResult => ({
		ok: matchesExpected(classification),
		priorReturn,
		lookbackBars,
		priorStartIdx: priorStart,
		classification,
		...extra,
	});

	if (startIdx < lookbackBars) return result('insufficient_data', { reason: 'startIdx < lookbackBars' });
	if (priorClose === 0 || startClose === 0) return result('sideways', { reason: 'missing_close' });
	if (Math.abs(priorReturn) <= params.sidewaysPct) return result('sideways');

	const points: Array<{ x: number; y: number }> = [];
	let maxClose = Number.NEGATIVE_INFINITY;
	let minClose = Number.POSITIVE_INFINITY;
	let hasMissingClose = false;
	for (let i = priorStart; i <= startIdx; i++) {
		const c = candles[i]?.close;
		if (typeof c !== 'number' || !Number.isFinite(c)) {
			hasMissingClose = true;
			continue;
		}
		if (c > maxClose) maxClose = c;
		if (c < minClose) minClose = c;
		points.push({ x: i, y: c });
	}

	if (hasMissingClose || points.length < 2 || !Number.isFinite(maxClose) || !Number.isFinite(minClose)) {
		return result('sideways', { reason: 'invalid_window' });
	}

	const range = maxClose - minClose;
	const rangePct = range / priorClose;
	const efficiency = range > 0 ? Math.abs(startClose - priorClose) / range : 0;
	const { r2 } = linearRegressionWithR2(points);

	let classification: PriorTrendClassification;
	const isDirectional = efficiency >= PRIOR_TREND_MIN_EFFICIENCY || r2 >= PRIOR_TREND_MIN_R2;
	if (!isDirectional) {
		classification = 'sideways';
	} else if (priorReturn > 0) {
		classification = 'up';
	} else {
		classification = 'down';
	}

	return result(classification, { rangePct, efficiency, r2 });
}

export function buildPrecedingTrend(
	candles: CandleData[],
	trend: PriorTrendResult,
	startIdx: number,
): PatternPrecedingTrend | undefined {
	const startIso = candles[trend.priorStartIdx]?.isoTime;
	const endIso = candles[startIdx]?.isoTime;
	if (!startIso || !endIso) return undefined;
	return {
		start: startIso,
		end: endIso,
		direction: trend.classification,
		returnPct: Number((trend.priorReturn * 100).toFixed(2)),
		lookbackBars: trend.lookbackBars,
	};
}

// 構造ゲートの値幅は Pivot.price ではなく extremePrice で測る。price の意味が検出器ごとに違うため（#128）。
export type ReversalSide = 'bottom' | 'top';

export const RETRACEMENT_MIN = 0.2;

// 0.85 に下げると、1 つの対称三角形の中で通る脚と落ちる脚が混ざる。
export const RETRACEMENT_MAX = 0.9;

export const NECKLINE_CROSS_LOOKBACK_BARS = 60;

// 先行トレンドの最小ルックバックとそろえている（どちらも足りなければ履歴不足として出力から除外される）。
export const NECKLINE_CROSS_MIN_WINDOW_BARS = PRIOR_TREND_LOOKBACK_MIN;

export const REVERSAL_HISTORY_WARMUP_BARS = Math.max(PRIOR_TREND_LOOKBACK_MAX, NECKLINE_CROSS_LOOKBACK_BARS);

export const TROUGH_REENTRY_FRACTION = 0.25;

export type StructuralRejectReason =
	| 'neckline_above_pre_decline_high'
	| 'neckline_below_pre_decline_low'
	| 'no_neckline_cross_before_trough1'
	| 'no_neckline_cross_before_peak1'
	| 'retracement_out_of_band';

export type StructuralSkipReason = 'no_prior_extreme' | 'insufficient_history';

export interface SizeThresholds {
	heightPct: number;
	depthPct: number;
}

export type PatternSizeRejectReason = 'pattern_too_small' | 'valley_too_shallow' | 'peak_too_shallow';

// ばらつきは price、高さは extremePrice で測る。水準は終値、値幅は高安という #131 / #132 の慣行に合わせている。
export interface LevelSpreadMetrics {
	spreadAbs: number;
	spreadPct: number;
	heightAbs: number | null;
	heightPct: number | null;
	spreadRatio: number | null;
}

export function levelSpreadMetrics(
	mainPoints: ReadonlyArray<Pick<Pivot, 'price'>>,
	allPoints: ReadonlyArray<Pick<Pivot, 'extremePrice'> | null | undefined>,
): LevelSpreadMetrics {
	const levels = mainPoints.map((p) => p.price);
	const spreadAbs = Math.max(...levels) - Math.min(...levels);
	const spreadPct = spreadAbs / Math.max(EPSILON, Math.max(...levels));

	const extremes = allPoints.map((p) => p?.extremePrice);
	const complete = extremes.every((v): v is number => Number.isFinite(v));
	if (!complete) return { spreadAbs, spreadPct, heightAbs: null, heightPct: null, spreadRatio: null };

	const hi = Math.max(...extremes);
	const lo = Math.min(...extremes);
	const heightAbs = hi - lo;
	return {
		spreadAbs,
		spreadPct,
		heightAbs,
		heightPct: heightAbs / Math.max(EPSILON, hi),
		spreadRatio: heightAbs > 0 ? spreadAbs / heightAbs : null,
	};
}

// パターン高さで割った無次元比なので時間足別にしない。triple と double で共有する。
export const MAX_LEVEL_SPREAD_RATIO = 0.5;

export type PatternLevelSpreadRejectReason = 'peak_spread_vs_height_excess' | 'valley_spread_vs_height_excess';

// 呼び出しは構造ゲートより後に置く。前に置くと構造ゲートの理由コードを横取りする。
export function validateLevelSpread(
	side: ReversalSide,
	metrics: LevelSpreadMetrics,
	maxRatio: number = MAX_LEVEL_SPREAD_RATIO,
): PatternLevelSpreadRejectReason | null {
	if (!exceedsLevelSpread(metrics, maxRatio)) return null;
	return side === 'top' ? 'peak_spread_vs_height_excess' : 'valley_spread_vs_height_excess';
}

// 量は PatternLevelSpreadRejectReason と同じだが、debug の reason 横断合計で triple と潰れないよう語彙を分ける（#193）。
export type PatternLevelDiffRejectReason = 'peaks_diff_vs_height_excess' | 'valleys_diff_vs_height_excess';

// double では triple 再分類判定（checkPostPivotInvalidation）より後に置く。前に置くと reclassified_as_triple_top を横取りする。
export function validateLevelDiff(
	side: ReversalSide,
	metrics: LevelSpreadMetrics,
	maxRatio: number = MAX_LEVEL_SPREAD_RATIO,
): PatternLevelDiffRejectReason | null {
	if (!exceedsLevelSpread(metrics, maxRatio)) return null;
	return side === 'top' ? 'peaks_diff_vs_height_excess' : 'valleys_diff_vs_height_excess';
}

// 高さを測れない候補は落とさない。この検査が意図していない理由で検出が減るため。
function exceedsLevelSpread(metrics: LevelSpreadMetrics, maxRatio: number): boolean {
	if (metrics.spreadRatio === null || !Number.isFinite(metrics.spreadRatio)) return false;
	return metrics.spreadRatio > maxRatio;
}

// levelTolerancePct は経路が実際に使った許容誤差（min）で、パラメータのエコーではないので tolerancePct と名付けない。
export function levelSpreadDetailsFrom(m: LevelSpreadMetrics, levelTolerancePct: number): Record<string, unknown> {
	return {
		spreadAbs: m.spreadAbs,
		spreadPct: m.spreadPct,
		heightAbs: m.heightAbs,
		heightPct: m.heightPct,
		spreadRatio: m.spreadRatio,
		levelTolerancePct,
	};
}

export type MainPointNecklineSideRejectReason = 'peaks_below_neckline' | 'valleys_above_neckline';

export interface MainPointNecklineSideOffender {
	idx: number;
	price: number;
	deviation: number;
}

export interface MainPointNecklineSideResult {
	reason: MainPointNecklineSideRejectReason | null;
	offenders: MainPointNecklineSideOffender[];
}

// extremePrice ではなく price で比べる。ネックラインもブレイク判定も終値由来のため（#216）。
// 呼び出しは validateLevelSpread / validateLevelDiff より後に置く。
export function validateMainPointsNecklineSide(
	side: ReversalSide,
	mainPoints: ReadonlyArray<Pick<Pivot, 'idx' | 'price'>>,
	necklinePrice: number,
): MainPointNecklineSideResult {
	return validateMainPointsAgainstNecklineAt(side, mainPoints, () => necklinePrice);
}

// 呼び出し側では空にならないが、空配列の Math.max() は -Infinity になるので潰す。
function maxOffenderDeviation(offenders: ReadonlyArray<MainPointNecklineSideOffender>): number | null {
	return offenders.length ? Math.max(...offenders.map((o) => o.deviation)) : null;
}

export function necklineSideDetailsFrom(
	necklinePrice: number,
	offenders: ReadonlyArray<MainPointNecklineSideOffender>,
): Record<string, unknown> {
	return {
		necklinePrice,
		offenders: offenders.map((o) => ({
			idx: o.idx,
			price: o.price,
			deviation: o.deviation,
			deviationPct: o.deviation / Math.max(EPSILON, Math.abs(necklinePrice)),
		})),
		maxDeviation: maxOffenderDeviation(offenders),
	};
}

// debug では完成済みと形成中の棄却が同じ配列に並ぶので、形成中は語彙を分ける（#261）。
export type FormingMainPointNecklineSideRejectReason = `forming_${MainPointNecklineSideRejectReason}`;

// detect_triples.ts と detect_doubles.ts で手書きすると、片方だけ改名しても型が通るのでここで作る。
export function formingNecklineSideReason(
	reason: MainPointNecklineSideRejectReason,
): FormingMainPointNecklineSideRejectReason {
	return `forming_${reason}`;
}

// necklineAt は detect_hs.ts にあり、import すると循環するので関数で受け取る。
export function validateMainPointsAgainstNecklineAt(
	side: ReversalSide,
	mainPoints: ReadonlyArray<Pick<Pivot, 'idx' | 'price'>>,
	necklineAt: (idx: number) => number,
): MainPointNecklineSideResult {
	const offenders: MainPointNecklineSideOffender[] = [];
	for (const p of mainPoints) {
		if (!Number.isFinite(p.price)) continue;
		const level = necklineAt(p.idx);
		if (!Number.isFinite(level)) continue;
		const deviation = side === 'top' ? level - p.price : p.price - level;
		if (deviation >= 0) offenders.push({ idx: p.idx, price: p.price, deviation });
	}
	if (offenders.length === 0) return { reason: null, offenders };
	return { reason: side === 'top' ? 'peaks_below_neckline' : 'valleys_above_neckline', offenders };
}

// 線には 1 つの水準が無いので、スカラー版と違いトップレベルの necklinePrice は出さない。
export function necklineSideDetailsFromAt(
	necklineAt: (idx: number) => number,
	offenders: ReadonlyArray<MainPointNecklineSideOffender>,
): Record<string, unknown> {
	return {
		offenders: offenders.map((o) => {
			const necklinePrice = necklineAt(o.idx);
			return {
				idx: o.idx,
				price: o.price,
				necklinePrice,
				deviation: o.deviation,
				deviationPct: o.deviation / Math.max(EPSILON, Math.abs(necklinePrice)),
			};
		}),
		maxDeviation: maxOffenderDeviation(offenders),
	};
}

// points は両端が主構成点の交互列（top なら山-谷-山…）を時系列順に渡す。
// 深さは両隣の平均と比べる。全体平均にすると H&S の頭が平均を押し上げ、浅い押しでも通る。
// 呼び出しは検出器固有の棄却検査より後に置く。前に置くと固有の理由コードを持つ候補の reason を横取りする。
export function validatePatternSize(
	side: ReversalSide,
	points: ReadonlyArray<Pick<Pivot, 'extremePrice'>>,
	thresholds: SizeThresholds,
): PatternSizeRejectReason | null {
	const prices = points.map((p) => p.extremePrice);
	if (prices.length < 3 || prices.some((v) => !Number.isFinite(v))) return null;

	const hi = Math.max(...prices);
	const lo = Math.min(...prices);
	if ((hi - lo) / Math.max(EPSILON, hi) < thresholds.heightPct) return 'pattern_too_small';

	const shallow: PatternSizeRejectReason = side === 'top' ? 'valley_too_shallow' : 'peak_too_shallow';
	for (let i = 1; i < prices.length - 1; i += 2) {
		const flankAvg = (prices[i - 1] + prices[i + 1]) / 2;
		const depth = side === 'top' ? flankAvg - prices[i] : prices[i] - flankAvg;
		const depthPct = depth / Math.max(EPSILON, flankAvg);
		if (depthPct < thresholds.depthPct) return shallow;
	}
	return null;
}

export interface ReversalStructureResult {
	ok: boolean;
	reason?: StructuralRejectReason;
	skipped?: StructuralSkipReason;
	priorExtreme?: { idx: number; extremePrice: number };
	retracementRatio?: number;
	necklineCrossIdx?: number;
}

// 窓内の極値ではなく直前のピボットを取る。極値を取ると分母が膨らみ、戻り率が実態より小さく出る。
export function findPriorExtreme(pivots: ReadonlyArray<Pivot>, beforeIdx: number, kind: 'H' | 'L'): Pivot | undefined {
	let found: Pivot | undefined;
	for (const p of pivots) {
		if (p.idx >= beforeIdx) break;
		if (p.kind === kind) found = p;
	}
	return found;
}

export const BREAKOUT_BUFFER_PCT = 0.015;
export const MAX_BARS_FROM_EXTREMUM = 20;

export function findBreakoutIdx(
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

export interface NecklineCrossResult {
	idx?: number;
	conclusive: boolean;
}

// 水準は構造から取るが、抜けは終値で判定する。ヒゲ 1 本の割り込みを抜けと数えないため。
export function findNecklineCross(
	candles: ReadonlyArray<{ close: number }>,
	fromIdx: number,
	toIdx: number,
	level: number,
	direction: 'down' | 'up',
): NecklineCrossResult {
	const start = Math.max(0, fromIdx);
	const end = Math.min(candles.length - 1, toIdx);
	const windowBars = end - start + 1;
	if (windowBars < NECKLINE_CROSS_MIN_WINDOW_BARS) return { conclusive: false };

	let seenBeyond = false;
	for (let i = start; i <= end; i++) {
		const close = candles[i]?.close;
		if (typeof close !== 'number' || !Number.isFinite(close)) continue;
		if (direction === 'down') {
			if (close > level) seenBeyond = true;
			else if (seenBeyond && close < level) return { idx: i, conclusive: true };
		} else {
			if (close < level) seenBeyond = true;
			else if (seenBeyond && close > level) return { idx: i, conclusive: true };
		}
	}
	return { conclusive: true };
}

export interface ReversalStructureInput {
	candles: ReadonlyArray<{ close: number }>;
	pivots: ReadonlyArray<Pivot>;
	first: Pivot;
	mid: Pivot;
	/** ブレイク判定と同じ値を渡す。mid.price は検出器ごとに基準が違うので使わない。 */
	necklinePrice: number;
	side: ReversalSide;
}

export function validateReversalStructure(input: ReversalStructureInput): ReversalStructureResult {
	const { candles, pivots, first, mid, necklinePrice, side } = input;
	const isBottom = side === 'bottom';

	const priorPivot = findPriorExtreme(pivots, first.idx, isBottom ? 'H' : 'L');
	if (!priorPivot) return { ok: true, skipped: 'no_prior_extreme' };
	const priorExtreme = { idx: priorPivot.idx, extremePrice: priorPivot.extremePrice };

	const priorRange = isBottom
		? priorPivot.extremePrice - first.extremePrice
		: first.extremePrice - priorPivot.extremePrice;
	const retraceRange = isBottom ? mid.extremePrice - first.extremePrice : first.extremePrice - mid.extremePrice;

	const overshootReason: StructuralRejectReason = isBottom
		? 'neckline_above_pre_decline_high'
		: 'neckline_below_pre_decline_low';

	// 先行値幅が無いならネックラインは必ず起点の外側なので、戻り率 > 1 と同じ理由で落とす。
	if (priorRange <= 0) return { ok: false, reason: overshootReason, priorExtreme };

	const retracementRatio = retraceRange / priorRange;
	if (retracementRatio > 1) return { ok: false, reason: overshootReason, priorExtreme, retracementRatio };
	if (retracementRatio < RETRACEMENT_MIN || retracementRatio > RETRACEMENT_MAX) {
		return { ok: false, reason: 'retracement_out_of_band', priorExtreme, retracementRatio };
	}

	const cross = findNecklineCross(
		candles,
		first.idx - NECKLINE_CROSS_LOOKBACK_BARS,
		first.idx,
		necklinePrice,
		isBottom ? 'down' : 'up',
	);
	if (cross.idx === undefined) {
		if (!cross.conclusive) {
			return { ok: true, skipped: 'insufficient_history', priorExtreme, retracementRatio };
		}
		return {
			ok: false,
			reason: isBottom ? 'no_neckline_cross_before_trough1' : 'no_neckline_cross_before_peak1',
			priorExtreme,
			retracementRatio,
		};
	}

	return { ok: true, priorExtreme, retracementRatio, necklineCrossIdx: cross.idx };
}

export interface TroughZoneReentryInput {
	candles: ReadonlyArray<{ close: number }>;
	first: Pivot;
	mid: Pivot;
	second: Pivot;
	untilIdx: number;
	side: ReversalSide;
}

export interface TroughZoneReentryResult {
	reentered: boolean;
	idx?: number;
	level: number;
}

export function detectTroughZoneReentry(input: TroughZoneReentryInput): TroughZoneReentryResult {
	const { candles, first, mid, second, untilIdx, side } = input;
	const isBottom = side === 'bottom';

	const anchor = isBottom
		? Math.min(first.extremePrice, second.extremePrice)
		: Math.max(first.extremePrice, second.extremePrice);
	const height = isBottom ? mid.extremePrice - anchor : anchor - mid.extremePrice;
	const level = isBottom ? anchor + height * TROUGH_REENTRY_FRACTION : anchor - height * TROUGH_REENTRY_FRACTION;

	if (!(height > 0)) return { reentered: false, level };

	const end = Math.min(candles.length - 1, untilIdx);
	for (let i = second.idx + 1; i <= end; i++) {
		const close = candles[i]?.close;
		if (typeof close !== 'number' || !Number.isFinite(close)) continue;
		if (isBottom ? close <= level : close >= level) return { reentered: true, idx: i, level };
	}
	return { reentered: false, level };
}

export type BreakoutPathRejectReason = 'peak_after_last_pivot' | 'trough_after_last_pivot';

// 検出器はリテラルを直書きせずこれを使う。#286 の網羅テストが ContinuationInvalidReason から理由コードを導くため。
export const BREAKOUT_AGAINST_EXPECTATION = 'breakout_against_expectation' as const;

export type ContinuationInvalidReason = typeof BREAKOUT_AGAINST_EXPECTATION;

export interface BreakoutPathInput {
	pivots: ReadonlyArray<Pivot>;
	lastPivotIdx: number;
	breakoutIdx: number;
	side: ReversalSide;
}

export interface BreakoutPathResult {
	found: boolean;
	reason?: BreakoutPathRejectReason;
	pivot?: Pivot;
}

// detectTroughZoneReentry とは塞ぐ形が違うので、どちらか一方には畳めない（#242）。
// pivots の並び順を仮定しないので、早期 break せず全件から最も左を返す。
export function detectPivotBeforeBreakout(input: BreakoutPathInput): BreakoutPathResult {
	const { pivots, lastPivotIdx, breakoutIdx, side } = input;
	const kind: Pivot['kind'] = side === 'top' ? 'H' : 'L';
	let hit: Pivot | undefined;
	for (const p of pivots) {
		if (!p || p.kind !== kind) continue;
		if (!Number.isFinite(p.idx)) continue;
		if (p.idx <= lastPivotIdx || p.idx >= breakoutIdx) continue;
		if (!hit || p.idx < hit.idx) hit = p;
	}
	if (!hit) return { found: false };
	return {
		found: true,
		reason: side === 'top' ? 'peak_after_last_pivot' : 'trough_after_last_pivot',
		pivot: hit,
	};
}
