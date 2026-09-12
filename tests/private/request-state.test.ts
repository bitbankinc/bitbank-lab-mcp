/**
 * src/private/request-state.ts のユニットテスト。
 *
 * MRTR requestState の HMAC / 期限 / bind（method・session・principal）と
 * nonce replay 防御を検証する。
 */

import type { ServerContext } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PURGE_INTERVAL_MS } from '../../lib/bounded-expiring-set.js';
import {
	_isNonceCleanupTimerActive,
	_resetUsedNonces,
	_usedNonceCount,
	bindRequestStateContext,
	consumeNonce,
	digestArgs,
	mintConfirmState,
	NONCE_RETENTION_MS,
	requestStateCodec,
	startNonceCleanupTimer,
	stopNonceCleanupTimer,
} from '../../src/private/request-state.js';

const ACTION = 'create_order';
const ARGS = { pair: 'btc_jpy', amount: '0.01', side: 'buy', type: 'limit' } as Record<string, unknown>;

/**
 * mint / verify 用の最小 ServerContext。
 *
 * bind（`bindRequestStateContext`）が読むのは `mcpReq.method` / `sessionId` /
 * `http.authInfo.clientId` だけなので、その 3 つ（と必須の `mcpReq.id`）のみを与える。
 * ServerContext の残りのメンバはダミーを置かない——スタブを足すと ServerContext 側が
 * この部分型へ代入できなくなり、キャストが TS2352（overlap 不足）になる。
 */
function ctx(overrides: { sessionId?: string; method?: string; clientId?: string } = {}): ServerContext {
	return {
		sessionId: overrides.sessionId,
		mcpReq: {
			id: 1,
			method: overrides.method ?? 'tools/call',
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

/** 固定 epoch ms（テスト内で時刻を明示する起点） */
const T0 = 1_786_291_200_000;

/**
 * 件数上限を差し替えた request-state モジュールを読み直す。
 *
 * `usedNonces` はモジュールスコープの singleton で、上限は生成時に
 * `REPLAY_GUARD_MAX_ENTRIES` から解決される。上限テストのためだけに本番コードへ
 * テスト専用の setter を生やさず、モジュールごと作り直して検証する
 * （環境変数による上書きが nonce 側にも効いていることの検証も兼ねる）。
 */
async function importWithMaxEntries(maxEntries: string) {
	vi.resetModules();
	vi.stubEnv('REPLAY_GUARD_MAX_ENTRIES', maxEntries);
	return await import('../../src/private/request-state.js');
}

afterEach(() => {
	stopNonceCleanupTimer();
	_resetUsedNonces();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.resetModules();
	vi.restoreAllMocks();
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
		expect(consumeNonce('nonce-1')).toEqual({ consumed: true });
		expect(consumeNonce('nonce-1')).toEqual({ consumed: false, reason: 'already_used' });
	});

	it('mint → verify → 消費 → replay 拒否（stdio 相当: sessionId / principal が空）', async () => {
		const stdio = ctx();
		const state = await mintConfirmState(ACTION, ARGS, stdio);
		const payload = await requestStateCodec.verify(state, ctx());

		expect(consumeNonce(payload.nonce)).toEqual({ consumed: true });
		expect(consumeNonce(payload.nonce)).toEqual({ consumed: false, reason: 'already_used' });
	});

	it('保持期間の境界: 期限ちょうどまでは replay 扱い、1ms 超えるとアクセス時 purge で消える', () => {
		expect(consumeNonce('nonce-ttl', T0).consumed).toBe(true);
		// 期限ちょうど（記録は生存）
		expect(consumeNonce('nonce-ttl', T0 + NONCE_RETENTION_MS)).toEqual({
			consumed: false,
			reason: 'already_used',
		});
		// 期限切れ → アクセス時 purge で除去され、同じ nonce を再び記録できる
		expect(consumeNonce('nonce-ttl', T0 + NONCE_RETENTION_MS + 1)).toEqual({ consumed: true });
		expect(_usedNonceCount()).toBe(1);
	});

	it('保持期間は requestState の TTL（300 秒）と一致する', () => {
		expect(NONCE_RETENTION_MS).toBe(300 * 1000);
	});

	it('件数上限の手前までは従来どおり消費できる', async () => {
		const mod = await importWithMaxEntries('3');
		expect(mod.consumeNonce('n1', T0)).toEqual({ consumed: true });
		expect(mod.consumeNonce('n2', T0)).toEqual({ consumed: true });
		expect(mod.consumeNonce('n3', T0)).toEqual({ consumed: true });
		expect(mod._usedNonceCount()).toBe(3);
	});

	it('件数上限に達すると true を返さない（fail-closed）', async () => {
		const mod = await importWithMaxEntries('3');
		mod.consumeNonce('n1', T0);
		mod.consumeNonce('n2', T0);
		mod.consumeNonce('n3', T0);

		expect(mod.consumeNonce('n4', T0)).toEqual({ consumed: false, reason: 'capacity_exceeded' });
	});

	it('上限到達時も生存 nonce は追い出されず、使用済み nonce は再び通らない', async () => {
		const mod = await importWithMaxEntries('3');
		mod.consumeNonce('n1', T0);
		mod.consumeNonce('n2', T0);
		mod.consumeNonce('n3', T0);
		mod.consumeNonce('overflow', T0);

		// 記録件数は上限のまま（新しい nonce のために生存記録を退避していない）
		expect(mod._usedNonceCount()).toBe(3);
		// 退避されていれば「未使用」に巻き戻って replay が通ってしまう
		expect(mod.consumeNonce('n1', T0)).toEqual({ consumed: false, reason: 'already_used' });
		expect(mod.consumeNonce('n2', T0)).toEqual({ consumed: false, reason: 'already_used' });
		expect(mod.consumeNonce('n3', T0)).toEqual({ consumed: false, reason: 'already_used' });
		// 拒否された nonce 自体も記録されていない（消費されていない）
		expect(mod._usedNonceCount()).toBe(3);
	});

	it('上限到達後も期限切れが purge されれば回復する', async () => {
		const mod = await importWithMaxEntries('2');
		mod.consumeNonce('old-1', T0);
		mod.consumeNonce('old-2', T0);
		expect(mod.consumeNonce('new-1', T0)).toEqual({ consumed: false, reason: 'capacity_exceeded' });

		// 保持期間を過ぎれば同じ nonce でも空きができる
		expect(mod.consumeNonce('new-1', T0 + NONCE_RETENTION_MS + 1)).toEqual({ consumed: true });
	});
});

describe('nonce の定期 purge タイマー', () => {
	it('保持期間を過ぎた nonce が定期 purge で除去される', () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);

		expect(consumeNonce('nonce-timer').consumed).toBe(true);
		startNonceCleanupTimer();

		// 保持期間内は残る（purge 間隔 60 秒 × 5 回分進めても期限に達していない）
		vi.advanceTimersByTime(NONCE_RETENTION_MS);
		expect(_usedNonceCount()).toBe(1);

		// 期限を超えた最初の定期 purge で消える（アクセスが一度も無くても消える）
		vi.advanceTimersByTime(DEFAULT_PURGE_INTERVAL_MS);
		expect(_usedNonceCount()).toBe(0);
	});

	it('停止後は定期 purge が走らない', () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);

		consumeNonce('nonce-stopped');
		startNonceCleanupTimer();
		stopNonceCleanupTimer();

		vi.advanceTimersByTime(NONCE_RETENTION_MS * 10);
		expect(_usedNonceCount()).toBe(1);
	});

	it('二重起動しない（2 回呼んでもタイマーは 1 つ）', () => {
		const spy = vi.spyOn(globalThis, 'setInterval');

		expect(_isNonceCleanupTimerActive()).toBe(false);
		startNonceCleanupTimer();
		startNonceCleanupTimer(); // 2 回目は no-op
		expect(spy).toHaveBeenCalledTimes(1);
		expect(_isNonceCleanupTimerActive()).toBe(true);

		stopNonceCleanupTimer();
		expect(_isNonceCleanupTimerActive()).toBe(false);
	});

	it('stopNonceCleanupTimer は複数回呼んでも安全、停止後に再開できる', () => {
		stopNonceCleanupTimer();
		expect(_isNonceCleanupTimerActive()).toBe(false);

		startNonceCleanupTimer();
		stopNonceCleanupTimer();
		stopNonceCleanupTimer();
		expect(_isNonceCleanupTimerActive()).toBe(false);

		startNonceCleanupTimer();
		expect(_isNonceCleanupTimerActive()).toBe(true);
		stopNonceCleanupTimer();
	});

	it('タイマーは unref される（プロセス終了をブロックしない）', () => {
		const unref = vi.fn();
		const handle = { unref } as unknown as ReturnType<typeof setInterval>;
		vi.spyOn(globalThis, 'setInterval').mockReturnValue(handle as never);

		startNonceCleanupTimer();
		expect(unref).toHaveBeenCalledTimes(1);

		stopNonceCleanupTimer();
	});
});
