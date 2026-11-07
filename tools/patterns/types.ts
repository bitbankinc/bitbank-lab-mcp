// 理由コードの単一ソースは src/schema/patterns.ts の Zod enum（TS 側で別に持つと parse() が黙って剥がす）。
import type { TargetProgressOmittedReason } from '../../src/schema/patterns.js';
import type { PriorTrendParams, SizeThresholds } from './structural.js';
import type { Pivot } from './swing.js';
import type { TargetBreakoutConfounder } from './target-confounders.js';

export interface TrendLine {
	slope: number;
	intercept: number;
	r2?: number;
	valueAt: (x: number) => number;
}

export interface WedgeParams {
	minSlope?: number;
	slopeRatioMinRising?: number;
	slopeRatioMinFalling?: number;
	slopeRatioMin?: number;
	minWeakerSlopeRatio?: number;
	windowSizeMin?: number;
	windowSizeMax?: number;
}

export interface PatternScoreComponents {
	fitScore: number;
	convergeScore: number;
	touchScore: number;
	alternationScore: number;
	insideScore: number;
	durationScore: number;
}

export interface PatternScoreWeights {
	fit: number;
	converge: number;
	touch: number;
	alternation: number;
	inside: number;
	duration: number;
}

export interface TouchPoint {
	index: number;
	distance: number;
	isBreak: boolean;
}

export interface TouchResult {
	upperTouches: TouchPoint[];
	lowerTouches: TouchPoint[];
	upperQuality: number;
	lowerQuality: number;
	score: number;
}

export interface DeduplicablePattern {
	type?: string;
	confidence?: number;
	range?: { start: string; end: string; current?: string };
	/** Pivot そのものを使い、緩い形で再宣言しない。extremePrice を落として組み直すと typecheck で止まるようにする（#125）。 */
	pivots?: Pivot[];
	[key: string]: unknown;
}

export interface CandleData {
	open: number;
	close: number;
	high: number;
	low: number;
	isoTime?: string;
}

export interface CandDebugArg {
	type: string;
	accepted: boolean;
	reason?: string;
	idxs?: number[];
	pts?: Array<{ role: string; idx: number; price: number }>;
	/** 組み立て時点の status。無いと形成中の成功エントリが completed と読まれる（#158）。 */
	status?: string;
	details?: Record<string, unknown>;
}

export interface CandDebugEntry {
	type: string;
	accepted: boolean;
	reason?: string;
	indices?: number[];
	points?: Array<{ role: string; idx: number; price: number; isoTime?: string }>;
	details?: unknown;
	status?: string;
	breakoutDirection?: string | null;
}

export interface DetectContext {
	candles: CandleData[];
	pivots: Pivot[];
	allPeaks: Pivot[];
	allValleys: Pivot[];
	tolerancePct: number;
	/** tolerancePct とは向きが逆で、大きいほど厳しい（#149）。 */
	headProminencePct: number;
	sizeThresholds: SizeThresholds;
	hsShoulderMaxPct: number;
	priorTrendParams?: PriorTrendParams;
	minDist: number;
	/** 空なら全種を対象にする。 */
	want: Set<string>;
	includeForming: boolean;
	debugCandidates: CandDebugEntry[];
	type: string;
	swingDepth: number;
	/** 構造図の日付表示にだけ使い、判定には使わない。未指定なら Asia/Tokyo。 */
	tz?: string;
}

export interface DetectResult {
	patterns: PatternEntry[];
	found?: Record<string, boolean>;
}

export interface AftermathResult {
	breakoutDate?: string | null;
	breakoutConfirmed: boolean;
	priceMove?: Record<string, { return: number; high: number; low: number } | null>;
	targetReached: boolean;
	theoreticalTarget?: number | null;
	outcome: string;
	daysToTarget?: number | null;
}

export interface PatternScoreBreakdown {
	levelMargin?: number;
	headProminence?: number;
	timeSymmetry?: number;
	retracement?: number;
	breakoutQuality?: number;
}

export interface PatternStructureGate {
	retracementRatio?: number;
	priorExtremeIdx?: number;
	priorExtremePrice?: number;
	necklineCrossIdx?: number;
	skipped?: 'no_prior_extreme' | 'insufficient_history';
}

export interface PatternStructureRange {
	start: string;
	end: string;
}

export type PatternConfirmation =
	| { type: 'neckline_breakout'; date: string; idx: number; price: number }
	| { type: 'not_confirmed' };

export interface PatternPrecedingTrend {
	start: string;
	end: string;
	direction: 'up' | 'down' | 'sideways' | 'insufficient_data';
	returnPct: number;
	lookbackBars: number;
}

export interface PatternEntry extends DeduplicablePattern {
	confidence?: number;
	/** relaxed 経路で拾った印。表記が検出器ごとにそろっていないので、判別は前方一致で行う。 */
	_fallback?: string;
	timeframe?: string;
	timeframeLabel?: string;
	neckline?: Array<{ x?: number; y: number }>;
	structureDiagram?: { svg: string; artifact?: { identifier: string; title: string } };
	status?: string;
	invalidReason?: string;
	scoreComponents?: PatternScoreBreakdown;
	structureGate?: PatternStructureGate;
	breakout?: { idx: number; price: number; direction?: string } | null;
	structureRange?: PatternStructureRange;
	confirmation?: PatternConfirmation;
	precedingTrend?: PatternPrecedingTrend;
	breakoutDirection?: 'up' | 'down';
	outcome?: 'success' | 'failure' | string;
	breakoutTarget?: number;
	targetMethod?: string;
	targetReachedPct?: number;
	targetReached?: boolean;
	targetReachedDate?: string;
	targetReachedPrice?: number;
	/** 交絡の 2 フィールドは検出器ではなく target-confounders.ts がパイプラインの段で付ける。 */
	targetFirstReachBars?: number;
	targetFirstReachDate?: string;
	targetScanBars?: number;
	targetScanComplete?: boolean;
	targetOtherBreakoutBeforeReach?: TargetBreakoutConfounder[];
	targetOppositeBreakoutInWindow?: TargetBreakoutConfounder[];
	targetProgressOmittedReason?: TargetProgressOmittedReason;
	trendlineLabel?: string;
	poleDirection?: 'up' | 'down';
	priorTrendDirection?: 'bullish' | 'bearish';
	flagpoleHeight?: number;
	retracementRatio?: number;
	isTrendContinuation?: boolean;
	poleStartDate?: string;
	poleEndDate?: string;
	poleChangePct?: number;
	poleBars?: number;
	poleATRMult?: number;
	flagUpperSlope?: number;
	flagLowerSlope?: number;
	spreadAvg?: number;
	spreadStability?: number;
	expectedBreakoutDirection?: 'up' | 'down';
	apexDate?: string;
	daysToApex?: number;
	completionPct?: number;
	breakoutDate?: string;
	breakoutBarIndex?: number;
	daysSinceBreakout?: number;
	aftermath?: AftermathResult | null;
}

export function pushCand(ctx: DetectContext, arg: CandDebugArg): void {
	const points = (arg.pts || []).map((p) => ({
		...p,
		isoTime: (ctx.candles[p.idx] as CandleData | undefined)?.isoTime,
	}));
	ctx.debugCandidates.push({
		type: arg.type,
		accepted: arg.accepted,
		reason: arg.reason,
		indices: arg.idxs,
		points,
		// 未指定ならキーごと出さない（`status: undefined` を置くと deep-equal 比較が壊れる）
		...(arg.status !== undefined ? { status: arg.status } : {}),
		...(arg.details !== undefined ? { details: arg.details } : {}),
	});
}
