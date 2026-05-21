import { ZodError } from 'zod';

/**
 * unknown型のエラーからメッセージを安全に取得する
 */
export function getErrorMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	if (typeof e === 'string') return e;
	return String(e);
}

/**
 * AbortErrorかどうかを判定する
 */
export function isAbortError(e: unknown): boolean {
	return e instanceof Error && e.name === 'AbortError';
}

/** ユーザ応答層に渡す安全なエラー表現 */
export interface PublicError {
	summary: string;
	errorType: string;
}

/**
 * 捕捉した例外をユーザ応答に出してよい形へ正規化する。
 *
 * - `ZodError`: 詳細メッセージはローカルパスや入力断片を含む場合があるため汎用文に置き換え
 * - `PrivateApiError` (構造判定): bitbank の業務エラー文言は素通し（"数量が最低取引量を下回っています" 等）
 * - その他: ローカルパスや fs / 内部ロジック由来の message を漏らさないため汎用文に置き換え
 *
 * ログ用途では引き続き `getErrorMessage(err)` を使うこと。
 */
export function toPublicError(e: unknown): PublicError {
	if (e instanceof ZodError) {
		return {
			summary: '入力形式が不正です。パラメータを確認してください',
			errorType: 'validation_error',
		};
	}
	if (
		e instanceof Error &&
		e.name === 'PrivateApiError' &&
		typeof (e as Error & { errorType?: unknown }).errorType === 'string'
	) {
		return {
			summary: e.message,
			errorType: (e as Error & { errorType: string }).errorType,
		};
	}
	return {
		summary: '内部エラーが発生しました。ログを確認してください',
		errorType: 'internal',
	};
}
