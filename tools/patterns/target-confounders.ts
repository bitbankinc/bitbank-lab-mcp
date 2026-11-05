// 単一ソースは src/schema/patterns.ts の Zod スキーマ。TS 側で形を別に持つと parse() が黙って剥がす。
export type { TargetBreakoutConfounder } from '../../src/schema/patterns.js';

import type { TargetBreakoutConfounder as Confounder } from '../../src/schema/patterns.js';

// 検出器が積んだ生のオブジェクトをそのまま受けるので、PatternEntry ではなく unknown で受ける。
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

// detect_patterns.ts のライフサイクル絞り込み（isCompleted）とそろえている。includeInvalid でも変えないのは、同じ値動きへの申告が呼び出しオプションで揺れるため。
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
	// string のまま持つと、列挙外の値を DetectPatternsOutputSchema.parse() で落とす検査が効かなくなる。
	const type = (typeof p.type === 'string' && p.type ? p.type : 'unknown') as Confounder['type'];
	return { source: p, type, direction, idx };
}

// 呼び出しは globalDedup と triple × H&S の型間排他の後に置く。先に置くと後で消えるパターンまで数える。
// 空配列はキーごと出さない。[] を置くと「調べて 0 件」と「対象外」が区別できない。
export function annotateTargetBreakoutConfounders<T extends TargetConfoundablePattern>(patterns: T[]): T[] {
	if (!Array.isArray(patterns) || patterns.length === 0) return patterns;

	const accepted = patterns.filter(isAcceptedForConfounding);
	const refs = accepted.map(toBreakoutRef).filter((r): r is BreakoutRef => r !== null);
	if (refs.length === 0) return patterns;

	for (const self of refs) {
		const p = self.source;
		const firstReach = Number(p.targetFirstReachBars);
		if (Number.isInteger(firstReach)) {
			// 到達側は方向を問わず (ブレイク, 初到達) の開区間で数える。初到達と同じ足では「先に起きた」と言えないため。
			const hits = collect(refs, self, (r) => r.idx > self.idx && r.idx < self.idx + firstReach);
			if (hits.length) p.targetOtherBreakoutBeforeReach = hits;
			continue;
		}

		const scanBars = Number(p.targetScanBars);
		if (!Number.isInteger(scanBars)) continue;
		// 未到達側は逆方向だけを数える。同方向も含めると 94.7% の実体に付き、申告にならない（#288）。
		const hits = collect(
			refs,
			self,
			(r) => r.direction !== self.direction && r.idx > self.idx && r.idx <= self.idx + scanBars,
		);
		if (hits.length) p.targetOppositeBreakoutInWindow = hits;
	}

	return patterns;
}

// 自分自身は参照で除く。同じ足で抜けた別の構造は、帰属を切る事実なので数える。
function collect(refs: readonly BreakoutRef[], self: BreakoutRef, keep: (r: BreakoutRef) => boolean): Confounder[] {
	return (
		refs
			.filter((r) => r.source !== self.source && keep(r))
			.map((r) => ({ type: r.type, direction: r.direction, barsAfterBreakout: r.idx - self.idx }))
			// rankPatterns の並び順に引きずられないよう、本数 → 種別で並びを固定する。
			.sort((a, b) => a.barsAfterBreakout - b.barsAfterBreakout || a.type.localeCompare(b.type))
	);
}
