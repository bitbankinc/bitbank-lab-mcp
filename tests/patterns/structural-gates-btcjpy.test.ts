// 合成 fixture では閾値の妥当性を検証できないので、戻り率の帯とネックライン交差の判定は実データ（`btc_jpy_1day_2026`）に対して固定する（#126）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBtcJpy2026Candles } from '../fixtures/btc_jpy_1day_2026.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { getDefaultParamsForTf } from '../../tools/patterns/config.js';
import {
	detectTroughZoneReentry,
	findPriorExtreme,
	RETRACEMENT_MAX,
	RETRACEMENT_MIN,
	validateReversalStructure,
} from '../../tools/patterns/structural.js';
import { detectSwingPoints } from '../../tools/patterns/swing.js';

const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);

/** fixture の idx（`detect_patterns` がスキャンする配列の位置と一致する） */
const IDX = {
	priorHigh: 42, // 2026-07-10 — 谷1(45) の直前スイング高値
	falseTrough1: 45, // 2026-07-13
	falseNeckline: 53, // 2026-07-21
	sharedTrough: 66, // 2026-08-03（偽陽性の谷2 / 正しい形の谷1）
	trueNeckline: 73, // 2026-08-10
	trueTrough2: 77, // 2026-08-14
	notAPivot: 79, // 2026-08-16
} as const;

const candles = buildBtcJpy2026Candles();
const pivots = detectSwingPoints(candles, { swingDepth: 3, strictPivots: true });
const pivotAt = (idx: number) => {
	const p = pivots.find((v) => v.idx === idx);
	if (!p) throw new Error(`no pivot at idx=${idx}`);
	return p;
};

function indicatorsOk() {
	return {
		ok: true as const,
		summary: 'ok',
		data: { chart: { candles, meta: { pastBuffer: 0 }, indicators: {} } },
		meta: {},
	};
}

describe('issue #126 構造ゲート — BTC/JPY 日足 実データ回帰', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe('ピボット抽出（swing.ts は本 PR で触っていない）', () => {
		it('8/3(66) と 8/14(77) は安値ピボットで、8/16(79) はピボットではない', () => {
			const valleys = pivots.filter((p) => p.kind === 'L').map((p) => p.idx);
			expect(valleys).toContain(IDX.sharedTrough);
			expect(valleys).toContain(IDX.trueTrough2);
			expect(valleys).not.toContain(IDX.notAPivot);
		});

		it('8/14 の安値は 8/16 より低い（外部レビューの D3 が誤診である実データ上の根拠）', () => {
			expect(candles[IDX.trueTrough2].low).toBeLessThan(candles[IDX.notAPivot].low);
			expect(candles[IDX.trueTrough2].low).toBe(9_955_830);
			expect(candles[IDX.notAPivot].low).toBe(9_998_855);
		});
	});

	describe('偽陽性 7/13 → 7/21 → 8/3', () => {
		it('ネックライン(7/21)が先行下落の起点(7/10)より上で、戻り率が 1.0 を超える', () => {
			const first = pivotAt(IDX.falseTrough1);
			const mid = pivotAt(IDX.falseNeckline);
			const prior = findPriorExtreme(pivots, first.idx, 'H');
			expect(prior?.idx).toBe(IDX.priorHigh);
			// 高安基準: 起点 10,467,388 < ネックライン 10,903,000
			expect(prior?.extremePrice).toBeLessThan(mid.extremePrice);

			const gate = validateReversalStructure({
				candles,
				pivots,
				first,
				mid,
				necklinePrice: mid.price,
				side: 'bottom',
			});
			expect(gate.ok).toBe(false);
			expect(gate.reason).toBe('neckline_above_pre_decline_high');
			expect(gate.retracementRatio).toBeGreaterThan(1);
			expect(gate.retracementRatio).toBeCloseTo(2.0463, 3);
		});

		it('谷2(8/3) の後、ネックライン到達前に谷ゾーンへ再進入している（8/16）', () => {
			const reentry = detectTroughZoneReentry({
				candles,
				first: pivotAt(IDX.falseTrough1),
				mid: pivotAt(IDX.falseNeckline),
				second: pivotAt(IDX.sharedTrough),
				untilIdx: candles.length - 1,
				side: 'bottom',
			});
			expect(reentry.reentered).toBe(true);
			expect(reentry.idx).toBe(IDX.notAPivot);
		});

		it('検出結果に含まれず、棄却理由が debug candidates に記録される', async () => {
			mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
			const res = await detectPatterns('btc_jpy', '1day', 90, {
				patterns: ['double_bottom', 'double_top'],
				includeForming: true,
				includeCompleted: true,
				view: 'debug',
				swingDepth: 3,
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;

			const offending = res.data.patterns.filter((p) => {
				const idxs = (p.pivots ?? []).map((v) => v.idx);
				return idxs.includes(IDX.falseTrough1) && idxs.includes(IDX.falseNeckline);
			});
			expect(offending).toHaveLength(0);

			const cands =
				(res.meta?.debug as { candidates?: Array<{ accepted?: boolean; reason?: string; indices?: number[] }> })
					?.candidates ?? [];
			const offendingCands = cands.filter(
				(c) => (c.indices ?? []).includes(IDX.falseTrough1) && (c.indices ?? []).includes(IDX.falseNeckline),
			);
			expect(offendingCands).toHaveLength(0);

			// 構造ゲートを通っても、先行下降を観測できない二谷は反転として確定しない。
			const trendRejected = cands.find((c) => c.reason === 'prior_trend_mismatch:sideways');
			expect(trendRejected?.indices).toEqual([IDX.sharedTrough, IDX.trueNeckline, IDX.trueTrough2]);
		});

		it('8/26 時点で forming にならない', async () => {
			mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
			const res = await detectPatterns('btc_jpy', '1day', 90, {
				patterns: ['double_bottom'],
				includeForming: true,
				includeCompleted: true,
				includeInvalid: true,
				view: 'debug',
				swingDepth: 3,
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			const forming = res.data.patterns.filter((p) => {
				const idxs = (p.pivots ?? []).map((v) => v.idx);
				return p.status === 'forming' && idxs.includes(IDX.falseNeckline);
			});
			expect(forming).toHaveLength(0);
		});
	});

	describe('includeForming / includeCompleted / includeInvalid の独立性', () => {
		// `includeCompleted: false` + `includeInvalid: true` で invalid / expired が返ることを固定する（completed バケットから invalid を引き算する形だと、どちらも返らない到達不能な組み合わせになる）。
		it('includeCompleted=false + includeInvalid=true で invalid / expired が返る', async () => {
			mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
			const res = await detectPatterns('btc_jpy', '1day', 90, {
				includeForming: false,
				includeCompleted: false,
				includeInvalid: true,
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			for (const p of res.data.patterns) {
				expect(['invalid', 'expired']).toContain(p.status);
			}
		});

		it('includeCompleted=true + includeInvalid=false に invalid / expired は混ざらない', async () => {
			mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
			const res = await detectPatterns('btc_jpy', '1day', 90, {
				includeForming: false,
				includeCompleted: true,
				includeInvalid: false,
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			for (const p of res.data.patterns) {
				expect(p.status === 'invalid' || p.status === 'expired').toBe(false);
			}
		});

		it('includeForming=true 単独では終端 status が混ざらない', async () => {
			mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
			const res = await detectPatterns('btc_jpy', '1day', 90, {
				includeForming: true,
				includeCompleted: false,
				includeInvalid: false,
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			for (const p of res.data.patterns) {
				expect(['forming', 'near_completion']).toContain(p.status);
			}
		});
	});

	describe('正しい形 8/3 → 8/10 → 8/14（安値切り上げ型）', () => {
		it('構造ゲートを通過し、戻り率が帯の内側に収まる', () => {
			const first = pivotAt(IDX.sharedTrough);
			const mid = pivotAt(IDX.trueNeckline);
			const gate = validateReversalStructure({
				candles,
				pivots,
				first,
				mid,
				necklinePrice: mid.price,
				side: 'bottom',
			});
			expect(gate.ok).toBe(true);
			expect(gate.retracementRatio).toBeCloseTo(0.528, 3);
			expect(gate.retracementRatio).toBeGreaterThan(RETRACEMENT_MIN);
			expect(gate.retracementRatio).toBeLessThan(RETRACEMENT_MAX);
			// 谷1 より前にネックライン水準を終値で下抜けた事象が実在する
			expect(gate.necklineCrossIdx).toBeDefined();
			expect(gate.necklineCrossIdx).toBeLessThan(first.idx);
		});

		it('安値切り上げ型である（谷2 の安値 > 谷1 の安値）', () => {
			expect(pivotAt(IDX.trueTrough2).extremePrice).toBeGreaterThan(pivotAt(IDX.sharedTrough).extremePrice);
		});

		it('谷2 の後、ネックライン到達前に谷ゾーンへ再進入していない', () => {
			const reentry = detectTroughZoneReentry({
				candles,
				first: pivotAt(IDX.sharedTrough),
				mid: pivotAt(IDX.trueNeckline),
				second: pivotAt(IDX.trueTrough2),
				untilIdx: candles.length - 1,
				side: 'bottom',
			});
			expect(reentry.reentered).toBe(false);
		});

		it('3 つの前提（間隔 4 本 / 高安基準 / 最終ピボット）が揃って検出される', () => {
			const [first, mid, second] = [pivotAt(IDX.sharedTrough), pivotAt(IDX.trueNeckline), pivotAt(IDX.trueTrough2)];

			// 1. 山 → 谷2 は 4 本。日足の既定 minBarsBetweenSwings（4）とちょうど同値。
			expect(second.idx - mid.idx).toBe(4);
			expect(mid.idx - first.idx).toBe(7);
			expect(getDefaultParamsForTf('1day').minBarsBetweenSwings).toBe(4);

			// 2. サイズ検査（validateDoubleSize）の価格基準。終値基準だと閾値割れ、高安基準なら通る。
			const heightPctClose = Math.abs(first.price - mid.price) / Math.max(first.price, mid.price);
			const peakHeightPctClose = (mid.price - (first.price + second.price) / 2) / ((first.price + second.price) / 2);
			expect(heightPctClose).toBeLessThan(0.03); // MIN_PATTERN_HEIGHT_PCT
			expect(peakHeightPctClose).toBeLessThan(0.05); // MIN_DEPTH_PCT

			const avgExt = (first.extremePrice + second.extremePrice) / 2;
			const heightPctExt =
				Math.abs(first.extremePrice - mid.extremePrice) / Math.max(first.extremePrice, mid.extremePrice);
			const peakHeightPctExt = (mid.extremePrice - avgExt) / avgExt;
			expect(heightPctExt).toBeGreaterThan(0.03);
			expect(peakHeightPctExt).toBeGreaterThan(0.05);

			// 3. 谷2 は窓の最後のピボット（3 ピボットの走査は `i + 2 < pivots.length` まで回す）。
			expect(pivots[pivots.length - 1].idx).toBe(IDX.trueTrough2);
		});

		// 突破足の終値 10,949,999 はネックライン（8/10 の終値 10,191,324）を 7.4% 上回り、8/17（10,278,279）と 8/18（10,330,037）はバッファ込みの閾値 10,344,194 に届かないので、突破の初出は 8/19 で一意に決まる。
		it('横ばい先行なので完成済み double_bottom としては検出しない', async () => {
			mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
			const res = await detectPatterns('btc_jpy', '1day', 90, {
				patterns: ['double_bottom'],
				includeCompleted: true,
				view: 'debug',
				swingDepth: 3,
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;

			const found = res.data.patterns.filter((p) => {
				const idxs = (p.pivots ?? []).map((v) => v.idx);
				return idxs.includes(IDX.sharedTrough) && idxs.includes(IDX.trueTrough2);
			});
			expect(found).toHaveLength(0);
			const candidates =
				(res.meta?.debug as { candidates?: Array<{ reason?: string; indices?: number[] }> })?.candidates ?? [];
			expect(
				candidates.some((c) => c.reason === 'prior_trend_mismatch:sideways' && c.indices?.join('-') === '66-73-77'),
			).toBe(true);
			expect(candles[82].isoTime.slice(0, 10)).toBe('2026-08-19');
			const necklineThreshold = pivotAt(IDX.trueNeckline).price * 1.015;
			expect(candles[80].close).toBeLessThan(necklineThreshold);
			expect(candles[81].close).toBeLessThan(necklineThreshold);
			expect(candles[82].close).toBeGreaterThan(necklineThreshold);
		});

		it('includeForming: true でも横ばい先行の形は完成済みとして出ない', async () => {
			mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
			const res = await detectPatterns('btc_jpy', '1day', 90, {
				patterns: ['double_bottom'],
				includeForming: true,
				includeCompleted: true,
				view: 'debug',
				swingDepth: 3,
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			const found = res.data.patterns.filter((p) => {
				const idxs = (p.pivots ?? []).map((v) => v.idx);
				return idxs.includes(IDX.sharedTrough) && idxs.includes(IDX.trueTrough2);
			});
			expect(found).toHaveLength(0);
		});

		it('高安基準は帯の中央付近、終値基準は下限すれすれ（基準選択の根拠）', () => {
			const first = pivotAt(IDX.sharedTrough);
			const mid = pivotAt(IDX.trueNeckline);
			const prior = findPriorExtreme(pivots, first.idx, 'H');
			expect(prior).toBeDefined();
			if (!prior) return;

			const extremeRatio = (mid.extremePrice - first.extremePrice) / (prior.extremePrice - first.extremePrice);
			const closeRatio = (mid.price - first.price) / (prior.price - first.price);

			expect(extremeRatio).toBeCloseTo(0.528, 3);
			expect(closeRatio).toBeCloseTo(0.222, 3);
			// 終値基準の下限までの余裕は 2.2 ポイント / 高安基準は 32.8 ポイント
			expect(closeRatio - RETRACEMENT_MIN).toBeLessThan(0.03);
			expect(extremeRatio - RETRACEMENT_MIN).toBeGreaterThan(0.3);
		});
	});
});
