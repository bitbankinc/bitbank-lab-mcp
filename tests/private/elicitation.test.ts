/**
 * src/private/elicitation.ts のユニットテスト。
 *
 * 共通化された preview → ユーザー確認 → execute の MRTR フロー（capability 判定、
 * round 1 の input_required 生成、round 2 の requestState 検証と confirm 応答分岐、
 * `onConfirmed` の例外伝播）を独立して検証する。
 * 3 つの preview ツール（preview_order / preview_cancel_order / preview_cancel_orders）の
 * 動作確認は引き続き `tests/private/preview_*.test.ts` で行う。
 */

import { isInputRequiredResult } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '../../lib/result.js';
import { clientSupportsElicitation, withElicitedConfirmation } from '../../src/private/elicitation.js';
import { _resetUsedNonces, digestArgs } from '../../src/private/request-state.js';

const ACTION = 'create_order';
const BIND_ARGS = { pair: 'btc_jpy', amount: '0.01', side: 'buy', type: 'limit' } as Record<string, unknown>;

/** elicitation 対応/非対応の 2025 系 fake サーバ */
function makeServer(supportsElicitation = true) {
	return {
		getClientCapabilities: () => (supportsElicitation ? { elicitation: {} } : {}),
	};
}

/** round 1 用 ctx（confirm 応答なし） */
function round1Ctx(supportsElicitation = true): Record<string, unknown> {
	return { server: makeServer(supportsElicitation) };
}

/**
 * round 2 用 ctx。requestState アクセサは verify フック通過後の decoded payload を返す想定。
 * state に null を渡すと「requestState なし」の再入を模す。
 */
function round2Ctx(
	confirmResponse: Record<string, unknown>,
	state: Record<string, unknown> | null = {
		action: ACTION,
		argsDigest: digestArgs(ACTION, BIND_ARGS),
		nonce: `nonce-${Math.random().toString(36).slice(2)}`,
	},
): Record<string, unknown> {
	return {
		server: makeServer(true),
		mcpReq: {
			inputResponses: { confirm: confirmResponse },
			requestState: () => state ?? undefined,
		},
	};
}

const ACCEPT = { action: 'accept', content: { confirmed: true } };

/** 既定の fallback McpResponse */
function makeFallback() {
	return {
		content: [{ type: 'text', text: 'FALLBACK_TEXT' }],
		structuredContent: { fallback: true } as Record<string, unknown>,
	};
}

const baseOpts = {
	action: ACTION,
	bindArgs: BIND_ARGS,
	summary: 'preview summary',
	confirmTitle: 'Confirm this action',
	onDeclinedText: 'ユーザーが操作を取り消しました',
	declinedStructured: { declined: true } as Record<string, unknown>,
};

const originalEnv = { ...process.env };

beforeEach(() => {
	_resetUsedNonces();
});

afterEach(() => {
	process.env = { ...originalEnv };
	vi.restoreAllMocks();
});

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

	it('capabilities.elicitation が存在すれば true（2025 系 initialize capabilities）', () => {
		const server = { getClientCapabilities: () => ({ elicitation: {} }) };
		expect(clientSupportsElicitation({ server })).toBe(true);
	});

	it('per-request envelope の clientCapabilities.elicitation でも true（2026-07-28 系）', () => {
		const extra = {
			mcpReq: { envelope: { clientCapabilities: { elicitation: {} } } },
		};
		expect(clientSupportsElicitation(extra)).toBe(true);
	});

	it('envelope の clientCapabilities に elicitation が無ければ false', () => {
		const extra = {
			mcpReq: { envelope: { clientCapabilities: { sampling: {} } } },
		};
		expect(clientSupportsElicitation(extra)).toBe(false);
	});
});

describe('withElicitedConfirmation', () => {
	describe('round 1 — input_required の生成', () => {
		it('elicitation 非対応ホストでは fallback を返す（onConfirmed は呼ばれない）', async () => {
			const onConfirmed = vi.fn();
			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: round1Ctx(false),
				onConfirmed,
				fallback: makeFallback(),
			});

			expect(result).toMatchObject({ content: [{ type: 'text', text: 'FALLBACK_TEXT' }] });
			expect(onConfirmed).not.toHaveBeenCalled();
		});

		it('extra が undefined でも fallback を返す', async () => {
			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: undefined,
				onConfirmed: vi.fn(),
				fallback: makeFallback(),
			});
			expect(result).toMatchObject({ content: [{ type: 'text', text: 'FALLBACK_TEXT' }] });
		});

		it('elicitation 対応ホストでは input_required（confirm 要求 + requestState）を返す', async () => {
			const onConfirmed = vi.fn();
			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: round1Ctx(true),
				onConfirmed,
				fallback: makeFallback(),
			});

			expect(isInputRequiredResult(result)).toBe(true);
			const mrtr = result as unknown as { inputRequests: Record<string, unknown>; requestState?: string };
			expect(mrtr.inputRequests).toHaveProperty('confirm');
			expect(typeof mrtr.requestState).toBe('string');
			// message には preview サマリ、スキーマには confirmTitle が載る
			const json = JSON.stringify(result);
			expect(json).toContain('preview summary');
			expect(json).toContain('Confirm this action');
			expect(onConfirmed).not.toHaveBeenCalled();
		});

		it('2026 系 envelope capabilities のみのホストでも input_required を返す', async () => {
			const extra = { mcpReq: { envelope: { clientCapabilities: { elicitation: {} } } } };
			const result = await withElicitedConfirmation({
				...baseOpts,
				extra,
				onConfirmed: vi.fn(),
				fallback: makeFallback(),
			});
			expect(isInputRequiredResult(result)).toBe(true);
		});

		it('fallback の structuredContent から confirmation_token / expires_at が剥がされる', async () => {
			const result = (await withElicitedConfirmation({
				...baseOpts,
				extra: round1Ctx(false),
				onConfirmed: vi.fn(),
				fallback: {
					content: [{ type: 'text', text: 'FALLBACK_TEXT' }],
					structuredContent: {
						confirmation_token: 'top-secret',
						expires_at: 123,
						data: { confirmation_token: 'nested-secret', expires_at: 456, preview: { pair: 'btc_jpy' } },
					},
				},
			})) as { structuredContent: Record<string, unknown> };

			expect(result.structuredContent.confirmation_token).toBeUndefined();
			expect(result.structuredContent.expires_at).toBeUndefined();
			const data = result.structuredContent.data as Record<string, unknown>;
			expect(data.confirmation_token).toBeUndefined();
			expect(data.expires_at).toBeUndefined();
			expect(data.preview).toEqual({ pair: 'btc_jpy' });
		});
	});

	describe('round 2 — confirm 応答による分岐', () => {
		it('accept + confirmed=true なら onConfirmed が呼ばれて結果が返る（成功）', async () => {
			const onConfirmed = vi.fn().mockResolvedValue(ok('実行完了', { order_id: 1 }));
			const result = (await withElicitedConfirmation({
				...baseOpts,
				extra: round2Ctx(ACCEPT),
				onConfirmed,
				fallback: makeFallback(),
			})) as { content: { text: string }[]; structuredContent: Record<string, unknown> };

			expect(onConfirmed).toHaveBeenCalledTimes(1);
			expect(result.content[0]?.text).toBe('実行完了');
			expect(result.structuredContent).toMatchObject({ ok: true });
		});

		it('accept + confirmed=true で onConfirmed が fail を返した場合は Error: プレフィックス付きで返る', async () => {
			// fail() ヘルパーは summary に自ら 'Error: ' を付けるため、ここでは prefix 付与
			// ロジック自体を検証する目的で素の FailResult 形を渡す
			const onConfirmed = vi
				.fn()
				.mockResolvedValue({ ok: false, summary: '発注に失敗しました', data: {}, meta: { errorType: 'api_error' } });
			const result = (await withElicitedConfirmation({
				...baseOpts,
				extra: round2Ctx(ACCEPT),
				onConfirmed,
				fallback: makeFallback(),
			})) as { content: { text: string }[] };

			expect(result.content[0]?.text).toBe('Error: 発注に失敗しました');
		});

		it('decline なら onConfirmed は呼ばれず onDeclinedText が返る', async () => {
			const onConfirmed = vi.fn();
			const result = (await withElicitedConfirmation({
				...baseOpts,
				extra: round2Ctx({ action: 'decline' }),
				onConfirmed,
				fallback: makeFallback(),
			})) as { content: { text: string }[]; structuredContent: Record<string, unknown> };

			expect(onConfirmed).not.toHaveBeenCalled();
			expect(result.content[0]?.text).toBe('ユーザーが操作を取り消しました');
			expect(result.structuredContent).toMatchObject({ declined: true });
		});

		it('cancel も decline と同じ扱い', async () => {
			const onConfirmed = vi.fn();
			const result = (await withElicitedConfirmation({
				...baseOpts,
				extra: round2Ctx({ action: 'cancel' }),
				onConfirmed,
				fallback: makeFallback(),
			})) as { content: { text: string }[] };

			expect(onConfirmed).not.toHaveBeenCalled();
			expect(result.content[0]?.text).toBe('ユーザーが操作を取り消しました');
		});

		it('accept だが confirmed=false なら decline 扱い（onConfirmed は呼ばれない）', async () => {
			const onConfirmed = vi.fn();
			const result = (await withElicitedConfirmation({
				...baseOpts,
				extra: round2Ctx({ action: 'accept', content: { confirmed: false } }),
				onConfirmed,
				fallback: makeFallback(),
			})) as { content: { text: string }[] };

			expect(onConfirmed).not.toHaveBeenCalled();
			expect(result.content[0]?.text).toBe('ユーザーが操作を取り消しました');
		});

		it('accept だが content が無い場合も decline 扱い', async () => {
			const onConfirmed = vi.fn();
			const result = (await withElicitedConfirmation({
				...baseOpts,
				extra: round2Ctx({ action: 'accept' }),
				onConfirmed,
				fallback: makeFallback(),
			})) as { content: { text: string }[] };

			expect(onConfirmed).not.toHaveBeenCalled();
			expect(result.content[0]?.text).toBe('ユーザーが操作を取り消しました');
		});

		it('decline 経路: declinedStructured から token が剥がされる', async () => {
			const result = (await withElicitedConfirmation({
				...baseOpts,
				extra: round2Ctx({ action: 'decline' }),
				onConfirmed: vi.fn(),
				fallback: makeFallback(),
				declinedStructured: {
					declined: true,
					confirmation_token: 'top-secret',
					data: { confirmation_token: 'nested-secret', expires_at: 456 },
				},
			})) as { structuredContent: Record<string, unknown> };

			expect(result.structuredContent.confirmation_token).toBeUndefined();
			const data = result.structuredContent.data as Record<string, unknown>;
			expect(data.confirmation_token).toBeUndefined();
			expect(data.expires_at).toBeUndefined();
		});

		it('onConfirmed が throw した場合は例外を伝播する（捕捉しない）', async () => {
			const onConfirmed = vi.fn().mockRejectedValue(new Error('execute failed'));
			await expect(
				withElicitedConfirmation({
					...baseOpts,
					extra: round2Ctx(ACCEPT),
					onConfirmed,
					fallback: makeFallback(),
				}),
			).rejects.toThrow('execute failed');
		});
	});

	describe('round 2 — requestState の文脈バインド検証', () => {
		const INVALID_TEXT = '確認情報が無効なため実行しませんでした';

		it('requestState が無い再入では実行しない', async () => {
			const onConfirmed = vi.fn();
			const result = (await withElicitedConfirmation({
				...baseOpts,
				extra: round2Ctx(ACCEPT, null),
				onConfirmed,
				fallback: makeFallback(),
			})) as { content: { text: string }[] };

			expect(onConfirmed).not.toHaveBeenCalled();
			expect(result.content[0]?.text).toContain(INVALID_TEXT);
		});

		it('action が一致しない requestState では実行しない', async () => {
			const onConfirmed = vi.fn();
			const result = (await withElicitedConfirmation({
				...baseOpts,
				extra: round2Ctx(ACCEPT, {
					action: 'cancel_order',
					argsDigest: digestArgs('cancel_order', BIND_ARGS),
					nonce: 'nonce-wrong-action',
				}),
				onConfirmed,
				fallback: makeFallback(),
			})) as { content: { text: string }[] };

			expect(onConfirmed).not.toHaveBeenCalled();
			expect(result.content[0]?.text).toContain(INVALID_TEXT);
		});

		it('引数を差し替えた再試行（argsDigest 不一致）では実行しない', async () => {
			const onConfirmed = vi.fn();
			// requestState は別の引数（amount 100 倍）で mint された想定
			const tamperedArgs = { ...BIND_ARGS, amount: '1.00' };
			const result = (await withElicitedConfirmation({
				...baseOpts,
				extra: round2Ctx(ACCEPT, {
					action: ACTION,
					argsDigest: digestArgs(ACTION, tamperedArgs),
					nonce: 'nonce-tampered-args',
				}),
				onConfirmed,
				fallback: makeFallback(),
			})) as { content: { text: string }[] };

			expect(onConfirmed).not.toHaveBeenCalled();
			expect(result.content[0]?.text).toContain(INVALID_TEXT);
		});

		it('同じ nonce の再利用（replay）では 2 回目は実行しない', async () => {
			const onConfirmed = vi.fn().mockResolvedValue(ok('実行完了', {}));
			const state = { action: ACTION, argsDigest: digestArgs(ACTION, BIND_ARGS), nonce: 'nonce-replay' };

			const first = (await withElicitedConfirmation({
				...baseOpts,
				extra: round2Ctx(ACCEPT, state),
				onConfirmed,
				fallback: makeFallback(),
			})) as { content: { text: string }[] };
			expect(first.content[0]?.text).toBe('実行完了');
			expect(onConfirmed).toHaveBeenCalledTimes(1);

			const second = (await withElicitedConfirmation({
				...baseOpts,
				extra: round2Ctx(ACCEPT, state),
				onConfirmed,
				fallback: makeFallback(),
			})) as { content: { text: string }[] };
			expect(second.content[0]?.text).toContain(INVALID_TEXT);
			expect(onConfirmed).toHaveBeenCalledTimes(1);
		});

		it('decline でも nonce は消費される（拒否済み確認の accept 付き replay を拒否）', async () => {
			const onConfirmed = vi.fn();
			const state = { action: ACTION, argsDigest: digestArgs(ACTION, BIND_ARGS), nonce: 'nonce-decline-replay' };

			const declined = (await withElicitedConfirmation({
				...baseOpts,
				extra: round2Ctx({ action: 'decline' }, state),
				onConfirmed,
				fallback: makeFallback(),
			})) as { content: { text: string }[] };
			expect(declined.content[0]?.text).toBe('ユーザーが操作を取り消しました');

			const replayed = (await withElicitedConfirmation({
				...baseOpts,
				extra: round2Ctx(ACCEPT, state),
				onConfirmed,
				fallback: makeFallback(),
			})) as { content: { text: string }[] };
			expect(replayed.content[0]?.text).toContain(INVALID_TEXT);
			expect(onConfirmed).not.toHaveBeenCalled();
		});

		it('無効 state のレスポンスでも declinedStructured から token が剥がされる', async () => {
			const result = (await withElicitedConfirmation({
				...baseOpts,
				extra: round2Ctx(ACCEPT, null),
				onConfirmed: vi.fn(),
				fallback: makeFallback(),
				declinedStructured: { confirmation_token: 'top-secret', declined: true },
			})) as { structuredContent: Record<string, unknown> };

			expect(result.structuredContent.confirmation_token).toBeUndefined();
			expect(result.structuredContent.declined).toBe(true);
		});
	});

	describe('trust-host-approval モード（BITBANK_TRUST_HOST_APPROVAL=1）', () => {
		const trustHostFallback = {
			content: [{ type: 'text', text: 'TRUST_HOST_TEXT' }],
			structuredContent: { confirmation_token: 'iframe-token', expires_at: 123 } as Record<string, unknown>,
		};

		it('フラグ OFF なら trustHostFallback は無視され fallback が返る', async () => {
			delete process.env.BITBANK_TRUST_HOST_APPROVAL;
			const result = (await withElicitedConfirmation({
				...baseOpts,
				extra: round1Ctx(false),
				onConfirmed: vi.fn(),
				fallback: makeFallback(),
				trustHostFallback,
			})) as { content: { text: string }[] };

			expect(result.content[0]?.text).toBe('FALLBACK_TEXT');
		});

		it('フラグ ON + elicitation 非対応なら trustHostFallback を token 付きのまま返す', async () => {
			process.env.BITBANK_TRUST_HOST_APPROVAL = '1';
			const result = (await withElicitedConfirmation({
				...baseOpts,
				extra: round1Ctx(false),
				onConfirmed: vi.fn(),
				fallback: makeFallback(),
				trustHostFallback,
			})) as { content: { text: string }[]; structuredContent: Record<string, unknown> };

			expect(result.content[0]?.text).toBe('TRUST_HOST_TEXT');
			// 妥協モードでは token を strip しない（iframe ボタン経路を成立させる）
			expect(result.structuredContent.confirmation_token).toBe('iframe-token');
		});

		it('フラグ ON + elicitation 対応ホストでは通常の MRTR 経路が優先される（trustHostFallback は無視）', async () => {
			process.env.BITBANK_TRUST_HOST_APPROVAL = '1';
			const result = await withElicitedConfirmation({
				...baseOpts,
				extra: round1Ctx(true),
				onConfirmed: vi.fn(),
				fallback: makeFallback(),
				trustHostFallback,
			});

			expect(isInputRequiredResult(result)).toBe(true);
		});
	});
});
