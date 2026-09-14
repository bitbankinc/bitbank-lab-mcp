/**
 * `tools/patterns/scoring.ts` — 反転パターンの confidence サブスコア軸。
 *
 * `retracementScore` / `breakoutQualityScore` は `detect_doubles.ts` の module-private 関数を
 * issue #199 候補 1 で共有モジュールへ切り出したもの。**切り出し時に定義を変えていない**ことを
 * 固定するためのテストなので、期待値は double の旧実装の式から導いてある。
 */
import { describe, expect, it } from 'vitest';
import { averageDefinedAxes, breakoutQualityScore, retracementScore } from '../../tools/patterns/scoring.js';
import { RETRACEMENT_MAX, RETRACEMENT_MIN } from '../../tools/patterns/structural.js';

describe('retracementScore', () => {
	const center = (RETRACEMENT_MIN + RETRACEMENT_MAX) / 2;

	it('undefined / 非有限値は undefined を返す（欠測を 0 にしない）', () => {
		expect(retracementScore(undefined)).toBeUndefined();
		expect(retracementScore(Number.NaN)).toBeUndefined();
		expect(retracementScore(Number.POSITIVE_INFINITY)).toBeUndefined();
	});

	it('許容帯の中央で 1', () => {
		expect(retracementScore(center)).toBeCloseTo(1, 10);
	});

	it('許容帯の両端で 0', () => {
		expect(retracementScore(RETRACEMENT_MIN)).toBeCloseTo(0, 10);
		expect(retracementScore(RETRACEMENT_MAX)).toBeCloseTo(0, 10);
	});

	it('帯の外は clamp01 で 0 に張り付く（帯の外は構造ゲートが先に弾く前提）', () => {
		expect(retracementScore(RETRACEMENT_MIN - 0.5)).toBe(0);
		expect(retracementScore(RETRACEMENT_MAX + 0.5)).toBe(0);
	});

	it('中央からの距離に対して線形（中央と端の中間で 0.5）', () => {
		const halfWidth = (RETRACEMENT_MAX - RETRACEMENT_MIN) / 2;
		expect(retracementScore(center + halfWidth / 2)).toBeCloseTo(0.5, 10);
		expect(retracementScore(center - halfWidth / 2)).toBeCloseTo(0.5, 10);
	});
});

describe('breakoutQualityScore', () => {
	it('突破足の終値が無い（NaN）なら undefined — 未ブレイクは欠測であって 0 ではない', () => {
		expect(breakoutQualityScore(100, Number.NaN, 20, 'top')).toBeUndefined();
	});

	it('パターン高さが 0 / 負なら undefined（0 除算を作らない）', () => {
		expect(breakoutQualityScore(100, 90, 0, 'top')).toBeUndefined();
		expect(breakoutQualityScore(100, 90, -10, 'top')).toBeUndefined();
	});

	it('top: ネックラインを高さの何割ぶん下抜けたか', () => {
		// 高さ 20 に対して 5 ぶん下抜け → 0.25
		expect(breakoutQualityScore(100, 95, 20, 'top')).toBeCloseTo(0.25, 10);
	});

	it('bottom: ネックラインを高さの何割ぶん上抜けたか', () => {
		expect(breakoutQualityScore(100, 105, 20, 'bottom')).toBeCloseTo(0.25, 10);
	});

	it('逆方向（超過が負）は 0 に clamp する', () => {
		expect(breakoutQualityScore(100, 105, 20, 'top')).toBe(0);
		expect(breakoutQualityScore(100, 95, 20, 'bottom')).toBe(0);
	});

	it('高さ以上に抜けても 1 で頭打ち', () => {
		expect(breakoutQualityScore(100, 70, 20, 'top')).toBe(1);
	});
});

describe('averageDefinedAxes', () => {
	it('空配列 / 全部 undefined は undefined', () => {
		expect(averageDefinedAxes([])).toBeUndefined();
		expect(averageDefinedAxes([undefined, undefined])).toBeUndefined();
	});

	it('undefined は分母からも外す（0 として混ぜない）', () => {
		// 0 として混ぜると (0.8 + 0.6 + 0) / 3 = 0.4667 になる
		expect(averageDefinedAxes([0.8, undefined, 0.6])).toBeCloseTo(0.7, 10);
	});

	it('単一要素はその値そのもの', () => {
		expect(averageDefinedAxes([undefined, 0.42, undefined])).toBeCloseTo(0.42, 10);
	});

	it('0 は欠測ではないので平均に含める', () => {
		expect(averageDefinedAxes([0, 1])).toBeCloseTo(0.5, 10);
	});
});
