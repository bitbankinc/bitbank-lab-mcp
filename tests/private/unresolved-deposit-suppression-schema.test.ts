/**
 * 入庫日価格を取得できない銘柄の抑止（issue #80）の契約テスト。
 *
 * `realized_pnl` は確定申告に使われうる数字なので、**出さなかったこと**と**なぜ出さなかったか**が
 * 出力から復元できなければならない。`structuredContent` を直読みする非 LLM クライアントにとって
 * description が唯一の手掛かりなので、意味づけを人手のレビューに委ねず機械的に固定する
 * （`.claude/rules/tools.md`「規約はテストで機械的に固定する」）。
 *
 * 固定するのは 4 点。
 * 1. **理由コードが「取得失敗」と「上限切り落とし」を区別できる。** 前者だけが実行ごとに
 *    結果が変わるので、読み手が「再実行すれば直るのか」を判断できる必要がある。
 * 2. **抑止範囲が description に書いてある。** 末尾 2 値だけが `realized_pnl` まで落とす、
 *    という他の理由コードとの非対称を書かないと消費者は `realized_pnl` を必ず読めると誤解する。
 * 3. **合計値の扱いが書いてある。** 抑止した銘柄を除外するのでも含めるのでもなく合計ごと
 *    出さない、という判断を黙って決めない（issue #80 仕様 3）。
 * 4. **検算式が壊れることが書いてある。** `Σ holdings[].realized_pnl +
 *    closed_position_realized_pnl = total_realized_pnl` は抑止実行では成立しない。
 */
import { describe, expect, it } from 'vitest';
import {
	AnalyzeMyPortfolioDataSchema,
	PortfolioCostBasisUnavailableReasonEnum,
	PortfolioUnresolvedDepositReasonEnum,
} from '../../src/private/schemas.js';

type Described = { description?: string };

/** `holdings[]` の要素スキーマ（`HoldingPnlSchema`）の shape */
function holdingShape(): Record<string, Described> {
	const holdings = AnalyzeMyPortfolioDataSchema.shape.holdings as unknown as {
		element: { shape: Record<string, Described> };
	};
	return holdings.element.shape;
}

/** optional なオブジェクトフィールドの shape */
function unwrappedShape(
	field: 'account_pnl' | 'yearly_realized_pnl' | 'monthly_realized_pnl',
): Record<string, Described> {
	const optional = AnalyzeMyPortfolioDataSchema.shape[field] as unknown as {
		unwrap: () => { shape: Record<string, Described> };
	};
	return optional.unwrap().shape;
}

/** shape から description を取り出す。無ければ落とす（description 前提のテストが黙って通らないように） */
function descriptionOf(shape: Record<string, Described>, key: string): string {
	const description = shape[key]?.description;
	if (description == null) throw new Error(`description が無い: ${key}`);
	return description;
}

/** データスキーマ直下フィールドの description */
function dataDescriptionOf(key: keyof typeof AnalyzeMyPortfolioDataSchema.shape): string {
	const described = AnalyzeMyPortfolioDataSchema.shape[key] as unknown as Described;
	if (described.description == null) throw new Error(`description が無い: ${String(key)}`);
	return described.description;
}

describe('入庫日価格の抑止 — 理由コード enum', () => {
	it('取得失敗と上限切り落としを別の値で表す', () => {
		expect(PortfolioUnresolvedDepositReasonEnum.options).toEqual([
			'deposit_price_fetch_failed',
			'deposit_price_chunk_truncated',
		]);
	});

	it('原価の理由コードの上位集合に含まれ、既存値の順序を崩さない', () => {
		// 公開済みの列挙は中間から変えない（新設値は末尾に足す）
		expect(PortfolioCostBasisUnavailableReasonEnum.options).toEqual([
			'dw_fetch_failed',
			'dw_history_incomplete',
			'has_crypto_deposits',
			'history_truncated',
			'unknown',
			'deposit_price_fetch_failed',
			'deposit_price_chunk_truncated',
			// #89 で追加（末尾に足す）
			'reconstructed_qty_negative',
			// #93 で追加（末尾に足す）
			'untracked_trade_suspected',
		]);
	});
});

describe('入庫日価格の抑止 — description', () => {
	it('cost_basis_unavailable_reason は realized_pnl まで落とす 2 値を名指しする', () => {
		const description = descriptionOf(holdingShape(), 'cost_basis_unavailable_reason');
		for (const reason of PortfolioUnresolvedDepositReasonEnum.options) {
			expect(description, `${reason} の説明`).toContain(reason);
		}
		// 他の理由コードとの非対称（この 2 値だけ realized_pnl も undefined）を明示する
		expect(description).toContain('realized_pnl も undefined');
		// 数量不変条件より優先することも書く（同時成立時にどちらが載るかを消費者が予測できるように）
		expect(description).toContain('has_crypto_deposits ではなくこちらが載る');
	});

	it('holdings[].realized_pnl は検算式が壊れる条件を書いている', () => {
		const description = descriptionOf(holdingShape(), 'realized_pnl');
		expect(description).toContain('成立しない');
		for (const reason of PortfolioUnresolvedDepositReasonEnum.options) {
			expect(description).toContain(reason);
		}
	});

	it('total_realized_pnl は「部分和を出さない」判断を書いている', () => {
		const description = dataDescriptionOf('total_realized_pnl');
		expect(description).toContain('total_realized_pnl_unavailable_reason');
		expect(description).toContain('部分和を確定値として出さない');
	});

	it('total_realized_pnl_unavailable_reason は影響範囲と検算式の破れを書いている', () => {
		const description = dataDescriptionOf('total_realized_pnl_unavailable_reason');
		// どのフィールドが undefined になるかを名指しする
		for (const field of [
			'total_realized_pnl',
			'account_pnl.spot_realized_pnl',
			'account_pnl.total',
			'closed_position_realized_pnl',
		]) {
			expect(description, `${field} への言及`).toContain(field);
		}
		expect(description).toContain('成立しない');
	});

	it('account_pnl は spot / total の抑止条件を書いている', () => {
		const shape = unwrappedShape('account_pnl');
		expect(descriptionOf(shape, 'spot_realized_pnl')).toContain('spot_realized_pnl_unavailable_reason');
		expect(descriptionOf(shape, 'total')).toContain('undefined');
		const reason = descriptionOf(shape, 'spot_realized_pnl_unavailable_reason');
		expect(reason).toContain('信用側の 4 フィールドはそのまま出る');
		for (const value of PortfolioUnresolvedDepositReasonEnum.options) {
			expect(reason).toContain(value);
		}
	});

	it('期間実現損益は「売却がある期間だけ抑止する」ことを書いている', () => {
		for (const field of ['yearly_realized_pnl', 'monthly_realized_pnl'] as const) {
			const shape = unwrappedShape(field);
			expect(descriptionOf(shape, 'realized_pnl'), field).toContain('realized_pnl_unavailable_reason');
			const reason = descriptionOf(shape, 'realized_pnl_unavailable_reason');
			expect(reason, field).toContain('期間内に該当銘柄の売却が無ければ抑止しない');
			// 売却件数は原価に依存しないので残すことも書く
			expect(reason, field).toContain('sell_count は出る');
		}
	});

	it('unpriced_deposit_count は「件数が 0 でなくても抑止されるとは限らない」ことを書いている', () => {
		// 恒久的に解決できない未算入（上場前・当日足の欠損）は抑止対象外。
		// ここを書かないと消費者は「件数 > 0 = 値が出ない」と読む。
		const description = descriptionOf(unwrappedShape('yearly_realized_pnl'), 'unpriced_deposit_count');
		expect(description).toContain('本値が 0 でなくても realized_pnl は出る');
		expect(description).toContain('realized_pnl_unavailable_reason');
	});
});
