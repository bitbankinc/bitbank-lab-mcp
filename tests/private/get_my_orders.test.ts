/**
 * get_my_orders ツールのユニットテスト。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFail, assertOk } from '../_assertResult.js';
import { mockBitbankError, mockBitbankSuccess, rawActiveOrdersResponse } from '../fixtures/private-api.js';

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

describe('get_my_orders', () => {
	it('フォーマット済みタイムスタンプの注文を返す', async () => {
		setupFetchMock(mockBitbankSuccess(rawActiveOrdersResponse));

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertOk(result);
		expect(result.data.orders).toHaveLength(2);
		// ordered_at が ISO8601 に変換されている
		for (const order of result.data.orders) {
			expect(order.ordered_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		}
	});

	it('注文がない場合のメッセージを返す', async () => {
		setupFetchMock(mockBitbankSuccess({ orders: [] }));

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertOk(result);
		expect(result.data.orders).toHaveLength(0);
		expect(result.summary).toContain('アクティブな注文はありません');
	});

	it('buy/sell の集計をサマリーに含む', async () => {
		setupFetchMock(mockBitbankSuccess(rawActiveOrdersResponse));

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertOk(result);
		expect(result.summary).toContain('買 1件');
		expect(result.summary).toContain('売 1件');
	});

	it('order_id をサマリーに含む', async () => {
		setupFetchMock(mockBitbankSuccess(rawActiveOrdersResponse));

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertOk(result);
		expect(result.summary).toContain('[ID: 2001]');
		expect(result.summary).toContain('[ID: 2002]');
	});

	it('不正な since 日付で validation_error を返す', async () => {
		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({ since: 'bad-date' });

		assertFail(result);
		expect(result.meta.errorType).toBe('validation_error');
	});

	it('PrivateApiError で fail を返す', async () => {
		setupFetchMock(mockBitbankError(20001), 400);

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertFail(result);
		expect(result.meta.errorType).toBe('authentication_error');
	});

	it('不正な end 日付で validation_error を返す', async () => {
		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({ end: 'not-a-date' });

		assertFail(result);
		expect(result.meta.errorType).toBe('validation_error');
		expect(result.summary).toContain('end');
	});

	it('非 PrivateApiError の例外で upstream_error を返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');
		expect(result.summary).toContain('fetch failed');
	});

	it('count パラメータを API に渡す', async () => {
		setupFetchMock(mockBitbankSuccess({ orders: [] }));

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		await getMyOrders({ count: 10 });

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).toContain('count=10');
	});

	it('expire_at がある注文で ISO8601 に変換される', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [
					{
						...rawActiveOrdersResponse.orders[0],
						expire_at: 1710100000000,
					},
				],
			}),
		);

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertOk(result);
		expect(result.data.orders[0].expire_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('成行注文の価格が「成行」と表示される', async () => {
		const marketOrder = { ...rawActiveOrdersResponse.orders[0], type: 'market', price: undefined };
		delete (marketOrder as Record<string, unknown>).price;
		setupFetchMock(mockBitbankSuccess({ orders: [marketOrder] }));

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertOk(result);
		expect(result.summary).toContain('成行');
	});

	it('非 JPY ペアで価格がそのまま表示される', async () => {
		const nonJpyOrder = { ...rawActiveOrdersResponse.orders[0], pair: 'btc_usdt', price: '45000' };
		setupFetchMock(mockBitbankSuccess({ orders: [nonJpyOrder] }));

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertOk(result);
		expect(result.summary).toContain('45000');
	});

	it('remaining_amount が未定義で「?」にフォールバックする', async () => {
		const order = { ...rawActiveOrdersResponse.orders[0] };
		delete (order as Record<string, unknown>).remaining_amount;
		setupFetchMock(mockBitbankSuccess({ orders: [order] }));

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertOk(result);
		expect(result.summary).toContain('?');
	});

	it('有効な since/end を unix ms に変換して API に渡す', async () => {
		setupFetchMock(mockBitbankSuccess({ orders: [] }));

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		await getMyOrders({ since: '2024-03-10T00:00:00Z', end: '2024-03-11T00:00:00Z' });

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).toContain('since=');
		expect(calledUrl).toContain('end=');
		expect(calledUrl).not.toContain('2024-03-10');
	});

	it('CANCELED_UNFILLED など非アクティブ注文をフィルタする', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [
					...rawActiveOrdersResponse.orders,
					{
						order_id: 56947594386,
						pair: 'eth_jpy',
						side: 'buy',
						type: 'limit',
						start_amount: '0.01',
						remaining_amount: '0.01',
						executed_amount: '0',
						price: '400000',
						average_price: '0',
						status: 'CANCELED_UNFILLED',
						ordered_at: 1710000200000,
					},
				],
			}),
		);

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertOk(result);
		// CANCELED_UNFILLED は除外され、UNFILLED と PARTIALLY_FILLED の 2 件のみ
		expect(result.data.orders).toHaveLength(2);
		expect(result.data.orders.map((o) => o.order_id)).not.toContain(56947594386);
		expect(result.summary).toContain('2件');
		expect(result.summary).not.toContain('CANCELED_UNFILLED');
		expect(result.meta.orderCount).toBe(2);
	});

	it('トリガー前の stop 注文（INACTIVE）をアクティブ注文として返す', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [
					{
						order_id: 56975061085,
						pair: 'eth_jpy',
						side: 'buy',
						type: 'stop',
						start_amount: '0.01',
						remaining_amount: '0.01',
						executed_amount: '0',
						trigger_price: '380000',
						average_price: '0',
						status: 'INACTIVE',
						user_cancelable: true,
						ordered_at: 1710000300000,
					},
				],
			}),
		);

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertOk(result);
		// INACTIVE は bitbank アプリで「未約定注文」として表示されるため、
		// get_my_orders からも返す必要がある（PR #393 で誤って弾いていた回帰修正）。
		expect(result.data.orders).toHaveLength(1);
		expect(result.data.orders[0].order_id).toBe(56975061085);
		expect(result.data.orders[0].status).toBe('INACTIVE');
		expect(result.summary).toContain('1件');
	});

	it('TRIGGERED 状態の stop 注文もアクティブ注文として返す', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [
					{
						order_id: 56975061086,
						pair: 'btc_jpy',
						side: 'sell',
						type: 'stop',
						start_amount: '0.001',
						remaining_amount: '0.001',
						executed_amount: '0',
						trigger_price: '15000000',
						average_price: '0',
						status: 'TRIGGERED',
						ordered_at: 1710000400000,
					},
				],
			}),
		);

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertOk(result);
		expect(result.data.orders).toHaveLength(1);
		expect(result.data.orders[0].status).toBe('TRIGGERED');
	});

	it('REJECTED は終端状態としてフィルタされる', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [
					...rawActiveOrdersResponse.orders,
					{
						order_id: 56975061099,
						pair: 'eth_jpy',
						side: 'buy',
						type: 'limit',
						start_amount: '0.01',
						remaining_amount: '0.01',
						executed_amount: '0',
						price: '400000',
						average_price: '0',
						status: 'REJECTED',
						ordered_at: 1710000600000,
					},
				],
			}),
		);

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertOk(result);
		// REJECTED は終端ステータスなので ACTIVE_STATUSES から除外される
		expect(result.data.orders).toHaveLength(2);
		expect(result.data.orders.map((o) => o.order_id)).not.toContain(56975061099);
	});

	it('FULLY_FILLED は終端状態として除外する', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [
					{
						order_id: 56975061087,
						pair: 'eth_jpy',
						side: 'buy',
						type: 'limit',
						start_amount: '0.01',
						remaining_amount: '0',
						executed_amount: '0.01',
						price: '380000',
						average_price: '380000',
						status: 'FULLY_FILLED',
						ordered_at: 1710000500000,
					},
				],
			}),
		);

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertOk(result);
		expect(result.data.orders).toHaveLength(0);
	});

	it('pair 指定なしで「全ペア」ラベルが表示される', async () => {
		setupFetchMock(mockBitbankSuccess(rawActiveOrdersResponse));

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertOk(result);
		expect(result.summary).toContain('全ペア');
	});

	it('信用 long 注文の position_side が data に保持されサマリーに long 表記が出る', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [
					{
						order_id: 7001,
						pair: 'btc_jpy',
						side: 'buy',
						position_side: 'long',
						type: 'limit',
						start_amount: '0.01',
						remaining_amount: '0.01',
						executed_amount: '0',
						price: '14000000',
						average_price: '0',
						status: 'UNFILLED',
						ordered_at: 1710000000000,
					},
				],
			}),
		);

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertOk(result);
		expect(result.data.orders).toHaveLength(1);
		expect(result.data.orders[0].position_side).toBe('long');
		expect(result.summary).toContain('long');
	});

	it('信用 short 注文のサマリーに short 表記が出る', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [
					{
						order_id: 7002,
						pair: 'btc_jpy',
						side: 'sell',
						position_side: 'short',
						type: 'limit',
						start_amount: '0.01',
						remaining_amount: '0.01',
						executed_amount: '0',
						price: '15000000',
						average_price: '0',
						status: 'UNFILLED',
						ordered_at: 1710000000000,
					},
				],
			}),
		);

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertOk(result);
		expect(result.data.orders[0].position_side).toBe('short');
		expect(result.summary).toContain('short');
	});

	it('現物注文では position_side が undefined になり long/short ラベルは出ない', async () => {
		setupFetchMock(mockBitbankSuccess(rawActiveOrdersResponse));

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertOk(result);
		for (const o of result.data.orders) {
			expect(o.position_side).toBeUndefined();
		}
		expect(result.summary).not.toMatch(/\b(long|short)\b/);
	});
});

describe('get_my_orders — handler (toolDef)', () => {
	it('handler が成功時に content + structuredContent を返す', async () => {
		setupFetchMock(mockBitbankSuccess(rawActiveOrdersResponse));

		const { toolDef } = await import('../../tools/private/get_my_orders.js');
		const result = await toolDef.handler({});

		expect(result).toHaveProperty('content');
		expect(result).toHaveProperty('structuredContent');
	});

	it('handler が失敗時に result をそのまま返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fail')) as unknown as typeof fetch;

		const { toolDef } = await import('../../tools/private/get_my_orders.js');
		const result = await toolDef.handler({});

		expect((result as { ok: boolean }).ok).toBe(false);
	});

	it('content[0].text に summary と data JSON が含まれ、LLM が orders 配列にアクセスできる', async () => {
		setupFetchMock(mockBitbankSuccess(rawActiveOrdersResponse));

		const { toolDef } = await import('../../tools/private/get_my_orders.js');
		const result = (await toolDef.handler({})) as { content: { text: string }[] };

		expect(result.content[0].text).toContain('アクティブ注文');
		expect(result.content[0].text).toContain('"orders"');
		expect(result.content[0].text).toContain('"timestamp"');
	});
});

describe('get_my_orders — 非 PrivateApiError の generic catch', () => {
	afterEach(() => {
		vi.doUnmock('../../src/private/client.js');
	});

	it('getDefaultClient が非 PrivateApiError を投げると upstream_error を返す', async () => {
		vi.doMock('../../src/private/client.js', () => ({
			getDefaultClient: () => ({
				get: () => {
					throw new Error('unexpected crash');
				},
			}),
			PrivateApiError: class extends Error {
				errorType: string;
				constructor(msg: string, errorType: string) {
					super(msg);
					this.errorType = errorType;
				}
			},
		}));

		const { default: getMyOrders } = await import('../../tools/private/get_my_orders.js');
		const result = await getMyOrders({});

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');
		expect(result.summary).toContain('unexpected crash');
	});
});
