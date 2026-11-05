// src/schema/patterns.ts が閾値を読むので、実行時の依存を持たない単位に分けてある（import は型だけにする）。
import type { TargetProgressOmittedReason } from '../../src/schema/patterns.js';
import type { TargetBreakoutConfounder } from './target-confounders.js';
import type { CandleData } from './types.js';

// 上限が無いと値が問い合わせ時点で動くので置く。取りこぼしを防ぐ走査幅であって、到達率の窓として読ませない（#288）。
// 時間足別のテーブルにしない。時間足別テーブルの流用は #198 で事故になっている。
export const TARGET_REACH_MAX_BARS = 60;

// 高さ相対（無次元）にして時間足別テーブルを持たない。分母が潰れるのはネックラインから投影する検出器だけ。
export const MIN_TARGET_DISTANCE_HEIGHT_RATIO = 0.15;

// この値ちょうどは「以上」を意味する。上の 2 つをすり抜けた場合の安全網。
export const TARGET_REACHED_PCT_CAP = 999;

// targetReached* は走査窓の極値の足、targetFirstReach* は初到達の足を指す。別の量なので混ぜない（#288）。
export interface TargetReachInfo {
	kind: 'measured';
	targetReachedPct: number;
	targetReached: boolean;
	targetReachedDate?: string;
	targetReachedPrice: number;
	targetFirstReachBars?: number;
	targetFirstReachDate?: string;
	targetScanBars?: number;
	targetScanComplete?: boolean;
}

// 単一ソースは src/schema/patterns.ts の Zod enum。TS 側にユニオンを別に持つと、宣言漏れの値を parse() が黙って剥がす。
export type TargetReachOmissionReason = TargetProgressOmittedReason;

export interface TargetReachOmitted {
	kind: 'omitted';
	reason: TargetReachOmissionReason;
}

export type TargetReachResult = TargetReachInfo | TargetReachOmitted;

export function omittedTargetReach(reason: TargetReachOmissionReason): TargetReachOmitted {
	return { kind: 'omitted', reason };
}

export function computeTargetReach(
	candles: readonly CandleData[],
	breakoutIdx: number,
	breakoutPrice: number,
	target: number,
	direction: 'up' | 'down',
	patternHeight: number,
): TargetReachResult {
	// 呼び出し側ガードと同じ理由コードにそろえ、ガードの手前と中で申告が変わらないようにする。
	if (!Number.isFinite(breakoutPrice)) return omittedTargetReach('invalid_breakout_price');
	if (!Number.isFinite(target)) return omittedTargetReach('no_target');
	const targetDistance = Math.abs(target - breakoutPrice);
	const startIdx = Math.max(0, breakoutIdx);
	if (startIdx >= candles.length) return omittedTargetReach('no_bars_after_breakout');

	// 距離ゼロも「既に到達」ではなく、測れない状態として扱う。
	if (!(patternHeight > 0) || targetDistance < patternHeight * MIN_TARGET_DISTANCE_HEIGHT_RATIO) {
		return omittedTargetReach('degenerate_target_distance');
	}

	// 最終 close ではなく走査窓の high / low の極値で見る。一度越えて戻ったケースを未到達にしないため。
	const lastIdx = Math.min(startIdx + TARGET_REACH_MAX_BARS, candles.length - 1);
	let extremePrice = direction === 'down' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
	let extremeIdx = -1;
	let firstReachIdx = -1;
	for (let i = startIdx; i <= lastIdx; i++) {
		const candle = candles[i];
		if (!candle) continue;
		if (direction === 'down') {
			const lo = Number(candle.low ?? NaN);
			if (!Number.isFinite(lo)) continue;
			if (lo < extremePrice) {
				extremePrice = lo;
				extremeIdx = i;
			}
			if (firstReachIdx < 0 && lo <= target) firstReachIdx = i;
		} else {
			const hi = Number(candle.high ?? NaN);
			if (!Number.isFinite(hi)) continue;
			if (hi > extremePrice) {
				extremePrice = hi;
				extremeIdx = i;
			}
			if (firstReachIdx < 0 && hi >= target) firstReachIdx = i;
		}
	}
	if (extremeIdx < 0 || !Number.isFinite(extremePrice)) return omittedTargetReach('no_bars_after_breakout');

	const targetReached = direction === 'down' ? extremePrice <= target : extremePrice >= target;
	// 未到達は floor して 99 に抑える。round だと 99.6% が 100 になり、下流の pct >= 100 判定を誤らせる。
	const moveDistance = direction === 'down' ? breakoutPrice - extremePrice : extremePrice - breakoutPrice;
	const rawPct = (moveDistance / targetDistance) * 100;
	const targetReachedPct = targetReached
		? Math.min(TARGET_REACHED_PCT_CAP, Math.max(100, Math.round(rawPct)))
		: Math.min(99, Math.max(0, Math.floor(rawPct)));
	const targetReachedDate = candles[extremeIdx]?.isoTime;
	const targetScanBars = lastIdx - startIdx;
	const targetFirstReachDate = firstReachIdx >= 0 ? candles[firstReachIdx]?.isoTime : undefined;
	return {
		kind: 'measured',
		targetReachedPct,
		targetReached,
		...(targetReachedDate ? { targetReachedDate } : {}),
		targetReachedPrice: extremePrice,
		...(firstReachIdx >= 0 ? { targetFirstReachBars: firstReachIdx - startIdx } : {}),
		...(targetFirstReachDate ? { targetFirstReachDate } : {}),
		targetScanBars,
		targetScanComplete: targetScanBars === TARGET_REACH_MAX_BARS,
	};
}

export function targetReachFields(
	reach: TargetReachResult,
): Partial<Omit<TargetReachInfo, 'kind'>> & { targetProgressOmittedReason?: TargetReachOmissionReason } {
	if (reach.kind === 'omitted') return { targetProgressOmittedReason: reach.reason };
	return {
		targetReachedPct: reach.targetReachedPct,
		targetReached: reach.targetReached,
		...(reach.targetReachedDate ? { targetReachedDate: reach.targetReachedDate } : {}),
		targetReachedPrice: reach.targetReachedPrice,
		// undefined のキーを残すと素の JSON 比較で差分になるので、キーごと落とす。
		...(reach.targetFirstReachBars != null ? { targetFirstReachBars: reach.targetFirstReachBars } : {}),
		...(reach.targetFirstReachDate ? { targetFirstReachDate: reach.targetFirstReachDate } : {}),
		...(reach.targetScanBars != null ? { targetScanBars: reach.targetScanBars } : {}),
		...(reach.targetScanComplete != null ? { targetScanComplete: reach.targetScanComplete } : {}),
	};
}

const TARGET_PROGRESS_OMISSION_NOTE: Record<TargetReachOmissionReason, string> = {
	not_broken_out: '未ブレイクのため未算出',
	no_target: 'ターゲット価格またはパターン高さが算出できないため',
	breakout_against_expectation: '期待方向と逆のブレイクで、標準的なパターン目標値を適用しないため',
	invalid_breakout_price: 'ブレイク足の終値が取得できないため',
	no_bars_after_breakout: 'ブレイク足以降のローソク足が無いため',
	degenerate_target_distance: `ブレイク足が想定値幅の${Math.round((1 - MIN_TARGET_DISTANCE_HEIGHT_RATIO) * 100)}%以上を消化済みで、残り距離が短く進捗率が意味を持たないため`,
	// 構造の性質ではなく検出器の未配線なので、他と違い「算出していない」側の言い方にする。
	not_computed_by_detector:
		'この検出器がターゲットへの到達を算出していないため。実装の未配線であり、構造の性質ではない',
};

// 4 つの形すべてで同じ前置きにする。上位集合のテストがこの語で照合する。
const TARGET_LINE_PREFIX = '   - ターゲット: ';

// 100% を超える数字（到達後の超過倍率）も価格も出さない。価格は呼び出し側が直前の行に出している（#288）。
// 素の JSON を渡す消費者（detect_patterns.ts の SummaryPattern）があるので、新しいフィールドは無くても通るようにする。
export function formatTargetProgressLine(
	p: {
		targetReachedPct?: number;
		targetReached?: boolean;
		targetProgressOmittedReason?: string;
		targetFirstReachBars?: number;
		targetFirstReachDate?: string;
		targetScanBars?: number;
		targetScanComplete?: boolean;
		targetOtherBreakoutBeforeReach?: readonly TargetBreakoutConfounder[];
		targetOppositeBreakoutInWindow?: readonly TargetBreakoutConfounder[];
	},
	opts: { formatDate?: (iso: string) => string } = {},
): string | null {
	if (p.targetProgressOmittedReason) {
		const note =
			TARGET_PROGRESS_OMISSION_NOTE[p.targetProgressOmittedReason as TargetReachOmissionReason] ??
			p.targetProgressOmittedReason;
		return `${TARGET_LINE_PREFIX}出力なし（${note}）`;
	}
	if (p.targetReachedPct == null) return null;
	const pct = Number(p.targetReachedPct);
	const reached = p.targetReached ?? pct >= 100;

	if (reached) {
		const bars = p.targetFirstReachBars;
		const date = p.targetFirstReachDate ? formatIso(p.targetFirstReachDate, opts.formatDate) : null;
		const detail =
			bars == null ? `ブレイク後${TARGET_REACH_MAX_BARS}本以内` : `ブレイク後 ${bars} 本目${date ? `、${date}` : ''}`;
		const note = confounderNote(p.targetOtherBreakoutBeforeReach, '到達前に別パターンのブレイクあり');
		return `${TARGET_LINE_PREFIX}到達（${detail}）${note}`;
	}

	const approach = `目標幅の ${pct}% まで接近`;
	const scanBars = p.targetScanBars;
	const complete = p.targetScanComplete ?? (scanBars != null && scanBars >= TARGET_REACH_MAX_BARS);
	const detail = complete
		? `走査 ${TARGET_REACH_MAX_BARS} 本完了、${approach}`
		: scanBars == null
			? `走査上限 ${TARGET_REACH_MAX_BARS} 本、${approach}`
			: `ブレイク後 ${scanBars} 本経過 / 走査上限 ${TARGET_REACH_MAX_BARS} 本、${approach}`;
	const note = confounderNote(p.targetOppositeBreakoutInWindow, '走査窓内に逆方向のブレイクあり');
	return `${TARGET_LINE_PREFIX}未到達（${detail}）${note}`;
}

function formatIso(iso: string, formatDate?: (iso: string) => string): string {
	if (!formatDate) return iso;
	try {
		const out = formatDate(iso);
		return out && out !== 'n/a' ? out : iso;
	} catch {
		return iso;
	}
}

function confounderNote(list: readonly TargetBreakoutConfounder[] | undefined, label: string): string {
	if (!Array.isArray(list) || list.length === 0) return '';
	const body = list
		.map((c) => `${c.type} ${c.direction === 'down' ? '下方' : '上方'} +${c.barsAfterBreakout} 本`)
		.join(', ');
	return `。${label}（${body}）`;
}
