/**
 * MCP Apps (SEP-1865) UI リソースレジストリ。
 *
 * `_meta.ui.resourceUri` を持つツールが参照する `ui://...` リソースをここに集約する。
 * 各エントリは `resources/list` に列挙され、`resources/read` で中身 (HTML) を返す。
 *
 * Progressive Enhancement: MCP Apps 非対応のホストはこれらのリソースを
 * 参照しないため、従来のテキスト確認フローがそのまま動作する。
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** MCP Apps リソースの標準 MIME タイプ */
export const APP_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

export interface AppResourceDefinition {
	/** リソース URI（ui:// スキーム） */
	uri: string;
	/** 人間向け表示名 */
	name: string;
	/** 説明 */
	description: string;
	/** MIME タイプ（デフォルト: APP_RESOURCE_MIME_TYPE） */
	mimeType: string;
	/** 中身 (HTML) を返す。遅延読み込みでビルド済み成果物を読み込む想定 */
	read(): Promise<string>;
	/** `resources/list` 応答の `_meta`（任意） */
	listMeta?: Record<string, unknown>;
	/** `resources/read` 応答の content `_meta`（任意） */
	contentMeta?: Record<string, unknown>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
/** リポジトリルート（src/resources/ から 2 階層上） */
const REPO_ROOT = resolve(__dirname, '..', '..');

/** HTML ファイルをキャッシュ付きで読み込む */
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

/**
 * 登録済み MCP Apps UI リソース一覧。
 * 新しい UI を追加するときはここにエントリを足す。
 */
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
