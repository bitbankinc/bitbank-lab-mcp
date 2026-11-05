// 100 件バッチの末尾が未確認入金（confirmed_at 欠落）でも、found_at にフォールバックしてページネーションが早期終了しないこと。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchDepositWithdrawal } from '../../src/handlers/portfolio/fetch.js';
import { BitbankPrivateClient } from '../../src/private/client.js';
import { mockBitbankSuccess } from '../fixtures/private-api.js';

beforeEach(() => {
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
});

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.BITBANK_API_KEY;
	delete process.env.BITBANK_API_SECRET;
});

describe('portfolio/fetch paginateDeposits — confirmed_at 欠落フォールバック', () => {
	it('末尾が未確認入金(confirmed_at 欠落)でも break せず found_at で次ページを取得する', async () => {
		const depositSinceValues: string[] = [];
		let depositCall = 0;

		const fetcher = vi.fn(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;

			if (urlStr.includes('deposit_history')) {
				depositCall++;
				const since = new URL(urlStr).searchParams.get('since');
				if (since) depositSinceValues.push(since);
				if (depositCall <= 2) {
					// 暗号資産 + JPY の 2 チャネルそれぞれ 1 ページ目: 100 件、末尾は未確認入金。
					const deposits = Array.from({ length: 100 }, (_, i) => {
						const isLast = i === 99;
						return {
							uuid: `dep-${depositCall}-p1-${i}`,
							asset: depositCall === 2 ? 'jpy' : 'btc',
							amount: '1.0',
							status: isLast ? 'FOUND' : 'DONE',
							found_at: 1709900000000 + i * 1000,
							...(isLast ? {} : { confirmed_at: 1709900000000 + i * 1000 + 100 }),
						};
					});
					return new Response(JSON.stringify(mockBitbankSuccess({ deposits })), { status: 200 });
				}
				// 2 ページ目: 10 件 → 完了
				const deposits = Array.from({ length: 10 }, (_, i) => ({
					uuid: `dep-${depositCall}-p2-${i}`,
					asset: depositCall === 4 ? 'jpy' : 'btc',
					amount: '1.0',
					status: 'DONE',
					found_at: 1709990000000 + i * 1000,
					confirmed_at: 1709990000000 + i * 1000 + 100,
				}));
				return new Response(JSON.stringify(mockBitbankSuccess({ deposits })), { status: 200 });
			}
			if (urlStr.includes('withdrawal_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
			}
			throw new Error(`Unexpected URL: ${urlStr}`);
		});

		const client = new BitbankPrivateClient({ fetcher: fetcher as unknown as typeof fetch });
		const result = await fetchDepositWithdrawal(client);

		expect(result).not.toBeNull();
		// 各入金チャネルが 2 ページずつ（1 ページ目で break しない）→ 暗号資産/JPY 各 110 件
		expect(result?.deposits.length).toBe(220);
		expect(result?.isComplete).toBe(true);
		// カーソルが末尾レコードの found_at にフォールバックして前進している
		expect(depositSinceValues).toContain(String(1709900000000 + 99 * 1000));
	});

	it('全件 confirmed_at ありの既存ケースが回帰しない', async () => {
		let depositCall = 0;

		const fetcher = vi.fn(async (url: string | URL | Request) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;

			if (urlStr.includes('deposit_history')) {
				depositCall++;
				// 50 件（< 100）→ 1 ページで完了
				const deposits = Array.from({ length: 50 }, (_, i) => ({
					uuid: `dep-${depositCall}-${i}`,
					asset: depositCall === 2 ? 'jpy' : 'btc',
					amount: '1.0',
					status: 'DONE',
					found_at: 1709900000000 + i * 1000,
					confirmed_at: 1709900000000 + i * 1000 + 100,
				}));
				return new Response(JSON.stringify(mockBitbankSuccess({ deposits })), { status: 200 });
			}
			if (urlStr.includes('withdrawal_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
			}
			throw new Error(`Unexpected URL: ${urlStr}`);
		});

		const client = new BitbankPrivateClient({ fetcher: fetcher as unknown as typeof fetch });
		const result = await fetchDepositWithdrawal(client);

		expect(result).not.toBeNull();
		expect(result?.deposits.length).toBe(100);
		expect(result?.isComplete).toBe(true);
	});
});
