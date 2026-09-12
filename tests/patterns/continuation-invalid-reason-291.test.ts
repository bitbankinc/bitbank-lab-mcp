/**
 * tests/patterns/continuation-invalid-reason-291.test.ts
 *
 * issue #291 — 継続系（`triangle_ascending` / `triangle_descending` / `pennant` /
 * `bull_flag` / `bear_flag`）の `status: 'invalid'` に
 * `invalidReason: 'breakout_against_expectation'` が付くことの**合成 fixture による固定**。
 *
 * 押さえるのは 3 点:
 *
 * 1. 継続系の `invalid` に理由コードが付く（triangle / pennant / flag を 1 件ずつ）。
 * 2. **`invalid` 以外には付かない**（`completed` の同型・同本体の対で見る）。
 * 3. 付与は **additive** で、採否・`status`・`outcome` は #291 の前後で変わらない。
 *    3 は各ケースで `status` / `breakoutDirection` / `outcome` を一緒に固定して見る。
 *
 * 実データ（BTC/JPY 1hour の `limit=72` 窓）での固定は
 * `tests/patterns/status-reason-label-286.test.ts`、状態行の文言の網羅は
 * `tests/detectPatternsViewsHandler.test.ts` の「状態行: status × 理由コードの網羅」が持つ。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult, assertOk } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import type { z } from 'zod';
import type { PatternFilterEnum } from '../../src/schema/patterns.js';
import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { BREAKOUT_AGAINST_EXPECTATION } from '../../tools/patterns/structural.js';
import {
	buildAscendingTriangleCompletedBreakoutCandles,
	buildAscendingTriangleInvalidBreakoutCandles,
	buildBullFlagFailureCandles,
	buildBullFlagSuccessCandles,
	buildBullPennantFailureCandles,
	buildBullPennantSuccessCandles,
	buildDescendingTriangleInvalidBreakoutCandles,
	type Candle,
} from '../fixtures/synthetic_pattern_candles.js';

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * `patterns` の絞り込みに渡せる値。**リテラルを手書きしない**——`PatternFilterEnum` から
 * 消えた値がテストに残っても typecheck で落ちるようにする。
 */
type PatternFilter = z.infer<typeof PatternFilterEnum>;

/** fixture を `detect_patterns` に流して `data.patterns` を返す。 */
async function run(candles: Candle[], patterns: PatternFilter[]) {
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = await detectPatterns('btc_jpy', '1day', candles.length, {
		patterns,
		includeCompleted: true,
		includeInvalid: true,
	});
	assertOk(res);
	return res.data.patterns;
}

describe('#291 継続系の invalid に breakout_against_expectation が付く', () => {
	// ── triangle ──
	// 本体が同一で末尾 3 本だけが違う対。**同じ形で方向だけを変えている**ので、
	// 理由コードの有無が `status` に対応していることがそのまま見える。
	it('triangle_ascending の下方ブレイク（invalid）に理由コードが付く', async () => {
		const hits = await run(buildAscendingTriangleInvalidBreakoutCandles(), ['triangle_ascending']);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]).toMatchObject({
			type: 'triangle_ascending',
			status: 'invalid',
			invalidReason: BREAKOUT_AGAINST_EXPECTATION,
			breakoutDirection: 'down',
			outcome: 'failure',
		});
	});

	it('triangle_ascending の上方ブレイク（completed）には付かない', async () => {
		const hits = await run(buildAscendingTriangleCompletedBreakoutCandles(), ['triangle_ascending']);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]).toMatchObject({
			type: 'triangle_ascending',
			status: 'completed',
			breakoutDirection: 'up',
			outcome: 'success',
		});
		expect(hits[0].invalidReason).toBeUndefined();
	});

	// 逆向きの三角形でも**同じコード**になる（継続系の `invalid` は方向で分かれない）。
	it('triangle_descending の上方ブレイク（invalid）にも同じコードが付く', async () => {
		const hits = await run(buildDescendingTriangleInvalidBreakoutCandles(), ['triangle_descending']);
		const hit = hits.find((p) => p.type === 'triangle_descending');
		expect(hit).toMatchObject({
			status: 'invalid',
			invalidReason: BREAKOUT_AGAINST_EXPECTATION,
			breakoutDirection: 'up',
			outcome: 'failure',
		});
	});

	// ── pennant ──
	it('bull_pennant の逆方向ブレイク（invalid）に理由コードが付く', async () => {
		const hits = await run(buildBullPennantFailureCandles(), ['pennant']);
		const hit = hits.find((p) => p.type === 'bull_pennant');
		expect(hit).toMatchObject({
			status: 'invalid',
			invalidReason: BREAKOUT_AGAINST_EXPECTATION,
			breakoutDirection: 'down',
			expectedBreakoutDirection: 'up',
			outcome: 'failure',
			isTrendContinuation: false,
		});
	});

	it('bull_pennant の順方向ブレイク（completed）には付かない', async () => {
		const hits = await run(buildBullPennantSuccessCandles(), ['pennant']);
		const hit = hits.find((p) => p.type === 'bull_pennant');
		expect(hit).toMatchObject({
			status: 'completed',
			breakoutDirection: 'up',
			outcome: 'success',
			isTrendContinuation: true,
		});
		expect(hit?.invalidReason).toBeUndefined();
	});

	// ── flag ──
	// triangle / pennant と同じく、**本体が同一で末尾 4 本だけが違う対**で見る。
	it('bull_flag の逆方向ブレイク（invalid）に理由コードが付く', async () => {
		const hits = await run(buildBullFlagFailureCandles(), ['flag']);
		const hit = hits.find((p) => p.type === 'bull_flag');
		expect(hit).toMatchObject({
			status: 'invalid',
			invalidReason: BREAKOUT_AGAINST_EXPECTATION,
			breakoutDirection: 'down',
			expectedBreakoutDirection: 'up',
			outcome: 'failure',
		});
	});

	it('bull_flag の順方向ブレイク（completed）には付かない', async () => {
		const hits = await run(buildBullFlagSuccessCandles(), ['flag']);
		const hit = hits.find((p) => p.type === 'bull_flag');
		expect(hit).toMatchObject({
			status: 'completed',
			breakoutDirection: 'up',
			expectedBreakoutDirection: 'up',
			outcome: 'success',
			isTrendContinuation: true,
		});
		expect(hit?.invalidReason).toBeUndefined();
	});

	// ── 横断 ──
	// **`invalid` 以外に理由コードが漏れないこと**を fixture 横断で見る。個別ケースの
	// `toBeUndefined()` は `completed` 2 件しか見ておらず、`forming` / `near_completion` を
	// 含む全件では確認していないため。
	it('どの fixture でも invalidReason が付くのは status=invalid の entry だけ', async () => {
		const cases: ReadonlyArray<[Candle[], PatternFilter[]]> = [
			[buildAscendingTriangleInvalidBreakoutCandles(), ['triangle_ascending']],
			[buildAscendingTriangleCompletedBreakoutCandles(), ['triangle_ascending']],
			[buildDescendingTriangleInvalidBreakoutCandles(), ['triangle_descending']],
			[buildBullPennantFailureCandles(), ['pennant']],
			[buildBullPennantSuccessCandles(), ['pennant']],
			[buildBullFlagFailureCandles(), ['flag']],
			[buildBullFlagSuccessCandles(), ['flag']],
		];
		// `status` と `invalidReason` の対を全件集めてから 1 回で見る（分岐の中で `expect` を
		// 呼ぶと、分岐に入らなかった組み合わせが黙って素通りする）。
		const seen: Array<{ type: string; status: string; invalidReason?: string }> = [];
		for (const [candles, want] of cases) {
			for (const p of await run(candles, want)) {
				seen.push({ type: String(p.type), status: String(p.status), invalidReason: p.invalidReason });
			}
		}
		const invalids = seen.filter((p) => p.status === 'invalid');
		const others = seen.filter((p) => p.status !== 'invalid');
		expect(invalids.map((p) => p.invalidReason)).toEqual(invalids.map(() => BREAKOUT_AGAINST_EXPECTATION));
		expect(others.map((p) => p.invalidReason)).toEqual(others.map(() => undefined));
		// 「1 件も `invalid` が無かったので素通りした」を防ぐ。
		expect(invalids.length).toBeGreaterThanOrEqual(4);
		// **`invalid` 以外の側も 3 系統すべてから来ていること**を確認する。片方の系統に
		// `completed` の fixture が無いと、その系統だけ「`invalid` 以外には付かない」が
		// 未検証のまま通ってしまう（CodeRabbit が flag について指摘した形）。
		const continuationOf = (type: string) =>
			type.startsWith('triangle_') ? 'triangle' : type.endsWith('_pennant') ? 'pennant' : 'flag';
		expect([...new Set(others.map((p) => continuationOf(p.type)))].sort()).toEqual(['flag', 'pennant', 'triangle']);
	});
});
