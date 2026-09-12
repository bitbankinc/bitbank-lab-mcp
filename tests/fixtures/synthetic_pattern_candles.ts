/**
 * `detect_patterns` の合成 fixture（22 系列）。
 *
 * もともと `tests/detect_patterns_fixtures.test.ts` にローカル関数として置かれていたものを
 * **無改変で**切り出した（issue #227 Phase 1）。計測スクリプト
 * tjackiet/bitbank-lab-mcp#227 の計測スクリプトが「標準コーパス 800」（合成 704 = 本 fixture 22 件 ×
 * オプション 8 通り × 時間足 2 種 × `swingDepth` 2 種）を組むのに同じ系列が要るため、
 * テストとスクリプトの両方から import できる場所に移した。系列の中身（`closes` 配列）は
 * 1 値も変えていない——回帰は `tests/detect_patterns_fixtures.test.ts` がそのまま持つ。
 *
 * `makeCandle` は終値だけを与えて `high = close + 3` / `low = close - 3` の疑似ローソク足を作る
 * （fixture テスト側の従来の組み方そのまま）。
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

/** fixture の idx（日オフセット）→ ISO 文字列。`year`-01-01 UTC を起点に 1 日刻み。 */
export function makeIso(dayOffset: number, year = 2026) {
	// 旧実装（Date.UTC(year, 0, 1 + dayOffset) の ISO 文字列）と同値。負の offset も同じ
	return dayjs.utc(`${year}-01-01T00:00:00.000Z`).add(dayOffset, 'day').toISOString();
}

/** 終値だけから疑似ローソク足を作る（`high = close + 3` / `low = close − 3`、volume 100）。 */
export function makeCandle(dayOffset: number, close: number, year = 2026): Candle {
	return {
		isoTime: makeIso(dayOffset, year),
		open: close,
		high: close + 3,
		low: close - 3,
		close,
		volume: 100,
	};
}

/** 完成済みダブルトップ（2 山 ≒ 130 / 129 → ネックライン割れ）。 */
export function buildCompletedDoubleTopCandles(year = 2026): Candle[] {
	const closes = [
		100, 102, 105, 110, 118, 130, 126, 122, 118, 114, 112, 110, 114, 118, 122, 126, 128, 129, 123, 116, 104, 100, 95,
		100, 99, 98,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

/**
 * 形成中ダブルボトム: 谷1(idx=4) → 山(idx=10) → 谷2(idx=16) → 直近が上昇中。
 *
 * `1day` の形成中 double は formationBars（= lastIdx - 谷1.idx）∈ [23, 148] を要求するので
 * 末尾を伸ばして formationBars=25 にしてある（#118 問題 3 のバー数統一。旧 fixture の 19 本では
 * 弾かれる）。中間の山（101）をブレイクバッファ 1.5% 込みで超えないよう末尾は 98 で頭打ち。
 */
export const FORMING_DOUBLE_BOTTOM_BARS = 30;

/** 形成中ダブルボトム（上の定数 `FORMING_DOUBLE_BOTTOM_BARS` の説明を参照）。 */
export function buildFormingDoubleBottomCandles(year = 2026): Candle[] {
	const closes = [
		108, 104, 99, 92, 80, 84, 88, 92, 96, 99, 101, 98, 94, 89, 85, 82, 81, 84, 88, 91, 94, 95, 96, 95, 96, 96.5, 97,
		97.5, 98, 98,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

/** ディセンディングトライアングルの逆方向（上）ブレイク。invalid / failure として保持されるべき fixture。 */
export function buildDescendingTriangleInvalidBreakoutCandles(year = 2026): Candle[] {
	// 三角形本体は 24 本（旧 fixture の 18 本に 1 サイクル 6 本を先頭で追加）。
	// `detect_triangles` の最小窓が時間足の構造的下限（1day = 23 本）になったため、
	// 旧 fixture（本体 18 本）では windowSizes が空になり検出されない。
	// 追加分は既存と同じ形（切り下がる高値・水平な安値 100〜101）を 1 サイクル伸ばしただけ。
	const closes = [
		130, 140, 132, 122, 100, 118, 120, 130, 124, 116, 100, 112, 125, 118, 101, 110, 120, 114, 100, 108, 115, 110, 101,
		107, 128, 132, 130, 128, 126, 124,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

/** 矩形レンジ（100〜110 の往復）。triangle として誤検出しないことを見る fixture。 */
export function buildRectangleRangeCandles(year = 2026): Candle[] {
	const closes = [
		105, 110, 104, 109, 101, 108, 102, 110, 101, 109, 100, 108, 102, 109, 101, 110, 100, 109, 101, 108, 102, 109, 101,
		110,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

/** 平行な上昇チャネル。wedge として誤検出しないことを見る fixture。 */
export function buildRisingChannelCandles(year = 2026): Candle[] {
	const closes = [
		100, 108, 104, 112, 108, 116, 112, 120, 116, 124, 120, 128, 124, 132, 128, 136, 132, 140, 136, 144, 140, 148, 144,
		152, 148, 156, 152, 160, 156, 164,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

/** ブルフラッグの本体部分（pole + 保ち合い。ブレイク前）。下の 2 つで共用する。 */
const BULL_FLAG_BODY_CLOSES = [100, 108, 116, 124, 132, 140, 136, 138, 134, 136, 132, 134, 130, 132, 128, 130];

/** ブルフラッグの逆方向ブレイク（failure）。 */
export function buildBullFlagFailureCandles(year = 2026): Candle[] {
	const closes = [...BULL_FLAG_BODY_CLOSES, 120, 118, 116, 114];

	return closes.map((close, index) => makeCandle(index, close, year));
}

/**
 * ブルフラッグの順方向ブレイク（success）。`completed` になる fixture（issue #291）。
 * 上の {@link buildBullFlagFailureCandles} と本体が同一で末尾 4 本だけが違うので、
 * 「`invalidReason` が付くのは `invalid` のときだけ」を flag でも同じ形の対で見られる。
 */
export function buildBullFlagSuccessCandles(year = 2026): Candle[] {
	const closes = [...BULL_FLAG_BODY_CLOSES, 136, 140, 144, 148];

	return closes.map((close, index) => makeCandle(index, close, year));
}

/** ブルペナントの順方向ブレイク（success）。 */
export function buildBullPennantSuccessCandles(year = 2026): Candle[] {
	const closes = [
		100, 110, 122, 136, 150, 165, 158, 162, 154, 160, 155, 159, 156, 158, 157, 157.8, 157.2, 158.1, 157.4, 170, 172,
		174,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

/** ブルペナントの逆方向ブレイク（failure）。 */
export function buildBullPennantFailureCandles(year = 2026): Candle[] {
	const closes = [
		100, 110, 122, 136, 150, 165, 158, 162, 154, 160, 155, 159, 156, 158, 157, 157.8, 157.2, 158.1, 157.4, 148, 146,
		144,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

/**
 * Triple Top: 3 peaks near 130, 2 valleys near 112, then neckline break
 */
export function buildCompletedTripleTopCandles(year = 2026): Candle[] {
	const closes = [
		100, 105, 112, 120, 128, 130, 126, 120, 115, 112, 116, 122, 128, 130, 131, 126, 120, 115, 113, 117, 122, 128, 130,
		131, 126, 118, 110, 104, 98, 94,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/**
 * Triple Bottom (forming): 3 valleys near 80, with enough bars after 3rd valley
 */
export function buildFormingTripleBottomCandles(year = 2026): Candle[] {
	const closes = [
		108, 104, 98, 92, 84, 80, 84, 90, 95, 98, 94, 88, 84, 81, 80, 84, 90, 95, 97, 93, 88, 84, 81, 80, 84, 88, 92, 96,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/**
 * Head & Shoulders (completed): L-shoulder 125, head 140, R-shoulder 126, neckline ~110-112, break
 */
export function buildCompletedHeadAndShouldersCandles(year = 2026): Candle[] {
	const closes = [
		100, 108, 116, 122, 125, 120, 116, 112, 110, 114, 120, 128, 136, 140, 136, 128, 120, 114, 112, 116, 120, 124, 126,
		122, 116, 108, 102, 96,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/**
 * Inverse Head & Shoulders (forming): L-shoulder 80, head 64, R-shoulder forming near 80
 */
export function buildFormingInverseHeadAndShouldersCandles(year = 2026): Candle[] {
	const closes = [
		108, 100, 92, 84, 80, 84, 90, 96, 100, 96, 88, 78, 68, 64, 70, 80, 90, 98, 100, 96, 90, 84, 80, 84, 88, 92,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/**
 * Rising Wedge (forming): both slopes up, lower steeper
 * Peaks at idx 5,12,19,26,33 → highs 133,137,141,145,149 (slope ~0.571/bar)
 * Valleys at idx 0,7,14,21,28 → lows 97,105,113,121,129 (slope ~1.143/bar, steeper)
 */
export function buildFormingRisingWedgeCandles(year = 2026): Candle[] {
	const closes = [
		100, 106, 112, 118, 124, 130, 119, 108, 113, 118, 124, 129, 134, 125, 116, 120, 125, 129, 134, 138, 131, 124, 128,
		131, 135, 138, 142, 137, 132, 135, 138, 140, 143, 146, 143,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/**
 * Falling Wedge (completed with upward breakout)
 * Mirror of rising wedge, inverted: both slopes down, upper steeper in abs value
 */
export function buildCompletedFallingWedgeCandles(year = 2026): Candle[] {
	const closes = [
		146, 140, 134, 128, 122, 116, 127, 138, 133, 128, 122, 117, 112, 121, 130, 126, 121, 117, 112, 108, 115, 122, 118,
		115, 111, 108, 104, 109, 114, 111, 108, 106, 103, 100, 103, 110, 118,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/** {@link buildFormingAscendingTriangleCandles} の本体部分（ブレイク前）。下の 2 つで共用する。 */
const ASCENDING_TRIANGLE_BODY_CLOSES = [
	115, 118, 121, 124, 127, 124, 118, 112, 116, 120, 124, 127, 123, 117, 114, 118, 122, 126, 127, 124, 120, 117, 120,
	123, 126, 127, 125, 122, 120, 123, 126, 127, 126,
];

/**
 * Ascending Triangle (forming): flat upper resistance ~130, rising lower support
 * Peaks: all near close=127 → high=130; Valleys: rising from low=97 upward
 * No impulsive pole before window (gradual entry) to avoid pennant reclassification
 */
export function buildFormingAscendingTriangleCandles(year = 2026): Candle[] {
	return ASCENDING_TRIANGLE_BODY_CLOSES.map((close, index) => makeCandle(index, close, year));
}

/**
 * アセンディングトライアングルの**逆方向（下）ブレイク**。`invalid` / `failure` になる fixture（issue #291）。
 *
 * 本体は {@link buildFormingAscendingTriangleCandles} と同じ形（水平レジスタンス ~127 /
 * 切り上がるサポート）で、末尾 3 本で下限ラインを ATR バッファぶん割る。
 * **3 本とも下げ続ける**のは、最終足が三角形内に戻ると whipsaw 判定でブレイクが取り消され
 * `forming` に落ちるため。
 */
export function buildAscendingTriangleInvalidBreakoutCandles(year = 2026): Candle[] {
	const closes = [...ASCENDING_TRIANGLE_BODY_CLOSES, 118, 112, 106];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/**
 * アセンディングトライアングルの**順方向（上）ブレイク**。`completed` / `success` になる fixture（issue #291）。
 * 上の {@link buildAscendingTriangleInvalidBreakoutCandles} と本体が同一で末尾 3 本だけが違うので、
 * 「`invalidReason` が付くのは `invalid` のときだけ」を同じ形の対で見られる。
 */
export function buildAscendingTriangleCompletedBreakoutCandles(year = 2026): Candle[] {
	const closes = [...ASCENDING_TRIANGLE_BODY_CLOSES, 133, 137, 140];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/**
 * Symmetrical Triangle (forming): upper falling, lower rising, converging
 * Peaks: descending from ~140 to ~126; Valleys: ascending from ~100 to ~118
 */
export function buildFormingSymmetricalTriangleCandles(year = 2026): Candle[] {
	const closes = [
		120, 126, 132, 137, 130, 122, 116, 110, 104, 100, 106, 114, 120, 128, 134, 128, 120, 115, 108, 104, 110, 118, 124,
		130, 126, 120, 116, 112, 108, 114, 120, 126, 124, 120, 117, 114,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/**
 * IHS with asymmetric neckline (PR #2 ケース2 相当)
 * 左肩・右肩は同水準（valley 80）、頭は十分下（valley 64）、
 * ネックラインを構成する2つのピーク（山1≒100, 山2≒108）が約7%非対称
 * → HS_NECKLINE_MAX_PCT=0.05 で hard reject されるべき
 * 5ピボット以上の間隔（minBarsBetweenSwings=4@1day）を確保するため間延びさせる
 */
export function buildAsymmetricNecklineIHSCandles(year = 2026): Candle[] {
	const closes = [
		// pre-trend: downtrend (idx 0-7)
		130, 125, 120, 115, 110, 105, 100, 90,
		// 左肩 valley ≒ 80 (idx 8)
		80,
		// 山1 peak ≒ 100 (idx 13)
		86, 90, 94, 98, 100,
		// 頭 valley ≒ 64 (idx 18)
		90, 78, 70, 66, 64,
		// 山2 peak ≒ 108 (idx 23, 山1 から +8%)
		74, 86, 96, 104, 108,
		// 右肩 valley ≒ 80 (idx 28)
		96, 90, 86, 82, 80,
		// 続伸 (idx 29+)
		90, 96, 100,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/**
 * H&S with asymmetric neckline (PR #2 H&S 側ミラー)
 * 左肩・右肩は同水準（peak 120）、頭は十分上（peak 140）、
 * ネックラインを構成する2つの谷（valley1≒100, valley2≒108）が約8%非対称
 */
export function buildAsymmetricNecklineHSCandles(year = 2026): Candle[] {
	const closes = [
		// pre-trend: uptrend (idx 0-7)
		70, 75, 80, 85, 90, 95, 100, 110,
		// 左肩 peak ≒ 120 (idx 8)
		120,
		// 谷1 valley ≒ 100 (idx 13)
		114, 110, 106, 102, 100,
		// 頭 peak ≒ 140 (idx 18)
		108, 118, 128, 134, 140,
		// 谷2 valley ≒ 108 (idx 23, 谷1 から +8%)
		126, 120, 116, 112, 108,
		// 右肩 peak ≒ 120 (idx 28)
		112, 114, 116, 118, 120,
		// 下落
		110, 100, 92,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/**
 * Double top with structurally unequal peaks (PR #2 double hard cap)
 * peak1≒100, valley≒80, peak2≒105 → 5% 差。tolerancePct=0.06 では near() を通るが
 * DOUBLE_LEVEL_MAX_PCT=0.03 の hard cap で弾かれるべき
 */
export function buildUnequalPeaksDoubleTopCandles(year = 2026): Candle[] {
	const closes = [
		// 上昇 (idx 0-5)
		70, 76, 82, 88, 94, 100,
		// peak1 (idx 5) → valley (idx 11)
		96, 92, 88, 84, 81, 80,
		// 上昇して peak2 ≒ 105 (idx 17)
		86, 92, 96, 100, 103, 105,
		// 下落して valley 後 (idx 23) で4本目のピボットを形成
		100, 92, 86, 82, 80, 82,
		// 反発（4ピボット確保のための尾部）
		88, 94,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- 上昇トレンド継続中の偽 double_bottom (PR #3 prior_trend hard reject) ---
// idx 0-29 で 100→245 の clean な上昇トレンド（毎バー +5）、その後 idx 30-55 で
// 形成中ダブルボトムらしき形（左谷 232, ミッドピーク 246, 右谷 231, 直近 248）を作る。
// 左谷 idx=30 における lookback window [5..30] は monotonic に近い上昇のため
// 'up' 分類で down_or_sideways と矛盾し hard reject されるべき。
//
// 右谷までの押し目を 16 本に伸ばして formationBars（= lastIdx - 左谷.idx）を 25 にしてある。
// `1day` の形成中 double はバー数レンジ [23, 148] を要求するので（#118 問題 3 のバー数統一）、
// 旧 fixture（formationBars=14）では形成バー数の段で先に弾かれ、prior_trend の段に届かない。
export const UPTREND_FAKE_DOUBLE_BOTTOM_BARS = 56;

/** 上昇トレンド継続中の偽ダブルボトム（上の定数 `UPTREND_FAKE_DOUBLE_BOTTOM_BARS` の説明を参照）。prior_trend で hard reject されるべき fixture。 */
export function buildUptrendThenFakeDoubleBottomCandles(year = 2026): Candle[] {
	const closes = [
		// idx 0-9: 上昇トレンド 100 → 145 (毎バー +5)
		100, 105, 110, 115, 120, 125, 130, 135, 140, 145,
		// idx 10-19: 上昇継続 150 → 195
		150, 155, 160, 165, 170, 175, 180, 185, 190, 195,
		// idx 20-29: 上昇継続 200 → 245
		200, 205, 210, 215, 220, 225, 230, 235, 240, 245,
		// idx 30: 左谷 232 まで小さく押し目
		232,
		// idx 31-35: ミッドピーク 246 へ戻り
		236, 239, 241, 243, 245,
		// idx 36: ミッドピーク
		246,
		// idx 37-52: 右谷 231 までゆるやかに押し目（単調なので途中にピボットは立たない）
		245, 244, 243, 242, 241, 240, 239, 238, 237, 236, 235, 234, 233, 232, 231.5, 231,
		// idx 53-55: 直近の戻り
		237, 243, 248,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/**
 * 下降トレンド継続中の偽 head_and_shoulders (PR #3 prior_trend hard reject)
 * idx 0-25 で 300→100 の clean な下降トレンド（毎バー -8）、その後 idx 26-45 で
 * H-L-H-L-H（左肩 110 / 谷1 92 / 頭 130 / 谷2 92 / 右肩 110）を形成。
 * 左肩 idx=29 における lookback window [19..29] は概ね monotonic な下降のため
 * priorReturn ≈ -0.26, efficiency ≈ 0.79 → 'down' 分類で up_or_sideways と矛盾し
 * hard reject されるべき。
 */
export function buildDowntrendThenFakeHSCandles(year = 2026): Candle[] {
	const closes = [
		// idx 0-9: 下降トレンド 300 → 228 (毎バー -8)
		300, 292, 284, 276, 268, 260, 252, 244, 236, 228,
		// idx 10-19: 下降継続 220 → 148
		220, 212, 204, 196, 188, 180, 172, 164, 156, 148,
		// idx 20-25: 下降継続 140 → 100
		140, 132, 124, 116, 108, 100,
		// idx 26-29: 左肩 110 へ rally
		103, 106, 108, 110,
		// idx 30-33: 谷1 92 へ pullback
		106, 100, 96, 92,
		// idx 34-37: 頭 130 へ rally
		102, 115, 125, 130,
		// idx 38-41: 谷2 92 へ pullback
		118, 105, 96, 92,
		// idx 42-45: 右肩 110 へ rally
		100, 105, 108, 110,
		// idx 46-48: 続落
		106, 100, 96,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

/**
 * Double bottom with structurally unequal valleys (PR #2 double hard cap)
 * valley1≒100, peak≒120, valley2≒95 → 5% 差。tolerancePct=0.06 では near() を通るが
 * DOUBLE_LEVEL_MAX_PCT=0.03 の hard cap で弾かれるべき
 */
export function buildUnequalValleysDoubleBottomCandles(year = 2026): Candle[] {
	const closes = [
		// 下落 (idx 0-5)
		130, 124, 118, 112, 106, 100,
		// valley1 (idx 5) → peak (idx 11)
		104, 108, 112, 116, 119, 120,
		// 下落して valley2 ≒ 95 (idx 17)
		116, 110, 105, 100, 97, 95,
		// 上昇して peak 後 (idx 23) で4本目のピボットを形成
		100, 108, 114, 118, 120, 118,
		// 反落（4ピボット確保のための尾部）
		112, 106,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}
