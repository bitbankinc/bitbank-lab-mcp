import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	BoundedExpiringSet,
	DEFAULT_MAX_ENTRIES,
	DEFAULT_PURGE_INTERVAL_MS,
	MAX_ENTRIES_CEILING,
} from '../../lib/bounded-expiring-set.js';

const NOW = 1700000000000;
const TTL = 60_000;

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe('BoundedExpiringSet — add / has の基本', () => {
	it('未記録の key は add に成功する', () => {
		const s = new BoundedExpiringSet();
		expect(s.add('a', NOW + TTL, NOW)).toEqual({ added: true });
		expect(s.has('a', NOW)).toBe(true);
		expect(s.size()).toBe(1);
	});

	it('生存中の key の再 add は already_recorded で失敗する（ワンタイム性）', () => {
		const s = new BoundedExpiringSet();
		s.add('a', NOW + TTL, NOW);

		const res = s.add('a', NOW + TTL, NOW + 1);
		expect(res).toEqual({ added: false, reason: 'already_recorded' });
		expect(s.size()).toBe(1);
	});

	it('未記録の key は has が false', () => {
		const s = new BoundedExpiringSet();
		expect(s.has('missing', NOW)).toBe(false);
	});

	it('期限ちょうど（nowMs === expiresAt）はまだ生存扱い', () => {
		const s = new BoundedExpiringSet();
		s.add('a', NOW + TTL, NOW);

		expect(s.has('a', NOW + TTL)).toBe(true);
		expect(s.has('a', NOW + TTL + 1)).toBe(false);
	});

	it('期限切れになった key は再び add できる（保証は TTL 内のみ）', () => {
		const s = new BoundedExpiringSet();
		s.add('a', NOW + TTL, NOW);

		expect(s.add('a', NOW + TTL * 3, NOW + TTL + 1)).toEqual({ added: true });
		expect(s.has('a', NOW + TTL + 1)).toBe(true);
	});

	it('clear で全記録が消える', () => {
		const s = new BoundedExpiringSet();
		s.add('a', NOW + TTL, NOW);
		s.add('b', NOW + TTL, NOW);
		expect(s.size()).toBe(2);

		s.clear();
		expect(s.size()).toBe(0);
		expect(s.has('a', NOW)).toBe(false);
	});
});

describe('BoundedExpiringSet — 期限切れの除去', () => {
	it('期限切れが purgeExpired で消える', () => {
		const s = new BoundedExpiringSet();
		s.add('a', NOW + TTL, NOW);
		s.add('b', NOW + TTL, NOW);

		expect(s.purgeExpired(NOW + TTL + 1)).toBe(2);
		expect(s.size()).toBe(0);
	});

	it('生存エントリは purgeExpired で消えない', () => {
		const s = new BoundedExpiringSet();
		s.add('old', NOW + TTL, NOW);
		s.add('new', NOW + TTL * 3, NOW + TTL); // 後から長い期限で記録

		expect(s.purgeExpired(NOW + TTL + 1)).toBe(1);
		expect(s.has('old', NOW + TTL + 1)).toBe(false);
		expect(s.has('new', NOW + TTL + 1)).toBe(true);
	});

	it('空の場合 purgeExpired は 0 を返す', () => {
		const s = new BoundedExpiringSet();
		expect(s.purgeExpired(NOW)).toBe(0);
	});

	it('期限切れが has から見えない（アクセス時に除去される）', () => {
		const s = new BoundedExpiringSet();
		s.add('a', NOW + TTL, NOW);
		expect(s.size()).toBe(1);

		expect(s.has('a', NOW + TTL + 1)).toBe(false);
		expect(s.size()).toBe(0); // アクセス時 purge で実体も消えている
	});

	it('add 時に挿入順の先頭側の期限切れが掃除される', () => {
		const s = new BoundedExpiringSet();
		s.add('a', NOW + TTL, NOW);
		s.add('b', NOW + TTL, NOW);

		// 上限に達していなくても、通常経路の先頭走査で期限切れが除去される
		s.add('c', NOW + TTL * 3, NOW + TTL + 1);
		expect(s.size()).toBe(1);
		expect(s.has('c', NOW + TTL + 1)).toBe(true);
	});
});

describe('BoundedExpiringSet — 件数上限', () => {
	it('上限未満では add が成功する', () => {
		const s = new BoundedExpiringSet({ maxEntries: 3 });
		expect(s.add('a', NOW + TTL, NOW)).toEqual({ added: true });
		expect(s.add('b', NOW + TTL, NOW)).toEqual({ added: true });
		expect(s.size()).toBe(2);
	});

	it('上限到達 + 空きが作れない場合は capacity_exceeded で失敗する', () => {
		const s = new BoundedExpiringSet({ maxEntries: 2 });
		s.add('a', NOW + TTL, NOW);
		s.add('b', NOW + TTL, NOW);

		const res = s.add('c', NOW + TTL, NOW);
		expect(res).toEqual({ added: false, reason: 'capacity_exceeded' });
		expect(s.size()).toBe(2);
		expect(s.has('c', NOW)).toBe(false);
		expect(s.stats().rejectedTotal).toBe(1);
	});

	it('上限到達時に生存エントリを追い出さない（replay 回帰テスト）', () => {
		const s = new BoundedExpiringSet({ maxEntries: 2 });
		s.add('a', NOW + TTL, NOW);
		s.add('b', NOW + TTL, NOW);

		// 追加は拒否される
		expect(s.add('c', NOW + TTL, NOW)).toEqual({ added: false, reason: 'capacity_exceeded' });

		// 追い出しが起きていれば、一度 add した生存 key が再び add できてしまう。
		// = その token / nonce の replay が黙って通る状態。
		expect(s.add('a', NOW + TTL, NOW)).toEqual({ added: false, reason: 'already_recorded' });
		expect(s.add('b', NOW + TTL, NOW)).toEqual({ added: false, reason: 'already_recorded' });
		expect(s.has('a', NOW)).toBe(true);
		expect(s.has('b', NOW)).toBe(true);
	});

	it('容量超過の add が連続しても生存エントリは残り続ける', () => {
		const s = new BoundedExpiringSet({ maxEntries: 2 });
		s.add('a', NOW + TTL, NOW);
		s.add('b', NOW + TTL, NOW);

		for (let i = 0; i < 50; i++) {
			expect(s.add(`flood-${i}`, NOW + TTL, NOW).added).toBe(false);
		}

		expect(s.size()).toBe(2);
		expect(s.has('a', NOW)).toBe(true);
		expect(s.has('b', NOW)).toBe(true);
		expect(s.stats().rejectedTotal).toBe(50);
	});

	it('上限到達でも期限切れが混ざっていれば purge 後に add が成功する', () => {
		const s = new BoundedExpiringSet({ maxEntries: 2 });
		s.add('expired', NOW + TTL, NOW);
		s.add('alive', NOW + TTL * 10, NOW);

		// 'expired' だけが期限切れの時刻で新規 add
		expect(s.add('fresh', NOW + TTL * 10, NOW + TTL + 1)).toEqual({ added: true });
		expect(s.has('expired', NOW + TTL + 1)).toBe(false);
		expect(s.has('alive', NOW + TTL + 1)).toBe(true);
		expect(s.has('fresh', NOW + TTL + 1)).toBe(true);
		expect(s.size()).toBe(2);
	});

	it('TTL が不揃いでも（挿入順 ≠ 期限順）期限切れがあれば add が成功する', () => {
		const s = new BoundedExpiringSet({ maxEntries: 2 });
		// 先頭が長寿命、後ろが短命 → 先頭走査だけでは空きを作れない
		s.add('long', NOW + TTL * 10, NOW);
		s.add('short', NOW + TTL, NOW);

		// 全走査フォールバックで 'short' が除去される
		expect(s.add('fresh', NOW + TTL * 10, NOW + TTL + 1)).toEqual({ added: true });
		expect(s.has('short', NOW + TTL + 1)).toBe(false);
		expect(s.has('long', NOW + TTL + 1)).toBe(true);
	});

	it('生存 key への再 add は期限を延長しない（TTL のすり抜け防止）', () => {
		const s = new BoundedExpiringSet({ maxEntries: 1 });
		s.add('a', NOW + TTL, NOW);

		// 失敗した add が既存エントリの期限を書き換えたりしない
		expect(s.add('a', NOW + TTL * 100, NOW).added).toBe(false);
		expect(s.has('a', NOW + TTL + 1)).toBe(false);
	});
});

describe('BoundedExpiringSet — 上限値の解決', () => {
	it('未指定なら DEFAULT_MAX_ENTRIES', () => {
		expect(new BoundedExpiringSet().maxEntries).toBe(DEFAULT_MAX_ENTRIES);
	});

	it('コンストラクタ指定が環境変数より優先される', () => {
		vi.stubEnv('REPLAY_GUARD_MAX_ENTRIES', '5000');
		expect(new BoundedExpiringSet({ maxEntries: 7 }).maxEntries).toBe(7);
	});

	it('環境変数で上書きできる', () => {
		vi.stubEnv('REPLAY_GUARD_MAX_ENTRIES', '500');
		expect(new BoundedExpiringSet().maxEntries).toBe(500);
	});

	it('上限超過は MAX_ENTRIES_CEILING で clamp する', () => {
		vi.stubEnv('REPLAY_GUARD_MAX_ENTRIES', String(MAX_ENTRIES_CEILING * 10));
		expect(new BoundedExpiringSet().maxEntries).toBe(MAX_ENTRIES_CEILING);
		expect(new BoundedExpiringSet({ maxEntries: MAX_ENTRIES_CEILING + 1 }).maxEntries).toBe(MAX_ENTRIES_CEILING);
	});

	it('小数は切り捨てる', () => {
		expect(new BoundedExpiringSet({ maxEntries: 10.9 }).maxEntries).toBe(10);
	});

	it.each([
		['空文字', ''],
		['非数値', 'abc'],
		['NaN', 'NaN'],
		['0', '0'],
		['負値', '-1'],
		['Infinity', 'Infinity'],
	])('不正な環境変数（%s）はデフォルトへフォールバックする', (_label, raw) => {
		vi.stubEnv('REPLAY_GUARD_MAX_ENTRIES', raw);
		expect(new BoundedExpiringSet().maxEntries).toBe(DEFAULT_MAX_ENTRIES);
	});

	it.each([
		['NaN', Number.NaN],
		['0', 0],
		['負値', -1],
		['Infinity', Number.POSITIVE_INFINITY],
	])('不正なコンストラクタ引数（%s）はデフォルトへフォールバックする', (_label, value) => {
		expect(new BoundedExpiringSet({ maxEntries: value }).maxEntries).toBe(DEFAULT_MAX_ENTRIES);
	});
});

describe('BoundedExpiringSet — 定期 purge タイマー', () => {
	it('定期タイマーで purge が走る', () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);

		const s = new BoundedExpiringSet({ purgeIntervalMs: 1_000 });
		s.add('a', NOW + 500);
		s.startCleanupTimer();
		expect(s.size()).toBe(1);

		vi.advanceTimersByTime(1_000);
		expect(s.size()).toBe(0);
		expect(s.stats().purgedTotal).toBe(1);

		s.stopCleanupTimer();
	});

	it('既定の purge 間隔は 60 秒', () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);

		const s = new BoundedExpiringSet();
		s.add('a', NOW + 500);
		s.startCleanupTimer();

		vi.advanceTimersByTime(DEFAULT_PURGE_INTERVAL_MS - 1);
		expect(s.size()).toBe(1);

		vi.advanceTimersByTime(1);
		expect(s.size()).toBe(0);

		s.stopCleanupTimer();
	});

	it('停止後は purge が走らない', () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);

		const s = new BoundedExpiringSet({ purgeIntervalMs: 1_000 });
		s.add('a', NOW + 500);
		s.startCleanupTimer();
		s.stopCleanupTimer();

		vi.advanceTimersByTime(10_000);
		expect(s.size()).toBe(1); // 記録は残ったまま
	});

	it('startCleanupTimer でタイマーが有効になる', () => {
		const s = new BoundedExpiringSet();
		expect(s.isCleanupTimerActive()).toBe(false);

		s.startCleanupTimer();
		expect(s.isCleanupTimerActive()).toBe(true);

		s.stopCleanupTimer();
	});

	it('重複起動しない（2回呼んでもタイマーは1つ）', () => {
		const spy = vi.spyOn(globalThis, 'setInterval');
		const s = new BoundedExpiringSet();

		s.startCleanupTimer();
		s.startCleanupTimer(); // 2回目は no-op
		expect(spy).toHaveBeenCalledTimes(1);
		expect(s.isCleanupTimerActive()).toBe(true);

		s.stopCleanupTimer();
		expect(s.isCleanupTimerActive()).toBe(false);
	});

	it('stopCleanupTimer は複数回呼んでも安全', () => {
		const s = new BoundedExpiringSet();
		s.stopCleanupTimer();
		expect(s.isCleanupTimerActive()).toBe(false);

		s.startCleanupTimer();
		s.stopCleanupTimer();
		s.stopCleanupTimer(); // 2回目は no-op
		expect(s.isCleanupTimerActive()).toBe(false);
	});

	it('停止後に再開できる', () => {
		const s = new BoundedExpiringSet();
		s.startCleanupTimer();
		s.stopCleanupTimer();
		s.startCleanupTimer();
		expect(s.isCleanupTimerActive()).toBe(true);

		s.stopCleanupTimer();
	});

	it('タイマーは unref される（プロセス終了をブロックしない）', () => {
		const unref = vi.fn();
		const handle = { unref } as unknown as ReturnType<typeof setInterval>;
		vi.spyOn(globalThis, 'setInterval').mockReturnValue(handle as never);

		const s = new BoundedExpiringSet();
		s.startCleanupTimer();
		expect(unref).toHaveBeenCalledTimes(1);

		s.stopCleanupTimer();
	});
});

describe('BoundedExpiringSet — stats', () => {
	it('件数系のメタ情報のみを返す（key の本文を含まない）', () => {
		const s = new BoundedExpiringSet({ maxEntries: 2 });
		s.add('secret-token', NOW + TTL, NOW);

		const stats = s.stats();
		expect(stats).toEqual({ size: 1, maxEntries: 2, purgedTotal: 0, rejectedTotal: 0 });
		expect(JSON.stringify(stats)).not.toContain('secret-token');
	});

	it('purgedTotal / rejectedTotal が累計される', () => {
		const s = new BoundedExpiringSet({ maxEntries: 1 });
		s.add('a', NOW + TTL, NOW);
		s.add('b', NOW + TTL, NOW); // 容量超過で拒否
		s.purgeExpired(NOW + TTL + 1); // 'a' を除去

		const stats = s.stats();
		expect(stats.rejectedTotal).toBe(1);
		expect(stats.purgedTotal).toBe(1);
		expect(stats.size).toBe(0);
	});
});
