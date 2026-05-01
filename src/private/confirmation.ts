/**
 * HITL (Human-in-the-Loop) 確認トークン — 取引操作の2ステップ確認。
 *
 * preview_order / preview_cancel_order / preview_cancel_orders が発行した
 * 確認トークンを、create_order / cancel_order / cancel_orders が検証する。
 * トークンは HMAC-SHA256(BITBANK_API_SECRET, payload) で生成し、
 * パラメータ一致 + 有効期限を検証する。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** デフォルト有効期限: 60秒 */
const DEFAULT_TTL_MS = 60_000;

/** TTL 上限: 5分 */
const MAX_TTL_MS = 300_000;

/** 使用済みトークンのセット（再利用防止） */
const usedTokens = new Map<string, number>(); // token → expiresAt

/** クリーンアップ間隔: 60秒 */
const CLEANUP_INTERVAL_MS = 60_000;

let cleanupTimerId: ReturnType<typeof setInterval> | null = null;

/** TTL 超過分の使用済みトークンを除去する */
export function purgeExpiredTokens(nowMs: number = Date.now()): number {
	let purged = 0;
	for (const [token, expiresAt] of usedTokens) {
		if (nowMs > expiresAt) {
			usedTokens.delete(token);
			purged++;
		}
	}
	return purged;
}

/** 定期クリーンアップを開始する（重複起動しない） */
export function startCleanupTimer(): void {
	if (cleanupTimerId != null) return;
	cleanupTimerId = setInterval(() => purgeExpiredTokens(), CLEANUP_INTERVAL_MS);
	// プロセス終了をブロックしないよう unref
	if (typeof cleanupTimerId === 'object' && 'unref' in cleanupTimerId) {
		cleanupTimerId.unref();
	}
}

/** 定期クリーンアップを停止する（テスト用） */
export function stopCleanupTimer(): void {
	if (cleanupTimerId != null) {
		clearInterval(cleanupTimerId);
		cleanupTimerId = null;
	}
}

/** 使用済みトークンセットをクリアする（テスト用） */
export function _resetUsedTokens(): void {
	usedTokens.clear();
}

/** 使用済みトークン数を返す（テスト用） */
export function _usedTokenCount(): number {
	return usedTokens.size;
}

/** クリーンアップタイマーが動作中かどうか（テスト用） */
export function _isCleanupTimerActive(): boolean {
	return cleanupTimerId != null;
}

function getTtlMs(): number {
	const env = process.env.ORDER_CONFIRM_TTL_MS;
	if (env) {
		const n = Number(env);
		if (Number.isFinite(n) && n > 0) return Math.min(n, MAX_TTL_MS);
	}
	return DEFAULT_TTL_MS;
}

function getSecret(): string {
	const secret = process.env.BITBANK_API_SECRET;
	if (!secret) throw new Error('BITBANK_API_SECRET is not configured');
	return secret;
}

/**
 * トークンペイロードを正規化する。
 * オブジェクトのキーをソートし、undefined を除外して JSON 文字列化する。
 */
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

/** HMAC-SHA256 を計算する */
function hmac(secret: string, data: string): string {
	return createHmac('sha256', secret).update(data).digest('hex');
}

export interface ConfirmationToken {
	token: string;
	expiresAt: number;
}

/** validateToken のエラー分類 */
export type TokenErrorCode = 'token_expired' | 'token_already_used' | 'token_invalid';

export interface TokenValidationError {
	message: string;
	code: TokenErrorCode;
}

/**
 * 確認トークンを生成する。
 *
 * @param action - 操作種別 ('create_order' | 'cancel_order' | 'cancel_orders')
 * @param params - 操作パラメータ（注文内容やキャンセル対象）
 * @param nowMs - 現在時刻（テスト用にオーバーライド可能）
 */
export function generateToken(
	action: string,
	params: Record<string, unknown>,
	nowMs: number = Date.now(),
): ConfirmationToken {
	const ttl = getTtlMs();
	const expiresAt = nowMs + ttl;
	const payload = canonicalize({ action, ...params, expiresAt });
	const token = hmac(getSecret(), payload);
	return { token, expiresAt };
}

/**
 * 確認トークンを検証する。
 *
 * 検証成功時は usedTokens に登録され、同一トークンの再利用は
 * `token_already_used` で拒否される（ワンショット制約）。
 *
 * @returns null なら検証成功、エラー時はメッセージとコードを返す
 */
export function validateToken(
	token: string,
	action: string,
	params: Record<string, unknown>,
	expiresAt: number,
	nowMs: number = Date.now(),
): TokenValidationError | null {
	// 有効期限チェック
	if (nowMs > expiresAt) {
		return {
			message: '確認トークンの有効期限が切れています。preview を再実行してください',
			code: 'token_expired',
		};
	}

	// 使用済みチェック（ワンショット）
	if (usedTokens.has(token)) {
		return {
			message: '確認トークンは既に使用されています。preview を再実行してください',
			code: 'token_already_used',
		};
	}

	// HMAC 再計算で検証
	const payload = canonicalize({ action, ...params, expiresAt });
	const expected = hmac(getSecret(), payload);

	if (token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
		return {
			message: '確認トークンが無効です。パラメータが変更された可能性があります。preview を再実行してください',
			code: 'token_invalid',
		};
	}

	// 検証成功 → 使用済みとして登録（ワンショット）
	usedTokens.set(token, expiresAt);

	return null;
}
