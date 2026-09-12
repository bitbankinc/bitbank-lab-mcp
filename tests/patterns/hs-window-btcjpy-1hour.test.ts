/**
 * BTC/JPY 1時間足 2026-08-24〜28 のスキャン窓の回帰（issue #157 / #146 の残り）。
 *
 * fixture は `tests/fixtures/btc_jpy_1hour_2026_08.ts`（2026-08-12T20:00Z 〜 08-28T00:00Z の 365 本）。
 *
 * ## `tests/patterns/detect_hs.test.ts` の `ISSUE_146_PIVOTS` との役割分担
 *
 * 両方を残している。**守る対象が違う。**
 *
 * | | 入力 | 守るもの |
 * |---|---|---|
 * | `detect_hs.test.ts` の `ISSUE_146_PIVOTS` | 人手で書き写したピボット列 | **窓生成ロジック単体**。`enumerateHsWindows` が交互列の崩れた `kind`/`idx`/`price` から窓を作るか。`tolerancePct` / `headProminencePct` の分離（#149）の振り分けもここ |
 * | 本ファイル | 実データ OHLC 365 本 | **`detectSwingPoints` を含む配線**。実 OHLC から実際にどのピボットが出るか、`pastBuffer` スライス後の idx が窓の idx と対応するか |
 *
 * 片方に寄せると診断力が落ちる。前者だけだと「`detectSwingPoints` がそのピボットを本当に出すか」
 * が未検証のままになる（#157 が「足りない」と指摘した点そのもの）。後者だけだと
 * `detectSwingPoints` の回帰と窓生成の回帰が同じ 1 本の失敗に潰れ、どちらが壊れたか分からない。
 *
 * ## `detect_patterns` を経由しない理由（`cap = 200`）
 *
 * `detect_patterns` の `view=debug` は candidates を 200 件で切る（`tools/detect_patterns.ts` の
 * `cap = 200`。accepted 優先 → rejected の順に詰める）。この fixture の 1hour / `swingDepth=3` /
 * `limit=365` は候補が cap を大きく超えるので、**観測できるかどうかが cap の詰め方に依存する**。
 * 本 fixture での実測:
 *
 * | 呼び方 | candidates | #146 の窓 |
 * |---|---|---|
 * | `patterns: ['head_and_shoulders']` | 200（cap 張り付き） | 観測できる（`filterCandidatesByWant`（#124）が他種別を先に落とすため） |
 * | 種別指定なし（既定の全パターン） | 200（cap 張り付き） | **押し出されて観測できない** |
 *
 * つまり `detect_patterns` 経由の回帰は「呼び出し側が種別を絞ったか」に暗黙に依存してしまう。
 * `detectHeadAndShoulders` を直接呼んで `ctx.debugCandidates`（トリム前。本 fixture で 373 件）を
 * 読めば cap から完全に独立する。
 */

import { describe, expect, it } from 'vitest';
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
import type { CandleData, DetectContext } from '../../tools/patterns/types.js';
import {
	BTC_JPY_1HOUR_2026_08_END_ISO,
	BTC_JPY_1HOUR_2026_08_OHLC,
	BTC_JPY_1HOUR_2026_08_START,
	buildBtcJpy1hour202608Candles,
} from '../fixtures/btc_jpy_1hour_2026_08.js';

const TF = '1hour';

// 実効パラメータは **ハードコードせず `config.ts` から解決する**。
// 手書きすると時間軸オート表を変えたときにテストだけ古い値で通り続ける。
const { swingDepth: TF_SWING_DEPTH, minBarsBetweenSwings: TF_MIN_DIST } = getDefaultParamsForTf(TF);
const TF_TOLERANCE = getDefaultToleranceForTf(TF);
// headProminencePct は tolerancePct とは独立の専用時間軸オート表を持つ（`getHeadProminenceForTf`。issue #198）。
// #149〜#197 は誤って tolerancePct の表を流用しており、1hour は 0.05 だった（#198 で正した対象そのもの）。
const TF_HEAD_PROMINENCE = getHeadProminenceForTf(TF);

/** #146 が観測した 5 点窓（左肩 / 谷1 / 頭 / 谷2 / 右肩）の fixture 上の idx */
const ISSUE_146_WINDOW = [283, 285, 294, 305, 308] as const;

/** #146 の 6 点（issue #157 の表）。`price` は終値。 */
const ISSUE_146_POINTS: Array<{ idx: number; price: number; kind: 'H' | 'L'; role: string }> = [
	{ idx: 272, price: 12_213_097, kind: 'L', role: '起点の安値' },
	{ idx: 283, price: 12_582_009, kind: 'H', role: '左肩' },
	{ idx: 285, price: 12_529_686, kind: 'L', role: '谷1' },
	{ idx: 294, price: 12_851_000, kind: 'H', role: '頭' },
	{ idx: 305, price: 12_531_708, kind: 'L', role: '谷2' },
	{ idx: 308, price: 12_617_817, kind: 'H', role: '右肩' },
];

function buildCtx(opts?: { swingDepth?: number; headProminencePct?: number }): DetectContext {
	const candles = buildBtcJpy1hour202608Candles() as CandleData[];
	const depth = opts?.swingDepth ?? TF_SWING_DEPTH;
	// **本 issue の主眼**: ピボットを人手で書き写さず `detectSwingPoints` から実際に出す。
	const pivots = detectSwingPoints(candles, { swingDepth: depth });
	const tol = TF_TOLERANCE;
	return {
		candles,
		pivots,
		allPeaks: pivots.filter((p: Pivot) => p.kind === 'H'),
		allValleys: pivots.filter((p: Pivot) => p.kind === 'L'),
		tolerancePct: tol,
		headProminencePct: opts?.headProminencePct ?? TF_HEAD_PROMINENCE,
		sizeThresholds: getSizeThresholdsForTf(TF),
		hsShoulderMaxPct: getHsShoulderMaxPctForTf(TF),
		minDist: TF_MIN_DIST,
		want: new Set(['head_and_shoulders']),
		includeForming: false,
		debugCandidates: [],
		type: TF,
		swingDepth: depth,
		near: (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * tol,
		pct: (a: number, b: number) => ((b - a) / Math.max(1, a)) * 100,
		lrWithR2: (pts) => linearRegressionWithR2(pts),
	};
}

const findIssueWindow = (ctx: DetectContext) =>
	ctx.debugCandidates.find(
		(d) => d.type === 'head_and_shoulders' && JSON.stringify(d.indices) === JSON.stringify([...ISSUE_146_WINDOW]),
	);

describe('BTC/JPY 1hour 2026-08 fixture のスキャン窓（issue #157）', () => {
	// ── fixture 自体の形（凍結条件の固定） ──

	describe('fixture の形', () => {
		it('365 本・1 時間刻みで欠損がない', () => {
			const candles = buildBtcJpy1hour202608Candles();
			expect(candles).toHaveLength(365);
			expect(BTC_JPY_1HOUR_2026_08_OHLC).toHaveLength(365);

			const start = Date.parse(BTC_JPY_1HOUR_2026_08_START);
			for (let i = 0; i < candles.length; i++) {
				expect(Date.parse(candles[i].isoTime)).toBe(start + i * 3_600_000);
			}
		});

		it('末尾が 2026-08-28T00:00:00.000Z で、除外した 12,977,887 の足を含まない', () => {
			// **末尾を切ってあるのは意図的**（fixture 先頭のコメントに理由がある）。
			// 直後の足 2026-08-28T01:00Z の終値 12,977,887 は頭 12,851,000 より高く、
			// これを含めると `enumerateHsWindows` が別の足を頭に取り、
			// `headIsExtremeInSpan`（#154 / PR #156）が #146 の窓を弾く。
			//
			// **「頭が fixture 全体の最高終値」ではない**ことに注意（idx 297 の終値 12,868,505 が
			// 頭より高い）。窓生成が見るのは**ピボットの price** であって生の終値ではなく、
			// idx 297 は前後 3 本の高値比較でピボットにならないため頭の座は動かない。
			// ここで固定するのは「切り落とした足が入っていない」ことだけ。
			const candles = buildBtcJpy1hour202608Candles();
			expect(candles.at(-1)?.isoTime).toBe(BTC_JPY_1HOUR_2026_08_END_ISO);
			expect(BTC_JPY_1HOUR_2026_08_END_ISO).toBe('2026-08-28T00:00:00.000Z');
			expect(Math.max(...candles.map((c) => c.close))).toBeLessThan(12_977_887);
		});
	});

	// ── detectSwingPoints の実挙動（#157 が「守れていない」と挙げた 1 点目） ──

	describe('detectSwingPoints（swingDepth=3）が #146 の 6 点を出す', () => {
		it('6 点が実際のピボットとして出る（idx / kind / price）', () => {
			const candles = buildBtcJpy1hour202608Candles() as CandleData[];
			expect(TF_SWING_DEPTH).toBe(3); // 1hour の時間軸オート値
			const pivots = detectSwingPoints(candles, { swingDepth: TF_SWING_DEPTH });

			for (const want of ISSUE_146_POINTS) {
				const got = pivots.find((p) => p.idx === want.idx);
				expect(got, `${want.role}（idx=${want.idx}）がピボットとして出ていない`).toBeDefined();
				expect(got?.kind).toBe(want.kind);
				// `price` は終値（`swing.ts`: 判定は high/low、格納は close）
				expect(got?.price).toBe(want.price);
			}
		});

		it('左肩→頭 11 本 / 頭→右肩 14 本（#146 の記述と一致）', () => {
			expect(ISSUE_146_WINDOW[2] - ISSUE_146_WINDOW[0]).toBe(11);
			expect(ISSUE_146_WINDOW[4] - ISSUE_146_WINDOW[2]).toBe(14);
		});

		it('頭と谷2 の間に高値ピボット idx 299 が挟まり、交互列が崩れている（#146 の前提）', () => {
			// **これが #146 の偽陰性の原因そのもの。** 頭(294) の直後・谷2(305) より前に
			// H ピボットが 1 つ入るため、配列上で連続する 5 ピボットは H-L-H-L-H にならない。
			// 旧実装はその交互列を要求していたので窓が 1 つも作られなかった。
			// **合成ピボット列ではなく実 OHLC から出ていること**を固定する。
			const candles = buildBtcJpy1hour202608Candles() as CandleData[];
			const pivots = detectSwingPoints(candles, { swingDepth: TF_SWING_DEPTH });

			const breaker = pivots.find((p) => p.idx === 299);
			expect(breaker?.kind).toBe('H');
			expect(breaker?.price).toBe(12_726_672);

			// 頭と谷2 の間の H ピボットは idx 299 だけ
			expect(pivots.filter((p) => p.kind === 'H' && p.idx > 294 && p.idx < 305).map((p) => p.idx)).toEqual([299]);
			// 邪魔者が頭より低いので `extremeBetween` は頭の座を 294 のまま保つ
			expect(breaker?.price).toBeLessThan(12_851_000);
		});
	});

	// ── 窓生成と棄却理由（固定すべき 2 点） ──

	describe('頭 12,851,000 を中心とする 5 点窓', () => {
		it('候補として生成される（#147 以前は 0 件だった）', () => {
			const ctx = buildCtx();
			detectHeadAndShoulders(ctx);
			expect(findIssueWindow(ctx)).toBeDefined();
		});

		it("既定（時間軸オート = getHeadProminenceForTf('1hour') = 0.83%）では accepted になる（issue #198 の修正確認）", () => {
			// 頭 12,851,000 / 両肩の高いほう 12,617,817 → 実際の突出は +1.85%。
			// #198 以前は auto が tolerancePct の表（1hour=5%）を流用しており 1.85% < 5% で
			// head_not_higher により棄却されていた（起票者が報告した偽陰性そのもの）。
			// #198 で auto を専用テーブル（1hour=0.83%）に差し替えたので、1.85% >= 0.83% を満たし
			// accepted になる。
			const ctx = buildCtx();
			expect(TF_HEAD_PROMINENCE).toBe(0.0083);
			detectHeadAndShoulders(ctx);

			const cand = findIssueWindow(ctx);
			expect(cand?.accepted).toBe(true);
			expect(cand?.reason).toBeUndefined();
			const points = cand?.points as Array<{ role: string; idx: number; price: number }>;
			expect(points.find((p) => p.role === 'head')).toMatchObject({ idx: 294, price: 12_851_000 });
			expect(points.find((p) => p.role === 'left_shoulder')).toMatchObject({ idx: 283, price: 12_582_009 });
			expect(points.find((p) => p.role === 'right_shoulder')).toMatchObject({ idx: 308, price: 12_617_817 });
		});

		it('headProminencePct を明示的に 0.05（#198 以前の旧オート値）に戻すと head_not_higher で棄却される', () => {
			// #198 が正した対象そのものの回帰: この実データの構造では頭の突出は +1.85% しかなく、
			// 5% を要求する閾値では今も足りない（値自体は #198 で変わっていない。変わったのは
			// auto の解決先だけ）。要求水準は 12,617,817 × 1.05 = 13,248,708。
			const ctx = buildCtx({ headProminencePct: 0.05 });
			detectHeadAndShoulders(ctx);

			const cand = findIssueWindow(ctx);
			expect(cand?.accepted).toBe(false);
			expect(cand?.reason).toBe('head_not_higher');

			const details = cand?.details as {
				leftShoulder: number;
				head: number;
				rightShoulder: number;
				headProminencePct: number;
			};
			expect(details.leftShoulder).toBe(12_582_009);
			expect(details.head).toBe(12_851_000);
			expect(details.rightShoulder).toBe(12_617_817);
			expect(details.headProminencePct).toBe(0.05);
			// 棄却理由を出力から検算できる（#125 / #128 の方針）。
			expect(details.head).toBeLessThan(details.rightShoulder * (1 + details.headProminencePct));
		});

		it('頭以外のゲート（肩の左右差・ネックライン水平性）は通っている（headProminencePct=0.05 で頭のみ棄却させた状態で確認）', () => {
			// 理由の梯子は「肩 → 頭 → ネックライン」の順なので、`head_not_higher` が返る時点で
			// **肩は通過済み**だが、**ネックラインは頭より後段なので未評価**。つまり水平性が
			// 通っていることは reason からは分からず、ここで別に固定する価値がある。
			// 実測値そのものも併せて固定し、閾値だけ動かして読み替えられるのを防ぐ。
			// （#198 で auto の既定値が変わったため、頭だけを確実に落とすには headProminencePct を
			// 明示的に 0.05 へ戻す——auto のままでは上のテストの通り accepted になり reason が無い。）
			const ctx = buildCtx({ headProminencePct: 0.05 });
			detectHeadAndShoulders(ctx);

			const details = findIssueWindow(ctx)?.details as {
				shouldersDiffPct: number;
				shoulderMaxPct: number;
				necklineDiffPct: number;
				necklineMaxPct: number;
			};
			expect(details.shouldersDiffPct).toBeLessThan(details.shoulderMaxPct);
			expect(details.necklineDiffPct).toBeLessThan(details.necklineMaxPct);
			// 肩の左右差 0.284% / ネックライン水平性 0.016%（issue #157 の表）
			expect(details.shouldersDiffPct).toBeCloseTo(0.00284, 5);
			expect(details.necklineDiffPct).toBeCloseTo(0.00016, 5);
		});
	});

	// ── swingDepth=5 は範囲外（#146 の「やらないこと」） ──

	it('swingDepth=5 では窓が生成されない（浅い谷1 がピボットにならない・#157 の範囲外）', () => {
		// 谷1（idx 285、左肩から -0.42%）が swingDepth=5 ではピボットとして出ず、
		// ネックラインの片側が張れない。解くには `detectSwingPoints` を触る必要があり
		// #146 の「やらないこと」に該当する。**0 件が正しい**ことを固定する。
		const candles = buildBtcJpy1hour202608Candles() as CandleData[];
		expect(detectSwingPoints(candles, { swingDepth: 5 }).some((p) => p.idx === 285)).toBe(false);

		const ctx = buildCtx({ swingDepth: 5 });
		detectHeadAndShoulders(ctx);
		expect(findIssueWindow(ctx)).toBeUndefined();
	});
});
