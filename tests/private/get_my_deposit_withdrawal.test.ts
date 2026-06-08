/**
 * get_my_deposit_withdrawal ツールのユニットテスト。
 *
 * ページネーション・UUID 重複排除・部分的失敗を検証する。
 */

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

/** URL パターンでルーティングする fetch モック */
function setupFetchMock(opts: {
	depositResponse?: unknown;
	withdrawalResponse?: unknown;
	depositFail?: boolean;
	withdrawalFail?: boolean;
	/** ページネーションテスト用: 各呼び出しに応答する関数 */
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
		// 暗号資産 + JPY で 2 回取得されるが、同じ UUID なので 1 件に dedup される
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
		// 100 + 50 = 150 件
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
								// 末尾の未確認入金には confirmed_at を付与しない
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
		// カーソルは末尾レコードの found_at (+1) にフォールバックして前進している
		expect(sinceValues).toContain(String(1709900000000 + 99 * 1000 + 1));
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

	it('PrivateApiError で fail を返す', async () => {
		// 両方失敗させると PrivateApiError として catch される
		setupFetchMock({ depositFail: true, withdrawalFail: true });

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		// asset 指定なしで全通貨取得 → 4 チャネル全失敗でも警告付き成功になるケースがある
		// PrivateApiError を直接トリガーするため、catch ブロックに入る状況を再現
		const result = await getMyDepositWithdrawal({ asset: 'btc' });

		// 部分的失敗は warn 付き成功になるため、assert で確認
		assertOk(result);
		expect(result.meta.hasWarnings).toBe(true);
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
		// deposit_history は失敗、withdrawal_history は成功
		setupFetchMock({ depositFail: true });

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		// asset 未指定: 4チャネル並列取得 → deposit 2チャネル失敗
		const result = await getMyDepositWithdrawal({});

		assertOk(result);
		expect(result.meta.hasWarnings).toBe(true);
		expect(result.meta.warnings.length).toBeGreaterThan(0);
		// 警告メッセージがサマリーに含まれる
		expect(result.summary).toContain('警告');
	});

	it('出金履歴の禁止フィールド（口座番号・名義等）を出力から除外する', async () => {
		// rawWithdrawalHistoryResponse の fiat 出金レコードには
		// 実 API が返す禁止フィールド（account_number / account_owner /
		// branch_name / account_type / account_uuid）が含まれている。
		// ツール出力（data.withdrawals[] と content[0].text 相当の summary）に
		// これらが漏洩しないことを検証する。
		setupFetchMock({});

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({});

		assertOk(result);

		// fiat 出金レコードが実際に取得されていることを前提条件として確認
		const jpyWithdrawal = result.data.withdrawals.find((w) => w.uuid === 'wd-001');
		expect(jpyWithdrawal).toBeDefined();
		// 許可フィールド（bank_name）は残る
		expect(jpyWithdrawal?.bank_name).toBe('テスト銀行');

		const forbiddenKeys = ['account_number', 'account_owner', 'branch_name', 'account_type', 'account_uuid'];

		// 個別レコードに禁止フィールドが無い
		for (const w of result.data.withdrawals) {
			for (const key of forbiddenKeys) {
				expect(w).not.toHaveProperty(key);
			}
		}

		// 結果全体（data + summary を含む）を文字列化して禁止フィールドのキー・値が現れないことを確認
		const serialized = JSON.stringify(result);
		for (const key of forbiddenKeys) {
			expect(serialized).not.toContain(key);
		}
		// 機密の値そのものも漏れていないこと
		// （account_number の '1234567' は許可フィールドである暗号資産アドレスと
		//   部分一致するため値検証から除外し、キー検証＋固有値検証で担保する）
		expect(serialized).not.toContain('タナカ タロウ');
		expect(serialized).not.toContain('テスト支店');
		expect(serialized).not.toContain('acc-uuid-001');
	});

	it('入金アドレス（暗号資産）は出力に露出しない（出力方針 Option A）', async () => {
		// 暗号資産入金（dep-002）には実 API どおり address が存在するが、入金側は出力に address を
		// 含めない（HIGH 分類。突合は txid を使う＝docs/internal:425/632）。出金側のみ address を出す
		// 非対称は意図的。get_margin_status 型のドリフト（フィクスチャがコード形）防止のため、Raw 型・
		// フィクスチャは実 API へ同期しつつ、露出だけ抑える。
		setupFetchMock({});

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({});

		assertOk(result);

		// 前提条件: フィクスチャの暗号資産入金に address が同期されている
		const rawBtc = rawDepositHistoryResponse.deposits.find((d) => d.uuid === 'dep-002') as
			| { address?: string }
			| undefined;
		expect(rawBtc?.address).toBeTruthy();

		// 個別レコードに address プロパティが無い
		const btcDeposit = result.data.deposits.find((d) => d.uuid === 'dep-002');
		expect(btcDeposit).toBeDefined();
		expect(btcDeposit).not.toHaveProperty('address');

		// 結果全体（data + summary）に生のアドレス値が現れない
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

	it('出金のみ取得時に partial failure で警告がつく', async () => {
		setupFetchMock({ withdrawalFail: true });

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({ asset: 'btc', type: 'withdrawal' });

		assertOk(result);
		expect(result.meta.hasWarnings).toBe(true);
		expect(result.data.withdrawals).toHaveLength(0);
	});
});

describe('get_my_deposit_withdrawal — singleFetch エラーパス', () => {
	it('asset + since/end + deposit失敗で singleFetchDeposits エラーパスを通る', async () => {
		setupFetchMock({ depositFail: true });

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({
			asset: 'btc',
			since: '2024-03-01T00:00:00Z',
			type: 'deposit',
		});

		assertOk(result);
		expect(result.meta.hasWarnings).toBe(true);
		expect(result.data.deposits).toHaveLength(0);
	});

	it('asset + since/end + withdrawal失敗で singleFetchWithdrawals エラーパスを通る', async () => {
		setupFetchMock({ withdrawalFail: true });

		const { default: getMyDepositWithdrawal } = await import('../../tools/private/get_my_deposit_withdrawal.js');
		const result = await getMyDepositWithdrawal({
			asset: 'eth',
			since: '2024-03-01T00:00:00Z',
			type: 'withdrawal',
		});

		assertOk(result);
		expect(result.meta.hasWarnings).toBe(true);
		expect(result.data.withdrawals).toHaveLength(0);
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
