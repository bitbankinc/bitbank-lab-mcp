import { describe, expect, it } from 'vitest';
import { PatternCandidateTypeEnum, PatternFilterEnum, PatternTypeEnum } from '../../src/schema/patterns.js';
import {
	CANDIDATE_LABEL_COVERAGE,
	candidateLabelCoverage,
	expandWantedTypes,
	filterCandidatesByWant,
	INPUT_ALIAS_EXPANSION,
} from '../../tools/patterns/candidate-filter.js';

type Cand = { type: string; accepted: boolean; reason?: string };

const cand = (type: string, reason = 'r'): Cand => ({ type, accepted: false, reason });

describe('filterCandidatesByWant', () => {
	it('want が空なら 1 件も落とさず順序も保つ', () => {
		const input = [cand('falling_wedge'), cand('double_bottom'), cand('flag')];
		const out = filterCandidatesByWant(input, new Set<string>());
		expect(out).toEqual(input);
	});

	it('要求した種別だけ残す', () => {
		const input = [cand('falling_wedge'), cand('double_bottom'), cand('rising_wedge'), cand('double_bottom')];
		const out = filterCandidatesByWant(input, new Set(['double_bottom']));
		expect(out.map((c) => c.type)).toEqual(['double_bottom', 'double_bottom']);
	});

	it('要求していない種別は残さない', () => {
		const out = filterCandidatesByWant([cand('falling_wedge'), cand('triangle_symmetrical')], new Set(['double_top']));
		expect(out).toEqual([]);
	});

	it('空配列 / 非配列を渡しても落ちない', () => {
		expect(filterCandidatesByWant([], new Set(['double_top']))).toEqual([]);
		expect(filterCandidatesByWant(undefined as unknown as Cand[], new Set(['double_top']))).toEqual([]);
	});

	// detect_pennants は方向・形状の分類前の棄却をすべて 'flag' ラベルで積む。
	it("分類前ラベル 'flag' は bull_flag 要求でも bull_pennant 要求でも残る", () => {
		for (const want of ['bull_flag', 'bear_flag', 'bull_pennant', 'bear_pennant']) {
			expect(filterCandidatesByWant([cand('flag')], new Set([want])), want).toHaveLength(1);
		}
	});

	it("分類前ラベル 'flag' は無関係な種別の要求では残らない", () => {
		expect(filterCandidatesByWant([cand('flag')], new Set(['double_top']))).toEqual([]);
	});

	// detect_triangles は 3 種の分類が確定する前の棄却をすべて 'triangle' ラベルで積む（#129）。
	it("分類前ラベル 'triangle' は三角形 3 種のどの要求でも残る", () => {
		for (const want of ['triangle_ascending', 'triangle_descending', 'triangle_symmetrical']) {
			expect(filterCandidatesByWant([cand('triangle')], new Set([want])), want).toHaveLength(1);
		}
	});

	it("分類前ラベル 'triangle' は無関係な種別の要求では残らない", () => {
		for (const want of ['double_top', 'rising_wedge', 'bull_pennant']) {
			expect(filterCandidatesByWant([cand('triangle')], new Set([want])), want).toEqual([]);
		}
	});

	it("分類前ラベル 'wedge' は上昇・下降ウェッジのどちらの要求でも残る", () => {
		for (const want of ['rising_wedge', 'falling_wedge']) {
			expect(filterCandidatesByWant([cand('wedge')], new Set([want])), want).toHaveLength(1);
		}
	});

	it("分類前ラベル 'wedge' は三角形や無関係な種別の要求では残らない", () => {
		for (const want of ['triangle', 'triangle_symmetrical', 'double_top', 'bull_pennant']) {
			expect(filterCandidatesByWant([cand('wedge')], new Set([want])), want).toEqual([]);
		}
	});

	it("入力エイリアス 'triangle' は分類前ラベルの候補も残す", () => {
		const input = [cand('triangle'), cand('triangle_ascending')];
		expect(filterCandidatesByWant(input, new Set(['triangle']))).toEqual(input);
	});

	it("入力エイリアス 'flag' は bull_flag / bear_flag の候補を残す", () => {
		const out = filterCandidatesByWant([cand('bull_flag'), cand('bear_flag'), cand('bull_pennant')], new Set(['flag']));
		expect(out.map((c) => c.type)).toEqual(['bull_flag', 'bear_flag']);
	});

	it("入力エイリアス 'pennant' は pennant の候補だけ残す", () => {
		const out = filterCandidatesByWant([cand('bull_pennant'), cand('bull_flag')], new Set(['pennant']));
		expect(out.map((c) => c.type)).toEqual(['bull_pennant']);
	});

	it("入力エイリアス 'triangle' は 3 種すべてを残す", () => {
		const input = [cand('triangle_ascending'), cand('triangle_descending'), cand('triangle_symmetrical')];
		expect(filterCandidatesByWant(input, new Set(['triangle']))).toEqual(input);
	});

	it('複数種別の要求は和集合になる', () => {
		const input = [cand('double_top'), cand('rising_wedge'), cand('falling_wedge')];
		const out = filterCandidatesByWant(input, new Set(['double_top', 'rising_wedge']));
		expect(out.map((c) => c.type)).toEqual(['double_top', 'rising_wedge']);
	});

	it('未知のラベルは自分自身としてのみ照合される', () => {
		expect(candidateLabelCoverage('made_up_type')).toEqual(['made_up_type']);
		expect(filterCandidatesByWant([cand('made_up_type')], new Set(['made_up_type']))).toHaveLength(1);
		expect(filterCandidatesByWant([cand('made_up_type')], new Set(['double_top']))).toEqual([]);
	});
});

describe('expandWantedTypes', () => {
	it('具体 type はそのまま', () => {
		expect(expandWantedTypes(new Set(['double_top']))).toEqual(new Set(['double_top']));
	});

	it('エイリアスを展開する', () => {
		expect(expandWantedTypes(new Set(['triangle']))).toEqual(
			new Set(['triangle_ascending', 'triangle_descending', 'triangle_symmetrical']),
		);
	});

	it('空集合は空集合', () => {
		expect(expandWantedTypes(new Set())).toEqual(new Set());
	});
});

describe('schema との整合', () => {
	const outputTypes = new Set<string>(PatternTypeEnum.options);
	const filterValues = new Set<string>(PatternFilterEnum.options);
	const aliases = [...filterValues].filter((v) => !outputTypes.has(v));

	it('入力エイリアス写像のキーが schema のエイリアスを過不足なく覆う', () => {
		expect(Object.keys(INPUT_ALIAS_EXPANSION).sort()).toEqual([...aliases].sort());
	});

	it('写像の値はすべて出力 type（エイリアスを指さない）', () => {
		for (const [key, expansion] of [
			...Object.entries(INPUT_ALIAS_EXPANSION),
			...Object.entries(CANDIDATE_LABEL_COVERAGE),
		]) {
			for (const t of expansion) {
				expect(outputTypes.has(t), `${key} → ${t} は出力 type ではない`).toBe(true);
			}
		}
	});

	it('candidate ラベル写像のキーが schema の umbrella ラベル（PatternCandidateTypeEnum の出力 type 以外）を過不足なく覆う', () => {
		const umbrellaLabels = PatternCandidateTypeEnum.options.filter((v) => !outputTypes.has(v));
		expect(Object.keys(CANDIDATE_LABEL_COVERAGE).sort()).toEqual([...umbrellaLabels].sort());
	});

	it('すべての出力 type は自分自身の要求で残る', () => {
		for (const t of outputTypes) {
			expect(filterCandidatesByWant([cand(t)], new Set([t])), t).toHaveLength(1);
		}
	});

	// enum に新しい三角形 / flag 系の type を足したのに写像を更新し忘れると、その type を要求した呼び出しに分類前の棄却が届かなくなる（#129）。
	it.each([
		['triangle', /^triangle_/],
		['flag', /^(bull|bear)_(flag|pennant)$/],
	] as const)('umbrella ラベル %s は同じファミリの出力 type を過不足なく覆う', (label, family) => {
		const expected = [...outputTypes].filter((t) => family.test(t)).sort();
		expect(expected.length, `${label}: ファミリの出力 type が 0 件では検出にならない`).toBeGreaterThan(0);
		expect([...CANDIDATE_LABEL_COVERAGE[label]].sort()).toEqual(expected);
	});

	// ラベル側が入力側より広いのは許容（'flag' が pennant まで覆う既存ケース）。
	it('同じ語の candidate ラベルは入力エイリアスの展開を必ず含む', () => {
		for (const [key, expansion] of Object.entries(INPUT_ALIAS_EXPANSION)) {
			const coverage = CANDIDATE_LABEL_COVERAGE[key];
			expect(coverage, `${key} が candidate ラベル写像に無い`).toBeDefined();
			for (const t of expansion) {
				expect(coverage.includes(t), `${key} → ${t} がラベル側で覆われていない`).toBe(true);
			}
		}
	});
});
