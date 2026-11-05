import { describe, expect, it } from 'vitest';
import { DetectedPatternSchema, TargetProgressOmittedReasonEnum } from '../../src/schema/patterns.js';
import {
	computeTargetReach,
	formatTargetProgressLine,
	MIN_TARGET_DISTANCE_HEIGHT_RATIO,
	omittedTargetReach,
	TARGET_REACH_MAX_BARS,
	TARGET_REACHED_PCT_CAP,
	type TargetReachInfo,
	type TargetReachOmissionReason,
	type TargetReachResult,
	targetReachFields,
} from '../../tools/patterns/target-reach.js';
import type { CandleData } from '../../tools/patterns/types.js';

function c(high: number, low: number, close: number, iso?: string): CandleData {
	return { open: close, high, low, close, isoTime: iso ?? '2026-01-01T00:00:00.000Z' };
}

function measured(r: TargetReachResult): TargetReachInfo {
	expect(r.kind).toBe('measured');
	return r as TargetReachInfo;
}

/** 単一ソース（Zod enum）から導出せず `satisfies` で突き合わせる。導出すると「網羅している」が自明になり、網羅テストが空虚に通る。 */
const ALL_OMISSION_REASONS = [
	'not_broken_out',
	'no_target',
	'breakout_against_expectation',
	'invalid_breakout_price',
	'no_bars_after_breakout',
	'degenerate_target_distance',
	'not_computed_by_detector',
] as const satisfies readonly TargetReachOmissionReason[];
type ListedReason = (typeof ALL_OMISSION_REASONS)[number];
// 逆向き（ユニオン → 配列）の包含。片方向だけだと配列に足りない値を見逃す。
const _exhaustive: ListedReason = null as unknown as TargetReachOmissionReason;
void _exhaustive;

describe('computeTargetReach', () => {
	it('direction=down: 最安 low が target を割り込む → reached=true, pct>=100', () => {
		// breakoutPrice=100, target=80, idx=2 で low=70 (<= target) → 到達
		const candles = [
			c(105, 95, 100, 'iso-0'),
			c(105, 90, 100, 'iso-1'),
			c(95, 70, 90, 'iso-2'),
			c(100, 85, 95, 'iso-3'),
		];
		const r = measured(computeTargetReach(candles, 0, 100, 80, 'down', 20));
		expect(r.targetReached).toBe(true);
		expect(r.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(r.targetReachedPrice).toBe(70);
		expect(r.targetReachedDate).toBe('iso-2');
	});

	it('direction=down: 一度到達後に close が戻っても最安 low ベースで到達扱い', () => {
		// breakoutPrice=100, target=80, idx=1 で low=75（到達） / idx=3 で close=100 へ戻し
		const candles = [
			c(102, 99, 100, 'iso-0'),
			c(95, 75, 90, 'iso-1'),
			c(110, 92, 105, 'iso-2'),
			c(115, 99, 110, 'iso-3'),
		];
		const r = measured(computeTargetReach(candles, 0, 100, 80, 'down', 20));
		expect(r.targetReached).toBe(true);
		expect(r.targetReachedPrice).toBe(75);
		expect(r.targetReachedDate).toBe('iso-1');
	});

	it('direction=down: ブレイク close が既に target を下回る（オーバーシュート）→ reached=true & pct>=100', () => {
		// breakoutPrice=70, target=80 → 既に到達済み
		const candles = [c(72, 65, 70, 'iso-0'), c(75, 60, 70, 'iso-1')];
		const r = measured(computeTargetReach(candles, 0, 70, 80, 'down', 10));
		expect(r.targetReached).toBe(true);
		expect(r.targetReachedPct).toBeGreaterThanOrEqual(100);
	});

	it('direction=down: low が target に届かない → reached=false, pct<100', () => {
		// breakoutPrice=100, target=50, 最安 low=90 → moveDistance=10, distance=50, pct=20
		const candles = [c(102, 100, 100, 'iso-0'), c(101, 90, 99, 'iso-1')];
		const r = measured(computeTargetReach(candles, 0, 100, 50, 'down', 50));
		expect(r.targetReached).toBe(false);
		expect(r.targetReachedPct).toBe(20);
		expect(r.targetReachedPrice).toBe(90);
	});

	it('direction=up: 最高 high が target を超える → reached=true, pct>=100', () => {
		// breakoutPrice=100, target=120, idx=2 で high=130 (>= target) → 到達
		const candles = [c(102, 98, 100, 'iso-0'), c(110, 100, 108, 'iso-1'), c(130, 115, 125, 'iso-2')];
		const r = measured(computeTargetReach(candles, 0, 100, 120, 'up', 20));
		expect(r.targetReached).toBe(true);
		expect(r.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(r.targetReachedPrice).toBe(130);
		expect(r.targetReachedDate).toBe('iso-2');
	});

	it('direction=up: 一度到達後に close が戻っても最高 high ベースで到達扱い', () => {
		// breakoutPrice=100, target=120, idx=1 で high=125（到達） / idx=2 で close=100 へ戻し
		const candles = [c(101, 99, 100, 'iso-0'), c(125, 100, 122, 'iso-1'), c(105, 95, 100, 'iso-2')];
		const r = measured(computeTargetReach(candles, 0, 100, 120, 'up', 20));
		expect(r.targetReached).toBe(true);
		expect(r.targetReachedPrice).toBe(125);
		expect(r.targetReachedDate).toBe('iso-1');
	});

	it('direction=up: ブレイク close が既に target を超える（オーバーシュート）→ reached=true & pct>=100', () => {
		// breakoutPrice=130, target=120 → 既に到達済み
		const candles = [c(135, 125, 130, 'iso-0'), c(140, 128, 135, 'iso-1')];
		const r = measured(computeTargetReach(candles, 0, 130, 120, 'up', 10));
		expect(r.targetReached).toBe(true);
		expect(r.targetReachedPct).toBeGreaterThanOrEqual(100);
	});

	it('direction=up: high が target に届かない → reached=false, pct<100', () => {
		// breakoutPrice=100, target=150, 最高 high=110 → moveDistance=10, distance=50, pct=20
		const candles = [c(105, 98, 100, 'iso-0'), c(110, 100, 108, 'iso-1')];
		const r = measured(computeTargetReach(candles, 0, 100, 150, 'up', 50));
		expect(r.targetReached).toBe(false);
		expect(r.targetReachedPct).toBe(20);
		expect(r.targetReachedPrice).toBe(110);
	});

	// `undefined` は返さない（issue #224 症状 2）。測れない経路は全部 reason を名乗る。

	it('breakoutPrice が NaN → invalid_breakout_price を名乗る', () => {
		const candles = [c(102, 98, 100, 'iso-0')];
		expect(computeTargetReach(candles, 0, Number.NaN, 80, 'down', 20)).toEqual({
			kind: 'omitted',
			reason: 'invalid_breakout_price',
		});
	});

	it('target が NaN → no_target を名乗る', () => {
		const candles = [c(102, 98, 100, 'iso-0')];
		expect(computeTargetReach(candles, 0, 100, Number.NaN, 'down', 20)).toEqual({
			kind: 'omitted',
			reason: 'no_target',
		});
	});

	it('breakoutIdx が candles.length 以上 → no_bars_after_breakout を名乗る', () => {
		const candles = [c(102, 98, 100, 'iso-0')];
		expect(computeTargetReach(candles, 5, 100, 80, 'down', 20)).toEqual({
			kind: 'omitted',
			reason: 'no_bars_after_breakout',
		});
	});

	it('走査窓に有限な high/low が 1 本も無い → no_bars_after_breakout を名乗る', () => {
		// 全足の high/low が非有限 → extremeIdx < 0 の経路
		const candles = [c(Number.NaN, Number.NaN, 100, 'iso-0'), c(Number.NaN, Number.NaN, 100, 'iso-1')];
		expect(computeTargetReach(candles, 0, 100, 120, 'up', 20)).toEqual({
			kind: 'omitted',
			reason: 'no_bars_after_breakout',
		});
	});

	it('breakoutIdx が負 → Math.max(0, ...) で 0 から走査', () => {
		const candles = [c(95, 70, 90, 'iso-0'), c(100, 80, 95, 'iso-1')];
		const r = measured(computeTargetReach(candles, -1, 100, 80, 'down', 20));
		expect(r.targetReached).toBe(true);
		expect(r.targetReachedPrice).toBe(70);
	});

	it('reached=false で raw pct が 99.x → 99 にキャップ（100 にせり上がらない）', () => {
		// breakoutPrice=100, target=0, extremeLow=0.4 → targetReached=false、rawPct = 99.6 を round すると 100（reached=false なのに pct=100）になるので floor + 99 キャップ
		const candles = [c(101, 0.4, 100, 'iso-0')];
		const r = measured(computeTargetReach(candles, 0, 100, 0, 'down', 100));
		expect(r.targetReached).toBe(false);
		expect(r.targetReachedPct).toBe(99);
	});

	it('reached=true なら通常通り round（オーバーシュート/到達の区別を維持）', () => {
		// breakoutPrice=100, target=80, extremeLow=80（ちょうど到達）→ rawPct = 20/20 * 100 = 100 → reached=true & pct=100
		const candles = [c(95, 80, 90, 'iso-0')];
		const r = measured(computeTargetReach(candles, 0, 100, 80, 'down', 20));
		expect(r.targetReached).toBe(true);
		expect(r.targetReachedPct).toBe(100);
	});

	it(`到達側は ${TARGET_REACHED_PCT_CAP} で頭打ちになる（issue #210 (1)）`, () => {
		// breakoutPrice=100, target=110（distance=10）、high=100000 → rawPct=999,000%
		const candles = [c(100_000, 99, 100, 'iso-0')];
		const r = measured(computeTargetReach(candles, 0, 100, 110, 'up', 10));
		expect(r.targetReached).toBe(true);
		expect(r.targetReachedPct).toBe(TARGET_REACHED_PCT_CAP);
	});

	it('上限に届かないオーバーシュートは丸めずそのまま出る', () => {
		// breakoutPrice=100, target=110（distance=10）、high=150 → rawPct=500%
		const candles = [c(150, 99, 100, 'iso-0')];
		expect(measured(computeTargetReach(candles, 0, 100, 110, 'up', 10)).targetReachedPct).toBe(500);
	});

	it('targetDistance がパターン高さの閾値未満 → kind=omitted（進捗を出さない。issue #210 (2)）', () => {
		// distance=10 / height=1000 → 比 0.01 < 0.15
		const candles = [c(200, 90, 100, 'iso-0'), c(300, 80, 250, 'iso-1')];
		const r = computeTargetReach(candles, 0, 100, 110, 'up', 1000);
		expect(r).toEqual({ kind: 'omitted', reason: 'degenerate_target_distance' });
	});

	it('閾値ちょうどは測る（境界は「未満」で切る）', () => {
		// distance=10 / height=10/0.15 → 比はちょうど MIN_TARGET_DISTANCE_HEIGHT_RATIO
		const candles = [c(105, 95, 100, 'iso-0')];
		const r = computeTargetReach(candles, 0, 100, 110, 'up', 10 / MIN_TARGET_DISTANCE_HEIGHT_RATIO);
		expect(r?.kind).toBe('measured');
	});

	it('0 距離（breakoutPrice == target）→ kind=omitted（旧: reached=true, pct=100）', () => {
		// ブレイク時点で target と一致 = 達成度を測る余地が無い。比 0 として退化ガードに落ちる。
		const candles = [c(102, 98, 100, 'iso-0'), c(105, 95, 100, 'iso-1')];
		expect(computeTargetReach(candles, 0, 100, 100, 'down', 20)?.kind).toBe('omitted');
		expect(computeTargetReach(candles, 0, 100, 100, 'up', 20)?.kind).toBe('omitted');
	});

	it('patternHeight が 0 / 負 / NaN → kind=omitted（比を判定できない）', () => {
		const candles = [c(130, 95, 100, 'iso-0')];
		for (const h of [0, -5, Number.NaN]) {
			expect(computeTargetReach(candles, 0, 100, 120, 'up', h)?.kind).toBe('omitted');
		}
	});

	it(`走査はブレイク足から ${TARGET_REACH_MAX_BARS} 本先まで（issue #210 (3)）`, () => {
		// 窓の内側（最終足）に high=130、窓の外側にさらに高い high=500 を置く
		const candles: CandleData[] = [];
		for (let i = 0; i <= TARGET_REACH_MAX_BARS + 5; i++) {
			candles.push(c(105, 95, 100, `iso-${i}`));
		}
		candles[TARGET_REACH_MAX_BARS] = c(130, 95, 100, `iso-${TARGET_REACH_MAX_BARS}`);
		candles[TARGET_REACH_MAX_BARS + 1] = c(500, 95, 100, `iso-${TARGET_REACH_MAX_BARS + 1}`);
		const r = measured(computeTargetReach(candles, 0, 100, 120, 'up', 20));
		expect(r.targetReachedPrice).toBe(130);
		expect(r.targetReachedDate).toBe(`iso-${TARGET_REACH_MAX_BARS}`);
	});

	it('窓の外だけで到達しても reached=false（「いつか到達」ではない）', () => {
		const candles: CandleData[] = [];
		for (let i = 0; i <= TARGET_REACH_MAX_BARS + 5; i++) {
			candles.push(c(105, 95, 100, `iso-${i}`));
		}
		candles[TARGET_REACH_MAX_BARS + 1] = c(500, 95, 100, 'iso-late');
		const r = measured(computeTargetReach(candles, 0, 100, 120, 'up', 20));
		expect(r.targetReached).toBe(false);
		expect(r.targetReachedPrice).toBe(105);
	});

	it('系列が窓より短ければ末尾まで（暫定値）', () => {
		const candles = [c(105, 95, 100, 'iso-0'), c(112, 95, 110, 'iso-1')];
		const r = measured(computeTargetReach(candles, 0, 100, 120, 'up', 20));
		expect(r.targetReached).toBe(false);
		expect(r.targetReachedPrice).toBe(112);
	});
});

describe('理由コードの単一ソース（issue #224 症状 2）', () => {
	// 型側は `satisfies` が見ているが、`z.enum` の options が型と食い違う書き方（`as` 等）を将来入れたときはこちらが落ちる。
	it('Zod enum の options とテストの全集合が一致する', () => {
		expect([...TargetProgressOmittedReasonEnum.options].sort()).toEqual([...ALL_OMISSION_REASONS].sort());
	});

	it('全 reason が DetectedPatternSchema.parse() を通り抜ける（黙って剥がされない）', () => {
		// 宣言漏れの事故は、型は通るのに parse が落としてどのクライアントにも届かない形で出る。
		for (const reason of ALL_OMISSION_REASONS) {
			const parsed = DetectedPatternSchema.parse({
				type: 'double_top',
				confidence: 0.75,
				range: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-20T00:00:00.000Z' },
				breakoutTarget: 110000,
				targetProgressOmittedReason: reason,
			});
			expect(parsed.targetProgressOmittedReason).toBe(reason);
		}
	});
});

describe('targetReachFields', () => {
	it.each(ALL_OMISSION_REASONS)('omitted(%s) → targetProgressOmittedReason だけを載せる', (reason) => {
		expect(targetReachFields(omittedTargetReach(reason))).toEqual({ targetProgressOmittedReason: reason });
	});

	it('measured → 進捗 4 フィールドを載せ、申告フィールドは出さない', () => {
		expect(
			targetReachFields({
				kind: 'measured',
				targetReachedPct: 120,
				targetReached: true,
				targetReachedDate: 'iso-1',
				targetReachedPrice: 130,
			}),
		).toEqual({
			targetReachedPct: 120,
			targetReached: true,
			targetReachedDate: 'iso-1',
			targetReachedPrice: 130,
		});
	});

	it('measured で targetReachedDate が無ければキーごと出さない', () => {
		expect(
			targetReachFields({ kind: 'measured', targetReachedPct: 50, targetReached: false, targetReachedPrice: 110 }),
		).not.toHaveProperty('targetReachedDate');
	});
});

describe('computeTargetReach: 到達の事実（issue #288 Phase 2）', () => {
	/** `n` 本のローソク足。`hitAt` の足だけ target（=120）に届く high を持つ。 */
	function seriesUp(n: number, hitAt?: number): CandleData[] {
		return Array.from({ length: n }, (_, i) =>
			i === hitAt ? c(130, 99, 100, `iso-${i}`) : c(105, 99, 100, `iso-${i}`),
		);
	}

	it('ブレイク足自身が target を越えていれば targetFirstReachBars = 0', () => {
		// ブレイク足（idx=0）の high=130 が target=120 を越えている。
		const r = measured(computeTargetReach(seriesUp(5, 0), 0, 100, 120, 'up', 20));
		expect(r.targetFirstReachBars).toBe(0);
		expect(r.targetFirstReachDate).toBe('iso-0');
	});

	it('初到達と極値が別の足なら両者が別の値になる（進捗行が極値の足を指さない）', () => {
		// idx=1 で target=120 に初到達（high=125）、idx=3 でさらに伸びて extremum（high=180）。
		const candles = [
			c(105, 99, 100, 'iso-0'),
			c(125, 110, 120, 'iso-1'),
			c(130, 118, 125, 'iso-2'),
			c(180, 125, 175, 'iso-3'),
		];
		const r = measured(computeTargetReach(candles, 0, 100, 120, 'up', 20));
		expect(r.targetFirstReachBars).toBe(1);
		expect(r.targetFirstReachDate).toBe('iso-1');
		// 既存の 2 フィールドは extremum の足のまま（同じ足に寄せない）。
		expect(r.targetReachedDate).toBe('iso-3');
		expect(r.targetReachedPrice).toBe(180);
	});

	it('direction=down でも初到達を拾う（極値より手前の足）', () => {
		// target=80。idx=1 で low=78 が初到達、idx=3 の low=50 が extremum。
		const candles = [c(102, 99, 100, 'iso-0'), c(95, 78, 85, 'iso-1'), c(90, 82, 86, 'iso-2'), c(85, 50, 60, 'iso-3')];
		const r = measured(computeTargetReach(candles, 0, 100, 80, 'down', 20));
		expect(r.targetFirstReachBars).toBe(1);
		expect(r.targetFirstReachDate).toBe('iso-1');
		expect(r.targetReachedDate).toBe('iso-3');
	});

	it('未到達なら targetFirstReachBars / targetFirstReachDate をキーごと出さない', () => {
		const r = measured(computeTargetReach(seriesUp(5), 0, 100, 120, 'up', 20));
		expect(r.targetReached).toBe(false);
		expect(r).not.toHaveProperty('targetFirstReachBars');
		expect(r).not.toHaveProperty('targetFirstReachDate');
		expect(targetReachFields(r)).not.toHaveProperty('targetFirstReachBars');
		expect(targetReachFields(r)).not.toHaveProperty('targetFirstReachDate');
	});

	it('初到達の後にもう一度届いても最初の足を返す（上書きしない）', () => {
		const candles = [
			c(105, 99, 100, 'iso-0'),
			c(125, 110, 120, 'iso-1'),
			c(101, 95, 98, 'iso-2'),
			c(140, 120, 138, 'iso-3'),
		];
		const r = measured(computeTargetReach(candles, 0, 100, 120, 'up', 20));
		expect(r.targetFirstReachBars).toBe(1);
	});

	// 走査本数はブレイク足を 0 本目とした後続の本数なので、上限まで走るには `TARGET_REACH_MAX_BARS + 1` 本の系列が要る。
	it.each([
		[TARGET_REACH_MAX_BARS - 1, TARGET_REACH_MAX_BARS - 2, false],
		[TARGET_REACH_MAX_BARS, TARGET_REACH_MAX_BARS - 1, false],
		[TARGET_REACH_MAX_BARS + 1, TARGET_REACH_MAX_BARS, true],
		[TARGET_REACH_MAX_BARS + 2, TARGET_REACH_MAX_BARS, true],
	])('系列 %i 本 → targetScanBars=%i / targetScanComplete=%s', (len, bars, complete) => {
		const r = measured(computeTargetReach(seriesUp(len), 0, 100, 120, 'up', 20));
		expect(r.targetScanBars).toBe(bars);
		expect(r.targetScanComplete).toBe(complete);
	});

	it('走査は上限で打ち切る——上限より先の到達は拾わない', () => {
		// 到達の足を上限のちょうど 1 本先に置く。
		const r = measured(
			computeTargetReach(seriesUp(TARGET_REACH_MAX_BARS + 2, TARGET_REACH_MAX_BARS + 1), 0, 100, 120, 'up', 20),
		);
		expect(r.targetReached).toBe(false);
		expect(r).not.toHaveProperty('targetFirstReachBars');
		// 上限ちょうどの足なら拾う（境界の内側）。
		const onEdge = measured(
			computeTargetReach(seriesUp(TARGET_REACH_MAX_BARS + 2, TARGET_REACH_MAX_BARS), 0, 100, 120, 'up', 20),
		);
		expect(onEdge.targetFirstReachBars).toBe(TARGET_REACH_MAX_BARS);
	});

	it('breakoutIdx が 0 でなくても本数はブレイク足からの相対値', () => {
		const candles = seriesUp(10, 7);
		const r = measured(computeTargetReach(candles, 5, 100, 120, 'up', 20));
		expect(r.targetFirstReachBars).toBe(2);
		expect(r.targetScanBars).toBe(4); // 末尾 idx=9 まで
		expect(r.targetScanComplete).toBe(false);
	});

	it('targetReachFields は measured のとき走査本数を必ず載せる', () => {
		const fields = targetReachFields(computeTargetReach(seriesUp(5, 1), 0, 100, 120, 'up', 20));
		expect(fields.targetScanBars).toBe(4);
		expect(fields.targetScanComplete).toBe(false);
		expect(fields.targetFirstReachBars).toBe(1);
	});
});

describe('formatTargetProgressLine（issue #288 Phase 2 で事実の記述に作り直した）', () => {
	it('進捗が無ければ null', () => {
		expect(formatTargetProgressLine({})).toBeNull();
	});

	it('到達: 本数と日時を出し、100% 超の数字は出さない', () => {
		const line = formatTargetProgressLine({
			targetReachedPct: 273,
			targetReached: true,
			targetFirstReachBars: 14,
			targetFirstReachDate: '2026-09-08T06:00:00.000Z',
			targetScanBars: TARGET_REACH_MAX_BARS,
			targetScanComplete: true,
		});
		expect(line).toBe('   - ターゲット: 到達（ブレイク後 14 本目、2026-09-08T06:00:00.000Z）');
		expect(line).not.toContain('273');
		expect(line).not.toContain('進捗');
	});

	it('到達: 日時の整形は呼び出し側に委ねる（tz 整形に合わせる）', () => {
		const line = formatTargetProgressLine(
			{ targetReachedPct: 120, targetReached: true, targetFirstReachBars: 14, targetFirstReachDate: 'iso' },
			{ formatDate: () => '2026-09-08 15:00' },
		);
		expect(line).toBe('   - ターゲット: 到達（ブレイク後 14 本目、2026-09-08 15:00）');
	});

	it('未到達（走査完了）: 走査本数の完了と接近度を出す', () => {
		expect(
			formatTargetProgressLine({
				targetReachedPct: 22,
				targetReached: false,
				targetScanBars: TARGET_REACH_MAX_BARS,
				targetScanComplete: true,
			}),
		).toBe(`   - ターゲット: 未到達（走査 ${TARGET_REACH_MAX_BARS} 本完了、目標幅の 22% まで接近）`);
	});

	it('未到達（走査中）: 経過本数と走査上限を並べる（「届かなかった」と読ませない）', () => {
		expect(
			formatTargetProgressLine({
				targetReachedPct: 22,
				targetReached: false,
				targetScanBars: 13,
				targetScanComplete: false,
			}),
		).toBe(
			`   - ターゲット: 未到達（ブレイク後 13 本経過 / 走査上限 ${TARGET_REACH_MAX_BARS} 本、目標幅の 22% まで接近）`,
		);
	});

	it.each([100, 115, 273, 530, TARGET_REACHED_PCT_CAP])('到達 pct=%i でも content に数字が出ない', (pct) => {
		const line = formatTargetProgressLine({
			targetReachedPct: pct,
			targetReached: true,
			targetFirstReachBars: 3,
		});
		expect(line).not.toContain(String(pct));
		expect(line).not.toContain('%');
	});

	it('未到達側に出る百分率は必ず 100 未満（上限側は 99 でキャップ済み）', () => {
		const line = formatTargetProgressLine({ targetReachedPct: 99, targetReached: false, targetScanBars: 60 });
		expect(line).toContain('目標幅の 99% まで接近');
	});

	it('到達: 到達前の別パターンのブレイクを末尾に足す', () => {
		const line = formatTargetProgressLine({
			targetReachedPct: 130,
			targetReached: true,
			targetFirstReachBars: 47,
			targetOtherBreakoutBeforeReach: [{ type: 'triangle_ascending', direction: 'down', barsAfterBreakout: 25 }],
		});
		expect(line).toBe(
			'   - ターゲット: 到達（ブレイク後 47 本目）。到達前に別パターンのブレイクあり（triangle_ascending 下方 +25 本）',
		);
	});

	it('未到達: 走査窓内の逆方向のブレイクを末尾に足す', () => {
		const line = formatTargetProgressLine({
			targetReachedPct: 22,
			targetReached: false,
			targetScanBars: TARGET_REACH_MAX_BARS,
			targetScanComplete: true,
			targetOppositeBreakoutInWindow: [{ type: 'triangle_descending', direction: 'down', barsAfterBreakout: 27 }],
		});
		expect(line).toContain('。走査窓内に逆方向のブレイクあり（triangle_descending 下方 +27 本）');
	});

	it('交絡が空配列なら何も足さない（全件に付く申告にしない）', () => {
		const line = formatTargetProgressLine({
			targetReachedPct: 130,
			targetReached: true,
			targetFirstReachBars: 4,
			targetOtherBreakoutBeforeReach: [],
			targetOppositeBreakoutInWindow: [],
		});
		expect(line).toBe('   - ターゲット: 到達（ブレイク後 4 本目）');
	});

	it('複数件は本数順に並べて全部出す', () => {
		const line = formatTargetProgressLine({
			targetReachedPct: 130,
			targetReached: true,
			targetFirstReachBars: 40,
			targetOtherBreakoutBeforeReach: [
				{ type: 'inverse_head_and_shoulders', direction: 'up', barsAfterBreakout: 3 },
				{ type: 'rising_wedge', direction: 'down', barsAfterBreakout: 37 },
			],
		});
		expect(line).toContain('（inverse_head_and_shoulders 上方 +3 本, rising_wedge 下方 +37 本）');
	});

	it('新フィールドが無い到達は本数を騙らず走査窓の幅までしか言わない', () => {
		expect(formatTargetProgressLine({ targetReachedPct: 132, targetReached: true })).toBe(
			`   - ターゲット: 到達（ブレイク後${TARGET_REACH_MAX_BARS}本以内）`,
		);
	});

	it('新フィールドが無い未到達は走査上限だけを言う', () => {
		expect(formatTargetProgressLine({ targetReachedPct: 47, targetReached: false })).toBe(
			`   - ターゲット: 未到達（走査上限 ${TARGET_REACH_MAX_BARS} 本、目標幅の 47% まで接近）`,
		);
	});

	it('targetReached が無い素の JSON でも pct>=100 で到達側に分岐する（旧実装と同じ判定）', () => {
		expect(formatTargetProgressLine({ targetReachedPct: 100 })).toContain('到達（');
		expect(formatTargetProgressLine({ targetReachedPct: 99 })).toContain('未到達（');
	});

	it('退化して出さなかった場合は理由を content に出す', () => {
		const line = formatTargetProgressLine({ targetProgressOmittedReason: 'degenerate_target_distance' });
		expect(line).toContain('出力なし');
		expect(line).toContain('85%以上');
	});

	// `null` は content から行ごと消えることを意味し、「進捗 0%」と「測っていない」が LLM に区別できなくなるので、理由があるのに null を返す経路を残さない（issue #224 症状 2）。
	it.each(ALL_OMISSION_REASONS)('reason=%s は必ず 1 行返す（黙らない）', (reason) => {
		const line = formatTargetProgressLine({ targetProgressOmittedReason: reason });
		expect(line).not.toBeNull();
		expect(line).toContain('   - ターゲット: 出力なし（');
		// コードそのものを content に漏らさない（日本語文言に写像されている）。
		expect(line).not.toContain(reason);
	});

	it('未知の reason でも黙らずコードを出す（写像漏れを無言にしない）', () => {
		const line = formatTargetProgressLine({ targetProgressOmittedReason: 'brand_new_reason' });
		expect(line).toBe('   - ターゲット: 出力なし（brand_new_reason）');
	});

	it('reason があれば pct より優先する（全 reason で）', () => {
		for (const reason of ALL_OMISSION_REASONS) {
			expect(formatTargetProgressLine({ targetProgressOmittedReason: reason, targetReachedPct: 4242 })).not.toContain(
				'4242',
			);
		}
	});

	it('退化の申告は pct より優先する（両方あっても進捗値を名乗らない）', () => {
		const line = formatTargetProgressLine({
			targetProgressOmittedReason: 'degenerate_target_distance',
			targetReachedPct: 240033,
		});
		expect(line).not.toContain('240033');
	});

	it('4 形とも行頭ラベルが同じ（規約 3 の上位集合テストが語で照合できる）', () => {
		const lines = [
			formatTargetProgressLine({ targetReachedPct: 120, targetReached: true, targetFirstReachBars: 1 }),
			formatTargetProgressLine({ targetReachedPct: 20, targetReached: false, targetScanBars: 60 }),
			formatTargetProgressLine({ targetReachedPct: 20, targetReached: false, targetScanBars: 3 }),
			formatTargetProgressLine({ targetProgressOmittedReason: 'not_broken_out' }),
		];
		for (const line of lines) expect(line).toMatch(/^ {3}- ターゲット: /);
	});
});
