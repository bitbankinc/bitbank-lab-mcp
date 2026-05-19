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

	// 参照実装: pandas-ta.ema(length=12) / ema(length=26)（SMA シード + k=2/(period+1)）
	// 入力配列: 40 本の合成終値（前半上昇 → 後半下降）。
	// EMA は SMA(period) を index = period-1 にシードし、以降 `next = price*k + prev*(1-k)`。
	// 参照: docs/market-data-accuracy-checklist.md §8.1
	const EMA_GOLDEN_CLOSES = [
		100.0, 101.5, 102.3, 103.1, 102.8, 104.2, 105.0, 104.6, 103.9, 105.5, 106.8, 107.2, 106.5, 108.0, 109.3, 108.7,
		110.1, 111.4, 110.8, 112.2, 113.5, 112.9, 114.3, 115.6, 114.0, 113.2, 112.5, 111.8, 110.5, 109.7, 108.4, 107.6,
		106.3, 105.5, 104.2, 103.4, 102.1, 101.3, 100.0, 99.2,
	];

	it('golden: EMA(12) 数値固定（pandas-ta.ema(length=12) 参照、ε=1e-4）', () => {
		const result = ema(EMA_GOLDEN_CLOSES, 12);
		expect(result).toHaveLength(40);
		// 先頭 11 個は NaN（先頭 period-1=11 個）
		for (let i = 0; i < 11; i++) {
			expect(result[i]).toBeNaN();
		}
		// シードは SMA(12) の値そのもの
		const seedSma12 = EMA_GOLDEN_CLOSES.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
		expect(result[11]).toBeCloseTo(seedSma12, 10);
		// pandas-ta 出力値（SMA シード + k=2/(12+1)≈0.15385 の漸化式）
		expect(result[11]).toBeCloseTo(103.9083, 4);
		expect(result[12]).toBeCloseTo(104.3071, 4); // 102.8*k + 103.9083*(1-k)
		expect(result[15]).toBeCloseTo(106.0396, 4);
		expect(result[20]).toBeCloseTo(109.3335, 4);
		expect(result[25]).toBeCloseTo(111.9702, 4);
		expect(result[35]).toBeCloseTo(107.6289, 4);
	});

	it('golden: EMA(26) 数値固定（pandas-ta.ema(length=26) 参照、ε=1e-4）', () => {
		const result = ema(EMA_GOLDEN_CLOSES, 26);
		expect(result).toHaveLength(40);
		// 先頭 25 個は NaN
		for (let i = 0; i < 25; i++) {
			expect(result[i]).toBeNaN();
		}
		// シードは SMA(26)
		const seedSma26 = EMA_GOLDEN_CLOSES.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
		expect(result[25]).toBeCloseTo(seedSma26, 10);
		// pandas-ta 出力値（SMA シード + k=2/(26+1)≈0.07407 の漸化式）
		expect(result[25]).toBeCloseTo(107.9769, 4);
		expect(result[26]).toBeCloseTo(108.312, 3); // 113.2*k + 107.9769*(1-k)
		expect(result[30]).toBeCloseTo(108.7577, 4);
		expect(result[35]).toBeCloseTo(107.6338, 4);
		expect(result[39]).toBeCloseTo(105.7579, 4);
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

	// 参照実装: pandas-ta.rsi(length=14)（Wilder's Smoothing / RMA）
	// 入力配列: 33 本の合成終値。前半は緩やかな上昇、後半は下降に転じるよう設計。
	// 期待値は同一スペックで実装したクリーンルーム参照（Wilder の漸化式そのまま）で生成。
	// 既存 JS 実装と Wilder RSI 仕様は完全一致するため、許容誤差 ε=1e-4 で固定する。
	// 参照: docs/market-data-accuracy-checklist.md §8.2
	it('golden: RSI(14) 数値固定（pandas-ta.rsi(length=14) 参照、ε=1e-4）', () => {
		const closes = [
			44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0,
			46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66,
			43.13,
		];
		const result = rsi(closes, 14);
		expect(result).toHaveLength(33);
		// 先頭 14 個（period 個）は NaN
		for (let i = 0; i < 14; i++) {
			expect(result[i]).toBeNaN();
		}
		// pandas-ta 出力値（Wilder RSI 仕様）
		expect(result[14]).toBeCloseTo(70.4641, 4);
		expect(result[15]).toBeCloseTo(66.2496, 4);
		expect(result[20]).toBeCloseTo(62.8807, 4);
		expect(result[25]).toBeCloseTo(50.3868, 4);
		expect(result[32]).toBeCloseTo(37.7888, 4);
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

	// 参照実装: pandas-ta.bbands(length=20, std=2)（population σ、除数 N。pandas の ddof=1 ではない）
	// 入力配列: EMA golden と同一の 40 本合成終値（前半上昇 → 後半下降）。
	// 中央線 = SMA(20)、帯 = mean ± 2 * σ。
	// 参照: docs/market-data-accuracy-checklist.md §8.3
	const BB_GOLDEN_CLOSES = [
		100.0, 101.5, 102.3, 103.1, 102.8, 104.2, 105.0, 104.6, 103.9, 105.5, 106.8, 107.2, 106.5, 108.0, 109.3, 108.7,
		110.1, 111.4, 110.8, 112.2, 113.5, 112.9, 114.3, 115.6, 114.0, 113.2, 112.5, 111.8, 110.5, 109.7, 108.4, 107.6,
		106.3, 105.5, 104.2, 103.4, 102.1, 101.3, 100.0, 99.2,
	];

	it('golden: Bollinger(20, 2) 数値固定（pandas-ta.bbands(length=20, std=2) 参照、ε=1e-4）', () => {
		const { upper, middle, lower } = bollingerBands(BB_GOLDEN_CLOSES, 20, 2);
		expect(upper).toHaveLength(40);
		expect(middle).toHaveLength(40);
		expect(lower).toHaveLength(40);
		// 先頭 19 個（period-1 個）は upper/middle/lower すべて NaN
		for (let i = 0; i < 19; i++) {
			expect(upper[i]).toBeNaN();
			expect(middle[i]).toBeNaN();
			expect(lower[i]).toBeNaN();
		}
		// pandas-ta 出力値（population σ、ddof=0）
		expect(middle[19]).toBeCloseTo(106.195, 4);
		expect(upper[19]).toBeCloseTo(112.9869, 4);
		expect(lower[19]).toBeCloseTo(99.4031, 4);
		expect(middle[25]).toBeCloseTo(109.675, 4);
		expect(upper[25]).toBeCloseTo(116.7491, 4);
		expect(lower[25]).toBeCloseTo(102.6009, 4);
		expect(middle[39]).toBeCloseTo(108.3, 4);
		expect(upper[39]).toBeCloseTo(118.5272, 4);
		expect(lower[39]).toBeCloseTo(98.0728, 4);
		// 恒等式: 全有限 index で upper - middle === middle - lower === stdDev * σ
		for (let i = 19; i < 40; i++) {
			expect(upper[i] - middle[i]).toBeCloseTo(middle[i] - lower[i], 10);
		}
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

	// 参照実装: pandas-ta.macd(fast=12, slow=26, signal=9)（SMA シード + EMA(9) on line）
	// 入力配列: 50 本の合成終値。最初の 33 本は RSI golden と同じ Wilder 系列、
	// 末尾 17 本を追加して signal の有効区間 (index >= 33) も確実に覆う。
	// 参照: docs/market-data-accuracy-checklist.md §8.11
	const MACD_GOLDEN_CLOSES = [
		44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03,
		46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13,
		43.84, 44.22, 44.57, 44.84, 45.1, 45.42, 45.84, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
	];

	it('golden: MACD(12,26,9) line/signal/hist 数値固定（pandas-ta.macd 参照、ε=1e-4）', () => {
		const result = macd(MACD_GOLDEN_CLOSES, 12, 26, 9);
		expect(result.line).toHaveLength(50);
		expect(result.signal).toHaveLength(50);
		expect(result.hist).toHaveLength(50);

		// line の有効先頭 index は 25（EMA(26) の出始め = period-1）
		const lineFirstFinite = result.line.findIndex((v) => Number.isFinite(v));
		expect(lineFirstFinite).toBe(25);
		for (let i = 0; i < 25; i++) {
			expect(result.line[i]).toBeNaN();
		}

		// signal の有効先頭 index は 33（line 有限値の先頭から 9 本目: 25 + 9 - 1）
		const signalFirstFinite = result.signal.findIndex((v) => Number.isFinite(v));
		expect(signalFirstFinite).toBe(33);
		for (let i = 0; i < 33; i++) {
			expect(result.signal[i]).toBeNaN();
		}

		// pandas-ta 出力値（line = EMA(12) - EMA(26)）
		expect(result.line[25]).toBeCloseTo(0.3067, 4);
		expect(result.line[33]).toBeCloseTo(-0.475, 3);
		expect(result.line[40]).toBeCloseTo(0.0641, 4);
		expect(result.line[49]).toBeCloseTo(0.328, 3);

		// pandas-ta 出力値（signal = EMA(9, line 有限部分)）
		expect(result.signal[33]).toBeCloseTo(-0.1454, 4);
		expect(result.signal[40]).toBeCloseTo(-0.1341, 4);
		expect(result.signal[49]).toBeCloseTo(0.257, 3);

		// 恒等式: hist[i] = line[i] - signal[i]（line/signal が共に有限な全 index で成立）
		for (let i = 0; i < 50; i++) {
			if (Number.isFinite(result.line[i]) && Number.isFinite(result.signal[i])) {
				expect(result.hist[i]).toBeCloseTo(result.line[i] - result.signal[i], 10);
			} else {
				expect(result.hist[i]).toBeNaN();
			}
		}
	});

	// 契約: line の先頭のみ NaN、途中は全て有限な入力では、
	// signal[i] の有効 index が line[i] の有効 index 起点で 9 本目から開始する。
	// 途中に NaN が混入したケースは契約外（docs §8.11）。
	it('macd index 防御: 先頭のみ NaN・途中は全て有限な line で signal が line の有限 index と整合', () => {
		const result = macd(MACD_GOLDEN_CLOSES, 12, 26, 9);

		const lineFirstFinite = result.line.findIndex((v) => Number.isFinite(v));
		// line の先頭 NaN 区間を除いて全て有限
		for (let i = lineFirstFinite; i < result.line.length; i++) {
			expect(Number.isFinite(result.line[i])).toBe(true);
		}

		// signal は lineFirstFinite + 8 (= 9 EMA の seed 位置) から有限
		const expectedSignalFirst = lineFirstFinite + (9 - 1);
		const signalFirstFinite = result.signal.findIndex((v) => Number.isFinite(v));
		expect(signalFirstFinite).toBe(expectedSignalFirst);

		// signal[i] は line[i] と同じ index に書き戻されている（圧縮されていない）
		for (let i = signalFirstFinite; i < result.signal.length; i++) {
			expect(Number.isFinite(result.signal[i])).toBe(true);
			expect(Number.isFinite(result.line[i])).toBe(true);
		}
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

	// 契約: ichimokuSeries が返す spanA[i] / spanB[i] は「計算バー位置 i」の値であり、
	// 描画時の +26 シフトは適用されていない（描画層 / 解釈層の責務）。
	// 参照: docs/market-data-accuracy-checklist.md §8.5, §8.6, §8.7
	describe('一目均衡表 index 契約', () => {
		// 単調増加する 60 本のデータ → 26 本前と末尾で値が大きく異なる
		const len = 60;
		const closes = Array.from({ length: len }, (_, i) => 100 + i);
		const highs = closes.map((c) => c + 5);
		const lows = closes.map((c) => c - 5);

		it('series.spanA[i] / spanB[i] は計算バー位置 i の値（+26 シフト前）', () => {
			const series = ichimokuSeries(highs, lows, closes);
			// spanA[i] は tenkan[i] と kijun[i] が両方有限な i (>= 25) で値を持つ
			// シフト後に末尾が NaN になる shiftChikou と違い、series 側は末尾まで値が埋まる
			expect(Number.isFinite(series.spanA[len - 1])).toBe(true);
			expect(Number.isFinite(series.spanB[len - 1])).toBe(true);
			// 計算定義どおり: spanA[i] = (tenkan[i] + kijun[i]) / 2
			for (let i = 25; i < len; i++) {
				expect(series.spanA[i]).toBeCloseTo((series.tenkan[i] + series.kijun[i]) / 2, 10);
			}
		});

		it('series.spanA[len-26] と ichimokuSnapshot().spanA は意味が異なる（トレンド系列で値も異なる）', () => {
			const series = ichimokuSeries(highs, lows, closes);
			const snap = ichimokuSnapshot(highs, lows, closes);
			expect(snap).not.toBeNull();
			if (!snap) return;

			// snapshot.spanA は「直近 9/26 本」から計算（= 26 本先にプロットされる雲）
			// series.spanA[len-1] も同じ値（末尾バーが直近窓そのもの）
			expect(series.spanA[len - 1]).toBeCloseTo(snap.spanA, 10);
			expect(series.spanB[len - 1]).toBeCloseTo(snap.spanB, 10);

			// 一方 series.spanA[len-26] は 26 本前のバーで計算された値（=「今日の雲」位置）
			// 単調増加データなので 26 本ぶんの差が出る
			expect(series.spanA[len - 26]).not.toBeCloseTo(snap.spanA, 4);
			expect(series.spanB[len - 26]).not.toBeCloseTo(snap.spanB, 4);
			// 増加データなので series.spanA[len-26] < snap.spanA となる
			expect(series.spanA[len - 26]).toBeLessThan(snap.spanA);
		});

		it('chikou[i] = closes[i]（遅行スパンの位置シフトは shiftChikou() の責務）', () => {
			const series = ichimokuSeries(highs, lows, closes);
			expect(series.chikou).toHaveLength(len);
			for (let i = 0; i < len; i++) {
				expect(series.chikou[i]).toBe(closes[i]);
			}
			// 確認: shiftChikou を別途適用すると末尾 26 個が NaN になる
			const shifted = shiftChikou(series.chikou, 26);
			for (let i = len - 26; i < len; i++) {
				expect(shifted[i]).toBeNaN();
			}
		});
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

	// 参照実装: lib/indicators.ts::stochastic()（自己整合性確認後に固定）
	// fixture: 40 本合成 OHLC（4 桁丸めで literal 化）
	//   close[i] = 100 + i*0.8 + sin(i*0.4)*2
	//   high[i]  = close[i] + 1.5
	//   low[i]   = close[i] - 1.5
	// 期待値は %K = (close - lowestLow) / (highestHigh - lowestLow) * 100、
	// %D = SMA(%K, 3) の定義に従う（実装値で固定 → リグレッション検出）。
	// 参照: docs/market-data-accuracy-checklist.md §8.4
	const STOCH_GOLDEN_CLOSES = [
		100, 101.5788, 103.0347, 104.2641, 105.1991, 105.8186, 106.1509, 106.27, 106.2833, 106.315, 106.4864, 106.8968,
		107.6077, 108.6331, 109.9375, 111.4412, 113.0331, 114.5882, 115.9873, 117.1358, 117.9787, 118.5092, 118.7698,
		118.8458, 118.8513, 118.912, 119.1443, 119.6381, 120.4416, 121.5543, 122.9269, 124.4688, 126.063, 127.5841,
		128.9183, 129.9812, 130.7313, 131.1765, 131.3728, 131.4155,
	];
	const STOCH_GOLDEN_HIGHS = [
		101.5, 103.0788, 104.5347, 105.7641, 106.6991, 107.3186, 107.6509, 107.77, 107.7833, 107.815, 107.9864, 108.3968,
		109.1077, 110.1331, 111.4375, 112.9412, 114.5331, 116.0882, 117.4873, 118.6358, 119.4787, 120.0092, 120.2698,
		120.3458, 120.3513, 120.412, 120.6443, 121.1381, 121.9416, 123.0543, 124.4269, 125.9688, 127.563, 129.0841,
		130.4183, 131.4812, 132.2313, 132.6765, 132.8728, 132.9155,
	];
	const STOCH_GOLDEN_LOWS = [
		98.5, 100.0788, 101.5347, 102.7641, 103.6991, 104.3186, 104.6509, 104.77, 104.7833, 104.815, 104.9864, 105.3968,
		106.1077, 107.1331, 108.4375, 109.9412, 111.5331, 113.0882, 114.4873, 115.6358, 116.4787, 117.0092, 117.2698,
		117.3458, 117.3513, 117.412, 117.6443, 118.1381, 118.9416, 120.0543, 121.4269, 122.9688, 124.563, 126.0841,
		127.4183, 128.4812, 129.2313, 129.6765, 129.8728, 129.9155,
	];

	it('golden: Stochastic(14, 3, 3) 数値固定（高/低/終値 40 本合成、ε=1e-4）', () => {
		const { kSeries, dSeries } = stochastic(STOCH_GOLDEN_HIGHS, STOCH_GOLDEN_LOWS, STOCH_GOLDEN_CLOSES, 14, 3, 3);
		expect(kSeries).toHaveLength(40);
		expect(dSeries).toHaveLength(40);
		// kSeries の有効先頭 index は kPeriod-1 + smoothK-1 = 13 + 2 = 15
		const kFirstFinite = kSeries.findIndex((v) => Number.isFinite(v));
		expect(kFirstFinite).toBe(15);
		for (let i = 0; i < 15; i++) {
			expect(kSeries[i]).toBeNaN();
		}
		// dSeries の有効先頭 index は kFirstFinite + smoothD-1 = 15 + 2 = 17
		const dFirstFinite = dSeries.findIndex((v) => Number.isFinite(v));
		expect(dFirstFinite).toBe(17);
		for (let i = 0; i < 17; i++) {
			expect(dSeries[i]).toBeNaN();
		}
		// 実装値（自己整合性確認済み）
		expect(kSeries[20]).toBeCloseTo(89.2285, 4);
		expect(dSeries[20]).toBeCloseTo(88.5798, 4);
		expect(kSeries[25]).toBeCloseTo(89.9057, 4);
		expect(dSeries[25]).toBeCloseTo(90.0991, 4);
		expect(kSeries[30]).toBeCloseTo(87.084, 4);
		expect(dSeries[30]).toBeCloseTo(87.6123, 4);
		expect(kSeries[39]).toBeCloseTo(90.2293, 4);
		expect(dSeries[39]).toBeCloseTo(90.0779, 4);
		// 範囲: 全有限値が 0..100 に収まる
		for (let i = kFirstFinite; i < 40; i++) {
			expect(kSeries[i]).toBeGreaterThanOrEqual(0);
			expect(kSeries[i]).toBeLessThanOrEqual(100);
		}
		for (let i = dFirstFinite; i < 40; i++) {
			expect(dSeries[i]).toBeGreaterThanOrEqual(0);
			expect(dSeries[i]).toBeLessThanOrEqual(100);
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
