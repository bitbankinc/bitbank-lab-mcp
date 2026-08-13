/**
 * MRTR (Multi Round-Trip Requests, SEP-2322) の `requestState` 管理。
 *
 * preview 系ツールの確認フロー（withElicitedConfirmation）が round 1 で mint し、
 * confirm 応答つきの再入（round 2）で検証する。SDK の `createRequestStateCodec` は
 * HMAC-SHA256 署名のみで**暗号化はしない**（payload はクライアントから可視）ため、
 * `confirmation_token` 等の秘匿情報は一切格納しない。格納するのは:
 *
 *   - `action`     — 確認対象の操作種別（create_order 等）。別操作への流用を拒否する
 *   - `argsDigest` — 元リクエスト引数の digest。引数を差し替えた再試行での
 *                    accept 再利用（プレビューを見ていない内容の実行）を拒否する
 *   - `nonce`      — one-time-use。使用済み requestState の replay を拒否する
 *
 * 加えて codec の `bind` で次を署名タグに束縛する（生値は wire に出ない）:
 *
 *   - 元の MCP method（例: `tools/call`）
 *   - 呼び出し元セッション ID（HTTP 等で得られる場合）
 *   - 認証 principal（`http.authInfo.clientId`。token 自体は含めない）
 *
 * stdio では sessionId / principal が共に空になり、既存の単一接続挙動を維持する。
 * sessionId または principal が得られる環境では、別セッション／別 principal への
 * requestState 持ち越しは verify 時に fail-closed で拒否される。
 *
 * 鍵は per-process ランダム。stdio サーバーは単一プロセスが全ラウンドを処理する
 * 前提のためこれで足りる（SDK ドキュメントの明記どおり）。プロセス再起動で
 * pending の確認は無効化される（安全側に倒れる）。
 *
 * 検証は 2 層:
 *   1. HMAC / 有効期限 / bind — SDK の verify フック（server.ts で ServerOptions に接続）が
 *      ハンドラ実行前に実施。失敗は wire レベルの -32602 になる
 *   2. action / argsDigest / nonce — withElicitedConfirmation が実行直前に実施
 *
 * 設計の背景は docs/adr/0007-hitl-confirmation-token-delivery.md を参照。
 */

import { createHash, randomBytes } from 'node:crypto';
import { createRequestStateCodec, type ServerContext } from '@modelcontextprotocol/server';

/** requestState の payload。秘匿情報は含めない（署名のみで暗号化されないため）。 */
export interface ConfirmRequestState {
	action: string;
	argsDigest: string;
	nonce: string;
}

/** 確認待ちの有効期限（秒）。人間の確認操作を待つ時間として confirmation token より長め。 */
const REQUEST_STATE_TTL_SECONDS = 300;

/** nonce の使用済み記録の保持期間（ms）。requestState TTL と揃える。 */
const NONCE_RETENTION_MS = REQUEST_STATE_TTL_SECONDS * 1000;

/**
 * mint / verify で同じ束縛文字列を返す。
 * 秘密（access token 等）は含めず、method・sessionId・clientId のみを使う。
 * 返値は envelope に生では載らず、ドメイン分離 HMAC タグになる。
 */
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

/**
 * 引数オブジェクトを正規化（キー再帰ソート + undefined 除去）して SHA-256 digest にする。
 * action を含めてドメイン分離する。
 */
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

/**
 * round 1 用: 確認フローの requestState を mint する。
 * bind を使うため ServerContext（少なくとも method / sessionId / principal が
 * mint 時と verify 時で一致する形）を必ず渡す。
 */
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

/** 使用済み nonce（one-time-use 強制）。値は記録時刻 + 保持期間。 */
const usedNonces = new Map<string, number>();

/**
 * nonce を消費する。未使用なら true を返して使用済みに登録し、
 * 使用済み（replay）なら false を返す。
 */
export function consumeNonce(nonce: string, nowMs: number = Date.now()): boolean {
	for (const [key, expiresAt] of usedNonces) {
		if (nowMs > expiresAt) usedNonces.delete(key);
	}
	if (usedNonces.has(nonce)) return false;
	usedNonces.set(nonce, nowMs + NONCE_RETENTION_MS);
	return true;
}

/** 使用済み nonce をクリアする（テスト用）。 */
export function _resetUsedNonces(): void {
	usedNonces.clear();
}
