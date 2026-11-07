import { describe, expect, it } from 'vitest';
import { barsPerDay, deduplicatePatterns, finalizeConf, globalDedup } from '../../tools/patterns/helpers.js';
import type { CandleData, DeduplicablePattern, TrendLine } from '../../tools/patterns/types.js';
import {
	calcAlternationScoreEx,
	calcApex,
	checkContainment,
	checkConvergenceEx,
	detectWedgeBreak,
	determineWedgeType,
	evaluateTouchesEx,
	generateWindows,
	WEDGE_MAX_CONVERGENCE,
} from '../../tools/patterns/wedge-helpers.js';

function makeTrendLine(slope: number, intercept: number): TrendLine {
	return { slope, intercept, valueAt: (x: number) => slope * x + intercept };
}

function makeCandles(count: number, basePrice: number = 100): CandleData[] {
	return Array.from({ length: count }, (_, i) => ({
		open: basePrice + i,
		close: basePrice + i,
		high: basePrice + i + 2,
		low: basePrice + i - 2,
		isoTime: `2024-01-${String(i + 1).padStart(2, '0')}`,
	}));
}

describe('generateWindows', () => {
	it('正しいウィンドウを生成する', () => {
		const windows = generateWindows(20, 5, 10, 5);
		expect(windows.length).toBeGreaterThan(0);
		for (const w of windows) {
			expect(w.endIdx - w.startIdx).toBeGreaterThanOrEqual(5);
			expect(w.endIdx - w.startIdx).toBeLessThanOrEqual(10);
			expect(w.endIdx).toBeLessThan(20);
		}
	});

	it('totalBars が minSize 未満なら空を返す', () => {
		const windows = generateWindows(3, 5, 10, 5);
		expect(windows).toEqual([]);
	});
});

describe('determineWedgeType', () => {
	it('両ライン上向き・下側が急 → rising_wedge', () => {
		const result = determineWedgeType(0.001, 0.002, { slopeRatioMinRising: 1.2 });
		expect(result).toBe('rising_wedge');
	});

	it('両ライン下向き・上側が急 → falling_wedge', () => {
		const result = determineWedgeType(-0.003, -0.001, { slopeRatioMinFalling: 1.15 });
		expect(result).toBe('falling_wedge');
	});

	it('傾きが小さすぎる場合は null', () => {
		const result = determineWedgeType(0.00001, 0.00002, {});
		expect(result).toBeNull();
	});

	it('比率が 0.9-1.1 の範囲内（ほぼ平行）は null', () => {
		const result = determineWedgeType(0.001, -0.001, {});
		expect(result).toBeNull();
	});
});

describe('calcApex', () => {
	it('収束するトレンドラインの Apex を計算', () => {
		const upper = makeTrendLine(-0.5, 200); // 下降ライン
		const lower = makeTrendLine(0.5, 100); // 上昇ライン
		const result = calcApex(upper, lower, 50);
		expect(result.apexIdx).toBe(100); // (100-200) / (-0.5-0.5) = 100
		expect(result.isValid).toBe(true);
		expect(result.barsToApex).toBe(50);
	});

	it('平行ラインの場合は Infinity', () => {
		const upper = makeTrendLine(1, 200);
		const lower = makeTrendLine(1, 100);
		const result = calcApex(upper, lower, 50);
		expect(result.apexIdx).toBe(Infinity);
		expect(result.isValid).toBe(false);
	});

	it('Apex が過去にある場合は isValid=false', () => {
		const upper = makeTrendLine(-0.5, 200);
		const lower = makeTrendLine(0.5, 100);
		const result = calcApex(upper, lower, 150);
		expect(result.isValid).toBe(false);
	});
});

describe('checkContainment', () => {
	it('全て境界内なら ratio=1', () => {
		const candles = makeCandles(10, 100);
		const upper = { valueAt: () => 200 };
		const lower = { valueAt: () => 0 };
		const result = checkContainment(candles, upper, lower, 0, 9);
		expect(result.closeInsideRatio).toBe(1);
		expect(result.violations).toBe(0);
	});

	it('全て境界外なら ratio=0', () => {
		const candles = makeCandles(10, 100);
		const upper = { valueAt: () => 50 };
		const lower = { valueAt: () => 40 };
		const result = checkContainment(candles, upper, lower, 0, 9);
		expect(result.closeInsideRatio).toBe(0);
		expect(result.violations).toBe(10);
	});
});

describe('checkConvergenceEx', () => {
	it('収束するラインで isConverging=true', () => {
		const upper = makeTrendLine(-1, 200);
		const lower = makeTrendLine(0.5, 50);
		const result = checkConvergenceEx(upper, lower, 0, 80);
		expect(result.isConverging).toBe(true);
		expect(result.ratio).toBeCloseTo(30 / 150, 10);
	});

	it('収束比がゲートちょうどなら isConverging=false', () => {
		const upper = makeTrendLine(-0.3, 110);
		const lower = makeTrendLine(0, 100);
		const result = checkConvergenceEx(upper, lower, 0, 10);
		expect(result.ratio).toBeCloseTo(WEDGE_MAX_CONVERGENCE, 10);
		expect(result.isConverging).toBe(false);
	});

	it('発散するラインで isConverging=false', () => {
		const upper = makeTrendLine(2, 200);
		const lower = makeTrendLine(-1, 50);
		const result = checkConvergenceEx(upper, lower, 0, 50);
		expect(result.isConverging).toBe(false);
	});
});

describe('evaluateTouchesEx', () => {
	it('タッチポイントを検出する', () => {
		const candles: readonly CandleData[] = Array.from({ length: 20 }, (_, i) => ({
			open: 100,
			close: 100,
			high: 110 - i * 0.4,
			low: 90 + i * 0.4,
		}));
		const upper = { valueAt: (x: number) => 110 - x * 0.4 };
		const lower = { valueAt: (x: number) => 90 + x * 0.4 };
		const result = evaluateTouchesEx(candles, upper, lower, 0, 19);
		expect(result.upperTouches.length).toBeGreaterThanOrEqual(0);
		expect(result.lowerTouches.length).toBeGreaterThanOrEqual(0);
		expect(result.upperQuality).toBe(result.upperTouches.filter((t) => !t.isBreak).length);
		expect(result.lowerQuality).toBe(result.lowerTouches.filter((t) => !t.isBreak).length);
	});
});

describe('calcAlternationScoreEx', () => {
	it('完全に交互なら 1', () => {
		const touches = {
			upperTouches: [
				{ index: 0, distance: 0, isBreak: false },
				{ index: 4, distance: 0, isBreak: false },
			],
			lowerTouches: [
				{ index: 2, distance: 0, isBreak: false },
				{ index: 6, distance: 0, isBreak: false },
			],
			upperQuality: 2,
			lowerQuality: 2,
		};
		expect(calcAlternationScoreEx(touches)).toBe(1);
	});

	it('全て同じ方向なら 0', () => {
		const touches = {
			upperTouches: [
				{ index: 0, distance: 0, isBreak: false },
				{ index: 1, distance: 0, isBreak: false },
				{ index: 2, distance: 0, isBreak: false },
			],
			lowerTouches: [],
			upperQuality: 3,
			lowerQuality: 0,
		};
		expect(calcAlternationScoreEx(touches)).toBe(0);
	});

	it('タッチが1つ以下なら 0', () => {
		const touches = {
			upperTouches: [{ index: 0, distance: 0, isBreak: false }],
			lowerTouches: [],
			upperQuality: 1,
			lowerQuality: 0,
		};
		expect(calcAlternationScoreEx(touches)).toBe(0);
	});
});

describe('finalizeConf', () => {
	it('種別ごとの補正を掛けず、小数 2 桁に丸めるだけ（#422）', () => {
		expect(finalizeConf(0.8)).toBe(0.8);
		expect(finalizeConf(0.8149)).toBe(0.81);
		expect(finalizeConf(0.815)).toBe(0.82);
	});

	it('1 を超えない', () => {
		expect(finalizeConf(1.3)).toBe(1);
	});

	it('0 未満にならない', () => {
		expect(finalizeConf(-0.2)).toBe(0);
	});
});

describe('detectWedgeBreak', () => {
	it('ブレイクがない場合は detected=false', () => {
		const candles = makeCandles(50, 100);
		const upper = { valueAt: () => 200 };
		const lower = { valueAt: () => 0 };
		const result = detectWedgeBreak(candles, 'falling_wedge', upper, lower, 0, 30, 49, 10);
		expect(result.detected).toBe(false);
		expect(result.breakIdx).toBe(-1);
	});

	it('上方ブレイクを検出する', () => {
		const candles: CandleData[] = Array.from({ length: 60 }, (_, i) => ({
			open: 100,
			close: i >= 40 ? 250 : 100,
			high: i >= 40 ? 260 : 110,
			low: 90,
			isoTime: `2024-01-${String(i + 1).padStart(2, '0')}`,
		}));
		const upper = { valueAt: () => 120 };
		const lower = { valueAt: () => 80 };
		const result = detectWedgeBreak(candles, 'falling_wedge', upper, lower, 0, 50, 59, 5);
		expect(result.detected).toBe(true);
		expect(result.breakIdx).toBe(51);
		expect(result.breakPrice).toBeGreaterThan(120);
	});

	it('形成終端以前の境界外終値を過去のブレイクとして検出しない', () => {
		const candles: CandleData[] = Array.from({ length: 60 }, (_, i) => ({
			open: 100,
			close: i === 40 ? 250 : 100,
			high: i === 40 ? 260 : 110,
			low: 90,
			isoTime: `2024-01-${String(i + 1).padStart(2, '0')}`,
		}));
		const upper = { valueAt: () => 120 };
		const lower = { valueAt: () => 80 };
		const result = detectWedgeBreak(candles, 'falling_wedge', upper, lower, 0, 50, 59, 5);
		expect(result.detected).toBe(false);
		expect(result.breakIdx).toBe(-1);
	});
});

describe('deduplicatePatterns', () => {
	it('重複しないパターンはそのまま返す', () => {
		const patterns = [
			{ type: 'double_top', confidence: 0.8, range: { start: '2024-01-01', end: '2024-01-10' } },
			{ type: 'double_bottom', confidence: 0.7, range: { start: '2024-02-01', end: '2024-02-10' } },
		];
		expect(deduplicatePatterns(patterns)).toHaveLength(2);
	});

	it('同種・重複期間のパターンは confidence が高い方を残す', () => {
		const patterns = [
			{ type: 'double_top', confidence: 0.6, range: { start: '2024-01-01', end: '2024-01-10' } },
			{ type: 'double_top', confidence: 0.9, range: { start: '2024-01-02', end: '2024-01-12' } },
		];
		const result = deduplicatePatterns(patterns);
		expect(result).toHaveLength(1);
		expect(result[0].confidence).toBe(0.9);
	});

	it('type や range がない場合はそのまま追加', () => {
		const patterns = [{ foo: 'bar' }, { type: 'double_top' }];
		expect(deduplicatePatterns(patterns)).toHaveLength(2);
	});

	it('空配列は空を返す', () => {
		expect(deduplicatePatterns([])).toEqual([]);
	});

	// range.end は形成中では常に最新足なので、status より前に比較すると形成中が完成済みを構造的に必ず押し出す（issue #133）。

	it('形成中が range.end も confidence も上回っていても、完成済み（status 未設定）が勝つ', () => {
		const completed: DeduplicablePattern = {
			type: 'double_bottom',
			confidence: 0.96,
			range: { start: '2024-01-01', end: '2024-01-10' },
		};
		const forming: DeduplicablePattern = {
			type: 'double_bottom',
			confidence: 1.0,
			status: 'forming',
			range: { start: '2024-01-01', end: '2024-01-15' },
		};
		const result = deduplicatePatterns([completed, forming]);
		expect(result).toHaveLength(1);
		expect(result[0].status).toBeUndefined();
		expect(result[0].confidence).toBe(0.96);
	});

	it('status=completed は status 未設定（完成済み扱い）より優先される', () => {
		const explicit: DeduplicablePattern = {
			type: 'triangle_ascending',
			confidence: 0.7,
			status: 'completed',
			range: { start: '2024-01-01', end: '2024-01-10' },
		};
		const unset: DeduplicablePattern = {
			type: 'triangle_ascending',
			confidence: 0.9,
			range: { start: '2024-01-01', end: '2024-01-15' },
		};
		const result = deduplicatePatterns([explicit, unset]);
		expect(result).toHaveLength(1);
		expect(result[0].status).toBe('completed');
	});

	it('invalid は range.end が新しくても完成済みに負ける', () => {
		const completed: DeduplicablePattern = {
			type: 'double_top',
			confidence: 0.8,
			range: { start: '2024-01-01', end: '2024-01-10' },
		};
		const invalid: DeduplicablePattern = {
			type: 'double_top',
			confidence: 0.9,
			status: 'invalid',
			range: { start: '2024-01-01', end: '2024-01-15' },
		};
		const result = deduplicatePatterns([completed, invalid]);
		expect(result).toHaveLength(1);
		expect(result[0].status).toBeUndefined();
	});

	// issue #142: 同 status 内の順序は confidence → range.end。`globalDedup` と同じ。
	it('同 status どうしでは confidence が高いほうが勝つ（range.end が古くても）', () => {
		const older: DeduplicablePattern = {
			type: 'double_top',
			confidence: 0.9,
			status: 'forming',
			range: { start: '2024-01-01', end: '2024-01-10' },
		};
		const newer: DeduplicablePattern = {
			type: 'double_top',
			confidence: 0.6,
			status: 'forming',
			range: { start: '2024-01-02', end: '2024-01-12' },
		};
		const result = deduplicatePatterns([older, newer]);
		expect(result).toHaveLength(1);
		expect(result[0].range?.end).toBe('2024-01-10');
		expect(result[0].confidence).toBe(0.9);
	});

	it('confidence が同点なら range.end が新しいほうが勝つ（#142 の入れ替えは同点では効かない）', () => {
		const older: DeduplicablePattern = {
			type: 'double_top',
			confidence: 0.8,
			status: 'forming',
			range: { start: '2024-01-01', end: '2024-01-10' },
		};
		const newer: DeduplicablePattern = {
			type: 'double_top',
			confidence: 0.8,
			status: 'forming',
			range: { start: '2024-01-02', end: '2024-01-12' },
		};
		const result = deduplicatePatterns([older, newer]);
		expect(result).toHaveLength(1);
		expect(result[0].range?.end).toBe('2024-01-12');
	});

	it('形成中は confidence が高くても完成済みに勝てない（statusScore が最優先のまま）', () => {
		const completed: DeduplicablePattern = {
			type: 'double_top',
			confidence: 0.6,
			status: 'completed',
			range: { start: '2024-01-01', end: '2024-01-10' },
		};
		const forming: DeduplicablePattern = {
			type: 'double_top',
			confidence: 1.0,
			status: 'forming',
			range: { start: '2024-01-02', end: '2024-01-12' },
		};
		const result = deduplicatePatterns([completed, forming]);
		expect(result).toHaveLength(1);
		expect(result[0].status).toBe('completed');
		expect(result[0].confidence).toBe(0.6);
	});
});

describe('globalDedup', () => {
	it('異なるカテゴリのパターンは残す', () => {
		const patterns = [
			{ type: 'double_top', confidence: 0.8, range: { start: '2024-01-01', end: '2024-01-10' } },
			{ type: 'rising_wedge', confidence: 0.7, range: { start: '2024-01-01', end: '2024-01-10' } },
		];
		expect(globalDedup(patterns)).toHaveLength(2);
	});

	it('同カテゴリで重複する場合は confidence が高い方を残す', () => {
		const patterns = [
			{ type: 'rising_wedge', confidence: 0.6, range: { start: '2024-01-01', end: '2024-01-10' } },
			{ type: 'falling_wedge', confidence: 0.9, range: { start: '2024-01-01', end: '2024-01-10' } },
		];
		const result = globalDedup(patterns);
		expect(result).toHaveLength(1);
		expect(result[0].confidence).toBe(0.9);
	});

	it('空配列は空を返す', () => {
		expect(globalDedup([])).toEqual([]);
	});

	// rankPatterns と同じ規則（statusScore → confidence → range.end）。

	it('形成中（confidence 1.00・range.end 最新）は完成済み（status 未設定・0.96）を押し出せない', () => {
		const completed: DeduplicablePattern = {
			type: 'double_bottom',
			confidence: 0.96,
			range: { start: '2026-08-03', end: '2026-08-19' },
		};
		const forming: DeduplicablePattern = {
			type: 'double_bottom',
			confidence: 1.0,
			status: 'forming',
			range: { start: '2026-08-03', end: '2026-08-26' },
		};
		// 入力順に依存しないこと（既存が完成済みでも形成中でも同じ勝者）
		for (const input of [
			[completed, forming],
			[forming, completed],
		]) {
			const result = globalDedup(input);
			expect(result).toHaveLength(1);
			expect(result[0].status).toBeUndefined();
			expect(result[0].confidence).toBe(0.96);
		}
	});

	it('status=completed は confidence が低くても status 未設定（完成済み扱い）に勝つ', () => {
		const explicit: DeduplicablePattern = {
			type: 'rising_wedge',
			confidence: 0.6,
			status: 'completed',
			range: { start: '2024-01-01', end: '2024-01-10' },
		};
		const unset: DeduplicablePattern = {
			type: 'rising_wedge',
			confidence: 0.9,
			range: { start: '2024-01-01', end: '2024-01-10' },
		};
		const result = globalDedup([explicit, unset]);
		expect(result).toHaveLength(1);
		expect(result[0].status).toBe('completed');
	});

	it('invalid は confidence が高くても完成済みに負ける', () => {
		const completed: DeduplicablePattern = {
			type: 'triangle_ascending',
			confidence: 0.7,
			status: 'completed',
			range: { start: '2024-01-01', end: '2024-01-10' },
		};
		const invalid: DeduplicablePattern = {
			type: 'triangle_descending',
			confidence: 0.95,
			status: 'invalid',
			range: { start: '2024-01-01', end: '2024-01-10' },
		};
		const result = globalDedup([completed, invalid]);
		expect(result).toHaveLength(1);
		expect(result[0].status).toBe('completed');
	});

	it('同 status どうしでは従来どおり confidence → range.end の順で選ぶ', () => {
		const lowConf: DeduplicablePattern = {
			type: 'rising_wedge',
			confidence: 0.6,
			status: 'forming',
			range: { start: '2024-01-01', end: '2024-01-15' },
		};
		const highConf: DeduplicablePattern = {
			type: 'rising_wedge',
			confidence: 0.9,
			status: 'forming',
			range: { start: '2024-01-01', end: '2024-01-10' },
		};
		const result = globalDedup([lowConf, highConf]);
		expect(result).toHaveLength(1);
		expect(result[0].confidence).toBe(0.9);
	});
});

describe('barsPerDay', () => {
	it('1day は 1 を返す', () => {
		expect(barsPerDay('1day')).toBe(1);
	});

	it('intraday は 1 日あたりのバー数を返す', () => {
		expect(barsPerDay('1hour')).toBe(24);
		expect(barsPerDay('4hour')).toBe(6);
		expect(barsPerDay('15min')).toBe(96);
		expect(barsPerDay('1min')).toBe(1440);
	});

	it('1week / 1month は 1 未満を返す', () => {
		expect(barsPerDay('1week')).toBeCloseTo(1 / 7, 10);
		expect(barsPerDay('1month')).toBeCloseTo(1 / 30, 10);
	});

	it('未知の time frame は 1 にフォールバック', () => {
		expect(barsPerDay('unknown' as string)).toBe(1);
	});
});
