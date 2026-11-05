import analyzeIndicators from '../tools/analyze_indicators.js';
import { intArg, parseArgs, runCli } from './cli-utils.js';

runCli(() => {
	const { positional } = parseArgs();
	const [pair, type, limitStr] = positional;

	if (!pair) {
		console.error('Usage: tsx tools/analyze_indicators_cli.ts <pair> [type] [limit]');
		console.error('Example: tsx tools/analyze_indicators_cli.ts btc_jpy 1day');
		console.error('Example: tsx tools/analyze_indicators_cli.ts btc_jpy 1hour 200');
		process.exit(1);
	}

	const limit = limitStr ? intArg(limitStr, 200) : null;
	return analyzeIndicators(pair, type || '1day', limit);
});
