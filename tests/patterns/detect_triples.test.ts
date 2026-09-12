import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { getHsShoulderMaxPctForTf, getSizeThresholdsForTf } from '../../tools/patterns/config.js';
import { detectTriples } from '../../tools/patterns/detect_triples.js';
import { linearRegressionWithR2 } from '../../tools/patterns/regression.js';
import type { Pivot } from '../../tools/patterns/swing.js';
import type { CandleData, DetectContext } from '../../tools/patterns/types.js';

// ── ヘルパー ──

// detect_triples.ts の BREAKOUT_BUFFER_PCT と揃える（=1.5%）。
// 丸めで閾値を割らないよう微小マージンを足し、ネックライン突破ギリギリの終値を作る。
const TEST_BREAKOUT_BUFFER_PCT = 0.015;
const TEST_BREAKOUT_MARGIN_PCT = 0.001;

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
	want?: Set<string>;
	includeForming?: boolean;
	type?: string;
}): DetectContext {
	const tol = opts.tolerancePct ?? 0.04;
	return {
		candles: opts.candles,
		pivots: opts.pivots,
		allPeaks: opts.allPeaks ?? opts.pivots.filter((p) => p.kind === 'H'),
		allValleys: opts.allValleys ?? opts.pivots.filter((p) => p.kind === 'L'),
		tolerancePct: tol,
		headProminencePct: tol,
		minDist: 5,
		want: opts.want ?? new Set(),
		includeForming: opts.includeForming ?? false,
		debugCandidates: [],
		type: opts.type ?? '1day',
		sizeThresholds: getSizeThresholdsForTf(opts.type ?? '1day'),
		hsShoulderMaxPct: getHsShoulderMaxPctForTf(opts.type ?? '1day'),
		swingDepth: 7,
		near: (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * tol,
		pct: (a: number, b: number) => ((b - a) / Math.max(1, a)) * 100,
		lrWithR2: (pts) => linearRegressionWithR2(pts),
	};
}

/**
 * Triple Top のローソク足とピボットを生成:
 * peak1(idx=0) → valley1(idx=10) → peak2(idx=20) → valley2(idx=30) → peak3(idx=40)
 *
 * 3山が等高、谷が等安、ネックライン勾配 <= 2%
 *
 * withBreakout=true のとき、peak3 以降にネックライン（谷の平均）を 1.5% 以上
 * 下抜けする終値を挿入し、完成済みパターンの検出を期待できる状態にする。
 */
function buildTripleTop(opts?: {
	peak?: number;
	valley?: number;
	peak2Price?: number;
	peak3Price?: number;
	v1Price?: number;
	v2Price?: number;
	withBreakout?: boolean;
	/**
	 * ブレイク足がネックラインを**パターン高さの何割**超えるか（issue #199）。
	 *
	 * 既定（未指定）は `BREAKOUT_BUFFER_PCT + 微小マージン`＝**判定を通るギリギリの浅さ**で、
	 * これは「ブレイクを検出させる」ためだけに選ばれた値だった。#199 で `breakoutQuality`
	 * （突破幅 ÷ パターン高さ）が整合度の軸になったため、この既定値は
	 * **軸を 0.1 前後に固定する交絡要因**になる。ブレイクの深さが主題でないテストでは
	 * ここに 1（＝高さと同じだけ抜ける）を渡し、交絡を外す。
	 */
	breakoutExcessOfHeight?: number;
}) {
	const pk = opts?.peak ?? 100;
	const pk2 = opts?.peak2Price ?? pk;
	const pk3 = opts?.peak3Price ?? pk;
	const v1 = opts?.v1Price ?? opts?.valley ?? 80;
	const v2 = opts?.v2Price ?? opts?.valley ?? 80;

	const candles: CandleData[] = [];
	for (let i = 0; i < 50; i++) candles.push(mkCandle(50 - i, 85, 90, 75, 85));
	candles[0] = mkCandle(50, pk - 1, pk, pk - 3, pk - 1);
	candles[10] = mkCandle(40, v1 + 1, v1 + 3, v1, v1 + 1);
	candles[20] = mkCandle(30, pk2 - 1, pk2, pk2 - 3, pk2 - 1);
	candles[30] = mkCandle(20, v2 + 1, v2 + 3, v2, v2 + 1);
	candles[40] = mkCandle(10, pk3 - 1, pk3, pk3 - 3, pk3 - 1);

	if (opts?.withBreakout) {
		// 谷の平均（ネックライン）を BREAKOUT_BUFFER_PCT 以上下抜けする終値
		const nlAvg = (v1 + v2) / 2;
		const marginal = Math.floor(nlAvg * (1 - TEST_BREAKOUT_BUFFER_PCT - TEST_BREAKOUT_MARGIN_PCT));
		const patternHeight = (pk + pk2 + pk3) / 3 - nlAvg;
		const breakClose =
			opts.breakoutExcessOfHeight === undefined
				? marginal
				: Math.min(marginal, Math.floor(nlAvg - patternHeight * opts.breakoutExcessOfHeight));
		for (let i = 41; i < 50; i++) {
			candles[i] = mkCandle(50 - i, breakClose, breakClose + 1, breakClose - 3, breakClose);
		}
	}

	const pivots: Pivot[] = [
		{ idx: 0, price: pk, kind: 'H', extremePrice: pk },
		{ idx: 10, price: v1, kind: 'L', extremePrice: v1 },
		{ idx: 20, price: pk2, kind: 'H', extremePrice: pk2 },
		{ idx: 30, price: v2, kind: 'L', extremePrice: v2 },
		{ idx: 40, price: pk3, kind: 'H', extremePrice: pk3 },
	];

	return { candles, pivots };
}

/**
 * Triple Bottom のローソク足とピボットを生成:
 * valley1(idx=0) → peak1(idx=10) → valley2(idx=20) → peak2(idx=30) → valley3(idx=40)
 *
 * withBreakout=true のとき、valley3 以降にネックライン（山の平均）を 1.5% 以上
 * 上抜けする終値を挿入し、完成済みパターンの検出を期待できる状態にする。
 */
function buildTripleBottom(opts?: {
	valley?: number;
	peak?: number;
	v2Price?: number;
	v3Price?: number;
	p1Price?: number;
	p2Price?: number;
	withBreakout?: boolean;
	/** {@link buildTripleTop} の同名オプションと同じ。上抜け側 */
	breakoutExcessOfHeight?: number;
}) {
	const vl = opts?.valley ?? 100;
	const v2 = opts?.v2Price ?? vl;
	const v3 = opts?.v3Price ?? vl;
	const p1 = opts?.p1Price ?? opts?.peak ?? 120;
	const p2 = opts?.p2Price ?? opts?.peak ?? 120;

	const candles: CandleData[] = [];
	for (let i = 0; i < 50; i++) candles.push(mkCandle(50 - i, 105, 115, 95, 105));
	candles[0] = mkCandle(50, vl + 1, vl + 3, vl, vl + 1);
	candles[10] = mkCandle(40, p1 - 1, p1, p1 - 3, p1 - 1);
	candles[20] = mkCandle(30, v2 + 1, v2 + 3, v2, v2 + 1);
	candles[30] = mkCandle(20, p2 - 1, p2, p2 - 3, p2 - 1);
	candles[40] = mkCandle(10, v3 + 1, v3 + 3, v3, v3 + 1);

	if (opts?.withBreakout) {
		// 山の平均（ネックライン）を BREAKOUT_BUFFER_PCT 以上上抜けする終値
		const nlAvg = (p1 + p2) / 2;
		const marginal = Math.ceil(nlAvg * (1 + TEST_BREAKOUT_BUFFER_PCT + TEST_BREAKOUT_MARGIN_PCT));
		const patternHeight = nlAvg - (vl + v2 + v3) / 3;
		const breakClose =
			opts.breakoutExcessOfHeight === undefined
				? marginal
				: Math.max(marginal, Math.ceil(nlAvg + patternHeight * opts.breakoutExcessOfHeight));
		for (let i = 41; i < 50; i++) {
			candles[i] = mkCandle(50 - i, breakClose, breakClose + 3, breakClose - 1, breakClose);
		}
	}

	const pivots: Pivot[] = [
		{ idx: 0, price: vl, kind: 'L', extremePrice: vl },
		{ idx: 10, price: p1, kind: 'H', extremePrice: p1 },
		{ idx: 20, price: v2, kind: 'L', extremePrice: v2 },
		{ idx: 30, price: p2, kind: 'H', extremePrice: p2 },
		{ idx: 40, price: v3, kind: 'L', extremePrice: v3 },
	];

	return { candles, pivots };
}

afterEach(() => {
	vi.resetAllMocks();
});

describe('detectTriples', () => {
	// ── Triple Top（完成済み）────────────────────────────────

	it('3山等高 + 等安谷 + ネックライン下抜け → triple_top completed 検出', () => {
		const { candles, pivots } = buildTripleTop({ withBreakout: true });
		const ctx = buildCtx({ candles, pivots });
		const result = detectTriples(ctx);

		const tt = result.patterns.filter((p) => p.type === 'triple_top');
		expect(tt.length).toBeGreaterThanOrEqual(1);
		expect(tt[0]?.status).toBe('completed');
		expect(tt[0]?.breakoutDirection).toBe('down');
		expect(tt[0]?.outcome).toBe('success');
		expect(tt[0]?.breakoutBarIndex).toBeDefined();
		expect(tt[0]?.confirmation).toMatchObject({ type: 'neckline_breakout' });
		expect(tt[0]?.confidence).toBeGreaterThan(0);
		expect(tt[0]?.neckline).toBeDefined();
		expect(tt[0]?.breakoutTarget).toBeDefined();
		expect(tt[0]?.targetMethod).toBe('neckline_projection');
		// #224 症状 3: pivots は主構成点 3 山 + ネックライン定義点 2 谷の 5 点（H-L-H-L-H。構造図と同じ並び）。
		expect(tt[0]?.pivots?.map((p) => p.kind)).toEqual(['H', 'L', 'H', 'L', 'H']);
		expect(tt[0]?.pivots?.every((p, i, arr) => i === 0 || p.idx > arr[i - 1].idx)).toBe(true);
		// 報告された 2 谷の price の平均が neckline の y そのもの（消費者が検算できる）。
		const valleys = tt[0]?.pivots?.filter((p) => p.kind === 'L') ?? [];
		expect(valleys).toHaveLength(2);
		expect((valleys[0].price + valleys[1].price) / 2).toBe(tt[0]?.neckline?.[0]?.y);
		expect(tt[0]?.neckline?.[1]?.y).toBe(tt[0]?.neckline?.[0]?.y);
	});

	it('Triple Top ターゲット価格 = neckline - (avgPeak - neckline)', () => {
		// nlAvg=(80+80)/2=80, avgPeak=100, target=80-(100-80)=60
		const { candles, pivots } = buildTripleTop({ peak: 100, valley: 80, withBreakout: true });
		const ctx = buildCtx({ candles, pivots });
		const result = detectTriples(ctx);

		const tt = result.patterns.find((p) => p.type === 'triple_top');
		expect(tt?.breakoutTarget).toBe(60);
	});

	it('3山構造のみ（ブレイクなし） + includeForming=true → near_completion', () => {
		const { candles, pivots } = buildTripleTop();
		const ctx = buildCtx({ candles, pivots, includeForming: true });
		const result = detectTriples(ctx);

		const tt = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'near_completion');
		expect(tt.length).toBeGreaterThanOrEqual(1);
		expect(tt[0]?.confirmation).toMatchObject({ type: 'not_confirmed' });
		expect(tt[0]?.breakoutDirection).toBeUndefined();
		expect(tt[0]?.outcome).toBeUndefined();
		expect(tt[0]?.breakoutBarIndex).toBeUndefined();
	});

	it('3山構造のみ（ブレイクなし） + includeForming=false → 未検出', () => {
		const { candles, pivots } = buildTripleTop();
		const ctx = buildCtx({ candles, pivots, includeForming: false });
		const result = detectTriples(ctx);

		const tt = result.patterns.filter((p) => p.type === 'triple_top');
		expect(tt).toHaveLength(0);
	});

	it('谷のネックライン傾斜が急すぎ → neckline_slope_excess rejected', () => {
		// v1=80, v2=82.5 → |2.5|/82.5 = 0.030 > NECKLINE_SLOPE_LIMIT(0.02)。
		// #186 以前は同じ式を tolerancePct(0.04) でも測っており（`valleysNear`）、
		// この入力は「valleysNear=true / necklineValid=false」だったので三項の else 枝に落ちていた。
		// 判定が 1 本になった今も同じコードが出る（棄却理由は入れ替わらない）。
		const { candles, pivots } = buildTripleTop({ v1Price: 80, v2Price: 82.5 });
		const ctx = buildCtx({ candles, pivots });
		detectTriples(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_top' && d.accepted === false && d.reason === 'neckline_slope_excess',
		);
		expect(rejected).toBeDefined();
	});

	it('2山目と1山目の間に谷がない → valleys_missing rejected', () => {
		// allValleys に谷を含まない（間の谷なし）
		const candles: CandleData[] = Array.from({ length: 50 }, (_, i) => mkCandle(50 - i, 90, 95, 85, 90));
		candles[0] = mkCandle(50, 99, 100, 97, 99);
		candles[20] = mkCandle(30, 99, 100, 97, 99);
		candles[40] = mkCandle(10, 99, 100, 97, 99);

		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 20, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 40, price: 100, kind: 'H', extremePrice: 100 },
		];
		// allValleys は空
		const ctx = buildCtx({ candles, pivots, allPeaks: pivots, allValleys: [] });
		detectTriples(ctx);

		const rejected = ctx.debugCandidates.find((d) => d.type === 'triple_top' && d.reason === 'valleys_missing');
		expect(rejected).toBeDefined();
	});

	// 旧名は「peaks_not_equal で通常は不検出」だったが、**`triple_top` に `peaks_not_equal` は
	// 存在したことがない**（#189 の相乗り修正）。落ちているのは 3 山の同水準判定 `nearAll` で、
	// 理由コードは `three_peaks_not_level`。`peaks_not_equal` と紛らわしい `valleys_not_equal`
	// （ネックライン側）も #186 / PR #188 で削除済み。名前だけが実態から離れていた。
	it('3山の等高差が tolerance 超 → strict は three_peaks_not_level で不検出（relaxed 由来は除外）', () => {
		// peak1=100, peak2=100, peak3=115 → nearAll fails (15/115=0.13 > 0.04)
		const { candles, pivots } = buildTripleTop({ peak: 100, peak2Price: 100, peak3Price: 115 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectTriples(ctx);

		const tt = result.patterns.filter((p) => p.type === 'triple_top' && !p._fallback);
		expect(tt).toHaveLength(0);
		// 実際に落ちた理由コードを固定する（テスト名が再び実態から離れないように）。
		expect(ctx.debugCandidates.some((d) => d.type === 'triple_top' && d.reason === 'three_peaks_not_level')).toBe(true);
	});

	// ── Triple Bottom（完成済み）────────────────────────────

	it('3谷等安 + 等高山 + ネックライン上抜け → triple_bottom completed 検出', () => {
		const { candles, pivots } = buildTripleBottom({ withBreakout: true });
		const ctx = buildCtx({ candles, pivots });
		const result = detectTriples(ctx);

		const tb = result.patterns.filter((p) => p.type === 'triple_bottom');
		expect(tb.length).toBeGreaterThanOrEqual(1);
		expect(tb[0]?.status).toBe('completed');
		expect(tb[0]?.breakoutDirection).toBe('up');
		expect(tb[0]?.outcome).toBe('success');
		expect(tb[0]?.breakoutBarIndex).toBeDefined();
		expect(tb[0]?.confirmation).toMatchObject({ type: 'neckline_breakout' });
		expect(tb[0]?.confidence).toBeGreaterThan(0);
		expect(tb[0]?.neckline).toBeDefined();
		expect(tb[0]?.breakoutTarget).toBeDefined();
		expect(tb[0]?.targetMethod).toBe('neckline_projection');
		// #224 症状 3: pivots は主構成点 3 谷 + ネックライン定義点 2 山の 5 点（L-H-L-H-L）。
		expect(tb[0]?.pivots?.map((p) => p.kind)).toEqual(['L', 'H', 'L', 'H', 'L']);
		expect(tb[0]?.pivots?.every((p, i, arr) => i === 0 || p.idx > arr[i - 1].idx)).toBe(true);
		const peaks = tb[0]?.pivots?.filter((p) => p.kind === 'H') ?? [];
		expect(peaks).toHaveLength(2);
		expect((peaks[0].price + peaks[1].price) / 2).toBe(tb[0]?.neckline?.[0]?.y);
	});

	it('Triple Bottom ターゲット価格 = neckline + (neckline - avgValley)', () => {
		// nlAvg=(120+120)/2=120, avgValley=100, target=120+(120-100)=140
		const { candles, pivots } = buildTripleBottom({ valley: 100, peak: 120, withBreakout: true });
		const ctx = buildCtx({ candles, pivots });
		const result = detectTriples(ctx);

		const tb = result.patterns.find((p) => p.type === 'triple_bottom');
		expect(tb?.breakoutTarget).toBe(140);
	});

	it('3谷構造のみ（ブレイクなし） + includeForming=true → near_completion', () => {
		const { candles, pivots } = buildTripleBottom();
		const ctx = buildCtx({ candles, pivots, includeForming: true });
		const result = detectTriples(ctx);

		const tb = result.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'near_completion');
		expect(tb.length).toBeGreaterThanOrEqual(1);
		expect(tb[0]?.confirmation).toMatchObject({ type: 'not_confirmed' });
		expect(tb[0]?.breakoutDirection).toBeUndefined();
		expect(tb[0]?.outcome).toBeUndefined();
		expect(tb[0]?.breakoutBarIndex).toBeUndefined();
	});

	it('3谷構造のみ（ブレイクなし） + includeForming=false → 未検出', () => {
		const { candles, pivots } = buildTripleBottom();
		const ctx = buildCtx({ candles, pivots, includeForming: false });
		const result = detectTriples(ctx);

		const tb = result.patterns.filter((p) => p.type === 'triple_bottom');
		expect(tb).toHaveLength(0);
	});

	it('山のネックライン傾斜が急すぎ → neckline_slope_excess rejected', () => {
		// p1=120, p2=123.7 → |3.7|/123.7 ≈ 0.030 > NECKLINE_SLOPE_LIMIT(0.02)。
		// #186 以前の `peaksNear`（tolerancePct=0.04 基準）との関係は top 側の同名テスト参照。
		const { candles, pivots } = buildTripleBottom({ p1Price: 120, p2Price: 123.7 });
		const ctx = buildCtx({ candles, pivots });
		detectTriples(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_bottom' && d.accepted === false && d.reason === 'neckline_slope_excess',
		);
		expect(rejected).toBeDefined();
	});

	it('2谷目と1谷目の間に山がない → peaks_missing rejected', () => {
		const candles: CandleData[] = Array.from({ length: 50 }, (_, i) => mkCandle(50 - i, 90, 115, 95, 100));
		candles[0] = mkCandle(50, 100, 102, 99, 100);
		candles[20] = mkCandle(30, 100, 102, 99, 100);
		candles[40] = mkCandle(10, 100, 102, 99, 100);

		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L', extremePrice: 100 },
			{ idx: 20, price: 100, kind: 'L', extremePrice: 100 },
			{ idx: 40, price: 100, kind: 'L', extremePrice: 100 },
		];
		const ctx = buildCtx({ candles, pivots, allPeaks: [], allValleys: pivots });
		detectTriples(ctx);

		const rejected = ctx.debugCandidates.find((d) => d.type === 'triple_bottom' && d.reason === 'peaks_missing');
		expect(rejected).toBeDefined();
	});

	// 旧テスト「谷スプレッド超過 → valley_spread_excess rejected」の入力をそのまま引き継ぐ。
	// `MAX_VALLEY_SPREAD`（1.5%）を削除した（#178 項目 2）ので、同じ入力が strict で受理される。
	it('谷スプレッド 3%（tolerancePct 内）→ strict で受理される', () => {
		// v1=100, v2=101, v3=103 → 価格水準基準のばらつきは (103-100)/100 = 3%。
		// - 段 1（`nearAll`）: tolerancePct = 4% 以内なので通る
		// - 段 3（`validateLevelSpread`）: 高さ 120-100=20 に対し 3/20 = 0.15 で
		//   MAX_LEVEL_SPREAD_RATIO（0.5）に遠く通る
		// 旧 `MAX_VALLEY_SPREAD` だけがこれを弾いていた。
		//
		// `breakoutExcessOfHeight` を明示するのは #199 の交絡外し。既定のギリギリのブレイクだと
		// `breakoutQuality` が 0.11 に張り付き、**谷スプレッドとは無関係な軸**で
		// `confidence_below_min` に落ちてしまう（本テストの主題は段 1 / 段 3 の水準判定）。
		const { candles, pivots } = buildTripleBottom({
			valley: 100,
			v2Price: 101,
			v3Price: 103,
			withBreakout: true,
			breakoutExcessOfHeight: 1,
		});
		const ctx = buildCtx({ candles, pivots });
		const result = detectTriples(ctx);

		expect(ctx.debugCandidates.filter((d) => d.reason === 'valley_spread_excess')).toHaveLength(0);
		const accepted = ctx.debugCandidates.find((d) => d.type === 'triple_bottom' && d.accepted === true);
		expect(accepted).toBeDefined();

		const tb = result.patterns.filter((p) => p.type === 'triple_bottom');
		expect(tb).toHaveLength(1);
		expect(tb[0]?.status).toBe('completed');
		// **strict で拾えていること**を固定する。削除前は strict が弾き relaxed fallback が
		// 同じパターンを拾い直していた（`_fallback` が付く）。同じ triple_bottom で strict の
		// ほうが厳しいという非対称は #178 項目 2 で解消済み。
		expect(tb[0]?._fallback).toBeUndefined();
	});

	it('3 点のばらつき 3% の受理は top / bottom で対称', () => {
		// `MAX_VALLEY_SPREAD` は bottom にしか無く、同形の triple_top は常に通っていた
		// （#138 確認事項 B の非対称）。削除後は両側とも strict で同じ confidence になる。
		// `breakoutExcessOfHeight` を明示する理由は直前のテストと同じ（#199 の交絡外し）。
		// 既定のギリギリのブレイクは top / bottom でパターン高さが違うぶん
		// `breakoutQuality` も違う値になり、**対称性の主張そのものが崩れる**。
		const top = buildTripleTop({
			peak: 100,
			peak2Price: 101,
			peak3Price: 103,
			withBreakout: true,
			breakoutExcessOfHeight: 1,
		});
		const bottom = buildTripleBottom({
			valley: 100,
			v2Price: 101,
			v3Price: 103,
			withBreakout: true,
			breakoutExcessOfHeight: 1,
		});
		const topCtx = buildCtx({ candles: top.candles, pivots: top.pivots });
		const bottomCtx = buildCtx({ candles: bottom.candles, pivots: bottom.pivots });

		const tt = detectTriples(topCtx).patterns.filter((p) => p.type === 'triple_top');
		const tb = detectTriples(bottomCtx).patterns.filter((p) => p.type === 'triple_bottom');
		expect(tt).toHaveLength(1);
		expect(tb).toHaveLength(1);
		expect(tb[0]?.confidence).toBe(tt[0]?.confidence);
		// **両側とも strict 由来**であることを個別に固定する。`toBe` で突き合わせるだけだと
		// 両方が relaxed に退行したケースも通ってしまい、対称性は満たすが主張が空になる。
		expect(tt[0]?._fallback).toBeUndefined();
		expect(tb[0]?._fallback).toBeUndefined();
	});

	// ── want フィルタ ────────────────────────────────────────

	it('want に triple_top のみ → triple_bottom は検出しない', () => {
		const { candles, pivots } = buildTripleBottom();
		const ctx = buildCtx({ candles, pivots, want: new Set(['triple_top']) });
		const result = detectTriples(ctx);

		const tb = result.patterns.filter((p) => p.type === 'triple_bottom');
		expect(tb).toHaveLength(0);
	});

	it('want に triple_bottom のみ → triple_top は検出しない', () => {
		const { candles, pivots } = buildTripleTop();
		const ctx = buildCtx({ candles, pivots, want: new Set(['triple_bottom']) });
		const result = detectTriples(ctx);

		const tt = result.patterns.filter((p) => p.type === 'triple_top');
		expect(tt).toHaveLength(0);
	});

	// ── Relaxed fallback ─────────────────────────────────────

	it('strict 不検出 → relaxed (x1.25) + ブレイクで Triple Top フォールバック検出', () => {
		// 24 バー（山1 idx 0 → 山3 idx 24。`periodScoreBars` の 26 本未満 = 0.8 区分）に
		// 3 山 2 谷 + ブレイクを配置。
		// peak3=105 → diff/max=5/105=0.0476 > strict(0.04) だが ≤ 0.05(x1.25) で relaxed が起動。
		const total = 32;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 75, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[6] = mkCandle(total - 6, 81, 83, 80, 81);
		candles[12] = mkCandle(total - 12, 99, 100, 97, 99);
		candles[18] = mkCandle(total - 18, 81, 83, 80, 81);
		candles[24] = mkCandle(total - 24, 104, 105, 102, 104);
		// ネックライン（=80）を 1.5% 以上下抜け
		for (let i = 25; i < total; i++) {
			candles[i] = mkCandle(total - i, 70, 71, 68, 70);
		}
		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 6, price: 80, kind: 'L', extremePrice: 80 },
			{ idx: 12, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 18, price: 80, kind: 'L', extremePrice: 80 },
			{ idx: 24, price: 105, kind: 'H', extremePrice: 105 },
		];
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectTriples(ctx);

		const tt = result.patterns.filter((p) => p.type === 'triple_top');
		expect(tt.length).toBeGreaterThanOrEqual(1);
		expect(tt[0]?._fallback).toMatch(/relaxed_triple/);
		expect(tt[0]?.status).toBe('completed');
		expect(tt[0]?.breakoutDirection).toBe('down');
		// relaxed 経路も strict と同じ 5 点（#224 症状 3）。谷 2 点の平均 = neckline の y。
		expect(tt[0]?.pivots?.map((p) => [p.idx, p.kind])).toEqual([
			[0, 'H'],
			[6, 'L'],
			[12, 'H'],
			[18, 'L'],
			[24, 'H'],
		]);
		expect(tt[0]?.neckline?.[0]?.y).toBe((80 + 80) / 2);
	});

	it('strict 不検出 → relaxed (x1.25) + ブレイクで Triple Bottom フォールバック検出', () => {
		// 24 日間に 3 谷 2 山 + ブレイクを配置。
		// valley3=95 → diff/max=5/100=0.05 > strict(0.04) だが ≤ 0.05(x1.25) で relaxed が起動。
		const total = 32;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 105, 115, 95, 105));
		candles[0] = mkCandle(total, 101, 102, 99, 101);
		candles[6] = mkCandle(total - 6, 119, 120, 118, 119);
		candles[12] = mkCandle(total - 12, 101, 102, 99, 101);
		candles[18] = mkCandle(total - 18, 119, 120, 118, 119);
		candles[24] = mkCandle(total - 24, 96, 97, 95, 96);
		// ネックライン（=120）を 1.5% 以上上抜け
		for (let i = 25; i < total; i++) {
			candles[i] = mkCandle(total - i, 132, 133, 131, 132);
		}
		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L', extremePrice: 100 },
			{ idx: 6, price: 120, kind: 'H', extremePrice: 120 },
			{ idx: 12, price: 100, kind: 'L', extremePrice: 100 },
			{ idx: 18, price: 120, kind: 'H', extremePrice: 120 },
			{ idx: 24, price: 95, kind: 'L', extremePrice: 95 },
		];
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectTriples(ctx);

		const tb = result.patterns.filter((p) => p.type === 'triple_bottom');
		expect(tb.length).toBeGreaterThanOrEqual(1);
		expect(tb[0]?._fallback).toMatch(/relaxed_triple/);
		expect(tb[0]?.status).toBe('completed');
		expect(tb[0]?.breakoutDirection).toBe('up');
		expect(tb[0]?.pivots?.map((p) => [p.idx, p.kind])).toEqual([
			[0, 'L'],
			[6, 'H'],
			[12, 'L'],
			[18, 'H'],
			[24, 'L'],
		]);
		expect(tb[0]?.neckline?.[0]?.y).toBe((120 + 120) / 2);
	});

	// ── 形成中 Triple Top ───────────────────────────────────

	it('includeForming=true + 2確定ピーク + 現在価格がピーク付近 → forming triple_top 検出', () => {
		// allPeaks: [{idx:0,100}, {idx:20,101}], allValleys: [{idx:10,80}, {idx:32,81}]
		// lastIdx=50, close=99（avgPeak=100.5 付近）
		// peak2 と現在足の間にも valley を置き、ネックライン構成点 2 つを満たす。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		candles[32] = mkCandle(total - 32, 80, 82, 80, 81);
		// 現在価格をピーク付近に設定
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 20, price: 101, kind: 'H', extremePrice: 101 },
		];
		const allValleys: Pivot[] = [
			{ idx: 10, price: 80, kind: 'L', extremePrice: 80 },
			{ idx: 32, price: 81, kind: 'L', extremePrice: 81 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming.length).toBeGreaterThanOrEqual(1);
		expect(forming[0]?.completionPct).toBeDefined();
		expect(forming[0]?.breakoutTarget).toBeDefined();
		// forming triple は confidence 上限が抑えられている（標準的扱い禁止）。
		expect(forming[0]?.confidence).toBeLessThanOrEqual(0.59);
	});

	// ── 形成中 Triple Bottom ─────────────────────────────────

	it('includeForming=true + 2確定谷 + 現在価格が谷水準に再到達 → forming triple_bottom 検出', () => {
		// allValleys: [{idx:0,100}, {idx:20,101}], allPeaks: [{idx:10,120}, {idx:32,119}]
		// lastIdx=50, close=100（valley 水準に再到達=3 谷目候補として現在価格を扱う）
		// valley2 と現在足の間にも peak を置き、ネックライン構成点 2 つを満たす。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 105, 115, 100, 110));
		candles[0] = mkCandle(total, 100, 102, 99, 101);
		candles[10] = mkCandle(total - 10, 119, 120, 118, 119);
		candles[20] = mkCandle(total - 20, 100, 102, 100, 101);
		candles[32] = mkCandle(total - 32, 118, 119, 117, 118);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 101, 103, 99, 100);
		}

		const allValleys: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L', extremePrice: 100 },
			{ idx: 20, price: 101, kind: 'L', extremePrice: 101 },
		];
		const allPeaks: Pivot[] = [
			{ idx: 10, price: 120, kind: 'H', extremePrice: 120 },
			{ idx: 32, price: 119, kind: 'H', extremePrice: 119 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'forming');
		expect(forming.length).toBeGreaterThanOrEqual(1);
		expect(forming[0]?.completionPct).toBeDefined();
		expect(forming[0]?.breakoutTarget).toBeDefined();
		// forming triple は confidence 上限が抑えられている（標準的扱い禁止）。
		expect(forming[0]?.confidence).toBeLessThanOrEqual(0.59);
	});

	// ── 形成中 Triple Top: 階段状切り上がり / 谷乖離の reject ──
	//
	// 再現シナリオ（実環境で発覚した誤検出）:
	//   peak1=11,762,787 → peak2=12,353,404 → currentPrice=12,820,448 と切り上がり、
	//   valley1=10,577,064 と valley2=12,000,002 で大きく乖離。
	//   旧実装ではこれを triple_top forming として整合度 0.71 で「標準的」扱いしていた。
	//   山と谷の水平性チェック・階段ステップチェックを入れて reject されることを検証する。

	it('forming triple_top: 3 山が単調に切り上がる場合は forming_stair_step_up で reject', () => {
		// peak1=100, peak2=100.5, currentPrice=104 → 階段状の切り上がり。
		// peakDiff=0.5/100.5=0.50%、currentDiff=3.75/100.25=3.74% で
		// tripleTolerancePct=0.04*1.2=0.048 を通過するが、stair-step ステップ
		// = (104-100)/100 = 4.0% > FORMING_STAIR_STEP_LIMIT(2%) で reject される。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 85, 90));
		candles[0] = mkCandle(total, 99, 100, 98, 99);
		candles[10] = mkCandle(total - 10, 80, 82, 79, 80);
		candles[20] = mkCandle(total - 20, 99.5, 100.5, 99, 100);
		candles[32] = mkCandle(total - 32, 80, 82, 79, 81);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 103, 105, 102, 104);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 20, price: 100.5, kind: 'H', extremePrice: 100.5 },
		];
		const allValleys: Pivot[] = [
			{ idx: 10, price: 80, kind: 'L', extremePrice: 80 },
			{ idx: 32, price: 81, kind: 'L', extremePrice: 81 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		// triple_top forming が検出されないこと（ユーザー報告の誤検出パターンの本質）
		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);
		// 階段状切り上がりが reject 理由として記録されていること
		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_top' && d.accepted === false && d.reason === 'forming_stair_step_up',
		);
		expect(rejected).toBeDefined();
	});

	// ── 形成中 Triple Top: 階段状**切り下がり**の reject（issue #263）──
	//
	// #263 以前は `triple_top` の切り上がりしか見ておらず、**単調な切り下がりは素通り**していた。
	// 実データの実例は #178 項目 1 Phase 1 の目視判定 §8 の #14（切り下がり 2.77%）/ #20。
	// 切り下がる 3 山は「レジスタンスに 3 回当たった」ではなく**下降トレンドの戻り高値の連続**。

	/**
	 * 3 山が `peak1 > peak2 > current` に並ぶ系列を組む。`currentClose` で累積ステップを動かす。
	 * 山は 100 / 99.5 固定なので `peakDiff` は 0.5% で同水準判定は常に通る。
	 */
	function descendingTopCtx(currentClose: number): DetectContext {
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 85, 90));
		candles[0] = mkCandle(total, 99, 100, 98, 100);
		candles[10] = mkCandle(total - 10, 80, 82, 79, 80);
		candles[20] = mkCandle(total - 20, 99, 100, 98, 99.5);
		candles[32] = mkCandle(total - 32, 80, 82, 79, 81);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, currentClose, currentClose + 1, currentClose - 1, currentClose);
		}
		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 20, price: 99.5, kind: 'H', extremePrice: 99.5 },
		];
		const allValleys: Pivot[] = [
			{ idx: 10, price: 80, kind: 'L', extremePrice: 80 },
			{ idx: 32, price: 81, kind: 'L', extremePrice: 81 },
		];
		return buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
	}

	it('forming triple_top: 3 山が単調に切り下がる場合は forming_stair_step_down で reject（#263）', () => {
		// peak1=100 > peak2=99.5 > current=97 の切り下がり。
		// ステップ = (100-97)/100 = 3.0% > FORMING_STAIR_STEP_LIMIT(2%) で reject。
		// peakDiff=0.5%・currentDiff=|97-99.75|/99.75=2.76% はどちらも 4.8% 以内なので、
		// **この系列を止めているのは単調性ゲートだけ**（下の対照系列が accepted になることが証拠）。
		const ctx = descendingTopCtx(97);
		const result = detectTriples(ctx);

		expect(result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming')).toHaveLength(0);
		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_top' && d.accepted === false && d.reason === 'forming_stair_step_down',
		);
		expect(rejected).toBeDefined();
		expect(rejected?.indices).toEqual([0, 20, 50]);
		// 既存の切り上がり側と同じ 3 点を積む（role 名も揃える）
		expect(rejected?.points?.map((p) => p.role)).toEqual(['peak1', 'peak2', 'current']);
	});

	it('forming triple_top: 切り下がりでもステップが上限内なら accepted のまま（#263 の最小対）', () => {
		// current=98.5 → ステップ = (100-98.5)/100 = 1.5% ≤ 2%。上のケースとの差は最新足の終値だけ。
		const ctx = descendingTopCtx(98.5);
		const result = detectTriples(ctx);

		expect(result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming')).toHaveLength(1);
		expect(
			ctx.debugCandidates.filter((d) => d.reason === 'forming_stair_step_down' || d.reason === 'forming_stair_step_up'),
		).toHaveLength(0);
	});

	it('forming triple_top: 3 山の累計 spread が tripleTolerancePct を超えると forming_peaks_not_level で reject', () => {
		// 階段ではないが（peak1 < peak2 > current で V 字）、3 点累計 spread が大きいケース。
		// peak1=100, peak2=105, current=99 → spread=(105-99)/105≈5.71% > tripleTolerancePct=4.8%。
		// 早期 peakDiff（5/105=4.76% < 4.8%）と currentDiff（3.5/102.5=3.41% < 4.8%）は通過させ、
		// stair-step も V 字配置なので発火しない → level check が確実に発火することを検証する。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 85, 90));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 104, 105, 102, 104);
		candles[32] = mkCandle(total - 32, 80, 82, 80, 81);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 20, price: 105, kind: 'H', extremePrice: 105 },
		];
		const allValleys: Pivot[] = [
			{ idx: 10, price: 80, kind: 'L', extremePrice: 80 },
			{ idx: 32, price: 81, kind: 'L', extremePrice: 81 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			tolerancePct: 0.04, // tripleTolerancePct=4.8%, levelSpreadLimit=4.8% → 5.71% で reject
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);
		// 別経路（早期 peakDiff / currentDiff silent reject）で落ちていないことを担保するため
		// 明示的に reason を assert する。
		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_top' && d.accepted === false && d.reason === 'forming_peaks_not_level',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_top: 谷の乖離が大きいと forming_neckline_not_horizontal で reject', () => {
		// 3 山は水平だが、valleys が 10.58M と 12.00M で乖離（spread = 11.83%）。
		// tolerancePct=0.04（necklineSpreadLimit=4%）→ reject。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) =>
			mkCandle(total - i, 12000000, 12200000, 11800000, 12000000),
		);
		candles[0] = mkCandle(total, 12349999, 12350000, 12349000, 12349999);
		candles[10] = mkCandle(total - 10, 10577063, 10577064, 10577000, 10577063);
		candles[20] = mkCandle(total - 20, 12350000, 12350001, 12349000, 12350000);
		candles[32] = mkCandle(total - 32, 12000001, 12000002, 12000000, 12000001);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 12350000, 12351000, 12349000, 12350000);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 12350000, kind: 'H', extremePrice: 12350000 },
			{ idx: 20, price: 12350000, kind: 'H', extremePrice: 12350000 },
		];
		const allValleys: Pivot[] = [
			{ idx: 10, price: 10577064, kind: 'L', extremePrice: 10577064 },
			{ idx: 32, price: 12000002, kind: 'L', extremePrice: 12000002 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			tolerancePct: 0.04,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_top' && d.accepted === false && d.reason === 'forming_neckline_not_horizontal',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_top: peak1 と現在足の間に valley が 1 個しかないと forming_neckline_points_insufficient で reject', () => {
		// 3 山水平、谷も水平だが valley が 1 個しかない → ネックライン構成点不足で reject。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 20, price: 101, kind: 'H', extremePrice: 101 },
		];
		const allValleys: Pivot[] = [{ idx: 10, price: 80, kind: 'L', extremePrice: 80 }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_top' && d.accepted === false && d.reason === 'forming_neckline_points_insufficient',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_top: 2 谷が両方 peak1-peak2 間にあり peak2-現在足 間に谷がない場合は reject', () => {
		// 谷の合計数は 2 だが構造的に H-L-L-H- となっており、H-L-H-L-(現在足) ではない。
		// peak1-peak2 区間内に v 2 つ、peak2-現在足 区間に v 0 つ。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[6] = mkCandle(total - 6, 79, 81, 79, 80);
		candles[14] = mkCandle(total - 14, 80, 82, 80, 81);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		// peak2(20) と lastIdx(50) の間には valley を置かない
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 20, price: 101, kind: 'H', extremePrice: 101 },
		];
		const allValleys: Pivot[] = [
			{ idx: 6, price: 80, kind: 'L', extremePrice: 80 },
			{ idx: 14, price: 81, kind: 'L', extremePrice: 81 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_top' && d.accepted === false && d.reason === 'forming_neckline_points_insufficient',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_top: 2 谷が両方 peak2-現在足 間にあり peak1-peak2 間に谷がない場合も reject', () => {
		// 対称ケース: peak1-peak2 区間に v 0 つ、peak2-現在足 区間に v 2 つ。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		candles[28] = mkCandle(total - 28, 79, 81, 79, 80);
		candles[36] = mkCandle(total - 36, 80, 82, 80, 81);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 20, price: 101, kind: 'H', extremePrice: 101 },
		];
		const allValleys: Pivot[] = [
			{ idx: 28, price: 80, kind: 'L', extremePrice: 80 },
			{ idx: 36, price: 81, kind: 'L', extremePrice: 81 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_top' && d.accepted === false && d.reason === 'forming_neckline_points_insufficient',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_top: 2 valley が両方とも peak1〜peak2 区間に偏ると forming_neckline_points_insufficient で reject', () => {
		// 合計 2 valley あるが、peak2〜現在足 区間に 1 つも valley が無い「H-L-L-H-」構造。
		// triple_top は H-L-H-L-H が必要なので、区間別に最低 1 つを要求して reject されることを検証。
		// 旧実装（valleysBetween.length >= 2 のみ）はこの構造を通してしまっていた。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[5] = mkCandle(total - 5, 79, 81, 79, 80);
		candles[15] = mkCandle(total - 15, 80, 82, 80, 81);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 20, price: 101, kind: 'H', extremePrice: 101 },
		];
		// 2 valley とも peak1(idx=0) と peak2(idx=20) の間に存在し、peak2 以降には無い
		const allValleys: Pivot[] = [
			{ idx: 5, price: 80, kind: 'L', extremePrice: 80 },
			{ idx: 15, price: 81, kind: 'L', extremePrice: 81 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_top' && d.accepted === false && d.reason === 'forming_neckline_points_insufficient',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_top: pivots は確定 2 山 + ネックライン定義点 2 谷の 4 点（H-L-H-L）で、3 山目（現在価格）は含まない', () => {
		// LLM が pivots だけ見て 3 山構造と誤読しないよう、forming は確定した主構成点（kind=H）を 2 点しか返さない。
		// ネックラインを定義する 2 谷（kind=L）は #224 症状 3 で足した——これが無いと neckline の y を検算できない。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		candles[32] = mkCandle(total - 32, 80, 82, 80, 81);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 20, price: 101, kind: 'H', extremePrice: 101 },
		];
		const allValleys: Pivot[] = [
			{ idx: 10, price: 80, kind: 'L', extremePrice: 80 },
			{ idx: 32, price: 81, kind: 'L', extremePrice: 81 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.find((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toBeDefined();
		expect(forming?.pivots?.map((p) => [p.idx, p.kind])).toEqual([
			[0, 'H'],
			[10, 'L'],
			[20, 'H'],
			[32, 'L'],
		]);
		// 主構成点（kind=H）は 2 点だけ。3 山目は現在価格の暫定値なので pivots に入らない。
		expect(forming?.pivots?.filter((p) => p.kind === 'H')).toHaveLength(2);
		// 報告された 2 谷から neckline の y が再現できる。
		expect(forming?.neckline?.[0]?.y).toBe((80 + 81) / 2);
	});

	// ── 形成中 Triple Bottom: 階段状切り下がり / 山乖離の reject（対称ケース）──

	/**
	 * 3 谷が `valley1 < valley2 < current` に並ぶ系列（issue #263。上の top の鏡像）。
	 * 谷は 100 / 100.5 固定なので `valleyDiff` は 0.5% で同水準判定は常に通る。
	 */
	function ascendingBottomCtx(currentClose: number): DetectContext {
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 105, 115, 95, 105));
		candles[0] = mkCandle(total, 101, 102, 100, 100);
		candles[10] = mkCandle(total - 10, 109, 110, 108, 109);
		candles[20] = mkCandle(total - 20, 100, 102, 100, 100.5);
		candles[32] = mkCandle(total - 32, 109, 110, 108, 109);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, currentClose, currentClose + 1, currentClose - 1, currentClose);
		}
		const allValleys: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L', extremePrice: 100 },
			{ idx: 20, price: 100.5, kind: 'L', extremePrice: 100.5 },
		];
		const allPeaks: Pivot[] = [
			{ idx: 10, price: 110, kind: 'H', extremePrice: 110 },
			{ idx: 32, price: 110, kind: 'H', extremePrice: 110 },
		];
		return buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
	}

	it('forming triple_bottom: 3 谷が単調に切り上がる場合は forming_stair_step_up で reject（#263）', () => {
		// valley1=100 < valley2=100.5 < current=103 の切り上がり。
		// ステップ = (103-100)/100 = 3.0% > FORMING_STAIR_STEP_LIMIT(2%) で reject。
		// valleyDiff=0.5%・currentDiff=|103-100.25|/100.25=2.74% はどちらも 4.8% 以内。
		const ctx = ascendingBottomCtx(103);
		const result = detectTriples(ctx);

		expect(result.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'forming')).toHaveLength(0);
		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_bottom' && d.accepted === false && d.reason === 'forming_stair_step_up',
		);
		expect(rejected).toBeDefined();
		expect(rejected?.indices).toEqual([0, 20, 50]);
		expect(rejected?.points?.map((p) => p.role)).toEqual(['valley1', 'valley2', 'current']);
	});

	it('forming triple_bottom: 切り上がりでもステップが上限内なら accepted のまま（#263 の最小対）', () => {
		// current=101.5 → ステップ = (101.5-100)/100 = 1.5% ≤ 2%。差は最新足の終値だけ。
		const ctx = ascendingBottomCtx(101.5);
		const result = detectTriples(ctx);

		expect(result.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'forming')).toHaveLength(1);
		expect(
			ctx.debugCandidates.filter((d) => d.reason === 'forming_stair_step_down' || d.reason === 'forming_stair_step_up'),
		).toHaveLength(0);
	});

	it('forming triple_bottom: 3 谷が単調に切り下がる場合は forming_stair_step_down で reject', () => {
		// triple_top の対称: valley1=102, valley2=100, currentPrice=99 → 切り下がり。
		// 全体ステップ = (102-99)/102 ≈ 2.94% で FORMING_STAIR_STEP_LIMIT=2% を超過。
		// 早期 valleyDiff（|102-100|/102 = 1.96%）と currentDiff（|99-101|/101 = 1.98%）は
		// tripleTolerancePct=4.8% 以下で通過するため、stair-step で reject されることを検証。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 105, 115, 95, 105));
		candles[0] = mkCandle(total, 101, 102, 100, 102);
		candles[10] = mkCandle(total - 10, 109, 110, 108, 109);
		candles[20] = mkCandle(total - 20, 99, 101, 99, 100);
		candles[32] = mkCandle(total - 32, 109, 110, 108, 109);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 99, 101, 98, 99);
		}

		const allValleys: Pivot[] = [
			{ idx: 0, price: 102, kind: 'L', extremePrice: 102 },
			{ idx: 20, price: 100, kind: 'L', extremePrice: 100 },
		];
		const allPeaks: Pivot[] = [
			{ idx: 10, price: 110, kind: 'H', extremePrice: 110 },
			{ idx: 32, price: 110, kind: 'H', extremePrice: 110 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'forming');
		expect(forming).toHaveLength(0);
		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_bottom' && d.accepted === false && d.reason === 'forming_stair_step_down',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_bottom: 山の乖離が大きいと forming_neckline_not_horizontal で reject', () => {
		// 3 谷は水平だが、ネックライン構成 peak が大きく乖離（例: 110 と 130）。
		// spread=(130-110)/130 ≈ 15.4% > necklineSpreadLimit=4% → reject。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 105, 115, 95, 105));
		candles[0] = mkCandle(total, 100, 102, 99, 101);
		candles[10] = mkCandle(total - 10, 109, 110, 108, 109);
		candles[20] = mkCandle(total - 20, 100, 102, 99, 101);
		candles[32] = mkCandle(total - 32, 129, 130, 128, 129);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 114, 116, 113, 115);
		}

		const allValleys: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L', extremePrice: 100 },
			{ idx: 20, price: 100, kind: 'L', extremePrice: 100 },
		];
		const allPeaks: Pivot[] = [
			{ idx: 10, price: 110, kind: 'H', extremePrice: 110 },
			{ idx: 32, price: 130, kind: 'H', extremePrice: 130 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_bottom' && d.accepted === false && d.reason === 'forming_neckline_not_horizontal',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_bottom: valley1 と現在足の間に peak が 1 個しかないと forming_neckline_points_insufficient で reject', () => {
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 105, 115, 100, 110));
		candles[0] = mkCandle(total, 100, 102, 99, 101);
		candles[10] = mkCandle(total - 10, 119, 120, 118, 119);
		candles[20] = mkCandle(total - 20, 100, 102, 100, 101);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 114, 116, 113, 115);
		}

		const allValleys: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L', extremePrice: 100 },
			{ idx: 20, price: 101, kind: 'L', extremePrice: 101 },
		];
		const allPeaks: Pivot[] = [{ idx: 10, price: 120, kind: 'H', extremePrice: 120 }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_bottom' && d.accepted === false && d.reason === 'forming_neckline_points_insufficient',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_bottom: 2 山が両方 valley1-valley2 間にあり valley2-現在足 間に山がない場合は reject', () => {
		// 山の合計数は 2 だが構造的に L-H-H-L- となっており、L-H-L-H-(現在足) ではない。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 105, 115, 100, 110));
		candles[0] = mkCandle(total, 100, 102, 99, 101);
		candles[6] = mkCandle(total - 6, 119, 120, 118, 119);
		candles[14] = mkCandle(total - 14, 118, 119, 117, 118);
		candles[20] = mkCandle(total - 20, 100, 102, 100, 101);
		// valley2(20) と lastIdx(50) の間には peak を置かない
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 101, 103, 99, 100);
		}

		const allValleys: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L', extremePrice: 100 },
			{ idx: 20, price: 101, kind: 'L', extremePrice: 101 },
		];
		const allPeaks: Pivot[] = [
			{ idx: 6, price: 120, kind: 'H', extremePrice: 120 },
			{ idx: 14, price: 119, kind: 'H', extremePrice: 119 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_bottom' && d.accepted === false && d.reason === 'forming_neckline_points_insufficient',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_bottom: 2 山が両方 valley2-現在足 間にあり valley1-valley2 間に山がない場合も reject', () => {
		// 対称ケース: valley1-valley2 区間に p 0 つ、valley2-現在足 区間に p 2 つ。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 105, 115, 100, 110));
		candles[0] = mkCandle(total, 100, 102, 99, 101);
		candles[20] = mkCandle(total - 20, 100, 102, 100, 101);
		candles[28] = mkCandle(total - 28, 119, 120, 118, 119);
		candles[36] = mkCandle(total - 36, 118, 119, 117, 118);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 101, 103, 99, 100);
		}

		const allValleys: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L', extremePrice: 100 },
			{ idx: 20, price: 101, kind: 'L', extremePrice: 101 },
		];
		const allPeaks: Pivot[] = [
			{ idx: 28, price: 120, kind: 'H', extremePrice: 120 },
			{ idx: 36, price: 119, kind: 'H', extremePrice: 119 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_bottom' && d.accepted === false && d.reason === 'forming_neckline_points_insufficient',
		);
		expect(rejected).toBeDefined();
	});

	it('forming triple_bottom: pivots は確定 2 谷 + ネックライン定義点 2 山の 4 点（L-H-L-H）で、3 谷目（現在価格）は含まない', () => {
		// 現在価格を valley 水準に置き、forming triple_bottom として検出させる。
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 105, 115, 100, 110));
		candles[0] = mkCandle(total, 100, 102, 99, 101);
		candles[10] = mkCandle(total - 10, 119, 120, 118, 119);
		candles[20] = mkCandle(total - 20, 100, 102, 100, 101);
		candles[32] = mkCandle(total - 32, 118, 119, 117, 118);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 101, 103, 99, 100);
		}

		const allValleys: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L', extremePrice: 100 },
			{ idx: 20, price: 101, kind: 'L', extremePrice: 101 },
		];
		const allPeaks: Pivot[] = [
			{ idx: 10, price: 120, kind: 'H', extremePrice: 120 },
			{ idx: 32, price: 119, kind: 'H', extremePrice: 119 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.find((p) => p.type === 'triple_bottom' && p.status === 'forming');
		expect(forming).toBeDefined();
		expect(forming?.pivots?.map((p) => [p.idx, p.kind])).toEqual([
			[0, 'L'],
			[10, 'H'],
			[20, 'L'],
			[32, 'H'],
		]);
		expect(forming?.pivots?.filter((p) => p.kind === 'L')).toHaveLength(2);
		expect(forming?.neckline?.[0]?.y).toBe((120 + 119) / 2);
	});

	it('includeForming=false では forming / near_completion パターンは返さない', () => {
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		for (let i = 45; i < total; i++) candles[i] = mkCandle(total - i, 98, 100, 97, 99);

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 20, price: 101, kind: 'H', extremePrice: 101 },
		];
		const allValleys: Pivot[] = [{ idx: 10, price: 80, kind: 'L', extremePrice: 80 }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: false,
		});
		const result = detectTriples(ctx);

		const unfinished = result.patterns.filter((p) => p.status === 'forming' || p.status === 'near_completion');
		expect(unfinished).toHaveLength(0);
	});

	// ── 間隔不足 ─────────────────────────────────────────────

	it('H ピーク間隔 < minDist(5) → triple_top スキップ', () => {
		// highsOnly が [idx=0, idx=3, idx=6] → b.idx-a.idx=3 < 5 → continue
		const candles: CandleData[] = Array.from({ length: 15 }, (_, i) => mkCandle(15 - i, 85, 95, 75, 85));
		candles[0] = mkCandle(15, 99, 100, 97, 99);
		candles[3] = mkCandle(12, 99, 100, 97, 99);
		candles[6] = mkCandle(9, 99, 100, 97, 99);

		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 3, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 6, price: 100, kind: 'H', extremePrice: 100 },
		];
		const ctx = buildCtx({ candles, pivots, allPeaks: pivots, allValleys: [] });
		const result = detectTriples(ctx);
		const tt = result.patterns.filter((p) => p.type === 'triple_top');
		expect(tt).toHaveLength(0);
	});

	// ── 形成中の形成バー数レンジ（時間軸スケーリング）──────────────
	//
	// 判定のプリミティブは**バー数**（`patterns/bar-thresholds.ts`）。
	//   formationBars ∈ [minBars, maxBars]
	//   minBars = clamp(round(21 × barsPerDay), 構造的下限, 構造的下限 × 2)
	//   maxBars = minBars × (90 / 21)
	// 日数（21日 / 90日）は値の出どころを示す注記でしかない。時間足ごとの実効レンジ:
	//   1hour  → [34, 146]
	//   1week  → [25, 107]
	//   1month → [29, 124]
	//
	// これ以前は patternDays = Math.round(formationBars × daysPerBar) を 21〜90 日で
	// 判定していたため、1hour は 492 本、1min は 29520 本の形成を要求し、`limit` の
	// スキーマ上限（365）でも到達不能だった（issue #118 問題 2）。

	it('1hour: 30 バーの形成は下限（34 本）を割るので形成中 triple_top にならない', () => {
		// 1hour の形成バー数レンジは [34, 146]。formationBars = 30 は下限に 4 本足りない。
		// 旧実装（日数判定）では 30 バー ≈ 1.25 日 < 21 日 で弾いていた——結論は同じだが、
		// 「1時間足で 21 暦日ぶんの形成」を要求しなくなったぶん下限は 492 本 → 34 本に下がっている。
		const total = 31;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		for (let i = 28; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 20, price: 101, kind: 'H', extremePrice: 101 },
		];
		const allValleys: Pivot[] = [{ idx: 10, price: 80, kind: 'L', extremePrice: 80 }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1hour',
		});
		const result = detectTriples(ctx);

		// 1.25 日相当 < FORMING_MIN_DAYS(21) なので form は弾かれる（intraday の短期間判定）
		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);
	});

	it('1hour: 119 バーの形成なら形成中 triple_top のレンジ判定を通過する', () => {
		// レンジ [34, 146] の**上側**が効いていることの確認。formationBars = 119 は
		// 旧実装が要求していた 492 本（= 21 暦日）を大きく下回るが、新しい上限 146 には収まる。
		// この fixture は 120 本あり既定 limit（90）を超えるので、**到達性の検証ではない**——
		// 既定 limit で実際に検出できることは tests/patterns/default-limit-detection.test.ts が固定する。
		const total = 120;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		// 2 つ確定済みピークと 2 つの確定済み谷（ネックライン構成）
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[50] = mkCandle(total - 50, 79, 81, 79, 80);
		candles[100] = mkCandle(total - 100, 100, 101, 99, 100);
		candles[110] = mkCandle(total - 110, 80, 82, 80, 81);
		for (let i = total - 5; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 100, price: 101, kind: 'H', extremePrice: 101 },
		];
		const allValleys: Pivot[] = [
			{ idx: 50, price: 80, kind: 'L', extremePrice: 80 },
			{ idx: 110, price: 81, kind: 'L', extremePrice: 81 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1hour',
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming.length).toBeGreaterThanOrEqual(1);
	});

	it('1week: 4 バーの形成は下限（25 本）を割るので形成中 triple_top にならない', () => {
		// 旧実装では 4 バー × 7 日/バー = 28 日 ∈ [21, 90] で日数判定は通り、
		// minDist=5 を満たせないという構造条件だけで落ちていた。
		// バー数判定では下限 25 本にも 21 本足りない——「週足 4 本の三尊」を
		// 期間として認めていた旧閾値（3 本相当）が構造的下限まで引き上がったため。
		const total = 7;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[2] = mkCandle(total - 2, 79, 81, 79, 80);
		candles[4] = mkCandle(total - 4, 100, 101, 99, 100);
		for (let i = 6; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 4, price: 101, kind: 'H', extremePrice: 101 },
		];
		const allValleys: Pivot[] = [{ idx: 2, price: 80, kind: 'L', extremePrice: 80 }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1week',
		});
		const result = detectTriples(ctx);

		// minDist(5) > 4 なのでスキップされる
		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);
	});

	it('1week: 29 バーの形成で形成中 triple_top がレンジ判定を通過する', () => {
		// formationBars = 29 ∈ [25, 107]。下限は 1week の構造的下限（25 本）由来で、
		// 旧実装の 3 本（21 日 ÷ 7 日/バー）は minDist=5 の 3 ピボットすら張れない値だった。
		// 構造制約: confirmedPeaks フィルタ idx < lastIdx-2 と minDist=5 を両立させ、
		// ネックライン構成点を peak1-peak2 間と peak2-現在足 間に 1 つずつ置く。
		const total = 30;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		candles[26] = mkCandle(total - 26, 80, 82, 80, 81);
		for (let i = 27; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 20, price: 101, kind: 'H', extremePrice: 101 },
		];
		const allValleys: Pivot[] = [
			{ idx: 10, price: 80, kind: 'L', extremePrice: 80 },
			{ idx: 26, price: 81, kind: 'L', extremePrice: 81 },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1week',
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming.length).toBeGreaterThanOrEqual(1);
	});

	it('1month: 6 バーの形成は下限（29 本）を割るので形成中 triple_top にならない', () => {
		// 1month の形成バー数レンジは [29, 124]。formationBars = 6 は下限を割る。
		// 旧実装では 6 バー × 30 日/バー = 180 日 > FORMING_MAX_DAYS(90) の**上限**超過で
		// 落ちていた。バー数判定では月足でも「形が成立するだけの本数」を下限として要求する。
		const total = 7;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[2] = mkCandle(total - 2, 79, 81, 79, 80);
		candles[4] = mkCandle(total - 4, 100, 101, 99, 100);
		for (let i = 6; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 4, price: 101, kind: 'H', extremePrice: 101 },
		];
		const allValleys: Pivot[] = [{ idx: 2, price: 80, kind: 'L', extremePrice: 80 }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1month',
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);
	});

	it('1month vs 1day: 同一バー数（25 本）なら 1day では検出されるが 1month では弾かれる（daysPerBar の効果）', () => {
		// 旧コード（1month → daysPerBar=1）では、type='1month' でも 1day と同じ
		// patternDays=25 と評価して誤って検出していた。
		// 新コードでは daysPerBar(1month)=30 を介して patternDays=750 と評価し、
		// FORMING_MAX_DAYS=90 を超えるため正しく拒否される。
		// ネックライン構成点 2 つを満たすため valley を 2 つ配置。
		const total = 26;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		candles[22] = mkCandle(total - 22, 80, 82, 80, 81);
		for (let i = 23; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
			{ idx: 20, price: 101, kind: 'H', extremePrice: 101 },
		];
		const allValleys: Pivot[] = [
			{ idx: 10, price: 80, kind: 'L', extremePrice: 80 },
			{ idx: 22, price: 81, kind: 'L', extremePrice: 81 },
		];

		const ctx1day = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1day',
		});
		const ctx1month = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1month',
		});
		const result1day = detectTriples(ctx1day);
		const result1month = detectTriples(ctx1month);

		const forming1day = result1day.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		const forming1month = result1month.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');

		expect(forming1day.length).toBeGreaterThanOrEqual(1);
		expect(forming1month).toHaveLength(0);
	});
	// ── #186: ネックライン水平性の判定を NECKLINE_SLOPE_LIMIT 1 本に畳んだ ──────────

	/**
	 * strict は同じ 2 点（top なら 2 谷、bottom なら 2 山）を `tolerancePct` と
	 * `NECKLINE_SLOPE_LIMIT` の**完全に同一の式**で 2 回測っていた。`tolerancePct` の
	 * 時間軸オートはすべて 0.03 以上なので既定パスでは常に `NECKLINE_SLOPE_LIMIT`（0.02）が
	 * 律速し、`valleys_not_equal` / `peaks_not_equal` は「`tolerancePct` を緩めれば通る」と
	 * 読めるのに実際には通らない——**間違ったつまみを指す理由コード**だった。
	 *
	 * 判定を 1 本にしたので、strict 由来の `valleys_not_equal` / `peaks_not_equal` は消える。
	 * `double_top` / `double_bottom`（`detect_doubles.ts`）と relaxed 経路の
	 * `*_relaxed` は別のコードなので**対象外**。
	 */
	describe('#186 strict のネックライン判定は NECKLINE_SLOPE_LIMIT の 1 本', () => {
		it('strict の triple_top は valleys_not_equal を返さない（理由コードの削除）', () => {
			// 傾き 3%（> 0.02）。#186 以前は valleysNear=true 側なので else 枝
			// （neckline_slope_excess）だったが、tolerancePct を 0.02 未満にすると
			// 同じ入力が valleys_not_equal に化けていた（＝ラベルだけが変わる）。
			for (const tol of [0.04, 0.01]) {
				const { candles, pivots } = buildTripleTop({ v1Price: 80, v2Price: 82.5 });
				const ctx = buildCtx({ candles, pivots, tolerancePct: tol });
				detectTriples(ctx);

				expect(
					ctx.debugCandidates.filter((d) => d.type === 'triple_top' && d.reason === 'valleys_not_equal'),
				).toHaveLength(0);
				expect(
					ctx.debugCandidates.filter((d) => d.type === 'triple_top' && d.reason === 'neckline_slope_excess').length,
				).toBeGreaterThanOrEqual(1);
			}
		});

		it('strict の triple_bottom は peaks_not_equal を返さない（理由コードの削除）', () => {
			for (const tol of [0.04, 0.01]) {
				const { candles, pivots } = buildTripleBottom({ p1Price: 120, p2Price: 123.7 });
				const ctx = buildCtx({ candles, pivots, tolerancePct: tol });
				detectTriples(ctx);

				expect(
					ctx.debugCandidates.filter((d) => d.type === 'triple_bottom' && d.reason === 'peaks_not_equal'),
				).toHaveLength(0);
				expect(
					ctx.debugCandidates.filter((d) => d.type === 'triple_bottom' && d.reason === 'neckline_slope_excess').length,
				).toBeGreaterThanOrEqual(1);
			}
		});

		/**
		 * **判定が緩む唯一の範囲を固定する。**
		 *
		 * 旧実装の実効上限は `min(tolerancePct, NECKLINE_SLOPE_LIMIT)`、新実装は
		 * `NECKLINE_SLOPE_LIMIT` なので、**`tolerancePct < 0.02` を明示したときだけ緩む**。
		 * スキーマは `min(0)` なので指定自体は可能だが、時間軸オート（最小 0.03）では到達しない。
		 *
		 * ここで固定するのは「strict が受理すること」。**tool 表面の `data.patterns` に
		 * 出るかどうかは変わらない**——旧実装でも strict が弾いた直後に relaxed fallback
		 * （`relaxed_triple_x1.25`）が同じ 3 点を拾い直していた。変わるのは confidence で、
		 * relaxed の 0.95 倍のペナルティが外れて上がる。
		 */
		it('tolerancePct=0.01（< 0.02）: ネックライン傾き 1.48% の triple_top を strict が受理する', () => {
			// v1=80, v2=81.2 → |1.2|/81.2 ≈ 0.0148 ∈ (0.01, 0.02]
			const { candles, pivots } = buildTripleTop({ v1Price: 80, v2Price: 81.2, withBreakout: true });
			const ctx = buildCtx({ candles, pivots, tolerancePct: 0.01 });
			const result = detectTriples(ctx);

			// 旧実装ではここが `valleys_not_equal` の棄却だった
			const accepted = ctx.debugCandidates.find((d) => d.type === 'triple_top' && d.accepted === true);
			expect(accepted).toBeDefined();

			const tt = result.patterns.filter((p) => p.type === 'triple_top');
			expect(tt).toHaveLength(1);
			expect(tt[0]?.status).toBe('completed');
			// strict 由来なので relaxed fallback のマーカーが付かない
			expect(tt[0]?._fallback).toBeUndefined();
		});

		it('tolerancePct=0.01（< 0.02）: ネックライン傾き 1.48% の triple_bottom を strict が受理する', () => {
			// p1=120, p2=121.8 → |1.8|/121.8 ≈ 0.0148 ∈ (0.01, 0.02]
			const { candles, pivots } = buildTripleBottom({ p1Price: 120, p2Price: 121.8, withBreakout: true });
			const ctx = buildCtx({ candles, pivots, tolerancePct: 0.01 });
			const result = detectTriples(ctx);

			const accepted = ctx.debugCandidates.find((d) => d.type === 'triple_bottom' && d.accepted === true);
			expect(accepted).toBeDefined();

			const tb = result.patterns.filter((p) => p.type === 'triple_bottom');
			expect(tb).toHaveLength(1);
			expect(tb[0]?.status).toBe('completed');
			expect(tb[0]?._fallback).toBeUndefined();
		});

		/**
		 * **`tolerancePct >= 0.02` では何も変わらない**ことの境界固定。
		 * 旧実装の実効上限 `min(tolerancePct, 0.02)` は `tolerancePct = 0.02` で新実装と一致する。
		 * 傾き 1.48%（< 0.02）は受理、2.5%（> 0.02）は棄却で、`tolerancePct` を 0.02 から
		 * 上げても下限は 0.02 のまま動かない。
		 */
		it('tolerancePct=0.02 / 0.06: 律速は常に NECKLINE_SLOPE_LIMIT（緩まない・締まらない）', () => {
			for (const tol of [0.02, 0.06]) {
				const pass = buildTripleTop({ v1Price: 80, v2Price: 81.2, withBreakout: true });
				const ctxPass = buildCtx({ candles: pass.candles, pivots: pass.pivots, tolerancePct: tol });
				detectTriples(ctxPass);
				expect(ctxPass.debugCandidates.some((d) => d.type === 'triple_top' && d.accepted === true)).toBe(true);

				const fail = buildTripleTop({ v1Price: 80, v2Price: 82.5, withBreakout: true });
				const ctxFail = buildCtx({ candles: fail.candles, pivots: fail.pivots, tolerancePct: tol });
				detectTriples(ctxFail);
				expect(
					ctxFail.debugCandidates.some((d) => d.type === 'triple_top' && d.reason === 'neckline_slope_excess'),
				).toBe(true);
			}
		});
	});

	// ── #199 候補 1: confidence の多軸化 ──────────────────────

	describe('#199 confidence の多軸化（symmetry を捨てて retracement / breakoutQuality を足す）', () => {
		it('完成済み triple は scoreComponents を出し、double 用の symmetry は含まない', () => {
			const { candles, pivots } = buildTripleTop({ withBreakout: true, breakoutExcessOfHeight: 1 });
			const result = detectTriples(buildCtx({ candles, pivots }));

			const tt = result.patterns.find((p) => p.type === 'triple_top');
			expect(tt?.scoreComponents).toBeDefined();
			// `symmetry` は「2 点の生の relDev」で double の軸。triple は許容幅で正規化した
			// `levelMargin` を使う（`.claude/rules/tools.md` 規約 7: 同じ語の意味を差し替えない）。
			expect(tt?.scoreComponents).not.toHaveProperty('symmetry');
			expect(tt?.scoreComponents?.levelMargin).toBe(1); // 3 山とも 100
			expect(tt?.scoreComponents?.breakoutQuality).toBe(1); // 高さと同じだけ抜けている
			expect(tt?.scoreComponents?.duration).toBeGreaterThan(0);
		});

		it('未ブレイク（near_completion）では breakoutQuality を出さない — 欠測を 0 として混ぜない', () => {
			const { candles, pivots } = buildTripleTop();
			const result = detectTriples(buildCtx({ candles, pivots, includeForming: true }));

			const tt = result.patterns.find((p) => p.type === 'triple_top' && p.status === 'near_completion');
			expect(tt).toBeDefined();
			expect(tt?.scoreComponents).not.toHaveProperty('breakoutQuality');
			expect(tt?.scoreComponents?.levelMargin).toBe(1);
		});

		it('breakoutQuality は浅いブレイクと深いブレイクを区別する（旧式では同点だった）', () => {
			const shallow = buildTripleTop({ withBreakout: true });
			const deep = buildTripleTop({ withBreakout: true, breakoutExcessOfHeight: 1 });
			const shallowTt = detectTriples(buildCtx({ candles: shallow.candles, pivots: shallow.pivots })).patterns.find(
				(p) => p.type === 'triple_top',
			);
			const deepTt = detectTriples(buildCtx({ candles: deep.candles, pivots: deep.pivots })).patterns.find(
				(p) => p.type === 'triple_top',
			);

			// 3 山も谷も同じで、違うのはブレイク足の終値だけ。
			expect(shallowTt?.scoreComponents?.levelMargin).toBe(deepTt?.scoreComponents?.levelMargin);
			expect(shallowTt?.scoreComponents?.duration).toBe(deepTt?.scoreComponents?.duration);
			expect(shallowTt?.scoreComponents?.breakoutQuality).toBeLessThan(0.2);
			expect(deepTt?.scoreComponents?.breakoutQuality).toBe(1);
			expect(Number(deepTt?.confidence)).toBeGreaterThan(Number(shallowTt?.confidence));
		});

		it('levelMargin はその経路の許容幅で正規化する（同じ 3 点でも tolerancePct が変われば変わる）', () => {
			const { candles, pivots } = buildTripleTop({
				peak: 100,
				peak2Price: 102,
				peak3Price: 104,
				withBreakout: true,
				breakoutExcessOfHeight: 1,
			});
			// 3 ペアの relDev 平均 = (2/102 + 2/104 + 4/104) / 3 ≈ 0.02577
			const tight = detectTriples(buildCtx({ candles, pivots, tolerancePct: 0.04 })).patterns.find(
				(p) => p.type === 'triple_top',
			);
			const loose = detectTriples(buildCtx({ candles, pivots, tolerancePct: 0.08 })).patterns.find(
				(p) => p.type === 'triple_top',
			);

			expect(tight?.scoreComponents?.levelMargin).toBeCloseTo(1 - 0.02577 / 0.04, 3);
			expect(loose?.scoreComponents?.levelMargin).toBeCloseTo(1 - 0.02577 / 0.08, 3);
		});

		it('confidence_below_min は details に confidence / 閾値 / 軸の内訳を載せる', () => {
			// 3 山 100 / 102 / 104（levelMargin 0.36）+ 浅いブレイク（breakoutQuality 0.09）で
			// 0.6 を割る。谷は 80 なので押しの深さ・パターン高さ・水準ばらつきはすべて通る。
			const { candles, pivots } = buildTripleTop({ peak: 100, peak2Price: 102, peak3Price: 104, withBreakout: true });
			const ctx = buildCtx({ candles, pivots });
			detectTriples(ctx);

			const rejected = ctx.debugCandidates.find((d) => d.type === 'triple_top' && d.reason === 'confidence_below_min');
			expect(rejected).toBeDefined();
			const details = rejected?.details as Record<string, number> | undefined;
			expect(details?.threshold).toBe(0.6);
			expect(details?.confidence).toBeLessThan(0.6);
			// 閾値を再検討するには「何の軸でいくつ落ちたか」が要る（#199）。
			expect(details?.levelMargin).toBeCloseTo(0.3558, 3);
			expect(details?.breakoutQuality).toBeGreaterThan(0);
		});

		/**
		 * 判定順の変更（#199）。`breakoutQuality` がブレイク足の終値を要るので、confidence の
		 * 算出は `validatePatternSize` / 構造ゲート / `validateLevelSpread` より後ろに移った。
		 *
		 * その結果 **`confidence_below_min` は固有の理由コードを横取りしなくなる**
		 * （`validatePatternSize` の docstring が言う原則どおり。汎用的な理由を後ろに置く）。
		 */
		it('固有のゲートと confidence の両方に該当する候補は、固有の理由コードを返す', () => {
			// 谷を 97 にすると押しの深さ 3.96% < depthPct(1day = 5%) で `valley_too_shallow`。
			const shallow = buildTripleTop({
				peak: 100,
				peak2Price: 102,
				peak3Price: 104,
				v1Price: 97,
				v2Price: 97,
				withBreakout: true,
			});
			const shallowCtx = buildCtx({ candles: shallow.candles, pivots: shallow.pivots });
			detectTriples(shallowCtx);
			const shallowCands = shallowCtx.debugCandidates.filter((d) => d.type === 'triple_top' && !d.accepted);
			expect(shallowCands.map((d) => d.reason)).toContain('valley_too_shallow');
			expect(shallowCands.map((d) => d.reason)).not.toContain('confidence_below_min');

			// **同じ 3 山**で谷だけ深くすると、サイズ検査を通って confidence で落ちる
			// ——つまり上のケースは「confidence でも落ちる候補」であり、順序の入れ替わりを
			// 見ていることの証明になる（片方だけだと「そもそも confidence は足りていた」を排除できない）。
			const deepValley = buildTripleTop({
				peak: 100,
				peak2Price: 102,
				peak3Price: 104,
				withBreakout: true,
			});
			const deepCtx = buildCtx({ candles: deepValley.candles, pivots: deepValley.pivots });
			detectTriples(deepCtx);
			expect(
				deepCtx.debugCandidates.filter((d) => d.type === 'triple_top' && !d.accepted).map((d) => d.reason),
			).toContain('confidence_below_min');
		});
	});
});
