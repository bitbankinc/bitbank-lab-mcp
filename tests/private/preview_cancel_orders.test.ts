/**
 * preview_cancel_orders ツールのユニットテスト。
 * 一括キャンセルの確認トークン発行とプレビューメッセージ生成を検証する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import previewCancelOrders from '../../tools/private/preview_cancel_orders.js';
import { assertOk } from '../_assertResult.js';

beforeEach(() => {
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
});

afterEach(() => {
	delete process.env.BITBANK_API_KEY;
	delete process.env.BITBANK_API_SECRET;
});

describe('preview_cancel_orders', () => {
	it('正常系: ok=true で confirmation_token を含むレスポンスを返す', () => {
		const result = previewCancelOrders({ pair: 'btc_jpy', order_ids: [2001, 2002] });

		assertOk(result);
		expect(result.data.confirmation_token).toBeTypeOf('string');
		expect(result.data.confirmation_token.length).toBeGreaterThan(0);
		expect(result.data.expires_at).toBeTypeOf('number');
		expect(result.data.expires_at).toBeGreaterThan(Date.now());
	});

	it('summary にペア名と件数が含まれる', () => {
		const result = previewCancelOrders({ pair: 'btc_jpy', order_ids: [1, 2, 3] });

		assertOk(result);
		expect(result.summary).toContain('BTC/JPY');
		expect(result.summary).toContain('3件');
	});

	it('summary に全ての注文IDが列挙される', () => {
		const orderIds = [1001, 1002, 1003];
		const result = previewCancelOrders({ pair: 'eth_jpy', order_ids: orderIds });

		assertOk(result);
		for (const id of orderIds) {
			expect(result.summary).toContain(String(id));
		}
	});

	it('summary に一括キャンセルの案内文が含まれる', () => {
		const result = previewCancelOrders({ pair: 'btc_jpy', order_ids: [100] });

		assertOk(result);
		expect(result.summary).toContain('一括キャンセルプレビュー');
		expect(result.summary).toContain('ユーザーの最終確認');
	});

	it('summary に confirmation_token の生値を含めない', () => {
		const result = previewCancelOrders({ pair: 'btc_jpy', order_ids: [100] });

		assertOk(result);
		// LLM が即座に cancel_orders を呼ばないよう、トークン文字列はサマリに出さない
		expect(result.summary).not.toContain(result.data.confirmation_token);
	});

	it('preview にパラメータが含まれる', () => {
		const result = previewCancelOrders({ pair: 'xrp_jpy', order_ids: [10, 20] });

		assertOk(result);
		expect(result.data.preview).toEqual({ pair: 'xrp_jpy', order_ids: [10, 20] });
	});

	it('meta.action が cancel_orders である', () => {
		const result = previewCancelOrders({ pair: 'btc_jpy', order_ids: [1] });

		assertOk(result);
		expect(result.meta.action).toBe('cancel_orders');
	});

	it('単一注文IDでも動作する', () => {
		const result = previewCancelOrders({ pair: 'btc_jpy', order_ids: [9999] });

		assertOk(result);
		expect(result.summary).toContain('1件');
		expect(result.summary).toContain('9999');
	});
});

describe('preview_cancel_orders — handler (toolDef)', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.resetModules();
	});

	it('handler が成功時に content + structuredContent を返す', async () => {
		const { toolDef } = await import('../../tools/private/preview_cancel_orders.js');
		const result = await toolDef.handler({ pair: 'btc_jpy', order_ids: [2001, 2002] });

		expect(result).toHaveProperty('content');
		expect(result).toHaveProperty('structuredContent');
		const content = (result as unknown as Record<string, unknown[]>).content;
		expect(content[0]).toHaveProperty('text');
	});

	it('elicitation 非対応ホストでは confirmation_token を content[0].text に出さない', async () => {
		const { toolDef } = await import('../../tools/private/preview_cancel_orders.js');
		const result = (await toolDef.handler({ pair: 'btc_jpy', order_ids: [2001, 2002] })) as {
			content: { text: string }[];
			structuredContent: { data?: { confirmation_token?: string } };
		};

		const text = result.content[0]?.text ?? '';
		const token = result.structuredContent?.data?.confirmation_token;
		expect(token).toBeTypeOf('string');
		expect((token as string).length).toBeGreaterThan(0);
		expect(text).not.toContain(token as string);
		expect(text).toContain('confirmation_token');
		expect(text).toContain('ホスト UI');
	});

	it('elicitation 対応ホストで accept されると cancel_orders まで実行される', async () => {
		globalThis.fetch = vi.fn().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					success: 1,
					data: {
						orders: [
							{
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
							},
						],
					},
				}),
				{ status: 200 },
			),
		) as unknown as typeof fetch;

		const elicitInput = vi.fn().mockResolvedValue({ action: 'accept', content: { confirmed: true } });
		const fakeServer = {
			getClientCapabilities: () => ({ elicitation: {} }),
			elicitInput,
		};

		const { toolDef } = await import('../../tools/private/preview_cancel_orders.js');
		const result = (await toolDef.handler({ pair: 'btc_jpy', order_ids: [2001] }, { server: fakeServer })) as {
			content: { text: string }[];
			structuredContent: Record<string, unknown>;
		};

		expect(elicitInput).toHaveBeenCalledTimes(1);
		expect(result.content[0]?.text).toContain('一括キャンセル完了');
		expect(result.structuredContent).toMatchObject({ ok: true });
	});

	it('elicitation で decline されたら cancel_orders は呼ばれない', async () => {
		const fetchMock = vi.fn() as unknown as typeof fetch;
		globalThis.fetch = fetchMock;

		const fakeServer = {
			getClientCapabilities: () => ({ elicitation: {} }),
			elicitInput: vi.fn().mockResolvedValue({ action: 'decline' }),
		};

		const { toolDef } = await import('../../tools/private/preview_cancel_orders.js');
		const result = (await toolDef.handler({ pair: 'btc_jpy', order_ids: [2001, 2002] }, { server: fakeServer })) as {
			content: { text: string }[];
		};

		expect(result.content[0]?.text).toContain('取り消し');
		expect((fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
	});
});
