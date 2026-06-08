/**
 * cancel_order ツールのユニットテスト。
 * 確認トークン検証 + 単一注文のキャンセル成功・エラーハンドリングを検証する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateToken } from '../../src/private/confirmation.js';
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

/** キャンセル済み注文レスポンス */
function canceledOrderResponse(overrides: Record<string, unknown> = {}) {
	return {
		order_id: 2001,
		pair: 'btc_jpy',
		side: 'buy',
		type: 'limit',
		start_amount: '0.01',
		remaining_amount: '0.01',
		executed_amount: '0',
		price: '14000000',
		average_price: '0',
		status: 'CANCELED_UNFILLED',
		ordered_at: 1710000000000,
		canceled_at: 1710001000000,
		...overrides,
	};
}

/** 有効な確認トークンを生成するヘルパー */
function validToken(params: { pair: string; order_id: number }) {
	const { token, expiresAt } = generateToken('cancel_order', params);
	return { confirmation_token: token, token_expires_at: expiresAt };
}

describe('cancel_order', () => {
	it('有効なトークンでキャンセル成功時に注文情報を返す', async () => {
		setupFetchMock(mockBitbankSuccess(canceledOrderResponse()));
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'btc_jpy', order_id: 2001, confirmation_token, token_expires_at });

		assertOk(result);
		expect(result.summary).toContain('注文キャンセル完了');
		expect(result.summary).toContain('BTC/JPY');
		expect(result.summary).toContain('2001');
		expect(result.data.order.status).toBe('CANCELED_UNFILLED');
	});

	it('不正トークンで拒否される', async () => {
		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({
			pair: 'btc_jpy',
			order_id: 2001,
			confirmation_token: 'invalid',
			token_expires_at: Date.now() + 60000,
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('token_invalid');
	});

	it('部分約定済みの注文キャンセル時に約定済み数量を表示', async () => {
		setupFetchMock(
			mockBitbankSuccess(
				canceledOrderResponse({
					executed_amount: '0.005',
					remaining_amount: '0.005',
					status: 'CANCELED_PARTIALLY_FILLED',
				}),
			),
		);
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'btc_jpy', order_id: 2001, confirmation_token, token_expires_at });

		assertOk(result);
		expect(result.summary).toContain('約定済み数量: 0.005');
	});

	it('売注文のキャンセルで「売」ラベルが表示される', async () => {
		setupFetchMock(mockBitbankSuccess(canceledOrderResponse({ side: 'sell', pair: 'eth_jpy' })));
		const { confirmation_token, token_expires_at } = validToken({ pair: 'eth_jpy', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'eth_jpy', order_id: 2001, confirmation_token, token_expires_at });

		assertOk(result);
		expect(result.summary).toContain('売');
	});

	it('信用 long 注文（ロング新規=buy+long）の summary に long ラベルが出る', async () => {
		setupFetchMock(mockBitbankSuccess(canceledOrderResponse({ side: 'buy', position_side: 'long' })));
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'btc_jpy', order_id: 2001, confirmation_token, token_expires_at });

		assertOk(result);
		expect(result.summary).toContain('long');
		expect(result.summary).toContain('買');
		expect(result.summary).not.toContain('short');
		expect(result.data.order.position_side).toBe('long');
	});

	it('信用 short 注文（ショート新規=sell+short）の summary に short ラベルが出る', async () => {
		setupFetchMock(mockBitbankSuccess(canceledOrderResponse({ side: 'sell', position_side: 'short' })));
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'btc_jpy', order_id: 2001, confirmation_token, token_expires_at });

		assertOk(result);
		expect(result.summary).toContain('short');
		expect(result.summary).toContain('売');
		expect(result.data.order.position_side).toBe('short');
	});

	it('ロング決済（sell+long）の summary に long ラベルと 売 が出る', async () => {
		setupFetchMock(mockBitbankSuccess(canceledOrderResponse({ side: 'sell', position_side: 'long' })));
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'btc_jpy', order_id: 2001, confirmation_token, token_expires_at });

		assertOk(result);
		expect(result.summary).toContain('long');
		expect(result.summary).toContain('売');
		expect(result.data.order.position_side).toBe('long');
	});

	it('ショート決済（buy+short）の summary に short ラベルと 買 が出る', async () => {
		setupFetchMock(mockBitbankSuccess(canceledOrderResponse({ side: 'buy', position_side: 'short' })));
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'btc_jpy', order_id: 2001, confirmation_token, token_expires_at });

		assertOk(result);
		expect(result.summary).toContain('short');
		expect(result.summary).toContain('買');
		expect(result.data.order.position_side).toBe('short');
	});

	it('現物注文（position_side なし）の summary に long/short ラベルは出ない', async () => {
		setupFetchMock(mockBitbankSuccess(canceledOrderResponse()));
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'btc_jpy', order_id: 2001, confirmation_token, token_expires_at });

		assertOk(result);
		expect(result.data.order.position_side).toBeUndefined();
		expect(result.summary).not.toMatch(/\b(long|short)\b/);
	});

	it('注文が見つからない場合（50009）に lib の専用文言を返す', async () => {
		setupFetchMock(mockBitbankError(50009), 400);
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_id: 99999 });

		const { getBitbankErrorMessage } = await import('../../src/lib/bitbank-errors.js');
		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'btc_jpy', order_id: 99999, confirmation_token, token_expires_at });

		assertFail(result);
		const expected = getBitbankErrorMessage(50009);
		expect(expected).toBeDefined();
		expect(result.summary).toBe(`Error: ${expected}`);
		expect(result.summary).toContain('見つかりません');
	});

	it('既にキャンセル済み（50026）に適切なエラーメッセージ', async () => {
		setupFetchMock(mockBitbankError(50026), 400);
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'btc_jpy', order_id: 2001, confirmation_token, token_expires_at });

		assertFail(result);
		expect(result.summary).toContain('キャンセル済み');
	});

	it('既に約定済み（50027）に適切なエラーメッセージ', async () => {
		setupFetchMock(mockBitbankError(50027), 400);
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'btc_jpy', order_id: 2001, confirmation_token, token_expires_at });

		assertFail(result);
		expect(result.summary).toContain('約定済み');
	});

	it('認証エラーで fail を返す', async () => {
		setupFetchMock(mockBitbankError(20001), 400);
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'btc_jpy', order_id: 2001, confirmation_token, token_expires_at });

		assertFail(result);
		expect(result.meta.errorType).toBe('authentication_error');
	});

	it('非 PrivateApiError の例外で upstream_error を返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Connection reset')) as unknown as typeof fetch;
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'btc_jpy', order_id: 2001, confirmation_token, token_expires_at });

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');
		expect(result.summary).toContain('Connection reset');
	});

	it('REJECTED ステータスの注文もキャンセル結果として受け付ける', async () => {
		setupFetchMock(mockBitbankSuccess(canceledOrderResponse({ status: 'REJECTED' })));
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'btc_jpy', order_id: 2001, confirmation_token, token_expires_at });

		assertOk(result);
		expect(result.data.order.status).toBe('REJECTED');
	});

	it('キャンセル不可エラー（50010）に適切なメッセージ', async () => {
		setupFetchMock(mockBitbankError(50010), 400);
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'btc_jpy', order_id: 2001, confirmation_token, token_expires_at });

		assertFail(result);
		expect(result.summary).toContain('キャンセルできません');
	});
});

describe('cancel_order — フォーマット分岐', () => {
	it('非 JPY ペアで価格がそのまま表示される', async () => {
		setupFetchMock(mockBitbankSuccess(canceledOrderResponse({ pair: 'btc_usdt', price: '45000.5' })));
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_usdt', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'btc_usdt', order_id: 2001, confirmation_token, token_expires_at });

		assertOk(result);
		expect(result.summary).toContain('45000.5');
	});

	it('成行注文キャンセル時に価格が「成行」と表示される', async () => {
		const data = canceledOrderResponse({ type: 'market' });
		delete (data as Record<string, unknown>).price;
		setupFetchMock(mockBitbankSuccess(data));
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'btc_jpy', order_id: 2001, confirmation_token, token_expires_at });

		assertOk(result);
		expect(result.summary).toContain('成行');
	});

	it('start_amount が null で executed_amount にフォールバックする', async () => {
		setupFetchMock(mockBitbankSuccess(canceledOrderResponse({ start_amount: null, executed_amount: '0.005' })));
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'btc_jpy', order_id: 2001, confirmation_token, token_expires_at });

		assertOk(result);
		expect(result.summary).toContain('0.005');
	});

	it('canceled_at が未設定の場合に現在時刻をフォールバック表示する', async () => {
		const data = canceledOrderResponse();
		delete (data as Record<string, unknown>).canceled_at;
		setupFetchMock(mockBitbankSuccess(data));
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({ pair: 'btc_jpy', order_id: 2001, confirmation_token, token_expires_at });

		assertOk(result);
		expect(result.summary).toContain('キャンセル日時');
	});
});

describe('cancel_order — 非 PrivateApiError の generic catch', () => {
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

		const { generateToken } = await import('../../src/private/confirmation.js');
		const { token, expiresAt } = generateToken('cancel_order', { pair: 'btc_jpy', order_id: 2001 });

		const { default: cancelOrder } = await import('../../tools/private/cancel_order.js');
		const result = await cancelOrder({
			pair: 'btc_jpy',
			order_id: 2001,
			confirmation_token: token,
			token_expires_at: expiresAt,
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');
		// 漏洩防止 regression: 未知エラーの内部 message（err.message）は summary に出さず汎用文へ置換する。
		expect(result.summary).not.toContain('unexpected crash');
		expect(result.summary).toContain('予期しないエラー');
	});
});

describe('cancel_order — handler (toolDef)', () => {
	it('handler が失敗時に result をそのまま返す', async () => {
		const { toolDef } = await import('../../tools/private/cancel_order.js');
		const result = await toolDef.handler({
			pair: 'btc_jpy',
			order_id: 2001,
			confirmation_token: 'invalid',
			token_expires_at: Date.now() + 60000,
		});

		expect((result as { ok: boolean }).ok).toBe(false);
	});

	it('handler が成功時に content + structuredContent を返す', async () => {
		setupFetchMock(mockBitbankSuccess(canceledOrderResponse()));
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_id: 2001 });

		const { toolDef } = await import('../../tools/private/cancel_order.js');
		const result = await toolDef.handler({
			pair: 'btc_jpy',
			order_id: 2001,
			confirmation_token,
			token_expires_at,
		});

		expect(result).toHaveProperty('content');
		expect(result).toHaveProperty('structuredContent');
	});
});
