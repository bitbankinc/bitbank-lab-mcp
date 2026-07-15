import { z } from 'zod';

// === Trading Process: Backtest Schemas ===

export const BacktestTimeframeEnum = z.enum(['1D', '4H', '1H']);
export const BacktestPeriodEnum = z.enum(['1M', '3M', '6M', '1Y', '2Y', '3Y']);

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO 8601 date (YYYY-MM-DD) required');

const BacktestTradeSchema = z.object({
	entry_time: z.string(),
	entry_price: z.number(),
	exit_time: z.string(),
	exit_price: z.number(),
	pnl_pct: z.number(),
	fee_pct: z.number(),
});

const EquityPointSchema = z.object({
	time: z.string(),
	equity_pct: z.number(),
});

const DrawdownPointSchema = z.object({
	time: z.string(),
	drawdown_pct: z.number(),
});

// === Generic Backtest Schema ===

export const StrategyTypeEnum = z.enum(['sma_cross', 'rsi', 'macd_cross', 'bb_breakout']);

export const StrategyConfigSchema = z.object({
	type: StrategyTypeEnum.describe('Strategy type'),
	params: z.record(z.string(), z.number()).optional().default({}).describe('Strategy parameters (overrides defaults)'),
});

export const RunBacktestInputSchema = z
	.object({
		pair: z.string().optional().default('btc_jpy').describe('Trading pair (e.g., btc_jpy)'),
		timeframe: BacktestTimeframeEnum.optional()
			.default('1D')
			.describe('Candle timeframe: 1D (daily), 4H (4-hour), 1H (hourly)'),
		period: BacktestPeriodEnum.optional()
			.default('3M')
			.describe('Backtest period: 1M, 3M, 6M, 1Y, 2Y, or 3Y. Ignored when start_date and end_date are both provided.'),
		start_date: IsoDateSchema.optional().describe(
			'Backtest start date (ISO 8601: YYYY-MM-DD). Takes precedence over period when both start_date and end_date are provided.',
		),
		end_date: IsoDateSchema.optional().describe(
			'Backtest end date (ISO 8601: YYYY-MM-DD). Takes precedence over period when both start_date and end_date are provided.',
		),
		strategy: StrategyConfigSchema.describe('Strategy configuration'),
		fee_bp: z
			.number()
			.min(0)
			.max(100)
			.optional()
			.describe(
				'One-way fee in basis points. When omitted, resolved dynamically from the current /spot/pairs taker rate (falls back to nominal 12 bp if unavailable). Explicit values are always respected.',
			),
		execution: z.literal('t+1_open').optional().default('t+1_open').describe('Execution timing (fixed: t+1_open)'),
		outputDir: z
			.string()
			.optional()
			.default('/mnt/user-data/outputs')
			.describe(
				'Output directory for chart files. Must be under an allowed root: ' +
					'/mnt/user-data/outputs, the server working directory, or a directory listed in ' +
					'the BACKTEST_OUTPUT_DIR_ALLOWLIST environment variable.',
			),
		savePng: z
			.boolean()
			.optional()
			.default(false)
			.describe(
				'Save chart as PNG file to outputDir (default: false). ' +
					'For inline display in chat UI, leave false and use includeSvg or prepare_chart_data instead.',
			),
		includeSvg: z
			.boolean()
			.optional()
			.default(false)
			.describe('Include SVG string in response (default: false, for token saving)'),
		chartDetail: z
			.enum(['default', 'full'])
			.optional()
			.default('default')
			.describe(
				'Chart detail level: default (equity+DD only) or full (price+indicator+equity+DD+position). Use full ONLY when user explicitly requests price chart or indicator visualization.',
			),
	})
	.refine((data) => !((data.start_date && !data.end_date) || (!data.start_date && data.end_date)), {
		error: 'start_date and end_date must be provided together',
		path: ['end_date'],
	})
	.refine((data) => !(data.start_date && data.end_date) || data.start_date <= data.end_date, {
		error: 'start_date must be on or before end_date',
		path: ['end_date'],
	});

const GenericBacktestSummarySchema = z.object({
	total_pnl_pct: z.number(),
	trade_count: z.number(),
	win_rate: z.number(),
	max_drawdown_pct: z.number(),
	buy_hold_pnl_pct: z.number(),
	excess_return_pct: z.number(),
	profit_factor: z.number().nullable().describe('Profit Factor (gross profit / gross loss). null if no losing trades'),
	sharpe_ratio: z.number().nullable().describe('Annualized Sharpe Ratio (daily returns, sqrt(365))'),
	avg_pnl_pct: z.number().describe('Average P&L per trade [%]'),
	evaluation_start: z.string().describe('Evaluation range start ISO time (first tradable bar, warmup excluded)'),
	evaluation_end: z.string().describe('Evaluation range end ISO time (last bar)'),
	evaluation_bars: z.number().describe('Bars in evaluation range (warmup excluded)'),
	warmup_bars: z.number().describe('Bars excluded as warmup (= strategy.computeRequiredBars)'),
});

export const RunBacktestOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: z.object({
			input: z.object({
				pair: z.string(),
				timeframe: z.string(),
				period: z.string(),
				strategy: StrategyConfigSchema,
				fee_bp: z.number(),
				execution: z.string(),
				effective_start: z.string().describe('First fetched candle ISO time (warmup included)'),
				effective_end: z.string().describe('Last fetched candle ISO time'),
				effective_bars: z.number().describe('Total fetched candle count (warmup included)'),
			}),
			summary: GenericBacktestSummarySchema,
			trades: z.array(BacktestTradeSchema),
			equity_curve: z.array(EquityPointSchema),
			drawdown_curve: z.array(DrawdownPointSchema),
			overlays: z.array(z.any()),
		}),
		chartPath: z.string().optional().describe('Path to saved PNG chart file'),
		svg: z.string().optional().describe('SVG string (only if includeSvg: true)'),
	}),
	z.object({
		ok: z.literal(false),
		error: z.string(),
		availableStrategies: z.array(StrategyTypeEnum).optional(),
	}),
]);
