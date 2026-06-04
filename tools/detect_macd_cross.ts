import { z } from 'zod';
import { calendarDateFromIso, dayjs } from '../lib/datetime.js';
import { formatSummary } from '../lib/formatter.js';
import { lastCrossover } from '../lib/indicators.js';
import { fail, failFromError, failFromValidation, ok, toStructured } from '../lib/result.js';
import { ALLOWED_PAIRS, ensurePair } from '../lib/validate.js';
import type { Pair } from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import analyzeIndicators from './analyze_indicators.js';

// ── テキスト組み立て: 純粋エクスポート関数 ──

/** 表示用暦日（JST）。既に YYYY-MM-DD の値はそのまま、ISO は calendarDateFromIso で変換。 */
function displayCalendarDate(isoOrDate: string | null | undefined, fallback: string): string {
	if (!isoOrDate) return fallback;
	const s = String(isoOrDate);
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
	return calendarDateFromIso(s) ?? fallback;
}

export interface MacdScreenCross {
	pair: string;
	type: 'golden' | 'dead';
	crossDate: string | null;
	barsAgo: number;
	macdAtCross: number | null;
	signalAtCross: number | null;
	histogramDelta: number | null;
	returnSinceCrossPct: number | null;
	prevCross: { type: 'golden' | 'dead'; barsAgo: number } | null;
}

export interface BuildMacdScreenTextInput {
	baseSummary: string;
	crosses: MacdScreenCross[];
	includeForming: boolean;
	includeStats: boolean;
}

export function buildMacdScreenText(input: BuildMacdScreenTextInput): string {
	const { baseSummary, crosses } = input;
	const crossLines = crosses.map((r, i) => {
		const date = displayCalendarDate(r.crossDate, '?');
		const ret =
			r.returnSinceCrossPct != null ? ` ret:${r.returnSinceCrossPct >= 0 ? '+' : ''}${r.returnSinceCrossPct}%` : '';
		const hd = r.histogramDelta != null ? ` histDelta:${r.histogramDelta}` : '';
		const prev = r.prevCross ? ` prev:${r.prevCross.type}(${r.prevCross.barsAgo}bars)` : '';
		return `[${i}] ${r.pair} ${r.type} @${date} barsAgo:${r.barsAgo} macd:${r.macdAtCross} sig:${r.signalAtCross}${hd}${ret}${prev}`;
	});
	return (
		baseSummary +
		`\n\n📋 全${crosses.length}件のクロス詳細:\n` +
		crossLines.join('\n') +
		`\n\n---\n📌 含まれるもの: MACDクロス検出（種類・日付・ヒストグラム差分・リターン率・前回クロス）` +
		`\n📌 含まれないもの: 他のテクニカル指標（RSI・BB等）、出来高分析、板情報` +
		`\n📌 補完ツール: analyze_indicators（全指標詳細）, analyze_market_signal（総合シグナル）, get_flow_metrics（出来高）`
	);
}

interface FormingStatus {
	status: string;
	estimatedCrossDays?: number | null;
	completion?: number | null;
	currentHistogram?: number | null;
	histogramTrend?: unknown[];
	currentMACD?: number | null;
	currentSignal?: number | null;
	lastCrossDate?: string | null;
	lastCrossBarsAgo?: number | null;
	lastCrossType?: string | null;
}

interface CrossStats {
	totalSamples: number;
	avgDay5Return?: number | null;
	worstCase?: number | null;
	bestCase?: number | null;
}

interface CrossHistory {
	goldenCrosses: CrossPerf[];
	deadCrosses: CrossPerf[];
}

export interface BuildMacdSingleTextInput {
	pair: string;
	lastClose: number | null;
	forming: FormingStatus | null;
	statistics: { golden: CrossStats; dead: CrossStats } | null;
	history: CrossHistory | null;
	historyDays: number;
	includeForming: boolean;
	includeStats: boolean;
}

export function buildMacdSingleText(input: BuildMacdSingleTextInput): string {
	const { pair, lastClose, forming, statistics, history, historyDays, includeForming, includeStats } = input;
	const lines: string[] = [];
	const pairStr = String(pair).toUpperCase();
	lines.push(lastClose != null ? `${pairStr} close=${Number(lastClose).toLocaleString('ja-JP')}円` : pairStr);

	if (forming) {
		const f = forming;
		if (f.status === 'forming_golden' || f.status === 'forming_dead') {
			const days =
				f.estimatedCrossDays != null
					? f.estimatedCrossDays <= 1.5
						? '1-2日以内'
						: `${Math.round(f.estimatedCrossDays)}日程度`
					: '不明';
			const compStr = f.completion != null ? `${Math.round((f.completion || 0) * 100)}%` : 'n/a';
			const crossType = f.status === 'forming_golden' ? 'ゴールデン' : 'デッド';
			const fmt = (v: unknown, d = 2) => (v == null ? 'n/a' : Number(v).toFixed(d));
			const estDate = (() => {
				if (f.estimatedCrossDays == null) return '不明';
				try {
					return dayjs()
						.add(Math.max(0, Math.round(f.estimatedCrossDays)), 'day')
						.format('YYYY-MM-DD');
				} catch {
					return '不明';
				}
			})();
			lines.push(`${crossType}クロス形成中: 完成度${compStr}、推定クロス日 ${estDate}（あと${days}）`);
			lines.push(
				`- ヒストグラム: ${fmt(f.currentHistogram, 2)} (直近5本: [${(Array.isArray(f.histogramTrend) ? f.histogramTrend : []).map((v: unknown) => (v == null ? 'n/a' : String(v))).join(', ')}])`,
			);
			lines.push(`- MACD: ${fmt(f.currentMACD, 2)} / Signal: ${fmt(f.currentSignal, 2)}`);
		} else if (f.status === 'crossed_recently') {
			const dateStr = displayCalendarDate(f.lastCrossDate, '不明');
			const agoStr = f.lastCrossBarsAgo != null ? `${f.lastCrossBarsAgo}日前` : '直近';
			const typ = f.lastCrossType === 'dead' ? 'デッド' : 'ゴールデン';
			lines.push(`${typ}クロス発生: ${dateStr}（${agoStr}）`);
		} else {
			lines.push('現在クロス形成の兆候なし');
		}
	}

	if (statistics && history) {
		const gStats = statistics.golden;
		const dStats = statistics.dead;
		const goldenCrosses = history.goldenCrosses;
		const deadCrosses = history.deadCrosses;
		if (gStats.totalSamples > 0) {
			const avgStr =
				gStats.avgDay5Return != null ? `${gStats.avgDay5Return >= 0 ? '+' : ''}${gStats.avgDay5Return}%` : 'n/a';
			const upCount = goldenCrosses.filter((c) => (c.performance.day5 ?? -Infinity) > 0).length;
			const rangeStr =
				gStats.worstCase != null && gStats.bestCase != null
					? `${gStats.worstCase >= 0 ? '+' : ''}${gStats.worstCase}% 〜 ${gStats.bestCase >= 0 ? '+' : ''}${gStats.bestCase}%`
					: 'n/a';
			lines.push(`過去${historyDays}日: ゴールデンクロス${goldenCrosses.length}回`);
			const upPct = goldenCrosses.length ? Math.round((upCount / goldenCrosses.length) * 100) : 0;
			lines.push(`- クロス後5日間: 平均${avgStr}、上昇した割合 ${upCount}/${goldenCrosses.length}回（${upPct}%）`);
			lines.push(`- 範囲: ${rangeStr}`);
		}
		if (dStats.totalSamples > 0) {
			const avgStr =
				dStats.avgDay5Return != null ? `${dStats.avgDay5Return >= 0 ? '+' : ''}${dStats.avgDay5Return}%` : 'n/a';
			const downCount = deadCrosses.filter((c) => (c.performance.day5 ?? Infinity) < 0).length;
			const rangeStr =
				dStats.worstCase != null && dStats.bestCase != null
					? `${dStats.worstCase >= 0 ? '+' : ''}${dStats.worstCase}% 〜 ${dStats.bestCase >= 0 ? '+' : ''}${dStats.bestCase}%`
					: 'n/a';
			lines.push(`デッドクロス${deadCrosses.length}回`);
			const downPct = deadCrosses.length ? Math.round((downCount / deadCrosses.length) * 100) : 0;
			lines.push(`- クロス後5日間: 平均${avgStr}、下落した割合 ${downCount}/${deadCrosses.length}回（${downPct}%）`);
			lines.push(`- 範囲: ${rangeStr}`);
		}
	}

	return (
		lines.join('\n') +
		`\n\n---\n📌 含まれるもの: MACD分析（${includeForming ? 'forming検出' : ''}${includeForming && includeStats ? '・' : ''}${includeStats ? '過去統計' : ''}）` +
		`\n📌 含まれないもの: 他のテクニカル指標（RSI・BB等）、出来高分析、板情報` +
		`\n📌 補完ツール: analyze_indicators（全指標詳細）, analyze_market_signal（総合シグナル）, get_flow_metrics（出来高）`
	);
}

// ── 共通: クロス検出ヘルパー ──

type CrossDetailed = {
	pair: string;
	type: 'golden' | 'dead';
	crossIndex: number;
	crossDate: string | null;
	barsAgo: number;
	macdAtCross: number | null;
	signalAtCross: number | null;
	histogramPrev: number | null;
	histogramCurr: number | null;
	histogramDelta: number | null;
	prevCross: { type: 'golden' | 'dead'; barsAgo: number; date: string | null } | null;
	priceAtCross: number | null;
	currentPrice: number | null;
	returnSinceCrossPct: number | null;
};

function diffAt(line: (number | null)[], signal: (number | null)[], i: number): number | null {
	return (line[i] ?? null) != null && (signal[i] ?? null) != null ? (line[i] as number) - (signal[i] as number) : null;
}

function findPrevCross(
	line: number[],
	signal: number[],
	before: number,
): { idx: number; type: 'golden' | 'dead' } | null {
	// index < before の範囲で直近クロスを探す（lastCrossover に委譲）。
	const cross = lastCrossover(line.slice(0, before), signal.slice(0, before));
	if (cross == null) return null;
	return { idx: before - 1 - cross.barsAgo, type: cross.type };
}

function detectCrossInRange(
	line: number[],
	signal: number[],
	candles: Array<{ isoTime?: string | null; close?: number | null }>,
	start: number,
	end: number,
	n: number,
	pairName: string,
): CrossDetailed | null {
	// [start, end] の curr index 範囲で直近クロスを探す。
	// lastCrossover は curr index <= end の最新クロスを返すので、end までで切って評価し、
	// 見つかった index が start 未満なら（= 範囲内にクロスなし）null を返す。
	const recent = lastCrossover(line.slice(0, end + 1), signal.slice(0, end + 1));
	if (recent == null) return null;
	const i = end - recent.barsAgo;
	if (i < start) return null;

	const prevDiff = diffAt(line, signal, i - 1);
	const currDiff = diffAt(line, signal, i);
	if (prevDiff == null || currDiff == null) return null;

	const currentPrice = (candles.at(-1)?.close ?? null) as number | null;
	const priceAtCross = (candles[i]?.close ?? null) as number | null;
	const retPct =
		priceAtCross && currentPrice != null
			? Number((((currentPrice - priceAtCross) / priceAtCross) * 100).toFixed(2))
			: null;
	const prev = findPrevCross(line, signal, i);

	return {
		pair: pairName,
		type: recent.type,
		crossIndex: i,
		crossDate: candles[i]?.isoTime ?? null,
		barsAgo: n - 1 - i,
		macdAtCross: (line[i] ?? null) as number | null,
		signalAtCross: (signal[i] ?? null) as number | null,
		histogramPrev: prevDiff,
		histogramCurr: currDiff,
		histogramDelta: Number((currDiff - prevDiff).toFixed(4)),
		prevCross: prev ? { type: prev.type, barsAgo: i - prev.idx, date: candles[prev.idx]?.isoTime ?? null } : null,
		priceAtCross,
		currentPrice,
		returnSinceCrossPct: retPct,
	};
}

// ── モード A: 複数ペアスクリーニング ──

type ScreenOpts = {
	minHistogramDelta?: number;
	maxBarsAgo?: number;
	minReturnPct?: number;
	maxReturnPct?: number;
	crossType?: 'golden' | 'dead' | 'both';
	sortBy?: 'date' | 'histogram' | 'return' | 'barsAgo';
	sortOrder?: 'asc' | 'desc';
	limit?: number;
	withPrice?: boolean;
};

async function screenMode(
	market: 'all' | 'jpy',
	lookback: number,
	pairs: string[] | undefined,
	view: 'summary' | 'detailed',
	screen: ScreenOpts | undefined,
) {
	const universe = pairs?.length
		? pairs.filter((p) => ALLOWED_PAIRS.has(p as Pair))
		: Array.from(ALLOWED_PAIRS.values()).filter((p) => (market === 'jpy' ? p.endsWith('_jpy') : true));

	const allDetailed: CrossDetailed[] = [];
	const failedPairs: string[] = [];
	await Promise.all(
		universe.map(async (pair) => {
			try {
				const ind = await analyzeIndicators(pair, '1day', 120);
				if (!ind?.ok) {
					failedPairs.push(pair);
					return;
				}
				const macdSeries = (ind.data?.indicators as { macd_series?: { line: number[]; signal: number[] } })
					?.macd_series;
				const line = macdSeries?.line || [];
				const signal = macdSeries?.signal || [];
				const candles = (ind.data?.normalized || []) as Array<{ isoTime?: string | null; close?: number | null }>;
				const n = line.length;
				if (n < 2) return;
				const start = Math.max(1, n - lookback);
				const cross = detectCrossInRange(line, signal, candles, start, n - 1, n, pair as string);
				if (cross) allDetailed.push(cross);
			} catch {
				failedPairs.push(pair);
			}
		}),
	);

	const opts = screen || {};
	const crossType = opts.crossType || 'both';
	const totalFound = allDetailed.length;
	let filtered = allDetailed.filter((r) => {
		if (crossType !== 'both' && r.type !== crossType) return false;
		if (
			opts.minHistogramDelta != null &&
			r.histogramDelta != null &&
			Math.abs(r.histogramDelta) < opts.minHistogramDelta
		)
			return false;
		if (opts.maxBarsAgo != null && r.barsAgo > opts.maxBarsAgo) return false;
		if (opts.minReturnPct != null && !(r.returnSinceCrossPct != null && r.returnSinceCrossPct >= opts.minReturnPct))
			return false;
		if (opts.maxReturnPct != null && !(r.returnSinceCrossPct != null && r.returnSinceCrossPct <= opts.maxReturnPct))
			return false;
		return true;
	});

	const sortBy = opts.sortBy || 'date';
	const order = (opts.sortOrder || 'desc') === 'desc' ? -1 : 1;
	const safeNum = (v: unknown, def = 0) => (v == null || Number.isNaN(Number(v)) ? def : Number(v));
	const projReturn = (v: unknown) => (v == null ? Number.NEGATIVE_INFINITY : Number(v));
	filtered.sort((a, b) => {
		if (sortBy === 'histogram')
			return (Math.abs(safeNum(b.histogramDelta)) - Math.abs(safeNum(a.histogramDelta))) * (order === -1 ? 1 : -1);
		if (sortBy === 'return')
			return (projReturn(b.returnSinceCrossPct) - projReturn(a.returnSinceCrossPct)) * (order === -1 ? 1 : -1);
		if (sortBy === 'barsAgo') return (safeNum(a.barsAgo) - safeNum(b.barsAgo)) * (order === -1 ? 1 : -1);
		// sortBy === 'date': compare crossDate strings directly
		const dateA = a.crossDate || '';
		const dateB = b.crossDate || '';
		return dateA < dateB ? -1 * order : dateA > dateB ? 1 * order : 0;
	});
	if (opts.limit != null && opts.limit > 0) filtered = filtered.slice(0, opts.limit);

	const resultsScreened = filtered.map((r) => ({
		pair: r.pair,
		type: r.type,
		macd: r.macdAtCross as number,
		signal: r.signalAtCross as number,
		isoTime: r.crossDate,
	}));
	const brief = resultsScreened
		.slice(0, 6)
		.map((r) => `${r.pair}:${r.type}${r.isoTime ? `@${displayCalendarDate(r.isoTime, '?')}` : ''}`)
		.join(', ');
	const conds: string[] = [];
	if (crossType !== 'both') conds.push(crossType);
	if (opts.minHistogramDelta != null) conds.push(`ヒストグラム≥${opts.minHistogramDelta}`);
	if (opts.maxBarsAgo != null) conds.push(`bars≤${opts.maxBarsAgo}`);
	if (opts.minReturnPct != null) conds.push(`return≥${opts.minReturnPct}%`);
	if (opts.maxReturnPct != null) conds.push(`return≤${opts.maxReturnPct}%`);
	if (opts.limit != null) conds.push(`top${opts.limit}`);
	const failedInfo = failedPairs.length > 0 ? ` | ⚠️${failedPairs.length}/${universe.length}ペア取得失敗` : '';
	const condStr = conds.length ? ` (全${totalFound}件中, 条件: ${conds.join(', ')})` : '';
	const baseSummary = formatSummary({
		pair: 'multi',
		latest: undefined,
		extra: `crosses=${resultsScreened.length}${condStr}${failedInfo}${brief ? ` [${brief}]` : ''}`,
	});
	const screenCrosses: MacdScreenCross[] = filtered.map((r) => ({
		pair: r.pair,
		type: r.type,
		crossDate: r.crossDate,
		barsAgo: r.barsAgo,
		macdAtCross: r.macdAtCross,
		signalAtCross: r.signalAtCross,
		histogramDelta: r.histogramDelta,
		returnSinceCrossPct: r.returnSinceCrossPct,
		prevCross: r.prevCross ? { type: r.prevCross.type, barsAgo: r.prevCross.barsAgo } : null,
	}));
	const summary = buildMacdScreenText({
		baseSummary,
		crosses: screenCrosses,
		includeForming: false,
		includeStats: false,
	});
	const data: Record<string, unknown> = { results: resultsScreened };
	if (view === 'detailed') {
		data.resultsDetailed = allDetailed;
		data.screenedDetailed = filtered;
	}
	const meta: Record<string, unknown> = {
		market,
		lookback,
		pairs: universe,
		view,
		screen: { ...opts, crossType, sortBy, sortOrder: opts.sortOrder || 'desc' },
	};
	if (failedPairs.length > 0) {
		meta.warning = `⚠️ ${universe.length}ペア中${failedPairs.length}ペアの指標取得に失敗しました: ${failedPairs.join(', ')}`;
		meta.failedPairs = failedPairs;
	}
	return ok(summary, data, meta);
}

// ── モード B: 単一ペア深掘り（forming + 過去統計） ──

type CrossPerf = { date: string | null; histogram: number | null; performance: Record<string, number | null> };

async function singlePairMode(
	pair: string,
	includeForming: boolean,
	includeStats: boolean,
	historyDays: number,
	performanceWindows: number[],
	minHistogramForForming: number,
) {
	const limit = Math.max(120, historyDays + 40);
	const ind = await analyzeIndicators(pair, '1day', limit);
	if (!ind?.ok) return fail(ind?.summary || 'indicators failed', ind?.meta?.errorType || 'internal');

	const macd = ind?.data?.indicators?.macd_series?.line || [];
	const signal = ind?.data?.indicators?.macd_series?.signal || [];
	const hist = ind?.data?.indicators?.macd_series?.hist || [];
	const candles: Array<{ isoTime?: string | null; close?: number }> = Array.isArray(ind?.data?.normalized)
		? ind.data.normalized
		: [];
	const n = Math.min(macd.length, signal.length, hist.length, candles.length);
	if (n < 20) return fail('insufficient data', 'user');

	const nowIdx = n - 1;
	const lastClose = candles[nowIdx]?.close ?? null;

	// forming detection
	let forming: FormingStatus | null = null;
	if (includeForming) {
		const win = Math.min(5, n - 1);
		const hNow = hist[nowIdx] as number | null;
		const hPrev = hist[nowIdx - win] as number | null;
		let completion: number | null = null;
		let estimatedCrossDays: number | null = null;
		let status: 'forming_golden' | 'forming_dead' | 'neutral' | 'crossed_recently' = 'neutral';
		const histogramTrend: Array<number | null> = [];
		for (let i = nowIdx - win + 1; i <= nowIdx; i++)
			histogramTrend.push(hist[i] == null ? null : Number((hist[i] as number).toFixed(4)));

		if (hNow != null && hPrev != null && Math.abs(hPrev) > 0) {
			const slopePerBar = (hNow - hPrev) / win;
			const movingTowardZero = (hPrev > 0 && slopePerBar < 0) || (hPrev < 0 && slopePerBar > 0);
			const notCrossedYet = (hPrev < 0 && hNow < 0) || (hPrev > 0 && hNow > 0);
			if (movingTowardZero && notCrossedYet && Math.abs(hNow) <= minHistogramForForming * 5) {
				completion = Number((1 - Math.min(1, Math.abs(hNow) / Math.abs(hPrev))).toFixed(2));
				const speed = Math.abs(slopePerBar);
				estimatedCrossDays = speed > 0 ? Number((Math.abs(hNow) / speed).toFixed(1)) : null;
				status = hPrev < 0 ? 'forming_golden' : 'forming_dead';
			}
		}

		let lastCrossIdx: number | null = null;
		let lastCrossType: 'golden' | 'dead' | null = null;
		for (let i = nowIdx; i >= Math.max(1, nowIdx - 3); i--) {
			const hp = hist[i - 1];
			const hc = hist[i];
			if (hp != null && hc != null) {
				if (hp <= 0 && hc > 0) {
					lastCrossIdx = i;
					lastCrossType = 'golden';
					break;
				}
				if (hp >= 0 && hc < 0) {
					lastCrossIdx = i;
					lastCrossType = 'dead';
					break;
				}
			}
		}
		if (status !== 'forming_golden' && status !== 'forming_dead' && lastCrossIdx != null) status = 'crossed_recently';

		forming = {
			status,
			completion,
			estimatedCrossDays,
			currentMACD: macd[nowIdx] ?? null,
			currentSignal: signal[nowIdx] ?? null,
			currentHistogram: hNow ?? null,
			histogramTrend,
			...(status === 'crossed_recently' && lastCrossIdx != null
				? {
						lastCrossType,
						lastCrossDate: candles[lastCrossIdx]?.isoTime ?? null,
						lastCrossBarsAgo: nowIdx - lastCrossIdx,
					}
				: {}),
		};
	}

	// history + statistics
	let history: CrossHistory | null = null;
	let statistics: { golden: CrossStats; dead: CrossStats } | null = null;
	if (includeStats) {
		const msCut = dayjs().subtract(historyDays, 'day').valueOf();
		const crosses: Array<{
			idx: number;
			type: 'golden' | 'dead';
			date: string | null;
			histogram: number | null;
			price: number | null;
		}> = [];
		for (let i = 1; i < n; i++) {
			const prevDiff = diffAt(macd, signal, i - 1);
			const currDiff = diffAt(macd, signal, i);
			if (prevDiff == null || currDiff == null) continue;
			const isGolden = prevDiff <= 0 && currDiff > 0;
			const isDead = prevDiff >= 0 && currDiff < 0;
			if (!isGolden && !isDead) continue;
			const dateStr = candles[i]?.isoTime || null;
			const ts = dateStr ? dayjs(dateStr).valueOf() : NaN;
			if (!Number.isFinite(ts) || ts < msCut) continue;
			crosses.push({
				idx: i,
				type: isGolden ? 'golden' : 'dead',
				date: dateStr,
				histogram: hist[i] ?? null,
				price: candles[i]?.close ?? null,
			});
		}

		const performanceFor = (idx: number, basePrice: number | null): Record<string, number | null> => {
			const perf: Record<string, number | null> = {};
			for (const w of performanceWindows) {
				const j = Math.min(n - 1, idx + w);
				const priceW = candles[j]?.close ?? null;
				perf[`day${String(w)}`] =
					basePrice != null && priceW != null ? Number((((priceW - basePrice) / basePrice) * 100).toFixed(2)) : null;
			}
			return perf;
		};

		const goldenCrosses: CrossPerf[] = [];
		const deadCrosses: CrossPerf[] = [];
		for (const c of crosses) {
			const perf = performanceFor(c.idx, c.price ?? null);
			const item: CrossPerf = {
				date: c.date,
				histogram: c.histogram == null ? null : Number((c.histogram as number).toFixed(4)),
				performance: perf,
			};
			if (c.type === 'golden') goldenCrosses.push(item);
			else deadCrosses.push(item);
		}

		const statsOf = (list: CrossPerf[]) => {
			const w = performanceWindows.includes(5) ? 5 : performanceWindows[performanceWindows.length - 1];
			const pick = (it: CrossPerf) => it.performance[`day${String(w)}`];
			const vals = list.map(pick).filter((v): v is number => v != null);
			const avg = vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : null;
			const successRate = list.length
				? Number(((list.filter((p) => (pick(p) ?? -Infinity) > 0).length / list.length) * 100).toFixed(0))
				: 0;
			const bestCase = vals.length ? Math.max(...vals) : null;
			const worstCase = vals.length ? Math.min(...vals) : null;
			return { avgDay5Return: avg, successRate, totalSamples: list.length, bestCase, worstCase };
		};

		history = { goldenCrosses, deadCrosses };
		statistics = { golden: statsOf(goldenCrosses), dead: statsOf(deadCrosses) };
	}

	// Build summary text
	const summaryText = buildMacdSingleText({
		pair,
		lastClose,
		forming,
		statistics,
		history,
		historyDays,
		includeForming,
		includeStats,
	});

	return ok(
		summaryText,
		{ forming, history, statistics },
		{ pair, historyDays, performanceWindows, minHistogramForForming, includeForming, includeStats },
	);
}

// ── MCP ツール定義（tool-registry から自動収集） ──

export const toolDef: ToolDefinition = {
	name: 'detect_macd_cross',
	description: `[MACD Cross / Crossover / Screening] MACDクロス検出（MACD cross / crossover / golden cross / dead cross / screening）。

pair省略: 複数銘柄スクリーニング / pair指定: 単一ペア深掘り分析（forming検出・過去統計）。

screen（スクリーニング用）:
- crossType: golden|dead|both
- minHistogramDelta / maxBarsAgo / minReturnPct / maxReturnPct
- sortBy: date|histogram|return|barsAgo
- limit: 上位N件`,
	inputSchema: z.object({
		pair: z.string().optional().describe('指定時は単一ペア深掘りモード'),
		market: z.enum(['all', 'jpy']).default('all').describe('スクリーニング時の対象市場'),
		pairs: z.array(z.string()).optional().describe('スクリーニング時の対象ペア限定'),
		lookback: z.number().int().min(1).max(10).default(3),
		view: z.enum(['summary', 'detailed']).optional().default('summary'),
		includeForming: z.boolean().optional().default(true).describe('単一ペア: forming検出'),
		includeStats: z.boolean().optional().default(true).describe('単一ペア: 過去統計'),
		historyDays: z.number().int().min(10).max(365).optional().default(90).describe('単一ペア: 統計対象期間'),
		performanceWindows: z.array(z.number().int().min(1).max(30)).optional().default([1, 3, 5, 10]),
		minHistogramForForming: z.number().min(0).optional().default(0.3),
		screen: z
			.object({
				minHistogramDelta: z.number().optional(),
				maxBarsAgo: z.number().int().min(0).optional(),
				minReturnPct: z.number().optional(),
				maxReturnPct: z.number().optional(),
				crossType: z.enum(['golden', 'dead', 'both']).optional().default('both'),
				sortBy: z.enum(['date', 'histogram', 'return', 'barsAgo']).optional().default('date'),
				sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
				limit: z.number().int().min(1).max(100).optional(),
				withPrice: z.boolean().optional(),
			})
			.optional(),
	}),
	handler: async (args: {
		pair?: string;
		market?: 'all' | 'jpy';
		pairs?: string[];
		lookback?: number;
		view?: 'summary' | 'detailed';
		includeForming?: boolean;
		includeStats?: boolean;
		historyDays?: number;
		performanceWindows?: number[];
		minHistogramForForming?: number;
		screen?: {
			minHistogramDelta?: number;
			maxBarsAgo?: number;
			minReturnPct?: number;
			maxReturnPct?: number;
			crossType?: 'golden' | 'dead' | 'both';
			sortBy?: 'date' | 'histogram' | 'return' | 'barsAgo';
			sortOrder?: 'asc' | 'desc';
			limit?: number;
			withPrice?: boolean;
		};
	}) => {
		try {
			if (args.pair) {
				const chk = ensurePair(args.pair);
				if (!chk.ok) return failFromValidation(chk);
				return singlePairMode(
					chk.pair,
					args.includeForming ?? true,
					args.includeStats ?? true,
					args.historyDays ?? 90,
					args.performanceWindows ?? [1, 3, 5, 10],
					args.minHistogramForForming ?? 0.3,
				);
			}
			const res: Awaited<ReturnType<typeof screenMode>> = await screenMode(
				args.market ?? 'all',
				args.lookback ?? 3,
				args.pairs,
				args.view ?? 'summary',
				args.screen,
			);
			if (!res?.ok || args.view !== 'detailed') return res;
			try {
				const detRaw: CrossDetailed[] = Array.isArray(res?.data?.screenedDetailed)
					? (res.data.screenedDetailed as CrossDetailed[])
					: Array.isArray(res?.data?.resultsDetailed)
						? (res.data.resultsDetailed as CrossDetailed[])
						: [];
				if (!detRaw.length) return res;
				const fmtDelta = (v: number | null | undefined) =>
					v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}`;
				const fmtRet = (v: number | null | undefined) =>
					v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
				const lines = detRaw.map((r) => {
					const date = displayCalendarDate(r?.crossDate, '');
					const prevDays = r?.prevCross?.barsAgo != null ? `${r.prevCross.barsAgo}日` : 'n/a';
					return `${String(r.pair)}: ${String(r.type)}@${date} (ヒストグラム${fmtDelta(r?.histogramDelta)}, 前回クロスから${prevDays}${r?.returnSinceCrossPct != null ? `, ${fmtRet(r.returnSinceCrossPct)}` : ''})`;
				});
				const text = `${String(res?.summary || '')}\n${lines.join('\n')}`.trim();
				return { content: [{ type: 'text', text }], structuredContent: toStructured(res) };
			} catch {
				return res;
			}
		} catch (e: unknown) {
			return failFromError(e);
		}
	},
};
