// 未知キーは既定値のまま黙って実行され、非整数の期間は指標の添字に使えず全 NaN になるので、どちらも弾く（issue 443）。
export function checkParamShape(
	params: Record<string, number>,
	defaults: Record<string, number>,
	integerKeys: readonly string[],
): string[] {
	const errors: string[] = [];
	const allowed = Object.keys(defaults);
	for (const key of Object.keys(params)) {
		if (!Object.hasOwn(defaults, key)) {
			errors.push(`unknown param '${key}' (allowed: ${allowed.join(', ')})`);
		}
	}
	for (const key of integerKeys) {
		const value = params[key];
		if (value !== undefined && !Number.isInteger(value)) {
			errors.push(`${key} must be an integer`);
		}
	}
	return errors;
}
