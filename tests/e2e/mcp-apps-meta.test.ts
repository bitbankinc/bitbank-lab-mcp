/**
 * MCP Apps `_meta` 配送の stdio wire レベル回帰（E2E）。
 *
 * 単体テストは `respond()` の戻り値までしか見ないため、**SDK が結果レベル `_meta` を
 * 実際にクライアントへ透過するか**は確認できない。ここだけがそれを担保する。
 * 計測では透過を確認済みだが、SDK 更新で静かに壊れうる箇所なので回帰を張る。
 *
 * ⚠️ `tests/e2e/**` は `npm test` の対象外で PR では走らない（CLAUDE.md）。
 * 手動 / nightly（`npm run test:e2e`）でのみ実行される。PR でのゲートは
 * `tests/private/mcp-apps-execute.test.ts` が担う。
 */
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIRMATION_META_KEY } from '../../src/mcp-apps-meta.js';
import { APP_RESOURCE_MIME_TYPE, MCP_APPS_UI_EXTENSION_ID } from '../../src/resources/app-resources.js';
import { mockSpotPairsResponse } from '../fixtures/private-api.js';

const ENTRY = new URL('./mock-server-entry.ts', import.meta.url).pathname;
const TSX_BIN = new URL('../../node_modules/.bin/tsx', import.meta.url).pathname;

if (!existsSync(TSX_BIN)) {
	throw new Error(
		`tsx バイナリが見つかりません: ${TSX_BIN}\n\`npm install\` を実行してから E2E を再実行してください。`,
	);
}

const ORDER_ARGS = { pair: 'btc_jpy', amount: '0.01', side: 'buy', type: 'limit', price: '14000000' };

/** MCP Apps UI を宣言するクライアント。SDK v1 の型に extensions が無いためキャストする。 */
function createAppUiClient(): Client {
	return new Client({ name: 'e2e-mcp-apps', version: '0.0.1' }, {
		capabilities: {
			extensions: { [MCP_APPS_UI_EXTENSION_ID]: { mimeTypes: [APP_RESOURCE_MIME_TYPE] } },
		},
	} as unknown as ConstructorParameters<typeof Client>[1]);
}

/** UI capability を宣言しないクライアント（ゲート 2 段目が閉じる側）。 */
function createPlainClient(): Client {
	return new Client({ name: 'e2e-plain', version: '0.0.1' });
}

function createTransport(env: Record<string, string>) {
	return new StdioClientTransport({
		command: TSX_BIN,
		args: [ENTRY],
		env: {
			...process.env,
			// preview_order は /spot/pairs と /ticker を引く。実 API を叩かないようモックする。
			MOCK_RESPONSES: JSON.stringify({
				'/spot/pairs': mockSpotPairsResponse(),
				'btc_jpy/ticker': { success: 1, data: { last: '15000000' } },
			}),
			// Private ツールの有効化に必要（実際の発注はしない。preview のみ呼ぶ）。
			BITBANK_API_KEY: 'e2e_key',
			BITBANK_API_SECRET: 'e2e_secret',
			...env,
		},
		stderr: 'pipe',
	});
}

type CallResult = {
	content?: Array<{ type: string; text?: string }>;
	structuredContent?: unknown;
	_meta?: Record<string, unknown>;
};

describe('E2E: MCP Apps `_meta` 経由の確認トークン配送', () => {
	let client: Client | undefined;

	afterEach(async () => {
		await client?.close();
		client = undefined;
	});

	it('オプトイン on + MCP Apps 宣言: `_meta` にトークンが載り、content / structuredContent には載らない', async () => {
		client = createAppUiClient();
		await client.connect(createTransport({ BITBANK_MCP_APPS_EXECUTE: '1' }));

		const result = (await client.callTool({ name: 'preview_order', arguments: ORDER_ARGS })) as CallResult;

		const payload = result._meta?.[CONFIRMATION_META_KEY] as
			| { confirmation_token?: string; expires_at?: number }
			| undefined;
		expect(payload?.confirmation_token).toBeTypeOf('string');
		expect(payload?.expires_at).toBeTypeOf('number');

		// 最重要: wire 上の content / structuredContent にトークン値が現れない
		const token = payload?.confirmation_token as string;
		expect(JSON.stringify(result.content)).not.toContain(token);
		expect(JSON.stringify(result.structuredContent)).not.toContain(token);
		expect(JSON.stringify(result.structuredContent)).not.toContain('confirmation_token');
	}, 30_000);

	it('オプトイン off: `_meta` にトークンが載らない', async () => {
		client = createAppUiClient();
		await client.connect(createTransport({}));

		const result = (await client.callTool({ name: 'preview_order', arguments: ORDER_ARGS })) as CallResult;

		expect(result._meta?.[CONFIRMATION_META_KEY]).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain('confirmation_token');
	}, 30_000);

	it('MCP Apps 未宣言のホストには、オプトイン on でも載らない', async () => {
		client = createPlainClient();
		await client.connect(createTransport({ BITBANK_MCP_APPS_EXECUTE: '1' }));

		const result = (await client.callTool({ name: 'preview_order', arguments: ORDER_ARGS })) as CallResult;

		expect(result._meta?.[CONFIRMATION_META_KEY]).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain('confirmation_token');
	}, 30_000);

	it('get_ui_snapshot も同じ `_meta` 契約でトークンを返す（pull 型 hydration）', async () => {
		client = createAppUiClient();
		await client.connect(createTransport({ BITBANK_MCP_APPS_EXECUTE: '1' }));

		// preview を 1 回通してスナップショットを作る
		await client.callTool({ name: 'preview_order', arguments: ORDER_ARGS });

		const snapshot = (await client.callTool({
			name: 'get_ui_snapshot',
			arguments: { resource_uri: 'ui://order/confirm.html' },
		})) as CallResult;

		const payload = snapshot._meta?.[CONFIRMATION_META_KEY] as { confirmation_token?: string } | undefined;
		expect(payload?.confirmation_token).toBeTypeOf('string');
		expect(JSON.stringify(snapshot.structuredContent)).not.toContain(payload?.confirmation_token as string);
	}, 30_000);

	it('トークン無しの create_order 直接呼び出しは direct_execute_forbidden', async () => {
		client = createAppUiClient();
		await client.connect(createTransport({ BITBANK_MCP_APPS_EXECUTE: '1' }));

		const result = (await client.callTool({
			name: 'create_order',
			// スキーマ上 confirmation_token は必須なので、空文字を渡してハンドラまで到達させる
			arguments: { ...ORDER_ARGS, confirmation_token: '', token_expires_at: Date.now() + 60_000 },
		})) as CallResult;

		const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
		expect(text).toContain('直接実行できません');
	}, 30_000);
});
