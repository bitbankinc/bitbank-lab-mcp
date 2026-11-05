// 末尾で切り詰める。`limit` は先頭を切り詰めるが、走査はブレイク足より後ろしか見ないので先頭の切り詰めでは pct は動かず、値を動かすのは系列の末尾（いつ問い合わせたか）だから（#210 (3)）。
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import {
	getDefaultParamsForTf,
	getDefaultToleranceForTf,
	getHeadProminenceForTf,
	getHsShoulderMaxPctForTf,
	getSizeThresholdsForTf,
} from '../../tools/patterns/config.js';
import { detectHeadAndShoulders } from '../../tools/patterns/detect_hs.js';
import { detectSwingPoints, type Pivot } from '../../tools/patterns/swing.js';
import { TARGET_REACH_MAX_BARS, TARGET_REACHED_PCT_CAP } from '../../tools/patterns/target-reach.js';
import type { CandleData, DetectContext } from '../../tools/patterns/types.js';
import { asMockResult, assertOk } from '../_assertResult.js';
import { buildBtcJpy1hour202608Candles } from '../fixtures/btc_jpy_1hour_2026_08.js';

type Candle = ReturnType<typeof buildBtcJpy1hour202608Candles>[number];

/** `detect_patterns.ts` と同じ組み方の H&S 用 `DetectContext`。実効パラメータは `config.ts` から解決する（手書きすると時間軸オート表を変えたときにテストだけ古い値で通り続ける）。 */
function buildHsCtx(): DetectContext {
	const candles = buildBtcJpy1hour202608Candles() as CandleData[];
	const { swingDepth, minBarsBetweenSwings } = getDefaultParamsForTf('1hour');
	const tol = getDefaultToleranceForTf('1hour');
	const pivots = detectSwingPoints(candles, { swingDepth });
	return {
		candles,
		pivots,
		allPeaks: pivots.filter((p: Pivot) => p.kind === 'H'),
		allValleys: pivots.filter((p: Pivot) => p.kind === 'L'),
		tolerancePct: tol,
		headProminencePct: getHeadProminenceForTf('1hour'),
		sizeThresholds: getSizeThresholdsForTf('1hour'),
		hsShoulderMaxPct: getHsShoulderMaxPctForTf('1hour'),
		minDist: minBarsBetweenSwings,
		want: new Set(['head_and_shoulders', 'inverse_head_and_shoulders']),
		includeForming: false,
		debugCandidates: [],
		type: '1hour',
		swingDepth,
	};
}

async function runOn(candles: Candle[]) {
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = await detectPatterns('btc_jpy', '1hour', candles.length, {});
	assertOk(res);
	return res.data.patterns;
}

/** 末尾の切り詰めではバー添字がずれないので、構造の同一性は添字ごと突き合わせられる。 */
function structureKey(p: Record<string, unknown>): string {
	const range = p.range as { start?: string } | undefined;
	return [p.type, range?.start, p.breakoutBarIndex, p.breakoutTarget].join('|');
}

describe('targetReachedPct は系列の末尾に依存しない（issue #210 (3)）', () => {
	it('240 本で切っても 365 本でも、走査窓が揃っている構造の進捗は完全に一致する', async () => {
		const full = buildBtcJpy1hour202608Candles();
		const truncated = full.slice(0, 240);

		const shortRun = await runOn(truncated);
		const longRun = await runOn(full);

		const byKey = new Map(longRun.map((p) => [structureKey(p as Record<string, unknown>), p]));

		let compared = 0;
		for (const s of shortRun) {
			const sp = s as Record<string, unknown>;
			const lp = byKey.get(structureKey(sp)) as Record<string, unknown> | undefined;
			if (!lp) continue;
			// 短いほうで走査窓ぶんの足が揃っていない構造は、定義上まだ暫定値なので比較しない。
			const bi = sp.breakoutBarIndex;
			if (typeof bi !== 'number' || truncated.length - 1 - bi < TARGET_REACH_MAX_BARS) continue;
			compared++;
			expect({
				key: structureKey(sp),
				targetReached: sp.targetReached,
				targetReachedPct: sp.targetReachedPct,
				targetReachedPrice: sp.targetReachedPrice,
				targetReachedDate: sp.targetReachedDate,
				targetProgressOmittedReason: sp.targetProgressOmittedReason,
			}).toEqual({
				key: structureKey(lp),
				targetReached: lp.targetReached,
				targetReachedPct: lp.targetReachedPct,
				targetReachedPrice: lp.targetReachedPrice,
				targetReachedDate: lp.targetReachedDate,
				targetProgressOmittedReason: lp.targetProgressOmittedReason,
			});
		}
		// 比較対象が 0 件だと「一致した」が空虚に成立するので、実際に突き合わせたことを固定する。
		expect(compared).toBeGreaterThanOrEqual(1);
	});

	it('系列全体の最高値（2026-08-25T02:00Z の 12,933,047）が 8 月中旬ブレイクの採点に使われない', async () => {
		const patterns = await runOn(buildBtcJpy1hour202608Candles());
		const stuck = patterns.filter((p) => {
			const q = p as Record<string, unknown>;
			return q.targetReachedDate === '2026-08-25T02:00:00.000Z' && Number(q.breakoutBarIndex) < 200;
		});
		expect(stuck).toEqual([]);
	});

	it(`targetReachedPct は ${TARGET_REACHED_PCT_CAP} を超えない（issue #210 (1)）`, async () => {
		const patterns = await runOn(buildBtcJpy1hour202608Candles());
		const pcts = patterns
			.map((p) => (p as Record<string, unknown>).targetReachedPct)
			.filter((v): v is number => typeof v === 'number');
		expect(pcts.length).toBeGreaterThan(0);
		expect(Math.max(...pcts)).toBeLessThanOrEqual(TARGET_REACHED_PCT_CAP);
	});

	it('分母が潰れた逆 H&S は進捗を出さず理由を申告する（issue #210 (2)。旧 240,033% / 43,177%）', () => {
		// 検出器を直接呼ぶ。`data.patterns` の勝者は `statusScore` → `confidence` で決まり、confidence の式が変われば別の構造が代表になるが、守りたいのは「退化した分母では進捗を出さない」であって「その構造が dedup に勝つ」ではない。
		const patterns = detectHeadAndShoulders(buildHsCtx()).patterns as Array<Record<string, unknown>>;
		const omitted = patterns.filter((p) => p.targetProgressOmittedReason === 'degenerate_target_distance');
		// 空集合に対する forEach は何も検証しないので、まず件数と中身を固定する。
		expect(
			omitted.map((p) => [p.type, (p.pivots as Array<{ idx: number }>).map((q) => q.idx).join('-'), p.breakoutTarget]),
		).toEqual([
			['inverse_head_and_shoulders', '20-26-42-106-109', 10279567],
			['inverse_head_and_shoulders', '15-18-42-106-109', 10302900],
			['inverse_head_and_shoulders', '3-9-42-106-109', 10304386],
		]);
		for (const q of omitted) {
			// breakoutTarget は出る（target の算出式は #210 の対象外）。進捗系だけが消える。
			expect(q.breakoutTarget).toEqual(expect.any(Number));
			expect(q.targetReached).toBeUndefined();
			expect(q.targetReachedPct).toBeUndefined();
			expect(q.targetReachedDate).toBeUndefined();
			expect(q.targetReachedPrice).toBeUndefined();
		}
	});

	it('窓先頭の履歴不足 H&S は出力に残らず、進捗の無言候補にもならない', async () => {
		// どの構造が dedup に勝つかに依存しない形にしてある。対象を H&S 系に絞るのは #210 (2) の範囲がそこだから。
		const patterns = (await runOn(buildBtcJpy1hour202608Candles())) as Array<Record<string, unknown>>;
		const scored = patterns.filter(
			(q) =>
				(q.type === 'head_and_shoulders' || q.type === 'inverse_head_and_shoulders') &&
				q.breakoutTarget !== undefined &&
				// 未ブレイク（`near_completion` 等）は進捗の算出対象外。`computeTargetReach` を呼ぶ条件が `breakout` の存在なので、`breakoutTarget` だけでは足りない。
				q.breakoutBarIndex !== undefined,
		);
		// 履歴ウォームアップにより、fixture の H&S は全件が出力前に除外される。
		expect(scored).toHaveLength(0);
	});
});
