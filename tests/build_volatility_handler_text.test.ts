import { describe, expect, it } from 'vitest';
import {
	buildVolatilityBeginnerText,
	buildVolatilityDetailedText,
	type VolDetailedInput,
	type VolViewInput,
} from '../src/handlers/getVolatilityMetricsHandler.js';

function makeViewInput(overrides?: Partial<VolViewInput>): VolViewInput {
	return {
		pair: 'btc_jpy',
		type: '1day',
		lastClose: 10_000_000,
		ann: true,
		annFactor: 19.1,
		annFactorFull: 19.1,
		sampleSize: 30,
		rvAnn: 0.45,
		pkAnn: 0.38,
		gkAnn: 0.35,
		rsAnn: 0.3,
		atrAbs: 250_000,
		atrPct: 0.025,
		tagsAll: ['volatile', 'high_vol'],
		rolling: [
			{ window: 14, rv_std: 0.025, rv_std_ann: 0.478 },
			{ window: 30, rv_std: 0.023, rv_std_ann: 0.439 },
		],
		...overrides,
	};
}

describe('buildVolatilityBeginnerText', () => {
	it('安いペアの現在価格と ATR を円の整数に潰さない', () => {
		const text = buildVolatilityBeginnerText(makeViewInput({ lastClose: 31.2345, atrAbs: 0.987654 }));
		expect(text).toContain('現在価格: 31.2345円');
		expect(text).toContain('約0.9877円');
	});

	it('ATR は価格の水準で桁を決めるので、BTC では 10 万円未満でも円の整数のまま', () => {
		const text = buildVolatilityBeginnerText(makeViewInput({ atrAbs: 45_678.9 }));
		expect(text).toContain('約45,679円');
	});

	it('ペア名・時間足・現在価格を含む', () => {
		const text = buildVolatilityBeginnerText(makeViewInput());
		expect(text).toContain('BTC_JPY [1day]');
		expect(text).toContain('現在価格:');
		expect(text).toContain('10,000,000円');
	});

	it('年間の動きとATRを含む', () => {
		const text = buildVolatilityBeginnerText(makeViewInput());
		expect(text).toContain('年間のおおよその動き');
		expect(text).toContain('1日の平均的な動き');
		expect(text).toContain('250,000円');
	});

	it('タグがある場合は今の傾向を表示', () => {
		const text = buildVolatilityBeginnerText(makeViewInput({ tagsAll: ['expanding_vol'] }));
		expect(text).toContain('今の傾向: expanding vol');
	});

	it('タグが空の場合は今の傾向を表示しない', () => {
		const text = buildVolatilityBeginnerText(makeViewInput({ tagsAll: [] }));
		expect(text).not.toContain('今の傾向');
	});

	it('lastClose が null の場合は n/a', () => {
		const text = buildVolatilityBeginnerText(makeViewInput({ lastClose: null }));
		expect(text).toContain('n/a');
	});
});

describe('buildVolatilityDetailedText', () => {
	it('ヘッダーに close 価格を含む', () => {
		const text = buildVolatilityDetailedText(makeViewInput(), 'detailed');
		expect(text).toContain('BTC_JPY [1day]');
		expect(text).toContain('close=10,000,000');
	});

	it('Volatility Metrics ブロックを含む', () => {
		const text = buildVolatilityDetailedText(makeViewInput(), 'detailed');
		expect(text).toContain('【Volatility Metrics (annualized)');
		expect(text).toContain('RV (std):');
		expect(text).toContain('ATR:');
		expect(text).toContain('Parkinson:');
	});

	it('annualize=false の場合は (annualized) が付かない', () => {
		const text = buildVolatilityDetailedText(makeViewInput({ ann: false }), 'detailed');
		expect(text).toContain('【Volatility Metrics,');
		expect(text).not.toContain('(annualized)');
	});

	it('Rolling Trends にウィンドウ・矢印を含む', () => {
		const text = buildVolatilityDetailedText(makeViewInput(), 'detailed');
		expect(text).toContain('【Rolling Trends');
		expect(text).toContain('14-day RV:');
		expect(text).toContain('30-day RV:');
	});

	it('Assessment ブロックにタグを含む', () => {
		const text = buildVolatilityDetailedText(makeViewInput(), 'detailed');
		expect(text).toContain('【Assessment】');
		expect(text).toContain('Tags: volatile, high_vol');
	});

	it('full ビューで Series ブロックを含む', () => {
		const input: VolDetailedInput = {
			...makeViewInput(),
			series: {
				ts: [1_700_000_000_000, 1_700_086_400_000],
				close: [10_000_000, 10_100_000],
				ret: [0.01],
			},
		};
		const text = buildVolatilityDetailedText(input, 'full');
		expect(text).toContain('【Series】');
		expect(text).toContain('Total: 30 candles');
		expect(text).toContain('Close range:');
		expect(text).toContain('Returns: mean=');
	});

	it('detailed ビューでは Series ブロックを含まない', () => {
		const input: VolDetailedInput = {
			...makeViewInput(),
			series: {
				ts: [1_700_000_000_000],
				close: [10_000_000],
				ret: [],
			},
		};
		const text = buildVolatilityDetailedText(input, 'detailed');
		expect(text).not.toContain('【Series】');
	});

	it('rolling が空の場合でもエラーにならない', () => {
		const text = buildVolatilityDetailedText(makeViewInput({ rolling: [] }), 'detailed');
		expect(text).toContain('【Rolling Trends');
	});
});
