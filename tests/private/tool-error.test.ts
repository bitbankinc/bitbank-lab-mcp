/**
 * failPrivateToolError（src/private/tool-error.ts）のユニットテスト。
 *
 * Private ツールの catch 経路で、未知エラー（プログラミングエラー・lib 由来例外・
 * ZodError 等）の内部 message を Result（summary）へ漏らさず、PrivateApiError の
 * 分類済み文言のみを素通しすることを検証する（情報漏洩防止 regression）。
 */

import { describe, expect, it } from 'vitest';
import { getBitbankErrorMessage } from '../../src/lib/bitbank-errors.js';
import { PrivateApiError } from '../../src/private/client.js';
import { failPrivateToolError } from '../../src/private/tool-error.js';
import { assertFail } from '../_assertResult.js';

const FALLBACK = 'フォールバック文言（内部詳細なし）';

describe('failPrivateToolError', () => {
	it('PrivateApiError は分類済み message と errorType を素通しする', () => {
		const err = new PrivateApiError('数量が最低取引量を下回っています', 'validation_error', 400, 60003);
		const result = failPrivateToolError(err, FALLBACK);

		assertFail(result);
		expect(result.summary).toBe('Error: 数量が最低取引量を下回っています');
		expect(result.meta.errorType).toBe('validation_error');
	});

	it('未知の Error は err.message を漏らさず汎用文に置換する', () => {
		const err = new Error('/home/user/secret/path.ts:42 internal boom token=abc');
		const result = failPrivateToolError(err, FALLBACK);

		assertFail(result);
		expect(result.summary).not.toContain('secret');
		expect(result.summary).not.toContain('boom');
		expect(result.summary).not.toContain('token=');
		expect(result.summary).toBe(`Error: ${FALLBACK}`);
		expect(result.meta.errorType).toBe('upstream_error');
	});

	it('TypeError（プログラミングエラー）も message を漏らさない', () => {
		const err = new TypeError("Cannot read properties of undefined (reading 'order_id')");
		const result = failPrivateToolError(err, FALLBACK);

		assertFail(result);
		expect(result.summary).not.toContain('undefined');
		expect(result.summary).toBe(`Error: ${FALLBACK}`);
		expect(result.meta.errorType).toBe('upstream_error');
	});

	it('Error 以外（文字列 throw 等）でも汎用文を返す', () => {
		const result = failPrivateToolError('raw string error', FALLBACK);

		assertFail(result);
		expect(result.summary).toBe(`Error: ${FALLBACK}`);
		expect(result.meta.errorType).toBe('upstream_error');
	});

	it('name / errorType を偽装した一般 Error は素通ししない（instanceof で判定）', () => {
		const forged = new Error('forged internal detail');
		(forged as unknown as { name: string }).name = 'PrivateApiError';
		(forged as unknown as { errorType: string }).errorType = 'authentication_error';

		const result = failPrivateToolError(forged, FALLBACK);

		assertFail(result);
		expect(result.summary).not.toContain('forged');
		expect(result.summary).toBe(`Error: ${FALLBACK}`);
		expect(result.meta.errorType).toBe('upstream_error');
	});

	describe('remapBitbankCode', () => {
		it('true: 既知 bitbankCode を共通テーブルの文言へ再マップする', () => {
			const mapped = getBitbankErrorMessage(60003);
			expect(mapped).toBeDefined();

			// client が別文言で生成しても、remap で共通テーブル文言に揃える
			const err = new PrivateApiError('raw client message', 'validation_error', 400, 60003);
			const result = failPrivateToolError(err, FALLBACK, { remapBitbankCode: true });

			assertFail(result);
			expect(result.summary).toBe(`Error: ${mapped}`);
			expect(result.meta.errorType).toBe('validation_error');
		});

		it('true: 未登録 bitbankCode は err.message にフォールバックする', () => {
			expect(getBitbankErrorMessage(999999)).toBeUndefined();

			const err = new PrivateApiError('classified message', 'upstream_error', 400, 999999);
			const result = failPrivateToolError(err, FALLBACK, { remapBitbankCode: true });

			assertFail(result);
			expect(result.summary).toBe('Error: classified message');
		});

		it('false（デフォルト）: bitbankCode があっても err.message をそのまま使う', () => {
			const err = new PrivateApiError('raw client message', 'validation_error', 400, 60003);
			const result = failPrivateToolError(err, FALLBACK);

			assertFail(result);
			expect(result.summary).toBe('Error: raw client message');
		});
	});
});
