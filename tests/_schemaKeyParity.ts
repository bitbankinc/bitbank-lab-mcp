// Zod の object は未宣言のキーを黙って落とすので、出力スキーマへの宣言を忘れたフィールドは parse 成功のまま消える。それを検出するための共有ヘルパ。
// 全ツールを自動で舐める横断テストにしないのは、`ToolDefinition` が `outputSchema` を持たず、上流のフィクスチャもツールごとに違うため（#184）。
import { expect } from 'vitest';

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 配列は `[]` を挟んで全要素を合算し（要素ごとに持つキーが違う）、`undefined` の値はキーが無いのと同じに扱う（Zod も optional 未指定のキーを落とすので、区別すると常に偽陽性になる）。 */
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

/** `knownStrips` を増やすときは呼び出し側に理由を必ず書く。 */
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
	// 既知として挙げたのに実際は strip されていない（＝宣言済みになった）ものは、allowlist から消させるために失敗させる。
	expect(
		knownStrips.filter((path) => !stripped.includes(path)),
		`${label}: knownStrips に挙がっているが実際には strip されていないキー（allowlist から消すこと）`,
	).toEqual([]);
	expect(
		stripped.filter((path) => !known.has(path)),
		`${label}: 載せているが出力スキーマに宣言が無く、parse で strip されているキー（スキーマに宣言を足すこと）`,
	).toEqual([]);

	// 逆向き。Zod は optional 未指定のキーを足さないので、parse 後にだけ現れるキーは無いはず。出たら宣言側の `.default()` 等を疑う。
	const invented = [...afterPaths].filter((path) => !beforePaths.has(path));
	expect(invented, `${label}: parse 後にだけ現れるキー`).toEqual([]);
}
