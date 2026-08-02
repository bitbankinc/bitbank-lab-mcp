import { describe, expect, it } from 'vitest';
import {
	type CalendarSpan,
	diffCalendarDays,
	endOfDayMs,
	endOfYearMs,
	enumerateDayKeys,
	enumerateYearKeys,
	isDayKeyCompleted,
	isDayKeyFormat,
	isSupportedTimeZone,
	isYearKeyFormat,
	parseDayKey,
	parseDayKeyAllowingOverflow,
	parseYearKey,
	recentCompletedDayKeys,
	shiftDayKey,
	startOfDayMs,
	startOfYearMs,
	toDayKey,
	toYearKey,
} from '../../lib/calendar.js';
import { dayjs } from '../../lib/datetime.js';

const UTC = 'UTC';
const JST = 'Asia/Tokyo';
const NY = 'America/New_York';
/** DST 開始が 00:00 の tz（該当日は 00:00 が存在しない） */
const SAO = 'America/Sao_Paulo';
/** DST のオフセットが 30 分だけ動く tz */
const LHI = 'Australia/Lord_Howe';

/** 検証を読みやすくするため ms を UTC ISO に戻す */
const iso = (ms: number) => dayjs.utc(ms).toISOString();

// 2026-07-07 23:31 UTC = 2026-07-08 08:31 JST。UTC 暦日と JST 暦日が割れる時間帯。
const NOW = Date.UTC(2026, 6, 7, 23, 31, 0);

describe('calendar: 暦日プリミティブ', () => {
	describe('isSupportedTimeZone', () => {
		it.each([UTC, JST, NY, SAO, LHI, 'Etc/GMT+12'])('有効な IANA tz は true: %s', (tz) => {
			expect(isSupportedTimeZone(tz)).toBe(true);
		});

		it.each([
			['不正な IANA 名', 'Not/AZone'],
			['空文字', ''],
			['null', null],
			['undefined', undefined],
			['数値', 9],
		])('%s は false', (_label, value) => {
			expect(isSupportedTimeZone(value)).toBe(false);
		});
	});

	describe('startOfDayMs / endOfDayMs', () => {
		it('UTC はその UTC 暦日の 00:00:00.000 〜 23:59:59.999', () => {
			expect(iso(startOfDayMs(NOW, UTC))).toBe('2026-07-07T00:00:00.000Z');
			expect(iso(endOfDayMs(NOW, UTC))).toBe('2026-07-07T23:59:59.999Z');
		});

		it('JST は UTC より 9 時間手前で日が始まる（同じ瞬間でも暦日がずれる）', () => {
			expect(iso(startOfDayMs(NOW, JST))).toBe('2026-07-07T15:00:00.000Z');
			expect(iso(endOfDayMs(NOW, JST))).toBe('2026-07-08T14:59:59.999Z');
		});

		it('UTC より西の tz でも同様に暦日境界がずれる', () => {
			expect(iso(startOfDayMs(NOW, NY))).toBe('2026-07-07T04:00:00.000Z');
			expect(iso(endOfDayMs(NOW, NY))).toBe('2026-07-08T03:59:59.999Z');
		});

		it('暦日境界ちょうどは自分自身を返す（off-by-one）', () => {
			const boundary = Date.UTC(2026, 6, 8, 0, 0, 0);
			expect(startOfDayMs(boundary, UTC)).toBe(boundary);
			expect(startOfDayMs(boundary - 1, UTC)).toBe(Date.UTC(2026, 6, 7, 0, 0, 0));
			expect(endOfDayMs(boundary - 1, UTC)).toBe(boundary - 1);
		});

		it('終端 + 1ms は次の暦日の開始に一致する（隙間も重なりも無い）', () => {
			for (const tz of [UTC, JST, NY, SAO, LHI]) {
				const end = endOfDayMs(NOW, tz);
				expect(startOfDayMs(end + 1, tz)).toBe(end + 1);
			}
		});
	});

	describe('startOfDayMs / endOfDayMs: DST', () => {
		it('spring forward（23 時間の日）でも暦日全体を覆う', () => {
			// America/New_York 2026-03-08: 02:00 → 03:00
			const inDay = Date.UTC(2026, 2, 8, 12, 0, 0);
			expect(iso(startOfDayMs(inDay, NY))).toBe('2026-03-08T05:00:00.000Z');
			expect(iso(endOfDayMs(inDay, NY))).toBe('2026-03-09T03:59:59.999Z');
			expect(endOfDayMs(inDay, NY) - startOfDayMs(inDay, NY) + 1).toBe(23 * 3600_000);
		});

		it('fall back（25 時間の日）でも暦日全体を覆う', () => {
			// America/New_York 2026-11-01: 02:00 → 01:00
			const inDay = Date.UTC(2026, 10, 1, 12, 0, 0);
			expect(iso(startOfDayMs(inDay, NY))).toBe('2026-11-01T04:00:00.000Z');
			expect(iso(endOfDayMs(inDay, NY))).toBe('2026-11-02T04:59:59.999Z');
			expect(endOfDayMs(inDay, NY) - startOfDayMs(inDay, NY) + 1).toBe(25 * 3600_000);
		});

		it('00:00 が存在しない日（DST 開始が深夜）は実在する最初の瞬間を返す', () => {
			// America/Sao_Paulo 2017-10-15: 00:00 → 01:00
			const inDay = Date.UTC(2017, 9, 15, 12, 0, 0);
			expect(iso(startOfDayMs(inDay, SAO))).toBe('2017-10-15T03:00:00.000Z'); // = 01:00 -02:00
			expect(toDayKey(startOfDayMs(inDay, SAO), SAO)).toBe('20171015');
		});

		it('30 分だけずれる DST でも境界が保たれる', () => {
			const inDay = Date.UTC(2026, 3, 5, 5, 0, 0);
			expect(iso(startOfDayMs(inDay, LHI))).toBe('2026-04-04T13:30:00.000Z');
			expect(iso(endOfDayMs(inDay, LHI))).toBe('2026-04-05T13:29:59.999Z');
		});
	});

	describe('startOfYearMs / endOfYearMs', () => {
		it('UTC 暦年の境界', () => {
			expect(iso(startOfYearMs(NOW, UTC))).toBe('2026-01-01T00:00:00.000Z');
			expect(iso(endOfYearMs(NOW, UTC))).toBe('2026-12-31T23:59:59.999Z');
		});

		it('JST 暦年の境界（UTC より 9 時間手前）', () => {
			expect(iso(startOfYearMs(NOW, JST))).toBe('2025-12-31T15:00:00.000Z');
			expect(iso(endOfYearMs(NOW, JST))).toBe('2026-12-31T14:59:59.999Z');
		});

		it('年末ぎりぎりでも属する暦年が tz でずれる', () => {
			// UTC 2025-12-31 20:00 = JST 2026-01-01 05:00
			const yearEnd = Date.UTC(2025, 11, 31, 20, 0, 0);
			expect(iso(startOfYearMs(yearEnd, UTC))).toBe('2025-01-01T00:00:00.000Z');
			expect(iso(startOfYearMs(yearEnd, JST))).toBe('2025-12-31T15:00:00.000Z');
			expect(toYearKey(yearEnd, UTC)).toBe('2025');
			expect(toYearKey(yearEnd, JST)).toBe('2026');
		});
	});

	describe('toDayKey / toYearKey', () => {
		it('同じ瞬間でも tz ごとに暦日キーが変わる', () => {
			expect(toDayKey(NOW, UTC)).toBe('20260707');
			expect(toDayKey(NOW, JST)).toBe('20260708');
			expect(toDayKey(NOW, NY)).toBe('20260707');
		});

		it('閏日を跨ぐ瞬間', () => {
			// UTC 2024-02-29 00:00 は NY ではまだ 2/28
			const leap = Date.UTC(2024, 1, 29, 0, 0, 0);
			expect(toDayKey(leap, UTC)).toBe('20240229');
			expect(toDayKey(leap, JST)).toBe('20240229');
			expect(toDayKey(leap, NY)).toBe('20240228');
		});

		it('暦年キー', () => {
			expect(toYearKey(NOW, UTC)).toBe('2026');
		});
	});

	describe('isDayKeyFormat / isYearKeyFormat', () => {
		it.each(['20260707', '00000000', '20260230'])('YYYYMMDD 形式は true（実在日は見ない）: %s', (key) => {
			expect(isDayKeyFormat(key)).toBe(true);
		});

		it.each([
			['ハイフン区切り', '2026-07-07'],
			['空文字', ''],
			['桁不足', '2026070'],
			['桁過多', '202607071'],
			['数値', 20260707],
			['null', null],
			['undefined', undefined],
		])('%s は false', (_label, value) => {
			expect(isDayKeyFormat(value)).toBe(false);
		});

		it('YYYY 形式', () => {
			expect(isYearKeyFormat('2026')).toBe(true);
			expect(isYearKeyFormat('20260707')).toBe(false);
			expect(isYearKeyFormat('')).toBe(false);
			expect(isYearKeyFormat(2026)).toBe(false);
		});
	});

	describe('parseDayKey', () => {
		it('UTC 暦日の区間を返す', () => {
			expect(parseDayKey('20260707', UTC)).toEqual({
				startMs: Date.UTC(2026, 6, 7, 0, 0, 0),
				endMs: Date.UTC(2026, 6, 8, 0, 0, 0) - 1,
			});
		});

		it('JST 暦日の区間を返す（UTC より 9 時間手前）', () => {
			const span = parseDayKey('20260707', JST) as CalendarSpan;
			expect(iso(span.startMs)).toBe('2026-07-06T15:00:00.000Z');
			expect(iso(span.endMs)).toBe('2026-07-07T14:59:59.999Z');
		});

		it('DST で 23 時間になる日も正しい長さの区間を返す', () => {
			const span = parseDayKey('20260308', NY) as CalendarSpan;
			expect(span.endMs - span.startMs + 1).toBe(23 * 3600_000);
		});

		it('閏日は解釈できる', () => {
			const span = parseDayKey('20240229', UTC) as CalendarSpan;
			expect(iso(span.startMs)).toBe('2024-02-29T00:00:00.000Z');
			expect(iso(span.endMs)).toBe('2024-02-29T23:59:59.999Z');
		});

		it('平年の 2/29 は実在しないので null（黙って 3/1 に繰り上げない）', () => {
			expect(parseDayKey('20260229', UTC)).toBeNull();
		});

		it.each([
			['存在しない日', '20260230'],
			['存在しない月', '20261301'],
			['0 日', '20260700'],
			['ハイフン区切り', '2026-07-07'],
			['空文字', ''],
			['YYYY 形式', '2026'],
		])('%s は null', (_label, key) => {
			expect(parseDayKey(key, UTC)).toBeNull();
		});

		it('月末・年末も境界が正しい', () => {
			expect(iso((parseDayKey('20260131', UTC) as CalendarSpan).endMs)).toBe('2026-01-31T23:59:59.999Z');
			expect(iso((parseDayKey('20261231', JST) as CalendarSpan).endMs)).toBe('2026-12-31T14:59:59.999Z');
		});

		it('形式不正なら tz が不正でも throw せず null（キー検証が先）', () => {
			expect(parseDayKey('bad', 'Not/AZone')).toBeNull();
		});

		it('形式が正しく tz が不正なら throw', () => {
			expect(() => parseDayKey('20260707', 'Not/AZone')).toThrow(TypeError);
		});
	});

	describe('parseDayKeyAllowingOverflow', () => {
		it('実在する日付は parseDayKey と同じ区間を返す', () => {
			for (const tz of [UTC, JST, NY]) {
				expect(parseDayKeyAllowingOverflow('20260707', tz)).toEqual(parseDayKey('20260707', tz));
			}
		});

		it.each([
			['存在しない日 → 翌月へ繰り上げ', '20260230', '2026-03-02'],
			['平年の 2/29 → 3/1', '20260229', '2026-03-01'],
			['存在しない日付（月末超過）', '20260431', '2026-05-01'],
			['12/32 → 翌年 1/1', '20251232', '2026-01-01'],
			['13 月 → 翌年 1 月', '20261301', '2027-01-01'],
		])('%s', (_label, key, expectedDate) => {
			const span = parseDayKeyAllowingOverflow(key, UTC) as CalendarSpan;
			expect(dayjs.utc(span.startMs).format('YYYY-MM-DD')).toBe(expectedDate);
		});

		it('繰り上げ後の日付も tz 暦日として扱う（JST は UTC より 9 時間手前）', () => {
			const span = parseDayKeyAllowingOverflow('20260230', JST) as CalendarSpan;
			expect(iso(span.startMs)).toBe('2026-03-01T15:00:00.000Z');
			expect(iso(span.endMs)).toBe('2026-03-02T14:59:59.999Z');
		});

		it('閏年の 2/29 は繰り上げずそのまま', () => {
			const span = parseDayKeyAllowingOverflow('20240229', UTC) as CalendarSpan;
			expect(iso(span.startMs)).toBe('2024-02-29T00:00:00.000Z');
		});

		it.each([
			['ハイフン区切り', '2026-07-07'],
			['空文字', ''],
			['YYYY 形式', '2026'],
			['9 桁', '202607071'],
		])('形式不正 (%s) は繰り上げの対象外で null', (_label, key) => {
			expect(parseDayKeyAllowingOverflow(key, UTC)).toBeNull();
		});

		it('形式が正しく tz が不正なら throw', () => {
			expect(() => parseDayKeyAllowingOverflow('20260707', 'Not/AZone')).toThrow(TypeError);
		});
	});

	describe('diffCalendarDays', () => {
		const ms = (iso8601: string) => dayjs.utc(iso8601).valueOf();

		it('同じ暦日なら 0、翌日なら 1、前日なら -1', () => {
			expect(diffCalendarDays(ms('2026-07-07T00:00:00Z'), ms('2026-07-07T23:59:59Z'), UTC)).toBe(0);
			expect(diffCalendarDays(ms('2026-07-07T00:00:00Z'), ms('2026-07-08T00:00:00Z'), UTC)).toBe(1);
			expect(diffCalendarDays(ms('2026-07-08T00:00:00Z'), ms('2026-07-07T00:00:00Z'), UTC)).toBe(-1);
		});

		it('tz が変われば同じ 2 瞬間でも暦日差が変わる', () => {
			// 2026-07-07T15:30Z は UTC 暦日 7/7 / JST 暦日 7/8
			const a = ms('2026-07-07T02:00:00Z');
			const b = ms('2026-07-07T15:30:00Z');
			expect(diffCalendarDays(a, b, UTC)).toBe(0);
			expect(diffCalendarDays(a, b, JST)).toBe(1);
		});

		it('DST を跨いでも暦日数で数える（ms 差の割り算は 1 日ずれる）', () => {
			// NY 2025-01-01 00:00 EST → 2025-06-16 00:00 EDT。暦日で 166 日ぶん離れているが
			// 春の DST 開始で 1 時間短く、ms 差は 165 日 23 時間しかない。
			const from = ms('2025-01-01T05:00:00Z');
			const to = ms('2025-06-16T04:00:00Z');
			expect(diffCalendarDays(from, to, NY)).toBe(166);
			expect(Math.floor((to - from) / 86_400_000)).toBe(165);
		});

		it('DST 終了側（25 時間の日）を跨いでもずれない', () => {
			// NY 2025-11-02 が 25 時間。11/01 → 11/03 は暦日で 2 日。
			expect(diffCalendarDays(ms('2025-11-01T12:00:00Z'), ms('2025-11-03T12:00:00Z'), NY)).toBe(2);
		});

		it('閏日・年跨ぎを含む長い区間も暦日数で数える', () => {
			expect(diffCalendarDays(ms('2024-01-01T00:00:00Z'), ms('2025-01-01T00:00:00Z'), UTC)).toBe(366);
			expect(diffCalendarDays(ms('2025-01-01T00:00:00Z'), ms('2026-01-01T00:00:00Z'), UTC)).toBe(365);
		});

		it('30 分オフセットの DST tz でもずれない', () => {
			expect(diffCalendarDays(ms('2026-04-03T12:00:00Z'), ms('2026-04-06T12:00:00Z'), LHI)).toBe(3);
		});

		it('非有限 ms / 不正 tz は TypeError', () => {
			expect(() => diffCalendarDays(Number.NaN, 0, UTC)).toThrow(TypeError);
			expect(() => diffCalendarDays(0, Number.POSITIVE_INFINITY, UTC)).toThrow(TypeError);
			expect(() => diffCalendarDays(0, 0, 'Not/AZone')).toThrow(TypeError);
		});
	});

	describe('parseYearKey', () => {
		it('UTC / JST 暦年の区間を返す', () => {
			expect(parseYearKey('2026', UTC)).toEqual({
				startMs: Date.UTC(2026, 0, 1, 0, 0, 0),
				endMs: Date.UTC(2027, 0, 1, 0, 0, 0) - 1,
			});
			const jst = parseYearKey('2026', JST) as CalendarSpan;
			expect(iso(jst.startMs)).toBe('2025-12-31T15:00:00.000Z');
			expect(iso(jst.endMs)).toBe('2026-12-31T14:59:59.999Z');
		});

		it('閏年は 366 日分の区間になる', () => {
			const span = parseYearKey('2024', UTC) as CalendarSpan;
			expect(span.endMs - span.startMs + 1).toBe(366 * 86_400_000);
		});

		it.each([
			['YYYYMMDD 形式', '20260707'],
			['桁不足', '202'],
			['空文字', ''],
		])('%s は null', (_label, key) => {
			expect(parseYearKey(key, UTC)).toBeNull();
		});
	});

	describe('暦日キーの往復変換', () => {
		it.each([
			UTC,
			JST,
			NY,
			SAO,
			LHI,
			'Etc/GMT+12',
			'Pacific/Kiritimati',
		])('key → span → key が元に戻り、span が元の瞬間を含む: %s', (tz) => {
			const key = toDayKey(NOW, tz);
			const span = parseDayKey(key, tz) as CalendarSpan;
			expect(span).not.toBeNull();
			expect(span.startMs).toBeLessThanOrEqual(NOW);
			expect(span.endMs).toBeGreaterThanOrEqual(NOW);
			expect(toDayKey(span.startMs, tz)).toBe(key);
			expect(toDayKey(span.endMs, tz)).toBe(key);
		});

		it.each([
			'20240229',
			'20261231',
			'20260101',
			'20260308',
			'20261101',
		])('ms を経由しても暦日キーが変わらない: %s', (key) => {
			for (const tz of [UTC, JST, NY]) {
				const span = parseDayKey(key, tz) as CalendarSpan;
				expect(toDayKey(span.startMs, tz)).toBe(key);
				expect(toDayKey(span.endMs, tz)).toBe(key);
			}
		});

		it('暦年キーも往復する', () => {
			for (const tz of [UTC, JST, NY]) {
				const span = parseYearKey('2026', tz) as CalendarSpan;
				expect(toYearKey(span.startMs, tz)).toBe('2026');
				expect(toYearKey(span.endMs, tz)).toBe('2026');
			}
		});
	});

	describe('shiftDayKey', () => {
		it('翌日 / 前日', () => {
			expect(shiftDayKey('20260707', 1)).toBe('20260708');
			expect(shiftDayKey('20260707', -1)).toBe('20260706');
			expect(shiftDayKey('20260707', 0)).toBe('20260707');
		});

		it('月末・年末を跨ぐ', () => {
			expect(shiftDayKey('20260731', 1)).toBe('20260801');
			expect(shiftDayKey('20260801', -1)).toBe('20260731');
			expect(shiftDayKey('20261231', 1)).toBe('20270101');
			expect(shiftDayKey('20260101', -1)).toBe('20251231');
		});

		it('閏年の 2 月末', () => {
			expect(shiftDayKey('20240228', 1)).toBe('20240229');
			expect(shiftDayKey('20240229', 1)).toBe('20240301');
			expect(shiftDayKey('20260228', 1)).toBe('20260301');
			expect(shiftDayKey('20260301', -1)).toBe('20260228');
		});

		it('複数日のシフト', () => {
			expect(shiftDayKey('20260101', 365)).toBe('20270101');
			expect(shiftDayKey('20240101', 366)).toBe('20250101');
		});

		it.each([
			['形式不正', '2026-07-07', 1],
			['実在しない日', '20260230', 1],
			['非整数', '20260707', 1.5],
			['NaN', '20260707', Number.NaN],
		])('%s は null', (_label, key, days) => {
			expect(shiftDayKey(key as string, days as number)).toBeNull();
		});
	});

	describe('enumerateDayKeys', () => {
		it('同一暦日内に収まる区間は単一要素', () => {
			const start = Date.UTC(2026, 6, 7, 1, 0, 0);
			expect(enumerateDayKeys(start, start + 3600_000, UTC)).toEqual(['20260707']);
		});

		it('start === end でも単一要素', () => {
			expect(enumerateDayKeys(NOW, NOW, UTC)).toEqual(['20260707']);
		});

		it('start > end は空配列', () => {
			expect(enumerateDayKeys(NOW + 1, NOW, UTC)).toEqual([]);
		});

		it('複数日を昇順で列挙する（両端 inclusive）', () => {
			const start = Date.UTC(2026, 6, 4, 23, 59, 59);
			const end = Date.UTC(2026, 6, 7, 0, 0, 0);
			expect(enumerateDayKeys(start, end, UTC)).toEqual(['20260704', '20260705', '20260706', '20260707']);
		});

		it('tz を変えると同じ区間でも列挙されるキーが変わる', () => {
			const start = Date.UTC(2026, 6, 7, 14, 0, 0);
			const end = Date.UTC(2026, 6, 7, 16, 0, 0);
			expect(enumerateDayKeys(start, end, UTC)).toEqual(['20260707']);
			// JST では 23:00 → 翌 01:00 なので暦日を跨ぐ
			expect(enumerateDayKeys(start, end, JST)).toEqual(['20260707', '20260708']);
		});

		it('暦日境界ちょうどの区間は 2 日ぶん（off-by-one）', () => {
			const boundary = Date.UTC(2026, 6, 8, 0, 0, 0);
			expect(enumerateDayKeys(boundary - 1, boundary, UTC)).toEqual(['20260707', '20260708']);
			expect(enumerateDayKeys(boundary, boundary, UTC)).toEqual(['20260708']);
		});

		it('DST を跨いでも日が飛ばず重複もしない', () => {
			// America/New_York の spring forward（3/8）と fall back（11/1）を挟む
			const spring = enumerateDayKeys(Date.UTC(2026, 2, 7, 12, 0, 0), Date.UTC(2026, 2, 10, 12, 0, 0), NY);
			expect(spring).toEqual(['20260307', '20260308', '20260309', '20260310']);
			const fall = enumerateDayKeys(Date.UTC(2026, 9, 31, 12, 0, 0), Date.UTC(2026, 11, 3, 12, 0, 0), NY);
			expect(fall.length).toBe(new Set(fall).size);
			expect(fall[0]).toBe('20261031');
			expect(fall.at(-1)).toBe('20261203');
			expect(fall.length).toBe(34); // 10/31 + 11月 30 日 + 12/1〜12/3
		});

		it('月末・年末・閏日を跨いで連続する', () => {
			const yearEnd = enumerateDayKeys(Date.UTC(2026, 11, 30, 0, 0, 0), Date.UTC(2027, 0, 2, 0, 0, 0), UTC);
			expect(yearEnd).toEqual(['20261230', '20261231', '20270101', '20270102']);

			const leap = enumerateDayKeys(Date.UTC(2024, 1, 28, 0, 0, 0), Date.UTC(2024, 2, 1, 0, 0, 0), UTC);
			expect(leap).toEqual(['20240228', '20240229', '20240301']);

			const nonLeap = enumerateDayKeys(Date.UTC(2026, 1, 28, 0, 0, 0), Date.UTC(2026, 2, 1, 0, 0, 0), UTC);
			expect(nonLeap).toEqual(['20260228', '20260301']);
		});
	});

	describe('enumerateYearKeys', () => {
		it('同一年内は単一要素', () => {
			expect(enumerateYearKeys(Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31), UTC)).toEqual(['2026']);
		});

		it('start > end は空配列', () => {
			expect(enumerateYearKeys(NOW + 1, NOW, UTC)).toEqual([]);
		});

		it('複数年を昇順で列挙する', () => {
			expect(enumerateYearKeys(Date.UTC(2024, 5, 1), Date.UTC(2026, 5, 1), UTC)).toEqual(['2024', '2025', '2026']);
		});

		it('年境界ちょうど（off-by-one）', () => {
			const boundary = Date.UTC(2026, 0, 1, 0, 0, 0);
			expect(enumerateYearKeys(boundary - 1, boundary, UTC)).toEqual(['2025', '2026']);
			expect(enumerateYearKeys(boundary, boundary, UTC)).toEqual(['2026']);
		});

		it('tz によって交差する暦年が変わる', () => {
			// UTC 2025-12-31 20:00 は JST では既に 2026 年
			const t = Date.UTC(2025, 11, 31, 20, 0, 0);
			expect(enumerateYearKeys(t, t, UTC)).toEqual(['2025']);
			expect(enumerateYearKeys(t, t, JST)).toEqual(['2026']);
		});
	});

	describe('isDayKeyCompleted', () => {
		it('nowMs が属する暦日より前なら完了済み', () => {
			expect(isDayKeyCompleted('20260706', NOW, UTC)).toBe(true);
		});

		it('進行中の暦日は未完了', () => {
			expect(isDayKeyCompleted('20260707', NOW, UTC)).toBe(false);
		});

		it('未来の暦日は未完了', () => {
			expect(isDayKeyCompleted('20260708', NOW, UTC)).toBe(false);
		});

		it('tz によって「進行中の暦日」が変わる', () => {
			// NOW は UTC 7/7 23:31 = JST 7/8 08:31
			expect(isDayKeyCompleted('20260707', NOW, UTC)).toBe(false);
			expect(isDayKeyCompleted('20260707', NOW, JST)).toBe(true);
		});

		it('暦日切り替わりの前後 1ms（off-by-one）', () => {
			const boundary = Date.UTC(2026, 6, 8, 0, 0, 0);
			expect(isDayKeyCompleted('20260707', boundary - 1, UTC)).toBe(false);
			expect(isDayKeyCompleted('20260707', boundary, UTC)).toBe(true);
		});

		it.each([
			['ハイフン区切り', '2026-07-06'],
			['空文字', ''],
			['YYYY 形式', '2026'],
		])('形式不正は false: %s', (_label, key) => {
			expect(isDayKeyCompleted(key, NOW, UTC)).toBe(false);
		});
	});

	describe('recentCompletedDayKeys', () => {
		it('進行中の暦日を含めず新しい順に返す', () => {
			expect(recentCompletedDayKeys(3, NOW, UTC)).toEqual(['20260706', '20260705', '20260704']);
		});

		it('tz が変われば起点も変わる', () => {
			// JST では NOW は 7/8 なので直近の完了済みは 7/7
			expect(recentCompletedDayKeys(2, NOW, JST)).toEqual(['20260707', '20260706']);
		});

		it('count = 0 / 負数 / NaN は空配列', () => {
			expect(recentCompletedDayKeys(0, NOW, UTC)).toEqual([]);
			expect(recentCompletedDayKeys(-3, NOW, UTC)).toEqual([]);
			expect(recentCompletedDayKeys(Number.NaN, NOW, UTC)).toEqual([]);
		});

		it('count = 1 は単一要素', () => {
			expect(recentCompletedDayKeys(1, NOW, UTC)).toEqual(['20260706']);
		});

		it('小数の count は切り捨てる', () => {
			expect(recentCompletedDayKeys(2.9, NOW, UTC)).toEqual(['20260706', '20260705']);
		});

		it('月初・年初・閏日を跨いで遡る', () => {
			expect(recentCompletedDayKeys(2, Date.UTC(2026, 7, 1, 12, 0, 0), UTC)).toEqual(['20260731', '20260730']);
			expect(recentCompletedDayKeys(2, Date.UTC(2026, 0, 1, 12, 0, 0), UTC)).toEqual(['20251231', '20251230']);
			expect(recentCompletedDayKeys(2, Date.UTC(2024, 2, 1, 12, 0, 0), UTC)).toEqual(['20240229', '20240228']);
		});

		it('返るキーはすべて完了済み判定を満たす', () => {
			for (const key of recentCompletedDayKeys(5, NOW, UTC)) {
				expect(isDayKeyCompleted(key, NOW, UTC)).toBe(true);
			}
		});
	});

	describe('不正な入力は TypeError で落ちる（黙って NaN を返さない）', () => {
		it.each([
			['startOfDayMs', () => startOfDayMs(Number.NaN, UTC)],
			['endOfDayMs', () => endOfDayMs(Number.POSITIVE_INFINITY, UTC)],
			['startOfYearMs', () => startOfYearMs(Number.NaN, UTC)],
			['endOfYearMs', () => endOfYearMs(Number.NaN, UTC)],
			['toDayKey', () => toDayKey(Number.NaN, UTC)],
			['toYearKey', () => toYearKey(Number.NaN, UTC)],
			['enumerateDayKeys(start)', () => enumerateDayKeys(Number.NaN, NOW, UTC)],
			['enumerateDayKeys(end)', () => enumerateDayKeys(NOW, Number.NaN, UTC)],
			['enumerateYearKeys', () => enumerateYearKeys(Number.NaN, NOW, UTC)],
		])('%s は非有限 ms で throw', (_label, fn) => {
			expect(fn).toThrow(TypeError);
		});

		it.each([
			['startOfDayMs', () => startOfDayMs(NOW, 'Not/AZone')],
			['toDayKey', () => toDayKey(NOW, '')],
			['enumerateDayKeys', () => enumerateDayKeys(NOW, NOW, 'Not/AZone')],
			['enumerateYearKeys', () => enumerateYearKeys(NOW, NOW, 'Not/AZone')],
			['isDayKeyCompleted', () => isDayKeyCompleted('20260706', NOW, 'Not/AZone')],
			['recentCompletedDayKeys', () => recentCompletedDayKeys(1, NOW, 'Not/AZone')],
		])('%s は不正 tz で throw', (_label, fn) => {
			expect(fn).toThrow(TypeError);
		});
	});
});
