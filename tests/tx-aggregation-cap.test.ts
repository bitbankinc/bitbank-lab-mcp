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
import getFlowMetrics from '../tools/get_flow_metrics.js';
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

	it('unlimited でもフィルタは limit 前に効く（フィルタ後の全件が返る）', async () => {
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
