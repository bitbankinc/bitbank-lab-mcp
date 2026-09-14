/**
 * P1 HITL セキュリティ回帰:
 * - BITBANK_TRUST_HOST_APPROVAL=1 でも preview 応答から execute 用 credential を得られない
 * - preview 後の model/direct-text（execute ツールの MCP handler）は実行されない
 * - elicitation accept 時のみ execute される
 * - decline / cancel / replay / 期限切れは実行されない
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFail } from '../_assertResult.js';
import { mockBitbankSuccess, mockSpotPairsResponse } from '../fixtures/private-api.js';
import { mrtrRound2Ctx } from './_mrtr-helpers.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function installFetchMock(opts?: { orderId?: number; cancelOrderId?: number }) {
	const orderId = opts?.orderId ?? 99999;
	const cancelOrderId = opts?.cancelOrderId ?? 2001;
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
		if (url.includes('/spot/pairs')) {
			return new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 });
		}
		if (url.includes('/ticker')) {
			return new Response(JSON.stringify(mockBitbankSuccess({ last: '15000000' })), { status: 200 });
		}
		if (url.includes('/user/spot/order_info') || url.includes('/v1/user/spot/order?')) {
			return new Response(
				JSON.stringify(
					mockBitbankSuccess({
						order_id: cancelOrderId,
						pair: 'btc_jpy',
						side: 'buy',
						type: 'limit',
						start_amount: '0.01',
						remaining_amount: '0.01',
						executed_amount: '0',
						price: '14000000',
						average_price: '0',
						status: 'UNFILLED',
						ordered_at: 1710000000000,
					}),
				),
				{ status: 200 },
			);
		}
		if (url.includes('/cancel_orders')) {
			return new Response(
				JSON.stringify(
					mockBitbankSuccess({
						orders: [
							{
								order_id: 3001,
								pair: 'btc_jpy',
								side: 'buy',
								type: 'limit',
								start_amount: '0.01',
								remaining_amount: '0',
								executed_amount: '0',
								average_price: '0',
								status: 'CANCELED_UNFILLED',
								ordered_at: 1710000000000,
							},
						],
					}),
				),
				{ status: 200 },
			);
		}
		if (url.includes('/cancel_order')) {
			return new Response(
				JSON.stringify(
					mockBitbankSuccess({
						order_id: cancelOrderId,
						pair: 'btc_jpy',
						side: 'buy',
						type: 'limit',
						start_amount: '0.01',
						remaining_amount: '0',
						executed_amount: '0',
						average_price: '0',
						status: 'CANCELED_UNFILLED',
						ordered_at: 1710000000000,
					}),
				),
				{ status: 200 },
			);
		}
		if (url.includes('/user/spot/order')) {
			return new Response(
				JSON.stringify(
					mockBitbankSuccess({
						order_id: orderId,
						pair: 'btc_jpy',
						side: 'buy',
						type: 'limit',
						start_amount: '0.01',
						remaining_amount: '0.01',
						executed_amount: '0',
						average_price: '0',
						status: 'UNFILLED',
						ordered_at: 1710000000000,
					}),
				),
				{ status: 200 },
			);
		}
		return new Response(JSON.stringify({ success: 1, data: {} }), { status: 200 });
	}) as unknown as typeof fetch;
}

function countOrderApiCalls(): number {
	const fetchMock = globalThis.fetch as unknown as { mock: { calls: Array<[unknown]> } };
	return fetchMock.mock.calls.filter((c) => {
		const url = String(c[0]);
		// 発注は POST /v1/user/spot/order（クエリ無し）。GET 照会 (`/order?`) は除外する。
		return url.includes('/v1/user/spot/order') && !url.includes('?') && !url.includes('cancel');
	}).length;
}

function countCancelApiCalls(): number {
	const fetchMock = globalThis.fetch as unknown as { mock: { calls: Array<[unknown]> } };
	return fetchMock.mock.calls.filter((c) => {
		const url = String(c[0]);
		return url.includes('/cancel_order');
	}).length;
}

beforeEach(() => {
	process.env = { ...originalEnv };
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
	installFetchMock();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	process.env = { ...originalEnv };
	vi.resetModules();
});

describe('HITL: trust-host でも preview から execute credential を得られない', () => {
	const cases = [
		{
			name: 'preview_order',
			load: () => import('../../tools/private/preview_order.js'),
			args: { pair: 'btc_jpy', amount: '0.01', side: 'buy', type: 'limit', price: '14000000' },
		},
		{
			name: 'preview_cancel_order',
			load: () => import('../../tools/private/preview_cancel_order.js'),
			args: { pair: 'btc_jpy', order_id: 2001 },
		},
		{
			name: 'preview_cancel_orders',
			load: () => import('../../tools/private/preview_cancel_orders.js'),
			args: { pair: 'btc_jpy', order_ids: [3001, 3002] },
		},
	] as const;

	for (const c of cases) {
		it(`${c.name}: BITBANK_TRUST_HOST_APPROVAL=1 でも token / expires_at を返さない`, async () => {
			process.env.BITBANK_TRUST_HOST_APPROVAL = '1';
			const { toolDef } = await c.load();
			const result = (await toolDef.handler(c.args as never)) as {
				content: { text: string }[];
				structuredContent: {
					data?: { confirmation_token?: string; expires_at?: number };
					confirmation_token?: string;
					expires_at?: number;
				};
			};

			const serialized = JSON.stringify(result);
			expect(serialized).not.toContain('confirmation_token');
			expect(result.structuredContent?.data?.confirmation_token).toBeUndefined();
			expect(result.structuredContent?.data?.expires_at).toBeUndefined();
			expect(result.structuredContent?.confirmation_token).toBeUndefined();
			expect(result.content[0]?.text).toContain('このホストでは取引実行に対応していません');
			expect(result.content[0]?.text).not.toContain('ボタンを押さない限り');
		});
	}
});

describe('HITL: preview 後の model/direct-text execute は実行されない', () => {
	it('preview_order 後に create_order handler を呼んでも発注 API は呼ばれない', async () => {
		process.env.BITBANK_TRUST_HOST_APPROVAL = '1';
		const { toolDef: previewDef } = await import('../../tools/private/preview_order.js');
		const previewArgs = {
			pair: 'btc_jpy',
			amount: '0.01',
			side: 'buy' as const,
			type: 'limit' as const,
			price: '14000000',
		};
		const preview = (await previewDef.handler(previewArgs)) as {
			structuredContent: {
				data?: { confirmation_token?: string; expires_at?: number; preview?: Record<string, unknown> };
			};
		};

		const leakedToken = preview.structuredContent?.data?.confirmation_token;
		expect(leakedToken).toBeUndefined();

		const { toolDef: createDef, default: createOrder } = await import('../../tools/private/create_order.js');
		// MCP tools/call 相当: handler は常に拒否
		const handlerResult = await createDef.handler({
			...previewArgs,
			confirmation_token: 'forged-or-leaked',
			token_expires_at: Date.now() + 60_000,
		});
		expect((handlerResult as { ok: boolean }).ok).toBe(false);
		expect((handlerResult as { meta: { errorType: string } }).meta.errorType).toBe('direct_execute_forbidden');
		expect(countOrderApiCalls()).toBe(0);

		// 内部関数に不正 token を渡しても検証失敗（defense in depth）
		const direct = await createOrder({
			...previewArgs,
			confirmation_token: 'forged-or-leaked',
			token_expires_at: Date.now() + 60_000,
		});
		expect(direct.ok).toBe(false);
		expect(countOrderApiCalls()).toBe(0);
	});

	it('preview_cancel_order 後に cancel_order handler を呼んでも取消 API は呼ばれない', async () => {
		process.env.BITBANK_TRUST_HOST_APPROVAL = '1';
		const { toolDef: previewDef } = await import('../../tools/private/preview_cancel_order.js');
		const previewArgs = { pair: 'btc_jpy', order_id: 2001 };
		const preview = (await previewDef.handler(previewArgs)) as {
			structuredContent: { data?: { confirmation_token?: string; expires_at?: number } };
		};
		expect(preview.structuredContent?.data?.confirmation_token).toBeUndefined();

		const before = countCancelApiCalls();
		const { toolDef: cancelDef } = await import('../../tools/private/cancel_order.js');
		const handlerResult = await cancelDef.handler({
			...previewArgs,
			confirmation_token: 'forged',
			token_expires_at: Date.now() + 60_000,
		});
		expect((handlerResult as { ok: boolean }).ok).toBe(false);
		expect((handlerResult as { meta: { errorType: string } }).meta.errorType).toBe('direct_execute_forbidden');
		expect(countCancelApiCalls()).toBe(before);
	});

	it('preview_cancel_orders 後に cancel_orders handler を呼んでも取消 API は呼ばれない', async () => {
		process.env.BITBANK_TRUST_HOST_APPROVAL = '1';
		const { toolDef: previewDef } = await import('../../tools/private/preview_cancel_orders.js');
		const previewArgs = { pair: 'btc_jpy', order_ids: [3001] };
		const preview = (await previewDef.handler(previewArgs)) as {
			structuredContent: { data?: { confirmation_token?: string } };
		};
		expect(preview.structuredContent?.data?.confirmation_token).toBeUndefined();

		const before = countCancelApiCalls();
		const { toolDef: cancelDef } = await import('../../tools/private/cancel_orders.js');
		const handlerResult = await cancelDef.handler({
			...previewArgs,
			confirmation_token: 'forged',
			token_expires_at: Date.now() + 60_000,
		});
		expect((handlerResult as { ok: boolean }).ok).toBe(false);
		expect((handlerResult as { meta: { errorType: string } }).meta.errorType).toBe('direct_execute_forbidden');
		expect(countCancelApiCalls()).toBe(before);
	});
});

describe('HITL: elicitation accept 時だけ execute される', () => {
	it('preview_order: accept で発注され、decline / cancel / replay では発注されない', async () => {
		const { toolDef } = await import('../../tools/private/preview_order.js');
		const args = {
			pair: 'btc_jpy',
			amount: '0.01',
			side: 'buy' as const,
			type: 'limit' as const,
			price: '14000000',
		};

		const declined = (await toolDef.handler(
			args,
			mrtrRound2Ctx('create_order', args, 'hitl-decline', { action: 'decline' }),
		)) as { content: { text: string }[] };
		expect(declined.content[0]?.text).toContain('キャンセル');
		expect(countOrderApiCalls()).toBe(0);

		const cancelled = (await toolDef.handler(
			args,
			mrtrRound2Ctx('create_order', args, 'hitl-cancel', { action: 'cancel' }),
		)) as { content: { text: string }[] };
		expect(cancelled.content[0]?.text).toContain('キャンセル');
		expect(countOrderApiCalls()).toBe(0);

		const accepted = (await toolDef.handler(args, mrtrRound2Ctx('create_order', args, 'hitl-accept'))) as {
			content: { text: string }[];
		};
		expect(accepted.content[0]?.text).toContain('注文発注完了');
		expect(countOrderApiCalls()).toBe(1);

		// 同一 nonce の replay は拒否
		const replayed = (await toolDef.handler(args, mrtrRound2Ctx('create_order', args, 'hitl-accept'))) as {
			content: { text: string }[];
		};
		expect(replayed.content[0]?.text).toContain('確認情報が無効');
		expect(countOrderApiCalls()).toBe(1);
	});

	it('preview_cancel_order: accept のみ取消され、decline では取消されない', async () => {
		const { toolDef } = await import('../../tools/private/preview_cancel_order.js');
		const args = { pair: 'btc_jpy', order_id: 2001 };

		const declined = (await toolDef.handler(
			args,
			mrtrRound2Ctx('cancel_order', args, 'hitl-cxl-decline', { action: 'decline' }),
		)) as { content: { text: string }[] };
		expect(declined.content[0]?.text).toContain('取り消しました');
		expect(countCancelApiCalls()).toBe(0);

		const accepted = (await toolDef.handler(args, mrtrRound2Ctx('cancel_order', args, 'hitl-cxl-accept'))) as {
			content: { text: string }[];
		};
		expect(accepted.content[0]?.text).toMatch(/キャンセル/);
		expect(countCancelApiCalls()).toBe(1);
	});

	it('preview_cancel_orders: accept のみ一括取消される', async () => {
		const { toolDef } = await import('../../tools/private/preview_cancel_orders.js');
		const args = { pair: 'btc_jpy', order_ids: [3001] };

		const declined = (await toolDef.handler(
			args,
			mrtrRound2Ctx('cancel_orders', args, 'hitl-bulk-decline', { action: 'decline' }),
		)) as { content: { text: string }[] };
		expect(declined.content[0]?.text).toContain('取り消しました');
		expect(countCancelApiCalls()).toBe(0);

		const accepted = (await toolDef.handler(args, mrtrRound2Ctx('cancel_orders', args, 'hitl-bulk-accept'))) as {
			content: { text: string }[];
		};
		expect(accepted.content[0]?.text).toMatch(/キャンセル/);
		expect(countCancelApiCalls()).toBe(1);
	});

	it('期限切れ token では内部 createOrder も実行されない', async () => {
		const { generateToken } = await import('../../src/private/confirmation.js');
		const params = { pair: 'btc_jpy', amount: '0.01', side: 'buy', type: 'limit', price: '14000000' };
		const past = Date.now() - 120_000;
		const { token, expiresAt } = generateToken('create_order', params, past);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: 'buy',
			type: 'limit',
			confirmation_token: token,
			token_expires_at: expiresAt,
		});
		assertFail(result);
		expect(result.meta.errorType).toBe('token_expired');
		expect(countOrderApiCalls()).toBe(0);
	});
});

describe('HITL: isHostApprovalTrusted は常に false', () => {
	it('BITBANK_TRUST_HOST_APPROVAL=1 でも false', async () => {
		process.env.BITBANK_TRUST_HOST_APPROVAL = '1';
		const { isHostApprovalTrusted } = await import('../../src/private/config.js');
		expect(isHostApprovalTrusted()).toBe(false);
	});
});
