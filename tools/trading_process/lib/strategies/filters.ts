export function entryFilterStartIdx(params: Record<string, number>): number {
	const smaStart = params.sma_filter_period > 0 ? params.sma_filter_period - 1 : 0;
	const rsiStart = params.rsi_filter_period > 0 ? params.rsi_filter_period + 1 : 0;
	return Math.max(smaStart, rsiStart);
}

export function isEntryBlockedBySmaRsi(
	i: number,
	closes: readonly number[],
	sma: readonly number[] | null,
	rsi: readonly number[] | null,
	rsiMax: number,
): boolean {
	if (sma && !Number.isNaN(sma[i]) && closes[i] < sma[i]) return true;
	if (rsi && !Number.isNaN(rsi[i]) && rsi[i] >= rsiMax) return true;
	return false;
}

// 戦略固有のフィルタ（MACD のゼロライン）は SMA と RSI の間に並べる。
export function describeEntryFilters(params: Record<string, number>, strategyParts: readonly string[] = []): string {
	const parts: string[] = [];
	if (params.sma_filter_period > 0) {
		parts.push(`SMA${params.sma_filter_period} trend filter`);
	}
	parts.push(...strategyParts);
	if (params.rsi_filter_period > 0 && params.rsi_filter_max < 100) {
		parts.push(`RSI(${params.rsi_filter_period})<${params.rsi_filter_max}`);
	}
	return parts.length > 0 ? ` [${parts.join(', ')}]` : '';
}
