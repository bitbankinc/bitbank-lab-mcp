import { dayjs } from '../../lib/datetime.js';
import { trueRange } from '../../lib/indicators.js';
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

// double / H&S は暦日基準のまま。triple と違いこの軸が定数になっておらず、移すと confidence の分布が動く（#199）。
export function periodScoreDays(startIso?: string, endIso?: string): number {
	if (!startIso || !endIso) return 0.7;
	const d = Math.abs(dayjs(endIso).diff(dayjs(startIso), 'day', true));
	if (d < 5) return 0.6;
	if (d < 15) return 0.8;
	if (d < 30) return 0.9;
	return 0.7;
}

// 時間足に依らないバー数の境界。時間足別テーブルは #198 で事故になっている。
export const PERIOD_SCORE_BAR_BUCKETS = [12, 18, 26] as const;

// 暦日版の末尾の 0.7（表の外の中立値が裾に漏れたもの）は引き継がず、単調にする（#199）。
export function periodScoreBars(bars: number): number {
	if (!Number.isFinite(bars)) return 0.7;
	const [b1, b2, b3] = PERIOD_SCORE_BAR_BUCKETS;
	if (bars < b1) return 0.6;
	if (bars < b2) return 0.7;
	if (bars < b3) return 0.8;
	return 0.9;
}

export function finalizeConf(base: number, type: string): number {
	const adj =
		type === 'head_and_shoulders' || type === 'inverse_head_and_shoulders'
			? 1.1
			: type === 'triple_top' || type === 'triple_bottom'
				? 1.05
				: type.startsWith('triangle') ||
						type === 'bull_flag' ||
						type === 'bear_flag' ||
						type === 'bull_pennant' ||
						type === 'bear_pennant'
					? 0.95
					: 1.0;
	const v = Math.min(1, Math.max(0, base * adj));
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
