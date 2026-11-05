export const EPSILON = 1e-12;

export function avg(arr: number[]): number | null {
	return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
}

export function median(arr: number[]): number | null {
	if (!arr.length) return null;
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// 既定は母集団分散（n）。実現ボラは標本（n-1）が標準だが、z-score や閾値（candle-validate / depth-analysis 等）は母集団のままが妥当なので opt-in にしている。
export function stddev(values: number[], sample = false): number {
	const n = values.length;
	if (n === 0) return 0;
	const divisor = sample ? n - 1 : n;
	if (divisor <= 0) return 0;
	const mean = values.reduce((s, v) => s + v, 0) / n;
	const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / divisor;
	return Math.sqrt(Math.max(0, variance));
}

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
