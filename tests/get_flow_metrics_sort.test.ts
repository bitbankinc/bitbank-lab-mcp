/**
 * get_flow_metrics の加工契約テスト（PR4）
 *
 * 取得パスごとの内部 sort 依存を解消し、全ての取得パスで timestampMs 昇順 sort が
 * 保証されることを契約として検証する。
 *
 * 上流 get_transactions も内部で sort 済みだが、契約の単一ソースは get_flow_metrics 側に
 * 置きたい（防御層）。そのため getTransactions をモックして「上流が未 sort で返した場合でも
 * get_flow_metrics の出力は昇順 sort される」ことを直接確認する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../lib/datetime.js';

vi.mock('../tools/get_transactions.js', () => ({
	default: vi.fn(),
}));

import getFlowMetrics, { toolDef } from '../tools/get_flow_metrics.js';
import getTransactions from '../tools/get_transactions.js';
import { asMockResult, assertOk } from './_assertResult.js';
import { asMcp } from './helpers/mcp.js';

type MockTx = {
	price: number;
	amount: number;
	side: 'buy' | 'sell';
	timestampMs: number;
	isoTime: string;
};

/** 意図的に降順に並べた約定列を作る（上流が未 sort で返したケースをシミュレート） */
function buildUnsortedTxs(count: number, startMs: number = Date.UTC(2024, 0, 1)): MockTx[] {
	const txs: MockTx[] = [];
	for (let i = 0; i < count; i++) {
		const ts = startMs + i * 60_000;
		txs.push({
			price: 5_000_000 + i,
			amount: 0.1,
			side: i % 2 === 0 ? 'buy' : 'sell',
			timestampMs: ts,
			isoTime: dayjs(ts).toISOString(),
		});
	}
	// 降順に並び替える
	return txs.reverse();
}

function mockOk(txs: MockTx[]) {
	return {
		ok: true,
		summary: 'ok',
		data: { normalized: txs },
		meta: { count: txs.length },
	};
}

function isAscending(arr: number[]): boolean {
	for (let i = 1; i < arr.length; i++) {
		if (arr[i] < arr[i - 1]) return false;
	}
	return true;
}

describe('get_flow_metrics: 加工契約 — timestampMs 昇順 sort', () => {
	const mocked = vi.mocked(getTransactions);

	afterEach(() => {
		vi.resetAllMocks();
	});

	it('date 指定成功時: 上流が降順で返してもバケットは昇順', async () => {
		const txs = buildUnsortedTxs(10);
		mocked.mockResolvedValueOnce(asMockResult(mockOk(txs)));

		const res = await getFlowMetrics('btc_jpy', 10, '20240101', 60_000);
		assertOk(res);
		const tss = res.data.series.buckets.map((b: { timestampMs: number }) => b.timestampMs);
		expect(tss.length).toBeGreaterThan(0);
		expect(isAscending(tss)).toBe(true);
	});

	it('latest 取得 (latestTxs.length >= limit) 時: 降順入力でも昇順出力', async () => {
		const txs = buildUnsortedTxs(20);
		// date 未指定 → 1 回目 = latest
		mocked.mockResolvedValueOnce(asMockResult(mockOk(txs)));

		// limit <= 20 なら supplement に進まず latestTxs を直接採用
		const res = await getFlowMetrics('btc_jpy', 10, undefined, 60_000);
		assertOk(res);
		const tss = res.data.series.buckets.map((b: { timestampMs: number }) => b.timestampMs);
		expect(tss.length).toBeGreaterThan(0);
		expect(isAscending(tss)).toBe(true);
		// 補完取得は呼ばれない
		expect(mocked).toHaveBeenCalledTimes(1);
	});

	it('latest + supplement マージ時: 降順入力でも昇順出力（既存 sort 維持）', async () => {
		const baseMs = Date.UTC(2024, 0, 1);
		const dayMs = 86_400_000;
		const latestTxs = buildUnsortedTxs(5, baseMs + 2 * dayMs);
		const supplementTxs = buildUnsortedTxs(5, baseMs + 1 * dayMs);
		// 1 回目 = latest, 2 回目 = supplement-1
		mocked.mockResolvedValueOnce(asMockResult(mockOk(latestTxs)));
		mocked.mockResolvedValueOnce(asMockResult(mockOk(supplementTxs)));

		// limit=10 > latestTxs.length=5 → supplement 経路に入る
		const res = await getFlowMetrics('btc_jpy', 10, undefined, 60_000);
		assertOk(res);
		const tss = res.data.series.buckets.map((b: { timestampMs: number }) => b.timestampMs);
		expect(tss.length).toBeGreaterThan(0);
		expect(isAscending(tss)).toBe(true);
	});

	it('handler 経由でも昇順 sort が保たれる', async () => {
		const txs = buildUnsortedTxs(10);
		mocked.mockResolvedValueOnce(asMockResult(mockOk(txs)));

		const res = asMcp<{ data: { series: { buckets: Array<{ timestampMs: number }> } } }>(
			await toolDef.handler({
				pair: 'btc_jpy',
				limit: 10,
				date: '20240101',
				bucketMs: 60_000,
				view: 'full',
			}),
		);
		const tss = res.structuredContent.data.series.buckets.map((b) => b.timestampMs);
		expect(tss.length).toBeGreaterThan(0);
		expect(isAscending(tss)).toBe(true);
	});
});

describe('get_flow_metrics: 重複除去キー仕様', () => {
	const mocked = vi.mocked(getTransactions);

	afterEach(() => {
		vi.resetAllMocks();
	});

	it('description に重複除去キー仕様 (timestampMs:price:amount:side) が明記されている', () => {
		expect(toolDef.description).toContain('timestampMs:price:amount:side');
		expect(toolDef.description).toContain('transaction_id');
	});

	it('handler 出力（view=summary）の footer に加工契約の説明が含まれる', async () => {
		const txs = buildUnsortedTxs(3);
		mocked.mockResolvedValueOnce(asMockResult(mockOk(txs)));
		const res = (await toolDef.handler({
			pair: 'btc_jpy',
			limit: 3,
			date: '20240101',
			bucketMs: 60_000,
			view: 'summary',
		})) as { content: Array<{ text: string }> };
		// view=summary は res.summary をそのまま返す。buildFlowMetricsText の footer に
		// 加工契約（sort / 重複除去キー）の説明が含まれている。
		const text = res.content[0].text;
		expect(text).toContain('加工契約');
		expect(text).toContain('timestampMs 昇順 sort');
		expect(text).toContain('timestampMs:price:amount:side');
	});

	it('latest と supplement で同じ約定 (transaction_id 違い) は重複除去される', async () => {
		// 同じ timestampMs/price/amount/side で transaction_id だけ異なる約定を返す。
		// get_transactions の normalized は transaction_id を含むが、
		// get_flow_metrics の dedup key は使用しない仕様。
		const baseMs = Date.UTC(2024, 0, 1);
		const dayMs = 86_400_000;
		const dupTx: MockTx & { transaction_id?: number } = {
			transaction_id: 1,
			price: 5_000_000,
			amount: 0.1,
			side: 'buy',
			timestampMs: baseMs + 2 * dayMs,
			isoTime: dayjs(baseMs + 2 * dayMs).toISOString(),
		};
		const dupTxAltId: MockTx & { transaction_id?: number } = {
			...dupTx,
			transaction_id: 2, // ID 違い、その他は同じ → 同一約定とみなされ重複除去
		};
		// latestTxs.length=1 < limit=10 → supplement 経路に進む
		const latestTxs = [dupTx];
		const supplementTxs = [dupTxAltId];
		mocked.mockResolvedValueOnce(asMockResult(mockOk(latestTxs as MockTx[])));
		mocked.mockResolvedValueOnce(asMockResult(mockOk(supplementTxs as MockTx[])));

		const res = await getFlowMetrics('btc_jpy', 10, undefined, 60_000);
		assertOk(res);
		// 重複除去後は 1 件のみ
		expect(res.data.aggregates.totalTrades).toBe(1);
	});
});
