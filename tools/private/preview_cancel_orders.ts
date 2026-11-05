import { formatPair } from '../../lib/formatter.js';
import { ok } from '../../lib/result.js';
import { confirmationTtlSeconds, generateToken } from '../../src/private/confirmation.js';
import { confirmPreview } from '../../src/private/preview-confirmation.js';
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
	lines.push('⚠️ この一括キャンセルはユーザーの最終確認を経るまで実行されません。');

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
		'⚠️ confirmation_token は content / structuredContent には決して含めない。LLM がトークンを読み取って cancel_orders を直接呼ぶことはできない。',
		'実際のキャンセルはユーザーの明示確認（対応ホストの確認ダイアログ、または確認カードのボタン操作）を経てのみ完結する。',
		'いずれにも対応しないホストではプレビューのみ返し、キャンセル実行は受け付けない。その場合は対応クライアントでの操作を第一に案内し、bitbank アプリ/ウェブでのキャンセルは任意の代替手段として扱う。',
		'このツールの応答を受け取った後、LLM が一括キャンセル完了を宣言してはならない。実行結果はユーザー確認後の応答で別途返る。',
	].join(' '),
	inputSchema: PreviewCancelOrdersInputSchema,
	_meta: {
		ui: {
			resourceUri: 'ui://cancel/confirm.html',
		},
	},
	handler: async (args, extra) => {
		const typedArgs = args as { pair: string; order_ids: number[] };
		const result = previewCancelOrders(typedArgs);
		if (!result.ok) return result;

		return confirmPreview({
			extra,
			action: 'cancel_orders',
			args: typedArgs,
			result,
			outputSchema: PreviewCancelOrdersOutputSchema,
			texts: {
				confirmTitle: `これら ${typedArgs.order_ids.length} 件の注文を一括キャンセルする`,
				declinedText: 'ユーザーが一括キャンセル操作を取り消しました（elicitation）',
				unsupportedHostGuide:
					'  実際に一括キャンセルするには、elicitation/MRTR 対応クライアントで同じ操作を行うか、bitbank アプリ/ウェブで該当注文をキャンセルしてください。',
				appUiGuide: [
					'※ 上部の確認カードで内容を確認し、「一括キャンセルを確定する」ボタンを押すと取消が実行されます。',
					`  ボタンを押さない限り実行されません。確認は ${confirmationTtlSeconds()} 秒で期限切れになるため、その場合は preview_cancel_orders をやり直してください。`,
				],
			},
			execute: cancelOrders,
		});
	},
};
