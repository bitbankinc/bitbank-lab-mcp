/**
 * lib/backtest_engine.ts - 汎用バックテストエンジン
 *
 * シグナルからトレードを生成し、エクイティ・ドローダウンを計算
 */

import type { Candle, DrawdownPoint, EquityPoint, Trade } from '../types.js';
import { calculateEquityAndDrawdown, type OpenPosition } from './equity.js';
import type { Overlay, Signal, Strategy, StrategyConfig } from './strategies/types.js';

/**
 * バックテスト入力
 */
export interface BacktestEngineInput {
	pair: string;
	timeframe: string;
	period: string;
	strategy: StrategyConfig;
	fee_bp: number;
	execution: 't+1_open';
	/**
	 * 取得範囲の開始 ISO 時刻（ウォームアップ含む。実際に fetch できた最初のバー）。
	 * 評価範囲は `BacktestEngineSummary.evaluation_start` を参照。
	 */
	effective_start: string;
	/**
	 * 取得範囲の終了 ISO 時刻（実際に fetch できた最後のバー）。
	 * 評価範囲の終端と一致するのが通常。
	 */
	effective_end: string;
	/**
	 * 取得範囲のバー本数（ウォームアップ含む。`effective_start` ~ `effective_end` の本数）。
	 * 評価範囲のバー本数は `BacktestEngineSummary.evaluation_bars` を参照。
	 */
	effective_bars: number;
}

/**
 * バックテストサマリー
 */
export interface BacktestEngineSummary {
	/** 複利計算による総損益[%] */
	total_pnl_pct: number;
	trade_count: number;
	win_rate: number;
	/** 0以上。最大ドローダウン[%] */
	max_drawdown_pct: number;
	/**
	 * Buy & Hold との比較。
	 * 戦略がトレード可能になる最初のバー（ウォームアップ終了直後）の **t+1 open** を起点、
	 * 最終バーの close を終点として計算する。ウォームアップ区間の値動きは含めない。
	 */
	buy_hold_pnl_pct: number;
	/** 超過リターン（戦略 - Buy&Hold） */
	excess_return_pct: number;
	/** Profit Factor: 総利益 / 総損失（損失がない場合 null） */
	profit_factor: number | null;
	/** 年率換算 Sharpe Ratio（timeframe のバーリターンベース） */
	sharpe_ratio: number | null;
	/** 1トレードあたり平均損益[%] */
	avg_pnl_pct: number;
	/**
	 * 評価範囲の開始 ISO 時刻（ウォームアップ終了直後＝戦略が最初にトレード可能になるバーの時刻）。
	 * `BacktestEngineInput.effective_start` は「取得範囲」の起点（ウォームアップ含む）であり、
	 * 本フィールドの「評価範囲」とは役割が異なる。
	 */
	evaluation_start: string;
	/**
	 * 評価範囲の終了 ISO 時刻（最終バーの時刻。通常 `effective_end` と一致）。
	 */
	evaluation_end: string;
	/**
	 * 評価範囲のバー本数（`evaluation_start` ~ `evaluation_end` の本数）。
	 * `evaluation_bars + warmup_bars === effective_bars` の関係が成立する。
	 */
	evaluation_bars: number;
	/**
	 * ウォームアップとして評価範囲から除外されたバー本数（= `strategy.computeRequiredBars(params)`）。
	 * 取得範囲の先頭から数えたインデックスに等しい。
	 */
	warmup_bars: number;
}

/**
 * バックテスト結果
 */
export interface BacktestEngineResult {
	input: BacktestEngineInput;
	summary: BacktestEngineSummary;
	trades: Trade[];
	equity_curve: EquityPoint[];
	drawdown_curve: DrawdownPoint[];
	overlays: Overlay[];
}

/**
 * `executeTradesFromSignals` の戻り値。
 * 末尾で未決済のロングポジションは `trades` には含まれず `open_position` で返る。
 */
export interface ExecuteTradesResult {
	trades: Trade[];
	open_position: OpenPosition | null;
}

/**
 * シグナル配列からトレードを実行
 *
 * @param candles ローソク足データ
 * @param signals シグナル配列
 * @param fee_bp 片道手数料（basis points）
 * @param warmupBars ウォームアップとして除外するバー本数。`i < warmupBars` のシグナルはスキップする。
 *   `i = warmupBars` のシグナルは最初に実行可能（B&H の t+1 open 起点と整合）。
 * @returns 確定トレード配列と、ループ終了時点の未決済ポジション
 */
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

		// エントリー
		if (position === 'none' && signal.action === 'buy') {
			position = 'long';
			entryTime = execTime;
			entryPrice = execPrice;
		}
		// エグジット
		else if (position === 'long' && signal.action === 'sell') {
			// 往復手数料率（乗数）。
			// 片道手数料率を f としたとき、厳密には往復後の乗数は (1 - f)^2 だが、
			// ここでは 1 - 2f の線形近似を採用している。誤差は f^2 オーダー
			// （fee_bp=12 で約 0.000144%）で実用上無視でき、単純さを優先する。
			const feeMultiplier = 1 - (fee_bp / 10000) * 2;

			// グロスリターン乗数
			const grossReturn = execPrice / entryPrice;

			// ネットリターン乗数（手数料控除後）
			const netReturn = grossReturn * feeMultiplier;

			// 表示用パーセント
			const pnlPct = (netReturn - 1) * 100;
			const feePct = (1 - feeMultiplier) * 100;

			// 丸めなしの生値を保持する。表示用の丸めは呼び出し側で行う
			// （複利計算で `confirmedEquity *= net_return` する際に微小利益が
			// 潰れるのを防ぐ）。
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

/**
 * Profit Factor を計算
 * 総利益 / 総損失（abs）。損失がゼロの場合 null。
 */
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

/**
 * timeframe → 1 年あたりのバー数
 * 暗号資産は 24/365 稼働のため、日数 × 1 日あたりのバー数。
 */
const DAYS_PER_YEAR = 365;
const BARS_PER_YEAR: Record<string, number> = {
	'1D': DAYS_PER_YEAR,
	'4H': DAYS_PER_YEAR * 6,
	'1H': DAYS_PER_YEAR * 24,
};

/**
 * 年率換算 Sharpe Ratio をエクイティカーブから計算
 * Sharpe = mean(bar_return) / stdev(bar_return) * sqrt(barsPerYear)
 *
 * timeframe に応じた年率換算係数を使う。未知の timeframe は 365（日次相当）を fallback とする。
 */
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

/**
 * サマリー統計を計算（複利）
 *
 * @param tradableStartIdx 戦略がトレード可能になる最初のインデックス（ウォームアップ本数）。
 *   B&H の起点は `candles[tradableStartIdx + 1].open`（t+1 open 約定と整合）。
 *   省略時は 0（=ウォームアップなし。B&H 起点は `candles[1].open`）。
 */
export function calculateSummary(
	trades: Trade[],
	maxDrawdown: number,
	candles: Candle[],
	equityCurve: EquityPoint[],
	timeframe: string,
	tradableStartIdx: number = 0,
): BacktestEngineSummary {
	// Buy & Hold は tradable 区間で算出する。
	// 起点: candles[tradableStartIdx + 1].open（戦略が最初に約定し得る t+1 open）
	// 終点: candles[last].close（常時保有なので最終バー close で OK）
	let buyHoldPnlPct = 0;
	const startIdx = tradableStartIdx + 1;
	if (candles.length >= 2 && startIdx < candles.length) {
		const startPrice = candles[startIdx].open;
		const lastClose = candles[candles.length - 1].close;
		if (startPrice > 0) {
			buyHoldPnlPct = ((lastClose - startPrice) / startPrice) * 100;
		}
	}

	// 評価範囲メタ情報
	const lastIdx = candles.length > 0 ? candles.length - 1 : 0;
	const clampedStartIdx = candles.length === 0 ? 0 : Math.min(Math.max(tradableStartIdx, 0), lastIdx);
	const evaluationStart = candles.length > 0 ? candles[clampedStartIdx].time : '';
	const evaluationEnd = candles.length > 0 ? candles[lastIdx].time : '';
	const evaluationBars = candles.length > 0 ? candles.length - clampedStartIdx : 0;
	const warmupBars = clampedStartIdx;

	// 総損益は equity_curve 最終値ベース（末尾未決済ポジションの含み損益も反映）。
	// 確定トレードのみの場合は equity.ts の confirmedEquity 更新が net_return の積算と等価のため
	// 旧式 Π(net_return) - 1 と数学的に一致する。
	const totalPnlPct = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity_pct : 0;
	const excessReturn = totalPnlPct - buyHoldPnlPct;

	// trade-level メトリクスは確定トレードのみを対象とする（未決済は含めない）。
	const wins = trades.filter((t) => t.pnl_pct > 0).length;
	const winRate = trades.length > 0 ? wins / trades.length : 0;
	const avgPnl = trades.length > 0 ? trades.reduce((s, t) => s + t.pnl_pct, 0) / trades.length : 0;

	// Sharpe は評価範囲（ウォームアップ除外）のバーリターンで算出する。
	// warmup 区間は equity_pct=0 が連続するため、含めると stdev が小さく評価され
	// Sharpe が過大評価される。
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

/**
 * バックテストを実行
 *
 * @param candles ローソク足データ
 * @param strategy 戦略オブジェクト
 * @param input バックテスト入力パラメータ
 * @returns バックテスト結果
 */
export function runBacktestEngine(
	candles: Candle[],
	strategy: Strategy,
	input: BacktestEngineInput,
): BacktestEngineResult {
	const params = { ...strategy.defaultParams, ...input.strategy.params };

	// ウォームアップ区間（評価対象外）。トレード執行・B&H 起点・メタ情報で共通利用する。
	const tradableStartIdx = strategy.computeRequiredBars(params);

	// 1. シグナル生成
	const signals = strategy.generate(candles, params);

	// 2. トレード実行（ウォームアップ区間のシグナルは除外）
	const { trades, open_position } = executeTradesFromSignals(candles, signals, input.fee_bp, tradableStartIdx);

	// 3. エクイティ・ドローダウン計算（末尾未決済ポジションは含み損益で延長）
	const { equity_curve, drawdown_curve, max_drawdown } = calculateEquityAndDrawdown(trades, candles, open_position);

	// 4. サマリー計算
	const summary = calculateSummary(trades, max_drawdown, candles, equity_curve, input.timeframe, tradableStartIdx);

	// 5. オーバーレイデータ取得
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
