import { type PairSpec, roundToPriceDigits } from '../../../lib/pairs.js';
import type {
	PortfolioCostBasisUnavailableReason,
	PortfolioFlowUnavailableReason,
	PortfolioQtyMismatchReason,
	PortfolioUnresolvedDepositReason,
} from '../../private/schemas.js';
import { qtyInvariantHolds, qtyInvariantTolerance, qtyMismatchReasonFor } from './calc.js';
import type { CandlePriceData, DepositWithdrawalData, PnlResult, RawAsset } from './types.js';

// avg_buy_price は板に出せる価格ではないので price_digits より桁を残して丸める（刻みで丸めると cost_basis との再構成誤差が乗る）。pairs を取れないときは丸めず、整数丸めに逃げない。
const AVG_BUY_PRICE_EXTRA_DIGITS = 2;

export interface HoldingRow {
	asset: string;
	pair: string;
	amount: string;
	avg_buy_price: number | undefined;
	current_price: number | undefined;
	jpy_value: number | undefined;
	cost_basis: number | undefined;
	unrealized_pnl: number | undefined;
	unrealized_pnl_pct: number | undefined;
	realized_pnl: number | undefined;
	trade_count: number | undefined;
	cost_basis_unavailable_reason: PortfolioCostBasisUnavailableReason | undefined;
	cost_basis_reliable: boolean | undefined;
	priced_deposit_count: number | undefined;
	unpriced_deposit_count: number | undefined;
	reconstructed_qty: number | undefined;
	qty_invariant_tolerance: number | undefined;
	qty_clamp_count: number | undefined;
	qty_clamp_absorbed_qty: number | undefined;
}

export interface ClosedPosition {
	asset: string;
	realized_pnl: number | undefined;
	priced_deposit_count: number | undefined;
	unpriced_deposit_count: number | undefined;
	realized_pnl_unavailable_reason: PortfolioCostBasisUnavailableReason | undefined;
}

export interface AssetCount {
	asset: string;
	count: number;
}

export interface SuppressedRealizedAsset extends AssetCount {
	reason: PortfolioUnresolvedDepositReason;
}

export interface UnresolvedDeposits {
	reasons: Map<string, PortfolioUnresolvedDepositReason>;
	/** 警告に出す件数の単一ソース。 */
	countOf: (asset: string) => number;
}

// 0 だと「数えたが 0」と「入庫が無い」が同じ表示になるので、キーごと落とす（#77）。
export function depositCountOrUndefined(count: number | undefined): number | undefined {
	return count != null && count > 0 ? count : undefined;
}

// reconstructed_qty は丸めず、0 でもキーを落とさない（消費者が判定を検算できるように。#87）。原価を抑止した銘柄でも出す。
function qtyInvariantInputsOf(
	pnl: PnlResult | undefined,
	onhandAmount: string,
	amountPrecision: number,
): {
	reconstructed_qty: number | undefined;
	qty_invariant_tolerance: number | undefined;
	qty_clamp_count: number | undefined;
	qty_clamp_absorbed_qty: number | undefined;
} {
	if (pnl == null) {
		return {
			reconstructed_qty: undefined,
			qty_invariant_tolerance: undefined,
			qty_clamp_count: undefined,
			qty_clamp_absorbed_qty: undefined,
		};
	}
	const onhand = Number(onhandAmount);
	const clamped = pnl.qty_clamp_count > 0;
	return {
		reconstructed_qty: Number.isFinite(pnl.reconstructed_qty) ? pnl.reconstructed_qty : undefined,
		// NaN は出力スキーマ（z.number()）を通らずレスポンス全体が落ちるので、値にならないものは出さない。
		qty_invariant_tolerance: Number.isFinite(onhand) ? qtyInvariantTolerance(onhand, amountPrecision) : undefined,
		// 吸収量は件数と対で意味を持つので同じ条件で出し入れする（#89）。
		qty_clamp_count: clamped ? pnl.qty_clamp_count : undefined,
		qty_clamp_absorbed_qty: clamped ? pnl.qty_clamp_absorbed_qty : undefined,
	};
}

interface PricedAsset {
	asset: RawAsset;
	pair: string;
	currentPrice: number | undefined;
	jpyValue: number | undefined;
}

// avg_buy_price 単体は出庫に対して不変だが、amount × avg_buy_price で原価を再構成されると同じ誤りに戻るので 4 フィールドをまとめて出さない。
function costUnavailableRow(
	p: PricedAsset,
	pnl: PnlResult | undefined,
	reason: PortfolioCostBasisUnavailableReason,
	realizedPnl: number | undefined,
): HoldingRow {
	return {
		asset: p.asset.asset,
		pair: p.pair,
		amount: p.asset.onhand_amount,
		avg_buy_price: undefined,
		current_price: p.currentPrice,
		jpy_value: p.jpyValue,
		cost_basis: undefined,
		unrealized_pnl: undefined,
		unrealized_pnl_pct: undefined,
		realized_pnl: realizedPnl,
		// 約定件数は原価に依存しないのでそのまま出す（何件の約定を見た結果かが読める）。
		trade_count: pnl?.trade_count,
		cost_basis_unavailable_reason: reason,
		cost_basis_reliable: false,
		// 抑止した経路でも件数は落とさない（未解決入庫による抑止では件数が根拠そのもの）。
		priced_deposit_count: depositCountOrUndefined(pnl?.priced_deposit_count),
		unpriced_deposit_count: depositCountOrUndefined(pnl?.unpriced_deposit_count),
		// 抑止した経路でも復元数量は出す（#87）。
		...qtyInvariantInputsOf(pnl, p.asset.onhand_amount, p.asset.amount_precision),
	};
}

export interface HoldingsContext {
	prices: Map<string, number>;
	pairsSpec: Map<string, PairSpec> | null;
	/** include_pnl=false なら undefined（損益を算出しない）。 */
	pnlOf: ((asset: string) => PnlResult) | undefined;
	flowUnavailableReason: PortfolioFlowUnavailableReason | undefined;
	unresolvedDeposits: UnresolvedDeposits;
	dwData: DepositWithdrawalData | null;
	tradesTruncated: boolean;
}

export interface HeldTally {
	/** jpy_value の降順。 */
	holdings: HoldingRow[];
	totalJpyValue: number;
	/** 抑止した銘柄は積まない（実行ごとに変わりうるので）。 */
	realizedPnl: number;
	qtyMismatchAssets: Array<{ asset: string; reason: PortfolioQtyMismatchReason }>;
	/** 数量乖離で抑止した銘柄は入れない（has_crypto_deposits の警告と二重になる）。 */
	unpricedDepositAssets: AssetCount[];
	qtyClampAssets: AssetCount[];
	suppressedRealizedAssets: SuppressedRealizedAsset[];
}

export function tallyHeldAssets(nonZeroAssets: readonly RawAsset[], ctx: HoldingsContext): HeldTally {
	let totalJpyValue = 0;
	let realizedPnl = 0;
	const qtyMismatchAssets: HeldTally['qtyMismatchAssets'] = [];
	const unpricedDepositAssets: AssetCount[] = [];
	const qtyClampAssets: AssetCount[] = [];
	const suppressedRealizedAssets: SuppressedRealizedAsset[] = [];

	const holdings = nonZeroAssets.map((a): HoldingRow => {
		const amount = a.onhand_amount;
		const isJpy = a.asset === 'jpy';

		const currentPrice = isJpy ? 1 : ctx.prices.get(a.asset);
		const jpyValue = isJpy ? Number(amount) : currentPrice ? Number(amount) * currentPrice : undefined;

		if (jpyValue != null && Number.isFinite(jpyValue)) {
			totalJpyValue += jpyValue;
		}
		const roundedJpyValue = jpyValue != null ? Math.round(jpyValue) : undefined;

		if (isJpy) {
			return {
				asset: a.asset,
				pair: 'jpy',
				amount,
				avg_buy_price: undefined,
				current_price: undefined,
				jpy_value: roundedJpyValue,
				cost_basis: undefined,
				unrealized_pnl: undefined,
				unrealized_pnl_pct: undefined,
				realized_pnl: undefined,
				trade_count: undefined,
				cost_basis_unavailable_reason: undefined,
				cost_basis_reliable: undefined,
				priced_deposit_count: undefined,
				unpriced_deposit_count: undefined,
				// JPY は calcPnl を呼んでいない（復元数量という概念が無い）のでまとめて省く。
				reconstructed_qty: undefined,
				qty_invariant_tolerance: undefined,
				qty_clamp_count: undefined,
				qty_clamp_absorbed_qty: undefined,
			};
		}

		const pair = `${a.asset}_jpy`;
		const pairSpec: PairSpec | undefined = ctx.pairsSpec?.get(pair);
		const priced: PricedAsset = {
			asset: a,
			pair,
			currentPrice: roundToPriceDigits(currentPrice, pairSpec),
			jpyValue: roundedJpyValue,
		};
		const pnl = ctx.pnlOf?.(a.asset);

		const unresolvedDepositReason = ctx.unresolvedDeposits.reasons.get(a.asset);
		if (pnl && unresolvedDepositReason == null) {
			realizedPnl += pnl.realized_pnl;
		}
		// unresolvedDepositReason が付く銘柄では集めない。その経路は realized_pnl を出さないので、過大寄りの警告が出してもいない値を指す。
		if (pnl != null && unresolvedDepositReason == null && pnl.qty_clamp_count > 0) {
			qtyClampAssets.push({ asset: a.asset, count: pnl.qty_clamp_count });
		}

		if (ctx.flowUnavailableReason != null) {
			return costUnavailableRow(priced, pnl, ctx.flowUnavailableReason, pnl?.realized_pnl);
		}

		// 数量不変条件より先に判定する（両方成立する構成で realized_pnl が漏れる。#80）。許容誤差内でも cost_basis_reliable=false になるのはこのため（#87）。
		if (pnl != null && unresolvedDepositReason != null) {
			suppressedRealizedAssets.push({
				asset: a.asset,
				count: ctx.unresolvedDeposits.countOf(a.asset),
				reason: unresolvedDepositReason,
			});
			return costUnavailableRow(priced, pnl, unresolvedDepositReason, undefined);
		}

		if (pnl != null && !qtyInvariantHolds(Number(amount), pnl.reconstructed_qty, a.amount_precision)) {
			const reason = qtyMismatchReasonFor(
				ctx.dwData,
				ctx.tradesTruncated,
				pnl.unpriced_deposit_count,
				pnl.reconstructed_qty,
			);
			qtyMismatchAssets.push({ asset: a.asset, reason });
			return costUnavailableRow(priced, pnl, reason, pnl.realized_pnl);
		}

		const unrealizedPnl =
			jpyValue != null && pnl?.cost_basis != null ? Math.round(jpyValue - pnl.cost_basis) : undefined;
		const unrealizedPnlPct =
			unrealizedPnl != null && pnl?.cost_basis != null && pnl.cost_basis > 0
				? Math.round((unrealizedPnl / pnl.cost_basis) * 10000) / 100
				: undefined;

		// 数量乖離が許容誤差に収まれば未算入の入庫があってもここを通るので、cost_basis_reliable=true と unpriced_deposit_count>0 は同時に立つ。
		if (pnl != null && pnl.unpriced_deposit_count > 0) {
			unpricedDepositAssets.push({ asset: a.asset, count: pnl.unpriced_deposit_count });
		}

		return {
			asset: a.asset,
			pair,
			amount,
			avg_buy_price: roundToPriceDigits(pnl?.avg_buy_price, pairSpec, {
				extraDigits: AVG_BUY_PRICE_EXTRA_DIGITS,
			}),
			current_price: priced.currentPrice,
			jpy_value: roundedJpyValue,
			cost_basis: pnl?.cost_basis != null ? Math.round(pnl.cost_basis) : undefined,
			unrealized_pnl: unrealizedPnl,
			unrealized_pnl_pct: unrealizedPnlPct,
			realized_pnl: pnl?.realized_pnl,
			trade_count: pnl?.trade_count,
			cost_basis_unavailable_reason: undefined,
			cost_basis_reliable: pnl != null ? true : undefined,
			priced_deposit_count: depositCountOrUndefined(pnl?.priced_deposit_count),
			unpriced_deposit_count: depositCountOrUndefined(pnl?.unpriced_deposit_count),
			...qtyInvariantInputsOf(pnl, amount, a.amount_precision),
		};
	});
	holdings.sort((a, b) => (b.jpy_value ?? 0) - (a.jpy_value ?? 0));

	return {
		holdings,
		totalJpyValue,
		realizedPnl,
		qtyMismatchAssets,
		unpricedDepositAssets,
		qtyClampAssets,
		suppressedRealizedAssets,
	};
}

export interface ClosedTally {
	/** 保有銘柄ぶんに売り切り銘柄ぶんを 1 件ずつ足した合計（足す順で浮動小数の値が変わるので、まとめて足さない）。 */
	totalRealizedPnl: number;
	/** undefined = 1 銘柄でも抑止した（部分和を出さない。#92）。0 = 売り切りはあったが実現損益ゼロ。 */
	closedPositionRealizedPnl: number | undefined;
	closedPositionAssetCount: number | undefined;
	/** 抑止時は undefined。部分配列を出すと内訳の合計を本当の合計と誤認させる。 */
	closedPositions: ClosedPosition[] | undefined;
	unpricedDepositAssets: AssetCount[];
	qtyClampAssets: AssetCount[];
	suppressedRealizedAssets: SuppressedRealizedAsset[];
}

export function tallyClosedAssets(input: {
	tradedAssets: ReadonlySet<string>;
	heldAssets: ReadonlySet<string>;
	pnlOf: (asset: string) => PnlResult;
	unresolvedDeposits: UnresolvedDeposits;
	heldRealizedPnl: number;
}): ClosedTally {
	let totalRealizedPnl = input.heldRealizedPnl;
	let closedSum = 0;
	let closedCount = 0;
	let closedSuppressed = false;
	const closedBreakdown: ClosedPosition[] = [];
	const unpricedDepositAssets: AssetCount[] = [];
	const qtyClampAssets: AssetCount[] = [];
	const suppressedRealizedAssets: SuppressedRealizedAsset[] = [];

	for (const asset of input.tradedAssets) {
		if (input.heldAssets.has(asset)) continue;
		const pnl = input.pnlOf(asset);
		const unresolvedDepositReason = input.unresolvedDeposits.reasons.get(asset);
		if (unresolvedDepositReason != null) {
			suppressedRealizedAssets.push({
				asset,
				count: input.unresolvedDeposits.countOf(asset),
				reason: unresolvedDepositReason,
			});
			closedSuppressed = true;
			continue;
		}
		// 金額の集計条件とは切り離す。未算入入庫があるからこそ 0 円に丸まるケースまで申告が消える（#77）。
		if (pnl.unpriced_deposit_count > 0) {
			unpricedDepositAssets.push({ asset, count: pnl.unpriced_deposit_count });
		}
		if (pnl.qty_clamp_count > 0) {
			qtyClampAssets.push({ asset, count: pnl.qty_clamp_count });
		}
		// realized_pnl が 0 の銘柄も内訳に含める。件数だけだと銘柄の入れ替わりが相殺されて見えなくなる（#92）。
		closedBreakdown.push({
			asset,
			realized_pnl: pnl.realized_pnl,
			priced_deposit_count: depositCountOrUndefined(pnl.priced_deposit_count),
			unpriced_deposit_count: depositCountOrUndefined(pnl.unpriced_deposit_count),
			realized_pnl_unavailable_reason: undefined,
		});
		if (pnl.realized_pnl !== 0) {
			totalRealizedPnl += pnl.realized_pnl;
			closedSum += pnl.realized_pnl;
			closedCount++;
		}
	}

	return {
		totalRealizedPnl,
		closedPositionRealizedPnl: closedSuppressed ? undefined : closedSum,
		closedPositionAssetCount: closedSuppressed ? undefined : closedCount,
		closedPositions: closedSuppressed
			? undefined
			: closedBreakdown.sort((x, y) => (y.realized_pnl ?? 0) - (x.realized_pnl ?? 0) || x.asset.localeCompare(y.asset)),
		unpricedDepositAssets,
		qtyClampAssets,
		suppressedRealizedAssets,
	};
}

// ?? 0 で欠損扱いすると負の realized_pnl を持つ要素より前に出るので、先に defined / undefined で分けて末尾にまとめる。
function byRealizedPnlDescUnknownLast(x: ClosedPosition, y: ClosedPosition): number {
	if (x.realized_pnl == null || y.realized_pnl == null) {
		if ((x.realized_pnl == null) !== (y.realized_pnl == null)) {
			return x.realized_pnl == null ? 1 : -1;
		}
		return x.asset.localeCompare(y.asset);
	}
	return y.realized_pnl - x.realized_pnl || x.asset.localeCompare(y.asset);
}

// 検出結果は合計に寄与しないので、他銘柄の抑止に道連れにせず closedPositions が undefined でも足す（#93）。
export function withDepositOnlyAssets(
	closedPositions: ClosedPosition[] | undefined,
	depositOnlyDetected: readonly string[],
	tradesTruncated: boolean,
): ClosedPosition[] | undefined {
	if (depositOnlyDetected.length === 0) return closedPositions;
	// 約定履歴が打ち切られていると誤検出しうるので、確度が落ちる場合は history_truncated に倒す（qtyMismatchReasonFor の優先順と揃える）。
	const detectionReason: PortfolioCostBasisUnavailableReason = tradesTruncated
		? 'history_truncated'
		: 'untracked_trade_suspected';
	const detectedEntries: ClosedPosition[] = depositOnlyDetected.map((asset) => ({
		asset,
		realized_pnl: undefined,
		priced_deposit_count: undefined,
		unpriced_deposit_count: undefined,
		realized_pnl_unavailable_reason: detectionReason,
	}));
	return [...(closedPositions ?? []), ...detectedEntries].sort(byRealizedPnlDescUnknownLast);
}

export interface UnrealizedTotals {
	/** 現在値が取れた銘柄の原価だけの合計。 */
	validCostBasis: number;
	hasValidCostData: boolean;
	totalUnrealizedPnl: number | undefined;
	totalUnrealizedPnlPct: number | undefined;
}

// ticker 未取得の銘柄の原価まで積むと過大なマイナスになるので、現在値が取れた銘柄の原価だけを集計し直す。
export function summarizeUnrealized(
	cryptoHoldings: readonly HoldingRow[],
	flowUnavailableReason: PortfolioFlowUnavailableReason | undefined,
): UnrealizedTotals {
	let validCostBasis = 0;
	let validJpyValue = 0;
	for (const h of cryptoHoldings) {
		if (h.jpy_value != null && h.cost_basis != null) {
			validCostBasis += h.cost_basis;
			validJpyValue += h.jpy_value;
		}
	}
	// validCostBasis は既に 0 だが、意図を明示するため理由コードでも閉じる。
	const hasValidCostData = flowUnavailableReason == null && validCostBasis > 0;
	const totalUnrealizedPnl = hasValidCostData ? Math.round(validJpyValue - validCostBasis) : undefined;
	const totalUnrealizedPnlPct =
		totalUnrealizedPnl != null && validCostBasis > 0
			? Math.round((totalUnrealizedPnl / validCostBasis) * 10000) / 100
			: undefined;
	return { validCostBasis, hasValidCostData, totalUnrealizedPnl, totalUnrealizedPnlPct };
}

// 銘柄名と件数のみで金額は出さない（sensitive-data の HIGH 分類）。売り切り銘柄は順序不定なので銘柄名でソートする。
export function assetCountLabel(entries: readonly AssetCount[]): string {
	return [...entries]
		.sort((x, y) => x.asset.localeCompare(y.asset))
		.map((e) => `${e.asset.toUpperCase()}（${e.count}件）`)
		.join(', ');
}

export interface HoldingPerformance {
	asset: string;
	pair: string;
	current_price: number | undefined;
	monthly_change_pct: number | undefined;
	yearly_change_pct: number | undefined;
	jpy_value: number | undefined;
	amount: string;
}

function changePctFrom(current: number | undefined, base: number | undefined): number | undefined {
	return current != null && base != null && base > 0 ? Math.round(((current - base) / base) * 10000) / 100 : undefined;
}

export function buildHoldingsPerformance(
	cryptoHoldings: readonly HoldingRow[],
	prices: Map<string, number>,
	boundaryPrices: CandlePriceData['boundaryPrices'],
): HoldingPerformance[] {
	return cryptoHoldings.map((h) => {
		const currentPrice = prices.get(h.asset);
		const bp = boundaryPrices.get(h.asset);
		return {
			asset: h.asset,
			pair: h.pair,
			current_price: h.current_price,
			monthly_change_pct: changePctFrom(currentPrice, bp?.monthStart),
			yearly_change_pct: changePctFrom(currentPrice, bp?.yearStart),
			jpy_value: h.jpy_value,
			amount: h.amount,
		};
	});
}
