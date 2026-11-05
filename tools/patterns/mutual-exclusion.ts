// 判定は入力集合の中だけで閉じる。patterns で絞って H&S が集合に無ければ排他は起きない（仕様。要求外の H&S を裏で検出しない）。
import type { Pivot } from './swing.js';
import type { DeduplicablePattern } from './types.js';

// 主構成点は pivots の位置ではなく kind で取る。形成中の経路は同じ type でも配列の長さと並びが違う。
// double は未計測なので載せない。載せると double の排他が動き出す（#218）。
const MAIN_POINT_KIND: Readonly<Record<string, Pivot['kind']>> = {
	triple_top: 'H',
	triple_bottom: 'L',
	head_and_shoulders: 'H',
	inverse_head_and_shoulders: 'L',
};

export function mainPointKind(type: string | undefined): Pivot['kind'] | undefined {
	return MAIN_POINT_KIND[String(type)];
}

// detect_patterns.ts の cap トリムがこの値で優先度を決めるので、文字列を直書きせずここから読む。
export const TRIPLE_HS_EXCLUSION_REASON = 'excluded_by_hs_main_point_overlap';

function isTriple(type: string): boolean {
	return type === 'triple_top' || type === 'triple_bottom';
}

function isHeadAndShoulders(type: string): boolean {
	return type === 'head_and_shoulders' || type === 'inverse_head_and_shoulders';
}

// 同じ点かどうかは idx で比べる。価格は検出器ごとに終値基準と高安基準が違う。
export function mainPointIdxs(pattern: DeduplicablePattern | undefined): number[] {
	const kind = MAIN_POINT_KIND[String(pattern?.type)];
	if (!kind) return [];
	const pivots = pattern?.pivots;
	if (!Array.isArray(pivots)) return [];
	return pivots
		.filter((p) => p?.kind === kind)
		.map((p) => Number(p?.idx))
		.filter((idx) => Number.isFinite(idx))
		.sort((a, b) => a - b);
}

export interface TripleHsOverlap {
	triple: DeduplicablePattern;
	tripleMainIdxs: number[];
	matches: Array<{ hsType: string; hsMainIdxs: number[]; sharedIdxs: number[] }>;
}

export interface TripleHsExclusionResult {
	kept: DeduplicablePattern[];
	excluded: TripleHsOverlap[];
	/** 0 なら比較そのものが起きていない。excluded が空なだけでは「該当なし」と区別できない（#224）。 */
	hsCandidateCount: number;
}

// 落とすのは常に triple。H&S は頭の突出が検証済みで、3 点が同水準という triple の前提と両立しない（#218）。
// globalDedup（期間の重なり）には混ぜない。混ぜると点を共有しない別パターンまで、期間が重なるだけで統合される。
// 呼び出しはライフサイクル絞り込みの後に置く。先に落とすと、根拠の H&S が後で消えてどちらも残らないことがある。
export function excludeTriplesSharingHsMainPoints(
	patterns: ReadonlyArray<DeduplicablePattern>,
): TripleHsExclusionResult {
	const hsEntries = patterns
		.filter((p) => isHeadAndShoulders(String(p?.type)))
		.map((p) => ({ type: String(p.type), mainIdxs: mainPointIdxs(p) }))
		.filter((e) => e.mainIdxs.length > 0);
	if (hsEntries.length === 0) return { kept: [...patterns], excluded: [], hsCandidateCount: 0 };

	const kept: DeduplicablePattern[] = [];
	const excluded: TripleHsOverlap[] = [];
	for (const p of patterns) {
		if (!isTriple(String(p?.type))) {
			kept.push(p);
			continue;
		}
		const tripleMainIdxs = mainPointIdxs(p);
		const matches: TripleHsOverlap['matches'] = [];
		for (const hs of hsEntries) {
			const sharedIdxs = tripleMainIdxs.filter((idx) => hs.mainIdxs.includes(idx));
			// 主構成点は 3 点しかないので、2 点の共有は同じ構造の別解釈、1 点は端点が接しているだけの別構造。
			if (sharedIdxs.length >= 2) matches.push({ hsType: hs.type, hsMainIdxs: hs.mainIdxs, sharedIdxs });
		}
		if (matches.length === 0) {
			kept.push(p);
			continue;
		}
		excluded.push({ triple: p, tripleMainIdxs, matches });
	}
	return { kept, excluded, hsCandidateCount: hsEntries.length };
}
