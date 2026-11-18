// 取得層データ正確性診断（2026-11-18）で確認した問題の回帰テスト。probe C / E は未修正の現状挙動の記録で、修正時は期待値を直すこと。
import { afterEach, describe, expect, it, vi } from 'vitest';
import getDepth from '../lib/get-depth.js';
import getCandles from '../tools/get_candles.js';
import getTicker from '../tools/get_ticker.js';
import getTickersJpy from '../tools/get_tickers_jpy.js';
import getTransactions from '../tools/get_transactions.js';
import { asMockResult } from './_assertResult.js';

function mockFetchJson(payload: unknown) {
	return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		asMockResult<Response>({
			ok: true,
			status: 200,
			statusText: 'OK',
			headers: new Headers({}),
			json: async () => payload,
		}),
	);
}

const TS = 1_700_000_000_000;

afterEach(() => {
	vi.restoreAllMocks();
});

describe('probe A: get_transactions の timestamp 0/負値', () => {
	it('executed_at=0 / -5 の行は drop され warning で件数が出る', async () => {
		mockFetchJson({
			success: 1,
			data: {
				transactions: [
					{ transaction_id: 1, price: '100', amount: '1', side: 'buy', executed_at: 0 },
					{ transaction_id: 2, price: '101', amount: '1', side: 'sell', executed_at: -5 },
					{ transaction_id: 3, price: '102', amount: '1', side: 'buy', executed_at: TS },
				],
			},
		});
		const res = await getTransactions('btc_jpy', 10);
		expect(res.ok).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: probe assertion
		const r = res as any;
		expect(r.data.normalized).toHaveLength(1);
		expect(r.data.normalized[0].timestampMs).toBe(TS);
		expect(r.meta.warning).toContain('2件');
		expect(r.summary).toContain('不正な約定行を除外');
	});

	it('date 形式不正（ハイフン付き）は fetch せず user エラーを返す', async () => {
		const spy = mockFetchJson({ success: 1, data: { transactions: [] } });
		const res = await getTransactions('btc_jpy', 10, '2025-11-17');
		expect(res.ok).toBe(false);
		expect(spy).not.toHaveBeenCalled();
		// biome-ignore lint/suspicious/noExplicitAny: probe assertion
		const r = res as any;
		expect(r.meta.errorType).toBe('user');
		expect(r.summary).toContain('YYYYMMDD');
	});
});

describe('probe B: get_ticker の timestamp=0', () => {
	it('timestamp=0 は欠損と同じ null になり 1970 時点として表示されない', async () => {
		mockFetchJson({
			success: 1,
			data: { last: '100', open: '90', high: '110', low: '80', buy: '99', sell: '101', vol: '5', timestamp: 0 },
		});
		const res = await getTicker('btc_jpy');
		expect(res.ok).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: probe assertion
		const r = res as any;
		expect(r.data.normalized.timestamp).toBeNull();
		expect(r.data.normalized.isoTime).toBeNull();
		expect(r.summary).not.toContain('1970/01/01');
	});
});

describe('probe C: get_candles の不正 ts 行と limit 窓（現状挙動の記録）', () => {
	const rows: unknown[][] = [
		...Array.from({ length: 6 }, (_, i) => [
			String(100 + i),
			String(110 + i),
			String(90 + i),
			String(105 + i),
			'1.0',
			TS + i * 86_400_000,
		]),
		['1', '2', '0.5', '1.5', '1.0', 'bogus_ts'],
	];

	it('不正 ts 行が slice(-limit) の窓の外なら warning 無しで黙って消える', async () => {
		mockFetchJson({ success: 1, data: { candlestick: [{ ohlcv: rows }] } });
		const res = await getCandles('btc_jpy', '1day', '2024', 3, 'UTC');
		expect(res.ok).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: probe assertion
		const r = res as any;
		expect(r.meta.count).toBe(3);
		expect(r.meta.warning).toBeUndefined();
		expect(r.summary).not.toContain('不正な OHLCV 行');
	});

	it('同じ不正 ts 行が窓に入ると upstream fail する', async () => {
		mockFetchJson({ success: 1, data: { candlestick: [{ ohlcv: rows }] } });
		const res = await getCandles('btc_jpy', '1day', '2024', 7, 'UTC');
		expect(res.ok).toBe(false);
		// biome-ignore lint/suspicious/noExplicitAny: probe assertion
		expect((res as any).meta.errorType).toBe('upstream');
	});
});

describe('probe D: lib/get-depth の不正レベル', () => {
	it('price が数値変換不能なレベルは drop され warning と droppedRows で申告される', async () => {
		mockFetchJson({
			success: 1,
			data: {
				asks: [
					['10100', '0.2'],
					['abc', '0.3'],
					['10300', '0.4'],
				],
				bids: [['9900', '0.3']],
				timestamp: TS,
			},
		});
		const res = await getDepth('btc_jpy');
		expect(res.ok).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: probe assertion
		const r = res as any;
		expect(r.data.asks).toHaveLength(2);
		expect(r.data.asks).not.toContainEqual(['abc', '0.3']);
		expect(r.summary).not.toContain('NaN');
		expect(r.summary).toContain('不正な板レベルを除外');
		expect(r.meta.droppedRows).toEqual({ bids: 0, asks: 1 });
		expect(r.meta.warning).toContain('不正な板レベルを除外');
	});

	it('不正 price + 大口 size も drop されるので NaN ゾーン → network 誤分類にならない', async () => {
		const smallAsks = Array.from({ length: 20 }, (_, i) => [String(10100 + i), '0.1']);
		mockFetchJson({
			success: 1,
			data: {
				asks: [...smallAsks, ['abc', '50']],
				bids: [['9900', '0.3']],
				timestamp: TS,
			},
		});
		const res = await getDepth('btc_jpy');
		expect(res.ok).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: probe assertion
		const r = res as any;
		expect(r.meta.droppedRows).toEqual({ bids: 0, asks: 1 });
		expect(r.meta.warning).toContain('不正な板レベルを除外');
	});

	it('空文字 size・非配列行も drop され分割代入 throw → network 誤分類に戻らない（PR 476 レビュー）', async () => {
		mockFetchJson({
			success: 1,
			data: {
				asks: [['10100', '0.2'], ['10200', ''], { 0: '10300', 1: '0.4' }, ['10400', true]],
				bids: [['9900', '0.3']],
				timestamp: TS,
			},
		});
		const res = await getDepth('btc_jpy');
		expect(res.ok).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: probe assertion
		const r = res as any;
		expect(r.data.asks).toEqual([['10100', '0.2']]);
		expect(r.meta.droppedRows).toEqual({ bids: 0, asks: 3 });
	});

	it('drop で片側が全滅したら upstream fail する', async () => {
		mockFetchJson({
			success: 1,
			data: {
				asks: [['abc', '0.3']],
				bids: [['9900', '0.3']],
				timestamp: TS,
			},
		});
		const res = await getDepth('btc_jpy');
		expect(res.ok).toBe(false);
		// biome-ignore lint/suspicious/noExplicitAny: probe assertion
		expect((res as any).meta.errorType).toBe('upstream');
	});
});

describe('probe E: get_tickers_jpy の文字列フィールド無検証パススルー（現状挙動の記録）', () => {
	it("last='xyz' の item がそのまま data と content text に出る", async () => {
		mockFetchJson({
			success: 1,
			data: [
				{
					pair: 'btc_jpy',
					sell: '1',
					buy: '1',
					high: '1',
					low: '1',
					open: 'abc',
					last: 'xyz',
					vol: '1',
					timestamp: TS,
				},
			],
		});
		const res = await getTickersJpy({ bypassCache: true });
		expect(res.ok).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: probe assertion
		const r = res as any;
		expect(r.data[0].last).toBe('xyz');
		expect(r.data[0].change24hPct).toBeNull();
		expect(r.summary).toContain('last:xyz');
	});
});
