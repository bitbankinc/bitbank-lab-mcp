import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowMetricsBucket } from '../tools/get_flow_metrics.js';
import getFlowMetrics, { buildFlowMetricsText, toolDef } from '../tools/get_flow_metrics.js';
import { assertFail, assertOk } from './_assertResult.js';

function txPayload(txs?: Array<{ price: string; amount: string; side: string; executed_at: string }>) {
	return {
		success: 1,
		data: {
			transactions: txs ?? [
				{ price: '5000000', amount: '0.1', side: 'buy', executed_at: '1700000000000' },
				{ price: '5000100', amount: '0.2', side: 'sell', executed_at: '1700000060000' },
				{ price: '5000200', amount: '0.3', side: 'buy', executed_at: '1700000120000' },
			],
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

describe('get_flow_metrics', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	// ─── inputSchema ──────────────────────────────────────

	it('inputSchema: hours は 0.1 以上のみ許可する', () => {
		const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', hours: 0.05 });
		expect(parse).toThrow();
	});

	// ─── 基本 ─────────────────────────────────────────────

	it('正常系: 集計値 totalTrades / buyTrades / sellTrades が計算される', async () => {
		mockFetch(txPayload());
		const res = await getFlowMetrics('btc_jpy', 3, '20240101', 60_000);
		assertOk(res);
		expect(res.data.aggregates.totalTrades).toBe(3);
		expect(res.data.aggregates.buyTrades).toBe(2);
		expect(res.data.aggregates.sellTrades).toBe(1);
	});

	it('aggressorRatio が正しく計算される', async () => {
		mockFetch(txPayload());
		const res = await getFlowMetrics('btc_jpy', 3, '20240101', 60_000);
		assertOk(res);
		// 2 buys / 3 total = 0.667
		expect(res.data.aggregates.aggressorRatio).toBeCloseTo(0.667, 2);
	});

	it('CVD が正しく計算される（buy - sell の累積）', async () => {
		mockFetch(txPayload());
		const res = await getFlowMetrics('btc_jpy', 3, '20240101', 60_000);
		assertOk(res);
		// CVD = 0.1 - 0.2 + 0.3 = 0.2
		expect(res.data.aggregates.finalCvd).toBeCloseTo(0.2, 4);
	});

	// ─── バケット分割 ─────────────────────────────────────

	it('バケット分割: 異なる bucketMs でバケット数が変わる', async () => {
		mockFetch(txPayload());
		// 3件のtx: 0, 60000, 120000ms → bucketMs=60000 で 3バケット
		const res = await getFlowMetrics('btc_jpy', 3, '20240101', 60_000);
		assertOk(res);
		expect(res.data.series.buckets.length).toBe(3);
	});

	it('バケット分割: 大きい bucketMs で1バケットに集約', async () => {
		mockFetch(txPayload());
		// bucketMs=200000 で全部1バケットに
		const res = await getFlowMetrics('btc_jpy', 3, '20240101', 200_000);
		assertOk(res);
		expect(res.data.series.buckets.length).toBe(1);
	});

	// ─── スパイク検出 ─────────────────────────────────────

	it('スパイク検出: zscoreベースでspike分類される', async () => {
		// 多数の小バケット＋1件の巨大バケットでzscoreを上げる
		const txs: Array<{ price: string; amount: string; side: string; executed_at: string }> = [];
		for (let i = 0; i < 20; i++) {
			txs.push({
				price: '5000000',
				amount: '0.01',
				side: i % 2 === 0 ? 'buy' : 'sell',
				executed_at: String(1_700_000_000_000 + i * 60_000),
			});
		}
		// 最後のバケットに大量取引 → zscoreが非常に高くなる
		txs.push({ price: '5000000', amount: '50.0', side: 'buy', executed_at: String(1_700_000_000_000 + 20 * 60_000) });
		txs.push({
			price: '5000000',
			amount: '50.0',
			side: 'sell',
			executed_at: String(1_700_000_000_000 + 20 * 60_000 + 1),
		});
		mockFetch(txPayload(txs));
		const res = await getFlowMetrics('btc_jpy', 100, '20240101', 60_000);
		assertOk(res);
		const spiked = (res.data.series.buckets as FlowMetricsBucket[]).filter((b) => b.spike !== null);
		expect(spiked.length).toBeGreaterThan(0);
	});

	it('スパイク検出: 均一ボリュームではスパイクなし', async () => {
		const txs = Array.from({ length: 5 }, (_, i) => ({
			price: '5000000',
			amount: '0.1',
			side: i % 2 === 0 ? 'buy' : ('sell' as string),
			executed_at: String(1_700_000_000_000 + i * 60_000),
		}));
		mockFetch(txPayload(txs));
		const res = await getFlowMetrics('btc_jpy', 10, '20240101', 60_000);
		assertOk(res);
		const spiked = (res.data.series.buckets as FlowMetricsBucket[]).filter((b) => b.spike !== null);
		expect(spiked.length).toBe(0);
	});

	// ─── hours パラメータ ─────────────────────────────────

	it('hours: 時間範囲ベースで取得し meta に mode=time_range を設定', async () => {
		// hours 指定時は日付ごとに getTransactions を呼ぶ → 全部同じレスポンス
		const nowMs = Date.now();
		const txs = [
			{ price: '5000000', amount: '0.1', side: 'buy', executed_at: String(nowMs - 1000) },
			{ price: '5000100', amount: '0.2', side: 'sell', executed_at: String(nowMs - 500) },
		];
		mockFetch(txPayload(txs));
		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', 1);
		assertOk(res);
		expect(res.meta.mode).toBe('time_range');
		expect(res.meta.hours).toBe(1);
	});

	it('hours: latest のみ失敗しても date が成功していれば ok（警告付き）', async () => {
		// /transactions (latest) は失敗、/transactions/YYYYMMDD (date) は成功
		const nowMs = Date.now();
		const txs = [
			{ price: '5000000', amount: '0.1', side: 'buy', executed_at: String(nowMs - 1000) },
			{ price: '5000100', amount: '0.2', side: 'sell', executed_at: String(nowMs - 500) },
		];
		globalThis.fetch = vi.fn().mockImplementation((url: string) => {
			if (/\/transactions\/\d{8}$/.test(url)) {
				return Promise.resolve({
					ok: true,
					status: 200,
					statusText: 'OK',
					json: async () => txPayload(txs),
				});
			}
			return Promise.resolve({
				ok: false,
				status: 503,
				statusText: 'Service Unavailable',
				json: async () => ({}),
			});
		}) as unknown as typeof fetch;
		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', 1);
		assertOk(res);
		expect(res.meta.warning).toBeTruthy();
		expect(res.meta.warning).toContain('latest');
	});

	it('hours: date 取得が全滅した場合は fail with 失敗詳細', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 503,
			statusText: 'Service Unavailable',
			headers: { get: () => null },
			json: async () => ({}),
		}) as unknown as typeof fetch;
		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', 1);
		assertFail(res);
		expect(res.summary).toContain('日付ベース');
		expect(res.summary).toMatch(/HTTP 503|network|timeout|unknown/);
	});

	// ─── 空データ ─────────────────────────────────────────

	it('取引0件の場合は aggregates が全て0', async () => {
		mockFetch({ success: 1, data: { transactions: [] } });
		const res = await getFlowMetrics('btc_jpy', 3, '20240101');
		assertOk(res);
		expect(res.data.aggregates.totalTrades).toBe(0);
		expect(res.data.series.buckets).toHaveLength(0);
	});

	// ─── 全買い/全売り ────────────────────────────────────

	it('全て buy の場合の集計', async () => {
		const txs = Array.from({ length: 3 }, (_, i) => ({
			price: '5000000',
			amount: '0.1',
			side: 'buy',
			executed_at: String(1_700_000_000_000 + i * 60_000),
		}));
		mockFetch(txPayload(txs));
		const res = await getFlowMetrics('btc_jpy', 3, '20240101', 60_000);
		assertOk(res);
		expect(res.data.aggregates.sellTrades).toBe(0);
		expect(res.data.aggregates.aggressorRatio).toBe(1);
		expect(res.data.aggregates.finalCvd).toBeCloseTo(0.3, 4);
	});

	// ─── エラー系 ─────────────────────────────────────────

	it('API異常系: date 指定時に上流失敗なら fail を返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;
		const res = await getFlowMetrics('btc_jpy', 10, '20240101');
		assertFail(res);
	});

	it('上流取得が全滅した場合は fail を返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;
		const res = await getFlowMetrics('btc_jpy', 10);
		assertFail(res);
		expect(res.meta?.errorType).toBe('network');
	});

	it('無効なペアで fail を返す', async () => {
		const res = await getFlowMetrics('invalid_pair');
		assertFail(res);
	});

	// ─── toolDef.handler view パラメータ ──────────────────

	it('handler: view=buckets で直近N件のバケットをテキスト返却', async () => {
		mockFetch(txPayload());
		const res = (await toolDef.handler({
			pair: 'btc_jpy',
			limit: 3,
			date: '20240101',
			bucketMs: 60_000,
			view: 'buckets',
			bucketsN: 2,
		})) as { content: Array<{ text: string }> };
		expect(res.content).toBeDefined();
		expect(res.content[0].text).toContain('Flow Metrics');
		expect(res.content[0].text).toContain('Recent');
	});

	it('handler: view=full で全バケットをテキスト返却', async () => {
		mockFetch(txPayload());
		const res = (await toolDef.handler({
			pair: 'btc_jpy',
			limit: 3,
			date: '20240101',
			bucketMs: 60_000,
			view: 'full',
		})) as { content: Array<{ text: string }> };
		expect(res.content).toBeDefined();
		expect(res.content[0].text).toContain('All buckets');
	});

	it('handler: view=summary は buckets を structuredContent から除外する', async () => {
		mockFetch(txPayload());
		const res = (await toolDef.handler({
			pair: 'btc_jpy',
			limit: 3,
			date: '20240101',
			bucketMs: 60_000,
			view: 'summary',
		})) as {
			content: Array<{ text: string }>;
			structuredContent: { ok: boolean; data: { series: Record<string, unknown> } };
		};
		expect(res.structuredContent.ok).toBe(true);
		expect('buckets' in res.structuredContent.data.series).toBe(false);
		// content テキストにもバケット行が含まれない
		expect(res.content[0].text).not.toContain('📋 全');
	});

	it('handler: view=compact は非ゼロバケットのみを返す', async () => {
		// ゼロ埋めバケットを生むため、時間的に離れた2約定のみで bucketMs を小さめに
		const payload = {
			success: 1,
			data: {
				transactions: [
					{ price: '5000000', amount: '0.1', side: 'buy', executed_at: '1700000000000' },
					{ price: '5000100', amount: '0.2', side: 'sell', executed_at: '1700000600000' },
				],
			},
		};
		mockFetch(payload);
		const res = (await toolDef.handler({
			pair: 'btc_jpy',
			limit: 10,
			date: '20240101',
			bucketMs: 60_000,
			view: 'compact',
		})) as { structuredContent: { data: { series: { buckets: FlowMetricsBucket[] } } } };
		const buckets = res.structuredContent.data.series.buckets;
		expect(buckets.every((b) => b.buyVolume > 0 || b.sellVolume > 0)).toBe(true);
	});

	it('handler: 失敗時はそのまま返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;
		const res = (await toolDef.handler({ pair: 'btc_jpy', limit: 3, date: '20240101' })) as { ok: boolean };
		expect(res.ok).toBe(false);
	});

	// === 形成中足（provisional）注記は対象外 ===
	// 本ツールは OHLC ローソク足ではなく約定（transactions）を時間バケットに集計するため、
	// 「最新足が未確定（形成中）」の概念が存在しない。note を付与しないことを固定する。
	it('形成中足注記は付与しない（約定バケットのため対象外）', async () => {
		mockFetch(txPayload());
		const res = await getFlowMetrics('btc_jpy', 3, '20240101', 60_000);
		assertOk(res);
		expect(res.summary).not.toContain('未確定（形成中）');
		expect((res.meta as { provisional?: boolean }).provisional).toBeUndefined();
	});
});

// ─── buildFlowMetricsText 単体テスト ─────────────────

describe('buildFlowMetricsText', () => {
	it('基本的なテキスト構造を含む', () => {
		const text = buildFlowMetricsText({
			baseSummary: 'BTC_JPY summary',
			totalTrades: 10,
			buyVolume: 1.5,
			sellVolume: 0.8,
			netVolume: 0.7,
			aggressorRatio: 0.6,
			cvd: 0.7,
			buckets: [],
			bucketMs: 60_000,
		});
		expect(text).toContain('BTC_JPY summary');
		expect(text).toContain('totalTrades=10');
		expect(text).toContain('buyVol=');
		expect(text).toContain('sellVol=');
	});

	it('dataWarning がある場合に表示', () => {
		const text = buildFlowMetricsText({
			baseSummary: 'summary',
			dataWarning: '⚠️ データ不足',
			totalTrades: 0,
			buyVolume: 0,
			sellVolume: 0,
			netVolume: 0,
			aggressorRatio: 0,
			cvd: 0,
			buckets: [],
			bucketMs: 60_000,
		});
		expect(text).toContain('⚠️ データ不足');
	});

	it('バケットデータがテキストに含まれる', () => {
		const bucket: FlowMetricsBucket = {
			timestampMs: 1_700_000_000_000,
			isoTime: '2023-11-14T00:00:00Z',
			displayTime: '11/14 09:00',
			buyVolume: 0.5,
			sellVolume: 0.3,
			totalVolume: 0.8,
			cvd: 0.2,
			zscore: 1.8,
			spike: 'notice',
		};
		const text = buildFlowMetricsText({
			baseSummary: 'summary',
			totalTrades: 1,
			buyVolume: 0.5,
			sellVolume: 0.3,
			netVolume: 0.2,
			aggressorRatio: 1,
			cvd: 0.2,
			buckets: [bucket],
			bucketMs: 60_000,
		});
		expect(text).toContain('11/14 09:00');
		expect(text).toContain('spike:notice');
		expect(text).toContain('cvd:0.2');
	});

	it('spike なしのバケットでは spike テキストなし', () => {
		const bucket: FlowMetricsBucket = {
			timestampMs: 1_700_000_000_000,
			isoTime: '2023-11-14T00:00:00Z',
			buyVolume: 0.5,
			sellVolume: 0.3,
			totalVolume: 0.8,
			cvd: 0.2,
			zscore: 0.5,
			spike: null,
		};
		const text = buildFlowMetricsText({
			baseSummary: 'summary',
			totalTrades: 1,
			buyVolume: 0.5,
			sellVolume: 0.3,
			netVolume: 0.2,
			aggressorRatio: 1,
			cvd: 0.2,
			buckets: [bucket],
			bucketMs: 60_000,
		});
		expect(text).not.toContain('spike:');
	});

	it('zscore が null の場合 n/a 表示', () => {
		const bucket: FlowMetricsBucket = {
			timestampMs: 1_700_000_000_000,
			isoTime: '2023-11-14T00:00:00Z',
			buyVolume: 0,
			sellVolume: 0,
			totalVolume: 0,
			cvd: 0,
			zscore: null,
			spike: null,
		};
		const text = buildFlowMetricsText({
			baseSummary: 'summary',
			totalTrades: 0,
			buyVolume: 0,
			sellVolume: 0,
			netVolume: 0,
			aggressorRatio: 0,
			cvd: 0,
			buckets: [bucket],
			bucketMs: 60_000,
		});
		expect(text).toContain('z:n/a');
	});
});
