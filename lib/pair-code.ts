/**
 * pair シンボル正規化ユーティリティ。
 *
 * bitbank API が返す通貨ペア文字列（`trades[].pair` / `orders[].pair` /
 * `positions[].pair` / `tickers_jpy` の `data[].pair` 等）を
 * **取得境界で小文字へ揃える**ための単一実装。`lib/asset-code.ts` の pair 版。
 *
 * リポジトリ全体が「API が返す pair は小文字」という前提の上に立っており、
 * 破れ方は asset 版より悪い:
 *
 * - `t.pair.replace('_jpy', '')` は `BTC_JPY` に対して**何も置換しない**（`_jpy` が無い）。
 *   結果 asset が `BTC_JPY` のまま holdings の Map キーになり、`lib/asset-code.ts` で
 *   正規化した `btc` と割れる（`portfolio/calc.ts` の `calcPeriodRealizedPnl` /
 *   `reconstructHoldingsAtDate`、`analyzeMyPortfolioHandler.ts` の `tradedAssets`）。
 * - `calcPnl` は `t.pair === \`${asset}_jpy\`` で突き合わせるため、pair が大文字だと
 *   該当約定が 0 件になる。エラーにならず「取引履歴なし」に見え、平均取得単価・
 *   実現損益が静かに消える。
 * - `lib/tickers.ts` の価格マップキーも pair 由来なので、大文字なら `prices.get('btc')`
 *   が外れる（＝ `unpriced_flow_assets` warning が全銘柄に対して誤検知する）。
 * - `pair.includes('jpy')` による JPY 建て判定（各 Private ツールの価格フォーマット）が
 *   外れ、円建て表示が崩れる。
 *
 * これは**防御的正規化**であり、現行 API は小文字を返す（公式 docs の JSON 例・
 * 全フィクスチャとも小文字。`docs/internal/bitbank-api-fields.md` 参照）。前提をコードに
 * 明文化し、破れたときに数値が壊れないようにするのが目的。
 *
 * **消費側（`portfolio/calc.ts` / 各 Private ツールの表示ロジック）に `.toLowerCase()` を
 * 撒かないこと。** 正規化は取得境界に集約し、どこで担保されているかを 1 箇所に保つ。
 *
 * ユーザー入力の pair 正規化（`lib/validate.ts` の `normalizePair` / `ensurePair`）とは
 * 別レイヤー。混ぜないこと（あちらは入力の受け口で不正形式を `null` にし、`ALLOWED_PAIRS`
 * で弾く。こちらは API レスポンスの受け口であり、**drop も throw もしない**——口座に
 * 非対応 pair（上場廃止ペア等）の履歴があっても取得層で落としてはならない）。
 */

/**
 * API 由来の pair シンボルを正規化する。**正規化 = 前後の空白除去 + 小文字化**の 2 つだけ。
 *
 * `trim()` も含むのは `normalizePair`（`lib/validate.ts`）/ `normalizeAssetCode` と同方針。
 * pair は英数字と `_` のみのため、ロケール依存の `toLocaleLowerCase` ではなく `toLowerCase` を使う。
 * 形式検証・ALLOWED_PAIRS 検証はしない（取得境界でやるのはこの 2 つのみ。drop も throw もしない）。
 */
export function normalizePairCode(raw: string): string {
	return raw.trim().toLowerCase();
}

/**
 * pair が JPY 建てかを判定する。
 *
 * 各 Private ツールの価格フォーマット分岐（`isJpy ? formatPrice(...) : 生文字列`）が
 * 従来 `pair.includes('jpy')` を直書きしていたのを 1 箇所に集約したもの。判定前に
 * `normalizePairCode` を通すので、**ユーザー入力由来の pair でも API 応答由来の pair でも安全**。
 *
 * これは「消費側に `.toLowerCase()` を撒く」ことにはあたらない。撒くのが禁物なのは
 * *API レスポンスの正規化*であって（それは取得境界の責務）、ここで扱うのは
 * `get_order` / `create_order` 等がユーザー入力の `pair` から直接 JPY 判定している経路
 * ——取得境界を通らない値なので、判定側で吸収するしかない。
 *
 * `lib/price.ts` の `isJpyPair`（`endsWith('_jpy')`）とは判定条件が違う。あちらは
 * 丸め桁数の決定用で quote 通貨が JPY かを見る。こちらは既存の `includes('jpy')` 挙動を
 * そのまま保つ（`jpy_btc` のような base 側 JPY も真になる）。統合はしない。
 */
export function isJpyQuotedPair(pair: string): boolean {
	return normalizePairCode(pair).includes('jpy');
}

/**
 * API レスポンスのレコード 1 件について `pair` フィールドのみを正規化して返す。
 *
 * 既に小文字（＝現行 API の実挙動）なら**元のオブジェクト参照をそのまま返す**ので、
 * 既存レスポンスに対しては実質ノーオペ（出力は 1 バイトも変わらない）。
 */
export function withNormalizedPair<T extends { pair: string }>(record: T): T {
	// レスポンス不正で pair が欠けていても取得層で throw させない（防御）。
	// 消費側では従来どおり「未知の pair」として扱われる。
	if (typeof record.pair !== 'string') return record;
	const pair = normalizePairCode(record.pair);
	return pair === record.pair ? record : { ...record, pair };
}

/**
 * API レスポンスのレコード配列について `pair` フィールドのみを正規化した配列を返す。
 *
 * `withNormalizedPair` と同じく、既に小文字のレコードは元の参照をそのまま通す。
 */
export function normalizePairCodes<T extends { pair: string }>(records: readonly T[]): T[] {
	return records.map(withNormalizedPair);
}
