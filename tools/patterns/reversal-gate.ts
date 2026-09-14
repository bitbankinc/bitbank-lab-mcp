/**
 * patterns/reversal-gate.ts - 反転パターンの構造ゲートを検出器へ配線する層
 *
 * `structural.ts` の {@link validateReversalStructure} は純粋関数で、`debugCandidates` も
 * `PatternEntry` も知らない。本ファイルはその戻り値を **`view=debug` の棄却理由**と
 * **`PatternEntry.structureGate`** に変換するだけの薄い層で、判定ロジックは持たない。
 *
 * #131 は構造ゲートを `detect_doubles.ts` のローカル関数（`applyStructuralGate`）としてだけ
 * 配線し、「head_and_shoulders / triple への適用は本 PR では行っていない——検出件数への影響の
 * 確認が別途要るため」と明記して保留した（issue #138 欠陥 2-1）。本ファイルはその回収で、
 * triple / H&S の 12 経路が同じ形でゲートを呼べるようにしたもの。
 *
 * **`first` / `mid` は「`validatePatternSize` に渡す構成点列の先頭 2 点」と決めてある。**
 * double（谷1-山-谷2）では `first` が谷1、`mid` が山で自明だが、triple（谷1-山1-谷2-山2-谷3）と
 * H&S（左肩-谷1-頭-谷2-右肩）は構成点が 5 つあり自明ではない。先頭 2 点に固定した理由:
 *
 * - **`first` は「先行トレンドが終わった点」**。triple なら谷1 / 山1、H&S なら左肩で、
 *   どちらもパターンが始まる点そのもの。ここより手前に先行値幅を張る（issue #138 の
 *   「triple なら谷1 の手前か、H&S なら左肩の手前か」に対する答え）
 * - **`mid` は「先行トレンドに対する最初の戻り」**。戻り率は `first → mid` の 1 脚で測るもので、
 *   構成点が 5 つに増えても測る脚は変わらない。頭や第3構成点まで含めた全振幅で測ると
 *   「先行値幅に対する戻り」ではなく「パターン全体の大きさ」になり、別の量になる
 * - サイズ検査（{@link validatePatternSize}）と同じ配列の先頭 2 点なので、**構成点の取り方が
 *   経路ごとにずれない**。forming H&S のように先行谷が取れず 3 点（頭-戻り-右肩）に縮む経路でも、
 *   縮んだ配列の先頭 2 点が自動的に正しい `first` / `mid` になる
 *
 * ネックライン水準（`necklinePrice`）は **検出器がブレイク判定に使うのと同じ値**を呼び出し側が
 * 渡す（`ReversalStructureInput.necklinePrice` の docstring）。
 */
import {
	detectPivotBeforeBreakout,
	detectTroughZoneReentry,
	type ReversalSide,
	type ReversalStructureResult,
	validateReversalStructure,
} from './structural.js';
import type { Pivot } from './swing.js';
import type { CandDebugEntry, CandleData, PatternStructureGate } from './types.js';

export interface ReversalGateInput {
	candles: CandleData[];
	pivots: ReadonlyArray<Pivot>;
	side: ReversalSide;
	/** 構成点列の先頭（bottom なら谷1 / 左肩、top なら山1 / 左肩）。本ファイル冒頭の注記を参照 */
	first: Pivot;
	/** 構成点列の 2 点目（先行トレンドに対する最初の戻り）。同上 */
	mid: Pivot;
	/** 検出器がブレイク判定に使うのと同じネックライン水準 */
	necklinePrice: number;
	/** `view=debug` の candidate に載せるパターン種別 */
	type: string;
	/** 同 `indices`。各経路の既存の棄却 candidate と同じ並びを渡す */
	indices: number[];
	debugCandidates: CandDebugEntry[];
}

/**
 * 構造ゲートを適用し、不合格なら debug candidate を積んで `null` を返す。
 *
 * **スコアの減点ではなく hard reject。** 通らない形は整合度がいくら高くても検出結果に出さない。
 *
 * **呼び出しは各経路の「既存の棄却検査をすべて通過した後」に置くこと。** 前に置くと、既に固有の
 * 理由コードを持つ候補の `reason` を横取りして `view=debug` の診断が変わる
 * （{@link validatePatternSize} の docstring と同じ理由。実装上は同関数の直後に並べてある）。
 */
export function applyReversalGate(input: ReversalGateInput): ReversalStructureResult | null {
	const { candles, pivots, side, first, mid, necklinePrice, type, indices, debugCandidates } = input;
	const gate = validateReversalStructure({ candles, pivots, first, mid, necklinePrice, side });
	if (gate.ok) return gate;
	debugCandidates.push({
		type,
		accepted: false,
		reason: gate.reason,
		indices,
		details: {
			side,
			firstIdx: first.idx,
			midIdx: mid.idx,
			necklinePrice,
			...(gate.retracementRatio !== undefined ? { retracementRatio: gate.retracementRatio } : {}),
			...(gate.priorExtreme
				? { priorExtremeIdx: gate.priorExtreme.idx, priorExtremePrice: gate.priorExtreme.extremePrice }
				: {}),
		},
	});
	return null;
}

/** {@link ReversalStructureResult} → `PatternEntry.structureGate` */
export function buildStructureGate(gate: ReversalStructureResult): PatternStructureGate | undefined {
	const out: PatternStructureGate = {};
	if (gate.retracementRatio !== undefined) out.retracementRatio = Number(gate.retracementRatio.toFixed(4));
	if (gate.priorExtreme) {
		out.priorExtremeIdx = gate.priorExtreme.idx;
		out.priorExtremePrice = gate.priorExtreme.extremePrice;
	}
	if (gate.necklineCrossIdx !== undefined) out.necklineCrossIdx = gate.necklineCrossIdx;
	return Object.keys(out).length > 0 ? out : undefined;
}

export interface PostBreakoutGateInput {
	candles: CandleData[];
	pivots: ReadonlyArray<Pivot>;
	side: ReversalSide;
	/**
	 * 構成点列の先頭 2 点。**本ファイル冒頭の注記と同じ取り方**
	 * （triple なら 谷1 / 山1 と最初の中間構成点、H&S なら 左肩 と 谷1）。
	 * {@link detectTroughZoneReentry} のゾーン水準を張るのに使う。
	 */
	first: Pivot;
	mid: Pivot;
	/** 最終構成点（triple なら山3 / 谷3、H&S なら右肩）。ここからブレイクまでの経路を見る */
	last: Pivot;
	/** ネックライン突破バーの idx。**ブレイクが確定している経路でだけ呼ぶこと** */
	breakoutIdx: number;
	/** `view=debug` の candidate に載せるパターン種別 */
	type: string;
	/** 同 `indices`。各経路の既存の棄却 candidate と同じ並びを渡す */
	indices: number[];
	debugCandidates: CandDebugEntry[];
}

/** 終端 status（`PatternEntry` に `...` で展開する形）。 */
export interface PostBreakoutGateResult {
	status: 'invalid';
	invalidReason: string;
}

/**
 * **最終構成点の確定後、ネックライン突破までの間にパターンが崩れていないか**を見る 2 つの検査を
 * まとめて適用する（issue #242）。崩れていれば `view=debug` の候補を積み、終端 status を返す。
 *
 * `detect_doubles.ts` は #126 G5 以降この 2 つを（前者だけ）ローカルに持っていたが、
 * **triple / H&S には 1 つも無かった**——`reversal-gate.ts` が #131 → #138 で構造ゲートを
 * 横展開したときに、再進入チェックが横展開から漏れていた（issue #242 の原因分析）。
 * 本関数はその回収で、判定ロジックは持たない（`structural.ts` の純粋関数を呼ぶだけ）。
 *
 * ## 適用順（double と揃えてある）
 *
 * 1. {@link detectTroughZoneReentry} — 最終構成点の後、パターン高さの一定比率まで**終値が**戻ったか（`re_entered_trough_zone`）
 * 2. {@link detectPivotBeforeBreakout} — 最終構成点とブレイク足の**間に同種のピボット**が
 *    あるか（`peak_after_last_pivot` / `trough_after_last_pivot`）
 *
 * **2 つは独立した検査で、片方では両方の実例を塞げない**（理由は
 * {@link detectPivotBeforeBreakout} の docstring）。順序を 1 → 2 にしてあるのは
 * `detect_doubles.ts` の既存の並び（`checkPostPivotInvalidation` が先）に合わせたもので、
 * **どちらも当たる候補には先に来た方の理由コードが付く**。
 *
 * ## 呼び出し位置
 *
 * 各経路の「**既存の棄却検査をすべて通過し、ブレイクが確定した直後**」。
 * {@link applyReversalGate} と同じ原則（固有の理由コードを持つ候補の `reason` を横取りしない）で、
 * 最後に置けば「これまで accepted だった候補だけを落とす」ことが位置から保証される。
 *
 * **ブレイクが確定していない経路（forming / `near_completion`）では呼ばないこと。**
 * 「最終構成点 → ブレイクの経路」が定義できないうえ、形成中の最終構成点は暫定値なので
 * hard reject の材料にしない。
 *
 * ## `status: 'invalid'` で出す。候補にも理由を残す
 *
 * `re_entered_trough_zone`（double の既存の扱い）に揃えて `status: 'invalid'` +
 * `invalidReason` を返す。**加えて `view=debug` の候補にも積む**——既定
 * （`includeInvalid: false`）では `invalid` のエントリが丸ごと消えるため、候補に残さないと
 * 「なぜ消えたか」が LLM にも利用者にも届かない。
 */
export function applyPostBreakoutGates(input: PostBreakoutGateInput): PostBreakoutGateResult | null {
	const { candles, pivots, side, first, mid, last, breakoutIdx, type, indices, debugCandidates } = input;

	const reentry = detectTroughZoneReentry({ candles, first, mid, second: last, untilIdx: breakoutIdx - 1, side });
	if (reentry.reentered) {
		debugCandidates.push({
			type,
			accepted: false,
			reason: 're_entered_trough_zone',
			indices,
			details: { side, lastPivotIdx: last.idx, breakoutIdx, zoneLevel: reentry.level, reenteredIdx: reentry.idx },
		});
		return { status: 'invalid', invalidReason: 're_entered_trough_zone' };
	}

	const path = detectPivotBeforeBreakout({ pivots, lastPivotIdx: last.idx, breakoutIdx, side });
	if (path.found && path.reason) {
		debugCandidates.push({
			type,
			accepted: false,
			reason: path.reason,
			indices,
			details: {
				side,
				lastPivotIdx: last.idx,
				breakoutIdx,
				...(path.pivot
					? {
							offenderIdx: path.pivot.idx,
							offenderPrice: path.pivot.price,
							offenderExtremePrice: path.pivot.extremePrice,
						}
					: {}),
			},
		});
		return { status: 'invalid', invalidReason: path.reason };
	}

	return null;
}
