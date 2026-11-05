import { nowIso, parseIso8601, toIsoMs } from '../../lib/datetime.js';
import { formatPair, formatPrice } from '../../lib/formatter.js';
import { normalizePairCodes } from '../../lib/pair-code.js';
import { fail, ok } from '../../lib/result.js';
import { type BitbankPrivateClient, getDefaultClient } from '../../src/private/client.js';
import { GetMarginTradeHistoryInputSchema, GetMarginTradeHistoryOutputSchema } from '../../src/private/schemas.js';
import { failPrivateToolError } from '../../src/private/tool-error.js';
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

const PAGE_SIZE = 1000;
const MAX_PAGES = 10;

async function paginateMarginTrades(
	client: BitbankPrivateClient,
	baseParams: Record<string, string>,
	limit: number,
	order: 'asc' | 'desc',
): Promise<{ trades: RawMarginTrade[]; isComplete: boolean }> {
	const all: RawMarginTrade[] = [];
	const seenIds = new Set<number>();
	const cursorKey: 'since' | 'end' = order === 'desc' ? 'end' : 'since';
	let cursor: string | undefined = baseParams[cursorKey];

	for (let page = 0; page < MAX_PAGES; page++) {
		const params: Record<string, string> = {
			...baseParams,
			type: 'margin',
			count: String(PAGE_SIZE),
			order,
			...(cursor ? { [cursorKey]: cursor } : {}),
		};
		const rawData = await client.get<{ trades: RawMarginTrade[] }>('/v1/user/spot/trade_history', params);
		// JPY 建て判定と価格フォーマットが小文字前提なので、取得境界で pair を揃える。
		const batch = normalizePairCodes(rawData.trades || []);
		// type=margin が無視された場合に備え、position_side != null で margin 約定のみに絞る。
		const marginOnly = batch.filter((t) => t.position_side != null);
		const newRecords = marginOnly.filter((t) => !seenIds.has(t.trade_id));
		for (const t of newRecords) seenIds.add(t.trade_id);
		all.push(...newRecords);

		// 終了判定はフィルタ前の生 batch.length を使う。フィルタ後の長さで判定すると、現物比率が高いとき早期終了して次ページの margin 約定を取り逃がす。
		const exhausted = batch.length < PAGE_SIZE;
		if (all.length >= limit) {
			return { trades: all.slice(0, limit), isComplete: exhausted && all.length === limit };
		}
		if (exhausted) {
			return { trades: all.slice(0, limit), isComplete: true };
		}

		// 次ページ: batch 末尾の executed_at をカーソルに（同一 ts のレコードを次ページに含めて再取得し、dedup する）
		const lastTs = batch[batch.length - 1]?.executed_at;
		if (!lastTs) break;
		const nextCursor = String(lastTs);
		// カーソル停滞検知: cursor が前進/後退しない（API が同じ範囲を返し続ける）と無限ループになるので打ち切る
		if (nextCursor === cursor) {
			return { trades: all.slice(0, limit), isComplete: false };
		}
		cursor = nextCursor;
	}

	return { trades: all.slice(0, limit), isComplete: false };
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

		let rawTrades: RawMarginTrade[];
		let isComplete: boolean;

		if (count <= PAGE_SIZE) {
			const params: Record<string, string> = { ...baseParams, type: 'margin' };
			if (count !== 20) params.count = String(count);
			if (order !== 'desc') params.order = order;
			const rawData = await client.get<{ trades: RawMarginTrade[] }>('/v1/user/spot/trade_history', params);
			const rawBatch = normalizePairCodes(rawData.trades);
			rawTrades = rawBatch.filter((t) => t.position_side != null);
			isComplete = rawBatch.length < count;
		} else {
			const result = await paginateMarginTrades(client, baseParams, count, order);
			rawTrades = result.trades;
			isComplete = result.isComplete;
		}

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
		if (!isComplete) {
			lines.push('※ 全件ではなく一部のみ取得されています。API件数上限に達した可能性があります');
		}

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
		'[Margin Trades / 信用約定履歴] 信用取引の約定履歴（新規建て・決済）を取得。通貨ペア・期間・件数でフィルタ可能。決済時の実現損益・利息を含む。注意: since を信用新規建て後に指定すると決済約定のみが返る場合があります。Private API。',
	inputSchema: GetMarginTradeHistoryInputSchema,
	handler: async (args: { pair?: string; count?: number; order?: 'asc' | 'desc'; since?: string; end?: string }) =>
		getMarginTradeHistory(args),
};
