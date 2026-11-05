import { describe, expect, it, vi } from 'vitest';

vi.mock('../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../tools/analyze_indicators.js';
import detectPatterns from '../tools/detect_patterns.js';
import { asMockResult, assertOk } from './_assertResult.js';
import { buildBtcJpy1hour202608Candles } from './fixtures/btc_jpy_1hour_2026_08.js';

describe('detect_patterns: 構造図の identifier', () => {
	it('同じ日に始まる同種のパターンが並んでも、結果の中で identifier がぶつからない', async () => {
		// 1hour の実データで、2026-08-21 に始まる H&S が 2 つ（完成と形成中）出る。
		const candles = buildBtcJpy1hour202608Candles();
		vi.mocked(analyzeIndicators).mockResolvedValueOnce(
			asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
		);

		const res = await detectPatterns('btc_jpy', '1hour', 365, { includeForming: true });
		assertOk(res);

		const ids = res.data.patterns.flatMap((p) => {
			const id = (p as { structureDiagram?: { artifact?: { identifier?: string } } }).structureDiagram?.artifact
				?.identifier;
			return id ? [id] : [];
		});
		expect(ids).toEqual(['head_and_shoulders-diagram-2026-08-21', 'head_and_shoulders-diagram-2026-08-21-2']);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
