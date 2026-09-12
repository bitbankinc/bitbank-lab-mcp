/**
 * tests/patterns/second-extreme-position-245.test.ts
 *
 * issue #245 — double の content に「山2 / 谷2 の位置」行を常に出す件の、**実データによる固定**。
 *
 * 合成データでの分岐（出す / 出さない、値の定義、triple / H&S に出ないこと、4 view）は
 * `tests/detectPatternsViewsHandler.test.ts` が持つ。本ファイルが押さえるのは 1 点だけ:
 *
 * **#245 の発端の形（実データ D の `limit=72` 窓 / `swingDepth: 6`）で `+9.9%` / `73.3%` が
 * 実際に content に出ること。** この 2 値は PR #276 の計測スクリプト
 * （tjackiet/bitbank-lab-mcp#245 の計測スクリプトの自己検算）と
 * tjackiet/bitbank-lab-mcp#245 の計測記録が出した値そのもので、表示層が同じ量を
 * 同じ分母（`levelSpreadMetrics` の `heightAbs` = 219,423）で出していることの検算になる。
 *
 * 窓の切り出しと `swingDepth: 6` で `completed` になる理由は
 * `tests/patterns/breakout-path-double.test.ts` の「経路ゲートの判定は swingDepth に依存する」
 * （issue #251 案 3）が仕様として固定している。既定の深さ 3 では経路ゲートが
 * `peak_after_last_pivot` を立てるので、**この形を accepted で見るには深さ 6 が要る。**
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import { toolDef as detectPatternsTool } from '../../src/handlers/detectPatternsHandler.js';
import analyzeIndicators from '../../tools/analyze_indicators.js';
import {
	BTC_JPY_1HOUR_2026_09_05_ISSUE_WINDOW,
	buildBtcJpy1hour20260905Candles,
} from '../fixtures/btc_jpy_1hour_2026_09_05.js';

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * #245 / #242 の発端の形（`btc_jpy` / `1hour` / 2026-09-05 の `limit=72` 窓）。
 *
 * | 役割 | 窓内 idx | UTC | 終値 | 高安 |
 * |---|---:|---|---:|---:|
 * | 山1 | 41 | 09-03 21:00 | 12,718,980 | 12,807,555 |
 * | 谷（ネックライン） | 46 | 09-04 02:00 | 12,617,594 | 12,588,132 |
 * | **山2** | **50** | **09-04 06:00** | **12,639,245** | **12,800,000** |
 *
 * - `heightAbs` = 12,807,555 − 12,588,132 = **219,423**
 * - `closeGap` = (12,639,245 − 12,617,594) / 219,423 = 21,651 / 219,423 = **0.0987 → +9.9%**
 * - `wickShare` = (12,800,000 − 12,639,245) / 219,423 = 160,755 / 219,423 = **0.7326 → 73.3%**
 */
async function liveWindowContent(view: string, opts: Record<string, unknown> = { swingDepth: 6 }): Promise<string> {
	const { start, end } = BTC_JPY_1HOUR_2026_09_05_ISSUE_WINDOW;
	const candles = buildBtcJpy1hour20260905Candles().slice(start, end);
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = (await detectPatternsTool.handler({
		pair: 'btc_jpy',
		type: '1hour',
		limit: candles.length,
		view,
		...opts,
	})) as { content?: Array<{ text?: string }> };
	const text = res?.content?.[0]?.text;
	// **`?? ''` で畳まない。** 空文字に落とすと `not.toContain` 側のケースが
	// 「ハンドラが content を返さなかった」ときにも通ってしまう。
	if (typeof text !== 'string') throw new Error(`view=${view} の content[0].text が取れない`);
	return text;
}

describe('#245 の発端の形（実データ D の limit=72 窓 / swingDepth: 6）', () => {
	// **4 view すべてで同じ 1 行が出る**——`debug` は `formatPatternLine` を呼ばない
	// 階梯外の view（出力の置換）なので対象外。`summary` はそもそもパターン明細を
	// 列挙しないため、実出力で見られるのは `detailed` / `full` の 2 つ。
	// `formatPatternLine` に 4 つの `view` 値を直接通す検算は
	// `tests/detectPatternsViewsHandler.test.ts` 側が持つ。
	for (const view of ['detailed', 'full'] as const) {
		it(`view=${view}: 山2 の位置行が PR #276 の計測値そのものを出す`, async () => {
			const text = await liveWindowContent(view);
			expect(text).toContain('山2 の位置: 終値はネックラインの +9.9%（パターン高さ比）/ ヒゲ 73.3%');
		});
	}

	it('既定の swingDepth（1hour = 3）では double_top ごと落ちるので行も出ない（#251 の深さ依存）', async () => {
		// #242 の経路ゲートが `peak_after_last_pivot` で `invalid` にし、既定の
		// `includeInvalid: false` で `data.patterns` から消える。**行が出ないのは
		// 表示層が黙ったからではなく、パターンそのものが無いから**なので両方を見る。
		const text = await liveWindowContent('full', {});
		expect(text).not.toContain('double_top');
		expect(text).not.toContain('山2 の位置');
	});
});
