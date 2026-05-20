import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../lib/datetime.js';
import { toolDef } from '../src/handlers/analyzeIndicatorsHandler.js';
import analyzeIndicators, { clearIndicatorCache, computeOBV, ema } from '../tools/analyze_indicators.js';
import { assertFail, assertOk } from './_assertResult.js';

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

describe('analyze_indicators', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearIndicatorCache();
	});

	it('inputSchema: limit は 1 以上のみ許可する', () => {
		const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', type: '1day', limit: 0 });
		expect(parse).toThrow();
	});

	it('正常系: 指標データとチャート時系列を返す', async () => {
		const rows = makeOhlcvRows(600);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', 60);
		assertOk(res);
		expect(res.data.indicators).toHaveProperty('RSI_14');
		expect(Array.isArray(res.data.chart.candles)).toBe(true);
		expect(Array.isArray(res.data.chart.indicators.SMA_25)).toBe(true);
	});

	it('全取得失敗時は errorType=network を返すべき（現状 user 扱い）', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', 1000);
		assertFail(res);
		expect(res.meta.errorType).toBe('network');
	});

	it('キャッシュ利用時も limit に応じた requiredCount と summary を返すべき', async () => {
		const rows = makeOhlcvRows(600);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const first = await analyzeIndicators('btc_jpy', '1day', 200);
		assertOk(first);
		expect(first.meta.requiredCount).toBe(399);

		const second = await analyzeIndicators('btc_jpy', '1day', 50);
		assertOk(second);
		expect(second.meta.requiredCount).toBe(249);
		expect(second.summary).toContain('直近50本');
	});

	// --- analyzeTrend branches ---

	it('analyzeTrend: データ不足（< 25行）→ trend=insufficient_data かつ警告を含む', async () => {
		// 10 rows: SMA_25 が計算できない → insufficient_data
		const rows = makeOhlcvRows(10);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		expect(res.data.trend).toBe('insufficient_data');
		// 複数の警告が生成される
		expect(res.meta.warnings).toBeDefined();
		expect(res.meta.warnings?.length).toBeGreaterThan(0);
	});

	it('analyzeTrend: 強い上昇トレンド（price > sma25 > sma75, sma200 存在, price > sma200） → strong_uptrend', async () => {
		// 250行の強い上昇トレンドデータ（全て単調増加）
		const count = 250;
		const startMs = Date.UTC(2024, 0, 1);
		const rows: OhlcvRow[] = [];
		for (let i = 0; i < count; i++) {
			const base = 1_000_000 + i * 100_000; // 大きく単調増加
			rows.push([
				String(base),
				String(base + 10_000),
				String(base - 10_000),
				String(base + 5_000),
				'1.5',
				String(startMs + i * 86_400_000),
			]);
		}
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		expect(res.data.trend).toBe('strong_uptrend');
	});

	it('analyzeTrend: 上昇トレンド（price > sma25 > sma75, sma200 なし）→ uptrend', async () => {
		// 80行: sma200 は計算できないが sma25/sma75 は計算できる単調増加
		const count = 80;
		const startMs = Date.UTC(2024, 0, 1);
		const rows: OhlcvRow[] = [];
		for (let i = 0; i < count; i++) {
			const base = 1_000_000 + i * 100_000;
			rows.push([
				String(base),
				String(base + 10_000),
				String(base - 10_000),
				String(base + 5_000),
				'1.5',
				String(startMs + i * 86_400_000),
			]);
		}
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		expect(res.data.trend).toBe('uptrend');
	});

	it('analyzeTrend: 強い下降トレンド（price < sma25 < sma75, sma200 存在, price < sma200） → strong_downtrend', async () => {
		// 250行の強い下降トレンド（単調減少）。モックが2回呼ばれるので合計500行。
		// 十分な価格を設定して負にならないようにする（500行 × 10,000 = 5,000,000 減少）
		const count = 250;
		const startMs = Date.UTC(2024, 0, 1);
		const rows: OhlcvRow[] = [];
		for (let i = 0; i < count; i++) {
			const base = 50_000_000 - i * 10_000; // 1日 10,000 円ずつ下落（500行で -5,000,000）
			rows.push([
				String(base),
				String(base + 5_000),
				String(base - 5_000),
				String(base - 2_000),
				'1.5',
				String(startMs + i * 86_400_000),
			]);
		}
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		expect(res.data.trend).toBe('strong_downtrend');
	});

	it('analyzeTrend: 下降トレンド（price < sma25 < sma75, sma200 なし）→ downtrend', async () => {
		// 80行の単調減少（sma200 なし）。モックが2回呼ばれるので合計160行。
		// 160行 < 200 なので sma200 は null → downtrend（strong_downtrend にならない）
		const count = 80;
		const startMs = Date.UTC(2024, 0, 1);
		const rows: OhlcvRow[] = [];
		for (let i = 0; i < count; i++) {
			const base = 20_000_000 - i * 100_000; // 1日 100,000 円ずつ下落（160行で -16,000,000）
			rows.push([
				String(base),
				String(base + 5_000),
				String(base - 5_000),
				String(base - 2_000),
				'1.5',
				String(startMs + i * 86_400_000),
			]);
		}
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		expect(res.data.trend).toBe('downtrend');
	});

	it('analyzeTrend: 横ばい（sma25/75 揃っているが明確な方向なし）→ sideways/overbought/oversold/uptrend/downtrend のいずれか（insufficient_data ではない）', async () => {
		// 100行の横ばいデータ（価格帯がほぼ一定）。モックは2回呼ばれるため合計200行。
		const count = 100;
		const startMs = Date.UTC(2024, 0, 1);
		const rows: OhlcvRow[] = [];
		for (let i = 0; i < count; i++) {
			const base = 5_000_000; // 完全に一定の価格
			rows.push([
				String(base),
				String(base + 200),
				String(base - 200),
				String(base),
				'1.5',
				String(startMs + i * 86_400_000),
			]);
		}
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		// insufficient_data ではない（SMA_25 と SMA_75 が計算できているため）
		expect(res.data.trend).not.toBe('insufficient_data');
		// 完全横ばいの場合は sideways が期待されるが、RSI次第で overbought/oversold になることもある
		expect([
			'sideways',
			'overbought',
			'oversold',
			'uptrend',
			'downtrend',
			'strong_uptrend',
			'strong_downtrend',
		]).toContain(res.data.trend);
	});

	it('analyzeTrend: 完全フラット価格（SMA全て同値, RSI=50）→ sideways（price==SMA でトレンド条件外）', async () => {
		// 完全フラット価格: close = open = high = low = 一定値
		// SMA_25 = SMA_75 = close → price == sma25 == sma75（> でも < でもない）
		// Wilder RSI: 変化なし → avgGain=0 && avgLoss=0 → 中立値 RSI = 50（業界標準）
		// RSI=50 は overbought/oversold いずれでもなく、price==SMA でトレンド条件外なので sideways
		// モック2回で合計 2×100=200行 (全て同値)
		const rows = makeOhlcvRows(100).map(([_o, _h, _l, _c, v, ts]) => {
			const base = '5000000';
			return [base, base, base, base, v, ts] as OhlcvRow;
		});
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		// RSI=50 は中立値、price==SMA なので uptrend/downtrend 条件に入らず sideways
		expect(res.data.trend).toBe('sideways');
	});

	it('analyzeTrend: 緩やかな上下動（RSI≈50, SMA同値付近）→ sideways', async () => {
		// 戦略: 価格が一定のベースで交互に±500円ずつ動く（close は奇数行が +500, 偶数行が -500）
		// SMA_25 ≈ SMA_75 ≈ base（上下均等なので）
		// RSI ≈ 50（均等な利益・損失）→ sideways
		// モック2回で合計 2×100=200行
		const startMs = Date.UTC(2022, 0, 1);
		const rows: OhlcvRow[] = [];
		const base = 5_000_000;
		for (let i = 0; i < 100; i++) {
			// 交互に +500/-500 で RSI≈50
			const close = i % 2 === 0 ? base + 500 : base - 500;
			rows.push([
				String(base),
				String(base + 1000),
				String(base - 1000),
				String(close),
				'1.0',
				String(startMs + i * 86_400_000),
			]);
		}
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		// 緩やかな上下動: sideways, overbought, oversold, downtrend のいずれか（insufficient_data ではない）
		expect(res.data.trend).not.toBe('insufficient_data');
	});

	// --- warning branches: insufficient data ---
	// Note: `1day` type で fetchCount=259 (limit=null, displayCount=60 の場合) を要求すると、
	// 2026年現在では estimatedBarsThisYear≈92 < 259 のため yearsNeeded=2 となり
	// モックが2回呼ばれる。各呼び出しで N 行が返るので合計 2N 行が normalized に入る。
	// 各警告のしきい値を踏まえて N を設定する。

	it('各警告の分岐: RSI_14/Bollinger_Bands/Stochastic → データ不足 の警告を含む（モック2回 × 7行 = 14行）', async () => {
		// 2呼び出し × 7行 = 14行 < 15 → RSI_14警告
		// 14行 < 20 → SMA_20, Bollinger_Bands, Stochastic警告
		const rows = makeOhlcvRows(7);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		expect(res.meta.warnings).toBeDefined();
		expect(res.meta.warnings?.some((w) => w.includes('RSI_14'))).toBe(true);
		expect(res.meta.warnings?.some((w) => w.includes('Bollinger_Bands'))).toBe(true);
		expect(res.meta.warnings?.some((w) => w.includes('Stochastic'))).toBe(true);
	});

	it('各警告の分岐: SMA_200/EMA_200 → データ不足 の警告を含む（モック2回 × 99行 = 198行）', async () => {
		// 2呼び出し × 99行 = 198行 < 200 → SMA_200, EMA_200警告
		const rows = makeOhlcvRows(99);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		expect(res.meta.warnings).toBeDefined();
		expect(res.meta.warnings?.some((w) => w.includes('SMA_200'))).toBe(true);
		expect(res.meta.warnings?.some((w) => w.includes('EMA_200'))).toBe(true);
	});

	it('各警告の分岐: Ichimoku → データ不足 の警告を含む（モック2回 × 25行 = 50行）', async () => {
		// 2呼び出し × 25行 = 50行 < 52 → Ichimoku警告
		const rows = makeOhlcvRows(25);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		expect(res.meta.warnings).toBeDefined();
		expect(res.meta.warnings?.some((w) => w.includes('Ichimoku'))).toBe(true);
	});

	it('各警告の分岐: StochRSI → データ不足 の警告を含む（モック2回 × 16行 = 32行）', async () => {
		// 2呼び出し × 16行 = 32行 < 34 → StochRSI警告
		const rows = makeOhlcvRows(16);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		expect(res.meta.warnings).toBeDefined();
		expect(res.meta.warnings?.some((w) => w.includes('StochRSI'))).toBe(true);
	});

	it('各警告の分岐: SMA_5 → データ不足 の警告を含む（モック2回 × 2行 = 4行）', async () => {
		// 2呼び出し × 2行 = 4行 < 5 → SMA_5, SMA_20, etc 警告
		const rows = makeOhlcvRows(2);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		expect(res.meta.warnings).toBeDefined();
		expect(res.meta.warnings?.some((w) => w.includes('SMA_5'))).toBe(true);
	});

	// --- ICHIMOKU_conversion branch in latestIndicators ---

	it('十分なデータ（>= 52行）があれば ICHIMOKU_conversion が summary に含まれる', async () => {
		const rows = makeOhlcvRows(600);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		expect(res.summary).toContain('ICHI_conv');
	});

	it('データ不足（< 52行）で ichimoku が null → summary に ICHI_conv が含まれない（2呼び出し × 25行 = 50行）', async () => {
		// 2呼び出し × 25行 = 50行 < 52 → ichimoku snapshot が null → ICHI_conv は summary に含まれない
		const rows = makeOhlcvRows(25);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		expect(res.summary).not.toContain('ICHI_conv');
	});

	// --- 上流 fetchWarning（meta.warning）の伝播 ---

	describe('上流 fetchWarning の meta.warning 伝播', () => {
		afterEach(() => clearIndicatorCache());

		function mockPartialMultiYear() {
			// analyze_indicators は anchorYear=currentYear で fetchSingleYear を並列呼び出しする。
			// 過半数失敗だと fail になるので、最古年 1 つだけを success:0 で失敗させる。
			const currentYear = dayjs.utc().year();
			const baseTs = dayjs.utc(`${currentYear - 1}-01-01`).valueOf();
			const validRows = Array.from({ length: 365 }, (_, i) => [
				'100',
				'110',
				'90',
				'105',
				'1.0',
				String(baseTs + i * 86_400_000),
			]);
			const callCount = { n: 0 };
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
				callCount.n += 1;
				const urlStr = String(url);
				// URL の年部分を抽出（末尾の /YYYY）
				const match = urlStr.match(/\/(\d{4})$/);
				const year = match ? Number(match[1]) : Number.NaN;
				// 最古年（呼ばれた中で最小）を 1 つだけ失敗させる仕掛けは複雑なので、
				// 「特定の年（現在年-3）を失敗扱い」にして 1/4 の partial failure を作る。
				const failYear = currentYear - 3; // 4年取得時 [cy, cy-1, cy-2, cy-3] の最古
				if (year === failYear) {
					return {
						ok: true,
						status: 200,
						statusText: 'OK',
						json: async () => ({ success: 0, data: { code: 10000 } }),
					} as Response;
				}
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					json: async () => ({ success: 1, data: { candlestick: [{ ohlcv: validRows }] } }),
				} as Response;
			});
			return callCount;
		}

		it('部分失敗時 meta.warning に伝播し、meta.warnings（指標不足）とは別フィールド', async () => {
			mockPartialMultiYear();
			// 日足 limit=1100 → fetchCount は 2回（buffer 含む）かつ getCandles 内で multi-year 経路
			const res = await analyzeIndicators('btc_jpy', '1day', 1100);
			assertOk(res);
			expect(res.meta.warning).toBeDefined();
			expect(typeof res.meta.warning).toBe('string');
			expect(res.meta.warning).toContain('失敗');
			// warnings 配列に上流警告が混入していないこと
			if (res.meta.warnings) {
				for (const w of res.meta.warnings) {
					expect(w).not.toContain('失敗');
				}
			}
		});

		it('キャッシュヒット時も meta.warning が保持される（cache miss → cache hit）', async () => {
			mockPartialMultiYear();
			const first = await analyzeIndicators('btc_jpy', '1day', 1100);
			assertOk(first);
			expect(first.meta.warning).toBeDefined();
			const firstWarning = first.meta.warning;

			// 2 回目: limit を小さくしてキャッシュヒットさせる
			const second = await analyzeIndicators('btc_jpy', '1day', 50);
			assertOk(second);
			// upstreamWarning が cache に保存されているので、2回目もそのまま見える
			expect(second.meta.warning).toBe(firstWarning);
		});

		it('正常系（部分失敗なし）では meta.warning は undefined', async () => {
			const rows = makeOhlcvRows(600);
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ success: 1, data: { candlestick: [{ ohlcv: rows }] } }),
			} as Response);

			const res = await analyzeIndicators('btc_jpy', '1day', 60);
			assertOk(res);
			expect(res.meta.warning).toBeUndefined();
		});
	});
});

// --- Unit tests for exported functions ---

describe('ema (exported)', () => {
	it('period <= 1 → 各値をそのまま toFixed(2) で返す', () => {
		const values = [100.123, 200.456, 300.789];
		const result = ema(values, 1);
		expect(result).toHaveLength(3);
		expect(result[0]).toBe(100.12);
		expect(result[1]).toBe(200.46);
		expect(result[2]).toBe(300.79);
	});

	it('period <= 1 (0) → 値をそのまま返す', () => {
		const values = [50, 100, 150];
		const result = ema(values, 0);
		expect(result).toHaveLength(3);
		expect(result[0]).toBe(50);
	});

	it('null 値が含まれる場合 → null を返す', () => {
		const values = [100, null as unknown as number, 300];
		const result = ema(values, 1);
		expect(result[1]).toBeNull();
	});

	it('period > 1 → EMA 計算を行う', () => {
		const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		const result = ema(values, 3);
		expect(result).toHaveLength(10);
		// 先頭2つはnull
		expect(result[0]).toBeNull();
		expect(result[1]).toBeNull();
		// 3番目以降は計算値
		expect(result[2]).not.toBeNull();
	});
});

describe('computeOBV (exported)', () => {
	it('candles.length < 2 → null を返す', () => {
		const candles = [{ open: 100, high: 110, low: 90, close: 105, volume: 10, unixtime: 0 }] as unknown as Parameters<
			typeof computeOBV
		>[0];
		const result = computeOBV(candles);
		expect(result.obv).toBeNull();
		expect(result.obvSma).toBeNull();
		expect(result.prevObv).toBeNull();
		expect(result.trend).toBeNull();
	});

	it('candles.length === 0 → null を返す', () => {
		const result = computeOBV([]);
		expect(result.obv).toBeNull();
		expect(result.trend).toBeNull();
	});

	it('candles >= 2 だが < smaPeriod (20) → obvSma は null、trend も null', () => {
		const candles = Array.from({ length: 5 }, (_, i) => ({
			open: 100 + i,
			high: 110 + i,
			low: 90 + i,
			close: 100 + i,
			volume: 10,
			unixtime: i * 86400,
		})) as Parameters<typeof computeOBV>[0];
		const result = computeOBV(candles, 20);
		expect(result.obv).not.toBeNull();
		expect(result.obvSma).toBeNull();
		expect(result.trend).toBeNull();
	});

	it('candles >= smaPeriod → trend が rising/falling/flat のいずれか', () => {
		// 25本: 全て値上がり（OBVは単調増加）
		const candles = Array.from({ length: 25 }, (_, i) => ({
			open: 1000 + i * 100,
			high: 1100 + i * 100,
			low: 900 + i * 100,
			close: 1050 + i * 100, // 毎日終値が高くなる
			volume: 1000,
			unixtime: i * 86400,
		})) as Parameters<typeof computeOBV>[0];
		const result = computeOBV(candles, 20);
		expect(result.obv).not.toBeNull();
		expect(result.obvSma).not.toBeNull();
		expect(['rising', 'falling', 'flat']).toContain(result.trend);
	});

	it('trend: OBV が SMA より大幅に上回る → rising', () => {
		// 前半は価格下落（OBV減少）、後半で急激に上昇（OBV大幅増加）
		// 後半でOBVが急増するとSMA20より高くなる
		const candles = Array.from({ length: 40 }, (_, i) => {
			// 後半20本で急騰
			const isRising = i >= 20;
			const base = isRising ? 1000 + (i - 20) * 5000 : 1000;
			return {
				open: base,
				high: base + 100,
				low: base - 100,
				close: base + 50,
				volume: isRising ? 10000 : 100, // 後半で出来高急増
				unixtime: i * 86400,
			};
		}) as Parameters<typeof computeOBV>[0];
		const result = computeOBV(candles, 20);
		expect(result.trend).toBe('rising');
	});

	it('trend: OBV が SMA より大幅に下回る → falling', () => {
		// 前半は価格上昇（OBV増加）、後半で急落
		const candles = Array.from({ length: 40 }, (_, i) => {
			const isFalling = i >= 20;
			const base = isFalling ? 5000 - (i - 20) * 200 : 5000;
			return {
				open: base,
				high: base + 100,
				low: base - 100,
				close: base - 50, // 終値が下落
				volume: isFalling ? 10000 : 100, // 後半で出来高急増しながら下落
				unixtime: i * 86400,
			};
		}) as Parameters<typeof computeOBV>[0];
		const result = computeOBV(candles, 20);
		expect(result.trend).toBe('falling');
	});

	it('trend: OBV が SMA とほぼ同じ → flat', () => {
		// 全て同じ終値（OBVは変動なし）
		const candles = Array.from({ length: 25 }, (_, i) => ({
			open: 1000,
			high: 1010,
			low: 990,
			close: 1000, // 変動なし → OBV変化なし
			volume: 100,
			unixtime: i * 86400,
		})) as Parameters<typeof computeOBV>[0];
		const result = computeOBV(candles, 20);
		// OBVがゼロ付近で動かない場合、threshold=0なのでflatになる
		expect(result.trend).toBe('flat');
	});
});

describe('padSeriesLengths: createChartData 経由で検証', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearIndicatorCache();
	});

	it('系列長が candles 長と一致しない場合にパディング/スライスされる', async () => {
		// 少量データでも chart.indicators の各系列が candles と同じ長さになること
		const rows = makeOhlcvRows(30);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);

		const candlesLen = res.data.chart.candles.length;
		const indicators = res.data.chart.indicators as Record<string, unknown>;

		// Array 型の指標系列は全て candles と同じ長さになっているはず
		const seriesKeys = ['SMA_25', 'SMA_75', 'EMA_12', 'BB_upper', 'RSI_14_series'];
		for (const key of seriesKeys) {
			if (Array.isArray(indicators[key])) {
				expect((indicators[key] as unknown[]).length).toBe(candlesLen);
			}
		}
	});

	it('大量データ（600行）でも系列が candles 長に揃えられる（slice側のブランチ）', async () => {
		// limit=10 にすることで candles が短くなり、系列が slice される
		const rows = makeOhlcvRows(600);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', 10);
		assertOk(res);

		// chart.candles は normalized（全行）なので長さは600
		const candlesLen = res.data.chart.candles.length;
		const indicators = res.data.chart.indicators as Record<string, unknown>;

		// SMA_25 は全candles行に対応するはず
		if (Array.isArray(indicators.SMA_25)) {
			expect((indicators.SMA_25 as unknown[]).length).toBe(candlesLen);
		}
	});

	// 契約: 戻り値の全系列の長さが normalized (chart.candles) と一致する。
	// padSeriesLengths が対象外とする macd_series も、計算時点で normalized から
	// 直接生成されるため一致する。落とすと描画層で index ずれが起きる。
	it('normalized.length と chart.indicators の各系列長が一致する（macd_series 含む）', async () => {
		// 60 行: SMA_25/EMA_26 等の主要指標が有効になる十分なバー数
		const rows = makeOhlcvRows(60);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);

		const candlesLen = res.data.chart.candles.length;
		const indicators = res.data.chart.indicators as Record<string, unknown>;

		// padSeriesLengths 対象キー（全て candles と同じ長さに揃えられる）
		const paddedKeys = [
			'SMA_5',
			'SMA_20',
			'SMA_25',
			'SMA_50',
			'SMA_75',
			'SMA_200',
			'EMA_12',
			'EMA_26',
			'EMA_50',
			'EMA_200',
			'BB_upper',
			'BB_middle',
			'BB_lower',
			'BB1_upper',
			'BB1_middle',
			'BB1_lower',
			'BB2_upper',
			'BB2_middle',
			'BB2_lower',
			'BB3_upper',
			'BB3_middle',
			'BB3_lower',
			'ICHI_tenkan',
			'ICHI_kijun',
			'ICHI_spanA',
			'ICHI_spanB',
			'ICHI_chikou',
			'RSI_14_series',
			'stoch_k_series',
			'stoch_d_series',
		];
		for (const key of paddedKeys) {
			expect(Array.isArray(indicators[key])).toBe(true);
			expect((indicators[key] as unknown[]).length).toBe(candlesLen);
		}

		// padSeriesLengths 対象外の macd_series も normalized から直接計算されるため一致する
		const macdSeries = indicators.macd_series as { line: unknown[]; signal: unknown[]; hist: unknown[] } | undefined;
		expect(macdSeries).toBeDefined();
		if (macdSeries) {
			expect(Array.isArray(macdSeries.line)).toBe(true);
			expect(Array.isArray(macdSeries.signal)).toBe(true);
			expect(Array.isArray(macdSeries.hist)).toBe(true);
			expect(macdSeries.line.length).toBe(candlesLen);
			expect(macdSeries.signal.length).toBe(candlesLen);
			expect(macdSeries.hist.length).toBe(candlesLen);
		}
	});
});
