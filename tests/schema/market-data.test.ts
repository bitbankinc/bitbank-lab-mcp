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
		expect(result.tz).toBe('Asia/Tokyo');
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
		// 語彙統一で既定を summary → full に改名した。**挙動は完全に不変**——旧 summary は
		// 実体が全件列挙で full と同じであり、名前だけを階梯（summary < detailed < full）に
		// 合わせた（docs/internal/view-vocabulary-unification.md §3-5）。
		expect(result.view).toBe('full');
		expect(result.format).toBe('text');
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
		expect(result.tz).toBe('Asia/Tokyo');
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
