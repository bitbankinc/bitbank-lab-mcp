import { nowIso } from '../../lib/datetime.js';
import { formatPair, formatPrice, formatYenExact } from '../../lib/formatter.js';
import { isJpyQuotedPair } from '../../lib/pair-code.js';
import { fail, ok } from '../../lib/result.js';
import type { RawTrade } from '../../src/handlers/portfolio/types.js';
import { getDefaultClient } from '../../src/private/client.js';
import { GetMyTradeHistoryInputSchema, GetMyTradeHistoryOutputSchema } from '../../src/private/schemas.js';
import { failPrivateToolError } from '../../src/private/tool-error.js';
import {
	completenessNote,
	epochRangeParams,
	fetchFilteredTradeHistory,
	hiddenTradesNote,
	normalizeTradeRow,
	scanBoundaryIso,
	tradesToDisplay,
} from '../../src/private/trade-history.js';
import type { ToolDefinition } from '../../src/tool-definition.js';

// 現物の手数料は売買とも quote 建て。base 建てが非ゼロのときだけ併記する。
function spotFeeInfo(t: { pair: string; fee_amount_quote: string; fee_amount_base: string }): string {
	const [baseAsset, quoteAsset] = t.pair.split('_').map((a) => a.toUpperCase());
	const hasQuote = t.fee_amount_quote !== '' && t.fee_amount_quote != null;
	const quote = !hasQuote
		? null
		: isJpyQuotedPair(t.pair)
			? formatYenExact(Number(t.fee_amount_quote))
			: `${t.fee_amount_quote} ${quoteAsset}`;
	const baseNum = Number(t.fee_amount_base);
	const base = Number.isFinite(baseNum) && baseNum !== 0 ? `${t.fee_amount_base} ${baseAsset}` : null;
	const parts = [quote, base].filter((p): p is string => p != null);
	return parts.length > 0 ? ` 手数料: ${parts.join(' + ')}` : '';
}

export default async function getMyTradeHistory(args: {
	pair?: string;
	count?: number;
	order?: 'asc' | 'desc';
	since?: string;
	end?: string;
}) {
	const { pair, count = 100, order = 'desc', since, end } = args;
	const client = getDefaultClient();

	try {
		const range = epochRangeParams({ since, end });
		if (!range.ok) {
			return GetMyTradeHistoryOutputSchema.parse(fail(range.message, 'validation_error'));
		}
		const baseParams: Record<string, string> = { ...(pair ? { pair } : {}), ...range.params };

		const fetched = await fetchFilteredTradeHistory<RawTrade>(client, {
			baseParams,
			order,
			limit: count,
			keep: (t) => t.position_side == null,
		});
		const rawTrades = fetched.trades;
		const isComplete = fetched.isComplete;

		const timestamp = nowIso();

		const trades = rawTrades.map(normalizeTradeRow);

		const lines: string[] = [];
		const pairLabel = pair ? formatPair(pair) : '全ペア';
		lines.push(`約定履歴: ${pairLabel} ${trades.length}件`);
		const note = completenessNote(fetched, { kept: '現物', excluded: '信用', order, limit: count });
		if (note) lines.push(note);

		if (trades.length > 0) {
			lines.push('');

			const displayTrades = tradesToDisplay(trades, order);
			for (const t of displayTrades) {
				const sideLabel = t.side === 'buy' ? '買' : '売';
				const isJpy = t.pair.includes('jpy');
				const price = isJpy ? formatPrice(Number(t.price)) : t.price;
				lines.push(
					`[trade: ${t.trade_id} / order: ${t.order_id}] ${t.executed_at} ${formatPair(t.pair)} ${sideLabel} ${t.amount} @ ${price} (${t.maker_taker})${spotFeeInfo(t)}`,
				);
			}

			const hiddenNote = hiddenTradesNote(trades.length, displayTrades, order);
			if (hiddenNote) lines.push(hiddenNote);

			const buyCount = trades.filter((t) => t.side === 'buy').length;
			const sellCount = trades.filter((t) => t.side === 'sell').length;
			lines.push('');
			lines.push(`集計: 買 ${buyCount}件 / 売 ${sellCount}件`);
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

		return GetMyTradeHistoryOutputSchema.parse(ok(summary, data, meta));
	} catch (err) {
		return GetMyTradeHistoryOutputSchema.parse(
			failPrivateToolError(err, '約定履歴取得中に予期しないエラーが発生しました'),
		);
	}
}

export const toolDef: ToolDefinition = {
	name: 'get_my_trade_history',
	description:
		'[My Trades / Trade History / Fills] 自分の現物約定履歴（my trades / trade history / fills / executions）を取得。通貨ペア・期間・件数でフィルタ可能。本文に出す明細は新しいほうから 100 件まで（超えた分は件数と、明細を取るときに end に渡す時刻を書く）。Private API。' +
		'※ 本ツールは現物約定専用。信用約定の取得は `get_margin_trade_history` を使う。',
	inputSchema: GetMyTradeHistoryInputSchema,
	handler: async (args: { pair?: string; count?: number; order?: 'asc' | 'desc'; since?: string; end?: string }) =>
		getMyTradeHistory(args),
};
