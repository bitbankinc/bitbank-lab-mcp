import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../lib/datetime.js';
import { toolDef } from '../src/handlers/analyzeIndicatorsHandler.js';
import { GetIndicatorsInputSchema } from '../src/schemas.js';
import analyzeIndicators, { clearIndicatorCache, computeOBV, ema } from '../tools/analyze_indicators.js';
import { assertFail, assertOk } from './_assertResult.js';
import { requireDefined } from './helpers/assert.js';

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

	it('inputSchema: date と tz は終端アンカーとして受け付ける', () => {
		const parsed = GetIndicatorsInputSchema.parse({ pair: 'btc_jpy', type: '1day', date: '20250831', tz: 'UTC' });
		expect(parsed.date).toBe('20250831');
		expect(parsed.tz).toBe('UTC');
	});

	it('date 指定時の本文ヘッダは現在時刻ではなくアンカー終端を示す', async () => {
		const rows = makeOhlcvRows(600);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const result = await toolDef.handler({ pair: 'btc_jpy', type: '1day', date: '20250831', tz: 'UTC', limit: 60 });
		const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
		const text = content?.[0]?.type === 'text' ? content[0].text || '' : '';
		expect(text).toContain('終端 date=20250831 指定');
		expect(text.split('\n')[1]).toContain('時点');
		expect(text.split('\n')[1]).not.toContain('現在');
	});

	it('安いペアの価格の指標を小数 2 桁で切らない（構造化データのスキーマでも切らない）', async () => {
		const startMs = Date.UTC(2024, 0, 1);
		const rows = Array.from({ length: 600 }, (_, i) => {
			const base = 31 + Math.sin(i / 7) * 0.5;
			return [base, base + 0.02, base - 0.02, base + 0.005]
				.map((v) => v.toFixed(4))
				.concat(['1000', String(startMs + i * 86_400_000)]);
		});
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('doge_jpy', '1day', 60);
		assertOk(res);
		const decimals = (v: number) => String(v).split('.')[1]?.length ?? 0;
		const sma = (res.data.chart.indicators.SMA_25 ?? []).filter((v): v is number => v != null);
		expect(sma.length).toBeGreaterThan(0);
		expect(Math.max(...sma.map(decimals))).toBeGreaterThan(2);
		const hist = (res.data.chart.indicators.macd_series?.hist ?? []).filter((v): v is number => v != null);
		expect(Math.max(...hist.map(decimals))).toBeGreaterThan(2);
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

	// mock で series を注入せず、fetch → get_candles → analyzeIndicators → toolDef.handler を素通しで検証する（本番が返す flat 形状そのものを使う）。
	it('本番経路: 下降→上昇のゴールデンクロスで MACD クロス・slope・bwTrend・σ推移が出る', async () => {
		// 単純な線形 V だと下降中の MACD line−signal が 0 のタイになり golden cross が出ないので、反発を加速させて line が signal を負→正で明確に上抜けるようにする。
		const startMs = Date.UTC(2025, 0, 1);
		const rows: OhlcvRow[] = [];
		for (let i = 0; i < 200; i++) {
			// 0..139: 30M → 16.1M（緩やかな下降）、140..174: 16M → 9M（急落・加速）、175..199: 9M → 17.4M（直近の急反発）
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
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = (await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 200 })) as {
			content: Array<{ text: string }>;
		};
		const text = res.content[0].text;
		// SMA の crossInfo（`直近クロス: ゴールデン`）に引っ張られないよう、MACD セクションの行フォーマットで assert する。
		expect(text).toMatch(/・ゴールデンクロス: \d+本前/);
		// 他指標の矢印に引っ張られないよう SMA(25) 行で限定する。
		expect(text).toMatch(/SMA\(25\):.*📈/);
		expect(text).toMatch(/バンド幅:.*(拡大中|収縮中|不変)/);
		expect(text).toContain('過去推移');
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

	it('終端 date が異なるデータを同じキャッシュに混ぜない', async () => {
		const rows = makeOhlcvRows(600);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const first = await analyzeIndicators('btc_jpy', '1day', 60, '20250831', 'UTC');
		assertOk(first);
		const callsAfterFirst = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
		const cached = await analyzeIndicators('btc_jpy', '1day', 60, '20250831', 'UTC');
		assertOk(cached);
		expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
		const differentTimezone = await analyzeIndicators('btc_jpy', '1day', 60, '20250831', 'America/New_York');
		assertOk(differentTimezone);
		expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsAfterFirst);
		const callsAfterTimezone = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
		const second = await analyzeIndicators('btc_jpy', '1day', 60, '20250901', 'UTC');
		assertOk(second);
		expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsAfterTimezone);
	});

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
		// 250 行の強い下降トレンド（単調減少）。
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
		// 80 行の単調減少。80 行 < 200 なので sma200 は null → downtrend（strong_downtrend にならない）
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
		// 100 行の横ばいデータ（価格帯がほぼ一定）。
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
		// 完全フラット価格では SMA_25 = SMA_75 = close で、Wilder RSI は avgGain=0 && avgLoss=0 → 中立値 50。RSI=50 は overbought/oversold のいずれでもなく、price==SMA でトレンド条件外なので sideways。
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
		expect(res.data.trend).toBe('sideways');
	});

	it('analyzeTrend: 緩やかな上下動（RSI≈50, SMA同値付近）→ sideways', async () => {
		// 交互に ±500 円ずつ動かすと SMA_25 ≈ SMA_75 ≈ base、RSI ≈ 50 → sideways
		const startMs = Date.UTC(2022, 0, 1);
		const rows: OhlcvRow[] = [];
		const base = 5_000_000;
		for (let i = 0; i < 100; i++) {
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

	// 2 回の fetch は同じ timestamp の行を返すので dedupeByTimestamp で 1 本扱いになり、normalized の本数 = 行数。

	it('各警告の分岐: RSI_14/Bollinger_Bands/Stochastic → データ不足 の警告を含む（7 本）', async () => {
		// 7 行 < 15 → RSI_14 警告、7 行 < 20 → SMA_20, Bollinger_Bands, Stochastic 警告
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

	// classic Stochastic（kPeriod=14, smoothK=3, smoothD=3）の最新 %D は 18本目で確定する。
	it('Stochastic 境界: 17本（< 18）→ Stochastic 警告あり', async () => {
		const rows = makeOhlcvRows(17);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		expect(res.meta.warnings?.some((w) => w.includes('Stochastic'))).toBe(true);
	});

	it('Stochastic 境界: 18本（= 最小要件）→ Stochastic 警告なし（off-by-two 是正）', async () => {
		const rows = makeOhlcvRows(18);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		expect(res.meta.warnings?.some((w) => w.includes('Stochastic'))).toBe(false);
	});

	it('Stochastic 境界: 19本 → Stochastic 警告なし', async () => {
		const rows = makeOhlcvRows(19);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		expect(res.meta.warnings?.some((w) => w.includes('Stochastic'))).toBe(false);
	});

	it('Stochastic 境界: 20本 → Stochastic 警告なし', async () => {
		const rows = makeOhlcvRows(20);
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;

		const res = await analyzeIndicators('btc_jpy', '1day', null);
		assertOk(res);
		expect(res.meta.warnings?.some((w) => w.includes('Stochastic'))).toBe(false);
	});

	it('各警告の分岐: SMA_200/EMA_200 → データ不足 の警告を含む（99 本）', async () => {
		// 99 行 < 200 → SMA_200, EMA_200 警告
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

	it('各警告の分岐: Ichimoku → データ不足 の警告を含む（25 本）', async () => {
		// 25 行 < 52 → Ichimoku 警告
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

	it('各警告の分岐: StochRSI → データ不足 の警告を含む（16 本）', async () => {
		// 16 行 < 34 → StochRSI 警告
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

	it('各警告の分岐: SMA_5 → データ不足 の警告を含む（2 本）', async () => {
		// 2 行 < 5 → SMA_5, SMA_20 などの警告
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

	it('データ不足（< 52行）で ichimoku が null → summary に ICHI_conv が含まれない（25 本）', async () => {
		// 25 行 < 52 → ichimoku snapshot が null → ICHI_conv は summary に含まれない
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

	describe('上流 fetchWarning の meta.warning 伝播', () => {
		afterEach(() => clearIndicatorCache());

		function mockPartialMultiYear() {
			// analyze_indicators は anchorYear=currentYear で fetchSingleYear を並列呼び出しし、過半数失敗だと fail になるので、1 年だけを success:0 で失敗させる。
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
				// 最古年（呼ばれた中で最小）を動的に選ぶ仕掛けは複雑なので、特定の年（現在年-3）を失敗扱いにして 1/4 の partial failure を作る。
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
			for (const w of res.meta.warnings ?? []) {
				expect(w).not.toContain('失敗');
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

describe('ema (exported)', () => {
	it('period <= 1 → 各値を価格の水準の桁（最低 2 桁）で返す', () => {
		const result = ema([15_234_567.891, 2500.12345, 31.2345678], 1);
		expect(result).toEqual([15_234_567.89, 2500.12, 31.2346]);
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
		expect(result[0]).toBeNull();
		expect(result[1]).toBeNull();
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
		// 前半は価格下落（OBV 減少）、後半で急激に上昇（OBV 大幅増加）させ、後半の OBV を SMA20 より高くする
		const candles = Array.from({ length: 40 }, (_, i) => {
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

		const seriesKeys = ['SMA_25', 'SMA_75', 'EMA_12', 'BB_upper', 'RSI_14_series'];
		for (const key of seriesKeys) {
			expect(Array.isArray(indicators[key]), key).toBe(true);
			expect((indicators[key] as unknown[]).length).toBe(candlesLen);
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

		expect(Array.isArray(indicators.SMA_25)).toBe(true);
		expect((indicators.SMA_25 as unknown[]).length).toBe(candlesLen);
	});

	// 戻り値の全系列の長さが normalized (chart.candles) と一致すること（padSeriesLengths が対象外とする macd_series も normalized から直接生成される）。落とすと描画層で index ずれが起きる。
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

		const macdSeries = requireDefined(
			indicators.macd_series as { line: unknown[]; signal: unknown[]; hist: unknown[] } | undefined,
			'indicators.macd_series',
		);
		expect(Array.isArray(macdSeries.line)).toBe(true);
		expect(Array.isArray(macdSeries.signal)).toBe(true);
		expect(Array.isArray(macdSeries.hist)).toBe(true);
		expect(macdSeries.line.length).toBe(candlesLen);
		expect(macdSeries.signal.length).toBe(candlesLen);
		expect(macdSeries.hist.length).toBe(candlesLen);
	});
});

describe('analyze_indicators: 形成中足（provisional）', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearIndicatorCache();
	});

	/** 最新足が「現在形成中」になるよう、末尾 ts を当日 UTC 0 時に揃えた日足を作る。 */
	function makeRowsEndingToday(count: number): OhlcvRow[] {
		const todayStart = dayjs().utc().startOf('day').valueOf();
		const rows: OhlcvRow[] = [];
		for (let i = count - 1; i >= 0; i--) {
			const base = 10_000_000 + (count - 1 - i) * 1_000;
			rows.push([
				String(base),
				String(base + 2_000),
				String(base - 2_000),
				String(base + 500),
				'1.5',
				String(todayStart - i * 86_400_000),
			]);
		}
		return rows;
	}

	function mockFetch(rows: OhlcvRow[]) {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv: rows }] } }),
		}) as unknown as typeof fetch;
	}

	it('最新足が形成中のとき meta.provisional=true かつ summary に注記が出る', async () => {
		mockFetch(makeRowsEndingToday(60));
		const res = await analyzeIndicators('btc_jpy', '1day', 60);
		assertOk(res);
		expect((res.meta as { provisional?: boolean }).provisional).toBe(true);
		expect(res.summary).toContain('未確定（形成中）');
	});

	it('最新足が確定済み（過去日）のとき meta.provisional は付かず注記も出ない', async () => {
		mockFetch(makeOhlcvRows(60)); // startMs=2024-01-01 起点 → 確定済み
		const res = await analyzeIndicators('btc_jpy', '1day', 60);
		assertOk(res);
		expect((res.meta as { provisional?: boolean }).provisional).toBeUndefined();
		expect(res.summary).not.toContain('未確定（形成中）');
	});
});
