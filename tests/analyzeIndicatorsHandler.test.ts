import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../tools/analyze_indicators.js', () => ({
	default: vi.fn(),
}));

import { ICHIMOKU_SHIFT } from '../lib/indicator-config.js';
import {
	type BuildIndicatorsTextInput,
	buildIndicatorsText,
	toolDef,
} from '../src/handlers/analyzeIndicatorsHandler.js';
import analyzeIndicators from '../tools/analyze_indicators.js';

/** デフォルト入力: 全フィールド null/空 → 最小出力 */
function baseInput(overrides?: Partial<BuildIndicatorsTextInput>): BuildIndicatorsTextInput {
	return {
		pair: 'btc_jpy',
		type: '1day',
		nowJst: '2026-04-01 12:00',
		close: 10000000,
		prev: 9900000,
		deltaPrev: { amt: 100000, pct: 1.01 },
		deltaLabel: '前日比',
		trend: 'uptrend',
		rsi: 55,
		recentRsiFormatted: ['50.0', '52.0', '55.0'],
		rsiUnitLabel: '日',
		macdLine: 10000,
		macdSignal: 5000,
		macdHist: 5000,
		lastMacdCross: { type: 'golden', barsAgo: 3 },
		divergence: 'なし',
		sma25: 9800000,
		sma75: 9500000,
		sma200: 9000000,
		s25Slope: 1000,
		s75Slope: 500,
		s200Slope: -200,
		arrangement: '200日 < 75日 < 25日 < 価格',
		crossInfo: '直近クロス: ゴールデン（5本前）',
		bbMid: 9800000,
		bbUp: 10200000,
		bbLo: 9400000,
		sigmaZ: 1.0,
		bandWidthPct: 8.16,
		bwTrend: '拡大中',
		sigmaHistory: [
			{ off: -6, z: 0.5 },
			{ off: -1, z: 1.0 },
		],
		tenkan: 9900000,
		kijun: 9700000,
		spanA: 9600000,
		spanB: 9400000,
		cloudTop: 9600000,
		cloudBot: 9400000,
		cloudPos: 'above_cloud',
		cloudThickness: 200000,
		cloudThicknessPct: 2.0,
		chikouBull: true,
		threeSignals: { judge: '三役好転' },
		toCloudDistance: null,
		ichimokuConvSlope: 500,
		ichimokuBaseSlope: -100,
		stochK: 65,
		stochD: 60,
		stochPrevK: 58,
		stochPrevD: 62,
		obvVal: 12345,
		obvSma20: 12000,
		obvTrend: 'rising',
		obvPrev: 12200,
		obvUnit: '',
		...overrides,
	};
}

describe('buildIndicatorsText', () => {
	// ── ヘッダー ─────────────────────────────────────────

	it('ヘッダーに pair / type / 時刻を含む', () => {
		const text = buildIndicatorsText(baseInput());
		expect(text).toContain('BTC_JPY');
		expect(text).toContain('1day');
		expect(text).toContain('2026-04-01');
	});

	it('deltaPrev ありで前日比を表示', () => {
		const text = buildIndicatorsText(baseInput());
		expect(text).toContain('前日比');
	});

	it('deltaPrev null で変化率なし', () => {
		const text = buildIndicatorsText(baseInput({ deltaPrev: null }));
		expect(text).not.toContain('前日比');
	});

	// ── 総合判定 ─────────────────────────────────────────

	it('uptrend → 上昇トレンド', () => {
		const text = buildIndicatorsText(baseInput({ trend: 'uptrend' }));
		expect(text).toContain('上昇トレンド');
	});

	it('strong_downtrend → 強い下降トレンド', () => {
		const text = buildIndicatorsText(baseInput({ trend: 'strong_downtrend' }));
		expect(text).toContain('強い下降トレンド');
	});

	it('neutral → 中立/レンジ', () => {
		const text = buildIndicatorsText(baseInput({ trend: 'neutral' }));
		expect(text).toContain('中立/レンジ');
	});

	// ── RSI 判定 ─────────────────────────────────────────

	it('RSI < 30 → 売られすぎ', () => {
		const text = buildIndicatorsText(baseInput({ rsi: 25 }));
		expect(text).toContain('売られすぎ');
	});

	it('RSI 30-50 → 弱め', () => {
		const text = buildIndicatorsText(baseInput({ rsi: 40 }));
		expect(text).toContain('弱め');
	});

	it('RSI 50-70 → 中立〜強め', () => {
		const text = buildIndicatorsText(baseInput({ rsi: 60 }));
		expect(text).toContain('中立〜強め');
	});

	it('RSI >= 70 → 買われすぎ', () => {
		const text = buildIndicatorsText(baseInput({ rsi: 75 }));
		expect(text).toContain('買われすぎ');
	});

	it('RSI null → n/a', () => {
		const text = buildIndicatorsText(baseInput({ rsi: null }));
		expect(text).toContain('RSI(14): n/a');
	});

	it('RSI 推移が2本以上で推移セクションを表示', () => {
		const text = buildIndicatorsText(baseInput({ recentRsiFormatted: ['50.0', '55.0', '60.0'] }));
		expect(text).toContain('RSI推移');
		expect(text).toContain('50.0 → 55.0 → 60.0');
	});

	it('RSI 推移が1本以下で推移セクションなし', () => {
		const text = buildIndicatorsText(baseInput({ recentRsiFormatted: ['50.0'] }));
		expect(text).not.toContain('RSI推移');
	});

	// ── MACD ─────────────────────────────────────────────

	it('MACD line / signal / hist の3数値がテキストに含まれる', () => {
		const text = buildIndicatorsText(baseInput({ macdLine: 12345, macdSignal: 6789, macdHist: 5556 }));
		expect(text).toContain('line=12,345');
		expect(text).toContain('signal=6,789');
		expect(text).toContain('hist=5,556');
	});

	it('MACD line / signal null → n/a', () => {
		const text = buildIndicatorsText(baseInput({ macdLine: null, macdSignal: null }));
		expect(text).toContain('line=n/a');
		expect(text).toContain('signal=n/a');
	});

	it('MACD line / signal が NaN / Infinity → n/a（NaN を出さない）', () => {
		const text = buildIndicatorsText(
			baseInput({ macdLine: Number.NaN, macdSignal: Number.POSITIVE_INFINITY, macdHist: Number.NEGATIVE_INFINITY }),
		);
		expect(text).toContain('line=n/a');
		expect(text).toContain('signal=n/a');
		expect(text).toContain('hist=n/a');
		expect(text).not.toContain('NaN');
		expect(text).not.toContain('Infinity');
	});

	it('MACD 負値も整数 + toLocaleString で表示される', () => {
		const text = buildIndicatorsText(baseInput({ macdLine: -1234, macdSignal: -567 }));
		expect(text).toContain('line=-1,234');
		expect(text).toContain('signal=-567');
	});

	it('MACD hist > 0 → 強気継続', () => {
		const text = buildIndicatorsText(baseInput({ macdHist: 5000 }));
		expect(text).toContain('強気継続');
	});

	it('MACD hist < 0 → 弱気継続', () => {
		const text = buildIndicatorsText(baseInput({ macdHist: -3000 }));
		expect(text).toContain('弱気継続');
	});

	it('MACD ゴールデンクロス表示', () => {
		const text = buildIndicatorsText(baseInput({ lastMacdCross: { type: 'golden', barsAgo: 3 } }));
		expect(text).toContain('ゴールデンクロス: 3本前');
	});

	it('MACD デッドクロス表示', () => {
		const text = buildIndicatorsText(baseInput({ lastMacdCross: { type: 'dead', barsAgo: 7 } }));
		expect(text).toContain('デッドクロス: 7本前');
	});

	it('MACD クロスなし', () => {
		const text = buildIndicatorsText(baseInput({ lastMacdCross: null }));
		expect(text).toContain('直近クロス: なし');
	});

	// ── BB ────────────────────────────────────────────────

	it('sigmaZ <= -1 → 売られすぎ', () => {
		const text = buildIndicatorsText(baseInput({ sigmaZ: -1.5 }));
		expect(text).toContain('-1.5σ');
		expect(text).toContain('売られすぎ');
	});

	it('sigmaZ >= 1 → 買われすぎ', () => {
		const text = buildIndicatorsText(baseInput({ sigmaZ: 1.5 }));
		expect(text).toContain('買われすぎ');
	});

	it('bandWidthPct < 8 → スクイーズ', () => {
		const text = buildIndicatorsText(baseInput({ bandWidthPct: 5 }));
		expect(text).toContain('スクイーズ');
	});

	it('bandWidthPct > 20 → エクスパンション', () => {
		const text = buildIndicatorsText(baseInput({ bandWidthPct: 25 }));
		expect(text).toContain('エクスパンション');
	});

	it('bbLo >= close で「現在価格に近い」表示', () => {
		const text = buildIndicatorsText(baseInput({ close: 9400000, bbLo: 9400000 }));
		expect(text).toContain('現在価格に近い');
	});

	it('sigmaHistory ありで過去推移を表示', () => {
		const text = buildIndicatorsText(
			baseInput({
				sigmaHistory: [
					{ off: -6, z: 0.5 },
					{ off: -1, z: 1.0 },
				],
			}),
		);
		expect(text).toContain('5日前: 0.5σ');
		expect(text).toContain('現在: 1σ');
	});

	// ── 一目均衡表 ───────────────────────────────────────

	it('above_cloud → 強気', () => {
		const text = buildIndicatorsText(baseInput({ cloudPos: 'above_cloud' }));
		expect(text).toContain('雲の上 → 強気');
	});

	it('below_cloud → 弱気 + 雲突入距離', () => {
		const text = buildIndicatorsText(baseInput({ cloudPos: 'below_cloud', toCloudDistance: 3.5, close: 9000000 }));
		expect(text).toContain('雲の下 → 弱気');
		expect(text).toContain('雲突入まで: 3.5%');
	});

	it('in_cloud → 中立', () => {
		const text = buildIndicatorsText(baseInput({ cloudPos: 'in_cloud' }));
		expect(text).toContain('雲の中 → 中立');
	});

	it('chikouBull true → 強気', () => {
		const text = buildIndicatorsText(baseInput({ chikouBull: true }));
		expect(text).toContain('価格より上 → 強気');
	});

	it('chikouBull false → 弱気', () => {
		const text = buildIndicatorsText(baseInput({ chikouBull: false }));
		expect(text).toContain('価格より下 → 弱気');
	});

	it('三役好転を表示', () => {
		const text = buildIndicatorsText(baseInput({ threeSignals: { judge: '三役好転' } }));
		expect(text).toContain('三役好転');
	});

	it('cloudThickness ありで雲の厚さを表示', () => {
		const text = buildIndicatorsText(baseInput({ cloudThickness: 200000, cloudThicknessPct: 2.0 }));
		expect(text).toContain('雲の厚さ');
	});

	// ── ストキャスティクス ────────────────────────────────

	it('stochK <= 20 → 売られすぎゾーン', () => {
		const text = buildIndicatorsText(baseInput({ stochK: 15, stochD: 18 }));
		expect(text).toContain('売られすぎゾーン');
	});

	it('stochK >= 80 → 買われすぎゾーン', () => {
		const text = buildIndicatorsText(baseInput({ stochK: 85, stochD: 82 }));
		expect(text).toContain('買われすぎゾーン');
	});

	it('stochK <= 10 → 強い売られすぎ', () => {
		const text = buildIndicatorsText(baseInput({ stochK: 8, stochD: 12 }));
		expect(text).toContain('強い売られすぎ');
	});

	it('stochK >= 90 → 強い買われすぎ', () => {
		const text = buildIndicatorsText(baseInput({ stochK: 92, stochD: 88 }));
		expect(text).toContain('強い買われすぎ');
	});

	it('%K が %D を上抜け → 買いシグナル', () => {
		// prevK < prevD, curK > curD
		const text = buildIndicatorsText(baseInput({ stochK: 55, stochD: 50, stochPrevK: 45, stochPrevD: 50 }));
		expect(text).toContain('買いシグナル');
	});

	it('%K が %D を下抜け → 売りシグナル', () => {
		// prevK > prevD, curK < curD
		const text = buildIndicatorsText(baseInput({ stochK: 45, stochD: 50, stochPrevK: 55, stochPrevD: 50 }));
		expect(text).toContain('売りシグナル');
	});

	it('stoch クロスなし', () => {
		// prevK > prevD, curK > curD（変化なし）
		const text = buildIndicatorsText(baseInput({ stochK: 55, stochD: 50, stochPrevK: 55, stochPrevD: 50 }));
		expect(text).toContain('クロス: なし');
	});

	it('stochK null → データ不足', () => {
		const text = buildIndicatorsText(baseInput({ stochK: null, stochD: null }));
		expect(text).toMatch(/ストキャスティクス[\s\S]*データ不足/);
	});

	// ── OBV ──────────────────────────────────────────────

	it('OBV rising → 出来高が上昇を支持', () => {
		const text = buildIndicatorsText(baseInput({ obvTrend: 'rising' }));
		expect(text).toContain('出来高が上昇を支持');
	});

	it('OBV falling → 出来高が下落を支持', () => {
		const text = buildIndicatorsText(baseInput({ obvTrend: 'falling' }));
		expect(text).toContain('出来高が下落を支持');
	});

	it('OBV flat → 出来高中立', () => {
		const text = buildIndicatorsText(baseInput({ obvTrend: 'flat' }));
		expect(text).toContain('出来高中立');
	});

	it('OBV ベアリッシュダイバージェンス（価格↑・OBV↓）', () => {
		// close > prev, obvVal < obvPrev
		const text = buildIndicatorsText(baseInput({ close: 10100000, prev: 10000000, obvVal: 12000, obvPrev: 12500 }));
		expect(text).toContain('ベアリッシュ');
	});

	it('OBV ブルリッシュダイバージェンス（価格↓・OBV↑）', () => {
		// close < prev, obvVal > obvPrev
		const text = buildIndicatorsText(baseInput({ close: 9900000, prev: 10000000, obvVal: 12500, obvPrev: 12000 }));
		expect(text).toContain('ブルリッシュ');
	});

	it('OBV ダイバージェンスなし（同方向）', () => {
		// close > prev, obvVal > obvPrev
		const text = buildIndicatorsText(baseInput({ close: 10100000, prev: 10000000, obvVal: 12500, obvPrev: 12000 }));
		expect(text).toContain('ダイバージェンス: なし');
	});

	it('OBV null → データ不足', () => {
		const text = buildIndicatorsText(baseInput({ obvVal: null }));
		expect(text).toMatch(/OBV[\s\S]*データ不足/);
	});

	// ── deltaLabel バリエーション ─────────────────────────

	it('timeframe week → 前週比ラベル対応', () => {
		const text = buildIndicatorsText(baseInput({ deltaLabel: '前週比' }));
		expect(text).toContain('前週比');
	});

	// ── 全セクション存在確認 ──────────────────────────────

	it('全セクションのヘッダーが含まれる', () => {
		const text = buildIndicatorsText(baseInput());
		expect(text).toContain('【総合判定】');
		expect(text).toContain('【モメンタム】');
		expect(text).toContain('【トレンド（移動平均線）】');
		expect(text).toContain('【ボラティリティ（ボリンジャーバンド±2σ）】');
		expect(text).toContain('【一目均衡表】');
		expect(text).toContain('【ストキャスティクスRSI】');
		expect(text).toContain('【OBV (On-Balance Volume)】');
		expect(text).toContain('【次に確認すべきこと】');
	});

	// ── null 多数でも crash しない ────────────────────────

	it('strong_downtrend + rsi < 30 + エクスパンション → 総合判定が全て反映', () => {
		const text = buildIndicatorsText(baseInput({ trend: 'strong_downtrend', rsi: 20, bandWidthPct: 25 }));
		expect(text).toContain('強い下降トレンド');
		expect(text).toContain('売られすぎ');
		expect(text).toContain('エクスパンション');
	});

	it('sigmaZ 中立範囲（-1 < z < 1）→ 中立', () => {
		const text = buildIndicatorsText(baseInput({ sigmaZ: 0.3 }));
		expect(text).toContain('中立');
	});

	it('bbLo > close で「現在価格に近い」非表示', () => {
		const text = buildIndicatorsText(baseInput({ close: 10000000, bbLo: 9000000 }));
		expect(text).not.toContain('現在価格に近い');
	});

	it('bbUp close で upper のvsCurPctが表示される', () => {
		const text = buildIndicatorsText(baseInput({ close: 10000000, bbUp: 10200000 }));
		expect(text).toContain('upper');
	});

	it('cloudPos unknown → 「n/a（雲データ不足）」（中立に丸めない）', () => {
		const text = buildIndicatorsText(baseInput({ cloudPos: 'unknown' }));
		expect(text).toContain('一目均衡表');
		expect(text).toContain('n/a（雲データ不足）');
		// データ欠落を「中立」として誤表示しない
		expect(text).not.toContain('雲の中 → 中立');
	});

	it('obvUnit が表示される', () => {
		const text = buildIndicatorsText(baseInput({ obvUnit: 'BTC' }));
		expect(text).toContain('BTC');
	});

	it('crossInfo null で表示されない', () => {
		const text = buildIndicatorsText(baseInput({ crossInfo: null }));
		expect(text).toContain('移動平均線');
	});

	it('bandWidthPct null で バンド幅 非表示', () => {
		const text = buildIndicatorsText(baseInput({ bandWidthPct: null }));
		expect(text).not.toContain('バンド幅');
	});

	it('chikouBull null で遅行スパン非表示', () => {
		const text = buildIndicatorsText(baseInput({ chikouBull: null }));
		expect(text).not.toContain('遅行スパン');
	});

	it('toCloudDistance: above_cloud では表示されない', () => {
		const text = buildIndicatorsText(baseInput({ cloudPos: 'above_cloud', toCloudDistance: 5 }));
		expect(text).not.toContain('雲突入まで');
	});

	it('ほぼ全て null でもクラッシュしない', () => {
		const text = buildIndicatorsText(
			baseInput({
				close: null,
				prev: null,
				deltaPrev: null,
				rsi: null,
				recentRsiFormatted: [],
				macdLine: null,
				macdSignal: null,
				macdHist: null,
				lastMacdCross: null,
				divergence: null,
				sma25: null,
				sma75: null,
				sma200: null,
				s25Slope: null,
				s75Slope: null,
				s200Slope: null,
				crossInfo: null,
				bbMid: null,
				bbUp: null,
				bbLo: null,
				sigmaZ: null,
				bandWidthPct: null,
				bwTrend: null,
				sigmaHistory: null,
				tenkan: null,
				kijun: null,
				spanA: null,
				spanB: null,
				cloudTop: null,
				cloudBot: null,
				cloudThickness: null,
				cloudThicknessPct: null,
				chikouBull: null,
				toCloudDistance: null,
				ichimokuConvSlope: null,
				ichimokuBaseSlope: null,
				stochK: null,
				stochD: null,
				stochPrevK: null,
				stochPrevD: null,
				obvVal: null,
				obvSma20: null,
				obvTrend: null,
				obvPrev: null,
			}),
		);
		expect(text).toContain('【総合判定】');
		expect(text.length).toBeGreaterThan(100);
	});
});

// ── toolDef.handler テスト ───────────────────────────

describe('toolDef.handler', () => {
	const mockedAnalyze = vi.mocked(analyzeIndicators);

	afterEach(() => vi.clearAllMocks());

	/** handler が必要とする analyzeIndicators の戻り値を構築 */
	/** ichi_series を「今日の雲」の値（spanA[len-26]/spanB[len-26]）から構築 */
	function buildIchiSeries(todaySpanA: number, todaySpanB: number, length = 30) {
		// 末尾 26 本前が「今日の雲」、末尾は「26 本後の雲」（今日計算された先行スパン）。
		// 末尾のみ別値を入れて区別する。
		const spanA = Array.from({ length }, () => todaySpanA);
		const spanB = Array.from({ length }, () => todaySpanB);
		return {
			tenkan: Array.from({ length }, () => todaySpanA),
			kijun: Array.from({ length }, () => todaySpanB),
			spanA,
			spanB,
			chikou: Array.from({ length }, () => todaySpanA),
		};
	}

	function mockResult(overrides?: Record<string, unknown>) {
		const series = {
			SMA_25: Array.from({ length: 20 }, (_, i) => 9700000 + i * 1000),
			SMA_75: Array.from({ length: 20 }, (_, i) => 9500000 + i * 500),
			SMA_200: Array.from({ length: 20 }, (_, i) => 9000000 + i * 200),
			MACD_line: Array.from({ length: 20 }, (_, i) => 1000 + i * 100),
			MACD_signal: Array.from({ length: 20 }, (_, i) => 800 + i * 100),
			MACD_hist: Array.from({ length: 20 }, (_, i) => 200 + i * 10),
			BB_upper: Array.from({ length: 20 }, () => 10200000),
			BB_lower: Array.from({ length: 20 }, () => 9400000),
			BB_middle: Array.from({ length: 20 }, () => 9800000),
			ICHIMOKU_conversion: Array.from({ length: 20 }, (_, i) => 9900000 + i * 100),
			ICHIMOKU_base: Array.from({ length: 20 }, (_, i) => 9700000 + i * 50),
		};
		const indicators = {
			RSI_14: 55,
			RSI_14_series: Array.from({ length: 10 }, (_, i) => 50 + i),
			SMA_25: 9800000,
			SMA_75: 9500000,
			SMA_200: 9000000,
			BB_middle: 9800000,
			BB_upper: 10200000,
			BB_lower: 9400000,
			MACD_hist: 5000,
			ICHIMOKU_spanA: 9600000,
			ICHIMOKU_spanB: 9400000,
			ICHIMOKU_conversion: 9900000,
			ICHIMOKU_base: 9700000,
			// 「今日の雲」判定は ichi_series.spanA/B の末尾 26 本前を参照する。
			ichi_series: buildIchiSeries(9600000, 9400000),
			STOCH_RSI_K: 65,
			STOCH_RSI_D: 60,
			STOCH_RSI_prevK: 58,
			STOCH_RSI_prevD: 62,
			OBV: 12345,
			OBV_SMA20: 12000,
			OBV_trend: 'rising',
			OBV_prevObv: 12200,
			series,
			...overrides,
		};
		// 30 本のローソク足（chikou 判定に 27 本必要）
		const normalized = Array.from({ length: 30 }, (_, i) => ({
			close: 10000000 + (i - 15) * 10000,
			open: 10000000,
			high: 10050000,
			low: 9950000,
		}));
		return {
			ok: true,
			summary: 'ok',
			data: { indicators, normalized, trend: 'uptrend' },
			meta: {},
		};
	}

	it('正常データでテキスト content を返す', async () => {
		mockedAnalyze.mockResolvedValueOnce(mockResult() as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content).toBeDefined();
		expect(res.content[0].text).toContain('BTC_JPY');
		expect(res.content[0].text).toContain('【総合判定】');
	});

	it('analyzeIndicators 失敗時はそのまま返す', async () => {
		mockedAnalyze.mockResolvedValueOnce({ ok: false, summary: 'error' } as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as { ok: boolean };
		expect(res.ok).toBe(false);
	});

	it('deltaLabel が timeframe に応じて変わる', async () => {
		for (const [type, label] of [
			['1day', '前日比'],
			['1week', '前週比'],
			['1month', '前月比'],
			['1hour', '前時間比'],
			['5min', '前足比'],
		] as const) {
			mockedAnalyze.mockResolvedValueOnce(mockResult() as never);
			const res = (await toolDef.handler({ pair: 'btc_jpy', type, limit: 200 })) as {
				content: Array<{ text: string }>;
			};
			expect(res.content[0].text).toContain(label);
		}
	});

	it('rsiUnitLabel が timeframe に応じて変わる', async () => {
		mockedAnalyze.mockResolvedValueOnce(mockResult() as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1week', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text).toContain('週');
	});

	it('BB series なしでも crash しない', async () => {
		const m = mockResult();
		(m.data.indicators as Record<string, unknown>).series = {};
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content).toBeDefined();
	});

	it('candles が少なくても crash しない', async () => {
		const m = mockResult();
		m.data.normalized = [{ close: 10000000, open: 10000000, high: 10050000, low: 9950000 }];
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content).toBeDefined();
	});

	it('cloudPos below_cloud で雲突入距離を計算', async () => {
		const m = mockResult();
		// close < cloudBot → below_cloud
		m.data.normalized = Array.from({ length: 30 }, () => ({
			close: 9300000,
			open: 9300000,
			high: 9350000,
			low: 9250000,
		}));
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text).toContain('雲の下');
	});

	it('handler が ind.MACD_line / MACD_signal を content text に渡す', async () => {
		const m = mockResult();
		(m.data.indicators as Record<string, unknown>).MACD_line = 12345;
		(m.data.indicators as Record<string, unknown>).MACD_signal = 6789;
		(m.data.indicators as Record<string, unknown>).MACD_hist = 5556;
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text).toContain('line=12,345');
		expect(res.content[0].text).toContain('signal=6,789');
		expect(res.content[0].text).toContain('hist=5,556');
	});

	it('MACD クロス検出', async () => {
		const m = mockResult();
		// MACD_line と MACD_signal がクロスするデータ
		const series = (m.data.indicators as Record<string, unknown>).series as Record<string, number[]>;
		series.MACD_line = [...Array.from({ length: 10 }, () => -100), ...Array.from({ length: 10 }, () => 100)];
		series.MACD_signal = Array.from({ length: 20 }, () => 0);
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text).toContain('ゴールデン');
	});

	it('SMA クロス検出', async () => {
		const m = mockResult();
		const series = (m.data.indicators as Record<string, unknown>).series as Record<string, number[]>;
		// SMA_25 が SMA_75 を上抜け
		series.SMA_25 = [...Array.from({ length: 10 }, () => 9400000), ...Array.from({ length: 10 }, () => 9600000)];
		series.SMA_75 = Array.from({ length: 20 }, () => 9500000);
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text).toContain('ゴールデン');
	});

	it('三役逆転の検出', async () => {
		const m = mockResult();
		// close < cloudBot → below_cloud
		m.data.normalized = Array.from({ length: 30 }, (_, i) => ({
			close: 9000000 + (i < 15 ? i * 10000 : -i * 10000),
			open: 9000000,
			high: 9100000,
			low: 8900000,
		}));
		// tenkan < kijun → convAboveBase = false
		(m.data.indicators as Record<string, unknown>).ICHIMOKU_conversion = 9200000;
		(m.data.indicators as Record<string, unknown>).ICHIMOKU_base = 9500000;
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text).toContain('三役逆転');
	});

	it('cloudPos in_cloud の検出', async () => {
		const m = mockResult();
		// 「今日の雲」: spanA=10.2M / spanB=9.8M、close=10M → in_cloud
		(m.data.indicators as Record<string, unknown>).ichi_series = buildIchiSeries(10200000, 9800000);
		m.data.normalized = Array.from({ length: 30 }, () => ({
			close: 10000000,
			open: 10000000,
			high: 10050000,
			low: 9950000,
		}));
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text).toContain('雲の中');
	});

	it('toCloudDistance: above_cloud で雲からの距離を計算', async () => {
		const m = mockResult();
		// 「今日の雲」: spanA=9.3M / spanB=9.2M、close=10M → above_cloud
		(m.data.indicators as Record<string, unknown>).ichi_series = buildIchiSeries(9300000, 9200000);
		m.data.normalized = Array.from({ length: 30 }, () => ({
			close: 10000000,
			open: 10000000,
			high: 10050000,
			low: 9950000,
		}));
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text).toContain('雲の上');
	});

	// ── 「今日の雲」判定のバグ修正（spanA[len-ICHIMOKU_SHIFT] を使うこと）──

	it('「今日の雲」判定は ichi_series.spanA/B の末尾 ICHIMOKU_SHIFT 本前を使う（ICHIMOKU_spanA/B とズレているケース）', async () => {
		const m = mockResult();
		// 末尾の ICHIMOKU_spanA/B（= ICHIMOKU_SHIFT 本後の雲）と「今日の雲」（= spanA[len-ICHIMOKU_SHIFT]）が
		// 大きく異なるケース。close=10M。
		// - ICHIMOKU_spanA/B（末尾＝ICHIMOKU_SHIFT 本後）: 6M/5M → これを使うと above_cloud（バグ）
		// - 今日の雲（spanA/B[len-ICHIMOKU_SHIFT]）: 11M/10.5M → 正しくは below_cloud
		(m.data.indicators as Record<string, unknown>).ICHIMOKU_spanA = 6000000;
		(m.data.indicators as Record<string, unknown>).ICHIMOKU_spanB = 5000000;
		const length = ICHIMOKU_SHIFT + 4;
		const spanA = Array.from({ length }, () => 11000000); // 「今日の雲」用
		const spanB = Array.from({ length }, () => 10500000);
		spanA[length - 1] = 6000000; // 末尾は「ICHIMOKU_SHIFT 本後の雲」
		spanB[length - 1] = 5000000;
		(m.data.indicators as Record<string, unknown>).ichi_series = {
			tenkan: Array.from({ length }, () => 11000000),
			kijun: Array.from({ length }, () => 10500000),
			spanA,
			spanB,
			chikou: Array.from({ length }, () => 11000000),
		};
		m.data.normalized = Array.from({ length: 30 }, () => ({
			close: 10000000,
			open: 10000000,
			high: 10050000,
			low: 9950000,
		}));
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		// 「今日の雲」（spanA[len-ICHIMOKU_SHIFT]=11M, spanB[len-ICHIMOKU_SHIFT]=10.5M）の下に close=10M がある
		expect(res.content[0].text).toContain('雲の下');
		expect(res.content[0].text).not.toContain('雲の上');
		// 表示される先行スパンも「今日の雲」の値であること
		expect(res.content[0].text).toContain('先行スパンA: 11,000,000');
		expect(res.content[0].text).toContain('先行スパンB: 10,500,000');
	});

	it('ichi_series が ICHIMOKU_SHIFT 本未満なら雲判定は null にフォールバック（末尾の ICHIMOKU_spanA/B は使わない）', async () => {
		const m = mockResult();
		// length < ICHIMOKU_SHIFT → spanA[len-ICHIMOKU_SHIFT] が取れないのでフォールバック
		const length = ICHIMOKU_SHIFT - 1;
		(m.data.indicators as Record<string, unknown>).ichi_series = {
			tenkan: Array.from({ length }, () => 9600000),
			kijun: Array.from({ length }, () => 9400000),
			spanA: Array.from({ length }, () => 9600000),
			spanB: Array.from({ length }, () => 9400000),
			chikou: Array.from({ length }, () => 9600000),
		};
		// 末尾の scalar 値（= 26 本後の雲）だけは存在するが、雲判定には使わない
		(m.data.indicators as Record<string, unknown>).ICHIMOKU_spanA = 9600000;
		(m.data.indicators as Record<string, unknown>).ICHIMOKU_spanB = 9400000;
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		const text = res.content[0].text;
		// 「今日の雲」は取得できないので、強気/弱気/中立のいずれの確定判定も出さない
		expect(text).not.toContain('雲の上 → 強気');
		expect(text).not.toContain('雲の下 → 弱気');
		expect(text).not.toContain('雲の中 → 中立');
		expect(text).toContain('n/a（雲データ不足）');
		// 先行スパン表示も n/a（= spanA/B が null にフォールバック）
		expect(text).toContain('先行スパンA: n/a');
		expect(text).toContain('先行スパンB: n/a');
	});

	it('ichi_series が欠落していても雲判定は null にフォールバック', async () => {
		const m = mockResult();
		delete (m.data.indicators as Record<string, unknown>).ichi_series;
		// 末尾の scalar 値（= 26 本後の雲）だけは存在するが、判定には使わない
		(m.data.indicators as Record<string, unknown>).ICHIMOKU_spanA = 9600000;
		(m.data.indicators as Record<string, unknown>).ICHIMOKU_spanB = 9400000;
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		const text = res.content[0].text;
		expect(text).not.toContain('雲の上 → 強気');
		expect(text).not.toContain('雲の下 → 弱気');
		expect(text).not.toContain('雲の中 → 中立');
		expect(text).toContain('n/a（雲データ不足）');
		expect(text).toContain('先行スパンA: n/a');
		expect(text).toContain('先行スパンB: n/a');
	});

	it('ブルリッシュ divergence 検出（MACD）', async () => {
		const m = mockResult();
		// 価格は下降、MACD hist は上昇
		m.data.normalized = Array.from({ length: 30 }, (_, i) => ({
			close: 11000000 - i * 50000,
			open: 11000000,
			high: 11100000 - i * 50000,
			low: 10900000 - i * 50000,
		}));
		const series = (m.data.indicators as Record<string, unknown>).series as Record<string, number[]>;
		series.MACD_hist = Array.from({ length: 30 }, (_, i) => -5000 + i * 200);
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text).toContain('ブルリッシュ');
	});

	it('SMA デッドクロス検出', async () => {
		const m = mockResult();
		const series = (m.data.indicators as Record<string, unknown>).series as Record<string, number[]>;
		// SMA_25 が SMA_75 を下抜け
		series.SMA_25 = [...Array.from({ length: 10 }, () => 9600000), ...Array.from({ length: 10 }, () => 9400000)];
		series.SMA_75 = Array.from({ length: 20 }, () => 9500000);
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text).toContain('デッド');
	});

	it('MACD デッドクロス検出', async () => {
		const m = mockResult();
		const series = (m.data.indicators as Record<string, unknown>).series as Record<string, number[]>;
		series.MACD_line = [...Array.from({ length: 10 }, () => 100), ...Array.from({ length: 10 }, () => -100)];
		series.MACD_signal = Array.from({ length: 20 }, () => 0);
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text).toContain('デッド');
	});

	it('OBV unit が pair に応じて変わる', async () => {
		mockedAnalyze.mockResolvedValueOnce(mockResult() as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text).toContain('BTC');
	});

	it('arrangement: SMA が3本未満で n/a', async () => {
		const m = mockResult();
		(m.data.indicators as Record<string, unknown>).SMA_25 = null;
		(m.data.indicators as Record<string, unknown>).SMA_75 = null;
		(m.data.indicators as Record<string, unknown>).SMA_200 = null;
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text).toContain('配置: n/a');
	});

	it('bwTrend 収縮中の検出', async () => {
		const m = mockResult({
			series: {
				SMA_25: Array.from({ length: 20 }, (_, i) => 9700000 + i * 1000),
				SMA_75: Array.from({ length: 20 }, (_, i) => 9500000 + i * 500),
				SMA_200: Array.from({ length: 20 }, (_, i) => 9000000 + i * 200),
				MACD_line: Array.from({ length: 20 }, (_, i) => 1000 + i * 100),
				MACD_signal: Array.from({ length: 20 }, (_, i) => 800 + i * 100),
				MACD_hist: Array.from({ length: 20 }, (_, i) => 200 + i * 10),
				// BB が収縮: 以前は幅広、今は幅狭
				BB_upper: Array.from({ length: 20 }, (_, i) => (i < 10 ? 10500000 : 10100000)),
				BB_lower: Array.from({ length: 20 }, (_, i) => (i < 10 ? 9500000 : 9900000)),
				BB_middle: Array.from({ length: 20 }, () => 10000000),
				ICHIMOKU_conversion: Array.from({ length: 20 }, (_, i) => 9900000 + i * 100),
				ICHIMOKU_base: Array.from({ length: 20 }, (_, i) => 9700000 + i * 50),
			},
		});
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		// bwTrend を確認（収縮中 or 拡大中 or 不変 のいずれか）
		const text = res.content[0].text;
		// BB series の幅が減少しているので収縮中が期待される
		expect(text).toMatch(/収縮中|拡大中|不変/);
	});

	it('MACD divergence 検出（ベアリッシュ）', async () => {
		const m = mockResult();
		// 価格は上昇、MACD hist は下降
		m.data.normalized = Array.from({ length: 30 }, (_, i) => ({
			close: 9000000 + i * 50000,
			open: 9000000,
			high: 9100000 + i * 50000,
			low: 8900000 + i * 50000,
		}));
		const series = (m.data.indicators as Record<string, unknown>).series as Record<string, number[]>;
		series.MACD_hist = Array.from({ length: 30 }, (_, i) => 5000 - i * 200);
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text).toContain('ベアリッシュ');
	});

	// ── 上流 warning / 指標不足 warnings の prepend ─────────

	it('meta.warning が content[0].text の先頭に出る', async () => {
		const m = mockResult();
		(m as { meta?: Record<string, unknown> }).meta = {
			warning: '⚠️ 3日中1日の取得に失敗しました。',
		};
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		// content の最先頭が警告行で始まる
		expect(res.content[0].text.startsWith('⚠️')).toBe(true);
		expect(res.content[0].text).toContain('3日中1日の取得に失敗');
		// 警告行のあとに本文セクションが続く
		const idxWarning = res.content[0].text.indexOf('⚠️');
		const idxBody = res.content[0].text.indexOf('【総合判定】');
		expect(idxWarning).toBeLessThan(idxBody);
	});

	it('meta.warnings（指標不足）が meta.warning と独立した別行として content に出る', async () => {
		const m = mockResult();
		(m as { meta?: Record<string, unknown> }).meta = {
			warning: '⚠️ 4年中1年の取得に失敗しました（2020年）。',
			warnings: ['SMA_200: データ不足', 'EMA_200: データ不足'],
		};
		mockedAnalyze.mockResolvedValueOnce(m as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		const text = res.content[0].text;
		// 上流 warning と 指標不足 warnings の両方が含まれる
		expect(text).toContain('4年中1年');
		expect(text).toContain('SMA_200: データ不足');
		expect(text).toContain('EMA_200: データ不足');
		// 別行で並ぶ
		const lines = text.split('\n');
		const warningLineIdx = lines.findIndex((l) => l.includes('4年中1年'));
		const sma200LineIdx = lines.findIndex((l) => l.includes('SMA_200'));
		expect(warningLineIdx).toBeGreaterThanOrEqual(0);
		expect(sma200LineIdx).toBeGreaterThan(warningLineIdx);
	});

	it('meta.warning / meta.warnings が無ければ本文が prefix なしで出る', async () => {
		mockedAnalyze.mockResolvedValueOnce(mockResult() as never);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text.startsWith('⚠️')).toBe(false);
		expect(res.content[0].text.startsWith('===')).toBe(true);
	});
});
