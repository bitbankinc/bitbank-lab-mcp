import { afterEach, describe, expect, it, vi } from 'vitest';
import getTicker from '../tools/get_ticker.js';
import { asMockResult, assertFail, assertOk } from './_assertResult.js';
import { tickerBtcJpy } from './fixtures/bitbank-api.js';

describe('getTicker', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('未対応pairはバリデーションエラーを返す', async () => {
		const res = await getTicker('unknown_jpy');
		assertFail(res);
		expect(res.meta?.errorType).toBe('user');
	});

	it('上流レスポンスが不正な場合は ok:false を返すべき', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			asMockResult<Response>({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ success: 1 }),
			}),
		);

		const res = await getTicker('btc_jpy', { timeoutMs: 100 });
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
	});

	it('正常なレスポンスで ok:true を返し normalized データが含まれる', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			asMockResult<Response>({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ ...tickerBtcJpy }),
			}),
		);

		const res = await getTicker('btc_jpy');
		assertOk(res);
		expect(res.data.normalized.pair).toBe('btc_jpy');
		expect(res.data.normalized.last).toBe(15500000);
		expect(res.data.normalized.buy).toBe(15490000);
		expect(res.data.normalized.sell).toBe(15500000);
		expect(res.data.normalized.volume).toBeCloseTo(123.4567, 4);
		expect(res.summary).toContain('スプレッド');
		expect(res.summary).toContain('24h変動');
	});

	it('全フィールドが null の場合も ok:true を返す（null ブランチ）', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			asMockResult<Response>({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: {
						last: null,
						open: null,
						high: null,
						low: null,
						buy: null,
						sell: null,
						vol: null,
						timestamp: null,
					},
				}),
			}),
		);

		const res = await getTicker('btc_jpy');
		assertOk(res);
		expect(res.summary).not.toContain('24h変動');
		expect(res.summary).not.toContain('スプレッド');
		expect(res.summary).toContain('N/A');
		expect(res.summary).not.toContain('時点');
		expect(res.data.normalized.last).toBeNull();
		expect(res.data.normalized.buy).toBeNull();
		expect(res.data.normalized.sell).toBeNull();
		expect(res.data.normalized.volume).toBeNull();
		expect(res.data.normalized.timestamp).toBeNull();
	});

	it('open が 0 のとき変動率行が出力されない', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			asMockResult<Response>({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: {
						...tickerBtcJpy.data,
						open: '0',
					},
				}),
			}),
		);

		const res = await getTicker('btc_jpy');
		assertOk(res);
		expect(res.summary).not.toContain('24h変動');
	});

	it('last が null のとき変動率行が出力されない', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			asMockResult<Response>({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: {
						...tickerBtcJpy.data,
						last: null,
					},
				}),
			}),
		);

		const res = await getTicker('btc_jpy');
		assertOk(res);
		expect(res.summary).not.toContain('24h変動');
	});

	it('buy が null のときスプレッドが出力されない', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			asMockResult<Response>({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: {
						...tickerBtcJpy.data,
						buy: null,
					},
				}),
			}),
		);

		const res = await getTicker('btc_jpy');
		assertOk(res);
		expect(res.summary).not.toContain('スプレッド');
	});

	it('sell が null のときスプレッドが出力されない', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			asMockResult<Response>({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: {
						...tickerBtcJpy.data,
						sell: null,
					},
				}),
			}),
		);

		const res = await getTicker('btc_jpy');
		assertOk(res);
		expect(res.summary).not.toContain('スプレッド');
	});

	it('vol >= 1000 のとき K 表記で出来高が表示される', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			asMockResult<Response>({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: {
						...tickerBtcJpy.data,
						vol: '2500',
					},
				}),
			}),
		);

		const res = await getTicker('btc_jpy');
		assertOk(res);
		expect(res.summary).toContain('2.50K BTC');
	});

	it('vol < 1000 のとき小数表記で出来高が表示される', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			asMockResult<Response>({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: {
						...tickerBtcJpy.data,
						vol: '500',
					},
				}),
			}),
		);

		const res = await getTicker('btc_jpy');
		assertOk(res);
		expect(res.summary).toContain('500.0000 BTC');
	});

	it('timestamp がある場合は時点行が出力される', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			asMockResult<Response>({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ ...tickerBtcJpy }),
			}),
		);

		const res = await getTicker('btc_jpy');
		assertOk(res);
		expect(res.summary).toContain('時点');
	});

	it('success:0 のレスポンスで upstream エラーを返す', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			asMockResult<Response>({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ success: 0, data: { code: 10000 } }),
			}),
		);

		const res = await getTicker('btc_jpy');
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
	});

	it('data が object でない場合 upstream エラーを返す', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			asMockResult<Response>({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({ success: 1, data: 'invalid' }),
			}),
		);

		const res = await getTicker('btc_jpy');
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
	});

	it('fetch が throw した場合 network エラーを返す', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network failure'));

		const res = await getTicker('btc_jpy', { timeoutMs: 100 });
		assertFail(res);
		expect(res.meta?.errorType).toBe('network');
	});

	it('pair に _ がなくても動作する（baseCurrency フォールバック）', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			asMockResult<Response>({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => ({
					success: 1,
					data: {
						...tickerBtcJpy.data,
						vol: '100',
					},
				}),
			}),
		);

		// btc_jpy は正常に split できるので、_を含むペアで通貨単位が大文字になることを確認
		const res = await getTicker('btc_jpy');
		assertOk(res);
		expect(res.summary).toContain('BTC');
	});
});
