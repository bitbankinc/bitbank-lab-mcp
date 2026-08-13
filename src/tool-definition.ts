import type { InputRequiredResult } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { Result } from './schemas.js';

/** SVG 等を直接返すハンドラ用の事前フォーマット済み MCP レスポンス */
export interface McpResponse {
	content: Array<{ type: string; text: string }>;
	structuredContent: Record<string, unknown>;
	/**
	 * **ツール結果レベル**の `_meta`（`CallToolResult._meta`）。指定時は `server.ts` の
	 * `respond()` がそのまま応答へ透過する。
	 *
	 * ⚠️ `ToolDefinition._meta`（`registerTool` に渡すツール定義側のメタ。`ui.resourceUri` 等）
	 * とは**別物**。あちらは tools/list に載るツールの静的メタデータ、こちらは 1 回の
	 * tools/call の結果に付随するメタデータ。
	 *
	 * MCP Apps ホストはこれを iframe へ転送し、モデルコンテキストには入れない
	 * （ext-apps / OpenAI Apps SDK の双方で一致する慣習）。確認トークンの配送に使う。
	 * 保証ではなくホスト実装の観測された挙動に依存する点は ADR-0007 を参照。
	 */
	_meta?: Record<string, unknown>;
}

/**
 * ハンドラに渡される MCP リクエストコンテキスト。
 *
 * MRTR（input_required）/ elicitation 等でリクエスト文脈を参照するツール用。
 * SDK v2 の `ServerContext`（`mcpReq.inputResponses` / `mcpReq.requestState` 等）を
 * そのまま受け取れるよう構造的型で受ける。
 * `server` プロパティは server.ts 側で内部 `Server` を合流させて注入する。
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
	 * 第2引数 `extra` は MRTR / elicitation 等でリクエスト文脈にアクセスする必要があるツールのみ参照する。
	 * MRTR ラウンドでは `InputRequiredResult` を返してよい（server.ts が素通しする）。
	 */
	handler(args: Record<string, unknown>, extra?: ToolHandlerExtra): Promise<Result | McpResponse | InputRequiredResult>;
	/**
	 * MCP ツール メタデータ。MCP Apps (SEP-1865) の `_meta.ui.resourceUri` 等を保持する。
	 * 未対応ホストでは無視される（Progressive Enhancement）。
	 */
	_meta?: Record<string, unknown>;
}
