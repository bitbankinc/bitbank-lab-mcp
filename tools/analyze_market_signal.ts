import type { z } from 'zod';
import { formatPercent, formatPriceJPY } from '../lib/formatter.js';
import { lastCrossover, sma } from '../lib/indicators.js';
import { fail, failFromError, failFromValidation, ok } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { collectUpstreamWarnings, prependWarnings } from '../lib/warning-propagation.js';
import {
	type AnalyzeMarketSignalDataSchemaOut,
	type AnalyzeMarketSignalMetaSchemaOut,
	AnalyzeMarketSignalOutputSchema,
} from '../src/schemas.js';
import analyzeIndicators from './analyze_indicators.js';
import getFlowMetrics from './get_flow_metrics.js';
import getVolatilityMetrics from './get_volatility_metrics.js';

// ── buildMarketSignalText ──────────────────────────────────────

export type BuildMarketSignalTextInput = {
	pair: string;
	type: string;
	score: number;
	recommendation: string;
	confidence: { level: string; reason: string };
	latestClose: number | null | undefined;
	sma: {
		sma25: number | null | undefined;
		sma75: number | null | undefined;
		sma200: number | null | undefined;
	};
	smaArrangement: 'bullish' | 'bearish' | 'mixed';
	smaPosition: 'above_all' | 'below_all' | 'mixed';
	smaDeviations: { vs25?: number; vs75?: number; vs200?: number };
	recentCross: { type: 'golden_cross' | 'death_cross'; pair: string; barsAgo: number } | null;
	factors: {
		smaTrendFactor: number;
		momentumFactor: number;
		cvdTrend: number;
		volatilityFactor: number;
		buyPressure: number;
	};
	contributions: {
		sma: number;
		mom: number;
		cvd: number;
		vol: number;
		buy: number;
	};
	rsi: number | null;
	rvNum: number;
	buyRatio: number;
	nextActions: Array<{ priority: string; tool: string; reason: string; suggestedParams?: Record<string, unknown> }>;
	alerts: Array<{ level: string; message: string }>;
};

export function buildMarketSignalText(input: BuildMarketSignalTextInput): string {
	const {
		pair,
		type,
		score,
		recommendation,
		confidence,
		latestClose,
		sma,
		smaArrangement,
		smaPosition,
		smaDeviations,
		recentCross,
		factors,
		contributions,
		rsi,
		rvNum,
		buyRatio,
		nextActions,
		alerts,
	} = input;
	const { smaTrendFactor, momentumFactor, cvdTrend, volatilityFactor, buyPressure } = factors;
	const { sma25, sma75, sma200 } = sma;

	const score100 = Math.round(score * 100);
	const priceNowStr = formatPriceJPY(latestClose);
	const relToNow = (smaVal?: number | null) => {
		if (smaVal == null || latestClose == null || latestClose === 0) return 'n/a';
		const rel = ((smaVal - latestClose) / latestClose) * 100;
		return `${formatPercent(rel, { sign: true, digits: 2 })}${rel >= 0 ? '上' : '下'}`;
	};
	const sma25Line = sma25 != null ? `${formatPriceJPY(sma25)}（現在より${relToNow(sma25)}）` : 'n/a';
	const sma75Line = sma75 != null ? `${formatPriceJPY(sma75)}（現在より${relToNow(sma75)}）` : 'n/a';
	const sma200Line = sma200 != null ? `${formatPriceJPY(sma200)}（現在より${relToNow(sma200)}）` : 'n/a';
	const arrangementStr =
		smaArrangement === 'bullish'
			? '上向き（短期 > 長期）'
			: smaArrangement === 'bearish'
				? '下向き（短期 < 長期）'
				: '混在';

	const toState = (v: number) => (v > 0.1 ? 'up' : v < -0.1 ? 'down' : 'flat');
	const momentumState = toState(momentumFactor);
	const cvdState = toState(cvdTrend);

	const buyLabel =
		buyPressure > 0.2
			? '買い優勢'
			: buyPressure > 0.05
				? 'やや買い優勢'
				: buyPressure < -0.2
					? '売り優勢'
					: buyPressure < -0.05
						? 'やや売り優勢'
						: '拮抗';
	const cvdLabel = cvdState === 'up' ? '上昇中' : cvdState === 'down' ? '下降中' : '横ばい';
	const momLabel = momentumState === 'up' ? '上昇中' : momentumState === 'down' ? '下降中' : '横ばい';
	const volLabel = volatilityFactor > 0.2 ? '落ち着いている' : volatilityFactor < -0.2 ? '荒い' : '中庸';

	const nextLines = nextActions.slice(0, 2).map((a, i) => {
		const num = `${i + 1}.`;
		const params = a.suggestedParams ? ` ${JSON.stringify(a.suggestedParams)}` : '';
		return `${num} ${a.tool}${params}`;
	});

	const orderStr = (() => {
		if (latestClose == null || sma25 == null || sma75 == null || sma200 == null) return '';
		if (smaArrangement === 'bearish') return '200 > 75 > 25 > 現在価格';
		if (smaArrangement === 'bullish') return '現在価格 > 25 > 75 > 200';
		return '';
	})();
	const trendLabel = smaArrangement === 'bearish' ? '弱気' : smaArrangement === 'bullish' ? '強気' : '不明瞭';
	const positionLabel = (() => {
		if (smaPosition === 'above_all') return '全平均の上';
		if (smaPosition === 'below_all') return '全平均の下';
		return '一部の平均と交差';
	})();
	const crossLine = (() => {
		if (!recentCross) return '';
		const jpType = recentCross.type === 'golden_cross' ? 'ゴールデンクロス' : 'デッドクロス';
		const action = recentCross.type === 'golden_cross' ? '上抜け' : '下抜け';
		const ago = recentCross.barsAgo || 0;
		return `直近クロス: ${ago}日前に${jpType}（25日が75日を${action}）`;
	})();

	return [
		`${String(pair).toUpperCase()} [${String(type)}]`,
		`総合スコア: ${score100}（${recommendation}、信頼度: ${confidence.level}）`,
		`※ トレンド重視型（中長期35%+30% / 短期20% / 瞬間5%）`,
		'',
		'【価格情報】',
		`現在価格: ${priceNowStr}`,
		'',
		'【SMA詳細】',
		`- 短期（25日平均）: ${sma25Line}`,
		`- 中期（75日平均）: ${sma75Line}`,
		`- 長期（200日平均）: ${sma200Line}`,
		`配置: ${smaArrangement === 'bearish' ? '下降順' : smaArrangement === 'bullish' ? '上昇順' : '混在'}${orderStr ? `（${orderStr}）` : ''} → トレンド: ${trendLabel}`,
		`位置: ${positionLabel}`,
		...(crossLine ? [crossLine] : []),
		'',
		'【各要素の詳細】',
		`- 平均価格の配置（重み35%）: ${smaTrendFactor.toFixed(2)}（${arrangementStr}）`,
		`- 勢いの変化（重み30%）: ${momentumFactor.toFixed(2)}（${momLabel}${rsi != null ? `、RSI=${Math.round(rsi)}` : ''}）`,
		`- 出来高の流れ（重み20%）: ${cvdTrend.toFixed(2)}（${cvdLabel}）`,
		`- 値動きの荒さ（重み10%）: ${volatilityFactor.toFixed(2)}（${volLabel}）`,
		`- 板の買い圧力（重み5%）: ${buyPressure.toFixed(2)}（${buyLabel}）`,
		'',
		'【次の確認推奨】',
		...(nextLines.length ? nextLines : ['- 該当なし']),
		'',
		'【数値詳細】',
		`contributions: sma=${contributions.sma.toFixed(3)} mom=${contributions.mom.toFixed(3)} cvd=${contributions.cvd.toFixed(3)} vol=${contributions.vol.toFixed(3)} buy=${contributions.buy.toFixed(3)}`,
		`rawValues: smaTrend=${smaTrendFactor.toFixed(3)} momentum=${momentumFactor.toFixed(3)} cvdTrend=${cvdTrend.toFixed(3)} volatility=${volatilityFactor.toFixed(3)} buyPressure=${buyPressure.toFixed(3)}`,
		`confidence: ${confidence.level} (${confidence.reason})`,
		`RSI: ${rsi ?? 'n/a'} | rv_ann: ${rvNum.toFixed(4)} | aggRatio: ${buyRatio.toFixed(3)}`,
		...(smaDeviations.vs25 != null
			? [
					`SMA乖離: vs25=${(smaDeviations.vs25 * 100).toFixed(2)}% vs75=${smaDeviations.vs75 != null ? (smaDeviations.vs75 * 100).toFixed(2) : 'n/a'}% vs200=${smaDeviations.vs200 != null ? (smaDeviations.vs200 * 100).toFixed(2) : 'n/a'}%`,
				]
			: []),
		...(recentCross ? [`SMAクロス: ${recentCross.type} ${recentCross.pair} ${recentCross.barsAgo}bars前`] : []),
		...(alerts.length ? [`alerts: ${alerts.map((a) => `[${a.level}] ${a.message}`).join('; ')}`] : []),
		'',
		'---',
		'📌 含まれるもの: 総合スコア・各要素の寄与度と生値・SMA配置・信頼度・推奨アクション',
		'📌 含まれないもの: 指標の時系列詳細、個別約定データ、チャートパターン検出、板の層別分析',
		'📌 補完ツール: get_flow_metrics（フロー詳細）, get_volatility_metrics（ボラ詳細）, analyze_indicators（指標詳細）, detect_patterns（パターン）, get_orderbook（板情報）',
	].join('\n');
}

// ── main function ──────────────────────────────────────────────

type AnalyzeOpts = {
	type?: string;
	flowLimit?: number;
	bucketMs?: number;
	windows?: number[];
	horizonBuckets?: number;
};

function clamp(x: number, min: number, max: number) {
	return Math.max(min, Math.min(max, x));
}

export default async function analyzeMarketSignal(pair: string = 'btc_jpy', opts: AnalyzeOpts = {}) {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk, AnalyzeMarketSignalOutputSchema);

	const type = opts.type || '1day';
	const flowLimit = Math.max(50, Math.min(opts.flowLimit ?? 300, 2000));
	const bucketMs = Math.max(1_000, Math.min(opts.bucketMs ?? 60_000, 3_600_000));
	const windows = (opts.windows?.length ? opts.windows : [14, 20, 30]).slice(0, 3);
	const horizon = Math.max(5, Math.min(opts.horizonBuckets ?? 10, 100));

	try {
		const [flowRes, volRes, indRes] = await Promise.all([
			getFlowMetrics(chk.pair, flowLimit, undefined, bucketMs),
			getVolatilityMetrics(chk.pair, type, 200, windows, { annualize: true }),
			// SMA25/75/200 を扱うため十分な本数を取得（最低200+バッファ）
			analyzeIndicators(chk.pair, type, 220),
		]);

		if (!flowRes?.ok)
			return AnalyzeMarketSignalOutputSchema.parse(
				fail(
					flowRes?.summary || 'flow failed',
					(!flowRes.ok && 'errorType' in flowRes.meta ? flowRes.meta.errorType : undefined) || 'internal',
				),
			);
		if (!volRes?.ok)
			return AnalyzeMarketSignalOutputSchema.parse(
				fail(
					volRes?.summary || 'vol failed',
					(!volRes.ok && 'errorType' in volRes.meta ? volRes.meta.errorType : undefined) || 'internal',
				),
			);
		if (!indRes?.ok)
			return AnalyzeMarketSignalOutputSchema.parse(
				fail(
					indRes?.summary || 'indicators failed',
					(!indRes.ok && 'errorType' in indRes.meta ? indRes.meta.errorType : undefined) || 'internal',
				),
			);

		// 上流 meta から warning / warnings を集約する。
		// - meta.warning (string): 取得層の不完全性。3 ツールそれぞれの meta.warning を改行連結し、
		//   どのツール由来か追跡できるよう `[flow] / [volatility] / [indicators]` の prefix を付ける。
		// - meta.warnings (string[]): 計算層の不完全性。analyze_indicators のみが出すので、
		//   そのまま継承する。warning と warnings は同じ field に混ぜない（別系統）。
		const upstreamWarning = collectUpstreamWarnings([
			{ source: 'flow', warning: (flowRes.meta as { warning?: string }).warning },
			{ source: 'volatility', warning: (volRes.meta as { warning?: string }).warning },
			{ source: 'indicators', warning: (indRes.meta as { warning?: string }).warning },
		]);
		const rawIndWarnings = (indRes.meta as { warnings?: string[] }).warnings;
		const upstreamWarnings =
			Array.isArray(rawIndWarnings) && rawIndWarnings.length > 0 ? [...rawIndWarnings] : undefined;

		// Flow metrics
		const agg = flowRes.data.aggregates || {};
		const buckets = (flowRes.data.series?.buckets || []) as Array<{ cvd: number }>;
		const cvdSeries = buckets.map((b) => b.cvd);
		const cvdSlice = cvdSeries.slice(-horizon);
		const cvdSlope = cvdSlice.length >= 2 ? cvdSlice[cvdSlice.length - 1] - cvdSlice[0] : 0;
		const cvdNormBase = Math.max(1, Math.max(...cvdSlice.map((v) => Math.abs(v))) || 1);
		const cvdTrend = clamp(cvdSlope / cvdNormBase, -1, 1);
		const buyRatio = typeof agg.aggressorRatio === 'number' ? agg.aggressorRatio : 0.5;
		const buyPressure = clamp((buyRatio - 0.5) * 2, -1, 1);

		// Volatility
		const rv = volRes?.data?.aggregates?.rv_std_ann ?? volRes?.data?.aggregates?.rv_std;
		const rvNum = typeof rv === 'number' ? rv : 0.5; // typical range ~0.2-0.8
		const volatilityFactor = clamp((0.5 - rvNum) / 0.5, -1, 1); // 低ボラほど +

		// Indicators
		const rsi = indRes?.data?.indicators?.RSI_14 as number | null;
		const momentumFactor = rsi == null ? 0 : clamp((rsi - 50) / 50, -1, 1);
		// SMA trend factor: price vs SMA25/75 alignment and distance to SMA200
		const latestClose = indRes?.data?.normalized?.at(-1)?.close as number | undefined;
		const sma25 = indRes?.data?.indicators?.SMA_25 as number | null | undefined;
		const sma75 = indRes?.data?.indicators?.SMA_75 as number | null | undefined;
		const sma200 = indRes?.data?.indicators?.SMA_200 as number | null | undefined;
		let smaTrendFactor = 0;
		let smaArrangement: 'bullish' | 'bearish' | 'mixed' = 'mixed';
		let smaDeviations: { vs25?: number; vs75?: number; vs200?: number } = {};
		if (latestClose != null && sma25 != null && sma75 != null) {
			// alignment bonus
			const alignedUp = latestClose > sma25 && (sma25 as number) > (sma75 as number);
			const alignedDown = latestClose < sma25 && (sma25 as number) < (sma75 as number);
			if (alignedUp) smaTrendFactor += 0.6;
			else if (alignedDown) smaTrendFactor -= 0.6;
			smaArrangement = alignedUp ? 'bullish' : alignedDown ? 'bearish' : 'mixed';
			// distance to SMA200 (above -> positive, below -> negative), normalized by 5% band
			if (sma200 != null) {
				const dist = (latestClose - (sma200 as number)) / (sma200 as number);
				smaTrendFactor += clamp(dist / 0.05, -0.4, 0.4);
			}
			smaTrendFactor = clamp(smaTrendFactor, -1, 1);
			// deviations (percent) vs SMA
			const pct = (val: number | null | undefined) =>
				val != null && latestClose != null && val !== 0 ? (latestClose - val) / val : undefined;
			smaDeviations = {
				vs25: pct(sma25 ?? null),
				vs75: pct(sma75 ?? null),
				vs200: pct(sma200 ?? null),
			};
		}
		// SMA position classification relative to all SMAs
		let smaPosition: 'above_all' | 'below_all' | 'mixed' = 'mixed';
		if (latestClose != null && sma25 != null && sma75 != null && sma200 != null) {
			if (latestClose > sma25 && latestClose > sma75 && latestClose > sma200) smaPosition = 'above_all';
			else if (latestClose < sma25 && latestClose < sma75 && latestClose < sma200) smaPosition = 'below_all';
			else smaPosition = 'mixed';
		}
		// Recent cross detection for 25/75 using normalized closes.
		// 全長 SMA 系列（lib/indicators.ts の sma — NaN 埋めで時間インデックスが揃う）を
		// lastCrossover に渡して直近クロスを取る。barsAgo は最新足からの本数。
		let recentCross: { type: 'golden_cross' | 'death_cross'; pair: '25/75'; barsAgo: number } | null = null;
		try {
			const normalized = indRes.data.normalized;
			const closes: number[] = Array.isArray(normalized)
				? normalized.map((c) => Number(c?.close)).filter((v) => Number.isFinite(v))
				: [];
			if (closes.length >= 80) {
				const cross = lastCrossover(sma(closes, 25), sma(closes, 75));
				if (cross) {
					recentCross = {
						type: cross.type === 'golden' ? 'golden_cross' : 'death_cross',
						pair: '25/75',
						barsAgo: cross.barsAgo,
					};
				}
			}
		} catch {
			/* ignore cross calc errors */
		}

		// Composite score
		// トレンド重視型（初心者向け）: 中長期トレンドを重視し、瞬間的な板の変動を抑制
		const weights = { smaTrend: 0.35, momentum: 0.3, cvdTrend: 0.2, volatility: 0.1, buyPressure: 0.05 } as const;
		const contribution_buy = buyPressure * weights.buyPressure;
		const contribution_cvd = cvdTrend * weights.cvdTrend;
		const contribution_mom = momentumFactor * weights.momentum;
		const contribution_vol = volatilityFactor * weights.volatility;
		const contribution_sma = smaTrendFactor * weights.smaTrend;
		const score = Number(
			(contribution_buy + contribution_cvd + contribution_mom + contribution_vol + contribution_sma).toFixed(3),
		);

		const recommendation = score >= 0.25 ? 'bullish' : score <= -0.25 ? 'bearish' : 'neutral';
		const tags: string[] = [];
		if (buyPressure > 0.2) tags.push('buy_pressure');
		if (cvdTrend > 0.2) tags.push('positive_cvd');
		if (volatilityFactor > 0.2) tags.push('low_vol');
		if (rsi != null && rsi < 35) tags.push('oversold_bias');
		if (rsi != null && rsi > 65) tags.push('overbought_risk');

		function calculateConfidence(
			contributions: { buyPressure: number; cvdTrend: number; momentum: number; volatility: number; smaTrend: number },
			score: number,
			quality: { hasUpstreamWarning: boolean; missingCoreFactors: string[] },
		) {
			// 主要要素が欠損していたら寄与計算が破綻するので low 固定（§9.4）。
			if (quality.missingCoreFactors.length > 0) {
				return {
					level: 'low' as const,
					reason: `主要要素のデータ不足: ${quality.missingCoreFactors.join(', ')}`,
				};
			}
			const contribValues = Object.values(contributions);
			const sorted = contribValues
				.map((val, idx) => ({ value: val, index: idx }))
				.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
			const top3Signs = sorted.slice(0, 3).map((x) => Math.sign(x.value));
			const allPositive = top3Signs.every((s) => s > 0);
			const allNegative = top3Signs.every((s) => s < 0);
			const top2Match = top3Signs[0] === top3Signs[1];
			const maxContribution = Math.abs(sorted[0].value);
			if ((allPositive || allNegative) && maxContribution >= 0.15) {
				// 取得層 warning がある場合は high にしない（最大 medium、§9.4）。
				if (quality.hasUpstreamWarning) {
					return {
						level: 'medium' as const,
						reason: '主要3要素が同方向で一致するが、上流データに取得層 warning あり。high → medium に降格',
					};
				}
				return { level: 'high' as const, reason: '主要3要素が同方向で一致。シグナルの信頼性高' };
			} else if (top2Match || Math.abs(score) < 0.3) {
				const reasons: string[] = [];
				if (top2Match) reasons.push('上位2要素が一致');
				if (Math.abs(score) < 0.3) reasons.push('スコアが中立圏');
				return { level: 'medium' as const, reason: `${reasons.join('、')}。追加確認推奨` };
			} else {
				return { level: 'low' as const, reason: '主要要素間で矛盾あり。詳細分析必須' };
			}
		}

		// Precompute contributions/breakdown, confidence and next actions
		type BreakdownEntry = { rawValue: number; weight: number; contribution: number; interpretation: string };
		type Breakdown = {
			buyPressure: BreakdownEntry;
			cvdTrend: BreakdownEntry;
			momentum: BreakdownEntry;
			volatility: BreakdownEntry;
			smaTrend: BreakdownEntry;
		};

		const contributionsData = {
			buyPressure: Number(contribution_buy.toFixed(3)),
			cvdTrend: Number(contribution_cvd.toFixed(3)),
			momentum: Number(contribution_mom.toFixed(3)),
			volatility: Number(contribution_vol.toFixed(3)),
			smaTrend: Number(contribution_sma.toFixed(3)),
		};

		const breakdownData: Breakdown = {
			buyPressure: {
				rawValue: Number(buyPressure.toFixed(3)),
				weight: 0.05,
				contribution: Number(contribution_buy.toFixed(3)),
				interpretation:
					buyPressure >= 0.4 ? 'strong' : buyPressure >= 0.15 ? 'moderate' : buyPressure <= -0.15 ? 'weak' : 'neutral',
			},
			cvdTrend: {
				rawValue: Number(cvdTrend.toFixed(3)),
				weight: 0.2,
				contribution: Number(contribution_cvd.toFixed(3)),
				interpretation:
					cvdTrend >= 0.4 ? 'strong' : cvdTrend >= 0.15 ? 'moderate' : cvdTrend <= -0.15 ? 'weak' : 'neutral',
			},
			momentum: {
				rawValue: Number(momentumFactor.toFixed(3)),
				weight: 0.3,
				contribution: Number(contribution_mom.toFixed(3)),
				interpretation:
					momentumFactor >= 0.35
						? 'strong'
						: momentumFactor >= 0.1
							? 'moderate'
							: momentumFactor <= -0.1
								? 'weak'
								: 'neutral',
			},
			volatility: {
				rawValue: Number(volatilityFactor.toFixed(3)),
				weight: 0.1,
				contribution: Number(contribution_vol.toFixed(3)),
				interpretation:
					volatilityFactor >= 0.35
						? 'strong'
						: volatilityFactor >= 0.1
							? 'moderate'
							: volatilityFactor <= -0.1
								? 'weak'
								: 'neutral',
			},
			smaTrend: {
				rawValue: Number(smaTrendFactor.toFixed(3)),
				weight: 0.35,
				contribution: Number(contribution_sma.toFixed(3)),
				interpretation:
					smaTrendFactor >= 0.35
						? 'strong'
						: smaTrendFactor >= 0.1
							? 'moderate'
							: smaTrendFactor <= -0.1
								? 'weak'
								: 'neutral',
			},
		};

		// 主要要素（重み 35% smaTrend、30% momentum）に必要なデータが揃っているかを判定。
		// 欠損があると寄与計算が無効化されるので、confidence を low 固定にする（§9.4）。
		// smaTrend は latestClose / sma25 / sma75 すべてを要求する（L287 のガード参照）。
		// いずれかが null なら smaTrendFactor=0 になり寄与 35% が黙って消えるので core 扱い。
		const missingCoreFactors: string[] = [];
		if (latestClose == null) missingCoreFactors.push('latestClose');
		if (sma200 == null) missingCoreFactors.push('SMA_200');
		if (sma75 == null) missingCoreFactors.push('SMA_75');
		if (sma25 == null) missingCoreFactors.push('SMA_25');
		if (rsi == null) missingCoreFactors.push('RSI_14');
		const confidence = calculateConfidence(contributionsData, score, {
			hasUpstreamWarning: !!upstreamWarning,
			missingCoreFactors,
		});

		function generateNextActions(
			breakdown: Breakdown,
			scoreVal: number,
			conf: { level: 'high' | 'medium' | 'low'; reason: string },
		) {
			const actions: Array<{
				priority: 'high' | 'medium' | 'low';
				tool: string;
				reason: string;
				suggestedParams?: Record<string, unknown>;
			}> = [];
			const cvdContribAbs = Math.abs(breakdown.cvdTrend.contribution);
			if (cvdContribAbs < 0.1) {
				actions.push({
					priority: 'high',
					tool: 'get_flow_metrics',
					reason: `CVD寄与が弱い(${breakdown.cvdTrend.contribution.toFixed(2)})。実際のフロー・スパイク確認推奨`,
					suggestedParams: { bucketMs: 60000, limit: 300 },
				});
			}
			const volContribAbs = Math.abs(breakdown.volatility.contribution);
			if (volContribAbs > 0.08 || breakdown.volatility.interpretation === 'strong') {
				actions.push({
					priority: volContribAbs > 0.12 ? 'high' : 'medium',
					tool: 'get_volatility_metrics',
					reason: `ボラティリティ寄与が${volContribAbs > 0.12 ? '大' : '中程度'}(${breakdown.volatility.contribution.toFixed(2)})。詳細確認推奨`,
					suggestedParams: { windows: [14, 20, 30], type: '1day' },
				});
			}
			const momContribAbs = Math.abs(breakdown.momentum.contribution);
			if (momContribAbs > 0.1) {
				actions.push({
					priority: momContribAbs > 0.15 ? 'high' : 'medium',
					tool: 'get_indicators',
					reason: `モメンタム寄与が${momContribAbs > 0.15 ? '大' : '中程度'}(${breakdown.momentum.contribution.toFixed(2)})。指標詳細確認推奨`,
					suggestedParams: { limit: 200 },
				});
			}
			const buyPressureAbs = Math.abs(breakdown.buyPressure.rawValue);
			if (buyPressureAbs > 0.5) {
				actions.push({
					priority: 'medium',
					tool: 'get_orderbook',
					reason: `板圧力が極端(${breakdown.buyPressure.rawValue.toFixed(2)})。帯域別分析推奨`,
					suggestedParams: { mode: 'pressure', bandsPct: [0.001, 0.005, 0.01] },
				});
			}
			if (Math.abs(scoreVal) < 0.3) {
				actions.push({
					priority: 'medium',
					tool: 'detect_patterns',
					reason: `スコア中立圏(${scoreVal.toFixed(3)})。レンジ・パターン形成可能性`,
					suggestedParams: { view: 'detailed' },
				});
			}
			if (conf.level === 'low') {
				actions.push({
					priority: 'high',
					tool: 'analyze_indicators',
					reason: '要素間で矛盾。複数角度からの検証必須',
					suggestedParams: { limit: 200 },
				});
			}
			const priorityOrder: Record<'high' | 'medium' | 'low', number> = { high: 0, medium: 1, low: 2 };
			return actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
		}

		const nextActions = generateNextActions(breakdownData, score, confidence);

		const alerts = (() => {
			const a: Array<{ level: 'info' | 'warning' | 'critical'; message: string }> = [];
			if (Math.abs(breakdownData.volatility.contribution) < 0.03) {
				a.push({ level: 'info', message: 'ボラティリティ寄与が低い。急変時に注意' });
			}
			if (confidence.level === 'low') {
				a.push({ level: 'warning', message: '要素間の矛盾あり。詳細分析を強く推奨' });
			}
			return a;
		})();

		// Direction states helper
		const toState = (v: number) => (v > 0.1 ? 'up' : v < -0.1 ? 'down' : 'flat');
		const momentumState = toState(momentumFactor);
		const cvdState = toState(cvdTrend);
		// Timeframe recommendation (simple): suggest 4hour when annualized RV is high
		const recommendedTimeframes: string[] = ['1day', ...(rvNum > 0.6 ? ['4hour'] : [])];

		const data = {
			score,
			recommendation,
			tags,
			formula: 'score = 0.35*smaTrend + 0.30*momentum + 0.20*cvdTrend + 0.10*volatility + 0.05*buyPressure',
			weights: { smaTrend: 0.35, momentum: 0.3, cvdTrend: 0.2, volatility: 0.1, buyPressure: 0.05 },
			contributions: contributionsData,
			breakdown: breakdownData,
			topContributors: ['smaTrend', 'momentum', 'cvdTrend', 'volatility', 'buyPressure']
				.map((k) => [
					k,
					{
						buyPressure: contribution_buy,
						cvdTrend: contribution_cvd,
						smaTrend: contribution_sma,
						momentum: contribution_mom,
						volatility: contribution_vol,
					}[k as 'buyPressure'] as number,
				])
				.sort((a, b) => Math.abs(b[1] as number) - Math.abs(a[1] as number))
				.slice(0, 2)
				.map((x) => x[0]) as Array<'buyPressure' | 'cvdTrend' | 'momentum' | 'volatility' | 'smaTrend'>,
			confidence: confidence.level,
			confidenceReason: confidence.reason,
			nextActions,
			alerts,
			thresholds: { bullish: 0.25, bearish: -0.25 },
			metrics: {
				buyPressure,
				cvdTrend,
				momentumFactor,
				volatilityFactor,
				smaTrendFactor,
				rsi: rsi ?? null,
				rv_std_ann: rvNum,
				aggressorRatio: buyRatio,
				cvdSlope,
				horizon,
			},
			states: {
				momentum: momentumState,
				cvdTrend: cvdState,
			},
			sma: {
				current: latestClose ?? null,
				values: { sma25: sma25 ?? null, sma75: sma75 ?? null, sma200: sma200 ?? null },
				deviations: {
					vs25: smaDeviations.vs25 != null ? Number((smaDeviations.vs25 * 100).toFixed(2)) : null,
					vs75: smaDeviations.vs75 != null ? Number((smaDeviations.vs75 * 100).toFixed(2)) : null,
					vs200: smaDeviations.vs200 != null ? Number((smaDeviations.vs200 * 100).toFixed(2)) : null,
				},
				arrangement: smaArrangement,
				position: smaPosition,
				distanceFromSma25Pct: smaDeviations.vs25 != null ? Number((smaDeviations.vs25 * 100).toFixed(2)) : null,
				recentCross,
			},
			recommendedTimeframes,
			refs: {
				flow: { aggregates: flowRes.data.aggregates, lastBuckets: buckets.slice(-Math.min(5, buckets.length)) },
				volatility: { aggregates: volRes.data.aggregates },
				indicators: { latest: indRes.data.indicators, trend: indRes.data.trend },
			},
		};

		const baseText = buildMarketSignalText({
			pair: chk.pair,
			type,
			score,
			recommendation,
			confidence,
			latestClose,
			sma: { sma25, sma75, sma200 },
			smaArrangement,
			smaPosition,
			smaDeviations,
			recentCross,
			factors: { smaTrendFactor, momentumFactor, cvdTrend, volatilityFactor, buyPressure },
			contributions: {
				sma: contribution_sma,
				mom: contribution_mom,
				cvd: contribution_cvd,
				vol: contribution_vol,
				buy: contribution_buy,
			},
			rsi: rsi ?? null,
			rvNum,
			buyRatio,
			nextActions,
			alerts,
		});

		// summary 先頭に warning / warnings を別行で連結する（取得層 / 計算層を別系統で出す）。
		// LLM は structuredContent.meta を参照できないため、テキストに警告を出さないと
		// データ不完全性を見落とす。prepare_chart_data と同じパターン。
		const fullText = prependWarnings(
			baseText,
			{ warning: upstreamWarning, warnings: upstreamWarnings },
			{ separator: '\n' },
		);

		const meta: Record<string, unknown> = createMeta(chk.pair, { type, windows, bucketMs, flowLimit });
		if (upstreamWarning) meta.warning = upstreamWarning;
		if (upstreamWarnings && upstreamWarnings.length > 0) meta.warnings = upstreamWarnings;
		return AnalyzeMarketSignalOutputSchema.parse(
			ok(
				fullText,
				data as z.infer<typeof AnalyzeMarketSignalDataSchemaOut>,
				meta as z.infer<typeof AnalyzeMarketSignalMetaSchemaOut>,
			),
		);
	} catch (e: unknown) {
		return failFromError(e, { schema: AnalyzeMarketSignalOutputSchema });
	}
}
