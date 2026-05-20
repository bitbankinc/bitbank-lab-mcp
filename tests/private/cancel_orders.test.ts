/**
 * cancel_orders ツールのユニットテスト。
 * 確認トークン検証 + 一括キャンセルの成功・部分失敗・エラーハンドリングを検証する。
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

/** キャンセル済み注文データ */
function canceledOrder(id: number, side: 'buy' | 'sell' = 'buy', overrides: Record<string, unknown> = {}) {
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
		status: 'CANCELED_UNFILLED',
		ordered_at: 1710000000000,
		canceled_at: 1710001000000,
		...overrides,
	};
}

/** 有効な確認トークンを生成するヘルパー */
function validToken(params: { pair: string; order_ids: number[] }) {
	const { token, expiresAt } = generateToken('cancel_orders', params);
	return { confirmation_token: token, token_expires_at: expiresAt };
}

describe('cancel_orders', () => {
	it('有効なトークンで複数注文の一括キャンセル成功', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [canceledOrder(3001), canceledOrder(3002, 'sell')],
			}),
		);
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_ids: [3001, 3002] });

		const { default: cancelOrders } = await import('../../tools/private/cancel_orders.js');
		const result = await cancelOrders({
			pair: 'btc_jpy',
			order_ids: [3001, 3002],
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		expect(result.summary).toContain('一括キャンセル完了');
		expect(result.summary).toContain('2件');
		expect(result.data.orders).toHaveLength(2);
		expect(result.meta.canceledCount).toBe(2);
	});

	it('不正トークンで拒否される', async () => {
		const { default: cancelOrders } = await import('../../tools/private/cancel_orders.js');
		const result = await cancelOrders({
			pair: 'btc_jpy',
			order_ids: [3001],
			confirmation_token: 'invalid',
			token_expires_at: Date.now() + 60000,
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('token_invalid');
	});

	it('一部の注文がキャンセルできなかった場合に警告メッセージを含む', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [canceledOrder(3001)],
			}),
		);
		const { confirmation_token, token_expires_at } = validToken({
			pair: 'btc_jpy',
			order_ids: [3001, 3002, 3003],
		});

		const { default: cancelOrders } = await import('../../tools/private/cancel_orders.js');
		const result = await cancelOrders({
			pair: 'btc_jpy',
			order_ids: [3001, 3002, 3003],
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		expect(result.summary).toContain('2件はキャンセルできませんでした');
	});

	it('注文情報に売買方向・価格・ステータスを含む', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [canceledOrder(3001, 'buy', { price: '14000000' }), canceledOrder(3002, 'sell', { price: '15000000' })],
			}),
		);
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_ids: [3001, 3002] });

		const { default: cancelOrders } = await import('../../tools/private/cancel_orders.js');
		const result = await cancelOrders({
			pair: 'btc_jpy',
			order_ids: [3001, 3002],
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		expect(result.summary).toContain('#3001');
		expect(result.summary).toContain('#3002');
		expect(result.summary).toContain('買');
		expect(result.summary).toContain('売');
	});

	it('信用 4 パターン（long/short × buy/sell）の混在を summary 各行から判別可能', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [
					// ロング新規: buy + long
					canceledOrder(3001, 'buy', { position_side: 'long' }),
					// ロング決済: sell + long
					canceledOrder(3002, 'sell', { position_side: 'long' }),
					// ショート新規: sell + short
					canceledOrder(3003, 'sell', { position_side: 'short' }),
					// ショート決済: buy + short
					canceledOrder(3004, 'buy', { position_side: 'short' }),
				],
			}),
		);
		const { confirmation_token, token_expires_at } = validToken({
			pair: 'btc_jpy',
			order_ids: [3001, 3002, 3003, 3004],
		});

		const { default: cancelOrders } = await import('../../tools/private/cancel_orders.js');
		const result = await cancelOrders({
			pair: 'btc_jpy',
			order_ids: [3001, 3002, 3003, 3004],
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		// 各行が #order_id ${posLabel}${sideLabel}${type} ... 形式（posLabel 末尾スペース付き）
		expect(result.summary).toContain('#3001 long 買');
		expect(result.summary).toContain('#3002 long 売');
		expect(result.summary).toContain('#3003 short 売');
		expect(result.summary).toContain('#3004 short 買');
		expect(result.data.orders.map((o) => o.position_side)).toEqual(['long', 'long', 'short', 'short']);
	});

	it('現物注文（position_side なし）混在時、信用注文のみに long/short ラベルが出る', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [
					canceledOrder(3001, 'buy'), // 現物
					canceledOrder(3002, 'sell', { position_side: 'short' }), // 信用ショート新規
				],
			}),
		);
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_ids: [3001, 3002] });

		const { default: cancelOrders } = await import('../../tools/private/cancel_orders.js');
		const result = await cancelOrders({
			pair: 'btc_jpy',
			order_ids: [3001, 3002],
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		// 現物行は posLabel なし
		expect(result.summary).toContain('#3001 買');
		expect(result.summary).not.toContain('#3001 long');
		expect(result.summary).not.toContain('#3001 short');
		// 信用ショート行は short プレフィックス付き
		expect(result.summary).toContain('#3002 short 売');
		expect(result.data.orders[0].position_side).toBeUndefined();
		expect(result.data.orders[1].position_side).toBe('short');
	});

	it('PrivateApiError で fail を返す', async () => {
		setupFetchMock(mockBitbankError(20001), 400);
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_ids: [3001] });

		const { default: cancelOrders } = await import('../../tools/private/cancel_orders.js');
		const result = await cancelOrders({
			pair: 'btc_jpy',
			order_ids: [3001],
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('authentication_error');
	});

	it('空の注文リストが返った場合も正常に処理', async () => {
		setupFetchMock(mockBitbankSuccess({ orders: [] }));
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_ids: [9999] });

		const { default: cancelOrders } = await import('../../tools/private/cancel_orders.js');
		const result = await cancelOrders({
			pair: 'btc_jpy',
			order_ids: [9999],
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		expect(result.summary).toContain('0件');
		expect(result.data.orders).toHaveLength(0);
	});

	it('非 PrivateApiError の例外で upstream_error を返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Socket hang up')) as unknown as typeof fetch;
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_ids: [3001] });

		const { default: cancelOrders } = await import('../../tools/private/cancel_orders.js');
		const result = await cancelOrders({
			pair: 'btc_jpy',
			order_ids: [3001],
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');
		expect(result.summary).toContain('Socket hang up');
	});

	it('REJECTED / TRIGGERED ステータスの注文も結果として受け付ける', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [
					canceledOrder(3001, 'buy', { status: 'REJECTED' }),
					canceledOrder(3002, 'sell', { status: 'TRIGGERED', type: 'stop', trigger_price: '13000000' }),
				],
			}),
		);
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_ids: [3001, 3002] });

		const { default: cancelOrders } = await import('../../tools/private/cancel_orders.js');
		const result = await cancelOrders({
			pair: 'btc_jpy',
			order_ids: [3001, 3002],
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		expect(result.data.orders.map((o) => o.status)).toEqual(['REJECTED', 'TRIGGERED']);
	});

	it('成行注文のキャンセル時に価格が「成行」と表示される', async () => {
		const marketOrder = canceledOrder(3001, 'buy', { type: 'market', price: undefined });
		delete (marketOrder as Record<string, unknown>).price;
		setupFetchMock(mockBitbankSuccess({ orders: [marketOrder] }));
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_ids: [3001] });

		const { default: cancelOrders } = await import('../../tools/private/cancel_orders.js');
		const result = await cancelOrders({
			pair: 'btc_jpy',
			order_ids: [3001],
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		expect(result.summary).toContain('成行');
	});
});

describe('cancel_orders — 非 PrivateApiError の generic catch', () => {
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
		const { token, expiresAt } = generateToken('cancel_orders', { pair: 'btc_jpy', order_ids: [3001] });

		const { default: cancelOrders } = await import('../../tools/private/cancel_orders.js');
		const result = await cancelOrders({
			pair: 'btc_jpy',
			order_ids: [3001],
			confirmation_token: token,
			token_expires_at: expiresAt,
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');
		expect(result.summary).toContain('unexpected crash');
	});
});

describe('cancel_orders — handler (toolDef)', () => {
	it('handler が失敗時に result をそのまま返す', async () => {
		const { toolDef } = await import('../../tools/private/cancel_orders.js');
		const result = await toolDef.handler({
			pair: 'btc_jpy',
			order_ids: [3001],
			confirmation_token: 'invalid',
			token_expires_at: Date.now() + 60000,
		});

		expect((result as { ok: boolean }).ok).toBe(false);
	});

	it('handler が成功時に content + structuredContent を返す', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				orders: [canceledOrder(3001)],
			}),
		);
		const { confirmation_token, token_expires_at } = validToken({ pair: 'btc_jpy', order_ids: [3001] });

		const { toolDef } = await import('../../tools/private/cancel_orders.js');
		const result = await toolDef.handler({
			pair: 'btc_jpy',
			order_ids: [3001],
			confirmation_token,
			token_expires_at,
		});

		expect(result).toHaveProperty('content');
		expect(result).toHaveProperty('structuredContent');
	});
});
