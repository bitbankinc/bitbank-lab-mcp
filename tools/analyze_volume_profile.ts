/**
 * analyze_volume_profile — 約定データから Volume Profile + VWAP + 約定サイズ分布を算出
 *
 * 内部で getTransactions を呼び出し、get_flow_metrics と同様のマージ戦略で
 * 約定データを収集。そこから3つの指標を導出する:
 *
 * 1. VWAP (出来高加重平均価格) + ±1σ/2σ バンド
 * 2. Volume Profile (価格帯別出来高分布 + POC + Value Area)
 * 3. Trade Size Distribution (約定サイズ別の分類 + 大口偏り)
 */

import type { z } from 'zod';
import { toDisplayTime, toIsoWithTz } from '../lib/datetime.js';
import { formatPair, formatPercent, formatPrice } from '../lib/formatter.js';
import { fail, failFromError, failFromValidation, ok } from '../lib/result.js';
import {
	applyTxLimit,
	buildAggregateCoverageNote,
	buildTxCoverageWarning,
	buildTxTruncationWarning,
	computeTxCoverage,
	extractUpstreamError,
	fetchLatestTxs,
	fetchSupplementTxs,
	fetchTxTimeRange,
	formatTxFailures,
	hasCoverageShortfall,
	partialFailureWarning,
	sortTxsAsc,
	type Tx,
	type TxFetcher,
	type TxLimitApplication,
} from '../lib/tx-fetch.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import {
	type AnalyzeVolumeProfileDataSchemaOut,
	AnalyzeVolumeProfileInputSchema,
	type AnalyzeVolumeProfileMetaSchemaOut,
	AnalyzeVolumeProfileOutputSchema,
} from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import getTransactions from './get_transactions.js';

/** get_transactions の応答件数上限（public ツールの limit 上限と同値）。 */
const PUBLIC_TX_LIMIT = 1000;

type FetchResult =
	| { ok: true; txs: Tx[]; fetchWarning?: string; limitApplication?: TxLimitApplication }
	| { ok: false; errorType: string; summary: string };

/**
 * 内部集計用の約定フェッチャ。
 *
 * `get_transactions` の応答上限（1000 件）は MCP 応答のサイズ制限であってフェッチ制限では
 * ないため、集計用途では外す（`unlimited`）。本ツールの出力は価格帯別プロファイル（bins 固定）
 * とサイズ分布なので全件を集計してもトークンは増えない一方、キャップしたままだと 1 UTC 日
 * （BTC/JPY で実測 5,609〜8,040 件）の末尾 4〜5 時間分しか VWAP / POC / Value Area に
 * 入らなかった。public ツール `get_transactions` 側の応答上限は変更していない。
 */
function internalTxFetcher(pair: string): TxFetcher {
	// limit は unlimited 指定時に無視されるが、万一オプションが外れても旧挙動
	// （応答上限 1000 件）へ縮退するよう public 上限を渡しておく。
	return (date) => getTransactions(pair, PUBLIC_TX_LIMIT, date, undefined, { unlimited: true });
}

/**
 * 約定を取得する。完了済み UTC 日アーカイブの列挙 + latest 補完 + dedup マージは
 * lib/tx-fetch.ts に集約されており、本関数は失敗ハンドリングの方針
 * （全滅 fail / 過半数 fail / 部分失敗 warning）だけを持つ。
 */
async function fetchTransactions(pair: string, hours?: number, limit?: number): Promise<FetchResult> {
	const txFetcher = internalTxFetcher(pair);

	if (hours != null && hours > 0) {
		const range = await fetchTxTimeRange(txFetcher, hours);
		const { results, merged } = range;
		if (merged.txs.length === 0) {
			const upstreamErr = extractUpstreamError(results);
			if (upstreamErr) return { ok: false, ...upstreamErr };
		}
		if (merged.failedCount > 0 && merged.failedCount >= merged.totalCount / 2) {
			return {
				ok: false,
				errorType: 'upstream',
				summary: `API取得の過半数が失敗しました（${merged.totalCount}件中${merged.failedCount}件失敗: ${formatTxFailures(merged.failures)}）`,
			};
		}
		return {
			ok: true,
			txs: range.txs,
			fetchWarning: partialFailureWarning(merged.totalCount, merged.failures),
		};
	}

	// Count-based
	const lim = limit ?? 500;
	const latest = await fetchLatestTxs(txFetcher);
	if (latest.txs.length === 0) {
		const upstreamErr = extractUpstreamError([latest.result]);
		if (upstreamErr) return { ok: false, ...upstreamErr };
	}
	// 取得は無制限だが limit はユーザーの明示要求なので最新側 limit 件に切る。
	// 黙って切ると集計値が部分データ由来であることが応答から分からないため申告する。
	if (latest.txs.length >= lim) {
		const applied = applyTxLimit(sortTxsAsc(latest.txs), lim);
		return {
			ok: true,
			txs: applied.txs,
			limitApplication: applied,
			fetchWarning: buildTxTruncationWarning(applied, lim, { scope: '/transactions (latest)' }),
		};
	}

	const { results, merged } = await fetchSupplementTxs(txFetcher, lim, latest);
	if (merged.txs.length === 0) {
		const upstreamErr = extractUpstreamError(results);
		if (upstreamErr) return { ok: false, ...upstreamErr };
	}
	// 補完は best-effort: 何かしら取得できていれば fail せず、部分失敗は警告で明示する
	// （latest 成功 + 補完失敗を「過半数失敗」として全体 fail すると、正当に取得できた
	// 直近データまで捨ててしまう。補完アーカイブは公開遅延等で 404 になり得る）。
	const applied = applyTxLimit(sortTxsAsc(merged.txs), lim);
	return {
		ok: true,
		txs: applied.txs,
		limitApplication: applied,
		fetchWarning:
			[
				partialFailureWarning(merged.totalCount, merged.failures),
				buildTxTruncationWarning(applied, lim, { scope: 'latest + 完了済み UTC 日アーカイブ' }),
			]
				.filter(Boolean)
				.join('\n') || undefined,
	};
}

// ── VWAP Calculation ──

function calcVwap(txs: Tx[]) {
	let sumPV = 0;
	let sumV = 0;
	for (const t of txs) {
		sumPV += t.price * t.amount;
		sumV += t.amount;
	}
	const vwap = sumV > 0 ? sumPV / sumV : 0;

	// Weighted standard deviation
	let sumWeightedSqDiff = 0;
	for (const t of txs) {
		sumWeightedSqDiff += t.amount * (t.price - vwap) ** 2;
	}
	const stdDev = sumV > 0 ? Math.sqrt(sumWeightedSqDiff / sumV) : 0;

	return { vwap, stdDev };
}

// ── Volume Profile Calculation ──

/**
 * 約定列の価格レンジ。
 *
 * `Math.min(...prices)` はスプレッド引数が数万件になると RangeError（stack overflow）に
 * なり得る。内部取得のキャップ解除で 1 UTC 日 8,000 件超を扱うようになったため、
 * ループで求める。
 */
function priceRangeOf(txs: Tx[]): { low: number; high: number } {
	let low = Number.POSITIVE_INFINITY;
	let high = Number.NEGATIVE_INFINITY;
	for (const t of txs) {
		if (t.price < low) low = t.price;
		if (t.price > high) high = t.price;
	}
	return { low, high };
}

function calcVolumeProfile(txs: Tx[], bins: number, valueAreaPct: number) {
	const { low: priceLow, high: priceHigh } = priceRangeOf(txs);
	const range = priceHigh - priceLow;

	// Guard against zero range (all trades at same price)
	if (range === 0) {
		// All trades at same price — single-bin profile with exact price
		const singleBin = { low: priceLow, high: priceLow, buyVolume: 0, sellVolume: 0, totalVolume: 0 };
		for (const t of txs) {
			if (t.side === 'buy') singleBin.buyVolume += t.amount;
			else singleBin.sellVolume += t.amount;
			singleBin.totalVolume += t.amount;
		}
		const totalVolume = singleBin.totalVolume;
		const isJpy = true;
		const fmtSingle = () => {
			const p = isJpy ? Math.round(priceLow).toLocaleString('ja-JP') : priceLow.toFixed(2);
			return `${p}〜${p}`;
		};
		const binResult = {
			low: Number(priceLow.toFixed(2)),
			high: Number(priceLow.toFixed(2)),
			label: fmtSingle(),
			buyVolume: Number(singleBin.buyVolume.toFixed(8)),
			sellVolume: Number(singleBin.sellVolume.toFixed(8)),
			totalVolume: Number(singleBin.totalVolume.toFixed(8)),
			pct: 100,
			dominant:
				singleBin.buyVolume > singleBin.sellVolume * 1.2
					? ('buy' as const)
					: singleBin.sellVolume > singleBin.buyVolume * 1.2
						? ('sell' as const)
						: ('balanced' as const),
		};
		return {
			bins: [binResult],
			poc: {
				price: Number(priceLow.toFixed(2)),
				volume: Number(totalVolume.toFixed(8)),
				binIndex: 0,
			},
			valueArea: {
				high: Number(priceLow.toFixed(2)),
				low: Number(priceLow.toFixed(2)),
				volume: Number(totalVolume.toFixed(8)),
				pct: 100,
			},
		};
	}
	const step = range / bins;
	const adjustedLow = priceLow;

	const profileBins: Array<{
		low: number;
		high: number;
		buyVolume: number;
		sellVolume: number;
		totalVolume: number;
	}> = [];
	for (let i = 0; i < bins; i++) {
		profileBins.push({
			low: adjustedLow + i * step,
			high: adjustedLow + (i + 1) * step,
			buyVolume: 0,
			sellVolume: 0,
			totalVolume: 0,
		});
	}

	// Distribute trades into bins
	for (const t of txs) {
		let idx = Math.floor((t.price - adjustedLow) / step);
		if (idx >= bins) idx = bins - 1;
		if (idx < 0) idx = 0;
		if (t.side === 'buy') profileBins[idx].buyVolume += t.amount;
		else profileBins[idx].sellVolume += t.amount;
		profileBins[idx].totalVolume += t.amount;
	}

	const totalVolume = profileBins.reduce((s, b) => s + b.totalVolume, 0);

	// POC (Point of Control): bin with highest volume
	let pocIdx = 0;
	let pocVol = 0;
	for (let i = 0; i < profileBins.length; i++) {
		if (profileBins[i].totalVolume > pocVol) {
			pocVol = profileBins[i].totalVolume;
			pocIdx = i;
		}
	}
	const pocPrice = (profileBins[pocIdx].low + profileBins[pocIdx].high) / 2;

	// Value Area: expand from POC until covering valueAreaPct of total volume
	const targetVol = totalVolume * valueAreaPct;
	let vaVol = profileBins[pocIdx].totalVolume;
	let vaLow = pocIdx;
	let vaHigh = pocIdx;
	while (vaVol < targetVol && (vaLow > 0 || vaHigh < bins - 1)) {
		const lowCandidate = vaLow > 0 ? profileBins[vaLow - 1].totalVolume : -1;
		const highCandidate = vaHigh < bins - 1 ? profileBins[vaHigh + 1].totalVolume : -1;
		if (lowCandidate >= highCandidate && lowCandidate >= 0) {
			vaLow--;
			vaVol += profileBins[vaLow].totalVolume;
		} else if (highCandidate >= 0) {
			vaHigh++;
			vaVol += profileBins[vaHigh].totalVolume;
		} else {
			break;
		}
	}

	const isJpy = true; // This tool always operates on JPY pairs primarily
	const fmtBin = (b: (typeof profileBins)[0]) => {
		const lo = isJpy ? Math.round(b.low).toLocaleString('ja-JP') : b.low.toFixed(2);
		const hi = isJpy ? Math.round(b.high).toLocaleString('ja-JP') : b.high.toFixed(2);
		return `${lo}〜${hi}`;
	};

	return {
		bins: profileBins.map((b, _i) => ({
			low: Number(b.low.toFixed(2)),
			high: Number(b.high.toFixed(2)),
			label: fmtBin(b),
			buyVolume: Number(b.buyVolume.toFixed(8)),
			sellVolume: Number(b.sellVolume.toFixed(8)),
			totalVolume: Number(b.totalVolume.toFixed(8)),
			pct: totalVolume > 0 ? Number(((b.totalVolume / totalVolume) * 100).toFixed(1)) : 0,
			dominant:
				b.buyVolume > b.sellVolume * 1.2
					? ('buy' as const)
					: b.sellVolume > b.buyVolume * 1.2
						? ('sell' as const)
						: ('balanced' as const),
		})),
		poc: {
			price: Number(pocPrice.toFixed(2)),
			volume: Number(pocVol.toFixed(8)),
			binIndex: pocIdx,
		},
		valueArea: {
			high: Number(profileBins[vaHigh].high.toFixed(2)),
			low: Number(profileBins[vaLow].low.toFixed(2)),
			volume: Number(vaVol.toFixed(8)),
			pct: totalVolume > 0 ? Number(((vaVol / totalVolume) * 100).toFixed(1)) : 0,
		},
	};
}

// ── Trade Size Distribution ──

function calcTradeSizeDistribution(txs: Tx[]) {
	const amounts = txs.map((t) => t.amount).sort((a, b) => a - b);
	const p25 = amounts[Math.floor(amounts.length * 0.25)] ?? 0;
	const p75 = amounts[Math.floor(amounts.length * 0.75)] ?? 0;
	const p95 = amounts[Math.floor(amounts.length * 0.95)] ?? 0;

	const categories = [
		{ label: '小口', minSize: 0, maxSize: p25, filter: (a: number) => a <= p25 },
		{ label: '中口', minSize: p25, maxSize: p75, filter: (a: number) => a > p25 && a <= p75 },
		{ label: '大口', minSize: p75, maxSize: p95, filter: (a: number) => a > p75 && a <= p95 },
		{ label: '特大口', minSize: p95, maxSize: null as number | null, filter: (a: number) => a > p95 },
	];

	const totalVolume = txs.reduce((s, t) => s + t.amount, 0);

	const result = categories.map((c) => {
		const matching = txs.filter((t) => c.filter(t.amount));
		const vol = matching.reduce((s, t) => s + t.amount, 0);
		const buyVol = matching.filter((t) => t.side === 'buy').reduce((s, t) => s + t.amount, 0);
		const sellVol = matching.filter((t) => t.side === 'sell').reduce((s, t) => s + t.amount, 0);
		return {
			label: c.label,
			minSize: Number(c.minSize.toFixed(8)),
			maxSize: c.maxSize != null ? Number(c.maxSize.toFixed(8)) : null,
			count: matching.length,
			volume: Number(vol.toFixed(8)),
			pct: totalVolume > 0 ? Number(((vol / totalVolume) * 100).toFixed(1)) : 0,
			buyVolume: Number(buyVol.toFixed(8)),
			sellVolume: Number(sellVol.toFixed(8)),
		};
	});

	// Large trade bias (大口 + 特大口)
	const largeTxs = txs.filter((t) => t.amount > p75);
	const largeBuyVol = largeTxs.filter((t) => t.side === 'buy').reduce((s, t) => s + t.amount, 0);
	const largeSellVol = largeTxs.filter((t) => t.side === 'sell').reduce((s, t) => s + t.amount, 0);
	const ratio = largeSellVol > 0 ? Number((largeBuyVol / largeSellVol).toFixed(2)) : largeBuyVol > 0 ? null : null;
	const interpretation =
		ratio == null
			? largeBuyVol > 0
				? '大口は買い一色'
				: '大口取引なし'
			: ratio > 1.3
				? '大口は買い優勢（蓄積の可能性）'
				: ratio < 0.7
					? '大口は売り優勢（分配の可能性）'
					: '大口は買い売り均衡';

	return {
		categories: result,
		thresholds: { p25: Number(p25.toFixed(8)), p75: Number(p75.toFixed(8)), p95: Number(p95.toFixed(8)) },
		largeTradeBias: {
			buyVolume: Number(largeBuyVol.toFixed(8)),
			sellVolume: Number(largeSellVol.toFixed(8)),
			ratio,
			interpretation,
		},
	};
}

// ── Main ──

export default async function analyzeVolumeProfile(
	pair: string = 'btc_jpy',
	hours?: number,
	limit: number = 500,
	bins: number = 20,
	valueAreaPct: number = 0.7,
	tz: string = 'Asia/Tokyo',
) {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk, AnalyzeVolumeProfileOutputSchema);

	try {
		const fetchResult = await fetchTransactions(chk.pair, hours, limit);
		if (!fetchResult.ok) {
			return AnalyzeVolumeProfileOutputSchema.parse(fail(fetchResult.summary, fetchResult.errorType));
		}
		const txs = fetchResult.txs;
		if (txs.length < 10) {
			return AnalyzeVolumeProfileOutputSchema.parse(fail('約定データが不足しています（10件未満）', 'user'));
		}

		const currentPrice = txs[txs.length - 1].price;
		const { vwap, stdDev } = calcVwap(txs);
		const profile = calcVolumeProfile(txs, bins, valueAreaPct);
		const tradeSizes = calcTradeSizeDistribution(txs);

		// VWAP position classification
		const dev = currentPrice - vwap;
		const deviationPct = vwap > 0 ? Number(((dev / vwap) * 100).toFixed(2)) : 0;
		const position =
			dev > 2 * stdDev
				? ('above_2sigma' as const)
				: dev > stdDev
					? ('above_1sigma' as const)
					: dev < -2 * stdDev
						? ('below_2sigma' as const)
						: dev < -stdDev
							? ('below_1sigma' as const)
							: ('at_vwap' as const);

		const positionLabel: Record<string, string> = {
			above_2sigma: '大幅に割高（+2σ超）→ 短期反落リスク高',
			above_1sigma: 'やや割高（+1σ超）→ 利確検討圏',
			at_vwap: 'VWAP近辺（±1σ以内）→ フェアバリュー圏',
			below_1sigma: 'やや割安（-1σ超）→ 押し目検討圏',
			below_2sigma: '大幅に割安（-2σ超）→ 短期反発期待',
		};

		// Time range info。
		// 先頭〜末尾の単純差分（durationMin）だけでは、アーカイブ未公開区間などの穴を
		// 「カバー済み」に見せてしまうため、実データがある区間の合計も併せて出す。
		const startMs = txs[0].timestampMs;
		const endMs = txs[txs.length - 1].timestampMs;
		const coverage = computeTxCoverage(txs);
		const durationMin = coverage?.spanMinutes ?? Math.round((endMs - startMs) / 60_000);
		const requestedMin = hours != null && hours > 0 ? Math.round(hours * 60) : undefined;
		const coverageWarning = buildTxCoverageWarning(coverage, { requestedMinutes: requestedMin, tz });
		// 取得層（部分失敗・カバレッジ欠損）と計算層（集計値がカバー区間のみ由来）は別系統。
		const fetchWarnings = [fetchResult.fetchWarning, coverageWarning].filter(Boolean) as string[];
		const dataWarning = fetchWarnings.length > 0 ? fetchWarnings.join('\n') : undefined;
		const coverageIncomplete =
			coverage != null && (coverage.gaps.length > 0 || hasCoverageShortfall(coverage, requestedMin));
		const calcWarnings =
			coverage && coverageIncomplete
				? [buildAggregateCoverageNote(coverage, '集計値（VWAP / POC / Value Area / 約定サイズ分布）', requestedMin)]
				: [];
		const totalVolume = txs.reduce((s, t) => s + t.amount, 0);
		const { low: priceLow, high: priceHigh } = priceRangeOf(txs);

		const data = {
			vwap: {
				price: Number(vwap.toFixed(2)),
				stdDev: Number(stdDev.toFixed(2)),
				bands: {
					upper2sigma: Number((vwap + 2 * stdDev).toFixed(2)),
					upper1sigma: Number((vwap + stdDev).toFixed(2)),
					lower1sigma: Number((vwap - stdDev).toFixed(2)),
					lower2sigma: Number((vwap - 2 * stdDev).toFixed(2)),
				},
				currentPrice,
				deviationPct,
				position,
				interpretation: positionLabel[position],
			},
			profile,
			tradeSizes,
			params: {
				totalTrades: txs.length,
				totalVolume: Number(totalVolume.toFixed(8)),
				priceRange: { high: priceHigh, low: priceLow },
				timeRange: {
					start: toIsoWithTz(startMs, tz) ?? '',
					end: toIsoWithTz(endMs, tz) ?? '',
					// durationMin は先頭〜末尾のスパン（欠損を含む）。カバー済み時間は coveredMin。
					durationMin,
					coveredMin: coverage?.coveredMinutes ?? durationMin,
					gapMin: coverage?.gapMinutes ?? 0,
					segments: coverage?.segments.length ?? 1,
					...(requestedMin != null ? { requestedMin } : {}),
				},
				bins,
				valueAreaPct,
			},
		};

		// Build summary text
		const pairDisplay = formatPair(chk.pair);
		const fmtPx = (p: number) => formatPrice(p, chk.pair);
		const rangeStr = `${toDisplayTime(startMs, tz) ?? '?'}〜${toDisplayTime(endMs, tz) ?? '?'}`;

		const topBins = [...profile.bins].sort((a, b) => b.totalVolume - a.totalVolume).slice(0, 5);
		const profileText = topBins
			.map((b, i) => {
				const bar = '█'.repeat(Math.max(1, Math.round(b.pct / 3)));
				return `  ${i + 1}. ${b.label}円: ${bar} ${b.pct}% (買${b.buyVolume.toFixed(4)}/売${b.sellVolume.toFixed(4)}) [${b.dominant}]`;
			})
			.join('\n');

		// 取得層 → 計算層の順で本文の前に出す（.claude/rules/tools.md の 2 系統ルール）
		const summaryLines: string[] = [...(dataWarning ? [dataWarning] : []), ...calcWarnings.map((w) => `⚠️ ${w}`)];
		// 欠損がある場合は「◯分間」ではなくスパン/実カバーを並記する（穴をカバー済みと申告しない）
		const durationLabel =
			coverage && coverage.gaps.length > 0
				? `スパン${coverage.spanMinutes}分/実カバー${coverage.coveredMinutes}分`
				: `${durationMin}分間`;
		const summary = [
			...summaryLines,
			`${pairDisplay} Volume Profile & VWAP (${txs.length}件, ${durationLabel})`,
			`期間: ${rangeStr}`,
			'',
			'📊 VWAP:',
			`  VWAP: ${fmtPx(vwap)} (σ=${fmtPx(stdDev)})`,
			`  バンド: +2σ=${fmtPx(vwap + 2 * stdDev)} / +1σ=${fmtPx(vwap + stdDev)} / -1σ=${fmtPx(vwap - stdDev)} / -2σ=${fmtPx(vwap - 2 * stdDev)}`,
			`  現在値: ${fmtPx(currentPrice)} (VWAP比 ${formatPercent(deviationPct, { sign: true })})`,
			`  判定: ${positionLabel[position]}`,
			'',
			'📈 Volume Profile (出来高上位5帯):',
			profileText,
			`  POC: ${fmtPx(profile.poc.price)} (最大出来高価格帯)`,
			`  Value Area: ${fmtPx(profile.valueArea.low)}〜${fmtPx(profile.valueArea.high)} (${profile.valueArea.pct}%)`,
			'',
			`💰 約定サイズ分布 (閾値: P25=${tradeSizes.thresholds.p25}, P75=${tradeSizes.thresholds.p75}, P95=${tradeSizes.thresholds.p95}):`,
			`  分類基準: 小口≤P25, 中口P25–P75, 大口P75–P95, 特大口>P95`,
			...tradeSizes.categories.map(
				(c) =>
					`  ${c.label}: ${c.count}件 ${c.volume.toFixed(4)} (${c.pct}%) 買${c.buyVolume.toFixed(4)}/売${c.sellVolume.toFixed(4)}`,
			),
			`  大口偏り: ${tradeSizes.largeTradeBias.interpretation}`,
			'',
			`---`,
			`📌 含まれるもの: VWAP＋σバンド、価格帯別出来高分布(POC/VA)、約定サイズ分布`,
			`📌 含まれないもの: 時系列フロー（CVD等）、板情報、テクニカル指標`,
			`📌 補完ツール: get_flow_metrics（CVD・スパイク）, get_orderbook（板情報）, analyze_indicators（指標）`,
		].join('\n');

		const metaExtra: Record<string, unknown> = { count: txs.length };
		if (dataWarning) metaExtra.warning = dataWarning;
		if (calcWarnings.length > 0) metaExtra.warnings = calcWarnings;
		// limit による切り捨ての明示（get_flow_metrics / get_transactions と対応）
		if (fetchResult.limitApplication) {
			metaExtra.totalAvailable = fetchResult.limitApplication.totalAvailable;
			metaExtra.truncated = fetchResult.limitApplication.truncated;
		}
		const meta = createMeta(chk.pair, metaExtra);
		return AnalyzeVolumeProfileOutputSchema.parse(
			ok<z.infer<typeof AnalyzeVolumeProfileDataSchemaOut>, z.infer<typeof AnalyzeVolumeProfileMetaSchemaOut>>(
				summary,
				data,
				meta as z.infer<typeof AnalyzeVolumeProfileMetaSchemaOut>,
			),
		);
	} catch (e: unknown) {
		return failFromError(e, { schema: AnalyzeVolumeProfileOutputSchema });
	}
}

// ── MCP ツール定義（tool-registry から自動収集） ──
export const toolDef: ToolDefinition = {
	name: 'analyze_volume_profile',
	description:
		`[Volume Profile / VWAP / POC] 出来高プロファイル分析（volume profile / VWAP / POC / value area）。VWAP±σバンド・価格帯別出来高・約定サイズ分布を算出。hours で期間指定（デフォルト4h、最大24h）。` +
		`\n\nデータソース制約（bitbank 側仕様）: 約定アーカイブ /transactions/{YYYYMMDD} は UTC 暦日単位で、当該 UTC 日の完了後にのみ公開される。完了済み UTC 日は**全件**（1日あたり数千件）を集計に使う。進行中の UTC 日（JST 09:00 で切り替わる）は /transactions (latest, 直近約60件) のみ。` +
		`\n\nカバレッジ申告: params.timeRange は durationMin（先頭〜末尾のスパン）に加えて coveredMin（実データがある区間の合計）/ gapMin / segments を返す。欠損があれば meta.warning（取得層）と meta.warnings（計算層: 集計値がカバー区間のみ由来である旨）で明示される。` +
		`\n\n加工契約: 内部の約定列は timestampMs 昇順にソート済み。latest と date ベースのマージ時の重複除去キーは \`timestampMs:price:amount:side\`（transaction_id は使用しない）。`,
	inputSchema: AnalyzeVolumeProfileInputSchema,
	handler: async (rawInput: Record<string, unknown>) => {
		const parsed = AnalyzeVolumeProfileInputSchema.parse(rawInput);
		return analyzeVolumeProfile(
			parsed.pair,
			'hours' in rawInput ? parsed.hours : undefined,
			parsed.limit,
			parsed.bins,
			parsed.valueAreaPct,
			parsed.tz,
		);
	},
};
