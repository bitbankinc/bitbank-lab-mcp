import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../tools/analyze_market_signal.js', () => ({
	default: vi.fn(),
}));

import {
	type BuildMarketSignalHandlerTextInput,
	buildMarketSignalHandlerText,
	toolDef,
} from '../../src/handlers/analyzeMarketSignalHandler.js';
import analyzeMarketSignal from '../../tools/analyze_market_signal.js';

const mockedAnalyzeMarketSignal = vi.mocked(analyzeMarketSignal);

afterEach(() => {
	vi.clearAllMocks();
});

// ─── 共通フィクスチャ ─────────────────────────────────────────────────────────

function makeTextInput(overrides: Partial<BuildMarketSignalHandlerTextInput> = {}): BuildMarketSignalHandlerTextInput {
	return {
		pair: 'btc_jpy',
		type: '1day',
		score: 0.5,
		recommendation: 'bullish',
		confidence: 'medium',
		confidenceReason: 'indicators aligned',
		scoreRange: { displayMin: -100, displayMax: 100, neutralBandDisplay: { min: -10, max: 10 } },
		topContributors: ['sma_trend', 'momentum'],
		sma: {
			current: 10_000_000,
			values: { sma25: 9_500_000, sma75: 9_000_000, sma200: 8_500_000 },
			deviations: { vs25: 5.26, vs75: 11.11, vs200: 17.65 },
			arrangement: 'bullish',
			recentCross: null,
		},
		supplementary: {
			rsi: 62.5,
			ichimokuSpanA: 9_800_000,
			ichimokuSpanB: 9_200_000,
			macdHist: 50_000,
		},
		breakdownArray: [
			{ factor: 'sma_trend', weight: 0.3, rawScore: 0.7, contribution: 0.21, interpretation: 'bullish' },
			{ factor: 'momentum', weight: 0.2, rawScore: 0.6, contribution: 0.12, interpretation: 'bullish' },
		],
		contributions: null,
		weights: null,
		nextActions: [
			{ priority: 'high', tool: 'get_orderbook', reason: '板圧力を確認' },
			{ priority: 'medium', tool: 'detect_patterns', reason: 'パターン確認' },
		],
		...overrides,
	};
}

// ─── buildMarketSignalHandlerText ─────────────────────────────────────────────

describe('buildMarketSignalHandlerText', () => {
	it('ペア名・タイムフレーム・スコア・判定が含まれる', () => {
		const text = buildMarketSignalHandlerText(makeTextInput());
		expect(text).toContain('BTC_JPY');
		expect(text).toContain('[1day]');
		expect(text).toContain('総合スコア: 50');
		expect(text).toContain('bullish');
	});

	it('スコア範囲と信頼度・理由が含まれる', () => {
		const text = buildMarketSignalHandlerText(makeTextInput());
		expect(text).toContain('-100〜100');
		expect(text).toContain('medium');
		expect(text).toContain('indicators aligned');
	});

	it('topContributors が「主要因」として表示される', () => {
		const text = buildMarketSignalHandlerText(makeTextInput());
		expect(text).toContain('主要因: sma_trend, momentum');
	});

	it('topContributors が空のとき主要因行が出ない', () => {
		const text = buildMarketSignalHandlerText(makeTextInput({ topContributors: [] }));
		expect(text).not.toContain('主要因');
	});

	it('SMA詳細ブロックが含まれる', () => {
		const text = buildMarketSignalHandlerText(makeTextInput());
		expect(text).toContain('【SMA（移動平均線）詳細】');
		expect(text).toContain('短期（25日）');
		expect(text).toContain('中期（75日）');
		expect(text).toContain('長期（200日）');
	});

	it('bullish arrangement → 上昇順・上昇トレンド構造と表示される', () => {
		const text = buildMarketSignalHandlerText(makeTextInput());
		expect(text).toContain('上昇順');
		expect(text).toContain('上昇トレンド構造');
	});

	it('bearish arrangement → 下降順・下落トレンド構造と表示される', () => {
		const text = buildMarketSignalHandlerText(
			makeTextInput({
				sma: {
					current: 8_000_000,
					values: { sma25: 9_000_000, sma75: 9_500_000, sma200: 10_000_000 },
					deviations: { vs25: -11.11, vs75: -15.79, vs200: -20.0 },
					arrangement: 'bearish',
					recentCross: null,
				},
			}),
		);
		expect(text).toContain('下降順');
		expect(text).toContain('下落トレンド構造');
	});

	it('golden_cross 直近クロスが表示される', () => {
		const text = buildMarketSignalHandlerText(
			makeTextInput({
				sma: {
					current: 10_000_000,
					values: { sma25: 9_500_000, sma75: 9_000_000, sma200: 8_500_000 },
					deviations: { vs25: 5.26, vs75: 11.11, vs200: 17.65 },
					arrangement: 'bullish',
					recentCross: { type: 'golden_cross', pair: '25/75', barsAgo: 3 },
				},
			}),
		);
		expect(text).toContain('ゴールデンクロス');
		expect(text).toContain('3日前');
	});

	it('dead_cross 直近クロスが表示される', () => {
		const text = buildMarketSignalHandlerText(
			makeTextInput({
				sma: {
					current: 8_000_000,
					values: { sma25: 9_000_000, sma75: 9_500_000, sma200: 10_000_000 },
					deviations: { vs25: -11.11, vs75: -15.79, vs200: -20.0 },
					arrangement: 'bearish',
					recentCross: { type: 'dead_cross', pair: '25/75', barsAgo: 5 },
				},
			}),
		);
		expect(text).toContain('デッドクロス');
		expect(text).toContain('5日前');
	});

	it('sma=null の場合 SMA詳細ブロックが出ない', () => {
		const text = buildMarketSignalHandlerText(makeTextInput({ sma: null }));
		expect(text).not.toContain('【SMA（移動平均線）詳細】');
	});

	it('RSI が補足指標に表示される', () => {
		const text = buildMarketSignalHandlerText(makeTextInput());
		expect(text).toContain('RSI(14)');
		expect(text).toContain('62.50');
		expect(text).toContain('中立圏');
	});

	it('RSI < 30 → 売られすぎと表示される', () => {
		const text = buildMarketSignalHandlerText(
			makeTextInput({ supplementary: { rsi: 25, ichimokuSpanA: null, ichimokuSpanB: null, macdHist: null } }),
		);
		expect(text).toContain('売られすぎ');
	});

	it('RSI > 70 → 買われすぎと表示される', () => {
		const text = buildMarketSignalHandlerText(
			makeTextInput({ supplementary: { rsi: 75, ichimokuSpanA: null, ichimokuSpanB: null, macdHist: null } }),
		);
		expect(text).toContain('買われすぎ');
	});

	it('一目均衡表: 現在価格が雲の上の場合「雲の上」と表示される', () => {
		// spanA=9_800_000, spanB=9_200_000 → cloudTop=9_800_000, current=10_000_000 → 雲の上
		const text = buildMarketSignalHandlerText(makeTextInput());
		expect(text).toContain('雲の上');
	});

	it('一目均衡表: 現在価格が雲の下の場合「雲の下」と表示される', () => {
		const text = buildMarketSignalHandlerText(
			makeTextInput({
				sma: {
					current: 8_500_000,
					values: { sma25: 9_000_000, sma75: 9_500_000, sma200: 10_000_000 },
					deviations: { vs25: -5.56, vs75: -10.53, vs200: -15.0 },
					arrangement: 'bearish',
					recentCross: null,
				},
				supplementary: {
					rsi: 40,
					ichimokuSpanA: 9_800_000,
					ichimokuSpanB: 9_200_000,
					macdHist: -30_000,
				},
			}),
		);
		expect(text).toContain('雲の下');
	});

	it('MACD ヒストグラム正 → 強気と表示される', () => {
		const text = buildMarketSignalHandlerText(makeTextInput());
		expect(text).toContain('MACD');
		expect(text).toContain('強気');
	});

	it('MACD ヒストグラム負 → 弱気と表示される', () => {
		const text = buildMarketSignalHandlerText(
			makeTextInput({ supplementary: { rsi: null, ichimokuSpanA: null, ichimokuSpanB: null, macdHist: -20_000 } }),
		);
		expect(text).toContain('弱気');
	});

	it('内訳（breakdownArray）が表示される', () => {
		const text = buildMarketSignalHandlerText(makeTextInput());
		expect(text).toContain('【内訳（raw×weight=寄与）】');
		expect(text).toContain('sma_trend');
		expect(text).toContain('momentum');
	});

	it('breakdownArray が空かつ contributions がある場合は contributions ブロックが表示される', () => {
		const text = buildMarketSignalHandlerText(
			makeTextInput({
				breakdownArray: [],
				contributions: { sma_trend: 0.21, flow: 0.15 },
				weights: { sma_trend: 0.3, flow: 0.2 },
			}),
		);
		expect(text).toContain('【内訳（contribution）】');
		expect(text).toContain('sma_trend');
	});

	it('nextActions が上位3件まで表示される', () => {
		const text = buildMarketSignalHandlerText(
			makeTextInput({
				nextActions: [
					{ priority: 'high', tool: 'get_orderbook', reason: '確認A' },
					{ priority: 'medium', tool: 'detect_patterns', reason: '確認B' },
					{ priority: 'low', tool: 'analyze_indicators', reason: '確認C' },
					{ priority: 'low', tool: 'get_candles', reason: '確認D' }, // 4件目は出ない
				],
			}),
		);
		expect(text).toContain('【次の確認候補】');
		expect(text).toContain('get_orderbook');
		expect(text).toContain('detect_patterns');
		expect(text).toContain('analyze_indicators');
		expect(text).not.toContain('get_candles');
	});

	it('priority が高/中/低に日本語変換される', () => {
		const text = buildMarketSignalHandlerText(makeTextInput());
		expect(text).toContain('(高)');
		expect(text).toContain('(中)');
	});
});

// ─── handler orchestration ────────────────────────────────────────────────────

describe('toolDef handler', () => {
	function makeBreakdownFactor(_factor: string) {
		return {
			rawValue: 0.3,
			weight: 0.2,
			contribution: 0.06,
			interpretation: 'moderate' as const,
		};
	}

	function makeOkResult(score = 0.3) {
		return {
			ok: true,
			summary: 'BTC_JPY 総合シグナル分析',
			data: {
				score,
				recommendation: 'bullish' as const,
				tags: [],
				confidence: 'medium' as const,
				confidenceReason: 'mixed signals',
				nextActions: [{ priority: 'medium' as const, tool: 'detect_patterns', reason: 'パターン確認' }],
				formula: 'weighted_sum',
				weights: { buyPressure: 0.3, cvdTrend: 0.2, momentum: 0.2, volatility: 0.15, smaTrend: 0.15 },
				contributions: { buyPressure: 0.09, cvdTrend: 0.06, momentum: 0.06, volatility: 0.045, smaTrend: 0.045 },
				breakdown: {
					buyPressure: makeBreakdownFactor('buyPressure'),
					cvdTrend: makeBreakdownFactor('cvdTrend'),
					momentum: makeBreakdownFactor('momentum'),
					volatility: makeBreakdownFactor('volatility'),
					smaTrend: makeBreakdownFactor('smaTrend'),
				},
				topContributors: ['buyPressure' as const],
				thresholds: { bullish: 20, bearish: -20 },
				metrics: {
					buyPressure: 0.3,
					cvdTrend: 0.3,
					momentumFactor: 0.2,
					volatilityFactor: 0.1,
					smaTrendFactor: 0.2,
					rsi: 55,
					rv_std_ann: 0.5,
					aggressorRatio: 0.55,
					cvdSlope: 100,
					horizon: 10,
				},
				sma: {
					current: 10_000_000,
					values: { sma25: 9_500_000, sma75: 9_000_000, sma200: 8_500_000 },
					deviations: { vs25: 5.26, vs75: 11.11, vs200: 17.65 },
					arrangement: 'bullish' as const,
					position: 'above_all' as const,
					recentCross: null,
				},
				refs: {
					flow: { aggregates: {}, lastBuckets: [] },
					volatility: { aggregates: {} },
					indicators: {
						latest: { RSI_14: 55, MACD_hist: 10_000 },
						trend: 'sideways' as const,
					},
				},
			},
			meta: {
				pair: 'btc_jpy',
				type: '1day' as const,
				windows: [7, 14],
				bucketMs: 60000,
				flowLimit: 100,
				fetchedAt: '2025-01-01T00:00:00Z',
			},
		};
	}

	function makeFailResult() {
		return {
			ok: false,
			summary: 'network error',
			data: {},
			meta: {
				errorType: 'NETWORK',
				pair: 'btc_jpy',
				type: '1day',
				windows: [7],
				bucketMs: 60000,
				flowLimit: 100,
				fetchedAt: '2025-01-01T00:00:00Z',
			},
		};
	}

	it('content テキストにペア名が含まれる', async () => {
		mockedAnalyzeMarketSignal.mockResolvedValueOnce(makeOkResult() as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('BTC_JPY');
	});

	it('structuredContent に ok:true が含まれる', async () => {
		mockedAnalyzeMarketSignal.mockResolvedValueOnce(makeOkResult() as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const sc = (res as { structuredContent: Record<string, unknown> }).structuredContent;
		expect(sc.ok).toBe(true);
	});

	it('res.ok=false はそのまま返す（parse して返す）', async () => {
		mockedAnalyzeMarketSignal.mockResolvedValueOnce(makeFailResult() as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		expect((res as { ok: boolean }).ok).toBe(false);
	});

	it('refs.indicators.latest から RSI/MACD が補足指標に渡される', async () => {
		mockedAnalyzeMarketSignal.mockResolvedValueOnce(makeOkResult() as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('RSI(14)');
		expect(text).toContain('MACD');
	});

	// ── 上流 warning の content 先頭への連結（§9.3） ────────────────────────────

	it('meta.warning がある場合 content の先頭行が ⚠️ で始まる', async () => {
		const r = makeOkResult();
		(r.meta as Record<string, unknown>).warning = '[flow] flow データ部分欠損';
		mockedAnalyzeMarketSignal.mockResolvedValueOnce(r as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		const firstLine = text.split('\n')[0];
		expect(firstLine).toMatch(/^⚠️/);
		expect(firstLine).toContain('[flow]');
		expect(firstLine).toContain('flow データ部分欠損');
	});

	it('meta.warnings（複数）が全て content 先頭ブロックに ⚠️ 付きで出る', async () => {
		const r = makeOkResult();
		(r.meta as Record<string, unknown>).warnings = ['SMA_200: データ不足', 'Ichimoku: データ不足'];
		mockedAnalyzeMarketSignal.mockResolvedValueOnce(r as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		const lines = text.split('\n');
		expect(lines[0]).toBe('⚠️ SMA_200: データ不足');
		expect(lines[1]).toBe('⚠️ Ichimoku: データ不足');
	});

	it('meta.warning と meta.warnings が両方ある場合、warning が先・warnings が後の順で並ぶ', async () => {
		const r = makeOkResult();
		(r.meta as Record<string, unknown>).warning = '[indicators] 取得層警告';
		(r.meta as Record<string, unknown>).warnings = ['SMA_200: データ不足'];
		mockedAnalyzeMarketSignal.mockResolvedValueOnce(r as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		const lines = text.split('\n');
		expect(lines[0]).toBe('⚠️ [indicators] 取得層警告');
		expect(lines[1]).toBe('⚠️ SMA_200: データ不足');
	});

	it('warning が無い場合は content 先頭に ⚠️ 行が出ない（既存挙動の維持）', async () => {
		mockedAnalyzeMarketSignal.mockResolvedValueOnce(makeOkResult() as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		const firstLine = text.split('\n')[0];
		expect(firstLine).not.toMatch(/^⚠️/);
		expect(firstLine).toContain('BTC_JPY');
	});
});
