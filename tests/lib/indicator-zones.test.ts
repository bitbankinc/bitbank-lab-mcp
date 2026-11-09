import { describe, expect, it } from 'vitest';
import { rsiZone, rsiZoneLabel, stochZone, stochZoneLabel } from '../../lib/indicator-zones.js';

describe('rsiZone', () => {
	it.each([
		[0, 'oversold'],
		[30, 'oversold'],
		[30.01, 'below_midline'],
		[49.99, 'below_midline'],
		[50, 'above_midline'],
		[69.99, 'above_midline'],
		[70, 'overbought'],
		[100, 'overbought'],
	] as const)('%s → %s', (rsi, zone) => {
		expect(rsiZone(rsi)).toBe(zone);
	});

	it('null / undefined / NaN は null', () => {
		expect(rsiZone(null)).toBeNull();
		expect(rsiZone(undefined)).toBeNull();
		expect(rsiZone(Number.NaN)).toBeNull();
		expect(rsiZoneLabel(null)).toBeNull();
	});

	it('ラベルに先の値動きを示す言葉を入れない', () => {
		for (const rsi of [10, 40, 60, 90]) {
			expect(rsiZoneLabel(rsi)).not.toMatch(/反発|反落|可能性|余地/);
		}
		expect(rsiZoneLabel(37)).toBe('中立圏（50未満）');
	});
});

describe('stochZone', () => {
	it.each([
		[20, 'oversold'],
		[20.01, 'neutral'],
		[79.99, 'neutral'],
		[80, 'overbought'],
	] as const)('%s → %s', (k, zone) => {
		expect(stochZone(k)).toBe(zone);
	});

	it('null は null、ラベルは境界を含む書き方にする', () => {
		expect(stochZone(null)).toBeNull();
		expect(stochZoneLabel('overbought')).toBe('買われすぎ圏（80以上）');
		expect(stochZoneLabel('oversold')).toBe('売られすぎ圏（20以下）');
	});
});
