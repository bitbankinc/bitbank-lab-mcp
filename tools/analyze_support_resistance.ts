import { calendarDateFromIso, dayjs } from '../lib/datetime.js';
import { formatSummary } from '../lib/formatter.js';
import { fail, failFromError, failFromValidation } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { AnalyzeSupportResistanceInputSchema, AnalyzeSupportResistanceOutputSchema } from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import getCandles from './get_candles.js';

export interface AnalyzeSupportResistanceOptions {
	lookbackDays?: number;
	topN?: number;
	tolerance?: number;
}

export interface TouchEvent {
	date: string;
	price: number;
	bounceStrength: number; // ヒゲの長さ%
	type: 'support' | 'resistance';
}

export interface SupportResistanceLevel {
	price: number;
	pctFromCurrent: number;
	strength: number; // 1-3
	label: string;
	touchCount: number;
	touches: TouchEvent[];
	recentBreak?: {
		date: string;
		price: number;
		breakPct: number;
	};
	type: 'support' | 'resistance'; // タイプ
	formationType?: 'traditional' | 'new_formation' | 'role_reversal'; // 形成タイプ
	volumeBoost?: boolean; // 出来高による補強
	note?: string; // 補足説明
}

type SrCandle = {
	isoTime?: string | null;
	timestamp?: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume?: number;
};

/** 表示・集計用の暦日（既定 JST）。isoTime の UTC 日付切り出しは使わない。 */
function srCalendarDate(c: SrCandle): string {
	return calendarDateFromIso(c.timestamp ?? c.isoTime) ?? '';
}

/** スイングポイント（ピボット）を検出: 左右 depth 本より高値/安値が突出した足 */
function detectSwingPoints(
	candles: SrCandle[],
	depth: number = 5,
): {
	swingHighs: Array<{ index: number; date: string; price: number; bounceStrength: number }>;
	swingLows: Array<{ index: number; date: string; price: number; bounceStrength: number }>;
} {
	const swingHighs: Array<{ index: number; date: string; price: number; bounceStrength: number }> = [];
	const swingLows: Array<{ index: number; date: string; price: number; bounceStrength: number }> = [];

	for (let i = depth; i < candles.length - depth; i++) {
		// スイングハイ: 左右 depth 本より高値が高い
		let isSwingHigh = true;
		for (let j = i - depth; j <= i + depth; j++) {
			if (j === i) continue;
			if (candles[j].high >= candles[i].high) {
				isSwingHigh = false;
				break;
			}
		}
		if (isSwingHigh) {
			swingHighs.push({
				index: i,
				date: srCalendarDate(candles[i]),
				price: candles[i].high,
				bounceStrength: ((candles[i].high - candles[i].close) / candles[i].high) * 100,
			});
		}

		// スイングロー: 左右 depth 本より安値が低い
		let isSwingLow = true;
		for (let j = i - depth; j <= i + depth; j++) {
			if (j === i) continue;
			if (candles[j].low <= candles[i].low) {
				isSwingLow = false;
				break;
			}
		}
		if (isSwingLow) {
			swingLows.push({
				index: i,
				date: srCalendarDate(candles[i]),
				price: candles[i].low,
				bounceStrength: ((candles[i].close - candles[i].low) / candles[i].low) * 100,
			});
		}
	}

	return { swingHighs, swingLows };
}

/** 近接するスイングポイントを %ベースでクラスタリング（凝集型） */
function clusterSwingPoints(
	points: Array<{ date: string; price: number; bounceStrength: number }>,
	tolerance: number,
): Array<{ level: number; points: Array<{ date: string; price: number; bounceStrength: number }> }> {
	if (points.length === 0) return [];

	const sorted = [...points].sort((a, b) => a.price - b.price);
	const clusters: Array<{ prices: number[]; points: Array<{ date: string; price: number; bounceStrength: number }> }> =
		[];
	let current = { prices: [sorted[0].price], points: [sorted[0]] };

	for (let i = 1; i < sorted.length; i++) {
		const avg = current.prices.reduce((a, b) => a + b, 0) / current.prices.length;
		if (Math.abs(sorted[i].price - avg) / avg <= tolerance) {
			current.prices.push(sorted[i].price);
			current.points.push(sorted[i]);
		} else {
			clusters.push(current);
			current = { prices: [sorted[i].price], points: [sorted[i]] };
		}
	}
	clusters.push(current);

	return clusters.map((c) => ({
		level: Math.round(c.prices.reduce((a, b) => a + b, 0) / c.prices.length),
		points: c.points,
	}));
}

/** スイングポイントベースで S/R レベルを検出し、各レベルのタッチ回数をカウント */
function findPriceLevels(
	candles: SrCandle[],
	tolerance: number,
	depth: number = 5,
): { supports: Map<number, TouchEvent[]>; resistances: Map<number, TouchEvent[]> } {
	if (candles.length < 2 * depth + 1) {
		return { supports: new Map(), resistances: new Map() };
	}

	const { swingHighs, swingLows } = detectSwingPoints(candles, depth);

	const supportClusters = clusterSwingPoints(
		swingLows.map((p) => ({ date: p.date, price: p.price, bounceStrength: p.bounceStrength })),
		tolerance,
	);
	const resistanceClusters = clusterSwingPoints(
		swingHighs.map((p) => ({ date: p.date, price: p.price, bounceStrength: p.bounceStrength })),
		tolerance,
	);

	// 各サポートレベルに対してゾーン内のタッチを全ローソク足からカウント
	const supports = new Map<number, TouchEvent[]>();
	for (const cluster of supportClusters) {
		const zoneMin = cluster.level * (1 - tolerance);
		const zoneMax = cluster.level * (1 + tolerance);
		const touches: TouchEvent[] = [];
		const seenDates = new Set<string>();

		for (const candle of candles) {
			const date = srCalendarDate(candle);
			if (seenDates.has(date)) continue;
			if (candle.low >= zoneMin && candle.low <= zoneMax && candle.close > candle.low) {
				touches.push({
					date,
					price: candle.low,
					bounceStrength: ((candle.close - candle.low) / candle.low) * 100,
					type: 'support',
				});
				seenDates.add(date);
			}
		}
		supports.set(cluster.level, touches);
	}

	// 各レジスタンスレベルに対してゾーン内のタッチを全ローソク足からカウント
	const resistances = new Map<number, TouchEvent[]>();
	for (const cluster of resistanceClusters) {
		const zoneMin = cluster.level * (1 - tolerance);
		const zoneMax = cluster.level * (1 + tolerance);
		const touches: TouchEvent[] = [];
		const seenDates = new Set<string>();

		for (const candle of candles) {
			const date = srCalendarDate(candle);
			if (seenDates.has(date)) continue;
			if (candle.high >= zoneMin && candle.high <= zoneMax && candle.close < candle.high) {
				touches.push({
					date,
					price: candle.high,
					bounceStrength: ((candle.high - candle.close) / candle.high) * 100,
					type: 'resistance',
				});
				seenDates.add(date);
			}
		}
		resistances.set(cluster.level, touches);
	}

	return { supports, resistances };
}

function detectRecentBreak(
	level: number,
	type: 'support' | 'resistance',
	candles: SrCandle[],
	recentDays: number = 7,
): { date: string; price: number; breakPct: number } | undefined {
	const recentCutoff = dayjs().subtract(recentDays, 'day');
	const recentCandles = candles.filter((c) => dayjs(c.isoTime).isAfter(recentCutoff));

	// 偽ブレイクアウト検出用の平均出来高
	const avgVolume = candles.reduce((sum, c) => sum + (c.volume || 0), 0) / (candles.length || 1);

	for (let i = 0; i < recentCandles.length; i++) {
		const candle = recentCandles[i];
		// 終値ベースで判定（ヒゲのみの突破はテストとして除外）
		const isBreak = type === 'support' ? candle.close < level * 0.99 : candle.close > level * 1.01;
		if (!isBreak) continue;

		// 低出来高の突破 → 翌日の終値で確認（偽ブレイクアウト防止）
		if (avgVolume > 0 && (candle.volume || 0) < avgVolume) {
			const next = recentCandles[i + 1];
			const nextConfirms = next && (type === 'support' ? next.close < level * 0.99 : next.close > level * 1.01);
			if (!nextConfirms) continue;
		}

		const breakPct = ((candle.close - level) / level) * 100;
		return {
			date: srCalendarDate(candle),
			price: candle.close,
			breakPct,
		};
	}

	return undefined;
}

function detectNewSupport(
	candles: SrCandle[],
	recentDays: number = 10,
): Array<{ price: number; date: string; volumeBoost: boolean; note: string }> {
	const recentCutoff = dayjs().subtract(recentDays, 'day');
	const recentCandles = candles.filter((c) => dayjs(c.isoTime).isAfter(recentCutoff));

	const newSupports: Array<{ price: number; date: string; volumeBoost: boolean; note: string }> = [];

	// 平均出来高計算
	const avgVolume = recentCandles.reduce((sum, c) => sum + (c.volume || 0), 0) / recentCandles.length;

	for (let i = 1; i < recentCandles.length - 1; i++) {
		const current = recentCandles[i];
		const prev = recentCandles[i - 1];
		const next = recentCandles[i + 1];

		// 安値が2日以上連続で切り上がっているかチェック
		if (current.low < prev.low && next.low > current.low) {
			// その最安値を以降割っていないかチェック
			const subsequentCandles = recentCandles.slice(i + 1);
			const lowestSubsequent = Math.min(...subsequentCandles.map((c) => c.low));

			if (lowestSubsequent >= current.low * 0.999) {
				// 0.1%の許容誤差
				const volumeBoost = (current.volume || 0) > avgVolume * 1.5;

				// V字反発の検出
				const prevDrop = ((current.close - prev.close) / prev.close) * 100;
				const nextRise = ((next.close - current.close) / current.close) * 100;
				let note = '新サポート形成（安値切り上げ）';

				if (prevDrop < -3 && nextRise > 3) {
					note = 'V字反発によるサポート形成';
				} else if (volumeBoost) {
					note = '大出来高での反発（新サポート）';
				}

				newSupports.push({
					price: current.low,
					date: srCalendarDate(current),
					volumeBoost,
					note,
				});
			}
		}
	}

	return newSupports;
}

function detectRoleReversal(
	brokenSupports: Map<number, { date: string; price: number }>,
	brokenResistances: Map<number, { date: string; price: number }>,
	_candles: SrCandle[],
	currentPrice: number,
): { newResistances: Map<number, string>; newSupports: Map<number, string> } {
	const newResistances = new Map<number, string>();
	const newSupports = new Map<number, string>();

	// 崩壊したサポート → レジスタンス転換
	for (const [level, breakInfo] of brokenSupports.entries()) {
		if (level > currentPrice) {
			// 現在価格より上
			newResistances.set(level, `元サポート（${breakInfo.date}に崩壊）→ レジスタンス転換`);
		}
	}

	// 突破されたレジスタンス → サポート転換
	for (const [level, breakInfo] of brokenResistances.entries()) {
		if (level < currentPrice) {
			// 現在価格より下
			newSupports.set(level, `元レジスタンス（${breakInfo.date}に突破）→ サポート転換`);
		}
	}

	return { newResistances, newSupports };
}

/** タッチの直近性スコアを計算（半減期ベースの指数減衰） */
function computeRecencyScore(touches: TouchEvent[], referenceDate: string, halfLifeDays: number = 30): number {
	const ref = dayjs(referenceDate);
	return touches.reduce((score, t) => {
		const daysAgo = Math.max(0, ref.diff(dayjs(t.date), 'day'));
		return score + Math.exp((-Math.LN2 * daysAgo) / halfLifeDays);
	}, 0);
}

/** ロールリバーサル後のプルバック確認 */
function hasPullbackConfirmation(
	level: number,
	type: 'support_to_resistance' | 'resistance_to_support',
	breakDate: string,
	candles: SrCandle[],
	tolerance: number,
): boolean {
	const breakIdx = candles.findIndex((c) => srCalendarDate(c) >= breakDate);
	if (breakIdx < 0) return false;
	const afterBreak = candles.slice(breakIdx + 1);

	if (type === 'support_to_resistance') {
		// 旧サポート崩壊 → レジスタンス転換: 高値がレベル付近に達したが終値はレベル以下
		return afterBreak.some((c) => c.high >= level * (1 - tolerance) && c.close < level);
	} else {
		// 旧レジスタンス突破 → サポート転換: 安値がレベル付近に達したが終値はレベル以上
		return afterBreak.some((c) => c.low <= level * (1 + tolerance) && c.close > level);
	}
}

function calculateStrength(opts: {
	touchCount: number;
	recencyScore: number;
	avgBounceStrength: number;
	hasRecentBreak: boolean;
	volumeBoost: boolean;
	formationType: 'traditional' | 'new_formation' | 'role_reversal';
	pullbackConfirmed: boolean;
}): number {
	const { touchCount, recencyScore, avgBounceStrength, hasRecentBreak, volumeBoost, formationType, pullbackConfirmed } =
		opts;
	let strength = 1;

	if (formationType === 'new_formation') {
		// 新形成は基本★★
		strength = 2;
		if (volumeBoost) strength = 3;
	} else if (formationType === 'role_reversal') {
		// ロールリバーサルは基本★、プルバック確認で★★
		strength = pullbackConfirmed ? 2 : 1;
	} else {
		// 従来型：接触回数ベース
		if (touchCount >= 5) strength = 3;
		else if (touchCount >= 3) strength = 2;
		else strength = 1;

		// 直近性スコアで強化（半減期30日、スコア1.5 ≈ 直近2回相当）
		if (recencyScore >= 1.5 && touchCount >= 3) strength = Math.min(3, strength + 1);

		// 反発の大きさで強化（平均反発2%以上）
		if (avgBounceStrength >= 2.0 && strength < 3) strength += 1;

		// 出来高補強
		if (volumeBoost && strength < 3) strength += 1;

		// 直近崩壊で減格
		if (hasRecentBreak && strength > 1) strength -= 1;
	}

	return Math.max(1, Math.min(3, strength));
}

export default async function analyzeSupportResistance(
	pair: string = 'btc_jpy',
	{ lookbackDays = 90, topN = 3, tolerance = 0.015 }: AnalyzeSupportResistanceOptions = {},
) {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk, AnalyzeSupportResistanceOutputSchema);

	try {
		// ローソク足データ取得
		const candlesRes = await getCandles(chk.pair, '1day', undefined, lookbackDays + 10);
		if (!candlesRes.ok) {
			return AnalyzeSupportResistanceOutputSchema.parse(
				fail(candlesRes.summary || 'candles failed', candlesRes.meta.errorType || 'internal'),
			);
		}

		const candles = candlesRes.data.normalized || [];
		if (candles.length === 0) {
			return AnalyzeSupportResistanceOutputSchema.parse(fail('No candle data available', 'data'));
		}

		// lookbackDays 範囲のローソク足のみを分析対象にする（バッファは除外）
		const analysisCandles = candles.length > lookbackDays ? candles.slice(-lookbackDays) : candles;

		const currentCandle = analysisCandles[analysisCandles.length - 1];
		const currentPrice = currentCandle.close;

		// 価格レベル検出（lookbackDays 範囲のみ）
		const { supports, resistances } = findPriceLevels(analysisCandles, tolerance);

		// 新サポート形成の検出
		const newSupports = detectNewSupport(analysisCandles, 10);

		// 崩壊・突破を記録
		const brokenSupports = new Map<number, { date: string; price: number }>();
		const brokenResistances = new Map<number, { date: string; price: number }>();

		for (const [level] of supports.entries()) {
			const recentBreak = detectRecentBreak(level, 'support', analysisCandles, 30);
			if (recentBreak) {
				brokenSupports.set(level, { date: recentBreak.date, price: recentBreak.price });
			}
		}

		for (const [level] of resistances.entries()) {
			const recentBreak = detectRecentBreak(level, 'resistance', analysisCandles, 30);
			if (recentBreak) {
				brokenResistances.set(level, { date: recentBreak.date, price: recentBreak.price });
			}
		}

		// ロールリバーサル検出
		const { newResistances, newSupports: roleReversalSupports } = detectRoleReversal(
			brokenSupports,
			brokenResistances,
			analysisCandles,
			currentPrice,
		);

		// 平均出来高計算
		const avgVolume =
			analysisCandles.reduce((sum: number, c: SrCandle) => sum + (c.volume || 0), 0) / analysisCandles.length;

		// サポートレベルを評価
		const supportLevels: SupportResistanceLevel[] = [];

		// A. 従来型サポート（崩壊していないもの）
		for (const [level, touches] of supports.entries()) {
			const pctFromCurrent = ((level - currentPrice) / currentPrice) * 100;

			if (pctFromCurrent >= 0) continue;
			if (Math.abs(pctFromCurrent) > 20) continue;
			if (touches.length < 2) continue;

			const recencyScore = computeRecencyScore(touches, currentCandle.isoTime ?? '');
			const avgBounce = touches.reduce((sum, t) => sum + t.bounceStrength, 0) / (touches.length || 1);

			const recentBreak = detectRecentBreak(level, 'support', analysisCandles, 7);
			if (recentBreak) continue; // 直近7日で崩壊したものは除外

			const volumeBoost = touches.some((t) => {
				const c = analysisCandles.find((c: SrCandle) => srCalendarDate(c) === t.date);
				return c && (c.volume || 0) > avgVolume * 1.5;
			});

			const strength = calculateStrength({
				touchCount: touches.length,
				recencyScore,
				avgBounceStrength: avgBounce,
				hasRecentBreak: false,
				volumeBoost,
				formationType: 'traditional',
				pullbackConfirmed: false,
			});

			supportLevels.push({
				price: level,
				pctFromCurrent,
				strength,
				label: '',
				touchCount: touches.length,
				touches,
				type: 'support',
				formationType: 'traditional',
				volumeBoost,
			});
		}

		// B. 新形成サポート
		for (const newSup of newSupports) {
			const pctFromCurrent = ((newSup.price - currentPrice) / currentPrice) * 100;
			if (pctFromCurrent >= 0 || Math.abs(pctFromCurrent) > 20) continue;

			const isDuplicate = supportLevels.some((s) => Math.abs(s.price - newSup.price) < newSup.price * tolerance);
			if (isDuplicate) continue;

			const strength = calculateStrength({
				touchCount: 0,
				recencyScore: 0,
				avgBounceStrength: 0,
				hasRecentBreak: false,
				volumeBoost: newSup.volumeBoost,
				formationType: 'new_formation',
				pullbackConfirmed: false,
			});

			supportLevels.push({
				price: newSup.price,
				pctFromCurrent,
				strength,
				label: '',
				touchCount: 1,
				touches: [{ date: newSup.date, price: newSup.price, bounceStrength: 0, type: 'support' }],
				type: 'support',
				formationType: 'new_formation',
				volumeBoost: newSup.volumeBoost,
				note: newSup.note,
			});
		}

		// C. ロールリバーサル（元レジスタンス → サポート転換）
		for (const [level, note] of roleReversalSupports.entries()) {
			const pctFromCurrent = ((level - currentPrice) / currentPrice) * 100;
			if (pctFromCurrent >= 0 || Math.abs(pctFromCurrent) > 20) continue;

			const isDuplicate = supportLevels.some((s) => Math.abs(s.price - level) < level * tolerance);
			if (isDuplicate) continue;

			const breakInfo = brokenResistances.get(level);
			const pullbackConfirmed = breakInfo
				? hasPullbackConfirmation(level, 'resistance_to_support', breakInfo.date, analysisCandles, tolerance)
				: false;

			const strength = calculateStrength({
				touchCount: 0,
				recencyScore: 0,
				avgBounceStrength: 0,
				hasRecentBreak: false,
				volumeBoost: false,
				formationType: 'role_reversal',
				pullbackConfirmed,
			});

			supportLevels.push({
				price: level,
				pctFromCurrent,
				strength,
				label: '',
				touchCount: 1,
				touches: [],
				type: 'support',
				formationType: 'role_reversal',
				note,
			});
		}

		// レジスタンスレベルを評価
		const resistanceLevels: SupportResistanceLevel[] = [];

		// A. 従来型レジスタンス（突破されていないもの）
		for (const [level, touches] of resistances.entries()) {
			const pctFromCurrent = ((level - currentPrice) / currentPrice) * 100;

			if (pctFromCurrent <= 0) continue;
			if (Math.abs(pctFromCurrent) > 20) continue;
			if (touches.length < 2) continue;

			const recencyScore = computeRecencyScore(touches, currentCandle.isoTime ?? '');
			const avgBounce = touches.reduce((sum, t) => sum + t.bounceStrength, 0) / (touches.length || 1);

			const recentBreak = detectRecentBreak(level, 'resistance', analysisCandles, 7);
			if (recentBreak) continue; // 直近7日で突破されたものは除外

			const volumeBoost = touches.some((t) => {
				const c = analysisCandles.find((c: SrCandle) => srCalendarDate(c) === t.date);
				return c && (c.volume || 0) > avgVolume * 1.5;
			});

			const strength = calculateStrength({
				touchCount: touches.length,
				recencyScore,
				avgBounceStrength: avgBounce,
				hasRecentBreak: false,
				volumeBoost,
				formationType: 'traditional',
				pullbackConfirmed: false,
			});

			resistanceLevels.push({
				price: level,
				pctFromCurrent,
				strength,
				label: '',
				touchCount: touches.length,
				touches,
				type: 'resistance',
				formationType: 'traditional',
				volumeBoost,
			});
		}

		// B. ロールリバーサル（元サポート → レジスタンス転換）
		for (const [level, note] of newResistances.entries()) {
			const pctFromCurrent = ((level - currentPrice) / currentPrice) * 100;
			if (pctFromCurrent <= 0 || Math.abs(pctFromCurrent) > 20) continue;

			const isDuplicate = resistanceLevels.some((r) => Math.abs(r.price - level) < level * tolerance);
			if (isDuplicate) continue;

			const breakInfo = brokenSupports.get(level);
			const pullbackConfirmed = breakInfo
				? hasPullbackConfirmation(level, 'support_to_resistance', breakInfo.date, analysisCandles, tolerance)
				: false;

			const strength = calculateStrength({
				touchCount: 0,
				recencyScore: 0,
				avgBounceStrength: 0,
				hasRecentBreak: false,
				volumeBoost: false,
				formationType: 'role_reversal',
				pullbackConfirmed,
			});

			resistanceLevels.push({
				price: level,
				pctFromCurrent,
				strength,
				label: '',
				touchCount: 1,
				touches: [],
				type: 'resistance',
				formationType: 'role_reversal',
				note,
			});
		}

		// ソート（現在価格に近い順、同じ距離なら強度順）
		supportLevels.sort((a, b) => {
			const distA = Math.abs(a.pctFromCurrent);
			const distB = Math.abs(b.pctFromCurrent);
			if (Math.abs(distA - distB) < 0.5) {
				return b.strength - a.strength;
			}
			return distA - distB;
		});

		resistanceLevels.sort((a, b) => {
			const distA = Math.abs(a.pctFromCurrent);
			const distB = Math.abs(b.pctFromCurrent);
			if (Math.abs(distA - distB) < 0.5) {
				return b.strength - a.strength;
			}
			return distA - distB;
		});

		// 有効なレベルのみ出力（topN個まで、無理に埋めない）
		const topSupports = supportLevels.slice(0, Math.min(supportLevels.length, topN));
		const topResistances = resistanceLevels.slice(0, Math.min(resistanceLevels.length, topN));

		// ラベルを付与（タイプに関わらず統一表記）
		topSupports.forEach((level) => {
			level.label = `サポート`;
		});

		topResistances.forEach((level) => {
			level.label = `レジスタンス`;
		});

		// content生成（LLMが読みやすいフォーマット）
		const formatLevel = (level: SupportResistanceLevel, type: 'support' | 'resistance') => {
			// 3段階表記：★☆☆ / ★★☆ / ★★★
			const stars = '★'.repeat(level.strength) + '☆'.repeat(3 - level.strength);
			let text = `${level.label}: ${level.price.toLocaleString('ja-JP')}円（${level.pctFromCurrent > 0 ? '+' : ''}${level.pctFromCurrent.toFixed(1)}%）強度：${stars}\n`;

			// 形成タイプに応じた平易な説明
			if (level.formationType === 'new_formation') {
				// 新形成サポート
				text += `  - 背景: ${level.note || '直近で底を打ち、安値を切り上げ中'}\n`;
				if (level.volumeBoost) {
					text += `  - 特徴: 大出来高での反発（平均の1.5倍以上）\n`;
				}
				text += `  - 意義: 直近の最安値、形成されたばかりの下支え\n`;
			} else if (level.formationType === 'role_reversal') {
				// ロールリバーサル
				if (type === 'support') {
					text += `  - 背景: ${level.note || '以前に上抜けした価格帯。現在は「上抜け後の下支え」として機能する可能性'}\n`;
					if (level.strength >= 2) {
						text += `  - 確認: プルバック後に価格がレベル上で維持（信頼性向上）\n`;
					} else {
						text += `  - 注意: プルバック未確認、再割れリスクあり\n`;
					}
				} else {
					text += `  - 背景: ${level.note || '以前に崩壊した価格帯。現在は「戻り売りポイント」として機能する可能性'}\n`;
					if (level.strength >= 2) {
						text += `  - 確認: プルバック後に価格がレベル下で維持（信頼性向上）\n`;
					} else {
						text += `  - 注意: プルバック未確認、再突破される可能性あり\n`;
					}
				}
			} else {
				// 従来型
				text += `  - 実績: ${level.touchCount}回の反応`;
				if (level.touches.length > 0) {
					const dates = level.touches
						.slice(-3)
						.map((t) => t.date)
						.join(', ');
					text += `（最近: ${dates}）`;
				}
				text += `\n`;
				if (level.volumeBoost) {
					text += `  - 特徴: 大出来高での反応あり（強度補強済み）\n`;
				}
				text += `  - 意義: 過去の実績から信頼性高い\n`;
			}

			if (level.recentBreak) {
				text += `  - ⚠️ 直近の崩壊: ${level.recentBreak.date}に${Math.abs(level.recentBreak.breakPct).toFixed(1)}%${type === 'support' ? '下抜け' : '上抜け'}（${type === 'support' ? '最安' : '最高'}${level.recentBreak.price.toLocaleString('ja-JP')}円）\n`;
				text += `  - 評価: 崩壊実績により信頼性低下、${type === 'support' ? '再割れ' : '再突破'}リスク高\n`;
			}

			return text;
		};

		const displayPair = chk.pair.replace('_', '/').toUpperCase();
		let contentText = `${displayPair} サポート・レジスタンス分析（過去${lookbackDays}日）\n`;
		contentText += `現在価格: ${currentPrice.toLocaleString('ja-JP')}円\n`;
		contentText += `分析日時: ${srCalendarDate(currentCandle)}\n\n`;

		contentText += `【サポートライン】\n`;
		if (topSupports.length === 0) {
			contentText += `  明確なサポートラインは検出されませんでした\n`;
		} else {
			topSupports.forEach((level) => {
				contentText += `${formatLevel(level, 'support')}\n`;
			});
		}

		contentText += `\n【レジスタンスライン】\n`;
		if (topResistances.length === 0) {
			contentText += `  明確なレジスタンスラインは検出されませんでした\n`;
		} else {
			topResistances.forEach((level) => {
				contentText += `${formatLevel(level, 'resistance')}\n`;
			});
		}

		contentText += `\n【判定ロジック】\n`;
		contentText += `A. 従来型: ピボット検出（左右5本）→ ${(tolerance * 100).toFixed(1)}%クラスタリング → タッチ2回以上、直近7日で崩壊なし\n`;
		contentText += `B. 新形成: 安値2日以上切り上げ + 以降割れなし（出来高1.5倍以上で強度+1）\n`;
		contentText += `C. 転換型: 崩壊したサポート→レジスタンス転換、突破したレジスタンス→サポート転換\n`;
		contentText += `- 崩壊判定: 終値ベース + 出来高確認（低出来高の突破は翌日確認を要求）\n`;
		contentText += `- 強度判定: 接触回数 × 直近性スコア（半減期30日）× 反発幅（2%以上で+1）× 出来高を総合評価\n`;
		contentText += `- 転換型の強化: プルバック確認時に強度★→★★\n`;

		const summary = formatSummary({
			pair: chk.pair,
			latest: currentPrice,
			extra: `supports=${topSupports.length} resistances=${topResistances.length}`,
		});

		const data = {
			currentPrice,
			analysisDate: currentCandle.isoTime,
			lookbackDays,
			supports: topSupports,
			resistances: topResistances,
			detectionCriteria: {
				swingDepth: 5,
				recentBreakWindow: 7,
				tolerance,
			},
		};

		const meta = createMeta(chk.pair, {
			lookbackDays,
			topN,
			supportCount: topSupports.length,
			resistanceCount: topResistances.length,
		});

		return AnalyzeSupportResistanceOutputSchema.parse({
			ok: true,
			summary,
			content: [{ type: 'text', text: contentText }],
			data,
			meta,
		});
	} catch (err: unknown) {
		return failFromError(err, {
			schema: AnalyzeSupportResistanceOutputSchema,
			defaultMessage: 'サポート・レジスタンス分析中にエラーが発生しました',
		});
	}
}

// ── MCP ツール定義（tool-registry から自動収集） ──
export const toolDef: ToolDefinition = {
	name: 'analyze_support_resistance',
	description:
		'[Support / Resistance / Key Levels] サポート・レジスタンス（support / resistance / key levels / price levels）を自動検出。反発/反落ポイントの接触回数・強度・崩壊実績を分析。',
	inputSchema: AnalyzeSupportResistanceInputSchema,
	handler: async ({
		pair,
		lookbackDays,
		topN,
		tolerance,
	}: {
		pair?: string;
		lookbackDays?: number;
		topN?: number;
		tolerance?: number;
	}) => analyzeSupportResistance(pair, { lookbackDays, topN, tolerance }),
};
