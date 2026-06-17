import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';

vi.mock('../lib/get-depth.js', () => ({
	default: vi.fn(),
}));

import getDepth from '../lib/get-depth.js';
import renderDepthSvg, { toolDef } from '../tools/render_depth_svg.js';

// ── ヘルパー ──

function depthOk(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		summary: 'depth ok',
		data: {
			asks: [
				['10100', '0.2'],
				['10200', '0.5'],
				['10300', '1.0'],
				['10400', '0.8'],
				['10500', '0.3'],
			],
			bids: [
				['9900', '0.3'],
				['9800', '0.6'],
				['9700', '1.2'],
				['9600', '0.5'],
				['9500', '0.4'],
			],
			...overrides,
		},
		meta: {},
	};
}

describe('render_depth_svg', () => {
	const mockedGetDepth = vi.mocked(getDepth);

	afterEach(() => vi.clearAllMocks());

	// ── スキーマ ─────────────────────────────────────────

	it('inputSchema: depth.levels < 10 を拒否', () => {
		expect(() => toolDef.inputSchema.parse({ pair: 'btc_jpy', depth: { levels: 9 } })).toThrow();
	});

	// ── 正常描画（inline） ───────────────────────────────

	it('正常データで SVG を inline 返却', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await renderDepthSvg({ pair: 'btc_jpy', type: '1day', depth: { levels: 200 } });
		assertOk(res);
		expect(res.data.svg).toContain('<svg');
		expect(res.data.svg).toContain('</svg>');
		expect(res.data.svg).toContain('Bids');
		expect(res.data.svg).toContain('Asks');
		expect(res.data.filePath).toBeUndefined();
		expect(res.meta.pair).toBe('btc_jpy');
		expect(res.meta.sizeBytes).toBeGreaterThan(0);
		expect(res.summary).toContain('rendered');
	});

	it('Y軸数量ラベルは pair の base 通貨を使う（eth_jpy → ETH、BTC を含まない）', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await renderDepthSvg({ pair: 'eth_jpy' });
		assertOk(res);
		// Y軸目盛りの <text>…N ETH</text>
		expect(res.data.svg).toMatch(/\d+ ETH<\/text>/);
		expect(res.data.svg).not.toContain('BTC');
	});

	it('SVG に板の深さヘッダー・買い売り比率・中央価格を含む', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await renderDepthSvg({ pair: 'btc_jpy' });
		assertOk(res);
		expect(res.data.svg).toContain('板の深さ');
		expect(res.data.svg).toContain('比率');
		// 中央価格ラベル
		expect(res.data.svg).toContain('¥');
	});

	it('summary に currentPrice / bestBid / bestAsk / ratio を含む', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await renderDepthSvg({ pair: 'btc_jpy' });
		assertOk(res);
		const s = res.data.summary;
		expect(s).toBeDefined();
		expect(s!.currentPrice).toBe(10000); // (9900+10100)/2
		expect(s!.bestBid).toBe(9900);
		expect(s!.bestAsk).toBe(10100);
		expect(s!.bidDepth).toBeGreaterThan(0);
		expect(s!.askDepth).toBeGreaterThan(0);
		expect(s!.ratio).toBeGreaterThan(0);
	});

	// ── ファイル保存 ─────────────────────────────────────

	it('preferFile=true でファイル保存', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await renderDepthSvg({ pair: 'btc_jpy', preferFile: true });
		assertOk(res);
		expect(res.data.filePath).toBeDefined();
		expect(res.data.filePath).toContain('depth-btc_jpy');
		expect(res.data.svg).toBeUndefined();
		expect(res.summary).toContain('saved');
	});

	it('autoSave=true でもファイル保存', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await renderDepthSvg({ pair: 'btc_jpy', autoSave: true });
		assertOk(res);
		expect(res.data.filePath).toBeDefined();
	});

	// ── エラー系 ─────────────────────────────────────────

	it('不正な pair → validation エラー', async () => {
		const res = await renderDepthSvg({ pair: 'invalid!!!' as never });
		assertFail(res);
	});

	it('getDepth 失敗 → fail 結果', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult({ ok: false, summary: 'Error: API error', meta: { errorType: 'api' } }),
		);
		const res = await renderDepthSvg({ pair: 'btc_jpy' });
		assertFail(res);
		expect(res.summary).toContain('API error');
	});

	it('asks/bids が空配列 → fail', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk({ asks: [], bids: [] })));
		const res = await renderDepthSvg({ pair: 'btc_jpy' });
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
	});

	it('asks が空で bids のみ → fail', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult(
				depthOk({
					asks: [],
					bids: [
						['100', '1.0'],
						['99', '2.0'],
					],
				}),
			),
		);
		const res = await renderDepthSvg({ pair: 'btc_jpy' });
		assertFail(res);
	});

	it('bids が空で asks のみ → fail', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult(
				depthOk({
					asks: [
						['101', '1.0'],
						['102', '2.0'],
					],
					bids: [],
				}),
			),
		);
		const res = await renderDepthSvg({ pair: 'btc_jpy' });
		assertFail(res);
	});

	// ── デフォルトパラメータ ──────────────────────────────

	it('引数なしでデフォルト（btc_jpy, 1day, 200レベル）が適用される', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await renderDepthSvg();
		assertOk(res);
		expect(res.meta.pair).toBe('btc_jpy');
		expect(res.meta.type).toBe('1day');
	});

	it('depth.levels でレベル数を指定', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		await renderDepthSvg({ pair: 'btc_jpy', depth: { levels: 50 } });
		// getDepth が指定レベルで呼ばれる
		expect(mockedGetDepth).toHaveBeenCalledWith('btc_jpy', { maxLevels: 50 });
	});

	it('depth.levels < 10 は 10 にクランプされる', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		await renderDepthSvg({ pair: 'btc_jpy', depth: { levels: 5 } });
		expect(mockedGetDepth).toHaveBeenCalledWith('btc_jpy', { maxLevels: 10 });
	});

	// ── SVG 構造検証 ─────────────────────────────────────

	it('SVG に Y軸目盛り（BTC）を含む', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await renderDepthSvg({ pair: 'btc_jpy' });
		assertOk(res);
		expect(res.data.svg).toContain('BTC');
	});

	it('SVG にプロットパス（bid/ask ライン）を含む', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await renderDepthSvg({ pair: 'btc_jpy' });
		assertOk(res);
		expect(res.data.svg).toContain('stroke="#10b981"'); // bid color
		expect(res.data.svg).toContain('stroke="#f97316"'); // ask color
	});

	it('SVG に中央線（dashed）を含む', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await renderDepthSvg({ pair: 'btc_jpy' });
		assertOk(res);
		expect(res.data.svg).toContain('stroke-dasharray="4 4"');
	});

	// ── toolDef.handler ──────────────────────────────────

	it('handler: inline SVG で content にチャートを含む', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day' })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content).toBeDefined();
		expect(res.content[0].text).toContain('Depth chart');
		expect(res.content[0].text).toContain('<svg');
	});

	it('handler: preferFile でファイルパスを content に含む', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', preferFile: true })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text).toContain('Saved');
		expect(res.content[0].text).toContain('computer://');
	});

	it('handler: getDepth 失敗時はそのまま返す', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult({ ok: false, summary: 'Error: fail', meta: { errorType: 'api' } }),
		);
		const res = (await toolDef.handler({ pair: 'btc_jpy' })) as { ok: boolean };
		expect(res.ok).toBe(false);
	});
});
