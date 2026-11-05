// URL は環境変数 TICKERS_JPY_URL で上書きできる（get_tickers_jpy と同じ先例）。

import { toNum } from './conversions.js';
import { BITBANK_API_BASE } from './http.js';
import { normalizePairCode } from './pair-code.js';

interface TickersJpyResponse {
	success?: number;
	data?: Array<{ pair: string; last: string }>;
}

export interface TickerPricesResult {
	prices: Map<string, number>;
	error?: string;
}

// raw fetch のまま。fetchJson 系に移すと retry / 429 の挙動が変わるので対象外にしている。
export async function fetchTickerPricesMap(): Promise<TickerPricesResult> {
	const url = String(process.env.TICKERS_JPY_URL || `${BITBANK_API_BASE}/tickers_jpy`);
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
		if (!res.ok) {
			return { prices: new Map(), error: `ticker HTTP ${res.status}` };
		}
		const json = (await res.json()) as TickersJpyResponse;
		if (json.success !== 1 || !Array.isArray(json.data)) {
			return { prices: new Map(), error: 'ticker レスポンス不正' };
		}

		const prices = new Map<string, number>();
		for (const item of json.data) {
			// 大文字だと BTC_JPY がキーになって全銘柄で lookup が外れるので、取得境界で正規化する。
			const asset = normalizePairCode(item.pair).replace('_jpy', '');
			const last = toNum(item.last);
			if (last != null && last > 0) {
				prices.set(asset, last);
			}
		}
		return { prices };
	} catch (e) {
		return { prices: new Map(), error: e instanceof Error ? e.message : 'ticker 取得失敗' };
	}
}
