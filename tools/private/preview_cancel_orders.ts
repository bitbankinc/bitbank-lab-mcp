/**
 * preview_cancel_orders — 一括キャンセルのプレビューと確認トークン発行。
 *
 * キャンセル対象の注文ID一覧を表示し、cancel_orders に渡す確認トークンを発行する。
 * 実際のキャンセルは行わない。
 *
 * elicitation 対応ホストでは preview → ユーザー確認 → cancel_orders までを
 * このハンドラ内で完結させる。非対応ホストでは従来通り structuredContent
 * 経由でトークンを渡しフォールバックする（Progressive Enhancement）。
 */

import { formatPair } from '../../lib/formatter.js';
import { ok, toStructured } from '../../lib/result.js';
import { generateToken } from '../../src/private/confirmation.js';
import { PreviewCancelOrdersInputSchema, PreviewCancelOrdersOutputSchema } from '../../src/private/schemas.js';
import type { ToolDefinition, ToolHandlerExtra } from '../../src/tool-definition.js';
import cancelOrders from './cancel_orders.js';

export default function previewCancelOrders(args: { pair: string; order_ids: number[] }) {
	const { pair, order_ids } = args;

	const tokenParams = { pair, order_ids };
	const { token, expiresAt } = generateToken('cancel_orders', tokenParams);

	const lines: string[] = [];
	lines.push(`📋 一括キャンセルプレビュー: ${formatPair(pair)} ${order_ids.length}件`);
	for (const id of order_ids) {
		lines.push(`  注文ID: ${id}`);
	}
	lines.push('');
	lines.push('⚠️ この一括キャンセルはユーザーの最終確認（ホスト UI または elicitation）を経るまで実行されません。');

	const summary = lines.join('\n');

	return PreviewCancelOrdersOutputSchema.parse(
		ok(
			summary,
			{ confirmation_token: token, expires_at: expiresAt, preview: { pair, order_ids } },
			{ action: 'cancel_orders' as const },
		),
	);
}

/** クライアントが elicitation/create に対応しているかを判定する。 */
function clientSupportsElicitation(extra: ToolHandlerExtra | undefined): boolean {
	const server = (extra as { server?: { getClientCapabilities?: () => unknown } } | undefined)?.server;
	const caps = typeof server?.getClientCapabilities === 'function' ? server.getClientCapabilities() : undefined;
	const elicitation = (caps as { elicitation?: unknown } | undefined)?.elicitation;
	return Boolean(elicitation);
}

/** SDK の elicitInput を呼び出すための最小限の interface */
interface ElicitCapableServer {
	elicitInput: (params: {
		message: string;
		requestedSchema: Record<string, unknown>;
	}) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }>;
}

export const toolDef: ToolDefinition = {
	name: 'preview_cancel_orders',
	description: [
		'[Preview Cancel Orders] 一括キャンセルのプレビューと確認トークン発行。実際のキャンセルは行わない。Private API。',
		'cancel_orders を実行するには、まずこのツールで確認トークンを取得する必要がある。',
		'⚠️ confirmation_token は LLM 可視テキストには含めない。ホスト UI または elicitation のユーザー確認を経て cancel_orders が呼ばれる前提。LLM が独断でトークンを引用して cancel_orders を呼ぶと意図しないキャンセルになり得る。',
	].join(' '),
	inputSchema: PreviewCancelOrdersInputSchema,
	// MCP Apps (SEP-1865): 対応ホストでは iframe 内にキャンセル確認 UI を表示する。
	// 非対応ホストでは無視され、従来のテキスト確認フローがそのまま動作する（Progressive Enhancement）。
	_meta: {
		ui: {
			resourceUri: 'ui://cancel/confirm.html',
		},
	},
	handler: async (args, extra) => {
		const typedArgs = args as { pair: string; order_ids: number[] };
		const result = previewCancelOrders(typedArgs);
		if (!result.ok) return result;

		// elicitation 対応ホストでは preview → ユーザー確認 → cancel_orders までを
		// このハンドラ内で完結させる。
		if (clientSupportsElicitation(extra)) {
			const server = (extra as { server?: ElicitCapableServer } | undefined)?.server;
			if (server && typeof server.elicitInput === 'function') {
				try {
					const elicit = await server.elicitInput({
						message: result.summary,
						requestedSchema: {
							type: 'object',
							properties: {
								confirmed: {
									type: 'boolean',
									title: `これら ${typedArgs.order_ids.length} 件の注文を一括キャンセルする`,
								},
							},
							required: ['confirmed'],
						},
					});
					if (elicit.action !== 'accept' || !elicit.content?.confirmed) {
						return {
							content: [{ type: 'text', text: 'ユーザーが一括キャンセル操作を取り消しました（elicitation）' }],
							structuredContent: toStructured(result),
						};
					}
					// 内部的に cancel_orders を実行。監査ログには route='elicitation' で記録される。
					const cancelResult = await cancelOrders(
						{
							...typedArgs,
							confirmation_token: result.data.confirmation_token,
							token_expires_at: result.data.expires_at,
						},
						'elicitation',
					);
					const cancelText = cancelResult.ok ? cancelResult.summary : `Error: ${cancelResult.summary}`;
					return {
						content: [{ type: 'text', text: cancelText }],
						structuredContent: toStructured(cancelResult),
					};
				} catch {
					// elicitInput が想定外に失敗した場合はフォールバックに進む。
				}
			}
		}

		// フォールバック: confirmation_token は LLM 可視テキストには含めない。
		const text = [
			result.summary,
			'',
			'※ confirmation_token はホスト UI / structuredContent 経由でのみ受け渡されます。',
			'  LLM はトークンを引用したり、ユーザー確認なしに cancel_orders を呼ばないでください。',
		].join('\n');
		return {
			content: [{ type: 'text', text }],
			structuredContent: toStructured(result),
		};
	},
};
