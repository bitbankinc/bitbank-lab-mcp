/**
 * Bitbank API レスポンスのフィクスチャ集
 * ユニットテスト・E2Eテストの両方で再利用する
 */

/** GET /{pair}/ticker — 正常レスポンス */
export const tickerBtcJpy = {
	success: 1,
	data: {
		pair: 'btc_jpy',
		sell: '15500000',
		buy: '15490000',
		high: '15600000',
		low: '15300000',
		open: '15400000',
		last: '15500000',
		vol: '123.4567',
		timestamp: 1710000000000,
	},
} as const;

/** GET /{pair}/ticker — success:0 エラーレスポンス */
export const tickerError = {
	success: 0,
	data: { code: 10000 },
} as const;

/** GET /{pair}/depth — 正常レスポンス（最小） */
export const depthBtcJpy = {
	success: 1,
	data: {
		asks: [
			['15500000', '0.1'],
			['15510000', '0.5'],
		],
		bids: [
			['15490000', '0.2'],
			['15480000', '0.8'],
		],
		asks_over: '100.0',
		bids_under: '80.0',
		timestamp: 1710000000000,
		sequenceId: '12345',
	},
} as const;

/** GET /{pair}/depth — success:0 エラーレスポンス */
export const depthError = {
	success: 0,
	data: { code: 20003 },
} as const;

/** GET /{pair}/candlestick — success:0 エラーレスポンス */
export const candlesError = {
	success: 0,
	data: { code: 10000 },
} as const;

/** GET /{pair}/transactions — 正常レスポンス（最小） */
export const transactionsBtcJpy = {
	success: 1,
	data: {
		transactions: [
			{
				transaction_id: 1,
				side: 'buy',
				price: '15500000',
				amount: '0.01',
				executed_at: 1710000000000,
			},
			{
				transaction_id: 2,
				side: 'sell',
				price: '15490000',
				amount: '0.02',
				executed_at: 1710000001000,
			},
			{
				transaction_id: 3,
				side: 'buy',
				price: '15500000',
				amount: '0.005',
				executed_at: 1710000002000,
			},
		],
	},
} as const;

/**
 * OHLCV ジェネレーター
 * @param count 本数
 * @param intervalMs 間隔（ms）。デフォルト 1day
 * @param basePrice 開始価格。デフォルト 15,000,000
 * @param baseTs 開始タイムスタンプ。デフォルト 2024-03-08T00:00:00Z
 */
export function generateOhlcv(count: number, intervalMs = 86400000, basePrice = 15000000, baseTs = 1709856000000) {
	const rows: [string, string, string, string, string, number][] = [];
	for (let i = 0; i < count; i++) {
		const open = basePrice + i * 50000;
		const high = open + 200000;
		const low = open - 100000;
		const close = open + 100000;
		const vol = 8 + Math.round(Math.sin(i) * 4 + 4);
		rows.push([String(open), String(high), String(low), String(close), String(vol), baseTs + i * intervalMs]);
	}
	return rows;
}

/** 1day 25本（ボラティリティ等の最低ライン） */
export const candlesBtcJpy1day = {
	success: 1,
	data: {
		candlestick: [{ type: '1day', ohlcv: generateOhlcv(25) }],
	},
};

/** 1day 120本（analyze_indicators, detect_patterns, detect_macd_cross 用） */
export const candlesBtcJpy1day120 = {
	success: 1,
	data: {
		candlestick: [{ type: '1day', ohlcv: generateOhlcv(120) }],
	},
};

/**
 * `Date.now()`（fake timers 含む）付近までカバーする 1day 120 本。
 *
 * 静的 `candlesBtcJpy1day120`（2024 起点）だと実行時点の期初始値が解決できず、
 * `buildPeriodPerformance` の始値欠損検出（#86）が誤発火する。`setupFetchMock` の
 * 既定はこちらにする。
 */
export function candlesBtcJpy1day120Near(nowMs = Date.now()) {
	const dayMs = 86400000;
	const baseTs = nowMs - 119 * dayMs;
	return {
		success: 1,
		data: {
			candlestick: [{ type: '1day', ohlcv: generateOhlcv(120, dayMs, 15_000_000, baseTs) }],
		},
	};
}

/** 5min 24本（detect_whale_events の lookback=2hour 用） */
export const candlesBtcJpy5min = {
	success: 1,
	data: {
		candlestick: [{ type: '5min', ohlcv: generateOhlcv(24, 300000) }],
	},
};

/** GET /tickers_jpy — 正常レスポンス（複数ペア） */
export const tickersJpy = {
	success: 1,
	data: [
		{
			pair: 'btc_jpy',
			sell: '15500000',
			buy: '15490000',
			high: '15600000',
			low: '15300000',
			open: '15400000',
			last: '15500000',
			vol: '123.4567',
			timestamp: 1710000000000,
		},
		{
			pair: 'eth_jpy',
			sell: '380000',
			buy: '379000',
			high: '385000',
			low: '375000',
			open: '377000',
			last: '380000',
			vol: '1500.123',
			timestamp: 1710000000000,
		},
		{
			pair: 'xrp_jpy',
			sell: '90',
			buy: '89',
			high: '92',
			low: '88',
			open: '89',
			last: '90',
			vol: '5000000',
			timestamp: 1710000000000,
		},
	],
} as const;
