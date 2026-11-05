// helpers.ts に置くと structural.ts への依存が wedge / triangle 側にまで入るので、別ファイルにしている。
import { EPSILON } from '../../lib/math.js';
import { clamp01 } from './regression.js';
import { RETRACEMENT_MAX, RETRACEMENT_MIN, type ReversalSide } from './structural.js';

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
