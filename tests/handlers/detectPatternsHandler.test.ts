import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../tools/detect_patterns.js', () => ({
	default: vi.fn(),
}));

import { toolDef } from '../../src/handlers/detectPatternsHandler.js';
import detectPatterns from '../../tools/detect_patterns.js';

const mockedDetectPatterns = vi.mocked(detectPatterns);

afterEach(() => {
	vi.clearAllMocks();
});

function makeFailResult() {
	return {
		ok: false,
		summary: 'network error',
		data: {},
		meta: { errorType: 'NETWORK', pair: 'btc_jpy', fetchedAt: '2025-01-01T00:00:00Z' },
	};
}

function makeOkResult(
	patterns: Array<{
		type: string;
		status?: 'forming' | 'near_completion' | 'completed' | 'invalid';
	}> = [],
) {
	const validPatterns = patterns.map((p) => ({
		type: p.type,
		confidence: 0.75,
		range: { start: '2025-01-01T00:00:00Z', end: '2025-03-01T00:00:00Z' },
		status: p.status ?? 'completed',
	}));

	return {
		ok: true,
		summary: `${validPatterns.length}件を検出`,
		data: {
			patterns: validPatterns,
		},
		meta: {
			pair: 'btc_jpy',
			type: '1day',
			count: validPatterns.length,
			fetchedAt: '2025-01-01T00:00:00Z',
		},
	};
}

describe('detectPatternsHandler', () => {
	it('不正な pair → ok:false を返す', async () => {
		const res = await toolDef.handler({
			pair: 'INVALID!!!',
			type: '1day',
			limit: 200,
		});
		expect((res as { ok?: boolean }).ok).toBe(false);
	});

	it('detectPatterns の結果 ok:false はそのまま返す', async () => {
		mockedDetectPatterns.mockResolvedValueOnce(makeFailResult() as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 90 });
		expect((res as { ok?: boolean }).ok).toBe(false);
	});

	it('view=detailed（デフォルト）で content テキストに件数が含まれる', async () => {
		mockedDetectPatterns.mockResolvedValueOnce(
			makeOkResult([{ type: 'double_top' }, { type: 'head_and_shoulders' }]) as never,
		);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 90 });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('2件を検出');
	});

	it('view=summary で content テキストに件数が含まれる', async () => {
		mockedDetectPatterns.mockResolvedValueOnce(makeOkResult([{ type: 'triangle_ascending' }]) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 90, view: 'summary' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('1件を検出');
	});

	it('view=full で content テキストに件数が含まれる', async () => {
		mockedDetectPatterns.mockResolvedValueOnce(makeOkResult([{ type: 'falling_wedge' }]) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 90, view: 'full' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('1件を検出');
	});

	it('view=debug で content テキストに件数が含まれる', async () => {
		mockedDetectPatterns.mockResolvedValueOnce(makeOkResult([]) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 90, view: 'debug' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('0件を検出');
	});

	it('content テキストにペア名が大文字で含まれる', async () => {
		mockedDetectPatterns.mockResolvedValueOnce(makeOkResult() as never);
		const res = await toolDef.handler({ pair: 'eth_jpy', type: '1day', limit: 90 });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('ETH_JPY');
	});

	it('パターンが0件でも正常に動作する', async () => {
		mockedDetectPatterns.mockResolvedValueOnce(makeOkResult([]) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 90 });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('0件を検出');
	});
});
