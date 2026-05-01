import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_PROMPT } from '../src/system-prompt.js';
import type { ToolDefinition } from '../src/tool-definition.js';

// ── Mock 用ローカル型 ──────────────────────────────────────────
interface FakeToolEntry {
	name: string;
	options: Record<string, unknown>;
	handler: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
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
	tools: FakeToolEntry[];
	prompts: FakePromptEntry[];
	resources: FakeResourceEntry[];
	requestHandlers: Record<string, (request?: Record<string, unknown>) => Promise<unknown> | unknown>;
	connections: Array<{ kind: string }>;
}
interface FakeHttpTransportShape {
	kind: string;
	options: Record<string, unknown>;
	handleRequest: ReturnType<typeof vi.fn>;
}
interface FakeExpressApp {
	use: ReturnType<typeof vi.fn>;
	listen: ReturnType<typeof vi.fn>;
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
	httpTransports: [] as FakeHttpTransportShape[],
	logToolRun: vi.fn(),
	logError: vi.fn(),
	expressFactory: vi.fn(),
	expressJson: vi.fn(),
	expressApp: null as FakeExpressApp | null,
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
	class FakeMcpServer {
		info: Record<string, unknown>;
		tools: FakeToolEntry[];
		prompts: FakePromptEntry[];
		resources: FakeResourceEntry[];
		requestHandlers: Record<string, (request?: Record<string, unknown>) => Promise<unknown> | unknown>;
		connections: Array<{ kind: string }>;

		constructor(info: Record<string, unknown>) {
			this.info = info;
			this.tools = [];
			this.prompts = [];
			this.resources = [];
			this.requestHandlers = {};
			this.connections = [];
			runtime.serverInstances.push(this);
		}

		registerTool(
			name: string,
			options: Record<string, unknown>,
			handler: (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
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

		setRequestHandler(name: string, handler: (request?: Record<string, unknown>) => Promise<unknown> | unknown) {
			this.requestHandlers[name] = handler;
		}

		async connect(transport: { kind: string }) {
			this.connections.push(transport);
		}
	}

	return { McpServer: FakeMcpServer };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => {
	class FakeStdioServerTransport {
		kind = 'stdio';

		constructor() {
			runtime.stdioTransports.push(this);
		}
	}

	return { StdioServerTransport: FakeStdioServerTransport };
});

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => {
	class FakeStreamableHTTPServerTransport {
		kind = 'http';
		options: Record<string, unknown>;
		handleRequest = vi.fn(async () => {});

		constructor(options: Record<string, unknown>) {
			this.options = options;
			runtime.httpTransports.push(this);
		}
	}

	return { StreamableHTTPServerTransport: FakeStreamableHTTPServerTransport };
});

vi.mock('../lib/logger.js', () => ({
	logToolRun: runtime.logToolRun,
	logError: runtime.logError,
}));

vi.mock('express', () => {
	// biome-ignore lint/suspicious/noExplicitAny: express モジュールモック — 関数に .json プロパティを動的付与するため any を使用
	const express = runtime.expressFactory as any;
	express.json = runtime.expressJson;
	return { default: express };
});

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
	runtime.httpTransports = [];
	runtime.logToolRun.mockReset();
	runtime.logError.mockReset();
	runtime.expressApp = {
		use: vi.fn(),
		listen: vi.fn((port: number, callback?: () => void) => {
			callback?.();
			return { port };
		}),
	};
	runtime.expressFactory.mockReset();
	runtime.expressFactory.mockImplementation(() => runtime.expressApp);
	runtime.expressJson.mockReset();
	runtime.expressJson.mockReturnValue({ kind: 'json-middleware' });
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
		delete process.env.MCP_ENABLE_HTTP;
		delete process.env.PORT;
		delete process.env.ALLOWED_HOSTS;
		delete process.env.ALLOWED_ORIGINS;
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it('起動時にツール・prompt・fallback handlers を登録する', async () => {
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
		expect(Object.keys(server.requestHandlers)).toEqual(
			expect.arrayContaining(['tools/list', 'prompts/list', 'prompts/get']),
		);
		// Resources は SDK の registerResource 経由で正規ルートに登録される
		expect(server.resources.map((r) => r.uri)).toEqual([
			'prompt://system',
			'ui://order/confirm.html',
			'ui://cancel/confirm.html',
		]);
		expect(server.connections).toHaveLength(1);
		expect(server.connections[0].kind).toBe('stdio');
		expect(runtime.stdioTransports).toHaveLength(1);
	});

	it('tools/list・prompts/list・prompts/get と resources の登録内容を返す', async () => {
		const { z } = await import('zod');
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		try {
			runtime.toolDefs = [
				{
					name: 'smoke_tool',
					description: 'Smoke tool description',
					inputSchema: z.object({
						pair: z.string().regex(/^[a-z_]+$/),
						limit: z.number().default(5),
						enabled: z.boolean(),
						note: z.string().optional(),
					}),
					handler: vi.fn(async () => ({ summary: 'ok', ok: true })) as unknown as ToolDefinition['handler'],
				},
			];

			const server = await importServer();

			const toolsList = (await server.requestHandlers['tools/list']()) as { tools: Array<Record<string, unknown>> };
			expect(toolsList.tools).toHaveLength(1);
			expect(toolsList.tools[0]).toMatchObject({
				name: 'smoke_tool',
				description: 'Smoke tool description',
				inputSchema: {
					type: 'object',
					properties: {
						pair: { type: 'string', pattern: '^[a-z_]+$' },
						limit: { type: 'number', default: 5 },
						enabled: { type: 'boolean' },
						note: { type: 'string' },
					},
					required: ['pair', 'enabled'],
				},
			});

			const promptsList = (await server.requestHandlers['prompts/list']()) as {
				prompts: Array<Record<string, unknown>>;
			};
			expect(promptsList.prompts).toEqual([{ name: 'smoke_prompt', description: 'Smoke prompt description' }]);

			const registeredPrompt = server.prompts[0];
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

			const promptGet = (await server.requestHandlers['prompts/get']({ params: { name: 'smoke_prompt' } })) as {
				description: string;
				messages: Array<Record<string, unknown>>;
			};
			expect(promptGet.description).toBe('Smoke prompt description');
			expect(promptGet.messages).toEqual([
				{ role: 'user', content: { type: 'text', text: 'system instruction' } },
				{ role: 'assistant', content: { type: 'text', text: 'assistant note' } },
			]);

			// Resources は SDK の registerResource 経由で登録され、`server.resources` に集約される
			expect(server.resources.map((r) => ({ uri: r.uri, name: r.name, ...r.config }))).toEqual([
				{
					uri: 'prompt://system',
					name: 'test-bb System Prompt',
					description: 'System-level guidance for using test-bb MCP server',
					mimeType: 'text/plain',
				},
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

			const sysPromptResource = server.resources.find((r) => r.uri === 'prompt://system');
			if (!sysPromptResource) throw new Error('prompt://system resource not registered');
			const sysPromptRead = (await sysPromptResource.read(new URL('prompt://system'))) as {
				contents: Array<Record<string, unknown>>;
			};
			expect(sysPromptRead.contents).toEqual([
				{
					uri: 'prompt://system',
					mimeType: 'text/plain',
					text: SYSTEM_PROMPT,
				},
			]);

			await expect(server.requestHandlers['prompts/get']({ params: { name: 'missing_prompt' } })).rejects.toThrow(
				'Prompt not found: missing_prompt',
			);
		} finally {
			consoleErrorSpy.mockRestore();
		}
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
			content: [{ type: 'text', text: '内部エラー: boom' }],
			structuredContent: {
				ok: false,
				summary: '内部エラー: boom',
				meta: {
					ms: expect.any(Number),
					errorType: 'internal',
				},
			},
		});
		expect(runtime.logError).toHaveBeenCalledTimes(1);
		expect(runtime.logError).toHaveBeenCalledWith('error_tool', expect.any(Error), { pair: 'eth_jpy' });
	});

	it('HTTP 有効時は HTTP transport と express を初期化する', async () => {
		const { z } = await import('zod');

		runtime.toolDefs = [
			{
				name: 'smoke_tool',
				description: 'Smoke tool description',
				inputSchema: z.object({ pair: z.string() }),
				handler: vi.fn(async () => ({ summary: 'ok', ok: true })) as unknown as ToolDefinition['handler'],
			},
		];
		process.env.MCP_ENABLE_HTTP = '1';
		process.env.PORT = '3010';
		process.env.ALLOWED_HOSTS = '127.0.0.1,localhost,example.com';
		process.env.ALLOWED_ORIGINS = 'https://example.com';

		const server = await importServer();

		// SDK の McpServer.connect() は 1:1 のため、HTTP 有効時は stdio を接続しない
		expect(server.connections).toHaveLength(1);
		expect(server.connections[0].kind).toBe('http');
		expect(runtime.httpTransports).toHaveLength(1);
		expect(runtime.httpTransports[0].options).toMatchObject({
			path: '/mcp',
			enableDnsRebindingProtection: true,
			allowedHosts: ['127.0.0.1', 'localhost', 'example.com'],
			allowedOrigins: ['https://example.com'],
		});
		expect(typeof runtime.httpTransports[0].options.sessionIdGenerator).toBe('function');
		expect(runtime.expressFactory).toHaveBeenCalledTimes(1);
		expect(runtime.expressJson).toHaveBeenCalledTimes(1);
		expect(runtime.expressApp?.use).toHaveBeenNthCalledWith(1, { kind: 'json-middleware' });
		// handleRequest ベースのミドルウェアが '/mcp' パスで登録される
		expect(runtime.expressApp?.use).toHaveBeenNthCalledWith(2, '/mcp', expect.any(Function));
		expect(runtime.expressApp?.listen).toHaveBeenCalledWith(expect.any(Number), expect.any(Function));
	});
});
