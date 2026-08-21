/**
 * HITL (Human-in-the-Loop) 確認トークン — 取引操作の2ステップ確認。
 *
 * preview_order / preview_cancel_order / preview_cancel_orders が発行した
 * 確認トークンを、create_order / cancel_order / cancel_orders が検証する。
 * トークンは HMAC-SHA256(BITBANK_API_SECRET + per-process nonce, payload) で生成し、
 * パラメータ一致 + 有効期限を検証する。
 *
 * 署名鍵に per-process nonce を混ぜているのは、**ワンショット性の保証範囲を
 * トークンの有効範囲と一致させる**ため。使用済み記録（`usedTokens`）はプロセス内メモリに
 * しか無いので、トークンだけがプロセスを跨いで有効だと「再起動 / 別プロセスなら同じトークンが
 * もう一度通る」という非対称が生じる。詳細は `getProcessNonce` のコメントと ADR-0007。
 *
 * 使用済みトークンの保持は `lib/bounded-expiring-set.ts` の `BoundedExpiringSet` に載せている。
 * TTL 経過分は purge される一方、件数上限に達した場合は生存トークンを追い出さず
 * `validateToken` を失敗させる（fail-closed）。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddRejectReason } from '../../lib/bounded-expiring-set.js';
import { BoundedExpiringSet } from '../../lib/bounded-expiring-set.js';

/** デフォルト有効期限: 60秒 */
const DEFAULT_TTL_MS = 60_000;

/** TTL 上限: 5分 */
const MAX_TTL_MS = 300_000;

/** クリーンアップ間隔: 60秒 */
const CLEANUP_INTERVAL_MS = 60_000;

/**
 * 使用済みトークンの記録ストアを生成する。
 *
 * 件数上限は `BoundedExpiringSet` の `DEFAULT_MAX_ENTRIES`（10,000 件。環境変数
 * `REPLAY_GUARD_MAX_ENTRIES` で上書き可能）をそのまま使う。ここで別の定数を持つと
 * 上限の定義が 2 箇所に割れ、環境変数での上書きも確認トークンだけ効かなくなるため、
 * 値は lib 側の 1 箇所に集約する。
 *
 * 確認トークン側から見た算出根拠 — TTL × 想定ピークレート:
 *   - 1 エントリの保持期間は最長 `MAX_TTL_MS` = 300 秒。既定は `DEFAULT_TTL_MS` = 60 秒で、
 *     `ORDER_CONFIRM_TTL_MS` で伸ばしても `getTtlMs` が 300 秒に clamp する。
 *     期限切れは purge されるので、同時に存在しうる件数は「TTL × 確認レート」で頭打ちになる。
 *   - 想定ピーク確認レートは 20 件/秒。確認は HITL（人手の承認）が起点なので実運用では
 *     1 件/秒にも届かないが、自動化クライアントの連投を見込んで 20 倍のマージンを取る。
 *   → 300 秒 × 20 件/秒 = 6,000 件 < 10,000 件。既定値で通常運用のピークを吸収できる。
 *
 * 上限到達時に古い生存エントリを追い出さないのが要点。追い出すとその注文の確認トークンが
 * 「未使用」に巻き戻り、二重発注が黙って通る（`lib/bounded-expiring-set.ts` 冒頭の設計ルール）。
 *
 * @param maxEntries - テスト用の上限上書き。省略時は lib 側が
 *   `REPLAY_GUARD_MAX_ENTRIES` → `DEFAULT_MAX_ENTRIES` の順に解決する。
 */
function createUsedTokenStore(maxEntries?: number): BoundedExpiringSet {
	return new BoundedExpiringSet({ maxEntries, purgeIntervalMs: CLEANUP_INTERVAL_MS });
}

/** 使用済みトークンのセット（再利用防止） */
let usedTokens = createUsedTokenStore();

/** TTL 超過分の使用済みトークンを除去する */
export function purgeExpiredTokens(nowMs: number = Date.now()): number {
	return usedTokens.purgeExpired(nowMs);
}

/** 定期クリーンアップを開始する（重複起動しない） */
export function startCleanupTimer(): void {
	usedTokens.startCleanupTimer();
}

/** 定期クリーンアップを停止する（テスト用） */
export function stopCleanupTimer(): void {
	usedTokens.stopCleanupTimer();
}

/**
 * 使用済みトークンセットをクリアする（テスト用）。
 *
 * `maxEntries` を渡した場合はストアを作り直す（`BoundedExpiringSet` の上限は生成時固定のため）。
 * 稼働中の定期クリーンアップは旧インスタンスに紐づくので、状態を引き継いで貼り直す。
 */
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

/** 使用済みトークン数を返す（テスト用。期限切れが残っている場合は含む） */
export function _usedTokenCount(): number {
	return usedTokens.size();
}

/** 使用済みトークンの件数上限を返す（テスト用。clamp 適用後の実効値） */
export function _usedTokenCapacity(): number {
	return usedTokens.maxEntries;
}

/** クリーンアップタイマーが動作中かどうか（テスト用） */
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

function getSecret(): string {
	const secret = process.env.BITBANK_API_SECRET;
	if (!secret) throw new Error('BITBANK_API_SECRET is not configured');
	return secret;
}

/**
 * per-process のランダム値を置く場所。
 *
 * **モジュールスコープではなく `globalThis` に置く。** 守りたい単位は「OS プロセス」であって
 * 「モジュールインスタンス」ではない。モジュールスコープに置くと、テストの `vi.resetModules()`
 * や将来の動的 import 構成でモジュールが再評価されるたびに値が変わり、同一プロセス内で
 * 発行したトークンが検証できなくなる。`Symbol.for` のグローバルレジストリなら
 * 再評価しても同じ値を引き当てる。
 */
const PROCESS_NONCE_KEY = Symbol.for('bitbank-lab-mcp.confirmation.processNonce');

/**
 * プロセスごとのランダム値。**署名鍵に混ぜてトークンをプロセスへ束縛する。**
 *
 * これが無いと、HMAC が永続の `BITBANK_API_SECRET` だけで決まる一方、使用済み記録
 * （`usedTokens`）はプロセス内メモリにしか無いため、ワンショット性がプロセス内に閉じているのに
 * トークンは閉じていない、という非対称が生じる。具体的には:
 *
 *   - TTL 内にサーバープロセスが再起動すると、使用済みトークンがもう一度通る
 *   - 同じ secret を持つ別プロセスでも通る（ホストが surface ごとにサーバーを spawn する構成）
 *
 * `requestState` は per-process ランダム鍵で既にこの穴を塞いでおり
 * （`src/private/request-state.ts` 冒頭）、確認トークンだけが非対称だった。それを揃える。
 *
 * 代償: プロセス再起動で**未使用の preview も無効化される**。これは経路 1（elicitation）の
 * pending 確認が再起動で失効するのと同じ挙動で、fail-closed 側に倒れる。
 */
function getProcessNonce(): string {
	const store = globalThis as unknown as Record<symbol, unknown>;
	const existing = store[PROCESS_NONCE_KEY];
	if (typeof existing === 'string') return existing;
	const nonce = randomBytes(32).toString('hex');
	store[PROCESS_NONCE_KEY] = nonce;
	return nonce;
}

/**
 * トークンの署名鍵。API secret と per-process nonce を結合する。
 *
 * 区切りに `\0` を使い、両者の境界を曖昧にしない（secret 末尾と nonce 先頭の
 * 連結違いが同じ鍵にならないようにする）。
 */
function getSigningKey(): string {
	return `${getSecret()}\0${getProcessNonce()}`;
}

/**
 * per-process nonce を再生成する（テスト用）。
 *
 * プロセス再起動を模擬する。呼ぶと、それ以前に発行した全トークンが `token_invalid` になる。
 */
export function _rotateProcessNonce(): void {
	const store = globalThis as unknown as Record<symbol, unknown>;
	store[PROCESS_NONCE_KEY] = randomBytes(32).toString('hex');
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
/**
 * 容量超過時の文言。原因は呼び出し側の操作ではなくサーバー側の混雑なので、
 * 「一時的に受け付けられない / 時間をおいて preview からやり直す」旨のみを伝える。
 * トークン本文は含めない（`.claude/rules/sensitive-data.md` の CRITICAL 分類）。
 */
const TOKEN_STORE_FULL_MESSAGE =
	'確認を一時的に受け付けられません（処理中の確認が上限に達しています）。しばらく時間をおいてから preview をやり直してください';

/**
 * 使用済み記録の失敗理由 → 検証エラーの対応表。
 * `Record` なので lib 側に理由が増えたら typecheck が落ちる（fail-closed のまま気づける）。
 */
const ADD_REJECTION_ERRORS: Record<AddRejectReason, TokenValidationError> = {
	// 上の has() と add() の間で記録された場合（現状は同期実行なので到達しないが、
	// 将来 validateToken に await が入っても二重実行を通さないための保険）。
	already_recorded: { message: TOKEN_ALREADY_USED_MESSAGE, code: 'token_already_used' },
	capacity_exceeded: { message: TOKEN_STORE_FULL_MESSAGE, code: 'token_store_full' },
	// expiresAt の非有限値は冒頭で弾いているので到達しない。lib 側の判定が変わっても
	// 検証成功に化けないよう明示的に拒否側へ倒しておく。
	invalid_expiry: { message: TOKEN_INVALID_MESSAGE, code: 'token_invalid' },
};

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
	const token = hmac(getSigningKey(), payload);
	return { token, expiresAt };
}

/**
 * 確認トークンを検証する。
 *
 * 検証成功時は usedTokens に登録され、同一トークンの再利用は
 * `token_already_used` で拒否される（ワンショット制約）。
 *
 * **検証成功と使用済み登録は不可分**に扱う。登録できなかった場合（件数上限）は
 * 再利用を検知できない状態なので、検証も成功させない（fail-closed）。
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
	// 非有限の expiresAt（NaN / ±Infinity）は期限比較が全て false になるため、
	// 下の期限チェックをすり抜けて「期限切れにならないトークン」になる。
	// expiresAt は HMAC ペイロードにも含まれる入力値なので、改ざんの一種として弾く。
	if (!Number.isFinite(expiresAt)) {
		return { message: TOKEN_INVALID_MESSAGE, code: 'token_invalid' };
	}

	// 有効期限チェック
	if (nowMs > expiresAt) {
		return { message: TOKEN_EXPIRED_MESSAGE, code: 'token_expired' };
	}

	// 使用済みチェック（ワンショット）。期限切れの記録はここで除去される（アクセス時 purge）。
	if (usedTokens.has(token, nowMs)) {
		return { message: TOKEN_ALREADY_USED_MESSAGE, code: 'token_already_used' };
	}

	// HMAC 再計算で検証
	const payload = canonicalize({ action, ...params, expiresAt });
	const expected = hmac(getSigningKey(), payload);

	if (token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
		return { message: TOKEN_INVALID_MESSAGE, code: 'token_invalid' };
	}

	// 使用済みとして登録できたときだけ検証成功とする。
	// 登録に失敗した状態で実行を許すと、同じトークンで二重発注が通る。
	const recorded = usedTokens.add(token, expiresAt, nowMs);
	if (!recorded.added) {
		return { ...ADD_REJECTION_ERRORS[recorded.reason] };
	}

	return null;
}
