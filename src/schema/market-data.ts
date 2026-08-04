import { z } from 'zod';
import {
	BaseMetaSchema,
	BasePairInputSchema,
	CandleSchema,
	CandleTypeEnum,
	deprecatedViewNote,
	FailResultSchema,
	FORMAT_PARAM_NOTE,
	toolResultSchema,
	VIEW_CONTRACT_NOTE,
} from './base.js';

// === Ticker ===
export const TickerNormalizedSchema = z.object({
	pair: z.string(),
	last: z.number().nullable(),
	buy: z.number().nullable(),
	sell: z.number().nullable(),
	open: z.number().nullable(),
	high: z.number().nullable(),
	low: z.number().nullable(),
	volume: z.number().nullable(),
	timestamp: z.number().nullable(),
	isoTime: z.string().nullable(),
});

export const GetTickerDataSchemaOut = z.object({ raw: z.unknown(), normalized: TickerNormalizedSchema });
export const GetTickerMetaSchemaOut = BaseMetaSchema;
export const GetTickerOutputSchema = toolResultSchema(GetTickerDataSchemaOut, GetTickerMetaSchemaOut);
export const GetTickerInputSchema = BasePairInputSchema;

// === Depth (raw depth tuple, shared by /depth tool and orderbook raw mode) ===
export const DepthLevelTupleSchema = z.tuple([z.string(), z.string()]);

// === Orderbook ===
export const OrderbookLevelSchema = z.object({ price: z.number(), size: z.number() });
export const OrderbookLevelWithCumSchema = OrderbookLevelSchema.extend({ cumSize: z.number() });
export const OrderbookNormalizedSchema = z.object({
	pair: z.string(),
	bestBid: z.number().nullable(),
	bestAsk: z.number().nullable(),
	spread: z.number().nullable(),
	mid: z.number().nullable(),
	bids: z.array(OrderbookLevelWithCumSchema),
	asks: z.array(OrderbookLevelWithCumSchema),
	timestamp: z.number().nullable(),
	isoTime: z.string().nullable(),
});

const OrderbookPressureTagEnum = z.enum(['notice', 'warning', 'strong']);

// mode=summary
export const OrderbookSummaryDataSchema = z.object({
	mode: z.literal('summary'),
	normalized: OrderbookNormalizedSchema,
});

// mode=pressure
export const OrderbookPressureBandSchema = z.object({
	widthPct: z.number(),
	baseMid: z.number().nullable(),
	baseBidSize: z.number(),
	baseAskSize: z.number(),
	bidDelta: z.number(),
	askDelta: z.number(),
	netDelta: z.number(),
	netDeltaPct: z.number().nullable(),
	tag: OrderbookPressureTagEnum.nullable(),
});
export const OrderbookPressureDataSchema = z.object({
	mode: z.literal('pressure'),
	bands: z.array(OrderbookPressureBandSchema),
	aggregates: z.object({
		netDelta: z.number(),
		strongestTag: OrderbookPressureTagEnum.nullable(),
	}),
});

// mode=statistics
export const OrderbookStatisticsDataSchema = z.object({
	mode: z.literal('statistics'),
	basic: z.object({
		currentPrice: z.number().nullable(),
		bestBid: z.number().nullable(),
		bestAsk: z.number().nullable(),
		spread: z.number().nullable(),
		spreadPct: z.number().nullable(),
	}),
	ranges: z.array(
		z.object({
			pct: z.number(),
			bidVolume: z.number(),
			askVolume: z.number(),
			bidValue: z.number(),
			askValue: z.number(),
			// ask 板が枯れて bid だけ存在するとき ratio は算出不能（数学的には Infinity）。
			// MCP wire format (JSON) では Infinity を表現できないため、buildStatistics 側で
			// null に正規化している（tools/get_orderbook.ts）。
			// 「買い優勢」の意味は interpretation / summary.overall / summary.strength で保持。
			ratio: z.number().nullable(),
			interpretation: z.string(),
		}),
	),
	liquidityZones: z.array(
		z.object({
			priceRange: z.string(),
			bidVolume: z.number(),
			askVolume: z.number(),
			dominance: z.enum(['bid', 'ask', 'balanced']),
			note: z.string().optional(),
		}),
	),
	largeOrders: z.object({
		bids: z.array(z.object({ price: z.number(), size: z.number(), distance: z.number().nullable() })),
		asks: z.array(z.object({ price: z.number(), size: z.number(), distance: z.number().nullable() })),
		threshold: z.number(),
	}),
	summary: z.object({
		overall: z.string(),
		strength: z.enum(['weak', 'moderate', 'strong']),
		liquidity: z.enum(['low', 'medium', 'high']),
		recommendation: z.string(),
	}),
});

// mode=raw（bitbank /depth の生値 + 壁ゾーン推定 overlay）
// 公式 API は asks_over などを string で返すが、テスト fixture では number リテラルを渡すため両方を許容する。
export const OrderbookRawDataSchema = z.object({
	mode: z.literal('raw'),
	asks: z.array(DepthLevelTupleSchema),
	bids: z.array(DepthLevelTupleSchema),
	asks_over: z.union([z.string(), z.number()]).optional(),
	asks_under: z.union([z.string(), z.number()]).optional(),
	bids_over: z.union([z.string(), z.number()]).optional(),
	bids_under: z.union([z.string(), z.number()]).optional(),
	ask_market: z.union([z.string(), z.number()]).optional(),
	bid_market: z.union([z.string(), z.number()]).optional(),
	timestamp: z.number().int(),
	sequenceId: z.number().int().optional(),
	overlays: z
		.object({
			depth_zones: z.array(
				z.object({
					low: z.number(),
					high: z.number(),
					color: z.string().optional(),
					label: z.string().optional(),
				}),
			),
		})
		.optional(),
});

export const GetOrderbookDataSchemaOut = z.discriminatedUnion('mode', [
	OrderbookSummaryDataSchema,
	OrderbookPressureDataSchema,
	OrderbookStatisticsDataSchema,
	OrderbookRawDataSchema,
]);
export const GetOrderbookMetaSchemaOut = BaseMetaSchema.extend({
	mode: z.enum(['summary', 'pressure', 'statistics', 'raw']),
	topN: z.number(),
	/** 非有限な price/size を持つ板レベルを drop した件数。0 件なら省略。 */
	droppedRows: z.object({ bids: z.number(), asks: z.number() }).optional(),
	/** drop が発生した場合の警告メッセージ（取得層の不完全性）。 */
	warning: z.string().optional(),
});
export const GetOrderbookOutputSchema = toolResultSchema(GetOrderbookDataSchemaOut, GetOrderbookMetaSchemaOut);

export const GetOrderbookInputSchema = BasePairInputSchema.extend({
	mode: z.enum(['summary', 'pressure', 'statistics', 'raw']).optional().default('summary'),
	/** summary mode: 上位N層 (1-200) */
	topN: z.number().int().min(1).max(200).optional().default(10),
	/** pressure mode: 帯域幅 (例: [0.001, 0.005, 0.01]) */
	bandsPct: z.array(z.number().positive()).optional().default([0.001, 0.005, 0.01]),
	/** statistics mode: 範囲% (例: [0.5, 1.0, 2.0]) */
	ranges: z.array(z.number().positive()).optional().default([0.5, 1.0, 2.0]),
	/** statistics mode: 価格ゾーン分割数 */
	priceZones: z.number().int().min(2).max(50).optional().default(10),
});

// === Candles ===
export const KeyPointSchema = z.object({
	index: z.number(),
	date: z.string().nullable().describe('YYYY-MM-DD（表示は tz 引数（既定 Asia/Tokyo）の暦日）'),
	close: z.number(),
	changePct: z.number().nullable().optional(),
});

export const KeyPointsSchema = z.object({
	today: KeyPointSchema.nullable(),
	sevenDaysAgo: KeyPointSchema.nullable(),
	thirtyDaysAgo: KeyPointSchema.nullable(),
	ninetyDaysAgo: KeyPointSchema.nullable(),
});

export const VolumeStatsSchema = z.object({
	recent7DaysAvg: z.number(),
	previous7DaysAvg: z.number(),
	last30DaysAvg: z.number().nullable(),
	// previous7DaysAvg === 0 のときは null（前週比較不可）。
	// nonzero / 0 → Infinity（JSON wire で null 化）、0 / 0 → NaN（z.number() で reject）の両方を回避するため。
	changePct: z.number().nullable(),
	judgment: z.string(),
});

export const GetCandlesDataSchemaOut = z.object({
	raw: z.unknown(),
	normalized: z.array(CandleSchema),
	keyPoints: KeyPointsSchema.optional(),
	volumeStats: VolumeStatsSchema.nullable().optional(),
});
export const GetCandlesMetaSchemaOut = BaseMetaSchema.extend({
	type: CandleTypeEnum,
	count: z.number(),
	/** 取得層の不完全性を示す警告（multi-year/multi-day 部分失敗時など）。指標不足の warnings[] とは別系統。 */
	warning: z.string().optional(),
	/** 最新足が形成中（未確定）か。realtime 取得（date 未指定）でのみ立つ情報フラグ。warning とは別系統。 */
	provisional: z.boolean().optional(),
});
export const GetCandlesOutputSchema = toolResultSchema(GetCandlesDataSchemaOut, GetCandlesMetaSchemaOut);

export const GetCandlesInputSchema = z.object({
	pair: z.string(),
	type: CandleTypeEnum,
	date: z
		.string()
		.optional()
		.describe(
			'type により形式が異なる:\n' +
				'- 1min/5min/15min/30min/1hour → YYYYMMDD（例: 20251022）\n' +
				'- 4hour/8hour/12hour/1day/1week/1month → YYYY（例: 2025）\n' +
				'date=YYYYMMDD は tz（既定 Asia/Tokyo）の暦日として解釈します。指定日の終端（23:59:59.999 in tz）以前の limit 本を返します。' +
				'limit は日数ではなくローソク足本数です。例: 1hour, date=20251002, limit=24 は指定 tz の 10/2 24 本（00:00〜23:00）。\n' +
				'省略時は最新。\n' +
				'（互換: 年足系で YYYYMMDD を渡した場合は先頭4桁を年として使用）',
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(10000)
		.optional()
		.default(200)
		.describe(
			'デフォルト 200。1〜10000 の整数。type により実上限が変わる: 1min〜1hour は最大 10000（複数日取得）、4hour〜1month は最大 5000（複数年取得）、それ以外は 1000。実上限を超えると user エラー。',
		),
	view: z
		.enum(['full', 'items'])
		.optional()
		.default('full')
		.describe(
			`${VIEW_CONTRACT_NOTE}\n` +
				'- full（既定）: サマリ本文（全 OHLCV を 1 行 1 本の圧縮形式で列挙）＋ 価格レンジ / キーポイント / 出来高統計 / フッタ ＋ 先頭 5 本の JSON サンプル。本ツールの最重量。\n' +
				`- items: ${deprecatedViewNote('view=full + format=json')}。挙動は view=full + format=json と同じ（content は全件の pretty JSON のみで、サマリ本文・価格レンジ・キーポイント・出来高統計・フッタは出ない）。\n` +
				'集計だけを返す軽量 summary は未実装（量を絞る手段は limit）。',
		),
	format: z.enum(['text', 'json']).optional().default('text').describe(FORMAT_PARAM_NOTE),
	tz: z
		.string()
		.optional()
		.default('Asia/Tokyo')
		.describe(
			'タイムゾーン（既定 Asia/Tokyo）。date パラメータの暦日解釈、isoTimeLocal、keyPoints.date、' +
				'priceRange.periodStart/End の表示に使用。isoTime は常に UTC ISO。' +
				'空文字も Asia/Tokyo にフォールバック。UTC が必要な場合は明示的に "UTC" を渡す。',
		),
});

// === Transactions ===
export const TransactionItemSchema = z.object({
	// 公式 API のレスポンスでは必須。normalized では上流欠損や互換ソース対応のため optional。
	transaction_id: z.number().int().optional(),
	price: z.number(),
	amount: z.number(),
	side: z.enum(['buy', 'sell']),
	timestampMs: z.number().int(),
	isoTime: z.string(),
});

export const GetTransactionsDataSchemaOut = z.object({ raw: z.unknown(), normalized: z.array(TransactionItemSchema) });
export const GetTransactionsMetaSchemaOut = BaseMetaSchema.extend({
	count: z.number().int(),
	source: z.enum(['latest', 'by_date']),
	warning: z.string().optional(),
});
export const GetTransactionsOutputSchema = toolResultSchema(GetTransactionsDataSchemaOut, GetTransactionsMetaSchemaOut);

export const GetTransactionsInputSchema = BasePairInputSchema.extend({
	limit: z.number().int().min(1).max(1000).optional().default(100),
	date: z
		.string()
		.regex(/^\d{8}$/)
		.optional()
		.describe('YYYYMMDD; omit for latest'),
	minAmount: z.number().positive().optional(),
	maxAmount: z.number().positive().optional(),
	minPrice: z.number().positive().optional(),
	maxPrice: z.number().positive().optional(),
	view: z
		.enum(['full', 'summary', 'items'])
		.optional()
		.default('full')
		.describe(
			`${VIEW_CONTRACT_NOTE}\n` +
				'- full（既定）: 返却した全約定を 1 行 1 件で列挙 ＋ 件数サマリ ＋ 切り捨て警告 ＋ スコープフッタ。本ツールの最重量。\n' +
				`- summary: ${deprecatedViewNote('view=full')}。旧既定値で、実体は full と同じ全件列挙（挙動は完全に不変で、名前だけを階梯に合わせた）。集計のみの軽量 summary は将来別リリースで opt-in 専用として新設予定。\n` +
				`- items: ${deprecatedViewNote('view=full + format=json')}。挙動は view=full + format=json と同じ（content は全件の pretty JSON のみで、件数サマリとスコープフッタは出ない）。`,
		),
	format: z.enum(['text', 'json']).optional().default('text').describe(FORMAT_PARAM_NOTE),
});

// === Depth (raw depth for analysis/visualization) ===
export const GetDepthDataSchemaOut = z.object({
	asks: z.array(DepthLevelTupleSchema),
	bids: z.array(DepthLevelTupleSchema),
	asks_over: z.string().optional(),
	asks_under: z.string().optional(),
	bids_over: z.string().optional(),
	bids_under: z.string().optional(),
	ask_market: z.string().optional(),
	bid_market: z.string().optional(),
	timestamp: z.number().int(),
	sequenceId: z.number().int().optional(),
	overlays: z
		.object({
			depth_zones: z.array(
				z.object({ low: z.number(), high: z.number(), color: z.string().optional(), label: z.string().optional() }),
			),
		})
		.optional(),
});
export const GetDepthMetaSchemaOut = BaseMetaSchema;
export const GetDepthOutputSchema = toolResultSchema(GetDepthDataSchemaOut, GetDepthMetaSchemaOut);

// === Flow Metrics (derived from recent transactions) ===
export const FlowBucketSchema = z.object({
	timestampMs: z.number().int(),
	isoTime: z.string(),
	isoTimeJST: z.string().optional(),
	displayTime: z.string().optional(),
	buyVolume: z.number(),
	sellVolume: z.number(),
	totalVolume: z.number(),
	cvd: z.number(),
	zscore: z.number().nullable().optional(),
	spike: z.enum(['notice', 'warning', 'strong']).nullable().optional(),
});

export const GetFlowMetricsDataSchemaOut = z.object({
	source: z.literal('transactions'),
	params: z.object({ bucketMs: z.number().int().min(1000) }),
	aggregates: z.object({
		totalTrades: z.number().int(),
		buyTrades: z.number().int(),
		sellTrades: z.number().int(),
		buyVolume: z.number(),
		sellVolume: z.number(),
		netVolume: z.number(),
		aggressorRatio: z.number().min(0).max(1),
		finalCvd: z.number(),
	}),
	series: z.object({ buckets: z.array(FlowBucketSchema) }),
});

export const GetFlowMetricsMetaSchemaOut = BaseMetaSchema.extend({
	count: z.number().int(),
	bucketMs: z.number().int(),
	timezone: z.string().optional(),
	timezoneOffset: z.string().optional(),
	serverTime: z.string().optional(),
	hours: z.number().optional(),
	mode: z.enum(['time_range']).optional(),
	actualRange: z
		.object({
			start: z.string(),
			end: z.string(),
			durationMinutes: z.number().int(),
		})
		.optional(),
	warning: z.string().optional(),
});

export const GetFlowMetricsOutputSchema = toolResultSchema(GetFlowMetricsDataSchemaOut, GetFlowMetricsMetaSchemaOut);

export const GetFlowMetricsInputSchema = BasePairInputSchema.extend({
	limit: z
		.number()
		.int()
		.min(1)
		.max(2000)
		.optional()
		.default(100)
		.describe('取得する約定件数（バケット数ではない）。hours 指定時は無視されます'),
	hours: z
		.number()
		.min(0.1)
		.max(24)
		.optional()
		.describe(
			'指定した時間数分の約定を取得して分析（例: 8 → 直近8時間）。limit より優先。複数日にまたがる場合も自動で取得します',
		),
	date: z
		.string()
		.regex(/^\d{8}$/)
		.optional()
		.describe('YYYYMMDD; omit for latest'),
	bucketMs: z
		.number()
		.int()
		.min(1000)
		.max(3600_000)
		.optional()
		.default(60_000)
		.describe('バケットの時間幅（ミリ秒）。デフォルト60000=1分間隔'),
	view: z
		.enum(['summary', 'detailed', 'full', 'compact', 'buckets'])
		.optional()
		.default('summary')
		.describe(
			`${VIEW_CONTRACT_NOTE}\n` +
				'本ツールの主対象はバケット列なので、view が決めるのは content のバケット行の量です（集計値・警告・フッタは全 view に出ます）。\n' +
				'- summary（既定）: 集計値のみ。バケット行は content に出ない。\n' +
				'- detailed: 集計値 ＋ 直近 bucketsN 件のバケット行（既定 10 / 上限 100）。それより前のバケット行は content に出ない。\n' +
				'- full: 集計値 ＋ 全バケット行。本ツールの最重量。\n' +
				`- compact: ${deprecatedViewNote('view=full + nonZeroOnly=true')}。挙動は view=full + nonZeroOnly=true と同じ。\n` +
				`- buckets: ${deprecatedViewNote('view=detailed')}。挙動は view=detailed と同じ。`,
		),
	nonZeroOnly: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			'true にすると content のバケット行を非ゼロ（buy または sell > 0）のみに絞ります。量ではなく絞り込みの軸なので view とは独立に指定できます。' +
				'約定が 1 件も無かった区間のバケットは出来高 0 なので content から落ちます（structuredContent には残るので、区間の連続性はそちらで確認できます）。' +
				'structuredContent は変わりません（全バケットのまま）。view=summary との併用は no-op（バケット行が無いため。エラーにはしません）。',
		),
	bucketsN: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.default(10)
		.describe(
			'view=detailed（および deprecated な view=buckets）で content に出す直近バケット行の件数。他の view では無視されます。',
		),
	tz: z.string().optional().default('Asia/Tokyo'),
});

// === /tickers_jpy (public REST) ===
export const TickerJpyItemSchema = z.object({
	pair: z.string(),
	sell: z.string().nullable(),
	buy: z.string().nullable(),
	high: z.string(),
	low: z.string(),
	open: z.string(),
	last: z.string(),
	vol: z.string(),
	timestamp: z.number(),
	// 追加: 24h変化率（%）。open/last から算出
	change24h: z.number().nullable().optional(),
	change24hPct: z.number().nullable().optional(),
});
export const GetTickersJpyOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: z.array(TickerJpyItemSchema),
		meta: z.object({ cache: z.object({ hit: z.boolean(), key: z.string() }).optional(), ts: z.string() }).passthrough(),
	}),
	FailResultSchema,
]);

// === get_tickers_jpy handler (NormalizedTicker shape) ===
// handler が structuredContent に渡す正規化済みティッカー。
// z.number() は NaN を reject するため、NaN/Infinity が混入したら parse 失敗で検出できる。
export const NormalizedTickerSchema = z
	.object({
		pair: z.string(),
		lastN: z.number().nullable(),
		openN: z.number().nullable(),
		highN: z.number().nullable(),
		lowN: z.number().nullable(),
		buyN: z.number().nullable(),
		sellN: z.number().nullable(),
		changeN: z.number().nullable(),
		volN: z.number().nullable(),
		volumeInJPY: z.number().nullable(),
	})
	.passthrough(); // 元の bitbank フィールド（last/open/...）は残す

export const GetTickersJpyHandlerOutputSchema = z.object({
	ok: z.literal(true),
	summary: z.string(),
	data: z.object({
		items: z.array(NormalizedTickerSchema),
		ranked: z.array(NormalizedTickerSchema).optional(),
	}),
	meta: z.record(z.string(), z.unknown()),
});

// === Market Summary (tickers + volatility snapshot) ===
export const MarketSummaryItemSchema = z.object({
	pair: z.string(),
	last: z.number().nullable(),
	change24hPct: z.number().nullable().optional(),
	vol24h: z.number().nullable().optional(),
	rv_std_ann: z.number().nullable().optional(),
	vol_bucket: z.enum(['low', 'mid', 'high']).nullable().optional(),
	tags: z.array(z.string()).optional(),
});

export const MarketSummaryRanksSchema = z.object({
	topGainers: z.array(z.object({ pair: z.string(), change24hPct: z.number().nullable() })).optional(),
	topLosers: z.array(z.object({ pair: z.string(), change24hPct: z.number().nullable() })).optional(),
	topVolatility: z.array(z.object({ pair: z.string(), rv_std_ann: z.number().nullable() })).optional(),
});
