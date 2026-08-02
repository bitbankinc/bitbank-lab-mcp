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
 * nowMs が属する UTC 暦日の開始時刻（ms）。この時刻以降はアーカイブ未公開区間で、
 * /transactions (latest, 直近約60件) でしか取得できない。
 *
 * 取得区間が進行中の UTC 日にかかるか（= latest 補完が必要か）の判定に使う。
 */
export function currentUtcDayStartMs(nowMs: number = Date.now()): number {
	return dayjs.utc(nowMs).startOf('day').valueOf();
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
 * [sinceMs, untilMs] と交差する完了済み UTC 暦日キーを昇順で返す。
 * 進行中の UTC 日は除外する（アーカイブ未公開のため要求しても 404）。
 * その区間のデータが必要な場合は /transactions (latest) で補完し、
 * カバレッジ不足を warning で明示すること。
 *
 * @param untilMs 取得区間の終端。**現在時刻とは限らない**（過去区間の指定では終端も過去）。
 * @param nowMs   「進行中の UTC 日」の判定に使う現在時刻。既定は `untilMs`（終端＝現在という
 *   従来の呼び出しと同じ挙動）。過去区間を要求する場合は `untilMs` の UTC 日が既に完了して
 *   いるため、実時刻を明示的に渡すこと。渡さないと完了済みの日を進行中と誤判定して
 *   アーカイブを列挙せず、取得できるはずのデータを取りこぼす。
 */
export function completedUtcDayKeysInRange(
	sinceMs: number,
	untilMs: number = Date.now(),
	nowMs: number = untilMs,
): string[] {
	if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs > untilMs) return [];
	const current = currentUtcDayKey(nowMs);
	const keys: string[] = [];
	let d = dayjs.utc(sinceMs).startOf('day');
	const end = dayjs.utc(untilMs).startOf('day');
	while (d.valueOf() <= end.valueOf()) {
		const key = d.format('YYYYMMDD');
		if (key < current) keys.push(key);
		d = d.add(1, 'day');
	}
	return keys;
}
