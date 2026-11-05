import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/schemas.js';
import { computeOBV } from '../tools/analyze_indicators.js';

function makeCandle(close: number, volume: number, open = close, high = close, low = close): Candle {
	return { open, high, low, close, volume };
}

describe('computeOBV', () => {
	it('データ不足（1本未満）→ null', () => {
		const result = computeOBV([makeCandle(100, 10)]);
		expect(result.obv).toBeNull();
		expect(result.obvSma).toBeNull();
	});

	it('手計算と一致する OBV', () => {
		// close=[100, 105, 103, 108, 108]  volume=[10, 20, 15, 25, 30] → OBV: [0, +20, 20-15=5, 5+25=30, 30(unchanged)]
		const candles = [
			makeCandle(100, 10),
			makeCandle(105, 20), // up → +20
			makeCandle(103, 15), // down → -15
			makeCandle(108, 25), // up → +25
			makeCandle(108, 30), // equal → 0
		];
		const result = computeOBV(candles, 20);
		expect(result.obv).toBeCloseTo(30, 0);
		expect(result.prevObv).toBeCloseTo(30, 0);
		// SMA20 は 5 本では算出不可
		expect(result.obvSma).toBeNull();
	});

	it('全上昇 → OBV = volume の累積', () => {
		const candles = [];
		for (let i = 0; i < 30; i++) {
			candles.push(makeCandle(100 + i, 10));
		}
		const result = computeOBV(candles, 20);
		// OBV = 10 * 29 = 290
		expect(result.obv).toBeCloseTo(290, 0);
		expect(result.obvSma).not.toBeNull();
	});

	it('全下降 → OBV = 負の累積', () => {
		const candles = [];
		for (let i = 0; i < 30; i++) {
			candles.push(makeCandle(1000 - i, 10));
		}
		const result = computeOBV(candles, 20);
		expect(result.obv).toBeCloseTo(-290, 0);
	});

	it('フラット価格 → OBV=0, trend=flat', () => {
		const candles = Array(30)
			.fill(null)
			.map(() => makeCandle(100, 10));
		const result = computeOBV(candles, 20);
		expect(result.obv).toBeCloseTo(0, 0);
		expect(result.obvSma).toBeCloseTo(0, 0);
		expect(result.trend).toBe('flat');
	});

	it('上昇トレンド検出 (rising)', () => {
		const candles = [];
		// 最初 20 本フラット → SMA ベースライン
		for (let i = 0; i < 20; i++) candles.push(makeCandle(100, 10));
		// 次の 10 本全上昇・高ボリューム → OBV が SMA を上回る
		for (let i = 0; i < 10; i++) candles.push(makeCandle(101 + i, 50));
		const result = computeOBV(candles, 20);
		expect(result.trend).toBe('rising');
	});

	it('下降トレンド検出 (falling)', () => {
		const candles = [];
		// 最初 20 本やや上昇
		for (let i = 0; i < 20; i++) candles.push(makeCandle(100 + i * 0.1, 10));
		// 次の 10 本全下降・高ボリューム → OBV が SMA を下回る
		for (let i = 0; i < 10; i++) candles.push(makeCandle(100 - i, 50));
		const result = computeOBV(candles, 20);
		expect(result.trend).toBe('falling');
	});
});
