import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateToken } from '../../src/private/confirmation.js';
import { assertFail, assertOk } from '../_assertResult.js';
import { mockBitbankSuccess, mockSpotPairsResponse } from '../fixtures/private-api.js';

const originalFetch = globalThis.fetch;

/** /spot/pairs（事前再検証）と /ticker（stop 系のトリガー価格再チェック）は既定の正常応答、それ以外（= 注文 API）は responses を順に返す。 */
function setupFetchMockSequence(responses: { body: unknown; status?: number }[]) {
	const orderResponses = [...responses];
	const mock = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
		if (url.includes('/spot/pairs')) {
			return new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 });
		}
		if (url.includes('/ticker')) {
			return new Response(JSON.stringify(mockBitbankSuccess({ last: '15000000' })), { status: 200 });
		}
		const next = orderResponses.shift();
		if (!next) {
			throw new Error(`No mocked order response left for ${url}`);
		}
		return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
	});
	globalThis.fetch = mock as unknown as typeof fetch;
	return mock;
}

function orderSuccessResponse(overrides: Record<string, unknown> = {}) {
	return {
		success: 1,
		data: {
			order_id: 12345,
			pair: 'btc_jpy',
			side: 'sell',
			type: 'stop',
			start_amount: '0.001',
			remaining_amount: '0.001',
			executed_amount: '0',
			average_price: '0',
			status: 'UNFILLED',
			ordered_at: 1710000000000,
			...overrides,
		},
	};
}

function validToken(params: Record<string, unknown>, nowMs = Date.now()) {
	const { token, expiresAt } = generateToken('create_order', params, nowMs);
	return { confirmation_token: token, token_expires_at: expiresAt, nowMs };
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

describe('create_order — 確認トークン検証', () => {
	it('有効なトークンで注文が成功する', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([{ body: orderSuccessResponse({ side: 'buy', type: 'limit', price: '14000000' }) }]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		expect(result.summary).toContain('注文発注完了');
	});

	it('トークンなし（不正トークン）で token_invalid を返す', async () => {
		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			pair: 'btc_jpy',
			amount: '0.001',
			side: 'buy',
			type: 'limit',
			price: '14000000',
			confirmation_token: 'invalid_token',
			token_expires_at: Date.now() + 60000,
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('token_invalid');
	});

	it('期限切れトークンで token_expired を返す', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const pastTime = Date.now() - 120_000;
		const { confirmation_token, token_expires_at } = validToken(params, pastTime);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('token_expired');
		expect(result.summary).toContain('有効期限');
	});

	it('パラメータ改ざん（amount 変更）で token_invalid を返す', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const { confirmation_token, token_expires_at } = validToken(params);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			amount: '999', // 改ざん
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('token_invalid');
	});

	it('market 注文も確認トークンで正常に動作する', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'sell', type: 'market' };
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([{ body: orderSuccessResponse({ side: 'sell', type: 'market' }) }]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'market',
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
	});
});

describe('create_order — エラーコード別ハンドリング', () => {
	it('残高不足エラー（60001）に適切なメッセージ', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([{ body: { success: 0, data: { code: 60001 } }, status: 400 }]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.summary).toContain('残高が不足');
	});

	it('数量下限エラー（60003）に適切なメッセージ', async () => {
		// 事前再検証を通る amount で、bitbank 側が 60003 を返すケース（pair 仕様の変更などで事前検証をすり抜けうるので、API エラーの対応付けは要る）。
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([{ body: { success: 0, data: { code: 60003 } }, status: 400 }]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.summary).toContain('最小数量');
	});

	it('同時注文上限エラー（60011）に適切なメッセージ', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([{ body: { success: 0, data: { code: 60011 } }, status: 400 }]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.summary).toContain('上限（30件）');
	});

	it('成行注文制限（70009）に適切なメッセージ', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'market' };
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([{ body: { success: 0, data: { code: 70009 } }, status: 400 }]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'market',
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.summary).toContain('成行注文が制限');
	});

	it('サーキットブレイク中の成行注文制限（70020）に適切なメッセージ', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'market' };
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([{ body: { success: 0, data: { code: 70020 } }, status: 400 }]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'market',
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.summary).toContain('サーキットブレイク');
		expect(result.summary).toContain('指値注文');
	});

	it('非 PrivateApiError の例外で upstream_error を返す', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const { confirmation_token, token_expires_at } = validToken(params);

		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Network failure')) as unknown as typeof fetch;

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');
		expect(result.summary).toContain('Network failure');
	});

	it('REJECTED ステータスのレスポンスを受け付ける（信用取引のリスク制限超過など）', async () => {
		const params = {
			pair: 'btc_jpy',
			amount: '0.001',
			side: 'buy',
			type: 'limit',
			price: '14000000',
			position_side: 'long',
		};
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([
			{
				body: orderSuccessResponse({
					side: 'buy',
					type: 'limit',
					price: '14000000',
					status: 'REJECTED',
				}),
			},
		]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			position_side: params.position_side as 'long' | 'short',
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		expect(result.data.order.status).toBe('REJECTED');
		expect(result.summary).toContain('REJECTED');
	});

	it('価格上限超過エラー（60006）に適切なメッセージ', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '999999999' };
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([{ body: { success: 0, data: { code: 60006 } }, status: 400 }]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.summary).toContain('上限を超えています');
	});
});

describe('create_order — 非 PrivateApiError の generic catch', () => {
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
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const { token, expiresAt } = generateToken('create_order', params);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
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

// 拒否理由が type 由来であることを issues.path で確かめる（success===false だけだと他フィールドの欠落でも通ってしまう）。
describe('create_order — 未対応の注文タイプ（take_profit / stop_loss / losscut）', () => {
	it.each([
		['take_profit', { trigger_price: '16000000' }],
		['stop_loss', { trigger_price: '13000000' }],
		// losscut はシステム発動のみのタイプ
		['losscut', {}],
	] as const)('%s は CreateOrderInputSchema で拒否される', async (type, extra) => {
		const { CreateOrderInputSchema } = await import('../../src/private/schemas.js');
		const result = CreateOrderInputSchema.safeParse({
			pair: 'btc_jpy',
			amount: '0.01',
			side: 'sell',
			type,
			...extra,
			confirmation_token: 'dummy',
			token_expires_at: Date.now() + 60_000,
		});
		expect(result.success).toBe(false);
		expect(result.error?.issues.some((i) => i.path.join('.') === 'type')).toBe(true);
	});
});

describe('create_order — handler (toolDef)', () => {
	it('MCP tools/call 経由は valid token でも常に拒否する', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const { confirmation_token, token_expires_at } = validToken(params);
		const fetchMock = setupFetchMockSequence([
			{ body: orderSuccessResponse({ side: 'buy', type: 'limit', price: '14000000' }) },
		]);

		const { toolDef } = await import('../../tools/private/create_order.js');
		const result = await toolDef.handler({
			...params,
			confirmation_token,
			token_expires_at,
		});

		expect((result as { ok: boolean }).ok).toBe(false);
		expect((result as { summary: string }).summary).toContain('MCP tools/call');
		expect((result as { meta: { errorType: string } }).meta.errorType).toBe('direct_execute_forbidden');
		expect(JSON.stringify(result)).not.toContain('confirmation_token');
		expect(JSON.stringify(result)).not.toContain(confirmation_token);
		// handler は createOrder() を呼ばないため注文 API は一切叩かれない
		expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/user/spot/order'))).toBe(false);
	});

	it('invalid token でも同様に direct_execute_forbidden で拒否する', async () => {
		const fetchMock = setupFetchMockSequence([
			{ body: orderSuccessResponse({ side: 'buy', type: 'limit', price: '14000000' }) },
		]);

		const { toolDef } = await import('../../tools/private/create_order.js');
		const result = await toolDef.handler({
			pair: 'btc_jpy',
			amount: '0.001',
			side: 'buy',
			type: 'limit',
			price: '14000000',
			confirmation_token: 'invalid',
			token_expires_at: Date.now() + 60000,
		});

		expect((result as { ok: boolean }).ok).toBe(false);
		expect((result as { meta: { errorType: string } }).meta.errorType).toBe('direct_execute_forbidden');
		expect(JSON.stringify(result)).not.toContain('confirmation_token');
		expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/user/spot/order'))).toBe(false);
	});
});

describe('create_order — POST 自動リトライ無効化（二重発注防止）', () => {
	// client.post は retries=0 を強制するので、5xx でも再送せず単発で失敗する（サーバー側で受理済みでも二重に飛ばない）。
	it('5xx 時に注文 API（POST）は 1 回しか呼ばれない', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const { confirmation_token, token_expires_at } = validToken(params);

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
			if (url.includes('/spot/pairs')) {
				return new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 });
			}
			if (url.includes('/ticker')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ last: '15000000' })), { status: 200 });
			}
			return new Response('', { status: 500 });
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');

		const orderCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/user/spot/order'));
		expect(orderCalls).toHaveLength(1);
	});
});

describe('create_order — トークン再利用拒否（ワンショット）', () => {
	it('同一 confirmation_token で 2 回叩くと 2 回目は token_already_used で失敗する', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const { confirmation_token, token_expires_at } = validToken(params);

		// 2 回目はトークン検証で止まり fetch を呼ばないので、成功レスポンスは 1 回分だけ用意する。
		setupFetchMockSequence([{ body: orderSuccessResponse({ side: 'buy', type: 'limit', price: '14000000' }) }]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const { _resetUsedTokens } = await import('../../src/private/confirmation.js');
		_resetUsedTokens();

		const first = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		});
		assertOk(first);

		const second = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		});
		assertFail(second);
		expect(second.meta.errorType).toBe('token_already_used');
		expect(second.summary).toContain('既に使用されています');
	});

	it('同一 confirmation_token を並行実行しても注文は 1 回しか通らない', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const { confirmation_token, token_expires_at } = validToken(params);

		// 注文レスポンスは 1 件のみ用意。2 回叩かれれば「レスポンス切れ」で検知できる
		const fetchMock = setupFetchMockSequence([
			{ body: orderSuccessResponse({ side: 'buy', type: 'limit', price: '14000000' }) },
		]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const { _resetUsedTokens } = await import('../../src/private/confirmation.js');
		_resetUsedTokens();

		const args = {
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		};
		const results = await Promise.all([createOrder(args), createOrder(args)]);

		expect(results.filter((r) => r.ok)).toHaveLength(1);
		const rejected = results.filter((r) => !r.ok);
		expect(rejected).toHaveLength(1);
		assertFail(rejected[0]);
		expect(rejected[0].meta.errorType).toBe('token_already_used');

		const orderCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/user/spot/order'));
		expect(orderCalls).toHaveLength(1);
	});

	it('使用済み記録が上限に達している場合は token_store_full を返し発注しない', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const { confirmation_token, token_expires_at } = validToken(params);

		const fetchMock = setupFetchMockSequence([
			{ body: orderSuccessResponse({ side: 'buy', type: 'limit', price: '14000000' }) },
		]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const { _resetUsedTokens, generateToken: gen, validateToken } = await import('../../src/private/confirmation.js');

		// 上限 1 件のストアを別トークンで埋めて満杯にする
		_resetUsedTokens({ maxEntries: 1 });
		const fillerParams = { pair: 'btc_jpy', amount: '0.002', side: 'sell', type: 'limit' };
		const filler = gen('create_order', fillerParams);
		expect(validateToken(filler.token, 'create_order', fillerParams, filler.expiresAt)).toBeNull();

		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('token_store_full');
		// 二重発注を防ぐため、記録できない状態では注文 API を叩かない
		const orderCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/user/spot/order'));
		expect(orderCalls).toHaveLength(0);
	});
});

describe('create_order — stop_limit / post_only / trigger_price', () => {
	it('stop_limit 注文で trigger_price がサマリーに含まれる', async () => {
		// 既定の ticker mock は last=15_000_000 なので、stop buy のトリガー価格は 15_000_000 超にして即時発動チェックを通す。
		const params = {
			pair: 'btc_jpy',
			amount: '0.001',
			side: 'buy',
			type: 'stop_limit',
			price: '16500000',
			trigger_price: '16000000',
		};
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([
			{
				body: orderSuccessResponse({
					side: 'buy',
					type: 'stop_limit',
					price: '16500000',
					trigger_price: '16000000',
				}),
			},
		]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'stop_limit',
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		expect(result.summary).toContain('トリガー価格');
	});

	it('post_only 有効時にサマリーに Post Only が含まれる', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000', post_only: true };
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([{ body: orderSuccessResponse({ side: 'buy', type: 'limit', price: '14000000' }) }]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		expect(result.summary).toContain('Post Only');
	});
});

describe('create_order — 信用取引（position_side）', () => {
	it('ロング新規（buy + long）で「信用新規（ロング）」サマリーが表示される', async () => {
		const params = {
			pair: 'btc_jpy',
			amount: '0.001',
			side: 'buy',
			type: 'limit',
			price: '14000000',
			position_side: 'long',
		};
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([{ body: orderSuccessResponse({ side: 'buy', type: 'limit', price: '14000000' }) }]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			position_side: params.position_side as 'long' | 'short',
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		expect(result.summary).toContain('信用新規（ロング）');
	});

	it('ロング決済（sell + long）で「信用決済（ロング）」サマリーが表示される', async () => {
		const params = {
			pair: 'btc_jpy',
			amount: '0.001',
			side: 'sell',
			type: 'market',
			position_side: 'long',
		};
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([{ body: orderSuccessResponse({ side: 'sell', type: 'market' }) }]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'market',
			position_side: params.position_side as 'long' | 'short',
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		expect(result.summary).toContain('信用決済（ロング）');
	});

	it('ショート新規（sell + short）で「信用新規（ショート）」サマリーが表示される', async () => {
		const params = {
			pair: 'eth_jpy',
			amount: '1.0',
			side: 'sell',
			type: 'limit',
			price: '400000',
			position_side: 'short',
		};
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([
			{ body: orderSuccessResponse({ pair: 'eth_jpy', side: 'sell', type: 'limit', price: '400000' }) },
		]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			position_side: params.position_side as 'long' | 'short',
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		expect(result.summary).toContain('信用新規（ショート）');
	});

	it('position_side なしで現物注文として信用ラベルが表示されない', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([{ body: orderSuccessResponse({ side: 'buy', type: 'limit', price: '14000000' }) }]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		expect(result.summary).not.toContain('信用');
	});

	it('position_side の改ざんでトークン検証が失敗する', async () => {
		const params = {
			pair: 'btc_jpy',
			amount: '0.001',
			side: 'buy',
			type: 'limit',
			price: '14000000',
			position_side: 'long',
		};
		const { confirmation_token, token_expires_at } = validToken(params);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			position_side: 'short', // 改ざん: long → short
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('token_invalid');
	});

	it('position_side を追加する改ざんでトークン検証が失敗する', async () => {
		// 現物注文のトークンで信用注文を試みる
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const { confirmation_token, token_expires_at } = validToken(params);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			position_side: 'long', // 改ざん: 現物→信用
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('token_invalid');
	});

	it('position_side を含む信用注文で request body に position_side が渡される', async () => {
		const params = {
			pair: 'btc_jpy',
			amount: '0.001',
			side: 'buy',
			type: 'limit',
			price: '14000000',
			position_side: 'long',
		};
		const { confirmation_token, token_expires_at } = validToken(params);

		const fetchMock = setupFetchMockSequence([
			{ body: orderSuccessResponse({ side: 'buy', type: 'limit', price: '14000000' }) },
		]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			position_side: params.position_side as 'long' | 'short',
			confirmation_token,
			token_expires_at,
		});

		// /spot/pairs / /ticker などのデフォルトモックを除外し、注文 API への呼び出しを特定する
		const orderCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/user/spot/order'));
		expect(orderCall).toBeDefined();
		const requestBody = JSON.parse((orderCall as unknown as [unknown, { body: string }])[1].body);
		expect(requestBody.position_side).toBe('long');
	});
});

describe('create_order — 信用取引エラーコード', () => {
	it('信用取引未審査エラー（50058）に適切なメッセージ', async () => {
		const params = {
			pair: 'btc_jpy',
			amount: '0.001',
			side: 'buy',
			type: 'limit',
			price: '14000000',
			position_side: 'long',
		};
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([{ body: { success: 0, data: { code: 50058 } }, status: 400 }]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			position_side: params.position_side as 'long' | 'short',
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.summary).toContain('審査');
	});

	it('新規建可能額超過エラー（50061）に適切なメッセージ', async () => {
		const params = {
			pair: 'btc_jpy',
			amount: '10',
			side: 'buy',
			type: 'limit',
			price: '14000000',
			position_side: 'long',
		};
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([{ body: { success: 0, data: { code: 50061 } }, status: 400 }]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			position_side: params.position_side as 'long' | 'short',
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.summary).toContain('新規建可能額');
	});

	it('建玉数量超過エラー（50062）に適切なメッセージ', async () => {
		// 事前再検証（pairs spec）を通過する amount を使い、bitbank API 側で 50062 が返るケースを模す
		const params = {
			pair: 'btc_jpy',
			amount: '0.001',
			side: 'sell',
			type: 'market',
			position_side: 'long',
		};
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([{ body: { success: 0, data: { code: 50062 } }, status: 400 }]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'market',
			position_side: params.position_side as 'long' | 'short',
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.summary).toContain('建玉数量');
	});

	it('信用取引利用不可エラー（50078）に適切なメッセージ', async () => {
		const params = {
			pair: 'btc_jpy',
			amount: '0.001',
			side: 'buy',
			type: 'limit',
			price: '14000000',
			position_side: 'long',
		};
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([{ body: { success: 0, data: { code: 50078 } }, status: 400 }]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			position_side: params.position_side as 'long' | 'short',
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.summary).toContain('信用取引');
	});
});

// preview と create の間に変わりうる項目（pair 仕様 / 市場価格）だけを create 側で軽く再チェックする。
describe('create_order — 事前再検証（ペア仕様 / トリガー価格）', () => {
	it('amount が最小注文数量を下回ると validation_error で発注前に弾く', async () => {
		// mockSpotPairsResponse の btc_jpy は unit_amount=0.0001 / amount_digits=8
		const params = { pair: 'btc_jpy', amount: '0.00001', side: 'buy', type: 'limit', price: '14000000' };
		const { confirmation_token, token_expires_at } = validToken(params);

		const fetchMock = setupFetchMockSequence([
			// 注文 API が呼ばれてはいけない（pairs 段階で停止する）
			{ body: orderSuccessResponse({ side: 'buy', type: 'limit', price: '14000000' }) },
		]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('validation_error');
		expect(result.summary).toContain('最小注文数量');
		const orderCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/user/spot/order'));
		expect(orderCall).toBeUndefined();
	});

	it('/spot/pairs 取得失敗時は warning に留めて発注を継続する', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const { confirmation_token, token_expires_at } = validToken(params);

		// /spot/pairs は 500、注文 API は成功
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
			if (url.includes('/spot/pairs')) {
				return new Response('boom', { status: 500 });
			}
			return new Response(JSON.stringify(orderSuccessResponse({ side: 'buy', type: 'limit', price: '14000000' })), {
				status: 200,
			});
		}) as unknown as typeof fetch;

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		expect(result.meta.warnings).toBeDefined();
		expect(result.meta.warnings?.[0]).toContain('/spot/pairs');
		expect(result.summary).toContain('スキップ');
		expect(result.summary).toContain('注文発注完了');
	});

	it('/spot/pairs ネットワークエラー時も warning でフォールバックする', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'sell', type: 'market' };
		const { confirmation_token, token_expires_at } = validToken(params);

		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
			if (url.includes('/spot/pairs')) {
				throw new TypeError('fetch failed');
			}
			return new Response(JSON.stringify(orderSuccessResponse({ side: 'sell', type: 'market' })), { status: 200 });
		}) as unknown as typeof fetch;

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'market',
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		expect(result.meta.warnings?.[0]).toContain('/spot/pairs');
	});

	it('stop sell でトリガー価格が現在価格以上に乖離していると validation_error で弾く', async () => {
		// preview 時点では trigger 13_000_000 < current 15_000_000 だったが、create 直前に current 12_000_000 まで下落して即時発動レベルになったケース。
		const params = {
			pair: 'btc_jpy',
			amount: '0.001',
			side: 'sell',
			type: 'stop',
			trigger_price: '13000000',
		};
		const { confirmation_token, token_expires_at } = validToken(params);

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
			if (url.includes('/spot/pairs')) {
				return new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 });
			}
			if (url.includes('/ticker')) {
				// 現在価格 12_000_000 → trigger 13_000_000 >= current で即時発動
				return new Response(JSON.stringify(mockBitbankSuccess({ last: '12000000' })), { status: 200 });
			}
			return new Response(
				JSON.stringify(orderSuccessResponse({ side: 'sell', type: 'stop', trigger_price: '13000000' })),
				{ status: 200 },
			);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'stop',
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('validation_error');
		expect(result.summary).toContain('即時発動');
		const orderCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/user/spot/order'));
		expect(orderCall).toBeUndefined();
	});

	it('stop buy でトリガー価格が現在価格以下に乖離していると validation_error で弾く', async () => {
		const params = {
			pair: 'btc_jpy',
			amount: '0.001',
			side: 'buy',
			type: 'stop',
			trigger_price: '14000000',
		};
		const { confirmation_token, token_expires_at } = validToken(params);

		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
			if (url.includes('/spot/pairs')) {
				return new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 });
			}
			if (url.includes('/ticker')) {
				// 現在価格 15_000_000 → trigger 14_000_000 <= current で即時発動
				return new Response(JSON.stringify(mockBitbankSuccess({ last: '15000000' })), { status: 200 });
			}
			return new Response(JSON.stringify({ success: 1, data: {} }), { status: 200 });
		}) as unknown as typeof fetch;

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'stop',
			confirmation_token,
			token_expires_at,
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('validation_error');
		expect(result.summary).toContain('即時発動');
	});

	it('limit 注文ではトリガー価格チェック（ticker fetch）が走らない', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const { confirmation_token, token_expires_at } = validToken(params);

		const fetchMock = setupFetchMockSequence([
			{ body: orderSuccessResponse({ side: 'buy', type: 'limit', price: '14000000' }) },
		]);

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		});

		assertOk(result);
		// ticker への呼び出しが発生していないこと（stop 系のみで実行される最適化）
		const tickerCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/ticker'));
		expect(tickerCall).toBeUndefined();
	});

	it('/ticker 取得失敗時は trigger 検証をスキップして発注を継続する', async () => {
		const params = {
			pair: 'btc_jpy',
			amount: '0.001',
			side: 'sell',
			type: 'stop',
			trigger_price: '13000000',
		};
		const { confirmation_token, token_expires_at } = validToken(params);

		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
			if (url.includes('/spot/pairs')) {
				return new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 });
			}
			if (url.includes('/ticker')) {
				return new Response('ticker boom', { status: 500 });
			}
			return new Response(
				JSON.stringify(orderSuccessResponse({ side: 'sell', type: 'stop', trigger_price: '13000000' })),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;

		const { default: createOrder } = await import('../../tools/private/create_order.js');
		const result = await createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'stop',
			confirmation_token,
			token_expires_at,
		});

		// trigger 検証は静かにスキップ（null 返却）し、発注は継続する
		assertOk(result);
		expect(result.summary).toContain('注文発注完了');
	});
});

/** data.order.pair を小文字契約に保つ。リクエストボディの pair と表示・JPY 判定はユーザー入力のまま。 */
describe('create_order — API pair の取得境界正規化', () => {
	const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };

	async function placeOrder() {
		const { confirmation_token, token_expires_at } = validToken(params);
		const { default: createOrder } = await import('../../tools/private/create_order.js');
		return createOrder({
			...params,
			side: params.side as 'buy' | 'sell',
			type: params.type as 'limit',
			confirmation_token,
			token_expires_at,
		});
	}

	it('小文字レスポンスでは出力が変わらない（回帰なし）', async () => {
		setupFetchMockSequence([{ body: orderSuccessResponse({ side: 'buy', type: 'limit', price: '14000000' }) }]);

		const result = await placeOrder();

		assertOk(result);
		expect(result.data.order.pair).toBe('btc_jpy');
		expect(result.summary).toContain('BTC/JPY');
	});

	it('大文字レスポンスでも structuredContent の pair は小文字契約を保つ', async () => {
		setupFetchMockSequence([
			{ body: orderSuccessResponse({ pair: 'BTC_JPY', side: 'buy', type: 'limit', price: '14000000' }) },
		]);

		const result = await placeOrder();

		assertOk(result);
		expect(result.data.order.pair).toBe('btc_jpy');
		expect(result.summary).toContain('BTC/JPY');
	});
});
