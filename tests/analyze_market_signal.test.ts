import { afterEach, describe, expect, it, vi } from 'vitest';
import { ICHIMOKU_SHIFT } from '../lib/indicator-config.js';
import { asMockResult, assertOk } from './_assertResult.js';

vi.mock('../tools/get_flow_metrics.js', () => ({
	default: vi.fn(),
}));

vi.mock('../tools/get_volatility_metrics.js', () => ({
	default: vi.fn(),
}));

vi.mock('../tools/analyze_indicators.js', () => ({
	default: vi.fn(),
}));

import { toolDef } from '../src/handlers/analyzeMarketSignalHandler.js';
import analyzeIndicators from '../tools/analyze_indicators.js';
import analyzeMarketSignal from '../tools/analyze_market_signal.js';
import getFlowMetrics from '../tools/get_flow_metrics.js';
import getVolatilityMetrics from '../tools/get_volatility_metrics.js';

function flowOk(aggressorRatio: number, cvdValues: number[], meta: Record<string, unknown> = {}) {
	return {
		ok: true,
		summary: 'ok',
		data: {
			aggregates: { aggressorRatio },
			series: {
				buckets: cvdValues.map((cvd) => ({ cvd })),
			},
		},
		meta,
	};
}

function volOk(rvStdAnn: number, meta: Record<string, unknown> = {}) {
	return {
		ok: true,
		summary: 'ok',
		data: {
			aggregates: { rv_std_ann: rvStdAnn },
		},
		meta,
	};
}

function makeCloses(count: number, close: number) {
	return Array.from({ length: count }, (_, idx) => ({
		close,
		isoTime: `2024-01-${String((idx % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
	}));
}

function indicatorsOk(params: {
	close: number;
	rsi: number | null;
	sma25: number | null;
	sma75: number | null;
	sma200: number | null;
	normalizedCount?: number;
	trend?:
		| 'strong_uptrend'
		| 'uptrend'
		| 'strong_downtrend'
		| 'downtrend'
		| 'overbought'
		| 'oversold'
		| 'sideways'
		| 'insufficient_data';
	meta?: Record<string, unknown>;
}) {
	const { close, rsi, sma25, sma75, sma200, normalizedCount = 220, trend = 'sideways', meta = {} } = params;
	return {
		ok: true,
		summary: 'ok',
		data: {
			indicators: {
				RSI_14: rsi,
				SMA_25: sma25,
				SMA_75: sma75,
				SMA_200: sma200,
			},
			normalized: makeCloses(normalizedCount, close),
			trend,
		},
		meta,
	};
}

describe('analyze_market_signal', () => {
	const mockedGetFlowMetrics = vi.mocked(getFlowMetrics);
	const mockedGetVolatilityMetrics = vi.mocked(getVolatilityMetrics);
	const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('inputSchema: flowLimit は整数のみ許可する', () => {
		const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', flowLimit: 10.5 });
		expect(parse).toThrow();
	});

	it('中立シグナル時の nextActions は存在しない detect_forming_chart_patterns ではなく detect_patterns を案内すべき', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.5)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 100, rsi: 50, sma25: 100, sma75: 100, sma200: 100 })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.nextActions.map((action) => action.tool)).toContain('detect_patterns');
	});

	it('主要要素が矛盾する低信頼ケースで nextActions に未登録の multiple_analysis を含めるべきではない', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.5, [0, 5, 10, 20, 30, 40, 50, 60, 80, 100])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 120, rsi: 0, sma25: 110, sma75: 100, sma200: 100 })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.confidence).toBe('low');
		expect(res.data.nextActions.map((action) => action.tool)).not.toContain('multiple_analysis');
	});

	it('強い弱気シグナル: CVD下降 + RSI低 + SMA下降配列 → bearish recommendation', async () => {
		// CVD が下降トレンド
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.2, [100, 80, 60, 40, 20, 10, 5, 0, -5, -10])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.8)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				indicatorsOk({
					close: 80,
					rsi: 20,
					sma25: 90,
					sma75: 100,
					sma200: 110,
					trend: 'strong_downtrend',
				}),
			),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.recommendation).toBe('bearish');
		expect(res.data.score).toBeLessThan(0);
	});

	it('強い強気シグナル: CVD上昇 + RSI高 + SMA上昇配列 → bullish recommendation', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.8, [0, 10, 20, 40, 60, 80, 100, 120, 140, 160])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.3)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				indicatorsOk({
					close: 120,
					rsi: 65,
					sma25: 115,
					sma75: 110,
					sma200: 100,
					trend: 'strong_uptrend',
				}),
			),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.recommendation).toBe('bullish');
		expect(res.data.score).toBeGreaterThan(0);
	});

	it('overbought: RSI > 70 で買われすぎリスク', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.6, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.4)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 130, rsi: 75, sma25: 125, sma75: 120, sma200: 110, trend: 'uptrend' })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.metrics.rsi).toBe(75);
	});

	it('oversold: RSI < 30 で売られすぎ', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.3, [50, 40, 30, 20, 10, 5, 0, -5, -10, -15])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.6)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 85, rsi: 25, sma25: 95, sma75: 105, sma200: 115, trend: 'downtrend' })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.metrics.rsi).toBe(25);
	});

	it('rv_std_ann > 1.0 のボラティリティ値が metrics に伝播する', async () => {
		// 注: 高ボラそのものは confidence を直接降格させない。confidence の降格は
		// (1) 上流 meta.warning ありで high → medium、(2) 主要要素 null で low 固定、の 2 系統のみ。
		// このテストは rv_std_ann が data.metrics にそのまま流れることを検証する。
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(1.5)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 100, rsi: 50, sma25: 100, sma75: 100, sma200: 100 })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.metrics.rv_std_ann).toBe(1.5);
	});

	it('SMA 整列: price > sma25 > sma75 > sma200 で aligned_up', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.6, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.3)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 130, rsi: 60, sma25: 120, sma75: 110, sma200: 100, trend: 'uptrend' })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.sma!.arrangement).toBe('bullish');
	});

	it('SMA 整列: price < sma25 < sma75 < sma200 で aligned_down', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.3, [50, 40, 30, 20, 10, 5, 0, -5, -10, -15])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.5)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 80, rsi: 35, sma25: 90, sma75: 100, sma200: 110, trend: 'strong_downtrend' })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.sma!.arrangement).toBe('bearish');
	});

	it('25/75 直近クロス: 時間軸を揃えた全長 SMA 系列で golden_cross を検出する（slidingMean ズレ修正の回帰）', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.5)));
		// 60 本下落 → 60 本上昇の V 字。下落局面で sma25<sma75、上昇局面で sma25>sma75 となり、
		// 直近クロスは上昇局面の golden。旧実装は長さの違う slidingMean 配列を同一 index で
		// 比較して 50 本ズレていたため、ここは時間軸の揃った全長系列での検出を固定する。
		const down = Array.from({ length: 60 }, (_, i) => 200 - i * 2);
		const up = Array.from({ length: 60 }, (_, i) => 82 + (i + 1) * 3);
		const closeSeries = [...down, ...up];
		const indRes = indicatorsOk({
			close: closeSeries[closeSeries.length - 1],
			rsi: 55,
			sma25: 100,
			sma75: 100,
			sma200: 100,
		});
		indRes.data.normalized = closeSeries.map((close, i) => ({
			close,
			isoTime: `2024-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
		}));
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indRes));

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		const recentCross = res.data.sma?.recentCross ?? null;
		expect(recentCross).not.toBeNull();
		expect(recentCross?.type).toBe('golden_cross');
		expect(recentCross?.pair).toBe('25/75');
		expect(recentCross?.barsAgo).toBeGreaterThanOrEqual(0);
		expect(recentCross?.barsAgo).toBeLessThan(closeSeries.length);
	});

	it('toolDef.handler: content テキストに分析結果が含まれる', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.5)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 100, rsi: 50, sma25: 100, sma75: 100, sma200: 100 })),
		);

		const res = (await toolDef.handler({ pair: 'btc_jpy' })) as { content: Array<{ text: string }> };
		expect(res.content).toBeDefined();
		expect(res.content[0].text).toContain('BTC_JPY');
	});

	// ── 「今日の雲」判定のバグ修正（spanA[len-ICHIMOKU_SHIFT] を使うこと）──

	it('toolDef.handler: 雲判定は ichi_series.spanA/B の末尾 ICHIMOKU_SHIFT 本前を使う（ICHIMOKU_spanA/B とズレているケース）', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.5)));
		const length = ICHIMOKU_SHIFT + 4;
		// - ICHIMOKU_spanA/B（末尾＝ICHIMOKU_SHIFT 本後）: 80/70 → これを使うと close=100 が above_cloud（バグ）
		// - 今日の雲（spanA/B[len-ICHIMOKU_SHIFT]）: 130/120 → 正しくは below_cloud
		const ichiSeries = {
			tenkan: Array.from({ length }, () => 130),
			kijun: Array.from({ length }, () => 120),
			spanA: Array.from({ length }, (_, i) => (i === length - 1 ? 80 : 130)),
			spanB: Array.from({ length }, (_, i) => (i === length - 1 ? 70 : 120)),
			chikou: Array.from({ length }, () => 130),
		};
		const indRes = indicatorsOk({ close: 100, rsi: 55, sma25: 100, sma75: 100, sma200: 100 });
		(indRes.data.indicators as Record<string, unknown>).ICHIMOKU_spanA = 80;
		(indRes.data.indicators as Record<string, unknown>).ICHIMOKU_spanB = 70;
		(indRes.data.indicators as Record<string, unknown>).ichi_series = ichiSeries;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indRes));

		const res = (await toolDef.handler({ pair: 'btc_jpy' })) as { content: Array<{ text: string }> };
		const text = res.content[0].text;
		// 「今日の雲」は 130/120、close=100 → 雲の下
		expect(text).toContain('一目均衡表: 雲の下');
		expect(text).not.toContain('一目均衡表: 雲の上');
	});

	it('toolDef.handler: ichi_series が ICHIMOKU_SHIFT 本未満なら雲判定は null にフォールバック', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.5)));
		const length = ICHIMOKU_SHIFT - 1;
		const ichiSeries = {
			tenkan: Array.from({ length }, () => 130),
			kijun: Array.from({ length }, () => 120),
			spanA: Array.from({ length }, () => 130),
			spanB: Array.from({ length }, () => 120),
			chikou: Array.from({ length }, () => 130),
		};
		const indRes = indicatorsOk({ close: 100, rsi: 55, sma25: 100, sma75: 100, sma200: 100 });
		// 末尾の scalar 値は存在するが、判定には使わない
		(indRes.data.indicators as Record<string, unknown>).ICHIMOKU_spanA = 80;
		(indRes.data.indicators as Record<string, unknown>).ICHIMOKU_spanB = 70;
		(indRes.data.indicators as Record<string, unknown>).ichi_series = ichiSeries;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indRes));

		const res = (await toolDef.handler({ pair: 'btc_jpy' })) as { content: Array<{ text: string }> };
		const text = res.content[0].text;
		// 「今日の雲」が取れないので一目均衡表セクションは出ない
		expect(text).not.toContain('一目均衡表: 雲の上');
		expect(text).not.toContain('一目均衡表: 雲の下');
		expect(text).not.toContain('一目均衡表: 雲の中');
	});

	it('aggressorRatio が最大で板圧力が極端なときは get_orderbook を深掘り候補に含めるべき', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(1, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.5)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 100, rsi: 50, sma25: 100, sma75: 100, sma200: 100 })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.metrics.buyPressure).toBe(1);
		expect(res.data.nextActions.map((action) => action.tool)).toContain('get_orderbook');
	});

	// ── 上流 warning の集約と伝播（§9.2 / §9.3） ────────────────────────────────

	it('get_flow_metrics の meta.warning が tool の meta.warning と content 先頭に伝播する', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(
			asMockResult(flowOk(0.5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], { warning: '⚠️ flow データ部分欠損' })),
		);
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.5)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 100, rsi: 50, sma25: 100, sma75: 100, sma200: 100 })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.meta.warning).toContain('[flow]');
		expect(res.meta.warning).toContain('flow データ部分欠損');
		expect(res.summary.split('\n')[0]).toMatch(/^⚠️/);
		expect(res.summary).toContain('[flow]');
	});

	it('get_volatility_metrics の meta.warning が tool の meta.warning と content 先頭に伝播する', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(
			asMockResult(volOk(0.5, { warning: '⚠️ volatility 不正OHLCをスキップ' })),
		);
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 100, rsi: 50, sma25: 100, sma75: 100, sma200: 100 })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.meta.warning).toContain('[volatility]');
		expect(res.meta.warning).toContain('volatility 不正OHLCをスキップ');
		expect(res.summary).toContain('[volatility]');
		expect(res.summary.split('\n')[0]).toMatch(/^⚠️/);
	});

	it('analyze_indicators の meta.warning（取得層）と meta.warnings（計算層）は別系統で伝播する（混在 NG）', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.5)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				indicatorsOk({
					close: 100,
					rsi: 50,
					sma25: 100,
					sma75: 100,
					sma200: 100,
					meta: {
						warning: '⚠️ indicators 取得層警告',
						warnings: ['SMA_200: データ不足', 'Ichimoku: データ不足'],
					},
				}),
			),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		// 取得層 warning は meta.warning に
		expect(res.meta.warning).toContain('[indicators]');
		expect(res.meta.warning).toContain('indicators 取得層警告');
		// 計算層 warnings は meta.warnings に（取得層メッセージが混入していない）
		expect(res.meta.warnings).toEqual(['SMA_200: データ不足', 'Ichimoku: データ不足']);
		expect(res.meta.warnings).not.toContain('indicators 取得層警告');
		// content 先頭に取得層 warning と計算層 warnings が両方並ぶ
		expect(res.summary).toContain('[indicators] indicators 取得層警告');
		expect(res.summary).toContain('⚠️ SMA_200: データ不足');
		expect(res.summary).toContain('⚠️ Ichimoku: データ不足');
	});

	// ── confidence のデータ品質連動降格（§9.4） ─────────────────────────────────

	it('取得層 warning がある状態では 寄与符号一致でも confidence が high にならず medium に降格する', async () => {
		// 主要3要素（smaTrend / momentum / cvdTrend）が全て正方向で一致する強気シグナルを用意。
		// 上流 warning なしなら high になる構成だが、warning ありで medium に降格する。
		mockedGetFlowMetrics.mockResolvedValueOnce(
			asMockResult(flowOk(0.8, [0, 10, 20, 40, 60, 80, 100, 120, 140, 160], { warning: '⚠️ flow データ部分欠損' })),
		);
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.3)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				indicatorsOk({
					close: 120,
					rsi: 65,
					sma25: 115,
					sma75: 110,
					sma200: 100,
					trend: 'strong_uptrend',
				}),
			),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.confidence).toBe('medium');
		expect(res.data.confidenceReason).toContain('取得層 warning');
	});

	it('SMA_200 が null のとき confidence は low 固定（寄与符号が一致していても）', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.8, [0, 10, 20, 40, 60, 80, 100, 120, 140, 160])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.3)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				indicatorsOk({
					close: 120,
					rsi: 65,
					sma25: 115,
					sma75: 110,
					sma200: null,
					trend: 'uptrend',
				}),
			),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.confidence).toBe('low');
		expect(res.data.confidenceReason).toContain('SMA_200');
	});

	it('RSI が null のとき confidence は low 固定', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.8, [0, 10, 20, 40, 60, 80, 100, 120, 140, 160])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.3)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				indicatorsOk({
					close: 120,
					rsi: null,
					sma25: 115,
					sma75: 110,
					sma200: 100,
					trend: 'uptrend',
				}),
			),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.confidence).toBe('low');
		expect(res.data.confidenceReason).toContain('RSI_14');
	});

	it('SMA_25 が null のとき confidence は low 固定（smaTrendFactor の入力が欠ける）', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.8, [0, 10, 20, 40, 60, 80, 100, 120, 140, 160])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.3)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				indicatorsOk({
					close: 120,
					rsi: 65,
					sma25: null,
					sma75: 110,
					sma200: 100,
					trend: 'uptrend',
				}),
			),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.confidence).toBe('low');
		expect(res.data.confidenceReason).toContain('SMA_25');
	});

	it('latestClose が null のとき confidence は low 固定（normalized が空）', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.8, [0, 10, 20, 40, 60, 80, 100, 120, 140, 160])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.3)));
		// normalizedCount=0 → indRes.data.normalized=[] → at(-1)?.close=undefined → latestClose null 扱い
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				indicatorsOk({
					close: 120,
					rsi: 65,
					sma25: 115,
					sma75: 110,
					sma200: 100,
					normalizedCount: 0,
					trend: 'uptrend',
				}),
			),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.confidence).toBe('low');
		expect(res.data.confidenceReason).toContain('latestClose');
	});

	it('上流 warning が全く無い場合は meta.warning / meta.warnings が出ない', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.5)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 100, rsi: 50, sma25: 100, sma75: 100, sma200: 100 })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.meta.warning).toBeUndefined();
		expect(res.meta.warnings).toBeUndefined();
		// content 先頭に ⚠️ が出ない（既存テストの緑維持）
		expect(res.summary.split('\n')[0]).not.toMatch(/^⚠️/);
	});
});
