import { describe, expect, it } from 'vitest';
import { savgolFilter, smoothCandleExtremes } from '../../tools/patterns/smoothing.js';

describe('savgolFilter', () => {
	it('空配列は空を返す', () => {
		expect(savgolFilter([])).toEqual([]);
	});

	it('データがウィンドウより短い場合はコピーを返す', () => {
		const data = [1, 2];
		const result = savgolFilter(data, 5);
		expect(result).toEqual([1, 2]);
		expect(result).not.toBe(data);
	});

	it('定数列はそのまま返す', () => {
		const data = [5, 5, 5, 5, 5, 5, 5];
		const result = savgolFilter(data, 5, 2);
		for (const v of result) {
			expect(v).toBeCloseTo(5, 5);
		}
	});

	it('線形データを保持する（2次多項式フィルタ）', () => {
		const data = Array.from({ length: 20 }, (_, i) => 2 * i);
		const result = savgolFilter(data, 5, 2);
		// 端を除く中央部分は元と一致するはず
		for (let i = 3; i < data.length - 3; i++) {
			expect(result[i]).toBeCloseTo(data[i], 3);
		}
	});

	it('結果の長さは入力と同じ', () => {
		const data = [1, 3, 5, 7, 9, 11, 13];
		const result = savgolFilter(data, 5);
		expect(result).toHaveLength(data.length);
	});

	it('偶数ウィンドウサイズは奇数に補正される', () => {
		const data = [1, 2, 3, 4, 5, 6, 7];
		// windowSize=4 → 内部で5に補正
		const result = savgolFilter(data, 4);
		expect(result).toHaveLength(data.length);
	});

	it('端の値は元データをそのまま使用', () => {
		const data = [10, 20, 30, 40, 50, 60, 70];
		const result = savgolFilter(data, 5, 2);
		// half = 2 なので最初の2つと最後の2つは元データ
		expect(result[0]).toBe(10);
		expect(result[1]).toBe(20);
		expect(result[data.length - 1]).toBe(70);
		expect(result[data.length - 2]).toBe(60);
	});
});

describe('smoothCandleExtremes', () => {
	it('空配列は空の配列を返す', () => {
		const result = smoothCandleExtremes([]);
		expect(result.smoothHigh).toEqual([]);
		expect(result.smoothLow).toEqual([]);
	});

	it('high と low を個別に平滑化する', () => {
		const candles = Array.from({ length: 10 }, (_, i) => ({
			high: 100 + i * 2 + (i % 2 === 0 ? 1 : -1),
			low: 90 + i * 2 + (i % 2 === 0 ? -1 : 1),
		}));
		const result = smoothCandleExtremes(candles, 5, 2);
		expect(result.smoothHigh).toHaveLength(10);
		expect(result.smoothLow).toHaveLength(10);
	});

	it('結果の長さは入力と同じ', () => {
		const candles = [
			{ high: 110, low: 90 },
			{ high: 115, low: 85 },
			{ high: 112, low: 88 },
		];
		const result = smoothCandleExtremes(candles);
		expect(result.smoothHigh).toHaveLength(3);
		expect(result.smoothLow).toHaveLength(3);
	});
});
