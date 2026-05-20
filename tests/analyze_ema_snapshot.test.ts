import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';

vi.mock('../tools/analyze_indicators.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../tools/analyze_indicators.js')>();
	return {
		default: vi.fn(),
		ema: actual.ema,
	};
});

vi.mock('../tools/get_candles.js', () => ({
	default: vi.fn(),
}));

import analyzeEmaSnapshot, { buildEmaSnapshotText, toolDef } from '../tools/analyze_ema_snapshot.js';
import analyzeIndicators from '../tools/analyze_indicators.js';
import getCandles from '../tools/get_candles.js';

function makeSeries(start: number, step: number, len: number) {
	return Array.from({ length: len }, (_, i) => Number((start + step * i).toFixed(4)));
}

function buildIndicatorsOk() {
	const len = 40;
	return {
		ok: true as const,
		summary: 'ok',
		data: {
			normalized: Array.from({ length: len }, (_, i) => ({
				close: i === len - 1 ? 150 : 130,
				isoTime: `2024-02-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
			})),
			indicators: {
				EMA_12: 140,
				EMA_26: 130,
				EMA_50: 120,
				EMA_200: 110,
			},
			chart: {
				candles: Array.from({ length: len }, (_, i) => ({
					isoTime: `2024-02-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
				})),
				indicators: {
					EMA_12: makeSeries(134, 0.2, len),
					EMA_26: makeSeries(125, 0.15, len),
					EMA_50: makeSeries(116, 0.1, len),
					EMA_200: makeSeries(106, 0.05, len),
				},
			},
		},
		meta: { pair: 'btc_jpy', type: '1day', count: len },
	};
}

function buildCandlesOk(closes?: number[]) {
	const len = 40;
	const defaultCloses = Array.from({ length: len }, (_, i) => 130 + i * 0.5);
	const actualCloses = closes ?? defaultCloses;
	return {
		ok: true as const,
		summary: 'ok',
		data: {
			normalized: Array.from({ length: actualCloses.length }, (_, i) => ({
				close: actualCloses[i],
				isoTime: `2024-02-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
			})),
		},
		meta: { pair: 'btc_jpy', type: '1day', count: actualCloses.length },
	};
}

const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);
const mockedGetCandles = vi.mocked(getCandles);

describe('analyze_ema_snapshot', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('inputSchema', () => {
		it('limit は 200 以上のみ許可する', () => {
			const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', type: '1day', limit: 199 });
			expect(parse).toThrow();
		});
	});

	describe('invalid pair', () => {
		it('無効なペアを渡すと ok: false を返す', async () => {
			const res = await analyzeEmaSnapshot('invalid_pair', '1day', 220, [12, 26, 50, 200]);
			assertFail(res);
			expect(res.ok).toBe(false);
		});
	});

	describe('standard periods (hasCustomPeriods=false)', () => {
		it('analyze_indicators が失敗を返した場合は ok: false を返す', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult({
					ok: false,
					summary: 'indicators failed',
					data: {},
					meta: { errorType: 'upstream' },
				}),
			);

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);
			assertFail(res);
			expect(res.meta.errorType).toBe('upstream');
		});

		it('指定periodsのEMAが欠損している場合 alignment は unknown であるべき', async () => {
			const mocked = buildIndicatorsOk();
			(mocked.data.indicators as Record<string, unknown>).EMA_200 = null;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);

			assertOk(res);
			expect(res.data.ema.EMA_200).toBeNull();
			expect(res.data.alignment).toBe('unknown');
		});

		it('重複periods指定時は自己クロス（EMA_12/EMA_12）や重複クロスを出さないべき', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildIndicatorsOk()));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 12, 26]);

			assertOk(res);
			const pairLabels = res.data.crosses.map((c) => `${c.a}/${c.b}`);
			expect(pairLabels).not.toContain('EMA_12/EMA_12');
			expect(new Set(pairLabels).size).toBe(pairLabels.length);
		});

		it('chart.candles が無い場合は normalized にフォールバックする', async () => {
			const mocked = buildIndicatorsOk();
			// Remove chart.candles but keep indicators
			(mocked.data.chart as Record<string, unknown>).candles = undefined;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);

			assertOk(res);
			expect(res.ok).toBe(true);
		});

		it('chart.candles も normalized も無い場合は空配列にフォールバックする', async () => {
			const mocked = buildIndicatorsOk();
			(mocked.data.chart as Record<string, unknown>).candles = undefined;
			(mocked.data as Record<string, unknown>).normalized = undefined;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);
			// Should still complete without throwing
			expect(res.ok).toBeDefined();
		});

		it('chartInd にキーが無い場合は ema_{p}_series にフォールバックする', async () => {
			const mocked = buildIndicatorsOk();
			// Remove chart.indicators so chartInd[key] won't be present
			mocked.data.chart.indicators = {} as typeof mocked.data.chart.indicators;
			// Add ema_12_series to indicators
			(mocked.data.indicators as Record<string, unknown>).ema_12_series = makeSeries(134, 0.2, 40);
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);

			assertOk(res);
			expect(res.ok).toBe(true);
		});

		it('analyze_indicators の summary が空の場合もエラーを正しく返す', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult({
					ok: false,
					summary: '',
					data: {},
					meta: { errorType: 'internal' },
				}),
			);

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);
			assertFail(res);
		});

		it('analyze_indicators の errorType が falsy の場合 internal にフォールバックする', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult({
					ok: false,
					summary: 'failed',
					data: {},
					meta: { errorType: '' },
				}),
			);

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);
			assertFail(res);
			expect(res.meta.errorType).toBe('internal');
		});

		it('chart.indicators が undefined の場合は空オブジェクトにフォールバックする', async () => {
			const mocked = buildIndicatorsOk();
			// Remove chart.indicators entirely to trigger ?? {} branch
			delete (mocked.data.chart as Record<string, unknown>).indicators;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);

			assertOk(res);
			expect(res.ok).toBe(true);
		});
	});

	describe('custom periods (hasCustomPeriods=true)', () => {
		it('getCandles が失敗した場合は ok: false を返す', async () => {
			mockedGetCandles.mockResolvedValueOnce(
				asMockResult({
					ok: false,
					summary: 'candles failed',
					data: {},
					meta: { errorType: 'upstream' },
				}),
			);

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [5, 15]);
			assertFail(res);
			expect(res.ok).toBe(false);
		});

		it('getCandles の summary が空の場合もエラーを正しく返す', async () => {
			mockedGetCandles.mockResolvedValueOnce(
				asMockResult({
					ok: false,
					summary: '',
					data: {},
					meta: { errorType: 'internal' },
				}),
			);

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [5, 15]);
			assertFail(res);
		});

		it('getCandles の errorType が falsy の場合 internal にフォールバックする', async () => {
			mockedGetCandles.mockResolvedValueOnce(
				asMockResult({
					ok: false,
					summary: 'failed',
					data: {},
					meta: { errorType: '' },
				}),
			);

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [5, 15]);
			assertFail(res);
			expect(res.meta.errorType).toBe('internal');
		});

		it('candles データが空の場合 close は null になる', async () => {
			mockedGetCandles.mockResolvedValueOnce(
				asMockResult({
					ok: true as const,
					summary: 'ok',
					data: { normalized: [] },
					meta: { pair: 'btc_jpy', type: '1day', count: 0 },
				}),
			);

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [5, 15]);

			assertOk(res);
			expect(res.data.latest.close).toBeNull();
		});

		it('カスタムペリオド [5, 15] で成功する', async () => {
			mockedGetCandles.mockResolvedValueOnce(asMockResult(buildCandlesOk()));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [5, 15]);

			assertOk(res);
			expect(res.data.ema).toHaveProperty('EMA_5');
			expect(res.data.ema).toHaveProperty('EMA_15');
		});

		it('カスタムペリオドで type=4hour の場合 slopePctPerDay が設定されない', async () => {
			mockedGetCandles.mockResolvedValueOnce(asMockResult(buildCandlesOk()));

			const res = await analyzeEmaSnapshot('btc_jpy', '4hour', 220, [5, 15]);

			assertOk(res);
			// slopePctPerDay should not be set for non-1day types
			for (const key of Object.keys(res.data.emas ?? {})) {
				expect((res.data.emas as Record<string, Record<string, unknown>>)[key]).not.toHaveProperty('slopePctPerDay');
			}
		});
	});

	describe('alignment detection', () => {
		it('bullish alignment: EMA_12 > EMA_26 > EMA_50 > EMA_200 でソート降順', async () => {
			const mocked = buildIndicatorsOk();
			// Sorted ascending: 12 < 26 < 50 < 200, values must be descending for bullish
			mocked.data.indicators = { EMA_12: 200, EMA_26: 150, EMA_50: 120, EMA_200: 100 };
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);

			assertOk(res);
			expect(res.data.alignment).toBe('bullish');
		});

		it('bearish alignment: EMA_12 < EMA_26 < EMA_50 < EMA_200 でソート昇順', async () => {
			const mocked = buildIndicatorsOk();
			mocked.data.indicators = { EMA_12: 100, EMA_26: 120, EMA_50: 150, EMA_200: 200 };
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);

			assertOk(res);
			expect(res.data.alignment).toBe('bearish');
		});

		it('mixed alignment: 順序が一致しない場合', async () => {
			const mocked = buildIndicatorsOk();
			mocked.data.indicators = { EMA_12: 150, EMA_26: 100, EMA_50: 180, EMA_200: 120 };
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);

			assertOk(res);
			expect(res.data.alignment).toBe('mixed');
		});

		it('periods が 2 つ以下の場合 alignment は unknown', async () => {
			const mocked = buildIndicatorsOk();
			mocked.data.indicators = { EMA_12: 200, EMA_26: 150, EMA_50: 120, EMA_200: 100 };
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26]);

			assertOk(res);
			// Only 2 unique periods → vals.length < 3 → unknown
			expect(res.data.alignment).toBe('unknown');
		});
	});

	describe('position detection', () => {
		it('close > all EMAs → above_all', async () => {
			const mocked = buildIndicatorsOk();
			mocked.data.indicators = { EMA_12: 100, EMA_26: 90, EMA_50: 80, EMA_200: 70 };
			// close is 150 (last element of normalized)
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);

			assertOk(res);
			expect(res.data.summary!.position).toBe('above_all');
		});

		it('close < all EMAs → below_all', async () => {
			const mocked = buildIndicatorsOk();
			mocked.data.indicators = { EMA_12: 200, EMA_26: 300, EMA_50: 400, EMA_200: 500 };
			// close is 150 < min 200
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);

			assertOk(res);
			expect(res.data.summary!.position).toBe('below_all');
		});

		it('close between EMAs → between', async () => {
			const mocked = buildIndicatorsOk();
			mocked.data.indicators = { EMA_12: 100, EMA_26: 120, EMA_50: 160, EMA_200: 200 };
			// close is 150, between 120 and 160
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);

			assertOk(res);
			expect(res.data.summary!.position).toBe('between');
		});
	});

	describe('pricePosition per EMA', () => {
		it('close > EMA_val → above branch is exercised (overall position above_all)', async () => {
			const mocked = buildIndicatorsOk();
			mocked.data.indicators = { EMA_12: 100, EMA_26: 90, EMA_50: 80, EMA_200: 70 };
			// close=150 > all EMAs → above branch covered in emasExt computation
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12]);

			assertOk(res);
			// pricePosition is stripped by Zod schema; verify via overall summary position instead
			expect(res.data.summary?.position).toBe('above_all');
		});

		it('close < EMA_val → below branch is exercised (overall position below_all)', async () => {
			const mocked = buildIndicatorsOk();
			mocked.data.indicators = { EMA_12: 300, EMA_26: 290, EMA_50: 280, EMA_200: 270 };
			// close=150 < all EMAs → below branch covered in emasExt computation
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12]);

			assertOk(res);
			expect(res.data.summary?.position).toBe('below_all');
		});

		it('close === EMA_val → equal branch is exercised', async () => {
			const mocked = buildIndicatorsOk();
			mocked.data.indicators = { EMA_12: 150, EMA_26: 150, EMA_50: 150, EMA_200: 150 };
			// close=150 === EMA=150 → equal branch covered in emasExt computation
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12]);

			assertOk(res);
			// close === EMA for all, position is 'between' (not above_all, not below_all)
			expect(res.data.summary?.position).toBe('between');
		});
	});

	describe('slopeOfLabel / slope detection', () => {
		it('十分な系列長で上昇 → rising', async () => {
			const mocked = buildIndicatorsOk();
			// Strong rising series: increases by 1% per bar → pct > 0.002
			const risingLen = 40;
			const base = 100;
			mocked.data.chart.indicators.EMA_12 = Array.from({ length: risingLen }, (_, i) =>
				Number((base * (1 + 0.005 * i)).toFixed(4)),
			);
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12]);

			assertOk(res);
			const emaData = res.data.emas as Record<string, { slope: string }>;
			expect(emaData['12']?.slope).toBe('rising');
		});

		it('十分な系列長で下降 → falling', async () => {
			const mocked = buildIndicatorsOk();
			const len = 40;
			const base = 200;
			mocked.data.chart.indicators.EMA_12 = Array.from({ length: len }, (_, i) =>
				Number((base * (1 - 0.005 * i)).toFixed(4)),
			);
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12]);

			assertOk(res);
			const emaData = res.data.emas as Record<string, { slope: string }>;
			expect(emaData['12']?.slope).toBe('falling');
		});

		it('変化がほぼゼロ → flat', async () => {
			const mocked = buildIndicatorsOk();
			// Very small change: pct < 0.002 and > -0.002 → flat
			mocked.data.chart.indicators.EMA_12 = makeSeries(100, 0.0001, 40);
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12]);

			assertOk(res);
			const emaData = res.data.emas as Record<string, { slope: string }>;
			expect(emaData['12']?.slope).toBe('flat');
		});

		it('系列長が5未満 → flat (n < 6)', async () => {
			const mocked = buildIndicatorsOk();
			mocked.data.chart.indicators.EMA_12 = [100, 101, 102] as unknown as typeof mocked.data.chart.indicators.EMA_12;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12]);

			assertOk(res);
			const emaData = res.data.emas as Record<string, { slope: string; slopePctPerBar: number | null }>;
			expect(emaData['12']?.slope).toBe('flat');
			expect(emaData['12']?.slopePctPerBar).toBeNull();
		});
	});

	describe('type === 1day → slopePctPerDay', () => {
		it('1day タイプでは slopePctPerDay が設定される', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildIndicatorsOk()));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);

			assertOk(res);
			const emaData = res.data.emas as Record<string, { slopePctPerDay?: number | null }>;
			// At least one EMA should have slopePctPerDay set
			const hasDay = Object.values(emaData).some((e) => 'slopePctPerDay' in e);
			expect(hasDay).toBe(true);
		});
	});

	describe('recent crosses detection', () => {
		it('ゴールデンクロス: prevA <= prevB && curA > curB → golden_cross', async () => {
			const mocked = buildIndicatorsOk();
			const len = 40;
			// EMA_12 crosses above EMA_26 at last bar
			const sa12 = Array.from({ length: len }, (_, i) => (i < len - 1 ? 100.0 : 110.0));
			const sa26 = Array.from({ length: len }, () => 105.0);
			mocked.data.chart.indicators.EMA_12 = sa12 as unknown as typeof mocked.data.chart.indicators.EMA_12;
			mocked.data.chart.indicators.EMA_26 = sa26 as unknown as typeof mocked.data.chart.indicators.EMA_26;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26]);

			assertOk(res);
			const crosses = res.data.recentCrosses as Array<{ type: string }>;
			const golden = crosses.filter((c) => c.type === 'golden_cross');
			expect(golden.length).toBeGreaterThan(0);
		});

		it('デッドクロス: prevA >= prevB && curA < curB → dead_cross', async () => {
			const mocked = buildIndicatorsOk();
			const len = 40;
			// EMA_12 crosses below EMA_26 at last bar
			const sa12 = Array.from({ length: len }, (_, i) => (i < len - 1 ? 110.0 : 100.0));
			const sa26 = Array.from({ length: len }, () => 105.0);
			mocked.data.chart.indicators.EMA_12 = sa12 as unknown as typeof mocked.data.chart.indicators.EMA_12;
			mocked.data.chart.indicators.EMA_26 = sa26 as unknown as typeof mocked.data.chart.indicators.EMA_26;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26]);

			assertOk(res);
			const crosses = res.data.recentCrosses as Array<{ type: string }>;
			const dead = crosses.filter((c) => c.type === 'dead_cross');
			expect(dead.length).toBeGreaterThan(0);
		});

		it('クロスが無い場合 recentCrosses は空', async () => {
			const mocked = buildIndicatorsOk();
			// EMA_12 consistently above EMA_26, no crossing
			mocked.data.chart.indicators.EMA_12 = makeSeries(150, 0.1, 40);
			mocked.data.chart.indicators.EMA_26 = makeSeries(100, 0.1, 40);
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26]);

			assertOk(res);
			expect(res.data.recentCrosses).toHaveLength(0);
		});

		it('系列長が 1 以下の場合 recentCrosses は空', async () => {
			const mocked = buildIndicatorsOk();
			mocked.data.chart.indicators.EMA_12 = [100] as unknown as typeof mocked.data.chart.indicators.EMA_12;
			mocked.data.chart.indicators.EMA_26 = [90] as unknown as typeof mocked.data.chart.indicators.EMA_26;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26]);

			assertOk(res);
			expect(res.data.recentCrosses).toHaveLength(0);
		});

		it('chartInd の EMA 系列が配列でない場合は空配列扱いで recentCrosses は空', async () => {
			const mocked = buildIndicatorsOk();
			// Set both EMA_12 and EMA_26 to non-array scalars → else branch in recentCrosses
			(mocked.data.chart.indicators as Record<string, unknown>).EMA_12 = 100;
			(mocked.data.chart.indicators as Record<string, unknown>).EMA_26 = 90;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26]);

			assertOk(res);
			// sa and sb both empty → n=0 < 2 → continue → no crosses
			expect(res.data.recentCrosses).toHaveLength(0);
		});

		it('candles[i].isoTime が null の場合 today() フォールバックが使われる', async () => {
			const mocked = buildIndicatorsOk();
			const len = 40;
			// EMA_12 crosses above EMA_26 at last bar with no isoTime
			const sa12 = Array.from({ length: len }, (_, i) => (i < len - 1 ? 100.0 : 110.0));
			const sa26 = Array.from({ length: len }, () => 105.0);
			mocked.data.chart.indicators.EMA_12 = sa12 as unknown as typeof mocked.data.chart.indicators.EMA_12;
			mocked.data.chart.indicators.EMA_26 = sa26 as unknown as typeof mocked.data.chart.indicators.EMA_26;
			// Remove isoTime from candles so fallback to today() is triggered
			mocked.data.chart.candles = Array.from({ length: len }, () => ({
				isoTime: null,
			})) as unknown as typeof mocked.data.chart.candles;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26]);

			assertOk(res);
			const crosses = res.data.recentCrosses as Array<{ type: string; date: string }>;
			const golden = crosses.filter((c) => c.type === 'golden_cross');
			expect(golden.length).toBeGreaterThan(0);
			// date should be today's date (YYYY-MM-DD format)
			expect(golden[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});
	});

	describe('slopeRates edge cases', () => {
		it('bars <= 0 の場合 slopePctPerBar は null', async () => {
			const mocked = buildIndicatorsOk();
			// prev === 0 → null guard triggered
			const len = 40;
			const series = Array.from({ length: len }, (_, i) => (i === len - 6 ? 0 : 100 + i));
			mocked.data.chart.indicators.EMA_12 = series as unknown as typeof mocked.data.chart.indicators.EMA_12;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12]);

			assertOk(res);
			const emaData = res.data.emas as Record<string, { slopePctPerBar: number | null }>;
			expect(emaData['12']?.slopePctPerBar).toBeNull();
		});

		it('slopeRates: chartInd[key] がリストでない場合は空配列扱い → null', async () => {
			const mocked = buildIndicatorsOk();
			// Set EMA_12 to a non-array scalar so Array.isArray returns false → else branch
			(mocked.data.chart.indicators as Record<string, unknown>).EMA_12 = 999;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12]);

			assertOk(res);
			const emaData = res.data.emas as Record<string, { slopePctPerBar: number | null; slope: string }>;
			// n = 0 < 6 → returns null / flat
			expect(emaData['12']?.slopePctPerBar).toBeNull();
			expect(emaData['12']?.slope).toBe('flat');
		});

		it('slopeRates: 先頭付近で curIdx < 0 → null', async () => {
			const mocked = buildIndicatorsOk();
			// All nulls → curIdx ends at -1 → early return null
			const len = 10;
			const series = Array.from({ length: len }, () => null);
			mocked.data.chart.indicators.EMA_12 = series as unknown as typeof mocked.data.chart.indicators.EMA_12;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12]);

			assertOk(res);
			const emaData = res.data.emas as Record<string, { slopePctPerBar: number | null }>;
			expect(emaData['12']?.slopePctPerBar).toBeNull();
		});

		it('close が null の場合 distancePct は null かつ formatSummary に undefined を渡す', async () => {
			const mocked = buildIndicatorsOk();
			// Make last normalized item have null close so close = null
			(mocked.data.normalized as Array<Record<string, unknown>>)[mocked.data.normalized.length - 1].close = null;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12]);

			assertOk(res);
			expect(res.data.latest.close).toBeNull();
			const emaData = res.data.emas as Record<string, { distancePct: number | null }>;
			expect(emaData['12']?.distancePct).toBeNull();
		});
	});

	describe('catch block', () => {
		it('予期しない例外が発生した場合 ok: false を返す', async () => {
			mockedAnalyzeIndicators.mockImplementationOnce(() => {
				throw new Error('unexpected error');
			});

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);
			assertFail(res);
			expect(res.ok).toBe(false);
		});
	});

	describe('toolDef.handler', () => {
		it('handler がデフォルト引数で正常に呼べる', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildIndicatorsOk()));

			const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 220, periods: [12, 26, 50, 200] });
			expect(res).toBeDefined();
		});
	});

	describe('normalized が配列でない場合のフォールバック', () => {
		it('chart.candles も normalized も配列でない場合 candles は空配列になる', async () => {
			const mocked = buildIndicatorsOk();
			// chart.candles を非配列にし、normalized を文字列にする
			// → Array.isArray(normalized) = false → [] フォールバック (line 140)
			// 文字列は .at() と .length を持つため line 134 と 141 はスローしない
			(mocked.data.chart as Record<string, unknown>).candles = null;
			(mocked.data as Record<string, unknown>).normalized = 'not-an-array';
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(mocked));

			// normalized.at(-1) → 'y' (last char), .close → undefined, close = null
			// normalizedLen = 'not-an-array'.length = 12
			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);
			// Should complete (ok or fail) without throwing
			expect(res.ok).toBeDefined();
		});
	});

	describe('上流 warning の伝播（取得層 meta.warning / 計算層 meta.warnings）', () => {
		it('analyzeIndicators path: meta.warning（取得層）が tool の meta.warning と summary 先頭に伝播する', async () => {
			const ind = buildIndicatorsOk();
			ind.meta = {
				...ind.meta,
				warning: '⚠️ partial fetch (multi-year)',
			} as typeof ind.meta;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);

			assertOk(res);
			expect(res.meta.warning).toBe('⚠️ partial fetch (multi-year)');
			expect(res.meta.warnings).toBeUndefined();
			expect(res.summary.split('\n')[0]).toContain('⚠️ partial fetch');
		});

		it('analyzeIndicators path: meta.warnings（計算層）が tool の meta.warnings に継承される', async () => {
			const ind = buildIndicatorsOk();
			ind.meta = {
				...ind.meta,
				warnings: ['EMA_200: データ不足', 'Ichimoku: データ不足'],
			} as typeof ind.meta;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);

			assertOk(res);
			expect(res.meta.warnings).toEqual(['EMA_200: データ不足', 'Ichimoku: データ不足']);
			expect(res.meta.warning).toBeUndefined();
			expect(res.summary).toContain('⚠️ EMA_200: データ不足');
			expect(res.summary).toContain('⚠️ Ichimoku: データ不足');
		});

		it('analyzeIndicators path: 取得層 warning と計算層 warnings は別フィールドで保持される（混入 NG）', async () => {
			const ind = buildIndicatorsOk();
			ind.meta = {
				...ind.meta,
				warning: '⚠️ partial fetch (multi-year)',
				warnings: ['EMA_200: データ不足'],
			} as typeof ind.meta;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);

			assertOk(res);
			expect(res.meta.warning).toBe('⚠️ partial fetch (multi-year)');
			expect(res.meta.warnings).toEqual(['EMA_200: データ不足']);
			expect(res.meta.warnings).not.toContain('partial fetch (multi-year)');
			const lines = res.summary.split('\n');
			expect(lines[0]).toContain('⚠️ partial fetch (multi-year)');
			expect(lines[1]).toContain('⚠️ EMA_200: データ不足');
		});

		it('analyzeIndicators path: 上流 warning なしなら meta.warning / meta.warnings は付与されない', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildIndicatorsOk()));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [12, 26, 50, 200]);

			assertOk(res);
			expect(res.meta.warning).toBeUndefined();
			expect(res.meta.warnings).toBeUndefined();
			expect(res.summary.startsWith('⚠️')).toBe(false);
		});

		it('getCandles path（custom periods）: meta.warning が tool の meta.warning と summary 先頭に伝播する', async () => {
			const candlesResult = buildCandlesOk();
			candlesResult.meta = {
				...candlesResult.meta,
				warning: '⚠️ partial fetch (3日中1日の取得に失敗)',
			} as typeof candlesResult.meta;
			mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesResult));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [5, 15]);

			assertOk(res);
			expect(res.meta.warning).toBe('⚠️ partial fetch (3日中1日の取得に失敗)');
			// getCandles path では計算層 warnings は出ない
			expect(res.meta.warnings).toBeUndefined();
			expect(res.summary.split('\n')[0]).toContain('⚠️ partial fetch');
		});

		it('getCandles path（custom periods）: 上流 meta.warnings が紛れ込んでも drop されて meta.warnings は undefined のまま', async () => {
			// getCandles は本来 warnings を出さないが、契約レベルでの回帰防止として
			// 上流 meta に warnings が混入していても tool 出力には載らないことを保証する。
			const candlesResult = buildCandlesOk();
			candlesResult.meta = {
				...candlesResult.meta,
				warning: '⚠️ partial fetch (multi-year)',
				// biome-ignore lint/suspicious/noExplicitAny: 契約違反パターンを意図的に注入するためのキャスト
				warnings: ['不正な計算層 warning（leak すべきでない）'] as any,
			} as typeof candlesResult.meta;
			mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesResult));

			const res = await analyzeEmaSnapshot('btc_jpy', '1day', 220, [5, 15]);

			assertOk(res);
			expect(res.meta.warning).toBe('⚠️ partial fetch (multi-year)');
			// getCandles path は取得層のみ。計算層 warnings は契約上 drop される。
			expect(res.meta.warnings).toBeUndefined();
			expect(res.summary).not.toContain('不正な計算層 warning');
		});
	});

	describe('buildEmaSnapshotText', () => {
		const baseInput = {
			baseSummary: 'BTC/JPY summary',
			type: '1day',
			crossStatuses: [],
			recentCrosses: [],
		};

		it('distancePct >= 0 → + プレフィックス', () => {
			const result = buildEmaSnapshotText({
				...baseInput,
				maLines: [
					{
						period: 12,
						value: 100,
						distancePct: 5.0,
						distanceAbs: 500,
						slope: 'rising',
						slopePctPerBar: 0.1,
					},
				],
			});
			expect(result).toContain('+5%');
		});

		it('distancePct < 0 → マイナスのまま', () => {
			const result = buildEmaSnapshotText({
				...baseInput,
				maLines: [
					{
						period: 12,
						value: 100,
						distancePct: -3.5,
						distanceAbs: -350,
						slope: 'falling',
						slopePctPerBar: -0.05,
					},
				],
			});
			expect(result).toContain('-3.5%');
		});

		it('distanceAbs >= 0 → + プレフィックスあり', () => {
			const result = buildEmaSnapshotText({
				...baseInput,
				maLines: [
					{
						period: 12,
						value: 100,
						distancePct: 2,
						distanceAbs: 200,
						slope: 'rising',
						slopePctPerBar: null,
					},
				],
			});
			expect(result).toContain('+');
		});

		it('distancePct=null, distanceAbs=null → n/a', () => {
			const result = buildEmaSnapshotText({
				...baseInput,
				maLines: [
					{
						period: 12,
						value: null,
						distancePct: null,
						distanceAbs: null,
						slope: 'flat',
						slopePctPerBar: null,
					},
				],
			});
			expect(result).toContain('n/a');
		});

		it('slopePctPerBar != null → レート行に含まれる', () => {
			const result = buildEmaSnapshotText({
				...baseInput,
				maLines: [
					{
						period: 12,
						value: 100,
						distancePct: 1,
						distanceAbs: 100,
						slope: 'rising',
						slopePctPerBar: 0.05,
					},
				],
			});
			expect(result).toContain('/day');
		});

		it('slopePctPerBar != null で type が 1day 以外 → /bar', () => {
			const result = buildEmaSnapshotText({
				...baseInput,
				type: '4hour',
				maLines: [
					{
						period: 12,
						value: 100,
						distancePct: 1,
						distanceAbs: 100,
						slope: 'rising',
						slopePctPerBar: 0.05,
					},
				],
			});
			expect(result).toContain('/bar');
		});

		it('slopePctPerBar=null → レートなし', () => {
			const result = buildEmaSnapshotText({
				...baseInput,
				maLines: [
					{
						period: 12,
						value: 100,
						distancePct: 1,
						distanceAbs: 100,
						slope: 'flat',
						slopePctPerBar: null,
					},
				],
			});
			expect(result).not.toContain('/day');
			expect(result).not.toContain('/bar');
		});

		it('pricePosition=above → （価格は上）', () => {
			const result = buildEmaSnapshotText({
				...baseInput,
				maLines: [
					{
						period: 12,
						value: 100,
						distancePct: 1,
						distanceAbs: 100,
						slope: 'rising',
						slopePctPerBar: null,
						pricePosition: 'above',
					},
				],
			});
			expect(result).toContain('（価格は上）');
		});

		it('pricePosition=below → （価格は下）', () => {
			const result = buildEmaSnapshotText({
				...baseInput,
				maLines: [
					{
						period: 12,
						value: 100,
						distancePct: -1,
						distanceAbs: -100,
						slope: 'falling',
						slopePctPerBar: null,
						pricePosition: 'below',
					},
				],
			});
			expect(result).toContain('（価格は下）');
		});

		it('pricePosition=equal → （同水準）', () => {
			const result = buildEmaSnapshotText({
				...baseInput,
				maLines: [
					{
						period: 12,
						value: 100,
						distancePct: 0,
						distanceAbs: 0,
						slope: 'flat',
						slopePctPerBar: null,
						pricePosition: 'equal',
					},
				],
			});
			expect(result).toContain('（同水準）');
		});

		it('crossStatuses がある場合 Cross Status セクションを含む', () => {
			const result = buildEmaSnapshotText({
				...baseInput,
				maLines: [],
				crossStatuses: [{ a: 'EMA_12', b: 'EMA_26', type: 'golden', delta: 10 }],
			});
			expect(result).toContain('Cross Status:');
			expect(result).toContain('EMA_12/EMA_26: golden (delta:10)');
		});

		it('recentCrosses がある場合 Recent Crosses セクションを含む', () => {
			const result = buildEmaSnapshotText({
				...baseInput,
				maLines: [],
				recentCrosses: [{ type: 'golden_cross', pair: [12, 26], barsAgo: 3, date: '2024-02-10' }],
			});
			expect(result).toContain('Recent Crosses (all):');
			expect(result).toContain('golden_cross 12/26 - 3 bars ago (2024-02-10)');
		});

		it('crossStatuses が空なら Cross Status セクションを含まない', () => {
			const result = buildEmaSnapshotText({
				...baseInput,
				maLines: [],
				crossStatuses: [],
			});
			expect(result).not.toContain('Cross Status:');
		});

		it('recentCrosses が空なら Recent Crosses セクションを含まない', () => {
			const result = buildEmaSnapshotText({
				...baseInput,
				maLines: [],
				recentCrosses: [],
			});
			expect(result).not.toContain('Recent Crosses (all):');
		});
	});
});
