/**
 * tests/patterns/target-confounders.test.ts
 *
 * ターゲット到達の交絡申告（`tools/patterns/target-confounders.ts`。issue #288 Phase 2）。
 *
 * **区間と方向の定義をここで固定する。** Phase 1 の実測では走査窓 (0, 60] に他パターンの
 * ブレイクがある実体が 94.7% あり、**素朴に出すと全件に付いて申告にならない**ので、
 * 到達側と未到達側で絞り方を変えてある。絞り方を緩めると静かに全件に付く方向へ戻るため、
 * 「付く」だけでなく**「付かない」側も同じ数だけ固定する。**
 *
 * 合成 fixture を使うのは、実データでは 4 条件（到達前 / 到達後 / 未到達×逆方向 /
 * 未到達×同方向のみ）を同じ系列に揃えられないため。実データ側の回帰は
 * `tests/detect_patterns_data_patterns_regression.test.ts`（ベースライン）と
 * `tests/patterns/target-reach-content-btcjpy.test.ts`（content の行）が持つ。
 */
import { describe, expect, it } from 'vitest';
import {
	annotateTargetBreakoutConfounders,
	type TargetConfoundablePattern,
} from '../../tools/patterns/target-confounders.js';

type Entry = TargetConfoundablePattern & Record<string, unknown>;

/** 到達したパターン 1 件。`firstReach` はブレイク足を 0 本目とした初到達の本数。 */
function reached(type: string, idx: number, direction: 'up' | 'down', firstReach: number): Entry {
	return {
		type,
		status: 'completed',
		breakoutBarIndex: idx,
		breakoutDirection: direction,
		targetFirstReachBars: firstReach,
		targetScanBars: 60,
		targetScanComplete: true,
	};
}

/** 未到達のパターン 1 件。`scanBars` は実際に走査した本数。 */
function unreached(type: string, idx: number, direction: 'up' | 'down', scanBars = 60): Entry {
	return {
		type,
		status: 'completed',
		breakoutBarIndex: idx,
		breakoutDirection: direction,
		targetScanBars: scanBars,
		targetScanComplete: scanBars === 60,
	};
}

const beforeReach = (p: Entry) => p.targetOtherBreakoutBeforeReach;
const oppositeInWindow = (p: Entry) => p.targetOppositeBreakoutInWindow;

describe('annotateTargetBreakoutConfounders: 到達側（開区間・方向不問）', () => {
	it('到達前に**同方向**の他ブレイクがあれば付く（同方向を見落とさない）', () => {
		// Phase 1 の予備監査で 20 本超の到達 6 件のうち 4 件が同方向だった。逆方向だけに絞ると
		// それらが「自力で届いた」と読まれるので、到達側は方向を問わない。
		const self = reached('triangle_ascending', 100, 'up', 20);
		const other = reached('falling_wedge', 110, 'up', 5);
		annotateTargetBreakoutConfounders([self, other]);
		expect(beforeReach(self)).toEqual([{ type: 'falling_wedge', direction: 'up', barsAfterBreakout: 10 }]);
	});

	it('到達前に逆方向の他ブレイクがあっても付く', () => {
		const self = reached('triangle_ascending', 100, 'up', 20);
		const other = unreached('rising_wedge', 105, 'down');
		annotateTargetBreakoutConfounders([self, other]);
		expect(beforeReach(self)).toEqual([{ type: 'rising_wedge', direction: 'down', barsAfterBreakout: 5 }]);
	});

	it('**到達後**の他ブレイクは付かない（開区間の右端）', () => {
		const self = reached('triangle_ascending', 100, 'up', 20);
		const other = reached('falling_wedge', 130, 'up', 2);
		annotateTargetBreakoutConfounders([self, other]);
		expect(beforeReach(self)).toBeUndefined();
	});

	it('初到達の足そのもので抜けた他パターンは数えない（開区間は右端を含まない）', () => {
		const self = reached('triangle_ascending', 100, 'up', 20);
		const onTheEdge = reached('falling_wedge', 120, 'up', 1);
		annotateTargetBreakoutConfounders([self, onTheEdge]);
		expect(beforeReach(self)).toBeUndefined();
	});

	it('自分のブレイク足と同じ足の他パターンは数えない（左端も開区間）', () => {
		const self = reached('triangle_ascending', 100, 'up', 20);
		const sameBar = reached('falling_wedge', 100, 'up', 3);
		annotateTargetBreakoutConfounders([self, sameBar]);
		expect(beforeReach(self)).toBeUndefined();
	});

	it('ブレイク足自身で到達（firstReach=0）なら区間が空なので付かない', () => {
		const self = reached('inverse_head_and_shoulders', 100, 'up', 0);
		const other = reached('falling_wedge', 100, 'up', 0);
		annotateTargetBreakoutConfounders([self, other]);
		expect(beforeReach(self)).toBeUndefined();
	});

	it('複数件は本数の昇順で並ぶ（入力順に引きずられない）', () => {
		const self = reached('triangle_ascending', 100, 'up', 50);
		const far = reached('rising_wedge', 137, 'down', 1);
		const near = reached('inverse_head_and_shoulders', 103, 'up', 1);
		annotateTargetBreakoutConfounders([self, far, near]);
		expect(beforeReach(self)).toEqual([
			{ type: 'inverse_head_and_shoulders', direction: 'up', barsAfterBreakout: 3 },
			{ type: 'rising_wedge', direction: 'down', barsAfterBreakout: 37 },
		]);
	});

	it('到達したパターンには未到達側のキーを付けない', () => {
		const self = reached('triangle_ascending', 100, 'up', 20);
		const other = unreached('rising_wedge', 105, 'down');
		annotateTargetBreakoutConfounders([self, other]);
		expect(oppositeInWindow(self)).toBeUndefined();
	});
});

describe('annotateTargetBreakoutConfounders: 未到達側（走査窓・逆方向のみ）', () => {
	it('走査窓に逆方向のブレイクがあれば付く', () => {
		const self = unreached('rising_wedge', 100, 'down');
		const other = reached('triangle_ascending', 128, 'up', 2);
		annotateTargetBreakoutConfounders([self, other]);
		expect(oppositeInWindow(self)).toEqual([{ type: 'triangle_ascending', direction: 'up', barsAfterBreakout: 28 }]);
	});

	it('**同方向だけ**なら付かない（素朴に出すと 94.7% に付くため）', () => {
		const self = unreached('rising_wedge', 100, 'down');
		const sameDir = unreached('triangle_descending', 128, 'down');
		annotateTargetBreakoutConfounders([self, sameDir]);
		expect(oppositeInWindow(self)).toBeUndefined();
	});

	it('走査窓の右端ちょうどは含む（閉区間）', () => {
		const self = unreached('rising_wedge', 100, 'down', 25);
		const onTheEdge = reached('triangle_ascending', 125, 'up', 1);
		annotateTargetBreakoutConfounders([self, onTheEdge]);
		expect(oppositeInWindow(self)).toEqual([{ type: 'triangle_ascending', direction: 'up', barsAfterBreakout: 25 }]);
	});

	it('走査窓の外（1 本先）は含まない', () => {
		const self = unreached('rising_wedge', 100, 'down', 25);
		const outside = reached('triangle_ascending', 126, 'up', 1);
		annotateTargetBreakoutConfounders([self, outside]);
		expect(oppositeInWindow(self)).toBeUndefined();
	});

	it('打ち切り（走査中）でも実際に走査した本数までで判定する', () => {
		// `targetScanBars` が 10 なら、窓は (100, 110]。上限 60 では判定しない。
		const self = unreached('rising_wedge', 100, 'down', 10);
		const inside = reached('triangle_ascending', 108, 'up', 1);
		const outside = reached('falling_wedge', 140, 'up', 1);
		annotateTargetBreakoutConfounders([self, inside, outside]);
		expect(oppositeInWindow(self)).toEqual([{ type: 'triangle_ascending', direction: 'up', barsAfterBreakout: 8 }]);
	});

	it('未到達のパターンには到達側のキーを付けない', () => {
		const self = unreached('rising_wedge', 100, 'down');
		const other = reached('triangle_ascending', 128, 'up', 2);
		annotateTargetBreakoutConfounders([self, other]);
		expect(beforeReach(self)).toBeUndefined();
	});
});

describe('annotateTargetBreakoutConfounders: 基準集合は accepted のみ', () => {
	it.each([
		'invalid',
		'expired',
		'forming',
		'near_completion',
	])('status=%s の他パターンは他ブレイクとして数えない', (status) => {
		const self = reached('triangle_ascending', 100, 'up', 20);
		const other: Entry = { ...reached('falling_wedge', 110, 'up', 5), status };
		annotateTargetBreakoutConfounders([self, other]);
		expect(beforeReach(self)).toBeUndefined();
	});

	it('accepted でない自分自身には何も付けない', () => {
		// `includeInvalid: true` で出力に混ざる `invalid` にも、交絡キーは付かない。
		const self: Entry = { ...reached('triangle_ascending', 100, 'up', 20), status: 'invalid' };
		const other = reached('falling_wedge', 110, 'up', 5);
		annotateTargetBreakoutConfounders([self, other]);
		expect(beforeReach(self)).toBeUndefined();
		expect(oppositeInWindow(self)).toBeUndefined();
	});

	it('status 未設定は完成済み扱い（ライフサイクル絞り込みと同じ判定）', () => {
		const self = reached('triangle_ascending', 100, 'up', 20);
		const other: Entry = { ...reached('falling_wedge', 110, 'up', 5) };
		other.status = undefined;
		annotateTargetBreakoutConfounders([self, other]);
		expect(beforeReach(self)).toEqual([{ type: 'falling_wedge', direction: 'up', barsAfterBreakout: 10 }]);
	});
});

describe('annotateTargetBreakoutConfounders: 出さない側', () => {
	it('空なら配列ではなくキーごと出さない（「調べて 0 件」と「対象外」を混ぜない）', () => {
		const self = reached('triangle_ascending', 100, 'up', 20);
		annotateTargetBreakoutConfounders([self]);
		expect(self).not.toHaveProperty('targetOtherBreakoutBeforeReach');
		expect(self).not.toHaveProperty('targetOppositeBreakoutInWindow');
	});

	it('進捗そのものが測れていない（targetScanBars が無い）パターンには何も付けない', () => {
		const self: Entry = {
			type: 'head_and_shoulders',
			status: 'completed',
			breakoutBarIndex: 100,
			breakoutDirection: 'down',
			targetProgressOmittedReason: 'degenerate_target_distance',
		};
		const other = reached('falling_wedge', 110, 'up', 5);
		annotateTargetBreakoutConfounders([self, other]);
		expect(beforeReach(self)).toBeUndefined();
		expect(oppositeInWindow(self)).toBeUndefined();
	});

	it('ブレイク足 / 方向が無いパターンは自分も他も対象外', () => {
		const noIdx: Entry = {
			type: 'triangle_ascending',
			status: 'completed',
			breakoutDirection: 'up',
			targetScanBars: 60,
		};
		const noDir: Entry = { type: 'falling_wedge', status: 'completed', breakoutBarIndex: 110, targetFirstReachBars: 1 };
		const self = unreached('rising_wedge', 100, 'down');
		annotateTargetBreakoutConfounders([self, noIdx, noDir]);
		expect(oppositeInWindow(self)).toBeUndefined();
		expect(beforeReach(noDir)).toBeUndefined();
	});

	it('空配列を渡しても落ちない', () => {
		expect(annotateTargetBreakoutConfounders([])).toEqual([]);
	});
});
