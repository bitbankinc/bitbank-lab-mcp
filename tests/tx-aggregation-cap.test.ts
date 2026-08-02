/**
 * 内部集計ツールのキャップ解除回帰（get_flow_metrics / analyze_volume_profile）
 *
 * 旧実装は集計用の取得にも get_transactions の応答上限（1000 件）を掛けていたため、
 * 1 UTC 日 5,609〜8,040 件（BTC/JPY 実測）のうち末尾 1000 件（≒4〜5 時間分）しか
 * CVD / アグレッサー比 / VWAP / Volume Profile に入っていなかった。しかもその事実は
 * 出力のどこにも現れなかった。
 *
 * ここでは getTransactions をモックせず **上流 fetch だけ** をモックして、実際の
 * limit 適用ロジックを通したうえで集計値が全件ベースになることを固定する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import analyzeVolumeProfile from '../tools/analyze_volume_profile.js';
import getFlowMetrics, { toolDef } from '../tools/get_flow_metrics.js';
import getTransactions from '../tools/get_transactions.js';
import { assertOk } from './_assertResult.js';

/** 2026-07-08 17:30 JST = 2026-07-08 08:30 UTC。進行中 UTC 日 = 20260708、完了済み = 20260707 */
const NOW = Date.UTC(2026, 6, 8, 8, 30, 0);
/** 完了済み UTC 日アーカイブ 20260707 のうち、hours=24 の窓に入る区間の先頭 */
const ARCHIVE_START = Date.UTC(2026, 6, 7, 8, 30, 0);
const ARCHIVE_COUNT = 2500;
const LATEST_COUNT = 60;

type RawTx = { transaction_id: number; price: string; amount: string; side: string; executed_at: string };

/**
 * 約定を等間隔に生成する。
 * amount は buy=0.02 / sell=0.01 固定にして CVD・VWAP を解析的に検証できるようにする。
 */
function buildTxs(startMs: number, count: number, stepMs: number, idBase: number): RawTx[] {
	return Array.from({ length: count }, (_, i) => ({
		transaction_id: idBase + i,
		// 価格は 5,000,000 と 6,000,000 を交互に → VWAP は数量加重で決まる
		price: i % 2 === 0 ? '5000000' : '6000000',
		amount: i % 2 === 0 ? '0.02' : '0.01',
		side: i % 2 === 0 ? 'buy' : 'sell',
		executed_at: String(startMs + i * stepMs),
	}));
}

const ARCHIVE_TXS = buildTxs(ARCHIVE_START, ARCHIVE_COUNT, 20_000, 1);
const LATEST_TXS = buildTxs(NOW - LATEST_COUNT * 1_000, LATEST_COUNT, 1_000, 900_001);

function jsonRes(body: unknown, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 404 ? 'Not Found' : 'OK',
		headers: { get: () => null },
		json: async () => body,
	} as unknown as Response;
}

function payload(txs: RawTx[]) {
	return { success: 1, data: { transactions: txs } };
}

function mockUpstream() {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
		const u = String(url);
		if (u.endsWith('/transactions/20260707')) return jsonRes(payload(ARCHIVE_TXS));
		if (u.endsWith('/transactions')) return jsonRes(payload(LATEST_TXS));
		return jsonRes({ success: 0, data: { code: 10000 } }, 404);
	});
}

/** buy 側 = 偶数 index。archive/latest ともに buy が 1 件多い（count が偶数なら半々） */
const TOTAL_TRADES = ARCHIVE_COUNT + LATEST_COUNT;
const BUY_TRADES = TOTAL_TRADES / 2;
const EXPECTED_CVD = BUY_TRADES * 0.02 - BUY_TRADES * 0.01;

describe('内部集計のキャップ解除（1 UTC 日 2000 件超）', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('get_flow_metrics(hours=24): totalTrades が全件ベースになる（旧: 末尾1000件）', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', 24);

		assertOk(res);
		expect(res.data.aggregates.totalTrades).toBe(TOTAL_TRADES);
		expect(res.data.aggregates.totalTrades).toBeGreaterThan(1000);
	});

	it('get_flow_metrics(hours=24): CVD / アグレッサー比 が全件ベースで算出される', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', 24);

		assertOk(res);
		expect(res.data.aggregates.buyTrades).toBe(BUY_TRADES);
		expect(res.data.aggregates.sellTrades).toBe(TOTAL_TRADES - BUY_TRADES);
		expect(res.data.aggregates.finalCvd).toBeCloseTo(EXPECTED_CVD, 6);
		expect(res.data.aggregates.aggressorRatio).toBeCloseTo(0.5, 3);
	});

	it('analyze_volume_profile(hours=24): totalTrades / VWAP が全件ベースになる', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await analyzeVolumeProfile('btc_jpy', 24, 500, 20, 0.7);

		assertOk(res);
		expect(res.data.params.totalTrades).toBe(TOTAL_TRADES);
		// buy: 5,000,000 x 0.02 / sell: 6,000,000 x 0.01 が同数 → VWAP = (100000+60000)/0.03
		const expectedVwap = (5_000_000 * 0.02 + 6_000_000 * 0.01) / 0.03;
		expect(res.data.vwap.price).toBeCloseTo(expectedVwap, 0);
		expect(res.data.params.totalVolume).toBeCloseTo(BUY_TRADES * 0.03, 6);
	});

	it('public ツール get_transactions の応答上限（1000 件）は据え置き', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getTransactions('btc_jpy', 1000, '20260707');

		assertOk(res);
		expect(res.data.normalized).toHaveLength(1000);
		expect(res.meta.totalFetched).toBe(ARCHIVE_COUNT);
		expect(res.meta.truncated).toBe(true);
		expect(res.meta.warning).toContain('最新側1000件のみを返却');
	});

	it('unlimited 指定時は limit を無視して全件返し、truncation warning も出さない', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getTransactions('btc_jpy', 1000, '20260707', undefined, { unlimited: true });

		assertOk(res);
		expect(res.data.normalized).toHaveLength(ARCHIVE_COUNT);
		expect(res.meta.truncated).toBe(false);
		expect(res.meta.warning).toBeUndefined();
		// 内部呼び出しでは LLM に渡らないため約定行は列挙しない（数千行の文字列生成を避ける）
		expect(res.summary).not.toContain('📋 全');
	});

	it('unlimited でもフィルタは limit 適用前に効く（フィルタ後の全件が返る）', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getTransactions('btc_jpy', 100, '20260707', { minPrice: 5_500_000 }, { unlimited: true });

		assertOk(res);
		// 価格 6,000,000 の約定（奇数 index）= 1250 件
		expect(res.data.normalized).toHaveLength(ARCHIVE_COUNT / 2);
		expect(res.meta.matched).toBe(ARCHIVE_COUNT / 2);
		expect(res.data.normalized.every((t) => t.price >= 5_500_000)).toBe(true);
	});
});

/**
 * カバレッジ申告の是正
 *
 * 旧実装の meta.actualRange.durationMinutes は先頭〜末尾の単純差分だった。JST 17:30 時点の
 * hours=24 では「直近約763分間分」と申告するが、実データがあるのは約5時間分のみで、
 * 間の空白区間がカバー済みとして計上されていた。
 *
 * 下記フィクスチャは実運用と同じ形（完了済み UTC 日アーカイブ → 空白 → latest 約60件）で、
 * 空白がカバー済みとして申告されないことを固定する。
 */
describe('カバレッジ申告（hours=24, 進行中 UTC 日に穴があるケース）', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/** アーカイブ末尾（7/7 22:23 UTC）〜 latest 先頭（7/8 08:29 UTC）の空白 */
	const EXPECTED_GAP_MIN = 606;
	const EXPECTED_COVERED_MIN = 834;

	it('get_flow_metrics: durationMinutes(スパン) と coveredMinutes(実カバー) を分けて申告する', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', 24);

		assertOk(res);
		const range = res.meta.actualRange;
		expect(range).toBeDefined();
		// スパンは要求窓どおり 1440 分だが、実データはその一部しかない
		expect(range?.durationMinutes).toBe(1440);
		expect(range?.coveredMinutes).toBe(EXPECTED_COVERED_MIN);
		expect(range?.gapMinutes).toBe(EXPECTED_GAP_MIN);
		expect(range?.coveredMinutes).toBeLessThan(range?.durationMinutes ?? 0);
		// 穴で分断された 2 区間
		expect(range?.segments).toBe(2);
		expect(range?.requestedMinutes).toBe(1440);
		expect(range?.coveragePct).toBeCloseTo(57.9, 1);
		// 最大の欠損区間が時刻付きで出る
		expect(range?.gaps?.[0].durationMinutes).toBe(EXPECTED_GAP_MIN);
	});

	it('get_flow_metrics: 欠損は取得層 warning、集計値の由来は計算層 warnings で明示される', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', 24);

		assertOk(res);
		// 取得層 (meta.warning): 要求窓 / 実カバー / 欠損の 3 点
		expect(res.meta.warning).toContain('カバレッジ');
		expect(res.meta.warning).toContain('要求 1440分');
		expect(res.meta.warning).toContain(`${EXPECTED_COVERED_MIN}分`);
		expect(res.meta.warning).toContain(`欠損 ${EXPECTED_GAP_MIN}分`);
		// 進行中 UTC 日のカバレッジ制約は従来どおり明示される
		expect(res.meta.warning).toContain('進行中の UTC 日 (20260708)');
		expect(res.meta.warning).toContain('直近約60件');
		// 計算層 (meta.warnings): 集計値がカバー区間のみ由来であること。2 系統は混ぜない
		expect(res.meta.warnings?.[0]).toContain('集計値');
		expect(res.meta.warnings?.[0]).toContain(`${EXPECTED_COVERED_MIN}分`);
		expect(res.meta.warning).not.toContain('集計値（totalTrades');
	});

	it('get_flow_metrics: summary は穴をカバー済みと申告しない（スパン/実カバー並記）', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', 24);

		assertOk(res);
		expect(res.summary).toContain(`スパン1440分/実カバー${EXPECTED_COVERED_MIN}分`);
		// 旧文言（穴の有無を問わず「直近約N分間分」で覆い隠していた）は出さない
		expect(res.summary).not.toContain('直近フローとして扱ってください');
	});

	it('get_flow_metrics handler: content テキストにスパン/実カバー/欠損が出る', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = (await toolDef.handler({
			pair: 'btc_jpy',
			bucketMs: 60_000,
			hours: 24,
			view: 'buckets',
			bucketsN: 3,
		})) as { content: Array<{ text: string }> };

		const text = res.content[0].text;
		expect(text).toContain('スパン1440分');
		expect(text).toContain(`実カバー${EXPECTED_COVERED_MIN}分`);
		expect(text).toContain(`欠損${EXPECTED_GAP_MIN}分`);
		expect(text).toContain('要求1440分');
		// 取得層 / 計算層の両方が content に出る（LLM は structuredContent を読めない）
		expect(text).toContain('カバレッジ');
		expect(text).toContain('集計値');
	});

	it('analyze_volume_profile: timeRange が実カバー区間を反映する', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await analyzeVolumeProfile('btc_jpy', 24, 500, 20, 0.7);

		assertOk(res);
		const tr = res.data.params.timeRange;
		expect(tr.durationMin).toBe(1440);
		expect(tr.coveredMin).toBe(EXPECTED_COVERED_MIN);
		expect(tr.gapMin).toBe(EXPECTED_GAP_MIN);
		expect(tr.segments).toBe(2);
		expect(tr.requestedMin).toBe(1440);
		expect(res.summary).toContain(`スパン1440分/実カバー${EXPECTED_COVERED_MIN}分`);
		expect(res.meta.warning).toContain('カバレッジ');
		expect(res.meta.warnings?.[0]).toContain('集計値');
	});

	it('欠損が無ければカバレッジ warning は出ない（誤検知しない）', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		// latest がアーカイブ末尾に連続する（＝穴なし）ケース
		const contiguousLatest = buildTxs(ARCHIVE_START + ARCHIVE_COUNT * 20_000, LATEST_COUNT, 20_000, 900_001);
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
			const u = String(url);
			if (u.endsWith('/transactions/20260707')) return jsonRes(payload(ARCHIVE_TXS));
			if (u.endsWith('/transactions')) return jsonRes(payload(contiguousLatest));
			return jsonRes({ success: 0, data: { code: 10000 } }, 404);
		});

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', 24);

		assertOk(res);
		expect(res.meta.actualRange?.gapMinutes).toBe(0);
		expect(res.meta.actualRange?.segments).toBe(1);
		expect(res.meta.warning).not.toContain('カバレッジ');
		expect(res.meta.warnings).toBeUndefined();
	});
});

/**
 * 欠損バケットの扱い（PR#8 のカバレッジ申告で露見した後続不具合）
 *
 * バケット分割は欠損区間をゼロ埋めするため、旧実装では
 *   (A) `total=0` が「約定ゼロ」なのか「データなし」なのか応答から判別できない
 *       （view=compact では欠損区間が黙って消える）
 *   (B) ゼロ埋めが Z スコアの母集団に入り、平均が押し下げられて欠損明けの
 *       通常バケットが偽スパイクとして検出される
 * という 2 つの誤読を生んでいた。
 */
describe('欠損バケット（hasData）', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('欠損区間のバケットは hasData=false / zscore=null / spike=null になる', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', 24);

		assertOk(res);
		const buckets = res.data.series.buckets;
		const gapBuckets = buckets.filter((b) => b.hasData === false);
		expect(gapBuckets.length).toBeGreaterThan(0);
		// 観測が無い区間に Z スコアは定義できない。0 でも負値でもなく null
		expect(gapBuckets.every((b) => b.zscore === null)).toBe(true);
		expect(gapBuckets.every((b) => b.spike === null)).toBe(true);
		expect(gapBuckets.every((b) => b.totalVolume === 0)).toBe(true);
	});

	it('データのあるバケットは hasData=true（ゼロ出来高でも欠損扱いしない）', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', 24);

		assertOk(res);
		const buckets = res.data.series.buckets;
		// アーカイブ区間は 20 秒間隔なので全バケットに約定がある
		expect(buckets.filter((b) => b.hasData !== false).every((b) => b.zscore !== null)).toBe(true);
		// 欠損バケット数は meta の gapMinutes とおおむね一致する（bucketMs=1分）
		const gapCount = buckets.filter((b) => b.hasData === false).length;
		expect(Math.abs(gapCount - (res.meta.actualRange?.gapMinutes ?? 0))).toBeLessThanOrEqual(2);
	});

	it('Z スコアの母集団から欠損バケットが除外される（偽スパイクを出さない）', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', 24);

		assertOk(res);
		const buckets = res.data.series.buckets;
		const dataBuckets = buckets.filter((b) => b.hasData !== false);
		// 母集団 = データのあるバケットのみ。その平均を実測から再計算して突き合わせる
		const mean = dataBuckets.reduce((s, b) => s + b.totalVolume, 0) / dataBuckets.length;
		const variance = dataBuckets.reduce((s, b) => s + (b.totalVolume - mean) ** 2, 0) / dataBuckets.length;
		const stdev = Math.sqrt(variance);
		const sample = dataBuckets.find((b) => b.totalVolume > 0);
		if (!sample) throw new Error('data bucket should exist');
		expect(sample.zscore).toBeCloseTo(Number(((sample.totalVolume - mean) / stdev).toFixed(2)), 2);

		// 全バケット基準（旧実装）の平均は欠損ゼロ埋めで押し下げられる
		const meanAll = buckets.reduce((s, b) => s + b.totalVolume, 0) / buckets.length;
		expect(meanAll).toBeLessThan(mean);
	});

	it('欠損明けの最初のバケットが偽スパイクにならない（同量の約定なら spike なし）', async () => {
		// アーカイブ区間と latest 区間で 1 バケットあたりの出来高を揃えたフィクスチャ。
		// 旧実装ではゼロ埋めで平均が下がり、欠損明けバケットの Z スコアが跳ねていた。
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		const uniform = (startMs: number, count: number, idBase: number): RawTx[] =>
			Array.from({ length: count }, (_, i) => ({
				transaction_id: idBase + i,
				price: '5000000',
				amount: '0.01',
				side: 'buy',
				executed_at: String(startMs + i * 60_000),
			}));
		// 8:30 UTC の 24h 窓に収まるよう、アーカイブは 200 分・latest は 30 分ぶん
		const archive = uniform(Date.UTC(2026, 6, 7, 10, 0, 0), 200, 1);
		const latest = uniform(NOW - 30 * 60_000, 30, 900_001);
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
			const u = String(url);
			if (u.endsWith('/transactions/20260707')) return jsonRes(payload(archive));
			if (u.endsWith('/transactions')) return jsonRes(payload(latest));
			return jsonRes({ success: 0, data: { code: 10000 } }, 404);
		});

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', 24);

		assertOk(res);
		const buckets = res.data.series.buckets;
		const firstAfterGap = buckets.findIndex((b, i) => i > 0 && b.hasData !== false && buckets[i - 1].hasData === false);
		expect(firstAfterGap).toBeGreaterThan(0);
		// 全バケット同量なので、欠損を除けば分散 0 → スパイクは検出されない
		expect(buckets[firstAfterGap].spike).toBeNull();
		expect(buckets.filter((b) => b.spike !== null)).toHaveLength(0);
	});
});

/**
 * limit による切り捨ての申告
 *
 * 件数ベース取得（date 指定 / 件数指定）は最新側 limit 件に切るが、旧実装はこれを
 * **無言で**行っていた。1 UTC 日は BTC/JPY で 5,600〜8,000 件あるのに limit 上限は 2000 の
 * ため、`date=YYYYMMDD` 指定では 1 日の 1/3 程度しか集計に入らない。しかも
 * `meta.actualRange` が「実カバー = スパン」を報告するため、**完全にカバーしたように見えて
 * いた**（#8/#9 で入れたカバレッジ申告が、切り捨てには反応しなかった）。
 */
describe('limit 切り捨ての申告', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('date 指定: 切り捨てを meta.truncated / totalAvailable で明示する', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getFlowMetrics('btc_jpy', 100, '20260707', 60_000);

		assertOk(res);
		expect(res.data.aggregates.totalTrades).toBe(100);
		expect(res.meta.totalAvailable).toBe(ARCHIVE_COUNT);
		expect(res.meta.truncated).toBe(true);
	});

	it('date 指定: warning に件数・limit・hours への誘導が入る', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getFlowMetrics('btc_jpy', 100, '20260707', 60_000);

		assertOk(res);
		expect(res.meta.warning).toContain('date=20260707（UTC 暦日）');
		expect(res.meta.warning).toContain(`${ARCHIVE_COUNT}件`);
		expect(res.meta.warning).toContain('limit=100');
		// 1 日全体を見る代替手段まで案内する
		expect(res.meta.warning).toContain('hours');
	});

	it('date 指定: 要求スコープは UTC 暦日（1440分）としてカバー率が出る', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getFlowMetrics('btc_jpy', 100, '20260707', 60_000);

		assertOk(res);
		const range = res.meta.actualRange;
		// 100件 × 20秒間隔 = 約33分。1 UTC 日 1440 分のごく一部しか見ていないことが数値に出る
		expect(range?.requestedMinutes).toBe(1440);
		expect(range?.coveredMinutes).toBeLessThan(60);
		expect(range?.coveragePct).toBeLessThan(5);
	});

	it('切り捨てが無ければ truncated=false で warning も出さない（誤検知しない）', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		const small = buildTxs(ARCHIVE_START, 50, 20_000, 1);
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
			const u = String(url);
			if (u.endsWith('/transactions/20260707')) return jsonRes(payload(small));
			if (u.endsWith('/transactions')) return jsonRes(payload(LATEST_TXS));
			return jsonRes({ success: 0, data: { code: 10000 } }, 404);
		});

		const res = await getFlowMetrics('btc_jpy', 100, '20260707', 60_000);

		assertOk(res);
		expect(res.data.aggregates.totalTrades).toBe(50);
		expect(res.meta.truncated).toBe(false);
		expect(res.meta.totalAvailable).toBe(50);
		expect(res.meta.warning ?? '').not.toContain('limit=');
	});

	it('件数ベース（latest + 補完）: 切り捨てを申告する', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000);

		assertOk(res);
		expect(res.data.aggregates.totalTrades).toBe(100);
		expect(res.meta.truncated).toBe(true);
		expect(res.meta.totalAvailable).toBe(TOTAL_TRADES);
		expect(res.meta.warning).toContain('latest + 完了済み UTC 日アーカイブ');
	});

	it('件数ベース（latest のみで足りる）: 切り捨てを申告する', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		// latest は 60 件返す → limit=10 なら latest だけで足り、50 件が切り捨てられる
		const res = await getFlowMetrics('btc_jpy', 10, undefined, 60_000);

		assertOk(res);
		expect(res.data.aggregates.totalTrades).toBe(10);
		expect(res.meta.truncated).toBe(true);
		expect(res.meta.totalAvailable).toBe(LATEST_COUNT);
		expect(res.meta.warning).toContain('/transactions (latest)');
	});

	it('hours 指定では limit を適用しないため truncated を立てない', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', 24);

		assertOk(res);
		expect(res.data.aggregates.totalTrades).toBe(TOTAL_TRADES);
		expect(res.meta.truncated).toBeUndefined();
		expect(res.meta.totalAvailable).toBeUndefined();
	});

	it('analyze_volume_profile: 件数ベースの切り捨てを申告する', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await analyzeVolumeProfile('btc_jpy', 0, 100, 20, 0.7);

		assertOk(res);
		expect(res.data.params.totalTrades).toBe(100);
		expect(res.meta.truncated).toBe(true);
		expect(res.meta.totalAvailable).toBe(TOTAL_TRADES);
		expect(res.summary).toContain('limit=100');
	});
});
