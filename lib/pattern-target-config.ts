// ターゲット進捗の閾値。検出器（tools/patterns/target-reach.ts）と schema の description 生成
// （src/schema/patterns.ts）の両方が読むため、どちらにも依存しない葉モジュールに置く
// （schema→tools の実行時依存と循環を作らない）。

// 上限が無いと値が問い合わせ時点で動くので置く。取りこぼしを防ぐ走査幅であって、到達率の窓として読ませない（#288）。
// 時間足別のテーブルにしない。時間足別テーブルの流用は #198 で事故になっている。
export const TARGET_REACH_MAX_BARS = 60;

// 高さ相対（無次元）にして時間足別テーブルを持たない。分母が潰れるのはネックラインから投影する検出器だけ。
export const MIN_TARGET_DISTANCE_HEIGHT_RATIO = 0.15;

// この値ちょうどは「以上」を意味する。上の 2 つをすり抜けた場合の安全網。
export const TARGET_REACHED_PCT_CAP = 999;
