import type { FailResult, OkResult } from '../src/schemas.js';
import { getErrorMessage, isAbortError } from './error.js';

export function ok<T = Record<string, unknown>, M = Record<string, unknown>>(
	summary: string,
	data: T = {} as T,
	meta: M = {} as M,
): OkResult<T, M> {
	return {
		ok: true,
		summary,
		data,
		meta,
	};
}

export function fail<M = Record<string, unknown>>(
	message: string,
	type: string = 'user',
	meta: M = {} as M,
): FailResult<M> {
	return {
		ok: false,
		summary: `Error: ${message}`,
		data: {},
		meta: { errorType: type, ...(meta as object) } as FailResult<M>['meta'],
	};
}

export interface FailFromErrorOptions {
	schema?: { parse: (v: unknown) => unknown };
	timeoutMs?: number;
	defaultType?: string;
	defaultMessage?: string;
}

export function failFromError(err: unknown, opts: FailFromErrorOptions = {}): ReturnType<typeof fail> {
	const { schema, timeoutMs, defaultType = 'internal', defaultMessage = 'internal error' } = opts;

	let message: string;
	let errorType: string;

	if (timeoutMs != null && isAbortError(err)) {
		message = `タイムアウト (${timeoutMs}ms)`;
		errorType = 'timeout';
	} else {
		message = getErrorMessage(err) || defaultMessage;
		errorType = defaultType;
	}

	const result = fail(message, errorType);
	return (schema ? schema.parse(result) : result) as ReturnType<typeof fail>;
}

// toolResultSchema の z.infer 型は FailResult の meta 型の推論差異で直接代入できないので、キャストをここに集約する。
export function parseAsResult<T, M>(
	schema: { parse: (v: unknown) => unknown },
	value: unknown,
): OkResult<T, M> | FailResult {
	return schema.parse(value) as OkResult<T, M> | FailResult;
}

export function failFromValidation(
	result: { error: { message: string; type: string } },
	schema?: { parse: (v: unknown) => unknown },
): FailResult {
	const f = fail(result.error.message, result.error.type);
	return (schema ? schema.parse(f) : f) as FailResult;
}

// Result は structuredContent の Record<string, unknown> に直接代入できないので、キャストをここに集約する。
export function toStructured(result: object): Record<string, unknown> {
	return result as Record<string, unknown>;
}
