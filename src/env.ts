import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/** パッケージルート（`src/` の 1 つ上）。`lib/logger.ts` の `PACKAGE_ROOT` と同じ関係。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// dotenv 17 defaults quiet to false — console.log output on stdout breaks STDIO transport
//
// `path` を明示するのは、既定が `process.cwd()/.env` だから。MCP サーバーはホストが
// spawn するため cwd はホスト依存で、Claude Desktop（macOS）では `/` になる。その場合
// `/.env` を探して見つからず、**`.env` が黙って無視される**（キーが読めず Private API
// ツールが登録されないが、理由が分からない）。docs/gitbook/private-api/setup.md が
// 案内している「`.env` に保管」構成が該当する。
//
// cwd 側を先に置いて既存挙動を維持し、パッケージルートを fallback として足す
// （dotenv は配列を先勝ちで解決するため、既に読めている環境の値は変わらない）。
dotenv.config({
	quiet: true,
	path: [path.resolve(process.cwd(), '.env'), path.join(PACKAGE_ROOT, '.env')],
});
