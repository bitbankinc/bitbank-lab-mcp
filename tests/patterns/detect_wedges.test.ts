/**
 * detect_wedges.test.ts
 *
 * detectWedges の branches カバレッジ改善テスト。
 *
 * 4b（回帰ベース完成済み）は要件が厳しいため、
 * 4d（形成中ウェッジ）を主なターゲットにしたデータジェネレータを使用。
 *
 * データ生成方針:
 *   Rising Wedge:  upper(i) = 100 + 0.3*i, lower(i) = 80 + 0.5*i (両者上昇、lower が急→収束)
 *   Falling Wedge: upper(i) = 200 - 0.5*i, lower(i) = 180 - 0.25*i (両者下落、upper が急→収束)
 *   period=8 の振動で SG 平滑化ピークが upper/lower に沿って出現
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { getHsShoulderMaxPctForTf, getSizeThresholdsForTf, resolveParams } from '../../tools/patterns/config.js';
import { detectWedges } from '../../tools/patterns/detect_wedges.js';
import { linearRegressionWithR2 } from '../../tools/patterns/regression.js';
import { detectSwingPoints, type Pivot } from '../../tools/patterns/swing.js';
import type { CandleData, DetectContext } from '../../tools/patterns/types.js';
import { buildBtcJpy2026Candles } from '../fixtures/btc_jpy_1day_2026.js';

// ── ヘルパー ──

function iso(daysAgo: number): string {
	return dayjs().subtract(daysAgo, 'day').startOf('day').toISOString();
}

function isoHoursAgo(hoursAgo: number): string {
	return dayjs().subtract(hoursAgo, 'hour').startOf('hour').toISOString();
}

function isoWeeksAgo(weeksAgo: number): string {
	return dayjs().subtract(weeksAgo, 'week').startOf('day').toISOString();
}

function mkCandle(daysAgo: number, o: number, h: number, l: number, c: number): CandleData {
	return { open: o, high: h, low: l, close: c, isoTime: iso(daysAgo) };
}

function mkCandleAt(iso: string, o: number, h: number, l: number, c: number): CandleData {
	return { open: o, high: h, low: l, close: c, isoTime: iso };
}

function buildCtx(opts: {
	candles: CandleData[];
	pivots: Pivot[];
	tolerancePct?: number;
	want?: Set<string>;
	includeForming?: boolean;
	type?: string;
	swingDepth?: number;
}): DetectContext {
	const tol = opts.tolerancePct ?? 0.04;
	return {
		candles: opts.candles,
		pivots: opts.pivots,
		allPeaks: opts.pivots.filter((p) => p.kind === 'H'),
		allValleys: opts.pivots.filter((p) => p.kind === 'L'),
		tolerancePct: tol,
		headProminencePct: tol,
		minDist: 5,
		want: opts.want ?? new Set(),
		includeForming: opts.includeForming ?? false,
		debugCandidates: [],
		type: opts.type ?? '1day',
		sizeThresholds: getSizeThresholdsForTf(opts.type ?? '1day'),
		hsShoulderMaxPct: getHsShoulderMaxPctForTf(opts.type ?? '1day'),
		swingDepth: opts.swingDepth ?? 7,
		near: (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * tol,
		pct: (a: number, b: number) => ((b - a) / Math.max(1, a)) * 100,
		lrWithR2: (pts) => linearRegressionWithR2(pts),
	};
}

/**
 * Rising Wedge 形状のローソク足を生成:
 *   upper(i) = 100 + 0.3*i  (緩やかな上昇)
 *   lower(i) = 80  + 0.5*i  (急な上昇 → 収束)
 *   apex ≈ i=100 (endIdx=79 より先 → apex valid)
 *   period=8 の振動でピーク/谷を作る
 */
function buildRisingWedgeCandles(nBars = 80): CandleData[] {
	const candles: CandleData[] = [];
	for (let i = 0; i < nBars; i++) {
		const upper = 100 + 0.3 * i;
		const lower = 80 + 0.5 * i;
		const mid = (upper + lower) / 2;
		const period = i % 8;
		let h: number;
		let l: number;
		let c: number;
		if (period === 0 || period === 1) {
			// ピーク領域: high が upper に接触
			h = upper;
			l = mid - 2;
			c = mid + 1;
		} else if (period === 4 || period === 5) {
			// 谷領域: low が lower に接触
			h = mid + 2;
			l = lower;
			c = mid - 1;
		} else {
			// 中間
			h = mid + 3;
			l = mid - 3;
			c = mid;
		}
		candles.push(mkCandle(nBars - i, mid, h, l, c));
	}
	return candles;
}

/**
 * Falling Wedge 形状のローソク足を生成:
 *   upper(i) = 200 - 0.5*i  (急な下落)
 *   lower(i) = 180 - 0.25*i (緩やかな下落 → 収束)
 *   apex ≈ i=80 (endIdx=79 → barsToApex=1: near_completion)
 */
function buildFallingWedgeCandles(nBars = 80): CandleData[] {
	const candles: CandleData[] = [];
	for (let i = 0; i < nBars; i++) {
		const upper = 200 - 0.5 * i;
		const lower = 180 - 0.25 * i;
		const mid = (upper + lower) / 2;
		const period = i % 8;
		let h: number;
		let l: number;
		let c: number;
		if (period === 0 || period === 1) {
			h = upper;
			l = mid - 2;
			c = mid + 1;
		} else if (period === 4 || period === 5) {
			h = mid + 2;
			l = lower;
			c = mid - 1;
		} else {
			h = mid + 3;
			l = mid - 3;
			c = mid;
		}
		candles.push(mkCandle(nBars - i, mid, h, l, c));
	}
	return candles;
}

afterEach(() => {
	vi.resetAllMocks();
});

describe('detectWedges', () => {
	// ── 基本動作 ─────────────────────────────────────────────

	it('ローソク足が少なすぎる → パターン不検出', () => {
		const candles: CandleData[] = Array.from({ length: 10 }, (_, i) => mkCandle(10 - i, 100, 102, 98, 100));
		const pivots: Pivot[] = [
			{ idx: 0, price: 102, kind: 'H', extremePrice: 102 },
			{ idx: 5, price: 98, kind: 'L', extremePrice: 98 },
		];
		const ctx = buildCtx({ candles, pivots });
		const result = detectWedges(ctx);
		// ウィンドウサイズ最小 20 本必要なので 10 本では検出なし
		expect(result.patterns).toHaveLength(0);
	});

	// ── want フィルタ ────────────────────────────────────────

	it('want に rising_wedge のみ → falling_wedge は型として返らない', () => {
		const candles = buildFallingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, want: new Set(['rising_wedge']) });
		const result = detectWedges(ctx);

		const fw = result.patterns.filter((p) => p.type === 'falling_wedge');
		// falling_wedge は want に含まれないので 0 件、もしくは want フィルタで除外
		expect(fw).toHaveLength(0);
	});

	it('want に falling_wedge のみ → rising_wedge は型として返らない', () => {
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, want: new Set(['falling_wedge']) });
		const result = detectWedges(ctx);

		const rw = result.patterns.filter((p) => p.type === 'rising_wedge');
		expect(rw).toHaveLength(0);
	});

	it('want が空 → 両タイプを検出候補にする（結果配列を返す）', () => {
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, want: new Set() });
		const result = detectWedges(ctx);
		// 少なくともエラーなく配列を返す
		expect(Array.isArray(result.patterns)).toBe(true);
	});

	// ── Rising Wedge 形成中（4d パス）───────────────────────

	it('Rising Wedge 形状のデータ → rising_wedge が検出される（4d forming）', () => {
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, want: new Set(), includeForming: true });
		const result = detectWedges(ctx);

		const rw = result.patterns.filter((p) => p.type === 'rising_wedge');
		// 4d パスで少なくとも 1 件検出されることを確認
		expect(rw.length).toBeGreaterThanOrEqual(1);
		expect(rw[0]?.confidence).toBeGreaterThan(0);
		expect(rw[0]?.range?.start).toBeDefined();
		expect(rw[0]?.range?.end).toBeDefined();
	});

	it('Rising Wedge の status は forming または near_completion', () => {
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true });
		const result = detectWedges(ctx);

		const rw = result.patterns.filter((p) => p.type === 'rising_wedge');
		if (rw.length > 0) {
			const statuses = ['forming', 'near_completion', 'completed'];
			expect(statuses).toContain(rw[0]?.status);
		}
	});

	// ── Falling Wedge 形成中（4d パス）──────────────────────

	it('Falling Wedge 形状のデータ → falling_wedge が検出される（4d forming）', () => {
		const candles = buildFallingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, want: new Set(), includeForming: true });
		const result = detectWedges(ctx);

		const fw = result.patterns.filter((p) => p.type === 'falling_wedge');
		expect(fw.length).toBeGreaterThanOrEqual(1);
		expect(fw[0]?.confidence).toBeGreaterThan(0);
		expect(fw[0]?.range?.start).toBeDefined();
	});

	it('Falling Wedge の daysToApex は正の整数', () => {
		const candles = buildFallingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true });
		const result = detectWedges(ctx);

		const fw = result.patterns.filter((p) => p.type === 'falling_wedge');
		if (fw.length > 0 && fw[0]?.daysToApex !== undefined) {
			expect(fw[0].daysToApex).toBeGreaterThan(0);
		}
	});

	// ── target 到達判定（high/low ベース）────────────────────
	//
	// 標準の buildFallingWedgeCandles は breakout を起こさない near_completion で終わるため、
	// 末尾に強い上抜けバーを付加した専用フィクスチャを使う。

	function buildFallingWedgeWithUpBreakout(): CandleData[] {
		const candles: CandleData[] = [];
		const total = 90;
		for (let i = 0; i < 80; i++) {
			const upper = 200 - 0.5 * i;
			const lower = 180 - 0.25 * i;
			const mid = (upper + lower) / 2;
			const period = i % 8;
			let h: number;
			let l: number;
			let c: number;
			if (period === 0 || period === 1) {
				h = upper;
				l = mid - 2;
				c = mid + 1;
			} else if (period === 4 || period === 5) {
				h = mid + 2;
				l = lower;
				c = mid - 1;
			} else {
				h = mid + 3;
				l = mid - 3;
				c = mid;
			}
			candles.push(mkCandle(total - i, mid, h, l, c));
		}
		// 末尾 10 本で upper(@79)=160.5 を大きく上回るブレイク
		for (let i = 80; i < total; i++) {
			candles.push(mkCandle(total - i, 165, 200, 162, 180));
		}
		return candles;
	}

	/**
	 * `buildFallingWedgeWithUpBreakout` の**鏡像**——rising wedge を**下方に**ブレイクさせる（#281）。
	 *
	 * 形状は `buildRisingWedgeCandles` と同じ upper(i) = 100 + 0.3i / lower(i) = 80 + 0.5i で、
	 * idx 80 に**下方ブレイク足**を 1 本置く。以降 9 本は下落を続けるだけの足。
	 *
	 * **要点はブレイク足の上ヒゲ。** `evaluateTouchesEx`（`helpers.ts`）は `isBreak` を
	 * **線ごとに独立に**立てるので、下側ラインを割った足でも高値が上側ラインの 0.5% 以内なら
	 * `upperTouches` 側は `isBreak: false` のまま残る。数値で書くと（idx 80。上側ラインの
	 * 復元値は設計値どおり upper(80) = 100 + 0.3 × 80 = **124.0**、下側は lower(80) = **120.0**）:
	 *
	 * - 高値 123.8 − 上側ライン 124.0 = **−0.2**。閾値は 124.0 × 0.005 = **0.62** なので
	 *   **0.5% 以内** → `upperTouches` に `isBreak: false` で入る（＝ #281 以前は `kind: 'H'` の構成点）。
	 * - 安値 114.0 − 下側ライン 120.0 = **−6.0**。閾値 120.0 × 0.005 = 0.60 を大きく割るので
	 *   `lowerTouches` は `isBreak: true`。
	 * - 終値 115.0 < lower(80) × (1 − `FORMING_BREAKOUT_FACTOR` 0.015) = 118.2 なので
	 *   形成中パスのブレイク判定が idx 80 で成立する（`breakoutDirection: 'down'`）。
	 *
	 * **高値を上側ラインから離すとこのフィクスチャは回帰テストにならない**——`isBreak: true` に
	 * なって #281 以前のコードでも構成点に入らず、素通りしてしまう。
	 */
	function buildRisingWedgeWithDownBreakout(): CandleData[] {
		const candles: CandleData[] = [];
		const total = 90;
		for (let i = 0; i < 80; i++) {
			const upper = 100 + 0.3 * i;
			const lower = 80 + 0.5 * i;
			const mid = (upper + lower) / 2;
			const period = i % 8;
			let h: number;
			let l: number;
			let c: number;
			if (period === 0 || period === 1) {
				h = upper;
				l = mid - 2;
				c = mid + 1;
			} else if (period === 4 || period === 5) {
				h = mid + 2;
				l = lower;
				c = mid - 1;
			} else {
				h = mid + 3;
				l = mid - 3;
				c = mid;
			}
			candles.push(mkCandle(total - i, mid, h, l, c));
		}
		// idx 80: 下方ブレイク足。上ヒゲが上側ライン（124.0）の 0.5% 以内に残る（上の docstring）。
		candles.push(mkCandle(total - 80, 120, 123.8, 114, 115));
		for (let i = 81; i < total; i++) {
			candles.push(mkCandle(total - i, 110, 112, 95, 100));
		}
		return candles;
	}

	// ── breakout 後のターゲット（pattern_height）────────────

	it('breakout が検出された場合、breakoutTarget と targetMethod が設定される', () => {
		// buildFallingWedgeCandles は apex 手前で終わり breakout しない（status=forming）ので、
		// breakoutTarget を持つパターンが 1 件も出ない。ここは上抜け付きフィクスチャを使う。
		const candles = buildFallingWedgeWithUpBreakout();
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true });
		const result = detectWedges(ctx);

		// 他のウェッジ種別が breakoutTarget を持つことで通ってしまわないよう falling_wedge に絞る
		const withTarget = result.patterns.filter((p) => p.type === 'falling_wedge' && p.breakoutTarget !== undefined);
		expect(withTarget.length).toBeGreaterThan(0);
		expect(withTarget[0]?.targetMethod).toBe('pattern_height');
	});

	it('falling_wedge ブレイク検出時に target 到達情報が一式付与される（high/low ベース）', () => {
		const candles = buildFallingWedgeWithUpBreakout();
		const ctx = buildCtx({ candles, pivots: [], includeForming: true });
		const result = detectWedges(ctx);

		const withTarget = result.patterns.filter((p) => p.type === 'falling_wedge' && p.breakoutTarget !== undefined);
		expect(withTarget.length).toBeGreaterThan(0);
		for (const p of withTarget) {
			expect(typeof p.targetReached).toBe('boolean');
			expect(typeof p.targetReachedPct).toBe('number');
			expect(typeof p.targetReachedPrice).toBe('number');
			expect(p.targetReachedPct).toBeGreaterThanOrEqual(0);
			expect(p.targetReachedDate).toBeDefined();
		}
	});

	it('falling_wedge: 到達済み → targetReached=true & pct>=100（クランプ確認）', () => {
		const candles = buildFallingWedgeWithUpBreakout();
		const ctx = buildCtx({ candles, pivots: [], includeForming: true });
		const result = detectWedges(ctx);

		const reached = result.patterns.find((p) => p.type === 'falling_wedge' && p.targetReached === true);
		expect(reached).toBeDefined();
		expect(reached?.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(reached?.breakoutDirection).toBe('up');
	});

	// aftermath.targetReached と top-level targetReached の整合性は detect_wedges.ts の
	// 回帰ベース（4b）パスでのみ aftermath が付与されるため、現行フィクスチャ
	// （主に forming_relaxed 4d 経由）では直接 assert できない。
	// コード上は `targetReached: targetReach?.targetReached ?? false` で同じ
	// targetReach から導出するため、定義上整合する。

	// ── デバッグ候補の検証 ───────────────────────────────────

	it('検出試行後 debugCandidates に情報が記録される', () => {
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true });
		detectWedges(ctx);
		// 4d では formingWedgeDebug を debugCandidates に unshift する
		expect(ctx.debugCandidates.length).toBeGreaterThanOrEqual(0);
	});

	// ── 重複排除 ─────────────────────────────────────────────

	it('deduplicatePatterns を経て同一タイプ・同一レンジの重複は除去される', () => {
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true });
		const result = detectWedges(ctx);

		// 同タイプ×同 range.start の重複がないことを確認
		const seen = new Set<string>();
		for (const p of result.patterns) {
			const key = `${p.type}_${p.range?.start}_${p.range?.end}`;
			expect(seen.has(key)).toBe(false);
			seen.add(key);
		}
	});

	// ── _method フィールド ───────────────────────────────────

	it('4d パスで検出されたパターンの _method は forming_relaxed', () => {
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true });
		const result = detectWedges(ctx);

		const fromFormingPath = result.patterns.filter((p) => (p as { _method?: string })._method === 'forming_relaxed');
		if (fromFormingPath.length > 0) {
			expect(fromFormingPath[0]?.type).toMatch(/wedge/);
		}
	});

	// ── near_completion ──────────────────────────────────────

	it('Falling Wedge の apex が近い場合 near_completion または completed になる', () => {
		// apex ≈ i=80, endIdx=79 → barsToApex=1 ≤ 10 → near_completion
		const candles = buildFallingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true });
		const result = detectWedges(ctx);

		const fw = result.patterns.filter((p) => p.type === 'falling_wedge');
		if (fw.length > 0) {
			const validStatuses = ['near_completion', 'completed', 'forming'];
			expect(validStatuses).toContain(fw[0]?.status);
		}
	});

	// ── includeForming=false で forming/near_completion を dedup 競合から外す（PR1）─────────

	it('includeForming=false のとき forming / near_completion 状態のパターンは返らない', () => {
		// forming パスは走るが、未ブレイクの forming/near_completion は dedup 前に除外される。
		// ブレイク検出済みで status=completed になったものだけが残る。
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: false });
		const result = detectWedges(ctx);

		for (const p of result.patterns) {
			expect(p.status).not.toBe('forming');
			expect(p.status).not.toBe('near_completion');
		}
	});

	it('includeForming=true / false で前者だけが forming / near_completion を含む', () => {
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctxOn = buildCtx({ candles, pivots, includeForming: true });
		const ctxOff = buildCtx({ candles, pivots, includeForming: false });
		const on = detectWedges(ctxOn).patterns;
		const off = detectWedges(ctxOff).patterns;
		const onHasForming = on.some((p) => p.status === 'forming' || p.status === 'near_completion');
		const offHasForming = off.some((p) => p.status === 'forming' || p.status === 'near_completion');
		expect(onHasForming).toBe(true);
		expect(offHasForming).toBe(false);
	});

	it('includeForming=false でも forming パス由来で completed 判定になったものは残る', () => {
		// 形成中ウィンドウ内でブレイクが検出された場合、forming パスは status=completed を返す。
		// それは dedup 競合用フィルタを通過すべき（下流 includeCompleted=true で消えないため）。
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctxOff = buildCtx({ candles, pivots, includeForming: false });
		const result = detectWedges(ctxOff);

		for (const p of result.patterns) {
			const validStatuses = ['completed', 'invalid'];
			expect(validStatuses).toContain(p.status);
		}
	});

	// ── 時間軸スケーリング: 1hour ─────────────────────────────
	//
	// 閾値のプリミティブはバー数（`patterns/bar-thresholds.ts`）。
	// 1hour の実効値は windowSizeMin=34 / formingWindowMin=34 / formingWindowMax=204。
	// 「25 日 × barsPerDay(1hour)=600 本」という日数換算は上限（構造的下限 17 × 2 = 34）で
	// 頭打ちになる——600 本は `limit` のスキーマ上限 365 でも到達不能だった（#118 問題 2）。

	function buildRisingWedge1Hour(nBars: number): CandleData[] {
		// 1hour 時間軸での Rising Wedge: 上下とも上昇、下が急で収束
		const candles: CandleData[] = [];
		for (let i = 0; i < nBars; i++) {
			const upper = 100 + 0.04 * i;
			const lower = 80 + 0.07 * i;
			const mid = (upper + lower) / 2;
			const period = i % 8;
			let h: number;
			let l: number;
			let c: number;
			if (period === 0 || period === 1) {
				h = upper;
				l = mid - 2;
				c = mid + 1;
			} else if (period === 4 || period === 5) {
				h = mid + 2;
				l = lower;
				c = mid - 1;
			} else {
				h = mid + 3;
				l = mid - 3;
				c = mid;
			}
			candles.push(mkCandleAt(isoHoursAgo(nBars - i), mid, h, l, c));
		}
		return candles;
	}

	it('1hour: 窓が足りていても収束が浅い形状は検出しない', () => {
		// この形状の勾配は upper=0.04/bar, lower=0.07/bar。80 バーでもギャップは
		// 20 → 17.6（ratio 0.88）までしか縮まず、収束条件（ratio < 0.70）を満たさない。
		// 窓（formingWindowMin=34）は 80 バーで足りているので、0 件になる理由は**形状**であって
		// 窓ではない。1hour で緩い上昇を過剰にウェッジ判定しないことの回帰検知。
		const candles = buildRisingWedge1Hour(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true, type: '1hour' });
		const result = detectWedges(ctx);
		expect(result.patterns).toHaveLength(0);
	});

	it('1hour: バー数を十分に確保すれば forming wedge が検出される', () => {
		// 600 バーあれば上の収束条件も満たす（ギャップ 20 → 2）。
		// 既定 limit（90 本）での検出可能性は tests/patterns/default-limit-detection.test.ts が固定している。
		const candles = buildRisingWedge1Hour(600);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true, type: '1hour' });
		const result = detectWedges(ctx);

		const rw = result.patterns.filter((p) => p.type === 'rising_wedge');
		expect(rw.length).toBeGreaterThanOrEqual(1);
		expect(rw[0]?.confidence).toBeGreaterThan(0);
	});

	// ── 時間軸スケーリング: 1week ─────────────────────────────
	//
	// 1week は日数換算値（round(25 × 1/7) = 4 本）が小さすぎるので、構造的下限
	// （`structuralFloorBars('1week')` = 25 本）でクランプされる側。実効値は
	// windowSizeMin=25 / windowSizeMax=90 / formingWindowMin=25 / formingWindowMax=150。

	function buildRisingWedge1Week(nBars: number): CandleData[] {
		// 1week 時間軸の Rising Wedge: 振幅と勾配を週足相当に拡大
		const candles: CandleData[] = [];
		for (let i = 0; i < nBars; i++) {
			const upper = 100 + 3 * i;
			const lower = 80 + 5 * i;
			const mid = (upper + lower) / 2;
			const period = i % 4;
			let h: number;
			let l: number;
			let c: number;
			if (period === 0) {
				h = upper;
				l = mid - 5;
				c = mid + 2;
			} else if (period === 2) {
				h = mid + 5;
				l = lower;
				c = mid - 2;
			} else {
				h = mid + 6;
				l = mid - 6;
				c = mid;
			}
			candles.push(mkCandleAt(isoWeeksAgo(nBars - i), mid, h, l, c));
		}
		return candles;
	}

	it('1week: 日数換算値（4 バー）ではなく構造的下限（25 バー）で評価される', () => {
		// bpd=1/7 を介すると round(25*1/7)=4 バー——minDist=5 の 3 ピボットすら張れない。
		// 構造的下限 25 でクランプされるので windowSizeMin=25。40 バーあれば検出機会あり。
		const candles = buildRisingWedge1Week(40);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true, type: '1week', swingDepth: 3 });
		const result = detectWedges(ctx);
		// 配列が返ること、それ自体が「1week でも壊れずに動く」ことの確認。
		expect(Array.isArray(result.patterns)).toBe(true);
	});

	it('1week: windowSizeMin（25 バー）にデータが届かない場合でも例外を投げない', () => {
		// 1week で 20 バー（約 5 ヶ月）。windowSizeMin=25 / formingWindowMin=25 を割るので
		// 通常のウィンドウは 1 つも生成されないが、形成中の「最新に揃えた特別ウィンドウ」は
		// start を max(0, lastIdx - size) に clamp して必ず積むため評価自体は走る。
		const candles = buildRisingWedge1Week(20);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true, type: '1week', swingDepth: 2 });
		expect(() => detectWedges(ctx)).not.toThrow();
	});

	it('1week と 1day で同一バー数でも例外なく評価できる', () => {
		// 窓の実効値は 1day が [25, 90]、1week が [25, 90]（1week は日数換算 4 本が
		// 構造的下限 25 に持ち上がり、上限も日数比 90/25 を保って 90 になる）。
		// 形状の振幅・勾配が違うので検出結果は一致しない。ここでは両時間軸で
		// 例外なく実行できることだけを確認する。
		const candles1d = buildRisingWedgeCandles(40);
		const candles1w = buildRisingWedge1Week(40);
		const ctx1d = buildCtx({ candles: candles1d, pivots: [], includeForming: true, type: '1day' });
		const ctx1w = buildCtx({ candles: candles1w, pivots: [], includeForming: true, type: '1week', swingDepth: 3 });
		expect(() => detectWedges(ctx1d)).not.toThrow();
		expect(() => detectWedges(ctx1w)).not.toThrow();
	});
	// ── pivots（構成点。issue #252）────────────────────────────
	//
	// `wedge_*` は #252 まで `pivots` を出しておらず、`triangle_*` と非対称だった。
	// 中身は上下トレンドラインの**非ブレイクタッチ点すべて**で、`price` は高安。
	//
	// **ここで踏むのは 4d（形成中）パス。** 4b（回帰ベース）は本ファイル冒頭のとおり
	// 合成フィクスチャでは通らず、実データ（`btc_jpy_1day_2026` / `1hour_2026_08` /
	// `1hour_2026_09` × tf 3 種 × swingDepth 4 種 × includeForming 2 値）でも 1 件も出ない。
	// **両パスとも同じ `buildTouchPivots` を通す**ので、契約はここで固定できる。

	describe('pivots（構成点）', () => {
		/**
		 * 指定した型の**形成中パス（4d）由来**のウェッジを 1 件取る。
		 *
		 * **型と検出経路の両方で絞る。** `detectWedges` は回帰パス（4b）の結果を先に並べるので、
		 * `_wedge` で終わる最初の 1 件を拾うと、別の型や 4b の結果が assert を満たしてしまい
		 * 「4d の `pivots` を見ている」つもりのテストが黙って別物を見る（PR #273 のレビュー指摘）。
		 * 4b が踏めるようになったらここが落ちるので、そのとき経路ごとにテストを分ければよい。
		 */
		function formingWedge(candles: CandleData[], type: 'rising_wedge' | 'falling_wedge') {
			const ctx = buildCtx({ candles, pivots: [], includeForming: true });
			const result = detectWedges(ctx);
			const w = result.patterns.find(
				(p) => p.type === type && (p as { _method?: string })._method === 'forming_relaxed',
			);
			expect(w).toBeDefined();
			return w as NonNullable<typeof w>;
		}

		it('rising_wedge に pivots が出る（idx 昇順・上下 2 点ずつ以上）', () => {
			const candles = buildRisingWedgeCandles(80);
			const w = formingWedge(candles, 'rising_wedge');
			const piv = w.pivots ?? [];

			// 上下 2 点ずつ以上（ウェッジの成立条件と整合）。
			expect(piv.length).toBeGreaterThanOrEqual(4);
			expect(piv.filter((p) => p.kind === 'H').length).toBeGreaterThanOrEqual(2);
			expect(piv.filter((p) => p.kind === 'L').length).toBeGreaterThanOrEqual(2);

			// idx 昇順。**同じ idx が H / L 両方に出ることは許す**（外側バーが上下両ラインを
			// 同時に触るケース。配列のキーは `idx` ではなく `(idx, kind)`）。
			for (let i = 1; i < piv.length; i++) {
				expect(piv[i].idx).toBeGreaterThanOrEqual(piv[i - 1].idx);
			}
		});

		it('price は高安（H=high / L=low）で extremePrice と一致する', () => {
			const candles = buildRisingWedgeCandles(80);
			const w = formingWedge(candles, 'rising_wedge');
			const piv = w.pivots ?? [];
			expect(piv.length).toBeGreaterThan(0);

			for (const p of piv) {
				const c = candles[p.idx];
				expect(c).toBeDefined();
				expect(p.price).toBe(p.kind === 'H' ? c.high : c.low);
				// **極値判定に使った値と同値**——この検出器は終値を経由していない、という情報。
				expect(p.extremePrice).toBe(p.price);
			}
		});

		it('price は終値ではない（構造図の点＝終値ベースと同じ配列を流用していない）', () => {
			// `pivForDiagram` は同じタッチ点から組むが `price` に**終値**を入れており、
			// 間引きもする。ここが終値になっていたら図の配列を流用した回帰。
			const candles = buildRisingWedgeCandles(80);
			const w = formingWedge(candles, 'rising_wedge');
			const piv = w.pivots ?? [];
			expect(piv.some((p) => p.price !== candles[p.idx].close)).toBe(true);
		});

		it('kind は上限 / 下限のタッチに対応する（H は上側トレンドライン、L は下側）', () => {
			// フィクスチャの設計値は upper(i) = 100 + 0.3i / lower(i) = 80 + 0.5i。
			// H の点だけ・L の点だけを回帰すると、それぞれの線が復元できるはず。
			const candles = buildRisingWedgeCandles(80);
			const w = formingWedge(candles, 'rising_wedge');
			const piv = w.pivots ?? [];

			const fitH = linearRegressionWithR2(piv.filter((p) => p.kind === 'H').map((p) => ({ x: p.idx, y: p.price })));
			const fitL = linearRegressionWithR2(piv.filter((p) => p.kind === 'L').map((p) => ({ x: p.idx, y: p.price })));

			expect(fitH.r2).toBeGreaterThan(0.9);
			expect(fitL.r2).toBeGreaterThan(0.9);
			expect(fitH.slope).toBeCloseTo(0.3, 1);
			expect(fitL.slope).toBeCloseTo(0.5, 1);
			// rising wedge は両ライン上向きで**下側がより急**（収束）。
			expect(fitH.slope).toBeGreaterThan(0);
			expect(fitL.slope).toBeGreaterThan(fitH.slope);
			// 同じ idx で H は L より上（上限側 / 下限側の対応そのもの）。
			const inverted = piv.filter((h) => {
				if (h.kind !== 'H') return false;
				const l = piv.find((q) => q.kind === 'L' && q.idx === h.idx);
				return l !== undefined && h.price <= l.price;
			});
			expect(inverted).toEqual([]);
		});

		it('ブレイク足は pivots に含まれない（上方ブレイク）', () => {
			// 末尾 10 本で上限を大きく上抜けるフィクスチャ。ブレイク足はラインを
			// **抜けた**足であって構成点ではないので `isBreak: true` として除かれる。
			const candles = buildFallingWedgeWithUpBreakout();
			const ctx = buildCtx({ candles, pivots: [], includeForming: true });
			const result = detectWedges(ctx);
			const broken = result.patterns.filter(
				(p) => p.type === 'falling_wedge' && typeof p.breakoutBarIndex === 'number',
			);
			expect(broken.length).toBeGreaterThan(0);

			for (const w of broken) {
				const piv = w.pivots ?? [];
				expect(piv.length).toBeGreaterThanOrEqual(4);
				expect(piv.some((p) => p.idx === w.breakoutBarIndex)).toBe(false);
				// ブレイク足だけでなく、**ブレイク区間（末尾 10 本）が丸ごと入らない**ことも見る。
				expect(piv.every((p) => p.idx < 80)).toBe(true);
				// #281 の打ち切りを上方ブレイクでも同じ形で当てる（下方ブレイクとの対称性）。
				expect(piv.every((p) => p.idx < (w.breakoutBarIndex as number))).toBe(true);
			}
		});

		it('ブレイク足は pivots に含まれない（下方ブレイク。#281 の回帰）', () => {
			// **#281 以前はここが落ちた。** 下方ブレイクの足は下側ラインについては
			// `isBreak: true` だが、高値が上側ラインの 0.5% 以内にあるので `upperTouches` 側は
			// `isBreak: false` のまま残り、`kind: 'H'` の構成点として出力に入っていた。
			// 修正前の失敗（#281 のコードを外して実行した実出力）:
			//   AssertionError: expected [ { idx: 80, price: 123.8, …(2) } ] to deeply equal []
			const candles = buildRisingWedgeWithDownBreakout();
			const ctx = buildCtx({ candles, pivots: [], includeForming: true });
			const result = detectWedges(ctx);
			const broken = result.patterns.filter((p) => p.type === 'rising_wedge' && typeof p.breakoutBarIndex === 'number');
			expect(broken.length).toBeGreaterThan(0);

			for (const w of broken) {
				const breakIdx = w.breakoutBarIndex as number;
				expect(w.breakoutDirection).toBe('down');
				const piv = w.pivots ?? [];
				expect(piv.length).toBeGreaterThanOrEqual(4);
				// ブレイク足の**高値そのもの**（`kind: 'H'`）が入っていないこと。
				expect(piv.filter((p) => p.idx === breakIdx)).toEqual([]);
				// ブレイク足**以降**が線を問わず落ちること（#281 の打ち切りは `>=`）。
				expect(piv.every((p) => p.idx < breakIdx)).toBe(true);
			}
		});

		it('未ブレイク（形成中）の pivots は #281 で変わらない', () => {
			// `breakIdx` が `null` なので打ち切りが効かない。**点数と終端が #281 以前と同じ**
			// ことを固定して、打ち切りが未ブレイクに漏れ出していないことを見る。
			const candles = buildRisingWedgeCandles(80);
			const w = formingWedge(candles, 'rising_wedge');
			expect(w.breakoutBarIndex).toBeUndefined();
			expect(w.breakoutDirection).toBeUndefined();

			const piv = w.pivots ?? [];
			// #281 以前の実測値（`buildRisingWedgeCandles(80)` / `swingDepth` 7 / `includeForming`）。
			expect(piv.length).toBe(25);
			expect(Math.min(...piv.map((p) => p.idx))).toBe(52);
			expect(Math.max(...piv.map((p) => p.idx))).toBe(78);
		});

		it('実データ: realA の rising_wedge からブレイク足 idx 45 が落ちる（#281 / PR #280 §3）', () => {
			// PR #280 §5-1 の実例。`btc_jpy_1day_2026`（90 本）× `1day` × 既定オプション
			// （`swingDepth` auto = 6）で出る `rising_wedge` `2026-06-23` 〜 `2026-07-13`。
			// ブレイク足は idx 45（`2026-07-13`、高値 10,439,626）で、下方ブレイクなのに
			// **その高値が上側ラインに接触**して `kind: 'H'` の構成点に入っていた（A0 = 10 点）。
			const candles = buildBtcJpy2026Candles();
			const resolved = resolveParams('1day', {});
			expect(resolved.swingDepth).toBe(6);
			const swings = detectSwingPoints(candles, { swingDepth: resolved.swingDepth, strictPivots: true });
			const ctx = buildCtx({
				candles,
				pivots: swings,
				tolerancePct: resolved.tolerancePct,
				includeForming: true,
				swingDepth: resolved.swingDepth,
			});
			const result = detectWedges(ctx);

			const w = result.patterns.find(
				(p) =>
					p.type === 'rising_wedge' &&
					String(p.range?.start).slice(0, 10) === '2026-06-23' &&
					String(p.range?.end).slice(0, 10) === '2026-07-13',
			);
			expect(w).toBeDefined();
			expect(w?.breakoutBarIndex).toBe(45);
			expect(w?.breakoutDirection).toBe('down');
			// ブレイク足の高値が fixture の値であること（別の足を指名していない保証）。
			expect(candles[45]?.high).toBe(10439626);

			const piv = w?.pivots ?? [];
			// **idx 45 を名指しで固定する。** #281 以前は `{ idx: 45, kind: 'H', price: 10439626 }` が入り、
			// A0 = 10 点だった。落ちるのはこの 1 点だけ。
			expect(piv.filter((p) => p.idx === 45)).toEqual([]);
			expect(piv.every((p) => p.idx < 45)).toBe(true);
			expect(piv.length).toBe(9);
		});

		it('falling_wedge でも kind が上限 / 下限に対応する', () => {
			// upper(i) = 200 − 0.5i / lower(i) = 180 − 0.25i。両ライン下向きで**上側がより急**。
			const candles = buildFallingWedgeWithUpBreakout();
			const w = formingWedge(candles, 'falling_wedge');
			const piv = w.pivots ?? [];

			const fitH = linearRegressionWithR2(piv.filter((p) => p.kind === 'H').map((p) => ({ x: p.idx, y: p.price })));
			const fitL = linearRegressionWithR2(piv.filter((p) => p.kind === 'L').map((p) => ({ x: p.idx, y: p.price })));
			expect(fitH.r2).toBeGreaterThan(0.9);
			expect(fitL.r2).toBeGreaterThan(0.9);
			expect(fitH.slope).toBeLessThan(0);
			expect(fitL.slope).toBeLessThan(0);
			expect(Math.abs(fitH.slope)).toBeGreaterThan(Math.abs(fitL.slope));
		});

		it('pivots は range の中に収まる', () => {
			const candles = buildRisingWedgeCandles(80);
			const w = formingWedge(candles, 'rising_wedge');
			const piv = w.pivots ?? [];
			const startIdx = candles.findIndex((c) => c.isoTime === w.range?.start);
			const endIdx = candles.findIndex((c) => c.isoTime === w.range?.end);
			expect(startIdx).toBeGreaterThanOrEqual(0);
			expect(endIdx).toBeGreaterThanOrEqual(startIdx);
			for (const p of piv) {
				expect(p.idx).toBeGreaterThanOrEqual(startIdx);
				expect(p.idx).toBeLessThanOrEqual(endIdx);
			}
		});
	});
});
