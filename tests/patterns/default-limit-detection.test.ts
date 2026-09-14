/**
 * tests/patterns/default-limit-detection.test.ts
 *
 * issue #118 問題 1 / 2 / 3 の回帰テスト。
 *
 * `tests/patterns/invariants.test.ts` の不変条件 9（到達性）は「閾値の**最小側**がスキャン窓に
 * 収まるか」という算術だけを見る。閾値が収まっていても検出器が実際に候補を返すとは限らず、
 * **最大側は見ていない**ので、ここでは合成データを既定 `limit`（90 本）ぶん与えて
 * **検出器が実際にパターンを返すこと**を時間足ごとに固定する。
 *
 * 問題 1 / 2（wedge / triple）の修正前は次のとおり 0 件だった（`limit` を上げても `4hour` の
 * 151 本要求までは届かず、`1hour` の 601 本要求はスキーマ上限 365 でも到達不能）:
 *
 * | 時間足 | 完成済み wedge | 形成中 triple |
 * |---|---|---|
 * | `1day`  | 1 件 | 1 件 |
 * | `4hour` | **0 件** | **0 件** |
 * | `1hour` | **0 件** | **0 件** |
 *
 * 問題 3（形成中 double / H&S）は最大側の問題で、最小側だけを見る到達性テストをすり抜けていた。
 * 下の専用 describe を参照。**double 側は #268 案 C で形成中経路ごと削除されたので、
 * 残っているのは H&S だけ**（形成中 triple は上の describe が既定 `limit` だけを見ている）。
 */
import { describe, expect, it } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { CandleTypeEnum } from '../../src/schema/base.js';
import {
	getDefaultParamsForTf,
	getDefaultToleranceForTf,
	getHsShoulderMaxPctForTf,
	getSizeThresholdsForTf,
} from '../../tools/patterns/config.js';
import { detectHeadAndShoulders, getHsFormingBarParams } from '../../tools/patterns/detect_hs.js';
import { detectTriples } from '../../tools/patterns/detect_triples.js';
import { detectWedges } from '../../tools/patterns/detect_wedges.js';
import { linearRegressionWithR2 } from '../../tools/patterns/regression.js';
import { detectSwingPoints } from '../../tools/patterns/swing.js';
import type { CandleData, DetectContext } from '../../tools/patterns/types.js';

/** `DetectPatternsInputSchema.shape.limit` の既定値。invariants.test.ts が 90 であることを固定している。 */
const DEFAULT_SCAN_WINDOW = 90;

/** 受け入れ基準が名指ししている時間足。 */
const TIMEFRAMES = ['1day', '4hour', '1hour'] as const;

/** 形成中の反転パターンは全時間足を見る（#118 問題 3 は `1week` / `1month` に出た）。 */
const ALL_TIMEFRAMES = CandleTypeEnum.options;

function mkCandle(index: number, o: number, h: number, l: number, c: number): CandleData {
	return { open: o, high: h, low: l, close: c, isoTime: dayjs.utc('2026-01-01').add(index, 'day').toISOString() };
}

/** 三角波の山 / 谷を作るカーネル（`center` で 1、`width` 本離れると 0）。 */
const bump = (i: number, center: number, width: number) => Math.max(0, 1 - Math.abs(i - center) / Math.max(3, width));

/**
 * 形成中の反転パターンの生成で、左ピボットより前に置く助走バー数。
 * `validatePriorTrend` が見る先行トレンドをここで作る。
 */
const FORMING_LEAD_BARS = 29;

/**
 * 既定スキャン窓（90 本）に収まる形成バー数。`29 + 60 + 1 = 90`。
 * 全時間足の最小要求（最大でも `4hour` 系の 42 本）を上回り、最大要求（最小でも `1day` H&S の
 * 99 本）を下回るので、1 つの形状で全時間足を賄える。
 */
const DEFAULT_FORMATION_BARS = DEFAULT_SCAN_WINDOW - FORMING_LEAD_BARS - 1;

/**
 * スキャン窓と同じ本数のローソク足から `DetectContext` を組む。
 * `detect_patterns.ts` と同じく時間足の既定パラメータ（`getDefaultParamsForTf` /
 * `getDefaultToleranceForTf`）を使い、呼び出し側のオプションは与えない。
 */
function buildCtx(tf: string, candles: CandleData[], includeForming: boolean): DetectContext {
	const { swingDepth, minBarsBetweenSwings } = getDefaultParamsForTf(tf);
	const tolerancePct = getDefaultToleranceForTf(tf);
	const pivots = detectSwingPoints(candles, { swingDepth });
	return {
		candles,
		pivots,
		allPeaks: pivots.filter((p) => p.kind === 'H'),
		allValleys: pivots.filter((p) => p.kind === 'L'),
		tolerancePct,
		headProminencePct: tolerancePct,
		minDist: minBarsBetweenSwings,
		want: new Set<string>(),
		includeForming,
		debugCandidates: [],
		type: tf,
		sizeThresholds: getSizeThresholdsForTf(tf),
		hsShoulderMaxPct: getHsShoulderMaxPctForTf(tf),
		swingDepth,
		near: (a, b) => Math.abs(a - b) <= Math.max(a, b) * tolerancePct,
		pct: (a, b) => ((b - a) / Math.max(1, a)) * 100,
		lrWithR2: (pts) => linearRegressionWithR2(pts),
	};
}

/**
 * Falling Wedge 形状（`tests/patterns/detect_wedges.test.ts` と同じ生成則）。
 *   upper(i) = 200 - 0.5*i（急な下落） / lower(i) = 180 - 0.25*i（緩やかな下落 → 収束）
 * period=8 の振動で上下のトレンドラインにタッチを作る。
 */
function buildFallingWedgeCandles(nBars: number): CandleData[] {
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
		candles.push(mkCandle(i, mid, h, l, c));
	}
	return candles;
}

/**
 * 形成中 Triple Top 形状。確定済みの山を 2 つ（idx=12 / idx=52）置き、
 * 直近足を同じ水準まで戻して 3 山目を「現在価格」で暫定にする。
 * formationBars = 89 - 12 = 77 で、`1day`[23,99] / `4hour`[42,180] / `1hour`[34,146] の
 * いずれのレンジにも収まる。
 */
function buildFormingTripleTopCandles(nBars: number): CandleData[] {
	const peak1 = 12;
	const peak2 = 52;
	const valley1 = 32;
	const valley2 = 72;
	const ramp = 6;

	const candles: CandleData[] = [];
	for (let i = 0; i < nBars; i++) {
		let close = 100 + 20 * (bump(i, peak1, 8) + bump(i, peak2, 8)) - 18 * (bump(i, valley1, 10) + bump(i, valley2, 10));
		// 直近 ramp 本で山の水準まで戻す（3 山目 = 現在価格）
		if (i >= nBars - ramp - 1) close = 100 + 20 * ((i - (nBars - ramp - 1)) / ramp);
		candles.push(mkCandle(i, close, close + 0.6, close - 0.6, close));
	}
	return candles;
}

/**
 * 形成中 H&S 形状。左肩を `FORMING_LEAD_BARS` に置き、頭 → 頭後谷 → 直近を左肩水準（暫定右肩）にする。
 * 暫定右肩は最終足なので `formationBars = 右肩.idx - 左肩.idx = lastIdx - 左肩.idx`。
 *
 * @param formationBars 返るローソク足は `FORMING_LEAD_BARS + formationBars + 1` 本。
 */
function buildFormingHeadAndShouldersCandles(formationBars: number): CandleData[] {
	const nBars = FORMING_LEAD_BARS + formationBars + 1;
	const last = nBars - 1;
	const left = FORMING_LEAD_BARS;
	const span = formationBars;
	const head = left + Math.round(span * 0.45);
	const postValley = left + Math.round(span * 0.72);
	const ramp = Math.max(2, Math.round(span / 8));
	const out: CandleData[] = [];
	for (let i = 0; i < nBars; i++) {
		let close =
			90 + 10 * bump(i, left, span * 0.12) + 45 * bump(i, head, span * 0.2) - 2 * bump(i, postValley, span * 0.14);
		if (i < left) close = 90 - 8 * ((left - i) / left);
		if (i >= last - ramp) close = 100;
		out.push(mkCandle(i, close, close + 0.4, close - 0.4, close));
	}
	return out;
}

/** 形成中 head_and_shoulders を返した件数。 */
function countFormingHeadAndShoulders(tf: string, formationBars: number): number {
	const ctx = buildCtx(tf, buildFormingHeadAndShouldersCandles(formationBars), true);
	return detectHeadAndShoulders(ctx).patterns.filter((p) => p.type === 'head_and_shoulders' && p.status === 'forming')
		.length;
}

describe('既定 limit（90 本）での検出可能性 — issue #118 問題 1 / 2', () => {
	for (const tf of TIMEFRAMES) {
		it(`${tf}: 完成済み wedge が既定スキャン窓で検出できる`, () => {
			const candles = buildFallingWedgeCandles(DEFAULT_SCAN_WINDOW);
			expect(candles).toHaveLength(DEFAULT_SCAN_WINDOW);

			const result = detectWedges(buildCtx(tf, candles, false));
			const completed = result.patterns.filter((p) => p.type === 'falling_wedge');
			expect(completed.length, `${tf}: 完成済み falling_wedge が 0 件`).toBeGreaterThanOrEqual(1);
			// includeForming=false なので forming / near_completion は落ちている
			expect(completed.every((p) => p.status === 'completed')).toBe(true);
		});

		it(`${tf}: 形成中 triple が既定スキャン窓で検出できる`, () => {
			const candles = buildFormingTripleTopCandles(DEFAULT_SCAN_WINDOW);
			expect(candles).toHaveLength(DEFAULT_SCAN_WINDOW);

			const result = detectTriples(buildCtx(tf, candles, true));
			const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
			expect(forming.length, `${tf}: 形成中 triple_top が 0 件`).toBeGreaterThanOrEqual(1);
		});
	}
});

// ──────────────────────────────────────────────
// 形成中 H&S — issue #118 問題 3 の回帰
//
// 旧実装は手書きの bars-per-day（`1day`→1 / `1week`→7 / **それ以外→1**）で
// `patternDays = Math.round(formationBars × daysPerBar)` を作り 21〜90 日で判定していた。
// `1week` の受理域は `formationBars ∈ [3, 12]` で、構造的下限（25 本）を下回るため
// **形成中 H&S が実質検出不能**だった。バー数へ統一して解消したことを固定する。
// **形成中 double は同じ問題を抱えていたが、#268 案 C で経路ごと削除された**ので回帰対象外。
// ──────────────────────────────────────────────

describe('既定 limit（90 本）での検出可能性 — issue #118 問題 3（形成中 H&S）', () => {
	it('既定 limit の形状はちょうど 90 本になる（助走 + 形成 + 端点 1 本）', () => {
		expect(buildFormingHeadAndShouldersCandles(DEFAULT_FORMATION_BARS)).toHaveLength(DEFAULT_SCAN_WINDOW);
	});

	for (const tf of ALL_TIMEFRAMES) {
		it(`${tf}: 形成中 head_and_shoulders が既定スキャン窓で検出できる`, () => {
			expect(
				countFormingHeadAndShoulders(tf, DEFAULT_FORMATION_BARS),
				`${tf}: 形成中 head_and_shoulders が 0 件`,
			).toBeGreaterThanOrEqual(1);
		});
	}
});

// ──────────────────────────────────────────────
// 形成中 H&S — バー数レンジの境界
//
// 既定 limit のテスト（上）は `formationBars = 60` の 1 点しか見ないので、下限 / 上限を
// 取り違えていても 60 を受理する限り通ってしまう。ここでは `patternBarRange` が返す
// 実際の境界値を検出器に食わせて、`minBars - 1` / `minBars` / `maxBars` / `maxBars + 1` の
// 4 点で受理・棄却が反転することを固定する。
//
// 形状生成は `formationBars` だけを可変にしてあるので、隣り合う 2 点の差はバー数レンジの
// 判定に帰属できる（形が壊れて 0 件になったのではない）。
// ──────────────────────────────────────────────

describe('形成中 H&S — バー数レンジの境界', () => {
	// **`double_top` の行は #268 案 C で削除した。** 形成中 double の経路が無くなり、
	// `getDoubleFormingBarParams`（バー数レンジ）も一緒に消えたので、固定する境界が無い。
	const cases = [
		{
			label: 'head_and_shoulders',
			params: getHsFormingBarParams,
			count: countFormingHeadAndShoulders,
		},
	] as const;

	for (const { label, params, count } of cases) {
		it(`${label}: 全時間足で minBars / maxBars のちょうど内側だけが受理される`, () => {
			for (const tf of ALL_TIMEFRAMES) {
				const { minBars, maxBars } = params(tf);
				expect(count(tf, minBars - 1), `${tf} × ${label}: minBars-1 (${minBars - 1}) が受理された`).toBe(0);
				expect(count(tf, minBars), `${tf} × ${label}: minBars (${minBars}) が棄却された`).toBeGreaterThanOrEqual(1);
				expect(count(tf, maxBars), `${tf} × ${label}: maxBars (${maxBars}) が棄却された`).toBeGreaterThanOrEqual(1);
				expect(count(tf, maxBars + 1), `${tf} × ${label}: maxBars+1 (${maxBars + 1}) が受理された`).toBe(0);
			}
		});
	}
});
