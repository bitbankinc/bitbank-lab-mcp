import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

dayjs.extend(utc);

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
		time: dayjs.utc('2024-01-01').add(i, 'day').toISOString(),
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
			evaluation_start: '2024-01-01T00:00:00.000Z',
			evaluation_end: '2024-01-31T00:00:00.000Z',
			evaluation_bars: 30,
			warmup_bars: 0,
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

	it('inputSchema: start_date のみ指定 → エラー（end_date も必要）', () => {
		const parse = () =>
			toolDef.inputSchema.parse({
				pair: 'btc_jpy',
				start_date: '2024-01-01',
				strategy: { type: 'rsi', params: {} },
			});
		expect(parse).toThrow(/start_date and end_date must be provided together/);
	});

	it('inputSchema: start_date > end_date → エラー', () => {
		const parse = () =>
			toolDef.inputSchema.parse({
				pair: 'btc_jpy',
				start_date: '2024-02-01',
				end_date: '2024-01-01',
				strategy: { type: 'rsi', params: {} },
			});
		expect(parse).toThrow(/start_date must be on or before end_date/);
	});

	it('inputSchema: start_date == end_date は許容', () => {
		const parsed = toolDef.inputSchema.parse({
			pair: 'btc_jpy',
			start_date: '2024-01-01',
			end_date: '2024-01-01',
			strategy: { type: 'rsi', params: {} },
		});
		expect(parsed.start_date).toBe('2024-01-01');
		expect(parsed.end_date).toBe('2024-01-01');
	});

	it('toolDef.handler は inputSchema の既定値 savePng=false / includeSvg=false を尊重するべき', async () => {
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
				savePng: false,
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

	it('start_date / end_date 指定時、summary text に Period セクションが含まれる', async () => {
		mocks.getStrategy.mockReturnValue({
			name: 'RSI',
			type: 'rsi',
			requiredBars: 14,
			defaultParams: { period: 14, overbought: 70, oversold: 30 },
			computeRequiredBars: () => 14,
		});
		mocks.fetchCandlesForBacktest.mockResolvedValue(buildCandles(90));
		const engineResult = buildEngineResult();
		engineResult.summary.evaluation_start = '2024-01-15T00:00:00.000Z';
		engineResult.summary.evaluation_end = '2024-03-31T00:00:00.000Z';
		engineResult.summary.evaluation_bars = 76;
		engineResult.summary.warmup_bars = 14;
		mocks.runBacktestEngine.mockReturnValue(engineResult);

		const res = await runBacktest({
			pair: 'btc_jpy',
			strategy: { type: 'rsi', params: {} },
			start_date: '2024-01-01',
			end_date: '2024-03-31',
			savePng: false,
			includeSvg: false,
		});

		assertOk(res);
		expect(res.summary).toContain('--- Period ---');
		expect(res.summary).toContain('Evaluation: 2024-01-15 ~ 2024-03-31');
		expect(res.summary).toContain('warmup: 14 bars');
		expect(res.summary).toContain('Buy & Hold:');
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
