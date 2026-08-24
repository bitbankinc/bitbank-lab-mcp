/**
 * MCP Apps（SEP-1865）の iframe ↔ サーバー間で共有するツール結果 `_meta` の契約。
 *
 * **サーバーと UI バンドルの両方から import される唯一のモジュール**なので、
 * Node 依存（`node:fs` 等）も重い依存も持たせない。定数と型だけを置く。
 * ここが単一の情報源であることで、キー文字列がサーバー側と iframe 側で
 * 食い違って「トークンを載せたのに UI が読めない」という無言の破綻を防ぐ。
 *
 * 設計の背景は docs/adr/0007-hitl-confirmation-token-delivery.md を参照。
 */

/**
 * ツール結果 `_meta` に確認トークンを載せるときの名前空間キー。
 *
 * MCP の `_meta` はキーに `<reverse-dns>/<name>` 形式のプレフィックスを付ける規約なので、
 * bitbank のドメインを反転した `cc.bitbank` を使い、ホストや他拡張のキーと衝突させない。
 */
export const CONFIRMATION_META_KEY = 'cc.bitbank/confirmation';

/**
 * `_meta[CONFIRMATION_META_KEY]` の中身。
 *
 * ⚠️ この値は `content` / `structuredContent` には決して載せない。
 * `_meta` は「モデルコンテキストに入れない」がホスト実装の観測された挙動として
 * 成立しているチャネルであり、この経路の認可はトークン所持そのものに依存する。
 */
export interface ConfirmationMetaPayload {
	confirmation_token: string;
	expires_at: number;
}

/**
 * 任意のツール結果 `_meta` から確認トークンを取り出す（形状が合わなければ undefined）。
 *
 * iframe 側は push 通知（`ui/notifications/tool-result`）と pull 復元
 * （`get_ui_snapshot`）の両方で同じ形の `_meta` を受け取るため、取り出しを 1 箇所にまとめる。
 */
export function readConfirmationMeta(meta: unknown): ConfirmationMetaPayload | undefined {
	const entry = (meta as Record<string, unknown> | undefined)?.[CONFIRMATION_META_KEY];
	if (!entry || typeof entry !== 'object') return undefined;
	const { confirmation_token, expires_at } = entry as Partial<ConfirmationMetaPayload>;
	if (typeof confirmation_token !== 'string' || confirmation_token.length === 0) return undefined;
	if (typeof expires_at !== 'number' || !Number.isFinite(expires_at)) return undefined;
	return { confirmation_token, expires_at };
}
