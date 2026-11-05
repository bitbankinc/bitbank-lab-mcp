import getTransactions from '../tools/get_transactions.js';
import { intArg, parseArgs, runCli } from './cli-utils.js';

runCli(() => {
	const { positional } = parseArgs();
	const pair = positional[0] || 'btc_jpy';
	const limit = intArg(positional[1], 100);
	const date = positional[2];
	return getTransactions(pair, limit, date);
});
