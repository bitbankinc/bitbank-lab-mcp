/**
 * portfolio/fetch のページネーションロジックのユニットテスト。
 *
 * 検証対象:
 *   - ページ境界の同一タイムスタンプレコードの取りこぼし防止（trade_id / uuid 重複排除）
 *   - 進捗ゼロ検出による無限ループ防止
 *   - 通常ケース（境界重複なし）のリグレッション防止
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../../lib/datetime.js';
import { fail, ok } from '../../../lib/result.js';
import { paginateMarginTrades, paginateTrades } from '../../../src/handlers/portfolio/fetch.js';
import type { FlowValuationTarget } from '../../../src/handlers/portfolio/types.js';
import type { GetCandlesData, GetCandlesMeta } from '../../../src/schemas.js';
import getCandles from '../../../tools/get_candles.js';

vi.mock('../../../tools/get_candles.js', () => ({
	default: vi.fn(),
}));

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

// ── get_candles モックの共通ビルダ ──
//
// `getCandles` の戻り値は `OkResult<GetCandlesData, GetCandlesMeta> | FailResult`。
// モックを手書きすると `data.raw` / `meta.fetchedAt` / `meta.errorType` が欠けた
// 「実装が絶対に返さない形」で被テストコードを叩くことになり、`fetchFlowDatePrices` の
// `isTransientFailure`（`res.meta.errorType` を読む）のような分岐が入った瞬間に
// 偽グリーンになる。ここでは本番と同じ `lib/result.ts` の `ok()` / `fail()` を通し、
// 形のズレを typecheck で検出できる状態に保つ。

/** `GetCandlesData['normalized']` の 1 要素（1day 足 1 本） */
type NormalizedCandle = GetCandlesData['normalized'][number];

/** get_candles の成功レスポンス。`raw` はテストで参照しないので null を入れる */
function candlesOk(normalized: NormalizedCandle[]) {
	return ok<GetCandlesData, GetCandlesMeta>(
		'ok',
		{ raw: null, normalized },
		{ pair: 'btc_jpy', fetchedAt: '2026-08-24T00:00:00.000Z', type: '1day', count: normalized.length },
	);
}

/**
 * get_candles の失敗レスポンス。
 *
 * `errorType` の既定は `upstream`（HTTP エラー・レート制限）＝ **再実行で解消しうる失敗**で、
 * `fetchFlowDatePrices` はリトライし `chunkFetchFailed` に計上する。
 * `user`（その年に足が無い）はリトライも計上もされない別経路なので、明示的に渡す。
 */
function candlesFail(errorType = 'upstream') {
	return fail(`get_candles failed (${errorType})`, errorType);
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

describe('fetchCandlePriceData', () => {
	const mockedGetCandles = vi.mocked(getCandles);

	beforeEach(() => {
		mockedGetCandles.mockReset();
	});

	it('get_candles 経由で JST 暦日キーと期間境界価格を構築する', async () => {
		const nowJst = dayjs().tz('Asia/Tokyo');
		const day1Ms = nowJst.startOf('year').valueOf();
		const day2Ms = nowJst.startOf('year').add(1, 'day').valueOf();
		const yearStartMs = day1Ms;
		const monthStartMs = day1Ms;
		const dayStartMs = day1Ms;

		mockedGetCandles.mockResolvedValue(
			candlesOk([
				{ open: 1_000_000, high: 1_010_000, low: 990_000, close: 1_005_000, volume: 1, timestamp: day1Ms },
				{ open: 1_100_000, high: 1_110_000, low: 1_090_000, close: 1_105_000, volume: 1, timestamp: day2Ms },
			]),
		);

		const { fetchCandlePriceData } = await import('../../../src/handlers/portfolio/fetch.js');
		const result = await fetchCandlePriceData(['btc_jpy'], yearStartMs, monthStartMs, dayStartMs);

		// date は渡さない（getCandles の future-check が当日 anchor を未来として弾くため）。
		// getCandles 内部 default の todayYyyymmdd() + anchorActive=false に委ねる。
		expect(mockedGetCandles).toHaveBeenCalledWith('btc_jpy', '1day', undefined, 400, 'Asia/Tokyo');

		const boundary = result.boundaryPrices.get('btc');
		expect(boundary?.yearStart).toBe(1_000_000);
		expect(boundary?.monthStart).toBe(1_000_000);
		expect(boundary?.dayStart).toBe(1_000_000);

		const daily = result.dailyPrices.get('btc');
		expect(daily?.get(nowJst.startOf('year').startOf('day').valueOf())).toBe(1_000_000);
		expect(daily?.get(nowJst.startOf('year').add(1, 'day').startOf('day').valueOf())).toBe(1_100_000);
	});

	it('get_candles が失敗したペアはスキップする', async () => {
		const nowJst = dayjs().tz('Asia/Tokyo');
		mockedGetCandles.mockResolvedValue(candlesFail());

		const { fetchCandlePriceData } = await import('../../../src/handlers/portfolio/fetch.js');
		const result = await fetchCandlePriceData(
			['btc_jpy'],
			nowJst.startOf('year').valueOf(),
			nowJst.startOf('month').valueOf(),
			nowJst.startOf('day').valueOf(),
		);

		expect(result.boundaryPrices.size).toBe(0);
		expect(result.dailyPrices.size).toBe(0);
	});

	/**
	 * 日次価格マップのキーは JST 暦日の 0:00。当日損益の起点（getJstPeriodBoundaries の
	 * dayStartMs）と同じ暦日境界でなければ、資産推移の日次点がこのマップを引けず
	 * 全点が現在価格フォールバックに落ちる（src/handlers/portfolio/calendar.ts 参照）。
	 */
	it('JST 0:00 前後の足を JST 暦日キーに正規化する（UTC 暦日ではない）', async () => {
		/** JST の壁時計時刻を epoch ms に変換する（JST は DST を持たないので UTC+9 固定）。 */
		const jstMs = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0) =>
			Date.UTC(y, m - 1, d, h - 9, min, s, ms);

		const aug1 = jstMs(2026, 8, 1);
		const aug2 = jstMs(2026, 8, 2);

		mockedGetCandles.mockResolvedValue(
			candlesOk([
				// JST 8/1 23:59:59.999（= 2026-08-01T14:59:59.999Z）→ 8/1 のキー
				{ open: 1_000_000, high: 1, low: 1, close: 1, volume: 1, timestamp: aug2 - 1 },
				// JST 8/2 09:00（= 2026-08-02T00:00:00Z）→ UTC 暦日で丸めると別キーになる足
				{ open: 3_000_000, high: 1, low: 1, close: 1, volume: 1, timestamp: jstMs(2026, 8, 2, 9) },
			]),
		);

		const { fetchCandlePriceData } = await import('../../../src/handlers/portfolio/fetch.js');
		// 当日 = JST 8/2。dayStart 価格は 8/2 00:00 以降の最初の足＝ JST 09:00 の足になる。
		const result = await fetchCandlePriceData(['btc_jpy'], aug1, aug1, aug2);

		const daily = result.dailyPrices.get('btc');
		expect([...(daily?.keys() ?? [])]).toEqual([aug1, aug2]);
		expect(daily?.get(aug1)).toBe(1_000_000);
		expect(daily?.get(aug2)).toBe(3_000_000);

		// 起点ちょうど（JST 8/2 00:00）より前の足は当日の始値に選ばれない
		expect(result.boundaryPrices.get('btc')?.dayStart).toBe(3_000_000);
	});
});

/**
 * `fetchFlowDatePrices` — 入出庫日価格を解決するための年単位 chunk の追加取得（#57 (a)-2）。
 *
 * 直近 400 日窓（`fetchCandlePriceData`）で解ける入出庫は追加取得しない、
 * 解けない分だけ (資産, 年) 単位で取りに行く、それでも取れなければ何もしない（現在価格
 * フォールバックは呼び出し側 `resolveFlowPrice` の担当）——の 3 経路を固定する。
 *
 * 加えて #76 の回帰: 入庫（取得原価に算入される）と出庫（表示専用）は chunk 予算を共有しない。
 * 共有していた頃は出庫が増えるだけで入庫が押し出され、取得原価と実現損益が実行ごとに変わった。
 */
describe('fetchFlowDatePrices', () => {
	const mockedGetCandles = vi.mocked(getCandles);

	/** JST の壁時計時刻を epoch ms に変換する（JST は DST を持たないので UTC+9 固定）。 */
	const jstMs = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h - 9);

	/** 入庫の価格解決対象 1 件 */
	const deposit = (asset: string, atMs: number): FlowValuationTarget => ({ asset, atMs, kind: 'deposit' });
	/** 出庫の価格解決対象 1 件 */
	const withdrawal = (asset: string, atMs: number): FlowValuationTarget => ({ asset, atMs, kind: 'withdrawal' });

	/** 実際に叩いた (pair, year) の組を昇順で返す */
	const requestedChunks = () => mockedGetCandles.mock.calls.map((c) => `${c[0]}:${c[2]}`).sort();

	/** 取りこぼしゼロの申告（資産別内訳も空）。`toEqual` で完全一致を見るため毎回新しい Map を返す */
	const noShortfall = () => ({ deposits: 0, withdrawals: 0, depositsByAsset: new Map() });

	/** 指定 JST 暦日の 1day 足 1 本だけを返す get_candles レスポンス */
	function candleAt(dayMs: number, open: number) {
		return candlesOk([{ open, high: open, low: open, close: open, volume: 1, timestamp: dayMs }]);
	}

	beforeEach(() => {
		mockedGetCandles.mockReset();
	});

	it('直近窓で解決できる入出庫は追加取得しない', async () => {
		const dayMs = jstMs(2026, 8, 1);
		const base = new Map([['btc', new Map([[dayMs, 1_000_000]])]]);

		const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
		const result = await fetchFlowDatePrices(base, [deposit('btc', jstMs(2026, 8, 1, 12))]);

		expect(mockedGetCandles).not.toHaveBeenCalled();
		// 追加取得が無ければ入力の Map をそのまま返す（無駄なコピーを作らない）
		expect(result.dailyPrices).toBe(base);
		expect(result.truncatedByChunkLimit).toEqual(noShortfall());
		expect(result.chunkFetchFailed).toEqual(noShortfall());
	});

	it('直近窓の外にある入出庫は (資産, 年) 単位で年 chunk を追加取得する', async () => {
		const oldDayMs = jstMs(2023, 4, 20);
		mockedGetCandles.mockResolvedValue(candleAt(oldDayMs, 4_000_000));

		const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
		const result = await fetchFlowDatePrices(new Map(), [
			deposit('btc', jstMs(2023, 4, 20, 12)),
			// 同じ (資産, 年) は何件あっても chunk は 1 つ
			deposit('btc', jstMs(2023, 9, 1, 12)),
		]);

		expect(mockedGetCandles).toHaveBeenCalledTimes(1);
		expect(mockedGetCandles).toHaveBeenCalledWith('btc_jpy', '1day', '2023', 400, 'Asia/Tokyo');
		expect(result.dailyPrices.get('btc')?.get(oldDayMs)).toBe(4_000_000);
	});

	it('資産・年が異なれば別 chunk として取得する', async () => {
		mockedGetCandles.mockResolvedValue(candleAt(jstMs(2023, 4, 20), 4_000_000));

		const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
		await fetchFlowDatePrices(new Map(), [
			deposit('btc', jstMs(2023, 4, 20, 12)),
			deposit('eth', jstMs(2023, 4, 20, 12)),
			deposit('btc', jstMs(2024, 4, 20, 12)),
		]);

		expect(requestedChunks()).toEqual(['btc_jpy:2023', 'btc_jpy:2024', 'eth_jpy:2023']);
	});

	it('JPY・非有限タイムスタンプは追加取得の対象外', async () => {
		const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
		const result = await fetchFlowDatePrices(new Map(), [
			deposit('jpy', jstMs(2023, 4, 20, 12)),
			deposit('btc', Number.NaN),
		]);

		expect(mockedGetCandles).not.toHaveBeenCalled();
		expect(result.dailyPrices.size).toBe(0);
	});

	it('リトライを使い切っても取得できない (資産, 年) は日次価格に載らない（呼び出し側が現在価格に落とす）', async () => {
		mockedGetCandles.mockResolvedValue(candlesFail());

		const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
		const result = await fetchFlowDatePrices(new Map(), [deposit('btc', jstMs(2023, 4, 20, 12))]);

		// 初回 + リトライ 2 回。使い切ってはじめて諦める（#81）
		expect(mockedGetCandles).toHaveBeenCalledTimes(3);
		expect(result.dailyPrices.get('btc')?.size ?? 0).toBe(0);
	});

	it('get_candles が throw しても他の chunk の結果は残る', async () => {
		const okDayMs = jstMs(2024, 4, 20);
		mockedGetCandles.mockImplementation(async (pair: string) => {
			if (pair === 'eth_jpy') throw new Error('boom');
			return candleAt(okDayMs, 5_000_000);
		});

		const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
		const result = await fetchFlowDatePrices(new Map(), [
			deposit('eth', jstMs(2024, 4, 20, 12)),
			deposit('btc', jstMs(2024, 4, 20, 12)),
		]);

		expect(result.dailyPrices.get('btc')?.get(okDayMs)).toBe(5_000_000);
		expect(result.dailyPrices.get('eth')).toBeUndefined();
	});

	it('入力の Map を破壊しない（資産推移シリーズの品質判定を巻き込まない）', async () => {
		const recentDayMs = jstMs(2026, 8, 1);
		const base = new Map([['btc', new Map([[recentDayMs, 1_000_000]])]]);
		mockedGetCandles.mockResolvedValue(candleAt(jstMs(2023, 4, 20), 4_000_000));

		const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
		const result = await fetchFlowDatePrices(base, [deposit('btc', jstMs(2023, 4, 20, 12))]);

		// 追加取得分は戻り値にのみ入り、入力の直近 400 日窓はそのまま
		expect(result.dailyPrices.get('btc')?.get(jstMs(2023, 4, 20))).toBe(4_000_000);
		expect(base.get('btc')?.size).toBe(1);
		expect(base.get('btc')?.has(jstMs(2023, 4, 20))).toBe(false);
		// 直近窓の値は上書きされない
		expect(result.dailyPrices.get('btc')?.get(recentDayMs)).toBe(1_000_000);
	});

	it('出庫の chunk 数の上限を超えた分は取得しない（新しい年から優先する）', async () => {
		mockedGetCandles.mockResolvedValue(candleAt(jstMs(2020, 1, 2), 1_000_000));

		const { fetchFlowDatePrices, MAX_WITHDRAWAL_FLOW_PRICE_YEAR_CHUNKS } = await import(
			'../../../src/handlers/portfolio/fetch.js'
		);
		// 上限 +2 年ぶんの出庫を古い年から並べる
		const years = Array.from({ length: MAX_WITHDRAWAL_FLOW_PRICE_YEAR_CHUNKS + 2 }, (_, i) => 2005 + i);
		const result = await fetchFlowDatePrices(
			new Map(),
			years.map((y) => withdrawal('btc', jstMs(y, 6, 1, 12))),
		);

		expect(mockedGetCandles).toHaveBeenCalledTimes(MAX_WITHDRAWAL_FLOW_PRICE_YEAR_CHUNKS);
		const requestedYears = mockedGetCandles.mock.calls.map((c) => Number(c[2])).sort((a, b) => a - b);
		// 切り捨てられるのは最も古い 2 年（2005, 2006）
		expect(requestedYears).toEqual(years.slice(2));
		// 黙って消さず、上限起因であることを件数で申告する
		expect(result.truncatedByChunkLimit).toEqual({ deposits: 0, withdrawals: 2, depositsByAsset: new Map() });
		expect(result.chunkFetchFailed).toEqual(noShortfall());
	});

	/**
	 * #76 の回帰の核。入庫と出庫が同じ chunk 予算を奪い合っていた頃は、
	 * 出庫が増えるだけで入庫の年 chunk が押し出され、押し出された入庫は
	 * `deposit_date_price` で解けず `collectDepositCostEvents` が原価から丸ごと落とした。
	 * ＝ 売買が一切無くても実行タイミングで移動平均の取得原価と過去の実現損益が変わった。
	 */
	describe('入庫と出庫の chunk 予算の分離（#76）', () => {
		/** 出庫の上限をゆうに超える件数の出庫（すべて入庫と違う年・違う資産） */
		const manyWithdrawals = (count: number) =>
			Array.from({ length: count }, (_, i) => withdrawal(`w${String(i).padStart(3, '0')}`, jstMs(2024, 6, 1, 12)));

		beforeEach(() => {
			mockedGetCandles.mockResolvedValue(candleAt(jstMs(2015, 6, 1), 1_000_000));
		});

		it('出庫が 0 件でも 100 件でも入庫の取得 chunk が変わらない', async () => {
			const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
			const deposits = [
				deposit('btc', jstMs(2018, 6, 1, 12)),
				deposit('eth', jstMs(2019, 6, 1, 12)),
				deposit('xrp', jstMs(2020, 6, 1, 12)),
			];

			await fetchFlowDatePrices(new Map(), deposits);
			const withoutWithdrawals = requestedChunks().filter((c) => !c.startsWith('w'));

			mockedGetCandles.mockClear();
			await fetchFlowDatePrices(new Map(), [...deposits, ...manyWithdrawals(100)]);
			const withWithdrawals = requestedChunks().filter((c) => !c.startsWith('w'));

			expect(withWithdrawals).toEqual(withoutWithdrawals);
			expect(withoutWithdrawals).toEqual(['btc_jpy:2018', 'eth_jpy:2019', 'xrp_jpy:2020']);
		});

		it('入庫が 0 件でも 100 件でも入庫はすべて取得される（出庫の上限に縛られない）', async () => {
			const { fetchFlowDatePrices, MAX_WITHDRAWAL_FLOW_PRICE_YEAR_CHUNKS } = await import(
				'../../../src/handlers/portfolio/fetch.js'
			);
			// 出庫の上限をはるかに超える (資産, 年) の入庫
			const years = Array.from({ length: MAX_WITHDRAWAL_FLOW_PRICE_YEAR_CHUNKS + 8 }, (_, i) => 2010 + i);
			const result = await fetchFlowDatePrices(
				new Map(),
				years.map((y) => deposit('btc', jstMs(y, 6, 1, 12))),
			);

			expect(mockedGetCandles).toHaveBeenCalledTimes(years.length);
			expect(result.truncatedByChunkLimit.deposits).toBe(0);
		});

		it('入庫と出庫が同じ (資産, 年) を要求したら chunk は 1 つ（出庫が相乗りする）', async () => {
			const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
			await fetchFlowDatePrices(new Map(), [
				deposit('btc', jstMs(2018, 3, 1, 12)),
				withdrawal('btc', jstMs(2018, 9, 1, 12)),
			]);

			expect(requestedChunks()).toEqual(['btc_jpy:2018']);
		});

		it('入庫の上限で切られた組を出庫の残枠で拾い直さない（非決定性の再発防止）', async () => {
			const { fetchFlowDatePrices, MAX_DEPOSIT_FLOW_PRICE_YEAR_CHUNKS } = await import(
				'../../../src/handlers/portfolio/fetch.js'
			);
			// 入庫だけで上限 +1 組。最後の 1 組には出庫も同居させる
			const years = Array.from({ length: MAX_DEPOSIT_FLOW_PRICE_YEAR_CHUNKS + 1 }, (_, i) => 1960 + i);
			const overflowYear = years[years.length - 1] as number;
			const result = await fetchFlowDatePrices(new Map(), [
				...years.map((y) => deposit('btc', jstMs(y, 6, 1, 12))),
				withdrawal('btc', jstMs(overflowYear, 7, 1, 12)),
			]);

			expect(mockedGetCandles).toHaveBeenCalledTimes(MAX_DEPOSIT_FLOW_PRICE_YEAR_CHUNKS);
			// 出庫の枠は空いているが、入庫が諦めた組を取りに行くことはしない
			expect(requestedChunks()).not.toContain(`btc_jpy:${overflowYear}`);
			// 相乗りしていた出庫も一緒に落ちたことを申告する
			expect(result.truncatedByChunkLimit).toEqual({
				deposits: 1,
				withdrawals: 1,
				// 抑止は銘柄単位で判断するので、入庫の取りこぼしは資産別にも数える（#80）
				depositsByAsset: new Map([['btc', 1]]),
			});
		});

		it('入庫の上限は古い年から埋める（後から入庫が増えても過去の原価が書き換わらない）', async () => {
			const { fetchFlowDatePrices, MAX_DEPOSIT_FLOW_PRICE_YEAR_CHUNKS } = await import(
				'../../../src/handlers/portfolio/fetch.js'
			);
			const years = Array.from({ length: MAX_DEPOSIT_FLOW_PRICE_YEAR_CHUNKS }, (_, i) => 1960 + i);
			const settled = years.map((y) => deposit('btc', jstMs(y, 6, 1, 12)));

			await fetchFlowDatePrices(new Map(), settled);
			const before = requestedChunks();

			// 新しい年の入庫が 1 件増えて上限を超える
			mockedGetCandles.mockClear();
			const result = await fetchFlowDatePrices(new Map(), [...settled, deposit('btc', jstMs(2026, 6, 1, 12))]);

			// 押し出されるのは新しく増えた側で、既に解決できていた古い年は 1 つも動かない
			expect(requestedChunks()).toEqual(before);
			expect(requestedChunks()).not.toContain('btc_jpy:2026');
			expect(result.truncatedByChunkLimit.deposits).toBe(1);
		});
	});

	/**
	 * 「上限で取りに行かなかった」と「取りに行ったが取れなかった」は
	 * どちらも `current_price_fallback_count` に混ざるので、そこからは再実行で直るのか読めない（#76 仕様 2）。
	 */
	describe('取れなかった理由の申告', () => {
		it('取得失敗は truncated ではなく chunkFetchFailed に、入庫・出庫別で数える', async () => {
			mockedGetCandles.mockResolvedValue(candlesFail());

			const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
			const result = await fetchFlowDatePrices(new Map(), [
				// 同じ chunk を要求する 2 件は 2 件として数える（chunk 数ではなく入出庫の件数）
				deposit('btc', jstMs(2018, 3, 1, 12)),
				deposit('btc', jstMs(2018, 9, 1, 12)),
				withdrawal('eth', jstMs(2019, 3, 1, 12)),
			]);

			expect(result.chunkFetchFailed).toEqual({ deposits: 2, withdrawals: 1, depositsByAsset: new Map([['btc', 2]]) });
			expect(result.truncatedByChunkLimit).toEqual(noShortfall());
		});

		it('get_candles が throw した chunk も取得失敗として数える', async () => {
			mockedGetCandles.mockImplementation(async () => {
				throw new Error('boom');
			});

			const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
			const result = await fetchFlowDatePrices(new Map(), [deposit('btc', jstMs(2018, 3, 1, 12))]);

			expect(result.chunkFetchFailed.deposits).toBe(1);
		});

		it('空応答（normalized が空配列）も取得失敗として数える', async () => {
			mockedGetCandles.mockResolvedValue(candlesOk([]));

			const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
			const result = await fetchFlowDatePrices(new Map(), [deposit('btc', jstMs(2018, 3, 1, 12))]);

			expect(result.chunkFetchFailed.deposits).toBe(1);
		});

		/**
		 * `get_candles` はその (資産, 年) に足が無いとき `errorType='user'` で失敗する
		 * （`No candle data returned` / `before bitbank service start` / HTTP 404）。
		 * 再実行しても結果が変わらないので取得失敗に数えない——数えると #80 の抑止に載り、
		 * 恒久的に価格を解決できない入庫のせいで当該銘柄の原価が永久に出せなくなる。
		 */
		it('その年に足が無い失敗（errorType=user）は取得失敗に数えない', async () => {
			mockedGetCandles.mockResolvedValue(candlesFail('user'));

			const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
			const result = await fetchFlowDatePrices(new Map(), [deposit('btc', jstMs(2018, 3, 1, 12))]);

			expect(result.chunkFetchFailed).toEqual(noShortfall());
			expect(result.truncatedByChunkLimit).toEqual(noShortfall());
		});

		it('取得は成功したが当日の足が無い（上場前）は失敗にも切り落としにも数えない', async () => {
			// 2018 年の chunk は返るが、入庫日（3/1）の足は含まれない
			mockedGetCandles.mockResolvedValue(candleAt(jstMs(2018, 12, 1), 1_000_000));

			const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
			const result = await fetchFlowDatePrices(new Map(), [deposit('btc', jstMs(2018, 3, 1, 12))]);

			// 再実行しても変わらない恒久的な未解決なので、現在価格フォールバック件数だけで足りる
			expect(result.chunkFetchFailed).toEqual(noShortfall());
			expect(result.truncatedByChunkLimit).toEqual(noShortfall());
			expect(result.dailyPrices.get('btc')?.has(jstMs(2018, 3, 1))).toBe(false);
		});

		it('対象がゼロ件なら申告もゼロ（入庫ゼロ・出庫ゼロ・両方ゼロ）', async () => {
			const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
			const empty = await fetchFlowDatePrices(new Map(), []);

			expect(mockedGetCandles).not.toHaveBeenCalled();
			expect(empty.truncatedByChunkLimit).toEqual(noShortfall());
			expect(empty.chunkFetchFailed).toEqual(noShortfall());
		});
	});

	/**
	 * 年 chunk 取得の一過性の失敗をリトライで吸収する（#81）。
	 *
	 * リトライが無かった頃は、同じ口座を同じ日に叩いても解決できた入庫の件数が実行ごとに変わり
	 * （実測で 3 件 → 1 件）、`collectDepositCostEvents` が原価に算入する入庫が変わって
	 * 移動平均の取得原価——ひいては**過去の売却の実現損益**まで動いた。
	 *
	 * 固定する不変条件は 2 つ:
	 *   - `chunkFetchFailed` に載るのはリトライを使い切った失敗だけ（＝一過性の失敗は載らない）
	 *   - 恒久的な失敗（`errorType='user'`）と成功では 1 回も余分に叩かない
	 */
	describe('年 chunk 取得のリトライ（#81）', () => {
		const oldDayMs = jstMs(2023, 4, 20);
		const oldDeposit = () => [deposit('btc', jstMs(2023, 4, 20, 12))];

		it('1 回失敗しても次で成功すれば入庫日価格が解決され、取得失敗に計上されない', async () => {
			mockedGetCandles.mockResolvedValueOnce(candlesFail()).mockResolvedValue(candleAt(oldDayMs, 4_000_000));

			const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
			const result = await fetchFlowDatePrices(new Map(), oldDeposit());

			expect(mockedGetCandles).toHaveBeenCalledTimes(2);
			expect(result.dailyPrices.get('btc')?.get(oldDayMs)).toBe(4_000_000);
			expect(result.chunkFetchFailed).toEqual(noShortfall());
		});

		it('throw もリトライの対象（次で成功すれば解決される）', async () => {
			let calls = 0;
			mockedGetCandles.mockImplementation(async () => {
				calls++;
				if (calls === 1) throw new Error('boom');
				return candleAt(oldDayMs, 4_000_000);
			});

			const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
			const result = await fetchFlowDatePrices(new Map(), oldDeposit());

			expect(calls).toBe(2);
			expect(result.dailyPrices.get('btc')?.get(oldDayMs)).toBe(4_000_000);
			expect(result.chunkFetchFailed).toEqual(noShortfall());
		});

		it('空応答（normalized が空配列）もリトライの対象', async () => {
			mockedGetCandles.mockResolvedValueOnce(candlesOk([])).mockResolvedValue(candleAt(oldDayMs, 4_000_000));

			const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
			const result = await fetchFlowDatePrices(new Map(), oldDeposit());

			expect(mockedGetCandles).toHaveBeenCalledTimes(2);
			expect(result.dailyPrices.get('btc')?.get(oldDayMs)).toBe(4_000_000);
			expect(result.chunkFetchFailed).toEqual(noShortfall());
		});

		it('初回で成功した chunk は 1 回しか叩かない（余分なリクエストを出さない）', async () => {
			mockedGetCandles.mockResolvedValue(candleAt(oldDayMs, 4_000_000));

			const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
			await fetchFlowDatePrices(new Map(), oldDeposit());

			expect(mockedGetCandles).toHaveBeenCalledTimes(1);
		});

		/**
		 * `errorType='user'` は「その年に足がそもそも無い」の表明で、何度叩いても同じ結果になる。
		 * ここをリトライすると上場前の入庫 1 件につき無駄なリクエストが 3 倍になり、
		 * レート制限を自分で誘発して**他の chunk の成功率を下げる**。
		 */
		it('その年に足が無い失敗（errorType=user）はリトライしない', async () => {
			mockedGetCandles.mockResolvedValue(candlesFail('user'));

			const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
			const result = await fetchFlowDatePrices(new Map(), [deposit('btc', jstMs(2018, 3, 1, 12))]);

			expect(mockedGetCandles).toHaveBeenCalledTimes(1);
			expect(result.chunkFetchFailed).toEqual(noShortfall());
		});

		it('リトライを使い切った失敗は従来どおり chunkFetchFailed に計上する（#80 の抑止経路を維持）', async () => {
			mockedGetCandles.mockResolvedValue(candlesFail());

			const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
			const result = await fetchFlowDatePrices(new Map(), oldDeposit());

			expect(mockedGetCandles).toHaveBeenCalledTimes(3);
			expect(result.chunkFetchFailed).toEqual({
				deposits: 1,
				withdrawals: 0,
				depositsByAsset: new Map([['btc', 1]]),
			});
		});

		it('throw もリトライを使い切れば chunkFetchFailed に計上する', async () => {
			mockedGetCandles.mockImplementation(async () => {
				throw new Error('boom');
			});

			const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
			const result = await fetchFlowDatePrices(new Map(), oldDeposit());

			expect(mockedGetCandles).toHaveBeenCalledTimes(3);
			expect(result.chunkFetchFailed.deposits).toBe(1);
		});

		it('1 つの chunk がリトライしても他の chunk の解決は妨げない', async () => {
			mockedGetCandles.mockImplementation(async (pair: string) => {
				if (pair === 'eth_jpy') return candlesFail();
				return candleAt(oldDayMs, 4_000_000);
			});

			const { fetchFlowDatePrices } = await import('../../../src/handlers/portfolio/fetch.js');
			const result = await fetchFlowDatePrices(new Map(), [
				deposit('eth', jstMs(2023, 4, 20, 12)),
				deposit('btc', jstMs(2023, 4, 20, 12)),
			]);

			expect(result.dailyPrices.get('btc')?.get(oldDayMs)).toBe(4_000_000);
			expect(result.chunkFetchFailed).toEqual({
				deposits: 1,
				withdrawals: 0,
				depositsByAsset: new Map([['eth', 1]]),
			});
		});
	});
});
