import { z } from 'zod';

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

export const StrategyTypeEnum = z.enum(['sma_cross', 'rsi', 'macd_cross', 'bb_breakout']);

export const StrategyConfigSchema = z.object({
	type: StrategyTypeEnum.describe('Strategy type'),
	params: z
		.record(z.string(), z.number())
		.optional()
		.default({})
		.describe(
			'Strategy parameters (overrides defaults). Unknown keys are rejected. Period params (short / long / period / fast / slow / signal / sma_filter_period / rsi_filter_period) must be integers.',
		),
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
	buy_hold_pnl_pct: z
		.number()
		.describe(
			'Buy & Hold return [%] from the open of the bar after evaluation_start to the last close. The one-way buy fee (fee_bp) is deducted; no sell fee (same as an open position)',
		),
	excess_return_pct: z.number().describe('total_pnl_pct - buy_hold_pnl_pct (both include fees)'),
	profit_factor: z
		.number()
		.nullable()
		.describe(
			'Profit Factor (gross profit / gross loss) over closed trades. null when there is no losing trade (no trades, all wins, or all trades exactly 0%)',
		),
	sharpe_ratio: z
		.number()
		.nullable()
		.describe(
			'Annualized Sharpe Ratio from per-bar returns over the evaluation range (bars per year: 1D = 365, 4H = 365 × 6, 1H = 365 × 24)',
		),
	avg_pnl_pct: z.number().describe('Average P&L per trade [%]'),
	evaluation_start: z
		.string()
		.describe(
			"Evaluation range start ISO time: the first bar whose signal can be acted on (warmup excluded). Signals fill at the next bar's open, so the first fill and the Buy & Hold entry are one bar later",
		),
	evaluation_end: z.string().describe('Evaluation range end ISO time (last bar)'),
	evaluation_bars: z
		.number()
		.describe(
			'Bars from evaluation_start to the last bar (evaluation_bars + warmup_bars = effective_bars). Includes evaluation_start, so bars where a fill can happen are one fewer',
		),
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
				period: z
					.string()
					.describe('Period (1M〜3Y), or "YYYY-MM-DD ~ YYYY-MM-DD" when start_date and end_date are given'),
				strategy: StrategyConfigSchema,
				fee_bp: z.number(),
				execution: z.string(),
				effective_start: z.string().describe('First fetched candle ISO time (warmup included)'),
				effective_end: z.string().describe('Last fetched candle ISO time'),
				effective_bars: z.number().describe('Total fetched candle count (warmup included)'),
			}),
			summary: GenericBacktestSummarySchema,
			trades: z
				.array(BacktestTradeSchema)
				.describe('Closed trades only (an open position at the end is in open_position)'),
			open_position: z
				.object({
					entry_time: z.string(),
					entry_price: z.number(),
					mark_time: z.string().describe('Last bar time used to value the position'),
					mark_price: z.number().describe('Last bar close'),
					unrealized_pnl_pct: z
						.number()
						.describe('Unrealized P&L [%] with the entry fee deducted and the exit fee not deducted'),
				})
				.nullable()
				.describe(
					'Long position still open at the last bar. total_pnl_pct / equity_curve / max_drawdown_pct / sharpe_ratio include its unrealized P&L; trade_count / win_rate / avg_pnl_pct / profit_factor do not.',
				),
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
