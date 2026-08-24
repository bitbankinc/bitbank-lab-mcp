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
import { BoundedExpiringSet } from '../../lib/bounded-expiring-set.js';

/** requestState の payload。秘匿情報は含めない（署名のみで暗号化されないため）。 */
export interface ConfirmRequestState {
	action: string;
	argsDigest: string;
	nonce: string;
}

/** 確認待ちの有効期限（秒）。人間の確認操作を待つ時間として confirmation token より長め。 */
const REQUEST_STATE_TTL_SECONDS = 300;

/**
 * nonce の使用済み記録の保持期間（ms）。requestState TTL と揃える。
 *
 * これより長く覚えても replay 防御には寄与しない（期限切れ requestState は
 * SDK の verify フックが先に落とすため、nonce 検証まで到達しない）。
 */
export const NONCE_RETENTION_MS = REQUEST_STATE_TTL_SECONDS * 1000;

/**
 * mint / verify で同じ束縛文字列を返す。
 * 秘密（access token 等）は含めず、method・sessionId・clientId のみを使う。
 * 返値は envelope に生では載らず、ドメイン分離 HMAC タグになる。
 *
 * ⚠️ **未設定の `sessionId` / `principal` を空文字に畳んでいる。** stdio では両者が
 * 常に空で mint↔verify が一致し、束縛は実質 no-op になる（既存挙動の維持が目的）。
 * HTTP トランスポートを足すと空文字同士が一致してしまい、越境再利用を弾けない。
 * ADR-0007 判断事項 B のとおり、トランスポート追加と同じ PR で「未設定は fail-closed」
 * へ変更すること。tripwire は `tests/http-transport-tripwire.test.ts`。
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

/**
 * 使用済み nonce（one-time-use 強制）。TTL + 件数上限つきの共通データ構造に載せる。
 *
 * **件数上限**: `BoundedExpiringSet` の既定値（`DEFAULT_MAX_ENTRIES` = 10,000）をそのまま使い、
 * ここで別の定数を定義し直さない。同じ数値が 2 箇所に散ると運用時の上書き
 * （環境変数 `REPLAY_GUARD_MAX_ENTRIES`）が片方にしか効かなくなるため、上限値の定義は
 * lib 側の 1 箇所に集約する。
 *
 * 既定値が nonce にもそのまま当てはまる根拠（lib 側の算出根拠を nonce の値で再確認したもの）:
 *   - 保持期間 = `NONCE_RETENTION_MS` = `REQUEST_STATE_TTL_SECONDS`(300 秒) × 1000。
 *     lib 側の算出が前提にしている「保持期間 最長 300 秒」と一致する。
 *   - 想定ピーク確認レート 20 件/秒（HITL 確認は人手起点。自動化クライアントの連投に 20 倍のマージン）
 *   → 300 秒 × 20 件/秒 = 6,000 件。切り上げて 10,000 件（約 2MB）。
 *
 * **生存 nonce は追い出さない**。容量を空けるために未期限切れの記録を退避すると、その nonce は
 * 「未使用」に巻き戻り replay が黙って通る。上限に達したら `add` を失敗させ、呼び出し側
 * （`withElicitedConfirmation`）に確認を拒否させる（fail-closed）。
 *
 * **purge は 2 系統**: アクセス時 purge（`consumeNonce` → `add`）に加えて、無アクセス期間でも
 * 記録が TTL 超過後に残り続けないよう定期 purge タイマー（`startNonceCleanupTimer`）を回す。
 */
const usedNonces = new BoundedExpiringSet();

/** `consumeNonce` が失敗した理由。 */
export type NonceConsumeFailureReason =
	/** 同じ nonce が保持期間内に既に使われている（= replay） */
	| 'already_used'
	/** 件数上限に達しており、期限切れを purge しても空きを作れなかった */
	| 'capacity_exceeded'
	/** 記録の有効期限が非有限値だった（現行の呼び出し経路では発生しない。下記コメント参照） */
	| 'invalid_expiry';

/**
 * `consumeNonce` の結果。判別可能ユニオンなので `consumed` で絞り込まないと `reason` を読めず、
 * 「消費できなかったのに実行してしまう」書き方にならない。
 */
export type NonceConsumeResult =
	| { readonly consumed: true }
	| { readonly consumed: false; readonly reason: NonceConsumeFailureReason };

/**
 * nonce を消費する（one-time-use 強制）。
 *
 * **fail-closed**: 使用済みとして登録できたときだけ `{ consumed: true }` を返す。
 * replay も容量超過も「消費できなかった」として扱い、呼び出し側は理由を問わず確認を通さない。
 * ただし理由は返す — 容量超過は引数の変更でも期限切れでもない一時的な事象なので、
 * 呼び出し側が「時間をおいて再試行」と案内できるようにする。
 *
 * 容量超過で失敗した場合、その nonce は消費されていない（生存エントリを追い出さないため
 * 記録の中身も無傷）。空きが出れば同じ確認をやり直せる。
 *
 * `invalid_expiry` は `expiresAtMs` が非有限のときの理由だが、ここでは有限な `nowMs` から
 * 内部で算出しているため現行経路では返らない（`nowMs` 自体が非有限なら `add` が `TypeError` を
 * 投げる＝実行されない）。将来の変更で発生したときに `already_used` に紛れて見えなくならないよう、
 * 潰さずそのまま伝播させる。
 *
 * nonce 本文はログにもエラー文言にも出さない（`.claude/rules/sensitive-data.md` の CRITICAL 分類）。
 */
export function consumeNonce(nonce: string, nowMs: number = Date.now()): NonceConsumeResult {
	const res = usedNonces.add(nonce, nowMs + NONCE_RETENTION_MS, nowMs);
	if (res.added) return { consumed: true };
	return { consumed: false, reason: res.reason === 'already_recorded' ? 'already_used' : res.reason };
}

/**
 * 使用済み nonce の定期 purge を開始する（重複起動しない）。
 * 起動箇所は `src/tool-registry.ts`（`confirmation.ts` の `startCleanupTimer` と同じ場所）。
 */
export function startNonceCleanupTimer(): void {
	usedNonces.startCleanupTimer();
}

/** 使用済み nonce の定期 purge を停止する（複数回呼んでも安全）。 */
export function stopNonceCleanupTimer(): void {
	usedNonces.stopCleanupTimer();
}

/** 定期 purge タイマーが稼働中かどうか（テスト用）。 */
export function _isNonceCleanupTimerActive(): boolean {
	return usedNonces.isCleanupTimerActive();
}

/** 使用済み nonce をクリアする（テスト用）。 */
export function _resetUsedNonces(): void {
	usedNonces.clear();
}

/** 使用済み nonce の記録件数を返す（テスト用。nonce 本文は返さない）。 */
export function _usedNonceCount(): number {
	return usedNonces.size();
}
