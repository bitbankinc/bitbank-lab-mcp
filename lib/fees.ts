// 見積り専用（カテゴリ A / B）。C のパススルーと実績側（trade_history の実額）は扱わない（.claude/rules/fees.md）。
// 解決は必ず ?? で行い || は使わない（campaign の 0 が fallback に化ける）。クランプもしない（負の maker リベートを返す）。

import { toNum } from './conversions.js';
import type { PairSpec } from './pairs.js';

/** ペア仕様が引けないときの公称 taker 手数料率（bitbank 現物 taker = 0.12%）。 */
export const DEFAULT_TAKER_FALLBACK = 0.0012;

export type FeeRole = 'maker' | 'taker';

/** preview_order / pairs と同じ語彙。 */
export type OrderType = 'limit' | 'market' | 'stop' | 'stop_limit';

// toNum は 0 / 負値を保持し、欠損・空文字・有限数にならない値だけを null にする（lib/conversions.ts）。
function resolveRate(raw: unknown, override?: number): number {
	return override ?? toNum(raw) ?? DEFAULT_TAKER_FALLBACK;
}

// 公称率に落とす前の値。null は「API が率を返していない」。
export function specFeeRate(spec: PairSpec | undefined, role: FeeRole): number | null {
	const raw = spec == null ? undefined : role === 'maker' ? spec.maker_fee_rate_quote : spec.taker_fee_rate_quote;
	return toNum(raw);
}

export function resolveFeeRate(spec: PairSpec | undefined, role: FeeRole, override?: number): number {
	return override ?? specFeeRate(spec, role) ?? DEFAULT_TAKER_FALLBACK;
}

// post_only は板を跨げず拒否されるので必ず maker。板を跨ぐ指値は即時約定するので taker（stop_limit は発動時の板が分からないので maker のまま）。
export function feeRole(type: OrderType, postOnly?: boolean, crossesBook?: boolean): FeeRole {
	if (postOnly === true) return 'maker';
	if (type === 'limit' && crossesBook === true) return 'taker';
	if (type === 'limit' || type === 'stop_limit') return 'maker';
	return 'taker';
}

function isMarginOpen(side: 'buy' | 'sell', positionSide: 'long' | 'short'): boolean {
	return (side === 'buy' && positionSide === 'long') || (side === 'sell' && positionSide === 'short');
}

function marginFeeField(open: boolean, role: FeeRole): keyof PairSpec {
	if (open) {
		return role === 'maker' ? 'margin_open_maker_fee_rate_quote' : 'margin_open_taker_fee_rate_quote';
	}
	return role === 'maker' ? 'margin_close_maker_fee_rate_quote' : 'margin_close_taker_fee_rate_quote';
}

export interface OrderFeeInput {
	type: OrderType;
	side: 'buy' | 'sell';
	price?: string | number | null;
	amount: string | number;
	postOnly?: boolean;
	positionSide?: 'long' | 'short';
	/** 現在の板と比べた結果。undefined は「比べられなかった」で、maker 想定のまま見積る。 */
	crossesBook?: boolean;
}

export interface OrderFeeEstimate {
	role: FeeRole;
	rate: number;
	estimatedFeeQuote?: number;
	estimatedCostQuote?: number;
	note: string;
}

function isJpyQuote(spec: PairSpec | undefined): boolean {
	return spec?.quote_asset?.toLowerCase() === 'jpy';
}

const MARGIN_RATE_MISSING_NOTE = '信用手数料率が API 未提供のため概算';
const MARGIN_INTEREST_NOTE = '利息（interest）は見積りに含めない（実績は trade_history）';
// 約定履歴の手数料は円未満まで計上されるが、端数処理の規則は確認できていないので概算と明記する（issue 449）。
const JPY_ROUNDING_NOTE = '推定手数料は円未満を四捨五入した概算（実際の手数料は円未満まで計上される）';

// 信用レートが null なら公称 taker で概算して note に「API 未提供」を付け、利息は見積りに含めない旨を常に note に付ける（誤った確定値を出さない）。
export function estimateOrderFee(spec: PairSpec | undefined, order: OrderFeeInput): OrderFeeEstimate {
	const role = feeRole(order.type, order.postOnly, order.crossesBook);
	const isMargin = order.positionSide != null;

	let rate: number;
	let marginRateMissing = false;
	if (isMargin) {
		const open = isMarginOpen(order.side, order.positionSide as 'long' | 'short');
		const raw = spec == null ? undefined : spec[marginFeeField(open, role)];
		marginRateMissing = toNum(raw) == null;
		rate = resolveRate(raw);
	} else {
		rate = resolveFeeRate(spec, role);
	}

	const priceNum = toNum(order.price);
	const amountNum = toNum(order.amount);
	const isLimitFamily = order.type === 'limit' || order.type === 'stop_limit';

	let estimatedFeeQuote: number | undefined;
	let estimatedCostQuote: number | undefined;
	let baseNote: string;

	if (isLimitFamily && priceNum != null && amountNum != null) {
		const notional = priceNum * amountNum;
		let fee = notional * rate;
		if (isJpyQuote(spec)) fee = Math.round(fee);
		estimatedFeeQuote = fee;
		estimatedCostQuote = order.side === 'buy' ? notional + fee : notional - fee;
		baseNote = order.postOnly
			? 'maker 確定'
			: role === 'taker'
				? 'taker 想定（指値が現在の板を跨ぐため即時約定）'
				: 'maker 想定（板を跨ぐと taker）';
	} else if (order.type === 'market' || order.type === 'stop') {
		baseNote = '成行/逆指値: 約定価格依存で JPY 見積りは省略';
	} else {
		baseNote = '指値だが price 未指定のため JPY 見積りは省略';
	}

	const notes: string[] = [baseNote];
	if (estimatedFeeQuote != null && isJpyQuote(spec)) notes.push(JPY_ROUNDING_NOTE);
	if (spec === undefined) {
		notes.push('spec 不明のため公称 taker で概算');
	}
	if (isMargin) {
		if (marginRateMissing) notes.push(MARGIN_RATE_MISSING_NOTE);
		notes.push(MARGIN_INTEREST_NOTE);
	}

	return { role, rate, estimatedFeeQuote, estimatedCostQuote, note: notes.join(' / ') };
}
