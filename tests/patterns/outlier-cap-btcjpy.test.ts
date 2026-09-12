/**
 * issue #141 の回帰テスト — 外れ値除去の上限を BTC/JPY 日足の**実データ**で固定する。
 *
 * fixture は `tests/fixtures/btc_jpy_1day_2026.ts`（2026-05-29〜08-26 の 90 本）。
 *
 * `robustFit` は `line.r2 >= minR2` になるまで最悪残差の点を除き続ける。除去の上限が
 * 「minPoints(3) 個が残るまで」しか無かったため、**閾値をぎりぎり超えるまで捨てた線**が
 * 成立していた。この fixture では 34 点中 18 点を捨てた `triangle_symmetrical` が
 * `r2Upper 0.602 / r2Lower 0.648`（閾値 0.6 の直上）でスキャン窓の 88%（idx 0〜81）を
 * 占めていた。
 *
 * 合成 fixture では閾値の妥当性を検証できない（除去率が最大 14.3% にしか達しない）ので、
 * 上限の値はここで実データに対して固定する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BTC_JPY_1DAY_2026_OHLC, buildBtcJpy2026Candles } from '../fixtures/btc_jpy_1day_2026.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { getTriangleParams } from '../../tools/patterns/detect_triangles.js';

const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);
const candles = buildBtcJpy2026Candles();

/** 除去率の上限を超えていた候補 = スキャン窓の 88% を占めていた対称三角形（idx 0〜81）。 */
const OVERSIZED = { start: '2026-05-29', end: '2026-08-19' } as const;

/** 外れ値除去が上限内で、#141 が「捨てられている良質な候補」として挙げたもの。 */
const GOOD = [
	{ start: '2026-06-08', end: '2026-07-14', type: 'triangle_symmetrical' }, // idx [10,46] 除去 6/15
	{ start: '2026-07-28', end: '2026-08-18', type: 'triangle_symmetrical' }, // idx [60,81] 除去 1/9
] as const;

function indicatorsOk() {
	return {
		ok: true as const,
		summary: 'ok',
		data: { chart: { candles, meta: { pastBuffer: 0 }, indicators: {} } },
		meta: {},
	};
}

async function runTriangles() {
	mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
	const res = await detectPatterns('btc_jpy', '1day', 90, {
		patterns: ['triangle'],
		includeForming: true,
		includeCompleted: true,
		view: 'debug',
	});
	if (!res.ok) throw new Error('detectPatterns failed');
	return res;
}

const day = (iso?: string) => String(iso).slice(0, 10);

describe('issue #141 外れ値除去の上限 — BTC/JPY 日足 実データ回帰', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe('閾値', () => {
		it('除去率の上限は 0.5（各ラインが自分のアンカー点の半分以上を残す）', () => {
			expect(getTriangleParams('1day').maxOutlierRemovalRate).toBe(0.5);
		});

		it('時間足に依らず同じ上限（除去率は本数ではなく割合なのでスケールしない）', () => {
			for (const tf of ['1hour', '4hour', '1day', '1week']) {
				expect(getTriangleParams(tf).maxOutlierRemovalRate).toBe(0.5);
			}
		});
	});

	describe('窓の 88% を占めていた対称三角形', () => {
		it('検出結果から消える', async () => {
			const res = await runTriangles();
			const oversized = res.data.patterns.filter(
				(p) => day(p.range.start) === OVERSIZED.start && day(p.range.end) === OVERSIZED.end,
			);
			expect(oversized, 'スキャン窓の 88% を占める候補が残っている').toEqual([]);
		});

		it('棄却理由が理由コード付きで debug に出る', async () => {
			const res = await runTriangles();
			const rejected = (res.meta.debug?.candidates ?? []).filter((c) => c.reason === 'excessive_outlier_removal');
			expect(rejected.length, '棄却理由が 1 件も届いていない').toBeGreaterThan(0);
			// 分類前の棄却なので umbrella ラベルで積む（`poor_trendline_fit` と同じ契約）。
			expect(rejected.every((c) => c.type === 'triangle')).toBe(true);

			// 18 点を捨てていた候補 [0,81] は上ライン 6/15・下ライン 12/19 で、
			// **下ラインだけが**上限を超える。合算除去率（18/34 = 0.53）ではなく
			// ライン単位で見ていることの実データ上の裏付け。
			const target = rejected.find((c) => c.indices?.[0] === 0 && c.indices?.[1] === 80);
			const d = target?.details as Record<string, number | string> | undefined;
			expect(d, 'idx [0,80] の棄却が届いていない').toBeDefined();
			expect(d?.valleysRemoved).toBe(12);
			expect(d?.valleysTotal).toBe(19);
			expect(d?.lowerRemovalRate).toBeGreaterThan(0.5);
			expect(d?.peaksRemoved).toBe(6);
			expect(d?.peaksTotal).toBe(15);
			expect(d?.upperRemovalRate).toBeLessThanOrEqual(0.5);
			expect(d?.exceededSide).toBe('lower');
		});
	});

	describe('除去率が上限内の候補は残る', () => {
		it('#141 が「捨てられている」と指摘した高整合度の候補が検出される', async () => {
			const res = await runTriangles();
			const found = res.data.patterns.map((p) => `${p.type}|${day(p.range.start)}|${day(p.range.end)}`);
			for (const g of GOOD) {
				expect(found, `${g.type} ${g.start}→${g.end} が消えている`).toContain(`${g.type}|${g.start}|${g.end}`);
			}
		});

		it('採用された候補は上下とも除去率が 0.5 以内（不変条件）', async () => {
			const res = await runTriangles();
			const accepted = (res.meta.debug?.candidates ?? []).filter(
				(c) => c.accepted && String(c.type).startsWith('triangle'),
			);
			expect(accepted.length).toBeGreaterThan(0);
			// 閾値パラメータ経由ではなくリテラル 0.5 で固定する——パラメータを読むと
			// 上限を緩めたときにこのテストが一緒に緩んで意味を失う。
			const over = accepted.filter((c) => {
				const d = c.details as {
					outlierPeaksRemoved: number;
					peaksTotal: number;
					outlierValleysRemoved: number;
					valleysTotal: number;
				};
				return d.outlierPeaksRemoved / d.peaksTotal > 0.5 || d.outlierValleysRemoved / d.valleysTotal > 0.5;
			});
			expect(over, '除去率が上限を超える候補が採用されている').toEqual([]);
		});

		it('18 点を捨てていた候補は消え、採用側の最大除去数は 12 になる', async () => {
			const res = await runTriangles();
			const removals = (res.meta.debug?.candidates ?? [])
				.filter((c) => c.accepted && String(c.type).startsWith('triangle'))
				.map((c) => {
					const d = c.details as { outlierPeaksRemoved: number; outlierValleysRemoved: number };
					return d.outlierPeaksRemoved + d.outlierValleysRemoved;
				});
			// main の最大は 18（窓の 88% を占めていた候補）。
			// **12 は 0 にはならない**——idx [24,82] の ascending が上 6/12・下 6/14 と
			// 上下ともちょうど 50% で、上限（境界は通す側）を通る。除去数の絶対値ではなく
			// 割合で切っている以上ここは残る。窓幅そのものを問う話は #141 の範囲外。
			expect(Math.max(...removals)).toBe(12);
		});
	});

	/**
	 * #141 が「pivots に同一 idx の重複がある」として併記した件。
	 *
	 * **これは重複ではない。** 配列のキーは `idx` ではなく `(idx, kind)` で、
	 * relaxed swing（`swingDepth=1`）では**外側バー**が高値としても安値としても極値になる。
	 * dedup すると片方の極値が消えるので、そうしないことをここで固定する。
	 */
	describe('外側バーは高値・安値の両方の極値になる（重複ではない）', () => {
		it('idx=38 は前後 2 本を包む外側バー', () => {
			const [, high, low] = BTC_JPY_1DAY_2026_OHLC[38];
			const [, prevHigh, prevLow] = BTC_JPY_1DAY_2026_OHLC[37];
			const [, nextHigh, nextLow] = BTC_JPY_1DAY_2026_OHLC[39];
			expect(high).toBeGreaterThan(prevHigh);
			expect(high).toBeGreaterThan(nextHigh);
			expect(low).toBeLessThan(prevLow);
			expect(low).toBeLessThan(nextLow);
			expect(high).toBe(10_470_583);
			expect(low).toBe(9_952_759);
		});

		it('pivots には idx=38 が H / L の 2 件入り、価格は別の値', async () => {
			const res = await runTriangles();
			const at38PerPattern = res.data.patterns
				.map((p) => (p.pivots ?? []).filter((v) => v.idx === 38))
				.filter((vs) => vs.length > 0);
			expect(at38PerPattern.length, 'idx=38 を含む三角形が無い').toBeGreaterThan(0);
			// 条件分岐の中で expect を呼ばない（vitest/no-conditional-expect）。
			// 各パターンの idx=38 を「kind → price」に畳んでから 1 度だけ突き合わせる。
			const shapes = at38PerPattern.map((vs) =>
				vs
					.map((v) => `${v.kind}:${v.price}`)
					.sort()
					.join(' / '),
			);
			expect(new Set(shapes)).toEqual(new Set(['H:10470583 / L:9952759']));
		});
	});
});
