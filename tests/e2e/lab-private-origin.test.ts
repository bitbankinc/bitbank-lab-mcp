// 研究用の起動口（lab/start.ts。ADR-0008）を実際に子プロセスとして起動し、MCP の tools/call が差し替え先（ループバックの HTTP サーバー）に届くことと、引数が無ければサーバーを起動せずに終わることを wire レベルで確かめる（単体テスト tests/lab/main.test.ts は依存を注入した runLab しか見ない）。
// `tests/e2e/**` は `npm test` の対象外で PR では走らない（手動 / nightly の `npm run test:e2e` でのみ実行される）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

const ENTRY = new URL('../../lab/start.ts', import.meta.url).pathname;
const TSX_BIN = new URL('../../node_modules/.bin/tsx', import.meta.url).pathname;

if (!existsSync(TSX_BIN)) {
	throw new Error(
		`tsx バイナリが見つかりません: ${TSX_BIN}\n\`npm install\` を実行してから E2E を再実行してください。`,
	);
}

interface ReceivedRequest {
	method: string;
	url: string;
	headers: IncomingHttpHeaders;
}

/** private API の代わりに立てるループバックの HTTP サーバー。受けた要求を記録する */
async function startFakePrivateApi(): Promise<{ origin: string; received: ReceivedRequest[]; server: Server }> {
	const received: ReceivedRequest[] = [];
	const server = createServer((req, res) => {
		received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
		res.setHeader('Content-Type', 'application/json');
		if (req.url?.startsWith('/v1/user/spot/active_orders')) {
			res.end(JSON.stringify({ success: 1, data: { orders: [] } }));
			return;
		}
		res.end(JSON.stringify({ success: 0, data: { code: 20003 } }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return { origin: `http://127.0.0.1:${port}`, received, server };
}

/** 起動口に渡す環境変数（ダミーのキー。ログは一時ディレクトリへ逃がしてリポジトリを汚さない） */
function labEnv(): Record<string, string> {
	return {
		...(process.env as Record<string, string>),
		BITBANK_API_KEY: 'e2e_key',
		BITBANK_API_SECRET: 'e2e_secret',
		LOG_DIR: mkdtempSync(path.join(tmpdir(), 'lab-e2e-logs-')),
		NO_COLOR: '1',
	};
}

describe('lab/start.ts（E2E）', () => {
	let client: Client | undefined;
	let server: Server | undefined;

	afterEach(async () => {
		await client?.close();
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		client = undefined;
		server = undefined;
	});

	it('private ツールの要求が差し替え先に届く（パスはそのまま・認証ヘッダ付き）', async () => {
		const fake = await startFakePrivateApi();
		server = fake.server;
		client = new Client({ name: 'e2e-lab', version: '0.0.1' });
		await client.connect(
			new StdioClientTransport({
				command: TSX_BIN,
				args: [ENTRY, `--private-api-origin=${fake.origin}`],
				env: labEnv(),
				stderr: 'pipe',
			}),
		);

		const result = await client.callTool({ name: 'get_my_orders', arguments: { pair: 'btc_jpy' } });

		expect(result.isError).not.toBe(true);
		expect(fake.received).toHaveLength(1);
		expect(fake.received[0].method).toBe('GET');
		expect(fake.received[0].url).toBe('/v1/user/spot/active_orders?pair=btc_jpy');
		expect(fake.received[0].headers['access-key']).toBe('e2e_key');
		expect(fake.received[0].headers['access-signature']).toMatch(/^[0-9a-f]{64}$/);
	}, 30_000);

	it.each([
		['引数なし', []],
		['遠隔の origin', ['--private-api-origin=https://example.com']],
	])('%s → 終了コード 2、stdout に何も出さない', (_label, args) => {
		const res = spawnSync(TSX_BIN, [ENTRY, ...args], { env: labEnv(), encoding: 'utf8', timeout: 20_000 });

		expect(res.status).toBe(2);
		expect(res.stdout).toBe('');
		expect(res.stderr).toContain('--private-api-origin');
	});
});
