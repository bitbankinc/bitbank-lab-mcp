/**
 * portfolio/fetch — API データ取得レイヤー。
 *
 * Private API（入出金・約定履歴）のページネーション、
 * Public API（ticker・キャンドル）の取得、テクニカル分析の取得を担当。
 */

import { normalizeAssetCodes } from '../../../lib/asset-code.js';
import { toYearKey } from '../../../lib/calendar.js';
import { retryAsync } from '../../../lib/http.js';
import { normalizePairCodes } from '../../../lib/pair-code.js';
import { fetchTickerPricesMap } from '../../../lib/tickers.js';
import analyzeIndicators from '../../../tools/analyze_indicators.js';
import getCandles from '../../../tools/get_candles.js';
import getMarginPositions from '../../../tools/private/get_margin_positions.js';
import getMarginStatus from '../../../tools/private/get_margin_status.js';
import type { BitbankPrivateClient } from '../../private/client.js';
import { PORTFOLIO_CALENDAR_TZ, portfolioDayStartMs } from './calendar.js';
import {
	type CandlePriceData,
	type DepositWithdrawalData,
	type FlowValuationTarget,
	type MarginAccountInfo,
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
		// 取得境界での asset 正規化。以降の消費側（portfolio/calc.ts）は小文字前提で
		// JPY 判定・prices 検索・holdings キーを組むため、ここで前提を担保する
		// （防御的正規化。現行 API は小文字を返す。`lib/asset-code.ts` 参照）。
		const batch = normalizeAssetCodes(result.data.deposits || []);
		const newRecords = batch.filter((d) => !seenIds.has(d.uuid));
		for (const d of newRecords) seenIds.add(d.uuid);
		all.push(...newRecords);
		if (batch.length < DW_PAGE_SIZE) {
			return { deposits: all, complete: true };
		}
		// 同一タイムスタンプが DW_PAGE_SIZE 件以上連続して進捗しない場合の保険
		if (newRecords.length === 0) return { deposits: all, complete: false };
		// 次ページ: 最後のレコードの confirmed_at を since に（同一 ts のレコードを次ページに含めて再取得し、dedup する）。
		// confirmed_at は確認済の入金にのみ存在する（docs: "exists only for confirmed one"）。
		// 末尾が未確認入金（status:'FOUND'）だと confirmed_at が欠落しカーソルが進まないため、
		// 常在する found_at にフォールバックして早期終了を防ぐ。
		const last = batch[batch.length - 1];
		const lastTs = last?.confirmed_at ?? last?.found_at;
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
		// paginateDeposits と同じ理由で取得境界で asset を小文字化する。
		const batch = normalizeAssetCodes(result.data.withdrawals || []);
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

export interface PaginateTradesOptions {
	/**
	 * API に渡すベースパラメータ（pair / since / end など）。
	 * order に対応するカーソル側（asc → since, desc → end）の値は初回カーソルとして使われ、
	 * 後続ページではカーソル側のみが上書きされる（もう一方の境界は preserve）。
	 */
	baseParams?: Record<string, string>;
	/** カーソル方向。asc → `since` を前進、desc → `end` を後退。デフォルト 'asc'。 */
	order?: 'asc' | 'desc';
	/** 返却する最大件数。デフォルトは事実上の無制限（Number.POSITIVE_INFINITY）。 */
	limit?: number;
}

/**
 * ページネーション付きで現物約定履歴を取得（最大 MAX_PAGES ページ）。
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
		// 取得境界での pair 正規化。消費側（portfolio/calc.ts）は `t.pair === \`${asset}_jpy\`` の
		// 突き合わせと `t.pair.replace('_jpy', '')` による asset 導出を小文字前提で行うため、
		// ここで前提を担保する（防御的正規化。現行 API は小文字を返す。`lib/pair-code.ts` 参照）。
		const batch = normalizePairCodes(result.data.trades || []);
		// 信用約定（position_side 付き）が混入した場合に備え、現物のみに絞る。
		const spotOnly = batch.filter((t) => t.position_side == null);
		const newRecords = spotOnly.filter((t) => !seenIds.has(t.trade_id));
		for (const t of newRecords) seenIds.add(t.trade_id);
		all.push(...newRecords);
		// truncated 判定はフィルタ前の batch.length を使う。フィルタ後の長さで判定すると
		// 信用比率が高いとき早期終了し、次ページの現物約定を取り逃がす（paginateMarginTrades と同じ理由）。
		if (batch.length < TRADE_PAGE_SIZE) return { trades: all.slice(0, limit), truncated: false };
		// limit 到達 → 早期打ち切り（期間内に未取得レコードがある可能性があるため truncated=true）
		if (all.length >= limit) return { trades: all.slice(0, limit), truncated: true };
		// 同一タイムスタンプが TRADE_PAGE_SIZE 件以上連続して進捗しない場合の保険。
		// カーソルベース（since/end の前進有無）で判定して、満杯信用ページに当たった瞬間に
		// 後続の現物約定を取り逃がさないようにする（paginateMarginTrades と同じ）。
		const lastTs = batch[batch.length - 1]?.executed_at;
		if (!lastTs) break;
		const nextCursor = String(lastTs);
		if (nextCursor === cursor) return { trades: all.slice(0, limit), truncated: true };
		cursor = nextCursor;
	}
	// ループ脱出は全て未完了（MAX_PAGES 到達 / API エラー / lastTs 欠損）。
	// 境界 dedup で all.length が TRADE_PAGE_SIZE の倍数にならないケースを誤って完了扱いしないよう、
	// 早期 return の通常完了パス以外は truncated=true で返す。
	return { trades: all.slice(0, limit), truncated: true };
}

/**
 * ページネーション付きで信用約定履歴を取得（type=margin、最大 MAX_PAGES ページ、古い順）。
 * 信用未利用や API 失敗時でも空配列で安全に返し、analyze_my_portfolio が落ちないようにする。
 *
 * 公式 docs (bitbankinc/bitbank-api-docs) の trade_history パラメータには `type=margin`
 * が記載されておらず、API が未知パラメータを無視する可能性がある。その場合は現物約定が
 * 混入し、calcMarginPnl が現物の fee_occurred_amount_quote まで margin_fee_cost として控除して
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
		// paginateTrades と同じ理由で取得境界で pair を小文字化する。
		const batch = normalizePairCodes(result.data.trades || []);
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

// ── 信用口座情報 ──

/**
 * 信用口座状態 (`get_margin_status`) と建玉一覧 (`get_margin_positions`) を並列取得し、
 * 各々の取得成否を独立フラグで返す。
 *
 * 設計判断: ツール handler を直接呼ぶ方式（paginateTrades 等と同じ依存パターン）。
 * 取得層 / 計算層の warning 文言を再実装せずに `get_margin_status` / `get_margin_positions`
 * 側のロジックを再利用できる。
 *
 * 信用未利用ユーザーで API が success レスポンスを返さないケースに備え、ハンドラ呼び出し
 * 自体が throw した場合も catch して `*FetchFailed = true` で上位に伝播する。
 */
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

// ── Ticker 取得 ──

/**
 * public API の tickers_jpy から asset → 最新価格 Map を取得する。
 * 共通ヘルパー `fetchTickerPricesMap`（lib/tickers.ts）の薄いラッパ。
 * 後方互換のため Map のみを返すシグネチャを維持する（呼び出し側は error を握り潰す）。
 */
export async function fetchTickerPrices(): Promise<Map<string, number>> {
	return (await fetchTickerPricesMap()).prices;
}

/**
 * 1dayキャンドルから期初始値 + 全日次始値マップを一括取得する。
 * boundaryPrices: 既存の年初/月初/日初パフォーマンス計算用。
 * dailyPrices: 資産推移時系列（equity series）構築用。asset → (candleTimestampMs → openPrice)。
 *
 * **前提: `pairs` は小文字で渡すこと。** ここは API レスポンスの受け口ではなく呼び出し元由来の
 * 値を受けるだけなので、正規化は行わない（`analyzeMyPortfolioHandler` は正規化済み asset から
 * 組んだ `${asset}_jpy` と、`paginateTrades` が正規化した `t.pair` のみを渡す）。
 * 下の `pair.replace('_jpy', '')` で導出する asset は、そのまま `boundaryPrices` /
 * `dailyPrices` のキーになり `lib/asset-code.ts` 側の小文字空間と join される。
 */
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

	// date を明示すると `getCandles` が anchorEndMs (当日 23:59:59) を未来として弾いてしまう
	// （anchorEndMs > Date.now() の future check）。equity series 構築では「今までの最近 limit 日」
	// が欲しいだけなので date を渡さず内部 default（todayYyyymmdd, anchorActive=false）に委ねる。
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

				// Normalize to JST midnight so keys match buildEquitySeries date lookups
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

// ── 入出庫日価格の追加取得 ──

/**
 * **出庫**（表示専用）の追加取得で発行する年単位 chunk の上限。
 *
 * `getCandles` は tz 暦年 1 年ぶんの窓に対して UTC 年 chunk を 2 つ叩く（JST 年頭は UTC 前年）ため、
 * 実 HTTP リクエスト数はこの 2 倍程度になる。長期口座（多資産 × 多年）で青天井にならないよう頭を止める。
 * 上限を超えた組は取得せず、`resolveFlowPrice` の現在価格フォールバックに落ちる。
 *
 * **入庫の chunk はこの上限を消費しない**（`MAX_DEPOSIT_FLOW_PRICE_YEAR_CHUNKS` が別枠）。
 * 共有すると出庫が増えるだけで入庫が押し出され、取得原価と実現損益が実行ごとに変わる（#76）。
 */
export const MAX_WITHDRAWAL_FLOW_PRICE_YEAR_CHUNKS = 12;

/**
 * **入庫**の追加取得で発行する年単位 chunk の上限（暴走時の安全弁）。
 *
 * 入庫は取得原価に算入されるので、取れなかった分は原価から丸ごと落ちて実現損益が変わる
 * （`collectDepositCostEvents` は `deposit_date_price` で解けた入庫だけを算入する）。
 * したがってこれは「予算」ではなく、壊れたデータで際限なく HTTP を撃たないための安全弁であり、
 * 実口座で当たらない水準に置く（bitbank の現物上場は 2017 年開始なので、実運用の (資産, 年) 組は
 * 数十が上限）。**出庫の件数では 1 枠も減らない。**
 *
 * 当たった場合は黙って落とさず `FlowDatePrices.truncatedByChunkLimit.deposits` で申告し、
 * 呼び出し側が「取得原価が不完全で再実行により変わりうる」ことを警告に出す。
 */
export const MAX_DEPOSIT_FLOW_PRICE_YEAR_CHUNKS = 64;

/**
 * 年 chunk 取得の最大同時実行数。
 *
 * 入庫は上限を実質外したので chunk 総数が伸びうる。全件を `Promise.all` に流すと
 * bitbank API のレート制限（HTTP 429）に当たるため、同時実行だけを頭打ちにする
 * （総数は絞らない ＝ 入庫を取り切る性質は変えない）。
 * バッチ間に無条件の遅延は入れない（成功時は 1 度も待たない）。実タイマー待ちが入るのは
 * chunk 取得が失敗してリトライする経路だけで、そこは `FLOW_PRICE_CHUNK_RETRIES` の注意書きに従う。
 *
 * **12 → 4 に下げた（#81）。** `getCandles` は tz 暦年 1 年ぶんの窓に UTC 年 chunk を 2 本叩き、
 * その 1 本ごとに HTTP リトライが最大 3 回入る。さらに本レイヤーのリトライ
 * （`FLOW_PRICE_CHUNK_RETRIES`）が重なるため、同時実行 12 のままだと瞬間的な発射レートが
 * リトライぶんだけ跳ね上がり、レート制限を自分で誘発して失敗率がむしろ上がる。
 * 本件の目的は取得原価の**決定性**なので、総取得時間が伸びても成功率を取る。
 * 総数は絞っていないので「入庫を取り切る」性質（#76）は変わらない。
 */
const FLOW_PRICE_FETCH_CONCURRENCY = 4;

/**
 * 年 chunk 1 つあたりの再試行回数（初回 + N 回）。
 *
 * `getCandles` の内側では `fetchJsonWithRateLimit` が HTTP 1 本ごとにリトライ（`Retry-After` 解釈込み）
 * しているが、**chunk 単位の成否判定はその外側**にあるため、
 * 「HTTP は返ったが `success:0`」「UTC 年 chunk の過半数が落ちて upstream 失敗」は 1 回で諦めていた。
 * ここが #81 の非決定性の入口——同じ口座を同じ日に叩いても解決できた入庫の件数が変わり、
 * 移動平均の取得原価と過去の実現損益まで動く。
 *
 * 待機は `lib/http.ts` の `retryAsync`（`retryBackoffMs` の共通スケジュール）に委ねる。自前で書かない。
 *
 * **テスト注意**: 待機は実タイマーなので、chunk 取得の失敗を注入するテストで
 * `vi.useFakeTimers()`（setTimeout ごと固める）を使うとハンドラが返ってこない。
 * now の固定だけが要るなら `vi.useFakeTimers({ toFake: ['Date'] })` を使うこと。
 */
const FLOW_PRICE_CHUNK_RETRIES = 2;

/** 入庫・出庫それぞれで「年 chunk を取れなかったせいで入出庫日価格を解決できなくなった」件数 */
export interface FlowPriceShortfall {
	/** 入庫の件数。1 件以上なら取得原価が不完全（`calcPnl` の原価に算入されない） */
	deposits: number;
	/** 出庫の件数。1 件以上なら純投入額の減算が現在価格での仮評価に落ちる（表示のみ） */
	withdrawals: number;
	/**
	 * `deposits` の資産別内訳（資産コード小文字 → 件数。0 件の資産はキーごと持たない）。
	 *
	 * 原価・実現損益の抑止は**銘柄単位**で判断する（#80）。合計件数だけでは
	 * 「どの銘柄の原価が欠けているか」が分からず、抑止範囲が全銘柄に広がってしまう。
	 * 出庫側は表示専用で銘柄単位の抑止対象にならないため内訳を持たない。
	 */
	depositsByAsset: Map<string, number>;
}

/** 追加取得の結果。日次価格に加えて「なぜ取れなかったか」を種類別に返す */
export interface FlowDatePrices {
	/**
	 * 入出庫換算用の日次価格（`baseDailyPrices` に追加取得分をマージしたもの）。
	 * 追加取得が 1 件も要らなければ `baseDailyPrices` インスタンスそのもの（下記「戻り値の所有権」）。
	 */
	dailyPrices: Map<string, Map<number, number>>;
	/**
	 * chunk 数の**上限で切り落とした**ために解決できなくなった件数。
	 * 「取りに行けば解決できたはず」の分であり、上場前・API 失敗で本当に取れない分
	 * （どちらも `current_price_fallback_count` に混ざる）とは区別して申告する（#76 仕様 2）。
	 *
	 * 上限は決定的（同じ入力なら同じ結果）だが、原価に入るはずの入庫が落ちている点は
	 * 取得失敗と同じなので、`depositsByAsset` に載った銘柄は原価・実現損益を確定値として
	 * 出さない（#80。理由コードは `deposit_price_chunk_truncated`）。
	 */
	truncatedByChunkLimit: FlowPriceShortfall;
	/**
	 * chunk の**取得に失敗した**（`get_candles` が upstream / network で fail、throw、空応答）ために
	 * 解決できなくなった件数。再実行で解消しうる一時的な不完全性。
	 *
	 * ここに載るのは**リトライ（`FLOW_PRICE_CHUNK_RETRIES`）を使い切ってなお失敗した分だけ**（#81）。
	 * 1 回目で落ちただけの一過性の失敗は取得側で吸収されるので載らない。
	 *
	 * 「当日の足が無い」（上場前・データ欠損）はここには入らない。それは再実行しても変わらない
	 * 恒久的な未解決なので、`current_price_fallback_count` だけで足りる。年 chunk が丸ごと
	 * 空で `getCandles` が `errorType='user'` で失敗するケース（その年に足が存在しない）も同じ扱い。
	 *
	 * `depositsByAsset` に載った銘柄は**実行ごとに取得原価と実現損益が変わる**ため、
	 * 確定値を出さない（#80。理由コードは `deposit_price_fetch_failed`）。
	 */
	chunkFetchFailed: FlowPriceShortfall;
}

/** (資産, 年) 1 組ぶんの取得候補。同じ組を要求した入庫・出庫の件数を持つ */
interface FlowPriceChunk {
	asset: string;
	year: string;
	depositCount: number;
	withdrawalCount: number;
}

const emptyShortfall = (): FlowPriceShortfall => ({ deposits: 0, withdrawals: 0, depositsByAsset: new Map() });

/** `shortfall` に (資産, 年) 1 組ぶんの取りこぼしを加算する（資産別内訳も同時に積む） */
function addShortfall(shortfall: FlowPriceShortfall, chunk: FlowPriceChunk): void {
	shortfall.deposits += chunk.depositCount;
	shortfall.withdrawals += chunk.withdrawalCount;
	if (chunk.depositCount > 0) {
		shortfall.depositsByAsset.set(chunk.asset, (shortfall.depositsByAsset.get(chunk.asset) ?? 0) + chunk.depositCount);
	}
}

/**
 * 入出庫日（入庫: `confirmed_at` / 出庫: `requested_at`）の 1day open を解決するため、
 * `fetchCandlePriceData` の 400 日窓に無い **(資産, 年) の組だけ**を年単位 chunk で追加取得し、
 * 既存の日次価格にマージした Map を返す（追加取得が不要なら引数をそのまま返す。下記「戻り値の所有権」）。
 *
 * ## 400 日超のフォールバック規則（#57 (a)-2）
 *
 * 1. 直近 400 日窓（`fetchCandlePriceData`）に当日の始値があればそれを使う（追加取得しない）
 * 2. 無ければ当該 (資産, 年) の 1day chunk を追加取得して解決を試みる
 * 3. それでも取れない（取得失敗 / 上限超過 / 上場前）場合は本関数では何もせず、
 *    `resolveFlowPrice` が現在価格にフォールバックする。混ぜたことは
 *    `FlowValuationBreakdown` と summary / meta の警告で申告される
 *
 * ## 入庫と出庫で予算を分ける理由（#76）
 *
 * 入庫と出庫を 1 つの上限で奪い合わせると、**出庫が増えただけで入庫の chunk が押し出される**。
 * 押し出された入庫は `deposit_date_price` で解けず、`collectDepositCostEvents` が原価から
 * 丸ごと落とすので、同じ口座・同じ期間でも実行タイミングで移動平均の取得原価が変わり、
 * **過去の実現損益まで動く**（#70 で出庫の解決範囲を年初来から全履歴へ広げて顕在化した）。
 *
 * そこで候補を 2 つに割り、別々の上限を当てる:
 *
 * - **入庫が要求する (資産, 年)**: `MAX_DEPOSIT_FLOW_PRICE_YEAR_CHUNKS`（安全弁）。
 *   **出庫の件数では 1 枠も減らない。** 上限が古い順に効くよう「古い年を先に」並べる
 *   （新しい入庫が増えても既に取得できていた古い年の順位が動かない ＝ 過去の実現損益が
 *   将来の入庫で書き換わらない）
 * - **出庫だけが要求する (資産, 年)**: `MAX_WITHDRAWAL_FLOW_PRICE_YEAR_CHUNKS`。
 *   表示専用なので従来どおり新しい年を優先する
 *
 * 入庫と出庫が同じ (資産, 年) を要求する組は**入庫側の予算で取得し、出庫はそれに相乗り**する。
 * 逆に、入庫の上限で切られた組を出庫の残枠で拾い直すことはしない——拾えてしまうと
 * 「出庫が増えたおかげで入庫が解決した」経路が復活し、本 issue の非決定性が形を変えて戻る。
 *
 * ## 戻り値の所有権
 *
 * 追加取得が 1 件も要らなかった場合は**引数の `baseDailyPrices` インスタンスをそのまま返す**
 * （無駄なコピーを避けるため）。呼び出し側は `dailyPrices` を常に自分専用のコピーとみなして
 * 書き換えてはいけない——読み取り専用に扱うこと。
 *
 * ## 引数の Map を破壊しない理由
 *
 * 入力の `baseDailyPrices` は資産推移シリーズ（`buildEquitySeries`）と
 * `equitySeriesQuality` の判定にも使われる。ここで古い年を混ぜ込むと
 * 「直近 400 日窓が揃っているか」という品質判定の意味が変わってしまうため、
 * 入出庫換算専用の別 Map として返す。
 */
export async function fetchFlowDatePrices(
	baseDailyPrices: Map<string, Map<number, number>>,
	targets: FlowValuationTarget[],
): Promise<FlowDatePrices> {
	// 直近窓で解決できない (資産, 年) を洗い出す。同じ年に何件入出庫があっても chunk は 1 つ。
	// 件数は入庫・出庫別に数える（切り落とし・取得失敗の申告を種類別に出すため）。
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
	// 入庫が 1 件でも要求する組は入庫側の予算で取る（出庫は相乗り）。
	// 上限は古い年から埋める: 新しい入庫が増えても既存の順位が動かず、過去の原価が書き換わらない。
	const depositChunks = all
		.filter((c) => c.depositCount > 0)
		.sort((a, b) => (a.year === b.year ? a.asset.localeCompare(b.asset) : a.year.localeCompare(b.year)));
	// 出庫だけが要求する組。表示専用なので新しい年を優先する（直近の出庫ほど残高への寄与が大きく、
	// 上場前で空振りする確率も低い）。同年内は資産名昇順で決定的に選ぶ。
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
		// depositCount は定義上 0 の組なので資産別内訳には積まれない。
		addShortfall(truncatedByChunkLimit, c);
	}

	const merged = new Map<string, Map<number, number>>();
	for (const [asset, byDate] of baseDailyPrices) merged.set(asset, new Map(byDate));

	const chunkFetchFailed = emptyShortfall();
	const markFailed = (chunk: FlowPriceChunk) => addShortfall(chunkFetchFailed, chunk);

	/**
	 * `getCandles` の失敗が**再実行で解消しうる**ものか判定する。
	 *
	 * `errorType='user'` は「その (資産, 年) に足がそもそも存在しない」ことの表明で
	 * （`No candle data returned` / `before bitbank service start` / HTTP 404）、
	 * 何度叩いても同じ結果になる。これを取得失敗に数えると、恒久的に価格を解決できない
	 * 入庫まで #80 の抑止対象に入り、当該銘柄の取得原価・実現損益が**永久に出せなくなる**。
	 * 上場前・データ欠損を取得失敗に数えないという本 interface の規約
	 * （`FlowDatePrices.chunkFetchFailed` の doc）を、年 chunk が丸ごと空のケースまで広げたもの。
	 *
	 * それ以外（`upstream` の HTTP エラー・レート制限・throw）は一時的な失敗として数える。
	 */
	const isTransientFailure = (res: { meta?: { errorType?: string } } | undefined): boolean =>
		res?.meta?.errorType !== 'user';

	/**
	 * `getCandles` の戻り値が `chunkFetchFailed` に計上される（＝再実行で解消しうる）ものか。
	 *
	 * リトライの判定と計上の判定を同じ述語に揃えることで、
	 * **`chunkFetchFailed` に載る結果は必ずリトライを使い切ったあとのもの**という不変条件を作る。
	 * 逆に `errorType='user'`（その年に足が無い）は何度叩いても同じなので `false` を返し、
	 * 上場前の入庫に対して無駄なリクエストを撃たない。
	 */
	const isChunkFetchFailure = (res: Awaited<ReturnType<typeof getCandles>> | undefined): boolean => {
		if (!res?.ok) return isTransientFailure(res);
		const normalized = res.data?.normalized;
		return !Array.isArray(normalized) || normalized.length === 0;
	};

	await runWithConcurrency(selected, FLOW_PRICE_FETCH_CONCURRENCY, async (chunk) => {
		const { asset, year } = chunk;
		try {
			// 1day の年 chunk は最大 366 本。`fetchCandlePriceData` と同じ暦（JST）で足を切る。
			// 一時的な失敗はここで吸収する（#81）。使い切っても失敗した場合は従来どおり
			// `chunkFetchFailed` に計上し、#80 の抑止経路へ落とす（戻り値の形は変えない）。
			const res = await retryAsync(() => getCandles(`${asset}_jpy`, '1day', year, 400, PORTFOLIO_CALENDAR_TZ), {
				retries: FLOW_PRICE_CHUNK_RETRIES,
				shouldRetry: isChunkFetchFailure,
			});
			if (!res?.ok) {
				// 「その年に足が無い」失敗は再実行しても変わらないので取得失敗に数えない
				// （現在価格フォールバック件数だけで足りる。`isTransientFailure` の doc 参照）。
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
				// 直近窓の値を上書きしない（同じ 1day open なので値は一致するが、
				// 取得経路によるブレを持ち込まないよう先に入っている方を優先する）。
				const dayMs = portfolioDayStartMs(ts);
				if (!byDate.has(dayMs)) byDate.set(dayMs, open);
			}
		} catch {
			// Non-fatal: この (資産, 年) は現在価格フォールバックに落ちる（件数は申告する）
			markFailed(chunk);
		}
	});

	return { dailyPrices: merged, truncatedByChunkLimit, chunkFetchFailed };
}

/**
 * `items` を最大 `limit` 並列で `worker` に流す。全件が終わるまで待つ。
 *
 * `lib/candle-fetch.ts` の `mergeChunks({ batched })` は同じ pair の chunk key を
 * `fetchCandleChunk` に流して `OhlcvRow` をマージする専用ヘルパーで、ここで必要な
 * 「(資産, 年) ごとに `getCandles` を呼び、chunk 単位で成否を分類する」形には嵌まらない。
 * またバッチ間に実タイマー遅延を挟むため、`vi.useFakeTimers()` 下の handler テストが止まる。
 */
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
