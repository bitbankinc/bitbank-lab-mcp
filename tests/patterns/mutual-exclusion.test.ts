/**
 * tests/patterns/mutual-exclusion.test.ts
 *
 * triple × H&S の型間排他（issue #218 Phase 2）の契約テスト。
 *
 * 検証する不変条件:
 *   1. 主構成点を 2 点以上共有する `triple_*` だけが落ちる（H&S 側は 1 件も落とさない）
 *   2. 共有 1 点以下では落とさない
 *   3. 主構成点は type ごとに定義が違う（triple は 3 点すべて / H&S は左肩・頭・右肩）。
 *      **形成中の経路は配列長が違う**ので位置決め打ちでは壊れる
 *   4. スコープ外（`double_*` / triangle 等）は素通し
 *   5. 落とした理由に「どの H&S と何点共有したか」が残る（決定性）
 *
 * エッジケースの優先順位（`.claude/rules/testing.md`）: 空配列 → 欠損 → 重複 → 単一要素 → 境界。
 * ここでの境界は**共有点数 1 / 2**（規則そのものの境界で、調整可能な閾値ではない）。
 */
import { describe, expect, it } from 'vitest';
import {
	excludeTriplesSharingHsMainPoints,
	mainPointIdxs,
	TRIPLE_HS_EXCLUSION_REASON,
} from '../../tools/patterns/mutual-exclusion.js';
import type { Pivot } from '../../tools/patterns/swing.js';
import type { DeduplicablePattern } from '../../tools/patterns/types.js';

const pivot = (idx: number, kind: Pivot['kind']): Pivot => ({ idx, price: 100 + idx, kind, extremePrice: 100 + idx });

/** `triple_top` = 3 山 / `triple_bottom` = 3 谷。 */
function triple(type: 'triple_top' | 'triple_bottom', idxs: number[]): DeduplicablePattern {
	const kind: Pivot['kind'] = type === 'triple_top' ? 'H' : 'L';
	return { type, confidence: 0.8, pivots: idxs.map((i) => pivot(i, kind)) };
}

/** 完成済み H&S = `H-L-H-L-H`（逆は `L-H-L-H-L`）の 5 点。主構成点は [0] [2] [4]。 */
function hs(type: 'head_and_shoulders' | 'inverse_head_and_shoulders', idxs: number[]): DeduplicablePattern {
	const main: Pivot['kind'] = type === 'head_and_shoulders' ? 'H' : 'L';
	const mid: Pivot['kind'] = main === 'H' ? 'L' : 'H';
	return { type, confidence: 0.7, pivots: idxs.map((i, n) => pivot(i, n % 2 === 0 ? main : mid)) };
}

describe('mainPointIdxs', () => {
	it('triple は 3 点すべてが主構成点', () => {
		expect(mainPointIdxs(triple('triple_bottom', [10, 20, 30]))).toEqual([10, 20, 30]);
	});

	it('H&S は左肩・頭・右肩の 3 点（ネックラインの定義点 [1] [3] は含めない）', () => {
		expect(mainPointIdxs(hs('head_and_shoulders', [1, 2, 3, 4, 5]))).toEqual([1, 3, 5]);
		expect(mainPointIdxs(hs('inverse_head_and_shoulders', [1, 2, 3, 4, 5]))).toEqual([1, 3, 5]);
	});

	it('形成中 H&S（4 点）でも主構成点 3 点を取れる — 位置決め打ちなら壊れるケース', () => {
		// `detect_hs.ts` の `formingHsForHead` が返す形: 左肩 H / 頭 H / 戻り谷 L / 暫定右肩 H。
		// `[0] [2] [4]` で取ると戻り谷（idx 30）と undefined を拾う。
		const forming: DeduplicablePattern = {
			type: 'head_and_shoulders',
			status: 'forming',
			pivots: [pivot(10, 'H'), pivot(20, 'H'), pivot(30, 'L'), pivot(40, 'H')],
		};
		expect(mainPointIdxs(forming)).toEqual([10, 20, 40]);
	});

	it('形成中 triple（2 点）でも取れる', () => {
		const forming: DeduplicablePattern = {
			type: 'triple_top',
			status: 'forming',
			pivots: [pivot(10, 'H'), pivot(20, 'H')],
		};
		expect(mainPointIdxs(forming)).toEqual([10, 20]);
	});

	it('昇順で返す（pivots の並びに依存しない）', () => {
		expect(mainPointIdxs(triple('triple_top', [30, 10, 20]))).toEqual([10, 20, 30]);
	});

	it('スコープ外の type / pivots 欠損 / 空配列は空を返す', () => {
		// `double_*` は**意図的にスコープ外**（Phase 1 が測っていない。モジュール冒頭）。
		expect(mainPointIdxs({ type: 'double_bottom', pivots: [pivot(1, 'L'), pivot(2, 'H'), pivot(3, 'L')] })).toEqual([]);
		expect(mainPointIdxs({ type: 'triangle_ascending', pivots: [pivot(1, 'H')] })).toEqual([]);
		expect(mainPointIdxs({ type: 'triple_top' })).toEqual([]);
		expect(mainPointIdxs({ type: 'triple_top', pivots: [] })).toEqual([]);
		expect(mainPointIdxs(undefined)).toEqual([]);
	});
});

describe('excludeTriplesSharingHsMainPoints', () => {
	it('空配列は空配列を返す', () => {
		expect(excludeTriplesSharingHsMainPoints([])).toEqual({ kept: [], excluded: [], hsCandidateCount: 0 });
	});

	it('H&S が 1 件も無ければ triple を落とさず、hsCandidateCount=0 で「比較できなかった」と申告する（#224 症状 1）', () => {
		const input = [triple('triple_bottom', [10, 20, 30]), triple('triple_top', [40, 50, 60])];
		const res = excludeTriplesSharingHsMainPoints(input);
		expect(res.kept).toEqual(input);
		expect(res.excluded).toHaveLength(0);
		// `excluded` が空なのは「比較して該当なし」ではなく「比較対象が無い」——ここで区別する。
		expect(res.hsCandidateCount).toBe(0);
	});

	it('H&S があれば hsCandidateCount に比較対象の件数が載る（該当 0 件でも 1 以上）', () => {
		const t = triple('triple_top', [219, 223, 232]);
		const h1 = hs('head_and_shoulders', [265, 272, 294, 313, 322]);
		const h2 = hs('head_and_shoulders', [204, 249, 294, 313, 318]);
		const res = excludeTriplesSharingHsMainPoints([t, h1, h2]);
		// 共有 0 点なので落ちないが、比較自体は 2 件の H&S に対して行われた
		expect(res.excluded).toHaveLength(0);
		expect(res.hsCandidateCount).toBe(2);
	});

	it('主構成点が取れない H&S（pivots 無し）は比較対象に数えない', () => {
		const t = triple('triple_top', [219, 223, 232]);
		const broken = { type: 'head_and_shoulders', pivots: [] } as unknown as DeduplicablePattern;
		const res = excludeTriplesSharingHsMainPoints([t, broken]);
		expect(res.kept).toEqual([t, broken]);
		expect(res.hsCandidateCount).toBe(0);
	});

	it('主構成点を 2 点共有していたら triple を落とし、H&S は残す', () => {
		// issue #218 の受け入れ条件と同じ形: triple 242-249-272 ↔ 逆 H&S 230-232-249-265-272
		// （主構成点 230 / 249 / 272）で 249・272 の 2 点を共有する。
		const t = triple('triple_bottom', [242, 249, 272]);
		const h = hs('inverse_head_and_shoulders', [230, 232, 249, 265, 272]);
		const res = excludeTriplesSharingHsMainPoints([t, h]);
		expect(res.kept).toEqual([h]);
		expect(res.excluded).toHaveLength(1);
		expect(res.hsCandidateCount).toBe(1);
		expect(res.excluded[0].triple).toBe(t);
		expect(res.excluded[0].tripleMainIdxs).toEqual([242, 249, 272]);
		expect(res.excluded[0].matches).toEqual([
			{ hsType: 'inverse_head_and_shoulders', hsMainIdxs: [230, 249, 272], sharedIdxs: [249, 272] },
		]);
	});

	it('3 点すべて共有していても落とす', () => {
		const t = triple('triple_bottom', [230, 249, 272]);
		const h = hs('inverse_head_and_shoulders', [230, 236, 249, 265, 272]);
		const res = excludeTriplesSharingHsMainPoints([t, h]);
		expect(res.kept).toEqual([h]);
		expect(res.excluded[0].matches[0].sharedIdxs).toEqual([230, 249, 272]);
	});

	it('共有が 1 点なら落とさない（境界: 1 / 2）', () => {
		const t = triple('triple_bottom', [77, 86, 100]);
		const h = hs('inverse_head_and_shoulders', [64, 92, 100, 118, 126]);
		const res = excludeTriplesSharingHsMainPoints([t, h]);
		expect(res.kept).toEqual([t, h]);
		expect(res.excluded).toHaveLength(0);
	});

	it('共有 0 点なら落とさない', () => {
		const t = triple('triple_top', [219, 223, 232]);
		const h = hs('head_and_shoulders', [265, 272, 294, 313, 322]);
		const res = excludeTriplesSharingHsMainPoints([t, h]);
		expect(res.kept).toEqual([t, h]);
	});

	it('ネックラインの定義点（H&S の [1] [3]）との一致は共有に数えない', () => {
		// triple 200-220-240 と H&S 100-200-300-240-400。位置で数えると 200 と 240 の 2 点だが、
		// **200 / 240 は H&S 側ではネックラインの定義点**なので主構成点の共有ではない。
		const t = triple('triple_top', [200, 220, 240]);
		const h = hs('head_and_shoulders', [100, 200, 300, 240, 400]);
		const res = excludeTriplesSharingHsMainPoints([t, h]);
		expect(res.kept).toEqual([t, h]);
	});

	it('複数の H&S と共有していたら全件を matches に載せる（決定性・入力順）', () => {
		const t = triple('triple_bottom', [10, 20, 30]);
		const h1 = hs('inverse_head_and_shoulders', [10, 15, 20, 25, 40]);
		const h2 = hs('inverse_head_and_shoulders', [20, 25, 30, 35, 50]);
		const res = excludeTriplesSharingHsMainPoints([h2, t, h1]);
		expect(res.kept).toEqual([h2, h1]);
		expect(res.excluded[0].matches.map((m) => m.sharedIdxs)).toEqual([
			[20, 30], // h2 が先（入力順）
			[10, 20],
		]);
	});

	it('スコープ外の type は素通しする（double / triangle / wedge）', () => {
		// **`double_*` は H&S と主構成点を 2 点共有していても落とさない**（未計測。別 issue）。
		const d: DeduplicablePattern = {
			type: 'double_bottom',
			pivots: [pivot(10, 'L'), pivot(15, 'H'), pivot(30, 'L')],
		};
		const w: DeduplicablePattern = { type: 'falling_wedge', pivots: [] };
		const h = hs('inverse_head_and_shoulders', [10, 12, 20, 25, 30]);
		const res = excludeTriplesSharingHsMainPoints([d, w, h]);
		expect(res.kept).toEqual([d, w, h]);
		expect(res.excluded).toHaveLength(0);
	});

	it('落とされなかったパターンの順序を保つ', () => {
		const a: DeduplicablePattern = { type: 'rising_wedge', pivots: [] };
		const t = triple('triple_bottom', [10, 20, 30]);
		const h = hs('inverse_head_and_shoulders', [10, 15, 20, 25, 40]);
		const b: DeduplicablePattern = { type: 'bull_flag', pivots: [] };
		expect(excludeTriplesSharingHsMainPoints([a, t, h, b]).kept).toEqual([a, h, b]);
	});

	it('pivots を持たない triple は落とせない（主構成点が読めないため）', () => {
		const t: DeduplicablePattern = { type: 'triple_bottom' };
		const h = hs('inverse_head_and_shoulders', [10, 15, 20, 25, 30]);
		expect(excludeTriplesSharingHsMainPoints([t, h]).kept).toEqual([t, h]);
	});

	it('理由コードは実装から読む（文字列の直書きを 2 箇所に散らさない）', () => {
		expect(TRIPLE_HS_EXCLUSION_REASON).toBe('excluded_by_hs_main_point_overlap');
	});
});
