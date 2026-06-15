/**
 * 数値演算ユーティリティ
 * 各ツールで重複していた関数を統一
 */

/** ゼロ除算ガード用イプシロン */
export const EPSILON = 1e-12;

/**
 * 配列の平均値を計算
 * @param arr 数値配列
 * @returns 平均値、空配列の場合はnull
 */
export function avg(arr: number[]): number | null {
	return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
}

/**
 * 配列の中央値を計算
 * @param arr 数値配列
 * @returns 中央値、空配列の場合はnull
 */
export function median(arr: number[]): number | null {
	if (!arr.length) return null;
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 配列の標準偏差を計算
 *
 * 既定は母集団分散（divisor = n）。`sample=true` で標本分散（divisor = n-1, Bessel 補正）。
 * 実現ボラ（サンプルからの母分散推定）は n-1 が統計標準。一方、z-score 正規化や
 * ヒューリスティック閾値（candle-validate / depth-analysis 等）は母集団のままが妥当なため、
 * 既定挙動は変えず opt-in とする。
 *
 * @param values 数値配列
 * @param sample true で標本分散（n-1）。既定 false（母集団 n）
 * @returns 標準偏差、空配列または標本分散で要素1以下の場合は0
 */
export function stddev(values: number[], sample = false): number {
	const n = values.length;
	if (n === 0) return 0;
	const divisor = sample ? n - 1 : n;
	if (divisor <= 0) return 0;
	const mean = values.reduce((s, v) => s + v, 0) / n;
	const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / divisor;
	return Math.sqrt(Math.max(0, variance));
}

/**
 * スライディングウィンドウ平均（SMA）
 * @param values 数値配列
 * @param window ウィンドウサイズ（>= 1）
 * @returns 各ウィンドウの平均値配列（長さ = values.length - window + 1）
 */
export function slidingMean(values: number[], window: number): number[] {
	const out: number[] = [];
	if (!Number.isFinite(window) || window <= 0) return out;
	let sum = 0;
	for (let i = 0; i < values.length; i++) {
		sum += values[i];
		if (i >= window) sum -= values[i - window];
		if (i >= window - 1) out.push(sum / window);
	}
	return out;
}

/**
 * スライディングウィンドウ標準偏差
 *
 * 既定は母集団分散（divisor = window）。`sample=true` で標本分散（divisor = window-1）。
 * 既定挙動は `stddev` と同じ理由で母集団のままとし、n-1 は opt-in とする。
 *
 * @param values 数値配列
 * @param window ウィンドウサイズ（>= 2）
 * @param sample true で標本分散（window-1）。既定 false（母集団 window）
 * @returns 各ウィンドウの標準偏差配列（長さ = values.length - window + 1）
 */
export function slidingStddev(values: number[], window: number, sample = false): number[] {
	const out: number[] = [];
	if (window <= 1) return out;
	let sum = 0;
	let sumsq = 0;
	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		sum += v;
		sumsq += v * v;
		if (i >= window) {
			const old = values[i - window];
			sum -= old;
			sumsq -= old * old;
		}
		if (i >= window - 1) {
			const n = window;
			const mean = sum / n;
			// 標本: Σ(x-mean)² / (n-1) = (sumsq - n*mean²)/(n-1)。母集団: sumsq/n - mean²（既存式を維持）。
			const variance = sample ? Math.max(0, (sumsq - n * mean * mean) / (n - 1)) : Math.max(0, sumsq / n - mean * mean);
			out.push(Math.sqrt(variance));
		}
	}
	return out;
}
