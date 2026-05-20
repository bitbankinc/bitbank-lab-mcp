import { dayjs, toDisplayTime } from './datetime.js';

/** 時間足コードを日本語ラベルに変換 */
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

export function formatPair(pair: string): string {
	return (pair || '').toUpperCase().replace('_', '/');
}

/**
 * 注文表示用の position_side ラベル。
 * 信用注文の 4 パターン（ロング新規 / ロング決済 / ショート新規 / ショート決済）を
 * side ラベル（買 / 売）と組み合わせて LLM が判別できるようにするための prefix。
 *
 * - `'long'`  → `'long '`（末尾スペース付き。後続の sideLabel と連結する前提）
 * - `'short'` → `'short '`
 * - その他（現物注文・undefined）→ `''`
 *
 * ⚠️ 信用建玉表示（get_margin_positions / analyzeMyPortfolio）は
 * 「ロング / ショート」を使うため本ヘルパは流用しない。
 */
export function formatOrderPositionLabel(positionSide: string | null | undefined): string {
	if (positionSide === 'long') return 'long ';
	if (positionSide === 'short') return 'short ';
	return '';
}

/**
 * タイムスタンプをJST表示形式に変換
 * @param ts タイムスタンプ（ミリ秒）。未指定時は現在時刻
 * @param tz タイムゾーン（デフォルト: 'Asia/Tokyo'）
 * @returns "2025/11/24 15:32:45 JST" 形式
 */
export function formatTimestampJST(ts?: number, tz: string = 'Asia/Tokyo'): string {
	const result = toDisplayTime(ts, tz);
	return result ?? dayjs(ts).toISOString();
}

/**
 * 価格フォーマット（¥プレフィックス、ペア依存）
 * JPY ペア → ¥123,456  /  non-JPY → 0.123456
 * pair 省略時は JPY として扱う
 */
export function formatPrice(value: number | null | undefined, pair?: string): string {
	if (value == null || !Number.isFinite(Number(value))) return 'N/A';
	const n = Number(value);
	const jpy = !pair || (typeof pair === 'string' && pair.toLowerCase().includes('jpy'));
	if (jpy) return `¥${n.toLocaleString('ja-JP')}`;
	return n.toLocaleString('ja-JP');
}

/**
 * 価格フォーマット（円サフィックス、四捨五入）
 * → 123,456円
 */
export function formatPriceJPY(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(Number(value))) return 'n/a';
	return `${Math.round(Number(value)).toLocaleString('ja-JP')}円`;
}

/**
 * 通貨フォーマット（JPY/非JPY対応、スペース＋通貨コード）
 * JPY → 123,456 JPY  /  非JPY → 0.12
 */
export function formatCurrency(value: number | null | undefined, pair?: string): string {
	if (value == null) return 'n/a';
	const jpy = !pair || (typeof pair === 'string' && pair.toLowerCase().includes('jpy'));
	return jpy ? `${Number(value).toLocaleString('ja-JP')} JPY` : `${Number(value).toFixed(2)}`;
}

/**
 * 通貨フォーマット短縮形（大きな値はk表示）
 * JPY ≥1000 → 12k JPY  /  JPY <1000 → 123 JPY  /  非JPY → 0.12
 */
export function formatCurrencyShort(value: number | null | undefined, pair?: string): string {
	if (value == null) return 'n/a';
	const jpy = !pair || (typeof pair === 'string' && pair.toLowerCase().includes('jpy'));
	if (jpy) {
		const n = Number(value);
		return n >= 1000 ? `${Math.round(n / 1000)}k JPY` : `${n.toLocaleString('ja-JP')} JPY`;
	}
	return `${Number(value).toFixed(2)}`;
}

/**
 * パーセンテージフォーマット
 * @param value 数値
 * @param opts.digits 小数桁数（デフォルト: 1）
 * @param opts.sign 正数に+を付けるか（デフォルト: false）
 * @param opts.multiply 100倍するか（デフォルト: false）。0-1小数→%変換に使う
 */
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

/**
 * 出来高フォーマット（日本円単位、億円/万円）
 */
export function formatVolumeJPY(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value)) return 'n/a';
	if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}億円`;
	return `${Math.round(value / 10_000)}万円`;
}

// ── unknown 型安全フォーマッタ（デバッグ・パターン検出向け） ──

/**
 * unknown 値を固定小数点で整形（デバッグ表示用）
 * @param v 値（unknown 型対応、NaN/null/undefined → 'n/a'）
 * @param digits 小数桁数（デフォルト: 8）
 */
export function formatFixed(v: unknown, digits = 8): string {
	if (v == null) return 'n/a';
	const n = Number(v);
	return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

/**
 * unknown 値を四捨五入してロケール整形
 * @param v 値（unknown 型対応、NaN/null/undefined → 'n/a'）
 */
export function formatRounded(v: unknown): string {
	if (v == null) return 'n/a';
	const n = Number(v);
	return Number.isFinite(n) ? Math.round(n).toLocaleString('ja-JP') : 'n/a';
}

/**
 * unknown 値をそのまま文字列化（整数表示用）
 * @param v 値（unknown 型対応、NaN/null/undefined → 'n/a'）
 */
export function formatInt(v: unknown): string {
	if (v == null) return 'n/a';
	const n = Number(v);
	return Number.isFinite(n) ? String(n) : 'n/a';
}

/**
 * unknown 値を比率（0-1）からパーセント整形
 * 例: 0.05 → "5.0%"
 * @param v 値（unknown 型対応、NaN/null/undefined → 'n/a'）
 * @param digits 小数桁数（デフォルト: 1）
 */
export function formatPctFromRatio(v: unknown, digits = 1): string {
	if (v == null) return 'n/a';
	const n = Number(v);
	return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : 'n/a';
}

// ── トレンド方向シンボル ──

/**
 * 傾き（slope）から方向絵文字を返す
 * 正→📈  負→📉  ゼロ/null→➡️
 */
export function formatTrendSymbol(slope: number | null | undefined): string {
	if (slope == null) return '➡️';
	return slope > 0 ? '📈' : slope < 0 ? '📉' : '➡️';
}

/**
 * 値の基準値との比較で矢印を返す（ボラティリティ推移など）
 * @param val 現在値
 * @param base 基準値
 * @param threshold 有意差の閾値（デフォルト: 0.05 = 5%）
 */
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

/**
 * 現在価格に対する基準価格の乖離率を整形
 * 例: close=100, ref=102 → "+2.0% 上方"
 * @param close 現在価格
 * @param ref 基準価格（SMA等）
 */
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
		// 追加: 全件の範囲情報
		priceRange?: { high: number; low: number; periodStart: string; periodEnd: string };
	} = {},
): string {
	const { pair, timeframe, latest, totalItems, keyPoints, volumeStats, extra, priceRange } = args;
	const p = formatPair(pair ?? '');
	const tf = timeframe ? ` [${timeframe}]` : '';
	const isJpy = typeof pair === 'string' && pair.toLowerCase().includes('jpy');
	const currency = isJpy ? '円' : '';

	// 基本情報
	let summary = p;

	// ローソク足取得の場合（totalItemsが明示的に指定されている場合）
	if (typeof totalItems === 'number' && totalItems > 0) {
		summary += `${tf} ローソク足${totalItems}本取得`;
		summary += `\n⚠️ 配列は古い順: data[0]=最古、data[${totalItems - 1}]=最新`;

		// 全件の範囲情報を追加
		if (priceRange) {
			summary += `\n\n📈 全${totalItems}件の価格範囲:`;
			summary += `\n- 期間: ${priceRange.periodStart} 〜 ${priceRange.periodEnd}`;
			summary += `\n- 高値: ${formatPrice(priceRange.high)}`;
			summary += `\n- 安値: ${formatPrice(priceRange.low)}`;
		}
	}

	// 期間別の価格推移
	if (keyPoints && keyPoints.today) {
		summary += '\n\n📊 期間別の価格推移:';

		const fmtChange = (pct: number | null) => {
			if (pct === null) return '';
			return ` → 変化率 ${formatPercent(pct, { sign: true })}`;
		};

		// 今日
		const today = keyPoints.today;
		summary += `\n- 今日 (${today.date || '不明'}, data[${today.index}]): ${formatPrice(today.close)}`;

		// 7日前
		if (keyPoints.sevenDaysAgo) {
			const sd = keyPoints.sevenDaysAgo;
			summary += `\n- 7日前 (${sd.date || '不明'}, data[${sd.index}]): ${formatPrice(sd.close)}${fmtChange(sd.changePct)}`;
		}

		// 30日前
		if (keyPoints.thirtyDaysAgo) {
			const td = keyPoints.thirtyDaysAgo;
			summary += `\n- 30日前 (${td.date || '不明'}, data[${td.index}]): ${formatPrice(td.close)}${fmtChange(td.changePct)}`;
		}

		// 90日前
		if (keyPoints.ninetyDaysAgo) {
			const nd = keyPoints.ninetyDaysAgo;
			summary += `\n- 90日前 (${nd.date || '不明'}, data[${nd.index}]): ${formatPrice(nd.close)}${fmtChange(nd.changePct)}`;
		}

		// 出来高情報
		if (volumeStats) {
			summary += '\n\n【出来高推移】';
			summary += `\n- 直近7日間の平均: ${volumeStats.recent7DaysAvg.toFixed(0)} BTC/日`;
			summary += `\n- その前7日間の平均: ${volumeStats.previous7DaysAvg.toFixed(0)} BTC/日`;
			if (typeof volumeStats.last30DaysAvg === 'number') {
				summary += `\n- 過去30日間の平均: ${volumeStats.last30DaysAvg.toFixed(0)} BTC/日`;
			}
			if (volumeStats.changePct === null) {
				summary += '\n- 出来高変化率: N/A（前7日間の出来高ゼロ）';
			} else {
				summary += `\n- 出来高変化率: ${volumeStats.changePct >= 0 ? '+' : ''}${volumeStats.changePct}%`;
			}
			summary += `\n- 判定: ${volumeStats.judgment}`;
		}

		// 全データは呼び出し元（get_candles.ts 等）がテキストに追記する
	} else if (typeof latest === 'number') {
		// keyPointsがない場合（板情報など）は中値を表示
		summary += ` 中値=${latest.toLocaleString('ja-JP')}${currency}`;
	}

	const tail = extra ? ` ${extra}` : '';
	return `${summary}${tail}`.trim();
}
