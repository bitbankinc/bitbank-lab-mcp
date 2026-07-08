import { describe, expect, it } from 'vitest';
import {
	completedUtcDayKeysInRange,
	currentUtcDayKey,
	isArchiveExpectedPublished,
	recentCompletedUtcDayKeys,
} from '../../lib/tx-archive.js';

// 基準時刻: 2026-07-07 23:31 UTC = 2026-07-08 08:31 JST（障害観測時刻）
// 進行中の UTC 日 = 20260707（JST では既に「昨日」の日付）
const NOW = Date.UTC(2026, 6, 7, 23, 31, 0);

describe('tx-archive: UTC 暦日アーカイブの日付キー導出', () => {
	describe('currentUtcDayKey', () => {
		it('JST 早朝（UTC 日付更新前）は JST の「昨日」にあたる UTC 日を返す', () => {
			expect(currentUtcDayKey(NOW)).toBe('20260707');
		});

		it('UTC 日付更新直後は新しい UTC 日を返す', () => {
			expect(currentUtcDayKey(Date.UTC(2026, 6, 8, 0, 0, 1))).toBe('20260708');
		});
	});

	describe('isArchiveExpectedPublished', () => {
		it('完了済み UTC 日は公開済み扱い', () => {
			expect(isArchiveExpectedPublished('20260706', NOW)).toBe(true);
		});

		it('進行中の UTC 日は未公開扱い（JST では「昨日」でも）', () => {
			expect(isArchiveExpectedPublished('20260707', NOW)).toBe(false);
		});

		it('未来の UTC 日は未公開扱い', () => {
			expect(isArchiveExpectedPublished('20260708', NOW)).toBe(false);
		});

		it('YYYYMMDD 形式でない値は false', () => {
			expect(isArchiveExpectedPublished('2026-07-06', NOW)).toBe(false);
			expect(isArchiveExpectedPublished('', NOW)).toBe(false);
		});
	});

	describe('recentCompletedUtcDayKeys', () => {
		it('進行中の UTC 日を含めず、直近の完了済み UTC 日から新しい順に返す', () => {
			expect(recentCompletedUtcDayKeys(2, NOW)).toEqual(['20260706', '20260705']);
		});

		it('count=0 は空配列', () => {
			expect(recentCompletedUtcDayKeys(0, NOW)).toEqual([]);
		});

		it('月跨ぎでも UTC 暦日で正しく遡る', () => {
			expect(recentCompletedUtcDayKeys(2, Date.UTC(2026, 7, 1, 12, 0, 0))).toEqual(['20260731', '20260730']);
		});
	});

	describe('completedUtcDayKeysInRange', () => {
		it('進行中の UTC 日を除外し、交差する完了済み UTC 日を昇順で返す', () => {
			// [7/6 22:31 UTC, 7/7 23:31 UTC] → UTC 日 20260706, 20260707 と交差するが 20260707 は進行中
			const sinceMs = NOW - 25 * 3600_000;
			expect(completedUtcDayKeysInRange(sinceMs, NOW)).toEqual(['20260706']);
		});

		it('時間窓が進行中の UTC 日内に収まる場合は空配列', () => {
			const now = Date.UTC(2026, 6, 7, 12, 0, 0);
			expect(completedUtcDayKeysInRange(now - 3600_000, now)).toEqual([]);
		});

		it('複数日にまたがる窓は全ての完了済み UTC 日を列挙する', () => {
			const now = Date.UTC(2026, 6, 7, 23, 31, 0);
			const sinceMs = now - 72 * 3600_000;
			expect(completedUtcDayKeysInRange(sinceMs, now)).toEqual(['20260704', '20260705', '20260706']);
		});

		it('since > now は空配列（防御）', () => {
			expect(completedUtcDayKeysInRange(NOW + 1000, NOW)).toEqual([]);
		});
	});
});
