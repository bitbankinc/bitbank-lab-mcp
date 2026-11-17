import { toIsoMs } from '../../lib/datetime.js';
import { normalizePairCodes } from '../../lib/pair-code.js';
import type { BitbankPrivateClient } from './client.js';

const TRADE_HISTORY_PAGE_SIZE = 1000;
const MAX_PAGES = 10;

interface TradeRow {
	trade_id: number;
	pair: string;
	executed_at: number;
}

export interface FilteredTradeHistory<T> {
	trades: T[];
	isComplete: boolean;
	scanned: number;
	excluded: number;
	// 件数に届かずページの上限などで打ち切ったときだけ入る。続きを取るときの end（desc）/ since（asc）。
	scanBoundaryMs: number | null;
	stopReason: 'page_limit' | 'stalled' | 'no_timestamp' | null;
}

// 約定履歴 API は現物と信用を混ぜて返し、分けるパラメータが無いので、絞った後の件数が limit に届くまで取り直す（#455）。
export async function fetchFilteredTradeHistory<T extends TradeRow>(
	client: BitbankPrivateClient,
	options: {
		baseParams: Record<string, string>;
		order: 'asc' | 'desc';
		limit: number;
		keep: (trade: T) => boolean;
	},
): Promise<FilteredTradeHistory<T>> {
	const { baseParams, order, limit, keep } = options;
	const kept: T[] = [];
	const seenIds = new Set<number>();
	let excluded = 0;
	const cursorKey: 'since' | 'end' = order === 'desc' ? 'end' : 'since';
	let cursor: string | undefined = baseParams[cursorKey];
	let lastScannedTs: number | undefined;
	let stopReason: FilteredTradeHistory<T>['stopReason'] = 'page_limit';

	for (let page = 0; page < MAX_PAGES; page++) {
		// 1 ページ目は要求件数だけ取る。混在で足りなかったときだけ、続きを上限件数でまとめて取る。
		const pageSize = page === 0 ? Math.min(limit, TRADE_HISTORY_PAGE_SIZE) : TRADE_HISTORY_PAGE_SIZE;
		const params: Record<string, string> = {
			...baseParams,
			count: String(pageSize),
			order,
			...(cursor ? { [cursorKey]: cursor } : {}),
		};
		const raw = await client.get<{ trades: T[] }>('/v1/user/spot/trade_history', params);
		const batch = normalizePairCodes(raw.trades ?? []);
		for (const t of batch) {
			if (seenIds.has(t.trade_id)) continue;
			seenIds.add(t.trade_id);
			if (keep(t)) kept.push(t);
			else excluded++;
		}

		// 終了判定は絞る前の件数で行う。絞った後の件数では、反対側の約定が多いページで続きがあるのに打ち切る。
		const exhausted = batch.length < pageSize;
		if (exhausted || kept.length >= limit) {
			return {
				trades: kept.slice(0, limit),
				isComplete: exhausted && kept.length <= limit,
				scanned: seenIds.size,
				excluded,
				scanBoundaryMs: null,
				stopReason: null,
			};
		}

		// 同じ時刻の行は次ページで取り直し、trade_id で重複を除く。
		const lastTs = batch[batch.length - 1]?.executed_at;
		if (!lastTs) {
			stopReason = 'no_timestamp';
			break;
		}
		lastScannedTs = lastTs;
		const nextCursor = String(lastTs);
		if (nextCursor === cursor) {
			stopReason = 'stalled';
			break;
		}
		cursor = nextCursor;
	}

	return {
		trades: kept.slice(0, limit),
		isComplete: false,
		scanned: seenIds.size,
		excluded,
		scanBoundaryMs: lastScannedTs ?? null,
		stopReason,
	};
}

const STOP_REASON_TEXT: Record<NonNullable<FilteredTradeHistory<unknown>['stopReason']>, string> = {
	page_limit: `取得するページ数の上限（${MAX_PAGES} ページ）まで調べて打ち切りました`,
	stalled: '同じ時刻の約定が 1 ページ分を超えて並び、先へ進めずに打ち切りました',
	no_timestamp: '約定時刻の無い行があり、先へ進めずに打ち切りました',
};

// stalled のときの境界は送り済みのカーソルと同じで、渡しても同じページが返るだけなので出さない。
export function scanBoundaryIso(result: FilteredTradeHistory<unknown>): string | undefined {
	if (result.isComplete || result.stopReason === 'stalled') return undefined;
	return toIsoMs(result.scanBoundaryMs) ?? undefined;
}

const INCOMPLETE_PREFIX = '※ 全件ではなく一部のみ取得されています。';

const TRADE_DISPLAY_LIMIT = 100;

// asc でも新しい側を出す。続きの案内が「表示した中で最も古い約定より前」の 1 通りで済む。
export function tradesToDisplay<T>(trades: T[], order: 'asc' | 'desc'): T[] {
	return order === 'asc' ? trades.slice(-TRADE_DISPLAY_LIMIT) : trades.slice(0, TRADE_DISPLAY_LIMIT);
}

export function hiddenTradesNote(
	total: number,
	shown: Array<{ executed_at: string }>,
	order: 'asc' | 'desc',
): string | null {
	const hidden = total - shown.length;
	if (hidden <= 0) return null;
	const oldestShown = (order === 'asc' ? shown[0] : shown[shown.length - 1])?.executed_at;
	const next =
		oldestShown != null
			? `残りの ${hidden}件は ${oldestShown} 以前の約定です。明細が必要なら end に ${oldestShown} を指定して取得してください。境界の時刻は含まれるので trade_id で重複を除いてください`
			: '明細が必要なら since / end で期間を絞って取得してください';
	return `... 他 ${hidden}件（本文の明細は新しいほうから ${TRADE_DISPLAY_LIMIT}件まで。${next}）`;
}

// 止めた理由（指定した件数に届いた / ページの上限などで打ち切った）を書き分け、LLM が続きを取れる時刻を出す。
export function completenessNote(
	result: FilteredTradeHistory<TradeRow>,
	options: { kept: string; excluded: string; order: 'asc' | 'desc'; limit: number },
): string | null {
	const { kept, excluded, order, limit } = options;
	if (result.isComplete) return null;
	const direction = order === 'desc' ? { word: '古い', param: 'end' } : { word: '新しい', param: 'since' };
	if (result.trades.length >= limit) {
		const lastAt = toIsoMs(result.trades[result.trades.length - 1]?.executed_at ?? null);
		const next =
			lastAt != null
				? `続きは ${direction.param} に ${lastAt}（取得した最後の約定の時刻）を指定し、count を今回より大きくして取得してください。境界の時刻は含まれるので、同じ時刻の約定は重複して返ります（trade_id で除いてください）`
				: `続きは ${direction.param} で期間を指定して取得してください`;
		return `${INCOMPLETE_PREFIX}指定した件数（${limit}件）に達したので取得を止めました。これより${direction.word}${kept}約定もある可能性があります。${next}`;
	}
	const found =
		result.excluded === 0
			? `${kept}約定は ${result.trades.length}件で、指定の件数に届きませんでした`
			: result.trades.length === 0
				? `取得した約定 ${result.scanned}件はすべて${excluded}で、${kept}約定はありませんでした（約定履歴 API は現物と信用を混ぜて返します）`
				: `取得した約定 ${result.scanned}件のうち ${result.excluded}件は${excluded}で、${kept}約定は ${result.trades.length}件でした（約定履歴 API は現物と信用を混ぜて返します）`;
	const boundary = scanBoundaryIso(result);
	const next =
		boundary != null
			? `続きは ${direction.param} に ${boundary}（最後に調べた約定の時刻）を指定して取得してください`
			: `続きは ${direction.param} で期間を指定して取得してください`;
	const reason = result.stopReason != null ? `${STOP_REASON_TEXT[result.stopReason]}。` : '';
	return `${INCOMPLETE_PREFIX}${found}。${reason}これより${direction.word}約定は取得していません。${next}`;
}
