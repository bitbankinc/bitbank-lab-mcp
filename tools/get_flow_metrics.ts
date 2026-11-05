import type { z } from 'zod';
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
	hasCoverageShortfall,
	isGapRange,
	resolveTxTimeRange,
	sortTxsAsc,
	type Tx,
	type TxLimitApplication,
	type TxTimeRangeResolved,
	unlimitedTxFetcher,
} from '../lib/tx-fetch.js';
import { createMeta, ensurePair, validateLimit } from '../lib/validate.js';
import {
	GetFlowMetricsInputSchema,
	GetFlowMetricsOutputSchema,
	MAX_TX_COUNT_LIMIT,
	MAX_TX_RANGE_DAYS,
} from '../src/schemas.js';
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
	/** false は約定ゼロではなく欠損区間。表示層の入力では省略を許すので、判定は必ず === false で行う。 */
	hasData?: boolean;
}

function bucketTimeLabel(b: FlowMetricsBucket): string {
	return b.displayTime || b.isoTimeJST || b.isoTime || '?';
}

// 非ゼロだけにフィルタすると欠損区間が黙って消え「閑散だった」と誤読されるので、欠損は区間として残す。
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

// リテラルを手書きせず Zod から導出する（enum から alias を消したとき、残った alias 分岐が型エラーになる。tools.md §7）。
export type FlowMetricsView = NonNullable<z.infer<typeof GetFlowMetricsInputSchema>['view']>;

export type FlowMetricsCanonicalView = 'summary' | 'detailed' | 'full';

// 正規化はハンドラ入口の 1 箇所だけで行う（alias を各分岐に散らすと削除時に取りこぼす）。compact + nonZeroOnly=false は自己矛盾なので写像の値を優先する。
export function normalizeFlowMetricsView(
	view: FlowMetricsView | undefined,
	nonZeroOnly: boolean | undefined,
): { view: FlowMetricsCanonicalView; nonZeroOnly: boolean } {
	if (view === 'compact') return { view: 'full', nonZeroOnly: true };
	if (view === 'buckets') return { view: 'detailed', nonZeroOnly: false };
	return { view: view ?? 'summary', nonZeroOnly: nonZeroOnly === true };
}

// 必ず renderCompactBucketLines を通し、見出しも旧 compact と同一文言にする（旧値経由のバケット行を 1 バイトも変えない）。
function renderNonZeroSection(
	buckets: FlowMetricsBucket[],
	fmt: (b: FlowMetricsBucket, index: number) => string,
	view: FlowMetricsCanonicalView,
): string {
	const { lines, shown, gapBuckets } = renderCompactBucketLines(buckets, fmt);
	const gapNote = gapBuckets > 0 ? ` (+${gapBuckets} no-data buckets shown as ranges)` : '';
	const heading =
		view === 'detailed'
			? `Recent ${buckets.length} buckets, non-zero ${shown}${gapNote}`
			: `Non-zero ${shown}/${buckets.length} buckets${gapNote}`;
	return `${heading}:\n${lines.join('\n')}`;
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

const UTC_DAY_MINUTES = 24 * 60;

type TxResult = Awaited<ReturnType<typeof getTransactions>>;

export default async function getFlowMetrics(
	pair: string = 'btc_jpy',
	limit: number = 100,
	date?: string,
	bucketMs: number = 60_000,
	tz: string = 'Asia/Tokyo',
	hours?: number,
	range?: { since?: string; until?: string },
) {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk, GetFlowMetricsOutputSchema);

	try {
		let txs: Tx[];
		let fetchWarning: string | undefined;
		let limitApplication: TxLimitApplication | undefined;
		let requestedMin: number | undefined;
		let resolvedRange: TxTimeRangeResolved | undefined;
		const txFetcher = unlimitedTxFetcher(getTransactions, chk.pair);
		const since = range?.since;
		const until = range?.until;

		if (since != null || until != null || (hours != null && hours > 0)) {
			const resolved = resolveTxTimeRange({ since, until, hours, date });
			if (!resolved.ok) return failFromValidation(resolved, GetFlowMetricsOutputSchema);
			resolvedRange = resolved;
			requestedMin = resolved.requestedMinutes;
			const fetched = await fetchTxTimeRange(txFetcher, resolved, {
				nowMs: resolved.nowMs,
				retryFailedDates: { delayMs: 500 },
			});
			const { currentUtcDay, dates, dateMerge, latestMerge } = fetched;

			// 全滅は失敗件数 == 要求件数で判定する（txs.length===0 だと約定 0 件の日 + 一部失敗を全滅と誤分類する）。
			const historicalAllFailed = dates.length > 0 && dateMerge.failedCount === dates.length;

			if (historicalAllFailed) {
				return GetFlowMetricsOutputSchema.parse(
					fail(
						`日付ベースの取得が全て失敗しました（${dateMerge.failedCount}件: ${formatTxFailures(dateMerge.failures)}）`,
						'upstream',
					),
				);
			}

			if (dates.length === 0 && latestMerge.txs.length === 0 && latestMerge.failedCount > 0) {
				return GetFlowMetricsOutputSchema.parse(
					fail(
						`取得手段がありません: 時間窓が進行中の UTC 日 (${currentUtcDay}) 内のためアーカイブは未公開で、latest 取得も失敗しました（${formatTxFailures(latestMerge.failures)}）`,
						'upstream',
					),
				);
			}

			const warnMsgs: string[] = [];
			if (dateMerge.failedCount > 0) {
				warnMsgs.push(
					`⚠️ 日付ベース取得で ${dateMerge.totalCount}件中 ${dateMerge.failedCount}件失敗: ${formatTxFailures(dateMerge.failures)}`,
				);
			}
			if (fetched.usedLatest) {
				warnMsgs.push(
					`ℹ️ 進行中の UTC 日 (${currentUtcDay}) のアーカイブは未公開のため、この区間は /transactions (latest, 直近約60件) で補完しています`,
				);
			}
			if (latestMerge.failedCount > 0) {
				warnMsgs.push(
					`⚠️ 最新約定の補完取得に失敗 (${formatTxFailures(latestMerge.failures)}) — 直近数分のデータが欠落している可能性があります`,
				);
			}
			if (warnMsgs.length > 0) fetchWarning = warnMsgs.join('\n');

			txs = fetched.txs;
		} else if (date) {
			// date 指定でも limit は適用しない（1 UTC 日の全件を集計する。limit を掛けるとその日の末尾側しか入らない）。
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
					// 加工契約: 全ての取得パスで昇順 sort を保証する（上流も sort 済みだが契約の単一ソースはこちら）。
					// latest フォールバックでも limit は適用しない（アーカイブの公開タイミングで limit が効いたり効かなかったりする非決定的な挙動を避ける）。
					txs = sortTxsAsc(latestRes.data.normalized as Tx[]);
					// latest フォールバックは要求日のデータではないので requestedMin を設定しない。
					fetchWarning =
						`⚠️ date=${date} のアーカイブは未公開（/transactions/{YYYYMMDD} は UTC 暦日の完了後に公開）のため ` +
						`/transactions (latest, 直近約60件) から取得しました。要求した UTC 暦日の全件ではありません`;
				} else {
					return GetFlowMetricsOutputSchema.parse(
						fail(txRes?.summary || 'failed', txRes?.meta?.errorType || 'internal'),
					);
				}
			} else {
				txs = sortTxsAsc(txRes.data.normalized as Tx[]);
				requestedMin = UTC_DAY_MINUTES;
			}
		} else {
			// limit が効くのはこの経路だけ。
			const lim = validateLimit(limit, 1, MAX_TX_COUNT_LIMIT);
			if (!lim.ok) return failFromValidation(lim, GetFlowMetricsOutputSchema);

			const latest = await fetchLatestTxs(txFetcher);

			if (latest.txs.length >= lim.value) {
				limitApplication = applyTxLimit(sortTxsAsc(latest.txs), lim.value);
				txs = limitApplication.txs;
				fetchWarning = buildTxTruncationWarning(limitApplication, lim.value, { scope: '/transactions (latest)' });
			} else {
				const { merged } = await fetchSupplementTxs(txFetcher, lim.value, latest);
				if (merged.txs.length === 0 && merged.failedCount > 0) {
					return GetFlowMetricsOutputSchema.parse(
						fail(`upstream fetch all failed (${formatTxFailures(merged.failures)})`, 'network'),
					);
				}
				// 補完は best-effort。取得できた直近データまで捨てないよう、補完失敗では fail せず警告で明示する（補完アーカイブは公開遅延等で 404 になりうる）。
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

		// バケット分割より前に求める（欠損バケットの判定に使う）。
		const coverage = computeTxCoverage(txs);

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

		for (const b of buckets) {
			if (b.buys === 0 && b.sells === 0 && isGapRange(coverage, b.ts, b.ts + bucketMs)) {
				b.hasData = false;
			}
		}

		const outBuckets: FlowMetricsBucket[] = [];
		let cvd = 0;
		// 平均・分散はデータのあるバケットだけから求める（ゼロ埋めを入れると欠損明けが偽スパイクになる）。
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

		const actualStartMs = txs[0]?.timestampMs;
		const actualEndMs = txs[txs.length - 1]?.timestampMs;
		const actualDurationMin = coverage?.spanMinutes ?? 0;

		const warnings: string[] = [];
		if (fetchWarning) warnings.push(fetchWarning);
		const coverageWarning = buildTxCoverageWarning(coverage, { requestedMinutes: requestedMin, tz });
		if (coverageWarning) warnings.push(coverageWarning);
		const dataWarning = warnings.length > 0 ? warnings.join('\n') : undefined;

		const coverageIncomplete =
			coverage != null && (coverage.gaps.length > 0 || hasCoverageShortfall(coverage, requestedMin));
		const calcWarnings: string[] =
			coverage && coverageIncomplete
				? [
						buildAggregateCoverageNote(
							coverage,
							'集計値（totalTrades / CVD / アグレッサー比 / スパイク Z スコア）',
							requestedMin,
						),
					]
				: [];

		const summaryNote =
			[...(dataWarning ? [dataWarning] : []), ...calcWarnings.map((w) => `⚠️ ${w}`)].join('\n') || undefined;

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
		// 約定を時間バケットに集計するツールなので形成中足（provisional）の注記は付けない（lib/provisional-bar.ts の対象外）。
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
		if (resolvedRange?.mode === 'absolute') {
			metaExtra.mode = 'absolute_range';
			metaExtra.range = { since: resolvedRange.sinceIso, until: resolvedRange.untilIso };
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

export const toolDef: ToolDefinition = {
	name: 'get_flow_metrics',
	description:
		`[Flow / CVD / Buy-Sell Pressure] 資金フロー分析（flow / CVD / aggressor ratio / buy-sell pressure）。約定データからCVD・アグレッサー比・スパイクを検出。直近フローは hours（現在時刻起点）、過去の特定区間は since/until（絶対時刻）、件数指定は limit。` +
		`\n\n期間指定の使い分け:` +
		`\n- **hours**: 現在時刻起点の相対窓（最大24h）。「直近N時間」の分析用。` +
		`\n- **since / until**: オフセット付き ISO8601 の絶対時刻区間（例: since=2026-08-01T00:00:00Z, until=2026-08-02T00:00:00Z）。**過去の特定区間を全件**集計する唯一の手段。until は排他（[since, until)）で省略時は現在時刻まで。最大 ${MAX_TX_RANGE_DAYS} 日。limit は適用しない。` +
		`\n- **date**: UTC 暦日 1 日（YYYYMMDD）。当該 UTC 日の**全件**（5,600〜8,000 件）を集計する。limit は適用しない。UTC 暦日ちょうどを指定する簡便手段なので、複数日にまたがる区間や UTC 暦日の境界に揃わない区間（例: JST の 1 日）には since/until を使うこと。` +
		`\n- **limit**: date / hours / since・until の**いずれも指定しない件数ベース取得（直近 N 件）でのみ有効**（上限 ${MAX_TX_COUNT_LIMIT} 件 ≒ BTC/JPY で 6〜8.5 時間分）。区間指定と併用しても無視される。それより長い窓は件数ではなく hours / since・until で指定すること。` +
		`\n- **since/until は hours とも date とも併用不可**（併用すると user エラー）。暗黙の優先順位を置くと、要求と異なる区間の集計値が無言で返るため。なお hours と date の同時指定だけは従来どおりエラーにせず hours が優先される（date は無視される）。` +
		`\n- since/until に YYYYMMDD 形式は使えない。暦日の基準がツール間で割れている（本ツールの date は UTC 暦日、get_candles の date は tz 引数の暦日）ため、絶対時刻はオフセット必須の ISO8601 のみ受け付ける。` +
		`\n\nデータソース制約（bitbank 側仕様）: 約定アーカイブ /transactions/{YYYYMMDD} は UTC 暦日単位で、当該 UTC 日の完了後にのみ公開される。完了済み UTC 日は**全件**（1日あたり数千件）を集計に使う。進行中の UTC 日（JST 09:00 で切り替わる）の約定は /transactions (latest, 直近約60件) でしか取得できないため、当日区間のカバレッジは限定的（warning で明示される）。` +
		`\n\nカバレッジ申告: meta.actualRange は durationMinutes（先頭〜末尾のスパン）に加えて coveredMinutes（実データがある区間の合計）/ gapMinutes / gaps を返す。requestedMinutes（要求区間）に対する coveragePct が出るので、要求どおり取れたかは常にこの値で確認できる。欠損があれば meta.warning（取得層）と meta.warnings（計算層: 集計値がカバー区間のみ由来である旨）で明示される。完了済み UTC 日のみの区間なら coveragePct はほぼ 100%、進行中 UTC 日にかかる区間は latest 約60件ぶんまで下がる。` +
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
		nonZeroOnly,
		bucketsN,
		tz,
		hours,
		since,
		until,
	}: {
		pair?: string;
		limit?: number;
		date?: string;
		bucketMs?: number;
		view?: FlowMetricsView;
		nonZeroOnly?: boolean;
		bucketsN?: number;
		tz?: string;
		hours?: number;
		since?: string;
		until?: string;
	}) => {
		const res = await getFlowMetrics(
			pair,
			Number(limit),
			date,
			Number(bucketMs),
			tz,
			hours != null ? Number(hours) : undefined,
			{ since, until },
		);
		if (!res?.ok) return res;

		const { view: effectiveView, nonZeroOnly: effectiveNonZeroOnly } = normalizeFlowMetricsView(view, nonZeroOnly);
		const buckets = (res?.data?.series?.buckets ?? []) as FlowMetricsBucket[];

		// view は content だけを変え、structuredContent は変えない（tools.md 規約 2）。出口で宣言スキーマを通し、view 分岐が structuredContent を加工したら CI で落とす（parse は冪等）。
		const structuredContent = GetFlowMetricsOutputSchema.parse(res) as Record<string, unknown>;

		// nonZeroOnly は view=summary では no-op でエラーにしない（量と絞り込みは直交する軸）。
		if (effectiveView === 'summary') {
			return { content: [{ type: 'text', text: res.summary }], structuredContent };
		}

		const fmt = (b: FlowMetricsBucket) =>
			b.hasData === false
				? `${b.displayTime || b.isoTime}  データなし（欠損区間）`
				: `${b.displayTime || b.isoTime}  buy=${b.buyVolume} sell=${b.sellVolume} total=${b.totalVolume} cvd=${b.cvd}${b.spike ? ` spike=${b.spike}` : ''}`;

		// res.summary をベースにする（組み直すと上位 view でフッタ等が消える。tools.md 規約 3）。
		const agg = res?.data?.aggregates ?? {};
		const actualRange = res?.meta?.actualRange;
		const rangeStr = actualRange
			? ` 実取得範囲: ${actualRange.start}〜${actualRange.end}（スパン${actualRange.durationMinutes}分 / 実カバー${actualRange.coveredMinutes}分${
					actualRange.gapMinutes > 0 ? `, 欠損${actualRange.gapMinutes}分` : ''
				}${actualRange.requestedMinutes != null ? ` / 要求${actualRange.requestedMinutes}分` : ''}）`
			: '';
		// warning 行はここで重ねない（res.summary が同じ 2 系統を既に含む）。
		const bucketHeader =
			`${String(pair).toUpperCase()} Flow Metrics (bucketMs=${res?.data?.params?.bucketMs ?? bucketMs})${rangeStr}\n` +
			`Totals: trades=${agg.totalTrades} buyVol=${agg.buyVolume} sellVol=${agg.sellVolume} net=${agg.netVolume} buy%=${(agg.aggressorRatio * 100 || 0).toFixed(1)} CVD=${agg.finalCvd}`;

		const shownBuckets = effectiveView === 'detailed' ? buckets.slice(-Number(bucketsN ?? 10)) : buckets;
		const body = effectiveNonZeroOnly
			? renderNonZeroSection(shownBuckets, fmt, effectiveView)
			: `${effectiveView === 'detailed' ? `Recent ${shownBuckets.length} buckets` : 'All buckets'}:\n${shownBuckets.map(fmt).join('\n')}`;
		const text = `${res.summary}\n\n${bucketHeader}\n\n${body}`;
		return { content: [{ type: 'text', text }], structuredContent };
	},
};
