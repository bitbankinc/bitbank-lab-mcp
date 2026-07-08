/**
 * /transactions/{YYYYMMDD} 日付アーカイブの日付キーユーティリティ。
 *
 * bitbank Public API の日付アーカイブは **UTC 暦日** でグルーピングされ、
 * 当該 UTC 日が完了するまで 404 を返す（進行中の UTC 日のデータは
 * /transactions (latest, 直近約60件) でのみ取得可能）。
 * 実測ログ: docs/internal/bitbank-tx-archive-tz.md
 *
 * JST 基準で「今日 / 昨日」を組むと、JST 早朝（00:00〜09:00 = UTC 日付更新前）には
 * 進行中の UTC 日を要求してしまい必ず 404 になる。日付キーは必ず本モジュールの
 * 「完了済み UTC 暦日」ベースで導出すること。
 */

import { dayjs } from './datetime.js';

/** nowMs が属する UTC 暦日キー (YYYYMMDD)。この日のアーカイブは未公開（404）。 */
export function currentUtcDayKey(nowMs: number = Date.now()): string {
	return dayjs.utc(nowMs).format('YYYYMMDD');
}

/**
 * dateKey のアーカイブが公開済みと期待できるか（= その UTC 暦日が完了しているか）。
 * 進行中・未来の UTC 日は false。形式不正（YYYYMMDD 以外）も false。
 */
export function isArchiveExpectedPublished(dateKey: string, nowMs: number = Date.now()): boolean {
	return /^\d{8}$/.test(dateKey) && dateKey < currentUtcDayKey(nowMs);
}

/**
 * 直近 count 個の完了済み UTC 暦日キーを新しい順で返す。
 * 進行中の UTC 日（= currentUtcDayKey）は含めない。
 */
export function recentCompletedUtcDayKeys(count: number, nowMs: number = Date.now()): string[] {
	const utcNow = dayjs.utc(nowMs);
	return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, i) =>
		utcNow.subtract(i + 1, 'day').format('YYYYMMDD'),
	);
}

/**
 * [sinceMs, nowMs] と交差する完了済み UTC 暦日キーを昇順で返す。
 * 進行中の UTC 日は除外する（アーカイブ未公開のため要求しても 404）。
 * その区間のデータが必要な場合は /transactions (latest) で補完し、
 * カバレッジ不足を warning で明示すること。
 */
export function completedUtcDayKeysInRange(sinceMs: number, nowMs: number = Date.now()): string[] {
	if (!Number.isFinite(sinceMs) || !Number.isFinite(nowMs) || sinceMs > nowMs) return [];
	const current = currentUtcDayKey(nowMs);
	const keys: string[] = [];
	let d = dayjs.utc(sinceMs).startOf('day');
	const end = dayjs.utc(nowMs).startOf('day');
	while (d.valueOf() <= end.valueOf()) {
		const key = d.format('YYYYMMDD');
		if (key < current) keys.push(key);
		d = d.add(1, 'day');
	}
	return keys;
}
