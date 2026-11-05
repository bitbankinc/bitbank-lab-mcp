import getVolatilityMetrics from '../tools/get_volatility_metrics.js';
import { intArg, parseArgs, runCli } from './cli-utils.js';

runCli(() => {
	const { positional, flags } = parseArgs();
	const pair = positional[0] || 'btc_jpy';
	const type = positional[1] || '1day';
	const limit = intArg(positional[2], 200);

	const windows =
		typeof flags.windows === 'string'
			? flags.windows
					.split(',')
					.map((s) => parseInt(s.trim(), 10))
					.filter((n) => Number.isFinite(n) && n >= 2)
			: undefined;
	const useLogReturns = flags.log ? true : flags.linear ? false : undefined;
	const annualize = flags.ann ? true : flags.noann ? false : undefined;

	return getVolatilityMetrics(pair, type, limit, windows || [14, 20, 30], { useLogReturns, annualize });
});
