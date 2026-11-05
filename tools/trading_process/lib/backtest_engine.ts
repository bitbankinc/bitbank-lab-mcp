import type { Candle, DrawdownPoint, EquityPoint, Trade } from '../types.js';
import { calculateEquityAndDrawdown, type OpenPosition } from './equity.js';
import type { Overlay, Signal, Strategy, StrategyConfig } from './strategies/types.js';

export interface BacktestEngineInput {
	pair: string;
	timeframe: string;
	period: string;
	strategy: StrategyConfig;
	fee_bp: number;
	execution: 't+1_open';
	/** 取得範囲（ウォームアップ含む）の開始。評価範囲の開始は evaluation_start。 */
	effective_start: string;
	effective_end: string;
	effective_bars: number;
}

export interface BacktestEngineSummary {
	total_pnl_pct: number;
	trade_count: number;
	win_rate: number;
	/** 0以上。最大ドローダウン[%] */
	max_drawdown_pct: number;
	/** 起点はウォームアップ終了直後の t+1 open、終点は最終バーの close（ウォームアップ区間の値動きは含めない）。 */
	buy_hold_pnl_pct: number;
	excess_return_pct: number;
	profit_factor: number | null;
	sharpe_ratio: number | null;
	avg_pnl_pct: number;
	evaluation_start: string;
	evaluation_end: string;
	/** evaluation_bars + warmup_bars === effective_bars が成り立つ。 */
	evaluation_bars: number;
	/** = strategy.computeRequiredBars(params)。取得範囲の先頭から数えたインデックスに等しい。 */
	warmup_bars: number;
}

export interface BacktestEngineResult {
	input: BacktestEngineInput;
	summary: BacktestEngineSummary;
	trades: Trade[];
	equity_curve: EquityPoint[];
	drawdown_curve: DrawdownPoint[];
	overlays: Overlay[];
}

/** 末尾で未決済のロングは trades に含めず open_position で返す。 */
export interface ExecuteTradesResult {
	trades: Trade[];
	open_position: OpenPosition | null;
}

// i = warmupBars のシグナルが最初に実行可能（B&H の t+1 open 起点と整合）。
export function executeTradesFromSignals(
	candles: Candle[],
	signals: Signal[],
	fee_bp: number,
	warmupBars: number = 0,
): ExecuteTradesResult {
	const trades: Trade[] = [];
	let position: 'none' | 'long' = 'none';
	let entryTime = '';
	let entryPrice = 0;

	for (let i = 0; i < signals.length - 1; i++) {
		if (i < warmupBars) continue;

		const signal = signals[i];
		const nextCandle = candles[i + 1];

		if (!nextCandle) continue;

		// t+1 open で執行
		const execPrice = nextCandle.open;
		const execTime = nextCandle.time;

		if (position === 'none' && signal.action === 'buy') {
			position = 'long';
			entryTime = execTime;
			entryPrice = execPrice;
		}
		// エグジット
		else if (position === 'long' && signal.action === 'sell') {
			// 往復手数料は厳密な (1 - f)^2 ではなく 1 - 2f の線形近似（誤差は f^2 オーダーで無視できる）。
			const feeMultiplier = 1 - (fee_bp / 10000) * 2;

			const grossReturn = execPrice / entryPrice;

			const netReturn = grossReturn * feeMultiplier;

			const pnlPct = (netReturn - 1) * 100;
			const feePct = (1 - feeMultiplier) * 100;

			// 丸めない生値を保持する（複利計算で微小利益が潰れないよう、丸めは呼び出し側で行う）。
			trades.push({
				entry_time: entryTime,
				entry_price: entryPrice,
				exit_time: execTime,
				exit_price: execPrice,
				pnl_pct: pnlPct,
				fee_pct: feePct,
				net_return: netReturn,
			});

			position = 'none';
		}
	}

	// 片道手数料乗数。確定トレードの feeMultiplier = 1 - 2f を対称分解した entry 側に相当する。
	const entryFeeMultiplier = 1 - fee_bp / 10000;
	const open_position: OpenPosition | null =
		position === 'long'
			? {
					entry_time: entryTime,
					entry_price: entryPrice,
					entry_fee_multiplier: entryFeeMultiplier,
				}
			: null;

	return { trades, open_position };
}

function calcProfitFactor(trades: Trade[]): number | null {
	let grossProfit = 0;
	let grossLoss = 0;
	for (const t of trades) {
		if (t.pnl_pct > 0) grossProfit += t.pnl_pct;
		else if (t.pnl_pct < 0) grossLoss += Math.abs(t.pnl_pct);
	}
	if (grossLoss === 0) return grossProfit > 0 ? null : null; // 全勝 or トレードなし
	return Number((grossProfit / grossLoss).toFixed(2));
}

// 暗号資産は 24/365 稼働なので、1 年のバー数は日数 × 1 日あたりのバー数。
const DAYS_PER_YEAR = 365;
const BARS_PER_YEAR: Record<string, number> = {
	'1D': DAYS_PER_YEAR,
	'4H': DAYS_PER_YEAR * 6,
	'1H': DAYS_PER_YEAR * 24,
};

// 未知の timeframe は 365（日次相当）に倒す。
function calcSharpeRatio(equityCurve: EquityPoint[], timeframe: string): number | null {
	if (equityCurve.length < 2) return null;

	const barReturns: number[] = [];
	for (let i = 1; i < equityCurve.length; i++) {
		const prevEq = 1 + equityCurve[i - 1].equity_pct / 100;
		const currEq = 1 + equityCurve[i].equity_pct / 100;
		if (prevEq > 0) {
			barReturns.push(currEq / prevEq - 1);
		}
	}
	if (barReturns.length < 2) return null;

	const mean = barReturns.reduce((a, b) => a + b, 0) / barReturns.length;
	const variance = barReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (barReturns.length - 1);
	const stdev = Math.sqrt(variance);
	if (stdev === 0) return null;

	const barsPerYear = BARS_PER_YEAR[timeframe] ?? DAYS_PER_YEAR;
	const sharpe = (mean / stdev) * Math.sqrt(barsPerYear);
	return Number(sharpe.toFixed(2));
}

export function calculateSummary(
	trades: Trade[],
	maxDrawdown: number,
	candles: Candle[],
	equityCurve: EquityPoint[],
	timeframe: string,
	tradableStartIdx: number = 0,
): BacktestEngineSummary {
	let buyHoldPnlPct = 0;
	const startIdx = tradableStartIdx + 1;
	if (candles.length >= 2 && startIdx < candles.length) {
		const startPrice = candles[startIdx].open;
		const lastClose = candles[candles.length - 1].close;
		if (startPrice > 0) {
			buyHoldPnlPct = ((lastClose - startPrice) / startPrice) * 100;
		}
	}

	const lastIdx = candles.length > 0 ? candles.length - 1 : 0;
	const clampedStartIdx = candles.length === 0 ? 0 : Math.min(Math.max(tradableStartIdx, 0), lastIdx);
	const evaluationStart = candles.length > 0 ? candles[clampedStartIdx].time : '';
	const evaluationEnd = candles.length > 0 ? candles[lastIdx].time : '';
	const evaluationBars = candles.length > 0 ? candles.length - clampedStartIdx : 0;
	const warmupBars = clampedStartIdx;

	// 総損益は equity_curve の最終値（末尾未決済の含み損益も反映）。確定トレードだけなら Π(net_return) - 1 と一致する。
	const totalPnlPct = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity_pct : 0;
	const excessReturn = totalPnlPct - buyHoldPnlPct;

	// trade-level メトリクスは確定トレードのみを対象とする（未決済は含めない）。
	const wins = trades.filter((t) => t.pnl_pct > 0).length;
	const winRate = trades.length > 0 ? wins / trades.length : 0;
	const avgPnl = trades.length > 0 ? trades.reduce((s, t) => s + t.pnl_pct, 0) / trades.length : 0;

	// Sharpe はウォームアップを除いた評価範囲のバーリターンで算出する（取引できない区間の 0 リターンを混ぜない）。
	const evaluationEquityCurve = equityCurve.slice(clampedStartIdx);

	return {
		total_pnl_pct: Number(totalPnlPct.toFixed(2)),
		trade_count: trades.length,
		win_rate: Number(winRate.toFixed(4)),
		max_drawdown_pct: Number(maxDrawdown.toFixed(2)),
		buy_hold_pnl_pct: Number(buyHoldPnlPct.toFixed(2)),
		excess_return_pct: Number(excessReturn.toFixed(2)),
		profit_factor: calcProfitFactor(trades),
		sharpe_ratio: calcSharpeRatio(evaluationEquityCurve, timeframe),
		avg_pnl_pct: Number(avgPnl.toFixed(2)),
		evaluation_start: evaluationStart,
		evaluation_end: evaluationEnd,
		evaluation_bars: evaluationBars,
		warmup_bars: warmupBars,
	};
}

export function runBacktestEngine(
	candles: Candle[],
	strategy: Strategy,
	input: BacktestEngineInput,
): BacktestEngineResult {
	const params = { ...strategy.defaultParams, ...input.strategy.params };

	// ウォームアップ区間（評価対象外）。トレード執行・B&H 起点・メタ情報で共通利用する。
	const tradableStartIdx = strategy.computeRequiredBars(params);

	const signals = strategy.generate(candles, params);

	const { trades, open_position } = executeTradesFromSignals(candles, signals, input.fee_bp, tradableStartIdx);

	const { equity_curve, drawdown_curve, max_drawdown } = calculateEquityAndDrawdown(trades, candles, open_position);

	const summary = calculateSummary(trades, max_drawdown, candles, equity_curve, input.timeframe, tradableStartIdx);

	const overlays = strategy.getOverlays(candles, params);

	return {
		input,
		summary,
		trades,
		equity_curve,
		drawdown_curve,
		overlays,
	};
}
