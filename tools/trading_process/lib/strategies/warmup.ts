// Wilder 平滑と EMA は初期値の影響が残るので、初期値の重みがこの比率を切るまでをウォームアップに含める（issue 442）。
const SEED_WEIGHT_TOLERANCE = 0.001;

function barsUntilSeedDecays(alpha: number): number {
	if (alpha >= 1) return 0;
	return Math.ceil(Math.log(SEED_WEIGHT_TOLERANCE) / Math.log(1 - alpha));
}

export function wilderConvergenceBars(period: number): number {
	return barsUntilSeedDecays(1 / period);
}

export function emaConvergenceBars(period: number): number {
	return barsUntilSeedDecays(2 / (period + 1));
}
