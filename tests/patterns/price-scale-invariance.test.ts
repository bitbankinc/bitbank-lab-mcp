import { describe, expect, it } from 'vitest';
import {
	getHsShoulderMaxPctForTf,
	getPriorTrendParamsForTf,
	getSizeThresholdsForTf,
	resolveParams,
} from '../../tools/patterns/config.js';
import { detectDoubles } from '../../tools/patterns/detect_doubles.js';
import { detectHeadAndShoulders } from '../../tools/patterns/detect_hs.js';
import { detectTriples } from '../../tools/patterns/detect_triples.js';
import { detectSwingPoints, filterPeaks, filterValleys } from '../../tools/patterns/swing.js';
import type { CandleData, DetectContext, DetectResult } from '../../tools/patterns/types.js';
import { buildBtcJpy1hour202608Candles } from '../fixtures/btc_jpy_1hour_2026_08.js';

function buildCtx(candles: CandleData[], type: string): DetectContext {
	const { swingDepth, tolerancePct, minBarsBetweenSwings, headProminencePct } = resolveParams(type, {});
	const pivots = detectSwingPoints(candles, { swingDepth, strictPivots: true });
	return {
		candles,
		pivots,
		allPeaks: filterPeaks(pivots),
		allValleys: filterValleys(pivots),
		tolerancePct,
		headProminencePct,
		sizeThresholds: getSizeThresholdsForTf(type),
		hsShoulderMaxPct: getHsShoulderMaxPctForTf(type),
		priorTrendParams: getPriorTrendParamsForTf(type),
		minDist: minBarsBetweenSwings,
		want: new Set(),
		includeForming: true,
		debugCandidates: [],
		type,
		swingDepth,
	};
}

function scaleTo(candles: CandleData[], maxPrice: number): CandleData[] {
	const k = maxPrice / Math.max(...candles.map((c) => c.high));
	return candles.map((c) => ({ ...c, open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k }));
}

function signature(result: DetectResult): string[] {
	return result.patterns.map((p) => `${p.type}|${p.status}|${p.range?.start}|${p.range?.end}`).sort();
}

describe('価格の水準によらず同じ判定になる', () => {
	// 旧実装で、最高値を 1 円未満に縮めると結果が変わっていた窓。
	it.each([
		['detectDoubles', detectDoubles, '1hour', () => buildBtcJpy1hour202608Candles().slice(230, 320)],
		['detectTriples', detectTriples, '1hour', () => buildBtcJpy1hour202608Candles().slice(0, 90)],
		['detectHeadAndShoulders', detectHeadAndShoulders, '1hour', () => buildBtcJpy1hour202608Candles().slice(150, 240)],
	] as const)('%s: 最高値を 0.5 円 / 0.05 円に縮めても検出結果が変わらない', (_name, detect, type, build) => {
		const candles = build();
		const base = signature(detect(buildCtx(candles, type)));
		expect(base.length).toBeGreaterThan(0);
		for (const maxPrice of [0.5, 0.05]) {
			expect(signature(detect(buildCtx(scaleTo(candles, maxPrice), type)))).toEqual(base);
		}
	});
});
