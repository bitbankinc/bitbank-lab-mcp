import { afterEach, describe, expect, it, vi } from 'vitest';
import { toolDef } from '../src/handlers/analyzeIndicatorsHandler.js';
import { IndicatorsInternalSchema } from '../src/schema/indicators.js';
import { clearIndicatorCache, computeAllIndicators } from '../tools/analyze_indicators.js';
import getCandles from '../tools/get_candles.js';
import { assertFail, assertOk } from './_assertResult.js';

// =============================================================================
// ハンドラのフィクスチャ乖離を構造的に防ぐ「契約テスト」
// =============================================================================
//
// 過去に analyze_indicators handler が存在しない `indicators.series.*` を参照し、
// MACD/SMA クロス・slope・BB 幅トレンド・σ推移が恒常欠落するバグがあった。長期間
// 見逃された根本原因は、handler テストの mock が「本番が返さない series 形状」を手で
// 注入しており、テストは緑のまま本番だけ壊れていたこと。
//
// このファイルは「テストが緑でも本番のデータ契約が壊れている」状態を機械検出するための
// 2 系統の型を確立する:
//   A. スキーマ契約: computeAllIndicators（本番）の出力を IndicatorsInternalSchema に
//      直接通し、未知キー混入・キーパス欠落（＝旧キー参照の再発）を検出する。
//   B. 実パイプライン契約（テンプレ）: fetch のみモックし get_candles → analyzeIndicators
//      → handler を本物のまま素通しする。tool 戻り値を手組みしないため、本番形状の
//      ズレがそのまま赤になる。新規ハンドラのテストはこの型を踏襲すること。
//      （参照実装: tests/analyze_indicators.test.ts の「本番経路」テスト）
//
// 既存フィクスチャの棚卸し（本番 `indicators` 形状を手組みしている箇所）:
//   - analyzeIndicatorsHandler.test.ts（修正済み: flat series。本ファイルが構造ガード）
//   - analyze_bb_snapshot / analyze_ichimoku_snapshot / analyze_stoch_snapshot /
//     analyze_market_signal / detect_macd_cross / analyze_currency_strength 等
//   いずれも本番と同じキー名（bb2_series / ichi_series.tenkan / macd_series.line /
//   stoch_k_series 等）を使っており、現時点でキー名のズレは無い（部分集合の手組み）。
//   本ファイルが「本番出力 ↔ schema」の単一ソース契約を担保するため、各 handler テストは
//   この契約の上に乗る形になる。
// =============================================================================

type OhlcvRow = [string, string, string, string, string, string];

/** 単調増加の日足 OHLCV。全指標（ICHIMOKU 含む >=52本）が有効になる十分なバー数を作る。 */
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

/**
 * 本番の正規化ローソク足を「本物の get_candles」経由で得てから computeAllIndicators に通す。
 * normalized を手組みしないことで、本番が実際に渡す形状そのものを契約対象にする。
 */
async function realIndicators(barCount = 250) {
	mockFetchRows(makeOhlcvRows(barCount));
	const candles = await getCandles('btc_jpy', '1day', undefined, barCount);
	assertOk(candles);
	expect(candles.data.normalized.length).toBeGreaterThanOrEqual(52);
	return computeAllIndicators(candles.data.normalized);
}

// =============================================================================
// A. スキーマ契約: computeAllIndicators（本番出力） ↔ IndicatorsInternalSchema
// =============================================================================

describe('indicators schema contract: computeAllIndicators ↔ IndicatorsInternalSchema', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		clearIndicatorCache();
	});

	it('本番出力に schema 未定義キー（未知キー混入）が無い（strict parse が通る）', async () => {
		const indicators = await realIndicators();
		// strict() は schema に存在しないキーがあると throw する。
		// → computeAllIndicators が schema 未定義キーを生やす / schema 側がキーをリネームすると即赤。
		expect(() => IndicatorsInternalSchema.strict().parse(indicators)).not.toThrow();
	});

	it('本番出力の各キーが schema の受理する型で出る（IndicatorsInternalSchema.parse が通る）', async () => {
		const indicators = await realIndicators();
		// 既定 parse は未知キーを strip するが、既知キーの型不一致・nested 必須キー欠落は検出する。
		expect(() => IndicatorsInternalSchema.parse(indicators)).not.toThrow();
	});

	// zod は既定で未知キーを strip するため、「handler が読むキーパスが本番出力に実在するか」を
	// 明示 assert する。リネームすると undefined になり赤になる（＝契約破壊の検出）。
	it('handler が読むキーパスが本番出力に実在する（旧 series.* 参照の再発防止）', async () => {
		const ind = await realIndicators();

		// MACD クロス・divergence 用（handler: ind.macd_series.line/signal/hist）
		expect(Array.isArray(ind.macd_series?.line)).toBe(true);
		expect(Array.isArray(ind.macd_series?.signal)).toBe(true);
		expect(Array.isArray(ind.macd_series?.hist)).toBe(true);
		// SMA slope / cross 用（handler: ind.sma_25_series 等）
		expect(Array.isArray(ind.sma_25_series)).toBe(true);
		expect(Array.isArray(ind.sma_75_series)).toBe(true);
		expect(Array.isArray(ind.sma_200_series)).toBe(true);
		// BB 幅トレンド・σ推移用（handler: ind.bb2_series.upper/middle/lower）
		expect(Array.isArray(ind.bb2_series?.upper)).toBe(true);
		expect(Array.isArray(ind.bb2_series?.middle)).toBe(true);
		expect(Array.isArray(ind.bb2_series?.lower)).toBe(true);
		// 一目均衡表 slope・「今日の雲」用（handler: ind.ichi_series.tenkan/kijun/spanA/spanB）
		expect(Array.isArray(ind.ichi_series?.tenkan)).toBe(true);
		expect(Array.isArray(ind.ichi_series?.kijun)).toBe(true);
		expect(Array.isArray(ind.ichi_series?.spanA)).toBe(true);
		expect(Array.isArray(ind.ichi_series?.spanB)).toBe(true);

		// 旧バグの再発防止: 本番は flat 構造で `series` ラッパを持たない。
		expect((ind as Record<string, unknown>).series).toBeUndefined();
	});

	// 受け入れ条件: 指標オブジェクトのキー名をわざとリネームすると赤になる（契約破壊を検出できる証明）。
	// 上の「本番出力にキーパスが実在する」テストは本番側リネームで赤になるが、ここでは契約（schema）が
	// リネームを検出する仕組み自体を、本番出力を改変して直接証明する。
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

// =============================================================================
// B. 実パイプライン契約（テンプレ）: fetch → get_candles → analyzeIndicators → handler
// =============================================================================
//
// 新規ハンドラのテストはこの型を踏襲する。ポイントは「tool 戻り値を手組みしない」こと:
//   - vi.mock で analyzeIndicators を差し替えない。
//   - globalThis.fetch だけをモックし、get_candles → analyzeIndicators → handler を素通しする。
// こうすると本番が返す flat series 形状をそのまま検証でき、handler が誤ったキーパスを読むと
// （以前の indicators.series.* バグのように）シグナルが欠落して赤になる。
// =============================================================================

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

		// 本番の flat series を正しく読めている証拠（手組みモックでは保証されない領域）:
		// MACD の直近クロス（macd_series 由来）
		expect(text).toMatch(/・ゴールデンクロス: \d+本前/);
		// SMA(25) の slope 矢印（sma_25_series 由来）
		expect(text).toMatch(/SMA\(25\):.*📈/);
		// BB バンド幅トレンド（bb2_series 由来）
		expect(text).toMatch(/バンド幅:.*(拡大中|収縮中|不変)/);
		// σ 過去推移（bb2_series + normalized 由来）
		expect(text).toContain('過去推移');

		// end-to-end: handler が構造化出力に載せる indicators が schema 契約を満たす
		// （analyzeIndicators 内の parse を通った形状がそのまま流れることを確認）。
		const indicators = res.structuredContent?.data?.indicators;
		expect(indicators).toBeDefined();
		expect(() => IndicatorsInternalSchema.parse(indicators)).not.toThrow();
	});

	// テンプレは異常系も示す: 取得層（fetch）が失敗したら handler は失敗結果（ok:false）を
	// そのまま伝播する。手組みモックでは「本番が失敗をどう返すか」を検証できないため、
	// 素通し型でこそ意味がある契約。
	it('fetch 失敗時は handler が失敗結果（ok:false / errorType=network）を伝播する', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 });
		assertFail(res);
		expect(res.meta.errorType).toBe('network');
	});
});
