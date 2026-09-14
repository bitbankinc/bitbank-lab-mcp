/**
 * patterns/mutual-exclusion.ts — 型間排他（issue #218 Phase 2）
 *
 * `triple_*` と H&S 系が**同じ主構成点**を 2 点以上共有して同時に出力される二重出力を、
 * triple 側を落とすことで解消する。
 *
 * ## なぜ triple を落とすのか（閾値ではなく検証済みの証拠で決める）
 *
 * ```text
 * H&S は headProminencePct のゲートを通過している
 *   = 中央の構成点が両隣と明確に違うことが既に検証済み
 * triple の前提は「3 点が同水準」
 *   = 中央が突出していないこと
 * ```
 *
 * 同じ点集合が両方を満たすなら、**中央が突出しているという検証済みの証拠がある側**が正しい。
 * したがって落とすのは常に triple で、H&S 側は 1 件も落とさない。
 *
 * **本モジュールは閾値を一切持たない。** issue #218 Phase 1
 * （tjackiet/bitbank-lab-mcp#218 の計測記録）は「ネックラインからの深さ比」を hard gate に
 * する案を実測して**否定**している——価格系列上の構造が 13 件しかなく、accepted プールの
 * 空白帯を支えているのはサイズ検査 / ネックライン傾き / 構造ゲート / `validateLevelSpread` と
 * いった**深さ比を見ていない別の定数**で、#215 と同じ壊れ方をする。Phase 1 が確かな根拠を
 * 出せたのは**二重出力 18 ペア**（共有 3 点 5 / 2 点 6 / 1 点 7）だけなので、そこだけを
 * **調整すべき定数を 1 つも増やさずに**直す。深さ比は計算も出力もしない。
 *
 * 「2 点以上」はつまみではなく**規則そのもの**である。triple の主構成点は 3 点しかないので、
 * 2 点以上の共有は「同じ構造の別解釈」を意味し、1 点の共有は「たまたま端点が接している別構造」を
 * 意味する（Phase 1 の 1 点共有 7 ペアは実際に別構造）。値を動かす余地がある定数ではないため、
 * 名前付きのつまみとして公開しない。
 *
 * ## スコープは `triple_*` × H&S 系だけ
 *
 * `double_*` × H&S 系は**未計測なので触らない**。同じ論理（double の前提「2 点が同水準」に対して
 * H&S の頭は突出が検証済み）が成り立ちそうに見えるが、Phase 1 が測ったのは triple × H&S の
 * ペアだけで実データの裏付けが無い。やるなら別 issue で計測から。
 *
 * ## 根拠は「実際に出力される H&S」だけ（`patterns` で絞ると排他も効かない）
 *
 * 判定は**出力集合の中だけで閉じている**。`detect_patterns(patterns: ['triple_bottom'])` のように
 * 種別を絞ると H&S 検出器がそもそも走らないので、根拠になる H&S が集合に無く**排他は 1 件も
 * 起きない**（既定呼び出しでは落ちる triple がそのまま返る）。これは仕様で、逆に
 * 「要求されていない H&S を裏で検出して triple を消す」と、`patterns` で絞った呼び出しの
 * コストと結果が要求外の種別に左右される。落とす根拠は**呼び出し側が実際に受け取る H&S**に
 * 限る、という一点で揃えてある。
 *
 * ## `globalDedup` に混ぜない理由
 *
 * `globalDedup`（`helpers.ts`）は**期間の 70% 重複**で同カテゴリを統合する仕組みで、本件の
 * 「主構成点の共有」とは基準が別。`categoryMap` に H&S と triple を足すと、
 * **点を 1 つも共有していない別々のパターンまで**期間が重なっただけで統合される。
 * 独立した処理として書く。
 */
import type { Pivot } from './swing.js';
import type { DeduplicablePattern } from './types.js';

/**
 * 主構成点が乗る側（山 = `'H'` / 谷 = `'L'`）。**type ごとに明示する**——
 * `pivots` の配列上の位置は type で意味が違い、決め打ちの添字は経路によって破綻する（下表）。
 *
 * | type | `pivots` | 主構成点 | 完成済みの位置 |
 * |---|---|---|---|
 * | `triple_*` | `[a, b, c]` | 3 点すべて | `[0] [1] [2]` |
 * | H&S 系 | `[p0, p1, p2, p3, p4]` | 左肩・頭・右肩（`p1` / `p3` はネックラインの定義点） | `[0] [2] [4]` |
 *
 * **形成中の経路は同じ type でも配列長が違う**ので、位置ではなく `kind` で取る:
 * 形成中 H&S は 4 点（左肩 H / 頭 H / 戻り谷 L / 暫定右肩 H。`detect_hs.ts` の
 * `formingHsForHead`）で `[0] [2] [4]` は**戻り谷と undefined を拾って壊れる**。
 * 形成中 triple は 2 点（`detect_triples.ts` の `tryFormingTripleTop`）。
 * `kind` で取れば完成済みでは上表の位置と一致し、形成中でも意味が保たれる
 * （Phase 1 の計測も同じ取り方をしている。tjackiet/bitbank-lab-mcp#218 の計測記録 3 章）。
 *
 * **`double_*` は意図的に載せていない**（上記スコープ）。載せると `mainPointIdxs` が
 * 値を返すようになり、ペアの列挙に double を足すだけで**未計測の排他が動き出す**。
 */
const MAIN_POINT_KIND: Readonly<Record<string, Pivot['kind']>> = {
	triple_top: 'H',
	triple_bottom: 'L',
	head_and_shoulders: 'H',
	inverse_head_and_shoulders: 'L',
};

/**
 * type の**主構成点の `kind`** を返す（対象外の type は `undefined`）。`mainPointIdxs` と同じ表
 * （`MAIN_POINT_KIND`）を読むので、`pivots` の要素を「主構成点 / ネックライン定義点」に
 * 振り分ける側（`view=debug` の `pts.role`）と `idxs` の絞り込みが食い違わない。
 */
export function mainPointKind(type: string | undefined): Pivot['kind'] | undefined {
	return MAIN_POINT_KIND[String(type)];
}

/**
 * 本段が `view=debug` の candidates に積む理由コード。`details` に
 * `tripleMainIdxs` / `sharedCount` / `matches`（どの H&S と何点共有したか）が入る。
 *
 * **`tools/detect_patterns.ts` の cap トリムがこの値で優先度を判定する**ので、文字列を
 * 直書きせずここから読む（片方だけ書き換えると、押し出し防止が黙って効かなくなる）。
 */
export const TRIPLE_HS_EXCLUSION_REASON = 'excluded_by_hs_main_point_overlap';

/** `triple_*` か。 */
function isTriple(type: string): boolean {
	return type === 'triple_top' || type === 'triple_bottom';
}

/** H&S 系（順・逆）か。 */
function isHeadAndShoulders(type: string): boolean {
	return type === 'head_and_shoulders' || type === 'inverse_head_and_shoulders';
}

/**
 * パターンの**主構成点のローソク足添字**を昇順で返す。対象外の type / `pivots` が無い場合は空配列。
 *
 * 比較は必ず `idx`（ローソク足の添字）で行う——価格は検出器ごとに終値基準 / 高安基準が違う
 * （`swing.ts` の `Pivot` の表）ので、同じ点かどうかの判定には使えない。
 */
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

/** 排他で落とした triple 1 件と、根拠になった H&S 側の情報。 */
export interface TripleHsOverlap {
	/** 落とした triple 本体。 */
	triple: DeduplicablePattern;
	/** triple の主構成点（3 点。形成中なら 2 点）。 */
	tripleMainIdxs: number[];
	/**
	 * 主構成点を 2 点以上共有した H&S。**1 つの triple が複数の H&S と共有しうる**ので配列で持つ
	 * （落とす判断自体は「1 件でも該当すれば落とす」なので順序に依存しない）。
	 * 並びは入力の `patterns` 順で決定的。
	 */
	matches: Array<{ hsType: string; hsMainIdxs: number[]; sharedIdxs: number[] }>;
}

export interface TripleHsExclusionResult {
	/** 排他後に残ったパターン。**入力の順序を保つ。** */
	kept: DeduplicablePattern[];
	/** 落とした triple の明細（`view=debug` の理由コードに使う）。 */
	excluded: TripleHsOverlap[];
	/**
	 * この段で**比較対象になった H&S の件数**（入力集合のうち H&S 系で主構成点が取れたもの）。
	 *
	 * `excluded.length === 0` は 2 通りある——「H&S と比較したが 2 点以上共有する triple が
	 * 無かった」と「H&S が集合に 1 件も無く比較そのものが起きなかった」（モジュール冒頭の
	 * 「`patterns` で絞ると排他も効かない」）。呼び出し側はこの値が 0 かどうかで両者を区別する
	 * （issue #224 症状 1。`meta.reduction.tripleHsCandidateCount` として申告される）。
	 */
	hsCandidateCount: number;
}

/**
 * `triple_*` と H&S 系が主構成点を 2 点以上共有していたら triple 側を落とす。
 *
 * **H&S 側は 1 件も落とさない**（triple 以外は素通し）。判定は入力集合の中だけで閉じているので、
 * **呼び出し位置はライフサイクル絞り込みの後**でなければならない——先に落とすと、根拠にした
 * H&S があとから `includeForming` 等で消えて**どちらも残らない**ことがある。
 */
export function excludeTriplesSharingHsMainPoints(
	patterns: ReadonlyArray<DeduplicablePattern>,
): TripleHsExclusionResult {
	const hsEntries = patterns
		.filter((p) => isHeadAndShoulders(String(p?.type)))
		.map((p) => ({ type: String(p.type), mainIdxs: mainPointIdxs(p) }))
		.filter((e) => e.mainIdxs.length > 0);
	// 比較対象が無い = 排他を**試せなかった**。`excluded: []` だけでは「試して該当なし」と
	// 区別できないので `hsCandidateCount: 0` で申告する（issue #224 症状 1）。
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
			// 主構成点は 3 点しかないので、2 点の共有は「同じ構造の別解釈」。
			// 1 点は端点が接しているだけの別構造なので落とさない（モジュール冒頭）。
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
