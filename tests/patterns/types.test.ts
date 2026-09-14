import { describe, expect, it } from 'vitest';
import { getHsShoulderMaxPctForTf, getSizeThresholdsForTf } from '../../tools/patterns/config.js';
import type { DetectContext } from '../../tools/patterns/types.js';
import { pushCand } from '../../tools/patterns/types.js';

function makeCtx(candles: Array<{ isoTime?: string }>): DetectContext {
	return {
		candles: candles.map((c) => ({
			open: 100,
			close: 100,
			high: 110,
			low: 90,
			...c,
		})),
		pivots: [],
		allPeaks: [],
		allValleys: [],
		tolerancePct: 0.04,
		headProminencePct: 0.04,
		minDist: 5,
		want: new Set(),
		includeForming: false,
		debugCandidates: [],
		type: '1day',
		sizeThresholds: getSizeThresholdsForTf('1day'),
		hsShoulderMaxPct: getHsShoulderMaxPctForTf('1day'),
		swingDepth: 6,
		near: () => false,
		pct: () => 0,
		lrWithR2: () => ({ slope: 0, intercept: 0, r2: 0, valueAt: () => 0 }),
	};
}

describe('pushCand', () => {
	it('デバッグ候補をコンテキストに追加する', () => {
		const ctx = makeCtx([{ isoTime: '2024-01-01' }, { isoTime: '2024-01-02' }]);
		pushCand(ctx, {
			type: 'double_top',
			accepted: true,
			reason: 'test',
			idxs: [0, 1],
			pts: [
				{ role: 'peak1', idx: 0, price: 100 },
				{ role: 'peak2', idx: 1, price: 110 },
			],
		});
		expect(ctx.debugCandidates).toHaveLength(1);
		const entry = ctx.debugCandidates[0];
		expect(entry.type).toBe('double_top');
		expect(entry.accepted).toBe(true);
		expect(entry.reason).toBe('test');
		expect(entry.indices).toEqual([0, 1]);
	});

	it('points に isoTime を付加する', () => {
		const ctx = makeCtx([{ isoTime: '2024-01-01' }, { isoTime: '2024-01-02' }]);
		pushCand(ctx, {
			type: 'test',
			accepted: false,
			pts: [{ role: 'peak', idx: 0, price: 100 }],
		});
		const entry = ctx.debugCandidates[0];
		expect(entry.points?.[0]?.isoTime).toBe('2024-01-01');
	});

	it('pts が空でも動作する', () => {
		const ctx = makeCtx([]);
		pushCand(ctx, { type: 'test', accepted: false });
		expect(ctx.debugCandidates).toHaveLength(1);
		expect(ctx.debugCandidates[0].points).toEqual([]);
	});

	it('範囲外のインデックスでも isoTime は undefined になるだけ', () => {
		const ctx = makeCtx([{ isoTime: '2024-01-01' }]);
		pushCand(ctx, {
			type: 'test',
			accepted: false,
			pts: [{ role: 'peak', idx: 99, price: 100 }],
		});
		expect(ctx.debugCandidates[0].points?.[0]?.isoTime).toBeUndefined();
	});
});
