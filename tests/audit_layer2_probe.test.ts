/**
 * AUDIT REPRODUCTION (Layer 2/3: 取得層 + 提示層) — 2026-06 データ正確性監査
 *
 * 各 it() は監査レポートの指摘 (F1 / P1 / P2 / P3) を再現・固定する characterization test。
 * いずれも「現状の挙動」を assert する。修正が入ったら期待値の更新が必要（その時点で
 * 監査指摘がクローズされたことの確認になる）。修正自体は本タスクの対象外。
 *
 * 実行: npx vitest run tests/audit_layer2_probe.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allToolDefs } from '../src/tool-registry.js';
import getOrderbook from '../tools/get_orderbook.js';
import { asMockResult } from './_assertResult.js';

function findNonFinite(value: unknown, path = '$'): string[] {
	const found: string[] = [];
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) found.push(`${path}=${String(value)}`);
		return found;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			for (const p of findNonFinite(value[i], `${path}[${i}]`)) found.push(p);
		}
		return found;
	}
	if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			for (const p of findNonFinite(v, `${path}.${k}`)) found.push(p);
		}
	}
	return found;
}

function mockJson(payload: unknown) {
	return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		asMockResult<Response>({
			ok: true,
			status: 200,
			statusText: 'OK',
			headers: new Headers(),
			json: async () => payload,
		}),
	);
}

const TS = 1_700_000_000_000;

afterEach(() => {
	vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────
// F1: get_orderbook は非数値 price を sanitize しない（prepare_depth_data は drop+warning するのに対し）
//   - summary / statistics: Zod parse 失敗 → 'network' へ誤分類（実態は upstream のデータ品質）
//   - raw: 破損値 "abc" / "NaN円" がそのまま LLM テキスト・data に流出
//   - pressure: bestBid 破損で baseMid=null に黙って退行（全 band ゼロ＝「均衡」と誤提示）
// ─────────────────────────────────────────────────────────────
describe('F1 取得層: get_orderbook 非数値 price の扱い（mode 間で不整合）', () => {
	const badDepth = {
		success: 1,
		data: {
			asks: [
				['5000100', '0.2'],
				['5000200', '0.4'],
			],
			bids: [
				['abc', '0.3'], // 上流データ破損想定（非数値 price）
				['5000000', '0.5'],
			],
			timestamp: TS,
		},
	};

	it('summary: Zod 失敗が network へ誤分類され、エラー文に NaN が漏れる', async () => {
		mockJson(badDepth);
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'summary' });
		expect(res.ok).toBe(false);
		expect((res.meta as { errorType?: string }).errorType).toBe('network'); // ← 本来は 'upstream' が妥当
		expect(res.summary).toMatch(/NaN|invalid_type/);
	});

	it('statistics: 同上（network 誤分類）', async () => {
		mockJson(badDepth);
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics' });
		expect(res.ok).toBe(false);
		expect((res.meta as { errorType?: string }).errorType).toBe('network');
	});

	it('raw: 破損値が drop/警告されず data・テキストにそのまま流出（"abc" / "NaN円"）', async () => {
		mockJson(badDepth);
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'raw' });
		expect(res.ok).toBe(true);
		// 破損値が data にそのまま残る
		expect((res.data as { bids: unknown[][] }).bids[0][0]).toBe('abc');
		// LLM 可視テキストに "NaN円" が出る
		expect(res.summary).toContain('NaN円');
		// meta に droppedRows / warning は無い（prepare_depth_data と非対称）
		expect((res.meta as { warning?: string }).warning).toBeUndefined();
	});

	it('pressure: bestBid 破損で baseMid=null に黙って退行（全 band ゼロ）', async () => {
		mockJson(badDepth);
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'pressure' });
		expect(res.ok).toBe(true);
		const bands = (res.data as { bands: Array<{ baseMid: number | null; netDeltaPct: number | null }> }).bands;
		expect(bands[0].baseMid).toBeNull();
		expect(bands.every((b) => b.netDeltaPct === null)).toBe(true);
		// 退行を示す warning も無い
		expect(findNonFinite({ data: res.data })).toEqual([]); // NaN は出ない（null 化）が、退行は無警告
	});
});

// ─────────────────────────────────────────────────────────────
// P2: get_orderbook pressure / statistics が出来高単位 "BTC" をハードコード（全ペア）
//   → eth_jpy 等の非 BTC ペアで LLM 可視テキストの単位が誤り
// ─────────────────────────────────────────────────────────────
describe('P2 提示層: get_orderbook の出来高単位ハードコード', () => {
	const goodDepth = {
		success: 1,
		data: {
			asks: [
				['500100', '2.0'],
				['500200', '4.0'],
			],
			bids: [
				['500000', '3.0'],
				['499900', '5.0'],
			],
			timestamp: TS,
		},
	};

	it('pressure (eth_jpy): テキストに "BTC" が出る（誤り）', async () => {
		mockJson(goodDepth);
		const res = await getOrderbook({ pair: 'eth_jpy', mode: 'pressure' });
		expect(res.summary).toMatch(/\bBTC\b/); // ← eth_jpy なのに BTC
	});

	it('statistics (eth_jpy): テキストに "BTC" が出る（誤り）', async () => {
		mockJson(goodDepth);
		const res = await getOrderbook({ pair: 'eth_jpy', mode: 'statistics' });
		expect(res.summary).toMatch(/\bBTC\b/);
	});

	it('summary / raw (eth_jpy): 単位ハードコードは無い（対照）', async () => {
		mockJson(goodDepth);
		const sum = await getOrderbook({ pair: 'eth_jpy', mode: 'summary' });
		expect(sum.summary).not.toMatch(/\bBTC\b/);
		vi.restoreAllMocks();
		mockJson(goodDepth);
		const raw = await getOrderbook({ pair: 'eth_jpy', mode: 'raw' });
		expect(raw.summary).not.toMatch(/\bBTC\b/);
	});
});

// ─────────────────────────────────────────────────────────────
// P1: get_candles handler の view=items が summary（= 先頭の fetchWarning）と meta を丸ごと落とす
//   → multi-day/multi-year 部分失敗時、LLM はデータ不完全に気づけない
// ─────────────────────────────────────────────────────────────
describe('P1 提示層: get_candles view=items の fetchWarning / meta 欠落', () => {
	// multi-day（1hour, limit=96）で最古 chunk だけ success:0 にして fetchWarning を発生させる
	// （過半数失敗は避ける）。
	function mockPartialMultiDay() {
		let call = 0;
		return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
			const url = String(input);
			const m = url.match(/\/candlestick\/1hour\/(\d{8})$/);
			const isFirst = call === 0;
			call += 1;
			if (m && isFirst) {
				return asMockResult<Response>({
					ok: true,
					status: 200,
					statusText: 'OK',
					headers: new Headers(),
					json: async () => ({ success: 0, data: { code: 10000 } }),
				});
			}
			const day = m?.[1] ?? '20240101';
			const base = Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00Z`);
			const ohlcv = [
				['5000000', '5000100', '4999900', '5000050', '1.0', base],
				['5000050', '5000200', '4999800', '5000100', '1.1', base + 3_600_000],
			];
			return asMockResult<Response>({
				ok: true,
				status: 200,
				statusText: 'OK',
				headers: new Headers(),
				json: async () => ({ success: 1, data: { candlestick: [{ ohlcv }] } }),
			});
		});
	}

	const getDef = () => {
		const def = allToolDefs.find((t) => t.name === 'get_candles');
		if (!def) throw new Error('get_candles not registered');
		return def;
	};

	it('full view（既定）: 部分失敗の警告が content に出る', async () => {
		mockPartialMultiDay();
		const out = (await getDef().handler({ pair: 'btc_jpy', type: '1hour', limit: 96 })) as {
			content?: Array<{ text: string }>;
		};
		const text = (out.content ?? []).map((c) => c.text).join('\n');
		expect(text).toMatch(/失敗しました/);
	});

	it('items view: 同条件で警告が消え、structuredContent に meta が無い', async () => {
		mockPartialMultiDay();
		const out = (await getDef().handler({ pair: 'btc_jpy', type: '1hour', limit: 96, view: 'items' })) as {
			content?: Array<{ text: string }>;
			structuredContent?: Record<string, unknown>;
		};
		const text = (out.content ?? []).map((c) => c.text).join('\n');
		expect(text).not.toMatch(/失敗しました/); // ← 警告が落ちる
		expect(text).not.toContain('⚠️');
		// structuredContent は { items } のみ。meta / summary が無い。
		expect(Object.keys(out.structuredContent ?? {})).toEqual(['items']);
	});
});

// ─────────────────────────────────────────────────────────────
// P3: get_transactions の filter + 既定 view=summary が個別約定行を落とす（件数のみ提示）
// ─────────────────────────────────────────────────────────────
describe('P3 提示層: get_transactions filter + view=summary の行欠落', () => {
	function txFixture() {
		return {
			success: 1,
			data: {
				transactions: [
					{ transaction_id: 1, price: '5000000', amount: '0.01', side: 'buy', executed_at: TS },
					{ transaction_id: 2, price: '5000100', amount: '2.5', side: 'sell', executed_at: TS + 1 },
					{ transaction_id: 3, price: '5000200', amount: '0.03', side: 'buy', executed_at: TS + 2 },
				],
			},
		};
	}
	const getDef = () => {
		const def = allToolDefs.find((t) => t.name === 'get_transactions');
		if (!def) throw new Error('get_transactions not registered');
		return def;
	};

	it('フィルタ無し: content に個別約定行（📋 全N件の取引）が出る', async () => {
		mockJson(txFixture());
		const out = (await getDef().handler({ pair: 'btc_jpy', limit: 10 })) as { summary?: string };
		expect(String(out.summary)).toMatch(/📋 全\d+件の取引/);
	});

	it('minAmount フィルタ + 既定 view=summary: 個別約定行が落ち、件数のみ', async () => {
		mockJson(txFixture());
		const out = (await getDef().handler({ pair: 'btc_jpy', limit: 10, minAmount: 1 })) as { summary?: string };
		const text = String(out.summary);
		expect(text).not.toMatch(/📋 全\d+件の取引/); // ← 行が消える
		expect(text).toMatch(/フィルタ後\s*1件/); // 件数のみ残る
	});
});
