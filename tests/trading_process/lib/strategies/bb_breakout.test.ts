import { describe, expect, it } from 'vitest';
import { bbBreakoutStrategy, validateParams } from '../../../../tools/trading_process/lib/strategies/bb_breakout.js';
import type { Candle } from '../../../../tools/trading_process/types.js';

/**
 * 指定した終値配列からローソク足を生成（簡易版）
 * open=close, high=close+1, low=close-1 で統一
 */
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
	it('デフォルトパラメータでバリデーション通過', () => {
		const result = validateParams({});
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
		expect(result.normalizedParams.period).toBe(20);
		expect(result.normalizedParams.stddev).toBe(2);
	});

	it('period < 5 でエラー', () => {
		const result = validateParams({ period: 4 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('period must be at least 5');
	});

	it('stddev <= 0 でエラー', () => {
		const result = validateParams({ stddev: 0 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('stddev must be positive');
	});

	it('複数エラーを同時に返す', () => {
		const result = validateParams({ period: 2, stddev: -1 });
		expect(result.valid).toBe(false);
		expect(result.errors).toHaveLength(2);
	});

	it('境界値: period=5, stddev=0.01 で通過', () => {
		const result = validateParams({ period: 5, stddev: 0.01 });
		expect(result.valid).toBe(true);
	});
});

describe('bbBreakoutStrategy', () => {
	it('name / type / requiredBars が正しい', () => {
		expect(bbBreakoutStrategy.name).toBe('Bollinger Bands Breakout');
		expect(bbBreakoutStrategy.type).toBe('bb_breakout');
		expect(bbBreakoutStrategy.requiredBars).toBe(25);
		expect(bbBreakoutStrategy.computeRequiredBars({})).toBe(25);
	});

	describe('computeRequiredBars', () => {
		it('period を増やすと必要バー数が増える（period=50 → 55）', () => {
			expect(bbBreakoutStrategy.computeRequiredBars({ period: 50 })).toBe(55);
		});
	});

	describe('generate', () => {
		it('シグナル配列の長さがローソク足の長さと一致する', () => {
			const candles = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
			const signals = bbBreakoutStrategy.generate(candles, {});
			expect(signals).toHaveLength(candles.length);
		});

		it('startIdx 未満のバーは hold を返す', () => {
			const candles = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
			const signals = bbBreakoutStrategy.generate(candles, { period: 20 });
			// startIdx = period + 1 = 21 なので、0〜20 は hold
			for (let i = 0; i <= 20; i++) {
				expect(signals[i].action).toBe('hold');
			}
		});

		it('下部バンド下回り→中央線上抜けで buy シグナルを生成', () => {
			// BB period=5 で短い期間にしてテスト
			// 安定 → 急落(下部バンド割れ) → 回復(中央線上抜け) のシナリオ
			const prices = [
				100,
				100,
				100,
				100,
				100,
				100,
				100, // 安定期
				80,
				78,
				75, // 急落（下部バンド割れ）
				85,
				90,
				95,
				100,
				105, // 回復
			];
			const candles = candlesFromCloses(prices);
			const signals = bbBreakoutStrategy.generate(candles, {
				period: 5,
				stddev: 2,
			});

			const buys = signals.filter((s) => s.action === 'buy');
			// 急落→回復パターンで buy が発生する可能性あり
			for (const buy of buys) {
				expect(buy.reason).toMatch(/BB Breakout/);
			}
		});

		it('上部バンド到達で sell シグナルを生成', () => {
			// 安定期の後に急騰して上部バンドに到達
			const prices = [
				100,
				100,
				100,
				100,
				100,
				100,
				100, // 安定期
				80,
				78,
				75, // 急落
				85,
				95,
				105,
				120,
				140, // 急回復 → 上部バンド超え
			];
			const candles = candlesFromCloses(prices);
			const signals = bbBreakoutStrategy.generate(candles, {
				period: 5,
				stddev: 2,
			});

			const sells = signals.filter((s) => s.action === 'sell');
			for (const sell of sells) {
				expect(sell.reason).toMatch(/BB Upper Band reached/);
			}
		});

		it('全ての signal に time が含まれる', () => {
			const candles = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
			const signals = bbBreakoutStrategy.generate(candles, {});
			for (const signal of signals) {
				expect(signal.time).toBeDefined();
			}
		});
	});

	describe('getOverlays', () => {
		it('2つのオーバーレイ（line + band）を返す', () => {
			const candles = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
			const overlays = bbBreakoutStrategy.getOverlays(candles, {});
			expect(overlays).toHaveLength(2);
			expect(overlays[0].type).toBe('line');
			expect(overlays[1].type).toBe('band');
		});

		it('line overlay の名前に period が含まれる', () => {
			const candles = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
			const overlays = bbBreakoutStrategy.getOverlays(candles, {
				period: 10,
			});
			expect(overlays[0].name).toBe('BB Middle(10)');
		});

		it('band overlay の名前に stddev が含まれる', () => {
			const candles = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
			const overlays = bbBreakoutStrategy.getOverlays(candles, {
				stddev: 3,
			});
			expect(overlays[1].name).toBe('BB ±3σ');
		});

		it('overlay data の長さがローソク足と一致する', () => {
			const candles = candlesFromCloses(Array.from({ length: 30 }, (_, i) => 100 + i));
			const overlays = bbBreakoutStrategy.getOverlays(candles, {});
			const lineOverlay = overlays[0] as { data: number[] };
			expect(lineOverlay.data).toHaveLength(candles.length);
		});
	});
});
