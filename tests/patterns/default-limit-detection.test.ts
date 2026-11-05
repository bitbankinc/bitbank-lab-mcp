// invariants.test.ts の到達性（不変条件 9）は閾値の最小側の算術だけを見るので、既定 `limit`（90 本）の合成データで検出器が実際にパターンを返すことを時間足ごとに固定する（#118）。
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

const bump = (i: number, center: number, width: number) => Math.max(0, 1 - Math.abs(i - center) / Math.max(3, width));

/** `validatePriorTrend` が見る先行トレンドをここで作る。 */
const FORMING_LEAD_BARS = 29;

/** 全時間足の最小要求（最大でも `4hour` 系の 42 本）を上回り、最大要求（最小でも `1day` H&S の 99 本）を下回るので、1 つの形状で全時間足を賄える。 */
const DEFAULT_FORMATION_BARS = DEFAULT_SCAN_WINDOW - FORMING_LEAD_BARS - 1;

/** `detect_patterns.ts` と同じく時間足の既定パラメータ（`getDefaultParamsForTf` / `getDefaultToleranceForTf`）を使い、呼び出し側のオプションは与えない。 */
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
	};
}

/** Falling Wedge 形状（`tests/patterns/detect_wedges.test.ts` と同じ生成則）。 */
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

/** formationBars = 89 - 12 = 77 で、`1day`[23,99] / `4hour`[42,180] / `1hour`[34,146] のいずれのレンジにも収まる。 */
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

/** 暫定右肩は最終足なので `formationBars = 右肩.idx - 左肩.idx = lastIdx - 左肩.idx`。 */
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

// 既定 limit のテスト（上）は `formationBars = 60` の 1 点しか見ないので、下限 / 上限を取り違えていても 60 を受理する限り通ってしまう。

describe('形成中 H&S — バー数レンジの境界', () => {
	// 形成中 double は #268 案 C で経路ごと削除されたので、固定する境界が無い。
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
