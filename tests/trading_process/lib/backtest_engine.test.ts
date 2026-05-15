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
		const result = executeTradesFromSignals(candles, [], 0);
		expect(result.trades).toEqual([]);
		expect(result.open_position).toBeNull();
	});

	it('buy → sell の1トレードを生成する', () => {
		const candles = makeCandles(10);
		const signals: Signal[] = [
			{ action: 'buy', reason: '', time: '' },
			{ action: 'hold', reason: '', time: '' },
			{ action: 'sell', reason: '', time: '' },
			...Array.from({ length: 7 }, () => ({ action: 'hold' as const, reason: '', time: '' })),
		];
		const { trades, open_position } = executeTradesFromSignals(candles, signals, 0);
		expect(trades).toHaveLength(1);
		expect(trades[0].entry_price).toBe(candles[1].open); // t+1 open で執行
		expect(trades[0].exit_price).toBe(candles[3].open);
		expect(open_position).toBeNull();
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
		const { trades } = executeTradesFromSignals(candles, signals, 10); // 10bp = 0.1%
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
		const { trades } = executeTradesFromSignals(candles, signals, 0);
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
		const { trades } = executeTradesFromSignals(candles, signals, 0);
		expect(trades).toHaveLength(1);
	});

	it('未決済ポジションは trades には含まれず open_position として返る', () => {
		const candles = makeCandles(5);
		const signals: Signal[] = [
			{ action: 'buy', reason: '', time: '' },
			{ action: 'hold', reason: '', time: '' },
			{ action: 'hold', reason: '', time: '' },
			{ action: 'hold', reason: '', time: '' },
			{ action: 'hold', reason: '', time: '' },
		];
		const result = executeTradesFromSignals(candles, signals, 0);
		expect(result.trades).toHaveLength(0);
		expect(result.open_position).not.toBeNull();
		expect(result.open_position?.entry_time).toBe(candles[1].time); // t+1
		expect(result.open_position?.entry_price).toBe(candles[1].open);
	});

	it('buy → sell → buy の最後の buy が未決済の場合 open_position に入る', () => {
		const candles = makeCandles(6);
		const signals: Signal[] = [
			{ action: 'buy', reason: '', time: '' },
			{ action: 'sell', reason: '', time: '' },
			{ action: 'buy', reason: '', time: '' },
			{ action: 'hold', reason: '', time: '' },
			{ action: 'hold', reason: '', time: '' },
			{ action: 'hold', reason: '', time: '' },
		];
		const result = executeTradesFromSignals(candles, signals, 0);
		expect(result.trades).toHaveLength(1);
		expect(result.open_position).not.toBeNull();
		// 2回目の buy は i=2、執行は t+1 = candles[3]
		expect(result.open_position?.entry_time).toBe(candles[3].time);
		expect(result.open_position?.entry_price).toBe(candles[3].open);
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
		const { trades } = executeTradesFromSignals(candles, signals, 0);
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

	it('Buy&Hold 損益を計算する（tradable 区間の t+1 open 起点）', () => {
		const candles: Candle[] = [
			{ time: 't0', open: 50, high: 60, low: 40, close: 50 }, // ウォームアップ
			{ time: 't1', open: 100, high: 110, low: 90, close: 120 }, // tradableStartIdx
			{ time: 't2', open: 110, high: 120, low: 100, close: 150 }, // t+1 = B&H 起点 (open=110)
			{ time: 't3', open: 140, high: 160, low: 130, close: 220 }, // 終点 close=220
		];
		const equityCurve = candles.map((c) => ({
			time: c.time,
			equity_pct: 0,
			confirmed_pct: 0,
		}));
		const summary = calculateSummary([], 0, candles, equityCurve, '1D', 1);
		// 起点: candles[2].open = 110、終点: candles[3].close = 220 → (220-110)/110*100 = 100%
		expect(summary.buy_hold_pnl_pct).toBe(100);
	});

	it('ウォームアップ中だけ価格が動き、tradable 区間がフラットなら B&H ≒ 0%', () => {
		const candles: Candle[] = [
			// ウォームアップ中に +100%
			{ time: 't0', open: 50, high: 60, low: 40, close: 50 },
			{ time: 't1', open: 100, high: 110, low: 90, close: 100 }, // tradableStartIdx
			// tradable 区間はフラット（t+1 open = 100, last close = 100）
			{ time: 't2', open: 100, high: 100, low: 100, close: 100 },
			{ time: 't3', open: 100, high: 100, low: 100, close: 100 },
		];
		const equityCurve = candles.map((c) => ({
			time: c.time,
			equity_pct: 0,
			confirmed_pct: 0,
		}));
		const summary = calculateSummary([], 0, candles, equityCurve, '1D', 1);
		expect(summary.buy_hold_pnl_pct).toBe(0);
	});

	it('ウォームアップ中フラット・tradable 区間で +50% なら B&H = 50%', () => {
		const candles: Candle[] = [
			// ウォームアップフラット
			{ time: 't0', open: 100, high: 100, low: 100, close: 100 },
			{ time: 't1', open: 100, high: 100, low: 100, close: 100 }, // tradableStartIdx
			// tradable 区間で +50%（t+1 open = 100 → last close = 150）
			{ time: 't2', open: 100, high: 160, low: 90, close: 140 },
			{ time: 't3', open: 140, high: 160, low: 130, close: 150 },
		];
		const equityCurve = candles.map((c) => ({
			time: c.time,
			equity_pct: 0,
			confirmed_pct: 0,
		}));
		const summary = calculateSummary([], 0, candles, equityCurve, '1D', 1);
		expect(summary.buy_hold_pnl_pct).toBe(50);
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
		// total_pnl_pct は equity_curve 最終値ベース。決済後 +10% を反映。
		const equityCurve = candles.map((c) => ({
			time: c.time,
			equity_pct: 10,
			confirmed_pct: 10,
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
		// total_pnl_pct は equity_curve 最終値ベース。1.1 * 1.1 = 1.21 → 21%
		const equityCurve = candles.map((c) => ({
			time: c.time,
			equity_pct: 21,
			confirmed_pct: 21,
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
// calculateSummary - evaluation_* / warmup_bars メタ情報
// ---------------------------------------------------------------------------
describe('calculateSummary - evaluation metadata', () => {
	it('evaluation_start / end / bars / warmup_bars が tradableStartIdx に応じて返される', () => {
		const candles = makeCandles(10); // t0 .. t9
		const equityCurve = candles.map((c) => ({
			time: c.time,
			equity_pct: 0,
			confirmed_pct: 0,
		}));
		const summary = calculateSummary([], 0, candles, equityCurve, '1D', 3);
		expect(summary.evaluation_start).toBe(candles[3].time);
		expect(summary.evaluation_end).toBe(candles[9].time);
		expect(summary.evaluation_bars).toBe(7); // 10 - 3
		expect(summary.warmup_bars).toBe(3);
	});

	it('evaluation_bars + warmup_bars === effective_bars (= candles.length)', () => {
		const candles = makeCandles(25);
		const equityCurve = candles.map((c) => ({
			time: c.time,
			equity_pct: 0,
			confirmed_pct: 0,
		}));
		for (const warmup of [0, 1, 5, 14, 24]) {
			const summary = calculateSummary([], 0, candles, equityCurve, '1D', warmup);
			expect(summary.evaluation_bars + summary.warmup_bars).toBe(candles.length);
		}
	});

	it('warmup_bars === strategy.computeRequiredBars(params)', () => {
		const candles = makeCandles(30);
		const mockStrategy = {
			name: 'test',
			type: 'sma_cross' as const,
			requiredBars: 7,
			defaultParams: { short: 3, long: 7 },
			computeRequiredBars: (_p: Record<string, number>) => 7,
			generate: (_c: Candle[], _p: Record<string, number>): Signal[] =>
				Array.from({ length: 30 }, () => ({ action: 'hold' as const, reason: '', time: '' })),
			getOverlays: () => [],
		};
		const params = { ...mockStrategy.defaultParams };
		const input = {
			pair: 'btc_jpy',
			timeframe: '1D',
			period: '1M',
			strategy: { type: 'sma_cross' as const, params: {} },
			fee_bp: 0,
			execution: 't+1_open' as const,
			effective_start: candles[0].time,
			effective_end: candles[candles.length - 1].time,
			effective_bars: candles.length,
		};
		const result = runBacktestEngine(candles, mockStrategy, input);
		expect(result.summary.warmup_bars).toBe(mockStrategy.computeRequiredBars(params));
	});

	it('tradableStartIdx = 0 のとき evaluation_start === effective_start かつ warmup_bars === 0', () => {
		const candles = makeCandles(12);
		const equityCurve = candles.map((c) => ({
			time: c.time,
			equity_pct: 0,
			confirmed_pct: 0,
		}));
		const summary = calculateSummary([], 0, candles, equityCurve, '1D', 0);
		expect(summary.warmup_bars).toBe(0);
		expect(summary.evaluation_start).toBe(candles[0].time); // = effective_start
		expect(summary.evaluation_bars).toBe(candles.length);
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
				// ウォームアップ後（i >= 5）にシグナルを配置
				return Array.from({ length: 20 }, (_, i) => {
					if (i === 10) return { action: 'buy' as const, reason: 'test', time: '' };
					if (i === 15) return { action: 'sell' as const, reason: 'test', time: '' };
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

// ---------------------------------------------------------------------------
// executeTradesFromSignals - warmupBars 引数（回帰防止）
// ---------------------------------------------------------------------------
describe('executeTradesFromSignals - warmupBars', () => {
	it('warmupBars=5 で signals[2]=buy, signals[4]=sell は除外され trades=[] になる', () => {
		const candles = makeCandles(10);
		const signals: Signal[] = Array.from({ length: 10 }, () => ({
			action: 'hold' as const,
			reason: '',
			time: '',
		}));
		signals[2] = { action: 'buy', reason: '', time: '' };
		signals[4] = { action: 'sell', reason: '', time: '' };
		const { trades } = executeTradesFromSignals(candles, signals, 0, 5);
		expect(trades).toEqual([]);
	});

	it('warmupBars=5 で signals[5]=buy, signals[7]=sell は 1 トレード生成される', () => {
		const candles = makeCandles(10);
		const signals: Signal[] = Array.from({ length: 10 }, () => ({
			action: 'hold' as const,
			reason: '',
			time: '',
		}));
		signals[5] = { action: 'buy', reason: '', time: '' };
		signals[7] = { action: 'sell', reason: '', time: '' };
		const { trades } = executeTradesFromSignals(candles, signals, 0, 5);
		expect(trades).toHaveLength(1);
		expect(trades[0].entry_price).toBe(candles[6].open); // t+1 open
		expect(trades[0].exit_price).toBe(candles[8].open);
	});

	it('warmupBars=0（デフォルト）では全 index で執行される', () => {
		const candles = makeCandles(10);
		const signals: Signal[] = Array.from({ length: 10 }, () => ({
			action: 'hold' as const,
			reason: '',
			time: '',
		}));
		signals[2] = { action: 'buy', reason: '', time: '' };
		signals[4] = { action: 'sell', reason: '', time: '' };
		const { trades } = executeTradesFromSignals(candles, signals, 0);
		expect(trades).toHaveLength(1);
		expect(trades[0].entry_price).toBe(candles[3].open);
		expect(trades[0].exit_price).toBe(candles[5].open);
	});

	it('境界値: i = warmupBars ちょうどの buy が許容される', () => {
		const candles = makeCandles(10);
		const signals: Signal[] = Array.from({ length: 10 }, () => ({
			action: 'hold' as const,
			reason: '',
			time: '',
		}));
		signals[5] = { action: 'buy', reason: '', time: '' };
		signals[7] = { action: 'sell', reason: '', time: '' };
		const { trades } = executeTradesFromSignals(candles, signals, 0, 5);
		expect(trades).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// runBacktestEngine - warmup 区間のシグナルがトレードに含まれない（回帰防止）
// ---------------------------------------------------------------------------
describe('runBacktestEngine - warmup boundary', () => {
	it('ウォームアップ区間内 (i<5) のシグナルは除外され、ウォームアップ後 (i>=5) のみトレードになる', () => {
		const candles = makeCandles(20);
		const mockStrategy = {
			name: 'test',
			type: 'sma_cross' as const,
			requiredBars: 5,
			defaultParams: { short: 3, long: 5 },
			computeRequiredBars: () => 5,
			generate: (_c: Candle[], _p: Record<string, number>): Signal[] => {
				return Array.from({ length: 20 }, (_, i) => {
					// ウォームアップ区間: 除外されるべき
					if (i === 2) return { action: 'buy' as const, reason: 'warmup-buy', time: '' };
					if (i === 4) return { action: 'sell' as const, reason: 'warmup-sell', time: '' };
					// ウォームアップ後: 含まれるべき
					if (i === 6) return { action: 'buy' as const, reason: 'real-buy', time: '' };
					if (i === 8) return { action: 'sell' as const, reason: 'real-sell', time: '' };
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
		expect(result.summary.trade_count).toBe(1);
		expect(result.summary.warmup_bars).toBe(5);
		// trades は i=6 buy / i=8 sell のもののみ
		expect(result.trades).toHaveLength(1);
		expect(result.trades[0].entry_price).toBe(candles[7].open); // t+1 open
		expect(result.trades[0].exit_price).toBe(candles[9].open);
	});

	it('境界値: computeRequiredBars=5 で signals[5]=buy, signals[7]=sell は 1 トレード生成される', () => {
		const candles = makeCandles(20);
		const mockStrategy = {
			name: 'test',
			type: 'sma_cross' as const,
			requiredBars: 5,
			defaultParams: { short: 3, long: 5 },
			computeRequiredBars: () => 5,
			generate: (_c: Candle[], _p: Record<string, number>): Signal[] => {
				return Array.from({ length: 20 }, (_, i) => {
					if (i === 5) return { action: 'buy' as const, reason: 'boundary-buy', time: '' };
					if (i === 7) return { action: 'sell' as const, reason: 'boundary-sell', time: '' };
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
		expect(result.trades).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// runBacktestEngine - 末尾未決済ポジションの含み損益反映（回帰防止）
// ---------------------------------------------------------------------------
describe('runBacktestEngine - open position carry forward', () => {
	it('未決済ポジションが equity_pct / total_pnl_pct に反映される', () => {
		// computeRequiredBars=2 → warmup=2、i=2 で buy → entry は candles[3]
		// candles[3].open=100, 最終 candles[7].close=200 → 含み益 +100%
		const candles: Candle[] = [
			{ time: 't0', open: 90, high: 95, low: 85, close: 90 },
			{ time: 't1', open: 95, high: 100, low: 90, close: 95 },
			{ time: 't2', open: 100, high: 105, low: 95, close: 100 },
			{ time: 't3', open: 100, high: 105, low: 95, close: 100 }, // entry at t+1 open=100
			{ time: 't4', open: 120, high: 130, low: 110, close: 120 },
			{ time: 't5', open: 150, high: 160, low: 140, close: 150 },
			{ time: 't6', open: 180, high: 200, low: 170, close: 180 },
			{ time: 't7', open: 190, high: 210, low: 180, close: 200 }, // last close=200
		];
		const mockStrategy = {
			name: 'test',
			type: 'sma_cross' as const,
			requiredBars: 2,
			defaultParams: {},
			computeRequiredBars: () => 2,
			generate: (_c: Candle[], _p: Record<string, number>): Signal[] => {
				return Array.from({ length: 8 }, (_, i) => {
					if (i === 2) return { action: 'buy' as const, reason: 'test', time: '' };
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
		// 未決済ポジションは trades に含まれない（契約維持）
		expect(result.trades).toHaveLength(0);
		expect(result.summary.trade_count).toBe(0);
		// equity_pct[last] / total_pnl_pct は +100% を反映
		expect(result.equity_curve[result.equity_curve.length - 1].equity_pct).toBeCloseTo(100, 1);
		expect(result.summary.total_pnl_pct).toBeCloseTo(100, 1);
	});

	it('未決済ポジションが max_drawdown に反映される', () => {
		// entry at t3 open=100, ピーク t4 close=200、その後 t5 close=150 → 25% DD
		const candles: Candle[] = [
			{ time: 't0', open: 90, high: 95, low: 85, close: 90 },
			{ time: 't1', open: 95, high: 100, low: 90, close: 95 },
			{ time: 't2', open: 100, high: 105, low: 95, close: 100 },
			{ time: 't3', open: 100, high: 105, low: 95, close: 100 }, // entry at t+1 open=100
			{ time: 't4', open: 150, high: 210, low: 140, close: 200 }, // peak equity = 2.0
			{ time: 't5', open: 175, high: 180, low: 140, close: 150 }, // equity = 1.5 → DD = 25%
		];
		const mockStrategy = {
			name: 'test',
			type: 'sma_cross' as const,
			requiredBars: 2,
			defaultParams: {},
			computeRequiredBars: () => 2,
			generate: (_c: Candle[], _p: Record<string, number>): Signal[] => {
				return Array.from({ length: 6 }, (_, i) => {
					if (i === 2) return { action: 'buy' as const, reason: 'test', time: '' };
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
		// (2.0 - 1.5) / 2.0 * 100 = 25%
		expect(result.summary.max_drawdown_pct).toBeCloseTo(25, 1);
	});
});
