/**
 * 約定（/transactions）取得のマージ層 — `get_flow_metrics` / `analyze_volume_profile` の共有基盤。
 *
 * 両ツールに重複していた以下を集約する:
 *   - 完了済み UTC 日アーカイブの列挙 + latest 補完という取得戦略
 *   - 重複除去つきマージ（dedup キー = `timestampMs:price:amount:side`）
 *   - 失敗詳細のフォーマット / 部分失敗 warning
 *
 * 失敗ハンドリングの方針（全滅 fail / 過半数 fail / 部分失敗 warning）は呼び出し側に委ねる
 * （`lib/candle-fetch.ts` と同じ設計）。判定に必要な素材（results / labels / failures /
 * グループ別 merge）を返すに留める。
 *
 * 上流 fetch は呼び出し側から `TxFetcher` として注入する。lib が tools/ に依存しないための
 * seam であり、テストでは単体で差し替えられる。
 */

import { completedUtcDayKeysInRange, currentUtcDayKey, recentCompletedUtcDayKeys } from './tx-archive.js';

/** 正規化済み約定（`get_transactions` の `data.normalized` 要素） */
export type Tx = {
	price: number;
	amount: number;
	side: 'buy' | 'sell';
	timestampMs: number;
	isoTime: string;
};

/** `get_transactions` が返す Result のうち、本モジュールが参照する部分 */
export type TxSourceResult = {
	ok?: boolean;
	data?: { normalized?: Tx[] };
	summary?: string;
	meta?: { errorType?: string };
} | null;

/**
 * 約定ソース 1 件を取得する関数。`date` 省略時は latest エンドポイント。
 * 戻り値は `get_transactions` の Result（`TxSourceResult` として読む）。
 *
 * lib から tools/ を import しないための注入点。呼び出し側が
 * `(date) => getTransactions(pair, ..., date, ...)` の形で渡す。
 * 上流 Result の完全な型を要求すると呼び出し側で構造が固定されてしまうため、
 * 受け口は `unknown` にして本モジュール内で `TxSourceResult` に読み替える。
 */
export type TxFetcher = (date?: string) => Promise<unknown>;

/** 取得に失敗したソース 1 件の診断情報 */
export type TxFetchFailure = { label: string; errorType: string; message: string };

export type TxMerge = {
	/** 重複除去済みの約定。**未 sort** — 呼び出し側で昇順 sort すること */
	txs: Tx[];
	/** マージ対象となったソース数 */
	totalCount: number;
	/** 失敗したソース数（= failures.length） */
	failedCount: number;
	failures: TxFetchFailure[];
};

/**
 * 重複除去キー: `timestampMs:price:amount:side`
 *
 * - bitbank の `/transactions` (latest) と `/transactions/{date}` で同じ約定の
 *   `transaction_id` が一致しないケースがあるため、`transaction_id` は使用しない。
 * - 同一ミリ秒・同一価格・同一数量・同一サイドの約定は実用上同一とみなす（誤差は
 *   CVD 等の集計値に影響しない範囲）。
 *
 * このキーは両ツールの description に加工契約として明文化済み。変更しないこと。
 */
export function txDedupKey(tx: Tx): string {
	return `${tx.timestampMs}:${tx.price}:${tx.amount}:${tx.side}`;
}

/**
 * 複数の `get_transactions` 結果をマージし重複を除去する（失敗詳細も返す）。
 *
 * マージ後の `txs` はソート前である。呼び出し側で `sortTxsAsc()` を適用すること
 * （加工契約: 全ての取得パスで昇順 sort を保証する）。
 */
export function mergeTxResults(results: unknown[], labels?: string[]): TxMerge {
	const seen = new Set<string>();
	const merged: Tx[] = [];
	const failures: TxFetchFailure[] = [];
	for (let i = 0; i < results.length; i++) {
		const r = results[i] as TxSourceResult;
		if (r?.ok && Array.isArray(r.data?.normalized)) {
			for (const tx of r.data.normalized as Tx[]) {
				const key = txDedupKey(tx);
				if (!seen.has(key)) {
					seen.add(key);
					merged.push(tx);
				}
			}
		} else {
			failures.push({
				label: labels?.[i] ?? `#${i}`,
				errorType: r?.meta?.errorType ?? 'unknown',
				message: r?.summary ?? 'unknown error',
			});
		}
	}
	return { txs: merged, totalCount: results.length, failedCount: failures.length, failures };
}

/** 加工契約: 全ての取得パスで timestampMs 昇順を保証する（入力は破壊しない）。 */
export function sortTxsAsc(txs: Tx[]): Tx[] {
	return txs.slice().sort((a, b) => a.timestampMs - b.timestampMs);
}

/**
 * 失敗詳細を "label(errorType: message)" 形式で列挙する。
 *
 * 「N件中M件失敗」だけではどの日付が何の理由で落ちたか判別できず調査不能になるため、
 * fail / warning のメッセージには必ずこれを含めること。
 */
export function formatTxFailures(failures: TxFetchFailure[]): string {
	return failures.map((f) => `${f.label}(${f.errorType}: ${f.message})`).join(', ');
}

/** 最初に見つかった失敗結果の errorType / summary を返す（全滅時の分類用）。 */
export function extractUpstreamError(results: unknown[]): { errorType: string; summary: string } | null {
	for (const res of results) {
		const r = res as { ok?: boolean; meta?: { errorType?: string }; summary?: string } | null;
		if (r && r.ok === false && r.meta?.errorType) {
			return { errorType: r.meta.errorType, summary: r.summary ?? 'upstream error' };
		}
	}
	return null;
}

/** 部分失敗の warning（取得層, ⚠️）。失敗が無ければ undefined。 */
export function partialFailureWarning(totalCount: number, failures: TxFetchFailure[]): string | undefined {
	if (failures.length === 0) return undefined;
	return `⚠️ ${totalCount}件中${failures.length}件のAPI取得に失敗しました（${formatTxFailures(failures)}）。データが不完全な可能性があります。`;
}

// ── 時間範囲ベースの取得 ─────────────────────────────────────

export type TimeRangeFetchOptions = {
	/** 現在時刻（テスト用。既定は Date.now()） */
	nowMs?: number;
	/**
	 * 失敗した日付アーカイブを一度だけ再取得する。
	 * `fetchJsonWithRateLimit` の内部リトライより長い間隔を空けたい場合に指定する。
	 */
	retryFailedDates?: { delayMs: number };
};

export type TimeRangeFetch = {
	sinceMs: number;
	nowMs: number;
	/** 進行中の UTC 暦日キー（この日のアーカイブは未公開） */
	currentUtcDay: string;
	/** 要求した完了済み UTC 暦日キー（昇順） */
	dates: string[];
	/** `[...dateResults, latestResult]`（呼び出し側の errorType 分類用に順序を保つ） */
	results: unknown[];
	/** `[...dates, 'latest']` */
	labels: string[];
	/** 日付アーカイブのみのマージ結果（authoritative: 時間範囲をカバー） */
	dateMerge: TxMerge;
	/** latest のみのマージ結果（supplement: 進行中 UTC 日の補完） */
	latestMerge: TxMerge;
	/** date + latest を 1 パスでマージした結果 */
	merged: TxMerge;
	/** `merged.txs` を [sinceMs, nowMs] でフィルタし昇順 sort したもの */
	txs: Tx[];
};

/**
 * 直近 `hours` 時間分の約定を取得する。
 *
 * bitbank の `/transactions/{YYYYMMDD}` は UTC 暦日アーカイブで、当該 UTC 日が完了する
 * まで 404 を返す（実測: docs/internal/bitbank-tx-archive-tz.md）。進行中の UTC 日は
 * 要求しても必ず 404 なので列挙から除外し、その区間は `/transactions` (latest) で補完する。
 * （JST 暦日で列挙すると JST 早朝＝UTC 日付更新前に進行中の UTC 日を要求して全滅する。）
 */
export async function fetchTxTimeRange(
	fetcher: TxFetcher,
	hours: number,
	options: TimeRangeFetchOptions = {},
): Promise<TimeRangeFetch> {
	const nowMs = options.nowMs ?? Date.now();
	const sinceMs = nowMs - hours * 3600_000;
	const currentUtcDay = currentUtcDayKey(nowMs);
	const dates = completedUtcDayKeysInRange(sinceMs, nowMs);

	// 日付ベース取得（authoritative: 時間範囲をカバー）と latest（supplement: 直近数分の補完）を
	// 区別する。当日分は日付指定だと直近数分が欠ける場合があるため latest も併用する。
	const results = await Promise.all([...dates.map((ds) => fetcher(ds)), fetcher()]);

	const retry = options.retryFailedDates;
	if (retry) {
		const retryIdx: number[] = [];
		for (let i = 0; i < dates.length; i++) {
			if (!(results[i] as TxSourceResult)?.ok) retryIdx.push(i);
		}
		if (retryIdx.length > 0) {
			await new Promise((resolve) => setTimeout(resolve, retry.delayMs));
			const retried = await Promise.all(retryIdx.map((i) => fetcher(dates[i])));
			for (let j = 0; j < retryIdx.length; j++) {
				if ((retried[j] as TxSourceResult)?.ok) results[retryIdx[j]] = retried[j];
			}
		}
	}

	const labels = [...dates, 'latest'];
	const dateResults = results.slice(0, dates.length);
	const latestResults = results.slice(dates.length);
	const dateMerge = mergeTxResults(dateResults, dates);
	const latestMerge = mergeTxResults(latestResults, ['latest']);
	const merged = mergeTxResults(results, labels);
	const txs = sortTxsAsc(merged.txs.filter((t) => t.timestampMs >= sinceMs && t.timestampMs <= nowMs));

	return { sinceMs, nowMs, currentUtcDay, dates, results, labels, dateMerge, latestMerge, merged, txs };
}

// ── 件数ベースの取得 ─────────────────────────────────────────

export type LatestTxFetch = {
	/** latest エンドポイントの生結果（errorType 分類用に保持） */
	result: unknown;
	/** latest が返した約定（未 dedup / 未 sort） */
	txs: Tx[];
};

/**
 * `/transactions` (latest) を 1 回叩く。bitbank の latest は直近約 60 件しか返さないため、
 * 要求件数を満たすかどうかの判定と、満たさない場合の `fetchSupplementTxs` 呼び出しは
 * 呼び出し側で行う（「latest 失敗なら補完せず即 fail」等の方針がツールごとに異なるため）。
 */
export async function fetchLatestTxs(fetcher: TxFetcher): Promise<LatestTxFetch> {
	const result = await fetcher();
	const r = result as TxSourceResult;
	const txs: Tx[] = r?.ok && Array.isArray(r.data?.normalized) ? (r.data.normalized as Tx[]) : [];
	return { result, txs };
}

export type SupplementFetchOptions = {
	/** 現在時刻（テスト用。既定は Date.now()） */
	nowMs?: number;
};

export type SupplementFetch = {
	/** 補完に使った完了済み UTC 暦日キー */
	supplementDates: string[];
	/** `[latest.result, ...supplementResults]` */
	results: unknown[];
	/** `['latest', ...supplementDates]` */
	labels: string[];
	/** results 全体のマージ結果（**未 sort**） */
	merged: TxMerge;
};

/**
 * latest だけで要求件数に届かないとき、完了済み UTC 日アーカイブで補完する。
 *
 * `/transactions/{YYYYMMDD}` は当該 UTC 日完了後に公開されるため、JST 基準の「昨日」で
 * 組むと JST 早朝（UTC 日付更新前）は進行中の UTC 日を要求して必ず 404 になる。
 *
 * 最終的な sort / 件数の切り出しは呼び出し側で行う（ツールごとに要件が異なるため）。
 */
export async function fetchSupplementTxs(
	fetcher: TxFetcher,
	limit: number,
	latest: LatestTxFetch,
	options: SupplementFetchOptions = {},
): Promise<SupplementFetch> {
	const supplementDates = recentCompletedUtcDayKeys(limit > 500 ? 2 : 1, options.nowMs);
	const supplementResults = await Promise.all(supplementDates.map((ds) => fetcher(ds)));
	const results = [latest.result, ...supplementResults];
	const labels = ['latest', ...supplementDates];
	return { supplementDates, results, labels, merged: mergeTxResults(results, labels) };
}
