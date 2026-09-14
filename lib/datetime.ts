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
 * tz 文字列を「実際に整形に使える IANA タイムゾーン」へ正規化する。
 *
 * 空文字・未指定に加えて、**IANA 名として解決できない値**（'Tokyo' / 'Not/AZone' 等）も
 * `Asia/Tokyo` に畳む。`formatDateInTz` / `toIsoWithTz` は解決できない tz に対して
 * `null` を返すだけなので、呼び出し側がそのまま使うと「表示行が丸ごと消える」
 * 「日付が空文字になる」という形で情報が黙って落ちる。表示前にここを通すこと。
 *
 * 判定は固定 epoch（0）で行うので現在時刻に依存しない。
 *
 * @returns 解決できた tz、できなければ 'Asia/Tokyo'
 */
export function resolveTz(tz: string | undefined | null, fallback: string = 'Asia/Tokyo'): string {
	if (typeof tz !== 'string' || tz.length === 0) return fallback;
	try {
		return dayjs(0).tz(tz).isValid() ? tz : fallback;
	} catch {
		return fallback;
	}
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
 * 日足未満（intraday）の時間足。
 * 暦日だけで表示すると足の位置が特定できず「直近◯時間がスキャンされていない」という
 * 誤読を招く（issue #200 の誤読の直接原因）ため、これらは時刻まで表示する。
 *
 * issue #233: 元は `tools/patterns/period.ts` にあったが、`lib/pattern-diagrams.ts`
 * （構造図）からも必要になったため `lib/` へ移した。`lib/` → `tools/` の逆方向依存を
 * 作らないための移動で、時間足の分類という土台的な判定は `lib/` 側が定位置。
 * `tools/patterns/period.ts` は互換のため re-export している。
 */
const INTRADAY_TYPES = new Set(['1min', '5min', '15min', '30min', '1hour', '4hour', '8hour', '12hour']);

/** 時間足が日足未満（= 表示に時刻まで含めるべき）か。 */
export function isIntradayType(type: string): boolean {
	return INTRADAY_TYPES.has(type);
}

/**
 * UTC ISO 文字列を、時間足に応じて暦日 `YYYY-MM-DD`（日足以上）または分単位
 * `YYYY-MM-DD HH:mm`（intraday）へ整形する（issue #200 要件 F-1 の共通実装）。
 *
 * **暦日に潰すと intraday では 24 本が同じラベルになり、どの足かを特定できない。**
 * `detect_patterns` の `content` はブレイク足・構成点・ターゲット初到達といった
 * 「どの足か」が意味を持つ行を出すので、時間足を見て粒度を切り替える必要がある。
 *
 * `src/handlers/detectPatternsViewsHandler.ts` の `toDateOrTime` と
 * `tools/detect_patterns.ts` の `res.summary` が**別々に同じ判定を持っていて片方だけ
 * 暦日に潰れていた**（#288 Phase 2 のレビュー指摘）ので、判定をここに 1 本化した。
 *
 * 値が空 / parse 失敗 / 不正 tz のときは `null` を返す。**フォールバックは呼び出し側が決める**
 * （`'n/a'` を出す側と、元の ISO をそのまま出す側がある）。
 */
export function formatDateOrTimeInTz(iso: string | number | undefined | null, tz: string, type: string): string | null {
	if (iso == null || iso === '') return null;
	const ms = typeof iso === 'number' ? iso : Date.parse(iso);
	if (!Number.isFinite(ms)) return null;
	if (!isIntradayType(type)) return formatDateInTz(ms, tz);
	const withTz = toIsoWithTz(ms, resolveTz(tz)); // 'YYYY-MM-DDTHH:mm:ss'
	return withTz ? `${withTz.slice(0, 10)} ${withTz.slice(11, 16)}` : null;
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
