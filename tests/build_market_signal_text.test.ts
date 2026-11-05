import { describe, expect, it } from 'vitest';
import { type BuildMarketSignalTextInput, buildMarketSignalText } from '../tools/analyze_market_signal.js';

function makeInput(overrides?: Partial<BuildMarketSignalTextInput>): BuildMarketSignalTextInput {
	return {
		pair: 'btc_jpy',
		type: '1day',
		score: 0.35,
		recommendation: 'bullish',
		confidence: { level: 'high', reason: '主要3要素が同方向で一致。シグナルの信頼性高' },
		latestClose: 5_000_000,
		sma: { sma25: 4_900_000, sma75: 4_800_000, sma200: 4_500_000 },
		smaArrangement: 'bullish',
		smaPosition: 'above_all',
		smaDeviations: { vs25: 0.0204, vs75: 0.0417, vs200: 0.1111 },
		recentCross: null,
		factors: {
			smaTrendFactor: 0.8,
			momentumFactor: 0.4,
			cvdTrend: 0.3,
			volatilityFactor: 0.1,
			buyPressure: 0.15,
		},
		contributions: { sma: 0.28, mom: 0.12, cvd: 0.06, vol: 0.01, buy: 0.008 },
		rsi: 62,
		rvNum: 0.35,
		buyRatio: 0.55,
		nextActions: [],
		alerts: [],
		...overrides,
	};
}

describe('buildMarketSignalText', () => {
	it('基本: ペア名・スコア・判定を含む', () => {
		const text = buildMarketSignalText(makeInput());
		expect(text).toContain('BTC_JPY [1day]');
		expect(text).toContain('総合スコア: 35');
		expect(text).toContain('bullish');
		expect(text).toContain('信頼度: high');
	});

	it('価格情報セクションを含む', () => {
		const text = buildMarketSignalText(makeInput());
		expect(text).toContain('【価格情報】');
		expect(text).toContain('現在価格:');
		expect(text).toContain('5,000,000円');
	});

	it('SMA詳細セクション: 3本の移動平均を表示', () => {
		const text = buildMarketSignalText(makeInput());
		expect(text).toContain('【SMA詳細】');
		expect(text).toContain('短期（25日平均）');
		expect(text).toContain('中期（75日平均）');
		expect(text).toContain('長期（200日平均）');
		expect(text).toContain('4,900,000円');
		expect(text).toContain('4,800,000円');
		expect(text).toContain('4,500,000円');
	});

	it('bullish 配置: 上昇順と表示', () => {
		const text = buildMarketSignalText(makeInput());
		expect(text).toContain('上昇順');
		expect(text).toContain('現在価格 > 25 > 75 > 200');
		expect(text).toContain('強気');
	});

	it('bearish 配置: 下降順と表示', () => {
		const text = buildMarketSignalText(
			makeInput({
				smaArrangement: 'bearish',
				smaPosition: 'below_all',
			}),
		);
		expect(text).toContain('下降順');
		expect(text).toContain('200 > 75 > 25 > 現在価格');
		expect(text).toContain('弱気');
	});

	it('mixed 配置: 混在と表示', () => {
		const text = buildMarketSignalText(
			makeInput({
				smaArrangement: 'mixed',
				smaPosition: 'mixed',
			}),
		);
		expect(text).toContain('混在');
		expect(text).toContain('一部の平均と交差');
		expect(text).toContain('不明瞭');
	});

	it('above_all 位置ラベル', () => {
		const text = buildMarketSignalText(makeInput({ smaPosition: 'above_all' }));
		expect(text).toContain('位置: 全平均の上');
	});

	it('below_all 位置ラベル', () => {
		const text = buildMarketSignalText(makeInput({ smaPosition: 'below_all' }));
		expect(text).toContain('位置: 全平均の下');
	});

	it('ゴールデンクロスを表示', () => {
		const text = buildMarketSignalText(
			makeInput({
				recentCross: { type: 'golden_cross', pair: '25/75', barsAgo: 3 },
			}),
		);
		expect(text).toContain('直近クロス: 3日前にゴールデンクロス');
		expect(text).toContain('上抜け');
	});

	it('デッドクロスを表示', () => {
		const text = buildMarketSignalText(
			makeInput({
				recentCross: { type: 'death_cross', pair: '25/75', barsAgo: 7 },
			}),
		);
		expect(text).toContain('直近クロス: 7日前にデッドクロス');
		expect(text).toContain('下抜け');
	});

	it('クロスなしの場合はクロス行を出力しない', () => {
		const text = buildMarketSignalText(makeInput({ recentCross: null }));
		expect(text).not.toContain('直近クロス:');
	});

	it('各要素の詳細セクション: 5要素すべて表示', () => {
		const text = buildMarketSignalText(makeInput());
		expect(text).toContain('【各要素の詳細】');
		expect(text).toContain('平均価格の配置（重み35%）');
		expect(text).toContain('勢いの変化（重み30%）');
		expect(text).toContain('出来高の流れ（重み20%）');
		expect(text).toContain('値動きの荒さ（重み10%）');
		expect(text).toContain('板の買い圧力（重み5%）');
	});

	it('RSI が表示される', () => {
		const text = buildMarketSignalText(makeInput({ rsi: 62 }));
		expect(text).toContain('RSI=62');
	});

	it('RSI null の場合は RSI= を出力しない', () => {
		const text = buildMarketSignalText(makeInput({ rsi: null }));
		expect(text).not.toContain('RSI=');
		expect(text).toContain('RSI: n/a');
	});

	it('buyPressure > 0.2 → 買い優勢', () => {
		const text = buildMarketSignalText(makeInput({ factors: { ...makeInput().factors, buyPressure: 0.3 } }));
		expect(text).toContain('買い優勢');
	});

	it('buyPressure やや買い優勢', () => {
		const text = buildMarketSignalText(makeInput({ factors: { ...makeInput().factors, buyPressure: 0.1 } }));
		expect(text).toContain('やや買い優勢');
	});

	it('buyPressure < -0.2 → 売り優勢', () => {
		const text = buildMarketSignalText(makeInput({ factors: { ...makeInput().factors, buyPressure: -0.3 } }));
		expect(text).toContain('売り優勢');
	});

	it('buyPressure 拮抗', () => {
		const text = buildMarketSignalText(makeInput({ factors: { ...makeInput().factors, buyPressure: 0.0 } }));
		expect(text).toContain('拮抗');
	});

	it('momentum up → 上昇中', () => {
		const text = buildMarketSignalText(makeInput({ factors: { ...makeInput().factors, momentumFactor: 0.5 } }));
		expect(text).toMatch(/勢いの変化.*上昇中/);
	});

	it('momentum down → 下降中', () => {
		const text = buildMarketSignalText(makeInput({ factors: { ...makeInput().factors, momentumFactor: -0.5 } }));
		expect(text).toMatch(/勢いの変化.*下降中/);
	});

	it('momentum flat → 横ばい', () => {
		const text = buildMarketSignalText(makeInput({ factors: { ...makeInput().factors, momentumFactor: 0.0 } }));
		expect(text).toMatch(/勢いの変化.*横ばい/);
	});

	it('低ボラ → 落ち着いている', () => {
		const text = buildMarketSignalText(makeInput({ factors: { ...makeInput().factors, volatilityFactor: 0.5 } }));
		expect(text).toContain('落ち着いている');
	});

	it('高ボラ → 荒い', () => {
		const text = buildMarketSignalText(makeInput({ factors: { ...makeInput().factors, volatilityFactor: -0.5 } }));
		expect(text).toContain('荒い');
	});

	it('中ボラ → 中庸', () => {
		const text = buildMarketSignalText(makeInput({ factors: { ...makeInput().factors, volatilityFactor: 0.0 } }));
		expect(text).toContain('中庸');
	});

	it('次の確認推奨: nextActions あり', () => {
		const text = buildMarketSignalText(
			makeInput({
				nextActions: [
					{ priority: 'high', tool: 'get_flow_metrics', reason: 'test', suggestedParams: { limit: 300 } },
					{ priority: 'medium', tool: 'get_orderbook', reason: 'test2' },
				],
			}),
		);
		expect(text).toContain('【次の確認推奨】');
		expect(text).toContain('1. get_flow_metrics');
		expect(text).toContain('2. get_orderbook');
	});

	it('次の確認推奨: nextActions 空 → 該当なし', () => {
		const text = buildMarketSignalText(makeInput({ nextActions: [] }));
		expect(text).toContain('- 該当なし');
	});

	it('数値詳細セクション: contributions と rawValues を含む', () => {
		const text = buildMarketSignalText(makeInput());
		expect(text).toContain('【数値詳細】');
		expect(text).toContain('contributions: sma=');
		expect(text).toContain('rawValues: smaTrend=');
		expect(text).toContain('rv_ann:');
		expect(text).toContain('aggRatio:');
	});

	it('SMA乖離: smaDeviations ありの場合', () => {
		const text = buildMarketSignalText(
			makeInput({
				smaDeviations: { vs25: 0.02, vs75: 0.04, vs200: 0.11 },
			}),
		);
		expect(text).toContain('SMA乖離: vs25=2.00%');
		expect(text).toContain('vs75=4.00%');
		expect(text).toContain('vs200=11.00%');
	});

	it('SMA乖離: vs25 undefined の場合は乖離行なし', () => {
		const text = buildMarketSignalText(makeInput({ smaDeviations: {} }));
		expect(text).not.toContain('SMA乖離:');
	});

	it('alerts ありの場合', () => {
		const text = buildMarketSignalText(
			makeInput({
				alerts: [{ level: 'warning', message: '要素間の矛盾あり' }],
			}),
		);
		expect(text).toContain('alerts: [warning] 要素間の矛盾あり');
	});

	it('alerts 空の場合は alerts 行なし', () => {
		const text = buildMarketSignalText(makeInput({ alerts: [] }));
		expect(text).not.toContain('alerts:');
	});

	it('フッターに含まれるもの/含まれないもの/補完ツールを表示', () => {
		const text = buildMarketSignalText(makeInput());
		expect(text).toContain('📌 含まれるもの:');
		expect(text).toContain('📌 含まれないもの:');
		expect(text).toContain('📌 補完ツール:');
	});

	it('SMA が null の場合でも動作する', () => {
		const text = buildMarketSignalText(
			makeInput({
				latestClose: null,
				sma: { sma25: null, sma75: null, sma200: null },
				smaDeviations: {},
			}),
		);
		expect(text).toContain('現在価格: n/a');
		expect(text).toContain('短期（25日平均）: n/a');
		expect(text).toContain('中期（75日平均）: n/a');
		expect(text).toContain('長期（200日平均）: n/a');
	});

	it('スコアが負の場合も正しく表示', () => {
		const text = buildMarketSignalText(makeInput({ score: -0.45, recommendation: 'bearish' }));
		expect(text).toContain('総合スコア: -45');
		expect(text).toContain('bearish');
	});

	it('orderStr: SMA一部nullの場合は順序文字列なし', () => {
		const text = buildMarketSignalText(
			makeInput({
				sma: { sma25: 4_900_000, sma75: 4_800_000, sma200: null },
				smaArrangement: 'bullish',
			}),
		);
		// orderStr requires all 4 values
		expect(text).not.toContain('現在価格 > 25 > 75 > 200');
	});

	it('純粋関数: 同じ入力で同じ出力', () => {
		const input = makeInput();
		expect(buildMarketSignalText(input)).toBe(buildMarketSignalText(input));
	});
});
