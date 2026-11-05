// tz は既定値を置かず必ず明示引数で渡す（date の解釈が UTC 暦日と JST 暦日に割れている問題を lib に持ち込まない）。
// tz 不正・非有限 ms は呼び出し側のバグなので TypeError、キー文字列の不正はユーザー入力由来なので null / false を返す。

import { dayjs } from './datetime.js';

const DAY_KEY_PATTERN = /^\d{8}$/;

const YEAR_KEY_PATTERN = /^\d{4}$/;

/** 文字列の辞書順が時系列順と一致する。 */
export type DayKey = string;

export type YearKey = string;

export interface CalendarSpan {
	readonly startMs: number;
	/** inclusive（次の区間の開始 - 1）。 */
	readonly endMs: number;
}

// 不正 tz を既定値へ倒すかは呼び出し側のポリシーなので、判定だけを提供する。
export function isSupportedTimeZone(tz: unknown): tz is string {
	if (typeof tz !== 'string' || tz.length === 0) return false;
	try {
		return dayjs(0).tz(tz).isValid();
	} catch {
		return false;
	}
}

function assertTimeZone(tz: string): void {
	if (!isSupportedTimeZone(tz)) {
		throw new TypeError(`calendar: unsupported time zone (received: ${String(tz)})`);
	}
}

function assertFiniteMs(ms: number, label: string): void {
	if (typeof ms !== 'number' || !Number.isFinite(ms)) {
		throw new TypeError(`calendar: ${label} must be a finite epoch millisecond value (received: ${String(ms)})`);
	}
}

function inTz(ms: number, tz: string, label = 'ms'): dayjs.Dayjs {
	assertFiniteMs(ms, label);
	assertTimeZone(tz);
	return dayjs(ms).tz(tz);
}

// DST 開始が 00:00 の tz ではその暦日に実在する最初の瞬間（01:00）を返す。
export function startOfDayMs(ms: number, tz: string): number {
	return inTz(ms, tz).startOf('day').valueOf();
}

export function endOfDayMs(ms: number, tz: string): number {
	return inTz(ms, tz).endOf('day').valueOf();
}

export function startOfYearMs(ms: number, tz: string): number {
	return inTz(ms, tz).startOf('year').valueOf();
}

export function endOfYearMs(ms: number, tz: string): number {
	return inTz(ms, tz).endOf('year').valueOf();
}

export function toDayKey(ms: number, tz: string): DayKey {
	return inTz(ms, tz).format('YYYYMMDD');
}

export function toYearKey(ms: number, tz: string): YearKey {
	return inTz(ms, tz).format('YYYY');
}

/** 実在しない日付も true になる。実在日まで確かめるなら parseDayKey の null で判定する。 */
export function isDayKeyFormat(value: unknown): value is DayKey {
	return typeof value === 'string' && DAY_KEY_PATTERN.test(value);
}

export function isYearKeyFormat(value: unknown): value is YearKey {
	return typeof value === 'string' && YEAR_KEY_PATTERN.test(value);
}

// dayjs.tz('2026-02-30', tz) は例外を投げずに 3/2 へ繰り上げるので、tz を当てる前に UTC の strict parse で実在日か確かめる。
export function parseDayKey(key: string, tz: string): CalendarSpan | null {
	if (!isDayKeyFormat(key)) return null;
	if (!dayjs.utc(key, 'YYYYMMDD', true).isValid()) return null;
	assertTimeZone(tz);
	const d = dayjs.tz(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`, tz);
	if (!d.isValid()) return null;
	return { startMs: d.startOf('day').valueOf(), endMs: d.endOf('day').valueOf() };
}

// 繰り上げるかは呼び出し側が関数の選択として明示する（get_candles の date は繰り上げ解釈のまま anchor を組んでおり、厳密解釈にすると結果が silent に変わる）。既定は parseDayKey を使う。
export function parseDayKeyAllowingOverflow(key: string, tz: string): CalendarSpan | null {
	if (!isDayKeyFormat(key)) return null;
	assertTimeZone(tz);
	const d = dayjs.tz(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`, tz);
	if (!d.isValid()) return null;
	return { startMs: d.startOf('day').valueOf(), endMs: d.endOf('day').valueOf() };
}

export function parseYearKey(key: string, tz: string): CalendarSpan | null {
	if (!isYearKeyFormat(key)) return null;
	assertTimeZone(tz);
	const d = dayjs.tz(`${key}-01-01`, tz);
	if (!d.isValid()) return null;
	return { startMs: d.startOf('year').valueOf(), endMs: d.endOf('year').valueOf() };
}

// ミリ秒に落とさないので DST による 23h / 25h の日を跨いでもズレない。
export function shiftDayKey(key: string, days: number): DayKey | null {
	if (!isDayKeyFormat(key) || !Number.isInteger(days)) return null;
	const d = dayjs.utc(key, 'YYYYMMDD', true);
	if (!d.isValid()) return null;
	return d.add(days, 'day').format('YYYYMMDD');
}

export function enumerateDayKeys(startMs: number, endMs: number, tz: string): DayKey[] {
	assertFiniteMs(startMs, 'startMs');
	assertFiniteMs(endMs, 'endMs');
	assertTimeZone(tz);
	if (startMs > endMs) return [];
	const lastKey = toDayKey(endMs, tz);
	const keys: DayKey[] = [];
	let key: DayKey | null = toDayKey(startMs, tz);
	while (key != null && key <= lastKey) {
		keys.push(key);
		key = shiftDayKey(key, 1);
	}
	return keys;
}

// ミリ秒差を 86400000 で割らない。DST を挟むと 23h / 25h の日が出て 1 日ずれる。
export function diffCalendarDays(fromMs: number, toMs: number, tz: string): number {
	const from = dayjs.utc(toDayKey(fromMs, tz), 'YYYYMMDD', true);
	const to = dayjs.utc(toDayKey(toMs, tz), 'YYYYMMDD', true);
	return to.diff(from, 'day');
}

export function enumerateYearKeys(startMs: number, endMs: number, tz: string): YearKey[] {
	assertFiniteMs(startMs, 'startMs');
	assertFiniteMs(endMs, 'endMs');
	assertTimeZone(tz);
	if (startMs > endMs) return [];
	const firstYear = Number(toYearKey(startMs, tz));
	const lastYear = Number(toYearKey(endMs, tz));
	const keys: YearKey[] = [];
	for (let y = firstYear; y <= lastYear; y++) keys.push(String(y).padStart(4, '0'));
	return keys;
}

export function isDayKeyCompleted(key: string, nowMs: number, tz: string): boolean {
	if (!isDayKeyFormat(key)) return false;
	return key < toDayKey(nowMs, tz);
}

export function recentCompletedDayKeys(count: number, nowMs: number, tz: string): DayKey[] {
	const wanted = Math.max(0, Math.floor(count));
	if (!(wanted > 0)) return [];
	const keys: DayKey[] = [];
	let key = shiftDayKey(toDayKey(nowMs, tz), -1);
	while (key != null && keys.length < wanted) {
		keys.push(key);
		key = shiftDayKey(key, -1);
	}
	return keys;
}
