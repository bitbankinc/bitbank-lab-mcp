/**
 * tests/patterns/invariants.test.ts
 *
 * パターン検出系ツールの横断契約テスト。
 *
 * `analyze_candle_patterns` と `detect_patterns` 系列について、
 * 全パターンタイプ横断で守られるべき不変条件を fixture ベースで検証する。
 *
 * カバーする 7 つの不変条件:
 *   1. barIndex 整合
 *   2. 決定性（同一入力に対する deep equal）
 *   3. status enum の許容値
 *   4. completed は breakout 成立 fixture でのみ出る
 *   5. whipsaw fixture で completed にならない
 *   6. includeForming=false で forming / near_completion 除外
 *   7. allow_partial_patterns=false で uses_partial_candle スキップ
 *
 * 設計方針:
 *   - 既存 fixture テスト（tests/patterns/*.test.ts, tests/analyze_candle_patterns.test.ts,
 *     tests/detect_patterns_fixtures.test.ts）とは独立して動作させる
 *   - 単一ファイルで完結する（fixture / モックを内部で定義）
 *   - 全パターンタイプ横断で検証する（個別パターンの詳細検証は既存テスト側）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { asMockResult, assertOk } from '../_assertResult.js';

vi.mock('../../tools/get_candles.js', () => ({
	default: vi.fn(),
}));

vi.mock('../../tools/analyze_indicators.js', () => ({
	default: vi.fn(),
}));

import analyzeCandlePatterns from '../../tools/analyze_candle_patterns.js';
import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import getCandles from '../../tools/get_candles.js';

// ── 型・ヘルパー ──────────────────────────────────

type Candle = {
	isoTime: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
};

/**
 * 契約で許容される status 値の和集合。
 * - analyze_candle_patterns: `confirmed` / `forming`
 * - detect_patterns: `forming` / `near_completion` / `completed`
 *   （`invalid` は includeInvalid=false の既定で除外されるため対象外）
 */
const ALLOWED_STATUSES = ['forming', 'near_completion', 'completed', 'confirmed'] as const;
type AllowedStatus = (typeof ALLOWED_STATUSES)[number];
const ALLOWED_STATUS_SET = new Set<string>(ALLOWED_STATUSES);

function makeIso(dayOffset: number, year = 2026): string {
	return dayjs.utc(`${year}-01-01`).add(dayOffset, 'day').toISOString();
}

function makeCandle(dayOffset: number, close: number, year = 2026): Candle {
	return {
		isoTime: makeIso(dayOffset, year),
		open: close,
		high: close + 3,
		low: close - 3,
		close,
		volume: 100,
	};
}

function indicatorsOk(candles: Candle[]) {
	return { ok: true, summary: 'ok', data: { chart: { candles } } };
}

function candlesOk(normalized: Candle[]) {
	return { ok: true, summary: 'ok', data: { normalized }, meta: { count: normalized.length } };
}

// ── analyze_candle_patterns 用ヘルパー ─────────────

function daysAgoIso(n: number): string {
	return dayjs().subtract(n, 'day').startOf('day').toISOString();
}

function todayIso(): string {
	// tool 側は JST 暦日（dayjs().tz('Asia/Tokyo')）と calendarDateFromIso(isoTime) を比較する
	// （analyze_candle_patterns.ts）。dayjs().startOf('day').toISOString() は
	// 非 UTC 環境でローカル深夜を UTC に変換すると前日 15:00Z 等になり、split('T')[0]
	// が前日日付になって lastCandleTime !== todayStr → isLastPartial=false で
	// partial 検出が外れる。日付部分が必ず一致するようローカル日付 + Z で組み立てる。
	return `${dayjs().format('YYYY-MM-DD')}T00:00:00.000Z`;
}

function mc(daysAgo: number, o: number, h: number, l: number, c: number, v = 100): Candle {
	return { isoTime: daysAgoIso(daysAgo), open: o, high: h, low: l, close: c, volume: v };
}

function bullishCandles(n: number, base = 100, step = 3): Candle[] {
	return Array.from({ length: n }, (_, i) => {
		const o = base + step * i;
		return mc(n - i, o, o + 6, o - 4, o + step);
	});
}

function bearishCandles(n: number, base = 130, step = 3): Candle[] {
	return Array.from({ length: n }, (_, i) => {
		const o = base - step * i;
		return mc(n - i, o, o + 4, o - 6, o - step);
	});
}

/** ローソク足パターン fixture: 1本足 / 2本足 / 3本足を網羅 */
const candleFixtures: Record<string, () => Candle[]> = {
	// 1本足
	hammer: () => [...bullishCandles(3), mc(0, 80, 100, 0, 85)],
	shooting_star: () => [...bullishCandles(3), mc(0, 20, 100, 0, 15)],
	doji: () => [...bullishCandles(3), mc(0, 100, 110, 90, 100.2)],
	// 2本足
	bullish_engulfing: () => [...bearishCandles(3), mc(1, 120, 121, 115, 116), mc(0, 115, 125, 114, 124)],
	bearish_engulfing: () => [...bullishCandles(3), mc(1, 110, 115, 109, 114), mc(0, 115, 116, 108, 109)],
	tweezer_top: () => [...bullishCandles(3), mc(1, 118, 130, 115, 125), mc(0, 125, 130.5, 120, 122)],
	// 3本足
	morning_star: () => [
		...bearishCandles(3),
		mc(2, 130, 132, 108, 110),
		mc(1, 109, 111, 105, 108),
		mc(0, 110, 135, 108, 132),
	],
	three_white_soldiers: () => [
		mc(5, 95, 98, 94, 96),
		mc(4, 95, 98, 94, 96),
		mc(3, 95, 98, 94, 96),
		mc(2, 100, 112, 99, 110),
		mc(1, 108, 122, 107, 120),
		mc(0, 118, 134, 117, 132),
	],
};

// ── detect_patterns 用 fixture ──────────────────────

/** 完成済み double_top（breakout 成立） */
function buildCompletedDoubleTopCandles(year = 2026): Candle[] {
	const closes = [
		100, 102, 105, 110, 118, 130, 126, 122, 118, 114, 112, 110, 114, 118, 122, 126, 128, 129, 123, 116, 104, 100, 95,
		100, 99, 98,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/** 形成中 double_bottom（breakout 未成立） */
function buildFormingDoubleBottomCandles(year = 2026): Candle[] {
	const closes = [108, 104, 99, 92, 80, 84, 88, 92, 96, 99, 101, 98, 94, 89, 85, 82, 81, 84, 88, 91, 94, 95, 96, 95];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/** 完成済み head_and_shoulders */
function buildCompletedHeadAndShouldersCandles(year = 2026): Candle[] {
	const closes = [
		100, 108, 116, 122, 125, 120, 116, 112, 110, 114, 120, 128, 136, 140, 136, 128, 120, 114, 112, 116, 120, 124, 126,
		122, 116, 108, 102, 96,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/** 完成済み triple_top */
function buildCompletedTripleTopCandles(year = 2026): Candle[] {
	const closes = [
		100, 105, 112, 120, 128, 130, 126, 120, 115, 112, 116, 122, 128, 130, 131, 126, 120, 115, 113, 117, 122, 128, 130,
		131, 126, 118, 110, 104, 98, 94,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/**
 * Bull pennant 順方向ブレイク（completed が明示的に出る fixture）。
 * tests/detect_patterns_fixtures.test.ts 既存 fixture と同じ価格列。
 */
function buildBullPennantSuccessCandles(year = 2026): Candle[] {
	const closes = [
		100, 110, 122, 136, 150, 165, 158, 162, 154, 160, 155, 159, 156, 158, 157, 157.8, 157.2, 158.1, 157.4, 170, 172,
		174,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/** 形成中 rising_wedge */
function buildFormingRisingWedgeCandles(year = 2026): Candle[] {
	const closes = [
		100, 106, 112, 118, 124, 130, 119, 108, 113, 118, 124, 129, 134, 125, 116, 120, 125, 129, 134, 138, 131, 124, 128,
		131, 135, 138, 142, 137, 132, 135, 138, 140, 143, 146, 143,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/** 形成中 triangle_symmetrical */
function buildFormingSymmetricalTriangleCandles(year = 2026): Candle[] {
	const closes = [
		120, 126, 132, 137, 130, 122, 116, 110, 104, 100, 106, 114, 120, 128, 134, 128, 120, 115, 108, 104, 110, 118, 124,
		130, 126, 120, 116, 112, 108, 114, 120, 126, 124, 120, 117, 114,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/**
 * 対称三角形 + 上方ブレイクアウト + whipsaw（三角形内に戻る価格列）。
 * tests/patterns/detect_triangles.test.ts:buildSymTriangleBase + buildWithBreakoutAndTail 相当。
 * - 40 本の対称三角形（phase=1 で upper 接触、phase=5 で lower 接触）
 * - 1 本のブレイクアウト足（close=120, upper ~98 を上抜け）
 * - 5 本の whipsaw 戻り足（close=94, 三角形内 [lower~93, upper~97]）
 */
function buildSymTriangleWhipsawCandles(year = 2026): Candle[] {
	const candles: Candle[] = [];
	for (let i = 0; i < 40; i++) {
		const upper = 110 - 0.3 * i;
		const lower = 80 + 0.3 * i;
		const mid = (upper + lower) / 2;
		const phase = i % 8;
		let h: number;
		let l: number;
		let c: number;

		if (phase === 1) {
			h = upper;
			l = upper - 5;
			c = upper - 1;
		} else if (phase === 5) {
			h = lower + 5;
			l = lower;
			c = lower + 1;
		} else {
			h = mid + 3;
			l = mid - 3;
			c = mid;
		}
		candles.push({
			isoTime: makeIso(i, year),
			open: mid,
			high: h,
			low: l,
			close: c,
			volume: 100,
		});
	}

	// ブレイクアウト足（上方）
	candles.push({
		isoTime: makeIso(40, year),
		open: 118,
		high: 122,
		low: 116,
		close: 120,
		volume: 100,
	});

	// whipsaw: 三角形内に再侵入
	for (let t = 0; t < 5; t++) {
		candles.push({
			isoTime: makeIso(41 + t, year),
			open: 94,
			high: 96,
			low: 92,
			close: 94,
			volume: 100,
		});
	}

	return candles;
}

// ── テスト本体 ─────────────────────────────────────

describe('patterns invariants — 横断契約', () => {
	const mockedGetCandles = vi.mocked(getCandles);
	const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);

	afterEach(() => {
		vi.clearAllMocks();
	});

	// ──────────────────────────────────────────────
	// 1. barIndex 整合
	//    candle_range_index / breakoutBarIndex / pivots[].idx が
	//    candles 配列のインデックス範囲内に収まること
	// ──────────────────────────────────────────────
	describe('barIndex 整合', () => {
		it('analyze_candle_patterns: candle_range_index は [0, windowCandles.length - 1] に収まる', async () => {
			const fixtures = Object.entries(candleFixtures);

			for (const [name, build] of fixtures) {
				const candles = build();
				mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
				const res = await analyzeCandlePatterns({
					window_days: candles.length,
					focus_last_n: 5,
					history_lookback_days: 30,
				});
				assertOk(res);
				const windowLen = res.data.window.candles.length;
				expect(windowLen).toBeGreaterThan(0);
				for (const p of res.data.recent_patterns) {
					const [start, end] = p.candle_range_index;
					expect(start, `${name}: start>=0`).toBeGreaterThanOrEqual(0);
					expect(end, `${name}: end<=windowLen-1`).toBeLessThanOrEqual(windowLen - 1);
					expect(start, `${name}: start<=end`).toBeLessThanOrEqual(end);
				}
			}
		});

		it('detect_patterns: breakoutBarIndex / pivots[].idx は [0, candles.length - 1] に収まる', async () => {
			const fixtures: Array<{
				name: string;
				candles: Candle[];
				opts: Parameters<typeof detectPatterns>[3];
			}> = [
				{
					name: 'double_top',
					candles: buildCompletedDoubleTopCandles(),
					opts: { patterns: ['double_top'], swingDepth: 2, tolerancePct: 0.02 },
				},
				{
					name: 'head_and_shoulders',
					candles: buildCompletedHeadAndShouldersCandles(),
					opts: { patterns: ['head_and_shoulders'], swingDepth: 2, tolerancePct: 0.04 },
				},
				{
					name: 'triple_top',
					candles: buildCompletedTripleTopCandles(),
					opts: { patterns: ['triple_top'], swingDepth: 2, tolerancePct: 0.02 },
				},
				{
					name: 'rising_wedge',
					candles: buildFormingRisingWedgeCandles(),
					opts: { patterns: ['rising_wedge'], includeForming: true },
				},
				{
					name: 'triangle_symmetrical',
					candles: buildFormingSymmetricalTriangleCandles(),
					opts: { patterns: ['triangle_symmetrical'], includeForming: true },
				},
			];

			for (const fx of fixtures) {
				mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(fx.candles)));
				const res = await detectPatterns('btc_jpy', '1day', fx.candles.length, fx.opts);
				assertOk(res);
				const lastIdx = fx.candles.length - 1;
				for (const p of res.data.patterns) {
					if (typeof p.breakoutBarIndex === 'number') {
						expect(p.breakoutBarIndex, `${fx.name}: breakoutBarIndex>=0`).toBeGreaterThanOrEqual(0);
						expect(p.breakoutBarIndex, `${fx.name}: breakoutBarIndex<=lastIdx`).toBeLessThanOrEqual(lastIdx);
					}
					if (Array.isArray(p.pivots)) {
						for (const pv of p.pivots) {
							expect(pv.idx, `${fx.name}: pivot idx>=0`).toBeGreaterThanOrEqual(0);
							expect(pv.idx, `${fx.name}: pivot idx<=lastIdx`).toBeLessThanOrEqual(lastIdx);
						}
					}
				}
			}
		});
	});

	// ──────────────────────────────────────────────
	// 2. 決定性
	//    同一入力に対する出力は deep equal（乱数・時刻依存ロジック禁止）
	// ──────────────────────────────────────────────
	describe('決定性', () => {
		it('analyze_candle_patterns: 同一 fixture を 2 回実行で recent_patterns が deep equal', async () => {
			const candles = candleFixtures.doji();
			mockedGetCandles
				.mockResolvedValueOnce(asMockResult(candlesOk(candles)))
				.mockResolvedValueOnce(asMockResult(candlesOk(candles)));

			const args = { window_days: candles.length, focus_last_n: 4, history_lookback_days: 30 };
			const a = await analyzeCandlePatterns(args);
			const b = await analyzeCandlePatterns(args);
			assertOk(a);
			assertOk(b);
			expect(a.data.recent_patterns.length).toBeGreaterThan(0);
			expect(a.data.recent_patterns).toEqual(b.data.recent_patterns);
		});

		it('detect_patterns: 同一 fixture を 2 回実行で data.patterns が deep equal', async () => {
			const candles = buildCompletedDoubleTopCandles();
			mockedAnalyzeIndicators
				.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)))
				.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));

			const opts = {
				patterns: ['double_top'] as ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
			};
			const a = await detectPatterns('btc_jpy', '1day', candles.length, opts);
			const b = await detectPatterns('btc_jpy', '1day', candles.length, opts);
			assertOk(a);
			assertOk(b);
			expect(a.data.patterns.length).toBeGreaterThan(0);
			expect(a.data.patterns).toEqual(b.data.patterns);
		});
	});

	// ──────────────────────────────────────────────
	// 3. status enum の許容値
	//    検出された全パターンの status は契約で定めた集合のいずれか
	// ──────────────────────────────────────────────
	describe('status enum の許容値', () => {
		it('analyze_candle_patterns: 全パターンの status は許容集合に含まれる', async () => {
			const fixtures = Object.entries(candleFixtures);
			let totalDetected = 0;

			for (const [, build] of fixtures) {
				const candles = build();
				mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
				const res = await analyzeCandlePatterns({
					window_days: candles.length,
					focus_last_n: 5,
					history_lookback_days: 30,
				});
				assertOk(res);
				for (const p of res.data.recent_patterns) {
					expect(ALLOWED_STATUS_SET.has(p.status)).toBe(true);
					totalDetected++;
				}
			}
			// 1 件以上は検出されていることを保証（vacuous true 防止）
			expect(totalDetected).toBeGreaterThan(0);
		});

		it('detect_patterns: 全パターンの status は許容集合に含まれる', async () => {
			const fixtures: Array<{ candles: Candle[]; opts: Parameters<typeof detectPatterns>[3] }> = [
				{
					candles: buildCompletedDoubleTopCandles(),
					opts: { patterns: ['double_top'], swingDepth: 2, tolerancePct: 0.02 },
				},
				{
					candles: buildFormingDoubleBottomCandles(),
					opts: {
						patterns: ['double_bottom'],
						swingDepth: 2,
						tolerancePct: 0.03,
						includeForming: true,
					},
				},
				{
					candles: buildCompletedHeadAndShouldersCandles(),
					opts: { patterns: ['head_and_shoulders'], swingDepth: 2, tolerancePct: 0.04 },
				},
				{
					candles: buildFormingRisingWedgeCandles(),
					opts: { patterns: ['rising_wedge'], includeForming: true },
				},
				{
					candles: buildFormingSymmetricalTriangleCandles(),
					opts: { patterns: ['triangle_symmetrical'], includeForming: true },
				},
				{
					candles: buildCompletedTripleTopCandles(),
					opts: { patterns: ['triple_top'], swingDepth: 2, tolerancePct: 0.02 },
				},
			];

			let totalDetected = 0;
			for (const fx of fixtures) {
				mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(fx.candles)));
				const res = await detectPatterns('btc_jpy', '1day', fx.candles.length, fx.opts);
				assertOk(res);
				for (const p of res.data.patterns) {
					if (p.status !== undefined) {
						expect(ALLOWED_STATUS_SET.has(p.status as AllowedStatus)).toBe(true);
					}
					totalDetected++;
				}
			}
			expect(totalDetected).toBeGreaterThan(0);
		});
	});

	// ──────────────────────────────────────────────
	// 4. completed は breakout 成立 fixture でのみ出る
	// ──────────────────────────────────────────────
	describe('completed は breakout 成立 fixture でのみ', () => {
		it('breakout 成立 fixture（bull pennant）→ status=completed のパターンが含まれる', async () => {
			// 注: detect_doubles / detect_hs / detect_triples は完成済みでも明示的な
			// status='completed' を付与しない（status=undefined のまま）ため、
			// 明示的に completed が出る pennant / triangle / wedge を使う。
			const candles = buildBullPennantSuccessCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
			const res = await detectPatterns('btc_jpy', '1day', candles.length, {
				patterns: ['pennant'],
				includeCompleted: true,
				includeInvalid: true,
			});
			assertOk(res);
			const completed = res.data.patterns.filter((p) => p.status === 'completed');
			expect(completed.length).toBeGreaterThan(0);
		});

		it('breakout 未成立 fixture（double_bottom forming）→ completed は含まれない', async () => {
			const candles = buildFormingDoubleBottomCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
			const res = await detectPatterns('btc_jpy', '1day', candles.length, {
				patterns: ['double_bottom'],
				swingDepth: 2,
				tolerancePct: 0.03,
				includeForming: true,
				includeCompleted: true,
			});
			assertOk(res);
			// baseline: 対象パターンが少なくとも 1 件検出されている（vacuous pass 防止）
			const targets = res.data.patterns.filter((p) => p.type === 'double_bottom');
			expect(targets.length).toBeGreaterThan(0);
			const completed = targets.filter((p) => p.status === 'completed');
			expect(completed).toHaveLength(0);
		});

		it('breakout 未成立 fixture（rising_wedge forming）→ completed は含まれない', async () => {
			const candles = buildFormingRisingWedgeCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
			const res = await detectPatterns('btc_jpy', '1day', candles.length, {
				patterns: ['rising_wedge'],
				includeForming: true,
				includeCompleted: true,
			});
			assertOk(res);
			// baseline: 対象パターンが少なくとも 1 件検出されている（vacuous pass 防止）
			const targets = res.data.patterns.filter((p) => p.type === 'rising_wedge');
			expect(targets.length).toBeGreaterThan(0);
			const completed = targets.filter((p) => p.status === 'completed');
			expect(completed).toHaveLength(0);
		});
	});

	// ──────────────────────────────────────────────
	// 5. whipsaw fixture で completed にならない
	//    （三角形系・doubles 系どちらも completed が出ない）
	// ──────────────────────────────────────────────
	describe('whipsaw fixture で completed にならない', () => {
		it('対称三角形 whipsaw → 三角形系で completed は 0 件', async () => {
			const candles = buildSymTriangleWhipsawCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
			const res = await detectPatterns('btc_jpy', '1day', candles.length, {
				patterns: ['triangle_symmetrical', 'triangle_ascending', 'triangle_descending'],
				includeForming: true,
				includeCompleted: true,
			});
			assertOk(res);
			// baseline: 三角形パターンが少なくとも 1 件検出されている（vacuous pass 防止）
			const triangles = res.data.patterns.filter(
				(p) => p.type === 'triangle_symmetrical' || p.type === 'triangle_ascending' || p.type === 'triangle_descending',
			);
			expect(triangles.length).toBeGreaterThan(0);
			const triangleCompleted = triangles.filter((p) => p.status === 'completed');
			expect(triangleCompleted).toHaveLength(0);
		});

		it('対称三角形 whipsaw → doubles 系で completed は 0 件', async () => {
			const candles = buildSymTriangleWhipsawCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
			const res = await detectPatterns('btc_jpy', '1day', candles.length, {
				patterns: ['double_top', 'double_bottom'],
				includeForming: true,
				includeCompleted: true,
			});
			assertOk(res);
			// baseline: doubles 系パターンが少なくとも 1 件検出されている（vacuous pass 防止）
			const doubles = res.data.patterns.filter((p) => p.type === 'double_top' || p.type === 'double_bottom');
			expect(doubles.length).toBeGreaterThan(0);
			const doublesCompleted = doubles.filter((p) => p.status === 'completed');
			expect(doublesCompleted).toHaveLength(0);
		});
	});

	// ──────────────────────────────────────────────
	// 6. includeForming=false で forming / near_completion 除外
	// ──────────────────────────────────────────────
	describe('includeForming=false で forming / near_completion 除外', () => {
		it('forming fixture + includeForming=false → forming / near_completion が結果から除外される', async () => {
			const candles = buildFormingRisingWedgeCandles();

			// baseline: includeForming=true なら同じ fixture から forming/near_completion が出る
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
			const baseline = await detectPatterns('btc_jpy', '1day', candles.length, {
				patterns: ['rising_wedge'],
				includeForming: true,
				includeCompleted: true,
			});
			assertOk(baseline);
			const baselineFormingLike = baseline.data.patterns.filter(
				(p) => p.status === 'forming' || p.status === 'near_completion',
			);
			expect(baselineFormingLike.length).toBeGreaterThan(0);

			// includeForming=false → 上記が除外される
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
			const res = await detectPatterns('btc_jpy', '1day', candles.length, {
				patterns: ['rising_wedge'],
				includeForming: false,
				includeCompleted: true,
			});
			assertOk(res);
			const formingLike = res.data.patterns.filter((p) => p.status === 'forming' || p.status === 'near_completion');
			expect(formingLike).toHaveLength(0);
		});

		it('forming fixture + includeForming=true → forming / near_completion が結果に含まれる', async () => {
			const candles = buildFormingRisingWedgeCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
			const res = await detectPatterns('btc_jpy', '1day', candles.length, {
				patterns: ['rising_wedge'],
				includeForming: true,
				includeCompleted: true,
			});
			assertOk(res);
			const formingLike = res.data.patterns.filter((p) => p.status === 'forming' || p.status === 'near_completion');
			expect(formingLike.length).toBeGreaterThan(0);
		});

		it('forming fixture（symmetrical triangle）+ includeForming=false → forming / near_completion が結果から除外される', async () => {
			const candles = buildFormingSymmetricalTriangleCandles();

			// baseline: includeForming=true なら同じ fixture から forming/near_completion が出る
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
			const baseline = await detectPatterns('btc_jpy', '1day', candles.length, {
				patterns: ['triangle_symmetrical'],
				includeForming: true,
				includeCompleted: true,
			});
			assertOk(baseline);
			const baselineFormingLike = baseline.data.patterns.filter(
				(p) => p.status === 'forming' || p.status === 'near_completion',
			);
			expect(baselineFormingLike.length).toBeGreaterThan(0);

			// includeForming=false → 上記が除外される
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
			const res = await detectPatterns('btc_jpy', '1day', candles.length, {
				patterns: ['triangle_symmetrical'],
				includeForming: false,
				includeCompleted: true,
			});
			assertOk(res);
			const formingLike = res.data.patterns.filter((p) => p.status === 'forming' || p.status === 'near_completion');
			expect(formingLike).toHaveLength(0);
		});
	});

	// ──────────────────────────────────────────────
	// 7. allow_partial_patterns=false で uses_partial_candle スキップ
	//    （既存 tests/analyze_candle_patterns.test.ts:546-575 と重複するが、
	//     横断契約として明示的に再記載する）
	// ──────────────────────────────────────────────
	describe('allow_partial_patterns=false で uses_partial_candle スキップ', () => {
		it('最新ローソク足が「今日」かつ allow_partial_patterns=false → uses_partial_candle=true なパターンなし', async () => {
			// 最新ローソク足は「今日」(=未確定 partial)。中身は body=0.1/range=20 で doji 検出対象。
			const candles: Candle[] = [
				mc(2, 100, 106, 94, 103),
				mc(1, 103, 108, 95, 105),
				{
					isoTime: todayIso(),
					open: 105,
					high: 115,
					low: 95,
					close: 105.1,
					volume: 100,
				},
			];

			// baseline: allow_partial=true なら uses_partial_candle=true なパターン (doji/forming) が出る
			mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
			const baseline = await analyzeCandlePatterns({
				window_days: 3,
				focus_last_n: 3,
				patterns: ['doji'],
				allow_partial_patterns: true,
				history_lookback_days: 30,
			});
			assertOk(baseline);
			const baselinePartials = baseline.data.recent_patterns.filter((p) => p.uses_partial_candle);
			expect(baselinePartials.length).toBeGreaterThan(0);

			// allow_partial=false → 上記の partial パターンがスキップされる
			mockedGetCandles.mockResolvedValueOnce(asMockResult(candlesOk(candles)));
			const res = await analyzeCandlePatterns({
				window_days: 3,
				focus_last_n: 3,
				patterns: ['doji'],
				allow_partial_patterns: false,
				history_lookback_days: 30,
			});
			assertOk(res);
			for (const p of res.data.recent_patterns) {
				expect(p.uses_partial_candle).toBe(false);
				expect(p.status).toBe('confirmed');
			}
		});
	});
});
