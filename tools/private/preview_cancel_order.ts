import { formatOrderPositionLabel, formatPair, formatPrice } from '../../lib/formatter.js';
import { isJpyQuotedPair } from '../../lib/pair-code.js';
import { fail, ok } from '../../lib/result.js';
import { generateToken } from '../../src/private/confirmation.js';
import { confirmPreview } from '../../src/private/preview-confirmation.js';
import type { OrderResponse } from '../../src/private/schemas.js';
import {
	PreviewCancelOrderInputSchema,
	PreviewCancelOrderOutputSchema,
	TERMINAL_ORDER_STATUSES,
} from '../../src/private/schemas.js';
import type { ToolDefinition } from '../../src/tool-definition.js';
import cancelOrder from './cancel_order.js';
import getOrder from './get_order.js';

function formatOrderDetailLines(order: OrderResponse, pair: string): string[] {
	const sideLabel = order.side === 'buy' ? '買' : '売';
	const posLabel = formatOrderPositionLabel(order.position_side);
	const isJpy = isJpyQuotedPair(pair);
	const price = order.price ? (isJpy ? formatPrice(Number(order.price)) : order.price) : '成行';
	const amount = order.start_amount ?? order.executed_amount ?? '?';
	const lines: string[] = [];
	lines.push(`  方向: ${posLabel}${sideLabel} / タイプ: ${order.type}`);
	lines.push(`  数量: ${amount}（残: ${order.remaining_amount ?? '0'} / 約定: ${order.executed_amount}）`);
	lines.push(`  価格: ${price}`);
	if (order.trigger_price) {
		lines.push(`  トリガー価格: ${isJpy ? formatPrice(Number(order.trigger_price)) : order.trigger_price}`);
	}
	if (order.average_price && order.average_price !== '0') {
		lines.push(`  平均約定価格: ${isJpy ? formatPrice(Number(order.average_price)) : order.average_price}`);
	}
	lines.push(`  ステータス: ${order.status}`);
	return lines;
}

// LLM がこの文をそのままユーザーへの説明に使うので、終端状態を「キャンセル済み」で一括りにせず理由を書き分ける。
// default は終端状態が増えたのに case を足し忘れたときの受け皿（未約定なのに「キャンセル済み」と出さないための保険）。
function terminalStatusMessage(status: OrderResponse['status']): string {
	switch (status) {
		case 'FULLY_FILLED':
			return `この注文は既に全量約定しているためキャンセルできません（status: ${status}）`;
		case 'REJECTED':
			return `この注文はシステムに拒否されており、キャンセル対象ではありません（status: ${status}）`;
		case 'CANCELED_UNFILLED':
		case 'CANCELED_PARTIALLY_FILLED':
			return `この注文は既にキャンセル済みです（status: ${status}）`;
		default:
			return `この注文は終端状態のためキャンセルできません（status: ${status}）`;
	}
}

export default async function previewCancelOrder(args: { pair: string; order_id: number }) {
	const { pair, order_id } = args;

	// 注文詳細の取得に失敗してもキャンセル自体は可能なので、エラーは握りつぶしてフォールバック表示にとどめる（キャンセル不能にする方が UX として悪い）。
	let orderDetail: OrderResponse | undefined;
	const detailResult = await getOrder({ pair, order_id });
	if (detailResult.ok) {
		orderDetail = detailResult.data.order;
	}

	// 終端状態はトークン生成より前に拒否する（押せるのに必ず失敗するボタンを出さず、二重キャンセルを bitbank へ届く前に止める）。
	const status = orderDetail?.status;
	if (status !== undefined && TERMINAL_ORDER_STATUSES.has(status)) {
		return PreviewCancelOrderOutputSchema.parse(fail(terminalStatusMessage(status), 'validation_error'));
	}

	const tokenParams = { pair, order_id };
	const { token, expiresAt } = generateToken('cancel_order', tokenParams);

	const lines: string[] = [];
	lines.push(`📋 キャンセルプレビュー: ${formatPair(pair)}`);
	lines.push(`  注文ID: ${order_id}`);
	if (orderDetail) {
		lines.push(...formatOrderDetailLines(orderDetail, pair));
	}
	lines.push('');
	lines.push('⚠️ このキャンセルはユーザーの最終確認を経るまで実行されません。');

	const summary = lines.join('\n');

	const data: Record<string, unknown> = {
		confirmation_token: token,
		expires_at: expiresAt,
		preview: { pair, order_id },
	};
	if (orderDetail) data.order = orderDetail;

	return PreviewCancelOrderOutputSchema.parse(ok(summary, data, { action: 'cancel_order' as const }));
}

export const toolDef: ToolDefinition = {
	name: 'preview_cancel_order',
	description: [
		'[Preview Cancel Order] 注文キャンセルのプレビュー。実際のキャンセルは行わない。Private API。',
		'⚠️ confirmation_token は content / structuredContent には決して含めない。LLM がトークンを読み取って cancel_order を直接呼ぶことはできない。',
		'実際のキャンセルはユーザーの明示確認（対応ホストの確認ダイアログ、または確認カードのボタン操作）を経てのみ完結する。',
		'いずれにも対応しないホストではプレビューのみ返し、キャンセル実行は受け付けない。その場合は対応クライアントでの操作を第一に案内し、bitbank アプリ/ウェブでのキャンセルは任意の代替手段として扱う。',
		'このツールの応答を受け取った後、LLM がキャンセル完了を宣言してはならない。実行結果はユーザー確認後の応答で別途返る。',
	].join(' '),
	inputSchema: PreviewCancelOrderInputSchema,
	_meta: {
		ui: {
			resourceUri: 'ui://cancel/confirm.html',
		},
	},
	handler: async (args, extra) => {
		const typedArgs = args as { pair: string; order_id: number };
		const result = await previewCancelOrder(typedArgs);
		if (!result.ok) return result;

		return confirmPreview({
			extra,
			action: 'cancel_order',
			args: typedArgs,
			result,
			outputSchema: PreviewCancelOrderOutputSchema,
			texts: {
				confirmTitle: 'この注文をキャンセルする',
				declinedText: 'ユーザーがキャンセル操作を取り消しました（elicitation）',
				unsupportedHostGuide:
					'  実際にキャンセルするには、elicitation/MRTR 対応クライアントで同じ操作を行うか、bitbank アプリ/ウェブで該当注文をキャンセルしてください。',
				appUiGuide: [
					'※ 上部の確認カードで内容を確認し、「キャンセルを確定する」ボタンを押すと取消が実行されます。',
					'  ボタンを押さない限り実行されません。確認は 60 秒で期限切れになるため、その場合は preview_cancel_order をやり直してください。',
				],
			},
			execute: cancelOrder,
		});
	},
};
