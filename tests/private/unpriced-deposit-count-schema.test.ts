// realized_pnl の算出条件を出力から復元できることを、description の文面で機械的に固定する（#77。structuredContent を直読みする非 LLM クライアントの唯一の手掛かり）。
import { describe, expect, it } from 'vitest';
import { AnalyzeMyPortfolioDataSchema } from '../../src/private/schemas.js';
import { DEPRECATED_FIELD_REMOVAL_TARGET } from '../../src/schema/base.js';

type Described = { description?: string };

function holdingShape(): Record<string, Described> {
	const holdings = AnalyzeMyPortfolioDataSchema.shape.holdings as unknown as {
		element: { shape: Record<string, Described> };
	};
	return holdings.element.shape;
}

function periodRealizedPnlShape(field: 'yearly_realized_pnl' | 'monthly_realized_pnl'): Record<string, Described> {
	const optional = AnalyzeMyPortfolioDataSchema.shape[field] as unknown as {
		unwrap: () => { shape: Record<string, Described> };
	};
	return optional.unwrap().shape;
}

/** description が無ければ落とす（description 前提のテストが黙って通らないように） */
function descriptionOf(shape: Record<string, Described>, key: string): string {
	const description = shape[key]?.description;
	if (description == null) throw new Error(`description が無い: ${key}`);
	return description;
}

describe('入庫の原価算入件数 — キー順', () => {
	it('holdings[] の新設 2 キーは既存キーの後ろに宣言されている', () => {
		const keys = Object.keys(holdingShape());
		// 既存キーの並びは崩さない（#69 / #72 と同じ理由: JSON を中間から変えない）
		const beforeThisIssue = [
			'asset',
			'pair',
			'amount',
			'avg_buy_price',
			'current_price',
			'jpy_value',
			'cost_basis',
			'unrealized_pnl',
			'unrealized_pnl_pct',
			'realized_pnl',
			'trade_count',
			'cost_basis_unavailable_reason',
			'cost_basis_reliable',
		];
		expect(keys.slice(0, beforeThisIssue.length)).toEqual(beforeThisIssue);
		// 末尾からの相対位置では固定しない。後続の issue がさらに後ろへキーを足すと、「既存キーの後ろ」という主張と無関係に落ちる。
		expect(keys.slice(beforeThisIssue.length, beforeThisIssue.length + 2)).toEqual([
			'priced_deposit_count',
			'unpriced_deposit_count',
		]);
	});

	it.each([
		'yearly_realized_pnl',
		'monthly_realized_pnl',
	] as const)('%s の新設 2 キーは既存キーの後ろに宣言されている', (field) => {
		const keys = Object.keys(periodRealizedPnlShape(field));
		expect(keys).toEqual([
			'realized_pnl',
			'sell_count',
			'period_start',
			'period_end',
			// 旧名は同じ位置に alias として残す（#85）
			'priced_deposit_count',
			'unpriced_deposit_count',
			'realized_pnl_unavailable_reason',
			'priced_deposit_count_all_time',
			'unpriced_deposit_count_all_time',
		]);
	});
});

describe('入庫の原価算入件数 — 期間損益の alias（#85）', () => {
	it.each([
		['priced_deposit_count', 'priced_deposit_count_all_time'],
		['unpriced_deposit_count', 'unpriced_deposit_count_all_time'],
	] as const)('%s の description に写像先と削除目標バージョンが書いてある', (deprecated, replacement) => {
		for (const field of ['yearly_realized_pnl', 'monthly_realized_pnl'] as const) {
			const description = descriptionOf(periodRealizedPnlShape(field), deprecated);
			expect(description, `${field}.${deprecated}`).toContain('非推奨');
			expect(description, `${field}.${deprecated}`).toContain(replacement);
			expect(description, `${field}.${deprecated}`).toContain(DEPRECATED_FIELD_REMOVAL_TARGET);
			expect(description, `${field}.${deprecated}`).toContain('期間スコープではない');
		}
	});

	it('holdings[] の unpriced_deposit_count は改名していない（配置と意味が一致しているため）', () => {
		const keys = Object.keys(holdingShape());
		expect(keys).toContain('unpriced_deposit_count');
		expect(keys).not.toContain('unpriced_deposit_count_all_time');
		expect(keys).not.toContain('priced_deposit_count_all_time');
		const description = descriptionOf(holdingShape(), 'unpriced_deposit_count');
		expect(description).not.toContain('非推奨');
	});
});

describe('入庫の原価算入件数 — description', () => {
	it('unpriced_deposit_count は「原価ゼロ扱いで除外して算出した」ことを書いている', () => {
		const description = descriptionOf(holdingShape(), 'unpriced_deposit_count');
		expect(description).toContain('算入しなかった');
		expect(description).toContain('原価ゼロ扱いで除外して算出されている');
		// 影響を受ける 5 フィールドを名指しする（どの値が不完全なのかを消費者が特定できるように）
		for (const field of ['cost_basis', 'avg_buy_price', 'unrealized_pnl', 'unrealized_pnl_pct', 'realized_pnl']) {
			expect(description).toContain(field);
		}
	});

	it('unpriced_deposit_count は cost_basis_reliable=true と同時に成立することを書いている', () => {
		// 本 issue の核。`reliable: true` を「原価は完全」と読ませないための一文。
		const description = descriptionOf(holdingShape(), 'unpriced_deposit_count');
		expect(description).toContain('cost_basis_reliable=true でも本値が 0 でなければ原価は不完全');
		expect(description).toContain('別軸');
	});

	it('unpriced_deposit_count は既存の理由コードと別軸であることを書いている', () => {
		// cost_basis_unavailable_reason は「原価を出せなかった」理由、本フィールドは「原価は出したが不完全」の度合い（混同すると enum に値を足す誤った設計に流れる）。
		const description = descriptionOf(holdingShape(), 'unpriced_deposit_count');
		expect(description).toContain('cost_basis_unavailable_reason');
		expect(description).toContain('原価は出したが不完全');
	});

	it('priced_deposit_count は「算入した件数」であることを書いている', () => {
		const description = descriptionOf(holdingShape(), 'priced_deposit_count');
		expect(description).toContain('算入した');
		// 2 つの件数の和が母数（不完全さの度合いを読むための分母）
		expect(description).toContain('unpriced_deposit_count との和');
	});

	it('cost_basis_reliable は「原価が全入庫を含む」の意味ではないと書いている', () => {
		const description = descriptionOf(holdingShape(), 'cost_basis_reliable');
		expect(description).toContain('unpriced_deposit_count');
	});

	it.each([
		'total_cost_basis',
		'total_unrealized_pnl',
		'total_realized_pnl',
	] as const)('%s は原価不完全な銘柄を含めることを書いている（issue #77 仕様 4: 黙って混ぜない）', (field) => {
		const shape = AnalyzeMyPortfolioDataSchema.shape as unknown as Record<
			string,
			{ description?: string; unwrap?: () => Described }
		>;
		const description = shape[field]?.description ?? '';
		expect(description).toContain('除外せず');
	});

	it.each([
		'yearly_realized_pnl',
		'monthly_realized_pnl',
	] as const)('%s.unpriced_deposit_count_all_time は全履歴・全銘柄の件数であることと期間スコープではないことを書いている', (field) => {
		const description = descriptionOf(periodRealizedPnlShape(field), 'unpriced_deposit_count_all_time');
		expect(description).toContain('全履歴・全銘柄');
		expect(description).toContain('原価ゼロで売った');
		expect(description).toContain('期間スコープではない');
	});

	it.each([
		'yearly_realized_pnl',
		'monthly_realized_pnl',
	] as const)('%s.priced_deposit_count_all_time は期間スコープではないことを書いている', (field) => {
		const description = descriptionOf(periodRealizedPnlShape(field), 'priced_deposit_count_all_time');
		expect(description).toContain('全履歴・全銘柄');
		expect(description).toContain('期間スコープではない');
	});
});
