import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub fs before importing logger
vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...actual,
		default: { ...actual, appendFileSync: vi.fn(), existsSync: vi.fn(() => true), mkdirSync: vi.fn() },
	};
});

const { logToolRun, logError, logTradeAction, _resetWriteFailureNotice } = await import('../../lib/logger.js');

/** tests/lib/ の 2 つ上 = パッケージルート（lib/logger.ts 側の PACKAGE_ROOT と一致する） */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXPECTED_LOG_DIR = process.env.LOG_DIR || path.join(PACKAGE_ROOT, 'logs');

describe('logger sensitive field masking', () => {
	beforeEach(() => {
		vi.mocked(fs.appendFileSync).mockClear();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('masks confirmation_token in logToolRun input', () => {
		logToolRun({
			tool: 'create_order',
			input: { pair: 'btc_jpy', confirmation_token: 'secret-hmac-value', token_expires_at: 999 },
			result: { ok: true, summary: 'done' },
			ms: 10,
		});

		const call = vi.mocked(fs.appendFileSync).mock.calls[0];
		expect(call).toBeDefined();
		const logged = JSON.parse(call[1] as string);
		expect(logged.input.confirmation_token).toBe('***');
		expect(logged.input.pair).toBe('btc_jpy');
		expect(logged.input.token_expires_at).toBe(999);
	});

	it('masks confirmation_token in logError input', () => {
		logError('cancel_order', new Error('boom'), {
			pair: 'eth_jpy',
			confirmation_token: 'another-secret',
		});

		const call = vi.mocked(fs.appendFileSync).mock.calls[0];
		expect(call).toBeDefined();
		const logged = JSON.parse(call[1] as string);
		expect(logged.input.confirmation_token).toBe('***');
		expect(logged.input.pair).toBe('eth_jpy');
	});

	it('masks token field in nested objects', () => {
		logToolRun({
			tool: 'test_tool',
			input: { nested: { token: 'should-be-masked' }, safe: 'visible' },
			result: { ok: true },
			ms: 5,
		});

		const call = vi.mocked(fs.appendFileSync).mock.calls[0];
		const logged = JSON.parse(call[1] as string);
		expect(logged.input.nested.token).toBe('***');
		expect(logged.input.safe).toBe('visible');
	});

	it('handles null/undefined input gracefully', () => {
		expect(() => logToolRun({ tool: 't', input: null, result: null, ms: 0 })).not.toThrow();
		expect(() => logError('t', new Error('e'), undefined)).not.toThrow();
	});
});

describe('ログ出力先', () => {
	beforeEach(() => {
		vi.mocked(fs.appendFileSync).mockClear();
	});
	afterEach(() => {
		vi.mocked(fs.appendFileSync).mockReset();
		vi.restoreAllMocks();
	});

	// MCP サーバーはホストが spawn するため cwd を制御できない（Claude Desktop / macOS では `/`）。
	// 出力先が cwd 相対だと `/logs` の作成が EACCES で落ち、取引監査ログごと黙って消える。
	it('cwd に依存しない絶対パスへ書く', () => {
		logToolRun({ tool: 'get_ticker', input: { pair: 'btc_jpy' }, result: { ok: true }, ms: 1 });

		const [file] = vi.mocked(fs.appendFileSync).mock.calls[0] as [string, string];
		expect(path.isAbsolute(file)).toBe(true);
		expect(path.dirname(file)).toBe(EXPECTED_LOG_DIR);
	});

	it('取引監査ログも同じ出力先へ書く', () => {
		logTradeAction({ type: 'create_order', pair: 'btc_jpy', status: 'UNFILLED', confirmed: true });

		const [file] = vi.mocked(fs.appendFileSync).mock.calls[0] as [string, string];
		expect(path.dirname(file)).toBe(EXPECTED_LOG_DIR);
	});

	// 上の 2 つは「絶対パスであること」までしか見ておらず、`path.resolve('./logs')` のような
	// **絶対パスだが cwd 依存** の実装を素通りさせる。実際に cwd を動かしてモジュールを
	// 読み直し、出力先が変わらないことまで確認する（vitest の cwd は通常
	// PACKAGE_ROOT と一致するため、cwd を変えないと差が出ない）。
	it('cwd を別ディレクトリへ移しても出力先が変わらない', async () => {
		const originalCwd = process.cwd();
		try {
			process.chdir(os.tmpdir());
			expect(process.cwd()).not.toBe(PACKAGE_ROOT);

			// LOG_DIR はモジュール評価時に一度だけ解決されるので、読み直して再評価させる
			vi.resetModules();
			const reloaded = await import('../../lib/logger.js');

			vi.mocked(fs.appendFileSync).mockClear();
			reloaded.logToolRun({ tool: 'get_ticker', input: {}, result: { ok: true }, ms: 1 });
			reloaded.logTradeAction({ type: 'create_order', pair: 'btc_jpy', status: 'UNFILLED', confirmed: true });

			const dirs = vi.mocked(fs.appendFileSync).mock.calls.map(([file]) => path.dirname(file as string));
			expect(dirs).toHaveLength(2);
			for (const dir of dirs) expect(dir).toBe(EXPECTED_LOG_DIR);
		} finally {
			process.chdir(originalCwd);
		}
	});
});

describe('書き込み失敗の扱い', () => {
	beforeEach(() => {
		_resetWriteFailureNotice();
		vi.mocked(fs.appendFileSync).mockClear();
	});
	afterEach(() => {
		vi.mocked(fs.appendFileSync).mockReset();
		vi.restoreAllMocks();
	});

	it('例外を投げず、stderr へ 1 回だけ通知する', () => {
		const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		vi.mocked(fs.appendFileSync).mockImplementation(() => {
			throw new Error('EACCES: permission denied');
		});

		expect(() => logToolRun({ tool: 't', input: {}, result: { ok: true }, ms: 1 })).not.toThrow();
		expect(() => logToolRun({ tool: 't', input: {}, result: { ok: true }, ms: 1 })).not.toThrow();

		expect(stderr).toHaveBeenCalledTimes(1);
		expect(String(stderr.mock.calls[0][0])).toContain('ログを書き込めません');
	});

	// stdout は JSON-RPC ストリームそのもの。混ぜるとプロトコルが壊れる。
	it('stdout には書かない', () => {
		const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		vi.mocked(fs.appendFileSync).mockImplementation(() => {
			throw new Error('EACCES: permission denied');
		});

		logToolRun({ tool: 't', input: {}, result: { ok: true }, ms: 1 });

		expect(stdout).not.toHaveBeenCalled();
	});

	it('通知にログレコード本文（機密フィールドを含みうる）を載せない', () => {
		const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		vi.mocked(fs.appendFileSync).mockImplementation(() => {
			throw new Error('EACCES: permission denied');
		});

		logToolRun({
			tool: 'create_order',
			input: { pair: 'btc_jpy', confirmation_token: 'secret-hmac-value' },
			result: { ok: true },
			ms: 1,
		});

		expect(String(stderr.mock.calls[0][0])).not.toContain('secret-hmac-value');
	});

	it('取引監査ログの書き込み失敗も通知する', () => {
		const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		vi.mocked(fs.appendFileSync).mockImplementation(() => {
			throw new Error('EACCES: permission denied');
		});

		expect(() =>
			logTradeAction({ type: 'cancel_order', pair: 'btc_jpy', status: 'CANCELED', confirmed: true }),
		).not.toThrow();
		expect(stderr).toHaveBeenCalledTimes(1);
	});

	// 追記前にチェーンを進めると、書き込まれなかったレコードの hash を次レコードが指し、
	// 改ざんが無いのに verify_log_integrity がチェーン断絶として検出する。
	it('追記に失敗したレコードでチェーンハッシュを進めない', () => {
		vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		const written: string[] = [];
		vi.mocked(fs.appendFileSync).mockImplementation(((_file: unknown, data: unknown) => {
			written.push(String(data));
		}) as never);

		const base = { type: 'create_order', pair: 'btc_jpy', confirmed: true } as const;
		logTradeAction({ ...base, status: 'OK-1' });

		vi.mocked(fs.appendFileSync).mockImplementationOnce(() => {
			throw new Error('EACCES: permission denied');
		});
		logTradeAction({ ...base, status: 'WRITE-FAILED' });

		logTradeAction({ ...base, status: 'OK-2' });

		expect(written).toHaveLength(2);
		const [ok1, ok2] = written.map((line) => JSON.parse(line));
		expect(ok1.status).toBe('OK-1');
		expect(ok2.status).toBe('OK-2');
		expect(ok2._prevHash).toBe(ok1._hash);
	});
});
