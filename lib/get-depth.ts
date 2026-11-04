import { GetDepthOutputSchema } from '../src/schemas.js';
import { toNum } from './conversions.js';
import { estimateZones } from './depth-analysis.js';
import { formatExactPrice, formatSummary, formatTimestampJST } from './formatter.js';
import { BITBANK_API_BASE, DEFAULT_RETRIES, fetchJsonWithRateLimit } from './http.js';
import { roundMidPrice } from './price.js';
import { fail, failFromError, failFromValidation, ok } from './result.js';
import { createMeta, ensurePair } from './validate.js';

export interface GetDepthOptions {
	timeoutMs?: number;
	maxLevels?: number;
}

export interface BuildDepthTextInput {
	timestamp: number;
	summary: string;
	bids: Array<[unknown, unknown]>;
	asks: Array<[unknown, unknown]>;
	mid: number | null;
}

export function buildDepthText(input: BuildDepthTextInput): string {
	const { timestamp, summary, bids, asks, mid } = input;
	const text = [
		`📸 ${formatTimestampJST(timestamp)}`,
		'',
		summary,
		`板の層数: 買い ${bids.length}層 / 売り ${asks.length}層`,
		mid ? `中値: ${formatExactPrice(mid)}円` : '',
		'',
		`🟢 買い板 (全${bids.length}層):`,
		...bids.map(([p, s]: [unknown, unknown], i: number) => `  ${i + 1}. ${formatExactPrice(Number(p))}円 ${s}`),
		'',
		`🔴 売り板 (全${asks.length}層):`,
		...asks.map(([p, s]: [unknown, unknown], i: number) => `  ${i + 1}. ${formatExactPrice(Number(p))}円 ${s}`),
	]
		.filter(Boolean)
		.join('\n');

	return (
		text +
		`\n\n---\n📌 含まれるもの: 現時点の板（bid/ask全レベル）、壁ゾーン推定` +
		`\n📌 含まれないもの: 板の時系列変化、約定履歴、テクニカル指標、出来高フロー` +
		`\n📌 補完ツール: get_orderbook（分析モード付き板情報）, get_flow_metrics（出来高フロー）, get_transactions（約定履歴）`
	);
}

export default async function getDepth(pair: string, { timeoutMs = 3000, maxLevels = 200 }: GetDepthOptions = {}) {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk);

	const url = `${BITBANK_API_BASE}/${chk.pair}/depth`;
	try {
		const { data: json, rateLimit } = await fetchJsonWithRateLimit(url, { timeoutMs, retries: DEFAULT_RETRIES });
		const jsonObj = json as { success?: number; data?: Record<string, unknown> & { code?: number } };

		// optional chaining のフォールバックに任せると success:0 が空配列として握りつぶされ ok を返すので、明示的に検証する。
		if (jsonObj?.success !== 1) {
			const code = jsonObj?.data?.code;
			const codeStr = code != null ? `（code: ${code}）` : '';
			return GetDepthOutputSchema.parse(fail(`bitbank API がエラーを返却しました${codeStr}`, 'upstream'));
		}

		const d = jsonObj?.data ?? {};
		// 空配列で握りつぶすと下流で原因の特定が困難になるので upstream エラーにする（get_orderbook と揃える）。
		if (!Array.isArray(d.asks) || !Array.isArray(d.bids)) {
			return GetDepthOutputSchema.parse(fail('上流レスポンスに bids/asks が含まれていません', 'upstream'));
		}
		const asks = (d.asks as Array<[unknown, unknown]>).slice(0, maxLevels);
		const bids = (d.bids as Array<[unknown, unknown]>).slice(0, maxLevels);

		// timestamp が欠損したら受信時刻で偽装せず upstream fail に倒す（古いデータを最新に見せない）。
		const tsNum = Number(d.timestamp ?? d.timestamp_ms);
		if (!Number.isFinite(tsNum) || tsNum <= 0) {
			return GetDepthOutputSchema.parse(fail('上流レスポンスに timestamp が含まれていません', 'upstream'));
		}

		// best 気配は finite な数値のみ採用し、mid を NaN 化させない。
		const bestAsk = toNum(asks[0]?.[0]);
		const bestBid = toNum(bids[0]?.[0]);
		const mid = bestBid != null && bestAsk != null ? roundMidPrice(bestBid, bestAsk) : null;
		const summary = formatSummary({
			pair: chk.pair,
			latest: mid ?? undefined,
			extra: `levels: bids=${bids.length} asks=${asks.length}`,
		});

		const data = {
			asks,
			bids,
			asks_over: d.asks_over,
			asks_under: d.asks_under,
			bids_over: d.bids_over,
			bids_under: d.bids_under,
			ask_market: d.ask_market,
			bid_market: d.bid_market,
			timestamp: tsNum,
			sequenceId:
				d.sequenceId != null ? Number(d.sequenceId) : d.sequence_id != null ? Number(d.sequence_id) : undefined,
			overlays: {
				depth_zones: [
					...estimateZones(
						bids.slice(0, 50).map(([p, s]: [unknown, unknown]) => [Number(p), Number(s)] as [number, number]),
						'bid',
					),
					...estimateZones(
						asks.slice(0, 50).map(([p, s]: [unknown, unknown]) => [Number(p), Number(s)] as [number, number]),
						'ask',
					),
				],
			},
		};

		// LLM は structuredContent.data を読めないので全板データを含める。
		const textWithBoundary = buildDepthText({ timestamp: data.timestamp, summary, bids, asks, mid });

		const meta = createMeta(chk.pair, rateLimit ? { rateLimit } : {});
		return GetDepthOutputSchema.parse(
			ok(textWithBoundary, data as Record<string, unknown>, meta as Record<string, unknown>),
		);
	} catch (err: unknown) {
		return failFromError(err, {
			schema: GetDepthOutputSchema,
			timeoutMs,
			defaultType: 'network',
			defaultMessage: 'ネットワークエラー',
		}) as ReturnType<typeof GetDepthOutputSchema.parse>;
	}
}
