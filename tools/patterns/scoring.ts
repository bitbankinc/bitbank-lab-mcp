/**
 * patterns/scoring.ts — 反転パターン（double / triple / H&S）の confidence サブスコア軸
 *
 * `PatternScoreBreakdown` の各軸を作る純粋関数だけを置く。検出器・`debugCandidates`・
 * スキーマのことは知らない。
 *
 * ## なぜ `helpers.ts` ではなく新ファイルなのか（issue #199 候補 1）
 *
 * `retracementScore` / `breakoutQualityScore` は `detect_doubles.ts` の module-private 関数
 * だったものを共有化したもので、置き場所として `helpers.ts` への追加も検討した。新ファイルに
 * したのは次の 3 点による:
 *
 * 1. **`helpers.ts` は既に 700 行超の雑多な寄せ集め**（バー数換算・wedge / triangle の幾何・
 *    タッチ評価・重複排除・`finalizeConf`）で、反転パターン固有の軸を足すと更に混ざる。
 *    隣には `reversal-gate.ts` / `ranking.ts` / `bar-thresholds.ts` / `min-bars.ts` という
 *    単機能モジュールが並んでおり、そちらの粒度に合わせるほうが既存の構成と揃う。
 * 2. **依存の向きを増やさないため。** 本モジュールは `structural.ts`（`RETRACEMENT_MIN` /
 *    `RETRACEMENT_MAX` / `ReversalSide`）に依存する。`helpers.ts` は現在 `structural.ts` を
 *    import していないので、そこに置くと **wedge / triangle / 重複排除しか使わない側にまで**
 *    構造ゲートの定数が芋づるで入ってくる。
 * 3. **triple 専用にしないため。** #204（H&S）でも同じ 2 関数を使う予定で、`detect_doubles.ts`
 *    から `detect_triples.ts` が import する（検出器どうしが横に依存する）形は避けたい。
 *
 * **軸の定義そのものは double から一切変えていない。** 切り出しは挙動不変で、
 * `tests/patterns/scoring.test.ts` が double 由来の値を固定する。
 */
import { EPSILON } from '../../lib/math.js';
import { clamp01 } from './regression.js';
import { RETRACEMENT_MAX, RETRACEMENT_MIN, type ReversalSide } from './structural.js';

/**
 * 戻り率スコア。許容帯 [{@link RETRACEMENT_MIN}, {@link RETRACEMENT_MAX}] の**中央で 1、端で 0**。
 *
 * 帯の外は構造ゲートが既に弾いているので、ここに来る値は必ず帯の中にある。
 * 「帯の中央 = 教科書的な戻り」という評価であって、合否の判定ではない。
 */
export function retracementScore(ratio: number | undefined): number | undefined {
	if (ratio === undefined || !Number.isFinite(ratio)) return undefined;
	const center = (RETRACEMENT_MIN + RETRACEMENT_MAX) / 2;
	const halfWidth = (RETRACEMENT_MAX - RETRACEMENT_MIN) / 2;
	if (halfWidth <= 0) return undefined;
	return clamp01(1 - Math.abs(ratio - center) / halfWidth);
}

/**
 * ブレイク品質スコア。突破足の終値がネックラインをパターン高さの何割ぶん超えたか。
 *
 * ネックラインぎりぎりの突破（`BREAKOUT_BUFFER_PCT` すれすれ）と、
 * 高さの半分ぶん一気に抜けた突破を同じ整合度にしないための軸。
 *
 * **未ブレイク（`near_completion`）では算出できない**——呼び出し側は `breakoutClose` に
 * `NaN` を渡し、`undefined` が返るので平均から外す（0 として混ぜると欠測が減点になる）。
 */
export function breakoutQualityScore(
	necklinePrice: number,
	breakoutClose: number,
	patternHeight: number,
	side: ReversalSide,
): number | undefined {
	if (!Number.isFinite(breakoutClose) || !(patternHeight > EPSILON)) return undefined;
	const excess = side === 'bottom' ? breakoutClose - necklinePrice : necklinePrice - breakoutClose;
	return clamp01(excess / patternHeight);
}

/**
 * 算出できた軸だけの相加平均。**`undefined` の軸は平均から外す**（0 として混ぜると
 * 「測れなかった」が「悪い」に化ける）。1 軸も無い場合だけ `undefined` を返す。
 */
export function averageDefinedAxes(values: Array<number | undefined>): number | undefined {
	const defined = values.filter((v): v is number => v !== undefined);
	if (defined.length === 0) return undefined;
	return defined.reduce((sum, v) => sum + v, 0) / defined.length;
}
