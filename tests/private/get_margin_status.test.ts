/**
 * get_margin_status ツールのユニットテスト。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFail, assertOk } from '../_assertResult.js';
import { mockBitbankError, mockBitbankSuccess, rawMarginStatusResponse } from '../fixtures/private-api.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env.BITBANK_API_KEY;
	delete process.env.BITBANK_API_SECRET;
	vi.resetModules();
});

function setupFetchMock(response: unknown, status = 200) {
	globalThis.fetch = vi
		.fn()
		.mockResolvedValue(new Response(JSON.stringify(response), { status })) as unknown as typeof fetch;
}

describe('get_margin_status', () => {
	it('NORMAL ステータスで正常に返す', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginStatusResponse));

		const { default: getMarginStatus } = await import('../../tools/private/get_margin_status.js');
		const result = await getMarginStatus({});

		assertOk(result);
		expect(result.data.status).toBe('NORMAL');
		expect(result.data.total_margin_balance).toBe('1000000');
		expect(result.data.buy_credit).toBe('500000');
		expect(result.data.sell_credit).toBe('450000');
		expect(result.data.available_balances).toHaveLength(2);
		expect(result.data.available_balances[0]).toEqual({ pair: 'btc_jpy', long: '500000', short: '450000' });
		expect(result.meta.hasWarning).toBe(false);
	});

	it('サマリーに保証金情報を含む', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginStatusResponse));

		const { default: getMarginStatus } = await import('../../tools/private/get_margin_status.js');
		const result = await getMarginStatus({});

		assertOk(result);
		expect(result.summary).toContain('正常');
		expect(result.summary).toContain('保証金合計');
		expect(result.summary).toContain('保証金率');
		expect(result.summary).toContain('250.00%');
	});

	it('CALL ステータスで警告を返す', async () => {
		const callStatus = { ...rawMarginStatusResponse, status: 'CALL' };
		setupFetchMock(mockBitbankSuccess(callStatus));

		const { default: getMarginStatus } = await import('../../tools/private/get_margin_status.js');
		const result = await getMarginStatus({});

		assertOk(result);
		expect(result.data.status).toBe('CALL');
		expect(result.meta.hasWarning).toBe(true);
		expect(result.summary).toContain('追証発生中');
		expect(result.summary).toContain('追証が発生しています');
	});

	it('LOSSCUT ステータスで警告を返す', async () => {
		const losscutStatus = { ...rawMarginStatusResponse, status: 'LOSSCUT' };
		setupFetchMock(mockBitbankSuccess(losscutStatus));

		const { default: getMarginStatus } = await import('../../tools/private/get_margin_status.js');
		const result = await getMarginStatus({});

		assertOk(result);
		expect(result.data.status).toBe('LOSSCUT');
		expect(result.meta.hasWarning).toBe(true);
		expect(result.summary).toContain('強制決済');
	});

	it('DEBT ステータスで警告を返す', async () => {
		const debtStatus = { ...rawMarginStatusResponse, status: 'DEBT' };
		setupFetchMock(mockBitbankSuccess(debtStatus));

		const { default: getMarginStatus } = await import('../../tools/private/get_margin_status.js');
		const result = await getMarginStatus({});

		assertOk(result);
		expect(result.data.status).toBe('DEBT');
		expect(result.meta.hasWarning).toBe(true);
		expect(result.summary).toContain('不足金が発生しています');
	});

	it('SETTLED ステータスを正常に処理する（警告なし）', async () => {
		const settledStatus = { ...rawMarginStatusResponse, status: 'SETTLED' };
		setupFetchMock(mockBitbankSuccess(settledStatus));

		const { default: getMarginStatus } = await import('../../tools/private/get_margin_status.js');
		const result = await getMarginStatus({});

		assertOk(result);
		expect(result.data.status).toBe('SETTLED');
		expect(result.meta.hasWarning).toBe(false);
		expect(result.summary).toContain('精算済み');
		// SETTLED は特別な警告メッセージを持たない
		expect(result.summary).not.toContain('⚠');
	});

	it('建玉なし（null フィールド）を正常に処理する', async () => {
		const noPositions = {
			...rawMarginStatusResponse,
			total_margin_balance_percentage: null,
			margin_call_percentage: null,
			losscut_percentage: null,
		};
		setupFetchMock(mockBitbankSuccess(noPositions));

		const { default: getMarginStatus } = await import('../../tools/private/get_margin_status.js');
		const result = await getMarginStatus({});

		assertOk(result);
		expect(result.data.total_margin_balance_percentage).toBeNull();
		expect(result.data.losscut_percentage).toBeNull();
		expect(result.data.margin_call_percentage).toBeNull();
		expect(result.summary).not.toContain('保証金率');
		expect(result.summary).not.toContain('強制決済率');
	});

	it('PrivateApiError で fail を返す', async () => {
		setupFetchMock(mockBitbankError(20001), 400);

		const { default: getMarginStatus } = await import('../../tools/private/get_margin_status.js');
		const result = await getMarginStatus({});

		assertFail(result);
		expect(result.meta.errorType).toBe('authentication_error');
	});

	it('非 PrivateApiError の例外で upstream_error を返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;

		const { default: getMarginStatus } = await import('../../tools/private/get_margin_status.js');
		const result = await getMarginStatus({});

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');
		expect(result.summary).toContain('fetch failed');
	});

	it('サマリーに維持保証金・建玉評価額・新規建て可能額を含む', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginStatusResponse));

		const { default: getMarginStatus } = await import('../../tools/private/get_margin_status.js');
		const result = await getMarginStatus({});

		assertOk(result);
		expect(result.summary).toContain('維持保証金合計');
		expect(result.summary).toContain('ロング');
		expect(result.summary).toContain('ショート');
		expect(result.summary).toContain('建玉総評価額');
		expect(result.summary).toContain('新規建て可能額');
	});

	it('強制決済率が設定されている場合サマリーに含む', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginStatusResponse));

		const { default: getMarginStatus } = await import('../../tools/private/get_margin_status.js');
		const result = await getMarginStatus({});

		assertOk(result);
		expect(result.summary).toContain('強制決済率');
		expect(result.summary).toContain('110.00%');
	});

	it('全数値フィールドが data に正しくマッピングされる', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginStatusResponse));

		const { default: getMarginStatus } = await import('../../tools/private/get_margin_status.js');
		const result = await getMarginStatus({});

		assertOk(result);
		expect(result.data.margin_position_profit_loss).toBe('50000');
		expect(result.data.unrealized_cost).toBe('1200');
		expect(result.data.total_margin_position_product).toBe('400000');
		expect(result.data.open_margin_position_product).toBe('300000');
		expect(result.data.open_margin_order_product).toBe('100000');
		expect(result.data.total_position_maintenance_margin).toBe('120000');
		expect(result.data.total_long_position_maintenance_margin).toBe('80000');
		expect(result.data.total_short_position_maintenance_margin).toBe('40000');
		expect(result.data.total_open_order_maintenance_margin).toBe('30000');
	});
});

describe('get_margin_status — handler (toolDef)', () => {
	it('handler がデフォルト引数で動作する', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginStatusResponse));

		const { toolDef } = await import('../../tools/private/get_margin_status.js');
		const result = await toolDef.handler({});

		expect((result as { ok: boolean }).ok).toBe(true);
	});
});

/**
 * API が返す pair は取得境界で小文字へ正規化する（`lib/pair-code.ts`）。
 * `data.available_balances[].pair` は structuredContent に公開されるので小文字契約を保つ。
 * 表示は `formatPair`（`toUpperCase()`）なので従来どおり大文字。防御的正規化（現行 API は小文字）。
 */
describe('get_margin_status — API pair の取得境界正規化', () => {
	it('小文字レスポンスでは出力が変わらない（回帰なし）', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginStatusResponse));

		const { default: getMarginStatus } = await import('../../tools/private/get_margin_status.js');
		const result = await getMarginStatus({});

		assertOk(result);
		expect(result.data.available_balances).toEqual(rawMarginStatusResponse.available_balances);
	});

	/**
	 * 正規化契約は「前後の空白除去 + 小文字化」の 2 つ。空白側は `formatPair`（`toUpperCase()`）
	 * では落ちないので、サマリーが正規化前の値を読み直していると空白が表示に残る。
	 * 本ツールは raw を 2 回読んでいて片方だけ未正規化だった（PR #39 レビュー指摘）ので、
	 * サマリーと data の両方を固定して回帰を防ぐ。
	 */
	it('前後に空白を含むレスポンスでもサマリー・data の両方から空白が落ちる', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				...rawMarginStatusResponse,
				available_balances: rawMarginStatusResponse.available_balances.map((b) => ({
					...b,
					pair: `  ${b.pair.toUpperCase()} `,
				})),
			}),
		);

		const { default: getMarginStatus } = await import('../../tools/private/get_margin_status.js');
		const result = await getMarginStatus({});

		assertOk(result);
		expect(result.data.available_balances.map((b) => b.pair)).toEqual(['btc_jpy', 'eth_jpy']);
		// 表示は formatPair で大文字。空白が残ると '  BTC/JPY  — ' のようにズレる
		expect(result.summary).toContain('  BTC/JPY — ロング:');
		expect(result.summary).not.toContain('BTC/JPY  —');
		expect(result.summary).not.toContain('   BTC/JPY');
	});

	it('大文字レスポンスでも structuredContent の pair は小文字契約を保つ', async () => {
		setupFetchMock(
			mockBitbankSuccess({
				...rawMarginStatusResponse,
				available_balances: rawMarginStatusResponse.available_balances.map((b) => ({
					...b,
					pair: b.pair.toUpperCase(),
				})),
			}),
		);

		const { default: getMarginStatus } = await import('../../tools/private/get_margin_status.js');
		const result = await getMarginStatus({});

		assertOk(result);
		expect(result.data.available_balances.map((b) => b.pair)).toEqual(['btc_jpy', 'eth_jpy']);
		// 数量フィールドは触らない
		expect(result.data.available_balances[0]).toEqual({ pair: 'btc_jpy', long: '500000', short: '450000' });
	});
});
