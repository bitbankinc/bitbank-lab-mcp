// docs/tools.md「limit の実効下限」§2 を各検出器の定数から導出する。スイング検出の構造的下限（§1）は scan-window.ts が持つので二重に持たない。
// 形成中 wedge は最新に揃えた窓を必ず積み、窓が足りなくても候補が消えないので扱わない。

import { getHsFormingBarParams } from './detect_hs.js';
import { getFlagParams } from './detect_pennants.js';
import { getTriangleParams } from './detect_triangles.js';
import { getTripleFormingBarParams } from './detect_triples.js';
import { getWedgeBarParams } from './detect_wedges.js';

// triangle は docs の表には無いが、到達性テストの網羅のために含める。
export const MIN_BARS_DETECTORS = [
	'forming_hs',
	'forming_triple',
	'completed_wedge',
	'triangle',
	'flag_pennant',
] as const;

export type MinBarsDetector = (typeof MIN_BARS_DETECTORS)[number];

export function minBarsForDetector(tf: string, detector: MinBarsDetector): number {
	switch (detector) {
		// formationBars は添字の差なので、窓の本数としては 1 本多く要る。
		case 'forming_hs':
			return getHsFormingBarParams(tf).minBars + 1;

		case 'forming_triple':
			return getTripleFormingBarParams(tf).minBars + 1;

		// generateWindows は start + size < totalBars で回すので、最小サイズの窓を 1 つ作るには windowSizeMin + 1 本要る。
		case 'completed_wedge':
			return getWedgeBarParams(tf).windowSizeMin + 1;

		// effectiveMax = min(lastIdx - 5, maxWindowBars) が minWindowBars 以上になるには bars >= minWindowBars + 6 が要る。
		case 'triangle':
			return getTriangleParams(tf).minWindowBars + 6;

		// poleEnd が添字なので、ループに入るには bars >= poleMinBars + consMinBars + 1 が要る。
		case 'flag_pennant': {
			const { poleMinBars, consMinBars } = getFlagParams(tf);
			return poleMinBars + consMinBars + 1;
		}
	}
}

export function minBarsTableForTf(tf: string): Record<MinBarsDetector, number> {
	const out = {} as Record<MinBarsDetector, number>;
	for (const d of MIN_BARS_DETECTORS) out[d] = minBarsForDetector(tf, d);
	return out;
}

export function isDetectorReachable(tf: string, detector: MinBarsDetector, bars: number): boolean {
	return minBarsForDetector(tf, detector) <= bars;
}
