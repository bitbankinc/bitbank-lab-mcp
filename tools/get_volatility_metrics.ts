import type { z } from 'zod';
import { toNum } from '../lib/conversions.js';
import { nowIso } from '../lib/datetime.js';
import { formatSummary } from '../lib/formatter.js';
import { wilderAtr } from '../lib/indicators.js';
import { slidingMean, slidingStddev, stddev } from '../lib/math.js';
import { isLatestBarProvisional, prependProvisionalNote } from '../lib/provisional-bar.js';
import { fail, failFromError, failFromValidation, ok } from '../lib/result.js';
import { createMeta, ensurePair, validateLimit } from '../lib/validate.js';
import {
	componentMeanToVol,
	garmanKlassComponents,
	logReturns,
	parkinsonComponents,
	rogersSatchellComponents,
} from '../lib/volatility.js';
import {
	type GetVolMetricsDataSchemaOut,
	type GetVolMetricsMetaSchemaOut,
	GetVolMetricsOutputSchema,
} from '../src/schemas.js';
import getCandles from './get_candles.js';

type Candle = { open: number; high: number; low: number; close: number; isoTime?: string | null };

/**
 * aggregates.atr に使う Wilder ATR の期間（TradingView・MT4 デフォルト）。
 * ドキュメント文字列・実装の両方を 1 箇所に固定するための定数。
 */
export const WILDER_ATR_PERIOD = 14;

export interface RollingEntry {
	window: number;
	rv_std: number;
	rv_std_ann?: number;
	parkinson?: number;
	garmanKlass?: number;
	rogersSatchell?: number;
}

export interface BuildVolatilityMetricsTextInput {
	baseSummary: string;
	aggregates: {
		rv_std: number;
		rv_std_ann?: number;
		parkinson: number;
		garmanKlass: number;
		rogersSatchell: number;
		atr: number;
	};
	rolling: RollingEntry[];
}

/** テキスト組み立て（ボラティリティ詳細）— テスト可能な純粋関数 */
export function buildVolatilityMetricsText(input: BuildVolatilityMetricsTextInput): string {
	const { baseSummary, aggregates: a, rolling } = input;
	const aggLines = [
		`rv_std:${a.rv_std}`,
		a.rv_std_ann != null ? `rv_std_ann:${a.rv_std_ann}` : '',
		`parkinson:${a.parkinson}`,
		`garmanKlass:${a.garmanKlass}`,
		`rogersSatchell:${a.rogersSatchell}`,
		`atr:${a.atr}`,
	]
		.filter(Boolean)
		.join(' ');
	const rollLines = rolling.map((r) => {
		const parts = [`w=${r.window} rv:${r.rv_std.toFixed(6)}`];
		if (r.rv_std_ann != null) parts.push(`ann:${r.rv_std_ann.toFixed(6)}`);
		if (r.parkinson != null) parts.push(`pk:${r.parkinson.toFixed(6)}`);
		return parts.join(' ');
	});
	return (
		baseSummary +
		`\n\naggregates: ${aggLines}` +
		`\n\n📊 ローリング分析:\n` +
		rollLines.join('\n') +
		`\n\n---\n📌 含まれるもの: ボラティリティ指標（RV・Parkinson・GK・RS・ATR）、ローリング分析` +
		`\n📌 含まれないもの: 価格の方向性・トレンド、出来高フロー、板情報、テクニカル指標` +
		`\n📌 ATR の定義: aggregates.atr は Wilder ATR（RMA ベース、period=${WILDER_ATR_PERIOD}、TradingView・MT4 標準と一致）。ローリングではボラ変化を RV / Parkinson で追跡してください。` +
		`\n📌 補完ツール: get_candles（価格OHLCV）, analyze_indicators（方向性指標）, get_flow_metrics（出来高フロー）`
	);
}

function baseIntervalMsOf(type: string): number {
	switch (type) {
		case '1min':
			return 60_000;
		case '5min':
			return 5 * 60_000;
		case '15min':
			return 15 * 60_000;
		case '30min':
			return 30 * 60_000;
		case '1hour':
			return 60 * 60_000;
		case '4hour':
			return 4 * 60 * 60_000;
		case '8hour':
			return 8 * 60 * 60_000;
		case '12hour':
			return 12 * 60 * 60_000;
		case '1day':
			return 24 * 60 * 60_000;
		case '1week':
			return 7 * 24 * 60 * 60_000;
		case '1month':
			return 30 * 24 * 60 * 60_000; // approx
		default:
			return 24 * 60 * 60_000;
	}
}

function periodsPerYear(type: string): number {
	const secondsPerYear = 365 * 24 * 60 * 60;
	const intervalSec = baseIntervalMsOf(type) / 1000;
	return Math.max(1, Math.floor(secondsPerYear / intervalSec));
}

function toMs(iso: string | null | undefined): number | null {
	if (!iso) return null;
	return toNum(Date.parse(iso));
}

export default async function getVolatilityMetrics(
	pair: string,
	type: string = '1day',
	limit: number = 200,
	windows: number[] = [14, 20, 30],
	opts?: { useLogReturns?: boolean; annualize?: boolean; tz?: string; cacheTtlMs?: number },
) {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk, GetVolMetricsOutputSchema);
	const lim = validateLimit(limit, 20, 500);
	if (!lim.ok) return failFromValidation(lim, GetVolMetricsOutputSchema);

	try {
		const cRes = await getCandles(chk.pair, type, undefined, lim.value);
		if (!cRes.ok)
			return GetVolMetricsOutputSchema.parse(fail(cRes.summary || 'failed', cRes.meta.errorType || 'internal'));
		const candles: Candle[] = cRes.data.normalized;
		if (!Array.isArray(candles) || candles.length < 20) {
			return GetVolMetricsOutputSchema.parse(fail('データ不足（最低20本必要）', 'user'));
		}

		const useLog = opts?.useLogReturns ?? true;
		const withAnn = opts?.annualize ?? true;

		const ts: number[] = [];
		const close: number[] = [];
		const open: number[] = [];
		const high: number[] = [];
		const low: number[] = [];
		let skippedOhlc = 0;
		let skippedIsoTime = 0;
		for (const c of candles) {
			const o = toNum(c.open);
			const h = toNum(c.high);
			const l = toNum(c.low);
			const cl = toNum(c.close);
			if (o == null || h == null || l == null || cl == null) {
				skippedOhlc++;
				continue;
			}

			const t = toMs(c.isoTime ?? null);
			if (t == null) {
				skippedIsoTime++;
				continue;
			}
			ts.push(t);
			open.push(o);
			high.push(h);
			low.push(l);
			close.push(cl);
		}

		if (close.length < 20) {
			return GetVolMetricsOutputSchema.parse(fail('有効なOHLCデータ不足（最低20本必要）', 'user'));
		}

		// 取得層の不完全性を集約: 上流 get_candles の fetchWarning + 自前スキップ件数
		const warningLines: string[] = [];
		if (cRes.meta.warning) warningLines.push(cRes.meta.warning);
		if (skippedOhlc > 0) {
			warningLines.push(`⚠️ ${skippedOhlc}件の不正な OHLC をスキップしました。データが不完全な可能性があります。`);
		}
		if (skippedIsoTime > 0) {
			warningLines.push(
				`⚠️ ${skippedIsoTime}件の isoTime 欠損ローソク足をスキップしました。データが不完全な可能性があります。`,
			);
		}
		const fetchWarning = warningLines.length > 0 ? warningLines.join('\n') : undefined;

		// 最新足が形成中（未確定）か。realtime 取得（date 未指定）では最新足は現在形成中の足。
		// 有効足の最新 ts（ts.at(-1)）を起点に判定する。
		const provisional = isLatestBarProvisional(ts.at(-1), String(type));

		const ret = logReturns(close, useLog);
		const rvInst = ret.map((r) => Math.abs(r));

		// Per-candle components for OHLC-based estimators（lib/volatility.ts に委譲）
		const pkSeries = parkinsonComponents(high, low);
		const gkSeries = garmanKlassComponents(open, high, low, close);
		const rsSeries = rogersSatchellComponents(open, high, low, close);

		// Aggregates over whole sample (use returns length for rv)
		const rvStd = stddev(ret);
		// Parkinson/GK/RS are per-candle estimators (not return-based), so use full series
		const pkMean = pkSeries.reduce((s, v) => s + v, 0) / Math.max(1, pkSeries.length);
		const gkMean = gkSeries.reduce((s, v) => s + v, 0) / Math.max(1, gkSeries.length);
		const rsMean = rsSeries.reduce((s, v) => s + v, 0) / Math.max(1, rsSeries.length);
		const parkinson = componentMeanToVol(pkMean, 'parkinson');
		const garmanKlass = componentMeanToVol(gkMean, 'garmanKlass');
		const rogersSatchell = componentMeanToVol(rsMean, 'rogersSatchell');

		// ATR aggregate: Wilder ATR (RMA-based, period=WILDER_ATR_PERIOD 固定、TradingView/MT4 標準)。
		const atrAggLatest = wilderAtr(high, low, close, WILDER_ATR_PERIOD).at(-1);
		const atrAgg = Number.isFinite(atrAggLatest) ? (atrAggLatest as number) : 0;

		const annFactor = withAnn ? Math.sqrt(periodsPerYear(type)) : 1;
		const rvStdAnn = withAnn ? rvStd * annFactor : undefined;

		// Rolling per requested windows
		const rollingOut: Array<{
			window: number;
			rv_std: number;
			rv_std_ann?: number;
			parkinson?: number;
			garmanKlass?: number;
			rogersSatchell?: number;
		}> = [];
		for (const wRaw of windows) {
			const w = Math.max(2, Math.min(wRaw | 0, ret.length));
			if (w > ret.length) continue;
			const rvStdRoll = slidingStddev(ret, w);
			const rvStdLatest = rvStdRoll.at(-1) ?? 0;
			const rvStdAnnLatest = withAnn ? rvStdLatest * annFactor : undefined;
			const pkRoll = slidingMean(pkSeries, w);
			const gkRoll = slidingMean(gkSeries, w);
			const rsRoll = slidingMean(rsSeries, w);
			const p = pkRoll.length ? componentMeanToVol(pkRoll.at(-1) as number, 'parkinson') : undefined;
			const gk = gkRoll.length ? componentMeanToVol(gkRoll.at(-1) as number, 'garmanKlass') : undefined;
			const rs = rsRoll.length ? componentMeanToVol(rsRoll.at(-1) as number, 'rogersSatchell') : undefined;
			rollingOut.push({
				window: w,
				rv_std: rvStdLatest,
				rv_std_ann: rvStdAnnLatest,
				parkinson: p,
				garmanKlass: gk,
				rogersSatchell: rs,
			});
		}

		// Tags: always use annualized RV for consistent thresholds regardless of annualize flag
		const tags: string[] = [];
		const rvRefAnn = rvStdAnn ?? rvStd * Math.sqrt(periodsPerYear(type));
		if (rvRefAnn >= 0.8) tags.push('volatile');
		else if (rvRefAnn <= 0.3) tags.push('calm');

		const data = {
			meta: {
				pair: chk.pair,
				type: String(type),
				fetchedAt: nowIso(),
				baseIntervalMs: baseIntervalMsOf(type),
				sampleSize: close.length,
				windows: [...windows],
				annualize: withAnn,
				useLogReturns: useLog,
				source: 'bitbank:candlestick' as const,
			},
			aggregates: {
				rv_std: Number(rvStd.toFixed(8)),
				rv_std_ann: withAnn ? Number((rvStdAnn as number).toFixed(8)) : undefined,
				parkinson: Number(parkinson.toFixed(8)),
				garmanKlass: Number(garmanKlass.toFixed(8)),
				rogersSatchell: Number(rogersSatchell.toFixed(8)),
				atr: Number(atrAgg.toFixed(8)),
			},
			rolling: rollingOut.map((r) => ({
				window: r.window,
				rv_std: Number(r.rv_std.toFixed(8)),
				rv_std_ann: r.rv_std_ann != null ? Number(r.rv_std_ann.toFixed(8)) : undefined,
				parkinson: r.parkinson != null ? Number(r.parkinson.toFixed(8)) : undefined,
				garmanKlass: r.garmanKlass != null ? Number(r.garmanKlass.toFixed(8)) : undefined,
				rogersSatchell: r.rogersSatchell != null ? Number(r.rogersSatchell.toFixed(8)) : undefined,
			})),
			series: {
				ts,
				close,
				ret: ret.map((v) => Number(v.toFixed(8))),
				rv_inst: rvInst.map((v) => Number(v.toFixed(8))),
			},
			tags,
		};

		const baseSummaryVol = formatSummary({
			pair: chk.pair,
			timeframe: String(type),
			latest: close.at(-1),
			extra: `rv=${(rvRefAnn).toFixed(3)}(ann)${tags.length ? ` ${tags.join(',')}` : ''}`,
		});
		// テキスト summary にボラティリティ詳細を含める（LLM が structuredContent.data を読めない対策）
		const bodySummary = buildVolatilityMetricsText({
			baseSummary: baseSummaryVol,
			aggregates: data.aggregates,
			rolling: rollingOut,
		});
		// 形成中足の注記（warning 2 系統とは別系統）→ 上流 fetchWarning の順で summary 先頭に連結する。
		// 順序は ⚠️ warning → ℹ️ 注記 → 本文（warning を最優先で見せる）。
		const summaryWithNote = prependProvisionalNote(bodySummary, provisional, { separator: '\n' });
		const summary = fetchWarning ? `${fetchWarning}\n${summaryWithNote}` : summaryWithNote;

		const metaExtra: Record<string, unknown> = { type, count: close.length };
		if (fetchWarning) metaExtra.warning = fetchWarning;
		if (provisional) metaExtra.provisional = true;
		const meta = createMeta(chk.pair, metaExtra);
		return GetVolMetricsOutputSchema.parse(
			ok<z.infer<typeof GetVolMetricsDataSchemaOut>, z.infer<typeof GetVolMetricsMetaSchemaOut>>(
				summary,
				data,
				meta as z.infer<typeof GetVolMetricsMetaSchemaOut>,
			),
		);
	} catch (e: unknown) {
		return failFromError(e, { schema: GetVolMetricsOutputSchema });
	}
}
