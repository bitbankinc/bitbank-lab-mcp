/**
 * 構造図（`lib/pattern-diagrams.ts` の `generatePatternDiagram`）のピボットラベルが
 * intraday で時刻まで出ることを、**検出器を実際に走らせて**固定する（issue #233）。
 *
 * `tests/lib/pattern-diagrams.test.ts` は `generatePatternDiagram` に `type` を直接渡して
 * 整形そのものを検証している。本ファイルはその 1 段上——**各検出器が `ctx.type` を
 * 構造図まで配線しているか**を見る。issue #233 の欠陥は整形関数と配線の両方に跨っており、
 * 整形だけ直しても呼び出し元が `type` を渡さなければ症状は一切変わらない。
 *
 * 症状（実データで確認された 2 例）: 1hour の `triple_top`（形成期間 9/2 03:00〜22:00）で
 * 構造図の 5 点がすべて「9/2」になり、どの点がどの足かを区別できなかった。
 * 本文側（`detectPatternsViewsHandler.ts` の `toDateOrTime`）は時刻まで出ていた。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { getHsShoulderMaxPctForTf, getSizeThresholdsForTf } from '../../tools/patterns/config.js';
import { detectDoubles } from '../../tools/patterns/detect_doubles.js';
import { detectHeadAndShoulders } from '../../tools/patterns/detect_hs.js';
import { detectTriples } from '../../tools/patterns/detect_triples.js';
import { linearRegressionWithR2 } from '../../tools/patterns/regression.js';
import type { Pivot } from '../../tools/patterns/swing.js';
import type { CandleData, DetectContext } from '../../tools/patterns/types.js';

// ── ヘルパー ──

/** 1 時間足の固定タイムライン。現在時刻に依存させない（ラベルの期待値を書けるようにする）。 */
const ANCHOR = '2026-09-02T13:00:00Z'; // JST 9/2 22:00

function iso(hoursAgo: number): string {
	return dayjs(ANCHOR).subtract(hoursAgo, 'hour').toISOString();
}

function mkCandle(hoursAgo: number, o: number, h: number, l: number, c: number): CandleData {
	return { open: o, high: h, low: l, close: c, isoTime: iso(hoursAgo) };
}

function buildCtx(opts: {
	candles: CandleData[];
	pivots: Pivot[];
	type: string;
	want: Set<string>;
	tolerancePct?: number;
}): DetectContext {
	const tol = opts.tolerancePct ?? 0.04;
	return {
		candles: opts.candles,
		pivots: opts.pivots,
		allPeaks: opts.pivots.filter((p) => p.kind === 'H'),
		allValleys: opts.pivots.filter((p) => p.kind === 'L'),
		tolerancePct: tol,
		headProminencePct: 0.04,
		minDist: 5,
		want: opts.want,
		includeForming: false,
		debugCandidates: [],
		type: opts.type,
		sizeThresholds: getSizeThresholdsForTf(opts.type),
		hsShoulderMaxPct: getHsShoulderMaxPctForTf(opts.type),
		swingDepth: 7,
		tz: 'Asia/Tokyo',
		near: (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * tol,
		pct: (a: number, b: number) => ((b - a) / Math.max(1, a)) * 100,
		lrWithR2: (pts) => linearRegressionWithR2(pts),
	};
}

/** ネックライン突破に必要な最小幅（detect_* の BREAKOUT_BUFFER_PCT=1.5%）＋マージン。 */
const BREAKOUT_PCT = 0.016;

/** H1 → L1 → H2 → L2 → H3（top） / その上下反転（bottom）。ブレイク足まで含める。 */
function buildTriple(side: 'top' | 'bottom') {
	const top = side === 'top';
	const peak = top ? 100 : 120;
	const valley = top ? 80 : 100;
	const base = (peak + valley) / 2;
	const candles: CandleData[] = [];
	for (let i = 0; i < 50; i++) candles.push(mkCandle(50 - i, base, base + 5, base - 5, base));
	const setPeak = (i: number) => mkCandle(50 - i, peak - 1, peak, peak - 3, peak - 1);
	const setValley = (i: number) => mkCandle(50 - i, valley + 1, valley + 3, valley, valley + 1);
	for (const i of top ? [0, 20, 40] : [10, 30]) candles[i] = setPeak(i);
	for (const i of top ? [10, 30] : [0, 20, 40]) candles[i] = setValley(i);
	// ネックライン（top=谷平均 / bottom=山平均）を突破する終値を並べる
	const nl = top ? valley : peak;
	const brk = top ? Math.floor(nl * (1 - BREAKOUT_PCT)) : Math.ceil(nl * (1 + BREAKOUT_PCT));
	for (let i = 41; i < 50; i++) candles[i] = mkCandle(50 - i, brk, brk + 3, brk - 3, brk);
	const kinds: Array<'H' | 'L'> = top ? ['H', 'L', 'H', 'L', 'H'] : ['L', 'H', 'L', 'H', 'L'];
	const pivots: Pivot[] = [0, 10, 20, 30, 40].map((idx, n) => {
		const kind = kinds[n] as 'H' | 'L';
		const price = kind === 'H' ? peak : valley;
		return { idx, price, kind, extremePrice: price };
	});
	return { candles, pivots };
}

/** H1 → L → H2（top） / その上下反転（bottom）。 */
function buildDouble(side: 'top' | 'bottom') {
	const top = side === 'top';
	const peak = top ? 100 : 120;
	const valley = top ? 80 : 100;
	const base = (peak + valley) / 2;
	const candles: CandleData[] = [];
	for (let i = 0; i < 40; i++) candles.push(mkCandle(40 - i, base, base + 5, base - 5, base));
	const setPeak = (i: number) => mkCandle(40 - i, peak - 1, peak, peak - 3, peak - 1);
	const setValley = (i: number) => mkCandle(40 - i, valley + 1, valley + 3, valley, valley + 1);
	for (const i of top ? [0, 20] : [10]) candles[i] = setPeak(i);
	for (const i of top ? [10] : [0, 20]) candles[i] = setValley(i);
	const nl = top ? valley : peak;
	const brk = top ? Math.floor(nl * (1 - BREAKOUT_PCT * 2)) : Math.ceil(nl * (1 + BREAKOUT_PCT * 2));
	for (let i = 21; i < 40; i++) candles[i] = mkCandle(40 - i, brk, brk + 3, brk - 3, brk);
	const kinds: Array<'H' | 'L'> = top ? ['H', 'L', 'H'] : ['L', 'H', 'L'];
	const pivots: Pivot[] = [0, 10, 20].map((idx, n) => {
		const kind = kinds[n] as 'H' | 'L';
		const price = kind === 'H' ? peak : valley;
		return { idx, price, kind, extremePrice: price };
	});
	return { candles, pivots };
}

/** 左肩 → 谷1 → 頭 → 谷2 → 右肩（top） / その上下反転（bottom）。 */
function buildHs(side: 'top' | 'bottom') {
	const top = side === 'top';
	const shoulder = top ? 100 : 100;
	const head = top ? 130 : 70;
	const neck = top ? 85 : 115;
	const base = top ? 90 : 110;
	const candles: CandleData[] = [];
	for (let i = 0; i < 70; i++) candles.push(mkCandle(70 - i, base, base + 5, base - 5, base));
	const extreme = (i: number, price: number, high: boolean) =>
		high
			? mkCandle(70 - i, price - 1, price, price - 3, price - 1)
			: mkCandle(70 - i, price + 1, price + 3, price, price + 1);
	candles[0] = extreme(0, shoulder, top);
	candles[15] = extreme(15, neck, !top);
	candles[30] = extreme(30, head, top);
	candles[45] = extreme(45, neck, !top);
	candles[60] = extreme(60, shoulder, top);
	const kinds: Array<'H' | 'L'> = top ? ['H', 'L', 'H', 'L', 'H'] : ['L', 'H', 'L', 'H', 'L'];
	const prices = [shoulder, neck, head, neck, shoulder];
	const pivots: Pivot[] = [0, 15, 30, 45, 60].map((idx, n) => ({
		idx,
		price: prices[n] as number,
		kind: kinds[n] as 'H' | 'L',
		extremePrice: prices[n] as number,
	}));
	return { candles, pivots };
}

/** SVG のピボットラベル（`<text …>山1: 9/2 03:00</text>` 等）から日時部分だけを抜く。 */
function pivotLabelDates(svg: string): string[] {
	return [...svg.matchAll(/>[^<>]*?: (\d+\/\d+(?: \d{2}:\d{2})?)</g)].map((m) => m[1] as string);
}

interface DetectorCase {
	name: string;
	patternType: string;
	run: (type: string) => Array<{ svg: string }>;
}

const CASES: DetectorCase[] = [
	{
		name: 'detectTriples / triple_top（issue #233 の実データ再現ケース）',
		patternType: 'triple_top',
		run: (type) =>
			collect(detectTriples(buildCtx({ ...buildTriple('top'), type, want: new Set(['triple_top']) })), 'triple_top'),
	},
	{
		name: 'detectTriples / triple_bottom',
		patternType: 'triple_bottom',
		run: (type) =>
			collect(
				detectTriples(buildCtx({ ...buildTriple('bottom'), type, want: new Set(['triple_bottom']) })),
				'triple_bottom',
			),
	},
	{
		name: 'detectDoubles / double_top',
		patternType: 'double_top',
		run: (type) =>
			collect(detectDoubles(buildCtx({ ...buildDouble('top'), type, want: new Set(['double_top']) })), 'double_top'),
	},
	{
		name: 'detectDoubles / double_bottom',
		patternType: 'double_bottom',
		run: (type) =>
			collect(
				detectDoubles(buildCtx({ ...buildDouble('bottom'), type, want: new Set(['double_bottom']) })),
				'double_bottom',
			),
	},
	{
		name: 'detectHeadAndShoulders / head_and_shoulders',
		patternType: 'head_and_shoulders',
		run: (type) =>
			collect(
				detectHeadAndShoulders(buildCtx({ ...buildHs('top'), type, want: new Set(['head_and_shoulders']) })),
				'head_and_shoulders',
			),
	},
	{
		name: 'detectHeadAndShoulders / inverse_head_and_shoulders',
		patternType: 'inverse_head_and_shoulders',
		run: (type) =>
			collect(
				detectHeadAndShoulders(buildCtx({ ...buildHs('bottom'), type, want: new Set(['inverse_head_and_shoulders']) })),
				'inverse_head_and_shoulders',
			),
	},
];

function collect(
	result: { patterns: Array<{ type?: string | undefined; structureDiagram?: { svg: string } | undefined }> },
	want: string,
) {
	return result.patterns
		.filter((p) => p.type === want && p.structureDiagram)
		.map((p) => ({ svg: (p.structureDiagram as { svg: string }).svg }));
}

describe('構造図の intraday 時刻ラベル（検出器からの配線。issue #233）', () => {
	for (const { name, run } of CASES) {
		it(`${name}: type=1hour で全ピボットラベルに HH:mm が付く`, () => {
			const diagrams = run('1hour');
			expect(diagrams.length).toBeGreaterThan(0);
			for (const { svg } of diagrams) {
				const labels = pivotLabelDates(svg);
				expect(labels.length).toBeGreaterThan(0);
				for (const label of labels) expect(label).toMatch(/^\d+\/\d+ \d{2}:\d{2}$/);
				// 同じ日付ラベルに潰れない（issue #233 の症状そのもの）。
				expect(new Set(labels).size).toBe(labels.length);
			}
		});

		it(`${name}: type=1day では M/D のまま（日足以上の表示形式は変えない）`, () => {
			const diagrams = run('1day');
			expect(diagrams.length).toBeGreaterThan(0);
			for (const { svg } of diagrams) {
				const labels = pivotLabelDates(svg);
				expect(labels.length).toBeGreaterThan(0);
				for (const label of labels) expect(label).toMatch(/^\d+\/\d+$/);
			}
		});
	}
});

// ── 配線の取りこぼし検知 ──

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DETECTOR_FILES = ['detect_doubles.ts', 'detect_triples.ts', 'detect_hs.ts', 'detect_wedges.ts'];

/** `generatePatternDiagram(` から始まる呼び出し 1 件分の実引数テキストを取り出す。 */
function callArguments(source: string, openIdx: number): string {
	let depth = 0;
	for (let i = openIdx; i < source.length; i++) {
		const ch = source[i];
		if (ch === '(') depth++;
		else if (ch === ')') {
			depth--;
			if (depth === 0) return source.slice(openIdx + 1, i);
		}
	}
	throw new Error('括弧が閉じていない');
}

describe('generatePatternDiagram の呼び出し元が type を渡している（tripwire）', () => {
	// 上の機能テストは実際に検出できたパターンしか通らないので、relaxed / forming など
	// 到達しにくい経路の配線漏れを取りこぼす。issue #233 の受け入れ条件は「1 箇所も
	// 取りこぼさないこと」なので、呼び出し元を機械的に数える。
	// 誤検知の性質: `type` という語が引数中にあるだけで通る緩い判定だが、
	// 構造図の呼び出しに `type` を書く理由は本 issue の配線以外に無い。
	it.each(DETECTOR_FILES)('%s の全呼び出しが options.type を渡す', (file) => {
		const source = fs.readFileSync(path.join(PACKAGE_ROOT, 'tools', 'patterns', file), 'utf8');
		const calls: string[] = [];
		let from = 0;
		while (true) {
			const found = source.indexOf('generatePatternDiagram(', from);
			if (found === -1) break;
			const open = found + 'generatePatternDiagram'.length;
			calls.push(callArguments(source, open));
			from = found + 1;
		}
		expect(calls.length).toBeGreaterThan(0);
		for (const args of calls) {
			expect(args).toMatch(/\btype\b/);
		}
	});
});
