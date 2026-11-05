import { describe, expect, it } from 'vitest';
import { calculateEquityAndDrawdown } from '../../../tools/trading_process/lib/equity.js';
import type { Candle, Trade } from '../../../tools/trading_process/types.js';

function makeCandles(times: string[], closes: number[]): Candle[] {
	return times.map((time, i) => ({
		time,
		open: closes[i],
		high: closes[i] + 5,
		low: closes[i] - 5,
		close: closes[i],
	}));
}

describe('calculateEquityAndDrawdown', () => {
	it('トレードなしの場合はエクイティ0%、ドローダウン0%', () => {
		const candles = makeCandles(['t0', 't1', 't2'], [100, 105, 110]);
		const result = calculateEquityAndDrawdown([], candles);
		expect(result.equity_curve).toHaveLength(3);
		expect(result.drawdown_curve).toHaveLength(3);
		expect(result.max_drawdown).toBe(0);
		for (const e of result.equity_curve) {
			expect(e.equity_pct).toBe(0);
		}
		for (const d of result.drawdown_curve) {
			expect(d.drawdown_pct).toBe(0);
		}
	});

	it('1トレード（利益）でエクイティが増加する', () => {
		const candles = makeCandles(['t0', 't1', 't2', 't3'], [100, 100, 110, 110]);
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
		const result = calculateEquityAndDrawdown(trades, candles);
		// t2 で決済 → 確定エクイティ = 1.0 * 1.1 = 1.1 → 10%
		expect(result.equity_curve[2].equity_pct).toBeCloseTo(10, 1);
		// t3 以降はポジションなし → 確定エクイティを維持
		expect(result.equity_curve[3].equity_pct).toBeCloseTo(10, 1);
	});

	it('1トレード（損失）でエクイティが減少する', () => {
		const candles = makeCandles(['t0', 't1', 't2', 't3'], [100, 100, 90, 90]);
		const trades: Trade[] = [
			{
				entry_time: 't1',
				entry_price: 100,
				exit_time: 't2',
				exit_price: 90,
				pnl_pct: -10,
				fee_pct: 0,
				net_return: 0.9,
			},
		];
		const result = calculateEquityAndDrawdown(trades, candles);
		expect(result.equity_curve[2].equity_pct).toBeCloseTo(-10, 1);
		expect(result.max_drawdown).toBeGreaterThan(0);
	});

	it('ポジション保有中は含み損益を反映する', () => {
		const candles = makeCandles(['t0', 't1', 't2', 't3', 't4'], [100, 100, 120, 110, 110]);
		const trades: Trade[] = [
			{
				entry_time: 't1',
				entry_price: 100,
				exit_time: 't3',
				exit_price: 110,
				pnl_pct: 10,
				fee_pct: 0,
				net_return: 1.1,
			},
		];
		const result = calculateEquityAndDrawdown(trades, candles);
		// t2: 含み益 = (120/100 - 1) * 100 = 20%
		expect(result.equity_curve[2].equity_pct).toBeCloseTo(20, 1);
		// t3: 決済時 → net_return で確定 = 10%
		expect(result.equity_curve[3].equity_pct).toBeCloseTo(10, 1);
	});

	it('ドローダウンが正しく計算される', () => {
		const candles = makeCandles(['t0', 't1', 't2', 't3'], [100, 100, 120, 90]);
		const trades: Trade[] = [
			{
				entry_time: 't1',
				entry_price: 100,
				exit_time: 't3',
				exit_price: 90,
				pnl_pct: -10,
				fee_pct: 0,
				net_return: 0.9,
			},
		];
		const result = calculateEquityAndDrawdown(trades, candles);
		// t2 で含みピーク、t3 で下落 → ドローダウン > 0
		expect(result.max_drawdown).toBeGreaterThan(0);
		for (const d of result.drawdown_curve) {
			expect(d.drawdown_pct).toBeGreaterThanOrEqual(0);
		}
	});

	it('複数トレードで複利計算が正しい', () => {
		const candles = makeCandles(['t0', 't1', 't2', 't3', 't4', 't5'], [100, 100, 110, 110, 121, 121]);
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
				exit_price: 121,
				pnl_pct: 10,
				fee_pct: 0,
				net_return: 1.1,
			},
		];
		const result = calculateEquityAndDrawdown(trades, candles);
		// 1.1 * 1.1 = 1.21 → 21%
		expect(result.equity_curve[4].equity_pct).toBeCloseTo(21, 1);
	});
});

describe('calculateEquityAndDrawdown - openPosition', () => {
	it('openPosition を渡すと entry_time 以降が含み損益で延長される', () => {
		const candles = makeCandles(['t0', 't1', 't2', 't3'], [100, 100, 150, 200]);
		const openPosition = { entry_time: 't1', entry_price: 100, entry_fee_multiplier: 1.0 };
		const result = calculateEquityAndDrawdown([], candles, openPosition);
		// t0: ポジションなし → 0、t1: entry at close=100 → 0、t2: close=150 → equity = 1.5 → 50、t3: close=200 → equity = 2.0 → 100
		expect(result.equity_curve[0].equity_pct).toBeCloseTo(0, 4);
		expect(result.equity_curve[1].equity_pct).toBeCloseTo(0, 4);
		expect(result.equity_curve[2].equity_pct).toBeCloseTo(50, 4);
		expect(result.equity_curve[3].equity_pct).toBeCloseTo(100, 4);
		// 決済イベントなし → confirmed_pct は全て 0
		for (const e of result.equity_curve) {
			expect(e.confirmed_pct).toBeCloseTo(0, 4);
		}
	});

	it('trades と openPosition の併存（決済後の再エントリー）', () => {
		// t1 entry → t2 exit (net_return=1.1)、その後 t3 で openPosition がエントリー
		const candles = makeCandles(['t0', 't1', 't2', 't3', 't4'], [100, 100, 110, 110, 121]);
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
		const openPosition = { entry_time: 't3', entry_price: 110, entry_fee_multiplier: 1.0 };
		const result = calculateEquityAndDrawdown(trades, candles, openPosition);
		// t2 決済後 confirmed_pct = 10、以降は維持
		expect(result.equity_curve[2].confirmed_pct).toBeCloseTo(10, 4);
		expect(result.equity_curve[3].confirmed_pct).toBeCloseTo(10, 4);
		expect(result.equity_curve[4].confirmed_pct).toBeCloseTo(10, 4);
		// t3 entry (close=110) → equity = 1.1 * (110/110) = 1.1 → equity_pct = 10
		expect(result.equity_curve[3].equity_pct).toBeCloseTo(10, 4);
		// t4 close=121 → equity = 1.1 * (121/110) = 1.21 → equity_pct = 21
		expect(result.equity_curve[4].equity_pct).toBeCloseTo(21, 4);
	});

	it('entry_fee_multiplier < 1 の openPosition で equity_pct に片道手数料が反映される', () => {
		// 価格変化なし。fee_bp=100 (片道 1%) 相当の entry_fee_multiplier=0.99 なので、entry 以降は片道手数料分だけマイナスになる。
		const candles = makeCandles(['t0', 't1', 't2'], [100, 100, 100]);
		const openPosition = { entry_time: 't1', entry_price: 100, entry_fee_multiplier: 0.99 };
		const result = calculateEquityAndDrawdown([], candles, openPosition);
		// t0: ポジションなし → 0、t1: entry at close=100 → entryEquity = 1.0 * 0.99 = 0.99 → -1%、t2: 価格不変 → -1%
		expect(result.equity_curve[0].equity_pct).toBeCloseTo(0, 4);
		expect(result.equity_curve[1].equity_pct).toBeCloseTo(-1, 4);
		expect(result.equity_curve[2].equity_pct).toBeCloseTo(-1, 4);
		for (const e of result.equity_curve) {
			expect(e.confirmed_pct).toBeCloseTo(0, 4);
		}
	});

	it('entry_fee_multiplier = 1.0 は従来挙動（fee なし）と数学的に等価', () => {
		// entry_fee_multiplier=1.0 のとき entryEquity への乗算が恒等なので、fee なしの equity_pct と完全一致する。
		const candles = makeCandles(['t0', 't1', 't2', 't3'], [100, 100, 150, 200]);
		const openPosition = { entry_time: 't1', entry_price: 100, entry_fee_multiplier: 1.0 };
		const result = calculateEquityAndDrawdown([], candles, openPosition);
		expect(result.equity_curve[0].equity_pct).toBeCloseTo(0, 4);
		expect(result.equity_curve[1].equity_pct).toBeCloseTo(0, 4);
		expect(result.equity_curve[2].equity_pct).toBeCloseTo(50, 4);
		expect(result.equity_curve[3].equity_pct).toBeCloseTo(100, 4);
	});

	it('trades と openPosition の併存でも entry_fee_multiplier が effective に効く', () => {
		// 1 つの完結トレード (net_return=1.1) で confirmedEquity=1.1、続けて openPosition (entry_fee_multiplier=0.99) が entry → entryEquity = 1.1 * 0.99 = 1.089、その後 close=entry_price なら equity_pct ≈ 8.9%
		const candles = makeCandles(['t0', 't1', 't2', 't3', 't4'], [100, 100, 110, 110, 110]);
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
		const openPosition = { entry_time: 't3', entry_price: 110, entry_fee_multiplier: 0.99 };
		const result = calculateEquityAndDrawdown(trades, candles, openPosition);
		// t2 決済直後 confirmed_pct = 10%（確定）
		expect(result.equity_curve[2].confirmed_pct).toBeCloseTo(10, 4);
		// t3 entry: entryEquity = 1.1 * 0.99 = 1.089、close=110 で含み損益 0 → equity = 1.089 → 8.9%
		expect(result.equity_curve[3].equity_pct).toBeCloseTo(8.9, 4);
		// t4 close=110 で変わらず → equity_pct = 8.9%
		expect(result.equity_curve[4].equity_pct).toBeCloseTo(8.9, 4);
		// confirmed_pct は決済後 10% のまま（openPosition の entry は confirmed を更新しない）
		expect(result.equity_curve[3].confirmed_pct).toBeCloseTo(10, 4);
		expect(result.equity_curve[4].confirmed_pct).toBeCloseTo(10, 4);
	});
});
