import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../../../lib/datetime.js';

vi.mock('../../../../lib/indicators.js', () => ({
	macd: vi.fn(),
}));
vi.mock('../../../../tools/trading_process/lib/sma.js', () => ({
	calculateSMA: vi.fn(),
}));
vi.mock('../../../../tools/trading_process/lib/strategies/rsi.js', () => ({
	calculateRSI: vi.fn(),
	rsiStrategy: {},
	validateParams: vi.fn(),
}));

import { macd as mockedMacd } from '../../../../lib/indicators.js';
import { calculateSMA as mockedCalculateSMA } from '../../../../tools/trading_process/lib/sma.js';
import { macdCrossStrategy, validateParams } from '../../../../tools/trading_process/lib/strategies/macd_cross.js';
import { calculateRSI as mockedCalculateRSI } from '../../../../tools/trading_process/lib/strategies/rsi.js';
import type { Candle } from '../../../../tools/trading_process/types.js';

afterEach(() => {
	vi.resetAllMocks();
});

function zeros(n: number): number[] {
	return Array.from({ length: n }, () => 0);
}

function makeCandles(n: number, close = 100): Candle[] {
	const base = dayjs('2024-01-01');
	return Array.from({ length: n }, (_, i) => ({
		time: base.add(i, 'day').format('YYYY-MM-DD'),
		open: close,
		high: close + 1,
		low: close - 1,
		close,
	}));
}

describe('validateParams', () => {
	it('デフォルトパラメータで通過', () => {
		const result = validateParams({});
		expect(result.valid).toBe(true);
		expect(result.normalizedParams.fast).toBe(12);
		expect(result.normalizedParams.slow).toBe(26);
		expect(result.normalizedParams.signal).toBe(9);
	});

	it('fast >= slow でエラー', () => {
		const result = validateParams({ fast: 26, slow: 26 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('fast period must be less than slow period');
	});

	it('fast < 2 でエラー', () => {
		const result = validateParams({ fast: 1 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('fast period must be at least 2');
	});

	it('signal < 2 でエラー', () => {
		const result = validateParams({ signal: 1 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('signal period must be at least 2');
	});

	it('sma_filter_period < 0 でエラー', () => {
		const result = validateParams({ sma_filter_period: -1 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('sma_filter_period must be >= 0');
	});

	it('zero_line_filter が不正値でエラー', () => {
		const result = validateParams({ zero_line_filter: 2 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('zero_line_filter must be -1, 0, or 1');
	});

	it('rsi_filter_max 範囲外でエラー', () => {
		const result = validateParams({ rsi_filter_max: 101 });
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('rsi_filter_max must be 0-100');
	});

	it('有効なパラメータ（フィルターあり）で通過', () => {
		const result = validateParams({
			fast: 5,
			slow: 10,
			signal: 3,
			sma_filter_period: 0,
			zero_line_filter: 1,
			rsi_filter_period: 14,
			rsi_filter_max: 70,
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});
});

describe('macdCrossStrategy', () => {
	it('name / type / requiredBars が正しい', () => {
		expect(macdCrossStrategy.name).toBe('MACD Crossover');
		expect(macdCrossStrategy.type).toBe('macd_cross');
		expect(macdCrossStrategy.requiredBars).toBe(35);
		expect(macdCrossStrategy.computeRequiredBars({})).toBe(35);
	});

	describe('computeRequiredBars', () => {
		it('slow / signal を増やすと必要バー数が増える', () => {
			expect(macdCrossStrategy.computeRequiredBars({ slow: 100, signal: 20 })).toBe(120);
		});

		it('sma_filter_period が slow + signal より大きいと sma_filter_period - 1 で支配される', () => {
			expect(macdCrossStrategy.computeRequiredBars({ sma_filter_period: 200 })).toBe(199);
		});

		it('rsi_filter_period が支配的なケースは period + 1', () => {
			expect(macdCrossStrategy.computeRequiredBars({ slow: 5, signal: 3, rsi_filter_period: 50 })).toBe(51);
		});
	});

	describe('generate', () => {
		it('シグナル配列の長さがローソク足と一致する', () => {
			const N = 40;
			const candles = makeCandles(N);
			vi.mocked(mockedMacd).mockReturnValue({
				line: zeros(N),
				signal: zeros(N),
				hist: zeros(N),
			});
			const signals = macdCrossStrategy.generate(candles, {});
			expect(signals).toHaveLength(N);
		});

		it('startIdx 未満は hold', () => {
			const N = 40;
			const candles = makeCandles(N);
			vi.mocked(mockedMacd).mockReturnValue({
				line: zeros(N),
				signal: zeros(N),
				hist: zeros(N),
			});
			// default params: fast=12, slow=26, signal=9 → startIdx = slow + signal - 1 = 34
			const signals = macdCrossStrategy.generate(candles, {});
			for (let i = 0; i < 34; i++) {
				expect(signals[i].action).toBe('hold');
			}
		});

		it('startIdx = slow + signal - 1 でクロスが起きた場合に buy シグナルを生成', () => {
			const N = 40;
			const candles = makeCandles(N);
			const line = zeros(N);
			const signal = zeros(N);
			// default params: fast=12, slow=26, signal=9 → startIdx = 34
			// Golden cross at i=34: prev macd <= signal, curr macd > signal
			line[33] = -1;
			signal[33] = 0;
			line[34] = 1;
			signal[34] = 0;
			vi.mocked(mockedMacd).mockReturnValue({ line, signal, hist: zeros(N) });
			const signals = macdCrossStrategy.generate(candles, {});
			expect(signals[34].action).toBe('buy');
			expect(signals[34].reason).toMatch(/Golden Cross/);
		});

		it('ゴールデンクロスで buy シグナルを生成', () => {
			const N = 40;
			const candles = makeCandles(N);
			const line = zeros(N);
			const signal = zeros(N);
			// Golden cross at i=35: prev macd <= signal, curr macd > signal
			line[34] = -1;
			signal[34] = 0;
			line[35] = 1;
			signal[35] = 0;
			vi.mocked(mockedMacd).mockReturnValue({ line, signal, hist: zeros(N) });
			const signals = macdCrossStrategy.generate(candles, {});
			expect(signals[35].action).toBe('buy');
			expect(signals[35].reason).toMatch(/Golden Cross/);
		});

		it('デッドクロスで sell シグナルを生成', () => {
			const N = 40;
			const candles = makeCandles(N);
			const line = zeros(N);
			const signal = zeros(N);
			// Dead cross at i=35: prev macd >= signal, curr macd < signal
			line[34] = 1;
			signal[34] = 0;
			line[35] = -1;
			signal[35] = 0;
			vi.mocked(mockedMacd).mockReturnValue({ line, signal, hist: zeros(N) });
			const signals = macdCrossStrategy.generate(candles, {});
			expect(signals[35].action).toBe('sell');
			expect(signals[35].reason).toMatch(/Dead Cross/);
		});

		it('指標に NaN → hold', () => {
			const N = 40;
			const candles = makeCandles(N);
			const line = zeros(N);
			const signal = zeros(N);
			// NaN at i-1=34 → hold at i=35
			line[34] = Number.NaN;
			vi.mocked(mockedMacd).mockReturnValue({ line, signal, hist: zeros(N) });
			const signals = macdCrossStrategy.generate(candles, {});
			expect(signals[35].action).toBe('hold');
		});

		it('SMA フィルター: 価格 < SMA → エントリー拒否', () => {
			const N = 40;
			const candles = makeCandles(N, 100); // close = 100
			const line = zeros(N);
			const signal = zeros(N);
			// Golden cross at i=35
			line[34] = -1;
			signal[34] = 0;
			line[35] = 1;
			signal[35] = 0;
			vi.mocked(mockedMacd).mockReturnValue({ line, signal, hist: zeros(N) });
			// SMA above close price → filtered
			vi.mocked(mockedCalculateSMA).mockReturnValue(Array.from({ length: N }, () => 200));
			const signals = macdCrossStrategy.generate(candles, { sma_filter_period: 20 });
			expect(signals[35].action).toBe('hold');
		});

		it('zero-line フィルター: MACD < 0 で filter=1 → 拒否', () => {
			const N = 40;
			const candles = makeCandles(N);
			const line = zeros(N);
			const signal = zeros(N);
			// Golden cross at i=35, but MACD is negative
			line[34] = -5;
			signal[34] = -3;
			line[35] = -2;
			signal[35] = -5; // macd(-2) > signal(-5): golden cross, but MACD < 0
			vi.mocked(mockedMacd).mockReturnValue({ line, signal, hist: zeros(N) });
			const signals = macdCrossStrategy.generate(candles, { zero_line_filter: 1 });
			expect(signals[35].action).toBe('hold');
		});

		it('RSI フィルター: RSI >= rsi_filter_max → 拒否', () => {
			const N = 40;
			const candles = makeCandles(N);
			const line = zeros(N);
			const signal = zeros(N);
			// Golden cross at i=35
			line[34] = -1;
			signal[34] = 0;
			line[35] = 1;
			signal[35] = 0;
			vi.mocked(mockedMacd).mockReturnValue({ line, signal, hist: zeros(N) });
			const rsiValues = Array.from({ length: N }, () => 50);
			rsiValues[35] = 80; // RSI(80) >= rsi_filter_max(70) → filtered
			vi.mocked(mockedCalculateRSI).mockReturnValue(rsiValues);
			const signals = macdCrossStrategy.generate(candles, { rsi_filter_period: 14, rsi_filter_max: 70 });
			expect(signals[35].action).toBe('hold');
		});

		it('全てのシグナルに time が含まれる', () => {
			const N = 40;
			const candles = makeCandles(N);
			vi.mocked(mockedMacd).mockReturnValue({
				line: zeros(N),
				signal: zeros(N),
				hist: zeros(N),
			});
			const signals = macdCrossStrategy.generate(candles, {});
			for (const s of signals) {
				expect(s.time).toBeDefined();
			}
		});
	});

	describe('getOverlays', () => {
		it('フィルターなしで 3 つの overlay を返す', () => {
			const N = 30;
			const candles = makeCandles(N);
			vi.mocked(mockedMacd).mockReturnValue({
				line: zeros(N),
				signal: zeros(N),
				hist: zeros(N),
			});
			const overlays = macdCrossStrategy.getOverlays(candles, {});
			expect(overlays).toHaveLength(3);
			expect(overlays[0].type).toBe('line');
			expect(overlays[1].type).toBe('line');
			expect(overlays[2].type).toBe('histogram');
		});

		it('MACD overlay の名前に fast/slow period が含まれる', () => {
			const N = 30;
			const candles = makeCandles(N);
			vi.mocked(mockedMacd).mockReturnValue({
				line: zeros(N),
				signal: zeros(N),
				hist: zeros(N),
			});
			const overlays = macdCrossStrategy.getOverlays(candles, { fast: 5, slow: 10, signal: 3 });
			expect(overlays[0].name).toBe('MACD(5,10)');
			expect(overlays[1].name).toBe('Signal(3)');
		});

		it('sma_filter_period > 0 で SMA overlay が追加され 4 つになる', () => {
			const N = 30;
			const candles = makeCandles(N);
			vi.mocked(mockedMacd).mockReturnValue({
				line: zeros(N),
				signal: zeros(N),
				hist: zeros(N),
			});
			vi.mocked(mockedCalculateSMA).mockReturnValue(Array.from({ length: N }, () => 100));
			const overlays = macdCrossStrategy.getOverlays(candles, { sma_filter_period: 20 });
			expect(overlays).toHaveLength(4);
			const smaOverlay = overlays[3] as { panel?: string; name: string };
			expect(smaOverlay.panel).toBe('price');
			expect(smaOverlay.name).toMatch(/SMA20.*filter/);
		});

		it('rsi_filter 有効時は RSI overlay が indicator パネルに追加される', () => {
			const N = 30;
			const candles = makeCandles(N);
			vi.mocked(mockedMacd).mockReturnValue({
				line: zeros(N),
				signal: zeros(N),
				hist: zeros(N),
			});
			vi.mocked(mockedCalculateRSI).mockReturnValue(Array.from({ length: N }, () => 50));
			const overlays = macdCrossStrategy.getOverlays(candles, { rsi_filter_period: 14, rsi_filter_max: 70 });
			expect(overlays).toHaveLength(4);
			const rsiOverlay = overlays[3] as { panel?: string; name: string };
			expect(rsiOverlay.panel).toBe('indicator');
			expect(rsiOverlay.name).toMatch(/RSI\(14\)/);
		});

		it('rsi_filter_max = 100 の場合は RSI overlay が追加されない', () => {
			const N = 30;
			const candles = makeCandles(N);
			vi.mocked(mockedMacd).mockReturnValue({
				line: zeros(N),
				signal: zeros(N),
				hist: zeros(N),
			});
			const overlays = macdCrossStrategy.getOverlays(candles, { rsi_filter_period: 14, rsi_filter_max: 100 });
			expect(overlays).toHaveLength(3);
		});
	});
});
