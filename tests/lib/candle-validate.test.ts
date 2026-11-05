import { describe, expect, it } from 'vitest';
import {
	type CandleRow,
	checkCompleteness,
	checkDuplicates,
	checkIntegrity,
	checkPriceAnomalies,
	checkVolumeAnomalies,
	classifyPairTier,
	computeQualityScore,
	getTierDefaults,
} from '../../lib/candle-validate.js';
import { dayjs } from '../../lib/datetime.js';

function makeCandles(n: number, baseTs = 1704067200000): CandleRow[] {
	return Array.from({ length: n }, (_, i) => ({
		open: 100 + i,
		high: 110 + i,
		low: 90 + i,
		close: 105 + i,
		volume: 1 + i * 0.1,
		isoTime: dayjs(baseTs + i * 3_600_000).toISOString(),
	}));
}

describe('checkCompleteness', () => {
	it('完全なデータは ratio 1 を返す', () => {
		const candles = makeCandles(24);
		const result = checkCompleteness(candles, '1hour');
		expect(result.ratio).toBe(1);
		expect(result.missing).toBe(0);
		expect(result.missingTimestamps).toHaveLength(0);
	});

	it('歯抜けデータの欠損を検出する', () => {
		const candles = makeCandles(24);
		const sparse = candles.filter((_, i) => i !== 2 && i !== 4);
		const result = checkCompleteness(sparse, '1hour');
		expect(result.missing).toBe(2);
		expect(result.missingTimestamps).toHaveLength(2);
		expect(result.ratio).toBeLessThan(1);
	});

	it('1week/1month はスキップして ratio 1 を返す', () => {
		const candles = makeCandles(10);
		expect(checkCompleteness(candles, '1week').ratio).toBe(1);
		expect(checkCompleteness(candles, '1month').ratio).toBe(1);
	});

	it('空配列は ratio 1 を返す', () => {
		const result = checkCompleteness([], '1hour');
		expect(result.ratio).toBe(1);
		expect(result.missing).toBe(0);
	});

	it('単一要素は ratio 1 を返す', () => {
		const result = checkCompleteness(makeCandles(1), '1hour');
		expect(result.ratio).toBe(1);
	});
});

describe('checkDuplicates', () => {
	it('重複なしなら count 0', () => {
		const result = checkDuplicates(makeCandles(10));
		expect(result.count).toBe(0);
	});

	it('重複タイムスタンプを検出する', () => {
		const candles = makeCandles(5);
		candles.push({ ...candles[2] });
		const result = checkDuplicates(candles);
		expect(result.count).toBe(1);
		expect(result.timestamps).toHaveLength(1);
	});

	it('isoTime が null のバーはスキップする', () => {
		const candles: CandleRow[] = [
			{ open: 100, high: 110, low: 90, close: 105, isoTime: null },
			{ open: 100, high: 110, low: 90, close: 105, isoTime: null },
		];
		const result = checkDuplicates(candles);
		expect(result.count).toBe(0);
	});
});

describe('checkIntegrity', () => {
	it('正常なデータは invalidCount 0', () => {
		const result = checkIntegrity(makeCandles(10));
		expect(result.invalidCount).toBe(0);
	});

	it('high < low を検出', () => {
		const candles = makeCandles(3);
		candles[1] = { open: 100, high: 80, low: 90, close: 85, volume: 1 };
		const result = checkIntegrity(candles);
		expect(result.invalidCount).toBe(1);
		expect(result.issues[0].issues).toEqual(expect.arrayContaining([expect.stringContaining('high')]));
	});

	it('high < open を検出', () => {
		const candles: CandleRow[] = [{ open: 120, high: 110, low: 90, close: 105, volume: 1 }];
		const result = checkIntegrity(candles);
		expect(result.invalidCount).toBe(1);
	});

	it('low > close を検出', () => {
		const candles: CandleRow[] = [{ open: 100, high: 110, low: 108, close: 105, volume: 1 }];
		const result = checkIntegrity(candles);
		expect(result.invalidCount).toBe(1);
	});

	it('負の出来高を検出', () => {
		const candles: CandleRow[] = [{ open: 100, high: 110, low: 90, close: 105, volume: -1 }];
		const result = checkIntegrity(candles);
		expect(result.invalidCount).toBe(1);
		expect(result.issues[0].issues).toEqual(expect.arrayContaining([expect.stringContaining('volume')]));
	});

	it('空配列は invalidCount 0', () => {
		const result = checkIntegrity([]);
		expect(result.invalidCount).toBe(0);
		expect(result.totalChecked).toBe(0);
	});
});

describe('checkPriceAnomalies', () => {
	it('安定したデータは異常値ゼロ', () => {
		// 微小な変動のみ
		const candles = makeCandles(50);
		const result = checkPriceAnomalies(candles, 3);
		expect(result.anomalyCount).toBe(0);
	});

	it('急激な価格変動を検出する', () => {
		const candles = makeCandles(50);
		// 25本目で突然10倍の価格
		candles[25] = { ...candles[25], close: candles[24].close * 10 };
		const result = checkPriceAnomalies(candles, 3);
		expect(result.anomalyCount).toBeGreaterThan(0);
		expect(result.anomalies.some((a) => a.index === 25)).toBe(true);
	});

	it('閾値を下げると検出が増える', () => {
		const candles = makeCandles(100);
		// やや大きめの変動を1つ入れる
		candles[50] = { ...candles[50], close: candles[49].close * 1.5 };
		const strict = checkPriceAnomalies(candles, 1.5);
		const loose = checkPriceAnomalies(candles, 5);
		expect(strict.anomalyCount).toBeGreaterThanOrEqual(loose.anomalyCount);
	});

	it('データ不足（2本以下）は空を返す', () => {
		const result = checkPriceAnomalies(makeCandles(2), 3);
		expect(result.anomalyCount).toBe(0);
		expect(result.stats).toBeNull();
	});
});

describe('checkVolumeAnomalies', () => {
	it('正常なデータは異常値ゼロ', () => {
		const candles = makeCandles(20);
		const result = checkVolumeAnomalies(candles, 10);
		expect(result.anomalyCount).toBe(0);
	});

	it('出来高ゼロを検出する', () => {
		const candles = makeCandles(10);
		candles[3] = { ...candles[3], volume: 0 };
		candles[7] = { ...candles[7], volume: 0 };
		const result = checkVolumeAnomalies(candles, 10);
		expect(result.zeroCount).toBe(2);
	});

	it('出来高スパイクを検出する', () => {
		const candles = makeCandles(20);
		// 平均の50倍のスパイク
		candles[10] = { ...candles[10], volume: 10000 };
		const result = checkVolumeAnomalies(candles, 10);
		expect(result.spikeCount).toBeGreaterThan(0);
		expect(result.anomalies.some((a) => a.reason === 'spike')).toBe(true);
	});

	it('空配列は空を返す', () => {
		const result = checkVolumeAnomalies([], 10);
		expect(result.totalBars).toBe(0);
		expect(result.stats).toBeNull();
	});
});

describe('computeQualityScore', () => {
	it('完全なデータは score 100, grade A', () => {
		const score = computeQualityScore(
			{ expected: 100, actual: 100, missing: 0, missingTimestamps: [], ratio: 1 },
			{ totalChecked: 100, invalidCount: 0, issues: [] },
			{ totalBars: 100, anomalyCount: 0, anomalies: [], stats: null },
			{ totalBars: 100, anomalyCount: 0, zeroCount: 0, spikeCount: 0, anomalies: [], stats: null },
		);
		expect(score.score).toBe(100);
		expect(score.grade).toBe('A');
	});

	it('欠損が多いと completeness が下がる', () => {
		const score = computeQualityScore(
			{ expected: 100, actual: 50, missing: 50, missingTimestamps: [], ratio: 0.5 },
			{ totalChecked: 50, invalidCount: 0, issues: [] },
			{ totalBars: 50, anomalyCount: 0, anomalies: [], stats: null },
			{ totalBars: 50, anomalyCount: 0, zeroCount: 0, spikeCount: 0, anomalies: [], stats: null },
		);
		expect(score.breakdown.completeness).toBe(15); // 0.5 * 30
		expect(score.score).toBeLessThan(100);
	});

	it('全項目で問題があると grade F', () => {
		const score = computeQualityScore(
			{ expected: 100, actual: 20, missing: 80, missingTimestamps: [], ratio: 0.2 },
			{ totalChecked: 20, invalidCount: 10, issues: [] },
			{ totalBars: 20, anomalyCount: 10, anomalies: [], stats: null },
			{ totalBars: 20, anomalyCount: 15, zeroCount: 10, spikeCount: 5, anomalies: [], stats: null },
		);
		expect(score.grade).toBe('F');
	});

	it('zeroVolumePenaltyWeight=0 なら出来高ゼロは減点されない', () => {
		const score = computeQualityScore(
			{ expected: 100, actual: 100, missing: 0, missingTimestamps: [], ratio: 1 },
			{ totalChecked: 100, invalidCount: 0, issues: [] },
			{ totalBars: 100, anomalyCount: 0, anomalies: [], stats: null },
			{ totalBars: 100, anomalyCount: 50, zeroCount: 50, spikeCount: 0, anomalies: [], stats: null },
			0, // minor ペア: ゼロ減点なし
		);
		expect(score.breakdown.volumeHealth).toBe(20); // フルスコア
	});

	it('zeroVolumePenaltyWeight=0.5 なら出来高ゼロの減点が半分', () => {
		const score = computeQualityScore(
			{ expected: 100, actual: 100, missing: 0, missingTimestamps: [], ratio: 1 },
			{ totalChecked: 100, invalidCount: 0, issues: [] },
			{ totalBars: 100, anomalyCount: 0, anomalies: [], stats: null },
			{ totalBars: 100, anomalyCount: 50, zeroCount: 50, spikeCount: 0, anomalies: [], stats: null },
			0.5, // mid ペア
		);
		// zeroRatio=0.5, weight=0.5 → 実効ペナルティ=0.25 → (1-0.25)*20=15
		expect(score.breakdown.volumeHealth).toBe(15);
	});
});

describe('classifyPairTier', () => {
	it('btc_jpy / eth_jpy / xrp_jpy は major', () => {
		expect(classifyPairTier('btc_jpy')).toBe('major');
		expect(classifyPairTier('eth_jpy')).toBe('major');
		expect(classifyPairTier('xrp_jpy')).toBe('major');
	});

	it('doge_jpy / sol_jpy は mid', () => {
		expect(classifyPairTier('doge_jpy')).toBe('mid');
		expect(classifyPairTier('sol_jpy')).toBe('mid');
	});

	it('grt_jpy / mona_jpy は minor', () => {
		expect(classifyPairTier('grt_jpy')).toBe('minor');
		expect(classifyPairTier('mona_jpy')).toBe('minor');
	});

	it('大文字でも正しく判定する', () => {
		expect(classifyPairTier('BTC_JPY')).toBe('major');
	});
});

describe('getTierDefaults', () => {
	it('major は厳しめの閾値を返す', () => {
		const d = getTierDefaults('major');
		expect(d.zeroVolumePenaltyWeight).toBe(1);
		expect(d.priceSigma).toBeLessThanOrEqual(4);
	});

	it('minor はゼロ出来高を減点しない', () => {
		const d = getTierDefaults('minor');
		expect(d.zeroVolumePenaltyWeight).toBe(0);
		expect(d.priceSigma).toBeGreaterThanOrEqual(5);
		expect(d.volumeMultiplier).toBeGreaterThanOrEqual(50);
	});
});
