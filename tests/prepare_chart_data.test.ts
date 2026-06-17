import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../lib/datetime.js';
import { PrepareChartDataOutputSchema } from '../src/schemas.js';
import { clearIndicatorCache } from '../tools/analyze_indicators.js';
import prepareChartData, { toolDef } from '../tools/prepare_chart_data.js';
import { assertFail, assertOk } from './_assertResult.js';

type OhlcvRow = [string, string, string, string, string, string];

function makeOhlcvRows(count: number, intervalMs = 86_400_000): OhlcvRow[] {
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
			String(startMs + i * intervalMs),
		]);
	}
	return rows;
}

function mockFetch(rows: OhlcvRow[], candleType = '1day') {
	vi.spyOn(globalThis, 'fetch').mockResolvedValue({
		ok: true,
		status: 200,
		statusText: 'OK',
		json: async () => ({ success: 1, data: { candlestick: [{ type: candleType, ohlcv: rows }] } }),
	} as Response);
}

describe('prepare_chart_data', () => {
	beforeEach(() => {
		clearIndicatorCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('正常系: コンパクト形式で candles を返す', async () => {
		mockFetch(makeOhlcvRows(600));
		const res = await prepareChartData('btc_jpy', '1day', 100);
		assertOk(res);
		expect(res.data.times).toHaveLength(100);
		expect(res.data.candles).toHaveLength(100);
		expect(res.data.candles[0]).toHaveLength(5);
		expect(res.data.candleFormat).toEqual(['open', 'high', 'low', 'close', 'volume']);
		expect(res.meta.pair).toBe('btc_jpy');
		expect(res.meta.count).toBe(100);
		expect(res.meta.volumeUnit).toBe('BTC');
	});

	it('candle の OHLCV 値が正しい関係を持つ', async () => {
		mockFetch(makeOhlcvRows(600));
		const res = await prepareChartData('btc_jpy', '1day', 100);
		assertOk(res);
		// makeOhlcvRows のパターン: high=open+2000, low=open-2000, close=open+500
		const [o, h, l, c, v] = res.data.candles[0];
		expect(h - o).toBe(2_000);
		expect(o - l).toBe(2_000);
		expect(c - o).toBe(500);
		expect(h).toBeGreaterThan(l); // high > low
		expect(v).toBe(1.5);
	});

	it('indicators 未指定時は series / subPanels を返さない', async () => {
		mockFetch(makeOhlcvRows(600));
		const res = await prepareChartData('btc_jpy', '1day', 100);
		assertOk(res);
		expect(res.data.series).toBeUndefined();
		expect(res.data.subPanels).toBeUndefined();
		expect(res.meta.indicators).toEqual([]);
	});

	it('指標フィルタリング: 指定した指標のみ含まれる', async () => {
		mockFetch(makeOhlcvRows(600));
		const res = await prepareChartData('btc_jpy', '1day', 100, ['SMA_25', 'SMA_75']);
		assertOk(res);
		expect(res.data.series).toHaveProperty('SMA_25');
		expect(res.data.series).toHaveProperty('SMA_75');
		expect(res.data.series).not.toHaveProperty('BB_upper');
		expect(res.data.series).not.toHaveProperty('ICHI_tenkan');
	});

	it('ICHIMOKU 指定時に chikou シフトが適用済み（全 null なら除外）', async () => {
		mockFetch(makeOhlcvRows(600));
		// limit=24 だと chikou は 26 本シフトのため全 null → 除外される
		const res = await prepareChartData('btc_jpy', '1day', 24, ['ICHIMOKU']);
		assertOk(res);
		expect(res.data.series).not.toHaveProperty('ICHI_chikou');
	});

	it('ICHIMOKU 指定時に chikou が部分的に値を持つ場合は含まれる', async () => {
		mockFetch(makeOhlcvRows(600));
		const res = await prepareChartData('btc_jpy', '1day', 60, ['ICHIMOKU']);
		assertOk(res);
		const chikou = res.data.series?.ICHI_chikou;
		expect(chikou).toBeDefined();
		expect(chikou).toHaveLength(res.data.candles.length);
		// 末尾 26 要素は null
		const tail26 = chikou?.slice(-26) ?? [];
		for (const v of tail26) {
			expect(v).toBeNull();
		}
		// 末尾以外に非 null 値が存在する
		const head = chikou?.slice(0, -26) ?? [];
		expect(head.some((v) => v !== null)).toBe(true);
	});

	it('series の各系列長が candles.length と一致する', async () => {
		mockFetch(makeOhlcvRows(600));
		const res = await prepareChartData('btc_jpy', '1day', 50, ['SMA_20', 'BB']);
		assertOk(res);
		const candleLen = res.data.candles.length;
		for (const [, arr] of Object.entries(res.data.series ?? {})) {
			expect(arr).toHaveLength(candleLen);
		}
	});

	it('RSI/MACD/STOCH がサブパネルに含まれ構造が正しい', async () => {
		mockFetch(makeOhlcvRows(600));
		const res = await prepareChartData('btc_jpy', '1day', 100, ['RSI', 'MACD', 'STOCH']);
		assertOk(res);
		const candleLen = res.data.candles.length;

		// RSI
		expect(res.data.subPanels?.RSI_14).toBeDefined();
		expect(res.data.subPanels?.RSI_14).toHaveLength(candleLen);

		// MACD — line, signal, hist すべて存在し長さが一致
		expect(res.data.subPanels?.MACD).toBeDefined();
		expect(res.data.subPanels?.MACD?.line).toHaveLength(candleLen);
		expect(res.data.subPanels?.MACD?.signal).toHaveLength(candleLen);
		expect(res.data.subPanels?.MACD?.hist).toHaveLength(candleLen);

		// STOCH
		expect(res.data.subPanels?.STOCH_K).toBeDefined();
		expect(res.data.subPanels?.STOCH_K).toHaveLength(candleLen);
		expect(res.data.subPanels?.STOCH_D).toBeDefined();
		expect(res.data.subPanels?.STOCH_D).toHaveLength(candleLen);

		// メインパネルの series には含まれない
		expect(res.data.series ?? {}).not.toHaveProperty('RSI_14');
	});

	it('JPY ペアの candle 値は整数に丸められる', async () => {
		mockFetch(makeOhlcvRows(600));
		const res = await prepareChartData('btc_jpy', '1day', 10);
		assertOk(res);
		for (const [o, h, l, c] of res.data.candles) {
			expect(Number.isInteger(o)).toBe(true);
			expect(Number.isInteger(h)).toBe(true);
			expect(Number.isInteger(l)).toBe(true);
			expect(Number.isInteger(c)).toBe(true);
		}
	});

	it('JPY ペアの indicator 値も整数に丸められる', async () => {
		mockFetch(makeOhlcvRows(600));
		const res = await prepareChartData('btc_jpy', '1day', 100, ['SMA_20']);
		assertOk(res);
		const sma = res.data.series?.SMA_20;
		expect(sma).toBeDefined();
		for (const v of sma ?? []) {
			if (v !== null) {
				expect(Number.isInteger(v)).toBe(true);
			}
		}
	});

	it('全 null 系列はレスポンスから除外される', async () => {
		mockFetch(makeOhlcvRows(600));
		const res = await prepareChartData('btc_jpy', '1day', 24, ['ICHIMOKU']);
		assertOk(res);
		for (const [, arr] of Object.entries(res.data.series ?? {})) {
			const hasValue = arr.some((v: number | null) => v !== null);
			expect(hasValue).toBe(true);
		}
	});

	it('meta.indicators に返却された指標名が含まれる', async () => {
		mockFetch(makeOhlcvRows(600));
		const res = await prepareChartData('btc_jpy', '1day', 100, ['SMA_20', 'RSI']);
		assertOk(res);
		expect(res.meta.indicators).toContain('SMA_20');
		expect(res.meta.indicators).toContain('RSI_14');
	});

	it('limit × indicators 数がしきい値を超える場合 limit が自動切り詰めされる', async () => {
		mockFetch(makeOhlcvRows(600));
		const indicators = ['SMA_25', 'SMA_75', 'BB', 'RSI', 'MACD'];
		// MAX_TOTAL_SERIES=150, seriesMultiplier=1+5=6
		// effectiveLimit = max(5, floor(150/6)) = 25
		const res = await prepareChartData('btc_jpy', '1day', 90, indicators);
		assertOk(res);
		expect(res.data.candles.length).toBe(25);
		// summary 先頭に独立した ⚠️ 行として出る（インライン連結ではない）
		expect(res.summary.startsWith('⚠️ limit was capped from 90 to 25')).toBe(true);
		// meta.warning に programmatic に露出している
		expect(res.meta.warning).toBeDefined();
		expect(res.meta.warning).toContain('limit was capped from 90 to 25');
	});

	it('truncation 発生時 handler content[0].text の先頭に ⚠️ 行として出る', async () => {
		mockFetch(makeOhlcvRows(600));
		const handlerRes = (await toolDef.handler({
			pair: 'btc_jpy',
			type: '1day',
			limit: 90,
			indicators: ['SMA_25', 'SMA_75', 'BB', 'RSI', 'MACD'],
		})) as { content: Array<{ text: string }> };
		const text = handlerRes.content[0].text;
		expect(text.startsWith('⚠️ limit was capped from 90 to 25')).toBe(true);
		// JSON 本体より前に warning が出る
		const idxWarning = text.indexOf('⚠️');
		const idxJson = text.indexOf('"times"');
		expect(idxWarning).toBeLessThan(idxJson);
		expect(idxWarning).toBeGreaterThanOrEqual(0);
	});

	it('limit が十分小さければ切り詰めが発生しない', async () => {
		mockFetch(makeOhlcvRows(600));
		const res = await prepareChartData('btc_jpy', '1day', 20, ['SMA_25', 'SMA_75']);
		assertOk(res);
		// 20 * 3 = 60 < 150 → 切り詰め不要
		expect(res.data.candles.length).toBe(20);
		expect(res.summary).not.toContain('limit was capped');
	});

	it('不正な pair で fail を返す', async () => {
		const res = await prepareChartData('invalid', '1day', 100);
		assertFail(res);
	});

	it('API エラー時に fail を返す', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
		const res = await prepareChartData('btc_jpy', '1day', 100);
		assertFail(res);
	});

	it('limit でデータ点数を制限する', async () => {
		mockFetch(makeOhlcvRows(600));
		const res = await prepareChartData('btc_jpy', '1day', 30);
		assertOk(res);
		expect(res.data.candles.length).toBeLessThanOrEqual(30);
	});

	it('デフォルト（Asia/Tokyo）で times がローカル時刻に変換される', async () => {
		mockFetch(makeOhlcvRows(600));
		const res = await prepareChartData('btc_jpy', '1day', 10);
		assertOk(res);
		// times はローカル ISO 形式（Z なし）
		expect(res.data.times[0]).not.toMatch(/Z$/);
		expect(res.data.times[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
		// makeOhlcvRows の末尾 10 本: i=590, timestamp = UTC 2024-01-01 + 590 日
		// 先頭 = UTC 2025-08-14T00:00:00 → Asia/Tokyo = 2025-08-14T09:00:00
		expect(res.data.times[0]).toContain('T09:00:00');
	});

	it('日足の labels は MM/DD 形式', async () => {
		mockFetch(makeOhlcvRows(600));
		const res = await prepareChartData('btc_jpy', '1day', 10);
		assertOk(res);
		expect(res.data.labels).toBeDefined();
		expect(res.data.labels).toHaveLength(10);
		expect(res.data.labels?.[0]).toMatch(/^\d{2}\/\d{2}$/);
	});

	it('tz="" 指定時は times が UTC、labels なし', async () => {
		mockFetch(makeOhlcvRows(600));
		const res = await prepareChartData('btc_jpy', '1day', 10, undefined, '');
		assertOk(res);
		expect(res.data.times[0]).toMatch(/Z$/);
		expect(res.data.labels).toBeUndefined();
	});

	it('時間足の labels は MM/DD HH:mm 形式', async () => {
		mockFetch(makeOhlcvRows(600, 3_600_000));
		const res = await prepareChartData('btc_jpy', '1hour', 10, undefined, 'Asia/Tokyo');
		assertOk(res);
		expect(res.data.labels).toBeDefined();
		expect(res.data.labels?.[0]).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
	});

	it('メインパネルとサブパネルの指標を同時指定しても干渉しない', async () => {
		mockFetch(makeOhlcvRows(600));
		const res = await prepareChartData('btc_jpy', '1day', 50, ['BB', 'ICHIMOKU', 'RSI', 'STOCH']);
		assertOk(res);
		const candleLen = res.data.candles.length;

		// メインパネル: BB + ICHIMOKU
		expect(res.data.series).toHaveProperty('BB_upper');
		expect(res.data.series).toHaveProperty('BB_middle');
		expect(res.data.series).toHaveProperty('BB_lower');
		expect(res.data.series).toHaveProperty('ICHI_tenkan');
		expect(res.data.series).toHaveProperty('ICHI_kijun');
		for (const [, arr] of Object.entries(res.data.series ?? {})) {
			expect(arr).toHaveLength(candleLen);
		}

		// サブパネル: RSI + STOCH
		expect(res.data.subPanels?.RSI_14).toHaveLength(candleLen);
		expect(res.data.subPanels?.STOCH_K).toHaveLength(candleLen);
		expect(res.data.subPanels?.STOCH_D).toHaveLength(candleLen);

		// meta.indicators にすべて含まれる
		for (const name of ['BB_upper', 'BB_middle', 'BB_lower', 'ICHI_tenkan', 'RSI_14', 'STOCH_K', 'STOCH_D']) {
			expect(res.meta.indicators).toContain(name);
		}
	});

	// ── 上流 fetchWarning / 指標不足 warnings の伝播 ──

	describe('上流 warning の伝播', () => {
		function mockPartialMultiYearFetch() {
			// analyze_indicators → getCandles は anchorYear=currentYear で multi-year 取得する。
			// limit=1100 で fetchCount=1299、yearsNeeded=4。最古年だけ success:0 で失敗させる。
			const currentYear = dayjs.utc().year();
			const failYear = currentYear - 3;
			const baseTs = dayjs.utc(`${currentYear - 1}-01-01`).valueOf();
			const validRows = Array.from({ length: 365 }, (_, i) => [
				'100',
				'110',
				'90',
				'105',
				'1.0',
				String(baseTs + i * 86_400_000),
			]);
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
				const urlStr = String(url);
				const match = urlStr.match(/\/(\d{4})$/);
				const year = match ? Number(match[1]) : Number.NaN;
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
		}

		it('部分失敗時、meta.warning と summary 先頭に上流警告が出る', async () => {
			mockPartialMultiYearFetch();
			// limit=1100 で analyze_indicators → multi-year（4年取得）が走る。
			// pair を変えてキャッシュ衝突を避ける。
			const res = await prepareChartData('bcc_jpy', '1day', 1100, undefined);
			assertOk(res);
			// summary 先頭に警告が出る
			expect(res.summary.startsWith('⚠️')).toBe(true);
			expect(res.meta.warning).toBeDefined();
			expect(res.meta.warning).toContain('失敗');
		});

		it('handler content[0].text の先頭に上流警告が出る', async () => {
			mockPartialMultiYearFetch();
			// pair を変えてキャッシュ衝突を避ける
			const res = await toolDef.handler({ pair: 'eth_jpy', type: '1day', limit: 1100 });
			// biome-ignore lint/suspicious/noExplicitAny: handler returns McpResponse
			const r = res as any;
			expect(r.content?.[0]?.text).toBeDefined();
			const text: string = r.content[0].text;
			// 先頭が warning 行
			expect(text.startsWith('⚠️')).toBe(true);
			// 上流 warning が出る
			expect(text).toContain('失敗');
			// JSON 本体より前に warning が出る
			const idxWarning = text.indexOf('⚠️');
			const idxJson = text.indexOf('"times"');
			expect(idxWarning).toBeLessThan(idxJson);
		});

		it('upstream warning が無い正常系では summary は通常通り', async () => {
			mockFetch(makeOhlcvRows(600));
			const res = await prepareChartData('xrp_jpy', '1day', 50);
			assertOk(res);
			expect(res.meta.warning).toBeUndefined();
			expect(res.summary.startsWith('⚠️')).toBe(false);
		});

		it('指標不足 warnings のみがある場合 summary に連結される', async () => {
			// 少ないデータで SMA_200 等の警告を発生させる（取得は成功するので fetchWarning なし）
			mockFetch(makeOhlcvRows(40));
			const res = await prepareChartData('mona_jpy', '1day', 30);
			assertOk(res);
			// fetchWarning（取得層）はない
			expect(res.meta.warning).toBeUndefined();
			// 指標不足の warnings は存在する
			expect(res.meta.warnings).toBeDefined();
			expect((res.meta.warnings ?? []).length).toBeGreaterThan(0);
			// summary 先頭は ⚠️ で始まる（warnings 由来）
			expect(res.summary.startsWith('⚠️')).toBe(true);
		});
	});

	// ─── 加工契約テスト（PR4）─────────────────────────────────
	//
	// prepare_chart_data の入出力契約を補強する。
	// - times は単調増加（昇順）であること
	// - 上流 warning は summary / content[0].text の先頭に伝播すること
	// - 入力 OHLCV の先頭行が、出力 candles[0] に正しく対応すること
	//
	// 1day は yearly type で analyze_indicators の fetchCount=limit+199 が当年経過日数を
	// 超えると multi-year (current + previous year) 取得が走る。単純な mockFetch だと
	// 両年で同じ ts を返してしまうため、ここでは年ごとに distinct な ts を返す
	// mockImplementation を使う。

	describe('加工契約', () => {
		/** 年ごとに distinct な timestamp の rows を返す mock（multi-year 取得に耐える） */
		function mockMultiYearDistinctFetch(rowsPerYear: number = 365) {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
				const urlStr = String(url);
				const m = urlStr.match(/\/(\d{4})$/);
				const year = m ? Number(m[1]) : dayjs.utc().year();
				const baseTs = dayjs.utc(`${year}-01-01`).valueOf();
				const intervalMs = 86_400_000;
				const ohlcv: OhlcvRow[] = [];
				for (let i = 0; i < rowsPerYear; i++) {
					const base = 10_000_000 + (year - 2024) * 1_000_000 + i * 1_000;
					ohlcv.push([
						String(base),
						String(base + 2_000),
						String(base - 2_000),
						String(base + 500),
						'1.5',
						String(baseTs + i * intervalMs),
					]);
				}
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					json: async () => ({ success: 1, data: { candlestick: [{ type: '1day', ohlcv }] } }),
				} as Response;
			});
		}

		it('times は単調増加である（multi-year fetch を考慮し distinct な ts を供給）', async () => {
			mockMultiYearDistinctFetch();
			const res = await prepareChartData('btc_jpy', '1day', 100, undefined, '');
			assertOk(res);
			expect(res.data.times.length).toBe(100);
			// times は UTC ISO 文字列なので辞書順比較で時系列順を判定できる
			for (let i = 1; i < res.data.times.length; i++) {
				expect(res.data.times[i] > res.data.times[i - 1]).toBe(true);
			}
		});

		it('times は tz 指定時もローカル ISO で単調増加（ms 換算で検証）', async () => {
			mockMultiYearDistinctFetch();
			const res = await prepareChartData('btc_jpy', '1day', 60, undefined, 'Asia/Tokyo');
			assertOk(res);
			expect(res.data.times.length).toBe(60);
			const msArr = res.data.times.map((t) => dayjs(t).valueOf());
			for (let i = 1; i < msArr.length; i++) {
				expect(msArr[i]).toBeGreaterThan(msArr[i - 1]);
			}
		});

		it('上流 warning は summary 先頭 / handler content[0].text 先頭の両方に伝播する', async () => {
			// 少ないデータで指標不足 warnings を発生させる（取得は成功するので fetchWarning なし）
			mockFetch(makeOhlcvRows(40));
			const res = await prepareChartData('xlm_jpy', '1day', 30);
			assertOk(res);
			// summary 先頭に warning
			expect(res.summary.startsWith('⚠️')).toBe(true);
			// handler 経由でも content[0].text 先頭に warning が伝播する
			mockFetch(makeOhlcvRows(40));
			const handlerRes = (await toolDef.handler({ pair: 'xlm_jpy', type: '1day', limit: 30 })) as {
				content: Array<{ text: string }>;
			};
			const text = handlerRes.content[0].text;
			expect(text.startsWith('⚠️')).toBe(true);
			// warning は JSON 本体より前に出る
			const idxWarning = text.indexOf('⚠️');
			const idxJson = text.indexOf('"times"');
			expect(idxWarning).toBeLessThan(idxJson);
			expect(idxWarning).toBeGreaterThanOrEqual(0);
		});

		it('入力 OHLCV の先頭行と candles[0] / times[0] が対応する', async () => {
			// times[0] を元に元データの (year, dayOfYear) を逆算し、入力 ohlcv と candles[0] を比較する。
			// multi-year fetch を伴うため、times[0] から逆算するアプローチが頑健。
			mockMultiYearDistinctFetch();
			const res = await prepareChartData('btc_jpy', '1day', 100, undefined, '');
			assertOk(res);
			expect(res.data.candles.length).toBe(100);

			const ts0 = dayjs.utc(res.data.times[0]).valueOf();
			const year0 = dayjs.utc(ts0).year();
			const yearStart = dayjs.utc(`${year0}-01-01`).valueOf();
			const dayIdx = Math.round((ts0 - yearStart) / 86_400_000);
			expect(dayIdx).toBeGreaterThanOrEqual(0);

			// mockMultiYearDistinctFetch の式と一致させる
			const expectedBase = 10_000_000 + (year0 - 2024) * 1_000_000 + dayIdx * 1_000;
			const expectedO = expectedBase; // JPY ペアは整数丸めだが、入力既に整数なので一致
			const expectedH = expectedBase + 2_000;
			const expectedL = expectedBase - 2_000;
			const expectedC = expectedBase + 500;
			const expectedV = 1.5;

			const [o, h, l, c, v] = res.data.candles[0];
			expect(o).toBe(expectedO);
			expect(h).toBe(expectedH);
			expect(l).toBe(expectedL);
			expect(c).toBe(expectedC);
			expect(v).toBe(expectedV);
		});
	});

	// ─── wire 出力の schema 検証（PrepareChartDataOutputSchema）─────────────
	//
	// prepare_chart_data は最終 ok() を parseAsResult で schema 検証して返す
	// （prepare_depth_data:206 / get_candles と同じ経路。以前は ok() 素返しで未検証だった）。
	// ここでは market_data_audit.test.ts §3 の assertRoundTrip パターンで、
	// JSON.stringify→parse 後の wire 形式でも schema を通過し意味が壊れないことを固定する。
	describe('wire 出力 schema 検証 (JSON round-trip)', () => {
		type ParsedPrepareChartData = ReturnType<typeof PrepareChartDataOutputSchema.parse>;

		// wire（JSON 往復後）を schema に通し、parse 結果（strip/transform 適用後）で意味不変を検証する。
		// 生の wire ではなく parsed に対して invariants を評価することで、parse 時の strip も検出できる。
		function assertRoundTrip(res: unknown, invariants: (parsed: ParsedPrepareChartData) => void) {
			const wire = JSON.parse(JSON.stringify(res));
			const parsed = PrepareChartDataOutputSchema.parse(wire); // schema 違反なら throw → テスト失敗
			invariants(parsed);
		}

		it('candles のみ: roundtrip 後も schema parse 成功 + summary/candles/times/meta 不変', async () => {
			mockFetch(makeOhlcvRows(600));
			const res = await prepareChartData('btc_jpy', '1day', 30);
			assertOk(res);
			assertRoundTrip(res, (v) => {
				expect(v.ok).toBe(true);
				expect(v.summary).toBe(res.summary);
				expect(v.data.candles).toHaveLength(res.data.candles.length);
				expect(v.data.times).toHaveLength(res.data.times.length);
				expect(v.data.candleFormat).toEqual(['open', 'high', 'low', 'close', 'volume']);
				expect(v.meta.pair).toBe('btc_jpy');
				expect(v.meta.count).toBe(res.data.candles.length);
				expect(v.meta.volumeUnit).toBe('BTC');
			});
		});

		it('series + subPanels: roundtrip 後も schema parse 成功 + 指標系列長が保持される', async () => {
			mockFetch(makeOhlcvRows(600));
			const res = await prepareChartData('btc_jpy', '1day', 50, ['SMA_20', 'BB', 'RSI', 'MACD']);
			assertOk(res);
			assertRoundTrip(res, (v) => {
				expect(Object.keys(v.data.series ?? {}).length).toBeGreaterThan(0);
				expect(v.data.series?.SMA_20).toHaveLength(v.data.candles.length);
				expect(v.data.subPanels?.RSI_14).toHaveLength(v.data.candles.length);
				expect(v.data.subPanels?.MACD?.line).toHaveLength(v.data.candles.length);
			});
		});

		it('指標不足 warnings が wire（meta.warnings）でも保持される（schema strip されない）', async () => {
			// 少データで SMA_200 等の指標不足警告を発生させ、schema 検証後も meta.warnings が
			// 残ることを固定する（schema meta に warnings を含めた回帰防止）。
			mockFetch(makeOhlcvRows(40));
			const res = await prepareChartData('mona_jpy', '1day', 30);
			assertOk(res);
			expect((res.meta.warnings ?? []).length).toBeGreaterThan(0);
			assertRoundTrip(res, (v) => {
				expect(Array.isArray(v.meta.warnings)).toBe(true);
				expect((v.meta.warnings ?? []).length).toBeGreaterThan(0);
				expect(v.meta.warnings).toEqual(res.meta.warnings);
			});
		});
	});
});
