// 指名するのは #178 の計測記録 §8 の目視判定 #14（12,851,000 → 12,617,817 → 12,495,607 の単調な切り下がり 2.77%）。
// #263 は向きを増やしただけで `FORMING_STAIR_STEP_LIMIT` を動かしていないので、閾値の直下をすり抜ける形はそのまま残る（意図した挙動）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult, assertOk } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { buildBtcJpy1hour202609Candles } from '../fixtures/btc_jpy_1hour_2026_09.js';

type Candidate = {
	type: string;
	accepted: boolean;
	reason?: string;
	indices?: number[];
	points?: Array<{ role: string; idx: number; price: number }>;
};
type Pattern = { type: string; status?: string; pivots?: Array<{ idx: number }> };

afterEach(() => {
	vi.restoreAllMocks();
});

/** 代表窓は `end=200 / swingDepth=6`（ハーネスのローリング窓は `candles.slice(0, windowEnd + 1)` なので 201 本）。`patterns` で種別を絞るのは `view=debug` の cap 対策（#124）。 */
async function detectAtEntity14(): Promise<{ patterns: Pattern[]; candidates: Candidate[] }> {
	const candles = buildBtcJpy1hour202609Candles().slice(0, 201);
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = await detectPatterns('btc_jpy', '1hour', candles.length, {
		includeForming: true,
		view: 'debug',
		swingDepth: 6,
		patterns: ['triple_top'],
	});
	assertOk(res);
	const meta = res.meta as { debug?: { candidates?: Candidate[] } } | undefined;
	return { patterns: res.data.patterns as unknown as Pattern[], candidates: meta?.debug?.candidates ?? [] };
}

describe('形成中 triple の単調性ゲートは両向き（issue #263・実データ C）', () => {
	it('§8 #14: 切り下がる 3 山 113-127-200 が forming_stair_step_down で落ちる', async () => {
		const { candidates } = await detectAtEntity14();

		const hits = candidates.filter((c) => c.type === 'triple_top' && c.reason === 'forming_stair_step_down');
		expect(hits).toHaveLength(1);
		expect(hits[0].accepted).toBe(false);
		expect(hits[0].indices).toEqual([113, 127, 200]);
		// メモ §8 #14 の数値そのもの。ステップ = (12,851,000 − 12,495,607) / 12,851,000 = 2.77% > 2%
		expect(hits[0].points?.map((p) => [p.role, p.price])).toEqual([
			['peak1', 12_851_000],
			['peak2', 12_617_817],
			['current', 12_495_607],
		]);
		const step = (12_851_000 - 12_495_607) / 12_851_000;
		expect(step).toBeGreaterThan(0.02);
		expect(step).toBeCloseTo(0.0277, 4);
	});

	it('§8 #14: この 2 山からは形成中 triple_top が出なくなる', async () => {
		const { patterns } = await detectAtEntity14();
		// 同じ窓の別のピークペアからは forming が出うる（ループが先へ進むため）ので、この構造だけが消えたことを主構成点で確かめる。
		const fromEntity14 = patterns.filter((p) => {
			const idxs = (p.pivots ?? []).map((v) => v.idx);
			return p.status === 'forming' && idxs.includes(113) && idxs.includes(127);
		});
		expect(fromEntity14).toHaveLength(0);
	});
});
