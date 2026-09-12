import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../tools/analyze_fibonacci.js', () => ({
	default: vi.fn(),
}));

import { toolDef } from '../../src/handlers/analyzeFibonacciHandler.js';
import analyzeFibonacci from '../../tools/analyze_fibonacci.js';
import { asMcp } from '../helpers/mcp.js';

const mockedAnalyzeFibonacci = vi.mocked(analyzeFibonacci);

afterEach(() => {
	vi.clearAllMocks();
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeFailResult() {
	return {
		ok: false,
		summary: 'insufficient data',
		data: {},
		meta: { errorType: 'INSUFFICIENT_DATA', pair: 'btc_jpy', fetchedAt: '2025-01-01T00:00:00Z' },
	};
}

function makeLevel(ratio: number, price: number) {
	return { ratio, price, distancePct: 0.05, isNearest: false };
}

function makeOkResult(opts: { trend?: 'up' | 'down' } = {}) {
	return {
		ok: true,
		summary: 'btc_jpy フィボナッチ分析',
		content: [
			{
				type: 'text',
				text: 'BTC_JPY フィボナッチ分析結果\nスイング高値: 12,000,000\nスイング安値: 8,000,000',
			},
		],
		data: {
			pair: 'btc_jpy',
			timeframe: '1day',
			currentPrice: 10_000_000,
			trend: opts.trend ?? 'up',
			swingHigh: { price: 12_000_000, date: '2025-01-15', index: 100 },
			swingLow: { price: 8_000_000, date: '2024-12-01', index: 80 },
			range: 4_000_000,
			levels: [makeLevel(0.382, 10_472_000), makeLevel(0.618, 9_528_000)],
			extensions: [makeLevel(1.272, 13_088_000)],
			position: {
				aboveLevel: null,
				belowLevel: null,
				nearestLevel: null,
			},
		},
		meta: {
			pair: 'btc_jpy',
			timeframe: '1day',
			lookbackDays: 90,
			mode: 'auto',
			fetchedAt: '2025-01-01T00:00:00Z',
		},
	};
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('analyzeFibonacciHandler', () => {
	it('analyze_fibonacci の ok:false はそのまま返す', async () => {
		mockedAnalyzeFibonacci.mockResolvedValueOnce(makeFailResult() as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		expect((res as { ok?: boolean }).ok).toBe(false);
	});

	it('成功時: content テキストにツールの出力テキストが含まれる', async () => {
		mockedAnalyzeFibonacci.mockResolvedValueOnce(makeOkResult() as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('フィボナッチ分析結果');
	});

	it('structuredContent に ok:true と type=fibonacci が含まれる', async () => {
		mockedAnalyzeFibonacci.mockResolvedValueOnce(makeOkResult() as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const sc = asMcp<Record<string, unknown>>(res).structuredContent;
		expect(sc.ok).toBe(true);
		expect(sc.type).toBe('fibonacci');
	});

	it('structuredContent に data フィールドが含まれる', async () => {
		mockedAnalyzeFibonacci.mockResolvedValueOnce(makeOkResult() as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const sc = asMcp<{ data: Record<string, unknown> }>(res).structuredContent;
		expect(sc.data).toHaveProperty('pair');
		expect(sc.data).toHaveProperty('levels');
		expect(sc.data).toHaveProperty('extensions');
		expect(sc.data).toHaveProperty('swingHigh');
		expect(sc.data).toHaveProperty('swingLow');
	});

	it('structuredContent の data.levels が配列', async () => {
		mockedAnalyzeFibonacci.mockResolvedValueOnce(makeOkResult() as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const sc = asMcp<{ data: { levels: unknown[] } }>(res).structuredContent;
		expect(Array.isArray(sc.data.levels)).toBe(true);
		expect(sc.data.levels).toHaveLength(2);
	});

	it('structuredContent の data.extensions が配列', async () => {
		mockedAnalyzeFibonacci.mockResolvedValueOnce(makeOkResult() as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const sc = asMcp<{ data: { extensions: unknown[] } }>(res).structuredContent;
		expect(Array.isArray(sc.data.extensions)).toBe(true);
		expect(sc.data.extensions).toHaveLength(1);
	});

	it('downtrend の場合も structuredContent に trend が含まれる', async () => {
		mockedAnalyzeFibonacci.mockResolvedValueOnce(makeOkResult({ trend: 'down' }) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const sc = asMcp<{ data: { trend: string } }>(res).structuredContent;
		expect(sc.data.trend).toBe('down');
	});

	it('summary が structuredContent に含まれる', async () => {
		mockedAnalyzeFibonacci.mockResolvedValueOnce(makeOkResult() as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const sc = asMcp<{ summary: string }>(res).structuredContent;
		expect(typeof sc.summary).toBe('string');
		expect(sc.summary.length).toBeGreaterThan(0);
	});

	it('tool 側 content に prepend された warning が handler の content[0].text に保たれる', async () => {
		const okResult = makeOkResult();
		okResult.content[0].text = `⚠️ 3日中1日の取得に失敗\n${okResult.content[0].text}`;
		okResult.summary = `⚠️ 3日中1日の取得に失敗\n${okResult.summary}`;
		(okResult.meta as Record<string, unknown>).warning = '⚠️ 3日中1日の取得に失敗';

		mockedAnalyzeFibonacci.mockResolvedValueOnce(okResult as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text.startsWith('⚠️ 3日中1日の取得に失敗')).toBe(true);

		const sc = asMcp<{ meta: Record<string, unknown>; summary: string }>(res).structuredContent;
		expect(sc.meta.warning).toBe('⚠️ 3日中1日の取得に失敗');
		expect(sc.summary.startsWith('⚠️ 3日中1日の取得に失敗')).toBe(true);
	});
});
