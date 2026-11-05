import { describe, expect, it } from 'vitest';
import {
	DOUBLE_LEVEL_MAX_PCT,
	HS_NECKLINE_MAX_PCT,
	HS_SHOULDER_MAX_PCT,
	isSameLevel,
	PRIOR_TREND_LOOKBACK_MAX,
	PRIOR_TREND_LOOKBACK_MIN,
	PRIOR_TREND_MIN_EFFICIENCY,
	PRIOR_TREND_MIN_R2,
	PRIOR_TREND_SIDEWAYS_PCT,
	REVERSAL_HISTORY_WARMUP_BARS,
	validateHorizontalNeckline,
	validatePriorTrend,
} from '../../tools/patterns/structural.js';
import { requireDefined } from '../helpers/assert.js';

describe('定数', () => {
	it('構造上限値の定義', () => {
		expect(DOUBLE_LEVEL_MAX_PCT).toBe(0.03);
		expect(HS_SHOULDER_MAX_PCT).toBe(0.05);
		expect(HS_NECKLINE_MAX_PCT).toBe(0.05);
		expect(PRIOR_TREND_SIDEWAYS_PCT).toBe(0.05);
		expect(PRIOR_TREND_LOOKBACK_MIN).toBe(10);
		expect(PRIOR_TREND_LOOKBACK_MAX).toBe(30);
		expect(PRIOR_TREND_MIN_EFFICIENCY).toBe(0.55);
		expect(PRIOR_TREND_MIN_R2).toBe(0.35);
		expect(REVERSAL_HISTORY_WARMUP_BARS).toBe(60);
	});
});

describe('isSameLevel', () => {
	it('境界値（=== maxPct）で true', () => {
		// relDev(95, 100) = 5/100 = 0.05
		expect(isSameLevel(95, 100, 0.05)).toBe(true);
	});

	it('上限超え（> maxPct）で false', () => {
		// relDev(90, 100) = 10/100 = 0.1 > 0.05
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
		// relDev(95, 100) = 0.05 === maxPct
		const result = validateHorizontalNeckline(95, 100, HS_NECKLINE_MAX_PCT);
		expect(result.ok).toBe(true);
		expect(result.diffPct).toBeCloseTo(0.05, 10);
	});

	it('7% 超え（山1=17.5M、山2=18.8M 相当）は NG', () => {
		// relDev(17_500_000, 18_800_000) = 1.3M / 18.8M ≈ 0.0691
		const result = validateHorizontalNeckline(17_500_000, 18_800_000, HS_NECKLINE_MAX_PCT);
		expect(result.ok).toBe(false);
		expect(result.diffPct).toBeCloseTo(1_300_000 / 18_800_000, 10);
	});

	it('差が完全に許容内なら ok=true', () => {
		// relDev(99, 100) = 0.01 < 0.05
		const result = validateHorizontalNeckline(99, 100, HS_NECKLINE_MAX_PCT);
		expect(result.ok).toBe(true);
		expect(result.diffPct).toBeCloseTo(0.01, 10);
	});
});

describe('validatePriorTrend', () => {
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

	it('時間足別パラメータで横ばい閾値とlookbackを上書きできる', () => {
		const closes = Array.from({ length: 13 }, () => 100);
		closes[12] = 102;
		const result = validatePriorTrend(makeCandles(closes), 12, 5, 'up', {
			sidewaysPct: 0.01,
			lookbackMin: 12,
			lookbackMax: 24,
		});
		expect(result.lookbackBars).toBe(12);
		expect(result.classification).toBe('up');
		expect(result.ok).toBe(true);
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

	describe('方向必須の反転前提 (up / down)', () => {
		it('明確な上昇トレンドだけを up として受け入れる', () => {
			const closes = [100, 100, 100, 100, 100, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
			const result = validatePriorTrend(makeCandles(closes), 15, 5, 'up');
			expect(result.classification).toBe('up');
			expect(result.ok).toBe(true);
		});

		it('明確な下降トレンドだけを down として受け入れる', () => {
			const closes = [100, 100, 100, 100, 100, 100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90];
			const result = validatePriorTrend(makeCandles(closes), 15, 5, 'down');
			expect(result.classification).toBe('down');
			expect(result.ok).toBe(true);
		});

		it('横ばいは up / down のどちらにも使えない', () => {
			const closes = Array.from({ length: 16 }, () => 100);
			const up = validatePriorTrend(makeCandles(closes), 15, 5, 'up');
			const down = validatePriorTrend(makeCandles(closes), 15, 5, 'down');
			expect(up).toMatchObject({ classification: 'sideways', ok: false });
			expect(down).toMatchObject({ classification: 'sideways', ok: false });
		});

		it('履歴不足は方向が未検証なだけなので保留として通す', () => {
			const candles = makeCandles([100, 100, 100]);
			expect(validatePriorTrend(candles, 2, 5, 'up')).toMatchObject({
				classification: 'insufficient_data',
				ok: true,
			});
			expect(validatePriorTrend(candles, 2, 5, 'down')).toMatchObject({
				classification: 'insufficient_data',
				ok: true,
			});
		});
	});

	describe('レンジ性フィルタ', () => {
		it('レンジ内の擬似下降は sideways（priorReturn -7% でも efficiency/r2 低い）', () => {
			// idx 5 から idx 15 まで価格がレンジ内でジグザグに振動する（priorReturn=-0.07、range=40 で efficiency = 7/40 = 0.175 < 0.55、ジグザグの線形回帰は r2 も < 0.35）。
			const closes = [
				100,
				100,
				100,
				100,
				100, // idx 0-4: 余白
				100, // idx 5: priorClose
				120,
				80,
				115,
				85, // idx 6-9: ジグザグ
				120,
				80,
				115,
				85,
				100, // idx 10-14: ジグザグ
				93, // idx 15: startClose
			];
			const result = validatePriorTrend(makeCandles(closes), 15, 5, 'down_or_sideways');
			expect(result.priorReturn).toBeCloseTo(-0.07, 10);
			expect(result.classification).toBe('sideways');
			expect(result.ok).toBe(true);
			expect(result.efficiency).toBeDefined();
			expect(result.r2).toBeDefined();
			expect(result.efficiency).toBeLessThan(PRIOR_TREND_MIN_EFFICIENCY);
			expect(result.r2).toBeLessThan(PRIOR_TREND_MIN_R2);
		});

		it('なだらかな下降トレンドは down（efficiency と r2 が共に高い）', () => {
			// idx 5 → idx 15 で 100 → 92 へほぼ単調下降。priorReturn ≈ -0.08
			const closes = [
				100,
				100,
				100,
				100,
				100, // idx 0-4: 余白
				100,
				99,
				98,
				97,
				96,
				95,
				94.5,
				94,
				93.5,
				92.5,
				92,
			];
			const result = validatePriorTrend(makeCandles(closes), 15, 5, 'down_or_sideways');
			expect(result.priorReturn).toBeCloseTo(-0.08, 10);
			expect(result.classification).toBe('down');
			expect(result.ok).toBe(true);
			expect(requireDefined(result.efficiency, 'result.efficiency')).toBeGreaterThanOrEqual(PRIOR_TREND_MIN_EFFICIENCY);
			expect(requireDefined(result.r2, 'result.r2')).toBeGreaterThanOrEqual(PRIOR_TREND_MIN_R2);
		});

		it('なだらかな上昇トレンドは up（efficiency と r2 が共に高い）', () => {
			// idx 5 → idx 15 で 100 → 108 へほぼ単調上昇。priorReturn ≈ +0.08
			const closes = [
				100,
				100,
				100,
				100,
				100, // idx 0-4: 余白
				100,
				101,
				102,
				103,
				104,
				105,
				105.5,
				106,
				106.5,
				107.5,
				108,
			];
			const result = validatePriorTrend(makeCandles(closes), 15, 5, 'up_or_sideways');
			expect(result.priorReturn).toBeCloseTo(0.08, 10);
			expect(result.classification).toBe('up');
			expect(result.ok).toBe(true);
			expect(requireDefined(result.efficiency, 'result.efficiency')).toBeGreaterThanOrEqual(PRIOR_TREND_MIN_EFFICIENCY);
			expect(requireDefined(result.r2, 'result.r2')).toBeGreaterThanOrEqual(PRIOR_TREND_MIN_R2);
		});

		it('大きな下降はノイズが多少あっても down', () => {
			// priorReturn=-15% 程度。中盤に多少のリバウンドがあるが、efficiency は十分高く trend として残る。
			const closes = [
				100,
				100,
				100,
				100,
				100, // idx 0-4: 余白
				100,
				96,
				92,
				90,
				93,
				88,
				86,
				90,
				88,
				85,
				85,
			];
			const result = validatePriorTrend(makeCandles(closes), 15, 5, 'down_or_sideways');
			expect(result.priorReturn).toBeCloseTo(-0.15, 10);
			expect(result.classification).toBe('down');
			expect(result.ok).toBe(true);
			expect(requireDefined(result.efficiency, 'result.efficiency')).toBeGreaterThanOrEqual(PRIOR_TREND_MIN_EFFICIENCY);
		});

		it('r2 だけが閾値以上の場合も up/down に分類される', () => {
			// 振幅は小さいが線形にフィットするデータ（y = 100 - 1*step + small_noise、step=10 で startClose=90 → priorReturn=-0.1）。
			const closes = [
				100,
				100,
				100,
				100,
				100, // idx 0-4: 余白
				100,
				99,
				99.5,
				97.5,
				97,
				96,
				95.5,
				93.5,
				93,
				91,
				90,
			];
			const result = validatePriorTrend(makeCandles(closes), 15, 5, 'down_or_sideways');
			expect(result.priorReturn).toBeCloseTo(-0.1, 10);
			expect(result.classification).toBe('down');
			expect(requireDefined(result.r2, 'result.r2')).toBeGreaterThanOrEqual(PRIOR_TREND_MIN_R2);
		});

		it('rangePct / efficiency / r2 は補助指標として戻り値に含まれる', () => {
			const closes = [100, 100, 100, 100, 100, 100, 101, 102, 103, 104, 105, 105.5, 106, 106.5, 107.5, 108];
			const result = validatePriorTrend(makeCandles(closes), 15, 5, 'up_or_sideways');
			expect(typeof result.rangePct).toBe('number');
			expect(typeof result.efficiency).toBe('number');
			expect(typeof result.r2).toBe('number');
			expect(Number.isFinite(requireDefined(result.rangePct, 'result.rangePct'))).toBe(true);
			expect(Number.isFinite(requireDefined(result.efficiency, 'result.efficiency'))).toBe(true);
			expect(Number.isFinite(requireDefined(result.r2, 'result.r2'))).toBe(true);
		});

		it('|priorReturn| <= sideways 範囲なら efficiency/r2 を計算せず sideways', () => {
			// priorReturn=0 → 早期 return パスで rangePct/efficiency/r2 は undefined
			const closes = Array.from({ length: 16 }, () => 100);
			const result = validatePriorTrend(makeCandles(closes), 15, 5, 'down_or_sideways');
			expect(result.classification).toBe('sideways');
			expect(result.rangePct).toBeUndefined();
			expect(result.efficiency).toBeUndefined();
			expect(result.r2).toBeUndefined();
		});

		it('insufficient_data は rangePct/efficiency/r2 を計算しない', () => {
			const closes = Array.from({ length: 6 }, () => 100);
			const result = validatePriorTrend(makeCandles(closes), 5, 5, 'down_or_sideways');
			expect(result.classification).toBe('insufficient_data');
			expect(result.rangePct).toBeUndefined();
			expect(result.efficiency).toBeUndefined();
			expect(result.r2).toBeUndefined();
		});
	});

	describe('priorStartIdx', () => {
		function makeCandles(closes: number[]): Array<{ close: number }> {
			return closes.map((close) => ({ close }));
		}

		it('priorStartIdx = max(0, startIdx - lookbackBars)', () => {
			// startIdx=15, lookbackBars=10 → priorStartIdx=5
			const closes = Array.from({ length: 16 }, () => 100);
			const result = validatePriorTrend(makeCandles(closes), 15, 5, 'down_or_sideways');
			expect(result.priorStartIdx).toBe(5);
		});

		it('insufficient_data でも priorStartIdx を返す（0 にクランプ）', () => {
			// startIdx=5, lookbackBars=10 → priorStartIdx=0
			const closes = Array.from({ length: 6 }, () => 100);
			const result = validatePriorTrend(makeCandles(closes), 5, 5, 'down_or_sideways');
			expect(result.classification).toBe('insufficient_data');
			expect(result.priorStartIdx).toBe(0);
		});

		it('priorStartIdx = max(0, startIdx - 30) (max クランプ後)', () => {
			// startIdx=40, patternBars=120 → lookbackBars=30, priorStartIdx=10
			const closes = Array.from({ length: 41 }, () => 100);
			const result = validatePriorTrend(makeCandles(closes), 40, 120, 'down_or_sideways');
			expect(result.priorStartIdx).toBe(10);
		});
	});
});
