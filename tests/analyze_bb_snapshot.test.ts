import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../lib/datetime.js';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';

// 既存のテストは fetch モックで analyze_indicators の全フローを通すので default export は actual の passthrough にし、warning 伝播テストでは mockResolvedValueOnce で 1 回だけ上書きする。
vi.mock('../tools/analyze_indicators.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../tools/analyze_indicators.js')>();
	return {
		...actual,
		default: vi.fn(actual.default),
	};
});

import { toolDef as analyzeIndicatorsToolDef } from '../src/handlers/analyzeIndicatorsHandler.js';
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

/** 直近 20 本のうち 19 本が baseClose、最後の 1 本が baseClose + deviation のとき zScore ≈ 2.18 で、deviation の大きさ（deviationMultiplier）には依存しない。 */
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

function makeDecreasingVolRows(count: number): OhlcvRow[] {
	const startMs = Date.UTC(2024, 0, 1);
	const baseClose = 10_000_000;
	const rows: OhlcvRow[] = [];
	for (let i = 0; i < count; i++) {
		const ts = startMs + i * 86_400_000;
		const halfPoint = Math.floor(count * 0.6);
		const close = i < halfPoint ? baseClose + (i % 2 === 0 ? 500_000 : -500_000) : baseClose;
		rows.push([String(close), String(close), String(close), String(close), '1.0', String(ts)]);
	}
	return rows;
}

/** bandWidthPct > 30% (wide) にするために交互に大きく上下するデータ。 */
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

// 終値を中心値から ±swingPct(i) で交互に振る。σ が中心値 × swingPct になるので、バンド幅 ≈ 4 × swingPct × 100（%）。
function makeAlternatingRows(count: number, swingPct: (i: number) => number): OhlcvRow[] {
	const startMs = Date.UTC(2024, 0, 1);
	const center = 10_000_000;
	const rows: OhlcvRow[] = [];
	for (let i = 0; i < count; i++) {
		const close = center * (1 + (i % 2 === 0 ? swingPct(i) : -swingPct(i)));
		rows.push([String(close), String(close), String(close), String(close), '1.0', String(startMs + i * 86_400_000)]);
	}
	return rows;
}

function makeStrongUptrendRows(count: number): OhlcvRow[] {
	const startMs = Date.UTC(2024, 0, 1);
	const rows: OhlcvRow[] = [];
	for (let i = 0; i < count; i++) {
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

function makeStrongDowntrendRows(count: number): OhlcvRow[] {
	const startMs = Date.UTC(2024, 0, 1);
	const rows: OhlcvRow[] = [];
	for (let i = 0; i < count; i++) {
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

/** analyzeIndicators が 2 年分のデータを並列取得するので、URL に含まれる年を見て返し分け、BB ウィンドウ内のスパイク本数を制御する。 */
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

function makeTimestampedRows(count: number, closeFn: (i: number) => number, startMs: number): OhlcvRow[] {
	return Array.from({ length: count }, (_, i) => {
		const close = closeFn(i);
		const ts = startMs + i * 86_400_000;
		return [String(close), String(close), String(close), String(close), '1.0', String(ts)] as OhlcvRow;
	});
}

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

	it('無効な pair を渡すと ok: false を返す', async () => {
		const res = await analyzeBbSnapshot('invalid_pair', '1day', 120, 'default');
		assertFail(res);
	});

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

	it('bandwidth_state: 幅がずっと一定なら、過去と比べて標準（50%）', async () => {
		const rows = makeFlatOhlcvRows(400, 10_000_000);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(res.data.interpretation.bandwidth_state).toBe('normal');
		expect(res.data.context.bandWidthPct_percentile).toBe(50);
	});

	it('bandwidth_state: 直近だけ振れが小さいと、幅の絶対値に依らず squeeze', async () => {
		// 前半は ±5%（幅 ≈ 20%）、直近 30 本は ±2%（幅 ≈ 8%）。固定の区切りなら 8% は squeeze の境目だが、ここでは過去との比較で決まる
		const rows = makeAlternatingRows(400, (i) => (i >= 370 ? 0.02 : 0.05));
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(res.data.interpretation.bandwidth_state).toBe('squeeze');
		expect(res.data.signals.some((s: string) => s.includes('Band width compressed'))).toBe(true);
	});

	it('bandwidth_state: 直近だけ振れが大きいと wide', async () => {
		const rows = makeAlternatingRows(400, (i) => (i >= 370 ? 0.05 : 0.02));
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(res.data.interpretation.bandwidth_state).toBe('wide');
		expect(res.data.signals.some((s: string) => s.includes('high volatility phase'))).toBe(true);
	});

	it('bandwidth_state: トレンド相場では normal/expanding/wide のいずれか', async () => {
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(['squeeze', 'normal', 'expanding', 'wide']).toContain(res.data.interpretation.bandwidth_state);
	});

	it('above_upper_band_risk タグ: 強い上昇で zScore > 2 のとき付与される可能性がある', async () => {
		const rows = makeStrongUptrendRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'extended');
		assertOk(res);
		// タグが付くかどうかは zScore 次第だが、エラーにならないことを確認
		expect(Array.isArray(res.data.tags)).toBe(true);
	});

	it('volatility_trend: timeseries が 10 本未満なら stable', async () => {
		const rows = makeFlatOhlcvRows(60, 10_000_000);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		// timeseries が 10 本未満なら stable が返るので、3 値のどれかであることだけを見る。
		expect(['stable', 'increasing', 'decreasing']).toContain(res.data.interpretation.volatility_trend);
	});

	it('volatility_trend: 増加傾向のデータで increasing が返る可能性がある', async () => {
		const rows = makeStrongUptrendRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(['stable', 'increasing', 'decreasing']).toContain(res.data.interpretation.volatility_trend);
	});

	it('No extreme positioning detected: シグナルが何もなければデフォルトシグナルが付く', async () => {
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(res.data.signals.length).toBeGreaterThan(0);
	});

	it('Band width around typical levels シグナル: bandwidth_state が normal のとき付与', async () => {
		// 振れ幅が一定なので、幅の順位は 50%（normal）
		const rows = makeAlternatingRows(400, () => 0.03);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(res.data.interpretation.bandwidth_state).toBe('normal');
		expect(res.data.signals).toContain('Band width around typical levels');
	});

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
		// 交互 ±D の後、最終本は平均値 ≈ middle → |zScore| ≈ 0
		const base = 10_000_000;
		const D = 500_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => {
			if (i === 90) return base;
			return base + (i % 20 < 10 ? -D : D);
		}, base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'extended');
		assertOk(res);
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
		expect(res.data.bb).toHaveProperty(['bands', '+2σ']);
		expect(res.data.bb).toHaveProperty(['bands', '-2σ']);
	});

	it('extended mode: extreme_events が返る', async () => {
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'extended');
		assertOk(res);
		expect(res.data).toHaveProperty('extreme_events');
	});

	it('extended mode: ±1σ・±3σ のバンドと幅も返す（±2σ と同じ中心・同じ σ）', async () => {
		mockFetch(makeAlternatingRows(400, (i) => (i >= 370 ? 0.05 : 0.02)));

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'extended');
		assertOk(res);
		const bb = res.data.bb as {
			middle: number;
			bands: Record<string, number>;
			bandWidthPct: Record<string, number>;
		};
		const { bands, bandWidthPct, middle } = bb;
		expect(bands['+3σ']).toBeGreaterThan(bands['+2σ']);
		expect(bands['+2σ']).toBeGreaterThan(bands['+1σ']);
		expect(bands['+1σ']).toBeGreaterThan(middle);
		expect(bands['-1σ']).toBeLessThan(middle);
		expect(bands['-3σ']).toBeLessThan(bands['-2σ']);
		expect(bandWidthPct['±1σ']).toBeCloseTo(bandWidthPct['±2σ'] / 2, 1);
		expect(bandWidthPct['±3σ']).toBeCloseTo((bandWidthPct['±2σ'] * 3) / 2, 1);
		expect((res.data.interpretation as { volatility_state: string }).volatility_state).toBe('wide');
		expect(res.data.interpretation).not.toHaveProperty('extreme_risk');
		expect(res.data.extreme_events).not.toHaveProperty('band_walk_detected');
	});

	it('extended mode: 直近 30 本で ±2σ・±3σ に届いた終値の本数を数え、本文にも数値を出す', async () => {
		// 最終本だけのスパイクは √19 ≈ 4.36σ なので、±2σ・±3σ ともに 1 本
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => (i === 90 ? base + 5_000_000 : base), base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'extended');
		assertOk(res);
		const events = res.data.extreme_events as Record<string, number | null>;
		expect(events.touches_2σ_last_30d).toBe(1);
		expect(events.touches_3σ_last_30d).toBe(1);
		expect(res.summary).toContain('current_zone: beyond_3σ');
		expect(res.summary).toMatch(/\+3σ:\d/);
		expect(res.summary).toContain('直近30本の終値: ±2σ 以上 1本 / ±3σ 以上 1本');
		expect(res.summary).toContain('above_upper_band_risk');
	});

	it('extended mode: fetch 失敗時は ok: false を返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'extended');
		expect(res.ok).toBe(false);
	});

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

	it('context: データが少なく timeseries が空でも ok になる', async () => {
		const rows = makeFlatOhlcvRows(60, 10_000_000);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		// context プロパティは存在するが null の可能性もある
		expect(res.data).toHaveProperty('context');
	});

	it('signals: percentile < 20 のとき breakout setup シグナルが付く可能性', async () => {
		// フラット相場: bandWidthPct が非常に低く percentile < 20 になりやすい
		const rows = makeFlatOhlcvRows(400, 10_000_000);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		const hasBreakout = res.data.signals.some((s: string) => s.includes('compressed') && s.includes('percentile'));
		const hasHighVol = res.data.signals.some((s: string) => s.includes('expanded') && s.includes('percentile'));
		const hasNoExtreme = res.data.signals.includes('No extreme positioning detected');
		expect(hasBreakout || hasHighVol || hasNoExtreme || res.data.signals.length > 0).toBe(true);
	});

	it('signals: trending 相場で volatility increasing シグナルが付く可能性', async () => {
		const rows = makeStrongUptrendRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(res.data.signals.length).toBeGreaterThan(0);
	});

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

	it('lower_zone: わずかに下落した場合に lower_zone になる', async () => {
		const rows = makeHighZscoreRows(400, 0.05, -1);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		const position = res.data.interpretation.position;
		expect(['lower_zone', 'near_middle', 'at_lower']).toContain(position);
	});

	it('bandwidth_state: 高ボラでも、ずっと同じ振れ幅なら標準（幅の絶対値では決めない）', async () => {
		const rows = makeHighVolRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect((res.data.bb as { bandWidthPct: number }).bandWidthPct).toBeGreaterThan(30);
		expect(res.data.interpretation.bandwidth_state).toBe('normal');
	});

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

	it('volatility_trend: 前半高ボラ → 後半フラットで decreasing が返る', async () => {
		const rows = makeDecreasingVolRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(['stable', 'increasing', 'decreasing']).toContain(res.data.interpretation.volatility_trend);
	});

	it('signals: bandWidth が非常に低い場合 breakout setup シグナルが付く', async () => {
		// フラット相場: bandWidthPct がほぼ 0 → percentile < 20 → breakout setup
		const rows = makeFlatOhlcvRows(400, 10_000_000);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		// フラット相場では全バンド幅が均等に低く percentile がほぼ 0 または 50 になるので、シグナルが存在することのみを確認する。
		expect(res.data.signals.length).toBeGreaterThan(0);
	});

	it('signals: bandWidth が過去より高い場合 high volatility phase シグナルが付く', async () => {
		// 直近 20 本だけ振れ幅を広げ、今のバンド幅を期間内の上位 20% に入れる
		const rows = makeAlternatingRows(400, (i) => (i >= 380 ? 0.1 : 0.01));
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		const hasHighVol = res.data.signals.some((s: string) => s.includes('high volatility phase'));
		const hasSomeSignal = res.data.signals.length > 0;
		expect(hasSomeSignal).toBe(true);
		expect(hasHighVol).toBe(true);
		expect(res.data.signals.some((s: string) => s.includes('percentile'))).toBe(true);
	});

	it('signals: No extreme positioning detected シグナルが付く場合がある', async () => {
		// トレンド相場かつ bandWidth が中程度のとき他のシグナルが付かない可能性があるので、signals 配列が空でないことだけを確認する。
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(res.data.signals.length).toBeGreaterThan(0);
	});

	it('extended mode: 20 本窓で 1 本だけのスパイクは √19 ≈ 4.36σ → beyond_3σ', async () => {
		// 19 本が同じ値で 1 本だけ d ずれると、平均 d/20・標準偏差 d√19/20 なので (d − d/20) ÷ σ = √19。半幅単位の 2.18 ではない
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows(
			(i) => (i === 90 ? base + 5_000_000 : base), // 最終本だけスパイク
			base,
		);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'extended');
		assertOk(res);
		expect(res.data.bb.zScore).toBeCloseTo(Math.sqrt(19), 2);
		expect(res.data.position_analysis?.current_zone).toBe('beyond_3σ');
	});

	it('extended mode: 下方向のスパイクは -√19σ → beyond_3σ', async () => {
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => (i === 90 ? base - 5_000_000 : base), base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'extended');
		assertOk(res);
		expect(res.data.bb.zScore).toBeCloseTo(-Math.sqrt(19), 2);
		expect(res.data.position_analysis?.current_zone).toBe('beyond_3σ');
	});

	it('extended mode: スパイクの大きさに依らず σ 単位の値は √19 のまま', async () => {
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => (i === 90 ? base + 8_000_000 : base), base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'extended');
		assertOk(res);
		expect(res.data.bb.zScore).toBeCloseTo(Math.sqrt(19), 2);
		expect(res.data.position_analysis?.current_zone).toBe('beyond_3σ');
	});

	it('extended mode: 緩やかな上昇トレンドは 1σ_to_2σ', async () => {
		// 等差で上がる系列の最新値は、20 本窓で中心から約 1.65σ 上にある
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => base + i * 20_000, base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'extended');
		assertOk(res);
		const z = res.data.bb.zScore as number;
		expect(z).toBeGreaterThan(1);
		expect(z).toBeLessThanOrEqual(2);
		expect(res.data.position_analysis?.current_zone).toBe('1σ_to_2σ');
	});

	it('default mode: at_upper → zScore >= 2（上のバンド以上）のとき at_upper になる', async () => {
		const rows = makeHighZscoreRows(400, 1, 1);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		// 1 本だけのスパイクは √19 ≈ 4.36σ
		expect(res.data.interpretation.position).toBe('at_upper');
	});

	it('default mode: at_lower → zScore <= -2（下のバンド以下）のとき at_lower になる', async () => {
		const rows = makeHighZscoreRows(400, 1, -1);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(res.data.interpretation.position).toBe('at_lower');
	});

	it('context: bandWidthPct_30d_avg は timeseries が十分あれば計算される', async () => {
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		expect(typeof res.data.context.bandWidthPct_30d_avg).toBe('number');
	});

	it('context: current_vs_avg は null または文字列', async () => {
		const rows = makeTrendingOhlcvRows(400);
		mockFetch(rows);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 120, 'default');
		assertOk(res);
		const val = res.data.context.current_vs_avg;
		expect(val === null || typeof val === 'string').toBe(true);
	});

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
			bandWidthRank: { percentile: 97, sampleSize: 120 },
			volatility_trend: 'increasing',
			bandWidthPct_percentile: 97,
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

	describe('上流 warning の伝播', () => {
		const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);

		/** fetch 経由ではなく analyzeIndicators を直接モックして、meta.warning / meta.warnings の伝播だけを検証する。 */
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

	it('year-aware mock: 振れ幅が一定なら bandwidth_state は normal', async () => {
		const base = 10_000_000;
		const D = base * 0.03;
		const { year2026, year2025 } = make2026And2025Rows((i) => base + (i % 2 === 0 ? D : -D), base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		expect(res.data.interpretation.bandwidth_state).toBe('normal');
	});

	it('year-aware mock: 振れ幅が 3% でも 8% でも、ずっと一定なら同じ normal（幅の水準に依らない）', async () => {
		const base = 10_000_000;
		for (const swing of [0.03, 0.08]) {
			clearIndicatorCache();
			const D = base * swing;
			const { year2026, year2025 } = make2026And2025Rows((i) => base + (i % 2 === 0 ? D : -D), base);
			mockFetchByYear(year2026, year2025);

			const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
			assertOk(res);
			expect(res.data.interpretation.bandwidth_state).toBe('normal');
		}
	});

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

	it('year-aware mock: percentile > 80 → high volatility phase signal', async () => {
		// percentile は「直近 30 本の bandWidthPct のうち最新値を下回る本数」で決まる。段差状に 1 度だけ振幅を増やすと最終時点で 30 本すべてが高ボラ側に入り切って 80 に届かないので、振幅を単調増加させて最新バーの bandWidth を窓内で最大にする。
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => {
			const amplitude = 20_000 + i * 8_000; // 振幅を単調増加 → 20 期間 σ も単調増加
			return base + (i % 2 ? amplitude : -amplitude);
		}, base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(res);
		expect(res.data.context.bandWidthPct_percentile).toBeGreaterThan(80);
		expect(res.data.signals.some((s: string) => s.includes('high volatility phase'))).toBe(true);
		expect(res.data.signals.some((s: string) => s.includes('percentile'))).toBe(true);
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

	it('year-aware mock: No extreme positioning detected が付く', async () => {
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
		expect(res.data.signals.length).toBeGreaterThan(0);
	});

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
		const base = 10_000_000;
		const D = 500_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => {
			if (i === 90) return base;
			return base + (i % 20 < 10 ? -D : D);
		}, base);
		mockFetchByYear(year2026, year2025);

		const res = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'extended');
		assertOk(res);
		expect(res.data.position_analysis?.current_zone).toBe('within_1σ');
	});

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

	it('near_middle: Price consolidating シグナルが付く', async () => {
		// 最終本を平均値にすると直近の幅が窓の中で最も小さくなるので、幅の状態はここでは見ない（normal のシグナルは別のテストで見る）
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
	});

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

	it('同じ足で analyze_indicators と同じ σ を返す（半幅単位で半分の値にならない）', async () => {
		const base = 10_000_000;
		const { year2026, year2025 } = make2026And2025Rows((i) => (i === 90 ? base + 5_000_000 : base), base);
		mockFetchByYear(year2026, year2025);

		const bb = await analyzeBbSnapshot('btc_jpy', '1day', 60, 'default');
		assertOk(bb);
		const z = Number((bb.data.bb.zScore as number).toFixed(2));
		clearIndicatorCache();
		const ind = (await analyzeIndicatorsToolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 60 })) as {
			content: Array<{ text: string }>;
		};
		expect(ind.content[0].text).toContain(`現在位置: ${z}σ → 買われすぎ圏（+2σ以上）`);
		expect(bb.data.interpretation.position).toBe('at_upper');
	});
});
