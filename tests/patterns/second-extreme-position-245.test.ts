// この形を accepted で見るには `swingDepth: 6` が要る（既定の深さ 3 では経路ゲートが `peak_after_last_pivot` を立てる）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectPatternsContent } from '../helpers/detect-patterns.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import {
	BTC_JPY_1HOUR_2026_09_05_ISSUE_WINDOW,
	buildBtcJpy1hour20260905Candles,
} from '../fixtures/btc_jpy_1hour_2026_09_05.js';

afterEach(() => {
	vi.restoreAllMocks();
});

/** 山1（idx 41、高値 12,807,555）/ 谷（idx 46、終値 12,617,594・安値 12,588,132）/ 山2（idx 50、終値 12,639,245・高値 12,800,000）で、heightAbs = 219,423、closeGap = 21,651 / 219,423 → +9.9%、wickShare = 160,755 / 219,423 → 73.3%。 */
function liveWindowContent(view: string, opts: Record<string, unknown> = { swingDepth: 6 }): Promise<string> {
	const { start, end } = BTC_JPY_1HOUR_2026_09_05_ISSUE_WINDOW;
	return detectPatternsContent(buildBtcJpy1hour20260905Candles().slice(start, end), { view, ...opts });
}

describe('#245 の発端の形（実データ D の limit=72 窓 / swingDepth: 6）', () => {
	// `debug` は `formatPatternLine` を呼ばず、`summary` はパターン明細を列挙しないので、実出力で見られるのは `detailed` / `full` の 2 つ。
	for (const view of ['detailed', 'full'] as const) {
		it(`view=${view}: 上昇先行の double_top と第2極値の表示を維持する`, async () => {
			const text = await liveWindowContent(view);
			expect(text).toContain('山2 の位置: 終値はネックラインの +9.9%（パターン高さ比）/ ヒゲ 73.3%');
			expect(text).toContain('double_top');
		});
	}

	it('既定の swingDepth（1hour = 3）では double_top ごと落ちるので行も出ない（#251 の深さ依存）', async () => {
		// #242 の経路ゲートが `peak_after_last_pivot` で `invalid` にし、既定の `includeInvalid: false` で `data.patterns` から消える。行が出ないのはパターンそのものが無いからなので両方を見る。
		const text = await liveWindowContent('full', {});
		expect(text).not.toContain('double_top');
		expect(text).not.toContain('山2 の位置');
	});
});
