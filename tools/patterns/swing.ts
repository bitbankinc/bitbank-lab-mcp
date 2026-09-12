/**
 * patterns/swing.ts - スイングポイント（ピボット）検出
 *
 * ローソク足データからスイングハイ/スイングローを検出する。
 */

/** ローソク足の最小インターフェース */
export interface Candle {
	open: number;
	close: number;
	high: number;
	low: number;
	isoTime?: string;
}

/**
 * スイングポイント（ピボット）
 *
 * `price` と `extremePrice` は**別の値**なので混同しないこと（issue #125）:
 * `detectSwingPoints` は極値判定（この足がスイングか否か）を `high` / `low` で行い、
 * `price` にはその足の**終値**を格納する。ヒゲ 1 本で構造比較（同水準判定・ネックライン）が
 * 動くのを避けるため。判定に使った値そのものは `extremePrice` に載せる——載せないと、
 * 報告された `price` から判定を検算できず「終値基準で極値を取っている」と誤読される。
 *
 * **`price` の意味は「終値」で固定ではない。** 本型は `PatternEntry.pivots` の要素型でもあり、
 * そこには `detectSwingPoints` を通さない検出器の構成点も入る:
 *
 * | 出どころ | `price` | `extremePrice` |
 * |---|---|---|
 * | `detectSwingPoints`（double / triple / H&S） | 終値 | 判定に使った `high` / `low` |
 * | `detect_triangles` の relaxed swing | **`high` / `low`** | 同左（同値） |
 * | `detect_wedges` のトレンドラインタッチ点 | **`high` / `low`** | 同左（同値） |
 * | 形成中 H&S / 逆 H&S の暫定右肩 | 最新足の終値 | 同左（極値判定を通っていない） |
 *
 * 三角形が終値を経由しないのは、**トレンドライン（`upperLine` / `lowerLine`）をこの高安列に
 * 回帰させており、`neckline` もその線から取る**ため。`price` を終値に差し替えると構成点が
 * 自分のトレンドライン上に乗らなくなる。ウェッジ（#252）も同じ論理で高安に揃えてある——
 * こちらは回帰の入力ではなく**トレンドラインへのタッチ点**を構成点にしており、
 * タッチ判定自体が `c.high` / `c.low` と線の距離で行われている（`helpers.ts` の `evaluateTouchesEx`）。
 * ウェッジの構造図（`pivForDiagram`）だけは従来どおり `price` に終値を入れているので、
 * **同じ `idx` でも図の点と `pivots` の点は価格が違う**。**不変なのは「`extremePrice` は判定に使った値」**の
 * 一点だけで、`price` の基準は検出器ごとに違う（`docs/tools.md` に表がある）。
 */
export interface Pivot {
	idx: number;
	/** 構造比較に使う価格。`detectSwingPoints` 由来ならその足の**終値**（上の表を参照）。 */
	price: number;
	kind: 'H' | 'L';
	/** 極値判定に実際に使った値。`kind='H'` なら `high`、`'L'` なら `low`。`price` との差がヒゲ分。 */
	extremePrice: number;
}

export interface DetectSwingePointsOptions {
	/** スイング検出の深さ（前後何本を比較するか） */
	swingDepth: number;
	/** 厳格モード: 全ての前後バーより高い/低い必要がある（false: 60%投票制） */
	strictPivots?: boolean;
}

/**
 * ローソク足データからスイングポイント（ピボット）を検出する
 *
 * **窓の前後 `swingDepth` 本はピボットにならない**——極値判定が前後 `swingDepth` 本との比較を
 * 要求するため、走査する `i` の範囲が `[swingDepth, candles.length − swingDepth)` に閉じている。
 * これは「窓の終端の足はまだピボットとして確定していない」という正しい制約だが、
 * **#242 の経路ゲート（`peak_after_last_pivot` / `trough_after_last_pivot`）と再進入チェックは
 * この列で判定するため、終端の余白にある戻しを見ない**。結果として同じ値動きでも
 * `limit`（窓の終端位置）によって `completed` / `invalid` が変わりうる
 * （issue #277。`docs/tools.md` の「スイング検出パラメータは時間軸オート」の節に実例がある。
 * 深さ側の同型の依存は issue #251）。
 *
 * @param candles - ローソク足データ
 * @param options - 検出オプション
 * @returns 検出されたピボットの配列
 */
export function detectSwingPoints(candles: Candle[], options: DetectSwingePointsOptions): Pivot[] {
	const { swingDepth, strictPivots = true } = options;

	const highs = candles.map((c) => c.high);
	const lows = candles.map((c) => c.low);
	const pivots: Pivot[] = [];

	for (let i = swingDepth; i < candles.length - swingDepth; i++) {
		let isHigh = true;
		let isLow = true;

		if (strictPivots) {
			// 厳格モード: 全ての前後バーより高い/低い必要がある
			for (let k = 1; k <= swingDepth; k++) {
				if (!(highs[i] > highs[i - k] && highs[i] > highs[i + k])) isHigh = false;
				if (!(lows[i] < lows[i - k] && lows[i] < lows[i + k])) isLow = false;
				if (!isHigh && !isLow) break;
			}
		} else {
			// 緩和モード: 60%投票制
			let votesHigh = 0;
			let votesLow = 0;
			for (let k = 1; k <= swingDepth; k++) {
				votesHigh += highs[i] > highs[i - k] && highs[i] > highs[i + k] ? 1 : 0;
				votesLow += lows[i] < lows[i - k] && lows[i] < lows[i + k] ? 1 : 0;
			}
			const need = Math.ceil(swingDepth * 0.6);
			isHigh = votesHigh >= need;
			isLow = votesLow >= need;
		}

		// 判定は high/low、格納価格は close（ヒゲ影響を回避）。
		// 判定に使った極値は extremePrice に併記して、出力から検算できるようにする。
		if (isHigh) {
			pivots.push({ idx: i, price: candles[i].close, kind: 'H', extremePrice: highs[i] });
		} else if (isLow) {
			pivots.push({ idx: i, price: candles[i].close, kind: 'L', extremePrice: lows[i] });
		}
	}

	return pivots;
}

/**
 * ピボットを高値（H）のみにフィルタリング
 */
export function filterPeaks(pivots: Pivot[]): Pivot[] {
	return pivots.filter((p) => p.kind === 'H');
}

/**
 * ピボットを安値（L）のみにフィルタリング
 */
export function filterValleys(pivots: Pivot[]): Pivot[] {
	return pivots.filter((p) => p.kind === 'L');
}
