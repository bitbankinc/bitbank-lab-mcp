// 実データ A（`btc_jpy` `1day`）の窓先頭 relaxed H&S が履歴不足で出力から除外されることをパイプライン全体で固定する（構造図とネックラインの値一致は `tests/patterns/hs-neckline-diagram-consistency.test.ts` が見る。issue #297）。
import { describe, expect, it, vi } from 'vitest';

vi.mock('../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import { toolDef as detectPatternsTool } from '../src/handlers/detectPatternsHandler.js';
import analyzeIndicators from '../tools/analyze_indicators.js';
import detectPatterns from '../tools/detect_patterns.js';
import { asMockResult, assertOk } from './_assertResult.js';
import { buildBtcJpy2026Candles } from './fixtures/btc_jpy_1day_2026.js';

/** 実データ A で relaxed H&S に落ちる最小のオプション集合。 */
const RELAXED_OPTS = {
	tolerancePct: 0.01,
	headProminencePct: 0.001,
	swingDepth: 2,
	minBarsBetweenSwings: 2,
	patternTypes: ['head_and_shoulders'],
} as const;

function mockCandles() {
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles: buildBtcJpy2026Candles() } } }),
	);
}

describe('detect_patterns（実データ A / btc_jpy 1day）: 窓先頭の relaxed H&S を履歴不足で除外（issue #297）', () => {
	it('data.patterns 側: 窓先頭の relaxed H&S は履歴不足として除外される', async () => {
		mockCandles();
		const res = await detectPatterns('btc_jpy', '1day', 90, { ...RELAXED_OPTS });
		assertOk(res);

		const hs = (res.data.patterns as Array<Record<string, unknown>>).filter((p) => p.type === 'head_and_shoulders');
		expect(hs).toHaveLength(0);
		expect((res.meta.reduction as { reversalHistoryExcluded: number }).reversalHistoryExcluded).toBeGreaterThan(0);
	});

	it('content 側: view=full の内訳に履歴不足段を出す', async () => {
		mockCandles();
		const res = (await detectPatternsTool.handler({
			pair: 'btc_jpy',
			type: '1day',
			limit: 90,
			view: 'full',
			...RELAXED_OPTS,
		})) as { content: Array<{ text: string }> };
		const text = res.content[0].text;

		expect(text).not.toContain('[relaxed_hs_x2.0_0.4]');
		expect(text).toContain('反転履歴不足 -');
	});
});
