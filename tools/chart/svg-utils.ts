export function niceTicks(min: number, max: number, count = 5): number[] {
	if (max < min) [min, max] = [max, min];
	const range = max - min;
	if (range === 0) return [min];

	const step = Math.max(1e-9, 10 ** Math.floor(Math.log10(range / count)));
	const err = (count * step) / range;

	let niceStep: number;
	if (err <= 0.15) niceStep = step * 10;
	else if (err <= 0.35) niceStep = step * 5;
	else if (err <= 0.75) niceStep = step * 2;
	else niceStep = step;

	const precision = Math.max(0, -Math.floor(Math.log10(niceStep)));
	const niceMin = Math.round(min / niceStep) * niceStep;
	const ticks: number[] = [];
	for (let v = niceMin; ticks.length < 20 && v <= max * 1.01; v += niceStep) {
		ticks.push(Number(v.toFixed(precision)));
	}

	return ticks;
}

export function formatYLabel(val: number, isJpyPair: boolean): string {
	const abs = Math.abs(val);
	const prefix = isJpyPair ? '¥' : '';
	if (abs >= 1_000_000_000) return `${prefix}${(val / 1_000_000_000).toFixed(1)}B`;
	if (abs >= 1_000_000) return `${prefix}${(val / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
	if (abs >= 10_000) return `${prefix}${(val / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}K`;
	if (abs >= 1_000) return `${prefix}${val.toLocaleString('ja-JP')}`;
	return `${prefix}${val}`;
}

export type Pt = { x: number; y: number };

export function simplifyPts(raw: Pt[], tolerance: number): Pt[] {
	if (tolerance <= 0 || raw.length <= 2) return raw;
	const sqTol = tolerance * tolerance;
	const simplified: Pt[] = [raw[0]];
	for (let i = 1; i < raw.length - 1; i++) {
		const a = raw[i - 1],
			b = raw[i],
			c = raw[i + 1];
		const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
		const dx = c.x - a.x;
		const dy = c.y - a.y;
		const len2 = dx * dx + dy * dy || 1;
		if ((area * area) / len2 >= sqTol) simplified.push(b);
	}
	simplified.push(raw[raw.length - 1]);
	return simplified;
}

export function sanitizeSvg(s: string): string {
	return s
		.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
		.replace(/\son[a-z]+="[^"]*"/gi, '')
		.replace(/\son[a-z]+='[^']*'/gi, '');
}

export const smaColors: Record<number, string> = {
	5: '#f472b6',
	20: '#a78bfa',
	25: '#3b82f6',
	50: '#22d3ee',
	75: '#f59e0b',
	200: '#10b981',
};

export const emaColors: Record<number, string> = {
	12: '#ff6b35',
	26: '#ffd166',
	50: '#ef476f',
	200: '#06d6a0',
};

export const bbColors = {
	bandFill2: 'rgba(59, 130, 246, 0.10)',
	line1: '#9ca3af',
	line2: '#3b82f6',
	line3: '#f59e0b',
	middle: '#9ca3af',
} as const;
