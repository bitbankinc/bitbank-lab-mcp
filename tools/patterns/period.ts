// スキャン範囲（検出器に渡した足）と検出パターン分布期間（パターンの range）は別の量なので、混ぜずに 2 行で出す。

import { formatDateInTz, isIntradayType, resolveTz, toIsoWithTz } from '../../lib/datetime.js';

/** 検出器に渡した足のレンジ。`meta.scan` と同じ形で、start / end は UTC ISO 文字列。 */
export interface ScanRange {
	start: string;
	end: string;
	bars: number;
	anchorDate?: string;
}

interface RangedPattern {
	range?: { start?: string; end?: string } | undefined;
}

// 実体は lib/datetime.ts。既存の import パス（tools/patterns/period.js）を壊さないよう re-export する。
export { isIntradayType } from '../../lib/datetime.js';

const toTs = (s?: string | null): number => (s ? Date.parse(s) : Number.NaN);

// tz は resolveTz 済みのものを渡す。未解決の tz だと行が消える。
function formatScanBoundary(ms: number, tz: string, intraday: boolean): string | null {
	if (!Number.isFinite(ms)) return null;
	if (!intraday) return formatDateInTz(ms, tz);
	const iso = toIsoWithTz(ms, tz); // 'YYYY-MM-DDTHH:mm:ss'
	return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : null;
}

export function buildScanRange(candles: ReadonlyArray<{ isoTime?: string | null }> | undefined): ScanRange | undefined {
	if (!Array.isArray(candles) || candles.length === 0) return undefined;
	const start = candles[0]?.isoTime;
	const end = candles[candles.length - 1]?.isoTime;
	if (!start || !end) return undefined;
	return { start, end, bars: candles.length };
}

export function buildScanRangeLine(
	scan: ScanRange | undefined | null,
	type: string,
	tz: string = 'Asia/Tokyo',
): string {
	if (!scan) return '';
	// 解決できない tz でも「行ごと消える」を起こさない（消えると LLM がスキャン窓を確認できない）。
	const displayTz = resolveTz(tz);
	const intraday = isIntradayType(type);
	const start = formatScanBoundary(toTs(scan.start), displayTz, intraday);
	const end = formatScanBoundary(toTs(scan.end), displayTz, intraday);
	if (!start || !end) return '';
	const anchor = scan.anchorDate ? `、終端 date=${scan.anchorDate} 指定` : '';
	return `スキャン範囲: ${start} ~ ${end}（${scan.bars}本${anchor}）`;
}

export function buildPatternSpanLine(pats: ReadonlyArray<RangedPattern>, tz: string = 'Asia/Tokyo'): string {
	if (!Array.isArray(pats)) return '';
	const starts = pats.map((p) => toTs(p?.range?.start)).filter(Number.isFinite);
	const ends = pats.map((p) => toTs(p?.range?.end)).filter(Number.isFinite);
	if (!starts.length || !ends.length) return '';
	const minStart = Math.min(...starts);
	const maxEnd = Math.max(...ends);
	// 分布期間は intraday でも暦日のみで出す（従来の表示を維持）。
	const displayTz = resolveTz(tz);
	const start = formatDateInTz(minStart, displayTz) ?? '';
	const end = formatDateInTz(maxEnd, displayTz) ?? '';
	const days = Math.max(1, Math.round((maxEnd - minStart) / 86400000));
	return `検出パターン分布期間: ${start} ~ ${end}（${days}日間）`;
}

export function buildPeriodBlock(
	scan: ScanRange | undefined | null,
	type: string,
	pats: ReadonlyArray<RangedPattern>,
	tz: string = 'Asia/Tokyo',
): string {
	return [buildScanRangeLine(scan, type, tz), buildPatternSpanLine(pats, tz)].filter(Boolean).join('\n');
}
