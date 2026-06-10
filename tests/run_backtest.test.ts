import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
	resolveBacktestFeeBp: vi.fn(),
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

vi.mock('../tools/trading_process/lib/resolve_fee.js', () => ({
	resolveBacktestFeeBp: mocks.resolveBacktestFeeBp,
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

function makeValidateOk(defaultParams: Record<string, number>) {
	return (params: Record<string, number>) => ({
		valid: true,
		errors: [],
		normalizedParams: { ...defaultParams, ...params },
	});
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
	beforeEach(() => {
		// 既定は dynamic 12bp。fee 解決を要する個別テストで上書きする。
		mocks.resolveBacktestFeeBp.mockResolvedValue({ fee_bp: 12, source: 'dynamic' });
	});

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
			validate: makeValidateOk({ period: 14, overbought: 70, oversold: 30 }),
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
			validate: makeValidateOk({ period: 14, overbought: 70, oversold: 30 }),
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

	it('content text の summary に equity_curve / drawdown_curve の JSON が含まれる', async () => {
		mocks.getStrategy.mockReturnValue({
			name: 'RSI',
			type: 'rsi',
			requiredBars: 14,
			defaultParams: { period: 14, overbought: 70, oversold: 30 },
			computeRequiredBars: () => 14,
			validate: makeValidateOk({ period: 14, overbought: 70, oversold: 30 }),
		});
		mocks.fetchCandlesForBacktest.mockResolvedValue(buildCandles(90));
		const engineResult = buildEngineResult();
		engineResult.equity_curve = [
			{ time: '2024-01-01T00:00:00.000Z', equity_pct: 0, confirmed_pct: 0 },
			{ time: '2024-01-02T00:00:00.000Z', equity_pct: 1.5, confirmed_pct: 0 },
			{ time: '2024-01-03T00:00:00.000Z', equity_pct: 2.0, confirmed_pct: 2.0 },
		];
		engineResult.drawdown_curve = [
			{ time: '2024-01-01T00:00:00.000Z', drawdown_pct: 0 },
			{ time: '2024-01-02T00:00:00.000Z', drawdown_pct: 0.5 },
			{ time: '2024-01-03T00:00:00.000Z', drawdown_pct: 0 },
		];
		mocks.runBacktestEngine.mockReturnValue(engineResult);

		const res = await runBacktest({
			pair: 'btc_jpy',
			strategy: { type: 'rsi', params: {} },
			savePng: false,
			includeSvg: false,
		});

		assertOk(res);
		expect(res.summary).toContain('=== Equity Curve');
		expect(res.summary).toContain('"equity_curve"');
		expect(res.summary).toContain('"equity_pct"');
		expect(res.summary).toContain('=== Drawdown Curve');
		expect(res.summary).toContain('"drawdown_curve"');
		expect(res.summary).toContain('"drawdown_pct"');

		// JSON が valid に parse できる
		const eqMatch = res.summary.match(/=== Equity Curve[^\n]*===\n(\{[^\n]*\})/);
		expect(eqMatch).not.toBeNull();
		const eqJson = JSON.parse((eqMatch as RegExpMatchArray)[1]) as {
			equity_curve: Array<{ time: string; equity_pct: number }>;
		};
		expect(eqJson.equity_curve).toHaveLength(3);
		expect(eqJson.equity_curve[0].time).toBe('2024-01-01T00:00:00.000Z');
		expect(eqJson.equity_curve[2].time).toBe('2024-01-03T00:00:00.000Z');
	});

	it('chartDetail=default で 200 点超の equity_curve は ≤200 点にサンプリングされる', async () => {
		mocks.getStrategy.mockReturnValue({
			name: 'RSI',
			type: 'rsi',
			requiredBars: 14,
			defaultParams: { period: 14, overbought: 70, oversold: 30 },
			computeRequiredBars: () => 14,
			validate: makeValidateOk({ period: 14, overbought: 70, oversold: 30 }),
		});
		mocks.fetchCandlesForBacktest.mockResolvedValue(buildCandles(1000));
		const engineResult = buildEngineResult();
		const N = 1000;
		engineResult.equity_curve = Array.from({ length: N }, (_, i) => ({
			time: dayjs.utc('2024-01-01').add(i, 'day').toISOString(),
			equity_pct: i * 0.01,
			confirmed_pct: 0,
		}));
		engineResult.drawdown_curve = Array.from({ length: N }, (_, i) => ({
			time: dayjs.utc('2024-01-01').add(i, 'day').toISOString(),
			drawdown_pct: 0,
		}));
		mocks.runBacktestEngine.mockReturnValue(engineResult);

		const res = await runBacktest({
			pair: 'btc_jpy',
			strategy: { type: 'rsi', params: {} },
			savePng: false,
			includeSvg: false,
			chartDetail: 'default',
		});

		assertOk(res);
		const eqMatch = res.summary.match(/=== Equity Curve[^\n]*===\n(\{[^\n]*\})/);
		expect(eqMatch).not.toBeNull();
		const eqJson = JSON.parse((eqMatch as RegExpMatchArray)[1]) as {
			equity_curve: Array<{ time: string; equity_pct: number }>;
		};
		expect(eqJson.equity_curve.length).toBeLessThanOrEqual(200);
		expect(eqJson.equity_curve.length).toBeGreaterThan(100);

		// 最初と最後の点は必ず含まれる
		const firstTime = dayjs.utc('2024-01-01').toISOString();
		const lastTime = dayjs
			.utc('2024-01-01')
			.add(N - 1, 'day')
			.toISOString();
		expect(eqJson.equity_curve[0].time).toBe(firstTime);
		expect(eqJson.equity_curve[eqJson.equity_curve.length - 1].time).toBe(lastTime);
	});

	it('chartDetail=full では equity_curve の全点が含まれる', async () => {
		mocks.getStrategy.mockReturnValue({
			name: 'RSI',
			type: 'rsi',
			requiredBars: 14,
			defaultParams: { period: 14, overbought: 70, oversold: 30 },
			computeRequiredBars: () => 14,
			validate: makeValidateOk({ period: 14, overbought: 70, oversold: 30 }),
		});
		mocks.fetchCandlesForBacktest.mockResolvedValue(buildCandles(500));
		const engineResult = buildEngineResult();
		const N = 500;
		engineResult.equity_curve = Array.from({ length: N }, (_, i) => ({
			time: dayjs.utc('2024-01-01').add(i, 'day').toISOString(),
			equity_pct: i * 0.01,
			confirmed_pct: 0,
		}));
		engineResult.drawdown_curve = [];
		mocks.runBacktestEngine.mockReturnValue(engineResult);

		const res = await runBacktest({
			pair: 'btc_jpy',
			strategy: { type: 'rsi', params: {} },
			savePng: false,
			includeSvg: false,
			chartDetail: 'full',
		});

		assertOk(res);
		const eqMatch = res.summary.match(/=== Equity Curve[^\n]*===\n(\{[^\n]*\})/);
		expect(eqMatch).not.toBeNull();
		const eqJson = JSON.parse((eqMatch as RegExpMatchArray)[1]) as {
			equity_curve: Array<{ time: string; equity_pct: number }>;
		};
		expect(eqJson.equity_curve.length).toBe(N);
	});

	it('equity_curve が空配列の場合は Equity Curve セクションを出力しない', async () => {
		mocks.getStrategy.mockReturnValue({
			name: 'RSI',
			type: 'rsi',
			requiredBars: 14,
			defaultParams: { period: 14, overbought: 70, oversold: 30 },
			computeRequiredBars: () => 14,
			validate: makeValidateOk({ period: 14, overbought: 70, oversold: 30 }),
		});
		mocks.fetchCandlesForBacktest.mockResolvedValue(buildCandles(90));
		mocks.runBacktestEngine.mockReturnValue(buildEngineResult());

		const res = await runBacktest({
			pair: 'btc_jpy',
			strategy: { type: 'rsi', params: {} },
			savePng: false,
			includeSvg: false,
		});

		assertOk(res);
		expect(res.summary).not.toContain('=== Equity Curve');
		expect(res.summary).not.toContain('=== Drawdown Curve');
	});

	it('includeSvg=false なら PNG 生成失敗時も svg を返すべきではない', async () => {
		mocks.getStrategy.mockReturnValue({
			name: 'RSI',
			type: 'rsi',
			requiredBars: 20,
			defaultParams: { period: 14, overbought: 70, oversold: 30 },
			computeRequiredBars: () => 20,
			validate: makeValidateOk({ period: 14, overbought: 70, oversold: 30 }),
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
			outputDir: '/tmp/backtest-tests',
			savePng: true,
			includeSvg: false,
		});

		assertOk(res);
		expect(res.pngError).toContain('sharp failed');
		expect(res.svg).toBeUndefined();
	});

	it('無効な params は fetch 前に弾かれ、fetchCandlesForBacktest が呼ばれない', async () => {
		mocks.getStrategy.mockReturnValue({
			name: 'SMA Crossover',
			type: 'sma_cross',
			requiredBars: 20,
			defaultParams: { short: 5, long: 20 },
			computeRequiredBars: () => 20,
			validate: () => ({
				valid: false,
				errors: ['short must be less than long'],
				normalizedParams: { short: 20, long: 20 },
			}),
		});

		const res = await runBacktest({
			pair: 'btc_jpy',
			strategy: { type: 'sma_cross', params: { short: 20, long: 20 } },
			savePng: false,
			includeSvg: false,
		});

		expect(res.ok).toBe(false);
		if (res.ok === false) {
			expect(res.error).toMatch(/Invalid strategy params/);
		}
		expect(mocks.fetchCandlesForBacktest).not.toHaveBeenCalled();
		expect(mocks.runBacktestEngine).not.toHaveBeenCalled();
	});

	it('複数の validation エラーが ; 区切りで連結され、戦略タイプも error に含まれる', async () => {
		mocks.getStrategy.mockReturnValue({
			name: 'SMA Crossover',
			type: 'sma_cross',
			requiredBars: 20,
			defaultParams: { short: 5, long: 20 },
			computeRequiredBars: () => 20,
			validate: () => ({
				valid: false,
				errors: ['short must be less than long', 'rsi_filter_max must be 0-100'],
				normalizedParams: { short: 20, long: 20, rsi_filter_max: 150 },
			}),
		});

		const res = await runBacktest({
			pair: 'btc_jpy',
			strategy: { type: 'sma_cross', params: { short: 20, long: 20, rsi_filter_max: 150 } },
			savePng: false,
			includeSvg: false,
		});

		expect(res.ok).toBe(false);
		if (res.ok === false) {
			expect(res.error).toContain('sma_cross');
			expect(res.error).toContain('short must be less than long');
			expect(res.error).toContain('rsi_filter_max must be 0-100');
			expect(res.error).toContain(';');
		}
	});

	it('validate.normalizedParams が以降の処理（computeRequiredBars / engine input）に渡る', async () => {
		const computeRequiredBars = vi.fn().mockReturnValue(20);
		mocks.getStrategy.mockReturnValue({
			name: 'SMA Crossover',
			type: 'sma_cross',
			requiredBars: 20,
			defaultParams: { short: 5, long: 20 },
			computeRequiredBars,
			validate: () => ({
				valid: true,
				errors: [],
				normalizedParams: { short: 5, long: 25 },
			}),
		});
		mocks.fetchCandlesForBacktest.mockResolvedValue(buildCandles(90));
		mocks.runBacktestEngine.mockReturnValue(buildEngineResult());

		const res = await runBacktest({
			pair: 'btc_jpy',
			strategy: { type: 'sma_cross', params: { long: 25 } },
			savePng: false,
			includeSvg: false,
		});

		assertOk(res);
		expect(computeRequiredBars).toHaveBeenCalledWith({ short: 5, long: 25 });
		expect(mocks.runBacktestEngine).toHaveBeenCalledTimes(1);
		const engineInput = mocks.runBacktestEngine.mock.calls[0][2];
		expect(engineInput.strategy.params).toEqual({ short: 5, long: 25 });
	});

	// -------------------------------------------------------------------------
	// 手数料の動的解決（taker レート由来）
	// -------------------------------------------------------------------------
	function setupRsiStrategy() {
		mocks.getStrategy.mockReturnValue({
			name: 'RSI',
			type: 'rsi',
			requiredBars: 14,
			defaultParams: { period: 14, overbought: 70, oversold: 30 },
			computeRequiredBars: () => 14,
			validate: makeValidateOk({ period: 14, overbought: 70, oversold: 30 }),
		});
		mocks.fetchCandlesForBacktest.mockResolvedValue(buildCandles(90));
		mocks.runBacktestEngine.mockReturnValue(buildEngineResult());
	}

	it('fee_bp 明示指定はそのまま使われ、resolveBacktestFeeBp に override として渡る', async () => {
		setupRsiStrategy();
		mocks.resolveBacktestFeeBp.mockResolvedValue({ fee_bp: 25, source: 'explicit' });

		const res = await runBacktest({
			pair: 'btc_jpy',
			strategy: { type: 'rsi', params: {} },
			fee_bp: 25,
			savePng: false,
			includeSvg: false,
		});

		assertOk(res);
		// override が resolveBacktestFeeBp に渡る
		expect(mocks.resolveBacktestFeeBp).toHaveBeenCalledWith('btc_jpy', 25);
		// engine には解決後の fee_bp が渡る（既存と同一 fee_bp → 数値不変の前提）
		const engineInput = mocks.runBacktestEngine.mock.calls[0][2];
		expect(engineInput.fee_bp).toBe(25);
		// summary に明示指定であることが表示される
		expect(res.summary).toContain('Fee: 25 bp (round-trip: 50 bp)');
		expect(res.summary).toContain('explicit: 明示指定');
	});

	it('fee_bp 未指定なら resolveBacktestFeeBp に undefined を渡し、dynamic レートが engine に渡る', async () => {
		setupRsiStrategy();
		mocks.resolveBacktestFeeBp.mockResolvedValue({ fee_bp: 10, source: 'dynamic' });

		const res = await runBacktest({
			pair: 'eth_jpy',
			strategy: { type: 'rsi', params: {} },
			savePng: false,
			includeSvg: false,
		});

		assertOk(res);
		expect(mocks.resolveBacktestFeeBp).toHaveBeenCalledWith('eth_jpy', undefined);
		const engineInput = mocks.runBacktestEngine.mock.calls[0][2];
		expect(engineInput.fee_bp).toBe(10);
		expect(res.summary).toContain('Fee: 10 bp (round-trip: 20 bp)');
		expect(res.summary).toContain('dynamic: /spot/pairs taker レート由来');
		// ハルシネーション防止の近似注記
		expect(res.summary).toContain('現在の /spot/pairs taker レート由来');
		expect(res.summary).toContain('現在レートでの近似');
	});

	it('pairs 取得失敗時は fallback 12bp ＋ warning が content 先頭付近に出る', async () => {
		setupRsiStrategy();
		mocks.resolveBacktestFeeBp.mockResolvedValue({
			fee_bp: 12,
			source: 'fallback',
			warning: '手数料: /spot/pairs 取得失敗のため公称 12 bp で概算します: fetch failed',
		});

		const res = await runBacktest({
			pair: 'btc_jpy',
			strategy: { type: 'rsi', params: {} },
			savePng: false,
			includeSvg: false,
		});

		assertOk(res);
		// warning は summary 先頭付近（タイトル行より前）に ⚠️ 付きで出る
		const titleIdx = res.summary.indexOf('=== RSI Backtest Result ===');
		const warnIdx = res.summary.indexOf('⚠️');
		expect(warnIdx).toBeGreaterThanOrEqual(0);
		expect(warnIdx).toBeLessThan(titleIdx);
		expect(res.summary).toContain('取得失敗');
		expect(res.summary).toContain('fallback: 公称 12bp 概算');
		const engineInput = mocks.runBacktestEngine.mock.calls[0][2];
		expect(engineInput.fee_bp).toBe(12);
	});

	it('回帰: 同一 fee_bp 入力なら engine に渡る fee_bp は従来通り（数値再現性）', async () => {
		setupRsiStrategy();
		mocks.resolveBacktestFeeBp.mockResolvedValue({ fee_bp: 12, source: 'explicit' });

		await runBacktest({
			pair: 'btc_jpy',
			strategy: { type: 'rsi', params: {} },
			fee_bp: 12,
			savePng: false,
			includeSvg: false,
		});

		const engineInput = mocks.runBacktestEngine.mock.calls[0][2];
		// 旧実装の固定 12bp と同じ値が engine に渡る → 損益計算は不変
		expect(engineInput.fee_bp).toBe(12);
	});
});
