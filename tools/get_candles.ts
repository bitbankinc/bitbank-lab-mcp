import type { z } from 'zod';
import {
	type CalendarSpan,
	diffCalendarDays,
	enumerateDayKeys,
	enumerateYearKeys,
	isDayKeyFormat,
	isSupportedTimeZone,
	isYearKeyFormat,
	parseDayKeyAllowingOverflow,
	parseYearKey,
	startOfYearMs,
	toDayKey,
	toYearKey,
} from '../lib/calendar.js';
import {
	dedupeByTimestamp,
	describeFailedChunks,
	type FetchChunkResult,
	fetchCandleChunk,
	type MergedChunkResult,
	mergeChunks,
	type OhlcvRow,
	UpstreamApiError,
} from '../lib/candle-fetch.js';
import { formatDateInTz, toIsoTime, toIsoWithTz } from '../lib/datetime.js';
import { getErrorMessage } from '../lib/error.js';
import { barCountLabel, formatSummary } from '../lib/formatter.js';
import {
	BITBANK_API_BASE,
	DEFAULT_RETRIES,
	fetchJsonWithRateLimit,
	HttpStatusError,
	type RateLimitInfo,
} from '../lib/http.js';
import { isLatestBarProvisional, PROVISIONAL_BAR_NOTE, prependProvisionalNote } from '../lib/provisional-bar.js';
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

// /candlestick の chunk は UTC 暦日 / 暦年で固定され、tz 引数（anchor / 表示の暦）とは独立している（docs/internal/bitbank-candle-tz.md）。
const FETCH_CHUNK_TZ = 'UTC';

const YEARLY_TYPES: Set<string> = new Set(['4hour', '8hour', '12hour', '1day', '1week', '1month']);

// 上流で最も古い足は btc_jpy の 2011 年。それより前の暦年 chunk は success:0 を返すだけなので取りに行かない（#439）。
const EARLIEST_CANDLE_YEAR = 2011;

const DAILY_TYPES: Set<string> = new Set(['1min', '5min', '15min', '30min', '1hour']);

const BARS_PER_YEAR: Record<string, number> = {
	'1month': 12,
	'1week': 52,
	'1day': 365,
	'12hour': 730,
	'8hour': 1095,
	'4hour': 2190,
};

const BARS_PER_DAY: Record<string, number> = {
	'1min': 1440,
	'5min': 288,
	'15min': 96,
	'30min': 48,
	'1hour': 24,
};

// 公式リリース（2017-03-01）より 2 ヶ月手前に置き、明らかに昔すぎる anchor だけを fetch 前に弾く（境界付近は上流の 404 / 空配列に任せる）。
const BITBANK_SERVICE_START_MS = 1483228800000;

// 1month は近似値（30 日）でよい（推定の上限キャップ用途）。
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

// 日次 chunk は bitbank API のレート制限に配慮し、3 並列 + バッチ間 500ms（≒6 req/s）に抑える。
const CANDLE_FETCH = {
	singleTimeoutMs: 5_000,
	chunkTimeoutMs: 8_000,
	dailyConcurrency: 3,
	dailyBatchDelayMs: 500,
} as const;

const CANDLE_LIMIT = {
	default: 1_000,
	multiYear: 5_000,
	multiDay: 10_000,
} as const;

/** 空文字・undefined・不正 tz のフォールバック先（表示層が円建て・JST 前提のため）。 */
const DEFAULT_ANCHOR_TZ = 'Asia/Tokyo';

function normalizeAnchorTz(tz: string | undefined): string {
	return isSupportedTimeZone(tz) ? tz : DEFAULT_ANCHOR_TZ;
}

// 繰り上げ許容で読む。validateDate は形式しか見ないので 20260230 が届き、parseDayKey に替えると anchor が無効化されて最新側 limit 本に化ける（回帰テストで固定）。
function computeAnchorSpan(rawDate: string, type: string, tz: string = DEFAULT_ANCHOR_TZ): CalendarSpan | null {
	const safeTz = normalizeAnchorTz(tz);
	if (isDayKeyFormat(rawDate)) return parseDayKeyAllowingOverflow(rawDate, safeTz);
	if (YEARLY_TYPES.has(type) && isYearKeyFormat(rawDate)) return parseYearKey(rawDate, safeTz);
	return null;
}

// 経過日数は暦日数で数える（ミリ秒差だと DST を挟む tz で 1 日少なくなり、limit 上限が境界で反転する）。起点は rawDate の年の 1/1 で、繰り上げで年を跨いでも動かさない。
function estimateBarsAvailableInAnchorYear(
	rawDate: string,
	type: string,
	barsPerYear: number,
	tz: string = DEFAULT_ANCHOR_TZ,
): number {
	if (!YEARLY_TYPES.has(type)) return barsPerYear;
	if (!isDayKeyFormat(rawDate)) return barsPerYear;
	const safeTz = normalizeAnchorTz(tz);
	const anchor = parseDayKeyAllowingOverflow(rawDate, safeTz);
	if (anchor == null) return barsPerYear;
	const anchorYear = parseYearKey(rawDate.slice(0, 4), safeTz);
	if (anchorYear == null) return barsPerYear;
	const daysFromStart = diffCalendarDays(anchorYear.startMs, anchor.startMs, safeTz) + 1;
	return Math.max(1, Math.floor(daysFromStart * (barsPerYear / 365)));
}

// success:0 由来は upstream として返し、それ以外（ネットワーク等）は throw して outer catch で network に分類させる。
function classifyAllChunksFailure(results: FetchChunkResult[]): FailResult | null {
	const firstError = results.find((r) => r.error);
	if (firstError?.error instanceof UpstreamApiError) {
		return fail(firstError.error.message, 'upstream');
	}
	if (firstError?.error) throw firstError.error;
	return null;
}

// 404 は期間キー自体が無い（未来・上場前）とき。期間は在るが集計が未了なのは 200 + success:0 (code: 10000) なので別に扱う。
function isChunkNotFoundError(err: unknown): boolean {
	if (err instanceof HttpStatusError) return err.status === 404;
	const msg = err instanceof Error ? err.message : String(err ?? '');
	return /\b404\b/.test(msg);
}

function isNotYetAvailableError(err: unknown): boolean {
	if (err instanceof UpstreamApiError) return true;
	return isChunkNotFoundError(err);
}

/** `partitionFailedChunks` の分類結果。3 つの配列は互いに素で、合計が失敗 chunk の総数になる。 */
interface FailedChunkPartition {
	hardFailedKeys: string[];
	pendingGapKeys: string[];
	absentGapKeys: string[];
}

// absentGap は同じリクエストの別 chunk が実データを返したときだけ（上場前の 404 と本来ある 404 は応答だけでは区別できないので代理指標にする。#84）。success:0 は過去期間なら本物の異常なので含めない。
function partitionFailedChunks(
	keys: string[],
	results: FetchChunkResult[],
	nowUtcDayKey: string,
): FailedChunkPartition {
	const hasAnyRows = results.some((r) => r?.rows?.length > 0);
	const hardFailedKeys: string[] = [];
	const pendingGapKeys: string[] = [];
	const absentGapKeys: string[] = [];
	for (let i = 0; i < keys.length; i++) {
		const err = results[i]?.error;
		if (err == null) continue;
		const key = keys[i];
		const isCurrentOrFuturePeriod = key >= nowUtcDayKey.slice(0, key.length);
		if (isCurrentOrFuturePeriod && isNotYetAvailableError(err)) pendingGapKeys.push(key);
		else if (hasAnyRows && isChunkNotFoundError(err)) absentGapKeys.push(key);
		else hardFailedKeys.push(key);
	}
	return { hardFailedKeys, pendingGapKeys, absentGapKeys };
}

// 半数ちょうどは含めない。YEARLY は 1 年の要求でも UTC 年 chunk が 2 本になり、>= だと片方が落ちただけで取得できた 1 年ぶんごと捨てる（#84）。
function isMajorityChunkFailure(hardFailedCount: number, totalChunks: number): boolean {
	return hardFailedCount > 0 && hardFailedCount * 2 > totalChunks;
}

interface ChunkWarnLabels {
	unit: string;
	calendar: string;
	pendingSuffix: string;
}

function buildChunkWarnLines(
	keys: string[],
	results: FetchChunkResult[],
	partition: FailedChunkPartition,
	totalChunks: number,
	labels: ChunkWarnLabels,
): string[] {
	const { hardFailedKeys, pendingGapKeys, absentGapKeys } = partition;
	const lines: string[] = [];
	if (hardFailedKeys.length > 0) {
		const detail = describeFailedChunks(keys, results, new Set(hardFailedKeys));
		lines.push(
			`⚠️ ${totalChunks}${labels.unit}中${hardFailedKeys.length}${labels.unit}の取得に失敗しました（${detail}）。データが不完全な可能性があります。`,
		);
	}
	if (pendingGapKeys.length > 0) {
		lines.push(
			`ℹ️ ${labels.calendar} ${pendingGapKeys.join(', ')} は開始直後でデータ未生成のためスキップしました${labels.pendingSuffix}。`,
		);
	}
	if (absentGapKeys.length > 0) {
		lines.push(
			`ℹ️ ${labels.calendar} ${absentGapKeys.join(', ')} は上流に足がありません（上場前などデータが存在しない期間）。取得できた期間のみで応答しています。`,
		);
	}
	return lines;
}

function evaluateMergedChunks(
	keys: string[],
	merged: Pick<MergedChunkResult, 'rows' | 'results'>,
	pair: string,
	type: string,
	labels: ChunkWarnLabels,
): FailResult | { ok: true; warning: string | undefined } {
	if (merged.rows.length === 0) {
		const classified = classifyAllChunksFailure(merged.results);
		if (classified) return classified;
	}

	// 進行中の UTC 期間は開始直後に chunk 未生成で 404 になるので、過半数失敗に数えない（数えると JST 早朝の当日取得が全滅する）。
	const nowUtcDayKey = toDayKey(Date.now(), FETCH_CHUNK_TZ);
	const partition = partitionFailedChunks(keys, merged.results, nowUtcDayKey);
	const totalChunks = merged.results.length - partition.pendingGapKeys.length - partition.absentGapKeys.length;
	if (isMajorityChunkFailure(partition.hardFailedKeys.length, totalChunks)) {
		const detail = describeFailedChunks(keys, merged.results, new Set(partition.hardFailedKeys));
		return fail(
			`ローソク足取得の過半数が失敗しました（${pair}/${type}, ${totalChunks}${labels.unit}中${partition.hardFailedKeys.length}${labels.unit}失敗: ${detail}）`,
			'upstream',
		);
	}
	const warnLines = buildChunkWarnLines(keys, merged.results, partition, totalChunks, labels);
	return { ok: true, warning: warnLines.length > 0 ? warnLines.join('\n') : undefined };
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

	const anchorTz = normalizeAnchorTz(tz);

	const dateProvided = date != null;
	// date 省略時の基準日は anchorTz の暦日で解釈する（サーバーのローカル tz だと JST 早朝の UTC サーバー等で 1 日ずれる）。
	const effectiveDate = date ?? toDayKey(Date.now(), anchorTz);
	const dateCheck = validateDate(effectiveDate, String(type));
	if (!dateCheck.ok) return failFromValidation(dateCheck);

	const isYearlyType = YEARLY_TYPES.has(type);
	const isDailyType = DAILY_TYPES.has(type);
	const barsPerYear = BARS_PER_YEAR[type] || 365;
	const barsPerDay = BARS_PER_DAY[type] || 24;

	// YEARLY_TYPES は API が年単位で返すので、slice(-limit) だけだと「指定日以前 limit 件」ではなく「年末側 limit 件」になる。
	const anchorSpan = dateProvided ? computeAnchorSpan(effectiveDate, String(type), anchorTz) : null;
	const anchorEndMs = anchorSpan?.endMs ?? null;
	const anchorActive = anchorEndMs != null;

	// 未来日は期間の終端ではなく開始で判定する（終端だと当日を未来として誤拒否する）。
	if (anchorSpan != null) {
		if (anchorSpan.startMs > Date.now()) {
			const isoLocal = toIsoWithTz(anchorSpan.startMs, anchorTz) ?? String(anchorSpan.startMs);
			return fail(
				`No candle data available for date=${effectiveDate} (date is in the future, starts at ${isoLocal} ${anchorTz})`,
				'user',
			);
		}
		if (anchorSpan.endMs < BITBANK_SERVICE_START_MS) {
			return fail(`No candle data available for date=${effectiveDate} (before bitbank service start)`, 'user');
		}
	}

	// 年は UTC で数える（fetch key は UTC 年 chunk。anchorTz の年だと JST 元日早朝に存在しない未来年 chunk を要求して 404 になる）。
	const currentYear = Number(toYearKey(Date.now(), FETCH_CHUNK_TZ));
	const anchorYear = dateProvided && isYearlyType ? Number(dateCheck.value) : currentYear;
	const isCurrentYearAnchor = anchorYear === currentYear;

	// floor(経過時間 / 間隔) + 1 は確定済み本数 + 形成中の足。日数ベースだと 4hour 以上で形成中の今日の足まで確定済みと数え、年初の小 limit で前年取得が漏れる。
	const nowMs = Date.now();
	const intervalMs = INTERVAL_MS[String(type)] ?? 86_400_000;
	const elapsedThisYearMs = Math.max(0, nowMs - startOfYearMs(nowMs, FETCH_CHUNK_TZ));
	const estimatedBarsThisYear = Math.floor(elapsedThisYearMs / intervalMs) + 1;

	const barsInAnchorYear = (() => {
		if (!isYearlyType) return barsPerYear;
		const fromAnchor = dateProvided
			? estimateBarsAvailableInAnchorYear(effectiveDate, String(type), barsPerYear, anchorTz)
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

	// /candlestick は UTC 暦日でグルーピングするので、tz 暦日 window と交差する UTC 暦日 key を両方向に列挙する（過去方向だけだと UTC より西の tz でローカル日の後半が欠ける）。
	const multiDayUtcKeys: string[] = [];
	const localDaySpan = isDailyType ? parseDayKeyAllowingOverflow(dateCheck.value, anchorTz) : null;
	if (localDaySpan != null) {
		const localDayStartMs = localDaySpan.startMs;
		const localDayEndMs = localDaySpan.endMs;
		const intervalMsForDaily = INTERVAL_MS[String(type)] ?? 3_600_000;
		const lookbackStartMs = localDayEndMs - (limit - 1) * intervalMsForDaily;
		// realtime は「最新 limit 本」なので now 起点の lookback も window に含める（tz 暦日終端起点だけだと UTC 等で当日 1 chunk に潰れる）。
		const realtimeLookbackStartMs = !dateProvided
			? Date.now() - (limit - 1) * intervalMsForDaily
			: Number.POSITIVE_INFINITY;
		const windowStartMs = Math.min(localDayStartMs, lookbackStartMs, realtimeLookbackStartMs);
		// 列挙は現在時刻でクランプする。未来の UTC 日 chunk は 404 が確定しており、JST 早朝にその 404 が過半数失敗と誤判定されて取得済みデータごと捨てられる。
		const windowEndMs = Math.min(localDayEndMs, Date.now());

		multiDayUtcKeys.push(...enumerateDayKeys(windowStartMs, windowEndMs, FETCH_CHUNK_TZ));
	}
	// limit > barsPerDay は前者を実質含意するが、防御的に OR で評価する。
	const needsMultiDay = isDailyType && (multiDayUtcKeys.length >= 2 || limit > barsPerDay);

	const yearlyTzWindowActive = isYearlyType && dateProvided && anchorActive;
	const multiYearUtcKeys: string[] = [];
	if (yearlyTzWindowActive && anchorSpan != null) {
		const intervalMsYearly = INTERVAL_MS[String(type)] ?? 86_400_000;
		const periodStartMs = startOfYearMs(anchorSpan.startMs, anchorTz);
		const lookbackStartMs = anchorSpan.endMs - (limit - 1) * intervalMsYearly;
		const windowStartMs = Math.min(periodStartMs, lookbackStartMs);
		const windowEndMs = Math.min(anchorSpan.endMs, Date.now());
		multiYearUtcKeys.push(...enumerateYearKeys(windowStartMs, windowEndMs, FETCH_CHUNK_TZ));
	}
	const useLegacyMultiYear = isYearlyType && needsMultiYear && !yearlyTzWindowActive;
	const useYearlyMultiFetch = yearlyTzWindowActive && multiYearUtcKeys.length > 1;

	const maxLimit =
		needsMultiYear || useYearlyMultiFetch || useLegacyMultiYear
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
		if (useYearlyMultiFetch || useLegacyMultiYear) {
			const requestedYearKeys = yearlyTzWindowActive
				? multiYearUtcKeys
				: Array.from({ length: yearsNeeded }, (_, i) => String(anchorYear - i));
			const inRangeYearKeys = requestedYearKeys.filter((key) => Number(key) >= EARLIEST_CANDLE_YEAR);
			// 全部が下限より前なら、上流の応答（エラー）をそのまま返すために絞らない。
			const yearKeys = inRangeYearKeys.length > 0 ? inRangeYearKeys : requestedYearKeys;
			const skippedEarlyYears = yearKeys.length < requestedYearKeys.length;

			const merged = await mergeChunks(yearKeys, (key) =>
				fetchCandleChunk(chk.pair, type, key, { timeoutMs: CANDLE_FETCH.chunkTimeoutMs }),
			);
			lastRateLimit = merged.lastRateLimit;

			const outcome = evaluateMergedChunks(yearKeys, merged, chk.pair, type, {
				unit: '年',
				calendar: 'UTC 暦年',
				pendingSuffix: '',
			});
			if (!outcome.ok) return outcome;
			const skippedNote = skippedEarlyYears
				? `ℹ️ UTC 暦年 ${EARLIEST_CANDLE_YEAR - 1} 以前は bitbank に足が無いため取得していません。取得できた期間のみで応答しています。`
				: undefined;
			fetchWarning = [outcome.warning, skippedNote].filter(Boolean).join('\n') || undefined;

			ohlcvs = merged.rows;
			const years = yearKeys.map(Number);
			json = { data: { candlestick: [{ ohlcv: ohlcvs }] }, _multiYear: { years, totalFetched: ohlcvs.length } };
		} else if (needsMultiDay) {
			const merged = await mergeChunks(
				multiDayUtcKeys,
				(key) => fetchCandleChunk(chk.pair, type, key, { timeoutMs: CANDLE_FETCH.chunkTimeoutMs }),
				{
					batched: {
						concurrency: CANDLE_FETCH.dailyConcurrency,
						batchDelayMs: CANDLE_FETCH.dailyBatchDelayMs,
					},
				},
			);
			lastRateLimit = merged.lastRateLimit;

			const outcome = evaluateMergedChunks(multiDayUtcKeys, merged, chk.pair, type, {
				unit: '日',
				calendar: 'UTC 暦日',
				pendingSuffix: '（当日分は形成され次第、以降の取得で揃います）',
			});
			if (!outcome.ok) return outcome;
			fetchWarning = outcome.warning;

			ohlcvs = merged.rows;
			json = {
				data: { candlestick: [{ ohlcv: ohlcvs }] },
				_multiDay: { daysRequested: multiDayUtcKeys.length, totalFetched: ohlcvs.length },
			};
		} else {
			// dateCheck.value（tz 暦日）をそのまま key にすると、JST 早朝の当日取得で UTC ではまだ始まっていない日を要求して 404 になる。
			const singleKey =
				yearlyTzWindowActive && multiYearUtcKeys.length === 1
					? multiYearUtcKeys[0]
					: isDailyType && multiDayUtcKeys.length >= 1
						? multiDayUtcKeys[multiDayUtcKeys.length - 1]
						: dateCheck.value;
			const url = `${BITBANK_API_BASE}/${chk.pair}/candlestick/${type}/${singleKey}`;
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
			// optional chaining のフォールバックに任せると success:0 が空配列として握りつぶされるので、明示的に検証する。
			if (jsonObj?.success !== 1) {
				// 進行中の UTC 期間の success:0 はデータ未生成で上流障害ではないので、multi-fetch 経路の gap と同じく user 向けに明示する。
				if (isDailyType && String(singleKey) >= toDayKey(Date.now(), FETCH_CHUNK_TZ)) {
					return parseAsResult<GetCandlesData, GetCandlesMeta>(
						GetCandlesOutputSchema,
						fail(
							`No candle data available yet for ${chk.pair} / ${type} / ${singleKey} (UTC 暦日の開始直後でデータ未生成です。しばらく待って再試行するか、前日以前の date を指定してください)`,
							'user',
						),
					);
				}
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
			return fail(`No candle data returned from bitbank API for ${chk.pair} / ${type} / ${dateCheck.value}`, 'user');
		}

		// 無効な ts の行は落とさず、後段の row validation で upstream として弾く。
		const sortedOhlcvs = [...ohlcvs].sort((a, b) => {
			const aTs = Number((a as [unknown, unknown, unknown, unknown, unknown, unknown])[5]) || 0;
			const bTs = Number((b as [unknown, unknown, unknown, unknown, unknown, unknown])[5]) || 0;
			return aTs - bTs;
		});

		const dedupedOhlcvs = dedupeByTimestamp(sortedOhlcvs as OhlcvRow[]);

		const anchoredOhlcvs = anchorActive
			? dedupedOhlcvs.filter((r) => {
					const ts = Number((r as [unknown, unknown, unknown, unknown, unknown, unknown])[5]);
					if (!Number.isFinite(ts)) return true;
					return ts <= (anchorEndMs as number);
				})
			: dedupedOhlcvs;

		if (anchorActive && anchoredOhlcvs.length === 0) {
			return fail(
				`No candle data available for ${chk.pair} / ${type} on or before date=${effectiveDate} (data range exists but does not include this date)`,
				'user',
			);
		}

		const rows = anchoredOhlcvs.slice(-limitCheck.value) as Array<
			[unknown, unknown, unknown, unknown, unknown, unknown]
		>;

		// NaN は後続の Zod parse で落ちて catch の network 分類になるので、ここで upstream として分類する。
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

		// volume は base 通貨建ての買い+売り合算（OHLCV[4] をそのまま使う）。
		const displayTz = anchorTz;
		const normalized = rows.map(([o, h, l, c, v, ts]) => ({
			open: Number(o),
			high: Number(h),
			low: Number(l),
			close: Number(c),
			volume: Number(v),
			timestamp: Number(ts),
			isoTime: toIsoTime(ts) ?? undefined,
			isoTimeLocal: toIsoWithTz(Number(ts), displayTz) ?? undefined,
		}));

		const totalItems = normalized.length;
		const today = normalized[totalItems - 1];
		const sevenDaysAgo = totalItems >= 8 ? normalized[totalItems - 1 - 7] : null;
		const thirtyDaysAgo = totalItems >= 31 ? normalized[totalItems - 1 - 30] : null;
		const ninetyDaysAgo = totalItems >= 91 ? normalized[totalItems - 1 - 90] : totalItems > 0 ? normalized[0] : null;

		const calcChange = (from: number | undefined, to: number | undefined) => {
			if (!from || !to) return null;
			return ((to - from) / from) * 100;
		};

		const calcVolumeStats = () => {
			if (totalItems < 14) return null;

			const recent7Days = normalized.slice(totalItems - 7, totalItems);
			const recent7DaysAvg = recent7Days.reduce((sum, c) => sum + c.volume, 0) / 7;

			const previous7Days = normalized.slice(totalItems - 14, totalItems - 7);
			const previous7DaysAvg = previous7Days.reduce((sum, c) => sum + c.volume, 0) / 7;

			let last30DaysAvg: number | null = null;
			if (totalItems >= 30) {
				const last30 = normalized.slice(totalItems - 30, totalItems);
				last30DaysAvg = last30.reduce((sum, c) => sum + c.volume, 0) / last30.length;
			}

			// previous7DaysAvg === 0 は Infinity / NaN になり schema parse が落ちるので null にする。
			const volumeChangePct =
				previous7DaysAvg === 0 ? null : ((recent7DaysAvg - previous7DaysAvg) / previous7DaysAvg) * 100;

			let judgment: string;
			if (volumeChangePct === null) judgment = `比較不可（その前${barCountLabel(7, String(type))}の出来高ゼロ）`;
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
						date: formatDateInTz(today.timestamp, displayTz),
						close: today.close,
					}
				: null,
			sevenDaysAgo: sevenDaysAgo
				? {
						index: totalItems - 1 - 7,
						date: formatDateInTz(sevenDaysAgo.timestamp, displayTz),
						close: sevenDaysAgo.close,
						changePct: calcChange(sevenDaysAgo.close, today?.close),
					}
				: null,
			thirtyDaysAgo: thirtyDaysAgo
				? {
						index: totalItems - 1 - 30,
						date: formatDateInTz(thirtyDaysAgo.timestamp, displayTz),
						close: thirtyDaysAgo.close,
						changePct: calcChange(thirtyDaysAgo.close, today?.close),
					}
				: null,
			ninetyDaysAgo: ninetyDaysAgo
				? {
						index: ninetyDaysAgo === normalized[0] ? 0 : totalItems - 1 - 90,
						date: formatDateInTz(ninetyDaysAgo.timestamp, displayTz),
						close: ninetyDaysAgo.close,
						changePct: calcChange(ninetyDaysAgo.close, today?.close),
					}
				: null,
		};

		const priceRange =
			normalized.length > 0
				? {
						high: Math.max(...normalized.map((c) => c.high)),
						low: Math.min(...normalized.map((c) => c.low)),
						periodStart: formatDateInTz(normalized[0].timestamp, displayTz) || '',
						periodEnd: formatDateInTz(normalized[normalized.length - 1].timestamp, displayTz) || '',
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

		// 過去 anchor は確定足なので注記を付けない。判定は lib の isLatestBarProvisional に委ねる（自前実装しない）。
		const anchorIncludesNow = anchorEndMs == null || anchorEndMs > Date.now();
		const provisional = anchorIncludesNow && isLatestBarProvisional(normalized.at(-1)?.timestamp, String(type));

		// MCP クライアントが structuredContent.data を読めないので全ローソク足を summary に含める。
		const baseCurrency = chk.pair.split('_')[0]?.toUpperCase() ?? '';
		const candleLines = normalized.map((c, i: number) => {
			const t =
				(c as { isoTimeLocal?: string; isoTime?: string }).isoTimeLocal ||
				(c.isoTime ? c.isoTime.replace(/\.000Z$/, 'Z') : '?');
			return `[${i}] ${t} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`;
		});
		const body =
			baseSummary +
			`\n\n📋 全${normalized.length}件のOHLCV (volume=${baseCurrency}建て合算値):\n` +
			candleLines.join('\n') +
			`\n\n---\n📌 含まれるもの: OHLCV（volume=${baseCurrency}建て合算値）、価格レンジ、期間別変動率` +
			`\n📌 含まれないもの: 出来高の売買内訳、板情報、ファンディングレート、個別約定` +
			`\n📌 補完ツール: get_flow_metrics（売買内訳・CVD）, get_transactions（個別約定）, get_orderbook（板情報）`;
		// 順序は ⚠️ fetchWarning → ℹ️ 形成中注記 → 本文。
		const bodyWithNote = prependProvisionalNote(body, provisional, { separator: '\n' });
		const summary = fetchWarning ? `${fetchWarning}\n${bodyWithNote}` : bodyWithNote;

		const metaExtra: Record<string, unknown> = { type, count: normalized.length };
		if (lastRateLimit) metaExtra.rateLimit = lastRateLimit;
		if (fetchWarning) metaExtra.warning = fetchWarning;
		// handler が代替ビューでも注記を出すために参照する。
		if (provisional) metaExtra.provisional = true;
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
		if (/404/.test(rawMsg)) {
			if (['4hour', '8hour', '12hour'].includes(t)) {
				const hint = `${t} は YYYY 形式（例: 2025）が必要です。なお、現在この時間足がAPIで提供されていない可能性もあります。1hour または 1day での取得もお試しください。`;
				return parseAsResult<GetCandlesData, GetCandlesMeta>(
					GetCandlesOutputSchema,
					fail(`HTTP 404 Not Found (${chk.pair}/${t}). ${hint}`, 'user'),
				);
			}
			return parseAsResult<GetCandlesData, GetCandlesMeta>(
				GetCandlesOutputSchema,
				fail(
					`HTTP 404 from bitbank API for ${chk.pair} / ${type} / ${dateCheck.value} (unknown reason; check pair/type/date validity)`,
					'user',
				),
			);
		}
		return failFromError(e, {
			schema: GetCandlesOutputSchema,
			defaultType: 'network',
			defaultMessage: 'ネットワークエラー',
		});
	}
}

export const toolDef: ToolDefinition = {
	name: 'get_candles',
	description: `[Candles / OHLCV / Candlestick] ローソク足（candles / OHLCV / chart data）を取得。1min〜1monthの各時間足に対応。date は tz（既定 Asia/Tokyo）の暦日として解釈し、その終端以前の limit 本を返す。
詳細は inputSchema を参照。

【重要】バックテストには run_backtest を使用（データ取得〜チャート描画を一括実行）。`,
	inputSchema: GetCandlesInputSchema,
	handler: async ({
		pair,
		type,
		date,
		limit,
		format,
		tz,
	}: {
		pair: string;
		type: '1min' | '5min' | '15min' | '30min' | '1hour' | '4hour' | '8hour' | '12hour' | '1day' | '1week' | '1month';
		date?: string;
		limit?: number;
		format?: z.infer<typeof GetCandlesInputSchema>['format'];
		tz?: string;
	}) => {
		const result = await getCandles(pair, type, date, limit, tz);
		if (!result.ok) return result;
		const effectiveFormat: 'text' | 'json' = format ?? 'text';
		if (effectiveFormat === 'json') {
			const items = result?.data?.normalized ?? [];
			const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: JSON.stringify(items, null, 2) }];
			// format=json でも取得層の warning と形成中注記を落とさない（LLM がデータの不完全性に気づけなくなる）。
			const meta = result.meta as { warning?: string; provisional?: boolean } | undefined;
			if (meta?.warning) content.push({ type: 'text', text: meta.warning });
			if (meta?.provisional) content.push({ type: 'text', text: PROVISIONAL_BAR_NOTE });
			// format は content の形式だけを選び、structuredContent の契約は変えない。
			return { content, structuredContent: toStructured(result) };
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
