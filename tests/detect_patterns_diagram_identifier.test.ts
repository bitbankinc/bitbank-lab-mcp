import { describe, expect, it } from 'vitest';
import { uniquifyDiagramIdentifiers } from '../tools/detect_patterns.js';
import type { DeduplicablePattern } from '../tools/patterns/types.js';

// 手元の実データには同じ日に始まる同種のパターンが並ぶ入力が無いので、関数を直接呼ぶ。
function withDiagram(type: string, identifier: string): DeduplicablePattern {
	return { type, structureDiagram: { svg: '<svg/>', artifact: { identifier, title: identifier } } };
}

function idsOf(patterns: DeduplicablePattern[]): Array<string | undefined> {
	return patterns.map(
		(p) => (p as { structureDiagram?: { artifact?: { identifier?: string } } }).structureDiagram?.artifact?.identifier,
	);
}

describe('detect_patterns: 構造図の identifier', () => {
	it('同じ日に始まる同種のパターンが並んでも、結果の中で identifier がぶつからない', () => {
		const out = uniquifyDiagramIdentifiers([
			withDiagram('head_and_shoulders', 'head_and_shoulders-diagram-2026-08-21'),
			withDiagram('double_top', 'double_top-diagram-2026-08-21'),
			withDiagram('head_and_shoulders', 'head_and_shoulders-diagram-2026-08-21'),
			{ type: 'rising_wedge' },
			withDiagram('head_and_shoulders', 'head_and_shoulders-diagram-2026-08-21'),
		]);

		expect(idsOf(out)).toEqual([
			'head_and_shoulders-diagram-2026-08-21',
			'double_top-diagram-2026-08-21',
			'head_and_shoulders-diagram-2026-08-21-2',
			undefined,
			'head_and_shoulders-diagram-2026-08-21-3',
		]);
	});

	it('連番を付けるのは identifier だけで、元のパターンは書き換えない', () => {
		const input = [
			withDiagram('head_and_shoulders', 'head_and_shoulders-diagram-2026-08-21'),
			withDiagram('head_and_shoulders', 'head_and_shoulders-diagram-2026-08-21'),
		];
		const out = uniquifyDiagramIdentifiers(input);

		expect(idsOf(input)).toEqual(['head_and_shoulders-diagram-2026-08-21', 'head_and_shoulders-diagram-2026-08-21']);
		expect(out[0]).toBe(input[0]);
		expect(out[1].structureDiagram).toMatchObject({
			svg: '<svg/>',
			artifact: { title: 'head_and_shoulders-diagram-2026-08-21' },
		});
	});
});
