import type { z } from 'zod';
import { toNum } from '../lib/conversions.js';
import { dayjs, toIsoMs } from '../lib/datetime.js';
import { formatPair, formatPrice } from '../lib/formatter.js';
import { BITBANK_API_BASE, DEFAULT_RETRIES, fetchJsonWithRateLimit } from '../lib/http.js';
import { fail, failFromError, failFromValidation, ok } from '../lib/result.js';
import { isArchiveExpectedPublished } from '../lib/tx-archive.js';
import { createMeta, ensurePair, validateLimit } from '../lib/validate.js';
import {
	type GetTransactionsDataSchemaOut,
	GetTransactionsInputSchema,
	type GetTransactionsMetaSchemaOut,
	GetTransactionsOutputSchema,
} from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';

type TxnRaw = Record<string, unknown>;

function toMs(input: unknown): number | null {
	const n = toNum(input);
	if (n == null) return null;
	return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
}

function normalizeSide(v: unknown): 'buy' | 'sell' | null {
	const s = String(v ?? '')
		.trim()
		.toLowerCase();
	if (s === 'buy') return 'buy';
	if (s === 'sell') return 'sell';
	return null;
}

type NormalizedTxn = {
	transaction_id?: number;
	price: number;
	amount: number;
	side: 'buy' | 'sell';
	timestampMs: number;
	isoTime: string;
};

/**
 * 取引サマリを生成
 */
function formatTransactionsSummary(pair: string, transactions: NormalizedTxn[], buys: number, sells: number): string {
	const pairDisplay = formatPair(pair);
	const baseCurrency = pair.split('_')[0]?.toUpperCase() ?? '';
	const lines: string[] = [];

	const fmtPx = (price: number) => formatPrice(price, pair);

	const formatTime = (ms: number): string => {
		return dayjs(ms).tz('Asia/Tokyo').format('HH:mm:ss');
	};

	lines.push(`${pairDisplay} 直近取引 ${transactions.length}件`);

	if (transactions.length > 0) {
		const latestTxn = transactions[transactions.length - 1];
		lines.push(`最新約定: ${fmtPx(latestTxn.price)}`);

		// 買い/売り比率
		const total = buys + sells;
		const buyRatio = total > 0 ? Math.round((buys / total) * 100) : 0;
		const sellRatio = 100 - buyRatio;
		const dominant = buyRatio >= 60 ? '買い優勢' : buyRatio <= 40 ? '売り優勢' : '拮抗';
		const dominantRatio = buyRatio >= 60 ? buyRatio : buyRatio <= 40 ? sellRatio : buyRatio;
		lines.push(`買い: ${buys}件 / 売り: ${sells}件（${dominant} ${dominantRatio}%）`);

		// 出来高合計
		const totalVolume = transactions.reduce((sum, t) => sum + t.amount, 0);
		const volStr = totalVolume >= 1 ? totalVolume.toFixed(4) : totalVolume.toFixed(6);
		lines.push(`出来高: ${volStr} ${baseCurrency}`);

		// 期間
		const oldest = transactions[0];
		const newest = transactions[transactions.length - 1];
		lines.push(`期間: ${formatTime(oldest.timestampMs)}〜${formatTime(newest.timestampMs)}`);
	}

	return lines.join('\n');
}

/** 約定行を LLM 可視テキスト（content）用に整形する。default view / filter view で共用。 */
function buildTxLines(transactions: NormalizedTxn[]): string[] {
	return transactions.map((t, i) => {
		const time = dayjs(t.timestampMs).tz('Asia/Tokyo').format('HH:mm:ss');
		const idPart = t.transaction_id != null ? ` id:${t.transaction_id}` : '';
		return `[${i}]${idPart} ${time} ${t.side} ${t.price} x${t.amount}`;
	});
}

/** get_transactions が返すデータの「含む/含まない」と補完ツールの定型フッター。 */
const TX_SCOPE_FOOTER =
	`\n\n---\n📌 含まれるもの: 個別約定（時刻・売買方向・価格・数量）、買い/売り件数比率` +
	`\n📌 含まれないもの: 集計済みフロー指標（CVD・Zスコア・スパイク）、OHLCV、板情報` +
	`\n📌 補完ツール: get_flow_metrics（集計フロー・CVD・スパイク検出）, get_candles（OHLCV）, get_orderbook（板情報）`;

export default async function getTransactions(pair: string = 'btc_jpy', limit: number = 60, date?: string) {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk, GetTransactionsOutputSchema);

	const lim = validateLimit(limit, 1, 1000);
	if (!lim.ok) return failFromValidation(lim, GetTransactionsOutputSchema);

	const url =
		date && /^\d{8}$/.test(String(date))
			? `${BITBANK_API_BASE}/${chk.pair}/transactions/${date}`
			: `${BITBANK_API_BASE}/${chk.pair}/transactions`;

	try {
		const { data: json, rateLimit } = await fetchJsonWithRateLimit(url, { timeoutMs: 4000, retries: DEFAULT_RETRIES });
		const jsonObj = json as { success?: number; data?: { transactions?: TxnRaw[]; code?: number } };

		// 上流レスポンスの success フラグを明示的に検証する。
		// 公式 API は { success: 0|1, data: ... } 形式で、エラー時は success:0 を返す。
		// optional chaining のフォールバックに任せると空配列として握りつぶされ ok を返してしまう。
		if (jsonObj?.success !== 1) {
			const code = jsonObj?.data?.code;
			const codeStr = code != null ? `（code: ${code}）` : '';
			return GetTransactionsOutputSchema.parse(fail(`bitbank API がエラーを返却しました${codeStr}`, 'upstream'));
		}

		const arr: TxnRaw[] = (jsonObj?.data?.transactions ?? []) as TxnRaw[];

		let droppedCount = 0;
		const items = arr
			.map((t) => {
				const txId = toNum(t.transaction_id ?? t.id);
				const price = toNum(t.price);
				const amount = toNum(t.amount ?? t.size);
				const side = normalizeSide(t.side);
				const ms = toMs(t.executed_at ?? t.timestamp ?? t.date);
				const isoTime = toIsoMs(ms);
				if (price == null || amount == null || side == null || isoTime == null) {
					droppedCount++;
					return null;
				}
				return {
					...(txId != null ? { transaction_id: txId } : {}),
					price,
					amount,
					side,
					timestampMs: ms as number,
					isoTime,
				};
			})
			.filter(Boolean) as NormalizedTxn[];

		const warningText =
			droppedCount > 0
				? `⚠️ 上流レスポンスから ${droppedCount}件 の不正な約定行を除外しました（price/amount/side/timestamp のいずれかが欠損または不正）`
				: undefined;

		const sorted = items.sort((a, b) => a.timestampMs - b.timestampMs);
		const latest = sorted.slice(-lim.value);

		const buys = latest.filter((t) => t.side === 'buy').length;
		const sells = latest.filter((t) => t.side === 'sell').length;
		const baseSummary = formatTransactionsSummary(chk.pair, latest, buys, sells);
		// テキスト summary に全取引データを含める（LLM が structuredContent.data を読めない対策）
		const txLines = buildTxLines(latest);
		const summary =
			baseSummary +
			(warningText ? `\n\n${warningText}` : '') +
			`\n\n📋 全${latest.length}件の取引:\n` +
			txLines.join('\n') +
			TX_SCOPE_FOOTER;

		const data = { raw: json, normalized: latest };
		const meta = createMeta(chk.pair, {
			count: latest.length,
			source: date ? 'by_date' : 'latest',
			...(rateLimit ? { rateLimit } : {}),
			...(warningText ? { warning: warningText } : {}),
		});
		return GetTransactionsOutputSchema.parse(
			ok<z.infer<typeof GetTransactionsDataSchemaOut>, z.infer<typeof GetTransactionsMetaSchemaOut>>(
				summary,
				data,
				meta as z.infer<typeof GetTransactionsMetaSchemaOut>,
			),
		);
	} catch (e: unknown) {
		// 失敗時は叩いた URL をエラーメッセージに含め、呼び出し側で原因を特定しやすくする。
		// ただし AbortError は failFromError 側の timeout 判定で必要なのでそのまま渡す。
		if (e instanceof Error && e.name === 'AbortError') {
			return failFromError(e, {
				schema: GetTransactionsOutputSchema,
				timeoutMs: 4000,
				defaultType: 'network',
				defaultMessage: `ネットワークエラー [url: ${url}]`,
			});
		}
		const baseMsg = e instanceof Error && e.message ? e.message : typeof e === 'string' ? e : 'ネットワークエラー';
		// 進行中・未来の UTC 日のアーカイブ 404 は bitbank 側の仕様（UTC 暦日完了後に公開）。
		// 「なぜ 404 か」を呼び出し側で診断できるようヒントを付与する。
		// URL 生成（上記）と同じ形式判定に揃える: YYYYMMDD 形式でない date は latest エンドポイントに
		// フォールバックしており、その 404 にアーカイブ未公開ヒントを付けると誤誘導になる。
		const isDateArchiveRequest = date != null && /^\d{8}$/.test(String(date));
		const archiveHint =
			isDateArchiveRequest && /404/.test(baseMsg) && !isArchiveExpectedPublished(String(date))
				? `（/transactions/{YYYYMMDD} は UTC 暦日アーカイブで、date=${date} は UTC ではまだ完了していないため未公開です。直近の約定は date 省略の latest を使用してください）`
				: '';
		const wrapped = new Error(`${baseMsg} [url: ${url}]${archiveHint}`);
		return failFromError(wrapped, {
			schema: GetTransactionsOutputSchema,
			timeoutMs: 4000,
			defaultType: 'network',
			defaultMessage: `ネットワークエラー [url: ${url}]`,
		});
	}
}

// ── MCP ツール定義（tool-registry から自動収集） ──
export const toolDef: ToolDefinition = {
	name: 'get_transactions',
	description:
		'[Transactions / Trades] 市場の約定履歴（transactions / recent trades）を取得。直近60件 or 日付指定。金額・価格でフィルタ可能。' +
		'\n\n制約（bitbank 側仕様）: date 指定（YYYYMMDD）は UTC 暦日アーカイブで、当該 UTC 日の完了後（JST 09:00 以降）にのみ公開される。進行中の UTC 日を指定すると 404。当日分の約定は date 省略（latest, 直近約60件）でのみ取得可能。',
	inputSchema: GetTransactionsInputSchema,
	handler: async ({
		pair,
		limit,
		date,
		minAmount,
		maxAmount,
		minPrice,
		maxPrice,
		view,
	}: {
		pair?: string;
		limit?: number;
		date?: string;
		minAmount?: number;
		maxAmount?: number;
		minPrice?: number;
		maxPrice?: number;
		view?: 'summary' | 'items';
	}) => {
		const res = await getTransactions(pair, limit, date);
		if (!res?.ok) return res;
		const hasFilter = minAmount != null || maxAmount != null || minPrice != null || maxPrice != null;
		type TxItem = {
			transaction_id?: number;
			price: number;
			amount: number;
			side: 'buy' | 'sell';
			timestampMs: number;
			isoTime: string;
		};
		const items = (res?.data?.normalized ?? ([] as TxItem[])).filter(
			(t: TxItem) =>
				(minAmount == null || t.amount >= minAmount) &&
				(maxAmount == null || t.amount <= maxAmount) &&
				(minPrice == null || t.price >= minPrice) &&
				(maxPrice == null || t.price <= maxPrice),
		);
		const fBuys = items.filter((t: TxItem) => t.side === 'buy').length;
		const fSells = items.filter((t: TxItem) => t.side === 'sell').length;
		const warningBlock = res.meta?.warning ? `\n\n${res.meta.warning}` : '';
		// フィルタ時も個別約定行を summary に含める。content[0].text しか LLM に見えないため、
		// 件数だけだとどの約定がヒットしたか不可視になる（非フィルタ経路と同じ並びで出す）。
		const filteredBody =
			items.length > 0 ? `\n\n📋 フィルタ後 ${items.length}件の取引:\n${buildTxLines(items).join('\n')}` : '';
		const summary = hasFilter
			? `${formatPair(pair ?? 'btc_jpy')} フィルタ後 ${items.length}件 (buy=${fBuys} sell=${fSells})${warningBlock}${filteredBody}${TX_SCOPE_FOOTER}`
			: res.summary;
		if (view === 'items') {
			const text = JSON.stringify(items, null, 2);
			const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text }];
			if (res.meta?.warning) {
				content.push({ type: 'text', text: res.meta.warning });
			}
			return {
				content,
				structuredContent: { ...res, summary, data: { ...res.data, normalized: items } } as Record<string, unknown>,
			};
		}
		return { ...res, summary, data: { ...res.data, normalized: items } };
	},
};
