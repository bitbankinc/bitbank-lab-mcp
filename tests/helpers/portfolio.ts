/** `holdings.find(...)` をそのまま参照すると、見つからなかったときに undefined のプロパティ参照で落ちて原因が読めないので、探した asset と実際に載っている asset 一覧を添えて落とす。 */
export function holdingOf<T extends { asset: string }>(holdings: readonly T[], asset: string): T {
	const found = holdings.find((h) => h.asset === asset);
	if (found === undefined) {
		throw new Error(`holding '${asset}' not found in holdings (present: [${holdings.map((h) => h.asset).join(', ')}])`);
	}
	return found;
}
