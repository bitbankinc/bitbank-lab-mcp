/**
 * preview_cancel_order ツールのユニットテスト。
 * 確認トークン発行・注文詳細フェッチ・プレビューメッセージ生成を検証する。
 *
 * BitbankPrivateClient はシングルトンで `globalThis.fetch` をコンストラクタで bind するため、
 * 各テストで `vi.resetModules()` + 動的 import + 先に fetch を差し替える順序を厳守する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertOk } from '../_assertResult.js';

const originalFetch = globalThis.fetch;

/** get_order が返すモック注文 */
function mockOrder(overrides: Record<string, unknown> = {}) {
	return {
		success: 1,
		data: {
			order_id: 2001,
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
			...overrides,
		},
	};
}

/** preview の中で呼ばれる get_order だけをモックする */
function mockGetOrderOnce(payload?: Record<string, unknown>) {
	const fn = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(payload ?? mockOrder()), { status: 200 }));
	globalThis.fetch = fn as unknown as typeof fetch;
	return fn;
}

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

async function loadPreviewCancelOrder() {
	const mod = await import('../../tools/private/preview_cancel_order.js');
	return mod.default;
}

describe('preview_cancel_order', () => {
	it('正常系: ok=true で confirmation_token を含むレスポンスを返す', async () => {
		mockGetOrderOnce();
		const previewCancelOrder = await loadPreviewCancelOrder();
		const result = await previewCancelOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertOk(result);
		expect(result.data.confirmation_token).toBeTypeOf('string');
		expect(result.data.confirmation_token.length).toBeGreaterThan(0);
		expect(result.data.expires_at).toBeTypeOf('number');
		expect(result.data.expires_at).toBeGreaterThan(Date.now());
	});

	it('summary にペア名（BTC/JPY）と注文IDが含まれる', async () => {
		mockGetOrderOnce(mockOrder({ order_id: 12345 }));
		const previewCancelOrder = await loadPreviewCancelOrder();
		const result = await previewCancelOrder({ pair: 'btc_jpy', order_id: 12345 });

		assertOk(result);
		expect(result.summary).toContain('BTC/JPY');
		expect(result.summary).toContain('12345');
	});

	it('summary にキャンセルプレビューの案内文が含まれる', async () => {
		mockGetOrderOnce(mockOrder({ order_id: 100, pair: 'eth_jpy' }));
		const previewCancelOrder = await loadPreviewCancelOrder();
		const result = await previewCancelOrder({ pair: 'eth_jpy', order_id: 100 });

		assertOk(result);
		expect(result.summary).toContain('キャンセルプレビュー');
		expect(result.summary).toContain('ユーザーの最終確認');
	});

	it('summary に confirmation_token の生値を含めない', async () => {
		mockGetOrderOnce(mockOrder({ order_id: 100, pair: 'eth_jpy' }));
		const previewCancelOrder = await loadPreviewCancelOrder();
		const result = await previewCancelOrder({ pair: 'eth_jpy', order_id: 100 });

		assertOk(result);
		// LLM が即座に cancel_order を呼ばないよう、トークン文字列はサマリに出さない
		expect(result.summary).not.toContain(result.data.confirmation_token);
	});

	it('preview にパラメータが含まれる', async () => {
		mockGetOrderOnce(mockOrder({ order_id: 9999, pair: 'xrp_jpy' }));
		const previewCancelOrder = await loadPreviewCancelOrder();
		const result = await previewCancelOrder({ pair: 'xrp_jpy', order_id: 9999 });

		assertOk(result);
		expect(result.data.preview).toEqual({ pair: 'xrp_jpy', order_id: 9999 });
	});

	it('meta.action が cancel_order である', async () => {
		mockGetOrderOnce();
		const previewCancelOrder = await loadPreviewCancelOrder();
		const result = await previewCancelOrder({ pair: 'btc_jpy', order_id: 1 });

		assertOk(result);
		expect(result.meta.action).toBe('cancel_order');
	});

	it('異なるペアでもフォーマットされる', async () => {
		mockGetOrderOnce(mockOrder({ order_id: 5555, pair: 'sol_jpy' }));
		const previewCancelOrder = await loadPreviewCancelOrder();
		const result = await previewCancelOrder({ pair: 'sol_jpy', order_id: 5555 });

		assertOk(result);
		expect(result.summary).toContain('SOL/JPY');
	});

	describe('注文詳細の付加', () => {
		it('get_order 成功時は方向・タイプ・数量・価格・ステータスを summary に含む', async () => {
			mockGetOrderOnce(
				mockOrder({
					order_id: 2001,
					side: 'sell',
					type: 'limit',
					start_amount: '0.5',
					remaining_amount: '0.3',
					executed_amount: '0.2',
					price: '15000000',
					status: 'PARTIALLY_FILLED',
				}),
			);
			const previewCancelOrder = await loadPreviewCancelOrder();
			const result = await previewCancelOrder({ pair: 'btc_jpy', order_id: 2001 });

			assertOk(result);
			expect(result.summary).toContain('売');
			expect(result.summary).toContain('limit');
			expect(result.summary).toContain('0.5');
			expect(result.summary).toContain('15,000,000');
			expect(result.summary).toContain('PARTIALLY_FILLED');
			expect(result.data.order?.order_id).toBe(2001);
		});

		it('stop 注文ではトリガー価格を summary に含む', async () => {
			mockGetOrderOnce(
				mockOrder({
					order_id: 56975222901,
					pair: 'eth_jpy',
					side: 'buy',
					type: 'stop',
					trigger_price: '380000',
					status: 'INACTIVE',
				}),
			);
			const previewCancelOrder = await loadPreviewCancelOrder();
			const result = await previewCancelOrder({ pair: 'eth_jpy', order_id: 56975222901 });

			assertOk(result);
			expect(result.summary).toContain('stop');
			expect(result.summary).toContain('トリガー価格');
			expect(result.summary).toContain('380,000');
			expect(result.summary).toContain('INACTIVE');
		});

		it('get_order 失敗時もキャンセルプレビューは ok を返す（フォールバック）', async () => {
			// get_order が API エラーを返す（既にキャンセル済み等）
			globalThis.fetch = vi
				.fn()
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ success: 0, data: { code: 50009 } }), { status: 400 }),
				) as unknown as typeof fetch;

			const previewCancelOrder = await loadPreviewCancelOrder();
			const result = await previewCancelOrder({ pair: 'btc_jpy', order_id: 2001 });

			assertOk(result);
			// 注文詳細は取得できなかったので order は含まれない
			expect(result.data.order).toBeUndefined();
			// 確認トークンは発行され、サマリの基本情報は出る
			expect(result.data.confirmation_token).toBeTypeOf('string');
			expect(result.summary).toContain('2001');
		});
	});
});

describe('preview_cancel_order — handler (toolDef)', () => {
	it('handler が成功時に content + structuredContent を返す', async () => {
		mockGetOrderOnce();
		const { toolDef } = await import('../../tools/private/preview_cancel_order.js');
		const result = await toolDef.handler({ pair: 'btc_jpy', order_id: 2001 });

		expect(result).toHaveProperty('content');
		expect(result).toHaveProperty('structuredContent');
		const content = (result as unknown as Record<string, unknown[]>).content;
		expect(content[0]).toHaveProperty('text');
	});

	it('elicitation 非対応ホストでは confirmation_token を content[0].text に出さない', async () => {
		mockGetOrderOnce();
		const { toolDef } = await import('../../tools/private/preview_cancel_order.js');
		const result = (await toolDef.handler({ pair: 'btc_jpy', order_id: 2001 })) as {
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

	it('elicitation 対応ホストで accept されると cancel_order まで実行される', async () => {
		// 1 回目: get_order（preview 内部）、2 回目: cancel_order
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify(mockOrder()), { status: 200 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: 1,
						data: {
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

		const { toolDef } = await import('../../tools/private/preview_cancel_order.js');
		const result = (await toolDef.handler({ pair: 'btc_jpy', order_id: 2001 }, { server: fakeServer })) as {
			content: { text: string }[];
			structuredContent: Record<string, unknown>;
		};

		expect(elicitInput).toHaveBeenCalledTimes(1);
		expect(result.content[0]?.text).toContain('注文キャンセル完了');
		expect(result.structuredContent).toMatchObject({ ok: true });
	});

	it('elicitation で decline されたら cancel_order は呼ばれない', async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(mockOrder()), { status: 200 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const fakeServer = {
			getClientCapabilities: () => ({ elicitation: {} }),
			elicitInput: vi.fn().mockResolvedValue({ action: 'decline' }),
		};

		const { toolDef } = await import('../../tools/private/preview_cancel_order.js');
		const result = (await toolDef.handler({ pair: 'btc_jpy', order_id: 2001 }, { server: fakeServer })) as {
			content: { text: string }[];
		};

		expect(result.content[0]?.text).toContain('取り消し');
		// fetch は get_order の 1 回のみ。cancel_order は呼ばれていない。
		expect(fetchMock.mock.calls).toHaveLength(1);
	});
});
