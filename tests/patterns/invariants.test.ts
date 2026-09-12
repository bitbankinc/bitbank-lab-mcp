/**
 * tests/patterns/invariants.test.ts
 *
 * パターン検出系ツールの横断契約テスト。
 *
 * `analyze_candle_patterns` と `detect_patterns` 系列について、
 * 全パターンタイプ横断で守られるべき不変条件を fixture ベースで検証する。
 *
 * カバーする 8 つの不変条件:
 *   1. barIndex 整合
 *   2. 決定性（同一入力に対する deep equal）
 *   3. status enum の許容値
 *   4. completed は breakout 成立 fixture でのみ出る
 *   5. whipsaw fixture で completed にならない
 *   6. includeForming=false で forming / near_completion 除外
 *   7. allow_partial_patterns=false で uses_partial_candle スキップ
 *   8. statistics と data.patterns の対象集合が一致する
 *   9. 各検出器の最小要求バー数が既定スキャン窓に収まる（到達性）
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

import { CandleTypeEnum } from '../../src/schema/base.js';
import { DetectPatternsInputSchema } from '../../src/schema/patterns.js';
import analyzeCandlePatterns from '../../tools/analyze_candle_patterns.js';
import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import getCandles from '../../tools/get_candles.js';
import { getDefaultParamsForTf } from '../../tools/patterns/config.js';
import { MIN_BARS_DETECTORS, type MinBarsDetector, minBarsForDetector } from '../../tools/patterns/min-bars.js';
import { assessScanWindow } from '../../tools/patterns/scan-window.js';

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
	// （analyze_candle_patterns.ts）。テスト側もローカル TZ ではなく必ず JST の「今日」
	// を基準に組み立てないと、UTC 環境で 15:00 以降（= JST 翌日 00:00 以降）に走らせた
	// とき、ローカル日付（前日）と JST 日付（翌日）がズレて isLastPartial=false になり、
	// partial 検出が外れる。`YYYY-MM-DD（JST）T00:00:00.000Z` は JST 09:00 にあたり、
	// calendarDateFromIso() で同じ JST 日付に戻る。
	return `${dayjs().tz('Asia/Tokyo').format('YYYY-MM-DD')}T00:00:00.000Z`;
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
	// 谷1(idx=4) → 山(idx=10) → 谷2(idx=16) → 直近が上昇中（3 点目が未確定）。
	// `1day` の形成中 double は formationBars（= lastIdx - 谷1.idx）∈ [23, 148] を要求するので
	// 末尾を伸ばして formationBars=25 にしてある（#118 問題 3 のバー数統一。旧実装は 19 本で通っていた）。
	// 中間の山（101）を 1.5% のブレイクバッファ込みで超えないよう、末尾は 98 で頭打ちにする。
	const closes = [
		108, 104, 99, 92, 80, 84, 88, 92, 96, 99, 101, 98, 94, 89, 85, 82, 81, 84, 88, 91, 94, 95, 96, 95, 96, 96.5, 97,
		97.5, 98, 98,
	];
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
 * descending triangle + 逆方向（上方）ブレイク → status='invalid' を生成する fixture。
 * tests/detect_patterns_fixtures.test.ts の同名関数と等価の価格列。
 */
function buildDescendingTriangleInvalidBreakoutCandles(year = 2026): Candle[] {
	// 三角形本体は 24 本（旧 fixture の 18 本に 1 サイクル 6 本を先頭で追加）。
	// `detect_triangles` の最小窓が時間足の構造的下限（1day = 23 本）になったため、
	// 旧 fixture（本体 18 本）では windowSizes が空になり検出されない。
	// 追加分は既存と同じ形（切り下がる高値・水平な安値 100〜101）を 1 サイクル伸ばしただけ。
	const closes = [
		130, 140, 132, 122, 100, 118, 120, 130, 124, 116, 100, 112, 125, 118, 101, 110, 120, 114, 100, 108, 115, 110, 101,
		107, 128, 132, 130, 128, 126, 124,
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

		// #125: 報告された price から判定を検算できること。
		// price は終値、extremePrice は極値判定に使った high / low で、両者は別物。
		// これを落とすと「終値基準で極値を取っている」と誤読される（実際に誤読された）。
		it('detect_patterns: 全 pivot が kind と、その足の high / low に一致する extremePrice を持つ', async () => {
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
					name: 'forming_double_bottom',
					candles: buildFormingDoubleBottomCandles(),
					opts: { patterns: ['double_bottom'], includeForming: true, swingDepth: 2, tolerancePct: 0.03 },
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
					name: 'triangle_symmetrical',
					candles: buildFormingSymmetricalTriangleCandles(),
					opts: { patterns: ['triangle_symmetrical'], includeForming: true },
				},
			];

			let seenPivots = 0;
			for (const fx of fixtures) {
				mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(fx.candles)));
				const res = await detectPatterns('btc_jpy', '1day', fx.candles.length, fx.opts);
				assertOk(res);
				const lastIdx = fx.candles.length - 1;
				for (const p of res.data.patterns) {
					for (const pv of p.pivots ?? []) {
						seenPivots++;
						expect(['H', 'L'], `${fx.name}: pivot kind`).toContain(pv.kind);
						expect(Number.isFinite(pv.extremePrice), `${fx.name}: extremePrice 有限`).toBe(true);
						const c = fx.candles[pv.idx];
						// 形成中パターンの暫定構成点は最新足の終値（極値判定を通っていない）ので除く。
						if (pv.idx === lastIdx && pv.extremePrice === pv.price) continue;
						// triangle_* は独自 relaxed swing（price が最初から high / low）なので price 側も極値。
						const expected = pv.kind === 'H' ? c.high : c.low;
						expect(pv.extremePrice, `${fx.name}: idx=${pv.idx} の extremePrice`).toBe(expected);
					}
				}
			}
			expect(seenPivots, 'fixture が 1 つも pivot を返していない（テストが空回り）').toBeGreaterThan(0);
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
			// 注: detect_doubles は完成済みでも明示的な status='completed' を付与しない
			// （status=undefined のまま）。detect_triples / detect_hs はネックラインブレイク
			// 確認で status='completed' を付与する。
			// このテストでは明示的に completed が出る pennant / triangle / wedge を使う。
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
	// 6.5 H&S / 逆H&S 契約: completed は必ず neckline_breakout を持ち、status は常に存在
	// ──────────────────────────────────────────────
	describe('H&S / inverse H&S contract', () => {
		it('completed の H&S は confirmation.type === neckline_breakout を持つ', async () => {
			const candles = buildCompletedHeadAndShouldersCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
			const res = await detectPatterns('btc_jpy', '1day', candles.length, {
				patterns: ['head_and_shoulders'],
				swingDepth: 2,
				tolerancePct: 0.04,
				includeForming: true,
				includeCompleted: true,
			});
			assertOk(res);
			const hsCompleted = res.data.patterns.filter(
				(p) => (p.type === 'head_and_shoulders' || p.type === 'inverse_head_and_shoulders') && p.status === 'completed',
			);
			// vacuous pass 防止: 少なくとも 1 件は completed が出る fixture を使っている
			expect(hsCompleted.length).toBeGreaterThan(0);
			for (const p of hsCompleted) {
				expect(p.confirmation?.type).toBe('neckline_breakout');
			}
		});

		it('H&S / 逆H&S の status は必ず存在する（undefined を返さない）', async () => {
			const candles = buildCompletedHeadAndShouldersCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
			const res = await detectPatterns('btc_jpy', '1day', candles.length, {
				patterns: ['head_and_shoulders', 'inverse_head_and_shoulders'],
				swingDepth: 2,
				tolerancePct: 0.04,
				includeForming: true,
				includeCompleted: true,
			});
			assertOk(res);
			const hsTargets = res.data.patterns.filter(
				(p) => p.type === 'head_and_shoulders' || p.type === 'inverse_head_and_shoulders',
			);
			expect(hsTargets.length).toBeGreaterThan(0);
			for (const p of hsTargets) {
				expect(p.status).toBeDefined();
				expect(['completed', 'near_completion', 'forming']).toContain(p.status);
			}
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

	// ──────────────────────────────────────────────
	// 8. statistics と data.patterns の対象集合が一致する
	//    （includeForming / includeCompleted / includeInvalid で除外されたパターンが
	//      statistics に紛れ込まないこと）
	// ──────────────────────────────────────────────
	describe('statistics と data.patterns の対象集合一致', () => {
		it('statistics の各 type.detected が data.patterns 内の同 type 件数と一致する', async () => {
			const fixtures: Array<{ name: string; candles: Candle[]; opts: Parameters<typeof detectPatterns>[3] }> = [
				{
					name: 'triangle_symmetrical + forming',
					candles: buildFormingSymmetricalTriangleCandles(),
					opts: { patterns: ['triangle_symmetrical'], includeForming: true, includeCompleted: true },
				},
				{
					name: 'rising_wedge + forming',
					candles: buildFormingRisingWedgeCandles(),
					opts: { patterns: ['rising_wedge'], includeForming: true, includeCompleted: true },
				},
				{
					name: 'bull pennant + completed',
					candles: buildBullPennantSuccessCandles(),
					opts: { patterns: ['pennant'], includeCompleted: true, includeInvalid: true },
				},
				{
					name: 'double_top + completed',
					candles: buildCompletedDoubleTopCandles(),
					opts: { patterns: ['double_top'], swingDepth: 2, tolerancePct: 0.02 },
				},
			];

			for (const fx of fixtures) {
				mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(fx.candles)));
				const res = await detectPatterns('btc_jpy', '1day', fx.candles.length, fx.opts);
				assertOk(res);

				const patternCounts: Record<string, number> = {};
				for (const p of res.data.patterns) {
					patternCounts[p.type] = (patternCounts[p.type] || 0) + 1;
				}

				const stats = (res.data.statistics ?? {}) as Record<string, { detected: number }>;
				for (const [type, stat] of Object.entries(stats)) {
					expect(stat.detected, `${fx.name}: statistics.${type}.detected vs data.patterns count`).toBe(
						patternCounts[type] ?? 0,
					);
				}
				for (const type of Object.keys(patternCounts)) {
					expect(stats, `${fx.name}: statistics has key for type ${type}`).toHaveProperty(type);
				}
			}
		});

		it('includeInvalid=false で invalid パターンが除外されたとき statistics にも残らない', async () => {
			// baseline: includeInvalid=true で invalid な triangle_descending が data.patterns / statistics 両方に出る
			const candles = buildDescendingTriangleInvalidBreakoutCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
			const baseline = await detectPatterns('btc_jpy', '1day', candles.length, {
				patterns: ['triangle_descending'],
				includeCompleted: true,
				includeInvalid: true,
			});
			assertOk(baseline);
			const baselineInvalid = baseline.data.patterns.filter((p) => p.status === 'invalid');
			expect(baselineInvalid.length).toBeGreaterThan(0);
			expect(baseline.data.statistics).toHaveProperty('triangle_descending');

			// includeInvalid=false → data.patterns から除外されると同時に statistics からも消える
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
			const res = await detectPatterns('btc_jpy', '1day', candles.length, {
				patterns: ['triangle_descending'],
				includeCompleted: true,
				includeInvalid: false,
			});
			assertOk(res);
			expect(res.data.patterns).toEqual([]);
			expect(res.data.statistics ?? {}).toEqual({});
		});

		it('includeForming=false で forming パターンが除外されたとき statistics にも残らない', async () => {
			// baseline: includeForming=true で forming な rising_wedge が statistics に含まれる
			const candles = buildFormingRisingWedgeCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
			const baseline = await detectPatterns('btc_jpy', '1day', candles.length, {
				patterns: ['rising_wedge'],
				includeForming: true,
				includeCompleted: true,
			});
			assertOk(baseline);
			const baselineFormingTypes = new Set(
				baseline.data.patterns
					.filter((p) => p.status === 'forming' || p.status === 'near_completion')
					.map((p) => p.type),
			);
			expect(baselineFormingTypes.size).toBeGreaterThan(0);

			// includeForming=false → forming 除外後の data.patterns と statistics が一致する
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
			const res = await detectPatterns('btc_jpy', '1day', candles.length, {
				patterns: ['rising_wedge'],
				includeForming: false,
				includeCompleted: true,
			});
			assertOk(res);

			const patternCounts: Record<string, number> = {};
			for (const p of res.data.patterns) {
				patternCounts[p.type] = (patternCounts[p.type] || 0) + 1;
			}
			const statsTypes = Object.keys(res.data.statistics ?? {});
			expect(new Set(statsTypes)).toEqual(new Set(Object.keys(patternCounts)));
			for (const [type, stat] of Object.entries((res.data.statistics ?? {}) as Record<string, { detected: number }>)) {
				expect(stat.detected).toBe(patternCounts[type] ?? 0);
			}
		});
	});
});

// ──────────────────────────────────────────────
// 9. 到達性 — 各検出器の最小要求バー数 <= 既定スキャン窓
//
//    #114 でスキャン窓が「直近 limit 本」に一致した結果、日数ベースの閾値が窓を超えると
//    **そのパターン種別だけが静かに 0 件になる**（issue #118）。閾値は 6 ファイルに散っていて
//    人手では追えないので、`patterns/min-bars.ts` の導出値で機械的に固定する。
//
//    PR A ではこの表を allowlist（既知の未到達 16 組）付きで導入した。閾値のプリミティブを
//    バー数に統一した（`patterns/bar-thresholds.ts`）ことで**全 16 組が解消し、allowlist は
//    空になった**。以降は「未到達の組み合わせが 1 つも無い」が不変条件そのものになる。
//    `detect_doubles` / `detect_hs` の形成中判定も同じ換算に乗ったので（#118 問題 3）、
//    全検出器がこの表の対象になっている。
//
//    このテストは「閾値の**最小側**が窓に収まるか」だけを見る。窓に収まっていても
//    検出できるとは限らない（形状の条件は別）。**最大側も見ていない**——旧実装の `1week` は
//    最小側が 2〜3 本で到達可能に見えて、最大側（12 本）が構造的下限（25 本）を下回るため
//    実質検出不能だった。最大側を含む実検出は `tests/patterns/default-limit-detection.test.ts`
//    が合成データで固定する。
// ──────────────────────────────────────────────

describe('検出器の到達性 — 最小要求バー数 vs 既定スキャン窓', () => {
	const ALL_TIMEFRAMES = CandleTypeEnum.options;
	/** 既定のスキャン窓。detect_patterns は直近 limit 本をそのまま検出器に渡す（#114）。 */
	const DEFAULT_SCAN_WINDOW = DetectPatternsInputSchema.shape.limit.parse(undefined) as number;

	/**
	 * 既定 `limit` では閾値に届かない組み合わせ。**現在は空**。
	 *
	 * 例外を足すときは `requiredBars`（`minBarsForDetector` の期待値）と理由を必ず書く。
	 * 下の「allowlist は空」テストがループで各行を検証するので、閾値を下げて到達可能に
	 * なった行を消し忘れると落ちる（stale 検出）。
	 */
	const KNOWN_UNREACHABLE: ReadonlyArray<{
		tf: string;
		detector: MinBarsDetector;
		requiredBars: number;
		reason: string;
	}> = [];

	const allowKey = (tf: string, detector: MinBarsDetector) => `${tf} ${detector}`;
	const allowlist = new Map(KNOWN_UNREACHABLE.map((e) => [allowKey(e.tf, e.detector), e]));

	it('既定 limit は 90（到達性判定の前提）', () => {
		expect(DEFAULT_SCAN_WINDOW).toBe(90);
	});

	it('全時間足 × 全検出器が既定 limit で到達可能（allowlist 外に未到達が無い）', () => {
		const unexpected: string[] = [];
		for (const tf of ALL_TIMEFRAMES) {
			for (const detector of MIN_BARS_DETECTORS) {
				const required = minBarsForDetector(tf, detector);
				if (required <= DEFAULT_SCAN_WINDOW) continue;
				if (allowlist.has(allowKey(tf, detector))) continue;
				unexpected.push(`${tf} x ${detector}: ${required}本 > 窓 ${DEFAULT_SCAN_WINDOW}本`);
			}
		}
		expect(unexpected, `既定 limit で到達不能な組み合わせ:\n${unexpected.join('\n')}`).toEqual([]);
	});

	it('allowlist は空 — 例外行が残っている場合はその内容も検証する', () => {
		for (const entry of KNOWN_UNREACHABLE) {
			// 時間足 / 検出器の typo 検出
			expect(ALL_TIMEFRAMES, `allowlist の時間足: ${entry.tf}`).toContain(entry.tf);
			expect(MIN_BARS_DETECTORS, `allowlist の検出器: ${entry.detector}`).toContain(entry.detector);
			// 要求本数の一致と、実際に未到達であること（stale 行の検出）
			const required = minBarsForDetector(entry.tf, entry.detector);
			expect(required, `allowlist: ${entry.tf} x ${entry.detector} の要求本数`).toBe(entry.requiredBars);
			expect(
				required,
				`allowlist: ${entry.tf} x ${entry.detector} は既定 limit で到達可能になっている。allowlist から行を消すこと`,
			).toBeGreaterThan(DEFAULT_SCAN_WINDOW);
		}
		// 重複行の検出も兼ねる（Map に畳んだ数が元の行数と一致すること）
		expect(allowlist.size, 'allowlist に重複行がある').toBe(KNOWN_UNREACHABLE.length);
		expect(KNOWN_UNREACHABLE, '未到達の例外は解消済み。行を足すなら理由を添えること').toEqual([]);
	});

	it('構造的下限（assessScanWindow）は全時間足で既定スキャン窓に収まる', () => {
		// パターンサイズ閾値とは別軸の下限（#117 / docs 表 1）。こちらは既定 limit で全時間足が通る。
		for (const tf of ALL_TIMEFRAMES) {
			const { swingDepth, minBarsBetweenSwings } = getDefaultParamsForTf(tf);
			const a = assessScanWindow(DEFAULT_SCAN_WINDOW, swingDepth, minBarsBetweenSwings);
			expect(a.sufficient, `${tf}: 構造的下限 ${a.minViableLimit}本 > 窓 ${DEFAULT_SCAN_WINDOW}本`).toBe(true);
		}
	});
});
