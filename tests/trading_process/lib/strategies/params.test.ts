import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateParams as validateBb } from '../../../../tools/trading_process/lib/strategies/bb_breakout.js';
import { validateParams as validateMacd } from '../../../../tools/trading_process/lib/strategies/macd_cross.js';
import { validateParams as validateRsi } from '../../../../tools/trading_process/lib/strategies/rsi.js';
import { validateParams as validateSma } from '../../../../tools/trading_process/lib/strategies/sma_cross.js';
import runBacktest from '../../../../tools/trading_process/run_backtest.js';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('戦略パラメータの未知キー（issue 443）', () => {
	it('sma_cross に short_period / long_period を渡すとエラーになり、既定値で実行されない', () => {
		const result = validateSma({ short_period: 10, long_period: 50 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"unknown param 'short_period' (allowed: short, long, sma_filter_period, rsi_filter_period, rsi_filter_max)",
		);
		expect(result.errors.some((e) => e.startsWith("unknown param 'long_period'"))).toBe(true);
	});

	it.each([
		['rsi', validateRsi, { length: 14 }],
		['macd_cross', validateMacd, { fast_period: 12 }],
		['bb_breakout', validateBb, { std: 2 }],
	] as const)('%s の未知キーはエラー', (_name, validate, params) => {
		const result = validate(params);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.startsWith(`unknown param '${Object.keys(params)[0]}'`))).toBe(true);
	});

	it('既知キーだけなら通る', () => {
		expect(validateSma({ short: 10, long: 50, sma_filter_period: 200 }).valid).toBe(true);
		expect(validateRsi({ period: 10, overbought: 75, oversold: 25 }).valid).toBe(true);
		expect(validateMacd({ fast: 8, slow: 21, signal: 5, zero_line_filter: -1 }).valid).toBe(true);
		expect(validateBb({ period: 30, stddev: 2.5 }).valid).toBe(true);
	});
});

describe('期間系パラメータの非整数（issue 443）', () => {
	it.each([
		['sma_cross', validateSma, 'short', 5.5],
		['sma_cross', validateSma, 'long', 20.5],
		['sma_cross', validateSma, 'sma_filter_period', 200.5],
		['sma_cross', validateSma, 'rsi_filter_period', 14.5],
		['rsi', validateRsi, 'period', 14.5],
		['macd_cross', validateMacd, 'fast', 12.5],
		['macd_cross', validateMacd, 'slow', 26.5],
		['macd_cross', validateMacd, 'signal', 9.5],
		['macd_cross', validateMacd, 'sma_filter_period', 50.5],
		['macd_cross', validateMacd, 'rsi_filter_period', 14.5],
		['bb_breakout', validateBb, 'period', 20.5],
	] as const)('%s の %s = %s はエラー', (_name, validate, key, value) => {
		const result = validate({ [key]: value });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(`${key} must be an integer`);
	});

	it('閾値・倍率系は小数を許す', () => {
		expect(validateRsi({ overbought: 72.5, oversold: 27.5 }).valid).toBe(true);
		expect(validateBb({ stddev: 2.5 }).valid).toBe(true);
		expect(validateSma({ rsi_filter_period: 14, rsi_filter_max: 65.5 }).valid).toBe(true);
		expect(validateMacd({ rsi_filter_period: 14, rsi_filter_max: 65.5 }).valid).toBe(true);
	});
});

describe('run_backtest の入口（issue 443）', () => {
	it('未知キーは fetch 前にエラーで返り、既定値の結果を返さない', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const res = await runBacktest({
			pair: 'btc_jpy',
			strategy: { type: 'sma_cross', params: { short_period: 10, long_period: 50 } },
		});
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error).toContain('Invalid strategy params for sma_cross');
		expect(res.error).toContain("unknown param 'short_period'");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('非整数の期間は fetch 前にエラーで返る', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const res = await runBacktest({ pair: 'btc_jpy', strategy: { type: 'rsi', params: { period: 14.5 } } });
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error).toContain('period must be an integer');
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
