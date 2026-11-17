// /ticker 取得失敗時は null（違反なし）で発注を続けさせる。bitbank 本 API 側でも同等の検証があるのでガードは失われない。

import { formatPrice } from './formatter.js';
import { fetchPairTicker } from './tickers.js';

export async function validateTriggerPrice(
	pair: string,
	side: 'buy' | 'sell',
	triggerPrice: number,
): Promise<string | null> {
	const ticker = await fetchPairTicker(pair);
	if (ticker == null) return null;
	const currentPrice = ticker.last;

	if (side === 'sell' && triggerPrice >= currentPrice) {
		return [
			`stop sell のトリガー価格（${formatPrice(triggerPrice)}）が現在価格（${formatPrice(currentPrice)}）以上のため、即時発動してしまいます。`,
			'stop sell は「価格がトリガー以下に下落したとき」に発動します（損切り用）。',
			'R1 上抜けで利確したい場合は limit sell を使用してください。',
		].join('\n');
	}

	if (side === 'buy' && triggerPrice <= currentPrice) {
		return [
			`stop buy のトリガー価格（${formatPrice(triggerPrice)}）が現在価格（${formatPrice(currentPrice)}）以下のため、即時発動してしまいます。`,
			'stop buy は「価格がトリガー以上に上昇したとき」に発動します（ブレイクアウト買い用）。',
			'指定価格以下で買いたい場合は limit buy を使用してください。',
		].join('\n');
	}

	return null;
}
