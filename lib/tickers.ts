/**
 * tickers_jpy 取得ユーティリティ
 *
 * public API `/tickers_jpy` を叩いて「asset → 最新価格」の Map を構築する共通処理。
 * get_my_assets / analyze_my_portfolio が共有する。URL は共有定数 `BITBANK_API_BASE`
 * を使い、環境変数 `TICKERS_JPY_URL` で上書きできる（get_tickers_jpy と同じ先例）。
 */

import { toNum } from './conversions.js';
import { BITBANK_API_BASE } from './http.js';

/** tickers_jpy レスポンスの最小形 */
interface TickersJpyResponse {
	success?: number;
	data?: Array<{ pair: string; last: string }>;
}

/** fetchTickerPricesMap の戻り値 */
export interface TickerPricesResult {
	/** asset（`_jpy` を除いたシンボル）→ 最新価格。失敗時は空 Map。 */
	prices: Map<string, number>;
	/** 取得に失敗した場合の理由（非致命的）。成功時は undefined。 */
	error?: string;
}

/**
 * public API の tickers_jpy から各通貨（asset）の最新価格 Map を構築する。
 *
 * 失敗しても throw せず、空 Map + error 文字列を返す（非致命的）。
 * 呼び出し側は error を warning に転用するか、prices のみを使う。
 *
 * - URL は `process.env.TICKERS_JPY_URL` で上書き可能（既定 `${BITBANK_API_BASE}/tickers_jpy`）。
 * - 数値は toNum で正規化し、`last > 0` のみ採用する。
 * - fetch 機構は raw fetch + `AbortSignal.timeout(3000)`（fetchJson 系への移行は retry/429
 *   挙動が変わるため対象外）。
 */
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
			const asset = item.pair.replace('_jpy', '');
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
