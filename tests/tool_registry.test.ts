import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allToolDefs } from '../src/tool-registry.js';

const expectedToolNames = [
	'get_ticker',
	'get_orderbook',
	'get_candles',
	'get_transactions',
	'get_flow_metrics',
	'get_volatility_metrics',
	'get_tickers_jpy',
	'analyze_indicators',
	'analyze_bb_snapshot',
	'analyze_ichimoku_snapshot',
	'analyze_sma_snapshot',
	'analyze_ema_snapshot',
	'analyze_stoch_snapshot',
	'analyze_mtf_sma',
	'analyze_support_resistance',
	'analyze_candle_patterns',
	'analyze_market_signal',
	'analyze_volume_profile',
	'analyze_currency_strength',
	'analyze_fibonacci',
	'analyze_mtf_fibonacci',
	'detect_patterns',
	'detect_macd_cross',
	'detect_whale_events',
	'validate_candle_data',
	'prepare_chart_data',
	'prepare_depth_data',
	'render_chart_svg',
	'render_depth_svg',
	'render_candle_pattern_diagram',
	'run_backtest',
	'refresh_pairs_cache',
	'get_ui_snapshot',
];

describe('tool-registry', () => {
	it('期待する 33 ツール名セットと一致する', () => {
		const actualNames = allToolDefs.map((toolDef) => toolDef.name);

		expect(actualNames).toHaveLength(33);
		expect([...actualNames].sort()).toEqual([...expectedToolNames].sort());
	});

	it('docs/tools.md のツール一覧表と registry が実ファイル同士で一致する', () => {
		const docs = readFileSync(new URL('../docs/tools.md', import.meta.url), 'utf8');
		const actualNames = allToolDefs.map((toolDef) => toolDef.name);
		const docsToolNames = Array.from(docs.matchAll(/^\|\s*`([^`]+)`\s*\|/gm), (match) => match[1]).filter((name) =>
			actualNames.includes(name),
		);

		expect(docsToolNames).toHaveLength(33);
		expect(new Set(docsToolNames).size).toBe(docsToolNames.length);
		expect([...docsToolNames].sort()).toEqual([...actualNames].sort());
	});

	it('ツール名の重複がない', () => {
		const actualNames = allToolDefs.map((toolDef) => toolDef.name);

		expect(new Set(actualNames).size).toBe(actualNames.length);
	});

	it('各 toolDef が server 登録に必要な基本要素を持つ', () => {
		for (const toolDef of allToolDefs) {
			expect(toolDef.name).toEqual(expect.any(String));
			expect(toolDef.name.length).toBeGreaterThan(0);
			expect(toolDef.description).toEqual(expect.any(String));
			expect(toolDef.description.length).toBeGreaterThan(0);
			expect(toolDef.inputSchema).toBeTruthy();
			expect(typeof (toolDef.inputSchema as { parse?: unknown }).parse).toBe('function');
			expect(typeof toolDef.handler).toBe('function');
		}
	});
});
