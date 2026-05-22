import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../lib/datetime.js';
import { asMockResult, assertOk } from './_assertResult.js';

vi.mock('../tools/analyze_indicators.js', () => ({
	default: vi.fn(),
}));

import analyzeIndicators from '../tools/analyze_indicators.js';
import detectPatterns from '../tools/detect_patterns.js';

type Candle = {
	isoTime: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
};

function makeIso(dayOffset: number, year = 2026) {
	return new Date(Date.UTC(year, 0, 1 + dayOffset, 0, 0, 0)).toISOString();
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

function buildCompletedDoubleTopCandles(year = 2026): Candle[] {
	const closes = [
		100, 102, 105, 110, 118, 130, 126, 122, 118, 114, 112, 110, 114, 118, 122, 126, 128, 129, 123, 116, 104, 100, 95,
		100, 99, 98,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

function buildFormingDoubleBottomCandles(year = 2026): Candle[] {
	const closes = [108, 104, 99, 92, 80, 84, 88, 92, 96, 99, 101, 98, 94, 89, 85, 82, 81, 84, 88, 91, 94, 95, 96, 95];

	return closes.map((close, index) => makeCandle(index, close, year));
}

function buildDescendingTriangleInvalidBreakoutCandles(year = 2026): Candle[] {
	const closes = [
		120, 130, 124, 116, 100, 112, 125, 118, 101, 110, 120, 114, 100, 108, 115, 110, 101, 107, 128, 132, 130, 128, 126,
		124,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

function buildRectangleRangeCandles(year = 2026): Candle[] {
	const closes = [
		105, 110, 104, 109, 101, 108, 102, 110, 101, 109, 100, 108, 102, 109, 101, 110, 100, 109, 101, 108, 102, 109, 101,
		110,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

function buildRisingChannelCandles(year = 2026): Candle[] {
	const closes = [
		100, 108, 104, 112, 108, 116, 112, 120, 116, 124, 120, 128, 124, 132, 128, 136, 132, 140, 136, 144, 140, 148, 144,
		152, 148, 156, 152, 160, 156, 164,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

function buildBullFlagFailureCandles(year = 2026): Candle[] {
	const closes = [100, 108, 116, 124, 132, 140, 136, 138, 134, 136, 132, 134, 130, 132, 128, 130, 120, 118, 116, 114];

	return closes.map((close, index) => makeCandle(index, close, year));
}

function buildBullPennantSuccessCandles(year = 2026): Candle[] {
	const closes = [
		100, 110, 122, 136, 150, 165, 158, 162, 154, 160, 155, 159, 156, 158, 157, 157.8, 157.2, 158.1, 157.4, 170, 172,
		174,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

function buildBullPennantFailureCandles(year = 2026): Candle[] {
	const closes = [
		100, 110, 122, 136, 150, 165, 158, 162, 154, 160, 155, 159, 156, 158, 157, 157.8, 157.2, 158.1, 157.4, 148, 146,
		144,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- Triple Top: 3 peaks near 130, 2 valleys near 112, then neckline break ---
function buildCompletedTripleTopCandles(year = 2026): Candle[] {
	const closes = [
		100, 105, 112, 120, 128, 130, 126, 120, 115, 112, 116, 122, 128, 130, 131, 126, 120, 115, 113, 117, 122, 128, 130,
		131, 126, 118, 110, 104, 98, 94,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- Triple Bottom (forming): 3 valleys near 80, with enough bars after 3rd valley ---
function buildFormingTripleBottomCandles(year = 2026): Candle[] {
	const closes = [
		108, 104, 98, 92, 84, 80, 84, 90, 95, 98, 94, 88, 84, 81, 80, 84, 90, 95, 97, 93, 88, 84, 81, 80, 84, 88, 92, 96,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- Head & Shoulders (completed): L-shoulder 125, head 140, R-shoulder 126, neckline ~110-112, break ---
function buildCompletedHeadAndShouldersCandles(year = 2026): Candle[] {
	const closes = [
		100, 108, 116, 122, 125, 120, 116, 112, 110, 114, 120, 128, 136, 140, 136, 128, 120, 114, 112, 116, 120, 124, 126,
		122, 116, 108, 102, 96,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- Inverse Head & Shoulders (forming): L-shoulder 80, head 64, R-shoulder forming near 80 ---
function buildFormingInverseHeadAndShouldersCandles(year = 2026): Candle[] {
	const closes = [
		108, 100, 92, 84, 80, 84, 90, 96, 100, 96, 88, 78, 68, 64, 70, 80, 90, 98, 100, 96, 90, 84, 80, 84, 88, 92,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- Rising Wedge (forming): both slopes up, lower steeper ---
// Peaks at idx 5,12,19,26,33 → highs 133,137,141,145,149 (slope ~0.571/bar)
// Valleys at idx 0,7,14,21,28 → lows 97,105,113,121,129 (slope ~1.143/bar, steeper)
function buildFormingRisingWedgeCandles(year = 2026): Candle[] {
	const closes = [
		100, 106, 112, 118, 124, 130, 119, 108, 113, 118, 124, 129, 134, 125, 116, 120, 125, 129, 134, 138, 131, 124, 128,
		131, 135, 138, 142, 137, 132, 135, 138, 140, 143, 146, 143,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- Falling Wedge (completed with upward breakout) ---
// Mirror of rising wedge, inverted: both slopes down, upper steeper in abs value
function buildCompletedFallingWedgeCandles(year = 2026): Candle[] {
	const closes = [
		146, 140, 134, 128, 122, 116, 127, 138, 133, 128, 122, 117, 112, 121, 130, 126, 121, 117, 112, 108, 115, 122, 118,
		115, 111, 108, 104, 109, 114, 111, 108, 106, 103, 100, 103, 110, 118,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- Ascending Triangle (forming): flat upper resistance ~130, rising lower support ---
// Peaks: all near close=127 → high=130; Valleys: rising from low=97 upward
// No impulsive pole before window (gradual entry) to avoid pennant reclassification
function buildFormingAscendingTriangleCandles(year = 2026): Candle[] {
	const closes = [
		115, 118, 121, 124, 127, 124, 118, 112, 116, 120, 124, 127, 123, 117, 114, 118, 122, 126, 127, 124, 120, 117, 120,
		123, 126, 127, 125, 122, 120, 123, 126, 127, 126,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- Symmetrical Triangle (forming): upper falling, lower rising, converging ---
// Peaks: descending from ~140 to ~126; Valleys: ascending from ~100 to ~118
function buildFormingSymmetricalTriangleCandles(year = 2026): Candle[] {
	const closes = [
		120, 126, 132, 137, 130, 122, 116, 110, 104, 100, 106, 114, 120, 128, 134, 128, 120, 115, 108, 104, 110, 118, 124,
		130, 126, 120, 116, 112, 108, 114, 120, 126, 124, 120, 117, 114,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- IHS with asymmetric neckline (PR #2 ケース2 相当) ---
// 左肩・右肩は同水準（valley 80）、頭は十分下（valley 64）、
// ネックラインを構成する2つのピーク（山1≒100, 山2≒108）が約7%非対称
// → HS_NECKLINE_MAX_PCT=0.05 で hard reject されるべき
// 5ピボット以上の間隔（minBarsBetweenSwings=4@1day）を確保するため間延びさせる
function buildAsymmetricNecklineIHSCandles(year = 2026): Candle[] {
	const closes = [
		// pre-trend: downtrend (idx 0-7)
		130, 125, 120, 115, 110, 105, 100, 90,
		// 左肩 valley ≒ 80 (idx 8)
		80,
		// 山1 peak ≒ 100 (idx 13)
		86, 90, 94, 98, 100,
		// 頭 valley ≒ 64 (idx 18)
		90, 78, 70, 66, 64,
		// 山2 peak ≒ 108 (idx 23, 山1 から +8%)
		74, 86, 96, 104, 108,
		// 右肩 valley ≒ 80 (idx 28)
		96, 90, 86, 82, 80,
		// 続伸 (idx 29+)
		90, 96, 100,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- H&S with asymmetric neckline (PR #2 H&S 側ミラー) ---
// 左肩・右肩は同水準（peak 120）、頭は十分上（peak 140）、
// ネックラインを構成する2つの谷（valley1≒100, valley2≒108）が約8%非対称
function buildAsymmetricNecklineHSCandles(year = 2026): Candle[] {
	const closes = [
		// pre-trend: uptrend (idx 0-7)
		70, 75, 80, 85, 90, 95, 100, 110,
		// 左肩 peak ≒ 120 (idx 8)
		120,
		// 谷1 valley ≒ 100 (idx 13)
		114, 110, 106, 102, 100,
		// 頭 peak ≒ 140 (idx 18)
		108, 118, 128, 134, 140,
		// 谷2 valley ≒ 108 (idx 23, 谷1 から +8%)
		126, 120, 116, 112, 108,
		// 右肩 peak ≒ 120 (idx 28)
		112, 114, 116, 118, 120,
		// 下落
		110, 100, 92,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- Double top with structurally unequal peaks (PR #2 double hard cap) ---
// peak1≒100, valley≒80, peak2≒105 → 5% 差。tolerancePct=0.06 では near() を通るが
// DOUBLE_LEVEL_MAX_PCT=0.03 の hard cap で弾かれるべき
function buildUnequalPeaksDoubleTopCandles(year = 2026): Candle[] {
	const closes = [
		// 上昇 (idx 0-5)
		70, 76, 82, 88, 94, 100,
		// peak1 (idx 5) → valley (idx 11)
		96, 92, 88, 84, 81, 80,
		// 上昇して peak2 ≒ 105 (idx 17)
		86, 92, 96, 100, 103, 105,
		// 下落して valley 後 (idx 23) で4本目のピボットを形成
		100, 92, 86, 82, 80, 82,
		// 反発（4ピボット確保のための尾部）
		88, 94,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- 上昇トレンド継続中の偽 double_bottom (PR #3 prior_trend hard reject) ---
// idx 0-29 で 100→245 の clean な上昇トレンド（毎バー +5）、その後 idx 30-44 で
// 形成中ダブルボトムらしき形（左谷 232, ミッドピーク 246, 右谷 231, 直近 248）を作る。
// 左谷 idx=30 における lookback window [20..30] は monotonic に近い上昇のため
// priorReturn ≈ +0.16, efficiency ≈ 0.71 → 'up' 分類で down_or_sideways と矛盾し
// hard reject されるべき。
function buildUptrendThenFakeDoubleBottomCandles(year = 2026): Candle[] {
	const closes = [
		// idx 0-9: 上昇トレンド 100 → 145 (毎バー +5)
		100, 105, 110, 115, 120, 125, 130, 135, 140, 145,
		// idx 10-19: 上昇継続 150 → 195
		150, 155, 160, 165, 170, 175, 180, 185, 190, 195,
		// idx 20-29: 上昇継続 200 → 245
		200, 205, 210, 215, 220, 225, 230, 235, 240, 245,
		// idx 30: 左谷 232 まで小さく押し目
		232,
		// idx 31-35: ミッドピーク 246 へ戻り
		236, 239, 241, 243, 245,
		// idx 36: ミッドピーク
		246,
		// idx 37-41: 右谷 231 まで押し目
		243, 240, 237, 234, 231,
		// idx 42-44: 直近の戻り
		237, 243, 248,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- 下降トレンド継続中の偽 head_and_shoulders (PR #3 prior_trend hard reject) ---
// idx 0-25 で 300→100 の clean な下降トレンド（毎バー -8）、その後 idx 26-45 で
// H-L-H-L-H（左肩 110 / 谷1 92 / 頭 130 / 谷2 92 / 右肩 110）を形成。
// 左肩 idx=29 における lookback window [19..29] は概ね monotonic な下降のため
// priorReturn ≈ -0.26, efficiency ≈ 0.79 → 'down' 分類で up_or_sideways と矛盾し
// hard reject されるべき。
function buildDowntrendThenFakeHSCandles(year = 2026): Candle[] {
	const closes = [
		// idx 0-9: 下降トレンド 300 → 228 (毎バー -8)
		300, 292, 284, 276, 268, 260, 252, 244, 236, 228,
		// idx 10-19: 下降継続 220 → 148
		220, 212, 204, 196, 188, 180, 172, 164, 156, 148,
		// idx 20-25: 下降継続 140 → 100
		140, 132, 124, 116, 108, 100,
		// idx 26-29: 左肩 110 へ rally
		103, 106, 108, 110,
		// idx 30-33: 谷1 92 へ pullback
		106, 100, 96, 92,
		// idx 34-37: 頭 130 へ rally
		102, 115, 125, 130,
		// idx 38-41: 谷2 92 へ pullback
		118, 105, 96, 92,
		// idx 42-45: 右肩 110 へ rally
		100, 105, 108, 110,
		// idx 46-48: 続落
		106, 100, 96,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- Double bottom with structurally unequal valleys (PR #2 double hard cap) ---
// valley1≒100, peak≒120, valley2≒95 → 5% 差。tolerancePct=0.06 では near() を通るが
// DOUBLE_LEVEL_MAX_PCT=0.03 の hard cap で弾かれるべき
function buildUnequalValleysDoubleBottomCandles(year = 2026): Candle[] {
	const closes = [
		// 下落 (idx 0-5)
		130, 124, 118, 112, 106, 100,
		// valley1 (idx 5) → peak (idx 11)
		104, 108, 112, 116, 119, 120,
		// 下落して valley2 ≒ 95 (idx 17)
		116, 110, 105, 100, 97, 95,
		// 上昇して peak 後 (idx 23) で4本目のピボットを形成
		100, 108, 114, 118, 120, 118,
		// 反落（4ピボット確保のための尾部）
		112, 106,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
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
		expect(res.data.overlays!.ranges).toEqual([
			{
				start: makeIso(5),
				end: makeIso(20),
				label: 'double_top',
			},
		]);
		expect(res.meta.count).toBe(1);
	});

	it('synthetic fixture から forming の double_bottom を completed なしで返せる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildFormingDoubleBottomCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 24, {
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
			status: 'forming',
			timeframe: '1day',
			timeframeLabel: '日足',
			trendlineLabel: 'ネックライン',
			completionPct: expect.any(Number),
			targetMethod: 'neckline_projection',
		});
		expect(res.data.patterns[0].range.end).toBe(makeIso(23));
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
		expect(res.data.overlays!.ranges).toEqual([]);
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
					type: 'flag',
					status: 'invalid',
					breakoutDirection: 'down',
					outcome: 'failure',
					timeframe: '1day',
					timeframeLabel: '日足',
					targetMethod: 'flagpole_projection',
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
					type: 'pennant',
					status: 'completed',
					poleDirection: 'up',
					breakoutDirection: 'up',
					outcome: 'success',
					isTrendContinuation: true,
					timeframe: '1day',
					timeframeLabel: '日足',
					targetMethod: 'flagpole_projection',
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
					type: 'pennant',
					poleDirection: 'up',
					breakoutDirection: 'down',
					outcome: 'failure',
					isTrendContinuation: false,
					timeframe: '1day',
					timeframeLabel: '日足',
					targetMethod: 'flagpole_projection',
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

		it('既存 forming double_bottom fixture は引き続き検出され、confidence は維持される', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildFormingDoubleBottomCandles())));
			const res = await detectPatterns('btc_jpy', '1day', 24, {
				patterns: ['double_bottom'],
				swingDepth: 2,
				tolerancePct: 0.03,
				includeForming: true,
				includeCompleted: false,
			});
			assertOk(res);
			const db = res.data.patterns.filter((p: { type: string }) => p.type === 'double_bottom');
			expect(db).toHaveLength(1);
			expect(db[0].status).toBe('forming');
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

			const res = await detectPatterns('btc_jpy', '1day', 45, {
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

			const res = await detectPatterns('btc_jpy', '1day', 24, {
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

		it('検出対象期間（detectionPeriodText）も tz で整形される', async () => {
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
			expect(res.summary).toContain('検出対象期間: 2026-10-07 ~ 2026-10-22');

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
			expect(resUtc.summary).toContain('検出対象期間: 2026-10-06 ~ 2026-10-21');
		});
	});
});
