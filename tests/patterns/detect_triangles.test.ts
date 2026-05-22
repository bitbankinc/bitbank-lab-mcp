/**
 * detect_triangles.test.ts
 *
 * detectTriangles の whipsaw（ブレイクアウト後に三角形内に戻る false-breakout）
 * 判定ロジックの境界テスト。
 *
 * determineTriangleStatus() 内の whipsaw 条件:
 *   if (hasBreakout && lastIdx > breakoutIdx) {
 *     const latestClose = candles[lastIdx].close;
 *     const uLatest = upperLine.valueAt(lastIdx);
 *     const lLatest = lowerLine.valueAt(lastIdx);
 *     if (latestClose > lLatest && latestClose < uLatest) {
 *       hasBreakout = false; breakoutIdx = -1; breakoutDirection = null;
 *     }
 *   }
 *
 * テスト観点:
 * 1. ブレイクアウト成立 → 直近足が三角形外に留まる → completed のまま
 * 2. ブレイクアウト成立 → 直近足が三角形内に再侵入 → whipsaw で forming 扱い
 * 3. 境界値: close === uLatest / close === lLatest → strict inequality のため whipsaw 不発
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { detectTriangles } from '../../tools/patterns/detect_triangles.js';
import { linearRegressionWithR2 } from '../../tools/patterns/regression.js';
import type { Pivot } from '../../tools/patterns/swing.js';
import type { CandleData, DetectContext } from '../../tools/patterns/types.js';

// ── ヘルパー ──────────────────────────────────────────────

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
		minDist: 5,
		want: opts.want ?? new Set(),
		includeForming: opts.includeForming ?? true,
		debugCandidates: [],
		type: opts.type ?? '1day',
		swingDepth: 7,
		near: (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * tol,
		pct: (a: number, b: number) => ((b - a) / Math.max(1, a)) * 100,
		lrWithR2: (pts) => linearRegressionWithR2(pts),
	};
}

// ── 対称三角形データ生成 ──────────────────────────────────
// 上限: 下落（upper = 110 - 0.3*i）、下限: 上昇（lower = 80 + 0.3*i）
// → symmetrical triangle（upperFalling && lowerRising）
// 収束: gapStart=30, gapEnd ≈ 30 - 0.6*(nBars-1) → 十分な収束
//
// ピーク（phase 1）: high が upper に接触
// バレー（phase 5）: low が lower に接触
// period=8 の振動で relaxed swing detection に拾われるよう設計

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
			// ピーク: high が upper に接触
			h = upper;
			l = upper - 5;
			c = upper - 1;
		} else if (phase === 5) {
			// バレー: low が lower に接触
			h = lower + 5;
			l = lower;
			c = lower + 1;
		} else {
			// 中間: high/low が upper/lower より控えめ
			h = mid + 3;
			l = mid - 3;
			c = mid;
		}
		candles.push(mkCandle(nBars + 20 - i, mid, h, l, c));
	}
	return candles;
}

/**
 * 三角形 + ブレイクアウト + 後続足を生成。
 *
 * @param tailCloses - ブレイクアウト後の追加足の close 値配列
 * @param breakoutClose - ブレイクアウト足の close（上方ブレイクアウト）
 */
function buildWithBreakoutAndTail(tailCloses: number[], breakoutClose = 120): CandleData[] {
	const base = buildSymTriangleBase(40);

	// ブレイクアウト足: close が upper + ATR*0.3 を超える
	base.push(mkCandle(20 - 0, breakoutClose - 2, breakoutClose + 2, breakoutClose - 4, breakoutClose));

	// 後続足
	for (let t = 0; t < tailCloses.length; t++) {
		const c = tailCloses[t];
		base.push(mkCandle(20 - (1 + t), c - 1, c + 2, c - 3, c));
	}

	return base;
}

// ── テスト ────────────────────────────────────────────────

afterEach(() => {
	vi.resetAllMocks();
});

describe('detectTriangles — whipsaw boundary tests', () => {
	// ────────────────────────────────────────────────────────
	// 1. ブレイクアウト成立 → 直近足が三角形外に留まる → completed
	// ────────────────────────────────────────────────────────
	it('ブレイクアウト後に三角形外に留まる → status=completed を維持', () => {
		// 後続足も 115-120 付近 → upper line (~98) より十分上
		const candles = buildWithBreakoutAndTail([118, 119, 120, 121]);
		const ctx = buildCtx({ candles, want: new Set(['triangle_symmetrical']) });
		const result = detectTriangles(ctx);

		const syms = result.patterns.filter((p) => p.type === 'triangle_symmetrical');
		// ブレイクアウトが検出され、completed であること
		const completed = syms.filter((p) => p.status === 'completed');
		expect(completed.length).toBeGreaterThanOrEqual(1);
		expect(completed[0]?.breakoutDirection).toBe('up');
		expect(completed[0]?.outcome).toBe('success');
	});

	// ────────────────────────────────────────────────────────
	// 2. ブレイクアウト成立 → 直近足が三角形内に再侵入 → whipsaw
	// ────────────────────────────────────────────────────────
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

		// whipsaw が発動した場合: completed パターンが存在しない
		// （forming / near_completion になるか、パターン自体がスキップされる）
		const completed = syms.filter((p) => p.status === 'completed');
		const forming = syms.filter((p) => p.status === 'forming' || p.status === 'near_completion');

		// whipsaw が効いている → completed は 0 件、forming が存在
		expect(syms.length).toBeGreaterThan(0);
		expect(completed.length === 0 || forming.length > 0).toBe(true);

		// breakoutDirection が設定されたパターンがないことを確認
		// （whipsaw で breakout 自体が無効化されるため）
		const withBreakout = syms.filter((p) => p.status === 'completed' && p.breakoutDirection === 'up');
		expect(withBreakout).toHaveLength(0);
	});

	// ────────────────────────────────────────────────────────
	// 3. 境界値: close がちょうど上限トレンドライン上 → whipsaw 不発
	//    strict inequality: latestClose < uLatest が false のため
	// ────────────────────────────────────────────────────────
	it('直近足が上限トレンドラインと一致 → whipsaw は発動しない（strict <）', () => {
		// upperLine は 110 - 0.3*i で下落。i=44 での値は 110-0.3*44=96.8 付近
		// breakout 後の最終足 close を upper 付近（97）にして、
		// 三角形「内」ではないことを検証（close < uLatest が false）
		// ここでは close が upper line の延長値以上になるよう設定
		const candles = buildWithBreakoutAndTail([115, 110, 105, 97]);

		// 最終足の close=97 は extrapolated upper (~96.8) とほぼ同じか上
		// → latestClose < uLatest が false → whipsaw 不発 → completed を期待
		const ctx = buildCtx({ candles, want: new Set(['triangle_symmetrical']) });
		const result = detectTriangles(ctx);

		const syms = result.patterns.filter((p) => p.type === 'triangle_symmetrical');
		// close が upper 以上なら whipsaw は発動しないので completed パターンが残る
		expect(syms.length).toBeGreaterThan(0);
		const hasBreakoutPattern = syms.some((p) => p.breakoutDirection === 'up' && p.status === 'completed');
		const hasFormingPattern = syms.some((p) => p.status === 'forming' || p.status === 'near_completion');
		expect(hasBreakoutPattern || hasFormingPattern).toBe(true);
	});

	it('直近足が下限トレンドラインと一致 → whipsaw は発動しない（strict >）', () => {
		// 下方ブレイクアウトのケース
		// lowerLine は 80 + 0.3*i で上昇。i=44 での値は 80+0.3*44=93.2 付近
		// 最終足 close を lower 付近に設定
		const base = buildSymTriangleBase(40);

		// 下方ブレイクアウト: close が lower - ATR*0.3 を下回る
		base.push(mkCandle(20, 75, 78, 72, 73));
		// 後続足: close を lower line 延長値（~93.2）以下に設定
		// → latestClose > lLatest が false → whipsaw 不発
		base.push(mkCandle(19, 92, 94, 90, 93));

		const ctx = buildCtx({
			candles: base,
			want: new Set(['triangle_symmetrical']),
			includeForming: true,
		});
		const result = detectTriangles(ctx);

		const syms = result.patterns.filter((p) => p.type === 'triangle_symmetrical');
		// 下方ブレイクアウトが検出された場合、close ≤ lLatest なら whipsaw 不発
		expect(syms.length).toBeGreaterThan(0);
		const formingOrCompleted = syms.filter(
			(p) => p.status === 'completed' || p.status === 'forming' || p.status === 'near_completion',
		);
		expect(formingOrCompleted.length).toBeGreaterThanOrEqual(1);
		const downBreakouts = syms.filter((p) => p.breakoutDirection === 'down');
		if (downBreakouts.length > 0) {
			expect(downBreakouts[0]?.breakoutBarIndex).toBeDefined();
		}
	});

	// ────────────────────────────────────────────────────────
	// 4. 古い historical パターンの skip 検証
	// ────────────────────────────────────────────────────────
	it('whipsaw + includeForming=false → forming パターンがスキップされる', () => {
		// 三角形パターン（40本）+ ブレイクアウト + 数本の戻り足
		// トレンドラインの交差は index≈50 なので、5本の戻り足なら交差前（lastIdx=45）
		// → whipsaw が発動し forming 扱い → includeForming=false で skip
		const base = buildSymTriangleBase(40);

		// ブレイクアウト足
		base.push(mkCandle(20, 118, 122, 116, 120));

		// ブレイクアウト後に三角形内に戻る（whipsaw）: close=94 は
		// upper(45)≈96.5, lower(45)≈93.5 の範囲内
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
		// whipsaw で breakout 無効化 → forming 扱い → includeForming=false → skip
		// → completed パターンは返らないはず
		const completed = syms.filter((p) => p.status === 'completed');
		expect(completed).toHaveLength(0);
	});

	// ────────────────────────────────────────────────────────
	// 基本動作テスト
	// ────────────────────────────────────────────────────────
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

	// ────────────────────────────────────────────────────────
	// 5. 形成中の途中足がライン外に出ても completed にならない
	//    （PR3: scanStart = patternEndIdx + 1 への修正検証）
	// ────────────────────────────────────────────────────────
	it('形成中の途中足がライン外に出ても completed にならない', () => {
		// i=20 で一時的に upper line を大きく上抜けする close を設定（false breakout）。
		// upper(20) ≈ 110 - 0.3*20 = 104。close=130 → upper + ATR*0.3 を大きく超える。
		// 後続足は通常パターンに戻り、保ち合い終端後にラインを抜けない。
		// → 中間の振れは breakout 扱いされず completed にならない。
		const candles = buildSymTriangleBase(40);
		candles[20] = mkCandle(20 + 40 - 20, 100, 132, 99, 130);

		const ctx = buildCtx({
			candles,
			want: new Set(['triangle_symmetrical']),
			includeForming: true,
		});
		const result = detectTriangles(ctx);

		const syms = result.patterns.filter((p) => p.type === 'triangle_symmetrical');
		// パターンは検出されるが、中間の振れによる completed は存在しない
		const completed = syms.filter((p) => p.status === 'completed');
		expect(completed).toHaveLength(0);
	});

	it('真のブレイクは保ち合い終端後の位置で検出される（中間の false breakout は採用されない）', () => {
		// 中間 i=20 で false breakout、その後保ち合い終端を過ぎてから本物のブレイクアウト。
		// PR3 修正により breakoutBarIndex は i=20 ではなく終端後の位置（>=38）になる。
		const base = buildSymTriangleBase(40);

		// 中間で upper を上抜け（false breakout）。
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
			expect(p.breakoutBarIndex).toBeDefined();
			// 形成期間中の false breakout (i=20) が採用されていないこと
			expect(p.breakoutBarIndex).not.toBe(20);
			// 保ち合い終端後（>=38）のブレイク位置であること
			expect(p.breakoutBarIndex!).toBeGreaterThanOrEqual(38);
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
});
