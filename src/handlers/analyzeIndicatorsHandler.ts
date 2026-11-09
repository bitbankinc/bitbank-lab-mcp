import type { z } from 'zod';
import { nowIso, resolveTz, toDisplayTime } from '../../lib/datetime.js';
import {
	barCountLabel,
	barsAgoLabel,
	formatDeviation,
	formatExactPrice,
	formatPercent,
	formatPriceAtLevel,
	formatPriceJPY,
	formatTrendSymbol,
	prevBarChangeLabel,
} from '../../lib/formatter.js';
import { ICHIMOKU_SHIFT, RSI_MIDLINE } from '../../lib/indicator-config.js';
import { rsiZoneLabel, stochZone, stochZoneLabel } from '../../lib/indicator-zones.js';
import { currentCloudSpans, lastCrossover } from '../../lib/indicators.js';
import { EPSILON } from '../../lib/math.js';
import { prependProvisionalNote } from '../../lib/provisional-bar.js';
import { toStructured } from '../../lib/result.js';
import { prependWarnings } from '../../lib/warning-propagation.js';
import analyzeIndicators from '../../tools/analyze_indicators.js';
import { GetIndicatorsInputSchema } from '../schemas.js';
import type { ToolDefinition } from '../tool-definition.js';

export interface BuildIndicatorsTextInput {
	pair: string;
	type: string;
	nowJst: string;
	timeContext?: string;
	close: number | null;
	prev: number | null;
	deltaPrev: { amt: number; pct: number } | null;
	deltaLabel: string;
	trend: string;
	rsi: number | null;
	recentRsiFormatted: string[];
	macdLine: number | null;
	macdSignal: number | null;
	macdHist: number | null;
	lastMacdCross: { type: 'golden' | 'dead'; barsAgo: number } | null;
	divergence: string | null;
	sma25: number | null;
	sma75: number | null;
	sma200: number | null;
	s25Slope: number | null;
	s75Slope: number | null;
	s200Slope: number | null;
	arrangement: string;
	crossInfo: string | null;
	bbMid: number | null;
	bbUp: number | null;
	bbLo: number | null;
	sigmaZ: number | null;
	bandWidthPct: number | null;
	bwTrend: string | null;
	sigmaHistory: Array<{ off: number; z: number } | null> | null;
	tenkan: number | null;
	kijun: number | null;
	spanA: number | null;
	spanB: number | null;
	cloudTop: number | null;
	cloudBot: number | null;
	cloudPos: string;
	cloudThickness: number | null;
	cloudThicknessPct: number | null;
	chikouBull: boolean | null;
	threeSignals: { judge: string };
	toCloudDistance: number | null;
	ichimokuConvSlope: number | null;
	ichimokuBaseSlope: number | null;
	stochK: number | null;
	stochD: number | null;
	stochPrevK: number | null;
	stochPrevD: number | null;
	obvVal: number | null;
	obvSma20: number | null;
	obvTrend: string | null;
	obvPrev: number | null;
	obvUnit: string;
}

export function buildIndicatorsText(input: BuildIndicatorsTextInput): string {
	const {
		pair,
		type,
		nowJst,
		timeContext,
		close,
		prev,
		deltaPrev,
		deltaLabel,
		trend,
		rsi,
		recentRsiFormatted,
		macdLine,
		macdSignal,
		macdHist,
		lastMacdCross,
		divergence,
		sma25,
		sma75,
		sma200,
		s25Slope,
		s75Slope,
		s200Slope,
		arrangement,
		crossInfo,
		bbMid,
		bbUp,
		bbLo,
		sigmaZ,
		bandWidthPct,
		bwTrend,
		sigmaHistory,
		tenkan,
		kijun,
		spanA,
		spanB,
		cloudTop: _cloudTop,
		cloudBot: _cloudBot,
		cloudPos,
		cloudThickness,
		cloudThicknessPct,
		chikouBull,
		threeSignals,
		toCloudDistance,
		ichimokuConvSlope,
		ichimokuBaseSlope,
		stochK,
		stochD,
		stochPrevK,
		stochPrevD,
		obvVal,
		obvSma20,
		obvTrend,
		obvPrev,
		obvUnit,
	} = input;

	const vsCurPct = (ref?: number | null) => formatDeviation(close, ref);

	const lines: string[] = [];
	lines.push(`=== ${String(pair).toUpperCase()} ${String(type)} 分析 ===`);
	lines.push(timeContext ?? `${nowJst} 現在`);
	const chgLine = deltaPrev ? `(${deltaLabel}: ${formatPercent(deltaPrev.pct, { sign: true, digits: 1 })})` : '';
	const closeStr = close != null ? `${formatExactPrice(close)}円` : 'n/a';
	lines.push(deltaPrev ? `${closeStr} ${chgLine}` : closeStr);
	lines.push('');
	lines.push('【総合判定】');
	const trendText =
		trend === 'strong_downtrend' ? '強い下降トレンド ⚠️' : trend === 'uptrend' ? '上昇トレンド' : '中立/レンジ';
	const rsiLabel = rsiZoneLabel(rsi) ?? '—';
	const bwState =
		bandWidthPct == null ? '—' : bandWidthPct < 8 ? 'スクイーズ' : bandWidthPct > 20 ? 'エクスパンション' : '標準';
	lines.push(`  トレンド: ${trendText}`);
	lines.push(`  勢い: RSI=${rsi ?? 'n/a'} → ${rsiLabel}`);
	lines.push(
		`  リスク: BB幅=${bandWidthPct != null ? `${bandWidthPct}%` : 'n/a'} → ${bwState}${bwTrend ? `（${bwTrend}）` : ''}`,
	);
	lines.push('');
	lines.push('【モメンタム】');
	lines.push(`  RSI(14): ${rsi ?? 'n/a'} → ${rsiLabel}`);
	if (recentRsiFormatted.length >= 2) {
		lines.push(`    【RSI推移（直近${barCountLabel(recentRsiFormatted.length, type)}）】`);
		lines.push('');
		lines.push(`    ${recentRsiFormatted.join(' → ')}`);
	}
	// MACD は価格の差なので、値自体ではなく価格の水準で桁を決める。
	const fmtMacd = (v: number | null) => (v == null || !Number.isFinite(v) ? 'n/a' : formatPriceAtLevel(v, close ?? v));
	const macdLineFmt = fmtMacd(macdLine);
	const macdSignalFmt = fmtMacd(macdSignal);
	const macdHistFmt = fmtMacd(macdHist);
	const macdHint =
		macdHist == null ? '—' : Number(macdHist) >= 0 ? '強気継続（プラス＝上昇圧力）' : '弱気継続（マイナス＝下落圧力）';
	lines.push(`  MACD(12,26,9): line=${macdLineFmt} signal=${macdSignalFmt} hist=${macdHistFmt} → ${macdHint}`);
	const crossStr = lastMacdCross
		? `${lastMacdCross.type === 'golden' ? 'ゴールデン' : 'デッド'}クロス: ${lastMacdCross.barsAgo}本前`
		: '直近クロス: なし';
	lines.push(`    ・${crossStr}`);
	lines.push(`    ・ダイバージェンス: ${divergence ?? 'なし'}`);
	lines.push('');
	lines.push('【トレンド（移動平均線）】');
	lines.push(`  配置: ${arrangement}`);
	lines.push(`  SMA(25): ${formatPriceJPY(sma25)} (${vsCurPct(sma25)}) ${formatTrendSymbol(s25Slope)}`);
	lines.push(`  SMA(75): ${formatPriceJPY(sma75)} (${vsCurPct(sma75)}) ${formatTrendSymbol(s75Slope)}`);
	lines.push(`  SMA(200): ${formatPriceJPY(sma200)} (${vsCurPct(sma200)}) ${formatTrendSymbol(s200Slope)}`);
	if (crossInfo) lines.push(`  ${crossInfo}`);
	lines.push('');
	lines.push('【ボラティリティ（ボリンジャーバンド±2σ）】');
	lines.push(
		`  現在位置: ${sigmaZ != null ? `${sigmaZ}σ` : 'n/a'} → ${sigmaZ != null ? (sigmaZ <= -1 ? '売られすぎ' : sigmaZ >= 1 ? '買われすぎ' : '中立') : '—'}`,
	);
	lines.push(`  middle: ${formatPriceJPY(bbMid)} (${vsCurPct(bbMid)})`);
	lines.push(`  upper:  ${formatPriceJPY(bbUp)} (${vsCurPct(bbUp)})`);
	lines.push(
		`  lower:  ${formatPriceJPY(bbLo)} (${vsCurPct(bbLo)})${bbLo != null && close != null && Number(bbLo) < Number(close) ? '' : ' ← 現在価格に近い'}`,
	);
	if (bandWidthPct != null) lines.push(`  バンド幅: ${bandWidthPct}% → ${bwTrend ?? '—'}`);
	if (sigmaHistory?.[0] && sigmaHistory[1]) {
		const ago5 = sigmaHistory[0]?.z;
		const curZ = sigmaHistory[1]?.z;
		lines.push('  過去推移:');
		if (ago5 != null) lines.push(`    ・${barsAgoLabel(5, type)}: ${ago5}σ`);
		if (curZ != null) lines.push(`    ・現在: ${curZ}σ`);
	}
	lines.push('');
	lines.push('【一目均衡表】');
	// 'unknown' は中立に丸めない。丸めるとデータ欠落が「雲の中（中立）」と表示される。
	lines.push(
		`  現在位置: ${
			cloudPos === 'below_cloud'
				? '雲の下 → 弱気'
				: cloudPos === 'above_cloud'
					? '雲の上 → 強気'
					: cloudPos === 'in_cloud'
						? '雲の中 → 中立'
						: 'n/a（雲データ不足）'
		}`,
	);
	lines.push(`  転換線: ${formatPriceJPY(tenkan)} (${vsCurPct(tenkan)}) ${formatTrendSymbol(ichimokuConvSlope)}`);
	lines.push(`  基準線: ${formatPriceJPY(kijun)} (${vsCurPct(kijun)}) ${formatTrendSymbol(ichimokuBaseSlope)}`);
	lines.push(`  先行スパンA: ${formatPriceJPY(spanA)} (${vsCurPct(spanA)})`);
	lines.push(`  先行スパンB: ${formatPriceJPY(spanB)} (${vsCurPct(spanB)})`);
	if (cloudThickness != null)
		lines.push(
			`  雲の厚さ: ${formatPriceJPY(cloudThickness, close)}（${cloudThicknessPct != null ? `${cloudThicknessPct.toFixed(1)}%` : 'n/a'}）`,
		);
	if (chikouBull != null) lines.push(`  遅行スパン: ${chikouBull ? '価格より上 → 強気' : '価格より下 → 弱気'}`);
	if (threeSignals) lines.push(`  三役判定: ${threeSignals.judge}`);
	if (toCloudDistance != null && cloudPos === 'below_cloud') lines.push(`  雲突入まで: ${toCloudDistance.toFixed(1)}%`);
	lines.push('');
	lines.push('【ストキャスティクスRSI】');
	if (stochK != null && stochD != null) {
		lines.push(`  %K: ${Number(stochK).toFixed(1)}  %D: ${Number(stochD).toFixed(1)}`);
		const zone = stochZone(Number(stochK));
		lines.push(`  判定: ${zone ? stochZoneLabel(zone) : '—'}`);
		if (stochPrevK != null && stochPrevD != null) {
			const prevBelow = Number(stochPrevK) < Number(stochPrevD);
			const curAbove = Number(stochK) > Number(stochD);
			const prevAbove = Number(stochPrevK) > Number(stochPrevD);
			const curBelow = Number(stochK) < Number(stochD);
			if (prevBelow && curAbove) {
				lines.push('  クロス: %Kが%Dを上抜け（買いシグナル候補）');
			} else if (prevAbove && curBelow) {
				lines.push('  クロス: %Kが%Dを下抜け（売りシグナル候補）');
			} else {
				lines.push('  クロス: なし');
			}
		}
	} else {
		lines.push('  データ不足');
	}
	lines.push('');
	lines.push('【OBV (On-Balance Volume)】');
	if (obvVal != null) {
		lines.push(`  現在値: ${Number(obvVal).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${obvUnit}`.trim());
		if (obvSma20 != null)
			lines.push(
				`  SMA(20): ${Number(obvSma20).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${obvUnit}`.trim(),
			);
		if (obvTrend != null) {
			const obvTrendLabel =
				obvTrend === 'rising'
					? 'OBV > SMA → 出来高が上昇を支持'
					: obvTrend === 'falling'
						? 'OBV < SMA → 出来高が下落を支持'
						: 'OBV ≈ SMA → 出来高中立';
			lines.push(`  トレンド: ${obvTrendLabel}`);
		}
		if (obvPrev != null && prev != null && close != null) {
			const priceUp = Number(close) > Number(prev);
			const priceDn = Number(close) < Number(prev);
			const obvUp = Number(obvVal) > Number(obvPrev);
			const obvDn = Number(obvVal) < Number(obvPrev);
			if (priceUp && obvDn) {
				lines.push('  ダイバージェンス: ベアリッシュ（価格↑・OBV↓）→ 上昇の持続力に疑問');
			} else if (priceDn && obvUp) {
				lines.push('  ダイバージェンス: ブルリッシュ（価格↓・OBV↑）→ 反発の可能性');
			} else {
				lines.push('  ダイバージェンス: なし（価格とOBVが同方向）');
			}
		}
	} else {
		lines.push('  データ不足');
	}
	lines.push('');
	lines.push('【次に確認すべきこと】');
	lines.push('  ・より詳しく: analyze_bb_snapshot / analyze_ichimoku_snapshot / analyze_sma_snapshot');
	lines.push(`  ・転換サイン例: RSIの${RSI_MIDLINE}超え, MACDヒストグラムのプラ転, SMA25の明確な上抜け`);
	lines.push('');
	lines.push('詳細は structuredContent.data.indicators / chart を参照。');
	return lines.join('\n');
}

function calcDeltaPrev(close: number | null, prev: number | null): { amt: number; pct: number } | null {
	if (close == null || prev == null || !Number.isFinite(prev) || prev === 0) return null;
	const amt = Number(close) - Number(prev);
	const pct = (amt / Math.abs(Number(prev))) * 100;
	return { amt, pct };
}

function extractRecentRsi(rsiSeries: unknown[] | null, count: number): (number | null)[] {
	if (!Array.isArray(rsiSeries) || rsiSeries.length === 0) return [];
	return rsiSeries.slice(-count).map((v: unknown) => {
		const num = Number(v);
		return Number.isFinite(num) ? num : null;
	});
}

function detectDivergence(
	candles: Array<{ close?: number }>,
	histSeries: number[] | null,
	lookback: number,
): string | null {
	const N = Math.min(lookback, candles.length);
	if (N < 5) return null;
	const pxA = Number(candles.at(-N)?.close ?? NaN),
		pxB = Number(candles.at(-1)?.close ?? NaN);
	if (!Number.isFinite(pxA) || !Number.isFinite(pxB) || !histSeries || histSeries.length < N) return null;
	const hA = Number(histSeries.at(-N) ?? NaN),
		hB = Number(histSeries.at(-1) ?? NaN);
	if (!Number.isFinite(hA) || !Number.isFinite(hB)) return null;
	const pxSlopeUp = pxB > pxA,
		pxSlopeDn = pxB < pxA;
	const histSlopeUp = hB > hA,
		histSlopeDn = hB < hA;
	if (pxSlopeUp && histSlopeDn) return 'ベアリッシュ（価格↑・モメンタム↓）';
	if (pxSlopeDn && histSlopeUp) return 'ブルリッシュ（価格↓・モメンタム↑）';
	return 'なし';
}

function calcSmaArrangement(curNum: number, s25n: number, s75n: number, s200n: number): string {
	const pts: Array<{ label: string; v: number }> = [];
	if (Number.isFinite(curNum)) pts.push({ label: '価格', v: curNum });
	if (Number.isFinite(s25n)) pts.push({ label: 'SMA25', v: s25n });
	if (Number.isFinite(s75n)) pts.push({ label: 'SMA75', v: s75n });
	if (Number.isFinite(s200n)) pts.push({ label: 'SMA200', v: s200n });
	if (pts.length < 3) return 'n/a';
	pts.sort((a, b) => a.v - b.v);
	return pts.map((p) => p.label).join(' < ');
}

function calcBandWidthTrend(bbSeries: {
	upper: number[] | null;
	lower: number[] | null;
	middle: number[] | null;
}): string | null {
	try {
		if (!bbSeries.upper || !bbSeries.lower || !bbSeries.middle) return null;
		const L = Math.min(bbSeries.upper.length, bbSeries.lower.length, bbSeries.middle.length);
		if (L < 6) return null;
		const cur =
			((bbSeries.upper.at(-1) ?? 0) - (bbSeries.lower.at(-1) ?? 0)) / Math.max(EPSILON, bbSeries.middle.at(-1) ?? 0);
		const prev5 =
			((bbSeries.upper.at(-6) ?? 0) - (bbSeries.lower.at(-6) ?? 0)) / Math.max(EPSILON, bbSeries.middle.at(-6) ?? 0);
		if (!Number.isFinite(cur) || !Number.isFinite(prev5)) return null;
		return cur > prev5 ? '拡大中' : cur < prev5 ? '収縮中' : '不変';
	} catch {
		return null;
	}
}

function calcSigmaHistory(
	candles: Array<{ close?: number }>,
	bbSeries: { upper: number[] | null; middle: number[] | null },
): Array<{ off: number; z: number } | null> | null {
	try {
		if (!bbSeries.upper || !bbSeries.middle) return null;
		const L = Math.min(candles.length, bbSeries.upper.length, bbSeries.middle.length);
		if (L < 6) return null;
		const { upper, middle } = bbSeries;
		const idxs = [-6, -1];
		const vals = idxs.map((off) => {
			const c = Number(candles.at(off)?.close ?? NaN);
			const m = Number(middle.at(off) ?? NaN);
			const u = Number(upper.at(off) ?? NaN);
			if (![c, m, u].every(Number.isFinite)) return null;
			const z = Number(((2 * (c - m)) / Math.max(EPSILON, u - m)).toFixed(2));
			return { off, z };
		});
		return vals;
	} catch {
		return null;
	}
}

function calcChikouBull(candles: Array<{ close?: number }>, close: number | null): boolean | null {
	const CHIKOU_LOOKBACK = ICHIMOKU_SHIFT + 1;
	if (candles.length < CHIKOU_LOOKBACK || close == null) return null;
	const past = Number(candles.at(-CHIKOU_LOOKBACK)?.close ?? NaN);
	if (!Number.isFinite(past)) return null;
	return Number(close) > past;
}

function calcThreeSignals(
	cloudPos: string,
	tenkan: number | null,
	kijun: number | null,
	chikouBull: boolean | null,
): { judge: string; aboveCloud: boolean; convAboveBase: boolean | null; chikouAbove: boolean | null } {
	const aboveCloud = cloudPos === 'above_cloud';
	const convAboveBase = tenkan != null && kijun != null ? Number(tenkan) >= Number(kijun) : null;
	const chikouAbove = chikouBull;
	let judge: '三役好転' | '三役逆転' | '混在' = '混在';
	if (aboveCloud && convAboveBase === true && chikouAbove === true) judge = '三役好転';
	if (cloudPos === 'below_cloud' && convAboveBase === false && chikouAbove === false) judge = '三役逆転';
	return { judge, aboveCloud, convAboveBase, chikouAbove };
}

function calcCloudDistance(
	close: number | null,
	cloudTop: number | null,
	cloudBot: number | null,
	cloudPos: string,
): number | null {
	if (close == null || cloudTop == null || cloudBot == null) return null;
	if (cloudPos === 'below_cloud') {
		const need = cloudBot - Number(close);
		return need > 0 ? (need / Math.max(EPSILON, Number(close))) * 100 : 0;
	}
	if (cloudPos === 'above_cloud') {
		const need = Number(close) - cloudTop;
		return need > 0 ? (need / Math.max(EPSILON, Number(close))) * 100 : 0;
	}
	return 0;
}

function findSmaCross(s25: number[] | null, s75: number[] | null): string | null {
	if (!s25 || !s75) return null;
	const cross = lastCrossover(s25, s75);
	if (cross == null) return '直近クロス: なし';
	return `直近クロス: ${cross.type === 'golden' ? 'ゴールデン' : 'デッド'}（${cross.barsAgo}本前）`;
}

export const toolDef: ToolDefinition = {
	name: 'analyze_indicators',
	description:
		'[Technical Indicators / RSI / MACD / SMA] テクニカル指標の総合分析。最新値・トレンド判定・シグナルをテキストで返す。十分な limit を指定（例: 日足200本）。\n\n描画 → prepare_chart_data / render_chart_svg。バックテスト → run_backtest。',
	inputSchema: GetIndicatorsInputSchema,
	handler: async ({ pair, type, date, tz, limit }: z.infer<typeof GetIndicatorsInputSchema>) => {
		const res = await analyzeIndicators(pair, type, limit, date, tz);
		if (!res.ok) return res;
		const ind = (res?.data?.indicators ?? {}) as Record<string, number | null | undefined> & {
			OBV_trend?: string | null;
		};
		const candles = (Array.isArray(res?.data?.normalized) ? res.data.normalized : []) as Array<{
			close?: number;
			[k: string]: unknown;
		}>;
		const close = candles.at(-1)?.close ?? null;
		const prev = candles.at(-2)?.close ?? null;
		const effectiveTz = resolveTz(tz);
		const nowJst = toDisplayTime(undefined, effectiveTz) ?? nowIso();
		const latestTimestamp = Number((candles.at(-1) as { timestamp?: number } | undefined)?.timestamp);
		const anchoredTime = date && Number.isFinite(latestTimestamp) ? toDisplayTime(latestTimestamp, effectiveTz) : null;
		const timeContext = date ? `${anchoredTime ?? date} 時点（終端 date=${date} 指定）` : undefined;
		const deltaPrev = calcDeltaPrev(close, prev);
		const deltaLabel = prevBarChangeLabel(type);
		const rsi = ind.RSI_14 ?? null;
		const rsiSeries = Array.isArray(res?.data?.indicators?.RSI_14_series) ? res.data.indicators.RSI_14_series : null;
		const recentRsiRaw = extractRecentRsi(rsiSeries, 7);
		const recentRsiFormatted = recentRsiRaw.map((v) => (v == null ? 'n/a' : Number(v).toFixed(1)));
		const sma25 = ind.SMA_25 ?? null;
		const sma75 = ind.SMA_75 ?? null;
		const sma200 = ind.SMA_200 ?? null;
		const bbMid = ind.BB_middle ?? ind.BB2_middle ?? null;
		const bbUp = ind.BB_upper ?? ind.BB2_upper ?? null;
		const bbLo = ind.BB_lower ?? ind.BB2_lower ?? null;
		const sigmaZ =
			close != null && bbMid != null && bbUp != null && bbUp - bbMid !== 0
				? Number(((2 * (close - bbMid)) / (bbUp - bbMid)).toFixed(2))
				: null;
		const bandWidthPct =
			bbUp != null && bbLo != null && bbMid ? Number((((bbUp - bbLo) / bbMid) * 100).toFixed(2)) : null;
		const macdLine = ind.MACD_line ?? null;
		const macdSignal = ind.MACD_signal ?? null;
		const macdHist = ind.MACD_hist ?? null;
		// 今日の雲は ichi_series の末尾 26 本前を見る。ind.ICHIMOKU_spanA/B は 26 本後にプロットされる雲なので使えない。
		const ichiSeries = (
			ind as { ichi_series?: { tenkan?: number[]; kijun?: number[]; spanA?: number[]; spanB?: number[] } }
		).ichi_series;
		const { spanA, spanB } = currentCloudSpans(ichiSeries);
		const tenkan = ind.ICHIMOKU_conversion ?? null;
		const kijun = ind.ICHIMOKU_base ?? null;
		const cloudTop = spanA != null && spanB != null ? Math.max(spanA, spanB) : null;
		const cloudBot = spanA != null && spanB != null ? Math.min(spanA, spanB) : null;
		const cloudPos =
			close != null && cloudTop != null && cloudBot != null
				? close > cloudTop
					? 'above_cloud'
					: close < cloudBot
						? 'below_cloud'
						: 'in_cloud'
				: 'unknown';
		const trend = res?.data?.trend ?? 'unknown';
		// 本番の指標オブジェクトは flat 構造で series キーを持たないので、flat キーから series マップを組む。
		const macdSeries = (ind as { macd_series?: { line?: number[]; signal?: number[]; hist?: number[] } }).macd_series;
		const bb2Series = (ind as { bb2_series?: { upper?: number[]; middle?: number[]; lower?: number[] } }).bb2_series;
		const series: Record<string, number[] | null> = {
			SMA_25: (ind as { sma_25_series?: number[] }).sma_25_series ?? null,
			SMA_75: (ind as { sma_75_series?: number[] }).sma_75_series ?? null,
			SMA_200: (ind as { sma_200_series?: number[] }).sma_200_series ?? null,
			MACD_line: macdSeries?.line ?? null,
			MACD_signal: macdSeries?.signal ?? null,
			MACD_hist: macdSeries?.hist ?? null,
			BB_upper: bb2Series?.upper ?? null,
			BB_lower: bb2Series?.lower ?? null,
			BB_middle: bb2Series?.middle ?? null,
			ICHIMOKU_conversion: ichiSeries?.tenkan ?? null,
			ICHIMOKU_base: ichiSeries?.kijun ?? null,
		};
		const slopeOf = (seriesKey: string, n = 5): number | null => {
			const arr = Array.isArray(series[seriesKey]) ? series[seriesKey] : null;
			if (!arr || arr.length < 2) return null;
			const len = Math.min(n, arr.length);
			const a = Number(arr.at(-len) ?? NaN);
			const b = Number(arr.at(-1) ?? NaN);
			if (!Number.isFinite(a) || !Number.isFinite(b) || len <= 1) return null;
			return (b - a) / (len - 1);
		};
		const lastMacdCross = lastCrossover(series.MACD_line, series.MACD_signal);
		const divergence = detectDivergence(candles, series.MACD_hist, 14);
		const curNum = Number(close ?? NaN);
		const s25n = Number(sma25 ?? NaN),
			s75n = Number(sma75 ?? NaN),
			s200n = Number(sma200 ?? NaN);
		const arrangement = calcSmaArrangement(curNum, s25n, s75n, s200n);
		const s25Slope = slopeOf('SMA_25', 5),
			s75Slope = slopeOf('SMA_75', 5),
			s200Slope = slopeOf('SMA_200', 7);
		const bbSeries = {
			upper: series.BB_upper,
			lower: series.BB_lower,
			middle: series.BB_middle,
		};
		const bwTrend = calcBandWidthTrend(bbSeries);
		const sigmaHistory = calcSigmaHistory(candles, bbSeries);
		const cloudThickness = cloudTop != null && cloudBot != null ? cloudTop - cloudBot : null;
		const cloudThicknessPct =
			cloudThickness != null && close != null && Number.isFinite(close)
				? (cloudThickness / Math.max(EPSILON, Number(close))) * 100
				: null;
		const chikouBull = calcChikouBull(candles, close);
		const threeSignals = calcThreeSignals(cloudPos, tenkan, kijun, chikouBull);
		const toCloudDistance = calcCloudDistance(close, cloudTop, cloudBot, cloudPos);
		const crossInfo = findSmaCross(series.SMA_25, series.SMA_75);
		const stochK = ind.STOCH_RSI_K ?? null;
		const stochD = ind.STOCH_RSI_D ?? null;
		const stochPrevK = ind.STOCH_RSI_prevK ?? null;
		const stochPrevD = ind.STOCH_RSI_prevD ?? null;
		const obvVal = ind.OBV ?? null;
		const obvSma20 = ind.OBV_SMA20 ?? null;
		const obvTrend = ind.OBV_trend ?? null;
		const obvPrev = ind.OBV_prevObv ?? null;

		const body = buildIndicatorsText({
			pair,
			type,
			nowJst,
			timeContext,
			close,
			prev,
			deltaPrev,
			deltaLabel,
			trend,
			rsi,
			recentRsiFormatted,
			macdLine,
			macdSignal,
			macdHist,
			lastMacdCross,
			divergence,
			sma25,
			sma75,
			sma200,
			s25Slope,
			s75Slope,
			s200Slope,
			arrangement,
			crossInfo,
			bbMid,
			bbUp,
			bbLo,
			sigmaZ,
			bandWidthPct,
			bwTrend,
			sigmaHistory,
			tenkan,
			kijun,
			spanA,
			spanB,
			cloudTop,
			cloudBot,
			cloudPos,
			cloudThickness,
			cloudThicknessPct,
			chikouBull,
			threeSignals,
			toCloudDistance,
			ichimokuConvSlope: slopeOf('ICHIMOKU_conversion', 5),
			ichimokuBaseSlope: slopeOf('ICHIMOKU_base', 5),
			stochK,
			stochD,
			stochPrevK,
			stochPrevD,
			obvVal,
			obvSma20,
			obvTrend,
			obvPrev,
			obvUnit: (pair ?? '').split('_')[0]?.toUpperCase() ?? '',
		});
		// 順序は warning → 注記 → 本文（warning を最優先で見せる）。
		const withNote = prependProvisionalNote(body, (res.meta as { provisional?: boolean })?.provisional === true);
		const text = prependWarnings(withNote, res.meta as { warning?: string; warnings?: string[] });
		return { content: [{ type: 'text', text }], structuredContent: toStructured(res) };
	},
};
