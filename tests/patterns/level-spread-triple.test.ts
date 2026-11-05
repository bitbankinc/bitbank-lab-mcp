// ゲートの実データケースは合成ではなく `btc_jpy_1day_2026` を使う（合成だと閾値に合わせて作れてしまうので、このゲートが実際に落とす形が実データに存在することを示す。#138）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { levelSpreadMetrics, MAX_LEVEL_SPREAD_RATIO, validateLevelSpread } from '../../tools/patterns/structural.js';
import { asMockResult, assertFail } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { buildBtcJpy2026Candles } from '../fixtures/btc_jpy_1day_2026.js';

type Candle = { isoTime: string; open: number; high: number; low: number; close: number; volume: number };
type Candidate = {
	type: string;
	accepted: boolean;
	reason?: string;
	indices?: number[];
	details?: Record<string, number>;
};

const main = (price: number) => ({ price });
const all = (extremePrice: number) => ({ extremePrice });

function mkCandle(i: number, close: number): Candle {
	const wick = close * 0.001;
	return {
		isoTime: dayjs.utc('2026-01-01T00:00:00Z').add(i, 'day').toISOString(),
		open: close,
		high: close + wick,
		low: close - wick,
		close,
		volume: 100,
	};
}

async function detectOn(closes: number[], tf: string, swingDepth: number) {
	const candles = closes.map((c, i) => mkCandle(i, c));
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = (await detectPatterns('btc_jpy', tf, candles.length, {
		swingDepth,
		includeCompleted: true,
		includeForming: true,
		view: 'debug',
	})) as {
		data?: { patterns?: Array<{ type: string; range: { start: string; end: string } }> };
		meta?: { debug?: { candidates?: Candidate[] } };
	};
	return { patterns: res.data?.patterns ?? [], candidates: res.meta?.debug?.candidates ?? [] };
}

/** `patterns` を絞るのは `view=debug` の cap 対策。`detect_patterns.ts` は候補を要求種別で絞ってから `cap = 200` でトリムするので、絞らないと実データの `sd2` では triple の棄却エントリが 1 件も残らない。 */
async function detectOnRealData(tf: string, swingDepth: number, want: Array<'triple_top' | 'triple_bottom'>) {
	const candles = buildBtcJpy2026Candles();
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = (await detectPatterns('btc_jpy', tf, candles.length, {
		swingDepth,
		patterns: want,
		includeCompleted: true,
		includeForming: true,
		view: 'debug',
	})) as {
		data?: { patterns?: Array<{ type: string; range: { start: string; end: string } }> };
		meta?: { debug?: { candidates?: Candidate[] } };
	};
	return { patterns: res.data?.patterns ?? [], candidates: res.meta?.debug?.candidates ?? [] };
}

/** 3 山（100 / 104 / 101）が階段状に切り下がる、山のばらつきが大きい系列。 */
const UNEVEN_PEAKS = [
	100, 92, 84, 76, 70, 100, 92, 84, 76, 70, 130, 118, 106, 94, 82, 70, 100, 92, 84, 76, 70, 66, 62, 58,
];
/** 3 谷（70 / 100 / 74）が階段状に切り上がる、谷のばらつきが大きい系列。 */
const UNEVEN_VALLEYS = [
	100, 108, 116, 124, 130, 100, 108, 116, 124, 130, 70, 82, 94, 106, 118, 130, 100, 108, 116, 124, 130, 134, 138, 142,
];

// The first leg is deliberately monotonic (up for top, down for bottom); the three main points stay within the level tolerance, but their spread exceeds half the pattern height.
const DIRECTIONAL_SPREAD_TOP = [
	80, 82, 84, 86, 88, 90, 92, 94, 96, 100, 99, 98, 97, 98, 100, 102, 104, 102, 100, 98, 97.5, 99, 100, 101, 99, 98, 97,
	96, 95, 94,
];
const DIRECTIONAL_SPREAD_BOTTOM = DIRECTIONAL_SPREAD_TOP.map((price) => 200 - price);

describe('levelSpreadMetrics（issue #138）', () => {
	it('分子は price・分母は extremePrice で測る', () => {
		// 主構成点の price は 100 / 104 / 101 → ばらつき 4。全構成点の extremePrice は 105 / 90 / 108 / 90 / 106 → 全振幅 18。
		const m = levelSpreadMetrics([main(100), main(104), main(101)], [all(105), all(90), all(108), all(90), all(106)]);
		expect(m.spreadAbs).toBe(4);
		expect(m.heightAbs).toBe(18);
		expect(m.spreadRatio).toBeCloseTo(4 / 18, 12);
		expect(m.spreadPct).toBeCloseTo(4 / 104, 12);
		expect(m.heightPct).toBeCloseTo(18 / 108, 12);
	});

	it('構成点が欠けていれば高さは測らず、ばらつきだけ返す', () => {
		const m = levelSpreadMetrics([main(100), main(104), main(101)], [all(105), null, all(108), undefined, all(106)]);
		expect(m.spreadAbs).toBe(4);
		expect(m.heightAbs).toBeNull();
		expect(m.heightPct).toBeNull();
		expect(m.spreadRatio).toBeNull();
	});

	it('高さ 0 では比を出さない（ゼロ除算）', () => {
		const m = levelSpreadMetrics([main(100), main(100), main(100)], [all(100), all(100), all(100)]);
		expect(m.heightAbs).toBe(0);
		expect(m.spreadRatio).toBeNull();
	});
});

describe('validateLevelSpread（issue #138）', () => {
	const metricsWithRatio = (ratio: number | null) => ({
		spreadAbs: 0,
		spreadPct: 0,
		heightAbs: 1,
		heightPct: 0,
		spreadRatio: ratio,
	});

	it('閾値は 0.5', () => {
		expect(MAX_LEVEL_SPREAD_RATIO).toBe(0.5);
	});

	it('閾値ちょうどは通し、超えたところで落とす（off-by-one）', () => {
		expect(validateLevelSpread('top', metricsWithRatio(MAX_LEVEL_SPREAD_RATIO))).toBeNull();
		expect(validateLevelSpread('top', metricsWithRatio(MAX_LEVEL_SPREAD_RATIO + 1e-9))).toBe(
			'peak_spread_vs_height_excess',
		);
		expect(validateLevelSpread('bottom', metricsWithRatio(MAX_LEVEL_SPREAD_RATIO + 1e-9))).toBe(
			'valley_spread_vs_height_excess',
		);
	});

	it('比を出せない候補は落とさない（判定材料が無いものを弾かない）', () => {
		expect(validateLevelSpread('top', metricsWithRatio(null))).toBeNull();
		expect(validateLevelSpread('bottom', metricsWithRatio(Number.NaN))).toBeNull();
	});

	it('上下で対称（同じ比なら top / bottom とも落ちる）', () => {
		const m = metricsWithRatio(0.9);
		expect(validateLevelSpread('top', m)).toBe('peak_spread_vs_height_excess');
		expect(validateLevelSpread('bottom', m)).toBe('valley_spread_vs_height_excess');
	});
});

describe('detect_patterns: 上流 analyze_indicators の失敗', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	// 棄却経路はすべて `analyze_indicators` の成功を前提にしているので、上流が失敗したときに候補を 1 件も組み立てないことを固定する（でないと「棄却理由が 0 件」が上流の失敗か窓の不在か区別できない）。
	it('上流がエラーなら fail をそのまま返し、pattern も debug candidate も作らない', async () => {
		vi.mocked(analyzeIndicators).mockResolvedValueOnce(
			asMockResult({ ok: false, summary: 'Error: upstream failed', data: {}, meta: { errorType: 'network' } }),
		);

		const res = await detectPatterns('btc_jpy', '1day', 90, {
			swingDepth: 2,
			includeCompleted: true,
			includeForming: true,
			view: 'debug',
		});

		assertFail(res);
		expect(res.summary).toContain('upstream failed');
		expect(res.meta.errorType).toBe('internal');
		// `data` は `fail()` が返す空オブジェクト。patterns も debug も生えない。
		expect((res.data as { patterns?: unknown[] }).patterns).toBeUndefined();
		expect((res.meta as { debug?: unknown }).debug).toBeUndefined();
	});
});

describe('detect_patterns: 3 点の同水準判定が無音でなくなる（issue #138 確認事項 A）', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('3 山が同水準でない窓は three_peaks_not_level を積む', async () => {
		const { candidates } = await detectOn(UNEVEN_PEAKS, '1day', 2);
		const hits = candidates.filter((c) => c.type === 'triple_top' && c.reason === 'three_peaks_not_level');
		expect(hits.length).toBeGreaterThan(0);
		const d = hits[0].details ?? {};
		expect(d.spreadPct).toBeGreaterThan(0);
		expect(d.heightPct).toBeGreaterThan(0);
		expect(d.spreadRatio).toBeGreaterThan(0);
	});

	it('3 谷が同水準でない窓は three_valleys_not_level を積む', async () => {
		const { candidates } = await detectOn(UNEVEN_VALLEYS, '1day', 2);
		const hits = candidates.filter((c) => c.type === 'triple_bottom' && c.reason === 'three_valleys_not_level');
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].details?.spreadRatio).toBeGreaterThan(0);
	});

	it('strict の triple_bottom は valleys_not_equal を返さない（到達不能分岐の除去。確認事項 C）', async () => {
		// 3 谷の非同水準は `three_valleys_not_level` が受け持つ。
		const { candidates } = await detectOn(UNEVEN_VALLEYS, '1day', 2);
		expect(candidates.filter((c) => c.type === 'triple_bottom' && c.reason === 'valleys_not_equal')).toHaveLength(0);
	});
});

describe('detect_patterns: 高さ相対の hard gate（issue #138 ステップ 2）', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('山のばらつきがパターン高さの 54% ある実データの triple_top を落とす', async () => {
		// BTC/JPY 実データ idx 47 / 53 / 59。山は 10,503,828 / 10,849,999 / 10,451,135 で、`tolerancePct`（4hour = 5%）から見れば 3.68% で同水準だが、パターン高さ 736,794 円に対してばらつき 398,864 円 = 54.1%。
		const { patterns, candidates } = await detectOnRealData('4hour', 2, ['triple_top']);

		const hit = candidates.find(
			(c) => c.type === 'triple_top' && c.reason === 'peak_spread_vs_height_excess' && String(c.indices) === '47,53,59',
		);
		expect(hit).toBeDefined();

		expect(
			patterns.filter((p) => p.type === 'triple_top' && p.range.start === '2026-07-15T00:00:00.000Z'),
		).toHaveLength(0);
	});

	it('谷のばらつきがパターン高さの 52% ある実データの triple_bottom を落とす', async () => {
		// BTC/JPY 実データ idx 56 / 66 / 77。谷のばらつき 520,270 円に対しパターン高さ 996,962 円 = 52.2%。relaxed 経路の検出なので、strict にだけゲートを入れても relaxed が同じ 3 谷を拾い直して落ちない。
		const { patterns, candidates } = await detectOnRealData('1day', 2, ['triple_bottom']);

		// `indices` で構造を名指しする。同じ理由コードで落ちる構造がもう 1 つあり（idx 33/45/49、比 0.5259）、`find` の先頭一致に頼ると別の構造の値を検証することに静かにすり替わる。
		const hit = candidates.find(
			(c) =>
				c.type === 'triple_bottom' && c.reason === 'prior_trend_mismatch:sideways' && String(c.indices) === '56,66,77',
		);
		expect(hit).toBeDefined();

		expect(
			patterns.filter((p) => p.type === 'triple_bottom' && p.range.start === '2026-07-24T00:00:00.000Z'),
		).toHaveLength(0);
	});

	it('比が閾値以下の triple は引き続き検出される（過剰棄却の回帰）', async () => {
		// 合成 fixture の教科書的な triple_top（3 山 130 / 131 / 131、高さ 18.7%）は比 0.04 なので影響を受けない。
		const closes = [
			100, 105, 112, 120, 128, 130, 126, 120, 115, 112, 116, 122, 128, 130, 131, 126, 120, 115, 113, 117, 122, 128, 130,
			131, 126, 118, 110, 104, 98, 94,
		];
		const { patterns, candidates } = await detectOn(closes, '1day', 2);
		expect(patterns.filter((p) => p.type === 'triple_top').length).toBeGreaterThan(0);
		expect(
			candidates.filter((c) => c.type === 'triple_top' && c.reason === 'peak_spread_vs_height_excess'),
		).toHaveLength(0);
	});

	it('方向が有効な triple_top でも peak spread 超過を検出器経由で棄却する', async () => {
		const { candidates } = await detectOn(DIRECTIONAL_SPREAD_TOP, '1day', 2);
		const hit = candidates.find((c) => c.type === 'triple_top' && c.reason === 'peak_spread_vs_height_excess');
		expect(hit?.indices).toEqual([9, 16, 23]);
		expect(hit?.details?.spreadRatio).toBeGreaterThan(MAX_LEVEL_SPREAD_RATIO);
	});

	it('方向が有効な triple_bottom でも valley spread 超過を検出器経由で棄却する', async () => {
		const { candidates } = await detectOn(DIRECTIONAL_SPREAD_BOTTOM, '1day', 2);
		const hit = candidates.find((c) => c.type === 'triple_bottom' && c.reason === 'valley_spread_vs_height_excess');
		expect(hit?.indices).toEqual([9, 16, 23]);
		expect(hit?.details?.spreadRatio).toBeGreaterThan(MAX_LEVEL_SPREAD_RATIO);
	});
});
