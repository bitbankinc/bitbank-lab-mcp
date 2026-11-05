// `completion_below_min` は現行定数では到達しないため、fixture ではなく「なぜ fixture を置けないか」の算術境界を固定する。
import { describe, expect, it, vi } from 'vitest';
import { asMockResult, assertOk } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({
	default: vi.fn(),
}));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { FORMING_MIN_COMPLETION } from '../../tools/patterns/detect_hs.js';
import { buildBtcJpy2026Candles } from '../fixtures/btc_jpy_1day_2026.js';

type Candle = {
	isoTime: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
};

function makeIso(dayOffset: number, year = 2026) {
	return new Date(Date.UTC(year, 0, 1 + dayOffset, 0, 0, 0)).toISOString();
}

function makeCandle(dayOffset: number, close: number, year = 2026): Candle {
	return {
		isoTime: makeIso(dayOffset, year),
		open: close,
		high: close + 3,
		low: close - 3,
		close,
		volume: 100,
	};
}

function fromCloses(closes: number[]): Candle[] {
	return closes.map((close, index) => makeCandle(index, close));
}

function indicatorsOk(candles: Candle[]) {
	return { ok: true, summary: 'ok', data: { chart: { candles } } };
}

/** tests/detect_patterns_fixtures.test.ts の同名 fixture と同じ価格列 */
const COMPLETED_HS_CLOSES = [
	100, 108, 116, 122, 125, 120, 116, 112, 110, 114, 120, 128, 136, 140, 136, 128, 120, 114, 112, 116, 120, 124, 126,
	122, 116, 108, 102, 96,
];
const FORMING_INVERSE_HS_CLOSES = [
	108, 100, 92, 84, 80, 84, 90, 96, 100, 96, 88, 78, 68, 64, 70, 80, 90, 98, 100, 96, 90, 84, 80, 84, 88, 92,
];
const COMPLETED_FALLING_WEDGE_CLOSES = [
	146, 140, 134, 128, 122, 116, 127, 138, 133, 128, 122, 117, 112, 121, 130, 126, 121, 117, 112, 108, 115, 122, 118,
	115, 111, 108, 104, 109, 114, 111, 108, 106, 103, 100, 103, 110, 118,
];

type Candidate = {
	type: string;
	accepted: boolean;
	reason?: string;
	status?: string;
	indices?: number[];
	points?: Array<{ role: string; idx: number; price: number; isoTime?: string }>;
	details?: Record<string, unknown>;
};

async function runDebug(
	candles: Candle[],
	opts: Parameters<typeof detectPatterns>[3] = {},
): Promise<{ patterns: Array<Record<string, unknown>>; candidates: Candidate[] }> {
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
	const res = await detectPatterns('btc_jpy', '1day', candles.length, {
		includeForming: true,
		view: 'debug',
		...opts,
	});
	assertOk(res);
	return {
		patterns: res.data.patterns as unknown as Array<Record<string, unknown>>,
		candidates: (res.meta.debug?.candidates ?? []) as Candidate[],
	};
}

describe('forming H&S debug candidates (#155)', () => {
	it('#155 の実データ候補は横ばい先行なら形成中 H&S として積まれない', async () => {
		const { patterns, candidates } = await runDebug(buildBtcJpy2026Candles() as Candle[], {
			patterns: ['head_and_shoulders', 'inverse_head_and_shoulders'],
			headProminencePct: 0.01,
			includeForming: true,
			includeCompleted: true,
			includeInvalid: true,
		});

		expect(patterns).toHaveLength(0);

		const hit = candidates.find(
			(c) =>
				c.reason === 'prior_trend_mismatch:sideways' && JSON.stringify(c.indices) === JSON.stringify([38, 53, 66, 73]),
		);
		expect(hit?.type).toBe('head_and_shoulders');
		expect(hit?.accepted).toBe(false);
	});

	it('accepted: true は dedup 前の「組み立てた」であって最終出力に残ったではない', async () => {
		// 形成中 H&S はすべての頭候補を試すので、accepted 候補は data.patterns より多く出うる（globalDedup は detect_patterns 側の後段）。
		const { patterns, candidates } = await runDebug(buildBtcJpy2026Candles() as Candle[], {
			patterns: ['head_and_shoulders', 'inverse_head_and_shoulders'],
			headProminencePct: 0.01,
			includeForming: true,
			includeCompleted: true,
			includeInvalid: true,
		});
		const formingAccepted = candidates.filter((c) => c.accepted && c.status === 'forming');
		expect(formingAccepted.length).toBeGreaterThanOrEqual(patterns.length);
	});

	describe('構成点 4 点が揃った後の分岐は理由コードを残す', () => {
		it('head_not_extreme_in_span（H&S）', async () => {
			const { candidates } = await runDebug(buildBtcJpy2026Candles() as Candle[], {
				swingDepth: 2,
				patterns: ['head_and_shoulders'],
			});
			const hit = candidates.find((c) => c.type === 'head_and_shoulders' && c.reason === 'head_not_extreme_in_span');
			expect(hit).toBeDefined();
			expect(hit?.accepted).toBe(false);
			expect(hit?.indices).toHaveLength(4);
			// 区間の内側により高いピークが居る = 頭の取り違え（#154 のゲート）
			expect(hit?.details).toMatchObject({ spanFromIdx: expect.any(Number), spanToIdx: expect.any(Number) });
		});

		it('head_not_extreme_in_span（逆 H&S）', async () => {
			const { candidates } = await runDebug(fromCloses(COMPLETED_FALLING_WEDGE_CLOSES), {
				swingDepth: 2,
				patterns: ['inverse_head_and_shoulders'],
			});
			const hit = candidates.find(
				(c) => c.type === 'inverse_head_and_shoulders' && c.reason === 'head_not_extreme_in_span',
			);
			expect(hit).toBeDefined();
			expect(hit?.accepted).toBe(false);
			expect(hit?.indices).toHaveLength(4);
		});

		it('formation_bars_out_of_range（H&S）', async () => {
			const { candidates } = await runDebug(fromCloses(COMPLETED_HS_CLOSES), {
				swingDepth: 2,
				patterns: ['head_and_shoulders'],
			});
			const hit = candidates.find((c) => c.type === 'head_and_shoulders' && c.reason === 'formation_bars_out_of_range');
			expect(hit).toBeDefined();
			expect(hit?.accepted).toBe(false);
			const details = hit?.details as { formationBars: number; minBars: number; maxBars: number };
			expect(details.formationBars < details.minBars || details.formationBars > details.maxBars).toBe(true);
		});

		it('formation_bars_out_of_range（逆 H&S）', async () => {
			const { candidates } = await runDebug(fromCloses(FORMING_INVERSE_HS_CLOSES), {
				swingDepth: 2,
				patterns: ['inverse_head_and_shoulders'],
			});
			const hit = candidates.find(
				(c) => c.type === 'inverse_head_and_shoulders' && c.reason === 'formation_bars_out_of_range',
			);
			expect(hit).toBeDefined();
			expect(hit?.accepted).toBe(false);
			const details = hit?.details as { formationBars: number; minBars: number; maxBars: number };
			expect(details.formationBars < details.minBars || details.formationBars > details.maxBars).toBe(true);
		});

		it('completion_below_min は現行定数では到達しない（fixture を置けない理由を固定する）', () => {
			// completion = min(1, (0.75 + 0.25 * progress) * (暫定右肩なら 0.9))、progress ∈ [0, 1] なので、最小は progress = 0 × 暫定右肩の 0.9 掛け。
			const minCompletion = 0.75 * 0.9;
			expect(minCompletion).toBeGreaterThan(FORMING_MIN_COMPLETION);
		});
	});
});
