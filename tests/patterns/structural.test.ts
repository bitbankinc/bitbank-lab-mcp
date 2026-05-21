import { describe, expect, it } from 'vitest';
import {
	DOUBLE_LEVEL_MAX_PCT,
	HS_NECKLINE_MAX_PCT,
	HS_SHOULDER_MAX_PCT,
	isSameLevel,
	PRIOR_TREND_LOOKBACK_MAX,
	PRIOR_TREND_LOOKBACK_MIN,
	PRIOR_TREND_SIDEWAYS_PCT,
	relDiff,
	validateHorizontalNeckline,
	validatePriorTrend,
} from '../../tools/patterns/structural.js';

describe('定数', () => {
	it('構造上限値の定義', () => {
		expect(DOUBLE_LEVEL_MAX_PCT).toBe(0.03);
		expect(HS_SHOULDER_MAX_PCT).toBe(0.05);
		expect(HS_NECKLINE_MAX_PCT).toBe(0.05);
		expect(PRIOR_TREND_SIDEWAYS_PCT).toBe(0.05);
		expect(PRIOR_TREND_LOOKBACK_MIN).toBe(10);
		expect(PRIOR_TREND_LOOKBACK_MAX).toBe(30);
	});
});

describe('relDiff', () => {
	it('同じ値は 0', () => {
		expect(relDiff(100, 100)).toBe(0);
	});

	it('一方が 0 の境界（a=0）は 1', () => {
		expect(relDiff(0, 5)).toBe(1);
	});

	it('一方が 0 の境界（b=0）は 1', () => {
		expect(relDiff(5, 0)).toBe(1);
	});

	it('両方 0 はゼロ除算を避けて 0 を返す', () => {
		expect(relDiff(0, 0)).toBe(0);
	});

	it('通常ケース: max(a,b) を分母にとる', () => {
		// |100 - 110| / 110 = 10 / 110
		expect(relDiff(100, 110)).toBeCloseTo(10 / 110, 10);
	});

	it('順序は関係ない', () => {
		expect(relDiff(100, 110)).toBe(relDiff(110, 100));
	});
});

describe('isSameLevel', () => {
	it('境界値（=== maxPct）で true', () => {
		// relDiff(95, 100) = 5/100 = 0.05
		expect(isSameLevel(95, 100, 0.05)).toBe(true);
	});

	it('上限超え（> maxPct）で false', () => {
		// relDiff(90, 100) = 10/100 = 0.1 > 0.05
		expect(isSameLevel(90, 100, 0.05)).toBe(false);
	});

	it('同じ値は常に true', () => {
		expect(isSameLevel(100, 100, 0)).toBe(true);
	});

	it('差が許容より十分小さければ true', () => {
		expect(isSameLevel(99, 100, 0.05)).toBe(true);
	});
});

describe('validateHorizontalNeckline', () => {
	it('同水準（diffPct === 0）', () => {
		const result = validateHorizontalNeckline(100, 100, HS_NECKLINE_MAX_PCT);
		expect(result.ok).toBe(true);
		expect(result.diffPct).toBe(0);
	});

	it('5% 境界はギリギリ OK', () => {
		// relDiff(95, 100) = 0.05 === maxPct
		const result = validateHorizontalNeckline(95, 100, HS_NECKLINE_MAX_PCT);
		expect(result.ok).toBe(true);
		expect(result.diffPct).toBeCloseTo(0.05, 10);
	});

	it('7% 超え（山1=17.5M、山2=18.8M 相当）は NG', () => {
		// relDiff(17_500_000, 18_800_000) = 1.3M / 18.8M ≈ 0.0691
		const result = validateHorizontalNeckline(17_500_000, 18_800_000, HS_NECKLINE_MAX_PCT);
		expect(result.ok).toBe(false);
		expect(result.diffPct).toBeCloseTo(1_300_000 / 18_800_000, 10);
	});

	it('差が完全に許容内なら ok=true', () => {
		// relDiff(99, 100) = 0.01 < 0.05
		const result = validateHorizontalNeckline(99, 100, HS_NECKLINE_MAX_PCT);
		expect(result.ok).toBe(true);
		expect(result.diffPct).toBeCloseTo(0.01, 10);
	});
});

describe('validatePriorTrend', () => {
	/** close 値の配列から最小限の candles 配列を生成 */
	function makeCandles(closes: number[]): Array<{ close: number }> {
		return closes.map((close) => ({ close }));
	}

	describe('データ不足', () => {
		it('startIdx === 0 は insufficient_data', () => {
			const candles = makeCandles([100]);
			const result = validatePriorTrend(candles, 0, 5, 'down_or_sideways');
			expect(result.ok).toBe(true);
			expect(result.classification).toBe('insufficient_data');
		});

		it('startIdx < PRIOR_TREND_LOOKBACK_MIN は insufficient_data', () => {
			// startIdx=5, lookbackBars=10 → priorStart=0, startIdx < 10
			const candles = makeCandles(Array.from({ length: 6 }, () => 100));
			const result = validatePriorTrend(candles, 5, 5, 'down_or_sideways');
			expect(result.ok).toBe(true);
			expect(result.classification).toBe('insufficient_data');
		});

		it('insufficient_data でも up_or_sideways は ok=true（hard reject しない）', () => {
			const candles = makeCandles([100, 100, 100]);
			const result = validatePriorTrend(candles, 2, 5, 'up_or_sideways');
			expect(result.ok).toBe(true);
			expect(result.classification).toBe('insufficient_data');
		});

		// patternBars が大きく lookbackBars=30 にクランプされる場合、
		// startIdx=15 では startIdx - lookbackBars = -15 < 0 なので
		// 旧条件（startIdx < PRIOR_TREND_LOOKBACK_MIN=10）では拾えなかった。
		it('startIdx < lookbackBars (max クランプ後) は insufficient_data', () => {
			// startIdx=15, patternBars=120 → lookbackBars=30, 15 < 30 で insufficient
			const closes = Array.from({ length: 16 }, () => 100);
			const result = validatePriorTrend(makeCandles(closes), 15, 120, 'down_or_sideways');
			expect(result.ok).toBe(true);
			expect(result.classification).toBe('insufficient_data');
			expect(result.lookbackBars).toBe(30);
		});
	});

	describe('lookbackBars の clamp 動作', () => {
		it('patternBars=5 → lookbackBars=10 (min クランプ)', () => {
			// startIdx=15 で priorStart=15-10=5
			const closes = Array.from({ length: 16 }, () => 100);
			const result = validatePriorTrend(makeCandles(closes), 15, 5, 'down_or_sideways');
			expect(result.lookbackBars).toBe(10);
		});

		it('patternBars=120 → lookbackBars=30 (max クランプ)', () => {
			// startIdx=40 で priorStart=40-30=10
			const closes = Array.from({ length: 41 }, () => 100);
			const result = validatePriorTrend(makeCandles(closes), 40, 120, 'down_or_sideways');
			expect(result.lookbackBars).toBe(30);
		});

		it('patternBars=40 → lookbackBars=20 (中間)', () => {
			const closes = Array.from({ length: 41 }, () => 100);
			const result = validatePriorTrend(makeCandles(closes), 40, 40, 'down_or_sideways');
			expect(result.lookbackBars).toBe(20);
		});
	});

	describe('bullish 反転前提 (down_or_sideways)', () => {
		it('priorReturn=-10% → ok=true, classification=down', () => {
			// close[5]=100, close[15]=90 → priorReturn=(90-100)/100=-0.1
			const closes = Array.from({ length: 16 }, () => 100);
			closes[15] = 90;
			const result = validatePriorTrend(makeCandles(closes), 15, 5, 'down_or_sideways');
			expect(result.ok).toBe(true);
			expect(result.classification).toBe('down');
			expect(result.priorReturn).toBeCloseTo(-0.1, 10);
		});

		it('priorReturn=0% → ok=true, classification=sideways', () => {
			const closes = Array.from({ length: 16 }, () => 100);
			const result = validatePriorTrend(makeCandles(closes), 15, 5, 'down_or_sideways');
			expect(result.ok).toBe(true);
			expect(result.classification).toBe('sideways');
			expect(result.priorReturn).toBeCloseTo(0, 10);
		});

		it('priorReturn=+10% → ok=false, classification=up', () => {
			const closes = Array.from({ length: 16 }, () => 100);
			closes[15] = 110;
			const result = validatePriorTrend(makeCandles(closes), 15, 5, 'down_or_sideways');
			expect(result.ok).toBe(false);
			expect(result.classification).toBe('up');
			expect(result.priorReturn).toBeCloseTo(0.1, 10);
		});
	});

	describe('bearish 反転前提 (up_or_sideways)', () => {
		it('priorReturn=+10% → ok=true, classification=up', () => {
			const closes = Array.from({ length: 16 }, () => 100);
			closes[15] = 110;
			const result = validatePriorTrend(makeCandles(closes), 15, 5, 'up_or_sideways');
			expect(result.ok).toBe(true);
			expect(result.classification).toBe('up');
		});

		it('priorReturn=0% → ok=true, classification=sideways', () => {
			const closes = Array.from({ length: 16 }, () => 100);
			const result = validatePriorTrend(makeCandles(closes), 15, 5, 'up_or_sideways');
			expect(result.ok).toBe(true);
			expect(result.classification).toBe('sideways');
		});

		it('priorReturn=-10% → ok=false, classification=down', () => {
			const closes = Array.from({ length: 16 }, () => 100);
			closes[15] = 90;
			const result = validatePriorTrend(makeCandles(closes), 15, 5, 'up_or_sideways');
			expect(result.ok).toBe(false);
			expect(result.classification).toBe('down');
		});
	});
});
