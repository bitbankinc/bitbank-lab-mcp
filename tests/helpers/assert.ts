/**
 * 値の存在を表明しつつ型を絞り込むテスト用ヘルパ。
 *
 * `expect(x).toBeDefined()` は TS の型を絞らないため、直後の `x.foo` が
 * `possibly 'undefined'` になる。かといって `x!.foo` と書くと、実際に
 * undefined だったときの失敗が「undefined のプロパティ参照」になり、
 * どの値が欠けていたのか分からない。
 *
 * ここのヘルパは絞り込みと診断を同時に満たす —— 失敗時は「どの値が
 * 何だったか」をメッセージに含めて落ちる。
 */

/** 値が null / undefined でないことを表明し、以降の参照で型を絞る。 */
export function assertDefined<T>(value: T, label: string): asserts value is NonNullable<T> {
	if (value === undefined || value === null) {
		throw new Error(`${label} is ${value === undefined ? 'undefined' : 'null'} (expected defined)`);
	}
}

/**
 * `assertDefined` の式版。宣言と同時に絞り込みたい場合に使う。
 *
 * @example
 * const pnl = requireDefined(result.data.account_pnl, 'result.data.account_pnl');
 */
export function requireDefined<T>(value: T, label: string): NonNullable<T> {
	assertDefined(value, label);
	return value;
}
