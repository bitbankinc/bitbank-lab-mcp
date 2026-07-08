import { afterEach, describe, expect, it, vi } from 'vitest';
import getTransactions, { toolDef } from '../tools/get_transactions.js';
import { assertFail, assertOk } from './_assertResult.js';

type TxInput = {
	transaction_id?: number;
	price: string;
	amount: string;
	side: 'buy' | 'sell';
	executed_at: string;
};

function buildTransactions(count: number, opts?: { startId?: number }): TxInput[] {
	const baseTs = 1_700_000_000_000;
	const startId = opts?.startId ?? 1_000_000;
	return Array.from({ length: count }, (_, i) => ({
		transaction_id: startId + i,
		price: String(5_000_000 + i),
		amount: '0.01',
		side: i % 2 === 0 ? 'buy' : 'sell',
		executed_at: String(baseTs + i * 1000),
	}));
}

function mockFetchOk(body: unknown, headers: Record<string, string> = {}) {
	// 実 Fetch API の Headers は case-insensitive。case-sensitive な独自 mock だと
	// 呼び出し側が異なる casing でアクセスしたとき本番と挙動が乖離するため、
	// 標準 Headers クラスでラップして本番と等価な挙動にする。
	return vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		statusText: 'OK',
		headers: new Headers(headers),
		json: async () => body,
	}) as unknown as typeof fetch;
}

describe('get_transactions', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	// ── inputSchema ──

	it('inputSchema: date は YYYYMMDD 形式のみ許可する', () => {
		const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', date: '2024-01-01' });
		expect(parse).toThrow();
	});

	it('inputSchema: date が 8 桁数字なら通る', () => {
		const parsed = toolDef.inputSchema.parse({ pair: 'btc_jpy', date: '20240101' });
		expect((parsed as { date: string }).date).toBe('20240101');
	});

	it('inputSchema: 9 桁の日付らしき文字列は拒否する（^\\d{8}$ 想定）', () => {
		const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', date: '202401011' });
		expect(parse).toThrow();
	});

	// ── 正常系 ──

	it('正常系: limit 件数だけ normalized を返す', async () => {
		globalThis.fetch = mockFetchOk({
			success: 1,
			data: { transactions: buildTransactions(8) },
		});

		const res = await getTransactions('btc_jpy', 5);
		assertOk(res);
		expect(res.data.normalized).toHaveLength(5);
		expect(res.meta.count).toBe(5);
	});

	it('正常系: デフォルト 60 件を返す（直接呼び出し時）', async () => {
		globalThis.fetch = mockFetchOk({
			success: 1,
			data: { transactions: buildTransactions(120) },
		});

		const res = await getTransactions('btc_jpy');
		assertOk(res);
		expect(res.data.normalized).toHaveLength(60);
	});

	it('正常系: transaction_id を normalized に保持する', async () => {
		globalThis.fetch = mockFetchOk({
			success: 1,
			data: { transactions: buildTransactions(3, { startId: 42_000_000 }) },
		});

		const res = await getTransactions('btc_jpy', 3);
		assertOk(res);
		const ids = res.data.normalized.map((t: { transaction_id?: number }) => t.transaction_id);
		expect(ids).toEqual([42_000_000, 42_000_001, 42_000_002]);
	});

	it('正常系: transaction_id が上流に無い場合は欠損として落とさない（normalized は残り、id のみ undefined）', async () => {
		const rows = buildTransactions(2);
		const stripped = rows.map(({ transaction_id: _omit, ...rest }) => rest);
		globalThis.fetch = mockFetchOk({ success: 1, data: { transactions: stripped } });

		const res = await getTransactions('btc_jpy', 2);
		assertOk(res);
		expect(res.data.normalized).toHaveLength(2);
		expect(res.data.normalized[0].transaction_id).toBeUndefined();
	});

	it('正常系: 空配列でも ok を返す（fail にしない）', async () => {
		globalThis.fetch = mockFetchOk({ success: 1, data: { transactions: [] } });

		const res = await getTransactions('btc_jpy', 10);
		assertOk(res);
		expect(res.data.normalized).toHaveLength(0);
		expect(res.meta.count).toBe(0);
	});

	it('正常系: meta.source は date 未指定で "latest"、指定で "by_date"', async () => {
		globalThis.fetch = mockFetchOk({ success: 1, data: { transactions: buildTransactions(2) } });
		const latest = await getTransactions('btc_jpy', 2);
		assertOk(latest);
		expect(latest.meta.source).toBe('latest');

		globalThis.fetch = mockFetchOk({ success: 1, data: { transactions: buildTransactions(2) } });
		const byDate = await getTransactions('btc_jpy', 2, '20240101');
		assertOk(byDate);
		expect(byDate.meta.source).toBe('by_date');
	});

	// ── URL 構築 ──

	it('URL: date 指定時に /transactions/{YYYYMMDD} に当たる', async () => {
		const fetchMock = mockFetchOk({ success: 1, data: { transactions: buildTransactions(1) } });
		globalThis.fetch = fetchMock;
		await getTransactions('btc_jpy', 10, '20240315');
		const url = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string;
		expect(url).toBe('https://public.bitbank.cc/btc_jpy/transactions/20240315');
	});

	it('URL: date が 8 桁以外（部分一致しない長さ）の場合は /transactions に当たる', async () => {
		const fetchMock = mockFetchOk({ success: 1, data: { transactions: buildTransactions(1) } });
		globalThis.fetch = fetchMock;
		// 内部の正規表現が /^\d{8}$/ に締まっているため 9 桁では date URL を組まない
		await getTransactions('btc_jpy', 10, '202403150');
		const url = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string;
		expect(url).toBe('https://public.bitbank.cc/btc_jpy/transactions');
	});

	// ── 異常系 ──

	it('API異常系: success:0 を upstream エラーとして明示分類する', async () => {
		globalThis.fetch = mockFetchOk({ success: 0, data: { code: 10000 } });

		const res = await getTransactions('btc_jpy', 10);
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
		expect(res.summary).toContain('code: 10000');
	});

	it('API異常系: success:0 で data.code が無くても upstream として返す', async () => {
		globalThis.fetch = mockFetchOk({ success: 0, data: {} });

		const res = await getTransactions('btc_jpy', 10);
		assertFail(res);
		expect(res.meta?.errorType).toBe('upstream');
	});

	it('API異常系: AbortError は timeout 分類されるべき', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const res = await getTransactions('btc_jpy', 10);
		assertFail(res);
		expect(res.meta?.errorType).toBe('timeout');
	});

	it('API異常系: ネットワーク失敗時はエラーメッセージに URL を含める', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const res = await getTransactions('btc_jpy', 10);
		assertFail(res);
		expect(res.summary).toContain('https://public.bitbank.cc/btc_jpy/transactions');
	});

	// ── 上流データ品質 ──

	describe('上流データ品質', () => {
		it('price 欠損行はドロップし、件数を meta.warning と summary に出す', async () => {
			const baseTs = 1_700_000_000_000;
			const rows: Array<Record<string, unknown>> = [
				{ transaction_id: 1, price: '5000000', amount: '0.01', side: 'buy', executed_at: String(baseTs) },
				{ transaction_id: 2, amount: '0.02', side: 'sell', executed_at: String(baseTs + 1000) },
				{ transaction_id: 3, price: '5000003', amount: '0.03', side: 'buy', executed_at: String(baseTs + 2000) },
				{ transaction_id: 4, amount: '0.04', side: 'sell', executed_at: String(baseTs + 3000) },
			];
			globalThis.fetch = mockFetchOk({ success: 1, data: { transactions: rows } });

			const res = await getTransactions('btc_jpy', 10);
			assertOk(res);
			expect(res.data.normalized).toHaveLength(2);
			expect(typeof res.meta.warning).toBe('string');
			expect(res.meta.warning).toContain('2件');
			expect(res.summary).toContain(res.meta.warning);
		});

		it('不正な side の行はドロップし、件数を warning に出す', async () => {
			const baseTs = 1_700_000_000_000;
			const rows: Array<Record<string, unknown>> = [
				{ transaction_id: 1, price: '5000000', amount: '0.01', side: 'buy', executed_at: String(baseTs) },
				{ transaction_id: 2, price: '5000001', amount: '0.02', side: 'invalid', executed_at: String(baseTs + 1000) },
				{ transaction_id: 3, price: '5000002', amount: '0.03', side: 'sell', executed_at: String(baseTs + 2000) },
				{ transaction_id: 4, price: '5000003', amount: '0.04', side: 'buy', executed_at: String(baseTs + 3000) },
			];
			globalThis.fetch = mockFetchOk({ success: 1, data: { transactions: rows } });

			const res = await getTransactions('btc_jpy', 10);
			assertOk(res);
			expect(res.data.normalized).toHaveLength(3);
			expect(typeof res.meta.warning).toBe('string');
			expect(res.meta.warning).toContain('1件');
			expect(res.summary).toContain(res.meta.warning);
		});

		it('全件正常時は meta.warning を出さない', async () => {
			globalThis.fetch = mockFetchOk({ success: 1, data: { transactions: buildTransactions(4) } });

			const res = await getTransactions('btc_jpy', 10);
			assertOk(res);
			expect(res.data.normalized).toHaveLength(4);
			expect(res.meta.warning).toBeUndefined();
		});
	});

	// ── ペア / limit バリデーション ──

	it('バリデーション: 未対応 pair は fail を返す', async () => {
		const res = await getTransactions('zzz_jpy', 10);
		assertFail(res);
	});

	it('バリデーション: limit が範囲外なら fail を返す', async () => {
		const res = await getTransactions('btc_jpy', 0);
		assertFail(res);
	});

	// ── handler 経由のフィルタ ──

	describe('toolDef.handler 経由のフィルタ', () => {
		function fixture(items: TxInput[]) {
			globalThis.fetch = mockFetchOk({ success: 1, data: { transactions: items } });
		}

		const rows: TxInput[] = [
			{ transaction_id: 1, price: '4000000', amount: '0.05', side: 'buy', executed_at: '1700000000000' },
			{ transaction_id: 2, price: '5000000', amount: '0.5', side: 'sell', executed_at: '1700000001000' },
			{ transaction_id: 3, price: '6000000', amount: '1.0', side: 'buy', executed_at: '1700000002000' },
			{ transaction_id: 4, price: '7000000', amount: '2.0', side: 'sell', executed_at: '1700000003000' },
		];

		it('minAmount は下限フィルタが効く', async () => {
			fixture(rows);
			const res = (await toolDef.handler({ pair: 'btc_jpy', limit: 10, minAmount: 0.5 })) as {
				ok: true;
				data: { normalized: Array<{ amount: number }> };
			};
			expect(res.ok).toBe(true);
			expect(res.data.normalized.map((t) => t.amount)).toEqual([0.5, 1.0, 2.0]);
		});

		it('maxAmount は上限フィルタが効く', async () => {
			fixture(rows);
			const res = (await toolDef.handler({ pair: 'btc_jpy', limit: 10, maxAmount: 1.0 })) as {
				ok: true;
				data: { normalized: Array<{ amount: number }> };
			};
			expect(res.data.normalized.map((t) => t.amount)).toEqual([0.05, 0.5, 1.0]);
		});

		it('minPrice + maxPrice の同時指定で範囲フィルタが効く', async () => {
			fixture(rows);
			const res = (await toolDef.handler({ pair: 'btc_jpy', limit: 10, minPrice: 5_000_000, maxPrice: 6_000_000 })) as {
				ok: true;
				data: { normalized: Array<{ price: number }> };
			};
			expect(res.data.normalized.map((t) => t.price)).toEqual([5_000_000, 6_000_000]);
		});

		it('フィルタ未指定なら全件を維持し summary もそのまま', async () => {
			fixture(rows);
			const res = (await toolDef.handler({ pair: 'btc_jpy', limit: 10 })) as {
				ok: true;
				data: { normalized: unknown[] };
				summary: string;
			};
			expect(res.data.normalized).toHaveLength(4);
			expect(res.summary).toContain('直近取引');
		});

		it('フィルタ指定時は summary が件数表示に差し替わる', async () => {
			fixture(rows);
			const res = (await toolDef.handler({ pair: 'btc_jpy', limit: 10, minAmount: 1.5 })) as {
				ok: true;
				summary: string;
			};
			expect(res.summary).toContain('フィルタ後 1件');
		});

		it('フィルタ指定時も summary にヒットした個別約定行を含める（件数だけにしない）', async () => {
			fixture(rows);
			const res = (await toolDef.handler({ pair: 'btc_jpy', limit: 10, minAmount: 1.0 })) as {
				ok: true;
				summary: string;
			};
			// ヒットした約定（id:3 / id:4）の個別行が content 可視テキストに出る
			expect(res.summary).toContain('📋 フィルタ後 2件の取引:');
			expect(res.summary).toContain('id:3');
			expect(res.summary).toContain('id:4');
			expect(res.summary).toContain('6000000');
			expect(res.summary).toContain('7000000');
			// フィルタ対象外（id:1 / id:2）は summary に漏れない
			expect(res.summary).not.toContain('id:1');
			expect(res.summary).not.toContain('id:2');
		});

		it('フィルタが0件ヒットなら個別行ブロックを出さず件数のみ（フッターは維持）', async () => {
			fixture(rows);
			const res = (await toolDef.handler({ pair: 'btc_jpy', limit: 10, minAmount: 100 })) as {
				ok: true;
				summary: string;
			};
			expect(res.summary).toContain('フィルタ後 0件');
			expect(res.summary).not.toContain('📋 フィルタ後');
			expect(res.summary).toContain('補完ツール');
		});

		it('view=items の場合は content text が JSON 配列', async () => {
			fixture(rows);
			const res = (await toolDef.handler({ pair: 'btc_jpy', limit: 10, view: 'items' })) as {
				content: Array<{ type: string; text: string }>;
			};
			const parsed = JSON.parse(res.content[0].text);
			expect(Array.isArray(parsed)).toBe(true);
			expect(parsed).toHaveLength(4);
		});

		it('view=items でも drop 警告は content に伝搬する（content[0] は JSON 配列を維持し warning は content[1]）', async () => {
			const malformed: Array<Record<string, unknown>> = [
				{ transaction_id: 1, price: '4000000', amount: '0.05', side: 'buy', executed_at: '1700000000000' },
				{ transaction_id: 2, price: '5000000', amount: '0.5', side: 'sell', executed_at: '1700000001000' },
				{ transaction_id: 3, amount: '0.7', side: 'buy', executed_at: '1700000002000' },
				{ transaction_id: 4, price: '6000000', amount: '1.0', side: 'buy', executed_at: '1700000003000' },
			];
			globalThis.fetch = mockFetchOk({ success: 1, data: { transactions: malformed } });

			const res = (await toolDef.handler({ pair: 'btc_jpy', limit: 10, view: 'items' })) as {
				content: Array<{ type: string; text: string }>;
			};
			const parsed = JSON.parse(res.content[0].text);
			expect(Array.isArray(parsed)).toBe(true);
			expect(parsed).toHaveLength(3);
			expect(res.content).toHaveLength(2);
			expect(res.content[1].text).toContain('1件');
		});

		it('view=items で drop が無ければ content は 1 要素のまま', async () => {
			fixture(rows);
			const res = (await toolDef.handler({ pair: 'btc_jpy', limit: 10, view: 'items' })) as {
				content: Array<{ type: string; text: string }>;
			};
			expect(res.content).toHaveLength(1);
		});

		it('handler 経由でも transaction_id が保持される', async () => {
			fixture(rows);
			const res = (await toolDef.handler({ pair: 'btc_jpy', limit: 10 })) as {
				ok: true;
				data: { normalized: Array<{ transaction_id?: number }> };
			};
			expect(res.data.normalized.map((t) => t.transaction_id)).toEqual([1, 2, 3, 4]);
		});

		it('フィルタ適用時も上流の drop 警告を summary / meta.warning に伝搬する', async () => {
			const malformed: Array<Record<string, unknown>> = [
				{ transaction_id: 1, price: '4000000', amount: '0.05', side: 'buy', executed_at: '1700000000000' },
				{ transaction_id: 2, price: '5000000', amount: '0.5', side: 'sell', executed_at: '1700000001000' },
				{ transaction_id: 3, amount: '0.7', side: 'buy', executed_at: '1700000002000' },
				{ transaction_id: 4, price: '6000000', amount: '1.0', side: 'buy', executed_at: '1700000003000' },
			];
			globalThis.fetch = mockFetchOk({ success: 1, data: { transactions: malformed } });

			const res = (await toolDef.handler({ pair: 'btc_jpy', limit: 10, minAmount: 0.5 })) as {
				ok: true;
				data: { normalized: Array<{ amount: number }> };
				summary: string;
				meta: { warning?: string };
			};
			expect(res.data.normalized.map((t) => t.amount)).toEqual([0.5, 1.0]);
			expect(typeof res.meta.warning).toBe('string');
			expect(res.meta.warning).toContain('1件');
			expect(res.summary).toContain('フィルタ後');
			expect(res.summary).toContain(res.meta.warning as string);
		});
	});
});

// ── UTC 暦日アーカイブ制約のエラーヒント ──
// /transactions/{YYYYMMDD} は UTC 暦日アーカイブで、当該 UTC 日完了後に公開される（bitbank 側仕様）。
// 進行中・未来の UTC 日の 404 には「なぜ 404 か」のヒントを付与する。

describe('get_transactions: 未公開アーカイブ 404 のヒント', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	const mock404 = () =>
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: false,
			status: 404,
			statusText: 'Not Found',
			headers: { get: () => null },
			json: async () => ({ success: 0, data: { code: 10000 } }),
		} as unknown as Response);

	it('進行中の UTC 日（JST 早朝の「JST 昨日」）の 404 にはアーカイブ未公開ヒントが付く', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.UTC(2026, 6, 7, 23, 31, 0)); // 進行中 UTC 日 = 20260707
		mock404();

		const res = await getTransactions('btc_jpy', 60, '20260707');
		expect(res.ok).toBe(false);
		expect(res.summary).toContain('UTC ではまだ完了していない');
		expect(res.summary).toContain('20260707');
	});

	it('完了済み UTC 日の 404 にはヒントを付けない（実失敗として扱う）', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.UTC(2026, 6, 7, 23, 31, 0));
		mock404();

		const res = await getTransactions('btc_jpy', 60, '20260701');
		expect(res.ok).toBe(false);
		expect(res.summary).not.toContain('UTC ではまだ完了していない');
		expect(res.summary).toContain('404');
	});
});
