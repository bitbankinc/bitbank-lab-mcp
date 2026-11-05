// limit のスキーマ下限（20）は公開契約なので変えず、構造上何も出ない窓は data.warnings と content で申告する。

import { timeframeLabel } from '../../lib/formatter.js';

// どの検出器の要件にも対応しない経験値だが、#134 の実測で据え置いた。構造から導いた不変量ではない。
// structuralFloorBars の唯一の入力で、全検出器のサイズ閾値に効く。動かすと docs/tools.md の 2 表と min-bars.ts の導出値も動く。
export const STRUCTURAL_PIVOT_GAP_FLOOR_BARS = 5;

export const SCAN_WINDOW_WARNING_TYPE = 'limit_too_small_for_timeframe';

export interface PatternWarning {
	type: string;
	message: string;
	suggestedParams?: Record<string, unknown>;
}

export interface ScanWindowAssessment {
	bars: number;
	pivotCandidateBars: number;
	requiredPivotCandidateBars: number;
	pivotGapBars: number;
	minViableLimit: number;
	sufficient: boolean;
}

// 最も安い 3 ピボット構造（double）で判定する。通っても検出は保証せず、構造上ゼロになる窓を見つけるための下限。
export function assessScanWindow(bars: number, swingDepth: number, minBarsBetweenSwings: number): ScanWindowAssessment {
	const safeBars = Number.isFinite(bars) ? Math.max(0, Math.trunc(bars)) : 0;
	const safeDepth = Number.isFinite(swingDepth) ? Math.max(0, Math.trunc(swingDepth)) : 0;
	const safeMinDist = Number.isFinite(minBarsBetweenSwings) ? Math.max(1, Math.trunc(minBarsBetweenSwings)) : 1;

	const pivotGapBars = Math.max(safeMinDist, STRUCTURAL_PIVOT_GAP_FLOOR_BARS);
	// 3 ピボット（山・谷・山）を最小間隔で並べるのに要る幅 + 両端の 1 本。
	const requiredPivotCandidateBars = 2 * pivotGapBars + 1;
	// detectSwingPoints は idx ∈ [swingDepth, bars - swingDepth) だけを候補にする。
	const pivotCandidateBars = Math.max(0, safeBars - 2 * safeDepth);
	const minViableLimit = 2 * safeDepth + requiredPivotCandidateBars;

	return {
		bars: safeBars,
		pivotCandidateBars,
		requiredPivotCandidateBars,
		pivotGapBars,
		minViableLimit,
		sufficient: pivotCandidateBars >= requiredPivotCandidateBars,
	};
}

export function buildScanWindowWarning(params: {
	type: string;
	bars: number;
	swingDepth: number;
	minBarsBetweenSwings: number;
}): PatternWarning | null {
	const { type, bars, swingDepth, minBarsBetweenSwings } = params;
	const a = assessScanWindow(bars, swingDepth, minBarsBetweenSwings);
	if (a.bars <= 0 || a.sufficient) return null;

	const tfLabel = timeframeLabel(String(type));
	const message =
		`limit が${tfLabel}（${type}）に対して小さすぎます: ` +
		`スキャン窓 ${a.bars}本 のうち前後 swingDepth=${swingDepth}本 ずつがスイング検出から外れるため、` +
		`ピボット候補は ${a.pivotCandidateBars}本 しか残りません` +
		`（最小構成の反転パターン＝3 ピボット × 最小間隔 ${a.pivotGapBars}本 には ${a.requiredPivotCandidateBars}本 必要）。` +
		`この窓では構造上ほぼ何も検出できないので、0 件を「パターンが無い」と解釈しないこと。` +
		`limit≥${a.minViableLimit} にするか、swingDepth を下げてください。`;

	return {
		type: SCAN_WINDOW_WARNING_TYPE,
		message,
		suggestedParams: { limit: a.minViableLimit },
	};
}

export function extractScanWindowWarnings(warnings: ReadonlyArray<PatternWarning> | undefined | null): string[] {
	if (!Array.isArray(warnings)) return [];
	return warnings.filter((w) => w?.type === SCAN_WINDOW_WARNING_TYPE && !!w.message).map((w) => w.message);
}
