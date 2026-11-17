import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paginateDeposits, paginateWithdrawals } from '../../../src/handlers/portfolio/pagination.js';
import { BitbankPrivateClient } from '../../../src/private/client.js';
import { mockBitbankSuccess } from '../../fixtures/private-api.js';

beforeEach(() => {
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
});

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.BITBANK_API_KEY;
	delete process.env.BITBANK_API_SECRET;
});

const BASE_TS = 1_700_000_000_000;

function deposit(i: number, ts: number, overrides: Record<string, unknown> = {}) {
	return {
		uuid: `dep-${i}`,
		asset: 'jpy',
		amount: '1000',
		status: 'DONE',
		found_at: ts - 100,
		confirmed_at: ts,
		...overrides,
	};
}

function withdrawal(i: number, ts: number) {
	return { uuid: `wd-${i}`, asset: 'jpy', amount: '1000', fee: '550', status: 'DONE', requested_at: ts };
}

// 実口座で確かめた振る舞い（since / end はどちらも境界を含む）だけを再現する（fork の issue 458 項目 1・7）。
function fakeHistoryApi(
	key: 'deposits' | 'withdrawals',
	records: Array<Record<string, unknown>>,
	timeOf: (r: Record<string, unknown>) => number,
) {
	const calls: URLSearchParams[] = [];
	const fetcher = vi.fn(async (url: string | URL | Request) => {
		const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
		const params = new URL(href).searchParams;
		calls.push(params);
		const since = params.get('since');
		const end = params.get('end');
		const count = Number(params.get('count'));
		const rows = records
			.filter((r) => (since == null || timeOf(r) >= Number(since)) && (end == null || timeOf(r) <= Number(end)))
			.sort((a, b) => timeOf(b) - timeOf(a))
			.slice(0, count);
		return new Response(JSON.stringify(mockBitbankSuccess({ [key]: rows })), { status: 200 });
	});
	return { client: new BitbankPrivateClient({ fetcher: fetcher as unknown as typeof fetch }), calls };
}

const depositTime = (r: Record<string, unknown>) => Number(r.confirmed_at ?? r.found_at);
const withdrawalTime = (r: Record<string, unknown>) => Number(r.requested_at);

describe('paginateDeposits / paginateWithdrawals — 新しい順の API を古いほうへさかのぼる', () => {
	it('入金 250 件を取りこぼさずに全件取得し、complete=true を返す', async () => {
		const records = Array.from({ length: 250 }, (_, i) => deposit(i, BASE_TS + i * 1000));
		const { client, calls } = fakeHistoryApi('deposits', records, depositTime);

		const result = await paginateDeposits(client, { asset: 'jpy' });

		expect(result.complete).toBe(true);
		expect(result.deposits).toHaveLength(250);
		expect(new Set(result.deposits.map((d) => d.uuid)).size).toBe(250);
		expect(calls).toHaveLength(3);
		expect(calls[0].get('end')).toBeNull();
		// 次の end は前のページのいちばん古い時刻をそのまま使う（境界を含むので 1ms 引かない）。
		expect(calls[1].get('end')).toBe(String(BASE_TS + 150 * 1000));
		expect(calls[2].get('end')).toBe(String(BASE_TS + 51 * 1000));
		for (const c of calls) expect(c.get('count')).toBe('100');
	});

	it('出金 150 件を全件取得し、complete=true を返す', async () => {
		const records = Array.from({ length: 150 }, (_, i) => withdrawal(i, BASE_TS + i * 1000));
		const { client, calls } = fakeHistoryApi('withdrawals', records, withdrawalTime);

		const result = await paginateWithdrawals(client, { asset: 'jpy' });

		expect(result.complete).toBe(true);
		expect(result.withdrawals).toHaveLength(150);
		expect(calls[1].get('end')).toBe(String(BASE_TS + 50 * 1000));
	});

	it('ページの境目に同じ時刻の入金が並んでいても、取りこぼさず重複もしない', async () => {
		// 新しいほうから 99〜102 件目が同じ時刻。1 ページ目の末尾と 2 ページ目の先頭に分かれる。
		const records = Array.from({ length: 180 }, (_, i) => {
			const ts = i >= 78 && i <= 81 ? BASE_TS + 81 * 1000 : BASE_TS + i * 1000;
			return deposit(i, ts);
		});
		const { client } = fakeHistoryApi('deposits', records, depositTime);

		const result = await paginateDeposits(client, {});

		expect(result.complete).toBe(true);
		expect(result.deposits).toHaveLength(180);
		expect(new Set(result.deposits.map((d) => d.uuid)).size).toBe(180);
	});

	it('since は期間の下限として毎回送り、その前の履歴は取らない', async () => {
		const records = Array.from({ length: 300 }, (_, i) => deposit(i, BASE_TS + i * 1000));
		const sinceMs = BASE_TS + 120 * 1000;
		const { client, calls } = fakeHistoryApi('deposits', records, depositTime);

		const result = await paginateDeposits(client, {}, sinceMs);

		expect(result.complete).toBe(true);
		expect(result.deposits).toHaveLength(180);
		for (const c of calls) expect(c.get('since')).toBe(String(sinceMs));
	});

	it('いちばん古い入金が未確認（confirmed_at が無い）でも found_at で次のページへ進む', async () => {
		const records = Array.from({ length: 130 }, (_, i) =>
			i === 30
				? deposit(i, BASE_TS + i * 1000, { status: 'FOUND', confirmed_at: undefined })
				: deposit(i, BASE_TS + i * 1000),
		);
		const { client, calls } = fakeHistoryApi('deposits', records, depositTime);

		const result = await paginateDeposits(client, {});

		expect(result.complete).toBe(true);
		expect(result.deposits).toHaveLength(130);
		expect(calls[1].get('end')).toBe(String(BASE_TS + 30 * 1000 - 100));
	});

	it('上限ページ数に達したら、取れた分を返して complete=false にする', async () => {
		const records = Array.from({ length: 1500 }, (_, i) => withdrawal(i, BASE_TS + i * 1000));
		const { client, calls } = fakeHistoryApi('withdrawals', records, withdrawalTime);

		const result = await paginateWithdrawals(client, {});

		expect(result.complete).toBe(false);
		expect(calls).toHaveLength(10);
		// 新しいほうから 1,000 件（重複を除くと 991 件）を取り、古い分は取っていない。
		expect(result.withdrawals.map((w) => w.uuid)).toContain('wd-1499');
		expect(result.withdrawals.map((w) => w.uuid)).not.toContain('wd-0');
	});

	it('同じ時刻の履歴が 1 ページ分を超えて進めないときは、打ち切って complete=false にする', async () => {
		const records = Array.from({ length: 150 }, (_, i) => deposit(i, BASE_TS));
		const { client, calls } = fakeHistoryApi('deposits', records, depositTime);

		const result = await paginateDeposits(client, {});

		expect(result.complete).toBe(false);
		expect(result.deposits).toHaveLength(100);
		expect(calls.length).toBeLessThan(10);
	});
});
