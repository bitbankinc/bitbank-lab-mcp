/**
 * tools/patterns/period.ts — スキャン範囲 / 検出パターン分布期間の行ビルダー。
 *
 * 「検出対象期間」という旧ラベルがスキャン窓を指しているように読め、
 * 「1時間足で直近1日分がスキャンされていない」という誤読を招いた。
 * 本テストは 2 行が別の量として出ること、intraday で時刻が落ちないことを固定する。
 */
import { describe, expect, it } from 'vitest';
import {
	buildPatternSpanLine,
	buildPeriodBlock,
	buildScanRange,
	buildScanRangeLine,
	isIntradayType,
	type ScanRange,
} from '../../tools/patterns/period.js';

// timezone-sensitive な timestamp（23:30Z 系）:
//   2026-10-01T23:30:00.000Z → JST: 2026-10-02 08:30 / UTC: 2026-10-01 23:30
const START_UTC_LATE = '2026-10-01T23:30:00.000Z';
const END_UTC_LATE = '2026-10-10T23:30:00.000Z';

const pat = (start: string, end: string) => ({ range: { start, end } });

// ── isIntradayType ──

describe('isIntradayType', () => {
	it.each(['1min', '5min', '15min', '30min', '1hour', '4hour', '8hour', '12hour'])('%s は intraday', (type) => {
		expect(isIntradayType(type)).toBe(true);
	});

	it.each(['1day', '1week', '1month'])('%s は intraday ではない', (type) => {
		expect(isIntradayType(type)).toBe(false);
	});

	it('未知の時間足は intraday ではない（時刻を勝手に出さない）', () => {
		expect(isIntradayType('unknown')).toBe(false);
	});
});

// ── buildScanRange ──

describe('buildScanRange', () => {
	it('先頭足・末尾足・本数を返す', () => {
		const candles = [
			{ isoTime: '2026-08-05T07:00:00.000Z' },
			{ isoTime: '2026-08-05T08:00:00.000Z' },
			{ isoTime: '2026-08-05T09:00:00.000Z' },
		];
		expect(buildScanRange(candles)).toEqual({
			start: '2026-08-05T07:00:00.000Z',
			end: '2026-08-05T09:00:00.000Z',
			bars: 3,
		});
	});

	it('空配列のとき undefined', () => {
		expect(buildScanRange([])).toBeUndefined();
	});

	it('undefined のとき undefined', () => {
		expect(buildScanRange(undefined)).toBeUndefined();
	});

	it('単一要素のとき start === end / bars=1', () => {
		expect(buildScanRange([{ isoTime: '2026-08-05T07:00:00.000Z' }])).toEqual({
			start: '2026-08-05T07:00:00.000Z',
			end: '2026-08-05T07:00:00.000Z',
			bars: 1,
		});
	});

	it('isoTime が null / 欠損のときは推測せず undefined', () => {
		expect(buildScanRange([{ isoTime: null }, { isoTime: '2026-08-05T08:00:00.000Z' }])).toBeUndefined();
		expect(buildScanRange([{ isoTime: '2026-08-05T07:00:00.000Z' }, {}])).toBeUndefined();
	});
});

// ── buildScanRangeLine ──

describe('buildScanRangeLine', () => {
	const scan: ScanRange = { start: '2026-08-05T07:00:00.000Z', end: '2026-08-21T21:00:00.000Z', bars: 399 };

	it('intraday（1hour）は時刻まで出す — 誤読の直接原因だったので暦日に丸めない', () => {
		expect(buildScanRangeLine(scan, '1hour', 'UTC')).toBe('スキャン範囲: 2026-08-05 07:00 ~ 2026-08-21 21:00（399本）');
	});

	it('intraday（4hour / 12hour）も時刻まで出す', () => {
		expect(buildScanRangeLine(scan, '4hour', 'UTC')).toContain('07:00 ~ 2026-08-21 21:00');
		expect(buildScanRangeLine(scan, '12hour', 'UTC')).toContain('07:00 ~ 2026-08-21 21:00');
	});

	it('日足以上は暦日のみ', () => {
		expect(buildScanRangeLine(scan, '1day', 'UTC')).toBe('スキャン範囲: 2026-08-05 ~ 2026-08-21（399本）');
	});

	it('tz 既定（Asia/Tokyo）で JST の日時を表示する', () => {
		// 07:00Z → JST 16:00、21:00Z → 翌日 JST 06:00
		expect(buildScanRangeLine(scan, '1hour')).toBe('スキャン範囲: 2026-08-05 16:00 ~ 2026-08-22 06:00（399本）');
	});

	it("tz='' は Asia/Tokyo にフォールバックする", () => {
		expect(buildScanRangeLine(scan, '1hour', '')).toBe(buildScanRangeLine(scan, '1hour', 'Asia/Tokyo'));
	});

	it('scan が undefined / null のとき空文字', () => {
		expect(buildScanRangeLine(undefined, '1hour')).toBe('');
		expect(buildScanRangeLine(null, '1hour')).toBe('');
	});

	it('start / end が無効日時のとき空文字', () => {
		expect(buildScanRangeLine({ start: 'invalid', end: 'also-invalid', bars: 3 }, '1hour')).toBe('');
	});

	it('bars=1（最小）でも本数を出す', () => {
		const one: ScanRange = { start: START_UTC_LATE, end: START_UTC_LATE, bars: 1 };
		expect(buildScanRangeLine(one, '1day', 'UTC')).toBe('スキャン範囲: 2026-10-01 ~ 2026-10-01（1本）');
	});
});

// ── buildPatternSpanLine ──

describe('buildPatternSpanLine', () => {
	it('ラベルは「検出パターン分布期間」— スキャン窓ではないことを名前で示す', () => {
		const line = buildPatternSpanLine([pat('2026-01-01T00:00:00.000Z', '2026-01-20T00:00:00.000Z')], 'UTC');
		expect(line).toBe('検出パターン分布期間: 2026-01-01 ~ 2026-01-20（19日間）');
		expect(line).not.toContain('検出対象期間');
	});

	it('複数パターンでは最古 start ~ 最新 end を張る', () => {
		const pats = [
			pat('2026-01-05T00:00:00.000Z', '2026-01-10T00:00:00.000Z'),
			pat('2026-01-01T00:00:00.000Z', '2026-01-20T00:00:00.000Z'),
			pat('2026-01-03T00:00:00.000Z', '2026-01-15T00:00:00.000Z'),
		];
		expect(buildPatternSpanLine(pats, 'UTC')).toBe('検出パターン分布期間: 2026-01-01 ~ 2026-01-20（19日間）');
	});

	it('空配列のとき空文字を返す', () => {
		expect(buildPatternSpanLine([])).toBe('');
	});

	it('range が undefined のとき空文字を返す', () => {
		expect(buildPatternSpanLine([{}])).toBe('');
	});

	it('range.start/end が無効日時のとき空文字を返す', () => {
		expect(buildPatternSpanLine([pat('invalid', 'also-invalid')])).toBe('');
	});

	it('start === end でも 1日間として出す（0日間にしない）', () => {
		expect(buildPatternSpanLine([pat(START_UTC_LATE, START_UTC_LATE)], 'UTC')).toContain('（1日間）');
	});

	it('tz 既定（Asia/Tokyo）で JST 暦日を表示する', () => {
		const line = buildPatternSpanLine([pat(START_UTC_LATE, END_UTC_LATE)]);
		expect(line).toContain('2026-10-02');
		expect(line).toContain('2026-10-11');
	});

	it("tz='Asia/Tokyo' 明示で JST 暦日を表示する", () => {
		const line = buildPatternSpanLine([pat(START_UTC_LATE, END_UTC_LATE)], 'Asia/Tokyo');
		expect(line).toContain('2026-10-02');
		expect(line).toContain('2026-10-11');
	});

	it("tz='UTC' のとき UTC 暦日を表示する", () => {
		const line = buildPatternSpanLine([pat(START_UTC_LATE, END_UTC_LATE)], 'UTC');
		expect(line).toContain('2026-10-01');
		expect(line).toContain('2026-10-10');
	});

	it("tz='' は Asia/Tokyo にフォールバックする", () => {
		const line = buildPatternSpanLine([pat(START_UTC_LATE, END_UTC_LATE)], '');
		expect(line).toContain('2026-10-02');
		expect(line).toContain('2026-10-11');
	});
});

// ── buildPeriodBlock ──

describe('buildPeriodBlock', () => {
	const scan: ScanRange = { start: '2026-08-05T07:00:00.000Z', end: '2026-08-21T21:00:00.000Z', bars: 399 };
	const pats = [pat('2026-08-05T07:00:00.000Z', '2026-08-19T07:00:00.000Z')];

	it('スキャン範囲 → 検出パターン分布期間 の 2 行を返す', () => {
		expect(buildPeriodBlock(scan, '1hour', pats, 'UTC')).toBe(
			'スキャン範囲: 2026-08-05 07:00 ~ 2026-08-21 21:00（399本）\n検出パターン分布期間: 2026-08-05 ~ 2026-08-19（14日間）',
		);
	});

	it('scan が無いときは分布期間だけを返す（空行を挟まない）', () => {
		expect(buildPeriodBlock(undefined, '1hour', pats, 'UTC')).toBe(
			'検出パターン分布期間: 2026-08-05 ~ 2026-08-19（14日間）',
		);
	});

	it('パターン 0 件でもスキャン範囲は出る（どこまで見たかは常に分かる）', () => {
		expect(buildPeriodBlock(scan, '1day', [], 'UTC')).toBe('スキャン範囲: 2026-08-05 ~ 2026-08-21（399本）');
	});

	it('両方空なら空文字', () => {
		expect(buildPeriodBlock(undefined, '1day', [])).toBe('');
	});
});
