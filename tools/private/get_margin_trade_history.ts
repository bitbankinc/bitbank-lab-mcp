import { nowIso, parseIso8601, toIsoMs } from '../../lib/datetime.js';
import { formatPair, formatPrice, formatYenExact } from '../../lib/formatter.js';
import { fail, ok } from '../../lib/result.js';
import { getDefaultClient } from '../../src/private/client.js';
import { GetMarginTradeHistoryInputSchema, GetMarginTradeHistoryOutputSchema } from '../../src/private/schemas.js';
import { failPrivateToolError } from '../../src/private/tool-error.js';
import {
	completenessNote,
	fetchFilteredTradeHistory,
	hiddenTradesNote,
	scanBoundaryIso,
	tradesToDisplay,
} from '../../src/private/trade-history.js';
import type { ToolDefinition } from '../../src/tool-definition.js';

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

function hasValue(v: string | undefined): v is string {
	return v != null && v !== '';
}

// 信用の手数料は決済時にまとめて計上され、決済行の fee_occurred_amount_quote が新規側と決済側の合計になる。
function closeCostInfo(t: { profit_loss?: string; fee_occurred_amount_quote?: string; interest?: string }): string {
	const parts: string[] = [];
	if (hasValue(t.profit_loss)) parts.push(`損益: ${formatYenExact(Number(t.profit_loss))}（手数料控除後）`);
	if (hasValue(t.fee_occurred_amount_quote))
		parts.push(`発生手数料: ${formatYenExact(Number(t.fee_occurred_amount_quote))}`);
	if (hasValue(t.interest)) parts.push(`利息: ${formatYenExact(Number(t.interest))}`);
	return parts.length > 0 ? ` ${parts.join(' / ')}` : '';
}

function openCostInfo(t: { fee_amount_quote: string }): string {
	return hasValue(t.fee_amount_quote) ? ` 手数料: ${formatYenExact(Number(t.fee_amount_quote))}` : '';
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
		const baseParams: Record<string, string> = {};
		if (pair) baseParams.pair = pair;

		if (since) {
			const parsed = parseIso8601(since);
			if (!parsed) {
				return GetMarginTradeHistoryOutputSchema.parse(
					fail(`since の日時形式が不正です: ${since}`, 'validation_error'),
				);
			}
			baseParams.since = String(parsed.valueOf());
		}
		if (end) {
			const parsed = parseIso8601(end);
			if (!parsed) {
				return GetMarginTradeHistoryOutputSchema.parse(fail(`end の日時形式が不正です: ${end}`, 'validation_error'));
			}
			baseParams.end = String(parsed.valueOf());
		}

		const fetched = await fetchFilteredTradeHistory<RawMarginTrade>(client, {
			baseParams,
			order,
			limit: count,
			keep: (t) => t.position_side != null,
		});
		const rawTrades = fetched.trades;
		const isComplete = fetched.isComplete;

		const timestamp = nowIso();

		const trades = rawTrades.map((t) => ({
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

		const lines: string[] = [];
		const pairLabel = pair ? formatPair(pair) : '全ペア';
		lines.push(`信用約定履歴: ${pairLabel} ${trades.length}件`);
		const note = completenessNote(fetched, { kept: '信用', excluded: '現物', order, limit: count });
		if (note) lines.push(note);

		if (trades.length > 0) {
			lines.push('');

			const displayTrades = tradesToDisplay(trades, order);
			let shownClose = false;
			for (const t of displayTrades) {
				const sideLabel = t.side === 'buy' ? '買' : '売';
				const posLabel = t.position_side === 'long' ? 'ロング' : t.position_side === 'short' ? 'ショート' : '';
				const isJpy = t.pair.includes('jpy');
				const price = isJpy ? formatPrice(Number(t.price)) : t.price;
				const isClose =
					(t.side === 'sell' && t.position_side === 'long') || (t.side === 'buy' && t.position_side === 'short');
				const costInfo = isClose ? closeCostInfo(t) : openCostInfo(t);
				if (isClose && t.profit_loss) shownClose = true;
				lines.push(
					`[trade: ${t.trade_id} / order: ${t.order_id}] ${t.executed_at} ${formatPair(t.pair)} ${posLabel}${sideLabel} ${t.amount} @ ${price} (${t.maker_taker})${costInfo}`,
				);
			}

			const hiddenNote = hiddenTradesNote(trades.length, displayTrades, order);
			if (hiddenNote) lines.push(hiddenNote);
			if (shownClose) {
				lines.push(
					'※ 損益（profit_loss）は手数料控除後の値です。発生手数料は新規側と決済側の合計で、決済行にまとめて計上されます。利息（interest）は別に出しています（損益に含まれるかは確認できていません）',
				);
			}

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
			isComplete,
			scanBoundary: scanBoundaryIso(fetched),
			...(client.lastRateLimit ? { rateLimit: client.lastRateLimit } : {}),
		};

		return GetMarginTradeHistoryOutputSchema.parse(ok(summary, data, meta));
	} catch (err) {
		return GetMarginTradeHistoryOutputSchema.parse(
			failPrivateToolError(err, '信用約定履歴取得中に予期しないエラーが発生しました'),
		);
	}
}

export const toolDef: ToolDefinition = {
	name: 'get_margin_trade_history',
	description:
		'[Margin Trades / 信用約定履歴] 信用取引の約定履歴（新規建て・決済）を取得。通貨ペア・期間・件数でフィルタ可能。決済時の実現損益・利息を含む。本文に出す明細は新しいほうから 100 件まで（超えた分は件数と、明細を取るときに end に渡す時刻を書く）。注意: since を信用新規建て後に指定すると決済約定のみが返る場合があります。Private API。',
	inputSchema: GetMarginTradeHistoryInputSchema,
	handler: async (args: { pair?: string; count?: number; order?: 'asc' | 'desc'; since?: string; end?: string }) =>
		getMarginTradeHistory(args),
};
