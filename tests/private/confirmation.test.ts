/**
 * HITL 確認トークンのユニットテスト。
 * トークン生成・検証、有効期限、パラメータ改ざん検知を検証する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_ENTRIES } from '../../lib/bounded-expiring-set.js';
import {
	_isCleanupTimerActive,
	_resetUsedTokens,
	_usedTokenCapacity,
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
	stopCleanupTimer();
	// 件数上限を絞ったテストがストアを作り直すため、既定値へ戻してから次のテストに渡す
	_resetUsedTokens({ maxEntries: DEFAULT_MAX_ENTRIES });
	vi.useRealTimers();
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

/** テスト共通の基準時刻。TTL は既定 60 秒なので expiresAt = NOW + 60_000 になる */
const NOW = 1700000000000;

/**
 * 有効なトークンを生成し、そのまま検証まで通す（成功すれば使用済み記録が 1 件増える）。
 * `seq` でパラメータを変え、毎回異なるトークンを作る。
 */
function consumeToken(seq: number, nowMs: number = NOW) {
	const params = { pair: 'btc_jpy', amount: '0.001', seq };
	const { token, expiresAt } = generateToken('create_order', params, nowMs);
	const error = validateToken(token, 'create_order', params, expiresAt, nowMs);
	return { params, token, expiresAt, error };
}

describe('validateToken — 使用済み記録の件数上限（fail-closed）', () => {
	it('既定の上限は BoundedExpiringSet の既定値をそのまま使う', () => {
		expect(_usedTokenCapacity()).toBe(DEFAULT_MAX_ENTRIES);
	});

	it('上限に達するまでは従来どおり検証が成功する', () => {
		_resetUsedTokens({ maxEntries: 3 });

		expect(consumeToken(0).error).toBeNull();
		expect(consumeToken(1).error).toBeNull();
		// 上限ちょうどまでは記録できる
		expect(consumeToken(2).error).toBeNull();
		expect(_usedTokenCount()).toBe(3);
	});

	it('上限到達後の新しいトークンは token_store_full で拒否される（成功を返さない）', () => {
		_resetUsedTokens({ maxEntries: 2 });
		consumeToken(0);
		consumeToken(1);

		const { error, token } = consumeToken(2);
		expect(error).not.toBeNull();
		expect(error?.code).toBe('token_store_full');
		expect(error?.message).toContain('時間をおいて');
		expect(error?.message).toContain('preview');
		// token 本文をユーザー向け文言に混ぜない
		expect(error?.message).not.toContain(token);
	});

	it('上限到達時に生存トークンは追い出されず、使用済みトークンは再び通らない', () => {
		_resetUsedTokens({ maxEntries: 2 });
		const first = consumeToken(0);
		const second = consumeToken(1);
		expect(first.error).toBeNull();
		expect(second.error).toBeNull();

		// 上限到達
		expect(consumeToken(2).error?.code).toBe('token_store_full');
		expect(_usedTokenCount()).toBe(2);

		// 追い出しが起きていれば使用済み記録が消え、同じトークンで二重発注が通ってしまう
		const replayFirst = validateToken(first.token, 'create_order', first.params, first.expiresAt, NOW + 1000);
		expect(replayFirst?.code).toBe('token_already_used');
		const replaySecond = validateToken(second.token, 'create_order', second.params, second.expiresAt, NOW + 1000);
		expect(replaySecond?.code).toBe('token_already_used');
	});

	it('上限到達後でも期限切れが purge されれば再び検証が成功する', () => {
		_resetUsedTokens({ maxEntries: 2 });
		consumeToken(0);
		consumeToken(1);
		expect(consumeToken(2).error?.code).toBe('token_store_full');

		// TTL(60秒) 経過後に発行されたトークンは、期限切れ 2 件が purge されるので記録できる
		const revived = consumeToken(3, NOW + 60_001);
		expect(revived.error).toBeNull();
		expect(_usedTokenCount()).toBe(1);
	});

	it('拒否された検証は使用済みとして記録されない', () => {
		_resetUsedTokens({ maxEntries: 1 });
		consumeToken(0);
		expect(consumeToken(1).error?.code).toBe('token_store_full');
		expect(_usedTokenCount()).toBe(1);
	});
});

describe('使用済み記録の purge 経路', () => {
	it('アクセス時 purge: 検証のたびに期限切れエントリが除去される', () => {
		_resetUsedTokens({ maxEntries: 10 });
		consumeToken(0);
		consumeToken(1);
		expect(_usedTokenCount()).toBe(2);

		// 定期タイマーは動かさず、次の検証だけで古い記録が消えること
		expect(_isCleanupTimerActive()).toBe(false);
		expect(consumeToken(2, NOW + 60_001).error).toBeNull();
		expect(_usedTokenCount()).toBe(1);
	});

	it('定期 purge: 無アクセスでもタイマー発火で期限切れエントリが消える', () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);

		expect(consumeToken(0).error).toBeNull();
		expect(_usedTokenCount()).toBe(1);

		startCleanupTimer();

		// 1 回目の発火（+60秒）は expiresAt ちょうど＝期限内なので残る
		vi.advanceTimersByTime(60_000);
		expect(_usedTokenCount()).toBe(1);

		// 2 回目の発火（+120秒）で期限切れとして除去される
		vi.advanceTimersByTime(60_000);
		expect(_usedTokenCount()).toBe(0);
	});
});

describe('validateToken — 並行実行時の二重使用防止', () => {
	it('同一トークンを同一 tick で複数回検証しても成功は 1 回だけ', () => {
		const params = { pair: 'btc_jpy', amount: '0.001', side: 'buy', type: 'limit' };
		const { token, expiresAt } = generateToken('create_order', params, NOW);

		const results = [0, 1, 2].map(() => validateToken(token, 'create_order', params, expiresAt, NOW + 1000));

		expect(results.filter((r) => r === null)).toHaveLength(1);
		expect(results.filter((r) => r?.code === 'token_already_used')).toHaveLength(2);
		expect(_usedTokenCount()).toBe(1);
	});

	it('上限到達中の並行検証はすべて拒否される（fail-closed）', () => {
		_resetUsedTokens({ maxEntries: 1 });
		consumeToken(0);

		const results = [1, 2, 3].map((seq) => consumeToken(seq).error);
		expect(results.every((e) => e?.code === 'token_store_full')).toBe(true);
		expect(_usedTokenCount()).toBe(1);
	});
});

describe('validateToken — 非有限の expiresAt', () => {
	it.each([
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
		['-Infinity', Number.NEGATIVE_INFINITY],
	])('%s の expiresAt は token_invalid で拒否し記録もしない', (_label, expiresAt) => {
		const params = { pair: 'btc_jpy', amount: '0.001' };
		const { token } = generateToken('create_order', params, NOW);

		const error = validateToken(token, 'create_order', params, expiresAt, NOW + 1000);
		expect(error?.code).toBe('token_invalid');
		expect(_usedTokenCount()).toBe(0);
	});
});
