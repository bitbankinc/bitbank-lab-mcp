/**
 * get_my_trade_history — 自分の約定履歴を取得する Private API ツール。
 *
 * bitbank Private API `/v1/user/spot/trade_history` を呼び出し、
 * LLM が分析しやすい形に整形して返す。
 *
 * - 自動ページネーション: count > PAGE_SIZE (1000) の場合、`portfolio/fetch.paginateTrades`
 *   経由で cursor ベースに複数回リクエストし全件取得を試みる（最大 MAX_PAGES ページ）。
 * - 単発・ページネーション両経路とも、現物専用のため `position_side != null`（信用約定）の
 *   混入は防御的に除外する（paginateTrades と対称化）。
 * - isComplete フラグ: 全件取得できたかどうかを meta に含める。
 */

import { nowIso, parseIso8601, toIsoMs } from '../../lib/datetime.js';
import { formatPair, formatPrice } from '../../lib/formatter.js';
import { fail, ok } from '../../lib/result.js';
import { paginateTrades } from '../../src/handlers/portfolio/fetch.js';
import type { RawTrade } from '../../src/handlers/portfolio/types.js';
import { getDefaultClient, PrivateApiError } from '../../src/private/client.js';
import { GetMyTradeHistoryInputSchema, GetMyTradeHistoryOutputSchema } from '../../src/private/schemas.js';
import type { ToolDefinition } from '../../src/tool-definition.js';

// bitbank /v1/user/spot/trade_history の 1 リクエスト上限。`paginateTrades` 内の
// `TRADE_PAGE_SIZE` と同値（bitbank API 仕様の制約。`count` がこの値以下なら単発で済む）。
const PAGE_SIZE = 1000;

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
		// クエリパラメータを組み立て
		const baseParams: Record<string, string> = {};
		if (pair) baseParams.pair = pair;

		// ISO8601 → unix ms 変換（strict parse で不正日時を弾く）
		if (since) {
			const parsed = parseIso8601(since);
			if (!parsed) {
				return GetMyTradeHistoryOutputSchema.parse(fail(`since の日時形式が不正です: ${since}`, 'validation_error'));
			}
			baseParams.since = String(parsed.valueOf());
		}
		if (end) {
			const parsed = parseIso8601(end);
			if (!parsed) {
				return GetMyTradeHistoryOutputSchema.parse(fail(`end の日時形式が不正です: ${end}`, 'validation_error'));
			}
			baseParams.end = String(parsed.valueOf());
		}

		let rawTrades: RawTrade[];
		let isComplete: boolean;

		if (count <= PAGE_SIZE) {
			// 単発リクエストで十分なケース
			const params = { ...baseParams, count: String(count), order };
			const rawData = await client.get<{ trades: RawTrade[] }>(
				'/v1/user/spot/trade_history',
				Object.keys(params).length > 0 ? params : undefined,
			);
			const rawBatch = rawData.trades ?? [];
			// 信用約定（position_side 付き）の混入を防御的に除外（paginateTrades と対称）。
			rawTrades = rawBatch.filter((t) => t.position_side == null);
			// isComplete はフィルタ前の API レスポンス件数で判定する。フィルタ後を使うと
			// 信用比率が高いときに「全件取得済み」と誤判定する（paginateTrades と同じ理由）。
			isComplete = rawBatch.length < count;
		} else {
			// 自動ページネーション（order に応じて asc + since / desc + end カーソルで取得）。
			// `position_side != null` の信用約定は paginateTrades 側で防御的に除外される。
			const result = await paginateTrades(client, { baseParams, order, limit: count });
			rawTrades = result.trades;
			isComplete = !result.truncated;
		}

		const timestamp = nowIso();

		// 約定データの整形
		const trades = rawTrades.map((t) => ({
			trade_id: t.trade_id,
			pair: t.pair,
			order_id: t.order_id,
			side: t.side,
			// 上流で position_side != null の信用約定はフィルタ済みのため通常は undefined。
			// 型整合のためフィールドは残し、`position_side` の存在で現物 / 信用を識別する下流契約を維持する。
			position_side: t.position_side,
			type: t.type,
			amount: t.amount,
			price: t.price,
			maker_taker: t.maker_taker,
			fee_amount_base: t.fee_amount_base,
			fee_amount_quote: t.fee_amount_quote,
			fee_occurred_amount_quote: t.fee_occurred_amount_quote,
			executed_at: toIsoMs(t.executed_at) ?? String(t.executed_at),
		}));

		// サマリー文字列の生成
		const lines: string[] = [];
		const pairLabel = pair ? formatPair(pair) : '全ペア';
		lines.push(`約定履歴: ${pairLabel} ${trades.length}件`);
		if (!isComplete) {
			lines.push('※ 全件ではなく一部のみ取得されています。API件数上限に達した可能性があります');
		}

		if (trades.length > 0) {
			lines.push('');

			// サマリーに表示する約定（最大10件）
			// desc（デフォルト）: 先頭が直近なのでそのまま slice
			// asc: 末尾が直近なので末尾10件を取得
			const displayTrades = order === 'asc' ? trades.slice(-10) : trades.slice(0, 10);
			for (const t of displayTrades) {
				const sideLabel = t.side === 'buy' ? '買' : '売';
				const isJpy = t.pair.includes('jpy');
				const price = isJpy ? formatPrice(Number(t.price)) : t.price;
				lines.push(
					`[trade: ${t.trade_id} / order: ${t.order_id}] ${t.executed_at} ${formatPair(t.pair)} ${sideLabel} ${t.amount} @ ${price} (${t.maker_taker})`,
				);
			}

			if (trades.length > 10) {
				lines.push(`... 他 ${trades.length - 10}件`);
			}

			// 集計情報
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
			...(client.lastRateLimit ? { rateLimit: client.lastRateLimit } : {}),
		};

		return GetMyTradeHistoryOutputSchema.parse(ok(summary, data, meta));
	} catch (err) {
		if (err instanceof PrivateApiError) {
			return GetMyTradeHistoryOutputSchema.parse(fail(err.message, err.errorType));
		}
		return GetMyTradeHistoryOutputSchema.parse(
			fail(err instanceof Error ? err.message : '約定履歴取得中に予期しないエラーが発生しました', 'upstream_error'),
		);
	}
}

// ── MCP ツール定義（tool-registry から自動収集） ──
export const toolDef: ToolDefinition = {
	name: 'get_my_trade_history',
	description:
		'[My Trades / Trade History / Fills] 自分の現物約定履歴（my trades / trade history / fills / executions）を取得。通貨ペア・期間・件数でフィルタ可能。Private API。' +
		'※ 本ツールは現物約定専用。信用約定の取得は `get_margin_trade_history` を使う。',
	inputSchema: GetMyTradeHistoryInputSchema,
	handler: async (args: { pair?: string; count?: number; order?: 'asc' | 'desc'; since?: string; end?: string }) =>
		getMyTradeHistory(args),
};
