// debug の候補の points は view=debug の content に「role@idx:価格」で出るので、棄却 4 種の構成点を固定する。
import { describe, expect, it } from 'vitest';
import {
	getHsShoulderMaxPctForTf,
	getPriorTrendParamsForTf,
	getSizeThresholdsForTf,
	resolveParams,
} from '../../tools/patterns/config.js';
import { detectDoubles } from '../../tools/patterns/detect_doubles.js';
import type {
	BreakoutPathRejectReason,
	MainPointNecklineSideRejectReason,
	PatternLevelDiffRejectReason,
	StructuralRejectReason,
} from '../../tools/patterns/structural.js';
import { detectSwingPoints, filterPeaks, filterValleys } from '../../tools/patterns/swing.js';
import type { CandDebugEntry, CandleData, DetectContext } from '../../tools/patterns/types.js';
import { buildBtcJpy1hour20260905Candles } from '../fixtures/btc_jpy_1hour_2026_09_05.js';

type Gate = 'level_diff' | 'neckline_side' | 'structure' | 'breakout_path';

const GATE_OF_REASON = {
	peaks_diff_vs_height_excess: 'level_diff',
	valleys_diff_vs_height_excess: 'level_diff',
	peaks_below_neckline: 'neckline_side',
	valleys_above_neckline: 'neckline_side',
	neckline_above_pre_decline_high: 'structure',
	neckline_below_pre_decline_low: 'structure',
	no_neckline_cross_before_trough1: 'structure',
	no_neckline_cross_before_peak1: 'structure',
	retracement_out_of_band: 'structure',
	peak_after_last_pivot: 'breakout_path',
	trough_after_last_pivot: 'breakout_path',
} as const satisfies Record<
	PatternLevelDiffRejectReason | MainPointNecklineSideRejectReason | StructuralRejectReason | BreakoutPathRejectReason,
	Gate
>;

function gateOf(reason: string | undefined): Gate | undefined {
	return reason !== undefined && Object.hasOwn(GATE_OF_REASON, reason)
		? GATE_OF_REASON[reason as keyof typeof GATE_OF_REASON]
		: undefined;
}

function mirror(candles: CandleData[]): CandleData[] {
	const m = Math.max(...candles.map((c) => c.high)) + Math.min(...candles.map((c) => c.low));
	return candles.map((c) => ({ ...c, open: m - c.open, high: m - c.low, low: m - c.high, close: m - c.close }));
}

function detectDebugCandidates(candles: CandleData[]): CandDebugEntry[] {
	const tf = '1hour';
	const { swingDepth, tolerancePct, minBarsBetweenSwings, headProminencePct } = resolveParams(tf, {});
	const pivots = detectSwingPoints(candles, { swingDepth, strictPivots: true });
	const ctx: DetectContext = {
		candles,
		pivots,
		allPeaks: filterPeaks(pivots),
		allValleys: filterValleys(pivots),
		tolerancePct,
		headProminencePct,
		sizeThresholds: getSizeThresholdsForTf(tf),
		hsShoulderMaxPct: getHsShoulderMaxPctForTf(tf),
		priorTrendParams: getPriorTrendParamsForTf(tf),
		minDist: minBarsBetweenSwings,
		want: new Set(),
		includeForming: false,
		debugCandidates: [],
		type: tf,
		swingDepth,
		tz: 'Asia/Tokyo',
	};
	detectDoubles(ctx);
	return ctx.debugCandidates;
}

const full = buildBtcJpy1hour20260905Candles();
const mirrored = mirror(full);
// 全 365 本では同水準の棄却が出ないので、出る窓（[64, 112)）を足している。
const CASES: Array<{ name: string; candles: CandleData[] }> = [
	{ name: '全 365 本', candles: full },
	{ name: '全 365 本（上下反転）', candles: mirrored },
	{ name: '[64, 112)', candles: full.slice(64, 112) },
	{ name: '[64, 112)（上下反転）', candles: mirrored.slice(64, 112) },
];

const hits = CASES.flatMap(({ name, candles }) =>
	detectDebugCandidates(candles).flatMap((c) => {
		const gate = gateOf(c.reason);
		return gate && (c.type === 'double_top' || c.type === 'double_bottom') ? [{ name, candles, c, gate }] : [];
	}),
);

describe('double の棄却候補の points（btc_jpy_1hour_2026_09_05）', () => {
	it('4 種の棄却が top / bottom とも候補に出ている（下の検査が空集合で通らないこと）', () => {
		const seen = new Set(hits.map(({ c, gate }) => `${c.type}/${gate}`));
		expect([...seen].sort()).toEqual([
			'double_bottom/breakout_path',
			'double_bottom/level_diff',
			'double_bottom/neckline_side',
			'double_bottom/structure',
			'double_top/breakout_path',
			'double_top/level_diff',
			'double_top/neckline_side',
			'double_top/structure',
		]);
		expect(hits.some(({ c, gate }) => gate === 'structure' && c.points?.[0]?.role === 'prior_extreme')).toBe(true);
		expect(hits.some(({ c, gate }) => gate === 'breakout_path' && c.points?.length === 4)).toBe(true);
	});

	it('3 つの構成点が indices の順に、外側 1・中間・外側 2 の役割と終値で載る', () => {
		for (const { name, candles, c, gate } of hits) {
			const [outer, mid] = c.type === 'double_top' ? ['peak', 'valley'] : ['valley', 'peak'];
			const points = c.points ?? [];
			const hasPrior = gate === 'structure' && points[0]?.role === 'prior_extreme';
			const hasAfterLast = gate === 'breakout_path' && points.length === 4;
			const [i1, i2, i3] = c.indices ?? [];
			const at = (role: string, idx: number) => ({
				role,
				idx,
				price: candles[idx].close,
				isoTime: candles[idx].isoTime,
			});
			expect(points, `${name} ${c.type} ${c.reason}`).toEqual([
				...(hasPrior ? [points[0]] : []),
				at(`${outer}1`, i1),
				at(mid, i2),
				at(`${outer}2`, i3),
				...(hasAfterLast ? [{ ...points[3], role: `${outer}_after_last` }] : []),
			]);
		}
	});
});
