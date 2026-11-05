import { dayjs } from '../../../lib/datetime.js';
import type {
	DepositWithdrawalStatus,
	PortfolioChangePctUnavailableReason,
	PortfolioFlowUnavailableReason,
	PortfolioQtyMismatchReason,
	PortfolioUnresolvedDepositReason,
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

// 現物の手数料は買いが base、売りが quote で発生する（API 仕様）。両方が非ゼロでも正しくなるよう両方を参照する。

export interface DepositCostBasisInput {
	deposits: RawDeposit[];
	pricing: FlowPricing;
}

interface PricedDepositEvent {
	asset: string;
	ts: number;
	qty: number;
	cost: number;
}

interface DepositCostEvents {
	priced: PricedDepositEvent[];
	unpricedCounts: Map<string, number>;
}

// 判定は必ず絶対値で行う。qty < 1e-12 と書くと本物の負値（取得漏れの証拠）まで 0 に握り潰す（#89）。原価のリセット条件とは意味が違う。
const QTY_DUST_EPSILON = 1e-12;

function normalizeQtyDust(qty: number): number {
	return Math.abs(qty) < QTY_DUST_EPSILON ? 0 : qty;
}

export interface QtyClampTally {
	count: number;
	absorbed: number;
}

// 保有ゼロでの売り（coveredQty = 0）も発火として数える。クランプ分岐と同じ事象なので、片方だけだと発火回数が過小になる。
function tallyQtyClamp(tally: QtyClampTally, requestedQty: number, coveredQty: number): void {
	const uncovered = requestedQty - coveredQty;
	if (uncovered > QTY_DUST_EPSILON) {
		tally.count++;
		tally.absorbed += uncovered;
	}
}

// 現在価格フォールバックは原価に使わない。使うとその入庫ぶんの評価損益がゼロ付近に貼り付き、誤差が相場と連動する（#53）。
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

interface CostBasis {
	costQty: number;
	cost: number;
}

interface ParsedTrade {
	qty: number;
	price: number;
	feeQuote: number;
	feeBase: number;
}

function parseTradeForReplay(t: RawTrade): ParsedTrade | null {
	const qty = Number(t.amount);
	const price = Number(t.price);
	if (!Number.isFinite(qty) || !Number.isFinite(price)) return null;
	return { qty, price, feeQuote: Number(t.fee_amount_quote) || 0, feeBase: Number(t.fee_amount_base) || 0 };
}

function applyDeposit(h: CostBasis, qty: number, cost: number): void {
	h.cost += cost;
	h.costQty += qty;
}

function applyBuy(h: CostBasis, t: ParsedTrade): void {
	h.cost += t.qty * t.price + t.feeQuote;
	h.costQty += t.qty - t.feeBase;
}

// 原価側（costQty）はゼロ床でクランプし、その発火を tally に数える（#89）。
function applySell(h: CostBasis, t: ParsedTrade, clamp: QtyClampTally): { realized: number; soldQty: number } {
	// 売りで減る base 量は qty + feeBase（reconstructHoldingsAtDate の巻き戻しと対称）。
	const soldQty = t.qty + t.feeBase;
	if (h.costQty > 0) {
		const avgCost = h.cost / h.costQty;
		const coveredQty = Math.min(soldQty, h.costQty);
		const sellCost = coveredQty * avgCost;
		const sellRevenue = t.qty * t.price - t.feeQuote; // 売却収入から手数料を差し引く
		h.cost -= sellCost;
		h.costQty -= coveredQty;
		tallyQtyClamp(clamp, soldQty, coveredQty);
		if (h.costQty < QTY_DUST_EPSILON) {
			h.costQty = 0;
			h.cost = 0;
		}
		return { realized: sellRevenue - sellCost, soldQty };
	}
	tallyQtyClamp(clamp, soldQty, 0);
	return { realized: t.qty * t.price - t.feeQuote, soldQty };
}

// 出庫の Math.min のゼロ床クランプは #89 の対象外なので残す（発火としても数えない）。何もしなかったときは 0 ではなく undefined を返す（呼び出し側は 0 でも netQty を丸め直してしまう）。
function applyWithdrawal(h: CostBasis, amount: number): number | undefined {
	if (!(h.costQty > 0 && amount > 0)) return undefined;
	const avgCost = h.cost / h.costQty;
	const removedQty = Math.min(amount, h.costQty);
	h.cost -= removedQty * avgCost;
	h.costQty -= removedQty;
	if (h.costQty < QTY_DUST_EPSILON) {
		h.costQty = 0;
		h.cost = 0;
	}
	return removedQty;
}

export function calcPnl(
	trades: RawTrade[],
	asset: string,
	withdrawals?: RawWithdrawal[],
	depositCost?: DepositCostBasisInput,
): PnlResult {
	const pair = `${asset}_jpy`;
	const relevantTrades = trades.filter((t) => t.pair === pair).sort((a, b) => a.executed_at - b.executed_at);

	const relevantWithdrawals = (withdrawals ?? []).filter((w) => w.asset === asset && w.status === 'DONE');

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
			qty_clamp_count: 0,
			qty_clamp_absorbed_qty: 0,
		};
	}

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

	// costQty はゼロ床でクランプし、netQty はしない（#89）。costQty を代数和にすると次の買いで平均単価の分母が縮み、実現損益と原価が動く。
	// netQty の負値は取得漏れの証拠なので握り潰さない（#89）。
	const h: CostBasis = { costQty: 0, cost: 0 };
	let netQty = 0;
	let realizedPnl = 0;
	const clamp: QtyClampTally = { count: 0, absorbed: 0 };

	for (const event of events) {
		if (event.type === 'deposit') {
			applyDeposit(h, event.qty, event.cost);
			netQty += event.qty;
		} else if (event.type === 'trade') {
			const t = parseTradeForReplay(event.trade);
			if (!t) continue;
			if (event.trade.side === 'buy') {
				applyBuy(h, t);
				netQty += t.qty - t.feeBase;
			} else {
				const sell = applySell(h, t, clamp);
				realizedPnl += sell.realized;
				netQty = normalizeQtyDust(netQty - sell.soldQty);
			}
		} else {
			const removedQty = applyWithdrawal(h, event.amount);
			if (removedQty !== undefined) netQty = normalizeQtyDust(netQty - removedQty);
		}
	}

	// 原価由来の 2 値は costQty で決める。netQty だと負の繰り越しを抱えた銘柄で cost_basis が黙って消える。
	const avgBuyPrice = h.costQty > 0 ? h.cost / h.costQty : undefined;
	const costBasis = h.costQty > 0 ? h.cost : undefined;

	return {
		avg_buy_price: avgBuyPrice,
		cost_basis: costBasis,
		realized_pnl: Math.round(realizedPnl),
		trade_count: relevantTrades.length,
		reconstructed_qty: normalizeQtyDust(netQty),
		priced_deposit_count: deposits.priced.length,
		unpriced_deposit_count: unpricedDepositCount,
		qty_clamp_count: clamp.count,
		qty_clamp_absorbed_qty: clamp.absorbed,
	};
}

export const QTY_INVARIANT_TOLERANCE_QUANTA = 5;
export const QTY_INVARIANT_TOLERANCE_RATIO = 0.001;

// 絶対項は取引所側の端数処理が最下位桁にたまる分、相対項はリプレイの浮動小数点誤差が保有量に比例して積み上がる分。
export function qtyInvariantTolerance(onhandAmount: number, amountPrecision: number): number {
	return Math.max(
		QTY_INVARIANT_TOLERANCE_QUANTA * 10 ** -amountPrecision,
		Math.abs(onhandAmount) * QTY_INVARIANT_TOLERANCE_RATIO,
	);
}

export function qtyInvariantHolds(onhandAmount: number, reconstructedQty: number, amountPrecision: number): boolean {
	return Math.abs(onhandAmount - reconstructedQty) <= qtyInvariantTolerance(onhandAmount, amountPrecision);
}

// has_crypto_deposits は dw.deposits の再走査ではなく unpriced_deposit_count で判定する（算入済みの入庫は乖離の説明にならない）。
export function qtyMismatchReasonFor(
	dw: DepositWithdrawalData | null,
	tradesTruncated: boolean,
	unpricedDepositCount: number,
	reconstructedQty: number,
): PortfolioQtyMismatchReason {
	if (unpricedDepositCount > 0) return 'has_crypto_deposits';
	if (tradesTruncated || (dw != null && !dw.isComplete)) return 'history_truncated';
	if (reconstructedQty < 0) return 'reconstructed_qty_negative';
	return 'untracked_trade_suspected';
}

// 出庫が 1 件でもある銘柄は除外する。取得漏れを見逃す方向にだけ誤り、外部送付しただけの銘柄を警告する方向には誤らない（#93）。
export function depositOnlyAssets(
	dw: DepositWithdrawalData | null,
	heldAssets: ReadonlySet<string>,
	tradedAssets: ReadonlySet<string>,
): string[] {
	if (dw == null) return [];
	const withdrawnAssets = new Set(
		dw.withdrawals.filter((w) => w.status === 'DONE' && w.asset !== 'jpy').map((w) => w.asset),
	);
	const found = new Set<string>();
	for (const d of dw.deposits) {
		if (d.status !== 'DONE') continue;
		if (d.asset === 'jpy') continue;
		if (heldAssets.has(d.asset)) continue;
		if (tradedAssets.has(d.asset)) continue;
		if (withdrawnAssets.has(d.asset)) continue;
		found.add(d.asset);
	}
	return [...found].sort();
}

export function unresolvedDepositReasonsByAsset(
	truncatedDepositsByAsset: ReadonlyMap<string, number>,
	failedDepositsByAsset: ReadonlyMap<string, number>,
): Map<string, PortfolioUnresolvedDepositReason> {
	const reasons = new Map<string, PortfolioUnresolvedDepositReason>();
	for (const [asset, count] of truncatedDepositsByAsset) {
		if (count > 0) reasons.set(asset, 'deposit_price_chunk_truncated');
	}
	// 取得失敗を後に置いて上書きする（実行ごとに結果が変わるほうを優先する）。
	for (const [asset, count] of failedDepositsByAsset) {
		if (count > 0) reasons.set(asset, 'deposit_price_fetch_failed');
	}
	return reasons;
}

export function dominantUnresolvedDepositReason(
	reasons: Iterable<PortfolioUnresolvedDepositReason>,
): PortfolioUnresolvedDepositReason | undefined {
	let found: PortfolioUnresolvedDepositReason | undefined;
	for (const reason of reasons) {
		if (reason === 'deposit_price_fetch_failed') return reason;
		found = reason;
	}
	return found;
}

// 入力は全履歴が前提。avg_cost は期間開始前の買い・入庫・出庫から積み上げ、depositCost を渡さないと calcPnl と食い違う。
export function calcPeriodRealizedPnl(
	trades: RawTrade[],
	sinceMs: number,
	periodStart: string,
	periodEnd: string,
	withdrawals?: RawWithdrawal[],
	depositCost?: DepositCostBasisInput,
): PeriodRealizedPnl {
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

	// costQty は calcPnl と同じくゼロ床でクランプする。復元数量は出す先が無いので netQty は持たない（クランプの発火だけは申告する。#89）。
	const holdings = new Map<string, CostBasis>();
	let periodRealized = 0;
	let periodSellCount = 0;
	const clamp: QtyClampTally = { count: 0, absorbed: 0 };
	const soldAssets = new Set<string>();

	for (const event of events) {
		if (event.type === 'deposit') {
			const h = holdings.get(event.asset) ?? { costQty: 0, cost: 0 };
			applyDeposit(h, event.qty, event.cost);
			holdings.set(event.asset, h);
		} else if (event.type === 'trade') {
			const t = parseTradeForReplay(event.trade);
			if (!t) continue;
			const asset = event.trade.pair.replace('_jpy', '');
			const h = holdings.get(asset) ?? { costQty: 0, cost: 0 };

			if (event.trade.side === 'buy') {
				applyBuy(h, t);
			} else {
				const sell = applySell(h, t, clamp);
				if (event.trade.executed_at >= sinceMs) {
					periodRealized += sell.realized;
					periodSellCount++;
					soldAssets.add(asset);
				}
			}

			holdings.set(asset, h);
		} else {
			const h = holdings.get(event.asset) ?? { costQty: 0, cost: 0 };
			if (applyWithdrawal(h, event.amount) !== undefined) holdings.set(event.asset, h);
		}
	}

	let unpricedDepositCount = 0;
	for (const count of depositEvents.unpricedCounts.values()) unpricedDepositCount += count;

	return {
		realized_pnl: Math.round(periodRealized),
		sell_count: periodSellCount,
		sold_assets: [...soldAssets],
		period_start: periodStart,
		period_end: periodEnd,
		priced_deposit_count_all_time: depositEvents.priced.length,
		unpriced_deposit_count_all_time: unpricedDepositCount,
		qty_clamp_count: clamp.count,
		qty_clamp_absorbed_qty: clamp.absorbed,
	};
}

// 内部の受け渡しには _cost 付きだけを使う。deprecated な別名は wire の互換のためだけにある（#72）。
export interface MarginPnlTotals {
	margin_realized_pnl: number;
	margin_interest_cost: number;
	margin_fee_cost: number;
}

// profit_loss は手数料・利息控除前のグロスなので interest と手数料を別に足し上げる。手数料は fee_amount_quote ではなく per-trade の発生額の fee_occurred_amount_quote を使う。
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

// DEPRECATED_FIELD_REMOVAL_TARGET で別名を消すときは、margin_interest / margin_fee の 2 行とスキーマ・型定義・summary の参照をまとめて落とす。
export function buildAccountPnl(
	spotRealizedPnl: number | undefined,
	marginPnl: MarginPnlTotals,
	suppressedReason?: PortfolioUnresolvedDepositReason,
): AccountPnl {
	return {
		spot_realized_pnl: spotRealizedPnl,
		margin_realized_pnl: marginPnl.margin_realized_pnl,
		margin_interest: marginPnl.margin_interest_cost,
		margin_fee: marginPnl.margin_fee_cost,
		total:
			spotRealizedPnl == null
				? undefined
				: spotRealizedPnl + marginPnl.margin_realized_pnl - marginPnl.margin_interest_cost - marginPnl.margin_fee_cost,
		margin_interest_cost: marginPnl.margin_interest_cost,
		margin_fee_cost: marginPnl.margin_fee_cost,
		spot_realized_pnl_unavailable_reason: spotRealizedPnl == null ? suppressedReason : undefined,
	};
}

export function buildPeriodAccountPnl(
	spotRealizedPnl: number | undefined,
	marginPnl: MarginPnlTotals,
	periodStart: string,
	periodEnd: string,
	suppressedReason?: PortfolioUnresolvedDepositReason,
): PeriodAccountPnl {
	return {
		...buildAccountPnl(spotRealizedPnl, marginPnl, suppressedReason),
		period_start: periodStart,
		period_end: periodEnd,
	};
}

// 元本ではなく成果なので純入出金・純投入額からは外す。数量の復元と取得原価（入庫日の価格）には他の入庫と同じく入れる。
export function isStakingReward(d: RawDeposit): boolean {
	return d.category === 'STAKING';
}

// 非有限な atMs は portfolioDayStartMs が throw するので、日次価格を引かずに現在価格に落とす。
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

class FlowValuationCounter {
	private dated = 0;
	private fallback = 0;

	count(basis: 'deposit_date_price' | 'current_price_fallback'): void {
		if (basis === 'deposit_date_price') this.dated++;
		else this.fallback++;
	}

	toBreakdown(): FlowValuationBreakdown | undefined {
		return buildFlowValuationBreakdown(this.dated, this.fallback);
	}
}

function buildFlowValuationBreakdown(dated: number, fallback: number): FlowValuationBreakdown | undefined {
	if (dated === 0 && fallback === 0) return undefined;
	return {
		deposit_date_price_count: dated,
		current_price_fallback_count: fallback,
		basis: fallback === 0 ? 'deposit_date_price' : dated === 0 ? 'current_price_fallback' : 'mixed',
	};
}

// 下限を入庫と出庫で分けるのは消費者が非対称だから。反映先の無い入出庫まで換算すると追加取得と警告が動き、反映先があるのに絞ると黙って 0 円計上になる（#70）。
export interface FlowValuationScope {
	depositsSinceMs?: number;
	withdrawalsSinceMs?: number;
}

// fetchFlowDatePrices の取得対象と summarizeFlowValuation の集計の母集合。除外基準は calcPeriodNetFlow の unpriced_assets 判定とそろえている。
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

// 各セクションの内訳は重なる部分集合なので、足すと二重計上になる。母集合を 1 度だけ数える。
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

// 出庫は外部に移すとこの口座からは測れないので、元本の回収として純投入額から引く（#70）。
export function calcDepositWithdrawalSummary(
	dw: DepositWithdrawalData,
	totalJpyValue: number,
	pricing: FlowPricing,
): DepositWithdrawalSummary {
	const completedDeposits = dw.deposits.filter((d) => d.status === 'DONE');
	const completedWithdrawals = dw.withdrawals.filter((w) => w.status === 'DONE');

	const jpyDeposits = completedDeposits.filter((d) => d.asset === 'jpy');
	const jpyWithdrawals = completedWithdrawals.filter((w) => w.asset === 'jpy');
	const totalJpyDeposited = jpyDeposits.reduce((sum, d) => sum + Number(d.amount), 0);
	const totalJpyWithdrawn = jpyWithdrawals.reduce((sum, w) => sum + Number(w.amount), 0);

	const cryptoDeposits = completedDeposits.filter((d) => d.asset !== 'jpy');
	const cryptoWithdrawals = completedWithdrawals.filter((w) => w.asset !== 'jpy');

	let cryptoDepositEstimatedJpy = 0;
	let hasEstimate = false;
	const depositValuation = new FlowValuationCounter();
	const stakingCount = cryptoDeposits.filter(isStakingReward).length;
	let stakingEstimatedJpy = 0;
	let hasStakingEstimate = false;
	for (const d of cryptoDeposits) {
		const amount = Number(d.amount);
		if (!Number.isFinite(amount) || amount <= 0) continue;
		const resolved = resolveFlowPrice(pricing, d.asset, d.confirmed_at);
		if (!resolved) continue;
		cryptoDepositEstimatedJpy += amount * resolved.price;
		depositValuation.count(resolved.basis);
		hasEstimate = true;
		if (isStakingReward(d)) {
			stakingEstimatedJpy += amount * resolved.price;
			hasStakingEstimate = true;
		}
	}

	// 手数料（w.fee）は元本に含めない。JPY 出金も amount だけを集計しているので、暗号資産出庫だけ手数料込みにすると非対称になる。
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
		(hasEstimate ? cryptoDepositEstimatedJpy - stakingEstimatedJpy : 0) -
		(hasWithdrawalEstimate ? cryptoWithdrawalEstimatedJpy : 0);

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
	if (stakingCount > 0) summary.staking_reward_count = stakingCount;
	if (hasStakingEstimate) summary.staking_reward_estimated_jpy = Math.round(stakingEstimatedJpy);
	const valuation = depositValuation.toBreakdown();
	if (valuation) summary.crypto_deposit_valuation = valuation;
	const wdValuation = withdrawalValuation.toBreakdown();
	if (wdValuation) summary.crypto_withdrawal_valuation = wdValuation;
	return summary;
}

export function calcPeriodDWSummary(
	dw: DepositWithdrawalData,
	sinceMs: number,
	periodStartIso: string,
	periodEndIso: string,
	pricing: FlowPricing,
): PeriodDWSummary {
	const completedDeposits = dw.deposits.filter((d) => d.status === 'DONE' && d.confirmed_at >= sinceMs);
	const completedWithdrawals = dw.withdrawals.filter((w) => w.status === 'DONE' && w.requested_at >= sinceMs);

	const jpyDep = completedDeposits.filter((d) => d.asset === 'jpy');
	const jpyWd = completedWithdrawals.filter((w) => w.asset === 'jpy');
	const jpyDeposited = jpyDep.reduce((s, d) => s + Number(d.amount), 0);
	const jpyWithdrawn = jpyWd.reduce((s, w) => s + Number(w.amount), 0);

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
	const depBreakdown = depValuation.toBreakdown();
	if (depBreakdown) summary.crypto_deposit_valuation = depBreakdown;
	const wdBreakdown = wdValuation.toBreakdown();
	if (wdBreakdown) summary.crypto_withdrawal_valuation = wdBreakdown;
	return summary;
}

// 当日の起点だけは portfolioDayStartMs で求める。日次価格のキーと資産推移の日次点と同じ暦日境界を共有するため。
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
			// 途中経過が負でも保持する（出庫相などで相殺される繰り越しを落とさない）。
			holdings.set(asset, current - (qty - feeBase));
			holdings.set('jpy', currentJpy + qty * price + feeQuote);
		} else {
			holdings.set(asset, current + qty + feeBase);
			holdings.set('jpy', currentJpy - qty * price + feeQuote);
		}
	}

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

	for (const [asset, amount] of holdings) {
		if (amount < 1e-12) holdings.delete(asset);
	}

	return holdings;
}

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

// 履歴が欠けている判定は flowUnavailableReasonFor と同じ述語にする。部分集合を合計すると、*_performance が未計測と言う応答で点だけが確定値を出す。
export function buildEquityFlowByPoint(
	dw: DepositWithdrawalData | null,
	pricing: FlowPricing,
	pointMsAsc: number[],
): Map<number, number> {
	const byPoint = new Map<number, number>();
	if (!dw || pointMsAsc.length === 0) return byPoint;
	// 未計測を 0 でも部分値でもなく「キーの不在」で表す。
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

	for (const d of dw.deposits) {
		if (!isStakingReward(d)) add(d.asset, d.amount, d.status, d.confirmed_at, 1);
	}
	for (const w of dw.withdrawals) add(w.asset, w.amount, w.status, w.requested_at, -1);

	// value_jpy と同じ粒度に丸め、相殺してゼロになった点はキーごと落とす。
	for (const [key, value] of byPoint) {
		const rounded = Math.round(value);
		if (rounded === 0) byPoint.delete(key);
		else byPoint.set(key, rounded);
	}
	return byPoint;
}

// atMs >= pointMsAsc[0] が前提（buildEquityFlowByPoint が範囲外を先に落としている）。
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

		// dailyPrices ではなく holdings を起点に回す。candle が全失敗すると priceMap が空になり、最終点とスケールが合わなくなる。
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
		const flow = flowByPoint?.get(dateMs);
		if (flow != null) point.flow_jpy = flow;
		series.push(point);
	}

	series.push({
		timestamp: currentIso,
		value_jpy: currentValueJpy,
	});

	return series;
}

// 表示セクションの状態であって、損益計算が入出金履歴を使えたかではない（そちらは flowUnavailableReasonFor）。
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

// allFailed だけだと出庫チャネルだけが落ちた構成を見逃し、cost_basis を過大化させる出庫が欠けたまま calcPnl に渡るので、warnings / isComplete も見る。
export function flowUnavailableReasonFor(dw: DepositWithdrawalData | null): PortfolioFlowUnavailableReason | undefined {
	if (!dw) return 'dw_fetch_failed';
	if (dw.allFailed || dw.warnings.length > 0) return 'dw_fetch_failed';
	// 取得自体は成功しているので失敗とは別コードにする（再実行しても解消しないため、案内文言も変わる）。
	if (!dw.isComplete) return 'dw_history_incomplete';
	return undefined;
}

function unmeasuredNetFlow(): PeriodNetFlowResult {
	return { net_flow_jpy: null, withdrawal_fee_jpy: null, measured: false };
}

// dw が null のとき 0 を返さない。0 だと adjusted_change がフローゼロ前提の確定値として出る。
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
	const unpricedAssets = new Set<string>();
	const valuation = new FlowValuationCounter();
	let stakingCount = 0;
	let stakingReward = 0;
	const unpricedStakingAssets = new Set<string>();

	for (const d of completedDeposits) {
		if (d.asset === 'jpy') {
			netFlow += Number(d.amount);
			continue;
		}
		const amount = Number(d.amount);
		if (!Number.isFinite(amount) || amount <= 0) continue;
		const resolved = resolveFlowPrice(pricing, d.asset, d.confirmed_at);
		if (isStakingReward(d)) {
			stakingCount++;
			if (resolved) stakingReward += amount * resolved.price;
			else unpricedStakingAssets.add(d.asset);
			continue;
		}
		if (resolved) {
			netFlow += amount * resolved.price;
			valuation.count(resolved.basis);
		} else {
			unpricedAssets.add(d.asset);
		}
	}

	for (const w of completedWithdrawals) {
		const fee = Number(w.fee) || 0;
		if (w.asset === 'jpy') {
			netFlow -= Number(w.amount);
			withdrawalFee += fee;
			continue;
		}
		const amount = Number(w.amount);
		if (!Number.isFinite(amount) || amount <= 0) continue;
		// 元本と手数料は同じ出庫日の単価で換算する。混成にすると withdrawal_fee_jpy だけが相場で動く。
		const resolved = resolveFlowPrice(pricing, w.asset, w.requested_at);
		if (resolved) {
			netFlow -= amount * resolved.price;
			if (fee > 0) {
				withdrawalFee += fee * resolved.price;
			}
			valuation.count(resolved.basis);
		} else {
			unpricedAssets.add(w.asset);
		}
	}

	const result: PeriodNetFlowResult = {
		net_flow_jpy: Math.round(netFlow),
		withdrawal_fee_jpy: Math.round(withdrawalFee),
		measured: true,
	};
	if (unpricedAssets.size > 0) result.unpriced_assets = [...unpricedAssets].sort();
	const breakdown = valuation.toBreakdown();
	if (breakdown) result.valuation = breakdown;
	// 1 件でも換算できなければ額は出さない。部分集合の合計を確定値として出さない。
	if (unpricedStakingAssets.size > 0) result.staking_reward_unpriced_assets = [...unpricedStakingAssets].sort();
	else if (stakingCount > 0) result.staking_reward_jpy = Math.round(stakingReward);
	return result;
}

export const PERFORMANCE_NOTE =
	'期初評価額は現在の保有状態から約定・入出金を逆算して復元し、期初時点の始値（1day candle open）で評価。暗号資産の入出庫は入出庫日（入庫: confirmed_at / 出庫: requested_at）の始値で JPY 換算し、その日の価格を取得できなかった分のみ現在価格で仮評価する（内訳は flow_valuation）。純入出金は元本移動のみ（出金手数料を含まない。ステーキング報酬（入金種別 STAKING）は元本ではなく成果として扱い、純入出金に含めない。額は staking_reward_jpy）。調整後増減 = 単純増減 - 純入出金（市場変動 + 出金手数料コスト）。増減率（change_pct / adjusted_change_pct）は期初評価額が 0、現在評価額の 1% 未満、期初の始値を解決できなかった暗号資産があり期初評価額が過小、または現在価格を解決できなかった保有があり現在評価額が過小のときは出さない（分母が小さすぎて率が運用成績を表さない、過小な分母になる、または分子が過小になるため。理由は change_pct_unavailable_reason、資産名は unpriced_start_assets / unpriced_current_assets、増減額は通常どおり出る）。期初評価額・現在評価額そのものは過小である場合でも金額を出すが、過小であることは unpriced_start_assets / unpriced_current_assets と理由コードで申告する（黙って出さない）。';

export const PERFORMANCE_NOTE_CHANGE_OVERSTATED =
	'この期間は期初の始値を解決できなかった暗号資産があり（change_pct_unavailable_reason=start_boundary_unpriced）、期初評価額から脱落した分がそのまま増減額に乗るため change_jpy / adjusted_change_jpy も同じ額だけ過大（change_jpy_overstated=true）。増減額を運用成績として読まないこと。この期間の値動きはこの結果からは算出できない（資産推移シリーズも同じ日次価格に依存するため代替にならない）。';

export const PERFORMANCE_NOTE_CHANGE_DIRECTION_UNKNOWN =
	'この期間は期初の始値を解決できなかった暗号資産があり（change_pct_unavailable_reason=start_boundary_unpriced）、change_jpy / adjusted_change_jpy もその欠損の影響を受ける。現在評価額でも価格を解決できない保有があるため**ずれの向きは確定できない**（change_jpy_overstated は付かない）。増減額を運用成績として読まないこと。この期間の値動きはこの結果からは算出できない（資産推移シリーズも同じ日次価格に依存するため代替にならない）。';

export const PERFORMANCE_NOTE_CHANGE_UNDERSTATED =
	'この期間は現在価格を解決できなかった暗号資産の保有があり（change_pct_unavailable_reason=current_value_unpriced）、現在評価額から脱落した分がそのまま増減額から欠けるため change_jpy / adjusted_change_jpy は同じ額だけ過小（change_jpy_understated=true）。保有暗号資産が全て脱落している場合は現在評価額が JPY 残高だけに縮退しており、増減額は口座の損失ではなく価格取得の失敗を表す数になる。増減額を運用成績として読まないこと。この期間の値動きはこの結果からは算出できない（資産推移シリーズも最終点に同じ現在評価額を使うため代替にならない）。';

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
	/** candlePriceData.dailyPrices とは別物（400 日超の年 chunk を合流させた fetchFlowDatePrices の戻り値）。 */
	flowPricing: FlowPricing;
	/** flowPricing.currentPrices はこの値を作ったのと同じ ticker 価格 Map であること。別ソースだと現在評価額の欠損を検出できない（#109）。 */
	currentValue: number;
	nowIso: string;
	/** 設定されていれば dwData の中身に関わらず未計測として扱う（失敗時の空の中身を集計するとフローゼロの確定値になる）。 */
	flowUnavailableReason?: PortfolioFlowUnavailableReason;
}

// 現在評価額に対する比なので口座規模に依存しない。1% なら増減率は +9,900% を超えない。
export const MIN_START_VALUE_RATIO = 0.01;

// 両値とも整数なので startValue * 100 >= currentValue は厳密。0.01 を掛けると閾値ちょうどが浮動小数誤差でぶれる。
const MIN_START_VALUE_RATIO_INVERSE = 100;

export function changePctUnavailableReasonFor(
	startValue: number,
	currentValue: number,
): PortfolioChangePctUnavailableReason | undefined {
	if (startValue <= 0) return 'start_value_zero';
	if (startValue * MIN_START_VALUE_RATIO_INVERSE < currentValue) return 'start_value_negligible';
	return undefined;
}

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

// 未登録・始値 undefined・3 境界すべて undefined は解消の見込みが違うが、率抑止の帰結は同じなので start_boundary_unpriced に統一する。
function unpricedStartAssets(
	startHoldings: Map<string, number>,
	boundaryPrices: CandlePriceData['boundaryPrices'],
	key: PeriodPerformanceKey,
): string[] | undefined {
	const unpriced = new Set<string>();
	for (const [asset, amount] of startHoldings) {
		if (asset === 'jpy') continue;
		if (!Number.isFinite(amount) || amount <= 0) continue;
		const pp = boundaryPrices.get(asset);
		if (pp != null && pickBoundaryPrice(key, pp) != null) continue;
		unpriced.add(asset);
	}
	if (unpriced.size === 0) return undefined;
	return [...unpriced].sort();
}

function unpricedCurrentAssets(ctx: PortfolioPerformanceContext): string[] | undefined {
	const unpriced = new Set<string>();
	for (const { asset, amount: rawAmount } of ctx.currentHoldings) {
		if (asset === 'jpy') continue;
		const amount = Number(rawAmount);
		if (!Number.isFinite(amount) || amount <= 0) continue;
		if (ctx.flowPricing.currentPrices.has(asset)) continue;
		unpriced.add(asset);
	}
	if (unpriced.size === 0) return undefined;
	return [...unpriced].sort();
}

// start_value_zero / start_value_negligible は期初評価額が本当に小さいだけで増減額は正しく読めるので追記しない。
function performanceNote(reason: PortfolioChangePctUnavailableReason | undefined, changeOverstated: boolean): string {
	if (reason === 'start_boundary_unpriced') {
		return `${PERFORMANCE_NOTE}${changeOverstated ? PERFORMANCE_NOTE_CHANGE_OVERSTATED : PERFORMANCE_NOTE_CHANGE_DIRECTION_UNKNOWN}`;
	}
	if (reason === 'current_value_unpriced') return `${PERFORMANCE_NOTE}${PERFORMANCE_NOTE_CHANGE_UNDERSTATED}`;
	return PERFORMANCE_NOTE;
}

// 出力フィールド順・桁丸めは JSON.stringify の結果を変えないよう旧実装とそろえている。後から足したフィールドは既存キーの後ろに置く。
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
	const unpricedStart = unpricedStartAssets(startHoldings, ctx.candlePriceData.boundaryPrices, spec.key);
	const unpricedCurrent = unpricedCurrentAssets(ctx);
	// 片端だけが欠けているときだけ向きが確定する。両端で欠けるとその資産の値動きがどちらにも入らない。
	const changeOverstated = unpricedStart != null && unpricedCurrent == null;
	const changeUnderstated = unpricedCurrent != null && unpricedStart == null;
	// 価格の解決欠損 2 種は増減額を読ませない系なので、増減額で読むよう誘導する start_value_* より必ず先に選ぶ。
	const pctUnavailableReason: PortfolioChangePctUnavailableReason | undefined = unpricedStart
		? 'start_boundary_unpriced'
		: unpricedCurrent
			? 'current_value_unpriced'
			: changePctUnavailableReasonFor(startValue, ctx.currentValue);
	const adjusted = flow.net_flow_jpy != null ? change - flow.net_flow_jpy : null;
	// dwData が null なのは取得が落ちたときだけなので dw_fetch_failed に落とす（損益を出す構成では常に取得する）。
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
		// 追記文は理由コードで選ぶ。両端が欠ける構成の DIRECTION_UNKNOWN 文は現在側にも触れるので、現在側の文を重ねない。
		note: performanceNote(pctUnavailableReason, changeOverstated),
		flow_measured: flow.measured,
	};
	if (unavailableReason) performance.flow_unavailable_reason = unavailableReason;
	if (flow.unpriced_assets) performance.unpriced_flow_assets = flow.unpriced_assets;
	if (flow.valuation) performance.flow_valuation = flow.valuation;
	if (flow.staking_reward_jpy != null) performance.staking_reward_jpy = flow.staking_reward_jpy;
	if (flow.staking_reward_unpriced_assets)
		performance.staking_reward_unpriced_assets = flow.staking_reward_unpriced_assets;
	if (unpricedStart) performance.unpriced_start_assets = unpricedStart;
	if (unpricedCurrent) performance.unpriced_current_assets = unpricedCurrent;
	if (pctUnavailableReason) performance.change_pct_unavailable_reason = pctUnavailableReason;
	// 起点は率の抑止と同じ unpricedStart。別条件にすると率と増減額の申告が食い違う。
	if (changeOverstated) performance.change_jpy_overstated = true;
	if (changeUnderstated) performance.change_jpy_understated = true;
	return performance;
}
