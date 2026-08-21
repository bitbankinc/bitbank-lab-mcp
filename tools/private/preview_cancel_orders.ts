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
	lines.push('⚠️ この一括キャンセルはユーザーの最終確認（elicitation/MRTR）を経るまで実行されません。');

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
		'実際のキャンセルは elicitation/MRTR 対応ホスト上でのユーザー確認ダイアログ経由でのみ完結する。',
		'非対応ホストではプレビューのみ返し、キャンセル実行は受け付けない。ユーザーには elicitation/MRTR 対応クライアントでの操作を第一に案内し、bitbank アプリ/ウェブでのキャンセルは任意の代替手段として扱う。',
	].join(' '),
	inputSchema: PreviewCancelOrdersInputSchema,
	// MCP Apps (SEP-1865): 対応ホストでは iframe 内にキャンセルプレビュー UI を表示する。
	// 非対応ホストでは無視される（Progressive Enhancement）。
	// 注: iframe 起源の tools/call をサーバー側で識別できないため、UI からの
	// cancel_orders 実行経路は無効。execute は elicitation/MRTR のみ。
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
			'  実際に一括キャンセルするには、elicitation/MRTR 対応クライアントで同じ操作を行うか、bitbank アプリ/ウェブで該当注文をキャンセルしてください。',
		].join('\n');

		// elicitation 対応ホストでは preview → ユーザー確認 → cancel_orders までを
		// このハンドラ内で完結させる。confirmation_token / expires_at は
		// withElicitedConfirmation が structuredContent / declinedStructured / fallback
		// から必ず剥がすため caller 側で sanitize する必要はない（最終ガードは helper 側）。
		return withElicitedConfirmation({
			extra,
			action: 'cancel_orders',
			bindArgs: typedArgs as unknown as Record<string, unknown>,
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
					{ sessionId: (extra as { sessionId?: string } | undefined)?.sessionId },
				),
			onDeclinedText: 'ユーザーが一括キャンセル操作を取り消しました（elicitation）',
			declinedStructured: toStructured(result),
			fallback: {
				content: [{ type: 'text', text: fallbackText }],
				structuredContent: toStructured(result),
			},
		});
	},
};
