import { TtlCache } from './cache.js';
import { toNum } from './conversions.js';
import { getErrorMessage, isAbortError } from './error.js';
import { roundAtDecimalDigits } from './price.js';

/** private API のホストだが認証不要。 */
export const SPOT_PAIRS_URL = 'https://api.bitbank.cc/v1/spot/pairs';

// TTL の不正値（空文字 / NaN / 0 以下）はデフォルトに落とす。TTL=0 でキャッシュが恒久的に無効化されるのを防ぐため。
const DEFAULT_PAIRS_TTL_MS = 60 * 60 * 1000;
function resolvePairsTtlMs(): number {
	const raw = process.env.BITBANK_SPOT_PAIRS_TTL_MS;
	if (raw == null || raw.trim() === '') return DEFAULT_PAIRS_TTL_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PAIRS_TTL_MS;
}
const PAIRS_TTL_MS = resolvePairsTtlMs();
const FETCH_TIMEOUT_MS_DEFAULT = 5000;
const CACHE_KEY = 'spot_pairs';

export interface PairSpec {
	name: string;
	base_asset: string;
	quote_asset: string;
	unit_amount: string;
	/** limit / stop_limit の最大注文数量 */
	limit_max_amount: string;
	/** market / stop の最大注文数量 */
	market_max_amount: string;
	price_digits: number;
	amount_digits: number;
	is_enabled: boolean;
	stop_order: boolean;
	stop_order_and_cancel: boolean;
	stop_market_order: boolean;
	stop_stop_order: boolean;
	stop_stop_limit_order: boolean;
	stop_margin_long_order: boolean;
	stop_margin_short_order: boolean;
	stop_buy_order: boolean;
	stop_sell_order: boolean;

	// 文字列のまま保持し欠損は null。直接 parse せず lib/fees.ts 経由で解決する（.claude/rules/fees.md）。
	taker_fee_rate_quote: string | null;
	/** campaign で負のリベートになりうる。 */
	maker_fee_rate_quote: string | null;
	taker_fee_rate_base: string | null;
	maker_fee_rate_base: string | null;
	margin_open_maker_fee_rate_quote: string | null;
	margin_open_taker_fee_rate_quote: string | null;
	margin_close_maker_fee_rate_quote: string | null;
	margin_close_taker_fee_rate_quote: string | null;
}

/** lowercase キー。 */
export type PairsSpecMap = Map<string, PairSpec>;

const cache = new TtlCache<PairsSpecMap>({ ttlMs: PAIRS_TTL_MS, maxEntries: 1 });

export function clearPairsSpecCache(): void {
	cache.clear();
}

interface RawPair {
	name?: string;
	base_asset?: string;
	quote_asset?: string;
	unit_amount?: string;
	limit_max_amount?: string;
	market_max_amount?: string;
	price_digits?: number;
	amount_digits?: number;
	is_enabled?: boolean;
	stop_order?: boolean;
	stop_order_and_cancel?: boolean;
	stop_market_order?: boolean;
	stop_stop_order?: boolean;
	stop_stop_limit_order?: boolean;
	stop_margin_long_order?: boolean;
	stop_margin_short_order?: boolean;
	stop_buy_order?: boolean;
	stop_sell_order?: boolean;
	taker_fee_rate_quote?: string | null;
	maker_fee_rate_quote?: string | null;
	taker_fee_rate_base?: string | null;
	maker_fee_rate_base?: string | null;
	margin_open_maker_fee_rate_quote?: string | null;
	margin_open_taker_fee_rate_quote?: string | null;
	margin_close_maker_fee_rate_quote?: string | null;
	margin_close_taker_fee_rate_quote?: string | null;
}

function feeRateOrNull(v: unknown): string | null {
	return typeof v === 'string' ? v : null;
}

function normalize(raw: RawPair): PairSpec | null {
	if (!raw?.name) return null;
	const priceDigits = Number(raw.price_digits);
	const amountDigits = Number(raw.amount_digits);
	return {
		name: String(raw.name).toLowerCase(),
		base_asset: String(raw.base_asset ?? ''),
		quote_asset: String(raw.quote_asset ?? ''),
		unit_amount: String(raw.unit_amount ?? '0'),
		limit_max_amount: String(raw.limit_max_amount ?? ''),
		market_max_amount: String(raw.market_max_amount ?? ''),
		price_digits: Number.isFinite(priceDigits) ? priceDigits : 0,
		amount_digits: Number.isFinite(amountDigits) ? amountDigits : 0,
		is_enabled: raw.is_enabled === true,
		stop_order: raw.stop_order === true,
		stop_order_and_cancel: raw.stop_order_and_cancel === true,
		stop_market_order: raw.stop_market_order === true,
		stop_stop_order: raw.stop_stop_order === true,
		stop_stop_limit_order: raw.stop_stop_limit_order === true,
		stop_margin_long_order: raw.stop_margin_long_order === true,
		stop_margin_short_order: raw.stop_margin_short_order === true,
		stop_buy_order: raw.stop_buy_order === true,
		stop_sell_order: raw.stop_sell_order === true,
		taker_fee_rate_quote: feeRateOrNull(raw.taker_fee_rate_quote),
		maker_fee_rate_quote: feeRateOrNull(raw.maker_fee_rate_quote),
		taker_fee_rate_base: feeRateOrNull(raw.taker_fee_rate_base),
		maker_fee_rate_base: feeRateOrNull(raw.maker_fee_rate_base),
		margin_open_maker_fee_rate_quote: feeRateOrNull(raw.margin_open_maker_fee_rate_quote),
		margin_open_taker_fee_rate_quote: feeRateOrNull(raw.margin_open_taker_fee_rate_quote),
		margin_close_maker_fee_rate_quote: feeRateOrNull(raw.margin_close_maker_fee_rate_quote),
		margin_close_taker_fee_rate_quote: feeRateOrNull(raw.margin_close_taker_fee_rate_quote),
	};
}

export interface FetchPairsSpecOptions {
	timeoutMs?: number;
	/** 取得失敗時は throw し、古いキャッシュは破棄しない（上書きは成功時のみ）。 */
	forceRefresh?: boolean;
}

export async function fetchPairsSpec(opts: FetchPairsSpecOptions = {}): Promise<PairsSpecMap> {
	if (!opts.forceRefresh) {
		const cached = cache.get(CACHE_KEY);
		if (cached) return cached;
	}

	const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS_DEFAULT;
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(SPOT_PAIRS_URL, { signal: ctrl.signal });
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
		const json = (await res.json()) as { success?: number; data?: { pairs?: unknown[] } };
		if (json?.success !== 1 || !Array.isArray(json.data?.pairs)) {
			throw new Error('上流レスポンスが不正です（success !== 1 または data.pairs が配列でない）');
		}
		const map: PairsSpecMap = new Map();
		for (const raw of json.data.pairs as RawPair[]) {
			const spec = normalize(raw);
			if (spec) map.set(spec.name, spec);
		}
		if (map.size === 0) throw new Error('ペア仕様が空です');
		cache.set(CACHE_KEY, map);
		return map;
	} catch (err) {
		if (isAbortError(err)) throw new Error(`/spot/pairs 取得タイムアウト (${timeoutMs}ms)`);
		throw new Error(`/spot/pairs 取得失敗: ${getErrorMessage(err)}`);
	} finally {
		clearTimeout(t);
	}
}

// spec が無いときは丸めずに生値を返す。整数丸めにフォールバックすると低価格ペアが壊れる（XLM 26.686 → 27）。
export function roundToPriceDigits(
	value: number | undefined,
	spec: PairSpec | undefined,
	opts: { extraDigits?: number } = {},
): number | undefined {
	if (value == null || !Number.isFinite(value)) return undefined;
	if (spec == null) return value;
	const digits = spec.price_digits + (opts.extraDigits ?? 0);
	if (!Number.isFinite(digits) || digits < 0) return value;
	const rounded = roundAtDecimalDigits(value, digits);
	// 巨大値が Infinity に飛んだ場合は丸めを諦めて生値を返す。
	return Number.isFinite(rounded) ? rounded : value;
}

export interface OrderConstraintsInput {
	pair: string;
	type: 'limit' | 'market' | 'stop' | 'stop_limit';
	side: 'buy' | 'sell';
	amount: string;
	price?: string;
	trigger_price?: string;
	position_side?: 'long' | 'short';
}

export interface ConstraintViolation {
	field: 'pair' | 'amount' | 'price' | 'trigger_price' | 'type' | 'side';
	message: string;
}

export function fractionalDigitCount(s: string): number {
	if (typeof s !== 'string') return 0;
	const dot = s.indexOf('.');
	if (dot < 0) return 0;
	const stripped = s.replace(/0+$/, '').replace(/\.$/, '');
	const newDot = stripped.indexOf('.');
	if (newDot < 0) return 0;
	return stripped.length - newDot - 1;
}

// 違反は最初の 1 件だけ返す（pair 存在 → 取引停止 → 数量 → 価格 の順）。
export function validateOrderConstraints(
	spec: PairSpec | undefined,
	input: OrderConstraintsInput,
): ConstraintViolation | null {
	if (!spec) {
		return {
			field: 'pair',
			message: `未対応のペア '${input.pair}'。bitbank の /spot/pairs に存在しません`,
		};
	}

	if (!spec.is_enabled) {
		return {
			field: 'pair',
			message: `ペア '${spec.name}' は現在取引停止中です（is_enabled=false）`,
		};
	}

	if (spec.stop_order_and_cancel) {
		return {
			field: 'pair',
			message: `ペア '${spec.name}' は現在新規注文・キャンセルともに停止中です（stop_order_and_cancel）`,
		};
	}
	if (spec.stop_order) {
		return {
			field: 'pair',
			message: `ペア '${spec.name}' は現在新規注文を停止しています（stop_order）`,
		};
	}

	if (input.type === 'market' && spec.stop_market_order) {
		return { field: 'type', message: `ペア '${spec.name}' は現在 market 注文を停止しています` };
	}
	if (input.type === 'stop' && spec.stop_stop_order) {
		return { field: 'type', message: `ペア '${spec.name}' は現在 stop 注文を停止しています` };
	}
	if (input.type === 'stop_limit' && spec.stop_stop_limit_order) {
		return { field: 'type', message: `ペア '${spec.name}' は現在 stop_limit 注文を停止しています` };
	}

	if (input.side === 'buy' && spec.stop_buy_order) {
		return { field: 'side', message: `ペア '${spec.name}' は現在 buy 注文を停止しています` };
	}
	if (input.side === 'sell' && spec.stop_sell_order) {
		return { field: 'side', message: `ペア '${spec.name}' は現在 sell 注文を停止しています` };
	}

	if (input.position_side === 'long' && input.side === 'buy' && spec.stop_margin_long_order) {
		return { field: 'type', message: `ペア '${spec.name}' は現在 信用ロング新規建て を停止しています` };
	}
	if (input.position_side === 'short' && input.side === 'sell' && spec.stop_margin_short_order) {
		return { field: 'type', message: `ペア '${spec.name}' は現在 信用ショート新規建て を停止しています` };
	}

	const baseLabel = spec.base_asset ? spec.base_asset.toUpperCase() : '';

	const amountNum = toNum(input.amount);
	const minNum = toNum(spec.unit_amount);
	if (amountNum != null && minNum != null && amountNum < minNum) {
		return {
			field: 'amount',
			message: `amount は最小注文数量 ${spec.unit_amount} ${baseLabel} 以上を指定してください（指定値: ${input.amount}）`,
		};
	}

	const isLimitFamily = input.type === 'limit' || input.type === 'stop_limit';
	const maxStr = isLimitFamily ? spec.limit_max_amount : spec.market_max_amount;
	const maxNum = toNum(maxStr);
	if (amountNum != null && maxNum != null && maxNum > 0 && amountNum > maxNum) {
		const limitLabel = isLimitFamily ? 'limit / stop_limit' : 'market / stop';
		return {
			field: 'amount',
			message: `amount は最大注文数量 ${maxStr} ${baseLabel} 以下を指定してください（${limitLabel} の上限。指定値: ${input.amount}）`,
		};
	}

	const amountFrac = fractionalDigitCount(input.amount);
	if (amountFrac > spec.amount_digits) {
		return {
			field: 'amount',
			message: `amount の小数桁数 (${amountFrac}) が許容上限 (${spec.amount_digits}) を超えています（最小単位: 10^-${spec.amount_digits} ${baseLabel}）`,
		};
	}

	if (input.price != null && input.price !== '') {
		const priceFrac = fractionalDigitCount(input.price);
		if (priceFrac > spec.price_digits) {
			return {
				field: 'price',
				message: `price の小数桁数 (${priceFrac}) が許容上限 (${spec.price_digits}) を超えています（最小値刻み: 10^-${spec.price_digits}）`,
			};
		}
	}

	if (input.trigger_price != null && input.trigger_price !== '') {
		const tpFrac = fractionalDigitCount(input.trigger_price);
		if (tpFrac > spec.price_digits) {
			return {
				field: 'trigger_price',
				message: `trigger_price の小数桁数 (${tpFrac}) が許容上限 (${spec.price_digits}) を超えています（最小値刻み: 10^-${spec.price_digits}）`,
			};
		}
	}

	return null;
}
