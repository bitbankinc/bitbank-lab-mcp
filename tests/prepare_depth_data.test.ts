import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrepareDepthDataOutputSchema } from '../src/schemas.js';
import prepareDepthData, { toolDef } from '../tools/prepare_depth_data.js';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';

vi.mock('../lib/get-depth.js', () => ({ default: vi.fn() }));

import getDepth from '../lib/get-depth.js';

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
			timestamp: 1700000000000,
			...overrides,
		},
		meta: {},
	};
}

describe('prepare_depth_data', () => {
	const mockedGetDepth = vi.mocked(getDepth);

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ── スキーマ ─────────────────────────────────────────

	it('inputSchema: levels < 10 を拒否', () => {
		expect(() => toolDef.inputSchema.parse({ pair: 'btc_jpy', levels: 9 })).toThrow();
	});

	it('inputSchema: levels > 1000 を拒否', () => {
		expect(() => toolDef.inputSchema.parse({ pair: 'btc_jpy', levels: 1001 })).toThrow();
	});

	it('inputSchema: bandPct > 1 を拒否', () => {
		expect(() => toolDef.inputSchema.parse({ pair: 'btc_jpy', bandPct: 1.5 })).toThrow();
	});

	it('inputSchema: bandPct <= 0 を拒否', () => {
		expect(() => toolDef.inputSchema.parse({ pair: 'btc_jpy', bandPct: 0 })).toThrow();
	});

	it('inputSchema: デフォルト値が適用される', () => {
		const parsed = toolDef.inputSchema.parse({});
		expect(parsed.pair).toBe('btc_jpy');
		expect(parsed.levels).toBe(200);
		expect(parsed.bandPct).toBe(0.01);
	});

	// ── 正常系 ───────────────────────────────────────────

	it('正常データで [price, cumulativeVolume] 配列を返す', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(res);

		expect(Array.isArray(res.data.bids)).toBe(true);
		expect(Array.isArray(res.data.asks)).toBe(true);
		expect(res.data.bids).toHaveLength(5);
		expect(res.data.asks).toHaveLength(5);
		// 各要素は [price, cumulativeVolume] のタプル
		for (const [p, q] of res.data.bids) {
			expect(typeof p).toBe('number');
			expect(typeof q).toBe('number');
		}
	});

	it('bids は価格降順、asks は価格昇順でソート', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(res);

		// bids: 9900 > 9800 > 9700 > 9600 > 9500
		expect(res.data.bids[0][0]).toBe(9900);
		expect(res.data.bids[4][0]).toBe(9500);
		for (let i = 0; i < res.data.bids.length - 1; i++) {
			expect(res.data.bids[i][0]).toBeGreaterThan(res.data.bids[i + 1][0]);
		}
		// asks: 10100 < 10200 < 10300 < 10400 < 10500
		expect(res.data.asks[0][0]).toBe(10100);
		expect(res.data.asks[4][0]).toBe(10500);
		for (let i = 0; i < res.data.asks.length - 1; i++) {
			expect(res.data.asks[i][0]).toBeLessThan(res.data.asks[i + 1][0]);
		}
	});

	it('累積 volume が単調非減少', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(res);

		// bids: 0.3 → 0.9 → 2.1 → 2.6 → 3.0
		expect(res.data.bids[0][1]).toBeCloseTo(0.3);
		expect(res.data.bids[1][1]).toBeCloseTo(0.9);
		expect(res.data.bids[4][1]).toBeCloseTo(3.0);
		for (let i = 0; i < res.data.bids.length - 1; i++) {
			expect(res.data.bids[i + 1][1]).toBeGreaterThanOrEqual(res.data.bids[i][1]);
		}
		// asks: 0.2 → 0.7 → 1.7 → 2.5 → 2.8
		expect(res.data.asks[0][1]).toBeCloseTo(0.2);
		expect(res.data.asks[4][1]).toBeCloseTo(2.8);
		for (let i = 0; i < res.data.asks.length - 1; i++) {
			expect(res.data.asks[i + 1][1]).toBeGreaterThanOrEqual(res.data.asks[i][1]);
		}
	});

	it('bestBid / bestAsk / mid / spread を正しく算出', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(res);

		expect(res.data.bestBid).toBe(9900);
		expect(res.data.bestAsk).toBe(10100);
		expect(res.data.mid).toBe(10000);
		expect(res.data.spread).toBe(200);
		expect(res.data.spreadPct).toBeCloseTo(0.02);
	});

	it('totalBidVolume / totalAskVolume が累積末尾と一致', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(res);

		expect(res.data.totalBidVolume).toBeCloseTo(3.0);
		expect(res.data.totalAskVolume).toBeCloseTo(2.8);
		expect(res.data.totalBidVolume).toBeCloseTo(res.data.bids.at(-1)?.[1] ?? 0);
		expect(res.data.totalAskVolume).toBeCloseTo(res.data.asks.at(-1)?.[1] ?? 0);
	});

	it('band: ±1% 範囲（mid=10000 → 9900-10100）の集計', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(res);

		// ±1% = 9900〜10100 → bid: 9900 の 0.3 のみ、ask: 10100 の 0.2 のみ
		expect(res.data.band.pct).toBe(0.01);
		expect(res.data.band.bidVolume).toBeCloseTo(0.3);
		expect(res.data.band.askVolume).toBeCloseTo(0.2);
		expect(res.data.band.ratio).toBeCloseTo(1.5); // 0.3 / 0.2
	});

	it('bandPct を広げると集計範囲が広がる', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await prepareDepthData({ pair: 'btc_jpy', bandPct: 0.05 });
		assertOk(res);

		// ±5% = 9500〜10500 → 全レベル対象
		expect(res.data.band.pct).toBe(0.05);
		expect(res.data.band.bidVolume).toBeCloseTo(3.0);
		expect(res.data.band.askVolume).toBeCloseTo(2.8);
	});

	it('JPY ペアの価格は整数に丸められる', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(res);

		for (const [p] of res.data.bids) expect(Number.isInteger(p)).toBe(true);
		for (const [p] of res.data.asks) expect(Number.isInteger(p)).toBe(true);
		expect(Number.isInteger(res.data.bestBid ?? 0)).toBe(true);
		expect(Number.isInteger(res.data.mid ?? 0)).toBe(true);
	});

	it('meta に pair / fetchedAt / levels / volumeUnit を含む', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(res);

		expect(res.meta.pair).toBe('btc_jpy');
		expect(typeof res.meta.fetchedAt).toBe('string');
		expect(res.meta.levels).toEqual({ bids: 5, asks: 5 });
		expect(res.meta.volumeUnit).toBe('BTC');
	});

	it('eth_jpy では volumeUnit が ETH', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await prepareDepthData({ pair: 'eth_jpy' });
		assertOk(res);
		expect(res.meta.volumeUnit).toBe('ETH');
	});

	it('timestamp と isoTime を data に含む', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(res);
		expect(res.data.timestamp).toBe(1700000000000);
		expect(res.data.isoTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	// ── エッジケース ─────────────────────────────────────

	it('空配列: bids/asks 両方空 → fail', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk({ asks: [], bids: [] })));
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
	});

	it('片側のみ: asks のみ → fail', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult(
				depthOk({
					asks: [
						['10100', '1.0'],
						['10200', '2.0'],
					],
					bids: [],
				}),
			),
		);
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertFail(res);
	});

	it('片側のみ: bids のみ → fail', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult(
				depthOk({
					asks: [],
					bids: [
						['9900', '1.0'],
						['9800', '2.0'],
					],
				}),
			),
		);
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertFail(res);
	});

	it('単一レベル: 各側 1 レベルのみでも正常処理', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult(
				depthOk({
					asks: [['10100', '0.5']],
					bids: [['9900', '0.5']],
				}),
			),
		);
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(res);
		expect(res.data.bids).toEqual([[9900, 0.5]]);
		expect(res.data.asks).toEqual([[10100, 0.5]]);
		expect(res.data.totalBidVolume).toBe(0.5);
		expect(res.data.totalAskVolume).toBe(0.5);
	});

	it('重複価格レベル: それぞれの size が累積される', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult(
				depthOk({
					bids: [
						['9900', '0.3'],
						['9900', '0.2'],
						['9800', '0.5'],
					],
					asks: [['10100', '1.0']],
				}),
			),
		);
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(res);
		// 9900 が連続しても累積に含まれる
		expect(res.data.totalBidVolume).toBeCloseTo(1.0);
	});

	// ── NaN ガード（崩れた string 値の drop） ─────────────

	it('NaN ガード: bids に "abc" 等の崩れた string が混入 → NaN 行が drop され、有効行で累積', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult(
				depthOk({
					bids: [
						['9900', '0.3'],
						['abc', '0.5'], // price NaN → drop
						['9800', 'xyz'], // size NaN → drop
						['9700', '0.7'],
					],
					asks: [
						['10100', '0.4'],
						['10200', '0.6'],
					],
				}),
			),
		);
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(res);

		// 有効行 (9900, 9700) のみが累積に含まれる
		expect(res.data.bids).toHaveLength(2);
		expect(res.data.bids[0]).toEqual([9900, 0.3]);
		expect(res.data.bids[1]).toEqual([9700, 1.0]); // 累積 0.3 + 0.7
		expect(res.data.totalBidVolume).toBeCloseTo(1.0);

		// drop 件数が meta.droppedRows に記録される
		expect(res.meta.droppedRows).toEqual({ bids: 2, asks: 0 });
		expect(typeof res.meta.warning).toBe('string');
		expect(res.meta.warning).toContain('2件');
	});

	it('NaN ガード: 出力に NaN / Infinity / -Infinity が一切混入しない', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult(
				depthOk({
					bids: [
						['9900', '0.3'],
						['', '0.5'], // price empty → Number('') = 0 だが Number.isFinite(0) = true なので残る
						['9800', null], // size null → Number(null) = 0 → 残る
						['NaN', '0.7'], // Number('NaN') = NaN → drop
						['9700', undefined], // Number(undefined) = NaN → drop
					],
					asks: [
						['10100', 'Infinity'], // Number('Infinity') = Infinity → drop
						['10200', '0.6'],
					],
				}),
			),
		);
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(res);

		// 再帰的に値を検査
		const hasNonFinite = (v: unknown): boolean => {
			if (typeof v === 'number') return !Number.isFinite(v);
			if (Array.isArray(v)) return v.some(hasNonFinite);
			if (v && typeof v === 'object') return Object.values(v).some(hasNonFinite);
			return false;
		};
		expect(hasNonFinite(res.data)).toBe(false);
	});

	it('NaN ガード: drop 件数が summary（content テキスト）に出力される', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult(
				depthOk({
					bids: [
						['9900', '0.3'],
						['abc', '0.5'],
					],
					asks: [
						['10100', '0.4'],
						['xyz', '0.5'],
						['fail', '0.6'],
					],
				}),
			),
		);
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(res);
		// summary に warning が含まれる（合計 3 件）
		expect(res.summary).toContain('3件');
		expect(res.summary).toContain('bids: 1件');
		expect(res.summary).toContain('asks: 2件');
		expect(res.meta.droppedRows).toEqual({ bids: 1, asks: 2 });
	});

	it('NaN ガード: 全件 NaN（片側でも）→ upstream fail', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult(
				depthOk({
					bids: [
						['abc', 'def'],
						['NaN', 'NaN'],
					],
					asks: [['10100', '1.0']],
				}),
			),
		);
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
		expect(res.summary).toContain('数値変換');
	});

	it('NaN ガード: 全件 NaN（両側）→ upstream fail', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult(
				depthOk({
					bids: [['abc', 'def']],
					asks: [['xyz', 'foo']],
				}),
			),
		);
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
	});

	it('NaN ガード: 正常データでは droppedRows / warning は省略される', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(res);
		expect(res.meta.droppedRows).toBeUndefined();
		expect(res.meta.warning).toBeUndefined();
		// summary に warning マークが付かない
		expect(res.summary).not.toContain('⚠️');
	});

	// ── 出力スキーマ検証 ─────────────────────────────────

	it('スキーマ検証: 正常データの出力が PrepareDepthDataOutputSchema.parse() を通る', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		expect(() => PrepareDepthDataOutputSchema.parse(res)).not.toThrow();
	});

	it('スキーマ検証: drop 発生時の出力が PrepareDepthDataOutputSchema.parse() を通る', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult(
				depthOk({
					bids: [
						['9900', '0.3'],
						['abc', '0.5'],
					],
					asks: [['10100', '0.4']],
				}),
			),
		);
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		expect(() => PrepareDepthDataOutputSchema.parse(res)).not.toThrow();
	});

	it('スキーマ検証: 空配列 fail の出力が PrepareDepthDataOutputSchema.parse() を通る', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk({ asks: [], bids: [] })));
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		expect(() => PrepareDepthDataOutputSchema.parse(res)).not.toThrow();
	});

	it('スキーマ検証: 全件 NaN fail の出力が PrepareDepthDataOutputSchema.parse() を通る', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult(
				depthOk({
					bids: [['abc', 'def']],
					asks: [['xyz', 'foo']],
				}),
			),
		);
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		expect(() => PrepareDepthDataOutputSchema.parse(res)).not.toThrow();
	});

	// ── 入力バリデーション ───────────────────────────────

	it('不正な pair → fail', async () => {
		const res = await prepareDepthData({ pair: 'invalid!!!' });
		assertFail(res);
	});

	// ── API 異常系 ───────────────────────────────────────

	it('getDepth 失敗 → fail を伝搬', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult({ ok: false, summary: 'Error: API error', meta: { errorType: 'api' } }),
		);
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertFail(res);
		expect(res.summary).toContain('API error');
	});

	it('getDepth が例外投げる → fail', async () => {
		mockedGetDepth.mockRejectedValueOnce(new TypeError('fetch failed'));
		const res = await prepareDepthData({ pair: 'btc_jpy' });
		assertFail(res);
	});

	// ── toolDef.handler（content テキスト） ─────────────

	it('handler: content テキストに summary と JSON データを含む', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		const res = (await toolDef.handler({ pair: 'btc_jpy' })) as {
			content: Array<{ text: string }>;
			structuredContent: { ok: boolean };
		};
		expect(res.content).toBeDefined();
		expect(res.content[0].text).toContain('btc_jpy depth data');
		expect(res.content[0].text).toContain('"bids"');
		expect(res.content[0].text).toContain('"asks"');
		expect(res.content[0].text).toContain('"mid"');
		expect(res.structuredContent.ok).toBe(true);
	});

	it('handler: 失敗時はそのまま fail 結果を返す', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult({ ok: false, summary: 'Error: fail', meta: { errorType: 'api' } }),
		);
		const res = (await toolDef.handler({ pair: 'btc_jpy' })) as { ok: boolean };
		expect(res.ok).toBe(false);
	});

	it('handler: drop 発生時、content テキストに警告メッセージが含まれる', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult(
				depthOk({
					bids: [
						['9900', '0.3'],
						['abc', '0.5'],
					],
					asks: [['10100', '0.4']],
				}),
			),
		);
		const res = (await toolDef.handler({ pair: 'btc_jpy' })) as {
			content: Array<{ text: string }>;
			structuredContent: { ok: boolean; meta: { droppedRows?: { bids: number; asks: number }; warning?: string } };
		};
		// content テキスト（LLM が読める部分）に drop 件数の警告が出る
		expect(res.content[0].text).toContain('⚠️');
		expect(res.content[0].text).toContain('1件');
		// structuredContent.meta にも残る（プログラム読み取り用）
		expect(res.structuredContent.meta.droppedRows).toEqual({ bids: 1, asks: 0 });
		expect(typeof res.structuredContent.meta.warning).toBe('string');
	});
});
