/**
 * lib/fetch_candles.ts - バックテスト用ローソク足取得
 *
 * 【データ品質保証】
 * - time でソート（古い順）
 * - time をキーに重複排除
 * - 数値 NaN / time欠損は除外
 */

import { dayjs } from '../../../lib/datetime.js';
import getCandles from '../../get_candles.js';
import type { BacktestRange, Candle, Period, Timeframe } from '../types.js';

// 期間 → 必要本数のマッピング（バックテスト対象期間）
// 1D: 日足 → 1M=30, 3M=90, 6M=180, 1Y=365, 2Y=730, 3Y=1095
// 4H: 4時間足 → 1M=180, 3M=540, 6M=1080, 1Y=2190, 2Y=4380, 3Y=6570
// 1H: 1時間足 → 1M=720, 3M=2160, 6M=4320, 1Y=8760, 2Y=17520, 3Y=26280
const PERIOD_TO_BARS: Record<Timeframe, Record<Period, number>> = {
	'1D': { '1M': 30, '3M': 90, '6M': 180, '1Y': 365, '2Y': 730, '3Y': 1095 },
	'4H': { '1M': 180, '3M': 540, '6M': 1080, '1Y': 2190, '2Y': 4380, '3Y': 6570 },
	'1H': { '1M': 720, '3M': 2160, '6M': 4320, '1Y': 8760, '2Y': 17520, '3Y': 26280 },
};

// timeframe → get_candles の type マッピング
const TIMEFRAME_TO_CANDLE_TYPE: Record<Timeframe, string> = {
	'1D': '1day',
	'4H': '4hour',
	'1H': '1hour',
};

// timeframe → 1日あたりのバー数（絶対範囲指定時の本数推定に使う）
const BARS_PER_DAY: Record<Timeframe, number> = {
	'1D': 1,
	'4H': 6,
	'1H': 24,
};

// timeframe → getCandles から取得可能な上限本数
// （複数年/複数日取得時の maxLimit と整合させる）
const MAX_FETCHABLE_BARS: Record<Timeframe, number> = {
	'1D': 5000,
	'4H': 5000,
	'1H': 10000,
};

/**
 * 期間に対応するバックテスト対象本数を取得
 */
export function getPeriodBars(timeframe: Timeframe, period: Period): number {
	return PERIOD_TO_BARS[timeframe]?.[period] ?? 90;
}

/**
 * ローソク足データのバリデーション
 */
function isValidCandle(candle: Candle): boolean {
	if (!candle.time || candle.time.trim() === '') return false;

	const timestamp = dayjs(candle.time).valueOf();
	if (Number.isNaN(timestamp)) return false;

	if (
		Number.isNaN(candle.open) ||
		Number.isNaN(candle.high) ||
		Number.isNaN(candle.low) ||
		Number.isNaN(candle.close)
	) {
		return false;
	}

	if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0) {
		return false;
	}

	return true;
}

interface NormalizedCandle {
	isoTime?: string | null;
	open: number;
	high: number;
	low: number;
	close: number;
	volume?: number | null;
}

function normalizeAndClean(normalized: NormalizedCandle[]): Candle[] {
	const rawCandles: Candle[] = normalized.map((c) => ({
		time: c.isoTime || '',
		open: Number(c.open),
		high: Number(c.high),
		low: Number(c.low),
		close: Number(c.close),
		volume: c.volume != null ? Number(c.volume) : undefined,
	}));

	const valid = rawCandles.filter(isValidCandle);
	if (valid.length === 0) {
		throw new Error('No valid candle data after filtering');
	}

	valid.sort((a, b) => dayjs(a.time).valueOf() - dayjs(b.time).valueOf());

	// Map は挿入順を保持するので、ソート済みを set すれば結果も時系列順
	const uniqueMap = new Map<string, Candle>();
	for (const candle of valid) {
		uniqueMap.set(candle.time, candle);
	}
	return Array.from(uniqueMap.values());
}

async function fetchRawCandles(pair: string, timeframe: Timeframe, fetchLimit: number): Promise<Candle[]> {
	const candleType = TIMEFRAME_TO_CANDLE_TYPE[timeframe];
	if (!candleType) {
		throw new Error(`Unsupported timeframe: ${timeframe}`);
	}

	const result = await getCandles(pair, candleType, undefined, fetchLimit);
	if (!result.ok) {
		throw new Error(`Failed to fetch candles: ${result.summary}`);
	}

	const normalized = result.data?.normalized;
	if (!normalized || !Array.isArray(normalized) || normalized.length === 0) {
		throw new Error('No candle data returned');
	}

	return normalizeAndClean(normalized as NormalizedCandle[]);
}

/**
 * 直近 N 本（period 指定）でローソク足を取得
 */
async function fetchByPeriod(
	pair: string,
	timeframe: Timeframe,
	period: Period,
	warmupBars: number,
): Promise<Candle[]> {
	const periodBars = PERIOD_TO_BARS[timeframe]?.[period];
	if (!periodBars) {
		throw new Error(`Unsupported timeframe/period: ${timeframe}/${period}`);
	}

	// 必要な本数: バックテスト期間 + ウォームアップ + バッファ
	const neededBars = periodBars + warmupBars + 10;
	const maxBars = MAX_FETCHABLE_BARS[timeframe];
	const fetchLimit = Math.min(
		// 日足は複数年取得を発動させるため最低 400 を指定
		timeframe === '1D' ? Math.max(neededBars, 400) : neededBars,
		maxBars,
	);

	const uniqueCandles = await fetchRawCandles(pair, timeframe, fetchLimit);

	if (uniqueCandles.length <= neededBars) {
		return uniqueCandles;
	}

	const startIdx = uniqueCandles.length - neededBars;
	return uniqueCandles.slice(startIdx);
}

/**
 * 絶対日付範囲でローソク足を取得
 * start_date - warmupBars 本前 〜 end_date までを返す
 */
async function fetchByAbsoluteRange(
	pair: string,
	timeframe: Timeframe,
	start: string,
	end: string,
	warmupBars: number,
): Promise<Candle[]> {
	const startMs = dayjs(start).valueOf();
	const endMs = dayjs(end).endOf('day').valueOf();
	if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
		throw new Error(`Invalid date format: start=${start}, end=${end}`);
	}
	if (startMs > endMs) {
		throw new Error(`start_date (${start}) must be on or before end_date (${end})`);
	}

	const barsPerDay = BARS_PER_DAY[timeframe];
	const maxBars = MAX_FETCHABLE_BARS[timeframe];
	const todayMs = dayjs().endOf('day').valueOf();

	// 今日から start_date まで遡る日数（最低 0）
	const daysFromTodayToStart = Math.max(0, Math.ceil((todayMs - startMs) / (24 * 60 * 60 * 1000)));
	const neededBars = daysFromTodayToStart * barsPerDay + warmupBars + 20;
	const fetchLimit = Math.min(neededBars, maxBars);

	const uniqueCandles = await fetchRawCandles(pair, timeframe, fetchLimit);

	// 最古ローソク足が start_date より新しい → 要求レンジのデータ不足
	const fetchHitCap = fetchLimit >= maxBars;
	const earliestFetchedMs =
		uniqueCandles.length > 0 ? dayjs(uniqueCandles[0].time).valueOf() : Number.POSITIVE_INFINITY;
	if (earliestFetchedMs > startMs) {
		const earliest = uniqueCandles.length > 0 ? uniqueCandles[0].time.slice(0, 10) : 'N/A';
		if (fetchHitCap) {
			throw new Error(
				`Insufficient historical data: requested start_date=${start} but earliest available is ${earliest} ` +
					`(hit API fetch cap of ${maxBars} bars for ${timeframe}). ` +
					`Use a more recent start_date, switch to a coarser timeframe, or use period (1M~3Y) instead.`,
			);
		}
		throw new Error(
			`Insufficient historical data: requested start_date=${start} but earliest available is ${earliest} ` +
				`(API returned ${uniqueCandles.length} bars, did not extend to ${start}). ` +
				`Use a more recent start_date or check if data exists for this pair/timeframe at that period.`,
		);
	}

	// end_date より後を除外
	const inRange = uniqueCandles.filter((c) => dayjs(c.time).valueOf() <= endMs);
	if (inRange.length === 0) {
		throw new Error(
			`No candle data in range [${start}, ${end}] (fetched ${uniqueCandles.length} candles, all outside range)`,
		);
	}

	// start_date 以降の最初のインデックス
	const firstAtOrAfterStart = inRange.findIndex((c) => dayjs(c.time).valueOf() >= startMs);
	if (firstAtOrAfterStart === -1) {
		throw new Error(`No candle data on or after start_date (${start})`);
	}

	// ウォームアップ分の本数が start_date より前に確保できているか検証
	if (firstAtOrAfterStart < warmupBars) {
		throw new Error(
			`Insufficient warmup data: need ${warmupBars} bars before ${start} for indicator calculation, ` +
				`but only ${firstAtOrAfterStart} available. ` +
				`Use a more recent start_date or a strategy with shorter lookback.`,
		);
	}

	// ウォームアップ分だけ start_date より前を含める
	const warmupStartIdx = firstAtOrAfterStart - warmupBars;
	return inRange.slice(warmupStartIdx);
}

/**
 * バックテスト用にローソク足を取得
 *
 * @param pair 通貨ペア
 * @param timeframe 時間軸
 * @param range 期間指定（period 直近 N 本 / absolute 日付範囲）
 * @param warmupBars ウォームアップ用に追加で必要な本数（長期 SMA 等）
 * @returns ローソク足配列（古い順、ウォームアップ込み）
 */
export async function fetchCandlesForBacktest(
	pair: string,
	timeframe: Timeframe,
	range: BacktestRange,
	warmupBars: number,
): Promise<Candle[]> {
	if (range.type === 'period') {
		return fetchByPeriod(pair, timeframe, range.value, warmupBars);
	}
	return fetchByAbsoluteRange(pair, timeframe, range.start, range.end, warmupBars);
}
