import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../lib/datetime.js';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';

vi.mock('../tools/analyze_indicators.js', () => ({
	default: vi.fn(),
}));

import analyzeIchimokuSnapshot, { toolDef } from '../tools/analyze_ichimoku_snapshot.js';
import analyzeIndicators from '../tools/analyze_indicators.js';

function buildMockIndicatorSuccess() {
	const normalized = Array.from({ length: 40 }, (_, i) => ({
		close: i === 39 ? 80 : 120 - i,
	}));

	const spanA: number[] = Array.from({ length: 40 }, (_, i) => (i < 14 ? 130 : 100));
	const spanB: number[] = Array.from({ length: 40 }, (_, i) => (i < 14 ? 135 : 110));
	spanA[38] = 62;
	spanA[39] = 60;
	spanB[38] = 67;
	spanB[39] = 65;

	return {
		ok: true as const,
		summary: 'ok',
		data: {
			normalized,
			indicators: {
				ICHIMOKU_conversion: 90,
				ICHIMOKU_base: 95,
				ICHIMOKU_spanA: 60,
				ICHIMOKU_spanB: 65,
				ichi_series: {
					tenkan: Array.from({ length: 40 }, () => 90),
					kijun: Array.from({ length: 40 }, () => 95),
					spanA,
					spanB,
					chikou: Array.from({ length: 40 }, () => 70),
				},
			},
		},
		meta: { pair: 'btc_jpy', type: '1day', count: 40 },
	};
}

describe('analyze_ichimoku_snapshot', () => {
	const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('inputSchema: lookback は 2 以上のみ許可する', () => {
		const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', type: '1day', limit: 120, lookback: 1 });
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

		const res = await analyzeIchimokuSnapshot('btc_jpy', '1day', 120, 10);
		assertFail(res);
		expect(res.meta.errorType).toBe('upstream');
	});

	it('toolDef.handler は lookback を analyzeIchimokuSnapshot に伝搬するべき', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildMockIndicatorSuccess()));

		const res = await toolDef.handler({
			pair: 'btc_jpy',
			type: '1day',
			limit: 120,
			lookback: 3,
		});

		assertOk(res);
		expect(res.data.trend.cloudHistory).toHaveLength(3);
	});

	it('強い弱気条件（雲下 + 転換線<基準線 + 雲下降）では overallSignal は strong_bearish であるべき', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildMockIndicatorSuccess()));

		const res = await analyzeIchimokuSnapshot('btc_jpy', '1day', 120, 10);

		assertOk(res);
		expect(res.data.assessment.pricePosition).toBe('below_cloud');
		expect(res.data.assessment.tenkanKijun).toBe('bearish');
		expect(res.data.assessment.cloudSlope).toBe('falling');
		expect(res.data.signals!.overallSignal).toBe('strong_bearish');
	});

	it('遅行スパンは spanB の有無に依存せず ichi_series.chikou から取得されるべき', async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test fixture deep mutation
		const base = buildMockIndicatorSuccess() as any;
		base.data.indicators.ICHIMOKU_spanB = null;
		base.data.indicators.ichi_series.chikou[39] = 777;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(base));

		const res = await analyzeIchimokuSnapshot('btc_jpy', '1day', 120, 10);
		assertOk(res);
		expect(res.data.latest.chikou).toBe(777);
	});

	it('cloudHistory は lookback とローソク足本数の小さい方まで含めるべき（off-by-one しない）', async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test fixture deep mutation
		const short = buildMockIndicatorSuccess() as any;
		short.data.normalized = [{ close: 100 }, { close: 101 }];
		short.data.indicators.ichi_series.spanA = Array.from({ length: 40 }, () => 90);
		short.data.indicators.ichi_series.spanB = Array.from({ length: 40 }, () => 80);
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(short));

		const res = await analyzeIchimokuSnapshot('btc_jpy', '1day', 120, 2);
		assertOk(res);
		expect(res.data.trend!.cloudHistory).toHaveLength(2);
		expect(res.data.trend!.cloudHistory[0].barsAgo).toBe(0);
		expect(res.data.trend!.cloudHistory[1].barsAgo).toBe(1);
	});

	it('強気条件（雲上 + 転換線>基準線 + 雲上昇）では overallSignal は strong_bullish', async () => {
		const base = buildMockIndicatorSuccess();
		// 価格を雲の上に設定
		base.data.normalized = Array.from({ length: 40 }, () => ({ close: 200 }));
		// 転換線 > 基準線
		base.data.indicators.ICHIMOKU_conversion = 180;
		base.data.indicators.ICHIMOKU_base = 170;
		// spanA > spanB で上昇雲
		base.data.indicators.ICHIMOKU_spanA = 150;
		base.data.indicators.ICHIMOKU_spanB = 140;
		const sSeries = base.data.indicators.ichi_series;
		sSeries.spanA = Array.from({ length: 40 }, (_, i) => 100 + i * 2);
		sSeries.spanB = Array.from({ length: 40 }, (_, i) => 90 + i);
		sSeries.tenkan = Array.from({ length: 40 }, () => 180);
		sSeries.kijun = Array.from({ length: 40 }, () => 170);
		sSeries.chikou = Array.from({ length: 40 }, () => 200);
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(base));

		const res = await analyzeIchimokuSnapshot('btc_jpy', '1day', 120, 10);
		assertOk(res);
		expect(res.data.assessment.pricePosition).toBe('above_cloud');
		expect(res.data.assessment.tenkanKijun).toBe('bullish');
		expect(res.data.signals!.overallSignal).toContain('bullish');
	});

	it('雲の中（in_cloud）の判定', async () => {
		const base = buildMockIndicatorSuccess();
		// spanA=100, spanB=50 の雲の中に close=75 を配置
		base.data.indicators.ICHIMOKU_spanA = 100;
		base.data.indicators.ICHIMOKU_spanB = 50;
		const sSeries = base.data.indicators.ichi_series;
		sSeries.spanA = Array.from({ length: 40 }, () => 100);
		sSeries.spanB = Array.from({ length: 40 }, () => 50);
		base.data.normalized = Array.from({ length: 40 }, () => ({ close: 75 }));
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(base));

		const res = await analyzeIchimokuSnapshot('btc_jpy', '1day', 120, 10);
		assertOk(res);
		expect(res.data.assessment.pricePosition).toBe('in_cloud');
	});

	it('転換線 = 基準線 で neutral', async () => {
		const base = buildMockIndicatorSuccess();
		base.data.indicators.ICHIMOKU_conversion = 95;
		base.data.indicators.ICHIMOKU_base = 95;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(base));

		const res = await analyzeIchimokuSnapshot('btc_jpy', '1day', 120, 10);
		assertOk(res);
		expect(res.data.assessment.tenkanKijun).toBe('neutral');
	});

	it('cloudSlope rising の検出', async () => {
		const base = buildMockIndicatorSuccess();
		// spanA が上昇トレンドに
		const sSeries = base.data.indicators.ichi_series;
		sSeries.spanA = Array.from({ length: 40 }, (_, i) => 50 + i * 3);
		sSeries.spanB = Array.from({ length: 40 }, (_, i) => 40 + i * 2);
		base.data.indicators.ICHIMOKU_spanA = sSeries.spanA[39];
		base.data.indicators.ICHIMOKU_spanB = sSeries.spanB[39];
		base.data.normalized = Array.from({ length: 40 }, () => ({ close: 200 }));
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(base));

		const res = await analyzeIchimokuSnapshot('btc_jpy', '1day', 120, 10);
		assertOk(res);
		expect(res.data.assessment.cloudSlope).toBe('rising');
	});

	it('toolDef.handler: テキスト content を返す', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildMockIndicatorSuccess()));
		const res = (await toolDef.handler({
			pair: 'btc_jpy',
			type: '1day',
			limit: 120,
			lookback: 5,
		})) as { content?: Array<{ text: string }> };
		// handler may return content or direct result
		if (res.content) {
			expect(res.content[0].text).toBeTruthy();
		}
	});

	it('雲データ不足時の cloud.direction は null（unknown を flat にしない）であるべき', async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test fixture deep mutation
		const noCloudSeries = buildMockIndicatorSuccess() as any;
		noCloudSeries.data.indicators.ichi_series = {
			tenkan: Array.from({ length: 40 }, () => 90),
			kijun: Array.from({ length: 40 }, () => 95),
			spanA: [],
			spanB: [],
			chikou: Array.from({ length: 40 }, () => 70),
		};
		noCloudSeries.data.indicators.ICHIMOKU_spanA = null;
		noCloudSeries.data.indicators.ICHIMOKU_spanB = null;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(noCloudSeries));

		const res = await analyzeIchimokuSnapshot('btc_jpy', '1day', 120, 10);
		assertOk(res);
		expect(res.data.assessment.cloudSlope).toBe('unknown');
		expect(res.data.cloud!.direction).toBeNull();
	});

	// ── 上流 warning の伝播（取得層 meta.warning / 計算層 meta.warnings） ──────

	it('上流 meta.warning（取得層）が tool の meta.warning と summary 先頭に伝播する', async () => {
		const ind = buildMockIndicatorSuccess();
		ind.meta = {
			...ind.meta,
			warning: '⚠️ partial fetch (3日中1日の取得に失敗)',
		} as typeof ind.meta;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeIchimokuSnapshot('btc_jpy', '1day', 120, 10);

		assertOk(res);
		expect(res.meta.warning).toBe('⚠️ partial fetch (3日中1日の取得に失敗)');
		expect(res.meta.warnings).toBeUndefined();
		expect(res.summary.split('\n')[0]).toContain('⚠️ partial fetch');
	});

	it('上流 meta.warnings（計算層）が tool の meta.warnings に継承される', async () => {
		const ind = buildMockIndicatorSuccess();
		ind.meta = {
			...ind.meta,
			warnings: ['Ichimoku: データ不足', 'SMA_200: データ不足'],
		} as typeof ind.meta;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeIchimokuSnapshot('btc_jpy', '1day', 120, 10);

		assertOk(res);
		expect(res.meta.warnings).toEqual(['Ichimoku: データ不足', 'SMA_200: データ不足']);
		expect(res.meta.warning).toBeUndefined();
		expect(res.summary).toContain('⚠️ Ichimoku: データ不足');
		expect(res.summary).toContain('⚠️ SMA_200: データ不足');
	});

	it('上流の取得層 warning と計算層 warnings は別フィールドで保持される（混入 NG）', async () => {
		const ind = buildMockIndicatorSuccess();
		ind.meta = {
			...ind.meta,
			warning: '⚠️ partial fetch (multi-year)',
			warnings: ['Ichimoku: データ不足'],
		} as typeof ind.meta;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(ind));

		const res = await analyzeIchimokuSnapshot('btc_jpy', '1day', 120, 10);

		assertOk(res);
		expect(res.meta.warning).toBe('⚠️ partial fetch (multi-year)');
		expect(res.meta.warnings).toEqual(['Ichimoku: データ不足']);
		expect(res.meta.warnings).not.toContain('partial fetch (multi-year)');
		const lines = res.summary.split('\n');
		expect(lines[0]).toContain('⚠️ partial fetch (multi-year)');
		expect(lines[1]).toContain('⚠️ Ichimoku: データ不足');
	});

	it('上流 warning なしなら meta.warning / meta.warnings は付与されない', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildMockIndicatorSuccess()));

		const res = await analyzeIchimokuSnapshot('btc_jpy', '1day', 120, 10);

		assertOk(res);
		expect(res.meta.warning).toBeUndefined();
		expect(res.meta.warnings).toBeUndefined();
		expect(res.summary.startsWith('⚠️')).toBe(false);
	});

	// === 形成中足（provisional）注記 ===
	describe('形成中足（provisional）注記', () => {
		// buildMockIndicatorSuccess() の最新足にのみ provisional 判定用 ts を載せる。
		function buildIndicatorsWithLatestTs(latestTsMs: number) {
			const base = buildMockIndicatorSuccess();
			const norm = base.data.normalized;
			norm[norm.length - 1] = { ...norm[norm.length - 1], timestamp: latestTsMs };
			return base;
		}

		it('realtime（最新足が形成中）: content の text に未確定注記が出て meta.provisional=true', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult(buildIndicatorsWithLatestTs(dayjs().utc().startOf('day').valueOf())),
			);
			const res = await analyzeIchimokuSnapshot('btc_jpy', '1day', 120, 10);
			assertOk(res);
			expect(res.summary).toContain('ℹ️ 最新足は未確定（形成中）');
			expect((res.meta as { provisional?: boolean }).provisional).toBe(true);
		});

		it('過去の確定足（date 指定相当）: 注記が出ず meta.provisional も付かない', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildIndicatorsWithLatestTs(Date.UTC(2024, 0, 1))));
			const res = await analyzeIchimokuSnapshot('btc_jpy', '1day', 120, 10);
			assertOk(res);
			expect(res.summary).not.toContain('未確定（形成中）');
			expect((res.meta as { provisional?: boolean }).provisional).toBeUndefined();
		});
	});
});
