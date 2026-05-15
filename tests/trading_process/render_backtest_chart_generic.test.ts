import { describe, expect, it } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import type { BacktestEngineSummary } from '../../tools/trading_process/lib/backtest_engine.js';
import type { Overlay } from '../../tools/trading_process/lib/strategies/types.js';
import {
	type GenericBacktestChartData,
	renderBacktestChartGeneric,
} from '../../tools/trading_process/render_backtest_chart_generic.js';
import type { Candle, DrawdownPoint, EquityPoint, Trade } from '../../tools/trading_process/types.js';

function makeCandles(n: number, startDate = '2024-01-01', closeStart = 100): Candle[] {
	const base = dayjs(startDate);
	return Array.from({ length: n }, (_, i) => ({
		time: base.add(i, 'day').format('YYYY-MM-DD'),
		open: closeStart + i,
		high: closeStart + i + 1,
		low: closeStart + i - 1,
		close: closeStart + i,
	}));
}

function makeSummary(overrides: Partial<BacktestEngineSummary> = {}): BacktestEngineSummary {
	return {
		total_pnl_pct: 5.0,
		trade_count: 3,
		win_rate: 0.67,
		max_drawdown_pct: 2.5,
		buy_hold_pnl_pct: 3.0,
		excess_return_pct: 2.0,
		profit_factor: 1.5,
		sharpe_ratio: 0.8,
		avg_pnl_pct: 1.67,
		evaluation_start: '2024-01-01',
		evaluation_end: '2024-01-10',
		evaluation_bars: 10,
		warmup_bars: 0,
		...overrides,
	};
}

function makeChartData(overrides: Partial<GenericBacktestChartData> = {}): GenericBacktestChartData {
	const candles = makeCandles(10);
	const equity_curve: EquityPoint[] = candles.map((c, i) => ({
		time: c.time,
		equity_pct: i * 0.5,
		confirmed_pct: i * 0.3,
	}));
	const drawdown_curve: DrawdownPoint[] = candles.map((c) => ({ time: c.time, drawdown_pct: 0 }));

	return {
		candles,
		overlays: [],
		trades: [],
		equity_curve,
		drawdown_curve,
		input: {
			pair: 'btc_jpy',
			timeframe: '1D',
			period: '1M',
			strategyName: 'Test Strategy',
			strategyParams: { fast: 12, slow: 26 },
			fee_bp: 12,
		},
		summary: makeSummary(),
		...overrides,
	};
}

describe('renderBacktestChartGeneric', () => {
	describe('モード分岐', () => {
		it("chartDetail='default' → minimal SVG (700x350)", () => {
			const data = makeChartData();
			const svg = renderBacktestChartGeneric(data, 'default');
			expect(svg).toContain('<svg');
			expect(svg).toContain('viewBox="0 0 700 350"');
		});

		it("chartDetail='full' → full SVG (1000 wide)", () => {
			const data = makeChartData();
			const svg = renderBacktestChartGeneric(data, 'full');
			expect(svg).toContain('<svg');
			expect(svg).toContain('viewBox="0 0 1000 ');
		});

		it('chartDetail 省略時は full チャート', () => {
			const data = makeChartData();
			const svg = renderBacktestChartGeneric(data);
			expect(svg).toContain('viewBox="0 0 1000 ');
		});
	});

	describe('minimal chart', () => {
		it('SVG 文字列が返る', () => {
			const data = makeChartData();
			const svg = renderBacktestChartGeneric(data, 'default');
			expect(typeof svg).toBe('string');
			expect(svg.length).toBeGreaterThan(0);
			expect(svg).toContain('</svg>');
		});

		it('ストラテジー名がタイトルに含まれる', () => {
			const data = makeChartData();
			const svg = renderBacktestChartGeneric(data, 'default');
			expect(svg).toContain('Test Strategy');
		});

		it('ペア名が含まれる', () => {
			const data = makeChartData();
			const svg = renderBacktestChartGeneric(data, 'default');
			expect(svg).toContain('BTC_JPY');
		});

		it('Equity パネルヘッダーが含まれる', () => {
			const data = makeChartData();
			const svg = renderBacktestChartGeneric(data, 'default');
			expect(svg).toContain('Equity');
		});

		it('Drawdown パネルヘッダーが含まれる', () => {
			const data = makeChartData();
			const svg = renderBacktestChartGeneric(data, 'default');
			expect(svg).toContain('Drawdown');
		});

		it('equity_curve が空でも SVG が返る', () => {
			const data = makeChartData({ equity_curve: [], drawdown_curve: [] });
			const svg = renderBacktestChartGeneric(data, 'default');
			expect(svg).toContain('</svg>');
		});
	});

	describe('full chart', () => {
		it('SVG 文字列が返る', () => {
			const data = makeChartData();
			const svg = renderBacktestChartGeneric(data, 'full');
			expect(typeof svg).toBe('string');
			expect(svg).toContain('</svg>');
		});

		it('ストラテジー名がタイトルに含まれる', () => {
			const data = makeChartData();
			const svg = renderBacktestChartGeneric(data, 'full');
			expect(svg).toContain('Test Strategy');
		});

		it('indicator overlay なしの高さが 810', () => {
			const data = makeChartData({ overlays: [] });
			const svg = renderBacktestChartGeneric(data, 'full');
			expect(svg).toContain('viewBox="0 0 1000 810"');
		});

		it('indicator overlay ありの高さが 1000', () => {
			const indicatorOverlay: Overlay = {
				type: 'line',
				name: 'MACD',
				color: '#22c55e',
				data: makeCandles(10).map(() => 0),
				panel: 'indicator',
			};
			const data = makeChartData({ overlays: [indicatorOverlay] });
			const svg = renderBacktestChartGeneric(data, 'full');
			expect(svg).toContain('viewBox="0 0 1000 1000"');
		});

		it('line overlay が価格チャートに描画される', () => {
			const priceOverlay: Overlay = {
				type: 'line',
				name: 'SMA20',
				color: '#fbbf24',
				data: makeCandles(10).map((c) => c.close),
				panel: 'price',
			};
			const data = makeChartData({ overlays: [priceOverlay] });
			const svg = renderBacktestChartGeneric(data, 'full');
			expect(svg).toContain('SMA20');
		});

		it('band overlay が stroke-dasharray で描画される', () => {
			const bandOverlay: Overlay = {
				type: 'band',
				name: 'BB ±2σ',
				color: '#a78bfa',
				fillColor: 'rgba(167,139,250,0.1)',
				data: {
					upper: makeCandles(10).map((c) => c.close + 5),
					lower: makeCandles(10).map((c) => c.close - 5),
				},
				panel: 'price',
			};
			const data = makeChartData({ overlays: [bandOverlay] });
			const svg = renderBacktestChartGeneric(data, 'full');
			expect(svg).toContain('stroke-dasharray="3,3"');
		});

		it('histogram overlay が indicator パネルに rect 要素で描画される', () => {
			const histOverlay: Overlay = {
				type: 'histogram',
				name: 'Histogram',
				positiveColor: 'rgba(34,197,94,0.7)',
				negativeColor: 'rgba(239,68,68,0.7)',
				data: [1, -1, 2, -2, 1, -1, 2, -2, 1, -1],
				panel: 'indicator',
			};
			const data = makeChartData({ overlays: [histOverlay] });
			const svg = renderBacktestChartGeneric(data, 'full');
			expect(svg).toContain('rgba(34,197,94,0.7)');
			expect(svg).toContain('rgba(239,68,68,0.7)');
		});

		it('NaN を含む overlay データはスキップされる', () => {
			const lineWithNaN: Overlay = {
				type: 'line',
				name: 'SMAWithNaN',
				color: '#fbbf24',
				data: [Number.NaN, Number.NaN, 105, 106, 107, 108, 109, 110, 111, 112],
				panel: 'price',
			};
			const data = makeChartData({ overlays: [lineWithNaN] });
			// Should not throw
			const svg = renderBacktestChartGeneric(data, 'full');
			expect(svg).toContain('</svg>');
		});

		it('trade marker が entry/exit ともにレンダリングされる', () => {
			const candles = makeCandles(10);
			const trade: Trade = {
				entry_time: candles[2].time,
				entry_price: candles[2].close,
				exit_time: candles[6].time,
				exit_price: candles[6].close,
				pnl_pct: 2.0,
				fee_pct: 0.1,
				net_return: 1.02,
			};
			const equity_curve: EquityPoint[] = candles.map((c, i) => ({
				time: c.time,
				equity_pct: i * 0.5,
				confirmed_pct: i * 0.3,
			}));
			const drawdown_curve: DrawdownPoint[] = candles.map((c) => ({ time: c.time, drawdown_pct: 0 }));
			const data = makeChartData({ candles, trades: [trade], equity_curve, drawdown_curve });
			const svg = renderBacktestChartGeneric(data, 'full');
			// Entry marker (▲) and exit marker (▼)
			expect(svg).toContain('▲');
			expect(svg).toContain('▼');
		});
	});

	describe('チャート見出しの日付レンジ', () => {
		it('minimal: evaluation_start ~ evaluation_end の YYYY-MM-DD が見出しに含まれる', () => {
			const data = makeChartData({
				input: {
					pair: 'btc_jpy',
					timeframe: '1D',
					period: '3M', // ダミー値: 表示には使われないはず
					strategyName: 'Test Strategy',
					strategyParams: { fast: 12, slow: 26 },
					fee_bp: 12,
				},
				summary: makeSummary({
					evaluation_start: '2025-09-04T00:00:00.000Z',
					evaluation_end: '2026-05-14T00:00:00.000Z',
				}),
			});
			const svg = renderBacktestChartGeneric(data, 'default');
			expect(svg).toContain('2025-09-04 ~ 2026-05-14');
			// "3M" のようなラベルそのものが描画されないこと（period 文字列に依存しない）
			expect(svg).not.toContain('| 3M |');
		});

		it('full: evaluation_start ~ evaluation_end が見出しに含まれる', () => {
			const data = makeChartData({
				input: {
					pair: 'btc_jpy',
					timeframe: '1D',
					period: '1Y',
					strategyName: 'Test Strategy',
					strategyParams: { fast: 12, slow: 26 },
					fee_bp: 12,
				},
				summary: makeSummary({
					evaluation_start: '2024-06-01T00:00:00.000Z',
					evaluation_end: '2025-06-01T00:00:00.000Z',
				}),
			});
			const svg = renderBacktestChartGeneric(data, 'full');
			expect(svg).toContain('2024-06-01 ~ 2025-06-01');
			expect(svg).not.toContain('| 1Y |');
		});

		it('絶対レンジ (start_date/end_date) 相当のケースでも実データレンジが表示される', () => {
			// period がデフォルトの 3M のまま渡ったとしても、表示は evaluation_* に従う
			const data = makeChartData({
				input: {
					pair: 'eth_jpy',
					timeframe: '4H',
					period: '3M',
					strategyName: 'Test Strategy',
					strategyParams: {},
					fee_bp: 12,
				},
				summary: makeSummary({
					evaluation_start: '2023-01-15T00:00:00.000Z',
					evaluation_end: '2023-08-20T00:00:00.000Z',
				}),
			});
			const svg = renderBacktestChartGeneric(data, 'full');
			expect(svg).toContain('2023-01-15 ~ 2023-08-20');
		});
	});

	describe('ヘルパー関数（renderBacktestChartGeneric 経由）', () => {
		it('formatPrice: 1M 以上は M サフィックス', () => {
			// price ticks in full chart use formatPrice — use high close price to get M suffix
			const candles = makeCandles(10, '2024-01-01', 1500000);
			const equity_curve: EquityPoint[] = candles.map((c, i) => ({ time: c.time, equity_pct: i, confirmed_pct: 0 }));
			const drawdown_curve: DrawdownPoint[] = candles.map((c) => ({ time: c.time, drawdown_pct: 0 }));
			const data = makeChartData({ candles, equity_curve, drawdown_curve });
			const svg = renderBacktestChartGeneric(data, 'full');
			expect(svg).toMatch(/\d+\.\d+M/);
		});

		it('formatPrice: 1K 以上は K サフィックス', () => {
			const candles = makeCandles(10, '2024-01-01', 5000);
			const equity_curve: EquityPoint[] = candles.map((c, i) => ({ time: c.time, equity_pct: i, confirmed_pct: 0 }));
			const drawdown_curve: DrawdownPoint[] = candles.map((c) => ({ time: c.time, drawdown_pct: 0 }));
			const data = makeChartData({ candles, equity_curve, drawdown_curve });
			const svg = renderBacktestChartGeneric(data, 'full');
			expect(svg).toMatch(/\d+\.\d+K/);
		});

		it('getDateFormat: 短い期間 (≤60日) は MM/DD 形式', () => {
			// 10 candles = ~9 day span → month-day format
			const candles = makeCandles(10);
			const equity_curve: EquityPoint[] = candles.map((c, i) => ({ time: c.time, equity_pct: i, confirmed_pct: 0 }));
			const drawdown_curve: DrawdownPoint[] = candles.map((c) => ({ time: c.time, drawdown_pct: 0 }));
			const data = makeChartData({ candles, equity_curve, drawdown_curve });
			const svg = renderBacktestChartGeneric(data, 'default');
			expect(svg).toMatch(/\d{2}\/\d{2}/); // MM/DD
		});

		it('getDateFormat: 長い期間 (>180日) は YYYY-MM 形式', () => {
			// 200 candles = ~199 day span → year-month format
			const candles = makeCandles(200);
			const equity_curve: EquityPoint[] = candles.map((c, i) => ({ time: c.time, equity_pct: i, confirmed_pct: 0 }));
			const drawdown_curve: DrawdownPoint[] = candles.map((c) => ({ time: c.time, drawdown_pct: 0 }));
			const data = makeChartData({ candles, equity_curve, drawdown_curve });
			const svg = renderBacktestChartGeneric(data, 'default');
			expect(svg).toMatch(/\d{4}-\d{2}(?!-\d{2})/); // YYYY-MM without day
		});

		it('calculateBuyHoldEquity: 価格変化がエクイティに反映される', () => {
			// prices go up: 100 → 109, so buy-hold equity should be positive at the end
			const candles = makeCandles(10, '2024-01-01', 100);
			const equity_curve: EquityPoint[] = candles.map((c, i) => ({ time: c.time, equity_pct: i, confirmed_pct: 0 }));
			const drawdown_curve: DrawdownPoint[] = candles.map((c) => ({ time: c.time, drawdown_pct: 0 }));
			const data = makeChartData({ candles, equity_curve, drawdown_curve });
			const svg = renderBacktestChartGeneric(data, 'default');
			// B&H pct in legend should be positive
			expect(svg).toContain('B&amp;H: +');
		});

		it('calculatePositionState: トレードに対応する位置に long 状態が設定される', () => {
			const candles = makeCandles(10);
			const trade: Trade = {
				entry_time: candles[1].time,
				entry_price: candles[1].close,
				exit_time: candles[5].time,
				exit_price: candles[5].close,
				pnl_pct: 1.0,
				fee_pct: 0.1,
				net_return: 1.01,
			};
			const equity_curve: EquityPoint[] = candles.map((c, i) => ({ time: c.time, equity_pct: i, confirmed_pct: 0 }));
			const drawdown_curve: DrawdownPoint[] = candles.map((c) => ({ time: c.time, drawdown_pct: 0 }));
			const data = makeChartData({ candles, trades: [trade], equity_curve, drawdown_curve });
			const svg = renderBacktestChartGeneric(data, 'full');
			// Position panel renders green rect for long positions
			expect(svg).toContain('"#4ade80"');
		});
	});
});
