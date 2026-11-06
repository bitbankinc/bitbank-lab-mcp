// LLM は structuredContent を参照しないので、view で structuredContent のフィールドを削ってもトークンは減らず、宣言スキーマを満たさない応答が非 LLM クライアントに渡るだけになる（docs/internal/view-vocabulary-unification.md §3-2 規約 4）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// detect_macd_cross（スクリーニングモード）と detect_patterns は「例外の明示」テストでのみ使うので、上流ツールをモックする。
vi.mock('../tools/analyze_indicators.js', () => ({ default: vi.fn() }));
vi.mock('../tools/detect_patterns.js', () => ({ default: vi.fn() }));

import { dayjs } from '../lib/datetime.js';
import { toolDef as detectPatternsTool } from '../src/handlers/detectPatternsHandler.js';
import { toolDef as volatilityTool } from '../src/handlers/getVolatilityMetricsHandler.js';
import analyzeIndicators from '../tools/analyze_indicators.js';
import { toolDef as macdCrossTool } from '../tools/detect_macd_cross.js';
import detectPatterns from '../tools/detect_patterns.js';
import { toolDef as candlesTool } from '../tools/get_candles.js';
import { toolDef as flowMetricsTool } from '../tools/get_flow_metrics.js';
import { toolDef as transactionsTool } from '../tools/get_transactions.js';
import { asMockResult } from './_assertResult.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** src/server.ts の respond() と同じ規則で、`{ content, structuredContent }` を返していれば内側の structuredContent、生の Result を返していれば Result 自体が structuredContent になる。 */
function structuredOf(res: unknown): Record<string, unknown> {
	if (!isPlainObject(res)) throw new Error('handler がオブジェクトを返していない');
	return isPlainObject(res.structuredContent) ? res.structuredContent : res;
}

async function collectByView<V extends string>(
	views: readonly V[],
	run: (view: V) => Promise<unknown>,
): Promise<Array<[V, Record<string, unknown>]>> {
	const out: Array<[V, Record<string, unknown>]> = [];
	for (const view of views) {
		out.push([view, structuredOf(await run(view))]);
	}
	return out;
}

function expectSameStructuredContent(entries: Array<[string, Record<string, unknown>]>): void {
	const [baseView, baseline] = entries[0];
	for (const [view, actual] of entries.slice(1)) {
		expect(actual, `view=${view} の structuredContent が view=${baseView} と異なる`).toEqual(baseline);
	}
}

type SupersetLeaf = { actual: unknown; expected: unknown; path: string };

// 構造の欠落は missing に、値として比べる葉は leaves に集め、expect は expectSuperset で 1 か所にまとめて呼ぶ。
function collectSuperset(
	actual: unknown,
	expected: unknown,
	path: string,
	missing: string[],
	leaves: SupersetLeaf[],
): void {
	if (!isPlainObject(expected)) {
		leaves.push({ actual, expected, path });
		return;
	}
	if (!isPlainObject(actual)) {
		missing.push(`${path} がオブジェクトでなくなっている`);
		return;
	}
	for (const [key, value] of Object.entries(expected)) {
		if (!Object.hasOwn(actual, key)) {
			missing.push(`${path}.${key} が view で消えている（削るのは禁止）`);
			continue;
		}
		collectSuperset(actual[key], value, `${path}.${key}`, missing, leaves);
	}
}

/** 配列・スカラーは値として deep-equal を要求し、プレーンオブジェクトのみ再帰的に緩める（削る・書き換えるのは禁止、足すのは許容）。 */
function expectSuperset(actual: unknown, expected: unknown, path = 'structuredContent'): void {
	const missing: string[] = [];
	const leaves: SupersetLeaf[] = [];
	collectSuperset(actual, expected, path, missing, leaves);
	expect(missing, missing.join('\n')).toEqual([]);
	for (const leaf of leaves) {
		expect(leaf.actual, `${leaf.path} の値が view で書き換わっている`).toEqual(leaf.expected);
	}
}

function addedPaths(actual: unknown, expected: unknown, path = ''): string[] {
	if (!isPlainObject(actual) || !isPlainObject(expected)) return [];
	const found: string[] = [];
	for (const key of Object.keys(actual)) {
		const childPath = path ? `${path}.${key}` : key;
		if (!Object.hasOwn(expected, key)) {
			found.push(childPath);
			continue;
		}
		found.push(...addedPaths(actual[key], expected[key], childPath));
	}
	return found.sort();
}

const TX_ROWS = [
	{ price: '5000000', amount: '0.1', side: 'buy', executed_at: '1700000000000' },
	{ price: '5000100', amount: '0.2', side: 'sell', executed_at: '1700000060000' },
	{ price: '5000200', amount: '0.3', side: 'buy', executed_at: '1700000120000' },
];

function ohlcvRows(count: number): string[][] {
	const startMs = Date.UTC(2025, 0, 1);
	const rows: string[][] = [];
	let prev = 10_000_000;
	for (let i = 0; i < count; i++) {
		const close = prev * (1 + Math.sin(i * 0.5) * 0.02);
		rows.push([
			String(prev),
			String(close * 1.01),
			String(close * 0.99),
			String(close),
			String(100 + i),
			String(startMs + i * 86_400_000),
		]);
		prev = close;
	}
	return rows;
}

function mockFetchJson(payload: unknown) {
	vi.spyOn(globalThis, 'fetch').mockResolvedValue({
		ok: true,
		status: 200,
		statusText: 'OK',
		json: async () => payload,
	} as unknown as Response);
}

const mockTransactions = () => mockFetchJson({ success: 1, data: { transactions: TX_ROWS } });
const mockCandles = (count: number) =>
	mockFetchJson({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: ohlcvRows(count) }] } });

describe('view は structuredContent を変えない（§3-2 規約 4）', () => {
	beforeEach(() => {
		// meta.fetchedAt / meta.serverTime は呼び出しごとの実時刻なので Date だけ固定する（setTimeout 等は実物のままにして fetch のリトライ待ちを壊さない）。
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(dayjs.utc('2026-03-01T00:00:00Z').valueOf());
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('get_flow_metrics: summary / detailed / full で同一', async () => {
		// bucketsN をバケット数（3）より小さくしないと、detailed が本文を絞る経路を通らない。
		const entries = await collectByView(['summary', 'detailed', 'full'] as const, async (view) => {
			mockTransactions();
			return flowMetricsTool.handler({
				pair: 'btc_jpy',
				limit: 3,
				date: '20240101',
				bucketMs: 60_000,
				bucketsN: 2,
				view,
			});
		});
		expectSameStructuredContent(entries);
		for (const [view, structured] of entries) {
			const series = (structured.data as { series: { buckets: unknown[] } }).series;
			expect(Array.isArray(series.buckets), `view=${view} に series.buckets が無い`).toBe(true);
			expect(series.buckets, `view=${view} のバケットが絞り込まれている`).toHaveLength(3);
		}
	});

	it('get_transactions: format=text / json で同一', async () => {
		const entries = await collectByView(['text', 'json'] as const, async (format) => {
			mockTransactions();
			return transactionsTool.handler({ pair: 'btc_jpy', limit: 3, date: '20240101', format });
		});
		expectSameStructuredContent(entries);
	});

	it('get_volatility_metrics: summary / detailed / full / beginner で同一', async () => {
		const entries = await collectByView(['summary', 'detailed', 'full', 'beginner'] as const, async (view) => {
			mockCandles(60);
			return volatilityTool.handler({
				pair: 'btc_jpy',
				type: '1day',
				limit: 50,
				windows: [14, 20, 30],
				useLogReturns: true,
				annualize: true,
				tz: 'Asia/Tokyo',
				cacheTtlMs: 60_000,
				view,
			});
		});
		expectSameStructuredContent(entries);
	});

	/** `format` は content の形式を選ぶパラメータで structuredContent の契約を変えない（規約 4 の根拠は format にもそのまま当たる）ので、view × format の全組み合わせで同一であることを要求する。 */
	it('get_candles: view × format で同一', async () => {
		const variants = {
			'full/text': { view: 'full', format: 'text' },
			'full/json': { view: 'full', format: 'json' },
		} as const;
		const entries = await collectByView(Object.keys(variants) as Array<keyof typeof variants>, async (label) => {
			mockCandles(10);
			return candlesTool.handler({ pair: 'btc_jpy', type: '1day', date: '2025', limit: 10, ...variants[label] });
		});
		expectSameStructuredContent(entries);

		for (const [label, structured] of entries) {
			expect(Object.keys(structured).sort(), `${label} の structuredContent が Result 封筒でない`).toEqual([
				'data',
				'meta',
				'ok',
				'summary',
			]);
			expect(Array.isArray((structured.data as { normalized: unknown }).normalized)).toBe(true);
		}
	});

	it('detect_patterns: detailed / debug は足すだけ（summary / full とは同一）', async () => {
		const base = {
			ok: true,
			summary: 'ok',
			data: {
				patterns: [
					{
						type: 'double_top',
						confidence: 0.8,
						timeframe: '1day',
						timeframeLabel: '日足',
						range: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-20T00:00:00.000Z' },
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
				// 実効パラメータ（#184）も view で削られないことが規約 2 の対象。
				effective_params: {
					swingDepth: { value: 6, source: 'auto' },
					minBarsBetweenSwings: { value: 4, source: 'auto' },
					tolerancePct: { value: 0.04, source: 'auto' },
					headProminencePct: { value: 0.04, source: 'auto' },
				},
				visualization_hints: { preferred_style: 'line', highlight_patterns: [] },
				debug: {
					swings: [{ kind: 'H', idx: 3, price: 100, isoTime: '2026-01-05T00:00:00.000Z' }],
					candidates: [{ type: 'double_top', accepted: true, indices: [0, 3, 6] }],
				},
			},
		};
		const entries = await collectByView(['summary', 'detailed', 'full', 'debug'] as const, async (view) => {
			vi.mocked(detectPatterns).mockResolvedValue(asMockResult(structuredClone(base)));
			return detectPatternsTool.handler({ pair: 'btc_jpy', type: '1day', limit: 20, view });
		});
		const byView = new Map(entries);
		const baseline = byView.get('summary') as Record<string, unknown>;

		expect(byView.get('full')).toEqual(baseline);

		expectSuperset(byView.get('detailed'), baseline);
		expect(addedPaths(byView.get('detailed'), baseline)).toEqual(['usage_example']);

		expectSuperset(byView.get('debug'), baseline);
		expect(addedPaths(byView.get('debug'), baseline)).toEqual(['data.candidates']);
	});

	it('detect_macd_cross: detailed は resultsDetailed / screenedDetailed を足すだけ', async () => {
		const entries = await collectByView(['summary', 'detailed'] as const, async (view) => {
			vi.mocked(analyzeIndicators).mockResolvedValue(
				asMockResult({
					ok: true,
					summary: 'ok',
					data: {
						normalized: [-1, 1, 2].map((_, i) => ({
							close: 100 + i,
							isoTime: dayjs.utc('2026-02-16T00:00:00Z').add(i, 'day').toISOString(),
						})),
						indicators: { macd_series: { line: [-1, 1, 2], signal: [0, 0, 0], hist: [-1, 1, 2] } },
					},
					meta: { pair: 'btc_jpy', type: '1day', count: 3 },
				}),
			);
			return macdCrossTool.handler({ pairs: ['btc_jpy'], lookback: 3, view });
		});
		const byView = new Map(entries);
		const baseline = byView.get('summary') as Record<string, unknown>;
		const detailed = byView.get('detailed') as Record<string, unknown>;

		// meta.view は要求パラメータのエコーなので view ごとに変わるが、データを削っても書き換えてもいないので比較対象から除外する。
		expect((baseline.meta as { view: string }).view).toBe('summary');
		expect((detailed.meta as { view: string }).view).toBe('detailed');
		const stripView = (structured: Record<string, unknown>) => {
			const { view: _view, ...meta } = structured.meta as Record<string, unknown>;
			return { ...structured, meta };
		};

		expectSuperset(stripView(detailed), stripView(baseline));
		expect(addedPaths(stripView(detailed), stripView(baseline))).toEqual([
			'data.resultsDetailed',
			'data.screenedDetailed',
		]);
	});
});
