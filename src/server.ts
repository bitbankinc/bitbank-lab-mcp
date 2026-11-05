import './env.js'; // must be first — loads .env before other modules read process.env
import { createRequire } from 'node:module';
import { isInputRequiredResult, McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { z } from 'zod';
import { toPublicError } from '../lib/error.js';
import { logError, logToolRun } from '../lib/logger.js';
import { CONFIRMATION_META_KEY } from './mcp-apps-meta.js';
import { requestStateCodec } from './private/request-state.js';
import { type PromptDef, prompts as promptDefs } from './prompts.js';
import { appResourceRegistry } from './resources/app-resources.js';
import { allToolDefs } from './tool-registry.js';
import { storeUiSnapshot } from './ui-snapshot-cache.js';

// serverInfo.version は package.json を単一ソースにする。package.json は publish 対象に含まれるので npm 経由の起動でも解決できる。
const { version: packageVersion } = createRequire(import.meta.url)('../package.json') as {
	version: string;
};

const server = new McpServer(
	{ name: 'bitbank-mcp', version: packageVersion },
	{
		// requestState の HMAC / 有効期限 / bind（method・session・principal）はハンドラ実行前にここで検証され、失敗時は SDK が wire レベルの -32602 を返す。
		requestState: {
			verify: (state, ctx) => requestStateCodec.verify(state, ctx),
		},
	},
);

type TextContent = { type: 'text'; text: string; _meta?: Record<string, unknown> };
type ToolReturn = {
	content: TextContent[];
	structuredContent?: Record<string, unknown>;
	_meta?: Record<string, unknown>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** respond() の 2 つのフォールバック（result の JSON 化 / result 自体の structuredContent 化）から結果レベル `_meta` を落とし、確認トークンを LLM 可視チャネルへ出さない。現行ハンドラはどちらにも入らないが、caller convention に頼らない防御として残す（ADR-0007）。 */
function withoutResultMeta(value: Record<string, unknown>): Record<string, unknown> {
	if (!('_meta' in value)) return value;
	const { _meta: _omitted, ...rest } = value;
	return rest;
}

const respond = (result: unknown): ToolReturn => {
	let text = '';
	if (isPlainObject(result)) {
		const r = result;
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
		if (!text && typeof r.summary === 'string') {
			text = r.summary;
		}
	}
	if (!text) {
		try {
			const json = JSON.stringify(
				isPlainObject(result) ? withoutResultMeta(result) : result,
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
	// handler が McpResponse shape を返したら内側の structuredContent をそのまま採用する。MCP Apps の iframe は structuredContent を直接参照するので、二重に包むと Result を取り出せない。
	const structured = isPlainObject(result)
		? isPlainObject(result.structuredContent)
			? result.structuredContent
			: withoutResultMeta(result)
		: undefined;
	// 結果レベル `_meta` は明示的に組み立てたハンドラのものだけを透過する。Result shape の `meta` はこれとは別物なので拾わない。
	const resultMeta = isPlainObject(result) && isPlainObject(result._meta) ? result._meta : undefined;
	return {
		content: [{ type: 'text', text }],
		...(structured ? { structuredContent: structured } : {}),
		...(resultMeta ? { _meta: resultMeta } : {}),
	};
};

function storeSnapshotIfUiTool(
	meta: Record<string, unknown> | undefined,
	response: ToolReturn,
	ctx?: Record<string, unknown>,
): void {
	const resourceUri = (meta as { ui?: { resourceUri?: unknown } } | undefined)?.ui?.resourceUri;
	if (typeof resourceUri === 'string' && response.structuredContent) {
		// 確認トークンを含む `_meta` はその expires_at を専用の期限として渡し、スナップショット TTL より先に落とす。
		const confirmation = (response._meta?.[CONFIRMATION_META_KEY] as { expires_at?: unknown } | undefined)?.expires_at;
		storeUiSnapshot(
			resourceUri,
			response.structuredContent,
			{ sessionId: (ctx as { sessionId?: string } | undefined)?.sessionId },
			response._meta,
			typeof confirmation === 'number' ? confirmation : undefined,
		);
	}
}

const TOOL_TIMEOUT_MS = 60_000;

function registerToolWithLog(
	name: string,
	schema: { description: string; inputSchema: z.ZodTypeAny; _meta?: Record<string, unknown> },
	handler: (input: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<unknown>,
) {
	// SDK v2 は Zod スキーマ全体（`.refine()` 等を含む）でハンドラ実行前に入力を検証する。型定義が generics に厳密なので、キャストはここに集約する。
	const toolConfig: Record<string, unknown> = {
		description: schema.description,
		inputSchema: schema.inputSchema,
	};
	if (schema._meta) toolConfig._meta = schema._meta;
	(server as unknown as { registerTool: (n: string, s: unknown, h: unknown) => void }).registerTool(
		name,
		toolConfig,
		async (input: Record<string, unknown>, ctx?: Record<string, unknown>) => {
			const t0 = Date.now();
			try {
				let timeoutId: ReturnType<typeof setTimeout> | undefined;
				const timeoutPromise = new Promise<never>((_, reject) => {
					timeoutId = setTimeout(
						() => reject(new Error(`ツール実行がタイムアウトしました (${TOOL_TIMEOUT_MS / 1000}秒)`)),
						TOOL_TIMEOUT_MS,
					);
				});
				// 内部 Server インスタンスを合流させるのは、2025 系接続の client capabilities 判定（getClientCapabilities）に使うため。
				const handlerExtra = { ...ctx, server: server.server };
				const result = await Promise.race([handler(input ?? {}, handlerExtra), timeoutPromise]).finally(() => {
					if (timeoutId) clearTimeout(timeoutId);
				});
				const ms = Date.now() - t0;
				// input_required は respond() で包むと resultType が失われ、クライアントが確認要求を受け取れなくなるので、SDK にそのまま渡す。
				if (isInputRequiredResult(result)) {
					logToolRun({ tool: name, input, result: { ok: true, summary: '[MRTR] input_required round' }, ms });
					return result;
				}
				logToolRun({ tool: name, input, result, ms });
				const response = respond(result);
				storeSnapshotIfUiTool(schema._meta, response, ctx);
				return response;
			} catch (err: unknown) {
				const ms = Date.now() - t0;
				// ログには元のエラー詳細を残し、応答層は toPublicError で正規化する。
				logError(name, err, input);
				const publicErr = toPublicError(err);
				const errorResponse: ToolReturn = {
					content: [{ type: 'text', text: publicErr.summary }],
					structuredContent: {
						ok: false,
						summary: publicErr.summary,
						meta: { ms, errorType: publicErr.errorType },
					},
				};
				// エラー応答も ontoolresult で配信されるはずの内容なので、同様にスナップショットへ残す（UI 側は ok:false をエラー表示として扱う）。
				storeSnapshotIfUiTool(schema._meta, errorResponse, ctx);
				return errorResponse;
			}
		},
	);
}

for (const def of allToolDefs) {
	registerToolWithLog(
		def.name,
		{ description: def.description, inputSchema: def.inputSchema, ...(def._meta ? { _meta: def._meta } : {}) },
		def.handler,
	);
}

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

// SDK の registerPrompt は argsSchema の generics に厳密なので、引数なしプロンプトの登録はキャストを集約して行う。
for (const p of promptDefs) {
	(server as unknown as { registerPrompt: (n: string, c: unknown, cb: unknown) => void }).registerPrompt(
		p.name,
		{ description: p.description },
		() => ({
			description: p.description,
			messages: toSdkMessages(p.messages),
		}),
	);
}

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

const transport = new StdioServerTransport();
await server.connect(transport);
