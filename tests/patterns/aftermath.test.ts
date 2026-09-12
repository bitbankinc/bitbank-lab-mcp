import { describe, expect, it } from 'vitest';
import { analyzeAftermath, buildStatistics, necklineValue } from '../../tools/patterns/aftermath.js';
import type { CandleData, PatternEntry } from '../../tools/patterns/types.js';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------
function makeCandles(count: number, base: number = 100, step: number = 1): CandleData[] {
	return Array.from({ length: count }, (_, i) => ({
		open: base + i * step,
		close: base + i * step,
		high: base + i * step + 5,
		low: base + i * step - 5,
		isoTime: `2024-01-${String(i + 1).padStart(2, '0')}`,
	}));
}

function makeIsoIndex(candles: CandleData[]): Map<string, number> {
	const m = new Map<string, number>();
	for (let i = 0; i < candles.length; i++) {
		const t = candles[i]?.isoTime;
		if (t) m.set(t, i);
	}
	return m;
}

// ---------------------------------------------------------------------------
// necklineValue
// ---------------------------------------------------------------------------
describe('necklineValue', () => {
	it('ネックラインが2点あれば補間する', () => {
		const p: PatternEntry = {
			neckline: [
				{ x: 0, y: 100 },
				{ x: 10, y: 110 },
			],
		};
		expect(necklineValue(p, 5)).toBeCloseTo(105, 5);
	});

	it('x が同じ場合は y1 を返す', () => {
		const p: PatternEntry = {
			neckline: [
				{ x: 5, y: 100 },
				{ x: 5, y: 110 },
			],
		};
		expect(necklineValue(p, 5)).toBe(100);
	});

	it('ネックラインがない場合は null', () => {
		expect(necklineValue({}, 5)).toBeNull();
	});

	it('ネックラインが1点の場合は null', () => {
		const p: PatternEntry = {
			neckline: [{ x: 0, y: 100 }],
		};
		expect(necklineValue(p, 5)).toBeNull();
	});

	it('x なしの場合は y 値を返す', () => {
		const p: PatternEntry = {
			neckline: [{ y: 100 }, { y: 110 }],
		};
		// x が未定義なので Number.isFinite(undefined) = false → フォールバック
		const result = necklineValue(p, 5);
		expect(result).toBe(100);
	});

	it('idx がクランプされる（0-1 の範囲内に補間）', () => {
		const p: PatternEntry = {
			neckline: [
				{ x: 0, y: 100 },
				{ x: 10, y: 200 },
			],
		};
		// idx=20 → t=2.0 → clamp to 1 → y=200
		expect(necklineValue(p, 20)).toBeCloseTo(200, 5);
		// idx=-5 → t=-0.5 → clamp to 0 → y=100
		expect(necklineValue(p, -5)).toBeCloseTo(100, 5);
	});
});

// ---------------------------------------------------------------------------
// analyzeAftermath
// ---------------------------------------------------------------------------
describe('analyzeAftermath', () => {
	it('endIso が見つからない場合は null', () => {
		const candles = makeCandles(10);
		const isoToIndex = makeIsoIndex(candles);
		const p: PatternEntry = {
			type: 'double_top',
			range: { start: '2024-01-01', end: '2099-01-01' },
			neckline: [
				{ x: 0, y: 100 },
				{ x: 10, y: 100 },
			],
		};
		expect(analyzeAftermath(p, candles, isoToIndex)).toBeNull();
	});

	it('ネックラインなしは null', () => {
		const candles = makeCandles(20);
		const isoToIndex = makeIsoIndex(candles);
		const p: PatternEntry = {
			type: 'double_top',
			range: { start: '2024-01-01', end: '2024-01-05' },
		};
		expect(analyzeAftermath(p, candles, isoToIndex)).toBeNull();
	});

	it('ブレイクアウト確認を検出する（bullish）', () => {
		// 上昇トレンドでネックライン突破
		const candles: CandleData[] = Array.from({ length: 30 }, (_, i) => ({
			open: 100,
			close: i > 10 ? 130 : 100, // endIdx後に急上昇
			high: i > 10 ? 135 : 105,
			low: i > 10 ? 125 : 95,
			isoTime: `2024-01-${String(i + 1).padStart(2, '0')}`,
		}));
		const isoToIndex = makeIsoIndex(candles);
		const p: PatternEntry = {
			type: 'double_bottom',
			range: { start: '2024-01-01', end: '2024-01-10' },
			neckline: [
				{ x: 0, y: 105 },
				{ x: 20, y: 105 },
			],
			pivots: [
				{ idx: 2, price: 90, kind: 'L', extremePrice: 90 },
				{ idx: 5, price: 110, kind: 'H', extremePrice: 110 },
				{ idx: 8, price: 90, kind: 'L', extremePrice: 90 },
			],
		};
		const result = analyzeAftermath(p, candles, isoToIndex);
		expect(result).not.toBeNull();
		expect(result?.breakoutConfirmed).toBe(true);
		expect(result?.breakoutDate).toBeDefined();
	});

	it('ブレイクアウト未確認の場合', () => {
		// ネックライン付近で横ばい
		const candles: CandleData[] = Array.from({ length: 30 }, (_, i) => ({
			open: 100,
			close: 100,
			high: 102,
			low: 98,
			isoTime: `2024-01-${String(i + 1).padStart(2, '0')}`,
		}));
		const isoToIndex = makeIsoIndex(candles);
		const p: PatternEntry = {
			type: 'double_bottom',
			range: { start: '2024-01-01', end: '2024-01-05' },
			neckline: [
				{ x: 0, y: 110 },
				{ x: 20, y: 110 },
			],
			pivots: [
				{ idx: 1, price: 90, kind: 'L', extremePrice: 90 },
				{ idx: 3, price: 100, kind: 'H', extremePrice: 100 },
			],
		};
		const result = analyzeAftermath(p, candles, isoToIndex);
		expect(result).not.toBeNull();
		expect(result?.breakoutConfirmed).toBe(false);
		expect(result?.outcome).toContain('未突破');
	});

	it('pennant は poleDirection で方向を判定', () => {
		const candles: CandleData[] = Array.from({ length: 30 }, (_, i) => ({
			open: 100,
			close: i > 10 ? 130 : 100,
			high: i > 10 ? 135 : 105,
			low: i > 10 ? 125 : 95,
			isoTime: `2024-01-${String(i + 1).padStart(2, '0')}`,
		}));
		const isoToIndex = makeIsoIndex(candles);
		const p: PatternEntry = {
			type: 'pennant',
			poleDirection: 'up',
			range: { start: '2024-01-01', end: '2024-01-10' },
			neckline: [
				{ x: 0, y: 105 },
				{ x: 20, y: 105 },
			],
			pivots: [{ idx: 5, price: 90, kind: 'L', extremePrice: 90 }],
		};
		const result = analyzeAftermath(p, candles, isoToIndex);
		expect(result).not.toBeNull();
		expect(result?.breakoutConfirmed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// buildStatistics
// ---------------------------------------------------------------------------
describe('buildStatistics', () => {
	it('パターンごとの統計を集計する', () => {
		const candles = makeCandles(30);
		const patterns: PatternEntry[] = [
			{
				type: 'double_top',
				range: { start: '2024-01-01', end: '2024-01-05' },
				neckline: [
					{ x: 0, y: 100 },
					{ x: 10, y: 100 },
				],
			},
			{
				type: 'double_bottom',
				range: { start: '2024-01-01', end: '2024-01-05' },
				neckline: [
					{ x: 0, y: 100 },
					{ x: 10, y: 100 },
				],
			},
		];
		const { statistics, isoToIndex } = buildStatistics(patterns, candles);
		expect(isoToIndex.size).toBe(30);
		expect(statistics).toHaveProperty('double_top');
		expect(statistics).toHaveProperty('double_bottom');
		const dt = statistics.double_top as { detected: number };
		expect(dt.detected).toBe(1);
	});

	it('空パターンの場合は空の統計', () => {
		const candles = makeCandles(10);
		const { statistics } = buildStatistics([], candles);
		expect(Object.keys(statistics)).toHaveLength(0);
	});

	it('aftermath を各パターンに付与する', () => {
		const candles = makeCandles(30);
		const patterns: PatternEntry[] = [
			{
				type: 'double_bottom',
				range: { start: '2024-01-01', end: '2024-01-05' },
				neckline: [
					{ x: 0, y: 100 },
					{ x: 10, y: 100 },
				],
				pivots: [{ idx: 2, price: 90, kind: 'L', extremePrice: 90 }],
			},
		];
		buildStatistics(patterns, candles);
		// aftermath が付与される（null の場合もある）
		expect('aftermath' in patterns[0]).toBe(true);
	});
});
