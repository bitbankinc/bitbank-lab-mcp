import type http from 'node:http';
import { createServer } from 'node:http';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * src/http.ts のレート制限ミドルウェアと同一構成で
 * express + express-rate-limit の動作を検証する。
 * stdio トランスポートにはレート制限が適用されないことを暗黙的に保証
 * （express ミドルウェアなので HTTP 以外には影響しない）。
 *
 * SKIP_NETWORK_TESTS=1 または 127.0.0.1:0 への bind が EACCES/EADDRNOTAVAIL 等で
 * 失敗するサンドボックス環境では describe ごと skip する。
 * （実装バグと環境制約を区別するため、原因不明の listen 失敗は throw する。）
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 3; // テスト用に少数

type ProbeResult = { ok: true } | { ok: false; reason: string };

async function probeLocalhostBind(): Promise<ProbeResult> {
	if (process.env.SKIP_NETWORK_TESTS === '1') {
		return { ok: false, reason: 'SKIP_NETWORK_TESTS=1 が指定されています' };
	}
	return new Promise<ProbeResult>((resolve) => {
		const srv = createServer();
		srv.once('error', (err) => {
			const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
			if (code === 'EACCES' || code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT' || code === 'EPERM') {
				resolve({ ok: false, reason: `127.0.0.1:0 への bind が ${code} で失敗 (サンドボックス環境の可能性)` });
			} else {
				// 想定外のエラーは握り潰さず実テストでも fail させたいので ok 扱いにする
				resolve({ ok: true });
			}
		});
		srv.once('listening', () => {
			srv.close(() => resolve({ ok: true }));
		});
		srv.listen(0, '127.0.0.1');
	});
}

// vitest はテストファイルをトップレベルで評価する。
// describe.skipIf に渡す条件を確定させるため、ここで bind probe を await する。
const probe = await probeLocalhostBind();
const SKIP = !probe.ok;
const SKIP_REASON = probe.ok ? '' : probe.reason;

if (SKIP) {
	console.warn(`[http-rate-limit] skipping suite: ${SKIP_REASON}`);
}

/**
 * 127.0.0.1:0 で listen し、bind 完了まで待つ。
 * - 成功 → http.Server を返す
 * - 失敗 → reject (EACCES, EADDRNOTAVAIL 等)
 *
 * 旧実装は listen のコールバックのみを resolve に繋げていたため、
 * bind 失敗時は error イベントだけが発火して beforeAll が無限待ちになり、
 * 続く server.address() が null になっていた。
 */
function listenLocal(app: express.Express): Promise<http.Server> {
	return new Promise((resolve, reject) => {
		const srv = app.listen(0, '127.0.0.1');
		srv.once('listening', () => {
			srv.removeListener('error', reject);
			resolve(srv);
		});
		srv.once('error', reject);
	});
}

function addressOf(srv: http.Server): { host: string; port: number } {
	const addr = srv.address();
	if (!addr || typeof addr === 'string') {
		throw new Error(
			`server.address() returned ${addr === null ? 'null' : `string=${addr}`}; ` +
				'listen が完了していない可能性があります。',
		);
	}
	return { host: '127.0.0.1', port: addr.port };
}

describe.skipIf(SKIP)('HTTP rate limiting on /mcp', () => {
	let server: http.Server;
	let baseUrl: string;

	beforeAll(async () => {
		const app = express();

		const limiter = rateLimit({
			windowMs: WINDOW_MS,
			max: MAX_REQUESTS,
			standardHeaders: 'draft-7',
			legacyHeaders: false,
			message: { error: 'Too many requests. Please try again later.' },
		});

		app.use('/mcp', limiter);
		app.post('/mcp', (_req, res) => {
			res.json({ ok: true });
		});

		// レート制限の対象外
		app.get('/health', (_req, res) => {
			res.json({ ok: true });
		});

		server = await listenLocal(app);
		const { host, port } = addressOf(server);
		baseUrl = `http://${host}:${port}`;
	});

	afterAll(async () => {
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
	});

	it('制限内のリクエストは 200 を返す', async () => {
		const res = await fetch(`${baseUrl}/mcp`, { method: 'POST' });
		expect(res.status).toBe(200);
		// draft-7: combined RateLimit ヘッダ
		const rl = res.headers.get('ratelimit');
		expect(rl).toContain(`limit=${MAX_REQUESTS}`);
	});

	it('制限超過で 429 を返す', async () => {
		// 残り枠を使い切る（beforeAll 後 1 回使用済みなので MAX-1 回追加）
		for (let i = 0; i < MAX_REQUESTS - 1; i++) {
			await fetch(`${baseUrl}/mcp`, { method: 'POST' });
		}

		const res = await fetch(`${baseUrl}/mcp`, { method: 'POST' });
		expect(res.status).toBe(429);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain('Too many requests');
	});

	it('/health はレート制限の対象外', async () => {
		// /mcp が制限超過でも /health は影響を受けない
		const res = await fetch(`${baseUrl}/health`);
		expect(res.status).toBe(200);
	});

	it('レスポンスに RateLimit 標準ヘッダが含まれる', async () => {
		// 新しいウィンドウで確認するため別 app を作る
		const app2 = express();
		const limiter2 = rateLimit({
			windowMs: WINDOW_MS,
			max: 10,
			standardHeaders: 'draft-7',
			legacyHeaders: false,
		});
		app2.use('/mcp', limiter2);
		app2.post('/mcp', (_req, res) => res.json({ ok: true }));

		const srv2 = await listenLocal(app2);
		const { port: port2 } = addressOf(srv2);

		try {
			const res = await fetch(`http://127.0.0.1:${port2}/mcp`, { method: 'POST' });
			expect(res.status).toBe(200);
			// draft-7: "limit=10, remaining=9, reset=N" 形式
			const rl = res.headers.get('ratelimit');
			expect(rl).toContain('limit=10');
			expect(rl).toContain('remaining=9');
			expect(rl).toMatch(/reset=\d+/);
			// RateLimit-Policy ヘッダも付与される
			expect(res.headers.get('ratelimit-policy')).toBeTruthy();
		} finally {
			await new Promise<void>((resolve, reject) => {
				srv2.close((err) => (err ? reject(err) : resolve()));
			});
		}
	});
});
