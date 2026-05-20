/**
 * cancel_orders — 複数注文を一括キャンセルする Private API ツール。
 *
 * bitbank Private API `POST /v1/user/spot/cancel_orders` を呼び出し、
 * 指定した複数の注文IDの注文をキャンセルする（最大30件）。
 */

import { nowIso } from '../../lib/datetime.js';
import { formatOrderPositionLabel, formatPair, formatPrice } from '../../lib/formatter.js';
import { logTradeAction } from '../../lib/logger.js';
import { fail, ok, toStructured } from '../../lib/result.js';
import { getDefaultClient, PrivateApiError } from '../../src/private/client.js';
import { validateToken } from '../../src/private/confirmation.js';
import type { OrderResponse } from '../../src/private/schemas.js';
import { CancelOrdersInputSchema, CancelOrdersOutputSchema } from '../../src/private/schemas.js';
import type { ToolDefinition } from '../../src/tool-definition.js';

export default async function cancelOrders(
	args: {
		pair: string;
		order_ids: number[];
		confirmation_token: string;
		token_expires_at: number;
	},
	route: 'elicitation' | 'ui-button' | 'direct-text' = 'direct-text',
) {
	const { pair, order_ids, confirmation_token, token_expires_at } = args;

	// HITL: 確認トークンの検証
	const tokenError = validateToken(confirmation_token, 'cancel_orders', { pair, order_ids }, token_expires_at);
	if (tokenError) {
		return CancelOrdersOutputSchema.parse(fail(tokenError.message, tokenError.code));
	}

	const client = getDefaultClient();

	try {
		const rawData = await client.post<{ orders: OrderResponse[] }>('/v1/user/spot/cancel_orders', {
			pair,
			order_ids,
		});

		const timestamp = nowIso();
		const orders = rawData.orders;
		const isJpy = pair.includes('jpy');

		const lines: string[] = [];
		lines.push(`一括キャンセル完了: ${formatPair(pair)} ${orders.length}件`);

		if (orders.length > 0) {
			lines.push('');
			for (const o of orders) {
				const sideLabel = o.side === 'buy' ? '買' : '売';
				const posLabel = formatOrderPositionLabel(o.position_side);
				const price = o.price ? (isJpy ? formatPrice(Number(o.price)) : o.price) : '成行';
				const amount = o.start_amount ?? o.executed_amount;
				lines.push(`#${o.order_id} ${posLabel}${sideLabel}${o.type} ${amount} @ ${price} [${o.status}]`);
			}
		}

		if (orders.length < order_ids.length) {
			lines.push('');
			lines.push(
				`※ ${order_ids.length - orders.length}件はキャンセルできませんでした（既に約定・キャンセル済みの可能性）`,
			);
		}

		const summary = lines.join('\n');

		logTradeAction({
			type: 'cancel_orders',
			orderIds: order_ids,
			pair,
			status: `canceled_${orders.length}_of_${order_ids.length}`,
			confirmed: true,
			route,
		});

		return CancelOrdersOutputSchema.parse(
			ok(
				summary,
				{ orders, timestamp },
				{
					fetchedAt: timestamp,
					canceledCount: orders.length,
					pair,
					...(client.lastRateLimit ? { rateLimit: client.lastRateLimit } : {}),
				},
			),
		);
	} catch (err) {
		if (err instanceof PrivateApiError) {
			return CancelOrdersOutputSchema.parse(fail(err.message, err.errorType));
		}
		return CancelOrdersOutputSchema.parse(
			fail(
				err instanceof Error ? err.message : '注文一括キャンセル中に予期しないエラーが発生しました',
				'upstream_error',
			),
		);
	}
}

export const toolDef: ToolDefinition = {
	name: 'cancel_orders',
	description:
		'[Cancel Orders / Bulk Cancel] 複数の注文を一括キャンセル（最大30件）。キャンセル後の注文情報を返す。Private API。' +
		' ⚠️ 事前に preview_cancel_orders で確認トークンを取得し、confirmation_token と token_expires_at を渡すこと。' +
		' トークンなしの直接呼び出しは拒否される。',
	inputSchema: CancelOrdersInputSchema,
	handler: async (args) => {
		const result = await cancelOrders(
			args as { pair: string; order_ids: number[]; confirmation_token: string; token_expires_at: number },
		);
		if (!result.ok) return result;
		const text = `${result.summary}\n${JSON.stringify(result.data, null, 2)}`;
		return {
			content: [{ type: 'text', text }],
			structuredContent: toStructured(result),
		};
	},
};
