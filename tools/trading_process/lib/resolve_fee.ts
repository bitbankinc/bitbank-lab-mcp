// エンジンは t+1 open 執行（taker 相当）なので taker レートだけを動的に解決する。取得失敗やペア未発見では公称 taker に落として機能を止めない。
// TODO: エンジンが maker 約定を表現できるようになったら、指値戦略は feeRole / maker レートへ切り替える。

import { getErrorMessage } from '../../../lib/error.js';
import { DEFAULT_TAKER_FALLBACK, resolveFeeRate } from '../../../lib/fees.js';
import { fetchPairsSpec } from '../../../lib/pairs.js';

const BP_PER_RATE = 10000;

// 率 × 10000 が 11.9999… のように桁あふれするので小数 4 桁で丸める。
export const DEFAULT_FEE_BP = Number((DEFAULT_TAKER_FALLBACK * BP_PER_RATE).toFixed(4));

export type FeeSource = 'explicit' | 'dynamic' | 'fallback';

export interface ResolvedFee {
	fee_bp: number;
	source: FeeSource;
	warning?: string;
}

export async function resolveBacktestFeeBp(pair: string, explicitFeeBp?: number): Promise<ResolvedFee> {
	// override 最優先。0 / 任意値もそのまま尊重する（既存バックテストの再現性のため）。
	if (explicitFeeBp != null) {
		return { fee_bp: explicitFeeBp, source: 'explicit' };
	}

	try {
		const pairsMap = await fetchPairsSpec();
		const spec = pairsMap.get(pair.toLowerCase());
		if (!spec) {
			return {
				fee_bp: DEFAULT_FEE_BP,
				source: 'fallback',
				warning: `手数料: ペア '${pair}' が /spot/pairs に見つからないため公称 ${DEFAULT_FEE_BP} bp で概算します。`,
			};
		}
		// taker レートを解決（spec の taker_fee_rate_quote 欠損時は lib/fees.ts が公称率に落とす）。
		const rate = resolveFeeRate(spec, 'taker');
		return { fee_bp: rate * BP_PER_RATE, source: 'dynamic' };
	} catch (err) {
		return {
			fee_bp: DEFAULT_FEE_BP,
			source: 'fallback',
			warning: `手数料: /spot/pairs 取得失敗のため公称 ${DEFAULT_FEE_BP} bp で概算します: ${getErrorMessage(err)}`,
		};
	}
}
