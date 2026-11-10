// helpers.ts に置くと structural.ts への依存が wedge / triangle 側にまで入るので、別ファイルにしている。
import { EPSILON } from '../../lib/math.js';
import { clamp01, relDev } from './regression.js';
import { RETRACEMENT_MAX, RETRACEMENT_MIN, type ReversalSide } from './structural.js';
import type { PatternScoreBreakdown } from './types.js';

// 物差しは strict の許容幅。relaxed で拾った候補は、緩めた分だけ 0 に寄る（#422）。
export function levelMarginScore(points: readonly number[], strictTolerancePct: number): number {
	const devs: number[] = [];
	for (let i = 0; i < points.length; i++) {
		for (let j = i + 1; j < points.length; j++) devs.push(relDev(points[i], points[j]));
	}
	const avg = devs.length > 0 ? devs.reduce((sum, v) => sum + v, 0) / devs.length : 0;
	return clamp01(1 - avg / Math.max(EPSILON, strictTolerancePct));
}

// 大きいほど良く上限の無い量（ATR 倍率・点数）。ゲートちょうど = 0、ゲートの 2 倍 = 0.5。
export function marginOverGate(measured: number, gate: number): number {
	if (!(measured > EPSILON)) return 0;
	return clamp01(1 - gate / measured);
}

// 小さいほど良い量（収束比・水平側の傾き）。0 = 1、ゲートちょうど = 0。
export function marginUnderGate(measured: number, gate: number): number {
	return clamp01(1 - Math.abs(measured) / Math.max(EPSILON, gate));
}

// 上限が 1 の量（R²・幅の安定度）。ゲートちょうど = 0、1 = 1。
export function marginToOne(measured: number, gate: number): number {
	return clamp01((measured - gate) / Math.max(EPSILON, 1 - gate));
}

// 2 点の回帰線は R² が 1 に張り付き、当てはまりを測れていないので平均から外す。
export function lineFitScore(lines: ReadonlyArray<{ r2: number; points: number }>, minR2: number): number | undefined {
	const scores = lines.filter((l) => l.points >= 3).map((l) => marginToOne(l.r2, minR2));
	return averageDefinedAxes(scores);
}

export function retracementScore(ratio: number | undefined): number | undefined {
	if (ratio === undefined || !Number.isFinite(ratio)) return undefined;
	const center = (RETRACEMENT_MIN + RETRACEMENT_MAX) / 2;
	const halfWidth = (RETRACEMENT_MAX - RETRACEMENT_MIN) / 2;
	if (halfWidth <= 0) return undefined;
	return clamp01(1 - Math.abs(ratio - center) / halfWidth);
}

export function breakoutQualityScore(
	necklinePrice: number,
	breakoutClose: number,
	patternHeight: number,
	side: ReversalSide,
): number | undefined {
	if (!Number.isFinite(breakoutClose) || !(patternHeight > EPSILON)) return undefined;
	const excess = side === 'bottom' ? breakoutClose - necklinePrice : necklinePrice - breakoutClose;
	return clamp01(excess / patternHeight);
}

// undefined の軸は平均から外す。0 として混ぜると「測れなかった」が「悪い」に化ける。
export function averageDefinedAxes(values: Array<number | undefined>): number | undefined {
	const defined = values.filter((v): v is number => v !== undefined);
	if (defined.length === 0) return undefined;
	return defined.reduce((sum, v) => sum + v, 0) / defined.length;
}

export function roundAxes(axes: PatternScoreBreakdown): PatternScoreBreakdown {
	const out: PatternScoreBreakdown = {};
	for (const [key, value] of Object.entries(axes) as Array<[keyof PatternScoreBreakdown, number | undefined]>) {
		if (value !== undefined) out[key] = Number(value.toFixed(4));
	}
	return out;
}
