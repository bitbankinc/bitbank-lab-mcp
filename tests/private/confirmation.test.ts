/**
 * HITL 確認トークンのユニットテスト。
 * トークン生成・検証、有効期限、パラメータ改ざん検知を検証する。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	_isCleanupTimerActive,
	_resetUsedTokens,
	_usedTokenCount,
	generateToken,
	purgeExpiredTokens,
	startCleanupTimer,
	stopCleanupTimer,
	validateToken,
} from '../../src/private/confirmation.js';

beforeEach(() => {
	process.env.BITBANK_API_SECRET = 'test_secret_for_hmac';
});

afterEach(() => {
	delete process.env.BITBANK_API_SECRET;
	delete process.env.ORDER_CONFIRM_TTL_MS;
	_resetUsedTokens();
	stopCleanupTimer();
});

describe('generateToken', () => {
	it('トークンと有効期限を返す', () => {
		const now = 1700000000000;
		const result = generateToken('create_order', { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit' }, now);

		expect(result.token).toMatch(/^[0-9a-f]{64}$/);
		expect(result.expiresAt).toBe(now + 60_000);
	});

	it('ORDER_CONFIRM_TTL_MS で有効期限を変更できる', () => {
		process.env.ORDER_CONFIRM_TTL_MS = '30000';
		const now = 1700000000000;
		const result = generateToken('create_order', { pair: 'btc_jpy' }, now);

		expect(result.expiresAt).toBe(now + 30_000);
	});

	it('ORDER_CONFIRM_TTL_MS が上限（5分）を超える場合はキャップされる', () => {
		process.env.ORDER_CONFIRM_TTL_MS = '600000'; // 10分
		const now = 1700000000000;
		const result = generateToken('create_order', { pair: 'btc_jpy' }, now);

		expect(result.expiresAt).toBe(now + 300_000); // 5分にキャップ
	});

	it('ORDER_CONFIRM_TTL_MS がちょうど上限の場合はそのまま使われる', () => {
		process.env.ORDER_CONFIRM_TTL_MS = '300000';
		const now = 1700000000000;
		const result = generateToken('create_order', { pair: 'btc_jpy' }, now);

		expect(result.expiresAt).toBe(now + 300_000);
	});

	it('同じパラメータで同じトークンを生成する（決定的）', () => {
		const now = 1700000000000;
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit' };
		const r1 = generateToken('create_order', params, now);
		const r2 = generateToken('create_order', params, now);

		expect(r1.token).toBe(r2.token);
	});

	it('異なるパラメータで異なるトークンを生成する', () => {
		const now = 1700000000000;
		const r1 = generateToken('create_order', { pair: 'btc_jpy', amount: '0.001' }, now);
		const r2 = generateToken('create_order', { pair: 'eth_jpy', amount: '0.001' }, now);

		expect(r1.token).not.toBe(r2.token);
	});
});

describe('validateToken', () => {
	it('正常系: 生成直後のトークンは検証を通過する', () => {
		const now = 1700000000000;
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit' };
		const { token, expiresAt } = generateToken('create_order', params, now);

		const error = validateToken(token, 'create_order', params, expiresAt, now + 1000);
		expect(error).toBeNull();
	});

	it('有効期限ギリギリ（ちょうど期限時刻）でも通過する', () => {
		const now = 1700000000000;
		const params = { pair: 'btc_jpy', amount: '0.001' };
		const { token, expiresAt } = generateToken('create_order', params, now);

		const error = validateToken(token, 'create_order', params, expiresAt, expiresAt);
		expect(error).toBeNull();
	});

	it('有効期限切れのトークンを拒否する', () => {
		const now = 1700000000000;
		const params = { pair: 'btc_jpy', amount: '0.001' };
		const { token, expiresAt } = generateToken('create_order', params, now);

		const error = validateToken(token, 'create_order', params, expiresAt, expiresAt + 1);
		expect(error?.code).toBe('token_expired');
		expect(error?.message).toContain('有効期限');
	});

	it('パラメータ改ざん（amount 変更）を検知する', () => {
		const now = 1700000000000;
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit' };
		const { token, expiresAt } = generateToken('create_order', params, now);

		// amount を改ざん
		const tampered = { ...params, amount: '100' };
		const error = validateToken(token, 'create_order', tampered, expiresAt, now + 1000);
		expect(error?.code).toBe('token_invalid');
		expect(error?.message).toContain('無効');
	});

	it('パラメータ改ざん（pair 変更）を検知する', () => {
		const now = 1700000000000;
		const params = { pair: 'btc_jpy', amount: '0.001' };
		const { token, expiresAt } = generateToken('create_order', params, now);

		const tampered = { ...params, pair: 'eth_jpy' };
		const error = validateToken(token, 'create_order', tampered, expiresAt, now + 1000);
		expect(error?.code).toBe('token_invalid');
		expect(error?.message).toContain('無効');
	});

	it('不正トークン（ランダム文字列）を拒否する', () => {
		const now = 1700000000000;
		const params = { pair: 'btc_jpy', amount: '0.001' };
		const { expiresAt } = generateToken('create_order', params, now);

		const error = validateToken('deadbeef'.repeat(8), 'create_order', params, expiresAt, now + 1000);
		expect(error?.code).toBe('token_invalid');
	});

	it('長さ不一致のトークンを拒否する（タイミングセーフ）', () => {
		const now = 1700000000000;
		const params = { pair: 'btc_jpy', amount: '0.001' };
		const { expiresAt } = generateToken('create_order', params, now);

		const error = validateToken('short', 'create_order', params, expiresAt, now + 1000);
		expect(error?.code).toBe('token_invalid');
	});

	it('空文字列トークンを拒否する', () => {
		const now = 1700000000000;
		const params = { pair: 'btc_jpy', amount: '0.001' };
		const { expiresAt } = generateToken('create_order', params, now);

		const error = validateToken('', 'create_order', params, expiresAt, now + 1000);
		expect(error?.code).toBe('token_invalid');
	});

	it('異なる action でのトークン使い回しを拒否する', () => {
		const now = 1700000000000;
		const params = { pair: 'btc_jpy', order_id: 123 };
		const { token, expiresAt } = generateToken('cancel_order', params, now);

		// cancel_order 用トークンを cancel_orders で使おうとする
		const error = validateToken(token, 'cancel_orders', params, expiresAt, now + 1000);
		expect(error?.code).toBe('token_invalid');
	});

	it('cancel_order の正常系', () => {
		const now = 1700000000000;
		const params = { pair: 'btc_jpy', order_id: 12345 };
		const { token, expiresAt } = generateToken('cancel_order', params, now);

		const error = validateToken(token, 'cancel_order', params, expiresAt, now + 1000);
		expect(error).toBeNull();
	});

	it('cancel_orders の正常系', () => {
		const now = 1700000000000;
		const params = { pair: 'btc_jpy', order_ids: [1001, 1002, 1003] };
		const { token, expiresAt } = generateToken('cancel_orders', params, now);

		const error = validateToken(token, 'cancel_orders', params, expiresAt, now + 1000);
		expect(error).toBeNull();
	});

	it('使用済みトークンの再利用は token_already_used で拒否される', () => {
		const now = 1700000000000;
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit' };
		const { token, expiresAt } = generateToken('create_order', params, now);

		// 1回目: 成功
		const first = validateToken(token, 'create_order', params, expiresAt, now + 1000);
		expect(first).toBeNull();

		// 2回目: 使用済みで拒否（コードまで一致を確認）
		const second = validateToken(token, 'create_order', params, expiresAt, now + 2000);
		expect(second?.code).toBe('token_already_used');
		expect(second?.message).toContain('既に使用されています');
	});

	it('使用済みトークンは usedTokens に登録される', () => {
		const now = 1700000000000;
		const params = { pair: 'btc_jpy', amount: '0.001' };
		const { token, expiresAt } = generateToken('create_order', params, now);

		expect(_usedTokenCount()).toBe(0);
		validateToken(token, 'create_order', params, expiresAt, now + 1000);
		expect(_usedTokenCount()).toBe(1);
	});

	it('検証失敗したトークンは使用済みに登録されない', () => {
		const now = 1700000000000;
		const params = { pair: 'btc_jpy', amount: '0.001' };
		const { expiresAt } = generateToken('create_order', params, now);

		// 不正トークンで検証失敗
		validateToken('deadbeef'.repeat(8), 'create_order', params, expiresAt, now + 1000);
		expect(_usedTokenCount()).toBe(0);
	});

	it('期限切れトークンは使用済みチェックの前に拒否される', () => {
		const now = 1700000000000;
		const params = { pair: 'btc_jpy', amount: '0.001' };
		const { token, expiresAt } = generateToken('create_order', params, now);

		// まずトークンを消費して使用済みにする
		expect(validateToken(token, 'create_order', params, expiresAt, now + 1000)).toBeNull();
		expect(_usedTokenCount()).toBe(1);

		// 期限切れ後に再検証 → token_already_used ではなく token_expired を返す
		const error = validateToken(token, 'create_order', params, expiresAt, expiresAt + 1);
		expect(error?.code).toBe('token_expired');
	});
});

describe('purgeExpiredTokens', () => {
	it('期限切れトークンを除去する', () => {
		const now = 1700000000000;
		const params = { pair: 'btc_jpy', amount: '0.001' };
		const { token, expiresAt } = generateToken('create_order', params, now);

		// トークンを使用済みにする
		validateToken(token, 'create_order', params, expiresAt, now + 1000);
		expect(_usedTokenCount()).toBe(1);

		// 期限切れ後にパージ
		const purged = purgeExpiredTokens(expiresAt + 1);
		expect(purged).toBe(1);
		expect(_usedTokenCount()).toBe(0);
	});

	it('有効期限内のトークンは除去しない', () => {
		const now = 1700000000000;
		const params = { pair: 'btc_jpy', amount: '0.001' };
		const { token, expiresAt } = generateToken('create_order', params, now);

		validateToken(token, 'create_order', params, expiresAt, now + 1000);
		expect(_usedTokenCount()).toBe(1);

		// 期限内にパージ → 除去されない
		const purged = purgeExpiredTokens(expiresAt);
		expect(purged).toBe(0);
		expect(_usedTokenCount()).toBe(1);
	});

	it('複数トークンのうち期限切れ分のみ除去する', () => {
		const now = 1700000000000;
		const params1 = { pair: 'btc_jpy', amount: '0.001' };
		const params2 = { pair: 'eth_jpy', amount: '0.01' };

		const t1 = generateToken('create_order', params1, now);
		const t2 = generateToken('create_order', params2, now + 30_000); // 30秒後に生成

		validateToken(t1.token, 'create_order', params1, t1.expiresAt, now + 1000);
		validateToken(t2.token, 'create_order', params2, t2.expiresAt, now + 31_000);
		expect(_usedTokenCount()).toBe(2);

		// t1 のみ期限切れ
		const purged = purgeExpiredTokens(t1.expiresAt + 1);
		expect(purged).toBe(1);
		expect(_usedTokenCount()).toBe(1);
	});

	it('空の場合は 0 を返す', () => {
		const purged = purgeExpiredTokens(Date.now());
		expect(purged).toBe(0);
	});
});

describe('startCleanupTimer / stopCleanupTimer', () => {
	it('startCleanupTimer でタイマーが有効になる', () => {
		expect(_isCleanupTimerActive()).toBe(false);
		startCleanupTimer();
		expect(_isCleanupTimerActive()).toBe(true);
	});

	it('重複起動しない（2回呼んでもタイマーは1つ）', () => {
		startCleanupTimer();
		expect(_isCleanupTimerActive()).toBe(true);
		startCleanupTimer(); // 2回目は no-op
		expect(_isCleanupTimerActive()).toBe(true);
		stopCleanupTimer();
		expect(_isCleanupTimerActive()).toBe(false);
	});

	it('stopCleanupTimer でタイマーが停止する', () => {
		startCleanupTimer();
		expect(_isCleanupTimerActive()).toBe(true);
		stopCleanupTimer();
		expect(_isCleanupTimerActive()).toBe(false);
	});

	it('stopCleanupTimer は複数回呼んでも安全', () => {
		stopCleanupTimer();
		expect(_isCleanupTimerActive()).toBe(false);
		startCleanupTimer();
		stopCleanupTimer();
		stopCleanupTimer(); // 2回目は no-op
		expect(_isCleanupTimerActive()).toBe(false);
	});
});
