/**
 * strategies/types.ts - 汎用バックテスト戦略の型定義
 */

import type { Candle } from '../../types.js';

/**
 * トレードシグナル
 */
export interface Signal {
	/** シグナル発生時刻 */
	time: string;
	/** シグナルの種類 */
	action: 'buy' | 'sell' | 'hold';
	/** シグナルの理由（オプション） */
	reason?: string;
}

/**
 * 戦略タイプ
 */
export type StrategyType = 'sma_cross' | 'rsi' | 'macd_cross' | 'bb_breakout';

/**
 * 戦略設定
 */
export interface StrategyConfig {
	type: StrategyType;
	params: Record<string, number>;
}

/**
 * オーバーレイデータ（チャート描画用）
 */
export interface OverlayLine {
	type: 'line';
	name: string;
	color: string;
	data: number[];
}

export interface OverlayBand {
	type: 'band';
	name: string;
	color: string;
	fillColor: string;
	data: { upper: number[]; middle?: number[]; lower: number[] };
}

export interface OverlayMarker {
	type: 'marker';
	name: string;
	color: string;
	data: Array<{ index: number; value: number; label?: string }>;
}

export interface OverlayHistogram {
	type: 'histogram';
	name: string;
	positiveColor: string;
	negativeColor: string;
	data: number[];
}

/**
 * オーバーレイの描画先パネル
 * - 'price': 価格チャート上に描画（デフォルト）
 * - 'indicator': 独立したインジケータサブパネルに描画（MACD, RSI 等）
 */
export type OverlayPanel = 'price' | 'indicator';

export type Overlay =
	| (OverlayLine & { panel?: OverlayPanel })
	| (OverlayBand & { panel?: OverlayPanel })
	| (OverlayMarker & { panel?: OverlayPanel })
	| (OverlayHistogram & { panel?: OverlayPanel });

/**
 * 戦略インターフェース
 */
export interface Strategy {
	/** 戦略名 */
	name: string;
	/** 戦略タイプ */
	type: StrategyType;
	/** デフォルトパラメータ時の必要バー数（参考値） */
	requiredBars: number;
	/** デフォルトパラメータ */
	defaultParams: Record<string, number>;
	/**
	 * 指定 params に応じて必要なウォームアップバー数を計算する。
	 * `long` / `slow` / `signal` 等のパラメータをデフォルトより大きく指定した
	 * 場合でも、ウォームアップ本数が不足しないようにするため呼び出し側はこちらを使う。
	 */
	computeRequiredBars(params: Record<string, number>): number;
	/**
	 * シグナル生成
	 * @param candles ローソク足データ
	 * @param params 戦略パラメータ
	 * @returns シグナル配列（各バーに対応）
	 */
	generate(candles: Candle[], params: Record<string, number>): Signal[];
	/**
	 * オーバーレイデータ取得（チャート描画用）
	 * @param candles ローソク足データ
	 * @param params 戦略パラメータ
	 * @returns オーバーレイ配列
	 */
	getOverlays(candles: Candle[], params: Record<string, number>): Overlay[];
}

/**
 * 戦略パラメータのバリデーション結果
 */
export interface ParamValidationResult {
	valid: boolean;
	errors: string[];
	normalizedParams: Record<string, number>;
}

/**
 * 戦略レジストリ型
 */
export type StrategyRegistry = Map<StrategyType, Strategy>;
