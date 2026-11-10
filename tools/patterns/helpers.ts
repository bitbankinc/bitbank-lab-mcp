import { trueRange } from '../../lib/indicators.js';
import { priceDecimals } from '../../lib/price.js';
import { statusScore } from './ranking.js';
import type { CandleData, DeduplicablePattern } from './types.js';

// 換算はバー数への一方向だけにする。プリミティブはバー数で、日数は値の由来を示すだけ（bar-thresholds.ts）。
export function barsPerDay(tf: string): number {
	switch (tf) {
		case '1min':
			return 1440;
		case '5min':
			return 288;
		case '15min':
			return 96;
		case '30min':
			return 48;
		case '1hour':
			return 24;
		case '4hour':
			return 6;
		case '8hour':
			return 3;
		case '12hour':
			return 2;
		case '1day':
			return 1;
		case '1week':
			return 1 / 7;
		case '1month':
			return 1 / 30;
		default:
			return 1;
	}
}

export function calcATR(candles: readonly CandleData[], from: number, to: number, period: number = 14): number {
	const start = Math.max(1, from);
	const end = Math.max(start + 1, to);
	const slice = candles.slice(start - 1, end + 1); // prevClose 用に 1 つ前を含める
	if (slice.length < 2) return 0;

	const highs = slice.map((c) => Number(c?.high ?? NaN));
	const lows = slice.map((c) => Number(c?.low ?? NaN));
	const closes = slice.map((c) => Number(c?.close ?? NaN));

	const tr = trueRange(highs, lows, closes);
	const validTr = tr.filter((v) => Number.isFinite(v));
	if (!validTr.length) return 0;
	const n = Math.min(period, validTr.length);
	const tail = validTr.slice(-n);
	return tail.reduce((s, v) => s + v, 0) / tail.length;
}

// 種別を越えて並べるので、種別ごとの補正は掛けない（#422）。
export function finalizeConf(base: number): number {
	const v = Math.min(1, Math.max(0, base));
	return Math.round(v * 100) / 100;
}

// 勝者は statusScore → confidence → range.end の新しさ → 高さの順で選ぶ（globalDedup とそろえている）。
// statusScore を先にしないと形成中が完成済みを押し出し（#133）、range.end を confidence より先にすると当てはまりの最も悪い解釈が勝つ（#142）。
export function deduplicatePatterns<T extends DeduplicablePattern>(arr: T[]): T[] {
	const result: T[] = [];
	for (const pattern of arr) {
		if (!pattern?.type || !pattern?.range?.start || !pattern?.range?.end) {
			result.push(pattern);
			continue;
		}
		const overlapping = result.filter((existing) => {
			if (existing?.type !== pattern.type) return false;
			const existingStart = Date.parse(existing.range?.start ?? '');
			const existingEnd = Date.parse(existing.range?.end ?? '');
			const patternStart = Date.parse(pattern.range?.start ?? '');
			const patternEnd = Date.parse(pattern.range?.end ?? '');
			if (
				!Number.isFinite(existingStart) ||
				!Number.isFinite(existingEnd) ||
				!Number.isFinite(patternStart) ||
				!Number.isFinite(patternEnd)
			)
				return false;
			const overlapStart = Math.max(existingStart, patternStart);
			const overlapEnd = Math.min(existingEnd, patternEnd);
			const overlapDuration = Math.max(0, overlapEnd - overlapStart);
			const existingDuration = Math.max(1, existingEnd - existingStart);
			const patternDuration = Math.max(1, patternEnd - patternStart);
			const minDuration = Math.min(existingDuration, patternDuration);
			return overlapDuration / minDuration > 0.5;
		});
		if (overlapping.length === 0) {
			result.push(pattern);
		} else {
			const allCandidates = [...overlapping, pattern];
			const getStatusScore = (p: DeduplicablePattern) => statusScore((p as { status?: string }).status);
			const maxStatusScore = Math.max(...allCandidates.map(getStatusScore));
			let best = allCandidates.filter((p) => getStatusScore(p) === maxStatusScore);
			if (best.length > 1) {
				const maxConfidence = Math.max(...best.map((p) => Number(p.confidence ?? 0)));
				best = best.filter((p) => Number(p.confidence ?? 0) === maxConfidence);
			}
			if (best.length > 1) {
				const maxEndTime = Math.max(...best.map((p) => Date.parse(p.range?.end ?? '')));
				best = best.filter((p) => Date.parse(p.range?.end ?? '') === maxEndTime);
			}
			if (best.length > 1) {
				const getHeight = (p: DeduplicablePattern) => {
					const piv = Array.isArray(p?.pivots) ? p.pivots : [];
					if (p?.type === 'double_top' && piv.length >= 3) {
						const peak = Math.max(Number(piv[0]?.price ?? 0), Number(piv[2]?.price ?? 0));
						const valley = Number(piv[1]?.price ?? peak);
						return Math.max(0, peak - valley);
					}
					if (p?.type === 'double_bottom' && piv.length >= 3) {
						const valley = Math.min(Number(piv[0]?.price ?? 0), Number(piv[2]?.price ?? 0));
						const peak = Number(piv[1]?.price ?? valley);
						return Math.max(0, peak - valley);
					}
					return 0;
				};
				const maxHeight = Math.max(...best.map(getHeight));
				best = best.filter((p) => getHeight(p) === maxHeight);
			}
			const winner = best[0];
			for (const dup of overlapping) {
				const idx = result.indexOf(dup);
				if (idx >= 0) result.splice(idx, 1);
			}
			result.push(winner);
		}
	}
	return result;
}

// 勝者は rankPatterns と同じく statusScore → confidence → range.end の新しさで選ぶ（#133）。
export function globalDedup(patterns: DeduplicablePattern[]): DeduplicablePattern[] {
	function toMs(iso?: string): number {
		try {
			const t = Date.parse(String(iso));
			return Number.isFinite(t) ? t : NaN;
		} catch {
			return NaN;
		}
	}
	function overlapRatio(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
		const as = toMs(aStart),
			ae = toMs(aEnd),
			bs = toMs(bStart),
			be = toMs(bEnd);
		if (!Number.isFinite(as) || !Number.isFinite(ae) || !Number.isFinite(bs) || !Number.isFinite(be)) return 0;
		const os = Math.max(as, bs);
		const oe = Math.min(ae, be);
		const ov = Math.max(0, oe - os);
		const ad = Math.max(1, ae - as);
		const bd = Math.max(1, be - bs);
		const minD = Math.min(ad, bd);
		return ov / minD;
	}

	// flag / pennant は入れない。bull と bear を 1 カテゴリに潰すと方向違いをマージしてしまう（detect_pennants.ts で方向別に dedup 済み）。
	const categoryMap: Record<string, string> = {
		rising_wedge: 'wedge',
		falling_wedge: 'wedge',
		triangle_ascending: 'triangle',
		triangle_descending: 'triangle',
		triangle_symmetrical: 'triangle',
	};
	function isSameCategory(a: string, b: string): boolean {
		if (a === b) return true;
		const ca = categoryMap[a];
		const cb = categoryMap[b];
		return !!(ca && cb && ca === cb);
	}

	const dedupThreshold = 0.7;
	const out: DeduplicablePattern[] = [];
	for (const p of patterns) {
		const pRange = { s: String(p?.range?.start), e: String(p?.range?.end ?? p?.range?.current) };
		const overlapIdx = out.findIndex(
			(q) =>
				isSameCategory(String(q?.type), String(p?.type)) &&
				overlapRatio(String(q?.range?.start), String(q?.range?.end ?? q?.range?.current), pRange.s, pRange.e) >=
					dedupThreshold,
		);
		if (overlapIdx < 0) {
			out.push(p);
		} else {
			const existing = out[overlapIdx];
			const eStatus = statusScore((existing as { status?: string }).status);
			const pStatus = statusScore((p as { status?: string }).status);
			if (pStatus > eStatus) {
				out[overlapIdx] = p;
			} else if (pStatus === eStatus) {
				const eConf = Number(existing?.confidence ?? 0);
				const pConf = Number(p?.confidence ?? 0);
				if (pConf > eConf) {
					out[overlapIdx] = p;
				} else if (pConf === eConf) {
					const eEnd = toMs(existing?.range?.end ?? existing?.range?.current);
					const pEnd = toMs(p?.range?.end ?? p?.range?.current);
					if (Number.isFinite(pEnd) && Number.isFinite(eEnd) && pEnd > eEnd) {
						out[overlapIdx] = p;
					}
				}
			}
		}
	}
	return out;
}

interface PricedPattern {
	pivots?: ReadonlyArray<{ price?: number }>;
	neckline?: ReadonlyArray<{ y?: number }>;
	breakout?: { price?: number } | null;
	confirmation?: object;
	breakoutTarget?: number;
	flagpoleHeight?: number;
}

// 応答の中の円表示の桁は、パターンに出てくる価格のうち最大のものの水準でそろえる。価格が 1 つも無い（未ブレイクの旗だけ）ときは値幅で代える。
export function patternPriceDecimals(patterns: ReadonlyArray<PricedPattern>): number {
	let level = 0;
	let heightLevel = 0;
	const take = (v: unknown) => {
		const n = Math.abs(Number(v));
		if (Number.isFinite(n) && n > level) level = n;
	};
	for (const p of patterns) {
		for (const pv of p.pivots ?? []) take(pv?.price);
		for (const pt of p.neckline ?? []) take(pt?.y);
		take(p.breakout?.price);
		take((p.confirmation as { price?: unknown } | undefined)?.price);
		take(p.breakoutTarget);
		const h = Math.abs(Number(p.flagpoleHeight));
		if (Number.isFinite(h) && h > heightLevel) heightLevel = h;
	}
	return priceDecimals(level > 0 ? level : heightLevel);
}
