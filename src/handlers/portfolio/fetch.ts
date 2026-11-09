import { toYearKey } from '../../../lib/calendar.js';
import { retryAsync } from '../../../lib/http.js';
import { rsiZone } from '../../../lib/indicator-zones.js';
import { normalizePairCodes } from '../../../lib/pair-code.js';
import { fetchTickerPricesMap } from '../../../lib/tickers.js';
import analyzeIndicators from '../../../tools/analyze_indicators.js';
import getCandles from '../../../tools/get_candles.js';
import getMarginPositions from '../../../tools/private/get_margin_positions.js';
import getMarginStatus from '../../../tools/private/get_margin_status.js';
import type { BitbankPrivateClient } from '../../private/client.js';
import { PORTFOLIO_CALENDAR_TZ, portfolioDayStartMs } from './calendar.js';
import { MAX_PAGES, paginateDeposits, paginateWithdrawals } from './pagination.js';
import {
	type CandlePriceData,
	type DepositWithdrawalData,
	type FlowValuationTarget,
	type MarginAccountInfo,
	type RawMarginTrade,
	type RawTrade,
	type TechnicalSummary,
	tryGet,
} from './types.js';

// 約定履歴は公式上限 1000。
const TRADE_PAGE_SIZE = 1000;

export interface PaginateTradesOptions {
	baseParams?: Record<string, string>;
	order?: 'asc' | 'desc';
	limit?: number;
}

export async function paginateTrades(
	client: BitbankPrivateClient,
	options: PaginateTradesOptions = {},
): Promise<{ trades: RawTrade[]; truncated: boolean }> {
	const baseParams = options.baseParams ?? {};
	const order = options.order ?? 'asc';
	const limit = options.limit ?? Number.POSITIVE_INFINITY;
	const cursorKey: 'since' | 'end' = order === 'desc' ? 'end' : 'since';

	const all: RawTrade[] = [];
	const seenIds = new Set<number>();
	let cursor: string | undefined = baseParams[cursorKey];

	for (let page = 0; page < MAX_PAGES; page++) {
		const params: Record<string, string> = {
			...baseParams,
			count: String(TRADE_PAGE_SIZE),
			order,
			...(cursor ? { [cursorKey]: cursor } : {}),
		};
		const result = await tryGet<{ trades: RawTrade[] }>(client, '/v1/user/spot/trade_history', params);
		if (!result.ok) break;
		const batch = normalizePairCodes(result.data.trades || []);
		// API の挙動変更で信用約定が混ざると calcMarginPnl 側と二重計上になるので、現物だけに絞る。
		const spotOnly = batch.filter((t) => t.position_side == null);
		const newRecords = spotOnly.filter((t) => !seenIds.has(t.trade_id));
		for (const t of newRecords) seenIds.add(t.trade_id);
		all.push(...newRecords);
		// truncated 判定はフィルタ前の件数で行う。フィルタ後だと信用比率が高いとき早期終了し、次ページの現物約定を取り逃がす。
		if (batch.length < TRADE_PAGE_SIZE) return { trades: all.slice(0, limit), truncated: false };
		if (all.length >= limit) return { trades: all.slice(0, limit), truncated: true };
		// 進捗の判定は件数ではなくカーソルの前進で行う。件数だと満杯の信用ページに当たった時点で後続の現物約定を取り逃がす。
		const lastTs = batch[batch.length - 1]?.executed_at;
		if (!lastTs) break;
		const nextCursor = String(lastTs);
		if (nextCursor === cursor) return { trades: all.slice(0, limit), truncated: true };
		cursor = nextCursor;
	}
	// dedup で件数がページ幅の倍数にならないので、ループを抜けたら件数によらず未完了として返す。
	return { trades: all.slice(0, limit), truncated: true };
}

// fetchFailed は API エラーで途中終了したときだけ true。信用未利用（trades=[] で完了）と取得失敗を上位で区別するため truncated とは別に持つ。
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
		const batch = normalizePairCodes(result.data.trades || []);
		// type=margin は docs に無く無視されうる。現物が混ざると calcMarginPnl が現物の手数料まで margin_fee_cost として控除する。
		const marginOnly = batch.filter((t) => t.position_side != null);
		const newRecords = marginOnly.filter((t) => !seenIds.has(t.trade_id));
		for (const t of newRecords) seenIds.add(t.trade_id);
		all.push(...newRecords);
		if (batch.length < TRADE_PAGE_SIZE) return { trades: all, truncated: false, fetchFailed: false };
		const lastTs = batch[batch.length - 1]?.executed_at;
		if (!lastTs) break;
		const nextSince = String(lastTs);
		if (nextSince === since) return { trades: all, truncated: true, fetchFailed: false };
		since = nextSince;
	}
	return { trades: all, truncated: true, fetchFailed };
}

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

		const totalItems =
			cryptoDepResult.deposits.length +
			jpyDepResult.deposits.length +
			cryptoWdResult.withdrawals.length +
			jpyWdResult.withdrawals.length;
		if (totalItems === 0 && warnings.length === 4) {
			return { deposits: [], withdrawals: [], warnings, allFailed: true, isComplete: false };
		}

		const rawDeposits = [...cryptoDepResult.deposits, ...jpyDepResult.deposits];
		const rawWithdrawals = [...cryptoWdResult.withdrawals, ...jpyWdResult.withdrawals];

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

export async function fetchMarginAccountInfo(): Promise<MarginAccountInfo> {
	const [statusRes, positionsRes] = await Promise.all([
		getMarginStatus({}).catch(() => null),
		getMarginPositions({}).catch(() => null),
	]);

	return {
		status: statusRes?.ok ? statusRes.data : undefined,
		statusFetchFailed: !statusRes?.ok,
		positions: positionsRes?.ok ? positionsRes.data : undefined,
		positionsFetchFailed: !positionsRes?.ok,
	};
}

export async function fetchTickerPrices(): Promise<Map<string, number>> {
	return (await fetchTickerPricesMap()).prices;
}

// pairs は呼び出し側で小文字化済みのものだけを受ける（API の受け口ではないので正規化しない）。
export async function fetchCandlePriceData(
	pairs: string[],
	yearStartMs: number,
	monthStartMs: number,
	dayStartMs: number,
): Promise<CandlePriceData> {
	const boundaryPrices = new Map<string, { yearStart?: number; monthStart?: number; dayStart?: number }>();
	const dailyPrices = new Map<string, Map<number, number>>();
	// 年初〜当日までの 1day 足 + tz anchor 仕様に合わせた UTC 年 chunk 取得用の余裕
	const limit = 400;

	// date を渡すと getCandles が当日 23:59:59 を未来として弾くので、date は渡さない。
	const promises = pairs.map(async (pair) => {
		try {
			// 日足の区切りは下の JST 0:00 正規化と同じ暦でなければキーがずれる（./calendar.ts）。
			const res = await getCandles(pair, '1day', undefined, limit, PORTFOLIO_CALENDAR_TZ);
			if (!res?.ok) return;

			const normalized = res.data?.normalized;
			if (!Array.isArray(normalized) || normalized.length === 0) return;

			const asset = pair.replace('_jpy', '');
			let yearStartPrice: number | undefined;
			let monthStartPrice: number | undefined;
			let dayStartPrice: number | undefined;
			const priceByDate = new Map<number, number>();

			for (const candle of normalized) {
				const ts = candle.timestamp;
				const open = candle.open;
				if (ts == null || !Number.isFinite(ts) || !Number.isFinite(open) || open <= 0) continue;

				const jstMidnight = portfolioDayStartMs(ts);
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

// 入庫の chunk はこの上限を消費しない。共有すると出庫が増えるだけで入庫が押し出され、取得原価が実行ごとに変わる（#76）。
export const MAX_WITHDRAWAL_FLOW_PRICE_YEAR_CHUNKS = 12;

// 入庫は取れなかった分が原価から丸ごと落ちるので、予算ではなく暴走時の安全弁として実口座で当たらない水準に置く。
export const MAX_DEPOSIT_FLOW_PRICE_YEAR_CHUNKS = 64;

// 同時実行だけを絞り、総数は絞らない（#76）。12 だと内側のリトライと重なってレート制限を自分で誘発する（#81）。
const FLOW_PRICE_FETCH_CONCURRENCY = 4;

// getCandles 内の HTTP リトライとは別に、success:0 や upstream 失敗を chunk 単位で取り直す（#81）。
const FLOW_PRICE_CHUNK_RETRIES = 2;

export interface FlowPriceShortfall {
	deposits: number;
	withdrawals: number;
	/** 出庫は表示専用で銘柄単位の抑止対象にならないので、内訳は入庫だけが持つ（#80）。 */
	depositsByAsset: Map<string, number>;
}

export interface FlowDatePrices {
	dailyPrices: Map<string, Map<number, number>>;
	/** 上限で切り落とした分だけ。上場前や取得失敗で取れない分とは分けて申告する（#76）。 */
	truncatedByChunkLimit: FlowPriceShortfall;
	/** リトライを使い切ってなお失敗した分だけ。その年に足が無い（errorType='user'）は再実行しても変わらないので入れない（#81）。 */
	chunkFetchFailed: FlowPriceShortfall;
}

interface FlowPriceChunk {
	asset: string;
	year: string;
	depositCount: number;
	withdrawalCount: number;
}

const emptyShortfall = (): FlowPriceShortfall => ({ deposits: 0, withdrawals: 0, depositsByAsset: new Map() });

function addShortfall(shortfall: FlowPriceShortfall, chunk: FlowPriceChunk): void {
	shortfall.deposits += chunk.depositCount;
	shortfall.withdrawals += chunk.withdrawalCount;
	if (chunk.depositCount > 0) {
		shortfall.depositsByAsset.set(chunk.asset, (shortfall.depositsByAsset.get(chunk.asset) ?? 0) + chunk.depositCount);
	}
}

// 戻り値は追加取得が不要なら baseDailyPrices そのものなので書き換えない。古い年は引数に混ぜない（equitySeriesQuality の判定が変わる）。
export async function fetchFlowDatePrices(
	baseDailyPrices: Map<string, Map<number, number>>,
	targets: FlowValuationTarget[],
): Promise<FlowDatePrices> {
	const missingYears = new Map<string, FlowPriceChunk>();
	for (const t of targets) {
		if (t.asset === 'jpy') continue;
		if (!Number.isFinite(t.atMs)) continue;
		const dayMs = portfolioDayStartMs(t.atMs);
		if (baseDailyPrices.get(t.asset)?.has(dayMs)) continue;
		// 年も日次キーと同じ JST 暦で数える（`getCandles` に渡す date は anchorTz 解釈のため）。
		const year = toYearKey(dayMs, PORTFOLIO_CALENDAR_TZ);
		const key = `${t.asset}:${year}`;
		const chunk = missingYears.get(key) ?? { asset: t.asset, year, depositCount: 0, withdrawalCount: 0 };
		if (t.kind === 'deposit') chunk.depositCount++;
		else chunk.withdrawalCount++;
		missingYears.set(key, chunk);
	}
	if (missingYears.size === 0) {
		return {
			dailyPrices: baseDailyPrices,
			truncatedByChunkLimit: emptyShortfall(),
			chunkFetchFailed: emptyShortfall(),
		};
	}

	const all = [...missingYears.values()];
	// 上限は古い年から埋める。新しい入庫が増えても既存の順位が動かず、過去の原価が書き換わらない。
	const depositChunks = all
		.filter((c) => c.depositCount > 0)
		.sort((a, b) => (a.year === b.year ? a.asset.localeCompare(b.asset) : a.year.localeCompare(b.year)));
	// 出庫だけが要求する組は表示専用なので新しい年を優先する。
	const withdrawalOnlyChunks = all
		.filter((c) => c.depositCount === 0)
		.sort((a, b) => (a.year === b.year ? a.asset.localeCompare(b.asset) : b.year.localeCompare(a.year)));

	const selected = [
		...depositChunks.slice(0, MAX_DEPOSIT_FLOW_PRICE_YEAR_CHUNKS),
		...withdrawalOnlyChunks.slice(0, MAX_WITHDRAWAL_FLOW_PRICE_YEAR_CHUNKS),
	];
	const truncatedByChunkLimit = emptyShortfall();
	for (const c of depositChunks.slice(MAX_DEPOSIT_FLOW_PRICE_YEAR_CHUNKS)) {
		// 入庫の上限で切られた組に相乗りしていた出庫も一緒に落ちる（出庫の残枠で拾い直さない）。
		addShortfall(truncatedByChunkLimit, c);
	}
	for (const c of withdrawalOnlyChunks.slice(MAX_WITHDRAWAL_FLOW_PRICE_YEAR_CHUNKS)) {
		addShortfall(truncatedByChunkLimit, c);
	}

	const merged = new Map<string, Map<number, number>>();
	for (const [asset, byDate] of baseDailyPrices) merged.set(asset, new Map(byDate));

	const chunkFetchFailed = emptyShortfall();
	const markFailed = (chunk: FlowPriceChunk) => addShortfall(chunkFetchFailed, chunk);

	// errorType='user' はその年に足が無いことの表明で再実行しても変わらない。失敗に数えると上場前の入庫で原価が永久に出せなくなる（#80）。
	const isTransientFailure = (res: { meta?: { errorType?: string } } | undefined): boolean =>
		res?.meta?.errorType !== 'user';

	// リトライと計上を同じ述語で判定し、chunkFetchFailed に載るのはリトライを使い切った結果だけにする。
	const isChunkFetchFailure = (res: Awaited<ReturnType<typeof getCandles>> | undefined): boolean => {
		if (!res?.ok) return isTransientFailure(res);
		const normalized = res.data?.normalized;
		return !Array.isArray(normalized) || normalized.length === 0;
	};

	await runWithConcurrency(selected, FLOW_PRICE_FETCH_CONCURRENCY, async (chunk) => {
		const { asset, year } = chunk;
		try {
			const res = await retryAsync(() => getCandles(`${asset}_jpy`, '1day', year, 400, PORTFOLIO_CALENDAR_TZ), {
				retries: FLOW_PRICE_CHUNK_RETRIES,
				shouldRetry: isChunkFetchFailure,
			});
			if (!res?.ok) {
				if (isTransientFailure(res)) markFailed(chunk);
				return;
			}
			const normalized = res.data?.normalized;
			if (!Array.isArray(normalized) || normalized.length === 0) {
				markFailed(chunk);
				return;
			}

			let byDate = merged.get(asset);
			if (!byDate) {
				byDate = new Map<number, number>();
				merged.set(asset, byDate);
			}
			for (const candle of normalized) {
				const ts = candle.timestamp;
				const open = candle.open;
				if (ts == null || !Number.isFinite(ts) || !Number.isFinite(open) || open <= 0) continue;
				const dayMs = portfolioDayStartMs(ts);
				if (!byDate.has(dayMs)) byDate.set(dayMs, open);
			}
		} catch {
			markFailed(chunk);
		}
	});

	return { dailyPrices: merged, truncatedByChunkLimit, chunkFetchFailed };
}

// lib/candle-fetch.ts の mergeChunks は chunk 単位の成否を分けられず、バッチ間の実タイマー遅延で fake timers 下のテストが止まるので使わない。
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
	let cursor = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		// cursor の読み書きは await を挟まないので、単一スレッドの JS では競合しない。
		while (cursor < items.length) {
			const item = items[cursor];
			cursor++;
			if (item === undefined) return;
			await worker(item);
		}
	});
	await Promise.all(runners);
}

const MAX_TECHNICAL_PAIRS = 5;

export async function fetchTechnical(pairs: string[]): Promise<TechnicalSummary[]> {
	const results: TechnicalSummary[] = [];
	const targets = pairs.slice(0, MAX_TECHNICAL_PAIRS);
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

			const trend = data.trend;

			const isBullish = trend === 'uptrend' || trend === 'strong_uptrend';
			const isBearish = trend === 'downtrend' || trend === 'strong_downtrend';
			let signal = 'neutral';
			const zone = rsiZone(rsi14);
			if (zone === 'overbought') {
				signal = isBullish ? 'bullish' : 'overbought';
			} else if (zone === 'oversold') {
				signal = isBearish ? 'bearish' : 'oversold';
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
