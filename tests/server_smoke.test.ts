import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../src/tool-definition.js';

// ── Mock 用ローカル型 ──────────────────────────────────────────
interface FakeToolEntry {
	name: string;
	options: Record<string, unknown>;
	handler: (input: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}
interface FakePromptEntry {
	name: string;
	options: Record<string, unknown>;
	handler: () => Record<string, unknown>;
}
interface FakeResourceEntry {
	name: string;
	uri: string;
	config: Record<string, unknown>;
	read: (uri: URL) => Promise<unknown> | unknown;
}
interface FakeMcpServerShape {
	info: Record<string, unknown>;
	options: Record<string, unknown> | undefined;
	server: Record<string, unknown>;
	tools: FakeToolEntry[];
	prompts: FakePromptEntry[];
	resources: FakeResourceEntry[];
	connections: Array<{ kind: string }>;
}
interface MockPromptDef {
	name: string;
	description: string;
	messages: Array<{
		role: string;
		content: Array<Record<string, unknown>>;
	}>;
}

const runtime = vi.hoisted(() => ({
	toolDefs: [] as ToolDefinition[],
	promptDefs: [] as MockPromptDef[],
	serverInstances: [] as FakeMcpServerShape[],
	stdioTransports: [] as Array<{ kind: string }>,
	logToolRun: vi.fn(),
	logError: vi.fn(),
}));

// SDK v2 は部分モックにする: McpServer だけ差し替え、isInputRequiredResult /
// inputRequired / createRequestStateCodec 等の純粋関数は実物を使う
// （server.ts 経由でロードされる src/private/request-state.ts が実物の codec を必要とする）。
vi.mock('@modelcontextprotocol/server', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();

	class FakeMcpServer {
		info: Record<string, unknown>;
		options: Record<string, unknown> | undefined;
		// server.ts が handlerExtra に注入する内部 Server 相当
		server: Record<string, unknown> = { getClientCapabilities: () => undefined };
		tools: FakeToolEntry[];
		prompts: FakePromptEntry[];
		resources: FakeResourceEntry[];
		connections: Array<{ kind: string }>;

		constructor(info: Record<string, unknown>, options?: Record<string, unknown>) {
			this.info = info;
			this.options = options;
			this.tools = [];
			this.prompts = [];
			this.resources = [];
			this.connections = [];
			runtime.serverInstances.push(this);
		}

		registerTool(
			name: string,
			options: Record<string, unknown>,
			handler: (input: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<Record<string, unknown>>,
		) {
			this.tools.push({ name, options, handler });
		}

		registerPrompt(name: string, options: Record<string, unknown>, handler: () => Record<string, unknown>) {
			this.prompts.push({ name, options, handler });
		}

		registerResource(
			name: string,
			uri: string,
			config: Record<string, unknown>,
			read: (uri: URL) => Promise<unknown> | unknown,
		) {
			this.resources.push({ name, uri, config, read });
		}

		async connect(transport: { kind: string }) {
			this.connections.push(transport);
		}
	}

	return { ...actual, McpServer: FakeMcpServer };
});

vi.mock('@modelcontextprotocol/server/stdio', () => {
	class FakeStdioServerTransport {
		kind = 'stdio';

		constructor() {
			runtime.stdioTransports.push(this);
		}
	}

	return { StdioServerTransport: FakeStdioServerTransport };
});

vi.mock('../lib/logger.js', () => ({
	logToolRun: runtime.logToolRun,
	logError: runtime.logError,
}));

vi.mock('../src/prompts.js', () => ({
	get prompts() {
		return runtime.promptDefs;
	},
}));

vi.mock('../src/tool-registry.js', async () => {
	const { z } = await import('zod');

	if (!runtime.toolDefs.length) {
		runtime.toolDefs = [
			{
				name: 'smoke_tool',
				description: 'Default smoke tool',
				inputSchema: z.object({
					pair: z.string().regex(/^[a-z_]+$/),
					limit: z.number().default(5),
					verbose: z.boolean().optional(),
				}),
				handler: vi.fn(async () => ({ summary: 'default ok', ok: true })) as unknown as ToolDefinition['handler'],
			},
		];
	}

	return {
		get allToolDefs() {
			return runtime.toolDefs;
		},
	};
});

const originalEnv = { ...process.env };

function resetRuntime() {
	runtime.toolDefs = [];
	runtime.promptDefs = [
		{
			name: 'smoke_prompt',
			description: 'Smoke prompt description',
			messages: [
				{ role: 'system', content: [{ type: 'text', text: 'system instruction' }] },
				{
					role: 'assistant',
					content: [
						{ type: 'text', text: 'assistant note' },
						{ type: 'tool_code', tool_name: 'get_ticker', tool_input: { pair: 'btc_jpy' } },
					],
				},
			],
		},
	];
	runtime.serverInstances = [];
	runtime.stdioTransports = [];
	runtime.logToolRun.mockReset();
	runtime.logError.mockReset();
}

async function importServer(): Promise<FakeMcpServerShape> {
	vi.resetModules();
	await import('../src/server.js');
	const server = runtime.serverInstances.at(-1);
	if (!server) throw new Error('importServer: no server instance created');
	return server;
}

describe('server.ts smoke', () => {
	beforeEach(() => {
		resetRuntime();
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it('起動時にツール・prompt・resources を登録し requestState.verify を設定する', async () => {
		const { z } = await import('zod');

		runtime.toolDefs = [
			{
				name: 'smoke_tool',
				description: 'Smoke tool description',
				inputSchema: z.object({
					pair: z.string().regex(/^[a-z_]+$/),
					limit: z.number().default(5),
					includeMeta: z.boolean().optional(),
				}),
				handler: vi.fn(async () => ({ summary: 'ok', ok: true })) as unknown as ToolDefinition['handler'],
			},
			{
				name: 'second_tool',
				description: 'Second tool description',
				inputSchema: z.object({
					enabled: z.boolean(),
				}),
				handler: vi.fn(async () => ({ summary: 'ok2', ok: true })) as unknown as ToolDefinition['handler'],
			},
		];

		const server = await importServer();

		expect(server.info).toEqual({ name: 'bitbank-mcp', version: '0.4.2' });
		expect(server.tools.map((tool) => tool.name)).toEqual(['smoke_tool', 'second_tool']);
		expect(server.prompts.map((prompt) => prompt.name)).toEqual(['smoke_prompt']);
		// MRTR requestState の HMAC / 期限検証フックが ServerOptions に接続されている
		const requestState = server.options?.requestState as { verify?: unknown } | undefined;
		expect(typeof requestState?.verify).toBe('function');
		// Resources は SDK の registerResource 経由で正規ルートに登録される
		expect(server.resources.map((r) => r.uri)).toEqual(['ui://order/confirm.html', 'ui://cancel/confirm.html']);
		expect(server.connections).toHaveLength(1);
		expect(server.connections[0].kind).toBe('stdio');
		expect(runtime.stdioTransports).toHaveLength(1);
	});

	it('tool・prompt・resources の登録内容が SDK に渡る', async () => {
		const { z } = await import('zod');

		const inputSchema = z.object({
			pair: z.string().regex(/^[a-z_]+$/),
			limit: z.number().default(5),
			enabled: z.boolean(),
			note: z.string().optional(),
		});
		runtime.toolDefs = [
			{
				name: 'smoke_tool',
				description: 'Smoke tool description',
				inputSchema,
				handler: vi.fn(async () => ({ summary: 'ok', ok: true })) as unknown as ToolDefinition['handler'],
			},
		];

		const server = await importServer();

		// ツールは完全な Zod スキーマ（.refine 等を含む）をそのまま SDK に渡す。
		// JSON Schema への変換・入力検証・tools/list のルーティングは SDK v2 の責務。
		expect(server.tools).toHaveLength(1);
		expect(server.tools[0].options).toMatchObject({ description: 'Smoke tool description' });
		expect(server.tools[0].options.inputSchema).toBe(inputSchema);

		// prompt は registerPrompt 経由で登録され、メッセージは SDK 形式に変換される
		const registeredPrompt = server.prompts[0];
		expect(registeredPrompt.options).toEqual({ description: 'Smoke prompt description' });
		const promptRegistration = registeredPrompt.handler();
		expect(promptRegistration.messages).toEqual([
			{ role: 'user', content: { type: 'text', text: 'system instruction' } },
			{
				role: 'assistant',
				content: {
					type: 'text',
					text: 'assistant note\nCall get_ticker with {"pair":"btc_jpy"}',
				},
			},
		]);

		// Resources は SDK の registerResource 経由で登録され、`server.resources` に集約される
		expect(server.resources.map((r) => ({ uri: r.uri, name: r.name, ...r.config }))).toEqual([
			{
				uri: 'ui://order/confirm.html',
				name: 'Order Confirmation',
				description:
					'preview_order の結果をインタラクティブに確認し、create_order を発注するための UI（MCP Apps / SEP-1865）',
				mimeType: 'text/html;profile=mcp-app',
			},
			{
				uri: 'ui://cancel/confirm.html',
				name: 'Cancel Confirmation',
				description:
					'preview_cancel_order / preview_cancel_orders の結果をインタラクティブに確認し、cancel_order(s) を実行するための UI（MCP Apps / SEP-1865）',
				mimeType: 'text/html;profile=mcp-app',
			},
		]);
	});

	it('tool 実行の success と error を整形し logger を呼ぶ', async () => {
		const { z } = await import('zod');

		const successHandler = vi.fn(async () => ({
			content: [{ type: 'text', text: 'preferred text' }],
			summary: 'ignored summary',
			ok: true,
			data: { value: 1 },
		}));
		const errorHandler = vi.fn(async () => {
			throw new Error('boom');
		});

		runtime.toolDefs = [
			{
				name: 'success_tool',
				description: 'Success tool',
				inputSchema: z.object({ pair: z.string() }),
				handler: successHandler as unknown as ToolDefinition['handler'],
			},
			{
				name: 'error_tool',
				description: 'Error tool',
				inputSchema: z.object({ pair: z.string() }),
				handler: errorHandler as unknown as ToolDefinition['handler'],
			},
		];

		const server = await importServer();

		const successResult = await server.tools[0].handler({ pair: 'btc_jpy' });
		expect(successResult).toEqual({
			content: [{ type: 'text', text: 'preferred text' }],
			structuredContent: {
				content: [{ type: 'text', text: 'preferred text' }],
				summary: 'ignored summary',
				ok: true,
				data: { value: 1 },
			},
		});
		expect(runtime.logToolRun).toHaveBeenCalledTimes(1);
		expect(runtime.logToolRun.mock.calls[0][0]).toMatchObject({
			tool: 'success_tool',
			input: { pair: 'btc_jpy' },
			ms: expect.any(Number),
		});

		const errorResult = await server.tools[1].handler({ pair: 'eth_jpy' });
		expect(errorResult).toEqual({
			content: [{ type: 'text', text: '内部エラーが発生しました。ログを確認してください' }],
			structuredContent: {
				ok: false,
				summary: '内部エラーが発生しました。ログを確認してください',
				meta: {
					ms: expect.any(Number),
					errorType: 'internal',
				},
			},
		});
		// 元のエラー message ('boom') は応答層に漏らさないが、ログには full message を渡す。
		const errorTextOut = (errorResult as { content: Array<{ text: string }> }).content[0].text;
		expect(errorTextOut).not.toContain('boom');
		expect(runtime.logError).toHaveBeenCalledTimes(1);
		expect(runtime.logError).toHaveBeenCalledWith('error_tool', expect.any(Error), { pair: 'eth_jpy' });
		expect((runtime.logError.mock.calls[0][1] as Error).message).toBe('boom');
	});

	it('MRTR（input_required）を返すハンドラの結果は respond() で包まず素通しする', async () => {
		const { z } = await import('zod');
		const { inputRequired } = (await vi.importActual(
			'@modelcontextprotocol/server',
		)) as typeof import('@modelcontextprotocol/server');

		const mrtrResult = inputRequired({
			inputRequests: {
				confirm: inputRequired.elicit({
					message: '実行しますか？',
					requestedSchema: {
						type: 'object',
						properties: { confirmed: { type: 'boolean' } },
						required: ['confirmed'],
					},
				}),
			},
			requestState: 'opaque-state',
		});
		const mrtrHandler = vi.fn(async () => mrtrResult);

		runtime.toolDefs = [
			{
				name: 'mrtr_tool',
				description: 'MRTR tool',
				inputSchema: z.object({ pair: z.string() }),
				handler: mrtrHandler as unknown as ToolDefinition['handler'],
			},
		];

		const server = await importServer();
		const result = await server.tools[0].handler({ pair: 'btc_jpy' });

		// respond() の content/structuredContent ラップが掛かっていないこと
		expect(result).toBe(mrtrResult);
		expect(runtime.logToolRun).toHaveBeenCalledTimes(1);
		expect(runtime.logToolRun.mock.calls[0][0]).toMatchObject({
			tool: 'mrtr_tool',
			result: { ok: true, summary: '[MRTR] input_required round' },
		});
	});

	it('_meta.ui.resourceUri を持つツールの応答は UI スナップショットに保存される', async () => {
		const { z } = await import('zod');

		runtime.toolDefs = [
			{
				name: 'ui_tool',
				description: 'MCP Apps 連携ツール',
				inputSchema: z.object({}),
				handler: vi.fn(async () => ({
					ok: true,
					summary: 'preview ok',
					data: { preview: { pair: 'btc_jpy' } },
				})) as unknown as ToolDefinition['handler'],
				_meta: { ui: { resourceUri: 'ui://order/confirm.html' } },
			},
			{
				name: 'plain_tool',
				description: '通常ツール',
				inputSchema: z.object({}),
				handler: vi.fn(async () => ({ ok: true, summary: 'plain ok' })) as unknown as ToolDefinition['handler'],
			},
			{
				name: 'ui_error_tool',
				description: 'MCP Apps 連携ツール（エラー）',
				inputSchema: z.object({}),
				handler: vi.fn(async () => {
					throw new Error('boom');
				}) as unknown as ToolDefinition['handler'],
				_meta: { ui: { resourceUri: 'ui://cancel/confirm.html' } },
			},
		];

		const server = await importServer();
		// importServer() の vi.resetModules() 後に server.ts と同一インスタンスの
		// cache モジュールを import する（モジュールキャッシュを共有させる）。
		const { getUiSnapshot, _resetUiSnapshots } = await import('../src/ui-snapshot-cache.js');
		_resetUiSnapshots();

		await server.tools[0].handler({});
		expect(getUiSnapshot('ui://order/confirm.html')).toMatchObject({
			ok: true,
			data: { preview: { pair: 'btc_jpy' } },
		});

		// _meta.ui の無いツールはどの URI にも保存されない
		await server.tools[1].handler({});
		expect(getUiSnapshot('ui://cancel/confirm.html')).toBeNull();

		// エラー応答も ontoolresult で配信されるはずの内容としてスナップショットに残る
		await server.tools[2].handler({});
		expect(getUiSnapshot('ui://cancel/confirm.html')).toMatchObject({ ok: false });

		// スナップショットは sessionId + resourceUri をキーに独立保持する。
		// sess-1 への保存は stdio（sessionId なし）エントリを上書きしない。
		await server.tools[0].handler({}, { sessionId: 'sess-1' });
		expect(getUiSnapshot('ui://order/confirm.html', { sessionId: 'sess-1' })).toMatchObject({ ok: true });
		expect(getUiSnapshot('ui://order/confirm.html', { sessionId: 'other-session' })).toBeNull();
		expect(getUiSnapshot('ui://order/confirm.html')).toMatchObject({ ok: true });
	});

	// `_meta` は confirmation token を載せる唯一のチャネルで、`content[0].text` は LLM が読む
	// 唯一のチャネル。respond() の 2 つのフォールバックは result 全体を流し込むため、
	// `_meta` を落とさないとトークンが LLM 可視チャネルへ出る（ADR-0007）。
	// 現行ハンドラはこの分岐に入らないが、将来のハンドラが黙って踏む罠なのでここで固定する。
	it('結果レベル `_meta` は content / structuredContent のフォールバックに流れない', async () => {
		const { z } = await import('zod');
		const TOKEN = 'tok_must_not_leak';
		const META = { 'cc.bitbank/confirmation': { confirmation_token: TOKEN, expires_at: 1 } };

		runtime.toolDefs = [
			{
				// content が空 & summary 無し → JSON フォールバックへ落ちる
				name: 'empty_content_tool',
				description: 'content 空',
				inputSchema: z.object({}),
				handler: vi.fn(async () => ({
					content: [],
					structuredContent: { ok: true, data: { preview: {} } },
					_meta: META,
				})) as unknown as ToolDefinition['handler'],
			},
			{
				// structuredContent が plain object でない → result 自体が structuredContent になる
				name: 'non_object_structured_tool',
				description: 'structuredContent が非オブジェクト',
				inputSchema: z.object({}),
				handler: vi.fn(async () => ({
					content: [{ type: 'text', text: '確認カードを表示しました' }],
					structuredContent: 'not-an-object',
					_meta: META,
				})) as unknown as ToolDefinition['handler'],
			},
		];

		const server = await importServer();

		for (const [index, label] of [
			[0, 'JSON フォールバック'],
			[1, 'structuredContent フォールバック'],
		] as const) {
			const result = await server.tools[index].handler({});
			expect(JSON.stringify(result.content), `${label}: content にトークンが出た`).not.toContain(TOKEN);
			expect(JSON.stringify(result.structuredContent), `${label}: structuredContent にトークンが出た`).not.toContain(
				TOKEN,
			);
			// 配送そのものは壊さない: 結果レベル `_meta` は従来どおり透過する
			expect(JSON.stringify(result._meta), `${label}: _meta の透過が壊れた`).toContain(TOKEN);
		}
	});

	it('ハンドラには ctx と内部 Server を合流させた extra が渡る', async () => {
		const { z } = await import('zod');

		// 引数を型付けしておかないと mock.calls[0] が空タプル [] に推論され、
		// [1] の取り出しが TS2493 / TS2352 になる。
		const spyHandler = vi.fn(async (_input: Record<string, unknown>, _extra?: Record<string, unknown>) => ({
			summary: 'ok',
			ok: true,
		}));
		runtime.toolDefs = [
			{
				name: 'ctx_tool',
				description: 'ctx tool',
				inputSchema: z.object({}),
				handler: spyHandler as unknown as ToolDefinition['handler'],
			},
		];

		const server = await importServer();
		const fakeCtx = { mcpReq: { id: 1, inputResponses: { confirm: { action: 'decline' } } } };
		await server.tools[0].handler({}, fakeCtx);

		expect(spyHandler).toHaveBeenCalledTimes(1);
		const extra = spyHandler.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(extra.mcpReq).toBe(fakeCtx.mcpReq);
		expect(extra.server).toBe(server.server);
	});

	it('応答層は内部エラー本文・ZodError 詳細を漏らさず PrivateApiError は素通しする', async () => {
		const { z } = await import('zod');
		const { ZodError } = await import('zod');

		const pathLeakHandler = vi.fn(async () => {
			throw new Error("ENOENT: no such file or directory, open '/home/user/secret/path.ts'");
		});
		const zodHandler = vi.fn(async () => {
			// Zod のバリデーション失敗を模した ZodError を投げる
			const schema = z.object({ pair: z.string() });
			schema.parse({ pair: 123 });
			throw new Error('unreachable');
		});
		// importServer() で vi.resetModules() が呼ばれるため、PrivateApiError は
		// handler 実行時にロード（lib/error.ts と同じモジュールキャッシュを参照させる）
		const privateApiHandler = vi.fn(async () => {
			const { PrivateApiError } = await import('../src/private/client.js');
			throw new PrivateApiError('数量が最低取引量を下回っています', 'invalid_amount');
		});

		runtime.toolDefs = [
			{
				name: 'path_leak_tool',
				description: 'tool that throws an error containing a local path',
				inputSchema: z.object({}),
				handler: pathLeakHandler as unknown as ToolDefinition['handler'],
			},
			{
				name: 'zod_tool',
				description: 'tool that throws ZodError',
				inputSchema: z.object({}),
				handler: zodHandler as unknown as ToolDefinition['handler'],
			},
			{
				name: 'private_api_tool',
				description: 'tool that throws PrivateApiError',
				inputSchema: z.object({}),
				handler: privateApiHandler as unknown as ToolDefinition['handler'],
			},
		];

		const server = await importServer();

		// 1) 一般 Error 由来のローカルパスがユーザ応答に含まれないこと
		const pathLeakResult = (await server.tools[0].handler({})) as {
			content: Array<{ text: string }>;
			structuredContent: { summary: string; meta: { errorType: string } };
		};
		expect(pathLeakResult.content[0].text).not.toContain('/home/user/secret/path.ts');
		expect(pathLeakResult.content[0].text).not.toContain('ENOENT');
		expect(pathLeakResult.structuredContent.summary).not.toContain('/home/user/secret/path.ts');
		expect(pathLeakResult.structuredContent.meta.errorType).toBe('internal');

		// 2) ZodError の詳細メッセージがユーザ応答に含まれないこと
		const zodResult = (await server.tools[1].handler({})) as {
			content: Array<{ text: string }>;
			structuredContent: { summary: string; meta: { errorType: string } };
		};
		expect(zodResult.content[0].text).not.toContain('Expected');
		expect(zodResult.content[0].text).not.toContain('pair');
		expect(zodResult.content[0].text).toContain('入力形式が不正です');
		expect(zodResult.structuredContent.meta.errorType).toBe('validation_error');
		// logError には ZodError がそのまま渡る（運用デバッグ性は維持）
		const loggedErr = runtime.logError.mock.calls.find((c) => c[0] === 'zod_tool')?.[1] as Error;
		expect(loggedErr).toBeInstanceOf(ZodError);

		// 3) PrivateApiError の業務メッセージは素通し
		const privateResult = (await server.tools[2].handler({})) as {
			content: Array<{ text: string }>;
			structuredContent: { summary: string; meta: { errorType: string } };
		};
		expect(privateResult.content[0].text).toBe('数量が最低取引量を下回っています');
		expect(privateResult.structuredContent.summary).toBe('数量が最低取引量を下回っています');
		expect(privateResult.structuredContent.meta.errorType).toBe('invalid_amount');
	});

	it('stdio transport で起動し接続する', async () => {
		const { z } = await import('zod');

		runtime.toolDefs = [
			{
				name: 'smoke_tool',
				description: 'Smoke tool description',
				inputSchema: z.object({ pair: z.string() }),
				handler: vi.fn(async () => ({ summary: 'ok', ok: true })) as unknown as ToolDefinition['handler'],
			},
		];

		const server = await importServer();
		expect(server.connections).toHaveLength(1);
		expect(server.connections[0].kind).toBe('stdio');
	});
});
