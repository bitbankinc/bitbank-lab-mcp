// 構造化データ（range / confirmation.date 等）の日付は後方互換のため UTC ISO のまま。表示だけを tz で整形する。
import { formatDateOrTimeInTz } from '../../lib/datetime.js';
import { formatInt, formatPctFromRatio, formatPriceDecimals } from '../../lib/formatter.js';
import { toStructured } from '../../lib/result.js';
import { CONFIDENCE_NOTE, formatScoreBreakdownLines } from '../../tools/patterns/confidence-text.js';
import { patternPriceDecimals } from '../../tools/patterns/helpers.js';
import { BREAKOUT_AGAINST_EXPECTATION, levelSpreadMetrics } from '../../tools/patterns/structural.js';
import { formatStructureGateSkipLine, formatTriplePositionLines } from '../../tools/patterns/structure-diagnostics.js';
import type { Pivot } from '../../tools/patterns/swing.js';
import { formatTargetProgressLine } from '../../tools/patterns/target-reach.js';
import type { PatternEntry } from '../../tools/patterns/types.js';
import type { McpResponse } from '../tool-definition.js';

export interface SwingDebug {
	kind: string;
	idx: number;
	price: number;
	isoTime?: string;
}

/** status / breakoutDirection の置き場所は検出器によって top-level と details 配下に割れているので、読む側（candLines）で 1 回だけ解決する（#160）。 */
export interface CandidateDebug {
	type: string;
	accepted: boolean;
	reason?: string;
	status?: string;
	breakoutDirection?: string | null;
	indices?: number[];
	points?: Array<{ role: string; idx: number; price: number }>;
	details?: Record<string, unknown>;
}

export interface PatternMeta {
	debug?: {
		swings?: SwingDebug[];
		candidates?: CandidateDebug[];
		/** 欠損は「トリムが無かった」ではなく「件数が分からない」なので、表示側では行ごと落とす（#180）。 */
		candidatesTotal?: number;
		candidatesOmitted?: number;
		swingsTotal?: number;
		swingsOmitted?: number;
	};
	effective_params?: EffectiveParams;
	reduction?: ReductionCounts;
	[key: string]: unknown;
}

/** src/schema/patterns.ts の ReductionSchema と対。 */
interface ReductionCounts {
	detected: number;
	reversalHistoryExcluded?: number;
	dedupMerged: number;
	currentFiltered: number;
	lifecycleExcluded: number;
	/** 減るのは triple_* だけ（#218）。 */
	tripleHsExcluded: number;
	/** 0 なら tripleHsExcluded の 0 は「比較対象が無かった」の意味。waterfall の等式には入らない（#224）。 */
	tripleHsCandidateCount: number;
	output: number;
}

/** src/schema/patterns.ts の EffectiveParamsSchema と対。 */
interface EffectiveParam {
	value: number;
	source: 'auto' | 'explicit';
}

/** 入力値ではなく解決後の実効値（#182 の sentinel 置換適用済み）。 */
interface EffectiveParams {
	swingDepth?: EffectiveParam;
	minBarsBetweenSwings?: EffectiveParam;
	tolerancePct?: EffectiveParam;
	headProminencePct?: EffectiveParam;
}

export interface PatternResult {
	ok?: boolean;
	data?: { patterns?: PatternEntry[]; overlays?: unknown };
	meta?: Record<string, unknown>;
	summary?: string;
	[key: string]: unknown;
}

const toTs = (s?: string): number => {
	try {
		return s ? Date.parse(s) : NaN;
	} catch {
		return NaN;
	}
};

/** キーの昇順比較。`localeCompare` は ICU の有無で並びが揺れるので使わない（並びはテストで固定する）。 */
export const byKeyAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function buildTypeSummary(pats: PatternEntry[]): string {
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

/** tests/view-content-superset.test.ts が定型要素の抽出に使うので、変えるなら向こうも直す。 */
export const EFFECTIVE_PARAMS_LABEL = '実効パラメータ（入力値ではない）';

/** schema / meta の宣言順と揃える。 */
const EFFECTIVE_PARAM_ORDER = ['swingDepth', 'minBarsBetweenSwings', 'tolerancePct', 'headProminencePct'] as const;

// 常に出す（行が無いことを LLM に推論させない）。effective_params が無ければ空文字を返し、入力値で代用しない（#184）。
export function buildEffectiveParamsLine(meta: PatternMeta | undefined, type: string): string {
	const eff = meta?.effective_params;
	if (!eff) return '';
	const parts: string[] = [];
	let hasAuto = false;
	for (const key of EFFECTIVE_PARAM_ORDER) {
		const entry = eff[key];
		if (!entry || !Number.isFinite(entry.value)) continue;
		const auto = entry.source !== 'explicit';
		if (auto) hasAuto = true;
		parts.push(`${key}=${entry.value}(${auto ? 'auto' : '指定'})`);
	}
	if (parts.length === 0) return '';
	// auto が 1 つも無い呼び出しでは置換が起きていないので注記ごと落とす。
	const note = hasAuto ? ` ※auto=${type} の時間軸オート値（スキーマ既定値 7/5/0.04 の明示指定も auto）` : '';
	return `${EFFECTIVE_PARAMS_LABEL}: ${parts.join(' / ')}${note}`;
}

export const DETECTION_ROUTE_LABEL = '検出経路';

// relaxed が 0 件でも行を出す。行が無いことを「relaxed なし」と LLM に推論させない（#191）。
export function buildDetectionRouteLine(pats: PatternEntry[]): string {
	if (!Array.isArray(pats) || pats.length === 0) return '';
	const byTag = new Map<string, number>();
	for (const p of pats) {
		const tag = typeof p?._fallback === 'string' ? p._fallback.trim() : '';
		if (!tag) continue;
		byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
	}
	const relaxed = [...byTag.values()].reduce((sum, n) => sum + n, 0);
	if (relaxed === 0) {
		return `${DETECTION_ROUTE_LABEL}: 全 ${formatInt(pats.length)} 件とも strict（relaxed フォールバック由来は 0 件）`;
	}
	const breakdown = [...byTag.entries()]
		.sort((a, b) => b[1] - a[1] || byKeyAsc(a[0], b[0]))
		.map(([tag, n]) => `${tag}×${formatInt(n)}`)
		.join(', ');
	return (
		`${DETECTION_ROUTE_LABEL}: strict ${formatInt(pats.length - relaxed)} 件 / relaxed フォールバック由来 ${formatInt(relaxed)} 件` +
		`（${breakdown}）※該当パターンは見出し行の末尾に同じ値が [ ] 付きで出る（summary はパターン行を出さないので件数のみ）`
	);
}

export const REDUCTION_LABEL = '検出内訳';
export const TRIPLE_HS_NO_CANDIDATE_NOTE = '（比較対象 H&S 無し）';

// currentFiltered だけは 0 のとき省く（無効時も確定的に 0 を返すので曖昧さが無い）。他の段は 0 でも省かない。件数は再集計しない（#200）。
export function buildReductionLine(meta: PatternMeta | undefined): string {
	const r = meta?.reduction;
	if (!r) return '';
	const {
		detected,
		reversalHistoryExcluded,
		dedupMerged,
		currentFiltered,
		lifecycleExcluded,
		tripleHsExcluded,
		tripleHsCandidateCount,
		output,
	} = r;
	if (![detected, dedupMerged, currentFiltered, lifecycleExcluded, tripleHsExcluded, output].every(Number.isFinite))
		return '';
	const parts = [`検出 ${formatInt(detected)}件`];
	if (Number.isFinite(reversalHistoryExcluded)) {
		parts.push(`反転履歴不足 -${formatInt(reversalHistoryExcluded as number)}`);
	}
	parts.push(`重複統合 -${formatInt(dedupMerged)}`);
	if (currentFiltered > 0) parts.push(`現在時点フィルタ -${formatInt(currentFiltered)}`);
	// tripleHsCandidateCount が無い古い meta では注記を出さない。無いことを「比較対象無し」と読ませない。
	const hsNote = tripleHsCandidateCount === 0 ? TRIPLE_HS_NO_CANDIDATE_NOTE : '';
	parts.push(
		`ライフサイクル除外 -${formatInt(lifecycleExcluded)}`,
		`triple×H&S排他 -${formatInt(tripleHsExcluded)}${hsNote}`,
		`出力 ${formatInt(output)}件`,
	);
	return `${REDUCTION_LABEL}: ${parts.join(' → ')}`;
}

// total が数値でないときは行ごと出さない（件数不明で「省略なし」と書かない）。省略 0 でも「省略なし」を明示する（#180）。
export function formatTrimNote(kept: number, total?: number, omitted?: number, omittedNote?: string): string {
	const trim = resolveTrimCounts(kept, total, omitted);
	if (!trim) return '';
	const tail =
		trim.dropped > 0 ? `${formatInt(trim.dropped)} 件省略${omittedNote ? `。${omittedNote}` : ''}` : '省略なし';
	return ` ${formatInt(kept)} / 全 ${formatInt(trim.total)} 件（${tail}）`;
}

// formatTrimNote と formatRejectionSummary の単一ソース。別々に計算すると見出しと集計が食い違う（#191）。
export function resolveTrimCounts(
	kept: number,
	total?: number,
	omitted?: number,
): { total: number; dropped: number } | null {
	if (typeof total !== 'number' || !Number.isFinite(total)) return null;
	const dropped =
		typeof omitted === 'number' && Number.isFinite(omitted) ? Math.max(0, omitted) : Math.max(0, total - kept);
	return { total, dropped };
}

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

export function toDateOrTime(iso: string | undefined, tz: string, type: string): string {
	// 判定は lib/datetime.ts が単一ソース。ここは 'n/a' フォールバックを足すだけ。
	return formatDateOrTimeInTz(iso, tz, type) ?? 'n/a';
}

function buildPeriodLines(p: PatternEntry, legacyRange: string, tz: string, type: string, decimals: number): string[] {
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
		lines.push(`   - 文脈期間: ${toDateOrTime(ctxStart, tz, type)} ~ ${toDateOrTime(ctxEnd, tz, type)}${suffix}`);
	}

	if (p.structureRange) {
		lines.push(
			`   - 形成期間: ${toDateOrTime(p.structureRange.start, tz, type)} ~ ${toDateOrTime(p.structureRange.end, tz, type)}（構成点）`,
		);
	}

	if (p.confirmation?.type === 'neckline_breakout') {
		const priceStr = Number.isFinite(p.confirmation.price)
			? `${formatPriceDecimals(p.confirmation.price, decimals)}円`
			: 'n/a';
		lines.push(`   - ブレイク確認: ${toDateOrTime(p.confirmation.date, tz, type)}（${priceStr}）`);
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
			`   - 先行トレンド: ${toDateOrTime(t.start, tz, type)} ~ ${toDateOrTime(t.end, tz, type)}（${dirJa[t.direction] || t.direction}、${sign}${t.returnPct}%、lookback=${t.lookbackBars}本）`,
		);
	}

	return lines.length > 0 ? lines : [`   - 期間: ${legacyRange}`];
}

// 生の価格は toLocaleString の既定（小数 3 桁）より桁を減らさない。ここで丸めると BTC でも表示が変わる。
function rawYen(v: number, decimals: number): string {
	return v.toLocaleString('ja-JP', { maximumFractionDigits: Math.max(3, decimals) });
}

// 判定は高安・報告値は終値なので両方を出す。片方だけだと出力から判定を検算できない（#125）。
function formatPivotPrices(pv: Pivot, decimals: number): string {
	const yen = (v: number) => `${formatPriceDecimals(v, decimals)}円`;
	const close = Number(pv?.price);
	const extreme = Number(pv?.extremePrice);
	const basisLabel = pv?.kind === 'L' ? '安値' : '高値';
	if (!Number.isFinite(close)) return 'n/a';
	if (!Number.isFinite(extreme)) return `(${yen(close)})`;
	if (yen(close) === yen(extreme)) return `${basisLabel} ${yen(extreme)}（判定は${basisLabel}基準）`;
	return `終値 ${yen(close)} / ${basisLabel} ${yen(extreme)}（判定は${basisLabel}基準）`;
}

// 極値は高安・同水準は終値の混合基準なので、ヒゲだけの山2 を読み手が知る手段としてこの行を出す。分母は levelSpreadMetrics を使い、表示層で式を写さない（#245）。
function formatSecondExtremePositionLine(p: PatternEntry): string | null {
	const side = p?.type === 'double_top' ? 'top' : p?.type === 'double_bottom' ? 'bottom' : null;
	if (!side) return null;
	const pivots = p?.pivots;
	// >= 3 ではなく === 3。点数が変わったら b がネックライン定義点だという前提から検算し直す。
	if (!Array.isArray(pivots) || pivots.length !== 3) return null;
	const [a, b, c] = pivots;
	if (!a || !b || !c) return null;
	const necklinePrice = Number(b.price);
	const close = Number(c.price);
	const extreme = Number(c.extremePrice);
	if (!Number.isFinite(necklinePrice) || !Number.isFinite(close) || !Number.isFinite(extreme)) return null;
	const { heightAbs } = levelSpreadMetrics([a, c], [a, b, c]);
	if (heightAbs === null || !(heightAbs > 0)) return null;
	// 符号は価格の向き（+ が上）に固定する。closeGap の向きで符号を付けると種別で意味が反転する。
	const gapByPrice = (close - necklinePrice) / heightAbs;
	const wickShare = side === 'top' ? (extreme - close) / heightAbs : (close - extreme) / heightAbs;
	const label = side === 'top' ? '山2' : '谷2';
	// `formatPctFromRatio` は負値にだけ符号を付けるので、正のときだけ `+` を補う。
	const sign = gapByPrice > 0 ? '+' : '';
	return `   - ${label} の位置: 終値はネックラインの ${sign}${formatPctFromRatio(gapByPrice)}（パターン高さ比）/ ヒゲ ${formatPctFromRatio(wickShare)}`;
}

// kind から役割を導出しない（形成中 H&S は左肩と頭が同じ kind）。形成中 H&S の 4 点は完成版 5 点の先頭 4 点ではないので、点数ごとに別エントリを置く（#234）。
const PIVOT_ROLE_LABELS: Readonly<Record<string, readonly string[]>> = {
	'triple_top:5': ['山1', '谷1', '山2', '谷2', '山3'],
	'triple_top:4': ['山1', '谷1', '山2', '谷2'],
	'triple_bottom:5': ['谷1', '山1', '谷2', '山2', '谷3'],
	'triple_bottom:4': ['谷1', '山1', '谷2', '山2'],
	'head_and_shoulders:5': ['左肩', '谷1', '頭', '谷2', '右肩'],
	'head_and_shoulders:4': ['左肩', '頭', '谷（頭後）', '右肩(暫定)'],
	'inverse_head_and_shoulders:5': ['左肩', '山1', '頭', '山2', '右肩'],
	'inverse_head_and_shoulders:4': ['左肩', '頭', '山（頭後）', '右肩(暫定)'],
};

// double 2 型だけは点数で引かない。点数を鍵にすると pivots の構成が変わった瞬間に表示が黙って消える。
function pivotRoleLabels(type: string, pivotCount: number): readonly string[] | null {
	if (type === 'double_top') return ['山1', '谷', '山2'];
	if (type === 'double_bottom') return ['谷1', '山', '谷2'];
	return PIVOT_ROLE_LABELS[`${type}:${pivotCount}`] ?? null;
}

// last と zone を 1 つの表に同居させる（分けると片方だけ埋め忘れて混線した文が出る）。side='top' のゾーンは山側なので、理由コード名のまま「谷ゾーン」と書かない（#286）。
const REVERSAL_STATUS_WORDS: Readonly<Record<string, { last: string; zone: '山' | '谷' }>> = {
	double_top: { last: '山2', zone: '山' },
	double_bottom: { last: '谷2', zone: '谷' },
	triple_top: { last: '山3', zone: '山' },
	triple_bottom: { last: '谷3', zone: '谷' },
	head_and_shoulders: { last: '右肩', zone: '山' },
	inverse_head_and_shoulders: { last: '右肩', zone: '谷' },
};

const CONTINUATION_STATUS_TYPES: ReadonlySet<string> = new Set([
	'triangle_ascending',
	'triangle_descending',
	'triangle_symmetrical',
	'falling_wedge',
	'rising_wedge',
	'bull_flag',
	'bear_flag',
	'bull_pennant',
	'bear_pennant',
]);

const STATUS_JA: Readonly<Record<string, string>> = {
	forming: '形成中',
	near_completion: 'ほぼ完成',
	completed: '完成（ブレイクアウト確認済み）',
	invalid: '無効',
	expired: '期限切れ',
};

// 表に無いコードには日本語を当てない（#286）。新しい理由コードを検出器に足したらここにも足す（網羅はテストが固定している）。
function invalidReasonJa(reason: string, type: string): string | null {
	const words = REVERSAL_STATUS_WORDS[type];
	const last = words?.last ?? '最終構成点';
	switch (reason) {
		case 're_entered_trough_zone':
			// 種別が引けないときは方向を持たない言い回しに落とす（「山」「谷」を推測しない）。
			return words
				? `${last} の確定後、突破前に${words.zone}ゾーンへ戻った`
				: '最終構成点の確定後、突破前に最終構成点のゾーンへ戻った';
		case 'peak_after_last_pivot':
			return `${last} の後に別の山を作ってから割った`;
		case 'trough_after_last_pivot':
			return `${last} の後に別の谷を作ってから抜けた`;
		case 'forming_expired':
			return '突破確認窓を過ぎてもネックラインを突破しなかった';
		case BREAKOUT_AGAINST_EXPECTATION:
			// 継続系では words 由来の語（山2 / 谷3 / 右肩）を混ぜない。存在しない構造を名乗ることになる（#291）。
			return '期待と逆方向にブレイク';
		default:
			return null;
	}
}

// 同じ near_completion が系統で別の事実を指すので種別で分ける。
function nearCompletionJa(type: string): string {
	if (REVERSAL_STATUS_WORDS[type]) return 'ほぼ完成（構造成立・ネックライン未突破）';
	if (CONTINUATION_STATUS_TYPES.has(type)) return 'ほぼ完成（apex接近）';
	return 'ほぼ完成';
}

// invalidReason があれば必ずコードを併記する。structuredContent は LLM から見えないので、content に出さないと理由が届かない。
export function formatStatusLine(p: Pick<PatternEntry, 'status' | 'invalidReason' | 'type'>): string | null {
	const status = p?.status;
	if (!status) return null;
	const base = STATUS_JA[status];
	// 未知の status は生の値をそのまま出す（誤った日本語を当てない）。
	if (!base) return `   - 状態: ${status}`;

	const type = String(p?.type ?? '');
	if (status === 'near_completion') return `   - 状態: ${nearCompletionJa(type)}`;
	if (status === 'invalid' || status === 'expired') {
		const reason = p?.invalidReason;
		if (!reason) return `   - 状態: ${base}`;
		const ja = invalidReasonJa(reason, type);
		return `   - 状態: ${base}（${ja ? `${ja}: ` : ''}${reason}）`;
	}
	return `   - 状態: ${base}`;
}

export function formatPatternLine(
	p: PatternEntry,
	idx: number,
	view: string,
	meta: PatternMeta,
	tz: string = 'Asia/Tokyo',
	type: string = '1day',
	decimals: number = patternPriceDecimals([p]),
): string {
	const name = String(p?.type || 'unknown');
	const conf = p?.confidence != null ? Number(p.confidence).toFixed(2) : 'n/a';
	const range = p?.range ? `${toDateOrTime(p.range.start, tz, type)} ~ ${toDateOrTime(p.range.end, tz, type)}` : 'n/a';
	const periodLines = buildPeriodLines(p, range, tz, type, decimals);

	let priceRange: string | null = null;
	if (Array.isArray(p?.pivots) && p.pivots.length) {
		const prices = p.pivots.map((v) => Number(v?.price)).filter(Number.isFinite);
		if (prices.length)
			priceRange = `${rawYen(Math.min(...prices), decimals)}円 - ${rawYen(Math.max(...prices), decimals)}円`;
	}

	let neckline: string | null = null;
	if (Array.isArray(p?.neckline) && p.neckline.length === 2) {
		const [a, b] = p.neckline;
		const y1 = Number(a?.y),
			y2 = Number(b?.y);
		if (Number.isFinite(y1) && Number.isFinite(y2)) {
			neckline =
				y1 === y2 ? `${rawYen(y1, decimals)}円（水平）` : `${rawYen(y1, decimals)}円 → ${rawYen(y2, decimals)}円`;
		}
	}

	const idxToIso = buildIdxToIso(meta);

	const pivotLines: string[] = [];
	if ((view === 'full' || view === 'debug') && Array.isArray(p?.pivots) && p.pivots.length >= 3) {
		const pivs = p.pivots;
		const roleLabels = pivotRoleLabels(String(p?.type ?? ''), pivs.length);
		// roleLabels.length で回す。点数と食い違ったまま添字で引くと別の役割のラベルを黙って貼る。
		if (roleLabels) {
			for (let i = 0; i < roleLabels.length; i++) {
				const pv = pivs[i];
				if (!pv) continue;
				const d = idxToIso[Number(pv.idx)] || '';
				const date = toDateOrTime(d || undefined, tz, type);
				pivotLines.push(`   - ${roleLabels[i]}: ${date} ${formatPivotPrices(pv, decimals)}`);
			}
		}
	}

	let breakoutLine: string | null = null;
	try {
		if ((view === 'full' || view === 'debug') && p?.breakout?.idx != null) {
			const bidx = Number(p.breakout.idx);
			const bpx = Number(p.breakout.price);
			const bIso = idxToIso[bidx];
			const bdate = bIso ? toDateOrTime(String(bIso), tz, type) : 'n/a';
			const bprice = Number.isFinite(bpx) ? formatPriceDecimals(bpx, decimals) : 'n/a';
			breakoutLine = `   - ブレイク: ${bdate} (${bprice}円)`;
		}
	} catch {
		/* ignore */
	}

	const statusLine = formatStatusLine(p);

	// pivots.length では判定しない（#224 で構成点を足したとき length 条件が黙って注記を消した）。status === 'forming' だけで判定する。
	let formingTripleNote: string | null = null;
	if ((p?.type === 'triple_top' || p?.type === 'triple_bottom') && p?.status === 'forming') {
		const role = p.type === 'triple_top' ? '3 山目' : '3 谷目';
		formingTripleNote = `   - 注: ${role}は現在価格を暫定（未確定）。2 確定ピボット + 現在価格で評価しているため、参考材料として扱う`;
	}

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
				bull_flag: '上方',
				bear_flag: '下方',
				bull_pennant: '上方',
				bear_pennant: '下方',
			};
			const expectedDir = p.type ? expectedDirMap[p.type] : undefined;
			const meaningMap: Record<string, Record<string, string>> = {
				falling_wedge: { success: '強気転換', failure: '上方転換シナリオ無効化' },
				rising_wedge: { success: '弱気転換', failure: '下方転換シナリオ無効化' },
				triangle_ascending: { success: '上方ブレイク（強気）', failure: '下方ブレイク（弱気転換）' },
				triangle_descending: { success: '下方ブレイク（弱気）', failure: '上方ブレイク（強気転換）' },
				bull_flag: { success: 'トレンド継続（強気）', failure: 'ダマシ（弱気転換）' },
				bear_flag: { success: 'トレンド継続（弱気）', failure: 'ダマシ（強気転換）' },
				bull_pennant: { success: 'トレンド継続（強気）', failure: 'ダマシ（弱気転換）' },
				bear_pennant: { success: 'トレンド継続（弱気）', failure: 'ダマシ（強気転換）' },
			};
			const meaning = (p.type && p.outcome ? meaningMap[p.type]?.[p.outcome] : undefined) || `${directionJa}ブレイク`;
			let dirLine = `   - ブレイク方向: ${directionJa}ブレイク`;
			if (expectedDir) dirLine += `（本来は${expectedDir}ブレイクが期待されるパターン）`;
			outcomeLine = `${dirLine}\n   - パターン結果: ${outcomeJa}（${meaning}）`;
		}
	} catch {
		/* ignore */
	}

	let pennantLine: string | null = null;
	try {
		const isFlagFamily =
			p?.type === 'bull_flag' || p?.type === 'bear_flag' || p?.type === 'bull_pennant' || p?.type === 'bear_pennant';
		if (isFlagFamily) {
			const parts: string[] = [];
			if (p.poleDirection) parts.push(`フラッグポール方向: ${p.poleDirection === 'up' ? '上昇' : '下降'}`);
			if (p.priorTrendDirection)
				parts.push(
					`先行トレンド: ${p.priorTrendDirection === 'bullish' ? '強気（上昇トレンド）' : '弱気（下降トレンド）'}`,
				);
			if (p.flagpoleHeight != null)
				parts.push(`フラッグポール値幅: ${formatPriceDecimals(Number(p.flagpoleHeight), decimals)}円`);
			if (p.poleStartDate && p.poleEndDate && p.poleChangePct != null) {
				const psd = toDateOrTime(p.poleStartDate, tz, type);
				const ped = toDateOrTime(p.poleEndDate, tz, type);
				const sign = p.poleChangePct >= 0 ? '+' : '';
				const pctStr = `${sign}${(p.poleChangePct * 100).toFixed(1)}%`;
				const barsStr = p.poleBars ? `, ${p.poleBars}本` : '';
				parts.push(`旗竿期間: ${psd} ~ ${ped}（${pctStr}${barsStr}）`);
			}
			if (p.poleATRMult != null) {
				parts.push(`旗竿 ATR 倍率: ${p.poleATRMult.toFixed(2)}x`);
			}
			if (p.flagUpperSlope != null && p.flagLowerSlope != null) {
				parts.push(
					`チャネル傾き: 上限=${p.flagUpperSlope.toFixed(decimals + 2)}, 下限=${p.flagLowerSlope.toFixed(decimals + 2)}（円/本）`,
				);
			}
			if (p.spreadAvg != null && p.spreadStability != null) {
				const stabPct = (p.spreadStability * 100).toFixed(0);
				parts.push(`平均チャネル幅: ${formatPriceDecimals(p.spreadAvg, decimals)}円（平行度: ${stabPct}%）`);
			}
			if (p.expectedBreakoutDirection) {
				parts.push(`期待ブレイク方向: ${p.expectedBreakoutDirection === 'up' ? '上方' : '下方'}`);
			}
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

	// ターゲット行は breakoutTarget の有無で握り潰さない。no_target は breakoutTarget が必ず無いときの申告なので、価格行のガードに入れるとその経路だけが消える。
	let targetLine: string | null = null;
	const progressLine = formatTargetProgressLine(p, { formatDate: (iso) => toDateOrTime(iso, tz, type) });
	if (p?.breakoutTarget != null) {
		const methodJa: Record<string, string> = {
			flagpole_projection: 'フラッグポール値幅投影',
			pattern_height: 'パターン高さ投影',
			neckline_projection: 'ネックライン投影',
		};
		targetLine = `   - ターゲット価格: ${formatPriceDecimals(Number(p.breakoutTarget), decimals)}円（${(p.targetMethod && methodJa[p.targetMethod]) || p.targetMethod}）`;
		if (progressLine) targetLine += `\n${progressLine}`;
	} else if (progressLine) {
		targetLine = progressLine;
	}

	// strict 由来には何も付けない。「印が無い = strict」は 検出経路: 行が件数で裏づける。
	const fallbackTag = typeof p?._fallback === 'string' && p._fallback.trim() ? ` [${p._fallback.trim()}]` : '';

	const lines = [
		`${idx + 1}. ${name} (パターン整合度: ${conf})${fallbackTag}`,
		...formatScoreBreakdownLines(p?.scoreComponents),
		...periodLines,
		statusLine,
		formingTripleNote,
		priceRange ? `   - 価格範囲: ${priceRange}` : null,
		...(pivotLines.length ? pivotLines : []),
		formatStructureGateSkipLine(p?.structureGate?.skipped),
		...formatTriplePositionLines(p?.type, p?.pivots),
		// view で分岐しない。軽い view でも「山2 がヒゲだけ」を LLM が読めるべきなので全 view に出す。
		formatSecondExtremePositionLine(p),
		neckline ? `   - ${p?.trendlineLabel || 'ネックライン'}: ${neckline}` : null,
		breakoutLine,
		outcomeLine,
		targetLine,
		pennantLine,
		diagramBlock,
	].filter(Boolean);
	return lines.join('\n');
}

export function formatSummaryView(
	hdr: string,
	pats: PatternEntry[],
	periodBlock: string,
	typeSummary: string,
	patterns: string[] | undefined,
	includeForming: boolean | undefined,
	res: PatternResult,
	_tz: string = 'Asia/Tokyo',
	effectiveParamsLine: string = '',
): McpResponse {
	const now = Date.now();
	const within = (ms: number) =>
		pats.filter((p) => Number.isFinite(toTs(p?.range?.end)) && now - toTs(p.range?.end) <= ms).length;
	const in30 = within(30 * 86400000);
	const in90 = within(90 * 86400000);
	const formingHint = includeForming ? '' : '\n※形成中は includeForming=true を指定してください。';
	const routeLine = buildDetectionRouteLine(pats);
	const reductionLine = buildReductionLine(res?.meta as PatternMeta | undefined);
	const text = `${hdr}（${typeSummary || '分類なし'}、直近30日: ${in30}件、直近90日: ${in90}件）\n${periodBlock ? `${periodBlock}\n` : ''}${effectiveParamsLine ? `${effectiveParamsLine}\n` : ''}${routeLine ? `${routeLine}\n` : ''}${reductionLine ? `${reductionLine}\n` : ''}検討パターン: ${patterns?.length ? patterns.join(', ') : '既定セット'}${formingHint}\n詳細は structuredContent.data.patterns を参照。`;
	return { content: [{ type: 'text', text }], structuredContent: toStructured(res) };
}

export function formatFullView(
	hdr: string,
	pats: PatternEntry[],
	periodBlock: string,
	typeSummary: string,
	meta: PatternMeta,
	res: PatternResult,
	tz: string = 'Asia/Tokyo',
	effectiveParamsLine: string = '',
	type: string = '1day',
): McpResponse {
	const decimals = patternPriceDecimals(pats);
	const body = pats.map((p, i) => formatPatternLine(p, i, 'full', meta, tz, type, decimals)).join('\n\n');
	const overlayNote = res?.data?.overlays
		? '\n\nチャート連携: structuredContent.data.overlays を render_chart_svg.overlays に渡すと注釈/範囲を描画できます。'
		: '';
	const trustNote = `\n\n${CONFIDENCE_NOTE}\n  ※ status=forming は最終構成点が未確定のため、整合度に関わらず「参考材料」として扱う`;
	const routeLine = buildDetectionRouteLine(pats);
	const reductionLine = buildReductionLine(meta);
	const text = `${hdr}（${typeSummary || '分類なし'}）\n${periodBlock ? `${periodBlock}\n` : ''}${effectiveParamsLine ? `${effectiveParamsLine}\n` : ''}${routeLine ? `${routeLine}\n` : ''}${reductionLine ? `${reductionLine}\n` : ''}\n【検出パターン（全件）】\n${body}${overlayNote}${trustNote}`;
	return { content: [{ type: 'text', text }], structuredContent: toStructured(res) };
}

/** slice の件数とトリム申告行の閾値判定の両方が参照する。 */
const DETAILED_VIEW_PATTERN_LIMIT = 5;

export function formatDetailedView(
	hdr: string,
	pats: PatternEntry[],
	periodBlock: string,
	typeSummary: string,
	meta: PatternMeta,
	patterns: string[] | undefined,
	res: PatternResult,
	tz: string = 'Asia/Tokyo',
	effectiveParamsLine: string = '',
	type: string = '1day',
): McpResponse {
	const top = pats.slice(0, DETAILED_VIEW_PATTERN_LIMIT);
	const decimals = patternPriceDecimals(pats);
	const body = top.length
		? top.map((p, i) => formatPatternLine(p, i, 'detailed', meta, tz, type, decimals)).join('\n\n')
		: '';
	// pats.length < 上限 のときは行ごと出さない（省略が起こり得ない）。ちょうど上限のときだけ cap で切られたかの区別がつかないので明示する（#196）。
	const patternsNote =
		pats.length >= DETAILED_VIEW_PATTERN_LIMIT
			? formatTrimNote(top.length, pats.length, undefined, '全件は view=full')
			: '';

	let none = '';
	if (!top.length) {
		const resSummary = String(res?.summary ?? '');
		if (resSummary === 'insufficient data') {
			none = `\n${resSummary}`;
		} else {
			// 入力値へフォールバックしない。実効値が無いときは数値を主張しない（#184）。
			const effTol = meta?.effective_params?.tolerancePct?.value;
			// 緩める / 締めるの基準は実効値。
			const loosenHint = Number.isFinite(effTol as number)
				? `・緩めるなら tolerancePct に実効値 ${effTol} より大きい値を指定してください（上限 0.1）。${effTol} 以下は締める方向です（スキーマ既定値 0.04 は sentinel なので時間軸オート値に戻ります）`
				: '・緩めるなら tolerancePct を実効値より大きい値に上げてください（上限 0.1。実効値は上の実効パラメータ行を参照）。スキーマ既定値 0.04 は sentinel なので時間軸オート値に置換されます';
			none = `\nパターンは検出されませんでした。\n・検討パターン: ${patterns?.length ? patterns.join(', ') : '既定セット'}\n${loosenHint}`;
		}
	}

	const overlayNote = res?.data?.overlays
		? '\n\nチャート連携: structuredContent.data.overlays を render_chart_svg.overlays に渡すと注釈/範囲を描画できます。'
		: '';
	const trustNote = `\n\n${CONFIDENCE_NOTE}\n  ※ status=forming は最終構成点が未確定のため、整合度に関わらず「参考材料」として扱う`;
	const usage = `\n\nusage_example:\n  step1: detect_patterns を実行\n  step2: structuredContent.data.overlays を取得\n  step3: render_chart_svg の overlays に渡す`;
	const routeLine = buildDetectionRouteLine(pats);
	const reductionLine = buildReductionLine(meta);
	const text = `${hdr}（${typeSummary || '分類なし'}）\n${periodBlock ? `${periodBlock}\n` : ''}${effectiveParamsLine ? `${effectiveParamsLine}\n` : ''}${routeLine ? `${routeLine}\n` : ''}${reductionLine ? `${reductionLine}\n` : ''}\n${top.length ? `【検出パターン】${patternsNote}\n${body}` : ''}${none}${overlayNote}${trustNote}${usage}`;
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
