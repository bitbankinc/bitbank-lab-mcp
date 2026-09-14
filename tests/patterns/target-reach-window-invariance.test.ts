/**
 * tests/patterns/target-reach-window-invariance.test.ts
 *
 * issue #210 (3) の回帰。**同じ構造・同じブレイク足のパターンは、系列がどこで終わっていても
 * 同じ `targetReachedPct` / `targetReached` を返す**ことを固定する（走査窓ぶんの足が揃っている限り）。
 *
 * `computeTargetReach` の走査は元々 `candles.length` まで無制限だったので、系列が伸びるほど
 * extremum が更新されて値が動いた。実データ B（`btc_jpy` 1hour 365 本）を 240 本で切ると:
 *
 * | パターン | 240 本で | 365 本で |
 * |---|---:|---:|
 * | `falling_wedge`（ブレイク 2026-08-17T15:00Z） | 4,473% | 5,102% |
 * | `inverse_head_and_shoulders`（同 2026-08-17T18:00Z） | 209,921% | 240,033% |
 * | `triangle_ascending`（target 10,387,692） | 1,507% | 1,719% |
 * | `triangle_ascending`（target 11,671,022） | 382% | 483% |
 *
 * 4 件とも `targetReachedPrice` が **系列全体の最高値 12,933,047（2026-08-25T02:00Z）** に
 * 張り付いていた——8/17 のブレイクが 8/25 の高値で採点されていた、ということ。
 * これは #154（窓を広げたのに検出が減る）と同じクラスの欠陥で、走査を
 * `TARGET_REACH_MAX_BARS` 本で止めることで解消する。
 *
 * **末尾の切り詰めで見る理由**: `limit` は「直近 N 本」を意味するので**先頭**を切り詰める。
 * 走査はブレイク足より後ろしか見ないため、先頭を切っても共通するパターンの pct は元々動かない
 * （実測でも `limit` 120 / 150 / 200 / 250 / 300 / 365 の総当たりで差分 0）。値を動かすのは
 * **系列の末尾**＝「いつ問い合わせたか」で、それがこのテストの対象。
 */
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
import { linearRegressionWithR2 } from '../../tools/patterns/regression.js';
import { detectSwingPoints, type Pivot } from '../../tools/patterns/swing.js';
import { TARGET_REACH_MAX_BARS, TARGET_REACHED_PCT_CAP } from '../../tools/patterns/target-reach.js';
import type { CandleData, DetectContext } from '../../tools/patterns/types.js';
import { asMockResult, assertOk } from '../_assertResult.js';
import { buildBtcJpy1hour202608Candles } from '../fixtures/btc_jpy_1hour_2026_08.js';

type Candle = ReturnType<typeof buildBtcJpy1hour202608Candles>[number];

/**
 * `detect_patterns.ts` と同じ組み方の H&S 用 `DetectContext`（`tests/patterns/hs-window-btcjpy-1hour.ts`
 * と同じ idiom）。実効パラメータは**ハードコードせず `config.ts` から解決する**——手書きすると
 * 時間軸オート表を変えたときにテストだけ古い値で通り続ける。
 */
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
		near: (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * tol,
		pct: (a: number, b: number) => ((b - a) / Math.max(1, a)) * 100,
		lrWithR2: (pts) => linearRegressionWithR2(pts),
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
		// 修正前はこのうち 3 件が不一致だった（本ファイル冒頭の表のうち、240 本側に窓が揃う構造）。
		expect(compared).toBeGreaterThanOrEqual(3);
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
		// **検出器を直接呼ぶ**（`detectPatterns` の `data.patterns` は見ない）。
		//
		// 初版は `data.patterns` から `targetProgressOmittedReason` を持つ 2 件を名指しで拾っていたが、
		// この 2 件は **`globalDedup` の勝者**であって「分母が潰れた構造」の全体ではない。
		// 勝者は `statusScore` → `confidence` の順で決まるので、**confidence の式が変われば
		// 別の構造が代表になり、同じ 2 件が出力に残らなくなる**（issue #204 Phase 2 で実際にそうなった
		// ——分母が潰れた 4 構造はどれも代表を取れなくなり、`data.patterns` からは 0 件になった）。
		// #210 が守りたいのは「退化した分母では進捗を出さない」であって「その構造が dedup に勝つ」では
		// ないので、dedup より手前の検出器出力に対象を移す。
		const patterns = detectHeadAndShoulders(buildHsCtx()).patterns as Array<Record<string, unknown>>;
		const omitted = patterns.filter((p) => p.targetProgressOmittedReason === 'degenerate_target_distance');
		// 空集合に対する forEach は何も検証しないので、まず件数と中身を固定する。
		expect(
			omitted.map((p) => [p.type, (p.pivots as Array<{ idx: number }>).map((q) => q.idx).join('-'), p.breakoutTarget]),
		).toEqual([
			// #211（`necklineAt` の外挿クランプ）で 4 件 → 7 件に増えた。投影の起点が
			// 定義点の右端に頭打ちになるぶん `target` がブレイク終値へ寄り、`|target - breakoutPrice|`
			// が退化判定に掛かる構造が増える（＝**進捗を出さない**側に倒れる。無クランプ時に
			// 外挿で分母を水増ししていた構造が正体を現した形）。
			//
			// **#216 Phase 2（H&S 分）で 7 件 → 6 件**。`inverse_head_and_shoulders`
			// 225-232-249-265-272 が主構成点ネックライン側ゲートで落ちた——左肩 (idx 225 /
			// 終値 12,296,676) が `necklineAt(225)` = 12,282,275（クランプで谷1 の水準）より
			// **14,401 円上**にあり、逆 H&S の左肩がネックラインの上に乗っている形だった
			// （パターン高さ 245,081 円の 5.876%）。**このリストから消えたのは 1 件だけ**で、
			// 残る 6 件は `breakoutTarget` を含めて不変。
			//
			// **#244 Phase 2（肩の同水準判定の時間足別化）で 6 件 → 5 件**。
			// `inverse_head_and_shoulders` 230-232-249-283-285 が肩ゲートで落ちた——左肩
			// (idx 230 / 終値 12,215,999) と右肩 (idx 285 / 終値 12,529,686) の `relDiff` が
			// **2.504%** で、`1hour` の肩の上限（`getHsShoulderMaxPctForTf('1hour')` = 1.04%）を
			// 超える。この構造は Phase 1.5 §10 の**形 X**（実データ D の `30-32-49-83-85`。
			// B の idx − 200 = D の idx）で、目視で「呼べない」と判定済み。
			// **残る 5 件は `breakoutTarget` を含めて不変。**
			['inverse_head_and_shoulders', '242-245-249-265-272', 12558124],
			['inverse_head_and_shoulders', '230-232-249-265-272', 12602209],
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

	it('出力に残ったブレイク済み H&S は、進捗を出すか理由を申告するかのどちらかになっている', async () => {
		// 上のテストを検出器層へ移したぶん、`detectPatterns` 経由でも成り立つ不変条件を別に置く。
		// **どの構造が dedup に勝つかに依存しない**形にしてある。
		//
		// 対象を H&S 系に絞るのは #210 (2) の範囲がそこだから。
		//
		// **#224 症状 2 以降、triple / double も無言ではない。** `detect_triples.ts` は
		// 依然 `computeTargetReach` を呼んでいないが、`targetProgressOmittedReason` で
		// `not_computed_by_detector` を申告するようになった（doubles は `not_broken_out` /
		// `invalid_breakout_price`）。全 type を横断する「無言 0 件」の固定は
		// `tests/patterns/target-progress-declared.test.ts` にある。ここは #210 (2) の
		// 退化ガードが H&S でどう働くかの回帰なので、対象は H&S 系のまま。
		const patterns = (await runOn(buildBtcJpy1hour202608Candles())) as Array<Record<string, unknown>>;
		const scored = patterns.filter(
			(q) =>
				(q.type === 'head_and_shoulders' || q.type === 'inverse_head_and_shoulders') &&
				q.breakoutTarget !== undefined &&
				// 未ブレイク（`near_completion` 等）は進捗の算出対象外——`computeTargetReach` を
				// 呼ぶ条件が `breakout` の存在なので、`breakoutTarget` だけでは足りない。
				q.breakoutBarIndex !== undefined,
		);
		// 「対象が 1 件も無い」で空虚に通らないようにする。
		expect(scored.length).toBeGreaterThan(0);
		// 進捗系 3 フィールドは「理由を申告したか」で全か無かに揃う。
		expect(
			scored.map((q) => ({
				omitted: q.targetProgressOmittedReason !== undefined,
				hasPct: typeof q.targetReachedPct === 'number',
				hasReached: q.targetReached !== undefined,
			})),
		).toEqual(
			scored.map((q) => ({
				omitted: q.targetProgressOmittedReason !== undefined,
				hasPct: q.targetProgressOmittedReason === undefined,
				hasReached: q.targetProgressOmittedReason === undefined,
			})),
		);
	});
});
