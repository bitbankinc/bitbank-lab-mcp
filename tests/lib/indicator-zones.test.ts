import { describe, expect, it } from 'vitest';
import {
	bbPosition,
	bbPositionLabel,
	bbWidthState,
	bbZScore,
	rsiZone,
	rsiZoneLabel,
	stochZone,
	stochZoneLabel,
} from '../../lib/indicator-zones.js';

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

describe('bbZScore', () => {
	it('上のバンド上で +2、下のバンド上で -2、中心で 0（σ 単位）', () => {
		expect(bbZScore(110, 100, 110, 90)).toBe(2);
		expect(bbZScore(90, 100, 110, 90)).toBe(-2);
		expect(bbZScore(100, 100, 110, 90)).toBe(0);
		expect(bbZScore(105, 100, 110, 90)).toBe(1);
	});

	it('欠損やバンド幅 0 は null', () => {
		expect(bbZScore(null, 100, 110, 90)).toBeNull();
		expect(bbZScore(100, 100, 100, 100)).toBeNull();
		expect(bbZScore(100, 100, 90, 110)).toBeNull();
	});
});

describe('bbPosition', () => {
	it.each([
		[-2.5, 'at_lower'],
		[-2, 'at_lower'],
		[-1.99, 'lower_zone'],
		[-1.01, 'lower_zone'],
		[-1, 'near_middle'],
		[0, 'near_middle'],
		[1, 'near_middle'],
		[1.01, 'upper_zone'],
		[1.99, 'upper_zone'],
		[2, 'at_upper'],
	] as const)('%s → %s', (z, position) => {
		expect(bbPosition(z)).toBe(position);
	});

	it('null は null、ラベルに σ の範囲を入れる', () => {
		expect(bbPosition(null)).toBeNull();
		expect(bbPositionLabel('at_upper')).toBe('買われすぎ圏（+2σ以上）');
		expect(bbPositionLabel('near_middle')).toBe('中心付近（±1σ以内）');
	});
});

describe('bbWidthState', () => {
	it.each([
		[8, 'squeeze'],
		[8.01, 'normal'],
		[18, 'normal'],
		[18.01, 'expanding'],
		[30, 'expanding'],
		[30.01, 'wide'],
	] as const)('%s%% → %s', (pct, state) => {
		expect(bbWidthState(pct)).toBe(state);
	});

	it('幅が取れないときは squeeze にせず null', () => {
		expect(bbWidthState(null)).toBeNull();
		expect(bbWidthState(Number.NaN)).toBeNull();
	});
});
