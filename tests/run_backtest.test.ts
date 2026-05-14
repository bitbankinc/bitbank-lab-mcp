import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	handlerRunBacktest: vi.fn(),
	fetchCandlesForBacktest: vi.fn(),
	getPeriodBars: vi.fn(),
	runBacktestEngine: vi.fn(),
	getStrategy: vi.fn(),
	getAvailableStrategies: vi.fn(),
	renderBacktestChartGeneric: vi.fn(),
	svgToPng: vi.fn(),
	generateBacktestChartFilename: vi.fn(),
}));

vi.mock('../tools/trading_process/index.js', () => ({
	runBacktest: mocks.handlerRunBacktest,
}));

vi.mock('../tools/trading_process/lib/fetch_candles.js', () => ({
	fetchCandlesForBacktest: mocks.fetchCandlesForBacktest,
	getPeriodBars: mocks.getPeriodBars,
}));

vi.mock('../tools/trading_process/lib/backtest_engine.js', () => ({
	runBacktestEngine: mocks.runBacktestEngine,
}));

vi.mock('../tools/trading_process/lib/strategies/index.js', () => ({
	getStrategy: mocks.getStrategy,
	getAvailableStrategies: mocks.getAvailableStrategies,
}));

vi.mock('../tools/trading_process/render_backtest_chart_generic.js', () => ({
	renderBacktestChartGeneric: mocks.renderBacktestChartGeneric,
}));

vi.mock('../tools/trading_process/lib/svg_to_png.js', () => ({
	svgToPng: mocks.svgToPng,
	generateBacktestChartFilename: mocks.generateBacktestChartFilename,
}));

import { toolDef } from '../src/handlers/runBacktestHandler.js';
import runBacktest from '../tools/trading_process/run_backtest.js';
import { assertOk } from './_assertResult.js';

function buildCandles(count: number) {
	return Array.from({ length: count }, (_, i) => ({
		time: new Date(Date.UTC(2024, 0, i + 1)).toISOString(),
		open: 100 + i,
		high: 101 + i,
		low: 99 + i,
		close: 100 + i,
		volume: 1,
	}));
}

function buildEngineResult() {
	return {
		input: {
			pair: 'btc_jpy',
			timeframe: '1D',
			period: '3M',
			strategy: { type: 'rsi', params: {} },
			fee_bp: 12,
			execution: 't+1_open',
		},
		summary: {
			total_pnl_pct: 1.23,
			trade_count: 1,
			win_rate: 1,
			max_drawdown_pct: 0.5,
			buy_hold_pnl_pct: 0.9,
			excess_return_pct: 0.33,
			profit_factor: null,
			sharpe_ratio: null,
			avg_pnl_pct: 1.23,
		},
		trades: [
			{
				entry_time: '2024-01-10T00:00:00.000Z',
				entry_price: 100,
				exit_time: '2024-01-11T00:00:00.000Z',
				exit_price: 101,
				pnl_pct: 1.23,
				fee_pct: 0.24,
				net_return: 1.0123,
			},
		],
		equity_curve: [],
		drawdown_curve: [],
		overlays: [],
	};
}

describe('run_backtest', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('inputSchema: strategy.type は定義済み enum のみ許可する', () => {
		const parse = () =>
			toolDef.inputSchema.parse({
				pair: 'btc_jpy',
				strategy: { type: 'not_a_strategy', params: {} },
			});

		expect(parse).toThrow();
	});

	it('toolDef.handler は inputSchema の既定値 savePng=true / includeSvg=false を尊重するべき', async () => {
		mocks.handlerRunBacktest.mockResolvedValue({
			ok: false,
			error: 'boom',
		});

		await toolDef.handler({
			pair: 'btc_jpy',
			strategy: { type: 'rsi', params: {} },
		});

		expect(mocks.handlerRunBacktest).toHaveBeenCalledWith(
			expect.objectContaining({
				pair: 'btc_jpy',
				strategy: { type: 'rsi', params: {} },
				savePng: true,
				includeSvg: false,
				chartDetail: 'default',
			}),
		);
	});

	it('requiredBars は RSI の閾値 params ではなく計算期間ベースで判定するべき', async () => {
		mocks.getStrategy.mockReturnValue({
			name: 'RSI',
			type: 'rsi',
			requiredBars: 20,
			defaultParams: { period: 14, overbought: 70, oversold: 30 },
			computeRequiredBars: () => 20,
		});
		mocks.getPeriodBars.mockReturnValue(90);
		mocks.fetchCandlesForBacktest.mockResolvedValue(buildCandles(40));

		const res = await runBacktest({
			pair: 'btc_jpy',
			strategy: { type: 'rsi', params: {} },
			includeSvg: false,
			savePng: false,
		});

		assertOk(res);
	});

	it('includeSvg=false なら PNG 生成失敗時も svg を返すべきではない', async () => {
		mocks.getStrategy.mockReturnValue({
			name: 'RSI',
			type: 'rsi',
			requiredBars: 20,
			defaultParams: { period: 14, overbought: 70, oversold: 30 },
			computeRequiredBars: () => 20,
		});
		mocks.getPeriodBars.mockReturnValue(90);
		mocks.fetchCandlesForBacktest.mockResolvedValue(buildCandles(90));
		mocks.runBacktestEngine.mockReturnValue(buildEngineResult());
		mocks.renderBacktestChartGeneric.mockReturnValue('<svg>chart</svg>');
		mocks.generateBacktestChartFilename.mockReturnValue('backtest.png');
		mocks.svgToPng.mockRejectedValue(new Error('sharp failed'));

		const res = await runBacktest({
			pair: 'btc_jpy',
			strategy: { type: 'rsi', params: {} },
			outputDir: '/Users/toshikitanaka/bitbank-mcp-sandbox/tools/tests',
			savePng: true,
			includeSvg: false,
		});

		assertOk(res);
		expect(res.pngError).toContain('sharp failed');
		expect(res.svg).toBeUndefined();
	});
});
