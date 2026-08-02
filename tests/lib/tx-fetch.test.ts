/**
 * lib/tx-fetch.ts — get_flow_metrics / analyze_volume_profile 共有の約定取得層。
 *
 * 加工契約（dedup キー `timestampMs:price:amount:side` / timestampMs 昇順 sort）は
 * ツール description に明文化済みのため、ここで固定する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	applyTxLimit,
	buildAggregateCoverageNote,
	buildTxCoverageWarning,
	buildTxTruncationWarning,
	computeTxCoverage,
	extractUpstreamError,
	fetchLatestTxs,
	fetchSupplementTxs,
	fetchTxTimeRange,
	formatTxFailures,
	hasCoverageShortfall,
	mergeTxResults,
	partialFailureWarning,
	sortTxsAsc,
	type Tx,
	txDedupKey,
} from '../../lib/tx-fetch.js';

const BASE_MS = Date.UTC(2026, 6, 7, 0, 0, 0);

function tx(overrides: Partial<Tx> = {}): Tx {
	return {
		price: 5_000_000,
		amount: 0.1,
		side: 'buy',
		timestampMs: BASE_MS,
		isoTime: '2026-07-07T00:00:00.000Z',
		...overrides,
	};
}

function okResult(txs: Tx[]) {
	return { ok: true, summary: 'ok', data: { normalized: txs }, meta: { count: txs.length } };
}

function failResult(errorType = 'network', summary = 'HTTP 503') {
	return { ok: false, summary, data: {}, meta: { errorType } };
}

describe('txDedupKey', () => {
	it('transaction_id を含まない（同一約定でも上流間で ID が一致しないため）', () => {
		const a = { ...tx(), transaction_id: 1 } as Tx;
		const b = { ...tx(), transaction_id: 2 } as Tx;
		expect(txDedupKey(a)).toBe(txDedupKey(b));
		expect(txDedupKey(a)).toBe(`${BASE_MS}:5000000:0.1:buy`);
	});

	it('timestampMs / price / amount / side のいずれかが違えば別キー', () => {
		const base = tx();
		expect(txDedupKey(base)).not.toBe(txDedupKey(tx({ timestampMs: BASE_MS + 1 })));
		expect(txDedupKey(base)).not.toBe(txDedupKey(tx({ price: 5_000_001 })));
		expect(txDedupKey(base)).not.toBe(txDedupKey(tx({ amount: 0.2 })));
		expect(txDedupKey(base)).not.toBe(txDedupKey(tx({ side: 'sell' })));
	});
});

describe('mergeTxResults', () => {
	it('空配列: txs も failures も空', () => {
		const m = mergeTxResults([]);
		expect(m.txs).toEqual([]);
		expect(m.totalCount).toBe(0);
		expect(m.failedCount).toBe(0);
	});

	it('null 結果は失敗として errorType=unknown で記録される', () => {
		const m = mergeTxResults([null], ['latest']);
		expect(m.failedCount).toBe(1);
		expect(m.failures[0]).toEqual({ label: 'latest', errorType: 'unknown', message: 'unknown error' });
	});

	it('label 未指定時は #index をラベルにする', () => {
		const m = mergeTxResults([failResult()]);
		expect(m.failures[0].label).toBe('#0');
	});

	it('重複入力: 同一キーの約定は 1 件に畳まれる', () => {
		const m = mergeTxResults([okResult([tx(), tx()]), okResult([tx()])], ['20260706', 'latest']);
		expect(m.txs).toHaveLength(1);
		expect(m.failedCount).toBe(0);
	});

	it('単一要素: そのまま通す', () => {
		const m = mergeTxResults([okResult([tx()])], ['latest']);
		expect(m.txs).toHaveLength(1);
	});

	it('成功と失敗が混在: 成功分はマージし失敗は失敗詳細に積む', () => {
		const m = mergeTxResults(
			[okResult([tx()]), failResult('upstream', 'HTTP 404'), okResult([tx({ timestampMs: BASE_MS + 1000 })])],
			['20260705', '20260706', 'latest'],
		);
		expect(m.txs).toHaveLength(2);
		expect(m.totalCount).toBe(3);
		expect(m.failedCount).toBe(1);
		expect(m.failures[0]).toEqual({ label: '20260706', errorType: 'upstream', message: 'HTTP 404' });
	});

	it('ok=true でも normalized が配列でなければ失敗扱い', () => {
		const m = mergeTxResults([{ ok: true, summary: 'broken', data: {}, meta: {} }], ['latest']);
		expect(m.failedCount).toBe(1);
	});

	it('マージ結果は未 sort（呼び出し側の sortTxsAsc が契約）', () => {
		const later = tx({ timestampMs: BASE_MS + 60_000 });
		const earlier = tx({ timestampMs: BASE_MS, price: 4_999_999 });
		const m = mergeTxResults([okResult([later]), okResult([earlier])]);
		expect(m.txs.map((t) => t.timestampMs)).toEqual([BASE_MS + 60_000, BASE_MS]);
	});
});

describe('sortTxsAsc', () => {
	it('timestampMs 昇順に並べ、入力配列は破壊しない', () => {
		const input = [
			tx({ timestampMs: BASE_MS + 2000 }),
			tx({ timestampMs: BASE_MS }),
			tx({ timestampMs: BASE_MS + 1000 }),
		];
		const sorted = sortTxsAsc(input);
		expect(sorted.map((t) => t.timestampMs)).toEqual([BASE_MS, BASE_MS + 1000, BASE_MS + 2000]);
		expect(input[0].timestampMs).toBe(BASE_MS + 2000);
	});

	it('空配列でも落ちない', () => {
		expect(sortTxsAsc([])).toEqual([]);
	});
});

describe('formatTxFailures / partialFailureWarning / extractUpstreamError', () => {
	it('formatTxFailures: label(errorType: message) 形式で列挙する', () => {
		expect(
			formatTxFailures([
				{ label: '20260706', errorType: 'network', message: 'HTTP 503' },
				{ label: 'latest', errorType: 'upstream', message: 'code 10000' },
			]),
		).toBe('20260706(network: HTTP 503), latest(upstream: code 10000)');
	});

	it('partialFailureWarning: 失敗ゼロなら undefined', () => {
		expect(partialFailureWarning(3, [])).toBeUndefined();
	});

	it('partialFailureWarning: 失敗詳細を必ず含む', () => {
		const w = partialFailureWarning(3, [{ label: '20260706', errorType: 'network', message: 'HTTP 503' }]);
		expect(w).toContain('3件中1件');
		expect(w).toContain('20260706(network: HTTP 503)');
	});

	it('extractUpstreamError: 最初の失敗結果の errorType を返す', () => {
		expect(extractUpstreamError([okResult([tx()]), failResult('upstream', 'boom')])).toEqual({
			errorType: 'upstream',
			summary: 'boom',
		});
	});

	it('extractUpstreamError: 失敗が無ければ null', () => {
		expect(extractUpstreamError([okResult([tx()])])).toBeNull();
	});
});

describe('fetchTxTimeRange', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/** 2026-07-08 09:30 JST = 2026-07-08 00:30 UTC。進行中 UTC 日 = 20260708 */
	const NOW = Date.UTC(2026, 6, 8, 0, 30, 0);

	/** hours 指定（現在時刻起点の相対窓）を絶対区間に変換する — 呼び出し側と同じ変換 */
	const lastHours = (hours: number, nowMs: number = NOW) => ({ sinceMs: nowMs - hours * 3600_000, untilMs: nowMs });

	it('進行中の UTC 日は列挙せず、完了済み UTC 日 + latest を叩く', async () => {
		const calls: Array<string | undefined> = [];
		const fetcher = vi.fn(async (date?: string) => {
			calls.push(date);
			return okResult([tx({ timestampMs: NOW - 60_000 })]);
		});

		const res = await fetchTxTimeRange(fetcher, lastHours(2), { nowMs: NOW });

		expect(res.dates).toEqual(['20260707']);
		expect(res.currentUtcDay).toBe('20260708');
		expect(calls).toEqual(['20260707', undefined]);
		expect(res.labels).toEqual(['20260707', 'latest']);
		expect(res.usedLatest).toBe(true);
	});

	it('時間窓外の約定は除外し、昇順 sort して返す', async () => {
		const inWindow = tx({ timestampMs: NOW - 30 * 60_000 });
		const tooOld = tx({ timestampMs: NOW - 5 * 3600_000, price: 4_000_000 });
		const future = tx({ timestampMs: NOW + 60_000, price: 6_000_000 });
		const fetcher = vi.fn(async (date?: string) =>
			date ? okResult([future, tooOld]) : okResult([inWindow, tx({ timestampMs: NOW - 10 * 60_000 })]),
		);

		const res = await fetchTxTimeRange(fetcher, lastHours(1), { nowMs: NOW });

		expect(res.txs.map((t) => t.timestampMs)).toEqual([NOW - 30 * 60_000, NOW - 10 * 60_000]);
	});

	it('date 群と latest のマージ結果を別々に取り出せる（警告文の出し分け用）', async () => {
		const fetcher = vi.fn(async (date?: string) => (date ? failResult('upstream', 'HTTP 404') : okResult([tx()])));

		const res = await fetchTxTimeRange(fetcher, lastHours(2), { nowMs: NOW });

		expect(res.dateMerge.failedCount).toBe(1);
		expect(res.dateMerge.failures[0].label).toBe('20260707');
		expect(res.latestMerge.failedCount).toBe(0);
		expect(res.merged.totalCount).toBe(2);
	});

	it('retryFailedDates 指定時: 失敗した date のみ 1 度だけ再取得する', async () => {
		let dateCalls = 0;
		const fetcher = vi.fn(async (date?: string) => {
			if (!date) return okResult([tx({ timestampMs: NOW - 1000 })]);
			dateCalls++;
			return dateCalls === 1 ? failResult('network', 'HTTP 503') : okResult([tx({ timestampMs: NOW - 2000 })]);
		});

		const res = await fetchTxTimeRange(fetcher, lastHours(2), { nowMs: NOW, retryFailedDates: { delayMs: 0 } });

		expect(dateCalls).toBe(2);
		expect(res.dateMerge.failedCount).toBe(0);
	});

	it('retryFailedDates 未指定時: 再取得しない', async () => {
		let dateCalls = 0;
		const fetcher = vi.fn(async (date?: string) => {
			if (!date) return okResult([tx({ timestampMs: NOW - 1000 })]);
			dateCalls++;
			return failResult('network', 'HTTP 503');
		});

		const res = await fetchTxTimeRange(fetcher, lastHours(2), { nowMs: NOW });

		expect(dateCalls).toBe(1);
		expect(res.dateMerge.failedCount).toBe(1);
	});

	it('時間窓が進行中 UTC 日内に収まる場合は date を一切要求しない', async () => {
		const calls: Array<string | undefined> = [];
		const fetcher = vi.fn(async (date?: string) => {
			calls.push(date);
			return okResult([tx({ timestampMs: NOW - 1000 })]);
		});

		const res = await fetchTxTimeRange(fetcher, lastHours(0.25), { nowMs: NOW });

		expect(res.dates).toEqual([]);
		expect(calls).toEqual([undefined]);
	});

	it('過去区間のみの要求では latest を叩かない（区間外の約定しか返らないため）', async () => {
		const calls: Array<string | undefined> = [];
		const fetcher = vi.fn(async (date?: string) => {
			calls.push(date);
			return okResult([tx({ timestampMs: Date.UTC(2026, 6, 6, 12, 0, 0) })]);
		});

		// 完了済み UTC 日 20260706 の丸 1 日（untilMs は閉区間の上端 = 23:59:59.999）
		const res = await fetchTxTimeRange(
			fetcher,
			{ sinceMs: Date.UTC(2026, 6, 6, 0, 0, 0), untilMs: Date.UTC(2026, 6, 7, 0, 0, 0) - 1 },
			{ nowMs: NOW },
		);

		expect(calls).toEqual(['20260706']);
		expect(res.usedLatest).toBe(false);
		expect(res.labels).toEqual(['20260706']);
		expect(res.latestMerge.totalCount).toBe(0);
		expect(res.latestMerge.failedCount).toBe(0);
		expect(res.txs).toHaveLength(1);
	});

	it('過去区間でも「進行中の UTC 日」の判定は実時刻で行う（終端の日を未公開扱いしない）', async () => {
		// untilMs の UTC 日 = 20260707。これを現在時刻とみなすと 20260707 が進行中と誤判定され、
		// 実際には公開済みのアーカイブを列挙しなくなる。
		const calls: Array<string | undefined> = [];
		const fetcher = vi.fn(async (date?: string) => {
			calls.push(date);
			return okResult([tx({ timestampMs: Date.UTC(2026, 6, 7, 6, 0, 0) })]);
		});

		const res = await fetchTxTimeRange(
			fetcher,
			{ sinceMs: Date.UTC(2026, 6, 7, 0, 0, 0), untilMs: Date.UTC(2026, 6, 7, 12, 0, 0) },
			{ nowMs: NOW },
		);

		expect(res.dates).toEqual(['20260707']);
		expect(calls).toEqual(['20260707']);
		expect(res.usedLatest).toBe(false);
	});

	it('区間が進行中 UTC 日にかかる場合は latest を叩く', async () => {
		const calls: Array<string | undefined> = [];
		const fetcher = vi.fn(async (date?: string) => {
			calls.push(date);
			return okResult([tx({ timestampMs: NOW - 60_000 })]);
		});

		const res = await fetchTxTimeRange(
			fetcher,
			{ sinceMs: Date.UTC(2026, 6, 7, 12, 0, 0), untilMs: Date.UTC(2026, 6, 8, 0, 10, 0) },
			{ nowMs: NOW },
		);

		expect(res.usedLatest).toBe(true);
		expect(calls).toEqual(['20260707', undefined]);
	});

	it('untilMs は閉区間の上端として扱う（境界の約定を落とさない）', async () => {
		const untilMs = Date.UTC(2026, 6, 8, 0, 10, 0);
		const fetcher = vi.fn(async (date?: string) =>
			date ? okResult([]) : okResult([tx({ timestampMs: untilMs }), tx({ timestampMs: untilMs + 1, price: 1 })]),
		);

		const res = await fetchTxTimeRange(fetcher, { sinceMs: untilMs - 3600_000, untilMs }, { nowMs: NOW });

		expect(res.txs.map((t) => t.timestampMs)).toEqual([untilMs]);
	});
});

describe('fetchLatestTxs / fetchSupplementTxs', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const NOW = Date.UTC(2026, 6, 7, 23, 31, 0); // 2026-07-08 08:31 JST

	it('fetchLatestTxs: date を渡さずに 1 回だけ叩く', async () => {
		const fetcher = vi.fn(async () => okResult([tx()]));
		const latest = await fetchLatestTxs(fetcher);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher).toHaveBeenCalledWith();
		expect(latest.txs).toHaveLength(1);
	});

	it('fetchLatestTxs: 失敗時は txs 空 + 生 result を保持する', async () => {
		const fail = failResult('network', 'boom');
		const latest = await fetchLatestTxs(async () => fail);
		expect(latest.txs).toEqual([]);
		expect(latest.result).toBe(fail);
	});

	it('fetchSupplementTxs: 補完日付は完了済み UTC 日（JST 早朝でも進行中 UTC 日を要求しない）', async () => {
		const calls: Array<string | undefined> = [];
		const fetcher = vi.fn(async (date?: string) => {
			calls.push(date);
			return okResult([tx()]);
		});
		const latest = { result: okResult([tx()]), txs: [tx()] };

		const sup = await fetchSupplementTxs(fetcher, 100, latest, { nowMs: NOW });

		expect(sup.supplementDates).toEqual(['20260706']);
		expect(calls).toEqual(['20260706']);
		expect(sup.labels).toEqual(['latest', '20260706']);
	});

	it('fetchSupplementTxs: limit > 500 なら 2 日分を補完する', async () => {
		const fetcher = vi.fn(async () => okResult([tx()]));
		const latest = { result: okResult([]), txs: [] };

		const sup = await fetchSupplementTxs(fetcher, 600, latest, { nowMs: NOW });

		expect(sup.supplementDates).toEqual(['20260706', '20260705']);
		expect(sup.merged.totalCount).toBe(3); // latest + 2 日分
	});

	it('fetchSupplementTxs: latest の結果もマージ対象に含める', async () => {
		const latestTx = tx({ timestampMs: NOW });
		const dayTx = tx({ timestampMs: NOW - 86_400_000, price: 4_900_000 });
		const latest = { result: okResult([latestTx]), txs: [latestTx] };

		const sup = await fetchSupplementTxs(async () => okResult([dayTx]), 100, latest, { nowMs: NOW });

		expect(sup.merged.txs).toHaveLength(2);
		expect(sup.merged.failedCount).toBe(0);
	});
});

describe('computeTxCoverage', () => {
	/** ts オフセット（分）で約定列を作る */
	const at = (minutes: number[]) => minutes.map((m) => tx({ timestampMs: BASE_MS + m * 60_000 }));

	it('空配列: null', () => {
		expect(computeTxCoverage([])).toBeNull();
	});

	it('単一要素: スパン 0・欠損なし', () => {
		const c = computeTxCoverage(at([0]));
		expect(c?.spanMinutes).toBe(0);
		expect(c?.coveredMinutes).toBe(0);
		expect(c?.gapMinutes).toBe(0);
		expect(c?.segments).toHaveLength(1);
		expect(c?.gaps).toHaveLength(0);
	});

	it('連続した約定: span = covered、欠損なし', () => {
		const c = computeTxCoverage(at([0, 1, 2, 3, 5, 8]));
		expect(c?.spanMinutes).toBe(8);
		expect(c?.coveredMinutes).toBe(8);
		expect(c?.gapMinutes).toBe(0);
		expect(c?.gaps).toHaveLength(0);
	});

	it('閾値ちょうどの無約定は欠損としない（off-by-one）', () => {
		// 既定閾値 15 分。ちょうど 15 分は許容、15 分 + 1ms から欠損
		expect(computeTxCoverage(at([0, 15]))?.gaps).toHaveLength(0);
		const overThreshold = [tx({ timestampMs: BASE_MS }), tx({ timestampMs: BASE_MS + 15 * 60_000 + 1 })];
		expect(computeTxCoverage(overThreshold)?.gaps).toHaveLength(1);
	});

	it('閑散帯の無約定（実測最長 7.5 分）は欠損としない', () => {
		// 2026-08-01 実測: JST 01:43:40〜01:51:12 の 7.5 分無約定。別系統の /candlestick でも
		// volume=0 が 7 本連続しており、取得欠損ではなく本当に約定が無かった区間。
		const quiet = [tx({ timestampMs: BASE_MS }), tx({ timestampMs: BASE_MS + 7.5 * 60_000 })];
		expect(computeTxCoverage(quiet)?.gaps).toHaveLength(0);
		expect(computeTxCoverage(quiet)?.coveredMinutes).toBe(8);
	});

	it('穴があるとき: covered は穴を含まず、span = covered + gap', () => {
		// 0〜10分に約定、10〜610分は空白、610〜620分に約定
		const c = computeTxCoverage(at([0, 5, 10, 610, 615, 620]));
		expect(c?.spanMinutes).toBe(620);
		expect(c?.coveredMinutes).toBe(20); // 10 + 10
		expect(c?.gapMinutes).toBe(600);
		expect(c?.segments).toHaveLength(2);
		expect(c?.gaps).toHaveLength(1);
		expect(c?.gaps[0].durationMinutes).toBe(600);
		expect((c?.coveredMinutes ?? 0) + (c?.gapMinutes ?? 0)).toBe(c?.spanMinutes);
	});

	it('穴が複数あるとき: すべて列挙する', () => {
		const c = computeTxCoverage(at([0, 5, 10, 100, 105, 110, 300, 305, 310]));
		expect(c?.segments).toHaveLength(3);
		expect(c?.gaps.map((g) => g.durationMinutes)).toEqual([90, 190]);
	});

	it('gapMs は指定で変えられる', () => {
		const c = computeTxCoverage(at([0, 10, 20]), 60 * 60_000);
		expect(c?.gaps).toHaveLength(0);
		expect(c?.coveredMinutes).toBe(20);
	});
});

describe('buildTxCoverageWarning / buildAggregateCoverageNote', () => {
	const at = (minutes: number[]) => minutes.map((m) => tx({ timestampMs: BASE_MS + m * 60_000 }));

	it('欠損なしなら undefined（誤検知しない）', () => {
		expect(buildTxCoverageWarning(computeTxCoverage(at([0, 5, 10])))).toBeUndefined();
	});

	it('coverage が null なら undefined', () => {
		expect(buildTxCoverageWarning(null)).toBeUndefined();
	});

	it('requestedMinutes 指定時: 要求窓に対するカバー率を出す', () => {
		const c = computeTxCoverage(at([0, 5, 10, 610, 615, 620]));
		const w = buildTxCoverageWarning(c, { requestedMinutes: 1440, tz: 'Asia/Tokyo' });
		expect(w).toContain('要求 1440分');
		expect(w).toContain('20分');
		expect(w).toContain('欠損 600分');
		expect(w).toContain('1区間');
	});

	it('requestedMinutes 未指定時: スパンを分母にする', () => {
		const w = buildTxCoverageWarning(computeTxCoverage(at([0, 5, 10, 610, 615, 620])));
		expect(w).toContain('スパン 620分');
		expect(w).not.toContain('要求');
	});

	it('最大の欠損区間を時刻付きで示す', () => {
		const w = buildTxCoverageWarning(computeTxCoverage(at([0, 5, 10, 100, 105, 110, 500, 505, 510])));
		expect(w).toContain('2区間');
		expect(w).toContain('最大 390分');
	});

	it('buildAggregateCoverageNote: 計算層の注記は集計対象時間と区間数を含む', () => {
		const c = computeTxCoverage(at([0, 5, 10, 610, 615, 620]));
		if (!c) throw new Error('coverage should exist');
		const note = buildAggregateCoverageNote(c, '集計値（CVD）');
		expect(note).toContain('集計値（CVD）');
		expect(note).toContain('20分');
		expect(note).toContain('2区間');
		expect(note).toContain('600分');
		// 計算層は meta.warnings に入るので ⚠️ プレフィックスは付けない
		expect(note.startsWith('⚠️')).toBe(false);
	});
});

describe('applyTxLimit / buildTxTruncationWarning', () => {
	const many = (n: number) => Array.from({ length: n }, (_, i) => tx({ timestampMs: BASE_MS + i * 60_000 }));

	it('件数が limit 以下なら切り捨てない', () => {
		const app = applyTxLimit(many(5), 10);
		expect(app.txs).toHaveLength(5);
		expect(app.totalAvailable).toBe(5);
		expect(app.truncated).toBe(false);
	});

	it('ちょうど limit 件でも切り捨てない（off-by-one）', () => {
		const app = applyTxLimit(many(10), 10);
		expect(app.truncated).toBe(false);
		expect(app.txs).toHaveLength(10);
	});

	it('limit 超過時は最新側 limit 件を残し、適用前の件数を保持する', () => {
		const app = applyTxLimit(many(100), 10);
		expect(app.txs).toHaveLength(10);
		expect(app.totalAvailable).toBe(100);
		expect(app.truncated).toBe(true);
		// 残るのは最新側（末尾）
		expect(app.txs[0].timestampMs).toBe(BASE_MS + 90 * 60_000);
		expect(app.txs.at(-1)?.timestampMs).toBe(BASE_MS + 99 * 60_000);
	});

	it('空配列でも落ちない', () => {
		const app = applyTxLimit([], 10);
		expect(app.txs).toEqual([]);
		expect(app.truncated).toBe(false);
	});

	it('buildTxTruncationWarning: 切り捨てが無ければ undefined', () => {
		expect(buildTxTruncationWarning(applyTxLimit(many(5), 10), 10)).toBeUndefined();
	});

	it('buildTxTruncationWarning: 件数・limit・スコープ・代替手段を含む', () => {
		const w = buildTxTruncationWarning(applyTxLimit(many(2500), 100), 100, {
			scope: 'date=20260801（UTC 暦日）',
			hint: '1 UTC 日全体の集計には hours を使ってください。',
		});
		expect(w).toContain('date=20260801（UTC 暦日）');
		expect(w).toContain('2500件');
		expect(w).toContain('100件');
		expect(w).toContain('limit=100');
		expect(w).toContain('hours');
		// 集計値だけでなくカバレッジ申告も部分データ由来であることを明示する
		expect(w).toContain('カバレッジ');
	});
});

describe('hasCoverageShortfall / カバレッジ不足の警告', () => {
	const at = (minutes: number[]) => minutes.map((m) => tx({ timestampMs: BASE_MS + m * 60_000 }));
	/** 0〜spanMin 分に 1 分間隔で連続する約定列（内部ギャップなし） */
	const contiguous = (spanMin: number) => at(Array.from({ length: spanMin + 1 }, (_, i) => i));

	it('hasCoverageShortfall: 80% ちょうどは不足としない（off-by-one）', () => {
		expect(hasCoverageShortfall(computeTxCoverage(contiguous(80)), 100)).toBe(false);
		expect(hasCoverageShortfall(computeTxCoverage(contiguous(79)), 100)).toBe(true);
	});

	it('hasCoverageShortfall: requestedMinutes が無ければ常に false', () => {
		expect(hasCoverageShortfall(computeTxCoverage(contiguous(10)))).toBe(false);
		expect(hasCoverageShortfall(computeTxCoverage(contiguous(10)), 0)).toBe(false);
		expect(hasCoverageShortfall(null, 100)).toBe(false);
	});

	it('内部欠損なし + 要求窓の8割未満 → 未カバーの定量警告が出る', () => {
		// 実測（2026-08-02, hours=4）: latest 約60件 ≒ 34分 / 要求240分 = 14%
		const w = buildTxCoverageWarning(computeTxCoverage(contiguous(34)), {
			requestedMinutes: 240,
			tz: 'Asia/Tokyo',
		});
		expect(w).toContain('要求 240分');
		expect(w).toContain('34分（14%）');
		expect(w).toContain('外側 206分 は未カバー');
		// 内部欠損はゼロなので「欠損」の行は出さない
		expect(w).not.toContain('欠損');
	});

	it('内部欠損なし + 要求窓の8割以上 → 警告なし（誤検知しない）', () => {
		expect(buildTxCoverageWarning(computeTxCoverage(contiguous(80)), { requestedMinutes: 100 })).toBeUndefined();
	});

	it('内部欠損あり + 窓外の未カバーもあり → 両方を併記する', () => {
		// 0〜10分 + 30〜40分（内部ギャップ 20分）、要求 100分 → 窓外 60分
		const c = computeTxCoverage(at([0, 5, 10, 30, 35, 40]));
		const w = buildTxCoverageWarning(c, { requestedMinutes: 100 });
		expect(w).toContain('欠損 20分');
		expect(w).toContain('外側 60分 は未カバー');
	});

	it('buildAggregateCoverageNote: 不足時は「窓全体を代表しない」旨を追記する', () => {
		const c = computeTxCoverage(contiguous(34));
		if (!c) throw new Error('coverage should exist');
		const note = buildAggregateCoverageNote(c, '集計値（CVD）', 240);
		expect(note).toContain('34分（1区間）のみから算出');
		expect(note).toContain('要求した時間窓（240分）全体を代表する値ではありません');
		// 内部欠損ゼロなら「欠損 N分」は出さない
		expect(note).not.toContain('欠損');
	});

	it('buildAggregateCoverageNote: requestedMinutes 未指定なら従来どおり', () => {
		const c = computeTxCoverage(at([0, 5, 10, 610, 615, 620]));
		if (!c) throw new Error('coverage should exist');
		const note = buildAggregateCoverageNote(c, '集計値（CVD）');
		expect(note).toContain('欠損 600分');
		expect(note).not.toContain('代表する値ではありません');
	});
});
