import { describe, expect, it } from 'vitest';
import { smaCrossStrategy, validateParams } from '../../../../tools/trading_process/lib/strategies/sma_cross.js';
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
		expect(result.normalizedParams.short).toBe(5);
		expect(result.normalizedParams.long).toBe(20);
	});

	it('short >= long でエラー', () => {
		const result = validateParams({ short: 20, long: 20 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('short must be less than long');
	});

	it('short < 2 でエラー', () => {
		const result = validateParams({ short: 1 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('short must be at least 2');
	});

	it('long < 3 でエラー', () => {
		const result = validateParams({ short: 2, long: 2 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('long must be at least 3');
	});

	it('sma_filter_period < 0 でエラー', () => {
		const result = validateParams({ sma_filter_period: -1 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('sma_filter_period must be >= 0');
	});

	it('rsi_filter_period < 0 でエラー', () => {
		const result = validateParams({ rsi_filter_period: -1 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('rsi_filter_period must be >= 0');
	});

	it('rsi_filter_max 範囲外でエラー', () => {
		const result = validateParams({ rsi_filter_max: 101 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('rsi_filter_max must be 0-100');
	});

	it('フィルター 0 は無効（有効な設定）', () => {
		const result = validateParams({
			sma_filter_period: 0,
			rsi_filter_period: 0,
		});
		expect(result.valid).toBe(true);
	});
});

describe('smaCrossStrategy', () => {
	it('name / type / requiredBars が正しい', () => {
		expect(smaCrossStrategy.name).toBe('SMA Crossover');
		expect(smaCrossStrategy.type).toBe('sma_cross');
		expect(smaCrossStrategy.requiredBars).toBe(30);
		expect(smaCrossStrategy.computeRequiredBars({})).toBe(30);
	});

	describe('computeRequiredBars', () => {
		it('long を増やすと必要バー数が増える（long=100 → 110）', () => {
			expect(smaCrossStrategy.computeRequiredBars({ long: 100 })).toBe(110);
		});

		it('sma_filter_period が long より大きい場合はそちらに支配される', () => {
			expect(smaCrossStrategy.computeRequiredBars({ sma_filter_period: 200 })).toBe(209);
		});

		it('rsi_filter_period が支配的なケースは period + 1 + 10', () => {
			expect(smaCrossStrategy.computeRequiredBars({ short: 3, long: 5, rsi_filter_period: 50 })).toBe(61);
		});
	});

	describe('generate', () => {
		it('シグナル配列の長さがローソク足と一致する', () => {
			const candles = candlesFromCloses(Array.from({ length: 40 }, (_, i) => 100 + i));
			const signals = smaCrossStrategy.generate(candles, {});
			expect(signals).toHaveLength(candles.length);
		});

		it('startIdx 未満は hold', () => {
			const candles = candlesFromCloses(Array.from({ length: 40 }, (_, i) => 100 + i));
			const signals = smaCrossStrategy.generate(candles, {
				short: 5,
				long: 20,
			});
			// startIdx = longPeriod = 20
			for (let i = 0; i < 20; i++) {
				expect(signals[i].action).toBe('hold');
			}
		});

		it('ゴールデンクロスで buy シグナルを生成', () => {
			// 下降 → 上昇の転換でゴールデンクロス発生
			// short=2, long=5 で短い期間にして検出しやすくする
			const prices = [
				100,
				98,
				96,
				94,
				92,
				90,
				88, // 下降
				85,
				83,
				82, // さらに下降
				84,
				88,
				92,
				96,
				100,
				105,
				110,
				115,
				120, // 急回復
			];
			const candles = candlesFromCloses(prices);
			const signals = smaCrossStrategy.generate(candles, {
				short: 2,
				long: 5,
			});

			const buys = signals.filter((s) => s.action === 'buy');
			expect(buys.length).toBeGreaterThan(0);
			for (const buy of buys) {
				expect(buy.reason).toMatch(/Golden Cross/);
			}
		});

		it('デッドクロスで sell シグナルを生成', () => {
			// 上昇 → 下降の転換でデッドクロス発生
			const prices = [
				80,
				85,
				90,
				95,
				100,
				105,
				110,
				115,
				120, // 上昇
				115,
				110,
				105,
				100,
				95,
				90,
				85,
				80,
				75,
				70, // 下降
			];
			const candles = candlesFromCloses(prices);
			const signals = smaCrossStrategy.generate(candles, {
				short: 2,
				long: 5,
			});

			const sells = signals.filter((s) => s.action === 'sell');
			expect(sells.length).toBeGreaterThan(0);
			for (const sell of sells) {
				expect(sell.reason).toMatch(/Dead Cross/);
			}
		});

		it('全てのシグナルに time が含まれる', () => {
			const candles = candlesFromCloses(Array.from({ length: 40 }, (_, i) => 100 + i));
			const signals = smaCrossStrategy.generate(candles, {});
			for (const signal of signals) {
				expect(signal.time).toBeDefined();
			}
		});
	});

	describe('getOverlays', () => {
		it('フィルターなしで 2 つの line overlay を返す', () => {
			const candles = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
			const overlays = smaCrossStrategy.getOverlays(candles, {});
			expect(overlays).toHaveLength(2);
			expect(overlays[0].type).toBe('line');
			expect(overlays[1].type).toBe('line');
		});

		it('overlay の名前に period が含まれる', () => {
			const candles = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
			const overlays = smaCrossStrategy.getOverlays(candles, {
				short: 3,
				long: 10,
			});
			expect(overlays[0].name).toBe('SMA(3)');
			expect(overlays[1].name).toBe('SMA(10)');
		});

		it('sma_filter_period 有効時は overlay が 3 つになる', () => {
			const candles = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
			const overlays = smaCrossStrategy.getOverlays(candles, {
				sma_filter_period: 10,
			});
			expect(overlays).toHaveLength(3);
			expect(overlays[2].name).toMatch(/SMA10.*filter/);
		});

		it('rsi_filter 有効時は overlay にインジケータパネルが追加', () => {
			const candles = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
			const overlays = smaCrossStrategy.getOverlays(candles, {
				rsi_filter_period: 14,
				rsi_filter_max: 70,
			});
			expect(overlays).toHaveLength(3);
			const rsiOverlay = overlays[2] as { panel?: string; name: string };
			expect(rsiOverlay.panel).toBe('indicator');
			expect(rsiOverlay.name).toMatch(/RSI/);
		});

		it('overlay data の長さがローソク足と一致する', () => {
			const candles = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
			const overlays = smaCrossStrategy.getOverlays(candles, {});
			for (const overlay of overlays) {
				const lineOverlay = overlay as { data: number[] };
				expect(lineOverlay.data).toHaveLength(candles.length);
			}
		});
	});
});
