/**
 * get_margin_positions ツールのユニットテスト。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFail, assertOk } from '../_assertResult.js';
import { mockBitbankError, mockBitbankSuccess, rawMarginPositionsResponse } from '../fixtures/private-api.js';

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

function setupFetchMock(response: unknown, status = 200) {
	globalThis.fetch = vi
		.fn()
		.mockResolvedValue(new Response(JSON.stringify(response), { status })) as unknown as typeof fetch;
}

describe('get_margin_positions', () => {
	it('建玉一覧を返す', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginPositionsResponse));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({});

		assertOk(result);
		expect(result.data.positions).toHaveLength(2);
		expect(result.data.positions[0].pair).toBe('btc_jpy');
		expect(result.data.positions[0].position_side).toBe('long');
		expect(result.data.positions[1].position_side).toBe('short');
		expect(result.meta.positionCount).toBe(2);
	});

	it('ロング/ショートの集計をサマリーに含む', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginPositionsResponse));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({});

		assertOk(result);
		expect(result.summary).toContain('ロング 1件');
		expect(result.summary).toContain('ショート 1件');
	});

	it('建玉ゼロの場合のメッセージを返す', async () => {
		const empty = { ...rawMarginPositionsResponse, positions: [] };
		setupFetchMock(mockBitbankSuccess(empty));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({});

		assertOk(result);
		expect(result.data.positions).toHaveLength(0);
		expect(result.summary).toContain('建玉はありません');
	});

	it('pair 指定でフィルタされる', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginPositionsResponse));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({ pair: 'btc_jpy' });

		assertOk(result);
		expect(result.data.positions).toHaveLength(1);
		expect(result.data.positions[0].pair).toBe('btc_jpy');
		expect(result.meta.pair).toBe('btc_jpy');
	});

	it('pair 指定なしで「全ペア」ラベルが表示される', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginPositionsResponse));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({});

		assertOk(result);
		expect(result.summary).toContain('全ペア');
	});

	it('追証発生時に ⚠ アラートを summary 先頭に表示する', async () => {
		const withNotice = {
			...rawMarginPositionsResponse,
			notice: {
				what: '追証',
				occurred_at: 1710000000000,
				amount: '100000',
				due_date_at: 1710200000000,
			},
		};
		setupFetchMock(mockBitbankSuccess(withNotice));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({});

		assertOk(result);
		expect(result.meta.hasNotice).toBe(true);
		const firstLine = result.summary.split('\n')[0];
		expect(firstLine.startsWith('⚠')).toBe(true);
		expect(firstLine).toContain('追証');
		expect(firstLine).toContain('100,000');
	});

	it('不足金がある場合に ⚠ アラートを summary 先頭に表示する', async () => {
		const withPayables = {
			...rawMarginPositionsResponse,
			payables: { amount: '50000' },
		};
		setupFetchMock(mockBitbankSuccess(withPayables));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({});

		assertOk(result);
		const firstLine = result.summary.split('\n')[0];
		expect(firstLine.startsWith('⚠')).toBe(true);
		expect(firstLine).toContain('不足金');
		expect(firstLine).toContain('50,000');
	});

	it('losscut_threshold を返す', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginPositionsResponse));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({});

		assertOk(result);
		expect(result.data.losscut_threshold.individual).toBe('110');
		expect(result.data.losscut_threshold.company).toBe('120');
	});

	it('PrivateApiError で fail を返す', async () => {
		setupFetchMock(mockBitbankError(20001), 400);

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({});

		assertFail(result);
		expect(result.meta.errorType).toBe('authentication_error');
	});

	it('非 PrivateApiError の例外で upstream_error を返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({});

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');
		expect(result.summary).toContain('fetch failed');
	});

	it('存在しない pair でフィルタ → 0 件になる', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginPositionsResponse));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({ pair: 'xrp_jpy' });

		assertOk(result);
		expect(result.data.positions).toHaveLength(0);
		expect(result.summary).toContain('建玉はありません');
		expect(result.meta.pair).toBe('xrp_jpy');
	});

	it('追証と不足金が同時に発生した場合、両方の ⚠ アラートを summary 先頭に表示する', async () => {
		const withBoth = {
			...rawMarginPositionsResponse,
			notice: {
				what: '追証',
				occurred_at: 1710000000000,
				amount: '100000',
				due_date_at: 1710200000000,
			},
			payables: { amount: '50000' },
		};
		setupFetchMock(mockBitbankSuccess(withBoth));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({});

		assertOk(result);
		expect(result.meta.hasNotice).toBe(true);
		const lines = result.summary.split('\n');
		expect(lines[0].startsWith('⚠')).toBe(true);
		expect(lines[0]).toContain('追証');
		expect(lines[0]).toContain('100,000');
		expect(lines[1].startsWith('⚠')).toBe(true);
		expect(lines[1]).toContain('不足金');
		expect(lines[1]).toContain('50,000');
	});

	it('不足金が 0 の場合はアラートを表示しない', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginPositionsResponse));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({});

		assertOk(result);
		expect(result.summary).not.toContain('不足金');
	});

	it('notice / payables 無しの場合、summary 先頭は建玉リストヘッダー（⚠ なし）', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginPositionsResponse));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({});

		assertOk(result);
		const firstLine = result.summary.split('\n')[0];
		expect(firstLine).toContain('信用建玉一覧');
		expect(firstLine.startsWith('⚠')).toBe(false);
	});

	it('notice が全 null オブジェクト（NORMAL 口座）でも ok:true で建玉を返し、偽 ⚠ を出さない', async () => {
		// 実 API は追証等が無い NORMAL 状態でも notice を null ではなく全 null オブジェクトで返す。
		const allNullNotice = {
			...rawMarginPositionsResponse,
			notice: { what: null, occurred_at: null, amount: null, due_date_at: null },
		};
		setupFetchMock(mockBitbankSuccess(allNullNotice));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({});

		assertOk(result);
		expect(result.data.positions).toHaveLength(2);
		expect(result.meta.hasNotice).toBe(false);
		expect(result.summary).not.toContain('⚠');
		expect(result.summary.split('\n')[0]).toContain('信用建玉一覧');
	});

	it('notice にイベントあり（一部フィールドのみ非 null）でも ⚠ 行を出す', async () => {
		const partialNotice = {
			...rawMarginPositionsResponse,
			notice: { what: '追証', occurred_at: null, amount: '100000', due_date_at: null },
		};
		setupFetchMock(mockBitbankSuccess(partialNotice));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({});

		assertOk(result);
		expect(result.meta.hasNotice).toBe(true);
		const firstLine = result.summary.split('\n')[0];
		expect(firstLine.startsWith('⚠')).toBe(true);
		expect(firstLine).toContain('追証');
		expect(firstLine).toContain('100,000');
		// due_date_at が null のときは「—」で描画される
		expect(firstLine).toContain('期日: —');
	});

	it('notice: null（後方互換）でも ok:true で建玉を返す', async () => {
		const nullNotice = { ...rawMarginPositionsResponse, notice: null };
		setupFetchMock(mockBitbankSuccess(nullNotice));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({});

		assertOk(result);
		expect(result.data.positions).toHaveLength(2);
		expect(result.meta.hasNotice).toBe(false);
		expect(result.summary).not.toContain('⚠');
	});

	it('建玉の評価額・平均取得価格をサマリーに含む', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginPositionsResponse));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({});

		assertOk(result);
		// btc_jpy のポジション
		expect(result.summary).toContain('15,000,000');
		expect(result.summary).toContain('評価額');
	});
});

describe('get_margin_positions — handler (toolDef)', () => {
	it('handler がデフォルト引数で動作する', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginPositionsResponse));

		const { toolDef } = await import('../../tools/private/get_margin_positions.js');
		const result = await toolDef.handler({});

		expect((result as { ok: boolean }).ok).toBe(true);
	});
});

/**
 * pair の正規化は 2 レイヤーある。同じ 1 行（`p.pair === pair`）の両側なのでまとめて固定する。
 *
 * - **API 応答側**: 取得境界で小文字化（`lib/pair-code.ts`）。揃えないとフィルタが全件落とし、
 *   JPY 建て判定（`p.pair.includes('jpy')`）も外れて平均取得価格が円フォーマットされない。
 * - **ユーザー入力側**: `lib/validate.ts` の `normalizePair`。`BTC_JPY` と入力されると
 *   応答側（小文字）と `===` が一致せず建玉が全件消える。`ensurePair` は使わない
 *   （ALLOWED_PAIRS に無い上場廃止ペアの建玉を照会できなくなるため）。
 */
describe('get_margin_positions — pair の正規化', () => {
	const upperResponse = {
		...rawMarginPositionsResponse,
		positions: rawMarginPositionsResponse.positions.map((p) => ({ ...p, pair: p.pair.toUpperCase() })),
	};

	it('小文字レスポンス + 小文字入力では出力が変わらない（回帰なし）', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginPositionsResponse));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({ pair: 'btc_jpy' });

		assertOk(result);
		expect(result.data.positions.map((p) => p.pair)).toEqual(['btc_jpy']);
		expect(result.meta.pair).toBe('btc_jpy');
		expect(result.summary).toContain('BTC/JPY');
		expect(result.summary).toContain('¥15,000,000');
	});

	it('大文字レスポンスでも pair フィルタが建玉を返す', async () => {
		setupFetchMock(mockBitbankSuccess(upperResponse));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({ pair: 'btc_jpy' });

		assertOk(result);
		// 正規化前は 'BTC_JPY' === 'btc_jpy' が偽で建玉が全件消えていた
		expect(result.data.positions.map((p) => p.pair)).toEqual(['btc_jpy']);
		expect(result.meta.positionCount).toBe(1);
	});

	it('大文字レスポンスでも JPY 建て判定が崩れない（平均取得価格の円フォーマット）', async () => {
		setupFetchMock(mockBitbankSuccess(upperResponse));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({});

		assertOk(result);
		expect(result.data.positions.map((p) => p.pair)).toEqual(['btc_jpy', 'eth_jpy']);
		expect(result.summary).toContain('¥15,000,000');
		expect(result.summary).not.toContain(' 15000000 ');
	});

	it('ユーザー入力が大文字でも建玉を返す（入力レイヤーの正規化）', async () => {
		setupFetchMock(mockBitbankSuccess(rawMarginPositionsResponse));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({ pair: 'BTC_JPY' });

		assertOk(result);
		expect(result.data.positions.map((p) => p.pair)).toEqual(['btc_jpy']);
		expect(result.meta.pair).toBe('btc_jpy');
	});

	it('ALLOWED_PAIRS に無い pair でも取得層で落とさない（上場廃止ペアの建玉）', async () => {
		const delisted = {
			...rawMarginPositionsResponse,
			positions: [{ ...rawMarginPositionsResponse.positions[0], pair: 'MONA_JPY' }],
		};
		setupFetchMock(mockBitbankSuccess(delisted));

		const { default: getMarginPositions } = await import('../../tools/private/get_margin_positions.js');
		const result = await getMarginPositions({ pair: 'mona_jpy' });

		assertOk(result);
		expect(result.data.positions.map((p) => p.pair)).toEqual(['mona_jpy']);
	});
});
