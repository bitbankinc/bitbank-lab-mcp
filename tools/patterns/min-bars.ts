/**
 * patterns/min-bars.ts - 「時間足 × 検出器 → 最小要求バー数」の単一ソース
 *
 * `docs/tools.md` の「`limit` の実効下限」§2（パターンサイズ由来の下限）を、手書きの表ではなく
 * 各検出器の定数から導出する。閾値そのものは各検出器に置いたまま、
 * **どの時間足でどれだけの窓が要るか**の計算だけをここに集約する。
 *
 * ## なぜ要るか
 *
 * #114 でスキャン窓が「直近 `limit` 本」に一致した結果、閾値が窓を超えると
 * **そのパターン種別だけが静かに 0 件になる**（issue #118）。閾値は 6 ファイルに散っていて、
 * 個々の組み合わせが到達可能かどうかを人手で追えない。ここで機械可読にしておけば、
 * 到達性を CI で固定でき、閾値を動かしたときに何が到達不能になるかが即座に分かる。
 *
 * 閾値のプリミティブは `patterns/bar-thresholds.ts` でバー数に統一済み。
 * **全検出器がこの換算に乗っている**ので、ここは各検出器の「バー数レンジ」を
 * スキャン窓の本数（添字ではなく本数）に読み替えるだけでよい。
 *
 * ## 何を返すか / 返さないか
 *
 * 返すのは **パターンサイズ閾値由来の下限**、つまり「その時間足でパターンの大きさの条件が
 * 満たされうる最小のスキャン窓本数」。`docs/tools.md` §2 の表と同じ意味論で、
 * 以下は**含めない**:
 *
 * - スイング検出の構造的下限（前後 `swingDepth` 本の除外）
 *   → `patterns/scan-window.ts` の `assessScanWindow`（docs §1）が担当。二重に持たない。
 * - 時間足でスケールしない絶対ガード
 *   （`detect_pennants` / `detect_triangles` の `if (lastIdx < 15) return`、
 *   `detect_patterns.ts` の `candles.length < 20`）
 *   → いずれも 21 本以下の定数で、既定 `limit`（90）では効かない。
 *
 * ## 対象外の検出器
 *
 * - **完成済み double / triple / H&S**: サイズ閾値を持たない（ピボット構造のみ）。
 * - **形成中 double**: **そもそも形成中経路が無い**（issue #268 案 C で `tryFormingDoubleTop` を
 *   削除した。double は `near_completion` / `expired` / `invalid` / `completed` の 4 段）。
 *   完成済み経路（`near_completion` を含む）が要求するのはピボット 3 点の間隔
 *   （`minDist` × 2 + 前後の `swingDepth`）だけで、これは §2 ではなく §1 の一般式
 *   （`2 × swingDepth + 2 × max(minBarsBetweenSwings, 5) + 1`）が担う。
 * - **形成中 wedge**: `formingWindowMin` は下限に見えるが、`detect_wedges` は
 *   「最新に揃えた特別ウィンドウ」を `Math.max(0, lastIdx - size)` で clamp して必ず積むため、
 *   窓が足りなくても候補が消えない。ハードなゲートではないのでここでは扱わない。
 */

import { getHsFormingBarParams } from './detect_hs.js';
import { getFlagParams } from './detect_pennants.js';
import { getTriangleParams } from './detect_triangles.js';
import { getTripleFormingBarParams } from './detect_triples.js';
import { getWedgeBarParams } from './detect_wedges.js';

/**
 * パターンサイズの下限を持つ検出器の識別子。
 *
 * `docs/tools.md` §2 の表が持つのは `forming_triple` / `forming_hs` / `completed_wedge` /
 * `flag_pennant` の 4 列。`triangle` は同じクラスの閾値を持つが表では散文で触れているだけなので、
 * ここで併せて導出する（到達性テストの網羅性のため）。
 *
 * **`forming_double` は #268 案 C で外した**（形成中 double の経路が無くなり、この検出器種別の
 * 構造的下限そのものが意味を失った）。上の「対象外の検出器」を参照。
 */
export const MIN_BARS_DETECTORS = [
	'forming_hs',
	'forming_triple',
	'completed_wedge',
	'triangle',
	'flag_pennant',
] as const;

export type MinBarsDetector = (typeof MIN_BARS_DETECTORS)[number];

/**
 * その時間足でその検出器が候補を作りうる最小のスキャン窓本数を返す。
 *
 * 「この本数あれば検出できる」ではなく「これ未満だとサイズ閾値で構造的に 0 件」という下限。
 * 実効的な制約は `limit` そのものではなく `meta.scan.bars`（実際に走査した本数）。
 */
export function minBarsForDetector(tf: string, detector: MinBarsDetector): number {
	switch (detector) {
		// 形成中の反転パターン 2 種（triple / H&S）は同じ形をしている: `formationBars` をバー数
		// レンジと突き合わせる（`patterns/bar-thresholds.ts` の換算）。`formationBars` は添字の差
		// （triple は `lastIdx - 左ピボット.idx`、H&S は `右肩.idx - 左肩.idx`）なので、
		// 窓としては 1 本多く要る。H&S の右肩は確定ピボットのこともあり、その場合は
		// `右肩.idx < lastIdx` ぶんさらに広い窓が要る——ここが返すのは下限なのでこれでよい。
		case 'forming_hs':
			return getHsFormingBarParams(tf).minBars + 1;

		case 'forming_triple':
			return getTripleFormingBarParams(tf).minBars + 1;

		// detect_wedges.ts: `generateWindows` は `start + size < totalBars` で回すので、
		// 最小サイズの窓が 1 つでも生成されるには `totalBars >= windowSizeMin + 1` が要る。
		case 'completed_wedge':
			return getWedgeBarParams(tf).windowSizeMin + 1;

		// detect_triangles.ts: `effectiveMax = Math.min(lastIdx - 5, maxWindowBars)` に対して
		// `minWindowBars <= effectiveMax` でないと windowSizes が空になる。
		// → `lastIdx >= minWindowBars + 5` → `bars >= minWindowBars + 6`。
		// `minWindowBars` は構造的下限（`structuralFloorBars`）なので時間足でスケールする。
		case 'triangle':
			return getTriangleParams(tf).minWindowBars + 6;

		// detect_pennants.ts: スキャンループは `poleEnd = poleMinBars` から始まり
		// `poleEnd <= lastIdx - consMinBars` で回る。`poleEnd` は添字なので初回の反復に入るには
		// `bars >= poleMinBars + consMinBars + 1` が要る（旗竿と保ち合いの境界となる 1 本ぶん）。
		// forming_triple / completed_wedge の +1 と同じ性質の端点で、揃えて含める。
		case 'flag_pennant': {
			const { poleMinBars, consMinBars } = getFlagParams(tf);
			return poleMinBars + consMinBars + 1;
		}
	}
}

/** 1 時間足ぶんの全検出器の最小要求バー数。 */
export function minBarsTableForTf(tf: string): Record<MinBarsDetector, number> {
	const out = {} as Record<MinBarsDetector, number>;
	for (const d of MIN_BARS_DETECTORS) out[d] = minBarsForDetector(tf, d);
	return out;
}

/**
 * その検出器がそのスキャン窓で到達可能か（＝サイズ閾値が窓を超えていないか）。
 *
 * @param bars スキャン窓の本数（実効値は `meta.scan.bars`）
 */
export function isDetectorReachable(tf: string, detector: MinBarsDetector, bars: number): boolean {
	return minBarsForDetector(tf, detector) <= bars;
}
