import { describe, expect, it } from 'vitest';
import { getDefaultParamsForTf } from '../../tools/patterns/config.js';
import {
	assessScanWindow,
	buildScanWindowWarning,
	extractScanWindowWarnings,
	SCAN_WINDOW_WARNING_TYPE,
} from '../../tools/patterns/scan-window.js';

/** 時間足の既定パラメータでの判定（実際の detect_patterns と同じ解決経路）。 */
function warnWithDefaults(tf: string, bars: number) {
	const { swingDepth, minBarsBetweenSwings } = getDefaultParamsForTf(tf);
	return buildScanWindowWarning({ type: tf, bars, swingDepth, minBarsBetweenSwings });
}

describe('assessScanWindow', () => {
	it('ピボット候補は前後 swingDepth 本を除いた本数になる', () => {
		const a = assessScanWindow(20, 6, 4);
		expect(a.pivotCandidateBars).toBe(20 - 6 * 2);
		// minBarsBetweenSwings(4) より double 検出の下限(5)が大きいので 5 が採られる
		expect(a.pivotGapBars).toBe(5);
		expect(a.requiredPivotCandidateBars).toBe(11);
		expect(a.minViableLimit).toBe(23);
		expect(a.sufficient).toBe(false);
	});

	it('minBarsBetweenSwings が double の下限を上回る場合はそちらを採る', () => {
		const a = assessScanWindow(100, 8, 6);
		expect(a.pivotGapBars).toBe(6);
		expect(a.requiredPivotCandidateBars).toBe(13);
		expect(a.minViableLimit).toBe(8 * 2 + 13);
	});

	it('minViableLimit ちょうどで足り、1 本足りないと不足になる（off-by-one）', () => {
		const min = assessScanWindow(0, 6, 4).minViableLimit;
		expect(assessScanWindow(min, 6, 4).sufficient).toBe(true);
		expect(assessScanWindow(min - 1, 6, 4).sufficient).toBe(false);
	});

	it('bars=0 / 1 本でも例外にならずピボット候補 0 本に畳む', () => {
		expect(assessScanWindow(0, 6, 4).pivotCandidateBars).toBe(0);
		expect(assessScanWindow(1, 6, 4).pivotCandidateBars).toBe(0);
		expect(assessScanWindow(0, 6, 4).sufficient).toBe(false);
	});

	it('NaN / 負値は安全側（0 本・最小間隔 5 本）に畳む', () => {
		const a = assessScanWindow(Number.NaN, Number.NaN, Number.NaN);
		expect(a.bars).toBe(0);
		expect(a.pivotCandidateBars).toBe(0);
		expect(a.pivotGapBars).toBe(5);
		expect(assessScanWindow(-10, -3, -1).pivotCandidateBars).toBe(0);
	});
});

describe('buildScanWindowWarning', () => {
	it('日足 limit=20（スキーマ下限）では警告を出す — 崖そのもの', () => {
		const w = warnWithDefaults('1day', 20);
		expect(w).not.toBeNull();
		expect(w?.type).toBe(SCAN_WINDOW_WARNING_TYPE);
		expect(w?.suggestedParams).toEqual({ limit: 23 });
		expect(w?.message).toContain('日足');
		expect(w?.message).toContain('limit≥23');
	});

	it('日足 limit=23（推奨下限）では警告を出さない', () => {
		expect(warnWithDefaults('1day', 23)).toBeNull();
	});

	it('既定 limit=90 ではどの時間足でも警告を出さない', () => {
		const tfs = ['1min', '5min', '15min', '30min', '1hour', '4hour', '8hour', '12hour', '1day', '1week', '1month'];
		for (const tf of tfs) {
			expect(warnWithDefaults(tf, 90), tf).toBeNull();
		}
	});

	it('swingDepth が小さい時間足は limit=20 でも警告を出さない（1hour）', () => {
		expect(warnWithDefaults('1hour', 20)).toBeNull();
	});

	it('swingDepth が大きい時間足は limit=20 で警告を出す（1week / 1month）', () => {
		expect(warnWithDefaults('1week', 20)?.suggestedParams).toEqual({ limit: 25 });
		expect(warnWithDefaults('1month', 20)?.suggestedParams).toEqual({ limit: 29 });
	});

	it('bars=0 では警告を出さない（データ不足は insufficient data 側の責務）', () => {
		expect(buildScanWindowWarning({ type: '1day', bars: 0, swingDepth: 6, minBarsBetweenSwings: 4 })).toBeNull();
	});

	it('limit が十分でも swingDepth を大きくすると警告が出る', () => {
		const w = buildScanWindowWarning({ type: '1day', bars: 30, swingDepth: 10, minBarsBetweenSwings: 4 });
		expect(w).not.toBeNull();
		expect(w?.suggestedParams).toEqual({ limit: 31 });
	});
});

describe('extractScanWindowWarnings', () => {
	it('該当 type のメッセージだけを取り出す', () => {
		const warnings = [
			{ type: 'low_detection_count', message: '検出数が少ないです' },
			{ type: SCAN_WINDOW_WARNING_TYPE, message: '窓が狭い' },
		];
		expect(extractScanWindowWarnings(warnings)).toEqual(['窓が狭い']);
	});

	it('空配列 / undefined / null では空配列を返す', () => {
		expect(extractScanWindowWarnings([])).toEqual([]);
		expect(extractScanWindowWarnings(undefined)).toEqual([]);
		expect(extractScanWindowWarnings(null)).toEqual([]);
	});

	it('message が空の要素は落とす', () => {
		expect(extractScanWindowWarnings([{ type: SCAN_WINDOW_WARNING_TYPE, message: '' }])).toEqual([]);
	});
});
