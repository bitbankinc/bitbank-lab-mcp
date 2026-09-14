/**
 * triple × H&S の型間排他（issue #218 Phase 2）を**実データのパイプライン全体**で固定する。
 *
 * `tests/patterns/mutual-exclusion.test.ts` が純関数の契約を見るのに対し、こちらは
 * `detect_patterns` を通したときに
 *
 * 1. issue #218 の受け入れ条件（実データ B `1hour` の `triple_bottom` 242-249-272 が
 *    逆 H&S 230-232-249-265-272 と 249・272 を共有して落ちる）が成立すること
 * 2. **落ちるのは `triple_*` だけ**で H&S 系・double・wedge・triangle・pennant が 1 件も動かないこと
 * 3. 新しい縮小段が `meta.reduction` と `検出内訳:` 行に申告されること（#200 の契約）
 * 4. 落ちた理由が `view=debug` から追えること（**cap トリムで押し出されない**こと込み）
 * 5. **排他の根拠が「実際に出力される H&S」であること**——ライフサイクル絞り込みより後に
 *    置いていることの回帰。先に置くと、根拠にした H&S が後段で消えて「どちらも残らない」
 *    ケースが作れてしまう
 *
 * を見る。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import { toolDef as detectPatternsTool } from '../src/handlers/detectPatternsHandler.js';
import { TRIPLE_HS_NO_CANDIDATE_NOTE } from '../src/handlers/detectPatternsViewsHandler.js';
import analyzeIndicators from '../tools/analyze_indicators.js';
import detectPatterns from '../tools/detect_patterns.js';
import { mainPointIdxs, TRIPLE_HS_EXCLUSION_REASON } from '../tools/patterns/mutual-exclusion.js';
import type { DeduplicablePattern } from '../tools/patterns/types.js';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';
import { buildBtcJpy1hour202608Candles } from './fixtures/btc_jpy_1hour_2026_08.js';

/** `type` と主構成点 idx だけに畳んだ識別キー。 */
function keyOf(p: { type?: string; pivots?: Array<{ idx: number; kind: string }> }): string {
	return `${p.type}|${(p.pivots ?? []).map((v) => `${v.kind}${v.idx}`).join('-')}`;
}

async function run(opts: Record<string, unknown> = {}) {
	const candles = buildBtcJpy1hour202608Candles();
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = await detectPatterns('btc_jpy', '1hour', 365, opts);
	assertOk(res);
	return res;
}

describe('detect_patterns: triple × H&S の型間排他（issue #218 Phase 2）', () => {
	it('受け入れ条件: triple_bottom 242-249-272 が落ち、共有した逆 H&S は残る', async () => {
		const res = await run();
		const keys = res.data.patterns.map(keyOf);

		// 落ちる側: issue #218 本文の実例（conf 0.81 / 構成点 idx 242 / 249 / 272）
		expect(keys).not.toContain('triple_bottom|L242-L249-L272');
		// 根拠側: 主構成点は左肩 230 / 頭 249 / 右肩 272。**249・272 の 2 点**を共有する
		expect(keys).toContain('inverse_head_and_shoulders|L230-H232-L249-H265-L272');

		// 逆 H&S の主構成点と triple の主構成点の共有が 2 点であることを実データで固定する
		// （どちらかの構造が入れ替わったらこの数が変わり、受け入れ条件の前提が崩れる）。
		const ihs = res.data.patterns.find((p) => keyOf(p) === 'inverse_head_and_shoulders|L230-H232-L249-H265-L272');
		expect(mainPointIdxs(ihs as DeduplicablePattern)).toEqual([230, 249, 272]);
	});

	it('落ちるのは triple_* だけ — H&S 系 / double / wedge / triangle / pennant は 1 件も動かない', async () => {
		const res = await run();
		const byType = new Map<string, number>();
		for (const p of res.data.patterns) byType.set(p.type, (byType.get(p.type) ?? 0) + 1);
		// 実データ B の 1hour（デフォルトオプション）の内訳。本段（型間排他）が落とすのは
		// `triple_bottom` 242-249-272 の 1 件だけで、H&S 系 / double / wedge / triangle /
		// pennant は 1 件も動かない（`tripleHsExcluded` が 1 のままであることは下の
		// waterfall のテストが固定する）。
		//
		// **`triple_top` 219-223-232 は #216 Phase 2 で消えた**——本段の対象外
		// （出力に残る 2 件の `head_and_shoulders` と主構成点を 1 点も共有しない）だが、
		// 山3（idx 232 / 終値 12,282,275）がネックライン 12,285,548.5 より 3,273.5 円下で、
		// **検出器層の `peaks_below_neckline` がここへ到達する前に落としている。**
		// この件数は本 issue のゲートではなく #216 Phase 2 のゲートが決めている。
		//
		// **`head_and_shoulders` 2 件は #211（`necklineAt` の外挿クランプ）で消えた**——これも
		// 本段の対象外で、ブレイクが右肩より後ろの外挿に依存していたため `near_completion` に
		// 落ち、既定 `includeForming: false` で除かれている。逆 H&S 2 件は残るので、本段が
		// 落とす `triple_bottom` 242-249-272（共有点 249 / 272）の前提は変わらない。
		expect(Object.fromEntries([...byType].sort())).toEqual({
			falling_wedge: 2,
			inverse_head_and_shoulders: 2,
			rising_wedge: 2,
			triangle_ascending: 4,
		});
		expect(res.meta.count).toBe(10);
	});

	it('meta.reduction に新しい段が載り、waterfall が成立する', async () => {
		const res = await run();
		const r = res.meta.reduction as Record<string, number>;
		expect(r.tripleHsExcluded).toBe(1);
		// 既定呼び出しでは H&S 系 2 件（逆 H&S 2。#211 のクランプで `head_and_shoulders` 2 件が
		// `near_completion` に落ちた）が出力に残り、それが比較対象になる（#224 症状 1）。
		expect(r.tripleHsCandidateCount).toBe(2);
		expect(r.dedupMerged + r.currentFiltered + r.lifecycleExcluded + r.tripleHsExcluded + r.output).toBe(r.detected);
		expect(r.output).toBe(res.meta.count);
	});

	// issue #224 症状 1: `tripleHsExcluded` の 0 は「比較して該当なし」と「比較対象が無く比較できなかった」の
	// 2 通りある。`patterns` で triple 系だけを要求すると H&S 検出器が走らず後者になる
	// （`mutual-exclusion.ts` 冒頭「`patterns` で絞ると排他も効かない」は仕様）。判定は変えず申告だけ足す。
	describe('patterns で絞って H&S が出力集合に無いとき（issue #224 症状 1）', () => {
		it('tripleHsExcluded=0 かつ tripleHsCandidateCount=0 になり、既定呼び出しなら落ちる triple_bottom がそのまま返る', async () => {
			const res = await run({ patterns: ['triple_bottom'] });
			const r = res.meta.reduction as Record<string, number>;
			expect(r.tripleHsExcluded).toBe(0);
			expect(r.tripleHsCandidateCount).toBe(0);
			// 既定呼び出しで排他される 242-249-272（conf 0.81）が、比較対象が無いので残る（仕様どおり）。
			// `pivots` にはネックライン定義点 245 / 265 も入る（#224 症状 3）。
			expect(res.data.patterns.map(keyOf)).toContain('triple_bottom|L242-H245-L249-H265-L272');
			expect(res.data.patterns.every((p) => p.type === 'triple_bottom')).toBe(true);
			expect(r.dedupMerged + r.currentFiltered + r.lifecycleExcluded + r.tripleHsExcluded + r.output).toBe(r.detected);
		});

		it('検出内訳行に「比較対象 H&S 無し」の注記が付く', async () => {
			const candles = buildBtcJpy1hour202608Candles();
			vi.mocked(analyzeIndicators).mockResolvedValueOnce(
				asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
			);
			const res = (await detectPatternsTool.handler({
				pair: 'btc_jpy',
				type: '1hour',
				limit: 365,
				patterns: ['triple_bottom'],
				view: 'summary',
			})) as { content: Array<{ text: string }> };
			const line = res.content[0].text.split('\n').find((l) => l.startsWith('検出内訳:'));
			expect(line).toContain(`triple×H&S排他 -0${TRIPLE_HS_NO_CANDIDATE_NOTE}`);
		});

		it('既定呼び出し（H&S も検出）では注記が付かない', async () => {
			const candles = buildBtcJpy1hour202608Candles();
			vi.mocked(analyzeIndicators).mockResolvedValueOnce(
				asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
			);
			const res = (await detectPatternsTool.handler({
				pair: 'btc_jpy',
				type: '1hour',
				limit: 365,
				view: 'summary',
			})) as {
				content: Array<{ text: string }>;
			};
			const line = res.content[0].text.split('\n').find((l) => l.startsWith('検出内訳:'));
			expect(line).not.toContain(TRIPLE_HS_NO_CANDIDATE_NOTE);
		});
	});

	it('検出内訳行に段が出る（#200 の契約。0 件でも省かない）', async () => {
		const candles = buildBtcJpy1hour202608Candles();
		vi.mocked(analyzeIndicators).mockResolvedValueOnce(
			asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
		);
		const res = (await detectPatternsTool.handler({ pair: 'btc_jpy', type: '1hour', limit: 365, view: 'summary' })) as {
			content: Array<{ text: string }>;
		};
		const line = res.content[0].text.split('\n').find((l) => l.startsWith('検出内訳:'));
		expect(line).toContain('triple×H&S排他 -1');
		// 段の並びはパイプライン順（ライフサイクル絞り込みの**後**）。
		expect(line).toMatch(/ライフサイクル除外 -\d+ → triple×H&S排他 -\d+ → 出力/);
	});

	it('view=debug で「どの H&S と何点共有したか」が追える（cap トリムで押し出されない）', async () => {
		const res = await run();
		const candidates = (res.meta.debug?.candidates ?? []) as Array<Record<string, unknown>>;
		// **cap（200 件）に対して候補は 1,900 件超ある。** 検出器の棄却理由と同じ優先度で積むと
		// 本段は最後に push されるため必ず押し出される——ここが落ちたらトリムの優先度が戻っている。
		expect(res.meta.debug?.candidatesOmitted).toBeGreaterThan(0);

		const hit = candidates.filter((c) => c.reason === TRIPLE_HS_EXCLUSION_REASON);
		expect(hit).toHaveLength(1);
		expect(hit[0].type).toBe('triple_bottom');
		expect(hit[0].accepted).toBe(false);
		expect(hit[0].indices).toEqual([242, 249, 272]);
		// #224 症状 3: triple の `pivots` にネックライン定義点（2 山）が入ったので、`points` は 5 点になる。
		// role は `kind` から決めるため、`role: 'main'` の集合は `indices` と一致する（全点を main と
		// 名乗ると `indices` と食い違う）。
		const points = hit[0].points as Array<{ role: string; idx: number }>;
		expect(points.map((p) => [p.role, p.idx])).toEqual([
			['main', 242],
			['neckline', 245],
			['main', 249],
			['neckline', 265],
			['main', 272],
		]);
		expect(points.filter((p) => p.role === 'main').map((p) => p.idx)).toEqual(hit[0].indices);
		expect(hit[0].details).toEqual({
			tripleMainIdxs: [242, 249, 272],
			sharedCount: 2,
			matches: [{ hsType: 'inverse_head_and_shoulders', hsMainIdxs: [230, 249, 272], sharedIdxs: [249, 272] }],
		});
	});

	// **ライフサイクル絞り込みより後に置いていることの回帰。** 先に置くと、根拠にした H&S が
	// あとから `includeForming` / `includeCompleted` / `includeInvalid` で消え、
	// **triple も H&S も残らない**組み合わせが作れてしまう。ここでは「落とした triple の
	// `matches` が、同じ応答の `data.patterns` に実在する H&S を指している」ことを
	// 8 通りのライフサイクル組み合わせすべてで固定する。
	const LIFECYCLE_COMBOS = [false, true].flatMap((includeForming) =>
		[false, true].flatMap((includeCompleted) =>
			[false, true].map((includeInvalid) => ({ includeForming, includeCompleted, includeInvalid })),
		),
	);

	it.each(LIFECYCLE_COMBOS)('排他の根拠は出力に残る H&S だけ: %o', async (opts) => {
		const res = await run(opts);
		const outputHsMain = new Set(
			res.data.patterns
				.filter((p) => p.type === 'head_and_shoulders' || p.type === 'inverse_head_and_shoulders')
				.map((p) => mainPointIdxs(p as DeduplicablePattern).join('-')),
		);
		const hit = ((res.meta.debug?.candidates ?? []) as Array<Record<string, unknown>>).filter(
			(c) => c.reason === TRIPLE_HS_EXCLUSION_REASON,
		);
		const r = res.meta.reduction as Record<string, number>;
		expect(hit).toHaveLength(r.tripleHsExcluded);
		for (const c of hit) {
			const matches = (c.details as { matches: Array<{ hsMainIdxs: number[] }> }).matches;
			expect(matches.length).toBeGreaterThan(0);
			for (const m of matches) {
				expect(outputHsMain, `${c.type} の根拠 ${m.hsMainIdxs} が data.patterns に居ない`).toContain(
					m.hsMainIdxs.join('-'),
				);
			}
		}
	});

	it('8 通りのうち少なくとも 1 つで実際に排他が起きている（上のテストが空振りしていない）', async () => {
		let total = 0;
		for (const opts of LIFECYCLE_COMBOS) {
			const res = await run(opts);
			total += (res.meta.reduction as Record<string, number>).tripleHsExcluded;
		}
		expect(total).toBeGreaterThan(0);
	});

	// 上流失敗の早期 return（`if (!res.ok) return fail(...)`）は本段より**前**にあるので、
	// 排他は走らず `meta.reduction` も生えない。
	//
	// **`fail` / `patterns` / `debug` 側の一般契約は
	// `tests/patterns/level-spread-triple.test.ts` が既に固定している**ので、ここでは重複させず
	// **#218 が足した 2 つだけ**を見る: `meta.reduction`（4 段目 `tripleHsExcluded` を含む）が
	// 生えないことと、排他の棄却候補が 1 件も積まれないこと。
	//
	// `ok()` を返す 2 経路（通常 / `'insufficient data'`）の `reduction` は
	// `tests/detect_patterns_meta_schema_parity.test.ts` が押さえており、**これで 3 つある
	// 出口すべてが埋まる**——早期 return に段を足し忘れる #184 決定事項 1 のクラスの穴を塞ぐ。
	it('上流がエラーなら排他まで到達せず、meta.reduction も排他候補も生えない', async () => {
		vi.mocked(analyzeIndicators).mockResolvedValueOnce(
			asMockResult({ ok: false, summary: 'Error: upstream failed', data: {}, meta: { errorType: 'network' } }),
		);

		const res = await detectPatterns('btc_jpy', '1hour', 365, { view: 'debug' });

		assertFail(res);
		expect((res.meta as { reduction?: unknown }).reduction).toBeUndefined();
		const candidates = ((res.meta as { debug?: { candidates?: Array<Record<string, unknown>> } }).debug?.candidates ??
			[]) as Array<Record<string, unknown>>;
		expect(candidates.filter((c) => c.reason === TRIPLE_HS_EXCLUSION_REASON)).toHaveLength(0);
	});
});
