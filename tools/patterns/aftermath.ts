import { avg as avgRaw, median as medianRaw } from '../../lib/math.js';
import { roundPriceAtLevel } from '../../lib/price.js';
import type { AftermathResult, CandleData, PatternEntry } from './types.js';

export function necklineValue(p: PatternEntry, idx: number): number | null {
	const nl = Array.isArray(p?.neckline) && p.neckline.length === 2 ? p.neckline : null;
	if (!nl) return null;
	const [a, b] = nl;
	if (Number.isFinite(a?.x) && Number.isFinite(b?.x) && Number.isFinite(a?.y) && Number.isFinite(b?.y)) {
		const x1 = Number(a.x),
			y1 = Number(a.y),
			x2 = Number(b.x),
			y2 = Number(b.y);
		if (x2 !== x1) {
			const t = (idx - x1) / (x2 - x1);
			return y1 + (y2 - y1) * Math.max(0, Math.min(1, t));
		}
		return y1;
	}
	return Number.isFinite(a?.y) ? Number(a.y) : Number.isFinite(b?.y) ? Number(b.y) : null;
}

const BULLISH_TYPES = [
	'double_bottom',
	'inverse_head_and_shoulders',
	'triangle_ascending',
	'triangle_symmetrical',
	'bull_flag',
	'bull_pennant',
];
const BEARISH_TYPES = ['double_top', 'head_and_shoulders', 'triangle_descending', 'bear_flag', 'bear_pennant'];

export function analyzeAftermath(
	p: PatternEntry,
	candles: CandleData[],
	isoToIndex: Map<string, number>,
): AftermathResult | null {
	try {
		const endIso = p?.range?.end;
		const endIdx = isoToIndex.has(String(endIso)) ? (isoToIndex.get(String(endIso)) as number) : -1;
		if (endIdx < 0) return null;
		const baseClose = Number(candles[endIdx]?.close ?? NaN);
		if (!Number.isFinite(baseClose)) return null;
		const nlAtEnd = necklineValue(p, endIdx);
		const pType = String(p?.type);
		const bullish = BULLISH_TYPES.includes(pType);
		const bearish = BEARISH_TYPES.includes(pType);
		if (!Number.isFinite(nlAtEnd as number)) return null;
		let breakoutConfirmed = false;
		let breakoutDate: string | undefined;
		let daysToTarget: number | null = null;
		const breakoutBuffer = 0.015;
		for (let i = endIdx + 1; i < Math.min(candles.length, endIdx + 30); i++) {
			const nl = necklineValue(p, i) ?? (nlAtEnd as number);
			const c = Number(candles[i]?.close ?? NaN);
			if (!Number.isFinite(c) || !Number.isFinite(nl)) continue;
			if ((bullish && c > nl * (1 + breakoutBuffer)) || (bearish && c < nl * (1 - breakoutBuffer))) {
				breakoutConfirmed = true;
				breakoutDate = candles[i]?.isoTime;
				break;
			}
		}
		const horizon = [3, 7, 14];
		const priceMove: Record<string, { return: number; high: number; low: number }> = {};
		for (const h of horizon) {
			const to = Math.min(candles.length - 1, endIdx + h);
			if (to <= endIdx) continue;
			let hi = -Infinity,
				lo = Infinity;
			for (let i = endIdx + 1; i <= to; i++) {
				hi = Math.max(hi, Number(candles[i]?.high ?? -Infinity));
				lo = Math.min(lo, Number(candles[i]?.low ?? Infinity));
			}
			const closeTo = Number(candles[to]?.close ?? NaN);
			if (!Number.isFinite(closeTo)) continue;
			const ret = ((closeTo - baseClose) / baseClose) * 100;
			priceMove[`days${h}`] = {
				return: Number(ret.toFixed(2)),
				high: roundPriceAtLevel(hi, baseClose),
				low: roundPriceAtLevel(lo, baseClose),
			};
		}
		let theoreticalTarget = NaN;
		const nl = nlAtEnd as number;
		const pivotPrices = Array.isArray(p?.pivots)
			? p.pivots.map((x: { price?: number }) => Number(x?.price)).filter((x: number) => Number.isFinite(x))
			: [];
		if (bullish && pivotPrices.length) {
			const patternLow = Math.min(...pivotPrices);
			theoreticalTarget = nl + (nl - patternLow);
		} else if (bearish && pivotPrices.length) {
			const patternHigh = Math.max(...pivotPrices);
			theoreticalTarget = nl - (patternHigh - nl);
		}
		let targetReached = false;
		if (Number.isFinite(theoreticalTarget)) {
			for (let i = endIdx + 1; i <= Math.min(candles.length - 1, endIdx + 14); i++) {
				const hiVal = Number(candles[i]?.high ?? NaN);
				const loVal = Number(candles[i]?.low ?? NaN);
				if (bullish && Number.isFinite(hiVal) && hiVal >= theoreticalTarget) {
					targetReached = true;
					daysToTarget = i - endIdx;
					break;
				}
				if (bearish && Number.isFinite(loVal) && loVal <= theoreticalTarget) {
					targetReached = true;
					daysToTarget = i - endIdx;
					break;
				}
			}
		}
		function outcomeMessage(): string {
			if (!breakoutConfirmed) return 'ネックライン未突破（パターン不発）';
			if (targetReached) return '成功（理論目標価格到達）';
			const r3 = priceMove?.days3?.return;
			const r7 = priceMove?.days7?.return;
			const r14 = priceMove?.days14?.return;
			const arr = [r3, r7, r14].filter((v: unknown) => typeof v === 'number') as number[];
			if (!arr.length) return '評価不可（事後データ不足）';
			const best = arr.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0);
			const expected = bullish ? 1 : -1;
			const actual = best > 0 ? 1 : -1;
			if (expected === actual && Math.abs(best) > 3)
				return `部分成功（ブレイクアウト後${best > 0 ? '+' : ''}${best.toFixed(1)}%、目標未達）`;
			if (expected !== actual && Math.abs(best) > 3)
				return `失敗（ブレイクアウト後、期待と逆方向に${best > 0 ? '+' : ''}${best.toFixed(1)}%）`;
			return `失敗（ブレイクアウト後、値動き僅少: ${best > 0 ? '+' : ''}${best.toFixed(1)}%）`;
		}
		const outcome = outcomeMessage();
		return {
			breakoutDate,
			breakoutConfirmed,
			priceMove,
			targetReached,
			theoreticalTarget: Number.isFinite(theoreticalTarget) ? roundPriceAtLevel(theoreticalTarget, nl) : null,
			outcome,
			daysToTarget,
		};
	} catch {
		return null;
	}
}

export function buildStatistics(
	patterns: PatternEntry[],
	candles: CandleData[],
): { statistics: Record<string, unknown>; isoToIndex: Map<string, number> } {
	const isoToIndex = new Map<string, number>();
	for (let i = 0; i < candles.length; i++) {
		const t = candles[i]?.isoTime;
		if (t) isoToIndex.set(String(t), i);
	}
	const stats: Record<
		string,
		{ detected: number; withAftermath: number; success: number; r7: number[]; r14: number[] }
	> = {};
	for (const p of patterns) {
		const a = analyzeAftermath(p, candles, isoToIndex);
		if (a) p.aftermath = a;
		const t = String(p.type);
		if (!stats[t]) stats[t] = { detected: 0, withAftermath: 0, success: 0, r7: [], r14: [] };
		stats[t].detected += 1;
		if (a) {
			stats[t].withAftermath += 1;
			if (a.outcome === 'success') stats[t].success += 1;
			const r7 = a?.priceMove?.days7?.return;
			if (typeof r7 === 'number') stats[t].r7.push(r7);
			const r14 = a?.priceMove?.days14?.return;
			if (typeof r14 === 'number') stats[t].r14.push(r14);
		}
	}

	const avg = (arr: number[]) => {
		const v = avgRaw(arr);
		return v != null ? Number(v.toFixed(2)) : null;
	};
	const med = (arr: number[]) => {
		const v = medianRaw(arr);
		return v != null ? Number(v.toFixed(2)) : null;
	};

	const statistics: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(stats)) {
		statistics[k] = {
			detected: v.detected,
			withAftermath: v.withAftermath,
			successRate: v.withAftermath ? Number((v.success / v.withAftermath).toFixed(2)) : null,
			avgReturn7d: avg(v.r7),
			avgReturn14d: avg(v.r14),
			medianReturn7d: med(v.r7),
		};
	}
	return { statistics, isoToIndex };
}
