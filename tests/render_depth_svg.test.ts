import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';
import { requireDefined } from './helpers/assert.js';

vi.mock('../lib/get-depth.js', () => ({
	default: vi.fn(),
}));

import getDepth from '../lib/get-depth.js';
import renderDepthSvg, { toolDef } from '../tools/render_depth_svg.js';

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

function yAxisTicks(svg: string): Array<{ y: number; label: string }> {
	return [
		...svg.matchAll(
			/<text x="56" y="(-?[\d.]+)" text-anchor="end" dominant-baseline="middle" fill="#e5e7eb" font-size="10">([^<]+)<\/text>/g,
		),
	].map((m) => ({ y: Number(m[1]), label: m[2] }));
}

describe('render_depth_svg', () => {
	const mockedGetDepth = vi.mocked(getDepth);

	afterEach(() => vi.clearAllMocks());

	it('inputSchema: depth.levels < 10 を拒否', () => {
		expect(() => toolDef.inputSchema.parse({ pair: 'btc_jpy', depth: { levels: 9 } })).toThrow();
	});

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
		expect(res.data.svg).toContain('¥');
	});

	it('summary に currentPrice / bestBid / bestAsk / ratio を含む', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await renderDepthSvg({ pair: 'btc_jpy' });
		assertOk(res);
		const s = res.data.summary;
		expect(s).toBeDefined();
		expect(requireDefined(s, 's').currentPrice).toBe(10000); // (9900+10100)/2
		expect(requireDefined(s, 's').bestBid).toBe(9900);
		expect(requireDefined(s, 's').bestAsk).toBe(10100);
		expect(requireDefined(s, 's').bidDepth).toBeGreaterThan(0);
		expect(requireDefined(s, 's').askDepth).toBeGreaterThan(0);
		expect(requireDefined(s, 's').ratio).toBeGreaterThan(0);
	});

	it('安いペア（0.0001 円刻み）: 価格を円の整数に潰さず、横軸も板の幅いっぱいに描く', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult(
				depthOk({
					asks: [
						['31.2347', '1000'],
						['31.2500', '2000'],
						['31.3000', '3000'],
					],
					bids: [
						['31.2345', '1500'],
						['31.2000', '2500'],
						['31.1500', '3500'],
					],
				}),
			),
		);
		const res = await renderDepthSvg({ pair: 'doge_jpy' });
		assertOk(res);
		const s = requireDefined(res.data.summary, 's');
		expect(s.currentPrice).toBe(31.2346);
		expect(s.bestBid).toBe(31.2345);
		expect(s.bestAsk).toBe(31.2347);
		const svg = requireDefined(res.data.svg, 'svg');
		expect(svg).toContain('>¥31.2346</text>');
		// 横軸の目盛り（左端 = 最安の買い 31.15、右端 = 最高の売り 31.30）
		const ticks = [
			...svg.matchAll(
				/<text x="([\d.]+)" y="[\d.]+" text-anchor="(middle|end)" fill="#e5e7eb" font-size="10">¥([^<]+)<\/text>/g,
			),
		];
		expect(ticks.map((m) => m[3])).toEqual(['31.15', '31.19', '31.23', '31.26', '31.3']);
		expect(Number(ticks.at(-1)?.[1]) - Number(ticks[0]?.[1])).toBeCloseTo(784, 0);
		// 右端の目盛りだけ右ぞろえにして、右の余白からはみ出さないようにする
		expect(ticks.map((m) => m[2])).toEqual(['middle', 'middle', 'middle', 'middle', 'end']);
	});

	it('数量軸の目盛りはプロット領域の中に収める（最大の数量より上に目盛りを出さない）', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await renderDepthSvg({ pair: 'btc_jpy' });
		assertOk(res);
		const ticks = yAxisTicks(requireDefined(res.data.svg, 'svg'));
		expect(ticks.map((t) => t.label)).toEqual(['0 BTC', '0.5 BTC', '1 BTC', '1.5 BTC', '2 BTC', '2.5 BTC', '3 BTC']);
		// プロット領域の上端は padding.top = 84
		for (const t of ticks) expect(t.y).toBeGreaterThanOrEqual(84);
	});

	it('最大の数量が目盛りの境目のすぐ下でも、境目の目盛りをプロット領域の上に出さない', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult(
				depthOk({
					asks: [['10100', '1.0']],
					bids: [
						['9900', '1.49'],
						['9800', '1.0'],
					],
				}),
			),
		);
		const res = await renderDepthSvg({ pair: 'btc_jpy' });
		assertOk(res);
		const ticks = yAxisTicks(requireDefined(res.data.svg, 'svg'));
		// 最大の数量 2.49 に対して niceTicks は 2.5 も返す（最大値の 1% 上まで）
		expect(ticks.map((t) => t.label)).toEqual(['0 BTC', '0.5 BTC', '1 BTC', '1.5 BTC', '2 BTC']);
	});

	it('数量が数百万になる安いペアでも、数量軸の目盛りは数本にとどめる', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult(
				depthOk({
					asks: [
						['31.2347', '500000'],
						['31.2500', '800000'],
					],
					bids: [
						['31.2345', '1000000'],
						['31.2000', '1200000'],
						['31.1500', '1256789'],
					],
				}),
			),
		);
		const res = await renderDepthSvg({ pair: 'doge_jpy' });
		assertOk(res);
		const ticks = yAxisTicks(requireDefined(res.data.svg, 'svg'));
		expect(ticks.map((t) => t.label)).toEqual(['0 DOGE', '1M DOGE', '2M DOGE', '3M DOGE']);
	});

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
		expect(mockedGetDepth).toHaveBeenCalledWith('btc_jpy', { maxLevels: 50 });
	});

	it('depth.levels < 10 は 10 にクランプされる', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		await renderDepthSvg({ pair: 'btc_jpy', depth: { levels: 5 } });
		expect(mockedGetDepth).toHaveBeenCalledWith('btc_jpy', { maxLevels: 10 });
	});

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
