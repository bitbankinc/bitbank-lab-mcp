import { describe, expect, it } from 'vitest';
import type { Candle } from '../../tools/patterns/swing.js';
import { detectSwingPoints, filterPeaks, filterValleys } from '../../tools/patterns/swing.js';

/** V字のローソク足データを生成するヘルパー */
function makeCandles(prices: number[]): Candle[] {
	return prices.map((p) => ({
		open: p,
		close: p,
		high: p + 1,
		low: p - 1,
	}));
}

describe('detectSwingPoints', () => {
	it('空配列は空を返す', () => {
		expect(detectSwingPoints([], { swingDepth: 2 })).toEqual([]);
	});

	it('データが少なすぎる場合は空を返す', () => {
		const candles = makeCandles([100, 110, 100]);
		expect(detectSwingPoints(candles, { swingDepth: 3 })).toEqual([]);
	});

	it('明確なスイングハイを検出する', () => {
		// 上昇→ピーク→下降
		const prices = [100, 110, 120, 130, 120, 110, 100];
		const candles = makeCandles(prices);
		const pivots = detectSwingPoints(candles, { swingDepth: 2 });
		const peaks = pivots.filter((p) => p.kind === 'H');
		expect(peaks.length).toBeGreaterThanOrEqual(1);
		expect(peaks[0].idx).toBe(3);
	});

	it('明確なスイングローを検出する', () => {
		// 下降→ボトム→上昇
		const prices = [130, 120, 110, 100, 110, 120, 130];
		const candles = makeCandles(prices);
		const pivots = detectSwingPoints(candles, { swingDepth: 2 });
		const valleys = pivots.filter((p) => p.kind === 'L');
		expect(valleys.length).toBeGreaterThanOrEqual(1);
		expect(valleys[0].idx).toBe(3);
	});

	it('strictPivots=false で緩和モードを使用', () => {
		const prices = [100, 110, 120, 130, 125, 120, 100];
		const candles = makeCandles(prices);
		const pivots = detectSwingPoints(candles, { swingDepth: 2, strictPivots: false });
		// 緩和モードでもスイングを検出
		expect(pivots.length).toBeGreaterThanOrEqual(1);
	});

	it('ピボットの価格は close を使用する', () => {
		const candles: Candle[] = [
			{ open: 100, close: 100, high: 105, low: 95 },
			{ open: 110, close: 110, high: 115, low: 105 },
			{ open: 120, close: 125, high: 130, low: 115 },
			{ open: 110, close: 110, high: 115, low: 105 },
			{ open: 100, close: 100, high: 105, low: 95 },
		];
		const pivots = detectSwingPoints(candles, { swingDepth: 1 });
		const peaks = pivots.filter((p) => p.kind === 'H');
		if (peaks.length > 0) {
			// price は close 値（125）であって high（130）ではない
			expect(peaks[0].price).toBe(125);
		}
	});
});

describe('filterPeaks', () => {
	it('H のみをフィルタする', () => {
		const pivots = [
			{ idx: 0, price: 100, kind: 'H' as const, extremePrice: 100 },
			{ idx: 1, price: 90, kind: 'L' as const, extremePrice: 90 },
			{ idx: 2, price: 110, kind: 'H' as const, extremePrice: 110 },
		];
		const peaks = filterPeaks(pivots);
		expect(peaks).toHaveLength(2);
		expect(peaks.every((p) => p.kind === 'H')).toBe(true);
	});

	it('空配列は空を返す', () => {
		expect(filterPeaks([])).toEqual([]);
	});
});

describe('filterValleys', () => {
	it('L のみをフィルタする', () => {
		const pivots = [
			{ idx: 0, price: 100, kind: 'H' as const, extremePrice: 100 },
			{ idx: 1, price: 90, kind: 'L' as const, extremePrice: 90 },
			{ idx: 2, price: 85, kind: 'L' as const, extremePrice: 85 },
		];
		const valleys = filterValleys(pivots);
		expect(valleys).toHaveLength(2);
		expect(valleys.every((p) => p.kind === 'L')).toBe(true);
	});

	it('空配列は空を返す', () => {
		expect(filterValleys([])).toEqual([]);
	});
});

// ──────────────────────────────────────────────
// 価格基準の透明化（#125）
//   極値判定は high / low、格納する price は close。両者が別物であることを
//   出力から検算できるように extremePrice を持たせている。
// ──────────────────────────────────────────────
describe('detectSwingPoints: price と extremePrice の関係', () => {
	/** ヒゲの長さを指定できるローソク足（close と high/low を明確にずらす） */
	function makeWickyCandles(prices: number[], wick: number): Candle[] {
		return prices.map((p) => ({ open: p, close: p, high: p + wick, low: p - wick }));
	}

	it('スイングハイの price は終値、extremePrice は高値', () => {
		const prices = [100, 110, 120, 130, 120, 110, 100];
		const candles = makeWickyCandles(prices, 7);
		const peaks = filterPeaks(detectSwingPoints(candles, { swingDepth: 2 }));
		expect(peaks).toHaveLength(1);
		expect(peaks[0].idx).toBe(3);
		expect(peaks[0].price).toBe(candles[3].close);
		expect(peaks[0].extremePrice).toBe(candles[3].high);
		// ヒゲがある限り両者は一致しない。一致してしまうと「終値基準」との区別が付かない。
		expect(peaks[0].extremePrice).not.toBe(peaks[0].price);
	});

	it('スイングローの price は終値、extremePrice は安値', () => {
		const prices = [130, 120, 110, 100, 110, 120, 130];
		const candles = makeWickyCandles(prices, 7);
		const valleys = filterValleys(detectSwingPoints(candles, { swingDepth: 2 }));
		expect(valleys).toHaveLength(1);
		expect(valleys[0].idx).toBe(3);
		expect(valleys[0].price).toBe(candles[3].close);
		expect(valleys[0].extremePrice).toBe(candles[3].low);
		expect(valleys[0].extremePrice).not.toBe(valleys[0].price);
	});

	it('緩和モードでも extremePrice は判定に使った極値のまま', () => {
		const prices = [100, 110, 120, 130, 125, 120, 100];
		const candles = makeWickyCandles(prices, 5);
		const pivots = detectSwingPoints(candles, { swingDepth: 2, strictPivots: false });
		expect(pivots.length).toBeGreaterThan(0);
		for (const pv of pivots) {
			const c = candles[pv.idx];
			expect(pv.extremePrice).toBe(pv.kind === 'H' ? c.high : c.low);
		}
	});

	it('ヒゲが 0 の足では price と extremePrice が一致する（同値は情報であって欠損ではない）', () => {
		const prices = [100, 110, 120, 130, 120, 110, 100];
		const candles = makeWickyCandles(prices, 0);
		const peaks = filterPeaks(detectSwingPoints(candles, { swingDepth: 2 }));
		expect(peaks[0].extremePrice).toBe(peaks[0].price);
	});
});

// ──────────────────────────────────────────────
// 窓の前後 swingDepth 本の余白（#277）
//   走査範囲が [swingDepth, length − swingDepth) に閉じているので、窓の**最後の**
//   swingDepth 本は**極値であってもピボットにならない**。#242 の経路ゲートは
//   このピボット列で判定するため、終端の余白にある戻しを見ない。
//   検出器を通した仕様の固定は tests/patterns/breakout-path-double.test.ts。
//
//   ここでは**両端の境界そのものを実行して固定する**——余白の内外を挟むだけの
//   テストは [swingDepth + 1, length − swingDepth − 1) を走査する実装でも通ってしまう。
// ──────────────────────────────────────────────
describe('detectSwingPoints: 窓の前後 swingDepth 本はピボットにならない（issue #277）', () => {
	const DEPTH = 3;
	/** idx 5 が明確な極値（高値 111）。窓をどこで切るかで余白の内外が変わる。 */
	const PRICES = [100, 101, 102, 103, 104, 110, 105];

	/** close = 指定値、高安は ±1 のローソク足。極値判定は high / low で行われる。 */
	function makeCandles(prices: number[]): Candle[] {
		return prices.map((p) => ({ open: p, close: p, high: p + 1, low: p - 1 }));
	}

	const kinds = (candles: Candle[]) =>
		detectSwingPoints(candles, { swingDepth: DEPTH }).map((p) => `${p.kind}${p.idx}`);

	it('長さ 2 × swingDepth + 1 では、終端の余白にある極値がピボットにならない', () => {
		const candles = makeCandles(PRICES);
		expect(candles).toHaveLength(2 * DEPTH + 1);
		// 走査できる i は swingDepth だけ（i < 7 − 3 = 4）。idx 5 は範囲の外。
		expect(detectSwingPoints(candles, { swingDepth: DEPTH })).toEqual([]);
	});

	// ── 終端側の境界そのもの（idx 5 を動かさず、後ろの本数だけ 1 本ずつ増やす）──
	//   最後にピボットになりうるのは length − swingDepth − 1（終端からちょうど swingDepth 本前）。
	//   idx 5 に対しては length = 9 がその位置で、length = 8 はまだ余白の中。

	it('終端まであと swingDepth − 1 本（length = 8）では、まだピボットにならない', () => {
		const candles = makeCandles([...PRICES, 104]);
		expect(candles).toHaveLength(8);
		// i < 8 − 3 = 5。idx 5 は 1 つ足りない。
		expect(kinds(candles)).toEqual([]);
	});

	it('終端からちょうど swingDepth 本前（length = 9）になった瞬間にピボットになる', () => {
		const candles = makeCandles([...PRICES, 104, 103]);
		expect(candles).toHaveLength(9);
		// 走査範囲の右端 length − swingDepth − 1 = 5 が idx 5 そのもの。
		expect(candles.length - DEPTH - 1).toBe(5);
		expect(kinds(candles)).toEqual(['H5']);
		expect(detectSwingPoints(candles, { swingDepth: DEPTH })[0].extremePrice).toBe(candles[5].high);
	});

	it('さらに後ろを伸ばしてもピボットのまま（境界を越えた側の対照）', () => {
		expect(kinds(makeCandles([...PRICES, 104, 103, 102]))).toEqual(['H5']);
	});

	// ── 先頭側の境界そのもの（前後は対称）──

	it('窓の先頭 swingDepth 本も候補から外れる（idx = swingDepth − 1 は落ちる）', () => {
		// idx 1 が明確な極値だが、swingDepth = 3 では i < 3 を走査しない。
		const head = makeCandles([100, 110, 104, 103, 102, 101, 100, 101, 102, 103]);
		expect(detectSwingPoints(head, { swingDepth: DEPTH }).some((p) => p.idx === 1)).toBe(false);
	});

	it('idx = swingDepth ちょうどは走査範囲の左端として採用される', () => {
		// idx 3 が明確な安値。走査範囲は [3, 8 − 3 = 5)。
		const candles = makeCandles([106, 105, 104, 100, 104, 105, 106, 107]);
		expect(kinds(candles)).toEqual([`L${DEPTH}`]);
		expect(detectSwingPoints(candles, { swingDepth: DEPTH })[0].extremePrice).toBe(candles[DEPTH].low);
	});
});
