// 環境変数 MOCK_RESPONSES に JSON を渡すと、URL パターンに応じて fetch をモックした状態でサーバーを起動する（例: MOCK_RESPONSES='{"btc_jpy/ticker": {...}}' tsx tests/e2e/mock-server-entry.ts）。

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockMap: Record<string, unknown> = {};

const raw = process.env.MOCK_RESPONSES;
if (raw) {
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	for (const [pattern, body] of Object.entries(parsed)) {
		mockMap[pattern] = body;
	}
}

if (Object.keys(mockMap).length > 0) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		for (const [pattern, body] of Object.entries(mockMap)) {
			if (url.includes(pattern)) {
				return new Response(JSON.stringify(body), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
		}
		// モック未定義の URL は実際の fetch にフォールバック
		return originalFetch(input, init);
	}) as typeof fetch;
}

// オプトイン時の確認の共有フォルダ（ADR-0007 判断事項 D）を、ホームではなくテスト用のフォルダにする。2 プロセスで共有させる E2E は同じ値を渡す。
const { _setSharedConfirmStateDirForTests } = await import('../../src/private/shared-confirm-state.js');
_setSharedConfirmStateDirForTests(
	process.env.E2E_SHARED_CONFIRM_STATE_DIR ?? mkdtempSync(path.join(os.tmpdir(), 'bitbank-e2e-confirm-')),
);

await import('../../src/server.js');
