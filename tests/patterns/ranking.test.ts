/**
 * tools/patterns/ranking.ts の単体テスト
 *
 * detect_patterns が表示・返却前にパターンを優先度順にソートするための関数。
 * 優先度: status='completed' → confirmation='neckline_breakout' → confidence高 → 直近性
 */
import { describe, expect, it } from 'vitest';
import { rankPatterns, statusScore } from '../../tools/patterns/ranking.js';
import type { DeduplicablePattern } from '../../tools/patterns/types.js';

interface TestPattern extends DeduplicablePattern {
	type: string;
	confidence: number;
	range: { start: string; end: string };
	status?: string;
	confirmation?: { type: string };
}

function makePattern(overrides: Partial<TestPattern>): TestPattern {
	return {
		type: 'double_top',
		confidence: 0.7,
		range: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-10T00:00:00.000Z' },
		...overrides,
	};
}

// statusScore は rankPatterns と dedup（patterns/helpers.ts の deduplicatePatterns /
// globalDedup）が共有する status 優先度の単一ソース（issue #133）。
// 序列を変えるとソートと dedup の両方が同時に動くため、スケールをここで固定する。
describe('statusScore', () => {
	it('completed > status 未設定（完成済み扱い） > forming / near_completion > invalid / expired', () => {
		expect(statusScore('completed')).toBe(3);
		expect(statusScore(undefined)).toBe(2);
		expect(statusScore('forming')).toBe(1);
		expect(statusScore('near_completion')).toBe(1);
		expect(statusScore('invalid')).toBe(0);
		expect(statusScore('expired')).toBe(0);
	});
});

describe('rankPatterns', () => {
	it('completed が forming より上位に来る', () => {
		const forming = makePattern({ type: 'a', confidence: 0.9, status: 'forming' });
		const completed = makePattern({ type: 'b', confidence: 0.5, status: 'completed' });
		const sorted = rankPatterns([forming, completed]);
		expect(sorted[0]).toBe(completed);
		expect(sorted[1]).toBe(forming);
	});

	it('confidence が高い順にソートされる（status / confirmation が同じ場合）', () => {
		const low = makePattern({ type: 'low', confidence: 0.3 });
		const high = makePattern({ type: 'high', confidence: 0.9 });
		const mid = makePattern({ type: 'mid', confidence: 0.6 });
		const sorted = rankPatterns([low, high, mid]);
		expect(sorted.map((p) => p.type)).toEqual(['high', 'mid', 'low']);
	});

	it('低 confidence H&S forming は高 confidence の別パターンより下位に来る', () => {
		const hsLow = makePattern({
			type: 'inverse_head_and_shoulders',
			confidence: 0.01,
			status: 'forming',
		});
		const tri = makePattern({
			type: 'triangle_symmetrical',
			confidence: 0.82,
			status: 'completed',
		});
		const sorted = rankPatterns([hsLow, tri]);
		expect(sorted[0]).toBe(tri);
		expect(sorted[1]).toBe(hsLow);
	});

	it('confirmation=neckline_breakout は not_confirmed より上位に来る', () => {
		const notConf = makePattern({ type: 'a', confidence: 0.8, confirmation: { type: 'not_confirmed' } });
		const conf = makePattern({
			type: 'b',
			confidence: 0.7,
			confirmation: { type: 'neckline_breakout' },
		});
		const sorted = rankPatterns([notConf, conf]);
		expect(sorted[0]).toBe(conf);
		expect(sorted[1]).toBe(notConf);
	});

	it('全部同スコアなら入力順を維持する（stable sort）', () => {
		const a = makePattern({ type: 'a', confidence: 0.7 });
		const b = makePattern({ type: 'b', confidence: 0.7 });
		const c = makePattern({ type: 'c', confidence: 0.7 });
		const sorted = rankPatterns([a, b, c]);
		expect(sorted).toEqual([a, b, c]);
	});

	it('confidence が同じ場合は range.end が新しい方が上位', () => {
		const older = makePattern({
			type: 'older',
			confidence: 0.7,
			range: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-10T00:00:00.000Z' },
		});
		const newer = makePattern({
			type: 'newer',
			confidence: 0.7,
			range: { start: '2026-02-01T00:00:00.000Z', end: '2026-02-10T00:00:00.000Z' },
		});
		const sorted = rankPatterns([older, newer]);
		expect(sorted[0]).toBe(newer);
		expect(sorted[1]).toBe(older);
	});

	it('confidence < 0.6 が confidence >= 0.6 より上に来ない（契約）', () => {
		const lowConf = makePattern({ type: 'low', confidence: 0.4, status: 'forming' });
		const highConf = makePattern({ type: 'high', confidence: 0.6, status: 'forming' });
		const sorted = rankPatterns([lowConf, highConf]);
		expect(sorted[0]).toBe(highConf);
		expect(sorted[1]).toBe(lowConf);
	});

	it('元の配列を破壊しない', () => {
		const a = makePattern({ type: 'a', confidence: 0.3 });
		const b = makePattern({ type: 'b', confidence: 0.9 });
		const input = [a, b];
		const sorted = rankPatterns(input);
		expect(input).toEqual([a, b]); // 元配列は変化しない
		expect(sorted).not.toBe(input); // 新しい配列が返る
	});

	it('空配列を受け取っても空配列を返す', () => {
		expect(rankPatterns([])).toEqual([]);
	});

	it('status=invalid は最下位', () => {
		const invalid = makePattern({ type: 'invalid', confidence: 0.9, status: 'invalid' });
		const forming = makePattern({ type: 'forming', confidence: 0.5, status: 'forming' });
		const completed = makePattern({ type: 'completed', confidence: 0.5, status: 'completed' });
		const sorted = rankPatterns([invalid, forming, completed]);
		expect(sorted.map((p) => p.type)).toEqual(['completed', 'forming', 'invalid']);
	});

	it('status 未設定（=完成扱い）は forming より上位', () => {
		const noStatus = makePattern({ type: 'no_status', confidence: 0.5 });
		const forming = makePattern({ type: 'forming', confidence: 0.9, status: 'forming' });
		const sorted = rankPatterns([forming, noStatus]);
		expect(sorted[0]).toBe(noStatus);
		expect(sorted[1]).toBe(forming);
	});
});
