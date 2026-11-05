import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetOrderbookOutputSchema } from '../src/schemas.js';
import getOrderbook, { toolDef } from '../tools/get_orderbook.js';
import { assertFail, assertOk } from './_assertResult.js';
import { depthError } from './fixtures/bitbank-api.js';

// biome-ignore lint/suspicious/noExplicitAny: test helper — deep property access on Result.data
function d(res: { data: Record<string, unknown> }): Record<string, any> {
	// biome-ignore lint/suspicious/noExplicitAny: test helper
	return res.data as Record<string, any>;
}

function depthPayload() {
	return {
		success: 1,
		data: {
			asks: [
				['5000100', '0.2'],
				['5000200', '0.4'],
			],
			bids: [
				['5000000', '0.3'],
				['4999900', '0.5'],
			],
			timestamp: 1_700_000_000_000,
		},
	};
}

function richDepthPayload() {
	const mid = 5_000_000;
	const asks: [string, string][] = [];
	const bids: [string, string][] = [];
	for (let i = 1; i <= 50; i++) {
		// 大口注文を含める (i=10: 0.5 BTC, i=30: 0.8 BTC)
		const askSize = i === 10 ? '0.5' : i === 30 ? '0.8' : '0.02';
		const bidSize = i === 10 ? '0.5' : i === 30 ? '0.8' : '0.02';
		asks.push([String(mid + i * 100), askSize]);
		bids.push([String(mid - i * 100), bidSize]);
	}
	return {
		success: 1,
		data: {
			asks,
			bids,
			timestamp: 1_700_000_000_000,
			sequenceId: 12345,
			asks_over: 10,
			bids_under: 5,
		},
	};
}

function mockFetch(payload: unknown) {
	globalThis.fetch = vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		statusText: 'OK',
		json: async () => payload,
	}) as unknown as typeof fetch;
}

describe('get_orderbook', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('inputSchema: summary の topN は 1-200 の範囲のみ許可する', () => {
		const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', mode: 'summary', topN: 201 });
		expect(parse).toThrow();
	});

	it('正常系: summary で topN 件の板情報を返す', async () => {
		mockFetch(depthPayload());
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'summary', topN: 2 });
		assertOk(res);
		expect(d(res).mode).toBe('summary');
		expect(d(res).normalized.bids).toHaveLength(2);
		expect(d(res).normalized.asks).toHaveLength(2);
	});

	it('summary: mid / spread / bestBid / bestAsk が正しく計算される', async () => {
		mockFetch(depthPayload());
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'summary', topN: 2 });
		assertOk(res);
		expect(d(res).normalized.bestBid).toBe(5_000_000);
		expect(d(res).normalized.bestAsk).toBe(5_000_100);
		expect(d(res).normalized.spread).toBe(100);
		expect(d(res).normalized.mid).toBe(5_000_050);
	});

	it('summary: cumSize が累積される', async () => {
		mockFetch(depthPayload());
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'summary', topN: 2 });
		assertOk(res);
		expect(d(res).normalized.bids[1].cumSize).toBe(0.8); // 0.3 + 0.5
		expect(d(res).normalized.asks[1].cumSize).toBe(0.6); // 0.2 + 0.4
	});

	it('pressure: 帯域別の買い/売り圧力を返す', async () => {
		mockFetch(richDepthPayload());
		const res = await getOrderbook({
			pair: 'btc_jpy',
			mode: 'pressure',
			bandsPct: [0.001, 0.005, 0.01],
		});
		assertOk(res);
		expect(d(res).mode).toBe('pressure');
		expect(d(res).bands).toHaveLength(3);
		for (const band of d(res).bands) {
			expect(band).toHaveProperty('widthPct');
			expect(band).toHaveProperty('baseBidSize');
			expect(band).toHaveProperty('baseAskSize');
			expect(band).toHaveProperty('netDeltaPct');
			expect(band).toHaveProperty('tag');
		}
	});

	it('pressure: strongestTag が最も強いタグに設定される', async () => {
		mockFetch(richDepthPayload());
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'pressure', bandsPct: [0.001, 0.005, 0.01] });
		assertOk(res);
		expect(d(res).aggregates).toHaveProperty('strongestTag');
		const validTags = ['notice', 'warning', 'strong', null];
		expect(validTags).toContain(d(res).aggregates.strongestTag);
	});

	it('pressure: baseMid が null の場合（片側空）でも crash しない', async () => {
		mockFetch({
			success: 1,
			data: {
				asks: [],
				bids: [['5000000', '0.3']],
				timestamp: 1_700_000_000_000,
			},
		});
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'pressure', bandsPct: [0.01] });
		assertOk(res);
		expect(d(res).bands[0].baseMid).toBeNull();
		expect(d(res).bands[0].tag).toBeNull();
	});

	it('pressure: netDeltaPct の tag 分類（strong/warning/notice/null）', async () => {
		// 大きな偏りを作る: 買い板のみ厚い
		const asks: [string, string][] = [['5000100', '0.001']];
		const bids: [string, string][] = [['5000000', '10.0']];
		mockFetch({
			success: 1,
			data: { asks, bids, timestamp: 1_700_000_000_000 },
		});
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'pressure', bandsPct: [0.01] });
		assertOk(res);
		expect(d(res).bands[0].tag).toBe('strong');
		expect(d(res).aggregates.strongestTag).toBe('strong');
	});

	it('statistics: ranges / liquidityZones / largeOrders / summary を返す', async () => {
		mockFetch(richDepthPayload());
		const res = await getOrderbook({
			pair: 'btc_jpy',
			mode: 'statistics',
			ranges: [0.5, 1.0, 2.0],
			priceZones: 5,
		});
		assertOk(res);
		expect(d(res).mode).toBe('statistics');
		expect(d(res).ranges).toHaveLength(3);
		expect(d(res).liquidityZones).toHaveLength(5);
		expect(d(res).largeOrders).toHaveProperty('bids');
		expect(d(res).largeOrders).toHaveProperty('asks');
		expect(d(res).summary).toHaveProperty('overall');
		expect(d(res).summary).toHaveProperty('strength');
		expect(d(res).summary).toHaveProperty('liquidity');
	});

	it('statistics: interpretation が買い板厚い/売り板厚い/均衡に分岐', async () => {
		// 買い板が圧倒的に厚い
		const asks: [string, string][] = [['5000100', '0.01']];
		const bids: [string, string][] = [['5000000', '10.0']];
		mockFetch({
			success: 1,
			data: { asks, bids, timestamp: 1_700_000_000_000 },
		});
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics', ranges: [0.5] });
		assertOk(res);
		expect(d(res).ranges[0].interpretation).toContain('買い板が厚い');
	});

	it('statistics: 売り板が厚い場合の interpretation', async () => {
		const asks: [string, string][] = [['5000100', '10.0']];
		const bids: [string, string][] = [['5000000', '0.01']];
		mockFetch({
			success: 1,
			data: { asks, bids, timestamp: 1_700_000_000_000 },
		});
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics', ranges: [0.5] });
		assertOk(res);
		expect(d(res).ranges[0].interpretation).toContain('売り板が厚い');
	});

	it('statistics: 均衡の場合の interpretation', async () => {
		const asks: [string, string][] = [['5000100', '1.0']];
		const bids: [string, string][] = [['5000000', '1.0']];
		mockFetch({
			success: 1,
			data: { asks, bids, timestamp: 1_700_000_000_000 },
		});
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics', ranges: [0.5] });
		assertOk(res);
		expect(d(res).ranges[0].interpretation).toBe('均衡');
	});

	it('statistics: 大口注文 (>= 0.1 BTC) がフィルタされる', async () => {
		mockFetch(richDepthPayload());
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics', ranges: [2.0] });
		assertOk(res);
		expect(d(res).largeOrders.bids.length).toBeGreaterThan(0);
		expect(d(res).largeOrders.asks.length).toBeGreaterThan(0);
		for (const o of d(res).largeOrders.bids) {
			expect(o.size).toBeGreaterThanOrEqual(0.1);
		}
	});

	it('statistics: 大口注文なしの場合', async () => {
		// 全て 0.01 BTC → threshold 0.1 以下
		const asks: [string, string][] = Array.from({ length: 10 }, (_, i) => [String(5_000_100 + i * 100), '0.01']);
		const bids: [string, string][] = Array.from({ length: 10 }, (_, i) => [String(5_000_000 - i * 100), '0.01']);
		mockFetch({
			success: 1,
			data: { asks, bids, timestamp: 1_700_000_000_000 },
		});
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics', ranges: [2.0] });
		assertOk(res);
		expect(d(res).largeOrders.bids).toHaveLength(0);
		expect(d(res).largeOrders.asks).toHaveLength(0);
	});

	it('statistics: zone dominance (bid/ask/balanced)', async () => {
		mockFetch(richDepthPayload());
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics', ranges: [2.0], priceZones: 10 });
		assertOk(res);
		const validDoms = ['bid', 'ask', 'balanced'];
		for (const zone of d(res).liquidityZones) {
			expect(validDoms).toContain(zone.dominance);
		}
	});

	it('statistics: overall assessment (買い優勢/売り優勢/均衡) と strength', async () => {
		// 強い買い優勢
		const asks: [string, string][] = [['5000100', '0.01']];
		const bids: [string, string][] = [['5000000', '10.0']];
		mockFetch({
			success: 1,
			data: { asks, bids, timestamp: 1_700_000_000_000 },
		});
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics', ranges: [0.5] });
		assertOk(res);
		expect(d(res).summary.overall).toBe('買い優勢');
		expect(d(res).summary.strength).toBe('strong');
		expect(d(res).summary.recommendation).toContain('買いエントリー');
	});

	it('statistics: 売り優勢の assessment', async () => {
		const asks: [string, string][] = [['5000100', '10.0']];
		const bids: [string, string][] = [['5000000', '0.01']];
		mockFetch({
			success: 1,
			data: { asks, bids, timestamp: 1_700_000_000_000 },
		});
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics', ranges: [0.5] });
		assertOk(res);
		expect(d(res).summary.overall).toBe('売り優勢');
		expect(d(res).summary.recommendation).toContain('押し目待ち');
	});

	it('statistics: 均衡の assessment', async () => {
		const asks: [string, string][] = [['5000100', '1.0']];
		const bids: [string, string][] = [['5000000', '1.0']];
		mockFetch({
			success: 1,
			data: { asks, bids, timestamp: 1_700_000_000_000 },
		});
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics', ranges: [0.5] });
		assertOk(res);
		expect(d(res).summary.overall).toBe('均衡');
		expect(d(res).summary.recommendation).toContain('レンジ');
	});

	it('statistics: liquidity が high/medium/low に分岐', async () => {
		// low liquidity: 少量
		const asks: [string, string][] = [['5000100', '0.5']];
		const bids: [string, string][] = [['5000000', '0.5']];
		mockFetch({
			success: 1,
			data: { asks, bids, timestamp: 1_700_000_000_000 },
		});
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics', ranges: [0.5] });
		assertOk(res);
		expect(['high', 'medium', 'low']).toContain(d(res).summary.liquidity);
	});

	it('statistics: bids/asks が空でも crash しない', async () => {
		mockFetch({
			success: 1,
			data: { asks: [], bids: [], timestamp: 1_700_000_000_000 },
		});
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics', ranges: [0.5], priceZones: 3 });
		assertOk(res);
		expect(d(res).basic.currentPrice).toBeNull();
	});

	it('raw: 生データとオーバーレイを返す', async () => {
		mockFetch(richDepthPayload());
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'raw' });
		assertOk(res);
		expect(d(res).mode).toBe('raw');
		expect(Array.isArray(d(res).bids)).toBe(true);
		expect(Array.isArray(d(res).asks)).toBe(true);
		expect(d(res).overlays).toHaveProperty('depth_zones');
	});

	it('raw: sequenceId を取得する', async () => {
		mockFetch(richDepthPayload());
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'raw' });
		assertOk(res);
		expect(d(res).sequenceId).toBe(12345);
	});

	it('raw: sequence_id (別名) にも対応する', async () => {
		const payload = richDepthPayload();
		const data = payload.data as Record<string, unknown>;
		delete data.sequenceId;
		(data as Record<string, unknown>).sequence_id = 67890;
		mockFetch(payload);
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'raw' });
		assertOk(res);
		expect(d(res).sequenceId).toBe(67890);
	});

	it('raw: asks_over / bids_under などの補助フィールドを含む', async () => {
		mockFetch(richDepthPayload());
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'raw' });
		assertOk(res);
		expect(d(res).asks_over).toBe(10);
		expect(d(res).bids_under).toBe(5);
	});

	it('raw: depth_zones (壁推定) が生成される', async () => {
		mockFetch(richDepthPayload());
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'raw' });
		assertOk(res);
		const zones = d(res).overlays.depth_zones;
		expect(Array.isArray(zones)).toBe(true);
		// richDepthPayload has outlier sizes (0.5, 0.8) that should create wall zones
		expect(zones.length).toBeGreaterThan(0);
		expect(zones[0]).toHaveProperty('low');
		expect(zones[0]).toHaveProperty('high');
		expect(zones[0]).toHaveProperty('label');
	});

	it('raw: bids/asks が空でも crash しない', async () => {
		mockFetch({
			success: 1,
			data: { asks: [], bids: [], timestamp: 1_700_000_000_000 },
		});
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'raw' });
		assertOk(res);
		expect(d(res).bids).toHaveLength(0);
		expect(d(res).asks).toHaveLength(0);
	});

	it('後方互換: string パラメータで summary モードが使える', async () => {
		mockFetch(depthPayload());
		const res = await getOrderbook('btc_jpy');
		assertOk(res);
		expect(d(res).mode).toBe('summary');
	});

	it('API異常系: AbortError は timeout 分類で fail を返す', async () => {
		globalThis.fetch = vi
			.fn()
			.mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError')) as unknown as typeof fetch;

		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'summary', timeoutMs: 100 });
		assertFail(res);
		expect(res.meta?.errorType).toBe('timeout');
	});

	it('上流レスポンスで bids/asks 欠損時は fail を返すべき（現状は ok=true）', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { timestamp: 1_700_000_000_000 } }),
		}) as unknown as typeof fetch;

		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'summary' });
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
	});

	it('API異常系: success:0 を bids/asks 欠損 ではなく upstream として明示分類する', async () => {
		mockFetch(depthError);
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'summary' });
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
		expect(res.summary).toContain('code: 20003');
	});

	it('API異常系: success:0 で data.code が無くても upstream として返す', async () => {
		mockFetch({ success: 0, data: {} });
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'summary' });
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
	});

	it('無効なペアで fail を返す', async () => {
		const res = await getOrderbook({ pair: 'invalid' });
		assertFail(res);
	});

	it('topN が範囲外で fail を返す', async () => {
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'summary', topN: 300 });
		assertFail(res);
	});

	it('全モードでテキストに境界情報が付加される', async () => {
		for (const mode of ['summary', 'pressure', 'statistics', 'raw'] as const) {
			mockFetch(richDepthPayload());
			const res = await getOrderbook({ pair: 'btc_jpy', mode });
			assertOk(res);
			expect(res.summary).toContain('含まれるもの');
			expect(res.summary).toContain(`mode=${mode}`);
		}
	});

	describe('OutputSchema 整合性', () => {
		// GetOrderbookOutputSchema は ok / fail の union を受けるので parse が通るだけでは ok の data 形状を検証したことにならない。各ケースで先に assertOk(res) で ok を確定させてから parse する。

		it('summary: 戻り値が OutputSchema を通る', async () => {
			mockFetch(depthPayload());
			const res = await getOrderbook({ pair: 'btc_jpy', mode: 'summary', topN: 2 });
			assertOk(res);
			expect(() => GetOrderbookOutputSchema.parse(res)).not.toThrow();
		});

		it('pressure: 戻り値が OutputSchema を通る', async () => {
			mockFetch(richDepthPayload());
			const res = await getOrderbook({ pair: 'btc_jpy', mode: 'pressure', bandsPct: [0.001, 0.005, 0.01] });
			assertOk(res);
			expect(() => GetOrderbookOutputSchema.parse(res)).not.toThrow();
		});

		it('statistics: 戻り値が OutputSchema を通る', async () => {
			mockFetch(richDepthPayload());
			const res = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics', ranges: [0.5, 1.0, 2.0], priceZones: 5 });
			assertOk(res);
			expect(() => GetOrderbookOutputSchema.parse(res)).not.toThrow();
		});

		it('raw: 戻り値が OutputSchema を通る', async () => {
			mockFetch(richDepthPayload());
			const res = await getOrderbook({ pair: 'btc_jpy', mode: 'raw' });
			assertOk(res);
			expect(() => GetOrderbookOutputSchema.parse(res)).not.toThrow();
		});

		it('statistics: ask 側枯渇 (askVolume=0 && bidVolume>0) で ratio=null、買い優勢 strong を維持し JSON 往復後も schema 一致', async () => {
			// best bid と best ask が同価で ask の size が 0 のとき ratio = Infinity になるが、MCP wire format で表現できないので実装は ratio: null に正規化し、意味（買い優勢 / strong / 売り板=0）は interpretation / summary / content text 側で保持する。
			mockFetch({
				success: 1,
				data: {
					asks: [
						['5000000', '0'],
						['5000100', '0'],
					],
					bids: [
						['5000000', '1.0'],
						['4999900', '10.0'],
					],
					timestamp: 1_700_000_000_000,
				},
			});
			const res = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics', ranges: [0.5] });
			assertOk(res);

			expect(d(res).ranges[0].ratio).toBeNull();

			expect(d(res).ranges[0].interpretation).toContain('買い板が厚い');
			expect(d(res).ranges[0].interpretation).toContain('算出不能');
			expect(d(res).summary.overall).toBe('買い優勢');
			expect(d(res).summary.strength).toBe('strong');
			expect(d(res).summary.recommendation).toContain('買いエントリー');

			expect(res.summary).toContain('算出不能');

			expect(() => GetOrderbookOutputSchema.parse(res)).not.toThrow();

			const roundTripped = JSON.parse(JSON.stringify(res));
			expect(roundTripped.data.ranges[0].ratio).toBeNull();
			expect(() => GetOrderbookOutputSchema.parse(roundTripped)).not.toThrow();
		});
	});
});
