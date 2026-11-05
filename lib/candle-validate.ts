// 暗号資産はファットテールなので σ 閾値は株式より広めにする（Vol.01）。

import { dayjs } from './datetime.js';
import { avg, stddev } from './math.js';

export interface CandleRow {
	open: number;
	high: number;
	low: number;
	close: number;
	volume?: number;
	isoTime?: string | null;
}

// 24h 出来高シェア（JPY 建て売買代金の割合）による分類（bitbank-cli-skills の pair-classification.md）。

export type PairTier = 'major' | 'mid' | 'minor';

const MAJOR_PAIRS = new Set(['btc_jpy', 'xrp_jpy', 'eth_jpy']);

const MID_PAIRS = new Set([
	'doge_jpy',
	'sol_jpy',
	'ltc_jpy',
	'ada_jpy',
	'avax_jpy',
	'dot_jpy',
	'bnb_jpy',
	'sui_jpy',
	'link_jpy',
]);

// major は出来高シェア 10% 以上、mid は 1〜10%、minor は 1% 未満。
export function classifyPairTier(pair: string): PairTier {
	const normalized = pair.toLowerCase();
	if (MAJOR_PAIRS.has(normalized)) return 'major';
	if (MID_PAIRS.has(normalized)) return 'mid';
	return 'minor';
}

export interface TierDefaults {
	priceSigma: number;
	volumeMultiplier: number;
	zeroVolumePenaltyWeight: number;
}

export function getTierDefaults(tier: PairTier): TierDefaults {
	switch (tier) {
		case 'major':
			return { priceSigma: 4, volumeMultiplier: 15, zeroVolumePenaltyWeight: 1 };
		case 'mid':
			return { priceSigma: 4, volumeMultiplier: 25, zeroVolumePenaltyWeight: 0.5 };
		case 'minor':
			return { priceSigma: 5, volumeMultiplier: 50, zeroVolumePenaltyWeight: 0 };
	}
}

const INTERVAL_MS: Record<string, number> = {
	'1min': 60_000,
	'5min': 300_000,
	'15min': 900_000,
	'30min': 1_800_000,
	'1hour': 3_600_000,
	'4hour': 14_400_000,
	'8hour': 28_800_000,
	'12hour': 43_200_000,
	'1day': 86_400_000,
};

export interface CompletenessResult {
	expected: number;
	actual: number;
	missing: number;
	missingTimestamps: string[];
	ratio: number; // 0–1
}

// 1week / 1month は間隔が不規則なのでスキップする（ratio: 1）。
export function checkCompleteness(candles: CandleRow[], candleType: string): CompletenessResult {
	const intervalMs = INTERVAL_MS[candleType];

	if (!intervalMs || candles.length < 2) {
		return { expected: candles.length, actual: candles.length, missing: 0, missingTimestamps: [], ratio: 1 };
	}

	const timestamps = candles.map((c) => (c.isoTime ? dayjs(c.isoTime).valueOf() : NaN)).filter((t) => !Number.isNaN(t));
	const uniqueTimestamps = [...new Set(timestamps)];

	if (uniqueTimestamps.length < 2) {
		return { expected: candles.length, actual: candles.length, missing: 0, missingTimestamps: [], ratio: 1 };
	}

	const first = uniqueTimestamps[0];
	const last = uniqueTimestamps[uniqueTimestamps.length - 1];
	const expected = Math.floor((last - first) / intervalMs) + 1;
	const tsSet = new Set(uniqueTimestamps);

	const missingTimestamps: string[] = [];
	for (let t = first; t <= last; t += intervalMs) {
		if (!tsSet.has(t)) {
			missingTimestamps.push(dayjs(t).toISOString());
		}
	}

	return {
		expected,
		actual: uniqueTimestamps.length,
		missing: missingTimestamps.length,
		missingTimestamps: missingTimestamps.slice(0, 50), // 上限50件
		ratio: expected > 0 ? Math.min(uniqueTimestamps.length / expected, 1) : 1,
	};
}

export interface DuplicatesResult {
	count: number;
	timestamps: string[];
}

export function checkDuplicates(candles: CandleRow[]): DuplicatesResult {
	const seen = new Set<string>();
	const duplicates: string[] = [];

	for (const c of candles) {
		const key = c.isoTime ?? '';
		if (!key) continue;
		if (seen.has(key)) {
			duplicates.push(key);
		} else {
			seen.add(key);
		}
	}

	return { count: duplicates.length, timestamps: duplicates.slice(0, 50) };
}

export interface IntegrityIssue {
	index: number;
	isoTime: string | null;
	issues: string[];
}

export interface IntegrityResult {
	totalChecked: number;
	invalidCount: number;
	issues: IntegrityIssue[];
}

export function checkIntegrity(candles: CandleRow[]): IntegrityResult {
	const issues: IntegrityIssue[] = [];

	for (let i = 0; i < candles.length; i++) {
		const c = candles[i];
		const rowIssues: string[] = [];

		if (c.high < c.low) {
			rowIssues.push(`high(${c.high}) < low(${c.low})`);
		}
		if (c.high < Math.max(c.open, c.close)) {
			rowIssues.push(`high(${c.high}) < max(open,close)(${Math.max(c.open, c.close)})`);
		}
		if (c.low > Math.min(c.open, c.close)) {
			rowIssues.push(`low(${c.low}) > min(open,close)(${Math.min(c.open, c.close)})`);
		}
		if (c.volume != null && c.volume < 0) {
			rowIssues.push(`volume(${c.volume}) < 0`);
		}

		if (rowIssues.length > 0) {
			issues.push({ index: i, isoTime: c.isoTime ?? null, issues: rowIssues });
		}
	}

	return {
		totalChecked: candles.length,
		invalidCount: issues.length,
		issues: issues.slice(0, 50),
	};
}

export interface PriceAnomaly {
	index: number;
	isoTime: string | null;
	returnPct: number;
	sigma: number;
}

export interface PriceAnomalyResult {
	totalBars: number;
	anomalyCount: number;
	anomalies: PriceAnomaly[];
	stats: { mean: number; stddev: number; threshold: number } | null;
}

export function checkPriceAnomalies(candles: CandleRow[], sigmaThreshold: number): PriceAnomalyResult {
	if (candles.length < 3) {
		return { totalBars: candles.length, anomalyCount: 0, anomalies: [], stats: null };
	}

	const returns: number[] = [];
	for (let i = 1; i < candles.length; i++) {
		const prev = candles[i - 1].close;
		if (prev === 0) {
			returns.push(0);
		} else {
			returns.push((candles[i].close - prev) / prev);
		}
	}

	const mean = avg(returns) ?? 0;
	const sd = stddev(returns);

	if (sd === 0) {
		return {
			totalBars: candles.length,
			anomalyCount: 0,
			anomalies: [],
			stats: { mean, stddev: sd, threshold: sigmaThreshold },
		};
	}

	const anomalies: PriceAnomaly[] = [];
	for (let i = 0; i < returns.length; i++) {
		const sigma = Math.abs((returns[i] - mean) / sd);
		if (sigma >= sigmaThreshold) {
			anomalies.push({
				index: i + 1, // candles のインデックス（returns は1個ずれる）
				isoTime: candles[i + 1].isoTime ?? null,
				returnPct: Number((returns[i] * 100).toFixed(4)),
				sigma: Number(sigma.toFixed(2)),
			});
		}
	}

	return {
		totalBars: candles.length,
		anomalyCount: anomalies.length,
		anomalies: anomalies.slice(0, 50),
		stats: { mean: Number((mean * 100).toFixed(6)), stddev: Number((sd * 100).toFixed(6)), threshold: sigmaThreshold },
	};
}

export interface VolumeAnomaly {
	index: number;
	isoTime: string | null;
	volume: number;
	reason: 'zero' | 'spike';
	multiplier?: number;
}

export interface VolumeAnomalyResult {
	totalBars: number;
	anomalyCount: number;
	zeroCount: number;
	spikeCount: number;
	anomalies: VolumeAnomaly[];
	stats: { avgVolume: number; threshold: number } | null;
}

export function checkVolumeAnomalies(candles: CandleRow[], multiplierThreshold: number): VolumeAnomalyResult {
	const volumes = candles.map((c) => c.volume ?? 0);

	if (volumes.length === 0) {
		return { totalBars: 0, anomalyCount: 0, zeroCount: 0, spikeCount: 0, anomalies: [], stats: null };
	}

	// スパイクのベースラインはゼロ出来高を除いて算出する（ゼロは取引が無かっただけ）。
	const nonZeroVolumes = volumes.filter((v) => v > 0);
	const avgVol = avg(nonZeroVolumes) ?? 0;
	const anomalies: VolumeAnomaly[] = [];
	let zeroCount = 0;
	let spikeCount = 0;

	for (let i = 0; i < candles.length; i++) {
		const vol = volumes[i];

		if (vol === 0) {
			zeroCount++;
			anomalies.push({ index: i, isoTime: candles[i].isoTime ?? null, volume: vol, reason: 'zero' });
		} else if (avgVol > 0 && vol > avgVol * multiplierThreshold) {
			spikeCount++;
			anomalies.push({
				index: i,
				isoTime: candles[i].isoTime ?? null,
				volume: vol,
				reason: 'spike',
				multiplier: Number((vol / avgVol).toFixed(2)),
			});
		}
	}

	return {
		totalBars: candles.length,
		anomalyCount: anomalies.length,
		zeroCount,
		spikeCount,
		anomalies: anomalies.slice(0, 50),
		stats: { avgVolume: Number(avgVol.toFixed(6)), threshold: multiplierThreshold },
	};
}

export interface QualityScore {
	score: number; // 0–100
	breakdown: {
		completeness: number; // 0–30
		integrity: number; // 0–25
		priceStability: number; // 0–25
		volumeHealth: number; // 0–20
	};
	grade: 'A' | 'B' | 'C' | 'D' | 'F';
}

// minor は出来高ゼロが日常的なので減点 0、major は異常の可能性があるので 1 を渡す。
export function computeQualityScore(
	completeness: CompletenessResult,
	integrity: IntegrityResult,
	priceAnomalies: PriceAnomalyResult,
	volumeAnomalies: VolumeAnomalyResult,
	zeroVolumePenaltyWeight = 1,
): QualityScore {
	const completenessScore = Math.round(completeness.ratio * 30);

	const integrityRatio = integrity.totalChecked > 0 ? 1 - integrity.invalidCount / integrity.totalChecked : 1;
	const integrityScore = Math.round(integrityRatio * 25);

	const priceRatio =
		priceAnomalies.totalBars > 1 ? 1 - Math.min(priceAnomalies.anomalyCount / (priceAnomalies.totalBars - 1), 1) : 1;
	const priceScore = Math.round(priceRatio * 25);

	const zeroRatio = volumeAnomalies.totalBars > 0 ? volumeAnomalies.zeroCount / volumeAnomalies.totalBars : 0;
	const spikeRatio = volumeAnomalies.totalBars > 0 ? volumeAnomalies.spikeCount / volumeAnomalies.totalBars : 0;
	const volumeScore = Math.round((1 - Math.min(zeroRatio * zeroVolumePenaltyWeight + spikeRatio, 1)) * 20);

	const score = completenessScore + integrityScore + priceScore + volumeScore;

	let grade: QualityScore['grade'];
	if (score >= 90) grade = 'A';
	else if (score >= 75) grade = 'B';
	else if (score >= 60) grade = 'C';
	else if (score >= 40) grade = 'D';
	else grade = 'F';

	return {
		score,
		breakdown: {
			completeness: completenessScore,
			integrity: integrityScore,
			priceStability: priceScore,
			volumeHealth: volumeScore,
		},
		grade,
	};
}
