/**
 * patterns/candidate-filter.ts - `debug.candidates` を入力 `patterns` フィルタで絞る
 *
 * ## なぜ要るか（issue #124）
 *
 * 全検出器が `want` を**分類・出力の時点**で参照しており、**走査に入る時点**では見ていない。
 * 候補（`debugCandidates`）は走査中に無条件で push されるため、`patterns=['double_bottom']`
 * を指定しても candidates には falling_wedge / rising_wedge が並び、
 * `detect_patterns.ts` の cap=200 トリム（accepted 優先 → rejected）で
 * **要求した種別の棄却理由が押し出される**。
 *
 * 各検出器の走査自体を `want` で早期スキップすれば計算量も減るが、6 ファイルに手を入れる
 * ことになり「検出結果ゼロ変更」の保証が難しい。ここでは**出力直前に 1 箇所で絞る**。
 *
 * ## ラベルの被覆は入力エイリアスと一致しない
 *
 * candidate の `type` は「その候補がどの種別になりえたか」を表すラベルで、
 * **方向・形状の分類前に積まれるものがある**。分類前の棄却は umbrella ラベル
 * （`'flag'` / `'triangle'`）で積む約束で、このラベルが覆う具体 type を
 * `CANDIDATE_LABEL_COVERAGE` に持つ。
 *
 * - `detect_pennants`: 分類前の棄却をすべて `type: 'flag'` で積む。このラベルは
 *   flag だけでなく pennant も覆う。
 * - `detect_triangles`: 分類前の棄却（`poor_trendline_fit` / `classification_failed`）を
 *   `type: 'triangle'` で積む。このラベルは三角形 3 種を覆う。
 *
 * 入力エイリアス（schema の `PATTERN_FILTER_ALIASES`）の `'flag' → bull_flag + bear_flag`
 * とは被覆が違うので、2 つの写像を分けて持つ。
 *
 * `detect_wedges` は umbrella ラベルを持たない。棄却の大半は
 * `validateRegressionCandidate` の引数 `wedgeType`（`'rising_wedge' | 'falling_wedge'`）で
 * 積んでおり、呼び出し元で**分類済み**。ラベルは実際の型と一致している。
 *
 * ただし `detectRegressionWedges` には**同じ傾き推定でラベルを決めている push が 2 箇所**あり
 * （`r2_below_threshold` と `type_classification_failed`）、どちらも傾きの向きが揃わない窓を
 * `triangle_symmetrical` として積む。**ウェッジ走査の棄却なのに三角形のラベルが付く**
 * （#129 の対象外。umbrella の `'wedge'` が `PatternFilterEnum` に無いため、直すにはまず
 * 入力語彙を足すかを決める必要がある）。**直すときは 2 箇所とも直すこと**——片方だけ直すと
 * 同じ推論が残って症状が半分だけ残る。
 *
 * ## 直すのはラベル側であってこのモジュールではない（#129）
 *
 * `detect_triangles` はかつて分類前の棄却を具体型 `triangle_symmetrical` で積んでいたため、
 * `patterns=['triangle_descending']` では candidates が 0 件になっていた——検出器は実際に
 * 走査・棄却しているのに理由が届かなかった。#129 で push 側を `'triangle'` に変えて解消した。
 *
 * ここで `triangle_symmetrical` を三角形 3 種に被覆させる案は採らなかった。それをすると
 * 対称三角形を要求していない呼び出しにまで対称三角形の候補（分類**後**の棄却・採用を含む）を
 * 返してしまい、規約「want に含まれない種別の candidate が出ない」に反する。
 * 新しい検出器を足すときも同じ——分類前の棄却は umbrella ラベルで積むこと。
 */

/**
 * 入力 `patterns` のエイリアス → 具体 type。
 * `src/schema/patterns.ts` の `PATTERN_FILTER_ALIASES` のコメントと 1:1 で対応する。
 */
export const INPUT_ALIAS_EXPANSION: Readonly<Record<string, readonly string[]>> = {
	flag: ['bull_flag', 'bear_flag'],
	pennant: ['bull_pennant', 'bear_pennant'],
	triangle: ['triangle_ascending', 'triangle_descending', 'triangle_symmetrical'],
};

/**
 * candidate の `type` ラベルが実際に覆う具体 type。
 * ここに無いラベルは自分自身だけを覆う。
 */
export const CANDIDATE_LABEL_COVERAGE: Readonly<Record<string, readonly string[]>> = {
	// detect_pennants は方向・形状の分類前の棄却をすべてこのラベルで積む（flag / pennant 両方）。
	flag: ['bull_flag', 'bear_flag', 'bull_pennant', 'bear_pennant'],
	pennant: ['bull_pennant', 'bear_pennant'],
	// detect_triangles は 3 種の分類が確定する前の棄却をこのラベルで積む（#129）。
	triangle: ['triangle_ascending', 'triangle_descending', 'triangle_symmetrical'],
};

/** `want`（入力 `patterns`）を具体 type の集合に展開する。 */
export function expandWantedTypes(want: ReadonlySet<string>): Set<string> {
	const out = new Set<string>();
	for (const w of want) {
		for (const t of INPUT_ALIAS_EXPANSION[w] ?? [w]) out.add(t);
	}
	return out;
}

/** candidate ラベルが覆う具体 type。未知のラベルは自分自身のみ。 */
export function candidateLabelCoverage(type: string): readonly string[] {
	return CANDIDATE_LABEL_COVERAGE[type] ?? [type];
}

/**
 * `debug.candidates` を `want` で絞る。
 *
 * `want` が空（= `patterns` 未指定 = 全種別）のときは絞らない。
 * このとき返す配列の中身は入力と完全に同一で、順序も保つ。
 *
 * @param candidates 各検出器が push した候補
 * @param want 入力 `patterns`（エイリアス含む）。空 = 全種別
 */
export function filterCandidatesByWant<T extends { type: string }>(
	candidates: readonly T[],
	want: ReadonlySet<string>,
): T[] {
	if (!Array.isArray(candidates)) return [];
	if (want.size === 0) return [...candidates];
	const wanted = expandWantedTypes(want);
	return candidates.filter((c) => candidateLabelCoverage(String(c?.type)).some((t) => wanted.has(t)));
}
