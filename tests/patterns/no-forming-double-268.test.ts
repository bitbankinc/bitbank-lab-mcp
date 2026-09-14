/**
 * issue #268 案 C のトリップワイヤ — **double は `status: 'forming'` を出さない。**
 *
 * `tryFormingDoubleBottom` は #262、`tryFormingDoubleTop` は #268 案 C で削除した。
 * 結果として `double_top` / `double_bottom` が取りうる `status` は
 * `near_completion` / `completed` / `invalid` / `expired` の 4 段で、**`forming` は仕様に無い**
 * （`src/schema/patterns.ts` の `status` の description と `docs/tools.md` の
 * 「`status` に `expired` がある」の節が契約側の単一ソース）。
 *
 * 理由は「最終構成点が 1 つしか無く、形成中を定義できない」こと。2 山のうち 1 つを最新足の
 * 暫定値で埋める経路は、主構成点 2 点のうち 1 点が確定ピボットでないため
 * **ネックライン側検査を 2 つの理由コードに分担する / 単調性ゲートが定義できない /
 * `pivots` が 2 点になる**という double 専用の例外を仕様のあちこちに作っていた（#262 / #269）。
 * 実データ 12,104 ケースで accepted は 0 件（`forming_bars_out_of_range` の下限割れが律速。
 * #268 Phase 1 §1）だったので、例外を抱え続ける理由も無かった。
 *
 * ## 将来 `forming` を再導入するときは、このファイルを**意図的に外す**
 *
 * 「たまたま 0 件」と「仕様として出ない」を区別するための仕掛けなので、再導入の PR は
 * ここを消す（または期待を反転させる）ことで意思表示になる。黙って通ってしまう状態にはしない。
 *
 * ## 3 層で見る
 *
 * 1. **削除前に実際に `forming` を出していた形**（{@link LEGACY_ACCEPTED_SHAPES}）。
 *    **この層だけが判別力を持つ。** 標準の合成 fixture と実データは削除前から 0 件
 *    （#268 Phase 1 §1 の `base` accepted 0）なので、それだけでは経路を戻しても落ちない。
 *    形は削除したテストから写してある（出どころは各 fixture の docstring）。
 * 2. **横断**: `includeForming: true`（かつ `includeInvalid: true`）で合成 fixture 全件と
 *    凍結済み実データ B を流し、`double_*` に `status: 'forming'` が 1 件も出ないこと。
 *    1 と違って削除前から 0 件だが、**別の形で `forming` が生える**変更を拾う網として置く。
 *    `view=debug` の候補側でも `status: 'forming'` が積まれないことを併せて見る
 *    （`data.patterns` は dedup の後なので、候補側が無音であることまで見ないと
 *    「組まれたが畳まれた」と区別できない）。
 * 3. **ソース**: `tools/patterns/detect_doubles.ts` に `tryFormingDoubleTop` /
 *    `tryFormingDoubleBottom` が復活していないこと。削除した経路が**別の名前で**戻ってきた
 *    場合は 1 / 2 が拾う。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { asMockResult, assertOk } from '../_assertResult.js';
import { buildBtcJpy1hour202608Candles } from '../fixtures/btc_jpy_1hour_2026_08.js';
import * as synth from '../fixtures/synthetic_pattern_candles.js';

type Candle = ReturnType<typeof synth.makeCandle>;
type Pattern = { type: string; status?: string };
type Candidate = { type: string; accepted: boolean; reason?: string; status?: string };

const DOUBLE_TYPES = ['double_top', 'double_bottom'] as const;

/**
 * 合成 fixture の全ビルダー。**名前で選ばない**——`build*Candles` を機械的に集めるので、
 * 新しい fixture を足したらこのトリップワイヤも自動でそれを見る。
 */
const SYNTHETIC_BUILDERS: Array<[string, () => Candle[]]> = Object.entries(synth)
	.filter(
		(entry): entry is [string, () => Candle[]] =>
			entry[0].startsWith('build') && entry[0].endsWith('Candles') && typeof entry[1] === 'function',
	)
	.map(([name, build]) => [name, build]);

/**
 * 削除前の `tryFormingDoubleTop` が**実際に `status: 'forming'` を出していた形**。
 *
 * 標準の合成 fixture / 実データはどの時間足でも 0 件だった（#268 Phase 1 §1）ので、
 * それだけを見るトリップワイヤは経路を戻しても落ちない。ここに削除したテストの fixture を
 * 写して**判別力のある層**にしてある:
 *
 * | 形 | 出どころ（削除したテスト） | 削除前の期待 |
 * |---|---|---|
 * | `sizeGateTop` | `size-gates-forming-doubles.test.ts` の `buildFormingDoubleTop(95)` | `1day` で accepted な形成中 `double_top` |
 * | `sizeGateTop(1hour)` | 同上（谷 96。時間足別のサイズ閾値で通る側） | `1hour` で accepted |
 * | `debugCandidateTop` | `forming-double-triple-debug-candidates.test.ts` の `FORMING_DOUBLE_TOP` | `1day` で accepted（`pivots` = `[10, 20]`） |
 *
 * どれも「確定した山 1 つ + その後の谷 + 最新足が山の水準まで戻った」形で、
 * **完成済み経路では構成点 3 点が揃わない**（谷より後が最終足まで単調増加なので山2 が
 * 確定ピボットにならない）。したがって `forming` を出す経路が無い限り double は 1 件も出ない。
 *
 * **`tests/detect_doubles.test.ts` から削除した「確定ピーク + 谷 + 現在価格がピーク付近」は
 * ここに移していない。** あのテストは `DetectContext` に**手で組んだピボット列**を注入して
 * `detectDoubles` を直接呼ぶ形で、`detectPatterns` 経由（実際のスイング検出）では同じ
 * 構成点が立たない——削除前の実装に戻しても落ちないので、判別力のある層には置けない。
 */
const LEGACY_ACCEPTED_SHAPES: Array<[name: string, tf: string, swingDepth: number, candles: () => Candle[]]> = [
	['sizeGateTop', '1day', 2, () => legacySizeGateTop(95)],
	['sizeGateTop(1hour)', '1hour', 2, () => legacySizeGateTop(96)],
	['debugCandidateTop', '1day', 3, () => legacyDebugCandidateTop()],
];

/** 終値列 → ヒゲ無しのローソク（`extremePrice === close`。size-gates の fixture と同じ）。 */
const closesToCandles = (closes: number[]): Candle[] => closes.map((c, i) => synth.makeCandle(i, c));

/** `size-gates-forming-doubles.test.ts` の `buildFormingDoubleTop`（山1 100 / 谷 `valley` / 最新足 100）。 */
function legacySizeGateTop(valley: number, lastIdx = 40): Candle[] {
	const closes: number[] = [94, 96, 98, 100];
	for (let i = 1; i <= 5; i++) closes.push(100 - ((100 - valley) * i) / 5); // idx 4..8 → 谷は idx=8
	const n = lastIdx - 8;
	for (let i = 1; i <= n; i++) closes.push(valley + ((100 - valley) * i) / n);
	return closesToCandles(closes);
}

/** `forming-double-triple-debug-candidates.test.ts` の `FORMING_DOUBLE_TOP`（100 → 130 → 112 → 128.05）。 */
function legacyDebugCandidateTop(): Candle[] {
	const spec: Array<[bars: number, end: number]> = [
		[10, 130],
		[10, 112],
		[13, 128.05],
	];
	const closes = [100];
	let cur = 100;
	for (const [bars, end] of spec) {
		for (let i = 1; i <= bars; i++) closes.push(cur + ((end - cur) * i) / bars);
		cur = end;
	}
	return closes.map((c, i) => {
		const close = Math.round(c * 100) / 100;
		return { ...synth.makeCandle(i, close), high: close + 3, low: close - 3 };
	});
}

/** 1 系列を `includeForming: true` / `view=debug` で流す。 */
async function run(
	candles: Candle[],
	tf: string,
	swingDepth: number | undefined,
): Promise<{ patterns: Pattern[]; candidates: Candidate[] }> {
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = await detectPatterns('btc_jpy', tf, candles.length, {
		includeForming: true,
		includeCompleted: true,
		includeInvalid: true,
		view: 'debug',
		...(swingDepth === undefined ? {} : { swingDepth }),
	});
	assertOk(res);
	const meta = res.meta as { debug?: { candidates?: Candidate[] } } | undefined;
	return { patterns: res.data.patterns as unknown as Pattern[], candidates: meta?.debug?.candidates ?? [] };
}

/** `double_*` の `forming` を `data.patterns` と候補の両方から集める。 */
function formingDoubles(out: { patterns: Pattern[]; candidates: Candidate[] }): string[] {
	const hits: string[] = [];
	for (const p of out.patterns) {
		if (DOUBLE_TYPES.includes(p.type as (typeof DOUBLE_TYPES)[number]) && p.status === 'forming') {
			hits.push(`data.patterns: ${p.type}`);
		}
	}
	for (const c of out.candidates) {
		if (DOUBLE_TYPES.includes(c.type as (typeof DOUBLE_TYPES)[number]) && c.status === 'forming') {
			hits.push(`candidate: ${c.type} (accepted=${c.accepted}, reason=${c.reason ?? '—'})`);
		}
	}
	return hits;
}

describe('double に status: forming は存在しない（issue #268 案 C のトリップワイヤ）', () => {
	describe('削除前に forming を出していた形（判別力のある層）', () => {
		for (const [name, tf, swingDepth, build] of LEGACY_ACCEPTED_SHAPES) {
			it(`${name} / ${tf} / sd=${swingDepth}`, async () => {
				const out = await run(build(), tf, swingDepth);
				expect(formingDoubles(out), `${name}: forming の double が出ている`).toEqual([]);
				// **この形は完成済み経路でも候補にならない**（山2 が確定ピボットにならないため）。
				// 「何かは出るが forming ではない」ではなく「double が 1 件も出ない」が削除後の姿。
				expect(
					out.patterns.filter((p) => DOUBLE_TYPES.includes(p.type as (typeof DOUBLE_TYPES)[number])),
					`${name}: double が出ている（この形は完成済み経路の構成点が揃わない）`,
				).toEqual([]);
			});
		}
	});

	it(`合成 fixture ${SYNTHETIC_BUILDERS.length} 本 × 時間足 2 × swingDepth 3 で 1 件も出ない`, async () => {
		// ビルダーを 1 本も拾えていないと「全件 0 件」が自明に通るので、母数を先に固定する。
		expect(SYNTHETIC_BUILDERS.length, '合成 fixture のビルダーが集まっていない').toBeGreaterThanOrEqual(20);

		for (const [name, build] of SYNTHETIC_BUILDERS) {
			for (const tf of ['1day', '1hour']) {
				for (const swingDepth of [undefined, 2, 3]) {
					const hits = formingDoubles(await run(build(), tf, swingDepth));
					expect(hits, `${name} / ${tf} / sd=${swingDepth ?? 'auto'}`).toEqual([]);
				}
			}
		}
	});

	it('凍結済み実データ B（btc_jpy_1hour_2026_08）× 時間足 3 × swingDepth 4 で 1 件も出ない', async () => {
		const candles = buildBtcJpy1hour202608Candles() as unknown as Candle[];
		for (const tf of ['1day', '4hour', '1hour']) {
			for (const swingDepth of [undefined, 2, 3, 6]) {
				const hits = formingDoubles(await run(candles, tf, swingDepth));
				expect(hits, `実データ B / ${tf} / sd=${swingDepth ?? 'auto'}`).toEqual([]);
			}
		}
	});

	it('同じ系列で near_completion の double は実際に出る（0 件が「検出器が黙っている」ではないこと）', async () => {
		// 上の 2 つは「出ない」ことしか見ないので、検出器ごと壊れていても通ってしまう。
		// double の未ブレイク構造がちゃんと `near_completion` で出ることを 1 件だけ対照に置く。
		const out = await run(synth.buildFormingDoubleBottomCandles(), '1day', 2);
		const nearCompletion = out.patterns.filter((p) => p.type === 'double_bottom' && p.status === 'near_completion');
		expect(nearCompletion.length, 'double_bottom の near_completion が 0 件').toBeGreaterThanOrEqual(1);
	});

	it('detect_doubles.ts に形成中 double の関数が復活していない', () => {
		const src = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), '../../tools/patterns/detect_doubles.ts'),
			'utf8',
		);
		// `function` を含めて見るのは、docstring や削除の経緯コメントで名前に触れても落ちないようにするため
		// （**誤検知する tripwire は最初に消される**。`tests/http-transport-tripwire.test.ts` と同じ判断）。
		expect(src, 'tryFormingDoubleTop が復活している（#268 案 C の決定に反する）').not.toContain(
			'function tryFormingDoubleTop',
		);
		expect(src, 'tryFormingDoubleBottom が復活している（#262 の決定に反する）').not.toContain(
			'function tryFormingDoubleBottom',
		);
	});
});
