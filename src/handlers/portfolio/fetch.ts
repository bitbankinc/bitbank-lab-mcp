/**
 * portfolio/fetch — API データ取得レイヤー。
 *
 * Private API（入出金・約定履歴）のページネーション、
 * Public API（ticker・キャンドル）の取得、テクニカル分析の取得を担当。
 */

import { dayjs } from '../../../lib/datetime.js';
import analyzeIndicators from '../../../tools/analyze_indicators.js';
import type { BitbankPrivateClient } from '../../private/client.js';
import {
	type CandlePriceData,
	type DepositWithdrawalData,
	type RawDeposit,
	type RawMarginTrade,
	type RawTrade,
	type RawWithdrawal,
	type TechnicalSummary,
	tryGet,
} from './types.js';

// ── Configuration ──
const MAX_PAGES = 10;
// 約定履歴は公式上限 1000。入出金履歴は公式上限 100（POST /v1/user/{deposit,withdrawal}_history）。
const TRADE_PAGE_SIZE = 1000;
const DW_PAGE_SIZE = 100;

async function paginateDeposits(
	client: BitbankPrivateClient,
	baseParams: Record<string, string>,
	sinceMs?: number,
): Promise<{ deposits: RawDeposit[]; complete: boolean; error?: string }> {
	const all: RawDeposit[] = [];
	const seenIds = new Set<string>();
	let since: string | undefined = sinceMs != null ? String(sinceMs) : undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const params = { ...baseParams, count: String(DW_PAGE_SIZE), ...(since ? { since } : {}) };
		const result = await tryGet<{ deposits: RawDeposit[] }>(client, '/v1/user/deposit_history', params);
		if (!result.ok) {
			return { deposits: all, complete: false, error: result.error };
		}
		const batch = result.data.deposits || [];
		const newRecords = batch.filter((d) => !seenIds.has(d.uuid));
		for (const d of newRecords) seenIds.add(d.uuid);
		all.push(...newRecords);
		if (batch.length < DW_PAGE_SIZE) {
			return { deposits: all, complete: true };
		}
		// 同一タイムスタンプが DW_PAGE_SIZE 件以上連続して進捗しない場合の保険
		if (newRecords.length === 0) return { deposits: all, complete: false };
		// 次ページ: 最後のレコードの confirmed_at を since に（同一 ts のレコードを次ページに含めて再取得し、dedup する）
		const lastTs = batch[batch.length - 1]?.confirmed_at;
		if (!lastTs) break;
		since = String(lastTs);
	}
	return { deposits: all, complete: false };
}

async function paginateWithdrawals(
	client: BitbankPrivateClient,
	baseParams: Record<string, string>,
	sinceMs?: number,
): Promise<{ withdrawals: RawWithdrawal[]; complete: boolean; error?: string }> {
	const all: RawWithdrawal[] = [];
	const seenIds = new Set<string>();
	let since: string | undefined = sinceMs != null ? String(sinceMs) : undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const params = { ...baseParams, count: String(DW_PAGE_SIZE), ...(since ? { since } : {}) };
		const result = await tryGet<{ withdrawals: RawWithdrawal[] }>(client, '/v1/user/withdrawal_history', params);
		if (!result.ok) {
			return { withdrawals: all, complete: false, error: result.error };
		}
		const batch = result.data.withdrawals || [];
		const newRecords = batch.filter((w) => !seenIds.has(w.uuid));
		for (const w of newRecords) seenIds.add(w.uuid);
		all.push(...newRecords);
		if (batch.length < DW_PAGE_SIZE) {
			return { withdrawals: all, complete: true };
		}
		// 同一タイムスタンプが DW_PAGE_SIZE 件以上連続して進捗しない場合の保険
		if (newRecords.length === 0) return { withdrawals: all, complete: false };
		const lastTs = batch[batch.length - 1]?.requested_at;
		if (!lastTs) break;
		since = String(lastTs);
	}
	return { withdrawals: all, complete: false };
}

/**
 * ページネーション付きで現物約定履歴を取得（最大 MAX_PAGES ページ、古い順）。
 *
 * 公式 docs (bitbankinc/bitbank-api-docs) は trade_history の `position_side` を
 * 「信用取引の時のみ」と明記しているため、現物エンドポイントから返るレコードには
 * 通常 `position_side` が含まれない。ただし API 側の挙動変更や信用約定の混入により
 * `position_side != null` のレコードが現物経路に流れ込むと、calcPnl が信用約定を
 * 現物の移動平均原価に取り込み、別経路の `paginateMarginTrades` + `calcMarginPnl`
 * と二重計上になる。防御的に `position_side == null` で現物のみに絞る
 * （paginateMarginTrades の `position_side != null` フィルタと対称化）。
 */
export async function paginateTrades(
	client: BitbankPrivateClient,
	sinceMs?: number,
): Promise<{ trades: RawTrade[]; truncated: boolean }> {
	const all: RawTrade[] = [];
	const seenIds = new Set<number>();
	let since: string | undefined = sinceMs != null ? String(sinceMs) : undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const params: Record<string, string> = { count: String(TRADE_PAGE_SIZE), order: 'asc' };
		if (since) params.since = since;
		const result = await tryGet<{ trades: RawTrade[] }>(client, '/v1/user/spot/trade_history', params);
		if (!result.ok) break;
		const batch = result.data.trades || [];
		// 信用約定（position_side 付き）が混入した場合に備え、現物のみに絞る。
		const spotOnly = batch.filter((t) => t.position_side == null);
		const newRecords = spotOnly.filter((t) => !seenIds.has(t.trade_id));
		for (const t of newRecords) seenIds.add(t.trade_id);
		all.push(...newRecords);
		// truncated 判定はフィルタ前の batch.length を使う。フィルタ後の長さで判定すると
		// 信用比率が高いとき早期終了し、次ページの現物約定を取り逃がす（paginateMarginTrades と同じ理由）。
		if (batch.length < TRADE_PAGE_SIZE) return { trades: all, truncated: false };
		// 同一タイムスタンプが TRADE_PAGE_SIZE 件以上連続して進捗しない場合の保険。
		// カーソルベース（since の前進有無）で判定して、満杯信用ページに当たった瞬間に
		// 後続の現物約定を取り逃がさないようにする（paginateMarginTrades と同じ）。
		const lastTs = batch[batch.length - 1]?.executed_at;
		if (!lastTs) break;
		const nextSince = String(lastTs);
		if (nextSince === since) return { trades: all, truncated: true };
		since = nextSince;
	}
	// ループ脱出は全て未完了（MAX_PAGES 到達 / API エラー / lastTs 欠損）。
	// 境界 dedup で all.length が TRADE_PAGE_SIZE の倍数にならないケースを誤って完了扱いしないよう、
	// 早期 return の通常完了パス以外は truncated=true で返す。
	return { trades: all, truncated: true };
}

/**
 * ページネーション付きで信用約定履歴を取得（type=margin、最大 MAX_PAGES ページ、古い順）。
 * 信用未利用や API 失敗時でも空配列で安全に返し、analyze_my_portfolio が落ちないようにする。
 *
 * 公式 docs (bitbankinc/bitbank-api-docs) の trade_history パラメータには `type=margin`
 * が記載されておらず、API が未知パラメータを無視する可能性がある。その場合は現物約定が
 * 混入し、calcMarginPnl が現物の fee_occurred_amount_quote まで margin_fee として控除して
 * account_pnl を過小表示してしまう。docs では position_side が「信用取引の時のみ」と
 * 明記されているため、position_side != null で margin 約定のみに絞る防御フィルタを掛ける。
 *
 * 戻り値の `truncated` は MAX_PAGES 到達 / lastTs 欠損などの「データ不完全」全般のシグナル
 * （現状の意味を維持）。`fetchFailed` は API エラーで途中終了した場合のみ true で、
 * 「信用未使用 (trades=[], 完了)」と「fetch 失敗で取得不能 (trades=[], 失敗)」を上位で
 * 区別できるようにするための独立フラグ。
 */
export async function paginateMarginTrades(
	client: BitbankPrivateClient,
	sinceMs?: number,
): Promise<{ trades: RawMarginTrade[]; truncated: boolean; fetchFailed: boolean }> {
	const all: RawMarginTrade[] = [];
	const seenIds = new Set<number>();
	let since: string | undefined = sinceMs != null ? String(sinceMs) : undefined;
	let fetchFailed = false;
	for (let page = 0; page < MAX_PAGES; page++) {
		const params: Record<string, string> = { type: 'margin', count: String(TRADE_PAGE_SIZE), order: 'asc' };
		if (since) params.since = since;
		const result = await tryGet<{ trades: RawMarginTrade[] }>(client, '/v1/user/spot/trade_history', params);
		if (!result.ok) {
			fetchFailed = true;
			break;
		}
		const batch = result.data.trades || [];
		// type=margin が無視された場合に備え、position_side != null で margin 約定のみに絞る。
		const marginOnly = batch.filter((t) => t.position_side != null);
		const newRecords = marginOnly.filter((t) => !seenIds.has(t.trade_id));
		for (const t of newRecords) seenIds.add(t.trade_id);
		all.push(...newRecords);
		// truncated 判定はフィルタ前の batch.length を使う。フィルタ後の長さで判定すると
		// 現物比率が高いとき早期終了し、次ページの margin 約定を取り逃がす。
		if (batch.length < TRADE_PAGE_SIZE) return { trades: all, truncated: false, fetchFailed: false };
		const lastTs = batch[batch.length - 1]?.executed_at;
		if (!lastTs) break;
		// 同一タイムスタンプ満杯ループの保険はカーソルベース（marginOnly 件数ではなく
		// since の前進有無）で判定する。marginOnly 件数で判定すると、古い順 (asc) 取得で
		// 「初期は現物のみ → 途中から信用利用開始」の口座で満杯現物ページに当たった瞬間に
		// 後続の信用約定を取り逃がしてしまう。
		const nextSince = String(lastTs);
		if (nextSince === since) return { trades: all, truncated: true, fetchFailed: false };
		since = nextSince;
	}
	// ループ脱出は全て未完了（MAX_PAGES 到達 / API エラー / lastTs 欠損）。paginateTrades と同じ扱い。
	return { trades: all, truncated: true, fetchFailed };
}

/**
 * 入出金履歴を取得する（JPY + 暗号資産の両方、ページネーション対応）。
 * sinceMs を指定すると、その日時以降のデータのみ取得する。
 * 全リクエスト失敗時は null を返す。一部失敗時は warnings 付きで返す。
 */
export async function fetchDepositWithdrawal(
	client: BitbankPrivateClient,
	sinceMs?: number,
): Promise<DepositWithdrawalData | null> {
	try {
		const [cryptoDepResult, jpyDepResult, cryptoWdResult, jpyWdResult] = await Promise.all([
			paginateDeposits(client, {}, sinceMs),
			paginateDeposits(client, { asset: 'jpy' }, sinceMs),
			paginateWithdrawals(client, {}, sinceMs),
			paginateWithdrawals(client, { asset: 'jpy' }, sinceMs),
		]);

		const warnings: string[] = [];
		const apiResults = [
			{ error: cryptoDepResult.error, label: '暗号資産入庫履歴' },
			{ error: jpyDepResult.error, label: 'JPY入金履歴' },
			{ error: cryptoWdResult.error, label: '暗号資産出庫履歴' },
			{ error: jpyWdResult.error, label: 'JPY出金履歴' },
		];
		for (const { error, label } of apiResults) {
			if (error) {
				warnings.push(`${label}の取得に失敗: ${error}`);
			}
		}

		// 全チャネルでデータゼロかつエラーあり = 全失敗
		const totalItems =
			cryptoDepResult.deposits.length +
			jpyDepResult.deposits.length +
			cryptoWdResult.withdrawals.length +
			jpyWdResult.withdrawals.length;
		if (totalItems === 0 && warnings.length === 4) {
			return { deposits: [], withdrawals: [], warnings, allFailed: true, isComplete: false };
		}

		// 成功分からデータを収集
		const rawDeposits = [...cryptoDepResult.deposits, ...jpyDepResult.deposits];
		const rawWithdrawals = [...cryptoWdResult.withdrawals, ...jpyWdResult.withdrawals];

		// UUID で重複排除
		const seenDeposit = new Set<string>();
		const allDeposits = rawDeposits.filter((d) => {
			if (seenDeposit.has(d.uuid)) return false;
			seenDeposit.add(d.uuid);
			return true;
		});

		const seenWithdrawal = new Set<string>();
		const allWithdrawals = rawWithdrawals.filter((w) => {
			if (seenWithdrawal.has(w.uuid)) return false;
			seenWithdrawal.add(w.uuid);
			return true;
		});

		const isComplete =
			cryptoDepResult.complete && jpyDepResult.complete && cryptoWdResult.complete && jpyWdResult.complete;

		return { deposits: allDeposits, withdrawals: allWithdrawals, warnings, allFailed: false, isComplete };
	} catch {
		return null;
	}
}

// ── Ticker 取得 ──

export async function fetchTickerPrices(): Promise<Map<string, number>> {
	const prices = new Map<string, number>();
	try {
		const res = await fetch('https://public.bitbank.cc/tickers_jpy', {
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) return prices;
		const json = (await res.json()) as { success?: number; data?: Array<{ pair: string; last: string }> };
		if (json.success !== 1 || !Array.isArray(json.data)) return prices;
		for (const item of json.data) {
			const asset = item.pair.replace('_jpy', '');
			const last = Number(item.last);
			if (Number.isFinite(last) && last > 0) prices.set(asset, last);
		}
	} catch {
		/* ticker 失敗は非致命的 */
	}
	return prices;
}

/**
 * 1dayキャンドルから期初始値 + 全日次始値マップを一括取得する。
 * boundaryPrices: 既存の年初/月初/日初パフォーマンス計算用。
 * dailyPrices: 資産推移時系列（equity series）構築用。asset → (candleTimestampMs → openPrice)。
 */
export async function fetchCandlePriceData(
	pairs: string[],
	yearStartMs: number,
	monthStartMs: number,
	dayStartMs: number,
): Promise<CandlePriceData> {
	const boundaryPrices = new Map<string, { yearStart?: number; monthStart?: number; dayStart?: number }>();
	const dailyPrices = new Map<string, Map<number, number>>();
	const nowJst = dayjs().tz('Asia/Tokyo');
	const year = nowJst.year();

	const promises = pairs.map(async (pair) => {
		try {
			const url = `https://public.bitbank.cc/${pair}/candlestick/1day/${year}`;
			const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
			if (!res.ok) return;
			const json = (await res.json()) as {
				success?: number;
				data?: { candlestick?: Array<{ ohlcv?: Array<Array<string | number>> }> };
			};
			if (json.success !== 1) return;

			const ohlcv = json.data?.candlestick?.[0]?.ohlcv;
			if (!Array.isArray(ohlcv) || ohlcv.length === 0) return;

			const asset = pair.replace('_jpy', '');
			let yearStartPrice: number | undefined;
			let monthStartPrice: number | undefined;
			let dayStartPrice: number | undefined;
			const priceByDate = new Map<number, number>();

			for (const candle of ohlcv) {
				const ts = Number(candle[5]);
				const open = Number(candle[0]);
				if (!Number.isFinite(open) || open <= 0) continue;

				// Normalize to JST midnight so keys match buildEquitySeries date lookups
				const jstMidnight = dayjs(ts).tz('Asia/Tokyo').startOf('day').valueOf();
				priceByDate.set(jstMidnight, open);

				if (yearStartPrice == null && ts >= yearStartMs) {
					yearStartPrice = open;
				}
				if (monthStartPrice == null && ts >= monthStartMs) {
					monthStartPrice = open;
				}
				if (dayStartPrice == null && ts >= dayStartMs) {
					dayStartPrice = open;
				}
			}

			boundaryPrices.set(asset, { yearStart: yearStartPrice, monthStart: monthStartPrice, dayStart: dayStartPrice });
			dailyPrices.set(asset, priceByDate);
		} catch {
			// Non-fatal: price unavailable for this pair
		}
	});

	await Promise.all(promises);
	return { boundaryPrices, dailyPrices };
}

// ── テクニカル分析 ──

export async function fetchTechnical(pairs: string[]): Promise<TechnicalSummary[]> {
	const results: TechnicalSummary[] = [];
	// 並列で取得（最大5通貨に制限）
	const targets = pairs.slice(0, 5);
	const promises = targets.map(async (pair) => {
		try {
			const res = await analyzeIndicators(pair, '1day', 60);
			if (!res?.ok) return null;
			const data = res.data;
			const indicators = data.indicators;
			const rsi14 = indicators.RSI_14 != null ? Number(indicators.RSI_14) : undefined;
			const sma25 = indicators.SMA_25 != null ? Number(indicators.SMA_25) : undefined;
			const lastClose = data.normalized?.at?.(-1)?.close;

			let smaDeviation: number | undefined;
			if (sma25 && lastClose && Number.isFinite(sma25) && Number.isFinite(lastClose)) {
				smaDeviation = Math.round(((lastClose - sma25) / sma25) * 10000) / 100;
			}

			// trend は analyzeIndicators の data に含まれる
			const trend = data.trend;

			// 総合判定: RSI とトレンドを組み合わせて判定
			// analyzeIndicators の trend は uptrend/strong_uptrend/downtrend/strong_downtrend/sideways
			const isBullish = trend === 'uptrend' || trend === 'strong_uptrend';
			const isBearish = trend === 'downtrend' || trend === 'strong_downtrend';
			let signal = 'neutral';
			if (rsi14 != null) {
				if (rsi14 >= 70) {
					// RSI 買われすぎ: 上昇トレンド中なら強気維持、それ以外は過熱警告
					signal = isBullish ? 'bullish' : 'overbought';
				} else if (rsi14 <= 30) {
					// RSI 売られすぎ: 下落トレンド中は弱気継続（落ちるナイフ）、それ以外は反発期待
					signal = isBearish ? 'bearish' : 'oversold';
				}
			}
			if (signal === 'neutral') {
				if (isBullish) signal = 'bullish';
				else if (isBearish) signal = 'bearish';
			}

			return {
				pair,
				trend,
				rsi_14: rsi14 != null ? Math.round(rsi14 * 100) / 100 : undefined,
				sma_deviation_pct: smaDeviation,
				signal,
			};
		} catch {
			return null;
		}
	});

	const settled = await Promise.all(promises);
	for (const r of settled) {
		if (r) results.push(r);
	}
	return results;
}
