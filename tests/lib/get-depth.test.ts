import { afterEach, describe, expect, it, vi } from 'vitest';
import getDepth, { buildDepthText } from '../../lib/get-depth.js';
import { assertFail, assertOk } from '../_assertResult.js';

/** bitbank 板レスポンスの最小フィクスチャ */
function depthApiResponse() {
	return {
		success: 1,
		data: {
			asks: [
				['5000100', '0.2'],
				['5000200', '0.4'],
				['5000300', '0.6'],
			],
			bids: [
				['5000000', '0.3'],
				['4999900', '0.5'],
				['4999800', '0.7'],
			],
			asks_over: '10.0',
			bids_under: '8.0',
			timestamp: 1_700_000_000_000,
			sequenceId: '12345',
		},
	};
}

describe('buildDepthText', () => {
	it('板データをテキストにフォーマットする', () => {
		const text = buildDepthText({
			timestamp: 1_700_000_000_000,
			summary: 'BTC/JPY depth',
			bids: [['5000000', '0.3']],
			asks: [['5000100', '0.2']],
			mid: 5000050,
		});
		expect(text).toContain('買い板');
		expect(text).toContain('売り板');
		expect(text).toContain('5,000,050円');
		expect(text).toContain('5,000,000');
		expect(text).toContain('5,000,100');
	});

	it('mid が null の場合でもフォーマットできる', () => {
		const text = buildDepthText({
			timestamp: 1_700_000_000_000,
			summary: 'test',
			bids: [],
			asks: [],
			mid: null,
		});
		expect(text).not.toContain('中値');
	});
});

describe('getDepth', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('正常系: 板データを取得して Result を返す', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(depthApiResponse()), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const res = await getDepth('btc_jpy');
		assertOk(res);
		expect(res.data.asks).toHaveLength(3);
		expect(res.data.bids).toHaveLength(3);
		expect(res.data.timestamp).toBe(1_700_000_000_000);
		expect(res.data.sequenceId).toBe(12345);
	});

	it('正常系: maxLevels で板の層数を制限できる', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(depthApiResponse()), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const res = await getDepth('btc_jpy', { maxLevels: 2 });
		assertOk(res);
		expect(res.data.asks).toHaveLength(2);
		expect(res.data.bids).toHaveLength(2);
	});

	it('正常系: レートリミット情報を meta に含める', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(depthApiResponse()), {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'X-RateLimit-Remaining': '50',
					'X-RateLimit-Limit': '100',
					'X-RateLimit-Reset': '1700000000',
				},
			}),
		);

		const res = await getDepth('btc_jpy');
		assertOk(res);
		expect(res.meta?.rateLimit).toEqual({ remaining: 50, limit: 100, reset: 1700000000 });
	});

	it('正常系: overlays.depth_zones が生成される', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(depthApiResponse()), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const res = await getDepth('btc_jpy');
		assertOk(res);
		expect(res.data.overlays).toBeDefined();
		expect(Array.isArray(res.data.overlays!.depth_zones)).toBe(true);
	});

	it('不正な pair で fail を返す', async () => {
		const res = await getDepth('invalid_pair');
		assertFail(res);
	});

	it('API異常系: success:0 を upstream エラーとして明示分類する', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: 0, data: { code: 10000 } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const res = await getDepth('btc_jpy');
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
		expect(res.summary).toContain('code: 10000');
	});

	it('API異常系: success:0 で data.code が無くても upstream として返す', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: 0, data: {} }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const res = await getDepth('btc_jpy');
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
	});

	it('API異常系: success:1 だが asks フィールドが欠損 → upstream fail', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: 1, data: { bids: [['100', '1']], timestamp: 1_700_000_000_000 } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const res = await getDepth('btc_jpy');
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
		expect(res.summary).toContain('bids/asks');
	});

	it('API異常系: success:1 だが bids が配列でない（オブジェクト）→ upstream fail', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					success: 1,
					data: { asks: [['100', '1']], bids: { broken: true }, timestamp: 1_700_000_000_000 },
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);

		const res = await getDepth('btc_jpy');
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
		expect(res.summary).toContain('bids/asks');
	});

	it('API異常系: success:1 だが asks/bids 両方欠損 → upstream fail', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: 1, data: { timestamp: 1_700_000_000_000 } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const res = await getDepth('btc_jpy');
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
	});

	it('API エラー（HTTP 500）で fail を返す', async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }));

		const res = await getDepth('btc_jpy', { timeoutMs: 1000 });
		assertFail(res);
		expect(res.meta?.errorType).toBe('network');
	});

	it('ネットワーク障害で fail を返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));

		const res = await getDepth('btc_jpy', { timeoutMs: 1000 });
		assertFail(res);
		expect(res.meta?.errorType).toBe('network');
	});

	it('AbortError（タイムアウト）で fail を返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));

		const res = await getDepth('btc_jpy', { timeoutMs: 100 });
		assertFail(res);
		expect(res.meta?.errorType).toBe('timeout');
	});

	it('summary テキストに板データが含まれる', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(depthApiResponse()), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const res = await getDepth('btc_jpy');
		assertOk(res);
		expect(res.summary).toContain('買い板');
		expect(res.summary).toContain('売り板');
	});
});
