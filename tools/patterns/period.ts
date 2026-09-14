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

import { formatDateInTz, isIntradayType, resolveTz, toIsoWithTz } from '../../lib/datetime.js';

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
 * 時間足が日足未満（= スキャン範囲を時刻まで表示すべき）か。
 *
 * 実体は `lib/datetime.ts`（issue #233 で移動）。構造図（`lib/pattern-diagrams.ts`）からも
 * 必要になり、`lib/` → `tools/` の逆方向依存を避けるため。既存の import パス
 * （`from '../../tools/patterns/period.js'`）を壊さないよう、ここから re-export する。
 */
export { isIntradayType } from '../../lib/datetime.js';

const toTs = (s?: string | null): number => (s ? Date.parse(s) : Number.NaN);

/**
 * スキャン範囲の境界 1 点の表示。
 * intraday は分まで（`YYYY-MM-DD HH:mm`）、日足以上は暦日のみ（`YYYY-MM-DD`）。
 * @param tz `resolveTz` 済みであること（未解決の tz を渡すと行が消える）。
 */
function formatScanBoundary(ms: number, tz: string, intraday: boolean): string | null {
	if (!Number.isFinite(ms)) return null;
	if (!intraday) return formatDateInTz(ms, tz);
	const iso = toIsoWithTz(ms, tz); // 'YYYY-MM-DDTHH:mm:ss'
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
 * @param tz 表示 TZ（既定 'Asia/Tokyo'）。空文字・解決できない IANA 名は Asia/Tokyo にフォールバック
 */
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
	return `スキャン範囲: ${start} ~ ${end}（${scan.bars}本）`;
}

/**
 * 「検出パターン分布期間」1 行。全パターンの range.start 最小 ~ range.end 最大。
 * **スキャン窓でも入力データ範囲でもない**（旧ラベル「検出対象期間」）。
 * @param tz 表示 TZ（既定 'Asia/Tokyo'）。空文字・解決できない IANA 名は Asia/Tokyo にフォールバック。
 */
export function buildPatternSpanLine(pats: ReadonlyArray<RangedPattern>, tz: string = 'Asia/Tokyo'): string {
	if (!Array.isArray(pats)) return '';
	const starts = pats.map((p) => toTs(p?.range?.start)).filter(Number.isFinite);
	const ends = pats.map((p) => toTs(p?.range?.end)).filter(Number.isFinite);
	if (!starts.length || !ends.length) return '';
	const minStart = Math.min(...starts);
	const maxEnd = Math.max(...ends);
	// 分布期間は暦日のみ（従来表示を維持）。構造化データは UTC ISO のまま。
	// 解決できない tz は Asia/Tokyo に畳む——畳まないと日付だけ空文字の行が出る。
	const displayTz = resolveTz(tz);
	const start = formatDateInTz(minStart, displayTz) ?? '';
	const end = formatDateInTz(maxEnd, displayTz) ?? '';
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
