/**
 * 約定（/transactions）取得のマージ層 — `get_flow_metrics` / `analyze_volume_profile` の共有基盤。
 *
 * 両ツールに重複していた以下を集約する:
 *   - 完了済み UTC 日アーカイブの列挙 + latest 補完という取得戦略
 *   - 重複除去つきマージ（dedup キー = `timestampMs:price:amount:side`）
 *   - 失敗詳細のフォーマット / 部分失敗 warning
 *   - 取得区間のカバレッジ（実データがある区間 / 欠損区間）算出
 *
 * 失敗ハンドリングの方針（全滅 fail / 過半数 fail / 部分失敗 warning）は呼び出し側に委ねる
 * （`lib/candle-fetch.ts` と同じ設計）。判定に必要な素材（results / labels / failures /
 * グループ別 merge）を返すに留める。
 *
 * 上流 fetch は呼び出し側から `TxFetcher` として注入する。lib が tools/ に依存しないための
 * seam であり、テストでは単体で差し替えられる。
 */

import { ISO8601_WITH_OFFSET_PATTERN, MAX_TX_RANGE_DAYS } from '../src/schema/base.js';
import { parseIso8601, toDisplayTime, toIsoTime } from './datetime.js';
import {
	completedUtcDayKeysInRange,
	currentUtcDayKey,
	currentUtcDayStartMs,
	recentCompletedUtcDayKeys,
} from './tx-archive.js';

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

// ── 取得区間の解決（hours / since・until） ──────────────────

/**
 * `since`〜`until` に指定できる最大範囲（ms）。
 * 上限値と根拠は `MAX_TX_RANGE_DAYS`（`src/schema/base.ts`。入力スキーマの description でも
 * 同じ値を出すため定数はそちらに置いている）。
 */
const MAX_TX_RANGE_MS = MAX_TX_RANGE_DAYS * 86_400_000;

export type TxTimeRangeInput = {
	/** 絶対時刻の区間開始（**含む**）。オフセット付き ISO8601 */
	since?: string;
	/**
	 * 絶対時刻の区間終端（**含まない**: `[since, until)`）。オフセット付き ISO8601。
	 * 省略時は現在時刻まで。排他にしておくと、隣接する区間を続けて要求しても
	 * 境界の約定が二重に計上されない。
	 */
	until?: string;
	/** 現在時刻起点の相対窓（時間）。`since` / `until` とは排他 */
	hours?: number;
	/** 暦日指定（YYYYMMDD）。排他チェックにのみ使う（区間の解決には使わない） */
	date?: string;
	/** 現在時刻（テスト用。既定は Date.now()） */
	nowMs?: number;
};

export type TxTimeRangeResolved = {
	/** `hours` = 現在時刻起点の相対窓 / `absolute` = since・until による絶対区間 */
	mode: 'hours' | 'absolute';
	/** 取得層に渡す閉区間の下端（含む） */
	sinceMs: number;
	/** 取得層に渡す閉区間の上端（含む）。`until` 排他指定は 1ms 手前に丸めてある */
	untilMs: number;
	nowMs: number;
	/** 要求区間の長さ（分）。カバレッジ率の分母（`buildTxCoverageWarning` 等に渡す） */
	requestedMinutes: number;
	/** 申告用: 要求区間の開始（UTC ISO8601） */
	sinceIso: string;
	/** 申告用: 要求区間の終端（UTC ISO8601, 排他）。`until` 省略時は現在時刻 */
	untilIso: string;
};

export type TxTimeRangeResolution =
	| ({ ok: true } & TxTimeRangeResolved)
	| { ok: false; error: { type: 'user'; message: string } };

function txRangeUserError(message: string): TxTimeRangeResolution {
	return { ok: false, error: { type: 'user', message } };
}

/** オフセット付き ISO8601 を ms に変換する（形式・暦日ともに strict に検証）。 */
function parseAbsoluteIso(label: string, value: string): { ok: true; ms: number } | { ok: false; message: string } {
	const parts = value.match(ISO8601_WITH_OFFSET_PATTERN);
	if (!parts) {
		return {
			ok: false,
			message: `${label} はオフセット付き ISO8601 で指定してください（例: 2026-08-01T00:00:00Z / 2026-08-01T09:00:00+09:00）。指定値: ${value}`,
		};
	}
	// 秒省略（2026-08-01T00:00Z）を補って strict parse に渡す
	const [, dateHm, sec, offset] = parts;
	const parsed = parseIso8601(`${dateHm}${sec ?? ':00'}${offset}`);
	if (!parsed) {
		return { ok: false, message: `${label} の日時が不正です（存在しない日付・時刻）。指定値: ${value}` };
	}
	return { ok: true, ms: parsed.valueOf() };
}

/**
 * 取得区間を解決する。`hours`（相対）と `since`/`until`（絶対）の排他判定もここで行う。
 *
 * 併用を「どちらかを優先」で黙って解決すると、要求と異なる区間の集計値が返っても応答から
 * 気づけないため user エラーにする。
 */
export function resolveTxTimeRange(input: TxTimeRangeInput): TxTimeRangeResolution {
	const nowMs = input.nowMs ?? Date.now();
	const { since, until, hours, date } = input;
	const hasAbsolute = since != null || until != null;
	const hasHours = hours != null && hours > 0;

	if (hasAbsolute && hasHours) {
		return txRangeUserError(
			'hours と since/until は併用できません（hours は現在時刻起点の相対指定、since/until は絶対時刻の区間指定）。どちらか一方を指定してください',
		);
	}
	if (hasAbsolute && date != null) {
		return txRangeUserError(
			'date と since/until は併用できません（date は UTC 暦日、since/until は絶対時刻の区間指定）。どちらか一方を指定してください',
		);
	}

	if (!hasAbsolute) {
		if (!hasHours) {
			return txRangeUserError('時間範囲の指定がありません（hours または since/until を指定してください）');
		}
		const sinceMs = nowMs - hours * 3600_000;
		return {
			ok: true,
			mode: 'hours',
			sinceMs,
			untilMs: nowMs,
			nowMs,
			requestedMinutes: Math.round(hours * 60),
			sinceIso: toIsoTime(sinceMs) ?? '',
			untilIso: toIsoTime(nowMs) ?? '',
		};
	}

	if (since == null) {
		return txRangeUserError('until 単独では取得区間が決まりません。since も指定してください');
	}

	const sinceParsed = parseAbsoluteIso('since', since);
	if (!sinceParsed.ok) return txRangeUserError(sinceParsed.message);
	const sinceMs = sinceParsed.ms;

	let untilMsExclusive = nowMs;
	if (until != null) {
		const untilParsed = parseAbsoluteIso('until', until);
		if (!untilParsed.ok) return txRangeUserError(untilParsed.message);
		untilMsExclusive = untilParsed.ms;
	}

	if (sinceMs > nowMs) {
		return txRangeUserError(`since が未来時刻です（現在: ${toIsoTime(nowMs)}）。指定値: ${since}`);
	}
	if (untilMsExclusive > nowMs) {
		return txRangeUserError(
			`until が未来時刻です（現在: ${toIsoTime(nowMs)}）。現在までを対象にする場合は until を省略してください。指定値: ${until}`,
		);
	}
	if (sinceMs >= untilMsExclusive) {
		return txRangeUserError(
			`since は until より前の時刻を指定してください（since=${toIsoTime(sinceMs)}, until=${toIsoTime(untilMsExclusive)}）`,
		);
	}
	if (untilMsExclusive - sinceMs > MAX_TX_RANGE_MS) {
		const days = ((untilMsExclusive - sinceMs) / 86_400_000).toFixed(1);
		return txRangeUserError(
			`since〜until が長すぎます（${days}日）。1 リクエスト = 1 UTC 日アーカイブ（BTC/JPY で 5,600〜8,000 件）のため上限は ${MAX_TX_RANGE_DAYS} 日です。期間を分割して呼び出してください`,
		);
	}

	return {
		ok: true,
		mode: 'absolute',
		sinceMs,
		// until は排他（[since, until)）だが取得層は閉区間。1ms 手前を上端にする。
		// until 省略時は「現在時刻まで」なので hours 指定と同じく現在時刻を含める。
		untilMs: until != null ? untilMsExclusive - 1 : nowMs,
		nowMs,
		requestedMinutes: Math.round((untilMsExclusive - sinceMs) / 60_000),
		sinceIso: toIsoTime(sinceMs) ?? '',
		untilIso: toIsoTime(untilMsExclusive) ?? '',
	};
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

/**
 * 取得する時間区間（**両端を含む**閉区間 `[sinceMs, untilMs]`）。
 *
 * 呼び出し側が「終端を含まない」区間を要求する場合は `untilMs` を 1ms 手前に丸めて渡すこと
 * （`resolveTxTimeRange` の `until` がこの形）。区間を閉区間にしているのは、`hours` 指定
 * （終端 = 現在時刻）の従来挙動を保つため。
 */
export type TxTimeRange = {
	sinceMs: number;
	untilMs: number;
};

export type TimeRangeFetch = {
	sinceMs: number;
	untilMs: number;
	nowMs: number;
	/** 進行中の UTC 暦日キー（この日のアーカイブは未公開） */
	currentUtcDay: string;
	/** 要求した完了済み UTC 暦日キー（昇順） */
	dates: string[];
	/**
	 * latest エンドポイントを叩いたか。
	 * 要求区間が進行中の UTC 日にかからない（＝過去区間のみ）場合は false。
	 * 呼び出し側の「進行中 UTC 日は latest 約60件のみ」warning はこのフラグで出し分ける。
	 */
	usedLatest: boolean;
	/** `[...dateResults, latestResult?]`（呼び出し側の errorType 分類用に順序を保つ） */
	results: unknown[];
	/** `[...dates, 'latest'?]` */
	labels: string[];
	/** 日付アーカイブのみのマージ結果（authoritative: 時間範囲をカバー） */
	dateMerge: TxMerge;
	/** latest のみのマージ結果（supplement: 進行中 UTC 日の補完）。未取得なら空 */
	latestMerge: TxMerge;
	/** date + latest を 1 パスでマージした結果 */
	merged: TxMerge;
	/** `merged.txs` を [sinceMs, untilMs] でフィルタし昇順 sort したもの */
	txs: Tx[];
};

/**
 * 指定した時間区間 `[sinceMs, untilMs]` の約定を取得する。
 *
 * bitbank の `/transactions/{YYYYMMDD}` は UTC 暦日アーカイブで、当該 UTC 日が完了する
 * まで 404 を返す（実測: docs/internal/bitbank-tx-archive-tz.md）。進行中の UTC 日は
 * 要求しても必ず 404 なので列挙から除外し、その区間は `/transactions` (latest) で補完する。
 * （JST 暦日で列挙すると JST 早朝＝UTC 日付更新前に進行中の UTC 日を要求して全滅する。）
 *
 * latest は **要求区間が進行中の UTC 日にかかる場合のみ**叩く。過去区間だけを要求された
 * ときの latest は現在の約定しか返さず区間外なので、呼び出しぶんが無駄になる（rate limit も
 * 消費する）。
 */
export async function fetchTxTimeRange(
	fetcher: TxFetcher,
	range: TxTimeRange,
	options: TimeRangeFetchOptions = {},
): Promise<TimeRangeFetch> {
	const nowMs = options.nowMs ?? Date.now();
	const { sinceMs, untilMs } = range;
	const currentUtcDay = currentUtcDayKey(nowMs);
	// 「進行中の UTC 日」の判定は untilMs ではなく実時刻 nowMs で行う
	// （過去区間では untilMs の UTC 日は既に完了しておりアーカイブが公開されている）。
	const dates = completedUtcDayKeysInRange(sinceMs, untilMs, nowMs);
	const usedLatest = untilMs >= currentUtcDayStartMs(nowMs);

	// 日付ベース取得（authoritative: 時間範囲をカバー）と latest（supplement: 直近数分の補完）を
	// 区別する。当日分は日付指定だと直近数分が欠ける場合があるため latest も併用する。
	const results = await Promise.all([...dates.map((ds) => fetcher(ds)), ...(usedLatest ? [fetcher()] : [])]);

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

	const labels = usedLatest ? [...dates, 'latest'] : [...dates];
	const dateResults = results.slice(0, dates.length);
	const latestResults = results.slice(dates.length);
	const dateMerge = mergeTxResults(dateResults, dates);
	const latestMerge = mergeTxResults(latestResults, ['latest']);
	const merged = mergeTxResults(results, labels);
	const txs = sortTxsAsc(merged.txs.filter((t) => t.timestampMs >= sinceMs && t.timestampMs <= untilMs));

	return {
		sinceMs,
		untilMs,
		nowMs,
		currentUtcDay,
		dates,
		usedLatest,
		results,
		labels,
		dateMerge,
		latestMerge,
		merged,
		txs,
	};
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

// ── 件数上限（limit）の適用 ──────────────────────────────────

export type TxLimitApplication = {
	/** limit 適用後の約定（最新側 limit 件） */
	txs: Tx[];
	/** limit 適用**前**に取得できていた件数 */
	totalAvailable: number;
	/** limit により切り捨てが発生したか */
	truncated: boolean;
};

/**
 * 件数ベース取得で `limit` を適用する（最新側 limit 件を残す）。
 *
 * 黙って切ると「指定した期間の全約定を集計した」ように見え、集計値もカバレッジ申告も
 * 部分データ由来であることが応答から分からなくなる（`get_transactions` が
 * `meta.truncated` / warning で解決済みの問題と同型）。呼び出し側が申告できるよう、
 * 適用前の件数と切り捨ての有無を必ず返す。
 *
 * @param sorted timestampMs 昇順にソート済みの約定列
 */
export function applyTxLimit(sorted: Tx[], limit: number): TxLimitApplication {
	const truncated = sorted.length > limit;
	return {
		txs: truncated ? sorted.slice(-limit) : sorted,
		totalAvailable: sorted.length,
		truncated,
	};
}

/**
 * `limit` による切り捨ての warning（取得層, ⚠️）。切り捨てが無ければ undefined。
 *
 * @param scope 切り捨て対象の説明（例: `date=20260801（UTC 暦日）`）
 * @param hint  代替手段の案内（例: 1 日全体の集計には hours を使う）
 */
export function buildTxTruncationWarning(
	app: TxLimitApplication,
	limit: number,
	options: { scope?: string; hint?: string } = {},
): string | undefined {
	if (!app.truncated) return undefined;
	const scope = options.scope ? `${options.scope} の` : '';
	const hint = options.hint ? ` ${options.hint}` : '';
	return `⚠️ ${scope}約定 ${app.totalAvailable}件 のうち最新側 ${app.txs.length}件 のみを集計しています（limit=${limit}）。集計値・カバレッジ申告はこの区間のみが対象です。${hint}`.trimEnd();
}

// ── カバレッジ（実データ区間 / 欠損区間） ────────────────────

/**
 * 約定列のカバレッジ判定で「欠損」とみなす無約定時間の既定閾値（ms）。
 *
 * **この値は実測から決めること。日平均約定間隔から導かないこと。**
 * 旧既定 5 分は「1 UTC 日 5,609〜8,040 件 ≒ 平均 10.7〜15.4 秒間隔なので、5 分の無約定は
 * 起こり得ない」という推論で置いた値だったが、これが誤りだった。日平均は活発な時間帯に
 * 引っ張られており、閑散帯には桁違いに間隔が伸びる。結果として BTC/JPY の平常な夜間を
 * 毎晩「取得欠損」と誤検知していた。
 *
 * 実測（2026-08-01）:
 * - JST 深夜（00:00〜05:00）の無約定区間は 47 分に 1 回、それ以外は 485 分に 1 回と
 *   **約 10 倍**の開きがある。取得欠損なら時刻とこれほど相関しない。
 * - 最長の閑散区間は 7.5 分（JST 01:43:40〜01:51:12）。同区間を別系統の
 *   `/candlestick` (1min) で確認すると 7 本連続で volume=0・OHLC が前足終値に張り付き
 *   ＝**本当に約定が無かった**ことが裏付けられた（アーカイブの欠落ではない）。
 *
 * 実測の最長 7.5 分に余裕を持たせて 15 分とする。
 *
 * 検出したい実欠損（UTC 日アーカイブの取得失敗 / 進行中 UTC 日が latest 約60件のみ）は
 * いずれも**時間スケール**でしか起きないため、15 分でも取りこぼさない。
 *
 * 再調整する場合は同じ手順を踏むこと: 疑わしい区間を `/candlestick` (1min) の volume と
 * 突き合わせ、0 なら閑散（閾値を上げる）、非 0 なら約定アーカイブの欠落（閾値は据え置き）。
 */
export const DEFAULT_TX_GAP_MS = 15 * 60_000;

export type TxSegment = { startMs: number; endMs: number; durationMinutes: number };

export type TxCoverage = {
	startMs: number;
	endMs: number;
	/** 先頭〜末尾のスパン（**欠損区間を含む**） */
	spanMinutes: number;
	/** 実際に約定が存在する区間（セグメント）の合計 */
	coveredMinutes: number;
	/** spanMinutes - coveredMinutes */
	gapMinutes: number;
	/** 連続して約定があった区間 */
	segments: TxSegment[];
	/** 閾値を超える無約定区間 */
	gaps: TxSegment[];
};

function toSegment(startMs: number, endMs: number): TxSegment {
	return { startMs, endMs, durationMinutes: Math.round((endMs - startMs) / 60_000) };
}

/**
 * 約定列から実カバー区間と欠損区間を算出する。
 *
 * 先頭〜末尾の単純差分（span）を「カバー済み時間」として申告すると、アーカイブ未公開区間の
 * ような穴を埋めたことにしてしまう。実データがある区間だけを合計した `coveredMinutes` を
 * 併記するために使う。
 *
 * @param txs   timestampMs 昇順にソート済みの約定列
 * @param gapMs 欠損とみなす無約定時間の閾値
 */
export function computeTxCoverage(txs: Tx[], gapMs: number = DEFAULT_TX_GAP_MS): TxCoverage | null {
	if (txs.length === 0) return null;
	const startMs = txs[0].timestampMs;
	const endMs = txs[txs.length - 1].timestampMs;

	const segments: TxSegment[] = [];
	const gaps: TxSegment[] = [];
	let segStart = startMs;
	let prev = startMs;
	let coveredMs = 0;
	for (const t of txs) {
		if (t.timestampMs - prev > gapMs) {
			segments.push(toSegment(segStart, prev));
			gaps.push(toSegment(prev, t.timestampMs));
			coveredMs += prev - segStart;
			segStart = t.timestampMs;
		}
		prev = t.timestampMs;
	}
	segments.push(toSegment(segStart, prev));
	coveredMs += prev - segStart;

	const spanMinutes = Math.round((endMs - startMs) / 60_000);
	const coveredMinutes = Math.round(coveredMs / 60_000);
	return {
		startMs,
		endMs,
		spanMinutes,
		coveredMinutes,
		// 分に丸めた値どうしの差にして span = covered + gap の整合を保つ（個別に丸めるとずれる）
		gapMinutes: Math.max(0, spanMinutes - coveredMinutes),
		segments,
		gaps,
	};
}

/**
 * `[startMs, endMs]` が欠損区間に完全に含まれるか（= この区間には取得できたデータが無い）。
 *
 * 時間バケット集計で「約定ゼロ」と「データなし」を区別するために使う。両者を混同すると、
 * 欠損区間のゼロ埋めがそのまま観測値として平均・分散に入り、Z スコア / スパイク判定を歪める。
 *
 * 判定は「区間全体が欠損に含まれる」で行う。欠損の境界にあたるバケットは境界の約定を
 * 含むため、そもそもゼロにならない。
 */
export function isGapRange(coverage: TxCoverage | null, startMs: number, endMs: number): boolean {
	if (!coverage) return false;
	return coverage.gaps.some((g) => startMs >= g.startMs && endMs <= g.endMs);
}

export type TxCoverageWarningOptions = {
	/**
	 * 要求した時間窓（分）。カバー率の分母になる。
	 * 呼び出し側が要求スコープを持つ場合のみ指定する（時間範囲指定・暦日指定 等）。
	 */
	requestedMinutes?: number;
	tz?: string;
};

/**
 * カバレッジ欠損の注記（取得層 warning, ℹ️）を組み立てる。欠損が無ければ undefined。
 *
 * 「先頭〜末尾の N 分間分を取得」とだけ申告すると欠損区間をカバー済みに見せてしまうため、
 * 要求窓 / 実カバー / 欠損を必ずセットで出す。
 */
/**
 * 「要求窓を満たしていない」と判定するカバー率の閾値（%）。
 *
 * #8 で削除した旧注記（「直近約N分間分です…」）が使っていた 80% を踏襲する。旧注記は
 * 枠組みこそ誤解を招いたが、カバー率 80% 未満で定量表示するという閾値自体は妥当だった。
 */
export const COVERAGE_SHORTFALL_WARN_PCT = 80;

/**
 * 要求した時間窓に対して実カバーが不足しているか（カバー率 < 80%）。
 *
 * 区間**内部**の欠損（gaps）とは独立した判定。gaps がゼロでも、窓の先頭・末尾側が
 * 未カバーならこちらが true になる（例: hours=4 の窓が丸ごと進行中 UTC 日内にあり、
 * latest 約60件 ≒ 34分ぶんしか取れないケース。実測: 2026-08-02）。
 */
export function hasCoverageShortfall(coverage: TxCoverage | null, requestedMinutes?: number): boolean {
	if (!coverage || requestedMinutes == null || requestedMinutes <= 0) return false;
	return (coverage.coveredMinutes / requestedMinutes) * 100 < COVERAGE_SHORTFALL_WARN_PCT;
}

export function buildTxCoverageWarning(
	coverage: TxCoverage | null,
	options: TxCoverageWarningOptions = {},
): string | undefined {
	if (!coverage) return undefined;
	const requested = options.requestedMinutes;
	const hasGaps = coverage.gaps.length > 0;
	// 内部欠損が無く、要求窓も（無い or 8 割以上）満たしているなら警告不要
	if (!hasGaps && !hasCoverageShortfall(coverage, requested)) return undefined;

	const tz = options.tz ?? 'Asia/Tokyo';
	const head =
		requested != null && requested > 0
			? `ℹ️ カバレッジ: 要求 ${requested}分のうち実データがあるのは ${coverage.coveredMinutes}分（${Math.round((coverage.coveredMinutes / requested) * 100)}%）です`
			: `ℹ️ カバレッジ: 取得区間のスパン ${coverage.spanMinutes}分のうち実データがあるのは ${coverage.coveredMinutes}分です`;
	const parts: string[] = [head];

	if (hasGaps) {
		const largest = coverage.gaps.reduce((a, b) => (b.durationMinutes > a.durationMinutes ? b : a));
		const largestLabel = `${toDisplayTime(largest.startMs, tz) ?? '?'}〜${toDisplayTime(largest.endMs, tz) ?? '?'}`;
		parts.push(
			`欠損 ${coverage.gapMinutes}分（${coverage.gaps.length}区間、最大 ${largest.durationMinutes}分: ${largestLabel}）`,
		);
	}

	// 要求窓のうち、取得できた区間（先頭〜末尾）の外側にある未カバー分。内部欠損とは別勘定。
	const outsideMinutes = requested != null ? Math.max(0, requested - coverage.spanMinutes) : 0;
	if (outsideMinutes > 0) {
		const rangeLabel = `${toDisplayTime(coverage.startMs, tz) ?? '?'}〜${toDisplayTime(coverage.endMs, tz) ?? '?'}`;
		parts.push(`実データ区間（${rangeLabel}）の外側 ${outsideMinutes}分 は未カバーです`);
	}

	return parts.join('。');
}

/**
 * 「集計値がカバー区間のみから算出されている」ことを示す注記（計算層 warnings[]）。
 *
 * 取得層の欠損そのもの（`buildTxCoverageWarning`）とは別系統。`.claude/rules/tools.md` の
 * 2 系統ルールに従い、`meta.warning`（string）ではなく `meta.warnings`（string[]）に載せる。
 *
 * @param requestedMinutes 要求した時間窓（分）。カバー率 80% 未満なら
 *   「窓全体を代表する値ではない」旨を追記する（内部欠損の有無と独立）。
 */
export function buildAggregateCoverageNote(
	coverage: TxCoverage,
	metricsLabel: string,
	requestedMinutes?: number,
): string {
	let note = `${metricsLabel}は実データのある ${coverage.coveredMinutes}分（${coverage.segments.length}区間）のみから算出しています`;
	if (coverage.gapMinutes > 0) {
		note += `。欠損 ${coverage.gapMinutes}分の約定は含まれません`;
	}
	if (hasCoverageShortfall(coverage, requestedMinutes)) {
		note += `。要求した時間窓（${requestedMinutes}分）全体を代表する値ではありません`;
	}
	return note;
}
