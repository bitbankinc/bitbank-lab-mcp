/**
 * 実データ A（`btc_jpy` `1day`）の relaxed H&S で、**content 本文行と構造図 SVG の
 * ネックライン水準が一致する**ことをパイプライン全体で固定する（issue #226）。
 *
 * `tests/patterns/hs-neckline-diagram-consistency.test.ts` が合成 fixture で検出器 →
 * 構造図 → 表示層の契約を見るのに対し、こちらは **`detect_patterns` の実配線**
 * （`resolveParams` の時間軸オート解決 → `detectSwingPoints` → relaxed フォールバック →
 * `globalDedup` → `formatFullView`）を通した実データで見る。
 *
 * ## 対象の構造（issue #226 Phase 1 の実測）
 *
 * | | |
 * |---|---|
 * | 構成点 idx | `[9, 13, 17, 20, 24]` |
 * | 経路 | `relaxed_hs_x2.0_0.4`（strict が 0 件のときだけ走る） |
 * | `nlY`（= `neckline[0].y` = `findHsBreakoutIdx` に渡す線の y） | 10,152,026 円 |
 * | 修正前の構造図ラベル（`nlAvg` = 谷1 10,181,668 と 谷2 10,152,026 の平均） | 10,166,847 円 |
 * | ずれ | **14,821 円** |
 *
 * 起票時の実測は実データ B（`1hour`）の別の構造（idx `[29,36,39,43,48]` / 差 27,364 円）だが、
 * **本 fixture の既定オプションでは strict H&S が検出されるため relaxed 経路に落ちない**
 * （relaxed は `!foundHS` のときだけ走る）。実データ A で relaxed に落ちる最小のオプション集合を
 * 実測で特定し、そちらを回帰の対象に据えた。値は fixture 由来なので**プールしていない**（#219）。
 *
 * ## 判定は 1 つも変わっていない
 *
 * 本 issue の修正前後で、実データ A / B それぞれ 1,520 ケース（2 通りのオプション格子）の
 * `type` / `pivots` / `neckline` / `breakoutTarget` / `confidence` / `status` /
 * `targetReachedPct` / `targetReached` / `targetProgressOmittedReason` / `_fallback` は
 * **全件不変**。SVG が変わったのは relaxed H&S の 36 件だけで、**strict H&S 系
 * （A: 1,394 件 / B: 3,996 件）の SVG は 1 バイトも動いていない。**
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import { toolDef as detectPatternsTool } from '../src/handlers/detectPatternsHandler.js';
import analyzeIndicators from '../tools/analyze_indicators.js';
import detectPatterns from '../tools/detect_patterns.js';
import { asMockResult, assertOk } from './_assertResult.js';
import { buildBtcJpy2026Candles } from './fixtures/btc_jpy_1day_2026.js';

/** 実データ A で relaxed H&S に落ちる最小のオプション集合（#226 Phase 1 の実測）。 */
const RELAXED_OPTS = {
	tolerancePct: 0.01,
	headProminencePct: 0.001,
	swingDepth: 2,
	minBarsBetweenSwings: 2,
	patternTypes: ['head_and_shoulders'],
} as const;

/** `nlY`（水平ネックラインの y）。ブレイク判定・ターゲット・出力フィールドが共有する唯一の水準。 */
const NL_Y = 10_152_026;
/** 修正前に構造図だけが描いていた値（谷1 / 谷2 の平均）。 */
const OLD_NL_AVG = 10_166_847;

function mockCandles() {
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles: buildBtcJpy2026Candles() } } }),
	);
}

function necklineFromSvg(svg: string): number {
	const m = svg.match(/ネックライン: ([\d,]+)円/);
	if (!m) throw new Error('構造図 SVG にネックラインラベルが無い');
	return Number(m[1].replace(/,/g, ''));
}

describe('detect_patterns（実データ A / btc_jpy 1day）: relaxed H&S の構造図が本文と同じネックラインを描く（issue #226）', () => {
	it('data.patterns 側: neckline は nlY の水平線で、構造図ラベルもその値', async () => {
		mockCandles();
		const res = await detectPatterns('btc_jpy', '1day', 90, { ...RELAXED_OPTS });
		assertOk(res);

		const hs = (res.data.patterns as Array<Record<string, unknown>>).filter((p) => p.type === 'head_and_shoulders');
		expect(hs).toHaveLength(1);
		const p = hs[0];
		expect(p._fallback).toBe('relaxed_hs_x2.0_0.4');
		expect((p.pivots as Array<{ idx: number }>).map((v) => v.idx)).toEqual([9, 13, 17, 20, 24]);

		// ブレイク判定（`findHsBreakoutIdx`）に渡る線。水平なので 2 点とも同値。
		expect(p.neckline).toEqual([
			{ x: 13, y: NL_Y },
			{ x: 20, y: NL_Y },
		]);
		// 2 定義点の平均（旧ラベル）とは 14,821 円ずれている——ずれが残っていれば下の等式が落ちる。
		const [v1, v2] = [(p.pivots as Array<{ price: number }>)[1].price, (p.pivots as Array<{ price: number }>)[3].price];
		expect((v1 + v2) / 2).toBe(OLD_NL_AVG);
		expect(OLD_NL_AVG - NL_Y).toBe(14_821);

		expect(necklineFromSvg(String((p.structureDiagram as { svg: string }).svg))).toBe(NL_Y);
	});

	it('content 側: view=full の本文行と構造図ラベルが同じ水準を名乗る', async () => {
		mockCandles();
		const res = (await detectPatternsTool.handler({
			pair: 'btc_jpy',
			type: '1day',
			limit: 90,
			view: 'full',
			...RELAXED_OPTS,
		})) as { content: Array<{ text: string }> };
		const text = res.content[0].text;

		// `patternTypes` は他 type の出力までは落とさないので、**当該 relaxed H&S の 1 件分**を切り出す
		// （見出し行 `N. 名前 (パターン整合度: …) [relaxed_hs_x2.0_0.4]` で始まるブロック）。
		const block = text.split(/\n(?=\d+\. )/).find((b) => b.includes('[relaxed_hs_x2.0_0.4]'));
		expect(block, 'relaxed H&S のブロックが content に無い').toBeDefined();

		// LLM に見えるのは content テキストだけ（`.claude/rules/tools.md`）。
		// 1 件のブロックに現れるネックライン水準は**本文行と構造図ラベルの 2 つ**で、値は 1 種類でなければならない。
		const found = [...(block as string).matchAll(/ネックライン: ([\d,]+)円/g)].map((m) =>
			Number(m[1].replace(/,/g, '')),
		);
		expect(found).toHaveLength(2);
		expect(new Set(found)).toEqual(new Set([NL_Y]));

		expect(block).toContain(`- ネックライン: ${NL_Y.toLocaleString('ja-JP')}円（水平）`);
		expect(block).not.toContain(OLD_NL_AVG.toLocaleString('ja-JP'));
	});
});
