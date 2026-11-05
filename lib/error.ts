import { ZodError } from 'zod';
import { PrivateApiError } from '../src/private/client.js';

export function getErrorMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	if (typeof e === 'string') return e;
	return String(e);
}

export function isAbortError(e: unknown): boolean {
	return e instanceof Error && e.name === 'AbortError';
}

export interface PublicError {
	summary: string;
	errorType: string;
}

// ZodError とその他の例外はローカルパスや入力断片を含みうるので汎用文に置き換え、PrivateApiError（instanceof で判定）だけ業務エラー文言を素通しする。ログには getErrorMessage を使う。
export function toPublicError(e: unknown): PublicError {
	if (e instanceof ZodError) {
		return {
			summary: '入力形式が不正です。パラメータを確認してください',
			errorType: 'validation_error',
		};
	}
	if (e instanceof PrivateApiError) {
		return {
			summary: e.message,
			errorType: e.errorType,
		};
	}
	return {
		summary: '内部エラーが発生しました。ログを確認してください',
		errorType: 'internal',
	};
}
