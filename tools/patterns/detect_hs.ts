/**
 * Head & Shoulders / Inverse Head & Shoulders 検出（完成済み＋形成中）
 * detect_patterns.ts Section 3 から抽出
 *
 * 完成済み構造の右肩形成後にネックライン突破が確認できた場合は
 * confirmation = 'neckline_breakout' を立てて status = 'completed' を付与する
 * （detect_doubles / detect_triples と同方針）。未確認の場合は
 * status = 'near_completion' + confirmation = 'not_confirmed' で返し、
 * detect_patterns 側の `!p.status` フォールバックで誤って completed 扱い
 * されるのを防ぐ。ネックラインは 2 点を結ぶ傾きつきラインとして外挿する。
 */
import { generatePatternDiagram } from '../../lib/pattern-diagrams.js';
import { patternBarRange } from './bar-thresholds.js';
import { finalizeConf, periodScoreDays } from './helpers.js';
import { clamp01, relDev } from './regression.js';
import { applyPostBreakoutGates, applyReversalGate, buildStructureGate } from './reversal-gate.js';
import { averageDefinedAxes, breakoutQualityScore, retracementScore } from './scoring.js';
import {
	HS_NECKLINE_MAX_PCT,
	HS_SHOULDER_MAX_PCT,
	isSameLevel,
	necklineSideDetailsFromAt,
	type PriorTrendResult,
	type ReversalSide,
	validateHorizontalNeckline,
	validateMainPointsAgainstNecklineAt,
	validatePatternSize,
	validatePriorTrend,
} from './structural.js';
import type { Pivot } from './swing.js';
import { computeTargetReach, omittedTargetReach, targetReachFields } from './target-reach.js';
import type {
	CandleData,
	DeduplicablePattern,
	DetectContext,
	DetectResult,
	PatternConfirmation,
	PatternPrecedingTrend,
	PatternScoreBreakdown,
} from './types.js';

// ── Helper: PriorTrendResult → PatternPrecedingTrend ──

function buildPrecedingTrend(
	candles: CandleData[],
	trend: PriorTrendResult,
	startIdx: number,
): PatternPrecedingTrend | undefined {
	const startIso = candles[trend.priorStartIdx]?.isoTime;
	const endIso = candles[startIdx]?.isoTime;
	if (!startIso || !endIso) return undefined;
	return {
		start: startIso,
		end: endIso,
		direction: trend.classification,
		returnPct: Number((trend.priorReturn * 100).toFixed(2)),
		lookbackBars: trend.lookbackBars,
	};
}

// ── 定数 ──

const RELAXED_FACTORS = [
	{ shoulder: 1.6, head: 0.6, tag: 'x1.6_0.6' },
	{ shoulder: 2.0, head: 0.4, tag: 'x2.0_0.4' },
] as const;

/**
 * `RELAXED_FACTORS` の末尾の段か。**relaxed の棄却エントリはここでだけ積む**（issue #174）。
 *
 * `findRelaxedHS` / `findRelaxedInverseHS` のループは「段が外・窓が内」なので、
 * **同じ窓が最大 2 回評価される**（`x1.6_0.6` で全窓 → 見つからなければ `x2.0_0.4` で全窓）。
 * 両段で積むと 2 つの害がある:
 *
 * - `detect_patterns.ts` の `cap = 200` を窓あたり最大 2 件で食い潰す
 * - **`x1.6_0.6` 段の肩落ちは最終的な棄却ではない**（同じ窓が `x2.0_0.4` で通りうる）のに
 *   「棄却」として残り、`view=debug` の読み手を誤らせる
 *
 * 段は緩くなる順に走り成功で早期 `return` するので、**末尾の段まで到達して落ちた窓**が
 * 「relaxed でも救えなかった窓」になる。逆に relaxed が成功した呼び出しでは末尾の段に
 * 到達せず棄却エントリが 1 件も残らないが、そのときは `fallback_relaxed` の
 * `accepted: true` が積まれるので「なぜ何も出ないのか」を追う用途には影響しない。
 *
 * **ネックラインについては**段に依存しない（`validateHorizontalNeckline` に factors が入らない）
 * ため、落ちる窓の集合は末尾の段が上位集合になる。**肩では集合の向きが逆**——肩の閾値は
 * 末尾の段のほうが緩い（`shoulder: 1.6` → `2.0`）ので、肩で落ちる窓は `×1.6` 段のほうが多く、
 * 末尾の段は部分集合になる。それでも取りこぼしが無い根拠は上の 2 つ目の箇条書きと同じで、
 * 「`×1.6` で落ちて `×2.0` で通る窓は最終的な棄却ではないので報告すべきでない」。
 */
function isFinalRelaxedStage(factors: (typeof RELAXED_FACTORS)[number]): boolean {
	return factors === RELAXED_FACTORS[RELAXED_FACTORS.length - 1];
}

const FORMING_RIGHT_TOLERANCE_PCT = 0.08;
/**
 * 形成中 H&S / 逆 H&S の形成期間の上限の日数由来。**実効値はバー数**で、
 * `getHsFormingBarParams` が `patterns/bar-thresholds.ts` の換算を通して決める。
 */
const FORMING_MAX_DAYS = 90;
/**
 * 形成中 H&S / 逆 H&S の形成期間の下限の日数由来。**実効値はバー数**で、
 * `getHsFormingBarParams` が `patterns/bar-thresholds.ts` の換算を通して決める。
 * ここの日数は「その値がどこから来たか」を示す注記であって、暦日数の要件ではない。
 */
export const FORMING_MIN_DAYS = 21;
/**
 * 形成中 H&S / 逆 H&S の完成度の下限。
 *
 * **現行の定数では到達しない。** `completion = min(1, (0.75 + 0.25 * progress) * (暫定右肩なら 0.9))`
 * で `progress ∈ [0, 1]` なので最小値は `0.75 * 0.9 = 0.675` になり、0.4 を下回れない
 * （実測でも合成 704 + 実データ 96 ケースで発火 0）。重み側（0.75 / 0.25 / 0.9）を触ったときに
 * 効き始めるガードとして残してあり、`completion_below_min` の理由コードもそのために積む。
 */
export const FORMING_MIN_COMPLETION = 0.4;
// detect_triples.ts と同値。形状不十分な forming 候補を上位表示させないための最低 confidence。
const FORMING_MIN_CONFIDENCE = 0.5;

/**
 * 形成中 H&S / 逆 H&S が要求する形成バー数のレンジ
 * （`formationBars = 右肩.idx - 左肩.idx`）。
 *
 * 旧実装は `patternDays = Math.round(formationBars × 手書き daysPerBar)` を作って 21〜90 日で
 * 判定していた。手書きの換算（`1day`→1 / `1week`→7 / **それ以外→1**）は intraday と `1month` を
 * 「1 日 / 本」に落とすため、`1month` は 21 バー = 21 ヶ月を要求し、intraday では日数閾値が
 * 偶然そのままバー数閾値として効いていた（issue #118 問題 3）。
 *
 * `detect_triples` の形成中判定（`getTripleFormingBarParams`）と同じ換算に統一してある
 * （日数由来も 21〜90 日で同値なので、両者の値は時間足を問わず一致する）。
 * `patterns/min-bars.ts` が「時間足 → 最小要求バー数」を導出するのに参照するため export する。
 */
export function getHsFormingBarParams(tf: string): { minBars: number; maxBars: number } {
	return patternBarRange(tf, FORMING_MIN_DAYS, FORMING_MAX_DAYS);
}

/**
 * 形成中 H&S / 逆 H&S の頭候補を**新しい順**に並べる（issue #154）。
 *
 * 旧実装は頭を「スキャン窓全体の最高値ピーク（逆 H&S は最安値の谷）」1 点に決め打ちし、
 * 他の頭候補を一切試さなかった。この決め方は**スキャン窓の左端に依存する**ため、
 * `limit` を上げて窓を広げると頭が過去側へ飛び、狭い窓で見えていた形成中パターンが
 * **候補として列挙されすらしなくなる**（#154 の症状: 1day で limit=90 → 1 件 /
 * limit=200 → 0 件）。窓を広げただけで検出が消えるのは利用者の期待に反する。
 *
 * **新しい順に列挙するのが単調性の鍵。** ピボット判定は前後 `swingDepth` 本だけを見る局所判定
 * なので、窓を左へ広げて増えるのは**より古い**頭候補だけで、既存の候補列の後ろに積まれる。
 * 列挙順が新しい順なら、広い窓は狭い窓の列挙を**接頭辞として含む**——狭い窓で見つかった
 * パターンは広い窓でも同じ頭から同じように見つかる。
 */
function headCandidatesNewestFirst<T extends Pivot>(list: readonly T[]): T[] {
	return [...list].sort((a, b) => b.idx - a.idx);
}

/**
 * 頭が**その形成区間の極値である**ことを検査する（issue #154）。
 *
 * 旧実装は頭を「窓全体の最高値ピーク / 最安値の谷」に決め打ちしていたため、この条件は
 * **暗黙に成立していた**（窓全体の極値は当然その部分区間の極値でもある）。頭候補を総当たりに
 * 変えるとこの暗黙の保証が外れ、`[左肩, 右肩]` の内側に頭より極端な同種ピボットがあっても
 * 通ってしまう（実測: `completed_falling_wedge` fixture が頭 idx 12=112 で逆 H&S として通り、
 * 同区間に idx 33=100 が居た）。区間内により極端な同種ピボットがあるなら、それは頭の取り違え。
 *
 * **判定は区間の内側だけを見るのでスキャン窓に依存しない**——単調性を壊さずに暗黙の保証を戻す。
 *
 * **比較は `price`（終値）で行い、`extremePrice`（ヒゲ）では行わない。** 戻そうとしている暗黙の
 * 保証が `confirmedPeaks.reduce((best, p) => p.price > best.price ? ...)`、すなわち**終値基準の
 * 極値**だったため。ヒゲ基準にすると別の（より厳しい）不変条件を課すことになり、旧実装が通していた
 * 読みを落としかねない。`swing.ts` が「判定は high/low、格納価格は close（ヒゲ影響を回避）」と
 * 定めているとおり、本ファイルの構造比較（左肩の 3% 判定・右肩の近接判定）もすべて `price` 側で
 * 揃っている。実測でも両者の差は出ない——合成 704 ケース + 実データ 288 ケースのいずれも差分 0。
 */
function headIsExtremeInSpan(
	sameKindPivots: readonly Pivot[],
	head: Pivot,
	fromIdx: number,
	toIdx: number,
	isTop: boolean,
): boolean {
	return !sameKindPivots.some(
		(p) =>
			p.idx > fromIdx && p.idx < toIdx && p.idx !== head.idx && (isTop ? p.price > head.price : p.price < head.price),
	);
}

// ── ネックラインブレイク検出（detect_doubles / detect_triples と同値の 1.5% バッファ） ──
// H&S は傾きつきネックライン（谷1→谷2 / 山1→山2）を外挿して判定する。
const HS_BREAKOUT_BUFFER_PCT = 0.015;
/**
 * 右肩から最大何バー後までブレイクをスキャンするか。`aftermath.ts` と同じ 30 を採用。
 * 例: 日足で右肩から約 4 週間後までのブレイクを拾える。
 *
 * **時間足に依らない固定値**で、#242 の経路ゲート（右肩とブレイクの間に同種のピボットがあれば
 * `peak_after_last_pivot` / `trough_after_last_pivot` で落とす）と組み合わさる。結果として
 * **右肩とブレイクの間にピボットが立たない形しか完成済みにならない**。1 時間足では 30 本の間に
 * ピボットが 1 つも立たないことは既定の `swingDepth=3` ではほぼ無いので、実質「右肩の直後 数本以内に
 * 割った形」だけが通る——実データ B / C / D の 1hour では完成済み `head_and_shoulders` は 0 件で、
 * 目視でも H&S と呼べる形は無い（#249 Phase 1）。#242 前は右肩 → ブレイクが中央値 28 本と
 * **上限 30 の 93% に張り付いて**おり、この窓が実効的な律速だった。逆 H&S は同コーパスで
 * 中央値 8 本 / max 9 本なので影響を受けていない。
 *
 * **値も時間足別化も据え置く**（#249 案 D。「0 件が正しい」ことを目視で確認済み）。
 * あわせて**完成済み経路にはパターン全長の上限が無い**（形成中経路の
 * `getHsFormingBarParams(tf).maxBars` に相当するものが無い）。上限の追加は #249 案 C として保留し、
 * #244（時間足別テーブル）で再検討する。
 *
 * 詳細は tjackiet/bitbank-lab-mcp#249 の計測記録 / `docs/tools.md`。
 */
const HS_BREAKOUT_MAX_BARS = 30;

// ── Helper: ネックライン補間 ──

type NecklinePt = { x: number; y: number };

/**
 * ネックライン（2 定義点で張る直線）の `i` 本目の水準。
 *
 * **定義点の外側は外挿しない**（issue #211）。`i` を `[min(a.x, b.x), max(a.x, b.x)]` へ丸めてから
 * 内挿するので、区間の外では直近の定義点の `y` で頭打ちになる。ネックラインは `p1` / `p3` の
 * 2 点でしか定義されておらず、その外側の値は「教科書の直線を伸ばしたらこうなるはず」という
 * モデル上の仮定であって、実際のサポート / レジスタンスの根拠が無いため。
 *
 * クランプは**この関数 1 箇所**で掛ける。消費者は 3 系統（ブレイク検出 `findHsBreakoutIdx`、
 * スコアリングの `necklinePrice`、ターゲット投影 `necklineProjectionTarget`）あるが、
 * すべて `necklineAt` / `necklineAtOr` を経由しており、消費者ごとにクランプ有無を分けると
 * 組み合わせ 8 通りをテストしないと挙動を保証できなくなる（#211 Phase 1 の計測 3 で、
 * ブレイク検出をクランプするかどうかでスコアリング側の効果の向きが反転することを確認済み）。
 *
 * 水平ネックライン（`a.y === b.y`。relaxed 経路と一部の forming 経路）ではクランプは恒等。
 * 頭の真下（`necklineProjectionHeight`）も頭が 2 定義点の**内側**にあるので恒等で、
 * パターン高さはクランプの前後で変わらない。
 *
 * **`i` が非有限なら `NaN`**（`necklineAtOr` はこれを fallback に畳む）。丸めより手前で弾くのは、
 * `Math.min` / `Math.max` が `±Infinity` を端点へ丸めてしまい、**壊れた添字に対して端点の `y` という
 * もっともらしい有限値**を返すため（CodeRabbit の指摘。PR #239 レビュー。クランプ導入前は
 * `±Infinity` がそのまま伝播して fallback に落ちていた）。`b.x === a.x` の退化ケースより手前に
 * 置くのは、「添字が壊れているなら水準を出さない」を経路によらず一定にするため。
 *
 * 添字の妥当性そのものは呼び出し側で担保する（`necklineProjectionTarget` の docstring を参照）。
 * export しているのは**この非有限ガードとクランプを直接テストするため**——2 つの export
 * （`necklineProjectionTarget` / `necklineProjectionHeight`）はどちらも添字を先に検査するので、
 * それら経由では非有限の経路に到達できない。
 */
export function necklineAt(neckline: NecklinePt[] | undefined, i: number): number {
	if (!Array.isArray(neckline) || neckline.length < 2) return NaN;
	const [a, b] = neckline;
	if (!(Number.isFinite(a?.x) && Number.isFinite(b?.x) && Number.isFinite(a?.y) && Number.isFinite(b?.y))) return NaN;
	if (!Number.isFinite(i)) return NaN;
	if (b.x === a.x) return a.y;
	// 定義点の区間へ丸める（#211）。`a.x < b.x` は現行 4 経路すべてで成り立つが、
	// 順序に依存しない形にしておく（逆順で張られたら外挿ではなく常に片端へ潰れるため）。
	const clampedI = Math.min(Math.max(a.x, b.x), Math.max(Math.min(a.x, b.x), i));
	return a.y + ((b.y - a.y) * (clampedI - a.x)) / (b.x - a.x);
}

// ── Helper: ネックライン射影ターゲット ──

/**
 * `targetMethod: 'neckline_projection'` の値幅を 1 箇所で出す（issue #208）。
 *
 * 教科書の H&S の値幅は「**頭からネックラインまでの高さ**を、ブレイク点のネックラインから
 * 投影する」。高さの測定基準は `headIdx`（頭の真下）に固定し、投影の**起点だけ**を
 * `anchorIdx`（strict / relaxed はブレイク足または右肩、forming は最終構成点）にする。
 *
 * 両方を `anchorIdx` にしていたのが #208 の欠陥で、`necklineAt` の**外挿距離ぶん高さが歪む**。
 * 実データ B の 1hour ケースでは定義点から 17 本外挿した結果、高さが 1/2.34 に潰れて
 * 下方向 H&S の target がブレイク終値より 39,079 円**上**に着地し、`targetReached` が
 * ブレイク直後に無条件で立っていた。
 *
 * `necklineAt` は #211 で**全消費者を統一してクランプした**（定義点の外側では直近の定義点の `y` で
 * 頭打ちになる）。ブレイク検出（`findHsBreakoutIdx`）・スコアリングの `necklinePrice` も同じ関数を
 * 通るので、投影の起点だけがクランプされる／されないという食い違いは起きない。
 *
 * 高さが 0 以下（外挿したネックラインが頭を追い越した）場合は **target を出さない**。
 * `validateHorizontalNeckline` が |谷1 − 谷2| <= `HS_NECKLINE_MAX_PCT` を課しており、頭は
 * ネックラインより上（逆 H&S は下）が保証されるので、頭の真下で測る限り構造的には起きない
 * 経路だが、`neckline` の張り方が経路ごとに違う（forming は先行谷 → 頭後の谷）ので念のため置く。
 *
 * @param direction 'down' = H&S（下方向）/ 'up' = 逆 H&S（上方向）
 * @param fallbackNecklinePrice `necklineAt` が NaN を返したときに使う代表水準（strict は谷の平均、
 *   relaxed / forming は検出器自身が使っている水平線の y）
 *
 * export しているのは**高さ 0 以下ガードを直接テストするため**。3 経路とも頭がネックラインの
 * 2 定義点の外側に来ない（頭は 2 点の間にあり、内挿値は必ず両端の間に収まる）ので、検出器
 * 経由ではガードに到達できない——標準コーパス 896 ケースでも発火 0 件。
 */
export function necklineProjectionTarget(args: {
	neckline: NecklinePt[];
	anchorIdx: number;
	headIdx: number;
	headPrice: number;
	direction: 'down' | 'up';
	fallbackNecklinePrice: number;
}): number | undefined {
	const { neckline, anchorIdx, direction, fallbackNecklinePrice } = args;
	// **添字は fallback の対象外**。`fallbackNecklinePrice` は「`neckline` の張り方が壊れている」
	// ときの代表水準であって、添字が壊れているときの代替ではない。`necklineAt` は非有限の `i` に
	// NaN を返し、`necklineAtOr` がそれを fallback に畳むので、ここで先に弾かないと
	// **もっともらしい target を返してしまう**（本来は undefined を返すべき入力）。
	if (!Number.isFinite(anchorIdx)) return undefined;
	const height = necklineProjectionHeight(args);
	if (height === undefined) return undefined;
	const nlAtAnchor = necklineAtOr(neckline, anchorIdx, fallbackNecklinePrice);
	if (!Number.isFinite(nlAtAnchor)) return undefined;
	return Math.round(direction === 'down' ? nlAtAnchor - height : nlAtAnchor + height);
}

/** `necklineAt` が NaN のとき `fallback` に畳む。添字の妥当性は呼び出し側で担保すること。 */
function necklineAtOr(neckline: NecklinePt[], i: number, fallback: number): number {
	const v = necklineAt(neckline, i);
	return Number.isFinite(v) ? v : fallback;
}

/**
 * `necklineProjectionTarget` が投影する**値幅そのもの**（頭の真下のネックラインから頭までの高さ）。
 *
 * `computeTargetReach` の分母 `|target − breakoutPrice|` が退化しているかを判定するのに
 * **同じ高さ**が要る（issue #210）。target 側とここで別々に高さを組むと、片方だけ直したときに
 * 黙ってずれるので 1 箇所に寄せる。`necklineProjectionTarget` もこの関数を通す。
 *
 * 高さが 0 以下（外挿したネックラインが頭を追い越した）なら `undefined`。
 */
export function necklineProjectionHeight(args: {
	neckline: NecklinePt[];
	headIdx: number;
	headPrice: number;
	direction: 'down' | 'up';
	fallbackNecklinePrice: number;
}): number | undefined {
	const { neckline, headIdx, headPrice, direction, fallbackNecklinePrice } = args;
	if (!Number.isFinite(headIdx) || !Number.isFinite(headPrice)) return undefined;
	const nlAtHead = necklineAtOr(neckline, headIdx, fallbackNecklinePrice);
	if (!Number.isFinite(nlAtHead)) return undefined;
	const height = direction === 'down' ? headPrice - nlAtHead : nlAtHead - headPrice;
	if (!(height > 0)) return undefined;
	return height;
}

// ── Helper: 完成済み H&S の整合度サブスコア（issue #204 Phase 2） ──

/**
 * 完成済み H&S / 逆 H&S の整合度サブスコア（issue #204 Phase 2）。
 *
 * 旧実装は 4 経路すべてが `(tolMargin + symmetry + per) / 3` で、**`tolMargin` と `symmetry` は
 * 同じ `relDev(左肩, 右肩)`（以下 rd）から作られていた**（正規化が違うだけ）。実質 2 軸しか無く、
 * `1hour` / `per = 0.6` / strict では `confidence = 0.953333 − 7.7 rd` という rd の 1 次式に
 * 潰れていた（Phase 1・PR #205 が 4,349 行全件で検算済み。
 * tjackiet/bitbank-lab-mcp#204 の計測記録（Phase 1））。
 *
 * **`detect_doubles.ts` の `buildDoubleScore` と同じ選択で `symmetry` を残し `tolMargin` を捨てる。**
 * H&S も主構成点は 2 点（両肩）なので、triple が逆の選択（`levelMargin` を残す）になった事情
 * ——`tolMargin` が 3 ペア平均で中間点の情報を持つ——が無い。そのうえで H&S 固有の 2 軸を足す:
 *
 * | 軸 | 出所 | ネイティブ 89 構造での `r(rd)` |
 * |---|---|---:|
 * | `symmetry` | double と同じ `1 − rd` | −1.00（定義上 rd そのもの） |
 * | `headProminence` | 頭の突出ゲートに対する余裕（**本 PR で新設**） | −0.17 |
 * | `timeSymmetry` | 左右のバー数比（**本 PR で新設**。従来どこにも使われていなかった量） | −0.42 |
 * | `retracement` | 構造ゲートの戻り率（double / triple と共有） | 0.03 |
 * | `breakoutQuality` | 突破幅 ÷ パターン高さ（同上） | −0.50 |
 * | `duration` | `periodScoreDays`（据え置き） | 0.06 |
 *
 * **ネックライン水平度は足さない。** Phase 1 の実測で分散はあった（0.0000〜0.0499）が
 * rd との相関がネイティブで 0.725 あり、「肩がずれている構造はネックラインもずれている」という
 * 共変で rd の情報を重ねるだけになる。
 *
 * **`duration`（`periodScoreDays`）は本 PR では変えない。** triple（#199 Phase 1）と違い H&S の
 * `per` は 0.6 / 0.7 / 0.8 / 0.9 の 4 値すべてを取る生きた軸で、バー数基準への置き換えは
 * 別途評価が要る。ここで一緒に動かすと軸構成変更の寄与と分離できない。
 */
function buildHsScore(opts: {
	/** 左肩 / 右肩の `price`（並び順は結果に影響しない） */
	shoulders: readonly [number, number];
	/** 頭の `price` */
	headPrice: number;
	/** 左肩 / 頭 / 右肩の `idx`（時間対称性はこの 3 点のバー数で測る） */
	shoulderIdxs: readonly [number, number];
	headIdx: number;
	/**
	 * `headProminence` 軸の採点に使う閾値。**strict / relaxed とも `headProminencePct`**
	 * （= strict のゲート）を渡す。
	 *
	 * relaxed は**ゲート**を `headProminencePct × factors.head` まで緩めるが、**採点**は緩めない
	 * （issue #227 Phase 2）。緩めた側の閾値で採点すると「実効 0.33% のゲートをぎりぎり超えた構造」も
	 * 「strict の 0.83% を超えた構造」も同じように加点され、**緩めたことが整合度に反映されない**。
	 * strict のゲートで採点すれば、突出が strict の要求に届かない構造は
	 * `clamp01(1 - gate / prominence)` が 0 に落ちる（軸が消えるのではなく 0 点になる）。
	 */
	headProminenceGate: number;
	/** 突破足時点のネックライン値（`necklineAt(neckline, breakoutIdx)`） */
	necklinePrice: number;
	/** ブレイク足の終値。**未ブレイク（`near_completion`）では `NaN`** を渡す */
	breakoutClose: number;
	/**
	 * パターン高さ。**`necklineProjectionHeight`（頭の真下のネックラインから頭まで）と同じ値**を
	 * 渡すこと（issue #208 / #209）。ブレイク足時点のネックラインで測ると外挿距離ぶん高さが歪み、
	 * `breakoutQuality` が過大に飽和する（Phase 1 の実測では飽和 69.0%、頭の真下基準では 44.1%）。
	 * 高さが取れない場合は `undefined` を渡すと軸が落ちる。
	 */
	patternHeight: number | undefined;
	side: ReversalSide;
	retracementRatio?: number;
	durationScore: number;
}): { components: PatternScoreBreakdown; base: number } {
	const [s1, s2] = opts.shoulders;
	const symmetry = clamp01(1 - relDev(s1, s2));
	const headProminence = headProminenceScore(opts.headPrice, opts.shoulders, opts.side, opts.headProminenceGate);
	const timeSymmetry = timeSymmetryScore(opts.shoulderIdxs, opts.headIdx);
	const retracement = retracementScore(opts.retracementRatio);
	const breakoutQuality = breakoutQualityScore(
		opts.necklinePrice,
		opts.breakoutClose,
		opts.patternHeight ?? Number.NaN,
		opts.side,
	);
	const components: PatternScoreBreakdown = {
		symmetry: Number(symmetry.toFixed(4)),
		...(headProminence !== undefined ? { headProminence: Number(headProminence.toFixed(4)) } : {}),
		...(timeSymmetry !== undefined ? { timeSymmetry: Number(timeSymmetry.toFixed(4)) } : {}),
		...(retracement !== undefined ? { retracement: Number(retracement.toFixed(4)) } : {}),
		...(breakoutQuality !== undefined ? { breakoutQuality: Number(breakoutQuality.toFixed(4)) } : {}),
		duration: Number(opts.durationScore.toFixed(4)),
	};
	// 算出できなかった軸は平均から外す（0 として混ぜると欠測が減点になる）。
	// `symmetry` は常に数値なので `averageDefinedAxes` が `undefined` を返すことはない。
	const base =
		averageDefinedAxes([symmetry, headProminence, timeSymmetry, retracement, breakoutQuality, opts.durationScore]) ??
		symmetry;
	return { components, base };
}

/**
 * 頭の突出ゲートに対する余裕（issue #204）。ゲートちょうどで 0、ゲートの 2 倍で 0.5、∞ で 1。
 *
 * 実測突出率は検出側のゲート（`p2.price > max(肩) * (1 + gate)` / 逆 H&S は
 * `p2.price < min(肩) * (1 - gate)`）と**同じ式**から出す——ゲートを通った候補なら必ず
 * `実測 > gate` になるので、この軸は `(0, 1)` に収まる。
 *
 * 上限が無い量（比は実測で最大 32 倍）を `1 − gate / 実測` で畳むのは、`marginFromRelDev` が
 * 上限ゲートに対して `1 − 実測 / 上限` を取るのと同じ発想の下限ゲート版。任意の飽和定数を
 * 置かずに済む。
 */
function headProminenceScore(
	headPrice: number,
	shoulders: readonly [number, number],
	side: ReversalSide,
	gate: number,
): number | undefined {
	const [s1, s2] = shoulders;
	const ref = side === 'bottom' ? Math.min(s1, s2) : Math.max(s1, s2);
	if (!(ref > 0) || !Number.isFinite(headPrice)) return undefined;
	const prominence = side === 'bottom' ? 1 - headPrice / ref : headPrice / ref - 1;
	if (!(prominence > 0)) return undefined;
	if (!(gate > 0)) return 1;
	return clamp01(1 - gate / prominence);
}

/**
 * 左肩→頭 と 頭→右肩 のバー数の釣り合い（issue #204）。1 = 左右が同じ長さ。
 *
 * **H&S 固有で、従来どこにも使われていなかった量。** Phase 1 の実測で候補軸のうち最も分散が
 * 広く（0.0556〜1.0000）、`symmetry`（レンジ幅 0.047）と違って実際に順位を動かす。
 */
function timeSymmetryScore(shoulderIdxs: readonly [number, number], headIdx: number): number | undefined {
	const [leftIdx, rightIdx] = shoulderIdxs;
	const left = headIdx - leftIdx;
	const right = rightIdx - headIdx;
	if (!(left > 0) || !(right > 0)) return undefined;
	return clamp01(Math.min(left, right) / Math.max(left, right));
}

// ── Helper: 右肩後のネックラインブレイクインデックスを検出 ──
// direction='below': H&S（close < necklineAt * (1 - buffer)）
// direction='above': 逆H&S（close > necklineAt * (1 + buffer)）

function findHsBreakoutIdx(
	candles: CandleData[],
	neckline: NecklinePt[],
	rightShoulderIdx: number,
	direction: 'below' | 'above',
): number {
	const end = Math.min(rightShoulderIdx + HS_BREAKOUT_MAX_BARS + 1, candles.length);
	for (let k = rightShoulderIdx + 1; k < end; k++) {
		const closeK = Number(candles[k]?.close ?? NaN);
		if (!Number.isFinite(closeK)) continue;
		const nlPrice = necklineAt(neckline, k);
		if (!Number.isFinite(nlPrice)) continue;
		if (direction === 'below' && closeK < nlPrice * (1 - HS_BREAKOUT_BUFFER_PCT)) return k;
		if (direction === 'above' && closeK > nlPrice * (1 + HS_BREAKOUT_BUFFER_PCT)) return k;
	}
	return -1;
}

// ── Helper: ブレイク確認済み / 未確認に応じた完成フィールド ──
//
// 確認済み: status='completed', confirmation=neckline_breakout, breakout 系メタ一式 + outcome='success'
// 未確認:   status='near_completion', confirmation=not_confirmed
//
// `!p.status` を completed 扱いする detect_patterns.ts のフォールバック対策として
// 未確認時にも status を明示的に設定する。

type HsCompletionFields = {
	status: 'completed' | 'near_completion';
	confirmation: PatternConfirmation;
	breakout?: { idx: number; price: number };
	breakoutBarIndex?: number;
	breakoutDate?: string;
	breakoutDirection?: 'up' | 'down';
	outcome?: 'success';
	rangeEnd: string;
};

function buildHsCompletionFields(
	candles: CandleData[],
	breakoutIdx: number,
	direction: 'down' | 'up',
	structureEndIso: string,
): HsCompletionFields | null {
	if (breakoutIdx < 0) {
		return {
			status: 'near_completion',
			confirmation: { type: 'not_confirmed' },
			rangeEnd: structureEndIso,
		};
	}
	const breakoutDate = candles[breakoutIdx]?.isoTime;
	const breakoutPrice = Number(candles[breakoutIdx]?.close ?? NaN);
	if (!breakoutDate || !Number.isFinite(breakoutPrice)) return null;
	return {
		status: 'completed',
		confirmation: {
			type: 'neckline_breakout',
			date: breakoutDate,
			idx: breakoutIdx,
			price: breakoutPrice,
		},
		breakout: { idx: breakoutIdx, price: breakoutPrice },
		breakoutBarIndex: breakoutIdx,
		breakoutDate,
		breakoutDirection: direction === 'down' ? 'down' : 'up',
		outcome: 'success',
		rangeEnd: breakoutDate,
	};
}

// ── Helper: 候補 5 点窓の生成（issue #146） ──

/** 候補 5 点窓。`p0`=左肩 / `p1`=谷1 / `p2`=頭 / `p3`=谷2 / `p4`=右肩（逆 H&S は谷↔山が入れ替わる）。 */
interface HsWindow {
	p0: Pivot;
	p1: Pivot;
	p2: Pivot;
	p3: Pivot;
	p4: Pivot;
}

/**
 * 探索する肩の組（左肩 × 右肩）の上限。
 *
 * 窓生成は肩リストの**全ペア**を見るので組数は肩の数の 2 乗で増える。`limit` の
 * スキーマ上限 365 本を最小の `swingDepth=2` で走らせても肩は 90 個前後（2 本に 1 つが
 * ピボット、その半分が肩）で 4,000 組ほどにしかならないため、実運用では到達しない。
 * 病的な入力（極端に多いピボット）で探索が発散しないための歯止めとして置く。
 */
const HS_MAX_SHOULDER_PAIRS = 5000;

/**
 * `list`（idx 昇順）から `(loIdx, hiIdx)` の**開区間**にある極値ピボットを返す。
 * `lower=true` なら最安値、`false` なら最高値。該当が無ければ `null`。
 *
 * 価格基準が `price`（終値）なのは `detect_triples` の谷 / 山の採用（`v.price < m.price`）と、
 * 既存の relaxed / 形成中 H&S の頭の採用（`p.price > best.price`）に合わせるため。
 * 後段の `headHigher` / `shouldersNear` / ネックラインも同じ `price` を見る。
 */
function extremeBetween(list: ReadonlyArray<Pivot>, loIdx: number, hiIdx: number, lower: boolean): Pivot | null {
	let best: Pivot | null = null;
	for (const p of list) {
		if (p.idx <= loIdx) continue;
		if (p.idx >= hiIdx) break;
		if (!best || (lower ? p.price < best.price : p.price > best.price)) best = p;
	}
	return best;
}

/**
 * 外側の脚（肩 ↔ 隣のネックライン点）に、`shoulder` を**明確に超える**肩が無いかを見る。
 *
 * 「明確に超える」は `HS_SHOULDER_MAX_PCT` を超えて高い（逆 H&S は低い）こと。同水準なら
 * 幅のある肩の一部として通す——双子の山で肩がわずかに低い側に当たっただけで窓が消えると、
 * 実在する H&S を落とすため（`enumerateHsWindows` の呼び出し箇所のコメント）。
 *
 * ## ここだけモジュール定数 5% のまま（時間足別にしない。issue #244 Phase 2）
 *
 * 肩ゲート（strict / relaxed の `shouldersWithinCap`）は #244 で
 * `ctx.hsShoulderMaxPct`（`getHsShoulderMaxPctForTf`。`1hour` で 1.04%）へ移したが、
 * **本関数だけは `HS_SHOULDER_MAX_PCT`（5%）を読み続ける。意図的な非対称。**
 *
 * **窓生成は緩く、肩ゲートで落として理由コードを残す。** 本関数で落とすと窓自体が
 * 生成されず、`view=debug` の candidates にも棄却理由が 1 行も残らない（**無音の偽陰性**）。
 * 肩ゲートまで通せば `shoulders_not_near:cap` が残り、LLM も呼び出し側も
 * 「なぜ出なかったか」を理由コードで追える。#178 の「誤って弾けば理由コードが出るが、
 * 誤って通せば無音」の非対称と同じ判断（#244 決定コメントの宿題 1）。
 *
 * **両者は落ちる集合が同じではない。** #244 Phase 1 の ablation は定数リテラルを差し替えたので
 * 窓生成も同時に締まり、**肩ゲートは通るのに窓生成で消える構造**が出ていた（結果 9(b) /
 * tjackiet/bitbank-lab-mcp#244 の計測記録 §9 の `btc_jpy_1day_2026` / `4hour` /
 * `20-24-27-53-80`。肩 1.228% < `4hour` の閾値 2.040%）。窓生成を据え置いた現行では
 * この構造は**残る**——Phase 2 の再計測（同 §11）で確認済み。
 */
function outerShoulderOk(
	shoulders: ReadonlyArray<Pivot>,
	shoulder: Pivot,
	loIdx: number,
	hiIdx: number,
	isTop: boolean,
): boolean {
	const outer = extremeBetween(shoulders, loIdx, hiIdx, !isTop);
	if (!outer) return true;
	const beyond = isTop ? outer.price > shoulder.price : outer.price < shoulder.price;
	if (!beyond) return true;
	return isSameLevel(outer.price, shoulder.price, HS_SHOULDER_MAX_PCT);
}

/**
 * 肩が同水準でないときの棄却理由コード（issue #172）。
 *
 * 肩の判定は**同じ指標（左右肩の相対差）を 2 つの閾値で測る AND**で、実効閾値は
 * `min(tolerancePct, HS_SHOULDER_MAX_PCT)`。ところが理由コードが `shoulders_not_near`
 * の 1 種類しかなかったため、**`view=debug` を `reason` で集計するとどちらのゲートで
 * 落ちたかが消えていた**。#152 / #167 はこれを見て「`HS_SHOULDER_MAX_PCT` が律速」と
 * 帰属し、存在しない偽陰性を追って issue が 2 本立った（実測では `HS_SHOULDER_MAX_PCT`
 * 律速は全時間足で 0 件、支配的なのは `:both`）。`view=debug` は LLM が理由コードで
 * 集計する導線（#144 / #145）なので、同じ誤読を LLM もする。
 *
 * 接尾辞はファイル内の既存 idiom（`prior_trend_mismatch:${classification}`）に合わせる。
 *
 * | コード | 意味 | 緩めれば通るか |
 * |---|---|---|
 * | `shoulders_not_near:tolerance` | `tolerancePct` のみ超過 | `tolerancePct` を緩めれば通る |
 * | `shoulders_not_near:cap` | {@link HS_SHOULDER_MAX_PCT} のみ超過 | 定数を緩めれば通る |
 * | `shoulders_not_near:both` | 両方超過 | **どちらを緩めても通らない** |
 *
 * `:cap` は `tolerancePct > 肩の上限` のときしか発火しない。**#244 Phase 2 で肩の上限が
 * 時間足別（`ctx.hsShoulderMaxPct` = `getHsShoulderMaxPctForTf`）になったので、発火条件が
 * 変わっている**——`1hour` 以下では tf-auto の `tolerancePct`（`1hour` 5% / `15min` `30min` 6%）が
 * 肩の上限（`1hour` 1.04% / `30min` 0.72% / `15min` 0.51%）を大きく上回るため、
 * **`:cap` が既定パスで普通に発火する。**
 *
 * | 時間足 | `tolerancePct`（tf-auto） | 肩の上限 | 既定パスで `:cap` が出るか |
 * |---|---|---|---|
 * | `1min` / `5min` / `15min` / `30min` | 0.04 / 0.04 / 0.06 / 0.06 | 0.13% / 0.29% / 0.51% / 0.72% | **出る** |
 * | `1hour` | 0.05 | **1.04%** | **出る** |
 * | `4hour` | 0.05 | 2.04% | **出る** |
 * | `8hour` / `12hour` | 0.045 | 2.89% / 3.54% | **出る** |
 * | `1day` / `1week` / `1month` | 0.04 / 0.035 / 0.03 | 5%（据え置き） | 出ない（`tolerancePct` が律速） |
 *
 * **#244 以前は「tf-auto では `15min` / `30min` だけ」だった。** 古い集計（`:cap` 0 件など）を
 * 読み替えるときはこの差に注意すること。`1day` 以上の発火条件は変わっていない——
 * そこでは今も呼び出し側が `tolerancePct` を 0.05 超で明示したときに限る。
 *
 * **strict 経路専用。** relaxed 経路は閾値が `tolerancePct × factors.shoulder` なので
 * {@link relaxedShouldersNotNearReason} を使う（issue #174）。分類そのものは
 * {@link shouldersNotNearSuffix} で共有する。
 */
function shouldersNotNearReason(withinTolerance: boolean, withinCap: boolean): string {
	return `shoulders_not_near:${shouldersNotNearSuffix(withinTolerance, withinCap)}`;
}

/**
 * {@link shouldersNotNearReason} / {@link relaxedShouldersNotNearReason} が共有する分類。
 *
 * 「どちらのゲートで落ちたか」は strict / relaxed で同じ 3 分類だが、**`tolerance` が指す
 * 閾値の実体が経路ごとに違う**（strict は `tolerancePct`、relaxed は
 * `tolerancePct × factors.shoulder`）。だからコード文字列は接頭辞で分け、分類だけを共有する。
 */
function shouldersNotNearSuffix(withinTolerance: boolean, withinCap: boolean): 'both' | 'cap' | 'tolerance' {
	if (!withinTolerance && !withinCap) return 'both';
	return withinTolerance ? 'cap' : 'tolerance';
}

/**
 * relaxed 経路で肩が同水準でないときの棄却理由コード（issue #174）。
 *
 * ## なぜ strict と別の接頭辞にするか
 *
 * **同じ 5 点が strict でも relaxed でも落ちうる。** 混ぜると `view=debug` を `reason` で
 * 集計したときに二重計上になり、#172 で直したばかりの内訳がまた壊れる。さらに閾値の実体が
 * 違うので、`:tolerance` を同じコードで束ねると「`tolerancePct` を緩めれば通る」の意味も
 * 経路ごとにズレる。接頭辞は同ファイルの既存 idiom（`forming_` #158 / PR #166）に合わせた。
 *
 * | コード | 意味 | 緩めれば通るか |
 * |---|---|---|
 * | `relaxed_shoulders_not_near:tolerance` | `tolerancePct × factors.shoulder` のみ超過 | `tolerancePct` を緩めれば通る |
 * | `relaxed_shoulders_not_near:cap` | {@link HS_SHOULDER_MAX_PCT} のみ超過 | 定数を緩めれば通る |
 * | `relaxed_shoulders_not_near:both` | 両方超過 | **どちらを緩めても通らない** |
 *
 * relaxed の実効閾値は `min(tolerancePct × factors.shoulder, ctx.hsShoulderMaxPct)` で、
 * **既定パスでは全時間足で肩の上限が律速する**（{@link HS_SHOULDER_MAX_PCT} の docstring の表）。
 * したがって `:cap` は既定パスでも普通に出る。#244 Phase 2 で肩の上限が時間足別になり、
 * `1hour` 以下では strict 側でも `:cap` が既定パスで出るようになった（strict と relaxed の
 * 違いは `:cap` の出る / 出ないではなく、`tolerance` が指す閾値の実体だけになっている）。
 */
function relaxedShouldersNotNearReason(withinTolerance: boolean, withinCap: boolean): string {
	return `relaxed_shoulders_not_near:${shouldersNotNearSuffix(withinTolerance, withinCap)}`;
}

/**
 * H&S / 逆 H&S の候補 5 点窓を列挙する（issue #146）。
 *
 * 旧実装は `pivots` の**配列上で連続する 5 点**を取り、それが `H-L-H-L-H`（逆は `L-H-L-H-L`）
 * であることを要求していた。この「交互列要求」は 2 通りの実データの崩れ方に脆い:
 *
 * - 浅い谷が `swingDepth` の粒度で消え、左肩と頭が `H→H` で連続する
 * - 頭の直後に別の高値が挟まり、頭より右の交互が崩れる
 *
 * どちらも**頭を中心とした窓が一度も生成されない**ため、`view=debug` の candidates にも
 * 棄却理由が残らない（「候補は生成されるが判定で落ちる」#138 / #139 / #140 とは別クラスの偽陰性）。
 *
 * そこで `detect_triples` の窓生成（山リストだけを見て 3 山を取り、間に何が挟まっても窓は作る）に
 * 寄せる。**肩リストから肩 2 つを取り、その間の最高値（逆 H&S は最安値）を頭に、
 * 谷は「肩と頭の間」の各区間から取る。**
 *
 * **本関数の窓は旧実装の窓の上位集合で、それは交互列が崩れていない区間でも同じ。**
 * 肩 2 つの間に肩が 1 つだけの組（`gap=2`）は旧実装と同じ 5 点になるが、
 * **間に肩を跨ぐ組（`gap>=3`）は旧実装が作れなかった窓**で、これは厳密に交互する列
 * （`H L H L H L H`）でも出る。例えば肩 `h0 h1 h2 h3` の `(h0, h3)` は、間の最高値
 * `max(h1, h2)` を頭に、`h1`（または `h2`）と間の谷 1 つを跨いだ 5 点になる。
 * **#146 の 5 点自体が `gap=3` の窓**（肩リスト `[左肩, 頭, 余計な高値, 右肩]` の第 1 と第 4）なので、
 * `gap=2` に限れば本 issue は解けない。
 *
 * 増えるのは窓であって検出ではない。品質保証は窓生成ではなく後段のゲート
 * （サイズ検査 #139 / 構造ゲート #140 / 先行トレンド / ネックライン水平性）が担う設計で、
 * 実測でも合成 fixture 704 ケースの `data.patterns` は完全一致・実データ 96 ケースは
 * 追加のみ・消失ゼロだった（CHANGELOG）。
 *
 * **列挙順は「肩リスト上の間隔（`gap`）が狭い順」。** 旧実装が作れた窓は必ず `gap=2` なので、
 * これで**狭い（＝より具体的な）読みが先に並ぶ**。窓を全件評価する strict 経路では
 * 順序は結果に効かないが、順序依存の呼び出し元を後から足したときに
 * 「まず狭い窓を見る」ことが保証されるようにしてある。
 *
 * **本関数を使うのは strict の 2 経路だけで、`findRelaxedHS` / `findRelaxedInverseHS` は
 * 旧実装のまま**（意図的な限定。#146）。relaxed は `RELAXED_FACTORS` を厳しい段から
 * 順に試して**最初に条件を満たした窓で早期 `return`** するため、窓が増えると緩い段へ
 * 落ちる前に厳しい段が別の窓を拾い、実データで**完成済み H&S が `near_completion` に
 * 置き換わって消える**（実測は CHANGELOG）。strict だけなら実データ 96 ケースで
 * 差分は**追加のみ・消失ゼロ**。#146 の 5 点は strict の許容誤差で通るので、
 * relaxed へ広げなくても本 issue は解ける。
 *
 * 窓にしない組は 2 つ:
 * - 谷が片側でも取れない組（ネックラインの 2 点が張れない）
 * - 肩が窓の最高値（逆 H&S は最安値）になる組。どう読んでも H&S ではないので
 *   候補にせず `view=debug` も汚さない。**許容誤差のマージン不足はここでは落とさない**
 *   ——それは窓生成ではなく判定の問題で、`head_not_higher` として debug に残す価値がある
 */
function enumerateHsWindows(ctx: DetectContext, side: 'top' | 'bottom'): HsWindow[] {
	const { pivots, minDist } = ctx;
	const isTop = side === 'top';
	const shoulders = pivots.filter((p) => p.kind === (isTop ? 'H' : 'L'));
	const mids = pivots.filter((p) => p.kind === (isTop ? 'L' : 'H'));
	const windows: HsWindow[] = [];
	let pairs = 0;

	// gap = 肩リスト上の左肩 → 右肩の距離。間に肩が 1 つ以上要るので 2 から始める。
	for (let gap = 2; gap < shoulders.length; gap++) {
		for (let i = 0; i + gap < shoulders.length; i++) {
			if (++pairs > HS_MAX_SHOULDER_PAIRS) return windows;
			const p0 = shoulders[i];
			const p4 = shoulders[i + gap];
			// 頭は肩 2 つの間の最高値（逆 H&S は最安値）。
			const p2 = extremeBetween(shoulders, p0.idx, p4.idx, !isTop);
			if (!p2) continue;
			if (isTop ? !(p2.price > p0.price && p2.price > p4.price) : !(p2.price < p0.price && p2.price < p4.price))
				continue;
			// ネックラインの 2 点は「肩と頭の間」の各区間の最安値（逆 H&S は最高値）。
			const p1 = extremeBetween(mids, p0.idx, p2.idx, isTop);
			const p3 = extremeBetween(mids, p2.idx, p4.idx, isTop);
			if (!p1 || !p3) continue;
			// **外側の脚（肩 ↔ 隣のネックライン点）に、肩を明確に超える肩があってはならない。**
			// 超えているなら、その肩こそが左肩 / 右肩であって、この組は肩を取り違えた読みでしかない
			// （取り違えていない読みは別の組として列挙されるので、パターンを落とすのではなく
			// 誤った anchor を落とすだけ）。
			//
			// **「明確に超える」を `HS_SHOULDER_MAX_PCT`（5% 固定。`ctx.hsShoulderMaxPct` ではない）で
			// 測るのが肝。** 窓生成をここで締めると `view=debug` が無音になるので、時間足別の値は
			// 肩ゲートにだけ適用する（#244 Phase 2。`outerShoulderOk` の docstring）。単純な `>` にすると、
			// 双子の山（実データの BTC/JPY 日足 idx 38 と 42 は差 0.08%）で肩がわずかに低い側に
			// 当たっただけで窓が消え、**実在する H&S を落とす**（実測で実データの改善が全て消えた）。
			// 同水準なら「幅のある肩」の一部とみなして通し、肩として別格に高いものだけを弾く。
			if (!outerShoulderOk(shoulders, p0, p0.idx, p1.idx, isTop)) continue;
			if (!outerShoulderOk(shoulders, p4, p3.idx, p4.idx, isTop)) continue;
			if (
				p1.idx - p0.idx < minDist ||
				p2.idx - p1.idx < minDist ||
				p3.idx - p2.idx < minDist ||
				p4.idx - p3.idx < minDist
			)
				continue;
			windows.push({ p0, p1, p2, p3, p4 });
		}
	}
	return windows;
}

// ── Helper: Strict Inverse H&S (L-H-L-H-L) ──

function findStrictInverseHS(ctx: DetectContext): { patterns: DeduplicablePattern[]; found: boolean } {
	const { candles, pivots, tolerancePct, headProminencePct, near, debugCandidates } = ctx;
	const patterns: DeduplicablePattern[] = [];
	let found = false;

	for (const { p0, p1, p2, p3, p4 } of enumerateHsWindows(ctx, 'bottom')) {
		// 肩は 2 ゲートの AND。どちらの conjunct で落ちたかを `reason` に出すため短絡評価をやめて
		// 別々に評価する（`near` / `isSameLevel` とも副作用の無い純粋比較なので判定は不変。issue #172）。
		const shouldersWithinTolerance = near(p0.price, p4.price);
		const shouldersWithinCap = isSameLevel(p0.price, p4.price, ctx.hsShoulderMaxPct);
		const shouldersNear = shouldersWithinTolerance && shouldersWithinCap;
		const headLower = p2.price < Math.min(p0.price, p4.price) * (1 - headProminencePct);
		const necklineCheck = validateHorizontalNeckline(p1.price, p3.price, HS_NECKLINE_MAX_PCT);
		if (shouldersNear && headLower && necklineCheck.ok) {
			const start = candles[p0.idx].isoTime;
			const end = candles[p4.idx].isoTime;
			if (start && end) {
				const trend = validatePriorTrend(candles, p0.idx, p4.idx - p0.idx, 'down_or_sideways');
				if (!trend.ok) {
					debugCandidates.push({
						type: 'inverse_head_and_shoulders',
						accepted: false,
						reason: `prior_trend_mismatch:${trend.classification}`,
						indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					});
					continue;
				}
				if (trend.classification === 'insufficient_data') {
					debugCandidates.push({
						type: 'inverse_head_and_shoulders',
						accepted: true,
						reason: 'prior_trend_insufficient_data',
						indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					});
				}
				// サイズ検査（#138 欠陥 2-2）。配置が最後なのは `validatePatternSize` の docstring を参照。
				const sizeReason = validatePatternSize('bottom', [p0, p1, p2, p3, p4], ctx.sizeThresholds);
				if (sizeReason) {
					debugCandidates.push({
						type: 'inverse_head_and_shoulders',
						accepted: false,
						reason: sizeReason,
						indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					});
					continue;
				}
				const neckline = [
					{ x: p1.idx, y: p1.price },
					{ x: p3.idx, y: p3.price },
				];
				const nlAvg = (Number(p1.price) + Number(p3.price)) / 2;

				// ネックライン水準は**ブレイク判定（findHsBreakoutIdx）に渡す線と同じ**ものを構造ゲートへ渡す
				// （`ReversalStructureInput.necklinePrice` の docstring）。線は p1 / p3 の 2 点で張るが、
				// ゲートは第1構成点より手前を遡るので**スカラーの水準**が要る。`validateHorizontalNeckline` が
				// 既に |p1 - p3| <= HS_NECKLINE_MAX_PCT を課しているため、2 点の平均が線の代表値になる。
				// 傾きを外挿して遡ると、探索窓 60 本ぶんの外挿誤差が水準そのものより大きくなり得る。
				// 構造ゲート（#138 欠陥 2-1）。#131 が double にだけ入れたものの横展開。
				// サイズ検査と同じく「既存の棄却検査をすべて通過した後」に置く。
				const gate = applyReversalGate({
					candles,
					pivots,
					side: 'bottom',
					first: p0,
					mid: p1,
					necklinePrice: nlAvg,
					type: 'inverse_head_and_shoulders',
					indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					debugCandidates,
				});
				if (!gate) continue;
				const structureGate = buildStructureGate(gate);

				// 主構成点とネックラインの位置関係（issue #216 Phase 2 の H&S 分）。**`applyReversalGate` の直後**
				// ——配置の理由は `validatePatternSize` の docstring（「既存の棄却検査をすべて通過した後」）と
				// 同じで、固有の理由コードを持つ候補の `reason` を横取りしないため。判定の実体と根拠は
				// `validateMainPointsAgainstNecklineAt` の docstring が単一ソース。
				//
				// **検査するのは `[p0, p2, p4]`（左肩・頭・右肩）だけ。** `p1` / `p3` はネックラインの
				// 定義点そのものなので、渡すと自分自身と比較する検査になり無意味（`deviation === 0` で
				// 必ず失格する）。基準は**ブレイク検出・スコアリング・ターゲット投影と同じ `necklineAt`**
				// で、肩は #211 のクランプにより「近い方の定義点の水準」と比較される。
				const nlAt = (i: number): number => necklineAt(neckline, i);
				const necklineSide = validateMainPointsAgainstNecklineAt('bottom', [p0, p2, p4], nlAt);
				if (necklineSide.reason) {
					debugCandidates.push({
						type: 'inverse_head_and_shoulders',
						accepted: false,
						reason: necklineSide.reason,
						details: necklineSideDetailsFromAt(nlAt, necklineSide.offenders),
						indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					});
					continue;
				}

				// 右肩後のネックライン上抜けを確認する。
				const breakoutIdx = findHsBreakoutIdx(candles, neckline, p4.idx, 'above');
				const completion = buildHsCompletionFields(candles, breakoutIdx, 'up', end);
				if (!completion) continue;
				// 最終構成点（右肩） → ブレイクの経路検証 と 肩ゾーン再進入の横展開（issue #242）。
				// ブレイクが確定している経路でだけ掛ける（`near_completion` は最終構成点 → ブレイクの
				// 経路が定義できない）。`first` / `mid` の取り方は上の `applyReversalGate` と同じで、
				// **構成点列の先頭 2 点**（左肩 p0 / 谷1 p1。本ファイル冒頭ではなく `reversal-gate.ts` 冒頭の注記）。
				const postGate =
					breakoutIdx >= 0
						? applyPostBreakoutGates({
								candles,
								pivots,
								side: 'bottom',
								first: p0,
								mid: p1,
								last: p4,
								breakoutIdx,
								type: 'inverse_head_and_shoulders',
								indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
								debugCandidates,
							})
						: null;
				const rangeEnd = completion.rangeEnd;
				const diagram = generatePatternDiagram(
					'inverse_head_and_shoulders',
					[
						{ ...p0, date: candles[p0.idx]?.isoTime },
						{ ...p1, date: candles[p1.idx]?.isoTime },
						{ ...p2, date: candles[p2.idx]?.isoTime },
						{ ...p3, date: candles[p3.idx]?.isoTime },
						{ ...p4, date: candles[p4.idx]?.isoTime },
					],
					{ price: nlAvg },
					{ start, end: rangeEnd },
					{ tz: ctx.tz, type: ctx.type },
				);
				// 投影の起点はブレイク日（または右肩日）時点のネックライン値。**高さは頭の真下**で測る（#208）。
				const targetAnchorIdx = breakoutIdx >= 0 ? breakoutIdx : p4.idx;
				const ihsTarget = necklineProjectionTarget({
					neckline,
					anchorIdx: targetAnchorIdx,
					headIdx: p2.idx,
					headPrice: p2.price,
					direction: 'up',
					fallbackNecklinePrice: nlAvg,
				});
				const ihsHeight = necklineProjectionHeight({
					neckline,
					headIdx: p2.idx,
					headPrice: p2.price,
					direction: 'up',
					fallbackNecklinePrice: nlAvg,
				});
				// ブレイク未確定 / target 未算出でも**理由を名乗る**（#224 症状 2）。
				// `undefined` を渡す書き方は `targetReachFields` の引数型から外してあるので通らない。
				const ihsReach = !completion.breakout
					? omittedTargetReach('not_broken_out')
					: ihsTarget === undefined || ihsHeight === undefined
						? omittedTargetReach('no_target')
						: computeTargetReach(candles, breakoutIdx, completion.breakout.price, ihsTarget, 'up', ihsHeight);
				const ihsPrecedingTrend = buildPrecedingTrend(candles, trend, p0.idx);

				// 整合度（issue #204 Phase 2）。**ブレイク検出と高さ算出の後ろに置く**
				// ——`breakoutQuality` が突破足の終値を、`patternHeight` が頭の真下のネックライン
				// （`necklineProjectionHeight`）を要るため。H&S には confidence の下限ゲートが
				// 無い（#206）ので、triple（#199）と違い棄却理由の帰属は動かない。
				const { components: scoreComponents, base } = buildHsScore({
					shoulders: [p0.price, p4.price],
					headPrice: p2.price,
					shoulderIdxs: [p0.idx, p4.idx],
					headIdx: p2.idx,
					headProminenceGate: headProminencePct,
					necklinePrice: necklineAt(neckline, breakoutIdx),
					breakoutClose: completion.breakout?.price ?? Number.NaN,
					patternHeight: ihsHeight,
					side: 'bottom',
					retracementRatio: gate.retracementRatio,
					durationScore: periodScoreDays(start, end),
				});
				const confidence = finalizeConf(base, 'inverse_head_and_shoulders');

				patterns.push({
					type: 'inverse_head_and_shoulders',
					confidence,
					scoreComponents,
					range: { start, end: rangeEnd },
					structureRange: { start, end },
					status: completion.status,
					confirmation: completion.confirmation,
					...(completion.breakout ? { breakout: completion.breakout } : {}),
					...(completion.breakoutBarIndex !== undefined ? { breakoutBarIndex: completion.breakoutBarIndex } : {}),
					...(completion.breakoutDate ? { breakoutDate: completion.breakoutDate } : {}),
					...(completion.breakoutDirection ? { breakoutDirection: completion.breakoutDirection } : {}),
					...(completion.outcome ? { outcome: completion.outcome } : {}),
					// #242 のゲートが当たったら `completed` を上書きして `invalid` にする。
					...postGate,
					...(ihsPrecedingTrend ? { precedingTrend: ihsPrecedingTrend } : {}),
					pivots: [p0, p1, p2, p3, p4],
					neckline,
					...(structureGate ? { structureGate } : {}),
					trendlineLabel: 'ネックライン',
					...(ihsTarget !== undefined
						? { breakoutTarget: ihsTarget, targetMethod: 'neckline_projection' as const }
						: {}),
					...targetReachFields(ihsReach),
					structureDiagram: diagram,
				});
				found = true;
				// #242 のゲートで `invalid` になった候補に `accepted: true` を積まない
				// （同じ構造に成功と棄却の 2 行が並ぶと `view=debug` が読めなくなる）。
				if (!postGate)
					debugCandidates.push({
						type: 'inverse_head_and_shoulders',
						accepted: true,
						indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
						points: [
							{ role: 'left_shoulder', idx: p0.idx, price: p0.price, isoTime: candles[p0.idx]?.isoTime },
							{ role: 'peak1', idx: p1.idx, price: p1.price, isoTime: candles[p1.idx]?.isoTime },
							{ role: 'head', idx: p2.idx, price: p2.price, isoTime: candles[p2.idx]?.isoTime },
							{ role: 'peak2', idx: p3.idx, price: p3.price, isoTime: candles[p3.idx]?.isoTime },
							{ role: 'right_shoulder', idx: p4.idx, price: p4.price, isoTime: candles[p4.idx]?.isoTime },
						],
					});
			}
		} else {
			const reason = !shouldersNear
				? shouldersNotNearReason(shouldersWithinTolerance, shouldersWithinCap)
				: !headLower
					? 'head_not_lower'
					: !necklineCheck.ok
						? 'neckline_not_horizontal'
						: 'unknown';
			debugCandidates.push({
				type: 'inverse_head_and_shoulders',
				accepted: false,
				reason,
				details: {
					leftShoulder: p0.price,
					rightShoulder: p4.price,
					shouldersDiff: Math.abs(p0.price - p4.price),
					shouldersDiffPct: Math.abs(p0.price - p4.price) / Math.max(1, Math.max(p0.price, p4.price)),
					shoulderMaxPct: ctx.hsShoulderMaxPct,
					tolerancePct,
					head: p2.price,
					headProminencePct,
					necklineP1: p1.price,
					necklineP3: p3.price,
					necklineDiffPct: necklineCheck.diffPct,
					necklineMaxPct: HS_NECKLINE_MAX_PCT,
				},
				indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
			});
		}
	}

	return { patterns, found };
}

// ── Helper: Strict H&S (H-L-H-L-H) ──

function findStrictHS(ctx: DetectContext): { patterns: DeduplicablePattern[]; found: boolean } {
	const { candles, pivots, tolerancePct, headProminencePct, near, debugCandidates } = ctx;
	const patterns: DeduplicablePattern[] = [];
	let found = false;

	for (const { p0, p1, p2, p3, p4 } of enumerateHsWindows(ctx, 'top')) {
		// 肩は 2 ゲートの AND。どちらの conjunct で落ちたかを `reason` に出すため短絡評価をやめて
		// 別々に評価する（`near` / `isSameLevel` とも副作用の無い純粋比較なので判定は不変。issue #172）。
		const shouldersWithinTolerance = near(p0.price, p4.price);
		const shouldersWithinCap = isSameLevel(p0.price, p4.price, ctx.hsShoulderMaxPct);
		const shouldersNear = shouldersWithinTolerance && shouldersWithinCap;
		const headHigher = p2.price > Math.max(p0.price, p4.price) * (1 + headProminencePct);
		const necklineCheck = validateHorizontalNeckline(p1.price, p3.price, HS_NECKLINE_MAX_PCT);
		if (shouldersNear && headHigher && necklineCheck.ok) {
			const start = candles[p0.idx].isoTime;
			const end = candles[p4.idx].isoTime;
			if (start && end) {
				const trend = validatePriorTrend(candles, p0.idx, p4.idx - p0.idx, 'up_or_sideways');
				if (!trend.ok) {
					debugCandidates.push({
						type: 'head_and_shoulders',
						accepted: false,
						reason: `prior_trend_mismatch:${trend.classification}`,
						indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					});
					continue;
				}
				if (trend.classification === 'insufficient_data') {
					debugCandidates.push({
						type: 'head_and_shoulders',
						accepted: true,
						reason: 'prior_trend_insufficient_data',
						indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					});
				}
				// サイズ検査（#138 欠陥 2-2）。配置が最後なのは `validatePatternSize` の docstring を参照。
				const sizeReason = validatePatternSize('top', [p0, p1, p2, p3, p4], ctx.sizeThresholds);
				if (sizeReason) {
					debugCandidates.push({
						type: 'head_and_shoulders',
						accepted: false,
						reason: sizeReason,
						indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					});
					continue;
				}
				const neckline = [
					{ x: p1.idx, y: p1.price },
					{ x: p3.idx, y: p3.price },
				];
				const nlAvg = (Number(p1.price) + Number(p3.price)) / 2;

				// ネックライン水準は**ブレイク判定（findHsBreakoutIdx）に渡す線と同じ**ものを構造ゲートへ渡す
				// （`ReversalStructureInput.necklinePrice` の docstring）。線は p1 / p3 の 2 点で張るが、
				// ゲートは第1構成点より手前を遡るので**スカラーの水準**が要る。`validateHorizontalNeckline` が
				// 既に |p1 - p3| <= HS_NECKLINE_MAX_PCT を課しているため、2 点の平均が線の代表値になる。
				// 傾きを外挿して遡ると、探索窓 60 本ぶんの外挿誤差が水準そのものより大きくなり得る。
				// 構造ゲート（#138 欠陥 2-1）。#131 が double にだけ入れたものの横展開。
				// サイズ検査と同じく「既存の棄却検査をすべて通過した後」に置く。
				const gate = applyReversalGate({
					candles,
					pivots,
					side: 'top',
					first: p0,
					mid: p1,
					necklinePrice: nlAvg,
					type: 'head_and_shoulders',
					indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					debugCandidates,
				});
				if (!gate) continue;
				const structureGate = buildStructureGate(gate);

				// 主構成点とネックラインの位置関係（issue #216 Phase 2 の H&S 分）。
				// 判定の実体・基準・配置の理由は `validateMainPointsAgainstNecklineAt` の docstring が単一ソース。
				// 検査するのは `[p0, p2, p4]` だけ（`p1` / `p3` はネックラインの定義点そのもの）。
				const nlAt = (i: number): number => necklineAt(neckline, i);
				const necklineSide = validateMainPointsAgainstNecklineAt('top', [p0, p2, p4], nlAt);
				if (necklineSide.reason) {
					debugCandidates.push({
						type: 'head_and_shoulders',
						accepted: false,
						reason: necklineSide.reason,
						details: necklineSideDetailsFromAt(nlAt, necklineSide.offenders),
						indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					});
					continue;
				}

				// 右肩後のネックライン下抜けを確認する。
				const breakoutIdx = findHsBreakoutIdx(candles, neckline, p4.idx, 'below');
				const completion = buildHsCompletionFields(candles, breakoutIdx, 'down', end);
				if (!completion) continue;
				// 最終構成点（右肩） → ブレイクの経路検証 と 肩ゾーン再進入の横展開（issue #242）。
				// ブレイクが確定している経路でだけ掛ける（`near_completion` は最終構成点 → ブレイクの
				// 経路が定義できない）。`first` / `mid` の取り方は上の `applyReversalGate` と同じで、
				// **構成点列の先頭 2 点**（左肩 p0 / 谷1 p1。本ファイル冒頭ではなく `reversal-gate.ts` 冒頭の注記）。
				const postGate =
					breakoutIdx >= 0
						? applyPostBreakoutGates({
								candles,
								pivots,
								side: 'top',
								first: p0,
								mid: p1,
								last: p4,
								breakoutIdx,
								type: 'head_and_shoulders',
								indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
								debugCandidates,
							})
						: null;
				const rangeEnd = completion.rangeEnd;
				const diagram = generatePatternDiagram(
					'head_and_shoulders',
					[
						{ ...p0, date: candles[p0.idx]?.isoTime },
						{ ...p1, date: candles[p1.idx]?.isoTime },
						{ ...p2, date: candles[p2.idx]?.isoTime },
						{ ...p3, date: candles[p3.idx]?.isoTime },
						{ ...p4, date: candles[p4.idx]?.isoTime },
					],
					{ price: nlAvg },
					{ start, end: rangeEnd },
					{ tz: ctx.tz, type: ctx.type },
				);
				// 投影の起点はブレイク日（または右肩日）時点のネックライン値。**高さは頭の真下**で測る（#208）。
				const targetAnchorIdx = breakoutIdx >= 0 ? breakoutIdx : p4.idx;
				const hsTarget = necklineProjectionTarget({
					neckline,
					anchorIdx: targetAnchorIdx,
					headIdx: p2.idx,
					headPrice: p2.price,
					direction: 'down',
					fallbackNecklinePrice: nlAvg,
				});
				const hsHeight = necklineProjectionHeight({
					neckline,
					headIdx: p2.idx,
					headPrice: p2.price,
					direction: 'down',
					fallbackNecklinePrice: nlAvg,
				});
				// ブレイク未確定 / target 未算出でも**理由を名乗る**（#224 症状 2）。
				// `undefined` を渡す書き方は `targetReachFields` の引数型から外してあるので通らない。
				const hsReach = !completion.breakout
					? omittedTargetReach('not_broken_out')
					: hsTarget === undefined || hsHeight === undefined
						? omittedTargetReach('no_target')
						: computeTargetReach(candles, breakoutIdx, completion.breakout.price, hsTarget, 'down', hsHeight);
				const hsPrecedingTrend = buildPrecedingTrend(candles, trend, p0.idx);

				// 整合度（issue #204 Phase 2）。配置の理由は `findStrictInverseHS` の同じ箇所を参照。
				const { components: scoreComponents, base } = buildHsScore({
					shoulders: [p0.price, p4.price],
					headPrice: p2.price,
					shoulderIdxs: [p0.idx, p4.idx],
					headIdx: p2.idx,
					headProminenceGate: headProminencePct,
					necklinePrice: necklineAt(neckline, breakoutIdx),
					breakoutClose: completion.breakout?.price ?? Number.NaN,
					patternHeight: hsHeight,
					side: 'top',
					retracementRatio: gate.retracementRatio,
					durationScore: periodScoreDays(start, end),
				});
				const confidence = finalizeConf(base, 'head_and_shoulders');

				patterns.push({
					type: 'head_and_shoulders',
					confidence,
					scoreComponents,
					range: { start, end: rangeEnd },
					structureRange: { start, end },
					status: completion.status,
					confirmation: completion.confirmation,
					...(completion.breakout ? { breakout: completion.breakout } : {}),
					...(completion.breakoutBarIndex !== undefined ? { breakoutBarIndex: completion.breakoutBarIndex } : {}),
					...(completion.breakoutDate ? { breakoutDate: completion.breakoutDate } : {}),
					...(completion.breakoutDirection ? { breakoutDirection: completion.breakoutDirection } : {}),
					...(completion.outcome ? { outcome: completion.outcome } : {}),
					// #242 のゲートが当たったら `completed` を上書きして `invalid` にする。
					...postGate,
					...(hsPrecedingTrend ? { precedingTrend: hsPrecedingTrend } : {}),
					pivots: [p0, p1, p2, p3, p4],
					neckline,
					...(structureGate ? { structureGate } : {}),
					trendlineLabel: 'ネックライン',
					...(hsTarget !== undefined ? { breakoutTarget: hsTarget, targetMethod: 'neckline_projection' as const } : {}),
					...targetReachFields(hsReach),
					structureDiagram: diagram,
				});
				found = true;
				// #242 のゲートで `invalid` になった候補に `accepted: true` を積まない
				// （同じ構造に成功と棄却の 2 行が並ぶと `view=debug` が読めなくなる）。
				if (!postGate)
					debugCandidates.push({
						type: 'head_and_shoulders',
						accepted: true,
						indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
						points: [
							{ role: 'left_shoulder', idx: p0.idx, price: p0.price, isoTime: candles[p0.idx]?.isoTime },
							{ role: 'valley1', idx: p1.idx, price: p1.price, isoTime: candles[p1.idx]?.isoTime },
							{ role: 'head', idx: p2.idx, price: p2.price, isoTime: candles[p2.idx]?.isoTime },
							{ role: 'valley2', idx: p3.idx, price: p3.price, isoTime: candles[p3.idx]?.isoTime },
							{ role: 'right_shoulder', idx: p4.idx, price: p4.price, isoTime: candles[p4.idx]?.isoTime },
						],
					});
			}
		} else {
			const reason = !shouldersNear
				? shouldersNotNearReason(shouldersWithinTolerance, shouldersWithinCap)
				: !headHigher
					? 'head_not_higher'
					: !necklineCheck.ok
						? 'neckline_not_horizontal'
						: 'unknown';
			debugCandidates.push({
				type: 'head_and_shoulders',
				accepted: false,
				reason,
				details: {
					leftShoulder: p0.price,
					rightShoulder: p4.price,
					shouldersDiff: Math.abs(p0.price - p4.price),
					shouldersDiffPct: Math.abs(p0.price - p4.price) / Math.max(1, Math.max(p0.price, p4.price)),
					shoulderMaxPct: ctx.hsShoulderMaxPct,
					tolerancePct,
					head: p2.price,
					headProminencePct,
					necklineP1: p1.price,
					necklineP3: p3.price,
					necklineDiffPct: necklineCheck.diffPct,
					necklineMaxPct: HS_NECKLINE_MAX_PCT,
				},
				indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
			});
		}
	}

	return { patterns, found };
}

// ── Helper: Relaxed H&S fallback ──

function findRelaxedHS(ctx: DetectContext): DeduplicablePattern | null {
	const { candles, pivots, allValleys, tolerancePct, headProminencePct, minDist, debugCandidates } = ctx;

	/**
	 * 終端 status（`invalid`）が付いた候補の置き場（issue #242 のレビュー指摘。double と同じ）。
	 *
	 * relaxed は**最初に組み上がった候補を返してその場で走査を終える**ので、候補が重なる列で
	 * 先頭の候補が `invalid` になると**後ろにある成立した候補まで一緒に失われる**。relaxed は
	 * 同 type の strict が 0 件のときだけ走るので、そのとき検出結果は 0 件になる。
	 * 終端候補はここに退避して走査を続け、成立した候補が無かったときだけ返す。
	 * **1 件だけ返す契約は変えない**（`??=` なので退避されるのは最初の 1 件）。
	 */
	let terminalFallback: DeduplicablePattern | null = null;

	for (const factors of RELAXED_FACTORS) {
		for (let i = 0; i < pivots.length - 4; i++) {
			const p0 = pivots[i],
				p1 = pivots[i + 1],
				p2 = pivots[i + 2],
				p3 = pivots[i + 3],
				p4 = pivots[i + 4];
			if (!(p0.kind === 'H' && p1.kind === 'L' && p2.kind === 'H' && p3.kind === 'L' && p4.kind === 'H')) continue;
			if (
				p1.idx - p0.idx < minDist ||
				p2.idx - p1.idx < minDist ||
				p3.idx - p2.idx < minDist ||
				p4.idx - p3.idx < minDist
			)
				continue;
			// relaxed の肩判定は `near()`（= tolerancePct 単体）ではなく段の係数を掛けた閾値で見る。
			// 実効閾値は `min(tolerancePct * factors.shoulder, HS_SHOULDER_MAX_PCT)`（#174）。
			const relaxedTolerancePct = tolerancePct * factors.shoulder;
			const shouldersWithinRelaxedTolerance =
				Math.abs(p0.price - p4.price) / Math.max(1, Math.max(p0.price, p4.price)) <= relaxedTolerancePct;
			const shouldersWithinCap = isSameLevel(p0.price, p4.price, ctx.hsShoulderMaxPct);
			const shouldersNearRelaxed = shouldersWithinRelaxedTolerance && shouldersWithinCap;
			const headHigherRelaxed = p2.price > Math.max(p0.price, p4.price) * (1 + headProminencePct * factors.head);
			const necklineCheck = validateHorizontalNeckline(p1.price, p3.price, HS_NECKLINE_MAX_PCT);
			if (!shouldersNearRelaxed || !headHigherRelaxed || !necklineCheck.ok) {
				// 頭で落ちた窓は積まない（#174 以前と同じ）。strict の `head_not_higher` と件数が近く、
				// cap を食う割に relaxed 固有の情報が無いため、本 issue の範囲外に置いた。
				const reason = !shouldersNearRelaxed
					? relaxedShouldersNotNearReason(shouldersWithinRelaxedTolerance, shouldersWithinCap)
					: headHigherRelaxed && !necklineCheck.ok
						? 'relaxed_neckline_not_horizontal'
						: null;
				if (reason && isFinalRelaxedStage(factors)) {
					debugCandidates.push({
						type: 'head_and_shoulders',
						accepted: false,
						reason,
						details: {
							leftShoulder: p0.price,
							rightShoulder: p4.price,
							shouldersDiff: Math.abs(p0.price - p4.price),
							shouldersDiffPct: Math.abs(p0.price - p4.price) / Math.max(1, Math.max(p0.price, p4.price)),
							shoulderMaxPct: ctx.hsShoulderMaxPct,
							tolerancePct,
							relaxedShoulderFactor: factors.shoulder,
							relaxedTolerancePct,
							head: p2.price,
							headProminencePct,
							necklineP1: p1.price,
							necklineP3: p3.price,
							necklineDiffPct: necklineCheck.diffPct,
							necklineMaxPct: HS_NECKLINE_MAX_PCT,
						},
						indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					});
				}
				continue;
			}
			const start = candles[p0.idx].isoTime;
			const end = candles[p4.idx].isoTime;
			if (!start || !end) continue;
			const trend = validatePriorTrend(candles, p0.idx, p4.idx - p0.idx, 'up_or_sideways');
			if (!trend.ok) {
				debugCandidates.push({
					type: 'head_and_shoulders',
					accepted: false,
					reason: `prior_trend_mismatch:${trend.classification}`,
					indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
				});
				continue;
			}
			if (trend.classification === 'insufficient_data') {
				debugCandidates.push({
					type: 'head_and_shoulders',
					accepted: true,
					reason: 'prior_trend_insufficient_data',
					indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
				});
			}
			// サイズ検査（#138 欠陥 2-2）。配置が最後なのは `validatePatternSize` の docstring を参照。
			const sizeReason = validatePatternSize('top', [p0, p1, p2, p3, p4], ctx.sizeThresholds);
			if (sizeReason) {
				debugCandidates.push({
					type: 'head_and_shoulders',
					accepted: false,
					reason: sizeReason,
					indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
				});
				continue;
			}
			const valleyBetween = allValleys.filter((v: { idx: number }) => v.idx > p0.idx && v.idx < p4.idx);
			const postValleys = allValleys.filter((v: { idx: number }) => v.idx > p2.idx);
			const minValley = valleyBetween.length
				? valleyBetween.reduce((m, v) => (v.price < m.price ? v : m))
				: postValleys.length
					? postValleys.reduce((m, v) => (v.price < m.price ? v : m))
					: null;
			const nlY = minValley ? minValley.price : Math.min(p1.price, p3.price);
			const neckline = [
				{ x: p1.idx, y: nlY },
				{ x: p3.idx, y: nlY },
			];

			// relaxed 経路のネックラインは `nlY` の水平線（`findHsBreakoutIdx` に渡すのと同一）。
			// ブレイク判定と同じ値をそのまま構造ゲートへ渡す。
			// 構造ゲート（#138 欠陥 2-1）。#131 が double にだけ入れたものの横展開。
			// サイズ検査と同じく「既存の棄却検査をすべて通過した後」に置く。
			const gate = applyReversalGate({
				candles,
				pivots,
				side: 'top',
				first: p0,
				mid: p1,
				necklinePrice: nlY,
				type: 'head_and_shoulders',
				indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
				debugCandidates,
			});
			if (!gate) continue;
			const structureGate = buildStructureGate(gate);

			// 主構成点とネックラインの位置関係（issue #216 Phase 2 の H&S 分）。
			// 判定の実体・基準・配置の理由は `validateMainPointsAgainstNecklineAt` の docstring が単一ソース。
			// 検査するのは `[p0, p2, p4]` だけ（`p1` / `p3` はネックラインの定義点そのもの）。
			const nlAt = (i: number): number => necklineAt(neckline, i);
			const necklineSide = validateMainPointsAgainstNecklineAt('top', [p0, p2, p4], nlAt);
			if (necklineSide.reason) {
				debugCandidates.push({
					type: 'head_and_shoulders',
					accepted: false,
					reason: necklineSide.reason,
					details: necklineSideDetailsFromAt(nlAt, necklineSide.offenders),
					indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
				});
				continue;
			}

			// 右肩後のネックライン下抜けを確認する。
			const breakoutIdx = findHsBreakoutIdx(candles, neckline, p4.idx, 'below');
			const completion = buildHsCompletionFields(candles, breakoutIdx, 'down', end);
			if (!completion) continue;
			// 最終構成点（右肩） → ブレイクの経路検証 と 肩ゾーン再進入の横展開（issue #242）。
			// ブレイクが確定している経路でだけ掛ける（`near_completion` は最終構成点 → ブレイクの
			// 経路が定義できない）。`first` / `mid` の取り方は上の `applyReversalGate` と同じで、
			// **構成点列の先頭 2 点**（左肩 p0 / 谷1 p1。本ファイル冒頭ではなく `reversal-gate.ts` 冒頭の注記）。
			const postGate =
				breakoutIdx >= 0
					? applyPostBreakoutGates({
							candles,
							pivots,
							side: 'top',
							first: p0,
							mid: p1,
							last: p4,
							breakoutIdx,
							type: 'head_and_shoulders',
							indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
							debugCandidates,
						})
					: null;
			const rangeEnd = completion.rangeEnd;
			const diagram = generatePatternDiagram(
				'head_and_shoulders',
				[
					{ ...p0, date: candles[p0.idx]?.isoTime },
					{ ...p1, date: candles[p1.idx]?.isoTime },
					{ ...p2, date: candles[p2.idx]?.isoTime },
					{ ...p3, date: candles[p3.idx]?.isoTime },
					{ ...p4, date: candles[p4.idx]?.isoTime },
				],
				// 構造図にも**ブレイク判定・ターゲット・出力フィールドと同じ `nlY`** を渡す（issue #226）。
				// 2 定義点の平均を渡していたため、構造図だけが他と食い違っていた。
				{ price: nlY },
				{ start, end: rangeEnd },
				{ tz: ctx.tz, type: ctx.type },
			);
			// nlY は水平ネックラインの y。頭の真下でもブレイク時点でも同値なので、`necklineProjectionTarget`
			// を通しても値は変わらない（#208 が揃えたのは**基準の名乗り**で、relaxed の値は不変）。
			// TODO: relaxed H&S も strict と同じく 谷1→谷2 の傾きつきネックラインを使うべき。
			//       別 PR で検討（今回の主目的は target reached の high/low 化）。
			const hsRelTarget = necklineProjectionTarget({
				neckline,
				anchorIdx: breakoutIdx >= 0 ? breakoutIdx : p4.idx,
				headIdx: p2.idx,
				headPrice: p2.price,
				direction: 'down',
				fallbackNecklinePrice: nlY,
			});
			const hsRelHeight = necklineProjectionHeight({
				neckline,
				headIdx: p2.idx,
				headPrice: p2.price,
				direction: 'down',
				fallbackNecklinePrice: nlY,
			});
			// ブレイク未確定 / target 未算出でも**理由を名乗る**（#224 症状 2）。
			// `undefined` を渡す書き方は `targetReachFields` の引数型から外してあるので通らない。
			const hsRelReach = !completion.breakout
				? omittedTargetReach('not_broken_out')
				: hsRelTarget === undefined || hsRelHeight === undefined
					? omittedTargetReach('no_target')
					: computeTargetReach(candles, breakoutIdx, completion.breakout.price, hsRelTarget, 'down', hsRelHeight);
			const hsRelPrecedingTrend = buildPrecedingTrend(candles, trend, p0.idx);
			// 整合度（issue #204 Phase 2）。strict と同じ軸構成・**同じ閾値**で採点する。
			// 頭の突出は**ゲートだけ** `headProminencePct × factors.head` に緩め、**採点は strict の
			// `headProminencePct`** で行う（issue #227 Phase 2。理由は `buildHsScore` の
			// `headProminenceGate` の docstring）。`× 0.95` の relaxed ペナルティは据え置き
			// ——段別にする案は段1 の accepted が実測で 0 件のままで、効果を測れないため見送った。
			const { components: scoreComponents, base } = buildHsScore({
				shoulders: [p0.price, p4.price],
				headPrice: p2.price,
				shoulderIdxs: [p0.idx, p4.idx],
				headIdx: p2.idx,
				headProminenceGate: headProminencePct,
				necklinePrice: necklineAt(neckline, breakoutIdx),
				breakoutClose: completion.breakout?.price ?? Number.NaN,
				patternHeight: hsRelHeight,
				side: 'top',
				retracementRatio: gate.retracementRatio,
				durationScore: periodScoreDays(start, end),
			});
			const confidence = finalizeConf(base * 0.95, 'head_and_shoulders');
			// #242 のゲートで `invalid` になった候補に `accepted: true` を積まない
			// （同じ構造に成功と棄却の 2 行が並ぶと `view=debug` が読めなくなる）。
			if (!postGate)
				debugCandidates.push({
					type: 'head_and_shoulders',
					accepted: true,
					reason: 'fallback_relaxed',
					indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
				});
			const entry: DeduplicablePattern = {
				type: 'head_and_shoulders',
				confidence,
				scoreComponents,
				range: { start, end: rangeEnd },
				structureRange: { start, end },
				status: completion.status,
				confirmation: completion.confirmation,
				...(completion.breakout ? { breakout: completion.breakout } : {}),
				...(completion.breakoutBarIndex !== undefined ? { breakoutBarIndex: completion.breakoutBarIndex } : {}),
				...(completion.breakoutDate ? { breakoutDate: completion.breakoutDate } : {}),
				...(completion.breakoutDirection ? { breakoutDirection: completion.breakoutDirection } : {}),
				...(completion.outcome ? { outcome: completion.outcome } : {}),
				// #242 のゲートが当たったら `completed` を上書きして `invalid` にする。
				...postGate,
				...(hsRelPrecedingTrend ? { precedingTrend: hsRelPrecedingTrend } : {}),
				pivots: [p0, p1, p2, p3, p4],
				neckline,
				...(structureGate ? { structureGate } : {}),
				trendlineLabel: 'ネックライン',
				...(hsRelTarget !== undefined
					? { breakoutTarget: hsRelTarget, targetMethod: 'neckline_projection' as const }
					: {}),
				...targetReachFields(hsRelReach),
				structureDiagram: diagram,
				_fallback: `relaxed_hs_${factors.tag}`,
			};
			if (entry.status === 'invalid') {
				terminalFallback ??= entry;
				continue;
			}
			return entry;
		}
	}
	return terminalFallback;
}

// ── Helper: Relaxed Inverse H&S fallback ──

function findRelaxedInverseHS(ctx: DetectContext): DeduplicablePattern | null {
	const { candles, pivots, allPeaks, tolerancePct, headProminencePct, minDist, debugCandidates } = ctx;

	/**
	 * 終端 status（`invalid`）が付いた候補の置き場（issue #242 のレビュー指摘。double と同じ）。
	 *
	 * relaxed は**最初に組み上がった候補を返してその場で走査を終える**ので、候補が重なる列で
	 * 先頭の候補が `invalid` になると**後ろにある成立した候補まで一緒に失われる**。relaxed は
	 * 同 type の strict が 0 件のときだけ走るので、そのとき検出結果は 0 件になる。
	 * 終端候補はここに退避して走査を続け、成立した候補が無かったときだけ返す。
	 * **1 件だけ返す契約は変えない**（`??=` なので退避されるのは最初の 1 件）。
	 */
	let terminalFallback: DeduplicablePattern | null = null;

	for (const factors of RELAXED_FACTORS) {
		for (let i = 0; i < pivots.length - 4; i++) {
			const p0 = pivots[i],
				p1 = pivots[i + 1],
				p2 = pivots[i + 2],
				p3 = pivots[i + 3],
				p4 = pivots[i + 4];
			if (!(p0.kind === 'L' && p1.kind === 'H' && p2.kind === 'L' && p3.kind === 'H' && p4.kind === 'L')) continue;
			if (
				p1.idx - p0.idx < minDist ||
				p2.idx - p1.idx < minDist ||
				p3.idx - p2.idx < minDist ||
				p4.idx - p3.idx < minDist
			)
				continue;
			// relaxed の肩判定は `near()`（= tolerancePct 単体）ではなく段の係数を掛けた閾値で見る。
			// 実効閾値は `min(tolerancePct * factors.shoulder, HS_SHOULDER_MAX_PCT)`（#174）。
			const relaxedTolerancePct = tolerancePct * factors.shoulder;
			const shouldersWithinRelaxedTolerance =
				Math.abs(p0.price - p4.price) / Math.max(1, Math.max(p0.price, p4.price)) <= relaxedTolerancePct;
			const shouldersWithinCap = isSameLevel(p0.price, p4.price, ctx.hsShoulderMaxPct);
			const shouldersNearRelaxed = shouldersWithinRelaxedTolerance && shouldersWithinCap;
			const headLowerRelaxed = p2.price < Math.min(p0.price, p4.price) * (1 - headProminencePct * factors.head);
			const necklineCheck = validateHorizontalNeckline(p1.price, p3.price, HS_NECKLINE_MAX_PCT);
			if (!(shouldersNearRelaxed && headLowerRelaxed && necklineCheck.ok)) {
				// 頭で落ちた窓は積まない（#174 以前と同じ）。strict の `head_not_lower` と件数が近く、
				// cap を食う割に relaxed 固有の情報が無いため、本 issue の範囲外に置いた。
				const reason = !shouldersNearRelaxed
					? relaxedShouldersNotNearReason(shouldersWithinRelaxedTolerance, shouldersWithinCap)
					: headLowerRelaxed && !necklineCheck.ok
						? 'relaxed_neckline_not_horizontal'
						: null;
				if (reason && isFinalRelaxedStage(factors)) {
					debugCandidates.push({
						type: 'inverse_head_and_shoulders',
						accepted: false,
						reason,
						details: {
							leftShoulder: p0.price,
							rightShoulder: p4.price,
							shouldersDiff: Math.abs(p0.price - p4.price),
							shouldersDiffPct: Math.abs(p0.price - p4.price) / Math.max(1, Math.max(p0.price, p4.price)),
							shoulderMaxPct: ctx.hsShoulderMaxPct,
							tolerancePct,
							relaxedShoulderFactor: factors.shoulder,
							relaxedTolerancePct,
							head: p2.price,
							headProminencePct,
							necklineP1: p1.price,
							necklineP3: p3.price,
							necklineDiffPct: necklineCheck.diffPct,
							necklineMaxPct: HS_NECKLINE_MAX_PCT,
						},
						indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					});
				}
				continue;
			}
			const start = candles[p0.idx].isoTime;
			const end = candles[p4.idx].isoTime;
			if (!start || !end) continue;
			const trend = validatePriorTrend(candles, p0.idx, p4.idx - p0.idx, 'down_or_sideways');
			if (!trend.ok) {
				debugCandidates.push({
					type: 'inverse_head_and_shoulders',
					accepted: false,
					reason: `prior_trend_mismatch:${trend.classification}`,
					indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
				});
				continue;
			}
			if (trend.classification === 'insufficient_data') {
				debugCandidates.push({
					type: 'inverse_head_and_shoulders',
					accepted: true,
					reason: 'prior_trend_insufficient_data',
					indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
				});
			}
			// サイズ検査（#138 欠陥 2-2）。配置が最後なのは `validatePatternSize` の docstring を参照。
			const sizeReason = validatePatternSize('bottom', [p0, p1, p2, p3, p4], ctx.sizeThresholds);
			if (sizeReason) {
				debugCandidates.push({
					type: 'inverse_head_and_shoulders',
					accepted: false,
					reason: sizeReason,
					indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
				});
				continue;
			}
			const peaksBetween = allPeaks.filter((v: { idx: number }) => v.idx > p0.idx && v.idx < p4.idx);
			const postPeaks = allPeaks.filter((v: { idx: number }) => v.idx > p2.idx);
			const maxPeak = peaksBetween.length
				? peaksBetween.reduce((m, v) => (v.price > m.price ? v : m))
				: postPeaks.length
					? postPeaks.reduce((m, v) => (v.price > m.price ? v : m))
					: null;
			const nlY = maxPeak ? maxPeak.price : Math.max(p1.price, p3.price);
			const neckline = [
				{ x: p1.idx, y: nlY },
				{ x: p3.idx, y: nlY },
			];

			// relaxed 経路のネックラインは `nlY` の水平線（`findHsBreakoutIdx` に渡すのと同一）。
			// ブレイク判定と同じ値をそのまま構造ゲートへ渡す。
			// 構造ゲート（#138 欠陥 2-1）。#131 が double にだけ入れたものの横展開。
			// サイズ検査と同じく「既存の棄却検査をすべて通過した後」に置く。
			const gate = applyReversalGate({
				candles,
				pivots,
				side: 'bottom',
				first: p0,
				mid: p1,
				necklinePrice: nlY,
				type: 'inverse_head_and_shoulders',
				indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
				debugCandidates,
			});
			if (!gate) continue;
			const structureGate = buildStructureGate(gate);

			// 主構成点とネックラインの位置関係（issue #216 Phase 2 の H&S 分）。
			// 判定の実体・基準・配置の理由は `validateMainPointsAgainstNecklineAt` の docstring が単一ソース。
			// 検査するのは `[p0, p2, p4]` だけ（`p1` / `p3` はネックラインの定義点そのもの）。
			const nlAt = (i: number): number => necklineAt(neckline, i);
			const necklineSide = validateMainPointsAgainstNecklineAt('bottom', [p0, p2, p4], nlAt);
			if (necklineSide.reason) {
				debugCandidates.push({
					type: 'inverse_head_and_shoulders',
					accepted: false,
					reason: necklineSide.reason,
					details: necklineSideDetailsFromAt(nlAt, necklineSide.offenders),
					indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
				});
				continue;
			}

			// 右肩後のネックライン上抜けを確認する。
			const breakoutIdx = findHsBreakoutIdx(candles, neckline, p4.idx, 'above');
			const completion = buildHsCompletionFields(candles, breakoutIdx, 'up', end);
			if (!completion) continue;
			// 最終構成点（右肩） → ブレイクの経路検証 と 肩ゾーン再進入の横展開（issue #242）。
			// ブレイクが確定している経路でだけ掛ける（`near_completion` は最終構成点 → ブレイクの
			// 経路が定義できない）。`first` / `mid` の取り方は上の `applyReversalGate` と同じで、
			// **構成点列の先頭 2 点**（左肩 p0 / 谷1 p1。本ファイル冒頭ではなく `reversal-gate.ts` 冒頭の注記）。
			const postGate =
				breakoutIdx >= 0
					? applyPostBreakoutGates({
							candles,
							pivots,
							side: 'bottom',
							first: p0,
							mid: p1,
							last: p4,
							breakoutIdx,
							type: 'inverse_head_and_shoulders',
							indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
							debugCandidates,
						})
					: null;
			const rangeEnd = completion.rangeEnd;
			const diagram = generatePatternDiagram(
				'inverse_head_and_shoulders',
				[
					{ ...p0, date: candles[p0.idx]?.isoTime },
					{ ...p1, date: candles[p1.idx]?.isoTime },
					{ ...p2, date: candles[p2.idx]?.isoTime },
					{ ...p3, date: candles[p3.idx]?.isoTime },
					{ ...p4, date: candles[p4.idx]?.isoTime },
				],
				// 構造図にも**ブレイク判定・ターゲット・出力フィールドと同じ `nlY`** を渡す（issue #226）。
				// 2 定義点の平均を渡していたため、構造図だけが他と食い違っていた。
				{ price: nlY },
				{ start, end: rangeEnd },
				{ tz: ctx.tz, type: ctx.type },
			);
			// nlY は水平ネックラインの y。頭の真下でもブレイク時点でも同値なので、`necklineProjectionTarget`
			// を通しても値は変わらない（#208 が揃えたのは**基準の名乗り**で、relaxed の値は不変）。
			// TODO: relaxed Inverse H&S も strict と同じく 山1→山2 の傾きつきネックラインを使うべき。
			//       別 PR で検討（今回の主目的は target reached の high/low 化）。
			const ihsRelTarget = necklineProjectionTarget({
				neckline,
				anchorIdx: breakoutIdx >= 0 ? breakoutIdx : p4.idx,
				headIdx: p2.idx,
				headPrice: p2.price,
				direction: 'up',
				fallbackNecklinePrice: nlY,
			});
			const ihsRelHeight = necklineProjectionHeight({
				neckline,
				headIdx: p2.idx,
				headPrice: p2.price,
				direction: 'up',
				fallbackNecklinePrice: nlY,
			});
			// ブレイク未確定 / target 未算出でも**理由を名乗る**（#224 症状 2）。
			// `undefined` を渡す書き方は `targetReachFields` の引数型から外してあるので通らない。
			const ihsRelReach = !completion.breakout
				? omittedTargetReach('not_broken_out')
				: ihsRelTarget === undefined || ihsRelHeight === undefined
					? omittedTargetReach('no_target')
					: computeTargetReach(candles, breakoutIdx, completion.breakout.price, ihsRelTarget, 'up', ihsRelHeight);
			const ihsRelPrecedingTrend = buildPrecedingTrend(candles, trend, p0.idx);
			// 整合度（issue #204 Phase 2）。配置と閾値の渡し方は `findRelaxedHS` の同じ箇所を参照。
			const { components: scoreComponents, base } = buildHsScore({
				shoulders: [p0.price, p4.price],
				headPrice: p2.price,
				shoulderIdxs: [p0.idx, p4.idx],
				headIdx: p2.idx,
				headProminenceGate: headProminencePct,
				necklinePrice: necklineAt(neckline, breakoutIdx),
				breakoutClose: completion.breakout?.price ?? Number.NaN,
				patternHeight: ihsRelHeight,
				side: 'bottom',
				retracementRatio: gate.retracementRatio,
				durationScore: periodScoreDays(start, end),
			});
			const confidence = finalizeConf(base * 0.95, 'inverse_head_and_shoulders');
			// #242 のゲートで `invalid` になった候補に `accepted: true` を積まない
			// （同じ構造に成功と棄却の 2 行が並ぶと `view=debug` が読めなくなる）。
			if (!postGate)
				debugCandidates.push({
					type: 'inverse_head_and_shoulders',
					accepted: true,
					reason: 'fallback_relaxed',
					indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
				});
			const entry: DeduplicablePattern = {
				type: 'inverse_head_and_shoulders',
				confidence,
				scoreComponents,
				range: { start, end: rangeEnd },
				structureRange: { start, end },
				status: completion.status,
				confirmation: completion.confirmation,
				...(completion.breakout ? { breakout: completion.breakout } : {}),
				...(completion.breakoutBarIndex !== undefined ? { breakoutBarIndex: completion.breakoutBarIndex } : {}),
				...(completion.breakoutDate ? { breakoutDate: completion.breakoutDate } : {}),
				...(completion.breakoutDirection ? { breakoutDirection: completion.breakoutDirection } : {}),
				...(completion.outcome ? { outcome: completion.outcome } : {}),
				// #242 のゲートが当たったら `completed` を上書きして `invalid` にする。
				...postGate,
				...(ihsRelPrecedingTrend ? { precedingTrend: ihsRelPrecedingTrend } : {}),
				pivots: [p0, p1, p2, p3, p4],
				neckline,
				...(structureGate ? { structureGate } : {}),
				trendlineLabel: 'ネックライン',
				...(ihsRelTarget !== undefined
					? { breakoutTarget: ihsRelTarget, targetMethod: 'neckline_projection' as const }
					: {}),
				...targetReachFields(ihsRelReach),
				structureDiagram: diagram,
				_fallback: `relaxed_ihs_${factors.tag}`,
			};
			if (entry.status === 'invalid') {
				terminalFallback ??= entry;
				continue;
			}
			return entry;
		}
	}
	return terminalFallback;
}

// ── Helper: 形成中 H&S ──

function tryFormingHS(ctx: DetectContext): DeduplicablePattern[] {
	const lastIdx = ctx.candles.length - 1;
	const confirmedPeaks = ctx.allPeaks.filter((p) => p.idx < lastIdx - 2);
	if (confirmedPeaks.length < 2) return [];

	// 頭を 1 点に決め打ちせず全候補を試す（#154）。重複は globalDedup が畳む。
	const out: DeduplicablePattern[] = [];
	for (const head of headCandidatesNewestFirst(confirmedPeaks)) {
		const found = formingHsForHead(ctx, confirmedPeaks, head);
		if (found) out.push(found);
	}
	return out;
}

/**
 * 頭候補 1 つを固定して形成中 H&S を組み立てる。組めなければ null（＝次の頭候補へ）。
 *
 * ## debug candidate の積み方（issue #155）
 *
 * 成功時に `accepted: true` を積む。**`accepted: true` は「検出器が組み立てた」であって
 * 「最終出力に残った」ではない**——`tryFormingHS` は #154 以降すべての頭候補を試すので、
 * ここで積んだ候補が後段 `detect_patterns.ts` の `globalDedup` に畳まれて `data.patterns`
 * に出ないことがある。strict パス（`findStrictHS`）も `patterns.push` の直後＝dedup 前に
 * 積んでおり、既存の約束と揃えてある。
 *
 * 棄却の理由コードは**構成点 4 点が揃った後の分岐にだけ**積む。左肩なし / 頭後の谷なし /
 * 右肩なしの 3 分岐は「まだ形が無い」段階の脱落で、`headCandidatesNewestFirst` のループが
 * 頭候補の数だけ回すぶんそのまま発火する（1hour × `limit=365` × `swingDepth=3` では確定
 * ピークが数十個あり、H&S と逆 H&S 合わせて 100 件級）。`detect_patterns.ts` の cap=200 を
 * 食い潰して**他の検出器の棄却理由を押し出す**ため積まない。積むなら頭候補ごとではなく
 * 1 回だけ集約する形が要る（別途）。
 */
function formingHsForHead(
	ctx: DetectContext,
	confirmedPeaks: readonly Pivot[],
	head: Pivot,
): DeduplicablePattern | null {
	const { candles, pivots, allPeaks, allValleys } = ctx;
	const lastIdx = candles.length - 1;
	const currentPrice = Number(candles[lastIdx]?.close ?? NaN);
	const isoAt = (i: number) => candles[i]?.isoTime || '';
	const formingBars = getHsFormingBarParams(ctx.type);

	// 左肩: 頭より左のピークで、頭より3%以上低い
	const leftCandidates = confirmedPeaks.filter((p) => p.idx < head.idx && head.price > p.price * 1.03);
	if (leftCandidates.length < 1) return null;
	const left = leftCandidates[leftCandidates.length - 1];

	// 頭後の谷を探す
	const postHeadValley = allValleys.find((v) => v.idx > head.idx && v.idx < lastIdx - 1);
	if (!postHeadValley) return null;

	// 右肩候補
	const rightPeakCandidates = allPeaks.filter(
		(p) =>
			p.idx > postHeadValley.idx &&
			p.price < head.price &&
			Math.abs(p.price - left.price) / Math.max(1, left.price) <= FORMING_RIGHT_TOLERANCE_PCT,
	);

	let rightShoulder: Pivot | null = rightPeakCandidates.length
		? rightPeakCandidates[rightPeakCandidates.length - 1]
		: null;
	let isProvisional = false;

	// 確定右肩がない場合、現在価格が左肩近傍なら暫定右肩
	if (!rightShoulder) {
		const nearLeft = Math.abs(currentPrice - left.price) / Math.max(1, left.price) <= FORMING_RIGHT_TOLERANCE_PCT;
		if (nearLeft && currentPrice < head.price && currentPrice > postHeadValley.price) {
			// 暫定右肩は確定ピボットではなく最新足の終値。極値判定（前後 swingDepth 本との比較）を
			// 通っていないので、判定に使った値＝比較に使った currentPrice そのものになる。
			rightShoulder = { idx: lastIdx, price: currentPrice, kind: 'H', extremePrice: currentPrice };
			isProvisional = true;
		}
	}
	if (!rightShoulder) return null;

	// 頭は形成区間の最高値であること（#154。総当たり化で外れた暗黙の保証を明示に戻す）
	if (!headIsExtremeInSpan(allPeaks, head, left.idx, rightShoulder.idx, true)) {
		ctx.debugCandidates.push({
			type: 'head_and_shoulders',
			accepted: false,
			reason: 'head_not_extreme_in_span',
			indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
			details: { spanFromIdx: left.idx, spanToIdx: rightShoulder.idx, headIdx: head.idx, headPrice: head.price },
		});
		return null;
	}

	// 完成度計算
	const closeness =
		1 - Math.abs(rightShoulder.price - left.price) / Math.max(1e-12, left.price * FORMING_RIGHT_TOLERANCE_PCT);
	const progress = Math.max(0, Math.min(1, closeness));
	const completion = Math.min(1, (0.75 + 0.25 * progress) * (isProvisional ? 0.9 : 1.0));
	if (completion < FORMING_MIN_COMPLETION) {
		ctx.debugCandidates.push({
			type: 'head_and_shoulders',
			accepted: false,
			reason: 'completion_below_min',
			indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
			details: { completion, threshold: FORMING_MIN_COMPLETION },
		});
		return null;
	}

	const formationBars = Math.max(0, rightShoulder.idx - left.idx);
	if (formationBars < formingBars.minBars || formationBars > formingBars.maxBars) {
		ctx.debugCandidates.push({
			type: 'head_and_shoulders',
			accepted: false,
			reason: 'formation_bars_out_of_range',
			indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
			details: { formationBars, minBars: formingBars.minBars, maxBars: formingBars.maxBars },
		});
		return null;
	}

	const trend = validatePriorTrend(candles, left.idx, rightShoulder.idx - left.idx, 'up_or_sideways');
	if (!trend.ok) {
		ctx.debugCandidates.push({
			type: 'head_and_shoulders',
			accepted: false,
			reason: `prior_trend_mismatch:${trend.classification}`,
			indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
		});
		return null;
	}
	if (trend.classification === 'insufficient_data') {
		ctx.debugCandidates.push({
			type: 'head_and_shoulders',
			accepted: true,
			reason: 'prior_trend_insufficient_data',
			indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
		});
	}

	// ネックライン
	const preHeadValleys = allValleys.filter((v) => v.idx > left.idx && v.idx < head.idx);
	const preHeadValley = preHeadValleys.length
		? preHeadValleys.reduce((best, v) => (v.price < best.price ? v : best), preHeadValleys[0])
		: null;

	const neckline = preHeadValley
		? [
				{ x: preHeadValley.idx, y: preHeadValley.price },
				{ x: postHeadValley.idx, y: postHeadValley.price },
			]
		: [
				{ x: left.idx, y: postHeadValley.price },
				{ x: postHeadValley.idx, y: postHeadValley.price },
			];

	const confBase = Math.min(1, Math.max(0, 0.6 * closeness + 0.4 * progress));
	const confidence = Math.round(confBase * (isProvisional ? 0.9 : 1.0) * 100) / 100;

	// 形状不十分な forming 候補（confidence=0.01 等）が上位表示されるのを防ぐ。
	// detect_triples.ts と同じ閾値を使う。
	if (confidence < FORMING_MIN_CONFIDENCE) {
		ctx.debugCandidates.push({
			type: 'head_and_shoulders',
			accepted: false,
			reason: 'confidence_below_min_forming',
			indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
			details: { confidence, threshold: FORMING_MIN_CONFIDENCE },
		});
		return null;
	}

	// サイズ検査（#138 欠陥 2-2）。配置が最後なのは `validatePatternSize` の docstring を参照。
	// 先行谷 / 先行山が取れないときは頭-戻り-右肩の 3 点で測る（交互列の形は保たれる）。
	const hsSizeReason = validatePatternSize(
		'top',
		preHeadValley ? [left, preHeadValley, head, postHeadValley, rightShoulder] : [head, postHeadValley, rightShoulder],
		ctx.sizeThresholds,
	);
	if (hsSizeReason) {
		ctx.debugCandidates.push({
			type: 'head_and_shoulders',
			accepted: false,
			reason: hsSizeReason,
			indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
		});
		return null;
	}

	const formHsNl = neckline[0].y;

	// 構造ゲート（#138 欠陥 2-1）。#131 が double にだけ入れたものの横展開。
	// `first` / `mid` は**サイズ検査に渡した構成点列の先頭 2 点**（`reversal-gate.ts` の冒頭）。
	// 先行谷が取れず 3 点（頭-戻り-右肩）に縮む経路では、縮んだ配列の先頭 2 点がそのまま
	// `first` / `mid` になる。ネックライン水準は検出器自身が使う `neckline[0].y`。
	const gate = applyReversalGate({
		candles,
		pivots,
		side: 'top',
		first: preHeadValley ? left : head,
		mid: preHeadValley ?? postHeadValley,
		necklinePrice: formHsNl,
		type: 'head_and_shoulders',
		indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
		debugCandidates: ctx.debugCandidates,
	});
	if (!gate) return null;
	const structureGate = buildStructureGate(gate);

	const start = isoAt(left.idx);
	const end = isoAt(rightShoulder.idx);

	// forming にはブレイク足が無いので、投影の起点は**最終構成点**（暫定を含む右肩）の idx。
	// 高さは strict / relaxed と同じく頭の真下で測る（#208）。以前は `neckline[0].y`
	// （ネックラインの**左端**）を高さにも起点にも使っており、傾いたネックラインでは
	// 現在バー時点の水準と食い違っていた。
	const formHsTarget = necklineProjectionTarget({
		neckline,
		anchorIdx: rightShoulder.idx,
		headIdx: head.idx,
		headPrice: head.price,
		direction: 'down',
		fallbackNecklinePrice: formHsNl,
	});
	const formHsStructureRange = start && end ? { start, end } : undefined;
	const formHsPrecedingTrend = buildPrecedingTrend(candles, trend, left.idx);

	// 成功エントリ（issue #155）。構成点は 4 点で strict の 5 点とは違うため、頭後の谷は
	// strict の `valley1` / `valley2` と混同しない専用 role で積む。先行谷（ネックラインの
	// 左端）は `points` にだけ載せる——既存の棄却エントリと `indices` の並びを揃えるため。
	// 暫定右肩は確定ピボットではなく最新足の終値なので role を分ける。
	ctx.debugCandidates.push({
		type: 'head_and_shoulders',
		accepted: true,
		status: 'forming',
		indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
		points: [
			{ role: 'left_shoulder', idx: left.idx, price: left.price, isoTime: candles[left.idx]?.isoTime },
			...(preHeadValley
				? [
						{
							role: 'pre_head_valley',
							idx: preHeadValley.idx,
							price: preHeadValley.price,
							isoTime: candles[preHeadValley.idx]?.isoTime,
						},
					]
				: []),
			{ role: 'head', idx: head.idx, price: head.price, isoTime: candles[head.idx]?.isoTime },
			{
				role: 'post_head_valley',
				idx: postHeadValley.idx,
				price: postHeadValley.price,
				isoTime: candles[postHeadValley.idx]?.isoTime,
			},
			{
				role: isProvisional ? 'right_shoulder_provisional' : 'right_shoulder',
				idx: rightShoulder.idx,
				price: rightShoulder.price,
				isoTime: candles[rightShoulder.idx]?.isoTime,
			},
		],
		details: {
			confidence,
			completionPct: Math.round(completion * 100),
			method: isProvisional ? 'forming_hs_provisional' : 'forming_hs',
		},
	});

	return {
		type: 'head_and_shoulders',
		confidence,
		range: { start, end },
		...(formHsStructureRange ? { structureRange: formHsStructureRange } : {}),
		confirmation: { type: 'not_confirmed' },
		...(formHsPrecedingTrend ? { precedingTrend: formHsPrecedingTrend } : {}),
		status: 'forming',
		pivots: [
			{ idx: left.idx, price: left.price, kind: 'H' as const, extremePrice: left.extremePrice },
			{ idx: head.idx, price: head.price, kind: 'H' as const, extremePrice: head.extremePrice },
			{
				idx: postHeadValley.idx,
				price: postHeadValley.price,
				kind: 'L' as const,
				extremePrice: postHeadValley.extremePrice,
			},
			{
				idx: rightShoulder.idx,
				price: rightShoulder.price,
				kind: 'H' as const,
				extremePrice: rightShoulder.extremePrice,
			},
		],
		neckline,
		...(structureGate ? { structureGate } : {}),
		trendlineLabel: 'ネックライン',
		...(formHsTarget !== undefined
			? { breakoutTarget: formHsTarget, targetMethod: 'neckline_projection' as const }
			: {}),
		// 形成中は定義上ブレイクしていないので進捗は測れない。**それを言う**（#224 症状 2）——
		// `breakoutTarget` は出るので、黙ると LLM が「進捗 0%」と読み違える。
		...targetReachFields(omittedTargetReach('not_broken_out')),
		completionPct: Math.round(completion * 100),
		_method: isProvisional ? 'forming_hs_provisional' : 'forming_hs',
	};
}

// ── Helper: 形成中 Inverse H&S ──

function tryFormingInverseHS(ctx: DetectContext): DeduplicablePattern[] {
	const lastIdx = ctx.candles.length - 1;
	const confirmedValleys = ctx.allValleys.filter((v) => v.idx < lastIdx - 2);
	if (confirmedValleys.length < 2) return [];

	// 頭を 1 点に決め打ちせず全候補を試す（#154）。重複は globalDedup が畳む。
	const out: DeduplicablePattern[] = [];
	for (const head of headCandidatesNewestFirst(confirmedValleys)) {
		const found = formingInverseHsForHead(ctx, confirmedValleys, head);
		if (found) out.push(found);
	}
	return out;
}

/** 頭候補 1 つを固定して形成中 逆 H&S を組み立てる。組めなければ null（＝次の頭候補へ）。 */
/**
 * 頭候補 1 つを固定して形成中 逆 H&S を組み立てる。組めなければ null（＝次の頭候補へ）。
 * debug candidate の積み方（成功エントリの意味・理由コードを積む分岐の範囲）は
 * {@link formingHsForHead} の docstring が単一ソース。
 */
function formingInverseHsForHead(
	ctx: DetectContext,
	confirmedValleys: readonly Pivot[],
	head: Pivot,
): DeduplicablePattern | null {
	const { candles, pivots, allPeaks, allValleys } = ctx;
	const lastIdx = candles.length - 1;
	const currentPrice = Number(candles[lastIdx]?.close ?? NaN);
	const isoAt = (i: number) => candles[i]?.isoTime || '';
	const formingBars = getHsFormingBarParams(ctx.type);

	// 左肩: 頭より左の谷で、頭より3%以上高い
	const leftCandidates = confirmedValleys.filter((v) => v.idx < head.idx && head.price < v.price * 0.97);
	if (leftCandidates.length < 1) return null;
	const left = leftCandidates[leftCandidates.length - 1];

	// 頭後のピークを探す
	const postHeadPeak = allPeaks.find((p) => p.idx > head.idx && p.idx < lastIdx - 1);
	if (!postHeadPeak) return null;

	// 右肩候補
	const rightValleyCandidates = allValleys.filter(
		(v) =>
			v.idx > postHeadPeak.idx &&
			v.price > head.price &&
			Math.abs(v.price - left.price) / Math.max(1, left.price) <= FORMING_RIGHT_TOLERANCE_PCT,
	);

	let rightShoulder: Pivot | null = rightValleyCandidates.length
		? rightValleyCandidates[rightValleyCandidates.length - 1]
		: null;
	let isProvisional = false;

	// 確定右肩がない場合、現在価格が左肩近傍なら暫定右肩
	if (!rightShoulder) {
		const nearLeft = Math.abs(currentPrice - left.price) / Math.max(1, left.price) <= FORMING_RIGHT_TOLERANCE_PCT;
		if (nearLeft && currentPrice > head.price && currentPrice < postHeadPeak.price) {
			// 暫定右肩は確定ピボットではなく最新足の終値（forming H&S 側と同じ扱い）。
			rightShoulder = { idx: lastIdx, price: currentPrice, kind: 'L', extremePrice: currentPrice };
			isProvisional = true;
		}
	}
	if (!rightShoulder) return null;

	// 頭は形成区間の最安値であること（#154。総当たり化で外れた暗黙の保証を明示に戻す）
	if (!headIsExtremeInSpan(allValleys, head, left.idx, rightShoulder.idx, false)) {
		ctx.debugCandidates.push({
			type: 'inverse_head_and_shoulders',
			accepted: false,
			reason: 'head_not_extreme_in_span',
			indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
			details: { spanFromIdx: left.idx, spanToIdx: rightShoulder.idx, headIdx: head.idx, headPrice: head.price },
		});
		return null;
	}

	// 完成度計算
	const closeness =
		1 - Math.abs(rightShoulder.price - left.price) / Math.max(1e-12, left.price * FORMING_RIGHT_TOLERANCE_PCT);
	const progress = Math.max(0, Math.min(1, closeness));
	const completion = Math.min(1, (0.75 + 0.25 * progress) * (isProvisional ? 0.9 : 1.0));
	if (completion < FORMING_MIN_COMPLETION) {
		ctx.debugCandidates.push({
			type: 'inverse_head_and_shoulders',
			accepted: false,
			reason: 'completion_below_min',
			indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
			details: { completion, threshold: FORMING_MIN_COMPLETION },
		});
		return null;
	}

	const formationBars = Math.max(0, rightShoulder.idx - left.idx);
	if (formationBars < formingBars.minBars || formationBars > formingBars.maxBars) {
		ctx.debugCandidates.push({
			type: 'inverse_head_and_shoulders',
			accepted: false,
			reason: 'formation_bars_out_of_range',
			indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
			details: { formationBars, minBars: formingBars.minBars, maxBars: formingBars.maxBars },
		});
		return null;
	}

	const trend = validatePriorTrend(candles, left.idx, rightShoulder.idx - left.idx, 'down_or_sideways');
	if (!trend.ok) {
		ctx.debugCandidates.push({
			type: 'inverse_head_and_shoulders',
			accepted: false,
			reason: `prior_trend_mismatch:${trend.classification}`,
			indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
		});
		return null;
	}
	if (trend.classification === 'insufficient_data') {
		ctx.debugCandidates.push({
			type: 'inverse_head_and_shoulders',
			accepted: true,
			reason: 'prior_trend_insufficient_data',
			indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
		});
	}

	// ネックライン
	const preHeadPeaks = allPeaks.filter((p) => p.idx > left.idx && p.idx < head.idx);
	const preHeadPeak = preHeadPeaks.length
		? preHeadPeaks.reduce((best, p) => (p.price > best.price ? p : best), preHeadPeaks[0])
		: null;

	const neckline = preHeadPeak
		? [
				{ x: preHeadPeak.idx, y: preHeadPeak.price },
				{ x: postHeadPeak.idx, y: postHeadPeak.price },
			]
		: [
				{ x: left.idx, y: postHeadPeak.price },
				{ x: postHeadPeak.idx, y: postHeadPeak.price },
			];

	const confBase = Math.min(1, Math.max(0, 0.6 * closeness + 0.4 * progress));
	const confidence = Math.round(confBase * (isProvisional ? 0.9 : 1.0) * 100) / 100;

	if (confidence < FORMING_MIN_CONFIDENCE) {
		ctx.debugCandidates.push({
			type: 'inverse_head_and_shoulders',
			accepted: false,
			reason: 'confidence_below_min_forming',
			indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
			details: { confidence, threshold: FORMING_MIN_CONFIDENCE },
		});
		return null;
	}

	// サイズ検査（#138 欠陥 2-2）。配置が最後なのは `validatePatternSize` の docstring を参照。
	// 先行谷 / 先行山が取れないときは頭-戻り-右肩の 3 点で測る（交互列の形は保たれる）。
	const ihsSizeReason = validatePatternSize(
		'bottom',
		preHeadPeak ? [left, preHeadPeak, head, postHeadPeak, rightShoulder] : [head, postHeadPeak, rightShoulder],
		ctx.sizeThresholds,
	);
	if (ihsSizeReason) {
		ctx.debugCandidates.push({
			type: 'inverse_head_and_shoulders',
			accepted: false,
			reason: ihsSizeReason,
			indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
		});
		return null;
	}

	const formIhsNl = neckline[0].y;

	// 構造ゲート（#138 欠陥 2-1）。#131 が double にだけ入れたものの横展開。
	// `first` / `mid` は**サイズ検査に渡した構成点列の先頭 2 点**（`reversal-gate.ts` の冒頭）。
	// 先行山が取れず 3 点（頭-戻り-右肩）に縮む経路では、縮んだ配列の先頭 2 点がそのまま
	// `first` / `mid` になる。ネックライン水準は検出器自身が使う `neckline[0].y`。
	const gate = applyReversalGate({
		candles,
		pivots,
		side: 'bottom',
		first: preHeadPeak ? left : head,
		mid: preHeadPeak ?? postHeadPeak,
		necklinePrice: formIhsNl,
		type: 'inverse_head_and_shoulders',
		indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
		debugCandidates: ctx.debugCandidates,
	});
	if (!gate) return null;
	const structureGate = buildStructureGate(gate);

	const start = isoAt(left.idx);
	const end = isoAt(rightShoulder.idx);

	// forming にはブレイク足が無いので、投影の起点は**最終構成点**（暫定を含む右肩）の idx。
	// 高さは strict / relaxed と同じく頭の真下で測る（#208）。以前は `neckline[0].y`
	// （ネックラインの**左端**）を高さにも起点にも使っており、傾いたネックラインでは
	// 現在バー時点の水準と食い違っていた。
	const formIhsTarget = necklineProjectionTarget({
		neckline,
		anchorIdx: rightShoulder.idx,
		headIdx: head.idx,
		headPrice: head.price,
		direction: 'up',
		fallbackNecklinePrice: formIhsNl,
	});
	const formIhsStructureRange = start && end ? { start, end } : undefined;
	const formIhsPrecedingTrend = buildPrecedingTrend(candles, trend, left.idx);

	// 成功エントリ（issue #155）。role の付け方は formingHsForHead 側と同じ約束で、
	// 上下が反転するぶん「谷」が「山」になる。
	ctx.debugCandidates.push({
		type: 'inverse_head_and_shoulders',
		accepted: true,
		status: 'forming',
		indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
		points: [
			{ role: 'left_shoulder', idx: left.idx, price: left.price, isoTime: candles[left.idx]?.isoTime },
			...(preHeadPeak
				? [
						{
							role: 'pre_head_peak',
							idx: preHeadPeak.idx,
							price: preHeadPeak.price,
							isoTime: candles[preHeadPeak.idx]?.isoTime,
						},
					]
				: []),
			{ role: 'head', idx: head.idx, price: head.price, isoTime: candles[head.idx]?.isoTime },
			{
				role: 'post_head_peak',
				idx: postHeadPeak.idx,
				price: postHeadPeak.price,
				isoTime: candles[postHeadPeak.idx]?.isoTime,
			},
			{
				role: isProvisional ? 'right_shoulder_provisional' : 'right_shoulder',
				idx: rightShoulder.idx,
				price: rightShoulder.price,
				isoTime: candles[rightShoulder.idx]?.isoTime,
			},
		],
		details: {
			confidence,
			completionPct: Math.round(completion * 100),
			method: isProvisional ? 'forming_ihs_provisional' : 'forming_ihs',
		},
	});

	return {
		type: 'inverse_head_and_shoulders',
		confidence,
		range: { start, end },
		...(formIhsStructureRange ? { structureRange: formIhsStructureRange } : {}),
		confirmation: { type: 'not_confirmed' },
		...(formIhsPrecedingTrend ? { precedingTrend: formIhsPrecedingTrend } : {}),
		status: 'forming',
		pivots: [
			{ idx: left.idx, price: left.price, kind: 'L' as const, extremePrice: left.extremePrice },
			{ idx: head.idx, price: head.price, kind: 'L' as const, extremePrice: head.extremePrice },
			{ idx: postHeadPeak.idx, price: postHeadPeak.price, kind: 'H' as const, extremePrice: postHeadPeak.extremePrice },
			{
				idx: rightShoulder.idx,
				price: rightShoulder.price,
				kind: 'L' as const,
				extremePrice: rightShoulder.extremePrice,
			},
		],
		neckline,
		...(structureGate ? { structureGate } : {}),
		trendlineLabel: 'ネックライン',
		...(formIhsTarget !== undefined
			? { breakoutTarget: formIhsTarget, targetMethod: 'neckline_projection' as const }
			: {}),
		// 形成中は定義上ブレイクしていないので進捗は測れない。**それを言う**（#224 症状 2）——
		// `breakoutTarget` は出るので、黙ると LLM が「進捗 0%」と読み違える。
		...targetReachFields(omittedTargetReach('not_broken_out')),
		completionPct: Math.round(completion * 100),
		_method: isProvisional ? 'forming_ihs_provisional' : 'forming_ihs',
	};
}

// ── Main ──

export function detectHeadAndShoulders(ctx: DetectContext): DetectResult {
	const { want, includeForming } = ctx;
	const patterns: DeduplicablePattern[] = [];

	// 3) Inverse H&S
	let foundInverseHS = false;
	if (want.size === 0 || want.has('inverse_head_and_shoulders')) {
		const result = findStrictInverseHS(ctx);
		patterns.push(...result.patterns);
		foundInverseHS = result.found;
	}

	// 3b) H&S
	let foundHS = false;
	if (want.size === 0 || want.has('head_and_shoulders')) {
		const result = findStrictHS(ctx);
		patterns.push(...result.patterns);
		foundHS = result.found;
	}

	// Relaxed fallback
	if (!foundHS && (want.size === 0 || want.has('head_and_shoulders'))) {
		const relaxed = findRelaxedHS(ctx);
		if (relaxed) {
			patterns.push(relaxed);
			foundHS = true;
		}
	}
	if (!foundInverseHS && (want.size === 0 || want.has('inverse_head_and_shoulders'))) {
		const relaxed = findRelaxedInverseHS(ctx);
		if (relaxed) {
			patterns.push(relaxed);
			foundInverseHS = true;
		}
	}

	// 3c) 形成中 H&S
	if (includeForming && (want.size === 0 || want.has('head_and_shoulders'))) {
		patterns.push(...tryFormingHS(ctx));
	}

	// 3d) 形成中 Inverse H&S
	if (includeForming && (want.size === 0 || want.has('inverse_head_and_shoulders'))) {
		patterns.push(...tryFormingInverseHS(ctx));
	}

	return { patterns, found: { head_and_shoulders: foundHS, inverse_head_and_shoulders: foundInverseHS } };
}
