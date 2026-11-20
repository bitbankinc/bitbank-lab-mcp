import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../lib/datetime.js';
import type { Candle } from '../src/schemas.js';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';

vi.mock('../tools/analyze_indicators.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../tools/analyze_indicators.js')>();
	return {
		...actual,
		default: vi.fn(),
	};
});

vi.mock('../tools/get_candles.js', () => ({
	default: vi.fn(),
}));

import analyzeIndicators from '../tools/analyze_indicators.js';
import analyzeRsiSnapshot, { toolDef } from '../tools/analyze_rsi_snapshot.js';
import getCandles from '../tools/get_candles.js';

// 型は CandleSchema 由来にする。provisional 判定は最新足の timestamp を読むので、リテラル推論のままだと最新足に timestamp を後付けするテストが型エラーになる。
function makeRisingCandles(count: number, start = 100): Candle[] {
	return Array.from({ length: count }, (_, i) => ({
		open: start + i,
		high: start + i,
		low: start + i,
		close: start + i,
		volume: 1,
		isoTime: `2024-03-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
	}));
}

function buildIndicatorsOk(
	overrides?: Partial<{
		rsiSeries: (number | null)[];
		closes: number[];
	}>,
) {
	const closes = overrides?.closes ?? Array.from({ length: 40 }, (_, i) => 100 + i);
	const rsiSeries = overrides?.rsiSeries ?? Array.from({ length: closes.length }, () => 55);
	const candles: Pick<Candle, 'close' | 'isoTime' | 'timestamp'>[] = closes.map((close, i) => ({
		close,
		isoTime: `2024-02-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
	}));

	return {
		ok: true as const,
		summary: 'ok',
		data: {
			normalized: candles,
			indicators: {
				RSI_14: rsiSeries.at(-1) ?? null,
				RSI_14_series: rsiSeries,
			},
			chart: {
				candles,
			},
		},
		meta: { pair: 'btc_jpy', type: '1day', count: closes.length },
	};
}

describe('analyze_rsi_snapshot', () => {
	const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);
	const mockedGetCandles = vi.mocked(getCandles);

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('inputSchema: limit は 40 以上のみ許可する', () => {
		const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', type: '1day', limit: 39 });
		expect(parse).toThrow();
	});

	it('inputSchema: period は 2 以上のみ許可する', () => {
		const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', type: '1day', period: 1 });
		expect(parse).toThrow();
	});

	it('analyze_indicators が失敗を返した場合は ok: false を返す', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult({
				ok: false,
				summary: 'indicators failed',
				data: {},
				meta: { errorType: 'upstream' },
			}),
		);

		const res = await analyzeRsiSnapshot('btc_jpy', '1day', 120);

		assertFail(res);
		expect(res.meta.errorType).toBe('upstream');
	});

	it('買われすぎ圏を判定し rsi_overbought タグと content の RSI 行を出すべき', async () => {
		const closes = Array.from({ length: 40 }, () => 100);
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(buildIndicatorsOk({ closes, rsiSeries: Array.from({ length: 40 }, () => 75) })),
		);

		const res = await analyzeRsiSnapshot('btc_jpy', '1day', 120);

		assertOk(res);
		expect(res.data.zone).toBe('overbought');
		expect(res.data.rsi.value).toBe(75);
		expect(res.data.tags).toContain('rsi_overbought');
		expect(res.data.midlineCross.type).toBe('none');
		expect(res.summary).toContain('RSI(14): 75.00');
		expect(res.summary).toContain('📌 含まれるもの');
	});

	it('売られすぎ圏を判定し rsi_oversold タグを付与するべき', async () => {
		const closes = Array.from({ length: 40 }, () => 100);
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(buildIndicatorsOk({ closes, rsiSeries: Array.from({ length: 40 }, () => 25) })),
		);

		const res = await analyzeRsiSnapshot('btc_jpy', '1day', 120);

		assertOk(res);
		expect(res.data.zone).toBe('oversold');
		expect(res.data.tags).toContain('rsi_oversold');
	});

	it('50 ライン上抜けで bullish_cross を検出するべき', async () => {
		const rsiSeries = [...Array.from({ length: 38 }, () => 45), 48, 55];
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildIndicatorsOk({ rsiSeries })));

		const res = await analyzeRsiSnapshot('btc_jpy', '1day', 120);

		assertOk(res);
		expect(res.data.zone).toBe('above_midline');
		expect(res.data.midlineCross.type).toBe('bullish_cross');
		expect(res.data.midlineCross.description).toContain('上抜け');
		expect(res.data.tags).toContain('rsi_bullish_cross');
		expect(res.data.recentCrosses.length).toBeGreaterThan(0);
		expect(res.data.recentCrosses.at(-1)?.type).toBe('bullish_cross');
		expect(res.data.recentCrosses.at(-1)?.barsAgo).toBe(0);
	});

	it('50 ライン下抜けで bearish_cross を検出するべき', async () => {
		const closes = Array.from({ length: 40 }, () => 100);
		const rsiSeries = [...Array.from({ length: 38 }, () => 55), 52, 45];
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildIndicatorsOk({ closes, rsiSeries })));

		const res = await analyzeRsiSnapshot('btc_jpy', '1day', 120);

		assertOk(res);
		expect(res.data.zone).toBe('below_midline');
		expect(res.data.midlineCross.type).toBe('bearish_cross');
		expect(res.data.tags).toContain('rsi_bearish_cross');
	});

	it('クロスが発生しない場合 midlineCross は none を返す', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildIndicatorsOk()));

		const res = await analyzeRsiSnapshot('btc_jpy', '1day', 120);

		assertOk(res);
		expect(res.data.midlineCross.type).toBe('none');
		expect(res.data.recentCrosses).toEqual([]);
	});

	it('bearish ダイバージェンスを検出するべき', async () => {
		// price rising but RSI falling
		const len = 40;
		const closes = Array.from({ length: len }, (_, i) => 100 + i * 2);
		const rsiSeries = Array.from({ length: len }, (_, i) => 80 - i * 0.5);
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildIndicatorsOk({ closes, rsiSeries })));

		const res = await analyzeRsiSnapshot('btc_jpy', '1day', 120);

		assertOk(res);
		expect(res.data.divergence.type).toBe('bearish');
		expect(res.data.tags).toContain('rsi_bearish_divergence');
	});

	it('bullish ダイバージェンスを検出するべき', async () => {
		// price falling but RSI rising
		const len = 40;
		const closes = Array.from({ length: len }, (_, i) => 200 - i * 2);
		const rsiSeries = Array.from({ length: len }, (_, i) => 20 + i * 0.5);
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildIndicatorsOk({ closes, rsiSeries })));

		const res = await analyzeRsiSnapshot('btc_jpy', '1day', 120);

		assertOk(res);
		expect(res.data.divergence.type).toBe('bullish');
		expect(res.data.tags).toContain('rsi_bullish_divergence');
	});

	it('無効なペアは ok: false を返す', async () => {
		const res = await analyzeRsiSnapshot('invalid_xxx', '1day', 120);
		expect(res.ok).toBe(false);
	});

	it('カスタム period は getCandles 直叩きで実計算するべき（全上昇 → RSI 100）', async () => {
		mockedGetCandles.mockResolvedValueOnce(
			asMockResult({
				ok: true,
				summary: 'ok',
				data: {
					normalized: makeRisingCandles(20),
					raw: {},
				},
				meta: { pair: 'btc_jpy', type: '1day', count: 20 },
			}),
		);

		const res = await analyzeRsiSnapshot('btc_jpy', '1day', 40, 5);

		assertOk(res);
		expect(mockedAnalyzeIndicators).not.toHaveBeenCalled();
		expect(res.data.rsi.value).toBe(100);
		expect(res.data.zone).toBe('overbought');
		expect((res.meta as { params?: { period?: number } }).params?.period).toBe(5);
	});

	it('カスタム period 時に getCandles が失敗したら ok: false を返す', async () => {
		mockedGetCandles.mockResolvedValueOnce(
			asMockResult({
				ok: false,
				summary: 'candles failed',
				data: {},
				meta: { errorType: 'upstream' },
			}),
		);

		const res = await analyzeRsiSnapshot('btc_jpy', '1day', 40, 10);

		expect(res.ok).toBe(false);
	});

	describe('上流 warning の伝播', () => {
		it('analyzeIndicators path（default period）: meta.warning / meta.warnings が別フィールドのまま summary 先頭に伝播する', async () => {
			const ind = buildIndicatorsOk();
			ind.meta = {
				...ind.meta,
				warning: '⚠️ partial fetch (3日中1日の取得に失敗)',
				warnings: ['RSI_14: データ不足'],
			} as typeof ind.meta;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

			const res = await analyzeRsiSnapshot('btc_jpy', '1day', 120);

			assertOk(res);
			expect(res.meta.warning).toBe('⚠️ partial fetch (3日中1日の取得に失敗)');
			expect(res.meta.warnings).toEqual(['RSI_14: データ不足']);
			const lines = res.summary.split('\n');
			expect(lines[0]).toContain('⚠️ partial fetch');
			expect(lines[1]).toContain('⚠️ RSI_14: データ不足');
		});

		it('analyzeIndicators path（default period）: 上流 warning なしなら meta.warning / meta.warnings は付与されない', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildIndicatorsOk()));

			const res = await analyzeRsiSnapshot('btc_jpy', '1day', 120);

			assertOk(res);
			expect(res.meta.warning).toBeUndefined();
			expect(res.meta.warnings).toBeUndefined();
			expect(res.summary.startsWith('⚠️')).toBe(false);
		});

		it('getCandles path（custom period）: meta.warning は伝播し、紛れ込んだ meta.warnings は drop する', async () => {
			mockedGetCandles.mockResolvedValueOnce(
				asMockResult({
					ok: true,
					summary: 'ok',
					data: {
						normalized: makeRisingCandles(20),
						raw: {},
					},
					meta: {
						pair: 'btc_jpy',
						type: '1day',
						count: 20,
						warning: '⚠️ partial fetch (multi-year)',
						warnings: ['不正な計算層 warning（leak すべきでない）'],
					},
				}),
			);

			const res = await analyzeRsiSnapshot('btc_jpy', '1day', 40, 5);

			assertOk(res);
			expect(res.meta.warning).toBe('⚠️ partial fetch (multi-year)');
			expect(res.meta.warnings).toBeUndefined();
			expect(res.summary).not.toContain('不正な計算層 warning');
			expect(res.summary.split('\n')[0]).toContain('⚠️ partial fetch');
		});
	});

	// default period は analyzeIndicators 経由、非デフォルトは getCandles 直叩きなので、両 path で最新足 ts から判定されることを確認する。
	describe('形成中足（provisional）注記', () => {
		const todayUtcStart = () => dayjs().utc().startOf('day').valueOf();

		it('default period × realtime: 未確定注記が出て meta.provisional=true', async () => {
			const ind = buildIndicatorsOk();
			const norm = ind.data.normalized;
			norm[norm.length - 1] = { ...norm[norm.length - 1], timestamp: todayUtcStart() };
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

			const res = await analyzeRsiSnapshot('btc_jpy', '1day', 120);

			assertOk(res);
			expect(res.summary).toContain('ℹ️ 最新足は未確定（形成中）');
			expect((res.meta as { provisional?: boolean }).provisional).toBe(true);
		});

		it('非デフォルト period × 過去の確定足: 注記が出ず meta.provisional も付かない', async () => {
			const candles = makeRisingCandles(20);
			candles[candles.length - 1] = { ...candles[candles.length - 1], timestamp: Date.UTC(2024, 0, 1) };
			mockedGetCandles.mockResolvedValueOnce(
				asMockResult({
					ok: true,
					summary: 'ok',
					data: { normalized: candles, raw: {} },
					meta: { pair: 'btc_jpy', type: '1day', count: 20 },
				}),
			);

			const res = await analyzeRsiSnapshot('btc_jpy', '1day', 40, 5);

			assertOk(res);
			expect(res.summary).not.toContain('未確定（形成中）');
			expect((res.meta as { provisional?: boolean }).provisional).toBeUndefined();
		});
	});
});
