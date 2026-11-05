import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult } from '../../_assertResult.js';

vi.mock('../../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import { fetchTechnical } from '../../../src/handlers/portfolio/fetch.js';
import analyzeIndicators from '../../../tools/analyze_indicators.js';

afterEach(() => {
	vi.restoreAllMocks();
});

function mockIndicators() {
	vi.mocked(analyzeIndicators).mockReset();
	vi.mocked(analyzeIndicators).mockImplementation(async () =>
		asMockResult({
			ok: true,
			summary: 'ok',
			data: { indicators: { RSI_14: 50, SMA_25: 100 }, normalized: [{ close: 100 }], trend: 'sideways' },
		}),
	);
}

describe('fetchTechnical', () => {
	it('先頭の 5 ペアだけを、渡された順に 1day / 60 本で分析する', async () => {
		mockIndicators();
		const pairs = ['btc_jpy', 'eth_jpy', 'xrp_jpy', 'ltc_jpy', 'bcc_jpy', 'mona_jpy', 'xlm_jpy'];

		const res = await fetchTechnical(pairs);

		expect(vi.mocked(analyzeIndicators).mock.calls).toEqual(pairs.slice(0, 5).map((p) => [p, '1day', 60]));
		expect(res.map((r) => r.pair)).toEqual(pairs.slice(0, 5));
	});

	it('5 ペア以下なら全部を分析する', async () => {
		mockIndicators();
		const pairs = ['btc_jpy', 'eth_jpy', 'xrp_jpy', 'ltc_jpy', 'bcc_jpy'];

		const res = await fetchTechnical(pairs);

		expect(vi.mocked(analyzeIndicators)).toHaveBeenCalledTimes(5);
		expect(res.map((r) => r.pair)).toEqual(pairs);
	});
});
