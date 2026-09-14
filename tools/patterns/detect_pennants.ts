/**
 * Flag / Pennant detection — pole-first scan with explicit bull/bear split.
 *
 * 検出ロジック:
 * 1. Relaxed swing detection (swingDepth=1) で consolidation のスイング点を抽出
 * 2. Pole（旗竿）スキャン — ATR 倍率・変化率・per-bar impulse でフィルタ
 *    （per-bar impulse: atrMult/poleLen で「緩やかな上昇」を除外）
 * 3. Pole 直後の consolidation 範囲でスイング点から上下トレンドラインを R² 回帰
 * 4. 上下ラインの spread 統計（平均・安定性）と convergence ratio を算出
 * 5. 分類:
 *    - 上下ライン平行 + pole と逆方向 → bull_flag / bear_flag
 *    - 上下ライン対称収束（上↓・下↑）→ bull_pennant / bear_pennant
 *    - pole と同方向の傾き → 拒否（trend continuation）
 *    - 発散・横ばい / 単純なノイズ → 拒否
 * 6. Breakout 検出（consolidation 終了後、ATR バッファ付き）
 * 7. 同区間の重複候補を抑制（consolidation 終端の近接性で dedup）
 */

import { cappedBarsForDays } from './bar-thresholds.js';
import { barsPerDay, calcATR, deduplicatePatterns, finalizeConf } from './helpers.js';
import { clamp01 } from './regression.js';
import { BREAKOUT_AGAINST_EXPECTATION } from './structural.js';
import { computeTargetReach, omittedTargetReach, type TargetReachResult, targetReachFields } from './target-reach.js';
import type { CandleData, DetectContext, DetectResult, PatternEntry } from './types.js';

// ---------------------------------------------------------------------------
// 時間軸別パラメータ
// ---------------------------------------------------------------------------
interface PoleParams {
	poleMinBars: number;
	poleMaxBars: number;
	minPoleATRMult: number;
	minPolePct: number;
	/** atrMult / poleLen の最小値。緩やかな上昇を除外するための per-bar impulse 基準。 */
	minPerBarImpulse: number;
	consMinBars: number;
	consMaxBars: number;
}

/** 旗竿 / 保ち合いの長さの日数由来。実効値はバー数（下記参照）。 */
const POLE_MIN_DAYS = 1;
const POLE_MAX_DAYS = 15;
const CONS_MIN_DAYS = 2;
const CONS_MAX_DAYS = 30;
/** 日数換算値が 1 本を割る時間足での絶対下限（旧実装から据え置き）。 */
const POLE_MIN_FLOOR_BARS = 2;
const POLE_MAX_FLOOR_BARS = 5;
const CONS_MIN_FLOOR_BARS = 3;
const CONS_MAX_FLOOR_BARS = 10;

/**
 * 時間足ごとの旗竿 / 保ち合いのバー数パラメータ。
 *
 * 最小側は `patterns/bar-thresholds.ts` の上限（構造的下限の定数倍）で頭打ちにする。
 * 日数換算のままだと `1min` で旗竿 1440 本 + 保ち合い 2880 本を要求し、`limit` の
 * スキーマ上限（365）でも到達不能だった（issue #118 問題 2）。
 *
 * **構造的「下限」は掛けない。** 下限の前提は「前後 `swingDepth` 本の除外」と
 * 「3 ピボットの最小間隔」だが、旗竿は単一のインパルス脚でピボット構造ではない。
 * `1day` に下限 23 本を掛けると `poleMinBars`(23) > `poleMaxBars`(15) となり全滅する。
 * 下限は旧実装の絶対値（旗竿 2 本 / 保ち合い 3 本）をそのまま使う。
 *
 * `patterns/min-bars.ts` が「時間足 → 最小要求バー数」を導出するのに参照するため export する。
 */
export function getFlagParams(tf: string): PoleParams {
	const bpd = barsPerDay(tf);

	// 旗竿: 1〜15日、保ち合い: 2〜30日（日数をバー数に変換）
	const poleMinBars = cappedBarsForDays(tf, POLE_MIN_DAYS, POLE_MIN_FLOOR_BARS);
	const consMinBars = cappedBarsForDays(tf, CONS_MIN_DAYS, CONS_MIN_FLOOR_BARS);
	// 最大側は頭打ちにしない（走査ループはいずれもデータ長で止まる）。最小側がクランプで
	// 動いた結果として max < min にならないことだけ保証する。
	const poleMaxBars = Math.max(poleMinBars, POLE_MAX_FLOOR_BARS, Math.round(POLE_MAX_DAYS * bpd));
	const consMaxBars = Math.max(consMinBars, CONS_MAX_FLOOR_BARS, Math.round(CONS_MAX_DAYS * bpd));

	// ATR 倍率・最小変化率は時間軸で微調整（中庸寄りの設定 — 緩やかな動きを除外）
	const t = String(tf);
	let minPoleATRMult = 2.0;
	let minPolePct = 0.05;
	let minPerBarImpulse = 0.35;
	if (t === '1day') {
		minPoleATRMult = 2.5;
		minPolePct = 0.08;
		minPerBarImpulse = 0.4;
	} else if (t === '1week') {
		minPoleATRMult = 2.5;
		minPolePct = 0.1;
		minPerBarImpulse = 0.4;
	} else if (t === '1month') {
		minPoleATRMult = 3.0;
		minPolePct = 0.12;
		minPerBarImpulse = 0.45;
	} else if (t === '1min' || t === '5min') {
		minPolePct = 0.015;
	} else if (t === '15min' || t === '30min') {
		minPolePct = 0.02;
	} else if (t === '1hour') {
		minPolePct = 0.03;
	} else if (t === '4hour' || t === '8hour' || t === '12hour') {
		minPoleATRMult = 2.2;
		minPolePct = 0.04;
	}

	return { poleMinBars, poleMaxBars, minPoleATRMult, minPolePct, minPerBarImpulse, consMinBars, consMaxBars };
}

// ---------------------------------------------------------------------------
// Spread 統計（チャネル幅の平均と安定性）
// ---------------------------------------------------------------------------
interface SpreadStats {
	spreadAvg: number;
	spreadStability: number; // 1 - CV. 1.0 = 完全平行 / 0.0 = 大きく揺らぐ
	spreadStart: number;
	spreadEnd: number;
	convergenceRatio: number; // spreadEnd / spreadStart
}

interface ValueAt {
	valueAt: (x: number) => number;
}

function computeSpreadStats(upper: ValueAt, lower: ValueAt, startIdx: number, endIdx: number): SpreadStats {
	const sampleCount = Math.max(5, Math.min(20, endIdx - startIdx + 1));
	const samples: number[] = [];
	for (let s = 0; s < sampleCount; s++) {
		const t = sampleCount === 1 ? 0 : s / (sampleCount - 1);
		const i = startIdx + Math.round(t * (endIdx - startIdx));
		const sp = upper.valueAt(i) - lower.valueAt(i);
		if (Number.isFinite(sp) && sp > 0) samples.push(sp);
	}
	const spreadStart = upper.valueAt(startIdx) - lower.valueAt(startIdx);
	const spreadEnd = upper.valueAt(endIdx) - lower.valueAt(endIdx);
	if (samples.length === 0 || spreadStart <= 0) {
		return { spreadAvg: 0, spreadStability: 0, spreadStart, spreadEnd, convergenceRatio: 0 };
	}
	const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
	const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
	const std = Math.sqrt(variance);
	const cv = mean > 0 ? std / mean : 1;
	const stability = clamp01(1 - cv);
	const convergenceRatio = spreadEnd / spreadStart;
	return { spreadAvg: mean, spreadStability: stability, spreadStart, spreadEnd, convergenceRatio };
}

// ---------------------------------------------------------------------------
// Robust regression — 最大残差点を順次除去して minPoints まで縮めながら fit
//
// Consolidation の初期足は pole 直後の調整が残って外れ値になりやすい。
// 単純な線形回帰だと R² が落ちて検出を逃すため、detect_triangles.ts と
// 同様に robust fit を使う。
// ---------------------------------------------------------------------------
interface SwingPt {
	idx: number;
	price: number;
}
interface RegLine {
	slope: number;
	intercept: number;
	r2: number;
	valueAt: (x: number) => number;
}
type LrWithR2Fn = (pts: Array<{ x: number; y: number }>) => RegLine;

function robustFit(
	pts: readonly SwingPt[],
	lrWithR2: LrWithR2Fn,
	minR2: number,
	minPoints: number,
): { line: RegLine; filtered: SwingPt[] } {
	let current = [...pts];
	let line = lrWithR2(current.map((p) => ({ x: p.idx, y: p.price })));
	const maxRemovals = Math.max(0, pts.length - minPoints);
	for (let r = 0; r < maxRemovals && line.r2 < minR2; r++) {
		let worstIdx = 0;
		let worstResidual = 0;
		for (let j = 0; j < current.length; j++) {
			const residual = Math.abs(current[j].price - line.valueAt(current[j].idx));
			if (residual > worstResidual) {
				worstResidual = residual;
				worstIdx = j;
			}
		}
		const next = current.filter((_, j) => j !== worstIdx);
		if (next.length < minPoints) break;
		current = next;
		line = lrWithR2(current.map((p) => ({ x: p.idx, y: p.price })));
	}
	return { line, filtered: current };
}

// ---------------------------------------------------------------------------
// Pole 検出 — 1 つの poleEnd 位置で最強の pole を返す
// ---------------------------------------------------------------------------
interface BestPole {
	poleStart: number;
	poleEnd: number;
	poleLen: number;
	magnitude: number;
	atrMult: number;
	perBarImpulse: number;
	localATR: number;
	poleUp: boolean;
}

function findBestPoleAt(candles: readonly CandleData[], poleEnd: number, params: PoleParams): BestPole | null {
	let best: BestPole | null = null;
	for (let poleLen = params.poleMinBars; poleLen <= Math.min(params.poleMaxBars, poleEnd); poleLen++) {
		const ps = poleEnd - poleLen;
		if (ps < 0) continue;
		const startPrice = candles[ps].close;
		const endPrice = candles[poleEnd].close;
		const magnitude = endPrice - startPrice;
		const changePct = Math.abs(magnitude) / Math.max(1e-12, startPrice);

		const localATR = calcATR(candles, Math.max(1, ps), poleEnd, 14);
		if (localATR <= 0) continue;

		const atrMult = Math.abs(magnitude) / localATR;
		// per-bar impulse: 短期間で大きく動いたか。緩やかな上昇を除外する。
		const perBarImpulse = atrMult / poleLen;

		if (atrMult < params.minPoleATRMult) continue;
		if (changePct < params.minPolePct) continue;
		if (perBarImpulse < params.minPerBarImpulse) continue;

		if (!best || atrMult > best.atrMult) {
			best = {
				poleStart: ps,
				poleEnd,
				poleLen,
				magnitude,
				atrMult,
				perBarImpulse,
				localATR,
				poleUp: magnitude > 0,
			};
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// 分類: bull_flag / bear_flag / bull_pennant / bear_pennant / null
// ---------------------------------------------------------------------------
type FlagType = 'bull_flag' | 'bear_flag' | 'bull_pennant' | 'bear_pennant';

interface ClassifyResult {
	type: FlagType | null;
	reason: string;
}

function classifyFlag(opts: {
	poleUp: boolean;
	upperSlope: number;
	lowerSlope: number;
	spread: SpreadStats;
}): ClassifyResult {
	const { poleUp, upperSlope, lowerSlope, spread } = opts;

	// ガード: spread が消滅 / 発散していたら拒否
	if (spread.spreadStart <= 0 || spread.spreadEnd <= 0) {
		return { type: null, reason: 'spread_invalid' };
	}
	// broadening: チャネル幅が拡大している → flag/pennant ではない
	if (spread.convergenceRatio > 1.4) {
		return { type: null, reason: 'broadening_channel' };
	}

	// Pennant（対称収束）: 上↓ かつ 下↑ かつ大きく収束。
	// spreadStability は収束パターンでは自然に低くなる（CV ベースなので幅変動が分母を圧迫）ため
	// pennant の判定には使わず、幾何（傾き符号 + convergence ratio）のみで判断する。
	const isSymmetricConvergent = upperSlope < 0 && lowerSlope > 0 && spread.convergenceRatio < 0.7;

	if (isSymmetricConvergent) {
		return { type: poleUp ? 'bull_pennant' : 'bear_pennant', reason: 'symmetric_convergence' };
	}

	// Flag（平行チャネル）の判定:
	// - spread の安定性が高い（spreadStability >= 0.7 = CV <= 0.3）
	// - convergence ratio が極端でない（0.7 〜 1.3）
	// - 平均傾き avgSlope が pole と逆方向
	const avgSlope = (upperSlope + lowerSlope) / 2;
	const isStableSpread =
		spread.spreadStability >= 0.7 && spread.convergenceRatio >= 0.7 && spread.convergenceRatio <= 1.3;
	const isCounterToPole = poleUp ? avgSlope < 0 : avgSlope > 0;
	// 完全水平のケース: avgSlope ≈ 0 でも flag として認める（教科書的な水平 flag）。
	const isNearlyHorizontal = Math.abs(avgSlope) < 1e-9 && spread.spreadStability >= 0.85;

	if (!isStableSpread) {
		return { type: null, reason: 'spread_unstable' };
	}
	if (!isCounterToPole && !isNearlyHorizontal) {
		return { type: null, reason: 'slope_same_as_pole' };
	}

	return { type: poleUp ? 'bull_flag' : 'bear_flag', reason: 'parallel_counter_trend' };
}

// ---------------------------------------------------------------------------
// 重複排除: 同じ pole + consolidation を重ねて検出した候補をまとめる
//
// 既存 deduplicatePatterns は同 type で range の重なり率 > 0.5 を要求するが、
// flag/pennant は短いスキャンステップで似た範囲を多数生成するため、
// より緩い閾値（>= 0.3）と「consolidation 終端の近接性」で dedup する。
// ---------------------------------------------------------------------------
function dedupFlagPennants(patterns: PatternEntry[]): PatternEntry[] {
	if (patterns.length <= 1) return patterns;
	const out: PatternEntry[] = [];

	function rangeMs(p: PatternEntry): { start: number; end: number } {
		return {
			start: Date.parse(String(p.range?.start ?? '')),
			end: Date.parse(String(p.range?.end ?? '')),
		};
	}

	function overlapRatio(a: { start: number; end: number }, b: { start: number; end: number }): number {
		if (!Number.isFinite(a.start) || !Number.isFinite(a.end) || !Number.isFinite(b.start) || !Number.isFinite(b.end)) {
			return 0;
		}
		const os = Math.max(a.start, b.start);
		const oe = Math.min(a.end, b.end);
		const ov = Math.max(0, oe - os);
		const minD = Math.max(1, Math.min(a.end - a.start, b.end - b.start));
		return ov / minD;
	}

	// 同 category（flag / pennant）かつ同 direction（bull / bear）を 1 グループとみなす
	function category(p: PatternEntry): string {
		const t = String(p.type ?? '');
		if (t === 'bull_flag' || t === 'bear_flag') return 'flag';
		if (t === 'bull_pennant' || t === 'bear_pennant') return 'pennant';
		return t;
	}

	for (const p of patterns) {
		const pr = rangeMs(p);
		const pCat = category(p);
		const pPoleEnd = p.poleEndDate ? Date.parse(p.poleEndDate) : NaN;

		const collidingIdx = out.findIndex((q) => {
			if (category(q) !== pCat) return false;
			if (q.type !== p.type) return false; // bull/bear 違いは別物として残す
			const qr = rangeMs(q);
			// 期間重複が 30% 以上、または pole 終端日が ±2 日以内
			if (overlapRatio(pr, qr) >= 0.3) return true;
			const qPoleEnd = q.poleEndDate ? Date.parse(q.poleEndDate) : NaN;
			if (Number.isFinite(pPoleEnd) && Number.isFinite(qPoleEnd)) {
				return Math.abs(pPoleEnd - qPoleEnd) <= 2 * 86400000;
			}
			return false;
		});

		if (collidingIdx < 0) {
			out.push(p);
			continue;
		}

		// 既存と比較: confidence 高い方を残し、同点なら end 新しい方
		const existing = out[collidingIdx];
		const eConf = Number(existing.confidence ?? 0);
		const pConf = Number(p.confidence ?? 0);
		if (pConf > eConf) {
			out[collidingIdx] = p;
		} else if (pConf === eConf) {
			const eEnd = Date.parse(String(existing.range?.end ?? ''));
			const pEnd = Date.parse(String(p.range?.end ?? ''));
			if (Number.isFinite(pEnd) && Number.isFinite(eEnd) && pEnd > eEnd) {
				out[collidingIdx] = p;
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// メイン検出関数
// ---------------------------------------------------------------------------
export function detectPennantsFlags(ctx: DetectContext): DetectResult {
	const { candles, want, includeForming, debugCandidates, lrWithR2 } = ctx;
	const type = ctx.type;
	let patterns: PatternEntry[] = [];

	// 入力フィルタ: 'flag' / 'pennant' エイリアスは bull/bear 双方を含む
	const wantBullFlag = want.size === 0 || want.has('bull_flag') || want.has('flag');
	const wantBearFlag = want.size === 0 || want.has('bear_flag') || want.has('flag');
	const wantBullPennant = want.size === 0 || want.has('bull_pennant') || want.has('pennant');
	const wantBearPennant = want.size === 0 || want.has('bear_pennant') || want.has('pennant');

	if (!wantBullFlag && !wantBearFlag && !wantBullPennant && !wantBearPennant) {
		return { patterns: [] };
	}

	const lastIdx = candles.length - 1;
	if (lastIdx < 15) return { patterns: [] };

	const params = getFlagParams(type);

	// Relaxed swing detection (swingDepth=1)
	const relaxedPeaks: Array<{ idx: number; price: number }> = [];
	const relaxedValleys: Array<{ idx: number; price: number }> = [];
	for (let i = 1; i < candles.length - 1; i++) {
		const c = candles[i];
		const prev = candles[i - 1];
		const next = candles[i + 1];
		if (c.high > prev.high && c.high > next.high) {
			relaxedPeaks.push({ idx: i, price: c.high });
		}
		if (c.low < prev.low && c.low < next.low) {
			relaxedValleys.push({ idx: i, price: c.low });
		}
	}

	const outerStep = params.poleMaxBars > 100 ? 2 : 1;

	for (let poleEnd = params.poleMinBars; poleEnd <= lastIdx - params.consMinBars; poleEnd += outerStep) {
		const pole = findBestPoleAt(candles, poleEnd, params);
		if (!pole) continue;

		// この pole 方向で必要なパターンが要求されていなければスキップ
		const directionWanted = pole.poleUp ? wantBullFlag || wantBullPennant : wantBearFlag || wantBearPennant;
		if (!directionWanted) continue;

		// --- Consolidation 範囲のスイング点を抽出 ---
		const consStart = poleEnd + 1;
		if (consStart > lastIdx - 2) continue;
		const consMaxEnd = Math.min(lastIdx, poleEnd + params.consMaxBars);

		const consHighs = relaxedPeaks.filter((p) => p.idx >= consStart && p.idx <= consMaxEnd);
		const consLows = relaxedValleys.filter((p) => p.idx >= consStart && p.idx <= consMaxEnd);

		// 線形回帰の R² ゲートが意味を持つには最低 3 点必要。
		// 2 点だと回帰線がそのまま 2 点を通って fit 100% になり quality check を素通りする。
		const minPointsForFit = 3;
		if (consHighs.length < minPointsForFit || consLows.length < minPointsForFit) {
			debugCandidates.push({
				type: 'flag',
				accepted: false,
				reason: 'insufficient_consolidation_swings',
				indices: [pole.poleStart, poleEnd],
				details: {
					highs: consHighs.length,
					lows: consLows.length,
					minPointsForFit,
					poleATRMult: Number(pole.atrMult.toFixed(2)),
					polePerBarImpulse: Number(pole.perBarImpulse.toFixed(2)),
					polePct: Number((pole.magnitude / Math.max(1e-12, candles[pole.poleStart].close)).toFixed(3)),
					poleBars: pole.poleLen,
					poleDirection: pole.poleUp ? 'up' : 'down',
				},
			});
			continue;
		}

		// トレンドラインのスパン整合性（保ち合いゾーン全体の 30% 以上を覆うこと）
		const upperSpan = consHighs[consHighs.length - 1].idx - consHighs[0].idx;
		const lowerSpan = consLows[consLows.length - 1].idx - consLows[0].idx;
		const actualConsEnd = Math.max(consHighs[consHighs.length - 1].idx, consLows[consLows.length - 1].idx);
		const consZoneWidth = Math.max(1, actualConsEnd - consStart);
		const minSpanRatio = 0.3;

		if (upperSpan < consZoneWidth * minSpanRatio || lowerSpan < consZoneWidth * minSpanRatio) {
			debugCandidates.push({
				type: 'flag',
				accepted: false,
				reason: 'trendline_span_too_short',
				indices: [pole.poleStart, poleEnd],
				details: {
					upperSpan,
					lowerSpan,
					consZoneWidth,
					actualConsEnd,
					upperRatio: Number((upperSpan / consZoneWidth).toFixed(3)),
					lowerRatio: Number((lowerSpan / consZoneWidth).toFixed(3)),
					minSpanRatio,
				},
			});
			continue;
		}

		// Robust regression — 最大残差点を順次除去して minPoints まで縮めながら fit。
		// pole 直後の調整足が外れ値になりやすいため、単純回帰だと R² が落ちて検出を逃す。
		// minPointsForFit は上の swing-count gate と同じ値 (3) を使う。
		const minR2 = 0.5;
		const { line: upperLine, filtered: filteredHighs } = robustFit(consHighs, lrWithR2, minR2, minPointsForFit);
		const { line: lowerLine, filtered: filteredLows } = robustFit(consLows, lrWithR2, minR2, minPointsForFit);

		if (upperLine.r2 < minR2 || lowerLine.r2 < minR2) {
			debugCandidates.push({
				type: 'flag',
				accepted: false,
				reason: 'poor_trendline_fit',
				indices: [pole.poleStart, consMaxEnd],
				details: {
					r2Upper: Number(upperLine.r2.toFixed(3)),
					r2Lower: Number(lowerLine.r2.toFixed(3)),
					highsUsed: filteredHighs.length,
					lowsUsed: filteredLows.length,
					highsTotal: consHighs.length,
					lowsTotal: consLows.length,
					minR2,
				},
			});
			continue;
		}

		const consEndIdx = actualConsEnd;
		const spread = computeSpreadStats(upperLine, lowerLine, consStart, consEndIdx);

		// 保ち合い幅が pole の 90% 超なら「収束していない」と判断して拒否
		const poleRange = Math.abs(pole.magnitude);
		if (spread.spreadStart > poleRange * 0.9) {
			debugCandidates.push({
				type: 'flag',
				accepted: false,
				reason: 'consolidation_too_wide',
				indices: [pole.poleStart, consEndIdx],
				details: {
					consRange: Number(spread.spreadStart.toFixed(2)),
					poleRange: Number(poleRange.toFixed(2)),
					ratio: Number((spread.spreadStart / poleRange).toFixed(3)),
				},
			});
			continue;
		}

		const classification = classifyFlag({
			poleUp: pole.poleUp,
			upperSlope: upperLine.slope,
			lowerSlope: lowerLine.slope,
			spread,
		});

		if (!classification.type) {
			debugCandidates.push({
				type: 'flag',
				accepted: false,
				reason: classification.reason,
				indices: [pole.poleStart, consEndIdx],
				details: {
					convergenceRatio: Number(spread.convergenceRatio.toFixed(3)),
					spreadAvg: Number(spread.spreadAvg.toFixed(2)),
					spreadStability: Number(spread.spreadStability.toFixed(3)),
					spreadStart: Number(spread.spreadStart.toFixed(2)),
					spreadEnd: Number(spread.spreadEnd.toFixed(2)),
					upperSlope: Number(upperLine.slope.toFixed(6)),
					lowerSlope: Number(lowerLine.slope.toFixed(6)),
					poleDirection: pole.poleUp ? 'up' : 'down',
					poleATRMult: Number(pole.atrMult.toFixed(2)),
					polePerBarImpulse: Number(pole.perBarImpulse.toFixed(2)),
				},
			});
			continue;
		}

		const flagType: FlagType = classification.type;
		// 要求フィルタとの整合チェック
		const wantThisType =
			(flagType === 'bull_flag' && wantBullFlag) ||
			(flagType === 'bear_flag' && wantBearFlag) ||
			(flagType === 'bull_pennant' && wantBullPennant) ||
			(flagType === 'bear_pennant' && wantBearPennant);
		if (!wantThisType) continue;

		// Breakout 検出（consolidation 終了後を走査）
		let breakoutIdx = -1;
		let breakoutDirection: 'up' | 'down' | null = null;
		const scanStart = consEndIdx + 1;
		for (let i = scanStart; i <= lastIdx; i++) {
			const close = candles[i].close;
			const uVal = upperLine.valueAt(i);
			const lVal = lowerLine.valueAt(i);
			if (close > uVal + pole.localATR * 0.3) {
				breakoutIdx = i;
				breakoutDirection = 'up';
				break;
			}
			if (close < lVal - pole.localATR * 0.3) {
				breakoutIdx = i;
				breakoutDirection = 'down';
				break;
			}
		}

		const hasBreakout = breakoutIdx !== -1;
		const patternEndIdx = hasBreakout ? breakoutIdx : consEndIdx;
		const expectedBreakoutDirection: 'up' | 'down' = pole.poleUp ? 'up' : 'down';
		const isExpectedBreakout = hasBreakout && breakoutDirection === expectedBreakoutDirection;

		let status: 'completed' | 'invalid' | 'forming' | 'near_completion';
		if (hasBreakout) {
			status = isExpectedBreakout ? 'completed' : 'invalid';
		} else {
			const consBars = consEndIdx - consStart;
			status = consBars > params.consMaxBars * 0.7 ? 'near_completion' : 'forming';
		}

		if ((status === 'forming' || status === 'near_completion') && !includeForming) continue;

		const startIso = candles[pole.poleStart]?.isoTime;
		const endIso = candles[patternEndIdx]?.isoTime;
		const poleStartIso = candles[pole.poleStart]?.isoTime;
		const poleEndIso = candles[pole.poleEnd]?.isoTime;
		if (!startIso || !endIso) continue;

		// --- Scoring ---
		const poleScore = clamp01(pole.atrMult / (params.minPoleATRMult * 3));
		const fitScore = (upperLine.r2 + lowerLine.r2) / 2;
		const touchScore = clamp01((filteredHighs.length + filteredLows.length) / 6);
		// flag は spreadStability、pennant は convergence の良さをスコアする
		const shapeScore =
			flagType === 'bull_flag' || flagType === 'bear_flag'
				? spread.spreadStability
				: clamp01(1 - spread.convergenceRatio); // pennant: convergenceRatio 小さいほど良い
		const baseScore = poleScore * 0.3 + shapeScore * 0.25 + fitScore * 0.2 + touchScore * 0.25;
		const confidence = finalizeConf(baseScore, flagType);

		const outcome = hasBreakout ? (isExpectedBreakout ? 'success' : 'failure') : undefined;
		const poleStartPrice = candles[pole.poleStart].close;
		const poleChangePct = pole.magnitude / Math.max(1e-12, poleStartPrice);

		// --- ターゲット価格計算（flagpole_projection 方式） ---
		let breakoutTarget: number | undefined;
		// 未ブレイクでも**理由を名乗る**（#224 症状 2）。`undefined` で初期化すると
		// `targetReachFields` が黙って `{}` に畳み、content から進捗行ごと消える。
		let targetReach: TargetReachResult = omittedTargetReach('not_broken_out');
		if (hasBreakout && breakoutDirection) {
			const bp = candles[breakoutIdx].close;
			breakoutTarget = breakoutDirection === 'up' ? bp + poleRange : bp - poleRange;
			breakoutTarget = Math.round(breakoutTarget);
			targetReach = computeTargetReach(candles, breakoutIdx, bp, breakoutTarget, breakoutDirection, poleRange);
		}

		patterns.push({
			type: flagType,
			confidence,
			range: { start: startIso, end: endIso },
			status,
			// 継続系の `invalid` は「期待と逆方向にブレイクした」の 1 条件しか無い
			// （上の status 判定: `hasBreakout && !isExpectedBreakout`）ので、`status` が決まれば
			// 理由も決まる。**採否にも `status` にも触らない additive な付与**（issue #291）。
			...(status === 'invalid' ? { invalidReason: BREAKOUT_AGAINST_EXPECTATION } : {}),
			poleDirection: pole.poleUp ? 'up' : 'down',
			priorTrendDirection: pole.poleUp ? 'bullish' : 'bearish',
			flagpoleHeight: Math.round(poleRange),
			expectedBreakoutDirection,
			poleStartDate: poleStartIso,
			poleEndDate: poleEndIso,
			poleChangePct: Number(poleChangePct.toFixed(4)),
			poleBars: pole.poleLen,
			poleATRMult: Number(pole.atrMult.toFixed(2)),
			flagUpperSlope: Number(upperLine.slope.toFixed(6)),
			flagLowerSlope: Number(lowerLine.slope.toFixed(6)),
			spreadAvg: Number(spread.spreadAvg.toFixed(2)),
			spreadStability: Number(spread.spreadStability.toFixed(3)),
			breakoutDirection: breakoutDirection ?? undefined,
			outcome,
			...(hasBreakout ? { isTrendContinuation: isExpectedBreakout } : {}),
			breakoutBarIndex: hasBreakout ? breakoutIdx : undefined,
			...(breakoutTarget !== undefined ? { breakoutTarget, targetMethod: 'flagpole_projection' as const } : {}),
			...targetReachFields(targetReach),
		});

		debugCandidates.push({
			type: flagType,
			accepted: true,
			reason: 'detected',
			indices: [pole.poleStart, patternEndIdx],
			details: {
				poleATRMult: Number(pole.atrMult.toFixed(2)),
				polePerBarImpulse: Number(pole.perBarImpulse.toFixed(2)),
				poleChangePct: Number(poleChangePct.toFixed(3)),
				poleBars: pole.poleLen,
				convergenceRatio: Number(spread.convergenceRatio.toFixed(3)),
				spreadAvg: Number(spread.spreadAvg.toFixed(2)),
				spreadStability: Number(spread.spreadStability.toFixed(3)),
				upperSlope: Number(upperLine.slope.toFixed(6)),
				lowerSlope: Number(lowerLine.slope.toFixed(6)),
				r2Upper: Number(upperLine.r2.toFixed(3)),
				r2Lower: Number(lowerLine.r2.toFixed(3)),
				touchCount: filteredHighs.length + filteredLows.length,
				outliersDropped: consHighs.length + consLows.length - (filteredHighs.length + filteredLows.length),
				breakout: hasBreakout ? { idx: breakoutIdx, direction: breakoutDirection } : null,
				status,
				confidence,
				expectedBreakoutDirection,
			},
		});
	}

	// 同区間の重複候補を抑制
	const beforeDedup = patterns.length;
	patterns = dedupFlagPennants(patterns);
	// 念のため標準 dedup も適用（type='flag'/'pennant' レガシーケース対策）
	patterns = deduplicatePatterns(patterns);
	const afterDedup = patterns.length;

	if (beforeDedup !== afterDedup) {
		debugCandidates.push({
			type: 'flag',
			accepted: true,
			reason: 'dedup_summary',
			details: { beforeDedup, afterDedup, removed: beforeDedup - afterDedup },
		});
	}

	return { patterns };
}
