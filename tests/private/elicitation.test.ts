/**
 * src/private/elicitation.ts のユニットテスト。
 *
 * 共通化された preview → ユーザー確認 → execute のフロー（capability 判定、
 * elicit 応答による分岐、`onConfirmed` の例外伝播）を独立して検証する。
 * 3 つの preview ツール（preview_order / preview_cancel_order / preview_cancel_orders）の
 * 動作確認は引き続き `tests/private/preview_*.test.ts` で行う。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, ok } from '../../lib/result.js';
import { clientSupportsElicitation, withElicitedConfirmation } from '../../src/private/elicitation.js';

/** elicitInput / getClientCapabilities を備えた fake サーバを生成する */
function makeServer(opts: {
	supportsElicitation?: boolean;
	elicitInput?: (params: {
		message: string;
		requestedSchema: Record<string, unknown>;
	}) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }>;
}) {
	const supports = opts.supportsElicitation ?? true;
	return {
		getClientCapabilities: () => (supports ? { elicitation: {} } : {}),
		elicitInput: opts.elicitInput,
	};
}

/** 既定の fallback McpResponse */
function makeFallback() {
	return {
		content: [{ type: 'text', text: 'FALLBACK_TEXT' }],
		structuredContent: { fallback: true } as Record<string, unknown>,
	};
}

describe('clientSupportsElicitation', () => {
	it('extra が undefined の場合は false', () => {
		expect(clientSupportsElicitation(undefined)).toBe(false);
	});

	it('server が無い extra の場合は false', () => {
		expect(clientSupportsElicitation({})).toBe(false);
	});

	it('getClientCapabilities が無い server の場合は false', () => {
		expect(clientSupportsElicitation({ server: {} })).toBe(false);
	});

	it('capabilities に elicitation が無い場合は false', () => {
		const server = { getClientCapabilities: () => ({ sampling: {} }) };
		expect(clientSupportsElicitation({ server })).toBe(false);
	});

	it('capabilities.elicitation が存在すれば true', () => {
		const server = { getClientCapabilities: () => ({ elicitation: {} }) };
		expect(clientSupportsElicitation({ server })).toBe(true);
	});
});

describe('withElicitedConfirmation', () => {
	const baseOpts = {
		summary: 'preview summary',
		confirmTitle: 'Confirm this action',
		onDeclinedText: 'ユーザーが操作を取り消しました',
		declinedStructured: { declined: true } as Record<string, unknown>,
	};

	describe('capability 判定', () => {
		it('クライアントが elicitation 非対応なら fallback を返す（elicitInput は呼ばれない）', async () => {
			const elicitInput = vi.fn();
			const fallback = makeFallback();
			const onConfirmed = vi.fn();

			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: { server: makeServer({ supportsElicitation: false, elicitInput }) },
				onConfirmed,
				fallback,
			});

			expect(result).toEqual(fallback);
			expect(elicitInput).not.toHaveBeenCalled();
			expect(onConfirmed).not.toHaveBeenCalled();
		});

		it('extra 自体が undefined でも fallback を返す', async () => {
			const fallback = makeFallback();
			const onConfirmed = vi.fn();

			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: undefined,
				onConfirmed,
				fallback,
			});

			expect(result).toEqual(fallback);
			expect(onConfirmed).not.toHaveBeenCalled();
		});

		it('elicitInput が関数でない場合も fallback を返す', async () => {
			const fallback = makeFallback();
			const onConfirmed = vi.fn();
			const server = { getClientCapabilities: () => ({ elicitation: {} }) };

			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: { server },
				onConfirmed,
				fallback,
			});

			expect(result).toEqual(fallback);
			expect(onConfirmed).not.toHaveBeenCalled();
		});
	});

	describe('elicit 応答による分岐', () => {
		it('accept + confirmed=true なら onConfirmed が呼ばれて結果が返る（成功）', async () => {
			const elicitInput = vi.fn().mockResolvedValue({ action: 'accept', content: { confirmed: true } });
			const onConfirmed = vi.fn().mockResolvedValue(ok('実行完了', { id: 1 }, { action: 'create_order' as const }));

			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: { server: makeServer({ elicitInput }) },
				onConfirmed,
				fallback: makeFallback(),
			});

			expect(elicitInput).toHaveBeenCalledTimes(1);
			expect(onConfirmed).toHaveBeenCalledTimes(1);
			expect(result.content[0]?.text).toBe('実行完了');
			expect(result.structuredContent).toMatchObject({ ok: true, summary: '実行完了' });
		});

		it('elicitInput には summary と confirmTitle が渡される', async () => {
			const elicitInput = vi.fn().mockResolvedValue({ action: 'decline' });

			await withElicitedConfirmation({
				...baseOpts,
				extra: { server: makeServer({ elicitInput }) },
				onConfirmed: vi.fn(),
				fallback: makeFallback(),
			});

			expect(elicitInput).toHaveBeenCalledWith({
				message: 'preview summary',
				requestedSchema: {
					type: 'object',
					properties: {
						confirmed: { type: 'boolean', title: 'Confirm this action' },
					},
					required: ['confirmed'],
				},
			});
		});

		it('accept + confirmed=true で onConfirmed が fail を返した場合は Error: プレフィックス付きで返る', async () => {
			const elicitInput = vi.fn().mockResolvedValue({ action: 'accept', content: { confirmed: true } });
			const onConfirmed = vi.fn().mockResolvedValue(fail('token_invalid', 'token_invalid'));

			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: { server: makeServer({ elicitInput }) },
				onConfirmed,
				fallback: makeFallback(),
			});

			// fail() は summary を 'Error: <msg>' に整形するため、ラッパーで更に 'Error: ' を前置すると
			// 'Error: Error: token_invalid' になる。既存 3 ハンドラの挙動を保持しているため統一。
			expect(result.content[0]?.text).toBe('Error: Error: token_invalid');
			expect(result.structuredContent).toMatchObject({ ok: false });
		});

		it('accept だが confirmed=false なら decline 扱い（onConfirmed は呼ばれない）', async () => {
			const elicitInput = vi.fn().mockResolvedValue({ action: 'accept', content: { confirmed: false } });
			const onConfirmed = vi.fn();
			const fallback = makeFallback();

			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: { server: makeServer({ elicitInput }) },
				onConfirmed,
				fallback,
			});

			expect(onConfirmed).not.toHaveBeenCalled();
			expect(result.content[0]?.text).toBe('ユーザーが操作を取り消しました');
			expect(result.structuredContent).toEqual({ declined: true });
		});

		it('accept だが content が無い場合も decline 扱い', async () => {
			const elicitInput = vi.fn().mockResolvedValue({ action: 'accept' });
			const onConfirmed = vi.fn();

			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: { server: makeServer({ elicitInput }) },
				onConfirmed,
				fallback: makeFallback(),
			});

			expect(onConfirmed).not.toHaveBeenCalled();
			expect(result.content[0]?.text).toBe('ユーザーが操作を取り消しました');
		});

		it('decline なら onConfirmed は呼ばれず onDeclinedText が返る', async () => {
			const elicitInput = vi.fn().mockResolvedValue({ action: 'decline' });
			const onConfirmed = vi.fn();

			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: { server: makeServer({ elicitInput }) },
				onConfirmed,
				fallback: makeFallback(),
			});

			expect(onConfirmed).not.toHaveBeenCalled();
			expect(result.content[0]?.text).toBe('ユーザーが操作を取り消しました');
			expect(result.structuredContent).toEqual({ declined: true });
		});

		it('cancel も decline と同じ扱い（accept-without-confirmed と挙動を統一）', async () => {
			const elicitInput = vi.fn().mockResolvedValue({ action: 'cancel' });
			const onConfirmed = vi.fn();

			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: { server: makeServer({ elicitInput }) },
				onConfirmed,
				fallback: makeFallback(),
			});

			expect(onConfirmed).not.toHaveBeenCalled();
			expect(result.content[0]?.text).toBe('ユーザーが操作を取り消しました');
			expect(result.structuredContent).toEqual({ declined: true });
		});
	});

	describe('例外伝播', () => {
		it('elicitInput が throw した場合は fallback を返す（捕捉してフォールバック）', async () => {
			const elicitInput = vi.fn().mockRejectedValue(new Error('connection lost'));
			const onConfirmed = vi.fn();
			const fallback = makeFallback();

			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: { server: makeServer({ elicitInput }) },
				onConfirmed,
				fallback,
			});

			expect(result).toEqual(fallback);
			expect(onConfirmed).not.toHaveBeenCalled();
		});

		it('onConfirmed が throw した場合は例外を伝播する（捕捉しない）', async () => {
			const elicitInput = vi.fn().mockResolvedValue({ action: 'accept', content: { confirmed: true } });
			const onConfirmed = vi.fn().mockRejectedValue(new Error('execute boom'));

			await expect(
				withElicitedConfirmation({
					...baseOpts,
					extra: { server: makeServer({ elicitInput }) },
					onConfirmed,
					fallback: makeFallback(),
				}),
			).rejects.toThrow('execute boom');
			expect(elicitInput).toHaveBeenCalledTimes(1);
			expect(onConfirmed).toHaveBeenCalledTimes(1);
		});
	});

	// 多層防御: caller が誤って confirmation_token / expires_at を含めて渡しても、
	// withElicitedConfirmation 内で必ず剥がされることを保証する。
	// caller 側 sanitize は将来のリファクタで消えうるため、helper レベルで unit テストする。
	describe('confirmation_token / expires_at の最終ガード', () => {
		const tokenLeakedStructured = {
			ok: true,
			summary: 'preview',
			data: {
				confirmation_token: 'SECRET-TOKEN',
				expires_at: 1_700_000_000_000,
				preview: { pair: 'btc_jpy' },
			},
			meta: { action: 'create_order' },
		} as Record<string, unknown>;

		it('elicitation 非対応ホスト: fallback.structuredContent から token が剥がされる', async () => {
			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: { server: makeServer({ supportsElicitation: false }) },
				onConfirmed: vi.fn(),
				declinedStructured: { declined: true } as Record<string, unknown>,
				fallback: {
					content: [{ type: 'text', text: 'FALLBACK_TEXT' }],
					structuredContent: tokenLeakedStructured,
				},
			});

			const data = (result.structuredContent as { data?: Record<string, unknown> }).data;
			expect(data?.confirmation_token).toBeUndefined();
			expect(data?.expires_at).toBeUndefined();
			expect(data?.preview).toEqual({ pair: 'btc_jpy' });
			// caller の渡したオブジェクトをミューテートしていないこと
			expect((tokenLeakedStructured.data as Record<string, unknown>).confirmation_token).toBe('SECRET-TOKEN');
		});

		it('decline 経路: declinedStructured から token が剥がされる', async () => {
			const elicitInput = vi.fn().mockResolvedValue({ action: 'decline' });

			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: { server: makeServer({ elicitInput }) },
				onConfirmed: vi.fn(),
				declinedStructured: tokenLeakedStructured,
				fallback: makeFallback(),
			});

			const data = (result.structuredContent as { data?: Record<string, unknown> }).data;
			expect(data?.confirmation_token).toBeUndefined();
			expect(data?.expires_at).toBeUndefined();
			expect(data?.preview).toEqual({ pair: 'btc_jpy' });
		});

		it('最上位の confirmation_token / expires_at も剥がす（形状違い caller 防御）', async () => {
			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: { server: makeServer({ supportsElicitation: false }) },
				onConfirmed: vi.fn(),
				declinedStructured: { declined: true } as Record<string, unknown>,
				fallback: {
					content: [{ type: 'text', text: 'FALLBACK_TEXT' }],
					structuredContent: {
						confirmation_token: 'TOP-LEVEL-TOKEN',
						expires_at: 1_700_000_000_000,
						other: 'kept',
					} as Record<string, unknown>,
				},
			});

			expect(result.structuredContent.confirmation_token).toBeUndefined();
			expect(result.structuredContent.expires_at).toBeUndefined();
			expect(result.structuredContent.other).toBe('kept');
		});
	});

	// BITBANK_TRUST_HOST_APPROVAL=1 のオプトイン妥協モード。
	// elicitation 非対応 + フラグ ON + trustHostFallback 指定の三者揃いで、
	// structuredContent から token を剥がさず caller のレスポンスをそのまま返す。
	// 詳細は docs/adr/0002-hitl-confirmation-token-delivery.md。
	describe('trust-host-approval モード（BITBANK_TRUST_HOST_APPROVAL=1）', () => {
		const tokenStructured = {
			ok: true,
			summary: 'preview',
			data: {
				confirmation_token: 'KEPT-TOKEN',
				expires_at: 1_700_000_000_000,
				preview: { pair: 'btc_jpy' },
			},
			meta: { action: 'create_order' },
		} as Record<string, unknown>;

		const makeTrustHostFallback = () => ({
			content: [{ type: 'text', text: 'IFRAME_BUTTON_GUIDE' }],
			structuredContent: tokenStructured,
		});

		afterEach(() => {
			delete process.env.BITBANK_TRUST_HOST_APPROVAL;
		});

		it('フラグ OFF（未設定）のときは trustHostFallback を渡しても従来の fallback（token strip）が返る', async () => {
			const trustHostFallback = makeTrustHostFallback();
			const fallback = makeFallback();
			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: { server: makeServer({ supportsElicitation: false }) },
				onConfirmed: vi.fn(),
				fallback,
				trustHostFallback,
			});

			expect(result.content[0]?.text).toBe('FALLBACK_TEXT');
			expect(result.structuredContent).toEqual({ fallback: true });
		});

		it('フラグ ON + 非対応ホスト + trustHostFallback 指定で token が strip されずに返る', async () => {
			process.env.BITBANK_TRUST_HOST_APPROVAL = '1';
			const trustHostFallback = makeTrustHostFallback();
			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: { server: makeServer({ supportsElicitation: false }) },
				onConfirmed: vi.fn(),
				fallback: makeFallback(),
				trustHostFallback,
			});

			expect(result.content[0]?.text).toBe('IFRAME_BUTTON_GUIDE');
			const data = (result.structuredContent as { data?: Record<string, unknown> }).data;
			expect(data?.confirmation_token).toBe('KEPT-TOKEN');
			expect(data?.expires_at).toBe(1_700_000_000_000);
		});

		it('フラグ ON でも trustHostFallback 未指定なら従来の fallback（strip）が返る', async () => {
			process.env.BITBANK_TRUST_HOST_APPROVAL = '1';
			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: { server: makeServer({ supportsElicitation: false }) },
				onConfirmed: vi.fn(),
				fallback: {
					content: [{ type: 'text', text: 'FALLBACK_TEXT' }],
					structuredContent: tokenStructured,
				},
			});

			expect(result.content[0]?.text).toBe('FALLBACK_TEXT');
			const data = (result.structuredContent as { data?: Record<string, unknown> }).data;
			expect(data?.confirmation_token).toBeUndefined();
			expect(data?.expires_at).toBeUndefined();
		});

		it('フラグ ON + elicitation 対応ホストでは通常の elicit 経路が優先される（trustHostFallback は無視）', async () => {
			process.env.BITBANK_TRUST_HOST_APPROVAL = '1';
			const elicitInput = vi.fn().mockResolvedValue({ action: 'accept', content: { confirmed: true } });
			const onConfirmed = vi.fn().mockResolvedValue(ok('executed', { order: 'OK' }, { fetchedAt: 'now' }));

			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: { server: makeServer({ elicitInput }) },
				onConfirmed,
				fallback: makeFallback(),
				trustHostFallback: makeTrustHostFallback(),
			});

			expect(elicitInput).toHaveBeenCalledTimes(1);
			expect(onConfirmed).toHaveBeenCalledTimes(1);
			expect(result.content[0]?.text).toBe('executed');
		});

		it('フラグ ON + elicitInput が例外で失敗した場合も trustHostFallback が返る', async () => {
			process.env.BITBANK_TRUST_HOST_APPROVAL = '1';
			const elicitInput = vi.fn().mockRejectedValue(new Error('boom'));
			const trustHostFallback = makeTrustHostFallback();

			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: { server: makeServer({ elicitInput }) },
				onConfirmed: vi.fn(),
				fallback: makeFallback(),
				trustHostFallback,
			});

			expect(result.content[0]?.text).toBe('IFRAME_BUTTON_GUIDE');
		});
	});
});
