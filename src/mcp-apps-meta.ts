// サーバーと UI バンドルの両方から import されるので、Node 依存も重い依存も持たせず、定数と型だけを置く。

/** MCP の `_meta` キーは `<reverse-dns>/<name>` 形式の規約なので、bitbank のドメインを反転した `cc.bitbank` を使う。 */
export const CONFIRMATION_META_KEY = 'cc.bitbank/confirmation';

/** `content` / `structuredContent` には決して載せない。この経路の認可はトークン所持そのものに依存する（ADR-0007）。 */
export interface ConfirmationMetaPayload {
	confirmation_token: string;
	expires_at: number;
}

export function readConfirmationMeta(meta: unknown): ConfirmationMetaPayload | undefined {
	const entry = (meta as Record<string, unknown> | undefined)?.[CONFIRMATION_META_KEY];
	if (!entry || typeof entry !== 'object') return undefined;
	const { confirmation_token, expires_at } = entry as Partial<ConfirmationMetaPayload>;
	if (typeof confirmation_token !== 'string' || confirmation_token.length === 0) return undefined;
	if (typeof expires_at !== 'number' || !Number.isFinite(expires_at)) return undefined;
	return { confirmation_token, expires_at };
}

// ホストが結果 `_meta` を iframe に渡さないときの代わりの経路。一覧に出さないテンプレートで、`{app}` は確認 UI `ui://{app}/confirm.html` の名前。
export const CONFIRMATION_RESOURCE_TEMPLATE = 'bitbank-confirmation://{app}';

export function confirmationResourceUri(appResourceUri: string): string | undefined {
	const app = /^ui:\/\/([a-z-]+)\/confirm\.html$/.exec(appResourceUri)?.[1];
	return app ? `bitbank-confirmation://${app}` : undefined;
}

export function appResourceUriFor(app: string): string {
	return `ui://${app}/confirm.html`;
}
