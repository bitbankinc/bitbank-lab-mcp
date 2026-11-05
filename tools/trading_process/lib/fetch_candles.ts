import { diffCalendarDays, endOfDayMs } from '../../../lib/calendar.js';
import { calendarDateFromIso, dayjs } from '../../../lib/datetime.js';
import getCandles from '../../get_candles.js';
import type { BacktestRange, Candle, Period, Timeframe } from '../types.js';

// bitbank の日足が JST 0:00 区切りなので固定し、実行環境の TZ に依存させない。
const BACKTEST_CALENDAR_TZ = 'Asia/Tokyo';

const PERIOD_TO_BARS: Record<Timeframe, Record<Period, number>> = {
	'1D': { '1M': 30, '3M': 90, '6M': 180, '1Y': 365, '2Y': 730, '3Y': 1095 },
	'4H': { '1M': 180, '3M': 540, '6M': 1080, '1Y': 2190, '2Y': 4380, '3Y': 6570 },
	'1H': { '1M': 720, '3M': 2160, '6M': 4320, '1Y': 8760, '2Y': 17520, '3Y': 26280 },
};

const TIMEFRAME_TO_CANDLE_TYPE: Record<Timeframe, string> = {
	'1D': '1day',
	'4H': '4hour',
	'1H': '1hour',
};

const BARS_PER_DAY: Record<Timeframe, number> = {
	'1D': 1,
	'4H': 6,
	'1H': 24,
};

// getCandles の複数年 / 複数日取得の maxLimit と整合させる。
const MAX_FETCHABLE_BARS: Record<Timeframe, number> = {
	'1D': 5000,
	'4H': 5000,
	'1H': 10000,
};

export function getPeriodBars(timeframe: Timeframe, period: Period): number {
	return PERIOD_TO_BARS[timeframe]?.[period] ?? 90;
}

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

async function fetchByAbsoluteRange(
	pair: string,
	timeframe: Timeframe,
	start: string,
	end: string,
	warmupBars: number,
): Promise<Candle[]> {
	const startMs = dayjs.tz(start, BACKTEST_CALENDAR_TZ).valueOf();
	// 暦日終端を当てる前に不正な日付を弾く（lib/calendar は非有限 ms に TypeError を投げる）。
	const endParsedMs = dayjs.tz(end, BACKTEST_CALENDAR_TZ).valueOf();
	if (Number.isNaN(startMs) || Number.isNaN(endParsedMs)) {
		throw new Error(`Invalid date format: start=${start}, end=${end}`);
	}
	const endMs = endOfDayMs(endParsedMs, BACKTEST_CALENDAR_TZ);
	if (startMs > endMs) {
		throw new Error(`start_date (${start}) must be on or before end_date (${end})`);
	}

	const barsPerDay = BARS_PER_DAY[timeframe];
	const maxBars = MAX_FETCHABLE_BARS[timeframe];

	// 当日ぶんを含めるので暦日差 + 1。ミリ秒差を 86400000 で割らない（DST で 1 日ずれる）。
	const daysFromTodayToStart = Math.max(0, diffCalendarDays(startMs, Date.now(), BACKTEST_CALENDAR_TZ) + 1);
	const neededBars = daysFromTodayToStart * barsPerDay + warmupBars + 20;
	const fetchLimit = Math.min(neededBars, maxBars);

	const uniqueCandles = await fetchRawCandles(pair, timeframe, fetchLimit);

	const fetchHitCap = fetchLimit >= maxBars;
	const earliestFetchedMs =
		uniqueCandles.length > 0 ? dayjs(uniqueCandles[0].time).valueOf() : Number.POSITIVE_INFINITY;
	if (earliestFetchedMs > startMs) {
		const earliest = uniqueCandles.length > 0 ? (calendarDateFromIso(uniqueCandles[0].time) ?? 'N/A') : 'N/A';
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

	const inRange = uniqueCandles.filter((c) => dayjs(c.time).valueOf() <= endMs);
	if (inRange.length === 0) {
		throw new Error(
			`No candle data in range [${start}, ${end}] (fetched ${uniqueCandles.length} candles, all outside range)`,
		);
	}

	const firstAtOrAfterStart = inRange.findIndex((c) => dayjs(c.time).valueOf() >= startMs);
	if (firstAtOrAfterStart === -1) {
		throw new Error(`No candle data on or after start_date (${start})`);
	}

	if (firstAtOrAfterStart < warmupBars) {
		throw new Error(
			`Insufficient warmup data: need ${warmupBars} bars before ${start} for indicator calculation, ` +
				`but only ${firstAtOrAfterStart} available. ` +
				`Use a more recent start_date or a strategy with shorter lookback.`,
		);
	}

	const warmupStartIdx = firstAtOrAfterStart - warmupBars;
	return inRange.slice(warmupStartIdx);
}

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
