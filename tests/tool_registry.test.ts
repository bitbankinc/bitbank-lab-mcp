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

const docsMarkdown = readFileSync(new URL('../docs/tools.md', import.meta.url), 'utf8');

// 「カテゴリ別ツール」節だけが registry と 1:1 で対応すべきカタログで、以降の節はツール名を 1 列目に置く参考表を持つので、節を限定する（ファイル全体から拾うと、カタログでない表を足しただけで件数・重複の検証が落ちる）。
// Private ツールは API キー未設定時 `allToolDefs` に載らないので Private 小節で切る（未知の名前を捨てるフィルタが要らなくなり、カタログに実在しないツール名や綴り違いを集合比較で落とせる）。
// 見出しはプレフィックス一致なので末尾のツール数の更新には影響されず、先頭が `## カテゴリ別ツール` でなくなったら空を返して呼び出し側の件数検証で落ちる。
function extractCatalogToolNames(docs: string): string[] {
	const catalogStart = docs.search(/^## カテゴリ別ツール/m);
	if (catalogStart < 0) return [];
	// slice の +1 は、カテゴリ別ツール見出し自身が下の「次の `## ` 見出し」検索にマッチして範囲が長さ 0 になるのを避けるため。
	const rest = docs.slice(catalogStart + 1);
	const nextHeading = rest.search(/^## /m);
	const catalog = nextHeading < 0 ? rest : rest.slice(0, nextHeading);
	const privateStart = catalog.search(/^### Private API/m);
	const publicCatalog = privateStart < 0 ? catalog : catalog.slice(0, privateStart);

	return Array.from(publicCatalog.matchAll(/^\|\s*`([^`]+)`\s*\|/gm), (match) => match[1]);
}

describe('tool-registry', () => {
	it('期待する 33 ツール名セットと一致する', () => {
		const actualNames = allToolDefs.map((toolDef) => toolDef.name);

		expect(actualNames).toHaveLength(33);
		expect([...actualNames].sort()).toEqual([...expectedToolNames].sort());
	});

	it('docs/tools.md のツール一覧表と registry が実ファイル同士で一致する', () => {
		const actualNames = allToolDefs.map((toolDef) => toolDef.name);
		const docsToolNames = extractCatalogToolNames(docsMarkdown);

		expect(docsToolNames).toHaveLength(33);
		expect(new Set(docsToolNames).size).toBe(docsToolNames.length);
		expect([...docsToolNames].sort()).toEqual([...actualNames].sort());
	});

	// 抽出が黙って空振り / 黙って握り潰しをすると、上の突き合わせが通っていても docs と registry が一致している保証にならない。
	it('見出しの語幹が変わると抽出は空になる（検査が黙って無効化されない）', () => {
		const renamed = docsMarkdown.replace(/^## カテゴリ別ツール.*$/m, '## ツールカタログ');

		expect(renamed).not.toBe(docsMarkdown);
		expect(extractCatalogToolNames(renamed)).toEqual([]);
	});

	it('見出し末尾のツール数が変わっても抽出は変わらない', () => {
		const recounted = docsMarkdown.replace(
			/^## カテゴリ別ツール.*$/m,
			'## カテゴリ別ツール（全 50 ツール：Public 34 + Private 16）',
		);

		expect(recounted).not.toBe(docsMarkdown);
		expect(extractCatalogToolNames(recounted)).toEqual(extractCatalogToolNames(docsMarkdown));
	});

	it('カタログに実在しないツール名を足すと抽出に残る（フィルタで黙って捨てない）', () => {
		const withGhost = docsMarkdown.replace(
			/^\|\s*`get_ticker`\s*\|.*$/m,
			(row) => `| \`get_ghost_tool\` | 実在しないツール |\n${row}`,
		);
		const names = extractCatalogToolNames(withGhost);

		expect(withGhost).not.toBe(docsMarkdown);
		expect(names).toContain('get_ghost_tool');
		// 上の突き合わせテストが集合比較で落とせること（件数も 33 からずれる）。
		expect(names).toHaveLength(34);
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
