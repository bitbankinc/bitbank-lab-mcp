import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../tools/trading_process/index.js', () => ({
	runBacktest: vi.fn(),
}));

import { toolDef } from '../../src/handlers/runBacktestHandler.js';
import { runBacktest } from '../../tools/trading_process/index.js';
import { asMcp } from '../helpers/mcp.js';

const mockedRunBacktest = vi.mocked(runBacktest);

afterEach(() => {
	vi.clearAllMocks();
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeOkResult(opts: { svg?: string; summary?: string } = {}) {
	return {
		ok: true,
		summary: opts.summary ?? 'バックテスト完了 トレード数: 10',
		svg: opts.svg,
		data: {
			input: {
				pair: 'btc_jpy',
				timeframe: '1day',
				period: '3M',
				strategy: { type: 'sma_cross', params: {} },
			},
			summary: {
				totalReturn: 0.15,
				winRate: 0.6,
				maxDrawdown: -0.08,
				sharpeRatio: 1.2,
			},
			trades: Array.from({ length: 10 }, (_, i) => ({ id: i })),
		},
	};
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('runBacktestHandler', () => {
	it('エラー時に content テキストに Error: が含まれる', async () => {
		mockedRunBacktest.mockResolvedValueOnce({
			ok: false,
			error: 'Unknown strategy',
			availableStrategies: ['sma_cross', 'rsi', 'macd_cross', 'bb_breakout'],
		} as never);
		const res = await toolDef.handler({
			pair: 'btc_jpy',
			strategy: { type: 'sma_cross' },
			timeframe: '1D',
			period: '1M',
		});
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('Error:');
		expect(text).toContain('Unknown strategy');
	});

	it('エラー時に availableStrategies が含まれる', async () => {
		mockedRunBacktest.mockResolvedValueOnce({
			ok: false,
			error: 'Unknown strategy',
			availableStrategies: ['sma_cross', 'rsi', 'macd_cross', 'bb_breakout'],
		} as never);
		const res = await toolDef.handler({
			pair: 'btc_jpy',
			strategy: { type: 'sma_cross' },
			timeframe: '1D',
			period: '1M',
		});
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('Available strategies');
		expect(text).toContain('sma_cross');
	});

	it('成功時（SVG なし）: content テキストに summary が含まれる', async () => {
		mockedRunBacktest.mockResolvedValueOnce(makeOkResult() as never);
		const res = await toolDef.handler({
			pair: 'btc_jpy',
			strategy: { type: 'sma_cross' },
			timeframe: '1D',
			period: '3M',
		});
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('バックテスト完了');
	});

	it('成功時（SVG あり）: content に --- Backtest Chart (SVG) --- が含まれる', async () => {
		mockedRunBacktest.mockResolvedValueOnce(makeOkResult({ svg: '<svg><polyline/></svg>' }) as never);
		const res = await toolDef.handler({
			pair: 'btc_jpy',
			strategy: { type: 'sma_cross' },
			timeframe: '1D',
			period: '3M',
		});
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('--- Backtest Chart (SVG) ---');
		expect(text).toContain('<svg>');
	});

	it('成功時（SVG あり）: structuredContent に ARTIFACT_REQUIRED ヒントが含まれる', async () => {
		mockedRunBacktest.mockResolvedValueOnce(makeOkResult({ svg: '<svg><polyline/></svg>' }) as never);
		const res = await toolDef.handler({
			pair: 'btc_jpy',
			strategy: { type: 'sma_cross' },
			timeframe: '1D',
			period: '3M',
		});
		const sc = asMcp<Record<string, unknown>>(res).structuredContent;
		const hint = sc.artifactHint as Record<string, unknown>;
		expect(hint?.renderHint).toBe('ARTIFACT_REQUIRED');
		expect(hint?.displayType).toBe('image/svg+xml');
	});

	it('成功時（SVG なし）: structuredContent の artifactHint が undefined', async () => {
		mockedRunBacktest.mockResolvedValueOnce(makeOkResult() as never);
		const res = await toolDef.handler({
			pair: 'btc_jpy',
			strategy: { type: 'sma_cross' },
			timeframe: '1D',
			period: '3M',
		});
		const sc = asMcp<Record<string, unknown>>(res).structuredContent;
		expect(sc.artifactHint).toBeUndefined();
	});

	it('structuredContent の data に trade_count が含まれる', async () => {
		mockedRunBacktest.mockResolvedValueOnce(makeOkResult() as never);
		const res = await toolDef.handler({
			pair: 'btc_jpy',
			strategy: { type: 'sma_cross' },
			timeframe: '1D',
			period: '3M',
		});
		const sc = asMcp<{ data: { trade_count: number } }>(res).structuredContent;
		expect(sc.data.trade_count).toBe(10);
	});
});
