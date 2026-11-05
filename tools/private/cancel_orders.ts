import { nowIso } from '../../lib/datetime.js';
import { formatOrderPositionLabel, formatPair, formatPrice } from '../../lib/formatter.js';
import { logTradeAction } from '../../lib/logger.js';
import { isJpyQuotedPair, normalizePairCodes } from '../../lib/pair-code.js';
import { fail, ok } from '../../lib/result.js';
import { getDefaultClient } from '../../src/private/client.js';
import { validateToken } from '../../src/private/confirmation.js';
import { runAppUiExecute } from '../../src/private/execute-gate.js';
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
	scope: { sessionId?: string } = {},
) {
	const { pair, order_ids, confirmation_token, token_expires_at } = args;

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
		// `data.orders[].pair` は小文字契約で返す（表示・JPY 判定は引数の `pair` を使うので、この正規化は出力契約のためだけ）。
		const orders = normalizePairCodes(rawData.orders);
		const isJpy = isJpyQuotedPair(pair);

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

		// 再描画で復元された古い確認カードからの二重キャンセルを防ぐため、実行済み preview のスナップショットを無効化する（同一セッションのみ）。
		clearUiSnapshot('ui://cancel/confirm.html', scope);

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
		return CancelOrdersOutputSchema.parse(
			failPrivateToolError(err, '注文一括キャンセル中に予期しないエラーが発生しました'),
		);
	}
}

export const toolDef: ToolDefinition = {
	name: 'cancel_orders',
	description:
		'[Cancel Orders / Bulk Cancel] 複数の注文を一括キャンセル（最大30件）。キャンセル後の注文情報を返す。Private API。' +
		' ⚠️ このツールを MCP tools/call から直接呼び出してはならない。サーバー側で拒否される。' +
		' 一括キャンセルは必ず preview_cancel_orders から始まるユーザー確認フローを経由してのみ行われる。',
	inputSchema: CancelOrdersInputSchema,
	handler: async (args, extra) => runAppUiExecute(args, extra, CancelOrdersOutputSchema, cancelOrders),
};
