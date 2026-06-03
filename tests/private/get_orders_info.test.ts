/**
 * get_orders_info ツールのユニットテスト。
 * 複数注文の一括取得の成功・部分取得・エラーハンドリングを検証する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFail, assertOk } from '../_assertResult.js';
import { mockBitbankError, mockBitbankSuccess } from '../fixtures/private-api.js';

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

/** 注文データ */
function orderData(id: number, side: 'buy' | 'sell' = 'buy', overrides: Record<string, unknown> = {}) {
	return {
		order_id: id,
		pair: 'btc_jpy',
		side,
		type: 'limit',
		start_amount: '0.01',
		remaining_amount: '0.01',
		executed_amount: '0',
		price: '14000000',
		average_price: '0',
		status: 'UNFILLED',
		ordered_at: 1710000000000,
		...overrides,
	};
}

describe('get_orders_info', () => {
	it('複数注文の詳細を取得して返す', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [orderData(4001), orderData(4002, 'sell')],
			}),
		);

		const { default: getOrdersInfo } = await import('../../tools/private/get_orders_info.js');
		const result = await getOrdersInfo({ pair: 'btc_jpy', order_ids: [4001, 4002] });

		assertOk(result);
		expect(result.summary).toContain('注文情報');
		expect(result.summary).toContain('2件');
		expect(result.data.orders).toHaveLength(2);
		expect(result.meta.orderCount).toBe(2);
	});

	it('注文IDとステータスをサマリーに含む', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [
					orderData(4001, 'buy', { status: 'UNFILLED' }),
					orderData(4002, 'sell', { status: 'PARTIALLY_FILLED' }),
				],
			}),
		);

		const { default: getOrdersInfo } = await import('../../tools/private/get_orders_info.js');
		const result = await getOrdersInfo({ pair: 'btc_jpy', order_ids: [4001, 4002] });

		assertOk(result);
		expect(result.summary).toContain('#4001');
		expect(result.summary).toContain('#4002');
		expect(result.summary).toContain('UNFILLED');
		expect(result.summary).toContain('PARTIALLY_FILLED');
	});

	it('一部の注文が取得できなかった場合に警告メッセージを含む', async () => {
		// 3件リクエストしたが1件のみ返却（2件は3ヶ月以上前）
		setupFetchMock(
			mockBitbankSuccess({
				orders: [orderData(4001)],
			}),
		);

		const { default: getOrdersInfo } = await import('../../tools/private/get_orders_info.js');
		const result = await getOrdersInfo({ pair: 'btc_jpy', order_ids: [4001, 4002, 4003] });

		assertOk(result);
		expect(result.summary).toContain('2件は3ヶ月以上前');
	});

	it('タイムスタンプが ISO8601 に変換される', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [orderData(4001)],
			}),
		);

		const { default: getOrdersInfo } = await import('../../tools/private/get_orders_info.js');
		const result = await getOrdersInfo({ pair: 'btc_jpy', order_ids: [4001] });

		assertOk(result);
		expect(result.summary).toMatch(/\d{4}-\d{2}-\d{2}T/);
	});

	it('認証エラーで fail を返す', async () => {
		setupFetchMock(mockBitbankError(20001), 400);

		const { default: getOrdersInfo } = await import('../../tools/private/get_orders_info.js');
		const result = await getOrdersInfo({ pair: 'btc_jpy', order_ids: [4001] });

		assertFail(result);
		expect(result.meta.errorType).toBe('authentication_error');
	});

	it('全注文が取得できた場合は警告メッセージなし', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [orderData(4001), orderData(4002)],
			}),
		);

		const { default: getOrdersInfo } = await import('../../tools/private/get_orders_info.js');
		const result = await getOrdersInfo({ pair: 'btc_jpy', order_ids: [4001, 4002] });

		assertOk(result);
		expect(result.summary).not.toContain('3ヶ月以上前');
	});

	it('非 PrivateApiError の例外で upstream_error を返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Timeout')) as unknown as typeof fetch;

		const { default: getOrdersInfo } = await import('../../tools/private/get_orders_info.js');
		const result = await getOrdersInfo({ pair: 'btc_jpy', order_ids: [4001] });

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');
		expect(result.summary).toContain('Timeout');
	});

	it('成行注文の価格が「成行」と表示される', async () => {
		const data = orderData(4001, 'buy', { type: 'market' });
		delete (data as Record<string, unknown>).price;
		setupFetchMock(mockBitbankSuccess({ orders: [data] }));

		const { default: getOrdersInfo } = await import('../../tools/private/get_orders_info.js');
		const result = await getOrdersInfo({ pair: 'btc_jpy', order_ids: [4001] });

		assertOk(result);
		expect(result.summary).toContain('成行');
	});

	it('非 JPY ペアで価格がそのまま表示される', async () => {
		setupFetchMock(mockBitbankSuccess({ orders: [orderData(4001, 'buy', { pair: 'btc_usdt', price: '45000' })] }));

		const { default: getOrdersInfo } = await import('../../tools/private/get_orders_info.js');
		const result = await getOrdersInfo({ pair: 'btc_usdt', order_ids: [4001] });

		assertOk(result);
		expect(result.summary).toContain('45000');
	});

	it('start_amount が null で executed_amount にフォールバックする', async () => {
		setupFetchMock(
			mockBitbankSuccess({ orders: [orderData(4001, 'buy', { start_amount: null, executed_amount: '0.005' })] }),
		);

		const { default: getOrdersInfo } = await import('../../tools/private/get_orders_info.js');
		const result = await getOrdersInfo({ pair: 'btc_jpy', order_ids: [4001] });

		assertOk(result);
		expect(result.summary).toContain('0.005');
	});

	it('注文が0件の場合は空リストを返す', async () => {
		setupFetchMock(mockBitbankSuccess({ orders: [] }));

		const { default: getOrdersInfo } = await import('../../tools/private/get_orders_info.js');
		const result = await getOrdersInfo({ pair: 'btc_jpy', order_ids: [4001] });

		assertOk(result);
		expect(result.data.orders).toHaveLength(0);
		expect(result.meta.orderCount).toBe(0);
	});

	it('REJECTED / TRIGGERED ステータスを受け付けて返す', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [
					orderData(4001, 'buy', { status: 'REJECTED' }),
					orderData(4002, 'sell', { status: 'TRIGGERED', type: 'stop', trigger_price: '13000000' }),
				],
			}),
		);

		const { default: getOrdersInfo } = await import('../../tools/private/get_orders_info.js');
		const result = await getOrdersInfo({ pair: 'btc_jpy', order_ids: [4001, 4002] });

		assertOk(result);
		expect(result.data.orders.map((o) => o.status)).toEqual(['REJECTED', 'TRIGGERED']);
		expect(result.summary).toContain('REJECTED');
		expect(result.summary).toContain('TRIGGERED');
	});

	it('信用 long/short 注文の position_side が schema を通過してサマリーに long/short 表記が出る', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [
					orderData(4001, 'buy', { position_side: 'long' }),
					orderData(4002, 'sell', { position_side: 'short' }),
				],
			}),
		);

		const { default: getOrdersInfo } = await import('../../tools/private/get_orders_info.js');
		const result = await getOrdersInfo({ pair: 'btc_jpy', order_ids: [4001, 4002] });

		assertOk(result);
		expect(result.data.orders[0].position_side).toBe('long');
		expect(result.data.orders[1].position_side).toBe('short');
		expect(result.summary).toContain('long');
		expect(result.summary).toContain('short');
	});

	it('現物注文では position_side が undefined になり long/short ラベルは出ない', async () => {
		setupFetchMock(mockBitbankSuccess({ orders: [orderData(4001)] }));

		const { default: getOrdersInfo } = await import('../../tools/private/get_orders_info.js');
		const result = await getOrdersInfo({ pair: 'btc_jpy', order_ids: [4001] });

		assertOk(result);
		expect(result.data.orders[0].position_side).toBeUndefined();
		expect(result.summary).not.toMatch(/\b(long|short)\b/);
	});

	it('order_ids が 31 件でも入力バリデーションを通過する（cancel_orders の 30 件上限は orders_info に適用しない）', async () => {
		const orderIds = Array.from({ length: 31 }, (_, i) => 4000 + i);
		setupFetchMock(mockBitbankSuccess({ orders: orderIds.map((id) => orderData(id)) }));

		const { default: getOrdersInfo } = await import('../../tools/private/get_orders_info.js');
		const result = await getOrdersInfo({ pair: 'btc_jpy', order_ids: orderIds });

		assertOk(result);
		expect(result.data.orders).toHaveLength(31);
		expect(result.meta.orderCount).toBe(31);
	});

	it('order_ids が 100 件（上限）でも入力バリデーションを通過する', async () => {
		const orderIds = Array.from({ length: 100 }, (_, i) => 4000 + i);
		setupFetchMock(mockBitbankSuccess({ orders: orderIds.map((id) => orderData(id)) }));

		const { default: getOrdersInfo } = await import('../../tools/private/get_orders_info.js');
		const result = await getOrdersInfo({ pair: 'btc_jpy', order_ids: orderIds });

		assertOk(result);
		expect(result.data.orders).toHaveLength(100);
	});

	it('order_ids が 101 件で validation_error を返す（防御的な上限 100 件超過）', async () => {
		const orderIds = Array.from({ length: 101 }, (_, i) => 4000 + i);

		const { default: getOrdersInfo } = await import('../../tools/private/get_orders_info.js');
		const result = await getOrdersInfo({ pair: 'btc_jpy', order_ids: orderIds });

		assertFail(result);
		expect(result.meta.errorType).toBe('validation_error');
	});
});

describe('get_orders_info — 非 PrivateApiError の generic catch', () => {
	afterEach(() => {
		vi.doUnmock('../../src/private/client.js');
	});

	it('非 PrivateApiError が投げられると upstream_error を返す', async () => {
		vi.doMock('../../src/private/client.js', () => ({
			getDefaultClient: () => ({
				post: () => {
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

		const { default: getOrdersInfo } = await import('../../tools/private/get_orders_info.js');
		const result = await getOrdersInfo({ pair: 'btc_jpy', order_ids: [4001] });

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');
		expect(result.summary).toContain('unexpected crash');
	});
});

describe('get_orders_info — handler (toolDef)', () => {
	it('handler が失敗時に result をそのまま返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fail')) as unknown as typeof fetch;

		const { toolDef } = await import('../../tools/private/get_orders_info.js');
		const result = await toolDef.handler({ pair: 'btc_jpy', order_ids: [4001] });

		expect((result as { ok: boolean }).ok).toBe(false);
	});

	it('handler が成功時に content + structuredContent を返す', async () => {
		setupFetchMock(mockBitbankSuccess({ orders: [orderData(4001)] }));

		const { toolDef } = await import('../../tools/private/get_orders_info.js');
		const result = await toolDef.handler({ pair: 'btc_jpy', order_ids: [4001] });

		expect(result).toHaveProperty('content');
		expect(result).toHaveProperty('structuredContent');
	});

	it('信用注文の position_side が content[0].text に含まれる', async () => {
		setupFetchMock(mockBitbankSuccess({ orders: [orderData(4001, 'buy', { position_side: 'long' })] }));

		const { toolDef } = await import('../../tools/private/get_orders_info.js');
		const result = (await toolDef.handler({ pair: 'btc_jpy', order_ids: [4001] })) as {
			content: { text: string }[];
		};

		expect(result.content[0].text).toContain('long');
		expect(result.content[0].text).toContain('position_side');
	});
});
