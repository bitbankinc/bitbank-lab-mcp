import {
	BB_PERIOD,
	ICHIMOKU_SHIFT,
	RSI_PERIOD,
	STOCH_PERIOD,
	STOCH_SMOOTH_D,
	STOCH_SMOOTH_K,
} from './indicator-config.js';

// 指標系列の単一ソース。計算（computeAllIndicators）・データ不足警告・取得本数・チャートの系列キー・
// パディング・描画色はすべてここから導出する。行を足せば全箇所に追従し、公開スキーマ（flat キー・enum）との
// 一致は tests/indicator-series-parity.test.ts が固定する。

export interface MaSeriesSpec {
	kind: 'sma' | 'ema';
	period: number;
	/** 公開契約の flat キー（src/schema/indicators.ts / chart.ts の enum と一致させる） */
	key: string;
	/** indicators 内の系列フィールド名（公開契約） */
	seriesKey: string;
	/** render_chart_svg の線色（SMA は実線、EMA は破線を呼び出し側で付ける） */
	color: string;
}

export const MA_SERIES = [
	{ kind: 'sma', period: 5, key: 'SMA_5', seriesKey: 'sma_5_series', color: '#f472b6' },
	{ kind: 'sma', period: 20, key: 'SMA_20', seriesKey: 'sma_20_series', color: '#a78bfa' },
	{ kind: 'sma', period: 25, key: 'SMA_25', seriesKey: 'sma_25_series', color: '#3b82f6' },
	{ kind: 'sma', period: 50, key: 'SMA_50', seriesKey: 'sma_50_series', color: '#22d3ee' },
	{ kind: 'sma', period: 75, key: 'SMA_75', seriesKey: 'sma_75_series', color: '#f59e0b' },
	{ kind: 'sma', period: 200, key: 'SMA_200', seriesKey: 'sma_200_series', color: '#10b981' },
	{ kind: 'ema', period: 12, key: 'EMA_12', seriesKey: 'ema_12_series', color: '#ff6b35' },
	{ kind: 'ema', period: 26, key: 'EMA_26', seriesKey: 'ema_26_series', color: '#ffd166' },
	{ kind: 'ema', period: 50, key: 'EMA_50', seriesKey: 'ema_50_series', color: '#ef476f' },
	{ kind: 'ema', period: 200, key: 'EMA_200', seriesKey: 'ema_200_series', color: '#06d6a0' },
] as const satisfies readonly MaSeriesSpec[];

export type MaSeriesKey = (typeof MA_SERIES)[number]['key'];
export type MaSeriesFieldKey = (typeof MA_SERIES)[number]['seriesKey'];

/**
 * 単一インスタンス指標の「最新値が確定する本数」（buildWarnings の閾値）。
 * lib 実装との一致は tests/calc_audit_probe.test.ts の境界 probe（N-1 本 / N 本の両側）が固定している。
 */
export const FIXED_MIN_BARS = [
	{ label: 'RSI_14', minBars: RSI_PERIOD + 1 },
	{ label: 'Bollinger_Bands', minBars: BB_PERIOD },
	// 転換線 9・基準線 26・先行スパン B 52 の最大。
	{ label: 'Ichimoku', minBars: 52 },
	// classic Stochastic の最新 %D は kPeriod + smoothK + smoothD - 2 本目で確定する（lib/indicators.ts の早期 return 条件と一致）。
	{ label: 'Stochastic', minBars: STOCH_PERIOD + STOCH_SMOOTH_K + STOCH_SMOOTH_D - 2 },
	// StochRSI の最新 %D は「RSI 初値（rsiPeriod+1 本目）から Stochastic と同じ助走」で確定する（lib/indicators.ts の guard と一致）。
	{ label: 'StochRSI', minBars: RSI_PERIOD + 1 + (STOCH_PERIOD + STOCH_SMOOTH_K + STOCH_SMOOTH_D - 2) - 1 },
] as const;

/**
 * 取得本数のバッファ（lib/indicator_buffer.ts が読む）。確定本数（FIXED_MIN_BARS）とは別物で、
 * 平滑の助走や一目の雲の先行シフトぶんを含めて多めに取る値。
 */
export const FIXED_FETCH_BARS = {
	RSI_14: RSI_PERIOD + 1,
	BB_20: BB_PERIOD,
	// 窓 14 本に %K/%D 平滑の助走を足した値。
	STOCH: 20,
	// 先行スパンの雲を ICHIMOKU_SHIFT 本先まで描くため、確定本数 52 に雲ぶんを足す。
	ICHIMOKU: 52 + ICHIMOKU_SHIFT,
} as const;
