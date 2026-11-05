// 形成中 triple / double の主構成点がネックラインの誤側にある形を、誤側の 1 点だけを動かした最小対（棄却系列と対照系列）で作る（issue #261）。`tests/patterns/neckline-side-forming-triple-double.test.ts` と `tests/patterns/forming-double-triple-debug-candidates.test.ts` の両方が import するので、同じ形を 2 箇所で書き直さない（片方だけ直すと黙って乖離する）。
// ピボットは高安、ネックラインと主構成点の比較は終値で決まるので、ヒゲが無いと同水準判定・整合度の下限・サイズ検査（高安基準）を同時に満たしたまま誤側を作れない。すべて `1day` 想定（形成バー数の下限 23 本 / `tolerancePct` 4%）。
import { dayjs } from '../../lib/datetime.js';

export type Candle = {
	isoTime: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
};

/** `[close, high, low]`。始値は終値と同値にする（本 fixture は終値と高安しか見ない）。 */
export type Row = [close: number, high: number, low: number];

/** 基準日は実データ fixture と重ならない年初にする。 */
export function rowsToCandles(rows: readonly Row[]): Candle[] {
	return rows.map(([close, high, low], i) => ({
		isoTime: dayjs.utc('2026-01-01T00:00:00Z').add(i, 'day').toISOString(),
		open: close,
		high,
		low,
		close,
		volume: 100,
	}));
}

/** `[bars, endClose][]` を線形補間して終値列にする。折り返し点がそのままピボット候補になる。 */
function legs(start: number, spec: ReadonlyArray<readonly [bars: number, end: number]>): number[] {
	const out = [start];
	let cur = start;
	for (const [bars, end] of spec) {
		for (let i = 1; i <= bars; i++) out.push(cur + ((end - cur) * i) / bars);
		cur = end;
	}
	return out.map((v) => Math.round(v * 1000) / 1000);
}

const ramp = (from: number, to: number, n = 36): number[] =>
	Array.from({ length: n }, (_, i) => Math.round((from + ((to - from) * i) / (n - 1)) * 1000) / 1000);

/** 形成中トリプルトップ（構成点 `[9, 22, 35]`、ネックライン = 2 谷の終値 99 / 98 の平均 98.5）。`currentClose` が最小対の可変部で、98.4 なら 3 山目がネックラインの下 → `forming_peaks_below_neckline`、98.6 なら上 → accepted な形成中 `triple_top`。山 1 / 山 2 の終値は 100 で揃えてあるので、同水準判定と整合度の下限は両方の値で通る。 */
export function formingTripleTopRows(currentClose: number): Row[] {
	const closes = legs(90, [
		[9, 100],
		[6, 99],
		[7, 100],
		[6, 98],
		[7, currentClose],
	]);
	return closes.map((c, i) => {
		const prev = closes[i - 1];
		const next = closes[i + 1];
		const isPeak = prev !== undefined && next !== undefined && c > prev && c > next;
		const isValley = prev !== undefined && next !== undefined && c < prev && c < next;
		return [c, c + (isPeak ? 6 : 0.5), c - (isValley ? 6.5 : 0.5)];
	});
}

/** 水準 200 で折り返した鏡像（`triple_top` → `triple_bottom`）。高安も入れ替える。 */
export const mirrorRows = (rows: readonly Row[]): Row[] => rows.map(([c, h, l]) => [200 - c, 200 - l, 200 - h]);

/** ブレイク待ちダブルボトム（構成点 `[8, 16, 24]`）。102 → 100 の緩い下降に谷バー 2 本（idx 8 / 24・下ヒゲ 8）と山バー（idx 16・上ヒゲ 8）を置き、ネックラインは山の終値。既定では谷1 の終値 101.543 > 山の終値 101.086 → `valleys_above_neckline`、`peakClose = 102.5` なら accepted な `near_completion` の `double_bottom`（完成済み経路の未ブレイク分岐が組む）。 */
export function formingDoubleBottomRows(peakClose?: number): Row[] {
	const closes = ramp(102, 100);
	if (peakClose !== undefined) closes[16] = peakClose;
	return closes.map((c, i) => [c, c + (i === 16 ? 8 : 0.5), c - (i === 8 || i === 24 ? 8 : 0.5)]);
}
