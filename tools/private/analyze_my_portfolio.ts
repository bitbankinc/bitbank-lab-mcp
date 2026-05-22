/**
 * analyze_my_portfolio — ポートフォリオ分析ツール（Phase 3 + Phase 4 拡張）。
 *
 * 保有資産・約定履歴・入出金履歴・テクニカル分析を統合し、
 * 損益状況とポートフォリオ全体の評価を LLM に提供する。
 * 入出金データがあれば口座全体のリターンを概算する。
 */

import { toStructured } from '../../lib/result.js';
import analyzeMyPortfolioHandler from '../../src/handlers/analyzeMyPortfolioHandler.js';
import { AnalyzeMyPortfolioInputSchema } from '../../src/private/schemas.js';
import type { ToolDefinition } from '../../src/tool-definition.js';

// ── MCP ツール定義（tool-registry から自動収集） ──
export const toolDef: ToolDefinition = {
	name: 'analyze_my_portfolio',
	description:
		'[Portfolio Analysis / PnL] 自分のポートフォリオ分析（portfolio / pnl / balance / return）。保有資産の評価損益・実現損益・口座リターンを一括算出。テクニカル分析統合オプション付き。Private API（要APIキー設定）。',
	inputSchema: AnalyzeMyPortfolioInputSchema,
	handler: async (args: {
		include_technical?: boolean;
		include_pnl?: boolean;
		include_deposit_withdrawal?: boolean;
	}) => {
		const result = await analyzeMyPortfolioHandler(args);
		if (!result.ok) return result;
		// LLM は structuredContent を参照できないため、グラフ用の時系列配列を content に含める
		const text = `${result.summary}\n${JSON.stringify(result.data, null, 2)}`;
		return {
			content: [{ type: 'text', text }],
			structuredContent: toStructured(result),
		};
	},
};
