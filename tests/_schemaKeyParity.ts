/**
 * 「`ok()` の meta / data に載せたキーが、出力スキーマの `parse()` で strip されていないか」を
 * 検証するための共有ヘルパ。
 *
 * ## 背景
 *
 * 全ツールは `ok(summary, data, meta)` の戻り値を `XxxOutputSchema.parse()` に通してから返す。
 * Zod の object は**未宣言のキーを黙って落とす**（エラーにしない）ので、
 * 出力スキーマへの宣言を忘れたフィールドは **parse 成功のまま消える**。
 * `detect_patterns` だけで 3 回踏んでいる（#155 `status` / #160 `breakoutDirection` /
 * #184 `effective_params`）。
 *
 * ## 横断テストにしていない理由（#184 の調査結果）
 *
 * 全ツールを自動で舐めるテストは、現状の作りでは書けない:
 *
 * 1. **`ToolDefinition`（`src/tool-definition.ts`）が `outputSchema` を持たない。**
 *    出力スキーマは各ツールのモジュール内部でしか参照されていないため、
 *    `tool-registry` からツールを列挙しても、そのツールの schema に手が届かない。
 * 2. **上流のフィクスチャがツールごとに違う。** `parse` を通すには実際に 1 回走らせる必要があり、
 *    そのためには bitbank REST の応答（candlestick / ticker / depth / transactions / pairs）を
 *    ツールごとに用意しないといけない。`OutputSchema.parse` を持つ 40 ファイルのうち 16 は Private 系で、
 *    さらに API キーと HMAC 署名クライアントのモックが要る。
 * 3. **`meta` は条件付きで組まれる。** `...(scan ? { scan } : {})` のような分岐があるため、
 *    1 回の happy path では meta の全形を踏めない。静的解析でキーを列挙することもできない。
 *
 * 無理に一般化すると「全ツールを浅く 1 回ずつ走らせて、たまたま出たキーだけ見る」テストになり、
 * 落ちないが守ってもいない状態になる。そこで**採用したのは横展開しやすい形にすること**:
 * 本ファイルのヘルパを使えば、新しいツールの parity テストは
 * 「上流モック + `parse` の spy + `expectNoStrippedKeys`」の 3 ステップで書ける。
 * 実例は `tests/detect_patterns_meta_schema_parity.test.ts`。
 */
import { expect } from 'vitest';

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * オブジェクトのキーパス集合。配列は `[]` を挟んで**全要素を合算**する
 * （要素ごとに持つキーが違うため。候補配列は reason を持つものと持たないものが混ざる）。
 * これにより `debug.candidates[].status` のような**配列要素の中の strip** も検出できる
 * （#155 / #160 がまさにこれ）。
 *
 * `undefined` の値は「キーが無い」と同じに扱う——Zod も optional 未指定のキーを落とすので、
 * 区別すると常に偽陽性になる。
 */
export function keyPaths(value: unknown, prefix = ''): Set<string> {
	const out = new Set<string>();
	if (Array.isArray(value)) {
		for (const element of value) {
			for (const path of keyPaths(element, `${prefix}[]`)) out.add(path);
		}
		return out;
	}
	if (!isPlainObject(value)) return out;
	for (const [key, nested] of Object.entries(value)) {
		if (nested === undefined) continue;
		const path = prefix ? `${prefix}.${key}` : key;
		out.add(path);
		for (const child of keyPaths(nested, path)) out.add(child);
	}
	return out;
}

/**
 * `parse()` の入力（ツールが実際に載せた値）と出力（宣言されていて生き残った値）で
 * キーパス集合が一致することを検証する。値の一致は見ない——対象は「宣言漏れによる消失」だけ。
 *
 * @param label 失敗メッセージに出す対象名（例: `'detect_patterns meta'`）
 * @param knownStrips 既に strip されていると**分かっている**キーパス。別 issue で扱う既知の
 *   欠落を「記録として」通すための口で、**増やすときは呼び出し側に理由を必ず書く**。
 *   allowlist が黙って腐らないよう、**ここに書いたのに実際は strip されていない**場合も失敗させる。
 */
export function expectNoStrippedKeys(
	before: unknown,
	after: unknown,
	label: string,
	knownStrips: readonly string[] = [],
): void {
	const beforePaths = keyPaths(before);
	const afterPaths = keyPaths(after);

	const stripped = [...beforePaths].filter((path) => !afterPaths.has(path));
	const known = new Set(knownStrips);
	// 既知として挙げたのに実際は strip されていない（＝宣言済みになった）ものは、
	// allowlist から消させるために失敗させる。放置すると allowlist が実態と乖離する。
	expect(
		knownStrips.filter((path) => !stripped.includes(path)),
		`${label}: knownStrips に挙がっているが実際には strip されていないキー（allowlist から消すこと）`,
	).toEqual([]);
	expect(
		stripped.filter((path) => !known.has(path)),
		`${label}: 載せているが出力スキーマに宣言が無く、parse で strip されているキー（スキーマに宣言を足すこと）`,
	).toEqual([]);

	// 逆向き。Zod は optional 未指定のキーを足さないので、parse 後にだけ現れるキーは無いはず。
	// 出たら宣言側の `.default()` 等を疑う。
	const invented = [...afterPaths].filter((path) => !beforePaths.has(path));
	expect(invented, `${label}: parse 後にだけ現れるキー`).toEqual([]);
}
