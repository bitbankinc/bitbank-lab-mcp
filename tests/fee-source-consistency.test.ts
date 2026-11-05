import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TAKER_FALLBACK, estimateOrderFee, resolveFeeRate } from '../lib/fees.js';
import type { PairSpec } from '../lib/pairs.js';
import { mockBitbankSuccess, mockSpotPairsResponse } from './fixtures/private-api.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** .claude/hooks/post-ts-lint.sh Phase 4 と同じパターン（`||` は campaign の 0 を fallback に化けさせる）。 */
const FEE_PATTERN = /0\.0012|(Number|parseFloat)\([^)]*_fee_rate_quote|_fee_rate_quote.*\|\|/;

const SCAN_DIRS = ['lib', 'tools', 'src'];

function collectTsFiles(dir: string): string[] {
	const out: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (entry === 'node_modules') continue;
			out.push(...collectTsFiles(full));
		} else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
			out.push(full);
		}
	}
	return out;
}

describe('手数料ソース横断 — enforcement 回帰防止（grep ベース）', () => {
	it('取引手数料リテラル / 直接 parse / || が lib/fees.ts・tests/ 以外に存在しない', () => {
		const violations: string[] = [];

		for (const d of SCAN_DIRS) {
			for (const file of collectTsFiles(join(REPO_ROOT, d))) {
				// Windows の区切り文字（\）でも比較できるようスラッシュに正規化する
				const rel = relative(REPO_ROOT, file).split(sep).join('/');
				if (rel === 'lib/fees.ts' || rel.startsWith('tests/') || rel.includes('/tests/')) continue;

				const lines = readFileSync(file, 'utf8').split('\n');
				lines.forEach((line, i) => {
					if (/\/\/ *allow-fee/.test(line)) return;
					if (FEE_PATTERN.test(line)) {
						violations.push(`${rel}:${i + 1}: ${line.trim()}`);
					}
				});
			}
		}

		// 違反があれば該当行を可視化して落とす（DEFAULT_TAKER_FALLBACK は lib/fees.ts 内のみ許可）。
		expect(violations).toEqual([]);
	});

	it('lib/fees.ts 自体には公称 taker フォールバック定数が 1 箇所だけ存在する', () => {
		const src = readFileSync(join(REPO_ROOT, 'lib/fees.ts'), 'utf8');
		const matches = src.match(/0\.0012/g) ?? [];
		// DEFAULT_TAKER_FALLBACK = 0.0012 の 1 箇所のみ（ハードコード全廃の裏返し）。
		expect(matches).toHaveLength(1);
	});
});

function makeSpec(overrides: Partial<PairSpec> = {}): PairSpec {
	return {
		name: 'btc_jpy',
		base_asset: 'btc',
		quote_asset: 'jpy',
		unit_amount: '0.0001',
		limit_max_amount: '1000',
		market_max_amount: '0.5',
		price_digits: 0,
		amount_digits: 8,
		is_enabled: true,
		stop_order: false,
		stop_order_and_cancel: false,
		stop_market_order: false,
		stop_stop_order: false,
		stop_stop_limit_order: false,
		stop_margin_long_order: false,
		stop_margin_short_order: false,
		stop_buy_order: false,
		stop_sell_order: false,
		taker_fee_rate_quote: '0.0012',
		maker_fee_rate_quote: '-0.0002',
		taker_fee_rate_base: '0',
		maker_fee_rate_base: '0',
		margin_open_maker_fee_rate_quote: null,
		margin_open_taker_fee_rate_quote: null,
		margin_close_maker_fee_rate_quote: null,
		margin_close_taker_fee_rate_quote: null,
		...overrides,
	};
}

describe('手数料ソース横断 — 見積りは全て lib/fees.ts 経由（一覧）', () => {
	const cases: Array<{ label: string; spec: PairSpec | undefined; role: 'maker' | 'taker'; expected: number }> = [
		{ label: 'taker 通常', spec: makeSpec({ taker_fee_rate_quote: '0.0012' }), role: 'taker', expected: 0.0012 },
		{ label: 'maker 通常', spec: makeSpec({ maker_fee_rate_quote: '0.0001' }), role: 'maker', expected: 0.0001 },
		{
			label: '負リベート（クランプしない）',
			spec: makeSpec({ maker_fee_rate_quote: '-0.0002' }),
			role: 'maker',
			expected: -0.0002,
		},
		{
			label: 'campaign=0（fallback に化けない）',
			spec: makeSpec({ taker_fee_rate_quote: '0' }),
			role: 'taker',
			expected: 0,
		},
		{
			label: '取得失敗フォールバック（spec undefined）',
			spec: undefined,
			role: 'taker',
			expected: DEFAULT_TAKER_FALLBACK,
		},
		{
			label: 'フィールド欠損フォールバック（null）',
			spec: makeSpec({ taker_fee_rate_quote: null }),
			role: 'taker',
			expected: DEFAULT_TAKER_FALLBACK,
		},
	];

	it.each(cases)('resolveFeeRate: $label → $expected', ({ spec, role, expected }) => {
		expect(resolveFeeRate(spec, role)).toBe(expected);
	});

	it('campaign=0 は estimateOrderFee でも 0 のまま（手数料 0 として算出）', () => {
		const est = estimateOrderFee(makeSpec({ maker_fee_rate_quote: '0' }), {
			type: 'limit',
			side: 'buy',
			price: '15000000',
			amount: '0.01',
		});
		expect(est.rate).toBe(0);
		expect(est.estimatedFeeQuote).toBe(0);
	});

	it('負リベートは estimateOrderFee でコストを減らす方向に効く', () => {
		const est = estimateOrderFee(makeSpec({ maker_fee_rate_quote: '-0.0002' }), {
			type: 'limit',
			side: 'buy',
			price: '15000000',
			amount: '0.01',
		});
		// fee = 150000 * -0.0002 = -30, buy cost = 150000 + (-30) = 149970
		expect(est.estimatedFeeQuote).toBe(-30);
		expect(est.estimatedCostQuote).toBe(149970);
	});
});

describe('手数料ソース横断 — preview_order 見積りで発注 POST が走らない', () => {
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
		vi.restoreAllMocks();
	});

	it('handler（elicitation 非対応）は手数料を見積るが /user/spot/order を一切叩かない', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
			if (url.includes('/spot/pairs')) {
				return new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 });
			}
			if (url.includes('/ticker')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ last: '15000000' })), { status: 200 });
			}
			return new Response(JSON.stringify({ success: 1, data: {} }), { status: 200 });
		}) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;

		const { toolDef } = await import('../tools/private/preview_order.js');
		const result = (await toolDef.handler({
			pair: 'btc_jpy',
			amount: '0.01',
			side: 'buy',
			type: 'limit',
			price: '14000000',
		})) as { content: { text: string }[] };

		expect(result.content[0]?.text).toContain('手数料見積り');
		const calls = (fetchMock as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls;
		expect(calls.some((c) => String(c[0]).includes('/user/spot/order'))).toBe(false);
	});
});
