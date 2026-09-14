/**
 * テスト用 `FlowPricing`（暗号資産入出庫の JPY 換算に使う価格ソース）ビルダー。
 *
 * 本番の `FlowPricing` は「入出庫日の 1day open → 現在価格」の 2 段構えなので、
 * どちらの経路を通したいかがテストの意図そのものになる。意図を呼び出し側に明示させるため、
 * 経路ごとに別のビルダーを用意する。
 */

import { portfolioDayStartMs } from '../src/handlers/portfolio/calendar.js';
import type { FlowPricing } from '../src/handlers/portfolio/types.js';

/**
 * 日次価格を一切持たない `FlowPricing`。全件が現在価格フォールバックに落ちる。
 * 入出庫日価格の導入前と同じ経路を通るため、既存挙動の回帰確認に使う。
 */
export function currentPriceOnly(currentPrices: Map<string, number> = new Map()): FlowPricing {
	return { dailyPrices: new Map(), currentPrices };
}

/**
 * 指定した (資産, 時刻) の日次始値を持つ `FlowPricing` を組み立てる。
 *
 * `atMs` はキー正規化前の任意の時刻でよく、本番と同じ `portfolioDayStartMs`（JST 暦日 0:00）で
 * 丸めてから登録する。同じ暦で引かないとキーがずれて黙って現在価格に落ちるため、
 * テスト側でも丸めを再実装せず本番の関数を共有する。
 */
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
