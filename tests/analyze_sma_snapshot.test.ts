import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';

vi.mock('../tools/analyze_indicators.js', () => ({
	default: vi.fn(),
}));

import analyzeIndicators from '../tools/analyze_indicators.js';
import analyzeSmaSnapshot, { toolDef } from '../tools/analyze_sma_snapshot.js';

function makeSeries(start: number, step: number, len: number) {
	return Array.from({ length: len }, (_, i) => Number((start + step * i).toFixed(2)));
}

function buildIndicatorsOk() {
	const len = 40;
	return {
		ok: true as const,
		summary: 'ok',
		data: {
			normalized: Array.from({ length: len }, (_, i) => ({
				close: i === len - 1 ? 140 : 120,
				isoTime: `2024-01-${String((i % 30) + 1).padStart(2, '0')}T00:00:00.000Z`,
			})),
			indicators: {
				SMA_5: 130,
				SMA_20: 120,
				SMA_50: 110,
			},
			chart: {
				candles: Array.from({ length: len }, (_, i) => ({
					isoTime: `2024-01-${String((i % 30) + 1).padStart(2, '0')}T00:00:00.000Z`,
				})),
				indicators: {
					SMA_5: makeSeries(126, 0.2, len),
					SMA_20: makeSeries(118, 0.15, len),
					SMA_50: makeSeries(108, 0.1, len),
				},
			},
		},
		meta: { pair: 'btc_jpy', type: '1day', count: len },
	};
}

describe('analyze_sma_snapshot', () => {
	const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('inputSchema: limit は 200 以上のみ許可する', () => {
		const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', type: '1day', limit: 199 });
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

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [25, 75, 200]);
		assertFail(res);
		expect(res.meta.errorType).toBe('upstream');
	});

	it('alignment は固定 25/75/200 ではなく指定 periods（5/20/50）で判定されるべき', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildIndicatorsOk()));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5, 20, 50]);

		assertOk(res);
		expect(res.data.alignment).toBe('bullish');
	});

	it('指定 periods が強気整列なら sma_bullish_alignment タグが付与されるべき', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildIndicatorsOk()));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5, 20, 50]);

		assertOk(res);
		expect(res.data.tags).toContain('sma_bullish_alignment');
	});

	it('periods が1つだけの場合 alignment は unknown（整列判定しない）であるべき', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildIndicatorsOk()));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5]);

		assertOk(res);
		expect(res.data.alignment).toBe('unknown');
		expect(res.data.tags).not.toContain('sma_bullish_alignment');
		expect(res.data.tags).not.toContain('sma_bearish_alignment');
	});

	it('重複 periods 指定時は自己クロス（SMA_5/SMA_5）や重複クロスを出さないべき', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildIndicatorsOk()));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5, 5, 20]);

		assertOk(res);
		const pairLabels = res.data.crosses.map((c) => `${c.a}/${c.b}`);
		expect(pairLabels).not.toContain('SMA_5/SMA_5');
		expect(new Set(pairLabels).size).toBe(pairLabels.length);
	});

	it('弱気整列なら sma_bearish_alignment タグが付与されるべき', async () => {
		// SMA_5 < SMA_20 < SMA_50 → bearish (短期が長期より低い = 降順)
		const ind = buildIndicatorsOk();
		ind.data.indicators.SMA_5 = 100;
		ind.data.indicators.SMA_20 = 120;
		ind.data.indicators.SMA_50 = 140;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5, 20, 50]);

		assertOk(res);
		expect(res.data.alignment).toBe('bearish');
		expect(res.data.tags).toContain('sma_bearish_alignment');
	});

	it('整列がどちらでもなければ mixed を返す', async () => {
		const ind = buildIndicatorsOk();
		// SMA_5=130 > SMA_20=120 but SMA_50=125 (not monotonic)
		ind.data.indicators.SMA_5 = 130;
		ind.data.indicators.SMA_20 = 120;
		ind.data.indicators.SMA_50 = 125;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5, 20, 50]);

		assertOk(res);
		expect(res.data.alignment).toBe('mixed');
		expect(res.data.tags).not.toContain('sma_bullish_alignment');
		expect(res.data.tags).not.toContain('sma_bearish_alignment');
	});

	it('価格が全SMAより下なら position=below_all を返す', async () => {
		const ind = buildIndicatorsOk();
		// close=140 だが SMA を全部高くする
		ind.data.indicators.SMA_5 = 150;
		ind.data.indicators.SMA_20 = 160;
		ind.data.indicators.SMA_50 = 170;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5, 20, 50]);

		assertOk(res);
		expect(res.data.summary!.position).toBe('below_all');
	});

	it('価格がSMAの間にある場合は position=between を返す', async () => {
		const ind = buildIndicatorsOk();
		// close=140, SMA_5=130 (below), SMA_50=150 (above)
		ind.data.indicators.SMA_5 = 130;
		ind.data.indicators.SMA_20 = 140;
		ind.data.indicators.SMA_50 = 150;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5, 20, 50]);

		assertOk(res);
		expect(res.data.summary!.position).toBe('between');
	});

	it('SMA の slope が rising/falling/flat を正しく判定するべき', async () => {
		const len = 40;
		const ind = buildIndicatorsOk();
		// rising series: 100 → 110 (>0.2% per bar over last 6)
		ind.data.chart.indicators.SMA_5 = makeSeries(100, 2, len);
		// falling series: 200 → 188
		ind.data.chart.indicators.SMA_20 = makeSeries(200, -2, len);
		// flat series: all 100
		ind.data.chart.indicators.SMA_50 = Array.from({ length: len }, () => 100);
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5, 20, 50]);

		assertOk(res);
		expect(res.data.smas!['5'].slope).toBe('rising');
		expect(res.data.smas!['20'].slope).toBe('falling');
		expect(res.data.smas!['50'].slope).toBe('flat');
	});

	it('チャートインジケータが短すぎる場合 slope は flat になるべき', async () => {
		const ind = buildIndicatorsOk();
		// Only 3 data points (< 6 required)
		ind.data.chart.indicators.SMA_5 = [100, 101, 102];
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5, 20, 50]);

		assertOk(res);
		expect(res.data.smas!['5'].slope).toBe('flat');
	});

	it('無効なペアは failFromValidation を返す', async () => {
		const res = await analyzeSmaSnapshot('invalid_xxx', '1day', 220, [25, 75, 200]);
		expect(res.ok).toBe(false);
	});

	it('type が 1day 以外の場合 slopePctPerDay は含まれないべき', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildIndicatorsOk()));

		const res = await analyzeSmaSnapshot('btc_jpy', '1hour', 220, [5, 20, 50]);

		assertOk(res);
		expect(res.data.smas!['5'].slopePctPerDay).toBeUndefined();
	});

	it('最近のクロスを検出するべき', async () => {
		const len = 40;
		const ind = buildIndicatorsOk();
		// Create a golden cross: SMA_5 goes from below SMA_20 to above
		const sma5 = Array.from({ length: len }, (_, i) => (i < len - 5 ? 100 : 130));
		const sma20 = Array.from({ length: len }, () => 115);
		ind.data.chart.indicators.SMA_5 = sma5;
		ind.data.chart.indicators.SMA_20 = sma20;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5, 20]);

		assertOk(res);
		expect(res.data.recentCrosses!.length).toBeGreaterThan(0);
		expect(res.data.recentCrosses![0].type).toBe('golden_cross');
	});

	it('pricePosition が below を返すケース', async () => {
		const ind = buildIndicatorsOk();
		// close=140, SMA_5=150 → below
		ind.data.indicators.SMA_5 = 150;
		ind.data.indicators.SMA_20 = 160;
		ind.data.indicators.SMA_50 = 170;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5, 20, 50]);

		assertOk(res);
		// pricePosition is optional in the schema, check via summary.position
		expect(res.data.summary!.position).toBe('below_all');
	});

	it('SMA値が null の場合 distancePct/distanceAbs も null になるべき', async () => {
		const ind = buildIndicatorsOk();
		ind.data.indicators.SMA_5 = null as unknown as number;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5, 20, 50]);

		assertOk(res);
		expect(res.data.smas!['5'].distancePct).toBeNull();
		expect(res.data.smas!['5'].distanceAbs).toBeNull();
	});

	it('chart.candles がない場合は normalized をフォールバックとして使うべき', async () => {
		const ind = buildIndicatorsOk();
		// Remove chart.candles, keep normalized
		(ind.data.chart as Record<string, unknown>).candles = undefined;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5, 20, 50]);

		assertOk(res);
		expect(res.data.latest.close).toBe(140);
	});

	it('SMA値に null が含まれる場合クロス判定をスキップするべき', async () => {
		const ind = buildIndicatorsOk();
		ind.data.indicators.SMA_5 = 130;
		ind.data.indicators.SMA_20 = null as unknown as number;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5, 20]);

		assertOk(res);
		// null pair should be excluded from crosses
		expect(res.data.crosses.length).toBe(0);
	});

	// ── 上流 warning の伝播（取得層 meta.warning / 計算層 meta.warnings） ──────

	it('上流 meta.warning（取得層）が tool の meta.warning と summary 先頭に伝播する', async () => {
		const ind = buildIndicatorsOk();
		ind.meta = {
			...ind.meta,
			warning: '⚠️ partial fetch (3日中1日の取得に失敗)',
		} as typeof ind.meta;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5, 20, 50]);

		assertOk(res);
		expect(res.meta.warning).toBe('⚠️ partial fetch (3日中1日の取得に失敗)');
		expect(res.meta.warnings).toBeUndefined();
		expect(res.summary.split('\n')[0]).toContain('⚠️ partial fetch');
	});

	it('上流 meta.warnings（計算層）が tool の meta.warnings に継承される', async () => {
		const ind = buildIndicatorsOk();
		ind.meta = {
			...ind.meta,
			warnings: ['SMA_200: データ不足', 'Ichimoku: データ不足'],
		} as typeof ind.meta;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5, 20, 50]);

		assertOk(res);
		expect(res.meta.warnings).toEqual(['SMA_200: データ不足', 'Ichimoku: データ不足']);
		expect(res.meta.warning).toBeUndefined();
		// 計算層 warnings は summary 先頭に並ぶ
		expect(res.summary).toContain('⚠️ SMA_200: データ不足');
		expect(res.summary).toContain('⚠️ Ichimoku: データ不足');
	});

	it('上流の取得層 warning と計算層 warnings は別フィールドで保持される（混入 NG）', async () => {
		const ind = buildIndicatorsOk();
		ind.meta = {
			...ind.meta,
			warning: '⚠️ partial fetch (multi-year)',
			warnings: ['SMA_200: データ不足'],
		} as typeof ind.meta;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5, 20, 50]);

		assertOk(res);
		// 取得層 warning は meta.warning
		expect(res.meta.warning).toBe('⚠️ partial fetch (multi-year)');
		// 計算層 warnings は meta.warnings に（取得層メッセージが混入していない）
		expect(res.meta.warnings).toEqual(['SMA_200: データ不足']);
		expect(res.meta.warnings).not.toContain('partial fetch (multi-year)');
		// summary 先頭の 2 行に取得層 warning と計算層 warnings がそれぞれ出る
		const lines = res.summary.split('\n');
		expect(lines[0]).toContain('⚠️ partial fetch (multi-year)');
		expect(lines[1]).toContain('⚠️ SMA_200: データ不足');
	});

	it('上流 warning なしなら meta.warning / meta.warnings は付与されない', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildIndicatorsOk()));

		const res = await analyzeSmaSnapshot('btc_jpy', '1day', 220, [5, 20, 50]);

		assertOk(res);
		expect(res.meta.warning).toBeUndefined();
		expect(res.meta.warnings).toBeUndefined();
		expect(res.summary.startsWith('⚠️')).toBe(false);
	});
});
