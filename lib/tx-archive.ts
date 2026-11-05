// アーカイブは UTC 暦日単位で、その UTC 日が完了するまで 404 を返す。JST 基準で今日 / 昨日を組まず、日付キーは必ず完了済み UTC 暦日から導く。

import { enumerateDayKeys, isDayKeyCompleted, recentCompletedDayKeys, startOfDayMs, toDayKey } from './calendar.js';

const ARCHIVE_TZ = 'UTC';

export function currentUtcDayKey(nowMs: number = Date.now()): string {
	return toDayKey(nowMs, ARCHIVE_TZ);
}

export function currentUtcDayStartMs(nowMs: number = Date.now()): number {
	return startOfDayMs(nowMs, ARCHIVE_TZ);
}

export function isArchiveExpectedPublished(dateKey: string, nowMs: number = Date.now()): boolean {
	return isDayKeyCompleted(dateKey, nowMs, ARCHIVE_TZ);
}

export function recentCompletedUtcDayKeys(count: number, nowMs: number = Date.now()): string[] {
	return recentCompletedDayKeys(count, nowMs, ARCHIVE_TZ);
}

// nowMs は進行中の UTC 日の判定に使う。過去区間では untilMs の UTC 日は完了済みなので実時刻を渡す（渡さないと取得できるはずの日を取りこぼす）。
export function completedUtcDayKeysInRange(
	sinceMs: number,
	untilMs: number = Date.now(),
	nowMs: number = untilMs,
): string[] {
	if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs > untilMs) return [];
	return enumerateDayKeys(sinceMs, untilMs, ARCHIVE_TZ).filter((key) => isDayKeyCompleted(key, nowMs, ARCHIVE_TZ));
}
