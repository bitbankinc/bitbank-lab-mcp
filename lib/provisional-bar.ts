// meta.warning / meta.warnings の 2 系統とは別の情報注記なので、⚠️ ではなく ℹ️ を使う。

import { dayjs } from './datetime.js';

export const PROVISIONAL_BAR_NOTE =
	'ℹ️ 最新足は未確定（形成中）です。終値・RSI・ATR 等の最新値は足が確定するまで変動する可能性があります。';

// 1month だけは暦依存で不規則なので isLatestBarProvisional 内で個別に計算する。
const FIXED_INTERVAL_MS: Record<string, number> = {
	'1min': 60_000,
	'5min': 300_000,
	'15min': 900_000,
	'30min': 1_800_000,
	'1hour': 3_600_000,
	'4hour': 14_400_000,
	'8hour': 28_800_000,
	'12hour': 43_200_000,
	'1day': 86_400_000,
	'1week': 604_800_000,
};

// realtime では最新足は常に形成中だが、ts 起点で判定して確定済みの足（過去日 anchor 等）には false を返す。
export function isLatestBarProvisional(
	latestTimestampMs: number | null | undefined,
	type: string,
	now: number = Date.now(),
): boolean {
	if (latestTimestampMs == null || !Number.isFinite(latestTimestampMs)) return false;
	const fixed = FIXED_INTERVAL_MS[type];
	if (fixed != null) return latestTimestampMs + fixed > now;
	if (type === '1month') return dayjs.utc(latestTimestampMs).add(1, 'month').valueOf() > now;
	// 未知の type は判定不能。確定/未確定を断定せず形成中扱いしない。
	return false;
}

export type PrependProvisionalNoteOptions = {
	separator?: '\n' | '\n\n';
};

export function prependProvisionalNote(
	body: string,
	provisional: boolean,
	options: PrependProvisionalNoteOptions = {},
): string {
	if (!provisional) return body;
	const separator = options.separator ?? '\n\n';
	return `${PROVISIONAL_BAR_NOTE}${separator}${body}`;
}
