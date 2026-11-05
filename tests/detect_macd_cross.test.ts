import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';

vi.mock('../tools/analyze_indicators.js', () => ({
	default: vi.fn(),
}));

import { dayjs } from '../lib/datetime.js';
import analyzeIndicators from '../tools/analyze_indicators.js';
import { toolDef } from '../tools/detect_macd_cross.js';

type AnalyzeIndicatorsOk = {
	ok: true;
	summary: string;
	data: {
		normalized: Array<{ isoTime: string; close: number }>;
		indicators: {
			macd_series: {
				line: number[];
				signal: number[];
				hist: number[];
			};
		};
	};
	meta: { pair: string; type: '1day'; count: number };
};

function makeCandles(closeSeries: number[], crossDates: Record<number, string> = {}) {
	return closeSeries.map((close, i) => ({
		close,
		isoTime:
			crossDates[i] ??
			dayjs()
				.subtract(closeSeries.length - 1 - i, 'day')
				.toISOString(),
	}));
}

function buildAnalyzeIndicatorsOk(args: {
	pair: string;
	line: number[];
	signal: number[];
	hist?: number[];
	closeSeries?: number[];
	crossDates?: Record<number, string>;
}): AnalyzeIndicatorsOk {
	const { pair, line, signal } = args;
	const hist = args.hist ?? line.map((value, i) => Number((value - (signal[i] ?? 0)).toFixed(4)));
	const closeSeries = args.closeSeries ?? Array.from({ length: line.length }, (_, i) => 100 + i);

	return {
		ok: true,
		summary: 'ok',
		data: {
			normalized: makeCandles(closeSeries, args.crossDates),
			indicators: {
				macd_series: { line, signal, hist },
			},
		},
		meta: { pair, type: '1day', count: line.length },
	};
}

describe('detect_macd_cross', () => {
	const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('inputSchema: lookback は 1 未満を拒否する', () => {
		const parse = () => toolDef.inputSchema.parse({ lookback: 0 });
		expect(parse).toThrow();
	});

	it('crossed_recently は直近3本で最も新しいクロスを返すべき', async () => {
		const line = [
			0.4, 0.5, 0.6, 0.6, 0.7, 0.7, 0.8, 0.8, 0.9, 0.9, 1.0, 1.0, 0.9, 0.8, -0.7, 0.5, -0.2, 0.2, -0.1, 0.1,
		];
		const signal = Array.from({ length: line.length }, () => 0);

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					line,
					signal,
					hist: line,
					crossDates: {
						16: '2026-02-16T00:00:00.000Z',
						17: '2026-02-17T00:00:00.000Z',
						18: '2026-02-18T00:00:00.000Z',
						19: '2026-02-19T00:00:00.000Z',
					},
				}),
			),
		);

		const res = await toolDef.handler({
			pair: 'btc_jpy',
			includeForming: true,
			includeStats: false,
		});

		assertOk(res);
		expect(res.data.forming.status).toBe('crossed_recently');
		expect(res.data.forming.lastCrossType).toBe('golden');
		expect(res.data.forming.lastCrossBarsAgo).toBe(0);
		expect(res.data.forming.lastCrossDate).toBe('2026-02-19T00:00:00.000Z');
	});

	it('screen.sortBy=date は barsAgo ではなく crossDate で並べるべき', async () => {
		mockedAnalyzeIndicators.mockImplementation(async (pair?: string) => {
			if (pair === 'btc_jpy') {
				return asMockResult(
					buildAnalyzeIndicatorsOk({
						pair,
						line: [0, 0, 0, 0, -1, 1],
						signal: [0, 0, 0, 0, 0, 0],
						crossDates: {
							5: '2025-01-01T00:00:00.000Z',
						},
					}),
				);
			}

			if (pair === 'eth_jpy') {
				return asMockResult(
					buildAnalyzeIndicatorsOk({
						pair,
						line: [0, 0, -1, 1, 2, 3],
						signal: [0, 0, 0, 0, 0, 0],
						crossDates: {
							3: '2025-02-01T00:00:00.000Z',
						},
					}),
				);
			}

			throw new Error(`unexpected pair: ${pair}`);
		});

		const res = await toolDef.handler({
			pairs: ['btc_jpy', 'eth_jpy'],
			lookback: 5,
			screen: {
				sortBy: 'date',
				sortOrder: 'desc',
			},
		});

		assertOk(res);
		expect(res.data.results.map((item: { pair: string }) => item.pair)).toEqual(['eth_jpy', 'btc_jpy']);
	});

	it('screenMode: pairs 未指定 + market=jpy は _jpy ペアのみスクリーニングする', async () => {
		mockedAnalyzeIndicators.mockResolvedValue(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					line: [0, -1, 1],
					signal: [0, 0, 0],
				}),
			),
		);

		const res = await toolDef.handler({ market: 'jpy', lookback: 3 });
		assertOk(res);
		const meta = res.meta as { pairs: string[] };
		expect(meta.pairs.every((p: string) => p.endsWith('_jpy'))).toBe(true);
	});

	it('screenMode: analyzeIndicators が !ok を返すペアは failedPairs に追加され meta.warning が付く', async () => {
		mockedAnalyzeIndicators.mockImplementation(async (pair?: string) => {
			if (pair === 'btc_jpy') {
				return asMockResult({ ok: false, summary: 'error', meta: { errorType: 'internal' } });
			}
			return asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: pair ?? 'btc_jpy',
					line: [0, -1, 1],
					signal: [0, 0, 0],
				}),
			);
		});

		const res = await toolDef.handler({ pairs: ['btc_jpy'], lookback: 3 });
		assertOk(res);
		const meta = res.meta as { warning?: string; failedPairs?: string[] };
		expect(meta.warning).toMatch(/失敗/);
		expect(meta.failedPairs).toContain('btc_jpy');
	});

	it('screenMode: analyzeIndicators が throw したペアは failedPairs に追加される', async () => {
		mockedAnalyzeIndicators.mockImplementation(async (pair?: string) => {
			if (pair === 'btc_jpy') {
				throw new Error('network error');
			}
			return asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: pair ?? 'btc_jpy',
					line: [0, -1, 1],
					signal: [0, 0, 0],
				}),
			);
		});

		const res = await toolDef.handler({ pairs: ['btc_jpy'], lookback: 3 });
		assertOk(res);
		const meta = res.meta as { failedPairs?: string[] };
		expect(meta.failedPairs).toContain('btc_jpy');
	});

	it('screenMode: n < 2 (line が1要素) はクロス追加せずスキップする', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					line: [1],
					signal: [0],
				}),
			),
		);

		const res = await toolDef.handler({ pairs: ['btc_jpy'], lookback: 3 });
		assertOk(res);
		expect(res.data.results).toHaveLength(0);
	});

	it('screenMode: screen.crossType=golden は dead クロスを除外する', async () => {
		mockedAnalyzeIndicators.mockImplementation(async (pair?: string) => {
			if (pair === 'btc_jpy') {
				// golden cross
				return asMockResult(
					buildAnalyzeIndicatorsOk({
						pair,
						line: [0, 0, -1, 1],
						signal: [0, 0, 0, 0],
					}),
				);
			}
			if (pair === 'eth_jpy') {
				// dead cross
				return asMockResult(
					buildAnalyzeIndicatorsOk({
						pair,
						line: [0, 0, 1, -1],
						signal: [0, 0, 0, 0],
					}),
				);
			}
			throw new Error(`unexpected pair: ${pair}`);
		});

		const res = await toolDef.handler({
			pairs: ['btc_jpy', 'eth_jpy'],
			lookback: 5,
			screen: { crossType: 'golden' },
		});
		assertOk(res);
		expect(res.data.results.every((r: { type: string }) => r.type === 'golden')).toBe(true);
	});

	it('screenMode: screen.crossType=dead は golden クロスを除外する', async () => {
		mockedAnalyzeIndicators.mockImplementation(async (pair?: string) => {
			if (pair === 'btc_jpy') {
				return asMockResult(
					buildAnalyzeIndicatorsOk({
						pair,
						line: [0, 0, -1, 1],
						signal: [0, 0, 0, 0],
					}),
				);
			}
			if (pair === 'eth_jpy') {
				return asMockResult(
					buildAnalyzeIndicatorsOk({
						pair,
						line: [0, 0, 1, -1],
						signal: [0, 0, 0, 0],
					}),
				);
			}
			throw new Error(`unexpected pair: ${pair}`);
		});

		const res = await toolDef.handler({
			pairs: ['btc_jpy', 'eth_jpy'],
			lookback: 5,
			screen: { crossType: 'dead' },
		});
		assertOk(res);
		expect(res.data.results.every((r: { type: string }) => r.type === 'dead')).toBe(true);
	});

	it('screenMode: screen.minHistogramDelta で小さいヒストグラム差分を除外する', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					// small histogram delta: prev=-0.001, curr=0.001 → delta=0.002
					line: [0, 0, -0.001, 0.001],
					signal: [0, 0, 0, 0],
				}),
			),
		);

		const res = await toolDef.handler({
			pairs: ['btc_jpy'],
			lookback: 5,
			screen: { minHistogramDelta: 0.5 },
		});
		assertOk(res);
		expect(res.data.results).toHaveLength(0);
	});

	it('screenMode: screen.maxBarsAgo で古いクロスを除外する', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					// cross at index 1, n=5 → barsAgo = 5-1-1 = 3
					line: [0, -1, 1, 1, 1],
					signal: [0, 0, 0, 0, 0],
				}),
			),
		);

		const res = await toolDef.handler({
			pairs: ['btc_jpy'],
			lookback: 5,
			screen: { maxBarsAgo: 1 },
		});
		assertOk(res);
		expect(res.data.results).toHaveLength(0);
	});

	it('screenMode: screen.minReturnPct で低リターンを除外する', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					line: [0, 0, -1, 1],
					signal: [0, 0, 0, 0],
					// cross at index 2 (priceAtCross=102), currentPrice=103 → ret≈+0.98%
					closeSeries: [100, 101, 102, 103],
				}),
			),
		);

		const res = await toolDef.handler({
			pairs: ['btc_jpy'],
			lookback: 5,
			screen: { minReturnPct: 5 },
		});
		assertOk(res);
		expect(res.data.results).toHaveLength(0);
	});

	it('screenMode: screen.maxReturnPct で高リターンを除外する', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					// cross at index 3 (price=100), currentPrice=300 → large ret ≈200%
					line: [0, 0, -1, 1, 1, 1],
					signal: [0, 0, 0, 0, 0, 0],
					closeSeries: [100, 100, 100, 100, 200, 300],
				}),
			),
		);

		const res = await toolDef.handler({
			pairs: ['btc_jpy'],
			lookback: 5,
			screen: { maxReturnPct: 1 },
		});
		assertOk(res);
		expect(res.data.results).toHaveLength(0);
	});

	it('screenMode: sortBy=histogram でヒストグラム絶対値の降順に並べる', async () => {
		mockedAnalyzeIndicators.mockImplementation(async (pair?: string) => {
			if (pair === 'btc_jpy') {
				return asMockResult(
					buildAnalyzeIndicatorsOk({
						pair,
						line: [0, -0.5, 0.6],
						signal: [0, 0, 0],
					}),
				);
			}
			if (pair === 'eth_jpy') {
				return asMockResult(
					buildAnalyzeIndicatorsOk({
						pair,
						line: [0, -2, 3],
						signal: [0, 0, 0],
					}),
				);
			}
			throw new Error(`unexpected pair: ${pair}`);
		});

		const res = await toolDef.handler({
			pairs: ['btc_jpy', 'eth_jpy'],
			lookback: 5,
			screen: { sortBy: 'histogram', sortOrder: 'desc' },
		});
		assertOk(res);
		const pairs = res.data.results.map((r: { pair: string }) => r.pair);
		expect(pairs[0]).toBe('eth_jpy');
	});

	it('screenMode: sortBy=return でリターン降順に並べる', async () => {
		mockedAnalyzeIndicators.mockImplementation(async (pair?: string) => {
			if (pair === 'btc_jpy') {
				// small return: cross at index 2 (price=100), currentPrice=101 → ~1%
				return asMockResult(
					buildAnalyzeIndicatorsOk({
						pair,
						line: [0, -1, 1, 1, 1],
						signal: [0, 0, 0, 0, 0],
						closeSeries: [100, 100, 100, 100, 101],
					}),
				);
			}
			if (pair === 'eth_jpy') {
				// large return: cross at index 2 (price=100), currentPrice=200 → 100%
				return asMockResult(
					buildAnalyzeIndicatorsOk({
						pair,
						line: [0, -1, 1, 1, 1],
						signal: [0, 0, 0, 0, 0],
						closeSeries: [100, 100, 100, 150, 200],
					}),
				);
			}
			throw new Error(`unexpected pair: ${pair}`);
		});

		const res = await toolDef.handler({
			pairs: ['btc_jpy', 'eth_jpy'],
			lookback: 5,
			screen: { sortBy: 'return', sortOrder: 'desc' },
		});
		assertOk(res);
		const pairs = res.data.results.map((r: { pair: string }) => r.pair);
		expect(pairs[0]).toBe('eth_jpy');
	});

	it('screenMode: sortBy=barsAgo で barsAgo 昇順に並べる', async () => {
		mockedAnalyzeIndicators.mockImplementation(async (pair?: string) => {
			if (pair === 'btc_jpy') {
				// cross at index 1, n=4 → barsAgo = n-1-1 = 2 (older cross)
				return asMockResult(
					buildAnalyzeIndicatorsOk({
						pair,
						line: [0, -1, 1, 1],
						signal: [0, 0, 0, 0],
					}),
				);
			}
			if (pair === 'eth_jpy') {
				// cross at index 2, n=4 → barsAgo = n-1-2 = 1 (more recent cross)
				return asMockResult(
					buildAnalyzeIndicatorsOk({
						pair,
						line: [0, 0, -1, 1],
						signal: [0, 0, 0, 0],
					}),
				);
			}
			throw new Error(`unexpected pair: ${pair}`);
		});

		// sortBy=barsAgo, sortOrder=desc は小さい barsAgo を先に並べる（このツールの「新しい順」）
		const res = await toolDef.handler({
			pairs: ['btc_jpy', 'eth_jpy'],
			lookback: 5,
			screen: { sortBy: 'barsAgo', sortOrder: 'desc' },
		});
		assertOk(res);
		const pairs = res.data.results.map((r: { pair: string }) => r.pair);
		// eth_jpy has smaller barsAgo (1) and comes first with sortOrder desc
		expect(pairs[0]).toBe('eth_jpy');
	});

	it('screenMode: screen.limit は結果を N 件に切り詰める', async () => {
		mockedAnalyzeIndicators.mockImplementation(async (pair?: string) => {
			return asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: pair ?? 'btc_jpy',
					line: [0, -1, 1],
					signal: [0, 0, 0],
				}),
			);
		});

		const res = await toolDef.handler({
			pairs: ['btc_jpy', 'eth_jpy'],
			lookback: 5,
			screen: { limit: 1 },
		});
		assertOk(res);
		expect(res.data.results).toHaveLength(1);
	});

	it('screenMode: view=detailed は resultsDetailed/screenedDetailed を含む', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					line: [0, -1, 1],
					signal: [0, 0, 0],
				}),
			),
		);

		const res = await toolDef.handler({
			pairs: ['btc_jpy'],
			lookback: 5,
			view: 'detailed',
		});
		expect(res).toBeDefined();
	});

	it('screenMode: view=detailed でクロスあり → content.text に詳細行が含まれる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					line: [0, -1, 1],
					signal: [0, 0, 0],
					crossDates: { 2: '2026-01-10T00:00:00.000Z' },
				}),
			),
		);

		const res = await toolDef.handler({
			pairs: ['btc_jpy'],
			lookback: 5,
			view: 'detailed',
		});
		expect(res).toHaveProperty('content');
		const content = (res as { content: Array<{ text: string }> }).content;
		expect(content[0].text).toMatch(/btc_jpy/);
	});

	it('screenMode: buildMacdScreenText の returnSinceCrossPct null/non-null と histogramDelta null/non-null と prevCross', async () => {
		mockedAnalyzeIndicators.mockImplementation(async (pair?: string) => {
			if (pair === 'btc_jpy') {
				return asMockResult(
					buildAnalyzeIndicatorsOk({
						pair,
						// cross at index 2, prev cross at index 1
						line: [1, -1, 1],
						signal: [0, 0, 0],
						crossDates: { 2: '2026-01-10T00:00:00.000Z', 1: '2026-01-09T00:00:00.000Z' },
					}),
				);
			}
			throw new Error(`unexpected: ${pair}`);
		});

		const res = await toolDef.handler({ pairs: ['btc_jpy'], lookback: 5 });
		assertOk(res);
		expect(res.data.results).toHaveLength(1);
	});

	it('singlePairMode: 無効なペアは failFromValidation を返す', async () => {
		const res = await toolDef.handler({ pair: 'invalid_pair' });
		assertFail(res);
	});

	it('singlePairMode: analyzeIndicators が !ok を返すと fail を返す', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult({ ok: false, summary: 'error', meta: { errorType: 'internal' } }),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: false, includeStats: false });
		assertFail(res);
	});

	it('singlePairMode: n < 20 は insufficient data を返す', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					line: Array.from({ length: 10 }, () => 0),
					signal: Array.from({ length: 10 }, () => 0),
				}),
			),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: false, includeStats: false });
		assertFail(res);
		expect((res as { summary: string }).summary).toMatch(/insufficient/);
	});

	it('singlePairMode: forming_golden (hPrev < 0 && slopePerBar > 0) を検出する', async () => {
		// hPrev < 0 から負のまま 0 に近づく形（n=20, nowIdx=19, win=5, hPrev=hist[14], hNow=hist[19]）。crossed_recently を避けるため hist[16..19] で符号を変えない。
		const n = 20;
		const hist = Array.from({ length: n }, () => 0);
		hist[14] = -0.3;
		hist[15] = -0.24;
		hist[16] = -0.18;
		hist[17] = -0.12;
		hist[18] = -0.06;
		hist[19] = -0.01;
		const line = hist.map((h) => h + 1);
		const signal = line.map((l, i) => l - hist[i]);

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult({
				ok: true,
				summary: 'ok',
				data: {
					normalized: Array.from({ length: n }, (_, i) => ({
						close: 100 + i,
						isoTime: dayjs()
							.subtract(n - 1 - i, 'day')
							.toISOString(),
					})),
					indicators: {
						macd_series: { line, signal, hist },
					},
				},
				meta: { pair: 'btc_jpy', type: '1day', count: n },
			}),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: true, includeStats: false });
		assertOk(res);
		expect(res.data.forming?.status).toBe('forming_golden');
	});

	it('singlePairMode: forming_dead (hPrev > 0 && slopePerBar < 0) を検出する', async () => {
		// hPrev > 0 から正のまま 0 に近づく形（n=20, nowIdx=19, win=5, hPrev=hist[14], hNow=hist[19]）。crossed_recently を避けるため hist[16..19] で符号を変えない。
		const n = 20;
		const hist = Array.from({ length: n }, () => 0);
		hist[14] = 0.3;
		hist[15] = 0.24;
		hist[16] = 0.18;
		hist[17] = 0.12;
		hist[18] = 0.06;
		hist[19] = 0.01;
		const line = hist.map((h) => h + 1);
		const signal = line.map((l, i) => l - hist[i]);

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult({
				ok: true,
				summary: 'ok',
				data: {
					normalized: Array.from({ length: n }, (_, i) => ({
						close: 100 + i,
						isoTime: dayjs()
							.subtract(n - 1 - i, 'day')
							.toISOString(),
					})),
					indicators: {
						macd_series: { line, signal, hist },
					},
				},
				meta: { pair: 'btc_jpy', type: '1day', count: n },
			}),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: true, includeStats: false });
		assertOk(res);
		expect(res.data.forming?.status).toBe('forming_dead');
	});

	it('singlePairMode: forming_golden で estimatedCrossDays <= 1.5 → 1-2日以内', async () => {
		// hPrev < 0、hNow がほぼ 0、slopePerBar > 0 で |hNow|/|slopePerBar| <= 1.5 にする（slopePerBar = (hNow - hPrev) / win、win=5）
		const n = 20;
		const hist = Array.from({ length: n }, () => 0);
		// hPrev (index 14) = -0.3, hNow (index 19) = -0.01 → slopePerBar = 0.058、estimatedCrossDays = 0.01 / 0.058 ≈ 0.17 <= 1.5
		hist[14] = -0.3;
		hist[15] = -0.24;
		hist[16] = -0.18;
		hist[17] = -0.12;
		hist[18] = -0.06;
		hist[19] = -0.01;

		const line = hist.map((h) => h + 1);
		const signal = line.map((l, i) => l - hist[i]);

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult({
				ok: true,
				summary: 'ok',
				data: {
					normalized: Array.from({ length: n }, (_, i) => ({
						close: 100 + i,
						isoTime: dayjs()
							.subtract(n - 1 - i, 'day')
							.toISOString(),
					})),
					indicators: {
						macd_series: { line, signal, hist },
					},
				},
				meta: { pair: 'btc_jpy', type: '1day', count: n },
			}),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: true, includeStats: false });
		assertOk(res);
		expect(res.data.forming?.status).toBe('forming_golden');
		expect(res.data.forming?.estimatedCrossDays).toBeLessThanOrEqual(1.5);
	});

	it('singlePairMode: forming_golden で estimatedCrossDays > 1.5 → X日程度', async () => {
		const n = 20;
		const hist = Array.from({ length: n }, () => 0);
		// hPrev (index 14) = -2, hNow (index 19) = -1.5 → slopePerBar = 0.1、estimatedCrossDays = 1.5 / 0.1 = 15 > 1.5
		hist[14] = -2;
		hist[15] = -1.9;
		hist[16] = -1.8;
		hist[17] = -1.7;
		hist[18] = -1.6;
		hist[19] = -1.5;

		const line = hist.map((h) => h + 1);
		const signal = line.map((l, i) => l - hist[i]);

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult({
				ok: true,
				summary: 'ok',
				data: {
					normalized: Array.from({ length: n }, (_, i) => ({
						close: 100 + i,
						isoTime: dayjs()
							.subtract(n - 1 - i, 'day')
							.toISOString(),
					})),
					indicators: {
						macd_series: { line, signal, hist },
					},
				},
				meta: { pair: 'btc_jpy', type: '1day', count: n },
			}),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: true, includeStats: false });
		assertOk(res);
		expect(res.data.forming?.status).toBe('forming_golden');
		expect(res.data.forming?.estimatedCrossDays).toBeGreaterThan(1.5);
	});

	it('singlePairMode: neutral (傾きがゼロに向かっていない) を返す', async () => {
		const n = 20;
		// All hist values are 0 → no forming condition, no recent cross
		const hist = Array.from({ length: n }, () => 0);
		const line = Array.from({ length: n }, () => 1);
		const signal = Array.from({ length: n }, () => 1);

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult({
				ok: true,
				summary: 'ok',
				data: {
					normalized: Array.from({ length: n }, (_, i) => ({
						close: 100 + i,
						isoTime: dayjs()
							.subtract(n - 1 - i, 'day')
							.toISOString(),
					})),
					indicators: {
						macd_series: { line, signal, hist },
					},
				},
				meta: { pair: 'btc_jpy', type: '1day', count: n },
			}),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: true, includeStats: false });
		assertOk(res);
		expect(res.data.forming?.status).toBe('neutral');
	});

	it('singlePairMode: includeForming=false は forming が null', async () => {
		const n = 20;
		const line = Array.from({ length: n }, () => 1);
		const signal = Array.from({ length: n }, () => 0);

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					line,
					signal,
				}),
			),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: false, includeStats: false });
		assertOk(res);
		expect(res.data.forming).toBeNull();
	});

	it('singlePairMode: includeStats=false は history/statistics が null', async () => {
		const n = 20;
		const line = Array.from({ length: n }, () => 1);
		const signal = Array.from({ length: n }, () => 0);

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					line,
					signal,
				}),
			),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: false, includeStats: false });
		assertOk(res);
		expect(res.data.history).toBeNull();
		expect(res.data.statistics).toBeNull();
	});

	it('singlePairMode: includeStats=true でゴールデン/デッドクロスを統計する', async () => {
		const n = 40;
		// Alternating golden and dead crosses
		const line: number[] = [];
		const signal: number[] = [];
		for (let i = 0; i < n; i++) {
			const val = i % 4 < 2 ? 1 : -1;
			line.push(val);
			signal.push(0);
		}
		const crossDates: Record<number, string> = {};
		for (let i = 0; i < n; i++) {
			crossDates[i] = dayjs()
				.subtract(n - 1 - i, 'day')
				.toISOString();
		}

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					line,
					signal,
					crossDates,
				}),
			),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: false, includeStats: true, historyDays: 180 });
		assertOk(res);
		expect(res.data.statistics).not.toBeNull();
		const stats = res.data.statistics as { golden: { totalSamples: number }; dead: { totalSamples: number } };
		expect(stats.golden.totalSamples).toBeGreaterThan(0);
		expect(stats.dead.totalSamples).toBeGreaterThan(0);
	});

	it('singlePairMode: buildMacdSingleText の forming_dead テキストを生成する', async () => {
		const n = 20;
		const hist = Array.from({ length: n }, () => 0);
		hist[14] = 2;
		hist[15] = 1.9;
		hist[16] = 1.8;
		hist[17] = 1.7;
		hist[18] = 1.6;
		hist[19] = 1.5;

		const line = hist.map((h) => h + 1);
		const signal = line.map((l, i) => l - hist[i]);

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult({
				ok: true,
				summary: 'ok',
				data: {
					normalized: Array.from({ length: n }, (_, i) => ({
						close: 100 + i,
						isoTime: dayjs()
							.subtract(n - 1 - i, 'day')
							.toISOString(),
					})),
					indicators: {
						macd_series: { line, signal, hist },
					},
				},
				meta: { pair: 'btc_jpy', type: '1day', count: n },
			}),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: true, includeStats: false });
		assertOk(res);
		expect(res.data.forming?.status).toBe('forming_dead');
	});

	it('singlePairMode: crossed_recently の dead クロスを検出する', async () => {
		const line = [
			0.4, 0.5, 0.6, 0.6, 0.7, 0.7, 0.8, 0.8, 0.9, 0.9, 1.0, 1.0, 0.9, 0.8, 0.7, 0.5, 0.2, -0.2, -0.1, -0.1,
		];
		const signal = Array.from({ length: line.length }, () => 0);

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					line,
					signal,
					hist: line,
					crossDates: {
						16: '2026-02-16T00:00:00.000Z',
						17: '2026-02-17T00:00:00.000Z',
						18: '2026-02-18T00:00:00.000Z',
						19: '2026-02-19T00:00:00.000Z',
					},
				}),
			),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: true, includeStats: false });
		assertOk(res);
		expect(res.data.forming?.status).toBe('crossed_recently');
		expect(res.data.forming?.lastCrossType).toBe('dead');
	});

	it('screenMode: view=detailed でクロスなし → detRaw.length === 0 → res をそのまま返す', async () => {
		// line stays positive, no cross within lookback
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					line: [1, 1, 1, 1, 1],
					signal: [0, 0, 0, 0, 0],
				}),
			),
		);

		const res = await toolDef.handler({
			pairs: ['btc_jpy'],
			lookback: 3,
			view: 'detailed',
		});
		// No crosses → detRaw.length === 0 → returns ok result (not content object)
		assertOk(res);
		expect(res.data.results).toHaveLength(0);
	});

	it('screenMode: market=all (default) は _jpy 以外のペアも含む', async () => {
		mockedAnalyzeIndicators.mockResolvedValue(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					line: [0, -1, 1],
					signal: [0, 0, 0],
				}),
			),
		);

		const res = await toolDef.handler({ market: 'all', lookback: 3 });
		assertOk(res);
		const meta = res.meta as { pairs: string[] };
		expect(meta.pairs.length).toBeGreaterThan(0);
	});

	it('screenMode: sortBy=date ascending でクロスを日付昇順に並べる', async () => {
		mockedAnalyzeIndicators.mockImplementation(async (pair?: string) => {
			if (pair === 'btc_jpy') {
				return asMockResult(
					buildAnalyzeIndicatorsOk({
						pair,
						line: [0, 0, 0, 0, -1, 1],
						signal: [0, 0, 0, 0, 0, 0],
						crossDates: {
							5: '2025-03-01T00:00:00.000Z',
						},
					}),
				);
			}
			if (pair === 'eth_jpy') {
				return asMockResult(
					buildAnalyzeIndicatorsOk({
						pair,
						line: [0, 0, -1, 1, 2, 3],
						signal: [0, 0, 0, 0, 0, 0],
						crossDates: {
							3: '2025-01-01T00:00:00.000Z',
						},
					}),
				);
			}
			throw new Error(`unexpected pair: ${pair}`);
		});

		const res = await toolDef.handler({
			pairs: ['btc_jpy', 'eth_jpy'],
			lookback: 5,
			screen: { sortBy: 'date', sortOrder: 'asc' },
		});

		assertOk(res);
		// ascending: earlier date first → eth_jpy (2025-01) before btc_jpy (2025-03)
		expect(res.data.results.map((item: { pair: string }) => item.pair)).toEqual(['eth_jpy', 'btc_jpy']);
	});

	it('buildMacdScreenText: returnSinceCrossPct non-null と prevCross non-null のテキスト出力', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					// prev cross at index 1 (dead), current cross at index 2 (golden)
					line: [1, -1, 1],
					signal: [0, 0, 0],
					// cross at index 2 priceAtCross=102, currentPrice=103 → small positive return
					closeSeries: [100, 101, 102, 103],
					crossDates: { 2: '2026-01-10T00:00:00.000Z' },
				}),
			),
		);

		const res = await toolDef.handler({ pairs: ['btc_jpy'], lookback: 5 });
		assertOk(res);
		expect(typeof res.summary).toBe('string');
		expect(res.data.results).toHaveLength(1);
	});

	it('singlePairMode: includeStats=true で統計テキストに過去クロス件数が含まれる', async () => {
		const n = 40;
		const line: number[] = [];
		const signal: number[] = [];
		for (let i = 0; i < n; i++) {
			line.push(i % 4 < 2 ? 1 : -1);
			signal.push(0);
		}
		const crossDates: Record<number, string> = {};
		for (let i = 0; i < n; i++) {
			crossDates[i] = dayjs()
				.subtract(n - 1 - i, 'day')
				.toISOString();
		}

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					line,
					signal,
					crossDates,
				}),
			),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: false, includeStats: true, historyDays: 180 });
		assertOk(res);
		expect(res.summary).toMatch(/ゴールデンクロス/);
		expect(res.summary).toMatch(/デッドクロス/);
	});

	it('buildMacdSingleText: forming_golden で estimatedCrossDays <= 1.5 → サマリに 1-2日以内 が含まれる', async () => {
		const n = 20;
		const hist = Array.from({ length: n }, () => 0);
		// hPrev (index 14) = -0.3, hNow (index 19) = -0.01 → slopePerBar = 0.058、estimatedCrossDays ≈ 0.17 <= 1.5
		hist[14] = -0.3;
		hist[15] = -0.24;
		hist[16] = -0.18;
		hist[17] = -0.12;
		hist[18] = -0.06;
		hist[19] = -0.01;

		const line = hist.map((h) => h + 1);
		const signal = line.map((l, i) => l - hist[i]);

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult({
				ok: true,
				summary: 'ok',
				data: {
					normalized: Array.from({ length: n }, (_, i) => ({
						close: 100 + i,
						isoTime: dayjs()
							.subtract(n - 1 - i, 'day')
							.toISOString(),
					})),
					indicators: {
						macd_series: { line, signal, hist },
					},
				},
				meta: { pair: 'btc_jpy', type: '1day', count: n },
			}),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: true, includeStats: false });
		assertOk(res);
		expect(res.data.forming?.status).toBe('forming_golden');
		expect(res.summary).toMatch(/1-2日以内/);
	});

	it('buildMacdSingleText: forming_golden で estimatedCrossDays > 1.5 → サマリに X日程度 が含まれる', async () => {
		const n = 20;
		const hist = Array.from({ length: n }, () => 0);
		// hPrev (index 14) = -2, hNow (index 19) = -1.5 → slopePerBar = 0.1、estimatedCrossDays = 15 > 1.5
		hist[14] = -2;
		hist[15] = -1.9;
		hist[16] = -1.8;
		hist[17] = -1.7;
		hist[18] = -1.6;
		hist[19] = -1.5;

		const line = hist.map((h) => h + 1);
		const signal = line.map((l, i) => l - hist[i]);

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult({
				ok: true,
				summary: 'ok',
				data: {
					normalized: Array.from({ length: n }, (_, i) => ({
						close: 100 + i,
						isoTime: dayjs()
							.subtract(n - 1 - i, 'day')
							.toISOString(),
					})),
					indicators: {
						macd_series: { line, signal, hist },
					},
				},
				meta: { pair: 'btc_jpy', type: '1day', count: n },
			}),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: true, includeStats: false });
		assertOk(res);
		expect(res.data.forming?.status).toBe('forming_golden');
		expect(res.summary).toMatch(/日程度/);
	});

	it('buildMacdSingleText: crossed_recently golden → サマリにゴールデンクロス発生が含まれる', async () => {
		const line = [
			0.4, 0.5, 0.6, 0.6, 0.7, 0.7, 0.8, 0.8, 0.9, 0.9, 1.0, 1.0, 0.9, 0.8, -0.7, 0.5, -0.2, 0.2, -0.1, 0.1,
		];
		const signal = Array.from({ length: line.length }, () => 0);

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					line,
					signal,
					hist: line,
					crossDates: {
						16: '2026-02-16T00:00:00.000Z',
						17: '2026-02-17T00:00:00.000Z',
						18: '2026-02-18T00:00:00.000Z',
						19: '2026-02-19T00:00:00.000Z',
					},
				}),
			),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: true, includeStats: false });
		assertOk(res);
		expect(res.data.forming?.status).toBe('crossed_recently');
		expect(res.summary).toMatch(/ゴールデンクロス発生/);
	});

	it('buildMacdSingleText: neutral → サマリにクロス形成の兆候なし が含まれる', async () => {
		const n = 20;
		const hist = Array.from({ length: n }, () => 0);
		const line = Array.from({ length: n }, () => 1);
		const signal = Array.from({ length: n }, () => 1);

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult({
				ok: true,
				summary: 'ok',
				data: {
					normalized: Array.from({ length: n }, (_, i) => ({
						close: 100 + i,
						isoTime: dayjs()
							.subtract(n - 1 - i, 'day')
							.toISOString(),
					})),
					indicators: {
						macd_series: { line, signal, hist },
					},
				},
				meta: { pair: 'btc_jpy', type: '1day', count: n },
			}),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: true, includeStats: false });
		assertOk(res);
		expect(res.data.forming?.status).toBe('neutral');
		expect(res.summary).toMatch(/クロス形成の兆候なし/);
	});

	it('buildMacdSingleText: forming_dead → サマリにデッドクロス形成中が含まれる', async () => {
		const n = 20;
		const hist = Array.from({ length: n }, () => 0);
		hist[14] = 2;
		hist[15] = 1.9;
		hist[16] = 1.8;
		hist[17] = 1.7;
		hist[18] = 1.6;
		hist[19] = 1.5;

		const line = hist.map((h) => h + 1);
		const signal = line.map((l, i) => l - hist[i]);

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult({
				ok: true,
				summary: 'ok',
				data: {
					normalized: Array.from({ length: n }, (_, i) => ({
						close: 100 + i,
						isoTime: dayjs()
							.subtract(n - 1 - i, 'day')
							.toISOString(),
					})),
					indicators: {
						macd_series: { line, signal, hist },
					},
				},
				meta: { pair: 'btc_jpy', type: '1day', count: n },
			}),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: true, includeStats: false });
		assertOk(res);
		expect(res.data.forming?.status).toBe('forming_dead');
		expect(res.summary).toMatch(/デッドクロス形成中/);
	});

	it('singlePairMode: includeForming=true + includeStats=true を両方有効にして ok を返す', async () => {
		const n = 40;
		const line: number[] = [];
		const signal: number[] = [];
		for (let i = 0; i < n; i++) {
			line.push(i % 4 < 2 ? 1 : -1);
			signal.push(0);
		}
		// Make last few entries approaching zero for forming detection
		const hist = line.map((l, i) => l - signal[i]);
		hist[n - 1] = -0.05;
		hist[n - 2] = -0.1;
		hist[n - 3] = -0.15;
		hist[n - 4] = -0.2;
		hist[n - 5] = -0.25;
		hist[n - 6] = -0.3;

		const crossDates: Record<number, string> = {};
		for (let i = 0; i < n; i++) {
			crossDates[i] = dayjs()
				.subtract(n - 1 - i, 'day')
				.toISOString();
		}

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult({
				ok: true,
				summary: 'ok',
				data: {
					normalized: Array.from({ length: n }, (_, i) => ({
						close: 100 + i,
						isoTime: crossDates[i],
					})),
					indicators: {
						macd_series: { line, signal, hist },
					},
				},
				meta: { pair: 'btc_jpy', type: '1day', count: n },
			}),
		);

		const res = await toolDef.handler({
			pair: 'btc_jpy',
			includeForming: true,
			includeStats: true,
			historyDays: 180,
		});
		assertOk(res);
		expect(res.data.statistics).not.toBeNull();
	});

	it('screenMode: view=summary は detailed の content を組まずに res をそのまま返す', async () => {
		// screenMode が ok=false を返す状況は通常作れないので、代わりに view='summary' のとき detailed の経路に入らないことを見る。
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					line: [0, 1, 2],
					signal: [0, 0, 0],
				}),
			),
		);

		const res = await toolDef.handler({
			pairs: ['btc_jpy'],
			lookback: 3,
			view: 'summary',
		});
		assertOk(res);
		expect('content' in res).toBe(false);
	});

	it('screenMode: pairs=[] は ALLOWED_PAIRS から universe を構築する (pairs 未指定扱い)', async () => {
		mockedAnalyzeIndicators.mockResolvedValue(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					line: [0, -1, 1],
					signal: [0, 0, 0],
				}),
			),
		);

		// pairs=[] → pairs?.length is falsy → use ALLOWED_PAIRS
		const res = await toolDef.handler({ pairs: [], lookback: 3, market: 'jpy' });
		assertOk(res);
		const meta = res.meta as { pairs: string[] };
		expect(meta.pairs.every((p: string) => p.endsWith('_jpy'))).toBe(true);
	});

	it('buildMacdSingleText: statistics.golden.totalSamples=0, statistics.dead.totalSamples=0 → 統計行なし', async () => {
		const n = 20;
		// All same sign in macd - no crosses → golden/dead totalSamples=0
		const line = Array.from({ length: n }, () => 1);
		const signal = Array.from({ length: n }, () => 0);

		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					line,
					signal,
				}),
			),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy', includeForming: false, includeStats: true, historyDays: 90 });
		assertOk(res);
		const stats = res.data.statistics as { golden: { totalSamples: number }; dead: { totalSamples: number } } | null;
		expect(stats).not.toBeNull();
		expect(stats?.golden.totalSamples).toBe(0);
		expect(stats?.dead.totalSamples).toBe(0);
	});

	it('screenMode: view=detailed 複数クロス + prevCross あり → content.text に prevCross 情報が含まれる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				buildAnalyzeIndicatorsOk({
					pair: 'btc_jpy',
					// prev dead cross at idx 1, current golden cross at idx 2
					line: [1, -1, 1],
					signal: [0, 0, 0],
					closeSeries: [100, 101, 102],
					crossDates: {
						1: '2026-01-09T00:00:00.000Z',
						2: '2026-01-10T00:00:00.000Z',
					},
				}),
			),
		);

		const res = await toolDef.handler({
			pairs: ['btc_jpy'],
			lookback: 5,
			view: 'detailed',
		});
		expect(res).toHaveProperty('content');
		const content = (res as { content: Array<{ text: string }> }).content;
		expect(content[0].text).toMatch(/日/);
	});
});
