import { calendarDateFromIso } from '../lib/datetime.js';
import { formatPair, formatPercent, formatPrice, timeframeLabel } from '../lib/formatter.js';
import { fail, failFromError, failFromValidation } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { extractUpstreamWarning, prependWarnings } from '../lib/warning-propagation.js';
import type { Pair } from '../src/schemas.js';
import { AnalyzeFibonacciInputSchema, AnalyzeFibonacciOutputSchema } from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import getCandles from './get_candles.js';

// ── Constants ──

/** Standard Fibonacci retracement ratios */
const RETRACEMENT_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];

/** Standard Fibonacci extension ratios */
const EXTENSION_RATIOS = [1.272, Math.SQRT2, 1.618, 2.0, 2.618];

// ── Types ──

interface NormalizedCandle {
	open: number;
	high: number;
	low: number;
	close: number;
	volume?: number;
	isoTime?: string | null;
	timestamp?: number;
}

interface SwingPoint {
	price: number;
	date: string;
	index: number;
}

interface FibLevel {
	ratio: number;
	price: number;
	distancePct: number;
	isNearest: boolean;
}

interface LevelStat {
	ratio: number;
	samplesCount: number;
	bounceRate: number;
	avgBounceReturnPct: number;
	avgBreakthroughReturnPct: number;
	medianDwellBars: number;
	confidence: 'high' | 'medium' | 'low';
}

// ── Swing Detection ──

/**
 * Detect the most significant swing high and swing low within the given candle range.
 * Uses a simple approach: find the highest high and lowest low, then determine trend
 * based on which came first.
 */
function detectSignificantSwings(candles: NormalizedCandle[]): {
	swingHigh: SwingPoint;
	swingLow: SwingPoint;
	trend: 'up' | 'down';
} {
	let highestIdx = 0;
	let lowestIdx = 0;

	for (let i = 1; i < candles.length; i++) {
		if (candles[i].high > candles[highestIdx].high) highestIdx = i;
		if (candles[i].low < candles[lowestIdx].low) lowestIdx = i;
	}

	const swingHigh: SwingPoint = {
		price: candles[highestIdx].high,
		date: calendarDateFromIso(candles[highestIdx].timestamp ?? candles[highestIdx].isoTime) ?? '',
		index: highestIdx,
	};

	const swingLow: SwingPoint = {
		price: candles[lowestIdx].low,
		date: calendarDateFromIso(candles[lowestIdx].timestamp ?? candles[lowestIdx].isoTime) ?? '',
		index: lowestIdx,
	};

	// Trend is determined by which swing came last:
	// If the low came after the high → downtrend (price fell from high to low)
	// If the high came after the low → uptrend (price rose from low to high)
	const trend: 'up' | 'down' = lowestIdx > highestIdx ? 'down' : 'up';

	return { swingHigh, swingLow, trend };
}

// ── Fibonacci Level Calculation ──

function calculateLevels(
	swingHigh: SwingPoint,
	swingLow: SwingPoint,
	trend: 'up' | 'down',
	currentPrice: number,
	ratios: number[],
): FibLevel[] {
	const range = swingHigh.price - swingLow.price;

	return ratios.map((ratio) => {
		// In downtrend: retracement goes up from low
		// In uptrend: retracement goes down from high
		const price = trend === 'down' ? swingLow.price + range * ratio : swingHigh.price - range * ratio;

		const distancePct = ((price - currentPrice) / currentPrice) * 100;

		return { ratio, price: Math.round(price), distancePct: Number(distancePct.toFixed(2)), isNearest: false };
	});
}

function calculateExtensions(
	swingHigh: SwingPoint,
	swingLow: SwingPoint,
	trend: 'up' | 'down',
	currentPrice: number,
	ratios: number[],
): FibLevel[] {
	const range = swingHigh.price - swingLow.price;

	return ratios.map((ratio) => {
		// Extensions project beyond the swing points
		// Uptrend: project above swingHigh  → swingLow + range * ratio
		// Downtrend: project below swingLow → swingHigh - range * ratio
		const price = trend === 'up' ? swingLow.price + range * ratio : swingHigh.price - range * ratio;

		const distancePct = ((price - currentPrice) / currentPrice) * 100;

		return { ratio, price: Math.round(price), distancePct: Number(distancePct.toFixed(2)), isNearest: false };
	});
}

function markNearest(levels: FibLevel[], currentPrice: number): FibLevel[] {
	if (levels.length === 0) return levels;

	let minDist = Infinity;
	let nearestIdx = 0;

	for (let i = 0; i < levels.length; i++) {
		const dist = Math.abs(levels[i].price - currentPrice);
		if (dist < minDist) {
			minDist = dist;
			nearestIdx = i;
		}
	}

	return levels.map((l, i) => ({ ...l, isNearest: i === nearestIdx }));
}

function findPosition(
	levels: FibLevel[],
	currentPrice: number,
): { aboveLevel: FibLevel | null; belowLevel: FibLevel | null; nearestLevel: FibLevel | null } {
	const sorted = [...levels].sort((a, b) => a.price - b.price);

	let aboveLevel: FibLevel | null = null;
	let belowLevel: FibLevel | null = null;
	const nearestLevel = levels.find((l) => l.isNearest) ?? null;

	for (const level of sorted) {
		if (level.price <= currentPrice) belowLevel = level;
		if (level.price > currentPrice && !aboveLevel) aboveLevel = level;
	}

	return { aboveLevel, belowLevel, nearestLevel };
}

// ── Historical Reaction Statistics (Feature #3) ──

/**
 * Analyze how price has historically reacted at each Fibonacci level.
 * Uses past candle data to count bounces vs breakthroughs at each level zone.
 */
function calculateLevelStats(candles: NormalizedCandle[], levels: FibLevel[], tolerancePct: number = 0.5): LevelStat[] {
	return levels.map((level) => {
		const zone = level.price * (tolerancePct / 100);
		const zoneMin = level.price - zone;
		const zoneMax = level.price + zone;

		let samplesCount = 0;
		let bounceCount = 0;
		const bounceReturns: number[] = [];
		const breakthroughReturns: number[] = [];
		const dwellBars: number[] = [];

		for (let i = 0; i < candles.length; i++) {
			const candle = candles[i];

			// Check if price touched the zone
			const touchedZone = candle.low <= zoneMax && candle.high >= zoneMin;
			if (!touchedZone) continue;

			samplesCount++;

			// Count dwell bars (how many consecutive bars stayed in zone)
			let dwell = 1;
			for (let j = i + 1; j < candles.length; j++) {
				if (candles[j].low <= zoneMax && candles[j].high >= zoneMin) {
					dwell++;
				} else {
					break;
				}
			}
			dwellBars.push(dwell);

			// Check what happened after touching the zone (look ahead 5 bars)
			const lookAhead = Math.min(i + dwell + 5, candles.length - 1);
			if (lookAhead <= i + dwell) continue;

			const afterCandle = candles[lookAhead];
			const returnPct = ((afterCandle.close - candle.close) / candle.close) * 100;

			// Determine if it bounced (reversed) or broke through
			const priceWasAbove = candle.close > level.price;
			const priceStayedAbove = afterCandle.close > level.price;

			if (priceWasAbove === priceStayedAbove) {
				// Bounced back to same side
				bounceCount++;
				bounceReturns.push(Math.abs(returnPct));
			} else {
				// Broke through
				breakthroughReturns.push(returnPct);
			}

			// Skip the dwell period to avoid double-counting
			i += dwell - 1;
		}

		const bounceRate = samplesCount > 0 ? bounceCount / samplesCount : 0;
		const avgBounceReturnPct =
			bounceReturns.length > 0 ? bounceReturns.reduce((a, b) => a + b, 0) / bounceReturns.length : 0;
		const avgBreakthroughReturnPct =
			breakthroughReturns.length > 0 ? breakthroughReturns.reduce((a, b) => a + b, 0) / breakthroughReturns.length : 0;

		// Median dwell bars
		const sortedDwell = [...dwellBars].sort((a, b) => a - b);
		const medianDwellBars = sortedDwell.length > 0 ? sortedDwell[Math.floor(sortedDwell.length / 2)] : 0;

		const confidence: 'high' | 'medium' | 'low' = samplesCount >= 8 ? 'high' : samplesCount >= 4 ? 'medium' : 'low';

		return {
			ratio: level.ratio,
			samplesCount,
			bounceRate: Number(bounceRate.toFixed(3)),
			avgBounceReturnPct: Number(avgBounceReturnPct.toFixed(2)),
			avgBreakthroughReturnPct: Number(avgBreakthroughReturnPct.toFixed(2)),
			medianDwellBars,
			confidence,
		};
	});
}

// ── Content Generation ──

function generateContent(
	pair: string,
	timeframe: string,
	currentPrice: number,
	trend: 'up' | 'down',
	swingHigh: SwingPoint,
	swingLow: SwingPoint,
	range: number,
	levels: FibLevel[],
	extensions: FibLevel[],
	position: { aboveLevel: FibLevel | null; belowLevel: FibLevel | null; nearestLevel: FibLevel | null },
	levelStats: LevelStat[],
	mode: string,
	lookbackDays: number,
): Array<{ type: 'text'; text: string }> {
	const lines: string[] = [];
	const pairLabel = formatPair(pair);
	const tfLabel = timeframeLabel(timeframe);

	lines.push(`【フィボナッチ分析】${pairLabel} ${tfLabel}（過去${lookbackDays}日）`);
	lines.push(`現在価格: ${formatPrice(currentPrice, pair)}`);
	lines.push(`トレンド: ${trend === 'up' ? '上昇↑' : '下降↓'}`);
	lines.push('');

	lines.push(`スイングハイ: ${formatPrice(swingHigh.price, pair)}（${swingHigh.date}）`);
	lines.push(`スイングロー: ${formatPrice(swingLow.price, pair)}（${swingLow.date}）`);
	lines.push(`レンジ幅: ${formatPrice(range, pair)}`);
	lines.push('');

	// Current position
	if (position.nearestLevel) {
		lines.push(
			`現在位置: ${(position.nearestLevel.ratio * 100).toFixed(1)}% 水準付近（距離 ${formatPercent(position.nearestLevel.distancePct, { sign: true })}）`,
		);
		if (position.belowLevel && position.aboveLevel) {
			lines.push(
				`  下: ${(position.belowLevel.ratio * 100).toFixed(1)}% = ${formatPrice(position.belowLevel.price, pair)}`,
			);
			lines.push(
				`  上: ${(position.aboveLevel.ratio * 100).toFixed(1)}% = ${formatPrice(position.aboveLevel.price, pair)}`,
			);
		}
	}
	lines.push('');

	// Retracement levels
	if (mode !== 'extension') {
		lines.push('【リトレースメント水準】');
		for (const level of levels) {
			const nearest = level.isNearest ? ' ← 最寄り' : '';
			lines.push(
				`  ${(level.ratio * 100).toFixed(1)}%: ${formatPrice(level.price, pair)} (${formatPercent(level.distancePct, { sign: true })})${nearest}`,
			);
		}
		lines.push('');
	}

	// Extension levels
	if (mode !== 'retracement' && extensions.length > 0) {
		lines.push('【エクステンション水準】');
		for (const ext of extensions) {
			lines.push(
				`  ${(ext.ratio * 100).toFixed(1)}%: ${formatPrice(ext.price, pair)} (${formatPercent(ext.distancePct, { sign: true })})`,
			);
		}
		lines.push('');
	}

	// Reaction stats — all levels with full detail
	const meaningfulStats = levelStats.filter((s) => s.samplesCount >= 1);
	if (meaningfulStats.length > 0) {
		lines.push('【過去の反応実績（各水準の統計）】');
		for (const stat of meaningfulStats) {
			const ratioLabel = `${(stat.ratio * 100).toFixed(1)}%`;
			if (stat.samplesCount === 0) {
				lines.push(`  ${ratioLabel}: データなし`);
				continue;
			}
			const bounceRatePct = (stat.bounceRate * 100).toFixed(0);
			lines.push(
				`  ${ratioLabel}: 反発率 ${bounceRatePct}%（${stat.samplesCount}回中${Math.round(stat.bounceRate * stat.samplesCount)}回反発）`,
			);
			lines.push(`    - 反発後の平均リターン: ${formatPercent(stat.avgBounceReturnPct, { sign: true })}`);
			lines.push(`    - ブレイク後の平均リターン: ${formatPercent(stat.avgBreakthroughReturnPct, { sign: true })}`);
			lines.push(`    - 水準付近の滞在足数（中央値）: ${stat.medianDwellBars}本`);
			lines.push(`    - 信頼度: ${stat.confidence}（サンプル${stat.samplesCount}件）`);
		}
		lines.push('');

		// Highlight best bounce
		const bestBounce = [...meaningfulStats]
			.filter((s) => s.samplesCount >= 2)
			.sort((a, b) => b.bounceRate - a.bounceRate)[0];
		if (bestBounce) {
			lines.push(
				`注目: ${(bestBounce.ratio * 100).toFixed(1)}% 水準が最も反発率が高い（${(bestBounce.bounceRate * 100).toFixed(0)}%、${bestBounce.samplesCount}回中）`,
			);
			lines.push('');
		}
	} else {
		lines.push('【過去の反応実績】該当データなし（分析期間内に各水準へのタッチがありませんでした）');
		lines.push('');
	}

	lines.push('【判定ロジック】');
	lines.push(`- スイング検出: 期間内の最高値・最安値を自動検出`);
	lines.push(`- トレンド判定: 高値→安値（下降）、安値→高値（上昇）の時系列順`);
	lines.push(`- リトレースメント: 0%, 23.6%, 38.2%, 50%, 61.8%, 78.6%, 100%`);
	lines.push(`- エクステンション: 127.2%, 141.4%, 161.8%, 200%, 261.8%`);
	if (meaningfulStats.length > 0) {
		lines.push(`- 反応実績: 各水準±0.5%ゾーンへのタッチを集計（過去データ）`);
	}

	return [{ type: 'text', text: lines.join('\n') }];
}

// ── Main Handler ──

export default async function analyzeFibonacci(opts: Record<string, unknown> = {}) {
	const input = AnalyzeFibonacciInputSchema.parse(opts);
	const pair = input.pair as string;
	const { type: timeframe, lookbackDays, mode, historyLookbackDays } = input;

	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk, AnalyzeFibonacciOutputSchema);

	try {
		// Fetch candle data for analysis period
		const candlesRes = await getCandles(chk.pair, timeframe, undefined, lookbackDays + 10);
		if (!candlesRes.ok) {
			return AnalyzeFibonacciOutputSchema.parse(
				fail(candlesRes.summary || 'candles failed', candlesRes.meta.errorType || 'internal'),
			);
		}

		// 上流 get_candles の meta.warning（multi-year/multi-day 部分失敗 等の取得層警告）を伝播する。
		const { warning: analysisWarning } = extractUpstreamWarning(candlesRes.meta);

		const candles: NormalizedCandle[] = candlesRes.data.normalized || [];
		if (candles.length < 10) {
			return AnalyzeFibonacciOutputSchema.parse(fail('ローソク足データが不足しています（最低10本必要）', 'data'));
		}

		const currentPrice = candles[candles.length - 1].close;

		// Detect swings
		const { swingHigh, swingLow, trend } = detectSignificantSwings(candles);
		const range = swingHigh.price - swingLow.price;

		if (range <= 0) {
			return AnalyzeFibonacciOutputSchema.parse(fail('スイングハイとスイングローの差が検出できません', 'data'));
		}

		// Calculate levels
		let levels: FibLevel[] = [];
		let extensions: FibLevel[] = [];

		if (mode !== 'extension') {
			levels = calculateLevels(swingHigh, swingLow, trend, currentPrice, RETRACEMENT_RATIOS);
			levels = markNearest(levels, currentPrice);
		}

		if (mode !== 'retracement') {
			extensions = calculateExtensions(swingHigh, swingLow, trend, currentPrice, EXTENSION_RATIOS);
		}

		const position = findPosition(levels.length > 0 ? levels : extensions, currentPrice);

		// Calculate historical reaction stats (Feature #3)
		// Fetch extended history for statistics
		let levelStats: LevelStat[] = [];
		let historyWarning: string | undefined;
		if (levels.length > 0) {
			let historyCandles: NormalizedCandle[] = candles;
			if (historyLookbackDays > lookbackDays) {
				try {
					const histRes = await getCandles(chk.pair, timeframe, undefined, historyLookbackDays + 10);
					if (histRes.ok) {
						// histRes.ok の時点で warning を抽出する（normalized が空でも warning は失わない）。
						const { warning: w } = extractUpstreamWarning(histRes.meta);
						historyWarning = w;
						if (histRes.data.normalized?.length > 0) {
							historyCandles = histRes.data.normalized;
						}
					}
				} catch {
					// Fall back to current candle data
				}
			}
			levelStats = calculateLevelStats(historyCandles, levels);
		}

		// 取得層 warning を集約。analysis / history を行単位で split → trim → Set で重複排除する
		// （部分一致行の重複も拾う）。
		const warningLines = [analysisWarning, historyWarning]
			.flatMap((w) => (w ? w.split('\n') : []))
			.map((w) => w.trim())
			.filter((w) => w.length > 0);
		const warning = warningLines.length > 0 ? [...new Set(warningLines)].join('\n') : undefined;

		// Generate content
		const rawContent = generateContent(
			chk.pair,
			timeframe,
			currentPrice,
			trend,
			swingHigh,
			swingLow,
			range,
			levels,
			extensions,
			position,
			levelStats,
			mode,
			lookbackDays,
		);

		// content[0].text 先頭に上流 warning を prepend する（JSON.stringify より前に出す）。
		// .claude/rules/tools.md の「上流 warning の伝播」参照。
		const content =
			warning && rawContent.length > 0
				? [
						{ type: 'text' as const, text: prependWarnings(rawContent[0].text, { warning }, { separator: '\n' }) },
						...rawContent.slice(1),
					]
				: rawContent;

		const nearestLabel = position.nearestLevel ? `${(position.nearestLevel.ratio * 100).toFixed(1)}%水準付近` : '';
		const baseSummary = `${formatPair(chk.pair)} フィボナッチ分析: ${trend === 'up' ? '上昇' : '下降'}トレンド、${nearestLabel}（${formatPrice(currentPrice, chk.pair)}）`;
		const summaryText = prependWarnings(baseSummary, { warning }, { separator: '\n' });

		const data = {
			pair: chk.pair,
			timeframe,
			currentPrice,
			trend,
			swingHigh,
			swingLow,
			range,
			levels,
			extensions,
			position,
			levelStats: levelStats.length > 0 ? levelStats : undefined,
		};

		const meta = createMeta(chk.pair as Pair, {
			timeframe,
			lookbackDays,
			mode,
			historyLookbackDays: levelStats.length > 0 ? historyLookbackDays : undefined,
			...(warning ? { warning } : {}),
		});

		return AnalyzeFibonacciOutputSchema.parse({
			ok: true,
			summary: summaryText,
			content,
			data,
			meta,
		});
	} catch (err: unknown) {
		return failFromError(err, {
			schema: AnalyzeFibonacciOutputSchema,
			defaultMessage: 'フィボナッチ分析中にエラーが発生しました',
		});
	}
}

// ── MCP ツール定義（tool-registry から自動収集） ──
export const toolDef: ToolDefinition = {
	name: 'analyze_fibonacci',
	description: `フィボナッチ・リトレースメント／エクステンション水準を自動計算。

【機能】
- スイングハイ・スイングローを自動検出しトレンド判定
- リトレースメント水準（0%, 23.6%, 38.2%, 50%, 61.8%, 78.6%, 100%）を算出
- エクステンション水準（127.2%, 141.4%, 161.8%, 200%, 261.8%）を算出
- 現在価格と各水準の距離（%）、最寄り水準を特定
- 過去の反応実績（反発率・平均リターン・滞在期間）を統計

【出力】
- content: LLM 向けテキスト解説
- structuredContent.data: 全水準の価格・距離%・反応統計を含む JSON
  → render_chart_svg や HTML アーティファクトで即座に可視化可能

【パラメータ】
- pair: 通貨ペア（デフォルト: btc_jpy）
- type: 時間足（デフォルト: 1day）
- lookbackDays: 分析期間（デフォルト: 90日）
- mode: retracement / extension / both（デフォルト: both）
- historyLookbackDays: 反応実績の集計期間（デフォルト: 180日）

複数タイムフレーム分析が必要な場合は analyze_mtf_fibonacci を使用。`,
	inputSchema: AnalyzeFibonacciInputSchema,
	handler: async (args: {
		pair?: string;
		type?: string;
		lookbackDays?: number;
		mode?: 'retracement' | 'extension' | 'both';
		historyLookbackDays?: number;
	}) => analyzeFibonacci(args),
};
