/**
 * cancel_orders — 複数注文を一括キャンセルする Private API ツール。
 *
 * bitbank Private API `POST /v1/user/spot/cancel_orders` を呼び出し、
 * 指定した複数の注文IDの注文をキャンセルする（最大30件）。
 */

import { nowIso } from '../../lib/datetime.js';
import { formatOrderPositionLabel, formatPair, formatPrice } from '../../lib/formatter.js';
import { logTradeAction } from '../../lib/logger.js';
import { fail, ok } from '../../lib/result.js';
import { getDefaultClient } from '../../src/private/client.js';
import { validateToken } from '../../src/private/confirmation.js';
import {
	DIRECT_EXECUTE_FORBIDDEN_ERROR_TYPE,
	DIRECT_EXECUTE_FORBIDDEN_MESSAGE,
} from '../../src/private/elicitation.js';
import type { OrderResponse } from '../../src/private/schemas.js';
import { CancelOrdersInputSchema, CancelOrdersOutputSchema } from '../../src/private/schemas.js';
import { failPrivateToolError } from '../../src/private/tool-error.js';
import type { ToolDefinition } from '../../src/tool-definition.js';
import { clearUiSnapshot } from '../../src/ui-snapshot-cache.js';

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

		// 実行済み preview のスナップショットを無効化（cancel_order と同趣旨）。
		clearUiSnapshot('ui://cancel/confirm.html');

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
		// PrivateApiError は分類済み文言を素通し、未知エラーは err.message を伏せて汎用文に置換する。
		return CancelOrdersOutputSchema.parse(
			failPrivateToolError(err, '注文一括キャンセル中に予期しないエラーが発生しました'),
		);
	}
}

export const toolDef: ToolDefinition = {
	name: 'cancel_orders',
	description:
		'[Cancel Orders / Bulk Cancel] 複数の注文を一括キャンセル（最大30件）。キャンセル後の注文情報を返す。Private API。' +
		' ⚠️ このツールは MCP tools/call（LLM / UI）からは実行できない。' +
		' 一括キャンセルは必ず preview_cancel_orders 経由の elicitation/MRTR 確認（ユーザーの明示 accept）でのみ行われる。' +
		' confirmation_token はクライアントに返らないため、直接呼び出してもトークン検証または本ハンドラの拒否で失敗する。',
	inputSchema: CancelOrdersInputSchema,
	handler: async () => {
		// MCP tools/call（LLM / UI）経由は常に拒否。
		// preview_cancel_orders の elicitation accept は cancelOrders() を直接呼ぶためここを通らない。
		return CancelOrdersOutputSchema.parse(fail(DIRECT_EXECUTE_FORBIDDEN_MESSAGE, DIRECT_EXECUTE_FORBIDDEN_ERROR_TYPE));
	},
};
