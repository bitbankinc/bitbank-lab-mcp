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

// === view の共通語彙（docs/internal/view-vocabulary-unification.md §3-2 / §3-3） ===

/**
 * 全ツール共通の `view` 契約。各ツールの `view` description の先頭に置く。
 *
 * `content[0].text` が LLM への唯一のチャネル（`.claude/rules/tools.md`）なので、
 * 軽い view は「短い表示」ではなく「LLM が明細を受け取らない」を意味する。
 * そのため各 view には「この view では〇〇が content に出ない」を必ず併記する（§3-2 規約 5）。
 *
 * **`structuredContent` について「view に依存しない」とは書かない。** §3-2 規約 4 が禁じているのは
 * *削る*ことだけで、**その view でしか計算しないデータを*足す*のは許容**されている
 * （`detect_patterns(detailed)` の `usage_example` / `(debug)` の `data.candidates`、
 * `detect_macd_cross(detailed)` の `data.resultsDetailed` / `data.screenedDetailed`）。
 * 「依存しない」と書くと、これらのツールで description が実装に対して嘘になる——
 * 呼び出し側が「`resultsDetailed` は `view` を問わず入る」と誤解する。
 * 足すツールは各 view の説明に**何を足すか**を明記すること。
 */
export const VIEW_CONTRACT_NOTE =
	'view は content の量を制御します。量は summary < detailed < full の順で、full は常にそのツールの最重量です。' +
	'view が structuredContent から**フィールドを削ることはありません**' +
	'（その view でしか計算しないデータを足すツールはあり、その場合は当該 view の説明に明記しています）。' +
	'content[0].text は LLM への唯一のチャネルなので、軽い view は「短い表示」ではなく「LLM が明細を受け取らない」を意味します。';

/**
 * deprecated な `view` 値を削除する目標バージョン（§6-4 の決定: 最低 1 リリース かつ 3 ヶ月）。
 *
 * 公開済みの最新は `0.3.1` なので、alias の導入は次のマイナー `0.4.0`、削除はその次の次の
 * マイナー `0.6.0` を目標にする（同一リリースに畳まない・1 マイナー分の猶予を挟む、
 * という §4-3 の条件をそのまま upstream のリリース線に当てた値）。
 * **リリース運用側でバージョン番号を確定させる際は、この定数を単一ソースとして更新すること。**
 */
export const DEPRECATED_VIEW_REMOVAL_TARGET = '0.6.0';

/** deprecated な `view` 値の description に付ける定型文（写像先と削除目標バージョンを明示する）。 */
export function deprecatedViewNote(replacement: string): string {
	return `非推奨。${replacement} を使うこと。${DEPRECATED_VIEW_REMOVAL_TARGET} で削除予定`;
}

/**
 * `format` パラメータの共通 description（§3-3）。
 *
 * `format=json` は**トークン削減オプションではない**。同じデータを pretty JSON にすると
 * 散文の圧縮形式より必ず増える（実測で約 7.4 倍。§2-0）。
 */
export const FORMAT_PARAM_NOTE =
	'content の形式。text（既定）: 散文 / json: pretty JSON。' +
	'json は機械可読性のために**トークンを払う**オプションで、同じデータでも text より必ず多くなります（削減オプションではありません）。' +
	'量は format ではなく view と limit が決めます。';

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
