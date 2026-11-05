// closed_positions の description は structuredContent を直読みする非 LLM クライアントの唯一の手掛かりなので、意味づけを機械的に固定する（#92 / #93）。
import { describe, expect, it } from 'vitest';
import { AnalyzeMyPortfolioDataSchema } from '../../src/private/schemas.js';

type Described = { description?: string };

function closedPositionShape(): Record<string, Described> {
	const closedPositions = AnalyzeMyPortfolioDataSchema.shape.closed_positions as unknown as {
		unwrap: () => { element: { shape: Record<string, Described> } };
	};
	return closedPositions.unwrap().element.shape;
}

/** description が無ければ落とす（description 前提のテストが黙って通らないように） */
function descriptionOf(shape: Record<string, Described>, key: string): string {
	const description = shape[key]?.description;
	if (description == null) throw new Error(`description が無い: ${key}`);
	return description;
}

describe('売り切り銘柄の内訳 — キー順', () => {
	it('closed_positions は AnalyzeMyPortfolioDataSchema の既存キーの後ろに宣言されている', () => {
		const keys = Object.keys(AnalyzeMyPortfolioDataSchema.shape);
		const closedPositionsIndex = keys.indexOf('closed_positions');
		const totalRealizedPnlUnavailableReasonIndex = keys.indexOf('total_realized_pnl_unavailable_reason');
		// 末尾からの相対位置では固定しない。後続の issue がさらに後ろへキーを足すと、「既存キーの後ろ」という主張と無関係に落ちる。
		expect(closedPositionsIndex).toBeGreaterThan(-1);
		expect(totalRealizedPnlUnavailableReasonIndex).toBeGreaterThan(-1);
		expect(closedPositionsIndex).toBeGreaterThan(totalRealizedPnlUnavailableReasonIndex);
	});

	it('ClosedPositionPnlSchema（要素）のキー順は asset, realized_pnl, priced/unpriced_deposit_count, realized_pnl_unavailable_reason', () => {
		expect(Object.keys(closedPositionShape())).toEqual([
			'asset',
			'realized_pnl',
			'priced_deposit_count',
			'unpriced_deposit_count',
			'realized_pnl_unavailable_reason',
		]);
	});
});

describe('売り切り銘柄の内訳 — description', () => {
	it('closed_positions は closed_position_realized_pnl との検算式を書いている', () => {
		const description = descriptionOf(AnalyzeMyPortfolioDataSchema.shape, 'closed_positions');
		expect(description).toContain('Σ closed_positions[].realized_pnl = closed_position_realized_pnl');
	});

	it('closed_positions は抑止時（closedSuppressed）に実額エントリを出さないことを closed_position_realized_pnl と揃えて書いている', () => {
		const description = descriptionOf(AnalyzeMyPortfolioDataSchema.shape, 'closed_positions');
		expect(description).toContain('**抑止時（closedSuppressed');
		expect(description).toContain('部分和を出さない既存方針をそのまま引き継ぐ');
	});

	/** #93 の検出エントリは抑止（closedSuppressed）と独立に動くので、closed_positions だけ undefined にならないことがある。その条件が description に書いてあることを固定する。 */
	it('closed_positions は #93 の検出エントリが抑止と独立に動くことを書いている', () => {
		const description = descriptionOf(AnalyzeMyPortfolioDataSchema.shape, 'closed_positions');
		expect(description).toContain('**#93 の検出エントリはこの抑止と独立に動く**');
		expect(description).toContain(
			'closed_position_realized_pnl / closed_position_asset_count が undefined の実行でも、検出エントリがあれば本配列自体は undefined にならない',
		);
	});

	it('closed_positions は closed_position_asset_count と対象が異なる（0 円の扱い）ことを書いている', () => {
		// 0 円の売り切り銘柄を含めるかどうかで件数と配列長が一致しないことがある（#92 仕様 2）。
		const description = descriptionOf(AnalyzeMyPortfolioDataSchema.shape, 'closed_positions');
		expect(description).toContain('**closed_position_asset_count とは対象が異なる**');
		expect(description).toContain('closed_positions.length が closed_position_asset_count を上回る');
		expect(description).toContain('issue #92 の発端そのもの');
	});

	it('closed_positions は並び順（realized_pnl 降順・asset 昇順）を書いている', () => {
		const description = descriptionOf(AnalyzeMyPortfolioDataSchema.shape, 'closed_positions');
		expect(description).toContain('realized_pnl 降順・同値は asset 昇順で決定的');
	});

	it('closed_positions は要素ごとの理由コード（realized_pnl_unavailable_reason）を参照していることを書いている', () => {
		const description = descriptionOf(AnalyzeMyPortfolioDataSchema.shape, 'closed_positions');
		expect(description).toContain('realized_pnl_unavailable_reason（#93）を参照');
	});

	it('realized_pnl_unavailable_reason（要素）は holdings 側との違い・検出の限界を書いている', () => {
		const description = descriptionOf(closedPositionShape(), 'realized_pnl_unavailable_reason');
		expect(description).toContain('realized_pnl / priced_deposit_count / unpriced_deposit_count はいずれも undefined');
		expect(description).toContain('holdings[].cost_basis_unavailable_reason と同じ enum を共有するが意味は異なる');
		expect(description).toContain('**断定はできない**');
		expect(description).toContain('**この検出にも限界がある**');
		expect(description).toContain(
			'販売所（即時売買）のみで売買を完結させた銘柄は入出金履歴にも約定履歴にも痕跡が残らない',
		);
		expect(description).toContain('closedSuppressed');
		expect(description).toContain('とは独立に動く');
	});

	it('realized_pnl_unavailable_reason（要素）は history_truncated にもなりうることを書いている', () => {
		const description = descriptionOf(closedPositionShape(), 'realized_pnl_unavailable_reason');
		expect(description).toContain('untracked_trade_suspected=');
		expect(description).toContain('history_truncated=');
		expect(description).toContain('tradedAssets が実際の取引所約定の部分集合でしかない');
	});

	it('realized_pnl_unavailable_reason（要素）は出庫がある銘柄を除外することとその代償を書いている', () => {
		const description = descriptionOf(closedPositionShape(), 'realized_pnl_unavailable_reason');
		expect(description).toContain('DONE の暗号資産出庫が 1 件でもある銘柄は対象から除外する');
		expect(description).toContain('出庫と販売所処分が同一銘柄に混在するケースは見逃す');
	});

	it('realized_pnl_unavailable_reason（要素）は入出金履歴が信頼できない実行では検出を行わないことを書いている', () => {
		const description = descriptionOf(closedPositionShape(), 'realized_pnl_unavailable_reason');
		expect(description).toContain('**入出金履歴の取得自体が信頼できない実行');
		expect(description).toContain('検出そのものを行わない');
	});

	it('closed_position_realized_pnl は closed_positions で検算できることを書いている', () => {
		const description = descriptionOf(AnalyzeMyPortfolioDataSchema.shape, 'closed_position_realized_pnl');
		expect(description).toContain('closed_positions で検算できる');
	});

	it('closed_position_asset_count は closed_positions.length と一致しないことがあると書いている', () => {
		const description = descriptionOf(AnalyzeMyPortfolioDataSchema.shape, 'closed_position_asset_count');
		expect(description).toContain('closed_positions.length とは一致しないことがある');
	});

	it('total_realized_pnl_unavailable_reason は closed_positions も undefined になることを書いている', () => {
		const description = descriptionOf(AnalyzeMyPortfolioDataSchema.shape, 'total_realized_pnl_unavailable_reason');
		expect(description).toContain(
			'closed_position_realized_pnl / closed_position_asset_count / closed_positions も undefined になる',
		);
	});

	it('realized_pnl（要素）は 0 円の銘柄も含むことを書いている', () => {
		const description = descriptionOf(closedPositionShape(), 'realized_pnl');
		expect(description).toContain('0 円の銘柄も含む');
	});

	it('priced_deposit_count / unpriced_deposit_count（要素）は holdings と同義であることを書いている', () => {
		const pricedDescription = descriptionOf(closedPositionShape(), 'priced_deposit_count');
		expect(pricedDescription).toContain('holdings[].priced_deposit_count と同義');
		expect(pricedDescription).toContain('0 件のときはキーごと省く');

		const unpricedDescription = descriptionOf(closedPositionShape(), 'unpriced_deposit_count');
		expect(unpricedDescription).toContain('holdings[].unpriced_deposit_count と同義');
		expect(unpricedDescription).toContain('0 件のときはキーごと省く');
		expect(unpricedDescription).toContain('#77 で認識済みの制約');
	});
});
