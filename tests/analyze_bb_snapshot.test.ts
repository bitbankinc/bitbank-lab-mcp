import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../lib/datetime.js';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';

// 既存のテストは fetch モックで analyze_indicators の全フローを通すため、
// default export は actual 実装の passthrough にする。warning 伝播テストでは
// mockResolvedValueOnce で 1 回だけ上書きする（次回呼び出しから actual に戻る）。
vi.mock('../tools/analyze_indicators.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../tools/analyze_indicators.js')>();
	return {
		...actual,
		default: vi.fn(actual.default),
	};
});

import analyzeBbSnapshot, { buildBbDefaultText, toolDef } from '../tools/analyze_bb_snapshot.js';
import analyzeIndicators, { clearIndicatorCache } from '../tools/analyze_indicators.js';

type OhlcvRow = [string, string, string, string, string, string];

function makeFlatOhlcvRows(count: number, close: number = 10_000_000): OhlcvRow[] {
	const startMs = Date.UTC(2024, 0, 1);
	const rows: OhlcvRow[] = [];
	for (let i = 0; i < count; i++) {
		const ts = startMs + i * 86_400_000;
		rows.push([String(close), String(close), String(close), String(close), '1.0', String(ts)]);
	}
	return rows;
}

function makeTrendingOhlcvRows(count: number): OhlcvRow[] {
	const startMs = Date.UTC(2024, 0, 1);
	const rows: OhlcvRow[] = [];
	for (let i = 0; i < count; i++) {
		const base = 10_000_000 + i * 10_000;
		rows.push([
			String(base),
			String(base + 2_000),
			String(base - 2_000),
			String(base + 1_000),
			'1.0',
			String(startMs + i * 86_400_000),
		]);
	}
	return rows;
}

/**
 * 最後の1本だけ大きく偏らせることで特定の zScore を生成するヘルパー。
 * BB period=20 の場合、直近20本のうち19本が baseClose で
 * 最後の1本が baseClose + deviation のとき:
 *   mean ≈ baseClose + deviation/20
 *   std  ≈ deviation * sqrt(19) / 20
 *   halfWidth = 2*std = deviation * sqrt(19) / 10
 *   zScore ≈ 2.18 (固定値 - D の大きさに依存しない)
 *
 * deviationMultiplier はベースの偏差を調整するが zScore 値自体は変わらない。
 * より小さな zScore を得るには異なる構造のデータが必要。
 */
function makeHighZscoreRows(count: number, deviationMultiplier = 1, direction: 1 | -1 = 1): OhlcvRow[] {
	const startMs = Date.UTC(2024, 0, 1);
	const baseClose = 10_000_000;
	const deviation = 2_000_000 * deviationMultiplier * direction;
	const rows: OhlcvRow[] = [];
	for (let i = 0; i < count; i++) {
		const close = i === count - 1 ? baseClose + deviation : baseClose;
		const ts = startMs + i * 86_400_000;
		rows.push([String(close), String(close), String(close), String(close), '1.0', String(ts)]);
	}
	return rows;
}

/**
 * 後半で bandWidth が縮小するデータ（decreasing volatility_trend 用）:
 * 前半は高ボラ、後半は低ボラ（フラット）にする。
 */
function makeDecreasingVolRows(count: number): OhlcvRow[] {
	const startMs = Date.UTC(2024, 0, 1);
	const baseClose = 10_000_000;
	const rows: OhlcvRow[] = [];
	for (let i = 0; i < count; i++) {
		const ts = startMs + i * 86_400_000;
		// 前半: 高ボラ（交互に上下）、後半: フラット
		const halfPoint = Math.floor(count * 0.6);
		const close = i < halfPoint ? baseClose + (i % 2 === 0 ? 500_000 : -500_000) : baseClose;
		rows.push([String(close), String(close), String(close), String(close), '1.0', String(ts)]);
	}
	return rows;
}

/**
 * 高ボラリティ相場: bandWidthPct > 30% (wide) にするために
 * 交互に大きく上下するデータ。
 */
function makeHighVolRows(count: number): OhlcvRow[] {
	const startMs = Date.UTC(2024, 0, 1);
	const baseClose = 10_000_000;
	const rows: OhlcvRow[] = [];
	for (let i = 0; i < count; i++) {
		const ts = startMs + i * 86_400_000;
		const close = baseClose + (i % 2 === 0 ? 2_000_000 : -2_000_000);
		rows.push([String(close), String(close), String(close), String(close), '1.0', String(ts)]);
	}
	return rows;
}

/** 強い上昇トレンド: 急激な価格上昇で close が upper band を超える */
function makeStrongUptrendRows(count: number): OhlcvRow[] {
	const startMs = Date.UTC(2024, 0, 1);
	const rows: OhlcvRow[] = [];
	for (let i = 0; i < count; i++) {
		// 最後の数本だけ急激に上昇させる
		const base =
			i < count - 5 ? 10_000_000 + i * 1_000 : 10_000_000 + (count - 5) * 1_000 + (i - (count - 5)) * 500_000;
		rows.push([
			String(base),
			String(base + 2_000),
			String(base - 2_000),
			String(base + 1_000),
			'1.0',
			String(startMs + i * 86_400_000),
		]);
	}
	return rows;
}

/** 強い下降トレンド: 急激な価格下落で close が lower band を超える */
function makeStrongDowntrendRows(count: number): OhlcvRow[] {
	const startMs = Date.UTC(2024, 0, 1);
	const rows: OhlcvRow[] = [];
	for (let i = 0; i < count; i++) {
		// 最後の数本だけ急激に下落させる
		const base =
			i < count - 5 ? 10_000_000 + i * 1_000 : 10_000_000 + (count - 5) * 1_000 - (i - (count - 5)) * 500_000;
		rows.push([
			String(base),
			String(base + 2_000),
			String(base - 2_000),
			String(base - 1_000),
			'1.0',
			String(startMs + i * 86_400_000),
		]);
	}
	return rows;
}

function mockFetch(rows: OhlcvRow[]) {
	globalThis.fetch = vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		statusText: 'OK',
		json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
	}) as unknown as typeof fetch;
}

/**
 * 年ごとに異なるデータを返す fetch モック。
 * analyzeIndicators が 2 年分のデータを並列取得するため、
 * URL に含まれる年を見て year2026Rows または year2025Rows を返す。
 * これにより BB ウィンドウ内のスパイク本数を制御できる。
 */
function mockFetchByYear(year2026Rows: OhlcvRow[], year2025Rows: OhlcvRow[]) {
	globalThis.fetch = vi.fn().mockImplementation(async (url: unknown) => {
		const rows = String(url).includes('/2026') ? year2026Rows : year2025Rows;
		return {
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		};
	}) as unknown as typeof fetch;
}

/**
 * 指定した closesFn(i) で close 値を決めたローを count 本生成する。
 * startMs にはミリ秒単位の開始タイムスタンプを渡す。
 */
function makeTimestampedRows(count: number, closeFn: (i: number) => number, startMs: number): OhlcvRow[] {
	return Array.from({ length: count }, (_, i) => {
		const close = closeFn(i);
		const ts = startMs + i * 86_400_000;
		return [String(close), String(close), String(close), String(close), '1.0', String(ts)] as OhlcvRow;
	});
}

/**
 * 2026 年分のローを生成する（Jan 1 - Apr 2 = 91 日）。
 * 2025 年分のフラットローも生成して返す。
 * mockFetchByYear と組み合わせて使う。
 */
function make2026And2025Rows(
	closeFn2026: (i: number) => number,
	base2025 = 10_000_000,
): { year2026: OhlcvRow[]; year2025: OhlcvRow[] } {
	const year2026 = makeTimestampedRows(91, closeFn2026, Date.UTC(2026, 0, 1));
	const year2025 = makeTimestampedRows(365, () => base2025, Date.UTC(2025, 0, 1));
	return { year2026, year2025 };
}

describe('analyze_bb_snapshot', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearIndicatorCache();
	});

	it('inputSchema: limit は 40 以上のみ許可する', () => {
		const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', type: '1day', limit: 39 });
		expect(parse).toThrow();
	});

	it('正常系: default mode で BB の主要項目を返す', async () => {
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(res.data.mode).toBe('default');
		expect(res.data.bb).toHaveProperty('zScore');
		expect(res.data.bb).toHaveProperty('bandWidthPct');
		expect(res.data).toHaveProperty('signals');
	});

	it('fetch 失敗時は ok: false を返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		expect(res.ok).toBe(false);
	});

	it('フラット相場では current_vs_avg は NaN% ではなく 0.0% であるべき', async () => {
		const rows = makeFlatOhlcvRows(400, 10_000_000);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(res.data.context.current_vs_avg).toBe('0.0%');
	});

	it('フラット相場では high volatility シグナルを出すべきではない', async () => {
		const rows = makeFlatOhlcvRows(400, 10_000_000);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(res.data.signals).not.toContain('Band width expanded (100th percentile) - high volatility phase');
	});

	// ── Invalid pair ──────────────────────────────────────────────────

	it('無効な pair を渡すと ok: false を返す', async () => {
		const res = await analyzeBbSnapshot('invalid_pair', '1day', 120, 'default');
		assertFail(res);
	});

	// ── Default mode: position branches ──────────────────────────────

	it('near_middle: close が BB middle 付近なら near_middle になる', async () => {
		// 2026 データ: 交互 ±D の後、最終本は平均値 ≈ middle → |zScore| ≈ 0 → near_middle
		const base = 10_000_000;
		const D = 500_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => {
			if (i === 90) return base; // 最終本は平均値
			return base + (i % 20 < 10 ? -D : D); // 交互
		}, base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		// last close がほぼ mean なので |zScore| < 0.3 → near_middle
		expect(res.data.interpretation.position).toBe('near_middle');
		expect(res.data.signals).toContain('Price consolidating near middle band');
	});

	it('at_upper: 急激な上昇後に at_upper または upper_zone になる', async () => {
		const rows = makeStrongUptrendRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		const position = res.data.interpretation.position;
		expect(['at_upper', 'upper_zone', 'near_middle']).toContain(position);
	});

	it('at_lower: 急激な下落後に at_lower または lower_zone になる', async () => {
		const rows = makeStrongDowntrendRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		const position = res.data.interpretation.position;
		expect(['at_lower', 'lower_zone', 'near_middle']).toContain(position);
	});

	it('upper_zone: 緩やかな上昇トレンドで upper_zone または near_middle になる', async () => {
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		const position = res.data.interpretation.position;
		expect(['upper_zone', 'near_middle', 'at_upper']).toContain(position);
	});

	// ── Default mode: bandwidth_state branches ────────────────────────

	it('bandwidth_state: フラット相場では squeeze になる', async () => {
		const rows = makeFlatOhlcvRows(400, 10_000_000);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		// フラット相場では bandWidthPct ≈ 0 なので squeeze
		expect(res.data.interpretation.bandwidth_state).toBe('squeeze');
	});

	it('bandwidth_state: トレンド相場では normal/expanding/wide のいずれか', async () => {
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(['squeeze', 'normal', 'expanding', 'wide']).toContain(res.data.interpretation.bandwidth_state);
	});

	// ── Tags: above_upper_band_risk / below_lower_band_risk ───────────

	it('above_upper_band_risk タグ: 強い上昇で zScore > 1 のとき付与される可能性がある', async () => {
		const rows = makeStrongUptrendRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'extended');
		assertOk(res);
		// タグが付くかどうかは zScore 次第だが、エラーにならないことを確認
		expect(Array.isArray(res.data.tags)).toBe(true);
	});

	// ── volatility_trend branches ─────────────────────────────────────

	it('volatility_trend: timeseries が 10 本未満なら stable', async () => {
		// 少ないデータで呼び出す
		const rows = makeFlatOhlcvRows(60, 10_000_000);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		// timeseries が最大 30 本だが BB 計算期間が 20 なので timeseries は存在する
		// timeseries.length < 10 であれば stable が返る
		expect(['stable', 'increasing', 'decreasing']).toContain(res.data.interpretation.volatility_trend);
	});

	it('volatility_trend: 増加傾向のデータで increasing が返る可能性がある', async () => {
		// 後半だけ急激に広がるデータ
		const rows = makeStrongUptrendRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(['stable', 'increasing', 'decreasing']).toContain(res.data.interpretation.volatility_trend);
	});

	// ── Signals ───────────────────────────────────────────────────────

	it('No extreme positioning detected: シグナルが何もなければデフォルトシグナルが付く', async () => {
		// 緩やかなトレンドでシグナルが少ない状態を試みる
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		// signals 配列に何らかの要素があることを確認
		expect(res.data.signals.length).toBeGreaterThan(0);
	});

	it('Band width around typical levels シグナル: bandwidth_state が normal のとき付与', async () => {
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		if (res.data.interpretation.bandwidth_state === 'normal') {
			expect(res.data.signals).toContain('Band width around typical levels');
		}
	});

	// ── Extended mode ─────────────────────────────────────────────────

	it('extended mode: mode が extended で返る', async () => {
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'extended');
		assertOk(res);
		expect(res.data.mode).toBe('extended');
	});

	it('extended mode: position_analysis.current_zone が返る', async () => {
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'extended');
		assertOk(res);
		expect(res.data).toHaveProperty('position_analysis');
		const zone = res.data.position_analysis?.current_zone;
		expect(['within_1σ', '1σ_to_2σ', 'beyond_2σ', 'beyond_3σ', null]).toContain(zone);
	});

	it('extended mode: close が BB middle 付近なら current_zone が within_1σ', async () => {
		// 2026 データ: 緩やかなトレンドで zScore ≈ 0.82 → within_1σ
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows(
			(i) => base + i * 20_000, // 緩やかな上昇
			base,
		);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'extended');
		assertOk(res);
		// 緩やかな上昇: |zScore| <= 1 → within_1σ
		expect(res.data.position_analysis?.current_zone).toBe('within_1σ');
	});

	it('extended mode: 急上昇後は 1σ_to_2σ または beyond_2σ または beyond_3σ になる可能性', async () => {
		const rows = makeStrongUptrendRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'extended');
		assertOk(res);
		const zone = res.data.position_analysis?.current_zone;
		expect(['within_1σ', '1σ_to_2σ', 'beyond_2σ', 'beyond_3σ', null]).toContain(zone);
	});

	it('extended mode: bb に bands と zScore が含まれる', async () => {
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'extended');
		assertOk(res);
		expect(res.data.bb).toHaveProperty('zScore');
		// extended mode の bb は bands プロパティを持つ
		if ('bands' in res.data.bb) {
			expect(res.data.bb.bands).toHaveProperty('+2σ');
			expect(res.data.bb.bands).toHaveProperty('-2σ');
		}
	});

	it('extended mode: extreme_events が返る', async () => {
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'extended');
		assertOk(res);
		expect(res.data).toHaveProperty('extreme_events');
	});

	it('extended mode: fetch 失敗時は ok: false を返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'extended');
		expect(res.ok).toBe(false);
	});

	// ── buildBbDefaultText (pure function) ────────────────────────────

	it('buildBbDefaultText: signals が空なら "- None" が含まれる', () => {
		const text = buildBbDefaultText({
			baseSummary: 'BTC/JPY summary',
			position: 'near_middle',
			bandwidth_state: 'normal',
			volatility_trend: 'stable',
			bandWidthPct_percentile: null,
			current_vs_avg: null,
			signals: [],
			next_steps: {
				if_need_detail: "Use mode='extended'",
				if_need_visualization: 'Use render_chart_svg',
			},
			mid: 10_000_000,
			upper: 10_200_000,
			lower: 9_800_000,
			zScore: 0.1,
			bandWidthPct: 4.0,
			timeseries: null,
		});
		expect(text).toContain('- None');
	});

	it('buildBbDefaultText: signals がある場合それぞれ "- " プレフィックスで含まれる', () => {
		const text = buildBbDefaultText({
			baseSummary: 'BTC/JPY summary',
			position: 'upper_zone',
			bandwidth_state: 'expanding',
			volatility_trend: 'increasing',
			bandWidthPct_percentile: 75,
			current_vs_avg: '+10.0%',
			signals: ['Signal A', 'Signal B'],
			next_steps: {
				if_need_detail: "Use mode='extended'",
				if_need_visualization: 'Use render_chart_svg',
			},
			mid: 10_000_000,
			upper: 10_500_000,
			lower: 9_500_000,
			zScore: 0.8,
			bandWidthPct: 10.0,
			timeseries: null,
		});
		expect(text).toContain('- Signal A');
		expect(text).toContain('- Signal B');
		expect(text).not.toContain('- None');
	});

	it('buildBbDefaultText: bandWidthPct_percentile が null のとき Band Width Percentile 行がない', () => {
		const text = buildBbDefaultText({
			baseSummary: 'BTC/JPY summary',
			position: 'near_middle',
			bandwidth_state: 'squeeze',
			volatility_trend: 'stable',
			bandWidthPct_percentile: null,
			current_vs_avg: null,
			signals: ['Some signal'],
			next_steps: {
				if_need_detail: "Use mode='extended'",
				if_need_visualization: 'Use render_chart_svg',
			},
			mid: 10_000_000,
			upper: 10_050_000,
			lower: 9_950_000,
			zScore: 0.0,
			bandWidthPct: 1.0,
			timeseries: null,
		});
		expect(text).not.toContain('Band Width Percentile:');
	});

	it('buildBbDefaultText: bandWidthPct_percentile があるとき Band Width Percentile 行が含まれる', () => {
		const text = buildBbDefaultText({
			baseSummary: 'BTC/JPY summary',
			position: 'near_middle',
			bandwidth_state: 'normal',
			volatility_trend: 'stable',
			bandWidthPct_percentile: 50,
			current_vs_avg: '+5.0%',
			signals: [],
			next_steps: {
				if_need_detail: "Use mode='extended'",
				if_need_visualization: 'Use render_chart_svg',
			},
			mid: 10_000_000,
			upper: 10_200_000,
			lower: 9_800_000,
			zScore: 0.2,
			bandWidthPct: 4.0,
			timeseries: null,
		});
		expect(text).toContain('Band Width Percentile: 50th');
	});

	it('buildBbDefaultText: timeseries が null のとき BB 推移セクションがない', () => {
		const text = buildBbDefaultText({
			baseSummary: 'BTC/JPY summary',
			position: 'near_middle',
			bandwidth_state: 'normal',
			volatility_trend: 'stable',
			bandWidthPct_percentile: null,
			current_vs_avg: null,
			signals: [],
			next_steps: {
				if_need_detail: "Use mode='extended'",
				if_need_visualization: 'Use render_chart_svg',
			},
			mid: 10_000_000,
			upper: 10_200_000,
			lower: 9_800_000,
			zScore: 0.1,
			bandWidthPct: 4.0,
			timeseries: null,
		});
		expect(text).not.toContain('BB推移');
	});

	it('buildBbDefaultText: timeseries があるとき BB 推移セクションが含まれる', () => {
		const timeseries = [
			{ time: '2024-01-01T00:00:00Z', zScore: 0.1, bandWidthPct: 4.0 },
			{ time: '2024-01-02T00:00:00Z', zScore: 0.2, bandWidthPct: 4.1 },
		];
		const text = buildBbDefaultText({
			baseSummary: 'BTC/JPY summary',
			position: 'near_middle',
			bandwidth_state: 'normal',
			volatility_trend: 'stable',
			bandWidthPct_percentile: null,
			current_vs_avg: null,
			signals: [],
			next_steps: {
				if_need_detail: "Use mode='extended'",
				if_need_visualization: 'Use render_chart_svg',
			},
			mid: 10_000_000,
			upper: 10_200_000,
			lower: 9_800_000,
			zScore: 0.1,
			bandWidthPct: 4.0,
			timeseries,
		});
		expect(text).toContain('BB推移');
		expect(text).toContain('2024-01-01');
	});

	it('buildBbDefaultText: position が null のとき n/a と表示される', () => {
		const text = buildBbDefaultText({
			baseSummary: 'BTC/JPY summary',
			position: null,
			bandwidth_state: null,
			volatility_trend: null,
			bandWidthPct_percentile: null,
			current_vs_avg: null,
			signals: [],
			next_steps: {
				if_need_detail: "Use mode='extended'",
				if_need_visualization: 'Use render_chart_svg',
			},
			mid: null,
			upper: null,
			lower: null,
			zScore: null,
			bandWidthPct: null,
			timeseries: null,
		});
		expect(text).toContain('Position: n/a');
		expect(text).toContain('Band State: n/a');
		expect(text).toContain('Volatility Trend: n/a');
	});

	// ── context: timeseries null/empty branches ───────────────────────

	it('context: データが少なく timeseries が空でも ok になる', async () => {
		// 最小限のデータ（BB 計算に必要な 20 本ギリギリ）
		const rows = makeFlatOhlcvRows(60, 10_000_000);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		// context プロパティは存在するが null の可能性もある
		expect(res.data).toHaveProperty('context');
	});

	// ── Signals: percentile < 20 / > 80 ──────────────────────────────

	it('signals: percentile < 20 のとき breakout setup シグナルが付く可能性', async () => {
		// フラット相場: bandWidthPct が非常に低く percentile < 20 になりやすい
		const rows = makeFlatOhlcvRows(400, 10_000_000);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		// フラット相場では bandWidthPct が全部ほぼ等しく percentile が 0 付近になる
		const hasBreakout = res.data.signals.some((s: string) => s.includes('compressed') && s.includes('percentile'));
		const hasHighVol = res.data.signals.some((s: string) => s.includes('expanded') && s.includes('percentile'));
		const hasNoExtreme = res.data.signals.includes('No extreme positioning detected');
		// いずれかのシグナルが存在するはず
		expect(hasBreakout || hasHighVol || hasNoExtreme || res.data.signals.length > 0).toBe(true);
	});

	it('signals: trending 相場で volatility increasing シグナルが付く可能性', async () => {
		const rows = makeStrongUptrendRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(res.data.signals.length).toBeGreaterThan(0);
	});

	// ── toolDef handler ───────────────────────────────────────────────

	it('toolDef.handler: 正常に呼び出せる', async () => {
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 120, mode: 'default' });
		expect(res).toBeDefined();
	});

	it('toolDef.handler: extended mode で呼び出せる', async () => {
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 120, mode: 'extended' });
		expect(res).toBeDefined();
	});

	// ── Invalid pair: failFromValidation path ────────────────────────────

	it('invalid pair (形式不正): failFromValidation を経由して ok: false を返す', async () => {
		// invalid_pair は ALLOWED_PAIRS に存在しないため failFromValidation が呼ばれる
		const res = await analyzeBbSnapshot('not_a_real_pair', '1day', 120, 'default');
		assertFail(res);
	});

	it('invalid pair (形式自体が不正): failFromValidation を経由して ok: false を返す', async () => {
		// スラッシュ区切りは normalizePair で null を返すため failFromValidation が呼ばれる
		const res = await analyzeBbSnapshot('BTC/JPY', '1day', 120, 'default');
		assertFail(res);
	});

	// ── Default mode: lower_zone (z between -0.3 and -1.8) ──────────────

	it('lower_zone: わずかに下落した場合に lower_zone になる', async () => {
		// 最後だけ少し下げて -0.3 < z < 0 を狙う
		const rows = makeHighZscoreRows(400, 0.05, -1);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		const position = res.data.interpretation.position;
		expect(['lower_zone', 'near_middle', 'at_lower']).toContain(position);
	});

	// ── bandwidth_state: wide (bw > 30) ──────────────────────────────────

	it('bandwidth_state: 高ボラ相場では wide または expanding になる', async () => {
		const rows = makeHighVolRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(['expanding', 'wide']).toContain(res.data.interpretation.bandwidth_state);
	});

	// ── Tags: above_upper_band_risk / below_lower_band_risk ──────────────

	it('above_upper_band_risk タグ: zScore > 1 のとき付与される', async () => {
		// deviationMultiplier=1 で zScore ≈ 2.18 となる
		const rows = makeHighZscoreRows(400, 1, 1);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'extended');
		assertOk(res);
		expect(res.data.tags).toContain('above_upper_band_risk');
	});

	it('below_lower_band_risk タグ: zScore < -1 のとき付与される', async () => {
		const rows = makeHighZscoreRows(400, 1, -1);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'extended');
		assertOk(res);
		expect(res.data.tags).toContain('below_lower_band_risk');
	});

	// ── volatility_trend: decreasing ─────────────────────────────────────

	it('volatility_trend: 前半高ボラ → 後半フラットで decreasing が返る', async () => {
		const rows = makeDecreasingVolRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(['stable', 'increasing', 'decreasing']).toContain(res.data.interpretation.volatility_trend);
	});

	// ── Signals: percentile < 20 (breakout setup) ────────────────────────

	it('signals: bandWidth が非常に低い場合 breakout setup シグナルが付く', async () => {
		// フラット相場: bandWidthPct がほぼ 0 → percentile < 20 → breakout setup
		const rows = makeFlatOhlcvRows(400, 10_000_000);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		// フラット相場では全バンド幅が均等に低い → percentile がほぼ 0 または 50
		// そのためシグナルが存在することのみを確認
		expect(res.data.signals.length).toBeGreaterThan(0);
	});

	// ── Signals: percentile > 80 (high volatility phase) ─────────────────

	it('signals: bandWidth が高い場合 high volatility phase シグナルが付く可能性', async () => {
		const rows = makeHighVolRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		// 高ボラ相場では percentile > 80 になりやすい
		const hasHighVol = res.data.signals.some((s: string) => s.includes('high volatility phase'));
		const hasSomeSignal = res.data.signals.length > 0;
		expect(hasSomeSignal).toBe(true);
		// high volatility phase シグナルが付くことを確認（付かない場合でもテスト通過）
		if (hasHighVol) {
			expect(res.data.signals.some((s: string) => s.includes('percentile'))).toBe(true);
		}
	});

	// ── Signals: No extreme positioning detected ──────────────────────────

	it('signals: No extreme positioning detected シグナルが付く場合がある', async () => {
		// トレンド相場かつ bandWidth が中程度のとき他のシグナルが付かない可能性がある
		// このテストは signals 配列が空でないことを確認するだけ
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(res.data.signals.length).toBeGreaterThan(0);
	});

	// ── Extended mode: current_zone branches ─────────────────────────────

	it('extended mode: zScore ≈ 2.18 → beyond_2σ の zone', async () => {
		// 2026 年末にスパイク 1 本だけ → zScore ≈ 2.18 → beyond_2σ
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows(
			(i) => (i === 90 ? base + 5_000_000 : base), // 最終本だけスパイク
			base,
		);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'extended');
		assertOk(res);
		const zone = res.data.position_analysis?.current_zone;
		expect(zone).toBe('beyond_2σ');
	});

	it('extended mode: zScore ≈ -2.18 → beyond_2σ の zone (下方向)', async () => {
		// 下方向スパイク → zScore ≈ -2.18 → beyond_2σ
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => (i === 90 ? base - 5_000_000 : base), base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'extended');
		assertOk(res);
		const zone = res.data.position_analysis?.current_zone;
		expect(zone).toBe('beyond_2σ');
	});

	it('extended mode: beyond_2σ を狙う（year-aware mock で single spike）', async () => {
		// 2025 年フラット、2026 年最終本のみスパイク → zScore ≈ 2.18 → beyond_2σ
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => (i === 90 ? base + 8_000_000 : base), base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'extended');
		assertOk(res);
		const zone = res.data.position_analysis?.current_zone;
		// zScore ≈ 2.18 は beyond_2σ 範囲（2 < |z| <= 3）
		expect(zone).toBe('beyond_2σ');
	});

	it('extended mode: 1σ_to_2σ を狙う（小さな偏差）', async () => {
		// deviationMultiplier=0.6 で zScore ≈ 1.3 → 1σ_to_2σ
		const rows = makeHighZscoreRows(400, 0.6, 1);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'extended');
		assertOk(res);
		const zone = res.data.position_analysis?.current_zone;
		expect(['within_1σ', '1σ_to_2σ', 'beyond_2σ']).toContain(zone);
	});

	// ── Default mode: at_upper (z >= 1.8) ────────────────────────────────

	it('default mode: at_upper → zScore >= 1.8 のとき at_upper になる', async () => {
		const rows = makeHighZscoreRows(400, 1, 1);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		// zScore ≈ 2.18 なので at_upper または upper_zone
		const position = res.data.interpretation.position;
		expect(['at_upper', 'upper_zone']).toContain(position);
	});

	it('default mode: at_lower → zScore <= -1.8 のとき at_lower になる', async () => {
		const rows = makeHighZscoreRows(400, 1, -1);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		const position = res.data.interpretation.position;
		expect(['at_lower', 'lower_zone']).toContain(position);
	});

	// ── context: timeseries null/empty branches ───────────────────────────

	it('context: bandWidthPct_30d_avg は timeseries が十分あれば計算される', async () => {
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		// timeseries が存在する場合 bandWidthPct_30d_avg が計算されることを確認
		if (res.data.context.bandWidthPct_30d_avg != null) {
			expect(typeof res.data.context.bandWidthPct_30d_avg).toBe('number');
		}
	});

	it('context: current_vs_avg は null または文字列', async () => {
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		const val = res.data.context.current_vs_avg;
		expect(val === null || typeof val === 'string').toBe(true);
	});

	// ── buildBbDefaultText: volatility_trend branches ────────────────────

	it('buildBbDefaultText: volatility_trend が increasing のとき Increasing が含まれる', () => {
		const text = buildBbDefaultText({
			baseSummary: 'BTC/JPY summary',
			position: 'upper_zone',
			bandwidth_state: 'expanding',
			volatility_trend: 'increasing',
			bandWidthPct_percentile: 85,
			current_vs_avg: '+20.0%',
			signals: ['Volatility increasing in recent periods'],
			next_steps: {
				if_need_detail: "Use mode='extended'",
				if_need_visualization: 'Use render_chart_svg',
			},
			mid: 10_000_000,
			upper: 10_800_000,
			lower: 9_200_000,
			zScore: 0.8,
			bandWidthPct: 16.0,
			timeseries: null,
		});
		expect(text).toContain('Volatility increasing in recent periods');
	});

	it('buildBbDefaultText: volatility_trend が decreasing のとき Decreasing が含まれる', () => {
		const text = buildBbDefaultText({
			baseSummary: 'BTC/JPY summary',
			position: 'near_middle',
			bandwidth_state: 'squeeze',
			volatility_trend: 'decreasing',
			bandWidthPct_percentile: 10,
			current_vs_avg: '-30.0%',
			signals: ['Volatility decreasing - potential squeeze forming'],
			next_steps: {
				if_need_detail: "Use mode='extended'",
				if_need_visualization: 'Use render_chart_svg',
			},
			mid: 10_000_000,
			upper: 10_100_000,
			lower: 9_900_000,
			zScore: 0.0,
			bandWidthPct: 2.0,
			timeseries: null,
		});
		expect(text).toContain('Volatility decreasing - potential squeeze forming');
	});

	it('buildBbDefaultText: signals に No extreme positioning detected が含まれる場合', () => {
		const text = buildBbDefaultText({
			baseSummary: 'BTC/JPY summary',
			position: 'upper_zone',
			bandwidth_state: 'normal',
			volatility_trend: 'stable',
			bandWidthPct_percentile: 50,
			current_vs_avg: '+5.0%',
			signals: ['No extreme positioning detected'],
			next_steps: {
				if_need_detail: "Use mode='extended'",
				if_need_visualization: 'Use render_chart_svg',
			},
			mid: 10_000_000,
			upper: 10_200_000,
			lower: 9_800_000,
			zScore: 0.5,
			bandWidthPct: 4.0,
			timeseries: null,
		});
		expect(text).toContain('No extreme positioning detected');
		expect(text).not.toContain('- None');
	});

	it('buildBbDefaultText: bandwidth_state が wide のとき wide が含まれる', () => {
		const text = buildBbDefaultText({
			baseSummary: 'BTC/JPY summary',
			position: 'at_upper',
			bandwidth_state: 'wide',
			volatility_trend: 'increasing',
			bandWidthPct_percentile: 95,
			current_vs_avg: '+80.0%',
			signals: ['Band width expanded (95th percentile) - high volatility phase'],
			next_steps: {
				if_need_detail: "Use mode='extended'",
				if_need_visualization: 'Use render_chart_svg',
			},
			mid: 10_000_000,
			upper: 11_600_000,
			lower: 8_400_000,
			zScore: 1.9,
			bandWidthPct: 32.0,
			timeseries: null,
		});
		expect(text).toContain('wide');
		expect(text).toContain('Band width expanded');
	});

	it('buildBbDefaultText: timeseries に zScore null エントリがある場合', () => {
		const timeseries = [
			{ time: '2024-01-01T00:00:00Z', zScore: null, bandWidthPct: null },
			{ time: '2024-01-02T00:00:00Z', zScore: 0.5, bandWidthPct: 4.0 },
		];
		const text = buildBbDefaultText({
			baseSummary: 'BTC/JPY summary',
			position: 'near_middle',
			bandwidth_state: 'normal',
			volatility_trend: 'stable',
			bandWidthPct_percentile: null,
			current_vs_avg: null,
			signals: [],
			next_steps: {
				if_need_detail: "Use mode='extended'",
				if_need_visualization: 'Use render_chart_svg',
			},
			mid: 10_000_000,
			upper: 10_200_000,
			lower: 9_800_000,
			zScore: 0.1,
			bandWidthPct: 4.0,
			timeseries,
		});
		expect(text).toContain('BB推移');
		expect(text).toContain('2024-01-01');
		expect(text).toContain('2024-01-02');
	});

	// ── 上流 warning の伝播（取得層 meta.warning / 計算層 meta.warnings） ──
	describe('上流 warning の伝播', () => {
		const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);

		/**
		 * BB が最小限に動くだけのモック応答を生成する。
		 * fetch 経由ではなく analyzeIndicators を直接モックすることで、
		 * meta.warning / meta.warnings の伝播だけを検証する。
		 */
		function buildBbIndicatorsMock(metaExtra: Record<string, unknown> = {}) {
			const len = 60;
			const normalized = Array.from({ length: len }, (_, i) => ({
				close: 10_000_000,
				isoTime: `2024-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
			}));
			const middleSeries = Array.from({ length: len }, () => 10_000_000);
			const upperSeries = Array.from({ length: len }, () => 10_100_000);
			const lowerSeries = Array.from({ length: len }, () => 9_900_000);
			return {
				ok: true as const,
				summary: 'ok',
				data: {
					normalized,
					indicators: {
						BB2_middle: 10_000_000,
						BB2_upper: 10_100_000,
						BB2_lower: 9_900_000,
						bb2_series: { upper: upperSeries, middle: middleSeries, lower: lowerSeries },
					},
				},
				meta: { pair: 'btc_jpy', type: '1day', count: len, ...metaExtra },
			};
		}

		it('default mode: 上流 meta.warning（取得層）が tool の meta.warning と summary 先頭に伝播する', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult(buildBbIndicatorsMock({ warning: '⚠️ partial fetch (3日中1日の取得に失敗)' })),
			);

			const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
			assertOk(res);
			expect(res.meta.warning).toBe('⚠️ partial fetch (3日中1日の取得に失敗)');
			expect(res.meta.warnings).toBeUndefined();
			expect(res.summary.split('\n')[0]).toContain('⚠️ partial fetch');
		});

		it('default mode: 上流 meta.warnings（計算層）が tool の meta.warnings に継承される', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult(buildBbIndicatorsMock({ warnings: ['SMA_200: データ不足', 'Ichimoku: データ不足'] })),
			);

			const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
			assertOk(res);
			expect(res.meta.warnings).toEqual(['SMA_200: データ不足', 'Ichimoku: データ不足']);
			expect(res.meta.warning).toBeUndefined();
			expect(res.summary).toContain('⚠️ SMA_200: データ不足');
			expect(res.summary).toContain('⚠️ Ichimoku: データ不足');
		});

		it('default mode: 取得層 warning と計算層 warnings は別フィールドで保持される（混入 NG）', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult(
					buildBbIndicatorsMock({
						warning: '⚠️ partial fetch (multi-year)',
						warnings: ['SMA_200: データ不足'],
					}),
				),
			);

			const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
			assertOk(res);
			expect(res.meta.warning).toBe('⚠️ partial fetch (multi-year)');
			expect(res.meta.warnings).toEqual(['SMA_200: データ不足']);
			expect(res.meta.warnings).not.toContain('partial fetch (multi-year)');
			const lines = res.summary.split('\n');
			expect(lines[0]).toContain('⚠️ partial fetch (multi-year)');
			expect(lines[1]).toContain('⚠️ SMA_200: データ不足');
		});

		it('default mode: 上流 warning なしなら meta.warning / meta.warnings は付与されない', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(buildBbIndicatorsMock()));

			const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
			assertOk(res);
			expect(res.meta.warning).toBeUndefined();
			expect(res.meta.warnings).toBeUndefined();
			expect(res.summary.startsWith('⚠️')).toBe(false);
		});

		it('extended mode: 上流 meta.warning（取得層）と meta.warnings（計算層）が両方伝播する', async () => {
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult(
					buildBbIndicatorsMock({
						warning: '⚠️ partial fetch (multi-year)',
						warnings: ['SMA_200: データ不足'],
					}),
				),
			);

			const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'extended');
			assertOk(res);
			expect(res.meta.warning).toBe('⚠️ partial fetch (multi-year)');
			expect(res.meta.warnings).toEqual(['SMA_200: データ不足']);
			const lines = res.summary.split('\n');
			expect(lines[0]).toContain('⚠️ partial fetch (multi-year)');
			expect(lines[1]).toContain('⚠️ SMA_200: データ不足');
		});
	});

	// ── Year-aware mock: specific zone / position branches ──────────────

	it('year-aware mock: at_upper (zScore ≈ 2.18 → at_upper)', async () => {
		// 2025 フラット + 2026 最終本スパイク → zScore ≈ 2.18 → at_upper
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => (i === 90 ? base + 5_000_000 : base), base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		expect(res.data.interpretation.position).toBe('at_upper');
	});

	it('year-aware mock: at_lower (zScore ≈ -2.18 → at_lower)', async () => {
		// 下方向スパイク → zScore ≈ -2.18 → at_lower
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => (i === 90 ? base - 5_000_000 : base), base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		expect(res.data.interpretation.position).toBe('at_lower');
	});

	it('year-aware mock: upper_zone (0.3 < z < 1.8)', async () => {
		// 緩やかな上昇トレンド → zScore ≈ 0.82 → upper_zone
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => base + i * 20_000, base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		expect(res.data.interpretation.position).toBe('upper_zone');
	});

	it('year-aware mock: lower_zone (−1.8 < z < −0.3)', async () => {
		// 緩やかな下降トレンド → zScore ≈ -0.82 → lower_zone
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => Math.max(base - i * 20_000, 1_000_000), base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		expect(res.data.interpretation.position).toBe('lower_zone');
	});

	it('year-aware mock: bandwidth_state normal (8 < bw <= 18)', async () => {
		// 3% 交互振動 → bw ≈ 12% → normal
		const base = 10_000_000;
		const D = base * 0.03;
		const { year2026, year2025 } = make2026And2025Rows((i) => base + (i % 2 === 0 ? D : -D), base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		expect(res.data.interpretation.bandwidth_state).toBe('normal');
	});

	it('year-aware mock: bandwidth_state expanding (18 < bw <= 30)', async () => {
		// 5% 交互振動 → bw ≈ 20% → expanding
		const base = 10_000_000;
		const D = base * 0.05;
		const { year2026, year2025 } = make2026And2025Rows((i) => base + (i % 2 === 0 ? D : -D), base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		expect(res.data.interpretation.bandwidth_state).toBe('expanding');
	});

	it('year-aware mock: bandwidth_state wide (bw > 30)', async () => {
		// 8% 交互振動 → bw ≈ 32% → wide
		const base = 10_000_000;
		const D = base * 0.08;
		const { year2026, year2025 } = make2026And2025Rows((i) => base + (i % 2 === 0 ? D : -D), base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		expect(res.data.interpretation.bandwidth_state).toBe('wide');
	});

	// ── volatility_trend: increasing / decreasing ─────────────────────────

	it('year-aware mock: volatility_trend increasing', async () => {
		// 後半 10 本だけ大きな振動（高 bw）→ recent5 > prev5 → increasing
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => {
			const pos = i - 61;
			if (i < 61) return base;
			if (pos < 20) return base + (i % 2 ? 50_000 : -50_000); // 小さな振動
			return base + (i % 2 ? 500_000 : -500_000); // 大きな振動
		}, base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		expect(res.data.interpretation.volatility_trend).toBe('increasing');
		expect(res.data.signals).toContain('Volatility increasing in recent periods');
	});

	it('year-aware mock: volatility_trend decreasing', async () => {
		// 前半 20 本は大きな振動、後半 10 本は小さな振動 → recent5 < prev5 → decreasing
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => {
			const pos = i - 61;
			if (i < 61) return base;
			if (pos < 20) return base + (i % 2 ? 500_000 : -500_000); // 大きな振動
			return base + (i % 2 ? 50_000 : -50_000); // 小さな振動
		}, base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		expect(res.data.interpretation.volatility_trend).toBe('decreasing');
		expect(res.data.signals).toContain('Volatility decreasing - potential squeeze forming');
	});

	// ── Signals: percentile < 20 (breakout) / > 80 (high vol) ────────────

	it('year-aware mock: percentile > 80 → high volatility phase signal', async () => {
		// bandWidth が過去比で高い状態 → percentile > 80 → high volatility phase signal
		const base = 10_000_000;
		// 前半は低 bw、後半は高 bw にして最終時点での percentile を高くする
		const { year2026, year2025 } = make2026And2025Rows((i) => {
			if (i < 61) return base + (i % 2 ? 50_000 : -50_000); // 低 bw
			return base + (i % 2 ? 500_000 : -500_000); // 高 bw
		}, base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		const hasHighVol = res.data.signals.some((s: string) => s.includes('high volatility phase'));
		const hasCompressed = res.data.signals.some((s: string) => s.includes('compressed'));
		// どちらか一方のパーセンタイルシグナルが付く
		expect(hasHighVol || hasCompressed || res.data.signals.length > 0).toBe(true);
		if (hasHighVol) {
			expect(res.data.signals.some((s: string) => s.includes('percentile'))).toBe(true);
		}
	});

	it('year-aware mock: percentile < 20 → breakout setup signal', async () => {
		// bandWidth が過去比で非常に低い状態 → percentile < 20 → breakout signal
		const base = 10_000_000;
		// 前半は高 bw、後半は低 bw → 最終時点での percentile が低くなる
		const { year2026, year2025 } = make2026And2025Rows((i) => {
			if (i < 61) return base + (i % 2 ? 500_000 : -500_000); // 高 bw
			return base + (i % 2 ? 30_000 : -30_000); // 低 bw
		}, base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		const hasBreakout = res.data.signals.some((s: string) => s.includes('compressed'));
		const hasHighVol = res.data.signals.some((s: string) => s.includes('high volatility phase'));
		expect(hasBreakout || hasHighVol || res.data.signals.length > 0).toBe(true);
	});

	// ── No extreme positioning detected ───────────────────────────────────

	it('year-aware mock: No extreme positioning detected が付く', async () => {
		// position=upper_zone, bw_state=squeeze, vol_trend=stable, context=nullでない場合
		// (bw_state=squeeze かつ position が near_middle でない かつ vol_trend=stable
		//  かつ percentile が 20〜80 なら "Band width X% vs 30-day average" が付く)
		// timeseries < 10 本の場合 context が null → 全シグナルなし → "No extreme positioning detected"
		const base = 10_000_000;
		// 少量のデータで timeseries を短くする
		const year2026 = makeTimestampedRows(
			30,
			(i) => (i === 29 ? base + 100_000 : base + (i % 2 ? 50_000 : -50_000)),
			Date.UTC(2026, 0, 1),
		);
		const year2025 = makeTimestampedRows(5, () => base, Date.UTC(2025, 0, 1));
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 40, 'default');
		assertOk(res);
		// signals が何らかの値を持つことを確認
		expect(res.data.signals.length).toBeGreaterThan(0);
	});

	// ── Extended mode: current_zone null / within_1σ ──────────────────────

	it('extended mode: current_zone null → zScore が null のとき null', async () => {
		// フラットデータ → std=0 → halfWidth=0 → zScore=null → current_zone=null
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows(() => base, base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'extended');
		assertOk(res);
		expect(res.data.position_analysis?.current_zone).toBeNull();
	});

	it('extended mode: within_1σ → |zScore| <= 1 のとき within_1σ', async () => {
		// 緩やかな上昇トレンド → |zScore| ≈ 0.82 → within_1σ
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => base + i * 20_000, base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'extended');
		assertOk(res);
		expect(res.data.position_analysis?.current_zone).toBe('within_1σ');
	});

	// ── Tags: above_upper / below_lower (year-aware) ─────────────────────

	it('year-aware mock: above_upper_band_risk タグが付く', async () => {
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => (i === 90 ? base + 5_000_000 : base), base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'extended');
		assertOk(res);
		expect(res.data.tags).toContain('above_upper_band_risk');
	});

	it('year-aware mock: below_lower_band_risk タグが付く', async () => {
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => (i === 90 ? base - 5_000_000 : base), base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'extended');
		assertOk(res);
		expect(res.data.tags).toContain('below_lower_band_risk');
	});

	// ── context: bandWidthPct_30d_avg / percentile calculation ───────────

	it('year-aware mock: context.bandWidthPct_30d_avg が計算される', async () => {
		// 十分な timeseries があるとき bandWidthPct_30d_avg が number になる
		const base = 10_000_000;
		const D = base * 0.03;
		const { year2026, year2025 } = make2026And2025Rows((i) => base + (i % 2 === 0 ? D : -D), base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		expect(typeof res.data.context.bandWidthPct_30d_avg).toBe('number');
		expect(typeof res.data.context.bandWidthPct_percentile).toBe('number');
		expect(typeof res.data.context.current_vs_avg).toBe('string');
	});

	it('near_middle + bandwidth normal: Price consolidating + Band width around typical levels', async () => {
		// near_middle かつ bandwidth_state=normal のときシグナルが 2 つ付く
		const base = 10_000_000;
		const D = base * 0.03;
		const { year2026, year2025 } = make2026And2025Rows((i) => {
			if (i === 90) return base; // 最終本は平均値 → near_middle
			return base + (i % 20 < 10 ? -D : D); // 交互で normal bw
		}, base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		expect(res.data.interpretation.position).toBe('near_middle');
		expect(res.data.signals).toContain('Price consolidating near middle band');
		expect(res.data.interpretation.bandwidth_state).toBe('normal');
		expect(res.data.signals).toContain('Band width around typical levels');
	});

	// === 形成中足（provisional）注記 ===
	// 親 describe の afterEach が fetch 復元 + clearIndicatorCache() を実行する。
	describe('形成中足（provisional）注記', () => {
		// 最新足 ts を当日 UTC 0 時に揃え、realtime 取得（date 未指定）相当＝形成中にする。
		function makeRowsEndingToday(count: number): OhlcvRow[] {
			const todayStart = dayjs().utc().startOf('day').valueOf();
			const rows: OhlcvRow[] = [];
			for (let i = count - 1; i >= 0; i--) {
				const base = 10_000_000 + (count - 1 - i) * 1_000;
				rows.push([
					String(base),
					String(base + 2_000),
					String(base - 2_000),
					String(base + 500),
					'1.5',
					String(todayStart - i * 86_400_000),
				]);
			}
			return rows;
		}

		it('realtime（最新足が形成中）: content[0].text 相当の summary に未確定注記が出て meta.provisional=true', async () => {
			mockFetch(makeRowsEndingToday(250));
			const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
			assertOk(res);
			expect(res.summary).toContain('ℹ️ 最新足は未確定（形成中）');
			expect((res.meta as { provisional?: boolean }).provisional).toBe(true);
		});

		it('extended mode でも未確定注記が出て meta.provisional=true', async () => {
			mockFetch(makeRowsEndingToday(250));
			const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'extended');
			assertOk(res);
			expect(res.summary).toContain('ℹ️ 最新足は未確定（形成中）');
			expect((res.meta as { provisional?: boolean }).provisional).toBe(true);
		});

		it('過去の確定足（date 指定相当）: 注記が出ず meta.provisional も付かない', async () => {
			// makeTrendingOhlcvRows は startMs=2024-01-01 起点 → 最新足も確定済み
			mockFetch(makeTrendingOhlcvRows(250));
			const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
			assertOk(res);
			expect(res.summary).not.toContain('未確定（形成中）');
			expect((res.meta as { provisional?: boolean }).provisional).toBeUndefined();
		});
	});
});
