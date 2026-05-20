import type { z } from 'zod';
import { formatSummary } from '../lib/formatter.js';
import { avg } from '../lib/math.js';
import { fail, failFromError, failFromValidation, ok } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { extractUpstreamWarning, prependWarnings } from '../lib/warning-propagation.js';
import {
	type AnalyzeIchimokuSnapshotDataSchemaOut,
	AnalyzeIchimokuSnapshotInputSchema,
	type AnalyzeIchimokuSnapshotMetaSchemaOut,
	AnalyzeIchimokuSnapshotOutputSchema,
} from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import analyzeIndicators from './analyze_indicators.js';

export interface BuildIchimokuSnapshotTextInput {
	pair: string;
	type: string;
	close: number | null;
	pricePosition: 'above_cloud' | 'in_cloud' | 'below_cloud' | 'unknown';
	tenkan: number | null;
	kijun: number | null;
	tenkanKijun: 'bullish' | 'bearish' | 'neutral' | 'unknown';
	tkDist: number | null;
	cloudTop: number | null;
	cloudBottom: number | null;
	direction: string | null;
	thickness: number | null;
	thicknessPct: number | null;
	strength: string | null;
	futureCloudTop: number | null;
	futureCloudBottom: number | null;
	chikouSpan: { position: 'above' | 'below' | null; distance: number | null; clearance: number | null };
	sanpuku: {
		kouten: boolean;
		gyakuten: boolean;
		conditions: { priceAboveCloud: boolean; tenkanAboveKijun: boolean; chikouAbovePrice: boolean };
	};
	recentCrosses: Array<{ type: 'golden_cross' | 'death_cross'; barsAgo: number; description: string }>;
	kumoTwist: { detected: boolean; barsAgo?: number; direction?: 'bullish' | 'bearish' };
	overallSignal: string;
	overallConfidence: string;
	scenarios: {
		scenarios: {
			bullish: { condition: string; target: number; probability: string };
			bearish: { condition: string; target: number; probability: string };
		};
		keyLevels: { support: number[]; resistance: number[] };
		watchPoints: string[];
	};
	trend: {
		trendStrength: { shortTerm: number; mediumTerm: number };
		momentum: string;
	};
	cloudHistory: Array<{ barsAgo: number; position: string }>;
	// Raw numeric data for 数値データ section
	currentSpanA: number | null;
	currentSpanB: number | null;
	futureSpanA: number | null;
	futureSpanB: number | null;
	tkDistPct: number | null;
}

/** テキスト組み立て（一目均衡表スナップショット表示）— テスト可能な純粋関数 */
export function buildIchimokuSnapshotText(input: BuildIchimokuSnapshotTextInput): string {
	const {
		pair,
		type,
		close,
		pricePosition,
		tenkan,
		kijun,
		tenkanKijun,
		tkDist,
		cloudTop,
		cloudBottom,
		direction,
		thickness,
		thicknessPct,
		strength,
		futureCloudTop,
		futureCloudBottom,
		chikouSpan,
		sanpuku,
		recentCrosses,
		kumoTwist,
		overallSignal,
		overallConfidence,
		scenarios,
		trend,
		cloudHistory,
		currentSpanA,
		currentSpanB,
		futureSpanA,
		futureSpanB,
		tkDistPct,
	} = input;
	const lines: string[] = [];
	lines.push(`${String(pair).toUpperCase()} ${String(type)} 一目均衡表分析`);
	if (close != null) lines.push(`価格: ${Number(close).toLocaleString('ja-JP')}円`);
	lines.push('');
	lines.push('【基本配置】');
	if (pricePosition !== 'unknown') {
		const clr =
			close != null && cloudTop != null && cloudBottom != null
				? pricePosition === 'above_cloud'
					? close - cloudTop
					: pricePosition === 'below_cloud'
						? cloudBottom - close
						: 0
				: null;
		const clrPct = clr != null && close != null && close !== 0 ? Number(((clr / close) * 100).toFixed(2)) : null;
		lines.push(
			`・価格位置: ${pricePosition.replace('_', ' ')}${clr != null ? ` (クリアランス: ${clr >= 0 ? '+' : ''}${clr.toLocaleString('ja-JP')}円${clrPct != null ? `, ${clrPct}%` : ''})` : ''}`,
		);
	}
	if (tenkan != null)
		lines.push(
			`・転換線: ${Number(tenkan).toLocaleString('ja-JP')}円${close != null ? ` (価格比 ${Number(((tenkan - close) / close) * 100).toFixed(1)}%)` : ''}`,
		);
	if (kijun != null) lines.push(`・基準線: ${Number(kijun).toLocaleString('ja-JP')}円`);
	if (tenkan != null && kijun != null)
		lines.push(
			`・転換線と基準線: ${tenkanKijun === 'bullish' ? '強気' : tenkanKijun === 'bearish' ? '弱気' : '中立'}配置${tkDist != null ? ` (転換線が${Math.abs(tkDist).toLocaleString('ja-JP')}円${tenkan > (kijun as number) ? '上' : '下'})` : ''}`,
		);
	lines.push('');
	lines.push('【雲の状態（今日の雲）】');
	lines.push(`・雲の方向: ${direction}`);
	if (thickness != null)
		lines.push(
			`・雲の厚み: ${thickness.toLocaleString('ja-JP')}円${thicknessPct != null ? ` (${thicknessPct}%)` : ''} - ${strength ?? 'n/a'}の強度`,
		);
	if (cloudTop != null && cloudBottom != null)
		lines.push(
			`・雲の範囲: ${Number(cloudBottom).toLocaleString('ja-JP')}円 ~ ${Number(cloudTop).toLocaleString('ja-JP')}円`,
		);
	// 26日後の雲（将来の参考情報）
	if (futureCloudTop != null && futureCloudBottom != null) {
		lines.push('');
		lines.push('【26日後の雲（先行スパン）】');
		lines.push(
			`・雲の範囲: ${Number(futureCloudBottom).toLocaleString('ja-JP')}円 ~ ${Number(futureCloudTop).toLocaleString('ja-JP')}円`,
		);
		if (close != null) {
			const futurePos = close > futureCloudTop ? '雲の上' : close < futureCloudBottom ? '雲の下' : '雲の中';
			lines.push(`・現在価格との比較: ${futurePos}`);
		}
	}
	lines.push('');
	lines.push('【遅行スパン】');
	if (chikouSpan.position)
		lines.push(
			`・位置: 26本前の価格より${chikouSpan.position === 'above' ? '上' : '下'}${chikouSpan.distance != null ? ` (${chikouSpan.distance >= 0 ? '+' : ''}${chikouSpan.distance.toLocaleString('ja-JP')}円)` : ''}`,
		);
	lines.push('');
	lines.push('【シグナル分析】');
	const achieved = [
		sanpuku.conditions.priceAboveCloud,
		sanpuku.conditions.tenkanAboveKijun,
		sanpuku.conditions.chikouAbovePrice,
	].filter(Boolean).length;
	lines.push(`・三役判定: ${sanpuku.kouten ? '好転' : sanpuku.gyakuten ? '逆転' : `好転条件 ${achieved}/3 達成`}`);
	lines.push(`  ${sanpuku.conditions.priceAboveCloud ? '✓' : '✗'} 価格が雲の上`);
	lines.push(`  ${sanpuku.conditions.tenkanAboveKijun ? '✓' : '✗'} 転換線が基準線の上`);
	lines.push(`  ${sanpuku.conditions.chikouAbovePrice ? '✓' : '✗'} 遅行スパンが好転中`);
	if (recentCrosses.length) lines.push('・直近のイベント:');
	for (const ev of recentCrosses)
		lines.push(`  - ${ev.barsAgo}本前: ${ev.type === 'golden_cross' ? 'ゴールデンクロス' : 'デッドクロス'}`);
	if (kumoTwist.detected)
		lines.push(
			`・雲のねじれ: ${kumoTwist.barsAgo}本前に${kumoTwist.direction === 'bullish' ? '強気' : '弱気'}のねじれ発生`,
		);
	lines.push(`・総合評価: ${overallSignal.replace('_', ' ')} (信頼度: ${overallConfidence})`);

	// Phase 3 content additions
	lines.push('');
	lines.push('【今後の注目ポイント】');
	if (scenarios?.scenarios) {
		const bull = scenarios.scenarios.bullish;
		const bear = scenarios.scenarios.bearish;
		if (bull)
			lines.push(
				`・上昇シナリオ: ${bull.condition} → ${Number(bull.target).toLocaleString('ja-JP')}円 (可能性: ${bull.probability})`,
			);
		if (bear)
			lines.push(
				`・下落シナリオ: ${bear.condition} → ${Number(bear.target).toLocaleString('ja-JP')}円 (可能性: ${bear.probability})`,
			);
	}
	lines.push('');
	lines.push('・重要価格:');
	if (scenarios?.keyLevels?.support?.length) {
		lines.push(
			`  - サポート: ${scenarios.keyLevels.support.map((x: number) => `${Number(x).toLocaleString('ja-JP')}円`).join('、')}`,
		);
	}
	if (scenarios?.keyLevels?.resistance?.length) {
		lines.push(
			`  - レジスタンス: ${scenarios.keyLevels.resistance.map((x: number) => `${Number(x).toLocaleString('ja-JP')}円`).join('、')}`,
		);
	}
	if (Array.isArray(scenarios?.watchPoints)) {
		lines.push('');
		lines.push('・ウォッチリスト:');
		for (const wp of scenarios.watchPoints) lines.push(`  - ${wp}`);
	}

	// Phase 4 trend content (optional)
	if (trend) {
		lines.push('');
		lines.push('【トレンド分析】');
		lines.push(`・短期強度: ${trend.trendStrength.shortTerm}`);
		lines.push(`・中期強度: ${trend.trendStrength.mediumTerm}`);
		const m = trend.momentum;
		lines.push(`・モメンタム: ${m === 'accelerating' ? '加速中' : m === 'decelerating' ? '減速中' : '安定'}`);
	}

	// structuredContent.data の数値詳細もテキストに含める（LLM が読めない対策）
	lines.push('');
	lines.push('【数値データ】');
	lines.push(`転換線: ${tenkan} / 基準線: ${kijun}`);
	lines.push(
		`雲(今日): spanA=${currentSpanA} spanB=${currentSpanB} top=${cloudTop} bottom=${cloudBottom} 厚み=${thickness}`,
	);
	lines.push(`雲(26日後): spanA=${futureSpanA} spanB=${futureSpanB} top=${futureCloudTop} bottom=${futureCloudBottom}`);
	lines.push(`転換-基準: 距離=${tkDist}円 (${tkDistPct}%)`);
	if (chikouSpan.distance != null) lines.push(`遅行スパン距離: ${chikouSpan.distance}円`);
	if (cloudHistory.length > 0) {
		lines.push(
			`雲の履歴(直近${cloudHistory.length}本): ${cloudHistory.map((h) => `${h.barsAgo}=${h.position}`).join(' ')}`,
		);
	}

	return (
		lines.join('\n') +
		`\n\n---\n📌 含まれるもの: 一目均衡表の全要素（転換線・基準線・雲・遅行スパン）、三役判定、シグナル` +
		`\n📌 含まれないもの: 他のテクニカル指標（RSI・MACD・BB）、出来高フロー、板情報` +
		`\n📌 補完ツール: analyze_indicators（他指標）, analyze_bb_snapshot（BB）, get_flow_metrics（出来高）, get_orderbook（板情報）`
	);
}

export default async function analyzeIchimokuSnapshot(
	pair: string = 'btc_jpy',
	type: string = '1day',
	limit: number = 120,
	lookback: number = 10,
) {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk, AnalyzeIchimokuSnapshotOutputSchema);

	try {
		const indRes = await analyzeIndicators(chk.pair, type, Math.max(100, limit));
		if (!indRes?.ok)
			return AnalyzeIchimokuSnapshotOutputSchema.parse(
				fail(indRes?.summary || 'indicators failed', (indRes?.meta as { errorType?: string })?.errorType || 'internal'),
			) as ReturnType<typeof fail>;

		// 上流 analyze_indicators の meta.warning（取得層）と meta.warnings（計算層）を別系統で伝播する。
		const { warning, warnings } = extractUpstreamWarning(indRes.meta);

		const latest = indRes.data.indicators;
		const close = indRes.data.normalized.at(-1)?.close ?? null;
		const tenkan = latest.ICHIMOKU_conversion ?? null;
		const kijun = latest.ICHIMOKU_base ?? null;
		// 🚨 CRITICAL: 先行スパンの理解
		// - spanA/spanB（latest.ICHIMOKU_spanA/B）: 「今日計算された先行スパン」→ 26日後に表示される雲
		// - 「今日の雲」を判定するには、26本前に計算された先行スパンの値を使う必要がある
		const futureSpanA = latest.ICHIMOKU_spanA ?? null; // 26日後の雲用
		const futureSpanB = latest.ICHIMOKU_spanB ?? null; // 26日後の雲用

		// 時系列データから「今日の雲」の位置を取得
		// ichi_series.spanA/spanB は時系列データで、最新の値が「今日計算された値」
		// 「今日の雲」は26本前に計算された値なので、配列の末尾から26本前を参照
		const series = indRes.data.indicators.ichi_series;
		let currentSpanA: number | null = null;
		let currentSpanB: number | null = null;
		if (series && Array.isArray(series.spanA) && Array.isArray(series.spanB)) {
			// 配列の長さが26以上あれば、26本前（今日の雲）の値を取得
			// 先行スパンは26期間先にプロットされるため、今日の雲 = 26期間前に計算された値
			const len = Math.min(series.spanA.length, series.spanB.length);
			if (len >= 26) {
				currentSpanA = series.spanA[len - 26] ?? null;
				currentSpanB = series.spanB[len - 26] ?? null;
			}
		}

		const chikou = Array.isArray(indRes?.data?.indicators?.ichi_series?.chikou)
			? (indRes.data.indicators.ichi_series.chikou.at(-1) ?? null)
			: null;

		// 🚨 「今日の雲」（現在価格と比較する用）
		const cloudTop = currentSpanA != null && currentSpanB != null ? Math.max(currentSpanA, currentSpanB) : null;
		const cloudBottom = currentSpanA != null && currentSpanB != null ? Math.min(currentSpanA, currentSpanB) : null;

		// 「26日後の雲」（将来の参考情報）
		const futureCloudTop = futureSpanA != null && futureSpanB != null ? Math.max(futureSpanA, futureSpanB) : null;
		const futureCloudBottom = futureSpanA != null && futureSpanB != null ? Math.min(futureSpanA, futureSpanB) : null;

		// Assessments without visual claims - 「今日の雲」を使って判定
		let pricePosition: 'above_cloud' | 'in_cloud' | 'below_cloud' | 'unknown' = 'unknown';
		if (close != null && cloudTop != null && cloudBottom != null) {
			if (close > cloudTop) pricePosition = 'above_cloud';
			else if (close < cloudBottom) pricePosition = 'below_cloud';
			else pricePosition = 'in_cloud';
		}

		let tenkanKijun: 'bullish' | 'bearish' | 'neutral' | 'unknown' = 'unknown';
		if (tenkan != null && kijun != null) {
			if (tenkan > kijun) tenkanKijun = 'bullish';
			else if (tenkan < kijun) tenkanKijun = 'bearish';
			else tenkanKijun = 'neutral';
		}

		// Slope of cloud via last two spanA/spanB points when available
		let cloudSlope: 'rising' | 'falling' | 'flat' | 'unknown' = 'unknown';
		// series は上で既に定義済み
		if (series && Array.isArray(series.spanA) && Array.isArray(series.spanB)) {
			const a1 = series.spanA.at(-1),
				a2 = series.spanA.at(-2);
			const b1 = series.spanB.at(-1),
				b2 = series.spanB.at(-2);
			if (a1 != null && a2 != null && b1 != null && b2 != null) {
				const d = (a1 as number) - (a2 as number) + ((b1 as number) - (b2 as number));
				if (Math.abs(d) < 1e-6) cloudSlope = 'flat';
				else cloudSlope = d > 0 ? 'rising' : 'falling';
			}
		}

		// Cloud metrics - 「今日の雲」の厚みを使用
		const thickness =
			currentSpanA != null && currentSpanB != null
				? Math.abs((currentSpanA as number) - (currentSpanB as number))
				: null;
		const thicknessPct =
			thickness != null && close != null && close !== 0 ? Number(((thickness / close) * 100).toFixed(2)) : null;
		const direction =
			cloudSlope === 'rising' ? 'rising' : cloudSlope === 'falling' ? 'falling' : cloudSlope === 'flat' ? 'flat' : null;
		const strength =
			thicknessPct == null ? null : thicknessPct >= 2 ? 'strong' : thicknessPct >= 0.8 ? 'moderate' : 'weak';

		// Tenkan-Kijun detail
		const tkRel = tenkan != null && kijun != null ? (tenkan > kijun ? 'bullish' : 'bearish') : null;
		const tkDist = tenkan != null && kijun != null ? Number(((tenkan as number) - (kijun as number)).toFixed(0)) : null;
		const tkDistPct =
			tkDist != null && close != null && close !== 0 ? Number(((tkDist / close) * 100).toFixed(2)) : null;

		// Chikou span detail: compare to price 26 bars ago
		let chikouSpan: { position: 'above' | 'below' | null; distance: number | null; clearance: number | null } = {
			position: null,
			distance: null,
			clearance: null,
		};
		const candles = indRes.data.normalized as Array<{ close: number }>;
		if (Array.isArray(candles) && candles.length >= 27 && close != null) {
			const ref = candles.at(-27)?.close ?? null;
			if (ref != null) {
				const dist = Number((close - ref).toFixed(0));
				chikouSpan = { position: close >= ref ? 'above' : 'below', distance: dist, clearance: dist };
			}
		}

		const tags: string[] = [];
		if (pricePosition === 'above_cloud') tags.push('price_above_cloud');
		if (pricePosition === 'below_cloud') tags.push('price_below_cloud');
		if (tenkanKijun === 'bullish') tags.push('tk_bullish');
		if (tenkanKijun === 'bearish') tags.push('tk_bearish');
		if (cloudSlope === 'rising') tags.push('cloud_rising');
		if (cloudSlope === 'falling') tags.push('cloud_falling');

		const _summary = formatSummary({
			pair: chk.pair,
			latest: close ?? undefined,
			extra: `pos=${pricePosition} tk=${tenkanKijun} cloud=${cloudSlope}`,
		});

		// Signals (Phase 2)
		// 三役: 価格>雲上、転換>基準、遅行>当時価格(近似: 現在価格>26本前)
		const sanpukuConditions = {
			priceAboveCloud: pricePosition === 'above_cloud',
			tenkanAboveKijun: tenkan != null && kijun != null ? tenkan > (kijun as number) : false,
			chikouAbovePrice:
				Array.isArray(candles) && candles.length >= 27 && close != null
					? close > (candles.at(-27)?.close ?? Infinity)
					: false,
		};
		const sanpuku = {
			kouten:
				sanpukuConditions.priceAboveCloud && sanpukuConditions.tenkanAboveKijun && sanpukuConditions.chikouAbovePrice,
			gyakuten:
				pricePosition === 'below_cloud' &&
				(tenkan != null && kijun != null ? tenkan < (kijun as number) : false) &&
				(Array.isArray(candles) && candles.length >= 27 && close != null
					? close < (candles.at(-27)?.close ?? -Infinity)
					: false),
			conditions: sanpukuConditions,
		};

		// 直近クロス検出（転換線と基準線のクロスを簡易に）
		const recentCrosses: Array<{ type: 'golden_cross' | 'death_cross'; barsAgo: number; description: string }> = [];
		const spanTenkan = indRes?.data?.indicators?.ichi_series?.tenkan as number[] | undefined;
		const spanKijun = indRes?.data?.indicators?.ichi_series?.kijun as number[] | undefined;
		if (Array.isArray(spanTenkan) && Array.isArray(spanKijun) && spanTenkan.length >= 5 && spanKijun.length >= 5) {
			const L = Math.min(spanTenkan.length, spanKijun.length);
			for (let i = 1; i < Math.min(15, L - 1); i++) {
				const a1 = spanTenkan[L - 1 - (i - 1)] - spanKijun[L - 1 - (i - 1)];
				const a2 = spanTenkan[L - 1 - i] - spanKijun[L - 1 - i];
				if (a1 <= 0 && a2 > 0)
					recentCrosses.push({ type: 'golden_cross', barsAgo: i, description: `${i}本前: 転換線が基準線を上抜け` });
				if (a1 >= 0 && a2 < 0)
					recentCrosses.push({ type: 'death_cross', barsAgo: i, description: `${i}本前: 転換線が基準線を下抜け` });
				if (recentCrosses.length >= 3) break;
			}
		}

		// 雲のねじれ（spanAとspanBの順位が入れ替わる）
		let kumoTwist = {
			detected: false as boolean,
			barsAgo: undefined as number | undefined,
			direction: undefined as 'bullish' | 'bearish' | undefined,
		};
		if (Array.isArray(series?.spanA) && Array.isArray(series?.spanB)) {
			const L = Math.min(series.spanA.length, series.spanB.length);
			for (let i = 1; i < Math.min(30, L - 1); i++) {
				const aPrev = series.spanA[L - 1 - i];
				const bPrev = series.spanB[L - 1 - i];
				const aNow = series.spanA[L - 1 - (i - 1)];
				const bNow = series.spanB[L - 1 - (i - 1)];
				if (aPrev != null && bPrev != null && aNow != null && bNow != null) {
					if (aPrev <= bPrev && aNow > bNow) {
						kumoTwist = { detected: true, barsAgo: i, direction: 'bullish' };
						break;
					}
					if (aPrev >= bPrev && aNow < bNow) {
						kumoTwist = { detected: true, barsAgo: i, direction: 'bearish' };
						break;
					}
				}
			}
		}

		// 総合評価（簡易）
		const bullishScore = Number(
			(sanpuku.kouten ? 1 : 0) +
				(pricePosition === 'above_cloud' ? 0.5 : 0) +
				(tenkanKijun === 'bullish' ? 0.5 : 0) +
				(cloudSlope === 'rising' ? 0.3 : 0),
		).toFixed(2);
		let overallSignal: 'strong_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strong_bearish' = 'neutral';
		if (Number(bullishScore) >= 1.5) overallSignal = 'strong_bullish';
		else if (Number(bullishScore) >= 0.8) overallSignal = 'bullish';
		else if (pricePosition === 'below_cloud' && tenkanKijun === 'bearish' && cloudSlope === 'falling')
			overallSignal = 'strong_bearish';
		else if (pricePosition === 'below_cloud' && tenkanKijun === 'bearish') overallSignal = 'bearish';
		const overallConfidence: 'high' | 'medium' | 'low' =
			sanpuku.kouten || sanpuku.gyakuten ? 'high' : recentCrosses.length ? 'medium' : 'low';

		// Phase 4: 時系列（雲位置の履歴とトレンド強度）
		const cloudHistory: Array<{ barsAgo: number; position: 'above' | 'in' | 'below' }> = [];
		if (Array.isArray(candles) && cloudTop != null && cloudBottom != null) {
			for (let i = 0; i < Math.min(lookback, candles.length); i++) {
				const idx = candles.length - 1 - i;
				const c = candles[idx]?.close;
				if (c != null) {
					const pos = c > (cloudTop as number) ? 'above' : c < (cloudBottom as number) ? 'below' : 'in';
					cloudHistory.push({ barsAgo: i, position: pos });
				}
			}
		}
		// 簡易トレンド強度: 直近/中期での雲クリアランス平均
		const avgOrZero = (arr: number[]) => avg(arr) ?? 0;
		let shortTerm = 0,
			mediumTerm = 0;
		if (Array.isArray(candles) && cloudTop != null && cloudBottom != null) {
			const st = candles.slice(-Math.min(lookback, candles.length));
			const mt = candles.slice(-Math.min(lookback * 2, candles.length));
			const clearanceSt = st.map((x) =>
				x.close > (cloudTop as number)
					? x.close - (cloudTop as number)
					: x.close < (cloudBottom as number)
						? ((cloudBottom as number) - x.close) * -1
						: 0,
			);
			const clearanceMt = mt.map((x) =>
				x.close > (cloudTop as number)
					? x.close - (cloudTop as number)
					: x.close < (cloudBottom as number)
						? ((cloudBottom as number) - x.close) * -1
						: 0,
			);
			const norm = (v: number) => Math.max(-100, Math.min(100, Math.round((v / (close || 1)) * 10000)));
			shortTerm = norm(avgOrZero(clearanceSt));
			mediumTerm = norm(avgOrZero(clearanceMt));
		}
		const momentumTrend: 'accelerating' | 'steady' | 'decelerating' =
			shortTerm > mediumTerm + 10 ? 'accelerating' : shortTerm < mediumTerm - 10 ? 'decelerating' : 'steady';

		const data = {
			latest: {
				close,
				tenkan,
				kijun,
				// 「今日の雲」（現在価格と比較する用）
				spanA: currentSpanA,
				spanB: currentSpanB,
				cloudTop,
				cloudBottom,
				// 「26日後の雲」（将来の参考情報）
				futureSpanA,
				futureSpanB,
				futureCloudTop,
				futureCloudBottom,
				chikou,
			},
			assessment: { pricePosition, tenkanKijun, cloudSlope },
			cloud: { thickness, thicknessPct, direction, strength, upperBound: cloudTop, lowerBound: cloudBottom },
			tenkanKijunDetail: { relationship: tkRel, distance: tkDist, distancePct: tkDistPct },
			chikouSpan,
			trend: { cloudHistory, trendStrength: { shortTerm, mediumTerm }, momentum: momentumTrend },
			signals: { sanpuku, recentCrosses, kumoTwist, overallSignal, confidence: overallConfidence },
			scenarios: {
				keyLevels: {
					resistance: [cloudTop ?? 0].filter(Boolean) as number[],
					support: [cloudBottom ?? 0].filter(Boolean) as number[],
					cloudEntry: cloudTop ?? 0,
					cloudExit: cloudBottom ?? 0,
				},
				scenarios: {
					bullish: {
						condition: '転換線が基準線を上抜け',
						target: close != null ? Math.round((close as number) * 1.07) : 0,
						probability: 'medium',
					},
					bearish: {
						condition: '雲突入（雲上限割れ）',
						target: cloudBottom != null ? Math.round((cloudBottom as number) * 0.97) : 0,
						probability: 'low',
					},
				},
				watchPoints: ['転換線と基準線のクロス', '雲の厚みの推移（薄い箇所）'],
			},
			tags,
		};

		const meta = createMeta(chk.pair, {
			type,
			count: indRes.data.normalized.length,
			...(warning ? { warning } : {}),
			...(warnings && warnings.length > 0 ? { warnings } : {}),
		});
		const baseText = buildIchimokuSnapshotText({
			pair: chk.pair,
			type,
			close,
			pricePosition,
			tenkan,
			kijun,
			tenkanKijun,
			tkDist,
			cloudTop,
			cloudBottom,
			direction,
			thickness,
			thicknessPct,
			strength,
			futureCloudTop,
			futureCloudBottom,
			chikouSpan,
			sanpuku,
			recentCrosses,
			kumoTwist,
			overallSignal,
			overallConfidence,
			scenarios: {
				scenarios: data.scenarios.scenarios,
				keyLevels: { support: data.scenarios.keyLevels.support, resistance: data.scenarios.keyLevels.resistance },
				watchPoints: data.scenarios.watchPoints,
			},
			trend: { trendStrength: data.trend.trendStrength, momentum: data.trend.momentum },
			cloudHistory,
			currentSpanA,
			currentSpanB,
			futureSpanA,
			futureSpanB,
			tkDistPct,
		});
		const text = prependWarnings(baseText, { warning, warnings }, { separator: '\n' });
		return AnalyzeIchimokuSnapshotOutputSchema.parse(
			ok(
				text,
				data as z.infer<typeof AnalyzeIchimokuSnapshotDataSchemaOut>,
				meta as z.infer<typeof AnalyzeIchimokuSnapshotMetaSchemaOut>,
			),
		);
	} catch (e: unknown) {
		return failFromError(e, { schema: AnalyzeIchimokuSnapshotOutputSchema });
	}
}

// ── MCP ツール定義（tool-registry から自動収集） ──
export const toolDef: ToolDefinition = {
	name: 'analyze_ichimoku_snapshot',
	description:
		'[Ichimoku Cloud] 一目均衡表（Ichimoku / cloud / kumo / tenkan-kijun）の数値スナップショット。価格と雲の位置関係・転換線/基準線クロス・雲の傾きを数値で返す。\n\n⚠️ 最新値のみ。時系列チャート描画 → prepare_chart_data（indicators: ["ICHIMOKU"]）。',
	inputSchema: AnalyzeIchimokuSnapshotInputSchema,
	handler: async ({
		pair,
		type,
		limit,
		lookback,
	}: {
		pair?: string;
		type?: string;
		limit?: number;
		lookback?: number;
	}) => analyzeIchimokuSnapshot(pair, type, limit, lookback),
};
