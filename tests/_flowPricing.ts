// 本番の `FlowPricing` は「入出庫日の 1day open → 現在価格」の 2 段構えなので、どちらの経路を通したいかを呼び出し側に明示させるため、経路ごとに別のビルダーを用意する。

import { portfolioDayStartMs } from '../src/handlers/portfolio/calendar.js';
import type { FlowPricing } from '../src/handlers/portfolio/types.js';

export function currentPriceOnly(currentPrices: Map<string, number> = new Map()): FlowPricing {
	return { dailyPrices: new Map(), currentPrices };
}

/** 本番と同じ `portfolioDayStartMs`（JST 暦日 0:00）で丸めてから登録する（同じ暦で引かないとキーがずれて黙って現在価格に落ちる）。 */
export function withDailyPrices(
	dated: Array<{ asset: string; atMs: number; price: number }>,
	currentPrices: Map<string, number> = new Map(),
): FlowPricing {
	const dailyPrices = new Map<string, Map<number, number>>();
	for (const { asset, atMs, price } of dated) {
		let byDate = dailyPrices.get(asset);
		if (!byDate) {
			byDate = new Map<number, number>();
			dailyPrices.set(asset, byDate);
		}
		byDate.set(portfolioDayStartMs(atMs), price);
	}
	return { dailyPrices, currentPrices };
}
