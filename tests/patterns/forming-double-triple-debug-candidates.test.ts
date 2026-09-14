/**
 * tests/patterns/forming-double-triple-debug-candidates.test.ts
 *
 * 形成中 double / triple が `debug.candidates` に痕跡を残すことの回帰テスト（issue #158）。
 * #155 / PR #159 が形成中 H&S にやったことの、形成中 double top / bottom・triple top / bottom
 * 4 経路への横展開。
 *
 * カバーするもの:
 *   1. 各経路で、`data.patterns` に出たパターンと**同じ構成点**を持つ
 *      `accepted: true` / `status` 付きの candidate が積まれる
 *   2. 新設した理由コードが、それぞれ発火する最小ケースを持つ
 *   3. 算術的に到達しないガード（`forming_completion_below_min` の triple top）は、
 *      fixture ではなく「なぜ fixture を置けないか」の境界を固定する
 *   4. `pushCand` の `status` は**渡さなければ出ない**（共有ヘルパの additive 性）
 *
 * ## double 2 型の「形成中」経路は**もう無い**（#262 / #268 案 C）
 *
 * `tryFormingDoubleBottom` は #262、`tryFormingDoubleTop` は **#268 案 C** で削除した。
 * どちらも同じ構造は完成済み経路が組むので、#158 が守りたかったこと（**この経路が `view=debug` で
 * 無音でない**）は据え置きのまま、`status` が `forming` → `near_completion` に、
 * top 側の理由コード 6 件は**経路ごと消えた**（削除分の一覧は CHANGELOG の #268 節）。
 */
import { describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { asMockResult, assertOk } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({
	default: vi.fn(),
}));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { FORMING_MIN_COMPLETION as TRIPLE_MIN_COMPLETION } from '../../tools/patterns/detect_triples.js';
import type { CandDebugEntry, DetectContext, PatternEntry } from '../../tools/patterns/types.js';
import { pushCand } from '../../tools/patterns/types.js';
import { formingTripleTopRows, mirrorRows, rowsToCandles } from '../fixtures/forming_neckline_side_261.js';

type Candle = {
	isoTime: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
};

// 検出器の出力型をそのまま使う。ローカルに再宣言すると、debug 出力の契約が変わっても
// この回帰テストが落ちなくなる（CodeRabbit 指摘）。
type Candidate = CandDebugEntry;
type Pattern = Pick<PatternEntry, 'type' | 'status' | 'pivots'>;

/** 合成列の基準日（UTC）。実データ fixture と重ならない年初に置く。 */
const SYNTHETIC_START = '2026-01-01';
const makeIso = (dayOffset: number) => dayjs.utc(SYNTHETIC_START).add(dayOffset, 'day').toISOString();

/** 終値列からローソク足を作る。ヒゲ幅は `extremePrice` 基準の検査（サイズ・深さ）に効くので固定する。 */
function fromCloses(closes: number[], wick = 3): Candle[] {
	return closes.map((close, index) => ({
		isoTime: makeIso(index),
		open: close,
		high: close + wick,
		low: close - wick,
		close,
		volume: 100,
	}));
}

/** `[bars, endPrice][]` を線形補間して終値列にする。折り返し点がそのままピボット候補になる。 */
function legs(start: number, spec: Array<[bars: number, endPrice: number]>): number[] {
	const out = [start];
	let cur = start;
	for (const [bars, end] of spec) {
		for (let i = 1; i <= bars; i++) out.push(cur + ((end - cur) * i) / bars);
		cur = end;
	}
	return out.map((v) => Math.round(v * 100) / 100);
}

async function runDebug(
	candles: Candle[],
	opts: Parameters<typeof detectPatterns>[3] = {},
): Promise<{ patterns: Pattern[]; candidates: Candidate[] }> {
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = await detectPatterns('btc_jpy', '1day', candles.length, {
		includeForming: true,
		view: 'debug',
		...opts,
	});
	assertOk(res);
	return {
		patterns: res.data.patterns as unknown as Pattern[],
		candidates: (res.meta.debug?.candidates ?? []) as Candidate[],
	};
}

// ── 各経路の fixture ──
// 価格は 100 前後のスケール。形成バー数の下限（1day: triple 23 本）を
// 満たすために各脚を長めに取ってある——短いと `forming_bars_out_of_range` に落ちる。
//
// **`FORMING_DOUBLE_TOP` は #268 案 C で削除した**（形成中 `double_top` の経路ごと消えた）。
/**
 * 形成中ダブルボトムと形成中トリプルボトムが同時に立つ列（構成点を共有する）。
 *
 * **谷は 102 → 100.5 の順（切り下がり）にしてある**（#263）。以前は 100 → 101 で、最新足 103.6 と
 * 合わせて 3 谷が単調に切り上がっており（`|103.6 − 100| / 100` = 3.6% > `FORMING_STAIR_STEP_LIMIT`）、
 * 両向きになった単調性ゲートが `forming_stair_step_up` で落とす形だった
 * （#263 以前は `triple_bottom` の切り上がりを見ていなかったので通っていた）。
 *
 * **最終脚 103.6 は動かせない。** ここを下げると価格が谷ゾーンへ戻り、
 * `checkPostPivotInvalidation` が形成中ダブルボトムを `status: 'invalid'` にしてしまう（#126 G5）。
 * 単調性を崩すのは谷側で行う。
 */
const FORMING_BOTTOMS = legs(132, [
	[9, 102],
	[6, 118],
	[7, 100.5],
	[6, 118],
	[7, 103.6],
]);
const FORMING_TRIPLE_TOP = legs(100, [
	[9, 130],
	[6, 112],
	[7, 129],
	[6, 113],
	[7, 129.5],
]);

/**
 * その種別の**形成中パスの成功エントリ**だけを取り出す。
 * 同じ種別の strict / relaxed パスも `accepted: true` を積む（`prior_trend_insufficient_data` 等）
 * ので、`status` で絞らないと経路が混ざる。
 */
function formingAcceptedFor(candidates: Candidate[], type: string): Candidate[] {
	return candidates.filter((c) => c.accepted && c.type === type && c.status !== undefined);
}

describe('forming double / triple debug candidates (#158)', () => {
	describe('成功エントリ — data.patterns に出たパターンと同じ構成点が積まれる', () => {
		/**
		 * **`status` を `forming` から `near_completion` に、`indices` を 4 点から 3 点に変えた
		 * （issue #262）。** `tryFormingDoubleBottom` は削除され、同じ構造を完成済み経路の
		 * 未ブレイク分岐が組む。最新足は構成点ではなくなったので `current` の 1 点が消え、
		 * 成功エントリは完成済みパスと同じ 3 点（`valley1` / `peak` / `valley2`）になった。
		 * **#158 が守りたかったこと（この経路が `view=debug` に無音でない）は据え置き。**
		 */
		it('double_bottom', async () => {
			const { patterns, candidates } = await runDebug(fromCloses(FORMING_BOTTOMS));

			const pattern = patterns.find((p) => p.type === 'double_bottom' && p.status === 'near_completion');
			expect(pattern).toBeDefined();
			expect(pattern?.pivots?.map((p) => p.idx)).toEqual([9, 15, 22]);

			const hits = formingAcceptedFor(candidates, 'double_bottom');
			expect(hits).toHaveLength(1);
			expect(hits[0].status).toBe('near_completion');
			expect(hits[0].indices).toEqual([9, 15, 22]);
			expect(hits[0].points?.map((p) => [p.role, p.idx])).toEqual([
				['valley1', 9],
				['peak', 15],
				['valley2', 22],
			]);
		});

		it('triple_top', async () => {
			const { patterns, candidates } = await runDebug(fromCloses(FORMING_TRIPLE_TOP));

			const pattern = patterns.find((p) => p.type === 'triple_top' && p.status === 'forming');
			expect(pattern).toBeDefined();
			// #224 症状 3: pivots にもネックライン定義点（2 谷）が入る。並びは points と同じ H-L-H-L で、
			// 現在価格（暫定 3 山目）だけが pivots に入らない。
			expect(pattern?.pivots?.map((p) => [p.kind, p.idx])).toEqual([
				['H', 9],
				['L', 15],
				['H', 22],
				['L', 28],
			]);

			const hits = formingAcceptedFor(candidates, 'triple_top');
			expect(hits).toHaveLength(1);
			expect(hits[0].status).toBe('forming');
			// indices は既存の棄却エントリと同じ 3 点。ネックラインを引いた 2 谷は points にだけ載る
			expect(hits[0].indices).toEqual([9, 22, 35]);
			expect(hits[0].points?.map((p) => [p.role, p.idx])).toEqual([
				['peak1', 9],
				['valley1', 15],
				['peak2', 22],
				['valley2', 28],
				['current', 35],
			]);
		});

		it('triple_bottom', async () => {
			const { patterns, candidates } = await runDebug(fromCloses(FORMING_BOTTOMS));

			const pattern = patterns.find((p) => p.type === 'triple_bottom' && p.status === 'forming');
			expect(pattern).toBeDefined();
			expect(pattern?.pivots?.map((p) => [p.kind, p.idx])).toEqual([
				['L', 9],
				['H', 15],
				['L', 22],
				['H', 28],
			]);

			const hits = formingAcceptedFor(candidates, 'triple_bottom');
			expect(hits).toHaveLength(1);
			expect(hits[0].status).toBe('forming');
			expect(hits[0].indices).toEqual([9, 22, 35]);
			expect(hits[0].points?.map((p) => [p.role, p.idx])).toEqual([
				['valley1', 9],
				['peak1', 15],
				['valley2', 22],
				['peak2', 28],
				['current', 35],
			]);
		});
	});

	describe('理由コード — 新設した各分岐が発火する最小ケース', () => {
		const REACHABLE: Array<{
			reason: string;
			type: string;
			candles: () => Candle[];
			opts?: Parameters<typeof detectPatterns>[3];
		}> = [
			// **double 2 型の形成中分岐はこの表から全部消えた。**
			// `tryFormingDoubleBottom` の 4 分岐（`forming_pattern_height_below_min` /
			// `forming_valleys_not_level` / `forming_current_below_valley_zone` /
			// `forming_bars_out_of_range`）は issue #262 で、`tryFormingDoubleTop` の 6 分岐
			// （`forming_no_confirmed_peak` / `forming_no_valley_after_peak` /
			// `forming_peak_level_out_of_tolerance` / `forming_peaks_not_level` /
			// `forming_current_at_or_below_valley` / `forming_bars_out_of_range`）は #268 案 C で、
			// いずれも経路ごと削除した。同じ形の棄却は完成済み経路の理由コードが担う
			// （対応表は #262 / #268 の PR 本文。回帰は `size-gates-forming-doubles.test.ts` と
			// `neckline-side-forming-triple-double.test.ts`、出ないことは `no-forming-double-268.test.ts`）。
			// tryFormingTripleTop / tryFormingTripleBottom
			{
				reason: 'forming_bars_out_of_range',
				type: 'triple_top',
				candles: () =>
					fromCloses(
						legs(100, [
							[5, 130],
							[3, 120],
							[4, 129],
							[3, 121],
							[6, 129.5],
						]),
					),
				opts: { swingDepth: 2 },
			},
			{
				reason: 'forming_confidence_below_min',
				type: 'triple_top',
				// 2 山は 129 → 130 の順（**非単調**）。130 → 129 → 126.5 だと 3 点が単調に切り下がり、
				// 前段の単調性ゲートが `forming_stair_step_down` で先に落とす（#263）。
				// 山の平均は 129.5 のままなので `currentDiff` = 2.32% も confidence 0.41 も変わらない。
				candles: () =>
					fromCloses(
						legs(100, [
							[9, 129],
							[6, 112],
							[7, 130],
							[6, 113],
							[7, 126.5],
						]),
					),
			},
			{
				reason: 'forming_bars_out_of_range',
				type: 'triple_bottom',
				candles: () =>
					fromCloses(
						legs(132, [
							[5, 100],
							[3, 112],
							[4, 101],
							[3, 112],
							[6, 100.5],
						]),
					),
				opts: { swingDepth: 2 },
			},
			{
				reason: 'forming_confidence_below_min',
				type: 'triple_bottom',
				// 2 谷は 102.3 → 100 の順（**非単調**）。100 → 102.3 → 103.8 だと単調な切り上がりで
				// `forming_stair_step_up` が先に落とす（#263）。谷の差 2.25% は変わらないので
				// confidence 0.43 も変わらない。
				candles: () =>
					fromCloses(
						legs(132, [
							[9, 102.3],
							[6, 118],
							[7, 100],
							[6, 118],
							[7, 103.8],
						]),
					),
			},
			// issue #263: 単調性ゲートの**逆向き**。#263 以前は `triple_top` の切り上がりと
			// `triple_bottom` の切り下がりしか見ておらず、この 2 行は 1 件も発火しなかった。
			// 元からある向き（top の up / bottom の down）の回帰は `detect_triples.test.ts` が持つ。
			{
				reason: 'forming_stair_step_down',
				type: 'triple_top',
				// 3 山 100 → 99.5 → 97 の単調な切り下がり。ステップ 3.0% > 2%
				candles: () =>
					fromCloses(
						legs(90, [
							[9, 100],
							[6, 88],
							[7, 99.5],
							[6, 88],
							[7, 97],
						]),
					),
			},
			{
				reason: 'forming_stair_step_up',
				type: 'triple_bottom',
				// 3 谷 100 → 100.5 → 103 の単調な切り上がり。ステップ 3.0% > 2%
				candles: () =>
					fromCloses(
						legs(110, [
							[9, 100],
							[6, 112],
							[7, 100.5],
							[6, 112],
							[7, 103],
						]),
					),
			},
			// issue #261: 主構成点とネックラインの位置関係。**4 経路すべてに配線されている**ことを
			// この表で機械的に固定する（合成 fixture は `tests/fixtures/forming_neckline_side_261.ts`。
			// 最小対の対照系列・`details` の中身・実データの実例は
			// `neckline-side-forming-triple-double.test.ts` が持つ）。
			{
				reason: 'forming_peaks_below_neckline',
				type: 'triple_top',
				candles: () => rowsToCandles(formingTripleTopRows(98.4)),
			},
			{
				reason: 'forming_valleys_above_neckline',
				type: 'triple_bottom',
				candles: () => rowsToCandles(mirrorRows(formingTripleTopRows(98.4))),
			},
			// `double_top` の `forming_peaks_below_neckline` は #268 案 C で、`double_bottom` の
			// `forming_valleys_above_neckline` は #262 で、それぞれ完成済み経路の
			// `peaks_below_neckline` / `valleys_above_neckline` になった
			// （`neckline-side-forming-triple-double.test.ts` / `neckline-side-triple-double.test.ts`）。
			{
				reason: 'forming_completion_below_min',
				type: 'triple_bottom',
				// 山と谷の差が小さく、現在値が谷水準をわずかに下回る形。progress が負に振れて
				// completion が 0.4 を割る（bottom 側だけが到達しうる。定数の docstring を参照）
				candles: () =>
					fromCloses(
						legs(112, [
							[10, 100],
							[8, 105],
							[8, 100],
							[8, 105],
							[8, 95.5],
						]),
					),
			},
		];

		for (const { reason, type, candles, opts } of REACHABLE) {
			it(`${type}: ${reason}`, async () => {
				const { candidates } = await runDebug(candles(), { includeInvalid: true, ...opts });
				const hit = candidates.find((c) => c.type === type && c.reason === reason);
				expect(hit, `${type}:${reason} が積まれていない`).toBeDefined();
				expect(hit?.accepted).toBe(false);
				// 棄却エントリに status は付かない（`includeInvalid` で拾える status とは別物）
				expect(hit?.status).toBeUndefined();
			});
		}
	});

	describe('到達しないガード — fixture ではなく算術境界を固定する', () => {
		// double の 2 経路は #262 / #268 案 C で削除済みなので、この境界が意味を持つのは
		// **triple だけ**（top は到達しない / bottom は上の表に fixture がある）。
		it('triple top の forming_completion_below_min は現行の重みでは発火しない', () => {
			// top 側の progress = min(1, currentPrice / avgPeakPrice) は価格が正である限り正。
			// completion > 0.66 になり、しきい値を割れない（bottom 側は progress が負を取りうる）。
			const baseCompletion = 0.66;
			expect(baseCompletion).toBeGreaterThan(TRIPLE_MIN_COMPLETION);
		});
	});

	describe('pushCand の status', () => {
		function makeCtx(): { ctx: DetectContext; out: CandDebugEntry[] } {
			const out: CandDebugEntry[] = [];
			const ctx = {
				candles: [{ open: 1, high: 2, low: 0, close: 1, isoTime: '2026-01-01T00:00:00.000Z' }],
				debugCandidates: out,
			} as unknown as DetectContext;
			return { ctx, out };
		}

		it('渡さなければ status キー自体が出ない', () => {
			const { ctx, out } = makeCtx();
			pushCand(ctx, { type: 'double_top', accepted: false, reason: 'x', idxs: [0] });
			expect(out).toHaveLength(1);
			expect('status' in out[0]).toBe(false);
		});

		it('渡せばそのまま写る', () => {
			const { ctx, out } = makeCtx();
			pushCand(ctx, { type: 'double_top', accepted: true, status: 'forming', idxs: [0] });
			expect(out[0].status).toBe('forming');
		});
	});
});
