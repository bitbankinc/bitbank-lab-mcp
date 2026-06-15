import { describe, expect, it } from 'vitest';
import { isLatestBarProvisional, PROVISIONAL_BAR_NOTE, prependProvisionalNote } from '../lib/provisional-bar.js';

describe('isLatestBarProvisional', () => {
	const now = Date.UTC(2026, 5, 15, 11, 30, 0); // 2026-06-15 11:30 UTC（足の境界をまたがない時刻）

	it('期間がまだ閉じていない最新足は形成中（true）', () => {
		// 1day: 当日 00:00 開始の足は 24h 後（翌日 00:00）まで形成中
		const todayStart = Date.UTC(2026, 5, 15, 0, 0, 0);
		expect(isLatestBarProvisional(todayStart, '1day', now)).toBe(true);
		// 1hour: 直近 1 時間の足
		const hourStart = Date.UTC(2026, 5, 15, 11, 0, 0);
		expect(isLatestBarProvisional(hourStart, '1hour', now)).toBe(true);
	});

	it('期間が既に閉じた確定足は形成中でない（false）', () => {
		const yesterdayStart = Date.UTC(2026, 5, 13, 0, 0, 0);
		expect(isLatestBarProvisional(yesterdayStart, '1day', now)).toBe(false);
		const prevHour = Date.UTC(2026, 5, 15, 9, 0, 0); // 09:00 の足は 10:00 に確定
		expect(isLatestBarProvisional(prevHour, '1hour', now)).toBe(false);
	});

	it('1week は 7 日間隔で判定する', () => {
		const thisWeekStart = Date.UTC(2026, 5, 15, 0, 0, 0);
		expect(isLatestBarProvisional(thisWeekStart, '1week', now)).toBe(true);
		const lastWeekStart = Date.UTC(2026, 5, 1, 0, 0, 0); // 14 日前 → 確定
		expect(isLatestBarProvisional(lastWeekStart, '1week', now)).toBe(false);
	});

	it('1month は暦月の終端で判定する', () => {
		const thisMonthStart = Date.UTC(2026, 5, 1, 0, 0, 0); // 6/1 → 7/1 まで形成中
		expect(isLatestBarProvisional(thisMonthStart, '1month', now)).toBe(true);
		const lastMonthStart = Date.UTC(2026, 4, 1, 0, 0, 0); // 5/1 → 6/1 に確定済
		expect(isLatestBarProvisional(lastMonthStart, '1month', now)).toBe(false);
	});

	it('null / undefined / NaN は false', () => {
		expect(isLatestBarProvisional(null, '1day', now)).toBe(false);
		expect(isLatestBarProvisional(undefined, '1day', now)).toBe(false);
		expect(isLatestBarProvisional(Number.NaN, '1day', now)).toBe(false);
	});

	it('未知の type は false（断定しない）', () => {
		const todayStart = Date.UTC(2026, 5, 15, 0, 0, 0);
		expect(isLatestBarProvisional(todayStart, 'unknown_type', now)).toBe(false);
	});
});

describe('prependProvisionalNote', () => {
	it('provisional=true で注記を別行で前置する', () => {
		const out = prependProvisionalNote('本文', true);
		expect(out.startsWith(PROVISIONAL_BAR_NOTE)).toBe(true);
		expect(out).toContain('本文');
		expect(out).toBe(`${PROVISIONAL_BAR_NOTE}\n\n本文`);
	});

	it('separator を指定できる', () => {
		expect(prependProvisionalNote('本文', true, { separator: '\n' })).toBe(`${PROVISIONAL_BAR_NOTE}\n本文`);
	});

	it('provisional=false で本文をそのまま返す', () => {
		expect(prependProvisionalNote('本文', false)).toBe('本文');
	});

	it('注記は ℹ️ プレフィックス（⚠️ ではない）で warning と区別する', () => {
		expect(PROVISIONAL_BAR_NOTE.startsWith('ℹ️')).toBe(true);
		expect(PROVISIONAL_BAR_NOTE.startsWith('⚠️')).toBe(false);
	});
});
