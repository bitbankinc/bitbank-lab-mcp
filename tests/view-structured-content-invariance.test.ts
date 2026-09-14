/**
 * `view` は `content` だけを変え、`structuredContent` の中身を変えない — の横断テスト。
 *
 * 根拠: docs/internal/view-vocabulary-unification.md §3-2 規約 4
 *   「view は structuredContent からフィールドを削ってはならない。
 *     一方、階梯外の view がその view でしか計算しないデータを *足す* のは許容する」
 *
 * なぜ削ってはいけないか（同 §2-0）: LLM は structuredContent を参照しない
 * （.claude/rules/tools.md）。削ってもトークンは 1 つも減らず、宣言スキーマを満たさない
 * 応答が非 LLM クライアントに渡るだけになる。
 *
 * 時刻の固定: meta.fetchedAt / meta.serverTime は呼び出しごとの実時刻なので、
 * Date だけを固定して view 間の deep-equal が壊れないようにする（timer は実物のまま）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// detect_macd_cross（スクリーニングモード）と detect_patterns は上流ツールをモックする。
// この 2 つは「例外の明示」テストでのみ使う。
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

// ── helpers ───────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * ハンドラ応答から、MCP クライアントが受け取る structuredContent を取り出す。
 * src/server.ts の respond() と同じ規則:
 *   `{ content, structuredContent }` を返していれば内側の structuredContent、
 *   生の Result を返していれば Result 自体が structuredContent になる。
 */
function structuredOf(res: unknown): Record<string, unknown> {
	if (!isPlainObject(res)) throw new Error('handler がオブジェクトを返していない');
	return isPlainObject(res.structuredContent) ? res.structuredContent : res;
}

/** 各 view を同一入力で実行し、view → structuredContent の対応を返す。 */
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

/** 先頭 view を基準に、全 view の structuredContent が deep-equal であることを検証する。 */
function expectSameStructuredContent(entries: Array<[string, Record<string, unknown>]>): void {
	const [baseView, baseline] = entries[0];
	for (const [view, actual] of entries.slice(1)) {
		expect(actual, `view=${view} の structuredContent が view=${baseView} と異なる`).toEqual(baseline);
	}
}

/**
 * `actual` が `expected` の上位集合であることを検証する（削る・書き換えるのは禁止、足すのは許容）。
 * 配列・スカラーは値として deep-equal を要求し、プレーンオブジェクトのみ再帰的に緩める。
 */
function expectSuperset(actual: unknown, expected: unknown, path = 'structuredContent'): void {
	if (isPlainObject(expected)) {
		expect(isPlainObject(actual), `${path} がオブジェクトでなくなっている`).toBe(true);
		const target = actual as Record<string, unknown>;
		for (const [key, value] of Object.entries(expected)) {
			expect(Object.hasOwn(target, key), `${path}.${key} が view で消えている（削るのは禁止）`).toBe(true);
			expectSuperset(target[key], value, `${path}.${key}`);
		}
		return;
	}
	expect(actual, `${path} の値が view で書き換わっている`).toEqual(expected);
}

/** `actual` が `expected` に対して追加しているキーのパス一覧（浅い順に列挙）。 */
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

// ── fixtures ──────────────────────────────────────────────

/** 約定 3 件（0 / 1 / 2 分）。get_flow_metrics / get_transactions 用。 */
const TX_ROWS = [
	{ price: '5000000', amount: '0.1', side: 'buy', executed_at: '1700000000000' },
	{ price: '5000100', amount: '0.2', side: 'sell', executed_at: '1700000060000' },
	{ price: '5000200', amount: '0.3', side: 'buy', executed_at: '1700000120000' },
];

/** OHLCV 行: [open, high, low, close, volume, timestampMs] */
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

// ── tests ─────────────────────────────────────────────────

describe('view は structuredContent を変えない（§3-2 規約 4）', () => {
	beforeEach(() => {
		// Date のみ固定する。setTimeout 等は実物のままにして fetch のリトライ待ちを壊さない。
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(dayjs.utc('2026-03-01T00:00:00Z').valueOf());
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('get_flow_metrics: summary / compact / buckets / full で同一', async () => {
		const entries = await collectByView(['summary', 'compact', 'buckets', 'full'] as const, async (view) => {
			mockTransactions();
			return flowMetricsTool.handler({ pair: 'btc_jpy', limit: 3, date: '20240101', bucketMs: 60_000, view });
		});
		expectSameStructuredContent(entries);
		// 回帰の本体: 旧実装は summary で series.buckets をキーごと削除していた。
		for (const [view, structured] of entries) {
			const series = (structured.data as { series: { buckets: unknown[] } }).series;
			expect(Array.isArray(series.buckets), `view=${view} に series.buckets が無い`).toBe(true);
			expect(series.buckets, `view=${view} のバケットが絞り込まれている`).toHaveLength(3);
		}
	});

	it('get_transactions: summary / items で同一', async () => {
		const entries = await collectByView(['summary', 'items'] as const, async (view) => {
			mockTransactions();
			return transactionsTool.handler({ pair: 'btc_jpy', limit: 3, date: '20240101', view });
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

	/**
	 * get_candles は PR 1 時点で唯一の逸脱だった——`view=items` が structuredContent を
	 * `{ items, meta }` に差し替え、Result 封筒（ok / summary / data.{raw,keyPoints,volumeStats}）を
	 * 落としていた。`items` を `view=full` + `format=json` へ置き換える PR 3 で同時に直したので
	 * （破壊を 1 回に集約するため。§5-0 分割の原則 2）、他ツールと同じ deep-equal で検証する。
	 *
	 * `format` は content の**形式**を選ぶパラメータであって structuredContent の契約を
	 * 変えるパラメータではない（§3-2 規約 4 は view についての規約だが、根拠——LLM は
	 * structuredContent を参照しないので削ってもトークンは減らない——は format にもそのまま当たる）。
	 * したがって view × format の全組み合わせで同一であることを要求する。
	 */
	it('get_candles: view × format（deprecated alias の items を含む）で同一', async () => {
		const variants = {
			'full/text': { view: 'full', format: 'text' },
			'full/json': { view: 'full', format: 'json' },
			'items(alias)': { view: 'items' },
			// alias は format 指定より優先される（get_candles の effectiveFormat）。
			// content の形は変わるが structuredContent は同一、が本テストの主張。
			'items(alias)/text': { view: 'items', format: 'text' },
			'items(alias)/json': { view: 'items', format: 'json' },
		} as const;
		const entries = await collectByView(Object.keys(variants) as Array<keyof typeof variants>, async (label) => {
			mockCandles(10);
			return candlesTool.handler({ pair: 'btc_jpy', type: '1day', date: '2025', limit: 10, ...variants[label] });
		});
		expectSameStructuredContent(entries);

		// 回帰の本体: 旧 items は封筒ごと差し替わり `{ items, meta }` になっていた。
		for (const [label, structured] of entries) {
			expect(Object.keys(structured).sort(), `${label} の structuredContent が Result 封筒でない`).toEqual([
				'data',
				'meta',
				'ok',
				'summary',
			]);
			// 旧 structuredContent.items の読み替え先
			expect(Array.isArray((structured.data as { normalized: unknown }).normalized)).toBe(true);
		}
	});

	// ── 明示された例外: 階梯外 view が「足す」のは許容（§3-2 規約 4） ──

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
				// #184 で出力スキーマに宣言した実効パラメータ。**view で削られないこと**が規約 2 の対象で、
				// 宣言前は parse で strip されて structuredContent に一度も現れていなかった（欠陥 D）。
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

		// 階梯上の view（summary / full）は完全一致
		expect(byView.get('full')).toEqual(baseline);

		// detailed は usage_example を足すだけ
		expectSuperset(byView.get('detailed'), baseline);
		expect(addedPaths(byView.get('detailed'), baseline)).toEqual(['usage_example']);

		// debug（階梯外）は data.candidates を足すだけ
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

		// meta.view は要求パラメータのエコーなので view ごとに変わる。
		// データを削っても書き換えてもいないため、比較対象からは除外する。
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
