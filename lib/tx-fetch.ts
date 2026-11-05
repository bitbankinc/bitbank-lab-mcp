// 失敗の扱い（全滅 / 過半数 / 部分失敗）は呼び出し側に委ねる（lib/candle-fetch.ts と同じ設計）。

import { ISO8601_WITH_OFFSET_PATTERN, MAX_TX_RANGE_DAYS } from '../src/schema/base.js';
import { parseIso8601, toDisplayTime, toIsoTime } from './datetime.js';
import {
	completedUtcDayKeysInRange,
	currentUtcDayKey,
	currentUtcDayStartMs,
	recentCompletedUtcDayKeys,
} from './tx-archive.js';

export type Tx = {
	price: number;
	amount: number;
	side: 'buy' | 'sell';
	timestampMs: number;
	isoTime: string;
};

export type TxSourceResult = {
	ok?: boolean;
	data?: { normalized?: Tx[] };
	summary?: string;
	meta?: { errorType?: string };
} | null;

/** lib から tools/ を import しないための注入点。受け口は unknown にして本モジュール内で TxSourceResult に読み替える。 */
export type TxFetcher = (date?: string) => Promise<unknown>;

/** get_transactions の応答件数上限（public ツールの limit 上限と同値）。 */
const PUBLIC_TX_LIMIT = 1000;

// get_transactions の 1000 件上限は MCP 応答のサイズ制限なので、集計用途では外す（キャップすると 1 UTC 日の末尾側しか集計に入らない）。
export function unlimitedTxFetcher(
	getTransactions: (
		pair: string,
		limit: number,
		date: string | undefined,
		filters: undefined,
		options: { unlimited: boolean },
	) => Promise<unknown>,
	pair: string,
): TxFetcher {
	// unlimited 指定時に limit は無視されるが、オプションが外れても応答上限へ縮退するよう public 上限を渡す。
	return (date) => getTransactions(pair, PUBLIC_TX_LIMIT, date, undefined, { unlimited: true });
}

export type TxFetchFailure = { label: string; errorType: string; message: string };

export type TxMerge = {
	/** 未 sort。呼び出し側で昇順 sort する。 */
	txs: Tx[];
	totalCount: number;
	failedCount: number;
	failures: TxFetchFailure[];
};

// transaction_id は latest と日付アーカイブで一致しないことがあるので使わない。両ツールの description に加工契約として明記してあるので変えない。
export function txDedupKey(tx: Tx): string {
	return `${tx.timestampMs}:${tx.price}:${tx.amount}:${tx.side}`;
}

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

// どの日付が何の理由で落ちたか調査できるよう、fail / warning のメッセージには必ずこれを含める。
export function formatTxFailures(failures: TxFetchFailure[]): string {
	return failures.map((f) => `${f.label}(${f.errorType}: ${f.message})`).join(', ');
}

export function extractUpstreamError(results: unknown[]): { errorType: string; summary: string } | null {
	for (const res of results) {
		const r = res as { ok?: boolean; meta?: { errorType?: string }; summary?: string } | null;
		if (r && r.ok === false && r.meta?.errorType) {
			return { errorType: r.meta.errorType, summary: r.summary ?? 'upstream error' };
		}
	}
	return null;
}

export function partialFailureWarning(totalCount: number, failures: TxFetchFailure[]): string | undefined {
	if (failures.length === 0) return undefined;
	return `⚠️ ${totalCount}件中${failures.length}件のAPI取得に失敗しました（${formatTxFailures(failures)}）。データが不完全な可能性があります。`;
}

// 上限値は入力スキーマの description でも出すので src/schema/base.ts に置いている。
const MAX_TX_RANGE_MS = MAX_TX_RANGE_DAYS * 86_400_000;

export type TxTimeRangeInput = {
	since?: string;
	/** 排他（[since, until)）。隣接する区間を続けて要求しても境界の約定が二重に計上されない。 */
	until?: string;
	hours?: number;
	/** 排他チェックにのみ使う（区間の解決には使わない）。 */
	date?: string;
	nowMs?: number;
};

export type TxTimeRangeResolved = {
	mode: 'hours' | 'absolute';
	sinceMs: number;
	untilMs: number;
	nowMs: number;
	requestedMinutes: number;
	sinceIso: string;
	untilIso: string;
};

export type TxTimeRangeResolution =
	| ({ ok: true } & TxTimeRangeResolved)
	| { ok: false; error: { type: 'user'; message: string } };

function txRangeUserError(message: string): TxTimeRangeResolution {
	return { ok: false, error: { type: 'user', message } };
}

function parseAbsoluteIso(label: string, value: string): { ok: true; ms: number } | { ok: false; message: string } {
	const parts = value.match(ISO8601_WITH_OFFSET_PATTERN);
	if (!parts) {
		return {
			ok: false,
			message: `${label} はオフセット付き ISO8601 で指定してください（例: 2026-08-01T00:00:00Z / 2026-08-01T09:00:00+09:00）。指定値: ${value}`,
		};
	}
	// parseIso8601 の strict format は小数秒 3 桁固定なので、秒省略や桁数違いを .SSS に揃えてから渡す。
	const [, dateHm, sec, frac, offset] = parts;
	const ms = (frac ?? '').padEnd(3, '0').slice(0, 3);
	const parsed = parseIso8601(`${dateHm}:${sec ?? '00'}.${ms}${offset}`);
	if (!parsed) {
		return { ok: false, message: `${label} の日時が不正です（存在しない日付・時刻）。指定値: ${value}` };
	}
	return { ok: true, ms: parsed.valueOf() };
}

// hours と since / until の併用はどちらかを優先せず user エラーにする（要求と違う区間の集計に気づけないため）。
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
		// until は排他だが取得層は閉区間なので 1ms 手前を上端にする。省略時は現在時刻を含める。
		untilMs: until != null ? untilMsExclusive - 1 : nowMs,
		nowMs,
		requestedMinutes: Math.round((untilMsExclusive - sinceMs) / 60_000),
		sinceIso: toIsoTime(sinceMs) ?? '',
		untilIso: toIsoTime(untilMsExclusive) ?? '',
	};
}

export type TimeRangeFetchOptions = {
	nowMs?: number;
	retryFailedDates?: { delayMs: number };
};

// 閉区間にしているのは hours 指定（終端 = 現在時刻）の従来挙動を保つため。
export type TxTimeRange = {
	sinceMs: number;
	untilMs: number;
};

export type TimeRangeFetch = {
	sinceMs: number;
	untilMs: number;
	nowMs: number;
	currentUtcDay: string;
	dates: string[];
	/** 要求区間が進行中の UTC 日にかからないときは false。呼び出し側の latest 約 60 件の warning はこれで出し分ける。 */
	usedLatest: boolean;
	results: unknown[];
	labels: string[];
	dateMerge: TxMerge;
	latestMerge: TxMerge;
	merged: TxMerge;
	txs: Tx[];
};

// /transactions/{date} は UTC 日が完了するまで 404 なので、進行中の UTC 日は列挙せず latest で補う。latest は要求区間が進行中の UTC 日にかかるときだけ叩く。
export async function fetchTxTimeRange(
	fetcher: TxFetcher,
	range: TxTimeRange,
	options: TimeRangeFetchOptions = {},
): Promise<TimeRangeFetch> {
	const nowMs = options.nowMs ?? Date.now();
	const { sinceMs, untilMs } = range;
	const currentUtcDay = currentUtcDayKey(nowMs);
	// 進行中の UTC 日の判定は untilMs ではなく実時刻 nowMs で行う。
	const dates = completedUtcDayKeysInRange(sinceMs, untilMs, nowMs);
	const usedLatest = untilMs >= currentUtcDayStartMs(nowMs);

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

export type LatestTxFetch = {
	result: unknown;
	txs: Tx[];
};

// 補完するかどうかは呼び出し側で決める（latest 失敗時の方針がツールごとに異なる）。
export async function fetchLatestTxs(fetcher: TxFetcher): Promise<LatestTxFetch> {
	const result = await fetcher();
	const r = result as TxSourceResult;
	const txs: Tx[] = r?.ok && Array.isArray(r.data?.normalized) ? (r.data.normalized as Tx[]) : [];
	return { result, txs };
}

export type SupplementFetchOptions = {
	nowMs?: number;
};

export type SupplementFetch = {
	supplementDates: string[];
	results: unknown[];
	labels: string[];
	merged: TxMerge;
};

// JST 基準の「昨日」で組むと JST 早朝は進行中の UTC 日を要求して必ず 404 になる。
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

export type TxLimitApplication = {
	txs: Tx[];
	totalAvailable: number;
	truncated: boolean;
};

// 黙って切ると全約定を集計したように見えるので、適用前の件数と切り捨ての有無を必ず返す。
export function applyTxLimit(sorted: Tx[], limit: number): TxLimitApplication {
	const truncated = sorted.length > limit;
	return {
		txs: truncated ? sorted.slice(-limit) : sorted,
		totalAvailable: sorted.length,
		truncated,
	};
}

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

// 実測から決めた値で、日平均約定間隔から導かない（閑散帯の無約定は最長 7.5 分。再調整は /candlestick 1min の volume と突き合わせる）。
export const DEFAULT_TX_GAP_MS = 15 * 60_000;

export type TxSegment = { startMs: number; endMs: number; durationMinutes: number };

export type TxCoverage = {
	startMs: number;
	endMs: number;
	spanMinutes: number;
	coveredMinutes: number;
	gapMinutes: number;
	segments: TxSegment[];
	gaps: TxSegment[];
};

function toSegment(startMs: number, endMs: number): TxSegment {
	return { startMs, endMs, durationMinutes: Math.round((endMs - startMs) / 60_000) };
}

// span を「カバー済み時間」と申告すると穴を埋めたことになるので、実データがある区間だけを合計する。
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

// 約定ゼロとデータなしを区別する。混同すると欠損のゼロ埋めが平均・分散に入り、Z スコアやスパイク判定を歪める。
export function isGapRange(coverage: TxCoverage | null, startMs: number, endMs: number): boolean {
	if (!coverage) return false;
	return coverage.gaps.some((g) => startMs >= g.startMs && endMs <= g.endMs);
}

export type TxCoverageWarningOptions = {
	requestedMinutes?: number;
	tz?: string;
};

export const COVERAGE_SHORTFALL_WARN_PCT = 80;

// 区間内部の欠損とは独立した判定。gaps がゼロでも窓の先頭・末尾が未カバーなら true になる。
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

// 取得層の欠損（buildTxCoverageWarning）とは別系統なので meta.warnings 側に載せる。
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
