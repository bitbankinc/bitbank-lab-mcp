// 鍵は per-process ランダム。stdio サーバーは単一プロセスが全ラウンドを処理する前提なのでこれで足り、プロセス再起動で pending の確認は無効化される（安全側）。

import { createHash, randomBytes } from 'node:crypto';
import { createRequestStateCodec, type ServerContext } from '@modelcontextprotocol/server';
import { BoundedExpiringSet } from '../../lib/bounded-expiring-set.js';

/** requestState の payload。秘匿情報は含めない（署名のみで暗号化されないため）。 */
export interface ConfirmRequestState {
	action: string;
	argsDigest: string;
	nonce: string;
}

/** 人間の確認操作を待つ時間として confirmation token より長め。 */
const REQUEST_STATE_TTL_SECONDS = 300;

/** requestState TTL と揃える。期限切れの requestState は SDK の verify フックが nonce 検証より先に落とすので、これより長く覚えても replay 防御には寄与しない。 */
export const NONCE_RETENTION_MS = REQUEST_STATE_TTL_SECONDS * 1000;

/** 未設定の `sessionId` / `principal` を空文字に畳んでいる。HTTP トランスポートを足すと空文字同士が一致して越境再利用を弾けないので、同じ PR で「未設定は fail-closed」に変える（ADR-0007 判断事項 B、`tests/http-transport-tripwire.test.ts`）。 */
export function bindRequestStateContext(ctx: ServerContext): string {
	const method = typeof ctx.mcpReq?.method === 'string' ? ctx.mcpReq.method : '';
	const sessionId = typeof ctx.sessionId === 'string' ? ctx.sessionId : '';
	const principal = typeof ctx.http?.authInfo?.clientId === 'string' ? ctx.http.authInfo.clientId : '';
	return `${method}\0${sessionId}\0${principal}`;
}

export const requestStateCodec = createRequestStateCodec<ConfirmRequestState>({
	key: randomBytes(32),
	ttlSeconds: REQUEST_STATE_TTL_SECONDS,
	bind: bindRequestStateContext,
});

export function digestArgs(action: string, args: Record<string, unknown>): string {
	const canonical = JSON.stringify(sortValue({ action, args }));
	return createHash('sha256').update(canonical).digest('hex');
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		return Object.keys(obj)
			.sort()
			.reduce<Record<string, unknown>>((acc, key) => {
				if (obj[key] !== undefined) acc[key] = sortValue(obj[key]);
				return acc;
			}, {});
	}
	return value;
}

export function mintConfirmState(action: string, args: Record<string, unknown>, ctx: ServerContext): Promise<string> {
	return requestStateCodec.mint(
		{
			action,
			argsDigest: digestArgs(action, args),
			nonce: randomBytes(16).toString('hex'),
		},
		ctx,
	);
}

/** 件数上限は `BoundedExpiringSet` の既定値をそのまま使う。ここで定数を定義し直すと、環境変数 `REPLAY_GUARD_MAX_ENTRIES` の上書きが片方にしか効かなくなる。 */
const usedNonces = new BoundedExpiringSet();

export type NonceConsumeFailureReason =
	| 'already_used'
	| 'capacity_exceeded'
	/** 現行経路では返らない（有限な nowMs から算出している）が、将来発生したとき already_used に紛れないよう潰さずに伝播させる */
	| 'invalid_expiry';

/** 判別可能ユニオンなので `consumed` で絞り込まないと `reason` を読めず、「消費できなかったのに実行してしまう」書き方にならない。 */
export type NonceConsumeResult =
	| { readonly consumed: true }
	| { readonly consumed: false; readonly reason: NonceConsumeFailureReason };

/** nonce 本文はログにもエラー文言にも出さない（`.claude/rules/sensitive-data.md` の CRITICAL 分類）。 */
export function consumeNonce(nonce: string, nowMs: number = Date.now()): NonceConsumeResult {
	const res = usedNonces.add(nonce, nowMs + NONCE_RETENTION_MS, nowMs);
	if (res.added) return { consumed: true };
	return { consumed: false, reason: res.reason === 'already_recorded' ? 'already_used' : res.reason };
}

export function startNonceCleanupTimer(): void {
	usedNonces.startCleanupTimer();
}

export function stopNonceCleanupTimer(): void {
	usedNonces.stopCleanupTimer();
}

export function _isNonceCleanupTimerActive(): boolean {
	return usedNonces.isCleanupTimerActive();
}

export function _resetUsedNonces(): void {
	usedNonces.clear();
}

export function _usedNonceCount(): number {
	return usedNonces.size();
}
