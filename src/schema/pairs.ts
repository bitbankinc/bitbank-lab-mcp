import { z } from 'zod';

export const RefreshPairsCacheInputSchema = z.object({
	pair: z.string().optional().describe('注記表示する対象ペア（例: btc_jpy）。指定しても再取得は全ペア対象。'),
});
