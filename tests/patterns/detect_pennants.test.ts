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

		const flags = result.patterns.filter((p) => p.type === 'flag');
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

		const flags = result.patterns.filter((p) => p.type === 'flag');
		const withBreakout = flags.filter((p) => p.breakoutBarIndex !== undefined);

		expect(withBreakout.length).toBeGreaterThan(0);
		for (const p of withBreakout) {
			// 保ち合いの最終スイング（i=13 or 14）以降にブレイクが検出されること
			expect(p.breakoutBarIndex!).toBeGreaterThanOrEqual(14);
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

		const flags = result.patterns.filter((p) => p.type === 'flag');
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
});
