/**
 * 日時変換ユーティリティ
 * 各ツールで重複していた関数を統一
 * dayjs ベースで実装
 */

import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';

// プラグイン有効化
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

/**
 * タイムスタンプをISO8601形式に変換
 * @param ts タイムスタンプ（ミリ秒または秒、unknown型対応）
 * @returns ISO8601文字列、無効な場合はnull
 */
export function toIsoTime(ts: unknown): string | null {
	const d = dayjs(Number(ts));
	return d.isValid() ? d.toISOString() : null;
}

/**
 * ミリ秒タイムスタンプをISO8601形式に変換（null安全版）
 * @param ms ミリ秒タイムスタンプ
 * @returns ISO8601文字列、無効な場合はnull
 */
export function toIsoMs(ms: number | null): string | null {
	if (ms == null) return null;
	const d = dayjs(ms);
	return d.isValid() ? d.toISOString() : null;
}

/**
 * タイムスタンプをタイムゾーン付きISO風形式に変換
 * @param ts ミリ秒タイムスタンプ
 * @param tz タイムゾーン（例: 'Asia/Tokyo', 'UTC'）
 * @returns "2025-01-15T14:30:00" 形式、エラー時はnull
 */
export function toIsoWithTz(ts: number, tz: string): string | null {
	try {
		const d = dayjs(ts).tz(tz);
		return d.isValid() ? d.format('YYYY-MM-DDTHH:mm:ss') : null;
	} catch {
		return null;
	}
}

/**
 * タイムスタンプを指定タイムゾーンの暦日 YYYY-MM-DD に変換
 * @param ms ミリ秒タイムスタンプ
 * @param tz タイムゾーン（デフォルト: 'Asia/Tokyo'、空文字も Asia/Tokyo にフォールバック）
 * @returns "YYYY-MM-DD" 形式、ms が null/undefined/NaN または tz が不正なら null
 */
export function formatDateInTz(ms: number | undefined | null, tz: string = 'Asia/Tokyo'): string | null {
	if (ms == null) return null;
	if (!Number.isFinite(ms)) return null;
	const effectiveTz = typeof tz === 'string' && tz.length > 0 ? tz : 'Asia/Tokyo';
	try {
		const d = dayjs(ms).tz(effectiveTz);
		return d.isValid() ? d.format('YYYY-MM-DD') : null;
	} catch {
		return null;
	}
}

/**
 * UTC ISO 文字列または ms から、指定 tz の暦日 YYYY-MM-DD を返す（表示・比較用）。
 * isoTime.split('T')[0] は UTC 暦日になるため、JST 表示には使わない。
 */
export function calendarDateFromIso(
	isoOrMs: string | number | null | undefined,
	tz: string = 'Asia/Tokyo',
): string | null {
	if (isoOrMs == null) return null;
	const ms = typeof isoOrMs === 'number' ? isoOrMs : dayjs(isoOrMs).valueOf();
	if (!Number.isFinite(ms)) return null;
	return formatDateInTz(ms, tz);
}

/**
 * タイムスタンプを日本語表示形式に変換
 * @param ts ミリ秒タイムスタンプ（未指定時は現在時刻）
 * @param tz タイムゾーン（デフォルト: 'Asia/Tokyo'）
 * @returns "2025/01/15 14:30:00 JST" 形式
 */
export function toDisplayTime(ts: number | undefined, tz: string = 'Asia/Tokyo'): string | null {
	try {
		const d = dayjs(ts).tz(tz);
		if (!d.isValid()) return null;
		const tzShort = tz === 'UTC' ? 'UTC' : 'JST';
		return `${d.format('YYYY/MM/DD HH:mm:ss')} ${tzShort}`;
	} catch {
		return null;
	}
}

/**
 * 現在時刻をISO8601形式で取得
 * @returns ISO8601文字列
 */
export function nowIso(): string {
	return dayjs().toISOString();
}

/**
 * 現在時刻を指定タイムゾーンで取得
 * @param tz タイムゾーン（デフォルト: 'Asia/Tokyo'）
 * @returns dayjs インスタンス
 */
export function nowTz(tz: string = 'Asia/Tokyo') {
	return dayjs().tz(tz);
}

/**
 * N日前の日付を取得
 * @param daysAgo 何日前か
 * @param format 出力フォーマット（デフォルト: 'YYYYMMDD'）
 * @returns フォーマットされた日付文字列
 */
export function daysAgo(daysAgo: number, format: string = 'YYYYMMDD'): string {
	return dayjs().subtract(daysAgo, 'day').format(format);
}

/**
 * 今日の日付を取得
 * @param format 出力フォーマット（デフォルト: 'YYYYMMDD'）
 * @returns フォーマットされた日付文字列
 */
export function today(format: string = 'YYYYMMDD'): string {
	return dayjs().format(format);
}

/**
 * ISO8601 文字列を strict parse する。
 * `2025-99-99` のような不正値を確実に弾く。
 * @returns dayjs インスタンス（isValid() === true）、不正時は null
 */
export function parseIso8601(value: string): dayjs.Dayjs | null {
	if (!value) return null;

	// タイムゾーン部分を分離して日時部分だけ strict parse する
	// ISO8601: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss[.SSS][Z|±HH:mm|±HHmm]
	const tzPattern = /([Zz]|[+-]\d{2}:\d{2}|[+-]\d{4})$/;
	const tzMatch = value.match(tzPattern);

	let dateTimePart = value;
	if (tzMatch) {
		dateTimePart = value.slice(0, -tzMatch[0].length);
	}

	// 日時部分のフォーマット候補
	const formats = ['YYYY-MM-DDTHH:mm:ss.SSS', 'YYYY-MM-DDTHH:mm:ss', 'YYYY-MM-DD'];

	for (const fmt of formats) {
		const d = dayjs(dateTimePart, fmt, true); // strict = true
		if (d.isValid()) {
			// TZ 付きの場合は元の文字列から utc parse して正確な時刻を返す
			if (tzMatch) {
				const full = dayjs.utc(value);
				return full.isValid() ? full : d;
			}
			return d;
		}
	}
	return null;
}

/**
 * ISO日付文字列を "M/D(曜日)" 形式に変換
 * 例: "2026-04-09T00:00:00Z" → "4/9(木)"
 * @param isoDate ISO8601 日付文字列
 */
export function formatDateWithDayOfWeek(isoDate: string): string {
	const days = ['日', '月', '火', '水', '木', '金', '土'];
	const d = dayjs(isoDate).utc();
	if (!d.isValid()) return 'n/a';
	const m = d.month() + 1;
	const day = d.date();
	const dow = days[d.day()];
	return `${m}/${day}(${dow})`;
}

// dayjs インスタンスを直接使いたい場合のエクスポート
export { dayjs };
