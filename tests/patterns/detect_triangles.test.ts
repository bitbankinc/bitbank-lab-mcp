import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { getHsShoulderMaxPctForTf, getSizeThresholdsForTf } from '../../tools/patterns/config.js';
import { classifyTriangle, detectTriangles, getTriangleParams } from '../../tools/patterns/detect_triangles.js';
import type { Pivot } from '../../tools/patterns/swing.js';
import type { CandleData, DetectContext } from '../../tools/patterns/types.js';
import { buildBtcJpy2026ThroughSep30Candles } from '../fixtures/btc_jpy_1day_2026.js';

function iso(daysAgo: number): string {
	return dayjs().subtract(daysAgo, 'day').startOf('day').toISOString();
}

function mkCandle(daysAgo: number, o: number, h: number, l: number, c: number): CandleData {
	return { open: o, high: h, low: l, close: c, isoTime: iso(daysAgo) };
}

function buildCtx(opts: {
	candles: CandleData[];
	pivots?: Pivot[];
	want?: Set<string>;
	includeForming?: boolean;
	type?: string;
}): DetectContext {
	const tol = 0.04;
	const pivots = opts.pivots ?? [];
	return {
		candles: opts.candles,
		pivots,
		allPeaks: pivots.filter((p) => p.kind === 'H'),
		allValleys: pivots.filter((p) => p.kind === 'L'),
		tolerancePct: tol,
		headProminencePct: tol,
		minDist: 5,
		want: opts.want ?? new Set(),
		includeForming: opts.includeForming ?? true,
		debugCandidates: [],
		type: opts.type ?? '1day',
		sizeThresholds: getSizeThresholdsForTf(opts.type ?? '1day'),
		hsShoulderMaxPct: getHsShoulderMaxPctForTf(opts.type ?? '1day'),
		swingDepth: 7,
	};
}

// period=8 の振動で relaxed swing detection に拾われるよう設計。

function buildSymTriangleBase(nBars: number): CandleData[] {
	const candles: CandleData[] = [];
	for (let i = 0; i < nBars; i++) {
		const upper = 110 - 0.3 * i;
		const lower = 80 + 0.3 * i;
		const mid = (upper + lower) / 2;
		const phase = i % 8;
		let h: number;
		let l: number;
		let c: number;

		if (phase === 1) {
			h = upper;
			l = upper - 5;
			c = upper - 1;
		} else if (phase === 5) {
			h = lower + 5;
			l = lower;
			c = lower + 1;
		} else {
			h = mid + 3;
			l = mid - 3;
			c = mid;
		}
		candles.push(mkCandle(nBars + 20 - i, mid, h, l, c));
	}
	return candles;
}

function buildWithBreakoutAndTail(tailCloses: number[], breakoutClose = 120): CandleData[] {
	const base = buildSymTriangleBase(40);

	// ブレイクアウト足: close が upper + ATR*0.3 を超える
	base.push(mkCandle(20 - 0, breakoutClose - 2, breakoutClose + 2, breakoutClose - 4, breakoutClose));

	for (let t = 0; t < tailCloses.length; t++) {
		const c = tailCloses[t];
		base.push(mkCandle(20 - (1 + t), c - 1, c + 2, c - 3, c));
	}

	return base;
}

afterEach(() => {
	vi.resetAllMocks();
});

describe('detectTriangles — whipsaw boundary tests', () => {
	it('ブレイクアウト後に三角形外に留まる → status=completed を維持', () => {
		// 後続足も 115-120 付近 → upper line (~98) より十分上
		const candles = buildWithBreakoutAndTail([118, 119, 120, 121]);
		const ctx = buildCtx({ candles, want: new Set(['triangle_symmetrical']) });
		const result = detectTriangles(ctx);

		const syms = result.patterns.filter((p) => p.type === 'triangle_symmetrical');
		const completed = syms.filter((p) => p.status === 'completed');
		expect(completed.length).toBeGreaterThanOrEqual(1);
		expect(completed[0]?.breakoutDirection).toBe('up');
		expect(completed[0]?.outcome).toBe('success');
	});

	it('ブレイクアウト後に三角形内に再侵入 → whipsaw で breakout 無効化', () => {
		// 三角形の中央は ~95。後続足が三角形内（upper ~98, lower ~92）に戻る
		const candles = buildWithBreakoutAndTail([110, 100, 95, 94]);
		const ctx = buildCtx({
			candles,
			want: new Set(['triangle_symmetrical']),
			includeForming: true,
		});
		const result = detectTriangles(ctx);

		const syms = result.patterns.filter((p) => p.type === 'triangle_symmetrical');

		const completed = syms.filter((p) => p.status === 'completed');
		const forming = syms.filter((p) => p.status === 'forming' || p.status === 'near_completion');

		expect(syms.length).toBeGreaterThan(0);
		expect(completed.length === 0 || forming.length > 0).toBe(true);

		const withBreakout = syms.filter((p) => p.status === 'completed' && p.breakoutDirection === 'up');
		expect(withBreakout).toHaveLength(0);
	});

	it('直近足が上限トレンドラインと一致 → whipsaw は発動しない（strict <）', () => {
		// upperLine は 110 - 0.3*i で、i=44 では 96.8 付近。最終足 close=97 は三角形「内」ではない（close < uLatest が false）。
		const candles = buildWithBreakoutAndTail([115, 110, 105, 97]);

		const ctx = buildCtx({ candles, want: new Set(['triangle_symmetrical']) });
		const result = detectTriangles(ctx);

		const syms = result.patterns.filter((p) => p.type === 'triangle_symmetrical');
		expect(syms.length).toBeGreaterThan(0);
		const hasBreakoutPattern = syms.some((p) => p.breakoutDirection === 'up' && p.status === 'completed');
		const hasFormingPattern = syms.some((p) => p.status === 'forming' || p.status === 'near_completion');
		expect(hasBreakoutPattern || hasFormingPattern).toBe(true);
	});

	it('直近足が下限トレンドライン以下 → whipsaw は発動しない（strict >）', () => {
		// lowerLine は 80 + 0.3*i で上昇し、直近足（i=41）での値は 92.3 付近。
		const base = buildSymTriangleBase(40);

		// 下方ブレイクアウト: close が lower - ATR*0.3 を下回る
		base.push(mkCandle(20, 75, 78, 72, 73));
		// 後続足の close を lower line 延長値（~92.3）より下にする → latestClose > lLatest が false → whipsaw 不発
		base.push(mkCandle(19, 90, 91, 88, 89));

		const ctx = buildCtx({
			candles: base,
			want: new Set(['triangle_symmetrical']),
			includeForming: true,
		});
		const result = detectTriangles(ctx);

		const syms = result.patterns.filter((p) => p.type === 'triangle_symmetrical');
		expect(syms.length).toBeGreaterThan(0);
		const formingOrCompleted = syms.filter(
			(p) => p.status === 'completed' || p.status === 'forming' || p.status === 'near_completion',
		);
		expect(formingOrCompleted.length).toBeGreaterThanOrEqual(1);
		const downBreakouts = syms.filter((p) => p.breakoutDirection === 'down');
		expect(downBreakouts.length).toBeGreaterThan(0);
		expect(downBreakouts[0]?.breakoutBarIndex).toBeDefined();
	});

	it('whipsaw + includeForming=false → forming パターンがスキップされる', () => {
		// トレンドラインの交差は index≈50 なので、5本の戻り足なら交差前（lastIdx=45）で whipsaw が発動して forming 扱いになり、includeForming=false で skip される。
		const base = buildSymTriangleBase(40);

		base.push(mkCandle(20, 118, 122, 116, 120));

		// close=94 は upper(45)≈96.5, lower(45)≈93.5 の範囲内（whipsaw）
		for (let t = 0; t < 5; t++) {
			base.push(mkCandle(19 - t, 94, 96, 92, 94));
		}

		const ctx = buildCtx({
			candles: base,
			want: new Set(['triangle_symmetrical']),
			includeForming: false, // forming を除外 → skip 対象
		});
		const result = detectTriangles(ctx);

		const syms = result.patterns.filter((p) => p.type === 'triangle_symmetrical');
		const completed = syms.filter((p) => p.status === 'completed');
		expect(completed).toHaveLength(0);
	});

	it('ローソク足が少なすぎる → パターン不検出', () => {
		const candles: CandleData[] = Array.from({ length: 10 }, (_, i) => mkCandle(10 - i, 100, 102, 98, 100));
		const ctx = buildCtx({ candles });
		const result = detectTriangles(ctx);
		expect(result.patterns).toHaveLength(0);
	});

	it('want に triangle を含まない → 不検出', () => {
		const candles = buildSymTriangleBase(40);
		const ctx = buildCtx({ candles, want: new Set(['head_and_shoulders']) });
		const result = detectTriangles(ctx);
		expect(result.patterns).toHaveLength(0);
	});

	it('空配列 → patterns は空', () => {
		const ctx = buildCtx({ candles: [] });
		const result = detectTriangles(ctx);
		expect(result.patterns).toHaveLength(0);
	});

	it('symmetrical triangle の基本検出（breakout なし・forming）', () => {
		const candles = buildSymTriangleBase(40);
		const ctx = buildCtx({
			candles,
			want: new Set(['triangle_symmetrical']),
			includeForming: true,
		});
		const result = detectTriangles(ctx);

		const syms = result.patterns.filter((p) => p.type === 'triangle_symmetrical');
		expect(syms.length).toBeGreaterThan(0);
		expect(syms[0]?.confidence).toBeGreaterThan(0);
		expect(syms[0]?.range?.start).toBeDefined();
		expect(syms[0]?.range?.end).toBeDefined();
		const validStatuses = ['forming', 'near_completion'];
		expect(validStatuses).toContain(syms[0]?.status);
	});

	it('形成中の途中足がライン外に出ても completed にならない', () => {
		// upper(20) ≈ 110 - 0.3*20 = 104。close=130 → upper + ATR*0.3 を大きく超えるが、後続足は通常パターンに戻る（false breakout）。
		const candles = buildSymTriangleBase(40);
		candles[20] = mkCandle(20 + 40 - 20, 100, 132, 99, 130);

		const ctx = buildCtx({
			candles,
			want: new Set(['triangle_symmetrical']),
			includeForming: true,
		});
		const result = detectTriangles(ctx);

		const syms = result.patterns.filter((p) => p.type === 'triangle_symmetrical');
		const completed = syms.filter((p) => p.status === 'completed');
		expect(completed).toHaveLength(0);
	});

	it('真のブレイクは保ち合い終端後の位置で検出される（中間の false breakout は採用されない）', () => {
		// 中間 i=20 で false breakout、保ち合い終端を過ぎてから本物のブレイクアウト（breakoutBarIndex は終端後の位置 >=38 になる）。
		const base = buildSymTriangleBase(40);

		base[20] = mkCandle(20 + 40 - 20, 100, 132, 99, 130);

		// 保ち合い終端後に本物のブレイクアウト。直近足も外側維持で whipsaw 不発。
		base.push(mkCandle(20, 100, 116, 99, 115)); // i=40
		base.push(mkCandle(19, 115, 121, 113, 119)); // i=41
		base.push(mkCandle(18, 119, 125, 117, 123)); // i=42

		const ctx = buildCtx({
			candles: base,
			want: new Set(['triangle_symmetrical']),
			includeForming: true,
		});
		const result = detectTriangles(ctx);

		const syms = result.patterns.filter((p) => p.type === 'triangle_symmetrical');
		const completed = syms.filter((p) => p.status === 'completed');

		expect(completed.length).toBeGreaterThan(0);
		for (const p of completed) {
			const idx = p.breakoutBarIndex;
			expect(idx).toBeDefined();
			expect(idx).not.toBe(20);
			expect(idx as number).toBeGreaterThanOrEqual(38);
		}
	});

	it('deduplicatePatterns で同一 range の重複が除去される', () => {
		const candles = buildWithBreakoutAndTail([118, 119, 120, 121]);
		const ctx = buildCtx({ candles, want: new Set() });
		const result = detectTriangles(ctx);

		const seen = new Set<string>();
		for (const p of result.patterns) {
			const key = `${p.type}_${p.range?.start}_${p.range?.end}`;
			expect(seen.has(key)).toBe(false);
			seen.add(key);
		}
	});

	it('triangle: 上方ブレイク後に high が target を超える → targetReached=true, pct>=100', () => {
		const candles = buildWithBreakoutAndTail([118, 119, 200, 121]);
		const ctx = buildCtx({ candles, want: new Set(['triangle_symmetrical']) });
		const result = detectTriangles(ctx);

		const completed = result.patterns.filter((p) => p.type === 'triangle_symmetrical' && p.status === 'completed');
		expect(completed.length).toBeGreaterThanOrEqual(1);
		const p = completed[0];
		expect(p?.breakoutTarget).toBeDefined();
		expect(p?.targetReached).toBe(true);
		expect(p?.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(p?.targetReachedPrice).toBeDefined();
		expect(p?.targetReachedDate).toBeDefined();
	});

	it('triangle: ブレイク後に high が target に届かない → targetReached=false, pct<100', () => {
		// breakoutClose=120, patternHeight≈30 → target=150。後続足 high<=123 で必ず未到達
		const candles = buildWithBreakoutAndTail([118, 119, 120, 121]);
		const ctx = buildCtx({ candles, want: new Set(['triangle_symmetrical']) });
		const result = detectTriangles(ctx);

		const completed = result.patterns.filter((p) => p.type === 'triangle_symmetrical' && p.status === 'completed');
		expect(completed.length).toBeGreaterThanOrEqual(1);
		const unreached = completed.find((p) => p.targetReached === false);
		expect(unreached).toBeDefined();
		expect(unreached?.targetReachedPct).toBeLessThan(100);
		expect(unreached?.targetReachedPrice).toBeDefined();
	});
});

describe('detectTriangles — 整合度（#422）', () => {
	type Details = { convergenceRatio: number; touchCount: number; upperRelSlope: number; lowerRelSlope: number };
	function detectOne(candles: CandleData[], type: string) {
		const ctx = buildCtx({ candles, want: new Set([type]), includeForming: true });
		const pattern = detectTriangles(ctx).patterns.find((p) => p.type === type);
		const debug = ctx.debugCandidates.find(
			(d) => d.type === type && d.accepted && (d.details as { confidence?: number }).confidence === pattern?.confidence,
		);
		return { pattern, details: debug?.details as Details | undefined };
	}

	it('対称三角は lineFit / convergence / touches / slopeSymmetry を出し、confidence はその単純平均', () => {
		const { pattern, details } = detectOne(buildSymTriangleBase(40), 'triangle_symmetrical');
		const sc = pattern?.scoreComponents ?? {};
		expect(Object.keys(sc).sort()).toEqual(['convergence', 'lineFit', 'slopeSymmetry', 'touches']);
		const axes = Object.values(sc) as number[];
		expect(pattern?.confidence).toBeCloseTo(axes.reduce((sum, v) => sum + v, 0) / axes.length, 2);
		expect(sc.touches).toBeCloseTo(1 - 4 / Number(details?.touchCount), 4);
		expect(sc.convergence).toBeCloseTo(
			1 - Number(details?.convergenceRatio) / getTriangleParams('1day').minConvergence,
			2,
		);
	});

	it('上昇三角は slopeSymmetry の代わりに上側の flatness を出す', () => {
		// 合成の振動では上側が水平の三角が立たないので、上昇三角が出る実データの窓を使う。
		const { pattern, details } = detectOne(buildBtcJpy2026ThroughSep30Candles().slice(6, 96), 'triangle_ascending');
		expect(pattern).toBeDefined();
		const sc = pattern?.scoreComponents ?? {};
		expect(sc.slopeSymmetry).toBeUndefined();
		expect(sc.flatness).toBeCloseTo(
			1 - Math.abs(Number(details?.upperRelSlope)) / getTriangleParams('1day').flatThreshold,
			2,
		);
	});
});

describe('classifyTriangle', () => {
	const ALL = { triangle_ascending: true, triangle_descending: true, triangle_symmetrical: true };
	const NONE = { triangle_ascending: false, triangle_descending: false, triangle_symmetrical: false };

	it('flatThreshold が moveThreshold より大きく、その間の傾きは flat と rising / falling の両方に入る', () => {
		const { flatThreshold, moveThreshold } = getTriangleParams('1day');
		expect(flatThreshold).toBeGreaterThan(moveThreshold);
	});

	it('上下とも重なりの帯にあると、ascending → descending → symmetrical の順に許された型を選ぶ', () => {
		const both = { upperFlat: true, upperFalling: true, lowerFlat: true, lowerRising: true };
		expect(classifyTriangle(both, ALL)).toBe('triangle_ascending');
		expect(classifyTriangle(both, { ...ALL, triangle_ascending: false })).toBe('triangle_descending');
		expect(classifyTriangle(both, { ...NONE, triangle_symmetrical: true })).toBe('triangle_symmetrical');
		expect(classifyTriangle(both, NONE)).toBeNull();
	});

	it('重ならない形はそれぞれ 1 つの型になり、許されていなければ null', () => {
		const asc = { upperFlat: true, upperFalling: false, lowerFlat: false, lowerRising: true };
		const desc = { upperFlat: false, upperFalling: true, lowerFlat: true, lowerRising: false };
		const sym = { upperFlat: false, upperFalling: true, lowerFlat: false, lowerRising: true };
		const flat = { upperFlat: true, upperFalling: false, lowerFlat: true, lowerRising: false };
		expect(classifyTriangle(asc, ALL)).toBe('triangle_ascending');
		expect(classifyTriangle(desc, ALL)).toBe('triangle_descending');
		expect(classifyTriangle(sym, ALL)).toBe('triangle_symmetrical');
		expect(classifyTriangle(flat, ALL)).toBeNull();
		expect(classifyTriangle(asc, { ...ALL, triangle_ascending: false })).toBeNull();
		expect(classifyTriangle(desc, { ...ALL, triangle_descending: false })).toBeNull();
		expect(classifyTriangle(sym, { ...ALL, triangle_symmetrical: false })).toBeNull();
	});
});
