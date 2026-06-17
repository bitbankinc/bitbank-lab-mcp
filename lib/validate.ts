import type { Pair } from '../src/schemas.js';
import { nowIso } from './datetime.js';

// bitbank 公式ペアリスト（アクティブなもののみ）
// 参考: https://github.com/bitbankinc/bitbank-api-docs/blob/master/pairs.md
//
// ⚠️ 制約: このリストは現状 JPY 建てのみ。
// 表示層（lib/formatter.ts ほか多数）が価格に「円」を直書きしているため、
// 非 JPY 建て（例: eth_btc）を追加する場合は表示層の quote 通貨対応が必須。
// Pair 型は `${string}_${string}` なので型では防げず、サイレントに誤表記となる。
// tests/lib/validate.test.ts のガードが番人（非JPYを足した瞬間 CI が赤くなる）。
export const ALLOWED_PAIRS: Set<Pair> = new Set([
	// 主要ペア
	'btc_jpy',
	'eth_jpy',
	'xrp_jpy',
	'ltc_jpy',
	'bcc_jpy',
	// アルトコイン
	'mona_jpy',
	'xlm_jpy',
	'qtum_jpy',
	'bat_jpy',
	'omg_jpy',
	'xym_jpy',
	'link_jpy',
	'boba_jpy',
	'enj_jpy',
	'dot_jpy',
	'doge_jpy',
	'astr_jpy',
	'ada_jpy',
	'avax_jpy',
	'axs_jpy',
	'flr_jpy',
	'sand_jpy',
	'gala_jpy',
	'ape_jpy',
	'chz_jpy',
	'oas_jpy',
	'mana_jpy',
	'grt_jpy',
	'bnb_jpy',
	'dai_jpy',
	'op_jpy',
	'arb_jpy',
	'klay_jpy',
	'imx_jpy',
	'mask_jpy',
	'pol_jpy', // 旧 matic_jpy
	'sol_jpy',
	'cyber_jpy',
	'render_jpy', // 旧 rndr_jpy
	'trx_jpy',
	'lpt_jpy',
	'atom_jpy',
	'sui_jpy',
	'sky_jpy', // 旧 mkr_jpy
]);

export function normalizePair(raw: unknown): Pair | null {
	if (!raw) return null;
	const s = String(raw).trim().toLowerCase();
	// Zodバリデーション済みの場合、形式変換（BTC/JPY → btc_jpy）は不要
	// 正規形式（xxx_yyy）以外は null を返す
	if (!/^[a-z0-9]+_[a-z0-9]+$/.test(s)) return null;
	return s as Pair;
}

export function ensurePair(
	pair: unknown,
): { ok: true; pair: Pair } | { ok: false; error: { type: 'user' | 'internal'; message: string } } {
	const norm = normalizePair(pair);
	if (!norm) {
		return {
			ok: false,
			error: { type: 'user', message: `pair '${String(pair)}' が不正です（例: btc_jpy）` },
		};
	}
	if (!ALLOWED_PAIRS.has(norm)) {
		return {
			ok: false,
			error: {
				type: 'user',
				message: `未対応のpair: '${norm}'（対応例: ${[...ALLOWED_PAIRS].slice(0, 5).join(', ')}...）`,
			},
		};
	}
	return { ok: true, pair: norm };
}

export function validateLimit(
	limit: unknown,
	min = 1,
	max = 1000,
	paramName = 'limit',
): { ok: true; value: number } | { ok: false; error: { type: 'user' | 'internal'; message: string } } {
	const num = Number(limit);
	if (!Number.isInteger(num) || num < min || num > max) {
		return {
			ok: false,
			error: {
				type: 'user',
				message: `${paramName} は ${min}〜${max} の整数で指定してください（指定値: ${String(limit)}）`,
			},
		};
	}
	return { ok: true, value: num };
}

export function validateDate(
	date: string,
	type: string | null = null,
): { ok: true; value: string } | { ok: false; error: { type: 'user' | 'internal'; message: string } } {
	if (type) {
		// YYYYMMDD が必要なタイプ（分足～1時間足）
		const TYPES_REQUIRE_YYYYMMDD = new Set(['1min', '5min', '15min', '30min', '1hour']);

		if (TYPES_REQUIRE_YYYYMMDD.has(type)) {
			if (!/^\d{8}$/.test(date)) {
				return {
					ok: false,
					error: {
						type: 'user',
						message: `${type} の場合、date は YYYYMMDD 形式で指定してください（指定値: ${date}）`,
					},
				};
			}
			return { ok: true, value: date };
		} else {
			// 4hour/8hour/12hour 以上は YYYY 単位で取得（公式仕様）
			if (!/^\d{4,8}$/.test(date)) {
				return {
					ok: false,
					error: { type: 'user', message: `date は YYYY または YYYYMMDD 形式で指定してください（指定値: ${date}）` },
				};
			}
			return { ok: true, value: String(date).substring(0, 4) };
		}
	}

	if (!/^\d{4,8}$/.test(date)) {
		return {
			ok: false,
			error: { type: 'user', message: `date は YYYY または YYYYMMDD 形式で指定してください（指定値: ${date}）` },
		};
	}
	return { ok: true, value: date };
}

export function createMeta(
	pair: Pair,
	additional: Record<string, unknown> = {},
): Record<string, unknown> & { pair: Pair; fetchedAt: string } {
	return {
		pair,
		fetchedAt: nowIso(),
		...additional,
	};
}
