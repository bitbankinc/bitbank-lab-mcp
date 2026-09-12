import { describe, expect, it } from 'vitest';
import { dayjs } from '../lib/datetime.js';
import { getHsShoulderMaxPctForTf, getSizeThresholdsForTf } from '../tools/patterns/config.js';
import { detectDoubles } from '../tools/patterns/detect_doubles.js';
import { linearRegressionWithR2 } from '../tools/patterns/regression.js';
import type { Pivot } from '../tools/patterns/swing.js';
import type { CandleData, DetectContext } from '../tools/patterns/types.js';

// ── ヘルパー ──

function iso(daysAgo: number): string {
	return dayjs().subtract(daysAgo, 'day').startOf('day').toISOString();
}

/** ベースライン candle を生成 */
function mkCandle(daysAgo: number, o: number, h: number, l: number, c: number): CandleData {
	return { open: o, high: h, low: l, close: c, isoTime: iso(daysAgo) };
}

/** DetectContext を組み立てる */
function buildCtx(opts: {
	candles: CandleData[];
	pivots: Pivot[];
	allPeaks?: Pivot[];
	allValleys?: Pivot[];
	tolerancePct?: number;
	want?: Set<string>;
	includeForming?: boolean;
	type?: string;
	/** 最小ピボット間隔。既定 5 は旧 `MIN_PIVOT_DISTANCE_BARS` と同値（既存ケースの挙動を保つ）。 */
	minDist?: number;
}): DetectContext {
	const tol = opts.tolerancePct ?? 0.04;
	return {
		candles: opts.candles,
		pivots: opts.pivots,
		allPeaks: opts.allPeaks ?? opts.pivots.filter((p) => p.kind === 'H'),
		allValleys: opts.allValleys ?? opts.pivots.filter((p) => p.kind === 'L'),
		tolerancePct: tol,
		headProminencePct: tol,
		minDist: opts.minDist ?? 5,
		want: opts.want ?? new Set(),
		includeForming: opts.includeForming ?? false,
		debugCandidates: [],
		type: opts.type ?? '1day',
		sizeThresholds: getSizeThresholdsForTf(opts.type ?? '1day'),
		hsShoulderMaxPct: getHsShoulderMaxPctForTf(opts.type ?? '1day'),
		swingDepth: 7,
		near: (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * tol,
		pct: (a: number, b: number) => ((b - a) / Math.max(1, a)) * 100,
		lrWithR2: (pts) => linearRegressionWithR2(pts),
	};
}

/**
 * ダブルトップのローソク足とピボットを生成:
 * peak1(idx=0) → valley(idx=10) → peak2(idx=20) → breakout(idx=25)
 */
function buildDoubleTop(opts?: { peak1?: number; valley?: number; peak2?: number; breakoutClose?: number }) {
	const p1 = opts?.peak1 ?? 200;
	const v = opts?.valley ?? 170;
	const p2 = opts?.peak2 ?? 200;
	const brk = opts?.breakoutClose ?? 160; // < neckline(170) * 0.985

	const candles: CandleData[] = [];
	// idx 0-4: peak1 付近
	for (let i = 0; i < 5; i++) candles.push(mkCandle(50 - i, p1 - 2, p1, p1 - 5, p1 - 2));
	// idx 5-9: 下落
	for (let i = 0; i < 5; i++) {
		const price = p1 - ((p1 - v) * (i + 1)) / 5;
		candles.push(mkCandle(45 - i, price + 2, price + 5, price - 2, price));
	}
	// idx 10-14: valley 付近
	for (let i = 0; i < 5; i++) candles.push(mkCandle(40 - i, v + 2, v + 5, v, v + 2));
	// idx 15-19: 上昇
	for (let i = 0; i < 5; i++) {
		const price = v + ((p2 - v) * (i + 1)) / 5;
		candles.push(mkCandle(35 - i, price - 2, price + 2, price - 5, price));
	}
	// idx 20-24: peak2 付近
	for (let i = 0; i < 5; i++) candles.push(mkCandle(30 - i, p2 - 2, p2, p2 - 5, p2 - 3));
	// idx 25-29: breakout（下落）
	for (let i = 0; i < 5; i++) candles.push(mkCandle(25 - i, brk + 5 - i, brk + 8 - i, brk - 2, brk));

	const pivots: Pivot[] = [
		{ idx: 0, price: p1, kind: 'H', extremePrice: p1 },
		{ idx: 10, price: v, kind: 'L', extremePrice: v },
		{ idx: 20, price: p2, kind: 'H', extremePrice: p2 },
		{ idx: 28, price: brk, kind: 'L', extremePrice: brk },
	];

	return { candles, pivots };
}

/**
 * ダブルボトムのローソク足とピボットを生成:
 * valley1(idx=0) → peak(idx=10) → valley2(idx=20) → breakout(idx=25)
 */
function buildDoubleBottom(opts?: { valley1?: number; peak?: number; valley2?: number; breakoutClose?: number }) {
	const v1 = opts?.valley1 ?? 100;
	const p = opts?.peak ?? 130;
	const v2 = opts?.valley2 ?? 100;
	const brk = opts?.breakoutClose ?? 140; // > neckline(130) * 1.015

	const candles: CandleData[] = [];
	// idx 0-4: valley1 付近
	for (let i = 0; i < 5; i++) candles.push(mkCandle(50 - i, v1 + 2, v1 + 5, v1, v1 + 2));
	// idx 5-9: 上昇
	for (let i = 0; i < 5; i++) {
		const price = v1 + ((p - v1) * (i + 1)) / 5;
		candles.push(mkCandle(45 - i, price - 2, price + 2, price - 5, price));
	}
	// idx 10-14: peak 付近
	for (let i = 0; i < 5; i++) candles.push(mkCandle(40 - i, p - 2, p, p - 5, p - 2));
	// idx 15-19: 下落
	for (let i = 0; i < 5; i++) {
		const price = p - ((p - v2) * (i + 1)) / 5;
		candles.push(mkCandle(35 - i, price + 2, price + 5, price - 2, price));
	}
	// idx 20-24: valley2 付近
	for (let i = 0; i < 5; i++) candles.push(mkCandle(30 - i, v2 + 2, v2 + 5, v2, v2 + 2));
	// idx 25-29: breakout（上昇）
	for (let i = 0; i < 5; i++) candles.push(mkCandle(25 - i, brk - 3 + i, brk + 2, brk - 5, brk));

	const pivots: Pivot[] = [
		{ idx: 0, price: v1, kind: 'L', extremePrice: v1 },
		{ idx: 10, price: p, kind: 'H', extremePrice: p },
		{ idx: 20, price: v2, kind: 'L', extremePrice: v2 },
		{ idx: 28, price: brk, kind: 'H', extremePrice: brk },
	];

	return { candles, pivots };
}

describe('detectDoubles', () => {
	// ── ダブルトップ（完成済み） ─────────────────────────

	it('H-L-H パターンでネックライン下抜け → ダブルトップ検出', () => {
		const { candles, pivots } = buildDoubleTop();
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);

		const dt = result.patterns.filter((p) => p.type === 'double_top');
		expect(dt.length).toBeGreaterThanOrEqual(1);
		expect(dt[0].confidence).toBeGreaterThan(0);
		expect(dt[0].neckline).toBeDefined();
		expect(dt[0].breakout).toBeDefined();
		expect(dt[0].breakoutTarget).toBeDefined();
		expect(dt[0].targetMethod).toBe('neckline_projection');
		expect(dt[0].structureDiagram).toBeDefined();
		expect(result.found?.double_top).toBe(true);
	});

	it('ダブルトップのターゲット価格 = neckline - (avgPeak - neckline)', () => {
		const { candles, pivots } = buildDoubleTop({ peak1: 200, valley: 170, peak2: 200 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const dt = result.patterns.find((p) => p.type === 'double_top');

		if (dt) {
			// avgPeak=200, neckline=170, target = 170 - (200-170) = 140
			expect(dt.breakoutTarget).toBe(140);
		}
	});

	it('ネックライン未下抜け → ダブルトップ不検出（debugCandidates に no_breakout）', () => {
		// breakout close がネックライン以上 → 下抜けなし
		const { candles, pivots } = buildDoubleTop({ breakoutClose: 175 }); // > 170*0.985
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);

		const dt = result.patterns.filter((p) => p.type === 'double_top');
		expect(dt).toHaveLength(0);
		const noBreakout = ctx.debugCandidates.find((d) => d.type === 'double_top' && d.reason === 'no_breakout');
		expect(noBreakout).toBeDefined();
	});

	it('ピーク高さ差が tolerance 超 → peaks_not_equal', () => {
		// peak1=200, peak2=220 → 差10%、tolerance=4%
		const { candles, pivots } = buildDoubleTop({ peak1: 200, peak2: 220 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectDoubles(ctx);

		const dt = result.patterns.filter((p) => p.type === 'double_top');
		expect(dt).toHaveLength(0);
		const rejected = ctx.debugCandidates.find((d) => d.type === 'double_top' && d.reason === 'peaks_not_equal');
		expect(rejected).toBeDefined();
	});

	it('パターン高さ < 3% → pattern_too_small で除外', () => {
		// peak=100, valley=98 → 差2%（< 3%）
		const { candles, pivots } = buildDoubleTop({ peak1: 100, valley: 98, peak2: 100 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);

		const dt = result.patterns.filter((p) => p.type === 'double_top');
		expect(dt).toHaveLength(0);
		const tooSmall = ctx.debugCandidates.find((d) => d.type === 'double_top' && d.reason === 'pattern_too_small');
		expect(tooSmall).toBeDefined();
	});

	it('谷深さ < 5% → valley_too_shallow で除外', () => {
		// peak=200, valley=192 → depth=(200-192)/200=4%
		const { candles, pivots } = buildDoubleTop({ peak1: 200, valley: 192, peak2: 200 });
		const ctx = buildCtx({ candles, pivots });
		detectDoubles(ctx);

		const tooShallow = ctx.debugCandidates.find(
			(d) =>
				d.type === 'double_top' && (d.reason === 'valley_too_shallow' || d.reason === 'valley_too_shallow_relaxed'),
		);
		expect(tooShallow).toBeDefined();
	});

	// ── ダブルボトム（完成済み） ─────────────────────────

	it('L-H-L パターンでネックライン上抜け → ダブルボトム検出', () => {
		const { candles, pivots } = buildDoubleBottom();
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);

		const db = result.patterns.filter((p) => p.type === 'double_bottom');
		expect(db.length).toBeGreaterThanOrEqual(1);
		expect(db[0].confidence).toBeGreaterThan(0);
		expect(db[0].breakout).toBeDefined();
		expect(db[0].breakoutTarget).toBeDefined();
		expect(result.found?.double_bottom).toBe(true);
	});

	it('ダブルボトムのターゲット価格 = neckline + (neckline - avgValley)', () => {
		const { candles, pivots } = buildDoubleBottom({ valley1: 100, peak: 130, valley2: 100 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const db = result.patterns.find((p) => p.type === 'double_bottom');

		if (db) {
			// avgValley=100, neckline=130, target = 130 + (130-100) = 160
			expect(db.breakoutTarget).toBe(160);
		}
	});

	it('ネックライン未上抜け → ダブルボトム不検出', () => {
		const { candles, pivots } = buildDoubleBottom({ breakoutClose: 125 }); // < 130*1.015
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);

		const db = result.patterns.filter((p) => p.type === 'double_bottom');
		expect(db).toHaveLength(0);
		const noBreakout = ctx.debugCandidates.find((d) => d.type === 'double_bottom' && d.reason === 'no_breakout');
		expect(noBreakout).toBeDefined();
	});

	it('谷高さ差が tolerance 超 → valleys_not_equal', () => {
		const { candles, pivots } = buildDoubleBottom({ valley1: 100, valley2: 115 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		detectDoubles(ctx);

		const rejected = ctx.debugCandidates.find((d) => d.type === 'double_bottom' && d.reason === 'valleys_not_equal');
		expect(rejected).toBeDefined();
	});

	it('パターン高さ < 3% → double_bottom pattern_too_small', () => {
		const { candles, pivots } = buildDoubleBottom({ valley1: 100, peak: 102, valley2: 100 });
		const ctx = buildCtx({ candles, pivots });
		detectDoubles(ctx);

		const tooSmall = ctx.debugCandidates.find((d) => d.type === 'double_bottom' && d.reason === 'pattern_too_small');
		expect(tooSmall).toBeDefined();
	});

	it('山高さ < 5% → peak_too_shallow で除外', () => {
		const { candles, pivots } = buildDoubleBottom({ valley1: 100, peak: 104, valley2: 100 });
		const ctx = buildCtx({ candles, pivots });
		detectDoubles(ctx);

		const tooShallow = ctx.debugCandidates.find(
			(d) => d.type === 'double_bottom' && (d.reason === 'peak_too_shallow' || d.reason === 'peak_too_shallow_relaxed'),
		);
		expect(tooShallow).toBeDefined();
	});

	// ── want フィルタ ────────────────────────────────────

	it('want に無関係なパターンのみの場合は検出しない', () => {
		const { candles, pivots } = buildDoubleTop();
		// double_top/bottom 以外の want → 全体ブロックをスキップ
		const ctx = buildCtx({ candles, pivots, want: new Set(['head_and_shoulders']) });
		const result = detectDoubles(ctx);
		expect(result.patterns).toHaveLength(0);
	});

	// ── relaxed fallback ─────────────────────────────────

	it('通常判定で不検出 → relaxed (x1.3) で検出', () => {
		// tolerance=2%, peak差=5/205=2.44% → 通常は peaks_not_equal、relaxed(2%*1.3=2.6%)で検出。
		// relaxed の許容幅は DOUBLE_LEVEL_MAX_PCT(3%) の hard cap で頭打ちになるため、
		// cap を超える peak 差（旧 200/210 = 4.76%）では relaxed も必ず落ちる
		// （peaks_not_equal_structural）。差は cap 内に収める必要がある。
		const { candles, pivots } = buildDoubleTop({ peak1: 200, peak2: 205 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.02 });
		const result = detectDoubles(ctx);

		const dt = result.patterns.filter((p) => p.type === 'double_top');
		expect(dt.length).toBeGreaterThan(0);
		expect(dt[0]._fallback).toContain('relaxed');
		// 通常判定で一度弾かれてから relaxed に落ちたことを確認する
		expect(ctx.debugCandidates.some((d) => d.type === 'double_top' && d.reason === 'peaks_not_equal')).toBe(true);
	});

	it('relaxed fallback でダブルボトムを検出', () => {
		// tolerance=2%, valley差=2.5/102.5=2.44% → 通常は valleys_not_equal、relaxed(2.6%)で検出。
		// ダブルトップ側と同じく DOUBLE_LEVEL_MAX_PCT(3%) の hard cap 内に収める。
		const { candles, pivots } = buildDoubleBottom({ valley1: 100, valley2: 102.5, peak: 130, breakoutClose: 140 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.02 });
		const result = detectDoubles(ctx);

		const db = result.patterns.filter((p) => p.type === 'double_bottom');
		expect(db.length).toBeGreaterThan(0);
		expect(db[0]._fallback).toContain('relaxed');
		expect(ctx.debugCandidates.some((d) => d.type === 'double_bottom' && d.reason === 'valleys_not_equal')).toBe(true);
	});

	// ── ピボット不足 ─────────────────────────────────────

	it('ピボット < 3 個では空結果', () => {
		const candles = Array.from({ length: 30 }, (_, i) => mkCandle(30 - i, 100, 102, 98, 100));
		const pivots: Pivot[] = [
			{ idx: 0, price: 200, kind: 'H', extremePrice: 200 },
			{ idx: 10, price: 170, kind: 'L', extremePrice: 170 },
		];
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		expect(result.patterns).toHaveLength(0);
	});

	// ── 間隔不足 ─────────────────────────────────────────

	it('ピボット間隔 < ctx.minDist → スキップ', () => {
		const candles = Array.from({ length: 30 }, (_, i) => mkCandle(30 - i, 100, 102, 98, 100));
		const pivots: Pivot[] = [
			{ idx: 0, price: 200, kind: 'H', extremePrice: 200 },
			{ idx: 3, price: 170, kind: 'L', extremePrice: 170 }, // 間隔3 < ctx.minDist(5)
			{ idx: 6, price: 200, kind: 'H', extremePrice: 200 },
			{ idx: 9, price: 170, kind: 'L', extremePrice: 170 },
		];
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		expect(result.patterns).toHaveLength(0);
	});

	// ── issue #130: 偽陰性を生んでいた 3 点の回帰 ─────────

	describe('issue #130 の回帰', () => {
		/**
		 * **最小ピボット間隔は `ctx.minDist` を使う。**
		 *
		 * 以前は検出器ローカルの `MIN_PIVOT_DISTANCE_BARS = 5` が `ctx.minDist` を上書きしており、
		 * 公開パラメータ `minBarsBetweenSwings` が double にだけ効かなかった
		 * （`detect_triples` / `detect_hs` は当時から `ctx.minDist` を使っている）。
		 * 日足の既定は 4、1時間足は 2 なので、既定パラメータでも常に上書きが起きていた。
		 */
		it('間隔 3 本は minDist=5 では落ち、minDist=2 では検出される', () => {
			// valley1(idx=0, 100) → peak(idx=3, 130) → valley2(idx=6, 100) → breakout(idx=8〜, 140)
			const candles: CandleData[] = [
				mkCandle(30, 100, 105, 100, 100),
				mkCandle(29, 110, 115, 105, 110),
				mkCandle(28, 122, 127, 118, 122),
				mkCandle(27, 130, 135, 126, 130),
				mkCandle(26, 120, 125, 115, 120),
				mkCandle(25, 108, 113, 103, 108),
				mkCandle(24, 100, 105, 100, 100),
				mkCandle(23, 115, 120, 110, 115),
				mkCandle(22, 140, 145, 135, 140),
				...Array.from({ length: 8 }, (_, i) => mkCandle(21 - i, 142, 147, 137, 142)),
			];
			const pivots: Pivot[] = [
				{ idx: 0, price: 100, kind: 'L', extremePrice: 100 },
				{ idx: 3, price: 130, kind: 'H', extremePrice: 135 },
				{ idx: 6, price: 100, kind: 'L', extremePrice: 100 },
			];

			const strict = detectDoubles(buildCtx({ candles, pivots, minDist: 5 }));
			expect(strict.patterns.filter((p) => p.type === 'double_bottom')).toHaveLength(0);

			const loose = detectDoubles(buildCtx({ candles, pivots, minDist: 2 }));
			const db = loose.patterns.filter((p) => p.type === 'double_bottom');
			expect(db).toHaveLength(1);
			expect((db[0].pivots ?? []).map((v) => v.idx)).toEqual([0, 3, 6]);
		});

		/**
		 * **サイズ検査は `extremePrice`（高安）基準。**
		 *
		 * 終値が圧縮されヒゲが大きい区間では、終値基準の値幅が実際の 1/6 になる。
		 * この fixture は終値基準で `MIN_PATTERN_HEIGHT_PCT`(3%) / `MIN_DEPTH_PCT`(5%) を
		 * 両方割るが、高安基準なら両方通る——BTC/JPY 日足 2026-08-03〜08-14 と同じ形。
		 */
		it('終値基準では閾値割れでも高安基準なら検出される', () => {
			// valley1(close 100 / low 95) → peak(close 102 / high 108) → valley2(close 100.5 / low 95.5)
			const candles: CandleData[] = [
				...Array.from({ length: 5 }, (_, i) => mkCandle(40 - i, 100, 101, 95, 100)),
				...Array.from({ length: 5 }, (_, i) => mkCandle(35 - i, 101, 108, 99, 102)),
				...Array.from({ length: 5 }, (_, i) => mkCandle(30 - i, 100.5, 101, 95.5, 100.5)),
				...Array.from({ length: 10 }, (_, i) => mkCandle(25 - i, 110, 112, 108, 110)),
			];
			const pivots: Pivot[] = [
				{ idx: 0, price: 100, kind: 'L', extremePrice: 95 },
				{ idx: 7, price: 102, kind: 'H', extremePrice: 108 },
				{ idx: 14, price: 100.5, kind: 'L', extremePrice: 95.5 },
			];

			// 前提: 終値基準なら両閾値割れ / 高安基準なら両方通る
			const heightClose = Math.abs(100 - 102) / 102;
			const peakHeightClose = (102 - (100 + 100.5) / 2) / ((100 + 100.5) / 2);
			expect(heightClose).toBeLessThan(0.03);
			expect(peakHeightClose).toBeLessThan(0.05);
			const heightExt = Math.abs(95 - 108) / 108;
			const peakHeightExt = (108 - (95 + 95.5) / 2) / ((95 + 95.5) / 2);
			expect(heightExt).toBeGreaterThan(0.03);
			expect(peakHeightExt).toBeGreaterThan(0.05);

			const ctx = buildCtx({ candles, pivots, minDist: 5 });
			const result = detectDoubles(ctx);
			const db = result.patterns.filter((p) => p.type === 'double_bottom');
			expect(db).toHaveLength(1);
			// サイズ検査で落ちた痕跡が残っていないこと（旧実装はここで pattern_too_small を積んだ）
			expect(ctx.debugCandidates.map((c) => c.reason)).not.toContain('pattern_too_small');
		});

		/**
		 * **窓の最後の 3 ピボットも走査対象。**
		 *
		 * 旧 `for (let i = 0; i < pivots.length - 3; i++)` は 4 ピボットぶんの端点を要求しており、
		 * 3 ピボットのパターンでは**最後の 1 組が必ず走査から漏れていた**
		 * （`detect_triples` は `i <= n - 3`、`detect_hs` は 5 ピボットに対し `i < n - 4` で正しい）。
		 * 第2構成点が窓の最後のピボットになる形——つまり**最も直近のダブルトップ / ボトム**が
		 * 構造的に検出できなかった。
		 */
		it('第2構成点が最後のピボットでも検出される（後続ピボット不要）', () => {
			const { candles, pivots } = buildDoubleBottom();
			// 4 本目（breakout 後のピボット）を落として 3 ピボットだけにする
			const threePivots = pivots.slice(0, 3);
			expect(threePivots).toHaveLength(3);

			const result = detectDoubles(buildCtx({ candles, pivots: threePivots }));
			const db = result.patterns.filter((p) => p.type === 'double_bottom');
			expect(db).toHaveLength(1);
			expect((db[0].pivots ?? []).map((v) => v.idx)).toEqual([0, 10, 20]);
		});
	});

	// ── 形成中経路は double に無い（issue #262 / #268 案 C）────────────────
	//
	// **`形成中ダブルトップ: 確定ピーク + 谷 + 現在価格がピーク付近` と
	// `forming double_top: structureRange あり, confirmation=not_confirmed` を削除した。**
	// `tryFormingDoubleTop` が #268 案 C で消えたので、`status: 'forming'` の `double_top` を
	// 作れる入力が存在しない。同じ形（山1 + 谷 + 最新足が山の水準）は完成済み経路の
	// 構成点 3 点が揃うまで候補にならず、揃った時点で `near_completion` になる。
	// `structureRange` / `confirmation: 'not_confirmed'` の回帰は下の `near_completion` の
	// テストが引き継いでいる。「1 件も出ない」ことは
	// `tests/patterns/no-forming-double-268.test.ts` のトリップワイヤが固定する。

	// `includeForming=false` では未ブレイク構造（`near_completion` / `expired` / `invalid`）も
	// 出ない。`forming` は #268 案 C 以降 double では構造的に出ないので、このテストが見ているのは
	// **`includeForming` のスイッチが効いていること**になった（`status` の名前は据え置き）。
	it('includeForming=false では未ブレイク構造も形成中も検出しない', () => {
		const candles: CandleData[] = [];
		for (let i = 0; i < 50; i++) candles.push(mkCandle(50 - i, 150, 155, 145, 150));
		candles[20] = mkCandle(30, 195, 200, 190, 195);
		candles[30] = mkCandle(20, 165, 170, 160, 165);
		for (let i = 40; i < 50; i++) candles[i] = mkCandle(50 - i, 195, 198, 190, 196);

		const pivots: Pivot[] = [
			{ idx: 5, price: 150, kind: 'L', extremePrice: 150 },
			{ idx: 20, price: 200, kind: 'H', extremePrice: 200 },
			{ idx: 30, price: 160, kind: 'L', extremePrice: 160 },
			{ idx: 45, price: 198, kind: 'H', extremePrice: 198 },
		];

		const ctx = buildCtx({ candles, pivots, includeForming: false });
		const result = detectDoubles(ctx);
		const forming = result.patterns.filter((p) => p.status === 'forming');
		expect(forming).toHaveLength(0);
	});

	// ── ブレイク待ちのダブルボトム（issue #262 で `forming` → `near_completion`）──────────

	/**
	 * **期待値を `forming` から `near_completion` に変えた（issue #262）。**
	 * この形（確定 2 谷 + 中間の山 + 未ブレイク）は構造が完成していてネックライン突破を
	 * 待っている段階で、`forming`（＝最終構成点がまだ形成中）ではない。旧 `tryFormingDoubleBottom`
	 * の誤ラベルを完成済み経路の `near_completion` に付け替えた。
	 *
	 * `completionPct` の検査を落としたのも同じ理由——完成度スコアは形成中経路の概念で、
	 * triple / H&S の `near_completion` も持っていない。
	 */
	it('ブレイク待ちダブルボトム: 確定谷2つ + 現在価格がネックライン付近 → near_completion', () => {
		const candles: CandleData[] = [];
		// 谷1 より前はネックライン(130)より上で推移させる。構造ゲート（issue #126）は
		// 「谷1 前にネックライン水準を終値で下抜けた事象」を要求するので、
		// 旧 fixture のように終値がネックラインとぴったり同値のまま横ばいだと、
		// そもそも下抜けという事象が存在せず棄却される。
		for (let i = 0; i < 50; i++) candles.push(mkCandle(50 - i, 140, 145, 135, 140));
		// valley1
		candles[10] = mkCandle(40, 102, 105, 100, 102);
		// peak between
		candles[20] = mkCandle(30, 128, 130, 125, 128);
		// valley2
		candles[30] = mkCandle(20, 103, 105, 100, 103);
		// 谷2 以降は**ネックライン(130)を超えない**まま推移させる（issue #262）。
		// 旧 fixture は idx 31〜39 が終値 140 のままで、実際には完成済みパスが idx 31 で
		// ブレイクを拾っていた——`forming` の重複報告がまさにこの PR の動機なので、
		// 「ブレイク待ち」を見たいこのテストでは埋め直す。
		for (let i = 31; i < 50; i++) candles[i] = mkCandle(50 - i, 125, 128, 122, 126);

		const pivots: Pivot[] = [
			{ idx: 5, price: 140, kind: 'H', extremePrice: 145 },
			{ idx: 10, price: 100, kind: 'L', extremePrice: 100 },
			{ idx: 20, price: 130, kind: 'H', extremePrice: 130 },
			{ idx: 30, price: 100, kind: 'L', extremePrice: 100 },
			{ idx: 45, price: 128, kind: 'H', extremePrice: 128 },
		];
		const allPeaks = pivots.filter((p) => p.kind === 'H');
		const allValleys = pivots.filter((p) => p.kind === 'L');

		const ctx = buildCtx({ candles, pivots, allPeaks, allValleys, includeForming: true });
		const result = detectDoubles(ctx);

		const nearCompletion = result.patterns.filter((p) => p.type === 'double_bottom' && p.status === 'near_completion');
		expect(nearCompletion.length).toBeGreaterThanOrEqual(1);
		expect(result.patterns.filter((p) => p.type === 'double_bottom' && p.status === 'forming')).toHaveLength(0);
		if (nearCompletion.length > 0) {
			expect(nearCompletion[0].breakoutTarget).toBeDefined();
			expect(nearCompletion[0].targetMethod).toBe('neckline_projection');
			// 未ブレイクなので進捗は測れないことを名乗る（#224 症状 2）
			expect(nearCompletion[0].targetProgressOmittedReason).toBe('not_broken_out');
		}
	});

	// ── structureRange / confirmation / precedingTrend（誤読防止のための分離フィールド） ──

	it('completed double_top: structureRange=peak1〜peak2, confirmation=breakoutIdx, precedingTrend あり', () => {
		const { candles, pivots } = buildDoubleTop();
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);

		const dt = result.patterns.find((p) => p.type === 'double_top');
		expect(dt).toBeDefined();
		if (!dt) return;

		// structureRange: peak1(idx=0) → peak2(idx=20)
		expect(dt.structureRange).toBeDefined();
		expect(dt.structureRange?.start).toBe(candles[0].isoTime);
		expect(dt.structureRange?.end).toBe(candles[20].isoTime);

		// confirmation: ネックライン下抜け（idx=25 が最初の breakout）
		expect(dt.confirmation).toBeDefined();
		expect(dt.confirmation?.type).toBe('neckline_breakout');
		if (dt.confirmation?.type === 'neckline_breakout') {
			expect(dt.confirmation.idx).toBe(dt.breakoutBarIndex);
			expect(dt.confirmation.date).toBe(candles[dt.breakoutBarIndex as number].isoTime);
			expect(dt.confirmation.price).toBe(Number(candles[dt.breakoutBarIndex as number].close));
		}

		// precedingTrend: end は peak1（startIdx=0）の isoTime
		expect(dt.precedingTrend).toBeDefined();
		expect(dt.precedingTrend?.end).toBe(candles[0].isoTime);
		expect(dt.precedingTrend?.direction).toBeDefined();
		expect(typeof dt.precedingTrend?.returnPct).toBe('number');
		expect(typeof dt.precedingTrend?.lookbackBars).toBe('number');
	});

	it('completed double_bottom: structureRange=valley1〜valley2, confirmation=breakoutIdx, precedingTrend あり', () => {
		const { candles, pivots } = buildDoubleBottom();
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);

		const db = result.patterns.find((p) => p.type === 'double_bottom');
		expect(db).toBeDefined();
		if (!db) return;

		expect(db.structureRange?.start).toBe(candles[0].isoTime);
		expect(db.structureRange?.end).toBe(candles[20].isoTime);

		expect(db.confirmation?.type).toBe('neckline_breakout');
		if (db.confirmation?.type === 'neckline_breakout') {
			expect(db.confirmation.idx).toBe(db.breakoutBarIndex);
			expect(db.confirmation.date).toBe(candles[db.breakoutBarIndex as number].isoTime);
		}

		expect(db.precedingTrend).toBeDefined();
		expect(db.precedingTrend?.end).toBe(candles[0].isoTime);
	});

	/**
	 * **期待値を `forming` から `near_completion` に変えた（issue #262）。** 理由は上の
	 * 「ブレイク待ちダブルボトム」の docstring を参照。`structureRange` が 2 谷で閉じることは
	 * 変わらない（完成済み経路の `structureRange` も第1〜第2構成点で閉じる）。**`range.end` は
	 * 最新足ではなく谷2 になった**——`detect_triples` の `near_completion` と同じ取り方。
	 */
	it('near_completion double_bottom: structureRange / range とも valley1〜valley2 で閉じる', () => {
		const candles: CandleData[] = [];
		// 谷1 前をネックライン(130)より上にするのは上の fixture と同じ理由（issue #126）
		for (let i = 0; i < 50; i++) candles.push(mkCandle(50 - i, 140, 145, 135, 140));
		candles[10] = mkCandle(40, 102, 105, 100, 102);
		candles[20] = mkCandle(30, 128, 130, 125, 128);
		candles[30] = mkCandle(20, 103, 105, 100, 103);
		// 谷2 以降が未ブレイクであることは上の fixture と同じ理由（issue #262）
		for (let i = 31; i < 50; i++) candles[i] = mkCandle(50 - i, 125, 128, 122, 126);

		const pivots: Pivot[] = [
			{ idx: 5, price: 140, kind: 'H', extremePrice: 145 },
			{ idx: 10, price: 100, kind: 'L', extremePrice: 100 },
			{ idx: 20, price: 130, kind: 'H', extremePrice: 130 },
			{ idx: 30, price: 100, kind: 'L', extremePrice: 100 },
			{ idx: 45, price: 128, kind: 'H', extremePrice: 128 },
		];
		const allPeaks = pivots.filter((p) => p.kind === 'H');
		const allValleys = pivots.filter((p) => p.kind === 'L');

		const ctx = buildCtx({ candles, pivots, allPeaks, allValleys, includeForming: true });
		const result = detectDoubles(ctx);
		const nearCompletion = result.patterns.find((p) => p.type === 'double_bottom' && p.status === 'near_completion');
		expect(nearCompletion).toBeDefined();
		if (!nearCompletion) return;

		expect(nearCompletion.structureRange?.start).toBe(candles[10].isoTime);
		expect(nearCompletion.structureRange?.end).toBe(candles[30].isoTime);
		expect(nearCompletion.range?.start).toBe(candles[10].isoTime);
		expect(nearCompletion.range?.end).toBe(candles[30].isoTime);
		expect(nearCompletion.confirmation?.type).toBe('not_confirmed');
		// ブレイク足が無いので breakout 系は出さない
		expect(nearCompletion.breakout).toBeUndefined();
		expect(nearCompletion.breakoutBarIndex).toBeUndefined();
	});

	// ── targetReachedPct / targetReached (high/low ベース) ───

	it('double_top: breakout 後に low が target 方向に動いた場合 high/low ベースで pct を算出', () => {
		// target=140, breakoutPrice=160, postBreak low=150 → (160-150)/(160-140)*100 = 50%
		const { candles, pivots } = buildDoubleTop({ peak1: 200, valley: 170, peak2: 200, breakoutClose: 160 });
		// 最後の candle の low を 150 に設定（target=140 方向に半分進行）
		const last = candles.length - 1;
		candles[last] = { ...candles[last], low: 150 };

		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const dt = result.patterns.find((p) => p.type === 'double_top');

		expect(dt).toBeDefined();
		if (!dt) return;
		expect(dt.targetReachedPct).toBe(50);
		expect(dt.targetReached).toBe(false);
		expect(dt.targetReachedPrice).toBe(150);
		expect(dt.targetReachedDate).toBe(candles[last].isoTime);
	});

	it('double_top: 一度 target 到達後に close が戻る → high/low ベースで targetReached=true', () => {
		// target=140, breakoutPrice=160
		// 中間 idx=27 で low=130 (<= target 140) → 到達
		// 末尾 idx=29 は close=160 まで recovery
		const { candles, pivots } = buildDoubleTop({ peak1: 200, valley: 170, peak2: 200, breakoutClose: 160 });
		// 中間 idx=27 で low=130 (target=140 を割り込む)
		candles[27] = { ...candles[27], low: 130 };

		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const dt = result.patterns.find((p) => p.type === 'double_top');

		expect(dt).toBeDefined();
		if (!dt) return;
		expect(dt.breakoutTarget).toBe(140);
		expect(dt.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(dt.targetReached).toBe(true);
		expect(dt.targetReachedPrice).toBe(130);
		expect(dt.targetReachedDate).toBe(candles[27].isoTime);
	});

	it('double_top: ブレイク close が既に target を下回る（オーバーシュート）→ targetReached=true & pct>=100', () => {
		// target=140, breakClose=130 → breakoutPrice=130 < target 140
		// 旧式: (extremePrice - 130) / (140 - 130) は分母 +10、extremePrice<130 で分子マイナス → pct<0
		// 新式: clamp により reached=true なら pct>=100
		const { candles, pivots } = buildDoubleTop({ peak1: 200, valley: 170, peak2: 200, breakoutClose: 130 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const dt = result.patterns.find((p) => p.type === 'double_top');

		expect(dt).toBeDefined();
		if (!dt) return;
		expect(dt.breakoutTarget).toBe(140);
		expect(dt.targetReached).toBe(true);
		expect(dt.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(dt.targetReachedPct).toBeGreaterThanOrEqual(0);
	});

	it('double_top: ブレイク close == target（距離ゼロ）→ 進捗を出さず理由を申告する', () => {
		// target=140, breakClose=140 → breakoutPrice == target → targetDistance=0。
		// #210 の退化ガードで target 進捗系は出さず、理由だけを申告する（breakoutTarget は出る）。
		const { candles, pivots } = buildDoubleTop({ peak1: 200, valley: 170, peak2: 200, breakoutClose: 140 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const dt = result.patterns.find((p) => p.type === 'double_top');

		expect(dt).toBeDefined();
		if (!dt) return;
		expect(dt.breakoutTarget).toBe(140);
		expect(dt.targetProgressOmittedReason).toBe('degenerate_target_distance');
		expect(dt.targetReached).toBeUndefined();
		expect(dt.targetReachedPct).toBeUndefined();
		expect(dt.targetReachedPrice).toBeUndefined();
		expect(dt.targetReachedDate).toBeUndefined();
	});

	it('double_bottom: 一度 target 到達後に close が戻る → high/low ベースで targetReached=true', () => {
		// target=160, breakoutPrice=140
		// 中間 idx=27 で high=170 (>= target 160) → 到達
		// 末尾 idx=29 は close=140 まで recovery
		const { candles, pivots } = buildDoubleBottom({ valley1: 100, peak: 130, valley2: 100, breakoutClose: 140 });
		candles[27] = { ...candles[27], high: 170 };

		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const db = result.patterns.find((p) => p.type === 'double_bottom');

		expect(db).toBeDefined();
		if (!db) return;
		expect(db.breakoutTarget).toBe(160);
		expect(db.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(db.targetReached).toBe(true);
		expect(db.targetReachedPrice).toBe(170);
		expect(db.targetReachedDate).toBe(candles[27].isoTime);
	});

	it('double_bottom: ブレイク high が target に届かない → 未到達 (targetReachedPct < 100)', () => {
		// breakoutPrice=140, target=160, 全 postBreak high < 160 → 未到達
		const { candles, pivots } = buildDoubleBottom({ valley1: 100, peak: 130, valley2: 100, breakoutClose: 140 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const db = result.patterns.find((p) => p.type === 'double_bottom');

		expect(db).toBeDefined();
		if (!db) return;
		expect(db.breakoutTarget).toBe(160);
		expect(db.targetReachedPct).toBeLessThan(100);
		expect(db.targetReached).toBe(false);
	});

	it('double_bottom: ブレイク close が既に target を上回る（オーバーシュート）→ targetReached=true & pct>=100', () => {
		// target=160, breakClose=170 → breakoutPrice=170 > target 160 で既に到達済み
		const { candles, pivots } = buildDoubleBottom({ valley1: 100, peak: 130, valley2: 100, breakoutClose: 170 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const db = result.patterns.find((p) => p.type === 'double_bottom');

		expect(db).toBeDefined();
		if (!db) return;
		expect(db.breakoutTarget).toBe(160);
		expect(db.targetReached).toBe(true);
		expect(db.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(db.targetReachedPct).toBeGreaterThanOrEqual(0);
	});

	it('double_bottom: ブレイク close == target（距離ゼロ）→ 進捗を出さず理由を申告する', () => {
		// target=160, breakClose=160（#210 の退化ガード）
		const { candles, pivots } = buildDoubleBottom({ valley1: 100, peak: 130, valley2: 100, breakoutClose: 160 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const db = result.patterns.find((p) => p.type === 'double_bottom');

		expect(db).toBeDefined();
		if (!db) return;
		expect(db.breakoutTarget).toBe(160);
		expect(db.targetProgressOmittedReason).toBe('degenerate_target_distance');
		expect(db.targetReached).toBeUndefined();
		expect(db.targetReachedPct).toBeUndefined();
		expect(db.targetReachedPrice).toBeUndefined();
		expect(db.targetReachedDate).toBeUndefined();
	});
});
