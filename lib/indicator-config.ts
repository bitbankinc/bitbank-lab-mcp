// analyze_indicators / render_chart_svg / handler 等が共有する既定値の単一ソース。

export const RSI_PERIOD = 14;
export const RSI_OVERBOUGHT = 70;
export const RSI_OVERSOLD = 30;
export const RSI_MIDLINE = 50;

export const BB_PERIOD = 20;
export const BB_STDDEV = 2;
export const BB_WIDTH_RANK_WINDOW = 120;
export const BB_WIDTH_SQUEEZE_BELOW_PCTL = 20;
export const BB_WIDTH_NORMAL_BELOW_PCTL = 80;
export const BB_WIDTH_EXPANDING_BELOW_PCTL = 95;

export const SMA_DEFAULT_PERIOD = 25;

export const MACD_FAST = 12;
export const MACD_SLOW = 26;
export const MACD_SIGNAL = 9;

export const STOCH_PERIOD = 14;
export const STOCH_SMOOTH_K = 3;
export const STOCH_SMOOTH_D = 3;
export const STOCH_OVERBOUGHT = 80;
export const STOCH_OVERSOLD = 20;

export const OBV_SMA_PERIOD = 20;
export const OBV_TREND_THRESHOLD = 0.02;

export const ICHIMOKU_SHIFT = 26;
export const ICHIMOKU_MIN_BARS_FOR_CLOUD = 60;

export const INDICATOR_CACHE_TTL_MS = 30_000;
export const INDICATOR_CACHE_MAX_ENTRIES = 20;
