/**
 * detectPatternsHandler のビュー別フォーマッタ
 * debug / summary / full / detailed の4モードを分離
 *
 * 表示日付の TZ:
 * - すべての日付表示は呼び出し側が渡す `tz` 引数で整形する（既定 'Asia/Tokyo'）。
 * - 構造化データ（PatternEntry.range / structureRange / precedingTrend / confirmation.date 等）は
 *   後方互換のため UTC ISO 文字列のまま不変。
 */
import { formatDateInTz } from '../../lib/datetime.js';
import { formatFixed, formatInt, formatPctFromRatio, formatRounded } from '../../lib/formatter.js';
import { toStructured } from '../../lib/result.js';
import type { PatternEntry } from '../../tools/patterns/types.js';
import type { McpResponse } from '../tool-definition.js';

/** デバッグスイング情報 */
interface SwingDebug {
	kind: string;
	idx: number;
	price: number;
	isoTime?: string;
}

/** デバッグ候補エントリ */
interface CandidateDebug {
	type: string;
	accepted: boolean;
	reason?: string;
	indices?: number[];
	points?: Array<{ role: string; idx: number; price: number }>;
	details?: Record<string, unknown>;
}

/** パターン検出メタデータ */
interface PatternMeta {
	debug?: {
		swings?: SwingDebug[];
		candidates?: CandidateDebug[];
	};
	effective_params?: { tolerancePct?: number };
	[key: string]: unknown;
}

/** パターン検出結果（res パラメータ用） */
interface PatternResult {
	ok?: boolean;
	data?: { patterns?: PatternEntry[]; overlays?: unknown };
	meta?: Record<string, unknown>;
	summary?: string;
	[key: string]: unknown;
}

/** fmtPointList 用のポイント */
interface IndexedPoint {
	index: number;
	price: number;
}

// ── helpers ──

const toTs = (s?: string): number => {
	try {
		return s ? Date.parse(s) : NaN;
	} catch {
		return NaN;
	}
};

const fmtPointList = (arr: unknown): string =>
	Array.isArray(arr) ? arr.map((p: IndexedPoint) => `[${p.index}:${formatRounded(p.price)}]`).join(', ') : 'n/a';

// ── shared ──

/**
 * 検出対象期間の1行テキスト
 * @param tz 表示 TZ（既定 'Asia/Tokyo'）。空文字 / 不正値は formatDateInTz が Asia/Tokyo にフォールバック。
 */
export function buildPeriodLine(pats: PatternEntry[], tz: string = 'Asia/Tokyo'): string {
	try {
		const ends = pats.map((p) => toTs(p?.range?.end)).filter(Number.isFinite);
		const starts = pats.map((p) => toTs(p?.range?.start)).filter(Number.isFinite);
		if (starts.length && ends.length) {
			const startDate = formatDateInTz(Math.min(...starts), tz) ?? '';
			const endDate = formatDateInTz(Math.max(...ends), tz) ?? '';
			const days = Math.max(1, Math.round((Math.max(...ends) - Math.min(...starts)) / 86400000));
			return `検出対象期間: ${startDate} ~ ${endDate}（${days}日間）`;
		}
	} catch {
		/* noop */
	}
	return '';
}

/**
 * 種別別件数集計
 * @param _tz 現状の集計ロジックでは TZ を使わないが、view formatter 群と signature を揃える。
 */
export function buildTypeSummary(pats: PatternEntry[], _tz: string = 'Asia/Tokyo'): string {
	const byType = pats.reduce(
		(m: Record<string, number>, p: PatternEntry) => {
			const k = String(p?.type || 'unknown');
			m[k] = (m[k] || 0) + 1;
			return m;
		},
		{} as Record<string, number>,
	);
	return Object.entries(byType)
		.map(([k, v]) => `${k}×${v}`)
		.join(', ');
}

// ── debug view: candidate details ──

function formatCandidateDetails(c: CandidateDebug): string {
	if (!c.details) return '\n   details: none';
	const d = c.details;
	const reason = String(c?.reason ?? '');

	if (reason === 'type_classification_failed') {
		return (
			`\n   failureReason: ${d?.failureReason || 'n/a'}` +
			`\n   slopes: hi=${formatFixed(d?.slopeHigh)} lo=${formatFixed(d?.slopeLow)}` +
			`\n   slopeRatio: ${Number.isFinite(Number(d?.slopeRatio)) ? Number(d.slopeRatio).toFixed(3) : 'n/a'}`
		);
	}

	if (reason === 'probe_window') {
		return (
			`\n   upper.slope: ${formatFixed(d?.slopeHigh)}` +
			`\n   lower.slope: ${formatFixed(d?.slopeLow)}` +
			`\n   priceRange: ${formatRounded(d?.priceRange)}` +
			`\n   barsSpan: ${formatInt(d?.barsSpan)}` +
			`\n   minMeaningfulSlope: ${formatFixed(d?.minMeaningfulSlope)}` +
			`\n   highsIn: ${fmtPointList(d?.highsIn)}` +
			`\n   lowsIn: ${fmtPointList(d?.lowsIn)}`
		);
	}

	if (reason === 'declining_highs' || reason === 'declining_highs_probe') {
		return (
			`\n   ${reason === 'declining_highs' ? 'declining_highs: true' : 'declining_highs_probe: metrics'}` +
			`\n   highsIn.count: ${formatInt(d?.highsCount)}` +
			`\n   1st half avg: ${formatRounded(d?.firstAvg)}` +
			`\n   2nd half avg: ${formatRounded(d?.secondAvg)}` +
			`\n   ratio: ${formatPctFromRatio(d?.ratio)}`
		);
	}

	if (reason === 'rising_probe') {
		return (
			`\n   r2: hi=${Number.isFinite(Number(d?.r2High)) ? Number(d.r2High).toFixed(3) : 'n/a'}, lo=${Number.isFinite(Number(d?.r2Low)) ? Number(d.r2Low).toFixed(3) : 'n/a'}` +
			`\n   slopes: hi=${Number.isFinite(Number(d?.slopeHigh)) ? Number(d.slopeHigh).toFixed(6) : 'n/a'} lo=${Number.isFinite(Number(d?.slopeLow)) ? Number(d.slopeLow).toFixed(6) : 'n/a'}` +
			`\n   slopeRatioLH: ${Number.isFinite(Number(d?.slopeRatioLH)) ? Number(d.slopeRatioLH).toFixed(3) : 'n/a'}` +
			`\n   priceRange: ${formatRounded(d?.priceRange)}, barsSpan: ${formatInt(d?.barsSpan)}` +
			`\n   minMeaningfulSlope: ${Number.isFinite(Number(d?.minMeaningfulSlope)) ? Number(d.minMeaningfulSlope).toFixed(6) : 'n/a'}` +
			`\n   highsIn: ${fmtPointList(d?.highsIn)}` +
			`\n   lowsIn: ${fmtPointList(d?.lowsIn)}` +
			`\n   declining_highs metrics: firstAvg=${formatRounded(d?.firstAvg)}, secondAvg=${formatRounded(d?.secondAvg)}, ratio=${formatPctFromRatio(d?.ratio)}`
		);
	}

	if (reason === 'post_filter_rising_highs_not_declining') {
		return (
			`\n   post_filter: rising highs not declining` +
			`\n   highsIn.count: ${formatInt(d?.highsCount)}` +
			`\n   1st half avg: ${formatRounded(d?.firstAvg)}` +
			`\n   2nd half avg: ${formatRounded(d?.secondAvg)}` +
			`\n   ratio: ${formatPctFromRatio(d?.ratio)}`
		);
	}

	if (reason === 'post_filter_falling_lows_not_rising') {
		return (
			`\n   post_filter: falling lows not rising` +
			`\n   lowsIn.count: ${formatInt(d?.lowsCount)}` +
			`\n   1st half avg: ${formatRounded(d?.firstAvg)}` +
			`\n   2nd half avg: ${formatRounded(d?.secondAvg)}` +
			`\n   ratio: ${formatPctFromRatio(d?.ratio)}`
		);
	}

	// default
	const s1 = Number(d.spreadStart);
	const s2 = Number(d.spreadEnd);
	const hi = Number(d.hiSlope);
	const lo = Number(d.loSlope);
	const spreadPart =
		Number.isFinite(s1) && Number.isFinite(s2)
			? `${Math.round(s1).toLocaleString('ja-JP')} → ${Math.round(s2).toLocaleString('ja-JP')}`
			: 'n/a';
	return `\n   spread: ${spreadPart}${Number.isFinite(hi) || Number.isFinite(lo) ? `, slopes: hi=${formatFixed(hi)} lo=${formatFixed(lo)}` : ''}`;
}

export function formatDebugView(
	hdr: string,
	meta: PatternMeta,
	_pats: PatternEntry[],
	res: PatternResult,
	tz: string = 'Asia/Tokyo',
): McpResponse {
	const swings: SwingDebug[] = Array.isArray(meta?.debug?.swings) ? meta.debug.swings : [];
	const cands: CandidateDebug[] = Array.isArray(meta?.debug?.candidates) ? meta.debug.candidates : [];

	const swingLines = swings.map((s) => {
		// swing は日付のみで十分（任意の足の高安特定が用途）。時刻表示が必要なら toIsoWithTz に変更する。
		const dateStr = s.isoTime ? (formatDateInTz(Date.parse(s.isoTime), tz) ?? 'n/a') : 'n/a';
		return `- ${s.kind} idx=${s.idx} price=${Math.round(Number(s.price)).toLocaleString('ja-JP')} (${dateStr})`;
	});

	const candLines = cands.map((c, i: number) => {
		const tag = c.accepted ? '✅' : '❌';
		const reason = c.accepted ? (c.reason ? ` (${c.reason})` : '') : c.reason ? ` [${c.reason}]` : '';
		const pts = Array.isArray(c.points)
			? c.points.map((p) => `${p.role}@${p.idx}:${Math.round(Number(p.price)).toLocaleString('ja-JP')}`).join(', ')
			: '';
		const indices = Array.isArray(c.indices) ? ` indices=[${c.indices.join(',')}]` : '';
		const detailsStr = formatCandidateDetails(c);
		return `${i + 1}. ${tag} ${c.type}${reason}${indices}${pts ? `\n   ${pts}` : ''}${detailsStr}`;
	});

	const text = [
		hdr,
		'',
		'【Swings】',
		swingLines.length ? swingLines.join('\n') : 'なし',
		'',
		'【Candidates】',
		candLines.length ? candLines.join('\n') : 'なし',
	].join('\n');

	try {
		return {
			content: [{ type: 'text', text }],
			structuredContent: {
				data: { ...res?.data, candidates: cands },
				meta: res?.meta ?? {},
				ok: res?.ok ?? true,
				summary: res?.summary ?? hdr,
			} as Record<string, unknown>,
		};
	} catch {
		return { content: [{ type: 'text', text }], structuredContent: toStructured(res) };
	}
}

// ── pattern line formatter (shared by full / detailed) ──

function buildIdxToIso(meta: PatternMeta): Record<number, string> {
	const map: Record<number, string> = {};
	try {
		const swings = meta?.debug?.swings;
		if (Array.isArray(swings)) {
			for (const s of swings) {
				const i = Number(s?.idx);
				const t = String(s?.isoTime || '');
				if (Number.isFinite(i) && t) map[i] = t;
			}
		}
	} catch {
		/* noop */
	}
	return map;
}

/**
 * UTC ISO 文字列を、指定 tz の暦日 YYYY-MM-DD として整形する。
 * 値が空 / parse 失敗時は 'n/a' を返す。
 */
function toDateOnly(iso: string | undefined, tz: string): string {
	if (!iso) return 'n/a';
	const ms = Date.parse(iso);
	return formatDateInTz(ms, tz) ?? 'n/a';
}

/**
 * structureRange / confirmation / precedingTrend が揃っている場合に
 * 文脈期間 / 形成期間 / ブレイク確認 / 先行トレンド の行を組み立てる。
 * いずれも未設定の場合は legacy「期間」行をフォールバックとして返す。
 */
function buildPeriodLines(p: PatternEntry, legacyRange: string, tz: string): string[] {
	const hasNew = !!(p?.structureRange || p?.confirmation || p?.precedingTrend);
	if (!hasNew) return [`   - 期間: ${legacyRange}`];

	const lines: string[] = [];

	const ctxStart = p.precedingTrend?.start ?? p.structureRange?.start ?? p.range?.start;
	const confirmedDate = p.confirmation?.type === 'neckline_breakout' ? p.confirmation.date : undefined;
	const ctxEnd = confirmedDate ?? p.structureRange?.end ?? p.range?.end;
	if (ctxStart && ctxEnd) {
		const suffix = confirmedDate
			? '（先行トレンド〜ブレイク確認日）'
			: p.precedingTrend
				? '（先行トレンド〜構成終了）'
				: '';
		lines.push(`   - 文脈期間: ${toDateOnly(ctxStart, tz)} ~ ${toDateOnly(ctxEnd, tz)}${suffix}`);
	}

	if (p.structureRange) {
		lines.push(
			`   - 形成期間: ${toDateOnly(p.structureRange.start, tz)} ~ ${toDateOnly(p.structureRange.end, tz)}（構成点）`,
		);
	}

	if (p.confirmation?.type === 'neckline_breakout') {
		const priceStr = Number.isFinite(p.confirmation.price)
			? `${Math.round(p.confirmation.price).toLocaleString('ja-JP')}円`
			: 'n/a';
		lines.push(`   - ブレイク確認: ${toDateOnly(p.confirmation.date, tz)}（${priceStr}）`);
	} else if (p.confirmation?.type === 'not_confirmed') {
		lines.push('   - ブレイク確認: なし（検出器ではネックライン突破を確認していません）');
	}

	if (p.precedingTrend) {
		const dirJa: Record<string, string> = {
			up: '上昇',
			down: '下降',
			sideways: '横ばい',
			insufficient_data: 'データ不足',
		};
		const t = p.precedingTrend;
		const sign = t.returnPct > 0 ? '+' : '';
		lines.push(
			`   - 先行トレンド: ${toDateOnly(t.start, tz)} ~ ${toDateOnly(t.end, tz)}（${dirJa[t.direction] || t.direction}、${sign}${t.returnPct}%、lookback=${t.lookbackBars}本）`,
		);
	}

	return lines.length > 0 ? lines : [`   - 期間: ${legacyRange}`];
}

export function formatPatternLine(
	p: PatternEntry,
	idx: number,
	view: string,
	meta: PatternMeta,
	tz: string = 'Asia/Tokyo',
): string {
	const name = String(p?.type || 'unknown');
	const conf = p?.confidence != null ? Number(p.confidence).toFixed(2) : 'n/a';
	// range.start/end は UTC ISO のまま構造化データに残す。表示のみ tz で整形する。
	const range = p?.range ? `${toDateOnly(p.range.start, tz)} ~ ${toDateOnly(p.range.end, tz)}` : 'n/a';
	const periodLines = buildPeriodLines(p, range, tz);

	// price range
	let priceRange: string | null = null;
	if (Array.isArray(p?.pivots) && p.pivots.length) {
		const prices = p.pivots.map((v) => Number(v?.price)).filter(Number.isFinite);
		if (prices.length)
			priceRange = `${Math.min(...prices).toLocaleString('ja-JP')}円 - ${Math.max(...prices).toLocaleString('ja-JP')}円`;
	}

	// neckline
	let neckline: string | null = null;
	if (Array.isArray(p?.neckline) && p.neckline.length === 2) {
		const [a, b] = p.neckline;
		const y1 = Number(a?.y),
			y2 = Number(b?.y);
		if (Number.isFinite(y1) && Number.isFinite(y2)) {
			neckline =
				y1 === y2
					? `${y1.toLocaleString('ja-JP')}円（水平）`
					: `${y1.toLocaleString('ja-JP')}円 → ${y2.toLocaleString('ja-JP')}円`;
		}
	}

	const idxToIso = buildIdxToIso(meta);

	// pivot detail lines (full/debug + double_top/double_bottom)
	const pivotLines: string[] = [];
	if ((view === 'full' || view === 'debug') && Array.isArray(p?.pivots) && p.pivots.length >= 3) {
		const pivs = p.pivots as Array<{ idx: number; price: number }>;
		const roleLabels =
			p.type === 'double_top' ? ['山1', '谷', '山2'] : p.type === 'double_bottom' ? ['谷1', '山', '谷2'] : null;
		if (roleLabels) {
			for (let i = 0; i < 3; i++) {
				const pv = pivs[i];
				if (!pv) continue;
				const d = idxToIso[Number(pv.idx)] || '';
				const date = toDateOnly(d || undefined, tz);
				pivotLines.push(`   - ${roleLabels[i]}: ${date} (${Math.round(Number(pv.price)).toLocaleString('ja-JP')}円)`);
			}
		}
	}

	// breakout
	let breakoutLine: string | null = null;
	try {
		if ((view === 'full' || view === 'debug') && p?.breakout?.idx != null) {
			const bidx = Number(p.breakout.idx);
			const bpx = Number(p.breakout.price);
			const bIso = idxToIso[bidx];
			const bdate = bIso ? toDateOnly(String(bIso), tz) : 'n/a';
			const bprice = Number.isFinite(bpx) ? Math.round(bpx).toLocaleString('ja-JP') : 'n/a';
			breakoutLine = `   - ブレイク: ${bdate} (${bprice}円)`;
		}
	} catch {
		/* ignore */
	}

	// status
	let statusLine: string | null = null;
	if (p?.status) {
		const statusJa: Record<string, string> = {
			completed: '完成（ブレイクアウト確認済み）',
			invalid: '無効（期待と逆方向にブレイク）',
			forming: '形成中',
			near_completion: 'ほぼ完成（apex接近）',
		};
		statusLine = `   - 状態: ${statusJa[p.status] || p.status}`;
	}

	// breakout direction & outcome
	let outcomeLine: string | null = null;
	try {
		if (p?.breakoutDirection && p?.outcome) {
			const directionJa = p.breakoutDirection === 'up' ? '上方' : '下方';
			const outcomeJa = p.outcome === 'success' ? '成功' : '失敗';
			const expectedDirMap: Record<string, string | undefined> = {
				falling_wedge: '上方',
				rising_wedge: '下方',
				triangle_ascending: '上方',
				triangle_descending: '下方',
				pennant: p.poleDirection === 'up' ? '上方' : p.poleDirection === 'down' ? '下方' : undefined,
			};
			const expectedDir = p.type ? expectedDirMap[p.type] : undefined;
			const meaningMap: Record<string, Record<string, string>> = {
				falling_wedge: { success: '強気転換', failure: '弱気継続' },
				rising_wedge: { success: '弱気転換', failure: '強気継続' },
				triangle_ascending: { success: '上方ブレイク（強気）', failure: '下方ブレイク（弱気転換）' },
				triangle_descending: { success: '下方ブレイク（弱気）', failure: '上方ブレイク（強気転換）' },
				pennant: {
					success: `トレンド継続（${p.poleDirection === 'up' ? '強気' : '弱気'}）`,
					failure: `ダマシ（${p.poleDirection === 'up' ? '弱気転換' : '強気転換'}）`,
				},
			};
			const meaning = (p.type && p.outcome ? meaningMap[p.type]?.[p.outcome] : undefined) || `${directionJa}ブレイク`;
			let dirLine = `   - ブレイク方向: ${directionJa}ブレイク`;
			if (expectedDir) dirLine += `（本来は${expectedDir}ブレイクが期待されるパターン）`;
			outcomeLine = `${dirLine}\n   - パターン結果: ${outcomeJa}（${meaning}）`;
		}
	} catch {
		/* ignore */
	}

	// pennant fields
	let pennantLine: string | null = null;
	try {
		if (p?.type === 'pennant') {
			const parts: string[] = [];
			if (p.poleDirection) parts.push(`フラッグポール方向: ${p.poleDirection === 'up' ? '上昇' : '下降'}`);
			if (p.priorTrendDirection)
				parts.push(
					`先行トレンド: ${p.priorTrendDirection === 'bullish' ? '強気（上昇トレンド）' : '弱気（下降トレンド）'}`,
				);
			if (p.flagpoleHeight != null)
				parts.push(`フラッグポール値幅: ${Math.round(Number(p.flagpoleHeight)).toLocaleString('ja-JP')}円`);
			if (p.retracementRatio != null) {
				const pctStr = (Number(p.retracementRatio) * 100).toFixed(0);
				parts.push(
					`戻し比率: ${pctStr}%${Number(p.retracementRatio) > 0.38 ? '（高め — トライアングル寄り）' : '（正常範囲）'}`,
				);
			}
			if (p.isTrendContinuation !== undefined)
				parts.push(`トレンド継続: ${p.isTrendContinuation ? 'はい（成功）' : 'いいえ（ダマシ）'}`);
			if (parts.length) pennantLine = parts.map((s) => `   - ${s}`).join('\n');
		}
	} catch {
		/* ignore */
	}

	// structure diagram
	let diagramBlock: string | null = null;
	try {
		if ((view === 'full' || view === 'detailed') && p?.structureDiagram?.svg) {
			const diagram = p.structureDiagram;
			const id = String(diagram?.artifact?.identifier || 'pattern-diagram');
			const title = String(diagram?.artifact?.title || 'パターン構造図');
			diagramBlock = [
				'--- Structure Diagram (SVG) ---',
				`identifier: ${id}`,
				`title: ${title}`,
				'type: image/svg+xml',
				'',
				String(diagram.svg),
			].join('\n');
		}
	} catch {
		/* noop */
	}

	// target price
	let targetLine: string | null = null;
	if (p?.breakoutTarget != null) {
		const methodJa: Record<string, string> = {
			flagpole_projection: 'フラッグポール値幅投影',
			pattern_height: 'パターン高さ投影',
			neckline_projection: 'ネックライン投影',
		};
		targetLine = `   - ターゲット価格: ${Math.round(Number(p.breakoutTarget)).toLocaleString('ja-JP')}円（${(p.targetMethod && methodJa[p.targetMethod]) || p.targetMethod}）`;
		if (p?.targetReachedPct != null) {
			targetLine += `\n   - ターゲット進捗: ${p.targetReachedPct}%${Number(p.targetReachedPct) >= 100 ? '（到達済み）' : ''}`;
		}
	}

	const lines = [
		`${idx + 1}. ${name} (パターン整合度: ${conf})`,
		...periodLines,
		statusLine,
		priceRange ? `   - 価格範囲: ${priceRange}` : null,
		...(pivotLines.length ? pivotLines : []),
		neckline ? `   - ${p?.trendlineLabel || 'ネックライン'}: ${neckline}` : null,
		breakoutLine,
		outcomeLine,
		targetLine,
		pennantLine,
		diagramBlock,
	].filter(Boolean);
	return lines.join('\n');
}

// ── summary view ──

export function formatSummaryView(
	hdr: string,
	pats: PatternEntry[],
	periodLine: string,
	typeSummary: string,
	patterns: string[] | undefined,
	includeForming: boolean | undefined,
	res: PatternResult,
	_tz: string = 'Asia/Tokyo',
): McpResponse {
	const now = Date.now();
	const within = (ms: number) =>
		pats.filter((p) => Number.isFinite(toTs(p?.range?.end)) && now - toTs(p.range!.end) <= ms).length;
	const in30 = within(30 * 86400000);
	const in90 = within(90 * 86400000);
	const formingHint = includeForming ? '' : '\n※形成中は includeForming=true を指定してください。';
	const text = `${hdr}（${typeSummary || '分類なし'}、直近30日: ${in30}件、直近90日: ${in90}件）\n${periodLine ? `${periodLine}\n` : ''}検討パターン: ${patterns?.length ? patterns.join(', ') : '既定セット'}${formingHint}\n詳細は structuredContent.data.patterns を参照。`;
	return { content: [{ type: 'text', text }], structuredContent: toStructured(res) };
}

// ── full view ──

export function formatFullView(
	hdr: string,
	pats: PatternEntry[],
	periodLine: string,
	typeSummary: string,
	meta: PatternMeta,
	res: PatternResult,
	tz: string = 'Asia/Tokyo',
): McpResponse {
	const body = pats.map((p, i) => formatPatternLine(p, i, 'full', meta, tz)).join('\n\n');
	const overlayNote = res?.data?.overlays
		? '\n\nチャート連携: structuredContent.data.overlays を render_chart_svg.overlays に渡すと注釈/範囲を描画できます。'
		: '';
	const trustNote =
		'\n\nパターン整合度について（形状一致度・対称性・期間から算出）:\n  0.8以上 = 理想的な形状（教科書的パターン）\n  0.7-0.8 = 標準的な形状（他指標と併用推奨）\n  0.6-0.7 = やや不明瞭（慎重に判断）\n  0.6未満 = 形状不十分';
	const text = `${hdr}（${typeSummary || '分類なし'}）\n${periodLine ? `${periodLine}\n` : ''}\n【検出パターン（全件）】\n${body}${overlayNote}${trustNote}`;
	return { content: [{ type: 'text', text }], structuredContent: toStructured(res) };
}

// ── detailed view (default) ──

export function formatDetailedView(
	hdr: string,
	pats: PatternEntry[],
	periodLine: string,
	typeSummary: string,
	meta: PatternMeta,
	tolerancePct: number | undefined,
	patterns: string[] | undefined,
	res: PatternResult,
	tz: string = 'Asia/Tokyo',
): McpResponse {
	const top = pats.slice(0, 5);
	const body = top.length ? top.map((p, i) => formatPatternLine(p, i, 'detailed', meta, tz)).join('\n\n') : '';

	let none = '';
	if (!top.length) {
		const resSummary = String(res?.summary ?? '');
		if (resSummary === 'insufficient data') {
			none = `\n${resSummary}`;
		} else {
			const effTol = meta?.effective_params?.tolerancePct ?? tolerancePct ?? 'default';
			none = `\nパターンは検出されませんでした（tolerancePct=${effTol}）。\n・検討パターン: ${patterns?.length ? patterns.join(', ') : '既定セット'}\n・必要に応じて tolerance を 0.03-0.06 に緩和してください`;
		}
	}

	const overlayNote = res?.data?.overlays
		? '\n\nチャート連携: structuredContent.data.overlays を render_chart_svg.overlays に渡すと注釈/範囲を描画できます。'
		: '';
	const trustNote =
		'\n\nパターン整合度について（形状一致度・対称性・期間から算出）:\n  0.8以上 = 理想的な形状（教科書的パターン）\n  0.7-0.8 = 標準的な形状（他指標と併用推奨）\n  0.6-0.7 = やや不明瞭（慎重に判断）\n  0.6未満 = 形状不十分';
	const usage = `\n\nusage_example:\n  step1: detect_patterns を実行\n  step2: structuredContent.data.overlays を取得\n  step3: render_chart_svg の overlays に渡す`;
	const text = `${hdr}（${typeSummary || '分類なし'}）\n${periodLine ? `${periodLine}\n` : ''}\n${top.length ? `【検出パターン】\n${body}` : ''}${none}${overlayNote}${trustNote}${usage}`;
	return {
		content: [{ type: 'text', text }],
		structuredContent: {
			...res,
			usage_example: {
				step1: 'detect_patterns を実行',
				step2: 'data.overlays を取得',
				step3: 'render_chart_svg の overlays に渡す',
			},
		},
	};
}
