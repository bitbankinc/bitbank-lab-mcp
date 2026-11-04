import { formatFixed, formatInt, formatPctFromRatio, formatPriceDecimals, formatRounded } from '../../lib/formatter.js';
import { priceDecimals } from '../../lib/price.js';
import { toStructured } from '../../lib/result.js';
import type { PatternEntry } from '../../tools/patterns/types.js';
import type { McpResponse } from '../tool-definition.js';
import {
	buildReductionLine,
	byKeyAsc,
	type CandidateDebug,
	formatTrimNote,
	type PatternMeta,
	type PatternResult,
	resolveTrimCounts,
	type SwingDebug,
	toDateOrTime,
} from './detectPatternsViewsHandler.js';

interface IndexedPoint {
	index: number;
	price: number;
}

const fmtPointList = (fmtPrice: (v: unknown) => string, arr: unknown): string =>
	Array.isArray(arr) ? arr.map((p: IndexedPoint) => `[${p.index}:${fmtPrice(p.price)}]`).join(', ') : 'n/a';

const GENERIC_DETAILS_MAX_FIELDS = 16;
const GENERIC_DETAILS_MAX_JSON = 160;

function formatCandidateDetails(c: CandidateDebug, fmtPrice: (v: unknown) => string): string {
	if (!c.details) return '\n   details: none';
	const d: Record<string, unknown> = c.details;
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
			`\n   priceRange: ${fmtPrice(d?.priceRange)}` +
			`\n   barsSpan: ${formatInt(d?.barsSpan)}` +
			`\n   minMeaningfulSlope: ${formatFixed(d?.minMeaningfulSlope)}` +
			`\n   highsIn: ${fmtPointList(fmtPrice, d?.highsIn)}` +
			`\n   lowsIn: ${fmtPointList(fmtPrice, d?.lowsIn)}`
		);
	}

	if (reason === 'declining_highs' || reason === 'declining_highs_probe') {
		return (
			`\n   ${reason === 'declining_highs' ? 'declining_highs: true' : 'declining_highs_probe: metrics'}` +
			`\n   highsIn.count: ${formatInt(d?.highsCount)}` +
			`\n   1st half avg: ${fmtPrice(d?.firstAvg)}` +
			`\n   2nd half avg: ${fmtPrice(d?.secondAvg)}` +
			`\n   ratio: ${formatPctFromRatio(d?.ratio)}`
		);
	}

	if (reason === 'rising_probe') {
		return (
			`\n   r2: hi=${Number.isFinite(Number(d?.r2High)) ? Number(d.r2High).toFixed(3) : 'n/a'}, lo=${Number.isFinite(Number(d?.r2Low)) ? Number(d.r2Low).toFixed(3) : 'n/a'}` +
			`\n   slopes: hi=${Number.isFinite(Number(d?.slopeHigh)) ? Number(d.slopeHigh).toFixed(6) : 'n/a'} lo=${Number.isFinite(Number(d?.slopeLow)) ? Number(d.slopeLow).toFixed(6) : 'n/a'}` +
			`\n   slopeRatioLH: ${Number.isFinite(Number(d?.slopeRatioLH)) ? Number(d.slopeRatioLH).toFixed(3) : 'n/a'}` +
			`\n   priceRange: ${fmtPrice(d?.priceRange)}, barsSpan: ${formatInt(d?.barsSpan)}` +
			`\n   minMeaningfulSlope: ${Number.isFinite(Number(d?.minMeaningfulSlope)) ? Number(d.minMeaningfulSlope).toFixed(6) : 'n/a'}` +
			`\n   highsIn: ${fmtPointList(fmtPrice, d?.highsIn)}` +
			`\n   lowsIn: ${fmtPointList(fmtPrice, d?.lowsIn)}` +
			`\n   declining_highs metrics: firstAvg=${fmtPrice(d?.firstAvg)}, secondAvg=${fmtPrice(d?.secondAvg)}, ratio=${formatPctFromRatio(d?.ratio)}`
		);
	}

	if (reason === 'post_filter_rising_highs_not_declining') {
		return (
			`\n   post_filter: rising highs not declining` +
			`\n   highsIn.count: ${formatInt(d?.highsCount)}` +
			`\n   1st half avg: ${fmtPrice(d?.firstAvg)}` +
			`\n   2nd half avg: ${fmtPrice(d?.secondAvg)}` +
			`\n   ratio: ${formatPctFromRatio(d?.ratio)}`
		);
	}

	if (reason === 'post_filter_falling_lows_not_rising') {
		return (
			`\n   post_filter: falling lows not rising` +
			`\n   lowsIn.count: ${formatInt(d?.lowsCount)}` +
			`\n   1st half avg: ${fmtPrice(d?.firstAvg)}` +
			`\n   2nd half avg: ${fmtPrice(d?.secondAvg)}` +
			`\n   ratio: ${formatPctFromRatio(d?.ratio)}`
		);
	}

	const flagReasons = new Set([
		'detected',
		'classification_failed',
		'spread_invalid',
		'broadening_channel',
		'spread_unstable',
		'slope_same_as_pole',
		'symmetric_convergence',
		'parallel_counter_trend',
		'insufficient_consolidation_swings',
		'trendline_span_too_short',
		'poor_trendline_fit',
		'consolidation_too_wide',
		'dedup_summary',
	]);
	if (flagReasons.has(reason)) {
		const lines: string[] = [];
		if (d?.poleATRMult != null || d?.polePerBarImpulse != null || d?.poleChangePct != null) {
			const poleAtr = d?.poleATRMult != null ? Number(d.poleATRMult).toFixed(2) : 'n/a';
			const poleImpulse = d?.polePerBarImpulse != null ? Number(d.polePerBarImpulse).toFixed(2) : 'n/a';
			const polePct = d?.poleChangePct != null ? `${(Number(d.poleChangePct) * 100).toFixed(1)}%` : 'n/a';
			const poleBars = d?.poleBars != null ? `${formatInt(d.poleBars)}本` : 'n/a';
			const poleDir = d?.poleDirection ? `(${d.poleDirection})` : '';
			lines.push(
				`   pole: atrMult=${poleAtr}, perBarImpulse=${poleImpulse}, change=${polePct}, bars=${poleBars} ${poleDir}`,
			);
		}
		if (d?.spreadAvg != null || d?.spreadStability != null || d?.spreadStart != null) {
			const spAvg = d?.spreadAvg != null ? fmtPrice(d.spreadAvg) : 'n/a';
			const spStab = d?.spreadStability != null ? `${(Number(d.spreadStability) * 100).toFixed(0)}%` : 'n/a';
			const spStart = d?.spreadStart != null ? fmtPrice(d.spreadStart) : null;
			const spEnd = d?.spreadEnd != null ? fmtPrice(d.spreadEnd) : null;
			const seg = spStart && spEnd ? `, start→end=${spStart}→${spEnd}` : '';
			lines.push(`   spread: avg=${spAvg}, stability=${spStab}${seg}`);
		}
		if (d?.upperSlope != null || d?.lowerSlope != null) {
			const us = d?.upperSlope != null ? Number(d.upperSlope).toFixed(4) : 'n/a';
			const ls = d?.lowerSlope != null ? Number(d.lowerSlope).toFixed(4) : 'n/a';
			const conv = d?.convergenceRatio != null ? Number(d.convergenceRatio).toFixed(3) : 'n/a';
			lines.push(`   slopes: upper=${us}, lower=${ls}, convergenceRatio=${conv}`);
		}
		if (d?.r2Upper != null || d?.r2Lower != null) {
			const r2U = d?.r2Upper != null ? Number(d.r2Upper).toFixed(3) : 'n/a';
			const r2L = d?.r2Lower != null ? Number(d.r2Lower).toFixed(3) : 'n/a';
			lines.push(`   r2: upper=${r2U}, lower=${r2L}`);
		}
		if (d?.expectedBreakoutDirection) {
			lines.push(`   expectedBreakoutDirection: ${d.expectedBreakoutDirection}`);
		}
		if (reason === 'dedup_summary') {
			lines.push(
				`   dedup: before=${formatInt(d?.beforeDedup)}, after=${formatInt(d?.afterDedup)}, removed=${formatInt(d?.removed)}`,
			);
		}
		if (reason === 'insufficient_consolidation_swings' && (d?.highs != null || d?.lows != null)) {
			lines.push(`   swings: highs=${formatInt(d?.highs)}, lows=${formatInt(d?.lows)}`);
		}
		if (reason === 'trendline_span_too_short') {
			lines.push(
				`   spans: upper=${formatInt(d?.upperSpan)}/${formatInt(d?.consZoneWidth)} (${(Number(d?.upperRatio) * 100).toFixed(0)}%), lower=${formatInt(d?.lowerSpan)}/${formatInt(d?.consZoneWidth)} (${(Number(d?.lowerRatio) * 100).toFixed(0)}%), minRatio=${(Number(d?.minSpanRatio) * 100).toFixed(0)}%`,
			);
		}
		if (reason === 'consolidation_too_wide') {
			lines.push(
				`   geometry: consRange=${fmtPrice(d?.consRange)}, poleRange=${fmtPrice(d?.poleRange)}, ratio=${(Number(d?.ratio) * 100).toFixed(0)}%`,
			);
		}
		if (reason === 'detected' && d?.touchCount != null) {
			// status はここで出さない。置き場所ごとに別行が出ると同じ事実が 2 通りの書式で散るので、candLines の 1 箇所でヘッダ行へ出す（#160）。
			lines.push(`   touchCount: ${formatInt(d.touchCount)}, confidence: ${d?.confidence ?? 'n/a'}`);
		}
		return lines.length > 0 ? `\n${lines.join('\n')}` : '\n   details: (no fields)';
	}

	// details に入っている診断値をそのまま列挙する。決め打ちのフィールド名（spreadStart 等）は default に来る検出器に存在しない。
	return formatGenericDetails(d);
}

function formatGenericDetails(d: Record<string, unknown>): string {
	const entries = Object.entries(d).filter(([, v]) => v != null);
	if (entries.length === 0) return '\n   details: (no fields)';
	const shown = entries.slice(0, GENERIC_DETAILS_MAX_FIELDS);
	const lines = shown.map(([k, v]) => `   ${k}: ${formatDetailValue(v)}`);
	if (entries.length > shown.length) {
		lines.push(`   … 他 ${entries.length - shown.length} フィールド（structuredContent.data.candidates 参照）`);
	}
	return `\n${lines.join('\n')}`;
}

function formatDetailValue(v: unknown): string {
	if (typeof v === 'number') {
		if (!Number.isFinite(v)) return String(v);
		if (Number.isInteger(v)) return String(v);
		// 価格帯の値（数百万円）を toFixed(6) で出すと読めないので、大きい値だけ丸める。
		return Math.abs(v) >= 1000 ? formatRounded(v) : String(Number(v.toFixed(6)));
	}
	if (typeof v === 'string' || typeof v === 'boolean') return String(v);
	try {
		const json = JSON.stringify(v);
		if (typeof json !== 'string') return String(v);
		return json.length > GENERIC_DETAILS_MAX_JSON ? `${json.slice(0, GENERIC_DETAILS_MAX_JSON)}…` : json;
	} catch {
		return String(v);
	}
}

// キーが在れば値が null でも次の系統へフォールバックしない。畳むと「未ブレイクなのに方向がある」行が出る。
function breakDirectionFromDetails(details?: Record<string, unknown>): string | null | undefined {
	if (!details) return undefined;
	for (const key of ['breakout', 'breakInfo'] as const) {
		if (!(key in details)) continue;
		return (details[key] as { direction?: string | null } | null | undefined)?.direction ?? null;
	}
	return undefined;
}

/** tests/detectPatternsViewsHandler.test.ts / tests/view-content-superset.test.ts が抽出に使うので、変えるならテスト側も直す。 */
export const CANDIDATE_BREAKDOWN_LABEL = '▼ 候補の内訳';
export const REJECTION_SUMMARY_LABEL = '▼ 棄却理由の内訳';
/** REJECTION_SUMMARY_LABEL と接頭辞が重ならない語にしてある（テストが startsWith で 2 つの見出しを抽出する）。 */
export const REJECTION_CROSS_TOTAL_LABEL = '▼ reason 横断合計';

/** 超過分は残余行 1 本に畳み、合計は必ず一致させる。 */
const REJECTION_SUMMARY_MAX_TYPES = 20;
/** type 行と横断合計行の両方に同じ上限を掛ける。 */
const REJECTION_SUMMARY_MAX_REASONS = 10;

// type:reason の 2 軸で数え、reason 単独の横断合計を足す。出さないと LLM が手集計して外す（#191, #193）。
function formatRejectionSummary(cands: CandidateDebug[], total?: number, omitted?: number): string[] {
	if (cands.length === 0) return [];
	const accepted = cands.filter((c) => c.accepted).length;
	const rejected = cands.length - accepted;
	const trim = resolveTrimCounts(cands.length, total, omitted);
	const censored = !!trim && trim.dropped > 0;

	const scope = !trim
		? `受け取った ${formatInt(cands.length)} 件`
		: censored
			? `表示 ${formatInt(cands.length)} 件`
			: `全 ${formatInt(cands.length)} 件`;
	const scopeNote = !trim
		? '（総数の申告が無いため cap 省略の有無は不明。この集計は受け取った分のみ）'
		: censored
			? `（全 ${formatInt(trim.total)} 件のうち ${formatInt(trim.dropped)} 件は cap で省略されており、**この集計に入っていない**）`
			: '（cap 省略なし＝全候補の内訳）';
	const lines = [
		`${CANDIDATE_BREAKDOWN_LABEL}: ${scope} = accepted ${formatInt(accepted)} 件 + rejected ${formatInt(rejected)} 件${scopeNote}`,
	];

	if (rejected === 0) {
		// 「棄却が 0 件」と「集計を出していない」を区別できるように、行ごと落とさず明示する。
		lines.push(`${REJECTION_SUMMARY_LABEL}: なし（rejected 0 件）`);
		return lines;
	}

	const byType = new Map<string, { count: number; reasons: Map<string, number> }>();
	// type 行とは独立に全 rejected から数えるので、type 行が残余に畳まれても横断合計は rejected と一致し続ける。
	const byReason = new Map<string, number>();
	for (const c of cands) {
		if (c.accepted) continue;
		const type = String(c.type || 'unknown');
		// 理由なしの棄却も数から落とさない（落とすと行の合計が rejected と合わなくなる）。
		const reason = c.reason ? String(c.reason) : '(reason なし)';
		const entry = byType.get(type) ?? { count: 0, reasons: new Map<string, number>() };
		entry.count += 1;
		entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + 1);
		byType.set(type, entry);
		byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
	}
	const sortedTypes = [...byType.entries()].sort((a, b) => b[1].count - a[1].count || byKeyAsc(a[0], b[0]));
	const shownTypes = sortedTypes.slice(0, REJECTION_SUMMARY_MAX_TYPES);
	const restTypes = sortedTypes.slice(REJECTION_SUMMARY_MAX_TYPES);

	lines.push(
		`${REJECTION_SUMMARY_LABEL}（type 別 → reason 別。合計は上の rejected ${formatInt(rejected)} 件と一致する${
			censored ? `。**全 ${formatInt(trim.total)} 件の内訳ではない**` : ''
		}）`,
	);
	for (const [type, entry] of shownTypes) {
		lines.push(`   - ${type} ${formatInt(entry.count)} 件: ${formatReasonParts(entry.reasons)}`);
	}
	if (restTypes.length > 0) {
		const restCount = restTypes.reduce((sum, [, entry]) => sum + entry.count, 0);
		lines.push(`   - （他 ${formatInt(restTypes.length)} 種別）${formatInt(restCount)} 件`);
	}

	// type が 1 種別しかないときは出さない（type 行がそのまま横断合計になる）。
	if (byType.size > 1) {
		lines.push(
			`${REJECTION_CROSS_TOTAL_LABEL}（type を跨いで reason だけで合算。同じ reason でも type ごとに意味が違いうるので帰属は上の type 別行で見る。合計は上の rejected ${formatInt(
				rejected,
			)} 件と一致する${censored ? `。**全 ${formatInt(trim.total)} 件の内訳ではない**` : ''}）`,
		);
		lines.push(`   - ${formatReasonParts(byReason)}`);
	}
	return lines;
}

// type 行と横断合計行で共有する。畳み方が 2 通りあると、どちらかだけ合計が合わなくなる。
function formatReasonParts(reasons: ReadonlyMap<string, number>): string {
	const sorted = [...reasons.entries()].sort((a, b) => b[1] - a[1] || byKeyAsc(a[0], b[0]));
	const parts = sorted.slice(0, REJECTION_SUMMARY_MAX_REASONS).map(([reason, n]) => `${reason} ${formatInt(n)}`);
	const rest = sorted.slice(REJECTION_SUMMARY_MAX_REASONS);
	if (rest.length > 0) {
		const restCount = rest.reduce((sum, [, n]) => sum + n, 0);
		parts.push(`他 ${formatInt(rest.length)} 種 ${formatInt(restCount)}`);
	}
	return parts.join(' / ');
}

export function formatDebugView(
	hdr: string,
	meta: PatternMeta,
	_pats: PatternEntry[],
	res: PatternResult,
	tz: string = 'Asia/Tokyo',
	// 新しい表示行は末尾に足す。positional 呼び出しがテストだけで 30 箇所超あり、先頭寄りに入れると黙ってずれる。
	effectiveParamsLine: string = '',
	type: string = '1day',
): McpResponse {
	const swings: SwingDebug[] = Array.isArray(meta?.debug?.swings) ? meta.debug.swings : [];
	const cands: CandidateDebug[] = Array.isArray(meta?.debug?.candidates) ? meta.debug.candidates : [];
	const reductionLine = buildReductionLine(meta);

	// スイングと候補の点は同じペアの価格なので、最大のものの水準で桁をそろえる。
	const priceLevel = [
		...swings.map((s) => s.price),
		...cands.flatMap((c) => (Array.isArray(c.points) ? c.points.map((p) => p.price) : [])),
	].reduce((max: number, v) => {
		const n = Math.abs(Number(v));
		return Number.isFinite(n) && n > max ? n : max;
	}, 0);
	const decimals = priceDecimals(priceLevel);
	const yen = (v: unknown) => formatPriceDecimals(Number(v), decimals);
	const detailPrice = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? 'n/a' : yen(v));

	const swingLines = swings.map((s) => {
		// intraday では時刻まで出す（#200）。1hour 等は 24 本が同じ日付ラベルに潰れる。
		const dateStr = s.isoTime ? toDateOrTime(s.isoTime, tz, type) : 'n/a';
		return `- ${s.kind} idx=${s.idx} price=${yen(s.price)} (${dateStr})`;
	});

	const candLines = cands.map((c, i: number) => {
		const tag = c.accepted ? '✅' : '❌';
		const reason = c.accepted ? (c.reason ? ` (${c.reason})` : '') : c.reason ? ` [${c.reason}]` : '';
		// ここが status / breakoutDirection の唯一の解決点（formatCandidateDetails 側では出さない）。
		const status = c.status ?? (c.details?.status as string | undefined);
		// null は「未ブレイクと判定した」という答えなので、?? ではなくキーの有無だけで分岐する。
		const dir = c.breakoutDirection !== undefined ? c.breakoutDirection : breakDirectionFromDetails(c.details);
		const statusStr = status ? ` status=${status}` : '';
		// 方向が無いときは null と書いても情報が増えないので行ごと出さない。
		const dirStr = dir ? ` breakoutDirection=${dir}` : '';
		const pts = Array.isArray(c.points) ? c.points.map((p) => `${p.role}@${p.idx}:${yen(p.price)}`).join(', ') : '';
		const indices = Array.isArray(c.indices) ? ` indices=[${c.indices.join(',')}]` : '';
		const detailsStr = formatCandidateDetails(c, detailPrice);
		return `${i + 1}. ${tag} ${c.type}${reason}${statusStr}${dirStr}${indices}${pts ? `\n   ${pts}` : ''}${detailsStr}`;
	});

	// swings は先頭から残すので落ちるのは直近側で、candidates とは落ちる側が逆になる（#180）。
	const swingsNote = formatTrimNote(
		swings.length,
		meta?.debug?.swingsTotal,
		meta?.debug?.swingsOmitted,
		'先頭から残すため省略分はすべて直近側のスイング',
	);
	// accepted が cap を超えると accepted も押し出されるので、返した配列に rejected が残っているかで文言を分ける（過小申告はするが嘘はつかない）。
	const keptHasRejected = cands.some((c) => !c.accepted);
	const candsNote = formatTrimNote(
		cands.length,
		meta?.debug?.candidatesTotal,
		meta?.debug?.candidatesOmitted,
		keptHasRejected
			? 'accepted は全件残っているため省略分はすべて棄却理由'
			: 'accepted が cap を埋めており省略分に accepted も含まれうる',
	);

	const text = [
		hdr,
		// 階梯外の view だが、診断が目的である以上ここでこそ実効値が要る（#184 決定事項 3）。
		...(effectiveParamsLine ? [effectiveParamsLine] : []),
		...(reductionLine ? [reductionLine] : []),
		'',
		`【Swings】${swingsNote}`,
		swingLines.length ? swingLines.join('\n') : 'なし',
		'',
		`【Candidates】${candsNote}`,
		// 列挙より前に置く。長いリストを読み切る前に全体像が要る。
		...formatRejectionSummary(cands, meta?.debug?.candidatesTotal, meta?.debug?.candidatesOmitted),
		// ✅ の status は候補を組み立てた時点のもので、その後 invalid / expired になったかは candidates からは分からない。
		'❌ = 候補段階の棄却（status なし。理由は [reason]。includeInvalid では拾えない）',
		'✅ の status = 候補を組み立てた時点の状態。成立後に invalid/expired になったかは data.patterns 側で見る',
		candLines.length
			? candLines.join('\n')
			: // 候補ゼロは「この窓でどの検出器も候補を組めなかった」の意。
				'なし（この窓では要求種別の候補が 1 つも組まれていない。candidates は入力 patterns で絞り込まれる）',
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
