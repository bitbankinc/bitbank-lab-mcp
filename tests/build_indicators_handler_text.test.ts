import { describe, expect, it } from 'vitest';
import { type BuildIndicatorsTextInput, buildIndicatorsText } from '../src/handlers/analyzeIndicatorsHandler.js';

function makeInput(overrides?: Partial<BuildIndicatorsTextInput>): BuildIndicatorsTextInput {
	return {
		pair: 'btc_jpy',
		type: '1day',
		nowJst: '2025/01/15 09:00',
		close: 15000000,
		prev: 14900000,
		deltaPrev: { amt: 100000, pct: 0.67 },
		deltaLabel: '前日比',
		trend: 'uptrend',
		rsi: 55,
		recentRsiFormatted: ['48.0', '50.5', '52.3', '55.0'],
		rsiUnitLabel: '日',
		macdLine: 10000,
		macdSignal: 5000,
		macdHist: 5000,
		lastMacdCross: { type: 'golden', barsAgo: 10 },
		divergence: 'なし',
		sma25: 14800000,
		sma75: 14500000,
		sma200: 13500000,
		s25Slope: 500,
		s75Slope: 200,
		s200Slope: 100,
		arrangement: '200日 < 75日 < 25日 < 価格',
		crossInfo: '直近クロス: ゴールデン（5本前）',
		bbMid: 14900000,
		bbUp: 15400000,
		bbLo: 14400000,
		sigmaZ: 0.4,
		bandWidthPct: 6.71,
		bwTrend: '収縮中',
		sigmaHistory: [
			{ off: -6, z: 0.8 },
			{ off: -1, z: 0.4 },
		],
		tenkan: 14950000,
		kijun: 14700000,
		spanA: 14600000,
		spanB: 14300000,
		cloudTop: 14600000,
		cloudBot: 14300000,
		cloudPos: 'above_cloud',
		cloudThickness: 300000,
		cloudThicknessPct: 2.0,
		chikouBull: true,
		threeSignals: { judge: '三役好転' },
		toCloudDistance: null,
		ichimokuConvSlope: 500,
		ichimokuBaseSlope: 100,
		stochK: 45,
		stochD: 50,
		stochPrevK: 40,
		stochPrevD: 48,
		obvVal: 1234.56,
		obvSma20: 1200,
		obvTrend: 'rising',
		obvPrev: 1200,
		obvUnit: 'BTC',
		...overrides,
	};
}

describe('buildIndicatorsText', () => {
	it('ヘッダー: ペア名・時間足・時刻を含む', () => {
		const text = buildIndicatorsText(makeInput());
		expect(text).toContain('=== BTC_JPY 1day 分析 ===');
		expect(text).toContain('2025/01/15 09:00 現在');
	});

	it('価格と前日比を含む', () => {
		const text = buildIndicatorsText(makeInput());
		expect(text).toContain('(前日比:');
	});

	it('総合判定セクション: トレンド・RSI・BB幅を含む', () => {
		const text = buildIndicatorsText(makeInput());
		expect(text).toContain('【総合判定】');
		expect(text).toContain('トレンド: 上昇トレンド');
		expect(text).toContain('RSI=55');
		expect(text).toContain('中立圏');
	});

	it('strong_downtrend の場合に警告を表示', () => {
		const text = buildIndicatorsText(makeInput({ trend: 'strong_downtrend' }));
		expect(text).toContain('強い下降トレンド ⚠️');
	});

	it('モメンタムセクション: RSI推移を含む', () => {
		const text = buildIndicatorsText(makeInput());
		expect(text).toContain('【モメンタム】');
		expect(text).toContain('RSI(14): 55');
		expect(text).toContain('48.0 → 50.5 → 52.3 → 55.0');
	});

	it('RSI < 30 で売られすぎ判定', () => {
		const text = buildIndicatorsText(makeInput({ rsi: 25 }));
		expect(text).toContain('売られすぎ圏（反発の可能性）');
	});

	it('RSI >= 70 で買われすぎ判定', () => {
		const text = buildIndicatorsText(makeInput({ rsi: 75 }));
		expect(text).toContain('買われすぎ圏（反落の可能性）');
	});

	it('MACD セクション: line / signal / hist とクロス情報', () => {
		const text = buildIndicatorsText(makeInput());
		expect(text).toContain('MACD(12,26,9): line=10,000 signal=5,000 hist=5,000');
		expect(text).toContain('ゴールデンクロス: 10本前');
	});

	it('MACD デッドクロスの表示', () => {
		const text = buildIndicatorsText(
			makeInput({
				lastMacdCross: { type: 'dead', barsAgo: 3 },
			}),
		);
		expect(text).toContain('デッドクロス: 3本前');
	});

	it('SMA セクション: 配置とクロス情報', () => {
		const text = buildIndicatorsText(makeInput());
		expect(text).toContain('【トレンド（移動平均線）】');
		expect(text).toContain('配置: 200日 < 75日 < 25日 < 価格');
		expect(text).toContain('SMA(25):');
		expect(text).toContain('SMA(75):');
		expect(text).toContain('SMA(200):');
		expect(text).toContain('直近クロス: ゴールデン（5本前）');
	});

	it('BB セクション: σ位置とバンド幅', () => {
		const text = buildIndicatorsText(makeInput());
		expect(text).toContain('【ボラティリティ（ボリンジャーバンド±2σ）】');
		expect(text).toContain('0.4σ');
		expect(text).toContain('バンド幅: 6.71%');
		expect(text).toContain('収縮中');
	});

	it('BB σ履歴がある場合に過去推移を表示', () => {
		const text = buildIndicatorsText(makeInput());
		expect(text).toContain('5日前: 0.8σ');
		expect(text).toContain('現在: 0.4σ');
	});

	it('一目均衡表セクション: 雲の上・三役好転', () => {
		const text = buildIndicatorsText(makeInput());
		expect(text).toContain('【一目均衡表】');
		expect(text).toContain('雲の上 → 強気');
		expect(text).toContain('三役判定: 三役好転');
	});

	it('cloudPos=below_cloud で弱気表示 + 雲突入距離', () => {
		const text = buildIndicatorsText(
			makeInput({
				cloudPos: 'below_cloud',
				toCloudDistance: 3.5,
			}),
		);
		expect(text).toContain('雲の下 → 弱気');
		expect(text).toContain('雲突入まで: 3.5%');
	});

	it('ストキャスティクス RSI セクション', () => {
		const text = buildIndicatorsText(makeInput());
		expect(text).toContain('【ストキャスティクスRSI】');
		expect(text).toContain('%K: 45.0');
		expect(text).toContain('%D: 50.0');
		expect(text).toContain('中立圏');
	});

	it('Stoch %K <= 20 で売られすぎゾーン', () => {
		const text = buildIndicatorsText(makeInput({ stochK: 15, stochD: 20 }));
		expect(text).toContain('売られすぎゾーン');
	});

	it('Stoch クロス上抜けの検出', () => {
		const text = buildIndicatorsText(
			makeInput({
				stochK: 55,
				stochD: 50,
				stochPrevK: 45,
				stochPrevD: 50,
			}),
		);
		expect(text).toContain('%Kが%Dを上抜け');
	});

	it('Stoch K/D が null の場合はデータ不足を表示', () => {
		const text = buildIndicatorsText(makeInput({ stochK: null, stochD: null }));
		expect(text).toContain('データ不足');
	});

	it('OBV セクション: 現在値・トレンド', () => {
		const text = buildIndicatorsText(makeInput());
		expect(text).toContain('【OBV (On-Balance Volume)】');
		expect(text).toContain('BTC');
		expect(text).toContain('OBV > SMA → 出来高が上昇を支持');
	});

	it('OBV ベアリッシュダイバージェンス', () => {
		const text = buildIndicatorsText(
			makeInput({
				close: 15000000,
				prev: 14900000,
				obvVal: 1100,
				obvPrev: 1200,
			}),
		);
		expect(text).toContain('ベアリッシュ（価格↑・OBV↓）');
	});

	it('OBV が null の場合はデータ不足', () => {
		const text = buildIndicatorsText(makeInput({ obvVal: null }));
		const obvSection = text.split('【OBV')[1]?.split('【')[0] ?? '';
		expect(obvSection).toContain('データ不足');
	});

	it('フッターに次に確認すべきことを含む', () => {
		const text = buildIndicatorsText(makeInput());
		expect(text).toContain('【次に確認すべきこと】');
		expect(text).toContain('analyze_bb_snapshot');
		expect(text).toContain('analyze_ichimoku_snapshot');
	});
});
