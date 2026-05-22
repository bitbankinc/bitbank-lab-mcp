/**
 * render_backtest_chart_generic.ts - 汎用バックテストチャート描画
 *
 * 2つのモード:
 * - default: エクイティ + ドローダウンのみ（軽量、トークン節約）
 * - full: 4段チャート（価格 + オーバーレイ + シグナル / エクイティ / ドローダウン / ポジション）
 */

import { calendarDateFromIso, dayjs } from '../../lib/datetime.js';
import type { BacktestEngineSummary } from './lib/backtest_engine.js';
import type { Overlay } from './lib/strategies/types.js';
import type { Candle, DrawdownPoint, EquityPoint, Trade } from './types.js';

export type ChartDetail = 'default' | 'full';

function formatRange(summary: BacktestEngineSummary): string {
	const start = calendarDateFromIso(summary.evaluation_start) ?? summary.evaluation_start.slice(0, 10);
	const end = calendarDateFromIso(summary.evaluation_end) ?? summary.evaluation_end.slice(0, 10);
	return `${start} ~ ${end}`;
}

// === 固定配色 ===
const COLORS = {
	background: '#1a1a2e',
	grid: '#2d2d44',
	text: '#e0e0e0',
	textMuted: '#888899',
	price: '#60a5fa',
	entryMarker: '#22c55e',
	exitMarker: '#ef4444',
	strategy: '#3b82f6',
	buyHold: '#9ca3af',
	drawdown: '#f87171',
	drawdownFill: 'rgba(248, 113, 113, 0.4)',
	positionLong: '#4ade80',
	zeroline: '#4b5563',
};

// オーバーレイ用のカラーパレット
const OVERLAY_COLORS = [
	'#fbbf24', // yellow
	'#a78bfa', // purple
	'#34d399', // green
	'#f472b6', // pink
	'#60a5fa', // blue
	'#fb923c', // orange
];

// === 固定レイアウト（full モード）===
const LAYOUT_FULL = {
	width: 1000,
	margin: { top: 70, right: 120, bottom: 40, left: 80 },
	priceHeight: 250,
	indicatorHeight: 150,
	equityHeight: 180,
	drawdownHeight: 100,
	positionHeight: 50,
	legendHeight: 25,
	gapBetweenPanels: 40,
};

// === 軽量レイアウト（default モード）===
const LAYOUT_MINIMAL = {
	width: 700,
	height: 350,
	margin: { top: 60, right: 100, bottom: 40, left: 70 },
	equityHeight: 150,
	drawdownHeight: 80,
	gapBetweenPanels: 30,
};

export interface GenericBacktestChartData {
	candles: Candle[];
	overlays: Overlay[];
	trades: Trade[];
	equity_curve: EquityPoint[];
	drawdown_curve: DrawdownPoint[];
	input: {
		pair: string;
		timeframe: string;
		period: string;
		strategyName: string;
		strategyParams: Record<string, number>;
		fee_bp: number;
	};
	summary: BacktestEngineSummary;
}

function formatPrice(price: number): string {
	if (price >= 1000000) return `${(price / 1000000).toFixed(2)}M`;
	if (price >= 1000) return `${(price / 1000).toFixed(1)}K`;
	return price.toFixed(0);
}

function formatPct(pct: number): string {
	return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

/**
 * データの期間に応じて適切な日付フォーマットを選択
 * @param spanDays データの期間（日数）
 * @returns 'full' (YYYY-MM-DD), 'month-day' (MM/DD), 'year-month' (YYYY-MM)
 */
function getDateFormat(spanDays: number): 'full' | 'month-day' | 'year-month' {
	if (spanDays <= 60) return 'month-day'; // 2ヶ月以下: MM/DD
	if (spanDays <= 180) return 'full'; // 6ヶ月以下: YYYY-MM-DD
	return 'year-month'; // それ以上: YYYY-MM
}

function formatDateBySpan(isoTime: string, format: 'full' | 'month-day' | 'year-month'): string {
	const d = dayjs(isoTime);
	switch (format) {
		case 'month-day':
			return d.format('MM/DD');
		case 'full':
			return d.format('YYYY-MM-DD');
		default:
			return d.format('YYYY-MM');
	}
}

function calculateSpanDays(candles: Candle[]): number {
	if (candles.length < 2) return 1;
	const first = dayjs(candles[0].time).valueOf();
	const last = dayjs(candles[candles.length - 1].time).valueOf();
	return Math.ceil((last - first) / (1000 * 60 * 60 * 24));
}

function generateYTicks(min: number, max: number, count: number): number[] {
	const range = max - min;
	const step = range / (count - 1);
	return Array.from({ length: count }, (_, i) => min + step * i);
}

function calculateBuyHoldEquity(candles: Candle[]): number[] {
	if (candles.length === 0) return [];
	const basePrice = candles[0].close;
	return candles.map((c) => ((c.close - basePrice) / basePrice) * 100);
}

function calculatePositionState(candles: Candle[], trades: Trade[]): ('long' | 'none')[] {
	const result: ('long' | 'none')[] = Array.from<'long' | 'none'>({ length: candles.length }).fill('none');
	for (const trade of trades) {
		const entryIdx = candles.findIndex((c) => c.time === trade.entry_time);
		const exitIdx = candles.findIndex((c) => c.time === trade.exit_time);
		if (entryIdx >= 0 && exitIdx >= 0) {
			for (let i = entryIdx; i <= exitIdx; i++) {
				result[i] = 'long';
			}
		}
	}
	return result;
}

/**
 * 汎用チャート描画
 * @param data チャートデータ
 * @param chartDetail 'default' = エクイティ+DD のみ（軽量）, 'full' = 4段チャート
 */
export function renderBacktestChartGeneric(data: GenericBacktestChartData, chartDetail: ChartDetail = 'full'): string {
	if (chartDetail === 'default') {
		return renderMinimalChart(data);
	}
	return renderFullChart(data);
}

/**
 * 軽量チャート描画（エクイティ + ドローダウンのみ）
 */
function renderMinimalChart(data: GenericBacktestChartData): string {
	const { candles, equity_curve, drawdown_curve, input, summary } = data;
	const { width, height, margin, equityHeight, drawdownHeight, gapBetweenPanels } = LAYOUT_MINIMAL;

	const plotWidth = width - margin.left - margin.right;
	const xScale = (i: number) => margin.left + (i / Math.max(1, candles.length - 1)) * plotWidth;

	const buyHoldEquity = calculateBuyHoldEquity(candles);
	const finalBuyHold = buyHoldEquity[buyHoldEquity.length - 1] || 0;

	// パネル位置
	const equityTop = margin.top;
	const equityBottom = equityTop + equityHeight;
	const ddTop = equityBottom + gapBetweenPanels;
	const ddBottom = ddTop + drawdownHeight;

	// エクイティスケール
	const strategyEquity = equity_curve.map((e) => e.equity_pct);
	const allEquity = [...strategyEquity, ...buyHoldEquity];
	const equityMin = Math.min(...allEquity, 0) * 1.1;
	const equityMax = Math.max(...allEquity, 0) * 1.1;
	const equityRange = Math.max(equityMax - equityMin, 10);
	const equityYScale = (pct: number) => equityBottom - ((pct - equityMin) / equityRange) * equityHeight;

	// ドローダウンスケール
	const ddValues = drawdown_curve.map((d) => d.drawdown_pct);
	const ddMax = Math.max(...ddValues, 5);
	const ddYScale = (ddPositive: number) => ddTop + (ddPositive / ddMax) * (drawdownHeight - 10);

	// データ間引き（100ポイント以上なら間引く）
	const step = candles.length > 100 ? Math.ceil(candles.length / 100) : 1;

	// SVG構築（レスポンシブ: viewBox のみ指定）
	const svg: string[] = [];
	svg.push(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" style="max-width:100%;height:auto;">`,
	);
	svg.push(`<rect width="${width}" height="${height}" fill="${COLORS.background}"/>`);

	// タイトル
	const paramsStr = Object.entries(input.strategyParams)
		.map(([k, v]) => `${k}=${v}`)
		.join(', ');
	svg.push(
		`<text x="${width / 2}" y="20" fill="${COLORS.text}" font-size="14" font-weight="bold" text-anchor="middle">`,
	);
	svg.push(`${input.strategyName} (${paramsStr})</text>`);

	svg.push(`<text x="${width / 2}" y="38" fill="${COLORS.textMuted}" font-size="11" text-anchor="middle">`);
	svg.push(
		`${input.pair.toUpperCase()} | ${formatRange(summary)} | Win: ${(summary.win_rate * 100).toFixed(0)}% | MaxDD: -${summary.max_drawdown_pct.toFixed(1)}%</text>`,
	);

	// 最終確定損益 (Realized P&L)
	const finalConfirmed = equity_curve.length > 0 ? equity_curve[equity_curve.length - 1].confirmed_pct : 0;

	// === エクイティカーブ ===
	// 凡例: Mark = Mark-to-Market PnL（時価評価損益）, Real = Realized PnL（確定損益）
	svg.push(
		`<text x="${margin.left}" y="${equityTop - 8}" fill="${COLORS.text}" font-size="10" font-weight="bold">Equity (%)</text>`,
	);
	svg.push(
		`<text x="${margin.left + 70}" y="${equityTop - 8}" fill="${COLORS.strategy}" font-size="9">Mark: ${formatPct(summary.total_pnl_pct)}</text>`,
	);
	svg.push(
		`<text x="${margin.left + 150}" y="${equityTop - 8}" fill="#22c55e" font-size="9">Real: ${formatPct(finalConfirmed)}</text>`,
	);
	svg.push(
		`<text x="${margin.left + 230}" y="${equityTop - 8}" fill="${COLORS.buyHold}" font-size="9">B&amp;H: ${formatPct(finalBuyHold)}</text>`,
	);

	// グリッド
	const equityTicks = generateYTicks(equityMin, equityMax, 3);
	for (const tick of equityTicks) {
		const y = equityYScale(tick);
		svg.push(
			`<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="${COLORS.grid}" stroke-dasharray="2,2"/>`,
		);
		svg.push(
			`<text x="${margin.left - 5}" y="${y + 3}" fill="${COLORS.textMuted}" font-size="8" text-anchor="end">${tick.toFixed(0)}%</text>`,
		);
	}

	// Buy & Hold ライン（間引き）
	const buyHoldPoints: string[] = [];
	for (let i = 0; i < candles.length; i += step) {
		buyHoldPoints.push(`${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(0)},${equityYScale(buyHoldEquity[i]).toFixed(0)}`);
	}
	svg.push(`<path d="${buyHoldPoints.join(' ')}" fill="none" stroke="${COLORS.buyHold}" stroke-width="1.5"/>`);

	// 確定損益ライン (Realized) - 点線、間引き
	if (equity_curve.length > 0) {
		const confirmedPoints: string[] = [];
		for (let i = 0; i < equity_curve.length; i += step) {
			confirmedPoints.push(
				`${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(0)},${equityYScale(equity_curve[i].confirmed_pct).toFixed(0)}`,
			);
		}
		svg.push(
			`<path d="${confirmedPoints.join(' ')}" fill="none" stroke="#22c55e" stroke-width="1.5" stroke-dasharray="4,2"/>`,
		);
	}

	// 評価損益ライン (Mark-to-Market) - 実線、間引き
	if (equity_curve.length > 0) {
		const strategyPoints: string[] = [];
		for (let i = 0; i < equity_curve.length; i += step) {
			strategyPoints.push(
				`${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(0)},${equityYScale(equity_curve[i].equity_pct).toFixed(0)}`,
			);
		}
		svg.push(`<path d="${strategyPoints.join(' ')}" fill="none" stroke="${COLORS.strategy}" stroke-width="2"/>`);
	}

	// === ドローダウン ===
	svg.push(
		`<text x="${margin.left}" y="${ddTop - 8}" fill="${COLORS.text}" font-size="10" font-weight="bold">Drawdown</text>`,
	);
	svg.push(
		`<line x1="${margin.left}" y1="${ddTop}" x2="${width - margin.right}" y2="${ddTop}" stroke="${COLORS.zeroline}" stroke-width="1"/>`,
	);

	if (drawdown_curve.length > 0) {
		const ddPoints: string[] = [];
		for (let i = 0; i < drawdown_curve.length; i += step) {
			ddPoints.push(
				`${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(0)},${ddYScale(drawdown_curve[i].drawdown_pct).toFixed(0)}`,
			);
		}
		const lastX = xScale(drawdown_curve.length - 1).toFixed(0);
		const firstX = xScale(0).toFixed(0);
		const fillPath = `${ddPoints.join(' ')} L${lastX},${ddTop} L${firstX},${ddTop} Z`;
		svg.push(`<path d="${fillPath}" fill="${COLORS.drawdownFill}"/>`);
		svg.push(`<path d="${ddPoints.join(' ')}" fill="none" stroke="${COLORS.drawdown}" stroke-width="1"/>`);
	}

	// X軸ラベル（期間に応じたフォーマット）
	const spanDays = calculateSpanDays(candles);
	const dateFormat = getDateFormat(spanDays);
	const xLabelInterval = Math.max(1, Math.floor(candles.length / 5));
	for (let i = 0; i < candles.length; i += xLabelInterval) {
		svg.push(
			`<text x="${xScale(i)}" y="${ddBottom + 12}" fill="${COLORS.textMuted}" font-size="8" text-anchor="middle">${formatDateBySpan(candles[i].time, dateFormat)}</text>`,
		);
	}

	svg.push('</svg>');
	return svg.join('\n');
}

/**
 * フルチャート描画（4〜5段: インジケータパネルは動的追加）
 */
function renderFullChart(data: GenericBacktestChartData): string {
	const { candles, overlays, trades, equity_curve, drawdown_curve, input, summary } = data;
	const {
		width,
		margin,
		priceHeight,
		indicatorHeight,
		equityHeight,
		drawdownHeight,
		positionHeight,
		gapBetweenPanels,
	} = LAYOUT_FULL;

	const plotWidth = width - margin.left - margin.right;
	const xScale = (i: number) => margin.left + (i / Math.max(1, candles.length - 1)) * plotWidth;

	const buyHoldEquity = calculateBuyHoldEquity(candles);
	const finalBuyHold = buyHoldEquity[buyHoldEquity.length - 1] || 0;
	const positionState = calculatePositionState(candles, trades);

	// オーバーレイを price / indicator に分離
	const priceOverlays = overlays.filter((o) => o.panel !== 'indicator');
	const indicatorOverlays = overlays.filter((o) => o.panel === 'indicator');
	const hasIndicatorPanel = indicatorOverlays.length > 0;

	// トレードマーカー
	const tradeEntryMarkers = trades
		.map((t) => ({
			idx: candles.findIndex((c) => c.time === t.entry_time),
			price: t.entry_price,
		}))
		.filter((m) => m.idx >= 0);

	const tradeExitMarkers = trades
		.map((t) => ({
			idx: candles.findIndex((c) => c.time === t.exit_time),
			price: t.exit_price,
		}))
		.filter((m) => m.idx >= 0);

	// パネル位置（インジケータパネルは動的）
	const priceTop = margin.top;
	const priceBottom = priceTop + priceHeight;

	const indTop = priceBottom + (hasIndicatorPanel ? gapBetweenPanels : 0);
	const indBottom = hasIndicatorPanel ? indTop + indicatorHeight : priceBottom;

	const equityTop = (hasIndicatorPanel ? indBottom : priceBottom) + gapBetweenPanels;
	const equityBottom = equityTop + equityHeight;
	const ddTop = equityBottom + gapBetweenPanels;
	const ddBottom = ddTop + drawdownHeight;
	const posTop = ddBottom + gapBetweenPanels;
	const posBottom = posTop + positionHeight;
	const totalHeight = posBottom + margin.bottom;

	// 価格スケール（priceOverlays のみ使用）
	const allPrices = [
		...candles.map((c) => c.close),
		...tradeEntryMarkers.map((m) => m.price),
		...tradeExitMarkers.map((m) => m.price),
	];

	for (const overlay of priceOverlays) {
		if (overlay.type === 'line') {
			allPrices.push(...overlay.data.filter((v) => !Number.isNaN(v)));
		} else if (overlay.type === 'band') {
			allPrices.push(...overlay.data.upper.filter((v) => !Number.isNaN(v)));
			allPrices.push(...overlay.data.lower.filter((v) => !Number.isNaN(v)));
		}
	}

	const priceMin = Math.min(...allPrices) * 0.995;
	const priceMax = Math.max(...allPrices) * 1.005;
	const priceYScale = (p: number) => priceBottom - ((p - priceMin) / (priceMax - priceMin)) * priceHeight;

	// エクイティスケール
	const strategyEquity = equity_curve.map((e) => e.equity_pct);
	const allEquity = [...strategyEquity, ...buyHoldEquity];
	const equityMin = Math.min(...allEquity, 0) * 1.1;
	const equityMax = Math.max(...allEquity, 0) * 1.1;
	const equityRange = Math.max(equityMax - equityMin, 10);
	const equityYScale = (pct: number) => equityBottom - ((pct - equityMin) / equityRange) * equityHeight;

	// ドローダウンスケール
	const ddValues = drawdown_curve.map((d) => d.drawdown_pct);
	const ddMax = Math.max(...ddValues, 5);
	const ddYScale = (ddPositive: number) => ddTop + (ddPositive / ddMax) * (drawdownHeight - 10);

	// SVG構築（レスポンシブ: viewBox のみ指定、高さは動的）
	const svg: string[] = [];
	svg.push(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${totalHeight}" style="max-width:100%;height:auto;">`,
	);
	svg.push(`<rect width="${width}" height="${totalHeight}" fill="${COLORS.background}"/>`);

	// タイトル
	const paramsStr = Object.entries(input.strategyParams)
		.map(([k, v]) => `${k}=${v}`)
		.join(', ');
	svg.push(
		`<text x="${width / 2}" y="25" fill="${COLORS.text}" font-size="16" font-weight="bold" text-anchor="middle">`,
	);
	svg.push(`${input.strategyName} Backtest (${paramsStr})</text>`);

	svg.push(`<text x="${width / 2}" y="48" fill="${COLORS.textMuted}" font-size="12" text-anchor="middle">`);
	svg.push(
		`${input.pair.toUpperCase()} | ${formatRange(summary)} | Trades: ${summary.trade_count} | Win Rate: ${(summary.win_rate * 100).toFixed(1)}% | Max DD: -${summary.max_drawdown_pct.toFixed(1)}%</text>`,
	);

	// === 価格チャート ===
	const priceTicks = generateYTicks(priceMin, priceMax, 5);
	for (const tick of priceTicks) {
		const y = priceYScale(tick);
		svg.push(
			`<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="${COLORS.grid}" stroke-dasharray="2,2"/>`,
		);
		svg.push(
			`<text x="${width - margin.right + 5}" y="${y + 4}" fill="${COLORS.textMuted}" font-size="10">${formatPrice(tick)}</text>`,
		);
	}

	// 終値ライン
	const pricePath = candles
		.map((c, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${priceYScale(c.close).toFixed(1)}`)
		.join(' ');
	svg.push(`<path d="${pricePath}" fill="none" stroke="${COLORS.price}" stroke-width="1.5"/>`);

	// 価格パネルのオーバーレイ描画（indicator パネルのものは除外）
	let colorIdx = 0;
	const legendItems: { color: string; name: string }[] = [{ color: COLORS.price, name: 'Close' }];

	for (const overlay of priceOverlays) {
		if (overlay.type === 'histogram') continue; // histogram は indicator パネルのみ
		const color = overlay.color || OVERLAY_COLORS[colorIdx % OVERLAY_COLORS.length];
		colorIdx++;

		if (overlay.type === 'line') {
			let started = false;
			const pathParts: string[] = [];
			for (let i = 0; i < overlay.data.length; i++) {
				const v = overlay.data[i];
				if (Number.isNaN(v)) {
					started = false;
					continue;
				}
				const x = xScale(i).toFixed(1);
				const y = priceYScale(v).toFixed(1);
				pathParts.push(`${started ? 'L' : 'M'}${x},${y}`);
				started = true;
			}
			if (pathParts.length > 0) {
				svg.push(`<path d="${pathParts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5"/>`);
			}
			legendItems.push({ color, name: overlay.name });
		} else if (overlay.type === 'band') {
			const upperPath: string[] = [];
			const lowerPath: string[] = [];
			let started = false;

			for (let i = 0; i < overlay.data.upper.length; i++) {
				const upper = overlay.data.upper[i];
				const lower = overlay.data.lower[i];
				if (Number.isNaN(upper) || Number.isNaN(lower)) {
					started = false;
					continue;
				}
				const x = xScale(i).toFixed(1);
				upperPath.push(`${started ? 'L' : 'M'}${x},${priceYScale(upper).toFixed(1)}`);
				lowerPath.push(`${started ? 'L' : 'M'}${x},${priceYScale(lower).toFixed(1)}`);
				started = true;
			}

			if (upperPath.length > 0) {
				svg.push(
					`<path d="${upperPath.join(' ')}" fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="3,3"/>`,
				);
				svg.push(
					`<path d="${lowerPath.join(' ')}" fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="3,3"/>`,
				);
			}
			legendItems.push({ color, name: overlay.name });
		}
	}

	// エントリー/エグジットマーカー
	for (const marker of tradeEntryMarkers) {
		const x = xScale(marker.idx);
		const y = priceYScale(marker.price);
		svg.push(`<circle cx="${x}" cy="${y}" r="6" fill="${COLORS.entryMarker}" stroke="#fff" stroke-width="1.5"/>`);
		svg.push(
			`<text x="${x}" y="${y - 12}" fill="${COLORS.entryMarker}" font-size="10" font-weight="bold" text-anchor="middle">▲</text>`,
		);
	}

	for (const marker of tradeExitMarkers) {
		const x = xScale(marker.idx);
		const y = priceYScale(marker.price);
		svg.push(`<circle cx="${x}" cy="${y}" r="6" fill="${COLORS.exitMarker}" stroke="#fff" stroke-width="1.5"/>`);
		svg.push(
			`<text x="${x}" y="${y + 18}" fill="${COLORS.exitMarker}" font-size="10" font-weight="bold" text-anchor="middle">▼</text>`,
		);
	}

	// 凡例（パネル上部に配置）
	let legendX = margin.left + 10;
	const legendY = priceTop - 8;
	for (const item of legendItems) {
		svg.push(`<text x="${legendX}" y="${legendY}" fill="${item.color}" font-size="10">● ${item.name}</text>`);
		legendX += item.name.length * 7 + 30;
	}
	svg.push(`<text x="${legendX}" y="${legendY}" fill="${COLORS.entryMarker}" font-size="10">▲ Entry</text>`);
	legendX += 60;
	svg.push(`<text x="${legendX}" y="${legendY}" fill="${COLORS.exitMarker}" font-size="10">▼ Exit</text>`);

	// === インジケータサブパネル（MACD 等） ===
	if (hasIndicatorPanel) {
		// インジケータ値のスケール計算
		const allIndValues: number[] = [];
		for (const overlay of indicatorOverlays) {
			if (overlay.type === 'line' || overlay.type === 'histogram') {
				allIndValues.push(...overlay.data.filter((v) => !Number.isNaN(v)));
			}
		}
		// ゼロを含む対称的なスケール（ヒストグラムのため）
		const indAbsMax = Math.max(Math.abs(Math.min(...allIndValues, 0)), Math.abs(Math.max(...allIndValues, 0))) * 1.15;
		const indMin = -indAbsMax;
		const indMax = indAbsMax;
		const indRange = Math.max(indMax - indMin, 1);
		const indYScale = (v: number) => indBottom - ((v - indMin) / indRange) * indicatorHeight;

		// パネルラベル + 凡例
		const indLines = indicatorOverlays.filter((o) => o.type === 'line');
		const panelTitle = indLines.length > 0 ? 'MACD' : 'Indicator';
		svg.push(
			`<text x="${margin.left}" y="${indTop - 15}" fill="${COLORS.text}" font-size="11" font-weight="bold">${panelTitle}</text>`,
		);

		let indLegendX = margin.left + 60;
		for (const overlay of indLines) {
			const col = overlay.type === 'line' ? overlay.color : '#888';
			svg.push(`<text x="${indLegendX}" y="${indTop - 15}" fill="${col}" font-size="9">--- ${overlay.name}</text>`);
			indLegendX += overlay.name.length * 7 + 40;
		}

		// ゼロライン
		const zeroY = indYScale(0);
		svg.push(
			`<line x1="${margin.left}" y1="${zeroY}" x2="${width - margin.right}" y2="${zeroY}" stroke="${COLORS.zeroline}" stroke-width="1"/>`,
		);

		// グリッド + Y軸ラベル
		const indTicks = generateYTicks(indMin, indMax, 5);
		for (const tick of indTicks) {
			const y = indYScale(tick);
			svg.push(
				`<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="${COLORS.grid}" stroke-dasharray="2,2"/>`,
			);
			svg.push(
				`<text x="${margin.left - 5}" y="${y + 3}" fill="${COLORS.textMuted}" font-size="8" text-anchor="end">${formatPrice(tick)}</text>`,
			);
		}

		// ヒストグラム棒の描画
		for (const overlay of indicatorOverlays) {
			if (overlay.type === 'histogram') {
				const barW = Math.max((plotWidth / candles.length) * 0.6, 1);
				for (let i = 0; i < overlay.data.length; i++) {
					const v = overlay.data[i];
					if (Number.isNaN(v)) continue;
					const x = xScale(i) - barW / 2;
					const yVal = indYScale(v);
					const yZero = indYScale(0);
					const barColor = v >= 0 ? overlay.positiveColor : overlay.negativeColor;
					const barTop = Math.min(yVal, yZero);
					const barHeight = Math.abs(yVal - yZero);
					svg.push(
						`<rect x="${x.toFixed(1)}" y="${barTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(barHeight, 0.5).toFixed(1)}" fill="${barColor}"/>`,
					);
				}
			}
		}

		// インジケータライン描画
		for (const overlay of indicatorOverlays) {
			if (overlay.type === 'line') {
				let started = false;
				const pathParts: string[] = [];
				for (let i = 0; i < overlay.data.length; i++) {
					const v = overlay.data[i];
					if (Number.isNaN(v)) {
						started = false;
						continue;
					}
					pathParts.push(`${started ? 'L' : 'M'}${xScale(i).toFixed(1)},${indYScale(v).toFixed(1)}`);
					started = true;
				}
				if (pathParts.length > 0) {
					svg.push(`<path d="${pathParts.join(' ')}" fill="none" stroke="${overlay.color}" stroke-width="1.5"/>`);
				}
			}
		}
	}

	// === エクイティカーブ ===
	const equityLabelY = equityTop - 15;
	svg.push(
		`<text x="${margin.left}" y="${equityLabelY}" fill="${COLORS.text}" font-size="11" font-weight="bold">Equity (%)</text>`,
	);
	svg.push(`<circle cx="${margin.left + 80}" cy="${equityLabelY - 4}" r="4" fill="${COLORS.strategy}"/>`);
	svg.push(
		`<text x="${margin.left + 90}" y="${equityLabelY}" fill="${COLORS.strategy}" font-size="10">Strategy (${formatPct(summary.total_pnl_pct)})</text>`,
	);
	svg.push(`<circle cx="${margin.left + 220}" cy="${equityLabelY - 4}" r="4" fill="${COLORS.buyHold}"/>`);
	svg.push(
		`<text x="${margin.left + 230}" y="${equityLabelY}" fill="${COLORS.buyHold}" font-size="10">Buy&amp;Hold (${formatPct(finalBuyHold)})</text>`,
	);

	const equityTicks = generateYTicks(equityMin, equityMax, 4);
	for (const tick of equityTicks) {
		const y = equityYScale(tick);
		svg.push(
			`<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="${COLORS.grid}" stroke-dasharray="2,2"/>`,
		);
		svg.push(
			`<text x="${margin.left - 10}" y="${y + 4}" fill="${COLORS.textMuted}" font-size="9" text-anchor="end">${tick.toFixed(0)}%</text>`,
		);
	}

	// Buy & Hold ライン
	const buyHoldPath = candles
		.map((_, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${equityYScale(buyHoldEquity[i]).toFixed(1)}`)
		.join(' ');
	svg.push(`<path d="${buyHoldPath}" fill="none" stroke="${COLORS.buyHold}" stroke-width="2"/>`);

	// Strategy ライン
	if (equity_curve.length > 0) {
		const strategyPath = equity_curve
			.map((e, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${equityYScale(e.equity_pct).toFixed(1)}`)
			.join(' ');
		svg.push(`<path d="${strategyPath}" fill="none" stroke="${COLORS.strategy}" stroke-width="2.5"/>`);
	}

	// === ドローダウン ===
	svg.push(
		`<text x="${margin.left}" y="${ddTop - 15}" fill="${COLORS.text}" font-size="11" font-weight="bold">Drawdown (%)</text>`,
	);
	svg.push(
		`<line x1="${margin.left}" y1="${ddTop}" x2="${width - margin.right}" y2="${ddTop}" stroke="${COLORS.zeroline}" stroke-width="1"/>`,
	);

	if (drawdown_curve.length > 0) {
		const ddPathPoints = drawdown_curve
			.map((d, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${ddYScale(d.drawdown_pct).toFixed(1)}`)
			.join(' ');
		const lastX = xScale(drawdown_curve.length - 1).toFixed(1);
		const firstX = xScale(0).toFixed(1);
		const fillPath = `${ddPathPoints} L${lastX},${ddTop} L${firstX},${ddTop} Z`;
		svg.push(`<path d="${fillPath}" fill="${COLORS.drawdownFill}"/>`);
		svg.push(`<path d="${ddPathPoints}" fill="none" stroke="${COLORS.drawdown}" stroke-width="1.5"/>`);
	}

	const ddTickStep = Math.ceil(ddMax / 3);
	const ddTickValues = [
		0,
		...Array.from({ length: 3 }, (_, i) => (i + 1) * ddTickStep).filter((v) => v <= ddMax * 1.2),
	];
	for (const tick of ddTickValues) {
		const y = ddYScale(tick);
		if (y <= ddBottom && y >= ddTop) {
			svg.push(
				`<text x="${margin.left - 10}" y="${y + 4}" fill="${COLORS.textMuted}" font-size="9" text-anchor="end">${tick === 0 ? '0%' : `-${tick.toFixed(0)}%`}</text>`,
			);
		}
	}

	// === ポジション ===
	svg.push(
		`<text x="${margin.left}" y="${posTop - 15}" fill="${COLORS.text}" font-size="11" font-weight="bold">Position</text>`,
	);
	svg.push(
		`<rect x="${margin.left}" y="${posTop}" width="${plotWidth}" height="${positionHeight}" fill="none" stroke="${COLORS.grid}"/>`,
	);

	const barWidth = plotWidth / candles.length;
	for (let i = 0; i < candles.length; i++) {
		if (positionState[i] === 'long') {
			const x = margin.left + (i / candles.length) * plotWidth;
			svg.push(
				`<rect x="${x.toFixed(1)}" y="${posTop + 3}" width="${Math.max(barWidth, 1).toFixed(1)}" height="${positionHeight - 6}" fill="${COLORS.positionLong}" opacity="0.7"/>`,
			);
		}
	}

	svg.push(
		`<rect x="${width - margin.right + 10}" y="${posTop + 5}" width="12" height="12" fill="${COLORS.positionLong}" opacity="0.7"/>`,
	);
	svg.push(
		`<text x="${width - margin.right + 28}" y="${posTop + 15}" fill="${COLORS.positionLong}" font-size="9">Long</text>`,
	);

	// X軸ラベル（期間に応じたフォーマット）
	const spanDays = calculateSpanDays(candles);
	const dateFormat = getDateFormat(spanDays);
	const xLabelInterval = Math.max(1, Math.floor(candles.length / 8));
	for (let i = 0; i < candles.length; i += xLabelInterval) {
		svg.push(
			`<text x="${xScale(i)}" y="${posBottom + 15}" fill="${COLORS.textMuted}" font-size="9" text-anchor="middle">${formatDateBySpan(candles[i].time, dateFormat)}</text>`,
		);
	}

	svg.push('</svg>');
	return svg.join('\n');
}
