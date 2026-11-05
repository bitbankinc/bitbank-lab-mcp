export type Timeframe = '1D' | '1H' | '4H';
export type Period = '1M' | '3M' | '6M' | '1Y' | '2Y' | '3Y';

// absolute の start / end は JST の 0:00 / 23:59:59.999 として解釈する（bitbank の日足が JST 区切りのため）。
export type BacktestRange = { type: 'period'; value: Period } | { type: 'absolute'; start: string; end: string };

export interface BacktestInput {
	pair: string;
	timeframe: Timeframe;
	period: Period;
	sma_short: number;
	sma_long: number;
	fee_bp: number;
	execution: 't+1_open';
}

export interface Candle {
	time: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume?: number;
}

export interface Trade {
	entry_time: string;
	entry_price: number;
	exit_time: string;
	exit_price: number;
	/** 丸めなしの生値。表示時は呼び出し側で丸める。 */
	pnl_pct: number;
	fee_pct: number;
	/** equity *= net_return で複利計算する乗数（丸めなし）。 */
	net_return: number;
}

export interface EquityPoint {
	time: string;
	/** 含み損益込みの累積損益[%]。 */
	equity_pct: number;
	/** 確定損益[%]。トレード決済時のみ更新される */
	confirmed_pct: number;
}

export interface DrawdownPoint {
	time: string;
	/** 0以上。ピークからの下落幅[%]。例: 18.31 (表示時に -18.31% とする) */
	drawdown_pct: number;
}

export interface BacktestSummary {
	total_pnl_pct: number;
	trade_count: number;
	win_rate: number;
	/** 0以上。最大ドローダウン[%]。表示時に -XX% とする */
	max_drawdown_pct: number;
}

export interface BacktestResult {
	input: BacktestInput;
	summary: BacktestSummary;
	trades: Trade[];
	equity_curve: EquityPoint[];
	drawdown_curve: DrawdownPoint[];
}

export interface BacktestChartData {
	candles: Candle[];
	smaShort: number[];
	smaLong: number[];
	trades: Trade[];
	equity_curve: EquityPoint[];
	drawdown_curve: DrawdownPoint[];
	input: BacktestInput;
	summary?: BacktestSummary;
}
