import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { detectTriples } from '../../tools/patterns/detect_triples.js';
import { linearRegressionWithR2 } from '../../tools/patterns/regression.js';
import type { Pivot } from '../../tools/patterns/swing.js';
import type { CandleData, DetectContext } from '../../tools/patterns/types.js';

// ── ヘルパー ──

// detect_triples.ts の BREAKOUT_BUFFER_PCT と揃える（=1.5%）。
// 丸めで閾値を割らないよう微小マージンを足し、ネックライン突破ギリギリの終値を作る。
const TEST_BREAKOUT_BUFFER_PCT = 0.015;
const TEST_BREAKOUT_MARGIN_PCT = 0.001;

function iso(daysAgo: number): string {
	return dayjs().subtract(daysAgo, 'day').startOf('day').toISOString();
}

function mkCandle(daysAgo: number, o: number, h: number, l: number, c: number): CandleData {
	return { open: o, high: h, low: l, close: c, isoTime: iso(daysAgo) };
}

function buildCtx(opts: {
	candles: CandleData[];
	pivots: Pivot[];
	allPeaks?: Pivot[];
	allValleys?: Pivot[];
	tolerancePct?: number;
	want?: Set<string>;
	includeForming?: boolean;
	type?: string;
}): DetectContext {
	const tol = opts.tolerancePct ?? 0.04;
	return {
		candles: opts.candles,
		pivots: opts.pivots,
		allPeaks: opts.allPeaks ?? opts.pivots.filter((p) => p.kind === 'H'),
		allValleys: opts.allValleys ?? opts.pivots.filter((p) => p.kind === 'L'),
		tolerancePct: tol,
		minDist: 5,
		want: opts.want ?? new Set(),
		includeForming: opts.includeForming ?? false,
		debugCandidates: [],
		type: opts.type ?? '1day',
		swingDepth: 7,
		near: (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * tol,
		pct: (a: number, b: number) => ((b - a) / Math.max(1, a)) * 100,
		lrWithR2: (pts) => linearRegressionWithR2(pts),
	};
}

/**
 * Triple Top のローソク足とピボットを生成:
 * peak1(idx=0) → valley1(idx=10) → peak2(idx=20) → valley2(idx=30) → peak3(idx=40)
 *
 * 3山が等高、谷が等安、ネックライン勾配 <= 2%
 *
 * withBreakout=true のとき、peak3 以降にネックライン（谷の平均）を 1.5% 以上
 * 下抜けする終値を挿入し、完成済みパターンの検出を期待できる状態にする。
 */
function buildTripleTop(opts?: {
	peak?: number;
	valley?: number;
	peak2Price?: number;
	peak3Price?: number;
	v1Price?: number;
	v2Price?: number;
	withBreakout?: boolean;
}) {
	const pk = opts?.peak ?? 100;
	const pk2 = opts?.peak2Price ?? pk;
	const pk3 = opts?.peak3Price ?? pk;
	const v1 = opts?.v1Price ?? opts?.valley ?? 80;
	const v2 = opts?.v2Price ?? opts?.valley ?? 80;

	const candles: CandleData[] = [];
	for (let i = 0; i < 50; i++) candles.push(mkCandle(50 - i, 85, 90, 75, 85));
	candles[0] = mkCandle(50, pk - 1, pk, pk - 3, pk - 1);
	candles[10] = mkCandle(40, v1 + 1, v1 + 3, v1, v1 + 1);
	candles[20] = mkCandle(30, pk2 - 1, pk2, pk2 - 3, pk2 - 1);
	candles[30] = mkCandle(20, v2 + 1, v2 + 3, v2, v2 + 1);
	candles[40] = mkCandle(10, pk3 - 1, pk3, pk3 - 3, pk3 - 1);

	if (opts?.withBreakout) {
		// 谷の平均（ネックライン）を BREAKOUT_BUFFER_PCT 以上下抜けする終値
		const nlAvg = (v1 + v2) / 2;
		const breakClose = Math.floor(nlAvg * (1 - TEST_BREAKOUT_BUFFER_PCT - TEST_BREAKOUT_MARGIN_PCT));
		for (let i = 41; i < 50; i++) {
			candles[i] = mkCandle(50 - i, breakClose, breakClose + 1, breakClose - 3, breakClose);
		}
	}

	const pivots: Pivot[] = [
		{ idx: 0, price: pk, kind: 'H' },
		{ idx: 10, price: v1, kind: 'L' },
		{ idx: 20, price: pk2, kind: 'H' },
		{ idx: 30, price: v2, kind: 'L' },
		{ idx: 40, price: pk3, kind: 'H' },
	];

	return { candles, pivots };
}

/**
 * Triple Bottom のローソク足とピボットを生成:
 * valley1(idx=0) → peak1(idx=10) → valley2(idx=20) → peak2(idx=30) → valley3(idx=40)
 *
 * withBreakout=true のとき、valley3 以降にネックライン（山の平均）を 1.5% 以上
 * 上抜けする終値を挿入し、完成済みパターンの検出を期待できる状態にする。
 */
function buildTripleBottom(opts?: {
	valley?: number;
	peak?: number;
	v2Price?: number;
	v3Price?: number;
	p1Price?: number;
	p2Price?: number;
	withBreakout?: boolean;
}) {
	const vl = opts?.valley ?? 100;
	const v2 = opts?.v2Price ?? vl;
	const v3 = opts?.v3Price ?? vl;
	const p1 = opts?.p1Price ?? opts?.peak ?? 120;
	const p2 = opts?.p2Price ?? opts?.peak ?? 120;

	const candles: CandleData[] = [];
	for (let i = 0; i < 50; i++) candles.push(mkCandle(50 - i, 105, 115, 95, 105));
	candles[0] = mkCandle(50, vl + 1, vl + 3, vl, vl + 1);
	candles[10] = mkCandle(40, p1 - 1, p1, p1 - 3, p1 - 1);
	candles[20] = mkCandle(30, v2 + 1, v2 + 3, v2, v2 + 1);
	candles[30] = mkCandle(20, p2 - 1, p2, p2 - 3, p2 - 1);
	candles[40] = mkCandle(10, v3 + 1, v3 + 3, v3, v3 + 1);

	if (opts?.withBreakout) {
		// 山の平均（ネックライン）を BREAKOUT_BUFFER_PCT 以上上抜けする終値
		const nlAvg = (p1 + p2) / 2;
		const breakClose = Math.ceil(nlAvg * (1 + TEST_BREAKOUT_BUFFER_PCT + TEST_BREAKOUT_MARGIN_PCT));
		for (let i = 41; i < 50; i++) {
			candles[i] = mkCandle(50 - i, breakClose, breakClose + 3, breakClose - 1, breakClose);
		}
	}

	const pivots: Pivot[] = [
		{ idx: 0, price: vl, kind: 'L' },
		{ idx: 10, price: p1, kind: 'H' },
		{ idx: 20, price: v2, kind: 'L' },
		{ idx: 30, price: p2, kind: 'H' },
		{ idx: 40, price: v3, kind: 'L' },
	];

	return { candles, pivots };
}

afterEach(() => {
	vi.resetAllMocks();
});

describe('detectTriples', () => {
	// ── Triple Top（完成済み）────────────────────────────────

	it('3山等高 + 等安谷 + ネックライン下抜け → triple_top completed 検出', () => {
		const { candles, pivots } = buildTripleTop({ withBreakout: true });
		const ctx = buildCtx({ candles, pivots });
		const result = detectTriples(ctx);

		const tt = result.patterns.filter((p) => p.type === 'triple_top');
		expect(tt.length).toBeGreaterThanOrEqual(1);
		expect(tt[0]?.status).toBe('completed');
		expect(tt[0]?.breakoutDirection).toBe('down');
		expect(tt[0]?.outcome).toBe('success');
		expect(tt[0]?.breakoutBarIndex).toBeDefined();
		expect(tt[0]?.confirmation).toMatchObject({ type: 'neckline_breakout' });
		expect(tt[0]?.confidence).toBeGreaterThan(0);
		expect(tt[0]?.neckline).toBeDefined();
		expect(tt[0]?.breakoutTarget).toBeDefined();
		expect(tt[0]?.targetMethod).toBe('neckline_projection');
	});

	it('Triple Top ターゲット価格 = neckline - (avgPeak - neckline)', () => {
		// nlAvg=(80+80)/2=80, avgPeak=100, target=80-(100-80)=60
		const { candles, pivots } = buildTripleTop({ peak: 100, valley: 80, withBreakout: true });
		const ctx = buildCtx({ candles, pivots });
		const result = detectTriples(ctx);

		const tt = result.patterns.find((p) => p.type === 'triple_top');
		expect(tt?.breakoutTarget).toBe(60);
	});

	it('3山構造のみ（ブレイクなし） + includeForming=true → near_completion', () => {
		const { candles, pivots } = buildTripleTop();
		const ctx = buildCtx({ candles, pivots, includeForming: true });
		const result = detectTriples(ctx);

		const tt = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'near_completion');
		expect(tt.length).toBeGreaterThanOrEqual(1);
		expect(tt[0]?.confirmation).toMatchObject({ type: 'not_confirmed' });
		expect(tt[0]?.breakoutDirection).toBeUndefined();
		expect(tt[0]?.outcome).toBeUndefined();
		expect(tt[0]?.breakoutBarIndex).toBeUndefined();
	});

	it('3山構造のみ（ブレイクなし） + includeForming=false → 未検出', () => {
		const { candles, pivots } = buildTripleTop();
		const ctx = buildCtx({ candles, pivots, includeForming: false });
		const result = detectTriples(ctx);

		const tt = result.patterns.filter((p) => p.type === 'triple_top');
		expect(tt).toHaveLength(0);
	});

	it('谷のネックライン傾斜が急すぎ → neckline_slope_excess rejected', () => {
		// valleysNear が true (slope=0.030 ≤ tol=0.04) かつ necklineValid が false (0.030 > 0.02)
		// v1=80, v2=82.5 → |2.5|/82.5 = 0.030 ∈ (0.02, 0.04]
		const { candles, pivots } = buildTripleTop({ v1Price: 80, v2Price: 82.5 });
		const ctx = buildCtx({ candles, pivots });
		detectTriples(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_top' && d.accepted === false && d.reason === 'neckline_slope_excess',
		);
		expect(rejected).toBeDefined();
	});

	it('2山目と1山目の間に谷がない → valleys_missing rejected', () => {
		// allValleys に谷を含まない（間の谷なし）
		const candles: CandleData[] = Array.from({ length: 50 }, (_, i) => mkCandle(50 - i, 90, 95, 85, 90));
		candles[0] = mkCandle(50, 99, 100, 97, 99);
		candles[20] = mkCandle(30, 99, 100, 97, 99);
		candles[40] = mkCandle(10, 99, 100, 97, 99);

		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 20, price: 100, kind: 'H' },
			{ idx: 40, price: 100, kind: 'H' },
		];
		// allValleys は空
		const ctx = buildCtx({ candles, pivots, allPeaks: pivots, allValleys: [] });
		detectTriples(ctx);

		const rejected = ctx.debugCandidates.find((d) => d.type === 'triple_top' && d.reason === 'valleys_missing');
		expect(rejected).toBeDefined();
	});

	it('3山の等高差が tolerance 超 → peaks_not_equal で通常は不検出', () => {
		// peak1=100, peak2=100, peak3=115 → nearAll fails (15/115=0.13 > 0.04)
		const { candles, pivots } = buildTripleTop({ peak: 100, peak2Price: 100, peak3Price: 115 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectTriples(ctx);

		const tt = result.patterns.filter((p) => p.type === 'triple_top' && !p._fallback);
		expect(tt).toHaveLength(0);
	});

	// ── Triple Bottom（完成済み）────────────────────────────

	it('3谷等安 + 等高山 + ネックライン上抜け → triple_bottom completed 検出', () => {
		const { candles, pivots } = buildTripleBottom({ withBreakout: true });
		const ctx = buildCtx({ candles, pivots });
		const result = detectTriples(ctx);

		const tb = result.patterns.filter((p) => p.type === 'triple_bottom');
		expect(tb.length).toBeGreaterThanOrEqual(1);
		expect(tb[0]?.status).toBe('completed');
		expect(tb[0]?.breakoutDirection).toBe('up');
		expect(tb[0]?.outcome).toBe('success');
		expect(tb[0]?.breakoutBarIndex).toBeDefined();
		expect(tb[0]?.confirmation).toMatchObject({ type: 'neckline_breakout' });
		expect(tb[0]?.confidence).toBeGreaterThan(0);
		expect(tb[0]?.neckline).toBeDefined();
		expect(tb[0]?.breakoutTarget).toBeDefined();
		expect(tb[0]?.targetMethod).toBe('neckline_projection');
	});

	it('Triple Bottom ターゲット価格 = neckline + (neckline - avgValley)', () => {
		// nlAvg=(120+120)/2=120, avgValley=100, target=120+(120-100)=140
		const { candles, pivots } = buildTripleBottom({ valley: 100, peak: 120, withBreakout: true });
		const ctx = buildCtx({ candles, pivots });
		const result = detectTriples(ctx);

		const tb = result.patterns.find((p) => p.type === 'triple_bottom');
		expect(tb?.breakoutTarget).toBe(140);
	});

	it('3谷構造のみ（ブレイクなし） + includeForming=true → near_completion', () => {
		const { candles, pivots } = buildTripleBottom();
		const ctx = buildCtx({ candles, pivots, includeForming: true });
		const result = detectTriples(ctx);

		const tb = result.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'near_completion');
		expect(tb.length).toBeGreaterThanOrEqual(1);
		expect(tb[0]?.confirmation).toMatchObject({ type: 'not_confirmed' });
		expect(tb[0]?.breakoutDirection).toBeUndefined();
		expect(tb[0]?.outcome).toBeUndefined();
		expect(tb[0]?.breakoutBarIndex).toBeUndefined();
	});

	it('3谷構造のみ（ブレイクなし） + includeForming=false → 未検出', () => {
		const { candles, pivots } = buildTripleBottom();
		const ctx = buildCtx({ candles, pivots, includeForming: false });
		const result = detectTriples(ctx);

		const tb = result.patterns.filter((p) => p.type === 'triple_bottom');
		expect(tb).toHaveLength(0);
	});

	it('山のネックライン傾斜が急すぎ → neckline_slope_excess rejected', () => {
		// peaksNear が true (slope=0.030 ≤ tol=0.04) かつ necklineValid が false (0.030 > 0.02)
		// p1=120, p2=123.7 → |3.7|/123.7 ≈ 0.030 ∈ (0.02, 0.04]
		const { candles, pivots } = buildTripleBottom({ p1Price: 120, p2Price: 123.7 });
		const ctx = buildCtx({ candles, pivots });
		detectTriples(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_bottom' && d.accepted === false && d.reason === 'neckline_slope_excess',
		);
		expect(rejected).toBeDefined();
	});

	it('2谷目と1谷目の間に山がない → peaks_missing rejected', () => {
		const candles: CandleData[] = Array.from({ length: 50 }, (_, i) => mkCandle(50 - i, 90, 115, 95, 100));
		candles[0] = mkCandle(50, 100, 102, 99, 100);
		candles[20] = mkCandle(30, 100, 102, 99, 100);
		candles[40] = mkCandle(10, 100, 102, 99, 100);

		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L' },
			{ idx: 20, price: 100, kind: 'L' },
			{ idx: 40, price: 100, kind: 'L' },
		];
		const ctx = buildCtx({ candles, pivots, allPeaks: [], allValleys: pivots });
		detectTriples(ctx);

		const rejected = ctx.debugCandidates.find((d) => d.type === 'triple_bottom' && d.reason === 'peaks_missing');
		expect(rejected).toBeDefined();
	});

	it('谷スプレッド超過 → valley_spread_excess rejected', () => {
		// v1=100, v2=101, v3=103 → spread=(103-100)/100=3% > 1.5%
		const { candles, pivots } = buildTripleBottom({ valley: 100, v2Price: 101, v3Price: 103 });
		const ctx = buildCtx({ candles, pivots });
		detectTriples(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_bottom' && d.accepted === false && d.reason === 'valley_spread_excess',
		);
		expect(rejected).toBeDefined();
	});

	// ── want フィルタ ────────────────────────────────────────

	it('want に triple_top のみ → triple_bottom は検出しない', () => {
		const { candles, pivots } = buildTripleBottom();
		const ctx = buildCtx({ candles, pivots, want: new Set(['triple_top']) });
		const result = detectTriples(ctx);

		const tb = result.patterns.filter((p) => p.type === 'triple_bottom');
		expect(tb).toHaveLength(0);
	});

	it('want に triple_bottom のみ → triple_top は検出しない', () => {
		const { candles, pivots } = buildTripleTop();
		const ctx = buildCtx({ candles, pivots, want: new Set(['triple_bottom']) });
		const result = detectTriples(ctx);

		const tt = result.patterns.filter((p) => p.type === 'triple_top');
		expect(tt).toHaveLength(0);
	});

	// ── Relaxed fallback ─────────────────────────────────────

	it('strict 不検出 → relaxed (x1.25) + ブレイクで Triple Top フォールバック検出', () => {
		// 24 日間（periodScoreDays=0.9 区分）に 3 山 2 谷 + ブレイクを配置。
		// peak3=105 → diff/max=5/105=0.0476 > strict(0.04) だが ≤ 0.05(x1.25) で relaxed が起動。
		const total = 32;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 75, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[6] = mkCandle(total - 6, 81, 83, 80, 81);
		candles[12] = mkCandle(total - 12, 99, 100, 97, 99);
		candles[18] = mkCandle(total - 18, 81, 83, 80, 81);
		candles[24] = mkCandle(total - 24, 104, 105, 102, 104);
		// ネックライン（=80）を 1.5% 以上下抜け
		for (let i = 25; i < total; i++) {
			candles[i] = mkCandle(total - i, 70, 71, 68, 70);
		}
		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 6, price: 80, kind: 'L' },
			{ idx: 12, price: 100, kind: 'H' },
			{ idx: 18, price: 80, kind: 'L' },
			{ idx: 24, price: 105, kind: 'H' },
		];
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectTriples(ctx);

		const tt = result.patterns.filter((p) => p.type === 'triple_top');
		expect(tt.length).toBeGreaterThanOrEqual(1);
		expect(tt[0]?._fallback).toMatch(/relaxed_triple/);
		expect(tt[0]?.status).toBe('completed');
		expect(tt[0]?.breakoutDirection).toBe('down');
	});

	it('strict 不検出 → relaxed (x1.25) + ブレイクで Triple Bottom フォールバック検出', () => {
		// 24 日間に 3 谷 2 山 + ブレイクを配置。
		// valley3=95 → diff/max=5/100=0.05 > strict(0.04) だが ≤ 0.05(x1.25) で relaxed が起動。
		const total = 32;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 105, 115, 95, 105));
		candles[0] = mkCandle(total, 101, 102, 99, 101);
		candles[6] = mkCandle(total - 6, 119, 120, 118, 119);
		candles[12] = mkCandle(total - 12, 101, 102, 99, 101);
		candles[18] = mkCandle(total - 18, 119, 120, 118, 119);
		candles[24] = mkCandle(total - 24, 96, 97, 95, 96);
		// ネックライン（=120）を 1.5% 以上上抜け
		for (let i = 25; i < total; i++) {
			candles[i] = mkCandle(total - i, 132, 133, 131, 132);
		}
		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L' },
			{ idx: 6, price: 120, kind: 'H' },
			{ idx: 12, price: 100, kind: 'L' },
			{ idx: 18, price: 120, kind: 'H' },
			{ idx: 24, price: 95, kind: 'L' },
		];
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectTriples(ctx);

		const tb = result.patterns.filter((p) => p.type === 'triple_bottom');
		expect(tb.length).toBeGreaterThanOrEqual(1);
		expect(tb[0]?._fallback).toMatch(/relaxed_triple/);
		expect(tb[0]?.status).toBe('completed');
		expect(tb[0]?.breakoutDirection).toBe('up');
	});

	// ── 形成中 Triple Top ───────────────────────────────────

	it('includeForming=true + 2確定ピーク + 現在価格がピーク付近 → forming triple_top 検出', () => {
		// allPeaks: [{idx:0,100}, {idx:20,101}], allValleys: [{idx:10,80}, {idx:32,81}]
		// lastIdx=50, close=99（avgPeak=100.5 付近）
		// peak2 と現在足の間にも valley を置き、ネックライン構成点 2 つを満たす。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		candles[32] = mkCandle(total - 32, 80, 82, 80, 81);
		// 現在価格をピーク付近に設定
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 20, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [
			{ idx: 10, price: 80, kind: 'L' },
			{ idx: 32, price: 81, kind: 'L' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming.length).toBeGreaterThanOrEqual(1);
		expect(forming[0]?.completionPct).toBeDefined();
		expect(forming[0]?.breakoutTarget).toBeDefined();
		// forming triple は confidence 上限が抑えられている（標準的扱い禁止）。
		expect(forming[0]?.confidence).toBeLessThanOrEqual(0.59);
	});

	// ── 形成中 Triple Bottom ─────────────────────────────────

	it('includeForming=true + 2確定谷 + 現在価格が谷水準に再到達 → forming triple_bottom 検出', () => {
		// allValleys: [{idx:0,100}, {idx:20,101}], allPeaks: [{idx:10,120}, {idx:32,119}]
		// lastIdx=50, close=100（valley 水準に再到達=3 谷目候補として現在価格を扱う）
		// valley2 と現在足の間にも peak を置き、ネックライン構成点 2 つを満たす。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 105, 115, 100, 110));
		candles[0] = mkCandle(total, 100, 102, 99, 101);
		candles[10] = mkCandle(total - 10, 119, 120, 118, 119);
		candles[20] = mkCandle(total - 20, 100, 102, 100, 101);
		candles[32] = mkCandle(total - 32, 118, 119, 117, 118);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 101, 103, 99, 100);
		}

		const allValleys: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L' },
			{ idx: 20, price: 101, kind: 'L' },
		];
		const allPeaks: Pivot[] = [
			{ idx: 10, price: 120, kind: 'H' },
			{ idx: 32, price: 119, kind: 'H' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'forming');
		expect(forming.length).toBeGreaterThanOrEqual(1);
		expect(forming[0]?.completionPct).toBeDefined();
		expect(forming[0]?.breakoutTarget).toBeDefined();
		// forming triple は confidence 上限が抑えられている（標準的扱い禁止）。
		expect(forming[0]?.confidence).toBeLessThanOrEqual(0.59);
	});

	// ── 形成中 Triple Top: 階段状切り上がり / 谷乖離の reject ──
	//
	// 再現シナリオ（実環境で発覚した誤検出）:
	//   peak1=11,762,787 → peak2=12,353,404 → currentPrice=12,820,448 と切り上がり、
	//   valley1=10,577,064 と valley2=12,000,002 で大きく乖離。
	//   旧実装ではこれを triple_top forming として整合度 0.71 で「標準的」扱いしていた。
	//   山と谷の水平性チェック・階段ステップチェックを入れて reject されることを検証する。

	it('forming triple_top: 3 山が単調に切り上がる場合は forming_stair_step_up で reject', () => {
		// peak1=100, peak2=100.5, currentPrice=104 → 階段状の切り上がり。
		// peakDiff=0.5/100.5=0.50%、currentDiff=3.75/100.25=3.74% で
		// tripleTolerancePct=0.04*1.2=0.048 を通過するが、stair-step ステップ
		// = (104-100)/100 = 4.0% > FORMING_STAIR_STEP_LIMIT(2%) で reject される。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 85, 90));
		candles[0] = mkCandle(total, 99, 100, 98, 99);
		candles[10] = mkCandle(total - 10, 80, 82, 79, 80);
		candles[20] = mkCandle(total - 20, 99.5, 100.5, 99, 100);
		candles[32] = mkCandle(total - 32, 80, 82, 79, 81);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 103, 105, 102, 104);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 20, price: 100.5, kind: 'H' },
		];
		const allValleys: Pivot[] = [
			{ idx: 10, price: 80, kind: 'L' },
			{ idx: 32, price: 81, kind: 'L' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		// triple_top forming が検出されないこと（ユーザー報告の誤検出パターンの本質）
		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);
		// 階段状切り上がりが reject 理由として記録されていること
		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_top' && d.accepted === false && d.reason === 'forming_stair_step_up',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_top: 3 山の累計 spread が tripleTolerancePct を超えると forming_peaks_not_level で reject', () => {
		// 階段ではないが（peak1 < peak2 > current で V 字）、3 点累計 spread が大きいケース。
		// peak1=100, peak2=105, current=99 → spread=(105-99)/105≈5.71% > tripleTolerancePct=4.8%。
		// 早期 peakDiff（5/105=4.76% < 4.8%）と currentDiff（3.5/102.5=3.41% < 4.8%）は通過させ、
		// stair-step も V 字配置なので発火しない → level check が確実に発火することを検証する。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 85, 90));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 104, 105, 102, 104);
		candles[32] = mkCandle(total - 32, 80, 82, 80, 81);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 20, price: 105, kind: 'H' },
		];
		const allValleys: Pivot[] = [
			{ idx: 10, price: 80, kind: 'L' },
			{ idx: 32, price: 81, kind: 'L' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			tolerancePct: 0.04, // tripleTolerancePct=4.8%, levelSpreadLimit=4.8% → 5.71% で reject
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);
		// 別経路（早期 peakDiff / currentDiff silent reject）で落ちていないことを担保するため
		// 明示的に reason を assert する。
		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_top' && d.accepted === false && d.reason === 'forming_peaks_not_level',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_top: 谷の乖離が大きいと forming_neckline_not_horizontal で reject', () => {
		// 3 山は水平だが、valleys が 10.58M と 12.00M で乖離（spread = 11.83%）。
		// tolerancePct=0.04（necklineSpreadLimit=4%）→ reject。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) =>
			mkCandle(total - i, 12000000, 12200000, 11800000, 12000000),
		);
		candles[0] = mkCandle(total, 12349999, 12350000, 12349000, 12349999);
		candles[10] = mkCandle(total - 10, 10577063, 10577064, 10577000, 10577063);
		candles[20] = mkCandle(total - 20, 12350000, 12350001, 12349000, 12350000);
		candles[32] = mkCandle(total - 32, 12000001, 12000002, 12000000, 12000001);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 12350000, 12351000, 12349000, 12350000);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 12350000, kind: 'H' },
			{ idx: 20, price: 12350000, kind: 'H' },
		];
		const allValleys: Pivot[] = [
			{ idx: 10, price: 10577064, kind: 'L' },
			{ idx: 32, price: 12000002, kind: 'L' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			tolerancePct: 0.04,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_top' && d.accepted === false && d.reason === 'forming_neckline_not_horizontal',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_top: peak1 と現在足の間に valley が 1 個しかないと forming_neckline_points_insufficient で reject', () => {
		// 3 山水平、谷も水平だが valley が 1 個しかない → ネックライン構成点不足で reject。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 20, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [{ idx: 10, price: 80, kind: 'L' }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_top' && d.accepted === false && d.reason === 'forming_neckline_points_insufficient',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_top: 2 谷が両方 peak1-peak2 間にあり peak2-現在足 間に谷がない場合は reject', () => {
		// 谷の合計数は 2 だが構造的に H-L-L-H- となっており、H-L-H-L-(現在足) ではない。
		// peak1-peak2 区間内に v 2 つ、peak2-現在足 区間に v 0 つ。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[6] = mkCandle(total - 6, 79, 81, 79, 80);
		candles[14] = mkCandle(total - 14, 80, 82, 80, 81);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		// peak2(20) と lastIdx(50) の間には valley を置かない
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 20, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [
			{ idx: 6, price: 80, kind: 'L' },
			{ idx: 14, price: 81, kind: 'L' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_top' && d.accepted === false && d.reason === 'forming_neckline_points_insufficient',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_top: 2 谷が両方 peak2-現在足 間にあり peak1-peak2 間に谷がない場合も reject', () => {
		// 対称ケース: peak1-peak2 区間に v 0 つ、peak2-現在足 区間に v 2 つ。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		candles[28] = mkCandle(total - 28, 79, 81, 79, 80);
		candles[36] = mkCandle(total - 36, 80, 82, 80, 81);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 20, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [
			{ idx: 28, price: 80, kind: 'L' },
			{ idx: 36, price: 81, kind: 'L' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_top' && d.accepted === false && d.reason === 'forming_neckline_points_insufficient',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_top: 2 valley が両方とも peak1〜peak2 区間に偏ると forming_neckline_points_insufficient で reject', () => {
		// 合計 2 valley あるが、peak2〜現在足 区間に 1 つも valley が無い「H-L-L-H-」構造。
		// triple_top は H-L-H-L-H が必要なので、区間別に最低 1 つを要求して reject されることを検証。
		// 旧実装（valleysBetween.length >= 2 のみ）はこの構造を通してしまっていた。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[5] = mkCandle(total - 5, 79, 81, 79, 80);
		candles[15] = mkCandle(total - 15, 80, 82, 80, 81);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 20, price: 101, kind: 'H' },
		];
		// 2 valley とも peak1(idx=0) と peak2(idx=20) の間に存在し、peak2 以降には無い
		const allValleys: Pivot[] = [
			{ idx: 5, price: 80, kind: 'L' },
			{ idx: 15, price: 81, kind: 'L' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_top' && d.accepted === false && d.reason === 'forming_neckline_points_insufficient',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_top: 確定 pivot は 2 個（pivots.length === 2）で 3 点目は未確定であることを示す', () => {
		// LLM が pivots だけ見て 3 山構造と誤読しないよう、forming は 2 確定 pivot のみ返す。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		candles[32] = mkCandle(total - 32, 80, 82, 80, 81);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 20, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [
			{ idx: 10, price: 80, kind: 'L' },
			{ idx: 32, price: 81, kind: 'L' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.find((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toBeDefined();
		expect(Array.isArray(forming?.pivots) ? forming.pivots.length : -1).toBe(2);
	});

	// ── 形成中 Triple Bottom: 階段状切り下がり / 山乖離の reject（対称ケース）──

	it('forming triple_bottom: 3 谷が単調に切り下がる場合は forming_stair_step_down で reject', () => {
		// triple_top の対称: valley1=102, valley2=100, currentPrice=99 → 切り下がり。
		// 全体ステップ = (102-99)/102 ≈ 2.94% で FORMING_STAIR_STEP_LIMIT=2% を超過。
		// 早期 valleyDiff（|102-100|/102 = 1.96%）と currentDiff（|99-101|/101 = 1.98%）は
		// tripleTolerancePct=4.8% 以下で通過するため、stair-step で reject されることを検証。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 105, 115, 95, 105));
		candles[0] = mkCandle(total, 101, 102, 100, 102);
		candles[10] = mkCandle(total - 10, 109, 110, 108, 109);
		candles[20] = mkCandle(total - 20, 99, 101, 99, 100);
		candles[32] = mkCandle(total - 32, 109, 110, 108, 109);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 99, 101, 98, 99);
		}

		const allValleys: Pivot[] = [
			{ idx: 0, price: 102, kind: 'L' },
			{ idx: 20, price: 100, kind: 'L' },
		];
		const allPeaks: Pivot[] = [
			{ idx: 10, price: 110, kind: 'H' },
			{ idx: 32, price: 110, kind: 'H' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'forming');
		expect(forming).toHaveLength(0);
		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_bottom' && d.accepted === false && d.reason === 'forming_stair_step_down',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_bottom: 山の乖離が大きいと forming_neckline_not_horizontal で reject', () => {
		// 3 谷は水平だが、ネックライン構成 peak が大きく乖離（例: 110 と 130）。
		// spread=(130-110)/130 ≈ 15.4% > necklineSpreadLimit=4% → reject。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 105, 115, 95, 105));
		candles[0] = mkCandle(total, 100, 102, 99, 101);
		candles[10] = mkCandle(total - 10, 109, 110, 108, 109);
		candles[20] = mkCandle(total - 20, 100, 102, 99, 101);
		candles[32] = mkCandle(total - 32, 129, 130, 128, 129);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 114, 116, 113, 115);
		}

		const allValleys: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L' },
			{ idx: 20, price: 100, kind: 'L' },
		];
		const allPeaks: Pivot[] = [
			{ idx: 10, price: 110, kind: 'H' },
			{ idx: 32, price: 130, kind: 'H' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_bottom' && d.accepted === false && d.reason === 'forming_neckline_not_horizontal',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_bottom: valley1 と現在足の間に peak が 1 個しかないと forming_neckline_points_insufficient で reject', () => {
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 105, 115, 100, 110));
		candles[0] = mkCandle(total, 100, 102, 99, 101);
		candles[10] = mkCandle(total - 10, 119, 120, 118, 119);
		candles[20] = mkCandle(total - 20, 100, 102, 100, 101);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 114, 116, 113, 115);
		}

		const allValleys: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L' },
			{ idx: 20, price: 101, kind: 'L' },
		];
		const allPeaks: Pivot[] = [{ idx: 10, price: 120, kind: 'H' }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_bottom' && d.accepted === false && d.reason === 'forming_neckline_points_insufficient',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_bottom: 2 山が両方 valley1-valley2 間にあり valley2-現在足 間に山がない場合は reject', () => {
		// 山の合計数は 2 だが構造的に L-H-H-L- となっており、L-H-L-H-(現在足) ではない。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 105, 115, 100, 110));
		candles[0] = mkCandle(total, 100, 102, 99, 101);
		candles[6] = mkCandle(total - 6, 119, 120, 118, 119);
		candles[14] = mkCandle(total - 14, 118, 119, 117, 118);
		candles[20] = mkCandle(total - 20, 100, 102, 100, 101);
		// valley2(20) と lastIdx(50) の間には peak を置かない
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 101, 103, 99, 100);
		}

		const allValleys: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L' },
			{ idx: 20, price: 101, kind: 'L' },
		];
		const allPeaks: Pivot[] = [
			{ idx: 6, price: 120, kind: 'H' },
			{ idx: 14, price: 119, kind: 'H' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_bottom' && d.accepted === false && d.reason === 'forming_neckline_points_insufficient',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_bottom: 2 山が両方 valley2-現在足 間にあり valley1-valley2 間に山がない場合も reject', () => {
		// 対称ケース: valley1-valley2 区間に p 0 つ、valley2-現在足 区間に p 2 つ。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 105, 115, 100, 110));
		candles[0] = mkCandle(total, 100, 102, 99, 101);
		candles[20] = mkCandle(total - 20, 100, 102, 100, 101);
		candles[28] = mkCandle(total - 28, 119, 120, 118, 119);
		candles[36] = mkCandle(total - 36, 118, 119, 117, 118);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 101, 103, 99, 100);
		}

		const allValleys: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L' },
			{ idx: 20, price: 101, kind: 'L' },
		];
		const allPeaks: Pivot[] = [
			{ idx: 28, price: 120, kind: 'H' },
			{ idx: 36, price: 119, kind: 'H' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_bottom' && d.accepted === false && d.reason === 'forming_neckline_points_insufficient',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_bottom: 確定 pivot は 2 個（pivots.length === 2）で 3 点目は未確定であることを示す', () => {
		// 現在価格を valley 水準に置き、forming triple_bottom として検出させる。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 105, 115, 100, 110));
		candles[0] = mkCandle(total, 100, 102, 99, 101);
		candles[10] = mkCandle(total - 10, 119, 120, 118, 119);
		candles[20] = mkCandle(total - 20, 100, 102, 100, 101);
		candles[32] = mkCandle(total - 32, 118, 119, 117, 118);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 101, 103, 99, 100);
		}

		const allValleys: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L' },
			{ idx: 20, price: 101, kind: 'L' },
		];
		const allPeaks: Pivot[] = [
			{ idx: 10, price: 120, kind: 'H' },
			{ idx: 32, price: 119, kind: 'H' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.find((p) => p.type === 'triple_bottom' && p.status === 'forming');
		expect(forming).toBeDefined();
		expect(Array.isArray(forming?.pivots) ? forming.pivots.length : -1).toBe(2);
	});

	it('includeForming=false では forming / near_completion パターンは返さない', () => {
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		for (let i = 45; i < total; i++) candles[i] = mkCandle(total - i, 98, 100, 97, 99);

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 20, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [{ idx: 10, price: 80, kind: 'L' }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: false,
		});
		const result = detectTriples(ctx);

		const unfinished = result.patterns.filter((p) => p.status === 'forming' || p.status === 'near_completion');
		expect(unfinished).toHaveLength(0);
	});

	// ── 間隔不足 ─────────────────────────────────────────────

	it('H ピーク間隔 < minDist(5) → triple_top スキップ', () => {
		// highsOnly が [idx=0, idx=3, idx=6] → b.idx-a.idx=3 < 5 → continue
		const candles: CandleData[] = Array.from({ length: 15 }, (_, i) => mkCandle(15 - i, 85, 95, 75, 85));
		candles[0] = mkCandle(15, 99, 100, 97, 99);
		candles[3] = mkCandle(12, 99, 100, 97, 99);
		candles[6] = mkCandle(9, 99, 100, 97, 99);

		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 3, price: 100, kind: 'H' },
			{ idx: 6, price: 100, kind: 'H' },
		];
		const ctx = buildCtx({ candles, pivots, allPeaks: pivots, allValleys: [] });
		const result = detectTriples(ctx);
		const tt = result.patterns.filter((p) => p.type === 'triple_top');
		expect(tt).toHaveLength(0);
	});

	// ── 形成中の patternDays 計算（時間軸スケーリング）──────────────
	//
	// 旧実装: daysPerBar = ctx.type === '1day' ? 1 : ctx.type === '1week' ? 7 : 1
	// → 1hour/1month/1min が全部 1 扱いになり、patternDays が完全にズレていた。
	// 新実装: helpers.ts の daysPerBar(tf) で正しく換算する。

	it('1hour: 30 バーで形成中 triple_top が patternDays 期間判定を通過する', () => {
		// 1hour で 30 バー = 約 1.25 日。FORMING_MIN_DAYS=21 / FORMING_MAX_DAYS=90 を
		// 旧コード（daysPerBar=1 扱い）では 30 と判定して通過していたが、新実装は
		// 30 * (1/24) ≈ 1 日と正しく評価して FORMING_MIN_DAYS=21 を下回ることで弾く。
		const total = 31;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		for (let i = 28; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 20, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [{ idx: 10, price: 80, kind: 'L' }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1hour',
		});
		const result = detectTriples(ctx);

		// 1.25 日相当 < FORMING_MIN_DAYS(21) なので form は弾かれる（intraday の短期間判定）
		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);
	});

	it('1hour: 720 バー（約 30 日）あれば形成中 triple_top の期間判定を通過する', () => {
		// 720 バー × (1/24) = 30 日 ∈ [21, 90] → patternDays チェック OK
		const total = 720;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		// 2 つ確定済みピークと 2 つの確定済み谷（ネックライン構成）
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[300] = mkCandle(total - 300, 79, 81, 79, 80);
		candles[600] = mkCandle(total - 600, 100, 101, 99, 100);
		candles[660] = mkCandle(total - 660, 80, 82, 80, 81);
		for (let i = total - 5; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 600, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [
			{ idx: 300, price: 80, kind: 'L' },
			{ idx: 660, price: 81, kind: 'L' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1hour',
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming.length).toBeGreaterThanOrEqual(1);
	});

	it('1week: 4 バーで形成中 triple_top は期間判定を通過しない（28 日 > MIN だが構造的に短い）', () => {
		// 4 バー × 7 日/バー = 28 日 ∈ [21, 90] → patternDays は通る
		// だが minDist=5 で 2 つのピーク間距離が足りないので構造的に成立しない。
		const total = 7;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[2] = mkCandle(total - 2, 79, 81, 79, 80);
		candles[4] = mkCandle(total - 4, 100, 101, 99, 100);
		for (let i = 6; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 4, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [{ idx: 2, price: 80, kind: 'L' }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1week',
		});
		const result = detectTriples(ctx);

		// minDist(5) > 4 なのでスキップされる
		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);
	});

	it('1week: 8 バー（56 日）で形成中 triple_top が patternDays 判定を通過する', () => {
		// 8 バー × 7 日/バー = 56 日 ∈ [21, 90] → OK
		// 旧コード（1week → daysPerBar=7）でも同じ結論。新コードでも維持される。
		// 構造制約: confirmedPeaks フィルタ idx < lastIdx-2 と minDist=5 を両立するため
		// total=9, peak1=0, peak2=5 とする（peak2=5 < 6=lastIdx-2 OK, 5-0=5 >= minDist=5 OK）。
		// ネックライン構成点 2 つを満たすため valley を 2 つ配置（idx=3 と idx=6）。
		const total = 9;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[3] = mkCandle(total - 3, 79, 81, 79, 80);
		candles[5] = mkCandle(total - 5, 100, 101, 99, 100);
		candles[6] = mkCandle(total - 6, 80, 82, 80, 81);
		for (let i = 7; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 5, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [
			{ idx: 3, price: 80, kind: 'L' },
			{ idx: 6, price: 81, kind: 'L' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1week',
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming.length).toBeGreaterThanOrEqual(1);
	});

	it('1month: 4 バー（120 日）は FORMING_MAX_DAYS(90) 超で patternDays 判定不可', () => {
		// 旧コードでは type !== 1day && type !== 1week なので daysPerBar=1 扱い
		// 4 * 1 = 4 日と判定して FORMING_MIN_DAYS(21) を下回り NG（理由が誤）
		// 新コードでは 4 * 30 = 120 日 > FORMING_MAX_DAYS(90) で正しく NG。
		const total = 7;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[2] = mkCandle(total - 2, 79, 81, 79, 80);
		candles[4] = mkCandle(total - 4, 100, 101, 99, 100);
		for (let i = 6; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 4, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [{ idx: 2, price: 80, kind: 'L' }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1month',
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);
	});

	it('1month vs 1day: 同一バー数（25 本）なら 1day では検出されるが 1month では弾かれる（daysPerBar の効果）', () => {
		// 旧コード（1month → daysPerBar=1）では、type='1month' でも 1day と同じ
		// patternDays=25 と評価して誤って検出していた。
		// 新コードでは daysPerBar(1month)=30 を介して patternDays=750 と評価し、
		// FORMING_MAX_DAYS=90 を超えるため正しく拒否される。
		// ネックライン構成点 2 つを満たすため valley を 2 つ配置。
		const total = 26;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		candles[22] = mkCandle(total - 22, 80, 82, 80, 81);
		for (let i = 23; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 20, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [
			{ idx: 10, price: 80, kind: 'L' },
			{ idx: 22, price: 81, kind: 'L' },
		];

		const ctx1day = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1day',
		});
		const ctx1month = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1month',
		});
		const result1day = detectTriples(ctx1day);
		const result1month = detectTriples(ctx1month);

		const forming1day = result1day.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		const forming1month = result1month.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');

		expect(forming1day.length).toBeGreaterThanOrEqual(1);
		expect(forming1month).toHaveLength(0);
	});
});
