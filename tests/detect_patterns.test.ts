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

	// ── パターン表示順序の一貫性（低 confidence H&S が上に出ない） ──

	it('高 confidence パターンが低 confidence H&S より上に表示される（detectPatterns が返した順を handler が崩さない）', async () => {
		// detectPatterns は rankPatterns 適用後の順番で返すため、
		// ここでは「ソート済み」配列を mock として渡し、handler がそれを保つことを検証する。
		// （rankPatterns 単体の挙動は tests/patterns/ranking.test.ts で検証）
		const sortedPatterns = [
			{
				type: 'triangle_symmetrical',
				confidence: 0.82,
				timeframe: '1day',
				timeframeLabel: '日足',
				range: { start: '2026-03-01T00:00:00.000Z', end: '2026-03-20T00:00:00.000Z' },
				status: 'completed',
			},
			{
				type: 'inverse_head_and_shoulders',
				confidence: 0.01,
				timeframe: '1day',
				timeframeLabel: '日足',
				range: { start: '2026-02-01T00:00:00.000Z', end: '2026-02-25T00:00:00.000Z' },
				status: 'forming',
			},
		];

		mockedDetectPatterns.mockResolvedValueOnce(
			asMockResult(
				okResult({
					data: {
						patterns: sortedPatterns,
						overlays: {
							ranges: sortedPatterns.map((p) => ({ start: p.range.start, end: p.range.end, label: p.type })),
						},
						warnings: [],
						statistics: {},
					},
					meta: {
						pair: 'btc_jpy',
						type: '1day',
						count: 2,
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
			includeForming: true,
		});

		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		const idxHigh = text.indexOf('triangle_symmetrical');
		const idxLow = text.indexOf('inverse_head_and_shoulders');
		expect(idxHigh).toBeGreaterThanOrEqual(0);
		expect(idxLow).toBeGreaterThanOrEqual(0);
		expect(idxHigh).toBeLessThan(idxLow);

		// structuredContent.data.patterns の順序も同じ
		// biome-ignore lint/suspicious/noExplicitAny: test assertion for structuredContent
		const sc = (res as any).structuredContent;
		const patTypes: string[] = (sc?.data?.patterns ?? []).map((p: { type: string }) => p.type);
		expect(patTypes[0]).toBe('triangle_symmetrical');
		expect(patTypes[1]).toBe('inverse_head_and_shoulders');
	});

	it('低 confidence H&S は detailed view に「形状不十分 / 低信頼」相当の警告を含む', async () => {
		mockedDetectPatterns.mockResolvedValueOnce(
			asMockResult(
				okResult({
					data: {
						patterns: [
							{
								type: 'inverse_head_and_shoulders',
								confidence: 0.01,
								timeframe: '1day',
								timeframeLabel: '日足',
								range: { start: '2026-02-01T00:00:00.000Z', end: '2026-02-25T00:00:00.000Z' },
								status: 'forming',
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
			includeForming: true,
		});

		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toMatch(/非常に低い|除外候補/);
	});
	// data.warnings は structuredContent 側にしか無く LLM からは見えないため、
	// スキャン窓不足の警告は content[0].text にも出す必要がある。
	describe('スキャン窓不足の警告（data.warnings → content）', () => {
		const scanWarning = {
			type: 'limit_too_small_for_timeframe',
			message: 'limit が日足（1day）に対して小さすぎます: limit≥23 にしてください。',
			suggestedParams: { limit: 23 },
		};

		function resultWithScanWarning() {
			return okResult({
				data: { patterns: [], overlays: { ranges: [] }, warnings: [scanWarning], statistics: {} },
			});
		}

		it.each(['summary', 'detailed', 'full', 'debug'] as const)('%s view の content 先頭に出る', async (view) => {
			mockedDetectPatterns.mockResolvedValueOnce(asMockResult(resultWithScanWarning()));

			const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 20, view });

			const text = (res as { content: Array<{ text: string }> }).content[0].text;
			expect(text.startsWith(`⚠️ ${scanWarning.message}`)).toBe(true);
		});

		it('上流 warning がある場合は上流が先、スキャン窓が後', async () => {
			mockedDetectPatterns.mockResolvedValueOnce(
				asMockResult(
					okResult({
						data: { patterns: [], overlays: { ranges: [] }, warnings: [scanWarning], statistics: {} },
						meta: {
							pair: 'btc_jpy',
							type: '1day',
							count: 0,
							visualization_hints: { preferred_style: 'line', highlight_patterns: [] },
							debug: { swings: [], candidates: [] },
							warning: 'partial fetch',
						},
					}),
				),
			);

			const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 20, view: 'detailed' });

			const lines = (res as { content: Array<{ text: string }> }).content[0].text.split('\n');
			expect(lines[0]).toBe('⚠️ partial fetch');
			expect(lines[1]).toBe(`⚠️ ${scanWarning.message}`);
		});

		it('low_detection_count は content に出さない（従来どおり structuredContent のみ）', async () => {
			mockedDetectPatterns.mockResolvedValueOnce(
				asMockResult(
					okResult({
						data: {
							patterns: [],
							overlays: { ranges: [] },
							warnings: [{ type: 'low_detection_count', message: '検出数が少ないです' }],
							statistics: {},
						},
					}),
				),
			);

			const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 90, view: 'detailed' });

			const text = (res as { content: Array<{ text: string }> }).content[0].text;
			expect(text.includes('⚠️')).toBe(false);
			expect(text.includes('検出数が少ないです')).toBe(false);
		});
	});
});
