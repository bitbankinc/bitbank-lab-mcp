/**
 * 売り切り銘柄の実現損益の銘柄別内訳（`closed_positions`）の契約テスト（#92 / #93）。
 *
 * `closed_position_realized_pnl` はループ内で銘柄ごとに算出した値を合計に畳んでおり、
 * 従来は畳んだ時点で銘柄別の値を捨てていた。合計値の変化がどの銘柄由来か出力から
 * 特定できず実口座検証が膠着したため、捨てずに `closed_positions` として出力する（#92）。
 * `structuredContent` を直読みする非 LLM クライアントにとって description が唯一の
 * 手掛かりなので、意味づけを人手のレビューに委ねず機械的に固定する
 * （`.claude/rules/tools.md`「規約はテストで機械的に固定する」）。
 *
 * #93 で `closed_positions` の用途が広がった。入庫はあるが約定履歴にも現在残高にも
 * 現れない銘柄（販売所取引などで API から不可視になった可能性がある銘柄）を、`realized_pnl`
 * を持たない検出専用の要素（`realized_pnl_unavailable_reason` 付き）として同じ配列に混在させる。
 * これにより #92 時点の「`cost_basis_unavailable_reason` に相当するフィールドは持たない」という
 * 決定が覆っているため、そちらのテストは #93 の新しい契約に合わせて更新している。
 *
 * 固定するのは 5 点。
 * 1. **新設キーは既存キーの後ろに宣言されている。** `z.object` の parse は宣言順で
 *    オブジェクトを組み直すため、宣言位置がそのまま wire のキー順になる。
 * 2. **closed_position_realized_pnl / closed_position_asset_count との対応関係が
 *    description に書いてある。** 合計との検算式（realized_pnl が定義されている要素のみが対象）、
 *    0 円の銘柄・#93 の検出エントリを含むぶん closed_position_asset_count と配列長が
 *    食い違いうること。
 * 3. **並び順（realized_pnl 降順・asset 昇順、検出エントリは末尾）が description に書いてある。**
 * 4. **算出条件（priced/unpriced_deposit_count）を holdings と同義として書いてある。**
 * 5. **#93 の検出専用フィールド（`realized_pnl_unavailable_reason`）の意味・出す条件・
 *    holdings 側の同名系フィールドとの違い・検出の限界が description に書いてある。**
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

	it('ClosedPositionPnlSchema（要素）のキー順は asset, realized_pnl, priced/unpriced_deposit_count, realized_pnl_unavailable_reason', () => {
		expect(Object.keys(closedPositionShape())).toEqual([
			'asset',
			'realized_pnl',
			'priced_deposit_count',
			'unpriced_deposit_count',
			// #93 で末尾に追加
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
		// 部分和を出さない既存方針の踏襲であることまで書く（issue #92 仕様 3）
		expect(description).toContain('部分和を出さない既存方針をそのまま引き継ぐ');
	});

	/**
	 * #93 で追加した契約: #93 の検出エントリ（realized_pnl_unavailable_reason 付き）は
	 * closedSuppressed と独立に動くため、closed_position_realized_pnl / closed_position_asset_count
	 * が undefined でも closed_positions 自体が undefined になるとは限らない。#92 時点の
	 * 「undefined の条件は 3 フィールドで共通」という単純な等式は #93 でもう成立しないため、
	 * その等式の代わりに新しい条件が description に書いてあることを固定する。
	 */
	it('closed_positions は #93 の検出エントリが抑止と独立に動くことを書いている', () => {
		const description = descriptionOf(AnalyzeMyPortfolioDataSchema.shape, 'closed_positions');
		expect(description).toContain('**#93 の検出エントリはこの抑止と独立に動く**');
		expect(description).toContain(
			'closed_position_realized_pnl / closed_position_asset_count が undefined の実行でも、検出エントリがあれば本配列自体は undefined にならない',
		);
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

	/**
	 * #93 で `closed_positions` に理由コード付きの検出エントリが追加された。#92 時点は
	 * 「cost_basis_unavailable_reason に相当するフィールドは持たない」だったので、その決定が
	 * 覆っていること・新フィールドの参照先が description に書いてあることを固定する。
	 */
	it('closed_positions は要素ごとの理由コード（realized_pnl_unavailable_reason）を参照していることを書いている', () => {
		const description = descriptionOf(AnalyzeMyPortfolioDataSchema.shape, 'closed_positions');
		expect(description).toContain('realized_pnl_unavailable_reason（#93）を参照');
	});

	it('realized_pnl_unavailable_reason（要素）は holdings 側との違い・検出の限界を書いている', () => {
		const description = descriptionOf(closedPositionShape(), 'realized_pnl_unavailable_reason');
		// 設定時に他の全フィールドが undefined になること
		expect(description).toContain('realized_pnl / priced_deposit_count / unpriced_deposit_count はいずれも undefined');
		// holdings[].cost_basis_unavailable_reason と同じ enum を共有するが意味が違う
		expect(description).toContain('holdings[].cost_basis_unavailable_reason と同じ enum を共有するが意味は異なる');
		// 断定できないこと（issue #93 の明示要求）
		expect(description).toContain('**断定はできない**');
		// 検出の限界（issue #93 で明記が必須とされている残存する穴）
		expect(description).toContain('**この検出にも限界がある**');
		expect(description).toContain(
			'販売所（即時売買）のみで売買を完結させた銘柄は入出金履歴にも約定履歴にも痕跡が残らない',
		);
		// closedSuppressed（#92 の抑止機構）と独立に動くこと
		expect(description).toContain('closedSuppressed');
		expect(description).toContain('とは独立に動く');
	});

	/**
	 * CodeRabbit review（PR #95）対応: 約定履歴が打ち切られていると tradedAssets が部分集合に
	 * なり、取引所で売買しただけの銘柄まで「約定に現れない」と誤検出しうる。本フィールドは
	 * untracked_trade_suspected 固定ではなく、確度が落ちる場合は history_truncated にも
	 * 倒れることを description に書いている。
	 */
	it('realized_pnl_unavailable_reason（要素）は history_truncated にもなりうることを書いている', () => {
		const description = descriptionOf(closedPositionShape(), 'realized_pnl_unavailable_reason');
		expect(description).toContain('untracked_trade_suspected=');
		expect(description).toContain('history_truncated=');
		expect(description).toContain('tradedAssets が実際の取引所約定の部分集合でしかない');
	});

	/**
	 * CodeRabbit review 対応時に発見した追加の誤検知パス（issue #93 の当初スコープには無かった）:
	 * 出庫だけで残高ゼロが完全に説明できる、販売所と無関係なありふれたケース（他ウォレットへの
	 * 送付など）を除外している。この保守的な判断（量を見ず「出庫が 1 件でもあれば除外」）と、
	 * その代償（出庫と販売所処分の混在は見逃す）を description に書いている。
	 */
	it('realized_pnl_unavailable_reason（要素）は出庫がある銘柄を除外することとその代償を書いている', () => {
		const description = descriptionOf(closedPositionShape(), 'realized_pnl_unavailable_reason');
		expect(description).toContain('DONE の暗号資産出庫が 1 件でもある銘柄は対象から除外する');
		expect(description).toContain('出庫と販売所処分が同一銘柄に混在するケースは見逃す');
	});

	/**
	 * CodeRabbit review（PR #95）で指摘: 出庫による除外判定は dw.withdrawals の完全性が前提。
	 * 入出金履歴の取得自体が信頼できない実行では、除外すべき出庫を見落として誤検出しうるため、
	 * 検出そのものを行わないことを description に書いている。
	 */
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
		// 売り切り銘柄には holdings 以外に置き場が無い制約（#77 で認識済み）を踏襲している
		expect(unpricedDescription).toContain('#77 で認識済みの制約');
	});
});
