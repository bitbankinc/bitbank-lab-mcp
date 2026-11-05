import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/** パッケージルート（`src/` の 1 つ上）。`lib/logger.ts` の `PACKAGE_ROOT` と同じ関係。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// dotenv 17 defaults quiet to false — console.log output on stdout breaks STDIO transport
// 既定の process.cwd()/.env だけだと、ホストが spawn して cwd が / のときに .env が黙って無視されるので、パッケージルートも探す。
// cwd 側を先に置く。dotenv は配列を先勝ちで解決するので、既に読めている環境の値は変わらない。
dotenv.config({
	quiet: true,
	path: [path.resolve(process.cwd(), '.env'), path.join(PACKAGE_ROOT, '.env')],
});
