/**
 * `account_pnl` 系スキーマの契約テスト（#72）。
 *
 * 対象は 3 点。いずれも人手のレビューでは抜けやすいので機械的に固定する
 * （`.claude/rules/tools.md`「規約はテストで機械的に固定する」）。
 *
 * 1. **コスト項の符号規約が description に書いてある。** `structuredContent` を直読みする
 *    非 LLM クライアントにとって、フィールド名と description が符号を知る唯一の手掛かり。
 * 2. **alias に写像先と削除目標バージョンが書いてある。** 期日を書かない別名は「いつ消せるのか」
 *    が分からなくなり、恒久的な二重出力として残る。
 * 3. **新設キーは既存キーの後ろに宣言されている。** `z.object` の parse は宣言順で
 *    オブジェクトを組み直すため、宣言位置がそのまま wire のキー順になる。
 */
import { describe, expect, it } from 'vitest';
import { AnalyzeMyPortfolioDataSchema } from '../../src/private/schemas.js';
import { DEPRECATED_FIELD_REMOVAL_TARGET } from '../../src/schema/base.js';

/** `AnalyzeMyPortfolioDataSchema` の optional なオブジェクトフィールドから shape を取り出す。 */
function shapeOf(
	field: 'account_pnl' | 'yearly_account_pnl' | 'monthly_account_pnl',
): Record<string, { description?: string }> {
	const optional = AnalyzeMyPortfolioDataSchema.shape[field] as unknown as {
		unwrap: () => { shape: Record<string, { description?: string }> };
	};
	return optional.unwrap().shape;
}

const ALL_HISTORY_KEYS = [
	'spot_realized_pnl',
	'margin_realized_pnl',
	'margin_interest',
	'margin_fee',
	'total',
	'margin_interest_cost',
	'margin_fee_cost',
	// #80 で追加
	'spot_realized_pnl_unavailable_reason',
];

const PERIOD_KEYS = [
	'spot_realized_pnl',
	'margin_realized_pnl',
	'margin_interest',
	'margin_fee',
	'total',
	'period_start',
	'period_end',
	'margin_interest_cost',
	'margin_fee_cost',
	// #80 で追加
	'spot_realized_pnl_unavailable_reason',
];

describe('AccountPnl スキーマ（#72: 信用コスト項の命名）', () => {
	it('新フィールドの description に符号規約（コスト = 正値 / total では減算）が書いてある', () => {
		const shape = shapeOf('account_pnl');
		for (const key of ['margin_interest_cost', 'margin_fee_cost'] as const) {
			const description = shape[key].description ?? '';
			expect(description, `${key} の description`).toContain('コスト = 正値');
			expect(description, `${key} の description`).toContain('減算');
		}
	});

	it('total の description に計算式が書いてあり、コスト項を新フィールド名で参照している', () => {
		const description = shapeOf('account_pnl').total.description ?? '';
		expect(description).toContain('spot_realized_pnl');
		expect(description).toContain('margin_realized_pnl');
		expect(description).toContain('margin_interest_cost');
		expect(description).toContain('margin_fee_cost');
	});

	it('旧フィールドの description に写像先と削除目標バージョンが書いてある', () => {
		const shape = shapeOf('account_pnl');
		const cases = [
			['margin_interest', 'margin_interest_cost'],
			['margin_fee', 'margin_fee_cost'],
		] as const;
		for (const [deprecated, replacement] of cases) {
			const description = shape[deprecated].description ?? '';
			expect(description, `${deprecated} の description`).toContain('非推奨');
			expect(description, `${deprecated} の description`).toContain(replacement);
			expect(description, `${deprecated} の description`).toContain(DEPRECATED_FIELD_REMOVAL_TARGET);
			// alias は符号も含めて同じ値。「負値になる」と読める書き方をしない
			expect(description, `${deprecated} の description`).toContain('コスト = 正値');
		}
	});

	it('新設キーは既存キーの後ろに宣言されている（wire のキー順が中間から変わらない）', () => {
		expect(Object.keys(shapeOf('account_pnl'))).toEqual(ALL_HISTORY_KEYS);
		// 期間版は period_start / period_end も既存キー。新設キーはさらにその後ろ
		expect(Object.keys(shapeOf('yearly_account_pnl'))).toEqual(PERIOD_KEYS);
		expect(Object.keys(shapeOf('monthly_account_pnl'))).toEqual(PERIOD_KEYS);
	});
});
