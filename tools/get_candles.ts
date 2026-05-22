import {
	dedupeByTimestamp,
	type FetchChunkResult,
	fetchCandleChunk,
	mergeChunks,
	type OhlcvRow,
	UpstreamApiError,
} from '../lib/candle-fetch.js';
import { dayjs, today, toIsoTime, toIsoWithTz } from '../lib/datetime.js';
import { getErrorMessage } from '../lib/error.js';
import { formatSummary } from '../lib/formatter.js';
import { BITBANK_API_BASE, DEFAULT_RETRIES, fetchJsonWithRateLimit, type RateLimitInfo } from '../lib/http.js';
import { fail, failFromError, failFromValidation, ok, parseAsResult, toStructured } from '../lib/result.js';
import { createMeta, ensurePair, validateDate, validateLimit } from '../lib/validate.js';
import type { CandleType, FailResult, GetCandlesData, GetCandlesMeta, OkResult } from '../src/schemas.js';
import { GetCandlesInputSchema, GetCandlesOutputSchema } from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';

const TYPES: Set<CandleType | string> = new Set([
	'1min',
	'5min',
	'15min',
	'30min',
	'1hour',
	'4hour',
	'8hour',
	'12hour',
	'1day',
	'1week',
	'1month',
]);

// 年単位でリクエストする時間足（YYYY形式）
const YEARLY_TYPES: Set<string> = new Set(['4hour', '8hour', '12hour', '1day', '1week', '1month']);

// 日単位でリクエストする時間足（YYYYMMDD形式）
const DAILY_TYPES: Set<string> = new Set(['1min', '5min', '15min', '30min', '1hour']);

// 時間足ごとの年間本数（複数年取得時の計算用）
const BARS_PER_YEAR: Record<string, number> = {
	'1month': 12,
	'1week': 52,
	'1day': 365,
	'12hour': 730,
	'8hour': 1095,
	'4hour': 2190,
};

// 時間足ごとの1日あたりの本数
const BARS_PER_DAY: Record<string, number> = {
	'1min': 1440,
	'5min': 288,
	'15min': 96,
	'30min': 48,
	'1hour': 24,
};

// 時間足ごとの bar 間隔（ms）— 現在年の利用可能本数を経過時間ベースで見積もる用。
// 日数ベースだと 4hour/8hour/12hour で「形成中の今日 1 日分の足がすべて確定済」と過大評価し、
// 年初に小 limit で前年取得が漏れる問題が起きる。
// 1month は近似値（30日）でよい — 推定の上限キャップ用途で厳密性は不要。
const INTERVAL_MS: Record<string, number> = {
	'1min': 60_000,
	'5min': 5 * 60_000,
	'15min': 15 * 60_000,
	'30min': 30 * 60_000,
	'1hour': 3_600_000,
	'4hour': 4 * 3_600_000,
	'8hour': 8 * 3_600_000,
	'12hour': 12 * 3_600_000,
	'1day': 86_400_000,
	'1week': 7 * 86_400_000,
	'1month': 30 * 86_400_000,
};

// fetch タイムアウト・並列度・バッチ間ディレイ
// 日次 chunk は bitbank API のレート制限に配慮し、3 並列 + バッチ間 500ms（≒6 req/s）に抑える。
const CANDLE_FETCH = {
	singleTimeoutMs: 5_000,
	chunkTimeoutMs: 8_000,
	dailyConcurrency: 3,
	dailyBatchDelayMs: 500,
} as const;

// limit 上限（複数年/複数日取得時は緩和）
const CANDLE_LIMIT = {
	default: 1_000,
	multiYear: 5_000,
	multiDay: 10_000,
} as const;

function todayYyyymmdd(): string {
	return today('YYYYMMDD');
}

/**
 * date 指定時の「これ以下の足だけ返す」上限 timestamp (ms, UTC) を返す。
 *
 * - YYYYMMDD: その日の終端 23:59:59.999 UTC
 * - YYYY: その年の終端 12-31 23:59:59.999 UTC（YEARLY_TYPES でのみ用いる）
 * - 形式不一致: null（validateDate 通過後を前提に呼ぶため通常は起きない）
 */
function computeAnchorEndMs(rawDate: string, type: string): number | null {
	if (/^\d{8}$/.test(rawDate)) {
		const year = rawDate.slice(0, 4);
		const month = rawDate.slice(4, 6);
		const day = rawDate.slice(6, 8);
		const d = dayjs.utc(`${year}-${month}-${day}`);
		return d.isValid() ? d.endOf('day').valueOf() : null;
	}
	if (YEARLY_TYPES.has(type) && /^\d{4}$/.test(rawDate)) {
		const d = dayjs.utc(`${rawDate}-01-01`);
		return d.isValid() ? d.endOf('year').valueOf() : null;
	}
	return null;
}

/**
 * anchor 年内で利用可能な本数を見積もる（multi-year yearsNeeded 計算用）。
 *
 * - YYYY 指定: フル年 (barsPerYear)
 * - YYYYMMDD 指定: 1/1 から anchor 日までの本数を日数比で按分
 *
 * 年初に anchor を指定された場合（例: 1/10）に「フル年使える」と誤判定すると
 * 多年取得が不足し、filter 後の件数が limit を満たさない問題を防ぐ。
 */
function estimateBarsAvailableInAnchorYear(rawDate: string, type: string, barsPerYear: number): number {
	if (!YEARLY_TYPES.has(type)) return barsPerYear;
	if (!/^\d{8}$/.test(rawDate)) return barsPerYear;
	const year = rawDate.slice(0, 4);
	const month = rawDate.slice(4, 6);
	const day = rawDate.slice(6, 8);
	const anchor = dayjs.utc(`${year}-${month}-${day}`);
	if (!anchor.isValid()) return barsPerYear;
	const startOfYear = dayjs.utc(`${year}-01-01`).startOf('year');
	const daysFromStart = anchor.diff(startOfYear, 'day') + 1;
	return Math.max(1, Math.floor(daysFromStart * (barsPerYear / 365)));
}

/**
 * 全 chunk 失敗時に first error を分類する。
 * - UpstreamApiError（success:0 由来）→ upstream として明示分類した FailResult
 * - その他（ネットワーク等）→ throw（outer catch で network 分類）
 * - エラーが存在しない（= rows>0 ありえる）→ null
 */
function classifyAllChunksFailure(results: FetchChunkResult[]): FailResult | null {
	const firstError = results.find((r) => r.error);
	if (firstError?.error instanceof UpstreamApiError) {
		return fail(firstError.error.message, 'upstream');
	}
	if (firstError?.error) throw firstError.error;
	return null;
}

export default async function getCandles(
	pair: string,
	type: CandleType | string = '1day',
	date?: string,
	limit: number = 200,
	tz: string = 'Asia/Tokyo',
): Promise<OkResult<GetCandlesData, GetCandlesMeta> | FailResult> {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk);

	if (!TYPES.has(type)) {
		return fail(`type は ${[...TYPES].join(', ')} から選択してください（指定値: ${String(type)}）`, 'user');
	}

	const dateProvided = date != null;
	const effectiveDate = date ?? todayYyyymmdd();
	const dateCheck = validateDate(effectiveDate, String(type));
	if (!dateCheck.ok) return failFromValidation(dateCheck);

	// 複数年取得が必要かどうかを判定
	const isYearlyType = YEARLY_TYPES.has(type);
	const isDailyType = DAILY_TYPES.has(type);
	const barsPerYear = BARS_PER_YEAR[type] || 365;
	const barsPerDay = BARS_PER_DAY[type] || 24;

	// date 指定時に「これ以下の足だけ返す」アンカー timestamp を計算する。
	// 単一 fetch（YEARLY_TYPES）では API が年単位で返すため slice(-limit) のみだと
	// 「指定日以前 limit 件」ではなく「年末側 limit 件」を返してしまう問題への対処。
	const anchorEndMs = dateProvided ? computeAnchorEndMs(effectiveDate, String(type)) : null;
	const anchorActive = anchorEndMs != null;

	// 起点年（multi-year のみ参照）:
	//   - date 指定時 → その年（過去年は丸ごと利用可能）
	//   - date 未指定 → 現在年（部分年であり経過日数を考慮）
	// 公式 API は YYYY 指定で 1 年分の candlestick を返す（4hour 以上の YEARLY_TYPES のみ）。
	const currentYear = dayjs().year();
	const anchorYear = dateProvided && isYearlyType ? Number(dateCheck.value) : currentYear;
	const isCurrentYearAnchor = anchorYear === currentYear;

	// 現在年は経過時間で利用可能本数が制限される。
	// floor(elapsedMs / intervalMs) + 1 は「確定済み本数 + 現在形成中の足」。
	// 日数ベース（floor(dayOfYear * barsPerYear/365)）だと 4hour/8hour/12hour で
	// 今日 1 日分の足がすべて確定済と過大評価され、年初の小 limit で前年取得が漏れる。
	const now = dayjs();
	const startOfYear = now.startOf('year');
	const intervalMs = INTERVAL_MS[String(type)] ?? 86_400_000;
	const elapsedThisYearMs = Math.max(0, now.valueOf() - startOfYear.valueOf());
	const estimatedBarsThisYear = Math.floor(elapsedThisYearMs / intervalMs) + 1;

	// anchor 年内で「利用可能な本数」を見積もる（multi-year yearsNeeded の上振れ防止用）。
	// - date 未指定: 現在年なら経過日数ベース、過去年（事実上 anchorYear=currentYear なのでこのケースは起きない）ならフル年
	// - date 指定 + YYYYMMDD: 1/1 から anchor までの按分
	// - date 指定 + YYYY: フル年
	// - 現在年 anchor は「今日より先のデータは無い」ため estimatedBarsThisYear で頭打ち
	const barsInAnchorYear = (() => {
		if (!isYearlyType) return barsPerYear;
		const fromAnchor = dateProvided
			? estimateBarsAvailableInAnchorYear(effectiveDate, String(type), barsPerYear)
			: barsPerYear;
		const usable = isCurrentYearAnchor ? Math.min(fromAnchor, estimatedBarsThisYear) : fromAnchor;
		return Math.max(1, usable);
	})();

	const yearsNeeded = isYearlyType
		? barsInAnchorYear >= limit
			? 1
			: 1 + Math.ceil((limit - barsInAnchorYear) / barsPerYear)
		: 1;
	const needsMultiYear = isYearlyType && yearsNeeded > 1;

	// 日単位タイプの場合、複数日取得が必要かどうかを判定
	const daysNeeded = isDailyType ? Math.ceil(limit / barsPerDay) + 1 : 1; // +1 for buffer
	const needsMultiDay = isDailyType && daysNeeded > 1;

	// 複数年/複数日取得の場合は上限を緩和
	const maxLimit = needsMultiYear
		? CANDLE_LIMIT.multiYear
		: needsMultiDay
			? CANDLE_LIMIT.multiDay
			: CANDLE_LIMIT.default;
	const limitCheck = validateLimit(limit, 1, maxLimit);
	if (!limitCheck.ok) return failFromValidation(limitCheck);

	let ohlcvs: unknown[] = [];
	let json: unknown = null;
	let fetchWarning: string | undefined;
	let lastRateLimit: RateLimitInfo | null = null;

	try {
		if (needsMultiYear) {
			// 複数年の並列取得（起点は anchorYear＝date 指定時はその年、未指定時は現在年）
			const years = Array.from({ length: yearsNeeded }, (_, i) => anchorYear - i);
			const yearKeys = years.map(String);

			const merged = await mergeChunks(yearKeys, (key) =>
				fetchCandleChunk(chk.pair, type, key, { timeoutMs: CANDLE_FETCH.chunkTimeoutMs }),
			);
			lastRateLimit = merged.lastRateLimit;

			// 全チャンクがエラーの場合は分類して伝播
			// - UpstreamApiError（success:0 由来）→ upstream として明示分類
			// - それ以外（ネットワーク等）→ throw → outer catch で network 分類
			if (merged.rows.length === 0) {
				const classified = classifyAllChunksFailure(merged.results);
				if (classified) return classified;
			}

			// 過半数失敗なら信頼性が低いため fail
			const totalChunks = merged.results.length;
			const failedCount = merged.failedKeys.length;
			if (failedCount > 0 && failedCount >= totalChunks / 2) {
				return fail(`ローソク足取得の過半数が失敗しました（${totalChunks}年中${failedCount}年失敗）`, 'upstream');
			}
			if (failedCount > 0) {
				fetchWarning = `⚠️ ${totalChunks}年中${failedCount}年の取得に失敗しました（${merged.failedKeys.join(', ')}年）。データが不完全な可能性があります。`;
			}

			ohlcvs = merged.rows;
			json = { data: { candlestick: [{ ohlcv: ohlcvs }] }, _multiYear: { years, totalFetched: ohlcvs.length } };
		} else if (needsMultiDay) {
			// 複数日の並列取得（1hour, 30min, etc.）
			// bitbank API レート制限対策: 3 並列 + バッチ間 500ms → 約 6 req/s に抑える
			const baseDate = dayjs(dateCheck.value, 'YYYYMMDD');
			const dates = Array.from({ length: daysNeeded }, (_, i) => baseDate.subtract(i, 'day').format('YYYYMMDD'));

			const merged = await mergeChunks(
				dates,
				(key) => fetchCandleChunk(chk.pair, type, key, { timeoutMs: CANDLE_FETCH.chunkTimeoutMs }),
				{
					batched: {
						concurrency: CANDLE_FETCH.dailyConcurrency,
						batchDelayMs: CANDLE_FETCH.dailyBatchDelayMs,
					},
				},
			);
			lastRateLimit = merged.lastRateLimit;

			// 全チャンクがエラーの場合は分類して伝播
			// - UpstreamApiError（success:0 由来）→ upstream として明示分類
			// - それ以外（ネットワーク等）→ throw → outer catch で network 分類
			if (merged.rows.length === 0) {
				const classified = classifyAllChunksFailure(merged.results);
				if (classified) return classified;
			}

			// 過半数失敗なら信頼性が低いため fail
			const totalDays = merged.results.length;
			const failedCount = merged.failedKeys.length;
			if (failedCount > 0 && failedCount >= totalDays / 2) {
				return fail(`ローソク足取得の過半数が失敗しました（${totalDays}日中${failedCount}日失敗）`, 'upstream');
			}
			if (failedCount > 0) {
				fetchWarning = `⚠️ ${totalDays}日中${failedCount}日の取得に失敗しました。データが不完全な可能性があります。`;
			}

			ohlcvs = merged.rows;
			json = {
				data: { candlestick: [{ ohlcv: ohlcvs }] },
				_multiDay: { daysRequested: daysNeeded, totalFetched: ohlcvs.length },
			};
		} else {
			// 従来の単一リクエスト
			const url = `${BITBANK_API_BASE}/${chk.pair}/candlestick/${type}/${dateCheck.value}`;
			const fetchResult = await fetchJsonWithRateLimit(url, {
				timeoutMs: CANDLE_FETCH.singleTimeoutMs,
				retries: DEFAULT_RETRIES,
			});
			json = fetchResult.data;
			lastRateLimit = fetchResult.rateLimit;
			const jsonObj = json as {
				success?: number;
				data?: { candlestick?: Array<{ ohlcv?: unknown[] }>; code?: number };
			};
			// 上流レスポンスの success フラグを明示的に検証する。
			// 公式 API は { success: 0|1, data: ... } 形式で、エラー時は success:0 を返す。
			// optional chaining のフォールバックに任せると空配列として握りつぶされ「データなし」(user) として返してしまう。
			if (jsonObj?.success !== 1) {
				const code = jsonObj?.data?.code;
				const codeStr = code != null ? `（code: ${code}）` : '';
				return parseAsResult<GetCandlesData, GetCandlesMeta>(
					GetCandlesOutputSchema,
					fail(`bitbank API がエラーを返却しました${codeStr}`, 'upstream'),
				);
			}
			const cs = jsonObj?.data?.candlestick?.[0];
			ohlcvs = cs?.ohlcv ?? [];
		}

		if (ohlcvs.length === 0) {
			return fail(`ローソク足データが見つかりません (${chk.pair} / ${type} / ${dateCheck.value})`, 'user');
		}

		// timestamp 昇順でソート（mergeChunks 経路は既にソート済だが、単一fetch経路も含めて統一）。
		// ts が無効な行はソート時に 0 として扱い、後続の row validation に判定を委ねる。
		const sortedOhlcvs = [...ohlcvs].sort((a, b) => {
			const aTs = Number((a as [unknown, unknown, unknown, unknown, unknown, unknown])[5]) || 0;
			const bTs = Number((b as [unknown, unknown, unknown, unknown, unknown, unknown])[5]) || 0;
			return aTs - bTs;
		});

		// 同一 timestamp の重複行を排除する。/candlestick レスポンスで同一 ts の重複行
		// （一方は全 0 OHLC のプレースホルダ）が観測されており、インジケーター・パターン検出・
		// バックテストへの副作用を防ぐため anchor filter の前に挟む。
		const dedupedOhlcvs = dedupeByTimestamp(sortedOhlcvs as OhlcvRow[]);

		// date 指定時はアンカー以下の足だけに絞り込む。
		// ts が非数値の行は filter で除外せず後段の row validation で upstream として弾く。
		const anchoredOhlcvs = anchorActive
			? dedupedOhlcvs.filter((r) => {
					const ts = Number((r as [unknown, unknown, unknown, unknown, unknown, unknown])[5]);
					if (!Number.isFinite(ts)) return true;
					return ts <= (anchorEndMs as number);
				})
			: dedupedOhlcvs;

		if (anchorActive && anchoredOhlcvs.length === 0) {
			return fail(`指定日（${effectiveDate}）以前のローソク足データが見つかりません (${chk.pair} / ${type})`, 'user');
		}

		const rows = anchoredOhlcvs.slice(-limitCheck.value) as Array<
			[unknown, unknown, unknown, unknown, unknown, unknown]
		>;

		// 各行を fail-fast で検証する。Number() 変換失敗（NaN）は後続の Zod parse で拒否され、
		// 同じ try ブロックの catch に落ちて 'network' 分類されてしまう。実態は上流データ品質の
		// 問題なので、ここで明示的に 'upstream' として分類する。
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			if (!Array.isArray(row) || row.length < 6) {
				return parseAsResult<GetCandlesData, GetCandlesMeta>(
					GetCandlesOutputSchema,
					fail(
						`上流レスポンスに不正な OHLCV 行が含まれています (行 ${i}: 行長 ${Array.isArray(row) ? (row as unknown[]).length : 'non-array'})`,
						'upstream',
					),
				);
			}
			const [o, h, l, c, v, ts] = row;
			const oNum = Number(o);
			const hNum = Number(h);
			const lNum = Number(l);
			const cNum = Number(c);
			const vNum = Number(v);
			if (
				!Number.isFinite(oNum) ||
				!Number.isFinite(hNum) ||
				!Number.isFinite(lNum) ||
				!Number.isFinite(cNum) ||
				!Number.isFinite(vNum)
			) {
				return parseAsResult<GetCandlesData, GetCandlesMeta>(
					GetCandlesOutputSchema,
					fail(
						`上流レスポンスに不正な OHLCV 行が含まれています (行 ${i}: o=${String(o)} h=${String(h)} l=${String(l)} c=${String(c)} v=${String(v)})`,
						'upstream',
					),
				);
			}
			const tsNum = Number(ts);
			if (!Number.isFinite(tsNum) || tsNum <= 0) {
				return parseAsResult<GetCandlesData, GetCandlesMeta>(
					GetCandlesOutputSchema,
					fail(`上流レスポンスに不正な OHLCV 行が含まれています (行 ${i}: ts=${String(ts)})`, 'upstream'),
				);
			}
		}

		// volume (v): base 通貨建ての合算取引量（買い+売り区別なし）
		// bitbank /candlestick API の OHLCV[4] をそのまま使用
		const useTz = typeof tz === 'string' && tz.length > 0;
		const normalized = rows.map(([o, h, l, c, v, ts]) => ({
			open: Number(o),
			high: Number(h),
			low: Number(l),
			close: Number(c),
			volume: Number(v),
			timestamp: Number(ts),
			isoTime: toIsoTime(ts) ?? undefined,
			...(useTz ? { isoTimeLocal: toIsoWithTz(Number(ts), tz) ?? undefined } : {}),
		}));

		// 期間別のキーポイントを抽出
		const totalItems = normalized.length;
		const today = normalized[totalItems - 1];
		const sevenDaysAgo = totalItems >= 8 ? normalized[totalItems - 1 - 7] : null;
		const thirtyDaysAgo = totalItems >= 31 ? normalized[totalItems - 1 - 30] : null;
		const ninetyDaysAgo = totalItems >= 91 ? normalized[totalItems - 1 - 90] : totalItems > 0 ? normalized[0] : null;

		// 変化率を計算
		const calcChange = (from: number | undefined, to: number | undefined) => {
			if (!from || !to) return null;
			return ((to - from) / from) * 100;
		};

		// 出来高情報を計算
		const calcVolumeStats = () => {
			if (totalItems < 14) return null;

			// 直近7日間の平均出来高
			const recent7Days = normalized.slice(totalItems - 7, totalItems);
			const recent7DaysAvg = recent7Days.reduce((sum, c) => sum + c.volume, 0) / 7;

			// その前7日間（8〜14日前）の平均出来高
			const previous7Days = normalized.slice(totalItems - 14, totalItems - 7);
			const previous7DaysAvg = previous7Days.reduce((sum, c) => sum + c.volume, 0) / 7;

			// 過去30日間の平均出来高（データが30本以上ある場合）
			let last30DaysAvg: number | null = null;
			if (totalItems >= 30) {
				const last30 = normalized.slice(totalItems - 30, totalItems);
				last30DaysAvg = last30.reduce((sum, c) => sum + c.volume, 0) / last30.length;
			}

			// 変化率（直近7日 vs その前7日）
			// previous7DaysAvg === 0 のとき計算式が破綻するため null として返す:
			//   - nonzero / 0 → Infinity（JSON wire で null 化、意味的にも不正）
			//   - 0 / 0 → NaN（z.number() で reject されて schema parse が落ちる）
			const volumeChangePct =
				previous7DaysAvg === 0 ? null : ((recent7DaysAvg - previous7DaysAvg) / previous7DaysAvg) * 100;

			// 判定
			let judgment: string;
			if (volumeChangePct === null) judgment = '前週比較不可（前7日間の出来高ゼロ）';
			else if (volumeChangePct > 20) judgment = '活発になっています';
			else if (volumeChangePct < -20) judgment = '落ち着いています';
			else judgment = 'ほぼ変わりません';

			return {
				recent7DaysAvg: Number(recent7DaysAvg.toFixed(2)),
				previous7DaysAvg: Number(previous7DaysAvg.toFixed(2)),
				last30DaysAvg: last30DaysAvg != null ? Number(last30DaysAvg.toFixed(2)) : null,
				changePct: volumeChangePct === null ? null : Number(volumeChangePct.toFixed(1)),
				judgment,
			};
		};

		const volumeStats = calcVolumeStats();

		const keyPoints = {
			today: today
				? {
						index: totalItems - 1,
						date: today.isoTime?.split('T')[0] || null,
						close: today.close,
					}
				: null,
			sevenDaysAgo: sevenDaysAgo
				? {
						index: totalItems - 1 - 7,
						date: sevenDaysAgo.isoTime?.split('T')[0] || null,
						close: sevenDaysAgo.close,
						changePct: calcChange(sevenDaysAgo.close, today?.close),
					}
				: null,
			thirtyDaysAgo: thirtyDaysAgo
				? {
						index: totalItems - 1 - 30,
						date: thirtyDaysAgo.isoTime?.split('T')[0] || null,
						close: thirtyDaysAgo.close,
						changePct: calcChange(thirtyDaysAgo.close, today?.close),
					}
				: null,
			ninetyDaysAgo: ninetyDaysAgo
				? {
						index: ninetyDaysAgo === normalized[0] ? 0 : totalItems - 1 - 90,
						date: ninetyDaysAgo.isoTime?.split('T')[0] || null,
						close: ninetyDaysAgo.close,
						changePct: calcChange(ninetyDaysAgo.close, today?.close),
					}
				: null,
		};

		// 全件の価格範囲を計算
		const priceRange =
			normalized.length > 0
				? {
						high: Math.max(...normalized.map((c) => c.high)),
						low: Math.min(...normalized.map((c) => c.low)),
						periodStart: normalized[0].isoTime?.split('T')[0] || '',
						periodEnd: normalized[normalized.length - 1].isoTime?.split('T')[0] || '',
					}
				: undefined;

		const baseSummary = formatSummary({
			pair: chk.pair,
			timeframe: String(type),
			latest: normalized.at(-1)?.close,
			totalItems,
			keyPoints,
			volumeStats,
			priceRange,
		});

		// テキスト summary に全ローソク足データを含める
		// （MCP クライアントが structuredContent.data を読めない場合に対応）
		const baseCurrency = chk.pair.split('_')[0]?.toUpperCase() ?? '';
		const candleLines = normalized.map((c, i: number) => {
			const t =
				(c as { isoTimeLocal?: string; isoTime?: string }).isoTimeLocal ||
				(c.isoTime ? c.isoTime.replace(/\.000Z$/, 'Z') : '?');
			return `[${i}] ${t} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`;
		});
		const summary =
			(fetchWarning ? `${fetchWarning}\n` : '') +
			baseSummary +
			`\n\n📋 全${normalized.length}件のOHLCV (volume=${baseCurrency}建て合算値):\n` +
			candleLines.join('\n') +
			`\n\n---\n📌 含まれるもの: OHLCV（volume=${baseCurrency}建て合算値）、価格レンジ、期間別変動率` +
			`\n📌 含まれないもの: 出来高の売買内訳、板情報、ファンディングレート、個別約定` +
			`\n📌 補完ツール: get_flow_metrics（売買内訳・CVD）, get_transactions（個別約定）, get_orderbook（板情報）`;

		const metaExtra: Record<string, unknown> = { type, count: normalized.length };
		if (lastRateLimit) metaExtra.rateLimit = lastRateLimit;
		if (fetchWarning) metaExtra.warning = fetchWarning;
		if (needsMultiYear) {
			metaExtra.multiYear = {
				yearsRequested: yearsNeeded,
				totalFetched: ohlcvs.length,
				limitApplied: limitCheck.value,
			};
		}

		const result = ok<GetCandlesData, GetCandlesMeta>(
			summary,
			{ raw: json, normalized, keyPoints, volumeStats } as GetCandlesData,
			createMeta(chk.pair, metaExtra) as GetCandlesMeta,
		);
		return parseAsResult<GetCandlesData, GetCandlesMeta>(GetCandlesOutputSchema, result);
	} catch (e: unknown) {
		const rawMsg = getErrorMessage(e);
		const t = String(type);
		if (/404/.test(rawMsg) && ['4hour', '8hour', '12hour'].includes(t)) {
			const hint = `${t} は YYYY 形式（例: 2025）が必要です。なお、現在この時間足がAPIで提供されていない可能性もあります。1hour または 1day での取得もお試しください。`;
			return parseAsResult<GetCandlesData, GetCandlesMeta>(
				GetCandlesOutputSchema,
				fail(`HTTP 404 Not Found (${chk.pair}/${t}). ${hint}`, 'user'),
			);
		}
		return failFromError(e, {
			schema: GetCandlesOutputSchema,
			defaultType: 'network',
			defaultMessage: 'ネットワークエラー',
		});
	}
}

// ── MCP ツール定義（tool-registry から自動収集） ──
export const toolDef: ToolDefinition = {
	name: 'get_candles',
	description: `[Candles / OHLCV / Candlestick] ローソク足（candles / OHLCV / chart data）を取得。1min〜1monthの各時間足に対応。

【重要】バックテストには run_backtest を使用（データ取得〜チャート描画を一括実行）。`,
	inputSchema: GetCandlesInputSchema,
	handler: async ({
		pair,
		type,
		date,
		limit,
		view,
		tz,
	}: {
		pair: string;
		type: '1min' | '5min' | '15min' | '30min' | '1hour' | '4hour' | '8hour' | '12hour' | '1day' | '1week' | '1month';
		date?: string;
		limit?: number;
		view?: 'full' | 'items';
		tz?: string;
	}) => {
		const result = await getCandles(pair, type, date, limit, tz);
		if (!result.ok) return result;
		if (view === 'items') {
			const items = result?.data?.normalized ?? [];
			return {
				content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
				structuredContent: { items } as Record<string, unknown>,
			};
		}
		try {
			const items = Array.isArray(result?.data?.normalized) ? result.data.normalized : [];
			const sample = items.slice(0, 5);
			const header = String(result?.summary ?? `${String(pair).toUpperCase()} [${String(type)}]`);
			const text = `${header}\nSample (first ${sample.length}/${items.length}):\n${JSON.stringify(sample, null, 2)}`;
			return { content: [{ type: 'text', text }], structuredContent: toStructured(result) };
		} catch {
			return result;
		}
	},
};
