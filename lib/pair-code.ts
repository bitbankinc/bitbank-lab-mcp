// 正規化は取得境界に集約し、消費側（portfolio/calc.ts / 各 Private ツール）に .toLowerCase() を撒かない。現行 API は小文字を返すので防御的な正規化。
// ユーザー入力の normalizePair（lib/validate.ts）とは別レイヤーで、drop も throw もしない（上場廃止ペアの履歴を取得層で落とさない）。

export function normalizePairCode(raw: string): string {
	return raw.trim().toLowerCase();
}

// 既存の includes('jpy') 挙動を保つので base 側の JPY も真になる。ユーザー入力由来の pair も通るので判定側で正規化する。
export function isJpyQuotedPair(pair: string): boolean {
	return normalizePairCode(pair).includes('jpy');
}

export function withNormalizedPair<T extends { pair: string }>(record: T): T {
	// pair が欠けていても取得層で throw させない。
	if (typeof record.pair !== 'string') return record;
	const pair = normalizePairCode(record.pair);
	return pair === record.pair ? record : { ...record, pair };
}

export function normalizePairCodes<T extends { pair: string }>(records: readonly T[]): T[] {
	return records.map(withNormalizedPair);
}
