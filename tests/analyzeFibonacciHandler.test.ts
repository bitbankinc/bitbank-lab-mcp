import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail } from '../lib/result.js';

vi.mock('../tools/analyze_fibonacci.js', () => ({ default: vi.fn() }));

import { toolDef } from '../src/handlers/analyzeFibonacciHandler.js';
import analyzeFibonacci from '../tools/analyze_fibonacci.js';

const mockedAnalyzeFibonacci = vi.mocked(analyzeFibonacci);

function okMinimal() {
	// content / levelStats を省略し、handler のフォールバック分岐（'' / []）を踏む。
	return {
		ok: true as const,
		summary: 'BTC/JPY フィボナッチ分析',
		data: {
			pair: 'btc_jpy',
			timeframe: '1day',
			currentPrice: 100,
			trend: 'up' as const,
			swingHigh: { price: 120, date: '2026-01-01', index: 10 },
			swingLow: { price: 80, date: '2025-12-01', index: 2 },
			range: 40,
			levels: [],
			extensions: [],
			position: { aboveLevel: null, belowLevel: null, nearestLevel: null },
		},
		meta: {
			pair: 'btc_jpy',
			fetchedAt: '2026-01-01T00:00:00.000Z',
			timeframe: '1day',
			lookbackDays: 90,
			mode: 'swing',
		},
	};
}

describe('analyzeFibonacciHandler', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('content / levelStats が無い ok 結果はフォールバック（空文字 / 空配列）で返す', async () => {
		mockedAnalyzeFibonacci.mockResolvedValueOnce(okMinimal() as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy' })) as unknown as {
			content: Array<{ text: string }>;
			structuredContent: { data: { levelStats: unknown[]; levels: unknown[] }; summary: string };
		};
		expect(res.content[0].text).toBe('');
		expect(res.structuredContent.data.levelStats).toEqual([]);
		expect(res.structuredContent.data.levels).toEqual([]);
		expect(res.structuredContent.summary).toBe('BTC/JPY フィボナッチ分析');
	});

	it('fail はそのまま返す', async () => {
		mockedAnalyzeFibonacci.mockResolvedValueOnce(fail('upstream error', 'upstream') as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy' })) as { ok: boolean };
		expect(res.ok).toBe(false);
	});
});
