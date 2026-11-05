import getCandles from '../tools/get_candles.js';
import { intArg, parseArgs, runCli } from './cli-utils.js';

runCli(() => {
	const { positional } = parseArgs();
	const [pair, type, date, limitStr] = positional;

	if (!pair || !type) {
		console.error('Usage: tsx tools/get_candles_cli.ts <pair> <type> [date:YYYY|YYYYMMDD] [limit]');
		console.error('Example: tsx tools/get_candles_cli.ts btc_jpy 1hour 20240511');
		console.error('Example: tsx tools/get_candles_cli.ts btc_jpy 1month 2024');
		process.exit(1);
	}

	const limit = intArg(limitStr, 200);
	return getCandles(pair, type, date, limit);
});
