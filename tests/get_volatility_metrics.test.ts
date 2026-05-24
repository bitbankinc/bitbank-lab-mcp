import { afterEach, describe, expect, it, vi } from 'vitest';
import getVolatilityMetrics from '../tools/get_volatility_metrics.js';
import { assertOk } from './_assertResult.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

// --- helpers -----------------------------------------------------------

/** OHLCV row: [open, high, low, close, volume, timestamp_ms] */
type OhlcvRow = [number, number, number, number, number, number];

function makeOhlcvRows(
	count: number,
	opts?: {
		baseClose?: number;
		drift?: number;
		noise?: number;
		flat?: boolean;
	},
): OhlcvRow[] {
	const base = opts?.baseClose ?? 10_000_000;
	const drift = opts?.drift ?? 0;
	const noise = opts?.noise ?? 0.02;
	const flat = opts?.flat ?? false;
	const startMs = Date.UTC(2025, 0, 1);
	const rows: OhlcvRow[] = [];
	let prev = base;
	for (let i = 0; i < count; i++) {
		const ts = startMs + i * 86_400_000;
		const change = flat ? 0 : drift + Math.sin(i * 0.5) * noise;
		const close = prev * (1 + change);
		const high = close * (1 + Math.abs(noise) * 0.5);
		const low = close * (1 - Math.abs(noise) * 0.5);
		const open = prev;
		rows.push([open, high, low, close, 100 + i, ts]);
		prev = close;
	}
	return rows;
}

function mockFetchWithOhlcv(rows: OhlcvRow[]) {
	globalThis.fetch = vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		json: async () => ({
			success: 1,
			data: { candlestick: [{ type: '1day', ohlcv: rows }] },
		}),
	});
}

// --- tests -------------------------------------------------------------

describe('get_volatility_metrics', () => {
	// === 1. Input validation =============================================

	describe('入力バリデーション', () => {
		it('不正な pair → ok: false', async () => {
			const res = await getVolatilityMetrics('INVALID!!!', '1day', 30);
			expect(res.ok).toBe(false);
		});

		it('limit < 20 → ok: false', async () => {
			const res = await getVolatilityMetrics('btc_jpy', '1day', 10);
			expect(res.ok).toBe(false);
		});

		it('limit > 500 → ok: false', async () => {
			const res = await getVolatilityMetrics('btc_jpy', '1day', 999);
			expect(res.ok).toBe(false);
		});
	});

	// === 2. Happy path ===================================================

	describe('正常系（30本、annualize=true）', () => {
		const rows = makeOhlcvRows(30);

		it('ok: true で全必須フィールドを含む', async () => {
			mockFetchWithOhlcv(rows);
			const res = await getVolatilityMetrics('btc_jpy', '1day', 30);
			assertOk(res);

			const d = res.data;
			expect(d.meta.pair).toBe('btc_jpy');
			expect(d.meta.sampleSize).toBe(30);
			expect(d.meta.annualize).toBe(true);
			expect(d.meta.useLogReturns).toBe(true);
			expect(d.meta.source).toBe('bitbank:candlestick');

			expect(d.aggregates).toHaveProperty('rv_std');
			expect(d.aggregates).toHaveProperty('rv_std_ann');
			expect(d.aggregates).toHaveProperty('parkinson');
			expect(d.aggregates).toHaveProperty('garmanKlass');
			expect(d.aggregates).toHaveProperty('rogersSatchell');
			expect(d.aggregates).toHaveProperty('atr');

			expect(d.rolling.length).toBe(3);
			expect(d.series.ts.length).toBe(30);
			expect(d.series.close.length).toBe(30);
			expect(d.series.ret.length).toBe(29);
		});

		it('rv_std_ann = rv_std * sqrt(periodsPerYear) が成り立つ', async () => {
			mockFetchWithOhlcv(rows);
			const res = await getVolatilityMetrics('btc_jpy', '1day', 30);
			assertOk(res);
			const a = res.data.aggregates;
			const expected = a.rv_std * Math.sqrt(365);
			expect(a.rv_std_ann).toBeCloseTo(expected, 6);
		});

		it('rolling の rv_std_ann も同様に検算できる', async () => {
			mockFetchWithOhlcv(rows);
			const res = await getVolatilityMetrics('btc_jpy', '1day', 30);
			assertOk(res);
			for (const r of res.data.rolling) {
				if (r.rv_std_ann != null) {
					expect(r.rv_std_ann).toBeCloseTo(r.rv_std * Math.sqrt(365), 6);
				}
			}
		});
	});

	// === 3. annualize: false =============================================

	describe('annualize: false', () => {
		const rows = makeOhlcvRows(30);

		it('rv_std_ann が undefined になる', async () => {
			mockFetchWithOhlcv(rows);
			const res = await getVolatilityMetrics('btc_jpy', '1day', 30, [14, 20], { annualize: false });
			assertOk(res);
			expect(res.data.aggregates.rv_std_ann).toBeUndefined();
			expect(res.data.meta.annualize).toBe(false);
		});

		it('rolling でも rv_std_ann が undefined になる', async () => {
			mockFetchWithOhlcv(rows);
			const res = await getVolatilityMetrics('btc_jpy', '1day', 30, [14, 20], { annualize: false });
			assertOk(res);
			for (const r of res.data.rolling) {
				expect(r.rv_std_ann).toBeUndefined();
			}
		});
	});

	// === 4. Edge cases ===================================================

	describe('エッジケース', () => {
		it('ちょうど 20 本（最小）で ok: true', async () => {
			const rows = makeOhlcvRows(20);
			mockFetchWithOhlcv(rows);
			const res = await getVolatilityMetrics('btc_jpy', '1day', 20);
			assertOk(res);
			expect(res.data.series.ret.length).toBe(19);
		});

		it('19 本しか返らない場合 → ok: false（データ不足）', async () => {
			const rows = makeOhlcvRows(19);
			mockFetchWithOhlcv(rows);
			const res = await getVolatilityMetrics('btc_jpy', '1day', 30);
			expect(res.ok).toBe(false);
		});

		it('全ローソク足が同一価格 → rv_std ≒ 0', async () => {
			const rows = makeOhlcvRows(30, { flat: true });
			mockFetchWithOhlcv(rows);
			const res = await getVolatilityMetrics('btc_jpy', '1day', 30);
			assertOk(res);
			expect(res.data.aggregates.rv_std).toBeCloseTo(0, 6);
		});

		it('window がデータ長を超える場合、rolling から除外される', async () => {
			const rows = makeOhlcvRows(25);
			mockFetchWithOhlcv(rows);
			const res = await getVolatilityMetrics('btc_jpy', '1day', 25, [14, 20, 100]);
			assertOk(res);
			const windowsInResult = res.data.rolling.map((r) => r.window);
			expect(windowsInResult).not.toContain(100);
		});
	});

	// === 5. Parkinson estimator correctness ==============================

	describe('Parkinson estimator', () => {
		it('全ローソク足の H/L 比から Parkinson が手計算と一致する', async () => {
			const rows: OhlcvRow[] = [];
			const startMs = Date.UTC(2025, 0, 1);
			for (let i = 0; i < 30; i++) {
				const base = 10_000_000;
				const high = base * 1.02;
				const low = base * 0.98;
				rows.push([base, high, low, base, 100, startMs + i * 86_400_000]);
			}
			mockFetchWithOhlcv(rows);
			const res = await getVolatilityMetrics('btc_jpy', '1day', 30, [14], { annualize: false });
			assertOk(res);

			const logHL = Math.log(1.02 / 0.98);
			const pkPerCandle = logHL * logHL;
			const expectedParkinson = Math.sqrt(pkPerCandle / (4 * Math.log(2)));

			expect(res.data.aggregates.parkinson).toBeCloseTo(expectedParkinson, 6);
		});
	});

	// === 6. ATR correctness ==============================================

	describe('ATR', () => {
		it('ATR > 0 かつ合理的な範囲', async () => {
			const rows = makeOhlcvRows(30);
			mockFetchWithOhlcv(rows);
			const res = await getVolatilityMetrics('btc_jpy', '1day', 30);
			assertOk(res);
			expect(res.data.aggregates.atr).toBeGreaterThan(0);
		});

		it('flat データ → ATR ≒ 0', async () => {
			const rows = makeOhlcvRows(30, { flat: true, noise: 0 });
			mockFetchWithOhlcv(rows);
			const res = await getVolatilityMetrics('btc_jpy', '1day', 30);
			assertOk(res);
			expect(res.data.aggregates.atr).toBeCloseTo(0, 2);
		});

		// 数値契約: aggregate ATR は Wilder ATR (RMA ベース、period=14 固定) と一致する。
		// 初回値 = SMA(TR[1..14])、以降は ATR_n = (ATR_{n-1} * 13 + TR_n) / 14。
		// TradingView・MT4 デフォルトの ATR と同じ。
		it('aggregate ATR は手計算した Wilder ATR (period=14 固定) と一致する', async () => {
			const rows = makeOhlcvRows(60);
			mockFetchWithOhlcv(rows);
			const res = await getVolatilityMetrics('btc_jpy', '1day', 60, [14]);
			assertOk(res);

			// rows: [open, high, low, close, volume, ts]（古い順）
			const highs = rows.map((r) => r[1]);
			const lows = rows.map((r) => r[2]);
			const closes = rows.map((r) => r[3]);
			const period = 14;
			const n = highs.length;

			// 手計算 TR[i] for i >= 1
			const tr: number[] = [];
			for (let i = 1; i < n; i++) {
				tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
			}
			// シード: SMA(TR[1..14])
			let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
			// 以降は Wilder の RMA 漸化式
			for (let i = period; i < tr.length; i++) {
				atr = (atr * (period - 1) + tr[i]) / period;
			}

			expect(res.data.aggregates.atr).toBeCloseTo(atr, 6);
		});

		// 数値契約: aggregate ATR は windows[0] の影響を受けず常に period=14。
		it('aggregate ATR は windows[0] に関わらず period=14 固定', async () => {
			const rows = makeOhlcvRows(60);
			mockFetchWithOhlcv(rows);
			const res14 = await getVolatilityMetrics('btc_jpy', '1day', 60, [14, 20, 30]);
			assertOk(res14);
			mockFetchWithOhlcv(rows);
			const res20 = await getVolatilityMetrics('btc_jpy', '1day', 60, [20, 30]);
			assertOk(res20);
			expect(res14.data.aggregates.atr).toBeCloseTo(res20.data.aggregates.atr, 8);
		});

		// 回帰テスト: rolling[].atr は削除済み（aggregates.atr の Wilder ATR を使う）
		it('rolling 各要素に atr フィールドが含まれない', async () => {
			const rows = makeOhlcvRows(60);
			mockFetchWithOhlcv(rows);
			const res = await getVolatilityMetrics('btc_jpy', '1day', 60, [14, 20, 30]);
			assertOk(res);
			for (const r of res.data.rolling) {
				expect(r).not.toHaveProperty('atr');
			}
		});
	});

	// === 7. Tags =========================================================

	describe('タグ生成', () => {
		it('高ボラ時に volatile タグが付与される', async () => {
			const rows = makeOhlcvRows(30, { noise: 0.15 });
			mockFetchWithOhlcv(rows);
			const res = await getVolatilityMetrics('btc_jpy', '1day', 30);
			assertOk(res);
			if (res.data.aggregates!.rv_std_ann! >= 0.8) {
				expect(res.data.tags).toContain('volatile');
			}
		});

		it('calm タグの閾値は 0.3 以下（tool 側）', async () => {
			const rows = makeOhlcvRows(200, { noise: 0.001 });
			mockFetchWithOhlcv(rows);
			const res = await getVolatilityMetrics('btc_jpy', '1day', 200, [14, 20, 30], { annualize: true });
			assertOk(res);
			const rvAnn = res.data.aggregates!.rv_std_ann;
			if (rvAnn! <= 0.3) {
				expect(res.data.tags).toContain('calm');
			} else {
				expect(res.data.tags).not.toContain('calm');
			}
		});
	});

	// === 8. Network error ================================================

	describe('ネットワークエラー', () => {
		it('fetch 失敗 → ok: false', async () => {
			globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
			const res = await getVolatilityMetrics('btc_jpy', '1day', 30);
			expect(res.ok).toBe(false);
		});
	});

	// === 9. Handler tag threshold with annualize=false ===================
	//    Handler (getVolatilityMetricsHandler) applies fixed thresholds
	//    (0.5 for high_vol, 0.2 for low_vol) to rv values.
	//    When annualize=false, per-period rv (~0.01-0.05 for daily) will
	//    ALWAYS be below 0.2, making low_vol tag always appear.
	//    This test documents the issue by calling the handler directly.

	describe('Handler タグ閾値の annualize=false 問題', () => {
		it('annualize=false の per-period RV は常に handler 閾値 0.2 未満になる', async () => {
			const rows = makeOhlcvRows(60, { noise: 0.05 });
			mockFetchWithOhlcv(rows);
			const res = await getVolatilityMetrics('btc_jpy', '1day', 60, [14, 20, 30], { annualize: false });
			assertOk(res);
			const rvStd = res.data.aggregates.rv_std;
			// per-period daily RV is typically 0.01-0.05, far below handler threshold 0.2
			expect(rvStd).toBeLessThan(0.2);
			// This means the handler would ALWAYS add 'low_vol' tag for non-annualized data
			// even when volatility is objectively high.
		});
	});

	// === 10. sampleSize / meta.warning の数値契約 ========================
	//   data.meta.sampleSize は close.length（スキップ後の実計算本数）と一致する。
	//   正常時は警告無し、合成タイムスタンプ（Date.now()）も埋め込まれない。
	//   不正 OHLC / isoTime 欠損 / 上流 fetchWarning の伝播は
	//   get_volatility_metrics.warnings.test.ts で get_candles を mock してテストする。

	describe('sampleSize の数値契約', () => {
		it('正常時は data.meta.sampleSize === data.series.close.length（スキップ無し）', async () => {
			const rows = makeOhlcvRows(30);
			mockFetchWithOhlcv(rows);
			const res = await getVolatilityMetrics('btc_jpy', '1day', 30);
			assertOk(res);
			expect(res.data.meta.sampleSize).toBe(res.data.series.close.length);
			expect(res.data.meta.sampleSize).toBe(30);
			// 警告は無し
			expect((res.meta as { warning?: string }).warning).toBeUndefined();
		});

		it('全件正常なら ts 配列に Date.now() 由来の値は含まれない', async () => {
			const rows = makeOhlcvRows(25);
			mockFetchWithOhlcv(rows);
			const before = Date.now();
			const res = await getVolatilityMetrics('btc_jpy', '1day', 25);
			assertOk(res);
			// 全ての ts は 2025 年起点（Date.now() が混入しない）
			for (const t of res.data.series.ts) {
				expect(t).toBeLessThan(before);
			}
		});
	});
});
