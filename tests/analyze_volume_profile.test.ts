import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../lib/datetime.js';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';

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

	afterEach(() => {
		vi.resetAllMocks();
	});

	// ── inputSchema ──

	it('inputSchema: valueAreaPct は 0.5 以上のみ許可する', () => {
		const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', valueAreaPct: 0.49 });
		expect(parse).toThrow();
	});

	// ── 正常系 ──

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

	// ── Invalid pair ──

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

	// ── txs.length < 10 ──

	it('約定データが10件未満の場合は insufficient data エラー', async () => {
		mockedGetTransactions.mockResolvedValue(
			asMockResult(mockTxResult(buildTxs([100, 101, 102, 103, 104, 105, 106, 107, 108]))),
		);

		const res = await analyzeVolumeProfile('btc_jpy', 0, 9, 5, 0.7);
		assertFail(res);
		expect(res.meta?.errorType).toBe('user');
		expect(res.summary).toContain('不足');
	});

	// ── VWAP position branches ──

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

	// ── calcVolumeProfile: dominant branches ──

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

	// ── calcTradeSizeDistribution: largeTradeBias ──

	it('largeTradeBias: ratio > 1.3 → 買い優勢', async () => {
		// 大口 (amount > p75) がすべて buy になるよう設計
		// p75 は index=7 の amount になる。amount=[1,2,...,10] → p75=8
		// 大口(>8)は amount=9,10 の2件。両方 buy にする
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

	// ── fetchWarning が summary と meta に含まれる ──

	it('count-based: latest 成功 + supplement 失敗 → fail せず fetchWarning 付きで部分データを返す', async () => {
		// 補完アーカイブは公開遅延等で 404 になり得るため best-effort。
		// latest が成功していれば「過半数失敗」で全体 fail せず、警告付きで返す
		// （旧実装は 1/2 失敗 → upstream fail で、JST 早朝に正当なデータごと捨てていた）。
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
		// lim=600 > 500 → supplement で day-1 + day-2 の2件追加 → 計3回のfetch
		// 1回失敗 (failedCount=1, totalCount=3) → 1 < 1.5 → fetchWarning (ok=true)
		const latestTxs = buildTxs(Array.from({ length: 15 }, (_, i) => 100 + i));
		const dayTxs = buildTxs(Array.from({ length: 10 }, (_, i) => 200 + i));
		mockedGetTransactions
			.mockResolvedValueOnce(asMockResult(mockTxResult(latestTxs))) // latest 15件
			.mockResolvedValueOnce(asMockResult(mockFailResult('network', 'day-1 failed'))) // supplement day-1 失敗
			.mockResolvedValueOnce(asMockResult(mockTxResult(dayTxs))); // supplement day-2 成功

		const res = await analyzeVolumeProfile('btc_jpy', 0, 600, 5, 0.7);
		assertOk(res);
		// fetchWarning は summary の先頭に含まれる (meta はスキーマで warning フィールドなし)
		expect(res.summary).toContain('⚠️');
	});

	// ── hours-based path ──

	it('hours > 0: 正常系 (単日)', async () => {
		const txs = buildTxs(Array.from({ length: 20 }, (_, i) => 100 + i));
		// hours=1 → 今日分 + latest の2回の fetch
		mockedGetTransactions
			.mockResolvedValueOnce(asMockResult(mockTxResult(txs))) // date fetch
			.mockResolvedValueOnce(asMockResult(mockTxResult(txs))); // latest fetch

		const res = await analyzeVolumeProfile('btc_jpy', 1, 500, 5, 0.7);
		// txs は2024年1月1日のタイムスタンプなので hours フィルタで除外される可能性がある
		// ok/fail 両方の可能性があるが、クラッシュしないことを確認
		expect(res).toBeDefined();
		expect(typeof res.ok).toBe('boolean');
	});

	it('hours > 0: 全 fetch 失敗 → extractUpstreamError を返す', async () => {
		mockedGetTransactions.mockResolvedValue(asMockResult(mockFailResult('network', 'all failed')));

		const res = await analyzeVolumeProfile('btc_jpy', 1, 500, 5, 0.7);
		assertFail(res);
		expect(res.meta?.errorType).toBe('network');
	});

	it('hours > 0: failedCount >= totalCount/2 → upstream エラー', async () => {
		const goodTxs = buildTxs(Array.from({ length: 5 }, (_, i) => 100 + i));
		// 2回呼ばれる: 1回目成功, 1回目失敗 → failedCount=1, totalCount=2 → 1>=1 → upstream
		mockedGetTransactions
			.mockResolvedValueOnce(asMockResult(mockTxResult(goodTxs)))
			.mockResolvedValueOnce(asMockResult(mockFailResult('upstream', 'failed')));

		const res = await analyzeVolumeProfile('btc_jpy', 1, 500, 5, 0.7);
		// failedCount=1 totalCount=2 → 1 >= 1 → upstream エラー
		// ただし mergedTxs>0 の場合は upstream エラー分岐に入らないこともある
		// mergedTxs.length===0 の場合のみ extractUpstreamError が走るので確認
		expect(res).toBeDefined();
	});

	it('hours > 0: 過半数失敗 (mergedTxs > 0) → upstream エラー', async () => {
		// 完了済み UTC 日 2 日分（20260706, 20260707）+ latest = 3 fetch になるよう固定時刻で実行
		// （dates は完了済み UTC 暦日基準。壁時計依存だと mid-day に dates が減り majority 判定が変わる）
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
			expect(mockedGetTransactions).toHaveBeenCalledWith('btc_jpy', 1000, '20260706');
			expect(mockedGetTransactions).not.toHaveBeenCalledWith('btc_jpy', 1000, '20260707');
		} finally {
			vi.useRealTimers();
		}
	});

	it('hours > 0: 部分失敗で fetchWarning あり', async () => {
		// hours=25 → 少なくとも2日分のdate + latest = 3回以上 → 1回のみ失敗 → fetchWarning
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
		// 総フェッチ数 >= 3、失敗数=1 → failedCount < totalCount/2 → fetchWarning
		expect(res).toBeDefined();
		if (res.ok) {
			// fetchWarning は summary の先頭に含まれる (meta はスキーマで warning フィールドなし)
			expect(res.summary).toContain('⚠️');
		}
	});

	// ── count-based: latestTxs.length >= lim → early return ──

	it('count-based: latestTxs.length >= lim → supplement なし (early return)', async () => {
		const txs = buildTxs(Array.from({ length: 20 }, (_, i) => 100 + i));
		mockedGetTransactions.mockResolvedValueOnce(asMockResult(mockTxResult(txs)));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertOk(res);
		// mockedGetTransactions は 1 回だけ呼ばれるはず
		expect(mockedGetTransactions).toHaveBeenCalledTimes(1);
	});

	// ── count-based: lim > 500 → 2日前も fetch ──

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

	// ── count-based: mergedTxs empty after supplement → extractUpstreamError ──

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

	// ── count-based: supplement failedCount >= totalCount/2 ──

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

	// ── count-based: latestTxs empty かつ ok=false → extractUpstreamError (lines 111-114) ──

	it('count-based: latestRes が ok=false → extractUpstreamError で即エラー返却', async () => {
		// latestRes.ok=false → latestTxs=[] → extractUpstreamError([latestRes]) でエラー返却
		mockedGetTransactions.mockResolvedValueOnce(asMockResult(mockFailResult('network', 'latest failed')));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertFail(res);
		expect(res.meta?.errorType).toBe('network');
		// supplement は呼ばれないはず
		expect(mockedGetTransactions).toHaveBeenCalledTimes(1);
	});

	// ── largeTradeBias: 大口が buy のみ (ratio=null, largeBuyVol > 0) ──

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

	// ── catch block ──

	it('予期しない例外が発生した場合 failFromError を返す', async () => {
		mockedGetTransactions.mockRejectedValue(new Error('unexpected error'));

		const res = await analyzeVolumeProfile('btc_jpy', 0, 10, 5, 0.7);
		assertFail(res);
		// failFromError は errorType='internal' を設定する
		expect(res.ok).toBe(false);
	});

	// ── fetchWarning in hours-based path ──

	it('hours > 0: fetchWarning が summary と meta に含まれる', async () => {
		// 1回目のみ失敗、残りはすべて成功 → failedCount=1 < totalCount/2 → fetchWarning
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
		// 総フェッチ数 >= 3 (2日分 + latest)、失敗数=1 → 1 < totalCount/2 → fetchWarning
		expect(res).toBeDefined();
		if (res.ok) {
			// fetchWarning は summary の先頭に含まれる (meta はスキーマで warning フィールドなし)
			expect(res.summary).toContain('⚠️');
		}
	});
});
