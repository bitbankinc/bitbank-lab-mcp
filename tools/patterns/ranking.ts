import type { DeduplicablePattern } from './types.js';

interface PatternWithStatus extends DeduplicablePattern {
	status?: string;
	confirmation?: { type?: string };
}

// status の優先度の単一ソース。deduplicatePatterns / globalDedup もこれを使うので、変更はここ 1 箇所で行う（#133）。
export function statusScore(status: string | undefined): number {
	if (status === 'completed') return 3;
	if (status === undefined) return 2;
	if (status === 'forming' || status === 'near_completion') return 1;
	return 0;
}

function confirmationScore(confirmation: { type?: string } | undefined): number {
	return confirmation?.type === 'neckline_breakout' ? 1 : 0;
}

function endTimeMs(p: PatternWithStatus): number {
	const end = p?.range?.end;
	if (!end) return 0;
	const t = Date.parse(String(end));
	return Number.isFinite(t) ? t : 0;
}

export function rankPatterns<T extends DeduplicablePattern>(patterns: readonly T[]): T[] {
	const indexed = patterns.map((p, i) => ({ p, i }));
	indexed.sort((a, b) => {
		const ap = a.p as PatternWithStatus;
		const bp = b.p as PatternWithStatus;

		const ss = statusScore(bp.status) - statusScore(ap.status);
		if (ss !== 0) return ss;

		const cs = confirmationScore(bp.confirmation) - confirmationScore(ap.confirmation);
		if (cs !== 0) return cs;

		const conf = Number(bp.confidence ?? 0) - Number(ap.confidence ?? 0);
		if (conf !== 0) return conf;

		const recency = endTimeMs(bp) - endTimeMs(ap);
		if (recency !== 0) return recency;

		return a.i - b.i;
	});
	return indexed.map((x) => x.p);
}
