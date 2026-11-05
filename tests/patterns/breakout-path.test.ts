import { describe, expect, it } from 'vitest';
import { detectPivotBeforeBreakout } from '../../tools/patterns/structural.js';
import type { Pivot } from '../../tools/patterns/swing.js';

function pivot(idx: number, kind: 'H' | 'L', price = 100): Pivot {
	return { idx, kind, price, extremePrice: kind === 'H' ? price + 1 : price - 1 };
}

describe('detectPivotBeforeBreakout: エッジケース', () => {
	it('空配列は found=false', () => {
		expect(detectPivotBeforeBreakout({ pivots: [], lastPivotIdx: 10, breakoutIdx: 20, side: 'top' })).toEqual({
			found: false,
		});
	});

	it('区間が空（ブレイクが最終構成点の次の足）なら found=false', () => {
		const pivots = [pivot(10, 'H'), pivot(11, 'H')];
		expect(detectPivotBeforeBreakout({ pivots, lastPivotIdx: 10, breakoutIdx: 11, side: 'top' }).found).toBe(false);
	});

	it('idx が非有限のピボットは無視する', () => {
		const pivots = [{ idx: Number.NaN, kind: 'H' as const, price: 100, extremePrice: 101 }];
		expect(detectPivotBeforeBreakout({ pivots, lastPivotIdx: 10, breakoutIdx: 20, side: 'top' }).found).toBe(false);
	});

	it('同種ピボットが複数あっても最も左の 1 つだけを返す', () => {
		const pivots = [pivot(15, 'H', 120), pivot(12, 'H', 110), pivot(18, 'H', 130)];
		const res = detectPivotBeforeBreakout({ pivots, lastPivotIdx: 10, breakoutIdx: 20, side: 'top' });
		expect(res.found).toBe(true);
		expect(res.pivot?.idx).toBe(12);
	});

	it('単一要素（区間内の同種 1 つ）で found=true', () => {
		const pivots = [pivot(15, 'H')];
		expect(detectPivotBeforeBreakout({ pivots, lastPivotIdx: 10, breakoutIdx: 20, side: 'top' }).found).toBe(true);
	});
});

describe('detectPivotBeforeBreakout: 両端を含まない', () => {
	it('最終構成点そのもの（idx === lastPivotIdx）は数えない', () => {
		const pivots = [pivot(10, 'H')];
		expect(detectPivotBeforeBreakout({ pivots, lastPivotIdx: 10, breakoutIdx: 20, side: 'top' }).found).toBe(false);
	});

	it('ブレイク足そのもの（idx === breakoutIdx）は数えない', () => {
		const pivots = [pivot(20, 'H')];
		expect(detectPivotBeforeBreakout({ pivots, lastPivotIdx: 10, breakoutIdx: 20, side: 'top' }).found).toBe(false);
	});

	it('最終構成点の 1 本後（off-by-one の下端）は数える', () => {
		const pivots = [pivot(11, 'H')];
		expect(detectPivotBeforeBreakout({ pivots, lastPivotIdx: 10, breakoutIdx: 20, side: 'top' }).pivot?.idx).toBe(11);
	});

	it('ブレイク足の 1 本前（off-by-one の上端）は数える', () => {
		const pivots = [pivot(19, 'H')];
		expect(detectPivotBeforeBreakout({ pivots, lastPivotIdx: 10, breakoutIdx: 20, side: 'top' }).pivot?.idx).toBe(19);
	});

	it('区間の外（前後）のピボットは数えない', () => {
		const pivots = [pivot(5, 'H'), pivot(25, 'H')];
		expect(detectPivotBeforeBreakout({ pivots, lastPivotIdx: 10, breakoutIdx: 20, side: 'top' }).found).toBe(false);
	});
});

describe('detectPivotBeforeBreakout: 同種と異種', () => {
	it('top は H だけを見る（L は無視）', () => {
		const pivots = [pivot(15, 'L')];
		expect(detectPivotBeforeBreakout({ pivots, lastPivotIdx: 10, breakoutIdx: 20, side: 'top' }).found).toBe(false);
	});

	it('bottom は L だけを見る（H は無視）', () => {
		const pivots = [pivot(15, 'H')];
		expect(detectPivotBeforeBreakout({ pivots, lastPivotIdx: 10, breakoutIdx: 20, side: 'bottom' }).found).toBe(false);
	});

	it('異種に挟まれていても同種があれば found=true', () => {
		const pivots = [pivot(12, 'L'), pivot(15, 'H'), pivot(17, 'L')];
		expect(detectPivotBeforeBreakout({ pivots, lastPivotIdx: 10, breakoutIdx: 20, side: 'top' }).pivot?.idx).toBe(15);
	});
});

describe('detectPivotBeforeBreakout: 水準は問わない・理由コード', () => {
	it('構成点より十分低い山でも落とす（top）', () => {
		const pivots = [pivot(55, 'H', 12_711_037)];
		const res = detectPivotBeforeBreakout({ pivots, lastPivotIdx: 50, breakoutIdx: 56, side: 'top' });
		expect(res).toEqual({ found: true, reason: 'peak_after_last_pivot', pivot: pivots[0] });
	});

	it('構成点より十分高い谷でも落とす（bottom）', () => {
		const pivots = [pivot(55, 'L', 999_999)];
		const res = detectPivotBeforeBreakout({ pivots, lastPivotIdx: 50, breakoutIdx: 60, side: 'bottom' });
		expect(res.reason).toBe('trough_after_last_pivot');
	});

	it('理由コードに種別の接頭辞を付けない', () => {
		const top = detectPivotBeforeBreakout({ pivots: [pivot(15, 'H')], lastPivotIdx: 10, breakoutIdx: 20, side: 'top' });
		const bottom = detectPivotBeforeBreakout({
			pivots: [pivot(15, 'L')],
			lastPivotIdx: 10,
			breakoutIdx: 20,
			side: 'bottom',
		});
		expect(top.reason).toBe('peak_after_last_pivot');
		expect(bottom.reason).toBe('trough_after_last_pivot');
		for (const r of [top.reason, bottom.reason]) {
			expect(r).not.toMatch(/^(double|triple|hs)_/);
		}
	});
});

describe('detectPivotBeforeBreakout: 純粋関数', () => {
	it('ピボット列の並び順に依存しない', () => {
		const asc = [pivot(12, 'H'), pivot(15, 'H'), pivot(18, 'H')];
		const desc = [...asc].reverse();
		const args = { lastPivotIdx: 10, breakoutIdx: 20, side: 'top' } as const;
		expect(detectPivotBeforeBreakout({ ...args, pivots: asc })).toEqual(
			detectPivotBeforeBreakout({ ...args, pivots: desc }),
		);
	});

	it('入力配列を変更しない', () => {
		const pivots = [pivot(12, 'H'), pivot(15, 'H')];
		const snapshot = JSON.stringify(pivots);
		detectPivotBeforeBreakout({ pivots, lastPivotIdx: 10, breakoutIdx: 20, side: 'top' });
		expect(JSON.stringify(pivots)).toBe(snapshot);
	});
});
