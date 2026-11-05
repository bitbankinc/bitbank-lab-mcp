// LLM が複数ツールをクロスチェックするので、同一板の mid は経路（get_orderbook 全 mode / prepare_depth_data / lib/get-depth）によらず一致させる（丸め規約は lib/price.ts の roundMidPrice に集約）。

import { afterEach, describe, expect, it, vi } from 'vitest';
import getDepth from '../lib/get-depth.js';
import { fractionDigits, roundMidPrice, roundSpread } from '../lib/price.js';
import getOrderbook from '../tools/get_orderbook.js';
import prepareDepthData from '../tools/prepare_depth_data.js';
import { asMockResult, assertOk } from './_assertResult.js';

const TS = 1_700_000_000_000;

/** get_orderbook（直接 fetch）と prepare_depth_data / get-depth（lib/get-depth 経由 fetch）の両経路に同一スナップショットを返す。 */
function mockDepth(asks: [string, string][], bids: [string, string][]) {
	vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		asMockResult<Response>({
			ok: true,
			status: 200,
			statusText: 'OK',
			headers: new Headers(),
			json: async () => ({ success: 1, data: { asks, bids, timestamp: TS } }),
		}),
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('lib/price — 中値とスプレッドの丸め（丸め規約の単一ソース）', () => {
	it('fractionDigits: 数値の小数の桁数（指数表記も読む）', () => {
		expect(fractionDigits(5_000_000)).toBe(0);
		expect(fractionDigits(312.345)).toBe(3);
		expect(fractionDigits(31.2346)).toBe(4);
		expect(fractionDigits(1.5e-7)).toBe(8);
		expect(fractionDigits(Number.NaN)).toBe(0);
	});

	it('10 万円以上の中値は円の整数（半端は +∞ 方向）', () => {
		expect(roundMidPrice(5_000_000, 5_000_101)).toBe(5_000_051);
		expect(roundMidPrice(5_000_000, 5_000_100)).toBe(5_000_050);
	});

	it('安いペアの中値を円の整数に潰さない', () => {
		expect(roundMidPrice(312.345, 312.347)).toBe(312.346);
		expect(roundMidPrice(31.2345, 31.2347)).toBe(31.2346);
	});

	// 1,000 円台で 0.001 円刻みのペアは有効数字が 7 桁ある。価格の水準の桁（6 桁）だけで丸めると 2,500.12 になり、最良の買い気配より下に出る。
	it('刻みの細かいペアでも中値が最良気配の内側に収まる', () => {
		const mid = roundMidPrice(2500.123, 2500.124);
		expect(mid).toBeGreaterThanOrEqual(2500.123);
		expect(mid).toBeLessThanOrEqual(2500.124);
	});

	it('スプレッドは気配の桁で丸め、2 進の誤差を残さない', () => {
		expect(roundSpread(312.345, 312.346)).toBe(0.001);
		expect(roundSpread(5_000_000, 5_000_101)).toBe(101);
	});
});

describe('mid 丸め規約 — ツール間整合（同一板 → 同一 mid）', () => {
	// 偶数 spread（mid=整数）/ 奇数 spread（mid に .5 が出る）の両方を固定する。奇数ケースは再現手順そのもの（bestAsk=5000101 / bestBid=5000000 → mid=5000050.5）。
	const cases = [
		{ label: '偶数 spread (mid=整数)', bestAsk: '5000100', bestBid: '5000000', expectedMid: 5_000_050 },
		{ label: '奇数 spread (mid=.5 → 丸め)', bestAsk: '5000101', bestBid: '5000000', expectedMid: 5_000_051 },
	];

	it.each(cases)('JPY ペア: $label → 全経路 mid=$expectedMid で一致', async ({ bestAsk, bestBid, expectedMid }) => {
		const asks: [string, string][] = [
			[bestAsk, '0.2'],
			['5000200', '0.4'],
		];
		const bids: [string, string][] = [
			[bestBid, '0.3'],
			['4999900', '0.5'],
		];
		const midText = `${expectedMid.toLocaleString('ja-JP')}円`;

		mockDepth(asks, bids);

		const summary = await getOrderbook({ pair: 'btc_jpy', mode: 'summary' });
		assertOk(summary);
		expect(summary.data.normalized.mid).toBe(expectedMid);

		const stats = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics' });
		assertOk(stats);
		expect(stats.data.basic.currentPrice).toBe(expectedMid);

		const pressure = await getOrderbook({ pair: 'btc_jpy', mode: 'pressure' });
		assertOk(pressure);
		expect(pressure.data.bands[0].baseMid).toBe(expectedMid);

		const raw = await getOrderbook({ pair: 'btc_jpy', mode: 'raw' });
		assertOk(raw);
		expect(raw.summary).toContain(`中値: ${midText}`);

		const pdd = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(pdd);
		expect(pdd.data.mid).toBe(expectedMid);

		const depth = await getDepth('btc_jpy');
		assertOk(depth);
		expect(depth.summary).toContain(`中値: ${midText}`);
	});

	it('安いペア（0.0001 円刻み）: 全経路の mid が円の整数に潰れず一致し、本文も最後の桁まで出す', async () => {
		mockDepth(
			[
				['31.2347', '1000'],
				['31.2400', '2000'],
			],
			[
				['31.2345', '1500'],
				['31.2300', '2500'],
			],
		);

		const summary = await getOrderbook({ pair: 'doge_jpy', mode: 'summary' });
		const stats = await getOrderbook({ pair: 'doge_jpy', mode: 'statistics' });
		const pressure = await getOrderbook({ pair: 'doge_jpy', mode: 'pressure' });
		const raw = await getOrderbook({ pair: 'doge_jpy', mode: 'raw' });
		const pdd = await prepareDepthData({ pair: 'doge_jpy' });
		const depth = await getDepth('doge_jpy');
		assertOk(summary);
		assertOk(stats);
		assertOk(pressure);
		assertOk(raw);
		assertOk(pdd);
		assertOk(depth);

		expect(summary.data.normalized.mid).toBe(31.2346);
		expect(summary.data.normalized.spread).toBe(0.0002);
		expect(stats.data.basic.currentPrice).toBe(31.2346);
		expect(stats.data.basic.spread).toBe(0.0002);
		expect(pressure.data.bands[0].baseMid).toBe(31.2346);
		expect(pdd.data.mid).toBe(31.2346);
		expect(pdd.data.spread).toBe(0.0002);
		expect(pdd.data.bestBid).toBe(31.2345);
		expect(pdd.data.bids[0][0]).toBe(31.2345);
		for (const text of [summary.summary, raw.summary, depth.summary]) {
			expect(text).toContain('中値: 31.2346円');
			expect(text).toContain('31.2345円');
		}
	});

	it('奇数 spread: 構造化 mid（summary / statistics / pressure / prepare_depth_data）が相互に一致', async () => {
		const asks: [string, string][] = [
			['5000101', '0.2'],
			['5000200', '0.4'],
		];
		const bids: [string, string][] = [
			['5000000', '0.3'],
			['4999900', '0.5'],
		];
		mockDepth(asks, bids);

		const summary = await getOrderbook({ pair: 'btc_jpy', mode: 'summary' });
		const stats = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics' });
		const pressure = await getOrderbook({ pair: 'btc_jpy', mode: 'pressure' });
		const pdd = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(summary);
		assertOk(stats);
		assertOk(pressure);
		assertOk(pdd);

		const mids = [
			summary.data.normalized.mid,
			stats.data.basic.currentPrice,
			pressure.data.bands[0].baseMid,
			pdd.data.mid,
		];
		expect(new Set(mids).size).toBe(1);
		expect(mids[0]).toBe(5_000_051);
	});

	it('API 異常系（upstream success:0）: get_orderbook / prepare_depth_data / get-depth は fail を返す', async () => {
		// 同一の異常レスポンスを共有経路に流し、全経路が ok:false（upstream 分類）で揃うことを固定する。
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			asMockResult<Response>({
				ok: true,
				status: 200,
				statusText: 'OK',
				headers: new Headers(),
				json: async () => ({ success: 0, data: { code: 20001 } }),
			}),
		);

		const ob = await getOrderbook({ pair: 'btc_jpy', mode: 'summary' });
		expect(ob.ok).toBe(false);
		expect((ob.meta as { errorType?: string }).errorType).toBe('upstream');

		const pdd = await prepareDepthData({ pair: 'btc_jpy' });
		expect(pdd.ok).toBe(false);

		const depth = await getDepth('btc_jpy');
		expect(depth.ok).toBe(false);
	});
});
