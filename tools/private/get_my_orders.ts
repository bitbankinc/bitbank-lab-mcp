import { nowIso, parseIso8601, toIsoMs } from '../../lib/datetime.js';
import { formatOrderPositionLabel, formatPair, formatPrice } from '../../lib/formatter.js';
import { normalizePairCodes } from '../../lib/pair-code.js';
import { fail, ok, toStructured } from '../../lib/result.js';
import { getDefaultClient } from '../../src/private/client.js';
import { GetMyOrdersInputSchema, GetMyOrdersOutputSchema } from '../../src/private/schemas.js';
import { failPrivateToolError } from '../../src/private/tool-error.js';
import type { ToolDefinition } from '../../src/tool-definition.js';

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
		const params: Record<string, string> = {};
		if (pair) params.pair = pair;
		if (count !== 100) params.count = String(count);

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

		// active_orders は稀に CANCELED_UNFILLED 等の非アクティブな注文も返すので、ユーザーから見てまだ生きている注文だけに絞る（INACTIVE は stop のトリガー前、TRIGGERED は後続注文の処理待ち）。
		const ACTIVE_STATUSES = new Set(['INACTIVE', 'UNFILLED', 'PARTIALLY_FILLED', 'TRIGGERED']);

		// 下の JPY 判定（`o.pair.includes('jpy')`）が価格フォーマットを決めるので、取得境界で pair を小文字化してから整形する。
		const orders = normalizePairCodes(rawData.orders)
			.filter((o) => ACTIVE_STATUSES.has(o.status))
			.map((o) => ({
				order_id: o.order_id,
				pair: o.pair,
				side: o.side,
				position_side: o.position_side,
				type: o.type,
				start_amount: o.start_amount,
				remaining_amount: o.remaining_amount,
				executed_amount: o.executed_amount,
				price: o.price,
				average_price: o.average_price,
				status: o.status,
				ordered_at: toIsoMs(o.ordered_at) ?? String(o.ordered_at),
				expire_at: o.expire_at ? (toIsoMs(o.expire_at) ?? String(o.expire_at)) : undefined,
				post_only: o.post_only,
				user_cancelable: o.user_cancelable,
				trigger_price: o.trigger_price,
				triggered_at: o.triggered_at != null ? (toIsoMs(Number(o.triggered_at)) ?? String(o.triggered_at)) : undefined,
			}));

		const lines: string[] = [];
		const pairLabel = pair ? formatPair(pair) : '全ペア';
		lines.push(`アクティブ注文: ${pairLabel} ${orders.length}件`);

		if (orders.length > 0) {
			lines.push('');

			for (const o of orders) {
				const sideLabel = o.side === 'buy' ? '買' : '売';
				const posLabel = formatOrderPositionLabel(o.position_side);
				const isJpy = o.pair.includes('jpy');
				const price = o.price ? (isJpy ? formatPrice(Number(o.price)) : o.price) : '成行';
				const remaining = o.remaining_amount ?? '?';
				const trig = o.trigger_price
					? ` トリガー:${isJpy ? formatPrice(Number(o.trigger_price)) : o.trigger_price}`
					: '';
				lines.push(
					`[ID: ${o.order_id}] ${formatPair(o.pair)} ${posLabel}${sideLabel}${o.type} ${remaining} @ ${price}${trig} [${o.status}] (${o.ordered_at})`,
				);
			}

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
		return GetMyOrdersOutputSchema.parse(failPrivateToolError(err, '注文情報取得中に予期しないエラーが発生しました'));
	}
}

export const toolDef: ToolDefinition = {
	name: 'get_my_orders',
	description:
		'[My Orders / Open Orders / Active Orders] 自分の未約定注文一覧（my orders / open orders / active orders / pending）を取得。通貨ペア・期間でフィルタ可能。Private API。' +
		'※ 本ツールは現物注文専用。信用注文の照会は `get_margin_positions` / 信用系ツールを使う。',
	inputSchema: GetMyOrdersInputSchema,
	handler: async (args) => {
		const result = await getMyOrders(args as { pair?: string; count?: number; since?: string; end?: string });
		if (!result.ok) return result;
		const text = `${result.summary}\n${JSON.stringify(result.data, null, 2)}`;
		return {
			content: [{ type: 'text', text }],
			structuredContent: toStructured(result),
		};
	},
};
