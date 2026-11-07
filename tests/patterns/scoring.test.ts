import { describe, expect, it } from 'vitest';
import {
	averageDefinedAxes,
	breakoutQualityScore,
	levelMarginScore,
	lineFitScore,
	marginOverGate,
	marginToOne,
	marginUnderGate,
	retracementScore,
	roundAxes,
} from '../../tools/patterns/scoring.js';
import { RETRACEMENT_MAX, RETRACEMENT_MIN } from '../../tools/patterns/structural.js';

describe('levelMarginScore', () => {
	it('主構成点が完全に一致すれば 1', () => {
		expect(levelMarginScore([100, 100], 0.04)).toBe(1);
	});

	it('ずれが strict の許容幅の半分なら 0.5', () => {
		// relDev(100, 98) = 2 / 100 = 0.02 = 0.04 の半分
		expect(levelMarginScore([100, 98], 0.04)).toBeCloseTo(0.5, 10);
	});

	it('許容幅ちょうど以上は 0（relaxed で拾った候補は 0 に寄る）', () => {
		expect(levelMarginScore([100, 96], 0.04)).toBeCloseTo(0, 10);
		expect(levelMarginScore([100, 94], 0.04)).toBe(0);
	});

	it('3 点は全ての組の relDev を平均して測る', () => {
		// relDev: (100, 99) = 0.01、(99, 98) = 1 / 99、(100, 98) = 0.02
		const avg = (0.01 + 1 / 99 + 0.02) / 3;
		expect(levelMarginScore([100, 99, 98], 0.04)).toBeCloseTo(1 - avg / 0.04, 10);
	});
});

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

describe('marginOverGate（大きいほど良い量）', () => {
	it('ゲートちょうどは 0、ゲートの 2 倍は 0.5、4 倍は 0.75', () => {
		expect(marginOverGate(2.5, 2.5)).toBe(0);
		expect(marginOverGate(5, 2.5)).toBeCloseTo(0.5, 10);
		expect(marginOverGate(10, 2.5)).toBeCloseTo(0.75, 10);
	});

	it('ゲート未満と 0 以下は 0', () => {
		expect(marginOverGate(2, 2.5)).toBe(0);
		expect(marginOverGate(0, 2.5)).toBe(0);
		expect(marginOverGate(-1, 2.5)).toBe(0);
	});
});

describe('marginUnderGate（小さいほど良い量）', () => {
	it('0 は 1、ゲートの半分は 0.5、ゲートちょうど以上は 0', () => {
		expect(marginUnderGate(0, 0.9)).toBe(1);
		expect(marginUnderGate(0.45, 0.9)).toBeCloseTo(0.5, 10);
		expect(marginUnderGate(0.9, 0.9)).toBe(0);
		expect(marginUnderGate(1.2, 0.9)).toBe(0);
	});

	it('傾きのように符号がある量は絶対値で測る', () => {
		expect(marginUnderGate(-0.015, 0.03)).toBeCloseTo(0.5, 10);
	});
});

describe('marginToOne（上限が 1 の量）', () => {
	it('ゲートちょうどは 0、1 は 1、中間は線形', () => {
		expect(marginToOne(0.6, 0.6)).toBe(0);
		expect(marginToOne(1, 0.6)).toBe(1);
		expect(marginToOne(0.8, 0.6)).toBeCloseTo(0.5, 10);
	});

	it('ゲート未満は 0', () => {
		expect(marginToOne(0.5, 0.6)).toBe(0);
	});
});

describe('lineFitScore', () => {
	it('線ごとの (R² − ゲート) ÷ (1 − ゲート) を平均する', () => {
		expect(
			lineFitScore(
				[
					{ r2: 0.8, points: 3 },
					{ r2: 1, points: 4 },
				],
				0.6,
			),
		).toBeCloseTo(0.75, 10);
	});

	it('2 点の線は R² が 1 に張り付くので外す', () => {
		expect(
			lineFitScore(
				[
					{ r2: 1, points: 2 },
					{ r2: 0.8, points: 3 },
				],
				0.6,
			),
		).toBeCloseTo(0.5, 10);
	});

	it('両方とも 2 点なら測れないので undefined', () => {
		expect(
			lineFitScore(
				[
					{ r2: 1, points: 2 },
					{ r2: 1, points: 2 },
				],
				0.6,
			),
		).toBeUndefined();
	});
});

describe('roundAxes', () => {
	it('undefined の軸は出さず、値は小数 4 桁に丸める', () => {
		expect(roundAxes({ lineFit: 0.123456, convergence: undefined, touches: 0.5 })).toEqual({
			lineFit: 0.1235,
			touches: 0.5,
		});
	});

	it('空なら空オブジェクト', () => {
		expect(roundAxes({})).toEqual({});
	});
});
