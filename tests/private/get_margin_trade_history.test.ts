/**
 * get_margin_trade_history ツールのユニットテスト。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFail, assertOk } from '../_assertResult.js';
import { mockBitbankError, mockBitbankSuccess, rawMarginTradeHistoryResponse } from '../fixtures/private-api.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env.BITBANK_API_KEY;
	delete process.env.BITBANK_API_SECRET;
	vi.resetModules();
});

function setupFetchMock(response: unknown, status = 200) {
	globalThis.fetch = vi
		.fn()
		.mockResolvedValue(new Response(JSON.stringify(response), { status })) as unknown as typeof fetch;
}

/** 順次レスポンスを返す fetch モック。呼び出しごとに responses を順に消費する。 */
function setupSequentialFetchMock(responses: unknown[]) {
	const mockFn = vi.fn();
	for (const res of responses) {
		mockFn.mockResolvedValueOnce(new Response(JSON.stringify(res), { status: 200 }));
	}
	globalThis.fetch = mockFn as unknown as typeof fetch;
	return mockFn;
}

/** N 件の信用約定（position_side 付き）を生成するヘルパー */
function generateMarginTrades(
	n: number,
	baseId = 1,
	baseTimestamp = 1710000000000,
	positionSide: 'long' | 'short' = 'long',
) {
	return Array.from({ length: n }, (_, i) => ({
		trade_id: baseId + i,
		pair: 'btc_jpy',
		order_id: 5000 + baseId + i,
		side: i % 2 === 0 ? 'buy' : 'sell',
		position_side: positionSide,
		type: 'limit',
		amount: '0.01',
		price: '15000000',
		maker_taker: 'maker',
		fee_amount_base: '0.00001',
		fee_amount_quote: '0',
		executed_at: baseTimestamp + i * 1000,
	}));
}

/** N 件の現物約定（position_side なし）を生成するヘルパー */
function generateSpotTrades(n: number, baseId = 1, baseTimestamp = 1710000000000) {
	return Array.from({ length: n }, (_, i) => ({
		trade_id: baseId + i,
		pair: 'btc_jpy',
		order_id: 5000 + baseId + i,
		side: i % 2 === 0 ? 'buy' : 'sell',
		type: 'limit',
		amount: '0.01',
		price: '15000000',
		maker_taker: 'maker',
		fee_amount_base: '0.00001',
		fee_amount_quote: '0',
		executed_at: baseTimestamp + i * 1000,
	}));
}

describe('get_margin_trade_history', () => {
	it('信用約定履歴を返す', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginTradeHistoryResponse));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.data.trades).toHaveLength(3);
		expect(result.meta.tradeCount).toBe(3);
	});

	it('type=margin パラメータを API に渡す', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		await getMarginTradeHistory({});

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).toContain('type=margin');
	});

	it('executed_at を ISO8601 に変換する', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginTradeHistoryResponse));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		for (const trade of result.data.trades) {
			expect(trade.executed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		}
	});

	it('position_side をサマリーに含む', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginTradeHistoryResponse));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.summary).toContain('ロング');
		expect(result.summary).toContain('ショート');
	});

	it('決済時の profit_loss をサマリーに含む', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginTradeHistoryResponse));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.summary).toContain('損益');
		expect(result.summary).toContain('5,000');
	});

	it('pair 指定を API に渡す', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		await getMarginTradeHistory({ pair: 'btc_jpy' });

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).toContain('pair=btc_jpy');
	});

	it('count パラメータを API に渡す', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		await getMarginTradeHistory({ count: 50 });

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).toContain('count=50');
	});

	it('不正な since 日付で validation_error を返す', async () => {
		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ since: 'bad-date' });

		assertFail(result);
		expect(result.meta.errorType).toBe('validation_error');
		expect(result.summary).toContain('since');
	});

	it('不正な end 日付で validation_error を返す', async () => {
		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ end: 'not-a-date' });

		assertFail(result);
		expect(result.meta.errorType).toBe('validation_error');
		expect(result.summary).toContain('end');
	});

	it('有効な since/end を unix ms に変換して API に渡す', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		await getMarginTradeHistory({ since: '2024-03-10T00:00:00Z', end: '2024-03-11T00:00:00Z' });

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).toContain('since=');
		expect(calledUrl).toContain('end=');
		expect(calledUrl).not.toContain('2024-03-10');
	});

	it('ロング/ショートの集計をサマリーに含む', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginTradeHistoryResponse));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.summary).toContain('ロング 2件');
		expect(result.summary).toContain('ショート 1件');
	});

	it('10 件超の trades で省略表示される', async () => {
		const manyTrades = {
			trades: Array.from({ length: 15 }, (_, i) => ({
				trade_id: 400 + i,
				pair: 'btc_jpy',
				order_id: 4000 + i,
				side: 'buy',
				position_side: 'long',
				type: 'limit',
				amount: '0.01',
				price: '15000000',
				maker_taker: 'maker',
				fee_amount_base: '0.00001',
				fee_amount_quote: '0',
				executed_at: 1710000000000 + i * 1000,
			})),
		};
		setupFetchMock(mockBitbankSuccess(manyTrades));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.data.trades).toHaveLength(15);
		expect(result.meta.tradeCount).toBe(15);
		expect(result.summary).toContain('他 5件');
	});

	it('order=asc 時は末尾 10 件を表示する', async () => {
		const manyTrades = {
			trades: Array.from({ length: 12 }, (_, i) => ({
				trade_id: 500 + i,
				pair: 'btc_jpy',
				order_id: 5000 + i,
				side: 'buy',
				position_side: 'long',
				type: 'limit',
				amount: '0.01',
				price: '15000000',
				maker_taker: 'maker',
				fee_amount_base: '0.00001',
				fee_amount_quote: '0',
				executed_at: 1710000000000 + i * 1000,
			})),
		};
		setupFetchMock(mockBitbankSuccess(manyTrades));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ order: 'asc' });

		assertOk(result);
		// asc 時は末尾 10 件（trade_id 502〜511）が表示される
		expect(result.summary).toContain('trade: 502');
		expect(result.summary).not.toContain('trade: 500]');
		expect(result.summary).not.toContain('trade: 501]');
	});

	it('count がデフォルト値 (20) の場合はパラメータを送らない', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		await getMarginTradeHistory({});

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).not.toContain('count=');
	});

	it('order がデフォルト値 (desc) の場合はパラメータを送らない', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		await getMarginTradeHistory({});

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).not.toContain('order=');
	});

	it('order=asc を API に渡す', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		await getMarginTradeHistory({ order: 'asc' });

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).toContain('order=asc');
	});

	it('profit_loss がないトレード（新規建て）は損益を表示しない', async () => {
		const openOnly = {
			trades: [
				{
					trade_id: 601,
					pair: 'btc_jpy',
					order_id: 6001,
					side: 'buy',
					position_side: 'long',
					type: 'limit',
					amount: '0.01',
					price: '15000000',
					maker_taker: 'maker',
					fee_amount_base: '0.00001',
					fee_amount_quote: '0',
					executed_at: 1710000000000,
				},
			],
		};
		setupFetchMock(mockBitbankSuccess(openOnly));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.summary).not.toContain('損益');
	});

	it('fee_occurred_amount_quote が API レスポンスに含まれる場合、出力に伝播する', async () => {
		const response = {
			trades: [
				{
					trade_id: 801,
					pair: 'btc_jpy',
					order_id: 8001,
					side: 'sell',
					position_side: 'long',
					type: 'market',
					amount: '0.01',
					price: '15500000',
					maker_taker: 'taker',
					fee_amount_base: '0',
					fee_amount_quote: '500',
					fee_occurred_amount_quote: '500',
					executed_at: 1710000000000,
				},
			],
		};
		setupFetchMock(mockBitbankSuccess(response));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.data.trades[0].fee_occurred_amount_quote).toBe('500');
	});

	it('fee_occurred_amount_quote が API レスポンスに含まれない場合、undefined を伝播する（fallback しない）', async () => {
		const response = {
			trades: [
				{
					trade_id: 802,
					pair: 'btc_jpy',
					order_id: 8002,
					side: 'sell',
					position_side: 'long',
					type: 'market',
					amount: '0.01',
					price: '15500000',
					maker_taker: 'taker',
					fee_amount_base: '0',
					fee_amount_quote: '500',
					executed_at: 1710000000000,
				},
			],
		};
		setupFetchMock(mockBitbankSuccess(response));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.data.trades[0].fee_occurred_amount_quote).toBeUndefined();
		// fallback で fee_amount_quote の値で埋めないことを明示的にアサート
		expect(result.data.trades[0].fee_occurred_amount_quote).not.toBe(result.data.trades[0].fee_amount_quote);
	});

	it('空の trades で 0 件メッセージを返す', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.data.trades).toHaveLength(0);
		expect(result.meta.tradeCount).toBe(0);
		expect(result.summary).toContain('0件');
	});

	it('現物 (position_side 欠損) が混在しても信用のみを返し集計もフィルタ後の値', async () => {
		// 公式 docs に type=margin パラメータの記載がなく、API が無視した場合の防御。
		// position_side == null の現物約定が混入しても、フィルタで信用のみが残ること、
		// および「ロング X件 / ショート Y件」の集計もフィルタ後の値であることを検証する。
		const mixed = {
			trades: [
				{
					trade_id: 701,
					pair: 'btc_jpy',
					order_id: 7001,
					side: 'buy',
					position_side: 'long',
					type: 'limit',
					amount: '0.01',
					price: '15000000',
					maker_taker: 'maker',
					fee_amount_base: '0.00001',
					fee_amount_quote: '0',
					executed_at: 1710000000000,
				},
				// 現物約定（position_side なし）。フィルタで除外されるべき
				{
					trade_id: 702,
					pair: 'btc_jpy',
					order_id: 7002,
					side: 'buy',
					type: 'limit',
					amount: '0.01',
					price: '15000000',
					maker_taker: 'maker',
					fee_amount_base: '0.00001',
					fee_amount_quote: '0',
					fee_occurred_amount_quote: '500', // 現物の手数料が margin_fee に混入してはいけない
					executed_at: 1710000001000,
				},
				{
					trade_id: 703,
					pair: 'eth_jpy',
					order_id: 7003,
					side: 'sell',
					position_side: 'short',
					type: 'limit',
					amount: '1.0',
					price: '400000',
					maker_taker: 'maker',
					fee_amount_base: '0.001',
					fee_amount_quote: '0',
					executed_at: 1710000002000,
				},
			],
		};
		setupFetchMock(mockBitbankSuccess(mixed));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		// 現物が除外され信用 2 件のみ
		expect(result.data.trades).toHaveLength(2);
		expect(result.meta.tradeCount).toBe(2);
		const ids = result.data.trades.map((t) => t.trade_id);
		expect(ids).toEqual([701, 703]);
		// 全レコードに position_side が付与されている
		for (const t of result.data.trades) {
			expect(t.position_side).toBeDefined();
		}
		// 集計はフィルタ後の数（ロング 1 / ショート 1）
		expect(result.summary).toContain('信用約定履歴');
		expect(result.summary).toContain('2件');
		expect(result.summary).toContain('ロング 1件');
		expect(result.summary).toContain('ショート 1件');
	});

	it('全件現物（position_side 欠損）のレスポンスは 0 件メッセージを返す', async () => {
		const spotOnly = {
			trades: [
				{
					trade_id: 801,
					pair: 'btc_jpy',
					order_id: 8001,
					side: 'buy',
					type: 'limit',
					amount: '0.01',
					price: '15000000',
					maker_taker: 'maker',
					fee_amount_base: '0.00001',
					fee_amount_quote: '0',
					executed_at: 1710000000000,
				},
			],
		};
		setupFetchMock(mockBitbankSuccess(spotOnly));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.data.trades).toHaveLength(0);
		expect(result.meta.tradeCount).toBe(0);
		expect(result.summary).toContain('0件');
	});

	it('PrivateApiError で fail を返す', async () => {
		setupFetchMock(mockBitbankError(20001), 400);

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertFail(result);
		expect(result.meta.errorType).toBe('authentication_error');
	});

	it('非 PrivateApiError の例外で upstream_error を返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');
		expect(result.summary).toContain('fetch failed');
	});
});

describe('get_margin_trade_history — ページネーション', () => {
	it('単発リクエストで全件取得時は isComplete=true', async () => {
		// count=20 / レスポンス 10 件（全 margin）
		const trades = generateMarginTrades(10, 1);
		setupFetchMock(mockBitbankSuccess({ trades }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ count: 20 });

		assertOk(result);
		expect(result.data.trades).toHaveLength(10);
		expect(result.meta.isComplete).toBe(true);
	});

	it('単発リクエストで API 上限ヒット時は isComplete=false', async () => {
		// count=100 / レスポンス 100 件（生 batch.length が count に等しい）
		const trades = generateMarginTrades(100, 1);
		setupFetchMock(mockBitbankSuccess({ trades }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ count: 100 });

		assertOk(result);
		expect(result.data.trades).toHaveLength(100);
		expect(result.meta.isComplete).toBe(false);
		expect(result.summary).toContain('全件ではなく一部のみ取得されています');
	});

	it('単発リクエストで現物混入をフィルタしても isComplete は生 batch.length で判定する', async () => {
		// count=20 / レスポンス 20 件（margin 12 + spot 8）
		// 生 batch.length=20 は count と等しいので isComplete=false が正しい
		const margin = generateMarginTrades(12, 1, 1710000000000);
		const spot = generateSpotTrades(8, 100, 1710000020000);
		// 時系列順に混ぜる
		const trades = [...margin.slice(0, 6), ...spot.slice(0, 4), ...margin.slice(6), ...spot.slice(4)];
		setupFetchMock(mockBitbankSuccess({ trades }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ count: 20 });

		assertOk(result);
		// 現物 8 件は除外され、margin 12 件だけ残る
		expect(result.data.trades).toHaveLength(12);
		for (const t of result.data.trades) {
			expect(t.position_side).toBeDefined();
		}
		// 生 batch.length=20 ≧ count=20 なので isComplete=false
		expect(result.meta.isComplete).toBe(false);
	});

	it('asc: count > 1000 で複数ページを自動取得する（2 ページで完了）', async () => {
		// page1: 1000 件全 margin（満杯）, page2: 500 件全 margin（不足 → 完了）
		const page1 = generateMarginTrades(1000, 1, 1710000000000);
		const page2 = generateMarginTrades(500, 1001, 1710001000000);

		const mockFn = setupSequentialFetchMock([
			mockBitbankSuccess({ trades: page1 }),
			mockBitbankSuccess({ trades: page2 }),
		]);

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ count: 1500, order: 'asc' });

		assertOk(result);
		expect(result.data.trades).toHaveLength(1500);
		expect(result.meta.isComplete).toBe(true);
		expect(result.meta.tradeCount).toBe(1500);
		expect(mockFn.mock.calls.length).toBe(2);
		// 2 回目のリクエストは since 付き（page1 末尾の executed_at をそのまま使う）
		const secondUrl = mockFn.mock.calls[1][0] as string;
		const expectedSince = page1[page1.length - 1].executed_at;
		expect(secondUrl).toContain(`since=${expectedSince}`);
	});

	it('asc ページネーション: 最終ページが短くても limit 超過分を捨てたら isComplete=false', async () => {
		// バグ回帰防止 (CodeRabbit #458): 旧実装は batch.length < PAGE_SIZE を見ただけで
		// isComplete=true を返していたため、page1=1000+page2=800 で count=1500 を求めると
		// all=1800 → slice(0,1500) で 300 件捨てているのに isComplete=true と誤報していた。
		// スキーマ仕様「count 制限で打ち切られた場合は false」に合わせ、limit 超過時は
		// 必ず false を返すよう修正された。
		const page1 = generateMarginTrades(1000, 1, 1710000000000);
		const page2 = generateMarginTrades(800, 1001, 1710001000000);

		setupSequentialFetchMock([mockBitbankSuccess({ trades: page1 }), mockBitbankSuccess({ trades: page2 })]);

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ count: 1500, order: 'asc' });

		assertOk(result);
		expect(result.data.trades).toHaveLength(1500);
		expect(result.meta.isComplete).toBe(false);
		expect(result.summary).toContain('全件ではなく一部のみ取得されています');
	});

	it('asc ページネーション: 最終ページが短く all=limit ちょうどなら isComplete=true', async () => {
		// 境界条件: page1=1000 + page2=500 で count=1500 を完全充当（exhausted=true && all===limit）。
		// 捨てたレコードは無く、API 窓も使い切ったので isComplete=true。
		const page1 = generateMarginTrades(1000, 1, 1710000000000);
		const page2 = generateMarginTrades(500, 1001, 1710001000000);

		setupSequentialFetchMock([mockBitbankSuccess({ trades: page1 }), mockBitbankSuccess({ trades: page2 })]);

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ count: 1500, order: 'asc' });

		assertOk(result);
		expect(result.data.trades).toHaveLength(1500);
		expect(result.meta.isComplete).toBe(true);
	});

	it('asc ページネーション: limit 到達で打ち切り（isComplete=false）', async () => {
		// page1: 1000 件全 margin, page2: 1000 件全 margin → all=2000 が limit=1500 を超えるので slice
		const page1 = generateMarginTrades(1000, 1, 1710000000000);
		const page2 = generateMarginTrades(1000, 1001, 1710001000000);

		setupSequentialFetchMock([mockBitbankSuccess({ trades: page1 }), mockBitbankSuccess({ trades: page2 })]);

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ count: 1500, order: 'asc' });

		assertOk(result);
		expect(result.data.trades).toHaveLength(1500);
		expect(result.meta.isComplete).toBe(false);
		expect(result.summary).toContain('全件ではなく一部のみ取得されています');
	});

	it('asc ページネーション: 現物混入下で margin だけ集める', async () => {
		// page1: 1000 件（margin 600 + spot 400）, page2: 1000 件（margin 600 + spot 400）,
		// page3: 1000 件（margin 300 + spot 700, 終端ではない）
		// limit=1500 で打ち切り（margin 600+600+300=1500）
		const page1 = [...generateMarginTrades(600, 1, 1710000000000), ...generateSpotTrades(400, 5000, 1710000600000)];
		const page2 = [...generateMarginTrades(600, 601, 1710001000000), ...generateSpotTrades(400, 5400, 1710001600000)];
		const page3 = [...generateMarginTrades(300, 1201, 1710002000000), ...generateSpotTrades(700, 5800, 1710002300000)];

		setupSequentialFetchMock([
			mockBitbankSuccess({ trades: page1 }),
			mockBitbankSuccess({ trades: page2 }),
			mockBitbankSuccess({ trades: page3 }),
		]);

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ count: 1500, order: 'asc' });

		assertOk(result);
		// margin だけで 1500 件取得して打ち切り
		expect(result.data.trades).toHaveLength(1500);
		// 全て margin のみ（position_side 付き）
		for (const t of result.data.trades) {
			expect(t.position_side).toBeDefined();
		}
		// page3 末尾は届かない（limit で打ち切り）が、count を満たしただけなので isComplete=false
		expect(result.meta.isComplete).toBe(false);
	});

	it('asc ページネーション: カーソル停滞で打ち切り（isComplete=false）', async () => {
		// page1 全 margin 1000 件で末尾の executed_at が固定。page2 も末尾 executed_at が同じ
		// → nextSince === since となりカーソル停滞検知で打ち切る。
		const sameLastTs = 1710000999000;
		const page1 = Array.from({ length: 1000 }, (_, i) => ({
			trade_id: i + 1,
			pair: 'btc_jpy',
			order_id: 5000 + i,
			side: 'buy',
			position_side: 'long',
			type: 'limit',
			amount: '0.01',
			price: '15000000',
			maker_taker: 'maker',
			fee_amount_base: '0.00001',
			fee_amount_quote: '0',
			executed_at: i < 999 ? 1710000000000 + i * 1000 : sameLastTs,
		}));
		// page2: 末尾 executed_at が page1 と同じになる
		const page2 = Array.from({ length: 1000 }, (_, i) => ({
			trade_id: 1001 + i,
			pair: 'btc_jpy',
			order_id: 6001 + i,
			side: 'buy',
			position_side: 'long',
			type: 'limit',
			amount: '0.01',
			price: '15000000',
			maker_taker: 'maker',
			fee_amount_base: '0.00001',
			fee_amount_quote: '0',
			executed_at: sameLastTs,
		}));

		const mockFn = setupSequentialFetchMock([
			mockBitbankSuccess({ trades: page1 }),
			mockBitbankSuccess({ trades: page2 }),
		]);

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ count: 5000, order: 'asc' });

		assertOk(result);
		expect(result.meta.isComplete).toBe(false);
		// MAX_PAGES (10) より早く打ち切られたことを fetch 呼び出し回数で確認
		expect(mockFn.mock.calls.length).toBeLessThan(10);
	});

	it('count <= 1000 ちょうどで生 batch.length が count に等しいとき isComplete=false', async () => {
		// count=1000 ぴったり → 単発リクエスト経路、API 上限ヒット相当
		const trades = generateMarginTrades(1000, 1, 1710000000000);
		setupFetchMock(mockBitbankSuccess({ trades }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ count: 1000 });

		assertOk(result);
		expect(result.data.trades).toHaveLength(1000);
		expect(result.meta.isComplete).toBe(false);
	});

	it('空配列で isComplete=true（既存 0 件ケースの ok 応答に isComplete が含まれる）', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ count: 20 });

		assertOk(result);
		expect(result.data.trades).toHaveLength(0);
		expect(result.meta.isComplete).toBe(true);
	});

	it('desc ページネーション結果が API の desc 順そのままで返る', async () => {
		// API は desc 順で返すので、mock も desc 順（trade_id 大きい方が先頭）にする。
		// page1: trade_id 2000..1001 (1000件), page2: trade_id 1001..802 (200件、境界 1001 が重複)
		const page1 = generateMarginTrades(1000, 1001, 1710001999000).reverse();
		const page2 = generateMarginTrades(200, 802, 1710000801000).reverse();

		setupSequentialFetchMock([mockBitbankSuccess({ trades: page1 }), mockBitbankSuccess({ trades: page2 })]);

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ count: 1199, order: 'desc' });

		assertOk(result);
		expect(result.data.trades).toHaveLength(1199);
		const tradeIds = result.data.trades.map((t: { trade_id: number }) => t.trade_id);
		// desc: 単調減少
		for (let i = 1; i < tradeIds.length; i++) {
			expect(tradeIds[i]).toBeLessThan(tradeIds[i - 1]);
		}
	});

	it('asc ページネーションは内部で order=asc を API に渡す', async () => {
		const page1 = generateMarginTrades(500, 1, 1710000000000);
		const mockFn = setupSequentialFetchMock([mockBitbankSuccess({ trades: page1 })]);

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		// count > 1000 でページネーション経路に入る
		await getMarginTradeHistory({ count: 2000, order: 'asc' });

		const firstUrl = mockFn.mock.calls[0][0] as string;
		expect(firstUrl).toContain('order=asc');
		expect(firstUrl).toContain('count=1000');
		expect(firstUrl).toContain('type=margin');
	});

	it('desc + count > 1000 で最新側 count 件が返る（CodeRabbit #458 指摘 2 の回帰防止）', async () => {
		// 旧バグ: paginate が常に asc 取得 → 末尾で reverse していたため、
		// count > PAGE_SIZE かつ order='desc' のとき「最古 count 件を新→古順」を返してしまっていた。
		// 修正後: order='desc' のときは API に order=desc + end カーソルを渡し、
		// 最新側 count 件を取得する。
		//
		// シナリオ: 期間内に trade_id 1..1500（ts 増加）の全 margin が存在。count=1200, order='desc'。
		// 期待: 最新 1200 件 = trade_id 1500..301 を desc 順で返す（最古 1200 件ではない）。
		const page1 = generateMarginTrades(1000, 501, 1710000500000).reverse(); // trade_id 1500..501
		const page2 = generateMarginTrades(501, 1, 1710000000000).reverse(); // trade_id 501..1

		const mockFn = setupSequentialFetchMock([
			mockBitbankSuccess({ trades: page1 }),
			mockBitbankSuccess({ trades: page2 }),
		]);

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ count: 1200, order: 'desc' });

		assertOk(result);
		expect(result.data.trades).toHaveLength(1200);
		const ids = result.data.trades.map((t) => t.trade_id);
		// 先頭は最新の 1500、末尾は 301（最古 count 件 = 1200..1 ではない）
		expect(ids[0]).toBe(1500);
		expect(ids[ids.length - 1]).toBe(301);
		// 旧バグなら ids[0] === 1200 になる
		expect(ids[0]).not.toBe(1200);
		// 2 ページ目の URL に end=ts(501) が渡されている（since ではない）
		const secondUrl = mockFn.mock.calls[1][0] as string;
		expect(secondUrl).toContain('order=desc');
		expect(secondUrl).toContain('end=1710000500000'); // ts of trade_id 501 = page1 末尾
		expect(secondUrl).not.toMatch(/[?&]since=/);
	});

	it('desc ページネーションは内部で order=desc を API に渡す（初回は end カーソル無し）', async () => {
		const page1 = generateMarginTrades(500, 1, 1710000000000).reverse();
		const mockFn = setupSequentialFetchMock([mockBitbankSuccess({ trades: page1 })]);

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		// count > 1000 でページネーション経路 + order=desc 明示
		await getMarginTradeHistory({ count: 2000, order: 'desc' });

		const firstUrl = mockFn.mock.calls[0][0] as string;
		expect(firstUrl).toContain('order=desc');
		expect(firstUrl).toContain('count=1000');
		expect(firstUrl).toContain('type=margin');
		// 初回は end カーソル未設定（ユーザーが end を渡していない）
		expect(firstUrl).not.toMatch(/[?&]end=/);
	});

	it('desc ページネーションで現物混入下でも margin だけ集めて最新側を返す', async () => {
		// page1: 1000 件（margin 600 + spot 400、desc 順）、page2: 800 件 margin（desc 順、終端）。
		// margin 600+800=1400 → limit=1200 で打ち切り、最新 1200 件が返る。
		const page1 = [
			...generateMarginTrades(600, 1401, 1710001400000).reverse(), // margin trade_id 2000..1401 desc
			...generateSpotTrades(400, 5000, 1710001000000).reverse(), // spot
		];
		const page2 = generateMarginTrades(800, 601, 1710000600000).reverse(); // margin trade_id 1400..601 desc

		setupSequentialFetchMock([mockBitbankSuccess({ trades: page1 }), mockBitbankSuccess({ trades: page2 })]);

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ count: 1200, order: 'desc' });

		assertOk(result);
		expect(result.data.trades).toHaveLength(1200);
		// 全て margin
		for (const t of result.data.trades) {
			expect(t.position_side).toBeDefined();
		}
		const ids = result.data.trades.map((t) => t.trade_id);
		// 最新側: 先頭は 2000、末尾は 801（最古 1200 件 = 600..1399 ではない）
		expect(ids[0]).toBe(2000);
		expect(ids[ids.length - 1]).toBe(801);
		expect(result.meta.isComplete).toBe(false);
	});
});

describe('get_margin_trade_history — handler (toolDef)', () => {
	it('handler がデフォルト引数で動作する', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginTradeHistoryResponse));

		const { toolDef } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await toolDef.handler({});

		expect((result as { ok: boolean }).ok).toBe(true);
	});
});

/**
 * API が返す pair は取得境界で小文字へ正規化する（`lib/pair-code.ts`）。
 * 揃えないと JPY 建て判定（`t.pair.includes('jpy')`）が外れ、価格が円フォーマットされない。
 * 現行の小文字レスポンスに対しては何も変わらない（防御的正規化）。
 */
describe('get_margin_trade_history — API pair の取得境界正規化', () => {
	it('小文字レスポンスでは出力の pair 表記が変わらない', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginTradeHistoryResponse));

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.data.trades.map((t) => t.pair)).toEqual(['btc_jpy', 'btc_jpy', 'eth_jpy']);
		expect(result.summary).toContain('BTC/JPY');
		expect(result.summary).toContain('¥15,000,000');
	});

	it('大文字レスポンスでも structuredContent は小文字契約 / JPY 建て表示が崩れない', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				trades: rawMarginTradeHistoryResponse.trades.map((t) => ({ ...t, pair: t.pair.toUpperCase() })),
			}),
		);

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({});

		assertOk(result);
		expect(result.data.trades.map((t) => t.pair)).toEqual(['btc_jpy', 'btc_jpy', 'eth_jpy']);
		// 正規化前は includes('jpy') が外れ、価格が生文字列 '15000000' のまま出ていた
		expect(result.summary).toContain('¥15,000,000');
		expect(result.summary).not.toContain(' 15000000 ');
		expect(result.summary).toContain('BTC/JPY');
	});

	it('ページネーション経路でも大文字 pair が小文字化される', async () => {
		const upper = generateMarginTrades(1000).map((t) => ({ ...t, pair: t.pair.toUpperCase() }));
		setupSequentialFetchMock([mockBitbankSuccess({ trades: upper }), mockBitbankSuccess({ trades: [] })]);

		const { default: getMarginTradeHistory } = await import('../../tools/private/get_margin_trade_history.js');
		const result = await getMarginTradeHistory({ count: 1500 });

		assertOk(result);
		expect(new Set(result.data.trades.map((t) => t.pair))).toEqual(new Set(['btc_jpy']));
	});
});
