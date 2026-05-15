import { toStructured } from '../../lib/result.js';
import { runBacktest } from '../../tools/trading_process/index.js';
import { RunBacktestInputSchema } from '../schemas.js';
import type { ToolDefinition } from '../tool-definition.js';

export const toolDef: ToolDefinition = {
	name: 'run_backtest',
	description: `[Backtest / Strategy Test / SMA Cross / RSI / MACD] 汎用バックテスト（backtest / strategy test / simulation / performance）。データ取得〜計算〜チャート描画を一括実行。

戦略: sma_cross / rsi / macd_cross / bb_breakout。
期間: 1M / 3M / 6M / 1Y / 2Y / 3Y、または start_date+end_date (YYYY-MM-DD) で任意レンジ指定可。
時間軸: 1D / 4H / 1H。
SVG チャート付きで損益・勝率・最大DD・Sharpe Ratio 等を返却。独自実装不要。`,
	inputSchema: RunBacktestInputSchema,
	handler: async (args: Record<string, unknown>) => {
		const parsed = RunBacktestInputSchema.parse(args);
		const res = await runBacktest({
			pair: parsed.pair,
			timeframe: parsed.timeframe,
			period: parsed.period,
			start_date: parsed.start_date,
			end_date: parsed.end_date,
			strategy: parsed.strategy,
			fee_bp: parsed.fee_bp,
			execution: parsed.execution,
			outputDir: parsed.outputDir,
			savePng: parsed.savePng,
			includeSvg: parsed.includeSvg,
			chartDetail: parsed.chartDetail,
		});

		if (!res.ok) {
			const errorText = res.availableStrategies
				? `Error: ${res.error}\nAvailable strategies: ${res.availableStrategies.join(', ')}`
				: `Error: ${res.error}`;
			return { content: [{ type: 'text', text: errorText }], structuredContent: toStructured(res) };
		}

		// SVG がある場合はアーティファクト用のヒントを追加
		let svgHint = '';
		if (res.svg) {
			svgHint = [
				'',
				'--- Backtest Chart (SVG) ---',
				`identifier: backtest-${parsed.strategy?.type}-${parsed.pair}-${Date.now()}`,
				`title: ${parsed.pair?.toUpperCase() || 'BTC_JPY'} ${res.data.input.strategy.type} Backtest`,
				'type: image/svg+xml',
				'',
				res.svg,
			].join('\n');
		}

		return {
			content: [{ type: 'text', text: res.summary + svgHint }],
			structuredContent: {
				ok: true,
				summary: res.summary,
				svg: res.svg,
				data: {
					input: res.data.input,
					summary: res.data.summary,
					trade_count: res.data.trades.length,
				},
				artifactHint: res.svg
					? {
							renderHint: 'ARTIFACT_REQUIRED',
							displayType: 'image/svg+xml',
							source: 'inline_svg',
						}
					: undefined,
			},
		};
	},
};
