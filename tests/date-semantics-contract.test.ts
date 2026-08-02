/**
 * date パラメータの暦基準の契約テスト
 *
 * 同じ `date: 'YYYYMMDD'` という名前でも、ツールによって基準となる暦が異なる。
 *
 *   - get_transactions / get_flow_metrics → **UTC 暦日**
 *     （bitbank の約定アーカイブ /transactions/{YYYYMMDD} が UTC 暦日単位のため）
 *   - get_candles / validate_candle_data → **tz 引数の暦日**（既定 Asia/Tokyo）
 *
 * 基準が description に書かれていないと、LLM は片方の基準で他方を呼んで無言でズレる
 * （実測: get_candles(date=20260801) を既定 tz で呼ぶと JST 8/1 23:59 = 8/1 14:59 UTC で
 * 打ち切られ、16:44 UTC の足が範囲外になる）。ツール本体の description ではなく
 * **パラメータの description** に書くことを契約として固定する。
 */
import { describe, expect, it } from 'vitest';
import { toolDef as getCandlesDef } from '../tools/get_candles.js';
import { toolDef as getFlowMetricsDef } from '../tools/get_flow_metrics.js';
import { toolDef as getTransactionsDef } from '../tools/get_transactions.js';
import { toolDef as validateCandleDataDef } from '../tools/validate_candle_data.js';

/** inputSchema の date フィールドの description を取り出す */
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

	it('get_flow_metrics: date では 1 UTC 日全体をカバーできないことが書かれている', () => {
		// limit 上限 2000 < 1 UTC 日の約定数（BTC/JPY 5,600〜8,000 件）のため、
		// date 指定は最新側に切り詰められる。切り捨てなく 1 日を集計できる代替手段
		// （since/until の絶対区間指定）への誘導まで含めて明記する。
		const desc = dateDescription(getFlowMetricsDef.inputSchema);
		expect(desc).toContain('since/until');
		expect(desc).toMatch(/カバーできません|1 日全体/);
	});
});
