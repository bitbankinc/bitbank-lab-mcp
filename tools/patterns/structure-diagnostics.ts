import { formatPctFromRatio } from '../../lib/formatter.js';
import { levelSpreadMetrics } from './structural.js';
import type { Pivot } from './swing.js';

export type StructureGateSkip = 'no_prior_extreme' | 'insufficient_history';

export function formatStructureGateSkipLine(skipped: StructureGateSkip | undefined): string | null {
	if (!skipped) return null;
	const reason =
		skipped === 'no_prior_extreme' ? '窓の先頭のため未評価' : '交差確認に必要な履歴が不足しているため未評価';
	return `   - 先行値幅: ${reason}`;
}

export function formatTriplePositionLines(type: string | undefined, pivots: Pivot[] | undefined): string[] {
	const side = type === 'triple_top' ? 'top' : type === 'triple_bottom' ? 'bottom' : null;
	if (!side || !Array.isArray(pivots) || (pivots.length !== 4 && pivots.length !== 5)) return [];
	const necklinePoints = [pivots[1], pivots[3]];
	if (!necklinePoints[0] || !necklinePoints[1]) return [];
	const necklinePrice = (Number(necklinePoints[0].price) + Number(necklinePoints[1].price)) / 2;
	if (!Number.isFinite(necklinePrice)) return [];
	const mainIndices = pivots.length === 5 ? [0, 2, 4] : [0, 2];
	const mainPoints = mainIndices.map((index) => pivots[index]).filter((point): point is Pivot => Boolean(point));
	if (mainPoints.length !== mainIndices.length) return [];
	const { heightAbs } = levelSpreadMetrics(mainPoints, pivots);
	if (heightAbs === null || !(heightAbs > 0)) return [];
	const label = side === 'top' ? '山' : '谷';
	return mainPoints.flatMap((point, i) => {
		const close = Number(point.price);
		const extreme = Number(point.extremePrice);
		if (!Number.isFinite(close) || !Number.isFinite(extreme)) return [];
		const gapByPrice = (close - necklinePrice) / heightAbs;
		const wickShare = side === 'top' ? (extreme - close) / heightAbs : (close - extreme) / heightAbs;
		const sign = gapByPrice > 0 ? '+' : '';
		return `   - ${label}${i + 1} の位置: 終値はネックラインの ${sign}${formatPctFromRatio(gapByPrice)}（パターン高さ比）/ ヒゲ ${formatPctFromRatio(wickShare)}`;
	});
}
