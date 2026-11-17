import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFail, assertOk } from '../_assertResult.js';
import { mockBitbankSuccess, mockSpotPairsResponse } from '../fixtures/private-api.js';
import { requireDefined } from '../helpers/assert.js';

const originalFetch = globalThis.fetch;

/** /spot/pairs は btc_jpy / eth_jpy を含む正常な仕様、/ticker は last=15000000 を返す既定の fetch モック。 */
function installDefaultFetchMock(extraPairs: Array<Record<string, unknown>> = []): void {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
		if (url.includes('/spot/pairs')) {
			return new Response(JSON.stringify(mockSpotPairsResponse(extraPairs)), { status: 200 });
		}
		if (url.includes('/ticker')) {
			return new Response(JSON.stringify(mockBitbankSuccess({ last: '15000000' })), { status: 200 });
		}
		return new Response(JSON.stringify({ success: 1, data: {} }), { status: 200 });
	}) as unknown as typeof fetch;
}

beforeEach(() => {
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
	installDefaultFetchMock();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env.BITBANK_API_KEY;
	delete process.env.BITBANK_API_SECRET;
	vi.resetModules();
});

describe('preview_order', () => {
	describe('バリデーション', () => {
		it('limit 注文で price 未指定はエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
			});

			assertFail(result);
			expect(result.summary).toContain('price');
		});

		it('market 注文で price 指定はエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'market',
				price: '15000000',
			});

			assertFail(result);
			expect(result.summary).toContain('market');
		});

		it('market 注文で trigger_price 指定はエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'market',
				trigger_price: '16000000',
			});

			assertFail(result);
			expect(result.summary).toContain('market');
		});

		it('stop 注文で trigger_price 未指定はエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'stop',
			});

			assertFail(result);
			expect(result.summary).toContain('trigger_price');
		});

		it('stop 注文で price 指定はエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'stop',
				price: '14000000',
				trigger_price: '13000000',
			});

			assertFail(result);
			expect(result.summary).toContain('stop_limit');
		});

		it('stop_limit 注文で trigger_price 未指定はエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'stop_limit',
				price: '16000000',
			});

			assertFail(result);
			expect(result.summary).toContain('trigger_price');
		});

		it('stop_limit 注文で price 未指定はエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'stop_limit',
				trigger_price: '16000000',
			});

			assertFail(result);
			expect(result.summary).toContain('price');
		});

		it('post_only は limit 以外でエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'market',
				post_only: true,
			});

			assertFail(result);
			expect(result.summary).toContain('post_only');
		});

		it('amount が不正な値でエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '-1',
				side: 'buy',
				type: 'market',
			});

			assertFail(result);
			expect(result.summary).toContain('amount');
		});

		it('price が不正な値でエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '0',
			});

			assertFail(result);
			expect(result.summary).toContain('price');
		});

		it('trigger_price が不正な値でエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'stop',
				trigger_price: 'abc',
			});

			assertFail(result);
			expect(result.summary).toContain('trigger_price');
		});
	});

	// 拒否理由が type 由来であることを issues.path で確かめる（success===false だけだと他フィールドの欠落でも通ってしまう）。
	describe('未対応の注文タイプ（take_profit / stop_loss / losscut）', () => {
		it.each([
			['take_profit', { trigger_price: '16000000' }],
			['stop_loss', { trigger_price: '13000000' }],
			['losscut', {}],
		] as const)('%s は PreviewOrderInputSchema で拒否される', async (type, extra) => {
			const { PreviewOrderInputSchema } = await import('../../src/private/schemas.js');
			const result = PreviewOrderInputSchema.safeParse({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type,
				...extra,
			});
			expect(result.success).toBe(false);
			expect(result.error?.issues.some((i) => i.path.join('.') === 'type')).toBe(true);
		});
	});

	describe('正常系', () => {
		it('limit 注文プレビューで confirmation_token を返す', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});

			assertOk(result);
			expect(result.data.confirmation_token).toBeTypeOf('string');
			expect(requireDefined(result.data.confirmation_token, 'result.data.confirmation_token').length).toBeGreaterThan(
				0,
			);
			expect(requireDefined(result.data.expires_at, 'result.data.expires_at')).toBeGreaterThan(Date.now());
		});

		it('market 注文プレビューが成功する', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'market',
			});

			assertOk(result);
			expect(result.summary).toContain('BTC/JPY');
			expect(result.summary).toContain('買');
			expect(result.summary).toContain('market');
			expect(result.summary).toContain('成行');
		});

		it('sell 注文で「売」ラベルが表示される', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'eth_jpy',
				amount: '1.0',
				side: 'sell',
				type: 'market',
			});

			assertOk(result);
			expect(result.summary).toContain('売');
			expect(result.summary).toContain('ETH/JPY');
		});

		it('limit 注文で価格がフォーマットされる（JPYペア）', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});

			assertOk(result);
			expect(result.summary).toContain('14,000,000');
		});

		it('post_only が有効な limit 注文のプレビュー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
				post_only: true,
			});

			assertOk(result);
			expect(result.summary).toContain('Post Only');
			expect(result.data.preview.post_only).toBe(true);
		});

		// トークン生成側（tokenParams）は post_only != null で false も含めるので、preview 側も false を残さないと create_order で token_invalid になる。
		it('post_only:false を明示した limit 注文の preview に post_only が含まれる', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
				post_only: false,
			});

			assertOk(result);
			expect(result.data.preview.post_only).toBe(false);
			expect(result.summary).not.toContain('Post Only');
		});

		it('post_only:false の preview トークンで create_order がトークン検証を通過する', async () => {
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
				if (url.includes('/spot/pairs')) {
					return new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 });
				}
				return new Response(
					JSON.stringify(
						mockBitbankSuccess({
							order_id: 12345,
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
			}) as unknown as typeof fetch;

			const orderArgs = {
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy' as const,
				type: 'limit' as const,
				price: '14000000',
				post_only: false,
			};

			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const preview = await previewOrder(orderArgs);
			assertOk(preview);

			const { default: createOrder } = await import('../../tools/private/create_order.js');
			const created = await createOrder({
				...orderArgs,
				confirmation_token: requireDefined(preview.data.confirmation_token, 'preview.data.confirmation_token'),
				token_expires_at: requireDefined(preview.data.expires_at, 'preview.data.expires_at'),
			});

			assertOk(created);
		});

		it('stop 注文でトリガー価格が表示される', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'stop',
				trigger_price: '13000000',
			});

			assertOk(result);
			expect(result.summary).toContain('トリガー価格');
			expect(result.summary).toContain('13,000,000');
		});

		it('preview にパラメータが含まれる', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});

			assertOk(result);
			expect(result.data.preview.pair).toBe('btc_jpy');
			expect(result.data.preview.side).toBe('buy');
			expect(result.data.preview.type).toBe('limit');
		});

		it('meta.action が create_order である', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'market',
			});

			assertOk(result);
			expect(result.meta.action).toBe('create_order');
		});
	});

	describe('トリガー価格検証', () => {
		it('stop sell でトリガー価格が現在価格以上の場合はエラー', async () => {
			// 現在価格: 15,000,000（モック済み）
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'stop',
				trigger_price: '16000000',
			});

			assertFail(result);
			expect(result.summary).toContain('即時発動');
		});

		it('stop buy でトリガー価格が現在価格以下の場合はエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'stop',
				trigger_price: '14000000',
			});

			assertFail(result);
			expect(result.summary).toContain('即時発動');
		});

		it('stop sell でトリガー価格が現在価格未満なら正常', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'stop',
				trigger_price: '13000000',
			});

			assertOk(result);
		});

		it('stop buy でトリガー価格が現在価格超なら正常', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'stop',
				trigger_price: '16000000',
			});

			assertOk(result);
		});
	});

	describe('信用取引（position_side）', () => {
		it('ロング新規（buy + long）で「信用新規（ロング）」ラベルが表示される', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
				position_side: 'long',
			});

			assertOk(result);
			expect(result.summary).toContain('信用新規（ロング）');
			expect(result.summary).toContain('信用取引です');
			expect(result.data.preview.position_side).toBe('long');
		});

		it('ロング決済（sell + long）で「信用決済（ロング）」ラベルが表示される', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'market',
				position_side: 'long',
			});

			assertOk(result);
			expect(result.summary).toContain('信用決済（ロング）');
		});

		it('ショート新規（sell + short）で「信用新規（ショート）」ラベルが表示される', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'eth_jpy',
				amount: '1.0',
				side: 'sell',
				type: 'limit',
				price: '400000',
				position_side: 'short',
			});

			assertOk(result);
			expect(result.summary).toContain('信用新規（ショート）');
		});

		it('ショート決済（buy + short）で「信用決済（ショート）」ラベルが表示される', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'eth_jpy',
				amount: '1.0',
				side: 'buy',
				type: 'market',
				position_side: 'short',
			});

			assertOk(result);
			expect(result.summary).toContain('信用決済（ショート）');
		});

		it('position_side なしで現物注文として信用ラベルが表示されない', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'market',
			});

			assertOk(result);
			expect(result.summary).not.toContain('信用');
			expect(result.data.preview.position_side).toBeUndefined();
		});

		it('position_side が確認トークンに含まれる（改ざん検出用）', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
				position_side: 'long',
			});

			assertOk(result);
			expect(result.data.confirmation_token).toBeTypeOf('string');
			expect(requireDefined(result.data.confirmation_token, 'result.data.confirmation_token').length).toBeGreaterThan(
				0,
			);
		});
	});

	describe('handler — トークンをクライアントに返さない', () => {
		it('elicitation 非対応ホストでは confirmation_token / expires_at を一切返さない', async () => {
			const { toolDef } = await import('../../tools/private/preview_order.js');
			// extra なし（= elicitation 非対応扱い）でハンドラを直接呼ぶ
			const result = (await toolDef.handler({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			})) as {
				content: { text: string }[];
				structuredContent: {
					data?: { confirmation_token?: string; expires_at?: number; preview?: Record<string, unknown> };
				};
			};

			const text = result.content[0]?.text ?? '';
			const data = result.structuredContent?.data;
			expect(data?.preview).toBeDefined();
			expect(data?.confirmation_token).toBeUndefined();
			expect(data?.expires_at).toBeUndefined();
			expect(text).not.toContain('confirmation_token');
			expect(text).toContain('このホストでは取引実行に対応していません');
		});

		it('elicitation 対応ホストで accept されると create_order まで実行される', async () => {
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
				if (url.includes('/spot/pairs')) {
					return new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 });
				}
				return new Response(
					JSON.stringify({
						success: 1,
						data: {
							order_id: 99999,
							pair: 'btc_jpy',
							side: 'buy',
							type: 'limit',
							start_amount: '0.01',
							remaining_amount: '0.01',
							executed_amount: '0',
							average_price: '0',
							status: 'UNFILLED',
							ordered_at: 1710000000000,
						},
					}),
					{ status: 200 },
				);
			}) as unknown as typeof fetch;

			const { mrtrRound2Ctx } = await import('./_mrtr-helpers.js');
			const { toolDef } = await import('../../tools/private/preview_order.js');
			const args = {
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			};
			// MRTR round 2: confirm 応答（accept + confirmed=true）つきの再入
			const result = (await toolDef.handler(args, mrtrRound2Ctx('create_order', args, 'po-accept-1'))) as {
				content: { text: string }[];
				structuredContent: Record<string, unknown>;
			};

			expect(result.content[0]?.text).toContain('注文発注完了');
			expect(result.structuredContent).toMatchObject({ ok: true });
		});

		it('elicitation で decline されたらキャンセル扱いで create_order は呼ばれない', async () => {
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
				if (url.includes('/spot/pairs')) {
					return new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 });
				}
				if (url.includes('/ticker')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ last: '15000000' })), { status: 200 });
				}
				throw new Error(`Unexpected fetch in decline test: ${url}`);
			}) as unknown as typeof fetch;
			globalThis.fetch = fetchMock;

			const { mrtrRound2Ctx } = await import('./_mrtr-helpers.js');
			const { toolDef } = await import('../../tools/private/preview_order.js');
			const args = {
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			};
			// MRTR round 2: confirm 応答（decline）つきの再入
			const result = (await toolDef.handler(
				args,
				mrtrRound2Ctx('create_order', args, 'po-decline-1', { action: 'decline' }),
			)) as {
				content: { text: string }[];
				structuredContent: { data?: { confirmation_token?: string; expires_at?: number } };
			};

			expect(result.content[0]?.text).toContain('キャンセル');
			expect(result.structuredContent?.data?.confirmation_token).toBeUndefined();
			expect(result.structuredContent?.data?.expires_at).toBeUndefined();
			// 注文 API は呼ばれない（/spot/pairs と、板を跨ぐかを見る /ticker だけ）
			const calls = (fetchMock as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls.map((c) => String(c[0]));
			expect(calls).toHaveLength(2);
			expect(calls.some((u) => u.includes('/spot/pairs'))).toBe(true);
			expect(calls.some((u) => u.includes('/ticker'))).toBe(true);
		});

		it('elicitation 対応ホストの round 1 では input_required が返り token は載らない', async () => {
			globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 }));

			const { mrtrRound1Ctx } = await import('./_mrtr-helpers.js');
			const { isInputRequiredResult } = await import('@modelcontextprotocol/server');
			const { toolDef } = await import('../../tools/private/preview_order.js');
			const result = await toolDef.handler(
				{
					pair: 'btc_jpy',
					amount: '0.01',
					side: 'buy',
					type: 'limit',
					price: '14000000',
				},
				mrtrRound1Ctx(),
			);

			expect(isInputRequiredResult(result)).toBe(true);
			const mrtr = result as unknown as { inputRequests?: Record<string, unknown>; requestState?: string };
			expect(mrtr.inputRequests).toHaveProperty('confirm');
			expect(typeof mrtr.requestState).toBe('string');
			// requestState は署名のみで暗号化されないため token を含めない（JSON 全体にも出さない）
			expect(JSON.stringify(result)).not.toContain('confirmation_token');
		});
	});

	// /spot/pairs に照らした事前バリデーション（60003/60004/60005/60006/70004 の早期検出）
	describe('ペア仕様の事前バリデーション（/spot/pairs）', () => {
		it('未対応ペアは pair エラーで弾く', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'foo_bar',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertFail(result);
			expect(result.summary).toContain('未対応のペア');
			expect(result.summary).toContain('foo_bar');
		});

		it('is_enabled=false のペアは取引停止エラー', async () => {
			installDefaultFetchMock([
				{
					name: 'btc_jpy',
					base_asset: 'btc',
					quote_asset: 'jpy',
					unit_amount: '0.0001',
					limit_max_amount: '1000',
					market_max_amount: '0.5',
					price_digits: 0,
					amount_digits: 8,
					is_enabled: false,
					stop_order: false,
					stop_order_and_cancel: false,
					stop_market_order: false,
					stop_stop_order: false,
					stop_stop_limit_order: false,
					stop_margin_long_order: false,
					stop_margin_short_order: false,
					stop_buy_order: false,
					stop_sell_order: false,
				},
			]);
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertFail(result);
			expect(result.summary).toContain('取引停止');
		});

		it('stop_market_order=true のペアで market 注文は弾く', async () => {
			installDefaultFetchMock([
				{
					name: 'btc_jpy',
					base_asset: 'btc',
					quote_asset: 'jpy',
					unit_amount: '0.0001',
					limit_max_amount: '1000',
					market_max_amount: '0.5',
					price_digits: 0,
					amount_digits: 8,
					is_enabled: true,
					stop_order: false,
					stop_order_and_cancel: false,
					stop_market_order: true,
					stop_stop_order: false,
					stop_stop_limit_order: false,
					stop_margin_long_order: false,
					stop_margin_short_order: false,
					stop_buy_order: false,
					stop_sell_order: false,
				},
			]);
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'market',
			});
			assertFail(result);
			expect(result.summary).toContain('market 注文を停止');
		});

		it('stop_buy_order=true のペアで buy は弾くが sell は通る', async () => {
			installDefaultFetchMock([
				{
					name: 'btc_jpy',
					base_asset: 'btc',
					quote_asset: 'jpy',
					unit_amount: '0.0001',
					limit_max_amount: '1000',
					market_max_amount: '0.5',
					price_digits: 0,
					amount_digits: 8,
					is_enabled: true,
					stop_order: false,
					stop_order_and_cancel: false,
					stop_market_order: false,
					stop_stop_order: false,
					stop_stop_limit_order: false,
					stop_margin_long_order: false,
					stop_margin_short_order: false,
					stop_buy_order: true,
					stop_sell_order: false,
				},
			]);
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const buyResult = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertFail(buyResult);
			expect(buyResult.summary).toContain('buy 注文を停止');

			const sellResult = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'limit',
				price: '16000000',
			});
			assertOk(sellResult);
		});

		it('amount が最小注文数量を下回るとエラー（最小単位を含む日本語メッセージ）', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.00001',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertFail(result);
			expect(result.summary).toContain('最小注文数量');
			expect(result.summary).toContain('0.0001');
			expect(result.summary).toContain('BTC');
		});

		it('amount が最大注文数量（limit）を超えるとエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '99999',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertFail(result);
			expect(result.summary).toContain('最大注文数量');
		});

		it('amount の小数桁が許容上限を超えるとエラー', async () => {
			installDefaultFetchMock([
				{
					name: 'btc_jpy',
					base_asset: 'btc',
					quote_asset: 'jpy',
					unit_amount: '0.0001',
					limit_max_amount: '1000',
					market_max_amount: '0.5',
					price_digits: 0,
					amount_digits: 4,
					is_enabled: true,
					stop_order: false,
					stop_order_and_cancel: false,
					stop_market_order: false,
					stop_stop_order: false,
					stop_stop_limit_order: false,
					stop_margin_long_order: false,
					stop_margin_short_order: false,
					stop_buy_order: false,
					stop_sell_order: false,
				},
			]);
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.123456',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertFail(result);
			expect(result.summary).toContain('amount の小数桁数');
		});

		it('price の小数桁が許容上限を超えるとエラー（price_digits=0 で 14000000.5）', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000.5',
			});
			assertFail(result);
			expect(result.summary).toContain('price の小数桁数');
		});

		it('trigger_price の小数桁が許容上限を超えるとエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'stop',
				trigger_price: '13000000.25',
			});
			assertFail(result);
			expect(result.summary).toContain('trigger_price の小数桁数');
		});

		it('/spot/pairs 取得失敗時は warning にフォールバックして発注プレビューを継続する', async () => {
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
				if (url.includes('/spot/pairs')) {
					return new Response('boom', { status: 500 });
				}
				if (url.includes('/ticker')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ last: '15000000' })), { status: 200 });
				}
				return new Response(JSON.stringify({ success: 1, data: {} }), { status: 200 });
			}) as unknown as typeof fetch;

			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertOk(result);
			expect(result.data.confirmation_token).toBeTypeOf('string');
			expect(result.meta.warnings).toBeDefined();
			expect(result.meta.warnings?.[0]).toContain('/spot/pairs');
			expect(result.summary).toContain('スキップ');
		});

		it('/spot/pairs ネットワークエラー時も warning でプレビューを継続する', async () => {
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
				if (url.includes('/spot/pairs')) {
					throw new TypeError('fetch failed');
				}
				if (url.includes('/ticker')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ last: '15000000' })), { status: 200 });
				}
				return new Response(JSON.stringify({ success: 1, data: {} }), { status: 200 });
			}) as unknown as typeof fetch;

			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'market',
			});
			assertOk(result);
			expect(result.meta.warnings?.[0]).toContain('/spot/pairs');
		});

		it('正常時は warnings 無し（meta に warnings キーを含めない）', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertOk(result);
			expect(result.meta.warnings).toBeUndefined();
		});
	});

	// /spot/pairs フィクスチャの maker は -0.0002（リベート）。
	describe('数量・価格の文字列形式（issue 449 項目 2）', () => {
		it.each([
			['amount', { amount: '1e-3' }],
			['amount', { amount: '0x1' }],
			['amount', { amount: ' 0.001 ' }],
			['amount', { amount: '.5' }],
			['price', { price: '1e7' }],
			['price', { price: '1.5e7' }],
			['price', { price: '+14000000' }],
		])('%s の指数表記・16 進・空白などは validation_error（%o）', async (field, override) => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.001',
				side: 'buy',
				type: 'limit',
				price: '14000000',
				...override,
			});
			assertFail(result);
			expect(result.meta?.errorType).toBe('validation_error');
			expect(result.summary).toContain(`${field} は正の数値を通常の 10 進表記`);
		});

		it('Number に収まらない桁数（Infinity になる）は、/spot/pairs を取れなくても validation_error', async () => {
			globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '9'.repeat(310),
				side: 'buy',
				type: 'market',
			});
			assertFail(result);
			expect(result.summary).toContain('amount は正の数値を通常の 10 進表記');
		});

		it('trigger_price の指数表記も validation_error', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.001',
				side: 'sell',
				type: 'stop',
				trigger_price: '1.4e7',
			});
			assertFail(result);
			expect(result.summary).toContain('trigger_price は正の数値を通常の 10 進表記');
		});

		it('inputSchema も通常の 10 進表記だけを通す', async () => {
			const { PreviewOrderInputSchema } = await import('../../src/private/schemas.js');
			const base = { pair: 'btc_jpy', side: 'buy', type: 'limit', price: '14000000' };
			expect(PreviewOrderInputSchema.safeParse({ ...base, amount: '0.001' }).success).toBe(true);
			expect(PreviewOrderInputSchema.safeParse({ ...base, amount: '1e-3' }).success).toBe(false);
			expect(PreviewOrderInputSchema.safeParse({ ...base, amount: '0.001', price: '1e7' }).success).toBe(false);
			expect(PreviewOrderInputSchema.safeParse({ ...base, amount: '0.001', trigger_price: '0x10' }).success).toBe(
				false,
			);
		});
	});

	describe('板を跨ぐ指値の手数料区分（issue 449 項目 3）', () => {
		/** maker -0.02% / taker 0.12% の既定 fixture に、best ask / best bid を持つ /ticker を返す。 */
		function installTickerMock(ticker: Record<string, string> | null): void {
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
				if (url.includes('/spot/pairs')) {
					return new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 });
				}
				if (url.includes('/ticker')) {
					if (ticker == null) return new Response('boom', { status: 500 });
					return new Response(JSON.stringify(mockBitbankSuccess(ticker)), { status: 200 });
				}
				return new Response(JSON.stringify({ success: 1, data: {} }), { status: 200 });
			}) as unknown as typeof fetch;
		}

		it('best ask 以上の指値買いは即時約定するので taker で見積る（-30 円のリベートと出さない）', async () => {
			installTickerMock({ last: '14995000', sell: '14990000', buy: '14980000' });
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '15000000',
			});
			assertOk(result);
			const fee = result.data.preview.fee_estimate;
			expect(fee?.role).toBe('taker');
			expect(fee?.rate).toBe(0.0012);
			expect(fee?.estimated_fee_quote).toBe(180);
			expect(fee?.estimated_cost_quote).toBe(150180);
			expect(fee?.note).toContain('taker 想定（指値が現在の板を跨ぐため即時約定）');
			expect(result.summary).toContain('手数料区分: taker');
		});

		it('best bid 以下の指値売りも taker', async () => {
			installTickerMock({ last: '14995000', sell: '14990000', buy: '14980000' });
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'limit',
				price: '14980000',
			});
			assertOk(result);
			expect(result.data.preview.fee_estimate?.role).toBe('taker');
		});

		it('板を跨がない指値は maker のまま', async () => {
			installTickerMock({ last: '14995000', sell: '14990000', buy: '14980000' });
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14985000',
			});
			assertOk(result);
			const fee = result.data.preview.fee_estimate;
			expect(fee?.role).toBe('maker');
			expect(fee?.note).toContain('maker 想定（板を跨ぐと taker）');
		});

		it('post_only は跨いでも maker（跨ぐ注文は取引所が拒否する）', async () => {
			installTickerMock({ last: '14995000', sell: '14990000', buy: '14980000' });
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '15000000',
				post_only: true,
			});
			assertOk(result);
			expect(result.data.preview.fee_estimate?.role).toBe('maker');
		});

		it('該当する側の best ask / bid が無ければ、最終価格では判定せず maker 想定のままにする', async () => {
			installTickerMock({ last: '14995000', buy: '14980000' });
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '15000000',
			});
			assertOk(result);
			const fee = result.data.preview.fee_estimate;
			expect(fee?.role).toBe('maker');
			expect(fee?.note).toContain('maker 想定（板を跨ぐと taker）');
		});

		it('/ticker が 429（Retry-After: 30）でも待たずに maker 想定で返す（確認トークンの有効期限を食わない）', async () => {
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
				if (url.includes('/spot/pairs')) {
					return new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 });
				}
				if (url.includes('/ticker')) {
					return new Response('rate limited', { status: 429, headers: { 'Retry-After': '30' } });
				}
				return new Response(JSON.stringify({ success: 1, data: {} }), { status: 200 });
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const startedAt = Date.now();
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '15000000',
			});
			assertOk(result);
			expect(Date.now() - startedAt).toBeLessThan(3000);
			expect(result.data.preview.fee_estimate?.role).toBe('maker');
			const tickerCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/ticker'));
			expect(tickerCalls).toHaveLength(1);
		});

		// 連続取引以外（サーキットブレイク中など）は sell <= buy になりうる（public-api.md の Ticker）。
		it('気配が交差していたら板を跨ぐかを判定せず maker で見積り、その旨を本文に出す', async () => {
			installTickerMock({ last: '14995000', sell: '14980000', buy: '14990000' });
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '15000000',
			});
			assertOk(result);
			const fee = result.data.preview.fee_estimate;
			expect(fee?.role).toBe('maker');
			expect(result.summary).toContain('気配が交差しています');
		});

		it('/ticker の取得に失敗したら従来どおり maker で見積る', async () => {
			installTickerMock(null);
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '15000000',
			});
			assertOk(result);
			const fee = result.data.preview.fee_estimate;
			expect(fee?.role).toBe('maker');
			expect(fee?.note).toContain('maker 想定（板を跨ぐと taker）');
		});
	});

	describe('手数料の端数（issue 449 項目 4）', () => {
		it('円建ての推定手数料は円未満を四捨五入した概算であることを備考に書く', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.0001',
				side: 'buy',
				type: 'limit',
				price: '3000000',
			});
			assertOk(result);
			expect(result.data.preview.fee_estimate?.note).toContain('推定手数料は円未満を四捨五入した概算');
			expect(result.summary).toContain('推定手数料は円未満を四捨五入した概算');
		});
	});

	describe('手数料見積り（fee_estimate）', () => {
		// maker 正レートでの買い/売りを明示検証するため、maker_fee_rate_quote を正値に上書きする。
		const POSITIVE_MAKER_PAIR = {
			name: 'btc_jpy',
			base_asset: 'btc',
			quote_asset: 'jpy',
			unit_amount: '0.0001',
			limit_max_amount: '1000',
			market_max_amount: '0.5',
			price_digits: 0,
			amount_digits: 8,
			is_enabled: true,
			stop_order: false,
			stop_order_and_cancel: false,
			stop_market_order: false,
			stop_stop_order: false,
			stop_stop_limit_order: false,
			stop_margin_long_order: false,
			stop_margin_short_order: false,
			stop_buy_order: false,
			stop_sell_order: false,
			maker_fee_rate_quote: '0.0001',
			taker_fee_rate_quote: '0.0012',
			maker_fee_rate_base: '0',
			taker_fee_rate_base: '0',
			margin_open_maker_fee_rate_quote: null,
			margin_open_taker_fee_rate_quote: null,
			margin_close_maker_fee_rate_quote: null,
			margin_close_taker_fee_rate_quote: null,
		};

		it('limit 買い → maker。notional+fee で推定コストを算出する', async () => {
			installDefaultFetchMock([POSITIVE_MAKER_PAIR]);
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertOk(result);
			const fee = result.data.preview.fee_estimate;
			expect(fee?.role).toBe('maker');
			expect(fee?.rate).toBe(0.0001);
			// notional = 14,000,000 * 0.01 = 140,000 / fee = 140,000 * 0.0001 = 14
			expect(fee?.estimated_fee_quote).toBe(14);
			expect(fee?.estimated_cost_quote).toBe(140014);
			expect(result.summary).toContain('手数料見積り');
			expect(result.summary).toContain('手数料区分: maker');
			expect(result.summary).toContain('0.01%');
		});

		it('limit 売り → maker。notional-fee で推定コストを算出する', async () => {
			installDefaultFetchMock([POSITIVE_MAKER_PAIR]);
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			// 現在価格（15,000,000）より上の売り指値なので板を跨がない
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'limit',
				price: '16000000',
			});
			assertOk(result);
			const fee = result.data.preview.fee_estimate;
			expect(fee?.role).toBe('maker');
			// notional = 160,000 / fee = 160,000 * 0.0001 = 16
			expect(fee?.estimated_fee_quote).toBe(16);
			expect(fee?.estimated_cost_quote).toBe(159984);
		});

		it('負のリベート（maker -0.0002）はコストを減らす方向に効く', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertOk(result);
			const fee = result.data.preview.fee_estimate;
			expect(fee?.role).toBe('maker');
			expect(fee?.rate).toBe(-0.0002);
			// fee = 140,000 * -0.0002 = -28
			expect(fee?.estimated_fee_quote).toBe(-28);
			// 買いは notional + fee = 140,000 + (-28) = 139,972（コストが減る）
			expect(fee?.estimated_cost_quote).toBe(139972);
			expect(result.summary).toContain('リベート');
		});

		it('market → taker。JPY 見積りは省略し note で明示する', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'market',
			});
			assertOk(result);
			const fee = result.data.preview.fee_estimate;
			expect(fee?.role).toBe('taker');
			expect(fee?.estimated_fee_quote).toBeUndefined();
			expect(fee?.estimated_cost_quote).toBeUndefined();
			expect(fee?.note).toContain('約定価格依存');
			expect(result.summary).toContain('手数料区分: taker');
		});

		it('post_only → maker 確定の note が出る', async () => {
			installDefaultFetchMock([POSITIVE_MAKER_PAIR]);
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
				post_only: true,
			});
			assertOk(result);
			const fee = result.data.preview.fee_estimate;
			expect(fee?.role).toBe('maker');
			expect(fee?.note).toContain('maker 確定');
		});

		it('信用ロング新規（buy+long）→ margin_open レートで解決する', async () => {
			installDefaultFetchMock([
				{
					...POSITIVE_MAKER_PAIR,
					margin_open_maker_fee_rate_quote: '0.0004',
					margin_close_maker_fee_rate_quote: '0.0003',
				},
			]);
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
				position_side: 'long',
			});
			assertOk(result);
			const fee = result.data.preview.fee_estimate;
			expect(fee?.role).toBe('maker');
			expect(fee?.rate).toBe(0.0004);
			// fee = 140,000 * 0.0004 = 56
			expect(fee?.estimated_fee_quote).toBe(56);
			expect(result.summary).toContain('信用新規');
		});

		it('信用レート null（デフォルトフィクスチャ）→ 公称 taker で概算し「API 未提供」note が content に出る', async () => {
			// デフォルトフィクスチャの margin_*_fee_rate_quote は null。
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
				position_side: 'long',
			});
			assertOk(result);
			const fee = result.data.preview.fee_estimate;
			// margin maker null → 公称 taker(0.0012) に fallback
			expect(fee?.rate).toBe(0.0012);
			expect(fee?.note).toContain('API 未提供');
			expect(result.summary).toContain('信用新規');
			expect(result.summary).toContain('API 未提供');
			expect(result.summary).toContain('利息');
		});

		it('信用見積りには利息を含めない旨の note が content に出る', async () => {
			installDefaultFetchMock([
				{
					...POSITIVE_MAKER_PAIR,
					margin_open_maker_fee_rate_quote: '0.0004',
					margin_close_maker_fee_rate_quote: '0.0003',
				},
			]);
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
				position_side: 'long',
			});
			assertOk(result);
			expect(result.summary).toContain('利息');
			expect(result.summary).toContain('trade_history');
			expect(result.summary).not.toContain('API 未提供');
		});

		it('信用ロング決済（sell+long）→ margin_close レートで解決する', async () => {
			installDefaultFetchMock([
				{
					...POSITIVE_MAKER_PAIR,
					margin_open_maker_fee_rate_quote: '0.0004',
					margin_close_maker_fee_rate_quote: '0.0003',
				},
			]);
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'limit',
				price: '16000000',
				position_side: 'long',
			});
			assertOk(result);
			const fee = result.data.preview.fee_estimate;
			expect(fee?.rate).toBe(0.0003);
			expect(result.summary).toContain('信用決済');
		});

		it('/spot/pairs 取得失敗時は公称 taker で概算しつつ warning が content に残る', async () => {
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
				if (url.includes('/spot/pairs')) {
					return new Response('boom', { status: 500 });
				}
				if (url.includes('/ticker')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ last: '15000000' })), { status: 200 });
				}
				return new Response(JSON.stringify({ success: 1, data: {} }), { status: 200 });
			}) as unknown as typeof fetch;

			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertOk(result);
			const fee = result.data.preview.fee_estimate;
			// spec 不明 → 公称 taker (0.0012) で概算
			expect(fee?.rate).toBe(0.0012);
			expect(fee?.note).toContain('spec 不明');
			expect(result.summary).toContain('手数料見積り');
			expect(result.summary).toContain('スキップ');
			expect(result.meta.warnings?.[0]).toContain('/spot/pairs');
		});

		it('handler の content[0].text に手数料行が含まれ、発注 POST は走らない', async () => {
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
				if (url.includes('/spot/pairs')) {
					return new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 });
				}
				if (url.includes('/ticker')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ last: '15000000' })), { status: 200 });
				}
				return new Response(JSON.stringify({ success: 1, data: {} }), { status: 200 });
			}) as unknown as typeof fetch;
			globalThis.fetch = fetchMock;

			const { toolDef } = await import('../../tools/private/preview_order.js');
			// extra なし（elicitation 非対応扱い）→ create_order には到達しない
			const result = (await toolDef.handler({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			})) as { content: { text: string }[] };

			const text = result.content[0]?.text ?? '';
			expect(text).toContain('手数料見積り');
			expect(text).toContain('手数料区分: maker');
			const calls = (fetchMock as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls;
			expect(calls.some((c) => String(c[0]).includes('/user/spot/order'))).toBe(false);
		});
	});
});
