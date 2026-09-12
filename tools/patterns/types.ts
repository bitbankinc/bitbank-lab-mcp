/**
 * detect_patterns 系モジュール共通の型定義
 */

// **理由コードの単一ソースは Zod 側**（`src/schema/patterns.ts` の
// `TargetProgressOmittedReasonEnum`）。ここから型を取ることで、宣言漏れで `parse()` に
// 黙って剥がされる形を作れなくしてある。`import type` なので実行時の依存は増えない。
import type { TargetProgressOmittedReason } from '../../src/schema/patterns.js';
import type { SizeThresholds } from './structural.js';
import type { Pivot } from './swing.js';
import type { TargetBreakoutConfounder } from './target-confounders.js';

/** トレンドライン（線形回帰の結果） */
export interface TrendLine {
	slope: number;
	intercept: number;
	r2?: number;
	valueAt: (x: number) => number;
}

/** ウェッジ検出パラメータ */
export interface WedgeParams {
	minSlope?: number;
	slopeRatioMinRising?: number;
	slopeRatioMinFalling?: number;
	slopeRatioMin?: number;
	minWeakerSlopeRatio?: number;
	windowSizeMin?: number;
	windowSizeMax?: number;
}

/** パターンスコアの各構成要素 */
export interface PatternScoreComponents {
	fitScore: number;
	convergeScore: number;
	touchScore: number;
	alternationScore: number;
	insideScore: number;
	durationScore: number;
}

/** パターンスコアの重み */
export interface PatternScoreWeights {
	fit: number;
	converge: number;
	touch: number;
	alternation: number;
	inside: number;
	duration: number;
}

/** タッチポイント */
export interface TouchPoint {
	index: number;
	distance: number;
	isBreak: boolean;
}

/** evaluateTouchesEx の戻り値 */
export interface TouchResult {
	upperTouches: TouchPoint[];
	lowerTouches: TouchPoint[];
	upperQuality: number;
	lowerQuality: number;
	score: number;
}

/** 重複排除対象のパターンエントリ（最低限のフィールド + 任意の追加フィールド） */
export interface DeduplicablePattern {
	type?: string;
	confidence?: number;
	range?: { start: string; end: string; current?: string };
	/**
	 * パターン構成点。`Pivot` そのものを使う（緩い形の再宣言をしない）ことで、
	 * 検出器が pivot を組み直すときに `extremePrice`（極値判定に使った値）を
	 * 落とすと typecheck が落ちる。#125 の「報告された price から判定を検算できない」
	 * を型で塞ぐための拘束。
	 */
	pivots?: Pivot[];
	[key: string]: unknown;
}

/** ローソク足データ（detectSwingPoints 互換） */
export interface CandleData {
	open: number;
	close: number;
	high: number;
	low: number;
	isoTime?: string;
}

/** pushCand() に渡すデバッグ引数 */
export interface CandDebugArg {
	type: string;
	accepted: boolean;
	reason?: string;
	idxs?: number[];
	pts?: Array<{ role: string; idx: number; price: number }>;
	/**
	 * 候補を組み立てた時点の status（issue #158）。形成中パスの成功エントリが
	 * 「完成済みとして採用された」と誤読されるのを防ぐための印で、`CandDebugEntry` 側には
	 * 元からあったが `pushCand` に写経路が無く、`pcand` を使う検出器からは積めなかった。
	 *
	 * **渡さなければキー自体を出力しない**（下の spread）。#158 以前の呼び出し元は 1 つも
	 * これを渡していないので、追加は既存出力に対して純粋に additive。
	 */
	status?: string;
	/**
	 * 棄却理由の診断値（issue #138）。`CandDebugEntry` 側には元からあったが `pushCand` に
	 * 写経路が無く、`pcand` を使う検出器からは積めなかった（`status` と同じ事情。#158）。
	 *
	 * **渡さなければキー自体を出力しない**（下の spread）。既存の呼び出し元は 1 つも
	 * これを渡していないので、追加は既存出力に対して純粋に additive。
	 */
	details?: Record<string, unknown>;
}

/** debugCandidates 配列の要素 */
export interface CandDebugEntry {
	type: string;
	accepted: boolean;
	reason?: string;
	indices?: number[];
	points?: Array<{ role: string; idx: number; price: number; isoTime?: string }>;
	details?: unknown;
	status?: string;
	breakoutDirection?: string | null;
}

/**
 * パターン検出コンテキスト — 各検出モジュールが共有するデータとコンフィグ。
 * detectPatterns() が組み立てて各検出関数に渡す。
 */
export interface DetectContext {
	candles: CandleData[];
	pivots: Pivot[];
	allPeaks: Pivot[];
	allValleys: Pivot[];
	tolerancePct: number;
	/**
	 * H&S / 逆 H&S 専用: 頭が両肩よりどれだけ突出していなければならないかの最小要求率（issue #149）。
	 * `tolerancePct` とは向きが逆で、**大きいほど判定が厳しくなる**（最小要求を引き上げるため）。
	 * `detect_hs.ts` の `headLower` / `headHigher` 判定にのみ使う。肩の同水準判定・ネックライン
	 * 水平度は引き続き `tolerancePct`（同水準判定）と固定定数 `HS_NECKLINE_MAX_PCT`（水平度）が担う。
	 */
	headProminencePct: number;
	/**
	 * 反転パターンのサイズ検査の下限 2 つ（issue #152）。`getSizeThresholdsForTf(type)` を
	 * `detect_patterns.ts` で **1 回だけ**解決して載せる。
	 *
	 * `structural.ts` は純粋関数のみで `DetectContext` を知らないため、`validatePatternSize`
	 * には呼び出し側からこの値を渡す。検出器がモジュール定数
	 * （`MIN_PATTERN_HEIGHT_PCT` / `MIN_DEPTH_PCT`）を直接読むと時間足別の値が効かなくなる。
	 */
	sizeThresholds: SizeThresholds;
	/**
	 * H&S / 逆 H&S の**左右肩の同水準判定の上限**（issue #244 Phase 2）。
	 * `getHsShoulderMaxPctForTf(type)` を `detect_patterns.ts` で **1 回だけ**解決して載せる
	 * （{@link sizeThresholds} と同じ流儀。`structural.ts` / 各検出器は `tf` を知らない）。
	 *
	 * **適用先は肩ゲートだけ。** `enumerateHsWindows` の窓生成（`outerShoulderOk`）は
	 * モジュール定数 `HS_SHOULDER_MAX_PCT`（5%）のまま緩く残す——窓生成で落とすと
	 * `view=debug` が無音になり、肩ゲートで落とせば `shoulders_not_near:cap` が残るため
	 * （`getHsShoulderMaxPctForTf` の docstring）。
	 */
	hsShoulderMaxPct: number;
	minDist: number;
	/** 検出対象パターン種別。空 = 全種 */
	want: Set<string>;
	includeForming: boolean;
	/** デバッグ候補バッファ（各モジュールが直接 push する） */
	debugCandidates: CandDebugEntry[];
	/** 時間軸（'1day', '1hour', '1week' 等） */
	type: string;
	/** スイング深度 */
	swingDepth: number;
	/** 近接判定ヘルパー（tolerancePct ベース） */
	near: (a: number, b: number) => boolean;
	/** 変化率計算 */
	pct: (a: number, b: number) => number;
	/** R² 付き線形回帰 */
	lrWithR2: (pts: Array<{ x: number; y: number }>) => {
		slope: number;
		intercept: number;
		r2: number;
		valueAt: (x: number) => number;
	};
	/**
	 * 構造図（`lib/pattern-diagrams.ts` の `generatePatternDiagram`）の日付表示に使う tz
	 * （issue #200 要件 F-2）。検出ロジックはこの値を判定に使わない——表示専用。
	 *
	 * `optional`: `tools/detect_patterns.ts` は常に渡すが、`DetectContext` を手組みする
	 * テスト（`tests/patterns/*.test.ts`）まで全部直すのはこの issue のスコープ外
	 * （検出ロジック自体は 1 行も変えていない）。未指定時は `generatePatternDiagram` 側の
	 * `resolveTz(undefined)` が `Asia/Tokyo` にフォールバックする。
	 */
	tz?: string;
}

/** 各パターン検出関数の戻り値 */
export interface DetectResult {
	patterns: PatternEntry[];
	/** 検出成否フラグ（後続の relaxed パスに使用） */
	found?: Record<string, boolean>;
}

/** 事後分析結果 */
export interface AftermathResult {
	breakoutDate?: string | null;
	breakoutConfirmed: boolean;
	priceMove?: Record<string, { return: number; high: number; low: number } | null>;
	targetReached: boolean;
	theoreticalTarget?: number | null;
	outcome: string;
	daysToTarget?: number | null;
}

/**
 * 整合度（confidence）のサブスコア。issue #126 で露出。
 * **構造ゲートを通過した候補どうしの形の良さ**の内訳であって、構造的妥当性の指標ではない。
 */
export interface PatternScoreBreakdown {
	/**
	 * 2 つの主構成点の同水準度（`1 − relDev`）。**正規化していない生の relDev** で、
	 * double（2 山 / 2 谷）と H&S（左肩 / 右肩）が共有する（issue #199 / #204）。
	 */
	symmetry?: number;
	/**
	 * 主構成点（triple なら 3 山 / 3 谷）の同水準度を **`tolerancePct` で正規化**した軸（issue #199）。
	 *
	 * `symmetry` とは別フィールドにしてある。`symmetry` は double の「2 点の relDev」で
	 * **正規化していない生の同水準度**、こちらは「全ペアの relDev 平均 ÷ その経路の許容幅」で、
	 * **同じ 0.9 でも意味が違う**（`symmetry=0.9` は 10% ずれている、`levelMargin=0.9` は
	 * 許容幅の 10% ぶんしかずれていない）。`symmetry` の意味を差し替えて流用すると、
	 * 旧値を読み続けるクライアントに黙って別の量が返る（`.claude/rules/tools.md` 規約 7）。
	 */
	levelMargin?: number;
	/**
	 * 頭がゲート（`headProminencePct`。relaxed 経路は段の係数倍）をどれだけ上回っているかの
	 * 余裕（issue #204）。`1 − ゲート / 実測突出率` で、ゲートちょうどなら 0、
	 * 突出率がゲートの 2 倍なら 0.5、∞ で 1。**H&S 系のみ。**
	 */
	headProminence?: number;
	/**
	 * 左肩→頭 と 頭→右肩 のバー数の釣り合い（`min / max`）。1 = 左右同じ長さ（issue #204）。
	 * 価格ではなく**時間軸**の対称性なので `symmetry`（肩の水準差）とは別の量。**H&S 系のみ。**
	 */
	timeSymmetry?: number;
	retracement?: number;
	breakoutQuality?: number;
	duration?: number;
}

/** 構造ゲート（issue #126）が実際に計測した値。schema 参照。 */
export interface PatternStructureGate {
	retracementRatio?: number;
	priorExtremeIdx?: number;
	priorExtremePrice?: number;
	necklineCrossIdx?: number;
}

/** パターン構成点のみで張る期間（誤読防止のための追加フィールド）。詳細は schema 参照。 */
export interface PatternStructureRange {
	start: string;
	end: string;
}

/** 検出器自身が確認したブレイク情報。schema 参照。 */
export type PatternConfirmation =
	| { type: 'neckline_breakout'; date: string; idx: number; price: number }
	| { type: 'not_confirmed' };

/** 先行トレンド情報。schema 参照。 */
export interface PatternPrecedingTrend {
	start: string;
	end: string;
	direction: 'up' | 'down' | 'sideways' | 'insufficient_data';
	returnPct: number;
	lookbackBars: number;
}

/** パターンエントリ（検出結果の1件）— 共通フィールド＋任意拡張 */
export interface PatternEntry extends DeduplicablePattern {
	confidence?: number;
	/**
	 * relaxed フォールバック経路で拾い直したことを示す provenance（issue #189 / #191 B）。
	 * 値は `relaxed_<検出器>_<段の係数>`（`relaxed_triple_x1.25` / `relaxed_hs_x2.0_0.4` 等。
	 * **表記は検出器ごとに揃っていない**——判別は前方一致で行う。詳細は `src/schema/patterns.ts` の
	 * `DetectedPatternSchema._fallback`）。**無ければ strict 経路で拾えた**の意。
	 *
	 * 親の `DeduplicablePattern` が `[key: string]: unknown` を持つのでアクセス自体は前からできたが、
	 * 型が `unknown` のままでは表示層でキャストが要る。PR #190 がスキーマ側でやったことの型側の対応物。
	 */
	_fallback?: string;
	timeframe?: string;
	timeframeLabel?: string;
	neckline?: Array<{ x?: number; y: number }>;
	structureDiagram?: { svg: string; artifact?: { identifier: string; title: string } };
	status?: string;
	/** `status='invalid' | 'expired'` の理由コード（issue #126）。schema 参照。 */
	invalidReason?: string;
	/** 整合度のサブスコア（issue #126）。ゲート通過後の形の良さの内訳。schema 参照。 */
	scoreComponents?: PatternScoreBreakdown;
	/** 構造ゲート（issue #126）の計測値。schema 参照。 */
	structureGate?: PatternStructureGate;
	breakout?: { idx: number; price: number; direction?: string } | null;
	structureRange?: PatternStructureRange;
	confirmation?: PatternConfirmation;
	precedingTrend?: PatternPrecedingTrend;
	breakoutDirection?: 'up' | 'down';
	outcome?: 'success' | 'failure' | string;
	breakoutTarget?: number;
	targetMethod?: string;
	targetReachedPct?: number;
	targetReached?: boolean;
	targetReachedDate?: string;
	targetReachedPrice?: number;
	/**
	 * ブレイク後の値動きの「事実」と、到達の帰属を切る交絡（issue #288 Phase 2）。schema 参照。
	 *
	 * **`targetReachedDate` / `targetReachedPrice` とは別の足を指す**——あちらは走査窓の extremum。
	 * 交絡 2 つは `tools/patterns/target-confounders.ts` がパイプライン段で注入する
	 * （検出器は付けない。他パターンの集合が確定するのが `globalDedup` / 型間排他の後のため）。
	 */
	targetFirstReachBars?: number;
	targetFirstReachDate?: string;
	targetScanBars?: number;
	targetScanComplete?: boolean;
	targetOtherBreakoutBeforeReach?: TargetBreakoutConfounder[];
	targetOppositeBreakoutInWindow?: TargetBreakoutConfounder[];
	/** target 進捗系を出さなかった理由（issue #210 / #224）。schema 参照。 */
	targetProgressOmittedReason?: TargetProgressOmittedReason;
	trendlineLabel?: string;
	poleDirection?: 'up' | 'down';
	priorTrendDirection?: 'bullish' | 'bearish';
	flagpoleHeight?: number;
	retracementRatio?: number;
	isTrendContinuation?: boolean;
	// bull/bear flag・pennant 用の検証情報
	poleStartDate?: string;
	poleEndDate?: string;
	poleChangePct?: number;
	poleBars?: number;
	poleATRMult?: number;
	flagUpperSlope?: number;
	flagLowerSlope?: number;
	spreadAvg?: number;
	spreadStability?: number;
	expectedBreakoutDirection?: 'up' | 'down';
	apexDate?: string;
	daysToApex?: number;
	completionPct?: number;
	breakoutDate?: string;
	breakoutBarIndex?: number;
	daysSinceBreakout?: number;
	aftermath?: AftermathResult | null;
}

/** pushCand ヘルパー（デバッグ候補に isoTime を付加して追加） */
export function pushCand(ctx: DetectContext, arg: CandDebugArg): void {
	const points = (arg.pts || []).map((p) => ({
		...p,
		isoTime: (ctx.candles[p.idx] as CandleData | undefined)?.isoTime,
	}));
	ctx.debugCandidates.push({
		type: arg.type,
		accepted: arg.accepted,
		reason: arg.reason,
		indices: arg.idxs,
		points,
		// 未指定ならキーごと出さない（`status: undefined` を置くと deep-equal 比較が壊れる）
		...(arg.status !== undefined ? { status: arg.status } : {}),
		...(arg.details !== undefined ? { details: arg.details } : {}),
	});
}
