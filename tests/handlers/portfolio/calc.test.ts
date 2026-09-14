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
 *   - 保有復元では売り側 fee_amount_base も巻き戻されること（API 仕様上ゼロだが防御的に対称化）
 *   - fee_amount_base = 0 のときは旧挙動と等価であること
 * を、calcPnl / calcPeriodRealizedPnl / reconstructHoldingsAtDate の 3 関数で検証する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../../lib/datetime.js';
import {
	buildAccountPnl,
	buildEquitySeries,
	buildPeriodAccountPnl,
	buildPeriodPerformance,
	calcDepositWithdrawalSummary,
	calcMarginPnl,
	calcPeriodDWSummary,
	calcPeriodMarginPnl,
	calcPeriodNetFlow,
	calcPeriodRealizedPnl,
	calcPnl,
	collectFlowValuationTargets,
	depositOnlyAssets,
	dominantUnresolvedDepositReason,
	flowUnavailableReasonFor,
	getJstPeriodBoundaries,
	PERFORMANCE_NOTE,
	PERFORMANCE_NOTE_CHANGE_DIRECTION_UNKNOWN,
	PERFORMANCE_NOTE_CHANGE_OVERSTATED,
	PERFORMANCE_NOTE_CHANGE_UNDERSTATED,
	type PortfolioPerformanceContext,
	qtyInvariantHolds,
	qtyInvariantTolerance,
	qtyMismatchReasonFor,
	reconstructHoldingsAtDate,
	resolveDepositWithdrawalStatus,
	resolveFlowPrice,
	summarizeFlowValuation,
	unresolvedDepositReasonsByAsset,
} from '../../../src/handlers/portfolio/calc.js';
import { PORTFOLIO_CALENDAR_TZ, portfolioDayStartMs } from '../../../src/handlers/portfolio/calendar.js';
import type {
	CandlePriceData,
	DepositWithdrawalData,
	FlowValuationTarget,
	RawDeposit,
	RawMarginTrade,
	RawTrade,
	RawWithdrawal,
} from '../../../src/handlers/portfolio/types.js';
import { currentPriceOnly, withDailyPrices } from '../../_flowPricing.js';

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

	it('売り側 fee_amount_base > 0 でも数量・原価が対称に減る（reconstructed_qty の誤検知防止）', () => {
		// 売りの feeBase は API 仕様上ゼロだが、防御方針（冒頭コメント）どおり非ゼロでも
		// 口座から減る base 量 = qty + feeBase として扱う。reconstructHoldingsAtDate の
		// 巻き戻し（qty + feeBase を加算）と対称でないと、reconstructed_qty が実残高より
		// feeBase ぶん過大になり数量不変条件が誤検知する。
		// 買い 1 BTC @ 10_000_000 → 売り 0.5 BTC @ 12_000_000、fee_base=0.002、fee_quote=3000
		//   disposed  = 0.502、sellCost = 0.502 * 10_000_000 = 5_020_000
		//   sellRev   = 0.5 * 12_000_000 - 3_000 = 5_997_000
		//   realized  = 977_000、残 qty = 0.498、残 cost = 4_980_000（avg は 10_000_000 のまま）
		const trades: RawTrade[] = [
			makeTrade({ trade_id: 1, executed_at: 1, side: 'buy', amount: '1', price: '10000000' }),
			makeTrade({
				trade_id: 2,
				executed_at: 2,
				side: 'sell',
				amount: '0.5',
				price: '12000000',
				fee_amount_base: '0.002',
				fee_amount_quote: '3000',
			}),
		];
		const result = calcPnl(trades, 'btc');
		expect(result.realized_pnl).toBe(977_000);
		expect(result.reconstructed_qty).toBeCloseTo(0.498, 9);
		expect(result.cost_basis).toBeCloseTo(4_980_000, 6);
		expect(result.avg_buy_price).toBeCloseTo(10_000_000, 4);
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
		// 買 1 → 出庫 0.301 → 売 0.5 の残数量
		expect(result.reconstructed_qty).toBeCloseTo(0.199, 9);
	});

	it('約定・出庫なし（空配列）で reconstructed_qty は 0', () => {
		const result = calcPnl([], 'btc');
		expect(result.reconstructed_qty).toBe(0);
	});

	it('分割売却の浮動小数点残差はダストリセットで reconstructed_qty=0 になる', () => {
		// 0.3 を 0.1 × 3 で売り切ると二進小数の残差（≈5e-17）が残るが、
		// 1e-12 未満のリセットロジック（calc.ts）で正確に 0 へ畳まれる。
		const trades: RawTrade[] = [
			makeTrade({ trade_id: 1, executed_at: 1, side: 'buy', amount: '0.3', price: '10000000' }),
			makeTrade({ trade_id: 2, executed_at: 2, side: 'sell', amount: '0.1', price: '10000000' }),
			makeTrade({ trade_id: 3, executed_at: 3, side: 'sell', amount: '0.1', price: '10000000' }),
			makeTrade({ trade_id: 4, executed_at: 4, side: 'sell', amount: '0.1', price: '10000000' }),
		];
		const result = calcPnl(trades, 'btc');
		expect(result.reconstructed_qty).toBe(0);
		expect(result.cost_basis).toBeUndefined();
	});
});

// ── 数量不変条件（復元数量 vs 実残高） ──

describe('qtyInvariantTolerance / qtyInvariantHolds', () => {
	it('絶対項: 実残高が小さいときは最小数量単位 × 5 が下限になる', () => {
		// onhand 0.00001（相対項 1e-8）< 絶対項 5e-8（precision 8）
		expect(qtyInvariantTolerance(0.00001, 8)).toBe(5e-8);
	});

	it('相対項: 実残高 × 0.1% が絶対項を上回るときはそちらを使う', () => {
		expect(qtyInvariantTolerance(10, 8)).toBeCloseTo(0.01, 12);
	});

	it('境界: 乖離がちょうど許容誤差なら成立、わずかに超えると破れる', () => {
		// precision 0 → 絶対項 5 が支配的（相対項 1000 × 0.1% = 1）。整数で境界を厳密に見る
		expect(qtyInvariantHolds(1000, 995, 0)).toBe(true); // 乖離 5 = 許容誤差
		expect(qtyInvariantHolds(1000, 994.9, 0)).toBe(false); // 乖離 5.1 > 許容誤差
	});

	it('amount_precision の違いで同じ乖離の判定が変わる', () => {
		// 乖離 4e-6: precision 6 の許容誤差 5e-6 には収まり、precision 8 の 5e-8 には収まらない
		expect(qtyInvariantHolds(0.000004, 0, 6)).toBe(true);
		expect(qtyInvariantHolds(0.000004, 0, 8)).toBe(false);
	});

	it('ダスト保有: 復元数量 0 でも最小単位数カウント以内なら成立', () => {
		expect(qtyInvariantHolds(0.00000004, 0, 8)).toBe(true); // 4e-8 ≤ 5e-8
	});

	it('一致（乖離 0）は常に成立', () => {
		expect(qtyInvariantHolds(0.6, 0.6, 8)).toBe(true);
	});
});

/**
 * #57 (b): 暗号資産入庫を「入庫日の始値で取得した」とみなして原価に算入する。
 *
 * (b) より前は入庫が calcPnl のイベントに存在せず、入庫ぶんの保有が**原価ゼロ**で
 * 積まれていた（含み益が過大 / 売却時の実現損益が売却収入そのもの）。
 * ここでは「算入されること」と「算入しない条件」の両方を固定する。
 */
describe('calcPnl — 入庫の原価算入', () => {
	/** 2026-05-16 10:00 JST */
	const DEPOSIT_MS = Date.UTC(2026, 4, 16, 1, 0, 0, 0);
	const SELL_MS = DEPOSIT_MS + 86_400_000;
	/** 入庫日の 1day open。現在価格とは意図的に離す */
	const DEPOSIT_DAY_OPEN = 8_000_000;

	const deposit = makeDeposit({ uuid: 'dep-btc', asset: 'btc', amount: '0.5', confirmed_at: DEPOSIT_MS });

	/** 入庫日の始値を解決できる pricing（現在価格は敢えて大きく離した値を置く） */
	function datedPricing(currentPrice = 20_000_000) {
		return withDailyPrices(
			[{ asset: 'btc', atMs: DEPOSIT_MS, price: DEPOSIT_DAY_OPEN }],
			new Map([['btc', currentPrice]]),
		);
	}

	it('入庫日の始値 × 数量が原価と復元数量に入り、実現損益には計上されない', () => {
		const res = calcPnl([], 'btc', [], { deposits: [deposit], pricing: datedPricing() });
		expect(res.reconstructed_qty).toBeCloseTo(0.5, 12);
		expect(res.cost_basis).toBeCloseTo(4_000_000, 6);
		expect(res.avg_buy_price).toBeCloseTo(DEPOSIT_DAY_OPEN, 6);
		expect(res.realized_pnl).toBe(0);
		expect(res.priced_deposit_count).toBe(1);
		expect(res.unpriced_deposit_count).toBe(0);
	});

	it('入庫 → 売却の順で realized_pnl が入庫日原価ベースになる', () => {
		const trades = [makeTrade({ side: 'sell', amount: '0.5', price: '10000000', executed_at: SELL_MS })];
		const res = calcPnl(trades, 'btc', [], { deposits: [deposit], pricing: datedPricing() });
		// 売却収入 5,000,000 − 入庫日原価 4,000,000
		expect(res.realized_pnl).toBe(1_000_000);
		expect(res.reconstructed_qty).toBe(0);
	});

	it('回帰の逆側: 入庫を渡さないと同じ売却が原価ゼロ扱いで実現損益を過大に出す', () => {
		const trades = [makeTrade({ side: 'sell', amount: '0.5', price: '10000000', executed_at: SELL_MS })];
		const res = calcPnl(trades, 'btc', []);
		expect(res.realized_pnl).toBe(5_000_000);
		expect(res.priced_deposit_count).toBe(0);
		expect(res.unpriced_deposit_count).toBe(0);
	});

	/** 本 issue の眼目。現在価格を 2 倍に振っても原価が 1 円も動かないこと。 */
	it('現在価格が動いても原価は動かない（入庫日の始値で固定）', () => {
		const low = calcPnl([], 'btc', [], { deposits: [deposit], pricing: datedPricing(20_000_000) });
		const high = calcPnl([], 'btc', [], { deposits: [deposit], pricing: datedPricing(40_000_000) });
		expect(high.cost_basis).toBe(low.cost_basis);
		expect(high.avg_buy_price).toBe(low.avg_buy_price);
	});

	/**
	 * 現在価格フォールバックを原価に使わない理由: 使うとその入庫ぶんの評価損益が常に
	 * ゼロ付近に貼り付き、誤差が相場と連動して動く（#53 の機序 6 を cost_basis 側に持ち込む）。
	 * 算入しない代わりに件数を申告し、数量不変条件の理由コードに載せる。
	 */
	it('入庫日の始値を解決できない入庫は算入せず unpriced_deposit_count で申告する', () => {
		const res = calcPnl([], 'btc', [], {
			deposits: [deposit],
			pricing: currentPriceOnly(new Map([['btc', 20_000_000]])),
		});
		expect(res.reconstructed_qty).toBe(0);
		expect(res.cost_basis).toBeUndefined();
		expect(res.avg_buy_price).toBeUndefined();
		expect(res.priced_deposit_count).toBe(0);
		expect(res.unpriced_deposit_count).toBe(1);
	});

	it('他銘柄の入庫は件数にも原価にも入らない', () => {
		const other = makeDeposit({ uuid: 'dep-eth', asset: 'eth', amount: '3', confirmed_at: DEPOSIT_MS });
		const res = calcPnl([], 'btc', [], { deposits: [other], pricing: datedPricing() });
		expect(res.reconstructed_qty).toBe(0);
		expect(res.priced_deposit_count).toBe(0);
		expect(res.unpriced_deposit_count).toBe(0);
	});

	it('DONE 以外の入庫は無視する（未確定を原価にしない）', () => {
		const pending = makeDeposit({ ...deposit, uuid: 'dep-pending', status: 'CONFIRMED' });
		const res = calcPnl([], 'btc', [], { deposits: [pending], pricing: datedPricing() });
		expect(res.reconstructed_qty).toBe(0);
		expect(res.priced_deposit_count).toBe(0);
		expect(res.unpriced_deposit_count).toBe(0);
	});

	it('数量ゼロ・数値不正の DONE 入庫は算入せず未算入として数える（乖離の証拠を残す）', () => {
		const zero = makeDeposit({ ...deposit, uuid: 'dep-zero', amount: '0' });
		const nan = makeDeposit({ ...deposit, uuid: 'dep-nan', amount: 'n/a' });
		const res = calcPnl([], 'btc', [], { deposits: [zero, nan], pricing: datedPricing() });
		expect(res.reconstructed_qty).toBe(0);
		expect(res.priced_deposit_count).toBe(0);
		expect(res.unpriced_deposit_count).toBe(2);
	});

	it('入庫 → 出庫の順で、出庫が入庫日原価を按分減少させる', () => {
		const withdrawals = [
			makeWithdrawal({ asset: 'btc', amount: '0.2', fee: '0.01', status: 'DONE', requested_at: SELL_MS }),
		];
		const res = calcPnl([], 'btc', withdrawals, { deposits: [deposit], pricing: datedPricing() });
		// 0.5 − (0.2 + 0.01) = 0.29 が残り、平均単価は入庫日始値のまま
		expect(res.reconstructed_qty).toBeCloseTo(0.29, 12);
		expect(res.cost_basis).toBeCloseTo(0.29 * DEPOSIT_DAY_OPEN, 6);
		expect(res.realized_pnl).toBe(0);
	});

	it('入庫より前の売却には入庫の原価が乗らない（時系列順で処理する）', () => {
		const trades = [makeTrade({ side: 'sell', amount: '0.1', price: '10000000', executed_at: DEPOSIT_MS - 1000 })];
		const res = calcPnl(trades, 'btc', [], { deposits: [deposit], pricing: datedPricing() });
		// 売却時点で保有ゼロ → 収入がそのまま実現損益。入庫はその後に原価として積まれる
		expect(res.realized_pnl).toBe(1_000_000);
		// #89: 数量は代数和なので売却分を必ず引く（0.5 ではなく 0.4）。旧実装は保有ゼロでの売りを
		// 数量から引かず 0.5 を返しており、その 0.1 は「API に現れない取得があった」証拠だったのに
		// 復元数量が実残高側へ押し戻されて乖離が消えていた。原価側は従来どおり（cost_basis は不変）
		expect(res.reconstructed_qty).toBeCloseTo(0.4, 12);
		expect(res.cost_basis).toBeCloseTo(4_000_000, 6);
		expect(res.qty_clamp_count).toBe(1);
		expect(res.qty_clamp_absorbed_qty).toBeCloseTo(0.1, 12);
	});
});

/**
 * #89 の回帰: 実口座データの完全リプレイで確定した機序を最小フィクスチャで再現する。
 *
 * 実データ: 販売所の買い（API に現れない取得）が 0.00041693 BTC 欠けた口座で、
 * 売り 2 回がそれぞれリプレイ上の保有を超え、クランプが発火（吸収 0.0003 + 0.0001 = 0.0004）。
 * 旧実装（数量もクランプ）は復元数量を実残高側へ 0.0004 押し戻し、乖離が 0.00041693 →
 * 0.00001693（許容誤差 0.1% 未満）に圧縮されて cost_basis_reliable=true を素通りしていた。
 *
 * 本テストの数量はその実データの構造をそのまま使う（buy 0.0003 → sell 0.0006 → buy 0.0014 →
 * sell 0.0015 → buy 0.1073、価格は全イベント同一で固定）。手数料は 0 にして数量の挙動だけを見る
 * （手数料込みの対称性は冒頭の fee_amount_base 系テストで別途固定済み）。
 */
describe('calcPnl — 数量の代数和追跡とクランプ申告（#89）', () => {
	const trades: RawTrade[] = [
		makeTrade({ trade_id: 1, executed_at: 1, side: 'buy', amount: '0.0003', price: '10000000' }),
		// 保有 0.0003 を超える売り → クランプ発火（吸収 0.0003）
		makeTrade({ trade_id: 2, executed_at: 2, side: 'sell', amount: '0.0006', price: '10000000' }),
		makeTrade({ trade_id: 3, executed_at: 3, side: 'buy', amount: '0.0014', price: '10000000' }),
		// 保有 0.0014 を超える売り → クランプ発火（吸収 0.0001）
		makeTrade({ trade_id: 4, executed_at: 4, side: 'sell', amount: '0.0015', price: '10000000' }),
		makeTrade({ trade_id: 5, executed_at: 5, side: 'buy', amount: '0.1073', price: '10000000' }),
	];

	it('reconstructed_qty は代数和（0.1069）で、クランプありの旧値 0.1073 より小さい', () => {
		const res = calcPnl(trades, 'btc');
		// 0.0003 - 0.0006 + 0.0014 - 0.0015 + 0.1073 = 0.1069
		expect(res.reconstructed_qty).toBeCloseTo(0.1069, 9);
	});

	it('クランプは 2 回発火し、吸収量の合計 0.0004 が旧値との差と一致する', () => {
		const res = calcPnl(trades, 'btc');
		expect(res.qty_clamp_count).toBe(2);
		expect(res.qty_clamp_absorbed_qty).toBeCloseTo(0.0004, 9);
		// 0.1073（クランプありなら得られていたはずの数量）− 0.1069（代数和） = 吸収合計
		expect(0.1073 - res.reconstructed_qty).toBeCloseTo(res.qty_clamp_absorbed_qty, 9);
	});

	it('realized_pnl は原価側クランプ（保有分のみ按分）が従来どおり効くので変わらない', () => {
		// sell1: coveredQty=min(0.0006,0.0003)=0.0003 → sellCost=3,000, sellRevenue=6,000 → +3,000
		// sell2: coveredQty=min(0.0015,0.0014)=0.0014 → sellCost=14,000, sellRevenue=15,000 → +1,000
		const res = calcPnl(trades, 'btc');
		expect(res.realized_pnl).toBe(4_000);
		// 最後の買いだけが原価に残る（直前の 2 回の売りでそれぞれダストリセットされている）
		expect(res.cost_basis).toBeCloseTo(1_073_000, 6);
		expect(res.avg_buy_price).toBeCloseTo(10_000_000, 6);
	});

	it('通常の売買のみ（保有内に収まる売り）ではクランプは発火しない', () => {
		const normalTrades: RawTrade[] = [
			makeTrade({ trade_id: 1, executed_at: 1, side: 'buy', amount: '1', price: '10000000' }),
			makeTrade({ trade_id: 2, executed_at: 2, side: 'sell', amount: '0.5', price: '11000000' }),
		];
		const res = calcPnl(normalTrades, 'btc');
		expect(res.qty_clamp_count).toBe(0);
		expect(res.qty_clamp_absorbed_qty).toBe(0);
		expect(res.reconstructed_qty).toBeCloseTo(0.5, 12);
	});

	it('保有ゼロ状態での売り（空売り）もクランプ発火として数える', () => {
		const res = calcPnl([makeTrade({ side: 'sell', amount: '0.001', price: '10000000' })], 'btc');
		expect(res.qty_clamp_count).toBe(1);
		expect(res.qty_clamp_absorbed_qty).toBeCloseTo(0.001, 12);
		expect(res.reconstructed_qty).toBeCloseTo(-0.001, 12);
	});

	it('ダストリセットは代数和の負値を握り潰さない（原価のリセットと数量のリセットは別条件）', () => {
		// 買い 0.1 → 売り 0.1 + 0.0000000000005（1e-12 未満の超過）: 原価側はダストで 0 にリセット
		// されるが、代数和はその超過分ぶん厳密に負へ振れる（絶対値は 1e-12 未満なので
		// normalizeQtyDust で 0 に畳まれる——これはダストの丸めであって「保有を超えた事実の隠蔽」ではない）
		const res = calcPnl(
			[
				makeTrade({ trade_id: 1, executed_at: 1, side: 'buy', amount: '0.1', price: '10000000' }),
				makeTrade({ trade_id: 2, executed_at: 2, side: 'sell', amount: '0.1000000000005', price: '10000000' }),
			],
			'btc',
		);
		expect(res.reconstructed_qty).toBe(0);
		expect(res.cost_basis).toBeUndefined();
		// 誤差レベル（1e-12 未満）の超過はクランプ発火として数えない（ダストと区別できないため）
		expect(res.qty_clamp_count).toBe(0);
	});
});

describe('calcPeriodRealizedPnl — 入庫の原価算入', () => {
	const DEPOSIT_MS = Date.UTC(2026, 4, 16, 1, 0, 0, 0);
	const SINCE_MS = DEPOSIT_MS + 86_400_000;
	const SELL_MS = SINCE_MS + 3_600_000;
	const DEPOSIT_DAY_OPEN = 8_000_000;

	const deposit = makeDeposit({ uuid: 'dep-btc', asset: 'btc', amount: '0.5', confirmed_at: DEPOSIT_MS });
	const pricing = withDailyPrices(
		[{ asset: 'btc', atMs: DEPOSIT_MS, price: DEPOSIT_DAY_OPEN }],
		new Map([['btc', 20_000_000]]),
	);
	const sell = [makeTrade({ side: 'sell', amount: '0.5', price: '10000000', executed_at: SELL_MS })];

	it('期間開始前の入庫も avg_cost に積み上がり、期間内の売却が入庫日原価ベースになる', () => {
		const res = calcPeriodRealizedPnl(sell, SINCE_MS, 'start', 'end', [], { deposits: [deposit], pricing });
		expect(res.realized_pnl).toBe(1_000_000);
		expect(res.sell_count).toBe(1);
	});

	/**
	 * depositCost を渡し忘れると入庫ぶんが原価ゼロで売られ、同じ売却の実現損益が
	 * calcPnl と食い違う（期間集計だけ過大になる）。その差を固定しておく。
	 */
	it('depositCost を渡さないと同じ売却が原価ゼロ扱いになり calcPnl と食い違う', () => {
		const withDeposit = calcPnl(sell, 'btc', [], { deposits: [deposit], pricing });
		const without = calcPeriodRealizedPnl(sell, SINCE_MS, 'start', 'end', []);
		expect(without.realized_pnl).toBe(5_000_000);
		expect(without.realized_pnl).not.toBe(withDeposit.realized_pnl);
	});

	/**
	 * 期間実現損益にも「何件の入庫を原価から除外したか」の申告が要る（#77）。
	 * 件数は全履歴・全銘柄——移動平均法は期間開始前の入庫も原価に積むため、
	 * `realized_pnl` の算出条件は期間内のイベントだけでは決まらない。
	 */
	it('算入した入庫・算入できなかった入庫の件数を返す', () => {
		const unpriced = makeDeposit({ uuid: 'dep-eth', asset: 'eth', amount: '3', confirmed_at: DEPOSIT_MS });
		const res = calcPeriodRealizedPnl(sell, SINCE_MS, 'start', 'end', [], {
			deposits: [deposit, unpriced],
			pricing,
		});
		// btc は入庫日の始値を持つので算入、eth は日次価格が無いので未算入
		expect(res.priced_deposit_count_all_time).toBe(1);
		expect(res.unpriced_deposit_count_all_time).toBe(1);
	});

	it('全件を算入できれば未算入件数はゼロ', () => {
		const res = calcPeriodRealizedPnl(sell, SINCE_MS, 'start', 'end', [], { deposits: [deposit], pricing });
		expect(res.priced_deposit_count_all_time).toBe(1);
		expect(res.unpriced_deposit_count_all_time).toBe(0);
	});

	it('入庫ゼロ・depositCost 未指定では両件数ともゼロ', () => {
		expect(calcPeriodRealizedPnl(sell, SINCE_MS, 'start', 'end', [])).toMatchObject({
			priced_deposit_count_all_time: 0,
			unpriced_deposit_count_all_time: 0,
		});
		expect(calcPeriodRealizedPnl(sell, SINCE_MS, 'start', 'end', [], { deposits: [], pricing })).toMatchObject({
			priced_deposit_count_all_time: 0,
			unpriced_deposit_count_all_time: 0,
		});
	});

	it('複数銘柄の未算入入庫は合算する（銘柄で絞らない）', () => {
		const unpricedEth = makeDeposit({ uuid: 'dep-eth', asset: 'eth', amount: '3', confirmed_at: DEPOSIT_MS });
		const unpricedXrp = makeDeposit({ uuid: 'dep-xrp', asset: 'xrp', amount: '100', confirmed_at: DEPOSIT_MS });
		const res = calcPeriodRealizedPnl(sell, SINCE_MS, 'start', 'end', [], {
			deposits: [unpricedEth, unpricedXrp],
			pricing,
		});
		expect(res.priced_deposit_count_all_time).toBe(0);
		expect(res.unpriced_deposit_count_all_time).toBe(2);
	});
});

describe('unresolvedDepositReasonsByAsset / dominantUnresolvedDepositReason（#80）', () => {
	it('取りこぼした銘柄だけに理由コードが付く（0 件の銘柄は載らない）', () => {
		const reasons = unresolvedDepositReasonsByAsset(new Map([['btc', 2]]), new Map([['eth', 1]]));
		expect(reasons.get('btc')).toBe('deposit_price_chunk_truncated');
		expect(reasons.get('eth')).toBe('deposit_price_fetch_failed');
		expect(reasons.size).toBe(2);
	});

	it('件数 0 の銘柄は抑止対象にしない', () => {
		expect(unresolvedDepositReasonsByAsset(new Map([['btc', 0]]), new Map([['eth', 0]])).size).toBe(0);
	});

	it('同じ銘柄が両方に載ったら取得失敗を採る（再現性が無い方が重い）', () => {
		const reasons = unresolvedDepositReasonsByAsset(new Map([['eth', 1]]), new Map([['eth', 1]]));
		expect(reasons.get('eth')).toBe('deposit_price_fetch_failed');
	});

	it('入力が空なら空（取りこぼしゼロで抑止も起きない）', () => {
		expect(unresolvedDepositReasonsByAsset(new Map(), new Map()).size).toBe(0);
	});

	it('合計値の理由は取得失敗が 1 銘柄でもあればそれを採る', () => {
		expect(dominantUnresolvedDepositReason([])).toBeUndefined();
		expect(dominantUnresolvedDepositReason(['deposit_price_chunk_truncated'])).toBe('deposit_price_chunk_truncated');
		expect(dominantUnresolvedDepositReason(['deposit_price_chunk_truncated', 'deposit_price_fetch_failed'])).toBe(
			'deposit_price_fetch_failed',
		);
		// 並び順に依存しない
		expect(dominantUnresolvedDepositReason(['deposit_price_fetch_failed', 'deposit_price_chunk_truncated'])).toBe(
			'deposit_price_fetch_failed',
		);
	});
});

describe('qtyMismatchReasonFor', () => {
	function makeDw(overrides: Partial<DepositWithdrawalData> = {}): DepositWithdrawalData {
		return { deposits: [], withdrawals: [], warnings: [], allFailed: false, isComplete: true, ...overrides };
	}

	it('原価に算入できなかった入庫がある → has_crypto_deposits', () => {
		expect(qtyMismatchReasonFor(makeDw(), false, 1, 0)).toBe('has_crypto_deposits');
	});

	it('入庫件数が複数でも単一の has_crypto_deposits', () => {
		expect(qtyMismatchReasonFor(makeDw(), false, 2, 0)).toBe('has_crypto_deposits');
	});

	/**
	 * (b) の要点。入庫日の始値で原価に算入できた入庫は数量にも入っているので、
	 * もはや乖離の説明にならない。dw.deposits に DONE 入庫が残っていても
	 * has_crypto_deposits を立ててはいけない（立てると「入庫のせい」で
	 * 打ち切り由来の乖離を取り違え、原価が出せない理由を誤って説明する）。
	 */
	it('入庫があっても全件を原価に算入できていれば has_crypto_deposits にならない', () => {
		const dw = makeDw({ deposits: [makeDeposit({ uuid: 'd1', asset: 'eth', amount: '1' })] });
		expect(qtyMismatchReasonFor(dw, false, 0, 0)).toBe('untracked_trade_suspected');
		expect(qtyMismatchReasonFor(dw, true, 0, 0)).toBe('history_truncated');
	});

	it('約定履歴の打ち切り → history_truncated（dw null でも同様）', () => {
		expect(qtyMismatchReasonFor(makeDw(), true, 0, 0)).toBe('history_truncated');
		expect(qtyMismatchReasonFor(null, true, 0, 0)).toBe('history_truncated');
	});

	it('入出金履歴の打ち切り（isComplete=false）→ history_truncated', () => {
		expect(qtyMismatchReasonFor(makeDw({ isComplete: false }), false, 0, 0)).toBe('history_truncated');
	});

	it('未算入の入庫は打ち切りより優先される（銘柄固有の証拠を採る）', () => {
		expect(qtyMismatchReasonFor(makeDw({ isComplete: false }), true, 1, 0)).toBe('has_crypto_deposits');
	});

	it('手掛かりなし（dw null / 空履歴、復元数量は非負）→ untracked_trade_suspected（#93。旧 unknown を置き換えた）', () => {
		expect(qtyMismatchReasonFor(null, false, 0, 0)).toBe('untracked_trade_suspected');
		expect(qtyMismatchReasonFor(makeDw(), false, 0, 0)).toBe('untracked_trade_suspected');
	});

	/**
	 * #89: 代数和が負になることは、API に現れない取得（販売所での買い等）があったことの
	 * 直接証拠。他に手掛かりが無ければこれを理由コードにする。
	 */
	it('復元数量が負 → reconstructed_qty_negative', () => {
		expect(qtyMismatchReasonFor(makeDw(), false, 0, -0.0004)).toBe('reconstructed_qty_negative');
		expect(qtyMismatchReasonFor(null, false, 0, -1e-9)).toBe('reconstructed_qty_negative');
	});

	it('復元数量が負でも、より具体的な理由（入庫・打ち切り）が優先される', () => {
		expect(qtyMismatchReasonFor(makeDw(), false, 1, -0.0004)).toBe('has_crypto_deposits');
		expect(qtyMismatchReasonFor(makeDw(), true, 0, -0.0004)).toBe('history_truncated');
		expect(qtyMismatchReasonFor(makeDw({ isComplete: false }), false, 0, -0.0004)).toBe('history_truncated');
	});
});

/**
 * 入庫はあるが約定履歴にも現在残高にも現れない銘柄の検出（issue #93 仕様 1）。
 *
 * 約定を起点にするループ（closed_positions の集計）も残高を起点にするループ（holdings）も、
 * 「約定・残高のどちらにも現れない」銘柄は対象にしない。入出金履歴（DONE の暗号資産入庫）を
 * 別経路の入力にすることで、この穴を埋める。
 */
describe('depositOnlyAssets', () => {
	function makeDw(overrides: Partial<DepositWithdrawalData> = {}): DepositWithdrawalData {
		return { deposits: [], withdrawals: [], warnings: [], allFailed: false, isComplete: true, ...overrides };
	}

	it('空配列: 入庫が無ければ検出しない', () => {
		expect(depositOnlyAssets(makeDw(), new Set(), new Set())).toEqual([]);
	});

	it('dw が null なら検出しない', () => {
		expect(depositOnlyAssets(null, new Set(), new Set())).toEqual([]);
	});

	it('単一要素: 入庫が 1 件だけで残高・約定のどちらにも無ければ検出する', () => {
		const dw = makeDw({ deposits: [makeDeposit({ uuid: 'd1', asset: 'flr' })] });
		expect(depositOnlyAssets(dw, new Set(), new Set())).toEqual(['flr']);
	});

	it('重複入力: 同一銘柄の入庫が複数件あっても銘柄名は 1 回だけ返す', () => {
		const dw = makeDw({
			deposits: [
				makeDeposit({ uuid: 'd1', asset: 'flr' }),
				makeDeposit({ uuid: 'd2', asset: 'flr' }),
				makeDeposit({ uuid: 'd3', asset: 'flr' }),
			],
		});
		expect(depositOnlyAssets(dw, new Set(), new Set())).toEqual(['flr']);
	});

	it('現在残高がある銘柄は除外する（保有継続中は holdings 側の数量不変条件が担当）', () => {
		const dw = makeDw({ deposits: [makeDeposit({ uuid: 'd1', asset: 'flr' })] });
		expect(depositOnlyAssets(dw, new Set(['flr']), new Set())).toEqual([]);
	});

	it('約定履歴がある銘柄は除外する（売り切りなら closed_positions の実額計算が担当）', () => {
		const dw = makeDw({ deposits: [makeDeposit({ uuid: 'd1', asset: 'flr' })] });
		expect(depositOnlyAssets(dw, new Set(), new Set(['flr']))).toEqual([]);
	});

	it('DONE 以外のステータスは無視する', () => {
		const dw = makeDw({ deposits: [makeDeposit({ uuid: 'd1', asset: 'flr', status: 'CONFIRMED' })] });
		expect(depositOnlyAssets(dw, new Set(), new Set())).toEqual([]);
	});

	it('jpy の入金は対象外（暗号資産の入庫のみが対象）', () => {
		const dw = makeDw({ deposits: [makeDeposit({ uuid: 'd1', asset: 'jpy' })] });
		expect(depositOnlyAssets(dw, new Set(), new Set())).toEqual([]);
	});

	it('複数銘柄を asset 昇順で決定的に返す', () => {
		const dw = makeDw({
			deposits: [
				makeDeposit({ uuid: 'd1', asset: 'oas' }),
				makeDeposit({ uuid: 'd2', asset: 'atom' }),
				makeDeposit({ uuid: 'd3', asset: 'arb' }),
			],
		});
		expect(depositOnlyAssets(dw, new Set(), new Set())).toEqual(['arb', 'atom', 'oas']);
	});

	/**
	 * 出庫だけで残高ゼロが説明できる、販売所と無関係なありふれたケース（他ウォレットへの
	 * 送付など）を誤検知しないための除外（CodeRabbit review, PR #95）。量の多寡は見ない——
	 * 出庫と販売所処分が同一銘柄に混在するケースは見逃す設計（取得漏れを見逃す方向にのみ
	 * 誤り、無い懸念を警告する方向には誤らない）。
	 */
	it('DONE の出庫が 1 件でもある銘柄は除外する（出庫だけで残高ゼロが説明できるため）', () => {
		const dw = makeDw({
			deposits: [makeDeposit({ uuid: 'd1', asset: 'flr' })],
			withdrawals: [makeWithdrawal({ uuid: 'w1', asset: 'flr' })],
		});
		expect(depositOnlyAssets(dw, new Set(), new Set())).toEqual([]);
	});

	it('DONE 以外の出庫は除外条件に数えない', () => {
		const dw = makeDw({
			deposits: [makeDeposit({ uuid: 'd1', asset: 'flr' })],
			withdrawals: [makeWithdrawal({ uuid: 'w1', asset: 'flr', status: 'REQUESTED' })],
		});
		expect(depositOnlyAssets(dw, new Set(), new Set())).toEqual(['flr']);
	});

	it('別銘柄の出庫は対象銘柄を除外しない', () => {
		const dw = makeDw({
			deposits: [makeDeposit({ uuid: 'd1', asset: 'flr' })],
			withdrawals: [makeWithdrawal({ uuid: 'w1', asset: 'oas' })],
		});
		expect(depositOnlyAssets(dw, new Set(), new Set())).toEqual(['flr']);
	});
});

describe('calcPeriodRealizedPnl — 期間内に売却した銘柄（#80）', () => {
	/**
	 * `realized_pnl` は全銘柄を単一タイムラインで合算した値なので、原価が欠けた銘柄が
	 * **その期間に売却しているか**でしか壊れるかどうかを判定できない。抑止範囲を
	 * 必要最小限に絞るための情報なので、期間内の売りだけを拾うことを固定する。
	 */
	it('期間内に売った銘柄だけを返す（期間外の売り・買い・入出庫は含めない）', () => {
		const trades: RawTrade[] = [
			// 期間外の売り（btc）
			makeTrade({ trade_id: 1, executed_at: 100, side: 'buy', amount: '2', price: '10000000' }),
			makeTrade({ trade_id: 2, executed_at: 200, side: 'sell', amount: '1', price: '11000000' }),
			// 期間内の売り（eth）
			makeTrade({ trade_id: 3, pair: 'eth_jpy', executed_at: 300, side: 'buy', amount: '2', price: '400000' }),
			makeTrade({ trade_id: 4, pair: 'eth_jpy', executed_at: 1500, side: 'sell', amount: '1', price: '500000' }),
			// 期間内だが買いだけの銘柄（xrp）
			makeTrade({ trade_id: 5, pair: 'xrp_jpy', executed_at: 1600, side: 'buy', amount: '100', price: '80' }),
		];
		const result = calcPeriodRealizedPnl(trades, 1000, '2024-01-01T00:00:00+09:00', '2024-12-31T23:59:59+09:00');
		expect(result.sold_assets).toEqual(['eth']);
		expect(result.sell_count).toBe(1);
	});

	it('同じ銘柄を期間内に複数回売っても 1 回だけ載る', () => {
		const trades: RawTrade[] = [
			makeTrade({ trade_id: 1, executed_at: 100, side: 'buy', amount: '3', price: '10000000' }),
			makeTrade({ trade_id: 2, executed_at: 1500, side: 'sell', amount: '1', price: '11000000' }),
			makeTrade({ trade_id: 3, executed_at: 1600, side: 'sell', amount: '1', price: '12000000' }),
		];
		const result = calcPeriodRealizedPnl(trades, 1000, '2024-01-01T00:00:00+09:00', '2024-12-31T23:59:59+09:00');
		expect(result.sold_assets).toEqual(['btc']);
		expect(result.sell_count).toBe(2);
	});

	it('約定が 1 件も無ければ空配列', () => {
		const result = calcPeriodRealizedPnl([], 1000, '2024-01-01T00:00:00+09:00', '2024-12-31T23:59:59+09:00');
		expect(result.sold_assets).toEqual([]);
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

	it('期間内 sell の fee_amount_base が calcPnl と同じ対称形で残数量・原価に反映される', () => {
		// calcPnl 側の対称化と同一ケース（買い @ 期間前、売り fee_base=0.002 @ 期間内）。
		// 実現損益は 977_000 で calcPnl と一致する（残数量・平均原価の整合を保つ）。
		const trades: RawTrade[] = [
			makeTrade({ trade_id: 1, executed_at: 100, side: 'buy', amount: '1', price: '10000000' }),
			makeTrade({
				trade_id: 2,
				executed_at: 1500,
				side: 'sell',
				amount: '0.5',
				price: '12000000',
				fee_amount_base: '0.002',
				fee_amount_quote: '3000',
			}),
		];
		const result = calcPeriodRealizedPnl(trades, 1000, 's', 'e');
		expect(result.realized_pnl).toBe(977_000);
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

	it('reverse sell で fee_amount_base > 0 のとき base 建て手数料も巻き戻される', () => {
		// 売りの base 建て手数料は API 仕様上ゼロだが、非ゼロが来ても正しく扱う（防御的）。
		// 期間内 sell (t=2000): amount=0.5, price=12M, fee_quote=5000, fee_base=0.002
		//   売りで実際に減った BTC = 0.5 + 0.002 = 0.502
		//   期間前 BTC = 1.5 + 0.5 + 0.002 = 2.002
		//   期間前 JPY = 11_000_000 - 0.5 * 12_000_000 + 5_000 = 5_005_000（quote 側は不変）
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
				fee_amount_base: '0.002',
			}),
		];
		const result = reconstructHoldingsAtDate(currentHoldings, trades, 1000, null);
		expect(result.get('btc')).toBeCloseTo(2.002, 9);
		expect(result.get('jpy')).toBe(5_005_000);
	});

	it('買い・売り両方に fee_amount_base があるとき期初保有が正確に復元される', () => {
		// 時系列（期初: 0.5 BTC / 20_000_000 JPY）:
		//   buy  t=2000: amount=1,   price=10M, fee_base=0.001 → BTC 0.5+0.999=1.499, JPY 10_000_000
		//   sell t=3000: amount=0.5, price=12M, fee_base=0.0005, fee_quote=3000
		//                → BTC 1.499-0.5005=0.9985, JPY 10_000_000+5_997_000=15_997_000
		// 逆算（新しい順）:
		//   sell 巻き戻し: BTC 0.9985+0.5+0.0005=1.499, JPY 15_997_000-6_000_000+3_000=10_000_000
		//   buy  巻き戻し: BTC 1.499-(1-0.001)=0.5,     JPY 10_000_000+10_000_000=20_000_000
		// 売り側 feeBase を無視すると BTC が 0.4995 となり期初と一致しない。
		const currentHoldings = [
			{ asset: 'btc', amount: '0.9985' },
			{ asset: 'jpy', amount: '15997000' },
		];
		const trades: RawTrade[] = [
			makeTrade({
				trade_id: 1,
				executed_at: 2000,
				side: 'buy',
				amount: '1',
				price: '10000000',
				fee_amount_base: '0.001',
			}),
			makeTrade({
				trade_id: 2,
				executed_at: 3000,
				side: 'sell',
				amount: '0.5',
				price: '12000000',
				fee_amount_quote: '3000',
				fee_amount_base: '0.0005',
			}),
		];
		const result = reconstructHoldingsAtDate(currentHoldings, trades, 1000, null);
		expect(result.get('btc')).toBeCloseTo(0.5, 9);
		expect(result.get('jpy')).toBe(20_000_000);
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

	it('買い→出庫を経由した口座でも期初保有を過大に復元しない（途中ゼロ床クランプ禁止）', () => {
		// 時系列: 0 BTC → buy 2 → withdrawal 1 → 現在 1 BTC（履歴と残高は整合）
		// 両イベントより前へ巻き戻すと期初は 0。
		// 旧実装は約定相で 1-2=-1 を delete してしまい、出庫相で 0+1=1 と過大復元していた。
		const currentHoldings = [{ asset: 'btc', amount: '1' }];
		const trades: RawTrade[] = [
			makeTrade({
				trade_id: 1,
				executed_at: 2000,
				side: 'buy',
				amount: '2',
				price: '10000000',
				fee_amount_base: '0',
			}),
		];
		const dw: DepositWithdrawalData = {
			deposits: [],
			withdrawals: [
				makeWithdrawal({
					uuid: 'wd-buy-then-out',
					asset: 'btc',
					amount: '1',
					fee: '0',
					status: 'DONE',
					requested_at: 3000,
				}),
			],
			warnings: [],
			allFailed: false,
			isComplete: true,
		};
		const result = reconstructHoldingsAtDate(currentHoldings, trades, 1000, dw);
		expect(result.has('btc')).toBe(false);
	});

	it('入庫→出庫を経由した口座でも期初保有を過大に復元しない（入庫相の途中ゼロ床クランプ禁止）', () => {
		// 時系列: 0 BTC → deposit 2 → withdrawal 1 → 現在 1 BTC（履歴と残高は整合）
		// 両イベントより前へ巻き戻すと期初は 0。
		// 旧実装は入庫相で 1-2=-1 を delete してしまい、出庫相で 0+1=1 と過大復元していた。
		const currentHoldings = [{ asset: 'btc', amount: '1' }];
		const dw: DepositWithdrawalData = {
			deposits: [
				makeDeposit({
					uuid: 'dep-then-out',
					asset: 'btc',
					amount: '2',
					status: 'DONE',
					found_at: 2000,
					confirmed_at: 2000,
				}),
			],
			withdrawals: [
				makeWithdrawal({
					uuid: 'wd-after-dep',
					asset: 'btc',
					amount: '1',
					fee: '0',
					status: 'DONE',
					requested_at: 3000,
				}),
			],
			warnings: [],
			allFailed: false,
			isComplete: true,
		};
		const result = reconstructHoldingsAtDate(currentHoldings, [], 1000, dw);
		expect(result.has('btc')).toBe(false);
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
		expect(result.margin_interest_cost).toBe(300);
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

	it('空配列で 0 / 0 / 0 / 0 を返す', () => {
		const result = calcMarginPnl([]);
		expect(result.margin_realized_pnl).toBe(0);
		expect(result.margin_interest_cost).toBe(0);
		expect(result.margin_fee_cost).toBe(0);
		expect(result.close_trade_count).toBe(0);
	});

	it('NaN / 不正な profit_loss / interest / fee はスキップする', () => {
		const trades: RawMarginTrade[] = [
			makeMarginTrade({
				trade_id: 1,
				profit_loss: '1000',
				interest: '50',
				fee_occurred_amount_quote: '20',
			}),
			makeMarginTrade({
				trade_id: 2,
				profit_loss: 'NaN',
				interest: 'abc',
				fee_occurred_amount_quote: 'xyz',
			}),
		];
		const result = calcMarginPnl(trades);
		expect(result.margin_realized_pnl).toBe(1000);
		expect(result.margin_interest_cost).toBe(50);
		expect(result.margin_fee_cost).toBe(20);
		expect(result.close_trade_count).toBe(1);
	});

	it('profit_loss のみのケース: realized のみ集計し interest / fee は 0', () => {
		const trades: RawMarginTrade[] = [
			makeMarginTrade({ trade_id: 1, profit_loss: '5000' }),
			makeMarginTrade({ trade_id: 2, profit_loss: '3000' }),
		];
		const result = calcMarginPnl(trades);
		expect(result.margin_realized_pnl).toBe(8000);
		expect(result.margin_interest_cost).toBe(0);
		expect(result.margin_fee_cost).toBe(0);
		expect(result.close_trade_count).toBe(2);
	});

	it('interest のみのケース: 建玉約定でも interest があれば合算', () => {
		// profit_loss なし（建玉約定）でも interest が付くケースは合算する
		const trades: RawMarginTrade[] = [
			makeMarginTrade({ trade_id: 1, interest: '40' }),
			makeMarginTrade({ trade_id: 2, interest: '60' }),
		];
		const result = calcMarginPnl(trades);
		expect(result.margin_realized_pnl).toBe(0);
		expect(result.margin_interest_cost).toBe(100);
		expect(result.margin_fee_cost).toBe(0);
		expect(result.close_trade_count).toBe(0);
	});

	it('fee_occurred_amount_quote のみのケース: profit_loss なしでも fee は合算', () => {
		// 建玉約定（profit_loss なし）でも fee_occurred_amount_quote が付くケース
		const trades: RawMarginTrade[] = [
			makeMarginTrade({ trade_id: 1, fee_occurred_amount_quote: '150' }),
			makeMarginTrade({ trade_id: 2, fee_occurred_amount_quote: '75' }),
		];
		const result = calcMarginPnl(trades);
		expect(result.margin_realized_pnl).toBe(0);
		expect(result.margin_interest_cost).toBe(0);
		expect(result.margin_fee_cost).toBe(225);
		expect(result.close_trade_count).toBe(0);
	});

	it('profit_loss / interest / fee_occurred_amount_quote が同時に非ゼロ', () => {
		// 信用決済の実例パターン: 3 つすべてが付いた決済約定
		const trades: RawMarginTrade[] = [
			makeMarginTrade({
				trade_id: 1,
				side: 'sell',
				profit_loss: '5000',
				interest: '30',
				fee_occurred_amount_quote: '155',
			}),
			makeMarginTrade({
				trade_id: 2,
				side: 'sell',
				profit_loss: '3000',
				interest: '20',
				fee_occurred_amount_quote: '100',
			}),
		];
		const result = calcMarginPnl(trades);
		expect(result.margin_realized_pnl).toBe(8000);
		expect(result.margin_interest_cost).toBe(50);
		expect(result.margin_fee_cost).toBe(255);
		expect(result.close_trade_count).toBe(2);
	});
});

describe('calcPeriodMarginPnl', () => {
	it('sinceMs 以降の約定のみを集計する（fee も含む）', () => {
		// 期間外 (t=500) + 期間内 (t=1500, t=2000)
		const trades: RawMarginTrade[] = [
			makeMarginTrade({
				trade_id: 1,
				executed_at: 500,
				profit_loss: '999',
				interest: '10',
				fee_occurred_amount_quote: '50',
			}), // 除外
			makeMarginTrade({
				trade_id: 2,
				executed_at: 1500,
				profit_loss: '5000',
				interest: '100',
				fee_occurred_amount_quote: '155',
			}),
			makeMarginTrade({
				trade_id: 3,
				executed_at: 2000,
				profit_loss: '3000',
				interest: '50',
				fee_occurred_amount_quote: '95',
			}),
		];
		const result = calcPeriodMarginPnl(trades, 1000, '2024-01-01T00:00:00+09:00', '2024-12-31T23:59:59+09:00');
		expect(result.margin_realized_pnl).toBe(8000);
		expect(result.margin_interest_cost).toBe(150);
		expect(result.margin_fee_cost).toBe(250);
		expect(result.close_trade_count).toBe(2);
		expect(result.period_start).toBe('2024-01-01T00:00:00+09:00');
		expect(result.period_end).toBe('2024-12-31T23:59:59+09:00');
	});
});

/**
 * `AccountPnl.spot_realized_pnl` / `total` は #80 の抑止で `undefined` になりうる
 * （`number | undefined`）ため、確定値どうしの検算にそのまま使うと TS18048 になる。
 *
 * `!` で潰すと抑止が誤って発火したときに `undefined + number = NaN` の比較失敗になり、
 * 「どのフィールドが出ていないのか」がテスト出力から読めない。先に `toBeDefined()` を
 * 表明してから絞ることで、失敗時はフィールド名つきのアサーション失敗として出る。
 */
function definedAmount(value: number | undefined, label: string): number {
	expect(value, label).toBeDefined();
	// expect() は TypeScript の型を絞らないので、表明が通ったことをここで型にも反映させる。
	if (value === undefined) throw new Error(`${label} が undefined（上の toBeDefined が失敗しているはず）`);
	return value;
}

describe('buildAccountPnl', () => {
	it('total = spot + margin - interest - fee を返す', () => {
		const result = buildAccountPnl(1000, {
			margin_realized_pnl: 500,
			margin_interest_cost: 100,
			margin_fee_cost: 50,
		});
		expect(result.spot_realized_pnl).toBe(1000);
		expect(result.margin_realized_pnl).toBe(500);
		expect(result.margin_interest_cost).toBe(100);
		expect(result.margin_fee_cost).toBe(50);
		expect(result.total).toBe(1350); // 1000 + 500 - 100 - 50
	});

	it('信用約定なし（margin=0, interest=0, fee=0）のとき total === spot_realized_pnl', () => {
		const result = buildAccountPnl(1234, { margin_realized_pnl: 0, margin_interest_cost: 0, margin_fee_cost: 0 });
		expect(result.spot_realized_pnl).toBe(1234);
		expect(result.margin_realized_pnl).toBe(0);
		expect(result.margin_interest_cost).toBe(0);
		expect(result.margin_fee_cost).toBe(0);
		expect(result.total).toBe(1234);
	});

	/**
	 * #72: `_cost` サフィックス無しの旧フィールドは **alias として残す**。
	 * 同じ正値を出し続けるので、旧フィールドを読んでいる消費者は壊れない。
	 * 削除目標は `DEPRECATED_FIELD_REMOVAL_TARGET`（`src/schema/base.ts`）。
	 */
	it('旧フィールド margin_interest / margin_fee は新フィールドと同じ正値を返す（alias）', () => {
		const result = buildAccountPnl(1000, {
			margin_realized_pnl: 500,
			margin_interest_cost: 100,
			margin_fee_cost: 50,
		});
		expect(result.margin_interest).toBe(result.margin_interest_cost);
		expect(result.margin_fee).toBe(result.margin_fee_cost);
		// alias も「コスト = 正値」のまま（負値に反転させない）
		expect(result.margin_interest).toBe(100);
		expect(result.margin_fee).toBe(50);
	});

	/**
	 * JSON を直読みする消費者が `_cost` を**引き算**して total を再現できること。
	 * 足し込むと符号が反転する（#72 の症状そのもの）ので、その向きも固定する。
	 */
	it('total は新フィールドで検算できる（コスト項は減算）', () => {
		const result = buildAccountPnl(-2000, {
			margin_realized_pnl: 8000,
			margin_interest_cost: 1,
			margin_fee_cost: 149,
		});
		const spot = definedAmount(result.spot_realized_pnl, 'spot_realized_pnl');
		expect(result.total).toBe(spot + result.margin_realized_pnl - result.margin_interest_cost - result.margin_fee_cost);
		expect(result.total).toBe(5850);
		// 足し込むと 150 円ぶんずれる = 符号規約を取り違えたときの誤差
		expect(spot + result.margin_realized_pnl + result.margin_interest_cost + result.margin_fee_cost).toBe(6150);
	});
});

describe('buildAccountPnl — 現物側の抑止（#80）', () => {
	const marginPnl = { margin_realized_pnl: 500, margin_interest_cost: 100, margin_fee_cost: 50 };

	it('spot が undefined なら total も出さず理由コードを載せる', () => {
		const result = buildAccountPnl(undefined, marginPnl, 'deposit_price_fetch_failed');
		expect(result.spot_realized_pnl).toBeUndefined();
		// 信用だけの合計を口座全体 PnL として出さない（現物ゼロ円と区別できなくなるため）
		expect(result.total).toBeUndefined();
		expect(result.spot_realized_pnl_unavailable_reason).toBe('deposit_price_fetch_failed');
		// 信用側は現物と独立に確定するのでそのまま出す
		expect(result.margin_realized_pnl).toBe(500);
		expect(result.margin_interest_cost).toBe(100);
		expect(result.margin_fee_cost).toBe(50);
	});

	it('spot が 0 円のときは抑止と区別して確定値を出す', () => {
		const result = buildAccountPnl(0, marginPnl, 'deposit_price_fetch_failed');
		expect(result.spot_realized_pnl).toBe(0);
		expect(result.total).toBe(350);
		expect(result.spot_realized_pnl_unavailable_reason).toBeUndefined();
	});

	it('抑止していなければ理由コードは載らない', () => {
		expect(buildAccountPnl(1000, marginPnl).spot_realized_pnl_unavailable_reason).toBeUndefined();
	});

	it('期間版も同じ規約で抑止する（期間の境界は残す）', () => {
		const result = buildPeriodAccountPnl(
			undefined,
			marginPnl,
			'2026-01-01T00:00:00+09:00',
			'2026-08-23T00:00:00+09:00',
			'deposit_price_chunk_truncated',
		);
		expect(result.spot_realized_pnl).toBeUndefined();
		expect(result.total).toBeUndefined();
		expect(result.spot_realized_pnl_unavailable_reason).toBe('deposit_price_chunk_truncated');
		expect(result.period_start).toBe('2026-01-01T00:00:00+09:00');
		expect(result.period_end).toBe('2026-08-23T00:00:00+09:00');
	});
});

describe('buildPeriodAccountPnl', () => {
	it('期間版でも新旧フィールドが同じ値で並び、total を新フィールドで検算できる', () => {
		const result = buildPeriodAccountPnl(
			300,
			{ margin_realized_pnl: 200, margin_interest_cost: 15, margin_fee_cost: 75 },
			'2026-01-01T00:00:00+09:00',
			'2026-08-23T00:00:00+09:00',
		);
		expect(result.margin_interest_cost).toBe(15);
		expect(result.margin_fee_cost).toBe(75);
		expect(result.margin_interest).toBe(15);
		expect(result.margin_fee).toBe(75);
		const spot = definedAmount(result.spot_realized_pnl, 'spot_realized_pnl');
		expect(result.total).toBe(spot + result.margin_realized_pnl - result.margin_interest_cost - result.margin_fee_cost);
		expect(result.total).toBe(410);
		expect(result.period_start).toBe('2026-01-01T00:00:00+09:00');
		expect(result.period_end).toBe('2026-08-23T00:00:00+09:00');
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
		const result = calcDepositWithdrawalSummary(dw, 2_000_000, currentPriceOnly());
		expect(result.total_jpy_deposited).toBe(1_500_000);
		expect(result.total_jpy_withdrawn).toBe(0);
		expect(result.net_jpy_invested).toBe(1_500_000);
		expect(result.account_return_jpy).toBe(500_000);
		expect(result.account_return_pct).toBeCloseTo(33.33, 1);
	});

	it('入金のみで net_jpy_invested <= 0 のとき account_return_* は undefined', () => {
		const dw = makeDwData(); // 入出金なし
		const result = calcDepositWithdrawalSummary(dw, 1_000_000, currentPriceOnly());
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
		const result = calcDepositWithdrawalSummary(dw, 3_000_000, currentPriceOnly(prices));
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
		const result = calcDepositWithdrawalSummary(dw, 1_000_000, currentPriceOnly());
		expect(result.total_jpy_deposited).toBe(0);
		expect(result.net_jpy_invested).toBe(0);
	});

	// ── 暗号資産出庫を元本の回収として純投入額から差し引く（#70） ──

	describe('暗号資産出庫の減算', () => {
		const prices = new Map([
			['btc', 10_000_000],
			['eth', 500_000],
		]);

		it('出庫の評価額だけ net_jpy_invested が減り、口座全体リターンが改善する', () => {
			// JPY 入金 3,000,000 + BTC 0.2 出庫（= 2,000,000）→ 純投入額 1,000,000
			const withdrawals = [makeWithdrawal({ uuid: 'w1', asset: 'btc', amount: '0.2', requested_at: 300 })];
			const deposits = [makeDeposit({ uuid: 'd1', amount: '3000000', confirmed_at: 100 })];
			const withWd = calcDepositWithdrawalSummary(
				makeDwData({ deposits, withdrawals }),
				2_000_000,
				currentPriceOnly(prices),
			);
			const withoutWd = calcDepositWithdrawalSummary(makeDwData({ deposits }), 2_000_000, currentPriceOnly(prices));

			expect(withWd.crypto_withdrawal_count).toBe(1);
			expect(withWd.crypto_withdrawal_estimated_jpy).toBe(2_000_000);
			expect(withWd.net_jpy_invested).toBe(withoutWd.net_jpy_invested - 2_000_000);
			expect(withWd.net_jpy_invested).toBe(1_000_000);
			// 出庫を引かないと「投入したまま消えた損失」になり、引くと実態に寄る（#70 の症状）
			expect(withoutWd.account_return_pct).toBeCloseTo(-33.33, 1);
			expect(withWd.account_return_jpy).toBe(1_000_000);
			expect(withWd.account_return_pct).toBe(100);
		});

		it('出庫ゼロの口座では出力が従来と一致する（キーごと落ちる）', () => {
			const dw = makeDwData({ deposits: [makeDeposit({ uuid: 'd1', amount: '1000000', confirmed_at: 100 })] });
			const result = calcDepositWithdrawalSummary(dw, 1_500_000, currentPriceOnly(prices));

			expect(result.net_jpy_invested).toBe(1_000_000);
			expect(result.crypto_withdrawal_count).toBe(0);
			expect(result.crypto_withdrawal_estimated_jpy).toBeUndefined();
			expect(result.crypto_withdrawal_valuation).toBeUndefined();
			expect('crypto_withdrawal_valuation' in result).toBe(false);
		});

		it('JPY 出金は暗号資産出庫の評価額に混ざらない（total_jpy_withdrawn 側の担当）', () => {
			const dw = makeDwData({
				deposits: [makeDeposit({ uuid: 'd1', amount: '3000000', confirmed_at: 100 })],
				withdrawals: [
					makeWithdrawal({ uuid: 'w-jpy', asset: 'jpy', amount: '500000', requested_at: 300 }),
					makeWithdrawal({ uuid: 'w-btc', asset: 'btc', amount: '0.1', requested_at: 300 }),
				],
			});
			const result = calcDepositWithdrawalSummary(dw, 2_000_000, currentPriceOnly(prices));

			expect(result.total_jpy_withdrawn).toBe(500_000);
			expect(result.crypto_withdrawal_count).toBe(1);
			expect(result.crypto_withdrawal_estimated_jpy).toBe(1_000_000);
			expect(result.net_jpy_invested).toBe(3_000_000 - 500_000 - 1_000_000);
		});

		it('出庫手数料は元本に含めない（calcPeriodNetFlow と同じ規約）', () => {
			const withFee = makeWithdrawal({ uuid: 'w1', asset: 'btc', amount: '0.1', fee: '0.0006', requested_at: 300 });
			const noFee = makeWithdrawal({ uuid: 'w1', asset: 'btc', amount: '0.1', fee: '0', requested_at: 300 });
			const deposits = [makeDeposit({ uuid: 'd1', amount: '3000000', confirmed_at: 100 })];

			const a = calcDepositWithdrawalSummary(
				makeDwData({ deposits, withdrawals: [withFee] }),
				2_000_000,
				currentPriceOnly(prices),
			);
			const b = calcDepositWithdrawalSummary(
				makeDwData({ deposits, withdrawals: [noFee] }),
				2_000_000,
				currentPriceOnly(prices),
			);
			expect(a.crypto_withdrawal_estimated_jpy).toBe(b.crypto_withdrawal_estimated_jpy);
			expect(a.crypto_withdrawal_estimated_jpy).toBe(1_000_000);
		});

		it('入庫と出庫が同一資産で混在しても双方が計上される（順序に依存しない）', () => {
			// BTC 0.3 入庫（3,000,000）→ BTC 0.1 出庫（1,000,000）。JPY 入金は無し
			const flows = {
				deposits: [makeDeposit({ uuid: 'd-btc', asset: 'btc', amount: '0.3', confirmed_at: 100 })],
				withdrawals: [makeWithdrawal({ uuid: 'w-btc', asset: 'btc', amount: '0.1', requested_at: 200 })],
			};
			const forward = calcDepositWithdrawalSummary(makeDwData(flows), 2_500_000, currentPriceOnly(prices));
			// 出庫が入庫より前に並ぶ履歴でも同じ（本関数は時系列を畳まず両建てで合計する）
			const reversed = calcDepositWithdrawalSummary(
				makeDwData({
					deposits: [makeDeposit({ uuid: 'd-btc', asset: 'btc', amount: '0.3', confirmed_at: 300 })],
					withdrawals: [makeWithdrawal({ uuid: 'w-btc', asset: 'btc', amount: '0.1', requested_at: 100 })],
				}),
				2_500_000,
				currentPriceOnly(prices),
			);

			expect(forward.crypto_deposit_estimated_jpy).toBe(3_000_000);
			expect(forward.crypto_withdrawal_estimated_jpy).toBe(1_000_000);
			expect(forward.net_jpy_invested).toBe(2_000_000);
			expect(reversed.net_jpy_invested).toBe(forward.net_jpy_invested);
		});

		it('出庫のみ（入庫ゼロ）で純投入額が負になると account_return_* は undefined', () => {
			const dw = makeDwData({
				withdrawals: [makeWithdrawal({ uuid: 'w-btc', asset: 'btc', amount: '0.1', requested_at: 100 })],
			});
			const result = calcDepositWithdrawalSummary(dw, 5_000_000, currentPriceOnly(prices));

			expect(result.crypto_withdrawal_estimated_jpy).toBe(1_000_000);
			expect(result.net_jpy_invested).toBe(-1_000_000);
			expect(result.account_return_jpy).toBeUndefined();
			expect(result.account_return_pct).toBeUndefined();
		});

		it('出庫の減算で純投入額が 0 ちょうどになっても account_return_* は undefined（境界）', () => {
			const dw = makeDwData({
				deposits: [makeDeposit({ uuid: 'd1', amount: '1000000', confirmed_at: 100 })],
				withdrawals: [makeWithdrawal({ uuid: 'w-btc', asset: 'btc', amount: '0.1', requested_at: 200 })],
			});
			const result = calcDepositWithdrawalSummary(dw, 5_000_000, currentPriceOnly(prices));

			expect(result.net_jpy_invested).toBe(0);
			expect(result.account_return_jpy).toBeUndefined();
			expect(result.account_return_pct).toBeUndefined();
		});

		it('DONE 以外・数量ゼロ・数値不正の出庫は評価額に寄与しない', () => {
			const dw = makeDwData({
				deposits: [makeDeposit({ uuid: 'd1', amount: '1000000', confirmed_at: 100 })],
				withdrawals: [
					makeWithdrawal({ uuid: 'w-pending', asset: 'btc', amount: '0.1', status: 'PROCESSING', requested_at: 200 }),
					makeWithdrawal({ uuid: 'w-zero', asset: 'btc', amount: '0', requested_at: 200 }),
					makeWithdrawal({ uuid: 'w-nan', asset: 'btc', amount: 'abc', requested_at: 200 }),
				],
			});
			const result = calcDepositWithdrawalSummary(dw, 1_000_000, currentPriceOnly(prices));

			// 未完了は件数からも外れ、数量ゼロ・不正は件数には残るが金額は動かない
			expect(result.crypto_withdrawal_count).toBe(2);
			expect(result.crypto_withdrawal_estimated_jpy).toBeUndefined();
			expect(result.net_jpy_invested).toBe(1_000_000);
		});

		it('価格を解決できない出庫は件数だけ残り、純投入額は動かない（黙って 0 円計上しない）', () => {
			const dw = makeDwData({
				deposits: [makeDeposit({ uuid: 'd1', amount: '1000000', confirmed_at: 100 })],
				withdrawals: [makeWithdrawal({ uuid: 'w-doge', asset: 'doge', amount: '1000', requested_at: 200 })],
			});
			const result = calcDepositWithdrawalSummary(dw, 1_200_000, currentPriceOnly(prices));

			expect(result.crypto_withdrawal_count).toBe(1);
			expect(result.crypto_withdrawal_estimated_jpy).toBeUndefined();
			expect(result.crypto_withdrawal_valuation).toBeUndefined();
			expect(result.net_jpy_invested).toBe(1_000_000);
		});
	});
});

// ── 入出庫日価格での JPY 換算（#57 (a)） ──

/**
 * 暗号資産入出庫の JPY 換算を「入出庫日の 1day open」で固定する経路の検証。
 *
 * 本 issue の眼目は「現在価格が動いても入出庫の評価額が動かないこと」なので、
 * 各ケースで **現在価格だけを差し替えた 2 回の呼び出しが同じ値を返すこと**を軸に据える。
 * 値の一致を目視の数値比較ではなく 2 回実行の突き合わせで見るのは、
 * 「たまたま同じ数値になった」ではなく「現在価格に依存していない」を主張するため。
 */
describe('入出庫日価格での JPY 換算', () => {
	function makeDwData(overrides: Partial<DepositWithdrawalData> = {}): DepositWithdrawalData {
		return { deposits: [], withdrawals: [], warnings: [], allFailed: false, isComplete: true, ...overrides };
	}

	/** 2025-06-10 12:00 JST（入出庫日）。同じ JST 暦日に丸まる時刻なら値は変わらない */
	const FLOW_MS = Date.UTC(2025, 5, 10, 3, 0, 0, 0);
	/** 入出庫日の 1day open。現在価格（下記）とは意図的に離す */
	const FLOW_DAY_PRICE = 8_000_000;

	describe('resolveFlowPrice', () => {
		it('入出庫日の日次価格があればそれを返す（basis=deposit_date_price）', () => {
			const pricing = withDailyPrices(
				[{ asset: 'btc', atMs: FLOW_MS, price: FLOW_DAY_PRICE }],
				new Map([['btc', 20_000_000]]),
			);
			expect(resolveFlowPrice(pricing, 'btc', FLOW_MS)).toEqual({
				price: FLOW_DAY_PRICE,
				basis: 'deposit_date_price',
			});
		});

		it('同じ JST 暦日の別時刻でも同じ日次価格に丸まる', () => {
			const pricing = withDailyPrices([{ asset: 'btc', atMs: FLOW_MS, price: FLOW_DAY_PRICE }]);
			// 2025-06-10 00:30 JST と 23:30 JST。どちらも同じ暦日
			const dayStartJst = Date.UTC(2025, 5, 9, 15, 30, 0, 0);
			const dayEndJst = Date.UTC(2025, 5, 10, 14, 30, 0, 0);
			expect(resolveFlowPrice(pricing, 'btc', dayStartJst)?.price).toBe(FLOW_DAY_PRICE);
			expect(resolveFlowPrice(pricing, 'btc', dayEndJst)?.price).toBe(FLOW_DAY_PRICE);
		});

		it('日次価格が無ければ現在価格に落ちる（basis=current_price_fallback）', () => {
			const pricing = currentPriceOnly(new Map([['btc', 20_000_000]]));
			expect(resolveFlowPrice(pricing, 'btc', FLOW_MS)).toEqual({
				price: 20_000_000,
				basis: 'current_price_fallback',
			});
		});

		it('どちらも無ければ undefined（呼び出し側が unpriced_assets に載せる）', () => {
			expect(resolveFlowPrice(currentPriceOnly(), 'doge', FLOW_MS)).toBeUndefined();
		});

		it('atMs が非有限でも throw せず現在価格に落ちる', () => {
			// portfolioDayStartMs は非有限で TypeError を投げるため、日次 lookup 前に弾く必要がある
			const pricing = withDailyPrices(
				[{ asset: 'btc', atMs: FLOW_MS, price: FLOW_DAY_PRICE }],
				new Map([['btc', 20_000_000]]),
			);
			expect(resolveFlowPrice(pricing, 'btc', Number.NaN)).toEqual({
				price: 20_000_000,
				basis: 'current_price_fallback',
			});
		});

		it('日次価格がゼロ・負なら採用せず現在価格に落ちる', () => {
			const pricing = withDailyPrices([{ asset: 'btc', atMs: FLOW_MS, price: 0 }], new Map([['btc', 20_000_000]]));
			expect(resolveFlowPrice(pricing, 'btc', FLOW_MS)?.basis).toBe('current_price_fallback');
		});
	});

	describe('calcPeriodNetFlow — 現在価格を変えても入出庫の評価額が動かない', () => {
		const dw = makeDwData({
			deposits: [makeDeposit({ uuid: 'd-btc', asset: 'btc', amount: '0.5', confirmed_at: FLOW_MS })],
			withdrawals: [
				makeWithdrawal({ uuid: 'w-btc', asset: 'btc', amount: '0.1', fee: '0.0005', requested_at: FLOW_MS }),
			],
		});
		const dated = [{ asset: 'btc', atMs: FLOW_MS, price: FLOW_DAY_PRICE }];

		it('現在価格を 2 倍にしても net_flow_jpy / withdrawal_fee_jpy が変わらない', () => {
			const cheap = calcPeriodNetFlow(dw, 0, withDailyPrices(dated, new Map([['btc', 10_000_000]])));
			const rich = calcPeriodNetFlow(dw, 0, withDailyPrices(dated, new Map([['btc', 20_000_000]])));

			expect(cheap.net_flow_jpy).toBe(rich.net_flow_jpy);
			expect(cheap.withdrawal_fee_jpy).toBe(rich.withdrawal_fee_jpy);
			// 入庫 0.5 - 出庫 0.1 = 正味 0.4 BTC を入出庫日の始値で換算
			expect(cheap.net_flow_jpy).toBe(Math.round(0.4 * FLOW_DAY_PRICE));
			// 出庫手数料も同じ単価で換算する（元本だけ入出庫日・手数料だけ現在価格の混成にしない）
			expect(cheap.withdrawal_fee_jpy).toBe(Math.round(0.0005 * FLOW_DAY_PRICE));
			expect(cheap.valuation).toEqual({
				deposit_date_price_count: 2,
				current_price_fallback_count: 0,
				basis: 'deposit_date_price',
			});
		});

		it('現在価格しか無い場合は同じ入力でも現在価格に連動して動く（フォールバックの性質）', () => {
			// 「入出庫日価格で固定する」ことの対偶。フォールバックが相場連動なのは既知の性質で、
			// だからこそ basis / 件数で申告する必要がある。
			const cheap = calcPeriodNetFlow(dw, 0, currentPriceOnly(new Map([['btc', 10_000_000]])));
			const rich = calcPeriodNetFlow(dw, 0, currentPriceOnly(new Map([['btc', 20_000_000]])));

			expect(cheap.net_flow_jpy).not.toBe(rich.net_flow_jpy);
			expect(cheap.valuation?.basis).toBe('current_price_fallback');
			expect(cheap.valuation?.current_price_fallback_count).toBe(2);
		});

		it('一部だけ日次価格がある場合は basis=mixed で件数を申告する', () => {
			const otherDayMs = Date.UTC(2025, 5, 11, 3, 0, 0, 0);
			const mixedDw = makeDwData({
				deposits: [
					makeDeposit({ uuid: 'd-1', asset: 'btc', amount: '0.5', confirmed_at: FLOW_MS }),
					makeDeposit({ uuid: 'd-2', asset: 'btc', amount: '0.5', confirmed_at: otherDayMs }),
				],
			});
			const result = calcPeriodNetFlow(mixedDw, 0, withDailyPrices(dated, new Map([['btc', 20_000_000]])));

			expect(result.valuation).toEqual({
				deposit_date_price_count: 1,
				current_price_fallback_count: 1,
				basis: 'mixed',
			});
			// 混在時も合計は「日次で解けた分 + 現在価格の分」
			expect(result.net_flow_jpy).toBe(Math.round(0.5 * FLOW_DAY_PRICE + 0.5 * 20_000_000));
		});

		/**
		 * 取りこぼしのずれの向きは入庫・出庫で逆になる。
		 * `netFlow` は入庫で加算・出庫で減算されるため、落ちた入庫は net_flow を過小に、
		 * 落ちた出庫は過大にする。`adjusted_change_jpy = change_jpy - net_flow_jpy` なので
		 * 調整後増減は常に net_flow と逆向きにずれる。スキーマ・型・warning の説明文が
		 * この向きを取り違えないよう、実際の符号をテストで固定する。
		 */
		it('取りこぼしの向き: 入庫が落ちると net_flow は過小、出庫が落ちると過大', () => {
			const priced = withDailyPrices([{ asset: 'btc', atMs: FLOW_MS, price: FLOW_DAY_PRICE }]);
			// doge は日次価格も現在価格も無いので必ず落ちる
			const depositOnly = makeDwData({
				deposits: [makeDeposit({ uuid: 'd-doge', asset: 'doge', amount: '1000', confirmed_at: FLOW_MS })],
			});
			const withdrawalOnly = makeDwData({
				withdrawals: [makeWithdrawal({ uuid: 'w-doge', asset: 'doge', amount: '1000', requested_at: FLOW_MS })],
			});

			// 基準: 落ちる入出庫が 1 件も無いときの net_flow は 0
			expect(calcPeriodNetFlow(makeDwData(), 0, priced).net_flow_jpy).toBe(0);

			// 落ちた入庫は「加算されるはずの正値」が消える → 真値より過小（真値 > 0、報告は 0）
			const withLostDeposit = calcPeriodNetFlow(depositOnly, 0, priced);
			expect(withLostDeposit.net_flow_jpy).toBe(0);
			expect(withLostDeposit.unpriced_assets).toEqual(['doge']);

			// 落ちた出庫は「減算されるはずの正値」が消える → 真値より過大（真値 < 0、報告は 0）
			const withLostWithdrawal = calcPeriodNetFlow(withdrawalOnly, 0, priced);
			expect(withLostWithdrawal.net_flow_jpy).toBe(0);
			expect(withLostWithdrawal.unpriced_assets).toEqual(['doge']);

			// 同じ入出庫を価格解決できたときの値（＝真値）と直接突き合わせる。
			// 「落ちると 0 になる」だけでは欠落しか示せず、過小/過大の向きは主張できない。
			const resolvable = withDailyPrices([{ asset: 'doge', atMs: FLOW_MS, price: 20 }]);
			const pricedDeposit = calcPeriodNetFlow(depositOnly, 0, resolvable);
			const pricedWithdrawal = calcPeriodNetFlow(withdrawalOnly, 0, resolvable);
			// 入庫は正、出庫は負に寄与する（向きが逆になることの根拠）
			expect(pricedDeposit.net_flow_jpy).toBe(20_000);
			expect(pricedWithdrawal.net_flow_jpy).toBe(-20_000);
			// 入庫の取りこぼし → 真値より小さい（過小）
			expect(Number(withLostDeposit.net_flow_jpy)).toBeLessThan(Number(pricedDeposit.net_flow_jpy));
			// 出庫の取りこぼし → 真値より大きい（過大）
			expect(Number(withLostWithdrawal.net_flow_jpy)).toBeGreaterThan(Number(pricedWithdrawal.net_flow_jpy));
		});

		it('日次価格も現在価格も無い資産は valuation に数えず unpriced_assets に載る', () => {
			const unpricedDw = makeDwData({
				deposits: [makeDeposit({ uuid: 'd-doge', asset: 'doge', amount: '1000', confirmed_at: FLOW_MS })],
			});
			const result = calcPeriodNetFlow(unpricedDw, 0, withDailyPrices(dated));

			expect(result.unpriced_assets).toEqual(['doge']);
			// 換算できていないので内訳にも載らない（キーごと落ちる）
			expect(result.valuation).toBeUndefined();
		});
	});

	describe('calcDepositWithdrawalSummary — 入庫は入庫日の始値で評価する', () => {
		const dw = makeDwData({
			deposits: [
				makeDeposit({ uuid: 'd-jpy', asset: 'jpy', amount: '1000000', confirmed_at: FLOW_MS }),
				makeDeposit({ uuid: 'd-btc', asset: 'btc', amount: '0.1', confirmed_at: FLOW_MS }),
			],
		});
		const dated = [{ asset: 'btc', atMs: FLOW_MS, price: FLOW_DAY_PRICE }];

		it('現在価格を変えても crypto_deposit_estimated_jpy / net_jpy_invested が動かない', () => {
			const cheap = calcDepositWithdrawalSummary(dw, 3_000_000, withDailyPrices(dated, new Map([['btc', 10_000_000]])));
			const rich = calcDepositWithdrawalSummary(dw, 3_000_000, withDailyPrices(dated, new Map([['btc', 30_000_000]])));

			expect(cheap.crypto_deposit_estimated_jpy).toBe(rich.crypto_deposit_estimated_jpy);
			expect(cheap.net_jpy_invested).toBe(rich.net_jpy_invested);
			// 0.1 BTC × 入庫日の始値 800_000 + JPY 入金 1_000_000
			expect(cheap.crypto_deposit_estimated_jpy).toBe(800_000);
			expect(cheap.net_jpy_invested).toBe(1_800_000);
			expect(cheap.crypto_deposit_valuation).toEqual({
				deposit_date_price_count: 1,
				current_price_fallback_count: 0,
				basis: 'deposit_date_price',
			});
		});

		it('暗号資産入庫が無ければ crypto_deposit_valuation はキーごと落ちる', () => {
			const jpyOnly = makeDwData({
				deposits: [makeDeposit({ uuid: 'd-jpy', asset: 'jpy', amount: '1000000', confirmed_at: FLOW_MS })],
			});
			const result = calcDepositWithdrawalSummary(jpyOnly, 2_000_000, withDailyPrices(dated));
			expect(result.crypto_deposit_valuation).toBeUndefined();
			expect('crypto_deposit_valuation' in result).toBe(false);
		});
	});

	describe('calcDepositWithdrawalSummary — 出庫は出庫日の始値で評価する', () => {
		/** 出庫日は入庫日の翌日。日付ごとに別の始値を持たせ、引き分けられていることを見る */
		const withdrawalDayMs = Date.UTC(2025, 5, 11, 3, 0, 0, 0);
		const WITHDRAWAL_DAY_PRICE = 9_000_000;
		const dw = makeDwData({
			deposits: [makeDeposit({ uuid: 'd-jpy', asset: 'jpy', amount: '3000000', confirmed_at: FLOW_MS })],
			withdrawals: [
				makeWithdrawal({ uuid: 'w-btc', asset: 'btc', amount: '0.1', fee: '0.0005', requested_at: withdrawalDayMs }),
			],
		});
		const dated = [
			{ asset: 'btc', atMs: FLOW_MS, price: FLOW_DAY_PRICE },
			{ asset: 'btc', atMs: withdrawalDayMs, price: WITHDRAWAL_DAY_PRICE },
		];

		it('現在価格を変えても crypto_withdrawal_estimated_jpy / net_jpy_invested が動かない', () => {
			const cheap = calcDepositWithdrawalSummary(dw, 3_000_000, withDailyPrices(dated, new Map([['btc', 10_000_000]])));
			const rich = calcDepositWithdrawalSummary(dw, 3_000_000, withDailyPrices(dated, new Map([['btc', 30_000_000]])));

			expect(cheap.crypto_withdrawal_estimated_jpy).toBe(rich.crypto_withdrawal_estimated_jpy);
			expect(cheap.net_jpy_invested).toBe(rich.net_jpy_invested);
			expect(cheap.account_return_jpy).toBe(rich.account_return_jpy);
			// 入庫日ではなく**出庫日**の始値で換算する（0.1 BTC × 900,000）
			expect(cheap.crypto_withdrawal_estimated_jpy).toBe(900_000);
			expect(cheap.net_jpy_invested).toBe(3_000_000 - 900_000);
			expect(cheap.crypto_withdrawal_valuation).toEqual({
				deposit_date_price_count: 1,
				current_price_fallback_count: 0,
				basis: 'deposit_date_price',
			});
		});

		it('出庫日の価格が無ければ現在価格にフォールバックし、内訳で申告する', () => {
			// 入庫日の足だけ持たせ、出庫日は解けない状況を作る
			const pricing = withDailyPrices(
				[{ asset: 'btc', atMs: FLOW_MS, price: FLOW_DAY_PRICE }],
				new Map([['btc', 20_000_000]]),
			);
			const result = calcDepositWithdrawalSummary(dw, 3_000_000, pricing);

			expect(result.crypto_withdrawal_estimated_jpy).toBe(2_000_000);
			expect(result.crypto_withdrawal_valuation).toEqual({
				deposit_date_price_count: 0,
				current_price_fallback_count: 1,
				basis: 'current_price_fallback',
			});
		});

		it('入庫と出庫の内訳は別フィールドで、互いに混ざらない', () => {
			const mixed = makeDwData({
				deposits: [makeDeposit({ uuid: 'd-btc', asset: 'btc', amount: '0.5', confirmed_at: FLOW_MS })],
				// 出庫日の足が無い → 出庫だけ現在価格フォールバックになる
				withdrawals: [makeWithdrawal({ uuid: 'w-btc', asset: 'btc', amount: '0.1', requested_at: withdrawalDayMs })],
			});
			const pricing = withDailyPrices(
				[{ asset: 'btc', atMs: FLOW_MS, price: FLOW_DAY_PRICE }],
				new Map([['btc', 20_000_000]]),
			);
			const result = calcDepositWithdrawalSummary(mixed, 5_000_000, pricing);

			expect(result.crypto_deposit_valuation?.basis).toBe('deposit_date_price');
			expect(result.crypto_withdrawal_valuation?.basis).toBe('current_price_fallback');
			expect(result.net_jpy_invested).toBe(Math.round(0.5 * FLOW_DAY_PRICE) - 0.1 * 20_000_000);
		});
	});

	describe('calcPeriodDWSummary — 入庫・出庫それぞれの換算方式を申告する', () => {
		it('出庫は requested_at 当日の始値で換算し、内訳を別フィールドで返す', () => {
			const withdrawalDayMs = Date.UTC(2025, 5, 11, 3, 0, 0, 0);
			const dw = makeDwData({
				deposits: [makeDeposit({ uuid: 'd-btc', asset: 'btc', amount: '0.2', confirmed_at: FLOW_MS })],
				withdrawals: [makeWithdrawal({ uuid: 'w-btc', asset: 'btc', amount: '0.1', requested_at: withdrawalDayMs })],
			});
			// 入庫日と出庫日で別の始値を持たせ、日付ごとに引き分けられていることを見る
			const pricing = withDailyPrices(
				[
					{ asset: 'btc', atMs: FLOW_MS, price: FLOW_DAY_PRICE },
					{ asset: 'btc', atMs: withdrawalDayMs, price: 9_000_000 },
				],
				new Map([['btc', 30_000_000]]),
			);
			const result = calcPeriodDWSummary(dw, 0, 'start', 'end', pricing);

			expect(result.crypto_deposit_estimated_jpy).toBe(Math.round(0.2 * FLOW_DAY_PRICE));
			expect(result.crypto_withdrawal_estimated_jpy).toBe(Math.round(0.1 * 9_000_000));
			expect(result.crypto_deposit_valuation?.basis).toBe('deposit_date_price');
			expect(result.crypto_withdrawal_valuation?.basis).toBe('deposit_date_price');
		});
	});

	describe('collectFlowValuationTargets', () => {
		const dw = makeDwData({
			deposits: [
				makeDeposit({ uuid: 'd-btc', asset: 'btc', amount: '0.5', confirmed_at: FLOW_MS }),
				// JPY は換算不要
				makeDeposit({ uuid: 'd-jpy', asset: 'jpy', amount: '1000', confirmed_at: FLOW_MS }),
				// 未完了は集計対象外
				makeDeposit({ uuid: 'd-pending', asset: 'eth', amount: '1', status: 'CONFIRMED', confirmed_at: FLOW_MS }),
				// 数量ゼロ・数値不正は金額に寄与しない
				makeDeposit({ uuid: 'd-zero', asset: 'eth', amount: '0', confirmed_at: FLOW_MS }),
				makeDeposit({ uuid: 'd-nan', asset: 'eth', amount: 'abc', confirmed_at: FLOW_MS }),
			],
			withdrawals: [makeWithdrawal({ uuid: 'w-eth', asset: 'eth', amount: '1', requested_at: FLOW_MS })],
		});

		it('DONE・非 JPY・数量が正の入出庫だけを返す（出庫は requested_at）', () => {
			expect(collectFlowValuationTargets(dw)).toEqual([
				{ asset: 'btc', atMs: FLOW_MS, kind: 'deposit' },
				{ asset: 'eth', atMs: FLOW_MS, kind: 'withdrawal' },
			]);
		});

		/**
		 * `kind` は `fetchFlowDatePrices` が年 chunk の予算を入庫用・出庫用に分けるための情報（#76）。
		 * ここで取り違えると出庫が入庫の枠を食い、取得原価が実行ごとに変わる状態に戻る。
		 */
		it('入庫は kind=deposit、出庫は kind=withdrawal を付ける', () => {
			const targets = collectFlowValuationTargets(dw);
			expect(targets.filter((t) => t.kind === 'deposit').map((t) => t.asset)).toEqual(['btc']);
			expect(targets.filter((t) => t.kind === 'withdrawal').map((t) => t.asset)).toEqual(['eth']);
		});

		it('下限時刻で期間外を落とす', () => {
			const since = (ms: number) => ({ depositsSinceMs: ms, withdrawalsSinceMs: ms });
			expect(collectFlowValuationTargets(dw, since(FLOW_MS + 1))).toEqual([]);
			expect(collectFlowValuationTargets(dw, since(FLOW_MS))).toHaveLength(2);
		});

		/**
		 * 入庫と出庫で消費者が違う: 入庫は常に全履歴（純投入額・口座全体リターン・取得原価）、
		 * 出庫は入出金分析セクションがある構成だけ全履歴で、無ければ期間集計だけが消費者になる。
		 * 片方の下限で両方を絞ると、出力に出ない入出庫のために candle を取りに行ってしまう
		 * （逆に反映先があるのに絞ると、その入出庫が黙って 0 円計上になる）。
		 */
		it('入庫と出庫の下限を別々に適用する', () => {
			// 入庫は全履歴、出庫だけ FLOW_MS より後に絞る → 出庫が落ちて入庫だけ残る
			expect(collectFlowValuationTargets(dw, { withdrawalsSinceMs: FLOW_MS + 1 })).toEqual([
				{ asset: 'btc', atMs: FLOW_MS, kind: 'deposit' },
			]);
			// 逆に入庫だけ絞る → 出庫だけ残る
			expect(collectFlowValuationTargets(dw, { depositsSinceMs: FLOW_MS + 1 })).toEqual([
				{ asset: 'eth', atMs: FLOW_MS, kind: 'withdrawal' },
			]);
		});

		it('scope 省略なら全履歴（入庫・出庫とも絞らない）', () => {
			expect(collectFlowValuationTargets(dw)).toHaveLength(2);
		});

		it('dw が null なら空配列', () => {
			expect(collectFlowValuationTargets(null)).toEqual([]);
		});
	});

	describe('summarizeFlowValuation', () => {
		const targets: FlowValuationTarget[] = [
			{ asset: 'btc', atMs: FLOW_MS, kind: 'deposit' },
			{ asset: 'eth', atMs: FLOW_MS, kind: 'deposit' },
			{ asset: 'doge', atMs: FLOW_MS, kind: 'withdrawal' },
		];

		it('母集合を 1 度だけ数える（各セクションの内訳を足し合わせない）', () => {
			const pricing = withDailyPrices(
				[{ asset: 'btc', atMs: FLOW_MS, price: FLOW_DAY_PRICE }],
				new Map([['eth', 400_000]]),
			);
			// btc=日次、eth=現在価格、doge=解決不能（数えない）
			expect(summarizeFlowValuation(targets, pricing)).toEqual({
				deposit_date_price_count: 1,
				current_price_fallback_count: 1,
				basis: 'mixed',
			});
		});

		it('対象が空なら undefined', () => {
			expect(summarizeFlowValuation([], currentPriceOnly())).toBeUndefined();
		});

		it('全件で価格を解決できなければ undefined（換算していないので内訳も無い）', () => {
			expect(summarizeFlowValuation(targets, currentPriceOnly())).toBeUndefined();
		});

		/**
		 * `basis` と 2 つの件数の整合は**構築時に保証する**（`buildFlowValuationBreakdown` が唯一の
		 * 生成経路）。スキーマ側で refine して弾く方針は取らない——`AnalyzeMyPortfolioOutputSchema`
		 * の parse 失敗はレスポンス全体を fail に落とすため、ラベルの不整合を理由に
		 * ポートフォリオ分析ごと失わせるのは割に合わない。代わりに不変条件をここで固定する。
		 */
		it('不変条件: basis は 2 つの件数から一意に決まり、件数は必ず非負整数', () => {
			// `summarizeFlowValuation` は `kind` を読まない（換算方式は asset と atMs だけで決まる）が、
			// 母集合の型は `FlowValuationTarget` なので入庫・出庫のどちらかを名乗る必要がある。
			// 上の `targets` と揃えて入庫にする——この describe が見ているのは `deposit_date_price` /
			// `current_price_fallback` の件数であって、入庫・出庫の区別（#76 の chunk 予算分離）は
			// `collectFlowValuationTargets` の describe が別に固定している。
			const dated: FlowValuationTarget = { asset: 'btc', atMs: FLOW_MS, kind: 'deposit' };
			const fallback: FlowValuationTarget = { asset: 'eth', atMs: FLOW_MS, kind: 'deposit' };
			const pricing = withDailyPrices(
				[{ asset: 'btc', atMs: FLOW_MS, price: FLOW_DAY_PRICE }],
				new Map([['eth', 400_000]]),
			);

			// (dated 件数, fallback 件数) の全組み合わせを網羅する
			const cases: Array<{ input: typeof targets; dated: number; fallback: number }> = [
				{ input: [], dated: 0, fallback: 0 },
				{ input: [dated], dated: 1, fallback: 0 },
				{ input: [fallback], dated: 0, fallback: 1 },
				{ input: [dated, fallback], dated: 1, fallback: 1 },
				{ input: [dated, dated, fallback], dated: 2, fallback: 1 },
			];

			for (const c of cases) {
				const result = summarizeFlowValuation(c.input, pricing);
				if (c.dated === 0 && c.fallback === 0) {
					// 換算 0 件は内訳ごと落とす（'mixed' の 0/0 のような無意味な組み合わせを作らない）
					expect(result).toBeUndefined();
					continue;
				}
				expect(result).toBeDefined();
				expect(result?.deposit_date_price_count).toBe(c.dated);
				expect(result?.current_price_fallback_count).toBe(c.fallback);
				expect(Number.isInteger(result?.deposit_date_price_count)).toBe(true);
				expect(Number.isInteger(result?.current_price_fallback_count)).toBe(true);
				// basis は件数から一意に決まる
				const expected = c.fallback === 0 ? 'deposit_date_price' : c.dated === 0 ? 'current_price_fallback' : 'mixed';
				expect(result?.basis).toBe(expected);
				// 'mixed' は必ず両方が正
				if (result?.basis === 'mixed') {
					expect(c.dated).toBeGreaterThan(0);
					expect(c.fallback).toBeGreaterThan(0);
				}
			}
		});
	});
});

// ── 期間ネットフロー ──

describe('calcPeriodNetFlow', () => {
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

	it('価格を引けない暗号資産の入庫: 資産名が unpriced_assets に載る（0 円計上を黙って落とさない）', () => {
		const dw = makeDwData({
			deposits: [makeDeposit({ uuid: 'd-doge', asset: 'doge', amount: '1000', confirmed_at: 2000 })],
		});
		const result = calcPeriodNetFlow(dw, 1000, currentPriceOnly());
		expect(result.net_flow_jpy).toBe(0); // 価格不明なので計上されない（＝過小になる）
		expect(result.unpriced_assets).toEqual(['doge']);
	});

	it('価格を引けない暗号資産の出庫: 資産名が unpriced_assets に載る', () => {
		const dw = makeDwData({
			withdrawals: [makeWithdrawal({ uuid: 'w-doge', asset: 'doge', amount: '1000', fee: '5', requested_at: 2000 })],
		});
		const result = calcPeriodNetFlow(dw, 1000, currentPriceOnly());
		expect(result.net_flow_jpy).toBe(0);
		// 出金手数料も JPY 換算できていない
		expect(result.withdrawal_fee_jpy).toBe(0);
		expect(result.unpriced_assets).toEqual(['doge']);
	});

	it('価格が全て引ける場合: unpriced_assets は付かず valuation で換算方式を申告する', () => {
		const dw = makeDwData({
			deposits: [makeDeposit({ uuid: 'd-btc', asset: 'btc', amount: '0.5', confirmed_at: 2000 })],
			withdrawals: [makeWithdrawal({ uuid: 'w-eth', asset: 'eth', amount: '1', fee: '0.005', requested_at: 2000 })],
		});
		const prices = new Map([
			['btc', 10_000_000],
			['eth', 400_000],
		]);
		const result = calcPeriodNetFlow(dw, 1000, currentPriceOnly(prices));
		// 入庫 5_000_000 - 出庫 400_000 = 4_600_000、手数料 0.005 * 400_000 = 2_000
		expect(result).toEqual({
			net_flow_jpy: 4_600_000,
			withdrawal_fee_jpy: 2_000,
			measured: true,
			// 日次価格が無いので 2 件とも現在価格フォールバックで換算された
			valuation: {
				deposit_date_price_count: 0,
				current_price_fallback_count: 2,
				basis: 'current_price_fallback',
			},
		});
		expect(Object.keys(result)).toEqual(['net_flow_jpy', 'withdrawal_fee_jpy', 'measured', 'valuation']);
	});

	it('dw が null: 0 ではなく未計測（null + measured=false）を返す', () => {
		// 0 を返すと呼び出し側で「本当にフローがゼロ」と区別できず、
		// adjusted_change = change - 0 がフローゼロ前提の確定値になってしまう。
		const result = calcPeriodNetFlow(null, 1000, currentPriceOnly());
		expect(result).toEqual({ net_flow_jpy: null, withdrawal_fee_jpy: null, measured: false });
	});

	it('履歴 0 件の dw: 未計測ではなく実測の 0（本当にフローがゼロ）', () => {
		const result = calcPeriodNetFlow(makeDwData(), 1000, currentPriceOnly());
		expect(result).toEqual({ net_flow_jpy: 0, withdrawal_fee_jpy: 0, measured: true });
	});

	it('JPY の入出金は価格解決の対象外: prices が空でも warning を出さない', () => {
		const dw = makeDwData({
			deposits: [makeDeposit({ uuid: 'd-jpy', asset: 'jpy', amount: '1000000', confirmed_at: 2000 })],
			withdrawals: [makeWithdrawal({ uuid: 'w-jpy', asset: 'jpy', amount: '200000', fee: '550', requested_at: 2000 })],
		});
		const result = calcPeriodNetFlow(dw, 1000, currentPriceOnly());
		expect(result.net_flow_jpy).toBe(800_000);
		expect(result.withdrawal_fee_jpy).toBe(550);
		expect(result.unpriced_assets).toBeUndefined();
		// JPY は換算不要なので valuation も立たない（キーごと落ちて従来出力と JSON 一致する）
		expect(result.valuation).toBeUndefined();
		expect(Object.keys(result)).toEqual(['net_flow_jpy', 'withdrawal_fee_jpy', 'measured']);
	});

	it('同一資産が複数件落ちても資産名は重複しない（昇順で返る）', () => {
		const dw = makeDwData({
			deposits: [
				makeDeposit({ uuid: 'd-doge-1', asset: 'doge', amount: '1000', confirmed_at: 2000 }),
				makeDeposit({ uuid: 'd-doge-2', asset: 'doge', amount: '2000', confirmed_at: 3000 }),
				makeDeposit({ uuid: 'd-mona', asset: 'mona', amount: '10', confirmed_at: 3000 }),
			],
			withdrawals: [makeWithdrawal({ uuid: 'w-doge', asset: 'doge', amount: '500', requested_at: 4000 })],
		});
		const result = calcPeriodNetFlow(dw, 1000, currentPriceOnly());
		expect(result.unpriced_assets).toEqual(['doge', 'mona']);
	});

	it('期間外・未完了の入出庫は価格が無くても warning に載らない', () => {
		const dw = makeDwData({
			deposits: [
				makeDeposit({ uuid: 'd-old', asset: 'doge', amount: '1000', confirmed_at: 500 }), // sinceMs 未満
				makeDeposit({ uuid: 'd-pending', asset: 'mona', amount: '10', status: 'CONFIRMED', confirmed_at: 2000 }),
			],
			withdrawals: [
				makeWithdrawal({ uuid: 'w-old', asset: 'doge', amount: '500', requested_at: 500 }),
				makeWithdrawal({ uuid: 'w-pending', asset: 'mona', amount: '5', status: 'PROCESSING', requested_at: 2000 }),
			],
		});
		const result = calcPeriodNetFlow(dw, 1000, currentPriceOnly());
		expect(result).toEqual({ net_flow_jpy: 0, withdrawal_fee_jpy: 0, measured: true });
	});

	it('数量ゼロ・数値不正の入出庫は金額に寄与しないため warning に載らない', () => {
		const dw = makeDwData({
			deposits: [
				makeDeposit({ uuid: 'd-zero', asset: 'doge', amount: '0', confirmed_at: 2000 }),
				makeDeposit({ uuid: 'd-nan', asset: 'mona', amount: 'abc', confirmed_at: 2000 }),
			],
			withdrawals: [makeWithdrawal({ uuid: 'w-zero', asset: 'doge', amount: '0', requested_at: 2000 })],
		});
		const result = calcPeriodNetFlow(dw, 1000, currentPriceOnly());
		expect(result.unpriced_assets).toBeUndefined();
	});
});

// ── 入出金データの利用可否 ──

describe('resolveDepositWithdrawalStatus / flowUnavailableReasonFor', () => {
	/** 取得成功・警告なし・履歴 0 件を既定とする DepositWithdrawalData を組み立てる。 */
	function makeDw(overrides: Partial<DepositWithdrawalData> = {}): DepositWithdrawalData {
		return { deposits: [], withdrawals: [], warnings: [], allFailed: false, isComplete: true, ...overrides };
	}

	const someDeposit = { uuid: 'd', asset: 'jpy', amount: '1000', status: 'DONE', found_at: 1, confirmed_at: 1 };

	it('include_deposit_withdrawal=false: セクションは not_requested でも理由コードは立たない', () => {
		// 表示フラグは取得可否を握らない。損益を出す構成なら履歴は取得済みなので、
		// 取得結果（ここでは取得成功・履歴あり）だけで原価の信頼性が決まる。
		const dw = makeDw({ deposits: [someDeposit] });
		expect(resolveDepositWithdrawalStatus(false, dw)).toBe('not_requested');
		expect(flowUnavailableReasonFor(dw)).toBeUndefined();
	});

	it('取得成功かつ履歴あり: available → 理由コードなし（取得原価を出してよい）', () => {
		const dw = makeDw({ deposits: [someDeposit] });
		const status = resolveDepositWithdrawalStatus(true, dw);
		expect(status).toBe('available');
		expect(flowUnavailableReasonFor(dw)).toBeUndefined();
	});

	it('取得成功・警告なし・履歴 0 件: no_history → 理由コードなし（本当に出庫ゼロ）', () => {
		const dw = makeDw();
		const status = resolveDepositWithdrawalStatus(true, dw);
		expect(status).toBe('no_history');
		expect(flowUnavailableReasonFor(dw)).toBeUndefined();
	});

	it('全リクエスト失敗: fallback → dw_fetch_failed', () => {
		const dw = makeDw({ allFailed: true });
		const status = resolveDepositWithdrawalStatus(true, dw);
		expect(status).toBe('fallback');
		expect(flowUnavailableReasonFor(dw)).toBe('dw_fetch_failed');
	});

	it('partial failure で履歴 0 件: fallback（warning ありは「本当に 0 件」と区別できない）', () => {
		const dw = makeDw({ warnings: ['一部失敗'] });
		const status = resolveDepositWithdrawalStatus(true, dw);
		expect(status).toBe('fallback');
		expect(flowUnavailableReasonFor(dw)).toBe('dw_fetch_failed');
	});

	it('partial failure だが履歴が残っている: status は available のまま理由コードは dw_fetch_failed', () => {
		// fetchDepositWithdrawal は 4 チャネルを個別に取得するため、暗号資産出庫チャネルだけ
		// 落ちても他にレコードがあれば allFailed=false → available になる。
		// このとき cost_basis を過大化させる当の出庫が欠けているので、原価は信頼できない。
		const dw = makeDw({ deposits: [someDeposit], warnings: ['暗号資産出庫履歴の取得に失敗: 10007'] });
		const status = resolveDepositWithdrawalStatus(true, dw);
		expect(status).toBe('available');
		expect(flowUnavailableReasonFor(dw)).toBe('dw_fetch_failed');
	});

	it('件数上限で打ち切られた履歴: available のまま dw_history_incomplete', () => {
		// 取得自体は成功しているので「失敗」とは別コード（再実行しても解消しない）
		const dw = makeDw({ deposits: [someDeposit], isComplete: false });
		const status = resolveDepositWithdrawalStatus(true, dw);
		expect(status).toBe('available');
		expect(flowUnavailableReasonFor(dw)).toBe('dw_history_incomplete');
	});

	it('dw が null: status は fallback、理由コードは dw_fetch_failed', () => {
		// 損益を出す構成では入出金履歴を常に取得するので、null は取得が落ちたときだけ。
		// 表示フラグの値に関わらず「未取得」ではなく「取得失敗」として扱う。
		expect(resolveDepositWithdrawalStatus(true, null)).toBe('fallback');
		expect(resolveDepositWithdrawalStatus(false, null)).toBe('not_requested');
		expect(flowUnavailableReasonFor(null)).toBe('dw_fetch_failed');
	});
});

// ── 期間別パフォーマンス（評価額比較） ──

describe('buildPeriodPerformance', () => {
	/** boundaryPrices を 3 期間まとめて生成 */
	function makeBoundaryPrices(
		entries: Array<[string, { yearStart?: number; monthStart?: number; dayStart?: number }]>,
	): CandlePriceData['boundaryPrices'] {
		return new Map(entries);
	}

	function makeEmptyDw(): DepositWithdrawalData {
		return { deposits: [], withdrawals: [], warnings: [], allFailed: false, isComplete: true };
	}

	function makeCtx(overrides: Partial<PortfolioPerformanceContext> = {}): PortfolioPerformanceContext {
		return {
			currentHoldings: [],
			trades: [],
			dwData: null,
			candlePriceData: { boundaryPrices: new Map(), dailyPrices: new Map() },
			flowPricing: currentPriceOnly(),
			currentValue: 0,
			nowIso: '2026-05-16T12:00:00+09:00',
			...overrides,
		};
	}

	it('入出金なし: change_jpy = currentValue - startValue, adjusted_change_jpy == change_jpy', () => {
		// 期初保有 1 BTC @ 10_000_000 = 10_000_000、現在 12_000_000
		// 期間内に売買・入出金なし → 期初保有はそのまま現在保有と一致する
		const ctx = makeCtx({
			currentHoldings: [{ asset: 'btc', amount: '1' }],
			// 「入出金なし」= 履歴 0 件を取得できた状態。null（未取得）とは区別する
			dwData: makeEmptyDw(),
			candlePriceData: {
				boundaryPrices: makeBoundaryPrices([['btc', { yearStart: 10_000_000 }]]),
				dailyPrices: new Map(),
			},
			flowPricing: currentPriceOnly(new Map([['btc', 12_000_000]])),
			currentValue: 12_000_000,
		});
		const result = buildPeriodPerformance({ key: 'yearly', startMs: 1000, startIso: '2026-01-01T00:00:00+09:00' }, ctx);
		expect(result.start_value_jpy).toBe(10_000_000);
		expect(result.current_value_jpy).toBe(12_000_000);
		expect(result.change_jpy).toBe(2_000_000);
		expect(result.change_pct).toBe(20); // 2_000_000 / 10_000_000 = 0.2
		expect(result.net_flow_jpy).toBe(0);
		expect(result.withdrawal_fee_jpy).toBe(0);
		expect(result.adjusted_change_jpy).toBe(2_000_000); // change - 0
		expect(result.adjusted_change_pct).toBe(20);
		expect(result.period_start).toBe('2026-01-01T00:00:00+09:00');
		expect(result.period_end).toBe('2026-05-16T12:00:00+09:00');
		expect(result.note).toBe(PERFORMANCE_NOTE);
		expect(result.flow_measured).toBe(true);
		expect(result.flow_unavailable_reason).toBeUndefined();
	});

	it('入出金あり: net_flow を差し引いた adjusted_change が算出される', () => {
		// 期初保有 1 BTC @ 10_000_000 = 10_000_000、現在 12_500_000
		// 期間内に JPY 入金 500_000 → 単純増減 2_500_000 のうち 500_000 は入金由来。
		// 調整後増減 = 2_500_000 - 500_000 = 2_000_000（市場由来）
		const dw: DepositWithdrawalData = {
			deposits: [{ uuid: 'd-jpy', asset: 'jpy', amount: '500000', status: 'DONE', found_at: 1500, confirmed_at: 1500 }],
			withdrawals: [],
			warnings: [],
			allFailed: false,
			isComplete: true,
		};
		const ctx = makeCtx({
			currentHoldings: [{ asset: 'btc', amount: '1' }],
			dwData: dw,
			candlePriceData: {
				boundaryPrices: makeBoundaryPrices([['btc', { yearStart: 10_000_000 }]]),
				dailyPrices: new Map(),
			},
			flowPricing: currentPriceOnly(new Map([['btc', 12_500_000]])),
			currentValue: 12_500_000,
		});
		const result = buildPeriodPerformance({ key: 'yearly', startMs: 1000, startIso: '2026-01-01T00:00:00+09:00' }, ctx);
		expect(result.start_value_jpy).toBe(10_000_000);
		expect(result.change_jpy).toBe(2_500_000);
		expect(result.net_flow_jpy).toBe(500_000);
		expect(result.adjusted_change_jpy).toBe(2_000_000);
		expect(result.change_pct).toBe(25); // 2_500_000 / 10_000_000
		expect(result.adjusted_change_pct).toBe(20); // 2_000_000 / 10_000_000
	});

	it('出金手数料: withdrawal_fee_jpy に集計され adjusted_change にコストとして残る', () => {
		// 現在保有: JPY 900_000（市場変動なし、純粋に出金のみの口座を想定）
		// 期間内 (t=1500): JPY 出金 100_000 + fee 1_000 → 口座から減ったのは 101_000
		// reconstructHoldingsAtDate は完了出金を逆算: 期初 JPY = 900_000 + 100_000 + 1_000 = 1_001_000
		// 単純増減 = 900_000 - 1_001_000 = -101_000
		// net_flow = -100_000（元本のみ、fee 除外）
		// 調整後増減 = -101_000 - (-100_000) = -1_000（fee がコストとして残る）
		const dw: DepositWithdrawalData = {
			deposits: [],
			withdrawals: [{ uuid: 'w-jpy', asset: 'jpy', amount: '100000', fee: '1000', status: 'DONE', requested_at: 1500 }],
			warnings: [],
			allFailed: false,
			isComplete: true,
		};
		const ctx = makeCtx({
			currentHoldings: [{ asset: 'jpy', amount: '900000' }],
			dwData: dw,
			candlePriceData: { boundaryPrices: new Map(), dailyPrices: new Map() },
			flowPricing: currentPriceOnly(),
			currentValue: 900_000,
		});
		const result = buildPeriodPerformance({ key: 'yearly', startMs: 1000, startIso: 's' }, ctx);
		expect(result.start_value_jpy).toBe(1_001_000);
		expect(result.change_jpy).toBe(-101_000);
		expect(result.net_flow_jpy).toBe(-100_000);
		expect(result.withdrawal_fee_jpy).toBe(1_000);
		expect(result.adjusted_change_jpy).toBe(-1_000); // fee 分のみがコストとして残る
	});

	it('保有 0 ケース: start_value=0 で change_pct / adjusted_change_pct が undefined', () => {
		// 期初保有なし、現在は入金 1_000_000 のみで保有形成
		// → start_value_jpy = 0、change_pct / adjusted_change_pct は undefined（0 除算回避）
		const dw: DepositWithdrawalData = {
			deposits: [
				{ uuid: 'd-jpy', asset: 'jpy', amount: '1000000', status: 'DONE', found_at: 1500, confirmed_at: 1500 },
			],
			withdrawals: [],
			warnings: [],
			allFailed: false,
			isComplete: true,
		};
		const ctx = makeCtx({
			currentHoldings: [{ asset: 'jpy', amount: '1000000' }],
			dwData: dw,
			candlePriceData: { boundaryPrices: new Map(), dailyPrices: new Map() },
			flowPricing: currentPriceOnly(),
			currentValue: 1_000_000,
		});
		const result = buildPeriodPerformance({ key: 'yearly', startMs: 1000, startIso: '2026-01-01T00:00:00+09:00' }, ctx);
		expect(result.start_value_jpy).toBe(0);
		expect(result.change_jpy).toBe(1_000_000);
		expect(result.net_flow_jpy).toBe(1_000_000);
		expect(result.adjusted_change_jpy).toBe(0);
		expect(result.change_pct).toBeUndefined();
		expect(result.adjusted_change_pct).toBeUndefined();
		expect(result.change_pct_unavailable_reason).toBe('start_value_zero');
	});

	/**
	 * #71: 期初評価額が極小のとき増減率が意味を持たない。
	 *
	 * 分母がゼロでさえなければ通す従来のガードでは、年初にほぼ空だった口座に入金して運用を
	 * 始めた場合に 5 桁の百分率（+26929.2% 等）が出る。抑止の基準は `MIN_START_VALUE_RATIO`
	 * （期初評価額が現在評価額の 1% 未満）。以下のブロックはその境界と 3 期間の一致を固定する。
	 */
	describe('増減率の抑止（期初評価額が現在評価額に対して極小）', () => {
		/**
		 * JPY 単独口座で「現在 `currentValue` 円・うち `depositAmount` 円が期間中の入金」の
		 * コンテキストを作る。期初評価額 = currentValue - depositAmount（入金を巻き戻した値）。
		 * 価格解決を挟まないので期初評価額を 1 円単位で狙える。
		 */
		function jpyDepositCtx(currentValue: number, depositAmount: number): PortfolioPerformanceContext {
			const dw: DepositWithdrawalData = {
				deposits: [
					{
						uuid: 'd-jpy',
						asset: 'jpy',
						amount: String(depositAmount),
						status: 'DONE',
						found_at: 1500,
						confirmed_at: 1500,
					},
				],
				withdrawals: [],
				warnings: [],
				allFailed: false,
				isComplete: true,
			};
			return makeCtx({
				currentHoldings: [{ asset: 'jpy', amount: String(currentValue) }],
				dwData: dw,
				candlePriceData: { boundaryPrices: new Map(), dailyPrices: new Map() },
				flowPricing: currentPriceOnly(),
				currentValue,
			});
		}

		it('期初評価額が現在評価額の 1% 未満: 率を落として金額だけ残す（5 桁の百分率を出さない）', () => {
			// issue #71 の実測構成: 期初 5,745 円 → 現在 1,552,826 円（差の 1,547,081 円は期間中の入金）。
			// 従来ガードでは change_pct = +26929.2% が出ていた。
			const result = buildPeriodPerformance(
				{ key: 'yearly', startMs: 1000, startIso: 's' },
				jpyDepositCtx(1_552_826, 1_547_081),
			);
			expect(result.start_value_jpy).toBe(5_745);
			expect(result.change_jpy).toBe(1_547_081); // 金額は残す
			expect(result.change_pct).toBeUndefined();
			expect(result.adjusted_change_pct).toBeUndefined();
			expect(result.change_pct_unavailable_reason).toBe('start_value_negligible');
		});

		it('境界ちょうど（期初 = 現在の 1%）: 率を出す', () => {
			// 現在 1,000,000 / 期初 10,000 = ちょうど 1%。閾値ちょうどは「率を出す」側に入れる。
			const result = buildPeriodPerformance(
				{ key: 'yearly', startMs: 1000, startIso: 's' },
				jpyDepositCtx(1_000_000, 990_000),
			);
			expect(result.start_value_jpy).toBe(10_000);
			expect(result.change_pct).toBe(9900); // 990_000 / 10_000
			expect(result.adjusted_change_pct).toBe(0); // 増減が全額入金由来
			expect(result.change_pct_unavailable_reason).toBeUndefined();
		});

		it('境界のわずかに上（期初が 1% + 1 円）: 率を出す', () => {
			const result = buildPeriodPerformance(
				{ key: 'yearly', startMs: 1000, startIso: 's' },
				jpyDepositCtx(1_000_000, 989_999),
			);
			expect(result.start_value_jpy).toBe(10_001);
			expect(result.change_pct).toBe(9899); // 989,999 / 10,001
			expect(result.change_pct_unavailable_reason).toBeUndefined();
		});

		it('境界のわずかに下（期初が 1% - 1 円）: 率を落とす', () => {
			const result = buildPeriodPerformance(
				{ key: 'yearly', startMs: 1000, startIso: 's' },
				jpyDepositCtx(1_000_000, 990_001),
			);
			expect(result.start_value_jpy).toBe(9_999);
			expect(result.change_jpy).toBe(990_001);
			expect(result.change_pct).toBeUndefined();
			expect(result.adjusted_change_pct).toBeUndefined();
			expect(result.change_pct_unavailable_reason).toBe('start_value_negligible');
		});

		it('daily / monthly / yearly の 3 期間で同じ判定になる（共通経路 buildPeriodPerformance）', () => {
			const ctx = jpyDepositCtx(1_552_826, 1_547_081);
			for (const key of ['daily', 'monthly', 'yearly'] as const) {
				const result = buildPeriodPerformance({ key, startMs: 1000, startIso: 's' }, ctx);
				expect(result.change_pct, key).toBeUndefined();
				expect(result.adjusted_change_pct, key).toBeUndefined();
				expect(result.change_pct_unavailable_reason, key).toBe('start_value_negligible');
			}
		});

		it('通常規模の期初評価額では従来どおり率が出る（回帰）', () => {
			// 期初 500,000 / 現在 1,000,000 → 期初は現在の 50% で閾値を大きく上回る。
			const result = buildPeriodPerformance(
				{ key: 'yearly', startMs: 1000, startIso: 's' },
				jpyDepositCtx(1_000_000, 500_000),
			);
			expect(result.start_value_jpy).toBe(500_000);
			expect(result.change_pct).toBe(100);
			expect(result.adjusted_change_pct).toBe(0);
			expect(result.change_pct_unavailable_reason).toBeUndefined();
		});

		it('純入出金が未計測なら adjusted_change_pct は null が優先される（抑止の undefined ではない）', () => {
			// 「率を出せない」（undefined）と「そもそも算出できない」（null）は別の意味なので潰さない。
			const ctx = { ...jpyDepositCtx(1_552_826, 1_547_081), flowUnavailableReason: 'dw_history_incomplete' as const };
			const result = buildPeriodPerformance({ key: 'yearly', startMs: 1000, startIso: 's' }, ctx);
			expect(result.change_pct).toBeUndefined();
			expect(result.adjusted_change_pct).toBeNull();
			expect(result.adjusted_change_jpy).toBeNull();
			expect(result.change_pct_unavailable_reason).toBe('start_value_negligible');
		});

		it('start_value_negligible では増減額の過大を申告しない（#105 回帰: 分子は正しい）', () => {
			// 期初が本当に小さいだけで change_jpy は実際の増減そのもの。フラグを立てると
			// 「読める値」を「読めない値」と誤って申告することになる。
			const result = buildPeriodPerformance(
				{ key: 'yearly', startMs: 1000, startIso: 's' },
				jpyDepositCtx(1_552_826, 1_547_081),
			);
			expect(result.change_pct_unavailable_reason).toBe('start_value_negligible');
			expect(result.change_jpy_overstated).toBeUndefined();
			expect(result.note).toBe(PERFORMANCE_NOTE);
			expect(JSON.stringify(result)).not.toContain('change_jpy_overstated');
		});

		it('start_value_zero でも増減額の過大を申告しない（#105 回帰）', () => {
			// 期初は空口座（全額が期間中の入金）。期初が本当に 0 なので change_jpy は正しい。
			const result = buildPeriodPerformance(
				{ key: 'yearly', startMs: 1000, startIso: 's' },
				jpyDepositCtx(1_000_000, 1_000_000),
			);
			expect(result.start_value_jpy).toBe(0);
			expect(result.change_pct_unavailable_reason).toBe('start_value_zero');
			expect(result.change_jpy_overstated).toBeUndefined();
			expect(result.note).toBe(PERFORMANCE_NOTE);
		});

		it('全額出金して現在評価額が 0 になった口座は抑止しない（-100% は意味のある率）', () => {
			// 期初 1,000,000 → 全額出金して現在 0。相対基準は分母（期初）側を見るので、
			// 現在評価額が小さいことを理由に率を落としてはいけない。
			const dw: DepositWithdrawalData = {
				deposits: [],
				withdrawals: [{ uuid: 'w-jpy', asset: 'jpy', amount: '1000000', fee: '0', status: 'DONE', requested_at: 1500 }],
				warnings: [],
				allFailed: false,
				isComplete: true,
			};
			const ctx = makeCtx({
				currentHoldings: [],
				dwData: dw,
				candlePriceData: { boundaryPrices: new Map(), dailyPrices: new Map() },
				flowPricing: currentPriceOnly(),
				currentValue: 0,
			});
			const result = buildPeriodPerformance({ key: 'yearly', startMs: 1000, startIso: 's' }, ctx);
			expect(result.start_value_jpy).toBe(1_000_000);
			expect(result.change_pct).toBe(-100);
			expect(result.change_pct_unavailable_reason).toBeUndefined();
		});
	});

	describe('期初の始値が解決できないときの増減率の抑止（#86）', () => {
		function btcJpyStartCtx(opts: {
			yearStart?: number;
			monthStart?: number;
			dayStart?: number;
			btcAmount?: string;
			jpyAmount?: string;
			currentBtcPrice?: number;
		}) {
			const btcAmount = opts.btcAmount ?? '0.1';
			const jpyAmount = opts.jpyAmount ?? '63314';
			const currentBtcPrice = opts.currentBtcPrice ?? 15_000_000;
			const boundary: { yearStart?: number; monthStart?: number; dayStart?: number } = {};
			if (opts.yearStart != null) boundary.yearStart = opts.yearStart;
			if (opts.monthStart != null) boundary.monthStart = opts.monthStart;
			if (opts.dayStart != null) boundary.dayStart = opts.dayStart;
			return makeCtx({
				currentHoldings: [
					{ asset: 'btc', amount: btcAmount },
					{ asset: 'jpy', amount: jpyAmount },
				],
				dwData: makeEmptyDw(),
				candlePriceData: {
					boundaryPrices: makeBoundaryPrices([['btc', boundary]]),
					dailyPrices: new Map(),
				},
				flowPricing: currentPriceOnly(new Map([['btc', currentBtcPrice]])),
				currentValue: Math.round(Number(btcAmount) * currentBtcPrice + Number(jpyAmount)),
			});
		}

		it('daily: dayStart 欠損 → 率 undefined + start_boundary_unpriced + unpriced_start_assets', () => {
			// issue #86 の機序: 当日足 open が未取得で暗号資産が期初評価から落ち、JPY だけになる。
			// 63,314 円は 1% 閾値を超えるため start_value_negligible では抑止されなかった。
			const ctx = btcJpyStartCtx({ yearStart: 10_000_000, monthStart: 10_000_000 });
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.start_value_jpy).toBe(63_314);
			expect(result.change_pct).toBeUndefined();
			expect(result.adjusted_change_pct).toBeUndefined();
			expect(result.change_pct_unavailable_reason).toBe('start_boundary_unpriced');
			expect(result.unpriced_start_assets).toEqual(['btc']);
			// 過大な率が出ないこと（+2394% 型）
			expect(JSON.stringify(result)).not.toMatch(/"change_pct":\s*\d{4,}/);
		});

		it('価格が揃っている通常時: 従来どおり率が出る（回帰）', () => {
			const ctx = btcJpyStartCtx({
				yearStart: 10_000_000,
				monthStart: 10_000_000,
				dayStart: 11_000_000,
				jpyAmount: '0',
				btcAmount: '1',
			});
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.start_value_jpy).toBe(11_000_000);
			expect(result.change_pct).toBeDefined();
			expect(result.change_pct_unavailable_reason).toBeUndefined();
			expect(result.unpriced_start_assets).toBeUndefined();
		});

		it('一部資産だけ欠損: 欠損資産のみ unpriced_start_assets に載る', () => {
			const ctx = makeCtx({
				currentHoldings: [
					{ asset: 'btc', amount: '0.1' },
					{ asset: 'eth', amount: '1' },
				],
				dwData: makeEmptyDw(),
				candlePriceData: {
					boundaryPrices: makeBoundaryPrices([
						['btc', { dayStart: 15_000_000 }],
						['eth', { yearStart: 400_000 }],
					]),
					dailyPrices: new Map(),
				},
				flowPricing: currentPriceOnly(
					new Map([
						['btc', 15_000_000],
						['eth', 380_000],
					]),
				),
				currentValue: Math.round(0.1 * 15_000_000 + 1 * 380_000),
			});
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.unpriced_start_assets).toEqual(['eth']);
			expect(result.change_pct_unavailable_reason).toBe('start_boundary_unpriced');
		});

		it('全暗号資産の当該期間始値欠損: 期初評価額は JPY だけ', () => {
			const ctx = btcJpyStartCtx({ yearStart: 10_000_000, monthStart: 10_000_000 });
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.start_value_jpy).toBe(63_314);
			expect(result.unpriced_start_assets).toEqual(['btc']);
			expect(result.change_pct_unavailable_reason).toBe('start_boundary_unpriced');
		});

		it('JPY のみ保有: unpriced_start_assets を誤検知しない', () => {
			const ctx = makeCtx({
				currentHoldings: [{ asset: 'jpy', amount: '100000' }],
				dwData: makeEmptyDw(),
				candlePriceData: { boundaryPrices: new Map(), dailyPrices: new Map() },
				flowPricing: currentPriceOnly(),
				currentValue: 100_000,
			});
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.unpriced_start_assets).toBeUndefined();
			expect(result.change_pct_unavailable_reason).toBeUndefined();
			expect(result.change_pct).toBe(0);
		});

		it('start_value_negligible と start_boundary_unpriced を取り違えない（始値欠損を優先）', () => {
			// 期初 JPY 5,000 + BTC（dayStart 欠損）。JPY だけだと negligible だが原因は始値欠損。
			const ctx = btcJpyStartCtx({ yearStart: 10_000_000, jpyAmount: '5000' });
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.change_pct_unavailable_reason).toBe('start_boundary_unpriced');
			expect(result.change_pct_unavailable_reason).not.toBe('start_value_negligible');
		});

		it('daily / monthly / yearly の 3 期間で同じ判定になる（共通経路 buildPeriodPerformance）', () => {
			const ctx = makeCtx({
				currentHoldings: [
					{ asset: 'btc', amount: '0.1' },
					{ asset: 'jpy', amount: '63314' },
				],
				dwData: makeEmptyDw(),
				candlePriceData: { boundaryPrices: new Map(), dailyPrices: new Map() },
				flowPricing: currentPriceOnly(new Map([['btc', 15_000_000]])),
				currentValue: Math.round(0.1 * 15_000_000 + 63_314),
			});
			for (const key of ['daily', 'monthly', 'yearly'] as const) {
				const result = buildPeriodPerformance({ key, startMs: 1000, startIso: 's' }, ctx);
				expect(result.change_pct, key).toBeUndefined();
				expect(result.change_pct_unavailable_reason, key).toBe('start_boundary_unpriced');
				expect(result.unpriced_start_assets, key).toEqual(['btc']);
			}
		});

		it('boundaryPrices にエントリが無い資産: 過大な率を出さない（CodeRabbit 回帰）', () => {
			const ctx = makeCtx({
				currentHoldings: [
					{ asset: 'btc', amount: '0.1' },
					{ asset: 'jpy', amount: '1000000' },
				],
				dwData: makeEmptyDw(),
				candlePriceData: { boundaryPrices: new Map(), dailyPrices: new Map() },
				flowPricing: currentPriceOnly(new Map([['btc', 15_000_000]])),
				currentValue: 2_500_000,
			});
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.start_value_jpy).toBe(1_000_000);
			expect(result.change_pct).toBeUndefined();
			expect(result.adjusted_change_pct).toBeUndefined();
			expect(result.change_pct_unavailable_reason).toBe('start_boundary_unpriced');
			expect(result.unpriced_start_assets).toEqual(['btc']);
		});

		it('change_jpy は出したまま change_jpy_overstated=true を付ける（#105: 値 + フラグ）', () => {
			// 期初 63,314 円（JPY のみ）→ 現在 1,563,314 円。差の 1,500,000 円は BTC が期初評価から
			// 脱落した分そのものであって値動きではない。値は消さずフラグで申告する
			// （change_jpy = current_value_jpy - start_value_jpy なので消費者が再計算できてしまい、
			//   null 化は隠蔽にならず契約を壊すだけ）。
			const ctx = btcJpyStartCtx({ yearStart: 10_000_000, monthStart: 10_000_000 });
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.change_jpy).toBe(result.current_value_jpy - result.start_value_jpy);
			expect(result.change_jpy_overstated).toBe(true);
			// adjusted_change_jpy も同じ額だけ過大（純入出金は分母と無関係なので過大分が残る）
			expect(result.adjusted_change_jpy).toBe(result.change_jpy);
		});

		it('note に増減額も過大である旨を追記する（#105）', () => {
			const ctx = btcJpyStartCtx({ yearStart: 10_000_000, monthStart: 10_000_000 });
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.note).toBe(`${PERFORMANCE_NOTE}${PERFORMANCE_NOTE_CHANGE_OVERSTATED}`);
			expect(result.note).toContain('増減額を運用成績として読まないこと');
			expect(result.note).toContain('算出できない');
		});

		it('一部資産だけ欠損でもフラグは立つ（脱落分だけ過大）', () => {
			const ctx = makeCtx({
				currentHoldings: [
					{ asset: 'btc', amount: '0.1' },
					{ asset: 'eth', amount: '1' },
				],
				dwData: makeEmptyDw(),
				candlePriceData: {
					boundaryPrices: makeBoundaryPrices([
						['btc', { dayStart: 15_000_000 }],
						['eth', { yearStart: 400_000 }],
					]),
					dailyPrices: new Map(),
				},
				flowPricing: currentPriceOnly(
					new Map([
						['btc', 15_000_000],
						['eth', 380_000],
					]),
				),
				currentValue: Math.round(0.1 * 15_000_000 + 1 * 380_000),
			});
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.unpriced_start_assets).toEqual(['eth']);
			expect(result.change_jpy_overstated).toBe(true);
		});

		it('daily / monthly / yearly の 3 期間でフラグと note が一貫する（#105）', () => {
			const ctx = makeCtx({
				currentHoldings: [
					{ asset: 'btc', amount: '0.1' },
					{ asset: 'jpy', amount: '63314' },
				],
				dwData: makeEmptyDw(),
				candlePriceData: { boundaryPrices: new Map(), dailyPrices: new Map() },
				flowPricing: currentPriceOnly(new Map([['btc', 15_000_000]])),
				currentValue: Math.round(0.1 * 15_000_000 + 63_314),
			});
			for (const key of ['daily', 'monthly', 'yearly'] as const) {
				const result = buildPeriodPerformance({ key, startMs: 1000, startIso: 's' }, ctx);
				expect(result.change_jpy_overstated, key).toBe(true);
				expect(result.note, key).toContain(PERFORMANCE_NOTE_CHANGE_OVERSTATED);
			}
		});

		it('価格が揃っている通常時: フラグも note の追記も出ない（JSON 一致の回帰）', () => {
			const ctx = btcJpyStartCtx({
				yearStart: 10_000_000,
				monthStart: 10_000_000,
				dayStart: 11_000_000,
				jpyAmount: '0',
				btcAmount: '1',
			});
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.change_jpy_overstated).toBeUndefined();
			expect(result.note).toBe(PERFORMANCE_NOTE);
			expect(JSON.stringify(result)).not.toContain('change_jpy_overstated');
		});

		it('現在価格も引けない保有: 過大と断定せず向き不明として扱う（CodeRabbit 回帰）', () => {
			// 現在評価額は現在 ticker 価格を引けなかった保有を除外して積む（handler の totalJpyValue）。
			// 期初・現在の両端から落ちる資産では、その資産の値動きがどちらにも入らないため
			// ずれが過大とも過小とも言えない。ここで change_jpy_overstated を立てると、
			// 抑止したはずの確定値（向き）を出してしまう。
			const ctx = makeCtx({
				currentHoldings: [
					{ asset: 'btc', amount: '0.1' },
					{ asset: 'jpy', amount: '63314' },
				],
				dwData: makeEmptyDw(),
				candlePriceData: { boundaryPrices: new Map(), dailyPrices: new Map() },
				// 現在価格 Map に btc が無い ＝ 現在評価額にも載っていない
				flowPricing: currentPriceOnly(),
				currentValue: 63_314,
			});
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.unpriced_start_assets).toEqual(['btc']);
			expect(result.change_pct_unavailable_reason).toBe('start_boundary_unpriced');
			expect(result.change_jpy_overstated).toBeUndefined();
			expect(result.note).toBe(`${PERFORMANCE_NOTE}${PERFORMANCE_NOTE_CHANGE_DIRECTION_UNKNOWN}`);
			expect(result.note).toContain('ずれの向きは確定できない');
			expect(result.note).not.toContain('同じ額だけ過大');
		});

		it('過大が確定する資産と向き不明の資産が混在: 過大と断定しない', () => {
			// btc は現在価格あり（現在側に載る = 過大が確定）、eth は現在価格なしで保有継続（向き不明）。
			// 合計のずれの向きは決まらないので立てない。
			const ctx = makeCtx({
				currentHoldings: [
					{ asset: 'btc', amount: '0.1' },
					{ asset: 'eth', amount: '1' },
				],
				dwData: makeEmptyDw(),
				candlePriceData: { boundaryPrices: new Map(), dailyPrices: new Map() },
				flowPricing: currentPriceOnly(new Map([['btc', 15_000_000]])),
				currentValue: 1_500_000,
			});
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.unpriced_start_assets).toEqual(['btc', 'eth']);
			expect(result.change_jpy_overstated).toBeUndefined();
		});

		it('期間中に売り切った資産は現在価格が無くても過大が確定する', () => {
			// 現在保有ゼロ ＝ 現在評価額への寄与が本当に 0 なので現在側は正しく、
			// 脱落するのは期初側だけ。向きは確定する。
			const soldTrade: RawTrade = {
				order_id: 1,
				trade_id: 1,
				pair: 'btc_jpy',
				side: 'sell',
				type: 'limit',
				amount: '0.1',
				price: '15000000',
				maker_taker: 'taker',
				fee_amount_base: '0',
				fee_amount_quote: '0',
				executed_at: 1500,
			};
			const ctx = makeCtx({
				currentHoldings: [{ asset: 'jpy', amount: '1563314' }],
				trades: [soldTrade],
				dwData: makeEmptyDw(),
				candlePriceData: { boundaryPrices: new Map(), dailyPrices: new Map() },
				flowPricing: currentPriceOnly(),
				currentValue: 1_563_314,
			});
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.unpriced_start_assets).toEqual(['btc']);
			expect(result.change_jpy_overstated).toBe(true);
			expect(result.note).toContain(PERFORMANCE_NOTE_CHANGE_OVERSTATED);
		});

		it('エントリはあるが 3 境界すべて undefined: 過大な率を出さない', () => {
			const ctx = makeCtx({
				currentHoldings: [
					{ asset: 'btc', amount: '0.1' },
					{ asset: 'jpy', amount: '1000000' },
				],
				dwData: makeEmptyDw(),
				candlePriceData: {
					boundaryPrices: makeBoundaryPrices([['btc', {}]]),
					dailyPrices: new Map(),
				},
				flowPricing: currentPriceOnly(new Map([['btc', 15_000_000]])),
				currentValue: 2_500_000,
			});
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.start_value_jpy).toBe(1_000_000);
			expect(result.change_pct).toBeUndefined();
			expect(result.change_pct_unavailable_reason).toBe('start_boundary_unpriced');
			expect(result.unpriced_start_assets).toEqual(['btc']);
		});
	});

	/**
	 * 現在価格を解決できないときの増減率の抑止（#109）。
	 *
	 * `start_boundary_unpriced`（#86 / #97 / #105）の**対称形**。あちらは期初評価額（分母）が
	 * 過小で増減額が過大、こちらは現在評価額（分子）が過小で増減額が過小になる。
	 *
	 * 最悪ケースは ticker（`tickers_jpy`）の全失敗。期初価格が資産ごとに年 chunk を引く
	 * （＝部分失敗が普通）のと違い、現在価格は 1 回の取得で全銘柄ぶんを取るため、その 1 回が
	 * 落ちると全暗号資産が一斉に脱落して現在評価額が JPY 残高だけに縮退する。
	 */
	describe('現在価格が解決できないときの増減率の抑止（#109）', () => {
		/**
		 * 期初は BTC / ETH とも始値が引ける口座。現在 ticker 価格だけを振って現在側の欠損を作る。
		 *
		 * `currentValue` は**価格を引けた銘柄だけ**を積む（handler の `totalJpyValue` と同じ規約）。
		 * ここを手で揃えないと「現在評価額から落ちているのに合計には入っている」という
		 * 実装ではありえない状態になり、テストが機序を写さなくなる。
		 */
		function currentUnpricedCtx(currentPrices: Map<string, number>) {
			const holdings: Array<[string, number]> = [
				['btc', 0.1],
				['eth', 1],
			];
			const jpy = 63_314;
			const currentValue =
				jpy + holdings.reduce((sum, [asset, amount]) => sum + amount * (currentPrices.get(asset) ?? 0), 0);
			return makeCtx({
				currentHoldings: [
					...holdings.map(([asset, amount]) => ({ asset, amount: String(amount) })),
					{ asset: 'jpy', amount: String(jpy) },
				],
				dwData: makeEmptyDw(),
				candlePriceData: {
					boundaryPrices: makeBoundaryPrices([
						['btc', { yearStart: 10_000_000, monthStart: 10_000_000, dayStart: 10_000_000 }],
						['eth', { yearStart: 300_000, monthStart: 300_000, dayStart: 300_000 }],
					]),
					dailyPrices: new Map(),
				},
				flowPricing: currentPriceOnly(currentPrices),
				currentValue: Math.round(currentValue),
			});
		}

		it('1 銘柄だけ現在価格が引けない: 率を抑止し理由コードと資産名を出す', () => {
			// ETH だけ ticker から落ちる。期初評価額（BTC + ETH + JPY）は正しいまま、
			// 現在評価額から ETH だけが抜けるので増減額はその分だけ過小になる。
			const ctx = currentUnpricedCtx(new Map([['btc', 15_000_000]]));
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.change_pct).toBeUndefined();
			expect(result.adjusted_change_pct).toBeUndefined();
			expect(result.change_pct_unavailable_reason).toBe('current_value_unpriced');
			expect(result.unpriced_current_assets).toEqual(['eth']);
			// 期初側は無傷（対称形の取り違えを防ぐ）
			expect(result.unpriced_start_assets).toBeUndefined();
			expect(result.change_jpy_understated).toBe(true);
			expect(result.change_jpy_overstated).toBeUndefined();
		});

		it('change_jpy は出したまま change_jpy_understated=true を付ける（#105 と同じ「値 + フラグ」）', () => {
			const ctx = currentUnpricedCtx(new Map([['btc', 15_000_000]]));
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.change_jpy).toBe(result.current_value_jpy - result.start_value_jpy);
			// adjusted_change_jpy も同じ額だけ過小（純入出金は両端の評価額と無関係）
			expect(result.adjusted_change_jpy).toBe(result.change_jpy);
			expect(result.note).toBe(`${PERFORMANCE_NOTE}${PERFORMANCE_NOTE_CHANGE_UNDERSTATED}`);
			expect(result.note).toContain('増減額を運用成績として読まないこと');
		});

		it('ticker 全失敗で全銘柄脱落: 巨額の偽損失に率を付けない（本 issue の核）', () => {
			// `fetchTickerPricesMap` はエラーを握り潰して空 Map を返す（lib/tickers.ts）。
			// その結果 currentValue は JPY 残高だけに縮退し、change_jpy は口座が消し飛んだ
			// ように見える巨額のマイナスになる。ここに率を付けると #54 の -60.9% と同じ型の
			// 「信頼できない確定値」になる。
			const ctx = currentUnpricedCtx(new Map());
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			// 期初 1,363,314（BTC 1,000,000 + ETH 300,000 + JPY 63,314）→ 現在は JPY だけ
			expect(result.start_value_jpy).toBe(1_363_314);
			expect(result.current_value_jpy).toBe(63_314);
			expect(result.change_jpy).toBe(-1_300_000);
			// 率は出さない（-95.36% 相当の偽損失率を確定値として出さない）
			expect(result.change_pct).toBeUndefined();
			expect(result.adjusted_change_pct).toBeUndefined();
			expect(JSON.stringify(result)).not.toContain('"change_pct":');
			expect(result.change_pct_unavailable_reason).toBe('current_value_unpriced');
			expect(result.unpriced_current_assets).toEqual(['btc', 'eth']);
			expect(result.change_jpy_understated).toBe(true);
			expect(result.note).toContain('JPY 残高だけに縮退');
			expect(result.note).toContain('口座の損失ではなく価格取得の失敗を表す数');
		});

		it('期初側の欠損と同時成立: 優先順位どおり start_boundary_unpriced になり向きは確定しない', () => {
			// BTC は期初始値も現在価格も引けない ＝ 両端から落ちる。ETH は両方引ける。
			// 増減額のずれは過大とも過小とも言えないので、どちらのフラグも立てない。
			const ctx = makeCtx({
				currentHoldings: [
					{ asset: 'btc', amount: '0.1' },
					{ asset: 'eth', amount: '1' },
				],
				dwData: makeEmptyDw(),
				candlePriceData: {
					boundaryPrices: makeBoundaryPrices([['eth', { dayStart: 300_000 }]]),
					dailyPrices: new Map(),
				},
				flowPricing: currentPriceOnly(new Map([['eth', 380_000]])),
				currentValue: 380_000,
			});
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.change_pct_unavailable_reason).toBe('start_boundary_unpriced');
			expect(result.unpriced_start_assets).toEqual(['btc']);
			expect(result.unpriced_current_assets).toEqual(['btc']);
			expect(result.change_jpy_overstated).toBeUndefined();
			expect(result.change_jpy_understated).toBeUndefined();
			expect(result.note).toBe(`${PERFORMANCE_NOTE}${PERFORMANCE_NOTE_CHANGE_DIRECTION_UNKNOWN}`);
		});

		it('期初側と現在側で脱落資産が違っても向きは確定しない（合計のずれが決まらない）', () => {
			// BTC は期初だけ落ちる（過大要因）、ETH は現在だけ落ちる（過小要因）。
			// 片方だけ見てフラグを立てると、合計としては決まらない向きを確定値として出すことになる。
			const ctx = makeCtx({
				currentHoldings: [
					{ asset: 'btc', amount: '0.1' },
					{ asset: 'eth', amount: '1' },
				],
				dwData: makeEmptyDw(),
				candlePriceData: {
					boundaryPrices: makeBoundaryPrices([['eth', { dayStart: 300_000 }]]),
					dailyPrices: new Map(),
				},
				flowPricing: currentPriceOnly(new Map([['btc', 15_000_000]])),
				currentValue: 1_500_000,
			});
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.unpriced_start_assets).toEqual(['btc']);
			expect(result.unpriced_current_assets).toEqual(['eth']);
			expect(result.change_jpy_overstated).toBeUndefined();
			expect(result.change_jpy_understated).toBeUndefined();
		});

		it('start_value_negligible より優先する（増減額へ誘導しない側を必ず選ぶ）', () => {
			// 期初がほぼ空 + 現在価格の欠損。start_value_negligible を選ぶと
			// 「増減額で読んでください」という誘導が出るが、その増減額も壊れている。
			const ctx = makeCtx({
				currentHoldings: [
					{ asset: 'btc', amount: '0.1' },
					{ asset: 'eth', amount: '1' },
					{ asset: 'jpy', amount: '1500000' },
				],
				trades: [],
				dwData: {
					deposits: [],
					withdrawals: [],
					warnings: [],
					allFailed: false,
					isComplete: true,
				},
				candlePriceData: {
					boundaryPrices: makeBoundaryPrices([
						['btc', { dayStart: 15_000_000 }],
						['eth', { dayStart: 380_000 }],
					]),
					dailyPrices: new Map(),
				},
				flowPricing: currentPriceOnly(new Map([['btc', 15_000_000]])),
				currentValue: 3_000_000,
			});
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.change_pct_unavailable_reason).toBe('current_value_unpriced');
		});

		it('start_value_zero より優先する（0 除算の説明より分子の欠損を先に出す）', () => {
			// 期初保有ゼロ（全額が期間中の入金）+ 現在価格の欠損。start_value_zero を選ぶと
			// 「増減額で読んでください」になるが、現在評価額が縮退した増減額は読めない。
			const depositMs = 1500;
			const ctx = makeCtx({
				currentHoldings: [
					{ asset: 'btc', amount: '0.1' },
					{ asset: 'jpy', amount: '0' },
				],
				dwData: {
					deposits: [
						{
							uuid: 'dep-btc',
							asset: 'btc',
							amount: '0.1',
							status: 'DONE',
							found_at: depositMs,
							confirmed_at: depositMs,
						},
					],
					withdrawals: [],
					warnings: [],
					allFailed: false,
					isComplete: true,
				},
				candlePriceData: { boundaryPrices: new Map(), dailyPrices: new Map() },
				flowPricing: currentPriceOnly(),
				currentValue: 0,
			});
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.start_value_jpy).toBe(0);
			expect(result.change_pct_unavailable_reason).toBe('current_value_unpriced');
			expect(result.change_pct).toBeUndefined();
		});

		it('JPY のみ保有では誤検知しない', () => {
			const ctx = makeCtx({
				currentHoldings: [{ asset: 'jpy', amount: '1000000' }],
				dwData: makeEmptyDw(),
				flowPricing: currentPriceOnly(),
				currentValue: 1_000_000,
			});
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.unpriced_current_assets).toBeUndefined();
			expect(result.change_jpy_understated).toBeUndefined();
			expect(result.change_pct_unavailable_reason).toBeUndefined();
		});

		it('数量ゼロ・数値不正の保有は対象外（評価に寄与しないため）', () => {
			const ctx = makeCtx({
				currentHoldings: [
					{ asset: 'btc', amount: '0' },
					{ asset: 'eth', amount: 'not-a-number' },
					{ asset: 'jpy', amount: '1000000' },
				],
				dwData: makeEmptyDw(),
				flowPricing: currentPriceOnly(),
				currentValue: 1_000_000,
			});
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.unpriced_current_assets).toBeUndefined();
			expect(result.change_pct_unavailable_reason).toBeUndefined();
		});

		it('daily / monthly / yearly の 3 期間で一貫する', () => {
			const ctx = currentUnpricedCtx(new Map([['btc', 15_000_000]]));
			for (const key of ['daily', 'monthly', 'yearly'] as const) {
				const result = buildPeriodPerformance({ key, startMs: 1000, startIso: 's' }, ctx);
				expect(result.change_pct_unavailable_reason, key).toBe('current_value_unpriced');
				expect(result.unpriced_current_assets, key).toEqual(['eth']);
				expect(result.change_jpy_understated, key).toBe(true);
				expect(result.note, key).toContain(PERFORMANCE_NOTE_CHANGE_UNDERSTATED);
			}
		});

		it('価格がすべて引けている通常時: 新設キーも note の追記も出ない（JSON 一致の回帰）', () => {
			const ctx = currentUnpricedCtx(
				new Map([
					['btc', 15_000_000],
					['eth', 380_000],
				]),
			);
			const result = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, ctx);
			expect(result.change_pct).toBeCloseTo(Math.round((result.change_jpy / result.start_value_jpy) * 10000) / 100);
			expect(result.note).toBe(PERFORMANCE_NOTE);
			// PERFORMANCE_NOTE 本文がフィールド名に言及するので、キーとしての出現だけを見る
			expect(JSON.stringify(result)).not.toContain('"unpriced_current_assets":');
			expect(JSON.stringify(result)).not.toContain('"change_jpy_understated":');
		});
	});

	it('期間内に売買あり: reconstructHoldingsAtDate で期初保有が逆算される', () => {
		// 現在保有 0.5 BTC、期間内 (t=2000) に 0.5 BTC 売却 → 期初は 1.0 BTC
		// 期初評価 1.0 * 10_000_000 = 10_000_000、現在 0.5 * 12_000_000 = 6_000_000
		// 売却で得た JPY が現在 JPY に乗っていない前提（保有テストの簡略化）
		const trades: RawTrade[] = [
			{
				trade_id: 1,
				pair: 'btc_jpy',
				order_id: 1,
				side: 'sell',
				type: 'market',
				amount: '0.5',
				price: '11000000',
				maker_taker: 'taker',
				fee_amount_base: '0',
				fee_amount_quote: '0',
				executed_at: 2000,
			},
		];
		const ctx = makeCtx({
			currentHoldings: [{ asset: 'btc', amount: '0.5' }],
			trades,
			dwData: makeEmptyDw(),
			candlePriceData: {
				boundaryPrices: makeBoundaryPrices([['btc', { yearStart: 10_000_000 }]]),
				dailyPrices: new Map(),
			},
			flowPricing: currentPriceOnly(new Map([['btc', 12_000_000]])),
			currentValue: 6_000_000, // 0.5 BTC @ 12M
		});
		const result = buildPeriodPerformance({ key: 'yearly', startMs: 1000, startIso: '2026-01-01T00:00:00+09:00' }, ctx);
		// 期初は売却前なので 1 BTC @ yearStart 10M = 10M
		expect(result.start_value_jpy).toBe(10_000_000);
		expect(result.current_value_jpy).toBe(6_000_000);
		expect(result.change_jpy).toBe(-4_000_000);
		expect(result.net_flow_jpy).toBe(0); // 入出金なし
		expect(result.adjusted_change_jpy).toBe(-4_000_000);
	});

	it('key="monthly" / "daily" は対応する boundaryPrice フィールドを選択する', () => {
		// 同一資産で 3 期間の始値を変えて、key に応じた値が選ばれることを検証
		const boundaryPrices = makeBoundaryPrices([
			['btc', { yearStart: 8_000_000, monthStart: 9_000_000, dayStart: 11_000_000 }],
		]);
		const baseCtx = makeCtx({
			currentHoldings: [{ asset: 'btc', amount: '1' }],
			candlePriceData: { boundaryPrices, dailyPrices: new Map() },
			flowPricing: currentPriceOnly(new Map([['btc', 12_000_000]])),
			currentValue: 12_000_000,
		});

		const yearly = buildPeriodPerformance({ key: 'yearly', startMs: 1000, startIso: 'y' }, baseCtx);
		const monthly = buildPeriodPerformance({ key: 'monthly', startMs: 1000, startIso: 'm' }, baseCtx);
		const daily = buildPeriodPerformance({ key: 'daily', startMs: 1000, startIso: 'd' }, baseCtx);

		expect(yearly.start_value_jpy).toBe(8_000_000);
		expect(monthly.start_value_jpy).toBe(9_000_000);
		expect(daily.start_value_jpy).toBe(11_000_000);
		expect(yearly.period_start).toBe('y');
		expect(monthly.period_start).toBe('m');
		expect(daily.period_start).toBe('d');
	});

	it('boundaryPrice が未取得の資産は期初評価から除外される（calcPortfolioValue が price 不在をスキップ）', () => {
		// BTC は boundary 取得済み、ETH は未取得 → ETH 分は startValue に乗らない
		const ctx = makeCtx({
			currentHoldings: [
				{ asset: 'btc', amount: '1' },
				{ asset: 'eth', amount: '5' },
			],
			candlePriceData: {
				boundaryPrices: makeBoundaryPrices([['btc', { yearStart: 10_000_000 }]]),
				dailyPrices: new Map(),
			},
			flowPricing: currentPriceOnly(
				new Map([
					['btc', 12_000_000],
					['eth', 300_000],
				]),
			),
			currentValue: 13_500_000, // 1 BTC @ 12M + 5 ETH @ 300k
		});
		const result = buildPeriodPerformance({ key: 'yearly', startMs: 1000, startIso: 's' }, ctx);
		// ETH は boundary 不在で評価から除外 → 期初は BTC 分のみ
		expect(result.start_value_jpy).toBe(10_000_000);
		expect(result.change_jpy).toBe(3_500_000);
	});

	it('出力フィールド順は仕様（JSON.stringify 結果が安定）', () => {
		// ハンドラ出力 JSON が変更前後で完全一致するため、key の挿入順を固定する。
		const ctx = makeCtx({
			currentHoldings: [{ asset: 'btc', amount: '1' }],
			dwData: makeEmptyDw(),
			candlePriceData: {
				boundaryPrices: makeBoundaryPrices([['btc', { yearStart: 10_000_000 }]]),
				dailyPrices: new Map(),
			},
			flowPricing: currentPriceOnly(new Map([['btc', 12_000_000]])),
			currentValue: 12_000_000,
		});
		const result = buildPeriodPerformance({ key: 'yearly', startMs: 1000, startIso: 's' }, ctx);
		expect(Object.keys(result)).toEqual([
			'start_value_jpy',
			'current_value_jpy',
			'change_jpy',
			'change_pct',
			'net_flow_jpy',
			'withdrawal_fee_jpy',
			'adjusted_change_jpy',
			'adjusted_change_pct',
			'period_start',
			'period_end',
			'note',
			'flow_measured',
		]);
	});

	it('価格を引けない入出庫がある場合: unpriced_flow_assets が末尾に足される（既存キー順は不変）', () => {
		// 期間内に DOGE 入庫があるが currentPrices に DOGE が無い
		// → net_flow_jpy には計上されず、資産名だけが申告される
		const dw: DepositWithdrawalData = {
			deposits: [{ uuid: 'd-doge', asset: 'doge', amount: '1000', status: 'DONE', found_at: 1500, confirmed_at: 1500 }],
			withdrawals: [],
			warnings: [],
			allFailed: false,
			isComplete: true,
		};
		const ctx = makeCtx({
			currentHoldings: [{ asset: 'btc', amount: '1' }],
			dwData: dw,
			candlePriceData: {
				boundaryPrices: makeBoundaryPrices([['btc', { yearStart: 10_000_000 }]]),
				dailyPrices: new Map(),
			},
			flowPricing: currentPriceOnly(new Map([['btc', 12_000_000]])),
			currentValue: 12_000_000,
		});
		const result = buildPeriodPerformance({ key: 'yearly', startMs: 1000, startIso: 's' }, ctx);
		expect(result.unpriced_flow_assets).toEqual(['doge']);
		expect(result.net_flow_jpy).toBe(0);
		// 追加キーは末尾。既存キーの並びは変わらない
		expect(Object.keys(result)).toEqual([
			'start_value_jpy',
			'current_value_jpy',
			'change_jpy',
			'change_pct',
			'net_flow_jpy',
			'withdrawal_fee_jpy',
			'adjusted_change_jpy',
			'adjusted_change_pct',
			'period_start',
			'period_end',
			'note',
			'flow_measured',
			'unpriced_flow_assets',
		]);
	});

	it('flowUnavailableReason あり: フロー 3 値が null + flow_measured=false + 理由コード', () => {
		// dwData に中身があっても、理由コードが立っていれば未計測として扱う。
		// allFailed / partial failure では dwData が空なので、そのまま集計すると
		// 「フローゼロ」という確定値になり adjusted_change が嘘になる。
		const ctx = makeCtx({
			currentHoldings: [{ asset: 'btc', amount: '1' }],
			dwData: makeEmptyDw(),
			flowUnavailableReason: 'dw_fetch_failed',
			candlePriceData: {
				boundaryPrices: makeBoundaryPrices([['btc', { yearStart: 10_000_000 }]]),
				dailyPrices: new Map(),
			},
			flowPricing: currentPriceOnly(new Map([['btc', 12_000_000]])),
			currentValue: 12_000_000,
		});
		const result = buildPeriodPerformance({ key: 'yearly', startMs: 1000, startIso: 's' }, ctx);
		expect(result.net_flow_jpy).toBeNull();
		expect(result.withdrawal_fee_jpy).toBeNull();
		expect(result.adjusted_change_jpy).toBeNull();
		expect(result.adjusted_change_pct).toBeNull();
		expect(result.flow_measured).toBe(false);
		expect(result.flow_unavailable_reason).toBe('dw_fetch_failed');
		// 単純増減（入出金の影響が混ざったままの値）は従来どおり出る
		expect(result.change_jpy).toBe(2_000_000);
		expect(result.change_pct).toBe(20);
	});

	it('dwData が null で理由コード未指定: dw_fetch_failed に落ちる', () => {
		// flow_measured=false なら必ず理由が付く、という契約を守る。
		// 損益を出す構成では入出金履歴を常に取得するので、dwData が null なのは取得が落ちたとき。
		const ctx = makeCtx({
			currentHoldings: [{ asset: 'btc', amount: '1' }],
			candlePriceData: {
				boundaryPrices: makeBoundaryPrices([['btc', { yearStart: 10_000_000 }]]),
				dailyPrices: new Map(),
			},
			flowPricing: currentPriceOnly(new Map([['btc', 12_000_000]])),
			currentValue: 12_000_000,
		});
		const result = buildPeriodPerformance({ key: 'yearly', startMs: 1000, startIso: 's' }, ctx);
		expect(result.flow_measured).toBe(false);
		expect(result.flow_unavailable_reason).toBe('dw_fetch_failed');
		expect(result.net_flow_jpy).toBeNull();
	});

	it('未計測かつ start_value_jpy=0: adjusted_change_pct は undefined ではなく null', () => {
		// 0 除算回避の undefined（キーごと落ちる）と、未計測の null を取り違えないこと
		const ctx = makeCtx({
			currentHoldings: [],
			flowUnavailableReason: 'dw_fetch_failed',
			currentValue: 1_000_000,
		});
		const result = buildPeriodPerformance({ key: 'yearly', startMs: 1000, startIso: 's' }, ctx);
		expect(result.start_value_jpy).toBe(0);
		expect(result.change_pct).toBeUndefined();
		expect(result.adjusted_change_pct).toBeNull();
	});

	it('価格を全て引ける場合: unpriced_flow_assets はキーごと出ない（JSON が従来と一致）', () => {
		const dw: DepositWithdrawalData = {
			deposits: [{ uuid: 'd-jpy', asset: 'jpy', amount: '500000', status: 'DONE', found_at: 1500, confirmed_at: 1500 }],
			withdrawals: [],
			warnings: [],
			allFailed: false,
			isComplete: true,
		};
		const ctx = makeCtx({
			currentHoldings: [{ asset: 'btc', amount: '1' }],
			dwData: dw,
			candlePriceData: {
				boundaryPrices: makeBoundaryPrices([['btc', { yearStart: 10_000_000 }]]),
				dailyPrices: new Map(),
			},
			flowPricing: currentPriceOnly(new Map([['btc', 12_000_000]])),
			currentValue: 12_500_000,
		});
		const result = buildPeriodPerformance({ key: 'yearly', startMs: 1000, startIso: 's' }, ctx);
		expect(result.unpriced_flow_assets).toBeUndefined();
		expect(Object.keys(result)).not.toContain('unpriced_flow_assets');
		expect(JSON.stringify(result)).not.toContain('unpriced_flow_assets');
	});
});

/**
 * 当日損益（daily performance）の起点が JST 暦日の 0:00 であることを境界時刻で固定する。
 *
 * この起点は `fetchCandlePriceData` が日次価格マップのキーに使う JST 0:00 正規化、および
 * 資産推移の日次点の打ち止めと**同じ暦日境界でなければならない**（src/handlers/portfolio/
 * calendar.ts 参照）。UTC 暦日で計算してしまうと JST 09:00 を境に起点が 1 日ぶんずれ、
 * JST 深夜（UTC ではまだ前日）の当日損益が前日ぶんを含んだ値になる。
 */
describe('getJstPeriodBoundaries: JST 暦日境界', () => {
	/** JST の壁時計時刻を epoch ms に変換する（JST は DST を持たないので UTC+9 固定）。 */
	function jstMs(y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0): number {
		return Date.UTC(y, m - 1, d, h - 9, min, s, ms);
	}

	function boundariesAt(nowMs: number) {
		vi.setSystemTime(nowMs);
		return getJstPeriodBoundaries();
	}

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it('JST 00:00:00.000 ちょうど → 起点はその瞬間自身', () => {
		const midnight = jstMs(2026, 8, 2);
		const b = boundariesAt(midnight);
		expect(b.dayStartMs).toBe(midnight);
		expect(b.dayStartIso).toBe('2026-08-02T00:00:00+09:00');
	});

	it('JST 00:00 の 1ms 前 → 前日 00:00 が起点（翌日ぶんに飛ばない）', () => {
		const b = boundariesAt(jstMs(2026, 8, 2) - 1);
		expect(b.dayStartMs).toBe(jstMs(2026, 8, 1));
		expect(b.dayStartIso).toBe('2026-08-01T00:00:00+09:00');
	});

	it('JST 00:00 の 1ms 後 → 当日 00:00 が起点', () => {
		const b = boundariesAt(jstMs(2026, 8, 2) + 1);
		expect(b.dayStartMs).toBe(jstMs(2026, 8, 2));
		expect(b.dayStartIso).toBe('2026-08-02T00:00:00+09:00');
	});

	it('JST 23:59:59.999 → 当日 00:00 が起点', () => {
		const b = boundariesAt(jstMs(2026, 8, 2, 23, 59, 59, 999));
		expect(b.dayStartMs).toBe(jstMs(2026, 8, 2));
	});

	it('UTC 日付の変わり目（JST 09:00）を跨いでも起点は動かない', () => {
		// UTC 暦日で計算していると、この 1ms を跨いだ瞬間に起点が 1 日ぶんずれる
		const before = boundariesAt(jstMs(2026, 8, 2, 8, 59, 59, 999)); // = 2026-08-01T23:59:59.999Z
		expect(before.dayStartMs).toBe(jstMs(2026, 8, 2));
		const after = boundariesAt(jstMs(2026, 8, 2, 9)); // = 2026-08-02T00:00:00.000Z
		expect(after.dayStartMs).toBe(jstMs(2026, 8, 2));
	});

	it('JST 深夜（UTC ではまだ前日）でも起点は JST 暦日の 0:00', () => {
		// JST 2026-08-02 01:00 = 2026-08-01T16:00Z。UTC 暦日なら 8/1 00:00 が起点になってしまう。
		const b = boundariesAt(jstMs(2026, 8, 2, 1));
		expect(b.dayStartMs).toBe(jstMs(2026, 8, 2));
		expect(b.dayStartIso).toBe('2026-08-02T00:00:00+09:00');
	});

	it('元日 JST 00:00 → 年初・月初・当日の起点が一致する', () => {
		const newYear = jstMs(2026, 1, 1);
		const b = boundariesAt(newYear);
		expect(b.yearStartMs).toBe(newYear);
		expect(b.monthStartMs).toBe(newYear);
		expect(b.dayStartMs).toBe(newYear);
	});

	it('実行環境 TZ が UTC でも JST 暦日で計算される', () => {
		vi.stubEnv('TZ', 'UTC');
		const b = boundariesAt(jstMs(2026, 8, 2, 3));
		expect(b.dayStartMs).toBe(jstMs(2026, 8, 2));
		expect(b.dayStartIso).toBe('2026-08-02T00:00:00+09:00');
	});

	it('起点は portfolioDayStartMs と一致する（日次価格キーとの共有契約）', () => {
		// ここがずれると資産推移の日次点が dailyPrices を引けず、全点が現在価格
		// フォールバックに落ちる（equitySeriesQuality が実態と乖離する）。
		const cases = [
			jstMs(2026, 8, 2),
			jstMs(2026, 8, 2) - 1,
			jstMs(2026, 8, 2, 9),
			jstMs(2026, 8, 2, 23, 59, 59, 999),
			jstMs(2026, 1, 1),
		];
		for (const nowMs of cases) {
			expect(boundariesAt(nowMs).dayStartMs).toBe(portfolioDayStartMs(nowMs));
		}
	});
});

/**
 * 資産推移シリーズの入出金フローマーカー（`EquityPoint.flow_jpy`）。
 *
 * 月次資産推移は入出金があった期間でも単一の連続線として出るため、大口入金のある口座では
 * 「ずっと同額を保有していた」と誤読される（#53 の症状 7 後半）。グラフ化されると注記行は
 * 消える前提なので、フロー発生点を**データとして**返す。
 *
 * 本 describe が固定する契約:
 *   - 点にフローを寄せる向き（`value_jpy[i+1] - value_jpy[i] - flow_jpy[i]` が市場変動）
 *   - 日付キーが `portfolioDayStartMs`（JST 暦日境界）と揃うこと
 *   - フローが無い期間は従来と JSON 一致すること
 */
describe('buildEquitySeries — 入出金フローマーカー', () => {
	/** JST の壁時計時刻を epoch ms に変換する（JST は DST を持たないので UTC+9 固定）。 */
	function jstMs(y: number, m: number, d: number, h = 0, min = 0): number {
		return Date.UTC(y, m - 1, d, h - 9, min);
	}

	/** JST 暦日 0:00 の連続点（日次シリーズ）を作る */
	function dailyPoints(y: number, m: number, fromDay: number, toDay: number) {
		const dates = [];
		for (let d = fromDay; d <= toDay; d++) dates.push(dayjs(jstMs(y, m, d)).tz(PORTFOLIO_CALENDAR_TZ));
		return dates;
	}

	function makeDwData(overrides: Partial<DepositWithdrawalData> = {}): DepositWithdrawalData {
		return { deposits: [], withdrawals: [], warnings: [], allFailed: false, isComplete: true, ...overrides };
	}

	/** JPY のみ保有。価格解決を挟まずフローの寄せ方だけを見るための最小構成。 */
	const JPY_ONLY = [{ asset: 'jpy', amount: '1500000' }];
	const NOW_ISO = '2026-08-04T12:00:00+09:00';

	function build(
		dates: ReturnType<typeof dailyPoints>,
		dw: DepositWithdrawalData | null,
		pricing = currentPriceOnly(),
		currentHoldings = JPY_ONLY,
		currentValueJpy = 1_500_000,
	) {
		return buildEquitySeries(dates, currentHoldings, [], dw, new Map(), currentValueJpy, NOW_ISO, new Map(), pricing);
	}

	it('JPY 入金があった日の点に flow_jpy が付く', () => {
		// 8/1〜8/3 の日次点 + 現在。8/2 に 500,000 円入金。
		const dw = makeDwData({
			deposits: [makeDeposit({ asset: 'jpy', amount: '500000', confirmed_at: jstMs(2026, 8, 2, 10) })],
		});
		const series = build(dailyPoints(2026, 8, 1, 3), dw);

		expect(series.map((p) => p.flow_jpy)).toEqual([undefined, 500_000, undefined, undefined]);
		expect(series[1].timestamp).toBe('2026-08-02T00:00:00+09:00');
	});

	/**
	 * 向きの契約。`reconstructHoldingsAtDate` は「点の時刻以降」の入出金を巻き戻すため、
	 * 8/2 の入金が評価額に現れるのは 8/3 の点から。flow_jpy を「この点から次の点まで」に
	 * 取ることで、増減からフローを引いた残りが市場変動になる。
	 * 逆向き（直前の点からこの点まで）に取ると、この式が 1 点ずれて成立しなくなる。
	 */
	it('value_jpy[i+1] - value_jpy[i] - flow_jpy[i] が市場変動になる（JPY のみ保有なら 0）', () => {
		const dw = makeDwData({
			deposits: [makeDeposit({ asset: 'jpy', amount: '500000', confirmed_at: jstMs(2026, 8, 2, 10) })],
		});
		const series = build(dailyPoints(2026, 8, 1, 3), dw);

		// 現在 1,500,000 円 / 8/2 の入金 500,000 円を巻き戻すと 8/1・8/2 は 1,000,000 円。
		expect(series.map((p) => p.value_jpy)).toEqual([1_000_000, 1_000_000, 1_500_000, 1_500_000]);
		for (let i = 0; i < series.length - 1; i++) {
			expect(series[i + 1].value_jpy - series[i].value_jpy - (series[i].flow_jpy ?? 0)).toBe(0);
		}
	});

	it('同じ日の入金と出金は純額で集約される', () => {
		const dw = makeDwData({
			deposits: [makeDeposit({ asset: 'jpy', amount: '800000', confirmed_at: jstMs(2026, 8, 2, 9) })],
			withdrawals: [
				makeWithdrawal({ asset: 'jpy', amount: '300000', fee: '550', requested_at: jstMs(2026, 8, 2, 18) }),
			],
		});
		const series = build(dailyPoints(2026, 8, 1, 3), dw);

		// 元本のみの純額。出金手数料 550 円は含まない（*_performance.net_flow_jpy と同一定義）。
		expect(series[1].flow_jpy).toBe(500_000);
	});

	it('純額がゼロに相殺される日はキーごと落ちる', () => {
		const dw = makeDwData({
			deposits: [makeDeposit({ asset: 'jpy', amount: '300000', confirmed_at: jstMs(2026, 8, 2, 9) })],
			withdrawals: [makeWithdrawal({ asset: 'jpy', amount: '300000', fee: '0', requested_at: jstMs(2026, 8, 2, 18) })],
		});
		const series = build(dailyPoints(2026, 8, 1, 3), dw);

		expect(series[1]).not.toHaveProperty('flow_jpy');
	});

	/**
	 * 出金手数料は flow_jpy に含めない（`*_performance.net_flow_jpy` と同一定義）。
	 * 結果として増減からフローを引いた残差に手数料コストが残る。これは
	 * `adjusted_change_jpy` の扱い（`PERFORMANCE_NOTE`）と揃えてある。
	 */
	it('出金は負値になり、出金手数料は残差に残る', () => {
		const dw = makeDwData({
			withdrawals: [
				makeWithdrawal({ asset: 'jpy', amount: '200000', fee: '550', requested_at: jstMs(2026, 8, 2, 18) }),
			],
		});
		const series = build(
			dailyPoints(2026, 8, 1, 3),
			dw,
			currentPriceOnly(),
			[{ asset: 'jpy', amount: '800000' }],
			800_000,
		);

		expect(series[1].flow_jpy).toBe(-200_000);
		// 8/2 は出金前（1,000,550 円）、8/3 は出金後（800,000 円）。
		expect(series[1].value_jpy).toBe(1_000_550);
		expect(series[2].value_jpy).toBe(800_000);
		expect(series[2].value_jpy - series[1].value_jpy - (series[1].flow_jpy ?? 0)).toBe(-550);
	});

	/**
	 * 回帰（JSON レベル）。フローゼロの期間では従来の点と完全一致し、キーも増えない。
	 * `toEqual` は undefined のプロパティを無視するので `JSON.stringify` で比較する。
	 */
	it('フローが無い期間は従来の出力（timestamp / value_jpy のみ）と JSON 一致する', () => {
		const dates = dailyPoints(2026, 8, 1, 3);
		const withFlowArg = build(dates, makeDwData());
		const legacy = buildEquitySeries(dates, JPY_ONLY, [], makeDwData(), new Map(), 1_500_000, NOW_ISO, new Map());

		expect(JSON.stringify(withFlowArg)).toBe(JSON.stringify(legacy));
		expect(JSON.stringify(withFlowArg)).not.toContain('flow_jpy');
	});

	it('flowPricing を渡さなければ flow_jpy を一切載せない（既存呼び出しの互換）', () => {
		const dw = makeDwData({
			deposits: [makeDeposit({ asset: 'jpy', amount: '500000', confirmed_at: jstMs(2026, 8, 2, 10) })],
		});
		const dates = dailyPoints(2026, 8, 1, 3);
		const series = buildEquitySeries(dates, JPY_ONLY, [], dw, new Map(), 1_500_000, NOW_ISO, new Map());

		expect(JSON.stringify(series)).not.toContain('flow_jpy');
	});

	it('入出金履歴が無い（dwData=null）と全点で落ちる', () => {
		const series = build(dailyPoints(2026, 8, 1, 3), null);
		expect(JSON.stringify(series)).not.toContain('flow_jpy');
	});

	/**
	 * 履歴が欠けている構成では部分集合の合計を確定値として出さない。
	 *
	 * `*_performance` は同じ状態で「純入出金: 未計測」（`flow_measured=false`）を返すので、
	 * 点だけが金額を主張すると 1 つの応答の中で矛盾する（#53 が潰している型の自己矛盾）。
	 * 判定は `flowUnavailableReasonFor` と同一にしてあり、`allFailed` / `isComplete` だけを
	 * 見る判定では塞げない **`warnings`（一部チャネル失敗）** も含む点をケースで固定する。
	 */
	describe('履歴が欠けている構成では全点で落ちる', () => {
		const deposits = [makeDeposit({ asset: 'jpy', amount: '500000', confirmed_at: jstMs(2026, 8, 2, 10) })];

		it.each([
			['件数上限による打ち切り（isComplete=false）', { isComplete: false }],
			['全チャネル失敗（allFailed=true）', { allFailed: true }],
			// 出庫チャネルだけが落ちると入金しか残らず「入金しかない口座」に見える。
			// allFailed は false・isComplete は true なので、warnings を見ないと素通りする。
			['一部チャネル失敗（warnings あり）', { warnings: ['出庫履歴の取得に失敗'] }],
		])('%s', (_label, overrides: Partial<DepositWithdrawalData>) => {
			const dw = makeDwData({ deposits, ...overrides });
			// 前提: そのケースが実際に理由コードを立てる状態であること
			expect(flowUnavailableReasonFor(dw)).toBeDefined();

			const series = build(dailyPoints(2026, 8, 1, 3), dw);
			expect(JSON.stringify(series)).not.toContain('flow_jpy');
		});

		it('履歴が完全なら同じ入金が載る（上の抑止が効きすぎていないことの対照）', () => {
			const dw = makeDwData({ deposits });
			expect(flowUnavailableReasonFor(dw)).toBeUndefined();

			const series = build(dailyPoints(2026, 8, 1, 3), dw);
			expect(series[1].flow_jpy).toBe(500_000);
		});
	});

	it('最終点（現在のリアルタイム評価額）には付かない', () => {
		// 最後の日次点 8/3 より後、現在（8/4 12:00）より前の入金は最後の日次点に寄る。
		const dw = makeDwData({
			deposits: [makeDeposit({ asset: 'jpy', amount: '500000', confirmed_at: jstMs(2026, 8, 4, 9) })],
		});
		const series = build(dailyPoints(2026, 8, 1, 3), dw);

		expect(series[series.length - 1].timestamp).toBe(NOW_ISO);
		expect(series[series.length - 1]).not.toHaveProperty('flow_jpy');
		expect(series[2].flow_jpy).toBe(500_000);
	});

	it('最初の点より前の入出金は載せない（期初評価額に織り込み済み）', () => {
		const dw = makeDwData({
			deposits: [makeDeposit({ asset: 'jpy', amount: '500000', confirmed_at: jstMs(2026, 7, 31, 23) })],
		});
		const series = build(dailyPoints(2026, 8, 1, 3), dw);

		expect(JSON.stringify(series)).not.toContain('flow_jpy');
	});

	it('DONE 以外のステータスは載せない', () => {
		const dw = makeDwData({
			deposits: [
				makeDeposit({ asset: 'jpy', amount: '500000', status: 'CONFIRMED', confirmed_at: jstMs(2026, 8, 2, 10) }),
			],
		});
		const series = build(dailyPoints(2026, 8, 1, 3), dw);

		expect(JSON.stringify(series)).not.toContain('flow_jpy');
	});

	/**
	 * 日付キーの暦。JST 深夜（UTC ではまだ前日）の入金が前日の点に落ちると、
	 * マーカーと評価額の段差が 1 日ずれる。
	 */
	it('JST 深夜の入金は JST 暦日の点に寄る（UTC 暦日に落ちない）', () => {
		const dw = makeDwData({
			// JST 8/2 01:00 = 2026-08-01T16:00Z
			deposits: [makeDeposit({ asset: 'jpy', amount: '500000', confirmed_at: jstMs(2026, 8, 2, 1) })],
		});
		const series = build(dailyPoints(2026, 8, 1, 3), dw);

		expect(series[0].flow_jpy).toBeUndefined();
		expect(series[1].flow_jpy).toBe(500_000);
	});

	it('JST 暦日 0:00 ちょうどの入金はその日の点に寄る', () => {
		const dw = makeDwData({
			deposits: [makeDeposit({ asset: 'jpy', amount: '500000', confirmed_at: jstMs(2026, 8, 2) })],
		});
		const series = build(dailyPoints(2026, 8, 1, 3), dw);

		expect(series[1].flow_jpy).toBe(500_000);
	});

	it('confirmed_at が非有限の入出金でバケットを壊さない', () => {
		const dw = makeDwData({
			deposits: [
				makeDeposit({ uuid: 'd-bad', asset: 'jpy', amount: '100000', confirmed_at: Number.NaN }),
				makeDeposit({ uuid: 'd-ok', asset: 'jpy', amount: '500000', confirmed_at: jstMs(2026, 8, 2, 10) }),
			],
		});
		const series = build(dailyPoints(2026, 8, 1, 3), dw);

		expect(series[1].flow_jpy).toBe(500_000);
	});

	describe('暗号資産の入出庫', () => {
		const BTC_ONLY = [{ asset: 'btc', amount: '0.1' }];

		it('入庫日の始値で JPY 換算される（現在価格ではない）', () => {
			const depositAt = jstMs(2026, 8, 2, 10);
			const dw = makeDwData({
				deposits: [makeDeposit({ asset: 'btc', amount: '0.05', confirmed_at: depositAt })],
			});
			// 入庫日 10,000,000 円 / 現在 20,000,000 円。現在価格で換算すると 1,000,000 円になる。
			const pricing = withDailyPrices(
				[{ asset: 'btc', atMs: depositAt, price: 10_000_000 }],
				new Map([['btc', 20_000_000]]),
			);
			const series = build(dailyPoints(2026, 8, 1, 3), dw, pricing, BTC_ONLY, 2_000_000);

			expect(series[1].flow_jpy).toBe(500_000);
		});

		it('入庫日の始値が無ければ現在価格にフォールバックする', () => {
			const dw = makeDwData({
				deposits: [makeDeposit({ asset: 'btc', amount: '0.05', confirmed_at: jstMs(2026, 8, 2, 10) })],
			});
			const pricing = currentPriceOnly(new Map([['btc', 20_000_000]]));
			const series = build(dailyPoints(2026, 8, 1, 3), dw, pricing, BTC_ONLY, 2_000_000);

			expect(series[1].flow_jpy).toBe(1_000_000);
		});

		/**
		 * 価格を解決できない入出庫は計上しない（0 円として黙って混ぜない）。
		 * 申告経路は同じ期間を張る `*_performance.unpriced_flow_assets` なので、
		 * ここで専用のフィールドは増やさない。
		 */
		it('価格を解決できない入出庫は計上しない（他の入出金は残る）', () => {
			const dw = makeDwData({
				deposits: [
					makeDeposit({ uuid: 'd-btc', asset: 'btc', amount: '0.05', confirmed_at: jstMs(2026, 8, 2, 10) }),
					makeDeposit({ uuid: 'd-jpy', asset: 'jpy', amount: '300000', confirmed_at: jstMs(2026, 8, 2, 11) }),
				],
			});
			const series = build(dailyPoints(2026, 8, 1, 3), dw, currentPriceOnly(), BTC_ONLY, 2_000_000);

			expect(series[1].flow_jpy).toBe(300_000);
		});

		/**
		 * キーの不在は「入出金が無かった」ではない（`EquityPoint.flow_jpy` の
		 * 「キーが無いことの意味」の (3)）。この区間には実際に入庫があるが、価格を解決できず
		 * 計上対象が残らないためキーごと落ちる。落ちた資産名は
		 * `*_performance.unpriced_flow_assets` が申告する。
		 */
		it('区間の入出庫が全件価格解決できないとキーごと落ちる（0 円計上しない）', () => {
			const dw = makeDwData({
				deposits: [makeDeposit({ asset: 'btc', amount: '0.05', confirmed_at: jstMs(2026, 8, 2, 10) })],
			});
			const series = build(dailyPoints(2026, 8, 1, 3), dw, currentPriceOnly(), BTC_ONLY, 2_000_000);

			expect(series[1]).not.toHaveProperty('flow_jpy');
			// 0 円のマーカーを立てていない（「純額ゼロ」と誤読させない）
			expect(JSON.stringify(series)).not.toContain('flow_jpy');
		});

		it('出庫は出庫日の始値で換算し負値になる（手数料は含めない）', () => {
			const withdrawAt = jstMs(2026, 8, 2, 18);
			const dw = makeDwData({
				withdrawals: [makeWithdrawal({ asset: 'btc', amount: '0.05', fee: '0.0005', requested_at: withdrawAt })],
			});
			const pricing = withDailyPrices([{ asset: 'btc', atMs: withdrawAt, price: 10_000_000 }]);
			const series = build(dailyPoints(2026, 8, 1, 3), dw, pricing, BTC_ONLY, 2_000_000);

			expect(series[1].flow_jpy).toBe(-500_000);
		});
	});

	/**
	 * 年次シリーズ（月次点）。日次点と同じ実装で、入出庫日はその月の点に寄る。
	 * 逆向き（直前の点からこの点まで）に取ると 8 月のフローが `2026-08-01` ではなく
	 * `2026-09-01` に載り、日付ラベルと発生月がずれる。
	 */
	describe('月次点（年次シリーズ）', () => {
		function monthlyPoints(y: number, fromMonth: number, toMonth: number) {
			const dates = [];
			for (let m = fromMonth; m <= toMonth; m++) dates.push(dayjs(jstMs(y, m, 1)).tz(PORTFOLIO_CALENDAR_TZ));
			return dates;
		}

		it('月の途中の入金はその月の点に寄る', () => {
			const dw = makeDwData({
				deposits: [makeDeposit({ asset: 'jpy', amount: '500000', confirmed_at: jstMs(2026, 8, 5, 10) })],
			});
			const series = build(monthlyPoints(2026, 6, 8), dw);

			expect(series[2].timestamp).toBe('2026-08-01T00:00:00+09:00');
			expect(series.map((p) => p.flow_jpy)).toEqual([undefined, undefined, 500_000, undefined]);
		});

		it('同じ月の複数フローは 1 点に集約される', () => {
			const dw = makeDwData({
				deposits: [
					makeDeposit({ uuid: 'd1', asset: 'jpy', amount: '500000', confirmed_at: jstMs(2026, 7, 3) }),
					makeDeposit({ uuid: 'd2', asset: 'jpy', amount: '200000', confirmed_at: jstMs(2026, 7, 28) }),
				],
				withdrawals: [makeWithdrawal({ asset: 'jpy', amount: '100000', requested_at: jstMs(2026, 7, 15) })],
			});
			const series = build(monthlyPoints(2026, 6, 8), dw);

			expect(series[1].flow_jpy).toBe(600_000);
		});
	});
});
