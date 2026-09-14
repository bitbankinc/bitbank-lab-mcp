import { describe, expect, it } from 'vitest';
import {
	type BuildFlowMetricsTextInput,
	buildFlowMetricsText,
	type FlowMetricsBucket,
} from '../tools/get_flow_metrics.js';

function makeBucket(overrides?: Partial<FlowMetricsBucket>): FlowMetricsBucket {
	return {
		timestampMs: 1_700_000_060_000,
		isoTime: '2023-11-14T00:01:00Z',
		isoTimeJST: '2023-11-14T09:01:00+09:00',
		displayTime: '11/14 09:01',
		buyVolume: 0.1,
		sellVolume: 0.2,
		totalVolume: 0.3,
		cvd: -0.1,
		zscore: 0.5,
		spike: null,
		...overrides,
	};
}

function makeInput(overrides?: Partial<BuildFlowMetricsTextInput>): BuildFlowMetricsTextInput {
	return {
		baseSummary: 'BTC/JPY trades=3 buy%=66.7 CVD=-0.10',
		totalTrades: 3,
		buyVolume: 0.4,
		sellVolume: 0.2,
		netVolume: 0.2,
		aggressorRatio: 0.667,
		cvd: 0.2,
		buckets: [makeBucket()],
		bucketMs: 60_000,
		...overrides,
	};
}

describe('buildFlowMetricsText', () => {
	it('基本出力: baseSummary + aggregates + バケット情報を含む', () => {
		const text = buildFlowMetricsText(makeInput());
		expect(text).toContain('BTC/JPY trades=3');
		expect(text).toContain('aggregates: totalTrades=3');
		expect(text).toContain('buyVol=0.4');
		expect(text).toContain('sellVol=0.2');
		expect(text).toContain('全1件のバケット (60000ms間隔)');
	});

	it('バケット行に displayTime・buy/sell・cvd・zscore が含まれる', () => {
		const text = buildFlowMetricsText(makeInput());
		expect(text).toContain('[0] 11/14 09:01 buy:0.1 sell:0.2 cvd:-0.1 z:0.5');
	});

	it('spike ありのバケットは spike ラベルが付く', () => {
		const text = buildFlowMetricsText(
			makeInput({
				buckets: [makeBucket({ spike: 'strong' })],
			}),
		);
		expect(text).toContain('spike:strong');
	});

	it('spike なしのバケットは spike ラベルが付かない', () => {
		const text = buildFlowMetricsText(
			makeInput({
				buckets: [makeBucket({ spike: null })],
			}),
		);
		expect(text).not.toContain('spike:');
	});

	it('zscore が null の場合は n/a と表示', () => {
		const text = buildFlowMetricsText(
			makeInput({
				buckets: [makeBucket({ zscore: null })],
			}),
		);
		expect(text).toContain('z:n/a');
	});

	it('dataWarning がある場合はテキストに含まれる', () => {
		const text = buildFlowMetricsText(
			makeInput({
				dataWarning: 'ℹ️ カバレッジ: 要求 1440分のうち実データがあるのは 834分（58%）です。欠損 606分（1区間）',
			}),
		);
		expect(text).toContain('要求 1440分');
		expect(text).toContain('欠損 606分');
	});

	it('取得層 / 計算層の 2 系統を渡すと別行で並ぶ', () => {
		const text = buildFlowMetricsText(
			makeInput({
				dataWarning:
					'ℹ️ カバレッジ: 要求 1440分のうち実データがあるのは 834分（58%）です。欠損 606分（1区間）\n⚠️ 集計値は実データのある 834分のみから算出しています',
			}),
		);
		const lines = text.split('\n');
		const fetchIdx = lines.findIndex((l) => l.startsWith('ℹ️ カバレッジ'));
		const calcIdx = lines.findIndex((l) => l.startsWith('⚠️ 集計値'));
		expect(fetchIdx).toBeGreaterThanOrEqual(0);
		expect(calcIdx).toBe(fetchIdx + 1);
	});

	it('dataWarning が undefined の場合は警告行なし', () => {
		const text = buildFlowMetricsText(makeInput({ dataWarning: undefined }));
		// baseSummary の直後に aggregates が来る（⚠️ 行がない）
		expect(text).not.toContain('⚠️');
		expect(text).toContain('CVD=-0.10\naggregates:');
	});

	it('複数バケットのインデックスが正しい', () => {
		const text = buildFlowMetricsText(
			makeInput({
				buckets: [
					makeBucket({ displayTime: '09:01' }),
					makeBucket({ displayTime: '09:02' }),
					makeBucket({ displayTime: '09:03' }),
				],
			}),
		);
		expect(text).toContain('[0] 09:01');
		expect(text).toContain('[1] 09:02');
		expect(text).toContain('[2] 09:03');
	});

	it('displayTime がない場合は isoTimeJST にフォールバック', () => {
		const text = buildFlowMetricsText(
			makeInput({
				buckets: [makeBucket({ displayTime: undefined, isoTimeJST: '2023-11-14T09:01:00+09:00' })],
			}),
		);
		expect(text).toContain('[0] 2023-11-14T09:01:00+09:00');
	});

	it('フッターに補完ツール情報を含む', () => {
		const text = buildFlowMetricsText(makeInput());
		expect(text).toContain('📌 含まれるもの:');
		expect(text).toContain('get_transactions');
	});
});
