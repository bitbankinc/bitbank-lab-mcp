/**
 * preview_cancel_order ツールのユニットテスト。
 * 確認トークン発行・注文詳細フェッチ・プレビューメッセージ生成を検証する。
 *
 * BitbankPrivateClient はシングルトンで `globalThis.fetch` をコンストラクタで bind するため、
 * 各テストで `vi.resetModules()` + 動的 import + 先に fetch を差し替える順序を厳守する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderStatusEnum, TERMINAL_ORDER_STATUSES } from '../../src/private/schemas.js';
import { assertFail, assertOk } from '../_assertResult.js';

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
		// confirmation_token / expires_at はスキーマ上 optional だが、内部関数 previewCancelOrder() は必ず生成する
		expect(result.data.confirmation_token).toBeTypeOf('string');
		expect(result.data.confirmation_token!.length).toBeGreaterThan(0);
		expect(result.data.expires_at).toBeTypeOf('number');
		expect(result.data.expires_at!).toBeGreaterThan(Date.now());
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

		it('信用 long 注文（ロング新規=buy+long）の summary に long 表記が出る', async () => {
			mockGetOrderOnce(mockOrder({ side: 'buy', position_side: 'long' }));
			const previewCancelOrder = await loadPreviewCancelOrder();
			const result = await previewCancelOrder({ pair: 'btc_jpy', order_id: 2001 });

			assertOk(result);
			expect(result.summary).toContain('long');
			expect(result.summary).toContain('買');
			expect(result.summary).not.toContain('short');
			expect(result.data.order?.position_side).toBe('long');
		});

		it('信用 short 注文（ショート新規=sell+short）の summary に short 表記が出る', async () => {
			mockGetOrderOnce(mockOrder({ side: 'sell', position_side: 'short' }));
			const previewCancelOrder = await loadPreviewCancelOrder();
			const result = await previewCancelOrder({ pair: 'btc_jpy', order_id: 2001 });

			assertOk(result);
			expect(result.summary).toContain('short');
			expect(result.summary).toContain('売');
			expect(result.data.order?.position_side).toBe('short');
		});

		it('ロング決済（sell+long）の summary に long と 売 が出る', async () => {
			mockGetOrderOnce(mockOrder({ side: 'sell', position_side: 'long' }));
			const previewCancelOrder = await loadPreviewCancelOrder();
			const result = await previewCancelOrder({ pair: 'btc_jpy', order_id: 2001 });

			assertOk(result);
			expect(result.summary).toContain('long');
			expect(result.summary).toContain('売');
			expect(result.data.order?.position_side).toBe('long');
		});

		it('ショート決済（buy+short）の summary に short と 買 が出る', async () => {
			mockGetOrderOnce(mockOrder({ side: 'buy', position_side: 'short' }));
			const previewCancelOrder = await loadPreviewCancelOrder();
			const result = await previewCancelOrder({ pair: 'btc_jpy', order_id: 2001 });

			assertOk(result);
			expect(result.summary).toContain('short');
			expect(result.summary).toContain('買');
			expect(result.data.order?.position_side).toBe('short');
		});

		it('現物注文（position_side なし）の summary に long/short ラベルは出ない', async () => {
			mockGetOrderOnce(mockOrder());
			const previewCancelOrder = await loadPreviewCancelOrder();
			const result = await previewCancelOrder({ pair: 'btc_jpy', order_id: 2001 });

			assertOk(result);
			expect(result.data.order?.position_side).toBeUndefined();
			expect(result.summary).not.toMatch(/\b(long|short)\b/);
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

describe('終端状態のガード（#28）', () => {
	/** 終端状態 → 期待する拒否メッセージ（LLM がそのままユーザーに説明する文なので状態ごとに書き分ける） */
	const TERMINAL_CASES: [string, string][] = [
		['FULLY_FILLED', 'この注文は既に全量約定しているためキャンセルできません（status: FULLY_FILLED）'],
		['REJECTED', 'この注文はシステムに拒否されており、キャンセル対象ではありません（status: REJECTED）'],
		['CANCELED_UNFILLED', 'この注文は既にキャンセル済みです（status: CANCELED_UNFILLED）'],
		['CANCELED_PARTIALLY_FILLED', 'この注文は既にキャンセル済みです（status: CANCELED_PARTIALLY_FILLED）'],
	];

	/**
	 * 拒否リスト方式の要点。ここを許可リスト（UNFILLED / PARTIALLY_FILLED だけ許す）に
	 * 反転させると INACTIVE / TRIGGERED を誤って拒否する（#28）。
	 */
	const CANCELABLE_STATUSES = ['INACTIVE', 'UNFILLED', 'PARTIALLY_FILLED', 'TRIGGERED'];

	it.each(TERMINAL_CASES)('%s は fail を返し confirmation_token を発行しない', async (status, message) => {
		mockGetOrderOnce(mockOrder({ status }));
		const previewCancelOrder = await loadPreviewCancelOrder();
		const result = await previewCancelOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertFail(result);
		expect(result.summary).toBe(`Error: ${message}`);
		expect(result.meta.errorType).toBe('validation_error');
		expect(result.data.confirmation_token).toBeUndefined();
		expect(result.data.expires_at).toBeUndefined();
	});

	it.each(CANCELABLE_STATUSES)('%s はプレビューを通す（許可リスト化への退行ガード）', async (status) => {
		mockGetOrderOnce(mockOrder({ status }));
		const previewCancelOrder = await loadPreviewCancelOrder();
		const result = await previewCancelOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertOk(result);
		expect(result.data.confirmation_token).toBeTypeOf('string');
	});

	it('OrderStatusEnum の全値が「終端で拒否」か「プレビューを通る」のどちらか一方に分類される', async () => {
		const statuses = OrderStatusEnum.options;
		// クライアントはコンストラクタで globalThis.fetch を bind するため、
		// import 前に全ケース分のレスポンスをキューしておく（テストごとの再 import は afterEach の resetModules 任せ）。
		const fetchMock = vi.fn();
		for (const status of statuses) {
			fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(mockOrder({ status })), { status: 200 }));
		}
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const previewCancelOrder = await loadPreviewCancelOrder();
		const classified: Record<string, 'terminal_rejected' | 'preview_ok'> = {};
		for (const status of statuses) {
			const result = await previewCancelOrder({ pair: 'btc_jpy', order_id: 2001 });
			classified[status] = result.ok ? 'preview_ok' : 'terminal_rejected';
			// 拒否＝終端集合に入っている、通過＝入っていない。両者は必ず一致する
			expect(classified[status] === 'terminal_rejected').toBe(TERMINAL_ORDER_STATUSES.has(status));
		}

		// enum に status が増えたら、分類を書き足さない限りここで落ちる
		expect(classified).toEqual({
			INACTIVE: 'preview_ok',
			UNFILLED: 'preview_ok',
			PARTIALLY_FILLED: 'preview_ok',
			FULLY_FILLED: 'terminal_rejected',
			CANCELED_UNFILLED: 'terminal_rejected',
			CANCELED_PARTIALLY_FILLED: 'terminal_rejected',
			REJECTED: 'terminal_rejected',
			TRIGGERED: 'preview_ok',
		});
	});

	it('拒否メッセージに API キー / シークレット / トークン表記が混入しない', async () => {
		mockGetOrderOnce(mockOrder({ status: 'FULLY_FILLED' }));
		const previewCancelOrder = await loadPreviewCancelOrder();
		const result = await previewCancelOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertFail(result);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain('test_key');
		expect(serialized).not.toContain('test_secret');
		expect(serialized).not.toContain('confirmation_token');
	});

	it('elicitation 対応ホストでも終端状態なら elicitation を出す前に fail を返す', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify(mockOrder({ status: 'FULLY_FILLED' })), { status: 200 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const { mrtrRound1Ctx } = await import('./_mrtr-helpers.js');
		const { toolDef } = await import('../../tools/private/preview_cancel_order.js');
		const result = await toolDef.handler({ pair: 'btc_jpy', order_id: 2001 }, mrtrRound1Ctx());

		assertFail(result);
		expect(result.summary).toContain('全量約定');
		// elicitation / input_required（= content つきの McpResponse）へは進んでいない
		expect(result).not.toHaveProperty('content');
		// fetch は get_order の 1 回のみ。cancel_order は呼ばれていない
		expect(fetchMock.mock.calls).toHaveLength(1);
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

	it('elicitation 非対応ホストでは confirmation_token / expires_at を一切返さない', async () => {
		mockGetOrderOnce();
		const { toolDef } = await import('../../tools/private/preview_cancel_order.js');
		const result = (await toolDef.handler({ pair: 'btc_jpy', order_id: 2001 })) as {
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

	it('既にキャンセル済みの注文はプレビュー段階で拒否する', async () => {
		mockGetOrderOnce(mockOrder({ status: 'CANCELED_UNFILLED' }));
		const previewCancelOrder = await loadPreviewCancelOrder();
		const result = await previewCancelOrder({ pair: 'btc_jpy', order_id: 2001 });

		assertFail(result);
		expect(result.summary).toContain('既にキャンセル済み');
		expect(result.meta.errorType).toBe('validation_error');
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

		const { mrtrRound2Ctx } = await import('./_mrtr-helpers.js');
		const { toolDef } = await import('../../tools/private/preview_cancel_order.js');
		const args = { pair: 'btc_jpy', order_id: 2001 };
		// MRTR round 2: confirm 応答（accept + confirmed=true）つきの再入
		const result = (await toolDef.handler(args, mrtrRound2Ctx('cancel_order', args, 'pco-accept-1'))) as {
			content: { text: string }[];
			structuredContent: Record<string, unknown>;
		};

		expect(result.content[0]?.text).toContain('注文キャンセル完了');
		expect(result.structuredContent).toMatchObject({ ok: true });
	});

	it('elicitation で decline されたら cancel_order は呼ばれない', async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(mockOrder()), { status: 200 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const { mrtrRound2Ctx } = await import('./_mrtr-helpers.js');
		const { toolDef } = await import('../../tools/private/preview_cancel_order.js');
		const args = { pair: 'btc_jpy', order_id: 2001 };
		// MRTR round 2: confirm 応答（decline）つきの再入
		const result = (await toolDef.handler(
			args,
			mrtrRound2Ctx('cancel_order', args, 'pco-decline-1', { action: 'decline' }),
		)) as {
			content: { text: string }[];
			structuredContent: { data?: { confirmation_token?: string; expires_at?: number } };
		};

		expect(result.content[0]?.text).toContain('取り消し');
		// decline 時の structuredContent にも confirmation_token / expires_at は含まれない
		expect(result.structuredContent?.data?.confirmation_token).toBeUndefined();
		expect(result.structuredContent?.data?.expires_at).toBeUndefined();
		// fetch は get_order の 1 回のみ。cancel_order は呼ばれていない。
		expect(fetchMock.mock.calls).toHaveLength(1);
	});
});
