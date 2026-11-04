// 各検出器の走査を want で止めず、出力直前のここ 1 箇所で絞る（検出結果を変えないため。#124）。

// src/schema/patterns.ts の PATTERN_FILTER_ALIASES と 1:1。candidate のラベルの被覆とは一致しないので、CANDIDATE_LABEL_COVERAGE と分けて持つ。
export const INPUT_ALIAS_EXPANSION: Readonly<Record<string, readonly string[]>> = {
	flag: ['bull_flag', 'bear_flag'],
	pennant: ['bull_pennant', 'bear_pennant'],
	triangle: ['triangle_ascending', 'triangle_descending', 'triangle_symmetrical'],
};

// 分類前の棄却は検出器が umbrella ラベルで積む。具体型（triangle_symmetrical など）を広く被覆させると、要求外の種別の候補まで返る（#129）。
export const CANDIDATE_LABEL_COVERAGE: Readonly<Record<string, readonly string[]>> = {
	// detect_pennants は方向・形状の分類前の棄却をすべてこのラベルで積む（flag / pennant 両方）。
	flag: ['bull_flag', 'bear_flag', 'bull_pennant', 'bear_pennant'],
	pennant: ['bull_pennant', 'bear_pennant'],
	// detect_triangles は 3 種の分類が確定する前の棄却をこのラベルで積む（#129）。
	triangle: ['triangle_ascending', 'triangle_descending', 'triangle_symmetrical'],
	// detect_wedges は上下の線の傾きの向きがそろわない窓の棄却をこのラベルで積む。
	wedge: ['rising_wedge', 'falling_wedge'],
};

export function expandWantedTypes(want: ReadonlySet<string>): Set<string> {
	const out = new Set<string>();
	for (const w of want) {
		for (const t of INPUT_ALIAS_EXPANSION[w] ?? [w]) out.add(t);
	}
	return out;
}

export function candidateLabelCoverage(type: string): readonly string[] {
	return CANDIDATE_LABEL_COVERAGE[type] ?? [type];
}

export function filterCandidatesByWant<T extends { type: string }>(
	candidates: readonly T[],
	want: ReadonlySet<string>,
): T[] {
	if (!Array.isArray(candidates)) return [];
	if (want.size === 0) return [...candidates];
	const wanted = expandWantedTypes(want);
	return candidates.filter((c) => candidateLabelCoverage(String(c?.type)).some((t) => wanted.has(t)));
}
