import { dayjs, toDisplayTime } from './datetime.js';
import { isJpyQuotedPair } from './pair-code.js';
import { fractionDigits, priceDecimals, roundAtDecimalDigits } from './price.js';

export function timeframeLabel(type: string): string {
	const map: Record<string, string> = {
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
	return map[type] || type;
}

// 本数を暦の長さとして読めるのは日足・週足・月足だけで、それ以外の足は「本」で数える（#431）。
const CALENDAR_BAR_UNITS: Record<string, { unit: string; per: string; prevChange: string }> = {
	'1day': { unit: '日', per: '日', prevChange: '前日比' },
	'1week': { unit: '週', per: '週', prevChange: '前週比' },
	'1month': { unit: 'か月', per: '月', prevChange: '前月比' },
};
const COUNT_BAR_UNIT = { unit: '本', per: '本', prevChange: '前足比' };

function barUnit(type: string) {
	return Object.hasOwn(CALENDAR_BAR_UNITS, type) ? CALENDAR_BAR_UNITS[type] : COUNT_BAR_UNIT;
}

export function barsAgoLabel(bars: number, type: string): string {
	return `${bars}${barUnit(type).unit}前`;
}

export function barsAheadLabel(bars: number, type: string): string {
	return `${bars}${barUnit(type).unit}後`;
}

export function barCountLabel(bars: number, type: string): string {
	return `${bars}${barUnit(type).unit}`;
}

export function perBarLabel(type: string): string {
	return `/${barUnit(type).per}`;
}

export function prevBarChangeLabel(type: string): string {
	return barUnit(type).prevChange;
}

export function formatPair(pair: string): string {
	return (pair || '').toUpperCase().replace('_', '/');
}

// 信用建玉の表示（get_margin_positions / analyzeMyPortfolio）は「ロング / ショート」を使うので、このヘルパは流用しない。
export function formatOrderPositionLabel(positionSide: string | null | undefined): string {
	if (positionSide === 'long') return 'long ';
	if (positionSide === 'short') return 'short ';
	return '';
}

export function formatTimestampJST(ts?: number, tz: string = 'Asia/Tokyo'): string {
	const result = toDisplayTime(ts, tz);
	return result ?? dayjs(ts).toISOString();
}

// toLocaleString の既定は小数 3 桁で切るので、100 円未満のペアの刻み（0.0001 円など）が落ちる。100 円以上は既定と同じ 3 桁。
export function formatPriceNumber(value: number): string {
	return value.toLocaleString('ja-JP', { maximumFractionDigits: Math.max(3, priceDecimals(value)) });
}

export function formatPrice(value: number | null | undefined, pair?: string): string {
	if (value == null || !Number.isFinite(Number(value))) return 'N/A';
	const text = formatPriceNumber(Number(value));
	const jpy = !pair || (typeof pair === 'string' && isJpyQuotedPair(pair));
	return jpy ? `¥${text}` : text;
}

// 計算した価格（指標・水準）用。値幅は refPrice に価格を渡す。取引所の値は formatExactPrice で桁を落とさずに出す。
export function formatPriceJPY(value: number | null | undefined, refPrice?: number | null): string {
	if (value == null || !Number.isFinite(Number(value))) return 'n/a';
	return `${formatPriceAtLevel(Number(value), refPrice ?? Number(value))}円`;
}

// 損益・評価額などの金額。価格ではないので円の整数でよい。
export function formatYenAmount(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(Number(value))) return 'n/a';
	return `${Math.round(Number(value)).toLocaleString('ja-JP')}円`;
}

export function formatCurrency(value: number | null | undefined, pair?: string): string {
	if (value == null) return 'n/a';
	const jpy = !pair || (typeof pair === 'string' && isJpyQuotedPair(pair));
	return jpy ? `${Number(value).toLocaleString('ja-JP')} JPY` : `${Number(value).toFixed(2)}`;
}

export function formatCurrencyShort(value: number | null | undefined, pair?: string): string {
	if (value == null) return 'n/a';
	const jpy = !pair || (typeof pair === 'string' && isJpyQuotedPair(pair));
	if (jpy) {
		const n = Number(value);
		return n >= 1000 ? `${Math.round(n / 1000)}k JPY` : `${n.toLocaleString('ja-JP')} JPY`;
	}
	return `${Number(value).toFixed(2)}`;
}

export function formatPercent(
	value: number | null | undefined,
	opts: { digits?: number; sign?: boolean; multiply?: boolean } = {},
): string {
	if (value == null || !Number.isFinite(Number(value))) return 'n/a';
	const { digits = 1, sign = false, multiply = false } = opts;
	const v = multiply ? Number(value) * 100 : Number(value);
	const prefix = sign && v >= 0 ? '+' : '';
	return `${prefix}${v.toFixed(digits)}%`;
}

export function formatVolumeJPY(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value)) return 'n/a';
	if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}億円`;
	return `${Math.round(value / 10_000)}万円`;
}

export function formatFixed(v: unknown, digits = 8): string {
	if (v == null) return 'n/a';
	const n = Number(v);
	return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

export function formatRounded(v: unknown): string {
	if (v == null) return 'n/a';
	const n = Number(v);
	return Number.isFinite(n) ? Math.round(n).toLocaleString('ja-JP') : 'n/a';
}

export function formatInt(v: unknown): string {
	if (v == null) return 'n/a';
	const n = Number(v);
	return Number.isFinite(n) ? String(n) : 'n/a';
}

export function formatPctFromRatio(v: unknown, digits = 1): string {
	if (v == null) return 'n/a';
	const n = Number(v);
	return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : 'n/a';
}

export function formatTrendSymbol(slope: number | null | undefined): string {
	if (slope == null) return '➡️';
	return slope > 0 ? '📈' : slope < 0 ? '📉' : '➡️';
}

export function formatTrendArrow(
	val: number | null | undefined,
	base: number | null | undefined,
	threshold = 0.05,
): string {
	if (val == null || base == null) return '→';
	if (val > base * (1 + threshold)) return '⬆⬆';
	if (val > base) return '⬆';
	if (val < base * (1 - threshold)) return '⬇⬇';
	if (val < base) return '⬇';
	return '→';
}

export function formatDeviation(close: number | null, ref: number | null | undefined): string {
	if (close == null || ref == null || !Number.isFinite(close) || !Number.isFinite(ref) || close === 0) return 'n/a';
	const pct = ((ref - close) / Math.abs(close)) * 100;
	if (!Number.isFinite(pct)) return 'n/a';
	const dir = ref >= close ? '上方' : '下方';
	return `${formatPercent(pct, { sign: true, digits: 1 })} ${dir}`;
}

export function formatSummary(
	args: {
		pair?: string;
		timeframe?: string;
		latest?: number;
		totalItems?: number;
		keyPoints?: {
			today?: { date?: string | null; index: number; close: number } | null;
			sevenDaysAgo?: { date?: string | null; index: number; close: number; changePct: number | null } | null;
			thirtyDaysAgo?: { date?: string | null; index: number; close: number; changePct: number | null } | null;
			ninetyDaysAgo?: { date?: string | null; index: number; close: number; changePct: number | null } | null;
		};
		volumeStats?: {
			recent7DaysAvg: number;
			previous7DaysAvg: number;
			last30DaysAvg?: number | null;
			changePct: number | null;
			judgment: string;
		} | null;
		extra?: string;
		priceRange?: { high: number; low: number; periodStart: string; periodEnd: string };
	} = {},
): string {
	const { pair, timeframe, latest, totalItems, keyPoints, volumeStats, extra, priceRange } = args;
	const p = formatPair(pair ?? '');
	const tf = timeframe ? ` [${timeframe}]` : '';
	const isJpy = typeof pair === 'string' && isJpyQuotedPair(pair);
	const currency = isJpy ? '円' : '';

	let summary = p;

	if (typeof totalItems === 'number' && totalItems > 0) {
		summary += `${tf} ローソク足${totalItems}本取得`;
		summary += `\n⚠️ 配列は古い順: data[0]=最古、data[${totalItems - 1}]=最新`;

		if (priceRange) {
			summary += `\n\n📈 全${totalItems}件の価格範囲:`;
			summary += `\n- 期間: ${priceRange.periodStart} 〜 ${priceRange.periodEnd}`;
			summary += `\n- 高値: ${formatPrice(priceRange.high)}`;
			summary += `\n- 安値: ${formatPrice(priceRange.low)}`;
		}
	}

	if (keyPoints?.today) {
		summary += '\n\n📊 期間別の価格推移:';

		const fmtChange = (pct: number | null) => {
			if (pct === null) return '';
			return ` → 変化率 ${formatPercent(pct, { sign: true })}`;
		};

		const today = keyPoints.today;
		const tfType = timeframe ?? '';
		summary += `\n- 最新 (${today.date || '不明'}, data[${today.index}]): ${formatPrice(today.close)}`;

		// 本数が 90 本に満たないとき ninetyDaysAgo は最古の足を指すので、ラベルは添字の差から付け、同じ足は 2 度出さない。
		const shown = new Set([today.index]);
		for (const point of [keyPoints.sevenDaysAgo, keyPoints.thirtyDaysAgo, keyPoints.ninetyDaysAgo]) {
			if (!point || shown.has(point.index)) continue;
			shown.add(point.index);
			const label = barsAgoLabel(today.index - point.index, tfType);
			summary += `\n- ${label} (${point.date || '不明'}, data[${point.index}]): ${formatPrice(point.close)}${fmtChange(point.changePct)}`;
		}

		if (volumeStats) {
			// 出来高の単位は pair の base 通貨から導出する（規約元6ツール・OBV と同じ書式）。
			const baseCcy = (pair ?? '').split('_')[0]?.toUpperCase() ?? '';
			const per = perBarLabel(tfType);
			summary += '\n\n【出来高推移】';
			summary += `\n- 直近${barCountLabel(7, tfType)}の平均: ${volumeStats.recent7DaysAvg.toFixed(0)} ${baseCcy}${per}`;
			summary += `\n- その前${barCountLabel(7, tfType)}の平均: ${volumeStats.previous7DaysAvg.toFixed(0)} ${baseCcy}${per}`;
			if (typeof volumeStats.last30DaysAvg === 'number') {
				summary += `\n- 過去${barCountLabel(30, tfType)}の平均: ${volumeStats.last30DaysAvg.toFixed(0)} ${baseCcy}${per}`;
			}
			if (volumeStats.changePct === null) {
				summary += `\n- 出来高変化率: N/A（その前${barCountLabel(7, tfType)}の出来高ゼロ）`;
			} else {
				summary += `\n- 出来高変化率: ${volumeStats.changePct >= 0 ? '+' : ''}${volumeStats.changePct}%`;
			}
			summary += `\n- 判定: ${volumeStats.judgment}`;
		}

		// 全データは呼び出し元（get_candles.ts 等）がテキストに追記する
	} else if (typeof latest === 'number') {
		summary += ` 中値=${formatExactPrice(latest)}${currency}`;
	}

	const tail = extra ? ` ${extra}` : '';
	return `${summary}${tail}`.trim();
}

// 桁数は呼び出し側が価格の水準から決める（priceDecimals）。小数の末尾の 0 は出さない。
export function formatPriceDecimals(value: number, decimals: number): string {
	return roundAtDecimalDigits(value, decimals).toLocaleString('ja-JP', { maximumFractionDigits: decimals });
}

// toLocaleString の既定は小数 3 桁で切るので、0.0001 円刻みのペアの気配や中値の最後の桁が落ちる。
export function formatExactPrice(value: number): string {
	return formatPriceDecimals(value, fractionDigits(value));
}

// 円の整数に丸めると、数円のペアでは価格や値幅が潰れる。値幅は値幅自体ではなく価格の水準（refPrice）で桁を決める。
export function formatPriceAtLevel(value: number, refPrice: number = value): string {
	return formatPriceDecimals(value, priceDecimals(refPrice));
}
