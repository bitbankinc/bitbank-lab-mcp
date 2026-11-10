import { describe, expect, it } from 'vitest';
import { type BuildIchimokuSnapshotTextInput, buildIchimokuSnapshotText } from '../tools/analyze_ichimoku_snapshot.js';

function makeInput(overrides?: Partial<BuildIchimokuSnapshotTextInput>): BuildIchimokuSnapshotTextInput {
	return {
		pair: 'btc_jpy',
		type: '1day',
		close: 15000000,
		pricePosition: 'above_cloud',
		tenkan: 14900000,
		kijun: 14700000,
		tenkanKijun: 'bullish',
		tkDist: 200000,
		cloudTop: 14500000,
		cloudBottom: 14200000,
		direction: '上昇',
		thickness: 300000,
		thicknessPct: 2.0,
		strength: '中程度',
		futureCloudTop: 14600000,
		futureCloudBottom: 14300000,
		chikouSpan: { position: 'above', distance: 500000, clearance: 100000 },
		sanpuku: {
			kouten: true,
			gyakuten: false,
			conditions: { priceAboveCloud: true, tenkanAboveKijun: true, chikouAbovePrice: true },
		},
		recentCrosses: [{ type: 'golden_cross', barsAgo: 10, description: '転換線/基準線ゴールデンクロス' }],
		kumoTwist: { detected: false },
		overallSignal: 'bullish',
		overallConfidence: 'high',
		scenarios: {
			scenarios: {
				bullish: { condition: '雲の上を維持', target: 16000000, probability: '60%' },
				bearish: { condition: '基準線を割り込む', target: 14000000, probability: '25%' },
			},
			keyLevels: { support: [14700000, 14200000], resistance: [15500000] },
			watchPoints: ['転換線の傾きに注目', '雲のねじれに警戒'],
		},
		trend: {
			trendStrength: { shortTerm: 7, mediumTerm: 5 },
			momentum: 'accelerating',
		},
		cloudHistory: [
			{ barsAgo: 0, position: 'above_cloud' },
			{ barsAgo: 5, position: 'above_cloud' },
		],
		currentSpanA: 14500000,
		currentSpanB: 14200000,
		futureSpanA: 14600000,
		futureSpanB: 14300000,
		tkDistPct: 1.36,
		...overrides,
	};
}

describe('buildIchimokuSnapshotText', () => {
	it('安いペアの価格・転換線・目標を小数 3 桁で切らない', () => {
		const text = buildIchimokuSnapshotText(
			makeInput({
				close: 31.2345,
				tenkan: 31.1234,
				scenarios: {
					scenarios: {
						bullish: { condition: '雲の上を維持', target: 33.4209, probability: '60%' },
						bearish: { condition: '基準線を割り込む', target: 29.8765, probability: '25%' },
					},
					keyLevels: { support: [30.1234], resistance: [32.5678] },
					watchPoints: [],
				},
			}),
		);
		expect(text).toContain('価格: 31.2345円');
		expect(text).toContain('・転換線: 31.1234円');
		expect(text).toContain('→ 33.4209円');
		expect(text).toContain('サポート: 30.1234円');
	});

	it('基本出力: ペア名と価格を含む', () => {
		const text = buildIchimokuSnapshotText(makeInput());
		expect(text).toContain('BTC_JPY 1day 一目均衡表分析');
		expect(text).toContain('価格: 15,000,000円');
	});

	it('基本配置セクション: 価格位置・転換線・基準線を含む', () => {
		const text = buildIchimokuSnapshotText(makeInput());
		expect(text).toContain('【基本配置】');
		expect(text).toContain('above cloud');
		expect(text).toContain('転換線:');
		expect(text).toContain('基準線:');
	});

	it('転換線と基準線の関係が表示される', () => {
		const text = buildIchimokuSnapshotText(makeInput());
		expect(text).toContain('強気配置');
	});

	it('雲の状態セクションが含まれる', () => {
		const text = buildIchimokuSnapshotText(makeInput());
		expect(text).toContain('【雲の状態（現在の雲）】');
		expect(text).toContain('雲の方向: 上昇');
		expect(text).toContain('雲の厚み:');
	});

	it('26日後の雲セクションが含まれる', () => {
		const text = buildIchimokuSnapshotText(makeInput());
		expect(text).toContain('【26日後の雲（先行スパン）】');
	});

	it('先行スパンの先の長さは足の種類で数える（週足は 26 週後、4 時間足は 26 本後）', () => {
		const weekly = buildIchimokuSnapshotText(makeInput({ type: '1week' }));
		expect(weekly).toContain('【26週後の雲（先行スパン）】');
		expect(weekly).toContain('雲(26週後): spanA=');
		const h4 = buildIchimokuSnapshotText(makeInput({ type: '4hour' }));
		expect(h4).toContain('【26本後の雲（先行スパン）】');
		expect(h4).not.toContain('26日後');
	});

	it('遅行スパンが含まれる', () => {
		const text = buildIchimokuSnapshotText(makeInput());
		expect(text).toContain('【遅行スパン】');
		expect(text).toContain('26本前の価格より上');
	});

	it('三役好転の場合は「好転」表示', () => {
		const text = buildIchimokuSnapshotText(makeInput());
		expect(text).toContain('三役判定: 好転');
		expect(text).toContain('✓ 価格が雲の上');
		expect(text).toContain('✓ 転換線が基準線の上');
		expect(text).toContain('✓ 遅行スパンが好転中');
	});

	it('三役逆転の場合は「逆転」表示', () => {
		const text = buildIchimokuSnapshotText(
			makeInput({
				sanpuku: {
					kouten: false,
					gyakuten: true,
					conditions: { priceAboveCloud: false, tenkanAboveKijun: false, chikouAbovePrice: false },
				},
			}),
		);
		expect(text).toContain('三役判定: 逆転');
	});

	it('部分的な条件達成の場合に達成数を表示', () => {
		const text = buildIchimokuSnapshotText(
			makeInput({
				sanpuku: {
					kouten: false,
					gyakuten: false,
					conditions: { priceAboveCloud: true, tenkanAboveKijun: true, chikouAbovePrice: false },
				},
			}),
		);
		expect(text).toContain('好転条件 2/3 達成');
	});

	it('雲のねじれが検出された場合に表示', () => {
		const text = buildIchimokuSnapshotText(
			makeInput({
				kumoTwist: { detected: true, barsAgo: 3, direction: 'bullish' },
			}),
		);
		expect(text).toContain('雲のねじれ: 3本前に強気のねじれ発生');
	});

	it('シナリオと重要価格が含まれる', () => {
		const text = buildIchimokuSnapshotText(makeInput());
		expect(text).toContain('【今後の注目ポイント】');
		expect(text).toContain('上昇シナリオ:');
		expect(text).toContain('下落シナリオ:');
		expect(text).toContain('サポート:');
		expect(text).toContain('レジスタンス:');
	});

	it('トレンド分析が含まれる', () => {
		const text = buildIchimokuSnapshotText(makeInput());
		expect(text).toContain('【トレンド分析】');
		expect(text).toContain('短期強度: 7');
		expect(text).toContain('モメンタム: 加速中');
	});

	it('数値データセクションが含まれる', () => {
		const text = buildIchimokuSnapshotText(makeInput());
		expect(text).toContain('【数値データ】');
		expect(text).toContain('転換線: 14900000 / 基準線: 14700000');
	});

	it('フッターに補完ツール情報を含む', () => {
		const text = buildIchimokuSnapshotText(makeInput());
		expect(text).toContain('📌 含まれるもの: 一目均衡表');
		expect(text).toContain('analyze_indicators');
	});
});
