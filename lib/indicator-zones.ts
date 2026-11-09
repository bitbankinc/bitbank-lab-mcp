import {
	BB_STDDEV,
	BB_WIDTH_EXPANDING_MAX_PCT,
	BB_WIDTH_NORMAL_MAX_PCT,
	BB_WIDTH_SQUEEZE_MAX_PCT,
	RSI_MIDLINE,
	RSI_OVERBOUGHT,
	RSI_OVERSOLD,
	STOCH_OVERBOUGHT,
	STOCH_OVERSOLD,
} from './indicator-config.js';

export type RsiZone = 'oversold' | 'below_midline' | 'above_midline' | 'overbought';

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

export type StochZone = 'oversold' | 'neutral' | 'overbought';

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

export type BbPosition = 'at_lower' | 'lower_zone' | 'near_middle' | 'upper_zone' | 'at_upper';

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

export type BbWidthState = 'squeeze' | 'normal' | 'expanding' | 'wide';

// 幅の区切りは足の種類に依らない固定値（#431）。
export function bbWidthState(bandWidthPct: number | null | undefined): BbWidthState | null {
	if (bandWidthPct == null || !Number.isFinite(bandWidthPct)) return null;
	if (bandWidthPct <= BB_WIDTH_SQUEEZE_MAX_PCT) return 'squeeze';
	if (bandWidthPct <= BB_WIDTH_NORMAL_MAX_PCT) return 'normal';
	if (bandWidthPct <= BB_WIDTH_EXPANDING_MAX_PCT) return 'expanding';
	return 'wide';
}

const BB_WIDTH_STATE_LABELS: Record<BbWidthState, string> = {
	squeeze: `スクイーズ（${BB_WIDTH_SQUEEZE_MAX_PCT}%以下）`,
	normal: `標準（${BB_WIDTH_SQUEEZE_MAX_PCT}〜${BB_WIDTH_NORMAL_MAX_PCT}%）`,
	expanding: `拡大（${BB_WIDTH_NORMAL_MAX_PCT}〜${BB_WIDTH_EXPANDING_MAX_PCT}%）`,
	wide: `大きく拡大（${BB_WIDTH_EXPANDING_MAX_PCT}%超）`,
};

export function bbWidthStateLabel(state: BbWidthState): string {
	return BB_WIDTH_STATE_LABELS[state];
}
