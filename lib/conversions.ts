// "" は Number("") === 0 だが、意図しない 0 変換を防ぐため null にする。
export function toNum(v: unknown): number | null {
	if (v == null) return null;
	if (typeof v === 'string' && v.trim() === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}
