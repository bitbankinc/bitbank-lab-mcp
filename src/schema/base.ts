import { z } from 'zod';

export const CandleTypeEnum = z.enum([
	'1min',
	'5min',
	'15min',
	'30min',
	'1hour',
	'4hour',
	'8hour',
	'12hour',
	'1day',
	'1week',
	'1month',
]);

// ── Shared base schemas ──

/** レートリミット情報スキーマ（レスポンスヘッダから抽出、ヘッダ未提供時は省略） */
export const RateLimitSchema = z
	.object({
		remaining: z.number().describe('残りリクエスト数'),
		limit: z.number().describe('期間あたりの上限数'),
		reset: z.number().describe('リセット時刻（Unix epoch 秒）'),
	})
	.optional();

/** pair + fetchedAt: 全 Meta スキーマの共通ベース */
export const BaseMetaSchema = z.object({
	pair: z.string(),
	fetchedAt: z.string(),
	rateLimit: RateLimitSchema,
});

/** pair デフォルト入力: z.string().optional().default('btc_jpy') */
export const BasePairInputSchema = z.object({ pair: z.string().optional().default('btc_jpy') });

/**
 * **オフセット付き** ISO8601 の絶対時刻。秒・小数秒は省略可、小数秒の桁数は任意。
 * 例: `2026-08-01T00:00:00Z` / `2026-08-01T09:00:00+09:00` / `2026-08-01T00:00Z` /
 * `2026-08-01T00:00:00.5Z`
 *
 * 絶対時刻の入力に `YYYYMMDD` を採らないのは、暦日の基準がツール間で割れている
 * （`get_transactions` / `get_flow_metrics` は UTC 暦日、`get_candles` /
 * `validate_candle_data` は `tz` 引数の暦日）ため。オフセットを必須にすると
 * 「どの暦で解釈されるか」が入力そのものから一意に決まり、取り違えが起きない。
 *
 * キャプチャグループ（1: 日付+HH:mm / 2: 秒 / 3: 小数秒の桁 / 4: オフセット）は
 * `lib/tx-fetch.ts` の `parseAbsoluteIso` が正準形 `.SSS` へ揃えるのに使う。**この
 * パターンで受理する形は、すべて正準化後に `parseIso8601`（strict）が通ること。**
 * 揃えないと「スキーマは通るが parse で落ちて『存在しない日付・時刻』と誤報する」
 * 入力が生まれる（実際 `.5Z` / `.12Z` がそうだった: `parseIso8601` の strict format は
 * `.SSS` の 3 桁のみ）。小数秒はミリ秒精度に切り捨てる（ISO8601 の小数秒は 10 進小数
 * なので `.5` = 500ms）。
 *
 * Zod の `.regex()` はグループを無視するため、入力検証の挙動には影響しない。
 */
export const ISO8601_WITH_OFFSET_PATTERN =
	/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * 約定集計ツール（`get_flow_metrics` / `analyze_volume_profile`）の `since`〜`until` に
 * 指定できる最大範囲（日）。
 *
 * 根拠: 完了済み UTC 日アーカイブは 1 日 = 1 リクエストで、BTC/JPY の 1 UTC 日は実測
 * 5,609〜8,040 件。上限 7 日なら最大 8 リクエスト・約 56,000 件を並列取得し、dedup 用の
 * Set と正規化済み配列をメモリに載せることになる。ここまでは実用範囲だが、これを超えると
 * リクエスト数・レスポンス parse・dedup がまとめて膨らみ、MCP 応答のタイムアウトにも近づく。
 * より長い期間は日次・週次に分割して呼ぶこと。
 *
 * 超過の判定は `lib/tx-fetch.ts` の `resolveTxTimeRange`（user エラー）。定数をこちらに
 * 置いているのは、この値が入力スキーマの description にも現れるため（schema 層は lib に
 * 依存しない方向を保つ）。
 */
export const MAX_TX_RANGE_DAYS = 7;

/** 約定集計ツール共通: 絶対時刻区間の開始（含む） */
export const TX_RANGE_SINCE_SCHEMA = z
	.string()
	.regex(ISO8601_WITH_OFFSET_PATTERN)
	.optional()
	.describe(
		'取得区間の開始時刻（**含む**）。オフセット付き ISO8601 のみ（例: 2026-08-01T00:00:00Z / 2026-08-01T09:00:00+09:00）。' +
			'YYYYMMDD は不可 — 暦日の基準がツール間で割れている（約定系ツールの date は UTC 暦日、get_candles の date は tz 引数の暦日）ため、' +
			'絶対時刻はオフセット必須にして解釈のブレを排除している。' +
			`hours / date とは併用不可。since〜until は最大 ${MAX_TX_RANGE_DAYS} 日。指定時は limit を適用しない（区間の全件を集計）`,
	);

/** 約定集計ツール共通: 絶対時刻区間の終端（含まない） */
export const TX_RANGE_UNTIL_SCHEMA = z
	.string()
	.regex(ISO8601_WITH_OFFSET_PATTERN)
	.optional()
	.describe(
		'取得区間の終端時刻（**含まない**: [since, until)）。オフセット付き ISO8601 のみ。省略時は現在時刻まで。' +
			'排他区間なので、連続する区間を続けて要求しても境界の約定が二重計上されない' +
			'（例: since=2026-08-01T00:00:00Z, until=2026-08-02T00:00:00Z は UTC 8/1 のちょうど 1 日）。' +
			'since 無しの until 単独指定は user エラー。未来時刻も user エラー（現在時刻までを対象にするなら until を省略する）',
	);

/** 全ツール共通のエラー分岐 */
export const FailResultSchema = z.object({
	ok: z.literal(false),
	summary: z.string(),
	data: z.object({}).passthrough(),
	meta: z.object({ errorType: z.string() }).passthrough(),
});

/** ok/fail Result union を生成するヘルパー */
export function toolResultSchema<D extends z.ZodTypeAny, M extends z.ZodTypeAny>(data: D, meta: M) {
	return z.union([z.object({ ok: z.literal(true), summary: z.string(), data, meta }), FailResultSchema]);
}

export const TrendLabelEnum = z.enum([
	'strong_uptrend',
	'uptrend',
	'strong_downtrend',
	'downtrend',
	'overbought',
	'oversold',
	'sideways',
	'insufficient_data',
]);

// === Shared output schemas (partial) ===
export const NumericSeriesSchema = z
	.array(z.union([z.number(), z.null()]))
	.transform((arr) => arr.map((v) => (v == null ? null : Number(Number(v).toFixed(2)))));

/**
 * ローソク足スキーマ
 * volume: base 通貨建ての合算取引量（買い+売り区別なし）。
 *   例: btc_jpy → BTC 単位、eth_jpy → ETH 単位。
 *   bitbank /candlestick API の OHLCV[4] をそのまま使用。
 *   公式アプリの Volume バー（買い/売り色分け）とは集計方法が異なる。
 */
export const CandleSchema = z.object({
	open: z.number(),
	high: z.number(),
	low: z.number(),
	close: z.number(),
	volume: z.number().optional(),
	isoTime: z
		.string()
		.nullable()
		.optional()
		.describe('UTC ISO 文字列（例: 2026-02-20T00:00:00.000Z）。tz 引数の影響を受けない。'),
	isoTimeLocal: z
		.string()
		.nullable()
		.optional()
		.describe('tz 引数のローカル時刻文字列（既定 Asia/Tokyo、例: 2026-02-20T09:00:00）。'),
	time: z.union([z.string(), z.number()]).optional(),
	timestamp: z.number().optional(),
});
