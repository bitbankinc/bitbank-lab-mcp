import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export function toIsoTime(ts: unknown): string | null {
	const d = dayjs(Number(ts));
	return d.isValid() ? d.toISOString() : null;
}

export function toIsoMs(ms: number | null): string | null {
	if (ms == null) return null;
	const d = dayjs(ms);
	return d.isValid() ? d.toISOString() : null;
}

// 解決できない tz も Asia/Tokyo に畳む。formatDateInTz / toIsoWithTz は null を返すだけなので、そのまま使うと表示行が黙って消える。
export function resolveTz(tz: string | undefined | null, fallback: string = 'Asia/Tokyo'): string {
	if (typeof tz !== 'string' || tz.length === 0) return fallback;
	try {
		return dayjs(0).tz(tz).isValid() ? tz : fallback;
	} catch {
		return fallback;
	}
}

export function toIsoWithTz(ts: number, tz: string): string | null {
	try {
		const d = dayjs(ts).tz(tz);
		return d.isValid() ? d.format('YYYY-MM-DDTHH:mm:ss') : null;
	} catch {
		return null;
	}
}

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

// isoTime.split('T')[0] は UTC 暦日になるので JST 表示には使わない。
export function calendarDateFromIso(
	isoOrMs: string | number | null | undefined,
	tz: string = 'Asia/Tokyo',
): string | null {
	if (isoOrMs == null) return null;
	const ms = typeof isoOrMs === 'number' ? isoOrMs : dayjs(isoOrMs).valueOf();
	if (!Number.isFinite(ms)) return null;
	return formatDateInTz(ms, tz);
}

export function toDisplayTime(ts: number | undefined, tz: string = 'Asia/Tokyo'): string | null {
	try {
		const d = dayjs(ts).tz(tz);
		if (!d.isValid()) return null;
		const tzLabel = tz === 'UTC' ? 'UTC' : tz === 'Asia/Tokyo' ? 'JST' : `${tz} (UTC${d.format('Z')})`;
		return `${d.format('YYYY/MM/DD HH:mm:ss')} ${tzLabel}`;
	} catch {
		return null;
	}
}

export function nowIso(): string {
	return dayjs().toISOString();
}

export function daysAgo(daysAgo: number, format: string = 'YYYYMMDD'): string {
	return dayjs().subtract(daysAgo, 'day').format(format);
}

export function today(format: string = 'YYYYMMDD'): string {
	return dayjs().format(format);
}

export function parseIso8601(value: string): dayjs.Dayjs | null {
	if (!value) return null;

	const tzPattern = /([Zz]|[+-]\d{2}:\d{2}|[+-]\d{4})$/;
	const tzMatch = value.match(tzPattern);

	let dateTimePart = value;
	if (tzMatch) {
		dateTimePart = value.slice(0, -tzMatch[0].length);
	}

	const formats = ['YYYY-MM-DDTHH:mm:ss.SSS', 'YYYY-MM-DDTHH:mm:ss', 'YYYY-MM-DD'];

	for (const fmt of formats) {
		const d = dayjs(dateTimePart, fmt, true); // strict = true
		if (d.isValid()) {
			if (tzMatch) {
				const full = dayjs.utc(value);
				return full.isValid() ? full : d;
			}
			return d;
		}
	}
	return null;
}

// lib/ → tools/ の逆方向依存を作らないため lib に置き、tools/patterns/period.ts は互換のため re-export している（#233）。
const INTRADAY_TYPES = new Set(['1min', '5min', '15min', '30min', '1hour', '4hour', '8hour', '12hour']);

export function isIntradayType(type: string): boolean {
	return INTRADAY_TYPES.has(type);
}

// 判定はここに 1 本化している（#288）。フォールバック（'n/a' か元の ISO か）は呼び出し側が決める。
export function formatDateOrTimeInTz(iso: string | number | undefined | null, tz: string, type: string): string | null {
	if (iso == null || iso === '') return null;
	const ms = typeof iso === 'number' ? iso : Date.parse(iso);
	if (!Number.isFinite(ms)) return null;
	if (!isIntradayType(type)) return formatDateInTz(ms, tz);
	const withTz = toIsoWithTz(ms, resolveTz(tz)); // 'YYYY-MM-DDTHH:mm:ss'
	return withTz ? `${withTz.slice(0, 10)} ${withTz.slice(11, 16)}` : null;
}

export function formatDateWithDayOfWeek(isoDate: string): string {
	const days = ['日', '月', '火', '水', '木', '金', '土'];
	const d = dayjs(isoDate).utc();
	if (!d.isValid()) return 'n/a';
	const m = d.month() + 1;
	const day = d.date();
	const dow = days[d.day()];
	return `${m}/${day}(${dow})`;
}

export { dayjs };
