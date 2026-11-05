import type { InputRequiredResult } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { Result } from './schemas.js';

export interface McpResponse {
	content: Array<{ type: string; text: string }>;
	structuredContent: Record<string, unknown>;
	/** `ToolDefinition._meta`（tools/list に載る静的メタ）とは別物で、1 回の tools/call の結果に付くメタ。確認トークンの配送に使う。 */
	_meta?: Record<string, unknown>;
}

/** SDK v2 の ServerContext と、server.ts が合流させる内部 `server` をそのまま受け取れるよう構造的型で受ける。 */
export interface ToolHandlerExtra {
	[key: string]: unknown;
}

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: z.ZodTypeAny;
	handler(args: Record<string, unknown>, extra?: ToolHandlerExtra): Promise<Result | McpResponse | InputRequiredResult>;
	_meta?: Record<string, unknown>;
}
