/**
 * preview_cancel_orders — 一括キャンセルのプレビュー。
 *
 * キャンセル対象の注文ID一覧を表示する。実際のキャンセルは行わない。
 *
 * 内部的に confirmation_token も生成するが、これはサーバープロセス内に閉じる:
 *   - elicitation 対応ホスト: ハンドラ内の accept 経路で cancel_orders へ非公開のまま
 *     引き渡し、preview → ユーザー確認 → cancel_orders までを完結させる
 *   - elicitation 非対応ホスト: キャンセル実行は行わずプレビューのみ返し、token は
 *     クライアントに渡さない
 *
 * 詳細は docs/private-api.md「`confirmation_token` の受け渡し」節を参照。
 */

import { formatPair } from '../../lib/formatter.js';
import { ok, toStructured } from '../../lib/result.js';
import { generateToken } from '../../src/private/confirmation.js';
import { withElicitedConfirmation } from '../../src/private/elicitation.js';
import { PreviewCancelOrdersInputSchema, PreviewCancelOrdersOutputSchema } from '../../src/private/schemas.js';
import type { ToolDefinition } from '../../src/tool-definition.js';
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

export const toolDef: ToolDefinition = {
	name: 'preview_cancel_orders',
	description: [
		'[Preview Cancel Orders] 一括キャンセルのプレビュー。実際のキャンセルは行わない。Private API。',
		'⚠️ confirmation_token はクライアント側には返さない（content / structuredContent / _meta のいずれにも含めない）。',
		'実際のキャンセルは elicitation 対応ホストでのみ可能で、その場合はこのハンドラ内で preview → ユーザー確認 → cancel_orders までを完結させる。',
		'elicitation 非対応ホストではプレビュー内容のみ返し、キャンセル実行は受け付けない。',
	].join(' '),
	inputSchema: PreviewCancelOrdersInputSchema,
	// MCP Apps (SEP-1865): 対応ホストでは iframe 内にキャンセル確認 UI を表示する。
	// 非対応ホストでは無視される（Progressive Enhancement）。
	// 注: 本 PR 時点では UI 側からの cancel_orders 経路は未実装（pending action store と
	// UI origin 検証の安全設計を別 PR で整備するまで token を UI に渡さない）。
	_meta: {
		ui: {
			resourceUri: 'ui://cancel/confirm.html',
		},
	},
	handler: async (args, extra) => {
		const typedArgs = args as { pair: string; order_ids: number[] };
		const result = previewCancelOrders(typedArgs);
		if (!result.ok) return result;

		// elicitation 非対応ホスト向けのフォールバックレスポンス。
		// キャンセル実行はこのホストでは行えない旨を明示し、トークンの存在は仄めかさない。
		const fallbackText = [
			result.summary,
			'',
			'※ このホストでは取引実行に対応していません。',
			'  実際に一括キャンセルするには、elicitation 対応クライアント（Claude Desktop など）で同じ操作を実行してください。',
		].join('\n');

		// BITBANK_TRUST_HOST_APPROVAL=1 のときに使う妥協経路用のレスポンス。
		// 詳細は docs/adr/0002-hitl-confirmation-token-delivery.md。
		const trustHostFallbackText = [
			result.summary,
			'',
			'iframe の「キャンセルを確定する」ボタンを押して一括キャンセルを確定してください。',
			'ボタンを押さない限りキャンセルは行われません。',
		].join('\n');

		// elicitation 対応ホストでは preview → ユーザー確認 → cancel_orders までを
		// このハンドラ内で完結させる。confirmation_token / expires_at は
		// withElicitedConfirmation が structuredContent / declinedStructured / fallback
		// から必ず剥がすため caller 側で sanitize する必要はない（最終ガードは helper 側）。
		return withElicitedConfirmation({
			extra,
			summary: result.summary,
			confirmTitle: `これら ${typedArgs.order_ids.length} 件の注文を一括キャンセルする`,
			// 内部的に cancel_orders を実行。監査ログには route='elicitation' で記録される。
			// confirmation_token / expires_at は previewCancelOrders() が必ず生成するため non-null 断定して渡す。
			onConfirmed: () =>
				cancelOrders(
					{
						...typedArgs,
						confirmation_token: result.data.confirmation_token!,
						token_expires_at: result.data.expires_at!,
					},
					'elicitation',
				),
			onDeclinedText: 'ユーザーが一括キャンセル操作を取り消しました（elicitation）',
			declinedStructured: toStructured(result),
			fallback: {
				content: [{ type: 'text', text: fallbackText }],
				structuredContent: toStructured(result),
			},
			trustHostFallback: {
				content: [{ type: 'text', text: trustHostFallbackText }],
				structuredContent: toStructured(result),
			},
		});
	},
};
