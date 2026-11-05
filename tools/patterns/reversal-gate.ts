import {
	detectPivotBeforeBreakout,
	detectTroughZoneReentry,
	type ReversalSide,
	type ReversalStructureResult,
	validateReversalStructure,
} from './structural.js';
import type { Pivot } from './swing.js';
import type { CandDebugEntry, CandleData, PatternStructureGate } from './types.js';

export interface ReversalGateInput {
	candles: CandleData[];
	pivots: ReadonlyArray<Pivot>;
	side: ReversalSide;
	/** validatePatternSize に渡す構成点列の先頭 2 点を first / mid にする。戻り率は first → mid の 1 脚で測るので、5 点のパターンでも変わらない。 */
	first: Pivot;
	mid: Pivot;
	/** 検出器がブレイク判定に使うのと同じネックライン水準 */
	necklinePrice: number;
	type: string;
	indices: number[];
	debugCandidates: CandDebugEntry[];
}

// 呼び出しは validatePatternSize の直後に置く。前に置くと固有の理由コードを持つ候補の reason を横取りする。
export function applyReversalGate(input: ReversalGateInput): ReversalStructureResult | null {
	const { candles, pivots, side, first, mid, necklinePrice, type, indices, debugCandidates } = input;
	const gate = validateReversalStructure({ candles, pivots, first, mid, necklinePrice, side });
	if (gate.ok) return gate;
	debugCandidates.push({
		type,
		accepted: false,
		reason: gate.reason,
		indices,
		details: {
			side,
			firstIdx: first.idx,
			midIdx: mid.idx,
			necklinePrice,
			...(gate.retracementRatio !== undefined ? { retracementRatio: gate.retracementRatio } : {}),
			...(gate.priorExtreme
				? { priorExtremeIdx: gate.priorExtreme.idx, priorExtremePrice: gate.priorExtreme.extremePrice }
				: {}),
		},
	});
	return null;
}

export function buildStructureGate(gate: ReversalStructureResult): PatternStructureGate | undefined {
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

export interface PostBreakoutGateInput {
	candles: CandleData[];
	pivots: ReadonlyArray<Pivot>;
	side: ReversalSide;
	first: Pivot;
	mid: Pivot;
	last: Pivot;
	breakoutIdx: number;
	type: string;
	indices: number[];
	debugCandidates: CandDebugEntry[];
}

export interface PostBreakoutGateResult {
	status: 'invalid';
	invalidReason: string;
}

// 適用順は double とそろえて再進入 → 経路。どちらにも当たる候補には先の理由コードが付く（#242）。
// ブレイクが確定していない経路では呼ばない。形成中の最終構成点は暫定値なので hard reject の材料にしない。
// 既定では invalid のエントリが出力から消えるので、理由を debug の候補にも残す。
export function applyPostBreakoutGates(input: PostBreakoutGateInput): PostBreakoutGateResult | null {
	const { candles, pivots, side, first, mid, last, breakoutIdx, type, indices, debugCandidates } = input;

	const reentry = detectTroughZoneReentry({ candles, first, mid, second: last, untilIdx: breakoutIdx - 1, side });
	if (reentry.reentered) {
		debugCandidates.push({
			type,
			accepted: false,
			reason: 're_entered_trough_zone',
			indices,
			details: { side, lastPivotIdx: last.idx, breakoutIdx, zoneLevel: reentry.level, reenteredIdx: reentry.idx },
		});
		return { status: 'invalid', invalidReason: 're_entered_trough_zone' };
	}

	const path = detectPivotBeforeBreakout({ pivots, lastPivotIdx: last.idx, breakoutIdx, side });
	if (path.found && path.reason) {
		debugCandidates.push({
			type,
			accepted: false,
			reason: path.reason,
			indices,
			details: {
				side,
				lastPivotIdx: last.idx,
				breakoutIdx,
				...(path.pivot
					? {
							offenderIdx: path.pivot.idx,
							offenderPrice: path.pivot.price,
							offenderExtremePrice: path.pivot.extremePrice,
						}
					: {}),
			},
		});
		return { status: 'invalid', invalidReason: path.reason };
	}

	return null;
}
