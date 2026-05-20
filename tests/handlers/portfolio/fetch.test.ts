/**
 * portfolio/fetch のページネーションロジックのユニットテスト。
 *
 * 検証対象:
 *   - ページ境界の同一タイムスタンプレコードの取りこぼし防止（trade_id / uuid 重複排除）
 *   - 進捗ゼロ検出による無限ループ防止
 *   - 通常ケース（境界重複なし）のリグレッション防止
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paginateMarginTrades, paginateTrades } from '../../../src/handlers/portfolio/fetch.js';
import { BitbankPrivateClient } from '../../../src/private/client.js';
import { mockBitbankError, mockBitbankSuccess } from '../../fixtures/private-api.js';

beforeEach(() => {
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
});

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.BITBANK_API_KEY;
	delete process.env.BITBANK_API_SECRET;
});

/** 順次レスポンスを返す fetcher（呼び出し回数と URL を記録する） */
function makeSequentialFetcher(responses: unknown[]) {
	const calls: string[] = [];
	let index = 0;
	const fetcher = async (url: string) => {
		calls.push(url);
		if (index >= responses.length) {
			throw new Error(`Unexpected fetch call #${index + 1}: ${url}`);
		}
		const body = responses[index++];
		return new Response(JSON.stringify(body), { status: 200 });
	};
	return { fetcher, calls };
}

function makeTrade(overrides: { trade_id: number; executed_at: number; pair?: string }) {
	return {
		trade_id: overrides.trade_id,
		pair: overrides.pair ?? 'btc_jpy',
		order_id: 5000 + overrides.trade_id,
		side: 'buy' as const,
		type: 'limit',
		amount: '0.01',
		price: '15000000',
		maker_taker: 'maker',
		fee_amount_base: '0.00001',
		fee_amount_quote: '0',
		executed_at: overrides.executed_at,
	};
}

function makeMarginTrade(overrides: { trade_id: number; executed_at: number; profit_loss?: string }) {
	return {
		trade_id: overrides.trade_id,
		pair: 'btc_jpy',
		order_id: 5000 + overrides.trade_id,
		side: 'sell' as const,
		position_side: 'long',
		type: 'limit',
		amount: '0.01',
		price: '15000000',
		maker_taker: 'maker',
		fee_amount_base: '0',
		fee_amount_quote: '0',
		profit_loss: overrides.profit_loss,
		executed_at: overrides.executed_at,
	};
}

function makeDeposit(overrides: { uuid: string; confirmed_at: number; asset?: string }) {
	return {
		uuid: overrides.uuid,
		asset: overrides.asset ?? 'jpy',
		amount: '1000',
		status: 'DONE',
		found_at: overrides.confirmed_at - 100,
		confirmed_at: overrides.confirmed_at,
	};
}

function makeWithdrawal(overrides: { uuid: string; requested_at: number; asset?: string }) {
	return {
		uuid: overrides.uuid,
		asset: overrides.asset ?? 'jpy',
		amount: '1000',
		fee: '550',
		status: 'DONE',
		requested_at: overrides.requested_at,
	};
}

describe('paginateTrades — ページネーション境界', () => {
	it('ページ境界に同一 executed_at のレコードが跨っていても全件取得できる', async () => {
		// バグ回帰防止: 旧実装は executed_at + 1 を次ページ since にしていたため、
		// ページ末尾と次ページ先頭に同じ executed_at が存在すると取りこぼしていた。
		// page1 末尾 3 件（id 998-1000）と page2 先頭 2 件（id 998, 1000）が同一 ts。
		// page2 には id 1001-1003 の新規レコードも同一 ts で存在し、旧実装ではスキップされていた。
		const tBoundary = 1710000999000;
		const page1 = Array.from({ length: 1000 }, (_, i) =>
			makeTrade({
				trade_id: i + 1,
				executed_at: i < 997 ? 1710000000000 + i * 1000 : tBoundary,
			}),
		);
		const page2 = [
			makeTrade({ trade_id: 998, executed_at: tBoundary }),
			makeTrade({ trade_id: 1000, executed_at: tBoundary }),
			makeTrade({ trade_id: 1001, executed_at: tBoundary }),
			makeTrade({ trade_id: 1002, executed_at: tBoundary }),
			makeTrade({ trade_id: 1003, executed_at: tBoundary + 1000 }),
		];

		const { fetcher, calls } = makeSequentialFetcher([
			mockBitbankSuccess({ trades: page1 }),
			mockBitbankSuccess({ trades: page2 }),
		]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateTrades(client);
		// 全 1003 件（page1 1000 + page2 新規 3）が取得され、重複 2 件は dedup される
		expect(result.trades).toHaveLength(1003);
		const ids = result.trades.map((t) => t.trade_id);
		expect(ids).toContain(1001);
		expect(ids).toContain(1002);
		expect(ids).toContain(1003);
		expect(new Set(ids).size).toBe(ids.length);

		// 2 回目の URL に since=tBoundary（+1 ではない）が含まれることを検証
		expect(calls.length).toBe(2);
		expect(calls[1]).toContain(`since=${tBoundary}`);
		expect(calls[1]).not.toContain(`since=${tBoundary + 1}`);
		expect(result.truncated).toBe(false);
	});

	it('連続ページで重複する trade_id は dedup される（次ページ先頭が前ページ末尾と一致）', async () => {
		const page1 = Array.from({ length: 1000 }, (_, i) =>
			makeTrade({ trade_id: i + 1, executed_at: 1710000000000 + i * 1000 }),
		);
		// page2 先頭 2 件を page1 末尾と意図的に重複させる
		const lastTwo = page1.slice(-2);
		const newRecords = Array.from({ length: 997 }, (_, i) =>
			makeTrade({ trade_id: 1001 + i, executed_at: 1710001000000 + i * 1000 }),
		);
		const page2 = [...lastTwo, ...newRecords];

		const { fetcher } = makeSequentialFetcher([
			mockBitbankSuccess({ trades: page1 }),
			mockBitbankSuccess({ trades: page2 }),
		]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateTrades(client);
		// 1000 (page1) + 997 (page2 新規) = 1997 件
		expect(result.trades).toHaveLength(1997);
		const ids = result.trades.map((t) => t.trade_id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(result.truncated).toBe(false);
	});

	it('全件同一 executed_at で進捗ゼロのとき truncated=true で打ち切る（無限ループ防止）', async () => {
		// 同一 ts が PAGE_SIZE 件以上連続するエッジケース。新実装は since=lastTs にしているため、
		// 次ページが同じ範囲を返し続けて進捗ゼロになると無限ループする可能性がある。
		// 進捗ゼロ検出により truncated=true で打ち切られることを検証。
		const sameTs = 1710000000000;
		const page1 = Array.from({ length: 1000 }, (_, i) => makeTrade({ trade_id: i + 1, executed_at: sameTs }));
		// 次ページ以降も全く同じレコードを返す（API が since=sameTs で同じ範囲を返却する想定）
		const { fetcher, calls } = makeSequentialFetcher([
			mockBitbankSuccess({ trades: page1 }),
			mockBitbankSuccess({ trades: page1 }),
		]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateTrades(client);
		expect(result.trades).toHaveLength(1000);
		expect(result.truncated).toBe(true);
		// MAX_PAGES (10) より早く打ち切られたことを確認（page1 + 1 回目の重複検出 = 2 回）
		expect(calls.length).toBeLessThan(10);
	});

	it('境界に重複がない通常ケース: ページネーションが従来どおり動作する（リグレッション防止）', async () => {
		const page1 = Array.from({ length: 1000 }, (_, i) =>
			makeTrade({ trade_id: i + 1, executed_at: 1710000000000 + i * 1000 }),
		);
		const page2 = Array.from({ length: 500 }, (_, i) =>
			makeTrade({ trade_id: 1001 + i, executed_at: 1710001000000 + i * 1000 }),
		);

		const { fetcher, calls } = makeSequentialFetcher([
			mockBitbankSuccess({ trades: page1 }),
			mockBitbankSuccess({ trades: page2 }),
		]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateTrades(client);
		expect(result.trades).toHaveLength(1500);
		expect(result.truncated).toBe(false);
		expect(calls.length).toBe(2);
	});

	it('空配列レスポンスで truncated=false を返す', async () => {
		const { fetcher } = makeSequentialFetcher([mockBitbankSuccess({ trades: [] })]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateTrades(client);
		expect(result.trades).toHaveLength(0);
		expect(result.truncated).toBe(false);
	});

	it('境界 dedup あり × MAX_PAGES 到達: all.length が PAGE_SIZE の倍数にならなくても truncated=true', async () => {
		// 各ページは満杯（1000 件）だが、ページ境界で 1 件ずつ trade_id が重複する。
		// 10 ページ全消費 → 1000 + 999*9 = 9991 件。9991 % 1000 !== 0 なので、
		// 旧実装は誤って truncated=false を返していた（バグ）。
		// 修正後は MAX_PAGES 到達で fall-through → truncated=true。
		const PAGE_SIZE = 1000;
		const MAX_PAGES = 10;
		const pages: ReturnType<typeof makeTrade>[][] = [];
		let nextId = 1;
		let prevLastId: number | null = null;
		let baseTs = 1710000000000;
		for (let p = 0; p < MAX_PAGES; p++) {
			const page: ReturnType<typeof makeTrade>[] = [];
			if (prevLastId != null) {
				page.push(makeTrade({ trade_id: prevLastId, executed_at: baseTs }));
				for (let i = 1; i < PAGE_SIZE; i++) {
					page.push(makeTrade({ trade_id: nextId++, executed_at: baseTs + i * 1000 }));
				}
			} else {
				for (let i = 0; i < PAGE_SIZE; i++) {
					page.push(makeTrade({ trade_id: nextId++, executed_at: baseTs + i * 1000 }));
				}
			}
			prevLastId = page[page.length - 1].trade_id;
			baseTs = page[page.length - 1].executed_at + 1000;
			pages.push(page);
		}

		const responses = pages.map((p) => mockBitbankSuccess({ trades: p }));
		const { fetcher, calls } = makeSequentialFetcher(responses);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateTrades(client);
		expect(result.trades).toHaveLength(9991);
		// 旧バグ条件: all.length % PAGE_SIZE === 0 で truncated を判定していた。
		// 9991 % 1000 = 991 のためズレるという前提を明示。
		expect(result.trades.length % PAGE_SIZE).not.toBe(0);
		expect(result.truncated).toBe(true);
		expect(calls.length).toBe(MAX_PAGES);
		const ids = result.trades.map((t) => t.trade_id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('API エラーで break するケース: truncated=true で返す', async () => {
		// page1 成功（満杯）→ page2 で HTTP 400 + auth エラー → tryGet が ok:false → break → fall-through。
		// auth エラー（20001）はクライアントが即座に PrivateApiError を投げる（リトライ無し）。
		const page1 = Array.from({ length: 1000 }, (_, i) =>
			makeTrade({ trade_id: i + 1, executed_at: 1710000000000 + i * 1000 }),
		);
		const responses: Response[] = [
			new Response(JSON.stringify(mockBitbankSuccess({ trades: page1 })), { status: 200 }),
			new Response(JSON.stringify(mockBitbankError(20001)), { status: 400 }),
		];
		let callIndex = 0;
		const fetcher = async (_url: string) => {
			if (callIndex >= responses.length) throw new Error('unexpected fetch call');
			return responses[callIndex++];
		};
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateTrades(client);
		expect(result.trades).toHaveLength(1000);
		expect(result.truncated).toBe(true);
		expect(callIndex).toBe(2);
	});

	it('lastTs 欠損で break するケース: truncated=true で返す', async () => {
		// 満杯バッチ（1000 件）だが最後のレコードの executed_at が undefined のとき、
		// !lastTs により break → fall-through → truncated=true。
		const head = Array.from({ length: 999 }, (_, i) =>
			makeTrade({ trade_id: i + 1, executed_at: 1710000000000 + i * 1000 }),
		);
		// 型上は executed_at: number だが、API レスポンスの欠損ケースを再現するため意図的に省略する
		const trailingTrade: Record<string, unknown> = {
			trade_id: 1000,
			pair: 'btc_jpy',
			order_id: 6000,
			side: 'buy',
			type: 'limit',
			amount: '0.01',
			price: '15000000',
			maker_taker: 'maker',
			fee_amount_base: '0.00001',
			fee_amount_quote: '0',
		};
		const fullPage = [...head, trailingTrade];

		const { fetcher, calls } = makeSequentialFetcher([mockBitbankSuccess({ trades: fullPage })]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateTrades(client);
		expect(result.trades).toHaveLength(1000);
		expect(result.truncated).toBe(true);
		expect(calls.length).toBe(1);
	});

	it('信用約定 (position_side 付き) が混入したレスポンスから現物のみが返る', async () => {
		// 公式 docs は position_side を「信用取引の時のみ」と明記しているが、API 挙動変更や
		// 信用約定の混入に備え、現物経路でも position_side == null で防御フィルタする。
		// paginateMarginTrades の position_side != null と対称化することで、calcPnl と
		// calcMarginPnl の二重計上を防ぐ。
		const mixed = [
			makeTrade({ trade_id: 1, executed_at: 1710000000000 }),
			// 信用約定（position_side='long'）。フィルタで除外されるべき
			{
				trade_id: 2,
				pair: 'btc_jpy',
				order_id: 5002,
				side: 'sell',
				position_side: 'long',
				type: 'limit',
				amount: '0.01',
				price: '15500000',
				maker_taker: 'maker',
				fee_amount_base: '0',
				fee_amount_quote: '0',
				profit_loss: '100',
				executed_at: 1710000001000,
			} as unknown as ReturnType<typeof makeTrade>,
			// ショート信用約定も除外されるべき
			{
				trade_id: 3,
				pair: 'btc_jpy',
				order_id: 5003,
				side: 'buy',
				position_side: 'short',
				type: 'limit',
				amount: '0.01',
				price: '15400000',
				maker_taker: 'maker',
				fee_amount_base: '0',
				fee_amount_quote: '0',
				profit_loss: '200',
				executed_at: 1710000002000,
			} as unknown as ReturnType<typeof makeTrade>,
			makeTrade({ trade_id: 4, executed_at: 1710000003000 }),
		];
		const { fetcher } = makeSequentialFetcher([mockBitbankSuccess({ trades: mixed })]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateTrades(client);
		expect(result.trades).toHaveLength(2);
		const ids = result.trades.map((t) => t.trade_id);
		expect(ids).toEqual([1, 4]);
		// 全レコードが position_side を持たないことを保証（calcPnl への流入を遮断）
		for (const t of result.trades) {
			expect(t.position_side).toBeUndefined();
		}
		expect(result.truncated).toBe(false);
	});

	it('全件信用約定 (position_side 付き) のレスポンスは空配列を返し truncated=false', async () => {
		// API が信用専用ページを返した極端なケース。現物経路の戻り値は空になる。
		const marginOnly = Array.from({ length: 5 }, (_, i) => ({
			trade_id: 100 + i,
			pair: 'btc_jpy',
			order_id: 6000 + i,
			side: 'sell' as const,
			position_side: 'long',
			type: 'limit',
			amount: '0.01',
			price: '15000000',
			maker_taker: 'maker',
			fee_amount_base: '0',
			fee_amount_quote: '0',
			executed_at: 1710000000000 + i * 1000,
		}));
		const { fetcher } = makeSequentialFetcher([mockBitbankSuccess({ trades: marginOnly })]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateTrades(client);
		expect(result.trades).toHaveLength(0);
		// batch.length (5) < TRADE_PAGE_SIZE (1000) で通常完了扱い
		expect(result.truncated).toBe(false);
	});

	it('満杯バッチが全て信用約定でも lastTs が前進していれば次ページを取得し現物約定を拾う', async () => {
		// 古い順 (asc) 取得で「初期は信用利用 → 途中から現物のみ」の口座を想定。
		// 1 ページ目が全て信用でも、後続ページに現物約定があれば取得できなければならない
		// （フィルタ後の件数のみで早期打ち切りすると取りこぼす）。
		const marginPage = Array.from({ length: 1000 }, (_, i) => ({
			trade_id: 200 + i,
			pair: 'btc_jpy',
			order_id: 7000 + i,
			side: 'sell' as const,
			position_side: 'long',
			type: 'limit',
			amount: '0.01',
			price: '15000000',
			maker_taker: 'maker',
			fee_amount_base: '0',
			fee_amount_quote: '0',
			executed_at: 1710000000000 + i * 1000,
		}));
		const spotPage = [
			makeTrade({ trade_id: 9001, executed_at: 1710001500000 }),
			makeTrade({ trade_id: 9002, executed_at: 1710001600000 }),
		];
		const { fetcher, calls } = makeSequentialFetcher([
			mockBitbankSuccess({ trades: marginPage }),
			mockBitbankSuccess({ trades: spotPage }),
		]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateTrades(client);
		expect(result.trades).toHaveLength(2);
		const ids = result.trades.map((t) => t.trade_id);
		expect(ids).toEqual([9001, 9002]);
		expect(result.truncated).toBe(false);
		// 2 ページ取得（早期打ち切りしていない）
		expect(calls.length).toBe(2);
		// 2 回目の URL に since=（page1 の lastTs）が含まれる
		const lastTsPage1 = 1710000000000 + 999 * 1000;
		expect(calls[1]).toContain(`since=${lastTsPage1}`);
	});
});

describe('paginateMarginTrades — ページネーション境界', () => {
	it('ページ境界に同一 executed_at の信用約定が跨っていても全件取得できる', async () => {
		const tBoundary = 1710000999000;
		const page1 = Array.from({ length: 1000 }, (_, i) =>
			makeMarginTrade({
				trade_id: i + 1,
				executed_at: i < 998 ? 1710000000000 + i * 1000 : tBoundary,
				profit_loss: '100',
			}),
		);
		const page2 = [
			makeMarginTrade({ trade_id: 999, executed_at: tBoundary, profit_loss: '100' }),
			makeMarginTrade({ trade_id: 1000, executed_at: tBoundary, profit_loss: '100' }),
			makeMarginTrade({ trade_id: 1001, executed_at: tBoundary, profit_loss: '200' }),
			makeMarginTrade({ trade_id: 1002, executed_at: tBoundary + 1000, profit_loss: '300' }),
		];

		const { fetcher, calls } = makeSequentialFetcher([
			mockBitbankSuccess({ trades: page1 }),
			mockBitbankSuccess({ trades: page2 }),
		]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateMarginTrades(client);
		// 1000 (page1) + 2 新規 (id 1001, 1002) = 1002 件
		expect(result.trades).toHaveLength(1002);
		const ids = result.trades.map((t) => t.trade_id);
		expect(ids).toContain(1001);
		expect(ids).toContain(1002);
		expect(new Set(ids).size).toBe(ids.length);
		expect(result.truncated).toBe(false);
		// 2 回目の URL に type=margin と since=tBoundary が含まれる
		expect(calls[1]).toContain('type=margin');
		expect(calls[1]).toContain(`since=${tBoundary}`);
	});

	it('全件同一 executed_at で進捗ゼロのとき truncated=true で打ち切る', async () => {
		const sameTs = 1710000000000;
		const page1 = Array.from({ length: 1000 }, (_, i) =>
			makeMarginTrade({ trade_id: i + 1, executed_at: sameTs, profit_loss: '100' }),
		);
		const { fetcher, calls } = makeSequentialFetcher([
			mockBitbankSuccess({ trades: page1 }),
			mockBitbankSuccess({ trades: page1 }),
		]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateMarginTrades(client);
		expect(result.trades).toHaveLength(1000);
		expect(result.truncated).toBe(true);
		expect(calls.length).toBeLessThan(10);
	});

	it('境界 dedup あり × MAX_PAGES 到達: all.length が PAGE_SIZE の倍数にならなくても truncated=true', async () => {
		const PAGE_SIZE = 1000;
		const MAX_PAGES = 10;
		const pages: ReturnType<typeof makeMarginTrade>[][] = [];
		let nextId = 1;
		let prevLastId: number | null = null;
		let baseTs = 1710000000000;
		for (let p = 0; p < MAX_PAGES; p++) {
			const page: ReturnType<typeof makeMarginTrade>[] = [];
			if (prevLastId != null) {
				page.push(makeMarginTrade({ trade_id: prevLastId, executed_at: baseTs, profit_loss: '100' }));
				for (let i = 1; i < PAGE_SIZE; i++) {
					page.push(makeMarginTrade({ trade_id: nextId++, executed_at: baseTs + i * 1000, profit_loss: '100' }));
				}
			} else {
				for (let i = 0; i < PAGE_SIZE; i++) {
					page.push(makeMarginTrade({ trade_id: nextId++, executed_at: baseTs + i * 1000, profit_loss: '100' }));
				}
			}
			prevLastId = page[page.length - 1].trade_id;
			baseTs = page[page.length - 1].executed_at + 1000;
			pages.push(page);
		}

		const responses = pages.map((p) => mockBitbankSuccess({ trades: p }));
		const { fetcher, calls } = makeSequentialFetcher(responses);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateMarginTrades(client);
		expect(result.trades).toHaveLength(9991);
		expect(result.trades.length % PAGE_SIZE).not.toBe(0);
		expect(result.truncated).toBe(true);
		expect(calls.length).toBe(MAX_PAGES);
	});

	it('API エラーで break するケース: truncated=true で返す', async () => {
		const page1 = Array.from({ length: 1000 }, (_, i) =>
			makeMarginTrade({ trade_id: i + 1, executed_at: 1710000000000 + i * 1000, profit_loss: '100' }),
		);
		const responses: Response[] = [
			new Response(JSON.stringify(mockBitbankSuccess({ trades: page1 })), { status: 200 }),
			new Response(JSON.stringify(mockBitbankError(20001)), { status: 400 }),
		];
		let callIndex = 0;
		const fetcher = async (_url: string) => {
			if (callIndex >= responses.length) throw new Error('unexpected fetch call');
			return responses[callIndex++];
		};
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateMarginTrades(client);
		expect(result.trades).toHaveLength(1000);
		expect(result.truncated).toBe(true);
		// API エラーで break したパスを区別するフラグ（PR #2: 不完全性伝播）
		expect(result.fetchFailed).toBe(true);
		expect(callIndex).toBe(2);
	});

	it('lastTs 欠損で break するケース: truncated=true で返す', async () => {
		const head = Array.from({ length: 999 }, (_, i) =>
			makeMarginTrade({ trade_id: i + 1, executed_at: 1710000000000 + i * 1000, profit_loss: '100' }),
		);
		const trailingTrade: Record<string, unknown> = {
			trade_id: 1000,
			pair: 'btc_jpy',
			order_id: 6000,
			side: 'sell',
			position_side: 'long',
			type: 'limit',
			amount: '0.01',
			price: '15000000',
			maker_taker: 'maker',
			fee_amount_base: '0',
			fee_amount_quote: '0',
			profit_loss: '100',
		};
		const fullPage = [...head, trailingTrade];

		const { fetcher, calls } = makeSequentialFetcher([mockBitbankSuccess({ trades: fullPage })]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateMarginTrades(client);
		expect(result.trades).toHaveLength(1000);
		expect(result.truncated).toBe(true);
		// lastTs 欠損は API エラーではないので fetchFailed=false
		expect(result.fetchFailed).toBe(false);
		expect(calls.length).toBe(1);
	});

	it('現物 (position_side 欠損) と信用が混在するレスポンスでも信用のみが返る', async () => {
		// 公式 docs に type=margin パラメータの記載がなく、API が無視した場合の防御。
		// position_side == null の現物約定が混入しても、フィルタで信用のみが残る。
		const mixed = [
			makeMarginTrade({ trade_id: 1, executed_at: 1710000000000, profit_loss: '100' }),
			// 現物約定（position_side なし）。フィルタで除外されるべき
			{
				trade_id: 2,
				pair: 'btc_jpy',
				order_id: 5002,
				side: 'buy',
				type: 'limit',
				amount: '0.01',
				price: '15000000',
				maker_taker: 'maker',
				fee_amount_base: '0.00001',
				fee_amount_quote: '0',
				executed_at: 1710000001000,
			} as unknown as ReturnType<typeof makeMarginTrade>,
			makeMarginTrade({ trade_id: 3, executed_at: 1710000002000, profit_loss: '200' }),
		];
		const { fetcher } = makeSequentialFetcher([mockBitbankSuccess({ trades: mixed })]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateMarginTrades(client);
		expect(result.trades).toHaveLength(2);
		const ids = result.trades.map((t) => t.trade_id);
		expect(ids).toEqual([1, 3]);
		// 全レコードに position_side が付いていることを保証
		for (const t of result.trades) {
			expect(t.position_side).toBeDefined();
		}
		expect(result.truncated).toBe(false);
	});

	it('全件現物約定（position_side なし）のレスポンスは空配列を返し truncated=false', async () => {
		const spotOnly = Array.from({ length: 5 }, (_, i) => ({
			trade_id: 100 + i,
			pair: 'btc_jpy',
			order_id: 6000 + i,
			side: 'buy' as const,
			type: 'limit',
			amount: '0.01',
			price: '15000000',
			maker_taker: 'maker',
			fee_amount_base: '0.00001',
			fee_amount_quote: '0',
			executed_at: 1710000000000 + i * 1000,
		}));
		const { fetcher } = makeSequentialFetcher([mockBitbankSuccess({ trades: spotOnly })]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateMarginTrades(client);
		expect(result.trades).toHaveLength(0);
		// batch.length (5) < TRADE_PAGE_SIZE (1000) で通常完了扱い
		expect(result.truncated).toBe(false);
	});

	it('満杯バッチが全て現物でも lastTs が前進していれば次ページを取得し信用約定を拾う', async () => {
		// 古い順 (asc) 取得で「初期は現物のみ → 途中から信用利用開始」の口座を想定。
		// 1 ページ目が全て現物でも、後続ページに信用約定があれば取得できなければならない
		// （marginOnly 件数のみで早期打ち切りすると取りこぼす）。
		const spotPage = Array.from({ length: 1000 }, (_, i) => ({
			trade_id: 200 + i,
			pair: 'btc_jpy',
			order_id: 7000 + i,
			side: 'buy' as const,
			type: 'limit',
			amount: '0.01',
			price: '15000000',
			maker_taker: 'maker',
			fee_amount_base: '0.00001',
			fee_amount_quote: '0',
			executed_at: 1710000000000 + i * 1000,
		}));
		const marginPage = [
			makeMarginTrade({ trade_id: 9001, executed_at: 1710001500000, profit_loss: '500' }),
			makeMarginTrade({ trade_id: 9002, executed_at: 1710001600000, profit_loss: '700' }),
		];
		const { fetcher, calls } = makeSequentialFetcher([
			mockBitbankSuccess({ trades: spotPage }),
			mockBitbankSuccess({ trades: marginPage }),
		]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateMarginTrades(client);
		expect(result.trades).toHaveLength(2);
		const ids = result.trades.map((t) => t.trade_id);
		expect(ids).toEqual([9001, 9002]);
		expect(result.truncated).toBe(false);
		// 2 ページ取得（早期打ち切りしていない）
		expect(calls.length).toBe(2);
		// 2 回目の URL に since=（page1 の lastTs）が含まれる
		const lastTsPage1 = 1710000000000 + 999 * 1000;
		expect(calls[1]).toContain(`since=${lastTsPage1}`);
	});

	it('満杯ページで lastTs が前回 since と同一のとき truncated=true で打ち切る（カーソル進捗ゼロ保険）', async () => {
		// 全件現物・全件同一 ts が連続するエッジケース。API が since=sameTs で同じ範囲を
		// 返し続けたとき、カーソルが進まないことを検出して無限ループを防ぐ。
		const sameTs = 1710000000000;
		const spotPageSameTs = Array.from({ length: 1000 }, (_, i) => ({
			trade_id: 300 + i,
			pair: 'btc_jpy',
			order_id: 8000 + i,
			side: 'buy' as const,
			type: 'limit',
			amount: '0.01',
			price: '15000000',
			maker_taker: 'maker',
			fee_amount_base: '0.00001',
			fee_amount_quote: '0',
			executed_at: sameTs,
		}));
		const { fetcher, calls } = makeSequentialFetcher([
			mockBitbankSuccess({ trades: spotPageSameTs }),
			mockBitbankSuccess({ trades: spotPageSameTs }),
		]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateMarginTrades(client);
		expect(result.trades).toHaveLength(0);
		expect(result.truncated).toBe(true);
		// MAX_PAGES (10) より早く打ち切られる（初回 since=undefined → page1、since=sameTs → page2 で即打ち切り）
		expect(calls.length).toBeLessThan(10);
	});
});

describe('paginateDeposits / paginateWithdrawals — ページネーション境界', () => {
	// paginateDeposits / paginateWithdrawals は非エクスポート関数だが、fetchDepositWithdrawal
	// 経由で間接的に検証する。
	// 入出金履歴 API の count 上限は公式 docs で 100 件と定義されているため、ページサイズは 100。
	it('入金: count パラメータが 100（公式上限）で送信される', async () => {
		const { fetchDepositWithdrawal } = await import('../../../src/handlers/portfolio/fetch.js');
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('deposit_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [] })), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
		}) as unknown as typeof fetch;
		const client = new BitbankPrivateClient({ fetcher });

		await fetchDepositWithdrawal(client);

		const fetchMock = fetcher as unknown as ReturnType<typeof vi.fn>;
		const depositCalls = fetchMock.mock.calls.map((c) => c[0] as string).filter((u) => u.includes('deposit_history'));
		expect(depositCalls.length).toBeGreaterThan(0);
		for (const url of depositCalls) {
			expect(url).toContain('count=100');
			expect(url).not.toContain('count=1000');
		}
	});

	it('出金: count パラメータが 100（公式上限）で送信される', async () => {
		const { fetchDepositWithdrawal } = await import('../../../src/handlers/portfolio/fetch.js');
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('withdrawal_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [] })), { status: 200 });
		}) as unknown as typeof fetch;
		const client = new BitbankPrivateClient({ fetcher });

		await fetchDepositWithdrawal(client);

		const fetchMock = fetcher as unknown as ReturnType<typeof vi.fn>;
		const withdrawalCalls = fetchMock.mock.calls
			.map((c) => c[0] as string)
			.filter((u) => u.includes('withdrawal_history'));
		expect(withdrawalCalls.length).toBeGreaterThan(0);
		for (const url of withdrawalCalls) {
			expect(url).toContain('count=100');
			expect(url).not.toContain('count=1000');
		}
	});

	it('入金: 100 件未満のレスポンス 1 ページで complete:true を返す', async () => {
		const { fetchDepositWithdrawal } = await import('../../../src/handlers/portfolio/fetch.js');
		// 5 件のみ（< 100）→ 1 ページで完了し、次ページを取得しない
		const oneShotPage = Array.from({ length: 5 }, (_, i) =>
			makeDeposit({ uuid: `dep-${i + 1}`, confirmed_at: 1710000000000 + i * 1000, asset: 'btc' }),
		);
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('asset=jpy')) {
				if (url.includes('deposit_history')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [] })), { status: 200 });
				}
				return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
			}
			if (url.includes('deposit_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ deposits: oneShotPage })), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
		}) as unknown as typeof fetch;
		const client = new BitbankPrivateClient({ fetcher });

		const result = await fetchDepositWithdrawal(client);
		if (!result) throw new Error('fetchDepositWithdrawal returned null');
		expect(result.deposits).toHaveLength(5);
		expect(result.isComplete).toBe(true);

		// crypto deposit は 1 回のみ呼ばれる（since 未指定）
		const fetchMock = fetcher as unknown as ReturnType<typeof vi.fn>;
		const cryptoDepositCalls = fetchMock.mock.calls
			.map((c) => c[0] as string)
			.filter((u) => u.includes('deposit_history') && !u.includes('asset=jpy'));
		expect(cryptoDepositCalls).toHaveLength(1);
		expect(cryptoDepositCalls[0]).not.toContain('since=');
	});

	it('出金: 100 件未満のレスポンス 1 ページで complete:true を返す', async () => {
		const { fetchDepositWithdrawal } = await import('../../../src/handlers/portfolio/fetch.js');
		const oneShotPage = Array.from({ length: 3 }, (_, i) =>
			makeWithdrawal({ uuid: `wd-${i + 1}`, requested_at: 1710000000000 + i * 1000, asset: 'btc' }),
		);
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('asset=jpy')) {
				if (url.includes('withdrawal_history')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
				}
				return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [] })), { status: 200 });
			}
			if (url.includes('withdrawal_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: oneShotPage })), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [] })), { status: 200 });
		}) as unknown as typeof fetch;
		const client = new BitbankPrivateClient({ fetcher });

		const result = await fetchDepositWithdrawal(client);
		if (!result) throw new Error('fetchDepositWithdrawal returned null');
		expect(result.withdrawals).toHaveLength(3);
		expect(result.isComplete).toBe(true);

		const fetchMock = fetcher as unknown as ReturnType<typeof vi.fn>;
		const cryptoWdCalls = fetchMock.mock.calls
			.map((c) => c[0] as string)
			.filter((u) => u.includes('withdrawal_history') && !u.includes('asset=jpy'));
		expect(cryptoWdCalls).toHaveLength(1);
		expect(cryptoWdCalls[0]).not.toContain('since=');
	});

	it('入金: 100 件（満杯）+ 残り 2 ページで境界 dedup 込みで complete:true を返す', async () => {
		const { fetchDepositWithdrawal } = await import('../../../src/handlers/portfolio/fetch.js');
		const tBoundary = 1710000999000;
		// crypto 入金: page1 100 件（うち末尾 3 件が同一 ts）+ page2 5 件（先頭 2 件重複 + 新規 3 件）
		const cryptoPage1 = Array.from({ length: 100 }, (_, i) =>
			makeDeposit({
				uuid: `dep-${i + 1}`,
				confirmed_at: i < 97 ? 1710000000000 + i * 1000 : tBoundary,
				asset: 'btc',
			}),
		);
		const cryptoPage2 = [
			makeDeposit({ uuid: 'dep-98', confirmed_at: tBoundary, asset: 'btc' }),
			makeDeposit({ uuid: 'dep-100', confirmed_at: tBoundary, asset: 'btc' }),
			makeDeposit({ uuid: 'dep-101', confirmed_at: tBoundary, asset: 'btc' }),
			makeDeposit({ uuid: 'dep-102', confirmed_at: tBoundary, asset: 'btc' }),
			makeDeposit({ uuid: 'dep-103', confirmed_at: tBoundary + 1000, asset: 'btc' }),
		];

		let cryptoPage = 0;
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('asset=jpy')) {
				if (url.includes('deposit_history')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [] })), { status: 200 });
				}
				return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
			}
			if (url.includes('deposit_history')) {
				const body = cryptoPage === 0 ? cryptoPage1 : cryptoPage2;
				cryptoPage++;
				return new Response(JSON.stringify(mockBitbankSuccess({ deposits: body })), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
		}) as unknown as typeof fetch;
		const client = new BitbankPrivateClient({ fetcher });

		const result = await fetchDepositWithdrawal(client);
		if (!result) throw new Error('fetchDepositWithdrawal returned null');
		// 100 (page1) + 3 新規 (page2) = 103 件、重複 2 件は dedup される
		expect(result.deposits).toHaveLength(103);
		const uuids = result.deposits.map((d) => d.uuid);
		expect(uuids).toContain('dep-101');
		expect(uuids).toContain('dep-102');
		expect(uuids).toContain('dep-103');
		expect(new Set(uuids).size).toBe(uuids.length);
		expect(result.isComplete).toBe(true);

		// crypto deposit の 2 回目呼び出しの URL に since=tBoundary（+1 ではない）が含まれる
		const fetchMock = fetcher as unknown as ReturnType<typeof vi.fn>;
		const cryptoDepositCalls = fetchMock.mock.calls
			.map((c) => c[0] as string)
			.filter((u) => u.includes('deposit_history') && !u.includes('asset=jpy'));
		expect(cryptoDepositCalls).toHaveLength(2);
		expect(cryptoDepositCalls[1]).toContain(`since=${tBoundary}`);
		expect(cryptoDepositCalls[1]).not.toContain(`since=${tBoundary + 1}`);
	});

	it('出金: 100 件（満杯）+ 残り 2 ページで境界 dedup 込みで complete:true を返す', async () => {
		const { fetchDepositWithdrawal } = await import('../../../src/handlers/portfolio/fetch.js');
		const tBoundary = 1710000999000;
		const cryptoWdPage1 = Array.from({ length: 100 }, (_, i) =>
			makeWithdrawal({
				uuid: `wd-${i + 1}`,
				requested_at: i < 98 ? 1710000000000 + i * 1000 : tBoundary,
				asset: 'btc',
			}),
		);
		const cryptoWdPage2 = [
			makeWithdrawal({ uuid: 'wd-99', requested_at: tBoundary, asset: 'btc' }),
			makeWithdrawal({ uuid: 'wd-100', requested_at: tBoundary, asset: 'btc' }),
			makeWithdrawal({ uuid: 'wd-101', requested_at: tBoundary, asset: 'btc' }),
			makeWithdrawal({ uuid: 'wd-102', requested_at: tBoundary + 1000, asset: 'btc' }),
		];

		let cryptoPage = 0;
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('asset=jpy')) {
				if (url.includes('withdrawal_history')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
				}
				return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [] })), { status: 200 });
			}
			if (url.includes('withdrawal_history')) {
				const body = cryptoPage === 0 ? cryptoWdPage1 : cryptoWdPage2;
				cryptoPage++;
				return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: body })), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [] })), { status: 200 });
		}) as unknown as typeof fetch;
		const client = new BitbankPrivateClient({ fetcher });

		const result = await fetchDepositWithdrawal(client);
		if (!result) throw new Error('fetchDepositWithdrawal returned null');
		// 100 (page1) + 2 新規 (wd-101, wd-102) = 102 件
		expect(result.withdrawals).toHaveLength(102);
		const uuids = result.withdrawals.map((w) => w.uuid);
		expect(uuids).toContain('wd-101');
		expect(uuids).toContain('wd-102');
		expect(new Set(uuids).size).toBe(uuids.length);
		expect(result.isComplete).toBe(true);

		const fetchMock = fetcher as unknown as ReturnType<typeof vi.fn>;
		const cryptoWdCalls = fetchMock.mock.calls
			.map((c) => c[0] as string)
			.filter((u) => u.includes('withdrawal_history') && !u.includes('asset=jpy'));
		expect(cryptoWdCalls).toHaveLength(2);
		expect(cryptoWdCalls[1]).toContain(`since=${tBoundary}`);
		expect(cryptoWdCalls[1]).not.toContain(`since=${tBoundary + 1}`);
	});

	it('JPY/crypto 間で同一 uuid の入金は重複排除される（fetchDepositWithdrawal レベルの dedup を維持）', async () => {
		// fetchDepositWithdrawal は JPY と crypto を別チャネルで取得して結合するため、
		// 万一同一 uuid が両方に現れる場合の dedup が必要（既存仕様の維持を検証）。
		const { fetchDepositWithdrawal } = await import('../../../src/handlers/portfolio/fetch.js');
		const sharedDeposit = makeDeposit({ uuid: 'dup-1', confirmed_at: 1710000000000, asset: 'jpy' });

		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('deposit_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [sharedDeposit] })), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
		}) as unknown as typeof fetch;
		const client = new BitbankPrivateClient({ fetcher });

		const result = await fetchDepositWithdrawal(client);
		if (!result) throw new Error('fetchDepositWithdrawal returned null');
		// crypto / jpy 両チャネルで同じ uuid が返っても 1 件に集約される
		expect(result.deposits).toHaveLength(1);
		expect(result.deposits[0].uuid).toBe('dup-1');
	});
});
