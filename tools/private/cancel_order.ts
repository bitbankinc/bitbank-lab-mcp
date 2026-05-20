/**
 * cancel_order — 注文をキャンセルする Private API ツール。
 *
 * bitbank Private API `POST /v1/user/spot/cancel_order` を呼び出し、
 * 指定した注文IDの注文をキャンセルする。
 *
 * エラーケース:
 * - 50009: 注文が見つからない
 * - 50010: キャンセル不可（既にキャンセル・約定済みなど）
 * - 50026: 既にキャンセル済み
 * - 50027: 既に約定済み
 */

import { nowIso, toIsoMs } from '../../lib/datetime.js';
import { formatPair, formatPrice } from '../../lib/formatter.js';
import { logTradeAction } from '../../lib/logger.js';
import { fail, ok, toStructured } from '../../lib/result.js';
import { getBitbankErrorMessage } from '../../src/lib/bitbank-errors.js';
import { getDefaultClient, PrivateApiError } from '../../src/private/client.js';
import { validateToken } from '../../src/private/confirmation.js';
import type { OrderResponse } from '../../src/private/schemas.js';
import { CancelOrderInputSchema, CancelOrderOutputSchema } from '../../src/private/schemas.js';
import type { ToolDefinition } from '../../src/tool-definition.js';

export default async function cancelOrder(
	args: {
		pair: string;
		order_id: number;
		confirmation_token: string;
		token_expires_at: number;
	},
	route: 'elicitation' | 'ui-button' | 'direct-text' = 'direct-text',
) {
	const { pair, order_id, confirmation_token, token_expires_at } = args;

	// HITL: 確認トークンの検証
	const tokenError = validateToken(confirmation_token, 'cancel_order', { pair, order_id }, token_expires_at);
	if (tokenError) {
		return CancelOrderOutputSchema.parse(fail(tokenError.message, tokenError.code));
	}

	const client = getDefaultClient();

	try {
		const rawOrder = await client.post<OrderResponse>('/v1/user/spot/cancel_order', {
			pair,
			order_id,
		});

		const timestamp = nowIso();
		const isJpy = pair.includes('jpy');
		const sideLabel = rawOrder.side === 'buy' ? '買' : '売';
		const price = rawOrder.price ? (isJpy ? formatPrice(Number(rawOrder.price)) : rawOrder.price) : '成行';
		const amount = rawOrder.start_amount ?? rawOrder.executed_amount;

		const lines: string[] = [];
		lines.push(`注文キャンセル完了: ${formatPair(pair)}`);
		lines.push(`  注文ID: ${order_id}`);
		lines.push(`  ${sideLabel} ${rawOrder.type} ${amount} @ ${price}`);
		lines.push(`  ステータス: ${rawOrder.status}`);
		if (rawOrder.executed_amount && rawOrder.executed_amount !== '0') {
			lines.push(`  約定済み数量: ${rawOrder.executed_amount}`);
		}
		lines.push(
			`  キャンセル日時: ${rawOrder.canceled_at ? (toIsoMs(rawOrder.canceled_at) ?? String(rawOrder.canceled_at)) : timestamp}`,
		);

		const summary = lines.join('\n');

		logTradeAction({
			type: 'cancel_order',
			orderId: order_id,
			pair,
			side: rawOrder.side,
			status: rawOrder.status,
			confirmed: true,
			route,
		});

		return CancelOrderOutputSchema.parse(
			ok(
				summary,
				{ order: rawOrder, timestamp },
				{
					fetchedAt: timestamp,
					orderId: order_id,
					pair,
					...(client.lastRateLimit ? { rateLimit: client.lastRateLimit } : {}),
				},
			),
		);
	} catch (err) {
		if (err instanceof PrivateApiError) {
			// キャンセル固有エラーの文言は src/lib/bitbank-errors.ts に集約済み。
			// client.ts も同テーブルを参照するため err.message には既にローカライズ文言が乗るが、
			// 未登録コードを client が素通ししたケースに備えてここでも lookup する。
			const mapped = err.bitbankCode != null ? getBitbankErrorMessage(err.bitbankCode) : undefined;
			return CancelOrderOutputSchema.parse(fail(mapped ?? err.message, err.errorType));
		}
		return CancelOrderOutputSchema.parse(
			fail(err instanceof Error ? err.message : '注文キャンセル中に予期しないエラーが発生しました', 'upstream_error'),
		);
	}
}

export const toolDef: ToolDefinition = {
	name: 'cancel_order',
	description:
		'[Cancel Order] 指定した注文IDの注文をキャンセルする。キャンセル後の注文情報を返す。Private API。' +
		' ⚠️ 事前に preview_cancel_order で確認トークンを取得し、confirmation_token と token_expires_at を渡すこと。' +
		' トークンなしの直接呼び出しは拒否される。',
	inputSchema: CancelOrderInputSchema,
	handler: async (args) => {
		const result = await cancelOrder(
			args as { pair: string; order_id: number; confirmation_token: string; token_expires_at: number },
		);
		if (!result.ok) return result;
		const text = `${result.summary}\n${JSON.stringify(result.data, null, 2)}`;
		return {
			content: [{ type: 'text', text }],
			structuredContent: toStructured(result),
		};
	},
};
