// 建てた時点で片道手数料を引き、確定トレードは決済時に net_return（往復手数料込み）で確定する。末尾未決済は最終バーまで含み損益で延長し、confirmed_pct には反映しない。

import type { Candle, DrawdownPoint, EquityPoint, Trade } from '../types.js';

export interface EquityResult {
	equity_curve: EquityPoint[];
	drawdown_curve: DrawdownPoint[];
	/** 0以上。最大ドローダウン[%] */
	max_drawdown: number;
}

export interface OpenPosition {
	entry_time: string;
	entry_price: number;
	entry_fee_multiplier: number;
}

interface PositionInfo {
	entryPrice: number;
	confirmedAtEntry: number;
	equityAfterEntryFee: number;
}

export function calculateEquityAndDrawdown(
	trades: Trade[],
	candles: Candle[],
	openPosition: OpenPosition | null = null,
): EquityResult {
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
		const entryTrade = tradeByEntryTime.get(candle.time);
		if (entryTrade && !position) {
			// fee_pct は往復 2f なので、建てた時の片道ぶんはその半分（executeTradesFromSignals の 1 - 2f を対称に分けたもの）。
			position = {
				entryPrice: entryTrade.entry_price,
				confirmedAtEntry: confirmedEquity,
				equityAfterEntryFee: confirmedEquity * (1 - entryTrade.fee_pct / 200),
			};
		}

		if (openPosition && !position && candle.time === openPosition.entry_time) {
			position = {
				entryPrice: openPosition.entry_price,
				confirmedAtEntry: confirmedEquity,
				equityAfterEntryFee: confirmedEquity * openPosition.entry_fee_multiplier,
			};
		}

		let currentEquity: number;
		if (position) {
			currentEquity = position.equityAfterEntryFee * (candle.close / position.entryPrice);
		} else {
			currentEquity = confirmedEquity;
		}

		// エグジットチェック（エクイティ計算後に処理）
		const exitTrade = tradeByExitTime.get(candle.time);
		if (exitTrade && position) {
			confirmedEquity = position.confirmedAtEntry * exitTrade.net_return;
			currentEquity = confirmedEquity; // 決済時は確定値を使用
			position = null;
		}

		const equityPct = (currentEquity - 1) * 100;
		const confirmedPct = (confirmedEquity - 1) * 100;
		equity_curve.push({
			time: candle.time,
			equity_pct: Number(equityPct.toFixed(4)),
			confirmed_pct: Number(confirmedPct.toFixed(4)),
		});

		if (currentEquity > peakEquity) {
			peakEquity = currentEquity;
		}

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
