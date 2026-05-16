/**
 * portfolio/calc — fee_amount_base を保有量・コスト基準に反映するロジックの検証。
 *
 * bitbank の現物手数料体系:
 *   買い: 手数料は base 通貨で発生（fee_amount_base > 0, fee_amount_quote = 0）
 *   売り: 手数料は quote 通貨で発生（fee_amount_quote > 0, fee_amount_base = 0）
 *
 * 旧実装は buy 側で fee_amount_base を無視していたため、保有量を過大に・
 * 平均取得単価を過小に記録していた。本テストは:
 *   - 買い側 fee_amount_base が holdingQty に反映されること
 *   - 売り側 fee_amount_quote が realized_pnl に従来通り反映されること
 *   - fee_amount_base = 0 のときは旧挙動と等価であること
 * を、calcPnl / calcPeriodRealizedPnl / reconstructHoldingsAtDate の 3 関数で検証する。
 */

import { describe, expect, it } from 'vitest';
import {
	buildAccountPnl,
	calcDepositWithdrawalSummary,
	calcMarginPnl,
	calcPeriodMarginPnl,
	calcPeriodRealizedPnl,
	calcPnl,
	reconstructHoldingsAtDate,
} from '../../../src/handlers/portfolio/calc.js';
import type {
	DepositWithdrawalData,
	RawDeposit,
	RawMarginTrade,
	RawTrade,
	RawWithdrawal,
} from '../../../src/handlers/portfolio/types.js';

/** 必須フィールドを既定値で埋めた RawTrade を生成する */
function makeTrade(overrides: Partial<RawTrade> = {}): RawTrade {
	return {
		trade_id: 1,
		pair: 'btc_jpy',
		order_id: 1,
		side: 'buy',
		type: 'limit',
		amount: '0',
		price: '0',
		maker_taker: 'maker',
		fee_amount_base: '0',
		fee_amount_quote: '0',
		executed_at: 0,
		...overrides,
	};
}

/** 必須フィールドを既定値で埋めた RawWithdrawal を生成する */
function makeWithdrawal(overrides: Partial<RawWithdrawal> = {}): RawWithdrawal {
	return {
		uuid: 'wd-1',
		asset: 'btc',
		amount: '0',
		fee: '0',
		status: 'DONE',
		requested_at: 0,
		...overrides,
	};
}

/** 必須フィールドを既定値で埋めた RawDeposit を生成する */
function makeDeposit(overrides: Partial<RawDeposit> = {}): RawDeposit {
	return {
		uuid: 'dep-1',
		asset: 'jpy',
		amount: '0',
		status: 'DONE',
		found_at: 0,
		confirmed_at: 0,
		...overrides,
	};
}

describe('calcPnl', () => {
	it('買い 1 件、fee_amount_base > 0 で保有量が減少し平均取得単価が上昇する', () => {
		// 1 BTC を 10_000_000 JPY で買い、手数料 0.001 BTC（base 側）
		//   holdingCost = 1 * 10_000_000 + 0 = 10_000_000 JPY
		//   holdingQty = 1 - 0.001 = 0.999 BTC
		//   avg_buy_price = 10_000_000 / 0.999 ≈ 10_010_010.0100
		const trades: RawTrade[] = [
			makeTrade({
				side: 'buy',
				amount: '1',
				price: '10000000',
				fee_amount_base: '0.001',
				fee_amount_quote: '0',
			}),
		];
		const result = calcPnl(trades, 'btc');
		expect(result.cost_basis).toBeCloseTo(10_000_000, 6);
		expect(result.avg_buy_price).toBeCloseTo(10_010_010.01001001, 4);
		expect(result.realized_pnl).toBe(0);
		expect(result.trade_count).toBe(1);
	});

	it('買い→売りで base/quote 両側の手数料が反映され realized_pnl が算出される', () => {
		// 買い 1 BTC @ 10_000_000、fee_base=0.001
		//   holdingQty = 0.999、holdingCost = 10_000_000
		// 売り 0.999 BTC @ 11_000_000、fee_quote=10_000
		//   avgCost  = 10_000_000 / 0.999
		//   sellCost = 0.999 * avgCost = 10_000_000
		//   sellRev  = 0.999 * 11_000_000 - 10_000 = 10_979_000
		//   realized = 10_979_000 - 10_000_000 = 979_000
		const trades: RawTrade[] = [
			makeTrade({
				trade_id: 1,
				executed_at: 1,
				side: 'buy',
				amount: '1',
				price: '10000000',
				fee_amount_base: '0.001',
				fee_amount_quote: '0',
			}),
			makeTrade({
				trade_id: 2,
				executed_at: 2,
				side: 'sell',
				amount: '0.999',
				price: '11000000',
				fee_amount_base: '0',
				fee_amount_quote: '10000',
			}),
		];
		const result = calcPnl(trades, 'btc');
		expect(result.realized_pnl).toBe(979_000);
		// 全量売却で保有ゼロ → avg/cost は undefined
		expect(result.avg_buy_price).toBeUndefined();
		expect(result.cost_basis).toBeUndefined();
		expect(result.trade_count).toBe(2);
	});

	it('fee_amount_base = 0 の買いで旧挙動と等価な結果を返す', () => {
		// 旧実装互換: fee_base=0 のとき holdingQty = qty、avg_buy_price = price
		const trades: RawTrade[] = [
			makeTrade({
				side: 'buy',
				amount: '1',
				price: '10000000',
				fee_amount_base: '0',
				fee_amount_quote: '0',
			}),
		];
		const result = calcPnl(trades, 'btc');
		expect(result.cost_basis).toBe(10_000_000);
		expect(result.avg_buy_price).toBe(10_000_000);
		expect(result.realized_pnl).toBe(0);
		expect(result.trade_count).toBe(1);
	});

	it('保有量を超える売りで原価は保有分のみ按分される（fee_base 反映後も同様）', () => {
		// 買い 1 BTC @ 10_000_000、fee_base=0.001 → holdingQty=0.999, holdingCost=10_000_000
		// 売り 2 BTC @ 11_000_000、fee_quote=20_000（保有 0.999 を超過）
		//   coveredQty = min(2, 0.999) = 0.999
		//   sellCost   = 0.999 * (10_000_000 / 0.999) = 10_000_000
		//   sellRev    = 2 * 11_000_000 - 20_000 = 21_980_000
		//   realized   = 21_980_000 - 10_000_000 = 11_980_000
		const trades: RawTrade[] = [
			makeTrade({
				trade_id: 1,
				executed_at: 1,
				side: 'buy',
				amount: '1',
				price: '10000000',
				fee_amount_base: '0.001',
			}),
			makeTrade({
				trade_id: 2,
				executed_at: 2,
				side: 'sell',
				amount: '2',
				price: '11000000',
				fee_amount_quote: '20000',
			}),
		];
		const result = calcPnl(trades, 'btc');
		expect(result.realized_pnl).toBe(11_980_000);
		expect(result.avg_buy_price).toBeUndefined();
		expect(result.cost_basis).toBeUndefined();
		expect(result.trade_count).toBe(2);
	});

	it('年初前買い → 年初後売りの全履歴投入で「売値 - 平均取得単価」が realized_pnl になる', () => {
		// バグ回帰防止: 年初前の買いを含めずに calcPnl を呼ぶと、年初後売却が
		// 「保有ゼロでの売り」扱いとなり、売却代金ほぼ全額（5_999_500）が realized に積まれていた。
		// 全履歴を渡せば原価が按分され、realized = 0.5 * (12_000_000 - 10_000_000) - 500 ≈ 999_500。
		const trades: RawTrade[] = [
			makeTrade({
				trade_id: 1,
				executed_at: 100, // 年初前
				side: 'buy',
				amount: '1',
				price: '10000000',
				fee_amount_base: '0',
				fee_amount_quote: '0',
			}),
			makeTrade({
				trade_id: 2,
				executed_at: 2000, // 年初後
				side: 'sell',
				amount: '0.5',
				price: '12000000',
				fee_amount_base: '0',
				fee_amount_quote: '500',
			}),
		];
		const result = calcPnl(trades, 'btc');
		// holdingQty=1, holdingCost=10_000_000 → avgCost=10_000_000
		// sellCost = 0.5 * 10_000_000 = 5_000_000
		// sellRev  = 0.5 * 12_000_000 - 500 = 5_999_500
		// realized = 5_999_500 - 5_000_000 = 999_500
		expect(result.realized_pnl).toBe(999_500);
		// 残保有 0.5 BTC、残原価 5_000_000
		expect(result.avg_buy_price).toBe(10_000_000);
		expect(result.cost_basis).toBe(5_000_000);
	});

	it('年初前のみ買って当年売却なしの場合、cost_basis / avg_buy_price が正しく出る', () => {
		// 全履歴入力での未売却ケース。realized_pnl は 0、保有分の原価が残る。
		const trades: RawTrade[] = [
			makeTrade({
				trade_id: 1,
				executed_at: 100, // 年初前
				side: 'buy',
				amount: '2',
				price: '8000000',
				fee_amount_base: '0',
				fee_amount_quote: '0',
			}),
		];
		const result = calcPnl(trades, 'btc');
		expect(result.realized_pnl).toBe(0);
		expect(result.cost_basis).toBe(16_000_000);
		expect(result.avg_buy_price).toBe(8_000_000);
		expect(result.trade_count).toBe(1);
	});

	it('年初前出庫 + 年初後売却で原価が按分減少し正しい realized_pnl になる', () => {
		// 買い 1 BTC（年初前）→ 出庫 0.3 BTC（年初前、手数料 0.001）→ 売り 0.5 BTC（年初後）
		// 出庫前: qty=1, cost=10_000_000 → avgCost=10_000_000
		// 出庫: removed=0.301（0.3 + fee 0.001）。新 qty=0.699, cost=10_000_000 - 0.301*10_000_000=6_990_000
		// 売り 0.5: avgCost=6_990_000/0.699=10_000_000
		//   sellCost = 0.5 * 10_000_000 = 5_000_000
		//   sellRev  = 0.5 * 12_000_000 - 0 = 6_000_000
		//   realized = 1_000_000
		const trades: RawTrade[] = [
			makeTrade({
				trade_id: 1,
				executed_at: 100,
				side: 'buy',
				amount: '1',
				price: '10000000',
			}),
			makeTrade({
				trade_id: 2,
				executed_at: 2000,
				side: 'sell',
				amount: '0.5',
				price: '12000000',
			}),
		];
		const withdrawals: RawWithdrawal[] = [
			makeWithdrawal({ uuid: 'w1', asset: 'btc', amount: '0.3', fee: '0.001', requested_at: 500 }),
		];
		const result = calcPnl(trades, 'btc', withdrawals);
		expect(result.realized_pnl).toBe(1_000_000);
		expect(result.cost_basis).toBeCloseTo(1_990_000, 6); // 0.199 * 10_000_000
		expect(result.avg_buy_price).toBeCloseTo(10_000_000, 4);
	});
});

describe('calcPeriodRealizedPnl', () => {
	it('期間前の買い fee_amount_base が期間内 sell の原価按分に反映される', () => {
		// 期間前 (t=500): 買い 1 BTC @ 10_000_000、fee_base=0.001
		//   h.qty = 0.999、h.cost = 10_000_000
		// 期間内 (t=1500): 売り 0.5 BTC @ 12_000_000、fee_quote=5_000
		//   avgCost  = 10_000_000 / 0.999 ≈ 10_010_010.0100
		//   sellCost = 0.5 * avgCost     ≈ 5_005_005.0050
		//   sellRev  = 0.5 * 12_000_000 - 5_000 = 5_995_000
		//   realized ≈ 989_994.995 → Math.round → 989_995
		const trades: RawTrade[] = [
			makeTrade({
				trade_id: 1,
				executed_at: 500,
				side: 'buy',
				amount: '1',
				price: '10000000',
				fee_amount_base: '0.001',
			}),
			makeTrade({
				trade_id: 2,
				executed_at: 1500,
				side: 'sell',
				amount: '0.5',
				price: '12000000',
				fee_amount_quote: '5000',
			}),
		];
		const result = calcPeriodRealizedPnl(trades, 1000, '2024-01-01T00:00:00+09:00', '2024-12-31T23:59:59+09:00');
		expect(result.realized_pnl).toBe(989_995);
		expect(result.sell_count).toBe(1);
		expect(result.period_start).toBe('2024-01-01T00:00:00+09:00');
		expect(result.period_end).toBe('2024-12-31T23:59:59+09:00');
	});

	it('期間前の出庫が期間内 sell の平均原価に反映される（calcPnl と一致）', () => {
		// 期間前 (t=100): 買い 1 BTC @ 10_000_000 → qty=1, cost=10_000_000
		// 期間前 (t=500): 出庫 0.3 BTC + fee 0.001 → qty=0.699, cost=6_990_000, avgCost=10_000_000
		// 期間内 (t=1500): 売り 0.5 BTC @ 12_000_000
		//   sellCost = 0.5 * 10_000_000 = 5_000_000
		//   sellRev  = 0.5 * 12_000_000 = 6_000_000
		//   realized = 1_000_000
		const trades: RawTrade[] = [
			makeTrade({ trade_id: 1, executed_at: 100, side: 'buy', amount: '1', price: '10000000' }),
			makeTrade({ trade_id: 2, executed_at: 1500, side: 'sell', amount: '0.5', price: '12000000' }),
		];
		const withdrawals: RawWithdrawal[] = [
			makeWithdrawal({ uuid: 'w1', asset: 'btc', amount: '0.3', fee: '0.001', requested_at: 500 }),
		];
		const result = calcPeriodRealizedPnl(
			trades,
			1000,
			'2024-01-01T00:00:00+09:00',
			'2024-12-31T23:59:59+09:00',
			withdrawals,
		);
		expect(result.realized_pnl).toBe(1_000_000);
		expect(result.sell_count).toBe(1);
	});

	it('withdrawals を渡さない場合と pending withdrawal は holdings に影響しない', () => {
		// pending（status=PROCESSING）の出庫は無視される。出庫を渡さなければ全量保有のまま売却される。
		const trades: RawTrade[] = [
			makeTrade({ trade_id: 1, executed_at: 100, side: 'buy', amount: '1', price: '10000000' }),
			makeTrade({ trade_id: 2, executed_at: 1500, side: 'sell', amount: '1', price: '12000000' }),
		];
		const pendingWithdrawals: RawWithdrawal[] = [
			makeWithdrawal({ uuid: 'w1', asset: 'btc', amount: '0.5', status: 'PROCESSING', requested_at: 500 }),
		];
		// withdrawals 引数なし: realized = 1 * 12_000_000 - 1 * 10_000_000 = 2_000_000
		const noWd = calcPeriodRealizedPnl(trades, 1000, 's', 'e');
		expect(noWd.realized_pnl).toBe(2_000_000);
		// pending withdrawal を渡しても DONE でないので無視され同じ結果
		const withPending = calcPeriodRealizedPnl(trades, 1000, 's', 'e', pendingWithdrawals);
		expect(withPending.realized_pnl).toBe(2_000_000);
	});

	it('空配列で realized_pnl=0 / sell_count=0 を返す', () => {
		const result = calcPeriodRealizedPnl([], 1000, 's', 'e');
		expect(result.realized_pnl).toBe(0);
		expect(result.sell_count).toBe(0);
	});

	it('保有ゼロ状態での売り（空売り）は period 内なら sell_count に計上される', () => {
		// 買いなしで突然 sell → calcPnl と同じく売却代金が realized になる
		const trades: RawTrade[] = [
			makeTrade({ trade_id: 1, executed_at: 1500, side: 'sell', amount: '0.5', price: '12000000' }),
		];
		const result = calcPeriodRealizedPnl(trades, 1000, 's', 'e');
		expect(result.realized_pnl).toBe(6_000_000);
		expect(result.sell_count).toBe(1);
	});

	it('期間前 sell のみで sell_count=0 / realized_pnl=0（期間内に売却なし）', () => {
		// エッジケース: 全 sell が sinceMs より前なら期間集計はゼロ
		const trades: RawTrade[] = [
			makeTrade({ trade_id: 1, executed_at: 100, side: 'buy', amount: '1', price: '10000000' }),
			makeTrade({ trade_id: 2, executed_at: 500, side: 'sell', amount: '0.5', price: '11000000' }),
		];
		const result = calcPeriodRealizedPnl(trades, 1000, 's', 'e');
		expect(result.realized_pnl).toBe(0);
		expect(result.sell_count).toBe(0);
	});
});

describe('reconstructHoldingsAtDate', () => {
	it('reverse buy で fee_amount_base が反映され、復元保有が 0 になり map から消える', () => {
		// 現在保有: 0.999 BTC（買い qty=1, fee_base=0.001 の結果）
		// sinceMs=1000、期間内 buy (t=2000) を逆算
		//   期間前 BTC = 0.999 - (1 - 0.001) = 0 → map から削除
		//   期間前 JPY = 0 + 1 * 10_000_000 + 0 = 10_000_000
		const currentHoldings = [{ asset: 'btc', amount: '0.999' }];
		const trades: RawTrade[] = [
			makeTrade({
				trade_id: 1,
				executed_at: 2000,
				side: 'buy',
				amount: '1',
				price: '10000000',
				fee_amount_base: '0.001',
			}),
		];
		const result = reconstructHoldingsAtDate(currentHoldings, trades, 1000, null);
		expect(result.has('btc')).toBe(false);
		expect(result.get('jpy')).toBe(10_000_000);
	});

	it('reverse sell は fee_amount_base 追加後も従来通り動作する', () => {
		// 現在保有: 1.5 BTC, 11_000_000 JPY（売り直後の状態を想定）
		// 期間内 sell (t=2000): amount=0.5, price=12M, fee_quote=5000, fee_base=0
		//   期間前 BTC = 1.5 + 0.5 = 2.0
		//   期間前 JPY = 11_000_000 - 0.5 * 12_000_000 + 5_000 = 5_005_000
		const currentHoldings = [
			{ asset: 'btc', amount: '1.5' },
			{ asset: 'jpy', amount: '11000000' },
		];
		const trades: RawTrade[] = [
			makeTrade({
				trade_id: 1,
				executed_at: 2000,
				side: 'sell',
				amount: '0.5',
				price: '12000000',
				fee_amount_quote: '5000',
				fee_amount_base: '0',
			}),
		];
		const result = reconstructHoldingsAtDate(currentHoldings, trades, 1000, null);
		expect(result.get('btc')).toBeCloseTo(2.0, 9);
		expect(result.get('jpy')).toBe(5_005_000);
	});

	it('不正な amount を持つ currentHoldings エントリは Number.isFinite ガードで除外される', () => {
		// 初期化ループの `Number.isFinite(amount) && amount > 0` ガードを検証:
		//   - 有効値（正の有限数）のみが Map に入る
		//   - NaN / 'abc' のような malformed string、負値、ゼロ、Infinity は除外
		const currentHoldings = [
			{ asset: 'btc', amount: '1.0' }, // 有効 → 保持
			{ asset: 'eth', amount: 'NaN' }, // Number.isFinite=false → 除外
			{ asset: 'xrp', amount: 'abc' }, // Number('abc')=NaN → 除外
			{ asset: 'ltc', amount: '-0.5' }, // amount > 0 false → 除外
			{ asset: 'doge', amount: '0' }, // amount > 0 false → 除外
			{ asset: 'bch', amount: 'Infinity' }, // Number.isFinite(Infinity)=false → 除外
		];
		const result = reconstructHoldingsAtDate(currentHoldings, [], 1000, null);
		expect(result.size).toBe(1);
		expect(result.get('btc')).toBe(1.0);
		expect(result.has('eth')).toBe(false);
		expect(result.has('xrp')).toBe(false);
		expect(result.has('ltc')).toBe(false);
		expect(result.has('doge')).toBe(false);
		expect(result.has('bch')).toBe(false);
	});

	it('amount / price が finite でない trade はスキップされ、他の trade と保有は影響を受けない', () => {
		// 約定ループの `if (!Number.isFinite(qty) || !Number.isFinite(price)) continue` を検証:
		//   - amount='NaN' の trade はスキップ → 保有は変化しない
		//   - price='abc' の trade はスキップ → 保有は変化しない
		// 関数が malformed 入力でクラッシュせず Map を返すことも併せて担保。
		const currentHoldings = [{ asset: 'btc', amount: '0.999' }];
		const trades: RawTrade[] = [
			makeTrade({
				trade_id: 1,
				executed_at: 2000,
				side: 'buy',
				amount: 'NaN', // qty=NaN → スキップ
				price: '10000000',
				fee_amount_base: '0.001',
			}),
			makeTrade({
				trade_id: 2,
				executed_at: 3000,
				side: 'buy',
				amount: '0.5',
				price: 'abc', // price=NaN → スキップ
				fee_amount_base: '0',
			}),
		];
		const result = reconstructHoldingsAtDate(currentHoldings, trades, 1000, null);
		expect(result.get('btc')).toBe(0.999);
		expect(result.has('jpy')).toBe(false);
	});
});

// ── 信用 PnL 集計 ──

/** 必須フィールドを既定値で埋めた RawMarginTrade を生成する */
function makeMarginTrade(overrides: Partial<RawMarginTrade> = {}): RawMarginTrade {
	return {
		trade_id: 1,
		pair: 'btc_jpy',
		order_id: 1,
		side: 'buy',
		position_side: 'long',
		type: 'limit',
		amount: '0',
		price: '0',
		maker_taker: 'maker',
		fee_amount_base: '0',
		fee_amount_quote: '0',
		executed_at: 0,
		...overrides,
	};
}

describe('calcMarginPnl', () => {
	it('決済約定のみカウントし、建玉約定（profit_loss なし）はスキップ', () => {
		// 決済 2 件（profit_loss あり）+ 建玉 1 件（profit_loss なし）
		const trades: RawMarginTrade[] = [
			makeMarginTrade({ trade_id: 1, side: 'buy', amount: '0.01', price: '15000000' }), // 建玉
			makeMarginTrade({ trade_id: 2, side: 'sell', amount: '0.01', price: '15500000', profit_loss: '5000' }), // 決済
			makeMarginTrade({ trade_id: 3, side: 'sell', amount: '0.01', price: '15800000', profit_loss: '8000' }), // 決済
		];
		const result = calcMarginPnl(trades);
		expect(result.close_trade_count).toBe(2);
		expect(result.margin_realized_pnl).toBe(13_000);
	});

	it('利息を加算する（profit_loss なしでも interest があれば合算）', () => {
		const trades: RawMarginTrade[] = [
			makeMarginTrade({ trade_id: 1, profit_loss: '5000', interest: '100' }),
			makeMarginTrade({ trade_id: 2, profit_loss: '3000', interest: '200' }),
			makeMarginTrade({ trade_id: 3, profit_loss: '1000' }), // interest なし
		];
		const result = calcMarginPnl(trades);
		expect(result.margin_interest).toBe(300);
	});

	it('損失（負の profit_loss）を正しく集計する', () => {
		const trades: RawMarginTrade[] = [
			makeMarginTrade({ trade_id: 1, profit_loss: '500' }),
			makeMarginTrade({ trade_id: 2, profit_loss: '-300' }),
		];
		const result = calcMarginPnl(trades);
		expect(result.margin_realized_pnl).toBe(200);
		expect(result.close_trade_count).toBe(2);
	});

	it('空配列で 0 / 0 / 0 を返す', () => {
		const result = calcMarginPnl([]);
		expect(result.margin_realized_pnl).toBe(0);
		expect(result.margin_interest).toBe(0);
		expect(result.close_trade_count).toBe(0);
	});

	it('NaN / 不正な profit_loss / interest はスキップする', () => {
		const trades: RawMarginTrade[] = [
			makeMarginTrade({ trade_id: 1, profit_loss: '1000', interest: '50' }),
			makeMarginTrade({ trade_id: 2, profit_loss: 'NaN', interest: 'abc' }),
		];
		const result = calcMarginPnl(trades);
		expect(result.margin_realized_pnl).toBe(1000);
		expect(result.margin_interest).toBe(50);
		expect(result.close_trade_count).toBe(1);
	});
});

describe('calcPeriodMarginPnl', () => {
	it('sinceMs 以降の約定のみを集計する', () => {
		// 期間外 (t=500) + 期間内 (t=1500, t=2000)
		const trades: RawMarginTrade[] = [
			makeMarginTrade({ trade_id: 1, executed_at: 500, profit_loss: '999', interest: '10' }), // 除外
			makeMarginTrade({ trade_id: 2, executed_at: 1500, profit_loss: '5000', interest: '100' }),
			makeMarginTrade({ trade_id: 3, executed_at: 2000, profit_loss: '3000', interest: '50' }),
		];
		const result = calcPeriodMarginPnl(trades, 1000, '2024-01-01T00:00:00+09:00', '2024-12-31T23:59:59+09:00');
		expect(result.margin_realized_pnl).toBe(8000);
		expect(result.margin_interest).toBe(150);
		expect(result.close_trade_count).toBe(2);
		expect(result.period_start).toBe('2024-01-01T00:00:00+09:00');
		expect(result.period_end).toBe('2024-12-31T23:59:59+09:00');
	});
});

describe('buildAccountPnl', () => {
	it('total = spot + margin - interest を返す', () => {
		const result = buildAccountPnl(1000, { margin_realized_pnl: 500, margin_interest: 100 });
		expect(result.spot_realized_pnl).toBe(1000);
		expect(result.margin_realized_pnl).toBe(500);
		expect(result.margin_interest).toBe(100);
		expect(result.total).toBe(1400); // 1000 + 500 - 100
	});

	it('信用約定なし（margin=0, interest=0）のとき total === spot_realized_pnl', () => {
		const result = buildAccountPnl(1234, { margin_realized_pnl: 0, margin_interest: 0 });
		expect(result.spot_realized_pnl).toBe(1234);
		expect(result.margin_realized_pnl).toBe(0);
		expect(result.margin_interest).toBe(0);
		expect(result.total).toBe(1234);
	});
});

describe('calcDepositWithdrawalSummary', () => {
	function makeDwData(overrides: Partial<DepositWithdrawalData> = {}): DepositWithdrawalData {
		return {
			deposits: [],
			withdrawals: [],
			warnings: [],
			allFailed: false,
			isComplete: true,
			...overrides,
		};
	}

	it('年初前入金で形成された現在保有: 純投入額には年初前入金も含まれる', () => {
		// 年初前に 1_000_000 JPY 入金 + 年初後に 500_000 JPY 入金 → 純投入 1_500_000
		// 現在総資産 2_000_000 → account_return = 2_000_000 - 1_500_000 = 500_000 (+33.33%)
		const dw = makeDwData({
			deposits: [
				makeDeposit({ uuid: 'd1', amount: '1000000', confirmed_at: 100 }),
				makeDeposit({ uuid: 'd2', amount: '500000', confirmed_at: 2000 }),
			],
		});
		const result = calcDepositWithdrawalSummary(dw, 2_000_000, new Map());
		expect(result.total_jpy_deposited).toBe(1_500_000);
		expect(result.total_jpy_withdrawn).toBe(0);
		expect(result.net_jpy_invested).toBe(1_500_000);
		expect(result.account_return_jpy).toBe(500_000);
		expect(result.account_return_pct).toBeCloseTo(33.33, 1);
	});

	it('入金のみで net_jpy_invested <= 0 のとき account_return_* は undefined', () => {
		const dw = makeDwData(); // 入出金なし
		const result = calcDepositWithdrawalSummary(dw, 1_000_000, new Map());
		expect(result.net_jpy_invested).toBe(0);
		expect(result.account_return_jpy).toBeUndefined();
		expect(result.account_return_pct).toBeUndefined();
	});

	it('暗号資産入庫が現在価格で仮評価され net_jpy_invested に加算される', () => {
		// JPY 入金 1_000_000 + BTC 0.1 入庫（現在価格 15_000_000）= 1_000_000 + 1_500_000 = 2_500_000
		const dw = makeDwData({
			deposits: [
				makeDeposit({ uuid: 'd1', amount: '1000000', confirmed_at: 100 }),
				makeDeposit({ uuid: 'd2', asset: 'btc', amount: '0.1', confirmed_at: 200 }),
			],
		});
		const prices = new Map([['btc', 15_000_000]]);
		const result = calcDepositWithdrawalSummary(dw, 3_000_000, prices);
		expect(result.crypto_deposit_count).toBe(1);
		expect(result.crypto_deposit_estimated_jpy).toBe(1_500_000);
		expect(result.net_jpy_invested).toBe(2_500_000);
		expect(result.account_return_jpy).toBe(500_000);
	});

	it('DONE 以外の入出金は集計対象外（FOUND/CONFIRMED は未完了）', () => {
		const dw = makeDwData({
			deposits: [
				makeDeposit({ uuid: 'd1', amount: '1000000', status: 'FOUND', confirmed_at: 100 }),
				makeDeposit({ uuid: 'd2', amount: '500000', status: 'CONFIRMED', confirmed_at: 200 }),
			],
		});
		const result = calcDepositWithdrawalSummary(dw, 1_000_000, new Map());
		expect(result.total_jpy_deposited).toBe(0);
		expect(result.net_jpy_invested).toBe(0);
	});
});
