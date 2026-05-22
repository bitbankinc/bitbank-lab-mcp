import { calendarDateFromIso, dayjs } from './datetime.js';

export type MaPrefix = 'SMA' | 'EMA';

/** Slope detection threshold (0.2% deadband) */
export const SLOPE_THRESHOLD = 0.002;
/** Lookback window for recent cross detection */
export const CROSS_LOOKBACK = 30;

// ── Shared interfaces ──

export interface MaLineEntry {
	period: number;
	value: number | null;
	distancePct: number | null;
	distanceAbs: number | null;
	slope: 'rising' | 'falling' | 'flat';
	slopePctPerBar: number | null;
	pricePosition?: 'above' | 'below' | 'equal';
}

export interface CrossStatus {
	a: string;
	b: string;
	type: 'golden' | 'dead';
	delta: number;
}

export interface RecentCrossEntry {
	type: 'golden_cross' | 'dead_cross';
	pair: [number, number];
	barsAgo: number;
	date: string;
}

export interface MaExtEntry {
	value: number | null;
	distancePct: number | null;
	distanceAbs: number | null;
	slope: 'rising' | 'falling' | 'flat';
	slopePctPerBar: number | null;
	slopePctTotal: number | null;
	barsWindow: number | null;
	slopePctPerDay?: number | null;
	pricePosition?: 'above' | 'below' | 'equal';
}

// ── Shared functions ──

export function slopeOfSeries(series: Array<number | null>): 'rising' | 'falling' | 'flat' {
	const n = series.length;
	if (n < 6) return 'flat';
	let curIdx = n - 1;
	while (curIdx >= 0 && series[curIdx] == null) curIdx--;
	let prevIdx = curIdx - 5;
	while (prevIdx >= 0 && series[prevIdx] == null) prevIdx--;
	if (curIdx < 0 || prevIdx < 0) return 'flat';
	const cur = series[curIdx] as number;
	const prev = series[prevIdx] as number;
	if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return 'flat';
	const pct = (cur - prev) / Math.abs(prev);
	if (pct > SLOPE_THRESHOLD) return 'rising';
	if (pct < -SLOPE_THRESHOLD) return 'falling';
	return 'flat';
}

export function computeSlopeRates(series: Array<number | null>): {
	pctTotal: number | null;
	pctPerBar: number | null;
	barsWindow: number | null;
} {
	const n = series.length;
	if (n < 6) return { pctTotal: null, pctPerBar: null, barsWindow: null };
	let curIdx = n - 1;
	while (curIdx >= 0 && series[curIdx] == null) curIdx--;
	let prevIdx = curIdx - 5;
	while (prevIdx >= 0 && series[prevIdx] == null) prevIdx--;
	if (curIdx < 0 || prevIdx < 0) return { pctTotal: null, pctPerBar: null, barsWindow: null };
	const cur = series[curIdx] as number;
	const prev = series[prevIdx] as number;
	const bars = curIdx - prevIdx;
	if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0 || bars <= 0)
		return { pctTotal: null, pctPerBar: null, barsWindow: null };
	const pctTotal = ((cur - prev) / Math.abs(prev)) * 100;
	const pctPerBar = pctTotal / bars;
	return { pctTotal, pctPerBar, barsWindow: bars };
}

export function generateCrossPairs(periods: number[]): Array<[number, number]> {
	const uniquePeriods = [...new Set(periods)];
	const pairs: Array<[number, number]> = [];
	for (let i = 0; i < uniquePeriods.length; i++) {
		for (let j = i + 1; j < uniquePeriods.length; j++) {
			pairs.push([uniquePeriods[i], uniquePeriods[j]]);
		}
	}
	return pairs;
}

export function detectCrossStatuses(
	crossPairs: Array<[number, number]>,
	map: Record<string, number | null>,
	prefix: MaPrefix,
): CrossStatus[] {
	const crosses: CrossStatus[] = [];
	for (const [a, b] of crossPairs) {
		const va = map[`${prefix}_${a}`];
		const vb = map[`${prefix}_${b}`];
		if (va != null && vb != null) {
			const delta = (va as number) - (vb as number);
			crosses.push({
				a: `${prefix}_${a}`,
				b: `${prefix}_${b}`,
				type: delta >= 0 ? 'golden' : 'dead',
				delta: Number(delta.toFixed(2)),
			});
		}
	}
	return crosses;
}

export function detectRecentCrosses(
	crossPairs: Array<[number, number]>,
	chartInd: Record<string, unknown>,
	candles: Array<{ isoTime?: string | null }>,
	prefix: MaPrefix,
): RecentCrossEntry[] {
	const recentCrosses: RecentCrossEntry[] = [];
	for (const [a, b] of crossPairs) {
		const sa: Array<number | null> = Array.isArray(chartInd?.[`${prefix}_${a}`])
			? (chartInd[`${prefix}_${a}`] as Array<number | null>)
			: [];
		const sb: Array<number | null> = Array.isArray(chartInd?.[`${prefix}_${b}`])
			? (chartInd[`${prefix}_${b}`] as Array<number | null>)
			: [];
		const n = Math.min(sa.length, sb.length, candles.length);
		if (n < 2) continue;
		const start = Math.max(1, n - CROSS_LOOKBACK);
		for (let i = start; i < n; i++) {
			const prevA = sa[i - 1];
			const prevB = sb[i - 1];
			const curA = sa[i];
			const curB = sb[i];
			if (prevA == null || prevB == null || curA == null || curB == null) continue;
			const prev = prevA - prevB;
			const curr = curA - curB;
			if ((prev <= 0 && curr > 0) || (prev >= 0 && curr < 0)) {
				const type = curr > 0 ? 'golden_cross' : 'dead_cross';
				const barsAgo = n - 1 - i;
				const date = calendarDateFromIso(candles[i]?.isoTime) ?? dayjs().tz('Asia/Tokyo').format('YYYY-MM-DD');
				recentCrosses.push({ type, pair: [a, b], barsAgo, date });
			}
		}
	}
	return recentCrosses;
}

export function detectAlignment(
	sortedVals: (number | null)[],
	opts: { minPeriods: number; strict: boolean },
): 'bullish' | 'bearish' | 'mixed' | 'unknown' {
	if (sortedVals.length < opts.minPeriods) return 'unknown';
	if (!sortedVals.every((v) => v != null)) return 'unknown';
	const nums = sortedVals as number[];
	const allDesc = opts.strict
		? nums.every((v, i) => i === 0 || v < nums[i - 1])
		: nums.every((v, i) => i === 0 || v <= nums[i - 1]);
	const allAsc = opts.strict
		? nums.every((v, i) => i === 0 || v > nums[i - 1])
		: nums.every((v, i) => i === 0 || v >= nums[i - 1]);
	if (allDesc) return 'bullish';
	if (allAsc) return 'bearish';
	return 'mixed';
}

export function detectPosition(
	close: number | null,
	maVals: number[],
): 'above_all' | 'below_all' | 'between' | 'unknown' {
	if (close == null || maVals.length === 0) return 'unknown';
	const minV = Math.min(...maVals);
	const maxV = Math.max(...maVals);
	if (close > maxV) return 'above_all';
	if (close < minV) return 'below_all';
	return 'between';
}

export function getSeries(chartInd: Record<string, unknown>, prefix: MaPrefix, period: number): Array<number | null> {
	const key = `${prefix}_${period}`;
	return Array.isArray(chartInd?.[key]) ? (chartInd[key] as Array<number | null>) : [];
}

export function computeMaExt(
	close: number | null,
	val: number | null,
	series: Array<number | null>,
	type: string,
): MaExtEntry {
	const distancePct =
		close != null && val != null && val !== 0 ? Number((((close - val) / val) * 100).toFixed(2)) : null;
	const distanceAbs = close != null && val != null ? Number((close - val).toFixed(2)) : null;
	const slope = slopeOfSeries(series);
	const rates = computeSlopeRates(series);
	const slopePctPerBar = rates.pctPerBar != null ? Number(rates.pctPerBar.toFixed(3)) : null;
	const slopePctTotal = rates.pctTotal != null ? Number(rates.pctTotal.toFixed(2)) : null;
	const barsWindow = rates.barsWindow;
	const entry: MaExtEntry = { value: val, distancePct, distanceAbs, slope, slopePctPerBar, slopePctTotal, barsWindow };
	if (type === '1day') entry.slopePctPerDay = slopePctPerBar;
	if (close != null && val != null) entry.pricePosition = close > val ? 'above' : close < val ? 'below' : 'equal';
	return entry;
}

export function buildMaLines(periods: number[], maExt: Record<string, MaExtEntry>): MaLineEntry[] {
	const topPeriods = Array.from(new Set(periods)).sort((a, b) => a - b);
	return topPeriods.map((p) => {
		const it = maExt[String(p)];
		return {
			period: p,
			value: it?.value ?? null,
			distancePct: it?.distancePct ?? null,
			distanceAbs: it?.distanceAbs ?? null,
			slope: it?.slope ?? 'flat',
			slopePctPerBar: it?.slopePctPerBar ?? null,
			pricePosition: it?.pricePosition,
		};
	});
}

export interface BuildMaSnapshotTextInput {
	baseSummary: string;
	type: string;
	prefix: MaPrefix;
	maLines: MaLineEntry[];
	crossStatuses: CrossStatus[];
	recentCrosses: RecentCrossEntry[];
	footerLines: string[];
}

export function buildMaSnapshotText(input: BuildMaSnapshotTextInput): string {
	const { baseSummary, type, prefix, maLines, crossStatuses, recentCrosses, footerLines } = input;
	const distanceLines = maLines.map((it) => {
		const valStr = it.value != null ? it.value : 'n/a';
		const pctStr = it.distancePct != null ? `${it.distancePct >= 0 ? '+' : ''}${it.distancePct}%` : 'n/a';
		const absStr =
			it.distanceAbs != null
				? `${it.distanceAbs >= 0 ? '+' : ''}${Number(it.distanceAbs).toLocaleString('ja-JP')}円`
				: 'n/a';
		const slopeRate =
			it.slopePctPerBar != null
				? `${it.slopePctPerBar >= 0 ? '+' : ''}${it.slopePctPerBar}%/${type === '1day' ? 'day' : 'bar'}`
				: null;
		const pos = it.pricePosition
			? it.pricePosition === 'above'
				? '（価格は上）'
				: it.pricePosition === 'below'
					? '（価格は下）'
					: '（同水準）'
			: '';
		return `${prefix}(${it.period}): ${valStr} (${pctStr}, ${absStr}) slope=${it.slope}${slopeRate ? ` (${slopeRate})` : ''}${pos}`;
	});
	const crossStatusLines = crossStatuses.map((c) => `${c.a}/${c.b}: ${c.type} (delta:${c.delta})`);
	const allRecentLines = recentCrosses.map(
		(rc) => `${rc.type} ${rc.pair.join('/')} - ${rc.barsAgo} bars ago (${rc.date})`,
	);
	return [
		baseSummary,
		'',
		...distanceLines,
		...(crossStatusLines.length ? ['', 'Cross Status:', ...crossStatusLines] : []),
		...(allRecentLines.length ? ['', 'Recent Crosses (all):', ...allRecentLines] : []),
		'',
		'---',
		...footerLines,
	]
		.filter(Boolean)
		.join('\n');
}
