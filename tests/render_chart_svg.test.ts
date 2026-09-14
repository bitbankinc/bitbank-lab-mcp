import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';

vi.mock('../tools/analyze_indicators.js', () => ({
	default: vi.fn(),
}));

vi.mock('../lib/get-depth.js', () => ({
	default: vi.fn(),
}));

import getDepth from '../lib/get-depth.js';
import { toolDef } from '../src/handlers/renderChartSvgHandler.js';
import analyzeIndicators from '../tools/analyze_indicators.js';
import renderChartSvg from '../tools/render_chart_svg.js';

// ── ヘルパー ──

function buildCandles(length: number) {
	return Array.from({ length }, (_, i) => {
		const base = 100 + i;
		const day = String((i % 28) + 1).padStart(2, '0');
		return {
			open: base,
			high: base + 5,
			low: base - 5,
			close: base + 2,
			volume: 10 + i,
			isoTime: `2024-01-${day}T00:00:00.000Z`,
		};
	});
}

function buildSeries(length: number, offset = 0): Array<number | null> {
	return Array.from({ length }, (_, i) => 100 + i + offset);
}

function buildSuccess(length: number, metaExtras: Record<string, unknown> = {}) {
	return {
		ok: true as const,
		summary: 'ok',
		data: {
			chart: {
				candles: buildCandles(length),
				indicators: {
					SMA_5: buildSeries(length, -1),
					SMA_20: buildSeries(length, -2),
					SMA_25: buildSeries(length, -3),
					SMA_50: buildSeries(length, -4),
					SMA_75: buildSeries(length, -5),
					SMA_200: buildSeries(length, -6),
					EMA_12: buildSeries(length, -1),
					EMA_26: buildSeries(length, -2),
					EMA_50: buildSeries(length, -3),
					EMA_200: buildSeries(length, -4),
					BB_upper: buildSeries(length, 8),
					BB_middle: buildSeries(length, 2),
					BB_lower: buildSeries(length, -8),
					BB1_upper: buildSeries(length, 5),
					BB1_middle: buildSeries(length, 2),
					BB1_lower: buildSeries(length, -5),
					BB2_upper: buildSeries(length, 8),
					BB2_middle: buildSeries(length, 2),
					BB2_lower: buildSeries(length, -8),
					BB3_upper: buildSeries(length, 11),
					BB3_middle: buildSeries(length, 2),
					BB3_lower: buildSeries(length, -11),
					ICHI_tenkan: buildSeries(length, 1),
					ICHI_kijun: buildSeries(length, 0),
					ICHI_spanA: buildSeries(length, 6),
					ICHI_spanB: buildSeries(length, 4),
					ICHI_chikou: buildSeries(length, -2),
					RSI_14: buildSeries(length, -50),
					MACD_line: buildSeries(length, -90),
					MACD_signal: buildSeries(length, -92),
					MACD_hist: Array.from({ length }, (_, i) => (i % 2 === 0 ? 2 : -1)),
				},
				meta: { pastBuffer: 0, shift: 26 },
			},
		},
		meta: { pair: 'btc_jpy', type: '1day', ...metaExtras },
	};
}

/** ICHIMOKU 用に spanA/spanB のうち末尾 partialNullCount 本を null にして雲不足を再現する */
function buildIchimokuWithPartialCloud(
	length: number,
	partialNullCount: number,
	metaExtras: Record<string, unknown> = {},
) {
	const base = buildSuccess(length, metaExtras);
	const spanA = base.data.chart.indicators.ICHI_spanA as Array<number | null>;
	const spanB = base.data.chart.indicators.ICHI_spanB as Array<number | null>;
	for (let i = length - partialNullCount; i < length; i++) {
		spanA[i] = null;
		spanB[i] = null;
	}
	return base;
}

describe('render_chart_svg', () => {
	const mockedAnalyze = vi.mocked(analyzeIndicators);
	const mockedDepth = vi.mocked(getDepth);

	afterEach(() => vi.clearAllMocks());

	// ── スキーマ ─────────────────────────────────────────

	it('inputSchema: ICHIMOKU と BB の併用を拒否', () => {
		expect(() =>
			toolDef.inputSchema.parse({ pair: 'btc_jpy', type: '1day', limit: 60, indicators: ['ICHIMOKU', 'BB'] }),
		).toThrow();
		expect(() =>
			toolDef.inputSchema.parse({ pair: 'btc_jpy', type: '1day', limit: 60, withIchimoku: true, withBB: true }),
		).toThrow();
	});

	// ── 基本描画（candles-only） ─────────────────────────

	it('指標なしでローソク足 SVG を返す', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60 });
		assertOk(res);
		expect(res.data.svg).toContain('<svg');
		expect(res.data.svg).toContain('</svg>');
		expect(res.meta.pair).toBe('btc_jpy');
		expect(res.meta.sizeBytes).toBeGreaterThan(0);
	});

	it('analyzeIndicators 失敗 → fail 結果', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult({ ok: false, summary: 'API error', meta: { errorType: 'api' } }));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60 });
		assertFail(res);
	});

	// ── SMA ──────────────────────────────────────────────

	it('indicators 配列で SMA を描画', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, indicators: ['SMA_25'] });
		assertOk(res);
		expect(res.meta.indicators).toContain('SMA_25');
		expect(res.data.svg).toContain('SMA');
	});

	it('legacy withSMA も動作（後方互換）', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, withSMA: [25] });
		assertOk(res);
		expect(res.meta.indicators).toContain('SMA_25');
	});

	it('複数 SMA を同時に描画', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({
			pair: 'btc_jpy',
			type: '1day',
			limit: 60,
			indicators: ['SMA_25', 'SMA_75', 'SMA_200'],
		});
		assertOk(res);
		expect(res.meta.indicators).toContain('SMA_25');
		expect(res.meta.indicators).toContain('SMA_75');
		expect(res.meta.indicators).toContain('SMA_200');
	});

	// ── EMA ──────────────────────────────────────────────

	it('EMA を描画', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, indicators: ['EMA_12', 'EMA_26'] });
		assertOk(res);
		expect(res.meta.indicators).toContain('EMA_12');
		expect(res.meta.indicators).toContain('EMA_26');
	});

	// ── ボリンジャーバンド ────────────────────────────────

	it('BB default モードで ±2σ のみ描画', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, indicators: ['BB'] });
		assertOk(res);
		expect(res.meta.bbMode).toBe('default');
		expect(res.meta.indicators).toContain('BB');
	});

	it('BB_EXTENDED モードで ±1σ/±2σ/±3σ 描画', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, indicators: ['BB_EXTENDED'] });
		assertOk(res);
		expect(res.meta.bbMode).toBe('extended');
	});

	it('legacy withBB + bbMode=extended も動作', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, withBB: true, bbMode: 'extended' });
		assertOk(res);
		expect(res.meta.bbMode).toBe('extended');
	});

	// ── 一目均衡表 ───────────────────────────────────────

	it('ICHIMOKU で転換線・基準線・雲を描画', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(90)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, indicators: ['ICHIMOKU'] });
		assertOk(res);
		// 内部名で 'Ichimoku' として記録される
		expect(res.meta.indicators).toContain('Ichimoku');
	});

	it('ICHIMOKU_EXTENDED で遅行スパンも描画', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(90)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, indicators: ['ICHIMOKU_EXTENDED'] });
		assertOk(res);
		expect(res.meta.indicators).toContain('Ichimoku');
	});

	it('一目均衡表使用時に limit < 60 なら自動調整', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(90)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 30, indicators: ['ICHIMOKU'] });
		assertOk(res);
		expect(res.summary).toContain('自動調整');
	});

	// ── heavy chart fallback ─────────────────────────────

	it('limit * layers > 500 で candles-only にフォールバック', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(365)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 365, indicators: ['ICHIMOKU_EXTENDED'] });
		assertOk(res);
		expect(res.summary).toContain('fallback to candles-only');
	});

	// ── ラインチャート ───────────────────────────────────

	it('style=line でライン描画', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, style: 'line' });
		assertOk(res);
		expect(res.data.svg).toContain('<path');
	});

	// ── サブパネル ───────────────────────────────────────

	it('subPanels=["volume"] でボリュームパネルを描画', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, subPanels: ['volume'] });
		assertOk(res);
		expect(res.data.svg).toContain('Volume');
	});

	it('subPanels=["rsi"] で RSI パネルを描画', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, subPanels: ['rsi'] });
		assertOk(res);
		expect(res.data.svg).toContain('RSI');
	});

	it('subPanels=["macd"] で MACD パネルを描画', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, subPanels: ['macd'] });
		assertOk(res);
		expect(res.data.svg).toContain('MACD');
	});

	// ── オーバーレイ ─────────────────────────────────────

	it('overlays.annotations でピンとラベルを描画', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({
			pair: 'btc_jpy',
			type: '1day',
			limit: 60,
			overlays: { annotations: [{ isoTime: '2024-01-05T00:00:00.000Z', text: 'テスト注記' }] },
		});
		assertOk(res);
		expect(res.data.svg).toContain('テスト注記');
	});

	it('overlays.ranges で時間範囲を描画', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({
			pair: 'btc_jpy',
			type: '1day',
			limit: 60,
			overlays: {
				ranges: [{ start: '2024-01-03T00:00:00.000Z', end: '2024-01-10T00:00:00.000Z', label: '範囲テスト' }],
			},
		});
		assertOk(res);
		// 範囲が SVG に含まれる
		expect(res.data.svg).toContain('<svg');
	});

	it('overlays.depth_zones で価格帯を描画', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({
			pair: 'btc_jpy',
			type: '1day',
			limit: 60,
			overlays: { depth_zones: [{ low: 95, high: 105, label: 'ゾーンA' }] },
		});
		assertOk(res);
		expect(res.data.svg).toContain('ゾーンA');
	});

	// ── レジェンド ───────────────────────────────────────

	it('withLegend=true でレジェンドを描画', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({
			pair: 'btc_jpy',
			type: '1day',
			limit: 60,
			withLegend: true,
			indicators: ['SMA_25'],
		});
		assertOk(res);
		expect(res.data.legend).toBeDefined();
	});

	it('withLegend=false でもレジェンドメタは返す', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({
			pair: 'btc_jpy',
			type: '1day',
			limit: 60,
			withLegend: false,
			indicators: ['SMA_25'],
		});
		assertOk(res);
		expect(res.data.legend).toBeDefined();
	});

	// ── Depth チャート ───────────────────────────────────

	it('style=depth で板深度チャートを描画', async () => {
		mockedDepth.mockResolvedValueOnce(
			asMockResult({
				ok: true,
				summary: 'ok',
				data: {
					asks: [
						['101', '1.0'],
						['102', '2.0'],
						['103', '3.0'],
					],
					bids: [
						['99', '1.5'],
						['98', '2.5'],
						['97', '3.5'],
					],
				},
				meta: {},
			}),
		);
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', style: 'depth' });
		assertOk(res);
		expect(res.data.svg).toContain('depth chart');
		expect(res.data.svg).toContain('Bids');
		expect(res.data.svg).toContain('Asks');
		expect(res.data.filePath).toBeDefined();
	});

	it('depth チャートで getDepth 失敗 → fail 結果', async () => {
		mockedDepth.mockResolvedValueOnce(asMockResult({ ok: false, summary: 'depth error', meta: { errorType: 'api' } }));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', style: 'depth' });
		assertFail(res);
	});

	// ── SVG minify / precision ───────────────────────────

	it('svgMinify=false でも SVG を返す', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, svgMinify: false });
		assertOk(res);
		expect(res.data.svg).toContain('<svg');
	});

	it('svgPrecision を設定可能', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, svgPrecision: 0 });
		assertOk(res);
		expect(res.data.svg).toBeDefined();
	});

	// ── meta 構造 ────────────────────────────────────────

	it('meta に range / sizeBytes / layerCount を含む', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60 });
		assertOk(res);
		expect(res.meta.range).toBeDefined();
		expect(res.meta.sizeBytes).toBeGreaterThan(0);
		expect(res.meta.layerCount).toBeDefined();
	});

	// ── viewBoxTight ─────────────────────────────────────

	it('viewBoxTight=false でも描画可能', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, viewBoxTight: false });
		assertOk(res);
		expect(res.data.svg).toContain('<svg');
	});

	// ── barWidthRatio ────────────────────────────────────

	it('barWidthRatio を指定可能', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, barWidthRatio: 0.5 });
		assertOk(res);
		expect(res.data.svg).toBeDefined();
	});

	// ── yPaddingPct ──────────────────────────────────────

	it('yPaddingPct で Y 軸パディングを調整', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, yPaddingPct: 0.1 });
		assertOk(res);
		expect(res.data.svg).toBeDefined();
	});

	// ── simplifyTolerance ────────────────────────────────

	it('simplifyTolerance=0 で簡略化なし', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({
			pair: 'btc_jpy',
			type: '1day',
			limit: 60,
			simplifyTolerance: 0,
			indicators: ['SMA_25'],
		});
		assertOk(res);
		expect(res.data.svg).toBeDefined();
	});

	// ── 上流 warning 伝播 ────────────────────────────────

	it('上流 meta.warning を meta.warning と summary 先頭に伝播', async () => {
		mockedAnalyze.mockResolvedValueOnce(
			asMockResult(
				buildSuccess(60, {
					warning: 'partial fetch: 2024-01-15 / 2024-01-16 を取得できませんでした',
				}),
			),
		);
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60 });
		assertOk(res);
		expect(res.meta.warning).toBe('partial fetch: 2024-01-15 / 2024-01-16 を取得できませんでした');
		expect(res.summary.startsWith('⚠️')).toBe(true);
		expect(res.summary).toContain('partial fetch');
	});

	it('上流 meta.warnings を meta.warnings として保持し summary 先頭に伝播', async () => {
		mockedAnalyze.mockResolvedValueOnce(
			asMockResult(
				buildSuccess(60, {
					warnings: ['SMA_200: データ不足', 'EMA_200: データ不足'],
				}),
			),
		);
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60 });
		assertOk(res);
		expect(res.meta.warnings).toEqual(['SMA_200: データ不足', 'EMA_200: データ不足']);
		expect(res.summary).toContain('SMA_200: データ不足');
		expect(res.summary).toContain('EMA_200: データ不足');
	});

	it('上流 warning / warnings を両方伝播', async () => {
		mockedAnalyze.mockResolvedValueOnce(
			asMockResult(
				buildSuccess(60, {
					warning: 'multi-day fetch partial',
					warnings: ['SMA_200: データ不足'],
				}),
			),
		);
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60 });
		assertOk(res);
		expect(res.meta.warning).toBe('multi-day fetch partial');
		expect(res.meta.warnings).toEqual(['SMA_200: データ不足']);
		expect(res.summary).toContain('multi-day fetch partial');
		expect(res.summary).toContain('SMA_200: データ不足');
	});

	it('上流 warning が無ければ meta.warning は付かず summary 先頭は通常通り', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60 });
		assertOk(res);
		expect(res.meta.warning).toBeUndefined();
		expect(res.meta.warnings).toBeUndefined();
		expect(res.summary.startsWith('⚠️')).toBe(false);
	});

	// ── renderWarnings（自前レンダリング層）───────────────

	it('雲不足の自前警告は meta.renderWarnings に入り meta.warnings には混入しない', async () => {
		// spanA/spanB の末尾を null にして雲のカバー率を 80% 未満に落とす
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildIchimokuWithPartialCloud(90, 55)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, indicators: ['ICHIMOKU'] });
		assertOk(res);
		expect(Array.isArray(res.meta.renderWarnings)).toBe(true);
		expect((res.meta.renderWarnings as string[]).some((w: string) => w.includes('雲のカバー率'))).toBe(true);
		// 上流 warnings には混入していない（雲不足は自前カテゴリ）
		expect(res.meta.warnings).toBeUndefined();
	});

	it('spanB 全 null で「先行スパンB のデータが不足」が renderWarnings に入る', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildIchimokuWithPartialCloud(90, 90)));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, indicators: ['ICHIMOKU'] });
		assertOk(res);
		expect((res.meta.renderWarnings as string[]).some((w: string) => w.includes('先行スパンB'))).toBe(true);
	});

	it('上流 warnings と renderWarnings は別フィールドとして同時に保持される', async () => {
		const mocked = buildIchimokuWithPartialCloud(90, 55, { warnings: ['SMA_200: データ不足'] });
		mockedAnalyze.mockResolvedValueOnce(asMockResult(mocked));
		const res = await renderChartSvg({ pair: 'btc_jpy', type: '1day', limit: 60, indicators: ['ICHIMOKU'] });
		assertOk(res);
		expect(res.meta.warnings).toEqual(['SMA_200: データ不足']);
		expect((res.meta.renderWarnings as string[]).some((w: string) => w.includes('雲のカバー率'))).toBe(true);
	});

	// ── handler 経由での warning 伝播 ────────────────────

	it('handler 経由でも content[0].text 先頭に上流 warning が含まれる', async () => {
		mockedAnalyze.mockResolvedValueOnce(
			asMockResult(
				buildSuccess(60, {
					warning: 'partial fetch detected',
					warnings: ['SMA_200: データ不足'],
				}),
			),
		);
		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 60 })) as {
			content: Array<{ type: string; text: string }>;
		};
		const text = res.content[0].text;
		expect(text.startsWith('⚠️')).toBe(true);
		expect(text).toContain('partial fetch detected');
		expect(text).toContain('SMA_200: データ不足');
	});

	it('handler 経由で renderWarnings が SVG block 直前に表示される', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildIchimokuWithPartialCloud(90, 55)));
		const res = (await toolDef.handler({
			pair: 'btc_jpy',
			type: '1day',
			limit: 60,
			indicators: ['ICHIMOKU'],
		})) as { content: Array<{ type: string; text: string }> };
		const text = res.content[0].text;
		const cloudIdx = text.indexOf('雲のカバー率');
		const svgIdx = text.indexOf('--- Chart SVG ---');
		expect(cloudIdx).toBeGreaterThan(-1);
		expect(svgIdx).toBeGreaterThan(-1);
		// renderWarnings は SVG block より前に出る
		expect(cloudIdx).toBeLessThan(svgIdx);
	});

	// ── toolDef.handler ──────────────────────────────────

	it('toolDef.handler が renderChartSvg に委譲', async () => {
		mockedAnalyze.mockResolvedValueOnce(asMockResult(buildSuccess(60)));
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 60 });
		expect(res).toBeDefined();
	});
});
