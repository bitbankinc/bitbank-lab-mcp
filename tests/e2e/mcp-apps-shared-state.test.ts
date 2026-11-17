// Claude Desktop はチャットのツール実行とカード（iframe）の要求を別々のサーバープロセスで受ける。2 つのサーバーを起動して、その形を再現する（ADR-0007 判断事項 D）。
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIRMATION_META_KEY } from '../../src/mcp-apps-meta.js';
import { APP_RESOURCE_MIME_TYPE, MCP_APPS_UI_EXTENSION_ID } from '../../src/resources/app-resources.js';
import { mockSpotPairsResponse, rawActiveOrdersResponse } from '../fixtures/private-api.js';

const ENTRY = fileURLToPath(new URL('./mock-server-entry.ts', import.meta.url));
const TSX_BIN = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));

const ORDER_ARGS = { pair: 'btc_jpy', amount: '0.01', side: 'buy', type: 'limit', price: '14000000' };

type CallResult = {
	content?: Array<{ type: string; text?: string }>;
	structuredContent?: unknown;
	_meta?: Record<string, unknown>;
};

function createAppUiClient(name: string): Client {
	return new Client({ name, version: '0.0.1' }, {
		capabilities: {
			extensions: { [MCP_APPS_UI_EXTENSION_ID]: { mimeTypes: [APP_RESOURCE_MIME_TYPE] } },
		},
	} as unknown as ConstructorParameters<typeof Client>[1]);
}

function createTransport(sharedDir: string) {
	return new StdioClientTransport({
		command: TSX_BIN,
		args: [ENTRY],
		env: {
			...process.env,
			MOCK_RESPONSES: JSON.stringify({
				'/spot/pairs': mockSpotPairsResponse(),
				'btc_jpy/ticker': { success: 1, data: { last: '15000000' } },
				'/user/spot/order': { success: 1, data: rawActiveOrdersResponse.orders[0] },
			}),
			BITBANK_API_KEY: 'e2e_key',
			BITBANK_API_SECRET: 'e2e_secret',
			BITBANK_MCP_APPS_EXECUTE: '1',
			E2E_SHARED_CONFIRM_STATE_DIR: sharedDir,
		},
		stderr: 'pipe',
	});
}

async function readConfirmation(client: Client) {
	const resource = await client.readResource({ uri: 'bitbank-confirmation://order' });
	return JSON.parse((resource.contents[0] as { text?: string }).text ?? '{}') as {
		structuredContent?: unknown;
		confirmation?: { confirmation_token?: string; expires_at?: number };
	};
}

// Windows では共有しない（ADR-0007 判断事項 D）ので、別プロセスへの受け渡しを前提にしたこの E2E は飛ばす。
describe.skipIf(process.platform === 'win32')('E2E: preview とカードが別プロセスに届くとき', () => {
	const clients: Client[] = [];
	const dirs: string[] = [];

	function tempDir(): string {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'bitbank-e2e-shared-'));
		dirs.push(dir);
		return dir;
	}

	async function connect(name: string, sharedDir: string): Promise<Client> {
		const client = createAppUiClient(name);
		await client.connect(createTransport(sharedDir));
		clients.push(client);
		return client;
	}

	afterEach(async () => {
		await Promise.all(clients.splice(0).map((c) => c.close()));
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it('同じフォルダを共有すれば、カード側のプロセスがトークンを受け取り、ボタンの発注が 1 回だけ通る', async () => {
		const shared = tempDir();
		const chat = await connect('e2e-chat-lane', shared);
		const card = await connect('e2e-card-lane', shared);

		const preview = (await chat.callTool({ name: 'preview_order', arguments: ORDER_ARGS })) as CallResult;
		const pushed = preview._meta?.[CONFIRMATION_META_KEY] as
			| { confirmation_token?: string; expires_at?: number }
			| undefined;
		expect(pushed?.confirmation_token).toEqual(expect.any(String));

		const body = await readConfirmation(card);
		expect(body.confirmation?.confirmation_token).toBe(pushed?.confirmation_token);
		expect(body.structuredContent).toEqual(preview.structuredContent);
		// 読んだだけでは消さない（ホストが `_meta` を落としても、カードがリソースから取り直せる）。
		expect((await readConfirmation(card)).confirmation?.confirmation_token).toBe(pushed?.confirmation_token);
		// カードが受け取ったと知らせたら、共有ファイルから消える。
		await card.callTool({
			name: 'get_ui_snapshot',
			arguments: { resource_uri: 'ui://order/confirm.html', confirmation_token: body.confirmation?.confirmation_token },
		});
		expect(await readConfirmation(card)).toEqual({});

		const snapshot = (await card.callTool({
			name: 'get_ui_snapshot',
			arguments: { resource_uri: 'ui://order/confirm.html' },
		})) as CallResult;
		expect(snapshot.structuredContent).toEqual(preview.structuredContent);

		const execArgs = {
			...ORDER_ARGS,
			confirmation_token: body.confirmation?.confirmation_token,
			token_expires_at: body.confirmation?.expires_at,
		};
		const executed = (await card.callTool({ name: 'create_order', arguments: execArgs })) as CallResult;
		expect((executed.structuredContent as { ok?: boolean } | undefined)?.ok).toBe(true);

		// 使用済みの印も共有されるので、もう一方のプロセスでは同じトークンが通らない。
		const replayed = (await chat.callTool({ name: 'create_order', arguments: execArgs })) as CallResult;
		expect(replayed.structuredContent).toMatchObject({ ok: false });
		expect(replayed.content?.[0]?.text).toContain('既に使用されています');

		// 発注後は控えも消えるので、カードを開き直してもボタンは出ない。
		expect(await readConfirmation(chat)).toEqual({});
	}, 60_000);

	it('2 つのプロセスで同じトークンを同時に使っても、発注は 1 回だけ通る', async () => {
		const shared = tempDir();
		const chat = await connect('e2e-chat-lane', shared);
		const card = await connect('e2e-card-lane', shared);

		await chat.callTool({ name: 'preview_order', arguments: ORDER_ARGS });
		const body = await readConfirmation(card);
		const execArgs = {
			...ORDER_ARGS,
			confirmation_token: body.confirmation?.confirmation_token,
			token_expires_at: body.confirmation?.expires_at,
		};

		const results = (await Promise.all([
			chat.callTool({ name: 'create_order', arguments: execArgs }),
			card.callTool({ name: 'create_order', arguments: execArgs }),
		])) as CallResult[];
		const oks = results.map((r) => (r.structuredContent as { ok?: boolean } | undefined)?.ok);
		expect(oks.filter((ok) => ok === true)).toHaveLength(1);
		const rejected = results.find((r) => (r.structuredContent as { ok?: boolean } | undefined)?.ok !== true);
		expect(rejected?.content?.[0]?.text).toContain('既に使用されています');
	}, 60_000);

	it('フォルダを共有していなければ、カード側のプロセスは何も受け取らない', async () => {
		const chat = await connect('e2e-chat-lane', tempDir());
		const card = await connect('e2e-card-lane', tempDir());

		await chat.callTool({ name: 'preview_order', arguments: ORDER_ARGS });

		expect(await readConfirmation(card)).toEqual({});
	}, 60_000);
});
