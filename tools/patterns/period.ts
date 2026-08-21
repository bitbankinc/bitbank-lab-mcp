/**
 * detect_patterns の期間表示行ビルダー。
 *
 * content に出る 2 行は**まったく別の量**を指す。混同すると誤読が起きるので分けて出す:
 *
 * - **スキャン範囲** — 検出器に実際に渡した足のレンジ（先頭足 ~ 末尾足、本数）。
 * - **検出パターン分布期間** — 検出されたパターンの `range.start` 最小値 ~ `range.end` 最大値。
 *
 * 旧ラベル「検出対象期間」は後者を指していたが、名前はスキャン窓を指しているように読める。
 * そのせいで「1時間足で直近1日分がスキャンされていない」という誤読が実際に発生した
 * （分布期間の終端は最後に検出されたパターンの終わりであって、データの終端ではない）。
 *
 * 算出が `tools/detect_patterns.ts`（summary 用）と
 * `src/handlers/detectPatternsViewsHandler.ts`（view 用）に重複していたため、ここへ寄せている。
 */

import { formatDateInTz, toIsoWithTz } from '../../lib/datetime.js';

/** 検出器に渡した足のレンジ。`meta.scan` と同じ形で、start / end は UTC ISO 文字列。 */
export interface ScanRange {
	start: string;
	end: string;
	bars: number;
}

/** range を持つ最小形（PatternEntry / DeduplicablePattern 双方を受けられる）。 */
interface RangedPattern {
	range?: { start?: string; end?: string } | undefined;
}

/**
 * 日足未満（intraday）の時間足。
 * 暦日だけで表示すると足の位置が特定できず「直近◯時間がスキャンされていない」という
 * 誤読を招く（今回の誤読の直接原因）ため、これらは時刻まで表示する。
 */
const INTRADAY_TYPES = new Set(['1min', '5min', '15min', '30min', '1hour', '4hour', '8hour', '12hour']);

/** 時間足が日足未満（= スキャン範囲を時刻まで表示すべき）か。 */
export function isIntradayType(type: string): boolean {
	return INTRADAY_TYPES.has(type);
}

const toTs = (s?: string | null): number => (s ? Date.parse(s) : Number.NaN);

/** 空文字 / 未指定の tz は Asia/Tokyo にフォールバック（formatDateInTz と同じ規約）。 */
const effectiveTz = (tz: string): string => (typeof tz === 'string' && tz.length > 0 ? tz : 'Asia/Tokyo');

/**
 * スキャン範囲の境界 1 点の表示。
 * intraday は分まで（`YYYY-MM-DD HH:mm`）、日足以上は暦日のみ（`YYYY-MM-DD`）。
 */
function formatScanBoundary(ms: number, tz: string, intraday: boolean): string | null {
	if (!Number.isFinite(ms)) return null;
	if (!intraday) return formatDateInTz(ms, tz);
	const iso = toIsoWithTz(ms, effectiveTz(tz)); // 'YYYY-MM-DDTHH:mm:ss'
	return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : null;
}

/**
 * 検出器に渡した candles から `meta.scan` を組み立てる。
 * isoTime が欠けている（`get_candles` が付与しなかった）場合は undefined を返し、
 * 推測値を出さない。
 */
export function buildScanRange(candles: ReadonlyArray<{ isoTime?: string | null }> | undefined): ScanRange | undefined {
	if (!Array.isArray(candles) || candles.length === 0) return undefined;
	const start = candles[0]?.isoTime;
	const end = candles[candles.length - 1]?.isoTime;
	if (!start || !end) return undefined;
	return { start, end, bars: candles.length };
}

/**
 * 「スキャン範囲」1 行。検出器に渡した足の先頭・末尾・本数を出す。
 * @param type 時間足（intraday なら時刻まで表示する）
 * @param tz 表示 TZ（既定 'Asia/Tokyo'。空文字 / 不正値も Asia/Tokyo にフォールバック）
 */
export function buildScanRangeLine(
	scan: ScanRange | undefined | null,
	type: string,
	tz: string = 'Asia/Tokyo',
): string {
	if (!scan) return '';
	const intraday = isIntradayType(type);
	const start = formatScanBoundary(toTs(scan.start), tz, intraday);
	const end = formatScanBoundary(toTs(scan.end), tz, intraday);
	if (!start || !end) return '';
	return `スキャン範囲: ${start} ~ ${end}（${scan.bars}本）`;
}

/**
 * 「検出パターン分布期間」1 行。全パターンの range.start 最小 ~ range.end 最大。
 * **スキャン窓でも入力データ範囲でもない**（旧ラベル「検出対象期間」）。
 * @param tz 表示 TZ（既定 'Asia/Tokyo'）。空文字 / 不正値は formatDateInTz が Asia/Tokyo にフォールバック。
 */
export function buildPatternSpanLine(pats: ReadonlyArray<RangedPattern>, tz: string = 'Asia/Tokyo'): string {
	if (!Array.isArray(pats)) return '';
	const starts = pats.map((p) => toTs(p?.range?.start)).filter(Number.isFinite);
	const ends = pats.map((p) => toTs(p?.range?.end)).filter(Number.isFinite);
	if (!starts.length || !ends.length) return '';
	const minStart = Math.min(...starts);
	const maxEnd = Math.max(...ends);
	// 分布期間は暦日のみ（従来表示を維持）。構造化データは UTC ISO のまま。
	const start = formatDateInTz(minStart, tz) ?? '';
	const end = formatDateInTz(maxEnd, tz) ?? '';
	const days = Math.max(1, Math.round((maxEnd - minStart) / 86400000));
	return `検出パターン分布期間: ${start} ~ ${end}（${days}日間）`;
}

/**
 * スキャン範囲 ＋ 検出パターン分布期間の 2 行ブロック（該当行が無ければ詰める）。
 * 両方空なら空文字を返すので、呼び出し側は `block ? ... : ''` で改行を制御できる。
 */
export function buildPeriodBlock(
	scan: ScanRange | undefined | null,
	type: string,
	pats: ReadonlyArray<RangedPattern>,
	tz: string = 'Asia/Tokyo',
): string {
	return [buildScanRangeLine(scan, type, tz), buildPatternSpanLine(pats, tz)].filter(Boolean).join('\n');
}
