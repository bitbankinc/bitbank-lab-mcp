import { describe, expect, it } from 'vitest';
import { type BuildVolatilityMetricsTextInput, buildVolatilityMetricsText } from '../tools/get_volatility_metrics.js';

function makeInput(overrides?: Partial<BuildVolatilityMetricsTextInput>): BuildVolatilityMetricsTextInput {
	return {
		baseSummary: 'BTC/JPY [1day] rv=0.450(ann)',
		aggregates: {
			rv_std: 0.02345678,
			rv_std_ann: 0.44812345,
			parkinson: 0.01891234,
			garmanKlass: 0.01561234,
			rogersSatchell: 0.01231234,
			atr: 250000.12345678,
		},
		rolling: [
			{ window: 14, rv_std: 0.025, rv_std_ann: 0.47759999, parkinson: 0.02 },
			{ window: 20, rv_std: 0.023, rv_std_ann: 0.4394, parkinson: 0.018 },
		],
		...overrides,
	};
}

describe('buildVolatilityMetricsText', () => {
	it('基本出力: baseSummary + aggregates + ローリング分析を含む', () => {
		const text = buildVolatilityMetricsText(makeInput());
		expect(text).toContain('BTC/JPY [1day] rv=0.450(ann)');
		expect(text).toContain('aggregates:');
		expect(text).toContain('rv_std:0.02345678');
		expect(text).toContain('rv_std_ann:0.44812345');
		expect(text).toContain('📊 ローリング分析:');
	});

	it('aggregates の各指標が出力される', () => {
		const text = buildVolatilityMetricsText(makeInput());
		expect(text).toContain('parkinson:0.01891234');
		expect(text).toContain('garmanKlass:0.01561234');
		expect(text).toContain('rogersSatchell:0.01231234');
		expect(text).toContain('atr:250000.12345678');
	});

	it('rv_std_ann が undefined の場合は出力から省略される', () => {
		const text = buildVolatilityMetricsText(
			makeInput({
				aggregates: {
					rv_std: 0.023,
					rv_std_ann: undefined,
					parkinson: 0.019,
					garmanKlass: 0.016,
					rogersSatchell: 0.012,
					atr: 250000,
				},
			}),
		);
		expect(text).not.toContain('rv_std_ann:');
		expect(text).toContain('rv_std:0.023');
	});

	it('ローリング行に window・rv・ann・pk が含まれる', () => {
		const text = buildVolatilityMetricsText(makeInput());
		expect(text).toContain('w=14 rv:0.025000 ann:0.477600 pk:0.020000');
		expect(text).toContain('w=20 rv:0.023000 ann:0.439400 pk:0.018000');
	});

	it('ローリング行に atr フィールドが含まれない', () => {
		const text = buildVolatilityMetricsText(makeInput());
		const rollingSection = text.split('📊 ローリング分析:')[1]?.split('---')[0] ?? '';
		expect(rollingSection).not.toContain('atr:');
	});

	it('ローリングで rv_std_ann が undefined の場合はローリング行に ann: を含まない', () => {
		const text = buildVolatilityMetricsText(
			makeInput({
				rolling: [{ window: 14, rv_std: 0.025, parkinson: 0.02 }],
			}),
		);
		expect(text).toContain('w=14 rv:0.025000');
		// ローリング行に ann: が含まれないことを確認（baseSummary の (ann) とは区別）
		const rollingSection = text.split('📊 ローリング分析:')[1]?.split('---')[0] ?? '';
		expect(rollingSection).not.toContain('ann:');
	});

	it('空のローリング配列でもエラーにならない', () => {
		const text = buildVolatilityMetricsText(makeInput({ rolling: [] }));
		expect(text).toContain('📊 ローリング分析:');
	});

	it('フッターに補完ツール情報を含む', () => {
		const text = buildVolatilityMetricsText(makeInput());
		expect(text).toContain('📌 含まれるもの:');
		expect(text).toContain('get_candles');
		expect(text).toContain('analyze_indicators');
	});
});
