import { describe, expect, it } from 'vitest';
import { dayjs } from '../../../../lib/datetime.js';
import { rsi } from '../../../../lib/indicators.js';
import { executeTradesFromSignals } from '../../../../tools/trading_process/lib/backtest_engine.js';
import { calculateEquityAndDrawdown } from '../../../../tools/trading_process/lib/equity.js';
import { macdCrossStrategy } from '../../../../tools/trading_process/lib/strategies/macd_cross.js';
import { rsiStrategy } from '../../../../tools/trading_process/lib/strategies/rsi.js';
import { smaCrossStrategy } from '../../../../tools/trading_process/lib/strategies/sma_cross.js';
import type { Strategy } from '../../../../tools/trading_process/lib/strategies/types.js';
import { emaConvergenceBars, wilderConvergenceBars } from '../../../../tools/trading_process/lib/strategies/warmup.js';
import type { Candle } from '../../../../tools/trading_process/types.js';

function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

function randomWalk(n: number, seed: number): Candle[] {
	const rand = lcg(seed);
	let price = 100;
	const out: Candle[] = [];
	for (let i = 0; i < n; i++) {
		const u1 = Math.max(rand(), 1e-12);
		const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rand());
		const open = price;
		price *= Math.exp(0.03 * z);
		out.push({
			time: dayjs.utc('2020-01-01').add(i, 'day').toISOString(),
			open,
			high: Math.max(open, price),
			low: Math.min(open, price),
			close: price,
		});
	}
	return out;
}

const EVAL_BARS = 90;
const FEE_BP = 12;

function finalPnlPct(candles: Candle[], strategy: Strategy, params: Record<string, number>, evalStart: number) {
	const signals = strategy.generate(candles, params);
	const { trades, open_position } = executeTradesFromSignals(candles, signals, FEE_BP, evalStart);
	const { equity_curve } = calculateEquityAndDrawdown(trades, candles, open_position);
	return equity_curve[equity_curve.length - 1].equity_pct;
}

// 評価区間の 90 本は同じまま、その前の履歴を「全部」と「ウォームアップぶんだけ」にして比べる。
function countDiverging(strategy: Strategy, params: Record<string, number>, seed: number) {
	const all = randomWalk(600, seed);
	const warmup = strategy.computeRequiredBars(params);
	let diverging = 0;
	for (let end = 560; end <= 600; end++) {
		const evalStart = end - EVAL_BARS;
		const full = finalPnlPct(all.slice(0, end), strategy, params, evalStart);
		const minimal = finalPnlPct(all.slice(evalStart - warmup, end), strategy, params, warmup);
		if (Math.abs(full - minimal) > 1e-9) diverging++;
	}
	return diverging;
}

describe('ウォームアップの本数（issue 442）', () => {
	it('Wilder 平滑と EMA の初期値の重みが 0.1% を切る本数', () => {
		expect(wilderConvergenceBars(14)).toBe(94);
		expect(emaConvergenceBars(26)).toBe(90);
		expect(emaConvergenceBars(9)).toBe(31);
	});

	it('rsi は period + 1 + 収束本数、macd_cross は slow + signal + それぞれの収束本数', () => {
		expect(rsiStrategy.computeRequiredBars({})).toBe(14 + 1 + 94);
		expect(macdCrossStrategy.computeRequiredBars({})).toBe(26 + 9 + 90 + 31);
	});

	it('sma_cross の RSI フィルタも Wilder 平滑の収束を待つ', () => {
		expect(smaCrossStrategy.computeRequiredBars({ short: 3, long: 5, rsi_filter_period: 14 })).toBe(14 + 1 + 94 + 10);
	});

	it.each([
		1, 2, 3, 4, 5,
	])('seed %i: rsi と macd_cross の評価区間の損益が、それより前の履歴の長さで変わらない', (seed) => {
		expect(countDiverging(rsiStrategy, {}, seed)).toBe(0);
		expect(countDiverging(macdCrossStrategy, {}, seed)).toBe(0);
	});

	it.each([1, 2, 3])('seed %i: RSI フィルタ付きの sma_cross / macd_cross も変わらない', (seed) => {
		const filter = { rsi_filter_period: 14, rsi_filter_max: 60 };
		expect(countDiverging(smaCrossStrategy, filter, seed)).toBe(0);
		expect(countDiverging(macdCrossStrategy, filter, seed)).toBe(0);
	});

	it('評価開始時点の RSI(14) が、全履歴で計算した値と 0.1 pt 以内で一致する', () => {
		const all = randomWalk(600, 1);
		const warmup = rsiStrategy.computeRequiredBars({});
		const evalStart = 600 - EVAL_BARS;
		const full = rsi(
			all.map((c) => c.close),
			14,
		)[evalStart];
		const minimal = rsi(
			all.slice(evalStart - warmup).map((c) => c.close),
			14,
		)[warmup];
		expect(Math.abs(full - minimal)).toBeLessThan(0.1);
	});
});
