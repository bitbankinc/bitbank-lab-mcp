/**
 * tests/patterns/status-reason-label-286.test.ts
 *
 * issue #286 — `detect_patterns` の content の状態行を `status` × 理由コードで出す件の、
 * **実データによる固定**。
 *
 * 合成データでの網羅（5 つの理由コード × 種別、未知コード、`near_completion` の系統分け、
 * `expired` のラベル）は `tests/detectPatternsViewsHandler.test.ts` の
 * 「状態行: status × 理由コードの網羅」が持つ。本ファイルが押さえるのは実データ D の
 * `limit=72` 窓に同居する 2 件:
 *
 * 1. **#242 / #245 の発端の形**——`invalidReason: 'peak_after_last_pivot'` の `double_top` の
 *    状態行が理由コードを併記し、「逆方向」と言わないこと（#286）。
 * 2. 同じ窓の `triangle_ascending` の `invalid`——継続系の状態行が
 *    `breakout_against_expectation` を併記すること（#291）。**#286 で消した
 *    「期待と逆方向にブレイク」は継続系に限っては正しい**ので、1. と 2. は同じ窓で
 *    反対の主張をする。だから状態行は type ごとのブロックに切って見る（{@link patternBlock}）。
 *
 * これが実機（Claude Desktop / 2026-09-11）で起きた誤表示そのもの——この構造の下方ブレイクは
 * `double_top` の**期待どおりの方向**なのに、旧実装は `status='invalid'` を理由を問わず
 * 「無効（期待と逆方向にブレイク）」と書いており、LLM がそのまま誤って説明した。
 * 「期待と逆方向にブレイク」に対応する理由コードは検出器に 1 つも存在しない。
 *
 * 窓の切り出しと既定 `swingDepth`（1hour = 3）で経路ゲートが `peak_after_last_pivot` を
 * 立てる理由は `tests/patterns/breakout-path-double.test.ts`（issue #251 案 3）が仕様として
 * 固定している。`includeInvalid: true` が要るのはそのためで、既定では `data.patterns` から消える。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import { toolDef as detectPatternsTool } from '../../src/handlers/detectPatternsHandler.js';
import analyzeIndicators from '../../tools/analyze_indicators.js';
import type { PatternEntry } from '../../tools/patterns/types.js';
import {
	BTC_JPY_1HOUR_2026_09_05_ISSUE_WINDOW,
	buildBtcJpy1hour20260905Candles,
} from '../fixtures/btc_jpy_1hour_2026_09_05.js';

afterEach(() => {
	vi.restoreAllMocks();
});

/** 実データ D の `limit=72` 窓を既定 `swingDepth` + `includeInvalid: true` で流す。 */
async function liveWindowContent(view: string): Promise<string> {
	const { start, end } = BTC_JPY_1HOUR_2026_09_05_ISSUE_WINDOW;
	const candles = buildBtcJpy1hour20260905Candles().slice(start, end);
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = (await detectPatternsTool.handler({
		pair: 'btc_jpy',
		type: '1hour',
		limit: candles.length,
		view,
		includeInvalid: true,
	})) as { content?: Array<{ text?: string }> };
	const text = res?.content?.[0]?.text;
	// **`?? ''` で畳まない。** 空文字に落とすと `not.toContain` 側が
	// 「ハンドラが content を返さなかった」ときにも通ってしまう。
	if (typeof text !== 'string') throw new Error(`view=${view} の content[0].text が取れない`);
	return text;
}

/**
 * content の明細を「`N. <type> (パターン整合度: …)`」の見出しで 1 件ずつに切り分け、
 * 指定 type のブロックの行を返す。
 *
 * **状態行を type に紐付けて見るために要る。** `text.split('\n').filter(状態行)` で
 * 全件をまとめて見ると、issue #291 で継続系の状態行が
 * 「期待と逆方向にブレイク」を**正しい意味で**名乗るようになった時点で、
 * 反転系の誤表示（#286）と区別できなくなる（この窓には両方が同居している）。
 */
function patternBlock(text: string, type: string): string[] {
	const lines = text.split('\n');
	const headIdx = lines.findIndex((l) => new RegExp(`^\\d+\\. ${type} \\(`, 'u').test(l));
	if (headIdx === -1) throw new Error(`${type} の明細ブロックが content に無い`);
	const rest = lines.slice(headIdx + 1);
	const nextIdx = rest.findIndex((l) => /^\d+\. \S+ \(/u.test(l));
	return [lines[headIdx], ...(nextIdx === -1 ? rest : rest.slice(0, nextIdx))];
}

/** ブロック内の状態行（`   - 状態: …`）。1 件につき 1 行しか出ない。 */
function statusLineOf(text: string, type: string): string {
	const hits = patternBlock(text, type).filter((l) => l.startsWith('   - 状態: '));
	expect(hits, `${type} の状態行`).toHaveLength(1);
	return hits[0];
}

/** 同じ窓の `structuredContent.data.patterns`（表示層を通さない生の entry を見るため）。 */
async function liveWindowPatterns(): Promise<PatternEntry[]> {
	const { start, end } = BTC_JPY_1HOUR_2026_09_05_ISSUE_WINDOW;
	const candles = buildBtcJpy1hour20260905Candles().slice(start, end);
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = (await detectPatternsTool.handler({
		pair: 'btc_jpy',
		type: '1hour',
		limit: candles.length,
		view: 'detailed',
		includeInvalid: true,
	})) as { structuredContent?: { data?: { patterns?: PatternEntry[] } } };
	const patterns = res?.structuredContent?.data?.patterns;
	if (!Array.isArray(patterns)) throw new Error('structuredContent.data.patterns が取れない');
	return patterns;
}

describe('#286 の発端の形（実データ D の limit=72 窓 / 既定 swingDepth / includeInvalid）', () => {
	// `formatPatternLine` を呼ぶのは階梯上の 2 view（`summary` は明細を列挙せず、
	// `debug` は階梯外で明細を出さない）。
	for (const view of ['detailed', 'full'] as const) {
		it(`view=${view}: double_top の状態行が理由コードを併記する`, async () => {
			const text = await liveWindowContent(view);
			expect(text).toContain('double_top');
			expect(text).toContain('   - 状態: 無効（山2 の後に別の山を作ってから割った: peak_after_last_pivot）');
		});

		// **旧実装の誤表示そのものを名指しで禁じる。** 初版は `not.toContain('逆方向')` と
		// 語だけで見ていたが、issue #288 Phase 2 でターゲット行が
		// 「走査窓内に逆方向のブレイクあり」を**正しい意味で**使うようになり、
		// 語の有無では状態行の誤表示を分離できなくなった（この窓では実際に交絡が付く）。
		//
		// issue #291 で継続系の状態行が「期待と逆方向にブレイク」を**正しい意味で**名乗るように
		// なったので、対象を `double_top` のブロックに絞る。全状態行を一括で見る書き方は
		// 継続系の正しい表示を誤検出する。
		it(`view=${view}: double_top の状態行が「期待と逆方向にブレイク」と言わない（旧実装の誤表示）`, async () => {
			const text = await liveWindowContent(view);
			const line = statusLineOf(text, 'double_top');
			expect(line).not.toContain('期待と逆方向にブレイク');
			expect(line).not.toContain('逆方向');
		});
	}
});

/**
 * issue #291 — 同じ窓の `triangle_ascending` の `invalid`。
 *
 * この entry は #242 の回帰テスト（`tests/patterns/breakout-path-double.test.ts` の
 * 「`includeInvalid: true` で `peak_after_last_pivot` として出て、`triangle_ascending` invalid は残る」）
 * が既に居ることを固定している。#286 の時点では検出器が理由コードを出しておらず、
 * 状態行が**裸の「無効」**になっていた（修正前の実出力: `   - 状態: 無効`）。
 */
describe('#291 継続系の invalid（実データ D の同じ窓の triangle_ascending）', () => {
	for (const view of ['detailed', 'full'] as const) {
		it(`view=${view}: triangle_ascending の状態行が理由コードを併記する`, async () => {
			const text = await liveWindowContent(view);
			expect(statusLineOf(text, 'triangle_ascending')).toBe(
				'   - 状態: 無効（期待と逆方向にブレイク: breakout_against_expectation）',
			);
		});

		// 方向の具体値は状態行が持たない。**2 行はそのまま残す**（#291 決定事項）。
		it(`view=${view}: 「ブレイク方向」「パターン結果」の 2 行が従来どおり残る`, async () => {
			const block = patternBlock(await liveWindowContent(view), 'triangle_ascending');
			expect(block).toContain('   - ブレイク方向: 下方ブレイク（本来は上方ブレイクが期待されるパターン）');
			expect(block).toContain('   - パターン結果: 失敗（下方ブレイク（弱気転換））');
		});
	}

	it('structuredContent の triangle_ascending invalid に invalidReason が付く（status / outcome は不変）', async () => {
		const patterns = await liveWindowPatterns();
		const hit = patterns.find((p) => p.type === 'triangle_ascending');
		expect(hit).toMatchObject({
			status: 'invalid',
			invalidReason: 'breakout_against_expectation',
			breakoutDirection: 'down',
			outcome: 'failure',
		});
	});

	// 同じ窓の `triangle_descending`（上方ブレイク）も同じコードを名乗る——継続系の
	// `invalid` は方向によらず 1 条件なので、コードは向きで分かれない。
	it('triangle_descending（逆向き）も同じコードを名乗る', async () => {
		const patterns = await liveWindowPatterns();
		expect(patterns.find((p) => p.type === 'triangle_descending')).toMatchObject({
			status: 'invalid',
			invalidReason: 'breakout_against_expectation',
			breakoutDirection: 'up',
		});
	});

	// `completed` の継続系には付かない（`invalid` 限定の additive な付与であること）。
	it('completed / その他の status には invalidReason が付かない', async () => {
		const patterns = await liveWindowPatterns();
		const nonInvalid = patterns.filter((p) => p.status !== 'invalid');
		expect(nonInvalid.length).toBeGreaterThan(0);
		for (const p of nonInvalid) expect(p.invalidReason, String(p.type)).toBeUndefined();
	});
});
