import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFail, assertOk } from '../_assertResult.js';
import {
	mockBitbankError,
	mockBitbankSuccess,
	rawDepositHistoryResponse,
	rawWithdrawalHistoryResponse,
} from '../fixtures/private-api.js';

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

function setupFetchMock(opts: {
	depositResponse?: unknown;
	withdrawalResponse?: unknown;
	depositFail?: boolean;
	withdrawalFail?: boolean;
	customHandler?: (url: string) => Response;
}) {
	globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
		const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;

		if (opts.customHandler) {
			return opts.customHandler(urlStr);
		}

		if (urlStr.includes('deposit_history')) {
			if (opts.depositFail) {
				return new Response(JSON.stringify(mockBitbankError(20001)), { status: 400 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess(opts.depositResponse ?? rawDepositHistoryResponse)), {
				status: 200,
			});
		}
		if (urlStr.includes('withdrawal_history')) {
			if (opts.withdrawalFail) {
				return new Response(JSON.stringify(mockBitbankError(20001)), { status: 400 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess(opts.withdrawalResponse ?? rawWithdrawalHistoryResponse)), {
				status: 200,
			});
		}
		throw new Error(`Unexpected URL: ${urlStr}`);
	}) as unknown as typeof fetch;
}

describe('get_my_deposit_withdrawal', () => {
	it('入出金を統合して返す', async () => {
		setupFetchMock({});

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({});

		assertOk(result);
		expect(result.data.deposits.length).toBeGreaterThan(0);
		expect(result.data.withdrawals.length).toBeGreaterThan(0);
	});

	it('UUID で重複を排除する', async () => {
		// 暗号資産チャネルと JPY チャネルで同じ UUID が返るケース
		const duplicateDeposit = {
			deposits: [
				{
					uuid: 'dup-001',
					asset: 'jpy',
					amount: '100000',
					status: 'DONE',
					found_at: 1709900000000,
					confirmed_at: 1709900100000,
				},
			],
		};
		setupFetchMock({ depositResponse: duplicateDeposit });

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({});

		assertOk(result);
		const uuids = result.data.deposits.map((d) => d.uuid);
		const uniqueUuids = [...new Set(uuids)];
		expect(uuids.length).toBe(uniqueUuids.length);
	});

	it('ページネーション: 100 件バッチで次ページを取得する', async () => {
		let depositCallCount = 0;
		setupFetchMock({
			customHandler: (url: string) => {
				if (url.includes('deposit_history')) {
					depositCallCount++;
					if (depositCallCount === 1) {
						// 100 件返す → 次ページあり
						const deposits = Array.from({ length: 100 }, (_, i) => ({
							uuid: `dep-page1-${i}`,
							asset: 'jpy',
							amount: '10000',
							status: 'DONE',
							found_at: 1709900000000 + i * 1000,
							confirmed_at: 1709900000000 + i * 1000 + 100,
						}));
						return new Response(JSON.stringify(mockBitbankSuccess({ deposits })), { status: 200 });
					}
					// 2 ページ目: 50 件 → 完了
					const deposits = Array.from({ length: 50 }, (_, i) => ({
						uuid: `dep-page2-${i}`,
						asset: 'jpy',
						amount: '10000',
						status: 'DONE',
						found_at: 1709990000000 + i * 1000,
						confirmed_at: 1709990000000 + i * 1000 + 100,
					}));
					return new Response(JSON.stringify(mockBitbankSuccess({ deposits })), { status: 200 });
				}
				if (url.includes('withdrawal_history')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
				}
				throw new Error(`Unexpected URL: ${url}`);
			},
		});

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({ asset: 'jpy', type: 'deposit' });

		assertOk(result);
		expect(result.data.deposits.length).toBe(150);
		expect(result.meta.isComplete).toBe(true);
	});

	it('ページネーション: 100 件バッチの末尾が未確認入金(confirmed_at 欠落)でも break せず found_at で次ページを取得する', async () => {
		let depositCallCount = 0;
		const sinceValues: string[] = [];
		setupFetchMock({
			customHandler: (url: string) => {
				if (url.includes('deposit_history')) {
					depositCallCount++;
					const u = new URL(url);
					const since = u.searchParams.get('since');
					if (since) sinceValues.push(since);
					if (depositCallCount === 1) {
						// 100 件返す → 次ページあり。末尾レコードは status:'FOUND'（confirmed_at プロパティ無し）。
						const deposits = Array.from({ length: 100 }, (_, i) => {
							const isLast = i === 99;
							return {
								uuid: `dep-page1-${i}`,
								asset: 'jpy',
								amount: '10000',
								status: isLast ? 'FOUND' : 'DONE',
								found_at: 1709900000000 + i * 1000,
								...(isLast ? {} : { confirmed_at: 1709900000000 + i * 1000 + 100 }),
							};
						});
						return new Response(JSON.stringify(mockBitbankSuccess({ deposits })), { status: 200 });
					}
					// 2 ページ目: 30 件 → 完了
					const deposits = Array.from({ length: 30 }, (_, i) => ({
						uuid: `dep-page2-${i}`,
						asset: 'jpy',
						amount: '10000',
						status: 'DONE',
						found_at: 1709990000000 + i * 1000,
						confirmed_at: 1709990000000 + i * 1000 + 100,
					}));
					return new Response(JSON.stringify(mockBitbankSuccess({ deposits })), { status: 200 });
				}
				if (url.includes('withdrawal_history')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
				}
				throw new Error(`Unexpected URL: ${url}`);
			},
		});

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({ asset: 'jpy', type: 'deposit' });

		assertOk(result);
		// 早期 break せず 2 ページ目を取得 → 100 + 30 = 130 件
		expect(depositCallCount).toBe(2);
		expect(result.data.deposits.length).toBe(130);
		expect(result.meta.isComplete).toBe(true);
		// カーソルは末尾レコードの found_at にフォールバックする（同じ時刻を取り直し、重複は uuid で除く）
		expect(sinceValues).toContain(String(1709900000000 + 99 * 1000));
	});

	it('部分的失敗時に警告付きで成功する', async () => {
		setupFetchMock({ depositFail: true });

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({ asset: 'btc' });

		assertOk(result);
		expect(result.meta.hasWarnings).toBe(true);
		expect(result.data.withdrawals.length).toBeGreaterThan(0);
	});

	it('uuid をサマリーに含む', async () => {
		setupFetchMock({});

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({});

		assertOk(result);
		expect(result.summary).toContain('[dep-001]');
		expect(result.summary).toContain('[dep-002]');
		expect(result.summary).toContain('[wd-001]');
		expect(result.summary).toContain('[wd-002]');
	});

	it('入金種別（category）を data に通し、NORMAL 以外だけ明細に出す', async () => {
		const deposits = {
			deposits: [
				{ uuid: 'dep-n', asset: 'eth', amount: '1', status: 'DONE', category: 'NORMAL', found_at: 1, confirmed_at: 2 },
				{
					uuid: 'dep-s',
					asset: 'eth',
					amount: '0.01',
					status: 'DONE',
					category: 'STAKING',
					found_at: 3,
					confirmed_at: 4,
				},
				{ uuid: 'dep-m', asset: 'xrp', amount: '5', status: 'DONE', category: 'MANUAL', found_at: 5, confirmed_at: 6 },
				{ uuid: 'dep-x', asset: 'btc', amount: '0.1', status: 'DONE', found_at: 7, confirmed_at: 8 },
			],
		};
		setupFetchMock({ depositResponse: deposits, withdrawalResponse: { withdrawals: [] } });

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({ type: 'deposit' });

		assertOk(result);
		const byUuid = new Map(result.data.deposits.map((d) => [d.uuid, d]));
		expect(byUuid.get('dep-n')?.category).toBe('NORMAL');
		expect(byUuid.get('dep-s')?.category).toBe('STAKING');
		expect(byUuid.get('dep-x')?.category).toBeUndefined();
		const lineOf = (uuid: string) => result.summary.split('\n').find((l) => l.includes(`[${uuid}]`)) ?? '';
		expect(lineOf('dep-n')).not.toContain('種別');
		expect(lineOf('dep-s')).toContain('種別: STAKING');
		expect(lineOf('dep-m')).toContain('種別: MANUAL');
		expect(lineOf('dep-x')).not.toContain('種別');
		expect(result.summary).toContain('うちステーキング報酬（種別: STAKING）1件');
	});

	it('type=deposit で出金 API を呼ばない', async () => {
		setupFetchMock({});

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({ asset: 'btc', type: 'deposit' });

		assertOk(result);
		expect(result.data.withdrawals).toHaveLength(0);

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(calledUrls.some((u) => u.includes('withdrawal_history'))).toBe(false);
	});

	it('不正な since 日付で validation_error を返す', async () => {
		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({ since: 'invalid' });

		assertFail(result);
		expect(result.meta.errorType).toBe('validation_error');
	});

	it('入金と出金の両方が失敗したら、空の成功ではなく PrivateApiError の分類で失敗を返す', async () => {
		setupFetchMock({ depositFail: true, withdrawalFail: true });

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({ asset: 'btc' });

		assertFail(result);
		expect(result.meta.errorType).toBe('authentication_error');
		expect(result.summary).toContain('API 認証に失敗しました');
	});

	it('全通貨のページ取得で 4 本とも失敗したら失敗を返す', async () => {
		setupFetchMock({ depositFail: true, withdrawalFail: true });

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({});

		assertFail(result);
		expect(result.meta.errorType).toBe('authentication_error');
	});

	it('片方が失敗しても、もう片方の取得が 0 件で成功していれば警告付きの成功を返す', async () => {
		setupFetchMock({ depositFail: true, withdrawalResponse: { withdrawals: [] } });

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({ asset: 'btc' });

		assertOk(result);
		expect(result.meta.hasWarnings).toBe(true);
		expect(result.data.deposits).toHaveLength(0);
		expect(result.data.withdrawals).toHaveLength(0);
	});

	it('不正な end 日付で validation_error を返す', async () => {
		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({ end: 'bad-date' });

		assertFail(result);
		expect(result.meta.errorType).toBe('validation_error');
		expect(result.summary).toContain('end');
	});

	it('全通貨（asset未指定）+ since/end指定で単発取得する', async () => {
		setupFetchMock({});

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({ since: '2024-03-01T00:00:00Z', end: '2024-03-31T00:00:00Z' });

		assertOk(result);
		// since/end 指定時は単発取得パス
		expect(result.data.deposits.length).toBeGreaterThanOrEqual(0);
	});

	it('全通貨（asset未指定）+ since/end未指定でページネーション取得する', async () => {
		setupFetchMock({});

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({});

		assertOk(result);
		expect(result.data.deposits.length).toBeGreaterThan(0);
		expect(result.data.withdrawals.length).toBeGreaterThan(0);
	});

	it('collectResults が4チャネルの部分失敗で警告を収集する', async () => {
		setupFetchMock({ depositFail: true });

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		// asset 未指定: 4チャネル並列取得 → deposit 2チャネル失敗
		const result = await getMyDepositWithdrawal({});

		assertOk(result);
		expect(result.meta.hasWarnings).toBe(true);
		expect(result.meta.warnings.length).toBeGreaterThan(0);
		expect(result.summary).toContain('警告');
	});

	it('出金履歴の禁止フィールド（口座番号・名義等）を出力から除外する', async () => {
		// fiat 出金レコードには実 API が返す禁止フィールド（account_number / account_owner / branch_name / account_type / account_uuid）が含まれており、出力に漏れないことを検証する。
		setupFetchMock({});

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({});

		assertOk(result);

		// fiat 出金レコードが実際に取得されていることを前提条件として確認
		const jpyWithdrawal = result.data.withdrawals.find((w) => w.uuid === 'wd-001');
		expect(jpyWithdrawal).toBeDefined();
		expect(jpyWithdrawal?.bank_name).toBe('テスト銀行');

		const forbiddenKeys = ['account_number', 'account_owner', 'branch_name', 'account_type', 'account_uuid'];

		for (const w of result.data.withdrawals) {
			for (const key of forbiddenKeys) {
				expect(w).not.toHaveProperty(key);
			}
		}

		const serialized = JSON.stringify(result);
		for (const key of forbiddenKeys) {
			expect(serialized).not.toContain(key);
		}
		// account_number の '1234567' は許可フィールドの暗号資産アドレスと部分一致するので、値検証から外してキー検証と固有値検証で担保する。
		expect(serialized).not.toContain('タナカ タロウ');
		expect(serialized).not.toContain('テスト支店');
		expect(serialized).not.toContain('acc-uuid-001');
	});

	it('入金アドレス（暗号資産）は出力に露出しない（出力方針 Option A）', async () => {
		// 入金側は address を出力しない（HIGH 分類。出金側だけ出す非対称は意図的）。フィクスチャは実 API に同期して address を持たせ、露出だけ抑える。
		setupFetchMock({});

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({});

		assertOk(result);

		// 前提条件: フィクスチャの暗号資産入金に address が同期されている
		const rawBtc = rawDepositHistoryResponse.deposits.find((d) => d.uuid === 'dep-002') as
			| { address?: string }
			| undefined;
		expect(rawBtc?.address).toBeTruthy();

		const btcDeposit = result.data.deposits.find((d) => d.uuid === 'dep-002');
		expect(btcDeposit).toBeDefined();
		expect(btcDeposit).not.toHaveProperty('address');

		expect(JSON.stringify(result)).not.toContain(rawBtc?.address as string);
	});

	it('type=withdrawal で入金 API を呼ばない', async () => {
		setupFetchMock({});

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({ asset: 'btc', type: 'withdrawal' });

		assertOk(result);
		expect(result.data.deposits).toHaveLength(0);

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(calledUrls.some((u) => u.includes('deposit_history'))).toBe(false);
	});
});

describe('get_my_deposit_withdrawal — ページの境目と途中の失敗', () => {
	const T0 = 1709900000000;
	const depositAt = (uuid: string, ts: number) => ({
		uuid,
		asset: 'jpy',
		amount: '1000',
		status: 'DONE',
		found_at: ts,
		confirmed_at: ts,
	});

	it('ページの境目と同じミリ秒の入金を取りこぼさない', async () => {
		// 100 件目から 102 件目までが同じ時刻。API の since はその時刻を含むものとして、昇順に 100 件ずつ返す。
		const all = [
			...Array.from({ length: 99 }, (_, i) => depositAt(`dep-${i}`, T0 + i)),
			depositAt('dep-99', T0 + 1000),
			depositAt('dep-100', T0 + 1000),
			depositAt('dep-101', T0 + 1000),
		];
		setupFetchMock({
			customHandler: (url: string) => {
				if (url.includes('deposit_history')) {
					const since = Number(new URL(url).searchParams.get('since') ?? 0);
					const deposits = all.filter((d) => d.confirmed_at >= since).slice(0, 100);
					return new Response(JSON.stringify(mockBitbankSuccess({ deposits })), { status: 200 });
				}
				return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
			},
		});

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({ asset: 'jpy', type: 'deposit' });

		assertOk(result);
		expect(result.data.deposits.map((d) => d.uuid)).toEqual(all.map((d) => d.uuid));
		expect(result.meta.isComplete).toBe(true);
	});

	it('2 ページ目の取得に失敗したら、取得状態を partial にして警告を出す', async () => {
		let depositCalls = 0;
		setupFetchMock({
			customHandler: (url: string) => {
				if (url.includes('deposit_history')) {
					depositCalls++;
					if (depositCalls === 1) {
						const deposits = Array.from({ length: 100 }, (_, i) => depositAt(`dep-${i}`, T0 + i));
						return new Response(JSON.stringify(mockBitbankSuccess({ deposits })), { status: 200 });
					}
					return new Response(JSON.stringify(mockBitbankError(20001)), { status: 400 });
				}
				return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
			},
		});

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({ asset: 'jpy', type: 'deposit' });

		assertOk(result);
		expect(depositCalls).toBe(2);
		expect(result.data.deposits).toHaveLength(100);
		expect(result.meta.isComplete).toBe(false);
		expect(result.meta.hasWarnings).toBe(true);
		expect(result.summary).toContain('取得状態: partial');
	});
});

describe('get_my_deposit_withdrawal — 特定通貨 + since/end 指定', () => {
	it('asset + since/end で単発取得する', async () => {
		setupFetchMock({});

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({
			asset: 'btc',
			since: '2024-03-01T00:00:00Z',
			end: '2024-03-31T00:00:00Z',
		});

		assertOk(result);
		// since/end 指定時は単発取得パス（asset指定あり）
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(calledUrls.some((u) => u.includes('since='))).toBe(true);
	});

	it('出金だけを取得して失敗したら失敗を返す', async () => {
		setupFetchMock({ withdrawalFail: true });

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({ asset: 'btc', type: 'withdrawal' });

		assertFail(result);
		expect(result.meta.errorType).toBe('authentication_error');
	});
});

describe('get_my_deposit_withdrawal — singleFetch エラーパス', () => {
	it('asset + since/end で入金だけを単発取得して失敗したら失敗を返す', async () => {
		setupFetchMock({ depositFail: true });

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({
			asset: 'btc',
			since: '2024-03-01T00:00:00Z',
			type: 'deposit',
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('authentication_error');
	});

	it('asset + since/end で出金だけを単発取得して失敗したら失敗を返す', async () => {
		setupFetchMock({ withdrawalFail: true });

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({
			asset: 'eth',
			since: '2024-03-01T00:00:00Z',
			type: 'withdrawal',
		});

		assertFail(result);
		expect(result.meta.errorType).toBe('authentication_error');
	});

	describe('API asset の取得境界正規化', () => {
		it('小文字レスポンスでは出力の asset 表記が変わらない', async () => {
			setupFetchMock({});

			const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
			const result = await getMyDepositWithdrawal({});

			assertOk(result);
			expect(result.data.deposits.map((d) => d.asset).sort()).toEqual(['btc', 'jpy']);
			expect(result.data.withdrawals.map((w) => w.asset).sort()).toEqual(['eth', 'jpy']);
			expect(result.summary).toContain('BTC');
			expect(result.summary).toContain('JPY 入金');
		});

		it('大文字レスポンスでも JPY / 暗号資産の振り分けと出力表記が小文字レスポンスと一致する', async () => {
			const toUpper = <T extends { asset: string }>(records: T[]) =>
				records.map((r) => ({ ...r, asset: r.asset.toUpperCase() }));
			setupFetchMock({
				depositResponse: { deposits: toUpper(rawDepositHistoryResponse.deposits) },
				withdrawalResponse: { withdrawals: toUpper(rawWithdrawalHistoryResponse.withdrawals) },
			});

			const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
			const result = await getMyDepositWithdrawal({});

			assertOk(result);
			expect(result.data.deposits.map((d) => d.asset).sort()).toEqual(['btc', 'jpy']);
			expect(result.data.withdrawals.map((w) => w.asset).sort()).toEqual(['eth', 'jpy']);
			// 大文字のままだと `d.asset === 'jpy'` が外れ、JPY 入出金が暗号資産側に振り分けられる
			expect(result.summary).toContain('JPY 入金: 1件');
			expect(result.summary).toContain('JPY 出金: 1件');
			expect(result.summary).toContain('暗号資産入庫: 1件');
			expect(result.summary).toContain('暗号資産出庫: 1件');
		});
	});

	it('全通貨 + since/end + 部分失敗で collectResults 警告を含む', async () => {
		setupFetchMock({ withdrawalFail: true });

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({
			since: '2024-03-01T00:00:00Z',
			end: '2024-03-31T00:00:00Z',
		});

		assertOk(result);
		expect(result.meta.hasWarnings).toBe(true);
		expect(result.summary).toContain('警告');
	});
});

describe('get_my_deposit_withdrawal — handler (toolDef)', () => {
	it('handler がデフォルト引数で動作する', async () => {
		setupFetchMock({});

		const { toolDef } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await toolDef.handler({});

		expect((result as { ok: boolean }).ok).toBe(true);
	});
});
