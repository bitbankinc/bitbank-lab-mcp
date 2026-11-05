import { ICHIMOKU_SHIFT } from './indicator-config.js';

const nanArray = (len: number): number[] => Array.from<number>({ length: len }).fill(NaN);

// 全指標で入力は古い順、データ不足の位置は NaN。丸めは呼び出し元で行う（analyze_indicators と trading_process が共有する）。

export function sma(prices: number[], period: number): number[] {
	if (period <= 0) {
		throw new Error('SMA period must be positive');
	}
	if (prices.length < period) {
		return nanArray(prices.length);
	}

	const result: number[] = nanArray(prices.length);
	let sum = 0;
	let nanCount = 0;

	for (let i = 0; i < period; i++) {
		if (Number.isNaN(prices[i])) nanCount++;
		else sum += prices[i];
	}
	result[period - 1] = nanCount === 0 ? sum / period : NaN;

	for (let i = period; i < prices.length; i++) {
		const oldVal = prices[i - period];
		if (Number.isNaN(oldVal)) nanCount--;
		else sum -= oldVal;

		const newVal = prices[i];
		if (Number.isNaN(newVal)) nanCount++;
		else sum += newVal;

		result[i] = nanCount === 0 ? sum / period : NaN;
	}

	return result;
}

export function ema(prices: number[], period: number): number[] {
	const result: number[] = nanArray(prices.length);
	if (period < 1) return result;

	const k = 2 / (period + 1);
	let prevEma: number | undefined;
	let seedSum = 0;
	let seedCount = 0;

	for (let i = 0; i < prices.length; i++) {
		const price = prices[i];
		if (!Number.isFinite(price)) {
			prevEma = undefined;
			seedSum = 0;
			seedCount = 0;
			continue;
		}
		if (prevEma === undefined) {
			seedSum += price;
			seedCount++;
			if (seedCount === period) {
				prevEma = seedSum / period;
				result[i] = prevEma;
			}
		} else {
			const next = price * k + prevEma * (1 - k);
			if (!Number.isFinite(next)) {
				// 防御的: 通常は到達しないが、到達したらリセット
				prevEma = undefined;
				seedSum = 0;
				seedCount = 0;
			} else {
				prevEma = next;
				result[i] = next;
			}
		}
	}

	return result;
}

// 変動なし区間（avgGain=0 かつ avgLoss=0）は中立値 50 を返す（業界標準）。
export function rsi(closes: number[], period: number): number[] {
	const result: number[] = nanArray(closes.length);

	if (closes.length < period + 1) {
		return result;
	}

	let avgGain = 0;
	let avgLoss = 0;
	for (let i = 1; i <= period; i++) {
		const change = closes[i] - closes[i - 1];
		if (change > 0) avgGain += change;
		else avgLoss += Math.abs(change);
	}
	avgGain /= period;
	avgLoss /= period;

	if (avgLoss === 0) {
		result[period] = avgGain === 0 ? 50 : 100;
	} else {
		result[period] = 100 - 100 / (1 + avgGain / avgLoss);
	}

	for (let i = period + 1; i < closes.length; i++) {
		const change = closes[i] - closes[i - 1];
		const gain = change > 0 ? change : 0;
		const loss = change < 0 ? Math.abs(change) : 0;

		avgGain = (avgGain * (period - 1) + gain) / period;
		avgLoss = (avgLoss * (period - 1) + loss) / period;

		if (avgLoss === 0) {
			result[i] = avgGain === 0 ? 50 : 100;
		} else {
			result[i] = 100 - 100 / (1 + avgGain / avgLoss);
		}
	}

	return result;
}

export function toNumericSeries(values: number[], decimals?: number): (number | null)[] {
	return values.map((v) => {
		if (!Number.isFinite(v)) return null;
		return decimals != null ? Number(v.toFixed(decimals)) : v;
	});
}

export function bollingerBands(
	values: number[],
	period: number = 20,
	stdDev: number = 2,
): { upper: number[]; middle: number[]; lower: number[] } {
	const n = values.length;
	const upper: number[] = nanArray(n);
	const middle: number[] = nanArray(n);
	const lower: number[] = nanArray(n);

	if (n < period) return { upper, middle, lower };

	let sum = 0;
	let nanCount = 0;
	for (let i = 0; i < period; i++) {
		if (Number.isNaN(values[i])) nanCount++;
		else sum += values[i];
	}

	for (let i = period - 1; i < n; i++) {
		if (i > period - 1) {
			const oldVal = values[i - period];
			if (Number.isNaN(oldVal)) nanCount--;
			else sum -= oldVal;

			const newVal = values[i];
			if (Number.isNaN(newVal)) nanCount++;
			else sum += newVal;
		}

		if (nanCount > 0) continue;

		const mean = sum / period;

		let sumSq = 0;
		for (let j = i - period + 1; j <= i; j++) {
			sumSq += (values[j] - mean) ** 2;
		}
		const std = Math.sqrt(sumSq / period);

		middle[i] = mean;
		upper[i] = mean + stdDev * std;
		lower[i] = mean - stdDev * std;
	}

	return { upper, middle, lower };
}

export function macd(
	values: number[],
	fast: number = 12,
	slow: number = 26,
	signal: number = 9,
): { line: number[]; signal: number[]; hist: number[] } {
	const emaFast = ema(values, fast);
	const emaSlow = ema(values, slow);
	const n = values.length;

	const line: number[] = nanArray(n);
	for (let i = 0; i < n; i++) {
		if (Number.isFinite(emaFast[i]) && Number.isFinite(emaSlow[i])) {
			line[i] = emaFast[i] - emaSlow[i];
		}
	}

	// Signal EMA — 有効な MACD 値のみでシードする
	const validStart = line.findIndex((v) => Number.isFinite(v));
	const signalLine: number[] = nanArray(n);

	if (validStart >= 0) {
		const validLine = line.slice(validStart).filter((v) => Number.isFinite(v));
		const sigEma = ema(validLine, signal);
		let idx = 0;
		for (let i = validStart; i < n; i++) {
			if (Number.isFinite(line[i])) {
				signalLine[i] = sigEma[idx++];
			}
		}
	}

	const hist: number[] = nanArray(n);
	for (let i = 0; i < n; i++) {
		if (Number.isFinite(line[i]) && Number.isFinite(signalLine[i])) {
			hist[i] = line[i] - signalLine[i];
		}
	}

	return { line, signal: signalLine, hist };
}

export function ichimokuSeries(
	highs: number[],
	lows: number[],
	closes: number[],
): { tenkan: number[]; kijun: number[]; spanA: number[]; spanB: number[]; chikou: number[] } {
	const n = highs.length;
	const tenkan: number[] = nanArray(n);
	const kijun: number[] = nanArray(n);
	const spanA: number[] = nanArray(n);
	const spanB: number[] = nanArray(n);

	const tenkanP = 9;
	const kijunP = 26;
	const senkouBP = 52;

	for (let i = 0; i < n; i++) {
		if (i >= tenkanP - 1) {
			const hSlice = highs.slice(i - tenkanP + 1, i + 1);
			const lSlice = lows.slice(i - tenkanP + 1, i + 1);
			tenkan[i] = (Math.max(...hSlice) + Math.min(...lSlice)) / 2;
		}

		if (i >= kijunP - 1) {
			const hSlice = highs.slice(i - kijunP + 1, i + 1);
			const lSlice = lows.slice(i - kijunP + 1, i + 1);
			kijun[i] = (Math.max(...hSlice) + Math.min(...lSlice)) / 2;
		}

		if (!Number.isNaN(tenkan[i]) && !Number.isNaN(kijun[i])) {
			spanA[i] = (tenkan[i] + kijun[i]) / 2;
		}

		if (i >= senkouBP - 1) {
			const hSlice = highs.slice(i - senkouBP + 1, i + 1);
			const lSlice = lows.slice(i - senkouBP + 1, i + 1);
			spanB[i] = (Math.max(...hSlice) + Math.min(...lSlice)) / 2;
		}
	}

	// chikou は終値そのまま（遅行スパンの位置シフトは呼び出し元で行う）
	const chikou = closes.slice();

	return { tenkan, kijun, spanA, spanB, chikou };
}

export function shiftChikou(chikou: number[], shift: number = 26): number[] {
	const n = chikou.length;
	const result: number[] = nanArray(n);
	for (let i = shift; i < n; i++) {
		result[i - shift] = chikou[i];
	}
	return result;
}

export function ichimokuSnapshot(
	highs: number[],
	lows: number[],
	_closes: number[],
): { conversion: number; base: number; spanA: number; spanB: number } | null {
	if (highs.length < 52 || lows.length < 52) return null;
	const conversion = (Math.max(...highs.slice(-9)) + Math.min(...lows.slice(-9))) / 2;
	const base = (Math.max(...highs.slice(-26)) + Math.min(...lows.slice(-26))) / 2;
	const spanA = (conversion + base) / 2;
	const spanB = (Math.max(...highs.slice(-52)) + Math.min(...lows.slice(-52))) / 2;
	return { conversion, base, spanA, spanB };
}

/** 今日の雲は ichi_series の spanA / spanB の短い方の末尾から ICHIMOKU_SHIFT 本前（末尾の値は ICHIMOKU_SHIFT 本後にプロットされる雲）。 */
export function currentCloudSpans(
	series: { spanA?: Array<number | null>; spanB?: Array<number | null> } | null | undefined,
): { spanA: number | null; spanB: number | null } {
	const spanA = series?.spanA;
	const spanB = series?.spanB;
	if (!Array.isArray(spanA) || !Array.isArray(spanB)) return { spanA: null, spanB: null };
	const len = Math.min(spanA.length, spanB.length);
	if (len < ICHIMOKU_SHIFT) return { spanA: null, spanB: null };
	return { spanA: spanA[len - ICHIMOKU_SHIFT] ?? null, spanB: spanB[len - ICHIMOKU_SHIFT] ?? null };
}

export function stochastic(
	highs: number[],
	lows: number[],
	closes: number[],
	kPeriod: number = 14,
	smoothK: number = 3,
	smoothD: number = 3,
): { kSeries: number[]; dSeries: number[] } {
	const n = Math.min(highs.length, lows.length, closes.length);
	if (n < kPeriod + smoothK + smoothD - 2) {
		return { kSeries: nanArray(n), dSeries: nanArray(n) };
	}

	const rawK: number[] = nanArray(n);
	for (let i = kPeriod - 1; i < n; i++) {
		let hi = -Infinity;
		let lo = Infinity;
		let hasInvalid = false;
		for (let j = i - kPeriod + 1; j <= i; j++) {
			const high = highs[j];
			const low = lows[j];
			if (!Number.isFinite(high) || !Number.isFinite(low)) {
				hasInvalid = true;
				break;
			}
			if (high > hi) hi = high;
			if (low < lo) lo = low;
		}
		if (hasInvalid) continue;
		const close = closes[i];
		if (!Number.isFinite(close)) continue;
		const range = hi - lo;
		rawK[i] = range === 0 ? 50 : ((close - lo) / range) * 100;
	}

	const kSeries: number[] = nanArray(n);
	for (let i = 0; i < n; i++) {
		if (!Number.isFinite(rawK[i])) continue;
		let sum = 0;
		let cnt = 0;
		for (let j = i - smoothK + 1; j <= i; j++) {
			if (j >= 0 && Number.isFinite(rawK[j])) {
				sum += rawK[j];
				cnt++;
			}
		}
		if (cnt === smoothK) kSeries[i] = sum / cnt;
	}

	const dSeries: number[] = nanArray(n);
	for (let i = 0; i < n; i++) {
		if (!Number.isFinite(kSeries[i])) continue;
		let sum = 0;
		let cnt = 0;
		for (let j = i - smoothD + 1; j <= i; j++) {
			if (j >= 0 && Number.isFinite(kSeries[j])) {
				sum += kSeries[j];
				cnt++;
			}
		}
		if (cnt === smoothD) dSeries[i] = sum / cnt;
	}

	return { kSeries, dSeries };
}

export function stochRSI(
	closes: number[],
	rsiPeriod: number = 14,
	stochPeriod: number = 14,
	smoothK: number = 3,
	smoothD: number = 3,
): { kSeries: number[]; dSeries: number[] } {
	const rsiValues = rsi(closes, rsiPeriod);
	const n = rsiValues.length;

	const validCount = rsiValues.filter((v) => Number.isFinite(v)).length;
	if (validCount < stochPeriod + smoothK + smoothD) {
		return { kSeries: nanArray(n), dSeries: nanArray(n) };
	}

	const rawK: number[] = nanArray(n);
	for (let i = 0; i < n; i++) {
		if (!Number.isFinite(rsiValues[i]) || i < stochPeriod - 1) continue;
		const window: number[] = [];
		for (let j = i - stochPeriod + 1; j <= i; j++) {
			if (Number.isFinite(rsiValues[j])) window.push(rsiValues[j]);
		}
		if (window.length < stochPeriod) continue;
		const lo = Math.min(...window);
		const hi = Math.max(...window);
		const range = hi - lo;
		rawK[i] = range === 0 ? 50 : ((rsiValues[i] - lo) / range) * 100;
	}

	const kSeries: number[] = nanArray(n);
	for (let i = 0; i < n; i++) {
		if (!Number.isFinite(rawK[i])) continue;
		let sum = 0;
		let cnt = 0;
		for (let j = i - smoothK + 1; j <= i; j++) {
			if (j >= 0 && Number.isFinite(rawK[j])) {
				sum += rawK[j];
				cnt++;
			}
		}
		if (cnt === smoothK) kSeries[i] = sum / cnt;
	}

	const dSeries: number[] = nanArray(n);
	for (let i = 0; i < n; i++) {
		if (!Number.isFinite(kSeries[i])) continue;
		let sum = 0;
		let cnt = 0;
		for (let j = i - smoothD + 1; j <= i; j++) {
			if (j >= 0 && Number.isFinite(kSeries[j])) {
				sum += kSeries[j];
				cnt++;
			}
		}
		if (cnt === smoothD) dSeries[i] = sum / cnt;
	}

	return { kSeries, dSeries };
}

export function trueRange(highs: number[], lows: number[], closes: number[]): number[] {
	const n = Math.min(highs.length, lows.length, closes.length);
	if (n < 2) return nanArray(n);

	const result: number[] = nanArray(n);
	for (let i = 1; i < n; i++) {
		const h = highs[i];
		const l = lows[i];
		const pc = closes[i - 1];
		if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(pc)) continue;
		result[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
	}
	return result;
}

// TradingView の既定 ATR（RMA）と一致させている（Wilder の元論文準拠）。
export function wilderAtr(highs: number[], lows: number[], closes: number[], period: number = 14): number[] {
	if (!Number.isInteger(period) || period < 1) {
		throw new Error('Wilder ATR period must be a positive integer');
	}
	const tr = trueRange(highs, lows, closes);
	const n = tr.length;
	const result: number[] = nanArray(n);

	if (n < period + 1) return result;

	let prev: number | undefined;
	let seedSum = 0;
	let seedCount = 0;

	for (let i = 1; i < n; i++) {
		const trVal = tr[i];
		if (!Number.isFinite(trVal)) {
			prev = undefined;
			seedSum = 0;
			seedCount = 0;
			continue;
		}
		if (prev === undefined) {
			seedSum += trVal;
			seedCount++;
			if (seedCount === period) {
				prev = seedSum / period;
				result[i] = prev;
			}
		} else {
			const next = (prev * (period - 1) + trVal) / period;
			prev = next;
			result[i] = next;
		}
	}

	return result;
}

export function obv(closes: number[], volumes: number[]): number[] {
	const n = Math.min(closes.length, volumes.length);
	if (n < 1) return [];

	const result: number[] = [0];
	for (let i = 1; i < n; i++) {
		const prev = result[i - 1];
		if (closes[i] > closes[i - 1]) {
			result.push(prev + volumes[i]);
		} else if (closes[i] < closes[i - 1]) {
			result.push(prev - volumes[i]);
		} else {
			result.push(prev);
		}
	}

	return result;
}

export type CrossType = 'golden' | 'dead';

// タイ値（0）は未クロスとしてスキップし探索を続ける（0 を跨いだだけの足はクロスとみなさない）。
export function lastCrossover(
	fast: readonly number[] | null,
	slow: readonly number[] | null,
): { type: CrossType; barsAgo: number } | null {
	if (!fast || !slow) return null;
	const n = Math.min(fast.length, slow.length);
	for (let i = n - 1; i >= 1; i--) {
		const prev = fast[i - 1] - slow[i - 1];
		const curr = fast[i] - slow[i];
		if (!Number.isFinite(prev) || !Number.isFinite(curr)) continue;
		if (prev < 0 && curr > 0) return { type: 'golden', barsAgo: n - 1 - i };
		if (prev > 0 && curr < 0) return { type: 'dead', barsAgo: n - 1 - i };
	}
	return null;
}
