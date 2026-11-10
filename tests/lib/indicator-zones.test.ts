import { describe, expect, it } from 'vitest';
import {
	bbPosition,
	bbPositionLabel,
	bbWidthRank,
	bbWidthState,
	bbWidthStateLabel,
	bbZScore,
	indicatorZones,
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

describe('bbWidthRank / bbWidthState', () => {
	const bands = (widthsPct: number[]) => ({
		upper: widthsPct.map((w) => 100 + w / 2),
		middle: widthsPct.map(() => 100),
		lower: widthsPct.map((w) => 100 - w / 2),
	});

	it('最新の幅が直近の窓の中で下から何 % かを返す（同じ値は半分ずつ数える）', () => {
		const b = bands([...Array.from({ length: 29 }, (_, i) => i + 1), 10]);
		const rank = bbWidthRank(b.upper, b.middle, b.lower);
		// 30 本中、10 より小さいのが 9 本、10 と等しいのが自分を含めて 2 本
		expect(rank?.sampleSize).toBe(30);
		expect(rank?.percentile).toBeCloseTo(((9 + 1) / 30) * 100, 6);
	});

	it('幅がずっと一定なら 50%', () => {
		const b = bands(Array.from({ length: 40 }, () => 8));
		expect(bbWidthRank(b.upper, b.middle, b.lower)?.percentile).toBe(50);
	});

	it('窓は直近 window 本だけ見る', () => {
		const b = bands([...Array.from({ length: 50 }, () => 100), ...Array.from({ length: 30 }, (_, i) => i + 1)]);
		const rank = bbWidthRank(b.upper, b.middle, b.lower, 30);
		expect(rank?.sampleSize).toBe(30);
		expect(rank?.percentile).toBeCloseTo((29.5 / 30) * 100, 6);
	});

	it('最新の足が欠けているか、有効な幅が BB の期間（20 本）に満たなければ null', () => {
		const short = bands(Array.from({ length: 19 }, () => 8));
		expect(bbWidthRank(short.upper, short.middle, short.lower)).toBeNull();
		const b = bands(Array.from({ length: 40 }, () => 8));
		expect(bbWidthRank([...b.upper, null], [...b.middle, 100], [...b.lower, 99])).toBeNull();
		expect(bbWidthState(null)).toBeNull();
	});

	it.each([
		[19.99, 'squeeze'],
		[20, 'normal'],
		[79.99, 'normal'],
		[80, 'expanding'],
		[94.99, 'expanding'],
		[95, 'wide'],
	] as const)('下から %s%% → %s', (percentile, state) => {
		expect(bbWidthState({ percentile, sampleSize: 120 })).toBe(state);
	});

	it('ラベルに窓の本数と順位を入れる', () => {
		expect(bbWidthStateLabel('squeeze', { percentile: 12.4, sampleSize: 120 })).toBe(
			'スクイーズ（直近120本の幅の中で下から12%）',
		);
	});
});

describe('indicatorZones', () => {
	it('各指標の判定をまとめて返し、取れない指標は null', () => {
		const series = Array.from({ length: 40 }, () => 100);
		expect(
			indicatorZones({
				close: 110,
				rsi: 72,
				stochRsiK: 15,
				bbMiddle: 100,
				bbUpper: 110,
				bbLower: 90,
				bbSeries: { upper: series.map((v) => v + 10), middle: series, lower: series.map((v) => v - 10) },
			}),
		).toEqual({ rsi: 'overbought', stochRsi: 'oversold', bbPosition: 'at_upper', bbWidth: 'normal' });
		expect(
			indicatorZones({
				close: null,
				rsi: null,
				stochRsiK: null,
				bbMiddle: null,
				bbUpper: null,
				bbLower: null,
				bbSeries: null,
			}),
		).toEqual({ rsi: null, stochRsi: null, bbPosition: null, bbWidth: null });
	});
});
