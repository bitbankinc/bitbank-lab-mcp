import { describe, expect, it } from 'vitest';
import {
	atr,
	bollingerBands,
	ema,
	ichimokuSeries,
	ichimokuSnapshot,
	macd,
	obv,
	rsi,
	shiftChikou,
	sma,
	stochastic,
	stochRSI,
	toNumericSeries,
	trueRange,
} from '../../lib/indicators.js';

// --- SMA ---

describe('sma', () => {
	it('基本的な SMA を計算する', () => {
		const prices = [100, 102, 104, 103, 105];
		const result = sma(prices, 3);
		expect(result).toHaveLength(5);
		expect(result[0]).toBeNaN();
		expect(result[1]).toBeNaN();
		expect(result[2]).toBeCloseTo(102, 10); // (100+102+104)/3
		expect(result[3]).toBeCloseTo(103, 10); // (102+104+103)/3
		expect(result[4]).toBeCloseTo(104, 10); // (104+103+105)/3
	});

	it('period=1 は入力値そのまま', () => {
		const prices = [10, 20, 30];
		const result = sma(prices, 1);
		expect(result).toEqual([10, 20, 30]);
	});

	it('period > データ長のとき全て NaN', () => {
		const result = sma([1, 2], 5);
		expect(result).toHaveLength(2);
		result.forEach((v) => {
			expect(v).toBeNaN();
		});
	});

	it('空配列は空配列を返す', () => {
		expect(sma([], 3)).toEqual([]);
	});

	it('period <= 0 でエラー', () => {
		expect(() => sma([1, 2, 3], 0)).toThrow();
		expect(() => sma([1, 2, 3], -1)).toThrow();
	});

	it('period = データ長のとき最後の1つだけ有効', () => {
		const result = sma([2, 4, 6], 3);
		expect(result[0]).toBeNaN();
		expect(result[1]).toBeNaN();
		expect(result[2]).toBeCloseTo(4, 10);
	});

	it('NaN 通過後に窓が回復する（中間の NaN）', () => {
		// 窓 [1,2]→1.5、[2,NaN]→NaN、[NaN,4]→NaN、[4,5]→4.5、[5,6]→5.5
		const result = sma([1, 2, NaN, 4, 5, 6], 2);
		expect(result[0]).toBeNaN();
		expect(result[1]).toBeCloseTo(1.5, 10);
		expect(result[2]).toBeNaN();
		expect(result[3]).toBeNaN();
		expect(result[4]).toBeCloseTo(4.5, 10);
		expect(result[5]).toBeCloseTo(5.5, 10);
	});

	it('先頭 NaN からの回復', () => {
		// 窓 [NaN,2]→NaN、[2,3]→2.5、[3,4]→3.5
		const result = sma([NaN, 2, 3, 4], 2);
		expect(result[0]).toBeNaN();
		expect(result[1]).toBeNaN();
		expect(result[2]).toBeCloseTo(2.5, 10);
		expect(result[3]).toBeCloseTo(3.5, 10);
	});

	it('連続 NaN を含むケース', () => {
		// 窓 [1,NaN]→NaN、[NaN,NaN]→NaN、[NaN,4]→NaN、[4,5]→4.5、[5,6]→5.5
		const result = sma([1, NaN, NaN, 4, 5, 6], 2);
		expect(result[0]).toBeNaN();
		expect(result[1]).toBeNaN();
		expect(result[2]).toBeNaN();
		expect(result[3]).toBeNaN();
		expect(result[4]).toBeCloseTo(4.5, 10);
		expect(result[5]).toBeCloseTo(5.5, 10);
	});

	it('末尾 NaN は NaN のまま', () => {
		// 窓 [1,2]→1.5、[2,3]→2.5、[3,NaN]→NaN
		const result = sma([1, 2, 3, NaN], 2);
		expect(result[0]).toBeNaN();
		expect(result[1]).toBeCloseTo(1.5, 10);
		expect(result[2]).toBeCloseTo(2.5, 10);
		expect(result[3]).toBeNaN();
	});
});

// --- EMA ---

describe('ema', () => {
	it('基本的な EMA を計算する', () => {
		const prices = [10, 11, 12, 13, 14, 15];
		const result = ema(prices, 3);
		expect(result).toHaveLength(6);
		expect(result[0]).toBeNaN();
		expect(result[1]).toBeNaN();
		// seed = SMA(10,11,12) = 11
		expect(result[2]).toBeCloseTo(11, 10);
		// EMA = 13 * 0.5 + 11 * 0.5 = 12 (k=2/(3+1)=0.5)
		expect(result[3]).toBeCloseTo(12, 10);
		expect(Number.isFinite(result[4])).toBe(true);
		expect(Number.isFinite(result[5])).toBe(true);
	});

	it('period > データ長のとき全て NaN', () => {
		const result = ema([1, 2], 5);
		expect(result).toHaveLength(2);
		result.forEach((v) => {
			expect(v).toBeNaN();
		});
	});

	it('空配列は空配列を返す', () => {
		expect(ema([], 3)).toEqual([]);
	});

	it('EMA は直近の値に重みを置く（SMA との比較）', () => {
		// 上昇トレンドでは EMA > SMA になるはず
		const prices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
		const smaResult = sma(prices, 5);
		const emaResult = ema(prices, 5);
		// 後半は EMA >= SMA
		for (let i = 6; i < prices.length; i++) {
			expect(emaResult[i]).toBeGreaterThanOrEqual(smaResult[i] - 0.001);
		}
	});

	it('入力途中に NaN: 後続が再シードして復帰する', () => {
		// period=3, k=0.5
		// 先頭 [1,2,3] でシード → result[2]=2
		// index 3 が NaN → 内部状態リセット
		// [5,6,7] で再シード → result[6]=6
		// 以降: result[7]=8*0.5+6*0.5=7, result[8]=9*0.5+7*0.5=8
		const result = ema([1, 2, 3, NaN, 5, 6, 7, 8, 9], 3);
		expect(result).toHaveLength(9);
		expect(result[0]).toBeNaN();
		expect(result[1]).toBeNaN();
		expect(result[2]).toBeCloseTo(2, 10);
		expect(result[3]).toBeNaN();
		expect(result[4]).toBeNaN();
		expect(result[5]).toBeNaN();
		expect(result[6]).toBeCloseTo(6, 10);
		expect(result[7]).toBeCloseTo(7, 10);
		expect(result[8]).toBeCloseTo(8, 10);
	});

	it('入力途中に Infinity: 後続が再シードして復帰する', () => {
		// NaN ケースと同じ動作: Infinity も非有限として等価に扱う
		const result = ema([1, 2, 3, Infinity, 5, 6, 7, 8, 9], 3);
		expect(result).toHaveLength(9);
		expect(result[2]).toBeCloseTo(2, 10);
		expect(result[3]).toBeNaN();
		// 再シード後は finite
		expect(result[6]).toBeCloseTo(6, 10);
		expect(result[7]).toBeCloseTo(7, 10);
		expect(result[8]).toBeCloseTo(8, 10);
		// 出力に Infinity が混入しない
		for (const v of result) {
			expect(Number.isFinite(v) || Number.isNaN(v)).toBe(true);
		}
	});

	it('入力途中に -Infinity: 後続が再シードして復帰する', () => {
		const result = ema([1, 2, 3, -Infinity, 5, 6, 7, 8, 9], 3);
		expect(result[2]).toBeCloseTo(2, 10);
		expect(result[3]).toBeNaN();
		expect(result[6]).toBeCloseTo(6, 10);
		for (const v of result) {
			expect(Number.isFinite(v) || Number.isNaN(v)).toBe(true);
		}
	});

	it('初期窓に NaN: 先頭をスキップして次の有限窓で再シード', () => {
		// [NaN, 1, 2, 3, 4, 5], period=3
		// index 0 (NaN) リセット → [1,2,3] でシード → result[3]=2
		// result[4]=4*0.5+2*0.5=3, result[5]=5*0.5+3*0.5=4
		const result = ema([NaN, 1, 2, 3, 4, 5], 3);
		expect(result).toHaveLength(6);
		expect(result[0]).toBeNaN();
		expect(result[1]).toBeNaN();
		expect(result[2]).toBeNaN();
		expect(result[3]).toBeCloseTo(2, 10);
		expect(result[4]).toBeCloseTo(3, 10);
		expect(result[5]).toBeCloseTo(4, 10);
	});

	it('初期窓に Infinity: 先頭をスキップして次の有限窓で再シード', () => {
		const result = ema([Infinity, 1, 2, 3, 4, 5], 3);
		expect(result[3]).toBeCloseTo(2, 10);
		expect(result[4]).toBeCloseTo(3, 10);
		expect(result[5]).toBeCloseTo(4, 10);
	});

	it('全要素 NaN なら全て NaN', () => {
		const result = ema([NaN, NaN, NaN, NaN, NaN], 3);
		expect(result).toHaveLength(5);
		for (const v of result) {
			expect(v).toBeNaN();
		}
	});

	it('末尾のみ NaN: 末尾は NaN、その前までは通常計算', () => {
		// [1,2,3,4,5,NaN], period=3
		// シード result[2]=2
		// result[3]=4*0.5+2*0.5=3
		// result[4]=5*0.5+3*0.5=4
		// result[5]=NaN (リセット)
		const result = ema([1, 2, 3, 4, 5, NaN], 3);
		expect(result[2]).toBeCloseTo(2, 10);
		expect(result[3]).toBeCloseTo(3, 10);
		expect(result[4]).toBeCloseTo(4, 10);
		expect(result[5]).toBeNaN();
	});

	it('連続 NaN を含むケース', () => {
		// [1,2,3,NaN,NaN,4,5,6,7], period=3
		// [1,2,3] シード → result[2]=2
		// NaN,NaN で連続リセット
		// [4,5,6] 再シード → result[7]=5
		// result[8]=7*0.5+5*0.5=6
		const result = ema([1, 2, 3, NaN, NaN, 4, 5, 6, 7], 3);
		expect(result[2]).toBeCloseTo(2, 10);
		expect(result[3]).toBeNaN();
		expect(result[4]).toBeNaN();
		expect(result[5]).toBeNaN();
		expect(result[6]).toBeNaN();
		expect(result[7]).toBeCloseTo(5, 10);
		expect(result[8]).toBeCloseTo(6, 10);
	});
});

// --- RSI ---

describe('rsi', () => {
	it('基本的な RSI を計算する（period=14）', () => {
		// 15 日分の上昇トレンド → RSI は高い値
		const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
		const result = rsi(closes, 14);
		expect(result).toHaveLength(20);
		// 先頭 14 個は NaN
		for (let i = 0; i < 14; i++) {
			expect(result[i]).toBeNaN();
		}
		// index 14 以降は有効
		expect(result[14]).toBeCloseTo(100, 5); // 全て上昇なので RSI≈100
	});

	it('全て下落なら RSI ≈ 0', () => {
		const closes = Array.from({ length: 20 }, (_, i) => 200 - i);
		const result = rsi(closes, 14);
		expect(result[14]).toBeCloseTo(0, 5);
	});

	it('横ばい（変化なし）なら RSI ≈ 50 付近', () => {
		// 上下交互
		const closes = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
		const result = rsi(closes, 14);
		const lastRsi = result[result.length - 1];
		expect(lastRsi).toBeGreaterThan(30);
		expect(lastRsi).toBeLessThan(70);
	});

	it('データ不足のとき全て NaN', () => {
		const result = rsi([100, 101, 102], 14);
		result.forEach((v) => {
			expect(v).toBeNaN();
		});
	});

	it('avgLoss === 0 のとき RSI = 100', () => {
		// 全上昇: avgLoss は 0
		const closes = Array.from({ length: 16 }, (_, i) => 100 + i);
		const result = rsi(closes, 14);
		expect(result[14]).toBe(100);
	});

	it('avgGain === 0 かつ avgLoss === 0（完全フラット）のとき RSI = 50', () => {
		// 全て同一価格: avgGain=0, avgLoss=0 → 0/0 未定義のため中立値 50 を返す（業界標準）
		const closes = Array.from({ length: 20 }, () => 100);
		const result = rsi(closes, 14);
		expect(result[14]).toBe(50);
		// Wilder smoothing 後も同様（変化がないため avgGain=0 && avgLoss=0 のまま）
		for (let i = 14; i < result.length; i++) {
			expect(result[i]).toBe(50);
		}
	});

	it('初期窓フラット → その後の上昇で RSI が 50 から離脱する', () => {
		// 先頭 15 個フラット（初期窓は avgGain=0 && avgLoss=0 で 50）、その後上昇
		const closes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 110, 120];
		const result = rsi(closes, 14);
		// 初期窓は完全フラット → 中立値 50
		expect(result[14]).toBe(50);
		// 上昇開始後は 50 から離脱（avgLoss=0 のまま avgGain>0 なので RSI=100 となる）
		expect(result[15]).toBeGreaterThan(50);
		expect(result[16]).toBeGreaterThan(50);
	});

	it('初期窓フラット → その後の下落で RSI が 50 から下方向に離脱する', () => {
		// 先頭 15 個フラット（初期窓は avgGain=0 && avgLoss=0 で 50）、その後下落
		const closes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 90, 80];
		const result = rsi(closes, 14);
		// 初期窓は完全フラット → 中立値 50
		expect(result[14]).toBe(50);
		// 下落開始後は 50 から下方向に離脱（avgGain=0 のまま avgLoss>0 なので RSI=0）
		expect(result[15]).toBeLessThan(50);
		expect(result[16]).toBeLessThan(50);
	});

	it('Wilder smoothing が正しく適用される', () => {
		// 具体的な値で検算
		const closes = [
			44, 44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0,
			46.03, 46.41, 46.22, 45.64,
		];
		const result = rsi(closes, 14);
		// RSI should be valid from index 14
		expect(Number.isFinite(result[14])).toBe(true);
		// Subsequent values should also be valid
		for (let i = 14; i < result.length; i++) {
			expect(Number.isFinite(result[i])).toBe(true);
			expect(result[i]).toBeGreaterThanOrEqual(0);
			expect(result[i]).toBeLessThanOrEqual(100);
		}
	});
});

// --- toNumericSeries ---

describe('toNumericSeries', () => {
	it('NaN を null に変換する', () => {
		expect(toNumericSeries([1, NaN, 3])).toEqual([1, null, 3]);
	});

	it('decimals 指定で丸める', () => {
		expect(toNumericSeries([1.23456, NaN, Math.PI], 2)).toEqual([1.23, null, 3.14]);
	});

	it('Infinity を null に変換する', () => {
		expect(toNumericSeries([Infinity, -Infinity, 5])).toEqual([null, null, 5]);
	});

	it('空配列は空配列を返す', () => {
		expect(toNumericSeries([])).toEqual([]);
	});
});

// --- Bollinger Bands ---

describe('bollingerBands', () => {
	it('基本的な BB を計算する', () => {
		// period=3 の簡易テスト
		const values = [10, 12, 11, 13, 12, 14];
		const { upper, middle, lower } = bollingerBands(values, 3, 2);
		expect(upper).toHaveLength(6);
		expect(middle[0]).toBeNaN();
		expect(middle[1]).toBeNaN();
		// middle[2] = (10+12+11)/3 = 11
		expect(middle[2]).toBeCloseTo(11, 10);
		// upper > middle > lower
		for (let i = 2; i < values.length; i++) {
			expect(upper[i]).toBeGreaterThan(middle[i]);
			expect(lower[i]).toBeLessThan(middle[i]);
		}
	});

	it('period > データ長のとき全て NaN', () => {
		const { upper, middle, lower } = bollingerBands([1, 2], 5);
		upper.forEach((v) => {
			expect(v).toBeNaN();
		});
		middle.forEach((v) => {
			expect(v).toBeNaN();
		});
		lower.forEach((v) => {
			expect(v).toBeNaN();
		});
	});

	it('全て同一値なら upper = middle = lower', () => {
		const values = [100, 100, 100, 100, 100];
		const { upper, middle, lower } = bollingerBands(values, 3, 2);
		for (let i = 2; i < values.length; i++) {
			expect(upper[i]).toBeCloseTo(100, 10);
			expect(middle[i]).toBeCloseTo(100, 10);
			expect(lower[i]).toBeCloseTo(100, 10);
		}
	});

	it('stdDev=0 なら upper = middle = lower', () => {
		const values = [10, 12, 11, 13, 12];
		const { upper, middle, lower } = bollingerBands(values, 3, 0);
		for (let i = 2; i < values.length; i++) {
			expect(upper[i]).toBeCloseTo(middle[i], 10);
			expect(lower[i]).toBeCloseTo(middle[i], 10);
		}
	});

	it('NaN 窓内では upper/middle/lower すべて NaN、外れたら回復する', () => {
		// values = [1, 2, NaN, 4, 5, 6, 7], period=3, stdDev=2
		// 窓 [1,2,NaN]→NaN、[2,NaN,4]→NaN、[NaN,4,5]→NaN
		// 窓 [4,5,6]→ mean=5, sumSq=2, std=sqrt(2/3)
		// 窓 [5,6,7]→ mean=6, sumSq=2, std=sqrt(2/3)
		const { upper, middle, lower } = bollingerBands([1, 2, NaN, 4, 5, 6, 7], 3, 2);
		// 先頭2つは period 不足
		expect(middle[0]).toBeNaN();
		expect(middle[1]).toBeNaN();
		// NaN を含む窓
		for (const i of [2, 3, 4]) {
			expect(upper[i]).toBeNaN();
			expect(middle[i]).toBeNaN();
			expect(lower[i]).toBeNaN();
		}
		// 回復後
		const std = Math.sqrt(2 / 3);
		expect(middle[5]).toBeCloseTo(5, 10);
		expect(upper[5]).toBeCloseTo(5 + 2 * std, 10);
		expect(lower[5]).toBeCloseTo(5 - 2 * std, 10);
		expect(middle[6]).toBeCloseTo(6, 10);
		expect(upper[6]).toBeCloseTo(6 + 2 * std, 10);
		expect(lower[6]).toBeCloseTo(6 - 2 * std, 10);
	});
});

// --- MACD ---

describe('macd', () => {
	it('基本的な MACD を計算する', () => {
		// 50 要素の上昇トレンド
		const values = Array.from({ length: 50 }, (_, i) => 100 + i * 0.5);
		const result = macd(values, 12, 26, 9);
		expect(result.line).toHaveLength(50);
		expect(result.signal).toHaveLength(50);
		expect(result.hist).toHaveLength(50);
		// 先頭は NaN（slow EMA が有効になるまで）
		for (let i = 0; i < 25; i++) {
			expect(result.line[i]).toBeNaN();
		}
		// 有効な値が存在する
		const validLines = result.line.filter((v) => !Number.isNaN(v));
		expect(validLines.length).toBeGreaterThan(0);
	});

	it('データ不足のとき全て NaN', () => {
		const result = macd([1, 2, 3], 12, 26, 9);
		result.line.forEach((v) => {
			expect(v).toBeNaN();
		});
		result.signal.forEach((v) => {
			expect(v).toBeNaN();
		});
		result.hist.forEach((v) => {
			expect(v).toBeNaN();
		});
	});

	it('上昇トレンドで MACD line > 0', () => {
		const values = Array.from({ length: 60 }, (_, i) => 100 + i * 2);
		const result = macd(values, 12, 26, 9);
		// 後半の有効な line は > 0（短期 > 長期）
		const lastLine = result.line.at(-1);
		expect(lastLine).not.toBeNaN();
		expect(lastLine).toBeGreaterThan(0);
	});

	it('入力に Infinity を含めても line/signal/hist に Infinity が混入しない', () => {
		const values: number[] = [];
		for (let i = 0; i < 80; i++) values.push(100 + i * 0.5);
		// 途中に Infinity を 1 件注入
		values[40] = Infinity;
		const result = macd(values, 12, 26, 9);
		for (const arr of [result.line, result.signal, result.hist]) {
			for (const v of arr) {
				expect(Number.isFinite(v) || Number.isNaN(v)).toBe(true);
			}
		}
		// 終盤は再シードが効いて有限値が得られる
		expect(Number.isFinite(result.line.at(-1))).toBe(true);
		expect(Number.isFinite(result.signal.at(-1))).toBe(true);
		expect(Number.isFinite(result.hist.at(-1))).toBe(true);
	});

	it('入力に NaN を含めても出力に Infinity が混入しない', () => {
		const values: number[] = [];
		for (let i = 0; i < 80; i++) values.push(100 + i * 0.5);
		values[20] = NaN;
		const result = macd(values, 12, 26, 9);
		for (const arr of [result.line, result.signal, result.hist]) {
			for (const v of arr) {
				expect(Number.isFinite(v) || Number.isNaN(v)).toBe(true);
			}
		}
	});

	it('全要素 NaN なら全て NaN', () => {
		const values = Array.from({ length: 60 }, () => NaN);
		const result = macd(values, 12, 26, 9);
		for (const v of result.line) expect(v).toBeNaN();
		for (const v of result.signal) expect(v).toBeNaN();
		for (const v of result.hist) expect(v).toBeNaN();
	});
});

// --- Ichimoku ---

describe('ichimokuSeries', () => {
	// 60 要素のテストデータ
	const n = 60;
	const highs = Array.from({ length: n }, (_, i) => 110 + i);
	const lows = Array.from({ length: n }, (_, i) => 90 + i);
	const closes = Array.from({ length: n }, (_, i) => 100 + i);

	it('tenkan は index 8 から有効', () => {
		const result = ichimokuSeries(highs, lows, closes);
		for (let i = 0; i < 8; i++) expect(result.tenkan[i]).toBeNaN();
		expect(result.tenkan[8]).not.toBeNaN();
	});

	it('kijun は index 25 から有効', () => {
		const result = ichimokuSeries(highs, lows, closes);
		for (let i = 0; i < 25; i++) expect(result.kijun[i]).toBeNaN();
		expect(result.kijun[25]).not.toBeNaN();
	});

	it('spanB は index 51 から有効', () => {
		const result = ichimokuSeries(highs, lows, closes);
		for (let i = 0; i < 51; i++) expect(result.spanB[i]).toBeNaN();
		expect(result.spanB[51]).not.toBeNaN();
	});

	it('chikou は closes のコピー', () => {
		const result = ichimokuSeries(highs, lows, closes);
		expect(result.chikou).toEqual(closes);
	});
});

describe('ichimokuSnapshot', () => {
	it('52 本以上あれば値を返す', () => {
		const highs = Array.from({ length: 52 }, (_, i) => 110 + i);
		const lows = Array.from({ length: 52 }, (_, i) => 90 + i);
		const closes = Array.from({ length: 52 }, (_, i) => 100 + i);
		const result = ichimokuSnapshot(highs, lows, closes);
		expect(result).not.toBeNull();
		expect(result?.conversion).toBeDefined();
		expect(result?.base).toBeDefined();
		expect(result?.spanA).toBeDefined();
		expect(result?.spanB).toBeDefined();
	});

	it('52 本未満なら null', () => {
		expect(ichimokuSnapshot([1], [1], [1])).toBeNull();
		expect(
			ichimokuSnapshot(
				Array.from({ length: 51 }, () => 100),
				Array.from({ length: 51 }, () => 90),
				Array.from({ length: 51 }, () => 95),
			),
		).toBeNull();
	});
});

// --- Stochastic ---

describe('stochastic', () => {
	it('基本的なストキャスティクスを計算する', () => {
		// 30 要素のテストデータ
		const n = 30;
		const highs = Array.from({ length: n }, (_, i) => 110 + Math.sin(i) * 5);
		const lows = Array.from({ length: n }, (_, i) => 90 + Math.sin(i) * 5);
		const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i) * 5);
		const result = stochastic(highs, lows, closes, 14, 3, 3);
		expect(result.kSeries).toHaveLength(n);
		expect(result.dSeries).toHaveLength(n);
		// 有効な値は 0-100 の範囲
		result.kSeries
			.filter((v) => !Number.isNaN(v))
			.forEach((v) => {
				expect(v).toBeGreaterThanOrEqual(0);
				expect(v).toBeLessThanOrEqual(100);
			});
	});

	it('データ不足のとき全て NaN', () => {
		const result = stochastic([1, 2], [1, 2], [1, 2], 14, 3, 3);
		result.kSeries.forEach((v) => {
			expect(v).toBeNaN();
		});
		result.dSeries.forEach((v) => {
			expect(v).toBeNaN();
		});
	});

	it('highs に Infinity が含まれても kSeries/dSeries に Infinity が混入しない', () => {
		const n = 30;
		const highs = Array.from({ length: n }, (_, i) => 110 + Math.sin(i) * 5);
		const lows = Array.from({ length: n }, (_, i) => 90 + Math.sin(i) * 5);
		const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i) * 5);
		highs[10] = Infinity;
		const result = stochastic(highs, lows, closes, 14, 3, 3);
		for (const v of result.kSeries) {
			expect(Number.isFinite(v) || Number.isNaN(v)).toBe(true);
		}
		for (const v of result.dSeries) {
			expect(Number.isFinite(v) || Number.isNaN(v)).toBe(true);
		}
	});

	it('lows に -Infinity が含まれても kSeries/dSeries に Infinity が混入しない', () => {
		const n = 30;
		const highs = Array.from({ length: n }, (_, i) => 110 + Math.sin(i) * 5);
		const lows = Array.from({ length: n }, (_, i) => 90 + Math.sin(i) * 5);
		const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i) * 5);
		lows[15] = -Infinity;
		const result = stochastic(highs, lows, closes, 14, 3, 3);
		for (const v of result.kSeries) {
			expect(Number.isFinite(v) || Number.isNaN(v)).toBe(true);
		}
		for (const v of result.dSeries) {
			expect(Number.isFinite(v) || Number.isNaN(v)).toBe(true);
		}
	});

	it('closes に Infinity が含まれてもその位置の rawK は NaN になり、出力に Infinity が混入しない', () => {
		const n = 30;
		const highs = Array.from({ length: n }, (_, i) => 110 + Math.sin(i) * 5);
		const lows = Array.from({ length: n }, (_, i) => 90 + Math.sin(i) * 5);
		const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i) * 5);
		closes[20] = Infinity;
		const result = stochastic(highs, lows, closes, 14, 3, 3);
		for (const v of result.kSeries) {
			expect(Number.isFinite(v) || Number.isNaN(v)).toBe(true);
		}
		for (const v of result.dSeries) {
			expect(Number.isFinite(v) || Number.isNaN(v)).toBe(true);
		}
	});

	it('全要素 NaN なら kSeries/dSeries 全て NaN', () => {
		const n = 30;
		const arr = Array.from({ length: n }, () => NaN);
		const result = stochastic(arr, arr, arr, 14, 3, 3);
		for (const v of result.kSeries) expect(v).toBeNaN();
		for (const v of result.dSeries) expect(v).toBeNaN();
	});

	it('空配列は空配列を返す', () => {
		const result = stochastic([], [], [], 14, 3, 3);
		expect(result.kSeries).toEqual([]);
		expect(result.dSeries).toEqual([]);
	});

	it('窓内に NaN が 1 本でもあれば rawK は NaN になる（14 本窓の末尾 NaN）', () => {
		const n = 30;
		const highs = Array.from({ length: n }, (_, i) => 110 + Math.sin(i) * 5);
		const lows = Array.from({ length: n }, (_, i) => 90 + Math.sin(i) * 5);
		const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i) * 5);
		// index 20 の high を NaN にする → 窓 [7..20] (i=20) の rawK は NaN
		highs[20] = NaN;
		const result = stochastic(highs, lows, closes, 14, 3, 3);
		// kSeries は rawK の SMA(3) なので、index 20 が NaN なら少なくとも 20,21,22 は NaN
		expect(result.kSeries[20]).toBeNaN();
		expect(result.kSeries[21]).toBeNaN();
		expect(result.kSeries[22]).toBeNaN();
	});

	it('窓中央に Infinity が混入したら対応 index の rawK が NaN になる', () => {
		const n = 30;
		const highs = Array.from({ length: n }, (_, i) => 110 + Math.sin(i) * 5);
		const lows = Array.from({ length: n }, (_, i) => 90 + Math.sin(i) * 5);
		const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i) * 5);
		// index 17 の low を Infinity にする → 窓 [4..17]..[17..30] に含む間 rawK は NaN
		lows[17] = Infinity;
		const result = stochastic(highs, lows, closes, 14, 3, 3);
		// index 17 を含む窓 (i = 17..30) のうち、データ範囲内の rawK が NaN
		// → kSeries は SMA(3) なので index 17,18,19 で必ず NaN
		expect(result.kSeries[17]).toBeNaN();
		expect(result.kSeries[18]).toBeNaN();
		expect(result.kSeries[19]).toBeNaN();
	});

	it('欠損が窓から外れた以降の index では正常な値が復帰する', () => {
		const n = 40;
		const highs = Array.from({ length: n }, (_, i) => 110 + Math.sin(i) * 5);
		const lows = Array.from({ length: n }, (_, i) => 90 + Math.sin(i) * 5);
		const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i) * 5);
		highs[10] = NaN;
		const result = stochastic(highs, lows, closes, 14, 3, 3);
		// index 10 を含む窓は i = 10..23 (kPeriod=14)
		// その後 i >= 24 では窓に NaN が含まれないので rawK は有限
		// kSeries は rawK の SMA(3) → i >= 26 で smoothK 分の rawK が有限になり kSeries も有限
		// dSeries は kSeries の SMA(3) → i >= 28 で有限
		for (let i = 28; i < n; i++) {
			expect(Number.isFinite(result.kSeries[i])).toBe(true);
			expect(Number.isFinite(result.dSeries[i])).toBe(true);
		}
	});

	it('欠損なしの通常ケースの値は変化しない（リグレッション）', () => {
		// 単調増加で hi - lo = 15 で固定、close - lo = 14 で固定 → rawK = 14/15*100
		const n = 20;
		const highs = Array.from({ length: n }, (_, i) => 11 + i);
		const lows = Array.from({ length: n }, (_, i) => 9 + i);
		const closes = Array.from({ length: n }, (_, i) => 10 + i);
		const result = stochastic(highs, lows, closes, 14, 3, 3);
		const expected = (14 / 15) * 100;
		// rawK は i >= 13 で一定 → kSeries は i >= 15、dSeries は i >= 17 で一定
		for (let i = 15; i < n; i++) {
			expect(result.kSeries[i]).toBeCloseTo(expected, 10);
		}
		for (let i = 17; i < n; i++) {
			expect(result.dSeries[i]).toBeCloseTo(expected, 10);
		}
	});
});

// --- Stochastic RSI ---

describe('stochRSI', () => {
	it('十分なデータで K/D を計算する', () => {
		const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i * 0.3) * 10);
		const result = stochRSI(closes, 14, 14, 3, 3);
		expect(result.kSeries).toHaveLength(60);
		expect(result.dSeries).toHaveLength(60);
		const validK = result.kSeries.filter((v) => !Number.isNaN(v));
		expect(validK.length).toBeGreaterThan(0);
		validK.forEach((v) => {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(100);
		});
	});

	it('データ不足のとき全て NaN', () => {
		const result = stochRSI([100, 101, 102], 14, 14, 3, 3);
		result.kSeries.forEach((v) => {
			expect(v).toBeNaN();
		});
	});

	it('closes に Infinity が含まれても kSeries/dSeries に Infinity が混入しない', () => {
		// rsi() に Infinity が流入すると非有限値が出る可能性があるが、
		// stochRSI 側で validCount / window が Number.isFinite で除外する
		const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i * 0.3) * 10);
		closes[30] = Infinity;
		const result = stochRSI(closes, 14, 14, 3, 3);
		for (const v of result.kSeries) {
			expect(Number.isFinite(v) || Number.isNaN(v)).toBe(true);
		}
		for (const v of result.dSeries) {
			expect(Number.isFinite(v) || Number.isNaN(v)).toBe(true);
		}
	});

	it('closes に NaN が含まれても kSeries/dSeries に Infinity が混入しない', () => {
		const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i * 0.3) * 10);
		closes[30] = NaN;
		const result = stochRSI(closes, 14, 14, 3, 3);
		for (const v of result.kSeries) {
			expect(Number.isFinite(v) || Number.isNaN(v)).toBe(true);
		}
		for (const v of result.dSeries) {
			expect(Number.isFinite(v) || Number.isNaN(v)).toBe(true);
		}
	});

	it('全要素 NaN なら kSeries/dSeries 全て NaN', () => {
		const closes = Array.from({ length: 60 }, () => NaN);
		const result = stochRSI(closes, 14, 14, 3, 3);
		for (const v of result.kSeries) expect(v).toBeNaN();
		for (const v of result.dSeries) expect(v).toBeNaN();
	});

	it('空配列は空配列を返す', () => {
		const result = stochRSI([], 14, 14, 3, 3);
		expect(result.kSeries).toEqual([]);
		expect(result.dSeries).toEqual([]);
	});
});

// --- OBV ---

describe('obv', () => {
	it('基本的な OBV を計算する', () => {
		const closes = [100, 102, 101, 103, 102];
		const volumes = [1000, 1200, 800, 1500, 900];
		const result = obv(closes, volumes);
		expect(result).toHaveLength(5);
		expect(result[0]).toBe(0);
		// 102 > 100 → +1200
		expect(result[1]).toBe(1200);
		// 101 < 102 → -800
		expect(result[2]).toBe(400);
		// 103 > 101 → +1500
		expect(result[3]).toBe(1900);
		// 102 < 103 → -900
		expect(result[4]).toBe(1000);
	});

	it('価格変化なしなら OBV 不変', () => {
		const closes = [100, 100, 100];
		const volumes = [1000, 2000, 3000];
		const result = obv(closes, volumes);
		expect(result).toEqual([0, 0, 0]);
	});

	it('空配列は空配列を返す', () => {
		expect(obv([], [])).toEqual([]);
	});

	it('単一要素は [0]', () => {
		expect(obv([100], [1000])).toEqual([0]);
	});
});

// --- True Range ---

describe('trueRange', () => {
	it('基本的な TR を計算する', () => {
		const highs = [110, 115, 112, 118];
		const lows = [100, 105, 108, 110];
		const closes = [105, 110, 109, 115];
		const result = trueRange(highs, lows, closes);
		expect(result).toHaveLength(4);
		expect(result[0]).toBeNaN(); // prevClose がない
		// i=1: max(115-105, |115-105|, |105-105|) = 10
		expect(result[1]).toBeCloseTo(10, 10);
		// i=2: max(112-108, |112-110|, |108-110|) = max(4, 2, 2) = 4
		expect(result[2]).toBeCloseTo(4, 10);
		// i=3: max(118-110, |118-109|, |110-109|) = max(8, 9, 1) = 9
		expect(result[3]).toBeCloseTo(9, 10);
	});

	it('データが1本以下のとき全て NaN', () => {
		expect(trueRange([100], [90], [95])).toEqual([NaN]);
		expect(trueRange([], [], [])).toEqual([]);
	});
});

// --- ATR ---

describe('atr', () => {
	it('基本的な ATR を計算する（period=3）', () => {
		// 5 本のキャンドル → TR は index 1-4 の 4 値
		// ATR(3) = first valid at index 3 (SMA of TR[1..3])
		const highs = [110, 115, 112, 118, 120];
		const lows = [100, 105, 108, 110, 112];
		const closes = [105, 110, 109, 115, 118];
		const result = atr(highs, lows, closes, 3);
		expect(result).toHaveLength(5);
		expect(result[0]).toBeNaN();
		expect(result[1]).toBeNaN();
		expect(result[2]).toBeNaN();
		// TR[1]=10, TR[2]=4, TR[3]=9 → ATR[3] = (10+4+9)/3 ≈ 7.667
		expect(result[3]).toBeCloseTo(23 / 3, 10);
		// TR[4] = max(120-112, |120-115|, |112-115|) = max(8, 5, 3) = 8
		// ATR[4] = SMA(TR[2..4]) = (4+9+8)/3 = 7
		expect(result[4]).toBeCloseTo(7, 10);
	});

	it('データ不足のとき全て NaN', () => {
		const result = atr([110, 115], [100, 105], [105, 110], 14);
		expect(result.every((v) => Number.isNaN(v))).toBe(true);
	});

	it('TR 窓内に NaN があるバーは ATR=NaN、窓から抜けると回復する', () => {
		// 構成: closes は全て 100、lows も全て 100、
		// highs = [100, 101, 101, NaN, 101, 101] とすると
		// TR[0]=NaN(prevClose 無し), TR[1]=1, TR[2]=1, TR[3]=NaN(high=NaN),
		// TR[4]=max(1,1,0)=1, TR[5]=1
		const highs = [100, 101, 101, NaN, 101, 101];
		const lows = [100, 100, 100, 100, 100, 100];
		const closes = [100, 100, 100, 100, 100, 100];
		const result = atr(highs, lows, closes, 2);
		// シード窓 tr[1..2]=[1,1] は有限 → result[2]=1
		expect(result[0]).toBeNaN();
		expect(result[1]).toBeNaN();
		expect(result[2]).toBeCloseTo(1, 10);
		// 窓 tr[2..3]=[1,NaN] → NaN
		expect(result[3]).toBeNaN();
		// 窓 tr[3..4]=[NaN,1] → NaN
		expect(result[4]).toBeNaN();
		// 窓 tr[4..5]=[1,1] → 1（NaN が抜けて回復）
		expect(result[5]).toBeCloseTo(1, 10);
	});

	it('シード窓に NaN を含んでも後続が回復する（Infinity → NaN）', () => {
		// highs[2]=Infinity → trueRange で TR[2]=NaN。
		// period=3, シード窓 tr[1..3] に NaN が混在 → result[3]=NaN。
		// データを延ばすことで NaN が窓から完全に外れて以降は回復する。
		const highs = [110, 115, Infinity, 118, 120, 121, 122];
		const lows = [100, 105, 108, 110, 112, 113, 114];
		const closes = [105, 110, 109, 115, 118, 120, 121];
		// TR[1]=max(115-105,|115-105|,|105-105|)=10
		// TR[2]=NaN (high=Infinity)
		// TR[3]=max(118-110,|118-109|,|110-109|)=max(8,9,1)=9
		// TR[4]=max(120-112,|120-115|,|112-115|)=max(8,5,3)=8
		// TR[5]=max(121-113,|121-118|,|113-118|)=max(8,3,5)=8
		// TR[6]=max(122-114,|122-120|,|114-120|)=max(8,2,6)=8
		const result = atr(highs, lows, closes, 3);
		// シード窓 [10, NaN, 9] → result[3]=NaN
		expect(result[3]).toBeNaN();
		// 窓 [NaN, 9, 8] → NaN
		expect(result[4]).toBeNaN();
		// 窓 [9, 8, 8]=25/3 → 8.333… （NaN が抜けて回復）
		expect(result[5]).toBeCloseTo(25 / 3, 10);
		// 窓 [8, 8, 8]=8
		expect(result[6]).toBeCloseTo(8, 10);
	});
});

// --- shiftChikou ---

describe('shiftChikou', () => {
	it('シフト後の系列長 === 元の系列長', () => {
		const chikou = Array.from({ length: 60 }, (_, i) => 100 + i);
		const result = shiftChikou(chikou, 26);
		expect(result).toHaveLength(60);
	});

	it('シフト後の末尾 26 要素が NaN', () => {
		const chikou = Array.from({ length: 60 }, (_, i) => 100 + i);
		const result = shiftChikou(chikou, 26);
		for (let i = 60 - 26; i < 60; i++) {
			expect(result[i]).toBeNaN();
		}
	});

	it('シフト後の先頭要素は元の index=shift の値', () => {
		const chikou = Array.from({ length: 60 }, (_, i) => 100 + i);
		const result = shiftChikou(chikou, 26);
		// result[0] = chikou[26] = 126
		expect(result[0]).toBe(126);
		// result[1] = chikou[27] = 127
		expect(result[1]).toBe(127);
	});

	it('デフォルト shift=26', () => {
		const chikou = Array.from({ length: 30 }, (_, i) => i);
		const result = shiftChikou(chikou);
		expect(result[0]).toBe(26);
		expect(result[3]).toBe(29);
		for (let i = 4; i < 30; i++) {
			expect(result[i]).toBeNaN();
		}
	});

	it('空配列は空配列を返す', () => {
		expect(shiftChikou([])).toEqual([]);
	});

	it('shift > データ長のとき全て NaN', () => {
		const result = shiftChikou([1, 2, 3], 26);
		result.forEach((v) => {
			expect(v).toBeNaN();
		});
	});
});
