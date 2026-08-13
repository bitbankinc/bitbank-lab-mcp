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
import { formatOrderPositionLabel, formatPair, formatPrice } from '../../lib/formatter.js';
import { logTradeAction } from '../../lib/logger.js';
import { isJpyQuotedPair, withNormalizedPair } from '../../lib/pair-code.js';
import { fail, ok } from '../../lib/result.js';
import { getDefaultClient } from '../../src/private/client.js';
import { validateToken } from '../../src/private/confirmation.js';
import {
	DIRECT_EXECUTE_FORBIDDEN_ERROR_TYPE,
	DIRECT_EXECUTE_FORBIDDEN_MESSAGE,
	isAppUiExecuteAllowed,
} from '../../src/private/elicitation.js';
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

	// HITL: 確認トークンの検証
	const tokenError = validateToken(confirmation_token, 'cancel_order', { pair, order_id }, token_expires_at);
	if (tokenError) {
		return CancelOrderOutputSchema.parse(fail(tokenError.message, tokenError.code));
	}

	const client = getDefaultClient();

	try {
		// 取得境界での pair 正規化（`lib/pair-code.ts`）。`data.order.pair` は小文字契約で返す。
		// 表示・JPY 判定は引数の `pair`（ユーザー入力）を使うので、ここは出力契約のためだけ。
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

		// 実行済み preview のスナップショットを無効化する（再描画で復元された古い確認
		// カードからの二重キャンセル → bitbank 70019 を防ぐ）。同一セッションのみ削除。
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
		// PrivateApiError は分類済み文言を素通し、未知エラーは err.message を伏せて汎用文に置換する。
		// 未登録 bitbankCode の素通しに備え remapBitbankCode で再 lookup する。
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
	handler: async (args, extra) => {
		// 既定では MCP tools/call（LLM / UI）経由を常に拒否する。
		// preview_cancel_order の elicitation accept は cancelOrder() を直接呼ぶためここを通らない。
		//
		// MCP Apps 実行経路（ADR-0007）が有効な場合のみ、確認トークンを伴う呼び出しを通す。
		// サーバーは iframe 起源と LLM 起源を区別できないため、**トークン所持が認可の実体**。
		// トークンは `_meta` にしか載せておらず LLM からは読めない。
		if (!isAppUiExecuteAllowed(extra)) {
			return CancelOrderOutputSchema.parse(fail(DIRECT_EXECUTE_FORBIDDEN_MESSAGE, DIRECT_EXECUTE_FORBIDDEN_ERROR_TYPE));
		}
		const typedArgs = args as Parameters<typeof cancelOrder>[0];
		// トークン欠落は「preview を経ていない直接呼び出し」なので従来どおり拒否する。
		// 値の正当性（HMAC / 期限 / ワンタイム / パラメータ一致）は cancelOrder 内の
		// validateToken が検証し、既存の errorType でそのまま失敗させる。
		if (!typedArgs?.confirmation_token || typeof typedArgs.token_expires_at !== 'number') {
			return CancelOrderOutputSchema.parse(fail(DIRECT_EXECUTE_FORBIDDEN_MESSAGE, DIRECT_EXECUTE_FORBIDDEN_ERROR_TYPE));
		}
		return cancelOrder(typedArgs, 'ui-button', {
			sessionId: (extra as { sessionId?: string } | undefined)?.sessionId,
		});
	},
};
