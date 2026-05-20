import { afterEach, describe, expect, it, vi } from 'vitest';
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
import analyzeStochSnapshot, { toolDef } from '../tools/analyze_stoch_snapshot.js';
import getCandles from '../tools/get_candles.js';

function makeFlatCandles(count: number, close = 100) {
	return Array.from({ length: count }, (_, i) => ({
		open: close,
		high: close,
		low: close,
		close,
		volume: 1,
		isoTime: `2024-03-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
	}));
}

function buildIndicatorsOk(
	overrides?: Partial<{
		stochK: number | null;
		stochD: number | null;
		prevK: number | null;
		prevD: number | null;
		closes: number[];
	}>,
) {
	const closes = overrides?.closes ?? Array.from({ length: 40 }, (_, i) => 100 + i);
	const candles = closes.map((close, i) => ({
		close,
		isoTime: `2024-02-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
	}));

	return {
		ok: true as const,
		summary: 'ok',
		data: {
			normalized: candles,
			indicators: {
				STOCH_K: overrides?.stochK ?? 55,
				STOCH_D: overrides?.stochD ?? 50,
				STOCH_prevK: overrides?.prevK ?? 45,
				STOCH_prevD: overrides?.prevD ?? 48,
				stoch_k_series: Array.from({ length: closes.length }, () => 50),
				stoch_d_series: Array.from({ length: closes.length }, () => 50),
			},
			chart: {
				candles,
			},
		},
		meta: { pair: 'btc_jpy', type: '1day', count: closes.length },
	};
}

describe('analyze_stoch_snapshot', () => {
	const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);
	const mockedGetCandles = vi.mocked(getCandles);

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('inputSchema: limit は 40 以上のみ許可する', () => {
		const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', type: '1day', limit: 39 });
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

		const res = await analyzeStochSnapshot('btc_jpy', '1day', 120);

		assertFail(res);
		expect(res.meta.errorType).toBe('upstream');
	});

	it('カスタムパラメータ時、必要最小本数ちょうどでも %K/%D を計算できるべき', async () => {
		mockedGetCandles.mockResolvedValueOnce(
			asMockResult({
				ok: true,
				summary: 'ok',
				data: {
					normalized: makeFlatCandles(17, 100),
					raw: {},
				},
				meta: { pair: 'btc_jpy', type: '1day', count: 17 },
			}),
		);

		const res = await analyzeStochSnapshot('btc_jpy', '1day', 40, 14, 3, 2);

		assertOk(res);
		expect(res.data.stoch.k).toBe(50);
		expect(res.data.stoch.d).toBe(50);
		expect(res.data.zone).toBe('neutral');
	});

	it('bullish cross が買われすぎ圏なら説明文はニュートラル圏ではなく現在ゾーンを反映するべき', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildIndicatorsOk({
					stochK: 85,
					stochD: 80,
					prevK: 70,
					prevD: 75,
				}),
			),
		);

		const res = await analyzeStochSnapshot('btc_jpy', '1day', 120);

		assertOk(res);
		expect(res.data.zone).toBe('overbought');
		expect(res.data.crossover.type).toBe('bullish_cross');
		expect(res.data.crossover.description).toContain('買われすぎ圏');
		expect(res.data.crossover.description).not.toContain('ニュートラル圏');
	});

	it('bearish cross をニュートラル圏で検出するべき', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildIndicatorsOk({
					stochK: 45,
					stochD: 50,
					prevK: 55,
					prevD: 50,
				}),
			),
		);

		const res = await analyzeStochSnapshot('btc_jpy', '1day', 120);

		assertOk(res);
		expect(res.data.zone).toBe('neutral');
		expect(res.data.crossover.type).toBe('bearish_cross');
		expect(res.data.tags).toContain('stoch_bearish_cross');
	});

	it('売られすぎ圏での bullish cross は stoch_strong_buy タグを付与するべき', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildIndicatorsOk({
					stochK: 15,
					stochD: 10,
					prevK: 8,
					prevD: 12,
				}),
			),
		);

		const res = await analyzeStochSnapshot('btc_jpy', '1day', 120);

		assertOk(res);
		expect(res.data.zone).toBe('oversold');
		expect(res.data.crossover.type).toBe('bullish_cross');
		expect(res.data.tags).toContain('stoch_oversold');
		expect(res.data.tags).toContain('stoch_bullish_cross');
		expect(res.data.tags).toContain('stoch_strong_buy');
		expect(res.data.crossover.description).toContain('売られすぎ圏からの反転');
	});

	it('買われすぎ圏での bearish cross は stoch_strong_sell タグを付与するべき', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildIndicatorsOk({
					stochK: 85,
					stochD: 90,
					prevK: 92,
					prevD: 88,
				}),
			),
		);

		const res = await analyzeStochSnapshot('btc_jpy', '1day', 120);

		assertOk(res);
		expect(res.data.zone).toBe('overbought');
		expect(res.data.crossover.type).toBe('bearish_cross');
		expect(res.data.tags).toContain('stoch_overbought');
		expect(res.data.tags).toContain('stoch_bearish_cross');
		expect(res.data.tags).toContain('stoch_strong_sell');
		expect(res.data.crossover.description).toContain('買われすぎ圏からの反転');
	});

	it('bearish ダイバージェンスを検出するべき', async () => {
		// price rising but %K falling
		const len = 40;
		const closes = Array.from({ length: len }, (_, i) => 100 + i * 2); // rising prices
		const kSeries = Array.from({ length: len }, (_, i) => 80 - i * 0.5); // falling K
		const ind = buildIndicatorsOk({ closes });
		ind.data.indicators.stoch_k_series = kSeries;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeStochSnapshot('btc_jpy', '1day', 120);

		assertOk(res);
		expect(res.data.divergence.type).toBe('bearish');
		expect(res.data.tags).toContain('stoch_bearish_divergence');
	});

	it('bullish ダイバージェンスを検出するべき', async () => {
		// price falling but %K rising
		const len = 40;
		const closes = Array.from({ length: len }, (_, i) => 200 - i * 2); // falling prices
		const kSeries = Array.from({ length: len }, (_, i) => 20 + i * 0.5); // rising K
		const ind = buildIndicatorsOk({ closes });
		ind.data.indicators.stoch_k_series = kSeries;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeStochSnapshot('btc_jpy', '1day', 120);

		assertOk(res);
		expect(res.data.divergence.type).toBe('bullish');
		expect(res.data.tags).toContain('stoch_bullish_divergence');
	});

	it('無効なペアは ok: false を返す', async () => {
		const res = await analyzeStochSnapshot('invalid_xxx', '1day', 120);
		expect(res.ok).toBe(false);
	});

	it('クロスが発生しない場合 crossover は none を返す', async () => {
		// prevDiff and currDiff have same sign → no cross
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildIndicatorsOk({
					stochK: 55,
					stochD: 50,
					prevK: 55,
					prevD: 50,
				}),
			),
		);

		const res = await analyzeStochSnapshot('btc_jpy', '1day', 120);

		assertOk(res);
		expect(res.data.crossover.type).toBe('none');
	});

	it('chart.candles がない場合は normalized をフォールバックに使うべき', async () => {
		const ind = buildIndicatorsOk();
		(ind.data.chart as Record<string, unknown>).candles = undefined;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeStochSnapshot('btc_jpy', '1day', 120);

		assertOk(res);
		expect(res.data.latest.close).not.toBeNull();
	});

	it('カスタムパラメータ時に getCandles が失敗したら ok: false を返す', async () => {
		mockedGetCandles.mockResolvedValueOnce(
			asMockResult({
				ok: false,
				summary: 'candles failed',
				data: {},
				meta: { errorType: 'upstream' },
			}),
		);

		const res = await analyzeStochSnapshot('btc_jpy', '1day', 40, 10, 5, 5);

		expect(res.ok).toBe(false);
	});

	it('最近のクロスを系列データから検出するべき', async () => {
		const len = 40;
		// Create k/d series with a cross near the end
		const kSeries = Array.from({ length: len }, (_, i) => (i < len - 3 ? 40 : 60));
		const dSeries = Array.from({ length: len }, () => 50);
		const ind = buildIndicatorsOk();
		ind.data.indicators.stoch_k_series = kSeries;
		ind.data.indicators.stoch_d_series = dSeries;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeStochSnapshot('btc_jpy', '1day', 120);

		assertOk(res);
		expect(res.data.recentCrosses.length).toBeGreaterThan(0);
	});

	// ── 上流 warning の伝播（取得層 meta.warning / 計算層 meta.warnings） ──

	describe('上流 warning の伝播', () => {
		it('analyzeIndicators path（default params）: meta.warning（取得層）が tool の meta.warning と summary 先頭に伝播する', async () => {
			const ind = buildIndicatorsOk();
			ind.meta = {
				...ind.meta,
				warning: '⚠️ partial fetch (3日中1日の取得に失敗)',
			} as typeof ind.meta;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

			const res = await analyzeStochSnapshot('btc_jpy', '1day', 120);

			assertOk(res);
			expect(res.meta.warning).toBe('⚠️ partial fetch (3日中1日の取得に失敗)');
			expect(res.meta.warnings).toBeUndefined();
			expect(res.summary.split('\n')[0]).toContain('⚠️ partial fetch');
		});

		it('analyzeIndicators path（default params）: meta.warnings（計算層）が tool の meta.warnings に継承される', async () => {
			const ind = buildIndicatorsOk();
			ind.meta = {
				...ind.meta,
				warnings: ['Stochastic: データ不足', 'SMA_200: データ不足'],
			} as typeof ind.meta;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

			const res = await analyzeStochSnapshot('btc_jpy', '1day', 120);

			assertOk(res);
			expect(res.meta.warnings).toEqual(['Stochastic: データ不足', 'SMA_200: データ不足']);
			expect(res.meta.warning).toBeUndefined();
			expect(res.summary).toContain('⚠️ Stochastic: データ不足');
			expect(res.summary).toContain('⚠️ SMA_200: データ不足');
		});

		it('analyzeIndicators path（default params）: 取得層 warning と計算層 warnings は別フィールドで保持される（混入 NG）', async () => {
			const ind = buildIndicatorsOk();
			ind.meta = {
				...ind.meta,
				warning: '⚠️ partial fetch (multi-year)',
				warnings: ['Stochastic: データ不足'],
			} as typeof ind.meta;
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

			const res = await analyzeStochSnapshot('btc_jpy', '1day', 120);

			assertOk(res);
			expect(res.meta.warning).toBe('⚠️ partial fetch (multi-year)');
			expect(res.meta.warnings).toEqual(['Stochastic: データ不足']);
			expect(res.meta.warnings).not.toContain('partial fetch (multi-year)');
			const lines = res.summary.split('\n');
			expect(lines[0]).toContain('⚠️ partial fetch (multi-year)');
			expect(lines[1]).toContain('⚠️ Stochastic: データ不足');
		});

		it('analyzeIndicators path（default params）: 上流 warning なしなら meta.warning / meta.warnings は付与されない', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildIndicatorsOk()));

			const res = await analyzeStochSnapshot('btc_jpy', '1day', 120);

			assertOk(res);
			expect(res.meta.warning).toBeUndefined();
			expect(res.meta.warnings).toBeUndefined();
			expect(res.summary.startsWith('⚠️')).toBe(false);
		});

		it('getCandles path（custom params）: meta.warning が tool の meta.warning と summary 先頭に伝播する', async () => {
			mockedGetCandles.mockResolvedValueOnce(
				asMockResult({
					ok: true,
					summary: 'ok',
					data: {
						normalized: makeFlatCandles(17, 100),
						raw: {},
					},
					meta: { pair: 'btc_jpy', type: '1day', count: 17, warning: '⚠️ partial fetch (3日中1日の取得に失敗)' },
				}),
			);

			const res = await analyzeStochSnapshot('btc_jpy', '1day', 40, 14, 3, 2);

			assertOk(res);
			expect(res.meta.warning).toBe('⚠️ partial fetch (3日中1日の取得に失敗)');
			// getCandles path では計算層 warnings は出ない
			expect(res.meta.warnings).toBeUndefined();
			expect(res.summary.split('\n')[0]).toContain('⚠️ partial fetch');
		});

		it('getCandles path（custom params）: 上流 meta.warnings が紛れ込んでも drop されて meta.warnings は undefined のまま', async () => {
			// getCandles は本来 warnings を出さないが、契約レベルでの回帰防止として
			// 上流 meta に warnings が混入していても tool 出力には載らないことを保証する。
			mockedGetCandles.mockResolvedValueOnce(
				asMockResult({
					ok: true,
					summary: 'ok',
					data: {
						normalized: makeFlatCandles(17, 100),
						raw: {},
					},
					meta: {
						pair: 'btc_jpy',
						type: '1day',
						count: 17,
						warning: '⚠️ partial fetch (multi-year)',
						warnings: ['不正な計算層 warning（leak すべきでない）'],
					},
				}),
			);

			const res = await analyzeStochSnapshot('btc_jpy', '1day', 40, 14, 3, 2);

			assertOk(res);
			expect(res.meta.warning).toBe('⚠️ partial fetch (multi-year)');
			// getCandles path は取得層のみ。計算層 warnings は契約上 drop される。
			expect(res.meta.warnings).toBeUndefined();
			expect(res.summary).not.toContain('不正な計算層 warning');
		});
	});
});
