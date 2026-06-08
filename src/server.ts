import './env.js'; // must be first — loads .env before other modules read process.env
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getErrorMessage, toPublicError } from '../lib/error.js';
import { logError, logToolRun } from '../lib/logger.js';
import { type PromptDef, prompts as promptDefs } from './prompts.js';
import { appResourceRegistry } from './resources/app-resources.js';
import { allToolDefs } from './tool-registry.js';

const server = new McpServer({ name: 'bitbank-mcp', version: '0.4.2' });
// Explicit registries for tools/prompts to improve STDIO inspector compatibility
const registeredTools: Array<{
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	_meta?: Record<string, unknown>;
}> = [];
const registeredPrompts: Array<{ name: string; description: string }> = [];

type TextContent = { type: 'text'; text: string; _meta?: Record<string, unknown> };
type ToolReturn = { content: TextContent[]; structuredContent?: Record<string, unknown> };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const respond = (result: unknown): ToolReturn => {
	// 優先順位: custom content > summary > safe JSON fallback
	let text = '';
	if (isPlainObject(result)) {
		const r = result;
		// ツールが content を提供している場合（配列 or 文字列）を優先
		if (Array.isArray(r.content)) {
			const first = (r.content as unknown[]).find(
				(c): c is { type: 'text'; text: string } => isPlainObject(c) && c.type === 'text' && typeof c.text === 'string',
			);
			if (first) {
				text = first.text;
			}
		} else if (typeof r.content === 'string') {
			text = r.content;
		}
		// 上記で未決定なら summary を採用
		if (!text && typeof r.summary === 'string') {
			text = r.summary;
		}
	}
	// それでも空の場合は安全な短縮JSONにフォールバック
	if (!text) {
		try {
			const json = JSON.stringify(
				result,
				(_key, value) => {
					if (typeof value === 'string' && value.length > 2000) return `…omitted (${value.length} chars)`;
					return value;
				},
				2,
			);
			text = json.length > 4000 ? `${json.slice(0, 4000)}\n…(truncated)…` : json;
		} catch {
			text = String(result);
		}
	}
	// handler が McpResponse shape (`{ content, structuredContent: Result }`) を返している場合、
	// 内側の structuredContent をそのまま採用する（二重ネストを防ぐ）。
	// MCP Apps (SEP-1865) の iframe は `structuredContent` を直接参照するため、
	// `{ structuredContent: { content, structuredContent: Result } }` のように包んでしまうと
	// クライアント側で Result を取り出せない。
	// Result shape (`{ ok, summary, data, meta }`) を直接返している場合は result 自体を採用する。
	const structured = isPlainObject(result)
		? isPlainObject(result.structuredContent)
			? result.structuredContent
			: result
		: undefined;
	return {
		content: [{ type: 'text', text }],
		...(structured ? { structuredContent: structured } : {}),
	};
};

/** Zod スキーマ → MCP inspector 用 JSON Schema に変換する。
 *  Zod 4 組み込みの toJSONSchema を使い、MCP 不要の additionalProperties を除去する。 */
function zodToInputJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
	const json = z.toJSONSchema(schema, { target: 'openApi3' }) as Record<string, unknown>;
	delete json.additionalProperties;
	// default 付きフィールドは required から除外（Zod が parse 時に適用するため MCP 入力では不要）
	const props = json.properties as Record<string, Record<string, unknown>> | undefined;
	if (Array.isArray(json.required) && props) {
		json.required = (json.required as string[]).filter((k) => !('default' in (props[k] ?? {})));
		if ((json.required as string[]).length === 0) delete json.required;
	}
	return json;
}

/** SDK の registerTool に渡すための ZodRawShape を取得する。
 *  .describe() / .default() / .optional() 等のラッパーを再帰的にアンラップする。 */
function getRawShape(s: z.ZodTypeAny): z.ZodRawShape {
	type Unwrappable = {
		shape?: z.ZodRawShape;
		_def?: { schema?: z.ZodTypeAny; innerType?: z.ZodTypeAny; in?: z.ZodTypeAny };
	};
	let cur = s as Unwrappable;
	for (let i = 0; i < 6; i++) {
		if (cur.shape) break;
		const def = cur._def;
		if (!def) break;
		// Zod 3: ZodEffects uses _def.schema / Zod 4: uses _def.in
		if (def.schema) {
			cur = def.schema as Unwrappable;
			continue;
		}
		if (def.in) {
			cur = def.in as Unwrappable;
			continue;
		}
		if (def.innerType) {
			cur = def.innerType as Unwrappable;
			continue;
		}
		break;
	}
	if (cur.shape) return cur.shape;
	throw new Error('inputSchema must be or wrap a ZodObject');
}

function registerToolWithLog(
	name: string,
	schema: { description: string; inputSchema: z.ZodTypeAny; _meta?: Record<string, unknown> },
	handler: (input: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<unknown>,
) {
	// Build JSON Schema for listing
	const inputSchemaJson = zodToInputJsonSchema(schema.inputSchema);
	registeredTools.push({
		name,
		description: schema.description,
		inputSchema: inputSchemaJson,
		...(schema._meta ? { _meta: schema._meta } : {}),
	});

	// SDK の registerTool は第2引数に { inputSchema: ZodRawShape } を要求するが
	// 型定義が厳密すぎて直接渡せないため、ここでキャストを集約する
	const toolConfig: Record<string, unknown> = {
		description: schema.description,
		inputSchema: getRawShape(schema.inputSchema),
	};
	if (schema._meta) toolConfig._meta = schema._meta;
	(server as unknown as { registerTool: (n: string, s: unknown, h: unknown) => void }).registerTool(
		name,
		toolConfig,
		async (input: Record<string, unknown>, extra?: Record<string, unknown>) => {
			const TOOL_TIMEOUT_MS = 60_000;
			const t0 = Date.now();
			try {
				// 入力を完全な inputSchema で検証する（defense-in-depth）。
				// SDK には getRawShape() で抽出した shape のみ渡しているため、
				// .refine() / .superRefine() 等のクロスフィールド制約は MCP 経由では失われ得る。
				// また各 handler は `args as ...` で cast しており明示 parse をしないため、
				// ここで本来のスキーマを通して取りこぼし・将来の登録経路変更に備える。
				// ZodError は下の catch で toPublicError により 'validation_error' に正規化され、
				// 入力断片やローカルパスは応答に露出しない。
				schema.inputSchema.parse(input ?? {});
				let timeoutId: ReturnType<typeof setTimeout> | undefined;
				const timeoutPromise = new Promise<never>((_, reject) => {
					timeoutId = setTimeout(
						() => reject(new Error(`ツール実行がタイムアウトしました (${TOOL_TIMEOUT_MS / 1000}秒)`)),
						TOOL_TIMEOUT_MS,
					);
				});
				// elicitation 等で server.elicitInput / getClientCapabilities を使うツール向けに、
				// SDK の RequestHandlerExtra に内部 Server インスタンスを合流させる。
				// （elicitInput / getClientCapabilities は McpServer 直下ではなく
				// McpServer.server (= 内部 Server) 上にあるため、wrapper ではなく中身を渡す）
				const handlerExtra = { ...extra, server: server.server };
				const result = await Promise.race([handler(input, handlerExtra), timeoutPromise]).finally(() => {
					if (timeoutId) clearTimeout(timeoutId);
				});
				const ms = Date.now() - t0;
				logToolRun({ tool: name, input, result, ms });
				return respond(result);
			} catch (err: unknown) {
				const ms = Date.now() - t0;
				// ログには元のエラー詳細を残し、応答層は toPublicError で正規化する。
				logError(name, err, input);
				const publicErr = toPublicError(err);
				return {
					content: [{ type: 'text', text: publicErr.summary }],
					structuredContent: {
						ok: false,
						summary: publicErr.summary,
						meta: { ms, errorType: publicErr.errorType },
					},
				};
			}
		},
	);
}

// === Auto-register all tools from registry ===
for (const def of allToolDefs) {
	registerToolWithLog(
		def.name,
		{ description: def.description, inputSchema: def.inputSchema, ...(def._meta ? { _meta: def._meta } : {}) },
		def.handler,
	);
}

// === Register prompts (SDK 形式に寄せた最小導入) ===

type PromptMessage = PromptDef['messages'][number];
type ContentBlock = PromptMessage['content'][number];

function toSdkMessages(msgs: PromptMessage[]) {
	return msgs.map((msg) => {
		const blocks: ContentBlock[] = Array.isArray(msg.content) ? msg.content : [];
		const text = blocks
			.map((b) => {
				if (b.type === 'text' && typeof b.text === 'string') return b.text;
				// tool_code ブロック: PromptDef の型定義外だが実データに存在する
				if (b.type === 'tool_code') {
					const tc = b as unknown as { tool_name?: string; tool_input?: unknown };
					const tool = tc.tool_name || 'tool';
					const args = tc.tool_input ? JSON.stringify(tc.tool_input) : '{}';
					return `Call ${tool} with ${args}`;
				}
				return '';
			})
			.filter(Boolean)
			.join('\n');
		return {
			role: msg.role === 'assistant' ? ('assistant' as const) : ('user' as const),
			content: { type: 'text' as const, text },
		};
	});
}

function registerPromptSafe(name: string, def: Pick<PromptDef, 'description' | 'messages'>) {
	const s = server as unknown as {
		registerPrompt?: (name: string, meta: { description: string }, cb: () => unknown) => void;
	};
	if (typeof s.registerPrompt === 'function') {
		registeredPrompts.push({ name, description: def.description });
		s.registerPrompt(name, { description: def.description }, () => ({
			description: def.description,
			messages: toSdkMessages(def.messages),
		}));
	}
}

// === Register prompts from src/prompts.ts ===
for (const p of promptDefs) {
	registerPromptSafe(p.name, p);
}

// === Register MCP Apps UI resources ===
// SDK の `registerResource` を使うことで `resources/list` と `resources/read` の
// JSON-RPC ルーティングが SDK 内部で正しく行われる。
// （以前の `setHandler('resources/...')` は SDK が要求する Zod スキーマではなく
//  文字列を渡していたため silently no-op となり、本番で `Method not found` を返していた）
for (const r of appResourceRegistry) {
	const config: Record<string, unknown> = {
		description: r.description,
		mimeType: r.mimeType,
		...(r.listMeta ? { _meta: r.listMeta } : {}),
	};
	(
		server as unknown as {
			registerResource: (
				name: string,
				uri: string,
				config: Record<string, unknown>,
				cb: (uri: URL) => Promise<unknown> | unknown,
			) => void;
		}
	).registerResource(r.name, r.uri, config, async () => ({
		contents: [
			{
				uri: r.uri,
				mimeType: r.mimeType,
				text: await r.read(),
				...(r.contentMeta ? { _meta: r.contentMeta } : {}),
			},
		],
	}));
}

// === トランスポート接続 ===
const transport = new StdioServerTransport();
await server.connect(transport);

// SDK の McpServer は setRequestHandler を public 型として export していないため、
// 低レベル API アクセスのキャストをこのヘルパーに集約する。
type HandlerFn = (request: unknown) => Promise<unknown>;
function setHandler(method: string, fn: HandlerFn) {
	(server as unknown as { setRequestHandler?: (method: string, fn: HandlerFn) => void }).setRequestHandler?.(
		method,
		fn,
	);
}

// Fallback handlers to ensure list operations work over STDIO
try {
	setHandler('tools/list', async () => ({
		tools: registeredTools.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
			...(t._meta ? { _meta: t._meta } : {}),
		})),
	}));
	setHandler('prompts/list', async () => ({
		prompts: registeredPrompts.map((p) => ({ name: p.name, description: p.description })),
	}));
	// prompts/get: convert content arrays to single TextContent objects per MCP spec
	setHandler('prompts/get', async (request: unknown) => {
		try {
			const params = (request as { params?: { name?: string } })?.params;
			const name = params?.name;
			console.error('[prompts/get] Requested name:', name);
			if (!name) {
				throw new Error('Prompt name is required');
			}

			const promptDef = promptDefs.find((p) => p.name === name);
			if (!promptDef) {
				console.error('[prompts/get] ERROR: Prompt not found:', name);
				throw new Error(`Prompt not found: ${name}`);
			}

			console.error('[prompts/get] Found prompt:', name, 'with', promptDef.messages.length, 'messages');
			// prompts/get はテキストブロックのみ抽出（tool_code は除外）
			const messages = promptDef.messages.map((msg) => {
				const blocks: ContentBlock[] = Array.isArray(msg.content) ? msg.content : [];
				const text = blocks
					.filter((b): b is ContentBlock & { text: string } => b.type === 'text' && typeof b.text === 'string')
					.map((b) => b.text)
					.join('\n');
				return {
					role: msg.role === 'assistant' ? ('assistant' as const) : ('user' as const),
					content: { type: 'text' as const, text },
				};
			});
			return { description: promptDef.description, messages };
		} catch (error: unknown) {
			console.error('[prompts/get] EXCEPTION:', getErrorMessage(error));
			throw error;
		}
	});
} catch {}
