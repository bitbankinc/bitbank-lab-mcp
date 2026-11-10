import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import {
	getDefaultToleranceForTf,
	getHsShoulderMaxPctForTf,
	getSizeThresholdsForTf,
} from '../../tools/patterns/config.js';
import { detectHeadAndShoulders, necklineAt, necklineProjectionTarget } from '../../tools/patterns/detect_hs.js';
import type { Pivot } from '../../tools/patterns/swing.js';
import type { CandleData, DetectContext } from '../../tools/patterns/types.js';

function iso(daysAgo: number): string {
	return dayjs().subtract(daysAgo, 'day').startOf('day').toISOString();
}

function mkCandle(daysAgo: number, o: number, h: number, l: number, c: number): CandleData {
	return { open: o, high: h, low: l, close: c, isoTime: iso(daysAgo) };
}

function buildCtx(opts: {
	candles: CandleData[];
	pivots: Pivot[];
	allPeaks?: Pivot[];
	allValleys?: Pivot[];
	tolerancePct?: number;
	/** 既定は tolerancePct に連動させず独立に 0.04（config.ts の時間軸オート表で '1day' に相当）とする。tolerancePct へフォールバックすると本番と違う結合を再現してしまう（issue #149）。 */
	headProminencePct?: number;
	want?: Set<string>;
	includeForming?: boolean;
	type?: string;
}): DetectContext {
	const tol = opts.tolerancePct ?? 0.04;
	const headProm = opts.headProminencePct ?? 0.04;
	return {
		candles: opts.candles,
		pivots: opts.pivots,
		allPeaks: opts.allPeaks ?? opts.pivots.filter((p) => p.kind === 'H'),
		allValleys: opts.allValleys ?? opts.pivots.filter((p) => p.kind === 'L'),
		tolerancePct: tol,
		headProminencePct: headProm,
		sizeThresholds: getSizeThresholdsForTf(opts.type ?? '1day'),
		hsShoulderMaxPct: getHsShoulderMaxPctForTf(opts.type ?? '1day'),
		minDist: 5,
		want: opts.want ?? new Set(),
		includeForming: opts.includeForming ?? false,
		debugCandidates: [],
		type: opts.type ?? '1day',
		swingDepth: 7,
	};
}

/** H&S ピボット: H(idx=0) → L(idx=15) → H(idx=30) → L(idx=45) → H(idx=60) */
function buildHS(opts?: {
	leftShoulder?: number;
	head?: number;
	rightShoulder?: number;
	valley1?: number;
	valley2?: number;
}) {
	const ls = opts?.leftShoulder ?? 100;
	const hd = opts?.head ?? 130;
	const rs = opts?.rightShoulder ?? 100;
	const v1 = opts?.valley1 ?? 85;
	const v2 = opts?.valley2 ?? 85;

	const candles: CandleData[] = [];
	for (let i = 0; i < 70; i++) candles.push(mkCandle(70 - i, 90, 95, 80, 90));
	candles[0] = mkCandle(70, ls - 1, ls, ls - 3, ls - 1);
	candles[15] = mkCandle(55, v1 + 1, v1 + 3, v1, v1 + 1);
	candles[30] = mkCandle(40, hd - 1, hd, hd - 3, hd - 1);
	candles[45] = mkCandle(25, v2 + 1, v2 + 3, v2, v2 + 1);
	candles[60] = mkCandle(10, rs - 1, rs, rs - 3, rs - 1);

	const pivots: Pivot[] = [
		{ idx: 0, price: ls, kind: 'H', extremePrice: ls },
		{ idx: 15, price: v1, kind: 'L', extremePrice: v1 },
		{ idx: 30, price: hd, kind: 'H', extremePrice: hd },
		{ idx: 45, price: v2, kind: 'L', extremePrice: v2 },
		{ idx: 60, price: rs, kind: 'H', extremePrice: rs },
	];

	return { candles, pivots };
}

/** Inverse H&S ピボット: L(idx=0) → H(idx=15) → L(idx=30) → H(idx=45) → L(idx=60) */
function buildInverseHS(opts?: {
	leftShoulder?: number;
	head?: number;
	rightShoulder?: number;
	peak1?: number;
	peak2?: number;
}) {
	const ls = opts?.leftShoulder ?? 100;
	const hd = opts?.head ?? 70;
	const rs = opts?.rightShoulder ?? 100;
	const p1 = opts?.peak1 ?? 115;
	const p2 = opts?.peak2 ?? 115;

	const candles: CandleData[] = [];
	for (let i = 0; i < 70; i++) candles.push(mkCandle(70 - i, 90, 95, 80, 90));
	candles[0] = mkCandle(70, ls + 1, ls + 3, ls, ls + 1);
	candles[15] = mkCandle(55, p1 - 1, p1, p1 - 3, p1 - 1);
	candles[30] = mkCandle(40, hd + 1, hd + 3, hd, hd + 1);
	candles[45] = mkCandle(25, p2 - 1, p2, p2 - 3, p2 - 1);
	candles[60] = mkCandle(10, rs + 1, rs + 3, rs, rs + 1);

	const pivots: Pivot[] = [
		{ idx: 0, price: ls, kind: 'L', extremePrice: ls },
		{ idx: 15, price: p1, kind: 'H', extremePrice: p1 },
		{ idx: 30, price: hd, kind: 'L', extremePrice: hd },
		{ idx: 45, price: p2, kind: 'H', extremePrice: p2 },
		{ idx: 60, price: rs, kind: 'L', extremePrice: rs },
	];

	return { candles, pivots };
}

function withPrecedingTrend(
	pattern: ReturnType<typeof buildHS> | ReturnType<typeof buildInverseHS>,
	direction: 'up' | 'down' | 'sideways',
) {
	const precedingBars = 30;
	const firstClose = pattern.candles[0].close;
	const leading = Array.from({ length: precedingBars }, (_, i) => {
		const progress = i / (precedingBars - 1);
		const start = direction === 'up' ? firstClose * 0.8 : direction === 'down' ? firstClose * 1.2 : firstClose;
		const close = start + (firstClose - start) * progress;
		return mkCandle(100 - i, close, close + 3, close - 3, close);
	});

	return {
		candles: [...leading, ...pattern.candles],
		pivots: pattern.pivots.map((pivot) => ({ ...pivot, idx: pivot.idx + precedingBars })),
	};
}

function buildHsWithBreakout(opts?: {
	breakIdx?: number;
	breakClose?: number;
	postBreakLow?: number;
	postBreakIdx?: number;
	totalBars?: number;
}) {
	const ls = 100;
	const hd = 130;
	const rs = 100;
	const v1 = 85;
	const v2 = 85;
	const total = opts?.totalBars ?? 80;
	const breakIdx = opts?.breakIdx ?? 65;
	// neckline (v1+v2)/2 = 85; close 80 は 85*(1-0.015)=83.725 を下回る → ブレイク
	const breakClose = opts?.breakClose ?? 80;

	const candles: CandleData[] = [];
	for (let i = 0; i < total; i++) candles.push(mkCandle(total - i, 90, 95, 80, 90));
	candles[0] = mkCandle(total, ls - 1, ls, ls - 3, ls - 1);
	candles[15] = mkCandle(total - 15, v1 + 1, v1 + 3, v1, v1 + 1);
	candles[30] = mkCandle(total - 30, hd - 1, hd, hd - 3, hd - 1);
	candles[45] = mkCandle(total - 45, v2 + 1, v2 + 3, v2, v2 + 1);
	candles[60] = mkCandle(total - 60, rs - 1, rs, rs - 3, rs - 1);
	for (let i = breakIdx; i < total; i++) {
		candles[i] = mkCandle(total - i, breakClose + 2, breakClose + 5, breakClose - 3, breakClose);
	}
	if (opts?.postBreakLow !== undefined && opts?.postBreakIdx !== undefined) {
		const idx = opts.postBreakIdx;
		const lo = opts.postBreakLow;
		candles[idx] = mkCandle(total - idx, lo + 3, lo + 5, lo, lo + 1);
	}

	const pivots: Pivot[] = [
		{ idx: 0, price: ls, kind: 'H', extremePrice: ls },
		{ idx: 15, price: v1, kind: 'L', extremePrice: v1 },
		{ idx: 30, price: hd, kind: 'H', extremePrice: hd },
		{ idx: 45, price: v2, kind: 'L', extremePrice: v2 },
		{ idx: 60, price: rs, kind: 'H', extremePrice: rs },
	];

	return { candles, pivots };
}

function buildInverseHsWithBreakout(opts?: {
	breakIdx?: number;
	breakClose?: number;
	postBreakHigh?: number;
	postBreakIdx?: number;
	totalBars?: number;
}) {
	const ls = 100;
	const hd = 70;
	const rs = 100;
	const p1 = 115;
	const p2 = 115;
	const total = opts?.totalBars ?? 80;
	const breakIdx = opts?.breakIdx ?? 65;
	// neckline (p1+p2)/2 = 115; close 120 は 115*(1+0.015)=116.725 を上回る → ブレイク
	const breakClose = opts?.breakClose ?? 120;

	const candles: CandleData[] = [];
	for (let i = 0; i < total; i++) candles.push(mkCandle(total - i, 90, 95, 80, 90));
	candles[0] = mkCandle(total, ls + 1, ls + 3, ls, ls + 1);
	candles[15] = mkCandle(total - 15, p1 - 1, p1, p1 - 3, p1 - 1);
	candles[30] = mkCandle(total - 30, hd + 1, hd + 3, hd, hd + 1);
	candles[45] = mkCandle(total - 45, p2 - 1, p2, p2 - 3, p2 - 1);
	candles[60] = mkCandle(total - 60, rs + 1, rs + 3, rs, rs + 1);
	// 全バー close=90 のままだと右肩 100 より下を這って #242 の「肩ゾーン再進入」で `invalid` になるので、右肩（idx 60）からブレイクまでの経路を肩の水準より上に通す。
	// 上限はブレイク閾値 115 × 1.015 = 116.725 未満（ここで先に抜けてしまわないため）。
	for (let i = 61; i < breakIdx; i++) {
		const c = 106 + (i - 61) * 3;
		candles[i] = mkCandle(total - i, c - 1, c + 2, c - 3, c);
	}
	for (let i = breakIdx; i < total; i++) {
		candles[i] = mkCandle(total - i, breakClose - 2, breakClose + 3, breakClose - 5, breakClose);
	}
	if (opts?.postBreakHigh !== undefined && opts?.postBreakIdx !== undefined) {
		const idx = opts.postBreakIdx;
		const hi = opts.postBreakHigh;
		candles[idx] = mkCandle(total - idx, hi - 5, hi, hi - 6, hi - 1);
	}

	const pivots: Pivot[] = [
		{ idx: 0, price: ls, kind: 'L', extremePrice: ls },
		{ idx: 15, price: p1, kind: 'H', extremePrice: p1 },
		{ idx: 30, price: hd, kind: 'L', extremePrice: hd },
		{ idx: 45, price: p2, kind: 'H', extremePrice: p2 },
		{ idx: 60, price: rs, kind: 'L', extremePrice: rs },
	];

	return { candles, pivots };
}

afterEach(() => {
	vi.resetAllMocks();
});

describe('detectHeadAndShoulders', () => {
	describe('反転に必要な先行トレンド', () => {
		it('横ばいのH&Sは反転として検出しない', () => {
			const { candles, pivots } = withPrecedingTrend(buildHS(), 'sideways');
			const ctx = buildCtx({ candles, pivots });
			const result = detectHeadAndShoulders(ctx);

			expect(result.patterns.filter((pattern) => pattern.type === 'head_and_shoulders')).toHaveLength(0);
			expect(
				ctx.debugCandidates.some(
					(candidate) =>
						candidate.type === 'head_and_shoulders' && candidate.reason === 'prior_trend_mismatch:sideways',
				),
			).toBe(true);
		});

		it('上昇後のH&Sは反転候補として検出できる', () => {
			const { candles, pivots } = withPrecedingTrend(buildHS(), 'up');
			const result = detectHeadAndShoulders(buildCtx({ candles, pivots }));
			const hs = result.patterns.find((pattern) => pattern.type === 'head_and_shoulders');

			expect(hs?.precedingTrend?.direction).toBe('up');
		});

		it('横ばいの逆H&Sは反転として検出しない', () => {
			const { candles, pivots } = withPrecedingTrend(buildInverseHS(), 'sideways');
			const ctx = buildCtx({ candles, pivots });
			const result = detectHeadAndShoulders(ctx);

			expect(result.patterns.filter((pattern) => pattern.type === 'inverse_head_and_shoulders')).toHaveLength(0);
			expect(
				ctx.debugCandidates.some(
					(candidate) =>
						candidate.type === 'inverse_head_and_shoulders' && candidate.reason === 'prior_trend_mismatch:sideways',
				),
			).toBe(true);
		});

		it('下降後の逆H&Sは反転候補として検出できる', () => {
			const { candles, pivots } = withPrecedingTrend(buildInverseHS(), 'down');
			const result = detectHeadAndShoulders(buildCtx({ candles, pivots }));
			const inverseHs = result.patterns.find((pattern) => pattern.type === 'inverse_head_and_shoulders');

			expect(inverseHs?.precedingTrend?.direction).toBe('down');
		});
	});

	it('H-L-H-L-H ピボット → head_and_shoulders 検出', () => {
		const { candles, pivots } = buildHS();
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.filter((p) => p.type === 'head_and_shoulders');
		expect(hs.length).toBeGreaterThanOrEqual(1);
		expect(hs[0]?.confidence).toBeGreaterThan(0);
		expect(hs[0]?.neckline).toBeDefined();
		expect(hs[0]?.breakoutTarget).toBeDefined();
		expect(hs[0]?.targetMethod).toBe('neckline_projection');
		expect(result.found?.head_and_shoulders).toBe(true);
	});

	it('H&S のターゲット価格 = neckline - (head - neckline)', () => {
		// nlAvg=(85+85)/2=85, head=130, target=85-(130-85)=40
		const { candles, pivots } = buildHS({ head: 130, valley1: 85, valley2: 85 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs?.breakoutTarget).toBe(40);
	});

	it('頭が両肩より高くない → head_not_higher で rejected', () => {
		// head=103, shoulders=100 → 103 > 100*(1+headProminencePct=0.04)=104? No（tolerancePct は無関係。issue #149）
		const { candles, pivots } = buildHS({ head: 103 });
		const ctx = buildCtx({ candles, pivots });
		detectHeadAndShoulders(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'head_and_shoulders' && d.accepted === false && d.reason === 'head_not_higher',
		);
		expect(rejected).toBeDefined();
	});

	it('両肩が離れすぎ → shoulders_not_near:both で rejected', () => {
		// left=100, right=120 → |20|/120=0.167 > tolerancePct(0.04) かつ > HS_SHOULDER_MAX_PCT(0.05) → どちらを緩めても通らないので :both（issue #172）
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 120 });
		const ctx = buildCtx({ candles, pivots });
		detectHeadAndShoulders(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'head_and_shoulders' && d.accepted === false && d.reason === 'shoulders_not_near:both',
		);
		expect(rejected).toBeDefined();
	});

	it('ピボット間隔 < minDist → H&S スキップ', () => {
		// 間隔3本 < minDist(5)
		const candles: CandleData[] = Array.from({ length: 20 }, (_, i) => mkCandle(20 - i, 90, 95, 85, 90));
		candles[0] = mkCandle(20, 99, 100, 97, 99);
		candles[3] = mkCandle(17, 84, 86, 83, 84);
		candles[6] = mkCandle(14, 129, 130, 127, 129);
		candles[9] = mkCandle(11, 84, 86, 83, 84);
		candles[12] = mkCandle(8, 99, 100, 97, 99);

		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 3, price: 85, kind: 'L', extremePrice: 85 },
			{ idx: 6, price: 130, kind: 'H', extremePrice: 130 },
			{ idx: 9, price: 85, kind: 'L', extremePrice: 85 },
			{ idx: 12, price: 100, kind: 'H', extremePrice: 100 },
		];
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.filter((p) => p.type === 'head_and_shoulders');
		expect(hs).toHaveLength(0);
	});

	it('L-H-L-H-L ピボット → inverse_head_and_shoulders 検出', () => {
		const { candles, pivots } = buildInverseHS();
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs.length).toBeGreaterThanOrEqual(1);
		expect(ihs[0]?.confidence).toBeGreaterThan(0);
		expect(ihs[0]?.neckline).toBeDefined();
		expect(ihs[0]?.breakoutTarget).toBeDefined();
		expect(ihs[0]?.targetMethod).toBe('neckline_projection');
		expect(result.found?.inverse_head_and_shoulders).toBe(true);
	});

	it('Inverse H&S ターゲット価格 = neckline + (neckline - head)', () => {
		// ihsNlAvg=(115+115)/2=115, head=70, target=115+(115-70)=160
		const { candles, pivots } = buildInverseHS({ head: 70, peak1: 115, peak2: 115 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.find((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs?.breakoutTarget).toBe(160);
	});

	it('Inverse H&S の肩が浅すぎる場合は shoulder_depth_insufficient で rejected', () => {
		// 左右肩はネックラインから 1、頭は 45 下なので、肩の深さ比は約 2.2%。形状の戻りとしては浅すぎるため、肩の同水準ゲートを通っても除外する。
		const { candles, pivots } = buildInverseHS({ leftShoulder: 114, rightShoulder: 114, head: 70 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		expect(result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders')).toHaveLength(0);
		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'inverse_head_and_shoulders' && d.reason === 'shoulder_depth_insufficient',
		);
		const details = rejected?.details as Record<string, unknown> | undefined;
		expect(details).toMatchObject({ minShoulderDepthRatio: 0.2 });
		expect(Number(details?.leftShoulderDepthRatio)).toBeCloseTo(1 / 45, 3);
	});

	it('relaxed Inverse H&S でも浅い肩を救済しない', () => {
		// 肩の差は strict の tolerance(4%)を超えるが、relaxed と cap(5%)には収まる。それでも左肩の深さ 1 / 45 は同じ hard gate で落ちる。
		const { candles, pivots } = buildInverseHS({ leftShoulder: 114, rightShoulder: 109, head: 70 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		expect(result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders')).toHaveLength(0);
		expect(
			ctx.debugCandidates.some(
				(d) => d.type === 'inverse_head_and_shoulders' && d.reason === 'shoulder_depth_insufficient',
			),
		).toBe(true);
	});

	it('H&S の肩が浅すぎる場合も shoulder_depth_insufficient で rejected', () => {
		// 逆 H&S の判定を上下反転したもの。左右肩は谷から 1、頭は 45 上なので、肩の深さ比は約 2.2%。
		const { candles, pivots } = buildHS({ leftShoulder: 86, rightShoulder: 86, head: 130 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		expect(result.patterns.filter((p) => p.type === 'head_and_shoulders')).toHaveLength(0);
		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'head_and_shoulders' && d.reason === 'shoulder_depth_insufficient',
		);
		const details = rejected?.details as Record<string, unknown> | undefined;
		expect(details).toMatchObject({ minShoulderDepthRatio: 0.2, headDepth: 45 });
		expect(Number(details?.leftShoulderDepthRatio)).toBeCloseTo(1 / 45, 3);
	});

	it('relaxed H&S でも浅い肩を救済しない', () => {
		// 肩の差は strict の tolerance(4%)を超えるが、relaxed と cap(5%)には収まる。左肩 1 / 45・右肩 5 / 45 はどちらも 20% に届かない。
		const { candles, pivots } = buildHS({ leftShoulder: 86, rightShoulder: 90, head: 130 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		expect(result.patterns.filter((p) => p.type === 'head_and_shoulders')).toHaveLength(0);
		expect(
			ctx.debugCandidates.some((d) => d.type === 'head_and_shoulders' && d.reason === 'shoulder_depth_insufficient'),
		).toBe(true);
	});

	it.each([
		[95, true],
		[93, false],
	] as const)('H&S の肩の深さの下限付近: 両肩 %d（谷 85・頭 130）で検出されるのは %s', (shoulder, detected) => {
		const { candles, pivots } = buildHS({ leftShoulder: shoulder, rightShoulder: shoulder, head: 130 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		expect(result.patterns.some((p) => p.type === 'head_and_shoulders')).toBe(detected);
		expect(
			ctx.debugCandidates.some((d) => d.type === 'head_and_shoulders' && d.reason === 'shoulder_depth_insufficient'),
		).toBe(!detected);
	});

	it('頭が両肩より低くない → head_not_lower で rejected', () => {
		// head=97, shoulders=100 → 97 < 100*(1-headProminencePct=0.04)=96? No (97 > 96)（tolerancePct は無関係。issue #149）
		const { candles, pivots } = buildInverseHS({ head: 97 });
		const ctx = buildCtx({ candles, pivots });
		detectHeadAndShoulders(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'inverse_head_and_shoulders' && d.accepted === false && d.reason === 'head_not_lower',
		);
		expect(rejected).toBeDefined();
	});

	it('want に head_and_shoulders のみ → inverse はスキップ', () => {
		const { candles, pivots } = buildInverseHS();
		const ctx = buildCtx({ candles, pivots, want: new Set(['head_and_shoulders']) });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toHaveLength(0);
	});

	it('want に inverse_head_and_shoulders のみ → H&S はスキップ', () => {
		const { candles, pivots } = buildHS();
		const ctx = buildCtx({ candles, pivots, want: new Set(['inverse_head_and_shoulders']) });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.filter((p) => p.type === 'head_and_shoulders');
		expect(hs).toHaveLength(0);
	});

	it('strict 不検出 → relaxed H&S (x1.6) でフォールバック検出', () => {
		// left=100, right=105 → diff/max=5/105=0.0476 > strict(0.04)、<= relaxed(0.04*1.6=0.064)、<= HS_SHOULDER_MAX_PCT(0.05)
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 105, head: 130 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.filter((p) => p.type === 'head_and_shoulders');
		expect(hs.length).toBeGreaterThan(0);
		expect(hs[0]?._fallback).toMatch(/relaxed_hs/);
		// ここは前置一致。本テストの主題は relaxed フォールバックであって、肩がどちらの conjunct で落ちたか（#172 の接尾辞）ではない。
		const strictRejected = ctx.debugCandidates.some(
			(d) => d.type === 'head_and_shoulders' && (d.reason ?? '').startsWith('shoulders_not_near'),
		);
		expect(strictRejected).toBe(true);
	});

	it('strict 不検出 → relaxed Inverse H&S でフォールバック検出', () => {
		// shoulders=100,105: diff/max=5/105=0.0476 > strict(0.04)、かつ relaxed(0.064) / HS_SHOULDER_MAX_PCT(0.05) の双方に収まる。
		const { candles, pivots } = buildInverseHS({ leftShoulder: 100, rightShoulder: 105, head: 70 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs.length).toBeGreaterThan(0);
		expect(ihs[0]?._fallback).toMatch(/relaxed_ihs/);
		const strictRejected = ctx.debugCandidates.some(
			(d) => d.type === 'inverse_head_and_shoulders' && (d.reason ?? '').startsWith('shoulders_not_near'),
		);
		expect(strictRejected).toBe(true);
	});

	// 肩の判定は `near(tolerancePct)` と `isSameLevel(ctx.hsShoulderMaxPct)` の AND で、実効閾値は `min(tolerancePct, ctx.hsShoulderMaxPct)`（issue #172）。
	// 本ブロックのケースは `buildCtx` の既定 `type`（`1day`）で走るので、cap は `HS_SHOULDER_MAX_PCT` = 5% のまま。

	it('H&S: tolerancePct のみ超過 → shoulders_not_near:tolerance', () => {
		// left=100, right=104.5 → 4.5/104.5 ≈ 0.0431 > tolerancePct(0.04) で near() は fail、<= HS_SHOULDER_MAX_PCT(0.05) で isSameLevel は通る
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 104.5, head: 130 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		detectHeadAndShoulders(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'head_and_shoulders' && d.accepted === false && d.reason?.startsWith('shoulders_not_near'),
		);
		expect(rejected?.reason).toBe('shoulders_not_near:tolerance');
		const details = rejected?.details as Record<string, unknown> | undefined;
		expect(details?.tolerancePct).toBe(0.04);
		expect(details?.shoulderMaxPct).toBe(0.05);
		expect(details?.shouldersDiffPct).toBeCloseTo(4.5 / 104.5, 6);
	});

	it('Inverse H&S: tolerancePct のみ超過 → shoulders_not_near:tolerance', () => {
		const { candles, pivots } = buildInverseHS({ leftShoulder: 100, rightShoulder: 104.5, head: 70 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		detectHeadAndShoulders(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) =>
				d.type === 'inverse_head_and_shoulders' && d.accepted === false && d.reason?.startsWith('shoulders_not_near'),
		);
		expect(rejected?.reason).toBe('shoulders_not_near:tolerance');
	});

	it('H&S: HS_SHOULDER_MAX_PCT のみ超過 → shoulders_not_near:cap（15min の tf-auto 許容）', () => {
		// `:cap` は `tolerancePct > cap` のときしか成立しないので、cap 5%（`1day`）のまま `tolerancePct` だけを 15min の tf-auto 値（0.06 > 0.05）に差し替えて発火させる。
		const tol15min = getDefaultToleranceForTf('15min');
		expect(tol15min).toBeGreaterThan(0.05);
		// left=100, right=105.5 → 5.5/105.5 ≈ 0.0521 <= tolerancePct(0.06) で near() は通り、> HS_SHOULDER_MAX_PCT(0.05) で isSameLevel が fail
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 105.5, head: 130 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: tol15min });
		detectHeadAndShoulders(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'head_and_shoulders' && d.accepted === false && d.reason?.startsWith('shoulders_not_near'),
		);
		expect(rejected?.reason).toBe('shoulders_not_near:cap');
	});

	it('Inverse H&S: HS_SHOULDER_MAX_PCT のみ超過 → shoulders_not_near:cap（30min の tf-auto 許容）', () => {
		const tol30min = getDefaultToleranceForTf('30min');
		expect(tol30min).toBeGreaterThan(0.05);
		const { candles, pivots } = buildInverseHS({ leftShoulder: 100, rightShoulder: 105.5, head: 70 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: tol30min });
		detectHeadAndShoulders(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) =>
				d.type === 'inverse_head_and_shoulders' && d.accepted === false && d.reason?.startsWith('shoulders_not_near'),
		);
		expect(rejected?.reason).toBe('shoulders_not_near:cap');
	});

	it('H&S: 両方超過 → shoulders_not_near:both（どちらを緩めても通らない）', () => {
		// left=100, right=112 → 12/112 ≈ 0.1071 → tolerancePct(0.04) も cap(0.05) も超過
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 112, head: 145 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		detectHeadAndShoulders(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'head_and_shoulders' && d.accepted === false && d.reason?.startsWith('shoulders_not_near'),
		);
		expect(rejected?.reason).toBe('shoulders_not_near:both');
	});

	it('Inverse H&S: 両方超過 → shoulders_not_near:both', () => {
		const { candles, pivots } = buildInverseHS({ leftShoulder: 100, rightShoulder: 112, head: 60 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		detectHeadAndShoulders(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) =>
				d.type === 'inverse_head_and_shoulders' && d.accepted === false && d.reason?.startsWith('shoulders_not_near'),
		);
		expect(rejected?.reason).toBe('shoulders_not_near:both');
	});

	it('接尾辞なしの shoulders_not_near は積まれない / tolerancePct <= cap では :cap も出ない', () => {
		// 掃引の `tolerancePct` 格子（0.03 / 0.04 / 0.05）は `1day` の cap（5%）以下であることが前提なので、`type` を短い足に変えるならこの格子も変えること。
		const seen = new Set<string>();
		for (const rightShoulder of [100, 102, 104, 104.5, 105, 105.5, 106, 108, 112, 120, 135]) {
			for (const tolerancePct of [0.03, 0.04, 0.05]) {
				for (const build of [buildHS, buildInverseHS]) {
					const isTop = build === buildHS;
					const { candles, pivots } = build({ leftShoulder: 100, rightShoulder, head: isTop ? 145 : 60 });
					const ctx = buildCtx({ candles, pivots, tolerancePct });
					detectHeadAndShoulders(ctx);
					for (const d of ctx.debugCandidates) {
						const reason = d.reason ?? '';
						if (reason.startsWith('shoulders_not_near')) seen.add(reason);
					}
				}
			}
		}
		expect(seen.has('shoulders_not_near')).toBe(false);
		expect(seen.has('shoulders_not_near:cap')).toBe(false);
		expect([...seen].sort()).toEqual(['shoulders_not_near:both', 'shoulders_not_near:tolerance']);
	});

	it('H&S: tolerancePct=0.06 でも肩 ±6%（HS_SHOULDER_MAX_PCT 超過）なら検出しない', () => {
		// left=100, right=106 → diff/max = 6/106 ≈ 0.0566 → > 0.05 cap だが ≤ 0.06 tolerancePct で、strict near() は通るが isSameLevel(.., 0.05) で弾かれる
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 106, head: 130 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.06 });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.filter((p) => p.type === 'head_and_shoulders');
		expect(hs).toHaveLength(0);

		// 本テストの主題が cap 境界そのものなので接尾辞まで固定する（issue #172）。
		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'head_and_shoulders' && d.accepted === false && d.reason === 'shoulders_not_near:cap',
		);
		expect(rejected).toBeDefined();
		const details = rejected?.details as Record<string, unknown> | undefined;
		expect(details?.shoulderMaxPct).toBe(0.05);
		expect(details?.shouldersDiffPct).toBeCloseTo(6 / 106, 6);
	});

	it('Inverse H&S: tolerancePct=0.06 でも肩 ±6%（HS_SHOULDER_MAX_PCT 超過）なら検出しない', () => {
		const { candles, pivots } = buildInverseHS({ leftShoulder: 100, rightShoulder: 106, head: 70 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.06 });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'inverse_head_and_shoulders' && d.accepted === false && d.reason === 'shoulders_not_near:cap',
		);
		expect(rejected).toBeDefined();
		const details = rejected?.details as Record<string, unknown> | undefined;
		expect(details?.shoulderMaxPct).toBe(0.05);
		expect(details?.shouldersDiffPct).toBeCloseTo(6 / 106, 6);
	});

	it('H&S: relaxed fallback でも肩 ±5% を超える候補は検出しない', () => {
		// left=100, right=106: strict(0.04) は near() で fail → relaxed パスに落ち、0.04*2.0=0.08 は通るが isSameLevel(100, 106, 0.05) で hard reject される
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 106, head: 130 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.filter((p) => p.type === 'head_and_shoulders');
		expect(hs).toHaveLength(0);
	});

	it('Inverse H&S: relaxed fallback でも肩 ±5% を超える候補は検出しない', () => {
		const { candles, pivots } = buildInverseHS({ leftShoulder: 100, rightShoulder: 106, head: 70 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toHaveLength(0);
	});

	it('H&S: strict 経路で肩差 5% 以内なら引き続き検出される（非退行）', () => {
		// left=100, right=104 → diff/max = 4/104 ≈ 0.0385 → < 0.05 cap, < 0.04 tolerancePct
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 104, head: 130 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.filter((p) => p.type === 'head_and_shoulders');
		expect(hs.length).toBeGreaterThanOrEqual(1);
		expect(hs[0]?._fallback).toBeUndefined();
	});

	it('Inverse H&S: strict 経路で肩差 5% 以内なら引き続き検出される（非退行）', () => {
		const { candles, pivots } = buildInverseHS({ leftShoulder: 100, rightShoulder: 104, head: 70 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs.length).toBeGreaterThanOrEqual(1);
		expect(ihs[0]?._fallback).toBeUndefined();
	});

	// relaxed は `near()` を呼ばず `tolerancePct * factors.shoulder` をインラインで比較するので、実効閾値は `min(tolerancePct * factors.shoulder, ctx.hsShoulderMaxPct)`（issue #174）。

	it('H&S relaxed: HS_SHOULDER_MAX_PCT のみ超過 → relaxed_shoulders_not_near:cap', () => {
		// left=100, right=106.5 → diff/max = 6.5/106.5 ≈ 0.0610 <= tolerancePct * 2.0 = 0.08 で relaxed の tolerance は通り、> HS_SHOULDER_MAX_PCT = 0.05 で cap だけ超過
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 106.5, head: 130 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectHeadAndShoulders(ctx);

		expect(result.patterns.filter((p) => p.type === 'head_and_shoulders')).toHaveLength(0);
		const relaxed = ctx.debugCandidates.filter(
			(d) => d.type === 'head_and_shoulders' && (d.reason ?? '').startsWith('relaxed_shoulders_not_near'),
		);
		expect(relaxed.map((d) => d.reason)).toEqual(['relaxed_shoulders_not_near:cap']);
		const details = relaxed[0]?.details as Record<string, unknown> | undefined;
		expect(details?.shoulderMaxPct).toBe(0.05);
		expect(details?.relaxedShoulderFactor).toBe(2.0);
		expect(details?.relaxedTolerancePct).toBeCloseTo(0.08, 12);
		expect(details?.shouldersDiffPct).toBeCloseTo(6.5 / 106.5, 12);

		const strict = ctx.debugCandidates.filter(
			(d) => d.type === 'head_and_shoulders' && (d.reason ?? '').startsWith('shoulders_not_near'),
		);
		expect(strict.map((d) => d.reason)).toEqual(['shoulders_not_near:both']);
	});

	it('Inverse H&S relaxed: HS_SHOULDER_MAX_PCT のみ超過 → relaxed_shoulders_not_near:cap', () => {
		const { candles, pivots } = buildInverseHS({ leftShoulder: 100, rightShoulder: 106.5, head: 70 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectHeadAndShoulders(ctx);

		expect(result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders')).toHaveLength(0);
		const relaxed = ctx.debugCandidates.filter(
			(d) => d.type === 'inverse_head_and_shoulders' && (d.reason ?? '').startsWith('relaxed_shoulders_not_near'),
		);
		expect(relaxed.map((d) => d.reason)).toEqual(['relaxed_shoulders_not_near:cap']);
		const strict = ctx.debugCandidates.filter(
			(d) => d.type === 'inverse_head_and_shoulders' && (d.reason ?? '').startsWith('shoulders_not_near'),
		);
		expect(strict.map((d) => d.reason)).toEqual(['shoulders_not_near:both']);
	});

	it('H&S relaxed: relaxed tolerance のみ超過 → relaxed_shoulders_not_near:tolerance', () => {
		// tolerancePct=0.02 → relaxed 末尾の段の tolerance は 0.04。left=100, right=104.5 → 4.5/104.5 ≈ 0.0431 > 0.04 かつ <= 0.05（cap は通る）
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 104.5, head: 130 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.02 });
		detectHeadAndShoulders(ctx);

		const relaxed = ctx.debugCandidates.filter(
			(d) => d.type === 'head_and_shoulders' && (d.reason ?? '').startsWith('relaxed_shoulders_not_near'),
		);
		expect(relaxed.map((d) => d.reason)).toEqual(['relaxed_shoulders_not_near:tolerance']);
	});

	it('H&S relaxed: 両方超過 → relaxed_shoulders_not_near:both', () => {
		// left=100, right=120 → 20/120 ≈ 0.167。0.04*2.0=0.08 も 0.05 も超える
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 120, head: 150 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		detectHeadAndShoulders(ctx);

		const relaxed = ctx.debugCandidates.filter(
			(d) => d.type === 'head_and_shoulders' && (d.reason ?? '').startsWith('relaxed_shoulders_not_near'),
		);
		expect(relaxed.map((d) => d.reason)).toEqual(['relaxed_shoulders_not_near:both']);
	});

	it('relaxed の棄却エントリは同じ窓で 2 回積まれない（段は外・窓が内のループ）', () => {
		// `RELAXED_FACTORS` は 2 段。素朴に両段で積むと同じ 5 点が 2 件になり cap を倍速で食うので、末尾の段でだけ積む（窓ごとにちょうど 1 件）。
		for (const build of [buildHS, buildInverseHS]) {
			const isTop = build === buildHS;
			const { candles, pivots } = build({ leftShoulder: 100, rightShoulder: 106.5, head: isTop ? 130 : 70 });
			const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
			detectHeadAndShoulders(ctx);

			const perWindow = new Map<string, number>();
			for (const d of ctx.debugCandidates) {
				if (!(d.reason ?? '').startsWith('relaxed_')) continue;
				const key = `${d.type}|${(d.indices ?? []).join(',')}`;
				perWindow.set(key, (perWindow.get(key) ?? 0) + 1);
			}
			expect(perWindow.size).toBe(1);
			expect([...perWindow.values()]).toEqual([1]);
		}
	});

	it('x1.6 段の肩落ちは棄却として積まれない（x2.0 段で通る窓）', () => {
		// tolerancePct=0.025 → x1.6 段 = 0.04 / x2.0 段 = 0.05。left=100, right=104.5 → 0.0431 は x1.6 で落ちて x2.0 で通る（cap 0.05 も通る）。
		// 末尾の段で救われる窓なので、x1.6 の落ちを積むと「棄却」の意味が壊れる。
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 104.5, head: 130 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.025 });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.filter((p) => p.type === 'head_and_shoulders');
		expect(hs.length).toBeGreaterThan(0);
		expect(hs[0]?._fallback).toBe('relaxed_hs_x2.0_0.4');
		expect(ctx.debugCandidates.filter((d) => (d.reason ?? '').startsWith('relaxed_shoulders_not_near'))).toHaveLength(
			0,
		);
	});

	it('relaxed のネックライン棄却は relaxed_ 接頭辞で strict と分かれる', () => {
		// 谷1=85 / 谷2=95 → relDev = 10/95 ≈ 0.105 > HS_NECKLINE_MAX_PCT(0.05)。肩と頭は strict / relaxed とも通るので、両経路がネックラインで落ちる。
		const { candles, pivots } = buildHS({ valley1: 85, valley2: 95, head: 130 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		detectHeadAndShoulders(ctx);

		const reasons = ctx.debugCandidates
			.filter((d) => d.type === 'head_and_shoulders' && (d.reason ?? '').includes('neckline_not_horizontal'))
			.map((d) => d.reason);
		expect(reasons).toContain('neckline_not_horizontal');
		expect(reasons).toContain('relaxed_neckline_not_horizontal');
		expect(reasons.filter((r) => r === 'relaxed_neckline_not_horizontal')).toHaveLength(1);
	});

	it('Inverse H&S relaxed: ネックライン棄却も relaxed_ 接頭辞で積む', () => {
		const { candles, pivots } = buildInverseHS({ peak1: 115, peak2: 128, head: 70 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		detectHeadAndShoulders(ctx);

		const reasons = ctx.debugCandidates
			.filter((d) => d.type === 'inverse_head_and_shoulders' && (d.reason ?? '').includes('neckline_not_horizontal'))
			.map((d) => d.reason);
		expect(reasons).toContain('relaxed_neckline_not_horizontal');
		expect(reasons.filter((r) => r === 'relaxed_neckline_not_horizontal')).toHaveLength(1);
	});

	it('relaxed は頭で落ちた窓を積まない（#174 の対象外。cap 保護）', () => {
		// head=101 は headProminencePct=0.04 の x2.0 段（= 0.016）でも突出不足。肩は同値で通るので、肩の理由コードもネックラインの理由コードも出ない。
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 100, head: 101 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		detectHeadAndShoulders(ctx);

		expect(ctx.debugCandidates.filter((d) => (d.reason ?? '').startsWith('relaxed_'))).toHaveLength(0);
	});

	it('includeForming=true + 右肩形成中 → forming H&S 検出', () => {
		// 左肩(idx=5,price=100) / 頭前谷(idx=20,price=88) / 頭(idx=30,price=135) / 頭後谷(idx=45,price=90)、最終 close=102（左肩 100 近傍 → 暫定右肩）
		const total = 66;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 85, 90));
		candles[5] = mkCandle(total - 5, 99, 100, 97, 99);
		candles[20] = mkCandle(total - 20, 87, 90, 87, 88);
		candles[30] = mkCandle(total - 30, 134, 135, 132, 134);
		candles[45] = mkCandle(total - 45, 89, 92, 89, 90);
		for (let i = 60; i < total; i++) {
			candles[i] = mkCandle(total - i, 101, 103, 100, 102);
		}

		const allPeaks: Pivot[] = [
			{ idx: 5, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 30, price: 135, kind: 'H', extremePrice: 135 },
		];
		const allValleys: Pivot[] = [
			{ idx: 20, price: 88, kind: 'L', extremePrice: 88 },
			{ idx: 45, price: 90, kind: 'L', extremePrice: 90 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectHeadAndShoulders(ctx);

		const forming = result.patterns.filter((p) => p.type === 'head_and_shoulders' && p.status === 'forming');
		expect(forming.length).toBeGreaterThanOrEqual(1);
		expect(forming[0]?.completionPct).toBeDefined();
		expect(forming[0]?.breakoutTarget).toBeDefined();
		expect(forming[0]?.targetMethod).toBe('neckline_projection');
	});

	it('includeForming=false では forming H&S は返さない', () => {
		const total = 66;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 85, 90));
		candles[5] = mkCandle(total - 5, 99, 100, 97, 99);
		candles[20] = mkCandle(total - 20, 87, 90, 87, 88);
		candles[30] = mkCandle(total - 30, 134, 135, 132, 134);
		candles[45] = mkCandle(total - 45, 89, 92, 89, 90);
		for (let i = 60; i < total; i++) {
			candles[i] = mkCandle(total - i, 101, 103, 100, 102);
		}

		const allPeaks: Pivot[] = [
			{ idx: 5, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 30, price: 135, kind: 'H', extremePrice: 135 },
		];
		const allValleys: Pivot[] = [
			{ idx: 20, price: 88, kind: 'L', extremePrice: 88 },
			{ idx: 45, price: 90, kind: 'L', extremePrice: 90 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: false,
		});
		const result = detectHeadAndShoulders(ctx);

		const forming = result.patterns.filter((p) => p.status === 'forming');
		expect(forming).toHaveLength(0);
	});

	it('includeForming=true + 右谷形成中 → forming inverse H&S 検出', () => {
		// 左肩(idx=5,price=100) / 頭前ピーク(idx=20,price=112) / 頭(idx=30,price=60) / 頭後ピーク(idx=45,price=110)、最終 close=98（左肩 100 近傍）
		const total = 66;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 85, 90));
		candles[5] = mkCandle(total - 5, 100, 102, 99, 101);
		candles[20] = mkCandle(total - 20, 111, 112, 110, 111);
		candles[30] = mkCandle(total - 30, 60, 62, 59, 61);
		candles[45] = mkCandle(total - 45, 109, 110, 108, 109);
		for (let i = 60; i < total; i++) {
			candles[i] = mkCandle(total - i, 97, 99, 97, 98);
		}

		const allPeaks: Pivot[] = [
			{ idx: 20, price: 112, kind: 'H', extremePrice: 112 },
			{ idx: 45, price: 110, kind: 'H', extremePrice: 110 },
		];
		const allValleys: Pivot[] = [
			{ idx: 5, price: 100, kind: 'L', extremePrice: 100 },
			{ idx: 30, price: 60, kind: 'L', extremePrice: 60 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectHeadAndShoulders(ctx);

		const forming = result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders' && p.status === 'forming');
		expect(forming.length).toBeGreaterThanOrEqual(1);
		expect(forming[0]?.completionPct).toBeDefined();
		expect(forming[0]?.breakoutTarget).toBeDefined();
	});

	it('completed H&S: structureRange=左肩〜右肩, confirmation=not_confirmed, precedingTrend あり', () => {
		const { candles, pivots } = buildHS();
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs).toBeDefined();
		if (!hs) return;

		// 左肩(idx=0) → 右肩(idx=60)
		expect(hs.structureRange?.start).toBe(candles[0].isoTime);
		expect(hs.structureRange?.end).toBe(candles[60].isoTime);

		expect(hs.confirmation?.type).toBe('not_confirmed');

		expect(hs.precedingTrend).toBeDefined();
		expect(hs.precedingTrend?.end).toBe(candles[0].isoTime);
		expect(typeof hs.precedingTrend?.lookbackBars).toBe('number');
	});

	it('completed Inverse H&S: structureRange=左肩〜右肩, confirmation=not_confirmed, precedingTrend あり', () => {
		const { candles, pivots } = buildInverseHS();
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.find((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toBeDefined();
		if (!ihs) return;

		expect(ihs.structureRange?.start).toBe(candles[0].isoTime);
		expect(ihs.structureRange?.end).toBe(candles[60].isoTime);
		expect(ihs.confirmation?.type).toBe('not_confirmed');
		expect(ihs.precedingTrend).toBeDefined();
	});

	it('forming H&S: structureRange / confirmation=not_confirmed / precedingTrend あり', () => {
		const total = 66;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 85, 90));
		candles[5] = mkCandle(total - 5, 99, 100, 97, 99);
		candles[20] = mkCandle(total - 20, 87, 90, 87, 88);
		candles[30] = mkCandle(total - 30, 134, 135, 132, 134);
		candles[45] = mkCandle(total - 45, 89, 92, 89, 90);
		for (let i = 60; i < total; i++) {
			candles[i] = mkCandle(total - i, 101, 103, 100, 102);
		}

		const allPeaks: Pivot[] = [
			{ idx: 5, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 30, price: 135, kind: 'H', extremePrice: 135 },
		];
		const allValleys: Pivot[] = [
			{ idx: 20, price: 88, kind: 'L', extremePrice: 88 },
			{ idx: 45, price: 90, kind: 'L', extremePrice: 90 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectHeadAndShoulders(ctx);

		const forming = result.patterns.find((p) => p.type === 'head_and_shoulders' && p.status === 'forming');
		expect(forming).toBeDefined();
		if (!forming) return;

		expect(forming.structureRange).toBeDefined();
		expect(forming.confirmation?.type).toBe('not_confirmed');
		expect(forming.precedingTrend).toBeDefined();
	});

	it('forming inverse H&S: 右肩が左肩から遠くても整合度の下限では落とさず、strict の物差しで levelMargin が 0 になる（#422）', () => {
		// 右肩（現在値 107）は左肩 100 から 7%。形成中のゲート 8% は通るが、strict の肩の許容幅を超える。
		const total = 66;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 85, 90));
		candles[5] = mkCandle(total - 5, 100, 102, 99, 100);
		candles[20] = mkCandle(total - 20, 111, 112, 110, 111);
		candles[30] = mkCandle(total - 30, 60, 62, 59, 60);
		candles[45] = mkCandle(total - 45, 109, 110, 108, 110);
		// 現在価格を 107 (左肩 100 から 7%) にして closeness を下げる
		for (let i = 60; i < total; i++) {
			candles[i] = mkCandle(total - i, 106, 108, 106, 107);
		}

		const allPeaks: Pivot[] = [
			{ idx: 20, price: 112, kind: 'H', extremePrice: 112 },
			{ idx: 45, price: 110, kind: 'H', extremePrice: 110 },
		];
		const allValleys: Pivot[] = [
			{ idx: 5, price: 100, kind: 'L', extremePrice: 100 },
			{ idx: 30, price: 60, kind: 'L', extremePrice: 60 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectHeadAndShoulders(ctx);

		const forming = result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders' && p.status === 'forming');
		expect(forming).toHaveLength(1);
		expect(forming[0].scoreComponents?.levelMargin).toBe(0);
		expect(forming[0].scoreComponents?.breakoutQuality).toBeUndefined();
		const axes = Object.values(forming[0].scoreComponents ?? {}) as number[];
		expect(forming[0].confidence).toBeCloseTo(axes.reduce((sum, v) => sum + v, 0) / axes.length, 2);
		expect(ctx.debugCandidates.some((d) => String(d.reason ?? '').startsWith('confidence_below_min'))).toBe(false);
	});

	it('forming H&S: 右肩が左肩から遠くても整合度の下限では落とさず、strict の物差しで levelMargin が 0 になる（#422）', () => {
		const total = 66;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 85, 90));
		candles[5] = mkCandle(total - 5, 99, 100, 97, 100);
		candles[20] = mkCandle(total - 20, 87, 90, 87, 88);
		candles[30] = mkCandle(total - 30, 134, 135, 132, 135);
		candles[45] = mkCandle(total - 45, 89, 92, 89, 90);
		// 現在価格を 93 (左肩 100 から 7%) にして closeness を下げる
		for (let i = 60; i < total; i++) {
			candles[i] = mkCandle(total - i, 93, 95, 91, 93);
		}

		const allPeaks: Pivot[] = [
			{ idx: 5, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 30, price: 135, kind: 'H', extremePrice: 135 },
		];
		const allValleys: Pivot[] = [
			{ idx: 20, price: 88, kind: 'L', extremePrice: 88 },
			{ idx: 45, price: 90, kind: 'L', extremePrice: 90 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectHeadAndShoulders(ctx);

		const forming = result.patterns.filter((p) => p.type === 'head_and_shoulders' && p.status === 'forming');
		expect(forming).toHaveLength(1);
		expect(forming[0].scoreComponents?.levelMargin).toBe(0);
		expect(forming[0].scoreComponents?.breakoutQuality).toBeUndefined();
		expect(ctx.debugCandidates.some((d) => String(d.reason ?? '').startsWith('confidence_below_min'))).toBe(false);
	});

	it('H&S: 右肩後にネックライン下抜け → status=completed, confirmation=neckline_breakout', () => {
		// neckline (85+85)/2 = 85, head 130。breakIdx=65 で close=80 (< 85*(1-0.015)=83.725) → 下抜け
		const { candles, pivots } = buildHsWithBreakout({ breakIdx: 65, breakClose: 80 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs).toBeDefined();
		if (!hs) return;

		expect(hs.status).toBe('completed');
		expect(hs.confirmation?.type).toBe('neckline_breakout');
		expect(hs.breakoutDirection).toBe('down');
		expect(hs.outcome).toBe('success');
		const breakoutBarIndex = hs.breakoutBarIndex;
		expect(typeof breakoutBarIndex).toBe('number');
		if (typeof breakoutBarIndex !== 'number') return;
		expect(breakoutBarIndex).toBeGreaterThan(60);
		expect(breakoutBarIndex).toBeLessThanOrEqual(candles.length - 1);

		expect(hs.range?.end).toBe(candles[breakoutBarIndex]?.isoTime);
		expect(hs.structureRange?.end).toBe(candles[60].isoTime);
		expect(hs.confirmation).toMatchObject({ type: 'neckline_breakout', date: hs.range?.end, idx: breakoutBarIndex });
	});

	it('H&S: 右肩後にターゲット到達 → targetReachedPct >= 100 + targetReached=true', () => {
		// target ≈ 85 - (130-85) = 40、breakoutPrice=80、末尾 idx=79 で low=25 (<= target=40) → 到達、pct = (25-80) / (40-80) * 100 = 137.5 → 138
		const total = 80;
		const { candles, pivots } = buildHsWithBreakout({
			breakIdx: 65,
			breakClose: 80,
			postBreakLow: 25,
			postBreakIdx: 79,
			totalBars: total,
		});
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs).toBeDefined();
		if (!hs) return;

		expect(hs.status).toBe('completed');
		// target = neckline(85) - (head(130) - neckline(85)) = 40
		expect(hs.breakoutTarget).toBe(40);
		expect(hs.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(hs.targetReached).toBe(true);
		expect(hs.targetReachedPrice).toBe(25);
		expect(hs.targetReachedDate).toBe(candles[79].isoTime);
	});

	it('H&S: 一度 target 到達後に close が戻る → high/low ベースで targetReached=true', () => {
		// ブレイク後の最安値で評価するので、末尾 idx=79 が close=80 (> target 40) に戻しても、中間 idx=70 の low=25 で到達扱いになる（(25-80)/(40-80)*100 = 137.5 → 138%）
		const total = 80;
		const { candles, pivots } = buildHsWithBreakout({
			breakIdx: 65,
			breakClose: 80,
			postBreakLow: 25,
			postBreakIdx: 70,
			totalBars: total,
		});
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs).toBeDefined();
		if (!hs) return;

		expect(hs.status).toBe('completed');
		expect(hs.confirmation?.type).toBe('neckline_breakout');
		expect(hs.breakoutTarget).toBe(40);

		expect(hs.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(hs.targetReached).toBe(true);
		expect(hs.targetReachedPrice).toBe(25);
		expect(hs.targetReachedDate).toBe(candles[70].isoTime);
		// 末尾 close は target を上回って戻っている（recovery を fixture が再現していることを念のため確認）
		const lastClose = candles[total - 1]?.close ?? Number.NaN;
		expect(lastClose).toBeGreaterThan(hs.breakoutTarget ?? Number.POSITIVE_INFINITY);
	});

	it('H&S: ブレイク後 low が target に届かない → 未到達 (targetReachedPct < 100)', () => {
		// postBreakLow 未指定なので全 post-break candle で low=77 > target 40 → 未到達、pct = (77-80)/(40-80)*100 = 7.5 → 8%
		const { candles, pivots } = buildHsWithBreakout({ breakIdx: 65, breakClose: 80 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs).toBeDefined();
		if (!hs) return;

		expect(hs.status).toBe('completed');
		expect(hs.confirmation?.type).toBe('neckline_breakout');
		expect(hs.breakoutTarget).toBe(40);
		expect(hs.targetReachedPct).toBeLessThan(100);
		expect(hs.targetReached).toBe(false);
	});

	it('H&S: ブレイク close == target（距離ゼロ）→ 進捗を出さず理由を申告する', () => {
		// breakClose=40 → breakoutPrice === target で targetDistance=0。距離ゼロは達成度を測る余地が無いので退化ガードで進捗を出さないが、breakoutTarget は出る（#210）。
		const { candles, pivots } = buildHsWithBreakout({ breakIdx: 65, breakClose: 40 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs).toBeDefined();
		if (!hs) return;

		expect(hs.status).toBe('completed');
		expect(hs.breakoutTarget).toBe(40);
		expect(hs.targetProgressOmittedReason).toBe('degenerate_target_distance');
		expect(hs.targetReached).toBeUndefined();
		expect(hs.targetReachedPct).toBeUndefined();
		expect(hs.targetReachedPrice).toBeUndefined();
		expect(hs.targetReachedDate).toBeUndefined();
	});

	it('H&S: ブレイク close が既に target を下回る（オーバーシュート）→ targetReached=true & pct>=100', () => {
		// breakClose=30 → breakoutPrice=30 < target 40 で既に到達済み。targetDistance=10, moveDistance=30-27=3, pct=30 だが、targetReached=true なので Math.max(100, 30) = 100 にクランプ
		const { candles, pivots } = buildHsWithBreakout({ breakIdx: 65, breakClose: 30 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs).toBeDefined();
		if (!hs) return;

		expect(hs.status).toBe('completed');
		expect(hs.confirmation?.type).toBe('neckline_breakout');
		expect(hs.breakoutTarget).toBe(40);
		expect(hs.targetReached).toBe(true);
		expect(hs.targetReachedPct).toBeGreaterThanOrEqual(100);
		// 不整合（reached=true なのに pct<0）が起きていないことを明示
		expect(hs.targetReachedPct).toBeGreaterThanOrEqual(0);
	});

	it('H&S: 右肩後にブレイクしない → status=near_completion, confirmation=not_confirmed', () => {
		// 既定 buildHS の末尾は close=90 で neckline 85 を割り込まない（90 > 83.725）
		const { candles, pivots } = buildHS();
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs).toBeDefined();
		if (!hs) return;

		expect(hs.status).not.toBe('completed');
		expect(hs.status).toBe('near_completion');
		expect(hs.confirmation?.type).toBe('not_confirmed');
		expect(hs.range?.end).toBe(candles[60].isoTime);
		expect(hs.structureRange?.end).toBe(candles[60].isoTime);
		expect(hs.breakoutBarIndex).toBeUndefined();
	});

	it('逆H&S: 右肩後にネックライン上抜け → status=completed, confirmation=neckline_breakout', () => {
		// neckline (115+115)/2 = 115, head 70。breakIdx=65 で close=120 (> 115*(1+0.015)=116.725) → 上抜け
		const { candles, pivots } = buildInverseHsWithBreakout({ breakIdx: 65, breakClose: 120 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.find((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toBeDefined();
		if (!ihs) return;

		expect(ihs.status).toBe('completed');
		expect(ihs.confirmation?.type).toBe('neckline_breakout');
		expect(ihs.breakoutDirection).toBe('up');
		expect(ihs.outcome).toBe('success');
		const breakoutBarIndex = ihs.breakoutBarIndex;
		expect(typeof breakoutBarIndex).toBe('number');
		if (typeof breakoutBarIndex !== 'number') return;
		expect(breakoutBarIndex).toBeGreaterThan(60);
		expect(ihs.range?.end).toBe(candles[breakoutBarIndex]?.isoTime);
		expect(ihs.structureRange?.end).toBe(candles[60].isoTime);
	});

	it('逆H&S: 右肩後にターゲット到達 → targetReachedPct >= 100 + targetReached=true', () => {
		// target ≈ 115 + (115-70) = 160、breakoutPrice=120、末尾 idx=79 で high=170 (>= target 160)、pct = (170-120)/(160-120)*100 = 125%
		const total = 80;
		const { candles, pivots } = buildInverseHsWithBreakout({
			breakIdx: 65,
			breakClose: 120,
			postBreakHigh: 170,
			postBreakIdx: 79,
			totalBars: total,
		});
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.find((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toBeDefined();
		if (!ihs) return;

		expect(ihs.status).toBe('completed');
		// target = neckline(115) + (neckline(115) - head(70)) = 160
		expect(ihs.breakoutTarget).toBe(160);
		expect(ihs.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(ihs.targetReached).toBe(true);
		expect(ihs.targetReachedPrice).toBe(170);
		expect(ihs.targetReachedDate).toBe(candles[79].isoTime);
	});

	it('逆H&S: 一度 target 到達後に close が戻る → high/low ベースで targetReached=true', () => {
		// 中間 idx=70 の high=170 (>= target 160) で到達、末尾 idx=79 は close=120 (< target 160) で recovery（(170-120)/(160-120)*100 = 125%）
		const total = 80;
		const { candles, pivots } = buildInverseHsWithBreakout({
			breakIdx: 65,
			breakClose: 120,
			postBreakHigh: 170,
			postBreakIdx: 70,
			totalBars: total,
		});
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.find((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toBeDefined();
		if (!ihs) return;

		expect(ihs.status).toBe('completed');
		expect(ihs.confirmation?.type).toBe('neckline_breakout');
		expect(ihs.breakoutTarget).toBe(160);

		expect(ihs.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(ihs.targetReached).toBe(true);
		expect(ihs.targetReachedPrice).toBe(170);
		expect(ihs.targetReachedDate).toBe(candles[70].isoTime);
		const lastClose = candles[total - 1]?.close ?? Number.NaN;
		expect(lastClose).toBeLessThan(ihs.breakoutTarget ?? Number.NEGATIVE_INFINITY);
	});

	it('逆H&S: ブレイク後 high が target に届かない → 未到達 (targetReachedPct < 100)', () => {
		// 全 post-break candle で high=123 (= breakClose+3) < target 160 → 未到達、pct = (123-120)/(160-120)*100 = 7.5 → 8%
		const { candles, pivots } = buildInverseHsWithBreakout({ breakIdx: 65, breakClose: 120 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.find((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toBeDefined();
		if (!ihs) return;

		expect(ihs.status).toBe('completed');
		expect(ihs.confirmation?.type).toBe('neckline_breakout');
		expect(ihs.breakoutTarget).toBe(160);
		expect(ihs.targetReachedPct).toBeLessThan(100);
		expect(ihs.targetReached).toBe(false);
	});

	it('逆H&S: ブレイク close == target（距離ゼロ）→ 進捗を出さず理由を申告する', () => {
		// target = 160, breakClose=160 → breakoutPrice === target → targetDistance=0（#210 の退化ガード）
		const { candles, pivots } = buildInverseHsWithBreakout({ breakIdx: 65, breakClose: 160 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.find((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toBeDefined();
		if (!ihs) return;

		expect(ihs.status).toBe('completed');
		expect(ihs.breakoutTarget).toBe(160);
		expect(ihs.targetProgressOmittedReason).toBe('degenerate_target_distance');
		expect(ihs.targetReached).toBeUndefined();
		expect(ihs.targetReachedPct).toBeUndefined();
		expect(ihs.targetReachedPrice).toBeUndefined();
		expect(ihs.targetReachedDate).toBeUndefined();
	});

	it('逆H&S: ブレイク close が既に target を上回る（オーバーシュート）→ targetReached=true & pct>=100', () => {
		// breakClose=170 → breakoutPrice=170 > target 160 で既に到達済み。targetDistance=10, moveDistance=173-170=3, pct=30 だが、targetReached=true なので 100 にクランプ
		const { candles, pivots } = buildInverseHsWithBreakout({ breakIdx: 65, breakClose: 170 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.find((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toBeDefined();
		if (!ihs) return;

		expect(ihs.status).toBe('completed');
		expect(ihs.confirmation?.type).toBe('neckline_breakout');
		expect(ihs.breakoutTarget).toBe(160);
		expect(ihs.targetReached).toBe(true);
		expect(ihs.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(ihs.targetReachedPct).toBeGreaterThanOrEqual(0);
	});

	it('逆H&S: 右肩後にブレイクしない → status=near_completion, confirmation=not_confirmed', () => {
		// 既定 buildInverseHS の末尾は close=90 で neckline 115 を超えない
		const { candles, pivots } = buildInverseHS();
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.find((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toBeDefined();
		if (!ihs) return;

		expect(ihs.status).not.toBe('completed');
		expect(ihs.status).toBe('near_completion');
		expect(ihs.confirmation?.type).toBe('not_confirmed');
		expect(ihs.range?.end).toBe(candles[60].isoTime);
		expect(ihs.structureRange?.end).toBe(candles[60].isoTime);
	});

	it('ピボット < 5 個では H&S/Inverse H&S とも検出しない', () => {
		const candles: CandleData[] = Array.from({ length: 30 }, (_, i) => mkCandle(30 - i, 90, 95, 85, 90));
		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 10, price: 85, kind: 'L', extremePrice: 85 },
			{ idx: 20, price: 130, kind: 'H', extremePrice: 130 },
		];
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);
		expect(result.patterns).toHaveLength(0);
	});

	describe('交互列が崩れたピボット列からの窓生成（issue #146）', () => {
		// issue #146 が実測として報告した BTC/JPY 1時間足のピボット列。swingDepth=3 では頭の直後に別の高値 12,726,672 が挟まり、頭より右の交互が崩れる。
		// 実データ側（`hs-window-btcjpy-1hour.test.ts`）は `detectSwingPoints` を含む配線を守り、本 describe は窓生成ロジック単体を守るので、一本化しない（#157）。
		const ISSUE_146_PIVOTS: Array<[number, number, 'H' | 'L']> = [
			[8, 12_213_097, 'L'], //  起点の安値 8/24
			[20, 12_582_009, 'H'], // 左肩 8/25
			[26, 12_529_686, 'L'], // 谷1 8/25（浅い -0.42%）
			[31, 12_851_000, 'H'], // 頭 8/25
			[34, 12_726_672, 'H'], // 頭の直後の余計な高値 ← ここで交互が崩れる
			[38, 12_531_708, 'L'], // 谷2 8/25
			[45, 12_617_817, 'H'], // 右肩 8/26
		];

		const ISSUE_146_WINDOW = [20, 26, 31, 38, 45];

		function buildIssue146Ctx(opts?: { tolerancePct?: number; headProminencePct?: number }): DetectContext {
			const total = 56;
			const candles: CandleData[] = [];
			for (let i = 0; i < total; i++) {
				const c = 12_213_097 + Math.round((i / total) * 300_000);
				candles.push(mkCandle(total - i, c, c + 5000, c - 5000, c));
			}
			for (const [idx, price, kind] of ISSUE_146_PIVOTS) {
				candles[idx] = mkCandle(
					total - idx,
					price,
					kind === 'H' ? price + 8000 : price + 3000,
					kind === 'L' ? price - 8000 : price - 3000,
					price,
				);
			}
			const pivots: Pivot[] = ISSUE_146_PIVOTS.map(([idx, price, kind]) => ({
				idx,
				price,
				kind,
				extremePrice: kind === 'H' ? price + 8000 : price - 8000,
			}));
			// 0.05 は両パラメータの相互独立性（issue #149）を確認するための固定値で、どちらの時間軸オート値でもない（headProminencePct の 1hour オートは 0.0083）。minBarsBetweenSwings=2 は 1hour の時間軸オート。
			const ctx = buildCtx({
				candles,
				pivots,
				tolerancePct: opts?.tolerancePct ?? 0.05,
				headProminencePct: opts?.headProminencePct ?? 0.05,
				type: '1hour',
				want: new Set(['head_and_shoulders']),
			});
			ctx.minDist = 2;
			return ctx;
		}

		const findIssueWindow = (ctx: DetectContext) =>
			ctx.debugCandidates.find(
				(d) => d.type === 'head_and_shoulders' && JSON.stringify(d.indices) === JSON.stringify(ISSUE_146_WINDOW),
			);

		it('頭 12,851,000 を中心とする 5 点が候補として生成される', () => {
			const ctx = buildIssue146Ctx();
			detectHeadAndShoulders(ctx);
			// 左肩 20 / 谷1 26 / 頭 31 / 谷2 38 / 右肩 45。頭の直後の高値 34 を挟んでも窓になる。
			expect(findIssueWindow(ctx)).toBeDefined();
		});

		it('生成された候補は理由付きで結論が出る（頭のマージン不足で head_not_higher）', () => {
			// 頭が右肩を 1.85% しか上回っておらず、strict が要求する頭のマージン（ここで渡す headProminencePct = 5%）に届かないので head_not_higher で棄却されるのが正しい。
			const ctx = buildIssue146Ctx();
			detectHeadAndShoulders(ctx);

			const cand = findIssueWindow(ctx);
			expect(cand?.accepted).toBe(false);
			expect(cand?.reason).toBe('head_not_higher');
			// 棄却理由を出力から検算できる（#125 / #128 の方針）。
			const details = cand?.details as { leftShoulder: number; head: number; rightShoulder: number };
			expect(details.leftShoulder).toBe(12_582_009);
			expect(details.head).toBe(12_851_000);
			expect(details.rightShoulder).toBe(12_617_817);
		});

		it('tolerancePct をどれだけ動かしても頭の判定（head_not_higher）は変わらない', () => {
			// 肩差 0.284%（35,808 / 12,617,817）はどんな tolerancePct でも near() を通るので、tolerancePct だけを極端に振っても head_not_higher は変わらない。
			const low = buildIssue146Ctx({ tolerancePct: 0.005, headProminencePct: 0.05 });
			detectHeadAndShoulders(low);
			const high = buildIssue146Ctx({ tolerancePct: 0.1, headProminencePct: 0.05 });
			detectHeadAndShoulders(high);

			const candLow = findIssueWindow(low);
			const candHigh = findIssueWindow(high);
			expect(candLow?.reason).toBe('head_not_higher');
			expect(candHigh?.reason).toBe('head_not_higher');

			const detailsLow = candLow?.details as { headProminencePct: number; tolerancePct: number };
			const detailsHigh = candHigh?.details as { headProminencePct: number; tolerancePct: number };
			expect(detailsLow.headProminencePct).toBe(0.05);
			expect(detailsHigh.headProminencePct).toBe(0.05);
			// tolerancePct 自体は debug に反映される（消えたわけではなく、頭の判定に使われないだけ）。
			expect(detailsLow.tolerancePct).toBe(0.005);
			expect(detailsHigh.tolerancePct).toBe(0.1);
		});

		it('headProminencePct を既定より緩めると head_not_higher が解消する', () => {
			// 頭のマージンは 1.85% なので、headProminencePct を既定 5% から 1% まで下げると head_not_higher では棄却されなくなる（tolerancePct は既定のまま）。
			const ctx = buildIssue146Ctx({ headProminencePct: 0.01 });
			detectHeadAndShoulders(ctx);

			const cand = findIssueWindow(ctx);
			expect(cand?.reason).not.toBe('head_not_higher');
		});

		it('厳密に交互する列でも、肩を跨ぐ窓（gap>=3）は新たに生成される', () => {
			// 肩を跨ぐ窓（gap>=3）は厳密に交互する列でも出る仕様（#146 の 5 点自体が gap=3 の窓）。固定しておかないと「交互列なら旧実装と同一」という誤った不変条件が書き戻されうる。
			// 肩 h0=0(100) / h1=20(118) / h2=40(130) / h3=60(101)。(h0, h3) を肩に取ると頭 = 間の最高値 130、肩は 100 と 101 で揃う。
			const pts: Array<[number, number, 'H' | 'L']> = [
				[0, 100, 'H'],
				[10, 80, 'L'],
				[20, 118, 'H'],
				[30, 82, 'L'],
				[40, 130, 'H'],
				[50, 81, 'L'],
				[60, 101, 'H'],
			];
			const candles: CandleData[] = Array.from({ length: 70 }, (_, i) => mkCandle(70 - i, 90, 95, 85, 90));
			for (const [idx, price] of pts) candles[idx] = mkCandle(70 - idx, price, price + 2, price - 2, price);
			const pivots: Pivot[] = pts.map(([idx, price, kind]) => ({ idx, price, kind, extremePrice: price }));

			const ctx = buildCtx({ candles, pivots, want: new Set(['head_and_shoulders']) });
			detectHeadAndShoulders(ctx);

			const spanning = ctx.debugCandidates.find(
				(d) => d.type === 'head_and_shoulders' && JSON.stringify(d.indices) === JSON.stringify([0, 10, 40, 50, 60]),
			);
			expect(spanning).toBeDefined();
			expect(spanning?.accepted).toBe(true);
		});

		it('肩を跨ぐ窓でも、外側の脚に肩を明確に超える山があれば窓にしない', () => {
			// H100-L80-H130-L80-H120-L80-H100 で (H0, H60) を肩に取ると、谷2(30) と右肩(60) の間に右肩より 20% 高い山 H40(120) があり、肩の取り違えになる。
			// 同水準（`HS_SHOULDER_MAX_PCT` = 5% 以内）の山は「幅のある肩」として通すので、実データの双子の山（BTC/JPY 日足 idx 38 と 42 は差 0.08%）は落ちない。
			const pts: Array<[number, number, 'H' | 'L']> = [
				[0, 100, 'H'],
				[10, 80, 'L'],
				[20, 130, 'H'],
				[30, 80, 'L'],
				[40, 120, 'H'],
				[50, 80, 'L'],
				[60, 100, 'H'],
			];
			const candles: CandleData[] = Array.from({ length: 70 }, (_, i) => mkCandle(70 - i, 90, 95, 85, 90));
			for (const [idx, price] of pts) candles[idx] = mkCandle(70 - idx, price, price + 2, price - 2, price);
			const pivots: Pivot[] = pts.map(([idx, price, kind]) => ({ idx, price, kind, extremePrice: price }));

			const ctx = buildCtx({ candles, pivots, want: new Set(['head_and_shoulders']) });
			const result = detectHeadAndShoulders(ctx);

			expect(result.patterns.filter((p) => p.type === 'head_and_shoulders')).toHaveLength(0);
			const misAnchored = ctx.debugCandidates.find(
				(d) => d.type === 'head_and_shoulders' && JSON.stringify(d.indices) === JSON.stringify([0, 10, 20, 30, 60]),
			);
			expect(misAnchored).toBeUndefined();
		});
	});
});

// フィクスチャはネックラインを意図的に傾けてある（水平だと頭の真下とブレイク足時点のネックラインが一致し、回帰を検出できない）。
describe('detectHeadAndShoulders: ネックライン射影の高さ基準（issue #208）', () => {
	/** 谷1(idx=15,83) → 谷2(idx=45,87) で `relDev = 4/87 = 4.6%`（`HS_NECKLINE_MAX_PCT = 5%` 内）。頭(idx=30) の真下は 85。 */
	function buildSlopedHsWithBreakout() {
		const total = 80;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 80, 90));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[15] = mkCandle(total - 15, 84, 86, 83, 84);
		candles[30] = mkCandle(total - 30, 129, 130, 127, 129);
		candles[45] = mkCandle(total - 45, 88, 90, 87, 88);
		candles[60] = mkCandle(total - 60, 99, 100, 97, 99);
		// idx 61-64 の close=90 では nlAt(k) * (1 - 0.015) を下回らないので、ブレイク足は必ず 65 になる。
		for (let i = 65; i < total; i++) candles[i] = mkCandle(total - i, 82, 85, 77, 80);

		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 15, price: 83, kind: 'L', extremePrice: 83 },
			{ idx: 30, price: 130, kind: 'H', extremePrice: 130 },
			{ idx: 45, price: 87, kind: 'L', extremePrice: 87 },
			{ idx: 60, price: 100, kind: 'H', extremePrice: 100 },
		];
		return { candles, pivots };
	}

	/** 傾いたネックラインを持つ逆 H&S + ブレイク（上のミラー）。山1(15,113) → 山2(45,118)。 */
	function buildSlopedIhsWithBreakout() {
		const total = 80;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 80, 90));
		candles[0] = mkCandle(total, 101, 103, 100, 101);
		candles[15] = mkCandle(total - 15, 112, 113, 110, 112);
		candles[30] = mkCandle(total - 30, 71, 73, 70, 71);
		candles[45] = mkCandle(total - 45, 117, 118, 115, 117);
		candles[60] = mkCandle(total - 60, 101, 103, 100, 101);
		for (let i = 65; i < total; i++) candles[i] = mkCandle(total - i, 128, 133, 125, 130);

		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L', extremePrice: 100 },
			{ idx: 15, price: 113, kind: 'H', extremePrice: 113 },
			{ idx: 30, price: 70, kind: 'L', extremePrice: 70 },
			{ idx: 45, price: 118, kind: 'H', extremePrice: 118 },
			{ idx: 60, price: 100, kind: 'L', extremePrice: 100 },
		];
		return { candles, pivots };
	}

	it('strict H&S: 高さは頭の真下、投影の起点はブレイク足', () => {
		// nlAt(30) = 85 → 高さ = 130 - 85 = 45、nlAt(65) = 87（#211 のクランプで谷2 の 87 に頭打ち）→ target = 87 - 45 = 42
		const { candles, pivots } = buildSlopedHsWithBreakout();
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs?.breakoutBarIndex).toBe(65);
		expect(hs?.breakoutTarget).toBe(42);
		expect(hs?.breakoutTarget).not.toBe(44);
		expect(hs?.targetMethod).toBe('neckline_projection');
	});

	it('strict Inverse H&S: 高さは頭の真下、投影の起点はブレイク足', () => {
		// nlAt(30) = 115.5 → 高さ = 115.5 - 70 = 45.5、nlAt(65) = 118（#211 のクランプで山2 の 118 に頭打ち）→ target = 118 + 45.5 = 163.5
		const { candles, pivots } = buildSlopedIhsWithBreakout();
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.find((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs?.breakoutBarIndex).toBe(65);
		expect(ihs?.breakoutTarget).toBe(163.5);
		expect(ihs?.breakoutTarget).not.toBe(166);
		expect(ihs?.targetMethod).toBe('neckline_projection');
	});

	it('下方向 H&S の target はブレイク終値より下に出る（無条件到達にならない）', () => {
		const { candles, pivots } = buildSlopedHsWithBreakout();
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.find((p) => p.type === 'head_and_shoulders');
		const breakClose = hs?.breakout?.price;
		expect(breakClose).toBeDefined();
		// #208 の症状は「下抜けブレイクなのに target がブレイク終値より上」だった。
		expect(hs?.breakoutTarget).toBeLessThan(breakClose as number);
	});

	it('forming H&S: 投影の起点は最終構成点（暫定右肩）で、高さは頭の真下', () => {
		// ネックライン (20,88) → (45,90)。nlAt(30) = 88.8 → 高さ = 135 - 88.8 = 46.2、暫定右肩 idx=65 → nlAt(65) = 90（#211 のクランプ）→ target = 90 - 46.2 = 43.8
		const total = 66;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 85, 90));
		candles[5] = mkCandle(total - 5, 99, 100, 97, 99);
		candles[20] = mkCandle(total - 20, 87, 90, 87, 88);
		candles[30] = mkCandle(total - 30, 134, 135, 132, 134);
		candles[45] = mkCandle(total - 45, 89, 92, 89, 90);
		for (let i = 60; i < total; i++) candles[i] = mkCandle(total - i, 101, 103, 100, 102);

		const allPeaks: Pivot[] = [
			{ idx: 5, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 30, price: 135, kind: 'H', extremePrice: 135 },
		];
		const allValleys: Pivot[] = [
			{ idx: 20, price: 88, kind: 'L', extremePrice: 88 },
			{ idx: 45, price: 90, kind: 'L', extremePrice: 90 },
		];
		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectHeadAndShoulders(ctx);

		const forming = result.patterns.find((p) => p.type === 'head_and_shoulders' && p.status === 'forming');
		expect(forming?.breakoutTarget).toBe(43.8);
		expect(forming?.breakoutTarget).not.toBe(41);
	});

	it('水平ネックラインでは起点をどこに取っても target が変わらない（relaxed 経路の値は不変）', () => {
		const flat = [
			{ x: 15, y: 85 },
			{ x: 45, y: 85 },
		];
		const atBreak = necklineProjectionTarget({
			neckline: flat,
			anchorIdx: 65,
			headIdx: 30,
			headPrice: 130,
			direction: 'down',
			fallbackNecklinePrice: 85,
		});
		const atShoulder = necklineProjectionTarget({
			neckline: flat,
			anchorIdx: 60,
			headIdx: 30,
			headPrice: 130,
			direction: 'down',
			fallbackNecklinePrice: 85,
		});
		expect(atBreak).toBe(40);
		expect(atShoulder).toBe(40);
	});

	// 頭の真下の値は内挿で両端の間に収まるので、高さ 0 以下のガードは検出器経由では到達しない。helper を直接呼んで振る舞いだけ固定する。
	it('高さが 0 以下なら target を出さない（H&S）', () => {
		const nl = [
			{ x: 15, y: 140 },
			{ x: 45, y: 150 },
		];
		expect(
			necklineProjectionTarget({
				neckline: nl,
				anchorIdx: 65,
				headIdx: 30,
				headPrice: 130,
				direction: 'down',
				fallbackNecklinePrice: 145,
			}),
		).toBeUndefined();
	});

	it('高さが 0 以下なら target を出さない（逆 H&S）', () => {
		const nl = [
			{ x: 15, y: 60 },
			{ x: 45, y: 65 },
		];
		expect(
			necklineProjectionTarget({
				neckline: nl,
				anchorIdx: 65,
				headIdx: 30,
				headPrice: 70,
				direction: 'up',
				fallbackNecklinePrice: 62,
			}),
		).toBeUndefined();
	});

	it('高さがちょうど 0 なら target を出さない（境界）', () => {
		const nl = [
			{ x: 15, y: 130 },
			{ x: 45, y: 130 },
		];
		expect(
			necklineProjectionTarget({
				neckline: nl,
				anchorIdx: 65,
				headIdx: 30,
				headPrice: 130,
				direction: 'down',
				fallbackNecklinePrice: 130,
			}),
		).toBeUndefined();
	});

	// 壊れた添字では `necklineAt` が NaN を返し、先に弾かないと `necklineAtOr` が fallbackNecklinePrice に畳んで「もっともらしい target」を返してしまう。
	it('headIdx が有限でないなら target を出さない（fallback に畳まない）', () => {
		expect(
			necklineProjectionTarget({
				neckline: [
					{ x: 15, y: 85 },
					{ x: 45, y: 85 },
				],
				anchorIdx: 65,
				headIdx: Number.NaN,
				headPrice: 130,
				direction: 'down',
				fallbackNecklinePrice: 85,
			}),
		).toBeUndefined();
	});

	it('anchorIdx が有限でないなら target を出さない（fallback に畳まない）', () => {
		expect(
			necklineProjectionTarget({
				neckline: [
					{ x: 15, y: 85 },
					{ x: 45, y: 85 },
				],
				anchorIdx: Number.POSITIVE_INFINITY,
				headIdx: 30,
				headPrice: 130,
				direction: 'down',
				fallbackNecklinePrice: 85,
			}),
		).toBeUndefined();
	});

	it('headPrice が有限でないなら target を出さない', () => {
		expect(
			necklineProjectionTarget({
				neckline: [
					{ x: 15, y: 85 },
					{ x: 45, y: 85 },
				],
				anchorIdx: 65,
				headIdx: 30,
				headPrice: Number.NaN,
				direction: 'down',
				fallbackNecklinePrice: 85,
			}),
		).toBeUndefined();
	});

	it('ネックラインが 2 点未満なら fallbackNecklinePrice を使う', () => {
		// necklineAt が NaN を返す経路。頭の真下も起点も fallback に畳まれるので target = 85 - (130 - 85) = 40。
		expect(
			necklineProjectionTarget({
				neckline: [{ x: 15, y: 85 }],
				anchorIdx: 65,
				headIdx: 30,
				headPrice: 130,
				direction: 'down',
				fallbackNecklinePrice: 85,
			}),
		).toBe(40);
	});
});

// クランプは `necklineAt` の 1 箇所にあり、3 消費者（ブレイク検出 / スコアリングの `necklinePrice` / ターゲット投影）すべてに同時に効く。
describe('necklineAt の外挿クランプ（issue #211）', () => {
	/** 傾き +4/30 本（15 本目 85 → 45 本目 89）。 */
	const sloped = [
		{ x: 15, y: 85 },
		{ x: 45, y: 89 },
	];

	it('定義点の内側は内挿のまま（クランプは恒等）', () => {
		expect(necklineAt(sloped, 15)).toBe(85);
		expect(necklineAt(sloped, 30)).toBe(87);
		expect(necklineAt(sloped, 45)).toBe(89);
	});

	it('右端より後ろは右端の値で頭打ちになる（外挿しない）', () => {
		expect(necklineAt(sloped, 46)).toBe(89);
		expect(necklineAt(sloped, 65)).toBe(89);
		expect(necklineAt(sloped, 100000)).toBe(89);
		// 無クランプなら nlAt(65) = 89 + 4/30 * 20 = 91.667 だった。
		expect(necklineAt(sloped, 65)).not.toBeCloseTo(91.667, 3);
	});

	it('左端より手前は左端の値で頭打ちになる（外挿しない）', () => {
		expect(necklineAt(sloped, 14)).toBe(85);
		expect(necklineAt(sloped, 0)).toBe(85);
		expect(necklineAt(sloped, -100000)).toBe(85);
		// 無クランプなら nlAt(0) = 85 - 4/30 * 15 = 83 だった。
		expect(necklineAt(sloped, 0)).not.toBe(83);
	});

	it('定義点が逆順に並んでいても区間へ丸める（片端へ潰れない）', () => {
		// 現行 4 経路は `p1.idx < p3.idx` を守るが、順序前提のクランプ（`min(max(i, a.x), b.x)`）だと右側外挿で左端 85 に潰れるので、順序に依存しないことを固定する。
		const reversed = [
			{ x: 45, y: 89 },
			{ x: 15, y: 85 },
		];
		expect(necklineAt(reversed, 30)).toBe(87);
		expect(necklineAt(reversed, 65)).toBe(89);
		expect(necklineAt(reversed, 0)).toBe(85);
	});

	it('水平ネックラインではクランプが恒等（relaxed 経路の値は動かない）', () => {
		const flat = [
			{ x: 15, y: 85 },
			{ x: 45, y: 85 },
		];
		for (const idx of [-100000, 0, 15, 30, 45, 65, 100000]) {
			expect(necklineAt(flat, idx)).toBe(85);
		}
	});

	it('2 定義点の x が同じなら区間が退化するので常に a.y（0 除算を作らない）', () => {
		const degenerate = [
			{ x: 30, y: 85 },
			{ x: 30, y: 89 },
		];
		expect(necklineAt(degenerate, 0)).toBe(85);
		expect(necklineAt(degenerate, 30)).toBe(85);
		expect(necklineAt(degenerate, 65)).toBe(85);
	});

	// `Math.min` / `Math.max` は `±Infinity` を端点へ丸めるので、ガードが無いと壊れた添字に端点の `y`（89 / 85）というもっともらしい有限値が返り、`necklineAtOr` の fallback にも畳まれなくなる。
	it('添字が非有限なら NaN（±Infinity が端点へ丸められない）', () => {
		expect(necklineAt(sloped, Number.POSITIVE_INFINITY)).toBeNaN();
		expect(necklineAt(sloped, Number.NEGATIVE_INFINITY)).toBeNaN();
		expect(necklineAt(sloped, Number.NaN)).toBeNaN();
	});

	it('x が退化したネックラインでも非有限の添字は NaN（経路で扱いを変えない）', () => {
		const degenerate = [
			{ x: 30, y: 85 },
			{ x: 30, y: 89 },
		];
		expect(necklineAt(degenerate, Number.POSITIVE_INFINITY)).toBeNaN();
		expect(necklineAt(degenerate, Number.NaN)).toBeNaN();
	});

	it('ネックラインが 2 点未満 / 定義点が非有限なら NaN', () => {
		expect(necklineAt(undefined, 30)).toBeNaN();
		expect(necklineAt([{ x: 15, y: 85 }], 30)).toBeNaN();
		expect(
			necklineAt(
				[
					{ x: Number.NaN, y: 85 },
					{ x: 45, y: 89 },
				],
				30,
			),
		).toBeNaN();
		expect(
			necklineAt(
				[
					{ x: 15, y: 85 },
					{ x: 45, y: Number.NaN },
				],
				30,
			),
		).toBeNaN();
	});

	it('ターゲット投影の起点までクランプが届く（H&S / 逆 H&S）', () => {
		// 頭 idx=30 の真下は 87 → 高さ = 130 - 87 = 43。起点は nlAt(65) = 89 に頭打ちになるので target = 89 - 43 = 46。
		expect(
			necklineProjectionTarget({
				neckline: sloped,
				anchorIdx: 65,
				headIdx: 30,
				headPrice: 130,
				direction: 'down',
				fallbackNecklinePrice: 87,
			}),
		).toBe(46);

		// 山1 (15,113) → 山2 (45,118)。nlAt(30) = 115.5 → 高さ = 115.5 - 70 = 45.5。起点は nlAt(65) = 118 → target = 118 + 45.5 = 163.5。
		expect(
			necklineProjectionTarget({
				neckline: [
					{ x: 15, y: 113 },
					{ x: 45, y: 118 },
				],
				anchorIdx: 65,
				headIdx: 30,
				headPrice: 70,
				direction: 'up',
				fallbackNecklinePrice: 115.5,
			}),
		).toBe(163.5);
	});
});

// 固定するのは「軸が 6 本あること」ではなく、rd（`relDev(左肩, 右肩)`）以外の量が実際に得点を動かすこと（issue #204）。
describe('detectHeadAndShoulders: 整合度の多軸化（issue #204）', () => {
	/** `detect_hs.ts` の `necklineAt` と同じ式（定義点の外側はクランプする。#211）。 */
	function nlAt(neckline: ReadonlyArray<{ x: number; y: number }>, i: number): number {
		const [a, b] = neckline;
		const clampedI = Math.min(Math.max(a.x, b.x), Math.max(Math.min(a.x, b.x), i));
		return a.y + ((b.y - a.y) * (clampedI - a.x)) / (b.x - a.x);
	}

	it('完成済み H&S は levelMargin ほか 5 軸を出し、symmetry と duration は出さない（#422）', () => {
		const { candles, pivots } = buildHsWithBreakout();
		const hs = detectHeadAndShoulders(buildCtx({ candles, pivots })).patterns.find(
			(p) => p.type === 'head_and_shoulders',
		);
		expect(hs?.status).toBe('completed');
		const sc = hs?.scoreComponents;
		expect(sc).toBeDefined();
		expect(sc).not.toHaveProperty('symmetry');
		expect(sc).not.toHaveProperty('duration');
		expect(sc?.levelMargin).toBe(1); // 両肩とも 100
		expect(sc?.headProminence).toBeGreaterThan(0);
		expect(sc?.timeSymmetry).toBe(1); // 左肩→頭 30 本 / 頭→右肩 30 本
		expect(sc?.breakoutQuality).toBeGreaterThan(0);
	});

	it('未ブレイク（near_completion）では breakoutQuality が付かない', () => {
		// ブレイクが無いので突破足の終値が無く、軸そのものが算出できない。0 として混ぜず平均から外す（「測れなかった」を「悪い」に化けさせない）。
		const { candles, pivots } = buildHS();
		const hs = detectHeadAndShoulders(buildCtx({ candles, pivots })).patterns.find(
			(p) => p.type === 'head_and_shoulders',
		);
		expect(hs?.status).toBe('near_completion');
		expect(hs?.scoreComponents).not.toHaveProperty('breakoutQuality');
		expect(hs?.scoreComponents?.levelMargin).toBeDefined();
	});

	it('levelMargin の物差しは strict の肩の判定と同じ幅（tolerancePct と肩の上限の小さいほう）', () => {
		// 両肩 100 / 102: relDev = 2 / 102。1day の肩の上限（hsShoulderMaxPct）は tolerancePct 0.04 より広いので、物差しは 0.04。
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 102 });
		const ctx = buildCtx({ candles, pivots });
		expect(ctx.hsShoulderMaxPct).toBeGreaterThan(0.04);
		const hs = detectHeadAndShoulders(ctx).patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs?.scoreComponents?.levelMargin).toBeCloseTo(1 - 2 / 102 / 0.04, 4);

		// 肩の上限のほうが狭いときは、上限が物差しになる。
		const narrow = buildCtx({ candles, pivots });
		narrow.hsShoulderMaxPct = 0.03;
		const narrowHs = detectHeadAndShoulders(narrow).patterns.find((p) => p.type === 'head_and_shoulders');
		expect(narrowHs?.scoreComponents?.levelMargin).toBeCloseTo(1 - 2 / 102 / 0.03, 4);
	});

	it('headProminence は突出ゲートに対する余裕（ゲートの 2 倍で 0.5）', () => {
		// headProminencePct = 0.04、head = 108 → 実測突出率 8% はゲートのちょうど 2 倍。
		const { candles, pivots } = buildHS({ head: 108 });
		const hs = detectHeadAndShoulders(buildCtx({ candles, pivots })).patterns.find(
			(p) => p.type === 'head_and_shoulders',
		);
		expect(hs?.scoreComponents?.headProminence).toBeCloseTo(0.5, 4);

		// 頭が高いほど余裕が増える（130 → 実測 30% はゲートの 7.5 倍で 1 − 1/7.5 = 0.8667）。
		const tall = buildHS({ head: 130 });
		const tallHs = detectHeadAndShoulders(buildCtx({ candles: tall.candles, pivots: tall.pivots })).patterns.find(
			(p) => p.type === 'head_and_shoulders',
		);
		expect(tallHs?.scoreComponents?.headProminence).toBeCloseTo(1 - 0.04 / 0.3, 4);
	});

	it('timeSymmetry は左肩→頭 と 頭→右肩 のバー数比', () => {
		// 頭を idx 20 に置く（左 20 本 / 右 40 本 → 0.5）。他は buildHS と同じ水準。
		const candles: CandleData[] = [];
		for (let i = 0; i < 70; i++) candles.push(mkCandle(70 - i, 90, 95, 80, 90));
		candles[0] = mkCandle(70, 99, 100, 97, 99);
		candles[10] = mkCandle(60, 86, 88, 85, 86);
		candles[20] = mkCandle(50, 129, 130, 127, 129);
		candles[45] = mkCandle(25, 86, 88, 85, 86);
		candles[60] = mkCandle(10, 99, 100, 97, 99);
		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 10, price: 85, kind: 'L', extremePrice: 85 },
			{ idx: 20, price: 130, kind: 'H', extremePrice: 130 },
			{ idx: 45, price: 85, kind: 'L', extremePrice: 85 },
			{ idx: 60, price: 100, kind: 'H', extremePrice: 100 },
		];
		const hs = detectHeadAndShoulders(buildCtx({ candles, pivots })).patterns.find(
			(p) => p.type === 'head_and_shoulders',
		);
		expect(hs?.scoreComponents?.timeSymmetry).toBeCloseTo(20 / 40, 4);
	});

	it('breakoutQuality の分母は「頭の真下のネックライン」までの高さ（#208 と同じ基準）', () => {
		// 傾きつきネックライン（谷1 = 85 / 谷2 = 89。相対差 4.5% < HS_NECKLINE_MAX_PCT 5%）にすると、頭の真下のネックラインとブレイク足時点のネックラインがずれる。
		const { candles, pivots } = buildHsWithBreakout();
		pivots[3] = { idx: 45, price: 89, kind: 'L', extremePrice: 89 };
		candles[45] = mkCandle(35, 90, 92, 89, 90);
		const hs = detectHeadAndShoulders(buildCtx({ candles, pivots })).patterns.find(
			(p) => p.type === 'head_and_shoulders',
		);
		expect(hs?.status).toBe('completed');
		const neckline = hs?.neckline as Array<{ x: number; y: number }>;
		const breakIdx = hs?.breakout?.idx as number;
		const breakClose = hs?.breakout?.price as number;
		const excess = nlAt(neckline, breakIdx) - breakClose;
		const heightAtHead = 130 - nlAt(neckline, 30);
		const heightAtBreakout = Math.abs(130 - nlAt(neckline, breakIdx));

		expect(hs?.scoreComponents?.breakoutQuality).toBeCloseTo(excess / heightAtHead, 4);
		// 2 つの高さが実際に違う入力であることを固定する（同値なら上の比較が空虚になる）。
		expect(heightAtBreakout).not.toBeCloseTo(heightAtHead, 3);
	});

	it('relaxed 経路も同じ軸構成で、突出の採点は strict の閾値で行う（#227 Phase 2）', () => {
		// left=100 / right=105 で strict の肩判定が落ち、relaxed 第 1 段（shoulder ×1.6 / head ×0.6）が拾う。
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 105, head: 130 });
		const hs = detectHeadAndShoulders(buildCtx({ candles, pivots, tolerancePct: 0.04 })).patterns.find(
			(p) => p.type === 'head_and_shoulders',
		);
		expect(hs?._fallback).toMatch(/relaxed_hs/);
		expect(hs?.scoreComponents?.headProminence).toBeDefined();
		// 実測突出率 = 130/105 − 1 = 0.238095。ゲートは relaxed で 0.04 × 0.6 = 0.024 まで緩むが、採点は strict の 0.04 で行う（緩めた側の閾値で採点すると「緩めたこと」が整合度に反映されない。issue #227）。
		const prominence = 130 / 105 - 1;
		expect(hs?.scoreComponents?.headProminence).toBeCloseTo(1 - 0.04 / prominence, 4);
		expect(hs?.scoreComponents?.headProminence).not.toBeCloseTo(1 - 0.024 / prominence, 3);
	});

	it('relaxed のゲートは通るが strict の突出に届かない構造は headProminence が 0 点になる（#227 Phase 2）', () => {
		// 突出率 0.238 に対し strict のゲートを 0.3 に上げる。strict では落ちるが relaxed 第 1 段（0.3 × 0.6 = 0.18）は通る。検出はされるが、突出の軸には 1 点も入らない。
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 105, head: 130 });
		const hs = detectHeadAndShoulders(
			buildCtx({ candles, pivots, tolerancePct: 0.04, headProminencePct: 0.3 }),
		).patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs?._fallback).toMatch(/relaxed_hs/);
		// strict のゲートに届かない入力であることを固定する（届いていたら 0 点の検証が空虚になる）
		expect(130 / 105 - 1).toBeLessThan(0.3);
		expect(hs?.scoreComponents?.headProminence).toBe(0);
	});

	it('逆 H&S の relaxed も突出の採点は strict の閾値で行う（#227 Phase 2）', () => {
		const { candles, pivots } = buildInverseHS({ leftShoulder: 100, rightShoulder: 105, head: 70 });
		const ihs = detectHeadAndShoulders(buildCtx({ candles, pivots, tolerancePct: 0.04 })).patterns.find(
			(p) => p.type === 'inverse_head_and_shoulders',
		);
		expect(ihs?._fallback).toMatch(/relaxed_ihs/);
		expect(ihs?.scoreComponents?.headProminence).toBeDefined();
		// 逆 H&S の突出は `1 − 頭 / min(肩)` = 1 − 70/100 = 0.30。
		const prominence = 1 - 70 / 100;
		expect(ihs?.scoreComponents?.headProminence).toBeCloseTo(1 - 0.04 / prominence, 4);
		expect(ihs?.scoreComponents?.headProminence).not.toBeCloseTo(1 - 0.024 / prominence, 3);
	});

	it('逆 H&S も relaxed のゲートは通るが strict の突出に届かなければ headProminence が 0 点（#227 Phase 2）', () => {
		// 突出 0.30 に対し strict のゲートを 0.4 に上げる。strict では落ちるが relaxed 第 1 段（0.4 × 0.6 = 0.24）は通る。
		const { candles, pivots } = buildInverseHS({ leftShoulder: 100, rightShoulder: 105, head: 70 });
		const ihs = detectHeadAndShoulders(
			buildCtx({ candles, pivots, tolerancePct: 0.04, headProminencePct: 0.4 }),
		).patterns.find((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs?._fallback).toMatch(/relaxed_ihs/);
		expect(1 - 70 / 100).toBeLessThan(0.4);
		expect(ihs?.scoreComponents?.headProminence).toBe(0);
	});

	it('肩の相対差が同じでも形が違えば confidence が変わる（rd の 1 次式が崩れている）', () => {
		const tall = buildHS({ head: 130 });
		const shallow = buildHS({ head: 108 });
		const run = (f: ReturnType<typeof buildHS>) =>
			detectHeadAndShoulders(buildCtx({ candles: f.candles, pivots: f.pivots })).patterns.find(
				(p) => p.type === 'head_and_shoulders',
			);
		const tallHs = run(tall);
		const shallowHs = run(shallow);

		expect(tallHs?.scoreComponents?.levelMargin).toBeDefined();
		expect(tallHs?.scoreComponents?.levelMargin).toBe(shallowHs?.scoreComponents?.levelMargin);
		expect(tallHs?.confidence).toBeGreaterThan(Number(shallowHs?.confidence));
	});
});
