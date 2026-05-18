/**
 * get_order ツールのユニットテスト。
 * 注文詳細取得の成功・エラーハンドリングを検証する。
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

/** 注文レスポンスデータ */
function orderResponse(overrides: Record<string, unknown> = {}) {
	return {
		order_id: 2001,
		pair: 'btc_jpy',
		side: 'buy',
		type: 'limit',
		start_amount: '0.01',
		remaining_amount: '0.005',
		executed_amount: '0.005',
		price: '14000000',
		average_price: '14000000',
		status: 'PARTIALLY_FILLED',
		ordered_at: 1710000000000,
		...overrides,
	};
}

describe('get_order', () => {
	it('注文詳細を取得して整形されたサマリーを返す', async () => {
		setupFetchMock(mockBitbankSuccess(orderResponse()));

		const { default: getOrder } = await import('../../tools/private/get_order.js');
		const result = await getOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertOk(result);
		expect(result.summary).toContain('注文詳細');
		expect(result.summary).toContain('BTC/JPY');
		expect(result.summary).toContain('2001');
		expect(result.summary).toContain('買');
		expect(result.summary).toContain('PARTIALLY_FILLED');
	});

	it('タイムスタンプが ISO8601 に変換される', async () => {
		setupFetchMock(mockBitbankSuccess(orderResponse()));

		const { default: getOrder } = await import('../../tools/private/get_order.js');
		const result = await getOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertOk(result);
		expect(result.summary).toMatch(/\d{4}-\d{2}-\d{2}T/);
	});

	it('平均約定価格が 0 でなければ表示する', async () => {
		setupFetchMock(mockBitbankSuccess(orderResponse({ average_price: '14500000' })));

		const { default: getOrder } = await import('../../tools/private/get_order.js');
		const result = await getOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertOk(result);
		expect(result.summary).toContain('平均約定価格');
	});

	it('平均約定価格が 0 なら表示しない', async () => {
		setupFetchMock(mockBitbankSuccess(orderResponse({ average_price: '0' })));

		const { default: getOrder } = await import('../../tools/private/get_order.js');
		const result = await getOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertOk(result);
		expect(result.summary).not.toContain('平均約定価格');
	});

	it('トリガー価格があれば表示する', async () => {
		const data = orderResponse({ type: 'stop', trigger_price: '13000000' });
		delete (data as Record<string, unknown>).price;
		setupFetchMock(mockBitbankSuccess(data));

		const { default: getOrder } = await import('../../tools/private/get_order.js');
		const result = await getOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertOk(result);
		expect(result.summary).toContain('トリガー価格');
	});

	it('キャンセル済み注文のキャンセル日時を表示', async () => {
		setupFetchMock(mockBitbankSuccess(orderResponse({ status: 'CANCELED_UNFILLED', canceled_at: 1710001000000 })));

		const { default: getOrder } = await import('../../tools/private/get_order.js');
		const result = await getOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertOk(result);
		expect(result.summary).toContain('キャンセル日時');
	});

	it('売注文で「売」ラベルが表示される', async () => {
		setupFetchMock(mockBitbankSuccess(orderResponse({ side: 'sell' })));

		const { default: getOrder } = await import('../../tools/private/get_order.js');
		const result = await getOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertOk(result);
		expect(result.summary).toContain('売');
	});

	it('認証エラーで fail を返す', async () => {
		setupFetchMock(mockBitbankError(20001), 400);

		const { default: getOrder } = await import('../../tools/private/get_order.js');
		const result = await getOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertFail(result);
		expect(result.meta.errorType).toBe('authentication_error');
	});

	it('成行注文の価格表示が「成行」になる', async () => {
		const data = orderResponse({ type: 'market', average_price: '14200000' });
		delete (data as Record<string, unknown>).price;
		setupFetchMock(mockBitbankSuccess(data));

		const { default: getOrder } = await import('../../tools/private/get_order.js');
		const result = await getOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertOk(result);
		expect(result.summary).toContain('成行');
	});

	it('非 PrivateApiError の例外で upstream_error を返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('DNS error')) as unknown as typeof fetch;

		const { default: getOrder } = await import('../../tools/private/get_order.js');
		const result = await getOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');
		expect(result.summary).toContain('DNS error');
	});

	it('start_amount が null で executed_amount にフォールバックする', async () => {
		setupFetchMock(mockBitbankSuccess(orderResponse({ start_amount: null, executed_amount: '0.003' })));

		const { default: getOrder } = await import('../../tools/private/get_order.js');
		const result = await getOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertOk(result);
		expect(result.summary).toContain('数量: 0.003');
	});

	it('非 JPY ペアのトリガー価格がそのまま表示される', async () => {
		setupFetchMock(
			mockBitbankSuccess(orderResponse({ pair: 'btc_usdt', type: 'stop', trigger_price: '44000', average_price: '0' })),
		);

		const { default: getOrder } = await import('../../tools/private/get_order.js');
		const result = await getOrder({ pair: 'btc_usdt', order_id: 2001 });

		assertOk(result);
		expect(result.summary).toContain('トリガー価格');
		expect(result.summary).toContain('44000');
	});

	it('非 JPY ペアの平均約定価格がそのまま表示される', async () => {
		setupFetchMock(mockBitbankSuccess(orderResponse({ pair: 'btc_usdt', average_price: '45123.5' })));

		const { default: getOrder } = await import('../../tools/private/get_order.js');
		const result = await getOrder({ pair: 'btc_usdt', order_id: 2001 });

		assertOk(result);
		expect(result.summary).toContain('45123.5');
	});

	it('非 JPY ペアで価格をそのまま表示する', async () => {
		setupFetchMock(mockBitbankSuccess(orderResponse({ pair: 'btc_usdt', price: '45000.5' })));

		const { default: getOrder } = await import('../../tools/private/get_order.js');
		const result = await getOrder({ pair: 'btc_usdt', order_id: 2001 });

		assertOk(result);
		expect(result.summary).toContain('45000.5');
	});

	it('REJECTED ステータスを受け付けてサマリーに反映する', async () => {
		setupFetchMock(mockBitbankSuccess(orderResponse({ status: 'REJECTED' })));

		const { default: getOrder } = await import('../../tools/private/get_order.js');
		const result = await getOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertOk(result);
		expect(result.data.order.status).toBe('REJECTED');
		expect(result.summary).toContain('REJECTED');
	});

	it('TRIGGERED ステータスを受け付けてサマリーに反映する', async () => {
		setupFetchMock(mockBitbankSuccess(orderResponse({ type: 'stop', status: 'TRIGGERED', trigger_price: '13000000' })));

		const { default: getOrder } = await import('../../tools/private/get_order.js');
		const result = await getOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertOk(result);
		expect(result.data.order.status).toBe('TRIGGERED');
		expect(result.summary).toContain('TRIGGERED');
	});

	it('未知のステータスは Zod 検証で弾かれて upstream_error を返す', async () => {
		setupFetchMock(mockBitbankSuccess(orderResponse({ status: 'UNKNOWN_FUTURE_STATUS' })));

		const { default: getOrder } = await import('../../tools/private/get_order.js');
		// status を strict enum で受けているため、未知の値は ZodError → catch ブロックで upstream_error にフォールバック
		const result = await getOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');
	});
});

describe('get_order — 非 PrivateApiError の generic catch', () => {
	afterEach(() => {
		vi.doUnmock('../../src/private/client.js');
	});

	it('非 PrivateApiError が投げられると upstream_error を返す', async () => {
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

		const { default: getOrder } = await import('../../tools/private/get_order.js');
		const result = await getOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');
		expect(result.summary).toContain('unexpected crash');
	});
});

describe('get_order — handler (toolDef)', () => {
	it('handler が失敗時に result をそのまま返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fail')) as unknown as typeof fetch;

		const { toolDef } = await import('../../tools/private/get_order.js');
		const result = await toolDef.handler({ pair: 'btc_jpy', order_id: 2001 });

		expect((result as { ok: boolean }).ok).toBe(false);
	});

	it('handler が成功時に content + structuredContent を返す', async () => {
		setupFetchMock(mockBitbankSuccess(orderResponse()));

		const { toolDef } = await import('../../tools/private/get_order.js');
		const result = await toolDef.handler({ pair: 'btc_jpy', order_id: 2001 });

		expect(result).toHaveProperty('content');
		expect(result).toHaveProperty('structuredContent');
	});
});
