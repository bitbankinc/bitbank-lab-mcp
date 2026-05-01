import type { z } from 'zod';
import type { Result } from './schemas.js';

/** SVG 等を直接返すハンドラ用の事前フォーマット済み MCP レスポンス */
export interface McpResponse {
	content: Array<{ type: string; text: string }>;
	structuredContent: Record<string, unknown>;
}

/**
 * ハンドラに渡される MCP リクエストコンテキスト。
 *
 * elicitation/sampling 等のサーバー → クライアント呼び出しを行うツール用。
 * SDK の `RequestHandlerExtra` をそのまま受け取れるよう構造的型で受ける。
 * `server` プロパティは server.ts 側で `McpServer` を合流させて注入する。
 */
export interface ToolHandlerExtra {
	[key: string]: unknown;
}

/**
 * MCP ツール定義。各ツールファイル（または src/handlers/）で `toolDef` として export する。
 * server.ts は tool-registry.ts 経由でこの定義を自動収集し registerToolWithLog に渡す。
 *
 * ツール追加/改修時は toolDef を更新するだけで server.ts の変更は不要。
 */
export interface ToolDefinition {
	/** MCP ツール名 (e.g. 'get_ticker') */
	name: string;
	/** ツール説明（LLM 向け） */
	description: string;
	/** Zod 入力スキーマ */
	inputSchema: z.ZodTypeAny;
	/**
	 * MCP ハンドラ（入力を受けて結果を返す）。respond() で自動ラップされる。
	 * 第2引数 `extra` は elicitation 等で SDK のサーバー機能にアクセスする必要があるツールのみ参照する。
	 */
	handler(args: Record<string, unknown>, extra?: ToolHandlerExtra): Promise<Result | McpResponse>;
	/**
	 * MCP ツール メタデータ。MCP Apps (SEP-1865) の `_meta.ui.resourceUri` 等を保持する。
	 * 未対応ホストでは無視される（Progressive Enhancement）。
	 */
	_meta?: Record<string, unknown>;
}
