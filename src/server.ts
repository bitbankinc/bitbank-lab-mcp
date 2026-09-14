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

// serverInfo.version は package.json を単一ソースとする。
// ハードコードすると package.json 側のリリースに追従せず drift する（実際に 0.4.2 のまま取り残されていた）。
// package.json は publish 対象（package.json の files）に含まれるため npm 経由の起動でも解決できる。
const { version: packageVersion } = createRequire(import.meta.url)('../package.json') as {
	version: string;
};

const server = new McpServer(
	{ name: 'bitbank-mcp', version: packageVersion },
	{
		// MRTR (SEP-2322) の requestState 検証。HMAC / 有効期限 / bind（method・session・
		// principal）の検証をハンドラ実行前に行い、失敗時は SDK が wire レベルの
		// -32602（Invalid or expired requestState）を返す。
		// codec の詳細と payload の文脈バインド検証は src/private/request-state.ts /
		// src/private/elicitation.ts を参照。
		requestState: {
			verify: (state, ctx) => requestStateCodec.verify(state, ctx),
		},
	},
);

type TextContent = { type: 'text'; text: string; _meta?: Record<string, unknown> };
type ToolReturn = {
	content: TextContent[];
	structuredContent?: Record<string, unknown>;
	/** ツール結果レベルの `_meta`（`CallToolResult._meta`）。詳細は McpResponse['_meta'] を参照。 */
	_meta?: Record<string, unknown>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `content` / `structuredContent` のフォールバックに使う、**結果レベル `_meta` を除いた**ビュー。
 *
 * `_meta` は confirmation token を載せる唯一のチャネル（ADR-0007）で、`content[0].text` は
 * **LLM が読む唯一のチャネル**。`respond()` には result 全体を丸ごと流し込むフォールバックが
 * 2 つあり、`_meta` を含めたままだとトークンがそこから LLM 可視チャネルへ出る:
 *
 *   1. `content` も `summary` も取れない → `JSON.stringify(result)` を `content` に入れる
 *   2. `structuredContent` が plain object でない → result 自体を `structuredContent` にする
 *      （ADR-0007 は `structuredContent` へのトークン露出を明確に禁じている）
 *
 * 現行ハンドラはどちらの分岐にも入らない（`content` に非空テキストを必ず付け、
 * `structuredContent` は Result 形のオブジェクトを返す）が、**ここは将来のハンドラが黙って
 * 踏む構造的な罠**なので、caller convention に頼らずフォールバック側で落とす
 * （`stripConfirmationTokenFields` と同じ多層防御の考え方）。
 *
 * 結果レベル `_meta` そのものは下の `resultMeta` で従来どおり透過するので、
 * iframe へのトークン配送は壊れない。
 */
function withoutResultMeta(value: Record<string, unknown>): Record<string, unknown> {
	if (!('_meta' in value)) return value;
	const { _meta: _omitted, ...rest } = value;
	return rest;
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
	// それでも空の場合は安全な短縮JSONにフォールバック（結果レベル `_meta` は含めない）
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
	// handler が McpResponse shape (`{ content, structuredContent: Result }`) を返している場合、
	// 内側の structuredContent をそのまま採用する（二重ネストを防ぐ）。
	// MCP Apps (SEP-1865) の iframe は `structuredContent` を直接参照するため、
	// `{ structuredContent: { content, structuredContent: Result } }` のように包んでしまうと
	// クライアント側で Result を取り出せない。
	// Result shape (`{ ok, summary, data, meta }`) を直接返している場合は result 自体を採用する。
	const structured = isPlainObject(result)
		? isPlainObject(result.structuredContent)
			? result.structuredContent
			: withoutResultMeta(result)
		: undefined;
	// ハンドラが McpResponse shape で結果レベル `_meta` を返している場合はそのまま透過する。
	// `CallToolResult` は `ResultSchema = z.looseObject({ _meta: … })` を extend しており、
	// 結果レベル `_meta` は仕様上の正規フィールドなので SDK は素通しする。
	// MCP Apps ホストはこれを iframe へ転送し、モデルコンテキストには入れない。
	//
	// Result shape（`{ ok, summary, data, meta }`）を直接返しているツールの `meta` は
	// **これとは別物**なので拾わない（`structuredContent` 側に入る）。`_meta` を明示的に
	// 組み立てたハンドラだけが対象。
	const resultMeta = isPlainObject(result) && isPlainObject(result._meta) ? result._meta : undefined;
	return {
		content: [{ type: 'text', text }],
		...(structured ? { structuredContent: structured } : {}),
		...(resultMeta ? { _meta: resultMeta } : {}),
	};
};

/**
 * `_meta.ui.resourceUri` を持つツール（MCP Apps 連携ツール）の応答を
 * UI スナップショットとして保持する。一部ホストで `ui/notifications/tool-result` が
 * iframe に配信されない場合の pull 型 hydration（get_ui_snapshot）に使う。
 * スナップショットは sessionId + resourceUri をキーに保持する（stdio では sessionId undefined）。
 */
function storeSnapshotIfUiTool(
	meta: Record<string, unknown> | undefined,
	response: ToolReturn,
	ctx?: Record<string, unknown>,
): void {
	const resourceUri = (meta as { ui?: { resourceUri?: unknown } } | undefined)?.ui?.resourceUri;
	if (typeof resourceUri === 'string' && response.structuredContent) {
		// 結果レベル `_meta` も一緒に保持する。確認トークンを含む場合はその `expires_at` を
		// `_meta` 専用の期限として渡し、スナップショット TTL（5 分）より先に落ちるようにする。
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

function registerToolWithLog(
	name: string,
	schema: { description: string; inputSchema: z.ZodTypeAny; _meta?: Record<string, unknown> },
	handler: (input: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<unknown>,
) {
	// SDK v2 は Standard Schema（Zod v4 オブジェクト）を inputSchema として直接受け、
	// `.refine()` / `.superRefine()` 等のクロスフィールド制約も含めた完全なスキーマで
	// ハンドラ実行前に入力検証する（v1 時代の raw shape 抽出 + 二重 parse は不要になった）。
	// 型定義は Zod スキーマの generics に厳密なため、ここでキャストを集約する。
	const toolConfig: Record<string, unknown> = {
		description: schema.description,
		inputSchema: schema.inputSchema,
	};
	if (schema._meta) toolConfig._meta = schema._meta;
	(server as unknown as { registerTool: (n: string, s: unknown, h: unknown) => void }).registerTool(
		name,
		toolConfig,
		async (input: Record<string, unknown>, ctx?: Record<string, unknown>) => {
			const TOOL_TIMEOUT_MS = 60_000;
			const t0 = Date.now();
			try {
				let timeoutId: ReturnType<typeof setTimeout> | undefined;
				const timeoutPromise = new Promise<never>((_, reject) => {
					timeoutId = setTimeout(
						() => reject(new Error(`ツール実行がタイムアウトしました (${TOOL_TIMEOUT_MS / 1000}秒)`)),
						TOOL_TIMEOUT_MS,
					);
				});
				// MRTR / elicitation を使うツール向けに、SDK の ServerContext
				// （mcpReq.inputResponses / mcpReq.requestState 等）へ内部 Server インスタンスを
				// 合流させて渡す。server は 2025 系接続の client capabilities 判定
				// （getClientCapabilities）に使う。
				const handlerExtra = { ...ctx, server: server.server };
				const result = await Promise.race([handler(input ?? {}, handlerExtra), timeoutPromise]).finally(() => {
					if (timeoutId) clearTimeout(timeoutId);
				});
				const ms = Date.now() - t0;
				// MRTR ラウンド（input_required）は SDK にそのまま渡す。respond() で包むと
				// resultType が失われ、クライアントが確認要求を受け取れなくなる。
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
				// エラー応答も ontoolresult で配信されるはずの内容なので、同様にスナップショットへ残す
				// （UI 側は preview 未受領時の ok:false をエラー表示として扱う）。
				storeSnapshotIfUiTool(schema._meta, errorResponse, ctx);
				return errorResponse;
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

// === Register prompts ===

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

// SDK の registerPrompt は argsSchema の generics に厳密なため、引数なしプロンプトの
// 登録はキャストを集約して行う。prompts/list・prompts/get のルーティングは SDK が担う。
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

// === Register MCP Apps UI resources ===
// SDK の `registerResource` を使うことで `resources/list` と `resources/read` の
// JSON-RPC ルーティングが SDK 内部で正しく行われる。
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
