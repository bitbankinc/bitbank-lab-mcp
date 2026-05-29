/**
 * preview_cancel_order — 注文キャンセルのプレビュー。
 *
 * キャンセル対象の注文情報を表示する。実際のキャンセルは行わない。
 *
 * 内部的に confirmation_token も生成するが、これはサーバープロセス内に閉じる:
 *   - elicitation 対応ホスト: ハンドラ内の accept 経路で cancel_order へ非公開のまま
 *     引き渡し、preview → ユーザー確認 → cancel_order までを完結させる
 *   - elicitation 非対応ホスト: キャンセル実行は行わずプレビューのみ返し、token は
 *     クライアントに渡さない
 *
 * 詳細は docs/private-api.md「`confirmation_token` の受け渡し」節を参照。
 */

import { formatOrderPositionLabel, formatPair, formatPrice } from '../../lib/formatter.js';
import { ok, toStructured } from '../../lib/result.js';
import { generateToken } from '../../src/private/confirmation.js';
import { withElicitedConfirmation } from '../../src/private/elicitation.js';
import type { OrderResponse } from '../../src/private/schemas.js';
import { PreviewCancelOrderInputSchema, PreviewCancelOrderOutputSchema } from '../../src/private/schemas.js';
import type { ToolDefinition } from '../../src/tool-definition.js';
import cancelOrder from './cancel_order.js';
import getOrder from './get_order.js';

/** 注文詳細をキャンセルプレビューのサマリ行に整形する */
function formatOrderDetailLines(order: OrderResponse, pair: string): string[] {
	const sideLabel = order.side === 'buy' ? '買' : '売';
	const posLabel = formatOrderPositionLabel(order.position_side);
	const isJpy = pair.includes('jpy');
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

export default async function previewCancelOrder(args: { pair: string; order_id: number }) {
	const { pair, order_id } = args;

	// 注文詳細を取得して preview にも同梱する。失敗してもキャンセル自体は可能なので、
	// エラーは握りつぶしてフォールバック表示にとどめる（ネットワーク不調や認証異常で
	// キャンセル不能になる方が UX として悪いため）。
	let orderDetail: OrderResponse | undefined;
	const detailResult = await getOrder({ pair, order_id });
	if (detailResult.ok) {
		orderDetail = detailResult.data.order;
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
	lines.push('⚠️ このキャンセルはユーザーの最終確認（ホスト UI または elicitation）を経るまで実行されません。');

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
		'⚠️ confirmation_token はクライアント側には返さない（content / structuredContent / _meta のいずれにも含めない）。',
		'実際のキャンセルは elicitation 対応ホストでのみ可能で、その場合はこのハンドラ内で preview → ユーザー確認 → cancel_order までを完結させる。',
		'elicitation 非対応ホストではプレビュー内容のみ返し、キャンセル実行は受け付けない。',
	].join(' '),
	inputSchema: PreviewCancelOrderInputSchema,
	// MCP Apps (SEP-1865): 対応ホストでは iframe 内にキャンセル確認 UI を表示する。
	// 非対応ホストでは無視される（Progressive Enhancement）。
	// 注: 本 PR 時点では UI 側からの cancel_order 経路は未実装（pending action store と
	// UI origin 検証の安全設計を別 PR で整備するまで token を UI に渡さない）。
	_meta: {
		ui: {
			resourceUri: 'ui://cancel/confirm.html',
		},
	},
	handler: async (args, extra) => {
		const typedArgs = args as { pair: string; order_id: number };
		const result = await previewCancelOrder(typedArgs);
		if (!result.ok) return result;

		// elicitation 非対応ホスト向けのフォールバックレスポンス。
		// キャンセル実行はこのホストでは行えない旨を明示し、トークンの存在は仄めかさない。
		const fallbackText = [
			result.summary,
			'',
			'※ このホストでは取引実行に対応していません。',
			'  実際にキャンセルするには、elicitation 対応クライアント（Claude Desktop など）で同じ操作を実行してください。',
		].join('\n');

		// BITBANK_TRUST_HOST_APPROVAL=1 のときに使う妥協経路用のレスポンス。
		// 詳細は docs/adr/0002-hitl-confirmation-token-delivery.md。
		const trustHostFallbackText = [
			result.summary,
			'',
			'iframe の「キャンセルを確定する」ボタンを押してキャンセルを確定してください。',
			'ボタンを押さない限りキャンセルは行われません。',
		].join('\n');

		// elicitation 対応ホストでは preview → ユーザー確認 → cancel_order までを
		// このハンドラ内で完結させる。confirmation_token / expires_at は
		// withElicitedConfirmation が structuredContent / declinedStructured / fallback
		// から必ず剥がすため caller 側で sanitize する必要はない（最終ガードは helper 側）。
		return withElicitedConfirmation({
			extra,
			summary: result.summary,
			confirmTitle: 'この注文をキャンセルする',
			// 内部的に cancel_order を実行。監査ログには route='elicitation' で記録される。
			// confirmation_token / expires_at は previewCancelOrder() が必ず生成するため non-null 断定して渡す。
			onConfirmed: () =>
				cancelOrder(
					{
						...typedArgs,
						confirmation_token: result.data.confirmation_token!,
						token_expires_at: result.data.expires_at!,
					},
					'elicitation',
				),
			onDeclinedText: 'ユーザーがキャンセル操作を取り消しました（elicitation）',
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
