import { describe, expect, it } from 'vitest';
import { calculateRSI, rsiStrategy, validateParams } from '../../../../tools/trading_process/lib/strategies/rsi.js';
import type { Candle } from '../../../../tools/trading_process/types.js';

function candlesFromCloses(closes: number[]): Candle[] {
	return closes.map((c, i) => ({
		time: `2024-01-${String(i + 1).padStart(2, '0')}`,
		open: c,
		high: c + 1,
		low: c - 1,
		close: c,
	}));
}

describe('validateParams', () => {
	it('デフォルトパラメータで通過', () => {
		const result = validateParams({});
		expect(result.valid).toBe(true);
		expect(result.normalizedParams.period).toBe(14);
		expect(result.normalizedParams.overbought).toBe(70);
		expect(result.normalizedParams.oversold).toBe(30);
	});

	it('period < 2 でエラー', () => {
		const result = validateParams({ period: 1 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('period must be at least 2');
	});

	it('overbought <= oversold でエラー', () => {
		const result = validateParams({ overbought: 30, oversold: 30 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('overbought must be greater than oversold');
	});

	it('oversold が範囲外でエラー', () => {
		const result = validateParams({ oversold: -1 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('oversold must be between 0 and 100');
	});

	it('overbought が範囲外でエラー', () => {
		const result = validateParams({ overbought: 101 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('overbought must be between 0 and 100');
	});

	it('複数エラーを同時に返す', () => {
		const result = validateParams({
			period: 0,
			overbought: 20,
			oversold: 50,
		});
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThanOrEqual(2);
	});
});

describe('calculateRSI', () => {
	it('結果の長さが入力と同じ', () => {
		const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
		const result = calculateRSI(closes, 14);
		expect(result).toHaveLength(closes.length);
	});

	it('先頭 period 個は NaN', () => {
		const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
		const result = calculateRSI(closes, 14);
		for (let i = 0; i < 14; i++) {
			expect(result[i]).toBeNaN();
		}
	});

	it('上昇トレンドでは RSI が高い', () => {
		// 20本の連続上昇
		const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
		const result = calculateRSI(closes, 14);
		const lastRSI = result[result.length - 1];
		expect(lastRSI).toBeGreaterThan(50);
	});

	it('下降トレンドでは RSI が低い', () => {
		const closes = Array.from({ length: 30 }, (_, i) => 200 - i * 2);
		const result = calculateRSI(closes, 14);
		const lastRSI = result[result.length - 1];
		expect(lastRSI).toBeLessThan(50);
	});
});

describe('rsiStrategy', () => {
	it('name / type / requiredBars が正しい', () => {
		expect(rsiStrategy.name).toBe('RSI');
		expect(rsiStrategy.type).toBe('rsi');
		expect(rsiStrategy.requiredBars).toBe(20);
		expect(rsiStrategy.computeRequiredBars({})).toBe(20);
	});

	describe('computeRequiredBars', () => {
		it('period を増やすと必要バー数が増える（period=50 → 56）', () => {
			expect(rsiStrategy.computeRequiredBars({ period: 50 })).toBe(56);
		});
	});

	describe('generate', () => {
		it('シグナル配列の長さがローソク足と一致する', () => {
			const candles = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
			const signals = rsiStrategy.generate(candles, {});
			expect(signals).toHaveLength(candles.length);
		});

		it('startIdx 未満は hold', () => {
			const candles = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
			const signals = rsiStrategy.generate(candles, { period: 14 });
			// startIdx = period + 1 = 15
			for (let i = 0; i < 15; i++) {
				expect(signals[i].action).toBe('hold');
			}
		});

		it('急落→回復で buy シグナルが発生する', () => {
			// period=5 で短い期間にして oversold を割りやすくする
			const prices = [
				100,
				102,
				104,
				103,
				105,
				106,
				107, // 上昇
				95,
				85,
				75,
				65,
				60, // 急落（RSI → oversold）
				62,
				65,
				70,
				75,
				80,
				85, // 回復（RSI が oversold 上抜け）
			];
			const candles = candlesFromCloses(prices);
			const signals = rsiStrategy.generate(candles, {
				period: 5,
				overbought: 70,
				oversold: 30,
			});

			const buys = signals.filter((s) => s.action === 'buy');
			for (const buy of buys) {
				expect(buy.reason).toMatch(/RSI crossed above/);
			}
		});

		it('急騰で sell シグナルが発生する', () => {
			const prices = [
				100,
				102,
				104,
				106,
				108,
				110,
				112, // ゆるやかな上昇
				115,
				120,
				130,
				140,
				150,
				160, // 急騰（RSI → overbought）
			];
			const candles = candlesFromCloses(prices);
			const signals = rsiStrategy.generate(candles, {
				period: 5,
				overbought: 70,
				oversold: 30,
			});

			const sells = signals.filter((s) => s.action === 'sell');
			for (const sell of sells) {
				expect(sell.reason).toMatch(/RSI reached overbought/);
			}
		});

		it('全てのシグナルに time が含まれる', () => {
			const candles = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
			const signals = rsiStrategy.generate(candles, {});
			for (const signal of signals) {
				expect(signal.time).toBeDefined();
			}
		});
	});

	describe('getOverlays', () => {
		it('1つの line overlay を返す', () => {
			const candles = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
			const overlays = rsiStrategy.getOverlays(candles, {});
			expect(overlays).toHaveLength(1);
			expect(overlays[0].type).toBe('line');
		});

		it('overlay の名前に period が含まれる', () => {
			const candles = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
			const overlays = rsiStrategy.getOverlays(candles, { period: 10 });
			expect(overlays[0].name).toBe('RSI(10)');
		});

		it('overlay data の長さがローソク足と一致する', () => {
			const candles = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
			const overlays = rsiStrategy.getOverlays(candles, {});
			const lineOverlay = overlays[0] as { data: number[] };
			expect(lineOverlay.data).toHaveLength(candles.length);
		});
	});
});
