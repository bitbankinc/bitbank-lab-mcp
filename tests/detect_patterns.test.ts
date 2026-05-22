import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult } from './_assertResult.js';

vi.mock('../tools/detect_patterns.js', () => ({
	default: vi.fn(),
}));

import { toolDef } from '../src/handlers/detectPatternsHandler.js';
import detectPatterns from '../tools/detect_patterns.js';

function okResult(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		summary: 'ok',
		data: {
			patterns: [],
			overlays: { ranges: [] },
			warnings: [],
			statistics: {},
		},
		meta: {
			pair: 'btc_jpy',
			type: '1day',
			count: 0,
			visualization_hints: { preferred_style: 'line', highlight_patterns: [] },
			debug: { swings: [], candidates: [] },
		},
		...overrides,
	};
}

describe('detect_patterns handler', () => {
	const mockedDetectPatterns = vi.mocked(detectPatterns);

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('データ不足時は generic な tolerance 調整ではなく insufficient data をそのまま案内するべき', async () => {
		mockedDetectPatterns.mockResolvedValueOnce(
			asMockResult(
				okResult({
					summary: 'insufficient data',
					data: {
						patterns: [],
						overlays: { ranges: [] },
						warnings: [],
						statistics: {},
					},
					meta: {
						pair: 'btc_jpy',
						type: '1day',
						count: 0,
						visualization_hints: { preferred_style: 'line', highlight_patterns: [] },
						debug: { swings: [], candidates: [] },
					},
				}),
			),
		);

		const res = await toolDef.handler({
			pair: 'btc_jpy',
			type: '1day',
			limit: 20,
			view: 'detailed',
		});

		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('insufficient data');
		expect(text).not.toContain('tolerance を 0.03-0.06 に緩和してください');
	});

	it('summary view で includeForming=true のときは includeForming を再指定する案内を出すべきではない', async () => {
		mockedDetectPatterns.mockResolvedValueOnce(
			asMockResult(
				okResult({
					data: {
						patterns: [
							{
								type: 'triangle_symmetrical',
								confidence: 0.82,
								timeframe: '1day',
								timeframeLabel: '日足',
								range: {
									start: '2026-01-01T00:00:00.000Z',
									end: '2026-01-10T00:00:00.000Z',
								},
								status: 'forming',
							},
						],
						overlays: {
							ranges: [
								{
									start: '2026-01-01T00:00:00.000Z',
									end: '2026-01-10T00:00:00.000Z',
									label: 'triangle_symmetrical',
								},
							],
						},
						warnings: [],
						statistics: {},
					},
					meta: {
						pair: 'btc_jpy',
						type: '1day',
						count: 1,
						visualization_hints: { preferred_style: 'line', highlight_patterns: ['triangle_symmetrical'] },
						debug: { swings: [], candidates: [] },
					},
				}),
			),
		);

		const res = await toolDef.handler({
			pair: 'btc_jpy',
			type: '1day',
			limit: 90,
			view: 'summary',
			includeForming: true,
		});

		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).not.toContain('※形成中は includeForming=true を指定してください。');
	});

	// ── 上流 warning の伝播（views 切替でも content 先頭に出ること） ──

	it('上流 meta.warning（取得層）が detailed view の content[0].text 先頭に伝播する', async () => {
		mockedDetectPatterns.mockResolvedValueOnce(
			asMockResult(
				okResult({
					summary: '⚠️ partial fetch (3日中1日の取得に失敗)\nBTC_JPY 日足（1day） 90本から0件を検出',
					meta: {
						pair: 'btc_jpy',
						type: '1day',
						count: 0,
						visualization_hints: { preferred_style: 'line', highlight_patterns: [] },
						debug: { swings: [], candidates: [] },
						warning: '⚠️ partial fetch (3日中1日の取得に失敗)',
					},
				}),
			),
		);

		const res = await toolDef.handler({
			pair: 'btc_jpy',
			type: '1day',
			limit: 90,
			view: 'detailed',
		});

		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text.startsWith('⚠️ partial fetch')).toBe(true);
	});

	it('上流 meta.warnings（計算層）が summary view の content[0].text 先頭に伝播する', async () => {
		mockedDetectPatterns.mockResolvedValueOnce(
			asMockResult(
				okResult({
					meta: {
						pair: 'btc_jpy',
						type: '1day',
						count: 0,
						visualization_hints: { preferred_style: 'line', highlight_patterns: [] },
						debug: { swings: [], candidates: [] },
						warnings: ['SMA_200: データ不足', 'Ichimoku: データ不足'],
					},
				}),
			),
		);

		const res = await toolDef.handler({
			pair: 'btc_jpy',
			type: '1day',
			limit: 90,
			view: 'summary',
		});

		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text.startsWith('⚠️ SMA_200: データ不足')).toBe(true);
		expect(text).toContain('⚠️ Ichimoku: データ不足');
	});

	it('上流 warning と warnings 両方が full view の content[0].text 先頭に並ぶ', async () => {
		mockedDetectPatterns.mockResolvedValueOnce(
			asMockResult(
				okResult({
					meta: {
						pair: 'btc_jpy',
						type: '1day',
						count: 0,
						visualization_hints: { preferred_style: 'line', highlight_patterns: [] },
						debug: { swings: [], candidates: [] },
						warning: '⚠️ partial fetch (multi-year)',
						warnings: ['SMA_200: データ不足'],
					},
				}),
			),
		);

		const res = await toolDef.handler({
			pair: 'btc_jpy',
			type: '1day',
			limit: 90,
			view: 'full',
		});

		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		const lines = text.split('\n');
		expect(lines[0]).toContain('⚠️ partial fetch (multi-year)');
		expect(lines[1]).toContain('⚠️ SMA_200: データ不足');
	});

	it('上流 warning が debug view の content[0].text 先頭にも伝播する', async () => {
		mockedDetectPatterns.mockResolvedValueOnce(
			asMockResult(
				okResult({
					meta: {
						pair: 'btc_jpy',
						type: '1day',
						count: 0,
						visualization_hints: { preferred_style: 'line', highlight_patterns: [] },
						debug: { swings: [], candidates: [] },
						warning: '⚠️ partial fetch',
					},
				}),
			),
		);

		const res = await toolDef.handler({
			pair: 'btc_jpy',
			type: '1day',
			limit: 90,
			view: 'debug',
		});

		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text.startsWith('⚠️ partial fetch')).toBe(true);
	});

	it('上流 warning が無い場合は content[0].text に ⚠️ が含まれない', async () => {
		mockedDetectPatterns.mockResolvedValueOnce(asMockResult(okResult()));

		const res = await toolDef.handler({
			pair: 'btc_jpy',
			type: '1day',
			limit: 90,
			view: 'detailed',
		});

		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text.includes('⚠️')).toBe(false);
	});

	it('debug view でも warnings と statistics を structuredContent.data に保持するべき', async () => {
		const warnings = [
			{
				type: 'low_detection_count',
				message: '検出数が少ないです',
				suggestedParams: { tolerancePct: 0.03 },
			},
		];
		const statistics = {
			triangle_symmetrical: {
				detected: 1,
				withAftermath: 1,
				successRate: 0.5,
				avgReturn7d: 0.02,
				avgReturn14d: 0.04,
				medianReturn7d: 0.01,
			},
		};

		mockedDetectPatterns.mockResolvedValueOnce(
			asMockResult(
				okResult({
					data: {
						patterns: [
							{
								type: 'triangle_symmetrical',
								confidence: 0.82,
								timeframe: '1day',
								timeframeLabel: '日足',
								range: {
									start: '2026-01-01T00:00:00.000Z',
									end: '2026-01-10T00:00:00.000Z',
								},
								status: 'completed',
							},
						],
						overlays: {
							ranges: [
								{
									start: '2026-01-01T00:00:00.000Z',
									end: '2026-01-10T00:00:00.000Z',
									label: 'triangle_symmetrical',
								},
							],
						},
						warnings,
						statistics,
					},
					meta: {
						pair: 'btc_jpy',
						type: '1day',
						count: 1,
						visualization_hints: { preferred_style: 'line', highlight_patterns: ['triangle_symmetrical'] },
						debug: {
							swings: [{ idx: 1, price: 100, kind: 'H', isoTime: '2026-01-02T00:00:00.000Z' }],
							candidates: [{ type: 'triangle_symmetrical', accepted: true }],
						},
					},
				}),
			),
		);

		const res = await toolDef.handler({
			pair: 'btc_jpy',
			type: '1day',
			limit: 90,
			view: 'debug',
		});

		// biome-ignore lint/suspicious/noExplicitAny: test assertion for structuredContent
		const sc = (res as any).structuredContent;
		expect(sc.data.warnings).toEqual(warnings);
		expect(sc.data.statistics).toEqual(statistics);
	});

	// ── tz 引数の伝搬（PR-4: 表示日付の tz 整形） ──

	it('tz 既定（Asia/Tokyo）: pattern range の表示が JST 暦日になる', async () => {
		// 2026-10-01T23:30Z は UTC=10/01、JST=10/02。
		mockedDetectPatterns.mockResolvedValueOnce(
			asMockResult(
				okResult({
					data: {
						patterns: [
							{
								type: 'triangle_symmetrical',
								confidence: 0.82,
								timeframe: '1day',
								timeframeLabel: '日足',
								range: {
									start: '2026-10-01T23:30:00.000Z',
									end: '2026-10-10T23:30:00.000Z',
								},
								status: 'completed',
							},
						],
						overlays: { ranges: [] },
						warnings: [],
						statistics: {},
					},
					meta: {
						pair: 'btc_jpy',
						type: '1day',
						count: 1,
						visualization_hints: { preferred_style: 'line', highlight_patterns: [] },
						debug: { swings: [], candidates: [] },
					},
				}),
			),
		);

		const res = await toolDef.handler({
			pair: 'btc_jpy',
			type: '1day',
			limit: 90,
			view: 'detailed',
		});

		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		// 表示は JST 暦日（既定 Asia/Tokyo）
		expect(text).toContain('2026-10-02');
		expect(text).toContain('2026-10-11');
	});

	it("tz='UTC': pattern range の表示が UTC 暦日になる", async () => {
		mockedDetectPatterns.mockResolvedValueOnce(
			asMockResult(
				okResult({
					data: {
						patterns: [
							{
								type: 'triangle_symmetrical',
								confidence: 0.82,
								timeframe: '1day',
								timeframeLabel: '日足',
								range: {
									start: '2026-10-01T23:30:00.000Z',
									end: '2026-10-10T23:30:00.000Z',
								},
								status: 'completed',
							},
						],
						overlays: { ranges: [] },
						warnings: [],
						statistics: {},
					},
					meta: {
						pair: 'btc_jpy',
						type: '1day',
						count: 1,
						visualization_hints: { preferred_style: 'line', highlight_patterns: [] },
						debug: { swings: [], candidates: [] },
					},
				}),
			),
		);

		const res = await toolDef.handler({
			pair: 'btc_jpy',
			type: '1day',
			limit: 90,
			view: 'detailed',
			tz: 'UTC',
		});

		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('2026-10-01');
		expect(text).toContain('2026-10-10');
	});

	it('tz は detectPatterns 呼び出しに伝搬する', async () => {
		mockedDetectPatterns.mockResolvedValueOnce(asMockResult(okResult()));

		await toolDef.handler({
			pair: 'btc_jpy',
			type: '1day',
			limit: 90,
			view: 'detailed',
			tz: 'UTC',
		});

		// detectPatterns(pair, type, limit, opts) の opts.tz に伝搬している
		expect(mockedDetectPatterns).toHaveBeenCalledWith('btc_jpy', '1day', 90, expect.objectContaining({ tz: 'UTC' }));
	});

	it("tz='' は Asia/Tokyo にフォールバックして detectPatterns に渡される", async () => {
		// schema の default('Asia/Tokyo') により tz 省略時は 'Asia/Tokyo' が入る。
		// 明示的に空文字を渡した場合は formatDateInTz 側でフォールバックされるため
		// 表示は同等に JST 暦日になる。
		mockedDetectPatterns.mockResolvedValueOnce(
			asMockResult(
				okResult({
					data: {
						patterns: [
							{
								type: 'triangle_symmetrical',
								confidence: 0.82,
								timeframe: '1day',
								timeframeLabel: '日足',
								range: {
									start: '2026-10-01T23:30:00.000Z',
									end: '2026-10-10T23:30:00.000Z',
								},
								status: 'completed',
							},
						],
						overlays: { ranges: [] },
						warnings: [],
						statistics: {},
					},
					meta: {
						pair: 'btc_jpy',
						type: '1day',
						count: 1,
						visualization_hints: { preferred_style: 'line', highlight_patterns: [] },
						debug: { swings: [], candidates: [] },
					},
				}),
			),
		);

		const res = await toolDef.handler({
			pair: 'btc_jpy',
			type: '1day',
			limit: 90,
			view: 'detailed',
			tz: '',
		});

		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		// 空文字 → Asia/Tokyo フォールバック
		expect(text).toContain('2026-10-02');
		expect(text).toContain('2026-10-11');
	});
});
