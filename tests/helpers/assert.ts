// `expect(x).toBeDefined()` は TS の型を絞らず、`x!.foo` だと undefined のときの失敗がプロパティ参照になってどの値が欠けていたのか分からないので、絞り込みと診断（失敗時に値をメッセージに含める）を同時に満たすヘルパ。

export function assertDefined<T>(value: T, label: string): asserts value is NonNullable<T> {
	if (value === undefined || value === null) {
		throw new Error(`${label} is ${value === undefined ? 'undefined' : 'null'} (expected defined)`);
	}
}

export function requireDefined<T>(value: T, label: string): NonNullable<T> {
	assertDefined(value, label);
	return value;
}

// expect を catch の中に書くと条件付きの expect になるので、拒否された値を取り出して外で確かめる。
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (err) {
		return err;
	}
	throw new Error('expected the promise to reject, but it resolved');
}
