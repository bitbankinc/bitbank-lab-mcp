import { describe, expect, it } from 'vitest';
import {
	barsPerDay,
	calcAlternationScoreEx,
	calcApex,
	calcDurationScoreEx,
	calcInsideRatioEx,
	calculatePatternScoreEx,
	checkContainment,
	checkConvergenceEx,
	deduplicatePatterns,
	detectWedgeBreak,
	determineWedgeType,
	evaluateTouchesEx,
	finalizeConf,
	generateWindows,
	globalDedup,
	PERIOD_SCORE_BAR_BUCKETS,
	periodScoreBars,
	periodScoreDays,
} from '../../tools/patterns/helpers.js';
import type { CandleData, DeduplicablePattern, TrendLine } from '../../tools/patterns/types.js';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// generateWindows
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// determineWedgeType
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// calcApex
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// checkContainment
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// checkConvergenceEx
// ---------------------------------------------------------------------------
describe('checkConvergenceEx', () => {
	it('収束するラインで isConverging=true', () => {
		const upper = makeTrendLine(-1, 200);
		const lower = makeTrendLine(0.5, 50);
		const result = checkConvergenceEx(upper, lower, 0, 80);
		expect(result.isConverging).toBe(true);
		expect(result.score).toBeGreaterThan(0);
	});

	it('発散するラインで isConverging=false', () => {
		const upper = makeTrendLine(2, 200);
		const lower = makeTrendLine(-1, 50);
		const result = checkConvergenceEx(upper, lower, 0, 50);
		expect(result.isConverging).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// evaluateTouchesEx
// ---------------------------------------------------------------------------
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
		expect(result.score).toBeGreaterThanOrEqual(0);
		expect(result.score).toBeLessThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// calcAlternationScoreEx
// ---------------------------------------------------------------------------
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
			score: 0.5,
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
			score: 0.375,
		};
		expect(calcAlternationScoreEx(touches)).toBe(0);
	});

	it('タッチが1つ以下なら 0', () => {
		const touches = {
			upperTouches: [{ index: 0, distance: 0, isBreak: false }],
			lowerTouches: [],
			upperQuality: 1,
			lowerQuality: 0,
			score: 0.125,
		};
		expect(calcAlternationScoreEx(touches)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// calcInsideRatioEx
// ---------------------------------------------------------------------------
describe('calcInsideRatioEx', () => {
	it('全て内側なら 1', () => {
		const candles: readonly CandleData[] = [
			{ open: 100, close: 100, high: 105, low: 95 },
			{ open: 100, close: 100, high: 105, low: 95 },
		];
		const upper = { valueAt: () => 110 };
		const lower = { valueAt: () => 90 };
		expect(calcInsideRatioEx(candles, upper, lower, 0, 1)).toBe(1);
	});

	it('全て外側なら 0', () => {
		const candles: readonly CandleData[] = [{ open: 100, close: 100, high: 120, low: 80 }];
		const upper = { valueAt: () => 105 };
		const lower = { valueAt: () => 95 };
		expect(calcInsideRatioEx(candles, upper, lower, 0, 0)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// calcDurationScoreEx
// ---------------------------------------------------------------------------
describe('calcDurationScoreEx', () => {
	it('範囲内の中央値で最高スコア', () => {
		const score = calcDurationScoreEx(57, { windowSizeMin: 25, windowSizeMax: 90 });
		expect(score).toBeCloseTo(1, 1);
	});

	it('範囲外なら 0', () => {
		expect(calcDurationScoreEx(10, { windowSizeMin: 25, windowSizeMax: 90 })).toBe(0);
		expect(calcDurationScoreEx(100, { windowSizeMin: 25, windowSizeMax: 90 })).toBe(0);
	});

	it('デフォルトパラメータを使用', () => {
		const score = calcDurationScoreEx(57, {});
		expect(score).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// calculatePatternScoreEx
// ---------------------------------------------------------------------------
describe('calculatePatternScoreEx', () => {
	it('全コンポーネント=1 なら 1', () => {
		const components = {
			fitScore: 1,
			convergeScore: 1,
			touchScore: 1,
			alternationScore: 1,
			insideScore: 1,
			durationScore: 1,
		};
		expect(calculatePatternScoreEx(components)).toBeCloseTo(1, 5);
	});

	it('全コンポーネント=0 なら 0', () => {
		const components = {
			fitScore: 0,
			convergeScore: 0,
			touchScore: 0,
			alternationScore: 0,
			insideScore: 0,
			durationScore: 0,
		};
		expect(calculatePatternScoreEx(components)).toBe(0);
	});

	it('カスタム重みを使用可能', () => {
		const components = {
			fitScore: 1,
			convergeScore: 0,
			touchScore: 0,
			alternationScore: 0,
			insideScore: 0,
			durationScore: 0,
		};
		const weights = { fit: 1, converge: 0, touch: 0, alternation: 0, inside: 0, duration: 0 };
		expect(calculatePatternScoreEx(components, weights)).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// periodScoreDays
// ---------------------------------------------------------------------------
describe('periodScoreDays（暦日基準。double / H&S が使う）', () => {
	it('ISO文字列なしは 0.7', () => {
		expect(periodScoreDays()).toBe(0.7);
	});

	it('短期間は低スコア', () => {
		expect(periodScoreDays('2024-01-01', '2024-01-03')).toBe(0.6);
	});

	it('15-30日は高スコア', () => {
		expect(periodScoreDays('2024-01-01', '2024-01-20')).toBe(0.9);
	});

	// 30 日以上だけ 0.9 → 0.7 と下がる。**この非単調性は暦日版の仕様として固定する**
	// （バー数版には引き継いでいない。理由は periodScoreBars の docstring）。
	it('30日以上は 0.9 から 0.7 に下がる（非単調。引数なしと同じ中立値）', () => {
		expect(periodScoreDays('2024-01-01', '2024-02-05')).toBe(0.7);
		expect(periodScoreDays('2024-01-01', '2024-02-05')).toBe(periodScoreDays());
	});
});

// ---------------------------------------------------------------------------
// periodScoreBars（issue #199 候補 2。triple のみが使う）
// ---------------------------------------------------------------------------
describe('periodScoreBars（バー数基準。triple が使う）', () => {
	it('境界は 12 / 18 / 26 バー', () => {
		expect(PERIOD_SCORE_BAR_BUCKETS).toEqual([12, 18, 26]);
	});

	it.each([
		[0, 0.6],
		[11, 0.6],
		[12, 0.7],
		[17, 0.7],
		[18, 0.8],
		[25, 0.8],
		[26, 0.9],
		[1000, 0.9],
	])('%i バー → %f', (bars, expected) => {
		expect(periodScoreBars(bars)).toBe(expected);
	});

	// 暦日版と違い最長バケットで下がらない。ここが崩れると
	// 「由来不明の段差をバー空間に持ち込まない」という #199 候補 2 の判断が黙って戻る。
	it('単調非減少（暦日版の 0.9 → 0.7 の段差を引き継いでいない）', () => {
		const scores = Array.from({ length: 60 }, (_, bars) => periodScoreBars(bars));
		for (let i = 1; i < scores.length; i++) {
			expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
		}
		expect(Math.max(...scores)).toBe(0.9);
	});

	it('時間足に依らない（引数はバー数だけで tf を受け取らない）', () => {
		expect(periodScoreBars.length).toBe(1);
	});

	it('非有限値は中立値 0.7', () => {
		expect(periodScoreBars(Number.NaN)).toBe(0.7);
		expect(periodScoreBars(Number.POSITIVE_INFINITY)).toBe(0.7);
	});
});

// ---------------------------------------------------------------------------
// finalizeConf
// ---------------------------------------------------------------------------
describe('finalizeConf', () => {
	it('head_and_shoulders はボーナス（*1.1）', () => {
		const result = finalizeConf(0.8, 'head_and_shoulders');
		expect(result).toBeCloseTo(0.88, 2);
	});

	it('triple_top はボーナス（*1.05）', () => {
		const result = finalizeConf(0.8, 'triple_top');
		expect(result).toBeCloseTo(0.84, 2);
	});

	it('triangle はペナルティ（*0.95）', () => {
		const result = finalizeConf(0.8, 'triangle_ascending');
		expect(result).toBeCloseTo(0.76, 2);
	});

	it('1 を超えない', () => {
		expect(finalizeConf(1, 'head_and_shoulders')).toBeLessThanOrEqual(1);
	});

	it('0 未満にならない', () => {
		expect(finalizeConf(0, 'unknown')).toBeGreaterThanOrEqual(0);
	});
});

// ---------------------------------------------------------------------------
// detectWedgeBreak
// ---------------------------------------------------------------------------
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
		expect(result.breakPrice).toBeGreaterThan(120);
	});
});

// ---------------------------------------------------------------------------
// deduplicatePatterns
// ---------------------------------------------------------------------------
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

	// ── statusScore 最優先（issue #133）──
	// range.end は形成中では常に最新足なので、status より前に比較すると
	// 形成中が完成済みを構造的に必ず押し出す。statusScore（ranking.ts が単一ソース）を
	// 最優先し、同 status 内でのみ「新しいほうを採る」を適用する。

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
	// #135 までは range.end が先で、最も新しく終わる 1 つに絞り込んだ時点で confidence が
	// 一度も比較されなかった（= 広い窓の低品質候補が勝つ）。
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

	// #133 / PR #135 の不変条件。#142 の入れ替えは statusScore の**下**なので、
	// confidence をどれだけ高くしても形成中は完成済みを押し出せない。
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

// ---------------------------------------------------------------------------
// globalDedup
// ---------------------------------------------------------------------------
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

	// ── statusScore 最優先（issue #133）──
	// rankPatterns と同じ規則（statusScore → confidence → range.end）。
	// status を見ずに confidence を先に比べると、形成中（整合度 1.00 が付きやすい）が
	// 突破確定済みの完成済み（同 0.96）を押し出す——issue #133 の実データそのもの。

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

// ---------------------------------------------------------------------------
// barsPerDay
// ---------------------------------------------------------------------------
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
