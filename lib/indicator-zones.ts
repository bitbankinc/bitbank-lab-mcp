import { RSI_MIDLINE, RSI_OVERBOUGHT, RSI_OVERSOLD, STOCH_OVERBOUGHT, STOCH_OVERSOLD } from './indicator-config.js';

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
