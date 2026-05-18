/**
 * create_order ツールのユニットテスト。
 * stop 注文のトリガー価格バリデーションは preview_order に移動したため、
 * ここでは確認トークンの検証と注文実行を検証する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateToken } from '../../src/private/confirmation.js';
import { assertFail, assertOk } from '../_assertResult.js';

const originalFetch = globalThis.fetch;

/** fetch モックのセットアップ（呼び出し順に複数レスポンスを返せる） */
function setupFetchMockSequence(responses: { body: unknown; status?: number }[]) {
	const mock = vi.fn();
	for (const { body, status = 200 } of responses) {
		mock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
	}
	globalThis.fetch = mock as unknown as typeof fetch;
	return mock;
}

/** 注文成功レスポンスを返すヘルパー */
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

/** 有効な確認トークンを生成するヘルパー */
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
		const params = { pair: 'btc_jpy', amount: '0.00000001', side: 'buy', type: 'limit', price: '14000000' };
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
		expect(result.summary).toContain('unexpected crash');
	});
});

describe('create_order — handler (toolDef)', () => {
	it('handler が失敗時に result をそのまま返す', async () => {
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
	});

	it('handler が成功時に content + structuredContent を返す', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([{ body: orderSuccessResponse({ side: 'buy', type: 'limit', price: '14000000' }) }]);

		const { toolDef } = await import('../../tools/private/create_order.js');
		const result = await toolDef.handler({
			...params,
			confirmation_token,
			token_expires_at,
		});

		expect(result).toHaveProperty('content');
		expect(result).toHaveProperty('structuredContent');
	});
});

describe('create_order — トークン再利用拒否（ワンショット）', () => {
	it('同一 confirmation_token で 2 回叩くと 2 回目は token_already_used で失敗する', async () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit', price: '14000000' };
		const { confirmation_token, token_expires_at } = validToken(params);

		// 1 回目用に成功レスポンスをセット。2 回目はトークン検証でブロックされ
		// fetch は呼ばれない想定。
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
});

describe('create_order — stop_limit / post_only / trigger_price', () => {
	it('stop_limit 注文で trigger_price がサマリーに含まれる', async () => {
		const params = {
			pair: 'btc_jpy',
			amount: '0.001',
			side: 'buy',
			type: 'stop_limit',
			price: '14500000',
			trigger_price: '14000000',
		};
		const { confirmation_token, token_expires_at } = validToken(params);

		setupFetchMockSequence([
			{
				body: orderSuccessResponse({
					side: 'buy',
					type: 'stop_limit',
					price: '14500000',
					trigger_price: '14000000',
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

		const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
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
		const params = {
			pair: 'btc_jpy',
			amount: '100',
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
