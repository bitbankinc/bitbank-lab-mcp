/**
 * issue #263 — 形成中 triple の単調性ゲートを**両向き**にした件の、実データによる回帰。
 *
 * #263 以前は `triple_top` の切り上がりと `triple_bottom` の切り下がりしか見ておらず、
 * **`triple_top` の単調な切り下がりと `triple_bottom` の単調な切り上がりが素通り**していた。
 * 合成 fixture の最小対（棄却 / 対照）と `pts` の形は `detect_triples.test.ts` が持つ。
 * **ここは「その形が実データに実在する」ことだけを固定する。**
 *
 * 指名するのは #178 項目 1 Phase 1（PR #260）のメモ
 * tjackiet/bitbank-lab-mcp#178 の計測記録
 * §8 の目視判定 **#14**:
 *
 * > `1hour / top / 08-25T02 + 08-25T16` | 呼べない |
 * > (M) 12,851,000 → 12,617,817 → 12,495,607 の**単調な切り下がり 2.77%**。
 * > `FORMING_STAIR_STEP_LIMIT`（2%）は切り上がりしか見ないので素通り（§3-2）
 *
 * §8 が「呼べない」と判定しながら accepted だった実体で、**#263 が単調性の理由コードで落とす**。
 *
 * ## §8 の他の単調な実体は #263 では落ちない（閾値を変えていないため）
 *
 * | § 8 | 形 | ステップ | #263 で落ちるか |
 * |---|---|---:|---|
 * | #14 | `triple_top` の切り下がり | **2.77%** | ✅ 落ちる |
 * | #20 | `triple_top` の切り上がり | 1.86% | ❌（**元から見ていた向き**で、閾値 2% の直下） |
 * | #23 | `triple_bottom` の切り上がり | 1.52% | ❌（新しい向きだが閾値 2% の直下） |
 *
 * **#263 は向きを増やしただけで `FORMING_STAIR_STEP_LIMIT` を動かしていない**ので、
 * 閾値の直下をすり抜ける形はそのまま残る。これは意図した挙動。
 */
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

/**
 * #178 の実データ C（`btc_jpy_1hour_2026_09`）を §8 #14 の**代表窓**に切って走らせる。
 *
 * 代表窓は `end=200 / swingDepth=6`（メモ §3-3 の「代表窓」列）。ハーネスのローリング窓は
 * `candles.slice(0, windowEnd + 1)` なので 201 本になる。`patterns` で種別を絞るのは
 * 検出範囲のためではなく **`view=debug` の cap 対策**（#124）。
 */
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
		// 同じ窓の別のピークペアからは forming が出うる（ループが先へ進むため）。
		// **この構造だけ**が消えたことを主構成点で確かめる。
		const fromEntity14 = patterns.filter((p) => {
			const idxs = (p.pivots ?? []).map((v) => v.idx);
			return p.status === 'forming' && idxs.includes(113) && idxs.includes(127);
		});
		expect(fromEntity14).toHaveLength(0);
	});
});
