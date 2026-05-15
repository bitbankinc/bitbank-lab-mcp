/**
 * lib/equity.ts - エクイティカーブ・ドローダウン計算
 *
 * 【計算仕様（含み損益ベース）】
 *
 * ■ エクイティ
 * - 初期値: 1.0（= 100%）
 * - ポジション非保有時: 前回の確定エクイティを維持
 * - ポジション保有中: entry_price から current_close までの含み損益を反映
 *   equity = confirmed_equity * (current_close / entry_price)
 * - トレード決済時: confirmed_equity を更新
 * - 末尾未決済ポジション (openPosition): entry_time 以降を最終バーまでマーク・トゥ・マーケット延長。
 *   confirmedEquity は更新されないため confirmed_pct には反映されないが、equity_pct には反映される。
 *
 * ■ ドローダウン
 * - 定義: (peak_equity - current_equity) / peak_equity * 100
 * - 常に 0 以上の値
 * - 新しいピークを更新すると DD = 0 に戻る
 *
 * ■ 表示用
 * - equity_pct: (equity - 1) * 100 で表示
 * - drawdown_pct: 0以上の下落幅[%]。表示時に -XX% とする
 */

import type { Candle, DrawdownPoint, EquityPoint, Trade } from '../types.js';

export interface EquityResult {
	equity_curve: EquityPoint[];
	drawdown_curve: DrawdownPoint[];
	/** 0以上。最大ドローダウン[%] */
	max_drawdown: number;
}

/**
 * 末尾で未決済のロングポジション。`executeTradesFromSignals` が
 * sell シグナルなしで終わった場合に返す。
 */
export interface OpenPosition {
	entry_time: string;
	entry_price: number;
}

interface PositionInfo {
	isLong: boolean;
	entryPrice: number;
	entryEquity: number; // エントリー時点の確定エクイティ
}

/**
 * トレード結果からエクイティカーブとドローダウンを計算（含み損益ベース）
 *
 * @param trades トレード配列
 * @param candles ローソク足配列
 * @param openPosition 末尾で未決済のポジション。指定すると entry_time 以降が
 *   最終バーまでマーク・トゥ・マーケット延長され、equity_pct / drawdown_pct
 *   に含み損益が反映される。confirmed_pct には反映されない。
 * @returns エクイティカーブ、ドローダウンカーブ、最大ドローダウン
 */
export function calculateEquityAndDrawdown(
	trades: Trade[],
	candles: Candle[],
	openPosition: OpenPosition | null = null,
): EquityResult {
	// トレードを entry_time と exit_time でマッピング
	const tradeByEntryTime = new Map<string, Trade>();
	const tradeByExitTime = new Map<string, Trade>();
	for (const t of trades) {
		tradeByEntryTime.set(t.entry_time, t);
		tradeByExitTime.set(t.exit_time, t);
	}

	const equity_curve: EquityPoint[] = [];
	const drawdown_curve: DrawdownPoint[] = [];

	let confirmedEquity = 1.0; // 確定済みエクイティ
	let peakEquity = 1.0;
	let maxDrawdown = 0;
	let position: PositionInfo | null = null;

	for (const candle of candles) {
		// エントリーチェック（確定トレード）
		const entryTrade = tradeByEntryTime.get(candle.time);
		if (entryTrade && !position) {
			position = {
				isLong: true,
				entryPrice: entryTrade.entry_price,
				entryEquity: confirmedEquity,
			};
		}

		// エントリーチェック（末尾未決済ポジション）
		// exit は持たないので tradeByExitTime には登録されず、以降のバーで
		// マーク・トゥ・マーケットが続き confirmedEquity は更新されない。
		if (openPosition && !position && candle.time === openPosition.entry_time) {
			position = {
				isLong: true,
				entryPrice: openPosition.entry_price,
				entryEquity: confirmedEquity,
			};
		}

		// 現在のエクイティを計算
		let currentEquity: number;
		if (position) {
			// ポジション保有中: 含み損益を反映
			const unrealizedReturn = candle.close / position.entryPrice;
			currentEquity = position.entryEquity * unrealizedReturn;
		} else {
			// ポジション非保有: 確定エクイティを維持
			currentEquity = confirmedEquity;
		}

		// エグジットチェック（エクイティ計算後に処理）
		const exitTrade = tradeByExitTime.get(candle.time);
		if (exitTrade && position) {
			// 確定エクイティを更新（手数料込み）
			confirmedEquity = position.entryEquity * exitTrade.net_return;
			currentEquity = confirmedEquity; // 決済時は確定値を使用
			position = null;
		}

		// 表示用エクイティ [%] = (equity - 1) * 100
		const equityPct = (currentEquity - 1) * 100;
		const confirmedPct = (confirmedEquity - 1) * 100;
		equity_curve.push({
			time: candle.time,
			equity_pct: Number(equityPct.toFixed(4)),
			confirmed_pct: Number(confirmedPct.toFixed(4)),
		});

		// ピーク更新
		if (currentEquity > peakEquity) {
			peakEquity = currentEquity;
		}

		// ドローダウン計算
		let drawdownPct = 0;
		if (peakEquity > 0) {
			drawdownPct = ((peakEquity - currentEquity) / peakEquity) * 100;
		}
		if (drawdownPct < 0) {
			drawdownPct = 0;
		}

		drawdown_curve.push({
			time: candle.time,
			drawdown_pct: Number(drawdownPct.toFixed(4)),
		});

		if (drawdownPct > maxDrawdown) {
			maxDrawdown = drawdownPct;
		}
	}

	return {
		equity_curve,
		drawdown_curve,
		max_drawdown: Number(maxDrawdown.toFixed(4)),
	};
}
