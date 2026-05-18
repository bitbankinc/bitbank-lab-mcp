import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../tools/get_tickers_jpy.js', () => ({
	default: vi.fn(),
}));

import {
	buildTickersJpyItemsText,
	buildTickersJpyRankedText,
	type NormalizedTicker,
	toolDef,
} from '../../src/handlers/getTickersJpyHandler.js';
import getTickersJpy from '../../tools/get_tickers_jpy.js';

const mockedGetTickersJpy = vi.mocked(getTickersJpy);

afterEach(() => {
	vi.clearAllMocks();
});

// ─── pure function tests ──────────────────────────────────────────────────────

describe('buildTickersJpyRankedText', () => {
	const makeTicker = (pair: string, changeN: number, volumeInJPY: number): NormalizedTicker => ({
		pair,
		lastN: 1000,
		openN: 900,
		highN: 1100,
		lowN: 800,
		buyN: 999,
		sellN: 1001,
		changeN,
		volN: 100,
		volumeInJPY,
	});

	it('ヘッダーに総件数・sortBy・order・top件数が含まれる', () => {
		const ranked = [makeTicker('btc_jpy', 5.5, 1_000_000)];
		const text = buildTickersJpyRankedText(30, ranked, 'change24h', 'desc', 5);
		expect(text).toContain('全30ペア取得');
		expect(text).toContain('sortBy=change24h');
		expect(text).toContain('desc');
		expect(text).toContain('top5');
	});

	it('ペア名が大文字スラッシュ区切りで表示される', () => {
		const ranked = [makeTicker('btc_jpy', 2.0, 500_000)];
		const text = buildTickersJpyRankedText(1, ranked, 'volume', 'asc', 1);
		expect(text).toContain('BTC/JPY');
	});

	it('連番インデックスが正しい（1始まり）', () => {
		const ranked = [makeTicker('btc_jpy', 5.0, 1_000_000), makeTicker('eth_jpy', 3.0, 500_000)];
		const text = buildTickersJpyRankedText(2, ranked, 'change24h', 'desc', 2);
		expect(text).toContain('1. BTC/JPY');
		expect(text).toContain('2. ETH/JPY');
	});

	it('空のランキングでも header 行だけ出力される', () => {
		const text = buildTickersJpyRankedText(0, [], 'name', 'asc', 5);
		expect(text).toContain('全0ペア取得');
	});
});

describe('buildTickersJpyItemsText', () => {
	const makeTicker = (pair: string, changeN: number): NormalizedTicker => ({
		pair,
		lastN: 5_000_000,
		openN: null,
		highN: null,
		lowN: null,
		buyN: null,
		sellN: null,
		changeN,
		volN: 50,
		volumeInJPY: 250_000_000,
	});

	it('総件数が先頭に表示される', () => {
		const items = [makeTicker('btc_jpy', 1.2)];
		const text = buildTickersJpyItemsText(items);
		expect(text).toContain('全1ペア取得');
	});

	it('上位5件のみ詳細表示される', () => {
		const items = Array.from({ length: 8 }, (_, i) => makeTicker(`coin${i}_jpy`, i * 0.5));
		const text = buildTickersJpyItemsText(items);
		// 6件目以降は「他N件」
		expect(text).toContain('他3ペア');
		// 5件までは含まれる
		expect(text).toContain('COIN0/JPY');
		expect(text).toContain('COIN4/JPY');
		expect(text).not.toContain('COIN5/JPY');
	});

	it('5件以下なら「他N件」行が出ない', () => {
		const items = [makeTicker('btc_jpy', 2.0), makeTicker('eth_jpy', 1.0)];
		const text = buildTickersJpyItemsText(items);
		expect(text).not.toContain('他');
	});
});

// ─── handler tests ────────────────────────────────────────────────────────────

describe('toolDef handler', () => {
	const mockTickerData = (pairs: Array<{ pair: string; last: number; open: number; vol: number }>) => ({
		ok: true,
		summary: 'ok',
		data: pairs.map((p) => ({
			pair: p.pair,
			last: String(p.last),
			open: String(p.open),
			high: String(p.last * 1.05),
			low: String(p.last * 0.95),
			buy: String(p.last - 100),
			sell: String(p.last + 100),
			vol: String(p.vol),
		})),
		meta: {},
	});

	it('getTickersJpy が ok:false を返すとそのまま返す', async () => {
		mockedGetTickersJpy.mockResolvedValueOnce({ ok: false, summary: 'error', error: 'NETWORK' } as never);
		const res = await toolDef.handler({ view: 'ranked' });
		expect((res as { ok: boolean }).ok).toBe(false);
	});

	it('view=ranked でテキストに ranked 件数が含まれる', async () => {
		mockedGetTickersJpy.mockResolvedValueOnce(
			mockTickerData([
				{ pair: 'btc_jpy', last: 10_000_000, open: 9_500_000, vol: 200 },
				{ pair: 'eth_jpy', last: 500_000, open: 480_000, vol: 100 },
			]) as never,
		);
		const res = await toolDef.handler({ view: 'ranked', sortBy: 'change24h', order: 'desc', limit: 2 });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('全2ペア取得');
		expect(text).toContain('top2');
	});

	it('view=items でテキストに全件数が含まれる', async () => {
		mockedGetTickersJpy.mockResolvedValueOnce(
			mockTickerData([{ pair: 'btc_jpy', last: 10_000_000, open: 9_000_000, vol: 300 }]) as never,
		);
		const res = await toolDef.handler({ view: 'items' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('全1ペア取得');
	});

	it('sortBy=volume で出来高の大きいペアが上位にくる', async () => {
		mockedGetTickersJpy.mockResolvedValueOnce(
			mockTickerData([
				{ pair: 'btc_jpy', last: 10_000_000, open: 10_000_000, vol: 10 }, // 小さい出来高
				{ pair: 'eth_jpy', last: 500_000, open: 500_000, vol: 1_000 }, // 大きい出来高
			]) as never,
		);
		const res = await toolDef.handler({ view: 'ranked', sortBy: 'volume', order: 'desc', limit: 2 });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		// ETH/JPY が出来高で上位に来る（出来高 = vol × last = 1000 × 500000 = 5億）
		expect(text).toContain('1. ETH/JPY');
		expect(text).toContain('2. BTC/JPY');
	});

	it('sortBy=name で名前のアルファベット順になる（desc）', async () => {
		mockedGetTickersJpy.mockResolvedValueOnce(
			mockTickerData([
				{ pair: 'btc_jpy', last: 1_000, open: 1_000, vol: 1 },
				{ pair: 'ada_jpy', last: 100, open: 100, vol: 1 },
			]) as never,
		);
		const res = await toolDef.handler({ view: 'ranked', sortBy: 'name', order: 'desc', limit: 2 });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		// desc=逆順なので btc > ada → BTC/JPY が1位
		expect(text).toContain('1. BTC/JPY');
		expect(text).toContain('2. ADA/JPY');
	});

	it('changeN が null のティッカーは open から計算される', async () => {
		mockedGetTickersJpy.mockResolvedValueOnce(
			mockTickerData([{ pair: 'xrp_jpy', last: 110, open: 100, vol: 50 }]) as never,
		);
		const res = await toolDef.handler({ view: 'ranked', sortBy: 'change24h', order: 'desc', limit: 1 });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		// change = (110-100)/100*100 = +10%
		expect(text).toContain('+10.00%');
	});

	it('structuredContent に ok:true と ranked/items 両方のデータが含まれる（ranked）', async () => {
		mockedGetTickersJpy.mockResolvedValueOnce(
			mockTickerData([{ pair: 'btc_jpy', last: 5_000_000, open: 5_000_000, vol: 100 }]) as never,
		);
		const res = await toolDef.handler({ view: 'ranked', sortBy: 'change24h', order: 'desc', limit: 5 });
		const sc = (res as { structuredContent: Record<string, unknown> }).structuredContent;
		expect(sc.ok).toBe(true);
		expect(sc.data).toHaveProperty('items');
		expect(sc.data).toHaveProperty('ranked');
	});
});

// ─── NaN / Infinity normalization (PR4) ───────────────────────────────────────

describe('toolDef handler — NaN/Infinity normalization', () => {
	const makeMockedRes = (data: unknown[]) => ({ ok: true, summary: 'ok', data, meta: {} });

	it('malformed string ("abc") は lastN / volumeInJPY 共に null になる', async () => {
		mockedGetTickersJpy.mockResolvedValueOnce(
			makeMockedRes([
				{
					pair: 'bad_jpy',
					last: 'abc',
					open: '100',
					high: '110',
					low: '90',
					buy: '99',
					sell: '101',
					vol: '1.0',
				},
			]) as never,
		);
		const res = await toolDef.handler({ view: 'ranked', sortBy: 'change24h', order: 'desc', limit: 1 });
		const sc = (res as { structuredContent: { data: { items: Array<Record<string, unknown>> } } }).structuredContent;
		const item = sc.data.items[0];
		expect(item.lastN).toBeNull();
		expect(item.volumeInJPY).toBeNull();
	});

	it('空文字 / null フィールドは N (正規化後) で null になる', async () => {
		mockedGetTickersJpy.mockResolvedValueOnce(
			makeMockedRes([
				{
					pair: 'empty_jpy',
					last: '100',
					open: '95',
					high: '110',
					low: '90',
					buy: null,
					sell: '',
					vol: '',
				},
			]) as never,
		);
		const res = await toolDef.handler({ view: 'items' });
		const sc = (res as { structuredContent: { data: { items: Array<Record<string, unknown>> } } }).structuredContent;
		const item = sc.data.items[0];
		expect(item.volN).toBeNull();
		expect(item.buyN).toBeNull();
		expect(item.sellN).toBeNull();
		expect(item.volumeInJPY).toBeNull();
	});

	it('Infinity / -Infinity が上流から来たら null に正規化される', async () => {
		mockedGetTickersJpy.mockResolvedValueOnce(
			makeMockedRes([
				{
					pair: 'inf_jpy',
					last: Infinity,
					open: -Infinity,
					high: '110',
					low: '90',
					buy: '99',
					sell: '101',
					vol: '1.0',
				},
			]) as never,
		);
		const res = await toolDef.handler({ view: 'items' });
		const sc = (res as { structuredContent: { data: { items: Array<Record<string, unknown>> } } }).structuredContent;
		const item = sc.data.items[0];
		expect(item.lastN).toBeNull();
		expect(item.openN).toBeNull();
		expect(item.volumeInJPY).toBeNull();
	});

	it('異常値ペアが ranked sort の末尾（desc, change）に来る', async () => {
		mockedGetTickersJpy.mockResolvedValueOnce(
			makeMockedRes([
				{
					pair: 'good_jpy',
					last: '110',
					open: '100',
					high: '120',
					low: '90',
					buy: '109',
					sell: '111',
					vol: '1.0',
				}, // +10%
				{
					pair: 'bad_jpy',
					last: 'abc',
					open: 'xyz',
					high: '0',
					low: '0',
					buy: '0',
					sell: '0',
					vol: 'NaN',
				}, // changeN=null
			]) as never,
		);
		const res = await toolDef.handler({ view: 'ranked', sortBy: 'change24h', order: 'desc', limit: 2 });
		const sc = (res as { structuredContent: { data: { ranked: Array<{ pair: string }> } } }).structuredContent;
		expect(sc.data.ranked[0].pair).toBe('good_jpy');
		expect(sc.data.ranked[1].pair).toBe('bad_jpy');
	});

	it('異常値ペアが ranked sort の先頭（asc, change）に来る', async () => {
		mockedGetTickersJpy.mockResolvedValueOnce(
			makeMockedRes([
				{
					pair: 'good_jpy',
					last: '110',
					open: '100',
					high: '120',
					low: '90',
					buy: '109',
					sell: '111',
					vol: '1.0',
				},
				{
					pair: 'bad_jpy',
					last: 'abc',
					open: 'xyz',
					high: '0',
					low: '0',
					buy: '0',
					sell: '0',
					vol: 'NaN',
				},
			]) as never,
		);
		const res = await toolDef.handler({ view: 'ranked', sortBy: 'change24h', order: 'asc', limit: 2 });
		const sc = (res as { structuredContent: { data: { ranked: Array<{ pair: string }> } } }).structuredContent;
		expect(sc.data.ranked[0].pair).toBe('bad_jpy');
		expect(sc.data.ranked[1].pair).toBe('good_jpy');
	});

	it('view=ranked の structuredContent が GetTickersJpyHandlerOutputSchema.parse() を通る', async () => {
		const { GetTickersJpyHandlerOutputSchema } = await import('../../src/schemas.js');
		mockedGetTickersJpy.mockResolvedValueOnce(
			makeMockedRes([
				{
					pair: 'btc_jpy',
					last: '5000000',
					open: '4900000',
					high: '5100000',
					low: '4800000',
					buy: '4999000',
					sell: '5001000',
					vol: '10',
				},
				{
					pair: 'bad_jpy',
					last: 'abc',
					open: '',
					high: '0',
					low: '0',
					buy: null,
					sell: undefined,
					vol: Infinity,
				},
			]) as never,
		);
		const res = await toolDef.handler({ view: 'ranked', sortBy: 'change24h', order: 'desc', limit: 5 });
		const sc = (res as { structuredContent: Record<string, unknown> }).structuredContent;
		expect(() => GetTickersJpyHandlerOutputSchema.parse(sc)).not.toThrow();
	});

	it('view=items の structuredContent が GetTickersJpyHandlerOutputSchema.parse() を通る', async () => {
		const { GetTickersJpyHandlerOutputSchema } = await import('../../src/schemas.js');
		mockedGetTickersJpy.mockResolvedValueOnce(
			makeMockedRes([
				{
					pair: 'btc_jpy',
					last: '5000000',
					open: '4900000',
					high: '5100000',
					low: '4800000',
					buy: '4999000',
					sell: '5001000',
					vol: '10',
				},
				{
					pair: 'bad_jpy',
					last: 'abc',
					open: '',
					high: '0',
					low: '0',
					buy: null,
					sell: undefined,
					vol: Infinity,
				},
			]) as never,
		);
		const res = await toolDef.handler({ view: 'items' });
		const sc = (res as { structuredContent: Record<string, unknown> }).structuredContent;
		expect(() => GetTickersJpyHandlerOutputSchema.parse(sc)).not.toThrow();
	});

	it('有限数同士の積がオーバーフローしても volumeInJPY は null になる', async () => {
		mockedGetTickersJpy.mockResolvedValueOnce(
			makeMockedRes([
				{
					pair: 'huge_jpy',
					last: '1e308',
					open: '1e308',
					high: '1e308',
					low: '1e308',
					buy: '1e308',
					sell: '1e308',
					vol: '1e308',
				},
			]) as never,
		);
		const res = await toolDef.handler({ view: 'items' });
		const sc = (res as { structuredContent: { data: { items: Array<Record<string, unknown>> } } }).structuredContent;
		const item = sc.data.items[0];
		// 1e308 * 1e308 = Infinity → null に正規化されている
		expect(item.lastN).toBe(1e308);
		expect(item.volN).toBe(1e308);
		expect(item.volumeInJPY).toBeNull();
	});

	it('structuredContent に NaN / Infinity が混入しない', async () => {
		mockedGetTickersJpy.mockResolvedValueOnce(
			makeMockedRes([
				{
					pair: 'bad_jpy',
					last: 'abc',
					open: Infinity,
					high: '0',
					low: '0',
					buy: '0',
					sell: '0',
					vol: NaN,
				},
			]) as never,
		);
		const res = await toolDef.handler({ view: 'ranked', sortBy: 'change24h', order: 'desc', limit: 1 });
		const sc = (res as { structuredContent: Record<string, unknown> }).structuredContent;
		// 正規化フィールドに NaN / Infinity がないことを確認
		const json = JSON.stringify(sc);
		expect(json).not.toContain('NaN');
		expect(json).not.toContain('Infinity');
	});
});
