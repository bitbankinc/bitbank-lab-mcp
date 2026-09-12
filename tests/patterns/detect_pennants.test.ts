/**
 * detect_pennants.test.ts
 *
 * detectPennantsFlags のブレイクアウト検出開始位置（PR3 修正）の境界テスト。
 *
 * PR3 修正点:
 *   scanStart = consStart + Math.max(3, Math.floor((consEndIdx - consStart) * 0.3))
 *     ↓
 *   scanStart = consEndIdx + 1
 *
 * テスト観点:
 * 1. 保ち合い中の途中足が channel 外に振れても completed にならない（中間の false breakout 無視）
 * 2. 保ち合い終端後の本物のブレイクは正しく検出される
 * 3. ブレイクアウトなしの形成中パターンは forming/near_completion のまま
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { getHsShoulderMaxPctForTf, getSizeThresholdsForTf } from '../../tools/patterns/config.js';
import { detectPennantsFlags } from '../../tools/patterns/detect_pennants.js';
import { linearRegressionWithR2 } from '../../tools/patterns/regression.js';
import type { Pivot } from '../../tools/patterns/swing.js';
import type { CandleData, DetectContext } from '../../tools/patterns/types.js';

// ── ヘルパー ──────────────────────────────────────────────

function iso(daysAgo: number): string {
	return dayjs().subtract(daysAgo, 'day').startOf('day').toISOString();
}

function mkCandle(daysAgo: number, close: number): CandleData {
	return {
		open: close,
		high: close + 3,
		low: close - 3,
		close,
		isoTime: iso(daysAgo),
	};
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
		near: (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * tol,
		pct: (a: number, b: number) => ((b - a) / Math.max(1, a)) * 100,
		lrWithR2: (pts) => linearRegressionWithR2(pts),
	};
}

// ── テストデータ ──────────────────────────────────────────
// bull flag のベース:
//   pole: i=0..5 で 100→140（+40%, 5 bar 急騰）
//   consolidation: i=6..15 で 130〜138 のやや下傾斜の平行チャネル
//   ブレイクダウン: i=16..19 で 114〜120（下方ブレイクアウト）

function buildBullFlagCloses(): number[] {
	return [100, 108, 116, 124, 132, 140, 136, 138, 134, 136, 132, 134, 130, 132, 128, 130, 120, 118, 116, 114];
}

function closesToCandles(closes: number[]): CandleData[] {
	return closes.map((close, i) => mkCandle(closes.length - 1 - i, close));
}

// ── テスト ────────────────────────────────────────────────

afterEach(() => {
	vi.resetAllMocks();
});

describe('detectPennantsFlags — scanStart 修正の境界テスト（PR3）', () => {
	// ────────────────────────────────────────────────────────
	// 1. 保ち合い中の途中足が channel 外に出ても completed にならない
	// ────────────────────────────────────────────────────────
	it('保ち合い中の途中足が channel 外に振れても completed にならない', () => {
		// 中間 i=9 の close を upper channel を上抜ける値に設定（false breakout）。
		// 後続足は通常チャネル内に戻る。保ち合い終端後にはラインを抜けない。
		// → 中間の振れは breakout 扱いされず completed にならない。
		const closes = buildBullFlagCloses().slice(0, 16); // ブレイクダウン部分を除く
		closes[9] = 150; // 上方への false breakout

		const candles = closesToCandles(closes);
		const ctx = buildCtx({
			candles,
			want: new Set(['flag']),
			includeForming: true,
		});
		const result = detectPennantsFlags(ctx);

		const flags = result.patterns.filter((p) => p.type === 'bull_flag' || p.type === 'bear_flag');
		// 中間の振れによる completed が存在しないこと
		const completed = flags.filter((p) => p.status === 'completed');
		expect(completed).toHaveLength(0);
	});

	// ────────────────────────────────────────────────────────
	// 2. 保ち合い終端後の本物のブレイクは検出される
	// ────────────────────────────────────────────────────────
	it('保ち合い終端後のブレイクは正しく検出される（breakoutBarIndex は consEndIdx 以降）', () => {
		const candles = closesToCandles(buildBullFlagCloses());
		const ctx = buildCtx({
			candles,
			want: new Set(['flag']),
			includeForming: true,
		});
		const result = detectPennantsFlags(ctx);

		const flags = result.patterns.filter((p) => p.type === 'bull_flag' || p.type === 'bear_flag');
		const withBreakout = flags.filter((p) => p.breakoutBarIndex !== undefined);

		expect(withBreakout.length).toBeGreaterThan(0);
		for (const p of withBreakout) {
			// 保ち合いの最終スイング（i=13 or 14）以降にブレイクが検出されること
			expect(p.breakoutBarIndex as number).toBeGreaterThanOrEqual(14);
		}
	});

	// ────────────────────────────────────────────────────────
	// 3. ブレイクなしの形成中パターン → forming/near_completion
	// ────────────────────────────────────────────────────────
	it('ブレイクアウトなしの形成中 flag は forming/near_completion のまま', () => {
		// pole + consolidation のみ、ブレイクアウト足なし
		const closes = buildBullFlagCloses().slice(0, 16);
		const candles = closesToCandles(closes);

		const ctx = buildCtx({
			candles,
			want: new Set(['flag']),
			includeForming: true,
		});
		const result = detectPennantsFlags(ctx);

		const flags = result.patterns.filter((p) => p.type === 'bull_flag' || p.type === 'bear_flag');
		// 検出された flag は completed/invalid にならず forming 系であるべき
		for (const p of flags) {
			expect(['forming', 'near_completion']).toContain(p.status);
			expect(p.breakoutBarIndex).toBeUndefined();
		}
	});

	// ────────────────────────────────────────────────────────
	// 4. 基本動作: 空配列・データ不足
	// ────────────────────────────────────────────────────────
	it('ローソク足が少なすぎる → パターン不検出', () => {
		const candles = closesToCandles([100, 102, 101, 103, 104]);
		const ctx = buildCtx({ candles, want: new Set(['flag']) });
		const result = detectPennantsFlags(ctx);
		expect(result.patterns).toHaveLength(0);
	});

	it('空配列 → patterns は空', () => {
		const ctx = buildCtx({ candles: [], want: new Set(['flag']) });
		const result = detectPennantsFlags(ctx);
		expect(result.patterns).toHaveLength(0);
	});

	it('want に flag を含まない → 不検出', () => {
		const candles = closesToCandles(buildBullFlagCloses());
		const ctx = buildCtx({ candles, want: new Set(['head_and_shoulders']) });
		const result = detectPennantsFlags(ctx);
		expect(result.patterns).toHaveLength(0);
	});

	// ────────────────────────────────────────────────────────
	// 5. target 到達判定（high/low ベース）
	// ────────────────────────────────────────────────────────

	it('flag: breakout 検出時に targetReached / targetReachedPct / targetReachedPrice が整合', () => {
		const candles = closesToCandles(buildBullFlagCloses());
		const ctx = buildCtx({ candles, want: new Set(['flag']), includeForming: true });
		const result = detectPennantsFlags(ctx);

		const completed = result.patterns.filter(
			(p) => (p.type === 'bull_flag' || p.type === 'bear_flag') && p.breakoutBarIndex !== undefined,
		);
		expect(completed.length).toBeGreaterThan(0);
		for (const p of completed) {
			expect(typeof p.targetReached).toBe('boolean');
			expect(typeof p.targetReachedPct).toBe('number');
			expect(typeof p.targetReachedPrice).toBe('number');
			if (p.targetReached === true) {
				expect(p.targetReachedPct).toBeGreaterThanOrEqual(100);
			} else {
				expect(p.targetReachedPct).toBeLessThan(100);
			}
		}
	});

	it('flag: 下方ブレイク後に low が target を下回る → targetReached=true (high/low ベース)', () => {
		// 標準フィクスチャは bull flag（poleUp=true）に対する下方ブレイクなので
		// 期待方向と逆 = status='invalid' / outcome='failure' になる。
		// target reach 計算自体は breakoutDirection に従って実行されるので、
		// status を問わず breakoutDirection='down' のパターンで low=0 が到達扱いされることを確認する。
		const closes = buildBullFlagCloses();
		const candles = closesToCandles(closes);
		// 末尾の low を 0 にして必ず target 到達となる極端ケース
		const last = candles.length - 1;
		candles[last] = { ...candles[last], low: 0 };

		const ctx = buildCtx({ candles, want: new Set(['flag']), includeForming: true });
		const result = detectPennantsFlags(ctx);

		const downBreakouts = result.patterns.filter(
			(p) => (p.type === 'bull_flag' || p.type === 'bear_flag') && p.breakoutDirection === 'down',
		);
		expect(downBreakouts.length).toBeGreaterThan(0);
		for (const p of downBreakouts) {
			expect(p.targetReached).toBe(true);
			expect(p.targetReachedPct).toBeGreaterThanOrEqual(100);
			expect(p.targetReachedPrice).toBe(0);
		}
	});
});

// ── bull/bear 分類・pole/spread メタデータ・重複抑制の改修テスト ──

describe('detectPennantsFlags — bull/bear 分類とメタデータ', () => {
	it('急騰 pole 後の平行下降チャネル → bull_flag として検出される', () => {
		// pole: 100→140 (+40%, 5本) で急騰 / 保ち合い: 130〜138 で平行下降
		const candles = closesToCandles(buildBullFlagCloses());
		const ctx = buildCtx({ candles, want: new Set(['flag']), includeForming: true });
		const result = detectPennantsFlags(ctx);

		const bullFlags = result.patterns.filter((p) => p.type === 'bull_flag');
		expect(bullFlags.length).toBeGreaterThan(0);
		for (const p of bullFlags) {
			expect(p.poleDirection).toBe('up');
			expect(p.expectedBreakoutDirection).toBe('up');
			expect(p.priorTrendDirection).toBe('bullish');
			// メタデータが付与されている
			expect(typeof p.poleStartDate).toBe('string');
			expect(typeof p.poleEndDate).toBe('string');
			expect(typeof p.poleChangePct).toBe('number');
			expect(p.poleChangePct as number).toBeGreaterThanOrEqual(0.08);
			expect(typeof p.flagUpperSlope).toBe('number');
			expect(typeof p.flagLowerSlope).toBe('number');
			expect(typeof p.spreadAvg).toBe('number');
			expect(typeof p.spreadStability).toBe('number');
			expect(p.spreadStability as number).toBeGreaterThanOrEqual(0.5);
		}
	});

	it('bear_flag は急落 pole + 平行上昇チャネルで検出される', () => {
		// pole: 200→140 (-30%, 5本) で急落 / 保ち合い: 145〜152 で平行上昇
		const closes = [200, 188, 176, 164, 152, 140, 144, 142, 146, 144, 148, 146, 150, 148, 152, 150];
		const candles = closesToCandles(closes);
		const ctx = buildCtx({ candles, want: new Set(['flag']), includeForming: true });
		const result = detectPennantsFlags(ctx);

		const bearFlags = result.patterns.filter((p) => p.type === 'bear_flag');
		expect(bearFlags.length).toBeGreaterThan(0);
		for (const p of bearFlags) {
			expect(p.poleDirection).toBe('down');
			expect(p.expectedBreakoutDirection).toBe('down');
			expect(p.priorTrendDirection).toBe('bearish');
			expect(p.poleChangePct as number).toBeLessThan(0);
		}
	});

	it('緩やかな上昇（per-bar impulse 未達）は pole として認められず flag 検出されない', () => {
		// 30本かけて 100→115（+15%、per-bar impulse 低い、ATR mult も低い）。
		// minPolePct 0.08 と minPoleATRMult 2.5 + perBarImpulse 0.4 のうち
		// perBarImpulse が低くて棄却される想定。
		const closes: number[] = [];
		for (let i = 0; i < 30; i++) closes.push(100 + i * 0.5);
		// 保ち合い相当
		for (let i = 0; i < 8; i++) closes.push(115 + (i % 2));

		const candles = closesToCandles(closes);
		const ctx = buildCtx({ candles, want: new Set(['flag']), includeForming: true });
		const result = detectPennantsFlags(ctx);

		const flagsLike = result.patterns.filter(
			(p) => p.type === 'bull_flag' || p.type === 'bear_flag' || p.type === 'bull_pennant' || p.type === 'bear_pennant',
		);
		expect(flagsLike).toHaveLength(0);
	});

	it('pole と同方向の傾き（上昇 pole + 上昇チャネル）は flag/pennant として検出されない', () => {
		// pole: 100→140 (+40%, 5本) → 上昇チャネル 138, 142, 144, 148, 150, 154...
		const closes = [100, 108, 116, 124, 132, 140, 138, 142, 144, 148, 150, 154, 156, 160, 162];
		const candles = closesToCandles(closes);
		const ctx = buildCtx({ candles, want: new Set(['flag']), includeForming: true });
		const result = detectPennantsFlags(ctx);

		const flagsLike = result.patterns.filter((p) => p.type === 'bull_flag' || p.type === 'bull_pennant');
		expect(flagsLike).toHaveLength(0);
	});

	it('同区間の重複候補は dedup される（同 type は 1 件まで）', () => {
		// 同じ pole + 同じ保ち合いから複数 poleEnd 位置で flag が候補化される条件。
		// dedupFlagPennants が pole-end ±2 日 / 30% 期間重複で潰すため、最終的に 1 件に収束する想定。
		const candles = closesToCandles(buildBullFlagCloses());
		const ctx = buildCtx({ candles, want: new Set(['flag']), includeForming: true });
		const result = detectPennantsFlags(ctx);

		const bullFlags = result.patterns.filter((p) => p.type === 'bull_flag');
		expect(bullFlags.length).toBe(1);
	});

	it('debug candidate に spread / pole 検証情報が含まれる', () => {
		const candles = closesToCandles(buildBullFlagCloses());
		const ctx = buildCtx({ candles, want: new Set(['flag']), includeForming: true });
		detectPennantsFlags(ctx);

		const accepted = ctx.debugCandidates.filter((c) => c.accepted && c.reason === 'detected');
		expect(accepted.length).toBeGreaterThan(0);
		const d = accepted[0].details as Record<string, unknown>;
		expect(d.poleATRMult).toBeTypeOf('number');
		expect(d.polePerBarImpulse).toBeTypeOf('number');
		expect(d.spreadAvg).toBeTypeOf('number');
		expect(d.spreadStability).toBeTypeOf('number');
		expect(d.convergenceRatio).toBeTypeOf('number');
		expect(d.expectedBreakoutDirection).toBeDefined();
	});
});
