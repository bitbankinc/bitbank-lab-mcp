import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

/** ext-apps の `EXTENSION_ID` からは import しない。`@modelcontextprotocol/ext-apps/server` は読み込み時に SDK v1 の Protocol と全 Zod スキーマを引き込み、SDK v2 の stdio サーバーに不要な依存が乗る。 */
export const MCP_APPS_UI_EXTENSION_ID = 'io.modelcontextprotocol/ui';

export interface AppResourceDefinition {
	uri: string;
	name: string;
	description: string;
	mimeType: string;
	read(): Promise<string>;
	listMeta?: Record<string, unknown>;
	contentMeta?: Record<string, unknown>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

function makeHtmlReader(relativePath: string): () => Promise<string> {
	let cache: string | null = null;
	return async () => {
		if (cache != null) return cache;
		const abs = resolve(REPO_ROOT, relativePath);
		try {
			cache = await readFile(abs, 'utf-8');
			return cache;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`MCP Apps UI リソースの読み込みに失敗しました (${relativePath}): ${msg}. ` +
					'`npm run build:ui` でビルドしてください',
			);
		}
	};
}

export const appResourceRegistry: AppResourceDefinition[] = [
	{
		uri: 'ui://order/confirm.html',
		name: 'Order Confirmation',
		description:
			'preview_order の結果をインタラクティブに確認し、create_order を発注するための UI（MCP Apps / SEP-1865）',
		mimeType: APP_RESOURCE_MIME_TYPE,
		read: makeHtmlReader('ui/order-confirm/dist/order-confirm.html'),
	},
	{
		uri: 'ui://cancel/confirm.html',
		name: 'Cancel Confirmation',
		description:
			'preview_cancel_order / preview_cancel_orders の結果をインタラクティブに確認し、cancel_order(s) を実行するための UI（MCP Apps / SEP-1865）',
		mimeType: APP_RESOURCE_MIME_TYPE,
		read: makeHtmlReader('ui/cancel-confirm/dist/cancel-confirm.html'),
	},
];
