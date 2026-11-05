// ADR-0008: 不正な引数・キー・origin ではサーバーを読み込まず EXIT_USAGE を返し（本番へ戻さない）、正常時は既定のクライアントを差し替えてからサーバーを起動する。出力は stderr だけ。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, mockBitbankSuccess } from '../fixtures/private-api.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env.BITBANK_API_KEY;
	delete process.env.BITBANK_API_SECRET;
	vi.restoreAllMocks();
	vi.resetModules();
});

/** client.ts のシングルトンを持ち越さないよう、毎回 lab/main.ts と client.ts を読み直す */
async function freshModules() {
	vi.resetModules();
	const lab = await import('../../lab/main.js');
	const client = await import('../../src/private/client.js');
	return { lab, client };
}

function harness(argv: string[], startServer: () => Promise<unknown> = async () => undefined) {
	const stderr: string[] = [];
	const stdoutSpy = vi.spyOn(process.stdout, 'write');
	const start = vi.fn(startServer);
	return {
		deps: { argv, writeStderr: (m: string) => stderr.push(m), startServer: start },
		stderr,
		start,
		stdoutSpy,
	};
}

describe('parseLabArgs', () => {
	it.each([
		[['--private-api-origin=http://127.0.0.1:14000'], 'http://127.0.0.1:14000'],
		[['--private-api-origin', 'http://127.0.0.1:14000'], 'http://127.0.0.1:14000'],
		// 中身の検査はクライアント側で行う（ここでは値をそのまま渡す）
		[['--private-api-origin='], ''],
	])('%j → origin を返す', async (argv, origin) => {
		const { lab } = await freshModules();
		expect(lab.parseLabArgs(argv)).toEqual({ ok: true, origin });
	});

	it.each([
		[[], /指定が必要/],
		[['--private-api-origin'], /値がありません/],
		[['--private-api-origin=http://127.0.0.1:1', '--private-api-origin=http://127.0.0.1:2'], /2 回以上/],
		[['--private-api-origin', 'http://127.0.0.1:1', '--private-api-origin=http://127.0.0.1:2'], /2 回以上/],
		[['--origin=http://127.0.0.1:14000'], /未知の引数/],
		[['http://127.0.0.1:14000'], /未知の引数/],
	])('%j → 失敗', async (argv, message) => {
		const { lab } = await freshModules();
		expect(lab.parseLabArgs(argv)).toEqual({ ok: false, error: expect.stringMatching(message) });
	});

	it.each([
		['フラグの値', '--api-secret=s3cr3t'],
		['フラグ無しの userinfo 付き URL', 'http://user:s3cr3t@127.0.0.1:14000'],
	])('未知の引数の中身はエラーに出さない（%s）', async (_label, arg) => {
		const { lab } = await freshModules();
		const parsed = lab.parseLabArgs([arg]);

		expect(parsed).toEqual({
			ok: false,
			error: '未知の引数があります（受け付けるのは --private-api-origin だけです）',
		});
		expect(JSON.stringify(parsed)).not.toContain('s3cr3t');
	});
});

describe('runLab: 起動しない場合', () => {
	it.each([
		['引数なし', []],
		['不正な origin（遠隔）', ['--private-api-origin=https://example.com']],
		['不正な origin（パスの接頭辞）', ['--private-api-origin=http://127.0.0.1:14000/proxy']],
		['不正な origin（空）', ['--private-api-origin=']],
		['不正な origin（本番）', ['--private-api-origin=https://api.bitbank.cc']],
	])('%s → EXIT_USAGE、サーバーを読み込まず、差し替えもしない', async (_label, argv) => {
		const { lab, client } = await freshModules();
		const h = harness(argv);

		await expect(lab.runLab(h.deps)).resolves.toBe(lab.EXIT_USAGE);

		expect(h.start).not.toHaveBeenCalled();
		expect(h.stderr.join('')).toContain('使い方');
		expect(h.stdoutSpy).not.toHaveBeenCalled();
		expect(globalThis.fetch).toBe(originalFetch);
		// 差し替えていないので、まだ既定のクライアントを差し替えられる状態のまま
		expect(() => client.setDefaultClient(new client.BitbankPrivateClient())).not.toThrow();
	});

	it('キーが未設定 → EXIT_USAGE（差し替えても private ツールが無いので起動しない）', async () => {
		delete process.env.BITBANK_API_KEY;
		const { lab } = await freshModules();
		const h = harness(['--private-api-origin=http://127.0.0.1:14000']);

		await expect(lab.runLab(h.deps)).resolves.toBe(lab.EXIT_USAGE);

		expect(h.start).not.toHaveBeenCalled();
		expect(h.stderr.join('')).toContain('BITBANK_API_KEY / BITBANK_API_SECRET が未設定');
		expect(globalThis.fetch).toBe(originalFetch);
	});
});

describe('runLab: 起動する場合', () => {
	it('既定のクライアントを差し替えてからサーバーを起動する', async () => {
		const calls: string[] = [];
		globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
			calls.push(String(input));
			return jsonResponse(mockBitbankSuccess({}));
		}) as unknown as typeof fetch;
		const { lab, client } = await freshModules();
		// サーバーが起動する時点で、既定のクライアントは既に差し替え先を向いている
		const h = harness(['--private-api-origin', 'http://[::1]:14000'], async () => {
			await client.getDefaultClient().get('/v1/user/assets');
			await client.getDefaultClient().post('/v1/user/spot/order', { pair: 'btc_jpy' });
		});

		await expect(lab.runLab(h.deps)).resolves.toBe(0);

		expect(h.start).toHaveBeenCalledTimes(1);
		expect(calls).toEqual(['http://[::1]:14000/v1/user/assets', 'http://[::1]:14000/v1/user/spot/order']);
		expect(() => client.setDefaultClient(new client.BitbankPrivateClient())).toThrow(/既に初期化/);
		expect(h.stderr.join('')).toContain('private API の接続先: http://[::1]:14000');
		expect(h.stdoutSpy).not.toHaveBeenCalled();
	});

	it('起動後は、既定のクライアントを迂回して本番へ向かう fetch を止める（ペア情報と公開 API は通す）', async () => {
		const passed: string[] = [];
		globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
			passed.push(String(input));
			return jsonResponse(mockBitbankSuccess({}));
		}) as unknown as typeof fetch;
		const { lab } = await freshModules();
		const h = harness(['--private-api-origin=http://127.0.0.1:14000']);
		await lab.runLab(h.deps);

		await expect(fetch('https://api.bitbank.cc/v1/user/assets')).rejects.toThrow(/本番の private API/);
		await expect(fetch(new URL('https://api.bitbank.cc/v1/user/spot/order'), { method: 'POST' })).rejects.toThrow(
			/本番の private API/,
		);
		await expect(fetch(new Request('https://API.BITBANK.CC:443/v1/spot/../user/assets'))).rejects.toThrow(
			/本番の private API/,
		);
		await expect(fetch('https://api.bitbank.cc/v1/unknown')).rejects.toThrow(/本番の private API/);

		await fetch('https://api.bitbank.cc/v1/spot/pairs');
		await fetch('https://public.bitbank.cc/btc_jpy/ticker');
		await fetch('http://127.0.0.1:14000/v1/user/assets');

		expect(passed).toEqual([
			'https://api.bitbank.cc/v1/spot/pairs',
			'https://public.bitbank.cc/btc_jpy/ticker',
			'http://127.0.0.1:14000/v1/user/assets',
		]);
		expect(h.stderr.join('')).toContain('本番の private API への要求を止めました: /v1/user/assets');
		expect(h.stdoutSpy).not.toHaveBeenCalled();
	});
});

describe('isBlockedProductionUrl', () => {
	it.each([
		['https://api.bitbank.cc/v1/user/assets', true],
		['https://api.bitbank.cc/v1/user/spot/order', true],
		['https://api.bitbank.cc/', true],
		// 例外は完全一致。`/v1/spot/` 配下でも挙げていないパスは止める
		['https://api.bitbank.cc/v1/spot/unknown', true],
		['https://api.bitbank.cc/v1/spot/pairs/extra', true],
		['https://api.bitbank.cc/v1/spot/', true],
		['https://api.bitbank.cc/v1/spot/pairs', false],
		['https://api.bitbank.cc/v1/spot/pairs?x=1', false],
		['https://public.bitbank.cc/btc_jpy/ticker', false],
		['http://127.0.0.1:14000/v1/user/assets', false],
		['not a url', false],
	])('%s → %s', async (url, blocked) => {
		const { lab } = await freshModules();
		expect(lab.isBlockedProductionUrl(url)).toBe(blocked);
	});
});
