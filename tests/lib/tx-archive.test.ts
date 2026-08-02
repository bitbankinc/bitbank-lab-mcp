import { describe, expect, it } from 'vitest';
import {
	completedUtcDayKeysInRange,
	currentUtcDayKey,
	currentUtcDayStartMs,
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

		it('nowMs 明示時: 終端が過去なら終端の UTC 日も完了済みとして列挙する', () => {
			// [7/5 00:00, 7/5 23:59:59.999] を 7/7 23:31 時点で要求 → 20260705 は公開済み
			const sinceMs = Date.UTC(2026, 6, 5, 0, 0, 0);
			const untilMs = Date.UTC(2026, 6, 6, 0, 0, 0) - 1;
			expect(completedUtcDayKeysInRange(sinceMs, untilMs, NOW)).toEqual(['20260705']);
		});

		it('nowMs 省略時は untilMs を現在時刻とみなす（従来の呼び出しと同じ挙動）', () => {
			// 第3引数が無ければ untilMs の UTC 日 = 進行中扱いになり列挙されない
			const sinceMs = Date.UTC(2026, 6, 5, 0, 0, 0);
			const untilMs = Date.UTC(2026, 6, 5, 12, 0, 0);
			expect(completedUtcDayKeysInRange(sinceMs, untilMs)).toEqual([]);
			expect(completedUtcDayKeysInRange(sinceMs, untilMs, NOW)).toEqual(['20260705']);
		});

		it('nowMs 明示時: 進行中の UTC 日は終端に含まれても除外する', () => {
			const sinceMs = Date.UTC(2026, 6, 6, 0, 0, 0);
			expect(completedUtcDayKeysInRange(sinceMs, NOW, NOW)).toEqual(['20260706']);
		});
	});

	describe('currentUtcDayStartMs', () => {
		it('その UTC 暦日の 00:00:00.000 を返す', () => {
			expect(currentUtcDayStartMs(NOW)).toBe(Date.UTC(2026, 6, 7, 0, 0, 0));
		});

		it('UTC 日の境界ちょうどは自分自身を返す（off-by-one）', () => {
			const boundary = Date.UTC(2026, 6, 8, 0, 0, 0);
			expect(currentUtcDayStartMs(boundary)).toBe(boundary);
			expect(currentUtcDayStartMs(boundary - 1)).toBe(Date.UTC(2026, 6, 7, 0, 0, 0));
		});
	});
});
