// 実データケースが `patterns` で種別を絞るのは、`view=debug` の候補配列が cap 200 件でトリムされるため。
import { describe, expect, it, vi } from 'vitest';
import {
	necklineSideDetailsFrom,
	necklineSideDetailsFromAt,
	validateMainPointsAgainstNecklineAt,
	validateMainPointsNecklineSide,
} from '../../tools/patterns/structural.js';
import { asMockResult, assertOk } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { buildBtcJpy1hour202608Candles } from '../fixtures/btc_jpy_1hour_2026_08.js';

type Candidate = {
	type: string;
	accepted: boolean;
	reason?: string;
	indices?: number[];
	details?: {
		necklinePrice?: number;
		maxDeviation?: number | null;
		offenders?: Array<{ idx: number; price: number; necklinePrice: number; deviation: number; deviationPct: number }>;
	};
};

const pt = (idx: number, price: number) => ({ idx, price });

/** 水平線（スカラー版と同値になるはずのケースで使う）。 */
const flat = (y: number) => () => y;

const sloped = (base: number) => (i: number) => base + i;

describe('validateMainPointsAgainstNecklineAt（issue #216 Phase 2・H&S 分）', () => {
	it('top: 全主構成点がその点のネックライン水準より上なら通す', () => {
		// 線は 101 / 105 / 109。点は 105 / 110 / 115 で全点が上。
		expect(validateMainPointsAgainstNecklineAt('top', [pt(1, 105), pt(5, 110), pt(9, 115)], sloped(100))).toEqual({
			reason: null,
			offenders: [],
		});
	});

	it('bottom: 全主構成点がその点のネックライン水準より下なら通す', () => {
		expect(validateMainPointsAgainstNecklineAt('bottom', [pt(1, 95), pt(5, 100), pt(9, 105)], sloped(100))).toEqual({
			reason: null,
			offenders: [],
		});
	});

	it('**点ごとに違う水準で評価する**（スカラー基準なら通る点が線基準で落ちる）', () => {
		const points = [pt(1, 105), pt(5, 110), pt(9, 108)];
		// スカラー 100 と比べれば 3 点とも上＝通る。
		expect(validateMainPointsNecklineSide('top', points, 100).reason).toBeNull();
		// 傾き 1 の線では idx 9 の水準が 109 なので、108 の点だけが下に落ちる。
		const res = validateMainPointsAgainstNecklineAt('top', points, sloped(100));
		expect(res.reason).toBe('peaks_below_neckline');
		expect(res.offenders).toEqual([{ idx: 9, price: 108, deviation: 1 }]);
	});

	it('水平線ならスカラー版と一致する（triple / double の水平ネックラインでの等価性）', () => {
		for (const side of ['top', 'bottom'] as const) {
			const points = [pt(1, 105), pt(5, 98), pt(9, 100)];
			expect(validateMainPointsAgainstNecklineAt(side, points, flat(100))).toEqual(
				validateMainPointsNecklineSide(side, points, 100),
			);
		}
	});

	it('等号は失格（ネックラインの真上に乗った点はその点の高さが 0）', () => {
		expect(validateMainPointsAgainstNecklineAt('top', [pt(9, 109)], sloped(100)).reason).toBe('peaks_below_neckline');
		expect(validateMainPointsAgainstNecklineAt('top', [pt(9, 109.000001)], sloped(100)).reason).toBeNull();
		expect(validateMainPointsAgainstNecklineAt('bottom', [pt(9, 109)], sloped(100)).reason).toBe(
			'valleys_above_neckline',
		);
		expect(validateMainPointsAgainstNecklineAt('bottom', [pt(9, 108.999999)], sloped(100)).reason).toBeNull();
	});

	it('**頭 (p2) だけが誤った側**のケースも拾う（検出器経由では到達しない形）', () => {
		// 頭がネックラインを追い越した形。`necklineProjectionHeight` の「高さ 0 以下」ガードと同じ構造だが、あちらは target を出さないだけで候補は残る。本ゲートは候補ごと落とす。
		const res = validateMainPointsAgainstNecklineAt('top', [pt(0, 120), pt(5, 100), pt(10, 130)], flat(110));
		expect(res.reason).toBe('peaks_below_neckline');
		expect(res.offenders).toEqual([{ idx: 5, price: 100, deviation: 10 }]);
	});

	it('誤った側の点は**全件**返す（先頭 1 件で打ち切らない）', () => {
		const res = validateMainPointsAgainstNecklineAt('bottom', [pt(1, 105), pt(5, 90), pt(9, 120)], flat(100));
		expect(res.reason).toBe('valleys_above_neckline');
		expect(res.offenders).toEqual([
			{ idx: 1, price: 105, deviation: 5 },
			{ idx: 9, price: 120, deviation: 20 },
		]);
	});

	it('空配列は素通し', () => {
		expect(validateMainPointsAgainstNecklineAt('top', [], flat(100))).toEqual({ reason: null, offenders: [] });
	});

	it('単一要素でも判定する', () => {
		expect(validateMainPointsAgainstNecklineAt('top', [pt(3, 90)], flat(100)).offenders).toEqual([
			{ idx: 3, price: 90, deviation: 10 },
		]);
	});

	it('同じ点が重複していても各行を独立に数える', () => {
		const res = validateMainPointsAgainstNecklineAt('top', [pt(9, 97), pt(9, 97)], flat(100));
		expect(res.offenders).toHaveLength(2);
	});

	it('`price` が有限でない点は検査から除く（落とさない）', () => {
		const res = validateMainPointsAgainstNecklineAt('top', [pt(1, Number.NaN), pt(5, 105)], flat(100));
		expect(res).toEqual({ reason: null, offenders: [] });
	});

	it('**水準が有限でない点だけ**を除く（候補ごと素通しにはしない）', () => {
		// スカラー版は `necklinePrice` が非有限なら候補ごと素通しだが、線は点ごとに値が違うので、1 点が評価できないことは他の点の判定材料が無いことを意味しない。
		const at = (i: number) => (i === 1 ? Number.NaN : 100);
		const res = validateMainPointsAgainstNecklineAt('top', [pt(1, 90), pt(5, 95)], at);
		expect(res.reason).toBe('peaks_below_neckline');
		expect(res.offenders).toEqual([{ idx: 5, price: 95, deviation: 5 }]);
	});
});

describe('necklineSideDetailsFromAt（issue #216 Phase 2・H&S 分）', () => {
	it('offender ごとに**その点の** `necklinePrice` を出す', () => {
		const at = sloped(100);
		const { offenders } = validateMainPointsAgainstNecklineAt('top', [pt(1, 100), pt(9, 108)], at);
		expect(necklineSideDetailsFromAt(at, offenders)).toEqual({
			offenders: [
				{ idx: 1, price: 100, necklinePrice: 101, deviation: 1, deviationPct: 1 / 101 },
				{ idx: 9, price: 108, necklinePrice: 109, deviation: 1, deviationPct: 1 / 109 },
			],
			maxDeviation: 1,
		});
	});

	it('トップレベルの `necklinePrice` は出さない（線に「1 つの水準」は無い）', () => {
		const at = sloped(100);
		const { offenders } = validateMainPointsAgainstNecklineAt('top', [pt(9, 108)], at);
		expect(necklineSideDetailsFromAt(at, offenders)).not.toHaveProperty('necklinePrice');
		// スカラー版は逆に出す（triple / double の出力形は不変）。
		expect(necklineSideDetailsFrom(100, [{ idx: 9, price: 98, deviation: 2 }])).toHaveProperty('necklinePrice', 100);
	});

	it('空配列で -Infinity を載せない', () => {
		expect(necklineSideDetailsFromAt(flat(100), []).maxDeviation).toBeNull();
	});
});

async function detectDebug(
	tf: string,
	opts: Record<string, unknown>,
): Promise<{ patterns: Array<Record<string, unknown>>; candidates: Candidate[] }> {
	const candles = buildBtcJpy1hour202608Candles();
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = await detectPatterns('btc_jpy', tf, candles.length, { view: 'debug', ...opts });
	assertOk(res);
	const meta = res.meta as { debug?: { candidates?: Candidate[] } } | undefined;
	return {
		patterns: res.data.patterns as Array<Record<string, unknown>>,
		candidates: meta?.debug?.candidates ?? [],
	};
}

const idxsOf = (p: Record<string, unknown>) => ((p.pivots as Array<{ idx: number }>) ?? []).map((v) => v.idx).join('-');

describe('実データ（`btc_jpy_1hour_2026_08`）の H&S 候補が誤った側で落ちる', () => {
	it('H&S: 横ばい先行ならネックライン側の検査より前にトレンド不一致で落ちる', async () => {
		// 右肩 (idx 330 / 終値 12,407,578) が `necklineAt(330)` = 12,479,395 より 71,817 円下。`necklineAt` は #211 で `[p1.idx, p3.idx]` にクランプされるので、右肩は「外挿した線」ではなく谷2 (idx 325) の水準と比べられる。
		const { candidates } = await detectDebug('1hour', { patterns: ['head_and_shoulders'], swingDepth: 2 });
		const rejected = candidates.filter((c) => c.reason === 'prior_trend_mismatch:sideways');
		expect(rejected.length).toBeGreaterThan(0);
		for (const c of rejected) {
			expect(c.type).toBe('head_and_shoulders');
			expect(c.accepted).toBe(false);
		}
		// 283 / 211 / 204 は右肩 330 との肩 `relDev` が 1.386% / 1.188% / 1.306% で `1hour` の肩ゲート（1.04%）を超え、本ゲートより手前の `shoulders_not_near:cap` で落ちる（257 は 0.844% で通る）。
		expect(rejected.map((c) => c.indices?.join('-'))).toEqual(expect.arrayContaining(['257-272-294-325-330']));
	});

	it('逆 H&S: 横ばい先行ならネックライン側の検査より前にトレンド不一致で落ちる', async () => {
		// 左肩 (idx 301 / 終値 12,621,674) が `necklineAt(301)` = 12,617,817（谷1 = idx 308 の水準にクランプ）より 3,857 円上。逆 H&S の左肩がネックラインの上に乗っている形。
		const { candidates, patterns } = await detectDebug('1hour', {
			patterns: ['inverse_head_and_shoulders'],
			swingDepth: 2,
		});
		const rejected = candidates.filter((c) => c.reason === 'prior_trend_mismatch:sideways');
		expect(rejected.length).toBeGreaterThan(0);
		for (const c of rejected) {
			expect(c.type).toBe('inverse_head_and_shoulders');
		}
		const rejectedIdxs = new Set(rejected.map((c) => c.indices?.join('-')));
		expect(patterns.filter((p) => rejectedIdxs.has(idxsOf(p)))).toEqual([]);
	});

	it('既定の `swingDepth` でも逆 H&S 225-232-249-265-272 は反対方向ゲートで落ちる', async () => {
		// 時間足別の横ばい閾値により、sideways ではなく up と分類されるが、逆 H&S に必要な down 先行ではないため棄却される。
		const { candidates, patterns } = await detectDebug('1hour', {
			patterns: ['head_and_shoulders', 'inverse_head_and_shoulders'],
		});
		const rejected = candidates.filter((c) => c.reason === 'prior_trend_mismatch:sideways');
		expect(rejected.map((c) => [c.type, c.reason, c.indices?.join('-')])).toEqual([
			['inverse_head_and_shoulders', 'prior_trend_mismatch:sideways', '242-245-249-265-272'],
			['inverse_head_and_shoulders', 'prior_trend_mismatch:sideways', '230-232-249-265-272'],
		]);
		expect(
			candidates.some((c) => c.reason === 'prior_trend_mismatch:up' && c.indices?.join('-') === '225-232-249-265-272'),
		).toBe(true);
		expect(patterns.filter((p) => idxsOf(p) === '225-232-249-265-272')).toEqual([]);
	});
});

describe('配線の範囲（issue #216 Phase 2・H&S 分）', () => {
	// 形成中経路には配線しない（暫定右肩を hard reject の材料にしない）。暫定右肩がたまたま正しい側に来る実データでは配線の有無を出力から区別できないので、ソースで固定する。
	it('完成済み 4 経路にだけ配線されている（形成中 2 経路には無い）', () => {
		const src = readFileSync(resolve(import.meta.dirname, '../../tools/patterns/detect_hs.ts'), 'utf8');
		// import 1 + 呼び出し 4 + docstring 参照。呼び出しだけを数える。
		const calls = src.split('validateMainPointsAgainstNecklineAt(').length - 1;
		expect(calls).toBe(4);
		for (const fn of ['function formingHsForHead(', 'function formingInverseHsForHead(']) {
			const from = src.indexOf(fn);
			expect(from).toBeGreaterThan(-1);
			// 次の top-level 関数定義までを本体とみなす。
			const rest = src.slice(from + fn.length);
			const to = rest.indexOf('\nfunction ');
			const body = to < 0 ? rest : rest.slice(0, to);
			expect(body).not.toContain('validateMainPointsAgainstNecklineAt');
		}
	});
});
