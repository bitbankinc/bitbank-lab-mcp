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

	it('get_flow_metrics: date が当該 UTC 日の全件を集計する（limit 非適用）ことが書かれている', () => {
		// 以前は「limit 上限 2000 < 1 UTC 日の約定数のため 1 日全体をカバーできない」という
		// **自分の欠陥を回避手段で説明する** description だった。date は limit を適用しなく
		// なったので、まず何をするかを書く。
		const desc = dateDescription(getFlowMetricsDef.inputSchema);
		expect(desc).toContain('全件');
		expect(desc).toContain('limit は適用しません');
		expect(desc).not.toMatch(/カバーできません/);
	});

	it('get_flow_metrics: date でも since/until が必要なケースへの誘導が残っている', () => {
		// 複数日にまたがる区間や、UTC 暦日の境界に揃わない区間（JST の 1 日など）は
		// date では表現できない。誘導を落とすと LLM が date で代用しようとする。
		const desc = dateDescription(getFlowMetricsDef.inputSchema);
		expect(desc).toContain('since/until');
		expect(desc).toMatch(/複数日|境界/);
	});

	it('get_flow_metrics: limit が件数ベース取得でのみ有効であることが書かれている', () => {
		// 区間指定パラメータ（date / hours / since・until）はいずれも limit を適用しない。
		// limit の適用範囲が description から読めないと、date + limit で少数サンプルを
		// 取ろうとする（旧挙動では実際にそう動いていた）。
		const shape = (getFlowMetricsDef.inputSchema as { shape?: Record<string, { description?: string }> })?.shape;
		const desc = shape?.limit?.description ?? '';
		expect(desc).toContain('件数ベース取得');
		expect(desc).toMatch(/date \/ hours \/ since・until/);
	});
});
