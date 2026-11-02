import { nowIso, toIsoMs } from '../../lib/datetime.js';
import { formatOrderPositionLabel, formatPair, formatPrice } from '../../lib/formatter.js';
import { logTradeAction } from '../../lib/logger.js';
import { isJpyQuotedPair, withNormalizedPair } from '../../lib/pair-code.js';
import { fail, ok } from '../../lib/result.js';
import { getDefaultClient } from '../../src/private/client.js';
import { validateToken } from '../../src/private/confirmation.js';
import { runAppUiExecute } from '../../src/private/execute-gate.js';
import type { OrderResponse } from '../../src/private/schemas.js';
import { CancelOrderInputSchema, CancelOrderOutputSchema } from '../../src/private/schemas.js';
import { failPrivateToolError } from '../../src/private/tool-error.js';
import type { ToolDefinition } from '../../src/tool-definition.js';
import { clearUiSnapshot } from '../../src/ui-snapshot-cache.js';

export default async function cancelOrder(
	args: {
		pair: string;
		order_id: number;
		confirmation_token: string;
		token_expires_at: number;
	},
	route: 'elicitation' | 'ui-button' | 'direct-text' = 'direct-text',
	scope: { sessionId?: string } = {},
) {
	const { pair, order_id, confirmation_token, token_expires_at } = args;

	const tokenError = validateToken(confirmation_token, 'cancel_order', { pair, order_id }, token_expires_at);
	if (tokenError) {
		return CancelOrderOutputSchema.parse(fail(tokenError.message, tokenError.code));
	}

	const client = getDefaultClient();

	try {
		// `data.order.pair` は小文字契約で返す（表示・JPY 判定は引数の `pair` を使うので、この正規化は出力契約のためだけ）。
		const rawOrder = withNormalizedPair(
			await client.post<OrderResponse>('/v1/user/spot/cancel_order', {
				pair,
				order_id,
			}),
		);

		const timestamp = nowIso();
		const isJpy = isJpyQuotedPair(pair);
		const sideLabel = rawOrder.side === 'buy' ? '買' : '売';
		const posLabel = formatOrderPositionLabel(rawOrder.position_side);
		const price = rawOrder.price ? (isJpy ? formatPrice(Number(rawOrder.price)) : rawOrder.price) : '成行';
		const amount = rawOrder.start_amount ?? rawOrder.executed_amount;

		const lines: string[] = [];
		lines.push(`注文キャンセル完了: ${formatPair(pair)}`);
		lines.push(`  注文ID: ${order_id}`);
		lines.push(`  ${posLabel}${sideLabel} ${rawOrder.type} ${amount} @ ${price}`);
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

		// 再描画で復元された古い確認カードからの二重キャンセル（bitbank 70019）を防ぐため、実行済み preview のスナップショットを無効化する（同一セッションのみ）。
		clearUiSnapshot('ui://cancel/confirm.html', scope);

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
		return CancelOrderOutputSchema.parse(
			failPrivateToolError(err, '注文キャンセル中に予期しないエラーが発生しました', { remapBitbankCode: true }),
		);
	}
}

export const toolDef: ToolDefinition = {
	name: 'cancel_order',
	description:
		'[Cancel Order] 指定した注文IDの注文をキャンセルする。キャンセル後の注文情報を返す。Private API。' +
		' ⚠️ このツールを MCP tools/call から直接呼び出してはならない。サーバー側で拒否される。' +
		' キャンセルは必ず preview_cancel_order から始まるユーザー確認フローを経由してのみ行われる。',
	inputSchema: CancelOrderInputSchema,
	handler: async (args, extra) => runAppUiExecute(args, extra, CancelOrderOutputSchema, cancelOrder),
};
