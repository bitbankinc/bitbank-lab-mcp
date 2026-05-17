/**
 * get_margin_trade_history — 信用取引の約定履歴を取得する Private API ツール。
 *
 * bitbank Private API `/v1/user/spot/trade_history` に `type=margin` を指定し、
 * 信用取引の約定（新規建て・決済）のみを取得して返す。
 *
 * 注意: since を信用新規建て後の日時に指定した場合、
 * 対応する決済約定のみが返される可能性があります。
 */

import { nowIso, parseIso8601, toIsoMs } from '../../lib/datetime.js';
import { formatPair, formatPrice } from '../../lib/formatter.js';
import { fail, ok } from '../../lib/result.js';
import { getDefaultClient, PrivateApiError } from '../../src/private/client.js';
import { GetMarginTradeHistoryInputSchema, GetMarginTradeHistoryOutputSchema } from '../../src/private/schemas.js';
import type { ToolDefinition } from '../../src/tool-definition.js';

/** bitbank /v1/user/spot/trade_history のレスポンス型（信用取引フィルタ時） */
interface RawMarginTrade {
	trade_id: number;
	pair: string;
	order_id: number;
	side: string;
	position_side?: string;
	type: string;
	amount: string;
	price: string;
	maker_taker: string;
	fee_amount_base: string;
	fee_amount_quote: string;
	fee_occurred_amount_quote?: string;
	profit_loss?: string;
	interest?: string;
	executed_at: number;
}

export default async function getMarginTradeHistory(args: {
	pair?: string;
	count?: number;
	order?: 'asc' | 'desc';
	since?: string;
	end?: string;
}) {
	const { pair, count = 20, order = 'desc', since, end } = args;
	const client = getDefaultClient();

	try {
		const params: Record<string, string> = { type: 'margin' };
		if (pair) params.pair = pair;
		if (count !== 20) params.count = String(count);
		if (order !== 'desc') params.order = order;

		// ISO8601 → unix ms 変換
		if (since) {
			const parsed = parseIso8601(since);
			if (!parsed) {
				return GetMarginTradeHistoryOutputSchema.parse(
					fail(`since の日時形式が不正です: ${since}`, 'validation_error'),
				);
			}
			params.since = String(parsed.valueOf());
		}
		if (end) {
			const parsed = parseIso8601(end);
			if (!parsed) {
				return GetMarginTradeHistoryOutputSchema.parse(fail(`end の日時形式が不正です: ${end}`, 'validation_error'));
			}
			params.end = String(parsed.valueOf());
		}

		const rawData = await client.get<{ trades: RawMarginTrade[] }>('/v1/user/spot/trade_history', params);

		const timestamp = nowIso();

		// 公式 docs に type=margin パラメータの記載がなく、API が無視する可能性に備える。
		// position_side は docs 上「信用取引の時のみ」付与されるため、これで margin 約定のみに絞る。
		const marginOnly = rawData.trades.filter((t) => t.position_side != null);

		// 約定データの整形
		const trades = marginOnly.map((t) => ({
			trade_id: t.trade_id,
			pair: t.pair,
			order_id: t.order_id,
			side: t.side,
			position_side: t.position_side,
			type: t.type,
			amount: t.amount,
			price: t.price,
			maker_taker: t.maker_taker,
			fee_amount_base: t.fee_amount_base,
			fee_amount_quote: t.fee_amount_quote,
			fee_occurred_amount_quote: t.fee_occurred_amount_quote,
			profit_loss: t.profit_loss,
			interest: t.interest,
			executed_at: toIsoMs(t.executed_at) ?? String(t.executed_at),
		}));

		// サマリー文字列の生成
		const lines: string[] = [];
		const pairLabel = pair ? formatPair(pair) : '全ペア';
		lines.push(`信用約定履歴: ${pairLabel} ${trades.length}件`);

		if (trades.length > 0) {
			lines.push('');

			const displayTrades = order === 'asc' ? trades.slice(-10) : trades.slice(0, 10);
			for (const t of displayTrades) {
				const sideLabel = t.side === 'buy' ? '買' : '売';
				const posLabel = t.position_side === 'long' ? 'ロング' : t.position_side === 'short' ? 'ショート' : '';
				const isJpy = t.pair.includes('jpy');
				const price = isJpy ? formatPrice(Number(t.price)) : t.price;
				const plInfo = t.profit_loss ? ` 損益: ${formatPrice(Number(t.profit_loss))} 円` : '';
				lines.push(
					`[trade: ${t.trade_id} / order: ${t.order_id}] ${t.executed_at} ${formatPair(t.pair)} ${posLabel}${sideLabel} ${t.amount} @ ${price} (${t.maker_taker})${plInfo}`,
				);
			}

			if (trades.length > 10) {
				lines.push(`... 他 ${trades.length - 10}件`);
			}

			// 集計
			const longCount = trades.filter((t) => t.position_side === 'long').length;
			const shortCount = trades.filter((t) => t.position_side === 'short').length;
			lines.push('');
			lines.push(`集計: ロング ${longCount}件 / ショート ${shortCount}件`);
		}

		const summary = lines.join('\n');

		const data = {
			trades,
			timestamp,
		};

		const meta = {
			fetchedAt: timestamp,
			tradeCount: trades.length,
			pair: pair || undefined,
			...(client.lastRateLimit ? { rateLimit: client.lastRateLimit } : {}),
		};

		return GetMarginTradeHistoryOutputSchema.parse(ok(summary, data, meta));
	} catch (err) {
		if (err instanceof PrivateApiError) {
			return GetMarginTradeHistoryOutputSchema.parse(fail(err.message, err.errorType));
		}
		return GetMarginTradeHistoryOutputSchema.parse(
			fail(err instanceof Error ? err.message : '信用約定履歴取得中に予期しないエラーが発生しました', 'upstream_error'),
		);
	}
}

// ── MCP ツール定義（tool-registry から自動収集） ──
export const toolDef: ToolDefinition = {
	name: 'get_margin_trade_history',
	description:
		'[Margin Trades / 信用約定履歴] 信用取引の約定履歴（新規建て・決済）を取得。通貨ペア・期間・件数でフィルタ可能。決済時の実現損益・利息を含む。注意: since を信用新規建て後に指定すると決済約定のみが返る場合があります。Private API。',
	inputSchema: GetMarginTradeHistoryInputSchema,
	handler: async (args: { pair?: string; count?: number; order?: 'asc' | 'desc'; since?: string; end?: string }) =>
		getMarginTradeHistory(args),
};
