/**
 * issue #216 Phase 2（H&S 分）— H&S 系の**主構成点とネックラインの位置関係**を
 * hard gate にした件の回帰テスト。
 *
 * triple / double 側（`neckline-side-triple-double.test.ts`）は #223 で入っていたが、
 * H&S だけは「スカラー基準（`price`）と傾きつきの線基準（外挿）で判定が反転しうる」ため
 * **#211 の結論待ちで保留**されていた。#211（`necklineAt` の外挿を定義点の区間へクランプ）が
 * PR #239 でマージされ、ブレイク検出・スコアリング・ターゲット投影の全消費者が
 * `necklineAt` 1 つを見るようになったので、**H&S もその `necklineAt` を基準にする**。
 *
 * 本テストが固定するのは 5 点:
 *
 * 1. `validateMainPointsAgainstNecklineAt` の判定そのもの（境界・欠損・重複・単一要素・
 *    **点ごとに違う水準で評価されること**）
 * 2. `necklineSideDetailsFromAt` が **offender ごとに `necklinePrice`** を出すこと
 *    ——H&S では点ごとに比較相手が違うので、1 つのスカラーでは診断にならない
 * 3. 凍結済み実データ（`btc_jpy_1hour_2026_08`）で `view=debug` の候補に
 *    **`peaks_below_neckline` / `valleys_above_neckline` が正しい `offenders` 付きで出る**こと。
 *    top / bottom の両方を実データで押さえる
 * 4. 落ちた構造が `data.patterns` に残っていないこと
 * 5. **形成中経路には配線していない**こと（暫定右肩を hard reject の材料にしない）
 *
 * 実データケースが `patterns` で種別を絞るのは、`view=debug` の候補配列が **cap 200 件**で
 * トリムされるため（`detect_patterns.ts` の `candidatesTrimmed`）。絞らないと 1hour の
 * 候補 2,000 件弱に押し出されて、棄却理由が配列に載らない。
 */
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

/** 傾き 1 の線（`idx` そのぶん水準が上がる）。 */
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
		// 頭がネックラインを追い越した形。`necklineProjectionHeight` の「高さ 0 以下」ガードと
		// 同じ構造だが、あちらは target を出さないだけで候補は残る。本ゲートは候補ごと落とす。
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
		// スカラー版は `necklinePrice` が非有限なら候補ごと素通しだが、線は点ごとに値が違うので
		// 1 点が評価できないことは他の点の判定材料が無いことを意味しない。
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
	it('H&S: 右肩がネックラインより下だと `peaks_below_neckline` で落ちる', async () => {
		// 右肩 (idx 330 / 終値 12,407,578) が `necklineAt(330)` = 12,479,395 より **71,817 円下**。
		// `necklineAt` は #211 で `[p1.idx, p3.idx]` にクランプされるので、この 12,479,395 は
		// 谷2 (idx 325) の水準そのもの——**右肩は「外挿した線」ではなく「谷2 の水準」と比べられる。**
		const { candidates } = await detectDebug('1hour', { patterns: ['head_and_shoulders'], swingDepth: 2 });
		const rejected = candidates.filter((c) => c.reason === 'peaks_below_neckline');
		expect(rejected.length).toBeGreaterThan(0);
		for (const c of rejected) {
			expect(c.type).toBe('head_and_shoulders');
			expect(c.accepted).toBe(false);
			expect(c.details?.offenders).toEqual([
				{
					idx: 330,
					price: 12407578,
					necklinePrice: 12479395,
					deviation: 71817,
					deviationPct: 71817 / 12479395,
				},
			]);
			expect(c.details?.maxDeviation).toBe(71817);
			// 頭 (idx 294) は誤った側ではない——**落ちた原因は肩**。
			expect(c.details?.offenders?.some((o) => o.idx === 294)).toBe(false);
		}
		// 落ちた窓は右肩 325-330 を共有する左肩候補。**#244 Phase 2 で 257 だけになった**——
		// 283 / 211 / 204 は右肩 330（12,407,578）との肩 `relDiff` が 1.386% / 1.188% / 1.306% で
		// `1hour` の肩ゲート（`getHsShoulderMaxPctForTf('1hour')` = 1.04%）を超えるため、
		// **本ゲートより手前の `shoulders_not_near:cap` で落ちる**。257 は 0.844% で通る。
		expect(rejected.map((c) => c.indices?.join('-'))).toEqual(expect.arrayContaining(['257-272-294-325-330']));
	});

	it('逆 H&S: 左肩がネックラインより上だと `valleys_above_neckline` で落ちる', async () => {
		// 左肩 (idx 301 / 終値 12,621,674) が `necklineAt(301)` = 12,617,817（谷1 = idx 308 の
		// 水準にクランプ）より **3,857 円上**。逆 H&S の左肩がネックラインの上に乗っている形。
		const { candidates, patterns } = await detectDebug('1hour', {
			patterns: ['inverse_head_and_shoulders'],
			swingDepth: 2,
		});
		const rejected = candidates.filter((c) => c.reason === 'valleys_above_neckline');
		expect(rejected.length).toBeGreaterThan(0);
		for (const c of rejected) {
			expect(c.type).toBe('inverse_head_and_shoulders');
			expect(c.details?.offenders).toEqual([
				{
					idx: 301,
					price: 12621674,
					necklinePrice: 12617817,
					deviation: 3857,
					deviationPct: 3857 / 12617817,
				},
			]);
		}
		// 落ちた構造は出力に残っていない。
		const rejectedIdxs = new Set(rejected.map((c) => c.indices?.join('-')));
		expect(patterns.filter((p) => rejectedIdxs.has(idxsOf(p)))).toEqual([]);
	});

	it('既定の `swingDepth` でも逆 H&S 225-232-249-265-272 が落ちる（左肩 +14,401 円）', async () => {
		// #211 マージ後の実データで**既定パラメータのまま**落ちる唯一の構造。
		// `tests/patterns/target-reach-window-invariance.test.ts` の退化ターゲット一覧が
		// 7 件 → 6 件になったのはこれ。
		const { candidates, patterns } = await detectDebug('1hour', {
			patterns: ['head_and_shoulders', 'inverse_head_and_shoulders'],
		});
		const rejected = candidates.filter(
			(c) => c.reason === 'valleys_above_neckline' || c.reason === 'peaks_below_neckline',
		);
		expect(rejected.map((c) => [c.type, c.reason, c.indices?.join('-')])).toEqual([
			['inverse_head_and_shoulders', 'valleys_above_neckline', '225-232-249-265-272'],
		]);
		expect(rejected[0].details?.offenders).toEqual([
			{
				idx: 225,
				price: 12296676,
				necklinePrice: 12282275,
				deviation: 14401,
				deviationPct: 14401 / 12282275,
			},
		]);
		expect(patterns.filter((p) => idxsOf(p) === '225-232-249-265-272')).toEqual([]);
	});
});

describe('配線の範囲（issue #216 Phase 2・H&S 分）', () => {
	/**
	 * **形成中経路には配線しない**（triple / double と同じ判断）。形成途中の右肩は暫定値
	 * （現在足の終値）なので、確定していない点を hard reject の材料にしない。
	 *
	 * 挙動ではなくソースで固定しているのは、形成中経路の暫定右肩が「たまたま正しい側に来る」
	 * 実データでは**配線の有無を出力から区別できない**ため（`tests/http-transport-tripwire.test.ts`
	 * と同じ流儀のトリップワイヤ）。
	 */
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
