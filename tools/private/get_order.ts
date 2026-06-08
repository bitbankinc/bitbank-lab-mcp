/**
 * get_order — 注文詳細を取得する Private API ツール。
 *
 * bitbank Private API `GET /v1/user/spot/order` を呼び出し、
 * 指定した注文IDの詳細情報を返す。
 *
 * ※ 約定・キャンセルから3ヶ月以上経過した注文は取得不可（エラー 50009）。
 */

import { nowIso, toIsoMs } from '../../lib/datetime.js';
import { formatOrderPositionLabel, formatPair, formatPrice } from '../../lib/formatter.js';
import { ok, toStructured } from '../../lib/result.js';
import { getDefaultClient } from '../../src/private/client.js';
import type { OrderResponse } from '../../src/private/schemas.js';
import { GetOrderInputSchema, GetOrderOutputSchema } from '../../src/private/schemas.js';
import { failPrivateToolError } from '../../src/private/tool-error.js';
import type { ToolDefinition } from '../../src/tool-definition.js';

/** 注文情報を人間可読な文字列に整形 */
function formatOrderSummary(o: OrderResponse, pair: string): string {
	const sideLabel = o.side === 'buy' ? '買' : '売';
	const posLabel = formatOrderPositionLabel(o.position_side);
	const isJpy = pair.includes('jpy');
	const price = o.price ? (isJpy ? formatPrice(Number(o.price)) : o.price) : '成行';
	const amount = o.start_amount ?? o.executed_amount;
	const lines: string[] = [];

	lines.push(`注文詳細: ${formatPair(pair)}`);
	lines.push(`  注文ID: ${o.order_id}`);
	lines.push(`  方向: ${posLabel}${sideLabel} / タイプ: ${o.type}`);
	lines.push(`  数量: ${amount} / 未約定: ${o.remaining_amount ?? '0'} / 約定済: ${o.executed_amount}`);
	lines.push(`  価格: ${price}`);
	if (o.average_price && o.average_price !== '0') {
		lines.push(`  平均約定価格: ${isJpy ? formatPrice(Number(o.average_price)) : o.average_price}`);
	}
	if (o.trigger_price) {
		lines.push(`  トリガー価格: ${isJpy ? formatPrice(Number(o.trigger_price)) : o.trigger_price}`);
	}
	lines.push(`  ステータス: ${o.status}`);
	lines.push(`  注文日時: ${toIsoMs(o.ordered_at) ?? String(o.ordered_at)}`);
	if (o.canceled_at) {
		lines.push(`  キャンセル日時: ${toIsoMs(o.canceled_at) ?? String(o.canceled_at)}`);
	}

	return lines.join('\n');
}

export default async function getOrder(args: { pair: string; order_id: number }) {
	const { pair, order_id } = args;
	const client = getDefaultClient();

	try {
		const rawOrder = await client.get<OrderResponse>('/v1/user/spot/order', {
			pair,
			order_id: String(order_id),
		});

		const timestamp = nowIso();
		const summary = formatOrderSummary(rawOrder, pair);

		return GetOrderOutputSchema.parse(
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
		// PrivateApiError は分類済み文言を素通し、未知エラーは err.message を伏せて汎用文に置換する。
		return GetOrderOutputSchema.parse(failPrivateToolError(err, '注文情報取得中に予期しないエラーが発生しました'));
	}
}

export const toolDef: ToolDefinition = {
	name: 'get_order',
	description:
		'[Order Detail / Order Status] 指定した注文IDの詳細情報を取得。ステータス・約定状況・価格を確認できる。Private API。',
	inputSchema: GetOrderInputSchema,
	handler: async (args) => {
		const result = await getOrder(args as { pair: string; order_id: number });
		if (!result.ok) return result;
		const text = `${result.summary}\n${JSON.stringify(result.data, null, 2)}`;
		return {
			content: [{ type: 'text', text }],
			structuredContent: toStructured(result),
		};
	},
};
