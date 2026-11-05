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
import { startNonceCleanupTimer } from './private/request-state.js';
import type { ToolDefinition } from './tool-definition.js';

export const allToolDefs: ToolDefinition[] = [
	getTicker,
	getOrderbook,
	getCandles,
	getTransactions,
	getFlowMetrics,
	getVolatilityMetrics,
	getTickersJpy,

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

	analyzeMarketSignal,
	detectPatterns,
	detectMacdCross,
	detectWhaleEvents,

	prepareChartData,
	prepareDepthData,
	renderChartSvg,
	renderDepthSvg,
	renderCandlePatternDiagram,

	validateCandleData,

	runBacktest,

	refreshPairsCache,

	getUiSnapshot,
];

if (isPrivateApiEnabled()) {
	const { toolDef: getMyAssets } = await import('../tools/private/get_my_assets.js');
	const { toolDef: getMyTradeHistory } = await import('../tools/private/get_my_trade_history.js');
	const { toolDef: getMyOrders } = await import('../tools/private/get_my_orders.js');
	const { toolDef: analyzeMyPortfolio } = await import('../tools/private/analyze_my_portfolio.js');
	const { toolDef: getMyDepositWithdrawal } = await import('../tools/private/get_my_deposit_withdrawal.js');
	const { toolDef: previewOrder } = await import('../tools/private/preview_order.js');
	const { toolDef: createOrder } = await import('../tools/private/create_order.js');
	const { toolDef: previewCancelOrder } = await import('../tools/private/preview_cancel_order.js');
	const { toolDef: cancelOrder } = await import('../tools/private/cancel_order.js');
	const { toolDef: previewCancelOrders } = await import('../tools/private/preview_cancel_orders.js');
	const { toolDef: cancelOrders } = await import('../tools/private/cancel_orders.js');
	const { toolDef: getOrder } = await import('../tools/private/get_order.js');
	const { toolDef: getOrdersInfo } = await import('../tools/private/get_orders_info.js');
	const { toolDef: getMarginStatus } = await import('../tools/private/get_margin_status.js');
	const { toolDef: getMarginPositions } = await import('../tools/private/get_margin_positions.js');
	const { toolDef: getMarginTradeHistory } = await import('../tools/private/get_margin_trade_history.js');
	const privateToolDefs = [
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
	];
	allToolDefs.push(...privateToolDefs);
	// 使用済み確認トークン / nonce は Private ツールでしか記録されないので、定期 purge は有効化と同じ場所で起動する。
	startCleanupTimer();
	startNonceCleanupTimer();
	log('info', {
		type: 'private_api',
		message: 'Private API tools enabled',
		tools: privateToolDefs.map((t) => t.name),
	});
} else {
	log('info', { type: 'private_api', message: 'Private API tools disabled (no API key configured)' });
}
