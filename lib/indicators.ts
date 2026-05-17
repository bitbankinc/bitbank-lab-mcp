/** Create a number[] of given length filled with NaN. */
const nanArray = (len: number): number[] => Array.from<number>({ length: len }).fill(NaN);

/**
 * lib/indicators.ts - テクニカル指標の共通計算モジュール
 *
 * 全指標の純粋な計算関数を提供。
 * リアルタイム分析 (tools/analyze_indicators.ts) と
 * バックテストエンジン (tools/trading_process/) の両方から使用される。
 *
 * 【共通仕様】
 * - 入力: number[]（古い順）
 * - 出力: number[]（データ不足の位置は NaN）
 * - 丸め処理なし（呼び出し元で必要に応じて丸める）
 */

/**
 * 単純移動平均 (SMA)
 *
 * 窓内に NaN を含む場合は NaN を返し、窓が完全に有限値で埋まった時点で計算を再開する。
 *
 * @param prices 価格配列（古い順）
 * @param period 期間（正の整数）
 * @returns SMA配列（先頭 period-1 個は NaN）
 */
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

/**
 * 指数移動平均 (EMA)
 *
 * 最初の EMA 値は period 区間の SMA をシードとして使用。
 * 非有限値 (NaN/Infinity) を含む入力にも対応し、検出時は内部状態をリセットして
 * 次に period 個の連続する有限値が揃った時点で再シードする。
 *
 * @param prices 価格配列（古い順）
 * @param period EMA 期間（2 以上）
 * @returns EMA配列（先頭 period-1 個は NaN）
 */
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
			// 非有限入力: 内部状態を全リセットして次の有限窓で再シード
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

/**
 * RSI (Relative Strength Index) — Wilder's Smoothing
 *
 * @param closes 終値配列（古い順）
 * @param period RSI 期間（通常 14）
 * @returns RSI配列（0–100、先頭 period 個は NaN）。
 *   変動なし区間（avgGain=0 かつ avgLoss=0）は中立値 50 を返す（業界標準）。
 */
export function rsi(closes: number[], period: number): number[] {
	const result: number[] = nanArray(closes.length);

	if (closes.length < period + 1) {
		return result;
	}

	// 価格変化
	let avgGain = 0;
	let avgLoss = 0;
	for (let i = 1; i <= period; i++) {
		const change = closes[i] - closes[i - 1];
		if (change > 0) avgGain += change;
		else avgLoss += Math.abs(change);
	}
	avgGain /= period;
	avgLoss /= period;

	// 最初の RSI
	if (avgLoss === 0) {
		result[period] = avgGain === 0 ? 50 : 100;
	} else {
		result[period] = 100 - 100 / (1 + avgGain / avgLoss);
	}

	// Wilder's Smoothing
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

/**
 * NaN → null 変換 + オプショナル丸め。
 * analyze_indicators.ts など NumericSeries を返す呼び出し元で使用。
 *
 * @param values number[]（NaN を含む）
 * @param decimals 小数桁数（省略時は丸めなし）
 * @returns (number | null)[]
 */
export function toNumericSeries(values: number[], decimals?: number): (number | null)[] {
	return values.map((v) => {
		if (!Number.isFinite(v)) return null;
		return decimals != null ? Number(v.toFixed(decimals)) : v;
	});
}

// ============================================================
// Bollinger Bands
// ============================================================

/**
 * ボリンジャーバンド
 *
 * 窓内に NaN を含む場合は upper/middle/lower すべて NaN を返し、
 * 窓が完全に有限値で埋まった時点で計算を再開する。
 *
 * @param values 価格配列（古い順）
 * @param period SMA 期間（デフォルト 20）
 * @param stdDev 標準偏差倍率（デフォルト 2）
 * @returns { upper, middle, lower } — 各 number[]（先頭 period-1 個は NaN）
 */
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

// ============================================================
// MACD
// ============================================================

/**
 * MACD (Moving Average Convergence Divergence)
 *
 * @param values 価格配列（古い順）
 * @param fast 短期 EMA 期間（デフォルト 12）
 * @param slow 長期 EMA 期間（デフォルト 26）
 * @param signal シグナル EMA 期間（デフォルト 9）
 * @returns { line, signal, hist } — 各 number[]（NaN で埋め）
 */
export function macd(
	values: number[],
	fast: number = 12,
	slow: number = 26,
	signal: number = 9,
): { line: number[]; signal: number[]; hist: number[] } {
	const emaFast = ema(values, fast);
	const emaSlow = ema(values, slow);
	const n = values.length;

	// MACD line = fast EMA - slow EMA
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

	// Histogram = line - signal
	const hist: number[] = nanArray(n);
	for (let i = 0; i < n; i++) {
		if (Number.isFinite(line[i]) && Number.isFinite(signalLine[i])) {
			hist[i] = line[i] - signalLine[i];
		}
	}

	return { line, signal: signalLine, hist };
}

// ============================================================
// Ichimoku Kinko Hyo
// ============================================================

/**
 * 一目均衡表の時系列（全ライン）
 *
 * @returns { tenkan, kijun, spanA, spanB, chikou } — 各 number[]（NaN 埋め）
 */
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

/**
 * 遅行スパン（chikou）を 26 本過去方向にシフトした系列を返す。
 *
 * シフト後の系列長は元の系列長と同一。
 * 末尾 `shift` 個は NaN（未来に対応するデータがないため）。
 *
 * @param chikou 終値配列（= ichimokuSeries().chikou）
 * @param shift シフト量（デフォルト 26）
 * @returns シフト適用済みの number[]（末尾 shift 個は NaN）
 */
export function shiftChikou(chikou: number[], shift: number = 26): number[] {
	const n = chikou.length;
	const result: number[] = nanArray(n);
	for (let i = shift; i < n; i++) {
		result[i - shift] = chikou[i];
	}
	return result;
}

/**
 * 一目均衡表の最新スナップショット値
 *
 * @returns 最新の conversion/base/spanA/spanB、データ不足なら null
 */
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

// ============================================================
// Classic Stochastic Oscillator
// ============================================================

/**
 * クラシック・ストキャスティクス
 *
 * %K_raw = (Close - Low_n) / (High_n - Low_n) * 100
 * %K = SMA(%K_raw, smoothK)
 * %D = SMA(%K, smoothD)
 *
 * @returns { kSeries, dSeries } — 各 number[]（NaN 埋め）
 */
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

	// Raw %K
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

	// %K = SMA(rawK, smoothK) — 手動ウィンドウ平均（NaN スキップ）
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

	// %D = SMA(%K, smoothD)
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

// ============================================================
// Stochastic RSI
// ============================================================

/**
 * ストキャスティクス RSI
 *
 * RSI 値にストキャスティクス計算を適用。
 *
 * @returns { kSeries, dSeries } — 各 number[]（NaN 埋め）
 */
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

	// Raw %K over RSI window
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

	// Smooth rawK → %K
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

	// %D = SMA(%K, smoothD)
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

// ============================================================
// True Range / ATR
// ============================================================

/**
 * True Range 系列
 *
 * TR = max(high - low, |high - prevClose|, |low - prevClose|)
 *
 * @param highs 高値配列（古い順）
 * @param lows 安値配列（古い順）
 * @param closes 終値配列（古い順）
 * @returns TR 配列（先頭は NaN — prevClose が存在しない）
 */
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

/**
 * ATR (Average True Range) — TR の SMA
 *
 * 窓内に NaN を含む場合は NaN を返し、窓が完全に有限値で埋まった時点で計算を再開する。
 * TR[0] は常に NaN（前足 close が存在しない）。シード窓は tr[1..period]。
 *
 * @param highs 高値配列（古い順）
 * @param lows 安値配列（古い順）
 * @param closes 終値配列（古い順）
 * @param period 期間（デフォルト 14）
 * @returns ATR 配列（NaN 埋め、先頭 period 個は NaN）
 */
export function atr(highs: number[], lows: number[], closes: number[], period: number = 14): number[] {
	const tr = trueRange(highs, lows, closes);
	const n = tr.length;
	const result: number[] = nanArray(n);

	if (n < period + 1) return result;

	let sum = 0;
	let nanCount = 0;
	for (let i = 1; i <= period; i++) {
		if (Number.isNaN(tr[i])) nanCount++;
		else sum += tr[i];
	}
	result[period] = nanCount === 0 ? sum / period : NaN;

	for (let i = period + 1; i < n; i++) {
		const oldVal = tr[i - period];
		if (Number.isNaN(oldVal)) nanCount--;
		else sum -= oldVal;

		const newVal = tr[i];
		if (Number.isNaN(newVal)) nanCount++;
		else sum += newVal;

		result[i] = nanCount === 0 ? sum / period : NaN;
	}

	return result;
}

// ============================================================
// OBV (On-Balance Volume)
// ============================================================

/**
 * OBV（出来高累積指標）
 *
 * @param closes 終値配列（古い順）
 * @param volumes 出来高配列（古い順）
 * @returns OBV の累積配列（number[]）
 */
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
