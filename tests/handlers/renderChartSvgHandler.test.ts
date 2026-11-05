import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../tools/render_chart_svg.js', () => ({
	default: vi.fn(),
}));

import { toolDef } from '../../src/handlers/renderChartSvgHandler.js';
import renderChartSvg from '../../tools/render_chart_svg.js';

const mockedRenderChartSvg = vi.mocked(renderChartSvg);

afterEach(() => {
	vi.clearAllMocks();
});

function makeSvgResult(opts: {
	svg?: string;
	pair?: string;
	type?: string;
	range?: { start: string; end: string };
	indicators?: string[];
	legend?: Record<string, string>;
}) {
	return {
		ok: true,
		summary: 'chart ok',
		data: {
			svg: opts.svg ?? '<svg><rect/></svg>',
			legend: opts.legend ?? {},
		},
		meta: {
			pair: opts.pair ?? 'btc_jpy',
			type: opts.type ?? '1day',
			range: opts.range,
			indicators: opts.indicators,
			identifier: 'test-id',
			title: 'BTC 1day chart',
		},
	};
}

describe('renderChartSvgHandler', () => {
	it('不正な pair → ensurePair が失敗して ok:false を返す', async () => {
		const res = await toolDef.handler({ pair: 'INVALID!!!', type: '1day' });
		expect((res as { ok?: boolean }).ok).toBe(false);
	});

	it('SVG がある場合 content テキストに --- Chart SVG --- ブロックが含まれる', async () => {
		mockedRenderChartSvg.mockResolvedValueOnce(makeSvgResult({}) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('--- Chart SVG ---');
		expect(text).toContain('<svg>');
	});

	it('SVG がない場合 summary テキストだけ返す', async () => {
		const noSvgResult = {
			ok: true,
			summary: 'chart rendered (no svg)',
			data: {},
			meta: { pair: 'btc_jpy', type: '1day' },
		};
		mockedRenderChartSvg.mockResolvedValueOnce(noSvgResult as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).not.toContain('--- Chart SVG ---');
		expect(text).toContain('chart rendered');
	});

	it('structuredContent に ARTIFACT_REQUIRED ヒントが含まれる（SVG あり）', async () => {
		mockedRenderChartSvg.mockResolvedValueOnce(makeSvgResult({}) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const sc = (res as { structuredContent: Record<string, unknown> }).structuredContent;
		const hint = sc.artifactHint as Record<string, unknown>;
		expect(hint?.renderHint).toBe('ARTIFACT_REQUIRED');
		expect(hint?.displayType).toBe('image/svg+xml');
	});

	it('content テキストにペア名・タイムフレームが含まれる', async () => {
		mockedRenderChartSvg.mockResolvedValueOnce(makeSvgResult({ pair: 'eth_jpy', type: '4hour' }) as never);
		const res = await toolDef.handler({ pair: 'eth_jpy', type: '4hour' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('ETH_JPY');
		expect(text).toContain('4hour');
	});

	it('range メタが含まれている場合 content に Period: が出る', async () => {
		mockedRenderChartSvg.mockResolvedValueOnce(
			makeSvgResult({ range: { start: '2025-01-01', end: '2025-03-01' } }) as never,
		);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('Period:');
		expect(text).toContain('2025-01-01');
	});

	it('indicators メタが含まれている場合 content に Indicators: が出る', async () => {
		mockedRenderChartSvg.mockResolvedValueOnce(makeSvgResult({ indicators: ['SMA_25', 'BB'] }) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('Indicators: SMA_25, BB');
	});

	it('legend がある場合 content に legend 情報が出る', async () => {
		mockedRenderChartSvg.mockResolvedValueOnce(
			makeSvgResult({ legend: { SMA_25: '9500000', BB_upper: '10500000' } }) as never,
		);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('SMA_25');
		expect(text).toContain('BB_upper');
	});
});
