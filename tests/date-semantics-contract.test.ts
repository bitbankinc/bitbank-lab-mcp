// 同じ `date: 'YYYYMMDD'` でも、get_transactions / get_flow_metrics は UTC 暦日、get_candles / validate_candle_data は tz 引数の暦日（既定 Asia/Tokyo）。基準をツールではなくパラメータの description に書くことを契約として固定する。
import { describe, expect, it } from 'vitest';
import { toolDef as getCandlesDef } from '../tools/get_candles.js';
import { toolDef as getFlowMetricsDef } from '../tools/get_flow_metrics.js';
import { toolDef as getTransactionsDef } from '../tools/get_transactions.js';
import { toolDef as validateCandleDataDef } from '../tools/validate_candle_data.js';

function dateDescription(inputSchema: unknown): string {
	const shape = (inputSchema as { shape?: Record<string, { description?: string }> })?.shape;
	const desc = shape?.date?.description;
	if (typeof desc !== 'string' || desc.length === 0) {
		throw new Error('date パラメータに description がありません');
	}
	return desc;
}

describe('date パラメータの暦基準が description に明記されている', () => {
	const utcBased = [
		{ name: 'get_transactions', def: getTransactionsDef },
		{ name: 'get_flow_metrics', def: getFlowMetricsDef },
	];
	const tzBased = [
		{ name: 'get_candles', def: getCandlesDef },
		{ name: 'validate_candle_data', def: validateCandleDataDef },
	];

	for (const { name, def } of utcBased) {
		it(`${name}: UTC 暦日であることと、tz 暦日系との違いが書かれている`, () => {
			const desc = dateDescription(def.inputSchema);
			expect(desc).toContain('UTC 暦日');
			// 他方の基準への言及がないと「どちらの暦か」を能動的に確認できない
			expect(desc).toMatch(/get_candles|tz/);
		});
	}

	for (const { name, def } of tzBased) {
		it(`${name}: tz 暦日であることと、UTC 暦日系との違いが書かれている`, () => {
			const desc = dateDescription(def.inputSchema);
			expect(desc).toContain('tz');
			expect(desc).toContain('暦日');
			expect(desc).toMatch(/get_transactions|get_flow_metrics|UTC 暦日/);
		});
	}

	it('get_flow_metrics: date が当該 UTC 日の全件を集計する（limit 非適用）ことが書かれている', () => {
		const desc = dateDescription(getFlowMetricsDef.inputSchema);
		expect(desc).toContain('全件');
		expect(desc).toContain('limit は適用しません');
		expect(desc).not.toMatch(/カバーできません/);
	});

	it('get_flow_metrics: date でも since/until が必要なケースへの誘導が残っている', () => {
		// 複数日にまたがる区間や UTC 暦日の境界に揃わない区間（JST の 1 日など）は date では表現できないので、誘導を落とすと LLM が date で代用しようとする。
		const desc = dateDescription(getFlowMetricsDef.inputSchema);
		expect(desc).toContain('since/until');
		expect(desc).toMatch(/複数日|境界/);
	});

	it('get_flow_metrics: limit が件数ベース取得でのみ有効であることが書かれている', () => {
		// 区間指定パラメータ（date / hours / since・until）はいずれも limit を適用しないので、limit の適用範囲が description から読めないと date + limit で少数サンプルを取ろうとする。
		const shape = (getFlowMetricsDef.inputSchema as { shape?: Record<string, { description?: string }> })?.shape;
		const desc = shape?.limit?.description ?? '';
		expect(desc).toContain('件数ベース取得');
		expect(desc).toMatch(/date \/ hours \/ since・until/);
	});
});
