import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { StrategyConfig } from '../tools/trading_process/lib/strategies/index.js';
import runBacktest from '../tools/trading_process/run_backtest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
	const strategyType = process.argv[2] || 'sma_cross';

	const strategyConfigs: Record<string, StrategyConfig> = {
		sma_cross: { type: 'sma_cross', params: { short: 5, long: 20 } },
		rsi: { type: 'rsi', params: { period: 14, overbought: 70, oversold: 30 } },
		macd_cross: { type: 'macd_cross', params: { fast: 12, slow: 26, signal: 9 } },
		bb_breakout: { type: 'bb_breakout', params: { period: 20, stddev: 2 } },
	};

	const config = strategyConfigs[strategyType];
	if (!config) {
		console.error(`Unknown strategy: ${strategyType}`);
		console.error(`Available: ${Object.keys(strategyConfigs).join(', ')}`);
		process.exit(1);
	}

	console.log(`\n=== Testing ${strategyType} strategy ===\n`);
	console.log(
		'Input:',
		JSON.stringify(
			{
				pair: 'btc_jpy',
				period: '3M',
				strategy: config,
			},
			null,
			2,
		),
	);

	const chartDetail = process.argv[3] === 'full' ? ('full' as const) : ('default' as const);

	const result = await runBacktest({
		pair: 'btc_jpy',
		period: '3M',
		strategy: config,
		savePng: false, // ローカルテストでは PNG 不要
		includeSvg: true, // SVG を返す
		chartDetail,
	});

	if (!result.ok) {
		console.error('\nError:', result.error);
		if ('availableStrategies' in result) {
			console.error('Available strategies:', result.availableStrategies);
		}
		process.exit(1);
	}

	console.log('\n' + result.summary);

	if (result.svg) {
		const outputPath = join(__dirname, '..', '..', 'assets', `backtest_${strategyType}_test.svg`);
		writeFileSync(outputPath, result.svg);
		console.log(`\nSVG saved to: ${outputPath}`);
		console.log(`\nOpen with: open ${outputPath}`);
	}
}

main().catch(console.error);
