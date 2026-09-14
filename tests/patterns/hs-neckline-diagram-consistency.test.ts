/**
 * H&S / 逆 H&S の**構造図 SVG のネックラインラベル**が、同じ 1 件の出力の中の
 * 他のネックライン水準と食い違わないことを固定する（issue #226）。
 *
 * ## 何が壊れていたか
 *
 * relaxed 経路は水平ネックライン `nlY` を組み、ブレイク判定（`findHsBreakoutIdx`）・
 * 構造ゲート・ターゲット・出力フィールド（`neckline`）のすべてに使っている。ところが
 * 構造図にだけ **その経路では他に一切消費されていない** `nlAvg`
 * （＝ 2 定義点 `p1` / `p3` の平均）を渡していた。実測（`btc_jpy` / `1hour` /
 * `_fallback: relaxed_hs_x2.0_0.4` / 構成点 idx `[29,36,39,43,48]`）では
 * content 本文行 12,481,701 円に対し構造図だけが 12,509,065 円で、差 27,364 円。
 *
 * **欠陥は 2 層にまたがっていた**。呼び出し側（`detect_hs.ts`）が `nlAvg` を渡していただけでなく、
 * `generatePatternDiagram`（`lib/pattern-diagrams.ts`）が H&S / 逆 H&S に限って
 * **引数 `neckline.price` を読まず、`pivots[1]` / `pivots[3]` の平均を自前で再計算していた**。
 * 呼び出し側だけを直しても SVG は 1 文字も変わらない（再計算が値を上書きするため）ので、
 * 本テストは**両層を通した実際の SVG 文字列**を検査する。
 *
 * ## 判定は 1 つも変えていない
 *
 * `nlY` は `findHsBreakoutIdx` に渡す線の y そのもので、そちらへ寄せるとブレイク判定・
 * 検出結果が動く。本 issue は表示層のみの欠陥なので、直したのは
 * 「構造図に渡す / 構造図が読む値」だけ。
 *
 * ## strict 経路は `nlAvg` 据え置き
 *
 * strict の `neckline` は `[{x:p1.idx,y:p1.price},{x:p3.idx,y:p3.price}]` ＝ **傾きつきの線**で、
 * スカラー 1 つでは表せない。`nlAvg` はその代表値として筋が通り、構造ゲート
 * （`applyReversalGate`）と `fallbackNecklinePrice` でも同じ値が使われている。
 * **誤って strict まで `neckline[0].y` に寄せる変更**を止めるため、strict のラベルが
 * 2 定義点の平均であることも併せて固定する。
 *
 * ## 既存テストがこの欠陥を捕まえられなかった理由
 *
 * `tests/detect_patterns_data_patterns_regression.test.ts` は `structureDiagram` を
 * `artifact.identifier` だけに畳んで比較しており（tz 修正で意図的に変わる svg / title を
 * 落とすため）、**SVG の中身は誰も検査していない**。
 */
import { describe, expect, it } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { generatePatternDiagram } from '../../lib/pattern-diagrams.js';
import { formatPatternLine } from '../../src/handlers/detectPatternsViewsHandler.js';
import { getHsShoulderMaxPctForTf, getSizeThresholdsForTf } from '../../tools/patterns/config.js';
import { detectHeadAndShoulders } from '../../tools/patterns/detect_hs.js';
import { linearRegressionWithR2 } from '../../tools/patterns/regression.js';
import type { Pivot } from '../../tools/patterns/swing.js';
import type { CandleData, DetectContext, PatternEntry } from '../../tools/patterns/types.js';

// ── ヘルパー ──

/** 実データ（BTC/JPY）の桁で見るための倍率。サイズ検査は率なので判定には効かない。 */
const SCALE = 125_000;

function iso(daysAgo: number): string {
	return dayjs().subtract(daysAgo, 'day').startOf('day').toISOString();
}

function mkCandle(daysAgo: number, o: number, h: number, l: number, c: number): CandleData {
	return { open: o, high: h, low: l, close: c, isoTime: iso(daysAgo) };
}

function buildCtx(opts: {
	candles: CandleData[];
	pivots: Pivot[];
	allValleys?: Pivot[];
	allPeaks?: Pivot[];
	tolerancePct?: number;
}): DetectContext {
	const tol = opts.tolerancePct ?? 0.04;
	return {
		candles: opts.candles,
		pivots: opts.pivots,
		allPeaks: opts.allPeaks ?? opts.pivots.filter((p) => p.kind === 'H'),
		allValleys: opts.allValleys ?? opts.pivots.filter((p) => p.kind === 'L'),
		tolerancePct: tol,
		headProminencePct: 0.04,
		sizeThresholds: getSizeThresholdsForTf('1day'),
		hsShoulderMaxPct: getHsShoulderMaxPctForTf('1day'),
		minDist: 5,
		want: new Set(),
		includeForming: false,
		debugCandidates: [],
		type: '1day',
		swingDepth: 7,
		near: (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * tol,
		pct: (a: number, b: number) => ((b - a) / Math.max(1, a)) * 100,
		lrWithR2: (pts) => linearRegressionWithR2(pts),
	};
}

/** H&S ピボット: H(0) → L(15) → H(30) → L(45) → H(60)。`tests/patterns/detect_hs.test.ts` と同形。 */
function buildHS(opts: {
	leftShoulder: number;
	head: number;
	rightShoulder: number;
	valley1: number;
	valley2: number;
}) {
	const { leftShoulder: ls, head: hd, rightShoulder: rs, valley1: v1, valley2: v2 } = opts;

	const candles: CandleData[] = [];
	for (let i = 0; i < 70; i++) candles.push(mkCandle(70 - i, 90 * SCALE, 95 * SCALE, 80 * SCALE, 90 * SCALE));
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

/** 逆 H&S ピボット: L(0) → H(15) → L(30) → H(45) → L(60)。 */
function buildInverseHS(opts: {
	leftShoulder: number;
	head: number;
	rightShoulder: number;
	peak1: number;
	peak2: number;
}) {
	const { leftShoulder: ls, head: hd, rightShoulder: rs, peak1: k1, peak2: k2 } = opts;

	const candles: CandleData[] = [];
	for (let i = 0; i < 70; i++) candles.push(mkCandle(70 - i, 90 * SCALE, 95 * SCALE, 80 * SCALE, 90 * SCALE));
	candles[0] = mkCandle(70, ls + 1, ls + 3, ls, ls + 1);
	candles[15] = mkCandle(55, k1 - 1, k1, k1 - 3, k1 - 1);
	candles[30] = mkCandle(40, hd + 1, hd + 3, hd, hd + 1);
	candles[45] = mkCandle(25, k2 - 1, k2, k2 - 3, k2 - 1);
	candles[60] = mkCandle(10, rs + 1, rs + 3, rs, rs + 1);

	const pivots: Pivot[] = [
		{ idx: 0, price: ls, kind: 'L', extremePrice: ls },
		{ idx: 15, price: k1, kind: 'H', extremePrice: k1 },
		{ idx: 30, price: hd, kind: 'L', extremePrice: hd },
		{ idx: 45, price: k2, kind: 'H', extremePrice: k2 },
		{ idx: 60, price: rs, kind: 'L', extremePrice: rs },
	];

	return { candles, pivots };
}

/** `12,481,701円` 形式のラベルから数値を取り出す。 */
function yen(label: string): number {
	return Number(label.replace(/,/g, ''));
}

/** 構造図 SVG のネックラインラベルの数値。 */
function necklineFromSvg(svg: string): number {
	const m = svg.match(/ネックライン: ([\d,]+)円/);
	if (!m) throw new Error(`構造図 SVG にネックラインラベルが無い: ${svg.slice(0, 200)}`);
	return yen(m[1]);
}

/** content 本文の「ネックライン: …」行（構造図ブロックより前）。 */
function necklineContentLine(text: string): string {
	const line = text.split('\n').find((l) => l.trim().startsWith('- ネックライン:'));
	if (!line) throw new Error(`content にネックライン行が無い:\n${text}`);
	return line.trim();
}

/**
 * 検出器の出力 1 件を `PatternEntry` として取り出す。`neckline` / `structureDiagram` /
 * `_fallback` は `DeduplicablePattern` の任意拡張（`[key: string]: unknown`）側にあり、
 * `PatternEntry` で初めて型が付く——表示層（`formatPatternLine`）が受け取る型と同じ。
 */
function detectOne(ctx: DetectContext, type: string): PatternEntry {
	const found = detectHeadAndShoulders(ctx).patterns.filter((p) => p.type === type);
	expect(found.length, `${type} が検出されていない`).toBeGreaterThan(0);
	return found[0] as PatternEntry;
}

/** `formatPatternLine` の full view（ネックライン行と構造図ブロックが同時に出る唯一の経路）。 */
function fullViewText(p: PatternEntry): string {
	// `PatternMeta` は未 export なので引数型から取る（`meta` はピボット日付の解決にしか使わず、
	// 本テストのピボットは `date` を持たないので空で足りる）。
	return formatPatternLine(p, 0, 'full', {} as Parameters<typeof formatPatternLine>[3], 'Asia/Tokyo', '1day');
}

// ── fixture 値 ──
//
// 肩 100 : 105（差 4.76%）は strict の tolerance 4% を超え、relaxed の 6.4% と
// hard cap 5% には収まる——`tests/patterns/detect_hs.test.ts` の relaxed fallback と同じ配置。
const RELAXED_HS = {
	leftShoulder: 100 * SCALE,
	rightShoulder: 105 * SCALE,
	head: 130 * SCALE,
	valley1: 85 * SCALE, // 10,625,000
	valley2: 82 * SCALE, // 10,250,000 ← nlY（低いほう）。nlAvg は 10,437,500
};
const RELAXED_IHS = {
	leftShoulder: 100 * SCALE,
	rightShoulder: 105 * SCALE,
	head: 70 * SCALE,
	peak1: 115 * SCALE, // 14,375,000
	peak2: 118 * SCALE, // 14,750,000 ← nlY（高いほう）。nlAvg は 14,562,500
};

describe('H&S / 逆 H&S: 構造図のネックラインラベルが本文と一致する（issue #226）', () => {
	it('relaxed H&S: 構造図ラベル == content 本文行 == neckline[0].y（= ブレイク判定に渡す線の y）', () => {
		const { candles, pivots } = buildHS(RELAXED_HS);
		const p = detectOne(buildCtx({ candles, pivots }), 'head_and_shoulders');
		expect(p._fallback).toMatch(/^relaxed_hs/);

		const nlY = Math.min(RELAXED_HS.valley1, RELAXED_HS.valley2);
		// ブレイク判定（`findHsBreakoutIdx`）に渡るのはこの線。水平なので 2 点とも同値。
		expect(p.neckline).toEqual([
			{ x: 15, y: nlY },
			{ x: 45, y: nlY },
		]);

		const text = fullViewText(p);
		expect(necklineContentLine(text)).toBe(`- ネックライン: ${nlY.toLocaleString('ja-JP')}円（水平）`);
		expect(necklineFromSvg(p.structureDiagram?.svg ?? '')).toBe(nlY);

		// 同じ 1 件の出力に現れるネックライン水準が 1 種類しかないこと（#226 の症状そのもの）。
		const all = [...text.matchAll(/ネックライン: ([\d,]+)円/g)].map((m) => yen(m[1]));
		expect(all.length).toBe(2); // 本文行 + 構造図ラベル
		expect(new Set(all)).toEqual(new Set([nlY]));
	});

	it('relaxed 逆H&S: 構造図ラベル == content 本文行 == neckline[0].y', () => {
		const { candles, pivots } = buildInverseHS(RELAXED_IHS);
		const p = detectOne(buildCtx({ candles, pivots }), 'inverse_head_and_shoulders');
		expect(p._fallback).toMatch(/^relaxed_ihs/);

		const nlY = Math.max(RELAXED_IHS.peak1, RELAXED_IHS.peak2);
		expect(p.neckline).toEqual([
			{ x: 15, y: nlY },
			{ x: 45, y: nlY },
		]);

		const text = fullViewText(p);
		expect(necklineContentLine(text)).toBe(`- ネックライン: ${nlY.toLocaleString('ja-JP')}円（水平）`);
		expect(necklineFromSvg(p.structureDiagram?.svg ?? '')).toBe(nlY);

		const all = [...text.matchAll(/ネックライン: ([\d,]+)円/g)].map((m) => yen(m[1]));
		expect(all.length).toBe(2);
		expect(new Set(all)).toEqual(new Set([nlY]));
	});

	// `nlY` は「両肩の間の最安の谷」（逆 H&S は最高の山）を `allValleys` / `allPeaks` から採るので、
	// **式としては 2 定義点のどちらとも一致しない位置に出る**。本番配線
	// （`detect_patterns.ts` は同一の `detectSwingPoints` 出力から `pivots` と `allValleys` を作る）では
	// `p0`〜`p4` が `pivots` 上で連続するため間に別の谷が入らず、今日は必ず `min(p1, p3)` に落ちる。
	// ここでは検出器の入力契約どおり `allValleys` に独立した谷を渡して、その位置が外側でも
	// 構造図が追随することを固定する（`nlY` の採り方を変えたときに黙って壊れないように）。
	it('relaxed H&S: nlY が 2 定義点の外側でも構造図ラベルが追随する', () => {
		const { candles, pivots } = buildHS(RELAXED_HS);
		const deeper: Pivot = { idx: 22, price: 60 * SCALE, kind: 'L', extremePrice: 60 * SCALE };
		const ctx = buildCtx({
			candles,
			pivots,
			allValleys: [...pivots.filter((v) => v.kind === 'L'), deeper].sort((a, b) => a.idx - b.idx),
		});
		const p = detectOne(ctx, 'head_and_shoulders');
		expect(p._fallback).toMatch(/^relaxed_hs/);

		const nlY = deeper.price;
		// 2 定義点（10,625,000 / 10,250,000）のどちらとも一致せず、外側（下）に出ている。
		expect(nlY).toBeLessThan(Math.min(RELAXED_HS.valley1, RELAXED_HS.valley2));
		expect(p.neckline?.[0]?.y).toBe(nlY);
		expect(necklineFromSvg(p.structureDiagram?.svg ?? '')).toBe(nlY);
		expect(necklineContentLine(fullViewText(p))).toBe(`- ネックライン: ${nlY.toLocaleString('ja-JP')}円（水平）`);
	});

	it('relaxed 逆H&S: nlY が 2 定義点の外側でも構造図ラベルが追随する', () => {
		const { candles, pivots } = buildInverseHS(RELAXED_IHS);
		const higher: Pivot = { idx: 22, price: 150 * SCALE, kind: 'H', extremePrice: 150 * SCALE };
		const ctx = buildCtx({
			candles,
			pivots,
			allPeaks: [...pivots.filter((v) => v.kind === 'H'), higher].sort((a, b) => a.idx - b.idx),
		});
		const p = detectOne(ctx, 'inverse_head_and_shoulders');
		expect(p._fallback).toMatch(/^relaxed_ihs/);

		const nlY = higher.price;
		expect(nlY).toBeGreaterThan(Math.max(RELAXED_IHS.peak1, RELAXED_IHS.peak2));
		expect(p.neckline?.[0]?.y).toBe(nlY);
		expect(necklineFromSvg(p.structureDiagram?.svg ?? '')).toBe(nlY);
		expect(necklineContentLine(fullViewText(p))).toBe(`- ネックライン: ${nlY.toLocaleString('ja-JP')}円（水平）`);
	});

	// ── strict は据え置き（`nlAvg`） ──

	it('strict H&S: 構造図ラベルは 2 定義点の平均（nlAvg）のまま', () => {
		const opts = {
			leftShoulder: 100 * SCALE,
			rightShoulder: 100 * SCALE,
			head: 130 * SCALE,
			valley1: 85 * SCALE,
			valley2: 82 * SCALE,
		};
		const { candles, pivots } = buildHS(opts);
		const p = detectOne(buildCtx({ candles, pivots }), 'head_and_shoulders');
		expect(p._fallback).toBeUndefined();

		// strict の neckline は**傾きつき**なので、本文行は 2 点を「→」で並べる。
		// 構造図はスカラー 1 つしか描けないため、代表値として平均を出す（strict の設計）。
		expect(p.neckline).toEqual([
			{ x: 15, y: opts.valley1 },
			{ x: 45, y: opts.valley2 },
		]);
		const nlAvg = (opts.valley1 + opts.valley2) / 2;
		expect(necklineFromSvg(p.structureDiagram?.svg ?? '')).toBe(nlAvg);
		expect(necklineContentLine(fullViewText(p))).toBe(
			`- ネックライン: ${opts.valley1.toLocaleString('ja-JP')}円 → ${opts.valley2.toLocaleString('ja-JP')}円`,
		);
	});

	it('strict 逆H&S: 構造図ラベルは 2 定義点の平均（nlAvg）のまま', () => {
		const opts = {
			leftShoulder: 100 * SCALE,
			rightShoulder: 100 * SCALE,
			head: 70 * SCALE,
			peak1: 115 * SCALE,
			peak2: 118 * SCALE,
		};
		const { candles, pivots } = buildInverseHS(opts);
		const p = detectOne(buildCtx({ candles, pivots }), 'inverse_head_and_shoulders');
		expect(p._fallback).toBeUndefined();

		expect(p.neckline).toEqual([
			{ x: 15, y: opts.peak1 },
			{ x: 45, y: opts.peak2 },
		]);
		const nlAvg = (opts.peak1 + opts.peak2) / 2;
		expect(necklineFromSvg(p.structureDiagram?.svg ?? '')).toBe(nlAvg);
		expect(necklineContentLine(fullViewText(p))).toBe(
			`- ネックライン: ${opts.peak1.toLocaleString('ja-JP')}円 → ${opts.peak2.toLocaleString('ja-JP')}円`,
		);
	});

	// ── 図の層の単体契約 ──

	it('generatePatternDiagram: H&S / 逆H&S が引数 neckline.price をラベルに出す（自前の再計算をしない）', () => {
		const range = { start: '2026-08-01T00:00:00Z', end: '2026-08-06T00:00:00Z' };
		const hsPivots = [
			{ idx: 0, price: 13_000_000, kind: 'H' as const, date: '2026-08-01T00:00:00Z' },
			{ idx: 1, price: 12_536_429, kind: 'L' as const, date: '2026-08-02T00:00:00Z' },
			{ idx: 2, price: 13_500_000, kind: 'H' as const, date: '2026-08-03T00:00:00Z' },
			{ idx: 3, price: 12_481_701, kind: 'L' as const, date: '2026-08-04T00:00:00Z' },
			{ idx: 4, price: 13_100_000, kind: 'H' as const, date: '2026-08-05T00:00:00Z' },
		];
		// issue #226 実測の値。旧実装は引数を無視して 2 定義点の平均 12,509,065 を描いていた。
		expect(
			necklineFromSvg(generatePatternDiagram('head_and_shoulders', hsPivots, { price: 12_481_701 }, range).svg),
		).toBe(12_481_701);
		// 2 定義点の外側でも引数がそのまま出る。
		expect(
			necklineFromSvg(generatePatternDiagram('head_and_shoulders', hsPivots, { price: 11_000_000 }, range).svg),
		).toBe(11_000_000);

		const ihsPivots = hsPivots.map((p) => ({ ...p, kind: p.kind === 'H' ? ('L' as const) : ('H' as const) }));
		expect(
			necklineFromSvg(
				generatePatternDiagram('inverse_head_and_shoulders', ihsPivots, { price: 13_900_000 }, range).svg,
			),
		).toBe(13_900_000);
	});
});
