/**
 * patterns/structural.ts - パターン構造検証ユーティリティ
 *
 * 反転パターン（double_top / double_bottom / head_and_shoulders /
 * inverse_head_and_shoulders）の検出に「形として失格な候補を hard reject
 * する層」を入れるための純粋関数群。
 *
 * 本ファイルは純粋関数のみ。detect_doubles.ts / detect_hs.ts への配線は
 * 別 PR で行う。
 *
 * regression.ts の `relDev`（分母 `Math.max(1, Math.max(a, b))`）には
 * 依存させず、構造検証の観点で純粋な相対差を返す `relDiff` を独立に持つ。
 */

import { linearRegressionWithR2 } from './regression.js';
import type { Pivot } from './swing.js';

// ---------- 定数 ----------

/**
 * double_top / double_bottom の2点（山-山、谷-谷）同水準の構造上限。**価格水準基準。**
 *
 * `tolerancePct` の `near` と**同じ量**（{@link relDiff}）を見ているので、完成済み double の
 * 同水準の実効上限は `min(tolerancePct, 本定数) × 価格水準`。これに加えて #178 項目 4 以降は
 * **高さ相対の {@link validateLevelDiff}（`MAX_LEVEL_SPREAD_RATIO` × パターン高さ）が
 * 独立した AND 条件**として掛かる。本定数は `spreadRatio` の実効上界
 * （`min(tolerancePct, 本定数) / depthPct`）の分子でもあるので、触ると向こうの到達可能域も
 * 動く（`validateLevelDiff` の docstring）。
 */
export const DOUBLE_LEVEL_MAX_PCT = 0.03;

/**
 * H&S / IHS の左右肩同水準の構造上限の **`1day` アンカー値**。**「肩の許容誤差」そのものではない**（issue #172）。
 *
 * ## ⚠️ 本定数を肩ゲートで直接読まないこと（issue #244 Phase 2）
 *
 * 肩ゲートの実効上限は **`ctx.hsShoulderMaxPct`（`config.ts` の `getHsShoulderMaxPctForTf`）**で、
 * 本定数はその **`1day` アンカー**（および `1week` / `1month` / 未知の時間足の値）としてだけ残っている。
 * 値は 0.05 のまま変えていない。5% 固定は ATR 換算で `1day` 1.8 ATR に対し **`1hour` 8.8 ATR** で、
 * 同水準判定が短い足で実質機能していなかった（#244 Phase 1 結果 3）。
 *
 * 本定数を**そのまま読み続けている箇所は 1 つだけ**——`detect_hs.ts` の `outerShoulderOk`
 * （`enumerateHsWindows` の窓生成）。**窓生成は 5% のまま緩く残す**のが #244 の決定で、
 * 理由は診断性（窓生成で落とすと `view=debug` が無音、肩ゲートで落とせば
 * `shoulders_not_near:cap` が残る）。詳細は `getHsShoulderMaxPctForTf` の docstring。
 *
 * ## 肩の判定における役割: 許容誤差に対する天井
 *
 * `detect_hs.ts` の 4 経路（strict 2 + relaxed 2）はいずれも肩の同水準判定を
 * **「相対差が許容誤差以内」AND `isSameLevel(p0, p4, ctx.hsShoulderMaxPct)`** で行う。
 * どちらの conjunct も同じ指標（左右肩の相対差 {@link relDiff}）を測っているので、
 * **実効閾値は 2 つの閾値の `min`**。**ただし許容誤差の実体が strict と relaxed で違う**
 * （issue #174。#173 の docstring は両経路を同一と書いていたが誤り）:
 *
 * | 経路 | 許容誤差の式 | 実効閾値 |
 * |---|---|---|
 * | strict（`findStrictHS` / `findStrictInverseHS`） | `near(p0, p4)` = `tolerancePct` | `min(tolerancePct, cap)` |
 * | relaxed（`findRelaxedHS` / `findRelaxedInverseHS`） | **`near()` を呼ばず** `tolerancePct × factors.shoulder` をインライン比較 | `min(tolerancePct × factors.shoulder, cap)` |
 *
 * `cap` = `ctx.hsShoulderMaxPct`（時間足別。`1day` 以上は本定数と同値の 0.05）。
 *
 * `factors` は `detect_hs.ts` の `RELAXED_FACTORS` の 2 段（`shoulder: 1.6` → `2.0`）。
 * `tolerancePct` は `config.ts` の `getDefaultToleranceForTf` が時間足ごとに返す
 * （`resolveParams` がスキーマ既定値 0.04 のときだけ tf-auto に差し替える）。
 *
 * **relaxed の実効閾値の式は `M = max(p0.price, p4.price) >= 1` を前提にしている。**
 * relaxed のインライン比較だけが分母を `Math.max(1, M)` にクランプしており、
 * `isSameLevel` は {@link relDiff} なので分母は素の `M`。したがって **`M < 1`
 * （1 円未満の建値）では 2 つの conjunct が別の分母を見る**——相対差に対する実効閾値は
 * `min(tolerancePct × factors.shoulder / M, cap)` になる。`1/M > 1` なので
 * **緩むのは許容誤差側だけで、`cap` が律速するという下表の結論は変わらない**（むしろ強まる）。
 * strict の `near()` にはこのクランプが無いため `min(tolerancePct, cap)` は
 * `M` によらず厳密。`view=debug` の `details.shouldersDiffPct` は strict / relaxed とも
 * `Math.max(1, M)` で割った値なので、`M < 1` では {@link relDiff} と一致しない。
 *
 * ### strict: `1day` 未満は `cap` が律速、`1day` 以上は `tolerancePct` が律速（#244 Phase 2 で更新）
 *
 * | 時間足 | `tolerancePct`（tf-auto） | `cap` = `getHsShoulderMaxPctForTf` | 実効値 | 律速側 |
 * |---|---|---|---|---|
 * | `1min` / `5min` | 0.04 | **0.0013 / 0.0029** | **0.0013 / 0.0029** | **`cap`** |
 * | `15min` / `30min` | 0.06 | **0.0051 / 0.0072** | **0.0051 / 0.0072** | **`cap`** |
 * | **`1hour`** | 0.05 | **0.0104** | **0.0104** | **`cap`** |
 * | `4hour` | 0.05 | **0.0204** | **0.0204** | **`cap`** |
 * | `8hour` / `12hour` | 0.045 | **0.0289 / 0.0354** | **0.0289 / 0.0354** | **`cap`** |
 * | `1day`（他） | 0.04 | 0.05（本定数） | **0.04** | **`tolerancePct`** |
 * | `1week` / `1month` | 0.035 / 0.03 | 0.05（本定数） | 0.035 / 0.03 | `tolerancePct` |
 *
 * **`1day` 以上の行は #244 以前と同一。** 変わったのは `1day` 未満で、以前は
 * 「`15min` / `30min` だけが本定数律速、`1hour` / `4hour` は 0.05 で同値」だった。
 * `resolveParams` は明示値をそのまま通すので、`1day` 以上では `tolerancePct: 0.08` のように
 * 呼び出し側が明示的に緩めて初めて `cap`（= 本定数）が効く。
 *
 * ### relaxed: `×1.6` 段で `1month` 以外の全時間足、`×2.0` 段では全時間足で `cap` が律速する
 *
 * | 時間足 | `tolerancePct` | `× 1.6` | `× 2.0` | `cap` | `×1.6` の実効値 | `×2.0` の実効値 |
 * |---|---|---|---|---|---|---|
 * | `15min` / `30min` | 0.06 | 0.096 | 0.12 | 0.0051 / 0.0072 | **`cap`** | **`cap`** |
 * | `1hour` / `4hour` | 0.05 | 0.08 | 0.10 | 0.0104 / 0.0204 | **`cap`** | **`cap`** |
 * | `8hour` / `12hour` | 0.045 | 0.072 | 0.09 | 0.0289 / 0.0354 | **`cap`** | **`cap`** |
 * | `1day`（他） | 0.04 | 0.064 | 0.08 | 0.05（本定数） | **0.05（本定数）** | **0.05（本定数）** |
 * | `1week` | 0.035 | 0.056 | 0.07 | 0.05（本定数） | **0.05（本定数）** | **0.05（本定数）** |
 * | `1month` | 0.03 | 0.048 | 0.06 | 0.05（本定数） | 0.048（`tolerancePct`） | **0.05（本定数）** |
 *
 * **relaxed は #244 の前後で「`cap` が律速」という結論が変わらない**（`1month` の `×1.6` 段を除く）。
 * 変わったのは strict 側で、**#244 以降は `1day` 未満なら strict でも `cap` が律速する。**
 *
 * ## 実測: `:cap` 0 件は strict の観測で、relaxed を 1 件も映していない
 *
 * 「全時間足で本定数のみが律速した棄却 = 0 件」（#167 のクローズコメント。BTC/JPY
 * `limit=200` / `headProminencePct: 0.01`）は **`shoulders_not_near:cap` を数えたもの**で、
 * この理由コードは **strict の専有**。#174 以前の relaxed は肩で落ちた窓に何も積まずに
 * `continue` していたため、**relaxed 側の cap 律速は観測に 1 件も入っていなかった。**
 *
 * #174 で relaxed にも棄却エントリを足したので、今は経路ごとに読める:
 *
 * | 理由コード | 経路 | 「許容誤差」の実体 |
 * |---|---|---|
 * | `shoulders_not_near:{tolerance,cap,both}` | strict | `tolerancePct` |
 * | `relaxed_shoulders_not_near:{tolerance,cap,both}` | relaxed（`RELAXED_FACTORS` 末尾の段のみ） | `tolerancePct × factors.shoulder` |
 *
 * **この定数を動かす提案は、両方の `:cap` を見ること。** 上表のとおり relaxed の `:cap` は
 * 既定パスでも普通に出る（合成 704 + 実データ 96 = 800 ケースで 105 件）。
 *
 * ## 律速 ≠ 出力への影響力
 *
 * 「relaxed ではほぼ全時間足で本定数が律速する」は**比較としては正しいが、出力を動かすことを
 * 意味しない。** relaxed は strict が 1 件も検出しなかったときだけ走るフォールバック
 * （`detectHeadAndShoulders` の `if (!foundHS …)`）なので到達頻度が低く、到達しても
 * 肩の後ろに頭の突出・ネックライン水平度・先行トレンド・サイズ検査・構造ゲートが並ぶ。
 *
 * 800 ケース（合成 704 + 実データ 96）で本定数だけを振った ablation:
 *
 * | 本定数 | `data.patterns` |
 * |---|---|
 * | 0.15 / 0.10 に緩める | **917**（現行と同数。`relaxed_shoulders_not_near:cap` が消えるだけ） |
 * | **0.05（現行）** | **917** |
 * | 0.02 に締める | 902 |
 * | 0.01 に締める | 882 |
 *
 * **緩めても動かない / 締めると動く**という非対称。#167 の「肩を 5.5% まで緩めて増える検出は
 * 0 件」と同じ結論で、**「律速している = 重要な定数」と読み替えないこと。**
 *
 * **この ablation は #244 以前の測定で、本定数が肩ゲートと窓生成の両方を駆動していたときのもの。**
 * 今の本定数は窓生成専用なので、同じ表を再測すると意味が変わる（肩ゲートの ablation は
 * `getHsShoulderMaxPctForTf` 側で行う）。値の比較に使うときは注意すること。
 *
 * ## もう 1 つの役割: 窓生成での「同水準の肩」判定
 *
 * `detect_hs.ts` の `outerShoulderOk`（`enumerateHsWindows` から呼ばれる）でも使う。
 * こちらは**外側の脚にある肩が anchor の肩を「明確に」超えているか**の判定で、
 * **`tolerancePct` と AND を取らない単独の閾値**。同水準（本定数以内）なら「幅のある肩」の
 * 一部として窓を通す。詳細は `outerShoulderOk` のコメントを参照。
 *
 * **#244 Phase 2 以降、本定数を実行時に読むのはこの 1 箇所だけ**（肩ゲートは
 * `ctx.hsShoulderMaxPct` へ移った）。窓生成は全時間足で 5% のまま。
 *
 * ## {@link HS_NECKLINE_MAX_PCT} との違い
 *
 * あちらは許容誤差と AND を取らない**独立した固定閾値**で、常に 5% が実効値
 * （`tolerancePct` を動かしてもネックライン水平度は動かない。schema の `tolerancePct`
 * description が公開している契約でもある）。本定数は肩の判定では許容誤差と
 * `min` を取るので、**同じ 0.05 でも効き方が違う。**
 */
export const HS_SHOULDER_MAX_PCT = 0.05;

/**
 * H&S / IHS のネックライン構成点（p1, p3）同水準の構造上限。
 *
 * **`tolerancePct` と AND を取らない独立した固定閾値**で、常にこの値が実効値になる
 * （`validateHorizontalNeckline` の `maxPct` にそのまま渡る）。呼び出し側が
 * `tolerancePct` を動かしてもネックラインの水平度要求は動かない——schema の
 * `tolerancePct` description が「ネックライン水平度は本パラメータに依存しない固定閾値」
 * として公開している契約。
 *
 * 肩側は同じ 0.05 でも肩の許容誤差と `min` を取るため効き方が違う（その許容誤差自体も
 * strict と relaxed で式が違う）し、**#244 Phase 2 以降は時間足別**
 * （`config.ts` の `getHsShoulderMaxPctForTf`。{@link HS_SHOULDER_MAX_PCT} はその `1day`
 * アンカー）。本定数は全時間足で 5% 固定のまま。**混同しないこと。**
 */
export const HS_NECKLINE_MAX_PCT = 0.05;

/**
 * 反転パターンのサイズ検査の下限。**パターン高さ**（構成点の高安の全振幅）と、
 * **戻りの深さ**（山と山に挟まれた谷 / 谷と谷に挟まれた山の押し）にそれぞれ掛かる。
 *
 * 元は `detect_doubles.ts` のローカル定数だった。double だけがサイズ検査を持ち、
 * `detect_triples.ts` / `detect_hs.ts` には相当する検査が 1 つも無かったため、
 * **double なら弾かれる小ささの形が triple / H&S では通っていた**（issue #138 欠陥 2-2）。
 * BTC/JPY 1時間足で高さ 1.66% のレンジ往復が `triple_top` と `triple_bottom` に
 * 同時に化けたのがこれ。値を揃えるために、定数と検査本体をここへ引き上げた。
 *
 * **時間足別の実効値は `config.ts` の `getSizeThresholdsForTf` が持つ（issue #152）。**
 * 本定数は **1day 相当の基準値**で、同関数のアンカー（1day / 1week / 1month / 未知の
 * 時間足のフォールバック）としてそのまま使われる。検出器から直接参照してはならない——
 * `tf` を知っている層（`detect_patterns.ts`）で 1 回だけ解決し、`DetectContext.sizeThresholds`
 * 経由で配る。
 */
export const MIN_PATTERN_HEIGHT_PCT = 0.03;

/**
 * {@link MIN_PATTERN_HEIGHT_PCT} と対。谷 / 山 1 つあたりの戻りの深さの下限。
 *
 * 時間足別の実効値と本定数の位置づけは {@link MIN_PATTERN_HEIGHT_PCT} の docstring を参照。
 */
export const MIN_DEPTH_PCT = 0.05;

/** 前提トレンド判定で「横ばい」とみなす priorReturn の範囲 */
export const PRIOR_TREND_SIDEWAYS_PCT = 0.05;

/** 前提トレンド判定の lookback バー数（min / max） */
export const PRIOR_TREND_LOOKBACK_MIN = 10;
export const PRIOR_TREND_LOOKBACK_MAX = 30;

/** 前提トレンド判定で「方向性のあるトレンド」とみなす efficiency 下限 */
export const PRIOR_TREND_MIN_EFFICIENCY = 0.55;

/** 前提トレンド判定で「方向性のあるトレンド」とみなす R² 下限 */
export const PRIOR_TREND_MIN_R2 = 0.35;

// ---------- 純粋関数 ----------

/**
 * 2値の相対差。`Math.max(a, b)` を分母にとり、`|a-b| / max(a, b)` を返す。
 *
 * 両方 0 のときはゼロ除算を避けるため 0 を返す。
 */
export function relDiff(a: number, b: number): number {
	const max = Math.max(a, b);
	if (max === 0) return 0;
	return Math.abs(a - b) / max;
}

/** 2値が `maxPct` 以内に収まっているか（hard cap 用） */
export function isSameLevel(a: number, b: number, maxPct: number): boolean {
	return relDiff(a, b) <= maxPct;
}

/** ネックライン構成2点の水平性検証結果 */
export interface NecklineHorizontalityResult {
	ok: boolean;
	diffPct: number;
}

/**
 * ネックライン構成2点の水平性検証。
 *
 * H&S / IHS の `neckline = [{x:p1.idx,y:p1.price},{x:p3.idx,y:p3.price}]`
 * の y 同士を `maxPct` 以内で同水準とみなす。
 */
export function validateHorizontalNeckline(
	p1Price: number,
	p3Price: number,
	maxPct: number,
): NecklineHorizontalityResult {
	const diffPct = relDiff(p1Price, p3Price);
	return { ok: diffPct <= maxPct, diffPct };
}

export type PriorTrendExpected = 'up_or_sideways' | 'down_or_sideways';

export type PriorTrendClassification = 'up' | 'down' | 'sideways' | 'insufficient_data';

export interface PriorTrendResult {
	ok: boolean;
	priorReturn: number;
	lookbackBars: number;
	/** lookback window 先頭の candle index（= `max(0, startIdx - lookbackBars)`） */
	priorStartIdx: number;
	classification: PriorTrendClassification;
	reason?: string;
	rangePct?: number;
	efficiency?: number;
	r2?: number;
}

/**
 * 形成前トレンド方向の検証。
 *
 * - `lookbackBars = clamp(round(patternBars * 0.5), PRIOR_TREND_LOOKBACK_MIN, PRIOR_TREND_LOOKBACK_MAX)`
 * - `priorStart  = max(0, startIdx - lookbackBars)`
 * - `priorReturn = (close[startIdx] - close[priorStart]) / close[priorStart]`
 *
 * 補助指標（lookback window 内の close 集合に対する集計）:
 * - `rangePct   = (maxClose - minClose) / priorClose`
 * - `efficiency = |startClose - priorClose| / (maxClose - minClose)`
 * - `r2`         = lookback window の (idx, close) に対する線形回帰 R²
 *
 * 分類ルール:
 * - データ不足（`startIdx < lookbackBars`）は `classification='insufficient_data'` で
 *   `ok=true`（hard reject しない）
 * - `|priorReturn| <= PRIOR_TREND_SIDEWAYS_PCT` は `classification='sideways'`
 * - `|priorReturn| > PRIOR_TREND_SIDEWAYS_PCT` でも、
 *   `efficiency >= PRIOR_TREND_MIN_EFFICIENCY` も `r2 >= PRIOR_TREND_MIN_R2` も
 *   満たさない場合は `classification='sideways'`（レンジ内の端点移動を弾く）
 * - 上記を満たす場合のみ `priorReturn > 0 → 'up'` / `priorReturn < 0 → 'down'`
 *
 * `ok` 判定:
 * - `expected='up_or_sideways'`  → `up` / `sideways` / `insufficient_data` を OK
 * - `expected='down_or_sideways'` → `down` / `sideways` / `insufficient_data` を OK
 *
 * close 欠損や window 不正の場合は安全側に `sideways` または `insufficient_data` に倒す。
 */
export function validatePriorTrend(
	candles: ReadonlyArray<{ close: number }>,
	startIdx: number,
	patternBars: number,
	expected: PriorTrendExpected,
): PriorTrendResult {
	const lookbackBars = Math.max(
		PRIOR_TREND_LOOKBACK_MIN,
		Math.min(PRIOR_TREND_LOOKBACK_MAX, Math.round(patternBars * 0.5)),
	);
	const priorStart = Math.max(0, startIdx - lookbackBars);
	const startCloseRaw = candles[startIdx]?.close;
	const priorCloseRaw = candles[priorStart]?.close;
	const startClose = typeof startCloseRaw === 'number' && Number.isFinite(startCloseRaw) ? startCloseRaw : 0;
	const priorClose = typeof priorCloseRaw === 'number' && Number.isFinite(priorCloseRaw) ? priorCloseRaw : 0;
	const priorReturn = priorClose === 0 ? 0 : (startClose - priorClose) / priorClose;

	if (startIdx < lookbackBars) {
		return {
			ok: true,
			priorReturn,
			lookbackBars,
			priorStartIdx: priorStart,
			classification: 'insufficient_data',
			reason: 'startIdx < lookbackBars',
		};
	}

	// 両端の close が欠損／不正な場合は安全側に sideways
	if (priorClose === 0 || startClose === 0) {
		const okMissing = expected === 'up_or_sideways' || expected === 'down_or_sideways';
		return {
			ok: okMissing,
			priorReturn,
			lookbackBars,
			priorStartIdx: priorStart,
			classification: 'sideways',
			reason: 'missing_close',
		};
	}

	// |priorReturn| が sideways 範囲内なら早期 return（補助指標の計算は不要）
	if (Math.abs(priorReturn) <= PRIOR_TREND_SIDEWAYS_PCT) {
		return {
			ok: true,
			priorReturn,
			lookbackBars,
			priorStartIdx: priorStart,
			classification: 'sideways',
		};
	}

	// lookback window の集計（priorStart .. startIdx を含む両端）
	const points: Array<{ x: number; y: number }> = [];
	let maxClose = Number.NEGATIVE_INFINITY;
	let minClose = Number.POSITIVE_INFINITY;
	let hasMissingClose = false;
	for (let i = priorStart; i <= startIdx; i++) {
		const c = candles[i]?.close;
		if (typeof c !== 'number' || !Number.isFinite(c)) {
			hasMissingClose = true;
			continue;
		}
		if (c > maxClose) maxClose = c;
		if (c < minClose) minClose = c;
		points.push({ x: i, y: c });
	}

	// window 内に欠損があれば安全側に sideways
	if (hasMissingClose || points.length < 2 || !Number.isFinite(maxClose) || !Number.isFinite(minClose)) {
		return {
			ok: true,
			priorReturn,
			lookbackBars,
			priorStartIdx: priorStart,
			classification: 'sideways',
			reason: 'invalid_window',
		};
	}

	const range = maxClose - minClose;
	const rangePct = range / priorClose;
	const efficiency = range > 0 ? Math.abs(startClose - priorClose) / range : 0;
	const { r2 } = linearRegressionWithR2(points);

	let classification: PriorTrendClassification;
	const isDirectional = efficiency >= PRIOR_TREND_MIN_EFFICIENCY || r2 >= PRIOR_TREND_MIN_R2;
	if (!isDirectional) {
		classification = 'sideways';
	} else if (priorReturn > 0) {
		classification = 'up';
	} else {
		classification = 'down';
	}

	const ok =
		expected === 'up_or_sideways'
			? classification === 'up' || classification === 'sideways'
			: classification === 'down' || classification === 'sideways';

	return { ok, priorReturn, lookbackBars, priorStartIdx: priorStart, classification, rangePct, efficiency, r2 };
}

// ---------- 反転パターンの構造ゲート（issue #126） ----------

/**
 * 構造ゲートが評価する価格基準は **`Pivot.extremePrice`（極値判定に使った high / low）**
 * であって `Pivot.price` ではない。
 *
 * 理由は 2 つある:
 *
 * 1. **`price` の意味が検出器ごとに違う**（`swing.ts` の `Pivot` docstring の表）。
 *    `detectSwingPoints` 由来なら終値、`detect_triangles` の relaxed swing なら high / low、
 *    形成中 H&S の暫定右肩なら最新足の終値。本ファイルは共通ユーティリティなので、
 *    生の `price: number` を受けると別の検出器に広げた瞬間に**型は通るまま**基準が変わる。
 *    `extremePrice` だけが「判定に使った値」として全検出器で意味が統一されている（#128）。
 * 2. **終値基準では帯の余裕が無い。** BTC/JPY 日足の実在ピボットで戻り率を計算すると
 *    （preDeclineHigh=7/21, trough1=8/3, peak=8/10）:
 *
 *    | 基準 | preDeclineHigh | trough1 | peak | 戻り率 |
 *    |---|---|---|---|---|
 *    | 終値 | 10,849,999 | 10,002,960 | 10,191,324 | 22.2% |
 *    | 高安 | 10,903,000 |  9,752,246 | 10,359,897 | 52.8% |
 *
 *    検出すべき正しいパターンが、終値基準では下限 {@link RETRACEMENT_MIN} まで 2 ポイントしか
 *    余裕が無い。高安基準なら帯の中央に収まる。
 *
 * **例外が 2 つある。**
 *
 * 1. **引き金は終値。** {@link findNecklineCross} の抜け判定と {@link detectTroughZoneReentry} の
 *    再進入判定は「その事象が起きたか」を見るので**終値**で評価する——ヒゲ 1 本の一時的な
 *    割り込みを「抜けた」と数えないため。水準（level）は構造由来、引き金（trigger）は終値、
 *    という組み合わせになる。
 * 2. **ネックラインの水準だけは呼び出し側から明示的に受け取る**
 *    （{@link ReversalStructureInput.necklinePrice}）。戻り率は「値幅」なので基準の統一された
 *    `extremePrice` で測るが、ネックラインは「線」であって、**後でブレイクを判定するのと
 *    同じ線**でなければ検査に意味が無い。
 *
 * なお {@link detectTroughZoneReentry} のゾーン水準は `extremePrice` 側で正しい。終値基準で
 * 組むと、実データ（8/3 → 8/10 → 8/14）で 8/16 の終値がゾーンに入り、**検出すべきパターンを
 * 無効化してしまう**（終値基準ゾーン上限 10,050,051 に対し 8/16 終値 10,014,831。
 * 高安基準なら上限 9,904,159 で入らない）。
 */
export type ReversalSide = 'bottom' | 'top';

/**
 * 中間構成点（ネックライン）の戻り率の下限。
 *
 * これを下回る山は「2 つの谷を分ける独立した山」ではなく、単一の底練り区間の中の
 * 揺れでしかない。下回った候補は double ではなく複合的な底（triple / 底練り）である。
 *
 * 高安基準での実測（下表）では、検出すべきパターンが 0.528 でここから十分離れている。
 * 終値基準だと同じパターンが 0.222 まで下がり、下限まで 2 ポイントしか残らない——
 * **基準を extremePrice にした根拠のひとつがこの余裕**（{@link ReversalSide} 参照）。
 */
export const RETRACEMENT_MIN = 0.2;

/**
 * 中間構成点（ネックライン）の戻り率の上限。
 *
 * これを上回るとネックラインが先行値幅の起点に肉薄し、上値抵抗がほぼ残っていない。
 * 形としては「上昇途中の押し目」であって反転の底固めではない。
 *
 * **1.0 超は設定不能で固定 reject**（{@link validateReversalStructure} が
 * `neckline_above_pre_decline_high` を返す）。定義上ダブルボトムではないため、
 * 閾値の調整対象にしない。**本定数はその内側にある「形の良し悪し」の線**であって、
 * 構造的な不可能性の線ではない。
 *
 * 値の根拠（BTC/JPY 日足 2026-05-29〜08-26 の実測、高安基準）:
 *
 * | 候補 | 構成点 | 戻り率 | あるべき判定 |
 * |---|---|---|---|
 * | 偽陽性 | 7/13 → 7/21 → 8/3 | **2.046** | 棄却（1.0 超の固定 reject で落ちる） |
 * | 正しい形 | 8/3 → 8/10 → 8/14 | **0.528** | 通過 |
 *
 * **実データが直接決めているのは「1.0 超は棄却」と「0.528 は通す」の 2 点だけ**で、
 * 0.85〜1.0 のどこに線を置くかは実測では決まらない。0.90 にしたのは:
 *
 * - 戻り率 0.90 以上はネックラインが先行値幅の起点の 10% 以内に入り、
 *   上値抵抗として意味を成さなくなる（投影ターゲットが先行高値を大きく超える）。
 * - 対称三角形は収束につれて戻り率が 0.79 → 0.91 と連続的に動く。0.85 に置くと
 *   **同じ 1 つの三角形の中で通る脚と落ちる脚が混在する**——構造の切れ目ではない場所に
 *   hard reject を置くことになる。
 * - 帯の内側の良し悪しは {@link RETRACEMENT_MIN} との中央からの距離としてスコア側
 *   （`scoreComponents.retracement`）が連続的に評価するので、hard reject 側を
 *   絞りすぎる必要がない。
 */
export const RETRACEMENT_MAX = 0.9;

/**
 * ネックライン下抜け（top なら上抜け）の探索窓のバー数。
 *
 * 「谷1 より前にネックライン水準を終値で抜けたバーが存在するか」を、谷1 から
 * この本数だけ遡って探す。無制限に遡ると遥か昔の無関係な交差でネックラインが
 * 正当化されてしまうので上限を置く。
 */
export const NECKLINE_CROSS_LOOKBACK_BARS = 60;

/**
 * 谷ゾーン（top なら山ゾーン）の高さ。パターン高さに対する比率で定義する。
 *
 * 谷2 確定後にこの水準まで戻した＝谷2 からの上昇をほぼ吐き出した、とみなす。
 * 絶対価格ではなくパターン高さの比率にしてあるので、値幅の大小に依存しない。
 */
export const TROUGH_REENTRY_FRACTION = 0.25;

/** 構造ゲートの不合格理由コード。debug candidates の `reason` にそのまま載る。 */
export type StructuralRejectReason =
	/** bottom: ネックラインが先行下落の起点より上（= 戻り率 > 1.0）。下抜けという事象が存在しない */
	| 'neckline_above_pre_decline_high'
	/** top: ネックラインが先行上昇の起点より下（= 戻り率 > 1.0） */
	| 'neckline_below_pre_decline_low'
	/** bottom: 谷1 より前にネックライン水準を終値で下抜けたバーが無い */
	| 'no_neckline_cross_before_trough1'
	/** top: 山1 より前にネックライン水準を終値で上抜けたバーが無い */
	| 'no_neckline_cross_before_peak1'
	/** 戻り率が [RETRACEMENT_MIN, RETRACEMENT_MAX] の帯の外（1.0 超は上の専用コード） */
	| 'retracement_out_of_band';

/** 構造ゲートを適用しなかった理由（`ok=true` のまま素通しした場合） */
export type StructuralSkipReason =
	/** 第1構成点より前に反対種別のピボットが無く、先行値幅を張れない */
	| 'no_prior_extreme'
	/** ネックライン交差の探索窓が短すぎて「交差が無い」ことを立証できない */
	| 'insufficient_history';

/**
 * サイズ検査の下限 2 つ。**どちらも下限で、小さいほど緩い。**
 *
 * 実値は時間足別（`config.ts` の `getSizeThresholdsForTf`。issue #152）。1day 相当の
 * 基準値が {@link MIN_PATTERN_HEIGHT_PCT} / {@link MIN_DEPTH_PCT}。
 */
export interface SizeThresholds {
	/** パターン高さ（構成点の高安の全振幅）の下限 */
	heightPct: number;
	/** 谷 / 山 1 つあたりの戻りの深さの下限 */
	depthPct: number;
}

/**
 * サイズ検査の不合格理由コード。`detect_doubles.ts` が既に debug candidates へ
 * 載せている 3 コードと同じ命名で、種別をまたいで同じ意味を持つ。
 */
export type PatternSizeRejectReason =
	/** パターン高さ（構成点の全振幅）が {@link SizeThresholds.heightPct} 未満 */
	| 'pattern_too_small'
	/** top: 山に挟まれた谷の押しが {@link SizeThresholds.depthPct} 未満 */
	| 'valley_too_shallow'
	/** bottom: 谷に挟まれた山の戻りが {@link SizeThresholds.depthPct} 未満 */
	| 'peak_too_shallow';

/**
 * 主構成点の水準ばらつき（`price` 基準）と、パターン高さ（`extremePrice` 基準）の実測値。
 *
 * **分子と分母で価格基準が違うのは意図的**（issue #138）。それぞれ既存の慣行に合わせている:
 *
 * | | 基準 | 合わせた既存実装 |
 * |---|---|---|
 * | 分子（水準ばらつき） | `Pivot.price`（終値） | 同水準判定（`near` / `isSameLevel`）。#131 / #132 の「水準同一性は終値」 |
 * | 分母（パターン高さ） | `Pivot.extremePrice`（高安） | {@link validatePatternSize}。同じく #131 / #132 の「値幅は高安」 |
 *
 * `extremePrice` 基準の全振幅は `price` 基準の全振幅**以上**（山は `high >= close`、
 * 谷は `low <= close`）なので、**比は保守的に（小さめに）出る**＝この比を上限として使う
 * 検査は棄却が控えめになる。安全側に倒すための選択で、逆（分母を `price`）にすると
 * ヒゲの分だけ棄却が増える。
 */
export interface LevelSpreadMetrics {
	/** 主構成点の `price` の max - min（絶対額） */
	spreadAbs: number;
	/** 同、価格水準に対する比。分母は主構成点の最大値（`relDev` と同じく `Math.max(1, …)` でクランプ） */
	spreadPct: number;
	/** 全構成点の `extremePrice` の max - min（絶対額）。構成点が欠けていれば `null` */
	heightAbs: number | null;
	/** 同、価格水準に対する比。分母は {@link validatePatternSize} と同じ `Math.max(1, hi)` */
	heightPct: number | null;
	/** `spreadAbs / heightAbs`。高さが 0 か構成点欠損なら `null` */
	spreadRatio: number | null;
}

/**
 * 主構成点の水準ばらつきをパターン高さで正規化した比を測る（issue #138）。
 *
 * `mainPoints` は同水準であるべき点（triple なら 3 山 / 3 谷）、`allPoints` は
 * パターン全体の構成点（triple なら 5 点）。`allPoints` に欠損（`null`）が混じる場合は
 * 高さを測れないので `heightAbs` / `heightPct` / `spreadRatio` を `null` にして
 * **ばらつきだけを返す**（棄却理由の details 用。呼び出し側が高さの確定前に呼べる）。
 */
export function levelSpreadMetrics(
	mainPoints: ReadonlyArray<Pick<Pivot, 'price'>>,
	allPoints: ReadonlyArray<Pick<Pivot, 'extremePrice'> | null | undefined>,
): LevelSpreadMetrics {
	const levels = mainPoints.map((p) => p.price);
	const spreadAbs = Math.max(...levels) - Math.min(...levels);
	const spreadPct = spreadAbs / Math.max(1, Math.max(...levels));

	const extremes = allPoints.map((p) => p?.extremePrice);
	const complete = extremes.every((v): v is number => Number.isFinite(v));
	if (!complete) return { spreadAbs, spreadPct, heightAbs: null, heightPct: null, spreadRatio: null };

	const hi = Math.max(...extremes);
	const lo = Math.min(...extremes);
	const heightAbs = hi - lo;
	return {
		spreadAbs,
		spreadPct,
		heightAbs,
		heightPct: heightAbs / Math.max(1, hi),
		spreadRatio: heightAbs > 0 ? spreadAbs / heightAbs : null,
	};
}

/**
 * 主構成点の水準ばらつきの、**パターン高さに対する**上限（issue #138）。
 *
 * ## なぜ価格水準の % では足りないのか
 *
 * 同水準判定（`near` / `tolerancePct`）は `|a-b| / max(a,b)` を見るので、**パターン自身の
 * 高さと無関係**。issue #138 の実例（BTC/JPY 1時間足）では許容幅がパターン高さの 3 倍あり、
 * 3 山が高さの 68% ばらついて単調に切り下がっていても「同水準」を通った。
 *
 * ## 0.5 の意味
 *
 * **本定数は triple と double が共有する**（double は #178 項目 4。同じ量を同じ意味で測るので
 * 検出器ごとに別の値を持たない。理由コードの語彙だけ {@link validateLevelDiff} が分けている）。
 * 以下は導入時の triple の説明だが、`3 山` を `2 山` に読み替えれば double にもそのまま当たる。
 *
 * `spreadRatio = 主構成点のばらつき / パターン高さ`。top なら
 * `高さ = 最高の山 - 最安の谷 = ばらつき + 最低の山からネックラインまでの押し` なので、
 * **`spreadRatio > 0.5` は「山の水準帯が、その山から谷までの押しより厚い」**を意味する。
 * 水準帯が押しより厚い形は、水平なレジスタンスに 3 回当たった形として読めない
 * （目視すれば単なる下降線 / 頭の突出した H&S）。#131 の「構造として成立しない形は
 * 減点ではなく hard reject」の系列。
 *
 * ## 時間足別テーブルを持たない理由
 *
 * **パターン自身の高さで正規化しているので、ボラティリティの水準に依らない。**
 * `getSizeThresholdsForTf`（#152）が時間足別なのは、あちらが価格水準の % を絶対的な下限として
 * 使っており ATR に対する難易度が時間足間で揃わなかったため。本比は無次元なのでその問題が無い。
 *
 * ## `tolerancePct` との関係
 *
 * **独立した AND 条件**で、`tolerancePct` の意味も既定値も変えない（#152 で
 * 「`getDefaultToleranceForTf` は触らない」と決めた理由がそのまま当てはまる）。
 * 実効的な水準ばらつきの上限は `min(tolerancePct × 価格水準, 本定数 × パターン高さ)`。
 */
export const MAX_LEVEL_SPREAD_RATIO = 0.5;

/**
 * 主構成点の水準ばらつきがパターン高さに対して過大な場合の理由コード。
 * {@link PatternSizeRejectReason} と同じく side ごとに別コードにしてある。
 */
export type PatternLevelSpreadRejectReason =
	/** top: 3 山（主構成点）のばらつきが {@link MAX_LEVEL_SPREAD_RATIO} × パターン高さを超える */
	| 'peak_spread_vs_height_excess'
	/** bottom: 3 谷（主構成点）のばらつきが同上 */
	| 'valley_spread_vs_height_excess';

/**
 * 高さ相対の同水準検査（issue #138）。不合格理由 or `null` を返す。
 *
 * **`metrics.spreadRatio` が `null`（高さを測れない / 高さ 0）のときは `null` を返す**——
 * 判定材料が無い候補を落とすと、この検査が意図していない理由で検出が減る。
 *
 * **呼び出しは各検出経路の「既存の棄却検査をすべて通過した後」に置くこと。**
 * 理由は {@link validatePatternSize} の docstring と同じ（固有の理由コードを持つ候補の
 * `reason` を横取りしない）。本検査は構造ゲート（`validateReversalStructure`）よりも後に置く
 * ——サイズ検査より後、というだけでは構造ゲートの理由を横取りしてしまう。
 */
export function validateLevelSpread(
	side: ReversalSide,
	metrics: LevelSpreadMetrics,
	maxRatio: number = MAX_LEVEL_SPREAD_RATIO,
): PatternLevelSpreadRejectReason | null {
	if (!exceedsLevelSpread(metrics, maxRatio)) return null;
	return side === 'top' ? 'peak_spread_vs_height_excess' : 'valley_spread_vs_height_excess';
}

/**
 * 主構成点**2 点**の水準の差がパターン高さに対して過大な場合の理由コード（issue #178 項目 4）。
 *
 * **{@link PatternLevelSpreadRejectReason} と語彙を分けてある。** 測っている量は同じ
 * `spreadRatio` だが、`view=debug` の集計が **`▼ reason 横断合計`（type を畳んで reason だけで
 * 合算する行。issue #193 / PR #194）** を出すため、流用すると **triple の「3 点のばらつき」と
 * double の「2 点の差」が横断合計行で 1 つの数字に潰れる**。type 別行では区別できるが、
 * 横断合計では区別できない。名前も `spread`（ばらつき）と `diff`（差）で対比させてある。
 */
export type PatternLevelDiffRejectReason =
	/** top: 2 山（主構成点）の差が {@link MAX_LEVEL_SPREAD_RATIO} × パターン高さを超える */
	| 'peaks_diff_vs_height_excess'
	/** bottom: 2 谷（主構成点）の差が同上 */
	| 'valleys_diff_vs_height_excess';

/**
 * 高さ相対の同水準検査の、**主構成点が 2 点の検出器（double）向け**（issue #178 項目 4）。
 *
 * 判定式は {@link validateLevelSpread} と同一（{@link exceedsLevelSpread}）で、返す理由コードの
 * 語彙だけが違う。分けた理由は {@link PatternLevelDiffRejectReason} の docstring を参照。
 *
 * ## 閾値は triple と同じ {@link MAX_LEVEL_SPREAD_RATIO}（0.5）
 *
 * `spreadRatio` は無次元なので時間足別テーブルを持たない、という
 * {@link MAX_LEVEL_SPREAD_RATIO} の理由が double にもそのまま当てはまる。
 *
 * ## `spreadRatio` に「1.0 が上界」のような構造上の天井は無い（PR #195 レビューでの訂正）
 *
 * 主構成点は全構成点に含まれるが、**分子と分母で読む価格フィールドが違う**——
 * 分子は `Pivot.price`（終値）、分母は `Pivot.extremePrice`（高安）。したがって
 * `spreadAbs <= heightAbs` は**成立しない**。低いほうの山に上ヒゲが付くと、高安で測る
 * 高さを増やさずに終値の差だけが広がる（実測可能な例: 山1 が高値 100 で引け、山2 が
 * 高値 100 / 終値 97、谷の安値 98.96 → `spreadRatio` 2.88。**この形は既存のゲートを
 * すべて通過して `accepted` になっていた**）。
 *
 * 実効上界を決めるのは**サイズ検査の深さ条件**（`heightPct` 側ではない）。山 2 つの
 * 極値が等しいとき `heightAbs >= depthPct × 価格水準` なので:
 *
 * ```
 * spreadRatio <= min(tolerancePct, DOUBLE_LEVEL_MAX_PCT) / getSizeThresholdsForTf(tf).depthPct
 * ```
 *
 * 既定パラメータなら `1hour` で 2.88 / `4hour` で 1.47 / `1day` 以上で 0.60。
 * **`1day` でも 0.5 を超えるので、本ゲートは短い時間足専用の装置ではない。**
 * 閾値 0.5 の根拠は幾何ではなく**実測の分布**（#178 項目 4。896 ケースで accept 側の
 * `spreadRatio` は max 0.360 で 0.069 との間が空。サイズ検査通過の 191 構造で max 0.951）。
 *
 * ## 呼び出し位置
 *
 * {@link validateLevelSpread} と同じ——「既存の棄却検査をすべて通過した後」。double では
 * 構造ゲート（`applyStructuralGate`）**と triple 再分類判定（`checkPostPivotInvalidation`）の
 * 両方より後**に置く。前に置くと `reclassified_as_triple_top` を横取りする。
 */
export function validateLevelDiff(
	side: ReversalSide,
	metrics: LevelSpreadMetrics,
	maxRatio: number = MAX_LEVEL_SPREAD_RATIO,
): PatternLevelDiffRejectReason | null {
	if (!exceedsLevelSpread(metrics, maxRatio)) return null;
	return side === 'top' ? 'peaks_diff_vs_height_excess' : 'valleys_diff_vs_height_excess';
}

/**
 * {@link validateLevelSpread} / {@link validateLevelDiff} が共有する判定。
 *
 * **`metrics.spreadRatio` が `null`（高さを測れない / 高さ 0）のときは `false` を返す**——
 * 判定材料が無い候補を落とすと、この検査が意図していない理由で検出が減る。
 */
function exceedsLevelSpread(metrics: LevelSpreadMetrics, maxRatio: number): boolean {
	if (metrics.spreadRatio === null || !Number.isFinite(metrics.spreadRatio)) return false;
	return metrics.spreadRatio > maxRatio;
}

/**
 * 同水準判定で落ちた候補の診断値（issue #138）。`view=debug` の `details` に載せる。
 *
 * `spreadPct` は価格水準基準（= `near` / `tolerancePct` が見ている量）、`heightPct` は
 * パターン高さの価格水準比、`spreadRatio` が**両者の比**——「主構成点のばらつきがパターン自身の
 * 高さの何割か」を読むための値で、issue #138 の実例では 0.68 だった。
 *
 * `levelTolerancePct` は **その経路の同水準判定が実際に使った許容誤差**（複数のゲートが同じ量を
 * 見ている経路ではその `min`）。生のパラメータ値をエコーするフィールドではないので、名前を
 * `tolerancePct` にしない。
 *
 * `allPoints` に構成点が欠けている（`null`）候補では高さを測れないので
 * `heightAbs` / `heightPct` / `spreadRatio` は `null` になり、content にも出ない。
 */
export function levelSpreadDetailsFrom(m: LevelSpreadMetrics, levelTolerancePct: number): Record<string, unknown> {
	return {
		spreadAbs: m.spreadAbs,
		spreadPct: m.spreadPct,
		heightAbs: m.heightAbs,
		heightPct: m.heightPct,
		spreadRatio: m.spreadRatio,
		levelTolerancePct,
	};
}

/**
 * 主構成点がネックラインの**誤った側**にある場合の理由コード（issue #216 Phase 2）。
 *
 * {@link PatternLevelSpreadRejectReason} / {@link PatternLevelDiffRejectReason} と同じく
 * **side ごとに分けてある。** `view=debug` の **`▼ reason 横断合計`（type を畳んで reason だけで
 * 合算する行。issue #193 / PR #194）** で top 側と bottom 側が 1 つの数字に潰れると、
 * 「山がネックラインを割った」と「谷がネックラインを超えた」——**符号が逆の 2 つの破綻**が
 * 区別できなくなる。
 *
 * 名前は「点が線のどちら側にあるか」をそのまま読む形にしてある（`_excess` 系のように
 * 「量が閾値を超えた」ではない——{@link validateMainPointsNecklineSide} には閾値が無い）。
 */
export type MainPointNecklineSideRejectReason =
	/** top: 主構成点（山）のいずれかがネックライン以下 */
	| 'peaks_below_neckline'
	/** bottom: 主構成点（谷）のいずれかがネックライン以上 */
	| 'valleys_above_neckline';

/** 誤った側にあった主構成点 1 点の診断値。`view=debug` の `details.offenders` に載る。 */
export interface MainPointNecklineSideOffender {
	/** 構成点のバー添字 */
	idx: number;
	/** 構成点の `price`（終値）。基準の根拠は {@link validateMainPointsNecklineSide} の docstring */
	price: number;
	/**
	 * ネックラインからの逸脱量。`top: neckline − price` / `bottom: price − neckline` で、
	 * **正なら誤った側**（0 は「上/下」のどちらでもないので同じく失格。#216 Phase 1 の
	 * 逸脱量の定義と符号を揃えてあるが、**0 を数えるかどうかだけが違う**——あちらは計測なので
	 * 同値を除いており、こちらは「より上にある」ことを要求するゲートなので同値も落とす）。
	 */
	deviation: number;
}

/** {@link validateMainPointsNecklineSide} の戻り値。 */
export interface MainPointNecklineSideResult {
	/** 失格理由。すべての主構成点が正しい側にあれば `null` */
	reason: MainPointNecklineSideRejectReason | null;
	/** 誤った側にあった点（`reason` が `null` なら空配列）。**全主構成点を検査した結果の全件** */
	offenders: MainPointNecklineSideOffender[];
}

/**
 * 主構成点とネックラインの位置関係の検査（issue #216 Phase 2）。
 *
 * `validateReversalStructure` に渡るのは構成点列の**先頭 2 点（`first` / `mid`）だけ**で、
 * それ以降の主構成点——double の第2構成点、triple の第2 / 第3構成点——は
 * **一度もネックラインと比較されていなかった**。その結果、
 * **「山3 がネックラインより下にある `triple_top`」が整合度 0.95 で出力されていた**
 * （実例: btc_jpy `1hour`、ネックライン 12,741,832 に対し山3 が 12,725,937 で −15,895）。
 * 3 つの山のうち 1 つが支持線を割っている形は、水平なレジスタンスに 3 回当たった形として
 * 読めない。#131 の「構造として成立しない形は減点ではなく hard reject」の系列。
 *
 * ## 検査内容
 *
 * | side | 要求 |
 * |---|---|
 * | `top` | すべての主構成点が `price > necklinePrice` |
 * | `bottom` | すべての主構成点が `price < necklinePrice` |
 *
 * **等号は失格**（`price === necklinePrice` は「より上」でも「より下」でもない）。
 * ネックラインの真上に乗った山は、その山だけパターン高さが 0 という意味なので通さない。
 *
 * ## 価格基準は `price`（終値）。`extremePrice` は採らない
 *
 * 1. **ネックラインが終値から作られている。** triple の `nlAvg` は 2 つの中間構成点の
 *    `price` の平均、double の `necklinePrice` は中間構成点の `price` そのもの。
 *    終値由来の線に高安を突き合わせるのは #178 項目 4 / `spreadRatio` と同じ**基準混在**。
 * 2. **ブレイク判定が終値。** `findBreakoutIdx` は終値で `necklinePrice` の突破を見る。
 *    {@link ReversalStructureInput.necklinePrice} の docstring が要求する
 *    「ゲートとブレイク判定は同じ値を使う」に揃う。
 * 3. **`extremePrice` 基準では triple の誤側が 0 件**（#216 Phase 1 の 1-3 章）＝
 *    ゲートが no-op になる。ヒゲは定義上、山なら上・谷なら下へ伸びるので、
 *    高安で測ると「誤った側」がほぼ消える。
 *
 * ## 許容幅（つまみ）を置かない
 *
 * #216 Phase 1 の結論 4 が根拠。**`double` / `triple` の逸脱量は最小がパターン高さの 2.96%**
 * （絶対額 2,147〜20,213 円）で**ゼロから離れている**。`inverse_head_and_shoulders` の
 * 最小 0.012%（31 円）のようなゼロ近傍の集団は triple / double には無いので、
 * **閾値を置かずにゼロ許容で切れる**。
 *
 * ## 本関数（スカラー版）の適用範囲は triple / double のみ
 *
 * **H&S 系に配線されていないのは本関数であって、検査そのものではない。** あちらは
 * {@link validateMainPointsAgainstNecklineAt}（**線版**。点ごとに `necklineAt(idx)` と比べる）で
 * **完成済み 4 経路に配線済み**（#216 の H&S 分。形成中 2 経路は今も未配線）。
 *
 * 分かれている理由: H&S 系は**ブレイク判定に傾きつきの線**を使う（右肩は線の定義 2 点の外側に
 * あるため外挿がかかる）。同じ構造がスカラー基準では「上に外れ」、線基準では「下に収まる」という
 * 反転が実際に起きるので、**#211（`necklineAt` の外挿クランプ）が入るまで基準を決められなかった**
 * （#216 Phase 1 の結論 2 / 3）。#211 マージ後に線版で配線した。
 *
 * triple / double のネックラインは**水平スカラー**なので線として評価しても同じ値になり、
 * この依存が無い。だから本関数（スカラー 1 つを受け取る形）で足りる。
 *
 * ## 呼び出し位置
 *
 * **各検出経路の「既存の棄却検査をすべて通過した後」**——{@link validateLevelSpread} /
 * {@link validateLevelDiff} よりも後ろ。理由は {@link validatePatternSize} の docstring と
 * 同じで、前に置くと固有の理由コードを持つ候補の `reason` を横取りする。
 *
 * **`necklinePrice` が有限でない場合は素通しする**（`reason: null`）。判定材料が無い候補を
 * 落とすと、この検査が意図していない理由で検出が減る（{@link exceedsLevelSpread} と同じ扱い）。
 * 主構成点側の `price` が有限でない点は**検査から除く**（落とさない）——同じ理由。
 */
export function validateMainPointsNecklineSide(
	side: ReversalSide,
	mainPoints: ReadonlyArray<Pick<Pivot, 'idx' | 'price'>>,
	necklinePrice: number,
): MainPointNecklineSideResult {
	if (!Number.isFinite(necklinePrice)) return { reason: null, offenders: [] };
	const offenders: MainPointNecklineSideOffender[] = [];
	for (const p of mainPoints) {
		if (!Number.isFinite(p.price)) continue;
		const deviation = side === 'top' ? necklinePrice - p.price : p.price - necklinePrice;
		if (deviation >= 0) offenders.push({ idx: p.idx, price: p.price, deviation });
	}
	if (offenders.length === 0) return { reason: null, offenders };
	return { reason: side === 'top' ? 'peaks_below_neckline' : 'valleys_above_neckline', offenders };
}

/**
 * {@link validateMainPointsNecklineSide} で落ちた候補の診断値。`view=debug` の `details` に載せる。
 *
 * **どの点がどれだけ外れたかを 1 点ずつ出す**（issue #216 Phase 2 の要件）。件数だけでは
 * 「最後の 1 点が僅かに割った」のか「3 点とも大きく割った」のかが読めず、
 * ゼロ許容という判断（許容幅を置かない根拠は {@link validateMainPointsNecklineSide} の
 * docstring）を後から見直せない。
 *
 * `deviationPct` はネックライン水準に対する比。**パターン高さ相対ではない**——高さは
 * この検査が受け取らない値（主構成点とネックラインしか見ない）なので、
 * ここで別の量を持ち込むと `levelSpreadDetailsFrom` の `spreadRatio` と紛らわしくなる。
 * 分母のクランプ（`Math.max(1, …)`）は `relDiff` / `levelSpreadMetrics` と同じ慣行。
 */
export function necklineSideDetailsFrom(
	necklinePrice: number,
	offenders: ReadonlyArray<MainPointNecklineSideOffender>,
): Record<string, unknown> {
	return {
		necklinePrice,
		offenders: offenders.map((o) => ({
			idx: o.idx,
			price: o.price,
			deviation: o.deviation,
			deviationPct: o.deviation / Math.max(1, Math.abs(necklinePrice)),
		})),
		// 呼び出しは `reason !== null`（= `offenders` が非空）のときだけだが、空配列で
		// `Math.max()` を呼ぶと `-Infinity` が `details` に載るので明示的に潰す。
		maxDeviation: offenders.length ? Math.max(...offenders.map((o) => o.deviation)) : null,
	};
}

/**
 * {@link MainPointNecklineSideRejectReason} の**形成中パス版**（issue #261）。
 *
 * 語彙を分ける理由は、`view=debug` の候補一覧が完成済みと形成中の棄却を**同じ配列に並べる**ため、
 * 同名だとどちらの経路で落ちたかが読めないこと。
 * さらに #193 / PR #194 の **`▼ reason 横断合計`（type を畳んで reason だけで合算する行）**で
 * 完成済みと形成中が 1 つの数字に潰れる。形成中の既存の理由コードが `forming_` 接頭辞で
 * 揃っている（`forming_bars_out_of_range` 等）のにも合わせてある。
 *
 * **判定そのものは完成済みとまったく同じ**（{@link validateMainPointsNecklineSide} を共有する）。
 * 分かれているのはラベルだけで、閾値も基準価格も経路で変えていない。
 */
export type FormingMainPointNecklineSideRejectReason = `forming_${MainPointNecklineSideRejectReason}`;

/**
 * {@link validateMainPointsNecklineSide} の理由コードを形成中パス用へ写す（issue #261）。
 * 写像先の語彙と、分けてある理由は {@link FormingMainPointNecklineSideRejectReason} を参照。
 *
 * **形成中 2 検出器（`detect_triples.ts` / `detect_doubles.ts`）が共有する。** 各ファイルで
 * テンプレートリテラルを手書きすると、片方だけ改名しても型が通ってしまう。
 */
export function formingNecklineSideReason(
	reason: MainPointNecklineSideRejectReason,
): FormingMainPointNecklineSideRejectReason {
	return `forming_${reason}`;
}

/**
 * 主構成点とネックラインの位置関係の検査（**線基準**。issue #216 Phase 2 の H&S 分）。
 *
 * {@link validateMainPointsNecklineSide} の**線バージョン**。判定の意味・理由コード・
 * 「等号は失格」「閾値を置かない」は同じで、**比較相手がスカラー 1 つではなく点ごとの値**
 * である点だけが違う。triple / double のネックラインは水平スカラーなので 1 つの値で足りたが、
 * **H&S の strict 経路のネックラインは傾きを持つ**（`p1` / `p3` の 2 点で張る直線）ため、
 * 主構成点ごとにその点の `idx` で線を評価した値と比べる必要がある。
 *
 * ## 別関数にしてある理由
 *
 * `validateMainPointsNecklineSide` はスカラー 1 つを受け取る設計で、既に triple / double の
 * 4 経路ずつに配線されている。**シグネチャ・テスト・`view=debug` の出力形を一切変えない**ため、
 * スカラー版はそのまま残して線版を足した。戻り値・理由コード・offender の型は
 * **同じものを再利用する**（`view=debug` の出力形を triple / double と H&S で揃えるため）。
 *
 * ## `necklineAt` は呼び出し側が渡す（依存の向きを崩さない）
 *
 * 本ファイルは `regression.js` / `swing.js` にしか依存しておらず、`detect_hs.ts` が
 * 本ファイルを使う**片方向**の関係になっている。`necklineAt` は `detect_hs.ts` の関数なので、
 * ここから import すると循環する。**関数として受け取る**ことでこの向きを保つ。
 *
 * ## 肩は「外挿した線」ではなく「近い方の定義点の水準」と比較される（#211 の設計）
 *
 * `detect_hs.ts` の `necklineAt` は #211 で定義点の区間 `[p1.idx, p3.idx]` へクランプされている。
 * H&S の主構成点 `[p0, p2, p4]` をこの関数で評価すると、実質的な比較相手はこうなる:
 *
 * | 主構成点 | `idx` の位置 | `necklineAt` の実質的な意味 |
 * |---|---|---|
 * | 左肩 (p0) | `p1.idx` より前（区間の外） | クランプで `p1.y` に頭打ち＝**谷1 の水準と比較** |
 * | 頭 (p2) | `p1.idx`〜`p3.idx` の内側 | **真の内挿値**（傾きを反映） |
 * | 右肩 (p4) | `p3.idx` より後（区間の外） | クランプで `p3.y` に頭打ち＝**谷2 の水準と比較** |
 *
 * **つまり肩だけが「線」ではなく「近い方の定義点の水準」と比較され、頭だけが真の内挿値で
 * 評価される。この非対称性は実装ミスではなく #211 の設計そのもの**（定義点の外側の値は
 * 「教科書の直線を伸ばしたらこうなるはず」というモデル上の仮定で、実際のサポート /
 * レジスタンスの根拠が無い）。基準を 1 つに揃えるために、ブレイク検出・スコアリング・
 * ターゲット投影と**同じ `necklineAt`** をそのまま使う——ここだけ別の基準を作らない。
 *
 * ## 許容幅（つまみ）を置かない
 *
 * tjackiet/bitbank-lab-mcp#216 の計測記録（#216 Phase 1 の H&S 分・`necklineAt` 基準での再計測）
 * が根拠。**逸脱量の最小はパターン高さの 1.504%（絶対額 3,857 円）で、0〜1.5% は空。**
 * #211 より前の基準（スカラー水準）で見えていた「逆 H&S の最小 0.012%（31 円）」という
 * ゼロ張り付きは**この基準では再現しない**ので、triple / double と同じくゼロ許容で切れる。
 *
 * ## 呼び出し位置・素通しの扱い
 *
 * {@link validateMainPointsNecklineSide} と同じ。**各検出経路の「既存の棄却検査をすべて
 * 通過した後」**に置き、`necklineAt` が有限を返さない点と `price` が有限でない点は
 * **検査から除く**（落とさない）。スカラー版が `necklinePrice` 非有限で候補ごと素通しするのに
 * 対し、こちらは**点ごとに除く**——線は点ごとに値が違うので、1 点が評価できないことは
 * 他の点の判定材料が無いことを意味しない。
 *
 * @param necklineAt 点の `idx` を受け取ってその位置のネックライン水準を返す関数
 *   （`detect_hs.ts` の `necklineAt(neckline, idx)` を束縛して渡す）
 */
export function validateMainPointsAgainstNecklineAt(
	side: ReversalSide,
	mainPoints: ReadonlyArray<Pick<Pivot, 'idx' | 'price'>>,
	necklineAt: (idx: number) => number,
): MainPointNecklineSideResult {
	const offenders: MainPointNecklineSideOffender[] = [];
	for (const p of mainPoints) {
		if (!Number.isFinite(p.price)) continue;
		const level = necklineAt(p.idx);
		if (!Number.isFinite(level)) continue;
		const deviation = side === 'top' ? level - p.price : p.price - level;
		if (deviation >= 0) offenders.push({ idx: p.idx, price: p.price, deviation });
	}
	if (offenders.length === 0) return { reason: null, offenders };
	return { reason: side === 'top' ? 'peaks_below_neckline' : 'valleys_above_neckline', offenders };
}

/**
 * {@link validateMainPointsAgainstNecklineAt} で落ちた候補の診断値。`view=debug` の `details` に載せる。
 *
 * {@link necklineSideDetailsFrom} の線バージョン。**offender ごとに `necklinePrice` を持つ**のが
 * 唯一の違いで、`offenders` / `maxDeviation` というトップレベルの形は揃えてある。
 *
 * **トップレベルの `necklinePrice` は出さない。** 線には「1 つの水準」が存在せず、
 * 代表値を 1 つ選んで載せると「その値と比較した」と誤読される（実際の比較相手は点ごとに違う）。
 * 点ごとの水準は各 offender の `necklinePrice` に出るので、
 * **`view=debug` から「どの点がどの水準と比べられたか」が読み取れる。**
 *
 * `deviationPct` の定義（その点のネックライン水準に対する比。**パターン高さ相対ではない**）と
 * 分母のクランプは {@link necklineSideDetailsFrom} と同じ。
 *
 * @param necklineAt {@link validateMainPointsAgainstNecklineAt} に渡したのと**同じ関数**を渡すこと
 *   （別の関数を渡すと `deviation` と `necklinePrice` が別々の線を指す）
 */
export function necklineSideDetailsFromAt(
	necklineAt: (idx: number) => number,
	offenders: ReadonlyArray<MainPointNecklineSideOffender>,
): Record<string, unknown> {
	return {
		offenders: offenders.map((o) => {
			const necklinePrice = necklineAt(o.idx);
			return {
				idx: o.idx,
				price: o.price,
				necklinePrice,
				deviation: o.deviation,
				deviationPct: o.deviation / Math.max(1, Math.abs(necklinePrice)),
			};
		}),
		// `necklineSideDetailsFrom` と同じ理由で空配列を明示的に潰す（`-Infinity` を載せない）。
		maxDeviation: offenders.length ? Math.max(...offenders.map((o) => o.deviation)) : null,
	};
}

/**
 * 反転パターンのサイズ検査（issue #138 欠陥 2-2）。不合格理由 or `null` を返す。
 *
 * `points` は**構成点を時系列順に並べた交互列**で、両端が主構成点（`side='top'`
 * なら山、`'bottom'` なら谷）であること。triple なら 5 点（山-谷-山-谷-山）、
 * H&S なら 5 点（左肩-谷-頭-谷-右肩）を渡す。
 *
 * 2 つの検査は `detect_doubles.ts` の `validateTopSize` / `validateBottomSize` と同型:
 *
 * - **パターン高さ**: 全構成点の最大 - 最小。issue #138 が実例の高さを
 *   「12,734,408 - 12,526,411 ≈ 1.66%」と全振幅で測ったのに合わせている
 * - **戻りの深さ**: 内側の点それぞれを、**その両隣の平均**と比べる。double の
 *   `peakAvg = (a + c) / 2`（谷を挟む 2 山の平均）を構成点が増えた場合へ素直に
 *   延長したもので、3 点の場合は double の式そのものに一致する。頭を含めた全体
 *   平均にしないのは、H&S で頭が平均を押し上げて肩-ネックライン間の押しが
 *   浅くても通ってしまうのを避けるため
 *
 * 価格基準は `Pivot.extremePrice`（高安）。**値幅の評価だから**で、
 * #131 / #132 の結論（値幅系は `extremePrice`、水準同一性とライン系は終値）の
 * 横展開。`detect_doubles.ts` の `validateTopSize` の docstring も参照。
 *
 * **呼び出しは各検出経路の「既存の棄却検査をすべて通過した後」に置くこと。** 前に置くと、
 * 既に固有の理由コードを持つ候補の `reason` を横取りして `view=debug` の診断が変わる
 * （実際、先に置いた版では `forming_neckline_not_horizontal` を検査していた既存テストが
 * `valley_too_shallow` に化けて落ちた）。最後に置けば **「これまで accepted だった候補だけを
 * 落とす」ことが位置から保証される**。
 *
 * 形成中パターンの暫定構成点（3 点目 / 暫定右肩）は極値判定を通っていないので、
 * `{ extremePrice: 現在足の終値 }` を渡す（既存の形成中 H&S の暫定右肩と同じ扱い）。
 *
 * **`thresholds` は引数で受ける（issue #152）。** 時間足別の値になったが、本ファイルは
 * 純粋関数のみで `DetectContext` を知らないので、解決は `tf` を知っている
 * `detect_patterns.ts` で 1 回だけ行い `DetectContext.sizeThresholds` で配る。
 * ここでモジュール定数を直接読むと時間足別の値が効かない。
 */
export function validatePatternSize(
	side: ReversalSide,
	points: ReadonlyArray<Pick<Pivot, 'extremePrice'>>,
	thresholds: SizeThresholds,
): PatternSizeRejectReason | null {
	const prices = points.map((p) => p.extremePrice);
	if (prices.length < 3 || prices.some((v) => !Number.isFinite(v))) return null;

	const hi = Math.max(...prices);
	const lo = Math.min(...prices);
	if ((hi - lo) / Math.max(1, hi) < thresholds.heightPct) return 'pattern_too_small';

	const shallow: PatternSizeRejectReason = side === 'top' ? 'valley_too_shallow' : 'peak_too_shallow';
	for (let i = 1; i < prices.length - 1; i += 2) {
		const flankAvg = (prices[i - 1] + prices[i + 1]) / 2;
		const depthPct =
			side === 'top' ? (flankAvg - prices[i]) / Math.max(1, flankAvg) : (prices[i] - flankAvg) / Math.max(1, flankAvg);
		if (depthPct < thresholds.depthPct) return shallow;
	}
	return null;
}

export interface ReversalStructureResult {
	ok: boolean;
	reason?: StructuralRejectReason;
	skipped?: StructuralSkipReason;
	/** 先行値幅の起点（bottom なら下落の起点＝谷1 直前のスイング高値）。`extremePrice` を載せる */
	priorExtreme?: { idx: number; extremePrice: number };
	/** 先行値幅に対する中間構成点の戻り率。算出できていれば `ok=false` でも載せる */
	retracementRatio?: number;
	/** ネックライン水準を終値で抜けたバー（第1構成点より前）。ゲート通過の証拠 */
	necklineCrossIdx?: number;
}

/**
 * 第1構成点より前で、直近の反対種別ピボットを返す。
 *
 * 「先行下落の起点」は**直前の**スイング高値と定義する（谷1 に向かう最後の下落の起点）。
 * 窓内の最高値ではない——下落が切り下げ高値で構成される場合、最高値を取ると
 * 分母が膨らんで戻り率が実態より小さく出る。
 */
export function findPriorExtreme(pivots: ReadonlyArray<Pivot>, beforeIdx: number, kind: 'H' | 'L'): Pivot | undefined {
	let found: Pivot | undefined;
	for (const p of pivots) {
		if (p.idx >= beforeIdx) break;
		if (p.kind === kind) found = p;
	}
	return found;
}

/** ネックライン交差の探索結果 */
export interface NecklineCrossResult {
	/** 交差が見つかったバーの idx。見つからなければ `undefined` */
	idx?: number;
	/** 「交差が無い」ことを立証できるだけの履歴があったか */
	conclusive: boolean;
}

/**
 * `[fromIdx, toIdx]` の窓で、`level` を**終値**で `direction` 方向に抜けたバーを探す。
 *
 * 「抜けた（cross）」は「その水準より下にある（below）」ではない。`direction='down'` なら
 * **一度 `level` より上で終えたバーがあり、その後 `level` より下で終えたバーがある**ことを要求する。
 * これが無いと、そもそもその水準を上から下に割ったという事象が起きていない
 * ——上抜けを「反転シグナル」と呼べる根拠が無い。
 */
export function findNecklineCross(
	candles: ReadonlyArray<{ close: number }>,
	fromIdx: number,
	toIdx: number,
	level: number,
	direction: 'down' | 'up',
): NecklineCrossResult {
	const start = Math.max(0, fromIdx);
	const end = Math.min(candles.length - 1, toIdx);
	const windowBars = end - start + 1;
	if (windowBars < PRIOR_TREND_LOOKBACK_MIN) return { conclusive: false };

	let seenBeyond = false;
	for (let i = start; i <= end; i++) {
		const close = candles[i]?.close;
		if (typeof close !== 'number' || !Number.isFinite(close)) continue;
		if (direction === 'down') {
			if (close > level) seenBeyond = true;
			else if (seenBeyond && close < level) return { idx: i, conclusive: true };
		} else {
			if (close < level) seenBeyond = true;
			else if (seenBeyond && close > level) return { idx: i, conclusive: true };
		}
	}
	return { conclusive: true };
}

export interface ReversalStructureInput {
	candles: ReadonlyArray<{ close: number }>;
	/** 全ピボット列（先行極値の探索に使う） */
	pivots: ReadonlyArray<Pivot>;
	/** 第1構成点（bottom なら谷1、top なら山1） */
	first: Pivot;
	/** 中間構成点＝ネックライン（bottom なら山、top なら谷） */
	mid: Pivot;
	/**
	 * ネックラインの水準。**呼び出し側がブレイク判定に使うのと同じ値を渡す。**
	 *
	 * `mid` から導出せず明示的に受け取るのは、`Pivot.price` の基準が検出器ごとに違う
	 * （`swing.ts` の表）ため——ここで `mid.price` を読むと、共通ゲートが呼び出し元ごとに
	 * 違う意味の数値を評価することになる。値幅の評価（戻り率）は基準が統一されている
	 * `extremePrice` を使うが、**ネックラインは「線」であって値幅ではない**ので、
	 * 「後でブレイクを判定する線」と同一でなければ検査の意味が無い。
	 *
	 * `detect_doubles` はここに `b.price`（`findBreakoutIdx` と `neckline` 配列に渡すのと
	 * 同じ値）を渡している。
	 */
	necklinePrice: number;
	side: ReversalSide;
}

/**
 * 反転パターン（double / triple / H&S 系）の構造ゲート。**hard reject の層**であって
 * スコアの減点ではない。ここを通らない形はスコアがいくら高くても検出結果に出さない。
 *
 * 検査は 2 つ:
 *
 * - **戻り率**（{@link RETRACEMENT_MIN} 〜 {@link RETRACEMENT_MAX}）。
 *   `1.0` 超は「ネックラインが先行下落の起点より上」＝定義上そのパターンではないので固定 reject。
 * - **ネックライン交差の実在**。第1構成点より前に、ネックライン水準を終値で抜けたバーが
 *   存在すること。存在しないなら「抜け返す」という事象が定義できない。
 *
 * 判定に必要な履歴が無い場合は `ok=true` + `skipped` で素通しする
 * （{@link validatePriorTrend} の `insufficient_data` と同じ安全側の倒し方）。
 *
 * 価格基準は `extremePrice`。理由は {@link ReversalSide} の docstring を参照。
 */
export function validateReversalStructure(input: ReversalStructureInput): ReversalStructureResult {
	const { candles, pivots, first, mid, necklinePrice, side } = input;
	const isBottom = side === 'bottom';

	const priorPivot = findPriorExtreme(pivots, first.idx, isBottom ? 'H' : 'L');
	if (!priorPivot) return { ok: true, skipped: 'no_prior_extreme' };
	const priorExtreme = { idx: priorPivot.idx, extremePrice: priorPivot.extremePrice };

	// 先行値幅（起点 → 第1構成点）。bottom なら下落幅、top なら上昇幅。
	const priorRange = isBottom
		? priorPivot.extremePrice - first.extremePrice
		: first.extremePrice - priorPivot.extremePrice;
	// 中間構成点の戻り幅（第1構成点 → ネックライン）
	const retraceRange = isBottom ? mid.extremePrice - first.extremePrice : first.extremePrice - mid.extremePrice;

	const overshootReason: StructuralRejectReason = isBottom
		? 'neckline_above_pre_decline_high'
		: 'neckline_below_pre_decline_low';

	// 先行値幅が無い（起点が第1構成点を越えていない）= そもそも先行下落 / 上昇が存在しない。
	// このときネックラインは必ず起点の外側にあるので、戻り率 > 1.0 と同じ扱いで reject する。
	if (priorRange <= 0) return { ok: false, reason: overshootReason, priorExtreme };

	const retracementRatio = retraceRange / priorRange;
	if (retracementRatio > 1) return { ok: false, reason: overshootReason, priorExtreme, retracementRatio };
	if (retracementRatio < RETRACEMENT_MIN || retracementRatio > RETRACEMENT_MAX) {
		return { ok: false, reason: 'retracement_out_of_band', priorExtreme, retracementRatio };
	}

	const cross = findNecklineCross(
		candles,
		first.idx - NECKLINE_CROSS_LOOKBACK_BARS,
		first.idx,
		necklinePrice,
		isBottom ? 'down' : 'up',
	);
	if (cross.idx === undefined) {
		// 窓が短くて「交差が無い」を立証できないなら素通し（安全側）。
		if (!cross.conclusive) {
			return { ok: true, skipped: 'insufficient_history', priorExtreme, retracementRatio };
		}
		return {
			ok: false,
			reason: isBottom ? 'no_neckline_cross_before_trough1' : 'no_neckline_cross_before_peak1',
			priorExtreme,
			retracementRatio,
		};
	}

	return { ok: true, priorExtreme, retracementRatio, necklineCrossIdx: cross.idx };
}

export interface TroughZoneReentryInput {
	candles: ReadonlyArray<{ close: number }>;
	/** 第1構成点 */
	first: Pivot;
	/** 中間構成点＝ネックライン */
	mid: Pivot;
	/** 第2構成点（この足より後を走査する） */
	second: Pivot;
	/** 走査終了 idx（ネックライン突破バー、または最終足）。両端を含む */
	untilIdx: number;
	side: ReversalSide;
}

export interface TroughZoneReentryResult {
	reentered: boolean;
	/** 再進入したバーの idx */
	idx?: number;
	/** 再進入と判定する価格水準 */
	level: number;
}

/**
 * 第2構成点の確定後、ネックライン突破前に価格が谷ゾーン（top なら山ゾーン）へ
 * 戻ってしまっていないかを見る。
 *
 * 戻っているなら、その第2構成点は「反転の底」ではなく、より大きな底練り区間の
 * 途中の点でしかない。ダブルとしては無効で、triple / 複合底として扱うべき形。
 *
 * ゾーンの水準は**パターン高さの比率**（{@link TROUGH_REENTRY_FRACTION}）で決める。
 * 絶対価格や固定 % だと値幅の大小でゾーンの意味が変わる。
 * 引き金は**終値**——ヒゲで一瞬触れただけを「戻った」と数えない。
 */
export function detectTroughZoneReentry(input: TroughZoneReentryInput): TroughZoneReentryResult {
	const { candles, first, mid, second, untilIdx, side } = input;
	const isBottom = side === 'bottom';

	const anchor = isBottom
		? Math.min(first.extremePrice, second.extremePrice)
		: Math.max(first.extremePrice, second.extremePrice);
	const height = isBottom ? mid.extremePrice - anchor : anchor - mid.extremePrice;
	const level = isBottom ? anchor + height * TROUGH_REENTRY_FRACTION : anchor - height * TROUGH_REENTRY_FRACTION;

	if (!(height > 0)) return { reentered: false, level };

	const end = Math.min(candles.length - 1, untilIdx);
	for (let i = second.idx + 1; i <= end; i++) {
		const close = candles[i]?.close;
		if (typeof close !== 'number' || !Number.isFinite(close)) continue;
		if (isBottom ? close <= level : close >= level) return { reentered: true, idx: i, level };
	}
	return { reentered: false, level };
}

/** 最終構成点 → ブレイクの経路検証の不合格理由コード。**種別を跨いで同じ語を使う**（issue #242）。 */
export type BreakoutPathRejectReason = 'peak_after_last_pivot' | 'trough_after_last_pivot';

/**
 * 継続系（`triangle_ascending` / `triangle_descending` / `pennant` / `bull_flag` / `bear_flag`）が
 * `status: 'invalid'` になる理由コード。**単一ソースはここ**（issue #291）。
 *
 * 継続系の `invalid` は「ブレイクはしたが**期待と逆方向**だった」の 1 条件しか無い
 * （`detect_triangles.ts` の `determineTriangleStatus`、`detect_pennants.ts` の status 判定）。
 * したがって値は 1 つで、検出器はそれを**リテラルで直書きせず**本定数から取る
 * ——`tests/detectPatternsViewsHandler.test.ts` の #286 網羅テストが
 * {@link ContinuationInvalidReason} から理由コードを導出しているため。
 *
 * `triangle_symmetrical` は期待方向を持たないので `invalid` にならず、`wedge_*` は
 * 逆方向を `outcome: 'failure'` で表して `invalid` を出さない。どちらも対象外。
 */
export const BREAKOUT_AGAINST_EXPECTATION = 'breakout_against_expectation' as const;

/** 継続系の `invalidReason` の全件（現状 1 値）。 */
export type ContinuationInvalidReason = typeof BREAKOUT_AGAINST_EXPECTATION;

export interface BreakoutPathInput {
	/** 走査対象のピボット列（`detectSwingPoints` の戻り値。並び順は仮定しない） */
	pivots: ReadonlyArray<Pivot>;
	/** 最終構成点の idx（double なら山2 / 谷2、triple なら山3 / 谷3、H&S なら右肩） */
	lastPivotIdx: number;
	/** ネックライン突破バーの idx */
	breakoutIdx: number;
	side: ReversalSide;
}

export interface BreakoutPathResult {
	/** 同種ピボットが区間内に 1 つでもあれば `true`（= 不合格） */
	found: boolean;
	/** `found` のときの理由コード */
	reason?: BreakoutPathRejectReason;
	/** 見つかった同種ピボットのうち**最も左のもの**（複数あっても 1 つだけ返す） */
	pivot?: Pivot;
}

/**
 * 最終構成点からネックライン突破バーまでの**経路**を検証する（issue #242）。
 *
 * 区間 `(lastPivotIdx, breakoutIdx)`（**両端を含まない**）に**同種のピボット**
 * （`side='top'` なら `kind='H'`、`'bottom'` なら `'L'`）が 1 つでもあれば不合格。
 *
 * ## なぜ要るか
 *
 * 反転パターンの「完成」は、最終構成点を付けた後に**そのままネックラインを割る**ことで成立する。
 * 途中でもう 1 つ山（谷）を作ってから割るのは、2 点（3 点）で反転したのではなく**別の形**
 * ——レンジの上限への 3 回目のタッチであったり、より大きな保ち合いの一部であったりする。
 *
 * ライブ実例（`btc_jpy` / `1hour` / `limit=72`、2026-09-05 実行。時刻は UTC）:
 *
 * | 役割 | idx | UTC | 終値 | 高安 |
 * |---|---:|---|---:|---:|
 * | 山1 | 41 | 09-03 21:00 | 12,718,980 | 12,807,555 |
 * | 谷（ネックライン） | 46 | 09-04 02:00 | 12,617,594 | 12,588,132 |
 * | 山2（最終構成点） | 50 | 09-04 06:00 | 12,639,245 | 12,800,000 |
 * | **再上昇の H ピボット** | **55** | **09-04 11:00** | **12,711,037** | **12,731,234** |
 * | ブレイク確認 | 56 | 09-04 12:00 | 12,396,727 | |
 *
 * 山2 の終値 12,639,245 から idx 55 の 12,711,037 まで、ネックライン 12,617,594 と山1 の
 * 中間（12,668,287）を超えて**半分以上戻してから**割っている。同じ区間を `detect_triangles` が
 * `triangle_ascending`（`status: invalid` = 下方ブレイク）として説明しており、値動きの読みは
 * そちらが正しい。
 *
 * ## 水準は問わない
 *
 * 「同水準の第3構成点か」は見ない。**再上昇の山が第1・第2構成点より低くても、そこにピボットが
 * ある時点で「最終構成点から直接割った」ではない。** 上の実例の idx 55 は高安基準で上 2 つより
 * 0.6% 低く、同水準判定（{@link DOUBLE_LEVEL_MAX_PCT} 等）で拾おうとすると閾値次第で漏れる。
 *
 * ## 既存の {@link detectTroughZoneReentry} との関係（どちらも要る）
 *
 * 再進入チェックは「パターン高さの {@link TROUGH_REENTRY_FRACTION} まで**終値が**戻ったか」を
 * 見る。上の実例ではゾーン下限 12,752,699 に対し idx 55 の終値が 0.3% 届かず、**発火しない**。
 * 逆に、ピボットにならない 1 本だけの戻しはゾーンに入っても本関数では拾えない。
 * **2 つは独立した検査**で、どちらか一方では上の実例も既存の実例も同時には塞げない。
 *
 * ## 閾値を持たない
 *
 * `mutual-exclusion.ts` と同じ原則で、つまみを増やさない。「ゾーン幅」「同水準の許容%」
 * のような可変量を持ち込むと、**閾値のどちら側に落ちるかで結論が変わる**候補が生まれ、
 * 実データ 1 件ごとに調整する誘惑が残る。ここは「区間に同種ピボットがあるか」の 0/1 だけを見る。
 *
 * ## 純粋関数。ピボット列の並び順は仮定しない
 *
 * `detectSwingPoints` は idx 昇順で返すが、本関数は早期 `break` をせず全件を走査して
 * **最も左の該当ピボット**を返す。呼び出し側が絞り込んだ配列を渡しても結果が変わらない。
 */
export function detectPivotBeforeBreakout(input: BreakoutPathInput): BreakoutPathResult {
	const { pivots, lastPivotIdx, breakoutIdx, side } = input;
	const kind: Pivot['kind'] = side === 'top' ? 'H' : 'L';
	let hit: Pivot | undefined;
	for (const p of pivots) {
		if (!p || p.kind !== kind) continue;
		if (!Number.isFinite(p.idx)) continue;
		// 両端は含まない。最終構成点そのもの・ブレイク足そのものは「間」ではない。
		if (p.idx <= lastPivotIdx || p.idx >= breakoutIdx) continue;
		if (!hit || p.idx < hit.idx) hit = p;
	}
	if (!hit) return { found: false };
	return {
		found: true,
		reason: side === 'top' ? 'peak_after_last_pivot' : 'trough_after_last_pivot',
		pivot: hit,
	};
}
