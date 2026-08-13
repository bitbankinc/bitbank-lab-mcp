/**
 * src/private/request-state.ts のユニットテスト。
 *
 * MRTR requestState の HMAC / 期限 / bind（method・session・principal）と
 * nonce replay 防御を検証する。
 */

import type { ServerContext } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	_resetUsedNonces,
	bindRequestStateContext,
	consumeNonce,
	digestArgs,
	mintConfirmState,
	requestStateCodec,
} from '../../src/private/request-state.js';

const ACTION = 'create_order';
const ARGS = { pair: 'btc_jpy', amount: '0.01', side: 'buy', type: 'limit' } as Record<string, unknown>;

/** mint / verify 用の最小 ServerContext。 */
function ctx(overrides: { sessionId?: string; method?: string; clientId?: string } = {}): ServerContext {
	return {
		sessionId: overrides.sessionId,
		mcpReq: {
			id: 1,
			method: overrides.method ?? 'tools/call',
			log: async () => {},
			elicitInput: async () => ({ action: 'cancel' }),
			createMessage: async () => ({ role: 'assistant', content: { type: 'text', text: '' } }),
		},
		...(overrides.clientId
			? {
					http: {
						authInfo: {
							token: 'must-not-appear-in-bind',
							clientId: overrides.clientId,
							scopes: [],
						},
					},
				}
			: {}),
	} as ServerContext;
}

afterEach(() => {
	_resetUsedNonces();
	vi.useRealTimers();
});

describe('bindRequestStateContext', () => {
	it('method / sessionId / principal を束縛し、token は含めない', () => {
		const bound = bindRequestStateContext(ctx({ sessionId: 'sess-a', clientId: 'client-1' }));
		expect(bound).toBe('tools/call\0sess-a\0client-1');
		expect(bound).not.toContain('must-not-appear-in-bind');
	});

	it('stdio 相当（sessionId / principal なし）では method のみ', () => {
		expect(bindRequestStateContext(ctx())).toBe('tools/call\0\0');
	});
});

describe('digestArgs', () => {
	it('キー順が違っても同じ digest になる', () => {
		const a = digestArgs(ACTION, { b: 1, a: 2 });
		const b = digestArgs(ACTION, { a: 2, b: 1 });
		expect(a).toBe(b);
	});

	it('action が異なれば digest も異なる', () => {
		expect(digestArgs('create_order', ARGS)).not.toBe(digestArgs('cancel_order', ARGS));
	});
});

describe('mintConfirmState / requestStateCodec.verify', () => {
	it('同一セッションでは mint → verify が成功し payload が復元される', async () => {
		const same = ctx({ sessionId: 'sess-a' });
		const state = await mintConfirmState(ACTION, ARGS, same);
		const payload = await requestStateCodec.verify(state, same);
		expect(payload.action).toBe(ACTION);
		expect(payload.argsDigest).toBe(digestArgs(ACTION, ARGS));
		expect(typeof payload.nonce).toBe('string');
		expect(payload.nonce.length).toBeGreaterThan(0);
	});

	it('stdio 相当（sessionId 未設定）でも mint → verify が成功する', async () => {
		const stdio = ctx();
		const state = await mintConfirmState(ACTION, ARGS, stdio);
		await expect(requestStateCodec.verify(state, ctx())).resolves.toMatchObject({ action: ACTION });
	});

	it('セッション A で発行した requestState をセッション B で使うと拒否される', async () => {
		const state = await mintConfirmState(ACTION, ARGS, ctx({ sessionId: 'sess-a' }));
		await expect(requestStateCodec.verify(state, ctx({ sessionId: 'sess-b' }))).rejects.toThrow('bind');
	});

	it('method が異なる requestState の再利用が拒否される', async () => {
		const state = await mintConfirmState(ACTION, ARGS, ctx({ method: 'tools/call' }));
		await expect(requestStateCodec.verify(state, ctx({ method: 'prompts/get' }))).rejects.toThrow('bind');
	});

	it('principal（clientId）が異なると拒否される', async () => {
		const state = await mintConfirmState(ACTION, ARGS, ctx({ clientId: 'client-a' }));
		await expect(requestStateCodec.verify(state, ctx({ clientId: 'client-b' }))).rejects.toThrow('bind');
	});

	it('改竄（payload 改変）は mac 検証で拒否される', async () => {
		const state = await mintConfirmState(ACTION, ARGS, ctx({ sessionId: 'sess-a' }));
		const [prefix, body, mac] = state.split('.');
		expect(prefix).toBe('v1');
		expect(body).toBeTruthy();
		expect(mac).toBeTruthy();
		// body の末尾をわずかに改変（base64url として壊さない範囲で）
		const tamperedBody = `${body!.slice(0, -1)}${body!.endsWith('A') ? 'B' : 'A'}`;
		const tampered = `${prefix}.${tamperedBody}.${mac}`;
		await expect(requestStateCodec.verify(tampered, ctx({ sessionId: 'sess-a' }))).rejects.toThrow();
	});

	it('期限切れの requestState は拒否される', async () => {
		vi.useFakeTimers();
		const t0 = 1_786_291_200_000; // 固定 epoch ms
		vi.setSystemTime(t0);
		const same = ctx({ sessionId: 'sess-a' });
		const state = await mintConfirmState(ACTION, ARGS, same);
		// TTL は 300 秒。それを超えて進める
		vi.setSystemTime(t0 + 301_000);
		await expect(requestStateCodec.verify(state, same)).rejects.toThrow('expired');
	});

	it('wire 上の payload に confirmation_token / sessionId / token を載せない', async () => {
		const state = await mintConfirmState(ACTION, ARGS, ctx({ sessionId: 'sess-secret', clientId: 'client-1' }));
		const body = state.split('.')[1]!;
		const padded = body.replace(/-/g, '+').replace(/_/g, '/');
		const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
		const json = Buffer.from(padded + pad, 'base64').toString('utf8');
		expect(json).not.toContain('confirmation_token');
		expect(json).not.toContain('sess-secret');
		expect(json).not.toContain('client-1');
		expect(json).not.toContain('must-not-appear-in-bind');
		const envelope = JSON.parse(json) as { p: ConfirmPayload; b?: string };
		expect(envelope.p).toEqual({
			action: ACTION,
			argsDigest: digestArgs(ACTION, ARGS),
			nonce: expect.any(String),
		});
		expect(typeof envelope.b).toBe('string');
	});
});

type ConfirmPayload = { action: string; argsDigest: string; nonce: string };

describe('consumeNonce', () => {
	it('初回は成功し、同一 nonce の再利用（replay）は拒否される', () => {
		expect(consumeNonce('nonce-1')).toBe(true);
		expect(consumeNonce('nonce-1')).toBe(false);
	});
});
