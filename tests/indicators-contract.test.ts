import { afterEach, describe, expect, it, vi } from 'vitest';
import { toolDef } from '../src/handlers/analyzeIndicatorsHandler.js';
import { IndicatorsInternalSchema } from '../src/schema/indicators.js';
import { clearIndicatorCache, computeAllIndicators } from '../tools/analyze_indicators.js';
import getCandles from '../tools/get_candles.js';
import { assertFail, assertOk } from './_assertResult.js';

// handler テストの mock が本番の返さない形状を手で注入すると、テストが緑のまま本番だけ壊れる。本番出力を schema に直接通す契約（A）と、fetch だけをモックしてパイプラインを素通しする契約（B）でそれを機械検出する。

type OhlcvRow = [string, string, string, string, string, string];

function makeOhlcvRows(count: number): OhlcvRow[] {
	const startMs = Date.UTC(2024, 0, 1);
	const rows: OhlcvRow[] = [];
	for (let i = 0; i < count; i++) {
		const base = 10_000_000 + i * 1_000;
		rows.push([
			String(base),
			String(base + 2_000),
			String(base - 2_000),
			String(base + 500),
			'1.5',
			String(startMs + i * 86_400_000),
		]);
	}
	return rows;
}

function mockFetchRows(rows: OhlcvRow[]) {
	vi.spyOn(globalThis, 'fetch').mockResolvedValue({
		ok: true,
		status: 200,
		statusText: 'OK',
		json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
	} as Response);
}

/** normalized を手組みせず本物の get_candles 経由で得て、本番が実際に渡す形状そのものを契約対象にする。 */
async function realIndicators(barCount = 250) {
	mockFetchRows(makeOhlcvRows(barCount));
	const candles = await getCandles('btc_jpy', '1day', undefined, barCount);
	assertOk(candles);
	expect(candles.data.normalized.length).toBeGreaterThanOrEqual(52);
	return computeAllIndicators(candles.data.normalized);
}

describe('indicators schema contract: computeAllIndicators ↔ IndicatorsInternalSchema', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		clearIndicatorCache();
	});

	it('本番出力に schema 未定義キー（未知キー混入）が無い（strict parse が通る）', async () => {
		const indicators = await realIndicators();
		// strict() は schema に存在しないキーがあると throw するので、computeAllIndicators が schema 未定義キーを生やす / schema 側がキーをリネームすると即赤になる。
		expect(() => IndicatorsInternalSchema.strict().parse(indicators)).not.toThrow();
	});

	it('本番出力の各キーが schema の受理する型で出る（IndicatorsInternalSchema.parse が通る）', async () => {
		const indicators = await realIndicators();
		// 既定 parse は未知キーを strip するが、既知キーの型不一致・nested 必須キー欠落は検出する。
		expect(() => IndicatorsInternalSchema.parse(indicators)).not.toThrow();
	});

	// zod は既定で未知キーを strip するので、handler が読むキーパスが本番出力に実在するかを明示 assert する（リネームすると undefined になり赤になる）。
	it('handler が読むキーパスが本番出力に実在する（旧 series.* 参照の再発防止）', async () => {
		const ind = await realIndicators();

		expect(Array.isArray(ind.macd_series?.line)).toBe(true);
		expect(Array.isArray(ind.macd_series?.signal)).toBe(true);
		expect(Array.isArray(ind.macd_series?.hist)).toBe(true);
		expect(Array.isArray(ind.sma_25_series)).toBe(true);
		expect(Array.isArray(ind.sma_75_series)).toBe(true);
		expect(Array.isArray(ind.sma_200_series)).toBe(true);
		expect(Array.isArray(ind.bb2_series?.upper)).toBe(true);
		expect(Array.isArray(ind.bb2_series?.middle)).toBe(true);
		expect(Array.isArray(ind.bb2_series?.lower)).toBe(true);
		expect(Array.isArray(ind.ichi_series?.tenkan)).toBe(true);
		expect(Array.isArray(ind.ichi_series?.kijun)).toBe(true);
		expect(Array.isArray(ind.ichi_series?.spanA)).toBe(true);
		expect(Array.isArray(ind.ichi_series?.spanB)).toBe(true);

		// 本番は flat 構造で `series` ラッパを持たない。
		expect((ind as Record<string, unknown>).series).toBeUndefined();
	});

	// 上のテストは本番側のリネームで赤になるが、ここでは契約（schema）がリネームを検出する仕組み自体を、本番出力を改変して直接証明する。
	it('回帰: 指標キーをリネームすると契約違反として検出される（契約破壊の検出証明）', async () => {
		const ind = await realIndicators();
		// 正規の本番出力は契約を満たす（前提条件）。
		expect(() => IndicatorsInternalSchema.strict().parse(ind)).not.toThrow();

		// (1) top-level の series キーをリネーム → strict parse が「未知キー」として検出。
		const renamedTop = { ...ind, macd_series_RENAMED: ind.macd_series } as Record<string, unknown>;
		delete renamedTop.macd_series;
		expect(() => IndicatorsInternalSchema.strict().parse(renamedTop)).toThrow();

		// (2) nested の必須キー（macd_series.line）をリネーム → parse が「必須キー欠落」として検出。
		const renamedNested = {
			...ind,
			macd_series: {
				line_RENAMED: ind.macd_series?.line,
				signal: ind.macd_series?.signal,
				hist: ind.macd_series?.hist,
			},
		} as Record<string, unknown>;
		expect(() => IndicatorsInternalSchema.parse(renamedNested)).toThrow();
	});
});

// 新規ハンドラのテストはこの型を踏襲する。vi.mock で analyzeIndicators を差し替えず、globalThis.fetch だけをモックして get_candles → analyzeIndicators → handler を素通しする。

describe('実パイプライン契約（テンプレ）: fetch → get_candles → analyzeIndicators → handler', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		clearIndicatorCache();
	});

	/** 下降 → 急落 → 直近の急反発。MACD line が signal を直近で明確に上抜けるデータ。 */
	function makeReversalRows(): OhlcvRow[] {
		const startMs = Date.UTC(2025, 0, 1);
		const rows: OhlcvRow[] = [];
		for (let i = 0; i < 200; i++) {
			const base =
				i < 140
					? 30_000_000 - i * 100_000
					: i < 175
						? 16_000_000 - (i - 140) * 200_000
						: 9_000_000 + (i - 175) * 350_000;
			rows.push([
				String(base),
				String(base + 50_000),
				String(base - 50_000),
				String(base),
				'1.5',
				String(startMs + i * 86_400_000),
			]);
		}
		return rows;
	}

	it('handler は本番の flat series からシグナルを算出し、構造化出力は schema 契約を満たす', async () => {
		mockFetchRows(makeReversalRows());

		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
			structuredContent: { data?: { indicators?: unknown } };
		};
		const text = res.content[0].text;

		// MACD の直近クロス（macd_series 由来）
		expect(text).toMatch(/・ゴールデンクロス: \d+本前/);
		// SMA(25) の slope 矢印（sma_25_series 由来）
		expect(text).toMatch(/SMA\(25\):.*📈/);
		// BB バンド幅トレンド（bb2_series 由来）
		expect(text).toMatch(/バンド幅:.*(拡大中|収縮中|不変)/);
		// σ 過去推移（bb2_series + normalized 由来）
		expect(text).toContain('過去推移');

		// handler が構造化出力に載せる indicators も schema 契約を満たす（analyzeIndicators 内の parse を通った形状がそのまま流れる）。
		const indicators = res.structuredContent?.data?.indicators;
		expect(indicators).toBeDefined();
		expect(() => IndicatorsInternalSchema.parse(indicators)).not.toThrow();
	});

	// 手組みモックでは「本番が失敗をどう返すか」を検証できないので、取得層の失敗の伝播も素通し型で見る。
	it('fetch 失敗時は handler が失敗結果（ok:false / errorType=network）を伝播する', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 });
		assertFail(res);
		expect(res.meta.errorType).toBe('network');
	});
});
