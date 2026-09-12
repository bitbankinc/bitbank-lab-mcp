/**
 * Double Top / Double Bottom 検出。
 *
 * **形成中（`status: 'forming'`）は出さない。** 取りうる status は `near_completion` /
 * `completed` / `invalid` / `expired` の 4 段（`detectDoubles` の docstring。issue #262 / #268）。
 * detect_patterns.ts Section 2 から抽出。
 */
import { generatePatternDiagram } from '../../lib/pattern-diagrams.js';
import { deduplicatePatterns, finalizeConf, periodScoreDays } from './helpers.js';
import { clamp01, relDev } from './regression.js';
import { averageDefinedAxes, breakoutQualityScore, retracementScore } from './scoring.js';
import {
	type BreakoutPathRejectReason,
	DOUBLE_LEVEL_MAX_PCT,
	detectPivotBeforeBreakout,
	detectTroughZoneReentry,
	isSameLevel,
	levelSpreadDetailsFrom,
	levelSpreadMetrics,
	necklineSideDetailsFrom,
	type PatternSizeRejectReason,
	type PriorTrendResult,
	type ReversalSide,
	type ReversalStructureResult,
	type SizeThresholds,
	validateLevelDiff,
	validateMainPointsNecklineSide,
	validatePriorTrend,
	validateReversalStructure,
} from './structural.js';
import type { Pivot } from './swing.js';
import { computeTargetReach, omittedTargetReach, targetReachFields } from './target-reach.js';
import {
	type CandleData,
	type DetectContext,
	type DetectResult,
	type PatternConfirmation,
	type PatternEntry,
	type PatternPrecedingTrend,
	type PatternScoreBreakdown,
	type PatternStructureGate,
	pushCand,
} from './types.js';

// ── Configuration ──
//
// ピボット間の最小距離の定数はここには無い。`ctx.minDist`（`resolveParams` が解決した
// `minBarsBetweenSwings`）を使う。以前は検出器ローカルの `MIN_PIVOT_DISTANCE_BARS = 5` が
// `ctx.minDist` を**無視して**いた（issue #130）。`detect_triples` / `detect_hs` は同じ反転系の
// ピボット列構造でありながら `ctx.minDist` をそのまま使っており、double だけが公開パラメータ
// `minBarsBetweenSwings` を黙って上書きしていた。時間足既定は日足 4 本 / 1時間足 2 本なので、
// **日足では 4 本間隔の構成が常に落ちていた**（BTC/JPY 2026-08-10 → 08-14 の 4 本がこれ）。
const BREAKOUT_BUFFER_PCT = 0.015;
const MAX_BARS_FROM_EXTREMUM = 20;
const RELAXED_TOLERANCE_FACTOR = 1.3;
const RELAXED_CONFIDENCE_PENALTY = 0.85;
// 形成中 double 専用の係数はすべて消えた（issue #262 / #268 案 C）。
// - `FORMING_TOLERANCE_MULTIPLIER` / `FORMING_VALLEY_INVALID_PCT`: `tryFormingDoubleBottom` 専用
//   だったので #262 で削除。前者と同名の係数は `detect_triples.ts` が形成中 triple 用に別途持つ
//   （値も用途も独立）。
// - `MIN_PATTERN_DAYS` / `MAX_FORMING_DAYS` / `FORMING_PEAK_TOLERANCE_PCT` /
//   `FORMING_BASE_COMPLETION` / `FORMING_COMPLETION_RANGE` / `MIN_FORMING_COMPLETION`:
//   `tryFormingDoubleTop` 専用だったので #268 案 C で削除。`MIN_FORMING_COMPLETION` は
//   「現行の定数では到達しない」と docstring に書いてあった（`completion` の下限 0.66 > 0.4）ので、
//   経路ごと消える今が整理の機会だった。
// 残るのは下の {@link FORMING_EXPIRY_BARS} だけで、これは未ブレイク構造（`near_completion`）の
// 期限判定（#262 / #270）が使う。
/**
 * 未ブレイク構造が `near_completion` を名乗れる、第2構成点確定からの経過バー数の上限
 * （issue #126 G4。名前は `forming` 時代のもので、#262 / #270 で `near_completion` に移った）。
 *
 * **{@link MAX_BARS_FROM_EXTREMUM} と同じ値であることに意味がある。** 完成済み判定の
 * `findBreakoutIdx` は第2構成点から `MAX_BARS_FROM_EXTREMUM` 本しかネックライン突破を探さない。
 * つまりそれを過ぎた候補は、以後どれだけ待っても `completed` にはならない。
 * 「まだ完成しうる」を成立させるには、未ブレイク側の期限を突破探索窓と一致させるしかない。
 *
 * これが無かったため、現値がネックラインを大きく上回っている状態でも「形成中」と
 * 報告され続けていた（8/25 時点で +17.8%）。
 */
const FORMING_EXPIRY_BARS = MAX_BARS_FROM_EXTREMUM;

type Pcand = (arg: Parameters<typeof pushCand>[1]) => void;

// ── Helper: ブレイクアウトインデックス検出 ──

function findBreakoutIdx(
	candles: CandleData[],
	afterIdx: number,
	necklinePrice: number,
	direction: 'below' | 'above',
): number {
	const end = Math.min(afterIdx + MAX_BARS_FROM_EXTREMUM + 1, candles.length);
	for (let k = afterIdx + 1; k < end; k++) {
		const closeK = Number(candles[k]?.close ?? NaN);
		if (!Number.isFinite(closeK)) continue;
		if (direction === 'below' && closeK < necklinePrice * (1 - BREAKOUT_BUFFER_PCT)) return k;
		if (direction === 'above' && closeK > necklinePrice * (1 + BREAKOUT_BUFFER_PCT)) return k;
	}
	return -1;
}

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

// ── Helper: ネックラインブレイク確認 → PatternConfirmation ──

function buildNecklineConfirmation(candles: CandleData[], breakoutIdx: number): PatternConfirmation | undefined {
	const date = candles[breakoutIdx]?.isoTime;
	if (!date) return undefined;
	return {
		type: 'neckline_breakout',
		date,
		idx: breakoutIdx,
		price: Number(candles[breakoutIdx]?.close ?? NaN),
	};
}

// ── Helper: ダブルトップ / ボトムのサイズ検証（不合格理由 or null） ──

/**
 * サイズ検査は**値幅の評価**なので、価格基準は `Pivot.extremePrice`（高安）で測る。
 *
 * #126 / #131 で構造ゲートの戻り率を `extremePrice` に寄せた判断の横展開（issue #130）。
 * 終値基準では**ヒゲの大きい区間で値幅が実際の 1/3 に見える**——BTC/JPY 日足の実在する
 * ダブルボトム（2026-08-03 → 08-10 → 08-14）は高安基準で 5.87% / 5.13% あるのに、
 * 終値基準では 1.85% / 1.67% にしか見えない。
 *
 * **この実例は 1day のもので、閾値も 1day の値（`heightPct` 3% / `depthPct` 5%）で読む**
 * （issue #152 で閾値が時間足別になった。実値は `config.ts` の `getSizeThresholdsForTf`）。
 * 1.85% < 3% かつ 1.67% < 5% で両方を割り、偽陰性になっていた。閾値が緩い下位時間足では
 * 同じ数値でも通るが、**基準を `extremePrice` にする理由は閾値と独立**——値幅を終値で測ると
 * 実際の 1/3 に見えるという歪みは、閾値をいくつにしても残る。
 *
 * **同水準判定（`near` / `isSameLevel(a.price, c.price)`）が終値基準のままなのは意図的。**
 * 「2 点が同じ水準か」は値幅ではなく水準の一致の問題で、ヒゲ 1 本で同水準判定が動くのを
 * 避けるために終値を見ている。ネックラインの「線」も同じ理由で終値基準
 * （`structural.ts` の {@link ReversalSide} の docstring を参照）。
 *
 * **引数は `Pick<Pivot, 'extremePrice'>`**（`validatePatternSize` と同じ形）。形成中パスの
 * 暫定構成点（最新足）は極値判定を通っていないので `Pivot` を組み立てられず、
 * `{ extremePrice: 最新足の終値 }` を渡す（issue #169。triple / H&S の形成中パスと同じ idiom）。
 */
function validateTopSize(
	a: Pick<Pivot, 'extremePrice'>,
	b: Pick<Pivot, 'extremePrice'>,
	c: Pick<Pivot, 'extremePrice'>,
	thresholds: SizeThresholds,
): PatternSizeRejectReason | null {
	const heightPct = Math.abs(a.extremePrice - b.extremePrice) / Math.max(1, Math.max(a.extremePrice, b.extremePrice));
	if (heightPct < thresholds.heightPct) return 'pattern_too_small';
	const peakAvg = (a.extremePrice + c.extremePrice) / 2;
	const valleyDepthPct = (peakAvg - b.extremePrice) / Math.max(1, peakAvg);
	if (valleyDepthPct < thresholds.depthPct) return 'valley_too_shallow';
	return null;
}

/** {@link validateTopSize} の符号反転版。価格基準・引数型の根拠は同関数の docstring を参照。 */
function validateBottomSize(
	a: Pick<Pivot, 'extremePrice'>,
	b: Pick<Pivot, 'extremePrice'>,
	c: Pick<Pivot, 'extremePrice'>,
	thresholds: SizeThresholds,
): PatternSizeRejectReason | null {
	const heightPct = Math.abs(a.extremePrice - b.extremePrice) / Math.max(1, Math.max(a.extremePrice, b.extremePrice));
	if (heightPct < thresholds.heightPct) return 'pattern_too_small';
	const valleyAvg = (a.extremePrice + c.extremePrice) / 2;
	const peakHeightPct = (b.extremePrice - valleyAvg) / Math.max(1, valleyAvg);
	if (peakHeightPct < thresholds.depthPct) return 'peak_too_shallow';
	return null;
}

/**
 * 高さ相対の同水準検査（issue #178 項目 4）。棄却したら debug candidate を積んで `true` を返す
 * （呼び出し側は `continue`）。
 *
 * ## なぜ double にも要るのか
 *
 * 既存の同水準判定は `near`（`tolerancePct`）と `isSameLevel`（{@link DOUBLE_LEVEL_MAX_PCT}）の
 * 2 段で、**どちらも分母が価格水準**——パターン自身の高さと無関係。#138 が triple で問題にした
 * 転倒がそのまま当てはまる形で、`levelSpreadMetrics` の分子（2 山 / 2 谷）は分母（全構成点の
 * 全振幅）を作る点でもあるため、**比が「2 山の差がパターンの深さの何割か」という自己完結した
 * 命題になる**（H&S の肩は分母の端点にならないので同じ指標が意味を持たず、#178 項目 3 は
 * 「不要」で決着している）。**同じ点を使うだけで、分子は終値・分母は高安**なので
 * `spreadAbs <= heightAbs` は成り立たない（比の上界は `validateLevelDiff` の docstring）。
 *
 * ## 呼び出し位置
 *
 * **既存の棄却検査をすべて通過した後**——{@link applyStructuralGate} と
 * {@link checkPostPivotInvalidation} の**両方より後**。前に置くと
 * `neckline_above_pre_decline_high` / `reclassified_as_triple_top` を持つ候補の `reason` を
 * 横取りする（`validatePatternSize` / `validateLevelSpread` の docstring と同じ理由）。
 * 最後に置けば **「これまで accepted だった候補だけを落とす」ことが位置から保証される**。
 *
 * ## 理由コードに `_relaxed` 接尾辞を付けない
 *
 * 本ファイルの `_relaxed` 接尾辞は**閾値が違う検査**に付いている（`peaks_not_equal` は
 * `tolerancePct`、`peaks_not_equal_relaxed` は `tolerancePct × RELAXED_TOLERANCE_FACTOR`）。
 * 本ゲートは strict / relaxed とも同じ `MAX_LEVEL_SPREAD_RATIO` を使うので分けない
 * ——`reclassified_as_triple_top` / `prior_trend_mismatch:` が既に両経路で無印なのと同じ。
 *
 * ## `levelTolerancePct`
 *
 * `details` に載せるのは**その経路の同水準判定の実効値**。double は `near`（または
 * `nearRelaxed`）と `isSameLevel` が**同じ量（`relDiff`）を見ている**ので、実効値は
 * 2 つの `min`。`HS_SHOULDER_MAX_PCT` の docstring が H&S の肩について書いているのと同じ構造で、
 * 現行の既定パラメータでは全時間足で {@link DOUBLE_LEVEL_MAX_PCT} 側が律速する。
 */
function rejectByLevelDiff(
	side: ReversalSide,
	type: 'double_top' | 'double_bottom',
	a: Pivot,
	b: Pivot,
	c: Pivot,
	levelTolerancePct: number,
	pcand: Pcand,
): boolean {
	const metrics = levelSpreadMetrics([a, c], [a, b, c]);
	const reason = validateLevelDiff(side, metrics);
	if (!reason) return false;
	const outerRole = side === 'top' ? 'peak' : 'valley';
	const midRole = side === 'top' ? 'valley' : 'peak';
	pcand({
		type,
		accepted: false,
		reason,
		idxs: [a.idx, b.idx, c.idx],
		pts: [
			{ role: `${outerRole}1`, idx: a.idx, price: a.price },
			{ role: midRole, idx: b.idx, price: b.price },
			{ role: `${outerRole}2`, idx: c.idx, price: c.price },
		],
		details: levelSpreadDetailsFrom(metrics, levelTolerancePct),
	});
	return true;
}

/**
 * 主構成点とネックラインの位置関係の検査（issue #216 Phase 2）。棄却したら debug candidate を
 * 積んで `true` を返す（呼び出し側は `continue`）。判定の実体と根拠——価格基準を `price`
 * （終値）にした理由、許容幅を置かない理由、H&S 系に配線しない理由——は
 * {@link validateMainPointsNecklineSide} の docstring が単一ソース。
 *
 * ## double の主構成点は `a` と `c` の 2 点。`b` は渡さない
 *
 * **`b`（中間構成点）はネックラインの定義点そのもの**（`necklinePrice = b.price`）なので、
 * 検査に含めると `deviation === 0` で必ず失格になる——全 double が落ちる。
 * triple の 3 点がすべて主構成点なのに対し、double は 3 点のうち 2 点だけが主構成点で、
 * この非対称は「ネックラインをどう引くか」の違いから来ている
 * （triple は 2 つの中間構成点の平均、double は 1 つの中間構成点そのもの）。
 *
 * ## 呼び出し位置
 *
 * {@link rejectByLevelDiff} の**直後**——既存の棄却検査（{@link applyStructuralGate} /
 * {@link checkPostPivotInvalidation} / 高さ相対の同水準検査）をすべて通過した後。
 * 理由は `validatePatternSize` / `validateLevelSpread` の docstring と同じで、
 * 前に置くと固有の理由コードを持つ候補の `reason` を横取りする。
 *
 * ## 理由コードに `_relaxed` 接尾辞を付けない
 *
 * {@link rejectByLevelDiff} と同じ——本ゲートは strict / relaxed とも**同じ判定**
 * （閾値を持たないので緩める余地が無い）。
 */
function rejectByNecklineSide(
	side: ReversalSide,
	type: 'double_top' | 'double_bottom',
	a: Pivot,
	b: Pivot,
	c: Pivot,
	necklinePrice: number,
	pcand: Pcand,
): boolean {
	const { reason, offenders } = validateMainPointsNecklineSide(side, [a, c], necklinePrice);
	if (!reason) return false;
	const outerRole = side === 'top' ? 'peak' : 'valley';
	const midRole = side === 'top' ? 'valley' : 'peak';
	pcand({
		type,
		accepted: false,
		reason,
		idxs: [a.idx, b.idx, c.idx],
		pts: [
			{ role: `${outerRole}1`, idx: a.idx, price: a.price },
			{ role: midRole, idx: b.idx, price: b.price },
			{ role: `${outerRole}2`, idx: c.idx, price: c.price },
		],
		details: necklineSideDetailsFrom(necklinePrice, offenders),
	});
	return true;
}

// ── Helper: 構造ゲート（issue #126）──

/**
 * 構造ゲート（{@link validateReversalStructure}）を適用し、不合格なら debug candidate を
 * 積んで `null` を返す。
 *
 * **スコアの減点ではなく hard reject。** ここを通らない形は整合度がいくら高くても
 * 検出結果に出さない。issue #126 の 7/1〜8/3 の偽陽性（ネックラインが先行下落の起点より
 * 4.88% 上にあり「下抜け」という事象が存在しないまま整合度 1.00 が付いていた）はここで落ちる。
 *
 * 価格基準は `Pivot.extremePrice`（高安）。既存の同水準判定（`isSameLevel(a.price, c.price)`）が
 * 終値基準のままなのは意図的で、本ゲートだけが `extremePrice` を見る——
 * 理由は `structural.ts` の {@link ReversalSide} の docstring を参照。
 */
function applyStructuralGate(
	candles: CandleData[],
	pivots: ReadonlyArray<Pivot>,
	side: ReversalSide,
	a: Pivot,
	b: Pivot,
	c: Pivot,
	necklinePrice: number,
	type: 'double_top' | 'double_bottom',
	pcand: Pcand,
): ReversalStructureResult | null {
	const gate = validateReversalStructure({ candles, pivots, first: a, mid: b, necklinePrice, side });
	if (gate.ok) return gate;
	const outerRole = side === 'bottom' ? 'valley' : 'peak';
	pcand({
		type,
		accepted: false,
		reason: gate.reason,
		idxs: [a.idx, b.idx, c.idx],
		pts: [
			...(gate.priorExtreme
				? [{ role: 'prior_extreme', idx: gate.priorExtreme.idx, price: gate.priorExtreme.extremePrice }]
				: []),
			{ role: `${outerRole}1`, idx: a.idx, price: a.price },
			{ role: side === 'bottom' ? 'peak' : 'valley', idx: b.idx, price: b.price },
			{ role: `${outerRole}2`, idx: c.idx, price: c.price },
		],
	});
	return null;
}

/** {@link ReversalStructureResult} → `PatternEntry.structureGate` */
function buildStructureGate(gate: ReversalStructureResult): PatternStructureGate | undefined {
	const out: PatternStructureGate = {};
	if (gate.retracementRatio !== undefined) out.retracementRatio = Number(gate.retracementRatio.toFixed(4));
	if (gate.priorExtreme) {
		out.priorExtremeIdx = gate.priorExtreme.idx;
		out.priorExtremePrice = gate.priorExtreme.extremePrice;
	}
	if (gate.necklineCrossIdx !== undefined) out.necklineCrossIdx = gate.necklineCrossIdx;
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 完成済みダブルの整合度サブスコア。
 *
 * 旧実装は `(tolMargin + symmetry + per) / 3` で、`tolMargin` と `symmetry` は
 * どちらも「2 点が同水準か」を測る同じ軸だった（実質 2 軸）。**戻り率**と**ブレイク品質**を
 * 独立軸として足し、4 軸の平均にする。構造的に無効な形に 1.00 が付いていた問題
 * （issue #126 G3）は構造ゲート側で塞ぐが、通過後の形の良さもこれで解像度が上がる。
 */
function buildDoubleScore(opts: {
	outer1: number;
	outer2: number;
	necklinePrice: number;
	breakoutClose: number;
	patternHeight: number;
	side: ReversalSide;
	retracementRatio?: number;
	durationScore: number;
}): { components: PatternScoreBreakdown; base: number } {
	const symmetry = clamp01(1 - relDev(opts.outer1, opts.outer2));
	const retracement = retracementScore(opts.retracementRatio);
	const breakoutQuality = breakoutQualityScore(opts.necklinePrice, opts.breakoutClose, opts.patternHeight, opts.side);
	const components: PatternScoreBreakdown = {
		symmetry: Number(symmetry.toFixed(4)),
		...(retracement !== undefined ? { retracement: Number(retracement.toFixed(4)) } : {}),
		...(breakoutQuality !== undefined ? { breakoutQuality: Number(breakoutQuality.toFixed(4)) } : {}),
		duration: Number(opts.durationScore.toFixed(4)),
	};
	// 算出できなかった軸は平均から外す（0 として混ぜると欠測が減点になる）。
	// `symmetry` は常に数値なので `averageDefinedAxes` が `undefined` を返すことはない。
	const base = averageDefinedAxes([symmetry, retracement, breakoutQuality, opts.durationScore]) ?? symmetry;
	return { components, base };
}

/**
 * 第2構成点の確定後にパターンが崩れていないかを見て、崩れていれば終端 status を返す
 * （issue #126 G5）。
 *
 * 谷ゾーンへ戻ってしまった候補は、同水準の第3構成点があれば triple への再分類対象なので
 * **何も出さない**（`detect_triples` に委ねる）。無ければ `invalid` として理由コード付きで出す。
 */
function checkPostPivotInvalidation(opts: {
	candles: CandleData[];
	pivots: ReadonlyArray<Pivot>;
	a: Pivot;
	b: Pivot;
	c: Pivot;
	untilIdx: number;
	side: ReversalSide;
}): { verdict: 'ok' } | { verdict: 'reclassify' } | { verdict: 'invalid'; reason: string; idx?: number } {
	const reentry = detectTroughZoneReentry({
		candles: opts.candles,
		first: opts.a,
		mid: opts.b,
		second: opts.c,
		untilIdx: opts.untilIdx,
		side: opts.side,
	});
	if (!reentry.reentered) return { verdict: 'ok' };

	const level = (opts.a.price + opts.c.price) / 2;
	const kind = opts.side === 'bottom' ? 'L' : 'H';
	const hasThird = opts.pivots.some(
		(p) => p.idx > opts.c.idx && p.kind === kind && isSameLevel(p.price, level, DOUBLE_LEVEL_MAX_PCT),
	);
	if (hasThird) return { verdict: 'reclassify' };
	return { verdict: 'invalid', reason: 're_entered_trough_zone', idx: reentry.idx };
}

/** 完成済みパスの終端 status（`status` / `invalidReason` をまとめて展開するための形）。 */
type DoubleTerminal = { status: 'invalid'; invalidReason: string };

/** 未ブレイクの構造（ブレイク足が存在しない）の status（issue #262）。 */
type DoubleUnbrokenStatus =
	| { status: 'near_completion' }
	| { status: 'expired'; invalidReason: string }
	| { status: 'invalid'; invalidReason: string };

/**
 * **構成点 3 点が揃っていて、まだネックラインを突破していない**構造の status を決める（issue #262）。
 *
 * 完成済み 4 経路（strict / relaxed × top / bottom）は以前、`findBreakoutIdx` が −1 のとき
 * `no_breakout` で棄却して終わっていた。`detect_triples` / `detect_hs` の完成済み経路は同じ状況で
 * `status: 'near_completion'` を出しており、**double 2 型だけがこの status を一度も出さなかった**。
 * 「構造は完成し、ブレイクを待っている」という段階そのものは double にも実在するので、
 * 同じ語を同じ意味で使う（issue #262 の決定 2）。
 *
 * ## triple / H&S より 2 段多い理由（#126 G4 / G5 を引き継ぐ）
 *
 * 旧 `tryFormingDoubleBottom`（#262 で削除）は、まさにこの段階を `status: 'forming'` という
 * 誤ラベルで出しており、**終端の 2 条件を持っていた**。同じ判定をここへ移す:
 *
 * - **期限切れ（#126 G4）**: 第2構成点 `c` から {@link FORMING_EXPIRY_BARS} を過ぎても未ブレイクなら
 *   `expired`。`findBreakoutIdx` は `c` から {@link MAX_BARS_FROM_EXTREMUM} 本しか突破を探さないので、
 *   窓を過ぎた候補は**以後どれだけ待っても `completed` にならない**。2 つの定数が同値であることに
 *   意味があるのはこのため（{@link FORMING_EXPIRY_BARS} の docstring が単一ソース）。
 * - **無効化（#126 G5）**: {@link checkPostPivotInvalidation} が谷（山）ゾーンへの再進入を見つけたら
 *   `invalid`。未ブレイクなので走査終端は `untilIdx = lastIdx`（呼び出し側が渡す）。
 *
 * `reclassify`（同水準の第3構成点があり triple へ委ねる）は呼び出し側が先に `continue` するので
 * ここには来ない。到達しても `near_completion` にはせず、フォールスルーの分岐を書かずに済ませている。
 *
 * ## #242 の経路ゲート（{@link checkBreakoutPath}）は掛けない
 *
 * `near_completion` は定義上「最終構成点からブレイクまでの経路がまだ無い」状態なので、
 * その経路を検証するゲートは掛けようがない。呼び出し側は `isCompleted` でも絞っている。
 */
function unbrokenStatusFields(opts: {
	post: ReturnType<typeof checkPostPivotInvalidation>;
	/** 第2構成点（山2 / 谷2）の idx。ここからの経過バー数で期限切れを判定する。 */
	lastPivotIdx: number;
	lastIdx: number;
}): DoubleUnbrokenStatus {
	if (opts.post.verdict === 'invalid') return { status: 'invalid', invalidReason: opts.post.reason };
	if (opts.lastIdx - opts.lastPivotIdx > FORMING_EXPIRY_BARS)
		return { status: 'expired', invalidReason: 'forming_expired' };
	return { status: 'near_completion' };
}

/**
 * 最終構成点（山2 / 谷2）からネックライン突破バーまでの**経路**を検証する（issue #242）。
 * 不合格なら `view=debug` の候補を積み、終端 status を返す。合格なら `null`。
 *
 * 判定の実体と根拠——なぜ水準を問わないのか、既存の {@link checkPostPivotInvalidation}
 * （25% ゾーン再進入）で足りないのはなぜか——は `structural.ts` の
 * {@link detectPivotBeforeBreakout} の docstring が単一ソース。
 *
 * ## 呼び出し位置
 *
 * {@link rejectByNecklineSide} の**直後**——既存の棄却検査をすべて通過し、`findBreakoutIdx` で
 * ブレイクが確定した後。`validatePatternSize` / `applyReversalGate` の docstring の原則
 * （固有の理由コードを持つ候補の `reason` を横取りしない）に従う。最後に置けば
 * **「これまで accepted だった候補だけを落とす」ことが位置から保証される。**
 *
 * ## `re_entered_trough_zone` を横取りしない
 *
 * {@link checkPostPivotInvalidation} が既に `invalid` を出している候補には**本ゲートを掛けない**
 * （呼び出し側が `post.verdict === 'ok'` のときだけ呼ぶ）。2 つの検査は独立で、どちらも当たる
 * 候補はありうるが、**先に固有の理由が付いているならそれが診断として正しい**。
 * `reclassified_as_triple_*` の分岐（`hasThird`）も同じ理由で本ゲートより前に残してある。
 *
 * ## `status: 'invalid'` で出す。候補にも理由を残す
 *
 * `re_entered_trough_zone` と同じ扱いで、`includeInvalid: true` なら
 * `status: 'invalid'` + `invalidReason` として出力する。**加えて `view=debug` の候補にも積む**
 * ——既定（`includeInvalid: false`）では `invalid` のエントリが丸ごと消えるため、
 * 候補に残さないと「なぜ消えたか」が LLM にも利用者にも届かない。
 *
 * ## 理由コードに `_relaxed` 接尾辞を付けない
 *
 * {@link rejectByLevelDiff} / {@link rejectByNecklineSide} と同じ——本ゲートは strict / relaxed とも
 * 同じ判定（閾値を持たないので緩める余地が無い）。
 */
function checkBreakoutPath(opts: {
	pivots: ReadonlyArray<Pivot>;
	side: ReversalSide;
	type: 'double_top' | 'double_bottom';
	a: Pivot;
	b: Pivot;
	c: Pivot;
	breakoutIdx: number;
	pcand: Pcand;
}): DoubleTerminal | null {
	const { pivots, side, type, a, b, c, breakoutIdx, pcand } = opts;
	const res = detectPivotBeforeBreakout({ pivots, lastPivotIdx: c.idx, breakoutIdx, side });
	if (!res.found || !res.reason) return null;
	const outerRole = side === 'top' ? 'peak' : 'valley';
	const midRole = side === 'top' ? 'valley' : 'peak';
	pcand({
		type,
		accepted: false,
		reason: res.reason,
		idxs: [a.idx, b.idx, c.idx],
		pts: [
			{ role: `${outerRole}1`, idx: a.idx, price: a.price },
			{ role: midRole, idx: b.idx, price: b.price },
			{ role: `${outerRole}2`, idx: c.idx, price: c.price },
			...(res.pivot ? [{ role: `${outerRole}_after_last`, idx: res.pivot.idx, price: res.pivot.price }] : []),
		],
		details: breakoutPathDetails(c.idx, breakoutIdx, res.pivot),
	});
	return { status: 'invalid', invalidReason: res.reason satisfies BreakoutPathRejectReason };
}

/** {@link checkBreakoutPath} の `details`。閾値を持たないゲートなので、出すのは位置と値だけ。 */
function breakoutPathDetails(
	lastPivotIdx: number,
	breakoutIdx: number,
	offender: Pivot | undefined,
): Record<string, unknown> {
	return {
		lastPivotIdx,
		breakoutIdx,
		...(offender
			? { offenderIdx: offender.idx, offenderPrice: offender.price, offenderExtremePrice: offender.extremePrice }
			: {}),
	};
}

// ── Helper: relaxed fallback ダブルトップ検索 ──

/**
 * 同水準判定を `factor` 倍に緩めたダブルトップ検索。**strict が `completed` を 1 件も出さなかったときだけ**
 * 呼ばれるフォールバックで、**1 件しか返さない**（最初に組み上がった `completed` 候補でその場で打ち切る）。
 *
 * 緩めているのは山どうしの同水準判定（`nearRelaxed`）だけで、サイズ検査・構造ゲート・
 * 高さ相対・ネックライン側・経路検証は strict と同じものが同じ順で掛かる。整合度には
 * {@link RELAXED_CONFIDENCE_PENALTY} を掛け、provenance を `_fallback` に残す。
 *
 * `completed` 以外の status が付いた候補（`invalid` / `expired` / `near_completion`）は
 * 即 return せず退避する——理由は関数内 `nonCompletedFallback` の docstring。
 */
function findRelaxedDoubleTop(
	pivots: Pivot[],
	candles: CandleData[],
	tolerancePct: number,
	factor: number,
	minDist: number,
	pcand: Pcand,
	sizeThresholds: SizeThresholds,
	tz: string | undefined,
	type: string,
	includeForming: boolean,
): PatternEntry | null {
	const tolRelax = tolerancePct * factor;
	const lastIdx = candles.length - 1;
	const nearRelaxed = (x: number, y: number) => Math.abs(x - y) <= Math.max(x, y) * tolRelax;

	/**
	 * `completed` 以外の status（`invalid` / `expired` / `near_completion`）が付いた候補の置き場
	 * （issue #242 のレビュー指摘。#262 で `near_completion` を追加）。
	 *
	 * relaxed は**最初に組み上がった候補を返してその場で走査を終える**ので、
	 * `H-L-H-L-H` のように候補が重なる列で先頭の候補が `invalid` になると、
	 * **後ろにある成立した候補まで一緒に失われる**（relaxed は同 type の strict が
	 * 0 件のときだけ走るフォールバックなので、そのとき検出結果は 0 件になる）。
	 * 退避して走査を続け、`completed` な候補が無かったときだけ返す。
	 * **1 件だけ返す契約は変えない**（`??=` なので退避されるのは最初の 1 件）。
	 *
	 * `near_completion` を `completed` と同じ「即 return」にしないのは同じ理由——
	 * ブレイク待ちの構造を 1 件拾っただけで、後ろにある**完成済み**の候補を捨てることになる。
	 */
	let nonCompletedFallback: PatternEntry | null = null;

	for (let i = 0; i + 2 < pivots.length; i++) {
		const a = pivots[i],
			b = pivots[i + 1],
			c = pivots[i + 2];
		if (!(a.kind === 'H' && b.kind === 'L' && c.kind === 'H')) continue;
		if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;

		const sizeReason = validateTopSize(a, b, c, sizeThresholds);
		if (sizeReason) {
			const reason = sizeReason === 'valley_too_shallow' ? 'valley_too_shallow_relaxed' : sizeReason;
			pcand({ type: 'double_top', accepted: false, reason, idxs: [a.idx, b.idx, c.idx] });
			continue;
		}
		if (!nearRelaxed(a.price, c.price)) {
			pcand({
				type: 'double_top',
				accepted: false,
				reason: 'peaks_not_equal_relaxed',
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'peak1', idx: a.idx, price: a.price },
					{ role: 'peak2', idx: c.idx, price: c.price },
				],
			});
			continue;
		}
		if (!isSameLevel(a.price, c.price, DOUBLE_LEVEL_MAX_PCT)) {
			pcand({
				type: 'double_top',
				accepted: false,
				reason: 'peaks_not_equal_structural',
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'peak1', idx: a.idx, price: a.price },
					{ role: 'peak2', idx: c.idx, price: c.price },
				],
			});
			continue;
		}

		const necklinePrice = b.price;
		const breakoutIdx = findBreakoutIdx(candles, c.idx, necklinePrice, 'below');
		const isCompleted = breakoutIdx >= 0;
		// 未ブレイクでも棄却しない（issue #262）。`includeForming` が false のときだけ
		// 従来どおり `no_breakout_relaxed` で抜ける（strict 側の同じ箇所を参照）。
		if (!isCompleted && !includeForming) {
			pcand({
				type: 'double_top',
				accepted: false,
				reason: 'no_breakout_relaxed',
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'peak1', idx: a.idx, price: a.price },
					{ role: 'valley', idx: b.idx, price: b.price },
					{ role: 'peak2', idx: c.idx, price: c.price },
				],
			});
			continue;
		}
		const trend = validatePriorTrend(candles, a.idx, (isCompleted ? breakoutIdx : lastIdx) - a.idx, 'up_or_sideways');
		if (!trend.ok) {
			pcand({
				type: 'double_top',
				accepted: false,
				reason: `prior_trend_mismatch:${trend.classification}`,
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'peak1', idx: a.idx, price: a.price },
					{ role: 'valley', idx: b.idx, price: b.price },
					{ role: 'peak2', idx: c.idx, price: c.price },
				],
			});
			continue;
		}
		if (trend.classification === 'insufficient_data') {
			pcand({
				type: 'double_top',
				accepted: true,
				reason: 'prior_trend_insufficient_data',
				idxs: [a.idx, b.idx, c.idx],
			});
		}

		const gate = applyStructuralGate(candles, pivots, 'top', a, b, c, necklinePrice, 'double_top', pcand);
		if (!gate) continue;

		const post = checkPostPivotInvalidation({
			candles,
			pivots,
			a,
			b,
			c,
			untilIdx: isCompleted ? breakoutIdx - 1 : lastIdx,
			side: 'top',
		});
		if (post.verdict === 'reclassify') {
			pcand({
				type: 'double_top',
				accepted: false,
				reason: 'reclassified_as_triple_top',
				idxs: [a.idx, b.idx, c.idx],
			});
			continue;
		}
		if (rejectByLevelDiff('top', 'double_top', a, b, c, Math.min(tolRelax, DOUBLE_LEVEL_MAX_PCT), pcand)) continue;
		if (rejectByNecklineSide('top', 'double_top', a, b, c, necklinePrice, pcand)) continue;
		// 最終構成点 → ブレイクの経路検証（issue #242）。既に `invalid` が付いている候補には掛けない。
		// **未ブレイク（`near_completion`）にも掛けない**——検証する経路がまだ存在しない（#262）。
		const pathTerminal =
			isCompleted && post.verdict === 'ok'
				? checkBreakoutPath({ pivots, side: 'top', type: 'double_top', a, b, c, breakoutIdx, pcand })
				: null;

		const start = candles[a.idx].isoTime,
			end = isCompleted ? candles[breakoutIdx]?.isoTime : candles[c.idx]?.isoTime;
		if (!start || !end) continue;

		const neckline = [
			{ x: a.idx, y: necklinePrice },
			{ x: isCompleted ? breakoutIdx : c.idx, y: necklinePrice },
		];
		const per = periodScoreDays(start, end);
		const dtRelAvgPeak = (a.price + c.price) / 2;
		const dtRelBp = isCompleted ? Number(candles[breakoutIdx]?.close ?? NaN) : NaN;
		const { components: scoreComponents, base } = buildDoubleScore({
			outer1: a.price,
			outer2: c.price,
			necklinePrice,
			breakoutClose: dtRelBp,
			patternHeight: dtRelAvgPeak - necklinePrice,
			side: 'top',
			retracementRatio: gate.retracementRatio,
			durationScore: per,
		});
		const confidence = finalizeConf(base * RELAXED_CONFIDENCE_PENALTY, 'double_top');
		const diagram = generatePatternDiagram(
			'double_top',
			[
				{ ...a, date: candles[a.idx]?.isoTime },
				{ ...b, date: candles[b.idx]?.isoTime },
				{ ...c, date: candles[c.idx]?.isoTime },
			],
			{ price: necklinePrice },
			{ start, end },
			{ tz, type },
		);
		const dtRelTarget = Math.round(necklinePrice - (dtRelAvgPeak - necklinePrice));
		// 未ブレイク / ブレイク足の終値が非有限——どちらも**理由を名乗って**畳む（#224 症状 2）。
		const dtRelReach = !isCompleted
			? omittedTargetReach('not_broken_out')
			: Number.isFinite(dtRelBp)
				? computeTargetReach(candles, breakoutIdx, dtRelBp, dtRelTarget, 'down', dtRelAvgPeak - necklinePrice)
				: omittedTargetReach('invalid_breakout_price');
		const structureRange =
			candles[a.idx]?.isoTime && candles[c.idx]?.isoTime
				? { start: candles[a.idx].isoTime as string, end: candles[c.idx].isoTime as string }
				: undefined;
		const confirmation = isCompleted
			? buildNecklineConfirmation(candles, breakoutIdx)
			: ({ type: 'not_confirmed' } as const);
		const precedingTrend = buildPrecedingTrend(candles, trend, a.idx);

		const structureGate = buildStructureGate(gate);
		const unbroken = isCompleted ? null : unbrokenStatusFields({ post, lastPivotIdx: c.idx, lastIdx });

		const entry: PatternEntry = {
			type: 'double_top',
			confidence,
			scoreComponents,
			...(structureGate ? { structureGate } : {}),
			range: { start, end },
			...(structureRange ? { structureRange } : {}),
			...(confirmation ? { confirmation } : {}),
			...(precedingTrend ? { precedingTrend } : {}),
			...(unbroken ??
				(post.verdict === 'invalid'
					? { status: 'invalid' as const, invalidReason: post.reason }
					: (pathTerminal ?? {}))),
			pivots: [a, b, c],
			neckline,
			trendlineLabel: 'ネックライン',
			...(isCompleted ? { breakout: { idx: breakoutIdx, price: dtRelBp }, breakoutBarIndex: breakoutIdx } : {}),
			breakoutTarget: dtRelTarget,
			targetMethod: 'neckline_projection' as const,
			...targetReachFields(dtRelReach),
			structureDiagram: diagram,
			_fallback: `relaxed_double_x${factor}`,
		};
		// 完成済み（status 未設定）だけが即 return。それ以外は退避して走査を続ける。
		if (entry.status !== undefined) {
			nonCompletedFallback ??= entry;
			continue;
		}
		return entry;
	}
	return nonCompletedFallback;
}

// ── Helper: relaxed fallback ダブルボトム検索 ──

/** {@link findRelaxedDoubleTop} の上下対称。契約・緩める範囲・退避の理由は同関数の docstring を参照。 */
function findRelaxedDoubleBottom(
	pivots: Pivot[],
	candles: CandleData[],
	tolerancePct: number,
	factor: number,
	minDist: number,
	pcand: Pcand,
	sizeThresholds: SizeThresholds,
	tz: string | undefined,
	type: string,
	includeForming: boolean,
): PatternEntry | null {
	const tolRelax = tolerancePct * factor;
	const lastIdx = candles.length - 1;
	const nearRelaxed = (x: number, y: number) => Math.abs(x - y) <= Math.max(x, y) * tolRelax;

	/**
	 * `completed` 以外の status（`invalid` / `expired` / `near_completion`）が付いた候補の置き場
	 * （issue #242 のレビュー指摘。#262 で `near_completion` を追加）。
	 *
	 * relaxed は**最初に組み上がった候補を返してその場で走査を終える**ので、
	 * `H-L-H-L-H` のように候補が重なる列で先頭の候補が `invalid` になると、
	 * **後ろにある成立した候補まで一緒に失われる**（relaxed は同 type の strict が
	 * 0 件のときだけ走るフォールバックなので、そのとき検出結果は 0 件になる）。
	 * 退避して走査を続け、`completed` な候補が無かったときだけ返す。
	 * **1 件だけ返す契約は変えない**（`??=` なので退避されるのは最初の 1 件）。
	 *
	 * `near_completion` を `completed` と同じ「即 return」にしないのは同じ理由——
	 * ブレイク待ちの構造を 1 件拾っただけで、後ろにある**完成済み**の候補を捨てることになる。
	 */
	let nonCompletedFallback: PatternEntry | null = null;

	for (let i = 0; i + 2 < pivots.length; i++) {
		const a = pivots[i],
			b = pivots[i + 1],
			c = pivots[i + 2];
		if (!(a.kind === 'L' && b.kind === 'H' && c.kind === 'L')) continue;
		if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;

		const sizeReason = validateBottomSize(a, b, c, sizeThresholds);
		if (sizeReason) {
			const reason = sizeReason === 'peak_too_shallow' ? 'peak_too_shallow_relaxed' : sizeReason;
			pcand({ type: 'double_bottom', accepted: false, reason, idxs: [a.idx, b.idx, c.idx] });
			continue;
		}
		if (!nearRelaxed(a.price, c.price)) {
			pcand({
				type: 'double_bottom',
				accepted: false,
				reason: 'valleys_not_equal_relaxed',
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'valley1', idx: a.idx, price: a.price },
					{ role: 'valley2', idx: c.idx, price: c.price },
				],
			});
			continue;
		}
		if (!isSameLevel(a.price, c.price, DOUBLE_LEVEL_MAX_PCT)) {
			pcand({
				type: 'double_bottom',
				accepted: false,
				reason: 'valleys_not_equal_structural',
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'valley1', idx: a.idx, price: a.price },
					{ role: 'valley2', idx: c.idx, price: c.price },
				],
			});
			continue;
		}

		const necklinePrice = b.price;
		const breakoutIdx = findBreakoutIdx(candles, c.idx, necklinePrice, 'above');
		const isCompleted = breakoutIdx >= 0;
		// 未ブレイクでも棄却しない（issue #262）。`includeForming` が false のときだけ
		// 従来どおり `no_breakout_relaxed` で抜ける（strict 側の同じ箇所を参照）。
		if (!isCompleted && !includeForming) {
			pcand({
				type: 'double_bottom',
				accepted: false,
				reason: 'no_breakout_relaxed',
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'valley1', idx: a.idx, price: a.price },
					{ role: 'peak', idx: b.idx, price: b.price },
					{ role: 'valley2', idx: c.idx, price: c.price },
				],
			});
			continue;
		}
		const trend = validatePriorTrend(candles, a.idx, (isCompleted ? breakoutIdx : lastIdx) - a.idx, 'down_or_sideways');
		if (!trend.ok) {
			pcand({
				type: 'double_bottom',
				accepted: false,
				reason: `prior_trend_mismatch:${trend.classification}`,
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'valley1', idx: a.idx, price: a.price },
					{ role: 'peak', idx: b.idx, price: b.price },
					{ role: 'valley2', idx: c.idx, price: c.price },
				],
			});
			continue;
		}
		if (trend.classification === 'insufficient_data') {
			pcand({
				type: 'double_bottom',
				accepted: true,
				reason: 'prior_trend_insufficient_data',
				idxs: [a.idx, b.idx, c.idx],
			});
		}

		const gate = applyStructuralGate(candles, pivots, 'bottom', a, b, c, necklinePrice, 'double_bottom', pcand);
		if (!gate) continue;

		const post = checkPostPivotInvalidation({
			candles,
			pivots,
			a,
			b,
			c,
			untilIdx: isCompleted ? breakoutIdx - 1 : lastIdx,
			side: 'bottom',
		});
		if (post.verdict === 'reclassify') {
			pcand({
				type: 'double_bottom',
				accepted: false,
				reason: 'reclassified_as_triple_bottom',
				idxs: [a.idx, b.idx, c.idx],
			});
			continue;
		}
		if (rejectByLevelDiff('bottom', 'double_bottom', a, b, c, Math.min(tolRelax, DOUBLE_LEVEL_MAX_PCT), pcand))
			continue;
		if (rejectByNecklineSide('bottom', 'double_bottom', a, b, c, necklinePrice, pcand)) continue;
		// 最終構成点 → ブレイクの経路検証（issue #242）。既に `invalid` が付いている候補には掛けない。
		// **未ブレイク（`near_completion`）にも掛けない**——検証する経路がまだ存在しない（#262）。
		const pathTerminal =
			isCompleted && post.verdict === 'ok'
				? checkBreakoutPath({ pivots, side: 'bottom', type: 'double_bottom', a, b, c, breakoutIdx, pcand })
				: null;

		const start = candles[a.idx].isoTime,
			end = isCompleted ? candles[breakoutIdx]?.isoTime : candles[c.idx]?.isoTime;
		if (!start || !end) continue;

		const neckline = [
			{ x: a.idx, y: necklinePrice },
			{ x: isCompleted ? breakoutIdx : c.idx, y: necklinePrice },
		];
		const per = periodScoreDays(start, end);
		const dbRelAvgValley = (a.price + c.price) / 2;
		const dbRelBp = isCompleted ? Number(candles[breakoutIdx]?.close ?? NaN) : NaN;
		const { components: scoreComponents, base } = buildDoubleScore({
			outer1: a.price,
			outer2: c.price,
			necklinePrice,
			breakoutClose: dbRelBp,
			patternHeight: necklinePrice - dbRelAvgValley,
			side: 'bottom',
			retracementRatio: gate.retracementRatio,
			durationScore: per,
		});
		const confidence = finalizeConf(base * RELAXED_CONFIDENCE_PENALTY, 'double_bottom');
		const diagram = generatePatternDiagram(
			'double_bottom',
			[
				{ ...a, date: candles[a.idx]?.isoTime },
				{ ...b, date: candles[b.idx]?.isoTime },
				{ ...c, date: candles[c.idx]?.isoTime },
			],
			{ price: necklinePrice },
			{ start, end },
			{ tz, type },
		);
		const dbRelTarget = Math.round(necklinePrice + (necklinePrice - dbRelAvgValley));
		// 未ブレイク / ブレイク足の終値が非有限——どちらも**理由を名乗って**畳む（#224 症状 2）。
		const dbRelReach = !isCompleted
			? omittedTargetReach('not_broken_out')
			: Number.isFinite(dbRelBp)
				? computeTargetReach(candles, breakoutIdx, dbRelBp, dbRelTarget, 'up', necklinePrice - dbRelAvgValley)
				: omittedTargetReach('invalid_breakout_price');
		const structureRange =
			candles[a.idx]?.isoTime && candles[c.idx]?.isoTime
				? { start: candles[a.idx].isoTime as string, end: candles[c.idx].isoTime as string }
				: undefined;
		const confirmation = isCompleted
			? buildNecklineConfirmation(candles, breakoutIdx)
			: ({ type: 'not_confirmed' } as const);
		const precedingTrend = buildPrecedingTrend(candles, trend, a.idx);

		const structureGate = buildStructureGate(gate);
		const unbroken = isCompleted ? null : unbrokenStatusFields({ post, lastPivotIdx: c.idx, lastIdx });

		const entry: PatternEntry = {
			type: 'double_bottom',
			confidence,
			scoreComponents,
			...(structureGate ? { structureGate } : {}),
			range: { start, end },
			...(structureRange ? { structureRange } : {}),
			...(confirmation ? { confirmation } : {}),
			...(precedingTrend ? { precedingTrend } : {}),
			...(unbroken ??
				(post.verdict === 'invalid'
					? { status: 'invalid' as const, invalidReason: post.reason }
					: (pathTerminal ?? {}))),
			pivots: [a, b, c],
			neckline,
			trendlineLabel: 'ネックライン',
			...(isCompleted ? { breakout: { idx: breakoutIdx, price: dbRelBp }, breakoutBarIndex: breakoutIdx } : {}),
			breakoutTarget: dbRelTarget,
			targetMethod: 'neckline_projection' as const,
			...targetReachFields(dbRelReach),
			structureDiagram: diagram,
			_fallback: `relaxed_double_x${factor}`,
		};
		// 完成済み（status 未設定）だけが即 return。それ以外は退避して走査を続ける。
		if (entry.status !== undefined) {
			nonCompletedFallback ??= entry;
			continue;
		}
		return entry;
	}
	return nonCompletedFallback;
}

// ── Main ──

/**
 * ダブルトップ / ダブルボトムを検出する。
 *
 * 1. **strict**: `pivots` の連続 3 点（H-L-H / L-H-L）を総当たりし、ブレイクが確定していれば
 *    完成済み、していなければ未ブレイクの構造として {@link unbrokenStatusFields} が status を決める
 *    （`near_completion` / `expired` / `invalid`。issue #262）。
 * 2. **relaxed フォールバック**: その type の `completed` が 1 件も出なかったときだけ
 *    {@link findRelaxedDoubleTop} / {@link findRelaxedDoubleBottom} を走らせ、1 件だけ足す。
 * 3. `deduplicatePatterns` で重なりを畳む。
 *
 * **double は `status: 'forming'` を出さない**（issue #268 案 C）。取りうる status は
 * `near_completion` / `expired` / `invalid` / `completed` の 4 段だけで、`forming` はこの種別の
 * 仕様に無い。理由は「最終構成点が 1 つしか無く、形成中を定義できない」こと——
 * 2 山のうち 1 つを最新足の暫定値で埋めると、主構成点 2 点のうち 1 点が確定ピボットでない
 * 経路になり、ネックライン側検査を 2 つに分担する / 単調性ゲートが定義できない / `pivots` が
 * 2 点になる、といった double 専用の例外が仕様のあちこちに生えていた（#262 / #269）。
 * triple / H&S は中間構成点が 2 つあるので最終構成点を暫定にしても形が決まり、
 * **そちらの `forming` は据え置き**。経緯は #262 / #268。
 *
 * 戻り値の `found` は **`completed` が出たかどうか**で、`near_completion` では立てない
 * （立てると relaxed フォールバックが走らなくなり、別の構成点で成立していた `completed` が消える）。
 */
export function detectDoubles(ctx: DetectContext): DetectResult {
	const { candles, pivots, tolerancePct, want, includeForming, near, minDist } = ctx;
	const pcand: Pcand = (arg) => pushCand(ctx, arg);
	// 未ブレイク構造（`near_completion` / `expired` / `invalid`）の期限・再進入の走査終端（issue #262）。
	const lastIdx = candles.length - 1;
	// strict 経路の同水準判定の実効値。`near`（tolerancePct）と `isSameLevel`
	// （DOUBLE_LEVEL_MAX_PCT）が同じ量を見るので min が実効閾値になる
	// （`rejectByLevelDiff` の docstring）。`details.levelTolerancePct` に載せるだけで、
	// 判定そのものには使わない。
	const levelTolerancePct = Math.min(tolerancePct, DOUBLE_LEVEL_MAX_PCT);
	const push = (arr: PatternEntry[], item: PatternEntry) => {
		arr.push(item);
	};
	let patterns: PatternEntry[] = [];

	let foundDoubleTop = false,
		foundDoubleBottom = false;
	if (want.size === 0 || want.has('double_top') || want.has('double_bottom')) {
		for (let i = 0; i + 2 < pivots.length; i++) {
			const a = pivots[i];
			const b = pivots[i + 1];
			const c = pivots[i + 2];
			if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;

			// ── double top: H-L-H ──
			if (a.kind === 'H' && b.kind === 'L' && c.kind === 'H') {
				const sizeReason = validateTopSize(a, b, c, ctx.sizeThresholds);
				if (sizeReason) {
					pcand({ type: 'double_top', accepted: false, reason: sizeReason, idxs: [a.idx, b.idx, c.idx] });
					continue;
				}
				if (!near(a.price, c.price)) {
					const diffPct = Math.abs(a.price - c.price) / Math.max(1, Math.max(a.price, c.price));
					if (diffPct > tolerancePct) {
						pcand({
							type: 'double_top',
							accepted: false,
							reason: 'peaks_not_equal',
							idxs: [a.idx, b.idx, c.idx],
							pts: [
								{ role: 'peak1', idx: a.idx, price: a.price },
								{ role: 'peak2', idx: c.idx, price: c.price },
							],
						});
					}
					continue;
				}
				if (!isSameLevel(a.price, c.price, DOUBLE_LEVEL_MAX_PCT)) {
					pcand({
						type: 'double_top',
						accepted: false,
						reason: 'peaks_not_equal_structural',
						idxs: [a.idx, b.idx, c.idx],
						pts: [
							{ role: 'peak1', idx: a.idx, price: a.price },
							{ role: 'peak2', idx: c.idx, price: c.price },
						],
					});
					continue;
				}
				// ネックライン下抜け（終値ベース1.5%バッファ）。**未検出でも棄却しない**（issue #262）——
				// 構造が揃っていてブレイクを待っている状態は `near_completion` として出す。
				const necklinePrice = b.price;
				const breakoutIdx = findBreakoutIdx(candles, c.idx, necklinePrice, 'below');
				const isCompleted = breakoutIdx >= 0;
				// `includeForming` が false なら未ブレイクの構造は出力対象外
				// （`detect_patterns.ts` のライフサイクル絞り込みでも落ちる）。
				// **その場合は従来どおり `no_breakout` で棄却して抜ける**——出力に出ないものを
				// 組み立てても `view=debug` の cap（#158 / #124）を食うだけで診断の役に立たない。
				if (!isCompleted && !includeForming) {
					pcand({
						type: 'double_top',
						accepted: false,
						reason: 'no_breakout',
						idxs: [a.idx, b.idx, c.idx],
						pts: [
							{ role: 'peak1', idx: a.idx, price: a.price },
							{ role: 'valley', idx: b.idx, price: b.price },
							{ role: 'peak2', idx: c.idx, price: c.price },
						],
					});
					continue;
				}
				// 先行トレンドの参照終端。未ブレイクではブレイク足が無いので最新足まで見る。
				const trend = validatePriorTrend(
					candles,
					a.idx,
					(isCompleted ? breakoutIdx : lastIdx) - a.idx,
					'up_or_sideways',
				);
				if (!trend.ok) {
					pcand({
						type: 'double_top',
						accepted: false,
						reason: `prior_trend_mismatch:${trend.classification}`,
						idxs: [a.idx, b.idx, c.idx],
						pts: [
							{ role: 'peak1', idx: a.idx, price: a.price },
							{ role: 'valley', idx: b.idx, price: b.price },
							{ role: 'peak2', idx: c.idx, price: c.price },
						],
					});
					continue;
				}
				if (trend.classification === 'insufficient_data') {
					pcand({
						type: 'double_top',
						accepted: true,
						reason: 'prior_trend_insufficient_data',
						idxs: [a.idx, b.idx, c.idx],
					});
				}
				const gate = applyStructuralGate(candles, pivots, 'top', a, b, c, necklinePrice, 'double_top', pcand);
				if (!gate) continue;
				// 未ブレイクでは走査終端が最新足になる（#126 G5 を `near_completion` へ引き継ぐ。
				// `unbrokenStatusFields` の docstring）。
				const post = checkPostPivotInvalidation({
					candles,
					pivots,
					a,
					b,
					c,
					untilIdx: isCompleted ? breakoutIdx - 1 : lastIdx,
					side: 'top',
				});
				if (post.verdict === 'reclassify') {
					pcand({
						type: 'double_top',
						accepted: false,
						reason: 'reclassified_as_triple_top',
						idxs: [a.idx, b.idx, c.idx],
					});
					continue;
				}
				if (rejectByLevelDiff('top', 'double_top', a, b, c, levelTolerancePct, pcand)) continue;
				if (rejectByNecklineSide('top', 'double_top', a, b, c, necklinePrice, pcand)) continue;
				// 最終構成点 → ブレイクの経路検証（issue #242）。既に `invalid` が付いている候補には掛けない。
				// **未ブレイク（`near_completion`）にも掛けない**——検証する経路がまだ存在しない（#262）。
				const pathTerminal =
					isCompleted && post.verdict === 'ok'
						? checkBreakoutPath({ pivots, side: 'top', type: 'double_top', a, b, c, breakoutIdx, pcand })
						: null;
				const start = candles[a.idx].isoTime;
				// 未ブレイクの `range.end` は第2構成点（＝`structureRange.end`）。
				// `detect_triples` の `near_completion` と同じ取り方。
				const end = isCompleted ? candles[breakoutIdx]?.isoTime : candles[c.idx]?.isoTime;
				if (!start || !end) continue;
				const neckline = [
					{ x: a.idx, y: necklinePrice },
					{ x: isCompleted ? breakoutIdx : c.idx, y: necklinePrice },
				];
				const per = periodScoreDays(start, end);
				const dtAvgPeak = (a.price + c.price) / 2;
				// 未ブレイクでは `NaN`。`breakoutQualityScore` は算出不能として軸から外れる
				// （`scoring.ts` の docstring）。
				const dtBp = isCompleted ? Number(candles[breakoutIdx]?.close ?? NaN) : NaN;
				const { components: dtScoreComponents, base } = buildDoubleScore({
					outer1: a.price,
					outer2: c.price,
					necklinePrice,
					breakoutClose: dtBp,
					patternHeight: dtAvgPeak - necklinePrice,
					side: 'top',
					retracementRatio: gate.retracementRatio,
					durationScore: per,
				});
				const confidence = finalizeConf(base, 'double_top');
				const diagram = generatePatternDiagram(
					'double_top',
					[
						{ ...a, date: candles[a.idx]?.isoTime },
						{ ...b, date: candles[b.idx]?.isoTime },
						{ ...c, date: candles[c.idx]?.isoTime },
					],
					{ price: necklinePrice },
					{ start, end },
					{ tz: ctx.tz, type: ctx.type },
				);
				const dtTarget = Math.round(necklinePrice - (dtAvgPeak - necklinePrice));
				// 未ブレイクなら進捗は測れない。**それを言う**（#224 症状 2）——`breakoutTarget` は
				// 出るので、黙ると LLM が「進捗 0%」と読み違える。
				// ブレイク足の終値が非有限なら**理由を名乗って**畳む（同）。
				const dtReach = !isCompleted
					? omittedTargetReach('not_broken_out')
					: Number.isFinite(dtBp)
						? computeTargetReach(candles, breakoutIdx, dtBp, dtTarget, 'down', dtAvgPeak - necklinePrice)
						: omittedTargetReach('invalid_breakout_price');
				const dtStructureRange =
					candles[a.idx]?.isoTime && candles[c.idx]?.isoTime
						? { start: candles[a.idx].isoTime as string, end: candles[c.idx].isoTime as string }
						: undefined;
				const dtConfirmation = isCompleted
					? buildNecklineConfirmation(candles, breakoutIdx)
					: ({ type: 'not_confirmed' } as const);
				const dtPrecedingTrend = buildPrecedingTrend(candles, trend, a.idx);
				const dtStructureGate = buildStructureGate(gate);
				const dtUnbroken = isCompleted ? null : unbrokenStatusFields({ post, lastPivotIdx: c.idx, lastIdx });
				push(patterns, {
					type: 'double_top',
					confidence,
					scoreComponents: dtScoreComponents,
					...(dtStructureGate ? { structureGate: dtStructureGate } : {}),
					range: { start, end },
					...(dtStructureRange ? { structureRange: dtStructureRange } : {}),
					...(dtConfirmation ? { confirmation: dtConfirmation } : {}),
					...(dtPrecedingTrend ? { precedingTrend: dtPrecedingTrend } : {}),
					...(dtUnbroken ??
						(post.verdict === 'invalid'
							? { status: 'invalid' as const, invalidReason: post.reason }
							: (pathTerminal ?? {}))),
					pivots: [a, b, c],
					neckline,
					trendlineLabel: 'ネックライン',
					...(isCompleted ? { breakout: { idx: breakoutIdx, price: dtBp }, breakoutBarIndex: breakoutIdx } : {}),
					breakoutTarget: dtTarget,
					targetMethod: 'neckline_projection' as const,
					...targetReachFields(dtReach),
					structureDiagram: diagram,
				});
				// **`found` は完成済みだけで立てる。** これを未ブレイクでも立てると、strict が
				// `near_completion` を 1 件出しただけで relaxed フォールバックが走らなくなり、
				// 別の構成点で成立していた **completed な relaxed 候補が消える**。
				if (isCompleted) foundDoubleTop = true;
				pcand({
					type: 'double_top',
					accepted: true,
					// 未ブレイクは組み立て時点の status を出す（#158。'completed' と誤読させない）。
					...(dtUnbroken ? { status: dtUnbroken.status } : {}),
					idxs: isCompleted ? [a.idx, b.idx, c.idx, breakoutIdx] : [a.idx, b.idx, c.idx],
					pts: [
						{ role: 'peak1', idx: a.idx, price: a.price },
						{ role: 'valley', idx: b.idx, price: b.price },
						{ role: 'peak2', idx: c.idx, price: c.price },
						...(isCompleted ? [{ role: 'breakout', idx: breakoutIdx, price: dtBp }] : []),
					],
				});
				continue;
			}

			// ── double bottom: L-H-L ──
			if (a.kind === 'L' && b.kind === 'H' && c.kind === 'L') {
				const sizeReason = validateBottomSize(a, b, c, ctx.sizeThresholds);
				if (sizeReason) {
					pcand({ type: 'double_bottom', accepted: false, reason: sizeReason, idxs: [a.idx, b.idx, c.idx] });
					continue;
				}
				if (!near(a.price, c.price)) {
					const diffPct = Math.abs(a.price - c.price) / Math.max(1, Math.max(a.price, c.price));
					if (diffPct > tolerancePct) {
						pcand({
							type: 'double_bottom',
							accepted: false,
							reason: 'valleys_not_equal',
							idxs: [a.idx, b.idx, c.idx],
							pts: [
								{ role: 'valley1', idx: a.idx, price: a.price },
								{ role: 'valley2', idx: c.idx, price: c.price },
							],
						});
					}
					continue;
				}
				if (!isSameLevel(a.price, c.price, DOUBLE_LEVEL_MAX_PCT)) {
					pcand({
						type: 'double_bottom',
						accepted: false,
						reason: 'valleys_not_equal_structural',
						idxs: [a.idx, b.idx, c.idx],
						pts: [
							{ role: 'valley1', idx: a.idx, price: a.price },
							{ role: 'valley2', idx: c.idx, price: c.price },
						],
					});
					continue;
				}
				// ネックライン突破（終値ベース＋1.5%バッファ）を c 以降で確認。
				// **未検出でも棄却しない**（issue #262。top 側と同じ扱い）。
				const necklinePrice = b.price;
				const breakoutIdx = findBreakoutIdx(candles, c.idx, necklinePrice, 'above');
				const isCompleted = breakoutIdx >= 0;
				if (!isCompleted && !includeForming) {
					pcand({
						type: 'double_bottom',
						accepted: false,
						reason: 'no_breakout',
						idxs: [a.idx, b.idx, c.idx],
						pts: [
							{ role: 'valley1', idx: a.idx, price: a.price },
							{ role: 'peak', idx: b.idx, price: b.price },
							{ role: 'valley2', idx: c.idx, price: c.price },
						],
					});
					continue;
				}
				const trend = validatePriorTrend(
					candles,
					a.idx,
					(isCompleted ? breakoutIdx : lastIdx) - a.idx,
					'down_or_sideways',
				);
				if (!trend.ok) {
					pcand({
						type: 'double_bottom',
						accepted: false,
						reason: `prior_trend_mismatch:${trend.classification}`,
						idxs: [a.idx, b.idx, c.idx],
						pts: [
							{ role: 'valley1', idx: a.idx, price: a.price },
							{ role: 'peak', idx: b.idx, price: b.price },
							{ role: 'valley2', idx: c.idx, price: c.price },
						],
					});
					continue;
				}
				if (trend.classification === 'insufficient_data') {
					pcand({
						type: 'double_bottom',
						accepted: true,
						reason: 'prior_trend_insufficient_data',
						idxs: [a.idx, b.idx, c.idx],
					});
				}
				const gate = applyStructuralGate(candles, pivots, 'bottom', a, b, c, necklinePrice, 'double_bottom', pcand);
				if (!gate) continue;
				const post = checkPostPivotInvalidation({
					candles,
					pivots,
					a,
					b,
					c,
					untilIdx: isCompleted ? breakoutIdx - 1 : lastIdx,
					side: 'bottom',
				});
				if (post.verdict === 'reclassify') {
					pcand({
						type: 'double_bottom',
						accepted: false,
						reason: 'reclassified_as_triple_bottom',
						idxs: [a.idx, b.idx, c.idx],
					});
					continue;
				}
				if (rejectByLevelDiff('bottom', 'double_bottom', a, b, c, levelTolerancePct, pcand)) continue;
				if (rejectByNecklineSide('bottom', 'double_bottom', a, b, c, necklinePrice, pcand)) continue;
				// 最終構成点 → ブレイクの経路検証（issue #242）。既に `invalid` が付いている候補には掛けない。
				// **未ブレイク（`near_completion`）にも掛けない**——検証する経路がまだ存在しない（#262）。
				const pathTerminal =
					isCompleted && post.verdict === 'ok'
						? checkBreakoutPath({ pivots, side: 'bottom', type: 'double_bottom', a, b, c, breakoutIdx, pcand })
						: null;
				const start = candles[a.idx].isoTime;
				const end = isCompleted ? candles[breakoutIdx]?.isoTime : candles[c.idx]?.isoTime;
				if (!start || !end) continue;
				const neckline = [
					{ x: a.idx, y: necklinePrice },
					{ x: isCompleted ? breakoutIdx : c.idx, y: necklinePrice },
				];
				const per = periodScoreDays(start, end);
				const dbAvgValley = (a.price + c.price) / 2;
				const dbBp = isCompleted ? Number(candles[breakoutIdx]?.close ?? NaN) : NaN;
				const { components: dbScoreComponents, base } = buildDoubleScore({
					outer1: a.price,
					outer2: c.price,
					necklinePrice,
					breakoutClose: dbBp,
					patternHeight: necklinePrice - dbAvgValley,
					side: 'bottom',
					retracementRatio: gate.retracementRatio,
					durationScore: per,
				});
				const confidence = finalizeConf(base, 'double_bottom');
				const diagram = generatePatternDiagram(
					'double_bottom',
					[
						{ ...a, date: candles[a.idx]?.isoTime },
						{ ...b, date: candles[b.idx]?.isoTime },
						{ ...c, date: candles[c.idx]?.isoTime },
					],
					{ price: necklinePrice },
					{ start, end },
					{ tz: ctx.tz, type: ctx.type },
				);
				const dbTarget = Math.round(necklinePrice + (necklinePrice - dbAvgValley));
				// 未ブレイク / ブレイク足の終値が非有限——どちらも**理由を名乗って**畳む（#224 症状 2）。
				const dbReach = !isCompleted
					? omittedTargetReach('not_broken_out')
					: Number.isFinite(dbBp)
						? computeTargetReach(candles, breakoutIdx, dbBp, dbTarget, 'up', necklinePrice - dbAvgValley)
						: omittedTargetReach('invalid_breakout_price');
				const dbStructureRange =
					candles[a.idx]?.isoTime && candles[c.idx]?.isoTime
						? { start: candles[a.idx].isoTime as string, end: candles[c.idx].isoTime as string }
						: undefined;
				const dbConfirmation = isCompleted
					? buildNecklineConfirmation(candles, breakoutIdx)
					: ({ type: 'not_confirmed' } as const);
				const dbPrecedingTrend = buildPrecedingTrend(candles, trend, a.idx);
				const dbStructureGate = buildStructureGate(gate);
				const dbUnbroken = isCompleted ? null : unbrokenStatusFields({ post, lastPivotIdx: c.idx, lastIdx });
				push(patterns, {
					type: 'double_bottom',
					confidence,
					scoreComponents: dbScoreComponents,
					...(dbStructureGate ? { structureGate: dbStructureGate } : {}),
					range: { start, end },
					...(dbStructureRange ? { structureRange: dbStructureRange } : {}),
					...(dbConfirmation ? { confirmation: dbConfirmation } : {}),
					...(dbPrecedingTrend ? { precedingTrend: dbPrecedingTrend } : {}),
					...(dbUnbroken ??
						(post.verdict === 'invalid'
							? { status: 'invalid' as const, invalidReason: post.reason }
							: (pathTerminal ?? {}))),
					pivots: [a, b, c],
					neckline,
					trendlineLabel: 'ネックライン',
					...(isCompleted ? { breakout: { idx: breakoutIdx, price: dbBp }, breakoutBarIndex: breakoutIdx } : {}),
					breakoutTarget: dbTarget,
					targetMethod: 'neckline_projection' as const,
					...targetReachFields(dbReach),
					structureDiagram: diagram,
				});
				// `found` を完成済みだけで立てる理由は double_top 側の同じ箇所を参照。
				if (isCompleted) foundDoubleBottom = true;
				pcand({
					type: 'double_bottom',
					accepted: true,
					...(dbUnbroken ? { status: dbUnbroken.status } : {}),
					idxs: [a.idx, b.idx, c.idx],
					pts: [
						{ role: 'valley1', idx: a.idx, price: a.price },
						{ role: 'peak', idx: b.idx, price: b.price },
						{ role: 'valley2', idx: c.idx, price: c.price },
					],
				});
			}
		}
		// relaxed fallback for double top/bottom: single-stage factor 1.3
		for (const f of [RELAXED_TOLERANCE_FACTOR]) {
			if (!foundDoubleTop && (want.size === 0 || want.has('double_top'))) {
				const result = findRelaxedDoubleTop(
					pivots,
					candles,
					tolerancePct,
					f,
					minDist,
					pcand,
					ctx.sizeThresholds,
					ctx.tz,
					ctx.type,
					includeForming,
				);
				if (result) {
					push(patterns, result);
					foundDoubleTop = true;
				}
			}
			if (!foundDoubleBottom && (want.size === 0 || want.has('double_bottom'))) {
				const result = findRelaxedDoubleBottom(
					pivots,
					candles,
					tolerancePct,
					f,
					minDist,
					pcand,
					ctx.sizeThresholds,
					ctx.tz,
					ctx.type,
					includeForming,
				);
				if (result) {
					push(patterns, result);
					foundDoubleBottom = true;
				}
			}
		}
		// --- 重複パターンの排除（patterns/helpers.ts へ抽出済み） ---
		patterns = deduplicatePatterns(patterns);
	}

	// **形成中経路は top / bottom とも存在しない**（issue #262 / #268 案 C）。
	// `tryFormingDoubleBottom` は「構造が揃ってブレイクを待っている」段階を `status: 'forming'`
	// という誤ラベルで出していたので #262 で削除し、その段階を上の完成済み経路の
	// `near_completion` に付け替えた。残っていた `tryFormingDoubleTop`（「2 つ目の山を作っている
	// 途中」）は #268 案 C で削除した——実データ 12,104 ケースで accepted 0 件（`forming_bars_out_of_range`
	// の下限割れが律速。#268 Phase 1 §1）で、維持するには double だけの例外を仕様に抱え続ける
	// 必要があった。`includeForming` は完成済み経路の未ブレイク分岐（`near_completion` /
	// `expired` / `invalid`）の出し分けにだけ効く（上の strict / relaxed 経路が見ている）。

	return { patterns, found: { double_top: foundDoubleTop, double_bottom: foundDoubleBottom } };
}
