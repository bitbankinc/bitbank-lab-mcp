#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const serverPath = resolve(packageRoot, 'src', 'server.ts');

const require = createRequire(import.meta.url);
const tsxImportUrl = pathToFileURL(require.resolve('tsx')).href;

// cwd をパッケージルートに固定する。MCP ホスト（Claude Desktop 等）が spawn する際の
// cwd は制御できず、macOS では `/` になる。継承すると cwd 相対のパス解決がすべて
// `/` 基準になり、ログ出力（`lib/logger.ts`）と `.env` 読み込み（`src/env.ts`）が
// 黙って失敗する。両モジュール側でもパッケージルート基準に解決しているが、
// 起点をここで揃えておけば今後 cwd 相対を足しても壊れない。
const child = spawn(process.execPath, ['--import', tsxImportUrl, serverPath], {
  stdio: 'inherit',
  cwd: packageRoot,
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
