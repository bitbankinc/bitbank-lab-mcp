import { avg as mathAvg, stddev } from './math.js';

export type DepthZone = { low: number; high: number; label: string; color?: string };

export type PriceSize = readonly [number, number];

/** 累積 volume 階段データ。[price, cumulativeVolume] */
export type CumulativeStep = [number, number];

// bids は高価格から、asks は低価格から（best から遠ざかる方向に）累積する。
export function buildCumulativeSteps(levels: ReadonlyArray<PriceSize>, side: 'bid' | 'ask'): CumulativeStep[] {
	if (!levels.length) return [];
	const sorted = [...levels].sort((a, b) => (side === 'bid' ? b[0] - a[0] : a[0] - b[0]));
	const out: CumulativeStep[] = [];
	let cum = 0;
	for (const [p, s] of sorted) {
		cum += s;
		out.push([p, cum]);
	}
	return out;
}

export function estimateZones(levels: ReadonlyArray<[number, number]>, side: 'bid' | 'ask'): DepthZone[] {
	if (!levels.length) return [];
	const qtys = levels.map(([, s]) => s);
	const avg = mathAvg(qtys) ?? 0;
	const stdev = stddev(qtys);
	const thr = avg + stdev * 2;
	const zones: DepthZone[] = [];
	for (const [p, s] of levels) {
		if (s >= thr) {
			const pad = p * 0.001; // 0.1%幅
			if (side === 'bid') zones.push({ low: p - pad, high: p + pad, label: 'bid wall', color: 'rgba(34,197,94,0.08)' });
			else zones.push({ low: p - pad, high: p + pad, label: 'ask wall', color: 'rgba(249,115,22,0.08)' });
		}
	}
	return zones.slice(0, 5); // 多すぎないように上位数本
}
