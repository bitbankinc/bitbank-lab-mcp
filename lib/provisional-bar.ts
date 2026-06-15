/**
 * 「最新足が形成中（未確定）」であることを content / summary に明示するためのユーティリティ。
 *
 * get_candles は realtime 取得（date 未指定）時、最新要素として現在形成中の足を含む
 * （tools/get_candles.ts の slice(-limit) は形成中足を trim しない）。
 * analyze_indicators / get_volatility_metrics はこの最新足をそのまま最新指標化するため、
 * 短い足ほど終値・RSI・ATR が暫定値で揺れる。LLM がこれを確定値と誤認しないよう注記を出す。
 *
 * この注記は meta.warning（取得層）/ meta.warnings（計算層）の 2 系統とは別物の情報注記。
 * 区別のため ⚠️ ではなく ℹ️ プレフィックスを用い、prepend は warning-propagation と同じ流儀に揃える。
 */

import { dayjs } from './datetime.js';

/** content / summary 先頭に付与する「形成中足」注記。 */
export const PROVISIONAL_BAR_NOTE =
	'ℹ️ 最新足は未確定（形成中）です。終値・RSI・ATR 等の最新値は足が確定するまで変動する可能性があります。';

/**
 * 固定間隔（ミリ秒）。1week は常に 7 日で規則的。
 * 1month のみ暦依存で不規則なので isLatestBarProvisional 内で個別計算する。
 */
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

/**
 * 最新足が形成中（未確定）かを判定する。
 *
 * 「バー開始 ts + そのインターバル」= 期間終端がまだ到来していなければ形成中（true）。
 * realtime 取得では最新足は常に形成中になるが、ts 起点で厳密判定することで、
 * 確定済みの足を渡した場合（過去日 anchor 等）には false を返せる。
 */
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
	/**
	 * 注記行と本文の間のセパレータ。
	 * - '\n\n'（デフォルト）: 空行を挟む（handler content 系）。
	 * - '\n': 1 行で詰める（ツール本体の summary 系）。
	 */
	separator?: '\n' | '\n\n';
};

/**
 * provisional が true のとき body の前に PROVISIONAL_BAR_NOTE を別行で連結する。
 * false ならそのまま返す。warning 2 系統の prependWarnings と同じ流儀。
 */
export function prependProvisionalNote(
	body: string,
	provisional: boolean,
	options: PrependProvisionalNoteOptions = {},
): string {
	if (!provisional) return body;
	const separator = options.separator ?? '\n\n';
	return `${PROVISIONAL_BAR_NOTE}${separator}${body}`;
}
