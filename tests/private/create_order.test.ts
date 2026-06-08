/**
 * create_order ツールのユニットテスト。
 * stop 注文のトリガー価格バリデーションは preview_order に移動したため、
 * ここでは確認トークンの検証と注文実行を検証する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateToken } from '../../src/private/confirmation.js';
import { assertFail, assertOk } from '../_assertResult.js';
import { mockBitbankSuccess, mockSpotPairsResponse } from '../fixtures/private-api.js';

const originalFetch = globalThis.fetch;

/**
 * fetch モックのセットアップ。
 * `/spot/pairs`（create_order の事前再検証）と `/ticker`（stop 系のトリガー価格再チェック）
 * はデフォルトの正常レスポンスを返し、それ以外のリクエスト（= 注文 API）は responses 配列を順に返す。
 *
 * 個別テストでペア仕様失敗 / トリガー乖離をテストする場合は `globalThis.fetch` を直接上書きする。
 */
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
		// 事前再検証（pairs spec）を通過する amount を使い、bitbank API 側で 60003 が返るケースを模す。
		// 実運用では pair 仕様の変更等で事前検証をすり抜け得るため、API エラーマッピングは引き続き必要。
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

// take_profit / stop_loss / losscut は公式 spec に列挙されているが本実装では意図的に未対応。
// CreateOrderInputSchema が Zod 段階で拒否し、注文 API には到達しないことを保証する。
// 詳細は docs/private-api.md「対応注文タイプ」節 / docs/api-contract-checklist.md §3.4 を参照。
//
// 失敗理由が「type フィールド由来」であることを issues.path で確認する。
// success===false のみだと、他フィールドの欠落（confirmation_token 未指定等）でも
// テストが通ってしまい、type 列挙の閉鎖性を検証できなくなるため。
describe('create_order — 未対応の注文タイプ（take_profit / stop_loss / losscut）', () => {
	it('take_profit は CreateOrderInputSchema で拒否される', async () => {
		const { CreateOrderInputSchema } = await import('../../src/private/schemas.js');
		const result = CreateOrderInputSchema.safeParse({
			pair: 'btc_jpy',
			amount: '0.01',
			side: 'sell',
			type: 'take_profit',
			trigger_price: '16000000',
			confirmation_token: 'dummy',
			token_expires_at: Date.now() + 60_000,
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.some((i) => i.path.join('.') === 'type')).toBe(true);
		}
	});

	it('stop_loss は CreateOrderInputSchema で拒否される', async () => {
		const { CreateOrderInputSchema } = await import('../../src/private/schemas.js');
		const result = CreateOrderInputSchema.safeParse({
			pair: 'btc_jpy',
			amount: '0.01',
			side: 'sell',
			type: 'stop_loss',
			trigger_price: '13000000',
			confirmation_token: 'dummy',
			token_expires_at: Date.now() + 60_000,
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.some((i) => i.path.join('.') === 'type')).toBe(true);
		}
	});

	it('losscut は CreateOrderInputSchema で拒否される（システム発動のみのタイプ）', async () => {
		const { CreateOrderInputSchema } = await import('../../src/private/schemas.js');
		const result = CreateOrderInputSchema.safeParse({
			pair: 'btc_jpy',
			amount: '0.01',
			side: 'sell',
			type: 'losscut',
			confirmation_token: 'dummy',
			token_expires_at: Date.now() + 60_000,
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.some((i) => i.path.join('.') === 'type')).toBe(true);
		}
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

describe('create_order — POST 自動リトライ無効化（二重発注防止）', () => {
	// 注文 API（POST /v1/user/spot/order）が 5xx を返した場合、
	// client.post は retries=0 を強制するため再送せず単発で失敗する。
	// 失敗した発注がサーバー側で実際には受理されていた場合でも、
	// クライアント側のリトライで同じ注文が二重に飛ぶ事故は起きない。
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
			// 注文 API は常に 5xx を返す
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

		// /user/spot/order への POST 呼び出しが正確に 1 回であることを assert（旧実装では 3 回叩かれていた）
		const orderCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/user/spot/order'));
		expect(orderCalls).toHaveLength(1);
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
		// デフォルト ticker mock は last=15_000_000 を返すため、
		// stop buy のトリガー価格は 15_000_000 超に設定（即時発動チェックを通過させる）
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

// 方針 B（preview = 主検証、create = 軽量再検証）の create 側ガード。
// preview から create までの間に状態が変化し得る項目（pair 仕様 / 市場価格）を
// 軽く再チェックする。詳細は docs/private-api.md「検証の責務分担」節。
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
		// 注文 API が呼ばれていないこと
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
		// summary 末尾にも warning が出る
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
		// preview 時点では trigger=13_000_000 < current=15_000_000 だったが、
		// create 直前に市場が下落して current=12_000_000 になり、即時発動レベルになったケース
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
		// 注文 API が呼ばれていないこと
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
