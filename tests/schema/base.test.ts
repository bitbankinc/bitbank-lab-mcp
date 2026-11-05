import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	BaseMetaSchema,
	BasePairInputSchema,
	CandleSchema,
	CandleTypeEnum,
	FailResultSchema,
	NumericSeriesSchema,
	RateLimitSchema,
	TrendLabelEnum,
	toolResultSchema,
} from '../../src/schema/base.js';

describe('CandleTypeEnum', () => {
	it('有効な時間足を受け入れる', () => {
		const valid = ['1min', '5min', '15min', '30min', '1hour', '4hour', '8hour', '12hour', '1day', '1week', '1month'];
		for (const v of valid) {
			expect(CandleTypeEnum.parse(v)).toBe(v);
		}
	});

	it('無効な時間足を拒否する', () => {
		expect(() => CandleTypeEnum.parse('2hour')).toThrow();
		expect(() => CandleTypeEnum.parse('')).toThrow();
	});
});

describe('RateLimitSchema', () => {
	it('有効なレート制限を受け入れる', () => {
		const result = RateLimitSchema.parse({ remaining: 100, limit: 300, reset: 1700000000 });
		expect(result).toEqual({ remaining: 100, limit: 300, reset: 1700000000 });
	});

	it('undefined を受け入れる（optional）', () => {
		expect(RateLimitSchema.parse(undefined)).toBeUndefined();
	});
});

describe('BaseMetaSchema', () => {
	it('有効なメタデータを受け入れる', () => {
		const result = BaseMetaSchema.parse({
			pair: 'btc_jpy',
			fetchedAt: '2024-01-01T00:00:00Z',
			rateLimit: undefined,
		});
		expect(result.pair).toBe('btc_jpy');
	});

	it('pair が欠けていると拒否する', () => {
		expect(() => BaseMetaSchema.parse({ fetchedAt: '2024-01-01' })).toThrow();
	});
});

describe('BasePairInputSchema', () => {
	it('デフォルト値 btc_jpy を適用する', () => {
		const result = BasePairInputSchema.parse({});
		expect(result.pair).toBe('btc_jpy');
	});

	it('指定されたペアを使用する', () => {
		const result = BasePairInputSchema.parse({ pair: 'eth_jpy' });
		expect(result.pair).toBe('eth_jpy');
	});
});

describe('FailResultSchema', () => {
	it('有効な失敗結果を受け入れる', () => {
		const result = FailResultSchema.parse({
			ok: false,
			summary: 'Error occurred',
			data: {},
			meta: { errorType: 'network' },
		});
		expect(result.ok).toBe(false);
		expect(result.meta.errorType).toBe('network');
	});

	it('ok: true を拒否する', () => {
		expect(() =>
			FailResultSchema.parse({
				ok: true,
				summary: 'ok',
				data: {},
				meta: { errorType: 'user' },
			}),
		).toThrow();
	});
});

describe('toolResultSchema', () => {
	it('ok/fail の union スキーマを生成する', () => {
		const schema = toolResultSchema(z.object({ value: z.number() }), z.object({ source: z.string() }));

		const okResult = schema.parse({
			ok: true,
			summary: 'success',
			data: { value: 42 },
			meta: { source: 'test' },
		});
		expect(okResult.ok).toBe(true);

		const failResult = schema.parse({
			ok: false,
			summary: 'Error: fail',
			data: {},
			meta: { errorType: 'user' },
		});
		expect(failResult.ok).toBe(false);
	});
});

describe('TrendLabelEnum', () => {
	it('全トレンドラベルを受け入れる', () => {
		const labels = [
			'strong_uptrend',
			'uptrend',
			'strong_downtrend',
			'downtrend',
			'overbought',
			'oversold',
			'sideways',
			'insufficient_data',
		];
		for (const l of labels) {
			expect(TrendLabelEnum.parse(l)).toBe(l);
		}
	});
});

describe('NumericSeriesSchema', () => {
	it('値の水準の桁（最低 2 桁）で丸める（1,000 以上は小数 2 桁、安い価格ほど桁が増える）', () => {
		const result = NumericSeriesSchema.parse([15_234_567.891, 1234.5678, 1.2345678]);
		expect(result).toEqual([15_234_567.89, 1234.57, 1.23457]);
	});

	it('null を保持する', () => {
		const result = NumericSeriesSchema.parse([1.5, null, 3.0]);
		expect(result).toEqual([1.5, null, 3.0]);
	});

	it('空配列を受け入れる', () => {
		expect(NumericSeriesSchema.parse([])).toEqual([]);
	});
});

describe('CandleSchema', () => {
	it('有効なローソク足を受け入れる', () => {
		const candle = CandleSchema.parse({
			open: 100,
			high: 110,
			low: 90,
			close: 105,
			volume: 1000,
			isoTime: '2024-01-01T00:00:00Z',
		});
		expect(candle.open).toBe(100);
		expect(candle.close).toBe(105);
	});

	it('最小限のフィールドで受け入れる', () => {
		const candle = CandleSchema.parse({ open: 100, high: 110, low: 90, close: 105 });
		expect(candle.open).toBe(100);
	});

	it('OHLC が欠けていると拒否する', () => {
		expect(() => CandleSchema.parse({ open: 100, high: 110, low: 90 })).toThrow();
	});
});
