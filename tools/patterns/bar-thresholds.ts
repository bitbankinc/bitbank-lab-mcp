/**
 * patterns/bar-thresholds.ts - パターン閾値のプリミティブを「日数」から「バー数」に移す
 *
 * ## なぜ日数をやめるか
 *
 * 検出器の閾値は日足前提で書かれた時代の名残で「日数 × `barsPerDay(tf)`」という形をしていた
 * （`detect_wedges` の 25 日窓、`detect_triples` の 21 日など）。この換算は intraday で爆発する:
 * 25 日は `1hour` で 600 本、`1min` で 36000 本になり、既定 `limit`（90）はもちろん `limit` の
 * スキーマ上限（365）でも届かない。結果として**そのパターン種別だけが静かに 0 件になる**
 * （issue #118 問題 1 / 2）。
 *
 * 閾値の本来の意図は「形が成立するだけの構造がある」ことであって暦日数ではない。
 * 1時間足の利用者にとって「14 暦日にまたがるダブルトップ」は要件として意味を持たない。
 * そこで**プリミティブをバー数にし、日数は「その値がどこから来たか」を説明する注記に降格する**。
 *
 * ## 換算の形
 *
 * ```
 * minBars = clamp(round(days × barsPerDay(tf)), structuralFloorBars(tf), patternBarsCap(tf))
 * ```
 *
 * - **下限**（`structuralFloorBars`）は `patterns/scan-window.ts` の `assessScanWindow` から取る。
 *   時間足ごとの `swingDepth` / `minBarsBetweenSwings` が既に効いているので、
 *   「その時間足で 3 ピボット構造が張れる最小の窓」という意味が付く。
 *   `detect_wedges` にあったマジックナンバー `MIN_STRUCTURAL = 15` はこれで置き換えて廃止した
 *   （floor だけでは #118 は解けない——`max(15, round(25 × bpd))` の floor 側が選ばれるのは
 *   `1week` / `1month` だけで、`1day` 以下では日数換算値が必ず floor を上回る）。
 * - **上限**（`patternBarsCap`）は下限の定数倍。**走査窓（`limit`）には依存させない**——
 *   同じデータで `limit` 次第にパターンの定義が変わるのを避けるため。
 *
 * ## 倍率が 2 である理由
 *
 * `PATTERN_BARS_CAP_MULTIPLIER` は「既定 `limit`=90 で全時間足・全種別が到達可能」を満たす
 * 唯一の整数倍率:
 *
 * - **1 は不可**: 上限 = 下限になり clamp が潰れる。日数換算値が 1 本も生き残らず、
 *   全時間足の閾値が構造的下限そのものに退化する。
 * - **3 以上は不可**: flag / pennant の要求本数は `poleMinBars + consMinBars + 1` で、
 *   両者が上限に張り付く `15min` / `30min` では `3 × 17 × 2 + 1 = 103` 本 > 90 本となり
 *   既定 `limit` で到達不能に戻る。
 * - **2 なら全組み合わせが 90 本以下**（最大は flag / pennant の `15min` / `30min` = 69 本）。
 *
 * 到達性は `tests/patterns/invariants.test.ts`（不変条件 9）が機械的に固定している。
 *
 * ## どの閾値に使うか / 使わないか
 *
 * | 種類 | 例 | 換算 |
 * |---|---|---|
 * | パターンの大きさそのもの | ウェッジの窓サイズ、形成中トリプルの形成バー数、三角形の窓 | `patternMinBars` / `patternBarRange`（下限 + 上限） |
 * | ピボット構造を前提としない大きさ | 旗竿長、保ち合い長 | `cappedBarsForDays`（上限のみ。下限は各検出器の絶対値） |
 * | パターン内部の比率 | タッチ間隔の上限、走査ステップ | 窓サイズに対する比（本モジュールは関与しない） |
 *
 * 旗竿（pole）に構造的下限を掛けてはいけない。下限の前提は「前後 `swingDepth` 本の除外」と
 * 「3 ピボットの最小間隔」だが、旗竿はピボット構造ではなく単一のインパルス脚なので前提が成立しない。
 * 実際 `1day` に下限 23 本を掛けると `poleMinBars`(23) > `poleMaxBars`(15) となり検出が全滅する。
 */

import { getDefaultParamsForTf } from './config.js';
import { barsPerDay } from './helpers.js';
import { assessScanWindow } from './scan-window.js';

/**
 * その時間足で「形が成立しうる」最小のバー数（構造的下限）。
 *
 * `assessScanWindow` の `minViableLimit`（= `2 × swingDepth + 2 × max(minBarsBetweenSwings, 5) + 1`）。
 * 参照する `swingDepth` / `minBarsBetweenSwings` は**時間足の既定値**であって呼び出し側の
 * オプションではない。閾値が呼び出しごとに動くと「同じデータでパターンの定義が変わる」ため。
 */
export function structuralFloorBars(tf: string): number {
	const { swingDepth, minBarsBetweenSwings } = getDefaultParamsForTf(tf);
	return assessScanWindow(0, swingDepth, minBarsBetweenSwings).minViableLimit;
}

/** 構造的下限に対する上限の倍率。理由は本ファイル冒頭の「倍率が 2 である理由」を参照。 */
export const PATTERN_BARS_CAP_MULTIPLIER = 2;

/**
 * 日数換算値の上限（バー数）。構造的下限の定数倍で、**走査窓（`limit`）には依存しない**。
 */
export function patternBarsCap(tf: string): number {
	return structuralFloorBars(tf) * PATTERN_BARS_CAP_MULTIPLIER;
}

/**
 * 日数閾値を「形が成立するだけのバー数」に換算する（最小側）。
 *
 * @param days 元の日数閾値。値の出どころを説明するために残してあり、intraday では
 *             上限クランプに、`1week` / `1month` では下限クランプに吸収されることが多い。
 */
export function patternMinBars(tf: string, days: number): number {
	const raw = Math.round(days * barsPerDay(tf));
	return Math.min(patternBarsCap(tf), Math.max(structuralFloorBars(tf), raw));
}

/**
 * 日数レンジ `[minDays, maxDays]` をバー数レンジに換算する。
 *
 * 最小側は `patternMinBars`。最大側は**日数比を bar 空間でも保つ**——最小側がクランプで
 * 動いた分だけ最大側も一緒に動かないと、`1week` / `1month`（下限クランプが効く）で
 * `minBars > maxBars` の反転が起き、そのパターンが 0 件になる。
 * 素の `round(maxDays × bpd)` を使わないのは、intraday で上限が青天井になり
 * 走査ループの反復回数が爆発するため（形成中ウェッジの窓ループは走査窓長で頭打ちにならない）。
 *
 * **`patternBarsCap` は最大側には掛けない。** cap の役割は「最小要求バー数が既定 `limit`（90）に
 * 収まること」だけで、最大側は到達性に関与しない。掛けると cap が効く時間足で
 * `minBars === maxBars` になり、レンジ判定が等値判定に退化する（`1hour` の形成中トリプルは
 * `formationBars` がちょうど 34 本のときだけ通り、完成済みウェッジの走査ウィンドウは
 * 8 サイズ → 1 サイズに潰れる）。`1day` も [25, 90] → [25, 46] に狭まり、
 * 本モジュール導入前と同一だった挙動が壊れる。この不変条件は
 * `tests/patterns/bar-thresholds.test.ts` が固定している。
 */
export function patternBarRange(tf: string, minDays: number, maxDays: number): { minBars: number; maxBars: number } {
	if (!(minDays > 0) || !(maxDays >= minDays)) {
		throw new RangeError(`patternBarRange: 0 < minDays <= maxDays が必要 (minDays=${minDays}, maxDays=${maxDays})`);
	}
	const minBars = patternMinBars(tf, minDays);
	const maxBars = Math.max(minBars + 1, Math.round(minBars * (maxDays / minDays)));
	return { minBars, maxBars };
}

/**
 * 上限クランプだけを掛ける（構造的下限は使わない）。
 *
 * 旗竿・保ち合いのようにピボット構造を前提としない閾値用。下限は検出器が持つ絶対値
 * （「旗竿は最低 2 本」など）をそのまま使う。
 */
export function cappedBarsForDays(tf: string, days: number, absoluteMinBars: number): number {
	const raw = Math.round(days * barsPerDay(tf));
	return Math.min(patternBarsCap(tf), Math.max(absoluteMinBars, raw));
}
