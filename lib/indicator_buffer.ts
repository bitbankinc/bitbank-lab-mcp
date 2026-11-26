import { FIXED_FETCH_BARS, MA_SERIES } from './indicator-series.js';

export type IndicatorBufferKey = (typeof MA_SERIES)[number]['key'] | keyof typeof FIXED_FETCH_BARS;

const INDICATOR_PERIODS = {
	...(Object.fromEntries(MA_SERIES.map((s) => [s.key, s.period])) as Record<(typeof MA_SERIES)[number]['key'], number>),
	...FIXED_FETCH_BARS,
} as const satisfies Record<IndicatorBufferKey, number>;

export function getFetchCount(displayCount: number, indicatorKeys: readonly IndicatorBufferKey[] = []): number {
	const maxPeriod = indicatorKeys.reduce((max, key) => {
		const period = INDICATOR_PERIODS[key] || 0;
		return Math.max(max, period);
	}, 0);
	const buffer = maxPeriod > 0 ? maxPeriod - 1 : 0;
	return displayCount + buffer;
}
