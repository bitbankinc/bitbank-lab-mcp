import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../lib/datetime.js';
import { GetCandlesInputSchema } from '../src/schemas.js';
import getCandles, { toolDef } from '../tools/get_candles.js';
import { assertFail, assertOk } from './_assertResult.js';
import { candlesError } from './fixtures/bitbank-api.js';

describe('GetCandlesInputSchema (limit 上限契約)', () => {
	it('limit=10000 は schema レベルで通る（multi-day 経路の実上限と整合）', () => {
		const parsed = GetCandlesInputSchema.parse({ pair: 'btc_jpy', type: '1min', limit: 10000 });
		expect((parsed as { limit: number }).limit).toBe(10000);
	});

	it('limit=10001 は schema レベルで弾かれる', () => {
		const result = GetCandlesInputSchema.safeParse({ pair: 'btc_jpy', type: '1min', limit: 10001 });
		expect(result.success).toBe(false);
	});

	it('limit=200 / limit=1000 / limit=1 / limit 省略 など既存ケースは引き続き通る', () => {
		expect(GetCandlesInputSchema.safeParse({ pair: 'btc_jpy', type: '1day', limit: 200 }).success).toBe(true);
		expect(GetCandlesInputSchema.safeParse({ pair: 'btc_jpy', type: '1day', limit: 1000 }).success).toBe(true);
		expect(GetCandlesInputSchema.safeParse({ pair: 'btc_jpy', type: '1day', limit: 1 }).success).toBe(true);
		// 省略時は default(200) が適用される
		const parsed = GetCandlesInputSchema.parse({ pair: 'btc_jpy', type: '1day' });
		expect((parsed as { limit: number }).limit).toBe(200);
	});

	it('limit=0 / limit=-1 / 小数は引き続き弾かれる', () => {
		expect(GetCandlesInputSchema.safeParse({ pair: 'btc_jpy', type: '1day', limit: 0 }).success).toBe(false);
		expect(GetCandlesInputSchema.safeParse({ pair: 'btc_jpy', type: '1day', limit: -1 }).success).toBe(false);
		expect(GetCandlesInputSchema.safeParse({ pair: 'btc_jpy', type: '1day', limit: 1.5 }).success).toBe(false);
	});
});

describe('getCandles', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('不正な日付形式は user エラーを返す', async () => {
		const res = await getCandles('btc_jpy', '1hour', '2024-01-01', 10);
		assertFail(res);
		expect(res.meta?.errorType).toBe('user');
	});

	it('日足未満で date 指定時は指定日基準で取得するべき', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({
				success: 1,
				data: {
					candlestick: [
						{
							ohlcv: [['100', '110', '90', '105', '1.23', '1704067200000']],
						},
					],
				},
			}),
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const res = await getCandles('btc_jpy', '1hour', '20240101', 50);
		assertOk(res);

		const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
		expect(calledUrls.some((u) => u.endsWith('/btc_jpy/candlestick/1hour/20240101'))).toBe(true);
	});

	it('無効な type は user エラーを返す', async () => {
		const res = await getCandles('btc_jpy', 'invalid_type', '20240101', 10);
		assertFail(res);
		expect(res.meta?.errorType).toBe('user');
	});

	it('無効なペアは failFromValidation を返す', async () => {
		const res = await getCandles('invalid_xxx', '1day', '20240101', 10);
		assertFail(res);
	});

	it('空のローソク足データは user エラーを返す', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({
				success: 1,
				data: {
					candlestick: [{ ohlcv: [] }],
				},
			}),
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const res = await getCandles('btc_jpy', '1day', '2024', 10);
		assertFail(res);
	});

	it('十分なデータがある場合 keyPoints と volumeStats を計算するべき', async () => {
		// 100本のローソク足を生成
		const baseTs = 1704067200000;
		const ohlcv = Array.from({ length: 100 }, (_, i) => [
			String(100 + i),
			String(110 + i),
			String(90 + i),
			String(105 + i),
			String(1 + i * 0.1),
			String(baseTs + i * 86400000),
		]);
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({
				success: 1,
				data: { candlestick: [{ ohlcv }] },
			}),
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const res = await getCandles('btc_jpy', '1day', '2024', 100);
		assertOk(res);

		// keyPoints should exist
		expect(res.data.keyPoints!.today).not.toBeNull();
		expect(res.data.keyPoints!.sevenDaysAgo).not.toBeNull();
		expect(res.data.keyPoints!.thirtyDaysAgo).not.toBeNull();
		expect(res.data.keyPoints!.ninetyDaysAgo).not.toBeNull();

		// baseTs=1704067200000 = 2024-01-01T00:00:00Z = JST 2024-01-01 09:00
		// 100本のローソク → today index=99 → 2024-04-09T00:00:00Z = JST 2024-04-09 09:00 → '2024-04-09'
		// 既定 tz='Asia/Tokyo' で JST 暦日として出る
		expect(res.data.keyPoints?.today?.date).toBe('2024-04-09');
		// sevenDaysAgo = index 92 → 2024-04-02 → JST '2024-04-02'
		expect(res.data.keyPoints?.sevenDaysAgo?.date).toBe('2024-04-02');

		// volumeStats should exist (>= 14 items)
		expect(res.data.volumeStats).not.toBeNull();
		expect(res.data.volumeStats?.changePct).toBeDefined();
		expect(res.data.volumeStats?.judgment).toBeDefined();
	});

	it('出来高推移ラベルは pair の base 通貨を使う（eth_jpy → ETH/日、BTC/日 を含まない）', async () => {
		const baseTs = 1704067200000; // 2024-01-01T00:00:00Z
		// volumeStats は totalItems >= 14 で算出される。ちょうど 14 本生成する。
		const ohlcv = Array.from({ length: 14 }, (_, i) => [
			'100',
			'110',
			'90',
			'105',
			String(1 + i * 0.1),
			String(baseTs + i * 86400000),
		]);
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({
				success: 1,
				data: { candlestick: [{ ohlcv }] },
			}),
		} as unknown as Response);

		const res = await getCandles('eth_jpy', '1day', '2024', 14);
		assertOk(res);
		expect(res.summary).toContain('【出来高推移】');
		expect(res.summary).toContain('ETH/日');
		expect(res.summary).not.toContain('BTC/日');
	});

	it('出来高変化率が +20% 以上なら「活発になっています」と判定するべき', async () => {
		const baseTs = 1704067200000;
		// recent 7 days high volume, previous 7 days low volume
		const ohlcv = Array.from({ length: 20 }, (_, i) => [
			'100',
			'110',
			'90',
			'105',
			i >= 13 ? '100' : '10', // last 7 high, previous low
			String(baseTs + i * 86400000),
		]);
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({
				success: 1,
				data: { candlestick: [{ ohlcv }] },
			}),
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const res = await getCandles('btc_jpy', '1day', '2024', 20);
		assertOk(res);
		expect(res.data.volumeStats?.judgment).toBe('活発になっています');
	});

	it('出来高変化率が -20% 以下なら「落ち着いています」と判定するべき', async () => {
		const baseTs = 1704067200000;
		// recent 7 days low volume, previous 7 days high volume
		const ohlcv = Array.from({ length: 20 }, (_, i) => [
			'100',
			'110',
			'90',
			'105',
			i >= 13 ? '10' : '100', // last 7 low, previous high
			String(baseTs + i * 86400000),
		]);
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({
				success: 1,
				data: { candlestick: [{ ohlcv }] },
			}),
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const res = await getCandles('btc_jpy', '1day', '2024', 20);
		assertOk(res);
		expect(res.data.volumeStats?.judgment).toBe('落ち着いています');
	});

	describe('volumeStats: 前7日間ゼロ出来高ベースライン耐性', () => {
		it('前7日間が全てゼロ出来高 + 直近7日間に出来高ありなら changePct=null かつ専用ラベル', async () => {
			const baseTs = 1704067200000;
			// previous 7 days (index 0-6) = 0 volume, recent 7 days (index 7-13) = nonzero
			// → previous7DaysAvg === 0, recent7DaysAvg !== 0 → 通常計算なら Infinity
			const ohlcv = Array.from({ length: 14 }, (_, i) => [
				'100',
				'110',
				'90',
				'105',
				i >= 7 ? '1.0' : '0',
				String(baseTs + i * 86400000),
			]);
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: { candlestick: [{ ohlcv }] },
				}),
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = await getCandles('btc_jpy', '1day', '2024', 14);
			assertOk(res);
			expect(res.data.volumeStats).not.toBeNull();
			expect(res.data.volumeStats?.changePct).toBeNull();
			expect(res.data.volumeStats?.judgment).toBe('前週比較不可（前7日間の出来高ゼロ）');
			expect(res.data.volumeStats?.previous7DaysAvg).toBe(0);
		});

		it('前7日も直近7日も全てゼロ出来高なら changePct=null かつ専用ラベル (0/0=NaN 経路)', async () => {
			const baseTs = 1704067200000;
			// all volumes are 0 → previous7DaysAvg === 0, recent7DaysAvg === 0 → 通常計算なら NaN
			const ohlcv = Array.from({ length: 14 }, (_, i) => [
				'100',
				'110',
				'90',
				'105',
				'0',
				String(baseTs + i * 86400000),
			]);
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: { candlestick: [{ ohlcv }] },
				}),
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = await getCandles('btc_jpy', '1day', '2024', 14);
			assertOk(res);
			expect(res.data.volumeStats).not.toBeNull();
			expect(res.data.volumeStats?.changePct).toBeNull();
			expect(res.data.volumeStats?.judgment).toBe('前週比較不可（前7日間の出来高ゼロ）');
			expect(res.data.volumeStats?.recent7DaysAvg).toBe(0);
			expect(res.data.volumeStats?.previous7DaysAvg).toBe(0);
		});

		it('前7日ゼロ出来高でも content text 出力で null.toFixed() 等で落ちない', async () => {
			const baseTs = 1704067200000;
			const ohlcv = Array.from({ length: 14 }, (_, i) => [
				'100',
				'110',
				'90',
				'105',
				i >= 7 ? '1.0' : '0',
				String(baseTs + i * 86400000),
			]);
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: { candlestick: [{ ohlcv }] },
				}),
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = (await toolDef.handler({
				pair: 'btc_jpy',
				type: '1day',
				date: '2024',
				limit: 14,
				view: 'full',
			})) as { content: Array<{ type: string; text: string }> };
			const text = res.content[0].text;
			// Infinity / NaN が含まれないこと
			expect(text).not.toMatch(/Infinity/);
			expect(text).not.toMatch(/NaN/);
			// 専用ラベルが summary に含まれる
			expect(text).toContain('前週比較不可');
		});
	});

	it('404 エラーで 4hour/8hour/12hour の場合はヒント付きメッセージを返す', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error('HTTP 404 Not Found'));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const res = await getCandles('btc_jpy', '4hour', '2024', 10);
		assertFail(res);
		expect(res.meta?.errorType).toBe('user');
	});

	it('ネットワークエラーの場合は network エラータイプを返す', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const res = await getCandles('btc_jpy', '1day', '2024', 10);
		assertFail(res);
		expect(res.meta?.errorType).toBe('network');
	});

	it('複数年取得が必要な場合は並列取得するべき', async () => {
		const baseTs = 1704067200000;
		const ohlcv = Array.from({ length: 200 }, (_, i) => [
			'100',
			'110',
			'90',
			'105',
			'1.0',
			String(baseTs + i * 86400000),
		]);
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({
				success: 1,
				data: { candlestick: [{ ohlcv }] },
			}),
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		// 1day with limit > 365 → needs multi-year
		const res = await getCandles('btc_jpy', '1day', undefined, 500);
		assertOk(res);

		// Should have made multiple fetch calls (one per year)
		expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
	});

	// ── multi-year 起点年（date パラメータの遵守） ──

	describe('multi-year: date パラメータを起点に取得する', () => {
		const buildSuccessMock = () => {
			const baseTs = 1577836800000; // 2020-01-01 UTC
			const ohlcv = Array.from({ length: 365 }, (_, i) => [
				'100',
				'110',
				'90',
				'105',
				'1.0',
				String(baseTs + i * 86400000),
			]);
			return vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: { candlestick: [{ ohlcv }] },
				}),
			});
		};

		it('1day: date 指定時はその年を起点に過去年を取得する', async () => {
			const fetchMock = buildSuccessMock();
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			await getCandles('btc_jpy', '1day', '2020', 2000);

			const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
			// 起点年 2020 が含まれる
			expect(calledUrls.some((u) => u.endsWith('/btc_jpy/candlestick/1day/2020'))).toBe(true);
			// 2020 より新しい年は呼ばれていない（現在年起点になっていないことを確認）
			for (let y = 2021; y <= 2030; y++) {
				expect(calledUrls.some((u) => u.endsWith(`/btc_jpy/candlestick/1day/${y}`))).toBe(false);
			}
		});

		it('1day: date が YYYYMMDD 形式でも YYYY 部分を起点とする', async () => {
			const fetchMock = buildSuccessMock();
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			await getCandles('btc_jpy', '1day', '20201225', 2000);

			const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
			expect(calledUrls.some((u) => u.endsWith('/btc_jpy/candlestick/1day/2020'))).toBe(true);
			for (let y = 2021; y <= 2030; y++) {
				expect(calledUrls.some((u) => u.endsWith(`/btc_jpy/candlestick/1day/${y}`))).toBe(false);
			}
		});

		it('4hour: date 指定時はその年を起点に過去年を取得する', async () => {
			const fetchMock = buildSuccessMock();
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			await getCandles('btc_jpy', '4hour', '2020', 5000);

			const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
			expect(calledUrls.some((u) => u.endsWith('/btc_jpy/candlestick/4hour/2020'))).toBe(true);
			for (let y = 2021; y <= 2030; y++) {
				expect(calledUrls.some((u) => u.endsWith(`/btc_jpy/candlestick/4hour/${y}`))).toBe(false);
			}
		});

		it('1week: date 指定時はその年を起点に過去年を取得する', async () => {
			const fetchMock = buildSuccessMock();
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			await getCandles('btc_jpy', '1week', '2018', 200);

			const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
			expect(calledUrls.some((u) => u.endsWith('/btc_jpy/candlestick/1week/2018'))).toBe(true);
			for (let y = 2019; y <= 2030; y++) {
				expect(calledUrls.some((u) => u.endsWith(`/btc_jpy/candlestick/1week/${y}`))).toBe(false);
			}
		});

		it('1month: date 指定時はその年を起点に過去年を取得する', async () => {
			const fetchMock = buildSuccessMock();
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			await getCandles('btc_jpy', '1month', '2017', 100);

			const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
			expect(calledUrls.some((u) => u.endsWith('/btc_jpy/candlestick/1month/2017'))).toBe(true);
			for (let y = 2018; y <= 2030; y++) {
				expect(calledUrls.some((u) => u.endsWith(`/btc_jpy/candlestick/1month/${y}`))).toBe(false);
			}
		});

		it('date 未指定時は現在年を起点に過去年を取得する（従来挙動）', async () => {
			const fetchMock = buildSuccessMock();
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			await getCandles('btc_jpy', '1day', undefined, 2000);

			const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
			const currentYear = dayjs().year();
			expect(calledUrls.some((u) => u.endsWith(`/btc_jpy/candlestick/1day/${currentYear}`))).toBe(true);
		});

		it('multi-day 取得には影響しない: 1hour + date 指定はそのまま YYYYMMDD を起点とする', async () => {
			const baseTs = 1705276800000; // 2024-01-15
			const ohlcv = Array.from({ length: 24 }, (_, i) => [
				'100',
				'110',
				'90',
				'105',
				'1.0',
				String(baseTs + i * 3600000),
			]);
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: { candlestick: [{ ohlcv }] },
				}),
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			await getCandles('btc_jpy', '1hour', '20240115', 100);

			const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
			// multi-day branch は YYYYMMDD 形式のまま既存挙動
			expect(calledUrls.some((u) => u.endsWith('/btc_jpy/candlestick/1hour/20240115'))).toBe(true);
		});
	});

	it('複数日取得が必要な場合はバッチ取得するべき', async () => {
		const baseTs = 1704067200000;
		const ohlcv = Array.from({ length: 50 }, (_, i) => [
			'100',
			'110',
			'90',
			'105',
			'1.0',
			String(baseTs + i * 3600000),
		]);
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({
				success: 1,
				data: { candlestick: [{ ohlcv }] },
			}),
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		// 1hour with limit > 24 (1 day) → needs multi-day
		const res = await getCandles('btc_jpy', '1hour', '20240115', 100);
		assertOk(res);

		// Should have made multiple fetch calls (one per day batch)
		expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
	});

	// ── limit 上限（schema 緩和後の impl 側 validateLimit との整合） ──

	describe('limit 上限: impl 側 validateLimit', () => {
		const buildFetchMock = (rows: unknown[][]) =>
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: { candlestick: [{ ohlcv: rows }] },
				}),
			});

		it('multi-year 経路: YEARLY_TYPES + limit=2000 は impl 側でも通る', async () => {
			const baseTs = 1577836800000;
			const ohlcv = Array.from({ length: 365 }, (_, i) => [
				'100',
				'110',
				'90',
				'105',
				'1.0',
				String(baseTs + i * 86400000),
			]);
			globalThis.fetch = buildFetchMock(ohlcv) as unknown as typeof fetch;

			const res = await getCandles('btc_jpy', '1day', '2020', 2000);
			assertOk(res);
		});

		it('multi-day 経路: DAILY_TYPES + limit=2000 は impl 側でも通る', async () => {
			const baseTs = 1705276800000;
			const ohlcv = Array.from({ length: 60 }, (_, i) => [
				'100',
				'110',
				'90',
				'105',
				'1.0',
				String(baseTs + i * 60_000),
			]);
			globalThis.fetch = buildFetchMock(ohlcv) as unknown as typeof fetch;

			const res = await getCandles('btc_jpy', '1min', '20240115', 2000);
			assertOk(res);
		});

		it('YEARLY_TYPES + limit=6000 は impl 側 validateLimit で user エラー（実上限 5000 超）', async () => {
			// schema は通るが impl の maxLimit=5000 を超えるため user エラー
			const baseTs = 1577836800000;
			const ohlcv = [['100', '110', '90', '105', '1.0', String(baseTs)]];
			globalThis.fetch = buildFetchMock(ohlcv) as unknown as typeof fetch;

			const res = await getCandles('btc_jpy', '1day', '2020', 6000);
			assertFail(res);
			expect(res.meta?.errorType).toBe('user');
		});
	});

	it('同一 timestamp の重複行は dedupe され normalized に 1 件のみ残る', async () => {
		// /candlestick レスポンスで同一 ts の重複（一方は全 0 OHLC のプレースホルダ）が
		// 観測される。pipeline (sort → dedupe → anchor filter → slice) で dedupe される。
		const ts = 1704067200000;
		const ohlcv = [
			// 同一 ts の重複: priority a で除外される全 0 プレースホルダ
			['0', '0', '0', '0', '0', String(ts)],
			// 同一 ts の正常行（残るべき）
			['100', '110', '90', '105', '1.5', String(ts)],
			// 別 ts の正常行
			['101', '111', '91', '106', '2.0', String(ts + 86400000)],
		];
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({
				success: 1,
				data: { candlestick: [{ ohlcv }] },
			}),
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const res = await getCandles('btc_jpy', '1day', '2024', 10);
		assertOk(res);

		// dedupe により ts=ts の行は 1 件のみ
		expect(res.data.normalized).toHaveLength(2);
		const tsList = res.data.normalized.map((c: { timestamp: number }) => c.timestamp);
		expect(tsList.filter((t: number) => t === ts)).toHaveLength(1);
		// 残ったのは非プレースホルダ行
		const kept = res.data.normalized.find((c: { timestamp: number }) => c.timestamp === ts);
		expect(kept?.open).toBe(100);
		expect(kept?.volume).toBe(1.5);
	});

	it('priceRange を正しく計算するべき', async () => {
		const baseTs = 1704067200000;
		const ohlcv = [
			['100', '150', '80', '120', '1.0', String(baseTs)],
			['120', '200', '70', '130', '2.0', String(baseTs + 86400000)],
		];
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({
				success: 1,
				data: { candlestick: [{ ohlcv }] },
			}),
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const res = await getCandles('btc_jpy', '1day', '2024', 10);
		assertOk(res);

		// High should be 200, Low should be 70
		const highs = res.data.normalized.map((c: { high: number }) => c.high);
		const lows = res.data.normalized.map((c: { low: number }) => c.low);
		expect(Math.max(...highs)).toBe(200);
		expect(Math.min(...lows)).toBe(70);

		// priceRange.periodStart/End は summary 上に出る。tz 既定=Asia/Tokyo の暦日:
		//   baseTs=2024-01-01T00:00:00Z=JST 2024-01-01 09:00 → '2024-01-01'
		//   baseTs+1d=2024-01-02T00:00:00Z=JST 2024-01-02 09:00 → '2024-01-02'
		expect(res.summary).toContain('2024-01-01 〜 2024-01-02');
	});

	// ── API 異常系（success:0） ──

	it('API異常系: success:0 を「データなし」(user) ではなく upstream として明示分類する', async () => {
		// 単一リクエスト経路: 1day + limit=10 + date=2024 は yearsNeeded=1 で単発取得
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => candlesError,
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const res = await getCandles('btc_jpy', '1day', '2024', 10);
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
		expect(res.summary).toContain('code: 10000');
	});

	it('API異常系: success:0 で data.code が無くても upstream として返す', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 0, data: {} }),
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const res = await getCandles('btc_jpy', '1day', '2024', 10);
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
	});

	it('API異常系: 複数年取得で全チャンク success:0 のとき upstream として明示分類する', async () => {
		// 1day + limit=500 → 複数年取得が走るパス
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => candlesError,
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const res = await getCandles('btc_jpy', '1day', undefined, 500);
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
		expect(res.summary).toContain('code: 10000');
	});

	it('API異常系: 複数日取得で全チャンク success:0 のとき upstream として明示分類する', async () => {
		// 1hour + limit=100 → 複数日バッチ取得が走るパス
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => candlesError,
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const res = await getCandles('btc_jpy', '1hour', '20240115', 100);
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
		expect(res.summary).toContain('code: 10000');
	});

	// ── OHLCV データ品質（不正行検出 + timestamp 保持） ──

	describe('OHLCV データ品質', () => {
		it('D-1: OHLCV 行に NaN になる値が含まれる場合 upstream として fail する', async () => {
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: {
						candlestick: [
							{
								ohlcv: [['foo', '100', '90', '95', '1.5', 1700000000000]],
							},
						],
					},
				}),
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = await getCandles('btc_jpy', '1day', '2024', 10);
			assertFail(res);
			expect(res.meta?.errorType).toBe('upstream');
			expect(res.summary).toContain('不正な OHLCV');
		});

		it('D-2: OHLCV 行長が 6 未満の場合 upstream として fail する', async () => {
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: {
						candlestick: [
							{
								ohlcv: [[100, 110, 90, 95, 1.5]],
							},
						],
					},
				}),
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = await getCandles('btc_jpy', '1day', '2024', 10);
			assertFail(res);
			expect(res.meta?.errorType).toBe('upstream');
			expect(res.summary).toContain('不正な OHLCV');
		});

		it('D-3: OHLCV 行の ts が非数値の場合 upstream として fail する', async () => {
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: {
						candlestick: [
							{
								ohlcv: [['1000', '1100', '900', '1050', '0.5', 'not-a-number']],
							},
						],
					},
				}),
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = await getCandles('btc_jpy', '1day', '2024', 10);
			assertFail(res);
			expect(res.meta?.errorType).toBe('upstream');
			expect(res.summary).toContain('不正な OHLCV');
		});

		it('D-4: OHLCV 行の ts が 0 以下の場合 upstream として fail する', async () => {
			// ts=0 は Number.isFinite(0)===true なので D-3 とは別枝（tsNum <= 0）を踏む
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: {
						candlestick: [
							{
								ohlcv: [['1000', '1100', '900', '1050', '0.5', 0]],
							},
						],
					},
				}),
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = await getCandles('btc_jpy', '1day', '2024', 10);
			assertFail(res);
			expect(res.meta?.errorType).toBe('upstream');
			expect(res.summary).toContain('不正な OHLCV');
		});

		it('E: 正常系では公式 candle の ms timestamp が normalized に保持される', async () => {
			const ts = 1700000000000;
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: {
						candlestick: [
							{
								ohlcv: [['100', '110', '90', '105', '1.5', ts]],
							},
						],
					},
				}),
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = await getCandles('btc_jpy', '1day', '2024', 10);
			assertOk(res);
			expect(res.data.normalized[0].timestamp).toBe(ts);
		});
	});

	it('tz が空文字列の場合 Asia/Tokyo にフォールバックし isoTimeLocal を含める', async () => {
		// 表示層を tz 必須にする方針との整合: 空文字も Asia/Tokyo として扱う。
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({
				success: 1,
				data: {
					candlestick: [{ ohlcv: [['100', '110', '90', '105', '1.0', '1704067200000']] }],
				},
			}),
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const res = await getCandles('btc_jpy', '1day', '2024', 10, '');
		assertOk(res);
		// Asia/Tokyo へのフォールバックなので isoTimeLocal が含まれる
		expect(res.data.normalized[0].isoTimeLocal).toBeDefined();
		// 1704067200000 = 2024-01-01T00:00:00Z = JST 2024-01-01 09:00
		expect(res.data.normalized[0].isoTimeLocal).toBe('2024-01-01T09:00:00');
		// keyPoints の date も JST 暦日
		expect(res.data.keyPoints?.today?.date).toBe('2024-01-01');
	});

	// ── formatDateInTz による表示層の tz 起点化（PR-2） ──

	describe('表示層の tz: keyPoints.date は tz 引数の暦日で出る', () => {
		const buildSingleCandleMock = (timestampMs: number) =>
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: {
						candlestick: [{ ohlcv: [['100', '110', '90', '105', '1.0', String(timestampMs)]] }],
					},
				}),
			});

		it("tz='Asia/Tokyo' (既定): 2025-10-01T00:00:00Z (=JST 2025-10-01 09:00) → '2025-10-01'", async () => {
			globalThis.fetch = buildSingleCandleMock(1759276800000) as unknown as typeof fetch;
			const res = await getCandles('btc_jpy', '1day', '2025', 10);
			assertOk(res);
			expect(res.data.keyPoints?.today?.date).toBe('2025-10-01');
		});

		it("tz='UTC': 同じ timestamp で '2025-10-01' (UTC 暦日)", async () => {
			globalThis.fetch = buildSingleCandleMock(1759276800000) as unknown as typeof fetch;
			const res = await getCandles('btc_jpy', '1day', '2025', 10, 'UTC');
			assertOk(res);
			expect(res.data.keyPoints?.today?.date).toBe('2025-10-01');
		});

		it("tz='Asia/Tokyo': 2025-10-01T11:00:00Z (=JST 2025-10-01 20:00) → '2025-10-01'", async () => {
			globalThis.fetch = buildSingleCandleMock(1759316400000) as unknown as typeof fetch;
			const res = await getCandles('btc_jpy', '1day', '2025', 10);
			assertOk(res);
			expect(res.data.keyPoints?.today?.date).toBe('2025-10-01');
		});

		it("tz='Asia/Tokyo': 2025-10-02T00:00:00Z (=JST 2025-10-02 09:00) → '2025-10-02'", async () => {
			globalThis.fetch = buildSingleCandleMock(1759363200000) as unknown as typeof fetch;
			const res = await getCandles('btc_jpy', '1day', '2025', 10);
			assertOk(res);
			expect(res.data.keyPoints?.today?.date).toBe('2025-10-02');
		});

		it('JST/UTC で日付が分かれる timestamp (2025-09-30T20:00:00Z): tz により date が変わる', async () => {
			const ms = Date.UTC(2025, 8, 30, 20, 0, 0); // 2025-09-30T20:00:00Z = JST 2025-10-01 05:00
			globalThis.fetch = buildSingleCandleMock(ms) as unknown as typeof fetch;

			const jst = await getCandles('btc_jpy', '1day', '2025', 10, 'Asia/Tokyo');
			assertOk(jst);
			expect(jst.data.keyPoints?.today?.date).toBe('2025-10-01');

			globalThis.fetch = buildSingleCandleMock(ms) as unknown as typeof fetch;
			const utc = await getCandles('btc_jpy', '1day', '2025', 10, 'UTC');
			assertOk(utc);
			expect(utc.data.keyPoints?.today?.date).toBe('2025-09-30');
		});
	});

	// ── toolDef.handler 経由（fail 透過） ──

	describe('toolDef.handler 経由', () => {
		it('success:0 + view=items のとき fail を透過し 0件 JSON を返さない', async () => {
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => candlesError,
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = (await toolDef.handler({
				pair: 'btc_jpy',
				type: '1day',
				date: '2024',
				limit: 10,
				view: 'items',
			})) as {
				ok: boolean;
				meta?: { errorType?: string };
				content?: Array<{ type: string; text: string }>;
			};
			expect(res.ok).toBe(false);
			expect(res.meta?.errorType).toBe('upstream');
			// fail を透過しているので content に 0件 JSON 配列を入れない
			if (res.content?.[0]?.text) {
				expect(res.content[0].text).not.toBe('[]');
			}
		});

		it('success:0 + view=full のとき fail を透過する', async () => {
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => candlesError,
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', date: '2024', limit: 10, view: 'full' })) as {
				ok: boolean;
				meta?: { errorType?: string };
			};
			expect(res.ok).toBe(false);
			expect(res.meta?.errorType).toBe('upstream');
		});

		it('正常系 + view=items のとき content text は JSON 配列で N 件含む', async () => {
			const baseTs = 1704067200000;
			const ohlcv = Array.from({ length: 3 }, (_, i) => [
				'100',
				'110',
				'90',
				'105',
				'1.0',
				String(baseTs + i * 86400000),
			]);
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: { candlestick: [{ ohlcv }] },
				}),
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = (await toolDef.handler({
				pair: 'btc_jpy',
				type: '1day',
				date: '2024',
				limit: 10,
				view: 'items',
			})) as {
				content: Array<{ type: string; text: string }>;
			};
			const parsed = JSON.parse(res.content[0].text);
			expect(Array.isArray(parsed)).toBe(true);
			expect(parsed).toHaveLength(3);
		});
	});

	// ── fetchWarning（部分失敗）の meta.warning 経由での伝播 ──

	describe('multi-year/multi-day 部分失敗時の fetchWarning', () => {
		it('multi-year: 4年中1年失敗 → meta.warning に伝播し、summary 先頭に出る', async () => {
			// 1day + date=2020 + limit=1100 → yearsNeeded=4（過去年起点）
			// years=[2020, 2019, 2018, 2017] のうち 2017 を success:0 で失敗させる
			const baseTs = 1577836800000; // 2020-01-01 UTC
			const validRows = Array.from({ length: 365 }, (_, i) => [
				'100',
				'110',
				'90',
				'105',
				'1.0',
				String(baseTs + i * 86400000),
			]);
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
				const urlStr = String(url);
				if (urlStr.includes('/1day/2017')) {
					return {
						ok: true,
						status: 200,
						statusText: 'OK',
						json: async () => ({ success: 0, data: { code: 10000 } }),
					} as Response;
				}
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					json: async () => ({ success: 1, data: { candlestick: [{ ohlcv: validRows }] } }),
				} as Response;
			});

			const res = await getCandles('btc_jpy', '1day', '2020', 1100);
			assertOk(res);
			// meta.warning に上流の部分失敗が伝播している
			expect(res.meta.warning).toBeDefined();
			expect(res.meta.warning).toContain('4年中1年');
			expect(res.meta.warning).toContain('2017');
			// summary 先頭にも警告が出る
			expect(res.summary.startsWith('⚠️')).toBe(true);
		});

		it('multi-day: 過半数未満の失敗 → meta.warning に伝播', async () => {
			// 1hour + date=20240115 (tz=Asia/Tokyo) + limit=200 → tz 暦日 window 由来の UTC keys
			//   = [20240107..20240115] の 9 日。
			// 9 日のうち 20240107（最古日）の 1 日を失敗させる（1/9 < 0.5）。
			const baseTs = 1705276800000; // 2024-01-15
			const validRows = Array.from({ length: 24 }, (_, i) => [
				'100',
				'110',
				'90',
				'105',
				'1.0',
				String(baseTs + i * 3600000),
			]);
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
				const urlStr = String(url);
				if (urlStr.includes('/1hour/20240107')) {
					return {
						ok: true,
						status: 200,
						statusText: 'OK',
						json: async () => ({ success: 0, data: { code: 10000 } }),
					} as Response;
				}
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					json: async () => ({ success: 1, data: { candlestick: [{ ohlcv: validRows }] } }),
				} as Response;
			});

			const res = await getCandles('btc_jpy', '1hour', '20240115', 200);
			assertOk(res);
			expect(res.meta.warning).toBeDefined();
			expect(res.meta.warning).toContain('日中');
			expect(res.summary.startsWith('⚠️')).toBe(true);
		});

		it('正常系（fetchWarning なし）: meta.warning は undefined のまま', async () => {
			const baseTs = 1577836800000;
			const ohlcv = Array.from({ length: 365 }, (_, i) => [
				'100',
				'110',
				'90',
				'105',
				'1.0',
				String(baseTs + i * 86400000),
			]);
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ success: 1, data: { candlestick: [{ ohlcv }] } }),
			} as Response);

			const res = await getCandles('btc_jpy', '1day', '2020', 365);
			assertOk(res);
			expect(res.meta.warning).toBeUndefined();
		});
	});

	// ── date アンカーによる絞り込み（指定日「以前」の limit 件を返す） ──

	describe('date アンカー絞り込み: 指定日以前の limit 件を返す', () => {
		/** YYYY-MM-DD UTC start-of-day を ms に（Date.UTC は月が 0-indexed なので -1） */
		const dayMs = (iso: string) => {
			const [y, m, d] = iso.split('-').map(Number);
			return Date.UTC(y, m - 1, d);
		};

		it('1day + date=YYYYMMDD + limit=3: 指定日を含む過去3本を返し、未来の足は含めない', async () => {
			// API は year=2025 を URL から受け取ったら 2025 年全体の足を返す体で mock する。
			// 9/30, 10/1, 10/2, 10/3, 10/4 の 5 本を返却 → 期待結果は 9/30, 10/1, 10/2 の 3 本。
			const ohlcv = [
				['100', '110', '90', '105', '1.0', dayMs('2025-09-30')],
				['101', '111', '91', '106', '1.0', dayMs('2025-10-01')],
				['102', '112', '92', '107', '1.0', dayMs('2025-10-02')],
				['103', '113', '93', '108', '1.0', dayMs('2025-10-03')],
				['104', '114', '94', '109', '1.0', dayMs('2025-10-04')],
			];
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ success: 1, data: { candlestick: [{ ohlcv }] } }),
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = await getCandles('btc_jpy', '1day', '20251002', 3);
			assertOk(res);

			expect(res.data.normalized).toHaveLength(3);
			const tsList = res.data.normalized.map((c: { timestamp: number }) => c.timestamp);
			expect(tsList).toEqual([dayMs('2025-09-30'), dayMs('2025-10-01'), dayMs('2025-10-02')]);
			// 10/3, 10/4 は含まれない
			expect(tsList).not.toContain(dayMs('2025-10-03'));
			expect(tsList).not.toContain(dayMs('2025-10-04'));
		});

		it('date 未指定: 従来通り末尾 limit 件（最新側）を返す', async () => {
			// 5 本の足を返す。date 未指定なので anchor フィルタなし → slice(-3) で末尾 3 本。
			const baseTs = dayMs('2025-09-30');
			const ohlcv = Array.from({ length: 5 }, (_, i) => [
				String(100 + i),
				String(110 + i),
				String(90 + i),
				String(105 + i),
				'1.0',
				String(baseTs + i * 86400000),
			]);
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ success: 1, data: { candlestick: [{ ohlcv }] } }),
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = await getCandles('btc_jpy', '1day', undefined, 3);
			assertOk(res);
			expect(res.data.normalized).toHaveLength(3);
			// 末尾 3 本: 10/2, 10/3, 10/4
			const tsList = res.data.normalized.map((c: { timestamp: number }) => c.timestamp);
			expect(tsList).toEqual([dayMs('2025-10-02'), dayMs('2025-10-03'), dayMs('2025-10-04')]);
		});

		it('1hour + date=YYYYMMDD + limit=5: 指定日終端 (tz=Asia/Tokyo) 23:59:59 以前のみ返し、JST 翌日の足は含めない', async () => {
			// anchor は JST 暦日終端で切る（PR-3 以降）。JST 10/2 23:59 = UTC 10/2 14:59 のため、
			// 防御的に「JST 10/3 に入る足」（UTC 10/2 15:00 以降）を mock に混ぜ、filter で確実に切り落とされることを検証する。
			const hourMs = (iso: string, h: number) => dayMs(iso) + h * 3600000;
			const ohlcv = [
				// JST 10/2 18:00..23:00 = UTC 10/2 09:00..14:00（6 本）
				...Array.from({ length: 6 }, (_, i) => ['100', '110', '90', '105', '1.0', String(hourMs('2025-10-02', 9 + i))]),
				// JST 10/3 00:00..02:00 = UTC 10/2 15:00..17:00（3 本、anchor の外側）
				...Array.from({ length: 3 }, (_, i) => [
					'200',
					'210',
					'190',
					'205',
					'1.0',
					String(hourMs('2025-10-02', 15 + i)),
				]),
			];
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ success: 1, data: { candlestick: [{ ohlcv }] } }),
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = await getCandles('btc_jpy', '1hour', '20251002', 5);
			assertOk(res);

			const tsList = res.data.normalized.map((c: { timestamp: number }) => c.timestamp);
			// すべて JST 10/2 終端（= UTC 10/2 14:59:59.999）以前であること
			const jstEndOfDayMs = dayMs('2025-10-02') + 15 * 3600000 - 1; // JST 10/2 23:59:59.999
			for (const ts of tsList) expect(ts).toBeLessThanOrEqual(jstEndOfDayMs);
			// JST 10/3（= UTC 10/2 15:00 以降）の足は含まれない
			expect(tsList.find((ts: number) => ts >= hourMs('2025-10-02', 15))).toBeUndefined();
		});

		it('1day + date=20250110 + limit 年跨ぎ: 2025年と2024年の両方を取得し、anchor 以前の limit 件を返す', async () => {
			// 各年 365 本のフィクスチャを返す。年ごとに baseTs を切り替える。
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
				const urlStr = String(url);
				const m = urlStr.match(/\/1day\/(\d{4})$/);
				const year = m ? Number(m[1]) : 2025;
				const baseTs = Date.UTC(year, 0, 1);
				const ohlcv = Array.from({ length: 365 }, (_, i) => [
					'100',
					'110',
					'90',
					'105',
					'1.0',
					String(baseTs + i * 86400000),
				]);
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					json: async () => ({ success: 1, data: { candlestick: [{ ohlcv }] } }),
				} as Response;
			});

			// daysFromStart(20250110)=10 → barsInAnchorYear=10
			// yearsNeeded = 1 + ceil((50-10)/365) = 2 → fetch [2025, 2024]
			const res = await getCandles('btc_jpy', '1day', '20250110', 50);
			assertOk(res);

			const calledUrls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
			expect(calledUrls.some((u) => u.endsWith('/1day/2025'))).toBe(true);
			expect(calledUrls.some((u) => u.endsWith('/1day/2024'))).toBe(true);

			// 結果は 50 本、すべて anchor=2025-01-10 23:59:59 以前
			expect(res.data.normalized).toHaveLength(50);
			const anchor = dayMs('2025-01-11') - 1;
			for (const c of res.data.normalized as Array<{ timestamp: number }>) {
				expect(c.timestamp).toBeLessThanOrEqual(anchor);
			}
			// 末尾は 2025-01-10
			expect(res.data.normalized.at(-1)?.timestamp).toBe(dayMs('2025-01-10'));
		});

		it('4hour 年初早朝 + 小 limit: 経過時間ベース見積もりで前年まで取得する', async () => {
			// バグ修正前は estimatedBarsThisYear が dayOfYear=1 から 6 bars と過大評価し、
			// limit=5 だと 6>=5 で yearsNeeded=1 となり前年が取得されなかった。
			// 経過時間ベースなら 03:00 UTC で floor(10800000/14400000)+1=1 となり前年取得が走る。
			vi.useFakeTimers();
			vi.setSystemTime(dayjs.utc('2026-01-01T03:00:00Z').valueOf());
			try {
				vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
					const urlStr = String(url);
					const m = urlStr.match(/\/4hour\/(\d{4})$/);
					const year = m ? Number(m[1]) : 2026;
					// 2025 年は通年分、2026 年は形成中で空配列を返す（実 API 挙動を模倣）
					const ohlcv =
						year === 2025
							? Array.from({ length: 100 }, (_, i) => [
									'100',
									'110',
									'90',
									'105',
									'1.0',
									String(Date.UTC(2025, 0, 1) + i * 4 * 3_600_000),
								])
							: [];
					return {
						ok: true,
						status: 200,
						statusText: 'OK',
						json: async () => ({ success: 1, data: { candlestick: [{ ohlcv }] } }),
					} as Response;
				});

				const res = await getCandles('btc_jpy', '4hour', undefined, 5);
				assertOk(res);

				const calledUrls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
				expect(calledUrls.some((u) => u.endsWith('/4hour/2026'))).toBe(true);
				expect(calledUrls.some((u) => u.endsWith('/4hour/2025'))).toBe(true);
				expect(res.data.normalized).toHaveLength(5);
			} finally {
				vi.useRealTimers();
			}
		});

		it('指定日以前のデータが存在しない場合は user エラーを返す', async () => {
			// year=2025 を fetch すると 2025-06 以降の足だけが返る mock。
			// date=20250105 → anchor=2025-01-05 23:59:59 → 全 row が anchor より後 → 空。
			const baseTs = dayMs('2025-06-01');
			const ohlcv = Array.from({ length: 3 }, (_, i) => [
				'100',
				'110',
				'90',
				'105',
				'1.0',
				String(baseTs + i * 86400000),
			]);
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ success: 1, data: { candlestick: [{ ohlcv }] } }),
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = await getCandles('btc_jpy', '1day', '20250105', 10);
			assertFail(res);
			expect(res.meta?.errorType).toBe('user');
			expect(res.summary).toContain('20250105');
		});
	});

	// ── PR-3: anchor を tz 起点で解釈する ──

	describe('anchor は tz 引数の暦日終端で切る（PR-3）', () => {
		/** YYYY-MM-DD UTC start-of-day を ms に */
		const dayMs = (iso: string) => {
			const [y, m, d] = iso.split('-').map(Number);
			return Date.UTC(y, m - 1, d);
		};
		const hourMs = (iso: string, h: number) => dayMs(iso) + h * 3600000;

		it("tz='Asia/Tokyo' × date=20251002 × 1hour × limit=24: normalized の timestamp は JST 10/2 (UTC 10/1 15:00..10/2 14:00) 内に収まる", async () => {
			// bitbank API は UTC 暦日でグルーピング（docs/internal/bitbank-candle-tz.md）。
			// /20251001 と /20251002 の 48 本のうち、anchor=JST 10/2 23:59:59=UTC 10/2 14:59:59
			// 以前の 24 本が選ばれる → JST 10/2 0:00..23:00 (UTC 10/1 15:00..10/2 14:00) 24 本。
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
				const urlStr = String(url);
				const m = urlStr.match(/\/1hour\/(\d{8})$/);
				const dateKey = m ? m[1] : '20251002';
				const y = Number(dateKey.slice(0, 4));
				const mo = Number(dateKey.slice(4, 6));
				const d = Number(dateKey.slice(6, 8));
				// 各 UTC 日について 0:00..23:00 の 24 本を返す
				const baseTs = Date.UTC(y, mo - 1, d);
				const ohlcv = Array.from({ length: 24 }, (_, i) => [
					'100',
					'110',
					'90',
					'105',
					'1.0',
					String(baseTs + i * 3600000),
				]);
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					json: async () => ({ success: 1, data: { candlestick: [{ ohlcv }] } }),
				} as Response;
			});

			const res = await getCandles('btc_jpy', '1hour', '20251002', 24, 'Asia/Tokyo');
			assertOk(res);

			expect(res.data.normalized).toHaveLength(24);
			const tsList = res.data.normalized.map((c: { timestamp: number }) => c.timestamp);
			// 最古 = JST 10/2 0:00 = UTC 10/1 15:00
			expect(tsList[0]).toBe(hourMs('2025-10-01', 15));
			// 最新 = JST 10/2 23:00 = UTC 10/2 14:00
			expect(tsList.at(-1)).toBe(hourMs('2025-10-02', 14));
			// すべて anchor (JST 10/2 23:59:59 = UTC 10/2 14:59:59) 以前
			const jstAnchor = dayMs('2025-10-02') + 15 * 3600000 - 1;
			for (const ts of tsList) expect(ts).toBeLessThanOrEqual(jstAnchor);
		});

		it("tz='UTC' 明示時は UTC 暦日終端 anchor（date=20251002 × 1hour × limit=24 → UTC 10/2 0:00..23:00）", async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
				const urlStr = String(url);
				const m = urlStr.match(/\/1hour\/(\d{8})$/);
				const dateKey = m ? m[1] : '20251002';
				const y = Number(dateKey.slice(0, 4));
				const mo = Number(dateKey.slice(4, 6));
				const d = Number(dateKey.slice(6, 8));
				const baseTs = Date.UTC(y, mo - 1, d);
				const ohlcv = Array.from({ length: 24 }, (_, i) => [
					'100',
					'110',
					'90',
					'105',
					'1.0',
					String(baseTs + i * 3600000),
				]);
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					json: async () => ({ success: 1, data: { candlestick: [{ ohlcv }] } }),
				} as Response;
			});

			const res = await getCandles('btc_jpy', '1hour', '20251002', 24, 'UTC');
			assertOk(res);

			expect(res.data.normalized).toHaveLength(24);
			const tsList = res.data.normalized.map((c: { timestamp: number }) => c.timestamp);
			// tz=UTC の暦日 anchor: UTC 10/2 0:00..23:00 ぴったり
			expect(tsList[0]).toBe(hourMs('2025-10-02', 0));
			expect(tsList.at(-1)).toBe(hourMs('2025-10-02', 23));
			const utcAnchor = dayMs('2025-10-03') - 1; // UTC 10/2 23:59:59.999
			for (const ts of tsList) expect(ts).toBeLessThanOrEqual(utcAnchor);
		});

		it('未来日 (date=20991231) は PR-5 で user エラー (future) として早期 fail する', async () => {
			// PR-5: anchor 計算後の早期 fail で fetch 前に未来日を弾く。
			// mock は fetch されないが安全のため設定しておく。
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ success: 0, data: { code: 10000 } }),
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			// 1day → YYYY 形式に丸められる: '2099'。anchor=JST 2099-12-31 23:59:59
			const res = await getCandles('btc_jpy', '1day', '20991231', 10, 'Asia/Tokyo');
			assertFail(res);
			expect(res.meta?.errorType).toBe('user');
			expect(res.summary).toContain('future');
			// 早期 fail により fetch は呼ばれない
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("tz='' (空文字) は Asia/Tokyo にフォールバックし JST anchor になる", async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
				const urlStr = String(url);
				const m = urlStr.match(/\/1hour\/(\d{8})$/);
				const dateKey = m ? m[1] : '20251002';
				const y = Number(dateKey.slice(0, 4));
				const mo = Number(dateKey.slice(4, 6));
				const d = Number(dateKey.slice(6, 8));
				const baseTs = Date.UTC(y, mo - 1, d);
				const ohlcv = Array.from({ length: 24 }, (_, i) => [
					'100',
					'110',
					'90',
					'105',
					'1.0',
					String(baseTs + i * 3600000),
				]);
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					json: async () => ({ success: 1, data: { candlestick: [{ ohlcv }] } }),
				} as Response;
			});

			const res = await getCandles('btc_jpy', '1hour', '20251002', 24, '');
			assertOk(res);
			const tsList = res.data.normalized.map((c: { timestamp: number }) => c.timestamp);
			// JST anchor の結果 (= 上の Asia/Tokyo ケースと同じ)
			expect(tsList[0]).toBe(hourMs('2025-10-01', 15));
			expect(tsList.at(-1)).toBe(hourMs('2025-10-02', 14));
		});

		it("不正な tz (例: 'Invalid/Zone') は Asia/Tokyo にフォールバックする", async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
				const urlStr = String(url);
				const m = urlStr.match(/\/1hour\/(\d{8})$/);
				const dateKey = m ? m[1] : '20251002';
				const y = Number(dateKey.slice(0, 4));
				const mo = Number(dateKey.slice(4, 6));
				const d = Number(dateKey.slice(6, 8));
				const baseTs = Date.UTC(y, mo - 1, d);
				const ohlcv = Array.from({ length: 24 }, (_, i) => [
					'100',
					'110',
					'90',
					'105',
					'1.0',
					String(baseTs + i * 3600000),
				]);
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					json: async () => ({ success: 1, data: { candlestick: [{ ohlcv }] } }),
				} as Response;
			});

			const res = await getCandles('btc_jpy', '1hour', '20251002', 24, 'Invalid/Zone');
			assertOk(res);
			const tsList = res.data.normalized.map((c: { timestamp: number }) => c.timestamp);
			// Asia/Tokyo フォールバックの結果
			expect(tsList[0]).toBe(hourMs('2025-10-01', 15));
			expect(tsList.at(-1)).toBe(hourMs('2025-10-02', 14));
		});

		it('4hour + date=2025 + tz=America/New_York: tz 年末の足が UTC 次年 chunk にある場合も fetch する', async () => {
			// NY 2025-12-31 23:00 (EST) = UTC 2026-01-01T04:00:00Z。旧実装は /2025 のみ fetch して欠落。
			const nyYearEndBarTs = Date.UTC(2026, 0, 1, 4, 0, 0, 0);
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
				const urlStr = String(url);
				const m = urlStr.match(/\/4hour\/(\d{4})$/);
				const year = m ? Number(m[1]) : 2025;
				const ohlcv =
					year === 2026
						? [['100', '110', '90', '105', '1.0', String(nyYearEndBarTs)]]
						: [
								['100', '110', '90', '105', '1.0', String(Date.UTC(2025, 11, 31, 12, 0, 0, 0))],
								['100', '110', '90', '105', '1.0', String(Date.UTC(2025, 11, 31, 16, 0, 0, 0))],
							];
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					json: async () => ({ success: 1, data: { candlestick: [{ ohlcv }] } }),
				} as Response;
			});

			const res = await getCandles('btc_jpy', '4hour', '2025', 6, 'America/New_York');
			assertOk(res);

			const calledUrls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
			expect(calledUrls.some((u) => u.endsWith('/4hour/2025'))).toBe(true);
			expect(calledUrls.some((u) => u.endsWith('/4hour/2026'))).toBe(true);
			expect(res.data.normalized.at(-1)?.timestamp).toBe(nyYearEndBarTs);
		});

		it('1day (YYYY anchor) + tz=Asia/Tokyo: 年末は JST 12/31 終端で切る (= UTC 12/31 14:59:59)', async () => {
			// UTC 12/31 00:00 (= JST 12/31 09:00) の daily candle は anchor 内、
			// UTC 12/31 23:00 のような次年の足は anchor 外（仮にあれば）。
			// 365 本 + ダミー次年バー 1 本を mock し、365 本残ることを検証する。
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
				const urlStr = String(url);
				const m = urlStr.match(/\/1day\/(\d{4})$/);
				const year = m ? Number(m[1]) : 2025;
				const baseTs = Date.UTC(year, 0, 1);
				const ohlcv = [
					...Array.from({ length: 365 }, (_, i) => ['100', '110', '90', '105', '1.0', String(baseTs + i * 86400000)]),
					// 次年 1/1 00:00 UTC = JST 1/1 09:00（anchor 外）
					['200', '210', '190', '205', '1.0', String(Date.UTC(year + 1, 0, 1))],
				];
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					json: async () => ({ success: 1, data: { candlestick: [{ ohlcv }] } }),
				} as Response;
			});

			const res = await getCandles('btc_jpy', '1day', '2025', 1000, 'Asia/Tokyo');
			assertOk(res);
			// 翌年 1/1 の足は除外、365 本のみ
			const tsList = res.data.normalized.map((c: { timestamp: number }) => c.timestamp);
			expect(tsList.find((ts: number) => ts >= Date.UTC(2026, 0, 1))).toBeUndefined();
			// 末尾は UTC 2025-12-31 00:00（= JST 12/31 09:00）
			expect(tsList.at(-1)).toBe(Date.UTC(2025, 11, 31));
		});
	});

	// ── PR-N: multi-day fetch 範囲は tz 暦日 window から導出する ──

	describe('multi-day fetch 範囲は tz 暦日 window から導出する', () => {
		/** YYYY-MM-DD UTC start-of-day を ms に */
		const dayMs = (iso: string) => {
			const [y, m, d] = iso.split('-').map(Number);
			return Date.UTC(y, m - 1, d);
		};
		const hourMs = (iso: string, h: number) => dayMs(iso) + h * 3600000;

		/** UTC 暦日キー (YYYYMMDD) のローソク 24 本 (0..23 UTC) を返す mock factory */
		const buildPerUtcDayMock = () =>
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
				const urlStr = String(url);
				const m = urlStr.match(/\/1hour\/(\d{8})$/);
				const dateKey = m ? m[1] : '20251002';
				const y = Number(dateKey.slice(0, 4));
				const mo = Number(dateKey.slice(4, 6));
				const d = Number(dateKey.slice(6, 8));
				const baseTs = Date.UTC(y, mo - 1, d);
				const ohlcv = Array.from({ length: 24 }, (_, i) => [
					'100',
					'110',
					'90',
					'105',
					'1.0',
					String(baseTs + i * 3600000),
				]);
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					json: async () => ({ success: 1, data: { candlestick: [{ ohlcv }] } }),
				} as Response;
			});

		it("tz='America/New_York' × date=20251002 × 1hour × limit=24: /20251002 と /20251003 の両方を fetch する", async () => {
			// NY (DST 中, UTC-4) の 10/2 は UTC 10/2 04:00 〜 UTC 10/3 03:59 → 旧実装で漏れていた '次の UTC 日' を含む。
			buildPerUtcDayMock();
			const res = await getCandles('btc_jpy', '1hour', '20251002', 24, 'America/New_York');
			assertOk(res);

			const calledUrls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
			expect(calledUrls.some((u) => u.endsWith('/1hour/20251002'))).toBe(true);
			expect(calledUrls.some((u) => u.endsWith('/1hour/20251003'))).toBe(true);

			// normalized 24 本が NY 10/2 0:00..23:00 = UTC 10/2 04:00..10/3 03:00 に収まる。
			expect(res.data.normalized).toHaveLength(24);
			const tsList = res.data.normalized.map((c: { timestamp: number }) => c.timestamp);
			expect(tsList[0]).toBe(hourMs('2025-10-02', 4));
			expect(tsList.at(-1)).toBe(hourMs('2025-10-03', 3));
		});

		it("tz='America/Los_Angeles' × date=20251002 × 1hour × limit=24: /20251003 まで fetch する", async () => {
			// LA (DST 中, UTC-7) の 10/2 は UTC 10/2 07:00 〜 UTC 10/3 06:59。
			buildPerUtcDayMock();
			const res = await getCandles('btc_jpy', '1hour', '20251002', 24, 'America/Los_Angeles');
			assertOk(res);

			const calledUrls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
			expect(calledUrls.some((u) => u.endsWith('/1hour/20251002'))).toBe(true);
			expect(calledUrls.some((u) => u.endsWith('/1hour/20251003'))).toBe(true);

			expect(res.data.normalized).toHaveLength(24);
			const tsList = res.data.normalized.map((c: { timestamp: number }) => c.timestamp);
			expect(tsList[0]).toBe(hourMs('2025-10-02', 7));
			expect(tsList.at(-1)).toBe(hourMs('2025-10-03', 6));
		});

		it("tz='Asia/Tokyo' × date=20251002 × 1hour × limit=24: /20251001 と /20251002 を fetch、/20251003 は fetch しない", async () => {
			// 既存 PR-3 ケースの回帰確認。JST (UTC+9) の 10/2 は UTC 10/1 15:00 〜 UTC 10/2 14:59。
			buildPerUtcDayMock();
			const res = await getCandles('btc_jpy', '1hour', '20251002', 24, 'Asia/Tokyo');
			assertOk(res);

			const calledUrls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
			expect(calledUrls.some((u) => u.endsWith('/1hour/20251001'))).toBe(true);
			expect(calledUrls.some((u) => u.endsWith('/1hour/20251002'))).toBe(true);
			expect(calledUrls.some((u) => u.endsWith('/1hour/20251003'))).toBe(false);
		});

		it("tz='UTC' × date=20251002 × 1hour × limit=24: window がローカル日と一致するため 1 UTC 日のみ fetch", async () => {
			// UTC 10/2 0:00 〜 UTC 10/2 23:59、limit=24 では lookback がローカル日終端から 0:00 まで戻るため
			// windowStart = localDayStart = UTC 10/2 0:00。UTC range は 1 日のみ → 単一 fetch 経路。
			buildPerUtcDayMock();
			const res = await getCandles('btc_jpy', '1hour', '20251002', 24, 'UTC');
			assertOk(res);

			const calledUrls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
			expect(calledUrls.some((u) => u.endsWith('/1hour/20251002'))).toBe(true);
			// 隣接 UTC 日は要求されない
			expect(calledUrls.some((u) => u.endsWith('/1hour/20251001'))).toBe(false);
			expect(calledUrls.some((u) => u.endsWith('/1hour/20251003'))).toBe(false);

			expect(res.data.normalized).toHaveLength(24);
			const tsList = res.data.normalized.map((c: { timestamp: number }) => c.timestamp);
			expect(tsList[0]).toBe(hourMs('2025-10-02', 0));
			expect(tsList.at(-1)).toBe(hourMs('2025-10-02', 23));
		});

		it("tz='Asia/Tokyo' × date=20251002 × 1min × limit=2880 (2 日分): /20251001 と /20251002 が fetch 範囲に含まれる", async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
				const urlStr = String(url);
				const m = urlStr.match(/\/1min\/(\d{8})$/);
				const dateKey = m ? m[1] : '20251002';
				const y = Number(dateKey.slice(0, 4));
				const mo = Number(dateKey.slice(4, 6));
				const d = Number(dateKey.slice(6, 8));
				const baseTs = Date.UTC(y, mo - 1, d);
				const ohlcv = Array.from({ length: 1440 }, (_, i) => [
					'100',
					'110',
					'90',
					'105',
					'1.0',
					String(baseTs + i * 60_000),
				]);
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					json: async () => ({ success: 1, data: { candlestick: [{ ohlcv }] } }),
				} as Response;
			});

			const res = await getCandles('btc_jpy', '1min', '20251002', 2880, 'Asia/Tokyo');
			assertOk(res);

			const calledUrls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
			expect(calledUrls.some((u) => u.endsWith('/1min/20251001'))).toBe(true);
			expect(calledUrls.some((u) => u.endsWith('/1min/20251002'))).toBe(true);
		});

		it("tz='America/New_York' × date=20251002 × 1hour × limit=1: 小 limit でもローカル日が window に含まれて空にならない", async () => {
			// Math.min(localDayStart, lookbackStart) のおかげで、limit=1 でも windowStart=NY 10/2 0:00=UTC 10/2 04:00
			// → UTC keys=[20251002, 20251003]。lookback が支配的でない場合の安全弁。
			buildPerUtcDayMock();
			const res = await getCandles('btc_jpy', '1hour', '20251002', 1, 'America/New_York');
			assertOk(res);

			const calledUrls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
			expect(calledUrls.some((u) => u.endsWith('/1hour/20251002'))).toBe(true);
			expect(calledUrls.some((u) => u.endsWith('/1hour/20251003'))).toBe(true);

			// limit=1 なので末尾 1 本: NY 10/2 23:00 = UTC 10/3 03:00。
			expect(res.data.normalized).toHaveLength(1);
			expect(res.data.normalized[0]?.timestamp).toBe(hourMs('2025-10-03', 3));
		});

		it('DST 境界日 (NY 2025-11-02) でも結果が空にならずクラッシュしない', async () => {
			// NY は 2025-11-02 02:00 で DST 終了 → 11/2 は 25 時間ある。
			// window は dayjs.tz の startOf/endOf に依存。空配列にならず assertOk できることだけ確認する
			// (DST 境界の厳密な bar count 整合は本 PR スコープ外)。
			buildPerUtcDayMock();
			const res = await getCandles('btc_jpy', '1hour', '20251102', 24, 'America/New_York');
			assertOk(res);
			expect(res.data.normalized.length).toBeGreaterThan(0);
		});
	});

	// ── PR-5: エラー分類の細分化 ──
	// 未来日 / 取引開始前 / 上流 404 / データなし を区別できるメッセージに変更。
	// errorType ('user'/'upstream'/'network') の使い分けは維持し、メッセージのみ user 向けに改善。

	describe('PR-5: エラー分類の細分化', () => {
		it('取引開始前 (date=20100101) は fetch 前に user エラー (before bitbank service start) として早期 fail する', async () => {
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ success: 1, data: { candlestick: [{ ohlcv: [] }] } }),
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = await getCandles('btc_jpy', '1day', '20100101', 10);
			assertFail(res);
			expect(res.meta?.errorType).toBe('user');
			expect(res.summary).toContain('before bitbank service start');
			expect(res.summary).toContain('20100101');
			// fetch 前に弾くので呼ばれない
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('anchor 適用前の空配列 (ohlcv: []) は user エラー (No candle data returned) を返す', async () => {
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ success: 1, data: { candlestick: [{ ohlcv: [] }] } }),
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			// 1day + date=2024 → anchor=JST 2024-12-31 終端（過去・サービス開始後）→ 早期 fail を通り抜ける
			const res = await getCandles('btc_jpy', '1day', '2024', 10);
			assertFail(res);
			expect(res.meta?.errorType).toBe('user');
			expect(res.summary).toContain('No candle data returned');
			expect(res.summary).toContain('btc_jpy');
			expect(res.summary).toContain('1day');
		});

		it('anchor filter 後 0 件 (data はあるが anchor がそれより前) は user エラー (on or before) を返す', async () => {
			// year=2025 fetch で 2025-06 以降のデータのみ返す mock。
			// date=20250105 → anchor=2025-01-05 23:59:59 → 全行が anchor より後 → filter 後 0 件。
			const baseTs = Date.UTC(2025, 5, 1); // 2025-06-01
			const ohlcv = Array.from({ length: 3 }, (_, i) => [
				'100',
				'110',
				'90',
				'105',
				'1.0',
				String(baseTs + i * 86400000),
			]);
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ success: 1, data: { candlestick: [{ ohlcv }] } }),
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = await getCandles('btc_jpy', '1day', '20250105', 10);
			assertFail(res);
			expect(res.meta?.errorType).toBe('user');
			expect(res.summary).toContain('on or before');
			expect(res.summary).toContain('20250105');
		});

		it('4hour × 404: 既存のヒント付きメッセージが残る', async () => {
			const fetchMock = vi.fn().mockRejectedValue(new Error('HTTP 404 Not Found'));
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = await getCandles('btc_jpy', '4hour', '2024', 10);
			assertFail(res);
			expect(res.meta?.errorType).toBe('user');
			// 既存のヒント文言
			expect(res.summary).toContain('HTTP 404 Not Found');
			expect(res.summary).toContain('YYYY 形式');
		});

		it('1day × 404: 新メッセージ "HTTP 404 from bitbank API" 形式を返す', async () => {
			const fetchMock = vi.fn().mockRejectedValue(new Error('HTTP 404 Not Found'));
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const res = await getCandles('btc_jpy', '1day', '2024', 10);
			assertFail(res);
			expect(res.meta?.errorType).toBe('user');
			expect(res.summary).toContain('HTTP 404 from bitbank API');
			expect(res.summary).toContain('btc_jpy');
			expect(res.summary).toContain('1day');
			expect(res.summary).toContain('check pair/type/date validity');
		});
	});

	// ── 形成中足（provisional）注記: realtime のみ ℹ️ 注記 + meta.provisional を立てる ──
	// analyze_indicators / get_volatility_metrics と同じ横展開。生データツール側の漏れを塞ぐ。

	describe('形成中足（provisional）注記', () => {
		/** 末尾の足が「現在形成中」になるよう ts を当日 UTC 0 時に揃えた日足を作る。 */
		const makeRowsEndingToday = (count: number): string[][] => {
			const todayStart = dayjs().utc().startOf('day').valueOf();
			return Array.from({ length: count }, (_, i) => {
				const idxFromEnd = count - 1 - i;
				const base = 100 + i;
				return [
					String(base),
					String(base + 10),
					String(base - 10),
					String(base + 5),
					'1.0',
					String(todayStart - idxFromEnd * 86_400_000),
				];
			});
		};

		/** 過去（2024 年起点）の確定足を作る。 */
		const makePastRows = (count: number): string[][] => {
			const baseTs = 1704067200000; // 2024-01-01 UTC
			return Array.from({ length: count }, (_, i) => [
				String(100 + i),
				String(110 + i),
				String(90 + i),
				String(105 + i),
				'1.0',
				String(baseTs + i * 86_400_000),
			]);
		};

		const mockOhlcv = (rows: string[][]) => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ success: 1, data: { candlestick: [{ ohlcv: rows }] } }),
			} as unknown as Response);
		};

		it('realtime（date 未指定）で最新足が形成中のとき meta.provisional=true かつ summary 先頭に ℹ️ 注記が出る', async () => {
			mockOhlcv(makeRowsEndingToday(30));
			const res = await getCandles('btc_jpy', '1day', undefined, 14);
			assertOk(res);
			expect((res.meta as { provisional?: boolean }).provisional).toBe(true);
			expect(res.summary).toContain('未確定（形成中）');
			// fetchWarning が無いので注記は summary 先頭（⚠️ ではなく ℹ️）。
			expect(res.summary.startsWith('ℹ️')).toBe(true);
		});

		it('過去日 anchor（date 指定）では確定足なので meta.provisional は付かず注記も出ない', async () => {
			mockOhlcv(makePastRows(30));
			const res = await getCandles('btc_jpy', '1day', '2024', 14);
			assertOk(res);
			expect((res.meta as { provisional?: boolean }).provisional).toBeUndefined();
			expect(res.summary).not.toContain('未確定（形成中）');
		});

		it('date 指定時は最新足の期間が未終了でも注記を付けない（!dateProvided ゲート）', async () => {
			// 当月の月足は ts 上 isLatestBarProvisional=true だが、date 指定なので注記を出さない。
			// !dateProvided ゲートが外れると provisional=true に化けるため、それを回帰で防ぐ。
			// now を月の途中に固定する（実時刻に依存すると月境界で ts 判定がブレるため）。
			vi.useFakeTimers();
			try {
				vi.setSystemTime(dayjs.utc('2026-06-17T06:00:00Z').valueOf());
				// 2026-01〜2026-06 の月足。末尾 = 2026-06-01（当月、期間未終了）。
				// anchor=20260610（過去・当月内）で当月足は filter を通過する。
				const rows = Array.from({ length: 6 }, (_, i) => {
					const ts = Date.UTC(2026, i, 1);
					const base = 1000 + i;
					return [String(base), String(base + 10), String(base - 10), String(base + 5), '1.0', String(ts)];
				});
				mockOhlcv(rows);
				const res = await getCandles('btc_jpy', '1month', '20260610', 6);
				assertOk(res);
				// 末尾足は当月（期間未終了）であることを明示。
				expect(res.data.normalized.at(-1)?.timestamp).toBe(Date.UTC(2026, 5, 1));
				// それでも date 指定なので注記・フラグは付かない。
				expect((res.meta as { provisional?: boolean }).provisional).toBeUndefined();
				expect(res.summary).not.toContain('未確定（形成中）');
			} finally {
				vi.useRealTimers();
			}
		});

		it('handler default view: realtime の content header に ℹ️ 注記が含まれる', async () => {
			mockOhlcv(makeRowsEndingToday(30));
			const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 14 })) as {
				content: Array<{ type: string; text: string }>;
			};
			expect(res.content[0].text).toContain('未確定（形成中）');
		});

		it('handler items view: realtime では JSON を content[0] に保ちつつ注記ブロックが残る', async () => {
			mockOhlcv(makeRowsEndingToday(30));
			const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 14, view: 'items' })) as {
				content: Array<{ type: string; text: string }>;
			};
			// content[0] は JSON 配列のまま（既存契約を維持）。
			const parsed = JSON.parse(res.content[0].text);
			expect(Array.isArray(parsed)).toBe(true);
			// 注記は別ブロックとして保持される。
			expect(res.content.some((c) => c.text.includes('未確定（形成中）'))).toBe(true);
		});

		it('handler items view: 過去日 anchor では注記ブロックを付けない', async () => {
			mockOhlcv(makePastRows(30));
			const res = (await toolDef.handler({
				pair: 'btc_jpy',
				type: '1day',
				date: '2024',
				limit: 14,
				view: 'items',
			})) as {
				content: Array<{ type: string; text: string }>;
			};
			expect(res.content.some((c) => c.text.includes('未確定（形成中）'))).toBe(false);
		});
	});
});

// ── JST 早朝（UTC 日付境界前後）の当日データ取得 ──
// 障害再現: 2026-07-08 08:31 JST（= 2026-07-07 23:31 UTC）に「直近24時間」系が全滅した。
// 原因は (1) 未来 UTC 日 chunk の要求 → 404 → 過半数失敗、(2) 当日 date 指定の future 誤拒否。
// bitbank API 実測（docs/internal/bitbank-candle-tz.md / bitbank-tx-archive-tz.md）:
//   - 進行中の UTC 日の candlestick は 200 + 部分データ
//   - 未来の UTC 日は 404、UTC 日開始直後は 200 + success:0 (code:10000)

describe('JST 早朝の当日データ取得（UTC 日付境界回帰）', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/** UTC 暦日キーごとに応答を返すモック。valid な日は 0..23 時の 24 本を返す。 */
	const mockPerUtcDay = (respond: (dateKey: string) => { status: number; body: unknown }) =>
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
			const m = String(url).match(/\/1hour\/(\d{8})$/);
			const { status, body } = respond(m ? m[1] : '');
			return {
				ok: status >= 200 && status < 300,
				status,
				statusText: status === 404 ? 'Not Found' : 'OK',
				headers: { get: () => null },
				json: async () => body,
			} as unknown as Response;
		});

	const dayBars = (dateKey: string) => {
		const y = Number(dateKey.slice(0, 4));
		const mo = Number(dateKey.slice(4, 6));
		const d = Number(dateKey.slice(6, 8));
		const baseTs = Date.UTC(y, mo - 1, d);
		return Array.from({ length: 24 }, (_, i) => ['100', '110', '90', '105', '1.0', String(baseTs + i * 3600000)]);
	};
	const okBody = (dateKey: string) => ({ success: 1, data: { candlestick: [{ ohlcv: dayBars(dateKey) }] } });
	const notFoundBody = { success: 0, data: { code: 10000 } };

	const calledUrls = () => (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));

	it('date 省略 + 1hour + limit=24 @JST 08:31: 進行中 UTC 日のみ fetch し、未来 UTC 日 (JST 当日キー) を要求しない', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(dayjs.utc('2026-07-07T23:31:00Z').valueOf());
		// 未来 UTC 日 20260708 を要求したら 404（実測どおり）→ 旧実装では過半数失敗で全滅していた
		mockPerUtcDay((key) => (key === '20260707' ? { status: 200, body: okBody(key) } : { status: 404, body: notFoundBody }));

		const res = await getCandles('btc_jpy', '1hour', undefined, 24);
		assertOk(res);
		expect(res.data.normalized).toHaveLength(24);
		expect(calledUrls().some((u) => u.endsWith('/1hour/20260707'))).toBe(true);
		expect(calledUrls().some((u) => u.endsWith('/1hour/20260708'))).toBe(false);
	});

	it('date=当日 (JST 20260708) 明示 @JST 08:31: 未来扱いせず部分データを返す', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(dayjs.utc('2026-07-07T23:31:00Z').valueOf());
		mockPerUtcDay((key) => (key === '20260707' ? { status: 200, body: okBody(key) } : { status: 404, body: notFoundBody }));

		const res = await getCandles('btc_jpy', '1hour', '20260708', 8);
		assertOk(res);
		// fetch key は UTC 基準の 20260707 のみ（JST 20260708 の 00:00〜08:31 は UTC 7/7 chunk 内）
		expect(calledUrls().some((u) => u.endsWith('/1hour/20260707'))).toBe(true);
		expect(calledUrls().some((u) => u.endsWith('/1hour/20260708'))).toBe(false);
		expect(res.data.normalized).toHaveLength(8);
		// 当日は最新足が形成中 → 注記が付く
		expect((res.meta as { provisional?: boolean }).provisional).toBe(true);
		expect(res.summary).toContain('未確定（形成中）');
	});

	it('date=翌日 (JST 20260709) は引き続き future として fetch 前に user fail する', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(dayjs.utc('2026-07-07T23:31:00Z').valueOf());
		const fetchSpy = mockPerUtcDay(() => ({ status: 404, body: notFoundBody }));

		const res = await getCandles('btc_jpy', '1hour', '20260709', 8);
		assertFail(res);
		expect(res.summary).toContain('future');
		expect(res.meta?.errorType).toBe('user');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('UTC 日開始直後 @JST 09:05: 進行中 UTC 日 chunk の success:0 は過半数失敗に数えず ℹ️ 注記で許容する', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(dayjs.utc('2026-07-08T00:05:00Z').valueOf());
		// 実測: UTC 日開始直後は 200 + success:0 (code:10000) が返る
		mockPerUtcDay((key) =>
			key === '20260707' ? { status: 200, body: okBody(key) } : { status: 200, body: notFoundBody },
		);

		const res = await getCandles('btc_jpy', '1hour', undefined, 24);
		assertOk(res);
		expect(res.data.normalized).toHaveLength(24);
		expect(calledUrls().some((u) => u.endsWith('/1hour/20260708'))).toBe(true);
		// 過半数失敗 fail にならず、ℹ️ 注記が meta.warning / summary に出る
		expect(res.meta.warning).toContain('ℹ️');
		expect(res.meta.warning).toContain('20260708');
	});

	it('過去 UTC 日 chunk の実失敗（404）は過半数 fail し、メッセージに日付と原因を含む', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(dayjs.utc('2026-07-08T00:05:00Z').valueOf());
		// date=20240115 (JST) → UTC keys [20240114, 20240115]。過去日 20240114 が HTTP 404 → 実失敗。
		mockPerUtcDay((key) => (key === '20240114' ? { status: 404, body: notFoundBody } : { status: 200, body: okBody(key) }));

		const res = await getCandles('btc_jpy', '1hour', '20240115', 24);
		assertFail(res);
		expect(res.summary).toContain('過半数が失敗');
		expect(res.summary).toContain('btc_jpy/1hour');
		expect(res.summary).toContain('20240114');
		expect(res.summary).toContain('404');
	});
});
