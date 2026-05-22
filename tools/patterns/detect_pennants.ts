/**
 * Flag detection — swing-point based with sliding pole scan.
 *
 * Pennant detection has been moved to detect_triangles.ts (Trendoscope 2-stage:
 * triangle detection → pole check → reclassify as pennant).
 *
 * This module now handles flag patterns only:
 * 1. Relaxed swing detection (swingDepth=1) for consolidation trendlines
 * 2. Scan for impulsive moves (flagpoles) using ATR normalization
 * 3. For each pole, examine subsequent swing points for consolidation
 * 4. Fit R²-based regression trendlines on consolidation swing points
 * 5. Classify as flag (roughly parallel channel, counter-trend to pole)
 * 6. Detect breakout with ATR buffer
 * 7. Apply deduplicatePatterns() before returning
 */

import { barsPerDay, calcATR, deduplicatePatterns, finalizeConf } from './helpers.js';
import { clamp01 } from './regression.js';
import type { DetectContext, DetectResult, PatternEntry } from './types.js';

// ---------------------------------------------------------------------------
// 時間軸別パラメータ — 「日数」ベースで定義し、bars-per-day で変換
// ---------------------------------------------------------------------------
function getFlagParams(tf: string) {
	const bpd = barsPerDay(tf);

	// 旗竿: 1〜15日、保ち合い: 2〜30日（日数をバー数に変換）
	const poleMinBars = Math.max(2, Math.round(1 * bpd));
	const poleMaxBars = Math.max(5, Math.round(15 * bpd));
	const consMinBars = Math.max(3, Math.round(2 * bpd));
	const consMaxBars = Math.max(10, Math.round(30 * bpd));

	// ATR 倍率・最小変化率は時間軸で微調整
	const t = String(tf);
	let minPoleATRMult = 1.5;
	let minPolePct = 0.03;
	if (t === '1day') {
		minPoleATRMult = 2.0;
		minPolePct = 0.05;
	}
	if (t === '1week') {
		minPoleATRMult = 2.0;
		minPolePct = 0.06;
	}
	if (t === '1month') {
		minPoleATRMult = 2.5;
		minPolePct = 0.08;
	}
	if (t === '1min' || t === '5min') {
		minPolePct = 0.01;
	}
	if (t === '15min' || t === '30min') {
		minPolePct = 0.015;
	}
	if (t === '1hour') {
		minPolePct = 0.02;
	}

	return { poleMinBars, poleMaxBars, minPoleATRMult, minPolePct, consMinBars, consMaxBars };
}

export function detectPennantsFlags(ctx: DetectContext): DetectResult {
	const { candles, want, includeForming, debugCandidates, lrWithR2 } = ctx;
	const type = ctx.type;
	let patterns: PatternEntry[] = [];

	// This module now only handles flags. Pennants are detected via detect_triangles.ts.
	const wantFlag = want.size === 0 || want.has('flag');
	if (!wantFlag) return { patterns: [] };

	const lastIdx = candles.length - 1;
	if (lastIdx < 15) return { patterns: [] };

	const params = getFlagParams(type);

	// --- Relaxed swing detection (swingDepth=1) for consolidation zones ---
	const relaxedPeaks: Array<{ idx: number; price: number }> = [];
	const relaxedValleys: Array<{ idx: number; price: number }> = [];
	for (let i = 1; i < candles.length - 1; i++) {
		const c = candles[i],
			prev = candles[i - 1],
			next = candles[i + 1];
		if (c.high > prev.high && c.high > next.high) {
			relaxedPeaks.push({ idx: i, price: c.high });
		}
		if (c.low < prev.low && c.low < next.low) {
			relaxedValleys.push({ idx: i, price: c.low });
		}
	}

	// --- Scan for flagpoles across entire history ---
	const outerStep = params.poleMaxBars > 100 ? 2 : 1;
	const innerStep = params.poleMaxBars > 50 ? 2 : 1;

	for (let poleEnd = params.poleMinBars; poleEnd <= lastIdx - params.consMinBars; poleEnd += outerStep) {
		// Find the strongest pole ending at this position
		let bestPoleStart = -1;
		let bestPoleMag = 0;
		let bestPoleATRMult = 0;

		for (let poleLen = params.poleMinBars; poleLen <= Math.min(params.poleMaxBars, poleEnd); poleLen += innerStep) {
			const ps = poleEnd - poleLen;
			const startPrice = candles[ps].close;
			const endPrice = candles[poleEnd].close;
			const magnitude = endPrice - startPrice;
			const changePct = Math.abs(magnitude) / Math.max(1e-12, startPrice);

			// Local ATR at pole
			const localATR = calcATR(candles, Math.max(1, ps), poleEnd, 14);
			if (localATR <= 0) continue;

			const atrMult = Math.abs(magnitude) / localATR;
			if (atrMult < params.minPoleATRMult || changePct < params.minPolePct) continue;

			// Keep the strongest pole
			if (atrMult > bestPoleATRMult) {
				bestPoleStart = ps;
				bestPoleMag = magnitude;
				bestPoleATRMult = atrMult;
			}
		}

		if (bestPoleStart < 0) continue;

		const poleUp = bestPoleMag > 0;
		const localATR = calcATR(candles, Math.max(1, bestPoleStart), poleEnd, 14);
		if (localATR <= 0) continue;

		// --- Check consolidation after pole ---
		const consStart = poleEnd + 1;
		if (consStart > lastIdx - 2) continue;

		const consMaxEnd = Math.min(lastIdx, poleEnd + params.consMaxBars);

		// Get swing points in consolidation zone
		const consHighs = relaxedPeaks.filter((p) => p.idx >= consStart && p.idx <= consMaxEnd);
		const consLows = relaxedValleys.filter((p) => p.idx >= consStart && p.idx <= consMaxEnd);

		if (consHighs.length < 2 || consLows.length < 2) {
			debugCandidates.push({
				type: 'flag',
				accepted: false,
				reason: 'insufficient_consolidation_swings',
				indices: [bestPoleStart, poleEnd],
				details: { highs: consHighs.length, lows: consLows.length, poleATRMult: Number(bestPoleATRMult.toFixed(2)) },
			});
			continue;
		}

		// --- Trendline span balance check ---
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
				indices: [bestPoleStart, poleEnd],
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

		// Fit trendlines with R²-based regression on swing points
		const upperLine = lrWithR2(consHighs.map((p) => ({ x: p.idx, y: p.price })));
		const lowerLine = lrWithR2(consLows.map((p) => ({ x: p.idx, y: p.price })));

		const minR2 = 0.65; // 平行チャネルは線形性が命 — 0.25 では偽陽性が多すぎた
		if (upperLine.r2 < minR2 || lowerLine.r2 < minR2) {
			debugCandidates.push({
				type: 'flag',
				accepted: false,
				reason: 'poor_trendline_fit',
				indices: [bestPoleStart, consMaxEnd],
				details: { r2Upper: Number(upperLine.r2.toFixed(3)), r2Lower: Number(lowerLine.r2.toFixed(3)), minR2 },
			});
			continue;
		}

		// Consolidation geometry
		const consEndIdx = actualConsEnd;
		const gapStart = upperLine.valueAt(consStart) - lowerLine.valueAt(consStart);
		const gapEnd = upperLine.valueAt(consEndIdx) - lowerLine.valueAt(consEndIdx);

		if (gapStart <= 0 || gapEnd <= 0) continue;

		const poleRange = Math.abs(bestPoleMag);
		if (gapStart > poleRange * 0.9) {
			debugCandidates.push({
				type: 'flag',
				accepted: false,
				reason: 'consolidation_too_wide',
				indices: [bestPoleStart, consEndIdx],
				details: {
					consRange: Number(gapStart.toFixed(2)),
					poleRange: Number(poleRange.toFixed(2)),
					ratio: Number((gapStart / poleRange).toFixed(3)),
				},
			});
			continue;
		}

		const convergenceRatio = gapEnd / gapStart;

		// --- Classify: Flag only (parallel channel, counter-trend to pole) ---
		const avgSlope = (upperLine.slope + lowerLine.slope) / 2;
		const slopeDiff = Math.abs(upperLine.slope - lowerLine.slope);
		const isParallel = slopeDiff < Math.abs(avgSlope) * 0.6 || convergenceRatio > 0.7;
		const isAgainstPole = poleUp ? avgSlope < 0 : avgSlope > 0;

		if (!(isParallel && isAgainstPole && convergenceRatio > 0.6)) {
			debugCandidates.push({
				type: 'flag',
				accepted: false,
				reason: 'classification_failed',
				indices: [bestPoleStart, consEndIdx],
				details: {
					convergenceRatio: Number(convergenceRatio.toFixed(3)),
					upperSlope: Number(upperLine.slope.toFixed(6)),
					lowerSlope: Number(lowerLine.slope.toFixed(6)),
					poleDirection: poleUp ? 'up' : 'down',
					isParallel,
					isAgainstPole,
				},
			});
			continue;
		}

		// --- Breakout detection (close-based with ATR buffer) ---
		let breakoutIdx = -1;
		let breakoutDirection: 'up' | 'down' | null = null;

		// Scan for breakout only AFTER consolidation ends.
		// Scanning earlier picks up normal in-pattern oscillations as fake breakouts.
		const scanStart = consEndIdx + 1;
		for (let i = scanStart; i <= lastIdx; i++) {
			const close = candles[i].close;
			const uVal = upperLine.valueAt(i);
			const lVal = lowerLine.valueAt(i);

			if (close > uVal + localATR * 0.3) {
				breakoutIdx = i;
				breakoutDirection = 'up';
				break;
			}
			if (close < lVal - localATR * 0.3) {
				breakoutIdx = i;
				breakoutDirection = 'down';
				break;
			}
		}

		// --- Status determination ---
		const hasBreakout = breakoutIdx !== -1;
		const patternEndIdx = hasBreakout ? breakoutIdx : consEndIdx;
		const isExpectedBreakout =
			hasBreakout && ((poleUp && breakoutDirection === 'up') || (!poleUp && breakoutDirection === 'down'));

		let status: 'completed' | 'invalid' | 'forming' | 'near_completion';
		if (hasBreakout) {
			status = isExpectedBreakout ? 'completed' : 'invalid';
		} else {
			// Flag: duration-based completion estimate
			const consBars = consEndIdx - consStart;
			status = consBars > params.consMaxBars * 0.7 ? 'near_completion' : 'forming';
		}

		// Skip forming if not requested
		if ((status === 'forming' || status === 'near_completion') && !includeForming) continue;

		const startIso = candles[bestPoleStart]?.isoTime;
		const endIso = candles[patternEndIdx]?.isoTime;
		if (!startIso || !endIso) continue;

		// --- Scoring ---
		const poleScore = clamp01(bestPoleATRMult / (params.minPoleATRMult * 3));
		const convScore = clamp01(1 - Math.abs(1 - convergenceRatio) / 0.5); // closer to 1.0 = better for flags
		const fitScore = (upperLine.r2 + lowerLine.r2) / 2;
		const touchScore = clamp01((consHighs.length + consLows.length) / 6);

		const baseScore = poleScore * 0.3 + convScore * 0.25 + fitScore * 0.2 + touchScore * 0.25;
		const confidence = finalizeConf(baseScore, 'flag');

		const outcome = hasBreakout ? (isExpectedBreakout ? 'success' : 'failure') : undefined;

		// --- ターゲット価格計算（flagpole_projection 方式） ---
		let breakoutTarget: number | undefined;
		let targetReachedPct: number | undefined;
		if (hasBreakout && breakoutDirection) {
			const bp = candles[breakoutIdx].close;
			breakoutTarget = breakoutDirection === 'up' ? bp + poleRange : bp - poleRange;
			breakoutTarget = Math.round(breakoutTarget);
			const curPrice = Number(candles[lastIdx]?.close);
			if (Number.isFinite(curPrice) && Math.abs(breakoutTarget - bp) > 1e-12) {
				targetReachedPct = Math.round(((curPrice - bp) / (breakoutTarget - bp)) * 100);
			}
		}

		patterns.push({
			type: 'flag',
			confidence,
			range: { start: startIso, end: endIso },
			status,
			poleDirection: poleUp ? 'up' : 'down',
			flagpoleHeight: Math.round(poleRange),
			breakoutDirection: breakoutDirection ?? undefined,
			outcome,
			breakoutBarIndex: hasBreakout ? breakoutIdx : undefined,
			...(breakoutTarget !== undefined ? { breakoutTarget, targetMethod: 'flagpole_projection' as const } : {}),
			...(targetReachedPct !== undefined ? { targetReachedPct } : {}),
		});

		debugCandidates.push({
			type: 'flag',
			accepted: true,
			reason: 'detected',
			indices: [bestPoleStart, patternEndIdx],
			details: {
				poleATRMult: Number(bestPoleATRMult.toFixed(2)),
				convergenceRatio: Number(convergenceRatio.toFixed(3)),
				r2Upper: Number(upperLine.r2.toFixed(3)),
				r2Lower: Number(lowerLine.r2.toFixed(3)),
				touchCount: consHighs.length + consLows.length,
				breakout: hasBreakout ? { idx: breakoutIdx, direction: breakoutDirection } : null,
				status,
				confidence,
			},
		});
	}

	patterns = deduplicatePatterns(patterns);

	return { patterns };
}
