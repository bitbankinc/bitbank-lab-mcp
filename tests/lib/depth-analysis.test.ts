import { describe, expect, it } from 'vitest';
import { estimateZones, toFiniteRawLevels } from '../../lib/depth-analysis.js';

describe('toFiniteRawLevels', () => {
	it('正常な string tuple と "0" を保持する', () => {
		const { rows, dropped } = toFiniteRawLevels([
			['10100', '0.2'],
			['10200', '0'],
		]);
		expect(rows).toHaveLength(2);
		expect(dropped).toBe(0);
	});

	it('数値変換不能な値を含む行は drop する', () => {
		const { rows, dropped } = toFiniteRawLevels([
			['10100', '0.2'],
			['abc', '0.3'],
			['10300', 'NaN'],
		]);
		expect(rows).toEqual([['10100', '0.2']]);
		expect(dropped).toBe(2);
	});

	it('空文字・空白のみ・null は Number() で 0 に化けるが drop する', () => {
		const { rows, dropped } = toFiniteRawLevels([
			['10100', ''],
			[' ', '0.2'],
			[null as unknown as string, '0.3'],
		]);
		expect(rows).toEqual([]);
		expect(dropped).toBe(3);
	});

	it('2 要素配列でない行（オブジェクト・要素数違い）は drop する', () => {
		const { rows, dropped } = toFiniteRawLevels([
			{ 0: '10100', 1: '0.2' } as unknown as [string, string],
			['10100', '0.2', 'extra'] as unknown as [string, string],
			['10200'] as unknown as [string, string],
			['10300', '0.4'],
		]);
		expect(rows).toEqual([['10300', '0.4']]);
		expect(dropped).toBe(3);
	});
});

describe('estimateZones', () => {
	it('空配列は空配列を返す', () => {
		expect(estimateZones([], 'bid')).toEqual([]);
	});

	it('閾値超えのレベルをゾーンとして検出する (bid)', () => {
		// n=10 にすると avg+2σ が外れ値より十分低くなり検出される
		const levels: [number, number][] = [
			[15000000, 0.5],
			[14990000, 0.5],
			[14980000, 0.5],
			[14970000, 0.5],
			[14960000, 0.5],
			[14950000, 0.5],
			[14940000, 0.5],
			[14930000, 0.5],
			[14920000, 0.5],
			[14910000, 100.0], // 大きな壁
		];
		const zones = estimateZones(levels, 'bid');
		expect(zones.length).toBeGreaterThan(0);
		expect(zones[0]).toHaveProperty('label', 'bid wall');
		expect(zones[0]).toHaveProperty('color');
		expect(zones[0].low).toBeLessThan(zones[0].high);
	});

	it('ask 側のゾーンを検出する', () => {
		const levels: [number, number][] = [
			[15100000, 0.5],
			[15110000, 0.5],
			[15120000, 0.5],
			[15130000, 0.5],
			[15140000, 0.5],
			[15150000, 0.5],
			[15160000, 0.5],
			[15170000, 0.5],
			[15180000, 0.5],
			[15190000, 100.0], // 大きな壁
		];
		const zones = estimateZones(levels, 'ask');
		expect(zones.length).toBeGreaterThan(0);
		expect(zones[0]).toHaveProperty('label', 'ask wall');
	});

	it('壁がない場合は空配列を返す', () => {
		const levels: [number, number][] = [
			[15000000, 1.0],
			[14990000, 1.1],
			[14980000, 0.9],
			[14970000, 1.0],
		];
		const zones = estimateZones(levels, 'bid');
		expect(zones).toEqual([]);
	});

	it('最大5個までに制限する', () => {
		// 全て同じ大きなサイズ → stddev = 0 → avg+2*0 = avg → 全て >= thr
		const levels: [number, number][] = Array.from({ length: 10 }, (_, i) => [15000000 - i * 10000, 100.0]);
		const zones = estimateZones(levels, 'bid');
		expect(zones.length).toBeLessThanOrEqual(5);
	});
});
