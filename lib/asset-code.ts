// 正規化は取得境界に集約し、消費側（portfolio/calc.ts 等）に .toLowerCase() を撒かない。大文字が混ざると JPY が純入出金から落ち、保有キーが割れて二重計上になる。

export function normalizeAssetCode(raw: string): string {
	return raw.trim().toLowerCase();
}

export function normalizeAssetCodes<T extends { asset: string }>(records: readonly T[]): T[] {
	return records.map((record) => {
		// asset が欠けていても取得層で throw させない。
		if (typeof record.asset !== 'string') return record;
		const asset = normalizeAssetCode(record.asset);
		return asset === record.asset ? record : { ...record, asset };
	});
}
