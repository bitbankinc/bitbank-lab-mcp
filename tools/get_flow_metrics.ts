import { dayjs, toDisplayTime, toIsoTime, toIsoWithTz } from '../lib/datetime.js';
import { formatSummary } from '../lib/formatter.js';
import { fail, failFromError, failFromValidation, ok } from '../lib/result.js';
import { createMeta, ensurePair, validateLimit } from '../lib/validate.js';
import { GetFlowMetricsInputSchema, GetFlowMetricsOutputSchema } from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import getTransactions from './get_transactions.js';

type Tx = { price: number; amount: number; side: 'buy' | 'sell'; timestampMs: number; isoTime: string };

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

	const displayBuckets =
		bucketsMode === 'compact' ? buckets.filter((b) => b.buyVolume > 0 || b.sellVolume > 0) : buckets;
	const bucketLines = displayBuckets.map((b, i) => {
		const t = b.displayTime || b.isoTimeJST || b.isoTime || '?';
		const sp = b.spike ? ` spike:${b.spike}` : '';
		return `[${i}] ${t} buy:${b.buyVolume} sell:${b.sellVolume} cvd:${b.cvd} z:${b.zscore ?? 'n/a'}${sp}`;
	});
	const label =
		bucketsMode === 'compact'
			? `\n\n📋 非ゼロ${displayBuckets.length}/${buckets.length}件のバケット (${bucketMs}ms間隔):\n`
			: `\n\n📋 全${displayBuckets.length}件のバケット (${bucketMs}ms間隔):\n`;
	return baseSummary + warningLine + aggregatesLine + label + bucketLines.join('\n') + footer;
}

type FetchFailure = { label: string; errorType: string; message: string };

type TxResultLike = {
	ok?: boolean;
	data?: { normalized?: Tx[] };
	summary?: string;
	meta?: { errorType?: string };
} | null;

/**
 * 複数の getTransactions 結果をマージし重複を除去する（失敗詳細も返す）。
 *
 * 重複除去キー: `timestampMs:price:amount:side`
 *   - bitbank の `/transactions` (latest) と `/transactions/{date}` で同じ約定の
 *     `transaction_id` が一致しないケースがあるため、`transaction_id` は使用しない。
 *   - 同一ミリ秒・同一価格・同一数量・同一サイドの約定は実用上同一とみなす（誤差は
 *     CVD 等の集計値に影響しない範囲）。
 *
 * マージ後の `txs` はソート前である。呼び出し側で `sort((a, b) => a.timestampMs - b.timestampMs)`
 * を適用すること（加工契約: 全ての取得パスで昇順 sort を保証する）。
 */
function mergeTxResults(
	results: unknown[],
	labels?: string[],
): { txs: Tx[]; totalCount: number; failures: FetchFailure[] } {
	const seen = new Set<string>();
	const merged: Tx[] = [];
	const failures: FetchFailure[] = [];
	for (let i = 0; i < results.length; i++) {
		const r = results[i] as TxResultLike;
		if (r?.ok && Array.isArray(r.data?.normalized)) {
			for (const tx of r.data.normalized as Tx[]) {
				const key = `${tx.timestampMs}:${tx.price}:${tx.amount}:${tx.side}`;
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
	return { txs: merged, totalCount: results.length, failures };
}

/** 失敗詳細をフォーマットする（"20260420(network: HTTP 503 ...)" 形式） */
function formatFailures(failures: FetchFailure[]): string {
	return failures.map((f) => `${f.label}(${f.errorType}: ${f.message})`).join(', ');
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

		if (hours != null && hours > 0) {
			// === 時間範囲ベースの取得 ===
			const nowMs = Date.now();
			const sinceMs = nowMs - hours * 3600_000;

			// bitbank の /transactions/{YYYYMMDD} は JST 基準の日付アーカイブ。
			// 当日分はアーカイブが未生成で 404 を返すことがあるため、当日 URL の失敗は
			// fatal 扱いせず /transactions (latest) からの補完にフォールバックする。
			const sinceDayjs = dayjs(sinceMs).tz('Asia/Tokyo');
			const nowDayjs = dayjs(nowMs).tz('Asia/Tokyo');
			const todayStr = nowDayjs.format('YYYYMMDD');

			// 必要な日付を YYYYMMDD (JST) 形式で列挙（古い順）
			const dates: string[] = [];
			let d = sinceDayjs.startOf('day');
			while (d.isBefore(nowDayjs) || d.isSame(nowDayjs, 'day')) {
				dates.push(d.format('YYYYMMDD'));
				d = d.add(1, 'day');
			}

			// 日付ベース取得（authoritative: 時間範囲をカバー）と latest（supplement: 直近数分の補完）を区別。
			// 当日分は日付指定だと直近数分が欠ける場合があるため latest も併用する。
			const dateResults = await Promise.all(dates.map((ds) => getTransactions(chk.pair, 1000, ds)));
			const latestResult = await getTransactions(chk.pair, 1000);

			// 失敗した date 取得を一度だけリトライ（fetchJsonWithRateLimit の内部リトライより長い間隔）
			const retryIdx: number[] = [];
			for (let i = 0; i < dateResults.length; i++) {
				const r = dateResults[i] as TxResultLike;
				if (!r?.ok) retryIdx.push(i);
			}
			if (retryIdx.length > 0) {
				await new Promise((resolve) => setTimeout(resolve, 500));
				const retried = await Promise.all(retryIdx.map((i) => getTransactions(chk.pair, 1000, dates[i])));
				for (let j = 0; j < retryIdx.length; j++) {
					const r = retried[j] as TxResultLike;
					if (r?.ok) dateResults[retryIdx[j]] = retried[j];
				}
			}

			const dateMerge = mergeTxResults(dateResults, dates);
			const latestMerge = mergeTxResults([latestResult], ['latest']);

			// 当日 (JST) のアーカイブ欠如は許容: その分は latest から補う。
			// fatal 扱いするのは「過去日が要求されたのに全て失敗」または「当日のみ要求で latest も失敗」
			const nonTodayFailures = dateMerge.failures.filter((f) => f.label !== todayStr);
			const todayFailed = dateMerge.failures.some((f) => f.label === todayStr);
			const historicalRequested = dates.some((ds) => ds !== todayStr);
			const historicalAllFailed = historicalRequested && dateMerge.txs.length === 0 && nonTodayFailures.length > 0;

			if (historicalAllFailed) {
				return GetFlowMetricsOutputSchema.parse(
					fail(
						`日付ベースの取得が全て失敗しました（${dateMerge.failures.length}件: ${formatFailures(dateMerge.failures)}）`,
						'upstream',
					),
				);
			}

			// 過去日が無く (today のみ) かつ today + latest 両方失敗 → 取得手段なし
			if (!historicalRequested && todayFailed && latestMerge.txs.length === 0) {
				const allFailures = [...dateMerge.failures, ...latestMerge.failures];
				return GetFlowMetricsOutputSchema.parse(
					fail(
						`日付ベース取得（当日 ${todayStr}）と latest の両方が失敗しました（${allFailures.length}件: ${formatFailures(allFailures)}）`,
						'upstream',
					),
				);
			}

			// 部分失敗は警告のみ（latest 失敗は直近数分の欠落、一部 date 失敗は該当日のカバレッジ不足）
			const warnMsgs: string[] = [];
			if (nonTodayFailures.length > 0) {
				warnMsgs.push(
					`⚠️ 日付ベース取得で ${dateMerge.totalCount}件中 ${nonTodayFailures.length}件失敗: ${formatFailures(nonTodayFailures)}`,
				);
			}
			if (todayFailed) {
				warnMsgs.push(
					`⚠️ 当日 (${todayStr}) アーカイブが未公開または取得失敗のため /transactions (latest) から補完しました`,
				);
			}
			if (latestMerge.failures.length > 0) {
				warnMsgs.push(
					`⚠️ 最新約定の補完取得に失敗 (${formatFailures(latestMerge.failures)}) — 直近数分のデータが欠落している可能性があります`,
				);
			}
			if (warnMsgs.length > 0) fetchWarning = warnMsgs.join('\n');

			// date + latest を統合して重複除去
			const combined = new Set<string>();
			const allTxs: Tx[] = [];
			for (const tx of [...dateMerge.txs, ...latestMerge.txs]) {
				const key = `${tx.timestampMs}:${tx.price}:${tx.amount}:${tx.side}`;
				if (!combined.has(key)) {
					combined.add(key);
					allTxs.push(tx);
				}
			}

			txs = allTxs
				.filter((t) => t.timestampMs >= sinceMs && t.timestampMs <= nowMs)
				.sort((a, b) => a.timestampMs - b.timestampMs);
		} else {
			// === 件数ベース取得 ===
			const lim = validateLimit(limit, 1, 2000);
			if (!lim.ok) return failFromValidation(lim, GetFlowMetricsOutputSchema);

			if (date) {
				// 明示的な日付指定がある場合はそのまま取得。
				// 当日 (JST) はアーカイブ未生成で 404 の可能性があるため latest にフォールバック。
				const txRes = await getTransactions(chk.pair, Math.min(lim.value, 1000), date);
				const isTodayJst = date === dayjs().tz('Asia/Tokyo').format('YYYYMMDD');
				if (!txRes?.ok) {
					if (isTodayJst) {
						const latestRes = await getTransactions(chk.pair, Math.min(lim.value, 1000));
						if (!latestRes?.ok) {
							return GetFlowMetricsOutputSchema.parse(
								fail(
									`date=${date} (today JST) アーカイブ未公開かつ latest 取得も失敗: ${txRes?.summary || 'unknown'} / ${latestRes?.summary || 'unknown'}`,
									latestRes?.meta?.errorType || 'upstream',
								),
							);
						}
						fetchWarning = `⚠️ 当日 (${date}) のアーカイブは未公開のため /transactions (latest) から取得しました`;
						// 加工契約: 全ての取得パスで昇順 sort を保証する。
						// 上流 getTransactions も内部 sort 済みだが、契約の単一ソースをこちらに置く。
						txs = (latestRes.data.normalized as Tx[]).slice().sort((a, b) => a.timestampMs - b.timestampMs);
					} else {
						return GetFlowMetricsOutputSchema.parse(
							fail(txRes?.summary || 'failed', txRes?.meta?.errorType || 'internal'),
						);
					}
				} else {
					// 加工契約: 全ての取得パスで昇順 sort を保証する。
					txs = (txRes.data.normalized as Tx[]).slice().sort((a, b) => a.timestampMs - b.timestampMs);
				}
			} else {
				// 日付指定なし: latest で取得し、不足なら日付ベースで補完
				const latestRes = await getTransactions(chk.pair, Math.min(lim.value, 1000));
				const latestR = latestRes as { ok?: boolean; data?: { normalized?: Tx[] } };
				const latestOk = !!latestR?.ok;
				const latestTxs: Tx[] = latestOk && Array.isArray(latestR.data?.normalized) ? latestR.data.normalized : [];

				if (latestTxs.length >= lim.value) {
					// 加工契約: 全ての取得パスで昇順 sort を保証する。
					txs = latestTxs.slice().sort((a, b) => a.timestampMs - b.timestampMs);
				} else {
					// latest の返却数が不足 → 前日・前々日の日付ベース取得で補完
					// bitbank の latest エンドポイントは約60件のみ返却するため
					const todayJst = dayjs().tz('Asia/Tokyo');
					const supplementFetches: Promise<unknown>[] = [
						getTransactions(chk.pair, 1000, todayJst.subtract(1, 'day').format('YYYYMMDD')),
					];
					if (lim.value > 500) {
						supplementFetches.push(getTransactions(chk.pair, 1000, todayJst.subtract(2, 'day').format('YYYYMMDD')));
					}
					const supplementResults = await Promise.all(supplementFetches);
					const allResults = [latestRes, ...supplementResults];
					const labels = ['latest', ...supplementFetches.map((_, i) => `supplement-${i + 1}`)];
					const { txs: merged, totalCount, failures } = mergeTxResults(allResults, labels);
					// 全て失敗した場合は network エラーとして返す
					if (merged.length === 0 && failures.length > 0) {
						return GetFlowMetricsOutputSchema.parse(
							fail(`upstream fetch all failed (${formatFailures(failures)})`, 'network'),
						);
					}
					// 過半数失敗なら fail
					if (failures.length > 0 && failures.length >= totalCount / 2) {
						return GetFlowMetricsOutputSchema.parse(
							fail(
								`API取得の過半数が失敗しました（${totalCount}件中${failures.length}件失敗: ${formatFailures(failures)}）`,
								'upstream',
							),
						);
					}
					if (failures.length > 0) {
						fetchWarning = `⚠️ ${totalCount}件中 ${failures.length}件のAPI取得に失敗しました: ${formatFailures(failures)}`;
					}
					txs = merged.sort((a, b) => a.timestampMs - b.timestampMs).slice(-lim.value);
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

		// バケット分割
		const t0 = txs[0].timestampMs;
		const buckets: Array<{ ts: number; buys: number; sells: number; vBuy: number; vSell: number }> = [];
		const idx = (ms: number) => Math.floor((ms - t0) / bucketMs);
		for (const t of txs) {
			const k = idx(t.timestampMs);
			while (buckets.length <= k)
				buckets.push({ ts: t0 + buckets.length * bucketMs, buys: 0, sells: 0, vBuy: 0, vSell: 0 });
			if (t.side === 'buy') {
				buckets[k].buys++;
				buckets[k].vBuy += t.amount;
			} else {
				buckets[k].sells++;
				buckets[k].vSell += t.amount;
			}
		}

		// CVD とスパイク
		const outBuckets: Array<{
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
		}> = [];
		let cvd = 0;
		const vols = buckets.map((b) => b.vBuy + b.vSell);
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
			cvd += b.vBuy - b.vSell;
			const z = stdev > 0 ? (vol - mean) / stdev : 0;
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
				zscore: Number.isFinite(z) ? Number(z.toFixed(2)) : null,
				spike: spikeLevel(z),
			});
		}

		const totalTrades = txs.length;
		const buyTrades = txs.filter((t) => t.side === 'buy').length;
		const sellTrades = totalTrades - buyTrades;
		const buyVolume = txs.filter((t) => t.side === 'buy').reduce((s, t) => s + t.amount, 0);
		const sellVolume = txs.filter((t) => t.side === 'sell').reduce((s, t) => s + t.amount, 0);
		const netVolume = buyVolume - sellVolume;
		const aggressorRatio = totalTrades > 0 ? Number((buyTrades / totalTrades).toFixed(3)) : 0;

		// 実際の取得範囲を計算
		const actualStartMs = txs[0]?.timestampMs;
		const actualEndMs = txs[txs.length - 1]?.timestampMs;
		const actualDurationMin = actualStartMs && actualEndMs ? Math.round((actualEndMs - actualStartMs) / 60_000) : 0;

		// データ不足警告
		const warnings: string[] = [];
		if (fetchWarning) warnings.push(fetchWarning);
		if (hours != null && hours > 0 && actualDurationMin > 0) {
			const requestedMin = hours * 60;
			const coveragePct = Math.round((actualDurationMin / requestedMin) * 100);
			if (coveragePct < 80) {
				warnings.push(
					`⚠️ ${hours}時間分をリクエストしましたが、取得できたデータは約${actualDurationMin}分間（カバー率${coveragePct}%）です。bitbank API の返却上限による制約の可能性があります。`,
				);
			}
		}
		const dataWarning = warnings.length > 0 ? warnings.join('\n') : undefined;

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

		const rangeLabel =
			actualStartMs && actualEndMs
				? ` (${toDisplayTime(actualStartMs, tz) ?? '?'}〜${toDisplayTime(actualEndMs, tz) ?? '?'}, ${actualDurationMin}分間)`
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
		//   - hours 指定時のカバレッジ不足 → dataWarning（取得層 meta.warning）
		//   - 取得失敗 → fetchWarning（取得層 meta.warning）
		// これらは analyze_indicators 等の provisional 注記（ℹ️）とは別物なので混在させない。
		// Result の summary は "summary" モード（集計値のみ、バケット行なし）。
		// 呼び出し側 (handler) が view に応じて content テキストを差し替える。
		const summary = buildFlowMetricsText({
			baseSummary,
			dataWarning,
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
		if (actualStartMs && actualEndMs) {
			metaExtra.actualRange = {
				start: toIsoWithTz(actualStartMs, tz) ?? toIsoTime(actualStartMs),
				end: toIsoWithTz(actualEndMs, tz) ?? toIsoTime(actualEndMs),
				durationMinutes: actualDurationMin,
			};
		}
		if (dataWarning) {
			metaExtra.warning = dataWarning;
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

		// view=compact: 非ゼロバケットのみ
		if (effectiveView === 'compact') {
			const nonZero = buckets.filter((b) => b.buyVolume > 0 || b.sellVolume > 0);
			const data = {
				...res.data,
				series: { ...res.data.series, buckets: nonZero },
			} as typeof res.data;
			const trimmed = { ...res, data };
			const fmt = (b: FlowMetricsBucket) =>
				`${b.displayTime || b.isoTime}  buy=${b.buyVolume} sell=${b.sellVolume} total=${b.totalVolume} cvd=${b.cvd}${b.spike ? ` spike=${b.spike}` : ''}`;
			const text = `${res.summary}\n\nNon-zero ${nonZero.length}/${buckets.length} buckets:\n${nonZero.map(fmt).join('\n')}`;
			return { content: [{ type: 'text', text }], structuredContent: trimmed as Record<string, unknown> };
		}

		const agg = res?.data?.aggregates ?? {};
		const n = Number(bucketsN ?? 10);
		const last = buckets.slice(-n);
		const fmt = (b: FlowMetricsBucket) =>
			`${b.displayTime || b.isoTime}  buy=${b.buyVolume} sell=${b.sellVolume} total=${b.totalVolume} cvd=${b.cvd}${b.spike ? ` spike=${b.spike}` : ''}`;
		const actualRange = res?.meta?.actualRange;
		const rangeStr = actualRange
			? ` 実取得範囲: ${actualRange.start}〜${actualRange.end}（${actualRange.durationMinutes}分間）`
			: '';
		const warnStr = res?.meta?.warning ? `\n${res.meta.warning}` : '';
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
