/**
 * get_margin_trade_history — 信用取引の約定履歴を取得する Private API ツール。
 *
 * bitbank Private API `/v1/user/spot/trade_history` に `type=margin` を指定し、
 * 信用取引の約定（新規建て・決済）のみを取得して返す。
 *
 * - 自動ページネーション: count > PAGE_SIZE (1000) の場合、cursor ベースで
 *   複数回リクエストし全件取得を試みる（最大 MAX_PAGES ページ）。
 * - 現物混入フィルタ: `type=margin` が API に無視された場合に備え、
 *   レスポンスから `position_side != null` で margin 約定のみに絞る。
 * - isComplete フラグ: 全件取得できたかどうかを meta に含める。
 *
 * 注意: since を信用新規建て後の日時に指定した場合、
 * 対応する決済約定のみが返される可能性があります。
 */

import { nowIso, parseIso8601, toIsoMs } from '../../lib/datetime.js';
import { formatPair, formatPrice } from '../../lib/formatter.js';
import { fail, ok } from '../../lib/result.js';
import { type BitbankPrivateClient, getDefaultClient, PrivateApiError } from '../../src/private/client.js';
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

// ── ページネーション設定 ──
const PAGE_SIZE = 1000;
const MAX_PAGES = 10;

/**
 * cursor ベースの自動ページネーション（asc 順で取得し、最後の executed_at を次ページ since に）。
 *
 * `paginateTrades` (get_my_trade_history) との違い:
 * - `type=margin` を毎回付与し、レスポンスから `position_side != null` で margin のみに絞る
 *   （API が type=margin を無視するケースへの保険、fetch.ts:paginateMarginTrades と同じ）。
 * - 終了条件はフィルタ前の生 batch.length で判定する（フィルタ後の長さで判定すると、
 *   現物比率が高いとき早期終了して次ページの信用約定を取り逃がす）。
 * - カーソル前進有無で進捗停止を検出する（同一ミリ秒の境界レコードでループしないよう）。
 *
 * 同一ミリ秒の境界レコードを取りこぼさないため、since はインクリメントせず、
 * trade_id で重複排除する。since/end が外部指定されている場合でもページネーションする。
 */
async function paginateMarginTrades(
	client: BitbankPrivateClient,
	baseParams: Record<string, string>,
	limit: number,
): Promise<{ trades: RawMarginTrade[]; isComplete: boolean }> {
	const all: RawMarginTrade[] = [];
	const seenIds = new Set<number>();
	let since: string | undefined = baseParams.since;

	for (let page = 0; page < MAX_PAGES; page++) {
		const params: Record<string, string> = {
			...baseParams,
			type: 'margin',
			count: String(PAGE_SIZE),
			order: 'asc',
			...(since ? { since } : {}),
		};
		const rawData = await client.get<{ trades: RawMarginTrade[] }>('/v1/user/spot/trade_history', params);
		const batch = rawData.trades || [];
		// type=margin が無視された場合に備え、position_side != null で margin 約定のみに絞る。
		const marginOnly = batch.filter((t) => t.position_side != null);
		const newRecords = marginOnly.filter((t) => !seenIds.has(t.trade_id));
		for (const t of newRecords) seenIds.add(t.trade_id);
		all.push(...newRecords);

		// 終了判定はフィルタ前の生 batch.length を使う。フィルタ後の長さで判定すると、
		// 現物比率が高いとき早期終了して次ページの margin 約定を取り逃がす。
		if (batch.length < PAGE_SIZE) {
			return { trades: all.slice(0, limit), isComplete: true };
		}

		// limit に達したら打ち切り。count を満たしただけで、期間内に未取得レコードがある可能性があるため isComplete=false
		if (all.length >= limit) {
			return { trades: all.slice(0, limit), isComplete: false };
		}

		// 次ページ: 最後の約定の executed_at を since に（同一 ts のレコードを次ページに含めて再取得し、dedup する）
		const lastTs = batch[batch.length - 1]?.executed_at;
		if (!lastTs) break;
		const nextSince = String(lastTs);
		// カーソル停滞検知: since が前進しない（API が同じ範囲を返し続ける）と無限ループになるので打ち切る
		if (nextSince === since) {
			return { trades: all.slice(0, limit), isComplete: false };
		}
		since = nextSince;
	}

	// MAX_PAGES 到達 → 打ち切り
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

		// ISO8601 → unix ms 変換
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

		// ページネーションは内部で asc 固定で取得するので、ユーザーが desc を要求している場合は逆順にする。
		// 単発リクエストは API に order をそのまま渡すため逆順処理は不要（API レスポンスを尊重）。
		let usedPagination = false;
		if (count <= PAGE_SIZE) {
			// 単発リクエスト
			const params: Record<string, string> = { ...baseParams, type: 'margin' };
			if (count !== 20) params.count = String(count);
			if (order !== 'desc') params.order = order;
			const rawData = await client.get<{ trades: RawMarginTrade[] }>('/v1/user/spot/trade_history', params);
			// 公式 docs に type=margin パラメータの記載がなく、API が無視する可能性に備える。
			// position_side は docs 上「信用取引の時のみ」付与されるため、これで margin 約定のみに絞る。
			rawTrades = rawData.trades.filter((t) => t.position_side != null);
			// API 窓内の margin 約定を全部もらったかどうかは生 batch.length で判定する
			// （フィルタ後の長さで判定すると、現物比率が高いとき誤って打ち切る）。
			isComplete = rawData.trades.length < count;
		} else {
			// 自動ページネーション
			usedPagination = true;
			const result = await paginateMarginTrades(client, baseParams, count);
			rawTrades = result.trades;
			isComplete = result.isComplete;
		}

		const timestamp = nowIso();

		// 約定データの整形
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

		// ページネーション経由の場合は asc 固定で取得しているので、desc 要求なら逆順に並べ直す。
		if (usedPagination && order === 'desc') {
			trades.reverse();
		}

		// サマリー文字列の生成
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
			isComplete,
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
