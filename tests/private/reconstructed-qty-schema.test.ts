/**
 * 復元数量と許容誤差（`reconstructed_qty` / `qty_invariant_tolerance`）の契約テスト（#87）。
 *
 * このフィールドの存在理由は **`cost_basis_reliable` の判定を消費者が検算できること**。
 * `structuredContent` を直読みする非 LLM クライアントにとって description が唯一の手掛かりなので、
 * 検算に要る式・出す条件・値の性質を人手のレビューに委ねず機械的に固定する
 * （`.claude/rules/tools.md`「規約はテストで機械的に固定する」）。
 *
 * 固定するのは 4 点。
 * 1. **新設キーは既存キーの後ろに宣言されている。** `z.object` の parse は宣言順で
 *    オブジェクトを組み直すため、宣言位置がそのまま wire のキー順になる。
 * 2. **許容誤差の式が書いてある。** これが無いと消費者は判定を再現できない
 *    （`amount_precision` は出力に含めていないので、式だけでも足りず値を出している）。
 * 3. **復元数量が実残高とは別物であること、差の読み方が書いてある。**
 * 4. **出す条件（抑止時は出す / JPY・`include_pnl=false` では出さない）と、
 *    `cost_basis_reliable=false` でも本判定で落ちたとは限らないことが書いてある。**
 */
import { describe, expect, it } from 'vitest';
import { AnalyzeMyPortfolioDataSchema } from '../../src/private/schemas.js';

type Described = { description?: string };

/** `holdings[]` の要素スキーマ（`HoldingPnlSchema`）の shape */
function holdingShape(): Record<string, Described> {
	const holdings = AnalyzeMyPortfolioDataSchema.shape.holdings as unknown as {
		element: { shape: Record<string, Described> };
	};
	return holdings.element.shape;
}

/** shape から description を取り出す。無ければ落とす（description 前提のテストが黙って通らないように） */
function descriptionOf(key: string): string {
	const description = holdingShape()[key]?.description;
	if (description == null) throw new Error(`description が無い: ${key}`);
	return description;
}

describe('復元数量と許容誤差 — キー順', () => {
	it('新設 2 キーは既存キーの後ろに宣言されている', () => {
		const keys = Object.keys(holdingShape());
		// #87 の 2 キーの後ろに #89 の 2 キーが足された（新設は常に末尾）
		expect(keys.slice(-4)).toEqual([
			'reconstructed_qty',
			'qty_invariant_tolerance',
			'qty_clamp_count',
			'qty_clamp_absorbed_qty',
		]);
		// 既存キーの並びは崩さない（#69 / #72 / #77 と同じ理由: JSON を中間から変えない）
		expect(keys.slice(0, -4)).toEqual([
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
			'priced_deposit_count',
			'unpriced_deposit_count',
		]);
	});
});

describe('復元数量と許容誤差 — description', () => {
	it('reconstructed_qty は実残高（amount）と別物であることを書いている', () => {
		const description = descriptionOf('reconstructed_qty');
		expect(description).toContain('**実残高（amount）とは別物**');
		expect(description).toContain('履歴から積み上げた理論値');
	});

	it('reconstructed_qty は許容誤差の式と判定式を書いている', () => {
		// 式が無いと消費者は cost_basis_reliable を検算できない（本 issue の核）
		const description = descriptionOf('reconstructed_qty');
		expect(description).toContain('max(10^-amount_precision × 5, |実残高| × 0.1%)');
		expect(description).toContain('|Number(amount) − reconstructed_qty| ≤ qty_invariant_tolerance');
	});

	it('reconstructed_qty は差の求め方（引き算）と許容誤差との比を書いている', () => {
		// 差そのものはフィールドにしていないので、その代わりに読み方を書く（issue #87 仕様 3）
		const description = descriptionOf('reconstructed_qty');
		expect(description).toContain('差そのものは別フィールドにしていない');
		expect(description).toContain('amount との引き算で得られ');
		expect(description).toContain('qty_invariant_tolerance が 1 以下');
	});

	it('reconstructed_qty は差がゼロでないこと自体は異常ではないと書いている', () => {
		// 端数処理・ダスト由来の差を「バグ」と読ませない。ただし原価は差の分だけ不完全
		const description = descriptionOf('reconstructed_qty');
		expect(description).toContain('**差がゼロでないこと自体は異常ではない**');
		expect(description).toContain('許容誤差内でも差の分だけ cost_basis は不完全');
		// API に現れない取引（販売所など）の推定が、差を出す最大の動機
		expect(description).toContain('API に現れない取引');
	});

	it('reconstructed_qty は丸めていないこと・型が数値である理由を書いている', () => {
		const description = descriptionOf('reconstructed_qty');
		expect(description).toContain('**丸めていない**');
		expect(description).toContain('amount が文字列なのに本値が数値なのは');
	});

	it('reconstructed_qty は 0 でもキーを落とさないと書いている', () => {
		// 件数フィールド（priced/unpriced_deposit_count）の 0 省略とは別方針なので明記する
		const description = descriptionOf('reconstructed_qty');
		expect(description).toContain('0 のときもキーを落とさない');
		expect(description).toContain('件数フィールドの 0 省略とは扱いが違う');
	});

	it('reconstructed_qty は出す条件（抑止時は出す / 対象外は省く / 売り切り銘柄）を書いている', () => {
		const description = descriptionOf('reconstructed_qty');
		expect(description).toContain('原価計算の対象外（JPY / include_pnl=false）では省略');
		expect(description).toContain('**原価を抑止した銘柄（cost_basis_unavailable_reason あり）では出す**');
		// 売り切り銘柄は holdings に置き場が無い（#77 と同じ制約）。こちらは申告すべき判定結果が
		// 無いので警告行を足していない、という判断まで書く
		expect(description).toContain('売り切り銘柄は holdings に載らないため本値も出ない');
		expect(description).toContain('警告行も足していない');
	});

	it('qty_invariant_tolerance は式と、値として出す理由を書いている', () => {
		const description = descriptionOf('qty_invariant_tolerance');
		expect(description).toContain('max(10^-amount_precision × 5, |Number(amount)| × 0.1%)');
		expect(description).toContain('|Number(amount) − reconstructed_qty| ≤ 本値');
		// amount_precision は出力に無いので、許容誤差は消費者側で再現できない
		expect(description).toContain(
			'**amount_precision を出力に含めていないため、本値が無いと消費者は許容誤差を再現できない**',
		);
	});

	it('qty_invariant_tolerance は「false = 数量不変条件で落ちた」ではないと書いている', () => {
		// 数量不変条件より前に抑止する経路があるので、検算が true でも false が出る
		const description = descriptionOf('qty_invariant_tolerance');
		expect(description).toContain('**cost_basis_reliable=false の銘柄がすべて本判定で落ちたわけではない**');
		for (const reason of [
			'dw_fetch_failed',
			'dw_history_incomplete',
			'deposit_price_fetch_failed',
			'deposit_price_chunk_truncated',
		]) {
			expect(description).toContain(reason);
		}
	});

	it('cost_basis_reliable は検算に使う 2 フィールドを名指ししている', () => {
		// 判定結果から入力への導線。これが無いと消費者は新設フィールドに気づけない
		const description = descriptionOf('cost_basis_reliable');
		expect(description).toContain('reconstructed_qty');
		expect(description).toContain('qty_invariant_tolerance');
		expect(description).toContain('出力だけで検算できる');
	});
});
