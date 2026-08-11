/**
 * asset コード正規化ユーティリティ。
 *
 * bitbank API が返す通貨コード（`assets[].asset` / `deposits[].asset` /
 * `withdrawals[].asset`）を **取得境界で小文字へ揃える**ための単一実装。
 *
 * リポジトリ全体が「API が返す asset は小文字」という前提の上に立っており、
 * 生の `asset` を小文字リテラル（`'jpy'`）と比較する、あるいは Map のキーに使う
 * 箇所が 20 箇所以上ある（`portfolio/calc.ts` の JPY 判定・holdings キー・
 * `prices.get(asset)` 等）。大文字が 1 つでも紛れ込むと、`JPY` が「価格を引けない
 * 暗号資産」として純入出金から落ちる／`BTC` と `btc` で保有キーが割れて二重計上に
 * なる、といった破綻が同時に起きる。
 *
 * これは**防御的正規化**であり、現行 API は小文字を返す（公式 docs の JSON 例は
 * `"asset": "jpy"`、`docs/internal/bitbank-api-fields.md` 参照）。前提をコードに
 * 明文化し、破れたときに数値が壊れないようにするのが目的。
 *
 * **消費側（`portfolio/calc.ts` 等）に `.toLowerCase()` を撒かないこと。**
 * 正規化は取得境界（`portfolio/fetch.ts` / `/v1/user/assets` の取り込み）に集約し、
 * どこで担保されているかを 1 箇所に保つ。
 *
 * ユーザー入力の pair 正規化（`lib/validate.ts` の `normalizePair`）とは別レイヤー。
 * 混ぜないこと（あちらは入力の受け口、こちらは API レスポンスの受け口）。
 *
 * API が返す **pair シンボル**の取得境界正規化は姉妹モジュール `lib/pair-code.ts`。
 * pair から導出した asset（`replace('_jpy', '')`）は本モジュールが担保する小文字空間に
 * 乗る必要があるため、両者は同じ境界方針で揃えてある。
 */

/**
 * API 由来の asset コードを小文字へ正規化する。
 *
 * 前後の空白も落とす（`normalizePair` と同方針）。asset コードは英数字のみのため、
 * ロケール依存の `toLocaleLowerCase` ではなく `toLowerCase` を使う。
 */
export function normalizeAssetCode(raw: string): string {
	return raw.trim().toLowerCase();
}

/**
 * API レスポンスのレコード配列について `asset` フィールドのみを正規化した配列を返す。
 *
 * 既に小文字（＝現行 API の実挙動）なら**元のオブジェクト参照をそのまま通す**ので、
 * 既存レスポンスに対しては実質ノーオペ（出力は 1 バイトも変わらない）。
 */
export function normalizeAssetCodes<T extends { asset: string }>(records: readonly T[]): T[] {
	return records.map((record) => {
		// レスポンス不正で asset が欠けていても取得層で throw させない（防御）。
		// 消費側では従来どおり「'jpy' でない未知資産」として扱われる。
		if (typeof record.asset !== 'string') return record;
		const asset = normalizeAssetCode(record.asset);
		return asset === record.asset ? record : { ...record, asset };
	});
}
