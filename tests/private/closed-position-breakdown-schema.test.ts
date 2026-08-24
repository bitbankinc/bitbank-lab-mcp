/**
 * 売り切り銘柄の実現損益の銘柄別内訳（`closed_positions`）の契約テスト（#92）。
 *
 * `closed_position_realized_pnl` はループ内で銘柄ごとに算出した値を合計に畳んでおり、
 * 従来は畳んだ時点で銘柄別の値を捨てていた。合計値の変化がどの銘柄由来か出力から
 * 特定できず実口座検証が膠着したため、捨てずに `closed_positions` として出力する。
 * `structuredContent` を直読みする非 LLM クライアントにとって description が唯一の
 * 手掛かりなので、意味づけを人手のレビューに委ねず機械的に固定する
 * （`.claude/rules/tools.md`「規約はテストで機械的に固定する」）。
 *
 * 固定するのは 4 点。
 * 1. **新設キーは既存キーの後ろに宣言されている。** `z.object` の parse は宣言順で
 *    オブジェクトを組み直すため、宣言位置がそのまま wire のキー順になる。
 * 2. **closed_position_realized_pnl / closed_position_asset_count との対応関係が
 *    description に書いてある。** 合計との検算式、抑止時に揃って undefined になること、
 *    0 円の銘柄を含むぶん closed_position_asset_count と配列長が食い違いうること。
 * 3. **並び順（realized_pnl 降順・asset 昇順）が description に書いてある。**
 * 4. **算出条件（priced/unpriced_deposit_count）を holdings と同義として書いてあり、
 *    cost_basis_unavailable_reason に相当するフィールドを持たない理由も書いてある。**
 */
import { describe, expect, it } from 'vitest';
import { AnalyzeMyPortfolioDataSchema } from '../../src/private/schemas.js';

type Described = { description?: string };

/** `closed_positions[]` の要素スキーマ（`ClosedPositionPnlSchema`）の shape */
function closedPositionShape(): Record<string, Described> {
	const closedPositions = AnalyzeMyPortfolioDataSchema.shape.closed_positions as unknown as {
		unwrap: () => { element: { shape: Record<string, Described> } };
	};
	return closedPositions.unwrap().element.shape;
}

/** shape から description を取り出す。無ければ落とす（description 前提のテストが黙って通らないように） */
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
		// 末尾からの相対位置では固定しない——後続の issue がさらに後ろへキーを足すと
		// 「既存キーの後ろ」という本来の主張と無関係に落ちるため（#77/#87 と同じ理由）。
		expect(closedPositionsIndex).toBeGreaterThan(-1);
		expect(totalRealizedPnlUnavailableReasonIndex).toBeGreaterThan(-1);
		expect(closedPositionsIndex).toBeGreaterThan(totalRealizedPnlUnavailableReasonIndex);
	});

	it('ClosedPositionPnlSchema（要素）のキー順は asset, realized_pnl, priced/unpriced_deposit_count', () => {
		expect(Object.keys(closedPositionShape())).toEqual([
			'asset',
			'realized_pnl',
			'priced_deposit_count',
			'unpriced_deposit_count',
		]);
	});
});

describe('売り切り銘柄の内訳 — description', () => {
	it('closed_positions は closed_position_realized_pnl との検算式を書いている', () => {
		const description = descriptionOf(AnalyzeMyPortfolioDataSchema.shape, 'closed_positions');
		expect(description).toContain('Σ closed_positions[].realized_pnl = closed_position_realized_pnl');
	});

	it('closed_positions は抑止時に undefined になる条件を closed_position_realized_pnl と揃えて書いている', () => {
		const description = descriptionOf(AnalyzeMyPortfolioDataSchema.shape, 'closed_positions');
		expect(description).toContain(
			'undefined の条件も closed_position_realized_pnl / closed_position_asset_count と同一',
		);
		expect(description).toContain('**抑止時は本配列も undefined**');
		// 部分和を出さない既存方針の踏襲であることまで書く（issue #92 仕様 3）
		expect(description).toContain('部分和を出さない既存方針をそのまま引き継ぐ');
	});

	it('closed_positions は closed_position_asset_count と対象が異なる（0 円の扱い）ことを書いている', () => {
		// 本 issue の核。0 円の売り切り銘柄を含めるかどうかで件数と配列長が一致しない可能性がある
		// （issue #92 仕様 2）ことと、含めると決めた理由を書く。
		const description = descriptionOf(AnalyzeMyPortfolioDataSchema.shape, 'closed_positions');
		expect(description).toContain('**closed_position_asset_count とは対象が異なる**');
		expect(description).toContain('closed_positions.length が closed_position_asset_count を上回る');
		expect(description).toContain('issue #92 の発端そのもの');
	});

	it('closed_positions は並び順（realized_pnl 降順・asset 昇順）を書いている', () => {
		const description = descriptionOf(AnalyzeMyPortfolioDataSchema.shape, 'closed_positions');
		expect(description).toContain('realized_pnl 降順・同値は asset 昇順で決定的');
	});

	it('closed_positions は cost_basis_unavailable_reason に相当するフィールドを持たない理由を書いている', () => {
		const description = descriptionOf(AnalyzeMyPortfolioDataSchema.shape, 'closed_positions');
		expect(description).toContain('cost_basis_unavailable_reason に相当するフィールドは持たない');
		expect(description).toContain('理由コードを持つ余地が無い');
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
		// 売り切り銘柄には holdings 以外に置き場が無い制約（#77 で認識済み）を踏襲している
		expect(unpricedDescription).toContain('#77 で認識済みの制約');
	});
});
