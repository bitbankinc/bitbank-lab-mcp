import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddRejectReason } from '../../lib/bounded-expiring-set.js';
import { BoundedExpiringSet } from '../../lib/bounded-expiring-set.js';

const DEFAULT_TTL_MS = 60_000;

const MAX_TTL_MS = 300_000;

const CLEANUP_INTERVAL_MS = 60_000;

/** 件数上限は `BoundedExpiringSet` の `DEFAULT_MAX_ENTRIES` をそのまま使う。ここで定数を持つと上限の定義が 2 箇所に割れ、`REPLAY_GUARD_MAX_ENTRIES` の上書きが確認トークンだけ効かなくなる。 */
function createUsedTokenStore(maxEntries?: number): BoundedExpiringSet {
	return new BoundedExpiringSet({ maxEntries, purgeIntervalMs: CLEANUP_INTERVAL_MS });
}

let usedTokens = createUsedTokenStore();

export function purgeExpiredTokens(nowMs: number = Date.now()): number {
	return usedTokens.purgeExpired(nowMs);
}

export function startCleanupTimer(): void {
	usedTokens.startCleanupTimer();
}

export function stopCleanupTimer(): void {
	usedTokens.stopCleanupTimer();
}

export function _resetUsedTokens(options?: { maxEntries?: number }): void {
	if (options?.maxEntries == null) {
		usedTokens.clear();
		return;
	}
	const wasActive = usedTokens.isCleanupTimerActive();
	usedTokens.stopCleanupTimer();
	usedTokens = createUsedTokenStore(options.maxEntries);
	if (wasActive) usedTokens.startCleanupTimer();
}

export function _usedTokenCount(): number {
	return usedTokens.size();
}

export function _usedTokenCapacity(): number {
	return usedTokens.maxEntries;
}

export function _isCleanupTimerActive(): boolean {
	return usedTokens.isCleanupTimerActive();
}

function getTtlMs(): number {
	const env = process.env.ORDER_CONFIRM_TTL_MS;
	if (env) {
		const n = Number(env);
		if (Number.isFinite(n) && n > 0) return Math.min(n, MAX_TTL_MS);
	}
	return DEFAULT_TTL_MS;
}

export function confirmationTtlSeconds(): number {
	return Math.floor(getTtlMs() / 1000);
}

function getSecret(): string {
	const secret = process.env.BITBANK_API_SECRET;
	if (!secret) throw new Error('BITBANK_API_SECRET is not configured');
	return secret;
}

/** 守りたい単位は OS プロセスなので `globalThis` に置く。モジュールスコープだと `vi.resetModules()` などで再評価されるたびに値が変わり、同じプロセスで発行したトークンを検証できなくなる。 */
const PROCESS_NONCE_KEY = Symbol.for('bitbank-lab-mcp.confirmation.processNonce');

/** 署名鍵に混ぜてトークンをプロセスへ束縛する。使用済み記録はプロセス内メモリにしか無いので、無いと再起動後や同じ secret を持つ別プロセスで使用済みトークンがもう一度通る（ADR-0007）。 */
function getProcessNonce(): string {
	const store = globalThis as unknown as Record<symbol, unknown>;
	const existing = store[PROCESS_NONCE_KEY];
	if (typeof existing === 'string') return existing;
	const nonce = randomBytes(32).toString('hex');
	store[PROCESS_NONCE_KEY] = nonce;
	return nonce;
}

/** 区切りに `\0` を使い、secret 末尾と nonce 先頭の連結違いが同じ鍵にならないようにする。 */
function getSigningKey(): string {
	return `${getSecret()}\0${getProcessNonce()}`;
}

export function _rotateProcessNonce(): void {
	const store = globalThis as unknown as Record<symbol, unknown>;
	store[PROCESS_NONCE_KEY] = randomBytes(32).toString('hex');
}

function canonicalize(params: Record<string, unknown>): string {
	const sorted = Object.keys(params)
		.sort()
		.reduce<Record<string, unknown>>((acc, key) => {
			if (params[key] !== undefined) {
				acc[key] = params[key];
			}
			return acc;
		}, {});
	return JSON.stringify(sorted);
}

function hmac(secret: string, data: string): string {
	return createHmac('sha256', secret).update(data).digest('hex');
}

export interface ConfirmationToken {
	token: string;
	expiresAt: number;
}

export type TokenErrorCode =
	| 'token_expired'
	| 'token_already_used'
	| 'token_invalid'
	/** 使用済み記録が件数上限に達し、再利用を検知できないため実行を許可しなかった */
	| 'token_store_full';

export interface TokenValidationError {
	message: string;
	code: TokenErrorCode;
}

const TOKEN_EXPIRED_MESSAGE = '確認トークンの有効期限が切れています。preview を再実行してください';
const TOKEN_ALREADY_USED_MESSAGE = '確認トークンは既に使用されています。preview を再実行してください';
const TOKEN_INVALID_MESSAGE =
	'確認トークンが無効です。パラメータが変更された可能性があります。preview を再実行してください';
/** トークン本文は含めない（`.claude/rules/sensitive-data.md` の CRITICAL 分類）。 */
const TOKEN_STORE_FULL_MESSAGE =
	'確認を一時的に受け付けられません（処理中の確認が上限に達しています）。しばらく時間をおいてから preview をやり直してください';

/** `Record` にしているので、lib 側に理由が増えたら typecheck が落ちる（fail-closed のまま気づける）。 */
const ADD_REJECTION_ERRORS: Record<AddRejectReason, TokenValidationError> = {
	// has() と add() の間で記録された場合。現状は同期実行なので到達しないが、将来 validateToken に await が入っても二重実行を通さないための保険。
	already_recorded: { message: TOKEN_ALREADY_USED_MESSAGE, code: 'token_already_used' },
	capacity_exceeded: { message: TOKEN_STORE_FULL_MESSAGE, code: 'token_store_full' },
	// expiresAt の非有限値は冒頭で弾いているので到達しないが、lib 側の判定が変わっても検証成功に化けないよう拒否側へ倒す。
	invalid_expiry: { message: TOKEN_INVALID_MESSAGE, code: 'token_invalid' },
};

export function generateToken(
	action: string,
	params: Record<string, unknown>,
	nowMs: number = Date.now(),
): ConfirmationToken {
	const ttl = getTtlMs();
	const expiresAt = nowMs + ttl;
	const payload = canonicalize({ action, ...params, expiresAt });
	const token = hmac(getSigningKey(), payload);
	return { token, expiresAt };
}

export function validateToken(
	token: string,
	action: string,
	params: Record<string, unknown>,
	expiresAt: number,
	nowMs: number = Date.now(),
): TokenValidationError | null {
	// 非有限の expiresAt（NaN / ±Infinity）は期限比較が全て false になり、下の期限チェックをすり抜けて「期限切れにならないトークン」になる。
	if (!Number.isFinite(expiresAt)) {
		return { message: TOKEN_INVALID_MESSAGE, code: 'token_invalid' };
	}

	if (nowMs > expiresAt) {
		return { message: TOKEN_EXPIRED_MESSAGE, code: 'token_expired' };
	}

	if (usedTokens.has(token, nowMs)) {
		return { message: TOKEN_ALREADY_USED_MESSAGE, code: 'token_already_used' };
	}

	const payload = canonicalize({ action, ...params, expiresAt });
	const expected = hmac(getSigningKey(), payload);

	if (token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
		return { message: TOKEN_INVALID_MESSAGE, code: 'token_invalid' };
	}

	// 使用済みとして登録できたときだけ検証成功とする。登録に失敗した状態で実行を許すと、同じトークンで二重発注が通る。
	const recorded = usedTokens.add(token, expiresAt, nowMs);
	if (!recorded.added) {
		return { ...ADD_REJECTION_ERRORS[recorded.reason] };
	}

	return null;
}
