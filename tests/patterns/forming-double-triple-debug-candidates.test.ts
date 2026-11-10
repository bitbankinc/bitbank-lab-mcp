// 形成中 double の経路は `tryFormingDoubleBottom` を #262、`tryFormingDoubleTop` を #268 案 C で削除したので、double は完成済み経路が組む。
import { describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { asMockResult, assertOk } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({
	default: vi.fn(),
}));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
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

// 検出器の出力型をそのまま使う。ローカルに再宣言すると、debug 出力の契約が変わってもこの回帰テストが落ちなくなる。
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

// 形成バー数の下限（1day: triple 23 本）を満たすために各脚を長めに取ってある（短いと `forming_bars_out_of_range` に落ちる）。
/** 最終脚 103.6 は動かせない（下げると価格が谷ゾーンへ戻り、`checkPostPivotInvalidation` がダブルボトムを `status: 'invalid'` にしてしまう。#126 G5）。谷は 102 → 100.5 の順にして、3 谷の単調な切り上がり（`forming_stair_step_up`。#263）を避けている。 */
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

/** 同じ種別の strict / relaxed パスも `accepted: true` を積む（`prior_trend_insufficient_data` 等）ので、`status` で絞らないと経路が混ざる。 */
function formingAcceptedFor(candidates: Candidate[], type: string): Candidate[] {
	return candidates.filter((c) => c.accepted && c.type === type && c.status !== undefined);
}

describe('forming double / triple debug candidates (#158)', () => {
	describe('成功エントリ — data.patterns に出たパターンと同じ構成点が積まれる', () => {
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
			// pivots にもネックライン定義点（2 谷）が入り、現在価格（暫定 3 山目）だけが pivots に入らない（#224 症状 3）。
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
			{
				reason: 'forming_completion_below_min',
				type: 'triple_top',
				// 山と谷の差が小さく、現在値が山水準を上回る形。progress が負に振れて completion が 0.4 を割る
				candles: () =>
					fromCloses(
						legs(93, [
							[10, 105],
							[8, 100],
							[8, 105],
							[8, 100],
							[8, 109.5],
						]),
					),
			},
			{
				reason: 'forming_completion_below_min',
				type: 'triple_bottom',
				// 上の鏡像。現在値が谷水準を下回る
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
