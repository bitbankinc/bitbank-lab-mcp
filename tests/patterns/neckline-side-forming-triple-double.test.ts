// double 側は形成中経路を見ていない（`tryFormingDoubleBottom` は #262、`tryFormingDoubleTop` は #268 案 C で削除）。`double_bottom` は同じ 3 点を完成済み経路が `near_completion` として組む。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult, assertOk } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { buildBtcJpy1hour20260905Candles } from '../fixtures/btc_jpy_1hour_2026_09_05.js';
import {
	type Candle,
	formingDoubleBottomRows,
	formingTripleTopRows,
	mirrorRows,
	rowsToCandles,
} from '../fixtures/forming_neckline_side_261.js';

type Candidate = {
	type: string;
	accepted: boolean;
	reason?: string;
	status?: string;
	indices?: number[];
	details?: {
		necklinePrice?: number;
		maxDeviation?: number | null;
		offenders?: Array<{ idx: number; price: number; deviation: number; deviationPct: number }>;
	};
};
type Pattern = { type: string; status?: string };

afterEach(() => {
	vi.restoreAllMocks();
});

async function detectForming(
	candles: Candle[],
	tf: string,
	opts: Record<string, unknown> = {},
): Promise<{ patterns: Pattern[]; candidates: Candidate[] }> {
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = await detectPatterns('btc_jpy', tf, candles.length, { includeForming: true, view: 'debug', ...opts });
	assertOk(res);
	const meta = res.meta as { debug?: { candidates?: Candidate[] } } | undefined;
	return { patterns: res.data.patterns as unknown as Pattern[], candidates: meta?.debug?.candidates ?? [] };
}

const forming = (patterns: Pattern[], type: string) =>
	patterns.filter((p) => p.type === type && p.status === 'forming');
/** ブレイク待ちの完成構造（issue #262 で `double_bottom` がこちらへ移った）。 */
const nearCompletion = (patterns: Pattern[], type: string) =>
	patterns.filter((p) => p.type === type && p.status === 'near_completion');
const withReason = (cands: Candidate[], type: string, reason: string) =>
	cands.filter((c) => c.type === type && c.reason === reason);

describe('形成中 triple — 主構成点がネックラインの誤側（issue #261）', () => {
	it('3 山目（最新足）がネックラインより下の triple_top は forming_peaks_below_neckline で落ちる', async () => {
		const { patterns, candidates } = await detectForming(rowsToCandles(formingTripleTopRows(98.4)), '1day');
		expect(forming(patterns, 'triple_top')).toHaveLength(0);

		const hits = withReason(candidates, 'triple_top', 'forming_peaks_below_neckline');
		expect(hits).toHaveLength(1);
		expect(hits[0].accepted).toBe(false);
		// 棄却エントリに status は付かない（成功エントリと読み分けるための印。#158）
		expect(hits[0].status).toBeUndefined();
		expect(hits[0].indices).toEqual([9, 22, 35]);
		expect(hits[0].details).toEqual({
			necklinePrice: 98.5,
			offenders: [
				{ idx: 35, price: 98.4, deviation: expect.closeTo(0.1, 6), deviationPct: expect.closeTo(0.0010152, 6) },
			],
			maxDeviation: expect.closeTo(0.1, 6),
		});
	});

	it('対照: 3 山目をネックラインの上に置くと accepted のまま（最小対）', async () => {
		const { patterns, candidates } = await detectForming(rowsToCandles(formingTripleTopRows(98.6)), '1day');
		expect(forming(patterns, 'triple_top')).toHaveLength(1);
		expect(withReason(candidates, 'triple_top', 'forming_peaks_below_neckline')).toHaveLength(0);
	});

	it('3 谷目がネックラインより上の triple_bottom も同じ形で落ちる（top の鏡像）', async () => {
		const rows = mirrorRows(formingTripleTopRows(98.4));
		const { patterns, candidates } = await detectForming(rowsToCandles(rows), '1day');
		expect(forming(patterns, 'triple_bottom')).toHaveLength(0);

		const hits = withReason(candidates, 'triple_bottom', 'forming_valleys_above_neckline');
		expect(hits).toHaveLength(1);
		expect(hits[0].indices).toEqual([9, 22, 35]);
		expect(hits[0].details?.necklinePrice).toBe(101.5);
		expect(hits[0].details?.offenders?.[0]).toMatchObject({ idx: 35, price: 101.6 });
	});

	it('対照: 鏡像でも 3 谷目をネックラインの下に置けば accepted のまま', async () => {
		const rows = mirrorRows(formingTripleTopRows(98.6));
		const { patterns, candidates } = await detectForming(rowsToCandles(rows), '1day');
		expect(forming(patterns, 'triple_bottom')).toHaveLength(1);
		expect(withReason(candidates, 'triple_bottom', 'forming_valleys_above_neckline')).toHaveLength(0);
	});
});

describe('ブレイク待ち double — 主構成点がネックラインの誤側（issue #261 / #262）', () => {
	// `indices` が 3 点なのは、完成済み経路が最新足を構成点として持たないため。
	it('谷1 がネックライン（山の終値）以上の double_bottom は valleys_above_neckline で落ちる', async () => {
		const { patterns, candidates } = await detectForming(rowsToCandles(formingDoubleBottomRows()), '1day');
		expect(nearCompletion(patterns, 'double_bottom')).toHaveLength(0);
		// 形成中パスは削除済みなので `forming_` 接頭辞側は 1 件も出ない
		expect(withReason(candidates, 'double_bottom', 'forming_valleys_above_neckline')).toHaveLength(0);

		// strict と relaxed の 2 件が並ぶ（relaxed は同 type の strict が `completed` を出さなかったときのフォールバック）。同じ 3 点・同じ理由コードなので中身は同一。
		const hits = withReason(candidates, 'double_bottom', 'valleys_above_neckline');
		expect(hits).toHaveLength(2);
		for (const hit of hits) {
			expect(hit.indices).toEqual([8, 16, 24]);
			expect(hit.details?.necklinePrice).toBe(101.086);
			expect(hit.details?.offenders).toEqual([
				{ idx: 8, price: 101.543, deviation: expect.closeTo(0.457, 6), deviationPct: expect.closeTo(0.0045209, 6) },
			]);
		}
	});

	it('対照: 山をネックラインとして 2 谷の上に置くと accepted のまま（最小対）', async () => {
		const { patterns, candidates } = await detectForming(rowsToCandles(formingDoubleBottomRows(102.5)), '1day');
		expect(nearCompletion(patterns, 'double_bottom')).toHaveLength(1);
		expect(withReason(candidates, 'double_bottom', 'valleys_above_neckline')).toHaveLength(0);
	});
});

describe('同じ形が凍結済み実データにも存在する（issue #261・btc_jpy_1hour_2026_09_05）', () => {
	// PR #260 のメモ §8 の目視判定 #34（「(N) 3 点目 12,465,523 < NL 12,480,430」）。実データ D の全 365 本がそのまま代表窓なので、fixture を切らずに再現できる。
	// `patterns` で種別を絞るのは `view=debug` の cap 対策（`detect_patterns.ts` は候補を要求種別で絞ってから cap = 200 でトリムする。#124）。
	it('#34: triple_top 329-338-364 が neckline-side gate で落ちる', async () => {
		const { patterns, candidates } = await detectForming(
			buildBtcJpy1hour20260905Candles() as unknown as Candle[],
			'1hour',
			{ swingDepth: 3, patterns: ['triple_top'] },
		);
		expect(forming(patterns, 'triple_top')).toHaveLength(0);

		const hit = withReason(candidates, 'triple_top', 'forming_peaks_below_neckline').find(
			(c) => String(c.indices?.join('-')) === '329-338-364',
		);
		expect(hit).toBeDefined();
	});
});
