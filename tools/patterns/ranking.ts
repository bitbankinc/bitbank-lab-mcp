/**
 * パターン優先度ランキング
 *
 * 検出器の実行順では H&S 等が低 confidence でも上位に出やすかったため、
 * 表示・返却前に以下の優先度でソートする:
 *   1. status === 'completed'（ブレイクアウト確認済み）
 *   2. confirmation.type === 'neckline_breakout'（検出器がブレイクを確認）
 *   3. confidence 高い順
 *   4. range.end が新しい順（直近性）
 *
 * これにより confidence < 0.6 のパターンが confidence >= 0.6 のパターンより
 * 上位に表示されない契約が成立する。
 */

import type { DeduplicablePattern } from './types.js';

interface PatternWithStatus extends DeduplicablePattern {
	status?: string;
	confirmation?: { type?: string };
}

/**
 * ステータスの優先度スコア（高いほど上位）。
 * - completed: 3（ブレイクアウト確認済み）
 * - status 未設定（完成済み扱い）: 2
 * - forming / near_completion: 1
 * - invalid / expired: 0
 *
 * `expired`（issue #126）は「形成中だったが突破確認窓を使い切った」状態で、
 * 以後 `completed` にはならない。`invalid` と同じ最下位に置く。
 *
 * **status 優先度の単一ソース（issue #133）。** `rankPatterns` だけでなく
 * `patterns/helpers.ts` の `deduplicatePatterns` / `globalDedup` も勝者選択の
 * 最優先軸としてこれを使う。規則を複数箇所に書くと必ず食い違う
 * （dedup が status を見ずに形成中を残し、rankPatterns の status 優先が
 * 手遅れになっていたのが #133）ので、変更はここ 1 箇所で行うこと。
 */
export function statusScore(status: string | undefined): number {
	if (status === 'completed') return 3;
	if (status === undefined) return 2;
	if (status === 'forming' || status === 'near_completion') return 1;
	return 0;
}

/**
 * confirmation の優先度スコア。
 * neckline_breakout のように検出器自身が確認したものを上に出す。
 */
function confirmationScore(confirmation: { type?: string } | undefined): number {
	return confirmation?.type === 'neckline_breakout' ? 1 : 0;
}

function endTimeMs(p: PatternWithStatus): number {
	const end = p?.range?.end;
	if (!end) return 0;
	const t = Date.parse(String(end));
	return Number.isFinite(t) ? t : 0;
}

/**
 * パターン配列を優先度順に並べ替えた新しい配列を返す（破壊しない）。
 * 同一スコアの場合は元の順序を保つ（stable sort）。
 */
export function rankPatterns<T extends DeduplicablePattern>(patterns: readonly T[]): T[] {
	const indexed = patterns.map((p, i) => ({ p, i }));
	indexed.sort((a, b) => {
		const ap = a.p as PatternWithStatus;
		const bp = b.p as PatternWithStatus;

		const ss = statusScore(bp.status) - statusScore(ap.status);
		if (ss !== 0) return ss;

		const cs = confirmationScore(bp.confirmation) - confirmationScore(ap.confirmation);
		if (cs !== 0) return cs;

		const conf = Number(bp.confidence ?? 0) - Number(ap.confidence ?? 0);
		if (conf !== 0) return conf;

		const recency = endTimeMs(bp) - endTimeMs(ap);
		if (recency !== 0) return recency;

		// 安定ソート: 同一スコアなら入力順を維持
		return a.i - b.i;
	});
	return indexed.map((x) => x.p);
}
