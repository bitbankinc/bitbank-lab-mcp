import { describe, expect, it } from 'vitest';
import { type BuildBbDefaultTextInput, buildBbDefaultText } from '../tools/analyze_bb_snapshot.js';

function makeInput(overrides?: Partial<BuildBbDefaultTextInput>): BuildBbDefaultTextInput {
	return {
		baseSummary: 'BTC/JPY [1day] z=0.5 bw=12.3%',
		position: 'near_middle',
		bandwidth_state: 'normal',
		bandWidthRank: { percentile: 45.4, sampleSize: 120 },
		volatility_trend: 'expanding',
		bandWidthPct_percentile: 65,
		current_vs_avg: 'above',
		signals: ['Price near middle band', 'Normal bandwidth'],
		next_steps: {
			if_need_detail: 'analyze_bb_snapshot mode=extended',
			if_need_visualization: 'render_chart_svg で描画',
		},
		mid: 15000000,
		upper: 15500000,
		lower: 14500000,
		zScore: 0.5,
		bandWidthPct: 12.3,
		timeseries: null,
		...overrides,
	};
}

describe('buildBbDefaultText', () => {
	it('基本出力: baseSummary + Position + Band State を含む', () => {
		const text = buildBbDefaultText(makeInput());
		expect(text).toContain('BTC/JPY [1day] z=0.5');
		expect(text).toContain('Position: near_middle / 中心付近（±1σ以内）');
		expect(text).toContain('Band State: normal / 標準（直近120本の幅の中で下から45%）');
	});

	it('Volatility Trend が含まれる', () => {
		const text = buildBbDefaultText(makeInput());
		expect(text).toContain('Volatility Trend: expanding');
	});

	it('Band Width Percentile が含まれる', () => {
		const text = buildBbDefaultText(makeInput());
		expect(text).toContain('Band Width Percentile: 65th (above vs avg)');
	});

	it('percentile が null の場合は Percentile 行なし', () => {
		const text = buildBbDefaultText(makeInput({ bandWidthPct_percentile: null }));
		expect(text).not.toContain('Band Width Percentile:');
	});

	it('Signals が出力される', () => {
		const text = buildBbDefaultText(makeInput());
		expect(text).toContain('Signals:');
		expect(text).toContain('- Price near middle band');
		expect(text).toContain('- Normal bandwidth');
	});

	it('signals が空の場合は None を表示', () => {
		const text = buildBbDefaultText(makeInput({ signals: [] }));
		expect(text).toContain('- None');
	});

	it('数値データセクションに BB 値が含まれる', () => {
		const text = buildBbDefaultText(makeInput());
		expect(text).toContain('📊 数値データ:');
		expect(text).toContain('BB middle:15000000');
		expect(text).toContain('upper:15500000');
		expect(text).toContain('lower:14500000');
		expect(text).toContain('zScore:0.500σ');
		expect(text).toContain('bw:12.30%');
	});

	it('timeseries がある場合にBB推移セクションが表示', () => {
		const text = buildBbDefaultText(
			makeInput({
				timeseries: [
					{ time: '2025-01-10T00:00:00Z', zScore: 0.3, bandWidthPct: 11.5 },
					{ time: '2025-01-11T00:00:00Z', zScore: 0.5, bandWidthPct: 12.3 },
				],
			}),
		);
		expect(text).toContain('📋 直近2本のBB推移（z は σ 単位）:');
		expect(text).toContain('2025-01-10 z:0.3 bw:11.5%');
		expect(text).toContain('2025-01-11 z:0.5 bw:12.3%');
	});

	it('timeseries が null の場合はBB推移セクションなし', () => {
		const text = buildBbDefaultText(makeInput({ timeseries: null }));
		expect(text).not.toContain('📋 直近');
	});

	it('フッターに補完ツール情報を含む', () => {
		const text = buildBbDefaultText(makeInput());
		expect(text).toContain('📌 含まれるもの:');
		expect(text).toContain('analyze_indicators');
	});
});
