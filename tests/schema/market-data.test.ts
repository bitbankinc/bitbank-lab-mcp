import { describe, expect, it } from 'vitest';
import {
	GetCandlesInputSchema,
	GetFlowMetricsInputSchema,
	GetOrderbookInputSchema,
	GetTransactionsInputSchema,
	OrderbookLevelSchema,
	OrderbookLevelWithCumSchema,
	TickerNormalizedSchema,
} from '../../src/schema/market-data.js';

describe('TickerNormalizedSchema', () => {
	it('有効なティッカーを受け入れる', () => {
		const result = TickerNormalizedSchema.parse({
			pair: 'btc_jpy',
			last: 5000000,
			buy: 4999000,
			sell: 5001000,
			open: 4900000,
			high: 5100000,
			low: 4800000,
			volume: 100.5,
			timestamp: 1700000000,
			isoTime: '2024-01-01T00:00:00Z',
		});
		expect(result.pair).toBe('btc_jpy');
		expect(result.last).toBe(5000000);
	});

	it('nullable フィールドに null を受け入れる', () => {
		const result = TickerNormalizedSchema.parse({
			pair: 'btc_jpy',
			last: null,
			buy: null,
			sell: null,
			open: null,
			high: null,
			low: null,
			volume: null,
			timestamp: null,
			isoTime: null,
		});
		expect(result.last).toBeNull();
	});
});

describe('OrderbookLevelSchema', () => {
	it('有効なレベルを受け入れる', () => {
		const result = OrderbookLevelSchema.parse({ price: 5000000, size: 1.5 });
		expect(result.price).toBe(5000000);
	});

	it('cumSize 付きスキーマも動作する', () => {
		const result = OrderbookLevelWithCumSchema.parse({ price: 5000000, size: 1.5, cumSize: 10.0 });
		expect(result.cumSize).toBe(10.0);
	});
});

describe('GetCandlesInputSchema', () => {
	it('有効な入力を受け入れる', () => {
		const result = GetCandlesInputSchema.parse({ pair: 'btc_jpy', type: '1day' });
		expect(result.limit).toBe(200);
		expect(result.view).toBe('full');
		expect(result.format).toBe('text');
		expect(result.tz).toBe('Asia/Tokyo');
	});

	it('deprecated alias（items）を受理し、enum 外は拒否する', () => {
		// alias 期間中も enum は**閉じたまま**であること。ここを固定しないと、
		// 誰かが view を z.string() に緩めてもテストが通り、ハンドラ側の
		// alias 正規化が「唯一の受理経路」でなくなったことに気づけない。
		expect(GetCandlesInputSchema.parse({ pair: 'btc_jpy', type: '1day', view: 'items' }).view).toBe('items');
		expect(() => GetCandlesInputSchema.parse({ pair: 'btc_jpy', type: '1day', view: 'summary' })).toThrow();
		expect(() => GetCandlesInputSchema.parse({ pair: 'btc_jpy', type: '1day', format: 'yaml' })).toThrow();
	});

	it('カスタム limit を受け入れる', () => {
		const result = GetCandlesInputSchema.parse({ pair: 'btc_jpy', type: '1hour', limit: 50 });
		expect(result.limit).toBe(50);
	});

	it('limit 範囲外を拒否する', () => {
		expect(() => GetCandlesInputSchema.parse({ pair: 'btc_jpy', type: '1day', limit: 0 })).toThrow();
		// max=10000 まで許容（multi-day/multi-year 経路の実上限と整合）
		expect(() => GetCandlesInputSchema.parse({ pair: 'btc_jpy', type: '1day', limit: 10001 })).toThrow();
	});

	it('limit=10000 を受け入れる（multi-day 経路の実上限と整合）', () => {
		const result = GetCandlesInputSchema.parse({ pair: 'btc_jpy', type: '1min', limit: 10000 });
		expect(result.limit).toBe(10000);
	});
});

describe('GetOrderbookInputSchema', () => {
	it('デフォルト値を適用する', () => {
		const result = GetOrderbookInputSchema.parse({});
		expect(result.pair).toBe('btc_jpy');
		expect(result.mode).toBe('summary');
		expect(result.topN).toBe(10);
	});

	it('カスタム mode を受け入れる', () => {
		const result = GetOrderbookInputSchema.parse({ mode: 'pressure' });
		expect(result.mode).toBe('pressure');
	});
});

describe('GetTransactionsInputSchema', () => {
	it('デフォルト値を適用する', () => {
		const result = GetTransactionsInputSchema.parse({});
		expect(result.pair).toBe('btc_jpy');
		expect(result.limit).toBe(100);
		// default は summary → full に変わったが**挙動は不変**（docs/internal/view-vocabulary-unification.md §3-5）。
		// 旧 summary は名前に反して「全件列挙」で実体が full だったため、名前だけを階梯に合わせた。
		// 旧値は 0.4.0 まで alias として受理し続ける（写像テストは tests/view-alias-mapping.test.ts）。
		expect(result.view).toBe('full');
		expect(result.format).toBe('text');
	});

	it('deprecated alias（summary / items）を受理し、enum 外は拒否する', () => {
		expect(GetTransactionsInputSchema.parse({ view: 'summary' }).view).toBe('summary');
		expect(GetTransactionsInputSchema.parse({ view: 'items' }).view).toBe('items');
		expect(() => GetTransactionsInputSchema.parse({ view: 'verbose' })).toThrow();
		expect(() => GetTransactionsInputSchema.parse({ format: 'yaml' })).toThrow();
	});

	it('date フォーマットを検証する', () => {
		const result = GetTransactionsInputSchema.parse({ date: '20240101' });
		expect(result.date).toBe('20240101');
	});

	it('無効な date フォーマットを拒否する', () => {
		expect(() => GetTransactionsInputSchema.parse({ date: '2024-01-01' })).toThrow();
	});
});

describe('GetFlowMetricsInputSchema', () => {
	it('デフォルト値を適用する', () => {
		const result = GetFlowMetricsInputSchema.parse({});
		expect(result.limit).toBe(100);
		expect(result.bucketMs).toBe(60_000);
		expect(result.view).toBe('summary');
		expect(result.nonZeroOnly).toBe(false);
		expect(result.bucketsN).toBe(10);
		expect(result.tz).toBe('Asia/Tokyo');
	});

	it('deprecated alias（compact / buckets）を受理し、enum 外は拒否する', () => {
		expect(GetFlowMetricsInputSchema.parse({ view: 'compact' }).view).toBe('compact');
		expect(GetFlowMetricsInputSchema.parse({ view: 'buckets' }).view).toBe('buckets');
		expect(GetFlowMetricsInputSchema.parse({ view: 'detailed' }).view).toBe('detailed');
		expect(() => GetFlowMetricsInputSchema.parse({ view: 'verbose' })).toThrow();
		expect(() => GetFlowMetricsInputSchema.parse({ nonZeroOnly: 'true' })).toThrow();
	});

	it('hours を受け入れる', () => {
		const result = GetFlowMetricsInputSchema.parse({ hours: 8 });
		expect(result.hours).toBe(8);
	});

	it('hours 範囲外を拒否する', () => {
		expect(() => GetFlowMetricsInputSchema.parse({ hours: 0 })).toThrow();
		expect(() => GetFlowMetricsInputSchema.parse({ hours: 25 })).toThrow();
	});
});
