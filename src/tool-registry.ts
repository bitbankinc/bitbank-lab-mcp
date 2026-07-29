/**
 * tool-registry.ts — 全 MCP ツール定義の集約
 *
 * 各ツールファイル（tools/*.ts）または複雑なハンドラファイル（src/handlers/*Handler.ts）から
 * toolDef をインポートし、配列として server.ts に提供する。
 *
 * 【ツール追加手順】
 * 1. tools/<name>.ts にツール関数を実装
 * 2. 同ファイル（または src/handlers/<name>Handler.ts）に toolDef を export
 * 3. ★ 本ファイルに import + allToolDefs に追加 ★
 * 4. npm run gen:types && npm run typecheck
 */

import { log } from '../lib/logger.js';
import { toolDef as analyzeBbSnapshot } from '../tools/analyze_bb_snapshot.js';
import { toolDef as analyzeCandlePatterns } from '../tools/analyze_candle_patterns.js';
import { toolDef as analyzeCurrencyStrength } from '../tools/analyze_currency_strength.js';
import { toolDef as analyzeEmaSnapshot } from '../tools/analyze_ema_snapshot.js';
import { toolDef as analyzeIchimokuSnapshot } from '../tools/analyze_ichimoku_snapshot.js';
import { toolDef as analyzeMtfFibonacci } from '../tools/analyze_mtf_fibonacci.js';
import { toolDef as analyzeMtfSma } from '../tools/analyze_mtf_sma.js';
import { toolDef as analyzeSmaSnapshot } from '../tools/analyze_sma_snapshot.js';
import { toolDef as analyzeStochSnapshot } from '../tools/analyze_stoch_snapshot.js';
import { toolDef as analyzeSupportResistance } from '../tools/analyze_support_resistance.js';
import { toolDef as analyzeVolumeProfile } from '../tools/analyze_volume_profile.js';
import { toolDef as detectMacdCross } from '../tools/detect_macd_cross.js';
import { toolDef as detectWhaleEvents } from '../tools/detect_whale_events.js';
import { toolDef as getCandles } from '../tools/get_candles.js';
import { toolDef as getFlowMetrics } from '../tools/get_flow_metrics.js';
import { toolDef as getOrderbook } from '../tools/get_orderbook.js';
import { toolDef as getTicker } from '../tools/get_ticker.js';
import { toolDef as getTransactions } from '../tools/get_transactions.js';
import { toolDef as getUiSnapshot } from '../tools/get_ui_snapshot.js';
import { toolDef as prepareChartData } from '../tools/prepare_chart_data.js';
import { toolDef as prepareDepthData } from '../tools/prepare_depth_data.js';
import { toolDef as refreshPairsCache } from '../tools/refresh_pairs_cache.js';
import { toolDef as renderCandlePatternDiagram } from '../tools/render_candle_pattern_diagram.js';
import { toolDef as renderDepthSvg } from '../tools/render_depth_svg.js';
import { toolDef as validateCandleData } from '../tools/validate_candle_data.js';
import { toolDef as analyzeFibonacci } from './handlers/analyzeFibonacciHandler.js';
import { toolDef as analyzeIndicators } from './handlers/analyzeIndicatorsHandler.js';
import { toolDef as analyzeMarketSignal } from './handlers/analyzeMarketSignalHandler.js';
import { toolDef as detectPatterns } from './handlers/detectPatternsHandler.js';
import { toolDef as getTickersJpy } from './handlers/getTickersJpyHandler.js';
import { toolDef as getVolatilityMetrics } from './handlers/getVolatilityMetricsHandler.js';
import { toolDef as renderChartSvg } from './handlers/renderChartSvgHandler.js';
import { toolDef as runBacktest } from './handlers/runBacktestHandler.js';
import { isPrivateApiEnabled } from './private/config.js';
import { startCleanupTimer } from './private/confirmation.js';
import type { ToolDefinition } from './tool-definition.js';

/**
 * Public ツール一覧（カテゴリ別）
 *
 * | カテゴリ             | ツール数 | 概要                                     |
 * |---------------------|---------|------------------------------------------|
 * | Data Retrieval      | 7       | ticker, orderbook, candles, transactions |
 * | Technical Analysis  | 13      | BB, 一目, SMA, EMA, Stoch, Fibonacci 等  |
 * | Signal & Detection  | 4       | 総合シグナル, パターン, MACD, クジラ       |
 * | Visualization       | 4       | SVG チャート, 板チャート, データ整形       |
 * | Backtesting         | 1       | SMA/MACD/BB/RSI 戦略バックテスト          |
 * | **Private**         | **16**  | 残高, 注文, 約定, ポートフォリオ, 信用取引, HITL確認（要 API キー）|
 */
export const allToolDefs: ToolDefinition[] = [
	// ── Data Retrieval (7) ──
	getTicker,
	getOrderbook,
	getCandles,
	getTransactions,
	getFlowMetrics,
	getVolatilityMetrics,
	getTickersJpy,

	// ── Technical Analysis (13) ──
	analyzeIndicators,
	analyzeBbSnapshot,
	analyzeIchimokuSnapshot,
	analyzeSmaSnapshot,
	analyzeEmaSnapshot,
	analyzeStochSnapshot,
	analyzeMtfSma,
	analyzeSupportResistance,
	analyzeCandlePatterns,
	analyzeVolumeProfile,
	analyzeCurrencyStrength,
	analyzeFibonacci,
	analyzeMtfFibonacci,

	// ── Signal & Detection (4) ──
	analyzeMarketSignal,
	detectPatterns,
	detectMacdCross,
	detectWhaleEvents,

	// ── Visualization (5) ──
	prepareChartData,
	prepareDepthData,
	renderChartSvg,
	renderDepthSvg,
	renderCandlePatternDiagram,

	// ── Data Quality (1) ──
	validateCandleData,

	// ── Backtesting (1) ──
	runBacktest,

	// ── Maintenance (1) ──
	refreshPairsCache,

	// ── MCP Apps support (1) ──
	getUiSnapshot,
];

// ── Private API tools（APIキー設定時のみ有効化） ──
if (isPrivateApiEnabled()) {
	// 動的 import で private ツールを追加
	// tool-registry.ts は起動時に1回だけ評価されるため、top-level await 相当の
	// 即時実行関数で動的 import を行い、allToolDefs に追加する。
	// ※ ESM の top-level await が使えない環境でも動作するよう IIFE で対応。
	const { toolDef: getMyAssets } = await import('../tools/private/get_my_assets.js');
	const { toolDef: getMyTradeHistory } = await import('../tools/private/get_my_trade_history.js');
	const { toolDef: getMyOrders } = await import('../tools/private/get_my_orders.js');
	const { toolDef: analyzeMyPortfolio } = await import('../tools/private/analyze_my_portfolio.js');
	const { toolDef: getMyDepositWithdrawal } = await import('../tools/private/get_my_deposit_withdrawal.js');
	// Trading tools (preview → execute の2ステップ確認)
	const { toolDef: previewOrder } = await import('../tools/private/preview_order.js');
	const { toolDef: createOrder } = await import('../tools/private/create_order.js');
	const { toolDef: previewCancelOrder } = await import('../tools/private/preview_cancel_order.js');
	const { toolDef: cancelOrder } = await import('../tools/private/cancel_order.js');
	const { toolDef: previewCancelOrders } = await import('../tools/private/preview_cancel_orders.js');
	const { toolDef: cancelOrders } = await import('../tools/private/cancel_orders.js');
	const { toolDef: getOrder } = await import('../tools/private/get_order.js');
	const { toolDef: getOrdersInfo } = await import('../tools/private/get_orders_info.js');
	// Margin tools
	const { toolDef: getMarginStatus } = await import('../tools/private/get_margin_status.js');
	const { toolDef: getMarginPositions } = await import('../tools/private/get_margin_positions.js');
	const { toolDef: getMarginTradeHistory } = await import('../tools/private/get_margin_trade_history.js');
	allToolDefs.push(
		getMyAssets,
		getMyTradeHistory,
		getMyOrders,
		analyzeMyPortfolio,
		getMyDepositWithdrawal,
		previewOrder,
		createOrder,
		previewCancelOrder,
		cancelOrder,
		previewCancelOrders,
		cancelOrders,
		getOrder,
		getOrdersInfo,
		getMarginStatus,
		getMarginPositions,
		getMarginTradeHistory,
	);
	startCleanupTimer();
	log('info', {
		type: 'private_api',
		message: 'Private API tools enabled',
		tools: [
			'get_my_assets',
			'get_my_trade_history',
			'get_my_orders',
			'analyze_my_portfolio',
			'get_my_deposit_withdrawal',
			'preview_order',
			'create_order',
			'preview_cancel_order',
			'cancel_order',
			'preview_cancel_orders',
			'cancel_orders',
			'get_order',
			'get_orders_info',
			'get_margin_status',
			'get_margin_positions',
			'get_margin_trade_history',
		],
	});
} else {
	log('info', { type: 'private_api', message: 'Private API tools disabled (no API key configured)' });
}
