import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPairsSpecCache } from '../lib/pairs.js';
import refreshPairsCache, { toolDef } from '../tools/refresh_pairs_cache.js';
import { mockSpotPairsResponse } from './fixtures/private-api.js';

const originalFetch = globalThis.fetch;

function isMcpResponse(
	r: unknown,
): r is { content: Array<{ type: string; text: string }>; structuredContent: Record<string, unknown> } {
	return typeof r === 'object' && r != null && 'content' in r && Array.isArray((r as { content: unknown }).content);
}

describe('refresh_pairs_cache', () => {
	beforeEach(() => {
		clearPairsSpecCache();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearPairsSpecCache();
		vi.restoreAllMocks();
	});

	it('toolDef は public ツールの基本要素を持つ', () => {
		expect(toolDef.name).toBe('refresh_pairs_cache');
		expect(toolDef.description.length).toBeGreaterThan(0);
		expect(typeof toolDef.inputSchema.parse).toBe('function');
		expect(typeof toolDef.handler).toBe('function');
	});

	it('成功時は content にペア数とレートが含まれる', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 }),
		);
		const res = await refreshPairsCache();
		expect(isMcpResponse(res)).toBe(true);
		if (!isMcpResponse(res)) return;
		const text = res.content[0]?.text ?? '';
		expect(text).toContain('強制再取得');
		expect(text).toContain('2 ペア');
		expect(text).toContain('取得時刻');
		// フィクスチャ: btc_jpy taker=0.0012 / maker=-0.0002
		expect(text).toContain('btc_jpy');
		expect(text).toContain('taker=0.0012');
		expect(text).toContain('maker=-0.0002');
	});

	it('TTL 内でも毎回 fetch が走る（forceRefresh）', async () => {
		const spy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 }));
		await refreshPairsCache();
		await refreshPairsCache();
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it('handler 経由でも content にデータが含まれる', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 }),
		);
		const res = await toolDef.handler({});
		expect(isMcpResponse(res)).toBe(true);
		if (!isMcpResponse(res)) return;
		expect(res.content[0]?.text).toContain('ペア');
		expect(res.structuredContent.ok).toBe(true);
	});

	it('pair 指定時、未対応ペアは注記される', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 }),
		);
		const res = await refreshPairsCache({ pair: 'zzz_jpy' });
		expect(isMcpResponse(res)).toBe(true);
		if (!isMcpResponse(res)) return;
		expect(res.content[0]?.text).toContain("'zzz_jpy' は /spot/pairs に存在しません");
	});

	it('pair の前後空白・大文字は正規化される（未対応扱いにならない）', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 }),
		);
		const res = await refreshPairsCache({ pair: '  BTC_JPY  ' });
		expect(isMcpResponse(res)).toBe(true);
		if (!isMcpResponse(res)) return;
		const text = res.content[0]?.text ?? '';
		expect(text).not.toContain('存在しません');
		expect(text).toContain('btc_jpy');
	});

	it('取得失敗時は fail を返す（サーバーは継続）', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }));
		const res = await refreshPairsCache();
		expect(isMcpResponse(res)).toBe(false);
		expect((res as { ok: boolean }).ok).toBe(false);
		expect((res as { summary: string }).summary).toContain('再取得に失敗');
	});

	it('ネットワークエラーでも fail を返す', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
		const res = await refreshPairsCache();
		expect(isMcpResponse(res)).toBe(false);
		expect((res as { ok: boolean }).ok).toBe(false);
	});
});
