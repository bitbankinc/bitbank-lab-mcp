import { z } from 'zod';
import { roundPriceAtLevel } from '../../lib/price.js';

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

export const CANDLE_DATE_DESCRIPTION =
	'type により形式が異なる: 1min/5min/15min/30min/1hour は YYYYMMDD、4hour/8hour/12hour/1day/1week/1month は YYYY（YYYYMMDD も先頭4桁として互換受理）。date は tz（既定 Asia/Tokyo）の暦日として解釈し、指定日の終端以前を対象にします。';

export const RateLimitSchema = z
	.object({
		remaining: z.number().describe('残りリクエスト数'),
		limit: z.number().describe('期間あたりの上限数'),
		reset: z.number().describe('リセット時刻（Unix epoch 秒）'),
	})
	.optional();

/** 取得層の不完全性（partial fetch など）。計算層の `warnings` と混ぜず、別フィールドで出す（.claude/rules/tools.md）。 */
export const warningField = { warning: z.string().optional() };

/** 計算層の不完全性（指標のバー数不足など）。 */
export const warningsField = { warnings: z.array(z.string()).optional() };

/** 最新足が未確定（形成中）なら true（lib/provisional-bar.ts）。 */
export const provisionalField = { provisional: z.boolean().optional() };

export const BaseMetaSchema = z.object({
	pair: z.string(),
	fetchedAt: z.string(),
	rateLimit: RateLimitSchema,
});

export const BasePairInputSchema = z.object({ pair: z.string().optional().default('btc_jpy') });

/**
 * キャプチャグループ（1: 日付+HH:mm / 2: 秒 / 3: 小数秒 / 4: オフセット）は `lib/tx-fetch.ts` の `parseAbsoluteIso` が `.SSS` へ正準化するのに使う。
 * このパターンで受理する形は、すべて正準化後に `parseIso8601`（strict）を通ること（揃えないと、スキーマは通るのに parse で落ちる）。
 */
export const ISO8601_WITH_OFFSET_PATTERN =
	/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/;

/** 超過の判定は `lib/tx-fetch.ts` の `resolveTxTimeRange`。定数をこちらに置くのは、入力スキーマの description にも現れるため（schema 層は lib に依存しない）。 */
export const MAX_TX_RANGE_DAYS = 7;

/** 区間指定（`date` / `hours` / `since`・`until`）は `limit` を適用しないので、`limit` の用途は件数ベース取得（直近 N 件）だけ。 */
export const MAX_TX_COUNT_LIMIT = 2000;

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

/** `structuredContent` について「view に依存しない」とは書かない。view でしか計算しないデータを足すツールがあり、description が実装に対して嘘になる。 */
export const VIEW_CONTRACT_NOTE =
	'view は content の量を制御します。量は summary < detailed < full の順で、full は常にそのツールの最重量です。' +
	'view が structuredContent から**フィールドを削ることはありません**' +
	'（その view でしか計算しないデータを足すツールはあり、その場合は当該 view の説明に明記しています）。' +
	'content[0].text は LLM への唯一のチャネルなので、軽い view は「短い表示」ではなく「LLM が明細を受け取らない」を意味します。';

// 今は非推奨の値もフィールドも無い。新たに非推奨にするときは、2 つの定数を削除する版に書き換えてから使う。
export const DEPRECATED_VIEW_REMOVAL_TARGET = '0.7.0';

export function deprecatedViewNote(replacement: string): string {
	return `非推奨。${replacement} を使うこと。${DEPRECATED_VIEW_REMOVAL_TARGET} で削除予定`;
}

/** 値は `DEPRECATED_VIEW_REMOVAL_TARGET` と同じだが、削除の単位（enum 値 / 出力フィールド）が別なので、片方だけ期日を動かせるよう定数を分けている。 */
export const DEPRECATED_FIELD_REMOVAL_TARGET = '0.7.0';

export function deprecatedFieldNote(replacement: string): string {
	return `**非推奨**（${replacement} の別名）。同じ値を返します。${DEPRECATED_FIELD_REMOVAL_TARGET} で削除予定なので ${replacement} へ移行してください`;
}

/** `format=json` はトークン削減オプションではない（同じデータを pretty JSON にすると散文より増える）。 */
export const FORMAT_PARAM_NOTE =
	'content の形式。text（既定）: 散文 / json: pretty JSON。' +
	'json は機械可読性のために**トークンを払う**オプションで、同じデータでも text より必ず多くなります（削減オプションではありません）。' +
	'量は format ではなく view と limit が決めます。';

export const FailResultSchema = z.object({
	ok: z.literal(false),
	summary: z.string(),
	data: z.object({}).passthrough(),
	meta: z.object({ errorType: z.string() }).passthrough(),
});

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

// 小数 2 桁に固定すると数円のペアの価格の系列の桁が落ちるので、値の水準の桁（最低 2 桁）で丸める。RSI など 0〜100 の系列は計算側で 2 桁に丸め済み。
export const NumericSeriesSchema = z
	.array(z.union([z.number(), z.null()]))
	.transform((arr) => arr.map((v) => (v == null ? null : roundPriceAtLevel(Number(v), Number(v), 2))));

/** volume は base 通貨建てで買い売りを区別しない（/candlestick の OHLCV[4] をそのまま使う）。公式アプリの Volume バーとは集計方法が異なる。 */
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
