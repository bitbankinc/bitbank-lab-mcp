/**
 * patterns/scan-window.ts - スキャン窓が構造上足りているかの判定
 *
 * スキャン窓は「直近 `limit` 本」に一致する（#114）。それ以前は warmup 分
 * （`limit + 199` 本）まで走査していたため窓の狭さが表面化しなかったが、窓を要求どおりに
 * 絞った結果、`limit` をスキーマ下限（20）付近まで小さくすると**構造上何も検出できない窓**
 * を作れるようになった。
 *
 * 崖の正体は `detectSwingPoints`（`patterns/swing.ts`）が窓の前後 `swingDepth` 本を
 * ピボット候補から外すこと。日足の既定 `swingDepth=6` では `limit=20` に対して
 * 候補が 8 本しか残らず、3 ピボットの反転パターン（最小間隔 5 本 × 2）が張れない。
 * `detect_patterns.ts` の `candles.length < 20` ガードはこれを「ちょうど 20」で通してしまうため、
 * 呼び出し側には「0 件検出」としか見えない。
 *
 * スキーマの `limit` 下限（20）は公開契約なので変更しない（`.claude/rules/tools.md` 規約 7）。
 * 代わりに `data.warnings` で申告し、`content` にも 1 行出して LLM が気づけるようにする。
 */

import { timeframeLabel } from '../../lib/formatter.js';

/**
 * 構造的下限を導くときに `minBarsBetweenSwings` に被せる床（本）。
 *
 * **⚠️ この 5 は、現在どの検出器の要件にも対応していない。それでも #134 の実測判定で据え置きを確定した。**
 * 名前が「構造的（structural）」と読めるが、**構造から導かれた不変量ではない。**
 * 根拠を探しても見つからないので探さないこと——下記が根拠のすべてである。
 *
 * ## 元の根拠と、それが消えた経緯
 *
 * この 5 はもともと `detect_doubles.ts` の `MIN_PIVOT_DISTANCE_BARS`、すなわち
 * **double 検出器が実際に要求する最小ピボット間隔**だった（当時の docstring は
 * 「double 検出は下限 5 を持つため大きい方を採る」と書いていた）。
 * issue #130 / PR #132 で検出器側の 5 を削除し、ピボット間隔は全検出器が `ctx.minDist`
 * （= 公開パラメータ `minBarsBetweenSwings`）をそのまま使う形に統一した
 * （`detect_triples` / `detect_hs` は元からそうで、double だけが黙って上書きしていた）。
 * **その時点で、この床が写していた検出器の挙動は存在しなくなった。**
 *
 * ## 据え置いている理由（経験的なもので、構造的必然ではない）
 *
 * この値は警告だけの値ではなく **`patterns/bar-thresholds.ts` の `structuralFloorBars` の
 * 唯一の入力**である。そこから `patternMinBars` / `patternBarsCap` を経由して
 * **全検出器のパターンサイズ閾値**（`docs/tools.md`「パターンサイズ由来の下限」表）が決まり、
 * **#121 の閾値調整はこの床（と `× 2` の上限）を前提に行われている。**
 * 床は下限であると同時に上限の基数でもあるので、下げると帯が両側から縮む。
 *
 * 床を外すと `minBarsBetweenSwings < 5` の 9 時間足で構造的下限が縮み、**double とは無関係の
 * triangle / wedge / triple が一斉に緩む**。#134 でこの増分を 1 件ずつ判定した——
 * main（24db879）で PR #131 / #132 / #135 と同じ 704 ケース比較を床なしビルドと突き合わせると
 * パターン総数 320 → 392 で、純増 +72 の実体は 9 パターン × オプション 8 ケース。内訳は
 * **正しい検出 1**（FormingDoubleBottom の 1hour 形成中 double。1day で検出済みの同一構成点）/
 * **誤検出・冗長 6**（矩形レンジへの triangle_ascending、H&S 本体の triangle_symmetrical への
 * 読み替え 2、検出済み triple_top と同一レジスタンスの重複 forming ほか）/
 * **幾何は正しいがラベルが劣化する灰色 2**。誤検出側が多数のため据え置きを確定した。
 * ほかに既存検出の range 付け替え 80 ケース・整合度変化 8 ケースの揺れを伴う。
 * 個々の判定根拠は CHANGELOG の #134 エントリと、#134 を閉じた PR を参照。
 *
 * ## 動かす場合に同時に動くもの
 *
 * `docs/tools.md` の 2 つの表（「構造的下限」/「パターンサイズ由来の下限」）・
 * `patterns/min-bars.ts` の導出値・`tests/patterns/invariants.test.ts` の到達性・
 * `#117` の警告 `limit_too_small_for_timeframe` の `suggestedParams.limit`。
 */
export const STRUCTURAL_PIVOT_GAP_FLOOR_BARS = 5;

/** `data.warnings[].type`。`low_detection_count` と同じ枠で返す。 */
export const SCAN_WINDOW_WARNING_TYPE = 'limit_too_small_for_timeframe';

/** `data.warnings[]` の 1 要素（detect_patterns の warnings 配列と同形）。 */
export interface PatternWarning {
	type: string;
	message: string;
	suggestedParams?: Record<string, unknown>;
}

export interface ScanWindowAssessment {
	/** 検出器に実際に渡した足の本数（= スキャン窓）。 */
	bars: number;
	/** 前後 `swingDepth` 本を除いた、ピボットになり得る足の本数。 */
	pivotCandidateBars: number;
	/** 3 ピボット構造を張るのに必要なピボット候補の本数。 */
	requiredPivotCandidateBars: number;
	/** ピボット間に要求される最小間隔（本）。 */
	pivotGapBars: number;
	/** その時間足・その swingDepth で構造上検出可能になる最小の窓（= 推奨 limit）。 */
	minViableLimit: number;
	/** 窓が構造上足りているか。 */
	sufficient: boolean;
}

/**
 * スキャン窓が「最小構成の反転パターン」を張れるかを判定する。
 *
 * 判定に使う最小構成は **double top / bottom**（本ツールが検出する中で最も安い 3 ピボット構造）。
 * H&S（5 ピボット）や三角形・ウェッジ（窓ベース）はこれより広い窓を要求するので、
 * ここが通らない窓ではそれらも当然出ない。逆にここが通っても検出を保証するものではない
 * ——あくまで「構造上ゼロ」の崖を検出するための下限。
 *
 * 間隔には {@link STRUCTURAL_PIVOT_GAP_FLOOR_BARS} の床が掛かるので、`minBarsBetweenSwings`
 * が 5 未満の時間足では**実際の検出器より 1〜4 本ぶん保守的**な下限が出る（警告としては
 * 安全側 = 少し多めの `limit` を勧める向き）。床の妥当性は #134 で実測判定済み（据え置き）——
 * 同定数の docstring を参照。
 *
 * @param bars 検出器に渡した足の本数
 * @param swingDepth スイング検出の深さ（前後この本数ぶんが候補から落ちる）
 * @param minBarsBetweenSwings 実効の最小ピボット間隔。{@link STRUCTURAL_PIVOT_GAP_FLOOR_BARS}
 *        を床に被せて大きい方を採る——**検出器の挙動の写しではなく**、パターンサイズ閾値の
 *        基準点を安定させるための保守側の床。理由は同定数の docstring を参照。
 */
export function assessScanWindow(bars: number, swingDepth: number, minBarsBetweenSwings: number): ScanWindowAssessment {
	const safeBars = Number.isFinite(bars) ? Math.max(0, Math.trunc(bars)) : 0;
	const safeDepth = Number.isFinite(swingDepth) ? Math.max(0, Math.trunc(swingDepth)) : 0;
	const safeMinDist = Number.isFinite(minBarsBetweenSwings) ? Math.max(1, Math.trunc(minBarsBetweenSwings)) : 1;

	const pivotGapBars = Math.max(safeMinDist, STRUCTURAL_PIVOT_GAP_FLOOR_BARS);
	// 3 ピボット（山・谷・山）を最小間隔で並べるのに要る幅 + 両端の 1 本。
	const requiredPivotCandidateBars = 2 * pivotGapBars + 1;
	// detectSwingPoints は idx ∈ [swingDepth, bars - swingDepth) だけを候補にする。
	const pivotCandidateBars = Math.max(0, safeBars - 2 * safeDepth);
	const minViableLimit = 2 * safeDepth + requiredPivotCandidateBars;

	return {
		bars: safeBars,
		pivotCandidateBars,
		requiredPivotCandidateBars,
		pivotGapBars,
		minViableLimit,
		sufficient: pivotCandidateBars >= requiredPivotCandidateBars,
	};
}

/**
 * 窓が足りていなければ `data.warnings` に載せる警告を返す。足りていれば `null`。
 *
 * `suggestedParams.limit` は**構造上の下限**であって「これだけあれば検出できる」値ではない
 * （各検出器が持つパターンサイズのバー数下限が別途かかる。`patterns/bar-thresholds.ts` で
 * バー数に統一済み — #121。表は `patterns/min-bars.ts` が導出する）。
 * メッセージ側で swingDepth を下げる選択肢も示す。
 */
export function buildScanWindowWarning(params: {
	type: string;
	bars: number;
	swingDepth: number;
	minBarsBetweenSwings: number;
}): PatternWarning | null {
	const { type, bars, swingDepth, minBarsBetweenSwings } = params;
	const a = assessScanWindow(bars, swingDepth, minBarsBetweenSwings);
	if (a.bars <= 0 || a.sufficient) return null;

	const tfLabel = timeframeLabel(String(type));
	const message =
		`limit が${tfLabel}（${type}）に対して小さすぎます: ` +
		`スキャン窓 ${a.bars}本 のうち前後 swingDepth=${swingDepth}本 ずつがスイング検出から外れるため、` +
		`ピボット候補は ${a.pivotCandidateBars}本 しか残りません` +
		`（最小構成の反転パターン＝3 ピボット × 最小間隔 ${a.pivotGapBars}本 には ${a.requiredPivotCandidateBars}本 必要）。` +
		`この窓では構造上ほぼ何も検出できないので、0 件を「パターンが無い」と解釈しないこと。` +
		`limit≥${a.minViableLimit} にするか、swingDepth を下げてください。`;

	return {
		type: SCAN_WINDOW_WARNING_TYPE,
		message,
		suggestedParams: { limit: a.minViableLimit },
	};
}

/** `data.warnings` から本モジュールの警告メッセージだけを取り出す（content 連結用）。 */
export function extractScanWindowWarnings(warnings: ReadonlyArray<PatternWarning> | undefined | null): string[] {
	if (!Array.isArray(warnings)) return [];
	return warnings.filter((w) => w?.type === SCAN_WINDOW_WARNING_TYPE && !!w.message).map((w) => w.message);
}
