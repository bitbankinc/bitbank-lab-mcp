import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';

vi.mock('../lib/get-depth.js', () => ({
	default: vi.fn(),
}));

vi.mock('../tools/get_candles.js', () => ({
	default: vi.fn(),
}));

import getDepth from '../lib/get-depth.js';
import detectWhaleEvents, { toolDef } from '../tools/detect_whale_events.js';
import getCandles from '../tools/get_candles.js';

function depthOk(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		summary: 'depth ok',
		data: {
			asks: [
				[101, 0.8],
				[102, 1.2],
			],
			bids: [
				[99, 1.1],
				[98, 0.9],
			],
			...overrides,
		},
		meta: {},
	};
}

function candlesOk(normalized: Array<Record<string, unknown>>) {
	return {
		ok: true,
		summary: 'candles ok',
		data: {
			normalized,
		},
		meta: {},
	};
}

describe('detect_whale_events', () => {
	const mockedGetDepth = vi.mocked(getDepth);
	const mockedGetCandles = vi.mocked(getCandles);

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('inputSchema: lookback は定義済み enum のみ許可する', () => {
		const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', lookback: '3hour' });
		expect(parse).toThrow();
	});

	it('上流で asks/bids が欠損している場合は fail を返すべき', async () => {
		mockedGetDepth.mockResolvedValueOnce(
			asMockResult({
				ok: true,
				summary: 'depth ok',
				data: {},
				meta: {},
			}),
		);
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk([{ close: 100 }, { close: 105 }])));

		const res = await detectWhaleEvents('btc_jpy', '1hour', 0.51);

		expect(res.ok).toBe(false);
		expect((res.meta as { errorType?: string })?.errorType).toBe('upstream');
	});

	it('ローソク足の close が欠損していても summary に NaN を出すべきではない', async () => {
		mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
		mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk([{}, { close: 105 }])));

		const res = await detectWhaleEvents('btc_jpy', '1hour', 0.52);

		assertOk(res);
		expect(res.summary).not.toContain('NaN');
	});

	// ── 新規追加テスト ──
	// beforeEach で resetAllMocks を呼び、前テストが消費しなかった
	// mockResolvedValueOnce キューをフラッシュしてテスト間の干渉を防ぐ
	describe('branch coverage', () => {
		beforeEach(() => {
			vi.resetAllMocks();
		});

		it('不正なペアは failFromValidation を返す（errorType = "user"）', async () => {
			const res = await detectWhaleEvents('invalid_pair_xyz', '1hour', 0.5);
			assertFail(res);
			// ensurePair が返す error.type は 'user'
			expect(res.meta?.errorType).toBe('user');
		});

		it('getDepth が !ok を返す場合は fail を返す（summary は dep.summary で上書き）', async () => {
			mockedGetDepth.mockResolvedValueOnce(
				asMockResult({
					ok: false,
					summary: 'depth upstream error',
					meta: { errorType: 'upstream' },
				}),
			);

			const res = await detectWhaleEvents('btc_jpy', '1hour', 0.53);
			assertFail(res);
			// fail() は "Error: <message>" の形式で summary を生成する
			expect(res.summary).toBe('Error: depth upstream error');
			expect(res.meta?.errorType).toBe('upstream');
		});

		it('getDepth が !ok かつ summary・errorType が undefined の場合はデフォルト値を使う', async () => {
			mockedGetDepth.mockResolvedValueOnce(
				asMockResult({
					ok: false,
					summary: undefined,
					meta: {},
				}),
			);

			const res = await detectWhaleEvents('btc_jpy', '1hour', 0.54);
			assertFail(res);
			expect(res.summary).toBe('Error: depth failed');
			expect(res.meta?.errorType).toBe('internal');
		});

		it('getCandles が !ok を返す場合は fail を返す（summary は candlesRes.summary で上書き）', async () => {
			mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
			mockedGetCandles.mockResolvedValueOnce(
				asMockResult({
					ok: false,
					summary: 'candles upstream error',
					meta: { errorType: 'upstream' },
				}),
			);

			const res = await detectWhaleEvents('btc_jpy', '1hour', 0.55);
			assertFail(res);
			expect(res.summary).toBe('Error: candles upstream error');
			expect(res.meta?.errorType).toBe('upstream');
		});

		it('getCandles が !ok かつ summary・errorType が undefined の場合はデフォルト値を使う', async () => {
			mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
			mockedGetCandles.mockResolvedValueOnce(
				asMockResult({
					ok: false,
					summary: undefined,
					meta: {},
				}),
			);

			const res = await detectWhaleEvents('btc_jpy', '1hour', 0.56);
			assertFail(res);
			expect(res.summary).toBe('Error: candles failed');
			expect(res.meta?.errorType).toBe('internal');
		});

		it('analyzeTrend: buyVol > sellVol*1.2 → trend は accumulation', async () => {
			// bids に大口あり、asks は minSize 未満 → buyVol > sellVol*1.2
			mockedGetDepth.mockResolvedValueOnce(
				asMockResult(
					depthOk({
						bids: [
							[99, 2.0],
							[98, 1.5],
						],
						asks: [
							[101, 0.1],
							[102, 0.1],
						],
					}),
				),
			);
			mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk([{ close: 100 }, { close: 105 }])));

			const res = await detectWhaleEvents('btc_jpy', '1hour', 0.57);
			assertOk(res);
			expect(res.data.stats.trend).toBe('accumulation');
			expect(res.summary).toContain('accumulation');
		});

		it('analyzeTrend: sellVol > buyVol*1.2 → trend は distribution', async () => {
			// asks に大口あり、bids は minSize 未満 → sellVol > buyVol*1.2
			mockedGetDepth.mockResolvedValueOnce(
				asMockResult(
					depthOk({
						bids: [
							[99, 0.1],
							[98, 0.1],
						],
						asks: [
							[101, 2.0],
							[102, 1.5],
						],
					}),
				),
			);
			mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk([{ close: 100 }, { close: 105 }])));

			const res = await detectWhaleEvents('btc_jpy', '1hour', 0.58);
			assertOk(res);
			expect(res.data.stats.trend).toBe('distribution');
			expect(res.summary).toContain('distribution');
		});

		it('analyzeTrend: buyVol と sellVol が均衡 → trend は neutral', async () => {
			mockedGetDepth.mockResolvedValueOnce(
				asMockResult(
					depthOk({
						bids: [[99, 1.0]],
						asks: [[101, 1.0]],
					}),
				),
			);
			mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk([{ close: 100 }, { close: 105 }])));

			const res = await detectWhaleEvents('btc_jpy', '1hour', 0.59);
			assertOk(res);
			expect(res.data.stats.trend).toBe('neutral');
			expect(res.summary).toContain('neutral');
		});

		it('bestBid が null の場合（bids が空）mid は null → distancePct は null', async () => {
			mockedGetDepth.mockResolvedValueOnce(
				asMockResult(
					depthOk({
						bids: [],
						asks: [
							[101, 1.0],
							[102, 0.8],
						],
					}),
				),
			);
			mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk([{ close: 100 }, { close: 105 }])));

			const res = await detectWhaleEvents('btc_jpy', '1hour', 0.6);
			assertOk(res);
			// mid が null なので distancePct は全て null になる
			for (const event of res.data.events) {
				expect(event.distancePct).toBeNull();
			}
		});

		it('validCloses.length < 2 の場合 priceChange は 0', async () => {
			mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
			// close が1件だけ → validCloses.length < 2 → priceChange = 0
			mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk([{ close: 100 }])));

			const res = await detectWhaleEvents('btc_jpy', '1hour', 0.61);
			assertOk(res);
			// priceChange = 0 → summary に "0.00%" が含まれる
			expect(res.summary).toContain('価格変化: 0.00%');
		});

		it('totalVol = 0 の場合 buyPct/sellPct はともに 0（バーが空）', async () => {
			// minSize を非常に大きくして large orders が 0 件になるようにする
			mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
			mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk([{ close: 100 }, { close: 105 }])));

			const res = await detectWhaleEvents('btc_jpy', '1hour', 9999);
			assertOk(res);
			expect(res.data.stats.buyVolume).toBe(0);
			expect(res.data.stats.sellVolume).toBe(0);
			// バーが空の場合 0% と表示される
			expect(res.summary).toContain('(0%)');
		});

		it('lookback=30min は 5min×6本でローソク足を取得する', async () => {
			mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
			mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk([{ close: 100 }, { close: 105 }])));

			const res = await detectWhaleEvents('btc_jpy', '30min', 0.62);
			assertOk(res);
			expect(mockedGetCandles).toHaveBeenCalledWith('btc_jpy', '5min', undefined, 6);
			expect(res.summary).toContain('30min');
		});

		it('lookback=2hour は 5min×24本でローソク足を取得する', async () => {
			mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
			mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk([{ close: 100 }, { close: 105 }])));

			const res = await detectWhaleEvents('btc_jpy', '2hour', 0.63);
			assertOk(res);
			expect(mockedGetCandles).toHaveBeenCalledWith('btc_jpy', '5min', undefined, 24);
			expect(res.summary).toContain('2hour');
		});

		it('同一引数の2回目呼び出しはキャッシュヒットして getDepth を呼ばない', async () => {
			const uniqueMinSize = 0.64321;
			mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
			mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk([{ close: 100 }, { close: 105 }])));

			const res1 = await detectWhaleEvents('btc_jpy', '1hour', uniqueMinSize);
			assertOk(res1);

			// 2回目: キャッシュヒット → getDepth/getCandles は追加で呼ばれない
			const res2 = await detectWhaleEvents('btc_jpy', '1hour', uniqueMinSize);
			assertOk(res2);

			expect(mockedGetDepth).toHaveBeenCalledTimes(1);
			expect(mockedGetCandles).toHaveBeenCalledTimes(1);
		});

		it('getDepth が例外をスローした場合は failFromError を返す', async () => {
			mockedGetDepth.mockRejectedValueOnce(new Error('network error'));

			const res = await detectWhaleEvents('btc_jpy', '1hour', 0.65);
			assertFail(res);
			expect(res.meta?.errorType).toBe('internal');
		});

		// === 形成中足（provisional）注記は対象外 ===
		// 主分析は板スナップショットであり、candles は lookback の概況（priceChange）にしか使わない。
		// 最新足が形成中（ts ≈ now）でも note を付与しないことを固定する。
		it('板スナップショットのため形成中足注記は付与しない', async () => {
			mockedGetDepth.mockResolvedValueOnce(asMockResult(depthOk()));
			mockedGetCandles.mockResolvedValueOnce(
				asMockResult(
					candlesOk([
						{ close: 100, timestamp: Date.now() - 300_000 },
						{ close: 105, timestamp: Date.now() },
					]),
				),
			);

			const res = await detectWhaleEvents('btc_jpy', '1hour', 0.66);
			assertOk(res);
			expect(res.summary).not.toContain('未確定（形成中）');
			expect((res.meta as { provisional?: boolean }).provisional).toBeUndefined();
		});
	});
});
