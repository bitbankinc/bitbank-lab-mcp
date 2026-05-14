import { describe, expect, it } from 'vitest';
import {
	calculateSummary,
	executeTradesFromSignals,
	runBacktestEngine,
} from '../../../tools/trading_process/lib/backtest_engine.js';
import type { Signal } from '../../../tools/trading_process/lib/strategies/types.js';
import type { Candle, Trade } from '../../../tools/trading_process/types.js';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------
function makeCandles(count: number, basePrice: number = 100): Candle[] {
	return Array.from({ length: count }, (_, i) => ({
		time: `2024-01-${String(i + 1).padStart(2, '0')}`,
		open: basePrice + i,
		high: basePrice + i + 5,
		low: basePrice + i - 5,
		close: basePrice + i + 1,
	}));
}

// ---------------------------------------------------------------------------
// executeTradesFromSignals
// ---------------------------------------------------------------------------
describe('executeTradesFromSignals', () => {
	it('空のシグナルはトレードなし', () => {
		const candles = makeCandles(10);
		expect(executeTradesFromSignals(candles, [], 0)).toEqual([]);
	});

	it('buy → sell の1トレードを生成する', () => {
		const candles = makeCandles(10);
		const signals: Signal[] = [
			{ action: 'buy', reason: '', time: '' },
			{ action: 'hold', reason: '', time: '' },
			{ action: 'sell', reason: '', time: '' },
			...Array.from({ length: 7 }, () => ({ action: 'hold' as const, reason: '', time: '' })),
		];
		const trades = executeTradesFromSignals(candles, signals, 0);
		expect(trades).toHaveLength(1);
		expect(trades[0].entry_price).toBe(candles[1].open); // t+1 open で執行
		expect(trades[0].exit_price).toBe(candles[3].open);
	});

	it('手数料が正しく反映される', () => {
		const candles: Candle[] = [
			{ time: 't0', open: 100, high: 110, low: 90, close: 100 },
			{ time: 't1', open: 100, high: 110, low: 90, close: 105 },
			{ time: 't2', open: 100, high: 110, low: 90, close: 100 },
			{ time: 't3', open: 100, high: 110, low: 90, close: 100 },
		];
		const signals: Signal[] = [
			{ action: 'buy', reason: '', time: '' },
			{ action: 'hold', reason: '', time: '' },
			{ action: 'sell', reason: '', time: '' },
			{ action: 'hold', reason: '', time: '' },
		];
		// 同じ価格で売買 → 手数料分だけマイナス
		const trades = executeTradesFromSignals(candles, signals, 10); // 10bp = 0.1%
		expect(trades).toHaveLength(1);
		expect(trades[0].fee_pct).toBeGreaterThan(0);
		expect(trades[0].pnl_pct).toBeLessThan(0); // 手数料分マイナス
	});

	it('buy が連続しても2回目は無視される', () => {
		const candles = makeCandles(10);
		const signals: Signal[] = [
			{ action: 'buy', reason: '', time: '' },
			{ action: 'buy', reason: '', time: '' }, // ポジション保有中 → 無視
			{ action: 'sell', reason: '', time: '' },
			...Array.from({ length: 7 }, () => ({ action: 'hold' as const, reason: '', time: '' })),
		];
		const trades = executeTradesFromSignals(candles, signals, 0);
		expect(trades).toHaveLength(1);
	});

	it('sell が先に来ても無視される', () => {
		const candles = makeCandles(5);
		const signals: Signal[] = [
			{ action: 'sell', reason: '', time: '' }, // ポジションなし → 無視
			{ action: 'buy', reason: '', time: '' },
			{ action: 'sell', reason: '', time: '' },
			{ action: 'hold', reason: '', time: '' },
			{ action: 'hold', reason: '', time: '' },
		];
		const trades = executeTradesFromSignals(candles, signals, 0);
		expect(trades).toHaveLength(1);
	});

	it('未決済ポジションはトレードに含まれない', () => {
		const candles = makeCandles(5);
		const signals: Signal[] = [
			{ action: 'buy', reason: '', time: '' },
			{ action: 'hold', reason: '', time: '' },
			{ action: 'hold', reason: '', time: '' },
			{ action: 'hold', reason: '', time: '' },
			{ action: 'hold', reason: '', time: '' },
		];
		const trades = executeTradesFromSignals(candles, signals, 0);
		expect(trades).toHaveLength(0);
	});

	it('複数トレードを生成する', () => {
		const candles = makeCandles(10);
		const signals: Signal[] = [
			{ action: 'buy', reason: '', time: '' },
			{ action: 'sell', reason: '', time: '' },
			{ action: 'buy', reason: '', time: '' },
			{ action: 'sell', reason: '', time: '' },
			...Array.from({ length: 6 }, () => ({ action: 'hold' as const, reason: '', time: '' })),
		];
		const trades = executeTradesFromSignals(candles, signals, 0);
		expect(trades).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// calculateSummary
// ---------------------------------------------------------------------------
describe('calculateSummary', () => {
	it('トレードなしの場合のサマリー', () => {
		const candles = makeCandles(10);
		const equityCurve = candles.map((c) => ({
			time: c.time,
			equity_pct: 0,
			confirmed_pct: 0,
		}));
		const summary = calculateSummary([], 0, candles, equityCurve, '1D');
		expect(summary.trade_count).toBe(0);
		expect(summary.total_pnl_pct).toBe(0);
		expect(summary.win_rate).toBe(0);
		expect(summary.profit_factor).toBeNull();
	});

	it('Buy&Hold 損益を計算する', () => {
		const candles: Candle[] = [
			{ time: 't0', open: 100, high: 110, low: 90, close: 100 },
			{ time: 't1', open: 105, high: 115, low: 95, close: 200 },
		];
		const equityCurve = candles.map((c) => ({
			time: c.time,
			equity_pct: 0,
			confirmed_pct: 0,
		}));
		const summary = calculateSummary([], 0, candles, equityCurve, '1D');
		expect(summary.buy_hold_pnl_pct).toBe(100); // (200-100)/100 * 100
	});

	it('勝ちトレードで正しいサマリーを計算', () => {
		const candles = makeCandles(10);
		const trades: Trade[] = [
			{
				entry_time: 't1',
				entry_price: 100,
				exit_time: 't2',
				exit_price: 110,
				pnl_pct: 10,
				fee_pct: 0,
				net_return: 1.1,
			},
		];
		const equityCurve = candles.map((c) => ({
			time: c.time,
			equity_pct: 0,
			confirmed_pct: 0,
		}));
		const summary = calculateSummary(trades, 5, candles, equityCurve, '1D');
		expect(summary.trade_count).toBe(1);
		expect(summary.win_rate).toBe(1);
		expect(summary.total_pnl_pct).toBe(10);
		expect(summary.max_drawdown_pct).toBe(5);
	});

	it('複利で総損益を計算する', () => {
		const candles = makeCandles(10);
		const trades: Trade[] = [
			{
				entry_time: 't1',
				entry_price: 100,
				exit_time: 't2',
				exit_price: 110,
				pnl_pct: 10,
				fee_pct: 0,
				net_return: 1.1,
			},
			{
				entry_time: 't3',
				entry_price: 100,
				exit_time: 't4',
				exit_price: 110,
				pnl_pct: 10,
				fee_pct: 0,
				net_return: 1.1,
			},
		];
		const equityCurve = candles.map((c) => ({
			time: c.time,
			equity_pct: 0,
			confirmed_pct: 0,
		}));
		const summary = calculateSummary(trades, 0, candles, equityCurve, '1D');
		// 複利: 1.1 * 1.1 = 1.21 → 21%
		expect(summary.total_pnl_pct).toBe(21);
	});

	it('profit_factor を計算する', () => {
		const candles = makeCandles(10);
		const trades: Trade[] = [
			{
				entry_time: 't1',
				entry_price: 100,
				exit_time: 't2',
				exit_price: 110,
				pnl_pct: 10,
				fee_pct: 0,
				net_return: 1.1,
			},
			{
				entry_time: 't3',
				entry_price: 110,
				exit_time: 't4',
				exit_price: 105,
				pnl_pct: -5,
				fee_pct: 0,
				net_return: 0.9545,
			},
		];
		const equityCurve = candles.map((c) => ({
			time: c.time,
			equity_pct: 0,
			confirmed_pct: 0,
		}));
		const summary = calculateSummary(trades, 0, candles, equityCurve, '1D');
		expect(summary.profit_factor).toBe(2); // 10 / 5 = 2
		expect(summary.win_rate).toBe(0.5);
	});
});

// ---------------------------------------------------------------------------
// sharpe_ratio の timeframe 年率換算
// ---------------------------------------------------------------------------
describe('calculateSummary - sharpe_ratio timeframe annualization', () => {
	// 単調変動するエクイティカーブ（stdev > 0 を担保）
	function makeEquityCurve(length: number) {
		return Array.from({ length }, (_, i) => ({
			time: `t${i}`,
			equity_pct: i % 2 === 0 ? i * 0.1 : i * 0.1 - 0.05,
			confirmed_pct: 0,
		}));
	}

	const candles = makeCandles(50);
	const equityCurve = makeEquityCurve(50);

	it('1D / 4H / 1H で Sharpe の値が変わる（同一 equity curve）', () => {
		const s1D = calculateSummary([], 0, candles, equityCurve, '1D').sharpe_ratio;
		const s4H = calculateSummary([], 0, candles, equityCurve, '4H').sharpe_ratio;
		const s1H = calculateSummary([], 0, candles, equityCurve, '1H').sharpe_ratio;

		expect(s1D).not.toBeNull();
		expect(s4H).not.toBeNull();
		expect(s1H).not.toBeNull();
		// 短い足ほど barsPerYear が増えるので |Sharpe| は大きくなる
		expect(Math.abs(s4H as number)).toBeGreaterThan(Math.abs(s1D as number));
		expect(Math.abs(s1H as number)).toBeGreaterThan(Math.abs(s4H as number));
	});

	it('1H は 1D の sqrt(24) ≈ 4.9 倍にスケールする', () => {
		const s1D = calculateSummary([], 0, candles, equityCurve, '1D').sharpe_ratio as number;
		const s1H = calculateSummary([], 0, candles, equityCurve, '1H').sharpe_ratio as number;
		const ratio = s1H / s1D;
		expect(ratio).toBeCloseTo(Math.sqrt(24), 1);
	});

	it('4H は 1D の sqrt(6) ≈ 2.45 倍にスケールする', () => {
		const s1D = calculateSummary([], 0, candles, equityCurve, '1D').sharpe_ratio as number;
		const s4H = calculateSummary([], 0, candles, equityCurve, '4H').sharpe_ratio as number;
		const ratio = s4H / s1D;
		expect(ratio).toBeCloseTo(Math.sqrt(6), 1);
	});

	it('未知 timeframe は 365（1D 相当）にフォールバックする', () => {
		const s1D = calculateSummary([], 0, candles, equityCurve, '1D').sharpe_ratio;
		const sUnknown = calculateSummary([], 0, candles, equityCurve, 'UNKNOWN_TF').sharpe_ratio;
		expect(sUnknown).toBe(s1D);
	});
});

// ---------------------------------------------------------------------------
// runBacktestEngine
// ---------------------------------------------------------------------------
describe('runBacktestEngine', () => {
	it('全パイプラインを通してバックテスト結果を返す', () => {
		const candles = makeCandles(20);
		const mockStrategy = {
			name: 'test',
			type: 'sma_cross' as const,
			requiredBars: 5,
			defaultParams: { short: 3, long: 5 },
			computeRequiredBars: () => 5,
			generate: (_c: Candle[], _p: Record<string, number>): Signal[] => {
				return Array.from({ length: 20 }, (_, i) => {
					if (i === 2) return { action: 'buy' as const, reason: 'test', time: '' };
					if (i === 5) return { action: 'sell' as const, reason: 'test', time: '' };
					return { action: 'hold' as const, reason: '', time: '' };
				});
			},
			getOverlays: () => [],
		};
		const input = {
			pair: 'btc_jpy',
			timeframe: '1D',
			period: '1M',
			strategy: { type: 'sma_cross' as const, params: {} },
			fee_bp: 0,
			execution: 't+1_open' as const,
		};
		const result = runBacktestEngine(candles, mockStrategy, input);
		expect(result.trades.length).toBeGreaterThanOrEqual(1);
		expect(result.equity_curve).toHaveLength(20);
		expect(result.drawdown_curve).toHaveLength(20);
		expect(result.summary).toBeDefined();
		expect(result.summary.trade_count).toBeGreaterThanOrEqual(1);
	});
});
