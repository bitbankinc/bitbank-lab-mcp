/**
 * since / until による絶対時刻区間指定（get_flow_metrics / analyze_volume_profile）
 *
 * 背景（実測 2026-08-02）: 過去の特定区間を全件取る手段が無かった。
 *   - hours（最大24）は**現在時刻起点**。過去の任意区間を指定できない。
 *   - date（UTC 暦日）は limit 上限 2000 で切り捨てられる。BTC/JPY の 1 UTC 日は
 *     5,600〜8,000 件あるため 1 日の 1/3 程度しか取れない
 *     （`get_flow_metrics(date=20260801, limit=2000)` が UTC 8/1 の 4,781 件のうち
 *     末尾 2,000 件＝8.3 時間分のみを返した）。
 *
 * ここでは getTransactions をモックせず **上流 fetch だけ** をモックし、実際の limit 適用
 * ロジックを通したうえで区間の全件が集計されることを固定する（tx-aggregation-cap.test.ts
 * と同じパターン）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import analyzeVolumeProfile from '../tools/analyze_volume_profile.js';
import getFlowMetrics, { toolDef } from '../tools/get_flow_metrics.js';
import { assertFail, assertOk } from './_assertResult.js';

/** 2026-08-02 21:00 JST = 2026-08-02 12:00 UTC。進行中 UTC 日 = 20260802、完了済み = 20260801 */
const NOW = Date.UTC(2026, 7, 2, 12, 0, 0);

/** 完了済み UTC 日 20260801 の丸 1 日を 20 秒間隔で埋める（4,320 件 = limit 上限 2000 超） */
const DAY_START = Date.UTC(2026, 7, 1, 0, 0, 0);
const DAY_STEP_MS = 20_000;
const DAY_COUNT = 4320;
const LATEST_COUNT = 60;

type RawTx = { transaction_id: number; price: string; amount: string; side: string; executed_at: string };

function buildTxs(startMs: number, count: number, stepMs: number, idBase: number): RawTx[] {
	return Array.from({ length: count }, (_, i) => ({
		transaction_id: idBase + i,
		price: i % 2 === 0 ? '5000000' : '6000000',
		amount: i % 2 === 0 ? '0.02' : '0.01',
		side: i % 2 === 0 ? 'buy' : 'sell',
		executed_at: String(startMs + i * stepMs),
	}));
}

const DAY_TXS = buildTxs(DAY_START, DAY_COUNT, DAY_STEP_MS, 1);
/** 進行中 UTC 日の直近 60 件（1 秒間隔 ≒ 1 分ぶん）。bitbank の latest はこの程度しか返さない */
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

/** 上流 fetch のモック。呼ばれた URL を記録して呼び出し回数の固定に使う */
function mockUpstream() {
	const urls: string[] = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
		const u = String(url);
		urls.push(u);
		if (u.endsWith('/transactions/20260801')) return jsonRes(payload(DAY_TXS));
		if (u.endsWith('/transactions')) return jsonRes(payload(LATEST_TXS));
		return jsonRes({ success: 0, data: { code: 10000 } }, 404);
	});
	return urls;
}

/** UTC 8/1 の丸 1 日（until は排他なので 8/2 00:00 が終端） */
const SINCE_DAY = '2026-08-01T00:00:00Z';
const UNTIL_DAY = '2026-08-02T00:00:00Z';

describe('since/until: 過去の完了済み UTC 日を全件集計する', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('get_flow_metrics: 区間の全件が集計され limit で切り捨てられない', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', undefined, {
			since: SINCE_DAY,
			until: UNTIL_DAY,
		});

		assertOk(res);
		// limit=100 / limit 上限 2000 のいずれにも切られない
		expect(res.data.aggregates.totalTrades).toBe(DAY_COUNT);
		expect(res.meta.truncated).toBeUndefined();
		expect(res.meta.totalAvailable).toBeUndefined();
		expect(res.meta.mode).toBe('absolute_range');
		expect(res.meta.range).toEqual({ since: '2026-08-01T00:00:00.000Z', until: '2026-08-02T00:00:00.000Z' });
	});

	it('get_flow_metrics: coveragePct が 95% 以上でカバレッジ警告が出ない（誤検知しない）', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', undefined, {
			since: SINCE_DAY,
			until: UNTIL_DAY,
		});

		assertOk(res);
		const range = res.meta.actualRange;
		expect(range?.requestedMinutes).toBe(1440);
		expect(range?.coveragePct).toBeGreaterThanOrEqual(95);
		expect(range?.gapMinutes).toBe(0);
		expect(range?.segments).toBe(1);
		// 取得層・計算層とも警告なし
		expect(res.meta.warning).toBeUndefined();
		expect(res.meta.warnings).toBeUndefined();
	});

	it('get_flow_metrics: 過去区間のみの要求では latest を叩かない', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		const urls = mockUpstream();

		await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', undefined, {
			since: SINCE_DAY,
			until: UNTIL_DAY,
		});

		// アーカイブ 1 日ぶんのみ。latest（/transactions）は区間外の約定しか返さないので叩かない
		expect(urls).toHaveLength(1);
		expect(urls[0]).toMatch(/\/transactions\/20260801$/);
	});

	it('get_flow_metrics: 進行中 UTC 日の補完注記は過去区間では出さない', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', undefined, {
			since: SINCE_DAY,
			until: UNTIL_DAY,
		});

		assertOk(res);
		expect(res.meta.warning ?? '').not.toContain('進行中の UTC 日');
	});

	it('get_flow_metrics: 複数の完了済み UTC 日を跨ぐ区間も全件集計する', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		const day0731 = buildTxs(Date.UTC(2026, 6, 31, 0, 0, 0), DAY_COUNT, DAY_STEP_MS, 500_001);
		const urls: string[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
			const u = String(url);
			urls.push(u);
			if (u.endsWith('/transactions/20260801')) return jsonRes(payload(DAY_TXS));
			if (u.endsWith('/transactions/20260731')) return jsonRes(payload(day0731));
			return jsonRes({ success: 0, data: { code: 10000 } }, 404);
		});

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', undefined, {
			since: '2026-07-31T00:00:00Z',
			until: UNTIL_DAY,
		});

		assertOk(res);
		expect(res.data.aggregates.totalTrades).toBe(DAY_COUNT * 2);
		expect(res.meta.actualRange?.requestedMinutes).toBe(2880);
		expect(res.meta.actualRange?.coveragePct).toBeGreaterThanOrEqual(95);
		expect(urls).toHaveLength(2);
		expect(urls.some((u) => u.endsWith('/transactions'))).toBe(false);
	});

	it('get_flow_metrics: until 排他 — 終端ちょうどの約定は次区間に属する（二重計上しない）', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		// 8/1 の丸 1 日 + 8/2 00:00:00.000 ちょうどの 1 件（8/1 のアーカイブに紛れている想定）
		const boundary: RawTx = {
			transaction_id: 999_999,
			price: '5000000',
			amount: '0.02',
			side: 'buy',
			executed_at: String(Date.UTC(2026, 7, 2, 0, 0, 0)),
		};
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
			const u = String(url);
			if (u.endsWith('/transactions/20260801')) return jsonRes(payload([...DAY_TXS, boundary]));
			if (u.endsWith('/transactions')) return jsonRes(payload(LATEST_TXS));
			return jsonRes({ success: 0, data: { code: 10000 } }, 404);
		});

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', undefined, {
			since: SINCE_DAY,
			until: UNTIL_DAY,
		});

		assertOk(res);
		expect(res.data.aggregates.totalTrades).toBe(DAY_COUNT);
	});

	it('get_flow_metrics handler: content テキストに要求区間とカバレッジが出る', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = (await toolDef.handler({
			pair: 'btc_jpy',
			bucketMs: 60_000,
			since: SINCE_DAY,
			until: UNTIL_DAY,
			view: 'buckets',
			bucketsN: 3,
		})) as { content: Array<{ text: string }> };

		const text = res.content[0].text;
		expect(text).toContain('要求1440分');
		expect(text).toContain('実カバー');
		expect(text).toContain(`trades=${DAY_COUNT}`);
	});

	it('analyze_volume_profile: 区間の全件が VWAP / プロファイルに入る', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		const urls = mockUpstream();

		const res = await analyzeVolumeProfile('btc_jpy', undefined, 500, 20, 0.7, 'Asia/Tokyo', {
			since: SINCE_DAY,
			until: UNTIL_DAY,
		});

		assertOk(res);
		expect(res.data.params.totalTrades).toBe(DAY_COUNT);
		expect(res.data.params.timeRange.requestedMin).toBe(1440);
		expect(res.data.params.timeRange.gapMin).toBe(0);
		expect(res.meta.truncated).toBeUndefined();
		expect(res.meta.mode).toBe('absolute_range');
		expect(res.meta.range).toEqual({ since: '2026-08-01T00:00:00.000Z', until: '2026-08-02T00:00:00.000Z' });
		expect(res.meta.warning).toBeUndefined();
		expect(res.meta.warnings).toBeUndefined();
		// 過去区間のみなので latest は叩かない
		expect(urls).toHaveLength(1);
		expect(urls[0]).toMatch(/\/transactions\/20260801$/);
	});
});

describe('since/until: 進行中 UTC 日にかかる区間', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('get_flow_metrics: latest 補完が働き、カバレッジ不足が既存の warning で申告される', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		const urls = mockUpstream();

		// UTC 8/2 00:00 〜 12:00（= NOW）は進行中 UTC 日。アーカイブ未公開で latest 約60件のみ
		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', undefined, {
			since: '2026-08-02T00:00:00Z',
			until: '2026-08-02T12:00:00Z',
		});

		assertOk(res);
		expect(urls).toEqual([expect.stringMatching(/\/transactions$/)]);
		expect(res.data.aggregates.totalTrades).toBe(LATEST_COUNT);
		const range = res.meta.actualRange;
		expect(range?.requestedMinutes).toBe(720);
		expect(range?.coveragePct).toBeLessThan(5);
		// 取得層: 進行中 UTC 日の制約 + カバー率の定量表示
		expect(res.meta.warning).toContain('進行中の UTC 日 (20260802)');
		expect(res.meta.warning).toContain('カバレッジ: 要求 720分');
		// 計算層: 集計値が窓全体を代表しないこと
		expect(res.meta.warnings?.[0]).toContain('要求した時間窓（720分）全体を代表する値ではありません');
	});

	it('get_flow_metrics: until 省略時は現在時刻までを要求区間とする', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		mockUpstream();

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', undefined, {
			since: '2026-08-02T06:00:00Z',
		});

		assertOk(res);
		expect(res.meta.actualRange?.requestedMinutes).toBe(360);
		expect(res.meta.range?.until).toBe('2026-08-02T12:00:00.000Z');
	});

	it('get_flow_metrics: 完了済み UTC 日 + 進行中 UTC 日を跨ぐ区間', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		const urls = mockUpstream();

		const res = await getFlowMetrics('btc_jpy', 100, undefined, 60_000, 'Asia/Tokyo', undefined, {
			since: SINCE_DAY,
			until: '2026-08-02T12:00:00Z',
		});

		assertOk(res);
		expect(res.data.aggregates.totalTrades).toBe(DAY_COUNT + LATEST_COUNT);
		expect(urls).toHaveLength(2);
		expect(urls.some((u) => u.endsWith('/transactions'))).toBe(true);
		// 進行中 UTC 日の 11 時間ぶんは取得不能 → 欠損として申告される
		expect(res.meta.actualRange?.requestedMinutes).toBe(2160);
		expect(res.meta.actualRange?.gapMinutes).toBeGreaterThan(600);
		expect(res.meta.warning).toContain('カバレッジ');
	});
});

describe('since/until: 入力バリデーション', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/** バリデーションは fetch より前に効くので上流モックは不要 */
	const callFlow = (range: { since?: string; until?: string }, hours?: number, date?: string) =>
		getFlowMetrics('btc_jpy', 100, date, 60_000, 'Asia/Tokyo', hours, range);

	it('hours との併用は user エラー（暗黙の優先順位を持たせない）', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);

		const res = await callFlow({ since: SINCE_DAY, until: UNTIL_DAY }, 4);

		assertFail(res);
		expect(res.meta.errorType).toBe('user');
		expect(res.summary).toContain('hours と since/until は併用できません');
	});

	it('date との併用は user エラー', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);

		const res = await callFlow({ since: SINCE_DAY }, undefined, '20260801');

		assertFail(res);
		expect(res.meta.errorType).toBe('user');
		expect(res.summary).toContain('date と since/until は併用できません');
	});

	it('until 単独指定は user エラー', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);

		const res = await callFlow({ until: UNTIL_DAY });

		assertFail(res);
		expect(res.summary).toContain('until 単独では取得区間が決まりません');
	});

	it('since > until は user エラー', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);

		const res = await callFlow({ since: UNTIL_DAY, until: SINCE_DAY });

		assertFail(res);
		expect(res.summary).toContain('since は until より前の時刻を指定してください');
	});

	it('since === until（長さ 0 の区間）は user エラー', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);

		const res = await callFlow({ since: SINCE_DAY, until: SINCE_DAY });

		assertFail(res);
		expect(res.summary).toContain('since は until より前の時刻を指定してください');
	});

	it('未来の since は user エラー', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);

		const res = await callFlow({ since: '2026-08-03T00:00:00Z' });

		assertFail(res);
		expect(res.summary).toContain('since が未来時刻です');
	});

	it('未来の until は user エラー（現在までなら until 省略を案内する）', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);

		const res = await callFlow({ since: SINCE_DAY, until: '2026-08-03T00:00:00Z' });

		assertFail(res);
		expect(res.summary).toContain('until が未来時刻です');
		expect(res.summary).toContain('until を省略');
	});

	it('YYYYMMDD 形式は user エラー（暦の取り違えを持ち込まない）', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);

		const res = await callFlow({ since: '20260801' });

		assertFail(res);
		expect(res.summary).toContain('オフセット付き ISO8601');
	});

	it('オフセットなし ISO8601 は user エラー', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);

		const res = await callFlow({ since: '2026-08-01T00:00:00' });

		assertFail(res);
		expect(res.summary).toContain('オフセット付き ISO8601');
	});

	it('存在しない日時は user エラー', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);

		const res = await callFlow({ since: '2026-02-30T00:00:00Z' });

		assertFail(res);
		expect(res.summary).toContain('存在しない日付・時刻');
	});

	it('最大範囲（7日）超過は user エラー', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);

		const res = await callFlow({ since: '2026-07-25T11:00:00Z', until: '2026-08-02T12:00:00Z' });

		assertFail(res);
		expect(res.meta.errorType).toBe('user');
		expect(res.summary).toContain('7 日');
		expect(res.summary).toContain('分割');
	});

	it('analyze_volume_profile も同じバリデーションを通る', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);

		const res = await analyzeVolumeProfile('btc_jpy', 4, 500, 20, 0.7, 'Asia/Tokyo', { since: SINCE_DAY });

		assertFail(res);
		expect(res.meta.errorType).toBe('user');
		expect(res.summary).toContain('hours と since/until は併用できません');
	});
});
