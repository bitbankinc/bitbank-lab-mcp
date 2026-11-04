import { toNum } from '../lib/conversions.js';
import { toIsoTime } from '../lib/datetime.js';
import { estimateZones } from '../lib/depth-analysis.js';
import { formatExactPrice, formatPriceDecimals, formatSummary, formatTimestampJST } from '../lib/formatter.js';
import { BITBANK_API_BASE, DEFAULT_RETRIES, fetchJsonWithRateLimit } from '../lib/http.js';
import { midPriceDecimals, roundMidPrice, roundSpread } from '../lib/price.js';
import { fail, failFromError, failFromValidation, ok, parseAsResult } from '../lib/result.js';
import { createMeta, ensurePair, validateLimit } from '../lib/validate.js';
import type { GetOrderbookData, GetOrderbookMeta, OrderbookLevelWithCum } from '../src/schemas.js';
import { GetOrderbookInputSchema, GetOrderbookOutputSchema } from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';

export type OrderbookMode = 'summary' | 'pressure' | 'statistics' | 'raw';

export interface GetOrderbookParams {
	pair?: string;
	mode?: OrderbookMode;
	topN?: number;
	bandsPct?: number[];
	ranges?: number[];
	priceZones?: number;
	maxLevels?: number;
	timeoutMs?: number;
}

type RawLevel = [string, string]; // [price, size] from API
type NumLevel = [number, number]; // [price, size] parsed

// /depth は値を string で返すので、壊れた値は NaN になって Math.max/min・Zod parse・表示まで伝播する。prepare_depth_data の toFiniteTuples と同じ防御を全 mode の入口で行う。
function toFiniteRawLevels(raw: RawLevel[]): { rows: RawLevel[]; dropped: number } {
	let dropped = 0;
	const rows: RawLevel[] = [];
	for (const lvl of raw) {
		if (Number.isFinite(Number(lvl?.[0])) && Number.isFinite(Number(lvl?.[1]))) {
			rows.push(lvl);
		} else {
			dropped++;
		}
	}
	return { rows, dropped };
}

function toLevelsWithCum(levels: NumLevel[], n: number): OrderbookLevelWithCum[] {
	const out = levels.slice(0, n).map(([price, size]) => ({ price, size, cumSize: 0 }));
	let cum = 0;
	for (const lvl of out) {
		cum += Number.isFinite(lvl.size) ? lvl.size : 0;
		lvl.cumSize = Number(cum.toFixed(8));
	}
	return out;
}

function buildSummary(pair: string, bidsNum: NumLevel[], asksNum: NumLevel[], topN: number, timestamp: number) {
	const bids = toLevelsWithCum(bidsNum, topN);
	const asks = toLevelsWithCum(asksNum, topN);

	const bestAsk = asks[0]?.price ?? null;
	const bestBid = bids[0]?.price ?? null;
	const spread = bestAsk != null && bestBid != null ? roundSpread(bestBid, bestAsk) : null;
	const mid = bestAsk != null && bestBid != null ? roundMidPrice(bestBid, bestAsk) : null;

	const summary = formatSummary({
		pair,
		latest: mid ?? undefined,
		extra: `bid=${bestBid ?? 'N/A'} ask=${bestAsk ?? 'N/A'} spread=${spread ?? 'N/A'}`,
	});

	const text = [
		`📸 ${formatTimestampJST(timestamp)}`,
		'',
		summary,
		'',
		`📊 板情報 (上位${topN}層):`,
		`中値: ${mid != null ? formatExactPrice(mid) : 'N/A'}円`,
		`スプレッド: ${spread != null ? formatExactPrice(spread) : 'N/A'}円`,
		'',
		`🟢 買い板 (Bids): ${bids.length}層`,
		...bids.map(
			(b, i) => `  ${i + 1}. ${formatExactPrice(b.price)}円 ${b.size.toFixed(4)} (cum:${b.cumSize.toFixed(4)})`,
		),
		'',
		`🔴 売り板 (Asks): ${asks.length}層`,
		...asks.map(
			(a, i) => `  ${i + 1}. ${formatExactPrice(a.price)}円 ${a.size.toFixed(4)} (cum:${a.cumSize.toFixed(4)})`,
		),
	]
		.filter(Boolean)
		.join('\n');

	const data = {
		mode: 'summary' as const,
		normalized: {
			pair,
			bestBid,
			bestAsk,
			spread,
			mid,
			bids,
			asks,
			timestamp,
			isoTime: toIsoTime(timestamp),
		},
	};
	return { text, data, mid };
}

function buildPressure(pair: string, bidsRaw: RawLevel[], asksRaw: RawLevel[], bandsPct: number[], timestamp: number) {
	const baseCcy = pair.split('_')[0]?.toUpperCase() ?? '';
	const bestAsk = Number(asksRaw?.[0]?.[0] ?? NaN);
	const bestBid = Number(bidsRaw?.[0]?.[0] ?? NaN);
	// 帯域境界の計算には丸め前の生 mid を使い、出力（baseMidOut）のみ共通の丸め規約に通す。
	const baseMid = Number.isFinite(bestAsk) && Number.isFinite(bestBid) ? (bestAsk + bestBid) / 2 : null;
	const baseMidOut = baseMid != null ? roundMidPrice(bestBid, bestAsk) : null;

	function sumInBand(levels: RawLevel[], low: number, high: number) {
		let s = 0;
		for (const [p, q] of levels) {
			const price = Number(p),
				qty = Number(q);
			if (Number.isFinite(price) && Number.isFinite(qty) && price >= low && price <= high) s += qty;
		}
		return s;
	}

	const eps = 1e-9;
	const bands = bandsPct.map((w) => {
		if (baseMid == null || !Number.isFinite(baseMid)) {
			return {
				widthPct: w,
				baseMid: null,
				baseBidSize: 0,
				baseAskSize: 0,
				bidDelta: 0,
				askDelta: 0,
				netDelta: 0,
				netDeltaPct: null as number | null,
				tag: null as 'notice' | 'warning' | 'strong' | null,
			};
		}
		const bidLow = (baseMid as number) * (1 - w);
		const bidHigh = baseMid as number;
		const askLow = baseMid as number;
		const askHigh = (baseMid as number) * (1 + w);

		const buyVol = sumInBand(bidsRaw, bidLow, bidHigh);
		const sellVol = sumInBand(asksRaw, askLow, askHigh);

		const net = Number((buyVol - sellVol).toFixed(8));
		const pressure = Number(((buyVol - sellVol) / (buyVol + sellVol + eps)).toFixed(4));

		const v = Math.abs(pressure);
		const tag: 'notice' | 'warning' | 'strong' | null =
			v >= 0.2 ? 'strong' : v >= 0.1 ? 'warning' : v >= 0.05 ? 'notice' : null;

		return {
			widthPct: w,
			baseMid: baseMidOut as number,
			baseBidSize: Number(buyVol.toFixed(8)),
			baseAskSize: Number(sellVol.toFixed(8)),
			bidDelta: Number(buyVol.toFixed(8)),
			askDelta: Number((-sellVol).toFixed(8)),
			netDelta: net,
			netDeltaPct: pressure,
			tag,
		};
	});

	const strongestTag: 'notice' | 'warning' | 'strong' | null = bands.some((b) => b.tag === 'strong')
		? 'strong'
		: bands.some((b) => b.tag === 'warning')
			? 'warning'
			: bands.some((b) => b.tag === 'notice')
				? 'notice'
				: null;

	const summary = formatSummary({
		pair,
		latest: baseMidOut ?? undefined,
		extra: `bands=${bandsPct.join(',')}; tag=${strongestTag ?? 'none'}`,
	});

	const text = [
		`📸 ${formatTimestampJST(timestamp)}`,
		'',
		summary,
		'',
		'📊 板圧力分析:',
		...bands.map(
			(b) =>
				`±${(b.widthPct * 100).toFixed(2)}%: 買い ${b.baseBidSize.toFixed(2)} ${baseCcy} / 売り ${b.baseAskSize.toFixed(2)} ${baseCcy} (圧力: ${((b.netDeltaPct ?? 0) * 100).toFixed(1)}%)${b.tag ? ` [${b.tag}]` : ''}`,
		),
		'',
		`💡 総合評価: ${strongestTag ?? '均衡'}`,
	]
		.filter(Boolean)
		.join('\n');

	const data = {
		mode: 'pressure' as const,
		bands,
		aggregates: { netDelta: Number(bands.reduce((s, b) => s + b.netDelta, 0).toFixed(8)), strongestTag },
	};
	return { text, data, mid: baseMidOut };
}

function buildStatistics(
	pair: string,
	bidsNum: NumLevel[],
	asksNum: NumLevel[],
	ranges: number[],
	priceZones: number,
	timestamp: number,
) {
	const baseCcy = pair.split('_')[0]?.toUpperCase() ?? '';
	const bestBid = bidsNum.length ? Math.max(...bidsNum.map(([p]) => p)) : null;
	const bestAsk = asksNum.length ? Math.min(...asksNum.map(([p]) => p)) : null;
	const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
	const zoneDecimals = bestBid != null && bestAsk != null ? midPriceDecimals(bestBid, bestAsk) : 0;

	const basic = {
		currentPrice: bestBid != null && bestAsk != null ? roundMidPrice(bestBid, bestAsk) : null,
		bestBid: bestBid != null ? Number(bestBid) : null,
		bestAsk: bestAsk != null ? Number(bestAsk) : null,
		spread: bestBid != null && bestAsk != null ? roundSpread(bestBid, bestAsk) : null,
		spreadPct: bestBid != null && bestAsk != null && mid ? (Number(bestAsk) - Number(bestBid)) / Number(mid) : null,
	};

	function sumWithinPct(levels: NumLevel[], pct: number, side: 'bid' | 'ask') {
		if (!mid) return { vol: 0, val: 0 };
		const minP = mid * (1 - pct / 100);
		const maxP = mid * (1 + pct / 100);
		let vol = 0;
		let val = 0;
		for (const [price, size] of levels) {
			if (side === 'bid' && price >= minP && price <= mid) {
				vol += size;
				val += size * price;
			}
			if (side === 'ask' && price <= maxP && price >= mid) {
				vol += size;
				val += size * price;
			}
		}
		return { vol, val };
	}

	// rawRatio は ask=0 で Infinity のまま overall / strength 判定に使い、出力 ratio だけ JSON と整合する finite か null にする。
	const rangeComputed = ranges.map((pct) => {
		const b = sumWithinPct(bidsNum, pct, 'bid');
		const a = sumWithinPct(asksNum, pct, 'ask');
		const askDried = a.vol === 0 && b.vol > 0;
		const rawRatio = a.vol > 0 ? b.vol / a.vol : b.vol > 0 ? Infinity : 0;
		return { pct, b, a, askDried, rawRatio };
	});
	const rangesOut = rangeComputed.map(({ pct, b, a, askDried, rawRatio }) => {
		const interpretation = askDried
			? '買い板が厚い（売り板=0、ratio 算出不能）'
			: rawRatio > 1.2
				? '買い板が厚い（下値堅い）'
				: rawRatio < 0.8
					? '売り板が厚い（上値重い）'
					: '均衡';
		return {
			pct,
			bidVolume: Number(b.vol.toFixed(4)),
			askVolume: Number(a.vol.toFixed(4)),
			bidValue: Math.round(b.val),
			askValue: Math.round(a.val),
			ratio: Number.isFinite(rawRatio) ? Number(rawRatio.toFixed(2)) : null,
			interpretation,
		};
	});

	const maxPct = Math.max(...ranges);
	const minPrice = mid ? mid * (1 - maxPct / 100) : 0;
	const maxPrice = mid ? mid * (1 + maxPct / 100) : 0;
	const step = priceZones > 0 && mid ? (maxPrice - minPrice) / priceZones : 0;
	const zones: Array<{
		priceRange: string;
		bidVolume: number;
		askVolume: number;
		dominance: 'bid' | 'ask' | 'balanced';
		note?: string;
	}> = [];
	if (step > 0) {
		for (let i = 0; i < priceZones; i++) {
			const lo = minPrice + i * step;
			const hi = lo + step;
			const bVol = bidsNum.filter(([p]) => p >= lo && p < hi).reduce((s, [, sz]) => s + sz, 0);
			const aVol = asksNum.filter(([p]) => p >= lo && p < hi).reduce((s, [, sz]) => s + sz, 0);
			const dom = bVol > aVol * 1.2 ? 'bid' : aVol > bVol * 1.2 ? 'ask' : 'balanced';
			const note = dom === 'bid' ? '強い買いサポート' : dom === 'ask' ? '強い売り圧力' : undefined;
			zones.push({
				priceRange: `${formatPriceDecimals(lo, zoneDecimals)} - ${formatPriceDecimals(hi, zoneDecimals)}`,
				bidVolume: Number(bVol.toFixed(4)),
				askVolume: Number(aVol.toFixed(4)),
				dominance: dom,
				note,
			});
		}
	}

	const threshold = 0.1;
	const largeBids = bidsNum
		.filter(([, sz]) => sz >= threshold)
		.slice(0, 20)
		.map(([p, sz]) => ({
			price: p,
			size: Number(sz.toFixed(3)),
			distance: mid ? Number((((p - mid) / mid) * 100).toFixed(2)) : null,
		}));
	const largeAsks = asksNum
		.filter(([, sz]) => sz >= threshold)
		.slice(0, 20)
		.map(([p, sz]) => ({
			price: p,
			size: Number(sz.toFixed(3)),
			distance: mid ? Number((((p - mid) / mid) * 100).toFixed(2)) : null,
		}));

	const lastRawRatio = rangeComputed[0]?.rawRatio ?? 1;
	const overall = lastRawRatio > 1.1 ? '買い優勢' : lastRawRatio < 0.9 ? '売り優勢' : '均衡';
	// |Infinity - 1| === Infinity > 0.3 で strong に分類される（ask=0 で買い圧倒のケース）。
	const strength = Math.abs(lastRawRatio - 1) > 0.3 ? 'strong' : Math.abs(lastRawRatio - 1) > 0.1 ? 'moderate' : 'weak';
	const liquidity =
		(rangesOut[0]?.bidVolume ?? 0) + (rangesOut[0]?.askVolume ?? 0) > 20
			? 'high'
			: (rangesOut[0]?.bidVolume ?? 0) + (rangesOut[0]?.askVolume ?? 0) > 5
				? 'medium'
				: 'low';
	const recommendation =
		overall === '買い優勢'
			? '下値が堅く、買いエントリーに適した環境。'
			: overall === '売り優勢'
				? '上値が重く、押し目待ち・警戒。'
				: '均衡圏、レンジ想定。';

	const text = [
		`📸 ${formatTimestampJST(timestamp)}`,
		'',
		`=== ${String(pair).toUpperCase()} 板統計分析 ===`,
		`💰 現在価格: ${basic.currentPrice != null ? `${formatExactPrice(basic.currentPrice)}円` : 'n/a'}`,
		basic.spread != null ? `   スプレッド: ${basic.spread}円 (${((basic.spreadPct || 0) * 100).toFixed(6)}%)` : '',
		'',
		'📊 板の厚み分析:',
		...rangesOut.map(
			(r) =>
				`±${r.pct}%レンジ: 買い ${r.bidVolume} ${baseCcy} / 売り ${r.askVolume} ${baseCcy} (比率 ${r.ratio === null ? '算出不能（売り板=0）' : r.ratio}) → ${r.interpretation}`,
		),
		'',
		'📈 価格帯別の流動性分布:',
		...zones.map(
			(z) => `${z.priceRange}円: 買い ${z.bidVolume} / 売り ${z.askVolume} (${z.dominance}) ${z.note || ''}`,
		),
		'',
		'🐋 大口注文:',
		...largeBids.map(
			(o) =>
				`買い板: ${formatExactPrice(o.price)}円に${o.size} ${baseCcy} (${o.distance != null ? `${(o.distance >= 0 ? '+' : '') + o.distance}%` : ''})`,
		),
		...largeAsks.map(
			(o) =>
				`売り板: ${formatExactPrice(o.price)}円に${o.size} ${baseCcy} (${o.distance != null ? `${(o.distance >= 0 ? '+' : '') + o.distance}%` : ''})`,
		),
		'',
		`💡 総合評価: ${overall}（${strength}）`,
		recommendation,
	]
		.filter(Boolean)
		.join('\n');

	const data = {
		mode: 'statistics' as const,
		basic,
		ranges: rangesOut,
		liquidityZones: zones,
		largeOrders: { bids: largeBids, asks: largeAsks, threshold },
		summary: { overall, strength, liquidity, recommendation },
	};
	return { text, data, mid };
}

function buildRaw(
	pair: string,
	rawJson: Record<string, unknown>,
	bidsRaw: RawLevel[],
	asksRaw: RawLevel[],
	timestamp: number,
) {
	const bestAsk = asksRaw[0]?.[0] != null ? Number(asksRaw[0][0]) : null;
	const bestBid = bidsRaw[0]?.[0] != null ? Number(bidsRaw[0][0]) : null;
	const mid = bestBid != null && bestAsk != null ? roundMidPrice(bestBid, bestAsk) : null;

	const bidsNum: NumLevel[] = bidsRaw.map(([p, s]) => [Number(p), Number(s)]);
	const asksNum: NumLevel[] = asksRaw.map(([p, s]) => [Number(p), Number(s)]);

	const summary = formatSummary({
		pair,
		latest: mid ?? undefined,
		extra: `levels: bids=${bidsRaw.length} asks=${asksRaw.length}`,
	});

	const text = [
		`📸 ${formatTimestampJST(timestamp)}`,
		'',
		summary,
		`板の層数: 買い ${bidsRaw.length}層 / 売り ${asksRaw.length}層`,
		mid ? `中値: ${formatExactPrice(mid)}円` : '',
		'',
		`🟢 買い板 (全${bidsRaw.length}層):`,
		...bidsRaw.map(([p, s], i) => `  ${i + 1}. ${formatExactPrice(Number(p))}円 ${s}`),
		'',
		`🔴 売り板 (全${asksRaw.length}層):`,
		...asksRaw.map(([p, s], i) => `  ${i + 1}. ${formatExactPrice(Number(p))}円 ${s}`),
	]
		.filter(Boolean)
		.join('\n');

	const d = rawJson;
	const data = {
		mode: 'raw' as const,
		asks: asksRaw,
		bids: bidsRaw,
		asks_over: d.asks_over,
		asks_under: d.asks_under,
		bids_over: d.bids_over,
		bids_under: d.bids_under,
		ask_market: d.ask_market,
		bid_market: d.bid_market,
		timestamp,
		sequenceId: toNum(d.sequenceId) ?? toNum(d.sequence_id) ?? undefined,
		overlays: {
			depth_zones: [...estimateZones(bidsNum.slice(0, 50), 'bid'), ...estimateZones(asksNum.slice(0, 50), 'ask')],
		},
	};

	return { text, data, mid };
}

export default async function getOrderbook(params: GetOrderbookParams | string = {}) {
	// 後方互換: 旧シグネチャ getOrderbook(pair, topN) 対応
	let opts: GetOrderbookParams;
	if (typeof params === 'string') {
		opts = { pair: params, mode: 'summary' };
	} else {
		opts = params;
	}

	const {
		pair = 'btc_jpy',
		mode = 'summary',
		topN = 10,
		bandsPct = [0.001, 0.005, 0.01],
		ranges = [0.5, 1.0, 2.0],
		priceZones = 10,
		maxLevels = 200,
		timeoutMs = 3000,
	} = opts;

	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk);

	if (mode === 'summary') {
		const limitCheck = validateLimit(topN, 1, 200, 'topN');
		if (!limitCheck.ok) return failFromValidation(limitCheck);
	}

	const url = `${BITBANK_API_BASE}/${chk.pair}/depth`;
	try {
		const { data: json, rateLimit } = await fetchJsonWithRateLimit(url, { timeoutMs, retries: DEFAULT_RETRIES });
		const jsonObj = json as { success?: number; data?: Record<string, unknown> };
		// optional chaining のフォールバックに任せると bids/asks 欠損として握りつぶされるので、success を明示的に検証する。
		if (jsonObj?.success !== 1) {
			const code = (jsonObj?.data as { code?: number } | undefined)?.code;
			const codeStr = code != null ? `（code: ${code}）` : '';
			return fail(`bitbank API がエラーを返却しました${codeStr}`, 'upstream');
		}
		const d = jsonObj?.data ?? {};
		if (!Array.isArray(d.asks) || !Array.isArray(d.bids)) {
			return fail('上流レスポンスに bids/asks が含まれていません', 'upstream');
		}
		const { rows: rawAsks, dropped: asksDropped } = toFiniteRawLevels((d.asks as RawLevel[]).slice(0, maxLevels));
		const { rows: rawBids, dropped: bidsDropped } = toFiniteRawLevels((d.bids as RawLevel[]).slice(0, maxLevels));
		// 元々片側が空の板は許容するが、drop で片側が全滅したら上流データ品質の問題として upstream fail に倒す。
		if ((asksDropped > 0 && rawAsks.length === 0) || (bidsDropped > 0 && rawBids.length === 0)) {
			return fail('板データの数値変換に失敗しました（有効な bids/asks が存在しません）', 'upstream');
		}
		// timestamp が欠損したら受信時刻で偽装せず upstream fail に倒す（古いデータを最新に見せない）。
		const timestamp = toNum(d.timestamp ?? d.timestamp_ms);
		if (timestamp == null || timestamp <= 0) {
			return fail('上流レスポンスに timestamp が含まれていません', 'upstream');
		}

		const bidsNum: NumLevel[] = rawBids.map(([p, s]) => [Number(p), Number(s)]);
		const asksNum: NumLevel[] = rawAsks.map(([p, s]) => [Number(p), Number(s)]);

		let result: { text: string; data: Record<string, unknown>; mid: number | null };

		switch (mode) {
			case 'pressure':
				result = buildPressure(chk.pair, rawBids, rawAsks, bandsPct, timestamp);
				break;
			case 'statistics':
				result = buildStatistics(chk.pair, bidsNum, asksNum, ranges, priceZones, timestamp);
				break;
			case 'raw':
				result = buildRaw(chk.pair, d, rawBids, rawAsks, timestamp);
				break;
			default:
				result = buildSummary(chk.pair, bidsNum, asksNum, topN, timestamp);
				break;
		}

		const boundary =
			`\n\n---\n📌 含まれるもの: 現時点の板スナップショット（mode=${mode}）` +
			`\n📌 含まれないもの: 板の時系列変化、約定履歴、テクニカル指標、出来高フロー` +
			`\n📌 補完ツール: get_flow_metrics（出来高フロー・CVD）, get_transactions（約定履歴）, analyze_indicators（指標）`;
		result.text += boundary;

		// drop した件数を LLM 可視テキスト先頭と meta に出す（prepare_depth_data と対称）。
		const totalDropped = bidsDropped + asksDropped;
		const droppedWarning =
			totalDropped > 0
				? `⚠️ 上流レスポンスから ${totalDropped}件 の不正な板レベルを除外しました（bids: ${bidsDropped}件 / asks: ${asksDropped}件、price/size が数値変換不能）`
				: undefined;
		if (droppedWarning) result.text = `${droppedWarning}\n\n${result.text}`;

		const meta = createMeta(chk.pair, {
			mode,
			topN,
			...(rateLimit ? { rateLimit } : {}),
			...(totalDropped > 0 ? { droppedRows: { bids: bidsDropped, asks: asksDropped } } : {}),
			...(droppedWarning ? { warning: droppedWarning } : {}),
		});
		return parseAsResult<GetOrderbookData, GetOrderbookMeta>(
			GetOrderbookOutputSchema,
			ok(result.text, result.data, meta),
		);
	} catch (err: unknown) {
		return failFromError(err, {
			schema: GetOrderbookOutputSchema,
			timeoutMs,
			defaultType: 'network',
			defaultMessage: 'ネットワークエラー',
		});
	}
}

export const toolDef: ToolDefinition = {
	name: 'get_orderbook',
	description: `[Order Book / Depth / Spread] 板情報（order book / depth / bid-ask spread）の統合ツール。

【mode】summary（デフォルト）: 上位N層+spread / pressure: 帯域別の買い/売り圧力 / statistics: 流動性ゾーン+大口注文 / raw: 生bids/asks+壁ゾーン推定。`,
	inputSchema: GetOrderbookInputSchema,
	handler: async ({
		pair,
		mode,
		topN,
		bandsPct,
		ranges,
		priceZones,
	}: {
		pair?: string;
		mode?: 'summary' | 'pressure' | 'statistics' | 'raw';
		topN?: number;
		bandsPct?: number[];
		ranges?: number[];
		priceZones?: number;
	}) => getOrderbook({ pair, mode, topN, bandsPct, ranges, priceZones }),
};
