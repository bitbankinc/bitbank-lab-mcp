// 月は 1 始まり（Date.UTC と違う）。
export function jstMs(y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0): number {
	return Date.UTC(y, m - 1, d, h - 9, min, s, ms);
}

export function utcDayMs(isoDate: string): number {
	const [y, m, d] = isoDate.split('-').map(Number);
	return Date.UTC(y, m - 1, d);
}
