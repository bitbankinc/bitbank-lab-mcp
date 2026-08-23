/**
 * portfolio/calc — 純粋な計算ロジック。
 *
 * 損益計算（移動平均法）、入出金サマリー、保有復元、
 * エクイティ時系列、期間ネットフロー、JST 期間境界を担当。
 * 全関数は I/O を行わない純粋関数。
 */

import { dayjs } from '../../../lib/datetime.js';
import type {
	DepositWithdrawalStatus,
	PortfolioChangePctUnavailableReason,
	PortfolioFlowUnavailableReason,
	PortfolioQtyMismatchReason,
} from '../../private/schemas.js';
import { PORTFOLIO_CALENDAR_TZ, portfolioDayStartMs } from './calendar.js';
import type {
	AccountPnl,
	CandlePriceData,
	DepositWithdrawalData,
	DepositWithdrawalSummary,
	EquityPoint,
	FlowPricing,
	FlowValuationBreakdown,
	FlowValuationTarget,
	PeriodAccountPnl,
	PeriodDWSummary,
	PeriodNetFlowResult,
	PeriodPerformance,
	PeriodRealizedPnl,
	PnlResult,
	RawDeposit,
	RawMarginTrade,
	RawTrade,
	RawWithdrawal,
} from './types.js';

// ── 損益計算エンジン ──

// bitbank の現物手数料体系:
//   買い: 手数料は base 通貨で発生（feeBase > 0, feeQuote = 0）
//   売り: 手数料は quote 通貨で発生（feeQuote > 0, feeBase = 0）
// 両方が同時に非ゼロになるケースは API 仕様上想定されないが、
// 防御的にどちらも参照しても算術的に正しくなるロジックを採用する。

/**
 * 原価計算に入庫を算入するための入力。
 *
 * `pricing` は入庫日（`confirmed_at`）の始値を引くための価格ソース。**現在価格への
 * フォールバックは原価には使わない**（`collectDepositCostEvents` の doc を参照）ので、
 * `pricing.currentPrices` は実質参照されないが、`FlowPricing` をそのまま渡せるよう
 * 型は共有する（呼び出し側で入出庫換算用に組み立てた 1 個をそのまま使い回すため）。
 */
export interface DepositCostBasisInput {
	deposits: RawDeposit[];
	pricing: FlowPricing;
}

/** 原価に算入できる入庫 1 件（入庫日の始値で JPY 換算済み） */
interface PricedDepositEvent {
	asset: string;
	ts: number;
	qty: number;
	cost: number;
}

interface DepositCostEvents {
	priced: PricedDepositEvent[];
	/** asset（小文字）→ 入庫日の始値を解決できず原価にも数量にも算入しなかった DONE 入庫の件数 */
	unpricedCounts: Map<string, number>;
}

/**
 * 入庫を「入庫日の始値 × 数量」の取得原価として算入できる形に整える。
 *
 * **算入するのは入庫日の始値（`deposit_date_price`）を解決できた入庫だけ。**
 * 現在価格フォールバックは意図的に使わない: 現在価格で原価を作ると、その入庫ぶんの
 * 評価損益が常にゼロ付近に貼り付き、誤差が相場と連動して動く（#53 の機序 6 を
 * cost_basis 側に持ち込むことになる）。嘘の原価を作らず、算入しなかった件数を
 * `unpricedCounts` で申告して数量不変条件（`qtyMismatchReasonFor`）に載せる。
 *
 * 数量・数値が不正な DONE 入庫も「算入できなかった入庫」として数える。実残高には
 * 効いているかもしれない一方こちらでは再現できないので、乖離の証拠としては残す。
 */
function collectDepositCostEvents(input: DepositCostBasisInput | undefined, assetFilter?: string): DepositCostEvents {
	const priced: PricedDepositEvent[] = [];
	const unpricedCounts = new Map<string, number>();
	if (!input) return { priced, unpricedCounts };

	for (const d of input.deposits) {
		if (d.status !== 'DONE') continue;
		if (d.asset === 'jpy') continue;
		if (assetFilter != null && d.asset !== assetFilter) continue;

		const qty = Number(d.amount);
		const resolved =
			Number.isFinite(qty) && qty > 0 ? resolveFlowPrice(input.pricing, d.asset, d.confirmed_at) : undefined;
		if (resolved?.basis === 'deposit_date_price') {
			priced.push({ asset: d.asset, ts: d.confirmed_at, qty, cost: qty * resolved.price });
		} else {
			unpricedCounts.set(d.asset, (unpricedCounts.get(d.asset) ?? 0) + 1);
		}
	}
	return { priced, unpricedCounts };
}

/**
 * 約定履歴・暗号資産入出庫から通貨ごとの平均取得単価と実現損益を算出する。
 * 移動平均法（総平均法）を採用。両 side の手数料（fee_amount_base / fee_amount_quote）を考慮。
 *
 * 暗号資産入庫（crypto deposit）は「入庫日の始値で買った」とみなして原価に算入する:
 *   - holdingQty に数量、holdingCost に 数量 × 入庫日始値 を加算
 *   - realized_pnl には計上しない（買いと同じく取得側のイベント）
 * これは**真の取得原価ではなく「入庫時点の相場で取得した」という仮定**である。
 * 入庫日の始値を解決できない入庫は算入せず、`unpriced_deposit_count` で申告する
 * （`collectDepositCostEvents` の doc を参照）。`depositCost` 自体を渡さない呼び出しでは
 * 全入庫が未算入になり、従来どおり「入庫は原価計算に入らない」挙動になる。
 *
 * 暗号資産出庫（crypto withdrawal）は「売却」ではなく原価の按分減少として扱う:
 *   - holdingQty と holdingCost を平均単価ベースで減らす
 *   - realized_pnl には計上しない
 * これにより、出庫後に残った少量保有の cost_basis が適正化され、
 * 評価損益が過大マイナスになる問題を防ぐ。
 */
export function calcPnl(
	trades: RawTrade[],
	asset: string,
	withdrawals?: RawWithdrawal[],
	depositCost?: DepositCostBasisInput,
): PnlResult {
	// この通貨に関する約定を古い順にソート
	const pair = `${asset}_jpy`;
	const relevantTrades = trades.filter((t) => t.pair === pair).sort((a, b) => a.executed_at - b.executed_at);

	// この通貨に関する完了済み暗号資産出庫
	const relevantWithdrawals = (withdrawals ?? []).filter((w) => w.asset === asset && w.status === 'DONE');

	// この通貨に関する完了済み暗号資産入庫（原価に算入できるものだけ）
	const deposits = collectDepositCostEvents(depositCost, asset);
	const unpricedDepositCount = deposits.unpricedCounts.get(asset) ?? 0;

	if (relevantTrades.length === 0 && relevantWithdrawals.length === 0 && deposits.priced.length === 0) {
		return {
			avg_buy_price: undefined,
			cost_basis: undefined,
			realized_pnl: 0,
			trade_count: 0,
			reconstructed_qty: 0,
			priced_deposit_count: 0,
			unpriced_deposit_count: unpricedDepositCount,
		};
	}

	// 約定・入庫・出庫を時系列順に統合して処理
	type TradeEvent = { type: 'trade'; ts: number; trade: RawTrade };
	type DepositEvent = { type: 'deposit'; ts: number; qty: number; cost: number };
	type WithdrawalEvent = { type: 'withdrawal'; ts: number; amount: number };
	type Event = TradeEvent | DepositEvent | WithdrawalEvent;

	const events: Event[] = [
		...relevantTrades.map((t): TradeEvent => ({ type: 'trade', ts: t.executed_at, trade: t })),
		...deposits.priced.map((d): DepositEvent => ({ type: 'deposit', ts: d.ts, qty: d.qty, cost: d.cost })),
		...relevantWithdrawals.map(
			(w): WithdrawalEvent => ({
				type: 'withdrawal',
				ts: w.requested_at,
				amount: Number(w.amount) + (Number(w.fee) || 0), // 出庫量 + 出庫手数料 = 口座から減った総量
			}),
		),
	].sort((a, b) => a.ts - b.ts);

	let holdingQty = 0;
	let holdingCost = 0; // 保有分の取得原価合計（手数料込み）
	let realizedPnl = 0;

	for (const event of events) {
		if (event.type === 'deposit') {
			// Crypto deposit: 入庫日の始値で取得したとみなして原価に算入。realized_pnl には計上しない
			holdingCost += event.cost;
			holdingQty += event.qty;
		} else if (event.type === 'trade') {
			const t = event.trade;
			const qty = Number(t.amount);
			const price = Number(t.price);
			if (!Number.isFinite(qty) || !Number.isFinite(price)) continue;

			// 決済通貨（JPY）建ての手数料 / 基軸通貨建ての手数料
			const feeQuote = Number(t.fee_amount_quote) || 0;
			const feeBase = Number(t.fee_amount_base) || 0;

			if (t.side === 'buy') {
				// 買い: JPY 出 = qty * price + feeQuote、base 入 = qty - feeBase
				holdingCost += qty * price + feeQuote;
				holdingQty += qty - feeBase;
			} else {
				// sell: 移動平均法で原価を按分
				if (holdingQty > 0) {
					const avgCost = holdingCost / holdingQty;
					// 売りで口座から減る base 量は qty + feeBase（reconstructHoldingsAtDate の巻き戻しと対称形。
					// 冒頭の方針コメントのとおり売りの feeBase は API 仕様上ゼロだが、非ゼロでも
					// 数量・原価が正しくなるよう base 建て手数料も平均原価で按分し実現損益に費用計上する）。
					// 保有量を超える売りの場合、原価は保有分のみ按分（超過分は原価ゼロ扱い）
					const coveredQty = Math.min(qty + feeBase, holdingQty);
					const sellCost = coveredQty * avgCost;
					const sellRevenue = qty * price - feeQuote; // 売却収入から手数料を差し引く
					realizedPnl += sellRevenue - sellCost;
					holdingCost -= sellCost;
					holdingQty -= coveredQty;
					// 誤差修正: 数量がゼロ近くなったらコストもリセット
					if (holdingQty < 1e-12) {
						holdingQty = 0;
						holdingCost = 0;
					}
				} else {
					// 保有ゼロ状態での売り（空売り等）: 実現損益のみ計上
					realizedPnl += qty * price - feeQuote;
				}
			}
		} else {
			// Crypto withdrawal: 原価を按分減少。realized_pnl には計上しない
			const wdQty = event.amount;
			if (holdingQty > 0 && wdQty > 0) {
				const avgCost = holdingCost / holdingQty;
				const removedQty = Math.min(wdQty, holdingQty);
				holdingCost -= removedQty * avgCost;
				holdingQty -= removedQty;
				if (holdingQty < 1e-12) {
					holdingQty = 0;
					holdingCost = 0;
				}
			}
		}
	}

	const avgBuyPrice = holdingQty > 0 ? holdingCost / holdingQty : undefined;
	const costBasis = holdingQty > 0 ? holdingCost : undefined;

	return {
		avg_buy_price: avgBuyPrice,
		cost_basis: costBasis,
		realized_pnl: Math.round(realizedPnl),
		trade_count: relevantTrades.length,
		reconstructed_qty: holdingQty,
		priced_deposit_count: deposits.priced.length,
		unpriced_deposit_count: unpricedDepositCount,
	};
}

// ── 数量不変条件（復元数量 vs 実残高） ──

/** 許容誤差の絶対項: 最小数量単位（10^-amount_precision）の何倍まで丸め・ダスト由来とみなすか */
export const QTY_INVARIANT_TOLERANCE_QUANTA = 5;
/** 許容誤差の相対項: 実残高に対する割合（0.1%） */
export const QTY_INVARIANT_TOLERANCE_RATIO = 0.001;

/**
 * 復元数量と実残高の突き合わせに使う許容誤差。
 *
 * `max(10^-amount_precision × 5, |実残高| × 0.1%)` を採用する:
 * - 絶対項: 取引所側の端数処理・手数料丸めは最下位桁（amount_precision）に数カウント分
 *   たまり得るため、ダスト保有でも厳密一致は期待できない
 * - 相対項: 移動平均リプレイの浮動小数点誤差は保有量に比例して積み上がる
 * どちらの項でも説明できない乖離は、履歴に無いイベント（入庫・打ち切り等）由来の実差とみなす。
 */
export function qtyInvariantTolerance(onhandAmount: number, amountPrecision: number): number {
	return Math.max(
		QTY_INVARIANT_TOLERANCE_QUANTA * 10 ** -amountPrecision,
		Math.abs(onhandAmount) * QTY_INVARIANT_TOLERANCE_RATIO,
	);
}

/** 数量不変条件: `calcPnl` が復元した保有数量が assets API の実残高と許容誤差内で一致するか。 */
export function qtyInvariantHolds(onhandAmount: number, reconstructedQty: number, amountPrecision: number): boolean {
	return Math.abs(onhandAmount - reconstructedQty) <= qtyInvariantTolerance(onhandAmount, amountPrecision);
}

/**
 * 数量乖離の理由コードを推定する。
 *
 * - 該当銘柄に**原価へ算入できなかった** DONE の暗号資産入庫がある → `has_crypto_deposits`。
 *   算入できなかった入庫は `calcPnl` の数量にも原価にも入らないため、銘柄固有の証拠として
 *   最優先する。判定は `calcPnl` が返す `unpriced_deposit_count` を使う——入庫日の始値で
 *   算入済みの入庫は数量に効いており、もはや乖離の説明にならないので、
 *   `dw.deposits` を再走査して「入庫があるか」で判定してはいけない
 * - 約定履歴が打ち切られている / 入出金履歴が不完全 → `history_truncated`
 * - どちらでもない → `unknown`（例: 履歴に現れない出庫）
 */
export function qtyMismatchReasonFor(
	dw: DepositWithdrawalData | null,
	tradesTruncated: boolean,
	unpricedDepositCount: number,
): PortfolioQtyMismatchReason {
	if (unpricedDepositCount > 0) return 'has_crypto_deposits';
	if (tradesTruncated || (dw != null && !dw.isComplete)) return 'history_truncated';
	return 'unknown';
}

// ── 期間別実現損益（年初来 / 月初来） ──

/**
 * 指定期間内の実現損益を算出する。
 *
 * 入力は全履歴（trades / withdrawals / deposits とも）が前提。
 * 移動平均法の avg_cost は全履歴から積み上げ（期間開始前の買い・入庫・出庫も含む）、
 * 期間内 (executed_at >= sinceMs) の売り約定のみ実現損益として集計する。
 *
 * 暗号資産入庫は calcPnl と同じく入庫日の始値で原価に算入し、realized_pnl には計上しない。
 * 暗号資産出庫は calcPnl と同じく原価の按分減少として扱い、realized_pnl には計上しない。
 * これにより入出庫を挟んだ売却でも残数量・平均原価が calcPnl と整合する
 * （`depositCost` を渡さないと入庫ぶんの原価がゼロのまま売られ、期間実現損益が calcPnl と食い違う）。
 *
 * 入庫日の始値を解決できず算入できなかった入庫は、`unpriced_deposit_count` として
 * 件数を返す（#77）。この件数ぶんの入庫は原価にも数量にも入っていないため、
 * `realized_pnl` はその入庫を原価ゼロで売った結果を含みうる。
 */
export function calcPeriodRealizedPnl(
	trades: RawTrade[],
	sinceMs: number,
	periodStart: string,
	periodEnd: string,
	withdrawals?: RawWithdrawal[],
	depositCost?: DepositCostBasisInput,
): PeriodRealizedPnl {
	// 約定・入庫・出庫を時系列順に統合（通貨を超えて単一タイムラインで処理）
	type TradeEvent = { type: 'trade'; ts: number; trade: RawTrade };
	type DepositEvent = { type: 'deposit'; ts: number; asset: string; qty: number; cost: number };
	type WithdrawalEvent = { type: 'withdrawal'; ts: number; asset: string; amount: number };
	type Event = TradeEvent | DepositEvent | WithdrawalEvent;

	const events: Event[] = [];
	for (const t of trades) {
		const asset = t.pair.replace('_jpy', '');
		if (asset === 'jpy') continue;
		events.push({ type: 'trade', ts: t.executed_at, trade: t });
	}
	// 入庫の算入状況は `realized_pnl` の算出条件そのものなので、件数を数えて返す（#77）。
	// 銘柄で絞らないのは、期間実現損益が全銘柄を単一タイムラインで処理するため。
	const depositEvents = collectDepositCostEvents(depositCost);
	for (const d of depositEvents.priced) {
		events.push({ type: 'deposit', ts: d.ts, asset: d.asset, qty: d.qty, cost: d.cost });
	}
	for (const w of withdrawals ?? []) {
		if (w.asset === 'jpy') continue;
		if (w.status !== 'DONE') continue;
		const wdQty = Number(w.amount) + (Number(w.fee) || 0); // 出庫量 + 出庫手数料 = 口座から減った総量
		if (!Number.isFinite(wdQty) || wdQty <= 0) continue;
		events.push({ type: 'withdrawal', ts: w.requested_at, asset: w.asset, amount: wdQty });
	}
	events.sort((a, b) => a.ts - b.ts);

	// 通貨ごとに移動平均法で avg_cost を追跡し、期間内の sell のみ realized に計上
	const holdings = new Map<string, { qty: number; cost: number }>();
	let periodRealized = 0;
	let periodSellCount = 0;

	for (const event of events) {
		if (event.type === 'deposit') {
			// Crypto deposit: 入庫日の始値で原価に算入。realized_pnl には計上しない
			const h = holdings.get(event.asset) ?? { qty: 0, cost: 0 };
			h.cost += event.cost;
			h.qty += event.qty;
			holdings.set(event.asset, h);
		} else if (event.type === 'trade') {
			const t = event.trade;
			const asset = t.pair.replace('_jpy', '');
			const qty = Number(t.amount);
			const price = Number(t.price);
			if (!Number.isFinite(qty) || !Number.isFinite(price)) continue;

			const feeQuote = Number(t.fee_amount_quote) || 0;
			const feeBase = Number(t.fee_amount_base) || 0;
			const h = holdings.get(asset) ?? { qty: 0, cost: 0 };

			if (t.side === 'buy') {
				// 買い: JPY 出 = qty * price + feeQuote、base 入 = qty - feeBase
				h.cost += qty * price + feeQuote;
				h.qty += qty - feeBase;
			} else {
				// sell
				let sellRealized = 0;
				if (h.qty > 0) {
					const avgCost = h.cost / h.qty;
					// 売りで減る base 量は qty + feeBase（calcPnl と同じ対称形。残数量・平均原価を一致させる）
					// 保有量を超える売りの場合、原価は保有分のみ按分
					const coveredQty = Math.min(qty + feeBase, h.qty);
					const sellCost = coveredQty * avgCost;
					const sellRevenue = qty * price - feeQuote;
					sellRealized = sellRevenue - sellCost;
					h.cost -= sellCost;
					h.qty -= coveredQty;
					if (h.qty < 1e-12) {
						h.qty = 0;
						h.cost = 0;
					}
				} else {
					sellRealized = qty * price - feeQuote;
				}

				// 期間内の売りのみ集計
				if (t.executed_at >= sinceMs) {
					periodRealized += sellRealized;
					periodSellCount++;
				}
			}

			holdings.set(asset, h);
		} else {
			// Crypto withdrawal: 原価を按分減少。realized_pnl には計上しない
			const h = holdings.get(event.asset) ?? { qty: 0, cost: 0 };
			if (h.qty > 0 && event.amount > 0) {
				const avgCost = h.cost / h.qty;
				const removedQty = Math.min(event.amount, h.qty);
				h.cost -= removedQty * avgCost;
				h.qty -= removedQty;
				if (h.qty < 1e-12) {
					h.qty = 0;
					h.cost = 0;
				}
				holdings.set(event.asset, h);
			}
		}
	}

	let unpricedDepositCount = 0;
	for (const count of depositEvents.unpricedCounts.values()) unpricedDepositCount += count;

	return {
		realized_pnl: Math.round(periodRealized),
		sell_count: periodSellCount,
		period_start: periodStart,
		period_end: periodEnd,
		priced_deposit_count: depositEvents.priced.length,
		unpriced_deposit_count: unpricedDepositCount,
	};
}

// ── 信用 PnL 集計 ──

/**
 * 信用の集計値（決済損益とコスト項）。
 *
 * コスト項は `_cost` サフィックス付きで、**コスト = 正値**・`total` では減算という符号規約を
 * 名前に出している（#72）。`AccountPnl` が出す deprecated な別名 `margin_interest` /
 * `margin_fee` は wire 上の互換のためだけに存在し、内部の受け渡しには使わない。
 */
export interface MarginPnlTotals {
	margin_realized_pnl: number;
	margin_interest_cost: number;
	margin_fee_cost: number;
}

/**
 * 信用約定履歴から実現損益・利息・手数料を集計する。
 *
 * bitbank API 仕様の整理（bitbank-api-docs / rest-api_JP.md + 信用取引ルール）:
 *   - profit_loss: 決済約定のみに付与。平均取得価格法によるグロス実現損益。
 *     手数料・利息は控除されていない（信用取引ルール: 売買手数料・利息は
 *     別ロジックで算出され、CSV 報告書でも実現損益・実現手数料・実現利息は
 *     別カラムとして記録される）。
 *   - interest: 決済時に発生する利息（コスト = 正値）。profit_loss とは独立。
 *   - fee_occurred_amount_quote: その約定で発生した quote 通貨建て手数料。
 *     信用取引では決済時にまとめて徴収されるが、API レスポンスでは発生時点で
 *     記録される。profit_loss とは独立に控除する必要がある。
 *     ※ fee_amount_quote ではなく fee_occurred_amount_quote を採用する理由:
 *        後者は新規建て・決済の各約定で発生額を per-trade で正確に表すため、
 *        期間集計（年初来 / 月初来）でも timing 上のズレを最小化できる。
 *
 * total = spot + margin_realized - margin_interest_cost - margin_fee_cost
 *   （`*_cost` はいずれもコスト = 正値で返し、total では減算する。#72 でサフィックスを付けた）
 *
 * - 建玉約定（profit_loss なし）でも fee_occurred_amount_quote / interest が
 *   付くケースは合算する（profit_loss の有無を close_trade_count の判定にのみ使う）。
 * - 期間絞り込みは呼び出し側で事前に行うか、calcPeriodMarginPnl を使う。
 */
export function calcMarginPnl(trades: RawMarginTrade[]): MarginPnlTotals & { close_trade_count: number } {
	let realized = 0;
	let interest = 0;
	let fee = 0;
	let count = 0;
	for (const t of trades) {
		if (t.profit_loss != null) {
			const pl = Number(t.profit_loss);
			if (Number.isFinite(pl)) {
				realized += pl;
				count++;
			}
		}
		if (t.interest != null) {
			const it = Number(t.interest);
			if (Number.isFinite(it)) {
				interest += it;
			}
		}
		if (t.fee_occurred_amount_quote != null) {
			const fq = Number(t.fee_occurred_amount_quote);
			if (Number.isFinite(fq)) {
				fee += fq;
			}
		}
	}
	return {
		margin_realized_pnl: Math.round(realized),
		margin_interest_cost: Math.round(interest),
		margin_fee_cost: Math.round(fee),
		close_trade_count: count,
	};
}

/**
 * 期間内の信用約定のみで PnL・利息・手数料を集計する。
 */
export function calcPeriodMarginPnl(
	trades: RawMarginTrade[],
	sinceMs: number,
	periodStart: string,
	periodEnd: string,
): MarginPnlTotals & { close_trade_count: number; period_start: string; period_end: string } {
	const inPeriod = trades.filter((t) => t.executed_at >= sinceMs);
	const result = calcMarginPnl(inPeriod);
	return { ...result, period_start: periodStart, period_end: periodEnd };
}

/**
 * 現物の実現損益と信用 PnL から口座全体 PnL を構築する。
 * total = spot_realized_pnl + margin_realized_pnl - margin_interest_cost - margin_fee_cost
 * （`*_cost` はいずれもコスト = 正値で保持し、total では控除する）
 *
 * deprecated な別名 `margin_interest` / `margin_fee` にも**同じ正値**を載せる。
 * `DEPRECATED_FIELD_REMOVAL_TARGET`（`src/schema/base.ts`）で削除する際は、
 * ここの 2 行とスキーマ・型定義・summary の参照をまとめて落とすこと。
 */
export function buildAccountPnl(spotRealizedPnl: number, marginPnl: MarginPnlTotals): AccountPnl {
	return {
		spot_realized_pnl: spotRealizedPnl,
		margin_realized_pnl: marginPnl.margin_realized_pnl,
		margin_interest: marginPnl.margin_interest_cost,
		margin_fee: marginPnl.margin_fee_cost,
		total: spotRealizedPnl + marginPnl.margin_realized_pnl - marginPnl.margin_interest_cost - marginPnl.margin_fee_cost,
		margin_interest_cost: marginPnl.margin_interest_cost,
		margin_fee_cost: marginPnl.margin_fee_cost,
	};
}

/**
 * 期間版の口座全体 PnL を構築する。
 */
export function buildPeriodAccountPnl(
	spotRealizedPnl: number,
	marginPnl: MarginPnlTotals,
	periodStart: string,
	periodEnd: string,
): PeriodAccountPnl {
	return {
		...buildAccountPnl(spotRealizedPnl, marginPnl),
		period_start: periodStart,
		period_end: periodEnd,
	};
}

// ── 入出庫の JPY 換算（入出庫日価格の解決） ──

/**
 * 入出庫 1 件を JPY 換算するための単価を解決する。
 *
 * 解決順序は **入出庫日（入庫: `confirmed_at` / 出庫: `requested_at`）当日の 1day open →
 * 現在価格** の 2 段。前者で解けたぶんは相場が動いても評価額が動かない
 * （現在価格だけで換算すると誤差が相場と連動する系統的バイアスになる。#53 の機序 6）。
 *
 * 日付キーは `portfolioDayStartMs`（JST 暦日 0:00）で、`fetchCandlePriceData` /
 * `fetchFlowDatePrices` が積む `dailyPrices` のキーと同じ暦を共有する（`./calendar.ts`）。
 * `atMs` が非有限なら日次価格は引かず現在価格に落とす（`portfolioDayStartMs` は
 * 非有限で throw するため、呼ぶ前に弾く必要がある）。
 *
 * どちらも解決できない場合は `undefined`。呼び出し側は当該入出庫を集計から落とし、
 * 資産名を `unpriced_assets` に載せて申告すること（黙って 0 円計上しない）。
 */
export function resolveFlowPrice(
	pricing: FlowPricing,
	asset: string,
	atMs: number,
): { price: number; basis: 'deposit_date_price' | 'current_price_fallback' } | undefined {
	if (Number.isFinite(atMs)) {
		const dated = pricing.dailyPrices.get(asset)?.get(portfolioDayStartMs(atMs));
		if (dated != null && Number.isFinite(dated) && dated > 0) {
			return { price: dated, basis: 'deposit_date_price' };
		}
	}
	const current = pricing.currentPrices.get(asset);
	if (current != null && Number.isFinite(current) && current > 0) {
		return { price: current, basis: 'current_price_fallback' };
	}
	return undefined;
}

/**
 * 換算方式ごとの件数を貯める内部アキュムレータ。
 * 換算**できた**件数だけを数える（価格を全く解決できなかったぶんは `unpriced_assets` 側の担当）。
 */
class FlowValuationCounter {
	private dated = 0;
	private fallback = 0;

	count(basis: 'deposit_date_price' | 'current_price_fallback'): void {
		if (basis === 'deposit_date_price') this.dated++;
		else this.fallback++;
	}

	/** 1 件も換算していなければ `undefined`（出力側でキーごと落とすため） */
	toBreakdown(): FlowValuationBreakdown | undefined {
		return buildFlowValuationBreakdown(this.dated, this.fallback);
	}
}

/**
 * 換算件数から内訳を組み立てる。両方 0（＝換算対象が無い / 全件で価格を解決できなかった）なら
 * `undefined` を返し、呼び出し側でフィールドごと落とせるようにする。
 */
function buildFlowValuationBreakdown(dated: number, fallback: number): FlowValuationBreakdown | undefined {
	if (dated === 0 && fallback === 0) return undefined;
	return {
		deposit_date_price_count: dated,
		current_price_fallback_count: fallback,
		basis: fallback === 0 ? 'deposit_date_price' : dated === 0 ? 'current_price_fallback' : 'mixed',
	};
}

/**
 * 価格解決の対象範囲。入庫と出庫で下限時刻を**別々に**指定する。
 *
 * 消費者が構成によって非対称になるから分けている:
 * - 入庫は `calcDepositWithdrawalSummary`（純投入額・口座全体リターン）と取得原価が
 *   **常に全履歴**を換算する
 * - 出庫は `calcDepositWithdrawalSummary` が**全履歴**を換算する（#70 で元本回収として
 *   純投入額から減算するようになった）。ただし入出金分析セクションを出さない構成
 *   （`include_deposit_withdrawal=false`）ではその消費者が消え、残るのは期間集計
 *   （`calcPeriodDWSummary` / `calcPeriodNetFlow`）だけになるので年初来で足りる
 *
 * 出力に反映される先が無い入出庫まで換算対象に含めると、そのために candle を追加取得し、
 * `FlowValuationBreakdown` の件数と「現在価格で仮評価」警告まで動いてしまう。
 * 逆に反映先があるのに絞ると、その入出庫が黙って 0 円計上になる（#70 の機序そのもの）。
 */
export interface FlowValuationScope {
	/** 入庫を集める下限時刻（`confirmed_at >= depositsSinceMs`）。省略で全履歴 */
	depositsSinceMs?: number;
	/** 出庫を集める下限時刻（`requested_at >= withdrawalsSinceMs`）。省略で全履歴 */
	withdrawalsSinceMs?: number;
}

/**
 * 価格解決が必要な入出庫（DONE・非 JPY・数量が正）を列挙する。
 *
 * `fetchFlowDatePrices` の追加取得対象の決定と、レスポンス全体の換算方式の集計
 * （`summarizeFlowValuation`）の両方で同じ母集合を使うためのヘルパー。
 * JPY の入出金は換算不要、数量ゼロ・数値不正の入出庫は金額に寄与しないので除外する
 * （`calcPeriodNetFlow` の `unpriced_assets` 判定と同じ基準）。
 *
 * 絞り込みの下限は `scope` で入庫・出庫それぞれに指定する（非対称な理由は
 * `FlowValuationScope` の doc を参照）。
 */
export function collectFlowValuationTargets(
	dw: DepositWithdrawalData | null,
	scope: FlowValuationScope = {},
): FlowValuationTarget[] {
	if (!dw) return [];
	const targets: FlowValuationTarget[] = [];
	const push = (
		kind: 'deposit' | 'withdrawal',
		asset: string,
		amount: string,
		status: string,
		atMs: number,
		sinceMs?: number,
	) => {
		if (status !== 'DONE') return;
		if (asset === 'jpy') return;
		const qty = Number(amount);
		if (!Number.isFinite(qty) || qty <= 0) return;
		if (sinceMs != null && !(atMs >= sinceMs)) return;
		targets.push({ asset, atMs, kind });
	};
	for (const d of dw.deposits) push('deposit', d.asset, d.amount, d.status, d.confirmed_at, scope.depositsSinceMs);
	for (const w of dw.withdrawals)
		push('withdrawal', w.asset, w.amount, w.status, w.requested_at, scope.withdrawalsSinceMs);
	return targets;
}

/**
 * 入出庫群を実際に換算したときの方式の内訳を返す（レスポンス全体の申告用）。
 *
 * 各セクションが返す内訳は互いに重なる部分集合（全履歴の入出金サマリー ⊃ 年初来 ⊃ 月初来）なので、
 * 単純に足すと二重計上になる。meta / summary の「n 件は現在価格で仮評価」は本関数で
 * **母集合を 1 度だけ**数えた値を使う。
 */
export function summarizeFlowValuation(
	targets: FlowValuationTarget[],
	pricing: FlowPricing,
): FlowValuationBreakdown | undefined {
	const counter = new FlowValuationCounter();
	for (const t of targets) {
		const resolved = resolveFlowPrice(pricing, t.asset, t.atMs);
		if (resolved) counter.count(resolved.basis);
	}
	return counter.toBreakdown();
}

// ── 入出金サマリー ──

/**
 * 入出金データから口座全体のリターンを算出する。
 *
 * - JPY 入金: 投資元本（入金）
 * - JPY 出金: 投資元本の回収（出金）
 * - 暗号資産入庫: **入庫日（`confirmed_at`）の 1day open** で JPY 換算し、投入額に加算。
 *   日次価格を解決できなかった分のみ現在価格にフォールバックし、内訳を
 *   `crypto_deposit_valuation` で申告する（黙って混ぜない）
 * - 暗号資産出庫: **出庫日（`requested_at`）の 1day open** で JPY 換算し、JPY 出金と同じ
 *   「元本の回収」として投入額から減算。内訳は `crypto_withdrawal_valuation` で申告する
 * - 純投入額 = JPY入金合計 - JPY出金合計 + 暗号資産入庫の推定JPY評価額 - 暗号資産出庫の推定JPY評価額
 * - 口座全体リターン = (現在評価額 - 純投入額) / 純投入額
 *
 * 入出庫を入出庫日価格で固定するのは、現在価格で仮評価すると誤差が相場と連動して動き、
 * 取引ゼロでも相場上昇だけで報告リターンが悪化するため（#53 の機序 6）。
 * ただしこれは「入庫時点の相場で取得した」という**仮定**であって真の取得原価ではない。
 *
 * 出庫を元本回収として扱うのは、他所のウォレットへ移して保有を続けていても**この口座の外
 * なので測れない**ため。口座内で完結する一貫した定義はこれしかない（外部保有分の値動きは
 * 測定対象外であることを出力の注記に明記する）。減算しないと出た価値が「投入したまま
 * 消えた損失」として残り、出庫が多いほどリターンが悪く見える（#70）。
 *
 * 出庫手数料（`fee`）は元本に含めない。`calcPeriodNetFlow` が元本移動（`net_flow_jpy`）と
 * 手数料（`withdrawal_fee_jpy`）を分離しているのと同じ規約で、JPY 出金側も `amount` だけを
 * 集計している（`total_jpy_withdrawn`）ため、暗号資産出庫だけ手数料込みにすると非対称になる。
 */
export function calcDepositWithdrawalSummary(
	dw: DepositWithdrawalData,
	totalJpyValue: number,
	pricing: FlowPricing,
): DepositWithdrawalSummary {
	// DONE ステータスの入金のみ集計（FOUND / CONFIRMED は未完了）
	const completedDeposits = dw.deposits.filter((d) => d.status === 'DONE');
	const completedWithdrawals = dw.withdrawals.filter((w) => w.status === 'DONE');

	// JPY 入出金
	const jpyDeposits = completedDeposits.filter((d) => d.asset === 'jpy');
	const jpyWithdrawals = completedWithdrawals.filter((w) => w.asset === 'jpy');
	const totalJpyDeposited = jpyDeposits.reduce((sum, d) => sum + Number(d.amount), 0);
	const totalJpyWithdrawn = jpyWithdrawals.reduce((sum, w) => sum + Number(w.amount), 0);

	// 暗号資産入出庫
	const cryptoDeposits = completedDeposits.filter((d) => d.asset !== 'jpy');
	const cryptoWithdrawals = completedWithdrawals.filter((w) => w.asset !== 'jpy');

	// 暗号資産入庫の推定 JPY 評価（入庫日の始値 → 解けなければ現在価格）
	let cryptoDepositEstimatedJpy = 0;
	let hasEstimate = false;
	const depositValuation = new FlowValuationCounter();
	for (const d of cryptoDeposits) {
		const amount = Number(d.amount);
		if (!Number.isFinite(amount) || amount <= 0) continue;
		const resolved = resolveFlowPrice(pricing, d.asset, d.confirmed_at);
		if (!resolved) continue;
		cryptoDepositEstimatedJpy += amount * resolved.price;
		depositValuation.count(resolved.basis);
		hasEstimate = true;
	}

	// 暗号資産出庫の推定 JPY 評価（出庫日の始値 → 解けなければ現在価格）。
	// 元本のみ。手数料（w.fee）は含めない（本関数の doc 参照）。
	let cryptoWithdrawalEstimatedJpy = 0;
	let hasWithdrawalEstimate = false;
	const withdrawalValuation = new FlowValuationCounter();
	for (const w of cryptoWithdrawals) {
		const amount = Number(w.amount);
		if (!Number.isFinite(amount) || amount <= 0) continue;
		const resolved = resolveFlowPrice(pricing, w.asset, w.requested_at);
		if (!resolved) continue;
		cryptoWithdrawalEstimatedJpy += amount * resolved.price;
		withdrawalValuation.count(resolved.basis);
		hasWithdrawalEstimate = true;
	}

	const netJpyInvested =
		totalJpyDeposited -
		totalJpyWithdrawn +
		(hasEstimate ? cryptoDepositEstimatedJpy : 0) -
		(hasWithdrawalEstimate ? cryptoWithdrawalEstimatedJpy : 0);

	// 口座全体リターン
	let accountReturnPct: number | undefined;
	let accountReturnJpy: number | undefined;
	if (netJpyInvested > 0) {
		accountReturnJpy = Math.round(totalJpyValue - netJpyInvested);
		accountReturnPct = Math.round(((totalJpyValue - netJpyInvested) / netJpyInvested) * 10000) / 100;
	}

	const summary: DepositWithdrawalSummary = {
		total_jpy_deposited: Math.round(totalJpyDeposited),
		total_jpy_withdrawn: Math.round(totalJpyWithdrawn),
		net_jpy_invested: Math.round(netJpyInvested),
		crypto_deposit_count: cryptoDeposits.length,
		crypto_deposit_estimated_jpy: hasEstimate ? Math.round(cryptoDepositEstimatedJpy) : undefined,
		crypto_withdrawal_count: cryptoWithdrawals.length,
		crypto_withdrawal_estimated_jpy: hasWithdrawalEstimate ? Math.round(cryptoWithdrawalEstimatedJpy) : undefined,
		account_return_pct: accountReturnPct,
		account_return_jpy: accountReturnJpy,
		is_complete: dw.isComplete,
		analysis_basis: 'deposit_withdrawal',
	};
	// 該当なしのときはキーごと省き、暗号資産入出庫が無い口座の出力を従来と JSON 一致させる。
	const valuation = depositValuation.toBreakdown();
	if (valuation) summary.crypto_deposit_valuation = valuation;
	const wdValuation = withdrawalValuation.toBreakdown();
	if (wdValuation) summary.crypto_withdrawal_valuation = wdValuation;
	return summary;
}

/**
 * 期間内の入出金を集計する。年次・月次サマリー用。
 *
 * 暗号資産の入出庫は `calcDepositWithdrawalSummary` と同じく入出庫日
 * （入庫: `confirmed_at` / 出庫: `requested_at`）の 1day open で JPY 換算し、
 * 解決できなかった分だけ現在価格にフォールバックして内訳を `*_valuation` で申告する。
 */
export function calcPeriodDWSummary(
	dw: DepositWithdrawalData,
	sinceMs: number,
	periodStartIso: string,
	periodEndIso: string,
	pricing: FlowPricing,
): PeriodDWSummary {
	const completedDeposits = dw.deposits.filter((d) => d.status === 'DONE' && d.confirmed_at >= sinceMs);
	const completedWithdrawals = dw.withdrawals.filter((w) => w.status === 'DONE' && w.requested_at >= sinceMs);

	// JPY
	const jpyDep = completedDeposits.filter((d) => d.asset === 'jpy');
	const jpyWd = completedWithdrawals.filter((w) => w.asset === 'jpy');
	const jpyDeposited = jpyDep.reduce((s, d) => s + Number(d.amount), 0);
	const jpyWithdrawn = jpyWd.reduce((s, w) => s + Number(w.amount), 0);

	// Crypto deposits
	const cryptoDep = completedDeposits.filter((d) => d.asset !== 'jpy');
	let cryptoDepJpy = 0;
	let hasDepEstimate = false;
	const depValuation = new FlowValuationCounter();
	for (const d of cryptoDep) {
		const amount = Number(d.amount);
		if (!Number.isFinite(amount) || amount <= 0) continue;
		const resolved = resolveFlowPrice(pricing, d.asset, d.confirmed_at);
		if (!resolved) continue;
		cryptoDepJpy += amount * resolved.price;
		depValuation.count(resolved.basis);
		hasDepEstimate = true;
	}

	// Crypto withdrawals
	const cryptoWd = completedWithdrawals.filter((w) => w.asset !== 'jpy');
	let cryptoWdJpy = 0;
	let hasWdEstimate = false;
	const wdValuation = new FlowValuationCounter();
	for (const w of cryptoWd) {
		const amount = Number(w.amount);
		if (!Number.isFinite(amount) || amount <= 0) continue;
		const resolved = resolveFlowPrice(pricing, w.asset, w.requested_at);
		if (!resolved) continue;
		cryptoWdJpy += amount * resolved.price;
		wdValuation.count(resolved.basis);
		hasWdEstimate = true;
	}

	const summary: PeriodDWSummary = {
		jpy_deposited: Math.round(jpyDeposited),
		jpy_withdrawn: Math.round(jpyWithdrawn),
		net_jpy: Math.round(jpyDeposited - jpyWithdrawn),
		crypto_deposit_count: cryptoDep.length,
		crypto_deposit_estimated_jpy: hasDepEstimate ? Math.round(cryptoDepJpy) : undefined,
		crypto_withdrawal_count: cryptoWd.length,
		crypto_withdrawal_estimated_jpy: hasWdEstimate ? Math.round(cryptoWdJpy) : undefined,
		period_start: periodStartIso,
		period_end: periodEndIso,
	};
	// 既存キーの後ろに置き、該当なしのときはキーごと省いて従来出力と JSON 一致させる。
	const depBreakdown = depValuation.toBreakdown();
	if (depBreakdown) summary.crypto_deposit_valuation = depBreakdown;
	const wdBreakdown = wdValuation.toBreakdown();
	if (wdBreakdown) summary.crypto_withdrawal_valuation = wdBreakdown;
	return summary;
}

// ── JST 期間境界 ──

/**
 * JST 基準の年初来・月初来の境界タイムスタンプを返す。
 *
 * 当日の起点だけは `portfolioDayStartMs`（= `lib/calendar.ts`）経由で求める。
 * `fetchCandlePriceData` の日次価格キーおよび資産推移の日次点と同じ暦日境界を
 * 共有する必要があるため（`./calendar.ts` 参照）。
 */
export function getJstPeriodBoundaries() {
	const nowMs = Date.now();
	const nowJst = dayjs(nowMs).tz(PORTFOLIO_CALENDAR_TZ);
	const yearStart = nowJst.startOf('year');
	const monthStart = nowJst.startOf('month');
	const dayStart = dayjs(portfolioDayStartMs(nowMs)).tz(PORTFOLIO_CALENDAR_TZ);
	return {
		yearStartMs: yearStart.valueOf(),
		yearStartIso: yearStart.format('YYYY-MM-DDTHH:mm:ssZ'),
		monthStartMs: monthStart.valueOf(),
		monthStartIso: monthStart.format('YYYY-MM-DDTHH:mm:ssZ'),
		dayStartMs: dayStart.valueOf(),
		dayStartIso: dayStart.format('YYYY-MM-DDTHH:mm:ssZ'),
		nowIso: nowJst.format('YYYY-MM-DDTHH:mm:ssZ'),
	};
}

// ── 保有復元・エクイティ ──

/**
 * 現在の保有情報から取引・入出金を逆順に辿り、指定日時の保有状態を復元する。
 */
export function reconstructHoldingsAtDate(
	currentHoldings: Array<{ asset: string; amount: string }>,
	trades: RawTrade[],
	sinceMs: number,
	dw: DepositWithdrawalData | null,
): Map<string, number> {
	const holdings = new Map<string, number>();
	for (const h of currentHoldings) {
		const amount = Number(h.amount);
		if (Number.isFinite(amount) && amount > 0) {
			holdings.set(h.asset, amount);
		}
	}

	// Reverse trades since sinceMs (newest first)
	const recentTrades = trades.filter((t) => t.executed_at >= sinceMs).sort((a, b) => b.executed_at - a.executed_at);

	for (const t of recentTrades) {
		const asset = t.pair.replace('_jpy', '');
		const qty = Number(t.amount);
		const price = Number(t.price);
		const feeQuote = Number(t.fee_amount_quote) || 0;
		const feeBase = Number(t.fee_amount_base) || 0;
		if (!Number.isFinite(qty) || !Number.isFinite(price)) continue;

		const current = holdings.get(asset) ?? 0;
		const currentJpy = holdings.get('jpy') ?? 0;

		if (t.side === 'buy') {
			// Reverse buy: 買いで実際に増えた base 量は qty - feeBase。それを巻き戻す。
			// 途中経過が負でも保持する（出庫相などで相殺される繰り越しを落とさない）。
			holdings.set(asset, current - (qty - feeBase));
			holdings.set('jpy', currentJpy + qty * price + feeQuote);
		} else {
			// Reverse sell: 売りで実際に減った base 量は qty + feeBase（base 建て手数料も base から引かれる）。
			// それを巻き戻す。買い側の `qty - feeBase` と符号だけが逆の対称形。
			// 冒頭の方針コメントのとおり売りの feeBase は API 仕様上ゼロだが、
			// 非ゼロが来ても算術的に正しくなるよう防御的に加算する。
			holdings.set(asset, current + qty + feeBase);
			holdings.set('jpy', currentJpy - qty * price + feeQuote);
		}
	}

	// Reverse deposits/withdrawals since sinceMs
	if (dw) {
		const completedDeposits = dw.deposits.filter((d) => d.status === 'DONE' && d.confirmed_at >= sinceMs);
		const completedWithdrawals = dw.withdrawals.filter((w) => w.status === 'DONE' && w.requested_at >= sinceMs);

		for (const d of completedDeposits) {
			const current = holdings.get(d.asset) ?? 0;
			// 約定相と同様、途中のゼロ床クランプはしない（全相終了後に掃除）。
			holdings.set(d.asset, current - Number(d.amount));
		}

		for (const w of completedWithdrawals) {
			const current = holdings.get(w.asset) ?? 0;
			const fee = Number(w.fee) || 0;
			holdings.set(w.asset, current + Number(w.amount) + fee);
		}
	}

	// Clean up negative/zero holdings（3 相すべて適用後の最終パスのみ）
	for (const [asset, amount] of holdings) {
		if (amount < 1e-12) holdings.delete(asset);
	}

	return holdings;
}

/**
 * 復元された保有情報と価格マップから口座評価額を算出する。
 */
export function calcPortfolioValue(holdings: Map<string, number>, priceMap: Map<string, number>): number {
	let total = 0;
	for (const [asset, amount] of holdings) {
		if (asset === 'jpy') {
			total += amount;
		} else {
			const price = priceMap.get(asset);
			if (price) {
				total += amount * price;
			}
		}
	}
	return total;
}

/**
 * 資産推移シリーズの各点に載せる純入出金額（`EquityPoint.flow_jpy`）を求める。
 *
 * `pointMsAsc` は**昇順の日次点・月次点の時刻**（最終点＝現在のリアルタイム評価額は含めない）。
 * 入出金 1 件は、その入出庫日（JST 暦日 0:00 に丸めた `confirmed_at` / `requested_at`）**以前で
 * 最も新しい点**のバケットに入る。点の間隔が日次でも月次でも同じ実装で成立する。
 *
 * 丸めに `portfolioDayStartMs` を使うのは点のキーと暦を共有するため（`./calendar.ts`）。点のキー
 * 自体が JST 暦日 0:00 なので生の時刻で比較しても結果は同じだが、点の間隔が変わっても
 * 「入出庫日で寄せる」意図が実装から読めるように丸めを明示する。
 *
 * 集計の範囲・向きは `EquityPoint.flow_jpy` の doc を単一ソースとする。実装上の要点のみ:
 *
 * - 履歴が欠けている構成では**全点で載せない**。判定は `flowUnavailableReasonFor` に委ねる
 *   （下記「履歴が欠けている場合」）。
 * - 最初の点より前の入出金は落とす。シリーズの外＝期初評価額に織り込み済みで、載せる点が無い。
 * - 暗号資産は `resolveFlowPrice`（入出庫日の始値 → 解決できなければ現在価格）で換算する。
 *   どちらでも解決できない分は計上しない。申告は同じ期間を張る
 *   `PeriodPerformance.unpriced_flow_assets` が担当する。
 * - `status !== 'DONE'` / 数量が非有限・非正の入出金は除外する（`collectFlowValuationTargets` と
 *   同じ基準）。JPY も同じ検証を通す——1 件の不正値でバケット全体を NaN にしないため。
 * - 純額がゼロに丸まる点はキーごと落とす（フローゼロの期間で従来と同じ出力にするため）。
 *
 * ## 履歴が欠けている場合
 *
 * 判定は `flowUnavailableReasonFor(dw)` と**同一**にする（取得失敗 / 一部チャネル失敗 /
 * 件数上限による打ち切り）。同じ述語を使うのは、`*_performance` が「純入出金: 未計測」と
 * 言っている応答で、資産推移の点だけが `← 純入出金 +500,000円` と確定値を出す自己矛盾を
 * 防ぐため。取得できた部分集合だけを合計すると、たとえば暗号資産出庫チャネルだけが
 * 落ちた構成で「入金しかない口座」に見える（`allFailed` は false・`warnings` にのみ現れる
 * ので、`allFailed` / `isComplete` だけを見る判定ではこの穴を塞げない）。
 *
 * 部分値を出さない代わりに、シリーズの段差は説明されないまま残る。この状態は
 * `*_performance.flow_measured=false` / `flow_unavailable_reason` と summary の
 * 「入出金を巻き戻せていません」行が既に申告している（本関数で新しい申告経路は作らない）。
 */
export function buildEquityFlowByPoint(
	dw: DepositWithdrawalData | null,
	pricing: FlowPricing,
	pointMsAsc: number[],
): Map<number, number> {
	const byPoint = new Map<number, number>();
	if (!dw || pointMsAsc.length === 0) return byPoint;
	// 未計測を 0 でも部分値でもなく「キーの不在」で表す（上記「履歴が欠けている場合」）。
	if (flowUnavailableReasonFor(dw) != null) return byPoint;
	const firstPointMs = pointMsAsc[0];

	const add = (asset: string, amount: string, status: string, atMs: number, signum: 1 | -1) => {
		if (status !== 'DONE') return;
		if (!Number.isFinite(atMs)) return;
		const qty = Number(amount);
		if (!Number.isFinite(qty) || qty <= 0) return;
		const dayMs = portfolioDayStartMs(atMs);
		if (dayMs < firstPointMs) return;

		let jpy: number;
		if (asset === 'jpy') {
			jpy = qty;
		} else {
			const resolved = resolveFlowPrice(pricing, asset, atMs);
			if (!resolved) return;
			jpy = qty * resolved.price;
		}
		const key = lastPointAtOrBefore(pointMsAsc, dayMs);
		byPoint.set(key, (byPoint.get(key) ?? 0) + signum * jpy);
	};

	for (const d of dw.deposits) add(d.asset, d.amount, d.status, d.confirmed_at, 1);
	for (const w of dw.withdrawals) add(w.asset, w.amount, w.status, w.requested_at, -1);

	// value_jpy と同じ粒度に丸め、相殺してゼロになった点はキーごと落とす。
	for (const [key, value] of byPoint) {
		const rounded = Math.round(value);
		if (rounded === 0) byPoint.delete(key);
		else byPoint.set(key, rounded);
	}
	return byPoint;
}

/**
 * 昇順の点列から `atMs` 以下で最大の要素を返す。呼び出し前に `atMs >= pointMsAsc[0]` が
 * 保証されている前提（`buildEquityFlowByPoint` が範囲外を先に落としている）。
 */
function lastPointAtOrBefore(pointMsAsc: number[], atMs: number): number {
	let lo = 0;
	let hi = pointMsAsc.length - 1;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (pointMsAsc[mid] <= atMs) lo = mid;
		else hi = mid - 1;
	}
	return pointMsAsc[lo];
}

/**
 * 指定日付群について保有状態を復元し、各時点の JPY 建て総資産額を算出する。
 * 最終点として現在のリアルタイム評価額を追加する。
 *
 * 価格解決順序: 各日付・各保有資産について、まず `dailyPrices`（1day candle open）を試み、
 * 取得できない場合は `fallbackPrices`（現在 ticker 価格）にフォールバックする。
 * フォールバックは JPY のみ保有 / 一部資産で candle 取得失敗時にも equity series を
 * 構築可能にし、最終点 `currentValueJpy` との整合性を保つために重要。
 *
 * `flowPricing` を渡すと各点に `flow_jpy`（その点から次の点までの純入出金）を載せる。
 * 入出金は `reconstructHoldingsAtDate` に渡すのと同じ `dwData` から拾うので、巻き戻した
 * 保有と載せるフローが同じ母集合になる（詳細は `buildEquityFlowByPoint` / `EquityPoint.flow_jpy`）。
 * 省略した場合は従来どおり `timestamp` / `value_jpy` のみの点を返す。
 */
export function buildEquitySeries(
	dates: ReturnType<typeof dayjs>[],
	currentHoldings: Array<{ asset: string; amount: string }>,
	allTrades: RawTrade[],
	dwData: DepositWithdrawalData | null,
	dailyPrices: Map<string, Map<number, number>>,
	currentValueJpy: number,
	currentIso: string,
	fallbackPrices?: Map<string, number>,
	flowPricing?: FlowPricing,
): EquityPoint[] {
	const series: EquityPoint[] = [];
	const flowByPoint = flowPricing
		? buildEquityFlowByPoint(
				dwData,
				flowPricing,
				dates.map((d) => d.valueOf()),
			)
		: undefined;

	for (const date of dates) {
		const dateMs = date.valueOf();
		const holdings = reconstructHoldingsAtDate(currentHoldings, allTrades, dateMs, dwData);

		// holdings に登場する非 JPY 資産について daily candle open を優先、無ければ現在価格にフォールバック。
		// dailyPrices を起点に回す旧実装だと candle 全失敗時に priceMap が空になり、historical 点と
		// 最終点 (currentValueJpy) でスケールが一致しなくなる。
		const priceMap = new Map<string, number>();
		for (const asset of holdings.keys()) {
			if (asset === 'jpy') continue;
			const daily = dailyPrices.get(asset)?.get(dateMs);
			if (daily != null) {
				priceMap.set(asset, daily);
				continue;
			}
			const fb = fallbackPrices?.get(asset);
			if (fb != null) priceMap.set(asset, fb);
		}

		const value = Math.round(calcPortfolioValue(holdings, priceMap));
		const point: EquityPoint = {
			timestamp: date.format('YYYY-MM-DDTHH:mm:ssZ'),
			value_jpy: value,
		};
		// 純額ゼロ・フロー未取得の点はキーごと落として、フローが無い期間の出力を従来と JSON 一致させる。
		const flow = flowByPoint?.get(dateMs);
		if (flow != null) point.flow_jpy = flow;
		series.push(point);
	}

	// Final point: current real-time value
	series.push({
		timestamp: currentIso,
		value_jpy: currentValueJpy,
	});

	return series;
}

// ── 入出金データの利用可否 ──

/**
 * `analyze_my_portfolio` の**入出金分析セクション**の状態を判定する。
 *
 * - `not_requested`: `include_deposit_withdrawal=false`（セクションを出力しない）
 * - `available`: 取得成功かつ履歴あり（入出金ベースの分析を実行できる）
 * - `no_history`: 取得成功・警告なしで本当に履歴 0 件
 * - `fallback`: 取得失敗 / partial failure で約定ベースにフォールバック
 *
 * **これは表示セクションの状態であって、損益計算が入出金履歴を使えたかではない。**
 * `include_pnl=true` なら `include_deposit_withdrawal` の値に関わらず入出金履歴を取得して
 * 損益計算に供給するため、`not_requested`（＝セクション未リクエスト）でも取得原価は
 * 正しく出る。損益側で使えたかは `flowUnavailableReasonFor` が別軸で判定する。
 */
export function resolveDepositWithdrawalStatus(
	includeDepositWithdrawal: boolean,
	dw: DepositWithdrawalData | null,
): DepositWithdrawalStatus {
	if (!includeDepositWithdrawal) return 'not_requested';
	if (!dw) return 'fallback';
	if (!dw.allFailed && (dw.deposits.length > 0 || dw.withdrawals.length > 0)) return 'available';
	if (!dw.allFailed && dw.warnings.length === 0 && dw.deposits.length === 0 && dw.withdrawals.length === 0) {
		return 'no_history';
	}
	return 'fallback';
}

/**
 * 入出金履歴を損益計算に使えない場合の理由コードを返す（使える場合は `undefined`）。
 *
 * **判定軸は取得結果だけで、`include_deposit_withdrawal`（表示セクションの制御）とも
 * `DepositWithdrawalStatus` とも独立している。** 損益を出す構成（`include_pnl=true`）では
 * 入出金履歴を常に取得するので、ここで見るべきは「取得できた履歴が完全か」だけになる。
 * `status` は「どの分析基準のセクションを出力したか」を表す別軸の値で、判定には使わない。
 *
 * `fetchDepositWithdrawal` は 暗号資産入庫 / JPY 入金 / 暗号資産出庫 / JPY 出金 の 4 チャネルを
 * 個別に取得し、一部だけ失敗しても残りにレコードがあれば `allFailed: false` で返す。
 * このとき暗号資産出庫チャネルが落ちていると、`cost_basis` を過大化させる当の出庫だけが
 * 欠けた `withdrawals` がそのまま `calcPnl` に渡ってしまう。件数上限による打ち切り
 * （`isComplete: false`）も同じく出庫の取りこぼしになる。だから `allFailed` だけでなく
 * `warnings` / `isComplete` も見る。
 *
 * 理由コードを立てても `status` 側は据え置くので、`deposit_withdrawal_summary`
 * （`is_complete` 付きの実データ）は従来どおり出力される——原価が信頼できないことと、
 * 入出金サマリーが使えないことは別問題。
 */
export function flowUnavailableReasonFor(dw: DepositWithdrawalData | null): PortfolioFlowUnavailableReason | undefined {
	// 取得そのものが例外で落ちた（fetchDepositWithdrawal が null）。
	if (!dw) return 'dw_fetch_failed';
	// 全チャネル失敗、または一部チャネルの失敗。出庫チャネルが落ちたかは warnings からは
	// 判別できるが、どのチャネルであれ「履歴が欠けている」以上は原価を確定できないので一律で閉じる。
	if (dw.allFailed || dw.warnings.length > 0) return 'dw_fetch_failed';
	// 件数上限による打ち切り。取得自体は成功しているので失敗とは別コードにする
	// （再実行しても解消しないため、案内文言も変わる）。
	if (!dw.isComplete) return 'dw_history_incomplete';
	return undefined;
}

// ── 期間ネットフロー ──

/** 純入出金が未計測であることを表す `PeriodNetFlowResult`（呼び出しごとに新しい object を返す） */
function unmeasuredNetFlow(): PeriodNetFlowResult {
	return { net_flow_jpy: null, withdrawal_fee_jpy: null, measured: false };
}

/**
 * 期間中の純入出金額と出金手数料を分離して算出する。
 *
 * - net_flow_jpy: 元本の移動のみ（出金手数料を含まない）。
 *   正値 = 純入金（口座に資金流入）、負値 = 純出金。
 * - withdrawal_fee_jpy: 出金時に失った手数料の合計。
 *   adjusted_change から net_flow を引いた結果にこのコストが残る。
 * - unpriced_assets: 価格を解決できず集計から落ちた暗号資産のシンボル（該当なしなら undefined）。
 *   落ちた入出庫は 0 円計上と等価。入庫を落とせば net_flow_jpy は過小、出庫を落とせば過大に
 *   なる（向きが方向で逆になる）ため、黙って落とさず申告する。
 * - valuation: 換算方式の内訳（該当なしなら undefined）。
 *
 * 暗号資産の入出庫は**入出庫日（入庫: confirmed_at / 出庫: requested_at）の 1day open** で
 * JPY 換算する。現在価格で仮評価すると誤差が相場と連動して動き、取引ゼロでも相場上昇だけで
 * 純入出金・調整後増減が動いてしまうため（#53 の機序 6）。日次価格を解決できなかった分だけ
 * 現在価格にフォールバックし、`valuation` で混在を申告する。
 *
 * `dw` が null（入出金履歴を取得していない）の場合は **0 を返さない**。
 * 0 を返すと呼び出し側で「未計測」と「本当にフローがゼロ」が区別できず、
 * `adjusted_change = change - 0` がフローゼロ前提の確定値として出てしまうため、
 * `measured: false` + 値 null で未計測であることを明示する。
 */
export function calcPeriodNetFlow(
	dw: DepositWithdrawalData | null,
	sinceMs: number,
	pricing: FlowPricing,
): PeriodNetFlowResult {
	if (!dw) return unmeasuredNetFlow();

	const completedDeposits = dw.deposits.filter((d) => d.status === 'DONE' && d.confirmed_at >= sinceMs);
	const completedWithdrawals = dw.withdrawals.filter((w) => w.status === 'DONE' && w.requested_at >= sinceMs);

	let netFlow = 0;
	let withdrawalFee = 0;
	// 価格を解決できなかった資産（JPY 建て換算ができず集計に載せられなかったもの）。
	// 数量ゼロ・数値不正で寄与しない入出庫は元から金額に影響しないため対象外とする。
	const unpricedAssets = new Set<string>();
	const valuation = new FlowValuationCounter();

	// Deposits (inflow)
	for (const d of completedDeposits) {
		if (d.asset === 'jpy') {
			netFlow += Number(d.amount);
			continue;
		}
		const amount = Number(d.amount);
		if (!Number.isFinite(amount) || amount <= 0) continue;
		const resolved = resolveFlowPrice(pricing, d.asset, d.confirmed_at);
		if (resolved) {
			netFlow += amount * resolved.price;
			valuation.count(resolved.basis);
		} else {
			unpricedAssets.add(d.asset);
		}
	}

	// Withdrawals — 元本（外部フロー）と手数料（コスト）を分離
	for (const w of completedWithdrawals) {
		const fee = Number(w.fee) || 0;
		if (w.asset === 'jpy') {
			netFlow -= Number(w.amount);
			withdrawalFee += fee;
			continue;
		}
		const amount = Number(w.amount);
		if (!Number.isFinite(amount) || amount <= 0) continue;
		// 出庫の単価も出庫日（requested_at）で固定する。元本と手数料は同じ単価で換算しないと
		// 「元本は出庫日・手数料は現在」という混成になり、withdrawal_fee_jpy だけが相場で動く。
		const resolved = resolveFlowPrice(pricing, w.asset, w.requested_at);
		if (resolved) {
			netFlow -= amount * resolved.price;
			if (fee > 0) {
				withdrawalFee += fee * resolved.price;
			}
			valuation.count(resolved.basis);
		} else {
			// 元本だけでなく出金手数料も JPY 換算できていない（withdrawal_fee_jpy も過小になる）
			unpricedAssets.add(w.asset);
		}
	}

	const result: PeriodNetFlowResult = {
		net_flow_jpy: Math.round(netFlow),
		withdrawal_fee_jpy: Math.round(withdrawalFee),
		measured: true,
	};
	// 該当なしのときはキーごと省き、価格を全解決できたときの出力を安定させる。
	if (unpricedAssets.size > 0) result.unpriced_assets = [...unpricedAssets].sort();
	const breakdown = valuation.toBreakdown();
	if (breakdown) result.valuation = breakdown;
	return result;
}

// ── 期間別パフォーマンス（評価額比較） ──

export const PERFORMANCE_NOTE =
	'期初評価額は現在の保有状態から約定・入出金を逆算して復元し、期初時点の始値（1day candle open）で評価。暗号資産の入出庫は入出庫日（入庫: confirmed_at / 出庫: requested_at）の始値で JPY 換算し、その日の価格を取得できなかった分のみ現在価格で仮評価する（内訳は flow_valuation）。純入出金は元本移動のみ（出金手数料を含まない）。調整後増減 = 単純増減 - 純入出金（市場変動 + 出金手数料コスト）。増減率（change_pct / adjusted_change_pct）は期初評価額が 0、または現在評価額の 1% 未満のときは出さない（分母が小さすぎて率が運用成績ではなく「期初がほぼ空だった」ことを表す数になるため。理由は change_pct_unavailable_reason、増減額は通常どおり出る）。';

export type PeriodPerformanceKey = 'daily' | 'monthly' | 'yearly';

export interface PeriodSpec {
	key: PeriodPerformanceKey;
	startMs: number;
	startIso: string;
}

export interface PortfolioPerformanceContext {
	currentHoldings: Array<{ asset: string; amount: string }>;
	trades: RawTrade[];
	dwData: DepositWithdrawalData | null;
	candlePriceData: CandlePriceData;
	/**
	 * 暗号資産入出庫の JPY 換算に使う価格ソース。
	 *
	 * `candlePriceData.dailyPrices` とは別に持つ。前者は期初評価・資産推移が使う
	 * 「直近 400 日窓」で、入出庫日価格には 400 日超の年単位 chunk を合流させた
	 * 別の Map（`fetchFlowDatePrices` の戻り値）を渡すため。
	 */
	flowPricing: FlowPricing;
	currentValue: number;
	nowIso: string;
	/**
	 * 入出金履歴を計算に使えない理由（`flowUnavailableReasonFor` の戻り値）。
	 *
	 * 設定されている場合は `dwData` の中身に関わらず純入出金を未計測として扱う。
	 * `dwData` が非 null でも allFailed / partial failure では中身が空なので、
	 * そのまま集計すると「フローゼロ」という確定値になってしまうため。
	 */
	flowUnavailableReason?: PortfolioFlowUnavailableReason;
}

/**
 * 増減率を出すために期初評価額が満たすべき、**現在評価額に対する**下限比率（1% = 1/100）。
 *
 * ## なぜ相対基準か
 *
 * 率が意味を持つかは口座の絶対規模ではなく、分母（期初評価額）が測ろうとしている変動に対して
 * 十分な大きさかで決まる。「1 万円未満なら抑止」のような絶対額固定は、期初 5 万円の口座では
 * 緩すぎ（+3,000% を通す）、期初 500 万円の口座では何も抑止しない。現在評価額との比で見れば
 * 口座規模に依存しない。
 *
 * ## なぜ 1% か
 *
 * この比が増減率の上限をそのまま決めるため。`change_pct = current / start - 1` なので、
 * `start >= current * 1%` を満たす限り増減率は +9,900% を超えられない。裏を返すと、
 * 率が 5 桁になるのは期初評価額が現在評価額の 1% を割ったときだけで、そこでの率は
 * 「運用成績」ではなく「期初がほぼ空だった」ことを表す数になる（年初にほぼ空の口座へ
 * 入金して運用を始めた場合に必ず起きる）。
 */
export const MIN_START_VALUE_RATIO = 0.01;

/**
 * `MIN_START_VALUE_RATIO` の逆数。判定を `startValue >= currentValue * 0.01` ではなく
 * `startValue * 100 >= currentValue` と整数どうしの積で書くために使う
 * （両値とも `Math.round` 済みの整数なので積は厳密。0.01 を掛ける形だと閾値ちょうどが
 * 浮動小数誤差でどちら側に落ちるか決まらない）。
 */
const MIN_START_VALUE_RATIO_INVERSE = 100;

/**
 * `change_pct` / `adjusted_change_pct` を出せない理由を返す。出せるなら `undefined`。
 *
 * 両フィールドは分母が同じ `start_value_jpy` なので判定も 1 か所に集約する
 * （＝ 片方だけ率が出る状態は作らない）。閾値ちょうど（`startValue * 100 === currentValue`）は
 * **率を出す側**に入れる。
 */
export function changePctUnavailableReasonFor(
	startValue: number,
	currentValue: number,
): PortfolioChangePctUnavailableReason | undefined {
	if (startValue <= 0) return 'start_value_zero';
	if (startValue * MIN_START_VALUE_RATIO_INVERSE < currentValue) return 'start_value_negligible';
	return undefined;
}

/**
 * 調整後増減率を求める。純入出金が未計測（`adjusted` が null）なら `null`、
 * 分母が使えないとき（`unavailableReason` あり）は `undefined` でキーごと落とす。
 */
function adjustedChangePct(
	adjusted: number | null,
	startValue: number,
	unavailableReason: PortfolioChangePctUnavailableReason | undefined,
): number | undefined | null {
	if (adjusted == null) return null;
	if (unavailableReason) return undefined;
	return Math.round((adjusted / startValue) * 10000) / 100;
}

function pickBoundaryPrice(
	key: PeriodPerformanceKey,
	pp: { yearStart?: number; monthStart?: number; dayStart?: number },
): number | undefined {
	switch (key) {
		case 'yearly':
			return pp.yearStart;
		case 'monthly':
			return pp.monthStart;
		case 'daily':
			return pp.dayStart;
	}
}

/**
 * 期間開始時点の保有を復元し、期初始値で評価したうえで現在評価額との差分・
 * 入出金調整後の差分を含む `PeriodPerformance` を構築する。
 *
 * 3 期間（daily / monthly / yearly）で挙動が同一だった以下の処理を一本化する:
 *   - `reconstructHoldingsAtDate` で期初の保有を復元
 *   - `candlePriceData.boundaryPrices` から期初始値を取り出して評価
 *   - `calcPeriodNetFlow` で期間内の純入出金を算出
 *   - `change` / `adjusted_change` / `pct` を `Math.round` で丸めて返す
 *
 * 入出金履歴を計算に使えない場合（`ctx.flowUnavailableReason` あり、または `ctx.dwData` が null）は
 * 純入出金を未計測として扱い、`net_flow_jpy` / `withdrawal_fee_jpy` / `adjusted_change_jpy` を
 * `null`・`flow_measured: false` で返す。`start_value_jpy` は入出金を巻き戻せていない値になるので、
 * 呼び出し側は `flow_unavailable_reason` を根拠に品質注記を出すこと。
 *
 * 出力フィールド順・桁丸めは旧インライン実装と完全一致させている
 * （JSON.stringify 結果が変わらないよう注意）。
 * `unpriced_flow_assets` / `flow_valuation` は後から足したフィールドなので既存キーの後ろに置き、
 * 該当なしのときはキーごと省いて旧出力と JSON 一致させる。
 */
export function buildPeriodPerformance(spec: PeriodSpec, ctx: PortfolioPerformanceContext): PeriodPerformance {
	const startHoldings = reconstructHoldingsAtDate(ctx.currentHoldings, ctx.trades, spec.startMs, ctx.dwData);
	const priceMap = new Map<string, number>();
	for (const [asset, pp] of ctx.candlePriceData.boundaryPrices) {
		const v = pickBoundaryPrice(spec.key, pp);
		if (v != null) priceMap.set(asset, v);
	}
	const startValue = Math.round(calcPortfolioValue(startHoldings, priceMap));
	const flow = ctx.flowUnavailableReason
		? unmeasuredNetFlow()
		: calcPeriodNetFlow(ctx.dwData, spec.startMs, ctx.flowPricing);
	const change = ctx.currentValue - startValue;
	// 増減率の分母（期初評価額）が使えるか。change_pct / adjusted_change_pct は分母が同じなので
	// 判定を 1 回で共有し、片方だけ率が出る状態を作らない。
	const pctUnavailableReason = changePctUnavailableReasonFor(startValue, ctx.currentValue);
	// 未計測のフローを 0 とみなして引かない。引いてしまうと adjusted_change が
	// 「入出金ゼロの口座の成績」という誤った確定値になる（それが -60.9% 型の表示の一因）。
	const adjusted = flow.net_flow_jpy != null ? change - flow.net_flow_jpy : null;
	// 未計測の理由。ctx 側の指定を優先し、指定が無い場合（dwData が null）は
	// 「取得に失敗した」に落とす。損益を出す構成では入出金履歴を常に取得するので、
	// dwData が null なのは取得が落ちたときだけ。flow_measured=false なら必ず理由が付く。
	const unavailableReason = flow.measured ? undefined : (ctx.flowUnavailableReason ?? 'dw_fetch_failed');
	const performance: PeriodPerformance = {
		start_value_jpy: startValue,
		current_value_jpy: ctx.currentValue,
		change_jpy: change,
		change_pct: pctUnavailableReason ? undefined : Math.round((change / startValue) * 10000) / 100,
		net_flow_jpy: flow.net_flow_jpy,
		withdrawal_fee_jpy: flow.withdrawal_fee_jpy,
		adjusted_change_jpy: adjusted,
		adjusted_change_pct: adjustedChangePct(adjusted, startValue, pctUnavailableReason),
		period_start: spec.startIso,
		period_end: ctx.nowIso,
		note: PERFORMANCE_NOTE,
		flow_measured: flow.measured,
	};
	if (unavailableReason) performance.flow_unavailable_reason = unavailableReason;
	if (flow.unpriced_assets) performance.unpriced_flow_assets = flow.unpriced_assets;
	if (flow.valuation) performance.flow_valuation = flow.valuation;
	if (pctUnavailableReason) performance.change_pct_unavailable_reason = pctUnavailableReason;
	return performance;
}
