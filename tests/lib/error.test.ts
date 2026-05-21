import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getErrorMessage, isAbortError, toPublicError } from '../../lib/error.js';

describe('getErrorMessage', () => {
	it('Error インスタンスから message を取得する', () => {
		expect(getErrorMessage(new Error('test error'))).toBe('test error');
	});
	it('文字列はそのまま返す', () => {
		expect(getErrorMessage('string error')).toBe('string error');
	});
	it('数値は String() で変換する', () => {
		expect(getErrorMessage(42)).toBe('42');
	});
	it('null は "null" を返す', () => {
		expect(getErrorMessage(null)).toBe('null');
	});
	it('undefined は "undefined" を返す', () => {
		expect(getErrorMessage(undefined)).toBe('undefined');
	});
});

describe('isAbortError', () => {
	it('AbortError を検出する', () => {
		const err = new DOMException('The operation was aborted', 'AbortError');
		expect(isAbortError(err)).toBe(true);
	});
	it('通常の Error は false を返す', () => {
		expect(isAbortError(new Error('test'))).toBe(false);
	});
	it('非 Error 型は false を返す', () => {
		expect(isAbortError('string')).toBe(false);
		expect(isAbortError(null)).toBe(false);
	});
});

describe('toPublicError', () => {
	it('ZodError は詳細メッセージを汎用文に置き換え errorType を validation_error にする', () => {
		const schema = z.object({ pair: z.string() });
		let zodErr: unknown;
		try {
			schema.parse({ pair: 123 });
		} catch (e) {
			zodErr = e;
		}
		const result = toPublicError(zodErr);
		expect(result.summary).toBe('入力形式が不正です。パラメータを確認してください');
		expect(result.errorType).toBe('validation_error');
		// 元の Zod 詳細（"Expected"、フィールド名 "pair"）が漏れていないこと
		expect(result.summary).not.toContain('Expected');
		expect(result.summary).not.toContain('pair');
	});

	it('PrivateApiError は message と errorType を素通しする', () => {
		class PrivateApiError extends Error {
			errorType: string;
			constructor(message: string, errorType: string) {
				super(message);
				this.name = 'PrivateApiError';
				this.errorType = errorType;
			}
		}
		const err = new PrivateApiError('数量が最低取引量を下回っています', 'invalid_amount');
		const result = toPublicError(err);
		expect(result.summary).toBe('数量が最低取引量を下回っています');
		expect(result.errorType).toBe('invalid_amount');
	});

	it('一般 Error は本文を漏らさず汎用文に置き換える', () => {
		const err = new Error("ENOENT: no such file or directory, open '/local/path/foo.ts'");
		const result = toPublicError(err);
		expect(result.summary).toBe('内部エラーが発生しました。ログを確認してください');
		expect(result.errorType).toBe('internal');
		expect(result.summary).not.toContain('/local/path/foo.ts');
		expect(result.summary).not.toContain('ENOENT');
	});

	it('非 Error 値も汎用文に正規化する', () => {
		expect(toPublicError('raw string err')).toEqual({
			summary: '内部エラーが発生しました。ログを確認してください',
			errorType: 'internal',
		});
		expect(toPublicError(undefined)).toEqual({
			summary: '内部エラーが発生しました。ログを確認してください',
			errorType: 'internal',
		});
	});

	it('PrivateApiError 様だが errorType がない場合は素通ししない', () => {
		// name だけが PrivateApiError でも errorType が無い偽物は internal 扱い
		const err = new Error('fake error');
		err.name = 'PrivateApiError';
		const result = toPublicError(err);
		expect(result.summary).toBe('内部エラーが発生しました。ログを確認してください');
		expect(result.errorType).toBe('internal');
	});
});
