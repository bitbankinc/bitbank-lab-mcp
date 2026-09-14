/**
 * tests/patterns/bar-thresholds.test.ts
 *
 * `patterns/bar-thresholds.ts`（日数閾値 → バー数の換算）の契約テスト。
 *
 * 検証するのは 3 点:
 *   1. clamp の両端（構造的下限 / 上限）が実際に効いていること
 *   2. `PATTERN_BARS_CAP_MULTIPLIER` が「既定 limit=90 で全組み合わせが到達可能」を
 *      満たす唯一の整数倍率であること（1 は clamp が潰れ、3 以上は flag / pennant が届かない）
 *   3. 最大側が最小側を下回らないこと（反転するとそのパターン種別が丸ごと 0 件になる）
 */
import { describe, expect, it } from 'vitest';
import { CandleTypeEnum } from '../../src/schema/base.js';
import {
	cappedBarsForDays,
	PATTERN_BARS_CAP_MULTIPLIER,
	patternBarRange,
	patternBarsCap,
	patternMinBars,
	structuralFloorBars,
} from '../../tools/patterns/bar-thresholds.js';
import { getDefaultParamsForTf } from '../../tools/patterns/config.js';
import { barsPerDay } from '../../tools/patterns/helpers.js';
import { assessScanWindow } from '../../tools/patterns/scan-window.js';

const ALL_TIMEFRAMES = CandleTypeEnum.options;

describe('structuralFloorBars', () => {
	it('assessScanWindow の minViableLimit と一致する（二重定義を作らない）', () => {
		for (const tf of ALL_TIMEFRAMES) {
			const { swingDepth, minBarsBetweenSwings } = getDefaultParamsForTf(tf);
			expect(structuralFloorBars(tf), tf).toBe(assessScanWindow(0, swingDepth, minBarsBetweenSwings).minViableLimit);
		}
	});

	it('全時間足で正の整数を返し、時間足が長いほど大きい', () => {
		let prev = 0;
		for (const tf of ALL_TIMEFRAMES) {
			const floor = structuralFloorBars(tf);
			expect(Number.isInteger(floor), `${tf}: ${floor}`).toBe(true);
			expect(floor, tf).toBeGreaterThan(0);
			// CandleTypeEnum は 1min → 1month の昇順
			expect(floor, `${tf}: 時間足が長いのに下限が小さい`).toBeGreaterThanOrEqual(prev);
			prev = floor;
		}
	});

	it('未知の時間足は barsPerDay と同じく 1day 相当にフォールバックする', () => {
		expect(structuralFloorBars('7hour')).toBe(structuralFloorBars('1day'));
		expect(patternBarsCap('7hour')).toBe(patternBarsCap('1day'));
	});
});

describe('PATTERN_BARS_CAP_MULTIPLIER', () => {
	it('2 である', () => {
		expect(PATTERN_BARS_CAP_MULTIPLIER).toBe(2);
		for (const tf of ALL_TIMEFRAMES) {
			expect(patternBarsCap(tf), tf).toBe(structuralFloorBars(tf) * 2);
		}
	});

	it('1 では clamp が潰れる（日数換算値が 1 つも生き残らない）', () => {
		// 上限 = 下限になると、どの日数を渡しても結果は構造的下限そのものになる。
		for (const tf of ALL_TIMEFRAMES) {
			const floor = structuralFloorBars(tf);
			for (const days of [1, 21, 25, 90]) {
				expect(Math.min(floor * 1, Math.max(floor, Math.round(days * barsPerDay(tf)))), `${tf} / ${days}日`).toBe(
					floor,
				);
			}
		}
	});

	it('3 以上では flag / pennant が既定 limit（90 本）に届かなくなる', () => {
		// flag / pennant の要求本数は poleMinBars + consMinBars + 1。
		// 旗竿 1 日 / 保ち合い 2 日を換算した値が両方とも上限に張り付く時間足
		// （15min / 30min）で、倍率 3 だと 3 × 17 × 2 + 1 = 103 本 > 90 本になる。
		const requiredAt = (tf: string, multiplier: number): number => {
			const cap = structuralFloorBars(tf) * multiplier;
			const pole = Math.min(cap, Math.max(2, Math.round(1 * barsPerDay(tf))));
			const cons = Math.min(cap, Math.max(3, Math.round(2 * barsPerDay(tf))));
			return pole + cons + 1;
		};
		for (const tf of ['15min', '30min']) {
			expect(requiredAt(tf, 2), `${tf}: 倍率 2`).toBeLessThanOrEqual(90);
			expect(requiredAt(tf, 3), `${tf}: 倍率 3`).toBeGreaterThan(90);
		}
	});
});

describe('patternMinBars', () => {
	it('日数換算値がレンジ内ならそのまま返す', () => {
		// 1day の 25 日窓は [23, 46] の内側なので 25 のまま
		expect(patternMinBars('1day', 25)).toBe(25);
		// 12hour の 21 日 = 42 本は上限ちょうど
		expect(patternMinBars('12hour', 21)).toBe(42);
	});

	it('小さすぎる日数換算値は構造的下限に持ち上がる（1week / 1month）', () => {
		expect(Math.round(21 * barsPerDay('1week'))).toBe(3);
		expect(patternMinBars('1week', 21)).toBe(structuralFloorBars('1week'));
		expect(patternMinBars('1month', 21)).toBe(structuralFloorBars('1month'));
	});

	it('大きすぎる日数換算値は上限で頭打ちになる（intraday）', () => {
		expect(Math.round(21 * barsPerDay('1hour'))).toBe(504);
		expect(patternMinBars('1hour', 21)).toBe(patternBarsCap('1hour'));
		expect(patternMinBars('1min', 21)).toBe(patternBarsCap('1min'));
	});

	it('全時間足・代表的な日数で [構造的下限, 上限] に収まる整数を返す', () => {
		for (const tf of ALL_TIMEFRAMES) {
			for (const days of [0, 1, 2, 15, 20, 21, 25, 90, 120]) {
				const bars = patternMinBars(tf, days);
				expect(Number.isInteger(bars), `${tf} / ${days}日: ${bars}`).toBe(true);
				expect(bars, `${tf} / ${days}日`).toBeGreaterThanOrEqual(structuralFloorBars(tf));
				expect(bars, `${tf} / ${days}日`).toBeLessThanOrEqual(patternBarsCap(tf));
			}
		}
	});

	it('日数に対して単調非減少', () => {
		for (const tf of ALL_TIMEFRAMES) {
			let prev = 0;
			for (let days = 0; days <= 120; days += 5) {
				const bars = patternMinBars(tf, days);
				expect(bars, `${tf} / ${days}日`).toBeGreaterThanOrEqual(prev);
				prev = bars;
			}
		}
	});
});

describe('patternBarRange', () => {
	it('最大側が最小側を必ず上回る（反転するとその種別が 0 件になる）', () => {
		const ranges: Array<[number, number]> = [
			[21, 90], // detect_triples の形成中
			[25, 90], // detect_wedges の完成済み窓
			[20, 120], // detect_wedges の形成中窓
		];
		for (const tf of ALL_TIMEFRAMES) {
			for (const [minDays, maxDays] of ranges) {
				const { minBars, maxBars } = patternBarRange(tf, minDays, maxDays);
				expect(maxBars, `${tf} / ${minDays}-${maxDays}日`).toBeGreaterThan(minBars);
			}
		}
	});

	it('bar 空間でも日数比を保つ', () => {
		// 1day は clamp が効かないので日数そのまま
		expect(patternBarRange('1day', 25, 90)).toEqual({ minBars: 25, maxBars: 90 });
		// 1month は下限クランプ（29 本）。上限も同じ比 90/25 = 3.6 でスケールする
		const m = patternBarRange('1month', 25, 90);
		expect(m.minBars).toBe(29);
		expect(m.maxBars).toBe(Math.round(29 * (90 / 25)));
	});

	it('最大側は上限（cap）を意図的に超える — cap は最小側だけの制約', () => {
		// cap の役割は「最小要求バー数が既定 limit（90）に収まること」だけ。最大側にも掛けると
		// cap が効く時間足で minBars === maxBars になり、レンジ判定が等値判定に退化する。
		for (const tf of ['1hour', '4hour']) {
			const { minBars, maxBars } = patternBarRange(tf, 21, 90);
			expect(minBars, `${tf}: 最小側は cap に張り付く`).toBe(patternBarsCap(tf));
			expect(maxBars, `${tf}: 最大側は cap を超える（意図的）`).toBeGreaterThan(patternBarsCap(tf));
		}
		// cap が効かない 1day では、本モジュール導入前と同じ [25, 90] のまま
		expect(patternBarRange('1day', 25, 90)).toEqual({ minBars: 25, maxBars: 90 });
		expect(patternBarsCap('1day')).toBe(46); // cap を最大側に掛けると 90 → 46 に狭まってしまう
	});

	it('minDays === maxDays でも最小 1 本の幅を持つ', () => {
		const { minBars, maxBars } = patternBarRange('1day', 25, 25);
		expect(minBars).toBe(25);
		expect(maxBars).toBe(26);
	});

	it('不正なレンジは RangeError', () => {
		expect(() => patternBarRange('1day', 0, 90)).toThrow(RangeError);
		expect(() => patternBarRange('1day', -1, 90)).toThrow(RangeError);
		expect(() => patternBarRange('1day', 90, 25)).toThrow(RangeError);
		expect(() => patternBarRange('1day', Number.NaN, 90)).toThrow(RangeError);
	});
});

describe('cappedBarsForDays', () => {
	it('構造的下限は適用しない（絶対下限だけを使う）', () => {
		// 旗竿 1 日 = 1day で 1 本 → 絶対下限 2 本。構造的下限（23 本）には持ち上がらない。
		expect(cappedBarsForDays('1day', 1, 2)).toBe(2);
		expect(structuralFloorBars('1day')).toBe(23);
	});

	it('上限は patternMinBars と同じ（構造的下限 × 倍率）', () => {
		expect(cappedBarsForDays('1min', 1, 2)).toBe(patternBarsCap('1min'));
		expect(cappedBarsForDays('15min', 2, 3)).toBe(patternBarsCap('15min'));
	});

	it('レンジ内の日数換算値はそのまま返す', () => {
		// 4hour の旗竿 1 日 = 6 本（絶対下限 2 と上限 42 の内側）
		expect(cappedBarsForDays('4hour', 1, 2)).toBe(6);
		expect(cappedBarsForDays('4hour', 2, 3)).toBe(12);
	});
});
