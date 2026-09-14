/**
 * issue #261 の合成 fixture（形成中 triple / double の**主構成点がネックラインの誤側**）。
 *
 * 各経路について、**誤側の 1 点だけを動かした最小対**（棄却系列と対照系列）を作る。
 *
 * **`formingDoubleTopRows` は #268 案 C で削除した**（形成中 `double_top` の経路ごと消えたので
 * 呼び手が無くなった）。`formingDoubleBottomRows` は #262 以降、形成中ではなく完成済み経路の
 * `near_completion` を見る fixture として残っている（形は #261 のまま）。
 * 回帰は `tests/patterns/neckline-side-forming-triple-double.test.ts`、
 * 理由コードの表駆動テストは `tests/patterns/forming-double-triple-debug-candidates.test.ts` が
 * それぞれ import する——**同じ形を 2 箇所で書き直すと、片方だけ直したときに黙って乖離する。**
 *
 * ## なぜ上ヒゲ / 下ヒゲが要るのか
 *
 * ピボットは**高安**で決まり、ネックラインと主構成点の比較は**終値**（`price`）で行う
 * （基準の根拠は `validateMainPointsNecklineSide` の docstring）。この 2 つが別基準だからこそ
 * 「山の終値が谷の終値より低い」形が実在しうる——それが本ゲートの拾う破綻そのもの。
 * ヒゲが無いと、同水準判定・整合度の下限・サイズ検査（高さ ≥ 3% / 深さ ≥ 5%。**高安基準**）を
 * 同時に満たしたまま誤側を作れない。完成済みの同型 fixture
 * （`tests/patterns/neckline-side-triple-double.test.ts` の `LIVE_SHAPED_ROWS`）と同じ事情。
 *
 * **すべて `1day` 想定**（形成バー数の下限 23 本 / `tolerancePct` 4%）。
 */
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

/** 行列をローソク足にする。基準日は実データ fixture と重ならない年初。 */
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

/**
 * 形成中トリプルトップ（構成点 `[9, 22, 35]`、ネックライン = 2 谷の終値 99 / 98 の平均 **98.5**）。
 *
 * `currentClose` だけが最小対の可変部:
 *
 * | 値 | 期待 |
 * |---|---|
 * | `98.4` | 3 山目がネックラインの**下** → `forming_peaks_below_neckline` |
 * | `98.6` | 3 山目がネックラインの**上** → accepted な形成中 `triple_top` |
 *
 * 山 1 / 山 2 の終値は 100 で揃えてあるので、同水準判定（3 点の終値の max−min ≤ 4.8%）と
 * 整合度の下限（`currentDiff ≤ 1.8%`）は両方の値で通る。
 */
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

/**
 * ブレイク待ちダブルボトム（構成点 `[8, 16, 24]`）。102 → 100 の緩い下降に、谷バー 2 本
 * （idx 8 / 24・下ヒゲ 8）と山バー（idx 16・上ヒゲ 8）を置いたもの。ネックラインは
 * 中間構成点（山）の終値。
 *
 * | 引数 | 期待 |
 * |---|---|
 * | （既定） | 谷1 の終値 101.543 > 山の終値 101.086 → `valleys_above_neckline` |
 * | `peakClose = 102.5` | 2 谷ともネックラインより下 → accepted な `near_completion` の `double_bottom` |
 *
 * **#261 当時は形成中経路（`tryFormingDoubleBottom`）を見ていた。** #262 でその経路が消え、
 * 同じ 3 点を完成済み経路の未ブレイク分岐が組むようになったので、理由コードは `forming_` 接頭辞の
 * 無いほうに、`status` は `near_completion` になった。**形そのものは #261 のまま**。
 */
export function formingDoubleBottomRows(peakClose?: number): Row[] {
	const closes = ramp(102, 100);
	if (peakClose !== undefined) closes[16] = peakClose;
	return closes.map((c, i) => [c, c + (i === 16 ? 8 : 0.5), c - (i === 8 || i === 24 ? 8 : 0.5)]);
}
