/**
 * cancel_orders — 複数注文を一括キャンセルする Private API ツール。
 *
 * bitbank Private API `POST /v1/user/spot/cancel_orders` を呼び出し、
 * 指定した複数の注文IDの注文をキャンセルする（最大30件）。
 */

import { nowIso } from '../../lib/datetime.js';
import { formatOrderPositionLabel, formatPair, formatPrice } from '../../lib/formatter.js';
import { logTradeAction } from '../../lib/logger.js';
import { isJpyQuotedPair, normalizePairCodes } from '../../lib/pair-code.js';
import { fail, ok } from '../../lib/result.js';
import { getDefaultClient } from '../../src/private/client.js';
import { validateToken } from '../../src/private/confirmation.js';
import {
	DIRECT_EXECUTE_FORBIDDEN_ERROR_TYPE,
	DIRECT_EXECUTE_FORBIDDEN_MESSAGE,
	isAppUiExecuteAllowed,
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
	scope: { sessionId?: string } = {},
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
		// 取得境界での pair 正規化（`lib/pair-code.ts`）。`data.orders[].pair` は小文字契約で返す。
		// 表示・JPY 判定は引数の `pair`（ユーザー入力）を使うので、ここは出力契約のためだけ。
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

		// 実行済み preview のスナップショットを無効化（cancel_order と同趣旨）。同一セッションのみ。
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
		' ⚠️ このツールを MCP tools/call から直接呼び出してはならない。サーバー側で拒否される。' +
		' 一括キャンセルは必ず preview_cancel_orders から始まるユーザー確認フローを経由してのみ行われる。',
	inputSchema: CancelOrdersInputSchema,
	handler: async (args, extra) => {
		// 既定では MCP tools/call（LLM / UI）経由を常に拒否する。
		// preview_cancel_orders の elicitation accept は cancelOrders() を直接呼ぶためここを通らない。
		//
		// MCP Apps 実行経路（ADR-0007）が有効な場合のみ、確認トークンを伴う呼び出しを通す。
		// サーバーは iframe 起源と LLM 起源を区別できないため、**トークン所持が認可の実体**。
		// トークンは `_meta` にしか載せておらず LLM からは読めない。
		if (!isAppUiExecuteAllowed(extra)) {
			return CancelOrdersOutputSchema.parse(
				fail(DIRECT_EXECUTE_FORBIDDEN_MESSAGE, DIRECT_EXECUTE_FORBIDDEN_ERROR_TYPE),
			);
		}
		const typedArgs = args as Parameters<typeof cancelOrders>[0];
		// トークン欠落は「preview を経ていない直接呼び出し」なので従来どおり拒否する。
		// 値の正当性（HMAC / 期限 / ワンタイム / パラメータ一致）は cancelOrders 内の
		// validateToken が検証し、既存の errorType でそのまま失敗させる。
		if (!typedArgs?.confirmation_token || typeof typedArgs.token_expires_at !== 'number') {
			return CancelOrdersOutputSchema.parse(
				fail(DIRECT_EXECUTE_FORBIDDEN_MESSAGE, DIRECT_EXECUTE_FORBIDDEN_ERROR_TYPE),
			);
		}
		return cancelOrders(typedArgs, 'ui-button', {
			sessionId: (extra as { sessionId?: string } | undefined)?.sessionId,
		});
	},
};
