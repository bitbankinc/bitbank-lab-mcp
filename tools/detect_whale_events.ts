import { z } from 'zod';
import { TtlCache } from '../lib/cache.js';
import { nowIso } from '../lib/datetime.js';
import getDepth from '../lib/get-depth.js';
import { fail, failFromError, failFromValidation, ok } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import type { Result } from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import getCandles from './get_candles.js';

type Lookback = '30min' | '1hour' | '2hour';

const cache = new TtlCache<Result>({ ttlMs: 60_000 });

function extractLargeOrders(levels: Array<[number, number]>, minSize: number) {
	return (levels || [])
		.filter(([_p, s]) => Number(s) >= minSize)
		.map(([p, s]) => ({ price: Number(p), size: Number(s) }));
}

function analyzeTrend(buyVol: number, sellVol: number): 'accumulation' | 'distribution' | 'neutral' {
	if (buyVol > sellVol * 1.2) return 'accumulation';
	if (sellVol > buyVol * 1.2) return 'distribution';
	return 'neutral';
}

function generateRecommendation(trend: string): string {
	if (trend === 'accumulation') return '買い圧力が優勢。段階的なエントリーを検討。';
	if (trend === 'distribution') return '売り圧力が優勢。押し目待ち/警戒。';
	return '均衡。レンジ内の値動きを想定。';
}

export default async function detectWhaleEvents(
	pair: string = 'btc_jpy',
	lookback: Lookback = '1hour',
	minSize: number = 0.5,
) {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk);

	const cacheKey = `${chk.pair}:${lookback}:${minSize}`;
	const hit = cache.get(cacheKey);
	if (hit) return hit;

	try {
		const dep = await getDepth(chk.pair, { maxLevels: 200 });
		if (!dep?.ok)
			return fail(dep?.summary || 'depth failed', (dep?.meta as { errorType?: string })?.errorType || 'internal');
		const rawAsks: Array<[string, string]> | undefined = dep?.data?.asks;
		const rawBids: Array<[string, string]> | undefined = dep?.data?.bids;
		if (!rawAsks || !rawBids) return fail('depth response missing asks/bids', 'upstream');
		const asks: Array<[number, number]> = rawAsks.map(([p, s]) => [Number(p), Number(s)]);
		const bids: Array<[number, number]> = rawBids.map(([p, s]) => [Number(p), Number(s)]);
		const bestBid = bids.length ? Math.max(...bids.map(([p]) => p)) : null;
		const bestAsk = asks.length ? Math.min(...asks.map(([p]) => p)) : null;
		const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;

		const lbMap: Record<Lookback, { type: string; limit: number }> = {
			'30min': { type: '5min', limit: 6 },
			'1hour': { type: '5min', limit: 12 },
			'2hour': { type: '5min', limit: 24 },
		};
		const lb = lbMap[lookback] || lbMap['1hour'];
		// NOTE: 形成中足（provisional）注記は対象外。
		// 本ツールの主分析は「現在の板（orderbook depth）」のスナップショットであり、ローソク足の
		// 最新値（終値・RSI・ATR 等）を確定値として提示するものではない。candles は lookback 区間の
		// 概況（先頭→末尾の close 変化率 priceChange）を添えるためだけに使い、最新足の終値そのものを
		// 指標値として出力しない。よって lib/provisional-bar.ts の「最新足は未確定」注記は意味を成さず付与しない。
		const candlesRes = await getCandles(chk.pair, lb.type, undefined, lb.limit);
		if (!candlesRes?.ok)
			return fail(
				candlesRes?.summary || 'candles failed',
				(candlesRes?.meta as { errorType?: string })?.errorType || 'internal',
			);
		const candles: Array<{ close: number }> = candlesRes?.data?.normalized || [];
		const validCloses = candles
			.map((c) => c.close)
			.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
		const priceChange =
			validCloses.length >= 2 ? (validCloses[validCloses.length - 1] - validCloses[0]) / validCloses[0] : 0;

		const largeBids = extractLargeOrders(bids, minSize);
		const largeAsks = extractLargeOrders(asks, minSize);

		const buyVol = largeBids.reduce((s, o) => s + o.size, 0);
		const sellVol = largeAsks.reduce((s, o) => s + o.size, 0);
		const trend = analyzeTrend(buyVol, sellVol);
		const recommendation = generateRecommendation(trend);

		const annotate = (side: 'buy' | 'sell') => (o: { price: number; size: number }) => ({
			side,
			price: o.price,
			size: Number(o.size.toFixed(3)),
			distancePct: mid ? Number((((o.price - mid) / mid) * 100).toFixed(2)) : null,
		});
		const events = [...largeBids.map(annotate('buy')), ...largeAsks.map(annotate('sell'))]
			.sort((a, b) => Math.abs(a.distancePct || 0) - Math.abs(b.distancePct || 0))
			.slice(0, 20);

		// Visualization: buy/sell balance
		const totalVol = buyVol + sellVol;
		const buyPct = totalVol > 0 ? buyVol / totalVol : 0;
		const sellPct = totalVol > 0 ? sellVol / totalVol : 0;
		const barLen = 14;
		const buyBars = '█'.repeat(Math.max(0, Math.round(buyPct * barLen)));
		const sellBars = '█'.repeat(Math.max(0, Math.round(sellPct * barLen)));

		// Distance stats
		const buyDists = largeBids
			.map((o) => (mid ? ((o.price - mid) / mid) * 100 : null))
			.filter((x): x is number => x != null);
		const sellDists = largeAsks
			.map((o) => (mid ? ((o.price - mid) / mid) * 100 : null))
			.filter((x): x is number => x != null);
		const avg = (arr: number[]) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
		const avgBuyDist = avg(buyDists);
		const avgSellDist = avg(sellDists);

		// 数量の単位は pair の base 通貨から導出する（規約元6ツールと同じ書式）。
		const baseCcy = chk.pair.split('_')[0]?.toUpperCase() ?? '';
		const text = [
			`=== ${chk.pair.toUpperCase()} 大口動向分析（過去${lookback}）===`,
			'',
			`🐋 検出された大口: ${events.length}件`,
			`買い: ${largeBids.length}件（合計${buyVol.toFixed(2)} ${baseCcy}）`,
			`売り: ${largeAsks.length}件（合計${sellVol.toFixed(2)} ${baseCcy}）`,
			'',
			'📊 買い/売りバランス:',
			`   買い: ${buyBars} ${buyVol.toFixed(2)} ${baseCcy} (${(buyPct * 100).toFixed(0)}%)`,
			`   売り: ${sellBars} ${sellVol.toFixed(2)} ${baseCcy} (${(sellPct * 100).toFixed(0)}%)`,
			'',
			'📏 距離の統計:',
			`   平均距離: 買い ${avgBuyDist.toFixed(2)}%, 売り ${avgSellDist.toFixed(2)}%`,
			'',
			'📋 主要な大口:',
			...events.map(
				(e) =>
					`${e.side === 'buy' ? '🟢' : '🔴'} ${e.price.toLocaleString('ja-JP')}円に${e.size} ${baseCcy}（${e.side === 'buy' ? '買い' : '売り'}）距離: ${e.distancePct != null ? `${(e.distancePct >= 0 ? '+' : '') + e.distancePct}%` : 'n/a'}`,
			),
			'',
			`📈 過去${lookback}の価格変化: ${(priceChange * 100).toFixed(2)}%`,
			'',
			`💡 総合評価: ${trend === 'accumulation' ? '買い圧力優勢' : trend === 'distribution' ? '売り圧力優勢' : '均衡'}（${trend}）`,
			recommendation,
			'',
			'※ 注: 推測ベースの簡易分析です（実約定・寿命照合は未実装）。',
			'',
			'---',
			'📌 含まれるもの: 現在の板から検出した大口注文（買い/売り・価格・サイズ・距離）、バランス分析',
			'📌 含まれないもの: 過去の大口動向の時系列変化、全体の出来高フロー、テクニカル指標',
			'📌 補完ツール: get_flow_metrics（出来高フロー・CVD）, get_orderbook（板の詳細分析）, analyze_indicators（指標）',
		].join('\n');

		const data = {
			events,
			stats: {
				buyOrders: largeBids.length,
				sellOrders: largeAsks.length,
				buyVolume: Number(buyVol.toFixed(3)),
				sellVolume: Number(sellVol.toFixed(3)),
				trend,
				recommendation,
			},
			meta: { lookback, minSize },
		};

		const meta = createMeta(chk.pair, { fetchedAt: nowIso() });
		const out = ok(text, data, meta);
		cache.set(cacheKey, out);
		return out;
	} catch (e: unknown) {
		return failFromError(e);
	}
}

// ── MCP ツール定義（tool-registry から自動収集） ──
export const toolDef: ToolDefinition = {
	name: 'detect_whale_events',
	description:
		'[Whale / Large Orders / Big Players] 大口投資家の動向検出（whale / large orders / big players / smart money）。板×ローソク足で大口注文を簡易検出。推測ベース。',
	inputSchema: z.object({
		pair: z.string().default('btc_jpy'),
		lookback: z.enum(['30min', '1hour', '2hour']).default('1hour'),
		minSize: z.number().min(0).default(0.5),
	}),
	handler: async ({ pair, lookback, minSize }: { pair: string; lookback: Lookback; minSize: number }) =>
		detectWhaleEvents(pair, lookback, minSize),
};
