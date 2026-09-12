/**
 * analyze_my_portfolio 系テスト用のフィクスチャ取り出しヘルパ。
 */

/**
 * holdings から指定 asset の保有を取り出す。
 *
 * `holdings.find(...)` の戻りは `T | undefined` なので、そのまま参照すると
 * 型エラーになるうえ、実際に見つからなかったときは「undefined のプロパティ参照」で
 * 落ちて原因が読めない。見つからない場合は探した asset と実際に載っている
 * asset 一覧を添えて落とす。
 */
export function holdingOf<T extends { asset: string }>(holdings: readonly T[], asset: string): T {
	const found = holdings.find((h) => h.asset === asset);
	if (found === undefined) {
		throw new Error(`holding '${asset}' not found in holdings (present: [${holdings.map((h) => h.asset).join(', ')}])`);
	}
	return found;
}
