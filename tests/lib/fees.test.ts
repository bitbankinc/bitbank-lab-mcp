// 見積り側の取引手数料（カテゴリ A / B）の解決ロジック。とくに `||` 誤用（campaign の 0 が fallback に化ける）の回帰を重点的に固定する。

import { describe, expect, it } from 'vitest';
import { DEFAULT_TAKER_FALLBACK, estimateOrderFee, feeRole, resolveFeeRate } from '../../lib/fees.js';
import type { PairSpec } from '../../lib/pairs.js';

/** 手数料フィールドのデフォルトはフィクスチャ相当（taker 0.0012 / maker -0.0002 / margin null）。 */
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

describe('resolveFeeRate', () => {
	it('taker 通常値を返す', () => {
		expect(resolveFeeRate(makeSpec(), 'taker')).toBe(0.0012);
	});

	it('maker 通常値を返す', () => {
		expect(resolveFeeRate(makeSpec(), 'maker')).toBe(-0.0002);
	});

	it('負のリベート（-0.0002）をクランプせずそのまま返す', () => {
		const rate = resolveFeeRate(makeSpec({ maker_fee_rate_quote: '-0.0002' }), 'maker');
		expect(rate).toBe(-0.0002);
		expect(rate).toBeLessThan(0);
	});

	it('campaign=0 は 0 のまま（fallback に化けない）', () => {
		expect(resolveFeeRate(makeSpec({ taker_fee_rate_quote: '0' }), 'taker')).toBe(0);
		expect(resolveFeeRate(makeSpec({ maker_fee_rate_quote: '0' }), 'maker')).toBe(0);
	});

	it('|| 誤用回帰: pair 値が 0 でも override 0 でも fallback 化しない', () => {
		// `value || fallback` だと 0 → fallback になるが、`??` なら 0 のまま。
		expect(resolveFeeRate(makeSpec({ taker_fee_rate_quote: '0' }), 'taker', 0)).toBe(0);
	});

	it('override が pair 値より優先される（override > pair > fallback）', () => {
		expect(resolveFeeRate(makeSpec(), 'taker', 0.0005)).toBe(0.0005);
	});

	it('override は 0 / 負値でも尊重される', () => {
		expect(resolveFeeRate(makeSpec(), 'taker', 0)).toBe(0);
		expect(resolveFeeRate(makeSpec(), 'taker', -0.0001)).toBe(-0.0001);
	});

	it('フィールド欠損（null）で fallback', () => {
		expect(resolveFeeRate(makeSpec({ taker_fee_rate_quote: null }), 'taker')).toBe(DEFAULT_TAKER_FALLBACK);
	});

	it('spec 自体が undefined で fallback', () => {
		expect(resolveFeeRate(undefined, 'taker')).toBe(DEFAULT_TAKER_FALLBACK);
		expect(resolveFeeRate(undefined, 'maker')).toBe(DEFAULT_TAKER_FALLBACK);
	});

	it('spec 欠損でも override があれば override 優先', () => {
		expect(resolveFeeRate(undefined, 'maker', -0.0002)).toBe(-0.0002);
	});
});

describe('feeRole', () => {
	it('limit は maker', () => {
		expect(feeRole('limit')).toBe('maker');
	});

	it('stop_limit は maker', () => {
		expect(feeRole('stop_limit')).toBe('maker');
	});

	it('market は taker', () => {
		expect(feeRole('market')).toBe('taker');
	});

	it('stop は taker', () => {
		expect(feeRole('stop')).toBe('taker');
	});

	it('post_only=true は market でも maker（板を跨げないため）', () => {
		expect(feeRole('market', true)).toBe('maker');
		expect(feeRole('limit', true)).toBe('maker');
	});

	it('post_only=false は type に従う', () => {
		expect(feeRole('market', false)).toBe('taker');
		expect(feeRole('limit', false)).toBe('maker');
	});
});

describe('estimateOrderFee', () => {
	it('limit buy: maker レート（-0.0002）で notional・fee・cost を算出し JPY 丸め', () => {
		const est = estimateOrderFee(makeSpec(), {
			type: 'limit',
			side: 'buy',
			price: '15000000',
			amount: '0.01',
		});
		// notional = 150000, fee = 150000 * -0.0002 = -30（リベート）, JPY 丸めで整数
		expect(est.role).toBe('maker');
		expect(est.rate).toBe(-0.0002);
		expect(est.estimatedFeeQuote).toBe(-30);
		// buy: notional + fee = 150000 + (-30) = 149970（リベート分コスト減）
		expect(est.estimatedCostQuote).toBe(149970);
		expect(est.note).toContain('maker 想定');
	});

	it('limit sell: cost = notional - fee', () => {
		const est = estimateOrderFee(makeSpec({ maker_fee_rate_quote: '0.0001' }), {
			type: 'limit',
			side: 'sell',
			price: '15000000',
			amount: '0.01',
		});
		// notional = 150000, fee = 15（JPY 丸め）, sell: 150000 - 15 = 149985
		expect(est.estimatedFeeQuote).toBe(15);
		expect(est.estimatedCostQuote).toBe(149985);
	});

	it('JPY ペアは fee を整数丸めする', () => {
		const est = estimateOrderFee(makeSpec({ taker_fee_rate_quote: '0.0012' }), {
			type: 'stop_limit',
			side: 'buy',
			price: '15000001',
			amount: '0.0123',
			postOnly: false,
		});
		// stop_limit は maker。maker レート -0.0002 → 150000.0123 * -0.0002 = -30.0000...
		expect(Number.isInteger(est.estimatedFeeQuote)).toBe(true);
	});

	it('非 JPY ペアは fee を丸めない', () => {
		const est = estimateOrderFee(makeSpec({ quote_asset: 'btc', maker_fee_rate_quote: '0.001' }), {
			type: 'limit',
			side: 'buy',
			price: '0.05',
			amount: '0.3',
		});
		// notional = 0.015, fee = 0.000015 → 丸めない
		expect(est.estimatedFeeQuote).toBeCloseTo(0.000015, 12);
	});

	it('market: JPY 見積りを省略し note で明示（約定価格依存）', () => {
		const est = estimateOrderFee(makeSpec(), {
			type: 'market',
			side: 'buy',
			amount: '0.01',
		});
		expect(est.role).toBe('taker');
		expect(est.rate).toBe(0.0012);
		expect(est.estimatedFeeQuote).toBeUndefined();
		expect(est.estimatedCostQuote).toBeUndefined();
		expect(est.note).toContain('約定価格依存');
	});

	it('stop: market 同様に JPY 見積りを省略', () => {
		const est = estimateOrderFee(makeSpec(), { type: 'stop', side: 'sell', amount: '0.01' });
		expect(est.role).toBe('taker');
		expect(est.estimatedFeeQuote).toBeUndefined();
		expect(est.note).toContain('約定価格依存');
	});

	it('post_only=true の limit は maker 確定 note', () => {
		const est = estimateOrderFee(makeSpec(), {
			type: 'limit',
			side: 'buy',
			price: '15000000',
			amount: '0.01',
			postOnly: true,
		});
		expect(est.role).toBe('maker');
		expect(est.note).toContain('maker 確定');
	});

	it('信用 open（buy + long）: margin_open_maker_fee_rate_quote を解決対象にする', () => {
		const est = estimateOrderFee(makeSpec({ margin_open_maker_fee_rate_quote: '0.0003' }), {
			type: 'limit',
			side: 'buy',
			price: '15000000',
			amount: '0.01',
			positionSide: 'long',
		});
		expect(est.role).toBe('maker');
		expect(est.rate).toBe(0.0003);
		// notional = 150000, fee = 45（JPY 丸め）
		expect(est.estimatedFeeQuote).toBe(45);
	});

	it('信用 close（sell + long）: margin_close_* を解決対象にする', () => {
		const est = estimateOrderFee(makeSpec({ margin_close_taker_fee_rate_quote: '0.0006' }), {
			type: 'market',
			side: 'sell',
			amount: '0.01',
			positionSide: 'long',
		});
		// market → taker、close（sell+long）
		expect(est.role).toBe('taker');
		expect(est.rate).toBe(0.0006);
	});

	it('信用 open（sell + short）も open 扱い', () => {
		const est = estimateOrderFee(makeSpec({ margin_open_taker_fee_rate_quote: '0.0007' }), {
			type: 'market',
			side: 'sell',
			amount: '0.01',
			positionSide: 'short',
		});
		expect(est.rate).toBe(0.0007);
	});

	it('信用 close（buy + short）も close 扱い', () => {
		const est = estimateOrderFee(makeSpec({ margin_close_maker_fee_rate_quote: '0.0008' }), {
			type: 'limit',
			side: 'buy',
			price: '15000000',
			amount: '0.01',
			positionSide: 'short',
		});
		expect(est.rate).toBe(0.0008);
	});

	it('信用 open（buy + long）: open taker レートを解決する', () => {
		const est = estimateOrderFee(makeSpec({ margin_open_taker_fee_rate_quote: '0.0009' }), {
			type: 'market',
			side: 'buy',
			amount: '0.01',
			positionSide: 'long',
		});
		expect(est.role).toBe('taker');
		expect(est.rate).toBe(0.0009);
	});

	it('信用 4 経路で open/close 判定が正しい（taker レート）', () => {
		const spec = makeSpec({
			margin_open_taker_fee_rate_quote: '0.0001',
			margin_close_taker_fee_rate_quote: '0.0002',
		});
		const base = { type: 'market' as const, amount: '0.01' };
		// 新規建て(open): buy+long / sell+short
		expect(estimateOrderFee(spec, { ...base, side: 'buy', positionSide: 'long' }).rate).toBe(0.0001);
		expect(estimateOrderFee(spec, { ...base, side: 'sell', positionSide: 'short' }).rate).toBe(0.0001);
		// 決済(close): sell+long / buy+short
		expect(estimateOrderFee(spec, { ...base, side: 'sell', positionSide: 'long' }).rate).toBe(0.0002);
		expect(estimateOrderFee(spec, { ...base, side: 'buy', positionSide: 'short' }).rate).toBe(0.0002);
	});

	it('信用 4 経路で open/close 判定が正しい（maker レート / 指値）', () => {
		const spec = makeSpec({
			margin_open_maker_fee_rate_quote: '0.0003',
			margin_close_maker_fee_rate_quote: '0.0004',
		});
		const base = { type: 'limit' as const, price: '15000000', amount: '0.01' };
		expect(estimateOrderFee(spec, { ...base, side: 'buy', positionSide: 'long' }).rate).toBe(0.0003);
		expect(estimateOrderFee(spec, { ...base, side: 'sell', positionSide: 'short' }).rate).toBe(0.0003);
		expect(estimateOrderFee(spec, { ...base, side: 'sell', positionSide: 'long' }).rate).toBe(0.0004);
		expect(estimateOrderFee(spec, { ...base, side: 'buy', positionSide: 'short' }).rate).toBe(0.0004);
	});

	it('信用フィールドが null なら fallback 概算しつつ「API 未提供」note を付ける', () => {
		const est = estimateOrderFee(makeSpec(), {
			type: 'market',
			side: 'buy',
			amount: '0.01',
			positionSide: 'long',
		});
		expect(est.rate).toBe(DEFAULT_TAKER_FALLBACK);
		expect(est.note).toContain('API 未提供');
	});

	it('信用見積りには利息（interest）を含めない旨の note を必ず付ける', () => {
		// レートが揃っていても利息 note は出る（現物レートとの混同防止）。
		const est = estimateOrderFee(makeSpec({ margin_open_maker_fee_rate_quote: '0.0003' }), {
			type: 'limit',
			side: 'buy',
			price: '15000000',
			amount: '0.01',
			positionSide: 'long',
		});
		expect(est.note).toContain('利息');
		expect(est.note).toContain('trade_history');
		// 信用レートが揃っているので「API 未提供」note は出ない。
		expect(est.note).not.toContain('API 未提供');
	});

	it('現物見積りには利息 note を付けない（カテゴリ A/B の分離）', () => {
		const est = estimateOrderFee(makeSpec(), {
			type: 'limit',
			side: 'buy',
			price: '15000000',
			amount: '0.01',
		});
		expect(est.note).not.toContain('利息');
	});

	it('spec 無し: fallback レートで概算し note に「公称 taker」を含める', () => {
		const est = estimateOrderFee(undefined, {
			type: 'limit',
			side: 'buy',
			price: '15000000',
			amount: '0.01',
		});
		expect(est.rate).toBe(DEFAULT_TAKER_FALLBACK);
		expect(est.note).toContain('公称 taker');
		// price 既知だが JPY 判定不可（spec 無し）→ 丸めずに概算
		expect(est.estimatedFeeQuote).toBeCloseTo(150000 * 0.0012, 6);
	});

	it('limit だが price 未指定: JPY 見積りを省略', () => {
		const est = estimateOrderFee(makeSpec(), { type: 'limit', side: 'buy', amount: '0.01' });
		expect(est.estimatedFeeQuote).toBeUndefined();
		expect(est.note).toContain('price 未指定');
	});
});
