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

describe('detect_patterns（実データ A / btc_jpy 1day）: 窓先頭の relaxed H&S を出力しない（issue #297）', () => {
	it('data.patterns 側: 窓先頭の relaxed H&S は肩の深さで落ち、出力に出ない', async () => {
		mockCandles();
		const res = await detectPatterns('btc_jpy', '1day', 90, { ...RELAXED_OPTS });
		assertOk(res);

		const hs = (res.data.patterns as Array<Record<string, unknown>>).filter((p) => p.type === 'head_and_shoulders');
		expect(hs).toHaveLength(0);
		// 履歴不足の段より手前で落ちるので、窓先頭の候補は reversal_history_insufficient に届かない（H&S 系の履歴不足は detect_patterns_triple_hs_exclusion が見る）。
		const candidates = (res.meta.debug as { candidates: Array<{ type: string; reason?: string; indices?: number[] }> })
			.candidates;
		const windowHead = candidates.filter(
			(c) => c.type === 'head_and_shoulders' && c.indices?.join('-') === '9-13-17-20-24',
		);
		expect(windowHead.map((c) => c.reason)).toContain('shoulder_depth_insufficient');
		expect(candidates.some((c) => c.type === 'head_and_shoulders' && c.reason === 'fallback_relaxed')).toBe(false);
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
