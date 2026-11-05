import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult, assertOk } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { buildBtcJpy1hour202609Candles } from '../fixtures/btc_jpy_1hour_2026_09.js';
import {
	BTC_JPY_1HOUR_2026_09_05_ISSUE_WINDOW,
	buildBtcJpy1hour20260905Candles,
} from '../fixtures/btc_jpy_1hour_2026_09_05.js';
import { makeCandle } from '../fixtures/synthetic_pattern_candles.js';

type Candle = { isoTime: string; open: number; high: number; low: number; close: number; volume: number };
type Candidate = {
	type: string;
	accepted: boolean;
	reason?: string;
	indices?: number[];
	details?: Record<string, unknown>;
};

afterEach(() => {
	vi.restoreAllMocks();
});

// 役割と idx：先行安値 10 / 山1 15 / 谷（ネックライン）19 / 山2（最終構成点）23 / 再上昇の H ピボット 27 / ブレイク確認 29。
// idx 27 の終値 126 は 25% ゾーンの下限 127（アンカー = 高安 133、高さ = 133 − 109 = 24、下限 = 133 − 24 × 0.25）に 1 だけ届かないので、既存の `detectTroughZoneReentry` では発火しない。
const WITH_PEAK_BETWEEN = [
	92, 94, 96, 98, 100, 101, 100, 99, 98, 97, 96, 102, 110, 118, 126, 130, 124, 120, 116, 112, 117, 121, 125, 129, 122,
	119, 122, 126, 120, 108, 104, 100, 98, 96,
];

/** 上の系列から idx 24〜29 の再上昇だけを取り除いた対照系列（山2 から直接割る）。 */
const WITHOUT_PEAK_BETWEEN = [
	92, 94, 96, 98, 100, 101, 100, 99, 98, 97, 96, 102, 110, 118, 126, 130, 124, 120, 116, 112, 117, 121, 125, 129, 122,
	118, 114, 108, 104, 100, 98, 96,
];

/** `makeCandle` の高安も対称に反転する。 */
function mirror(closes: number[]): number[] {
	return closes.map((c) => 226 - c);
}

function toCandles(closes: number[]): Candle[] {
	return closes.map((close, i) => makeCandle(i, close));
}

async function detectDebug(
	candles: Candle[],
	opts: Record<string, unknown> = {},
): Promise<{ patterns: Array<Record<string, unknown>>; candidates: Candidate[] }> {
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = await detectPatterns('btc_jpy', '1day', candles.length, { view: 'debug', swingDepth: 3, ...opts });
	assertOk(res);
	const meta = res.meta as { debug?: { candidates?: Candidate[] } } | undefined;
	return {
		patterns: res.data.patterns as Array<Record<string, unknown>>,
		candidates: meta?.debug?.candidates ?? [],
	};
}

const mainIdxs = (p: Record<string, unknown>) => ((p.pivots as Array<{ idx: number }>) ?? []).map((v) => v.idx);

describe('double_top: 山2 の後に山を作ってから割る形（issue #242・合成 fixture）', () => {
	it('既定では data.patterns に出ない', async () => {
		const { patterns } = await detectDebug(toCandles(WITH_PEAK_BETWEEN));
		expect(patterns.filter((p) => p.type === 'double_top')).toHaveLength(0);
	});

	it('includeInvalid: true で status=invalid + invalidReason=peak_after_last_pivot として出る', async () => {
		const { patterns } = await detectDebug(toCandles(WITH_PEAK_BETWEEN), { includeInvalid: true });
		const doubles = patterns.filter((p) => p.type === 'double_top');
		expect(doubles).toHaveLength(1);
		expect(doubles[0]).toMatchObject({ status: 'invalid', invalidReason: 'peak_after_last_pivot' });
		expect(mainIdxs(doubles[0])).toEqual([15, 19, 23]);
	});

	it('view=debug の候補に理由コードと「間のピボット」が残る', async () => {
		const { candidates } = await detectDebug(toCandles(WITH_PEAK_BETWEEN));
		const hit = candidates.find((c) => c.type === 'double_top' && c.reason === 'peak_after_last_pivot');
		expect(hit, JSON.stringify(candidates)).toBeDefined();
		expect(hit?.indices).toEqual([15, 19, 23]);
		expect(hit?.details).toMatchObject({
			lastPivotIdx: 23,
			breakoutIdx: 29,
			offenderIdx: 27,
			offenderPrice: 126,
			offenderExtremePrice: 129,
		});
	});

	it('既存の re_entered_trough_zone では拾えない配置になっている（2 つの検査は独立）', async () => {
		const { patterns, candidates } = await detectDebug(toCandles(WITH_PEAK_BETWEEN), { includeInvalid: true });
		expect(patterns.every((p) => p.invalidReason !== 're_entered_trough_zone')).toBe(true);
		expect(candidates.every((c) => c.reason !== 're_entered_trough_zone')).toBe(true);
	});

	it('中間の山を取り除いた対照系列は accepted のまま（他の理由で落ちていない）', async () => {
		const { patterns } = await detectDebug(toCandles(WITHOUT_PEAK_BETWEEN));
		const doubles = patterns.filter((p) => p.type === 'double_top');
		expect(doubles).toHaveLength(1);
		expect(doubles[0].status).toBeUndefined();
		expect(mainIdxs(doubles[0])).toEqual([15, 19, 23]);
	});
});

describe('double_bottom: 谷2 の後に谷を作ってから抜ける形（issue #242・符号反転）', () => {
	it('invalidReason は trough_after_last_pivot（種別の接頭辞を付けない）', async () => {
		const { patterns } = await detectDebug(toCandles(mirror(WITH_PEAK_BETWEEN)), { includeInvalid: true });
		const doubles = patterns.filter((p) => p.type === 'double_bottom');
		expect(doubles).toHaveLength(1);
		expect(doubles[0]).toMatchObject({ status: 'invalid', invalidReason: 'trough_after_last_pivot' });
		expect(mainIdxs(doubles[0])).toEqual([15, 19, 23]);
	});

	it('中間の谷を取り除いた対照系列は accepted のまま', async () => {
		const { patterns } = await detectDebug(toCandles(mirror(WITHOUT_PEAK_BETWEEN)));
		const doubles = patterns.filter((p) => p.type === 'double_bottom');
		expect(doubles).toHaveLength(1);
		expect(doubles[0].status).toBeUndefined();
	});
});

describe('同じ形が凍結済み実データにも存在する（issue #242・btc_jpy_1hour_2026_09）', () => {
	async function realData(opts: Record<string, unknown> = {}) {
		vi.mocked(analyzeIndicators).mockResolvedValueOnce(
			asMockResult({ ok: true, summary: 'ok', data: { chart: { candles: buildBtcJpy1hour202609Candles() } } }),
		);
		const res = await detectPatterns('btc_jpy', '1hour', 365, { view: 'debug', patterns: ['double_top'], ...opts });
		assertOk(res);
		const meta = res.meta as { debug?: { candidates?: Candidate[] } } | undefined;
		return {
			patterns: res.data.patterns as Array<Record<string, unknown>>,
			candidates: meta?.debug?.candidates ?? [],
		};
	}

	it('構成点 174-177-184 の double_top は既定で出ない', async () => {
		const { patterns } = await realData();
		expect(patterns.filter((p) => mainIdxs(p).join('-') === '174-177-184')).toHaveLength(0);
	});

	it('includeInvalid: true なら peak_after_last_pivot として出る', async () => {
		const { patterns } = await realData({ includeInvalid: true });
		const hit = patterns.find((p) => mainIdxs(p).join('-') === '174-177-184');
		expect(hit, JSON.stringify(patterns.map(mainIdxs))).toBeDefined();
		expect(hit).toMatchObject({ type: 'double_top', status: 'invalid', invalidReason: 'peak_after_last_pivot' });
	});

	it('view=debug の候補に間のピボット（idx 194）が載る', async () => {
		const { candidates } = await realData();
		const hit = candidates.find((c) => c.reason === 'peak_after_last_pivot' && c.indices?.join('-') === '174-177-184');
		expect(hit).toBeDefined();
		expect(hit?.details).toMatchObject({ lastPivotIdx: 184, breakoutIdx: 198, offenderIdx: 194 });
	});
});

describe('起票時のライブ実例そのもの（issue #242・実データ D の limit=72 窓）', () => {
	/** issue 本文の idx に一律 +288 すると実データ D の idx になるので、本 describe の期待値は issue 本文と同じ idx（窓の中の相対 idx）で書ける。 */
	async function liveWindow(opts: Record<string, unknown> = {}) {
		const { start, end } = BTC_JPY_1HOUR_2026_09_05_ISSUE_WINDOW;
		const candles = buildBtcJpy20260905Window(start, end);
		vi.mocked(analyzeIndicators).mockResolvedValueOnce(
			asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
		);
		const res = await detectPatterns('btc_jpy', '1hour', candles.length, { view: 'debug', ...opts });
		assertOk(res);
		const meta = res.meta as
			| { debug?: { candidates?: Candidate[]; swings?: Array<Record<string, unknown>> } }
			| undefined;
		return {
			patterns: res.data.patterns as Array<Record<string, unknown>>,
			candidates: meta?.debug?.candidates ?? [],
			swings: meta?.debug?.swings ?? [],
		};
	}

	function buildBtcJpy20260905Window(start: number, end: number): Candle[] {
		return buildBtcJpy1hour20260905Candles().slice(start, end);
	}

	it('スイング列が issue 本文と一致する（窓の切り出しの検算）', async () => {
		const { swings } = await liveWindow({ includeInvalid: true, includeForming: true });
		const around = swings
			.filter((s) => Number(s.idx) >= 41 && Number(s.idx) <= 58)
			.map((s) => `${s.kind}${s.idx}@${s.price}`);
		expect(around).toEqual(['H41@12718980', 'L46@12617594', 'H50@12639245', 'H55@12711037', 'L58@12343265']);
	});

	it('double_top は既定で出ない（受け入れ条件）', async () => {
		const { patterns } = await liveWindow();
		expect(patterns.filter((p) => p.type === 'double_top')).toHaveLength(0);
	});

	it('includeInvalid: true で peak_after_last_pivot として出て、triangle_ascending invalid は残る', async () => {
		const { patterns } = await liveWindow({ includeInvalid: true });

		const doubles = patterns.filter((p) => p.type === 'double_top');
		expect(doubles).toHaveLength(1);
		expect(doubles[0]).toMatchObject({ status: 'invalid', invalidReason: 'peak_after_last_pivot' });
		expect(mainIdxs(doubles[0])).toEqual([41, 46, 50]);

		// 値動きの正しい読みはこちら（#242 本文）。
		const asc = patterns.filter((p) => p.type === 'triangle_ascending');
		expect(asc).toHaveLength(1);
		expect(asc[0].status).toBe('invalid');
	});

	it('view=debug の候補に issue 本文と同じ「間のピボット」が載る', async () => {
		const { candidates } = await liveWindow();
		const hit = candidates.find((c) => c.type === 'double_top' && c.reason === 'peak_after_last_pivot');
		expect(hit).toBeDefined();
		expect(hit?.indices).toEqual([41, 46, 50]);
		expect(hit?.details).toEqual({
			lastPivotIdx: 50,
			breakoutIdx: 56,
			offenderIdx: 55,
			offenderPrice: 12_711_037,
			offenderExtremePrice: 12_731_234,
		});
	});

	it('既存の再進入チェックでは拾えない（ゾーン下限に 0.3% 届かない配置）', async () => {
		const { patterns, candidates } = await liveWindow({ includeInvalid: true });
		expect(patterns.every((p) => p.invalidReason !== 're_entered_trough_zone')).toBe(true);
		expect(candidates.every((c) => c.reason !== 're_entered_trough_zone')).toBe(true);
	});

	describe('経路ゲートの判定は swingDepth に依存する（issue #251 案 3・仕様として固定）', () => {
		// ゲートを深さ非依存に変える PR（例: `detectPivotBeforeBreakout` を足の高安ベースへ書き換える）は、ここの期待値を意図的に更新すること。
		// `swingDepth: 6` では H55 が極値にならない（深さ 6 の窓 idx 49〜61 に `high[50] = 12,800,000` / `high[49] = 12,750,000` があり、いずれも 12,731,234 より上）。
		it('swingDepth: 3 では peak_after_last_pivot で invalid（深さ依存の対照）', async () => {
			const { patterns } = await liveWindow({ includeInvalid: true, swingDepth: 3 });
			const doubles = patterns.filter((p) => p.type === 'double_top');
			expect(doubles).toHaveLength(1);
			expect(doubles[0]).toMatchObject({ status: 'invalid', invalidReason: 'peak_after_last_pivot' });
			expect(mainIdxs(doubles[0])).toEqual([41, 46, 50]);
		});

		it('swingDepth: 6 では時間足別閾値により上昇先行の double_top を確定する', async () => {
			const { patterns, candidates } = await liveWindow({ swingDepth: 6 });
			const doubles = patterns.filter((p) => p.type === 'double_top');
			expect(doubles).toHaveLength(1);
			expect(mainIdxs(doubles[0])).toEqual([41, 46, 50]);
			expect((doubles[0] as { precedingTrend?: { direction?: string } } | undefined)?.precedingTrend?.direction).toBe(
				'up',
			);
			expect(
				candidates.some((c) => c.reason === 'prior_trend_mismatch:sideways' && c.indices?.join('-') === '41-46-50'),
			).toBe(false);
		});

		it('swingDepth: 6 では debug の swings に idx 55 の H が無い（深さ 6 で極値にならない事実）', async () => {
			const { swings } = await liveWindow({ includeInvalid: true, includeForming: true, swingDepth: 6 });
			const around = swings
				.filter((s) => Number(s.idx) >= 41 && Number(s.idx) <= 58)
				.map((s) => `${s.kind}${s.idx}@${s.price}`);
			// swingDepth: 3 の同じ範囲は `H41 / L46 / H50 / H55 / L58`（上のケース）。H55 だけが落ちる。
			expect(around).toEqual(['H41@12718980', 'L46@12617594', 'H50@12639245', 'L58@12343265']);
			expect(swings.some((s) => Number(s.idx) === 55)).toBe(false);
		});

		it('swingDepth: 6 では peak_after_last_pivot の候補が 1 件も出ない', async () => {
			const { candidates } = await liveWindow({ swingDepth: 6 });
			expect(candidates.every((c) => c.reason !== 'peak_after_last_pivot')).toBe(true);
		});
	});
});

describe('窓の終端の余白: 同じ値動きが limit で completed / invalid に分かれる（issue #277）', () => {
	// `detectSwingPoints` の走査範囲は `[swingDepth, length − swingDepth)` なので、窓の最後の `swingDepth` 本はピボットになれない。
	// `swingDepth` は未指定（`1hour` の時間軸オート = 3）で通す。深さを変えずに `limit` だけで結果が割れることが本 describe の主張なので、`swingDepth: 6` は使わない。
	const START = 288;
	const rel = (abs: number) => abs - START;

	async function windowEndingAt(end: number, opts: Record<string, unknown> = {}) {
		const candles = buildBtcJpy1hour20260905Candles().slice(START, end);
		vi.mocked(analyzeIndicators).mockResolvedValueOnce(
			asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
		);
		const res = await detectPatterns('btc_jpy', '1hour', candles.length, { view: 'debug', ...opts });
		assertOk(res);
		const meta = res.meta as
			| { debug?: { candidates?: Candidate[]; swings?: Array<Record<string, unknown>> } }
			| undefined;
		return {
			patterns: res.data.patterns as Array<Record<string, unknown>>,
			candidates: meta?.debug?.candidates ?? [],
			swings: meta?.debug?.swings ?? [],
			warnings: (res.data as { warnings?: string[] }).warnings ?? [],
		};
	}

	/** 両窓で同一であることを固定する構成点（`double_top` の山1 / 谷 / 山2）。 */
	const MAIN_POINTS = [rel(329), rel(334), rel(338)];
	const MAIN_POINT_TIMES = ['2026-09-03T21:00:00.000Z', '2026-09-04T02:00:00.000Z', '2026-09-04T06:00:00.000Z'];

	/** 窓が違えば同じ相対 idx が違う日時になりうるため、日時での突き合わせが「同じ値動きを見ている」ことの証拠になる。 */
	const timesOf = (p: Record<string, unknown>, candles: Array<{ isoTime: string }>) =>
		mainIdxs(p).map((i) => candles[i]?.isoTime);

	const windowCandles = (end: number) => buildBtcJpy1hour20260905Candles().slice(START, end);

	it('切り出しの検算: 終端の足と再上昇の足の日時（両窓）', () => {
		const candles = buildBtcJpy1hour20260905Candles();
		expect(candles[343].isoTime).toBe('2026-09-04T11:00:00.000Z'); // 再上昇
		expect(candles[345].isoTime).toBe('2026-09-04T13:00:00.000Z'); // slice(288, 346) の終端
		expect(candles[348].isoTime).toBe('2026-09-04T16:00:00.000Z'); // slice(288, 349) の終端
		// 余白（swingDepth = 3）の中か外か。
		expect(345 - 343).toBe(2);
		expect(348 - 343).toBe(5);
	});

	describe('終端 09-04T13:00Z（slice(288, 346)/ 58 本）— 再上昇が余白の中', () => {
		it('経路が通った上昇先行の double_top は時間足別閾値で確定する（swingDepth 未指定）', async () => {
			const { patterns, warnings, candidates } = await windowEndingAt(346);
			const doubles = patterns.filter((p) => p.type === 'double_top');
			expect(doubles).toHaveLength(1);
			expect((doubles[0] as { precedingTrend?: { direction?: string } } | undefined)?.precedingTrend?.direction).toBe(
				'up',
			);
			expect(
				candidates.some(
					(c) => c.reason === 'prior_trend_mismatch:sideways' && c.indices?.join('-') === MAIN_POINTS.join('-'),
				),
			).toBe(false);
			expect(warnings).not.toContain('limit_too_small_for_timeframe');
		});

		it('再上昇の足（idx 55）がピボット列に無い——ゲートは「通した」のではなく見る点が無い', async () => {
			const { swings } = await windowEndingAt(346, { includeInvalid: true, includeForming: true });
			const around = swings.filter((s) => Number(s.idx) >= rel(329)).map((s) => `${s.kind}${s.idx}@${s.price}`);
			expect(around).toEqual(['H41@12718980', 'L46@12617594', 'H50@12639245']);
			expect(swings.some((s) => Number(s.idx) === rel(343))).toBe(false);
		});

		it('view=debug の候補に peak_after_last_pivot が 1 件も出ない', async () => {
			const { candidates } = await windowEndingAt(346);
			expect(candidates.every((c) => c.reason !== 'peak_after_last_pivot')).toBe(true);
		});
	});

	describe('終端 09-04T16:00Z（slice(288, 349)/ 61 本）— 再上昇がピボットになる', () => {
		it('既定では data.patterns から double_top が消える', async () => {
			const { patterns, warnings } = await windowEndingAt(349);
			expect(patterns.filter((p) => p.type === 'double_top')).toHaveLength(0);
			expect(warnings).not.toContain('limit_too_small_for_timeframe');
		});

		it('includeInvalid: true で invalid / peak_after_last_pivot として出る（構成点は同一）', async () => {
			const { patterns } = await windowEndingAt(349, { includeInvalid: true });
			const doubles = patterns.filter((p) => p.type === 'double_top');
			expect(doubles).toHaveLength(1);
			expect(doubles[0]).toMatchObject({ status: 'invalid', invalidReason: 'peak_after_last_pivot' });
			expect(mainIdxs(doubles[0])).toEqual(MAIN_POINTS);
			expect(timesOf(doubles[0], windowCandles(349))).toEqual(MAIN_POINT_TIMES);
		});

		it('view=debug の候補に余白から出てきた idx 55 が offender として載る', async () => {
			const { candidates, swings } = await windowEndingAt(349);
			expect(swings.some((s) => Number(s.idx) === rel(343) && s.kind === 'H')).toBe(true);
			const hit = candidates.find((c) => c.type === 'double_top' && c.reason === 'peak_after_last_pivot');
			expect(hit).toBeDefined();
			expect(hit?.indices).toEqual(MAIN_POINTS);
			expect(hit?.details).toMatchObject({
				lastPivotIdx: rel(338),
				breakoutIdx: rel(344),
				offenderIdx: rel(343),
			});
		});
	});

	describe('境界そのもの（slice(288, 347)/ 59 本）— 再上昇が余白から 1 本だけ外れる', () => {
		// 上の 2 窓は境界を挟むだけなので、走査範囲を 1 本狭めた実装（`[swingDepth + 1, length − swingDepth − 1)`）でも通ってしまう。
		it('終端 09-04T14:00Z で invalid / peak_after_last_pivot に変わる', async () => {
			const { patterns, swings } = await windowEndingAt(347, { includeInvalid: true });
			// 走査範囲の右端が再上昇の足そのもの。
			expect(347 - START - 3 - 1).toBe(rel(343));
			expect(swings.some((sw) => Number(sw.idx) === rel(343) && sw.kind === 'H')).toBe(true);

			const doubles = patterns.filter((p) => p.type === 'double_top');
			expect(doubles).toHaveLength(1);
			expect(doubles[0]).toMatchObject({ status: 'invalid', invalidReason: 'peak_after_last_pivot' });
			expect(mainIdxs(doubles[0])).toEqual(MAIN_POINTS);
		});

		it('1 本手前（slice(288, 346)）も上昇先行として確定する', async () => {
			const { patterns, candidates } = await windowEndingAt(346, { includeInvalid: true });
			const doubles = patterns.filter((p) => p.type === 'double_top');
			expect(doubles).toHaveLength(1);
			expect((doubles[0] as { precedingTrend?: { direction?: string } } | undefined)?.precedingTrend?.direction).toBe(
				'up',
			);
			expect(candidates.some((c) => c.reason === 'prior_trend_mismatch:sideways')).toBe(false);
		});
	});

	describe('実データ C の 365 本窓も先行トレンドを検証する（終端が同じ 09-04T13:00Z）', () => {
		/** 同じ形が C では構成点 348-353-357（= D の 329-334-338。`i + 19` の対応）として入っている。 */
		async function realDataC(opts: Record<string, unknown> = {}) {
			vi.mocked(analyzeIndicators).mockResolvedValueOnce(
				asMockResult({ ok: true, summary: 'ok', data: { chart: { candles: buildBtcJpy1hour202609Candles() } } }),
			);
			const res = await detectPatterns('btc_jpy', '1hour', 365, { view: 'debug', patterns: ['double_top'], ...opts });
			assertOk(res);
			const meta = res.meta as { debug?: { candidates?: Candidate[] } } | undefined;
			return {
				patterns: res.data.patterns as Array<Record<string, unknown>>,
				candidates: meta?.debug?.candidates ?? [],
			};
		}

		it('構成点 348-353-357 は上昇先行として既定で残る', async () => {
			const { patterns, candidates } = await realDataC();
			const hit = patterns.find((p) => mainIdxs(p).join('-') === '348-353-357');
			expect(hit, JSON.stringify(patterns.map(mainIdxs))).toBeDefined();
			expect((hit as { precedingTrend?: { direction?: string } } | undefined)?.precedingTrend?.direction).toBe('up');
			expect(
				candidates.some((c) => c.reason === 'prior_trend_mismatch:sideways' && c.indices?.join('-') === '348-353-357'),
			).toBe(false);
			// 再上昇の足は C の idx 362（= D の 343）で、終端 364 の 2 本前＝余白の中。
			expect(
				candidates.every((c) => !(c.reason === 'peak_after_last_pivot' && c.indices?.join('-') === '348-353-357')),
			).toBe(true);
		});
	});
});

describe('relaxed 経路は invalid になった候補で走査を打ち切らない（issue #242 のレビュー指摘）', () => {
	// 役割と idx：先行安値 4 / H0 9 / L1 13 / H2 17 / L3 21 / H4 25 / ネックライン下抜け 29。
	// `tolerancePct: 0.02` を明示するのは relaxed 経路を踏ませるため。隣接する山の相対差は 2.31% / 2.36% で、strict の `near`（2%）は落ちるが relaxed（2% × 1.3 = 2.6%）は通る。
	const NESTED_DOUBLE_TOPS = [
		100, 99, 98, 97, 96, 102, 110, 118, 126, 130, 124, 120, 116, 112, 117, 121, 125, 127, 124, 120, 117, 115, 118, 121,
		123, 124, 121, 118, 115, 108, 104, 100, 98, 96,
	];

	async function relaxed(opts: Record<string, unknown> = {}) {
		return detectDebug(toCandles(NESTED_DOUBLE_TOPS), { tolerancePct: 0.02, ...opts });
	}

	it('先頭が invalid でも、後ろの横ばい候補は completed として返さない', async () => {
		const { patterns, candidates } = await relaxed();
		const doubles = patterns.filter((p) => p.type === 'double_top');
		expect(doubles).toHaveLength(0);
		expect(
			candidates.some((c) => c.reason === 'prior_trend_mismatch:sideways' && c.indices?.join('-') === '17-21-25'),
		).toBe(true);
	});

	it('落ちた先頭の候補は view=debug に理由コード付きで残る', async () => {
		const { candidates } = await relaxed();
		const hit = candidates.find((c) => c.type === 'double_top' && c.reason === 'peak_after_last_pivot');
		expect(hit).toBeDefined();
		expect(hit?.indices).toEqual([9, 13, 17]);
		expect(hit?.details).toMatchObject({ lastPivotIdx: 17, breakoutIdx: 29, offenderIdx: 25 });
	});

	it('includeInvalid では経路不備の先頭候補だけを返す', async () => {
		const { patterns } = await relaxed({ includeInvalid: true });
		const doubles = patterns.filter((p) => p.type === 'double_top');
		expect(doubles).toHaveLength(1);
		expect(mainIdxs(doubles[0])).toEqual([9, 13, 17]);
		expect(doubles[0]).toMatchObject({ status: 'invalid', invalidReason: 'peak_after_last_pivot' });
	});
});
