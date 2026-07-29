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
		// confirmation_token / expires_at はスキーマ上 optional だが、内部関数 previewCancelOrders() は必ず生成する
		expect(result.data.confirmation_token).toBeTypeOf('string');
		expect(result.data.confirmation_token!.length).toBeGreaterThan(0);
		expect(result.data.expires_at).toBeTypeOf('number');
		expect(result.data.expires_at!).toBeGreaterThan(Date.now());
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

	it('elicitation 非対応ホストでは confirmation_token / expires_at を一切返さない', async () => {
		const { toolDef } = await import('../../tools/private/preview_cancel_orders.js');
		const result = (await toolDef.handler({ pair: 'btc_jpy', order_ids: [2001, 2002] })) as {
			content: { text: string }[];
			structuredContent: {
				data?: { confirmation_token?: string; expires_at?: number; preview?: Record<string, unknown> };
			};
		};

		const text = result.content[0]?.text ?? '';
		const data = result.structuredContent?.data;
		// structuredContent.data.preview は残るが confirmation_token / expires_at は含まれない
		expect(data?.preview).toBeDefined();
		expect(data?.confirmation_token).toBeUndefined();
		expect(data?.expires_at).toBeUndefined();
		// content[0].text にもトークン文字列・「confirmation_token」表記を出さない
		expect(text).not.toContain('confirmation_token');
		// 実行不可通知の案内文があること
		expect(text).toContain('このホストでは取引実行に対応していません');
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

		const { mrtrRound2Ctx } = await import('./_mrtr-helpers.js');
		const { toolDef } = await import('../../tools/private/preview_cancel_orders.js');
		const args = { pair: 'btc_jpy', order_ids: [2001] };
		// MRTR round 2: confirm 応答（accept + confirmed=true）つきの再入
		const result = (await toolDef.handler(args, mrtrRound2Ctx('cancel_orders', args, 'pcos-accept-1'))) as {
			content: { text: string }[];
			structuredContent: Record<string, unknown>;
		};

		expect(result.content[0]?.text).toContain('一括キャンセル完了');
		expect(result.structuredContent).toMatchObject({ ok: true });
	});

	it('elicitation で decline されたら cancel_orders は呼ばれない', async () => {
		const fetchMock = vi.fn() as unknown as typeof fetch;
		globalThis.fetch = fetchMock;

		const { mrtrRound2Ctx } = await import('./_mrtr-helpers.js');
		const { toolDef } = await import('../../tools/private/preview_cancel_orders.js');
		const args = { pair: 'btc_jpy', order_ids: [2001, 2002] };
		// MRTR round 2: confirm 応答（decline）つきの再入
		const result = (await toolDef.handler(
			args,
			mrtrRound2Ctx('cancel_orders', args, 'pcos-decline-1', { action: 'decline' }),
		)) as {
			content: { text: string }[];
			structuredContent: { data?: { confirmation_token?: string; expires_at?: number } };
		};

		expect(result.content[0]?.text).toContain('取り消し');
		// decline 時の structuredContent にも confirmation_token / expires_at は含まれない
		expect(result.structuredContent?.data?.confirmation_token).toBeUndefined();
		expect(result.structuredContent?.data?.expires_at).toBeUndefined();
		expect((fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
	});
});
