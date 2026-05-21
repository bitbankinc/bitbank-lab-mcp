/**
 * patterns/structural.ts - パターン構造検証ユーティリティ
 *
 * 反転パターン（double_top / double_bottom / head_and_shoulders /
 * inverse_head_and_shoulders）の検出に「形として失格な候補を hard reject
 * する層」を入れるための純粋関数群。
 *
 * 本ファイルは純粋関数のみ。detect_doubles.ts / detect_hs.ts への配線は
 * 別 PR で行う。
 *
 * regression.ts の `relDev`（分母 `Math.max(1, Math.max(a, b))`）には
 * 依存させず、構造検証の観点で純粋な相対差を返す `relDiff` を独立に持つ。
 */

// ---------- 定数 ----------

/** double_top / double_bottom の2点（山-山、谷-谷）同水準の構造上限 */
export const DOUBLE_LEVEL_MAX_PCT = 0.03;

/** H&S / IHS の左右肩同水準の構造上限 */
export const HS_SHOULDER_MAX_PCT = 0.05;

/** H&S / IHS のネックライン構成点（p1, p3）同水準の構造上限 */
export const HS_NECKLINE_MAX_PCT = 0.05;

/** 前提トレンド判定で「横ばい」とみなす priorReturn の範囲 */
export const PRIOR_TREND_SIDEWAYS_PCT = 0.05;

/** 前提トレンド判定の lookback バー数（min / max） */
export const PRIOR_TREND_LOOKBACK_MIN = 10;
export const PRIOR_TREND_LOOKBACK_MAX = 30;

// ---------- 純粋関数 ----------

/**
 * 2値の相対差。`Math.max(a, b)` を分母にとり、`|a-b| / max(a, b)` を返す。
 *
 * 両方 0 のときはゼロ除算を避けるため 0 を返す。
 */
export function relDiff(a: number, b: number): number {
	const max = Math.max(a, b);
	if (max === 0) return 0;
	return Math.abs(a - b) / max;
}

/** 2値が `maxPct` 以内に収まっているか（hard cap 用） */
export function isSameLevel(a: number, b: number, maxPct: number): boolean {
	return relDiff(a, b) <= maxPct;
}

/** ネックライン構成2点の水平性検証結果 */
export interface NecklineHorizontalityResult {
	ok: boolean;
	diffPct: number;
}

/**
 * ネックライン構成2点の水平性検証。
 *
 * H&S / IHS の `neckline = [{x:p1.idx,y:p1.price},{x:p3.idx,y:p3.price}]`
 * の y 同士を `maxPct` 以内で同水準とみなす。
 */
export function validateHorizontalNeckline(
	p1Price: number,
	p3Price: number,
	maxPct: number,
): NecklineHorizontalityResult {
	const diffPct = relDiff(p1Price, p3Price);
	return { ok: diffPct <= maxPct, diffPct };
}

export type PriorTrendExpected = 'up_or_sideways' | 'down_or_sideways';

export type PriorTrendClassification = 'up' | 'down' | 'sideways' | 'insufficient_data';

export interface PriorTrendResult {
	ok: boolean;
	priorReturn: number;
	lookbackBars: number;
	classification: PriorTrendClassification;
	reason?: string;
}

/**
 * 形成前トレンド方向の検証。
 *
 * - `lookbackBars = clamp(round(patternBars * 0.5), PRIOR_TREND_LOOKBACK_MIN, PRIOR_TREND_LOOKBACK_MAX)`
 * - `priorStart  = max(0, startIdx - lookbackBars)`
 * - `priorReturn = (close[startIdx] - close[priorStart]) / close[priorStart]`
 *
 * - `expected='up_or_sideways'`  は `priorReturn >= -PRIOR_TREND_SIDEWAYS_PCT` を OK
 * - `expected='down_or_sideways'` は `priorReturn <=  PRIOR_TREND_SIDEWAYS_PCT` を OK
 * - データ不足（`startIdx - lookbackBars < 0`、すなわち `startIdx < lookbackBars`）は
 *   `ok=true`, `classification='insufficient_data'` で返す（hard reject しない）
 *
 * 将来 R² やレンジ性判定を追加するため、結果はメタ情報付きの object を返す。
 */
export function validatePriorTrend(
	candles: ReadonlyArray<{ close: number }>,
	startIdx: number,
	patternBars: number,
	expected: PriorTrendExpected,
): PriorTrendResult {
	const lookbackBars = Math.max(
		PRIOR_TREND_LOOKBACK_MIN,
		Math.min(PRIOR_TREND_LOOKBACK_MAX, Math.round(patternBars * 0.5)),
	);
	const priorStart = Math.max(0, startIdx - lookbackBars);
	const startClose = candles[startIdx]?.close ?? 0;
	const priorClose = candles[priorStart]?.close ?? 0;
	const priorReturn = priorClose === 0 ? 0 : (startClose - priorClose) / priorClose;

	if (startIdx < lookbackBars) {
		return {
			ok: true,
			priorReturn,
			lookbackBars,
			classification: 'insufficient_data',
			reason: 'startIdx < lookbackBars',
		};
	}

	let classification: PriorTrendClassification;
	if (priorReturn > PRIOR_TREND_SIDEWAYS_PCT) {
		classification = 'up';
	} else if (priorReturn < -PRIOR_TREND_SIDEWAYS_PCT) {
		classification = 'down';
	} else {
		classification = 'sideways';
	}

	const ok =
		expected === 'up_or_sideways' ? priorReturn >= -PRIOR_TREND_SIDEWAYS_PCT : priorReturn <= PRIOR_TREND_SIDEWAYS_PCT;

	return { ok, priorReturn, lookbackBars, classification };
}
