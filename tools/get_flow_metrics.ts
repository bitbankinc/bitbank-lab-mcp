import { dayjs, toDisplayTime, toIsoTime, toIsoWithTz } from '../lib/datetime.js';
import { formatSummary } from '../lib/formatter.js';
import { fail, failFromError, failFromValidation, ok } from '../lib/result.js';
import { isArchiveExpectedPublished } from '../lib/tx-archive.js';
import {
	applyTxLimit,
	buildAggregateCoverageNote,
	buildTxCoverageWarning,
	buildTxTruncationWarning,
	computeTxCoverage,
	fetchLatestTxs,
	fetchSupplementTxs,
	fetchTxTimeRange,
	formatTxFailures,
	isGapRange,
	sortTxsAsc,
	type Tx,
	type TxFetcher,
	type TxLimitApplication,
} from '../lib/tx-fetch.js';
import { createMeta, ensurePair, validateLimit } from '../lib/validate.js';
import { GetFlowMetricsInputSchema, GetFlowMetricsOutputSchema } from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import getTransactions from './get_transactions.js';

export interface FlowMetricsBucket {
	timestampMs: number;
	isoTime: string;
	isoTimeJST?: string;
	displayTime?: string;
	buyVolume: number;
	sellVolume: number;
	totalVolume: number;
	cvd: number;
	zscore: number | null;
	spike: 'notice' | 'warning' | 'strong' | null;
	/**
	 * このバケットの区間に取得できたデータがあるか。
	 * `false` は「約定ゼロ」ではなく「取得できていない（欠損区間）」を意味する。
	 * ツール出力では常にセットされる。表示層の入力型としては省略を許し、
	 * 未指定はデータありとして扱う（判定は必ず `=== false` で行うこと）。
	 */
	hasData?: boolean;
}

/** バケットの表示時刻ラベル */
function bucketTimeLabel(b: FlowMetricsBucket): string {
	return b.displayTime || b.isoTimeJST || b.isoTime || '?';
}

/**
 * compact 表示用の行を組み立てる。連続する欠損バケットは 1 行の区間表記に畳む。
 *
 * 「非ゼロのみ」で単純フィルタすると欠損区間が応答から**黙って消える**ため、
 * 欠損は必ず区間として残す（消すと「閑散だった」と誤読される）。
 */
export function renderCompactBucketLines(
	buckets: FlowMetricsBucket[],
	fmt: (b: FlowMetricsBucket, index: number) => string,
): { lines: string[]; shown: number; gapBuckets: number } {
	const lines: string[] = [];
	let shown = 0;
	let gapBuckets = 0;
	let i = 0;
	while (i < buckets.length) {
		if (buckets[i].hasData === false) {
			const start = i;
			while (i < buckets.length && buckets[i].hasData === false) i++;
			gapBuckets += i - start;
			lines.push(
				`⋯ 欠損 ${bucketTimeLabel(buckets[start])}〜${bucketTimeLabel(buckets[i - 1])}（${i - start}バケット, データなし）`,
			);
			continue;
		}
		const b = buckets[i];
		if (b.buyVolume > 0 || b.sellVolume > 0) {
			lines.push(fmt(b, shown));
			shown++;
		}
		i++;
	}
	return { lines, shown, gapBuckets };
}

export interface BuildFlowMetricsTextInput {
	baseSummary: string;
	dataWarning?: string;
	totalTrades: number;
	buyVolume: number;
	sellVolume: number;
	netVolume: number;
	aggressorRatio: number;
	cvd: number;
	buckets: FlowMetricsBucket[];
	bucketMs: number;
	/** "summary" はバケット行を省略, "compact" は非ゼロバケットのみ, "full" は全件 */
	bucketsMode?: 'summary' | 'compact' | 'full';
}

/** テキスト組み立て（フロー分析結果）— テスト可能な純粋関数 */
export function buildFlowMetricsText(input: BuildFlowMetricsTextInput): string {
	const {
		baseSummary,
		dataWarning,
		totalTrades,
		buyVolume,
		sellVolume,
		netVolume,
		aggressorRatio,
		cvd,
		buckets,
		bucketMs,
		bucketsMode = 'full',
	} = input;
	const warningLine = dataWarning ? `\n${dataWarning}` : '';
	const aggregatesLine = `\naggregates: totalTrades=${totalTrades} buyVol=${Number(buyVolume.toFixed(4))} sellVol=${Number(sellVolume.toFixed(4))} netVol=${Number(netVolume.toFixed(4))} aggRatio=${aggressorRatio} finalCvd=${Number(cvd.toFixed(4))}`;
	const footer =
		`\n\n---\n📌 含まれるもの: 時系列バケット（買い/売り出来高・CVD・Zスコア・スパイク）、集計値` +
		`\n📌 含まれないもの: 個別約定の詳細、OHLCV価格データ、板情報、テクニカル指標` +
		`\n📌 補完ツール: get_transactions（個別約定）, get_candles（OHLCV）, get_orderbook（板情報）, analyze_indicators（指標）` +
		`\n📌 加工契約: 約定列は timestampMs 昇順 sort 済み / 重複除去キー=\`timestampMs:price:amount:side\`（transaction_id 不使用）`;

	if (bucketsMode === 'summary') {
		return baseSummary + warningLine + aggregatesLine + footer;
	}

	const fmtBucket = (b: FlowMetricsBucket, i: number) => {
		const t = bucketTimeLabel(b);
		// 欠損バケットを通常行と同じ形（buy:0 sell:0）で出すと「約定ゼロ」と誤読される
		if (b.hasData === false) return `[${i}] ${t} データなし（欠損区間）`;
		const sp = b.spike ? ` spike:${b.spike}` : '';
		return `[${i}] ${t} buy:${b.buyVolume} sell:${b.sellVolume} cvd:${b.cvd} z:${b.zscore ?? 'n/a'}${sp}`;
	};

	let bucketLines: string[];
	let label: string;
	if (bucketsMode === 'compact') {
		const { lines, shown, gapBuckets } = renderCompactBucketLines(buckets, fmtBucket);
		bucketLines = lines;
		const gapNote = gapBuckets > 0 ? `（欠損${gapBuckets}件は区間表記）` : '';
		label = `\n\n📋 非ゼロ${shown}/${buckets.length}件のバケット${gapNote} (${bucketMs}ms間隔):\n`;
	} else {
		bucketLines = buckets.map(fmtBucket);
		label = `\n\n📋 全${buckets.length}件のバケット (${bucketMs}ms間隔):\n`;
	}
	return baseSummary + warningLine + aggregatesLine + label + bucketLines.join('\n') + footer;
}

/** get_transactions の応答件数上限（public ツールの limit 上限と同値）。 */
const PUBLIC_TX_LIMIT = 1000;

/** 1 UTC 暦日の分数。date 指定時の要求スコープ（カバレッジ率の分母）。 */
const UTC_DAY_MINUTES = 24 * 60;

/** getTransactions の Result 型（date 指定パスで直接読むため） */
type TxResult = Awaited<ReturnType<typeof getTransactions>>;

/**
 * 内部集計用の約定フェッチャ。
 *
 * `get_transactions` の応答上限（1000 件）は MCP 応答のサイズ制限であってフェッチ制限では
 * ないため、集計用途では外す（`unlimited`）。本ツールの出力は時間バケット集計なので
 * 全件を集計してもトークンは増えない一方、キャップしたままだと 1 UTC 日
 * （BTC/JPY で実測 5,609〜8,040 件）の末尾 4〜5 時間分しか CVD / アグレッサー比に
 * 入らなかった。public ツール `get_transactions` 側の応答上限は変更していない。
 */
function internalTxFetcher(pair: string): TxFetcher {
	// limit は unlimited 指定時に無視されるが、万一オプションが外れても旧挙動
	// （応答上限 1000 件）へ縮退するよう public 上限を渡しておく。
	return (date) => getTransactions(pair, PUBLIC_TX_LIMIT, date, undefined, { unlimited: true });
}

export default async function getFlowMetrics(
	pair: string = 'btc_jpy',
	limit: number = 100,
	date?: string,
	bucketMs: number = 60_000,
	tz: string = 'Asia/Tokyo',
	hours?: number,
) {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk, GetFlowMetricsOutputSchema);

	try {
		let txs: Tx[];
		let fetchWarning: string | undefined;
		/** limit による切り捨ての実績（件数ベース取得時のみ）。meta と warning で申告する。 */
		let limitApplication: TxLimitApplication | undefined;
		/**
		 * 要求した時間窓（分）。カバレッジ率の分母になる。
		 * - hours 指定: hours×60 分
		 * - date 指定: 当該 UTC 暦日 = 1440 分（limit で切れた場合に「1 日のうちどれだけ見たか」が出る）
		 * - 件数ベース（date/hours なし）: 時間窓の要求が無いので undefined
		 */
		let requestedMin: number | undefined;
		const txFetcher = internalTxFetcher(chk.pair);

		if (hours != null && hours > 0) {
			// === 時間範囲ベースの取得 ===
			// 完了済み UTC 日アーカイブの列挙 + latest 補完 + dedup マージは lib/tx-fetch.ts に集約。
			// 失敗ハンドリング（全滅 fail / 部分失敗 warning）の方針は本ツール側で判断する。
			requestedMin = Math.round(hours * 60);
			const range = await fetchTxTimeRange(txFetcher, hours, { retryFailedDates: { delayMs: 500 } });
			const { currentUtcDay, dates, dateMerge, latestMerge } = range;

			// 完了済み UTC 日アーカイブ（authoritative）が全滅した場合は fail。
			// 進行中の UTC 日は fetch 対象外（アーカイブ未公開）なので、この失敗は実失敗のみ。
			// 「全滅」は失敗件数 == 要求件数で厳密に判定する（txs.length===0 をプロキシにすると、
			// 約定 0 件の日 + 一部失敗の組合せを全滅と誤分類する）。
			const historicalAllFailed = dates.length > 0 && dateMerge.failedCount === dates.length;

			if (historicalAllFailed) {
				return GetFlowMetricsOutputSchema.parse(
					fail(
						`日付ベースの取得が全て失敗しました（${dateMerge.failedCount}件: ${formatTxFailures(dateMerge.failures)}）`,
						'upstream',
					),
				);
			}

			// 時間窓が進行中の UTC 日内に収まる（アーカイブ要求なし）場合、latest が唯一のソース。
			// その latest も失敗したら取得手段なし。
			if (dates.length === 0 && latestMerge.txs.length === 0 && latestMerge.failedCount > 0) {
				return GetFlowMetricsOutputSchema.parse(
					fail(
						`取得手段がありません: 時間窓が進行中の UTC 日 (${currentUtcDay}) 内のためアーカイブは未公開で、latest 取得も失敗しました（${formatTxFailures(latestMerge.failures)}）`,
						'upstream',
					),
				);
			}

			// 部分失敗・カバレッジ制約は警告で明示（latest 失敗は直近数分の欠落、一部 date 失敗は該当日のカバレッジ不足）
			const warnMsgs: string[] = [];
			if (dateMerge.failedCount > 0) {
				warnMsgs.push(
					`⚠️ 日付ベース取得で ${dateMerge.totalCount}件中 ${dateMerge.failedCount}件失敗: ${formatTxFailures(dateMerge.failures)}`,
				);
			}
			// 進行中の UTC 日の区間はアーカイブが存在しないため、常に latest（直近約60件）のみでの補完になる
			warnMsgs.push(
				`ℹ️ 進行中の UTC 日 (${currentUtcDay}) のアーカイブは未公開のため、この区間は /transactions (latest, 直近約60件) で補完しています`,
			);
			if (latestMerge.failedCount > 0) {
				warnMsgs.push(
					`⚠️ 最新約定の補完取得に失敗 (${formatTxFailures(latestMerge.failures)}) — 直近数分のデータが欠落している可能性があります`,
				);
			}
			if (warnMsgs.length > 0) fetchWarning = warnMsgs.join('\n');

			txs = range.txs;
		} else {
			// === 件数ベース取得 ===
			const lim = validateLimit(limit, 1, 2000);
			if (!lim.ok) return failFromValidation(lim, GetFlowMetricsOutputSchema);

			if (date) {
				// 明示的な日付指定がある場合はそのまま取得。
				// /transactions/{YYYYMMDD} は UTC 暦日アーカイブで、当該 UTC 日が完了するまで未公開
				// （404）。進行中・未来の UTC 日（JST の「今日」に加え、JST 早朝は「昨日」も該当）を
				// 指定された場合は latest にフォールバックする。
				const txRes = (await txFetcher(date)) as TxResult;
				const archivePublished = isArchiveExpectedPublished(date);
				if (!txRes?.ok) {
					if (!archivePublished) {
						const latestRes = (await txFetcher()) as TxResult;
						if (!latestRes?.ok) {
							return GetFlowMetricsOutputSchema.parse(
								fail(
									`date=${date} のアーカイブは未公開（UTC 暦日完了後に公開）で、latest 取得も失敗: ${txRes?.summary || 'unknown'} / ${latestRes?.summary || 'unknown'}`,
									latestRes?.meta?.errorType || 'upstream',
								),
							);
						}
						// 加工契約: 全ての取得パスで昇順 sort を保証する。
						// 上流 getTransactions も内部 sort 済みだが、契約の単一ソースをこちらに置く。
						// 取得は無制限だが limit はユーザーの明示要求なので最新側 limit 件に切る。
						limitApplication = applyTxLimit(sortTxsAsc(latestRes.data.normalized as Tx[]), lim.value);
						txs = limitApplication.txs;
						// latest フォールバックでは要求日のデータを返していないため、requestedMin
						// （= UTC 暦日 1440 分）は設定しない。カバー率を出しても意味を成さない。
						fetchWarning = [
							`⚠️ date=${date} のアーカイブは未公開（/transactions/{YYYYMMDD} は UTC 暦日の完了後に公開）のため /transactions (latest) から取得しました`,
							buildTxTruncationWarning(limitApplication, lim.value),
						]
							.filter(Boolean)
							.join('\n');
					} else {
						return GetFlowMetricsOutputSchema.parse(
							fail(txRes?.summary || 'failed', txRes?.meta?.errorType || 'internal'),
						);
					}
				} else {
					// 加工契約: 全ての取得パスで昇順 sort を保証する。
					limitApplication = applyTxLimit(sortTxsAsc(txRes.data.normalized as Tx[]), lim.value);
					txs = limitApplication.txs;
					// 要求スコープは当該 UTC 暦日（1440 分）。limit で切れた場合、カバー率に
					// 「1 日のうちどれだけを見たか」が現れる。
					requestedMin = UTC_DAY_MINUTES;
					fetchWarning = buildTxTruncationWarning(limitApplication, lim.value, {
						scope: `date=${date}（UTC 暦日）`,
						hint: '1 UTC 日全体の集計には hours を使ってください（hours 指定時は limit を適用しません）。',
					});
				}
			} else {
				// 日付指定なし: latest で取得し、不足なら完了済み UTC 日アーカイブで補完する
				// （列挙・マージは lib/tx-fetch.ts。失敗ハンドリングの方針は本ツール側）。
				const latest = await fetchLatestTxs(txFetcher);

				if (latest.txs.length >= lim.value) {
					// 加工契約: 全ての取得パスで昇順 sort を保証する。
					limitApplication = applyTxLimit(sortTxsAsc(latest.txs), lim.value);
					txs = limitApplication.txs;
					fetchWarning = buildTxTruncationWarning(limitApplication, lim.value, { scope: '/transactions (latest)' });
				} else {
					// latest の返却数が不足（bitbank の latest エンドポイントは約60件のみ返却）
					const { merged } = await fetchSupplementTxs(txFetcher, lim.value, latest);
					// 全て失敗した場合は network エラーとして返す
					if (merged.txs.length === 0 && merged.failedCount > 0) {
						return GetFlowMetricsOutputSchema.parse(
							fail(`upstream fetch all failed (${formatTxFailures(merged.failures)})`, 'network'),
						);
					}
					// 補完は best-effort: 何かしら取得できていれば fail せず、失敗と件数不足を警告で明示する。
					// （latest 成功 + 補完失敗を「過半数失敗」として全体 fail すると、正当に取得できた
					// 直近データまで捨ててしまう。補完アーカイブは公開遅延等で 404 になり得る。）
					const warnMsgs: string[] = [];
					if (merged.failedCount > 0) {
						warnMsgs.push(
							`⚠️ ${merged.totalCount}件中 ${merged.failedCount}件のAPI取得に失敗しました: ${formatTxFailures(merged.failures)}`,
						);
					}
					limitApplication = applyTxLimit(sortTxsAsc(merged.txs), lim.value);
					txs = limitApplication.txs;
					const truncationWarning = buildTxTruncationWarning(limitApplication, lim.value, {
						scope: 'latest + 完了済み UTC 日アーカイブ',
					});
					if (truncationWarning) warnMsgs.push(truncationWarning);
					if (txs.length < lim.value) {
						warnMsgs.push(
							`ℹ️ 要求 ${lim.value}件に対し取得できたのは ${txs.length}件です（進行中の UTC 日のアーカイブは未公開のため取得不可）`,
						);
					}
					if (warnMsgs.length > 0) fetchWarning = warnMsgs.join('\n');
				}
			}
		}
		if (!Array.isArray(txs) || txs.length === 0) {
			return GetFlowMetricsOutputSchema.parse(
				ok(
					'no transactions',
					{
						source: 'transactions',
						params: { bucketMs },
						aggregates: {
							totalTrades: 0,
							buyTrades: 0,
							sellTrades: 0,
							buyVolume: 0,
							sellVolume: 0,
							netVolume: 0,
							aggressorRatio: 0,
							finalCvd: 0,
						},
						series: { buckets: [] },
					},
					createMeta(chk.pair, { count: 0, bucketMs }),
				),
			);
		}

		// 実カバー区間 / 欠損区間。バケット分割より前に求める（欠損バケットの判定に使う）。
		const coverage = computeTxCoverage(txs);

		// バケット分割
		const t0 = txs[0].timestampMs;
		const buckets: Array<{
			ts: number;
			buys: number;
			sells: number;
			vBuy: number;
			vSell: number;
			hasData: boolean;
		}> = [];
		const idx = (ms: number) => Math.floor((ms - t0) / bucketMs);
		for (const t of txs) {
			const k = idx(t.timestampMs);
			while (buckets.length <= k)
				buckets.push({ ts: t0 + buckets.length * bucketMs, buys: 0, sells: 0, vBuy: 0, vSell: 0, hasData: true });
			if (t.side === 'buy') {
				buckets[k].buys++;
				buckets[k].vBuy += t.amount;
			} else {
				buckets[k].sells++;
				buckets[k].vSell += t.amount;
			}
		}

		// 欠損区間に完全に含まれるバケットは「約定ゼロ」ではなく「データなし」。
		// 両者を混同すると (a) ゼロ埋めが Z スコアの母集団に入って歪む、(b) 応答上
		// 「閑散だった」と「取得できていない」が区別できない、の 2 つの誤読を生む。
		for (const b of buckets) {
			if (b.buys === 0 && b.sells === 0 && isGapRange(coverage, b.ts, b.ts + bucketMs)) {
				b.hasData = false;
			}
		}

		// CVD とスパイク
		const outBuckets: FlowMetricsBucket[] = [];
		let cvd = 0;
		// 平均・分散は**データのあるバケットのみ**から求める。欠損区間のゼロ埋めを母集団に
		// 入れると平均が押し下げられ、欠損明けの通常バケットが偽スパイクとして検出される。
		const vols = buckets.filter((b) => b.hasData).map((b) => b.vBuy + b.vSell);
		const mean = vols.reduce((a, b) => a + b, 0) / Math.max(1, vols.length);
		const variance = vols.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, vols.length);
		const stdev = Math.sqrt(variance);
		const spikeLevel = (z: number): 'notice' | 'warning' | 'strong' | null => {
			if (!Number.isFinite(z)) return null;
			if (z >= 3) return 'strong';
			if (z >= 2) return 'warning';
			if (z >= 1.5) return 'notice';
			return null;
		};

		for (const b of buckets) {
			const vol = b.vBuy + b.vSell;
			// 欠損バケットは vBuy/vSell とも 0 なので CVD は据え置きで引き継がれる（正しい）。
			cvd += b.vBuy - b.vSell;
			// 欠損バケットに Z スコアは定義できない（観測が無い）。0 でも負値でもなく null。
			const z = b.hasData ? (stdev > 0 ? (vol - mean) / stdev : 0) : null;
			const ts = b.ts + bucketMs - 1;
			outBuckets.push({
				timestampMs: ts,
				isoTime: toIsoTime(ts) ?? '',
				isoTimeJST: toIsoWithTz(ts, tz) ?? undefined,
				displayTime: toDisplayTime(ts, tz) ?? undefined,
				buyVolume: Number(b.vBuy.toFixed(8)),
				sellVolume: Number(b.vSell.toFixed(8)),
				totalVolume: Number(vol.toFixed(8)),
				cvd: Number(cvd.toFixed(8)),
				zscore: z != null && Number.isFinite(z) ? Number(z.toFixed(2)) : null,
				spike: z != null ? spikeLevel(z) : null,
				hasData: b.hasData,
			});
		}

		const totalTrades = txs.length;
		const buyTrades = txs.filter((t) => t.side === 'buy').length;
		const sellTrades = totalTrades - buyTrades;
		const buyVolume = txs.filter((t) => t.side === 'buy').reduce((s, t) => s + t.amount, 0);
		const sellVolume = txs.filter((t) => t.side === 'sell').reduce((s, t) => s + t.amount, 0);
		const netVolume = buyVolume - sellVolume;
		const aggressorRatio = totalTrades > 0 ? Number((buyTrades / totalTrades).toFixed(3)) : 0;

		// 実際の取得範囲を計算。
		// 先頭〜末尾の単純差分（span）だけを申告すると、アーカイブ未公開区間などの穴を
		// 「カバー済み」に見せてしまうため、実データがある区間の合計も併せて出す。
		const actualStartMs = txs[0]?.timestampMs;
		const actualEndMs = txs[txs.length - 1]?.timestampMs;
		const actualDurationMin = coverage?.spanMinutes ?? 0;

		// 取得層の注記（meta.warning）: 取得失敗・アーカイブ未公開区間・カバレッジ欠損。
		// 旧実装の「直近約N分間分です。直近フローとして扱ってください」は、変えられない制約
		// （進行中 UTC 日は latest 約60件のみ）と、直せる制約（アーカイブ側の 1000 件切り捨て）を
		// 同じ文言で覆い隠していた。後者はキャップ解除で解消したので、残る欠損を実測値で出す。
		const warnings: string[] = [];
		if (fetchWarning) warnings.push(fetchWarning);
		const coverageWarning = buildTxCoverageWarning(coverage, { requestedMinutes: requestedMin, tz });
		if (coverageWarning) warnings.push(coverageWarning);
		const dataWarning = warnings.length > 0 ? warnings.join('\n') : undefined;

		// 計算層の注記（meta.warnings）: 集計値が欠損を含む区間から算出されている事実。
		// 取得層（上記 dataWarning）とは別系統で出す（.claude/rules/tools.md）。
		const calcWarnings: string[] =
			coverage && coverage.gaps.length > 0
				? [buildAggregateCoverageNote(coverage, '集計値（totalTrades / CVD / アグレッサー比 / スパイク Z スコア）')]
				: [];

		// summary / content には 2 系統を別行で並べる（meta では別フィールド）
		const summaryNote =
			[...(dataWarning ? [dataWarning] : []), ...calcWarnings.map((w) => `⚠️ ${w}`)].join('\n') || undefined;

		// スパイク情報を集計（spike が null でないものをフィルタ）
		const spikes = outBuckets.filter((b) => b.spike !== null);
		let spikeInfo = '';
		if (spikes.length > 0) {
			const spikeDetails = spikes
				.slice(0, 3)
				.map((s) => {
					const time = s.displayTime || s.isoTime || '';
					const level = s.spike === 'strong' ? '🚨強' : s.spike === 'warning' ? '⚠️中' : '📈弱';
					const direction = s.cvd > 0 ? '買い' : '売り';
					return `${time}(${level}${direction})`;
				})
				.join(', ');
			spikeInfo = ` | スパイク${spikes.length}件: ${spikeDetails}`;
		} else {
			spikeInfo = ' | スパイクなし';
		}

		// 欠損がある場合は「スパン◯分」だけでなく実カバー分も出す（穴をカバー済みと申告しない）
		const coverageLabel =
			coverage && coverage.gaps.length > 0
				? `スパン${coverage.spanMinutes}分/実カバー${coverage.coveredMinutes}分`
				: `${actualDurationMin}分間`;
		const rangeLabel =
			actualStartMs && actualEndMs
				? ` (${toDisplayTime(actualStartMs, tz) ?? '?'}〜${toDisplayTime(actualEndMs, tz) ?? '?'}, ${coverageLabel})`
				: '';
		const baseSummary = formatSummary({
			pair: chk.pair,
			latest: txs.at(-1)?.price,
			extra: `trades=${totalTrades} buy%=${(aggressorRatio * 100).toFixed(1)} CVD=${cvd.toFixed(2)}${spikeInfo}${rangeLabel}`,
		});
		// NOTE: 形成中足（provisional）注記は対象外。
		// 本ツールは OHLC ローソク足ではなく約定（transactions）を時間バケットに集計するため、
		// 「最新足が未確定（形成中）」という概念が存在しない（lib/provisional-bar.ts の対象外）。
		// 最新バケットの不完全性は別系統で扱う:
		//   - カバレッジ欠損 → dataWarning（取得層 meta.warning, ℹ️）
		//   - 取得失敗 → fetchWarning（取得層 meta.warning, ⚠️）
		//   - 集計値が欠損区間を含む → calcWarnings（計算層 meta.warnings）
		// これらは OHLC ローソク足の provisional 注記（最新足が形成中）とは別物。本ツールに provisional 注記は付けない。
		// Result の summary は "summary" モード（集計値のみ、バケット行なし）。
		// 呼び出し側 (handler) が view に応じて content テキストを差し替える。
		const summary = buildFlowMetricsText({
			baseSummary,
			dataWarning: summaryNote,
			totalTrades,
			buyVolume,
			sellVolume,
			netVolume,
			aggressorRatio,
			cvd,
			buckets: outBuckets,
			bucketMs,
			bucketsMode: 'summary',
		});

		const data = {
			source: 'transactions' as const,
			params: { bucketMs },
			aggregates: {
				totalTrades,
				buyTrades,
				sellTrades,
				buyVolume: Number(buyVolume.toFixed(8)),
				sellVolume: Number(sellVolume.toFixed(8)),
				netVolume: Number(netVolume.toFixed(8)),
				aggressorRatio,
				finalCvd: Number(cvd.toFixed(8)),
			},
			series: { buckets: outBuckets },
		};

		const offsetMin = dayjs().utcOffset();
		const offset = `${offsetMin >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, '0')}:${String(Math.abs(offsetMin) % 60).padStart(2, '0')}`;
		const metaExtra: Record<string, unknown> = {
			count: totalTrades,
			bucketMs,
			timezone: tz,
			timezoneOffset: offset,
			serverTime: toIsoWithTz(Date.now(), tz) ?? undefined,
		};
		if (hours != null) {
			metaExtra.hours = hours;
			metaExtra.mode = 'time_range';
		}
		if (coverage) {
			const fmtRange = (ms: number) => toIsoWithTz(ms, tz) ?? toIsoTime(ms);
			metaExtra.actualRange = {
				start: fmtRange(coverage.startMs),
				end: fmtRange(coverage.endMs),
				// durationMinutes は先頭〜末尾のスパン（欠損を含む）。カバー済み時間は coveredMinutes。
				durationMinutes: coverage.spanMinutes,
				coveredMinutes: coverage.coveredMinutes,
				gapMinutes: coverage.gapMinutes,
				segments: coverage.segments.length,
				...(requestedMin != null
					? {
							requestedMinutes: requestedMin,
							coveragePct: Number(((coverage.coveredMinutes / requestedMin) * 100).toFixed(1)),
						}
					: {}),
				// 欠損区間は長い順に最大 3 件だけ載せる（件数が多いと structuredContent が膨らむ）
				...(coverage.gaps.length > 0
					? {
							gaps: [...coverage.gaps]
								.sort((a, b) => b.durationMinutes - a.durationMinutes)
								.slice(0, 3)
								.map((g) => ({
									start: fmtRange(g.startMs),
									end: fmtRange(g.endMs),
									durationMinutes: g.durationMinutes,
								})),
						}
					: {}),
			};
		}
		if (dataWarning) {
			metaExtra.warning = dataWarning;
		}
		if (calcWarnings.length > 0) {
			metaExtra.warnings = calcWarnings;
		}
		// limit による切り捨ての明示（get_transactions の totalFetched / truncated と対応）。
		// 黙って切ると集計値・カバレッジが部分データ由来であることが応答から分からない。
		if (limitApplication) {
			metaExtra.totalAvailable = limitApplication.totalAvailable;
			metaExtra.truncated = limitApplication.truncated;
		}
		const meta = createMeta(chk.pair, metaExtra);
		return GetFlowMetricsOutputSchema.parse(ok(summary, data, meta));
	} catch (e: unknown) {
		return failFromError(e, { schema: GetFlowMetricsOutputSchema });
	}
}

// ── MCP ツール定義（tool-registry から自動収集） ──
export const toolDef: ToolDefinition = {
	name: 'get_flow_metrics',
	description:
		`[Flow / CVD / Buy-Sell Pressure] 資金フロー分析（flow / CVD / aggressor ratio / buy-sell pressure）。約定データからCVD・アグレッサー比・スパイクを検出。hours（推奨）で時間範囲指定、または limit で件数指定。` +
		`\n\nデータソース制約（bitbank 側仕様）: 約定アーカイブ /transactions/{YYYYMMDD} は UTC 暦日単位で、当該 UTC 日の完了後にのみ公開される。完了済み UTC 日は**全件**（1日あたり数千件）を集計に使う。進行中の UTC 日（JST 09:00 で切り替わる）の約定は /transactions (latest, 直近約60件) でしか取得できないため、当日区間のカバレッジは限定的（warning で明示される）。` +
		`\n\nカバレッジ申告: meta.actualRange は durationMinutes（先頭〜末尾のスパン）に加えて coveredMinutes（実データがある区間の合計）/ gapMinutes / gaps を返す。欠損があれば meta.warning（取得層）と meta.warnings（計算層: 集計値がカバー区間のみ由来である旨）で明示される。` +
		`\n\n加工契約:` +
		`\n- 内部で使用する約定列は、取得パスに関わらず timestampMs 昇順にソート済み。` +
		`\n- latest と date ベースをマージする場合、重複除去キーは \`timestampMs:price:amount:side\`（transaction_id は使用しない: 同一約定でも上流エンドポイント間で ID が一致しないケースがあるため）。`,
	inputSchema: GetFlowMetricsInputSchema,
	handler: async ({
		pair,
		limit,
		date,
		bucketMs,
		view,
		bucketsN,
		tz,
		hours,
	}: {
		pair?: string;
		limit?: number;
		date?: string;
		bucketMs?: number;
		view?: 'summary' | 'compact' | 'buckets' | 'full';
		bucketsN?: number;
		tz?: string;
		hours?: number;
	}) => {
		const res = await getFlowMetrics(
			pair,
			Number(limit),
			date,
			Number(bucketMs),
			tz,
			hours != null ? Number(hours) : undefined,
		);
		if (!res?.ok) return res;

		const effectiveView = view ?? 'summary';
		const buckets = (res?.data?.series?.buckets ?? []) as FlowMetricsBucket[];

		// view=summary: バケットを structuredContent からも除外してトークン消費を抑える
		if (effectiveView === 'summary') {
			const { buckets: _omit, ...restSeries } = (res.data.series ?? {}) as { buckets?: unknown };
			const data = { ...res.data, series: restSeries } as typeof res.data;
			const trimmed = { ...res, data };
			return { content: [{ type: 'text', text: res.summary }], structuredContent: trimmed as Record<string, unknown> };
		}

		// 欠損バケットを通常行と同じ形（buy=0 sell=0）で出すと「約定ゼロ」と誤読される
		const fmt = (b: FlowMetricsBucket) =>
			b.hasData === false
				? `${b.displayTime || b.isoTime}  データなし（欠損区間）`
				: `${b.displayTime || b.isoTime}  buy=${b.buyVolume} sell=${b.sellVolume} total=${b.totalVolume} cvd=${b.cvd}${b.spike ? ` spike=${b.spike}` : ''}`;

		// view=compact: 非ゼロバケットのみ。ただし欠損バケットは落とさない
		// （落とすと欠損区間が応答から消え、「閑散だった」と誤読される）。
		if (effectiveView === 'compact') {
			const kept = buckets.filter((b) => b.buyVolume > 0 || b.sellVolume > 0 || b.hasData === false);
			const data = {
				...res.data,
				series: { ...res.data.series, buckets: kept },
			} as typeof res.data;
			const trimmed = { ...res, data };
			const { lines, shown, gapBuckets } = renderCompactBucketLines(buckets, fmt);
			const gapNote = gapBuckets > 0 ? ` (+${gapBuckets} no-data buckets shown as ranges)` : '';
			const text = `${res.summary}\n\nNon-zero ${shown}/${buckets.length} buckets${gapNote}:\n${lines.join('\n')}`;
			return { content: [{ type: 'text', text }], structuredContent: trimmed as Record<string, unknown> };
		}

		const agg = res?.data?.aggregates ?? {};
		const n = Number(bucketsN ?? 10);
		const last = buckets.slice(-n);
		const actualRange = res?.meta?.actualRange;
		// スパン（穴を含む）と実カバー時間を必ず並記する。durationMinutes だけを出すと
		// 欠損区間をカバー済みとして申告することになる。
		const rangeStr = actualRange
			? ` 実取得範囲: ${actualRange.start}〜${actualRange.end}（スパン${actualRange.durationMinutes}分 / 実カバー${actualRange.coveredMinutes}分${
					actualRange.gapMinutes > 0 ? `, 欠損${actualRange.gapMinutes}分` : ''
				}${actualRange.requestedMinutes != null ? ` / 要求${actualRange.requestedMinutes}分` : ''}）`
			: '';
		// 取得層 (meta.warning) と計算層 (meta.warnings) は別行で出す（.claude/rules/tools.md）。
		// 各行は本体側で ℹ️ / ⚠️ を付与済みなので、ここでは prefix を触らない。
		const metaWarnings = (res?.meta as { warnings?: string[] })?.warnings ?? [];
		const warnLines = [...(res?.meta?.warning ? [res.meta.warning] : []), ...metaWarnings.map((w) => `⚠️ ${w}`)];
		const warnStr = warnLines.length > 0 ? `\n${warnLines.join('\n')}` : '';
		let text = `${String(pair).toUpperCase()} Flow Metrics (bucketMs=${res?.data?.params?.bucketMs ?? bucketMs})${rangeStr}\n`;
		text += `Totals: trades=${agg.totalTrades} buyVol=${agg.buyVolume} sellVol=${agg.sellVolume} net=${agg.netVolume} buy%=${(agg.aggressorRatio * 100 || 0).toFixed(1)} CVD=${agg.finalCvd}${warnStr}`;
		if (effectiveView === 'buckets') {
			text += `\n\nRecent ${last.length} buckets:\n${last.map(fmt).join('\n')}`;
			return { content: [{ type: 'text', text }], structuredContent: res as Record<string, unknown> };
		}
		text += `\n\nAll buckets:\n${buckets.map(fmt).join('\n')}`;
		return { content: [{ type: 'text', text }], structuredContent: res as Record<string, unknown> };
	},
};
