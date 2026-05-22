import { describe, expect, it } from 'vitest';
import {
	calendarDateFromIso,
	dayjs,
	daysAgo,
	formatDateInTz,
	formatDateWithDayOfWeek,
	nowIso,
	toDisplayTime,
	today,
	toIsoMs,
	toIsoTime,
	toIsoWithTz,
} from '../../lib/datetime.js';

describe('toIsoTime', () => {
	it('ミリ秒タイムスタンプを ISO8601 に変換する', () => {
		const result = toIsoTime(1700000000000);
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
	it('秒タイムスタンプも変換する', () => {
		const result = toIsoTime(1700000000);
		expect(result).not.toBeNull();
	});
	it('無効な値は null を返す', () => {
		expect(toIsoTime('invalid')).toBeNull();
		expect(toIsoTime(NaN)).toBeNull();
	});
});

describe('toIsoMs', () => {
	it('ミリ秒タイムスタンプを ISO8601 に変換する', () => {
		const result = toIsoMs(1700000000000);
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
	it('null は null を返す', () => {
		expect(toIsoMs(null)).toBeNull();
	});
});

describe('toIsoWithTz', () => {
	it('タイムゾーン付き ISO 形式を返す', () => {
		const result = toIsoWithTz(1700000000000, 'Asia/Tokyo');
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
	});
	it('UTC タイムゾーンで動作する', () => {
		const result = toIsoWithTz(1700000000000, 'UTC');
		expect(result).not.toBeNull();
	});
});

describe('toDisplayTime', () => {
	it('JST 表示形式を返す', () => {
		const result = toDisplayTime(1700000000000);
		expect(result).toMatch(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} JST/);
	});
	it('UTC 指定で UTC と表示する', () => {
		const result = toDisplayTime(1700000000000, 'UTC');
		expect(result).toContain('UTC');
	});
	it('undefined は現在時刻を返す', () => {
		const result = toDisplayTime(undefined);
		expect(result).toContain('JST');
	});
});

describe('nowIso', () => {
	it('ISO8601 形式の文字列を返す', () => {
		const result = nowIso();
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
});

describe('daysAgo', () => {
	it('デフォルトは YYYYMMDD 形式', () => {
		const result = daysAgo(7);
		expect(result).toMatch(/^\d{8}$/);
	});
	it('カスタムフォーマットを指定できる', () => {
		const result = daysAgo(7, 'YYYY-MM-DD');
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
	it('0日前は今日と一致する', () => {
		expect(daysAgo(0)).toBe(today());
	});
});

describe('today', () => {
	it('デフォルトは YYYYMMDD 形式', () => {
		const result = today();
		expect(result).toMatch(/^\d{8}$/);
	});
	it('dayjs と一致する', () => {
		expect(today('YYYY-MM-DD')).toBe(dayjs().format('YYYY-MM-DD'));
	});
});

describe('calendarDateFromIso', () => {
	const ms = Date.UTC(2025, 8, 30, 20, 0, 0); // 2025-09-30T20:00:00Z = JST 2025-10-01

	it('UTC ISO から tz 暦日を返す（split(T)[0] とは異なる）', () => {
		expect(calendarDateFromIso('2025-09-30T20:00:00.000Z', 'Asia/Tokyo')).toBe('2025-10-01');
		expect(calendarDateFromIso('2025-09-30T20:00:00.000Z', 'UTC')).toBe('2025-09-30');
	});

	it('ms でも受け付ける', () => {
		expect(calendarDateFromIso(ms, 'Asia/Tokyo')).toBe('2025-10-01');
	});
});

describe('formatDateInTz', () => {
	// 2025-10-01T00:00:00Z = JST 2025-10-01 09:00 = New York 2025-09-30 20:00 (EDT)
	const ms = 1759276800000;

	it('Asia/Tokyo (デフォルト) で JST 暦日を返す', () => {
		expect(formatDateInTz(ms)).toBe('2025-10-01');
		expect(formatDateInTz(ms, 'Asia/Tokyo')).toBe('2025-10-01');
	});

	it('UTC 指定で UTC 暦日を返す', () => {
		expect(formatDateInTz(ms, 'UTC')).toBe('2025-10-01');
	});

	it('America/New_York 指定で現地暦日を返す', () => {
		// EDT (UTC-4) なので 2025-09-30 20:00
		expect(formatDateInTz(ms, 'America/New_York')).toBe('2025-09-30');
	});

	it('JST と UTC で日付がずれる timestamp で差が出る', () => {
		// 2025-09-30T20:00:00Z UTC = JST 2025-10-01 05:00
		const crossing = Date.UTC(2025, 8, 30, 20, 0, 0);
		expect(formatDateInTz(crossing, 'UTC')).toBe('2025-09-30');
		expect(formatDateInTz(crossing, 'Asia/Tokyo')).toBe('2025-10-01');
	});

	it('null / undefined / NaN は null を返す', () => {
		expect(formatDateInTz(null)).toBeNull();
		expect(formatDateInTz(undefined)).toBeNull();
		expect(formatDateInTz(Number.NaN)).toBeNull();
		expect(formatDateInTz(Number.POSITIVE_INFINITY)).toBeNull();
	});

	it('tz が空文字列なら Asia/Tokyo にフォールバック', () => {
		expect(formatDateInTz(ms, '')).toBe(formatDateInTz(ms, 'Asia/Tokyo'));
	});

	it('不正な tz は null を返す（呼び出し側でフォールバックを明示できる）', () => {
		expect(formatDateInTz(ms, 'Invalid/Zone')).toBeNull();
		expect(formatDateInTz(ms, 'NotAZone')).toBeNull();
	});
});

describe('formatDateWithDayOfWeek', () => {
	it('ISO日付を M/D(曜日) 形式に変換する', () => {
		// 2026-04-09 is Thursday (木)
		expect(formatDateWithDayOfWeek('2026-04-09T00:00:00Z')).toBe('4/9(木)');
	});
	it('日曜日を正しく表示する', () => {
		// 2026-04-05 is Sunday (日)
		expect(formatDateWithDayOfWeek('2026-04-05T00:00:00Z')).toBe('4/5(日)');
	});
	it('無効な日付は n/a を返す', () => {
		expect(formatDateWithDayOfWeek('invalid')).toBe('n/a');
	});
});
