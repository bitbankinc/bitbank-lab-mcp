/**
 * 暦日（カレンダーデー）プリミティブ。
 *
 * 「ある tz の暦日はいつ始まっていつ終わるか」「その瞬間はどの暦日キーか」
 * 「2 時刻の間にどの暦日キーが挟まるか」「その暦日はもう完了したか」だけを扱う。
 * 上流 API の仕様（bitbank の約定アーカイブは UTC 暦日単位、/candlestick は UTC 暦日
 * chunk 等）はドメイン層（`lib/tx-archive.ts` など）の責務であり、本モジュールは持たない。
 *
 * ## tz は必ず明示引数で渡す
 *
 * 既定値を置かない。同じ関数名で暦の基準が呼び出し箇所ごとに違う——現に
 * `date: 'YYYYMMDD'` の解釈が UTC 暦日と JST 暦日に割れている——という問題を
 * lib 側に持ち込まないため。`'UTC'` も普通の tz として渡す。
 *
 * ## 入力が不正なときの挙動
 *
 * - **tz が不正 / ms が非有限** → `TypeError` を throw する。呼び出し側のバグであり、
 *   黙って `NaN` や `'Invalid Date'` を伝播させると原因の遠い場所で壊れる。
 *   ユーザー入力の tz は `isSupportedTimeZone()` で先に正規化すること。
 * - **キー文字列の形式不正 / 実在しない日付** → `null`（`parse*`）または `false`（`is*`）を返す。
 *   こちらはユーザー入力由来なので throw しない。
 *
 * 素の `Date` コンストラクタは banned（`.claude/hooks/post-ts-lint.sh`）。日時計算は
 * `lib/datetime.ts` の dayjs（utc / timezone / customParseFormat プラグイン適用済み）に集約する。
 */

import { dayjs } from './datetime.js';

/** 暦日キーの形式（YYYYMMDD）。実在日かどうかは見ない。 */
const DAY_KEY_PATTERN = /^\d{8}$/;

/** 暦年キーの形式（YYYY）。 */
const YEAR_KEY_PATTERN = /^\d{4}$/;

/** 暦日キー（`YYYYMMDD`）。文字列の辞書順が時系列順と一致する。 */
export type DayKey = string;

/** 暦年キー（`YYYY`）。 */
export type YearKey = string;

/** 暦上の 1 区間。 */
export interface CalendarSpan {
	/** 区間の最初のミリ秒。 */
	readonly startMs: number;
	/** 区間の最後のミリ秒（**inclusive**）。次の区間の開始 - 1 に等しい。 */
	readonly endMs: number;
}

/**
 * dayjs（= Intl）が解釈できる tz 文字列か。空文字・未定義・不正な IANA 名は false。
 *
 * 不正 tz を既定値へ倒すかどうかは呼び出し側のポリシーなので、本モジュールでは判定だけ提供する。
 * 例: `const safeTz = isSupportedTimeZone(tz) ? tz : 'Asia/Tokyo';`
 */
export function isSupportedTimeZone(tz: unknown): tz is string {
	if (typeof tz !== 'string' || tz.length === 0) return false;
	try {
		return dayjs(0).tz(tz).isValid();
	} catch {
		// Intl は不正な tz 名に RangeError を投げる
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

/**
 * ms が属する tz 暦日の最初のミリ秒。
 *
 * DST 開始が 00:00 の tz（例: 2017-10-15 の America/Sao_Paulo は 00:00 が存在しない）では
 * その暦日に実在する最初の瞬間（01:00）を返す。
 */
export function startOfDayMs(ms: number, tz: string): number {
	return inTz(ms, tz).startOf('day').valueOf();
}

/** ms が属する tz 暦日の最後のミリ秒（23:59:59.999 相当。**inclusive**）。 */
export function endOfDayMs(ms: number, tz: string): number {
	return inTz(ms, tz).endOf('day').valueOf();
}

/** ms が属する tz 暦年の最初のミリ秒（1/1 00:00:00.000 in tz）。 */
export function startOfYearMs(ms: number, tz: string): number {
	return inTz(ms, tz).startOf('year').valueOf();
}

/** ms が属する tz 暦年の最後のミリ秒（12/31 23:59:59.999 in tz。**inclusive**）。 */
export function endOfYearMs(ms: number, tz: string): number {
	return inTz(ms, tz).endOf('year').valueOf();
}

/** ms が属する tz 暦日のキー（`YYYYMMDD`）。 */
export function toDayKey(ms: number, tz: string): DayKey {
	return inTz(ms, tz).format('YYYYMMDD');
}

/** ms が属する tz 暦年のキー（`YYYY`）。 */
export function toYearKey(ms: number, tz: string): YearKey {
	return inTz(ms, tz).format('YYYY');
}

/**
 * `YYYYMMDD` の**形式**を満たすか。2026-02-30 のような実在しない日付も true になる。
 * 実在日まで確かめたい場合は `parseDayKey()` が `null` を返すかで判定する。
 */
export function isDayKeyFormat(value: unknown): value is DayKey {
	return typeof value === 'string' && DAY_KEY_PATTERN.test(value);
}

/** `YYYY` の形式を満たすか。 */
export function isYearKeyFormat(value: unknown): value is YearKey {
	return typeof value === 'string' && YEAR_KEY_PATTERN.test(value);
}

/**
 * 暦日キー（`YYYYMMDD`）を tz 上の区間に変換する。形式不正・実在しない日付は `null`。
 *
 * `dayjs.tz('2026-02-30', tz)` は例外を投げずに 3/2 へ繰り上げてしまうため、
 * tz を当てる前に UTC の strict parse で実在日かどうかを確かめる。
 */
export function parseDayKey(key: string, tz: string): CalendarSpan | null {
	if (!isDayKeyFormat(key)) return null;
	if (!dayjs.utc(key, 'YYYYMMDD', true).isValid()) return null;
	assertTimeZone(tz);
	const d = dayjs.tz(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`, tz);
	if (!d.isValid()) return null;
	return { startMs: d.startOf('day').valueOf(), endMs: d.endOf('day').valueOf() };
}

/**
 * 暦日キーを tz 上の区間に変換する（**繰り上げ許容**版）。
 *
 * `parseDayKey` が実在しない日付を `null` で弾くのに対し、こちらはグレゴリオ暦の繰り上げで
 * 解釈する（`20260230` → 2026-03-02、`20251232` → 2026-01-01）。形式不正は `null`。
 *
 * 入力の**形式だけ**を検証して実在日を見ない層を通った値を扱う呼び出し側のための入口。
 * 現に `lib/validate.ts` の `validateDate` は `/^\d{8}$/` しか見ず、`get_candles` の `date` は
 * 繰り上げ解釈のまま anchor と fetch 範囲を組んでいる。厳密解釈へ倒すと「anchor 無効 →
 * 最新側 limit 本」のように結果が silent に変わるため、繰り上げるかどうかは
 * **呼び出し側が関数の選択として明示する**。
 *
 * 既定は `parseDayKey`（実在日を要求する方）を使うこと。
 */
export function parseDayKeyAllowingOverflow(key: string, tz: string): CalendarSpan | null {
	if (!isDayKeyFormat(key)) return null;
	assertTimeZone(tz);
	const d = dayjs.tz(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`, tz);
	if (!d.isValid()) return null;
	return { startMs: d.startOf('day').valueOf(), endMs: d.endOf('day').valueOf() };
}

/** 暦年キー（`YYYY`）を tz 上の区間に変換する。形式不正は `null`。 */
export function parseYearKey(key: string, tz: string): CalendarSpan | null {
	if (!isYearKeyFormat(key)) return null;
	assertTimeZone(tz);
	const d = dayjs.tz(`${key}-01-01`, tz);
	if (!d.isValid()) return null;
	return { startMs: d.startOf('year').valueOf(), endMs: d.endOf('year').valueOf() };
}

/**
 * 暦日キーを days 日ずらす。形式不正・実在しない日付・非整数 days は `null`。
 *
 * グレゴリオ暦の日付演算のみで、tz には依存しない（`20260301` の前日は
 * どの tz でも `20260228` / 閏年なら `20260229`）。ミリ秒に落とさないので
 * DST による 23h / 25h の日を跨いでもズレない。
 */
export function shiftDayKey(key: string, days: number): DayKey | null {
	if (!isDayKeyFormat(key) || !Number.isInteger(days)) return null;
	const d = dayjs.utc(key, 'YYYYMMDD', true);
	if (!d.isValid()) return null;
	return d.add(days, 'day').format('YYYYMMDD');
}

/**
 * [startMs, endMs] と交差する tz 暦日キーを昇順（inclusive）で列挙する。
 * `startMs > endMs` なら空配列。
 *
 * 列挙はキーの日付演算で進めるため、DST で 23h / 25h になる日や月末・閏日を跨いでも
 * 日が飛んだり重複したりしない。
 */
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

/**
 * 2 つの瞬間が属する tz 暦日の差（`toMs` の暦日 − `fromMs` の暦日、単位: 日）。
 * 同じ暦日なら 0、`toMs` が翌日なら 1、前日なら -1。
 *
 * ミリ秒差を 86400000 で割ってはいけない。DST を挟むと 23h / 25h の日が出て 1 日ぶんずれる
 * （`America/New_York` の 2025-01-01 → 06-16 は暦日で 166 日だが ms 差は 165 日 23 時間）。
 * 暦日キーの日付演算で数えるためオフセットの変化に影響されない。
 */
export function diffCalendarDays(fromMs: number, toMs: number, tz: string): number {
	const from = dayjs.utc(toDayKey(fromMs, tz), 'YYYYMMDD', true);
	const to = dayjs.utc(toDayKey(toMs, tz), 'YYYYMMDD', true);
	return to.diff(from, 'day');
}

/**
 * [startMs, endMs] と交差する tz 暦年キーを昇順（inclusive）で列挙する。
 * `startMs > endMs` なら空配列。
 */
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

/**
 * その暦日キーが nowMs 時点で**完了しているか**（= nowMs が属する暦日より前か）。
 * 進行中の暦日・未来の暦日は false。形式不正も false。
 */
export function isDayKeyCompleted(key: string, nowMs: number, tz: string): boolean {
	if (!isDayKeyFormat(key)) return false;
	return key < toDayKey(nowMs, tz);
}

/**
 * 直近 count 個の完了済み tz 暦日キーを新しい順で返す。
 * nowMs が属する進行中の暦日は含めない。count <= 0 / 非数値は空配列。
 */
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
