import { realpathSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
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

/** チャートファイルの既定出力ディレクトリ（Claude.ai 環境の出力先） */
export const DEFAULT_CHART_OUTPUT_DIR = '/mnt/user-data/outputs';

/** チャート出力の許可 root を運用側が追加する環境変数（path.delimiter 区切り） */
export const OUTPUT_DIR_ALLOWLIST_ENV = 'BACKTEST_OUTPUT_DIR_ALLOWLIST';

/**
 * チャート出力先として許可される root ディレクトリ一覧。
 * 既定: DEFAULT_CHART_OUTPUT_DIR とサーバー作業ディレクトリ配下
 * （相対パス指定・Cursor 等でワークスペース直下に書き出すユースケース用）。
 * それ以外は運用側が環境変数で明示的に許可する（LLM 入力からは追加できない）。
 */
export function allowedOutputRoots(): string[] {
	const extra = (process.env[OUTPUT_DIR_ALLOWLIST_ENV] ?? '')
		.split(delimiter)
		.map((p) => p.trim())
		.filter((p) => p.length > 0)
		.map((p) => resolve(p));
	return [resolve(DEFAULT_CHART_OUTPUT_DIR), process.cwd(), ...extra];
}

/**
 * パスを実パスに正規化する。実在する最深の祖先を realpathSync で解決し、
 * 未作成の末尾セグメントは字句のまま結合する（mkdir 前の検証で使うため）。
 * 許可 root 配下に置かれた symlink を経由した外部への書き込みを防ぐ。
 */
function canonicalizePath(p: string): string {
	let current = resolve(p);
	const pending: string[] = [];
	for (;;) {
		try {
			return join(realpathSync(current), ...pending);
		} catch {
			const parent = dirname(current);
			if (parent === current) return join(current, ...pending);
			pending.unshift(basename(current));
			current = parent;
		}
	}
}

/**
 * outputDir が許可 root 配下かを検証する。
 * LLM 入力（プロンプトインジェクション含む）経由でプロセス権限内の任意パスへ
 * ディレクトリ作成・ファイル書き込みされるのを防ぐ。`..` を含むパスも
 * symlink も実パスに解決してから判定するため、トラバーサル・symlink では
 * 迂回できない（検証と書き込みの間に symlink を差し替える TOCTOU は、
 * それができる時点でローカルアクセスを持つため脅威モデル外）。
 */
export function ensureAllowedOutputDir(
	dir: string,
): { ok: true; dir: string } | { ok: false; error: { type: 'user' | 'internal'; message: string } } {
	const canonical = canonicalizePath(dir);
	const roots = allowedOutputRoots();
	const canonicalRoots = roots.map(canonicalizePath);
	const allowed = canonicalRoots.some((root) => canonical === root || canonical.startsWith(root + sep));
	if (!allowed) {
		return {
			ok: false,
			error: {
				type: 'user',
				message: `outputDir '${dir}' は許可されていません。許可 root: ${roots.join(', ')} 配下のみ（追加は環境変数 ${OUTPUT_DIR_ALLOWLIST_ENV} で指定）`,
			},
		};
	}
	return { ok: true, dir: canonical };
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
