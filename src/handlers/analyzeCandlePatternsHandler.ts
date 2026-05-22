/**
 * analyzeCandlePatterns のビュー（表示）ロジック
 * generateSummary / generateContent + 共有型定義
 */

import type { z } from 'zod';
import { calendarDateFromIso, formatDateWithDayOfWeek } from '../../lib/datetime.js';
import { formatPrice as fmtPrice } from '../../lib/formatter.js';
import type { CandlePatternTypeEnum } from '../schemas.js';

// ── 共有型定義 ──

export type CandlePatternType = z.infer<typeof CandlePatternTypeEnum>;

export interface WindowCandle {
	timestamp: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
	is_partial: boolean;
}

export interface HistoryHorizonStats {
	avg_return: number;
	win_rate: number;
	sample: number;
}

export interface HistoryStats {
	lookback_days: number;
	occurrences: number;
	horizons: Record<string, HistoryHorizonStats>;
}

export interface LocalContext {
	trend_before: 'up' | 'down' | 'neutral';
	volatility_level: 'low' | 'medium' | 'high';
}

export interface DetectedCandlePattern {
	pattern: CandlePatternType;
	pattern_jp: string;
	direction: 'bullish' | 'bearish' | 'neutral';
	strength: number;
	candle_range_index: [number, number];
	uses_partial_candle: boolean;
	status: 'confirmed' | 'forming';
	local_context: LocalContext;
	history_stats: HistoryStats | null;
}

// ── Lookup Maps ──

const TREND_LABELS: Record<string, string> = { down: '下落傾向', up: '上昇傾向' };
const DIRECTION_LABELS: Record<string, string> = {
	bullish: '上昇転換のサイン',
	bearish: '下落転換のサイン',
};
const DIRECTION_DETAIL_LABELS: Record<string, string> = {
	bullish: '強気（上昇転換シグナル）',
	bearish: '弱気（下落転換シグナル）',
};
const TREND_SHORT_LABELS: Record<string, string> = { up: '上昇', down: '下落' };

// ── ヘルパー ──

function formatPrice(price: number): string {
	return fmtPrice(Math.round(price));
}

// ── サマリー生成 ──

export function generateSummary(patterns: DetectedCandlePattern[], windowCandles: WindowCandle[]): string {
	if (patterns.length === 0) {
		const trend =
			windowCandles.length >= 3
				? windowCandles[windowCandles.length - 1].close > windowCandles[0].close
					? '上昇'
					: '下落'
				: '横ばい';
		return `直近${windowCandles.length}日間で${trend}傾向ですが、特徴的なローソク足パターンは検出されませんでした。`;
	}

	const parts: string[] = [];

	for (const p of patterns) {
		const trendText = TREND_LABELS[p.local_context.trend_before] ?? '横ばい';
		const statusText = p.status === 'forming' ? '形成中（未確定）' : '確定';
		const directionText = DIRECTION_LABELS[p.direction] ?? '方向感の迷いを示すサイン';

		let statsPart = '';
		if (p.history_stats?.horizons['1']) {
			const h1 = p.history_stats.horizons['1'];
			statsPart = `過去${p.history_stats.lookback_days}日間で同様のパターンが${p.history_stats.occurrences}回出現し、翌日の勝率は${(h1.win_rate * 100).toFixed(0)}%でした。`;
		}

		parts.push(
			`${trendText}の中で「${p.pattern_jp}」（${statusText}）が検出されました。これは${directionText}とされます。${statsPart}`,
		);

		if (p.uses_partial_candle) {
			parts.push('⚠️ 本日の日足は未確定のため、終値確定後にパターンが変化する可能性があります。');
		}
	}

	return parts.join(' ');
}

// ── コンテント生成 ──

/** 1本足パターンの詳細行 */
function format1CandleDetail(p: DetectedCandlePattern, c: WindowCandle, dateStr: string, statusMark: string): string[] {
	const lines: string[] = [];
	const body = c.close - c.open;
	const candleType = body >= 0 ? '陽線' : '陰線';

	lines.push(`  📍 ${dateStr} に${p.pattern_jp}を検出${statusMark}`);
	lines.push(
		`    ${dateStr}: ${candleType} 始値${formatPrice(c.open)} → 終値${formatPrice(c.close)} (実体 ${body >= 0 ? '+' : '-'}${formatPrice(Math.abs(body)).replace('¥', '')}円)`,
	);
	lines.push(
		`    高値${formatPrice(c.high)} 安値${formatPrice(c.low)} (レンジ ${formatPrice(c.high - c.low).replace('¥', '')}円)`,
	);

	if (p.pattern === 'hammer') {
		const lower = Math.min(c.open, c.close) - c.low;
		lines.push(`    判定: 小さい実体 + 長い下ヒゲ（${formatPrice(lower).replace('¥', '')}円）→ 下値の強い買い圧力`);
	} else if (p.pattern === 'shooting_star') {
		const upper = c.high - Math.max(c.open, c.close);
		lines.push(`    判定: 小さい実体 + 長い上ヒゲ（${formatPrice(upper).replace('¥', '')}円）→ 上値の強い売り圧力`);
	} else if (p.pattern === 'doji') {
		const upper = c.high - Math.max(c.open, c.close);
		const lower = Math.min(c.open, c.close) - c.low;
		const variant =
			upper > lower * 1.5
				? 'トウバ型（上ヒゲ優勢）'
				: lower > upper * 1.5
					? 'トンボ型（下ヒゲ優勢）'
					: '通常型（上下均等）';
		lines.push(`    判定: 始値≒終値で売り買い拮抗 → ${variant}`);
	}
	lines.push('');
	return lines;
}

/** 2本足パターンの詳細行 */
function format2CandleDetail(
	p: DetectedCandlePattern,
	c1: WindowCandle,
	c2: WindowCandle,
	statusMark: string,
): string[] {
	const lines: string[] = [];
	const date1 = formatDateWithDayOfWeek(c1.timestamp);
	const date2 = formatDateWithDayOfWeek(c2.timestamp);
	const body1 = c1.close - c1.open;
	const body2 = c2.close - c2.open;
	const type1 = body1 >= 0 ? '陽線' : '陰線';
	const type2 = body2 >= 0 ? '陽線' : '陰線';

	lines.push(`  📍 ${date2} に${p.pattern_jp}を検出${statusMark}（${date1}-${date2}で形成）`);
	lines.push(
		`    ${date1}(前日): ${type1} 始値${formatPrice(c1.open)} → 終値${formatPrice(c1.close)} (実体 ${body1 >= 0 ? '+' : '-'}${formatPrice(Math.abs(body1)).replace('¥', '')}円)`,
	);
	lines.push(
		`    ${date2}(確定日): ${type2} 始値${formatPrice(c2.open)} → 終値${formatPrice(c2.close)} (実体 ${body2 >= 0 ? '+' : '-'}${formatPrice(Math.abs(body2)).replace('¥', '')}円) ← パターン確定`,
	);

	if (p.pattern === 'bullish_engulfing') {
		lines.push(`    判定: 当日の陽線が前日の陰線を完全に包む（始値が前日終値以下、終値が前日始値以上）`);
	} else if (p.pattern === 'bearish_engulfing') {
		lines.push(`    判定: 当日の陰線が前日の陽線を完全に包む（始値が前日終値以上、終値が前日始値以下）`);
	} else if (p.pattern === 'bullish_harami') {
		lines.push(`    判定: 当日のローソク足が前日の大陰線の実体内に収まる`);
	} else if (p.pattern === 'bearish_harami') {
		lines.push(`    判定: 当日のローソク足が前日の大陽線の実体内に収まる`);
	} else if (p.pattern === 'tweezer_top') {
		const highDiff = Math.abs(c1.high - c2.high);
		const matchPct = (1 - highDiff / ((c1.high + c2.high) / 2)) * 100;
		lines.push(
			`    判定: 2日連続で高値がほぼ同じ（誤差${highDiff.toLocaleString('ja-JP')}円, 一致率${matchPct.toFixed(1)}%）`,
		);
		lines.push(`    高値: ${formatPrice(c1.high)} → ${formatPrice(c2.high)}`);
	} else if (p.pattern === 'tweezer_bottom') {
		const lowDiff = Math.abs(c1.low - c2.low);
		const matchPct = (1 - lowDiff / ((c1.low + c2.low) / 2)) * 100;
		lines.push(
			`    判定: 2日連続で安値がほぼ同じ（誤差${lowDiff.toLocaleString('ja-JP')}円, 一致率${matchPct.toFixed(1)}%）`,
		);
		lines.push(`    安値: ${formatPrice(c1.low)} → ${formatPrice(c2.low)}`);
	} else if (p.pattern === 'dark_cloud_cover') {
		const midPoint = (c1.open + c1.close) / 2;
		lines.push(`    判定: 高寄り後に陰線で前日陽線の中心値（${formatPrice(midPoint)}）を下回る`);
		lines.push(`    ギャップ: ${formatPrice(c2.open)} > 前日終値${formatPrice(c1.close)}`);
	} else if (p.pattern === 'piercing_line') {
		const midPoint = (c1.open + c1.close) / 2;
		lines.push(`    判定: 安寄り後に陽線で前日陰線の中心値（${formatPrice(midPoint)}）を上回る`);
		lines.push(`    ギャップ: ${formatPrice(c2.open)} < 前日終値${formatPrice(c1.close)}`);
	}
	lines.push('');
	return lines;
}

/** 3本足パターンの詳細行 */
function format3CandleDetail(
	p: DetectedCandlePattern,
	c1: WindowCandle,
	c2: WindowCandle,
	c3: WindowCandle,
	statusMark: string,
): string[] {
	const lines: string[] = [];
	const date1 = formatDateWithDayOfWeek(c1.timestamp);
	const date2 = formatDateWithDayOfWeek(c2.timestamp);
	const date3 = formatDateWithDayOfWeek(c3.timestamp);

	lines.push(`  📍 ${date1}-${date3} に${p.pattern_jp}を検出${statusMark}（3本足パターン）`);
	for (const [label, c, dateStr] of [
		['1本目', c1, date1],
		['2本目', c2, date2],
		['3本目（確定日）', c3, date3],
	] as const) {
		const body = c.close - c.open;
		const ct = body >= 0 ? '陽線' : '陰線';
		lines.push(
			`    ${dateStr}(${label}): ${ct} 始値${formatPrice(c.open)} → 終値${formatPrice(c.close)} (実体 ${body >= 0 ? '+' : '-'}${formatPrice(Math.abs(body)).replace('¥', '')}円)`,
		);
	}

	if (p.pattern === 'morning_star') {
		const midPoint = (c1.open + c1.close) / 2;
		lines.push(`    判定: 大陰線→コマ→大陽線が1本目の中心値（${formatPrice(midPoint)}）超え → 底打ち反転`);
	} else if (p.pattern === 'evening_star') {
		const midPoint = (c1.open + c1.close) / 2;
		lines.push(`    判定: 大陽線→コマ→大陰線が1本目の中心値（${formatPrice(midPoint)}）割れ → 天井反転`);
	} else if (p.pattern === 'three_white_soldiers') {
		lines.push(`    判定: 3本連続陽線で各終値が前日を上回る → 力強い上昇トレンド`);
	} else if (p.pattern === 'three_black_crows') {
		lines.push(`    判定: 3本連続陰線で各終値が前日を下回る → 力強い下落トレンド`);
	}
	lines.push('');
	return lines;
}

/** 過去統計セクション */
function formatHistoryStats(p: DetectedCandlePattern): string[] {
	const lines: string[] = [];
	if (p.history_stats) {
		const hs = p.history_stats;
		lines.push(`  === 過去の実績（直近${hs.lookback_days}日間） ===`);
		lines.push(`    ${p.pattern_jp}の出現回数: ${hs.occurrences}回`);
		for (const [horizon, stats] of Object.entries(hs.horizons)) {
			const wins = Math.round(stats.win_rate * stats.sample);
			const losses = stats.sample - wins;
			lines.push(
				`    ${horizon}日後: 勝率${(stats.win_rate * 100).toFixed(1)}% (${wins}勝${losses}敗), 平均リターン ${stats.avg_return >= 0 ? '+' : ''}${stats.avg_return.toFixed(2)}%`,
			);
		}
		lines.push('');
	} else {
		lines.push('  === 過去の実績 ===');
		lines.push('    統計データなし（サンプル数不足または期間外）');
		lines.push('');
	}
	return lines;
}

/** パターンの読み方（固定テキスト） */
const PATTERN_GUIDE = [
	'【パターンの読み方】',
	'〈1本足〉',
	'・ハンマー: 下落局面で長い下ヒゲ→買い圧力が強く、上昇転換のサイン',
	'・シューティングスター: 上昇局面で長い上ヒゲ→売り圧力が強く、下落転換のサイン',
	'・十字線: 始値≒終値で売り買い拮抗→トレンド転換の予兆（前のトレンドの逆方向に注目）',
	'〈2本足〉',
	'・陽線包み線: 下落後に出現すると上昇転換のサイン',
	'・陰線包み線: 上昇後に出現すると下落転換のサイン',
	'・はらみ線: 大きなローソク足の中に小さなローソク足が収まる形で、トレンド転換の予兆',
	'・毛抜き天井: 高値圏で2日連続同じ高値→上昇の限界、下落転換のサイン',
	'・毛抜き底: 安値圏で2日連続同じ安値→下落の限界、上昇転換のサイン',
	'・かぶせ線: 高寄り後に陰線で前日陽線の中心以下→上昇一服、調整のサイン',
	'・切り込み線: 安寄り後に陽線で前日陰線の中心超え→下落一服、反発のサイン',
	'〈3本足〉',
	'・明けの明星: 大陰線→コマ→大陽線で底打ち反転のサイン',
	'・宵の明星: 大陽線→コマ→大陰線で天井反転のサイン',
	'・赤三兵: 3本連続陽線で力強い上昇の開始・継続',
	'・黒三兵: 3本連続陰線で力強い下落の開始・継続',
	'',
	'※勝率50%超でもリスク管理は必須です。統計は参考値であり、将来を保証するものではありません。',
].join('\n');

export function generateContent(
	patterns: DetectedCandlePattern[],
	windowCandles: WindowCandle[],
): Array<{ type: 'text'; text: string }> {
	const lines: string[] = [];

	lines.push('【ローソク足パターン分析結果】');
	lines.push('');
	lines.push(
		`分析期間: ${calendarDateFromIso(windowCandles[0]?.timestamp) ?? '?'} 〜 ${calendarDateFromIso(windowCandles[windowCandles.length - 1]?.timestamp) ?? '?'}`,
	);
	lines.push('');

	// === 1. ローソク足データ ===
	lines.push(`=== ${windowCandles.length}日間のローソク足 ===`);
	for (const c of windowCandles) {
		const dateStr = formatDateWithDayOfWeek(c.timestamp);
		const change = c.close - c.open;
		const changeSign = change >= 0 ? '+' : '-';
		const candleType = change >= 0 ? '陽線' : '陰線';
		const partialMark = c.is_partial ? ' ⚠未確定' : '';
		lines.push(
			`${dateStr}: 始値${formatPrice(c.open)} 高値${formatPrice(c.high)} 安値${formatPrice(c.low)} 終値${formatPrice(c.close)} [${candleType} ${changeSign}${formatPrice(Math.abs(change)).replace('¥', '')}円]${partialMark}`,
		);
	}
	lines.push('');

	// === 2. パターン検出結果 ===
	if (patterns.length === 0) {
		lines.push('=== 検出パターン ===');
		lines.push('なし');
		lines.push('');
		lines.push('直近の値動きには特徴的なローソク足パターンは見られませんでした。');
		lines.push('');
	} else {
		for (const p of patterns) {
			lines.push(`■ ${p.pattern_jp}（${p.pattern}）`);
			const dirLabel = DIRECTION_DETAIL_LABELS[p.direction] ?? '中立（方向性の迷い）';
			lines.push(`  方向性: ${dirLabel}`);
			lines.push(`  状態: ${p.status === 'forming' ? '形成中（終値未確定）' : '確定'}`);
			lines.push(`  強度: ${(p.strength * 100).toFixed(0)}%`);
			lines.push(`  直前トレンド: ${TREND_SHORT_LABELS[p.local_context.trend_before] ?? '中立'}`);
			lines.push('');

			// === 3. パターン該当箇所の詳細 ===
			const [idxStart, idxEnd] = p.candle_range_index;
			const spanSize = idxEnd - idxStart + 1;

			if (idxStart >= 0 && idxEnd < windowCandles.length) {
				const statusMark = p.uses_partial_candle ? '（形成中）' : '（確定）';
				lines.push('  === 検出パターンの詳細 ===');

				if (spanSize === 1) {
					lines.push(
						...format1CandleDetail(
							p,
							windowCandles[idxStart],
							formatDateWithDayOfWeek(windowCandles[idxStart].timestamp),
							statusMark,
						),
					);
				} else if (spanSize === 2) {
					lines.push(...format2CandleDetail(p, windowCandles[idxStart], windowCandles[idxEnd], statusMark));
				} else if (spanSize === 3) {
					lines.push(
						...format3CandleDetail(
							p,
							windowCandles[idxStart],
							windowCandles[idxStart + 1],
							windowCandles[idxEnd],
							statusMark,
						),
					);
				}
			}

			// === 4. 過去統計 ===
			lines.push(...formatHistoryStats(p));

			if (p.uses_partial_candle) {
				lines.push('  ⚠️ 注意: 本日の日足は未確定です。終値確定後にパターンが変化・消失する可能性があります。');
				lines.push('');
			}
		}
	}

	lines.push(PATTERN_GUIDE);

	return [{ type: 'text', text: lines.join('\n') }];
}
