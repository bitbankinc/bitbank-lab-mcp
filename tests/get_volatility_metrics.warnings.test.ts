import { afterEach, describe, expect, it, vi } from 'vitest';
import { toIsoTime } from '../lib/datetime.js';

vi.mock('../tools/get_candles.js', () => ({
	default: vi.fn(),
}));

import getCandles from '../tools/get_candles.js';
import getVolatilityMetrics from '../tools/get_volatility_metrics.js';
import { assertOk } from './_assertResult.js';

const mockedGetCandles = vi.mocked(getCandles);

afterEach(() => {
	vi.clearAllMocks();
});

type Candle = { open: number; high: number; low: number; close: number; volume?: number; isoTime?: string | null };

function makeCandle(i: number, opts: Partial<Candle> = {}): Candle {
	const ts = Date.UTC(2025, 0, 1) + i * 86_400_000;
	const base = 10_000_000 + i * 1000;
	return {
		open: base,
		high: base * 1.01,
		low: base * 0.99,
		close: base * (1 + Math.sin(i * 0.5) * 0.01),
		volume: 100,
		isoTime: toIsoTime(ts) ?? undefined,
		...opts,
	};
}

function makeCandles(count: number): Candle[] {
	return Array.from({ length: count }, (_, i) => makeCandle(i));
}

function mockCandlesOk(normalized: Candle[], extraMeta: Record<string, unknown> = {}) {
	mockedGetCandles.mockResolvedValueOnce({
		ok: true,
		summary: 'ok',
		data: { raw: {}, normalized },
		meta: {
			pair: 'btc_jpy',
			fetchedAt: '2025-01-01T00:00:00.000Z',
			type: '1day',
			count: normalized.length,
			...extraMeta,
		},
	} as never);
}

describe('get_volatility_metrics: meta.warning / sampleSize (skip 経路)', () => {
	describe('不正 OHLC のスキップ', () => {
		it('不正 OHLC を含む場合、close 配列が短くなり meta.warning が立つ', async () => {
			const normalized = makeCandles(35);
			for (let i = normalized.length - 3; i < normalized.length; i++) {
				normalized[i].high = Number.NaN;
			}
			mockCandlesOk(normalized);

			const res = await getVolatilityMetrics('btc_jpy', '1day', 35);
			assertOk(res);
			// 35 - 3 = 32 本が有効
			expect(res.data.series.close.length).toBe(32);
			expect(res.data.meta.sampleSize).toBe(32);
			const warning = (res.meta as { warning?: string }).warning;
			expect(warning).toBeDefined();
			expect(warning).toContain('3件の不正な OHLC');
			expect(res.summary.startsWith('⚠️')).toBe(true);
			expect(res.summary).toContain('3件の不正な OHLC');
		});

		it('全件正常なら meta.warning は出ない', async () => {
			mockCandlesOk(makeCandles(30));
			const res = await getVolatilityMetrics('btc_jpy', '1day', 30);
			assertOk(res);
			expect((res.meta as { warning?: string }).warning).toBeUndefined();
			expect(res.data.meta.sampleSize).toBe(30);
			expect(res.data.series.close.length).toBe(30);
		});
	});

	describe('isoTime 欠損のスキップ', () => {
		it('isoTime 欠損ローソク足はスキップされ meta.warning が立つ', async () => {
			const normalized = makeCandles(35);
			for (let i = normalized.length - 2; i < normalized.length; i++) {
				normalized[i].isoTime = null;
			}
			mockCandlesOk(normalized);

			const res = await getVolatilityMetrics('btc_jpy', '1day', 35);
			assertOk(res);
			// 35 - 2 = 33 本が有効
			expect(res.data.series.close.length).toBe(33);
			expect(res.data.meta.sampleSize).toBe(33);
			// ts 配列も同じ長さ（合成された Date.now() は含まれない）
			expect(res.data.series.ts.length).toBe(33);
			const warning = (res.meta as { warning?: string }).warning;
			expect(warning).toBeDefined();
			expect(warning).toContain('2件の isoTime 欠損');
		});

		it('isoTime が undefined（プロパティ自体欠損）でもスキップされる', async () => {
			const normalized: Candle[] = makeCandles(30);
			delete (normalized[5] as { isoTime?: string | null }).isoTime;
			mockCandlesOk(normalized);

			const res = await getVolatilityMetrics('btc_jpy', '1day', 30);
			assertOk(res);
			expect(res.data.series.close.length).toBe(29);
			expect(res.data.meta.sampleSize).toBe(29);
			const warning = (res.meta as { warning?: string }).warning;
			expect(warning).toBeDefined();
			expect(warning).toContain('1件の isoTime 欠損');
		});

		it('isoTime 欠損時に Date.now() を埋めない（ts 配列は全て 2025 年起点）', async () => {
			const normalized = makeCandles(30);
			for (let i = 25; i < 30; i++) {
				normalized[i].isoTime = null;
			}
			mockCandlesOk(normalized);

			const before = Date.now();
			const res = await getVolatilityMetrics('btc_jpy', '1day', 30);
			assertOk(res);
			// 全 ts は 2025 年由来（Date.now() が混入しない）
			for (const t of res.data.series.ts) {
				expect(t).toBeLessThan(before);
			}
		});
	});

	it('OHLC 不正と isoTime 欠損の両方を含む場合、両方の警告が出る', async () => {
		const normalized = makeCandles(40);
		normalized[10].high = Number.NaN; // OHLC 不正 1 件
		normalized[11].isoTime = null; // isoTime 欠損 1 件
		normalized[12].isoTime = null; // isoTime 欠損 1 件
		mockCandlesOk(normalized);

		const res = await getVolatilityMetrics('btc_jpy', '1day', 40);
		assertOk(res);
		expect(res.data.series.close.length).toBe(37);
		expect(res.data.meta.sampleSize).toBe(37);
		const warning = (res.meta as { warning?: string }).warning;
		expect(warning).toBeDefined();
		expect(warning).toContain('1件の不正な OHLC');
		expect(warning).toContain('2件の isoTime 欠損');
	});

	describe('上流 get_candles の fetchWarning 伝播', () => {
		it('上流 meta.warning が vol の meta.warning に伝播する', async () => {
			const upstreamWarning = '⚠️ 4年中1年の取得に失敗しました（2020年）。データが不完全な可能性があります。';
			mockCandlesOk(makeCandles(50), { warning: upstreamWarning });

			const res = await getVolatilityMetrics('btc_jpy', '1day', 50);
			assertOk(res);
			const warning = (res.meta as { warning?: string }).warning;
			expect(warning).toBeDefined();
			expect(warning).toContain('4年中1年の取得に失敗');
			expect(res.summary.startsWith('⚠️')).toBe(true);
			expect(res.summary).toContain('4年中1年の取得に失敗');
		});

		it('上流 warning と自前スキップ警告が両方あれば両方とも残る', async () => {
			const upstreamWarning = '⚠️ 3日中1日の取得に失敗しました。';
			const normalized = makeCandles(40);
			normalized[5].close = Number.NaN; // OHLC 不正 1 件
			mockCandlesOk(normalized, { warning: upstreamWarning });

			const res = await getVolatilityMetrics('btc_jpy', '1day', 40);
			assertOk(res);
			const warning = (res.meta as { warning?: string }).warning;
			expect(warning).toBeDefined();
			expect(warning).toContain('3日中1日の取得に失敗');
			expect(warning).toContain('1件の不正な OHLC');
		});

		it('上流 warning が無く自前スキップも無ければ meta.warning は出ない', async () => {
			mockCandlesOk(makeCandles(30));
			const res = await getVolatilityMetrics('btc_jpy', '1day', 30);
			assertOk(res);
			expect((res.meta as { warning?: string }).warning).toBeUndefined();
			expect(res.summary.startsWith('⚠️')).toBe(false);
		});
	});
});
