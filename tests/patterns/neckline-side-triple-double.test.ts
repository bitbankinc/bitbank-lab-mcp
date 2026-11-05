// 落ちた候補は `data.patterns` に残らないので、実データケースは `view=debug` の候補で理由コードと逸脱量を検算する。
// ライブデータは動くので、起票時の実例（山3 がネックライン下の `triple_top`）は同型を合成で固定する。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { necklineSideDetailsFrom, validateMainPointsNecklineSide } from '../../tools/patterns/structural.js';
import { asMockResult, assertOk } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { buildBtcJpy1hour202608Candles } from '../fixtures/btc_jpy_1hour_2026_08.js';

type Candle = { isoTime: string; open: number; high: number; low: number; close: number; volume: number };
type Candidate = {
	type: string;
	accepted: boolean;
	reason?: string;
	indices?: number[];
	details?: {
		necklinePrice?: number;
		maxDeviation?: number | null;
		// `necklinePrice` は線基準版（H&S）だけが offender ごとに持ち、スカラー版（triple / double）はトップレベルに 1 つ持つだけなので省略可能にしてある。
		offenders?: Array<{ idx: number; price: number; deviation: number; deviationPct: number; necklinePrice?: number }>;
	};
};

const pt = (idx: number, price: number) => ({ idx, price });

afterEach(() => {
	vi.restoreAllMocks();
});

describe('validateMainPointsNecklineSide（issue #216 Phase 2）', () => {
	it('top: 全主構成点がネックラインより上なら通す', () => {
		expect(validateMainPointsNecklineSide('top', [pt(1, 105), pt(5, 104), pt(9, 106)], 100)).toEqual({
			reason: null,
			offenders: [],
		});
	});

	it('bottom: 全主構成点がネックラインより下なら通す', () => {
		expect(validateMainPointsNecklineSide('bottom', [pt(1, 95), pt(5, 96), pt(9, 94)], 100)).toEqual({
			reason: null,
			offenders: [],
		});
	});

	it('top: 誤った側の点を全件返す（中間点も検査対象）', () => {
		const res = validateMainPointsNecklineSide('top', [pt(1, 105), pt(5, 98), pt(9, 97)], 100);
		expect(res.reason).toBe('peaks_below_neckline');
		// 最後の 1 点だけを見ない。実データにも第2構成点が誤側の構造が実在する（下の `triple_top` 204-211-219）。
		expect(res.offenders).toEqual([
			{ idx: 5, price: 98, deviation: 2 },
			{ idx: 9, price: 97, deviation: 3 },
		]);
	});

	it('bottom: 理由コードが side で分かれる（`view=debug` の reason 横断合計で潰れないため）', () => {
		const res = validateMainPointsNecklineSide('bottom', [pt(1, 95), pt(9, 101)], 100);
		expect(res.reason).toBe('valleys_above_neckline');
		expect(res.offenders).toEqual([{ idx: 9, price: 101, deviation: 1 }]);
	});

	it('境界: ネックラインと同値の点は失格（「より上 / より下」ではない）', () => {
		expect(validateMainPointsNecklineSide('top', [pt(1, 105), pt(9, 100)], 100).reason).toBe('peaks_below_neckline');
		expect(validateMainPointsNecklineSide('bottom', [pt(1, 95), pt(9, 100)], 100).reason).toBe(
			'valleys_above_neckline',
		);
	});

	it('境界: 許容幅を置いていないので 1 円の逸脱でも落ちる（ゼロ許容）', () => {
		expect(validateMainPointsNecklineSide('top', [pt(9, 99.999999)], 100).reason).toBe('peaks_below_neckline');
		expect(validateMainPointsNecklineSide('top', [pt(9, 100.000001)], 100).reason).toBeNull();
	});

	it('空配列: 判定材料が無いので素通し', () => {
		expect(validateMainPointsNecklineSide('top', [], 100)).toEqual({ reason: null, offenders: [] });
	});

	it('単一要素: 1 点でも判定する', () => {
		expect(validateMainPointsNecklineSide('top', [pt(3, 90)], 100).offenders).toEqual([
			{ idx: 3, price: 90, deviation: 10 },
		]);
	});

	it('欠損: ネックラインが有限でなければ素通し（意図しない理由で検出を減らさない）', () => {
		for (const nl of [Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(validateMainPointsNecklineSide('top', [pt(1, 1), pt(2, 2)], nl)).toEqual({
				reason: null,
				offenders: [],
			});
		}
	});

	it('欠損: 価格が有限でない主構成点は検査から除く（落とさない）', () => {
		const res = validateMainPointsNecklineSide('top', [pt(1, Number.NaN), pt(5, 105)], 100);
		expect(res).toEqual({ reason: null, offenders: [] });
	});

	it('重複入力: 同じ点が 2 度渡ってもそれぞれ計上する（呼び出し側の構成点列をそのまま映す）', () => {
		const res = validateMainPointsNecklineSide('top', [pt(9, 97), pt(9, 97)], 100);
		expect(res.offenders).toHaveLength(2);
	});
});

describe('necklineSideDetailsFrom（issue #216 Phase 2）', () => {
	it('どの点がどれだけ外れたかを 1 点ずつ出す', () => {
		const { offenders } = validateMainPointsNecklineSide('top', [pt(5, 98), pt(9, 97)], 100);
		expect(necklineSideDetailsFrom(100, offenders)).toEqual({
			necklinePrice: 100,
			offenders: [
				{ idx: 5, price: 98, deviation: 2, deviationPct: 0.02 },
				{ idx: 9, price: 97, deviation: 3, deviationPct: 0.03 },
			],
			maxDeviation: 3,
		});
	});

	it('空配列で -Infinity を載せない', () => {
		expect(necklineSideDetailsFrom(100, []).maxDeviation).toBeNull();
	});
});

// 山1 / 山2 = 終値 100.0、山3 = 終値 95.6（高値はいずれも 104.0）、谷1 / 谷2 = 終値 96.0 → ネックライン 96.0 で、山3 はネックラインより 0.4 下。
// 高値に 4.0 のヒゲを置いてあるのは `spreadRatio` を `MAX_LEVEL_SPREAD_RATIO` 以下に収めるため（ヒゲが無いと「山3 がネックライン下」と「ばらつきが高さの半分以下」は両立しない）。
const LIVE_SHAPED_ROWS: Array<[number, number, number]> = [
	// close, high, low
	[96.0, 96.5, 95.5],
	[94.0, 94.5, 93.5],
	[92.0, 92.5, 91.5],
	[90.0, 90.5, 89.5],
	[88.0, 88.5, 86.0], // idx 4: 先行安値（構造ゲートの起点）
	[90.0, 90.5, 89.5],
	[92.5, 93.0, 92.0],
	[95.0, 95.5, 94.5],
	[97.5, 98.0, 97.0],
	[100.0, 104.0, 99.0], // idx 9: 山1
	[97.5, 98.0, 97.0],
	[96.8, 97.3, 96.3],
	[96.4, 96.9, 95.9],
	[96.0, 96.5, 92.0], // idx 13: 谷1（double のネックライン）
	[96.6, 97.1, 96.1],
	[97.5, 98.0, 97.0],
	[98.5, 99.0, 98.0],
	[100.0, 104.0, 99.5], // idx 17: 山2
	[98.0, 98.5, 97.5],
	[97.0, 97.5, 96.5],
	[96.4, 96.9, 95.9],
	[96.0, 96.5, 92.0], // idx 21: 谷2
	[96.2, 96.7, 95.7],
	[96.0, 96.5, 95.5],
	[95.8, 96.3, 95.3],
	[95.6, 104.0, 95.1], // idx 25: 山3 — 終値がネックライン 96.0 より下
	[95.0, 95.5, 94.5],
	[94.0, 94.5, 93.5], // idx 27: ネックライン下抜け（1.5% バッファ込み）
	[93.0, 93.5, 92.5],
	[92.0, 92.5, 91.5],
	[91.0, 91.5, 90.5],
	[90.0, 90.5, 89.5],
	[89.0, 89.5, 88.5],
	[88.0, 88.5, 87.5],
];

function buildLiveShapedCandles(): Candle[] {
	return LIVE_SHAPED_ROWS.map(([close, high, low], i) => ({
		isoTime: dayjs.utc('2026-01-01T00:00:00Z').add(i, 'hour').toISOString(),
		open: close,
		high,
		low,
		close,
		volume: 100,
	}));
}

async function detectDebug(
	candles: Candle[],
	tf: string,
	opts: Record<string, unknown> = {},
): Promise<{ patterns: Array<Record<string, unknown>>; candidates: Candidate[] }> {
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = await detectPatterns('btc_jpy', tf, candles.length, { view: 'debug', ...opts });
	assertOk(res);
	const meta = res.meta as { debug?: { candidates?: Candidate[] } } | undefined;
	return {
		patterns: res.data.patterns as Array<Record<string, unknown>>,
		candidates: meta?.debug?.candidates ?? [],
	};
}

const mainIdxs = (p: Record<string, unknown>) => ((p.pivots as Array<{ idx: number }>) ?? []).map((v) => v.idx);

describe('主構成点がネックラインの誤った側にある形（issue #216 Phase 2・合成 fixture）', () => {
	it('山3 がネックラインより下の triple_top は data.patterns に出ない', async () => {
		const { patterns } = await detectDebug(buildLiveShapedCandles(), '1hour');
		expect(patterns.filter((p) => p.type === 'triple_top')).toHaveLength(0);
	});

	it('棄却理由は peaks_below_neckline で、details にどの点がどれだけ外れたかが載る', async () => {
		const { candidates } = await detectDebug(buildLiveShapedCandles(), '1hour');
		const rejected = candidates.filter((c) => c.reason === 'peaks_below_neckline');
		// strict 1 経路 + relaxed 2 段（factor 1.25 / 2.0）が同じ 3 山を拾い直すので複数件出る。strict にだけ入れると relaxed が同じ形を confidence × 0.95 で拾い直して素通りする。
		expect(rejected.length).toBeGreaterThanOrEqual(2);
		expect(rejected[0]).toMatchObject({ type: 'triple_top', accepted: false, indices: [9, 17, 25] });
		expect(rejected[0]?.details).toEqual({
			necklinePrice: 96,
			offenders: [
				{ idx: 25, price: 95.6, deviation: expect.closeTo(0.4, 6), deviationPct: expect.closeTo(0.004167, 6) },
			],
			maxDeviation: expect.closeTo(0.4, 6),
		});
	});

	// #216 のゲートは double を落とさない（主構成点は山1 / 山2 でどちらもネックラインより上。中間構成点はネックラインの定義点なので検査に含めない）が、山2 の後に山3 を作ってから割っているので #242 の経路ゲートで `invalid` になる。
	it('同じ 3 点の先頭 2 山から出る double_top は #216 では落ちない（#242 で invalid になる）', async () => {
		const { patterns, candidates } = await detectDebug(buildLiveShapedCandles(), '1hour');
		expect(patterns.filter((p) => p.type === 'double_top')).toHaveLength(0);
		expect(candidates.filter((c) => c.type === 'double_top' && c.reason === 'peaks_below_neckline')).toHaveLength(0);

		const { patterns: withInvalid } = await detectDebug(buildLiveShapedCandles(), '1hour', { includeInvalid: true });
		const doubles = withInvalid.filter((p) => p.type === 'double_top');
		expect(doubles).toHaveLength(1);
		expect(doubles[0]).toMatchObject({ status: 'invalid', invalidReason: 'peak_after_last_pivot' });
		expect(mainIdxs(doubles[0])).toEqual([9, 13, 17]);
	});

	it('谷3 がネックラインより上の triple_bottom も同じ形で落ちる（top の符号反転）', async () => {
		// 上の系列を水準 200 で折り返した鏡像。谷3 の終値 104.4 がネックライン 104.0 より上。
		const mirrored: Candle[] = LIVE_SHAPED_ROWS.map(([close, high, low], i) => ({
			isoTime: dayjs.utc('2026-01-01T00:00:00Z').add(i, 'hour').toISOString(),
			open: 200 - close,
			high: 200 - low,
			low: 200 - high,
			close: 200 - close,
			volume: 100,
		}));
		const { patterns, candidates } = await detectDebug(mirrored, '1hour');
		expect(patterns.filter((p) => p.type === 'triple_bottom')).toHaveLength(0);
		const rejected = candidates.filter((c) => c.reason === 'valleys_above_neckline');
		expect(rejected[0]).toMatchObject({ type: 'triple_bottom', accepted: false, indices: [9, 17, 25] });
		expect(rejected[0]?.details?.offenders?.[0]).toMatchObject({ idx: 25 });
	});
});

describe('同じ形が凍結済み実データにも存在する（issue #216 Phase 2・btc_jpy_1hour_2026_08）', () => {
	/** `patterns` で種別を絞るのは `view=debug` の cap 対策（`detect_patterns.ts` は候補を要求種別で絞ってから `cap = 200` でトリムする。#124）。 */
	async function realDataCandidates(tf: string, want: string[]): Promise<Candidate[]> {
		const { candidates } = await detectDebug(buildBtcJpy1hour202608Candles(), tf, { patterns: want });
		return candidates;
	}

	it('triple_top: 構成点 219-223-232 は neckline-side gate で除外される', async () => {
		const cands = await realDataCandidates('1hour', ['triple_top']);
		const hit = cands.find((c) => c.reason === 'peaks_below_neckline' && c.indices?.[0] === 219);
		expect(hit?.indices).toEqual([219, 223, 232]);
	});

	it('triple_top: 横ばい先行の構成点 211-219-223 も方向ゲートで除外される', async () => {
		const cands = await realDataCandidates('1hour', ['triple_top']);
		expect(cands.some((c) => c.reason === 'prior_trend_mismatch:sideways' && String(c.indices) === '211,219,223')).toBe(
			true,
		);
	});

	it('triple_bottom: 上昇先行の構成点 205-214-220 も方向ゲートで除外される', async () => {
		const cands = await realDataCandidates('1hour', ['triple_bottom']);
		expect(cands.some((c) => c.reason === 'prior_trend_mismatch:up' && String(c.indices) === '205,214,220')).toBe(true);
	});

	it('double_bottom: 谷2 がネックラインより 20,213 円上（Phase 1 の逸脱量の最大側）', async () => {
		const cands = await realDataCandidates('1min', ['double_bottom']);
		const hit = cands.find((c) => c.reason === 'valleys_above_neckline');
		expect(hit?.indices).toEqual([285, 287, 288]);
		expect(hit?.details?.necklinePrice).toBe(12536893);
		expect(hit?.details?.offenders).toEqual([
			{ idx: 288, price: 12557106, deviation: 20213, deviationPct: expect.closeTo(0.0016123, 7) },
		]);
	});

	it('H&S 側の配線と方向ゲートに加え、窓先頭の履歴不足候補も出力されない', async () => {
		// スカラー版ゲートは triple / double にしか配線しておらず、ここでは H&S 側の配線（`validateMainPointsAgainstNecklineAt`）がこの fixture の既定オプションの出力を動かさないことを固定する。
		// 既定パラメータで落ちる H&S 系は逆 H&S 225-232-249-265-272 の 1 件だけで、`globalDedup` の代表ではないので `data.patterns` の件数に出ない。
		const { patterns, candidates } = await detectDebug(buildBtcJpy1hour202608Candles(), '1hour');
		const hs = patterns.filter((p) => String(p.type).includes('head_and_shoulders'));
		expect(hs).toHaveLength(0);
		// スカラー版の理由コードは triple / double からしか出ない。
		expect(
			candidates.some(
				(c) =>
					String(c.type).includes('head_and_shoulders') &&
					c.reason?.endsWith('_neckline') &&
					// 線基準版は同じ理由コードを使う（`view=debug` の出力形を揃えるため）。スカラー版と区別できるのは details の形で、offender ごとに necklinePrice を持つ。
					c.details?.offenders?.every((o) => !('necklinePrice' in o)),
			),
		).toBe(false);
	});
});
