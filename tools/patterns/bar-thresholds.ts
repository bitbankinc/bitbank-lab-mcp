import { getDefaultParamsForTf } from './config.js';
import { barsPerDay } from './helpers.js';
import { assessScanWindow } from './scan-window.js';

// 参照するのは時間足の既定の swingDepth / minBarsBetweenSwings で、呼び出し側のオプションではない。閾値が呼び出しごとに動くと、同じデータでパターンの定義が変わる。
export function structuralFloorBars(tf: string): number {
	const { swingDepth, minBarsBetweenSwings } = getDefaultParamsForTf(tf);
	return assessScanWindow(0, swingDepth, minBarsBetweenSwings).minViableLimit;
}

// 1 だと上限 = 下限で clamp が潰れ、3 以上だと 15min / 30min の flag / pennant が既定 limit（90）で届かない（invariants.test.ts が固定）。
export const PATTERN_BARS_CAP_MULTIPLIER = 2;

// 走査窓（limit）には依存させない。依存させると limit 次第でパターンの定義が変わる。
export function patternBarsCap(tf: string): number {
	return structuralFloorBars(tf) * PATTERN_BARS_CAP_MULTIPLIER;
}

export function patternMinBars(tf: string, days: number): number {
	const raw = Math.round(days * barsPerDay(tf));
	return Math.min(patternBarsCap(tf), Math.max(structuralFloorBars(tf), raw));
}

// 最大側は日数比を保ったまま最小側のクランプに追従させる。追従しないと 1week / 1month で minBars > maxBars になり 0 件になる。
// patternBarsCap は最大側には掛けない。掛けるとレンジ判定が等値判定に退化する（bar-thresholds.test.ts が固定）。
export function patternBarRange(tf: string, minDays: number, maxDays: number): { minBars: number; maxBars: number } {
	if (!(minDays > 0) || !(maxDays >= minDays)) {
		throw new RangeError(`patternBarRange: 0 < minDays <= maxDays が必要 (minDays=${minDays}, maxDays=${maxDays})`);
	}
	const minBars = patternMinBars(tf, minDays);
	const maxBars = Math.max(minBars + 1, Math.round(minBars * (maxDays / minDays)));
	return { minBars, maxBars };
}

// ピボット構造を前提としない閾値（旗竿・保ち合い）用。構造的下限は掛けず、下限は検出器の絶対値を使う。
export function cappedBarsForDays(tf: string, days: number, absoluteMinBars: number): number {
	const raw = Math.round(days * barsPerDay(tf));
	return Math.min(patternBarsCap(tf), Math.max(absoluteMinBars, raw));
}
