import {
	BB_PERIOD,
	BB_STDDEV,
	BB_WIDTH_EXPANDING_BELOW_PCTL,
	BB_WIDTH_NORMAL_BELOW_PCTL,
	BB_WIDTH_RANK_WINDOW,
	BB_WIDTH_SQUEEZE_BELOW_PCTL,
	RSI_MIDLINE,
	RSI_OVERBOUGHT,
	RSI_OVERSOLD,
	STOCH_OVERBOUGHT,
	STOCH_OVERSOLD,
} from './indicator-config.js';

// 値の種類はここだけに置き、スキーマ（src/schema/indicators.ts の z.enum）もここから作る（#436）。
export const RSI_ZONES = ['oversold', 'below_midline', 'above_midline', 'overbought'] as const;
export type RsiZone = (typeof RSI_ZONES)[number];

export function rsiZone(rsi: number | null | undefined): RsiZone | null {
	if (rsi == null || !Number.isFinite(rsi)) return null;
	if (rsi <= RSI_OVERSOLD) return 'oversold';
	if (rsi >= RSI_OVERBOUGHT) return 'overbought';
	return rsi < RSI_MIDLINE ? 'below_midline' : 'above_midline';
}

// 「反発の可能性」のような先の値動きを示す言葉は付けない（#431）。
const RSI_ZONE_LABELS: Record<RsiZone, string> = {
	oversold: `売られすぎ圏（${RSI_OVERSOLD}以下）`,
	below_midline: `中立圏（${RSI_MIDLINE}未満）`,
	above_midline: `中立圏（${RSI_MIDLINE}以上）`,
	overbought: `買われすぎ圏（${RSI_OVERBOUGHT}以上）`,
};

export function rsiZoneLabel(rsi: number | null | undefined): string | null {
	const zone = rsiZone(rsi);
	return zone ? RSI_ZONE_LABELS[zone] : null;
}

export const STOCH_ZONES = ['oversold', 'neutral', 'overbought'] as const;
export type StochZone = (typeof STOCH_ZONES)[number];

export function stochZone(k: number | null | undefined): StochZone | null {
	if (k == null || !Number.isFinite(k)) return null;
	if (k >= STOCH_OVERBOUGHT) return 'overbought';
	if (k <= STOCH_OVERSOLD) return 'oversold';
	return 'neutral';
}

const STOCH_ZONE_LABELS: Record<StochZone, string> = {
	oversold: `売られすぎ圏（${STOCH_OVERSOLD}以下）`,
	neutral: '中立圏',
	overbought: `買われすぎ圏（${STOCH_OVERBOUGHT}以上）`,
};

export function stochZoneLabel(zone: StochZone): string {
	return STOCH_ZONE_LABELS[zone];
}

// 上下のバンドは中心から ±BB_STDDEV σ なので、バンドの全幅を 2 × BB_STDDEV で割ると σ になる。
export function bbZScore(
	close: number | null | undefined,
	middle: number | null | undefined,
	upper: number | null | undefined,
	lower: number | null | undefined,
): number | null {
	if (close == null || middle == null || upper == null || lower == null) return null;
	const sigma = (upper - lower) / (2 * BB_STDDEV);
	if (!Number.isFinite(close) || !Number.isFinite(middle) || !(sigma > 0)) return null;
	return (close - middle) / sigma;
}

export const BB_POSITIONS = ['at_lower', 'lower_zone', 'near_middle', 'upper_zone', 'at_upper'] as const;
export type BbPosition = (typeof BB_POSITIONS)[number];

export function bbPosition(zScore: number | null | undefined): BbPosition | null {
	if (zScore == null || !Number.isFinite(zScore)) return null;
	if (zScore >= BB_STDDEV) return 'at_upper';
	if (zScore <= -BB_STDDEV) return 'at_lower';
	if (Math.abs(zScore) <= 1) return 'near_middle';
	return zScore > 0 ? 'upper_zone' : 'lower_zone';
}

const BB_POSITION_LABELS: Record<BbPosition, string> = {
	at_upper: `買われすぎ圏（+${BB_STDDEV}σ以上）`,
	upper_zone: `中心より上（+1σ〜+${BB_STDDEV}σ）`,
	near_middle: '中心付近（±1σ以内）',
	lower_zone: `中心より下（-1σ〜-${BB_STDDEV}σ）`,
	at_lower: `売られすぎ圏（-${BB_STDDEV}σ以下）`,
};

export function bbPositionLabel(position: BbPosition): string {
	return BB_POSITION_LABELS[position];
}

export interface BbWidthRank {
	// 丸める前の値。区切りはこの値で判定し、表示だけ丸める。
	percentile: number;
	sampleSize: number;
}

type Series = ReadonlyArray<number | null | undefined>;

// 幅の水準は足の種類で大きく違う（4 時間足は数 %、週足は数十 %）ので、固定値ではなく同じ足の過去の幅と比べる（#437）。
export function bbWidthRank(
	upper: Series,
	middle: Series,
	lower: Series,
	window: number = BB_WIDTH_RANK_WINDOW,
): BbWidthRank | null {
	const n = Math.min(upper.length, middle.length, lower.length);
	const widths: number[] = [];
	for (let i = n - 1; i >= 0 && widths.length < window; i--) {
		const u = upper[i];
		const m = middle[i];
		const l = lower[i];
		const valid = u != null && m != null && l != null && Number.isFinite(u) && Number.isFinite(l) && m > 0;
		if (!valid) {
			if (i === n - 1) return null;
			continue;
		}
		widths.push(((u - l) / m) * 100);
	}
	if (widths.length < BB_PERIOD) return null;
	const current = widths[0];
	const below = widths.filter((w) => w < current).length;
	const equal = widths.filter((w) => w === current).length;
	// 同じ値は半分ずつ数える（幅が一定のとき 50%）。下回る数だけだと、一定の幅がスクイーズに化ける。
	return { percentile: ((below + equal / 2) / widths.length) * 100, sampleSize: widths.length };
}

export const BB_WIDTH_STATES = ['squeeze', 'normal', 'expanding', 'wide'] as const;
export type BbWidthState = (typeof BB_WIDTH_STATES)[number];

export function bbWidthState(rank: BbWidthRank | null | undefined): BbWidthState | null {
	if (rank == null || !Number.isFinite(rank.percentile)) return null;
	if (rank.percentile < BB_WIDTH_SQUEEZE_BELOW_PCTL) return 'squeeze';
	if (rank.percentile < BB_WIDTH_NORMAL_BELOW_PCTL) return 'normal';
	if (rank.percentile < BB_WIDTH_EXPANDING_BELOW_PCTL) return 'expanding';
	return 'wide';
}

const BB_WIDTH_STATE_NAMES: Record<BbWidthState, string> = {
	squeeze: 'スクイーズ',
	normal: '標準',
	expanding: '拡大',
	wide: '大きく拡大',
};

export function bbWidthStateLabel(state: BbWidthState, rank: BbWidthRank): string {
	return `${BB_WIDTH_STATE_NAMES[state]}（直近${rank.sampleSize}本の幅の中で下から${Math.round(rank.percentile)}%）`;
}

export interface IndicatorZones {
	rsi: RsiZone | null;
	stochRsi: StochZone | null;
	bbPosition: BbPosition | null;
	bbWidth: BbWidthState | null;
}

export interface IndicatorZoneInputs {
	close: number | null | undefined;
	rsi: number | null | undefined;
	stochRsiK: number | null | undefined;
	bbMiddle: number | null | undefined;
	bbUpper: number | null | undefined;
	bbLower: number | null | undefined;
	bbSeries: { upper: Series; middle: Series; lower: Series } | null | undefined;
}

// analyze_indicators の本文のラベルと同じ値・同じ関数から出す。
export function indicatorZones(input: IndicatorZoneInputs): IndicatorZones {
	const { close, rsi, stochRsiK, bbMiddle, bbUpper, bbLower, bbSeries } = input;
	return {
		rsi: rsiZone(rsi),
		stochRsi: stochZone(stochRsiK),
		bbPosition: bbPosition(bbZScore(close, bbMiddle, bbUpper, bbLower)),
		bbWidth: bbSeries ? bbWidthState(bbWidthRank(bbSeries.upper, bbSeries.middle, bbSeries.lower)) : null,
	};
}
