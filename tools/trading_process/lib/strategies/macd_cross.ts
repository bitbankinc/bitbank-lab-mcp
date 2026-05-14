/**
 * strategies/macd_cross.ts - MACDクロスオーバー戦略
 *
 * エントリー: MACDラインがシグナルラインを上抜け（ゴールデンクロス）
 * エグジット: MACDラインがシグナルラインを下抜け（デッドクロス）
 *
 * オプションフィルター:
 *   - sma_filter_period: SMAトレンドフィルター（例: 200）。価格がSMA上の場合のみ買い
 *   - zero_line_filter: ゼロラインフィルター（-1=ゼロ以下のみ, 0=なし, 1=ゼロ以上のみ）
 *   - rsi_filter_period: RSIフィルター期間（例: 14）。0で無効
 *   - rsi_filter_max: RSI上限（例: 70）。RSIがこの値未満の場合のみ買い
 */

import { macd as sharedMacd } from '../../../../lib/indicators.js';
import type { Candle } from '../../types.js';
import { calculateSMA } from '../sma.js';
import { calculateRSI } from './rsi.js';
import type { Overlay, ParamValidationResult, Signal, Strategy } from './types.js';

/**
 * MACD戦略のデフォルトパラメータ
 */
const DEFAULT_PARAMS: Record<string, number> = {
	fast: 12,
	slow: 26,
	signal: 9,
	// フィルター（0 = 無効）
	sma_filter_period: 0,
	zero_line_filter: 0, // -1=below zero only, 0=none, 1=above zero only
	rsi_filter_period: 0,
	rsi_filter_max: 100, // RSI < この値 の場合のみ買い（100=フィルター無効）
};

/**
 * MACDを計算（lib/indicators.ts への委譲）
 */
function calculateMACD(
	closes: number[],
	fastPeriod: number,
	slowPeriod: number,
	signalPeriod: number,
): { macd: number[]; signal: number[]; histogram: number[] } {
	const result = sharedMacd(closes, fastPeriod, slowPeriod, signalPeriod);
	return { macd: result.line, signal: result.signal, histogram: result.hist };
}

/**
 * パラメータのバリデーション
 */
export function validateParams(params: Record<string, number>): ParamValidationResult {
	const errors: string[] = [];
	const normalized = { ...DEFAULT_PARAMS, ...params };

	if (normalized.fast >= normalized.slow) {
		errors.push('fast period must be less than slow period');
	}
	if (normalized.fast < 2) {
		errors.push('fast period must be at least 2');
	}
	if (normalized.signal < 2) {
		errors.push('signal period must be at least 2');
	}
	if (normalized.sma_filter_period < 0) {
		errors.push('sma_filter_period must be >= 0');
	}
	if (![-1, 0, 1].includes(normalized.zero_line_filter)) {
		errors.push('zero_line_filter must be -1, 0, or 1');
	}
	if (normalized.rsi_filter_period < 0) {
		errors.push('rsi_filter_period must be >= 0');
	}
	if (normalized.rsi_filter_max < 0 || normalized.rsi_filter_max > 100) {
		errors.push('rsi_filter_max must be 0-100');
	}

	return {
		valid: errors.length === 0,
		errors,
		normalizedParams: normalized,
	};
}

/**
 * フィルター条件の説明文を生成
 */
function describeFilters(params: Record<string, number>): string {
	const parts: string[] = [];
	if (params.sma_filter_period > 0) {
		parts.push(`SMA${params.sma_filter_period} trend filter`);
	}
	if (params.zero_line_filter === 1) {
		parts.push('zero-line: above only');
	} else if (params.zero_line_filter === -1) {
		parts.push('zero-line: below only');
	}
	if (params.rsi_filter_period > 0 && params.rsi_filter_max < 100) {
		parts.push(`RSI(${params.rsi_filter_period})<${params.rsi_filter_max}`);
	}
	return parts.length > 0 ? ` [${parts.join(', ')}]` : '';
}

/**
 * MACDクロスオーバー戦略
 */
/**
 * MACD Cross の必要バー数を計算。
 *   - signal 線は index >= slow + signal - 2 で有効 → クロス判定で prev/curr 必要 → i >= slow + signal - 1
 *     よって最低 slow + signal 本必要
 *   - SMA filter: index >= sma_filter_period - 1 で有効
 *   - RSI filter: index >= rsi_filter_period + 1 で有効
 */
function computeRequiredBarsImpl(params: Record<string, number>): number {
	const p = { ...DEFAULT_PARAMS, ...params };
	const base = p.slow + p.signal;
	const smaF = p.sma_filter_period > 0 ? p.sma_filter_period - 1 : 0;
	const rsiF = p.rsi_filter_period > 0 ? p.rsi_filter_period + 1 : 0;
	return Math.max(base, smaF, rsiF);
}

export const macdCrossStrategy: Strategy = {
	name: 'MACD Crossover',
	type: 'macd_cross',
	requiredBars: computeRequiredBarsImpl(DEFAULT_PARAMS),
	defaultParams: DEFAULT_PARAMS,
	computeRequiredBars: computeRequiredBarsImpl,

	generate(candles: Candle[], params: Record<string, number>): Signal[] {
		const p = { ...DEFAULT_PARAMS, ...params };
		const { fast, slow, signal: signalPeriod } = p;
		const closes = candles.map((c) => c.close);
		const { macd, signal, histogram: _histogram } = calculateMACD(closes, fast, slow, signalPeriod);

		// フィルター用の指標を事前計算
		const sma = p.sma_filter_period > 0 ? calculateSMA(closes, p.sma_filter_period) : null;
		const rsi = p.rsi_filter_period > 0 ? calculateRSI(closes, p.rsi_filter_period) : null;

		const signals: Signal[] = [];
		// 各指標の「初の有効インデックス」基準でウォームアップを揃える
		// - signal 線は index >= slow + signal - 2 から有効 → クロス判定可能なのは i >= slow + signal - 1
		// - SMA filter: index >= sma_filter_period - 1 で有効
		// - RSI filter: index >= rsi_filter_period + 1 で有効
		const baseStartIdx = slow + signalPeriod - 1;
		const smaFilterStart = sma ? p.sma_filter_period - 1 : 0;
		const rsiFilterStart = rsi ? p.rsi_filter_period + 1 : 0;
		const startIdx = Math.max(baseStartIdx, smaFilterStart, rsiFilterStart);

		for (let i = 0; i < candles.length; i++) {
			if (i < startIdx) {
				signals.push({ time: candles[i].time, action: 'hold' });
				continue;
			}

			const prevMACD = macd[i - 1];
			const prevSignal = signal[i - 1];
			const currMACD = macd[i];
			const currSignal = signal[i];

			if (Number.isNaN(prevMACD) || Number.isNaN(prevSignal) || Number.isNaN(currMACD) || Number.isNaN(currSignal)) {
				signals.push({ time: candles[i].time, action: 'hold' });
				continue;
			}

			// ゴールデンクロス: MACDがシグナルを上抜け
			if (prevMACD <= prevSignal && currMACD > currSignal) {
				// フィルター適用（買いシグナルのみにフィルターを適用）
				const filterReasons: string[] = [];
				let filtered = false;

				// SMAトレンドフィルター: 価格がSMA上の場合のみ
				if (sma && !Number.isNaN(sma[i]) && closes[i] < sma[i]) {
					filtered = true;
					filterReasons.push(`price(${closes[i].toFixed(0)}) < SMA${p.sma_filter_period}(${sma[i].toFixed(0)})`);
				}

				// ゼロラインフィルター
				if (p.zero_line_filter === 1 && currMACD < 0) {
					filtered = true;
					filterReasons.push(`MACD(${currMACD.toFixed(0)}) below zero`);
				} else if (p.zero_line_filter === -1 && currMACD > 0) {
					filtered = true;
					filterReasons.push(`MACD(${currMACD.toFixed(0)}) above zero`);
				}

				// RSIフィルター
				if (rsi && !Number.isNaN(rsi[i]) && rsi[i] >= p.rsi_filter_max) {
					filtered = true;
					filterReasons.push(`RSI(${rsi[i].toFixed(1)}) >= ${p.rsi_filter_max}`);
				}

				if (filtered) {
					signals.push({ time: candles[i].time, action: 'hold' });
				} else {
					const filterDesc = describeFilters(p);
					signals.push({
						time: candles[i].time,
						action: 'buy',
						reason: `MACD Golden Cross: MACD(${currMACD.toFixed(0)}) > Signal(${currSignal.toFixed(0)})${filterDesc}`,
					});
				}
			}
			// デッドクロス: MACDがシグナルを下抜け（エグジットなのでフィルター適用しない）
			else if (prevMACD >= prevSignal && currMACD < currSignal) {
				signals.push({
					time: candles[i].time,
					action: 'sell',
					reason: `MACD Dead Cross: MACD(${currMACD.toFixed(0)}) < Signal(${currSignal.toFixed(0)})`,
				});
			}
			// シグナルなし
			else {
				signals.push({ time: candles[i].time, action: 'hold' });
			}
		}

		return signals;
	},

	getOverlays(candles: Candle[], params: Record<string, number>): Overlay[] {
		const p = { ...DEFAULT_PARAMS, ...params };
		const { fast, slow, signal: signalPeriod } = p;
		const closes = candles.map((c) => c.close);
		const { macd, signal, histogram } = calculateMACD(closes, fast, slow, signalPeriod);

		const overlays: Overlay[] = [
			{
				type: 'line' as const,
				name: `MACD(${fast},${slow})`,
				color: '#22c55e',
				data: macd,
				panel: 'indicator' as const,
			},
			{
				type: 'line' as const,
				name: `Signal(${signalPeriod})`,
				color: '#f97316',
				data: signal,
				panel: 'indicator' as const,
			},
			{
				type: 'histogram' as const,
				name: 'Histogram',
				positiveColor: 'rgba(34, 197, 94, 0.7)',
				negativeColor: 'rgba(239, 68, 68, 0.7)',
				data: histogram,
				panel: 'indicator' as const,
			},
		];

		// SMAフィルターが有効な場合、SMAラインを価格チャートに表示
		if (p.sma_filter_period > 0) {
			const sma = calculateSMA(closes, p.sma_filter_period);
			overlays.push({
				type: 'line' as const,
				name: `SMA${p.sma_filter_period} (filter)`,
				color: '#facc15',
				data: sma,
				panel: 'price' as const,
			});
		}

		// RSIフィルターが有効な場合、RSIラインをインジケータパネルに表示
		if (p.rsi_filter_period > 0 && p.rsi_filter_max < 100) {
			const rsi = calculateRSI(closes, p.rsi_filter_period);
			overlays.push({
				type: 'line' as const,
				name: `RSI(${p.rsi_filter_period})`,
				color: '#a78bfa',
				data: rsi,
				panel: 'indicator' as const,
			});
		}

		return overlays;
	},
};

export default macdCrossStrategy;
