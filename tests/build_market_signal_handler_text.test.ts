import { describe, expect, it } from 'vitest';
import {
	type BuildMarketSignalHandlerTextInput,
	buildMarketSignalHandlerText,
} from '../src/handlers/analyzeMarketSignalHandler.js';
import { requireDefined } from './helpers/assert.js';

function makeInput(overrides?: Partial<BuildMarketSignalHandlerTextInput>): BuildMarketSignalHandlerTextInput {
	return {
		pair: 'btc_jpy',
		type: '1day',
		score: 0.35,
		recommendation: 'bullish',
		confidence: 'high',
		confidenceReason: '主要3要素が同方向で一致',
		scoreRange: null,
		topContributors: ['smaTrend', 'momentum'],
		sma: {
			current: 5_000_000,
			values: { sma25: 4_900_000, sma75: 4_800_000, sma200: 4_500_000 },
			deviations: { vs25: 2.04, vs75: 4.17, vs200: 11.11 },
			arrangement: 'bullish',
			recentCross: null,
		},
		supplementary: { rsi: 55, ichimokuSpanA: 4_700_000, ichimokuSpanB: 4_600_000, macdHist: 12000 },
		breakdownArray: [],
		contributions: {
			buyPressure: 0.008,
			cvdTrend: 0.06,
			momentum: 0.12,
			volatility: 0.01,
			smaTrend: 0.28,
		},
		weights: {
			buyPressure: 0.05,
			cvdTrend: 0.2,
			momentum: 0.3,
			volatility: 0.1,
			smaTrend: 0.35,
		},
		nextActions: [],
		...overrides,
	};
}

describe('buildMarketSignalHandlerText', () => {
	it('基本: ペア名・スコア・判定を含む', () => {
		const text = buildMarketSignalHandlerText(makeInput());
		expect(text).toContain('BTC_JPY [1day]');
		expect(text).toContain('総合スコア: 35');
		expect(text).toContain('bullish');
		expect(text).toContain('信頼度: high');
	});

	it('デフォルトの範囲と中立域を表示', () => {
		const text = buildMarketSignalHandlerText(makeInput());
		expect(text).toContain('範囲: -100〜+100');
		expect(text).toContain('中立域: -10〜+10');
	});

	it('カスタム scoreRange を使用', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				scoreRange: { displayMin: -50, displayMax: 50, neutralBandDisplay: { min: -5, max: 5 } },
			}),
		);
		expect(text).toContain('範囲: -50〜50');
		expect(text).toContain('中立域: -5〜5');
	});

	it('confidenceReason ありの場合', () => {
		const text = buildMarketSignalHandlerText(makeInput({ confidenceReason: 'テスト理由' }));
		expect(text).toContain(': テスト理由');
	});

	it('confidenceReason 空の場合', () => {
		const text = buildMarketSignalHandlerText(makeInput({ confidenceReason: '' }));
		expect(text).not.toContain(': )');
	});

	it('topContributors を表示', () => {
		const text = buildMarketSignalHandlerText(makeInput());
		expect(text).toContain('主要因: smaTrend, momentum');
	});

	it('topContributors 空の場合は主要因行なし', () => {
		const text = buildMarketSignalHandlerText(makeInput({ topContributors: [] }));
		expect(text).not.toContain('主要因:');
	});

	it('SMA詳細: 3本の移動平均を表示', () => {
		const text = buildMarketSignalHandlerText(makeInput());
		expect(text).toContain('【SMA（移動平均線）詳細】');
		expect(text).toContain('現在価格: 5,000,000円');
		expect(text).toContain('短期（25日）');
		expect(text).toContain('中期（75日）');
		expect(text).toContain('長期（200日）');
	});

	it('SMA配置: bullish → 上昇トレンド構造', () => {
		const text = buildMarketSignalHandlerText(makeInput());
		expect(text).toContain('上昇順');
		expect(text).toContain('上昇トレンド構造');
	});

	it('SMA配置: bearish → 下落トレンド構造', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				sma: {
					...requireDefined(makeInput().sma, 'makeInput().sma'),
					arrangement: 'bearish',
					current: 4_400_000,
					values: { sma25: 4_500_000, sma75: 4_600_000, sma200: 4_700_000 },
				},
			}),
		);
		expect(text).toContain('下降順');
		expect(text).toContain('下落トレンド構造');
	});

	it('SMA配置: mixed → 方向感が弱い', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				sma: { ...requireDefined(makeInput().sma, 'makeInput().sma'), arrangement: 'mixed' },
			}),
		);
		expect(text).toContain('混在');
		expect(text).toContain('方向感が弱い');
	});

	it('SMA null の場合はSMAセクションなし', () => {
		const text = buildMarketSignalHandlerText(makeInput({ sma: null }));
		expect(text).not.toContain('【SMA（移動平均線）詳細】');
	});

	it('SMA詳細: 現在価格が null なら現在価格の行を出さず、null / NaN の移動平均は n/a', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				sma: {
					current: null,
					values: { sma25: 4_900_000, sma75: null, sma200: Number.NaN },
					deviations: { vs25: null, vs75: null, vs200: null },
					arrangement: 'mixed',
					recentCross: null,
				},
			}),
		);
		expect(text).toContain('【SMA（移動平均線）詳細】');
		expect(text).not.toContain('現在価格:');
		expect(text).toContain('- 短期（25日）: 4,900,000円');
		expect(text).toContain('- 中期（75日）: n/a円');
		expect(text).toContain('- 長期（200日）: n/a円');
	});

	it('SMA詳細: 現在価格が NaN でも現在価格の行を出さず、短期の移動平均が null なら n/a', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				sma: {
					current: Number.NaN,
					values: { sma25: null, sma75: 4_800_000, sma200: 4_500_000 },
					deviations: { vs25: null, vs75: null, vs200: null },
					arrangement: 'bullish',
					recentCross: null,
				},
			}),
		);
		expect(text).toContain('【SMA（移動平均線）詳細】');
		expect(text).not.toContain('現在価格:');
		expect(text).toContain('- 短期（25日）: n/a円');
		expect(text).toContain('- 長期（200日）: 4,500,000円');
	});

	it('SMA deviations を表示', () => {
		const text = buildMarketSignalHandlerText(makeInput());
		expect(text).toContain('+2.04%');
		expect(text).toContain('+4.17%');
		expect(text).toContain('+11.11%');
	});

	it('SMA deviations 負の値', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				sma: {
					...requireDefined(makeInput().sma, 'makeInput().sma'),
					deviations: { vs25: -1.5, vs75: -3.0, vs200: -8.0 },
				},
			}),
		);
		expect(text).toContain('-1.50%');
		expect(text).toContain('下');
	});

	it('ゴールデンクロスを表示', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				sma: {
					...requireDefined(makeInput().sma, 'makeInput().sma'),
					recentCross: { type: 'golden_cross', pair: '25/75', barsAgo: 5 },
				},
			}),
		);
		expect(text).toContain('直近クロス: 5日前');
		expect(text).toContain('上抜け');
		expect(text).toContain('ゴールデンクロス');
	});

	it('デッドクロスを表示', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				sma: {
					...requireDefined(makeInput().sma, 'makeInput().sma'),
					recentCross: { type: 'death_cross', pair: '25/75', barsAgo: 2 },
				},
			}),
		);
		expect(text).toContain('デッドクロス');
		expect(text).toContain('下抜け');
	});

	it('クロス pair が 25/75 以外の場合は表示しない', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				sma: {
					...requireDefined(makeInput().sma, 'makeInput().sma'),
					recentCross: { type: 'golden_cross', pair: '50/100', barsAgo: 3 },
				},
			}),
		);
		expect(text).not.toContain('直近クロス:');
	});

	it('4hour 足の場合は単位が「本前」', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				type: '4hour',
				sma: {
					...requireDefined(makeInput().sma, 'makeInput().sma'),
					recentCross: { type: 'golden_cross', pair: '25/75', barsAgo: 10 },
				},
			}),
		);
		expect(text).toContain('10本前');
	});

	it('補足指標: RSI を表示', () => {
		const text = buildMarketSignalHandlerText(makeInput());
		expect(text).toContain('【補足指標】');
		expect(text).toContain('RSI(14): 55.00');
		expect(text).toContain('中立圏');
	});

	it('RSI < 30 → 売られすぎ', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				supplementary: { ...makeInput().supplementary, rsi: 25 },
			}),
		);
		expect(text).toContain('売られすぎ');
	});

	it('RSI > 70 → 買われすぎ', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				supplementary: { ...makeInput().supplementary, rsi: 75 },
			}),
		);
		expect(text).toContain('買われすぎ');
	});

	it('一目均衡表: 雲の上', () => {
		const text = buildMarketSignalHandlerText(makeInput());
		// current=5M, spanA=4.7M, spanB=4.6M → above cloud
		expect(text).toContain('一目均衡表: 雲の上');
	});

	it('一目均衡表: 雲の下', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				sma: { ...requireDefined(makeInput().sma, 'makeInput().sma'), current: 4_500_000 },
				supplementary: { rsi: 55, ichimokuSpanA: 4_700_000, ichimokuSpanB: 4_600_000, macdHist: null },
			}),
		);
		expect(text).toContain('雲の下');
	});

	it('一目均衡表: 雲の中', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				sma: { ...requireDefined(makeInput().sma, 'makeInput().sma'), current: 4_650_000 },
				supplementary: { rsi: null, ichimokuSpanA: 4_700_000, ichimokuSpanB: 4_600_000, macdHist: null },
			}),
		);
		expect(text).toContain('雲の中');
		expect(text).toContain('距離 0%');
	});

	it('MACD: 強気', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				supplementary: { rsi: null, ichimokuSpanA: null, ichimokuSpanB: null, macdHist: 5000 },
			}),
		);
		expect(text).toContain('MACD: ヒストグラム');
		expect(text).toContain('強気');
	});

	it('MACD: 弱気', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				supplementary: { rsi: null, ichimokuSpanA: null, ichimokuSpanB: null, macdHist: -3000 },
			}),
		);
		expect(text).toContain('弱気');
	});

	it('補足指標: すべて null なら補足指標セクションなし', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				supplementary: { rsi: null, ichimokuSpanA: null, ichimokuSpanB: null, macdHist: null },
			}),
		);
		expect(text).not.toContain('【補足指標】');
	});

	it('breakdownArray ありの場合: raw×weight=寄与 形式', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				breakdownArray: [
					{ factor: 'smaTrend', weight: 0.35, rawScore: 0.8, contribution: 0.28, interpretation: 'strong' },
				],
			}),
		);
		expect(text).toContain('【内訳（raw×weight=寄与）】');
		expect(text).toContain('smaTrend: 0.80×35%=0.28 （strong）');
	});

	it('breakdownArray 空 + contributions あり → contribution 形式', () => {
		const text = buildMarketSignalHandlerText(makeInput());
		expect(text).toContain('【内訳（contribution）】');
		expect(text).toContain('smaTrend: 0.28');
		expect(text).toContain('weight 35%');
	});

	it('breakdownArray 空 + contributions null → 内訳セクションなし', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				breakdownArray: [],
				contributions: null,
				weights: null,
			}),
		);
		expect(text).not.toContain('【内訳');
	});

	it('nextActions ありの場合', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				nextActions: [
					{ priority: 'high', tool: 'get_flow_metrics', reason: 'CVD確認' },
					{ priority: 'medium', tool: 'get_orderbook', reason: '板確認' },
					{ priority: 'low', tool: 'detect_patterns', reason: 'パターン確認' },
				],
			}),
		);
		expect(text).toContain('【次の確認候補】');
		expect(text).toContain('(高) get_flow_metrics - CVD確認');
		expect(text).toContain('(中) get_orderbook - 板確認');
		expect(text).toContain('(低) detect_patterns - パターン確認');
	});

	it('nextActions 空 → 次の確認候補セクションなし', () => {
		const text = buildMarketSignalHandlerText(makeInput({ nextActions: [] }));
		expect(text).not.toContain('【次の確認候補】');
	});

	it('nextActions は最大3件まで', () => {
		const text = buildMarketSignalHandlerText(
			makeInput({
				nextActions: [
					{ priority: 'high', tool: 'tool1', reason: 'r1' },
					{ priority: 'high', tool: 'tool2', reason: 'r2' },
					{ priority: 'medium', tool: 'tool3', reason: 'r3' },
					{ priority: 'low', tool: 'tool4', reason: 'r4' },
				],
			}),
		);
		expect(text).toContain('tool3');
		expect(text).not.toContain('tool4');
	});

	it('純粋関数: 同じ入力で同じ出力', () => {
		const input = makeInput();
		expect(buildMarketSignalHandlerText(input)).toBe(buildMarketSignalHandlerText(input));
	});
});
