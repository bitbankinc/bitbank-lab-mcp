// BTC/JPY 1hour / 4hour の triple 候補は、既存のネックライン側ゲートより先に先行トレンドを検証する（時間足別の横ばい閾値による方向判定と、完成済み triple の単調階段除外）。
import { describe, expect, it, vi } from 'vitest';

vi.mock('../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import { toolDef as detectPatternsTool } from '../src/handlers/detectPatternsHandler.js';
import analyzeIndicators from '../tools/analyze_indicators.js';
import detectPatterns from '../tools/detect_patterns.js';
import { asMockResult, assertOk } from './_assertResult.js';
import { buildBtcJpy1hour202608Candles } from './fixtures/btc_jpy_1hour_2026_08.js';

/** 実データ B（`btc_jpy` 1hour）を `analyze_indicators` の応答として 1 回分差し込む。 */
function mockCandles() {
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles: buildBtcJpy1hour202608Candles() } } }),
	);
}

async function runForming(tf = '1hour') {
	mockCandles();
	const res = await detectPatterns('btc_jpy', tf, 365, { includeForming: true });
	assertOk(res);
	return res;
}

describe('detect_patterns: triple の先行トレンド方向ゲート（実データ B）', () => {
	it('1hour の単調な triple_bottom は階段形状として除外される', async () => {
		mockCandles();
		const res = await detectPatterns('btc_jpy', '1hour', 365, {
			includeForming: true,
			view: 'debug',
			patterns: ['triple_bottom'],
		});
		assertOk(res);
		const tb = res.data.patterns.find((p) => p.type === 'triple_bottom');
		expect(tb).toBeUndefined();

		const meta = res.meta as { debug?: { candidates?: Array<Record<string, unknown>> } } | undefined;
		const candidates = meta?.debug?.candidates ?? [];
		expect(candidates.some((c) => c.type === 'triple_bottom' && c.reason === 'stair_step_down')).toBe(true);
	});

	it('4hour の forming triple_top は時間足別閾値で上昇先行として残る', async () => {
		const res = await runForming('4hour');
		const tt = res.data.patterns.find((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(tt?.precedingTrend?.direction).toBe('up');
	});

	// 消えたことだけでは理由が読めないので、313-331-364 がどの理由コードで落ちたかを固定する。
	it('1hour の forming triple_bottom は PR4 の先行トレンドゲートで落ちる', async () => {
		mockCandles();
		const res = await detectPatterns('btc_jpy', '1hour', 365, {
			includeForming: true,
			view: 'debug',
			patterns: ['triple_bottom'],
		});
		assertOk(res);
		expect(res.data.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'forming')).toHaveLength(0);

		const meta = res.meta as { debug?: { candidates?: Array<Record<string, unknown>> } } | undefined;
		const hit = (meta?.debug?.candidates ?? []).find(
			(c) =>
				c.reason === 'prior_trend_mismatch:sideways' && String((c.indices as number[])?.join('-')) === '313-331-364',
		);
		expect(hit).toBeDefined();
	});

	it('triple 以外の反転系の pivots 点数は従来どおり（完成済み H&S は 5 点、double は 3 点）', async () => {
		const res = await runForming();
		const lengths = res.data.patterns
			.filter((p) => p.status !== 'forming')
			.filter((p) => /head_and_shoulders|double_/.test(String(p.type)))
			.map((p) => `${p.type}:${(p.pivots ?? []).length}`);
		expect(lengths.length).toBeGreaterThan(0);
		expect(lengths.filter((l) => l.includes('head_and_shoulders')).every((l) => l.endsWith(':5'))).toBe(true);
		expect(lengths.filter((l) => l.startsWith('double_')).every((l) => l.endsWith(':3'))).toBe(true);
	});

	async function fullContent(tf: string): Promise<string> {
		mockCandles();
		const out = (await detectPatternsTool.handler({
			pair: 'btc_jpy',
			type: tf,
			limit: 365,
			includeForming: true,
			view: 'full',
		})) as { content: Array<{ text: string }> };
		return out.content[0].text;
	}

	it('content: 単調な triple_bottom は出力されない（1hour）', async () => {
		expect(await fullContent('1hour')).not.toContain('triple_bottom');
	});

	it('content: 方向性のある forming triple_top も出力される（4hour）', async () => {
		expect(await fullContent('4hour')).toContain('triple_top');
	});
});
