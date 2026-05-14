/**
 * run_backtest.ts - 汎用バックテストエントリーポイント
 *
 * 任意の戦略を指定してバックテストを実行
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type BacktestEngineInput, type BacktestEngineResult, runBacktestEngine } from './lib/backtest_engine.js';
import { fetchCandlesForBacktest } from './lib/fetch_candles.js';
import { getAvailableStrategies, getStrategy, type StrategyConfig, type StrategyType } from './lib/strategies/index.js';
import { generateBacktestChartFilename, svgToPng } from './lib/svg_to_png.js';
import {
	type ChartDetail,
	type GenericBacktestChartData,
	renderBacktestChartGeneric,
} from './render_backtest_chart_generic.js';
import type { Period, Timeframe } from './types.js';

// Claude.ai のデフォルト出力ディレクトリ
const DEFAULT_OUTPUT_DIR = '/mnt/user-data/outputs';

/**
 * 書き込み可能なディレクトリを確保
 * /mnt/user-data/outputs を優先し、ディレクトリが存在しない場合は作成を試みる
 */
function ensureOutputDir(dir: string): void {
	try {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	} catch {
		// best-effort: directory creation failure will surface via svgToPng
	}
}

export interface RunBacktestInput {
	pair: string;
	timeframe?: Timeframe;
	period?: Period;
	strategy: StrategyConfig;
	fee_bp?: number;
	execution?: 't+1_open';
	/** 出力ディレクトリ（デフォルト: /mnt/user-data/outputs/） */
	outputDir?: string;
	/** PNG ファイルを生成する（デフォルト: false、ファイルシステム非共有のため） */
	savePng?: boolean;
	/** SVG 文字列を返す（デフォルト: true） */
	includeSvg?: boolean;
	/** チャート詳細度: 'default' = 軽量（エクイティ+DD）, 'full' = 4段チャート（デフォルト: 'default'） */
	chartDetail?: ChartDetail;
}

export interface RunBacktestOutput {
	ok: true;
	summary: string;
	data: BacktestEngineResult;
	/** PNG ファイルのパス（savePng: true の場合） */
	chartPath?: string;
	/** SVG 文字列（includeSvg: true の場合のみ） */
	svg?: string;
	/** PNG 生成エラー（エラー発生時のみ） */
	pngError?: string;
}

export interface RunBacktestError {
	ok: false;
	error: string;
	availableStrategies?: StrategyType[];
}

export type RunBacktestResult = RunBacktestOutput | RunBacktestError;

/**
 * 汎用バックテストを実行
 */
export default async function runBacktest(input: RunBacktestInput): Promise<RunBacktestResult> {
	try {
		const {
			pair,
			timeframe = '1D',
			period = '3M',
			strategy: strategyConfig,
			fee_bp = 12,
			execution = 't+1_open',
			outputDir = DEFAULT_OUTPUT_DIR,
			savePng = false, // ファイルシステム非共有のためデフォルトoff
			includeSvg = true, // SVG文字列をデフォルトで返す
			chartDetail = 'default', // 軽量チャートをデフォルトに
		} = input;

		// 戦略を取得
		const strategy = getStrategy(strategyConfig.type);
		if (!strategy) {
			return {
				ok: false,
				error: `Unknown strategy type: ${strategyConfig.type}`,
				availableStrategies: getAvailableStrategies(),
			};
		}

		// パラメータをマージ
		const params = { ...strategy.defaultParams, ...strategyConfig.params };

		// 必要なバー数を params から動的に計算（ユーザーが long / slow / signal 等を
		// デフォルトより大きく指定した場合でもウォームアップを十分確保するため）
		const requiredBars = strategy.computeRequiredBars(params);

		// ローソク足を取得
		const candles = await fetchCandlesForBacktest(pair, timeframe, period, requiredBars);

		if (candles.length < requiredBars + 10) {
			return {
				ok: false,
				error: `Insufficient candle data: ${candles.length} bars (need at least ${requiredBars + 10})`,
			};
		}

		// バックテストエンジン入力
		const engineInput: BacktestEngineInput = {
			pair,
			timeframe,
			period,
			strategy: strategyConfig,
			fee_bp,
			execution,
		};

		// バックテスト実行
		const result = runBacktestEngine(candles, strategy, engineInput);

		// チャート描画用データ
		const chartInput = {
			pair,
			timeframe,
			period,
			strategyName: strategy.name,
			strategyParams: params,
			fee_bp,
		};

		// チャート描画（savePng または includeSvg が有効な場合のみ）
		let svg: string | undefined;
		if (savePng || includeSvg) {
			const chartData: GenericBacktestChartData = {
				candles,
				overlays: result.overlays,
				trades: result.trades,
				equity_curve: result.equity_curve,
				drawdown_curve: result.drawdown_curve,
				input: chartInput,
				summary: result.summary,
			};
			svg = renderBacktestChartGeneric(chartData, chartDetail);
		}

		// サマリーテキスト生成
		const summaryText = result
			? generateSummaryText({
					candles,
					overlays: result.overlays,
					trades: result.trades,
					equity_curve: result.equity_curve,
					drawdown_curve: result.drawdown_curve,
					input: chartInput,
					summary: result.summary,
				})
			: '';

		// 結果を構築
		const output: RunBacktestOutput = {
			ok: true,
			summary: summaryText,
			data: result,
		};

		// PNG ファイル保存（savePng: true の場合のみ）
		if (savePng && svg) {
			try {
				ensureOutputDir(outputDir);
				const filename = generateBacktestChartFilename(pair, timeframe, strategyConfig.type, 'png');
				const pngPath = join(outputDir, filename);
				await svgToPng(svg, pngPath, { density: 150 });
				output.chartPath = pngPath;
			} catch (pngError) {
				const errorMsg = pngError instanceof Error ? pngError.message : String(pngError);
				if (includeSvg) {
					output.svg = svg;
				}
				output.pngError = `PNG generation failed: ${errorMsg}`;
			}
		}

		// SVG 文字列を含める場合
		if (includeSvg && svg) {
			output.svg = svg;
		}

		return output;
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return { ok: false, error: message };
	}
}

/**
 * サマリーテキストを生成
 */
function generateSummaryText(data: GenericBacktestChartData): string {
	const { input, summary, trades } = data;
	const lines: string[] = [];

	lines.push(`=== ${input.strategyName} Backtest Result ===`);
	lines.push(`Pair: ${input.pair.toUpperCase()}`);
	lines.push(`Period: ${input.period} (${input.timeframe})`);
	lines.push(`Strategy: ${input.strategyName}`);
	lines.push(`Parameters: ${JSON.stringify(input.strategyParams)}`);
	lines.push(`Fee: ${input.fee_bp} bp (round-trip: ${input.fee_bp * 2} bp)`);
	lines.push('');
	lines.push(`--- Summary (Compound) ---`);
	lines.push(`Total P&L: ${summary.total_pnl_pct >= 0 ? '+' : ''}${summary.total_pnl_pct.toFixed(2)}%`);
	lines.push(`Buy & Hold: ${summary.buy_hold_pnl_pct >= 0 ? '+' : ''}${summary.buy_hold_pnl_pct.toFixed(2)}%`);
	lines.push(`Excess Return: ${summary.excess_return_pct >= 0 ? '+' : ''}${summary.excess_return_pct.toFixed(2)}%`);
	lines.push(`Trades: ${summary.trade_count}`);
	lines.push(`Win Rate: ${(summary.win_rate * 100).toFixed(1)}%`);
	lines.push(`Avg P&L/Trade: ${summary.avg_pnl_pct >= 0 ? '+' : ''}${summary.avg_pnl_pct.toFixed(2)}%`);
	lines.push(`Max Drawdown: -${summary.max_drawdown_pct.toFixed(2)}%`);
	lines.push(`Profit Factor: ${summary.profit_factor != null ? summary.profit_factor.toFixed(2) : 'N/A (no losses)'}`);
	lines.push(`Sharpe Ratio: ${summary.sharpe_ratio != null ? summary.sharpe_ratio.toFixed(2) : 'N/A'}`);

	if (trades.length > 0) {
		lines.push('');
		lines.push(`--- Recent Trades (last 5) ---`);
		const recentTrades = trades.slice(-5);
		for (const t of recentTrades) {
			const entryDate = t.entry_time.split('T')[0];
			const exitDate = t.exit_time.split('T')[0];
			const pnlSign = t.pnl_pct >= 0 ? '+' : '';
			lines.push(`${entryDate} → ${exitDate}: ${pnlSign}${t.pnl_pct.toFixed(2)}% (×${t.net_return.toFixed(4)})`);
		}
	}

	return lines.join('\n');
}
