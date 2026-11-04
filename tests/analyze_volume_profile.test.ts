import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../lib/datetime.js';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';
import { requireDefined } from './helpers/assert.js';

vi.mock('../tools/get_transactions.js', () => ({
	default: vi.fn(),
}));

import analyzeVolumeProfile, { toolDef } from '../tools/analyze_volume_profile.js';
import getTransactions from '../tools/get_transactions.js';

type MockTx = {
	price: number;
	amount: number;
	side: 'buy' | 'sell';
	timestampMs: number;
	isoTime: string;
};

function buildTxs(prices: number[], amounts?: number[]): MockTx[] {
	const baseMs = Date.UTC(2024, 0, 1, 0, 0, 0);
	return prices.map((price, i) => ({
		price,
		amount: amounts?.[i] ?? i + 1,
		side: i % 2 === 0 ? 'buy' : 'sell',
		timestampMs: baseMs + i * 60_000,
		isoTime: dayjs(baseMs + i * 60_000).toISOString(),
	}));
}

function mockTxResult(txs: MockTx[]) {
	return {
		ok: true,
		summary: 'ok',
		data: { normalized: txs },
		meta: { count: txs.length },
	};
}

function mockFailResult(errorType = 'network', summary = 'network failed') {
	return {
		ok: false,
		summary,
		data: {},
		meta: { errorType },
	};
}

describe('analyze_volume_profile', () => {
	const mockedGetTransactions = vi.mocked(getTransactions);

	it('価格帯の幅が呼び値より細かくても、隣の価格帯と同じ数字にしない', async () => {
		const prices = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 31.2345 : 31.2346));
		mockedGetTransactions.mockResolvedValue(asMockResult(mockTxResult(buildTxs(prices))));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 20, 0.7);

		assertOk(res);
		const bins = res.data.profile.bins;
		expect(new Set(bins.map((b) => b.low)).size).toBe(bins.length);
		expect(new Set(bins.map((b) => b.label)).size).toBe(bins.length);
	});

	it('σ が呼び値より小さくても構造化データで 0 にしない', async () => {
		const prices = [...Array.from({ length: 9 }, () => 31.2345), 31.2346];
		mockedGetTransactions.mockResolvedValue(
			asMockResult(
				mockTxResult(
					buildTxs(
						prices,
						Array.from({ length: 10 }, () => 1),
					),
				),
			),
		);

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 4, 0.7);

		assertOk(res);
		expect(res.data.vwap.stdDev).toBeGreaterThan(0);
	});

	it('全約定が同じ価格なら、丸め誤差で σ を 0 以外にしない', async () => {
		const prices = Array.from({ length: 10 }, () => 10_000_000);
		mockedGetTransactions.mockResolvedValue(
			asMockResult(
				mockTxResult(
					buildTxs(
						prices,
						Array.from({ length: 10 }, () => 0.1),
					),
				),
			),
		);

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 4, 0.7);

		assertOk(res);
		expect(res.data.vwap.price).toBe(10_000_000);
		expect(res.data.vwap.stdDev).toBe(0);
	});

	it('σ が呼び値より小さくても、σ バンドと POC・Value Area を本文と構造化データで潰さない', async () => {
		const prices = [...Array.from({ length: 9 }, () => 31.2345), 31.2346];
		mockedGetTransactions.mockResolvedValue(
			asMockResult(
				mockTxResult(
					buildTxs(
						prices,
						Array.from({ length: 10 }, () => 1),
					),
				),
			),
		);

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 20, 0.7);

		assertOk(res);
		const { bands } = res.data.vwap;
		expect(bands.upper1sigma).toBeGreaterThan(bands.lower1sigma);
		const text = res.summary;
		const bandLine = text.split('\n').find((l) => l.includes('バンド:')) ?? '';
		const [up1, lo1] = [/\+1σ=([^ ]+)/u.exec(bandLine)?.[1], /-1σ=([^ ]+)/u.exec(bandLine)?.[1]];
		expect(up1).not.toBe(lo1);
		const { low, high } = res.data.profile.valueArea;
		expect(low).toBeLessThan(high);
		expect(text).toContain(
			`Value Area: ¥${low.toLocaleString('ja-JP', { maximumFractionDigits: 12 })}〜¥${high.toLocaleString('ja-JP', { maximumFractionDigits: 12 })}`,
		);
	});

	it('構造化データの VWAP を、自分の σ バンドの外に出さない', async () => {
		const prices = [...Array.from({ length: 9 }, () => 1000.004), 1000.005];
		mockedGetTransactions.mockResolvedValue(
			asMockResult(
				mockTxResult(
					buildTxs(
						prices,
						Array.from({ length: 10 }, () => 1),
					),
				),
			),
		);

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 4, 0.7);

		assertOk(res);
		const { price, bands } = res.data.vwap;
		expect(price).toBeGreaterThanOrEqual(bands.lower1sigma);
		expect(price).toBeLessThanOrEqual(bands.upper1sigma);
	});

	it('1 円未満の価格でも価格帯・POC・Value Area・VWAP を 0 に潰さない', async () => {
		const prices = Array.from({ length: 20 }, (_, i) => 0.0012 + (i % 5) * 0.00001);
		mockedGetTransactions.mockResolvedValue(asMockResult(mockTxResult(buildTxs(prices))));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 4, 0.7);

		assertOk(res);
		expect(res.data.profile.poc.price).toBeGreaterThan(0.0011);
		expect(res.data.profile.valueArea.low).toBeGreaterThan(0.0011);
		expect(res.data.profile.bins[0].low).toBeGreaterThan(0.0011);
		expect(res.data.vwap.price).toBeGreaterThan(0.0011);
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	it('inputSchema: valueAreaPct は 0.5 以上のみ許可する', () => {
		const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', valueAreaPct: 0.49 });
		expect(parse).toThrow();
	});

	it('正常系: VWAP・Volume Profile・約定サイズ分布を返す', async () => {
		mockedGetTransactions.mockResolvedValue(
			asMockResult(mockTxResult(buildTxs([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]))),
		);

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);

		assertOk(res);
		expect(res.data.params.totalTrades).toBe(10);
		expect(res.data.profile.bins).toHaveLength(5);
		expect(res.data.tradeSizes.categories).toHaveLength(4);
	});

	it('get_transactions が全件失敗時は errorType=network を保つべき', async () => {
		mockedGetTransactions.mockResolvedValue(
			asMockResult({
				ok: false,
				summary: 'network failed',
				data: {},
				meta: { errorType: 'network' },
			}),
		);

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 20, 0.7);

		expect(res.ok).toBe(false);
		expect((res.meta as { errorType?: string })?.errorType).toBe('network');
	});

	it('toolDef.handler は省略パラメータ時に inputSchema の既定値で動作するべき', async () => {
		mockedGetTransactions.mockResolvedValue(
			asMockResult(mockTxResult(buildTxs([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]))),
		);

		const res = await toolDef.handler({ pair: 'btc_jpy' });

		assertOk(res);
	});

	it('全約定が同一価格なら POC price は実約定価格と一致するべき', async () => {
		mockedGetTransactions.mockResolvedValue(
			asMockResult(
				mockTxResult(
					buildTxs(
						Array.from({ length: 10 }, () => 100),
						Array.from({ length: 10 }, (_, i) => i + 1),
					),
				),
			),
		);

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 6, 0.7);

		assertOk(res);
		expect(res.data.profile.poc.price).toBe(100);
	});

	it('無効な pair を渡すと failFromValidation を返す', async () => {
		const res = await analyzeVolumeProfile('INVALID_PAIR!!!');
		assertFail(res);
		expect(res.meta?.errorType).toBe('user');
	});

	it('存在しない pair を渡すと失敗する', async () => {
		const res = await analyzeVolumeProfile('aaa_bbb');
		assertFail(res);
		expect(res.meta?.errorType).toBe('user');
	});

	it('約定データが10件未満の場合は insufficient data エラー', async () => {
		mockedGetTransactions.mockResolvedValue(
			asMockResult(mockTxResult(buildTxs([100, 101, 102, 103, 104, 105, 106, 107, 108]))),
		);

		const res = await analyzeVolumeProfile('btc_jpy', 0, 9, 5, 0.7);
		assertFail(res);
		expect(res.meta?.errorType).toBe('user');
		expect(res.summary).toContain('不足');
	});

	it('VWAP position: above_2sigma — 現在値が VWAP+2σ 超', async () => {
		// 最後の価格を非常に高くして above_2sigma にする
		const prices = [100, 101, 100, 101, 100, 101, 100, 101, 100, 200];
		mockedGetTransactions.mockResolvedValue(asMockResult(mockTxResult(buildTxs(prices))));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertOk(res);
		expect(res.data.vwap.position).toBe('above_2sigma');
	});

	it('VWAP position: above_1sigma — 現在値が VWAP+1σ 超', async () => {
		// 最後の価格を VWAP+1σ〜2σ の範囲に収まるよう調整
		const prices = [100, 100, 100, 100, 100, 100, 100, 100, 100, 130];
		mockedGetTransactions.mockResolvedValue(asMockResult(mockTxResult(buildTxs(prices))));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertOk(res);
		expect(['above_1sigma', 'above_2sigma']).toContain(res.data.vwap.position);
	});

	it('VWAP position: at_vwap — 現在値が VWAP 近辺', async () => {
		// 全価格が同一なら stdDev=0、最後の価格が VWAP と同じ
		const prices = Array.from({ length: 10 }, () => 100);
		mockedGetTransactions.mockResolvedValue(
			asMockResult(
				mockTxResult(
					buildTxs(
						prices,
						Array.from({ length: 10 }, () => 1),
					),
				),
			),
		);

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertOk(res);
		expect(res.data.vwap.position).toBe('at_vwap');
	});

	it('VWAP position: below_1sigma — 現在値が VWAP-1σ 以下', async () => {
		// 最後の価格を低くして below_1sigma 〜 below_2sigma にする
		const prices = [100, 100, 100, 100, 100, 100, 100, 100, 100, 70];
		mockedGetTransactions.mockResolvedValue(asMockResult(mockTxResult(buildTxs(prices))));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertOk(res);
		expect(['below_1sigma', 'below_2sigma']).toContain(res.data.vwap.position);
	});

	it('VWAP position: below_2sigma — 現在値が VWAP-2σ 超え下', async () => {
		const prices = [100, 100, 100, 100, 100, 100, 100, 100, 100, 1];
		mockedGetTransactions.mockResolvedValue(asMockResult(mockTxResult(buildTxs(prices))));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertOk(res);
		expect(res.data.vwap.position).toBe('below_2sigma');
	});

	it('Volume Profile: dominant=buy のビンが存在する', async () => {
		// すべてのトレードを buy にして買い優勢ビンを作る
		const txs = Array.from({ length: 10 }, (_, i) => ({
			price: 100 + i,
			amount: 1,
			side: 'buy' as const,
			timestampMs: Date.UTC(2024, 0, 1) + i * 60_000,
			isoTime: dayjs(Date.UTC(2024, 0, 1) + i * 60_000).toISOString(),
		}));
		mockedGetTransactions.mockResolvedValue(asMockResult(mockTxResult(txs)));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertOk(res);
		const hasBuyDominant = res.data.profile.bins.some((b) => b.dominant === 'buy');
		expect(hasBuyDominant).toBe(true);
	});

	it('Volume Profile: dominant=sell のビンが存在する', async () => {
		const txs = Array.from({ length: 10 }, (_, i) => ({
			price: 100 + i,
			amount: 1,
			side: 'sell' as const,
			timestampMs: Date.UTC(2024, 0, 1) + i * 60_000,
			isoTime: dayjs(Date.UTC(2024, 0, 1) + i * 60_000).toISOString(),
		}));
		mockedGetTransactions.mockResolvedValue(asMockResult(mockTxResult(txs)));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertOk(res);
		const hasSellDominant = res.data.profile.bins.some((b) => b.dominant === 'sell');
		expect(hasSellDominant).toBe(true);
	});

	it('Volume Profile: dominant=balanced のビンが存在する', async () => {
		// 交互に buy/sell で equal volume → balanced
		const txs = Array.from({ length: 10 }, (_, i) => ({
			price: 100,
			amount: 1,
			side: i % 2 === 0 ? ('buy' as const) : ('sell' as const),
			timestampMs: Date.UTC(2024, 0, 1) + i * 60_000,
			isoTime: dayjs(Date.UTC(2024, 0, 1) + i * 60_000).toISOString(),
		}));
		mockedGetTransactions.mockResolvedValue(asMockResult(mockTxResult(txs)));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertOk(res);
		const hasBalanced = res.data.profile.bins.some((b) => b.dominant === 'balanced');
		expect(hasBalanced).toBe(true);
	});

	it('largeTradeBias: ratio > 1.3 → 買い優勢', async () => {
		// 大口 (amount > p75) がすべて buy になるよう設計する。amount=[1,2,...,10] → p75=8 なので、大口(>8)は amount=9,10 の2件。
		const txs = [
			{ price: 100, amount: 1, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1), isoTime: '' },
			{ price: 101, amount: 2, side: 'sell' as const, timestampMs: Date.UTC(2024, 0, 1) + 1, isoTime: '' },
			{ price: 102, amount: 3, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 2, isoTime: '' },
			{ price: 103, amount: 4, side: 'sell' as const, timestampMs: Date.UTC(2024, 0, 1) + 3, isoTime: '' },
			{ price: 104, amount: 5, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 4, isoTime: '' },
			{ price: 105, amount: 6, side: 'sell' as const, timestampMs: Date.UTC(2024, 0, 1) + 5, isoTime: '' },
			{ price: 106, amount: 7, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 6, isoTime: '' },
			{ price: 107, amount: 8, side: 'sell' as const, timestampMs: Date.UTC(2024, 0, 1) + 7, isoTime: '' },
			{ price: 108, amount: 9, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 8, isoTime: '' }, // 大口 buy
			{ price: 109, amount: 10, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 9, isoTime: '' }, // 大口 buy
		];
		mockedGetTransactions.mockResolvedValue(asMockResult(mockTxResult(txs)));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertOk(res);
		const bias = res.data.tradeSizes.largeTradeBias;
		expect(bias.interpretation).toContain('買い');
	});

	it('largeTradeBias: ratio < 0.7 → 売り優勢', async () => {
		const txs = [
			{ price: 100, amount: 1, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1), isoTime: '' },
			{ price: 101, amount: 2, side: 'sell' as const, timestampMs: Date.UTC(2024, 0, 1) + 1, isoTime: '' },
			{ price: 102, amount: 3, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 2, isoTime: '' },
			{ price: 103, amount: 4, side: 'sell' as const, timestampMs: Date.UTC(2024, 0, 1) + 3, isoTime: '' },
			{ price: 104, amount: 5, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 4, isoTime: '' },
			{ price: 105, amount: 6, side: 'sell' as const, timestampMs: Date.UTC(2024, 0, 1) + 5, isoTime: '' },
			{ price: 106, amount: 7, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 6, isoTime: '' },
			{ price: 107, amount: 8, side: 'sell' as const, timestampMs: Date.UTC(2024, 0, 1) + 7, isoTime: '' },
			{ price: 108, amount: 9, side: 'sell' as const, timestampMs: Date.UTC(2024, 0, 1) + 8, isoTime: '' }, // 大口 sell
			{ price: 109, amount: 10, side: 'sell' as const, timestampMs: Date.UTC(2024, 0, 1) + 9, isoTime: '' }, // 大口 sell
		];
		mockedGetTransactions.mockResolvedValue(asMockResult(mockTxResult(txs)));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertOk(res);
		const bias = res.data.tradeSizes.largeTradeBias;
		expect(bias.interpretation).toContain('売り');
	});

	it('largeTradeBias: ratio 均衡 → 均衡メッセージ', async () => {
		// 大口が buy/sell 同量
		const txs = [
			{ price: 100, amount: 1, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1), isoTime: '' },
			{ price: 101, amount: 2, side: 'sell' as const, timestampMs: Date.UTC(2024, 0, 1) + 1, isoTime: '' },
			{ price: 102, amount: 3, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 2, isoTime: '' },
			{ price: 103, amount: 4, side: 'sell' as const, timestampMs: Date.UTC(2024, 0, 1) + 3, isoTime: '' },
			{ price: 104, amount: 5, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 4, isoTime: '' },
			{ price: 105, amount: 6, side: 'sell' as const, timestampMs: Date.UTC(2024, 0, 1) + 5, isoTime: '' },
			{ price: 106, amount: 7, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 6, isoTime: '' },
			{ price: 107, amount: 8, side: 'sell' as const, timestampMs: Date.UTC(2024, 0, 1) + 7, isoTime: '' },
			{ price: 108, amount: 9, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 8, isoTime: '' }, // 大口 buy
			{ price: 109, amount: 9, side: 'sell' as const, timestampMs: Date.UTC(2024, 0, 1) + 9, isoTime: '' }, // 大口 sell 同量
		];
		mockedGetTransactions.mockResolvedValue(asMockResult(mockTxResult(txs)));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertOk(res);
		const bias = res.data.tradeSizes.largeTradeBias;
		expect(bias.interpretation).toContain('均衡');
	});

	it('largeTradeBias: 大口なし → 大口取引なし', async () => {
		// すべて同一 amount → p75=amount で大口取引なし
		const txs = Array.from({ length: 10 }, (_, i) => ({
			price: 100 + i,
			amount: 1,
			side: i % 2 === 0 ? ('buy' as const) : ('sell' as const),
			timestampMs: Date.UTC(2024, 0, 1) + i * 60_000,
			isoTime: '',
		}));
		mockedGetTransactions.mockResolvedValue(asMockResult(mockTxResult(txs)));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertOk(res);
		const bias = res.data.tradeSizes.largeTradeBias;
		expect(['大口取引なし', '大口は買い売り均衡', '大口は買い一色']).toContain(bias.interpretation);
	});

	it('count-based: latest 成功 + supplement 失敗 → fail せず fetchWarning 付きで部分データを返す', async () => {
		// 補完アーカイブは公開遅延等で 404 になり得るので best-effort。latest が成功していれば「過半数失敗」で全体 fail せず、警告付きで返す。
		const latestTxs = buildTxs(Array.from({ length: 15 }, (_, i) => 100 + i));
		mockedGetTransactions
			.mockResolvedValueOnce(asMockResult(mockTxResult(latestTxs))) // latest (15件)
			.mockResolvedValueOnce(asMockResult(mockFailResult('network', 'day fetch failed'))); // supplement day-1

		const res = await analyzeVolumeProfile('btc_jpy', 0, 20, 5, 0.7);
		assertOk(res);
		// fetchWarning は summary の先頭に含まれる (meta はスキーマで warning フィールドなし)
		expect(res.summary).toContain('⚠️');
	});

	it('fetchWarning が存在するとき (latestTxs < lim で supplement 1件失敗、lim > 500 で3回fetch)', async () => {
		// lim=600 > 500 → supplement で day-1 + day-2 の2件追加 → 計3回の fetch。1回失敗 (failedCount=1, totalCount=3) → 1 < 1.5 → fetchWarning (ok=true)
		const latestTxs = buildTxs(Array.from({ length: 15 }, (_, i) => 100 + i));
		const dayTxs = buildTxs(Array.from({ length: 10 }, (_, i) => 200 + i));
		mockedGetTransactions
			.mockResolvedValueOnce(asMockResult(mockTxResult(latestTxs))) // latest 15件
			.mockResolvedValueOnce(asMockResult(mockFailResult('network', 'day-1 failed'))) // supplement day-1 失敗
			.mockResolvedValueOnce(asMockResult(mockTxResult(dayTxs))); // supplement day-2 成功

		const res = await analyzeVolumeProfile('btc_jpy', 0, 600, 5, 0.7);
		assertOk(res);
		expect(res.summary).toContain('⚠️');
	});

	it('hours > 0: 正常系 (単日)', async () => {
		// 窓（11:00〜12:00 UTC）が進行中の UTC 日に収まるので、取得は latest の 1 回だけになる。
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.UTC(2026, 6, 8, 12, 0, 0));
		try {
			const windowStartMs = Date.UTC(2026, 6, 8, 11, 0, 0);
			const txs = buildTxs(Array.from({ length: 23 }, (_, i) => 100 + i)).map((t, i) => {
				const timestampMs = windowStartMs + (i - 3) * 60_000;
				return { ...t, timestampMs, isoTime: dayjs(timestampMs).toISOString() };
			});
			mockedGetTransactions.mockResolvedValueOnce(asMockResult(mockTxResult(txs)));

			const res = await analyzeVolumeProfile('btc_jpy', 1, 500, 5, 0.7);
			assertOk(res);
			expect(mockedGetTransactions).toHaveBeenCalledTimes(1);
			expect(mockedGetTransactions).toHaveBeenCalledWith('btc_jpy', 1000, undefined, undefined, { unlimited: true });
			// 窓より前の 3 件は落ちる
			expect(res.data.params.totalTrades).toBe(20);
			expect(res.data.params.timeRange.requestedMin).toBe(60);
		} finally {
			vi.useRealTimers();
		}
	});

	it('hours > 0: 全 fetch 失敗 → extractUpstreamError を返す', async () => {
		mockedGetTransactions.mockResolvedValue(asMockResult(mockFailResult('network', 'all failed')));

		const res = await analyzeVolumeProfile('btc_jpy', 1, 500, 5, 0.7);
		assertFail(res);
		expect(res.meta?.errorType).toBe('network');
	});

	it('hours > 0: 取得 2 件中 1 件の失敗（ちょうど半数）→ upstream エラー', async () => {
		// 完了済み UTC 日 20260707 + latest の 2 fetch になるよう固定時刻で実行する。
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.UTC(2026, 6, 8, 1, 0, 0));
		try {
			const windowStartMs = Date.UTC(2026, 6, 7, 23, 0, 0);
			const goodTxs = buildTxs(Array.from({ length: 5 }, (_, i) => 100 + i)).map((t, i) => {
				const timestampMs = windowStartMs + i * 60_000;
				return { ...t, timestampMs, isoTime: dayjs(timestampMs).toISOString() };
			});
			mockedGetTransactions
				.mockResolvedValueOnce(asMockResult(mockTxResult(goodTxs))) // 20260707
				.mockResolvedValueOnce(asMockResult(mockFailResult('upstream', 'failed'))); // latest

			const res = await analyzeVolumeProfile('btc_jpy', 2, 500, 5, 0.7);
			assertFail(res);
			expect(mockedGetTransactions.mock.calls.map((c) => c[2])).toEqual(['20260707', undefined]);
			expect(res.meta?.errorType).toBe('upstream');
			expect(res.summary).toContain('2件中1件失敗');
		} finally {
			vi.useRealTimers();
		}
	});

	it('hours > 0: 過半数失敗 (mergedTxs > 0) → upstream エラー', async () => {
		// 完了済み UTC 日 2 日分（20260706, 20260707）+ latest = 3 fetch になるよう固定時刻で実行する（壁時計依存だと mid-day に dates が減り majority 判定が変わる）
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.UTC(2026, 6, 8, 1, 0, 0));
		try {
			const goodTxs = buildTxs(Array.from({ length: 5 }, (_, i) => 100 + i));
			mockedGetTransactions
				.mockResolvedValueOnce(asMockResult(mockTxResult(goodTxs))) // 成功
				.mockResolvedValueOnce(asMockResult(mockFailResult('upstream', 'fail1'))) // 失敗
				.mockResolvedValueOnce(asMockResult(mockFailResult('upstream', 'fail2'))); // 失敗

			const res = await analyzeVolumeProfile('btc_jpy', 27, 500, 5, 0.7);
			// failedCount=2, totalCount=3 → 2 >= 1.5 → upstream エラー
			assertFail(res);
			expect(res.meta?.errorType).toBe('upstream');
		} finally {
			vi.useRealTimers();
		}
	});

	it('count-based: 補完日付は完了済み UTC 日（JST 早朝でも進行中の UTC 日を要求しない）', async () => {
		// 2026-07-08 08:31 JST = 2026-07-07 23:31 UTC → 進行中 UTC 日 = 20260707、完了済み = 20260706
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.UTC(2026, 6, 7, 23, 31, 0));
		try {
			const latestTxs = buildTxs(Array.from({ length: 15 }, (_, i) => 100 + i));
			const dayTxs = buildTxs(Array.from({ length: 10 }, (_, i) => 200 + i));
			mockedGetTransactions
				.mockResolvedValueOnce(asMockResult(mockTxResult(latestTxs))) // latest
				.mockResolvedValueOnce(asMockResult(mockTxResult(dayTxs))); // supplement

			const res = await analyzeVolumeProfile('btc_jpy', 0, 20, 5, 0.7);
			assertOk(res);
			// 補完 fetch は完了済み UTC 日 20260706（JST 基準の「昨日」20260707 ではない）
			const requestedDates = mockedGetTransactions.mock.calls.map((c) => c[2]);
			expect(requestedDates).toContain('20260706');
			expect(requestedDates).not.toContain('20260707');
			// 内部集計は応答上限 1000 件のキャップを外して全件取得する
			expect(mockedGetTransactions).toHaveBeenCalledWith('btc_jpy', 1000, '20260706', undefined, {
				unlimited: true,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('hours > 0: 部分失敗で fetchWarning あり', async () => {
		// 00:30 UTC なら hours=25 の窓に完了済み UTC 日が 2 日入り、latest と合わせて 3 回の取得になる（1 回の失敗は過半数に届かない）。
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.UTC(2026, 6, 8, 0, 30, 0));
		try {
			const nowMs = Date.now();
			const txs = Array.from({ length: 20 }, (_, i) => ({
				price: 100 + i,
				amount: 1,
				side: i % 2 === 0 ? ('buy' as const) : ('sell' as const),
				timestampMs: nowMs - i * 60_000,
				isoTime: dayjs(nowMs - i * 60_000).toISOString(),
			}));
			// 1回目のみ失敗、残りはすべて成功 (mockResolvedValue はキューが空の場合のフォールバック)
			mockedGetTransactions
				.mockResolvedValueOnce(asMockResult(mockFailResult('network', 'fail'))) // 1回目失敗
				.mockResolvedValue(asMockResult(mockTxResult(txs))); // 残りはすべて成功

			const res = await analyzeVolumeProfile('btc_jpy', 25, 500, 5, 0.7);
			assertOk(res);
			expect(mockedGetTransactions).toHaveBeenCalledTimes(3);
			expect(res.summary).toContain('⚠️');
		} finally {
			vi.useRealTimers();
		}
	});

	it('count-based: latestTxs.length >= lim → supplement なし (early return)', async () => {
		const txs = buildTxs(Array.from({ length: 20 }, (_, i) => 100 + i));
		mockedGetTransactions.mockResolvedValueOnce(asMockResult(mockTxResult(txs)));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertOk(res);
		expect(mockedGetTransactions).toHaveBeenCalledTimes(1);
	});

	it('count-based: lim > 500 → 2日前まで supplement fetch', async () => {
		const latestTxs = buildTxs(Array.from({ length: 10 }, (_, i) => 100 + i));
		const dayTxs = buildTxs(Array.from({ length: 10 }, (_, i) => 200 + i));
		mockedGetTransactions
			.mockResolvedValueOnce(asMockResult(mockTxResult(latestTxs))) // latest
			.mockResolvedValueOnce(asMockResult(mockTxResult(dayTxs))) // day-1
			.mockResolvedValueOnce(asMockResult(mockTxResult(dayTxs))); // day-2

		const res = await analyzeVolumeProfile('btc_jpy', 0, 600, 5, 0.7);
		assertOk(res);
		// lim=600>500 なので3回呼ばれるはず
		expect(mockedGetTransactions).toHaveBeenCalledTimes(3);
	});

	it('count-based: supplement 後も mergedTxs が空 → upstream エラー', async () => {
		// latest が 0 件 (ok=true だが空)
		const emptyResult = {
			ok: true,
			summary: 'ok',
			data: { normalized: [] },
			meta: { count: 0 },
		};
		const failResult = mockFailResult('network', 'sup failed');
		mockedGetTransactions
			.mockResolvedValueOnce(asMockResult(emptyResult)) // latest empty
			.mockResolvedValueOnce(asMockResult(failResult)); // supplement 失敗

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertFail(res);
		expect(res.meta?.errorType).toBe('network');
	});

	it('count-based: supplement 後に failedCount >= totalCount/2 → upstream エラー', async () => {
		// latest 成功(0件), supplement2件とも失敗 → failedCount=2, totalCount=3 → 2>=1.5
		const emptyResult = {
			ok: true,
			summary: 'ok',
			data: { normalized: [] },
			meta: { count: 0 },
		};
		mockedGetTransactions
			.mockResolvedValueOnce(asMockResult(emptyResult)) // latest empty (ok=true)
			.mockResolvedValueOnce(asMockResult(mockFailResult('upstream', 'sup1 failed'))) // day-1 失敗
			.mockResolvedValueOnce(asMockResult(mockFailResult('upstream', 'sup2 failed'))); // day-2 失敗

		const res = await analyzeVolumeProfile('btc_jpy', 0, 600, 5, 0.7);
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
	});

	it('count-based: latestRes が ok=false → extractUpstreamError で即エラー返却', async () => {
		// latestRes.ok=false → latestTxs=[] → extractUpstreamError([latestRes]) でエラー返却
		mockedGetTransactions.mockResolvedValueOnce(asMockResult(mockFailResult('network', 'latest failed')));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertFail(res);
		expect(res.meta?.errorType).toBe('network');
		expect(mockedGetTransactions).toHaveBeenCalledTimes(1);
	});

	it('largeTradeBias: 大口がすべて buy → 大口は買い一色', async () => {
		// largeSellVol=0, largeBuyVol>0 → ratio=null → '大口は買い一色'
		const txs = [
			{ price: 100, amount: 1, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1), isoTime: '' },
			{ price: 101, amount: 2, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 1, isoTime: '' },
			{ price: 102, amount: 3, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 2, isoTime: '' },
			{ price: 103, amount: 4, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 3, isoTime: '' },
			{ price: 104, amount: 5, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 4, isoTime: '' },
			{ price: 105, amount: 6, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 5, isoTime: '' },
			{ price: 106, amount: 7, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 6, isoTime: '' },
			{ price: 107, amount: 8, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 7, isoTime: '' },
			{ price: 108, amount: 9, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 8, isoTime: '' }, // 大口 buy
			{ price: 109, amount: 10, side: 'buy' as const, timestampMs: Date.UTC(2024, 0, 1) + 9, isoTime: '' }, // 大口 buy
		];
		mockedGetTransactions.mockResolvedValueOnce(asMockResult(mockTxResult(txs)));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertOk(res);
		expect(res.data.tradeSizes.largeTradeBias.ratio).toBeNull();
		expect(res.data.tradeSizes.largeTradeBias.interpretation).toBe('大口は買い一色');
	});

	it('予期しない例外が発生した場合 failFromError を返す', async () => {
		mockedGetTransactions.mockRejectedValue(new Error('unexpected error'));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertFail(res);
		// failFromError は errorType='internal' を設定する
		expect(res.ok).toBe(false);
	});

	it('hours > 0: fetchWarning が summary と meta に含まれる', async () => {
		// 00:30 UTC なら取得は 3 回で、1 回目だけの失敗は過半数に届かず警告になる。
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.UTC(2026, 6, 8, 0, 30, 0));
		try {
			const nowMs = Date.now();
			const recentTxs = Array.from({ length: 20 }, (_, i) => ({
				price: 100 + i,
				amount: 1,
				side: i % 2 === 0 ? ('buy' as const) : ('sell' as const),
				timestampMs: nowMs - i * 1_000,
				isoTime: dayjs(nowMs - i * 1_000).toISOString(),
			}));

			mockedGetTransactions
				.mockResolvedValueOnce(asMockResult(mockFailResult('network', 'fail'))) // 1回目失敗
				.mockResolvedValue(asMockResult(mockTxResult(recentTxs))); // 残りはすべて成功

			const res = await analyzeVolumeProfile('btc_jpy', 25, 500, 5, 0.7);
			assertOk(res);
			expect(mockedGetTransactions).toHaveBeenCalledTimes(3);
			const warning = requireDefined(res.meta.warning, 'res.meta.warning');
			expect(warning).toContain('⚠️');
			expect(res.summary).toContain(warning);
		} finally {
			vi.useRealTimers();
		}
	});
});
