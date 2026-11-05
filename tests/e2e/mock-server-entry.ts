// 環境変数 MOCK_RESPONSES に JSON を渡すと、URL パターンに応じて fetch をモックした状態でサーバーを起動する（例: MOCK_RESPONSES='{"btc_jpy/ticker": {...}}' tsx tests/e2e/mock-server-entry.ts）。

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

await import('../../src/server.js');
