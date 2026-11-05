import { toNum } from '../lib/conversions.js';
import { toDisplayTime, toIsoTime } from '../lib/datetime.js';
import { formatPair, formatPercent, formatPrice } from '../lib/formatter.js';
import { BITBANK_API_BASE, DEFAULT_RETRIES, fetchJsonWithRateLimit } from '../lib/http.js';
import { fail, failFromError, failFromValidation, ok, parseAsResult } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import type { FailResult, GetTickerData, GetTickerMeta, OkResult } from '../src/schemas.js';
import { GetTickerInputSchema, GetTickerOutputSchema } from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';

export interface GetTickerOptions {
	timeoutMs?: number;
}

function formatTickerSummary(pair: string, d: Record<string, unknown>): string {
	const pairDisplay = formatPair(pair);

	const last = toNum(d.last);
	const open = toNum(d.open);
	const high = toNum(d.high);
	const low = toNum(d.low);
	const buy = toNum(d.buy);
	const sell = toNum(d.sell);
	const vol = toNum(d.vol);

	const baseCurrency = pair.split('_')[0]?.toUpperCase() ?? '';

	const fmtPx = (v: number | null) => formatPrice(v, pair);

	let changeStr = '';
	if (last !== null && open !== null && open !== 0) {
		const changePct = ((last - open) / open) * 100;
		changeStr = formatPercent(changePct, { sign: true, digits: 2 });
	}

	let spreadStr = '';
	if (buy !== null && sell !== null) {
		spreadStr = fmtPx(sell - buy);
	}

	const formatVolume = (v: number | null): string => {
		if (v === null) return 'N/A';
		if (v >= 1000) {
			return `${(v / 1000).toFixed(2)}K ${baseCurrency}`;
		}
		return `${v.toFixed(4)} ${baseCurrency}`;
	};

	const lines: string[] = [];
	lines.push(`${pairDisplay} 現在値: ${fmtPx(last)}`);
	lines.push(`24h: 始値 ${fmtPx(open)} / 高値 ${fmtPx(high)} / 安値 ${fmtPx(low)}`);
	if (changeStr) {
		lines.push(`24h変動: ${changeStr}`);
	}
	lines.push(`出来高: ${formatVolume(vol)}`);
	lines.push(`Bid: ${fmtPx(buy)} / Ask: ${fmtPx(sell)}${spreadStr ? `（スプレッド: ${spreadStr}）` : ''}`);

	const tsNum = toNum(d.timestamp);
	const timeStr = tsNum != null ? toDisplayTime(tsNum) : null;
	if (timeStr) lines.push(`📸 ${timeStr} 時点`);

	return lines.join('\n');
}

export default async function getTicker(
	pair: string,
	{ timeoutMs = 5000 }: GetTickerOptions = {},
): Promise<OkResult<GetTickerData, GetTickerMeta> | FailResult> {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk);

	const url = `${BITBANK_API_BASE}/${chk.pair}/ticker`;

	try {
		const { data: json, rateLimit } = await fetchJsonWithRateLimit(url, { timeoutMs, retries: DEFAULT_RETRIES });
		const jsonObj = json as { success?: number; data?: Record<string, unknown> };

		if (jsonObj?.success !== 1 || !jsonObj?.data || typeof jsonObj.data !== 'object') {
			return fail('上流レスポンスが不正です', 'upstream');
		}

		const d = jsonObj.data;
		const summary = formatTickerSummary(chk.pair, d);

		const tsNum = toNum(d.timestamp);
		const data: GetTickerData = {
			raw: json,
			normalized: {
				pair: chk.pair,
				last: toNum(d.last),
				buy: toNum(d.buy),
				sell: toNum(d.sell),
				open: toNum(d.open),
				high: toNum(d.high),
				low: toNum(d.low),
				volume: toNum(d.vol),
				timestamp: tsNum,
				isoTime: tsNum != null ? toIsoTime(tsNum) : null,
			},
		};

		const meta = createMeta(chk.pair, rateLimit ? { rateLimit } : {});
		return parseAsResult<GetTickerData, GetTickerMeta>(GetTickerOutputSchema, ok(summary, data, meta));
	} catch (err: unknown) {
		return failFromError(err, {
			schema: GetTickerOutputSchema,
			timeoutMs,
			defaultType: 'network',
			defaultMessage: 'ネットワークエラー',
		});
	}
}

export const toolDef: ToolDefinition = {
	name: 'get_ticker',
	description:
		'[Ticker / Price] 単一ペアのティッカー（ticker / price / 24h change）を取得。現在価格・出来高・24h高安。',
	inputSchema: GetTickerInputSchema,
	handler: async ({ pair }: { pair?: string }) => getTicker(pair ?? 'btc_jpy'),
};
