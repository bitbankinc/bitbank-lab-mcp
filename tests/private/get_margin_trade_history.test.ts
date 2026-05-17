/**
 * get_margin_trade_history ツールのユニットテスト。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFail, assertOk } from '../_assertResult.js';
import { mockBitbankError, mockBitbankSuccess, rawMarginTradeHistoryResponse } from '../fixtures/private-api.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env.BITBANK_API_KEY;
	delete process.env.BITBANK_API_SECRET;
	vi.resetModules();
});

function setupFetchMock(response: unknown, status = 200) {
	globalThis.fetch = vi
		.fn()
		.mockResolvedValue(new Response(JSON.stringify(response), { status })) as unknown as typeof fetch;
}

describe('get_margin_trade_history', () => {
	it('信用約定履歴を返す', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginTradeHistoryResponse));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.data.trades).toHaveLength(3);
		expect(result.meta.tradeCount).toBe(3);
	});

	it('type=margin パラメータを API に渡す', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		await getMarginTradeHistory({});

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).toContain('type=margin');
	});

	it('executed_at を ISO8601 に変換する', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginTradeHistoryResponse));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		for (const trade of result.data.trades) {
			expect(trade.executed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		}
	});

	it('position_side をサマリーに含む', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginTradeHistoryResponse));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.summary).toContain('ロング');
		expect(result.summary).toContain('ショート');
	});

	it('決済時の profit_loss をサマリーに含む', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginTradeHistoryResponse));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.summary).toContain('損益');
		expect(result.summary).toContain('5,000');
	});

	it('pair 指定を API に渡す', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		await getMarginTradeHistory({ pair: 'btc_jpy' });

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).toContain('pair=btc_jpy');
	});

	it('count パラメータを API に渡す', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		await getMarginTradeHistory({ count: 50 });

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).toContain('count=50');
	});

	it('不正な since 日付で validation_error を返す', async () => {
		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ since: 'bad-date' });

		assertFail(result);
		expect(result.meta.errorType).toBe('validation_error');
		expect(result.summary).toContain('since');
	});

	it('不正な end 日付で validation_error を返す', async () => {
		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ end: 'not-a-date' });

		assertFail(result);
		expect(result.meta.errorType).toBe('validation_error');
		expect(result.summary).toContain('end');
	});

	it('有効な since/end を unix ms に変換して API に渡す', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		await getMarginTradeHistory({ since: '2024-03-10T00:00:00Z', end: '2024-03-11T00:00:00Z' });

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).toContain('since=');
		expect(calledUrl).toContain('end=');
		expect(calledUrl).not.toContain('2024-03-10');
	});

	it('ロング/ショートの集計をサマリーに含む', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginTradeHistoryResponse));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.summary).toContain('ロング 2件');
		expect(result.summary).toContain('ショート 1件');
	});

	it('10 件超の trades で省略表示される', async () => {
		const manyTrades = {
			trades: Array.from({ length: 15 }, (_, i) => ({
				trade_id: 400 + i,
				pair: 'btc_jpy',
				order_id: 4000 + i,
				side: 'buy',
				position_side: 'long',
				type: 'limit',
				amount: '0.01',
				price: '15000000',
				maker_taker: 'maker',
				fee_amount_base: '0.00001',
				fee_amount_quote: '0',
				executed_at: 1710000000000 + i * 1000,
			})),
		};
		setupFetchMock(mockBitbankSuccess(manyTrades));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.data.trades).toHaveLength(15);
		expect(result.meta.tradeCount).toBe(15);
		expect(result.summary).toContain('他 5件');
	});

	it('order=asc 時は末尾 10 件を表示する', async () => {
		const manyTrades = {
			trades: Array.from({ length: 12 }, (_, i) => ({
				trade_id: 500 + i,
				pair: 'btc_jpy',
				order_id: 5000 + i,
				side: 'buy',
				position_side: 'long',
				type: 'limit',
				amount: '0.01',
				price: '15000000',
				maker_taker: 'maker',
				fee_amount_base: '0.00001',
				fee_amount_quote: '0',
				executed_at: 1710000000000 + i * 1000,
			})),
		};
		setupFetchMock(mockBitbankSuccess(manyTrades));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ order: 'asc' });

		assertOk(result);
		// asc 時は末尾 10 件（trade_id 502〜511）が表示される
		expect(result.summary).toContain('trade: 502');
		expect(result.summary).not.toContain('trade: 500]');
		expect(result.summary).not.toContain('trade: 501]');
	});

	it('count がデフォルト値 (20) の場合はパラメータを送らない', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		await getMarginTradeHistory({});

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).not.toContain('count=');
	});

	it('order がデフォルト値 (desc) の場合はパラメータを送らない', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		await getMarginTradeHistory({});

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).not.toContain('order=');
	});

	it('order=asc を API に渡す', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		await getMarginTradeHistory({ order: 'asc' });

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).toContain('order=asc');
	});

	it('profit_loss がないトレード（新規建て）は損益を表示しない', async () => {
		const openOnly = {
			trades: [
				{
					trade_id: 601,
					pair: 'btc_jpy',
					order_id: 6001,
					side: 'buy',
					position_side: 'long',
					type: 'limit',
					amount: '0.01',
					price: '15000000',
					maker_taker: 'maker',
					fee_amount_base: '0.00001',
					fee_amount_quote: '0',
					executed_at: 1710000000000,
				},
			],
		};
		setupFetchMock(mockBitbankSuccess(openOnly));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.summary).not.toContain('損益');
	});

	it('fee_occurred_amount_quote が API レスポンスに含まれる場合、出力に伝播する', async () => {
		const response = {
			trades: [
				{
					trade_id: 801,
					pair: 'btc_jpy',
					order_id: 8001,
					side: 'sell',
					position_side: 'long',
					type: 'market',
					amount: '0.01',
					price: '15500000',
					maker_taker: 'taker',
					fee_amount_base: '0',
					fee_amount_quote: '500',
					fee_occurred_amount_quote: '500',
					executed_at: 1710000000000,
				},
			],
		};
		setupFetchMock(mockBitbankSuccess(response));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.data.trades[0].fee_occurred_amount_quote).toBe('500');
	});

	it('fee_occurred_amount_quote が API レスポンスに含まれない場合、undefined を伝播する（fallback しない）', async () => {
		const response = {
			trades: [
				{
					trade_id: 802,
					pair: 'btc_jpy',
					order_id: 8002,
					side: 'sell',
					position_side: 'long',
					type: 'market',
					amount: '0.01',
					price: '15500000',
					maker_taker: 'taker',
					fee_amount_base: '0',
					fee_amount_quote: '500',
					executed_at: 1710000000000,
				},
			],
		};
		setupFetchMock(mockBitbankSuccess(response));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.data.trades[0].fee_occurred_amount_quote).toBeUndefined();
		// fallback で fee_amount_quote の値で埋めないことを明示的にアサート
		expect(result.data.trades[0].fee_occurred_amount_quote).not.toBe(result.data.trades[0].fee_amount_quote);
	});

	it('空の trades で 0 件メッセージを返す', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.data.trades).toHaveLength(0);
		expect(result.meta.tradeCount).toBe(0);
		expect(result.summary).toContain('0件');
	});

	it('現物 (position_side 欠損) が混在しても信用のみを返し集計もフィルタ後の値', async () => {
		// 公式 docs に type=margin パラメータの記載がなく、API が無視した場合の防御。
		// position_side == null の現物約定が混入しても、フィルタで信用のみが残ること、
		// および「ロング X件 / ショート Y件」の集計もフィルタ後の値であることを検証する。
		const mixed = {
			trades: [
				{
					trade_id: 701,
					pair: 'btc_jpy',
					order_id: 7001,
					side: 'buy',
					position_side: 'long',
					type: 'limit',
					amount: '0.01',
					price: '15000000',
					maker_taker: 'maker',
					fee_amount_base: '0.00001',
					fee_amount_quote: '0',
					executed_at: 1710000000000,
				},
				// 現物約定（position_side なし）。フィルタで除外されるべき
				{
					trade_id: 702,
					pair: 'btc_jpy',
					order_id: 7002,
					side: 'buy',
					type: 'limit',
					amount: '0.01',
					price: '15000000',
					maker_taker: 'maker',
					fee_amount_base: '0.00001',
					fee_amount_quote: '0',
					fee_occurred_amount_quote: '500', // 現物の手数料が margin_fee に混入してはいけない
					executed_at: 1710000001000,
				},
				{
					trade_id: 703,
					pair: 'eth_jpy',
					order_id: 7003,
					side: 'sell',
					position_side: 'short',
					type: 'limit',
					amount: '1.0',
					price: '400000',
					maker_taker: 'maker',
					fee_amount_base: '0.001',
					fee_amount_quote: '0',
					executed_at: 1710000002000,
				},
			],
		};
		setupFetchMock(mockBitbankSuccess(mixed));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		// 現物が除外され信用 2 件のみ
		expect(result.data.trades).toHaveLength(2);
		expect(result.meta.tradeCount).toBe(2);
		const ids = result.data.trades.map((t) => t.trade_id);
		expect(ids).toEqual([701, 703]);
		// 全レコードに position_side が付与されている
		for (const t of result.data.trades) {
			expect(t.position_side).toBeDefined();
		}
		// 集計はフィルタ後の数（ロング 1 / ショート 1）
		expect(result.summary).toContain('信用約定履歴');
		expect(result.summary).toContain('2件');
		expect(result.summary).toContain('ロング 1件');
		expect(result.summary).toContain('ショート 1件');
	});

	it('全件現物（position_side 欠損）のレスポンスは 0 件メッセージを返す', async () => {
		const spotOnly = {
			trades: [
				{
					trade_id: 801,
					pair: 'btc_jpy',
					order_id: 8001,
					side: 'buy',
					type: 'limit',
					amount: '0.01',
					price: '15000000',
					maker_taker: 'maker',
					fee_amount_base: '0.00001',
					fee_amount_quote: '0',
					executed_at: 1710000000000,
				},
			],
		};
		setupFetchMock(mockBitbankSuccess(spotOnly));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.data.trades).toHaveLength(0);
		expect(result.meta.tradeCount).toBe(0);
		expect(result.summary).toContain('0件');
	});

	it('PrivateApiError で fail を返す', async () => {
		setupFetchMock(mockBitbankError(20001), 400);

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertFail(result);
		expect(result.meta.errorType).toBe('authentication_error');
	});

	it('非 PrivateApiError の例外で upstream_error を返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');
		expect(result.summary).toContain('fetch failed');
	});
});

describe('get_margin_trade_history — handler (toolDef)', () => {
	it('handler がデフォルト引数で動作する', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginTradeHistoryResponse));

		const { toolDef } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await toolDef.handler({});

		expect((result as { ok: boolean }).ok).toBe(true);
	});
});
