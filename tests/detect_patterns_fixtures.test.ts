import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../lib/datetime.js';
import { asMockResult, assertOk } from './_assertResult.js';

vi.mock('../tools/analyze_indicators.js', () => ({
	default: vi.fn(),
}));

import analyzeIndicators from '../tools/analyze_indicators.js';
import detectPatterns from '../tools/detect_patterns.js';

import {
	buildAsymmetricNecklineHSCandles,
	buildAsymmetricNecklineIHSCandles,
	buildBullFlagFailureCandles,
	buildBullPennantFailureCandles,
	buildBullPennantSuccessCandles,
	buildCompletedDoubleTopCandles,
	buildCompletedFallingWedgeCandles,
	buildCompletedHeadAndShouldersCandles,
	buildCompletedTripleTopCandles,
	buildDescendingTriangleInvalidBreakoutCandles,
	buildDowntrendThenFakeHSCandles,
	buildFormingAscendingTriangleCandles,
	buildFormingDoubleBottomCandles,
	buildFormingInverseHeadAndShouldersCandles,
	buildFormingRisingWedgeCandles,
	buildFormingSymmetricalTriangleCandles,
	buildFormingTripleBottomCandles,
	buildRectangleRangeCandles,
	buildRisingChannelCandles,
	buildUnequalPeaksDoubleTopCandles,
	buildUnequalValleysDoubleBottomCandles,
	buildUptrendThenFakeDoubleBottomCandles,
	type Candle,
	FORMING_DOUBLE_BOTTOM_BARS,
	makeCandle,
	makeIso,
	UPTREND_FAKE_DOUBLE_BOTTOM_BARS,
} from './fixtures/synthetic_pattern_candles.js';

/** `analyze_indicators` の成功レスポンスの最小形（`detect_patterns` はここから `chart.candles` だけを読む）。 */
function indicatorsOk(candles: Candle[]) {
	return {
		ok: true,
		summary: 'ok',
		data: {
			chart: {
				candles,
			},
		},
	};
}

describe('detect_patterns fixtures', () => {
	const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('synthetic fixture から completed の double_top を検出できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildCompletedDoubleTopCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 26, {
			patterns: ['double_top'],
			swingDepth: 2,
			tolerancePct: 0.02,
			includeCompleted: true,
			includeForming: false,
		});
		assertOk(res);
		expect(res.data.patterns).toHaveLength(1);
		expect(res.data.patterns[0]).toMatchObject({
			type: 'double_top',
			timeframe: '1day',
			timeframeLabel: '日足',
			trendlineLabel: 'ネックライン',
			breakoutBarIndex: 20,
			targetMethod: 'neckline_projection',
			aftermath: {
				breakoutConfirmed: true,
			},
		});
		expect(res.data.overlays?.ranges).toEqual([
			{
				start: makeIso(5),
				end: makeIso(20),
				label: 'double_top',
			},
		]);
		expect(res.meta.count).toBe(1);
	});

	/**
	 * **`status` の期待値を `forming` から `near_completion` に変えた（issue #262）。**
	 * この synthetic fixture は「確定 2 谷 + 中間の山が揃い、ネックライン突破を待っている」形で、
	 * 旧 `tryFormingDoubleBottom` がそれを `forming` と呼んでいた。完成済み経路の
	 * `near_completion` に付け替えたのが #262。`completionPct` は完成度スコアごと消えた
	 * （triple / H&S の `near_completion` も持たない）。**`range.end` も最新足から谷2 になった**。
	 */
	it('synthetic fixture から near_completion の double_bottom を completed なしで返せる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildFormingDoubleBottomCandles())));

		const res = await detectPatterns('btc_jpy', '1day', FORMING_DOUBLE_BOTTOM_BARS, {
			patterns: ['double_bottom'],
			swingDepth: 2,
			tolerancePct: 0.03,
			includeForming: true,
			includeCompleted: false,
		});

		assertOk(res);
		expect(res.data.patterns).toHaveLength(1);
		expect(res.data.patterns[0]).toMatchObject({
			type: 'double_bottom',
			status: 'near_completion',
			timeframe: '1day',
			timeframeLabel: '日足',
			trendlineLabel: 'ネックライン',
			targetMethod: 'neckline_projection',
			targetProgressOmittedReason: 'not_broken_out',
		});
		expect(res.data.patterns[0].completionPct).toBeUndefined();
		// `range.end` は第2構成点（谷2）。`structureRange` と一致する（`detect_triples` と同じ）。
		expect(res.data.patterns[0].range.end).toBe(res.data.patterns[0].structureRange?.end);
		expect(res.meta.count).toBe(1);
	});

	it('requireCurrentInPattern=true のとき古い fixture は除外される', async () => {
		vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildCompletedDoubleTopCandles(2025))));

		const res = await detectPatterns('btc_jpy', '1day', 26, {
			patterns: ['double_top'],
			swingDepth: 2,
			tolerancePct: 0.02,
			requireCurrentInPattern: true,
			currentRelevanceDays: 7,
		});

		assertOk(res);
		expect(res.data.patterns).toEqual([]);
		expect(res.data.overlays?.ranges).toEqual([]);
		expect(res.meta.count).toBe(0);
	});

	it('descending triangle の逆方向ブレイクは invalid / failure として保持できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk(buildDescendingTriangleInvalidBreakoutCandles())),
		);

		const res = await detectPatterns('btc_jpy', '1day', 24, {
			patterns: ['triangle_descending'],
			includeCompleted: true,
			includeInvalid: true,
		});

		assertOk(res);
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'triangle_descending',
					status: 'invalid',
					breakoutDirection: 'up',
					outcome: 'failure',
					timeframe: '1day',
					timeframeLabel: '日足',
				}),
			]),
		);
	});

	it('includeInvalid=false のとき invalid な triangle は結果から除外される', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk(buildDescendingTriangleInvalidBreakoutCandles())),
		);

		const res = await detectPatterns('btc_jpy', '1day', 24, {
			patterns: ['triangle_descending'],
			includeCompleted: true,
			includeInvalid: false,
		});

		assertOk(res);
		expect(res.data.patterns).toEqual([]);
	});

	it('矩形レンジの fixture を triangle として誤検出しない', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildRectangleRangeCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 24, {
			patterns: ['triangle'],
			includeForming: true,
			includeCompleted: true,
			includeInvalid: true,
		});

		assertOk(res);
		expect(res.data.patterns).toEqual([]);
	});

	it('平行な上昇チャネルの fixture を wedge として誤検出しない', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildRisingChannelCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 30, {
			patterns: ['rising_wedge', 'falling_wedge'],
			includeForming: true,
			includeCompleted: true,
			includeInvalid: true,
		});

		assertOk(res);
		expect(res.data.patterns).toEqual([]);
	});

	it('bull flag の逆方向ブレイクは invalid / failure として保持できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildBullFlagFailureCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 20, {
			patterns: ['flag'],
			includeCompleted: true,
			includeInvalid: true,
		});

		assertOk(res);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'bull_flag',
					status: 'invalid',
					breakoutDirection: 'down',
					outcome: 'failure',
					timeframe: '1day',
					timeframeLabel: '日足',
					targetMethod: 'flagpole_projection',
					expectedBreakoutDirection: 'up',
				}),
			]),
		);
	});

	it('bull pennant の順方向ブレイクは success として保持できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildBullPennantSuccessCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 28, {
			patterns: ['pennant'],
			includeCompleted: true,
			includeInvalid: true,
		});

		assertOk(res);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'bull_pennant',
					status: 'completed',
					poleDirection: 'up',
					breakoutDirection: 'up',
					outcome: 'success',
					isTrendContinuation: true,
					timeframe: '1day',
					timeframeLabel: '日足',
					targetMethod: 'flagpole_projection',
					expectedBreakoutDirection: 'up',
				}),
			]),
		);
	});

	it('bull pennant の逆方向ブレイクは failure として保持できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildBullPennantFailureCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 28, {
			patterns: ['pennant'],
			includeCompleted: true,
			includeInvalid: true,
		});

		assertOk(res);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'bull_pennant',
					poleDirection: 'up',
					breakoutDirection: 'down',
					outcome: 'failure',
					isTrendContinuation: false,
					timeframe: '1day',
					timeframeLabel: '日足',
					targetMethod: 'flagpole_projection',
					expectedBreakoutDirection: 'up',
				}),
			]),
		);
	});

	it('synthetic fixture から triple_top を検出できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildCompletedTripleTopCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 30, {
			patterns: ['triple_top'],
			swingDepth: 2,
			tolerancePct: 0.02,
			includeCompleted: true,
			includeForming: true,
		});

		assertOk(res);
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'triple_top',
					timeframe: '1day',
					timeframeLabel: '日足',
					targetMethod: 'neckline_projection',
				}),
			]),
		);
	});

	it('synthetic fixture から triple_bottom を検出できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildFormingTripleBottomCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 28, {
			patterns: ['triple_bottom'],
			swingDepth: 2,
			tolerancePct: 0.02,
			includeForming: true,
			includeCompleted: true,
		});

		assertOk(res);
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'triple_bottom',
					timeframe: '1day',
					timeframeLabel: '日足',
					targetMethod: 'neckline_projection',
				}),
			]),
		);
	});

	it('synthetic fixture から head_and_shoulders を検出できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildCompletedHeadAndShouldersCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 28, {
			patterns: ['head_and_shoulders'],
			swingDepth: 2,
			tolerancePct: 0.04,
			includeCompleted: true,
			includeForming: true,
		});

		assertOk(res);
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'head_and_shoulders',
					timeframe: '1day',
					timeframeLabel: '日足',
					targetMethod: 'neckline_projection',
				}),
			]),
		);
	});

	it('synthetic fixture から inverse_head_and_shoulders を検出できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk(buildFormingInverseHeadAndShouldersCandles())),
		);

		const res = await detectPatterns('btc_jpy', '1day', 26, {
			patterns: ['inverse_head_and_shoulders'],
			swingDepth: 2,
			tolerancePct: 0.04,
			includeForming: true,
			includeCompleted: true,
		});

		assertOk(res);
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'inverse_head_and_shoulders',
					timeframe: '1day',
					timeframeLabel: '日足',
					targetMethod: 'neckline_projection',
				}),
			]),
		);
	});

	it('synthetic fixture から forming の rising_wedge を検出できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildFormingRisingWedgeCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 35, {
			patterns: ['rising_wedge'],
			includeForming: true,
			includeCompleted: true,
		});

		assertOk(res);
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'rising_wedge',
					status: expect.stringMatching(/^(forming|near_completion)$/),
					timeframe: '1day',
					timeframeLabel: '日足',
				}),
			]),
		);
	});

	it('synthetic fixture から completed の falling_wedge を検出できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildCompletedFallingWedgeCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 37, {
			patterns: ['falling_wedge'],
			includeCompleted: true,
			includeForming: true,
		});

		assertOk(res);
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'falling_wedge',
					timeframe: '1day',
					timeframeLabel: '日足',
				}),
			]),
		);
	});

	// PR1: includeForming=false でも完成済み wedge が forming 候補に潰されないこと
	it('includeCompleted=true / includeForming=false でも completed wedge は検出される', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildCompletedFallingWedgeCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 37, {
			patterns: ['falling_wedge'],
			includeCompleted: true,
			includeForming: false,
		});

		assertOk(res);
		// completed wedge が残っている（forming 候補に dedup で潰されていない）
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'falling_wedge',
					timeframe: '1day',
					timeframeLabel: '日足',
				}),
			]),
		);
		// 残ったパターンは completed 系であって、forming / near_completion は混ざらない
		// （includeForming=false の段階で forming と near_completion を弾いているため）
		for (const p of res.data.patterns) {
			expect(['completed', 'invalid', undefined]).toContain(p.status);
		}
	});

	it('synthetic fixture から forming の triangle_ascending を検出できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildFormingAscendingTriangleCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 33, {
			patterns: ['triangle_ascending'],
			includeForming: true,
			includeCompleted: true,
		});

		assertOk(res);
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'triangle_ascending',
					status: expect.stringMatching(/^(forming|near_completion)$/),
					timeframe: '1day',
					timeframeLabel: '日足',
				}),
			]),
		);
	});

	it('synthetic fixture から forming の triangle_symmetrical を検出できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildFormingSymmetricalTriangleCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 36, {
			patterns: ['triangle_symmetrical'],
			includeForming: true,
			includeCompleted: true,
		});

		assertOk(res);
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'triangle_symmetrical',
					status: expect.stringMatching(/^(forming|near_completion)$/),
					timeframe: '1day',
					timeframeLabel: '日足',
				}),
			]),
		);
	});

	// ── ネックライン水平性 / double 構造上限 hard cap（PR #2） ──
	describe('反転パターン構造上限の hard reject', () => {
		it('IHS: 山1/山2 が同水準でない場合 inverse_head_and_shoulders を検出しない', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildAsymmetricNecklineIHSCandles())));
			const res = await detectPatterns('btc_jpy', '1day', 32, {
				patterns: ['inverse_head_and_shoulders'],
				swingDepth: 2,
				tolerancePct: 0.04,
				includeCompleted: true,
				includeForming: false,
			});
			assertOk(res);
			const ihs = res.data.patterns.filter((p: { type: string }) => p.type === 'inverse_head_and_shoulders');
			expect(ihs).toHaveLength(0);
		});

		it('IHS: view=debug の data.debug.candidates に neckline_not_horizontal が記録される', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildAsymmetricNecklineIHSCandles())));
			const res = await detectPatterns('btc_jpy', '1day', 32, {
				patterns: ['inverse_head_and_shoulders'],
				swingDepth: 2,
				tolerancePct: 0.04,
				includeCompleted: true,
				includeForming: false,
				view: 'debug',
			});
			assertOk(res);
			const candidates = (res.meta.debug?.candidates ?? []) as Array<{
				type: string;
				accepted: boolean;
				reason?: string;
			}>;
			const rejected = candidates.find(
				(c) =>
					c.type === 'inverse_head_and_shoulders' && c.accepted === false && c.reason === 'neckline_not_horizontal',
			);
			expect(rejected).toBeDefined();
		});

		it('H&S: 谷1/谷2 が同水準でない場合 head_and_shoulders を検出しない', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildAsymmetricNecklineHSCandles())));
			const res = await detectPatterns('btc_jpy', '1day', 32, {
				patterns: ['head_and_shoulders'],
				swingDepth: 2,
				tolerancePct: 0.04,
				includeCompleted: true,
				includeForming: false,
			});
			assertOk(res);
			const hs = res.data.patterns.filter((p: { type: string }) => p.type === 'head_and_shoulders');
			expect(hs).toHaveLength(0);
		});

		it('double_top: tolerancePct=0.06 でも 2山差が3%超なら検出しない', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildUnequalPeaksDoubleTopCandles())));
			const res = await detectPatterns('btc_jpy', '1day', 28, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.06,
				includeCompleted: true,
				includeForming: false,
			});
			assertOk(res);
			const dt = res.data.patterns.filter((p: { type: string }) => p.type === 'double_top');
			expect(dt).toHaveLength(0);
		});

		it('double_top: view=debug の data.debug.candidates に peaks_not_equal_structural が記録される', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildUnequalPeaksDoubleTopCandles())));
			const res = await detectPatterns('btc_jpy', '1day', 28, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.06,
				includeCompleted: true,
				includeForming: false,
				view: 'debug',
			});
			assertOk(res);
			const candidates = (res.meta.debug?.candidates ?? []) as Array<{
				type: string;
				accepted: boolean;
				reason?: string;
			}>;
			const rejected = candidates.find(
				(c) => c.type === 'double_top' && c.accepted === false && c.reason === 'peaks_not_equal_structural',
			);
			expect(rejected).toBeDefined();
		});

		it('double_bottom: tolerancePct=0.06 でも 2谷差が3%超なら検出しない', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult(indicatorsOk(buildUnequalValleysDoubleBottomCandles())),
			);
			const res = await detectPatterns('btc_jpy', '1day', 28, {
				patterns: ['double_bottom'],
				swingDepth: 2,
				tolerancePct: 0.06,
				includeCompleted: true,
				includeForming: false,
			});
			assertOk(res);
			const db = res.data.patterns.filter((p: { type: string }) => p.type === 'double_bottom');
			expect(db).toHaveLength(0);
		});

		it('double_bottom: view=debug の data.debug.candidates に valleys_not_equal_structural が記録される', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult(indicatorsOk(buildUnequalValleysDoubleBottomCandles())),
			);
			const res = await detectPatterns('btc_jpy', '1day', 28, {
				patterns: ['double_bottom'],
				swingDepth: 2,
				tolerancePct: 0.06,
				includeCompleted: true,
				includeForming: false,
				view: 'debug',
			});
			assertOk(res);
			const candidates = (res.meta.debug?.candidates ?? []) as Array<{
				type: string;
				accepted: boolean;
				reason?: string;
			}>;
			const rejected = candidates.find(
				(c) => c.type === 'double_bottom' && c.accepted === false && c.reason === 'valleys_not_equal_structural',
			);
			expect(rejected).toBeDefined();
		});

		// ── 非退行：既存 fixture が引き続き検出されることを担保 ──
		it('既存 double_top fixture は引き続き検出され、confidence は維持される', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildCompletedDoubleTopCandles())));
			const res = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
				includeCompleted: true,
				includeForming: false,
			});
			assertOk(res);
			const dt = res.data.patterns.filter((p: { type: string }) => p.type === 'double_top');
			expect(dt).toHaveLength(1);
			expect(dt[0].confidence).toBeGreaterThanOrEqual(0.6);
		});

		// `status` の期待値が `near_completion` に変わった理由は上の同 fixture のテストを参照（#262）。
		it('既存 forming double_bottom fixture は引き続き検出され、confidence は維持される', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildFormingDoubleBottomCandles())));
			const res = await detectPatterns('btc_jpy', '1day', FORMING_DOUBLE_BOTTOM_BARS, {
				patterns: ['double_bottom'],
				swingDepth: 2,
				tolerancePct: 0.03,
				includeForming: true,
				includeCompleted: false,
			});
			assertOk(res);
			const db = res.data.patterns.filter((p: { type: string }) => p.type === 'double_bottom');
			expect(db).toHaveLength(1);
			expect(db[0].status).toBe('near_completion');
			expect(db[0].confidence).toBeGreaterThanOrEqual(0.4);
		});

		it('既存 completed head_and_shoulders fixture は引き続き検出される', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult(indicatorsOk(buildCompletedHeadAndShouldersCandles())),
			);
			const res = await detectPatterns('btc_jpy', '1day', 28, {
				patterns: ['head_and_shoulders'],
				swingDepth: 2,
				tolerancePct: 0.04,
				includeCompleted: true,
				includeForming: true,
			});
			assertOk(res);
			const hs = res.data.patterns.filter((p: { type: string }) => p.type === 'head_and_shoulders');
			expect(hs.length).toBeGreaterThanOrEqual(1);
		});

		it('既存 forming inverse_head_and_shoulders fixture は引き続き検出される', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult(indicatorsOk(buildFormingInverseHeadAndShouldersCandles())),
			);
			const res = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['inverse_head_and_shoulders'],
				swingDepth: 2,
				tolerancePct: 0.04,
				includeForming: true,
				includeCompleted: true,
			});
			assertOk(res);
			const ihs = res.data.patterns.filter((p: { type: string }) => p.type === 'inverse_head_and_shoulders');
			expect(ihs.length).toBeGreaterThanOrEqual(1);
		});
	});

	// ── 形成前トレンド方向の hard reject（PR #3） ──
	describe('反転パターン形成前トレンドの hard reject', () => {
		it('上昇トレンド継続中は forming の double_bottom を検出しない（priorReturn が up）', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult(indicatorsOk(buildUptrendThenFakeDoubleBottomCandles())),
			);

			const res = await detectPatterns('btc_jpy', '1day', UPTREND_FAKE_DOUBLE_BOTTOM_BARS, {
				patterns: ['double_bottom'],
				swingDepth: 2,
				tolerancePct: 0.04,
				includeForming: true,
				includeCompleted: true,
			});

			assertOk(res);
			const dbs = res.data.patterns.filter((p: { type: string }) => p.type === 'double_bottom');
			expect(dbs).toHaveLength(0);

			const debugCands =
				(res.meta?.debug as { candidates?: Array<{ accepted?: boolean; reason?: string }> } | undefined)?.candidates ??
				[];
			const priorTrendRejects = debugCands.filter(
				(c) => !c.accepted && typeof c.reason === 'string' && c.reason.startsWith('prior_trend_mismatch'),
			);
			expect(priorTrendRejects.length).toBeGreaterThan(0);
		});

		it('下降トレンド継続中は head_and_shoulders を検出しない（priorReturn が down）', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildDowntrendThenFakeHSCandles())));

			const res = await detectPatterns('btc_jpy', '1day', 49, {
				patterns: ['head_and_shoulders'],
				swingDepth: 2,
				tolerancePct: 0.04,
				includeCompleted: true,
				includeForming: false,
			});

			assertOk(res);
			const hsPatterns = res.data.patterns.filter((p: { type: string }) => p.type === 'head_and_shoulders');
			expect(hsPatterns).toHaveLength(0);

			const debugCands =
				(res.meta?.debug as { candidates?: Array<{ accepted?: boolean; reason?: string }> } | undefined)?.candidates ??
				[];
			const priorTrendRejects = debugCands.filter(
				(c) => !c.accepted && typeof c.reason === 'string' && c.reason.startsWith('prior_trend_mismatch'),
			);
			expect(priorTrendRejects.length).toBeGreaterThan(0);
		});

		// pattern start がデータ先頭付近（lookback 不足）の場合、
		// validatePriorTrend は insufficient_data を返し hard reject しない。
		// 既存 fixture（pattern start idx ≦ 5）で検出が維持されることを確認。
		it('pattern 開始がデータ先頭付近の場合、prior_trend で reject しない', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildCompletedDoubleTopCandles())));

			const res = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
				includeCompleted: true,
				includeForming: false,
			});

			assertOk(res);
			const dt = res.data.patterns.filter((p: { type: string }) => p.type === 'double_top');
			expect(dt).toHaveLength(1);

			const debugCands =
				(res.meta?.debug as { candidates?: Array<{ accepted?: boolean; reason?: string }> } | undefined)?.candidates ??
				[];
			const priorTrendRejects = debugCands.filter(
				(c) => c.accepted === false && typeof c.reason === 'string' && c.reason.startsWith('prior_trend_mismatch'),
			);
			expect(priorTrendRejects).toHaveLength(0);

			// 棄却ではなく「accepted: true, reason: prior_trend_insufficient_data」を debug に残す
			const insufficientEntry = debugCands.find(
				(c) => c.accepted === true && c.reason === 'prior_trend_insufficient_data',
			);
			expect(insufficientEntry).toBeDefined();
		});

		// double_bottom 側でも同等にデータ先頭付近の場合は insufficient_data を debug に残す
		it('double_bottom でも pattern 開始がデータ先頭付近の場合、insufficient_data を debug に残す', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildFormingDoubleBottomCandles())));

			const res = await detectPatterns('btc_jpy', '1day', FORMING_DOUBLE_BOTTOM_BARS, {
				patterns: ['double_bottom'],
				swingDepth: 2,
				tolerancePct: 0.03,
				includeForming: true,
				includeCompleted: false,
			});

			assertOk(res);

			const debugCands =
				(res.meta?.debug as { candidates?: Array<{ accepted?: boolean; reason?: string }> } | undefined)?.candidates ??
				[];
			const priorTrendRejects = debugCands.filter(
				(c) => c.accepted === false && typeof c.reason === 'string' && c.reason.startsWith('prior_trend_mismatch'),
			);
			expect(priorTrendRejects).toHaveLength(0);

			const insufficientEntry = debugCands.find(
				(c) => c.accepted === true && c.reason === 'prior_trend_insufficient_data',
			);
			expect(insufficientEntry).toBeDefined();
		});
	});

	// ── 上流 warning の伝播（取得層 meta.warning / 計算層 meta.warnings） ──
	describe('上流 warning の伝播', () => {
		function indicatorsOkWithMeta(candles: Candle[], meta: Record<string, unknown>) {
			return {
				ok: true,
				summary: 'ok',
				data: { chart: { candles } },
				meta,
			};
		}

		it('上流 meta.warning（取得層 partial fetch）が tool の meta.warning と summary 先頭に伝播する', async () => {
			const candles = buildCompletedDoubleTopCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult(
					indicatorsOkWithMeta(candles, {
						warning: '⚠️ partial fetch (3日中1日の取得に失敗)',
					}),
				),
			);

			const res = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
			});

			assertOk(res);
			expect(res.meta.warning).toBe('⚠️ partial fetch (3日中1日の取得に失敗)');
			expect(res.meta.warnings).toBeUndefined();
			// summary 先頭が warning 行
			expect(res.summary.split('\n')[0]).toContain('⚠️ partial fetch');
		});

		it('上流 meta.warnings（計算層 SMA_200 不足等）が tool の meta.warnings に継承され、独自の data.warnings とは別フィールドで保持される', async () => {
			const candles = buildCompletedDoubleTopCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult(
					indicatorsOkWithMeta(candles, {
						warnings: ['SMA_200: データ不足', 'Ichimoku: データ不足'],
					}),
				),
			);

			const res = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
			});

			assertOk(res);
			// meta.warnings に上流計算層 warnings が継承される
			expect(res.meta.warnings).toEqual(['SMA_200: データ不足', 'Ichimoku: データ不足']);
			expect(res.meta.warning).toBeUndefined();
			// data.warnings（本ツール独自の検出系警告）と meta.warnings（上流計算層）は別フィールド
			// 独自警告は { type, message, suggestedParams } の形だが上流由来は string[]
			if (Array.isArray(res.data.warnings)) {
				for (const w of res.data.warnings) {
					// data.warnings は独自スキーマで、上流の string そのままが混入していないこと
					expect(typeof w).toBe('object');
				}
			}
			// summary 先頭が warning 行
			expect(res.summary.split('\n')[0]).toMatch(/^⚠️/);
			expect(res.summary).toContain('⚠️ SMA_200: データ不足');
		});

		it('上流の取得層 warning と計算層 warnings の両方が伝播し、別フィールドで保持される', async () => {
			const candles = buildCompletedDoubleTopCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult(
					indicatorsOkWithMeta(candles, {
						warning: '⚠️ partial fetch (multi-year)',
						warnings: ['SMA_200: データ不足'],
					}),
				),
			);

			const res = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
			});

			assertOk(res);
			expect(res.meta.warning).toBe('⚠️ partial fetch (multi-year)');
			expect(res.meta.warnings).toEqual(['SMA_200: データ不足']);
			// summary の先頭 2 行に取得層 warning と計算層 warnings がそれぞれ出る
			const lines = res.summary.split('\n');
			expect(lines[0]).toContain('⚠️ partial fetch');
			expect(lines[1]).toContain('⚠️ SMA_200: データ不足');
		});

		it('上流 warning 無しなら meta.warning / meta.warnings は付与されない', async () => {
			const candles = buildCompletedDoubleTopCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));

			const res = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
			});

			assertOk(res);
			expect(res.meta.warning).toBeUndefined();
			expect(res.meta.warnings).toBeUndefined();
			expect(res.summary.startsWith('⚠️')).toBe(false);
		});
	});

	// ── tz 表示（PR-4: 表示日付の tz 整形） ──
	describe('表示日付の tz 整形', () => {
		// 23:30 UTC の足を含む fixture を作る（UTC 暦日と JST 暦日が 1 日ずれる）。
		function makeIsoAt(year: number, month: number, day: number, hour: number): string {
			return dayjs
				.utc()
				.year(year)
				.month(month - 1)
				.date(day)
				.hour(hour)
				.minute(30)
				.second(0)
				.millisecond(0)
				.toISOString();
		}

		function buildDoubleTopAt2330Z(): Candle[] {
			// 既存 buildCompletedDoubleTopCandles と同じ close 列だが、isoTime を 23:30Z 系に振り直す。
			// idx 0 → 2026-10-01T23:30Z (UTC=10/01, JST=10/02)。1 日刻みで進める。
			const closes = [
				100, 102, 105, 110, 118, 130, 126, 122, 118, 114, 112, 110, 114, 118, 122, 126, 128, 129, 123, 116, 104, 100,
				95, 100, 99, 98,
			];
			return closes.map((close, index) => ({
				isoTime: makeIsoAt(2026, 10, 1 + index, 23),
				open: close,
				high: close + 3,
				low: close - 3,
				close,
				volume: 100,
			}));
		}

		it('tz 既定（Asia/Tokyo）: detect_patterns の summary 表示が JST 暦日になる', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildDoubleTopAt2330Z())));

			const res = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
				includeCompleted: true,
				includeForming: false,
			});

			assertOk(res);
			expect(res.data.patterns).toHaveLength(1);
			// idx 5 (= 2026-10-06T23:30Z → JST 10/07) ~ idx 20 (= 2026-10-21T23:30Z → JST 10/22)
			expect(res.summary).toContain('2026-10-07');
			expect(res.summary).toContain('2026-10-22');
			// UTC 暦日（10-06 / 10-21）は出ない
			expect(res.summary).not.toContain('2026-10-06');
			expect(res.summary).not.toContain('2026-10-21');
		});

		it("tz='UTC': detect_patterns の summary 表示が UTC 暦日になる", async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildDoubleTopAt2330Z())));

			const res = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
				includeCompleted: true,
				includeForming: false,
				tz: 'UTC',
			});

			assertOk(res);
			expect(res.data.patterns).toHaveLength(1);
			// idx 5 = 2026-10-06、idx 20 = 2026-10-21（UTC 暦日）
			expect(res.summary).toContain('2026-10-06');
			expect(res.summary).toContain('2026-10-21');
		});

		it('構造化データ data.patterns[*].range.start/end は UTC ISO 文字列のまま不変（後方互換）', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildDoubleTopAt2330Z())));

			// tz=Asia/Tokyo（既定）でも data 値は UTC ISO
			const res1 = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
				includeCompleted: true,
				includeForming: false,
			});
			assertOk(res1);
			expect(res1.data.patterns[0].range.start).toBe('2026-10-06T23:30:00.000Z');
			expect(res1.data.patterns[0].range.end).toBe('2026-10-21T23:30:00.000Z');

			// tz='UTC' でも同じ値（表示のみ変わる）
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildDoubleTopAt2330Z())));
			const res2 = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
				includeCompleted: true,
				includeForming: false,
				tz: 'UTC',
			});
			assertOk(res2);
			expect(res2.data.patterns[0].range.start).toBe('2026-10-06T23:30:00.000Z');
			expect(res2.data.patterns[0].range.end).toBe('2026-10-21T23:30:00.000Z');

			// overlays も同様に UTC ISO のまま
			expect(res1.data.overlays?.ranges?.[0]?.start).toBe('2026-10-06T23:30:00.000Z');
			expect(res2.data.overlays?.ranges?.[0]?.start).toBe('2026-10-06T23:30:00.000Z');
		});

		it("tz 省略時は detect_patterns 内部で 'Asia/Tokyo' にデフォルトされる（summary が JST 暦日）", async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildDoubleTopAt2330Z())));

			const res = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
				includeCompleted: true,
				includeForming: false,
				// tz 未指定
			});

			assertOk(res);
			expect(res.summary).toContain('2026-10-07');
			expect(res.summary).toContain('2026-10-22');
		});

		it("tz='' は Asia/Tokyo にフォールバックされる", async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildDoubleTopAt2330Z())));

			const res = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
				includeCompleted: true,
				includeForming: false,
				tz: '',
			});

			assertOk(res);
			expect(res.summary).toContain('2026-10-07');
			expect(res.summary).toContain('2026-10-22');
		});

		it('検出パターン分布期間も tz で整形される', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildDoubleTopAt2330Z())));

			const res = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
				includeCompleted: true,
				includeForming: false,
				tz: 'Asia/Tokyo',
			});

			assertOk(res);
			expect(res.summary).toContain('検出パターン分布期間: 2026-10-07 ~ 2026-10-22');

			// UTC のとき
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildDoubleTopAt2330Z())));
			const resUtc = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
				includeCompleted: true,
				includeForming: false,
				tz: 'UTC',
			});

			assertOk(resUtc);
			expect(resUtc.summary).toContain('検出パターン分布期間: 2026-10-06 ~ 2026-10-21');
		});
	});

	// スキャン窓 = 表示窓（直近 limit 本）。
	//
	// analyze_indicators は指標の warmup 分を先頭に足した配列を返し、その本数を
	// chart.meta.pastBuffer で伝える（render_chart_svg も `slice(pastBuffer)` で切る）。
	// 本ツールはこれを無視して全件走査しており、`limit=200` の要求に 399 本を走査して
	// ヘッダの `{limit}本から` が虚偽表示になっていた。
	describe('スキャン窓の pastBuffer 切り出し', () => {
		/** warmup 本を先頭に付けた chart を返す（本番 analyze_indicators と同じ形）。 */
		function indicatorsOkWithBuffer(warmup: Candle[], window: Candle[]) {
			return {
				ok: true,
				summary: 'ok',
				data: {
					chart: {
						candles: [...warmup, ...window],
						meta: { pastBuffer: warmup.length, shift: 26 },
					},
				},
			};
		}

		/** 平坦な warmup 足（パターンを作らないので検出結果に影響しないことが確認できる）。 */
		function flatCandles(count: number, startOffset: number): Candle[] {
			return Array.from({ length: count }, (_, i) => makeCandle(startOffset + i, 100));
		}

		it('pastBuffer 分を捨て、meta.scan が表示窓だけを指す', async () => {
			const window = buildCompletedDoubleTopCandles();
			const warmup = flatCandles(30, -30);
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOkWithBuffer(warmup, window)));

			const res = await detectPatterns('btc_jpy', '1day', window.length, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
			});

			assertOk(res);
			// warmup 30 本は走査対象外。scan は表示窓の先頭足から始まる。
			expect(res.meta.scan).toEqual({
				start: window[0].isoTime,
				end: window[window.length - 1].isoTime,
				bars: window.length,
			});
			expect(res.summary).toContain(`（${window.length}本）`);
		});

		it('pastBuffer が無いときは全件を走査する（上流の形が変わっても落とさない）', async () => {
			const window = buildCompletedDoubleTopCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(window)));

			const res = await detectPatterns('btc_jpy', '1day', window.length, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
			});

			assertOk(res);
			expect(res.meta.scan?.bars).toBe(window.length);
			expect(res.meta.scan?.start).toBe(window[0].isoTime);
		});

		it('warmup 側にあるパターンは検出されない（窓の外は見ない）', async () => {
			// warmup 側に double_top を、表示窓側は平坦にする。
			const warmupPattern = buildCompletedDoubleTopCandles();
			const flatWindow = flatCandles(26, 100);
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOkWithBuffer(warmupPattern, flatWindow)));

			const res = await detectPatterns('btc_jpy', '1day', flatWindow.length, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
			});

			assertOk(res);
			expect(res.data.patterns).toEqual([]);
		});

		// インデックス契約: 出力の idx はスキャン窓基準（warmup を含む chart.candles の添字ではない）。
		// slice で意味が変わった箇所なので、実際の足に解決できることを固定する。
		it('pivots[].idx / breakoutBarIndex はスキャン窓基準で、該当足に解決できる', async () => {
			const window = buildCompletedDoubleTopCandles();
			const warmup = flatCandles(30, -30);
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOkWithBuffer(warmup, window)));

			const res = await detectPatterns('btc_jpy', '1day', window.length, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
			});

			assertOk(res);
			const pattern = res.data.patterns[0];
			expect(pattern).toBeDefined();

			const pivots = pattern.pivots ?? [];
			expect(pivots.length).toBeGreaterThan(0);
			for (const pivot of pivots) {
				// window（= スキャン窓）の添字として有効な範囲に収まる
				expect(pivot.idx).toBeGreaterThanOrEqual(0);
				expect(pivot.idx).toBeLessThan(window.length);
				// 価格がその足の高安に含まれる = 正しい足を指している
				const bar = window[pivot.idx];
				expect(pivot.price).toBeGreaterThanOrEqual(bar.low);
				expect(pivot.price).toBeLessThanOrEqual(bar.high);
			}

			// range の端は pivot が指す足の日時と整合する（ISO 側との突き合わせ）
			expect(pattern.range.start).toBe(window[pivots[0].idx].isoTime);

			// breakoutBarIndex も同じ基準。bounds だけでなく、指す足が confirmation.date と
			// 一致することまで見る——bounds だけだと窓内に収まる誤りを見逃す。
			const breakoutBarIndex = pattern.breakoutBarIndex;
			expect(breakoutBarIndex).toBeDefined();
			expect(breakoutBarIndex).toBeGreaterThanOrEqual(0);
			expect(breakoutBarIndex).toBeLessThan(window.length);

			// confirmation.idx も出力に現れるインデックス。breakoutBarIndex と同じ足を指す。
			const confirmation = pattern.confirmation;
			expect(confirmation?.type).toBe('neckline_breakout');
			if (confirmation?.type !== 'neckline_breakout') throw new Error('unreachable');
			expect(confirmation.idx).toBe(breakoutBarIndex);
			expect(window[confirmation.idx].isoTime).toBe(confirmation.date);

			// warmup を含む配列の添字ではない: そちらに解決すると平坦足（100）に当たってしまう
			const all = [...warmup, ...window];
			expect(all[pivots[0].idx].isoTime).not.toBe(pattern.range.start);
			expect(all[confirmation.idx].isoTime).not.toBe(confirmation.date);
		});

		it('pastBuffer を無視した場合と結果が変わる（回帰の検出力を担保する）', async () => {
			const window = buildCompletedDoubleTopCandles();
			const warmupPattern = buildCompletedDoubleTopCandles(2025);

			// slice あり: 表示窓の 1 件だけ
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOkWithBuffer(warmupPattern, window)));
			const sliced = await detectPatterns('btc_jpy', '1day', window.length, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
			});

			// slice なし（pastBuffer を伝えない）: warmup 側のパターンも拾ってしまう
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk([...warmupPattern, ...window])));
			const unsliced = await detectPatterns('btc_jpy', '1day', window.length, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
			});

			assertOk(sliced);
			assertOk(unsliced);
			expect(sliced.meta.scan?.bars).toBe(window.length);
			expect(unsliced.meta.scan?.bars).toBe(warmupPattern.length + window.length);
			expect(sliced.data.patterns.length).toBeLessThan(unsliced.data.patterns.length);
		});
	});
	// スキャン窓 = 直近 limit 本になった結果、limit をスキーマ下限（20）付近まで小さくすると
	// swingDepth 分が前後から落ちてピボット候補が残らず「構造上ゼロ件」の窓が作れるようになった。
	// candles.length < 20 のガードは「ちょうど 20」で通ってしまうので、警告で申告する。
	describe('スキャン窓不足の警告', () => {
		/** 平坦でない適当な足を count 本作る（本数だけが論点なので形は問わない）。 */
		function noisyCandles(count: number): Candle[] {
			return Array.from({ length: count }, (_, i) => makeCandle(i, 100 + (i % 5) * 2));
		}

		it('日足 limit=20 では limit_too_small_for_timeframe を data.warnings に載せる', async () => {
			const candles = noisyCandles(20);
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));

			const res = await detectPatterns('btc_jpy', '1day', 20);

			assertOk(res);
			const warning = res.data.warnings?.find((w) => w.type === 'limit_too_small_for_timeframe');
			expect(warning).toBeDefined();
			expect(warning?.suggestedParams).toEqual({ limit: 23 });
			// data.warnings は LLM から見えないので summary にも同じ内容が出ていること。
			expect(res.summary.startsWith('⚠️ ')).toBe(true);
			expect(res.summary).toContain('limit≥23');
		});

		it('日足 limit=23 では警告を出さない（off-by-one）', async () => {
			const candles = noisyCandles(23);
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));

			const res = await detectPatterns('btc_jpy', '1day', 23);

			assertOk(res);
			expect(res.data.warnings?.some((w) => w.type === 'limit_too_small_for_timeframe')).toBe(false);
			expect(res.summary.startsWith('⚠️ ')).toBe(false);
		});

		it('pastBuffer 切り出し後の本数で判定する（warmup は窓に数えない）', async () => {
			// chart.candles は 50 本あるが、表示窓は 20 本しかない。
			const window = noisyCandles(20);
			const warmup = Array.from({ length: 30 }, (_, i) => makeCandle(-30 + i, 100));
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult({
					ok: true,
					summary: 'ok',
					data: { chart: { candles: [...warmup, ...window], meta: { pastBuffer: warmup.length } } },
				}),
			);

			const res = await detectPatterns('btc_jpy', '1day', 20);

			assertOk(res);
			expect(res.meta.scan?.bars).toBe(20);
			expect(res.data.warnings?.some((w) => w.type === 'limit_too_small_for_timeframe')).toBe(true);
		});

		it('上流 warning と併記され、上流が先に出る', async () => {
			const candles = noisyCandles(20);
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult({
					ok: true,
					summary: 'ok',
					data: { chart: { candles } },
					meta: { warning: 'partial fetch' },
				}),
			);

			const res = await detectPatterns('btc_jpy', '1day', 20);

			assertOk(res);
			const lines = res.summary.split('\n');
			expect(lines[0]).toBe('⚠️ partial fetch');
			expect(lines[1]).toContain('limit≥23');
		});
	});
});
