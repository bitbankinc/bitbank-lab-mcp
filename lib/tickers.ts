import { toNum } from './conversions.js';
import { BITBANK_API_BASE, fetchJson } from './http.js';
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
	const url = `${BITBANK_API_BASE}/tickers_jpy`;
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

export interface PairTicker {
	last: number;
	bestAsk: number | null;
	bestBid: number | null;
}

// 取得失敗・応答不正は null。呼び出し側は検証や見積りを「判定できない」として続行する。
export async function fetchPairTicker(
	pair: string,
	options: { timeoutMs?: number; retries?: number } = {},
): Promise<PairTicker | null> {
	try {
		const url = `${BITBANK_API_BASE}/${pair}/ticker`;
		const json = (await fetchJson(url, { timeoutMs: options.timeoutMs ?? 5000, retries: options.retries })) as {
			success?: number;
			data?: { last?: string; sell?: string; buy?: string };
		};
		if (json?.success !== 1 || !json.data?.last) return null;
		const last = toNum(json.data.last);
		if (last == null) return null;
		return { last, bestAsk: toNum(json.data.sell), bestBid: toNum(json.data.buy) };
	} catch {
		return null;
	}
}
