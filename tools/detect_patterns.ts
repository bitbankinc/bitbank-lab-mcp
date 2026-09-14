import type { z } from 'zod';
import { formatDateInTz, formatDateOrTimeInTz } from '../lib/datetime.js';
import { fail, failFromError, ok } from '../lib/result.js';
import { extractUpstreamWarning, prependWarnings } from '../lib/warning-propagation.js';
import { DetectPatternsOutputSchema, type PatternFilterEnum } from '../src/schemas.js';
import analyzeIndicators from './analyze_indicators.js';
import { buildStatistics } from './patterns/aftermath.js';
import { filterCandidatesByWant } from './patterns/candidate-filter.js';
import { getHsShoulderMaxPctForTf, getSizeThresholdsForTf, resolveParams } from './patterns/config.js';
// --- 各パターン検出モジュール ---
import { detectDoubles } from './patterns/detect_doubles.js';
import { detectHeadAndShoulders } from './patterns/detect_hs.js';
import { detectPennantsFlags } from './patterns/detect_pennants.js';
import { detectTriangles } from './patterns/detect_triangles.js';
import { detectTriples } from './patterns/detect_triples.js';
import { detectWedges } from './patterns/detect_wedges.js';
import { globalDedup } from './patterns/helpers.js';
import {
	excludeTriplesSharingHsMainPoints,
	mainPointKind,
	TRIPLE_HS_EXCLUSION_REASON,
} from './patterns/mutual-exclusion.js';
import { buildPeriodBlock, buildScanRange } from './patterns/period.js';
import { rankPatterns } from './patterns/ranking.js';
import { linearRegressionWithR2, near as nearFn, pct as pctFn } from './patterns/regression.js';
import { buildScanWindowWarning } from './patterns/scan-window.js';
import { type Candle, detectSwingPoints, filterPeaks, filterValleys } from './patterns/swing.js';
import { annotateTargetBreakoutConfounders, type TargetBreakoutConfounder } from './patterns/target-confounders.js';
import { formatTargetProgressLine } from './patterns/target-reach.js';
import { type CandDebugEntry, type DeduplicablePattern, type DetectContext, pushCand } from './patterns/types.js';

/**
 * flag / pennant 系パターン固有の検証メタデータ。
 * `PatternEntry` には optional として既に定義されているが、
 * `DeduplicablePattern` 経由で扱う summary 生成セクションでは型情報が落ちるため
 * ここで再宣言してキャストに使う。
 */
interface FlagFamilyMetadata {
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
}

/** Summary generation section で使う拡張型（DeduplicablePattern + パターン固有フィールド） */
interface SummaryPattern extends DeduplicablePattern {
	type: string;
	confidence: number;
	range: { start: string; end: string; current?: string };
	status?: string;
	breakoutDirection?: string;
	outcome?: string;
	neckline?: Array<{ y?: number }>;
	trendlineLabel?: string;
	daysToApex?: number;
	breakoutTarget?: number;
	targetMethod?: string;
	targetReachedPct?: number;
	targetReached?: boolean;
	targetProgressOmittedReason?: string;
	// ターゲット到達の事実 + 交絡（issue #288 Phase 2）。**`content` の文言に要るので
	// ここにも宣言する**——`DeduplicablePattern` の index signature 経由だと `unknown` になり、
	// `formatTargetProgressLine` の引数型に通らない。
	targetFirstReachBars?: number;
	targetFirstReachDate?: string;
	targetScanBars?: number;
	targetScanComplete?: boolean;
	targetOtherBreakoutBeforeReach?: TargetBreakoutConfounder[];
	targetOppositeBreakoutInWindow?: TargetBreakoutConfounder[];
	poleDirection?: string;
	priorTrendDirection?: string;
	flagpoleHeight?: number;
	retracementRatio?: number;
	isTrendContinuation?: boolean;
	timeframe?: string;
	timeframeLabel?: string;
}

/**
 * detect_patterns - チャートパターン検出（完成済み＋形成中）
 *
 * 設計思想:
 * - 目的: チャートパターンを検出し、統計的に信頼性の高いデータを提供
 * - 特徴: swingDepth パラメータによる厳密なスイング検出でパターン品質を重視
 * - ブレイク検出: ATR * 0.5 バッファ、最初の明確なブレイクで終点を確定
 * - 用途: 「過去の成功率は？」「典型的な期間は？」「aftermath は？」
 *
 * オプション:
 * - includeCompleted: true (デフォルト) → 完成済みパターンを検出
 * - includeForming: true → 形成中パターンも検出（早期警告向け）
 * - includeInvalid: true → 無効化済み（invalid）と期限切れ（expired）も検出
 */

export default async function detectPatterns(
	pair: string = 'btc_jpy',
	type: string = '1day',
	limit: number = 90,
	opts: Partial<{
		swingDepth: number;
		tolerancePct: number;
		minBarsBetweenSwings: number;
		/**
		 * H&S / 逆H&S 専用: 頭の最小突出率（issue #149）。未指定なら tolerancePct と同じ
		 * 時間軸オート値を使う。tolerancePct とは向きが逆で、大きいほど判定が厳しくなる。
		 */
		headProminencePct: number;
		strictPivots: boolean;
		patterns: Array<z.infer<typeof PatternFilterEnum>>;
		requireCurrentInPattern: boolean;
		currentRelevanceDays: number;
		// 統合オプション
		includeForming: boolean;
		includeCompleted: boolean;
		includeInvalid: boolean;
		view: 'summary' | 'detailed' | 'full' | 'debug';
		/** 表示日付のタイムゾーン（既定: 'Asia/Tokyo'）。空文字も Asia/Tokyo にフォールバック。*/
		tz: string;
	}> = {},
) {
	try {
		// --- パラメータ解決（patterns/config.ts から） ---
		const {
			swingDepth,
			tolerancePct,
			minBarsBetweenSwings: minDist,
			headProminencePct,
			sources: paramSources,
		} = resolveParams(type, opts);
		// 解決後の実効パラメータ（**入力値ではない**）。
		// #184 まで出力スキーマに宣言が無く parse() が黙って strip していたため、
		// どのクライアントにも届いていなかった。宣言は src/schema/patterns.ts の
		// EffectiveParamsSchema、キーの網羅は tests/detect_patterns_meta_schema_parity.test.ts。
		// 4 つ目の headProminencePct は #149 / PR #153 の追随漏れ（#184 欠陥 A）。
		//
		// **`ok()` を返す経路が 2 つある**（通常 / 'insufficient data' の早期 return）ので、
		// ここで 1 回だけ組んで両方に渡す。片方に足し忘れると「足りるときだけ実効値が出る」
		// という candle 本数依存の申告漏れになる——欠陥 A と同じ追随漏れのクラス。
		const effectiveParams = {
			swingDepth: { value: swingDepth, source: paramSources.swingDepth },
			minBarsBetweenSwings: { value: minDist, source: paramSources.minBarsBetweenSwings },
			tolerancePct: { value: tolerancePct, source: paramSources.tolerancePct },
			headProminencePct: { value: headProminencePct, source: paramSources.headProminencePct },
		};
		const strictPivots = opts.strictPivots !== false; // 既定: 厳格
		// 統合オプション
		const includeForming = opts.includeForming ?? false;
		const includeCompleted = opts.includeCompleted ?? true;
		const includeInvalid = opts.includeInvalid ?? false;
		// 表示日付の TZ（既定: Asia/Tokyo）。formatDateInTz が空文字 / 不正値を Asia/Tokyo にフォールバックする。
		const tz = opts.tz ?? 'Asia/Tokyo';
		const want = new Set(opts.patterns || []);
		// 'triangle' が指定された場合は3種を含む互換挙動
		if (want.has('triangle')) {
			want.add('triangle_ascending');
			want.add('triangle_descending');
			want.add('triangle_symmetrical');
		}

		const res = await analyzeIndicators(pair, type, limit);
		if (!res.ok) return DetectPatternsOutputSchema.parse(fail(res.summary || 'failed', 'internal'));

		// 上流 analyze_indicators の meta を取り込む（取得層 / 計算層は別系統）。
		// - res.meta.warning  → 取得層（get_candles の multi-year/multi-day 部分失敗等）
		// - res.meta.warnings → 計算層（SMA_200 がデータ不足等）
		// data.warnings は本ツール独自の検出系警告で、上流とは別フィールドで保持する。
		const upstream = extractUpstreamWarning(res.meta);

		const allCandles = res.data.chart.candles as Array<{
			open: number;
			close: number;
			high: number;
			low: number;
			isoTime?: string;
		}>;

		// analyze_indicators は「表示窓 limit 本」の前に指標の warmup 分を足した配列を返す
		// （SMA_200 / EMA_200 のぶん fetchCount = limit + 199）。その先頭 warmup 本数が
		// `chart.meta.pastBuffer` で、表示窓を得る側が slice する契約になっている
		// （render_chart_svg の `items.slice(pastBuffer)` が同じ idiom）。
		//
		// 本ツールはこれを無視して全件をスキャンしていたため、`limit=200` の要求に対して
		// 399 本を走査し、ヘッダの `{limit}本から` が虚偽表示になっていた。
		// pastBuffer が無い場合は 0 に畳む（= 全件）——上流の形が変わっても落とさないため。
		const pastBuffer = Math.max(0, Math.trunc(res.data.chart.meta?.pastBuffer ?? 0));
		// Array.isArray を先に見る——不正な上流応答でも従来どおり 'insufficient data' に落とす
		// （slice を先に呼ぶと例外になり、graceful path が失われる）。
		const candles = Array.isArray(allCandles) && pastBuffer > 0 ? allCandles.slice(pastBuffer) : allCandles;

		// 検出器に実際に渡す配列のレンジ。slice 後の配列から出す。
		const scan = buildScanRange(candles);
		if (!Array.isArray(candles) || candles.length < 20) {
			return DetectPatternsOutputSchema.parse(
				ok(
					'insufficient data',
					{ patterns: [] },
					// パラメータは既に解決済みなので、足りなかった側の応答でも実効値は申告できる。
					// 落とすと candle 本数によって meta の形が変わる（#184 決定事項 1「常に出す」の穴）。
					// reduction も同じ理由で常に出す（#200）。この経路は検出器を一切呼ばないので全段 0。
					{
						pair,
						type,
						count: 0,
						...(scan ? { scan } : {}),
						effective_params: effectiveParams,
						reduction: {
							detected: 0,
							dedupMerged: 0,
							currentFiltered: 0,
							lifecycleExcluded: 0,
							tripleHsExcluded: 0,
							tripleHsCandidateCount: 0,
							output: 0,
						},
					},
				),
			);
		}

		// 1) Swing points（patterns/swing.ts から）
		const pivots = detectSwingPoints(candles as Candle[], { swingDepth, strictPivots });

		// debug buffers
		const debugSwings = pivots.map((p) => ({
			idx: p.idx,
			price: p.price,
			kind: p.kind,
			isoTime: candles[p.idx]?.isoTime,
		}));
		const debugCandidates: CandDebugEntry[] = [];

		// --- 共有コンテキスト構築 ---
		const ctx: DetectContext = {
			candles,
			pivots,
			allPeaks: filterPeaks(pivots),
			allValleys: filterValleys(pivots),
			tolerancePct,
			headProminencePct,
			// 反転パターンのサイズ検査の下限（issue #152）。**時間足の解決はここ 1 箇所だけ。**
			// `structural.ts` / 各検出器は純粋関数側なので `tf` を知らない。
			sizeThresholds: getSizeThresholdsForTf(type),
			// H&S / 逆 H&S の肩の同水準判定の上限（issue #244 Phase 2）。**時間足の解決はここ 1 箇所だけ。**
			// 窓生成（`outerShoulderOk`）は `HS_SHOULDER_MAX_PCT`（5%）のまま——理由は
			// `getHsShoulderMaxPctForTf` の docstring（無音の偽陰性を避けるため窓生成は緩く残す）。
			hsShoulderMaxPct: getHsShoulderMaxPctForTf(type),
			minDist,
			want,
			includeForming,
			debugCandidates,
			type,
			swingDepth,
			near: (a: number, b: number) => nearFn(a, b, tolerancePct),
			pct: pctFn,
			lrWithR2: linearRegressionWithR2,
			// 構造図（generatePatternDiagram）の日付整形専用（issue #200 要件 F-2）。
			// 検出ロジックは tz を一切参照しない——表示専用の値をここで通すだけ。
			tz,
		};

		// --- 各パターン検出を実行 ---
		let patterns: DeduplicablePattern[] = [];

		// 2) Double top/bottom
		const doubles = detectDoubles(ctx);
		patterns.push(...doubles.patterns);

		// 3) Head & Shoulders
		const hs = detectHeadAndShoulders(ctx);
		patterns.push(...hs.patterns);

		// 4) Triangles + Pennant (Trendoscope 2-stage: triangle → pole check → pennant reclassification)
		const triangles = detectTriangles(ctx);
		patterns.push(...triangles.patterns);

		// 4b-4d) Wedges
		const wedges = detectWedges(ctx);
		patterns.push(...wedges.patterns);

		// 5) Flag detection (parallel channel with pole; pennant is now handled by detectTriangles)
		const flags = detectPennantsFlags(ctx);
		patterns.push(...flags.patterns);

		// 6) Triple Top / Triple Bottom
		const triples = detectTriples(ctx);
		patterns.push(...triples.patterns);

		// --- 縮小段の件数申告（issue #200 要件 E） ---
		// 検出結果は 3 段で縮小するが、旧実装はどの段で何件減ったかを一切申告していなかった
		// （1hour の H&S で accepted 76 件 → data.patterns 2 件のような縮小が「理由不明」に見えた）。
		// 件数は各段の直前直後で `.length` を取るだけで、フィルタの判定ロジック自体は変えない
		// （本 PR は検出結果 data.patterns を 1 件も変えないことが受け入れ条件）。
		// 集計は必ずここ 1 箇所で行う——2 箇所で別々に数えると見出しと実体が食い違う事故が
		// 過去に起きている（#180 の `resolveTrimCounts` docstring）。
		const reductionDetected = patterns.length;

		// グローバル重複排除: 全パターン種別横断で期間が70%以上重複する同一タイプを統合
		patterns = globalDedup(patterns);
		const reductionDedupMerged = reductionDetected - patterns.length;

		// Optional filter: only patterns whose end is within N days from now (current relevance)
		const reductionBeforeCurrentFilter = patterns.length;
		{
			const requireCurrent = !!opts.requireCurrentInPattern;
			const defaultDaysByType = (tf: string): number => {
				if (tf === '1month') return 60; // ~2 months
				if (tf === '1week') return 21; // ~3 weeks
				return 7; // default for daily and intraday
			};
			const maxAgeDays = Number.isFinite(opts.currentRelevanceDays)
				? Number(opts.currentRelevanceDays)
				: defaultDaysByType(String(type));
			if (requireCurrent && patterns.length) {
				const nowMs = Date.now();
				const inDays = (iso?: string) => {
					if (!iso) return Infinity;
					const t = Date.parse(iso);
					if (!Number.isFinite(t)) return Infinity;
					return Math.abs(nowMs - t) / 86400000;
				};
				patterns = patterns.filter((p) => inDays(p?.range?.end) <= maxAgeDays);
			}
		}
		const reductionCurrentFiltered = reductionBeforeCurrentFilter - patterns.length;

		// status を 3 つの排他バケットに分け、対応する include* が立っているものだけ残す。
		//
		// **3 つは独立した包含スイッチで、入れ子ではない。** 旧実装は
		// 「completed バケットに invalid を入れてから includeInvalid で引き算する」形だったため、
		// `includeCompleted: false` + `includeInvalid: true` が**どちらも返さない**という
		// 到達不能な組み合わせを作っていた（`includeInvalid` の説明文は「含める」と読める）。
		//
		// `expired`（issue #126）は「形成中だったが突破確認窓を使い切った」終端状態なので、
		// forming 側ではなく invalid と同じバケットに入れる。
		const filteredPatterns = patterns.filter((p) => {
			const isForming = p.status === 'forming' || p.status === 'near_completion';
			const isInvalid = p.status === 'invalid' || p.status === 'expired';
			// status 未設定は完成済み扱い（既存契約）
			const isCompleted = p.status === 'completed' || !p.status;
			return (includeForming && isForming) || (includeCompleted && isCompleted) || (includeInvalid && isInvalid);
		});
		const reductionLifecycleExcluded = patterns.length - filteredPatterns.length;
		patterns = filteredPatterns;

		// --- triple × H&S の型間排他（issue #218 Phase 2）---
		//
		// 主構成点を 2 点以上共有する `triple_*` と H&S 系が二重に出ていた（Phase 1 実測で
		// 構造単位 18 ペア）。H&S は `headProminencePct` のゲートを通過している = 中央の構成点が
		// 両隣と明確に違うことが**検証済み**で、triple の前提「3 点が同水準」とは両立しない。
		// 同じ点集合が両方を満たすなら証拠がある側が正しいので triple を落とす。
		// 判定・スコープ・閾値を持たない理由は `patterns/mutual-exclusion.ts` の冒頭が単一ソース。
		//
		// **置く位置はライフサイクル絞り込みの後でなければならない。** 先に置くと、triple を
		// 落とした後で根拠にした H&S が `includeForming` 等の絞り込みで消え、**どちらも残らない**。
		// 後に置けば「実際に出力される H&S」だけが根拠になる。
		const tripleHsExclusion = excludeTriplesSharingHsMainPoints(patterns);
		const reductionTripleHsExcluded = patterns.length - tripleHsExclusion.kept.length;
		// 比較対象になった H&S の件数（issue #224 症状 1）。`tripleHsExcluded` の 0 は
		// 「比較して該当なし」と「H&S が集合に無く比較できなかった」の 2 通りあり、この値が
		// 0 なら後者。再計算せず関数の申告をそのまま載せる（#180 の resolveTrimCounts と同じ理由）。
		const reductionTripleHsCandidateCount = tripleHsExclusion.hsCandidateCount;
		patterns = tripleHsExclusion.kept;
		// 落とした理由を `view=debug` に残す（issue #218 の決定性要件）。**どの H&S と何点共有したかを
		// 含める**——含めないと「accepted だったはずの triple が data.patterns に居ない」理由を
		// 追えなくなる。検出器が積んだ accepted エントリはそのまま残るので、同じ構成点の候補が
		// accepted 1 件 + 本 reason の rejected 1 件で並ぶのが正常な見え方。
		for (const ex of tripleHsExclusion.excluded) {
			pushCand(ctx, {
				type: String(ex.triple.type),
				accepted: false,
				reason: TRIPLE_HS_EXCLUSION_REASON,
				idxs: ex.tripleMainIdxs,
				// `pivots` は主構成点とネックライン定義点（v1 / v2）の混在リスト（#224 症状 3）。
				// `idxs` は `mainPointIdxs()` が `kind` で主構成点に絞っているので、`pts` の role も
				// 同じ表（`mainPointKind`）から決める——全点を `main` と名乗ると `idxs` と食い違う。
				pts: (ex.triple.pivots ?? []).map((pv) => ({
					role: pv.kind === mainPointKind(String(ex.triple.type)) ? 'main' : 'neckline',
					idx: pv.idx,
					price: pv.price,
				})),
				details: {
					tripleMainIdxs: ex.tripleMainIdxs,
					sharedCount: Math.max(...ex.matches.map((m) => m.sharedIdxs.length)),
					matches: ex.matches,
				},
			});
		}

		// --- ターゲット到達の交絡申告（issue #288 Phase 2）---
		//
		// **`data.patterns` に載る集合が確定してから**付ける。`globalDedup` と型間排他より前に
		// 置くと、後で消えるパターンを「他パターンのブレイク」として数えてしまう。
		// 基準集合・区間・方向の定義は `patterns/target-confounders.ts` が単一ソース
		// （accepted のみ / 到達側は開区間・方向不問 / 未到達側は逆方向のみ）。
		// **判定フィールドは 1 つも触らない**——追加は 2 キーだけで、既存キーは動かない。
		annotateTargetBreakoutConfounders(patterns);

		// detected = dedupMerged + currentFiltered + lifecycleExcluded + tripleHsExcluded + output
		// （waterfall の不変条件）。`tripleHsCandidateCount` は件数の減少ではなく比較対象の
		// 申告なので**この等式の外**。
		// tests/detect_patterns_meta_schema_parity.test.ts が実データでこの等式を固定する。
		const reduction = {
			detected: reductionDetected,
			dedupMerged: reductionDedupMerged,
			currentFiltered: reductionCurrentFiltered,
			lifecycleExcluded: reductionLifecycleExcluded,
			tripleHsExcluded: reductionTripleHsExcluded,
			tripleHsCandidateCount: reductionTripleHsCandidateCount,
			output: patterns.length,
		};

		// statistics と data.patterns の対象集合を一致させるため、フィルタ後の patterns に対して実行する。
		const { statistics } = buildStatistics(patterns, candles);

		// 時間足ラベル（各パターンに注入 + summary 用）
		const tfMap: Record<string, string> = {
			'1min': '1分足',
			'5min': '5分足',
			'15min': '15分足',
			'30min': '30分足',
			'1hour': '1時間足',
			'4hour': '4時間足',
			'8hour': '8時間足',
			'12hour': '12時間足',
			'1day': '日足',
			'1week': '週足',
			'1month': '月足',
		};
		const tfLabel = tfMap[String(type)] || String(type);

		// 全パターンに timeframe / timeframeLabel を付与（LLM が個別パターンから時間足を即座に読み取れるようにする）
		for (const p of patterns) {
			p.timeframe = String(type);
			p.timeframeLabel = tfLabel;
		}

		// 表示・返却前に優先度順にソートする（completed → confirmed → confidence → 直近性）。
		// content と structuredContent.data.patterns / overlays が同じ並び順を共有することで
		// 低 confidence の H&S 等が上位表示される問題を防ぐ。
		patterns = rankPatterns(patterns);

		// --- ここから先は SummaryPattern として扱う（検出モジュールが付与した固有フィールドにアクセスするため） ---
		const summaryPatterns = patterns as SummaryPattern[];

		// overlays: パターン範囲をそのまま帯描画できるように提供
		const ranges = summaryPatterns.map((p) => ({ start: p.range.start, end: p.range.end, label: p.type }));
		const warnings: Array<{ type: string; message: string; suggestedParams?: Record<string, unknown> }> = [];
		// 窓が構造上足りていない（= 検出 0 件が「パターンが無い」ではなく「張れない」）ケースを先に申告する。
		// low_detection_count の「tolerancePct を緩めろ」は、窓が足りていない状況では的外れな助言になる。
		const scanWindowWarning = buildScanWindowWarning({
			type: String(type),
			bars: candles.length,
			swingDepth,
			minBarsBetweenSwings: minDist,
		});
		if (scanWindowWarning) warnings.push(scanWindowWarning);
		if (patterns.length <= 1) {
			warnings.push({
				type: 'low_detection_count',
				message: '検出数が少ないです。tolerancePct や minBarsBetweenSwings の調整を推奨します',
				suggestedParams: { tolerancePct: 0.03, minBarsBetweenSwings: 2 },
			});
		}
		// --- debug 候補を要求種別で絞る（#124） ---
		// 各検出器は want を「分類・出力の時点」でしか見ておらず、走査中の候補は無条件に push される。
		// 絞らずに下の cap トリムへ渡すと、要求していない種別の候補が枠を食い潰して
		// **要求した種別の棄却理由が押し出される**。トリムより前に 1 箇所で落とす。
		// want は上の alias 展開（'triangle' → 3 種）済み。残りの alias は候補フィルタ側で扱う。
		const relevantCandidates = filterCandidatesByWant(debugCandidates, want);

		// --- サイズ抑制: debug 配列を上限でトリム（view未指定で返却が肥大化しやすいため） ---
		// ただし accepted を優先的に残す（accepted → rejected の順で cap まで）
		const cap = 200;
		const swingsTrimmed = Array.isArray(debugSwings) ? debugSwings.slice(0, cap) : [];
		const acc = relevantCandidates.filter((c) => !!c?.accepted);
		// 型間排他（#218）の棄却は**検出器の棄却理由ではなく「accepted になった候補が output に
		// 居ない理由」**なので、accepted と同じ優先度で残す。検出器の棄却と一緒に末尾へ積むと、
		// この段は最後に push されるため**実データでは必ず cap で押し出される**
		// （実測: 実データ B の 1hour で候補 1,994 件 / cap 200）——消えた理由を追うという
		// `view=debug` の目的そのものが果たせなくなる。#180 の「押し出しは棄却理由から始まる」は維持。
		const pipelineRej = relevantCandidates.filter((c) => !c?.accepted && c?.reason === TRIPLE_HS_EXCLUSION_REASON);
		const rej = relevantCandidates.filter((c) => !c?.accepted && c?.reason !== TRIPLE_HS_EXCLUSION_REASON);
		const candidatesTrimmed: CandDebugEntry[] = [...acc, ...pipelineRej, ...rej].slice(0, cap);
		// --- トリムの申告（#180 案 1） ---
		// 配列を黙って切り詰めると、呼び出し側は 200 件を受け取っても全件か一部か判別できない。
		// トリムは accepted を先に並べてから切るので、**押し出しは rejected 側から始まる**。
		// `view=debug` の目的（なぜ検出されなかったかを理由コードで追う。#144 / #145）は
		// まさにその rejected の理由コードなので、目的の情報から先に censored される。
		// cap の値は変えず、件数だけを申告する（#218 で**順序に 1 段だけ**手を入れた。すぐ上を参照）。
		//
		// **「押し出されたのは全部 rejected」と言い切れるのは `acc.length + pipelineRej.length <= cap`
		// のときだけ。** 超えれば accepted / 型間排他の棄却も押し出される（本リポジトリの標準コーパス
		// 800 ケースでは accepted の最大が 20 件・排他は 1 ケースあたり最大 1 件で一度も起きていないが、
		// **コードが保証しているのは順序だけ**）。
		// 判別は「返した配列に `accepted: false` が 1 件でも残っているか」でできるので、
		// 表示側（`formatDebugView`）がそこで文言を分ける。ここでフィールドを増やさない。
		//
		// **総数は絞り込み（#124 の `filterCandidatesByWant`）後の `relevantCandidates` を数える。**
		// トリムされる母集団そのものなので「自分が要求した種別の棄却理由が censored されたか」に
		// 直接答える。絞り込み前（`debugCandidates.length`）は出さない——絞り込みは cap を守るための
		// 仕組みで、「`patterns` を広げればもっと見える」は偽（広げるほど押し出しは増える）。
		const debugTrimmed = {
			swings: swingsTrimmed,
			candidates: candidatesTrimmed,
			candidatesTotal: relevantCandidates.length,
			candidatesOmitted: Math.max(0, relevantCandidates.length - candidatesTrimmed.length),
			swingsTotal: Array.isArray(debugSwings) ? debugSwings.length : 0,
			swingsOmitted: Array.isArray(debugSwings) ? Math.max(0, debugSwings.length - swingsTrimmed.length) : 0,
		};

		// summary 生成: LLM が content から読み取れるように詳細を含める
		const patternSummaries = summaryPatterns
			.map((p, idx) => {
				// range.start/end は UTC ISO 文字列。表示は呼び出し側 tz（既定 Asia/Tokyo）で整形する。
				const startMs = p.range?.start ? Date.parse(p.range.start) : NaN;
				const endMs = p.range?.end ? Date.parse(p.range.end) : NaN;
				const startDate = formatDateInTz(startMs, tz) ?? '?';
				const endDate = formatDateInTz(endMs, tz) ?? '?';
				let detail = `${idx + 1}. ${p.type}【${tfLabel}】(パターン整合度: ${p.confidence})\n   - 時間足: ${tfLabel}（${type}）\n   - 期間: ${startDate} ~ ${endDate}`;

				// 低 confidence の警告ラベル（confidence < 0.6 は形状不十分、< 0.3 は除外候補レベル）。
				// 「重要」「強いシグナル」「参考材料」扱いを防ぐため、明示的に警告する。
				const confNum = Number(p.confidence ?? NaN);
				if (Number.isFinite(confNum) && confNum < 0.6) {
					if (confNum < 0.3) {
						detail += '\n   - ⚠️ 信頼度: 非常に低い（形状不十分・除外候補レベル、単独判断不可）';
					} else {
						detail += '\n   - ⚠️ 信頼度: 低い（形状不十分・単独判断不可、他指標と必ず併用）';
					}
				}

				// status（全パターン共通）
				if (p.status) {
					const statusJa: Record<string, string> = {
						completed: '完成（ブレイクアウト確認済み）',
						invalid: '無効（期待と逆方向にブレイク）',
						forming: '形成中',
						near_completion: 'ほぼ完成（apex接近）',
					};
					detail += `\n   - 状態: ${statusJa[p.status] || p.status}`;
				}

				// ブレイクアウト情報（全パターン共通）
				if (p.breakoutDirection && p.outcome) {
					const directionJa = p.breakoutDirection === 'up' ? '上方' : '下方';
					const outcomeJa = p.outcome === 'success' ? '成功' : '失敗';

					// パターン別の期待方向と意味付け
					const expectedDirMap: Record<string, string | undefined> = {
						falling_wedge: '上方',
						rising_wedge: '下方',
						triangle_ascending: '上方',
						triangle_descending: '下方',
						pennant: p.poleDirection === 'up' ? '上方' : p.poleDirection === 'down' ? '下方' : undefined,
						bull_flag: '上方',
						bear_flag: '下方',
						bull_pennant: '上方',
						bear_pennant: '下方',
						flag: undefined,
					};
					const expectedDir = expectedDirMap[p.type];

					const meaningMap: Record<string, Record<string, string>> = {
						falling_wedge: { success: '強気転換', failure: '弱気継続' },
						rising_wedge: { success: '弱気転換', failure: '強気継続' },
						triangle_ascending: { success: '上方ブレイク（強気）', failure: '下方ブレイク（弱気転換）' },
						triangle_descending: { success: '下方ブレイク（弱気）', failure: '上方ブレイク（強気転換）' },
						pennant: {
							success: `トレンド継続（${p.poleDirection === 'up' ? '強気' : '弱気'}）`,
							failure: `ダマシ（${p.poleDirection === 'up' ? '弱気転換' : '強気転換'}）`,
						},
						bull_flag: { success: 'トレンド継続（強気）', failure: 'ダマシ（弱気転換）' },
						bear_flag: { success: 'トレンド継続（弱気）', failure: 'ダマシ（強気転換）' },
						bull_pennant: { success: 'トレンド継続（強気）', failure: 'ダマシ（弱気転換）' },
						bear_pennant: { success: 'トレンド継続（弱気）', failure: 'ダマシ（強気転換）' },
					};
					const meaning = meaningMap[p.type]?.[p.outcome] || `${directionJa}ブレイク`;

					detail += `\n   - ブレイク方向: ${directionJa}ブレイク`;
					if (expectedDir) detail += `（本来は${expectedDir}ブレイクが期待されるパターン）`;
					detail += `\n   - パターン結果: ${outcomeJa}（${meaning}）`;
				}

				// ネックライン/トレンドラインがある場合（用語正規化ラベルを使用）
				if (p.neckline && Array.isArray(p.neckline) && p.neckline.length >= 2) {
					const label = p.trendlineLabel || 'ネックライン';
					detail += `\n   - ${label}: ${Math.round(p.neckline[0]?.y || 0).toLocaleString('ja-JP')}円 → ${Math.round(p.neckline[1]?.y || 0).toLocaleString('ja-JP')}円`;
				}

				// ウェッジ固有: Apex（頂点）情報
				if ((p.type === 'falling_wedge' || p.type === 'rising_wedge') && p.daysToApex != null) {
					detail += `\n   - Apex（収束点）まで: ${p.daysToApex}本`;
				}

				// ターゲット価格情報（全パターン共通）
				//
				// **ターゲット行は `breakoutTarget` の有無で握り潰さない。** `targetProgressOmittedReason:
				// 'no_target'` は「ターゲット価格そのものが出せなかった」ことの申告なので、
				// **理由を出すべき唯一のケースで `breakoutTarget` が必ず無い。** 価格行のガードの中に
				// 進捗行を入れていると、その 1 経路だけが content から消える（#224 症状 2 と同じ形が
				// 呼び出し側に残っていた。#288 Phase 2 のレビュー指摘）。
				//
				// 日時は時間足に応じて粒度を変える（intraday は分まで）。
				// **暦日に潰すと 1hour では 24 本が同じラベルになり、初到達の足を特定できない。**
				const progressLine = formatTargetProgressLine(p, {
					formatDate: (iso) => formatDateOrTimeInTz(iso, tz, String(type)) ?? iso,
				});
				if (p.breakoutTarget != null) {
					const methodJa: Record<string, string> = {
						flagpole_projection: 'フラッグポール値幅投影',
						pattern_height: 'パターン高さ投影',
						neckline_projection: 'ネックライン投影',
					};
					detail += `\n   - ターゲット価格: ${Math.round(p.breakoutTarget).toLocaleString('ja-JP')}円（${(p.targetMethod && methodJa[p.targetMethod]) || p.targetMethod || '不明'}）`;
				}
				if (progressLine) detail += `\n${progressLine}`;

				// flag / pennant 固有フィールド（bull_*/bear_* 含む。legacy 'pennant' も処理）
				if (
					p.type === 'pennant' ||
					p.type === 'bull_flag' ||
					p.type === 'bear_flag' ||
					p.type === 'bull_pennant' ||
					p.type === 'bear_pennant'
				) {
					if (p.poleDirection) {
						detail += `\n   - フラッグポール方向: ${p.poleDirection === 'up' ? '上昇' : '下降'}`;
					}
					if (p.priorTrendDirection) {
						detail += `\n   - 先行トレンド: ${p.priorTrendDirection === 'bullish' ? '強気（上昇トレンド）' : '弱気（下降トレンド）'}`;
					}
					if (p.flagpoleHeight != null) {
						detail += `\n   - フラッグポール値幅: ${Math.round(p.flagpoleHeight).toLocaleString('ja-JP')}円`;
					}
					// pole の検証情報
					const pAny = p as SummaryPattern & FlagFamilyMetadata;
					if (pAny.poleStartDate && pAny.poleEndDate && pAny.poleChangePct != null) {
						const psd = formatDateInTz(Date.parse(pAny.poleStartDate), tz) ?? pAny.poleStartDate;
						const ped = formatDateInTz(Date.parse(pAny.poleEndDate), tz) ?? pAny.poleEndDate;
						const sign = pAny.poleChangePct >= 0 ? '+' : '';
						const pctStr = `${sign}${(pAny.poleChangePct * 100).toFixed(1)}%`;
						const barsStr = pAny.poleBars ? `, ${pAny.poleBars}本` : '';
						detail += `\n   - 旗竿期間: ${psd} ~ ${ped}（${pctStr}${barsStr}）`;
					}
					if (pAny.poleATRMult != null) {
						detail += `\n   - 旗竿 ATR 倍率: ${pAny.poleATRMult.toFixed(2)}x`;
					}
					if (pAny.flagUpperSlope != null && pAny.flagLowerSlope != null) {
						detail += `\n   - チャネル傾き: 上限=${pAny.flagUpperSlope.toFixed(2)}, 下限=${pAny.flagLowerSlope.toFixed(2)}（円/本）`;
					}
					if (pAny.spreadAvg != null && pAny.spreadStability != null) {
						const stabPct = (pAny.spreadStability * 100).toFixed(0);
						detail += `\n   - 平均チャネル幅: ${Math.round(pAny.spreadAvg).toLocaleString('ja-JP')}円（平行度: ${stabPct}%）`;
					}
					if (pAny.expectedBreakoutDirection) {
						detail += `\n   - 期待ブレイク方向: ${pAny.expectedBreakoutDirection === 'up' ? '上方' : '下方'}`;
					}
					if (p.retracementRatio != null) {
						const pctStr = (p.retracementRatio * 100).toFixed(0);
						detail += `\n   - 戻し比率: ${pctStr}%${p.retracementRatio > 0.38 ? '（高め — トライアングル寄り）' : '（正常範囲）'}`;
					}
					if (p.isTrendContinuation !== undefined) {
						detail += `\n   - トレンド継続: ${p.isTrendContinuation ? 'はい（成功）' : 'いいえ（ダマシ）'}`;
					}
				}

				return detail;
			})
			.join('\n\n');

		// aftermath 統計をテキストに含める（LLM が structuredContent.data を読めない対策）
		const statsText =
			statistics && Object.keys(statistics).length > 0
				? '\n\n【統計情報】\n' +
					Object.entries(statistics)
						.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
						.join('\n')
				: '';
		// スキャン範囲（検出器に渡した足）＋ 検出パターン分布期間（パターンの range 分布）。
		// 2 行は別の量なので分けて出す（詳細は patterns/period.ts）。tz 表示、構造化データは UTC ISO のまま。
		const periodBlock = buildPeriodBlock(scan, type, summaryPatterns, tz);
		const periodText = periodBlock ? `\n${periodBlock}` : '';
		// タイプ別件数を集約（例: rising_wedge×3, falling_wedge×2）
		const typeCounts: Record<string, number> = {};
		for (const p of summaryPatterns) {
			typeCounts[p.type] = (typeCounts[p.type] || 0) + 1;
		}
		const typeCountStr = Object.entries(typeCounts)
			.map(([t, c]) => `${t}×${c}`)
			.join(', ');

		const baseSummary =
			`${pair.toUpperCase()} ${tfLabel}（${type}） ${limit}本から${patterns.length}件を検出（${typeCountStr}）${periodText}\n\n【検出パターン（全件）】\n${patternSummaries || 'なし'}${statsText}\n\nチャート連携: data.overlays を render_chart_svg.overlays に渡すと注釈/範囲を描画できます。\n\nパターン整合度について（構成点の水準の揃い方・戻り率・ブレイク品質・期間から算出。軸の構成は種別で異なる）:\n  ※整合度は**構造ゲートを通過した候補どうしの形の良さ**の比較値であって、構造的妥当性の指標ではない。\n    ネックラインが先行値幅の起点を越えている等の構造的に無効な形は、整合度が下がるのではなく検出結果に出ない。\n    内訳は data.patterns[].scoreComponents、ゲートの計測値は data.patterns[].structureGate を参照。\n  0.8以上 = 理想的な形状（教科書的パターン）\n  0.7-0.8 = 標準的な形状（他指標と併用推奨）\n  0.6-0.7 = やや不明瞭（慎重に判断）\n  0.6未満 = 形状不十分` +
			`\n\n---\n📌 含まれるもの: チャートパターン検出（種類・整合度・期間）、ブレイク情報、統計` +
			`\n📌 含まれないもの: 出来高によるパターン確認、テクニカル指標値、板情報` +
			`\n📌 補完ツール: analyze_indicators（指標でパターンを裏付け）, get_flow_metrics（出来高確認）, get_orderbook（板情報）`;
		// summary 先頭に warning を別行で連結（separator='\n'）。上流（取得層 / 計算層）→ 検出層の順。
		// LLM が summary だけ見ても不完全性に気づけるようにするためで、
		// data.warnings は structuredContent 側にしか無く LLM から見えない（`.claude/rules/tools.md`）。
		const summaryWithScanWarning = prependWarnings(
			baseSummary,
			scanWindowWarning ? { warnings: [scanWindowWarning.message] } : undefined,
			{ separator: '\n' },
		);
		const summaryText = prependWarnings(summaryWithScanWarning, upstream, { separator: '\n' });

		const out = ok(
			summaryText,
			{ patterns, overlays: { ranges }, warnings, statistics },
			{
				pair,
				type,
				count: patterns.length,
				...(scan ? { scan } : {}),
				effective_params: effectiveParams,
				visualization_hints: {
					preferred_style: 'line',
					highlight_patterns: patterns.map((p) => p.type).slice(0, 3),
				},
				debug: debugTrimmed,
				reduction,
				...(upstream.warning ? { warning: upstream.warning } : {}),
				...(upstream.warnings && upstream.warnings.length > 0 ? { warnings: upstream.warnings } : {}),
			},
		);
		return DetectPatternsOutputSchema.parse(out);
	} catch (e: unknown) {
		return failFromError(e, { schema: DetectPatternsOutputSchema });
	}
}
