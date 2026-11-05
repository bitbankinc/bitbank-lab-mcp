import {
	type CandleRow,
	checkCompleteness,
	checkDuplicates,
	checkIntegrity,
	checkPriceAnomalies,
	checkVolumeAnomalies,
	classifyPairTier,
	computeQualityScore,
	getTierDefaults,
	type PairTier,
} from '../lib/candle-validate.js';
import { formatPair, timeframeLabel } from '../lib/formatter.js';
import { fail, failFromError, failFromValidation, ok, parseAsResult, toStructured } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import type {
	CandleType,
	FailResult,
	OkResult,
	ValidateCandleDataData,
	ValidateCandleDataMeta,
} from '../src/schemas.js';
import { ValidateCandleDataInputSchema, ValidateCandleDataOutputSchema } from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import getCandles from './get_candles.js';

export default async function validateCandleData(
	pair: string,
	type: CandleType = '1day',
	date: string | undefined,
	limit = 200,
	priceSigmaOverride?: number,
	volumeMultiplierOverride?: number,
	tz = 'Asia/Tokyo',
): Promise<OkResult<ValidateCandleDataData, ValidateCandleDataMeta> | FailResult> {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk);

	const tier: PairTier = classifyPairTier(chk.pair);
	const defaults = getTierDefaults(tier);
	const priceSigma = priceSigmaOverride ?? defaults.priceSigma;
	const volumeMultiplier = volumeMultiplierOverride ?? defaults.volumeMultiplier;

	try {
		const candlesResult = await getCandles(chk.pair, type, date, limit, tz);
		if (!candlesResult?.ok) {
			return fail(
				candlesResult?.summary || 'ローソク足取得に失敗しました',
				(candlesResult?.meta as { errorType?: string })?.errorType || 'upstream',
			);
		}

		const normalized = candlesResult.data.normalized;
		if (!normalized || normalized.length === 0) {
			return fail('ローソク足データが空です', 'user');
		}

		const rows: CandleRow[] = normalized.map(
			(c: { open: number; high: number; low: number; close: number; volume?: number; isoTime?: string | null }) => ({
				open: c.open,
				high: c.high,
				low: c.low,
				close: c.close,
				volume: c.volume,
				isoTime: c.isoTime,
			}),
		);

		const completeness = checkCompleteness(rows, type);
		const duplicates = checkDuplicates(rows);
		const integrity = checkIntegrity(rows);
		const priceAnomalies = checkPriceAnomalies(rows, priceSigma);
		const volumeAnomalies = checkVolumeAnomalies(rows, volumeMultiplier);
		const qualityScore = computeQualityScore(
			completeness,
			integrity,
			priceAnomalies,
			volumeAnomalies,
			defaults.zeroVolumePenaltyWeight,
		);

		const summary = buildValidationText(chk.pair, type, tier, {
			completeness,
			duplicates,
			integrity,
			priceAnomalies,
			volumeAnomalies,
			qualityScore,
		});

		const data: ValidateCandleDataData = {
			completeness,
			duplicates,
			integrity,
			priceAnomalies,
			volumeAnomalies,
			qualityScore,
		};

		const meta = createMeta(chk.pair, {
			type,
			count: rows.length,
			tier,
			thresholds: {
				priceSigma,
				volumeMultiplier,
				zeroVolumePenaltyWeight: defaults.zeroVolumePenaltyWeight,
			},
		});

		const result = ok<ValidateCandleDataData, ValidateCandleDataMeta>(summary, data, meta as ValidateCandleDataMeta);
		return parseAsResult<ValidateCandleDataData, ValidateCandleDataMeta>(ValidateCandleDataOutputSchema, result);
	} catch (e: unknown) {
		return failFromError(e, {
			schema: ValidateCandleDataOutputSchema,
			defaultType: 'internal',
			defaultMessage: 'データ品質検証でエラーが発生しました',
		});
	}
}

const TIER_LABELS: Record<PairTier, string> = {
	major: '高流動性',
	mid: '中流動性',
	minor: '低流動性',
};

function buildValidationText(pair: string, type: string, tier: PairTier, r: ValidateCandleDataData): string {
	const lines: string[] = [];
	const pairLabel = formatPair(pair);
	const tfLabel = timeframeLabel(type);

	lines.push(`${pairLabel} ${tfLabel} データ品質レポート`);
	lines.push(`ペアティア: ${tier} (${TIER_LABELS[tier]})`);
	lines.push(`品質スコア: ${r.qualityScore.score}/100 (${r.qualityScore.grade})`);
	lines.push('');

	const b = r.qualityScore.breakdown;
	lines.push('--- スコア内訳 ---');
	lines.push(`  完全性: ${b.completeness}/30`);
	lines.push(`  整合性: ${b.integrity}/25`);
	lines.push(`  価格安定性: ${b.priceStability}/25`);
	lines.push(`  出来高健全性: ${b.volumeHealth}/20`);
	lines.push('');

	lines.push('--- 完全性 ---');
	lines.push(
		`  期待本数: ${r.completeness.expected} / 実際: ${r.completeness.actual} / 欠損: ${r.completeness.missing}`,
	);
	lines.push(`  充足率: ${(r.completeness.ratio * 100).toFixed(1)}%`);
	if (r.completeness.missingTimestamps.length > 0) {
		lines.push(`  欠損タイムスタンプ (先頭${Math.min(r.completeness.missingTimestamps.length, 10)}件):`);
		for (const ts of r.completeness.missingTimestamps.slice(0, 10)) {
			lines.push(`    - ${ts}`);
		}
	}
	lines.push('');

	lines.push('--- 重複 ---');
	lines.push(`  重複件数: ${r.duplicates.count}`);
	if (r.duplicates.timestamps.length > 0) {
		for (const ts of r.duplicates.timestamps.slice(0, 5)) {
			lines.push(`    - ${ts}`);
		}
	}
	lines.push('');

	lines.push('--- OHLCV 整合性 ---');
	lines.push(`  チェック済み: ${r.integrity.totalChecked} / 不正: ${r.integrity.invalidCount}`);
	if (r.integrity.issues.length > 0) {
		for (const issue of r.integrity.issues.slice(0, 10)) {
			lines.push(`    [${issue.index}] ${issue.isoTime ?? 'N/A'}: ${issue.issues.join(', ')}`);
		}
	}
	lines.push('');

	lines.push('--- 価格異常値 ---');
	lines.push(`  検出数: ${r.priceAnomalies.anomalyCount}/${r.priceAnomalies.totalBars}本`);
	if (r.priceAnomalies.stats) {
		lines.push(
			`  平均リターン: ${r.priceAnomalies.stats.mean}% / 標準偏差: ${r.priceAnomalies.stats.stddev}% / 閾値: ${r.priceAnomalies.stats.threshold}σ`,
		);
	}
	if (r.priceAnomalies.anomalies.length > 0) {
		for (const a of r.priceAnomalies.anomalies.slice(0, 10)) {
			lines.push(`    [${a.index}] ${a.isoTime ?? 'N/A'}: ${a.returnPct}% (${a.sigma}σ)`);
		}
	}
	lines.push('');

	lines.push('--- 出来高異常値 ---');
	lines.push(
		`  検出数: ${r.volumeAnomalies.anomalyCount} (ゼロ: ${r.volumeAnomalies.zeroCount}, スパイク: ${r.volumeAnomalies.spikeCount})`,
	);
	if (r.volumeAnomalies.stats) {
		lines.push(
			`  平均出来高: ${r.volumeAnomalies.stats.avgVolume} / スパイク閾値: ${r.volumeAnomalies.stats.threshold}倍`,
		);
	}
	if (r.volumeAnomalies.anomalies.length > 0) {
		for (const a of r.volumeAnomalies.anomalies.slice(0, 10)) {
			const detail = a.reason === 'spike' ? `${a.multiplier}x` : 'ゼロ';
			lines.push(`    [${a.index}] ${a.isoTime ?? 'N/A'}: vol=${a.volume} (${detail})`);
		}
	}

	return lines.join('\n');
}

export const toolDef: ToolDefinition = {
	name: 'validate_candle_data',
	description: `[Data Quality / Validation] OHLCVローソク足データの品質検証。
分析やバックテスト前に「このデータ信用できる？」を確認するためのツール。
完全性（歯抜け）・重複・OHLCV整合性・価格異常値・出来高異常値を検出し、0-100の品質スコア（A-F）を算出。
ペアの流動性ティア（major/mid/minor）を自動判定し、暗号資産のファットテール分布や低流動性ペアの出来高ゼロを考慮した適切なデフォルト閾値を適用。
閾値は price_sigma, volume_multiplier で手動調整も可能。`,
	inputSchema: ValidateCandleDataInputSchema,
	handler: async ({
		pair,
		type,
		date,
		limit,
		price_sigma,
		volume_multiplier,
		tz,
	}: {
		pair: string;
		type: CandleType;
		date?: string;
		limit: number;
		price_sigma?: number;
		volume_multiplier?: number;
		tz: string;
	}) => {
		const result = await validateCandleData(pair, type, date, limit, price_sigma, volume_multiplier, tz);
		if (!result.ok) return result;

		const text = `${result.summary}\n\n${JSON.stringify({ meta: result.meta, data: result.data }, null, 2)}`;
		return {
			content: [{ type: 'text', text }],
			structuredContent: toStructured(result),
		};
	},
};
