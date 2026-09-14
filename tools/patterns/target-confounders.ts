/**
 * patterns/target-confounders.ts — ターゲット到達の交絡申告（issue #288 Phase 2）
 *
 * ## 何を申告するのか
 *
 * `targetReached` / `targetReachedPct` は「ブレイク後 60 本の値動きが target に届いたか」しか
 * 見ていない。**その 60 本の間に別のパターンがブレイクしていれば、届いた理由をこのパターンに
 * 帰属させられない。** Phase 1 の実測では走査窓に他パターンのブレイクが入る実体が **94.7%**
 * （`invalid` / `expired` 込みなら 98.5%）で、**素朴に「他ブレイクがあった」と書くと全件に付く**——
 * 全件に付く申告は申告になっていない。
 *
 * そこで**付ける条件を 2 つに絞る**。絞り方が両者で違うのは、到達側と未到達側で
 * 「帰属を切る」の意味が違うから:
 *
 * | 出力フィールド | 対象 | 区間 | 方向 |
 * |---|---|---|---|
 * | `targetOtherBreakoutBeforeReach` | **到達した**パターン | `(自分のブレイク, 自分の初到達)` の**開区間** | **問わない** |
 * | `targetOppositeBreakoutInWindow` | **未到達の**パターン | `(自分のブレイク, 自分のブレイク + targetScanBars]` | **逆方向のみ** |
 *
 * - **到達側で方向を問わないのは、同方向の後続パターン経由でも帰属が切れるから。**
 *   Phase 1 の予備監査で 20 本超の到達 6 件のうち **4 件が同方向**だった。「逆方向だけ」に
 *   絞ると、この 4 件が「自力で届いた」と読まれる。
 * - **未到達側を逆方向に限るのは、同方向まで含めると 94.7% に付くから。** 逆方向に絞れば
 *   Phase 1 の実測で母集団の 44.7%（未到達だけなら 47.6%）まで落ちる。
 *   **「逆方向へ行ったから届かなかった」とまでは言っていない**——順序は測っていない。
 *   言えるのは「同じ走査窓の中で反対向きの構造も成立していた」まで。
 *
 * ## 基準集合は **accepted のみ**（`includeInvalid: true` でも変えない）
 *
 * 「他パターンのブレイク」として数える集合は、`data.patterns` に載るもののうち
 * `status` が `invalid` / `expired` / `forming` / `near_completion` **でない**ものに固定する。
 * `includeInvalid: true` で `invalid` が出力に混ざる呼び出しでも基準集合は動かさない——
 * 動かすと、同じ値動きに対して「他ブレイクあり」の申告が呼び出しオプション次第で変わる。
 * `invalid` は「期待と逆方向に抜けた」形なので、それを他パターンのブレイクとして数えると
 * 交絡の件数が Phase 1 実測の 94.7% → 98.5% 側に跳ね、絞り込みの意味が消える。
 *
 * **自分自身は数えない。** 同じオブジェクトを参照で除く（`breakoutBarIndex` が同じ別実体は
 * 数える——同じ足で別の構造が抜けていれば、それは帰属を切る事実そのもの）。
 *
 * **`patterns`（種別フィルタ）で絞ると基準集合も絞られる。** 検出器は `want` を見て出力を
 * 絞るので、`patterns: ['triangle']` の呼び出しではウェッジや H&S のブレイクがそもそも
 * 存在せず、交絡として数えられない。**これは定義どおりの振る舞い**（「この呼び出しが返した
 * 集合の中に他のブレイクがあったか」）だが、**申告が呼び出し方で変わる唯一の軸**なので
 * `docs/tools.md` に明記してあり、`tests/detect_patterns_debug.test.ts` が仕様として固定している。
 * `includeInvalid` の方は上のとおり**基準集合を動かさない**——こちらは同じ検出結果に対する
 * 出力の絞り方の違いでしかなく、動かすと同じ値動きへの申告が揺れるため。
 *
 * ## 置く位置
 *
 * `globalDedup` と triple × H&S の型間排他の**後**（= `data.patterns` に載る集合が確定した後）。
 * 先に置くと、後の段で消えるパターンを他ブレイクとして数えてしまう。
 */

/**
 * 交絡として申告する 1 件。**本数はどれも自分のブレイク足を 0 本目とした相対値。**
 *
 * **単一ソースは `src/schema/patterns.ts` の `TargetBreakoutConfounderSchema`**（Zod）で、
 * ここは再エクスポートしているだけ。TypeScript の形を別に持つと、型上は正しい値を返しても
 * Zod 側の宣言とずれて `parse()` が黙って剥がす / 落とす——`TargetReachOmissionReason` が
 * 同じ理由で Zod から導出されている（#155 / #160 / #184 / #189 / #199 の再発防止）。
 * 実行時の依存は `src/schema/patterns.ts` → `target-reach.ts`（閾値 3 定数）の一方向のままで、
 * 逆向きは `import type` のみ（出力から消えるので循環しない）。
 */
export type { TargetBreakoutConfounder } from '../../src/schema/patterns.js';

// 内部で値を組み立てるためにローカル名でも参照する（上の re-export は公開用）。
import type { TargetBreakoutConfounder as Confounder } from '../../src/schema/patterns.js';

/**
 * 交絡の判定に要る最小のかたち。`PatternEntry` / `DeduplicablePattern` に依存しないのは、
 * 検出器が積んだ生のオブジェクトをそのまま受けるため（フィールドは後から注入されている）。
 */
export interface TargetConfoundablePattern {
	type?: unknown;
	status?: unknown;
	breakoutBarIndex?: unknown;
	breakoutDirection?: unknown;
	targetFirstReachBars?: unknown;
	targetScanBars?: unknown;
	targetOtherBreakoutBeforeReach?: Confounder[];
	targetOppositeBreakoutInWindow?: Confounder[];
}

/**
 * 基準集合に入る `status`。
 *
 * **ライフサイクル絞り込み（`tools/detect_patterns.ts`）の `isCompleted` と同じ判定にしてある**——
 * `status` 未設定は完成済み扱いという既存契約も含めて写す。ここだけ別の分類にすると、
 * 「出力には居るのに他ブレイクとして数えられない」パターンが静かに生まれる。
 */
function isAcceptedForConfounding(p: TargetConfoundablePattern): boolean {
	const status = typeof p.status === 'string' ? p.status : '';
	return status === 'completed' || status === '';
}

interface BreakoutRef {
	source: TargetConfoundablePattern;
	type: Confounder['type'];
	direction: 'up' | 'down';
	idx: number;
}

function toBreakoutRef(p: TargetConfoundablePattern): BreakoutRef | null {
	const idx = Number(p.breakoutBarIndex);
	if (!Number.isInteger(idx)) return null;
	const direction = p.breakoutDirection;
	if (direction !== 'up' && direction !== 'down') return null;
	// **キャストが要るのは `p.type` を `unknown` で受けているから**（検出器が積んだ生の
	// オブジェクトをそのまま受ける形。`TargetConfoundablePattern` の docstring を参照）。
	// 値そのものは `DetectedPatternSchema.type`（= `PatternTypeEnum`）を通る側なので列挙外には
	// ならず、読み取れなかった場合だけ防御分岐の `'unknown'` に落ちる。**万一列挙外が来たら
	// `DetectPatternsOutputSchema.parse()` が落として黙って通さない**——ここで `string` のまま
	// 持つと、その検査が効かなくなる。
	const type = (typeof p.type === 'string' && p.type ? p.type : 'unknown') as Confounder['type'];
	return { source: p, type, direction, idx };
}

/**
 * `patterns` を走査して交絡フィールドを**その場で注入**する（additive。既存キーは触らない）。
 *
 * 空配列は**キーごと出さない**——`structuredContent` に `[]` を置くと「調べた結果 0 件」と
 * 「そもそも対象外」が区別できなくなるうえ、既存の target 系フィールドの畳み方
 * （`undefined` はキーごと落とす）と揃わない。
 *
 * 戻り値は受け取った配列そのもの（呼び出し側で代入を続けられるようにするため）。
 */
export function annotateTargetBreakoutConfounders<T extends TargetConfoundablePattern>(patterns: T[]): T[] {
	if (!Array.isArray(patterns) || patterns.length === 0) return patterns;

	const accepted = patterns.filter(isAcceptedForConfounding);
	const refs = accepted.map(toBreakoutRef).filter((r): r is BreakoutRef => r !== null);
	if (refs.length === 0) return patterns;

	for (const p of accepted) {
		const self = toBreakoutRef(p);
		if (!self) continue;

		const firstReach = Number(p.targetFirstReachBars);
		if (Number.isInteger(firstReach)) {
			// 到達側: `(ブレイク, 初到達)` の**開区間**。初到達の足そのもので抜けた他パターンは
			// 数えない——同じ足なら「先に起きた」と言えないため。
			const hits = collect(refs, self, (r) => r.idx > self.idx && r.idx < self.idx + firstReach);
			if (hits.length) p.targetOtherBreakoutBeforeReach = hits;
			continue;
		}

		const scanBars = Number(p.targetScanBars);
		if (!Number.isInteger(scanBars)) continue;
		// 未到達側: 走査窓 `(ブレイク, ブレイク + targetScanBars]` の**逆方向のみ**。
		// 右端を閉じるのは、走査した最後の足のブレイクも窓の中の事実だから。
		const hits = collect(
			refs,
			self,
			(r) => r.direction !== self.direction && r.idx > self.idx && r.idx <= self.idx + scanBars,
		);
		if (hits.length) p.targetOppositeBreakoutInWindow = hits;
	}

	return patterns;
}

function collect(refs: readonly BreakoutRef[], self: BreakoutRef, keep: (r: BreakoutRef) => boolean): Confounder[] {
	return (
		refs
			.filter((r) => r.source !== self.source && keep(r))
			.map((r) => ({ type: r.type, direction: r.direction, barsAfterBreakout: r.idx - self.idx }))
			// 並びを本数 → 種別で固定する。`rankPatterns` の並び順に引きずられると、
			// 同じ入力でも content の文言が変わってしまう。
			.sort((a, b) => a.barsAfterBreakout - b.barsAfterBreakout || a.type.localeCompare(b.type))
	);
}
