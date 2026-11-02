import type { z } from 'zod';
import { formatDateInTz, formatDateOrTimeInTz } from '../lib/datetime.js';
import { fail, failFromError, ok } from '../lib/result.js';
import { extractUpstreamWarning, prependWarnings } from '../lib/warning-propagation.js';
import { DetectPatternsOutputSchema, type PatternFilterEnum } from '../src/schemas.js';
import analyzeIndicators from './analyze_indicators.js';
import { buildStatistics } from './patterns/aftermath.js';
import { filterCandidatesByWant } from './patterns/candidate-filter.js';
import {
	getHsShoulderMaxPctForTf,
	getPriorTrendParamsForTf,
	getSizeThresholdsForTf,
	resolveParams,
} from './patterns/config.js';
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
import { buildScanWindowWarning } from './patterns/scan-window.js';
import { REVERSAL_HISTORY_WARMUP_BARS } from './patterns/structural.js';
import { formatStructureGateSkipLine, formatTriplePositionLines } from './patterns/structure-diagnostics.js';
import { type Candle, detectSwingPoints, filterPeaks, filterValleys } from './patterns/swing.js';
import { annotateTargetBreakoutConfounders, type TargetBreakoutConfounder } from './patterns/target-confounders.js';
import { formatTargetProgressLine } from './patterns/target-reach.js';
import {
	type CandDebugEntry,
	type DeduplicablePattern,
	type DetectContext,
	type PatternEntry,
	pushCand,
} from './patterns/types.js';

/** PatternEntry と同じ形。DeduplicablePattern 経由の summary 生成では型情報が落ちるのでキャストに使う。 */
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
	// DeduplicablePattern の index signature 経由だと unknown になり formatTargetProgressLine に通らないので、ここにも宣言する（#288）。
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
	structureGate?: { skipped?: 'no_prior_extreme' | 'insufficient_history' };
}

const REVERSAL_PATTERN_TYPES = new Set([
	'double_top',
	'double_bottom',
	'triple_top',
	'triple_bottom',
	'head_and_shoulders',
	'inverse_head_and_shoulders',
]);
const PIPELINE_REJECTION_REASONS = new Set(['reversal_history_insufficient', TRIPLE_HS_EXCLUSION_REASON]);

// identifier は開始日までしか持たない（#200）ので、同じ日に始まる同種のパターンが並ぶとぶつかる。並べた後の 2 つ目以降に連番を付けて、結果の中で一意にする。
function uniquifyDiagramIdentifiers(patterns: DeduplicablePattern[]): DeduplicablePattern[] {
	const seen = new Map<string, number>();
	return patterns.map((p) => {
		const diagram = p.structureDiagram as PatternEntry['structureDiagram'];
		if (!diagram?.artifact) return p;
		const n = (seen.get(diagram.artifact.identifier) ?? 0) + 1;
		seen.set(diagram.artifact.identifier, n);
		if (n === 1) return p;
		return {
			...p,
			structureDiagram: {
				...diagram,
				artifact: { ...diagram.artifact, identifier: `${diagram.artifact.identifier}-${n}` },
			},
		};
	});
}

// 継続系には先行反転トレンドの要件が無いので対象にしない。
function filterReversalPatternsWithoutHistory(
	patterns: DeduplicablePattern[],
	debugCandidates: CandDebugEntry[],
	availableBars: number,
): { patterns: DeduplicablePattern[]; excluded: number } {
	// REVERSAL_HISTORY_WARMUP_BARS 以下の窓では scan-window 警告を優先し、短い fixture や小窓の後方互換を保つ。
	if (availableBars <= REVERSAL_HISTORY_WARMUP_BARS) return { patterns, excluded: 0 };
	let excluded = 0;
	const kept: DeduplicablePattern[] = [];
	for (const pattern of patterns) {
		if (!pattern.type || !REVERSAL_PATTERN_TYPES.has(pattern.type)) {
			kept.push(pattern);
			continue;
		}
		const firstPivotIdx = pattern.pivots?.[0]?.idx;
		const structureSkipped = (pattern.structureGate as { skipped?: string } | undefined)?.skipped;
		const precedingTrend = pattern.precedingTrend as { direction?: string } | undefined;
		const historyUnverified =
			structureSkipped === 'no_prior_extreme' ||
			structureSkipped === 'insufficient_history' ||
			precedingTrend?.direction === 'insufficient_data';
		if (
			typeof firstPivotIdx !== 'number' ||
			!Number.isInteger(firstPivotIdx) ||
			firstPivotIdx >= REVERSAL_HISTORY_WARMUP_BARS ||
			!historyUnverified
		) {
			kept.push(pattern);
			continue;
		}
		excluded += 1;
		debugCandidates.push({
			type: pattern.type,
			accepted: false,
			reason: 'reversal_history_insufficient',
			indices: [firstPivotIdx as number],
			details: {
				firstPivotIdx,
				requiredBars: REVERSAL_HISTORY_WARMUP_BARS,
			},
		});
	}
	return { patterns: kept, excluded };
}

export default async function detectPatterns(
	pair: string = 'btc_jpy',
	type: string = '1day',
	limit: number = 90,
	opts: Partial<{
		swingDepth: number;
		tolerancePct: number;
		minBarsBetweenSwings: number;
		/** tolerancePct とは向きが逆で、大きいほど判定が厳しくなる（#149）。 */
		headProminencePct: number;
		strictPivots: boolean;
		patterns: Array<z.infer<typeof PatternFilterEnum>>;
		requireCurrentInPattern: boolean;
		currentRelevanceDays: number;
		/** get_candles と同じ終端アンカー。 */
		date: string;
		includeForming: boolean;
		includeCompleted: boolean;
		includeInvalid: boolean;
		view: 'summary' | 'detailed' | 'full' | 'debug';
		tz: string;
	}> = {},
) {
	try {
		const {
			swingDepth,
			tolerancePct,
			minBarsBetweenSwings: minDist,
			headProminencePct,
			sources: paramSources,
		} = resolveParams(type, opts);
		// ok() を返す経路が 2 つある（通常 / insufficient data）ので 1 回だけ組んで両方に渡す（片方だけだと candle 本数依存の申告漏れになる。#184）。
		const effectiveParams = {
			swingDepth: { value: swingDepth, source: paramSources.swingDepth },
			minBarsBetweenSwings: { value: minDist, source: paramSources.minBarsBetweenSwings },
			tolerancePct: { value: tolerancePct, source: paramSources.tolerancePct },
			headProminencePct: { value: headProminencePct, source: paramSources.headProminencePct },
		};
		const strictPivots = opts.strictPivots !== false; // 既定: 厳格
		const includeForming = opts.includeForming ?? false;
		const includeCompleted = opts.includeCompleted ?? true;
		const includeInvalid = opts.includeInvalid ?? false;
		const tz = opts.tz ?? 'Asia/Tokyo';
		const want = new Set(opts.patterns || []);
		if (want.has('triangle')) {
			want.add('triangle_ascending');
			want.add('triangle_descending');
			want.add('triangle_symmetrical');
		}

		const res = await analyzeIndicators(pair, type, limit, opts.date, tz);
		if (!res.ok) return DetectPatternsOutputSchema.parse(fail(res.summary || 'failed', 'internal'));

		const upstream = extractUpstreamWarning(res.meta);

		const allCandles = res.data.chart.candles as Array<{
			open: number;
			close: number;
			high: number;
			low: number;
			isoTime?: string;
		}>;

		// analyze_indicators は warmup 分を足した配列を返すので、表示窓は pastBuffer を slice して得る（render_chart_svg と同じ。全件を走査するとヘッダの {limit}本から が虚偽になる）。
		const pastBuffer = Math.max(0, Math.trunc(res.data.chart.meta?.pastBuffer ?? 0));
		// Array.isArray を先に見る（slice を先に呼ぶと不正な上流応答で例外になり insufficient data に落ちない）。
		const candles = Array.isArray(allCandles) && pastBuffer > 0 ? allCandles.slice(pastBuffer) : allCandles;

		const scan = buildScanRange(candles);
		if (scan && opts.date) scan.anchorDate = opts.date;
		if (!Array.isArray(candles) || candles.length < 20) {
			return DetectPatternsOutputSchema.parse(
				ok(
					'insufficient data',
					{ patterns: [] },
					// 足りない側の応答でも実効値と reduction は常に出す（candle 本数で meta の形を変えない。#184, #200）。
					{
						pair,
						type,
						count: 0,
						...(upstream.warning ? { warning: upstream.warning } : {}),
						...(upstream.warnings && upstream.warnings.length > 0 ? { warnings: upstream.warnings } : {}),
						...(scan ? { scan } : {}),
						effective_params: effectiveParams,
						reduction: {
							detected: 0,
							reversalHistoryExcluded: 0,
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

		const pivots = detectSwingPoints(candles as Candle[], { swingDepth, strictPivots });

		const debugSwings = pivots.map((p) => ({
			idx: p.idx,
			price: p.price,
			kind: p.kind,
			isoTime: candles[p.idx]?.isoTime,
		}));
		const debugCandidates: CandDebugEntry[] = [];

		const ctx: DetectContext = {
			candles,
			pivots,
			allPeaks: filterPeaks(pivots),
			allValleys: filterValleys(pivots),
			tolerancePct,
			headProminencePct,
			// 時間足の解決はここ 1 箇所だけ（structural.ts と各検出器は tf を知らない。#152）。
			sizeThresholds: getSizeThresholdsForTf(type),
			// 窓生成（outerShoulderOk）は HS_SHOULDER_MAX_PCT のまま緩く残す（無音の偽陰性を避けるため。#244）。
			hsShoulderMaxPct: getHsShoulderMaxPctForTf(type),
			priorTrendParams: getPriorTrendParamsForTf(type),
			minDist,
			want,
			includeForming,
			debugCandidates,
			type,
			swingDepth,
			// ctx.tz は構造図の日付整形専用で、各検出器の判定には使わない。
			tz,
		};

		let patterns: DeduplicablePattern[] = [];

		const doubles = detectDoubles(ctx);
		patterns.push(...doubles.patterns);

		const hs = detectHeadAndShoulders(ctx);
		patterns.push(...hs.patterns);

		const triangles = detectTriangles(ctx);
		patterns.push(...triangles.patterns);

		const wedges = detectWedges(ctx);
		patterns.push(...wedges.patterns);

		const flags = detectPennantsFlags(ctx);
		patterns.push(...flags.patterns);

		const triples = detectTriples(ctx);
		patterns.push(...triples.patterns);

		const detectedBeforeHistoryFilter = patterns.length;
		const historyFiltered = filterReversalPatternsWithoutHistory(patterns, debugCandidates, candles.length);
		patterns = historyFiltered.patterns;
		const reductionReversalHistoryExcluded = historyFiltered.excluded;

		// 集計は必ずここ 1 箇所で行う（2 箇所で数えると見出しと実体が食い違う。#180）。
		const reductionDetected = detectedBeforeHistoryFilter;

		const reductionBeforeDedup = patterns.length;
		patterns = globalDedup(patterns);
		const reductionDedupMerged = reductionBeforeDedup - patterns.length;

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
				const anchoredMs = opts.date && scan ? Date.parse(scan.end) : Number.NaN;
				const referenceMs = Number.isFinite(anchoredMs) ? anchoredMs : Date.now();
				const inDays = (iso?: string) => {
					if (!iso) return Infinity;
					const t = Date.parse(iso);
					if (!Number.isFinite(t)) return Infinity;
					return Math.abs(referenceMs - t) / 86400000;
				};
				patterns = patterns.filter((p) => inDays(p?.range?.end) <= maxAgeDays);
			}
		}
		const reductionCurrentFiltered = reductionBeforeCurrentFilter - patterns.length;

		// 3 つの include* は独立した包含スイッチで入れ子ではない。expired は突破確認窓を使い切った終端状態なので invalid と同じバケットに入れる（#126）。
		const filteredPatterns = patterns.filter((p) => {
			const isForming = p.status === 'forming' || p.status === 'near_completion';
			const isInvalid = p.status === 'invalid' || p.status === 'expired';
			// status 未設定は完成済み扱い（既存契約）
			const isCompleted = p.status === 'completed' || !p.status;
			return (includeForming && isForming) || (includeCompleted && isCompleted) || (includeInvalid && isInvalid);
		});
		const reductionLifecycleExcluded = patterns.length - filteredPatterns.length;
		patterns = filteredPatterns;

		// ライフサイクル絞り込みの後に置く。先に置くと triple を落とした後で根拠の H&S が絞り込みで消え、どちらも残らない（#218）。
		const tripleHsExclusion = excludeTriplesSharingHsMainPoints(patterns);
		const reductionTripleHsExcluded = patterns.length - tripleHsExclusion.kept.length;
		// 0 なら「比較して該当なし」ではなく「H&S が集合に無く比較できなかった」。再計算せず関数の申告をそのまま載せる（#224）。
		const reductionTripleHsCandidateCount = tripleHsExclusion.hsCandidateCount;
		patterns = tripleHsExclusion.kept;
		// どの H&S と何点共有したかを含める（含めないと accepted だった triple が data.patterns に居ない理由を追えない。#218）。
		for (const ex of tripleHsExclusion.excluded) {
			pushCand(ctx, {
				type: String(ex.triple.type),
				accepted: false,
				reason: TRIPLE_HS_EXCLUSION_REASON,
				idxs: ex.tripleMainIdxs,
				// idxs は mainPointIdxs が kind で主構成点に絞っているので、pts の role も同じ表から決める（全点を main と名乗ると食い違う）。
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

		// data.patterns に載る集合が確定してから付ける（globalDedup と型間排他より前だと、後で消えるパターンを数える）。基準集合・区間・方向は patterns/target-confounders.ts が単一ソース。
		annotateTargetBreakoutConfounders(patterns);

		// detected = reversalHistoryExcluded + dedupMerged + currentFiltered + lifecycleExcluded + tripleHsExcluded + output（tripleHsCandidateCount は等式の外。テストが実データで固定する）。
		const reduction = {
			detected: reductionDetected,
			reversalHistoryExcluded: reductionReversalHistoryExcluded,
			dedupMerged: reductionDedupMerged,
			currentFiltered: reductionCurrentFiltered,
			lifecycleExcluded: reductionLifecycleExcluded,
			tripleHsExcluded: reductionTripleHsExcluded,
			tripleHsCandidateCount: reductionTripleHsCandidateCount,
			output: patterns.length,
		};

		// statistics と data.patterns の対象集合を一致させるため、フィルタ後の patterns に対して実行する。
		const { statistics } = buildStatistics(patterns, candles);

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

		for (const p of patterns) {
			p.timeframe = String(type);
			p.timeframeLabel = tfLabel;
		}

		// content と structuredContent が同じ並び順を共有するよう、表示・返却前に並べる。
		patterns = rankPatterns(patterns);
		patterns = uniquifyDiagramIdentifiers(patterns);

		const summaryPatterns = patterns as SummaryPattern[];

		const ranges = summaryPatterns.map((p) => ({ start: p.range.start, end: p.range.end, label: p.type }));
		const warnings: Array<{ type: string; message: string; suggestedParams?: Record<string, unknown> }> = [];
		// 窓が足りないときに low_detection_count の「tolerancePct を緩めろ」は的外れなので、先に申告する。
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
		// cap トリムより前に 1 箇所で落とす。絞らないと要求していない種別の候補が枠を食い潰し、要求した種別の棄却理由が押し出される（#124）。
		const relevantCandidates = filterCandidatesByWant(debugCandidates, want);

		const cap = 200;
		const swingsTrimmed = Array.isArray(debugSwings) ? debugSwings.slice(0, cap) : [];
		const acc = relevantCandidates.filter((c) => !!c?.accepted);
		// 履歴不足段と型間排他の棄却は accepted と同じ優先度で残す（末尾に積むと実データでは必ず cap で押し出される。#218）。
		const pipelineRej = relevantCandidates.filter(
			(c) => !c?.accepted && PIPELINE_REJECTION_REASONS.has(c?.reason ?? ''),
		);
		const rej = relevantCandidates.filter((c) => !c?.accepted && !PIPELINE_REJECTION_REASONS.has(c?.reason ?? ''));
		const candidatesTrimmed: CandDebugEntry[] = [...acc, ...pipelineRej, ...rej].slice(0, cap);
		// 総数は絞り込み後の relevantCandidates を数える（トリムされる母集団そのもの。#180）。
		const debugTrimmed = {
			swings: swingsTrimmed,
			candidates: candidatesTrimmed,
			candidatesTotal: relevantCandidates.length,
			candidatesOmitted: Math.max(0, relevantCandidates.length - candidatesTrimmed.length),
			swingsTotal: Array.isArray(debugSwings) ? debugSwings.length : 0,
			swingsOmitted: Array.isArray(debugSwings) ? Math.max(0, debugSwings.length - swingsTrimmed.length) : 0,
		};

		const patternSummaries = summaryPatterns
			.map((p, idx) => {
				const startMs = p.range?.start ? Date.parse(p.range.start) : NaN;
				const endMs = p.range?.end ? Date.parse(p.range.end) : NaN;
				const startDate = formatDateInTz(startMs, tz) ?? '?';
				const endDate = formatDateInTz(endMs, tz) ?? '?';
				let detail = `${idx + 1}. ${p.type}【${tfLabel}】(パターン整合度: ${p.confidence})\n   - 時間足: ${tfLabel}（${type}）\n   - 期間: ${startDate} ~ ${endDate}`;

				const confNum = Number(p.confidence ?? NaN);
				if (Number.isFinite(confNum) && confNum < 0.6) {
					if (confNum < 0.3) {
						detail += '\n   - ⚠️ 信頼度: 非常に低い（形状不十分・除外候補レベル、単独判断不可）';
					} else {
						detail += '\n   - ⚠️ 信頼度: 低い（形状不十分・単独判断不可、他指標と必ず併用）';
					}
				}

				if (p.status) {
					const statusJa: Record<string, string> = {
						completed: '完成（ブレイクアウト確認済み）',
						invalid: '無効（期待と逆方向にブレイク）',
						forming: '形成中',
						near_completion: 'ほぼ完成（apex接近）',
					};
					detail += `\n   - 状態: ${statusJa[p.status] || p.status}`;
				}

				const structureGateSkipLine = formatStructureGateSkipLine(p.structureGate?.skipped);
				if (structureGateSkipLine) detail += `\n${structureGateSkipLine}`;
				for (const positionLine of formatTriplePositionLines(p.type, p.pivots)) detail += `\n${positionLine}`;

				if (p.breakoutDirection && p.outcome) {
					const directionJa = p.breakoutDirection === 'up' ? '上方' : '下方';
					const outcomeJa = p.outcome === 'success' ? '成功' : '失敗';

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
						falling_wedge: { success: '強気転換', failure: '上方転換シナリオ無効化' },
						rising_wedge: { success: '弱気転換', failure: '下方転換シナリオ無効化' },
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

				if (p.neckline && Array.isArray(p.neckline) && p.neckline.length >= 2) {
					const label = p.trendlineLabel || 'ネックライン';
					detail += `\n   - ${label}: ${Math.round(p.neckline[0]?.y || 0).toLocaleString('ja-JP')}円 → ${Math.round(p.neckline[1]?.y || 0).toLocaleString('ja-JP')}円`;
				}

				if ((p.type === 'falling_wedge' || p.type === 'rising_wedge') && p.daysToApex != null) {
					detail += `\n   - Apex（収束点）まで: ${p.daysToApex}本`;
				}

				// ターゲット行は breakoutTarget の有無で握り潰さない。no_target は breakoutTarget が必ず無いときの申告なので、価格行のガードに入れるとその経路だけが消える。
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

				if (
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

		const statsText =
			statistics && Object.keys(statistics).length > 0
				? '\n\n【統計情報】\n' +
					Object.entries(statistics)
						.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
						.join('\n')
				: '';
		// スキャン範囲とパターン分布期間は別の量なので 2 行に分けて出す。
		const periodBlock = buildPeriodBlock(scan, type, summaryPatterns, tz);
		const periodText = periodBlock ? `\n${periodBlock}` : '';
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
		// 順序は上流（取得層 / 計算層）→ 検出層。data.warnings は structuredContent にしか無く LLM から見えない。
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
