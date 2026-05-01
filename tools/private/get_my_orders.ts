/**
 * get_my_orders — 自分のアクティブな注文一覧を取得する Private API ツール。
 *
 * bitbank Private API `/v1/user/spot/active_orders` を呼び出し、
 * LLM が分析しやすい形に整形して返す。
 */

import { nowIso, parseIso8601, toIsoMs } from '../../lib/datetime.js';
import { formatPair, formatPrice } from '../../lib/formatter.js';
import { fail, ok } from '../../lib/result.js';
import { getDefaultClient, PrivateApiError } from '../../src/private/client.js';
import { GetMyOrdersInputSchema, GetMyOrdersOutputSchema } from '../../src/private/schemas.js';
import type { ToolDefinition } from '../../src/tool-definition.js';

/** bitbank /v1/user/spot/active_orders のレスポンス型 */
interface RawOrder {
	order_id: number;
	pair: string;
	side: string;
	position_side?: string;
	type: string;
	start_amount?: string;
	remaining_amount?: string;
	executed_amount?: string;
	price?: string;
	post_only?: boolean;
	user_cancelable?: boolean;
	average_price?: string;
	ordered_at: number;
	expire_at?: number;
	triggered_at?: number | string;
	trigger_price?: string;
	status: string;
}

export default async function getMyOrders(args: { pair?: string; count?: number; since?: string; end?: string }) {
	const { pair, count = 100, since, end } = args;
	const client = getDefaultClient();

	try {
		// クエリパラメータを組み立て
		const params: Record<string, string> = {};
		if (pair) params.pair = pair;
		if (count !== 100) params.count = String(count);

		// ISO8601 → unix ms 変換（strict parse で不正日時を弾く）
		if (since) {
			const parsed = parseIso8601(since);
			if (!parsed) {
				return GetMyOrdersOutputSchema.parse(fail(`since の日時形式が不正です: ${since}`, 'validation_error'));
			}
			params.since = String(parsed.valueOf());
		}
		if (end) {
			const parsed = parseIso8601(end);
			if (!parsed) {
				return GetMyOrdersOutputSchema.parse(fail(`end の日時形式が不正です: ${end}`, 'validation_error'));
			}
			params.end = String(parsed.valueOf());
		}

		const rawData = await client.get<{ orders: RawOrder[] }>(
			'/v1/user/spot/active_orders',
			Object.keys(params).length > 0 ? params : undefined,
		);

		const timestamp = nowIso();

		// bitbank API の active_orders は稀に CANCELED_UNFILLED 等の非アクティブ
		// ステータスを含めて返すケースがあるため、サーバー側でも保険として
		// 「ユーザーから見てまだ生きている」注文のみに絞り込む。
		// - INACTIVE: stop / stop_limit のトリガー前。user_cancelable: true で
		//   bitbank アプリでも未約定注文として表示される。
		// - UNFILLED: 通常の指値・成行で未約定。
		// - PARTIALLY_FILLED: 部分約定。残量分はまだ生きている。
		// - TRIGGERED: stop がトリガーされ、後続の指値/成行が処理待ち。
		// FULLY_FILLED や CANCELED_* は終端状態なので除外する。
		const ACTIVE_STATUSES = new Set(['INACTIVE', 'UNFILLED', 'PARTIALLY_FILLED', 'TRIGGERED']);

		// 注文データの整形
		const orders = rawData.orders
			.filter((o) => ACTIVE_STATUSES.has(o.status))
			.map((o) => ({
				order_id: o.order_id,
				pair: o.pair,
				side: o.side,
				type: o.type,
				start_amount: o.start_amount,
				remaining_amount: o.remaining_amount,
				executed_amount: o.executed_amount,
				price: o.price,
				average_price: o.average_price,
				status: o.status,
				ordered_at: toIsoMs(o.ordered_at) ?? String(o.ordered_at),
				expire_at: o.expire_at ? (toIsoMs(o.expire_at) ?? String(o.expire_at)) : undefined,
			}));

		// サマリー文字列の生成
		const lines: string[] = [];
		const pairLabel = pair ? formatPair(pair) : '全ペア';
		lines.push(`アクティブ注文: ${pairLabel} ${orders.length}件`);

		if (orders.length > 0) {
			lines.push('');

			for (const o of orders) {
				const sideLabel = o.side === 'buy' ? '買' : '売';
				const isJpy = o.pair.includes('jpy');
				const price = o.price ? (isJpy ? formatPrice(Number(o.price)) : o.price) : '成行';
				const remaining = o.remaining_amount ?? '?';
				lines.push(
					`[ID: ${o.order_id}] ${formatPair(o.pair)} ${sideLabel}${o.type} ${remaining} @ ${price} [${o.status}] (${o.ordered_at})`,
				);
			}

			// 集計
			const buyCount = orders.filter((o) => o.side === 'buy').length;
			const sellCount = orders.filter((o) => o.side === 'sell').length;
			lines.push('');
			lines.push(`集計: 買 ${buyCount}件 / 売 ${sellCount}件`);
		} else {
			lines.push('アクティブな注文はありません。');
		}

		const summary = lines.join('\n');

		const data = {
			orders,
			timestamp,
		};

		const meta = {
			fetchedAt: timestamp,
			orderCount: orders.length,
			pair: pair || undefined,
			...(client.lastRateLimit ? { rateLimit: client.lastRateLimit } : {}),
		};

		return GetMyOrdersOutputSchema.parse(ok(summary, data, meta));
	} catch (err) {
		if (err instanceof PrivateApiError) {
			return GetMyOrdersOutputSchema.parse(fail(err.message, err.errorType));
		}
		return GetMyOrdersOutputSchema.parse(
			fail(err instanceof Error ? err.message : '注文情報取得中に予期しないエラーが発生しました', 'upstream_error'),
		);
	}
}

// ── MCP ツール定義（tool-registry から自動収集） ──
export const toolDef: ToolDefinition = {
	name: 'get_my_orders',
	description:
		'[My Orders / Open Orders / Active Orders] 自分の未約定注文一覧（my orders / open orders / active orders / pending）を取得。通貨ペア・期間でフィルタ可能。Private API。',
	inputSchema: GetMyOrdersInputSchema,
	handler: async (args: { pair?: string; count?: number; since?: string; end?: string }) => getMyOrders(args),
};
