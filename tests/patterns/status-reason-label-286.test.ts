// 同じ窓で反転系（`double_top` の `peak_after_last_pivot`）と継続系（`triangle_ascending` の `breakout_against_expectation`）が反対の主張をするので、状態行は type ごとのブロックに切って見る（#286 / #291）。
// `includeInvalid: true` が要るのは、既定 `swingDepth`（1hour = 3）で経路ゲートが `peak_after_last_pivot` を立てて、既定では `data.patterns` から消えるため。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult } from '../_assertResult.js';
import { detectPatternsContent } from '../helpers/detect-patterns.js';

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

function liveWindowContent(view: string): Promise<string> {
	const { start, end } = BTC_JPY_1HOUR_2026_09_05_ISSUE_WINDOW;
	return detectPatternsContent(buildBtcJpy1hour20260905Candles().slice(start, end), { view, includeInvalid: true });
}

/** `text.split('\n').filter(状態行)` で全件をまとめて見ると、継続系の正しい「期待と逆方向にブレイク」と反転系の誤表示（#286）を区別できない（この窓には両方が同居している）。 */
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
	// `formatPatternLine` を呼ぶのは階梯上の 2 view（`summary` は明細を列挙せず、`debug` は階梯外で明細を出さない）。
	for (const view of ['detailed', 'full'] as const) {
		it(`view=${view}: double_top の状態行が理由コードを併記する`, async () => {
			const text = await liveWindowContent(view);
			expect(text).toContain('double_top');
			expect(text).toContain('   - 状態: 無効（山2 の後に別の山を作ってから割った: peak_after_last_pivot）');
		});

		// 語の有無（`not.toContain('逆方向')`）では、ターゲット行の「走査窓内に逆方向のブレイクあり」や継続系の正しい表示を誤検出するので、`double_top` のブロックの状態行を名指しで見る。
		it(`view=${view}: double_top の状態行が「期待と逆方向にブレイク」と言わない（旧実装の誤表示）`, async () => {
			const text = await liveWindowContent(view);
			const line = statusLineOf(text, 'double_top');
			expect(line).not.toContain('期待と逆方向にブレイク');
			expect(line).not.toContain('逆方向');
		});
	}
});

describe('#291 継続系の invalid（実データ D の同じ窓の triangle_ascending）', () => {
	for (const view of ['detailed', 'full'] as const) {
		it(`view=${view}: triangle_ascending の状態行が理由コードを併記する`, async () => {
			const text = await liveWindowContent(view);
			expect(statusLineOf(text, 'triangle_ascending')).toBe(
				'   - 状態: 無効（期待と逆方向にブレイク: breakout_against_expectation）',
			);
		});

		// 方向の具体値は状態行が持たない。2 行はそのまま残す（#291 決定事項）。
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

	// 同じ窓の `triangle_descending`（上方ブレイク）も同じコードを名乗る。継続系の `invalid` は方向によらず 1 条件なので、コードは向きで分かれない。
	it('triangle_descending（逆向き）も同じコードを名乗る', async () => {
		const patterns = await liveWindowPatterns();
		expect(patterns.find((p) => p.type === 'triangle_descending')).toMatchObject({
			status: 'invalid',
			invalidReason: 'breakout_against_expectation',
			breakoutDirection: 'up',
		});
	});

	it('invalidReason は invalid 状態の entry にだけ付く', async () => {
		const patterns = await liveWindowPatterns();
		expect(patterns.length).toBeGreaterThan(0);
		for (const p of patterns.filter((row) => row.status === 'invalid')) expect(p.invalidReason).toBeDefined();
		for (const p of patterns.filter((row) => row.status !== 'invalid'))
			expect(p.invalidReason, String(p.type)).toBeUndefined();
	});
});
