import { describe, expect, it } from 'vitest';
import {
	AnalyzeCandlePatternsInputSchema,
	CandlePatternTypeEnum,
	DetectedPatternSchema,
	DetectPatternsInputSchema,
	PatternFilterEnum,
	PatternTypeEnum,
} from '../../src/schema/patterns.js';
import { TARGET_REACH_MAX_BARS } from '../../tools/patterns/target-reach.js';

describe('PatternTypeEnum', () => {
	it('出力 type は方向付きの確定パターンのみを受け入れる', () => {
		const types = [
			'double_top',
			'double_bottom',
			'triple_top',
			'triple_bottom',
			'head_and_shoulders',
			'inverse_head_and_shoulders',
			'triangle_ascending',
			'triangle_descending',
			'triangle_symmetrical',
			'falling_wedge',
			'rising_wedge',
			'bull_flag',
			'bear_flag',
			'bull_pennant',
			'bear_pennant',
		];
		for (const t of types) {
			expect(PatternTypeEnum.parse(t)).toBe(t);
		}
	});

	it("legacy umbrella alias ('flag' / 'pennant' / 'triangle') は出力 type として拒否される", () => {
		// これらは入力フィルタ用 alias のため、出力 type には現れてはならない。
		expect(() => PatternTypeEnum.parse('flag')).toThrow();
		expect(() => PatternTypeEnum.parse('pennant')).toThrow();
		expect(() => PatternTypeEnum.parse('triangle')).toThrow();
	});

	it('無効なパターンを拒否する', () => {
		expect(() => PatternTypeEnum.parse('unknown_pattern')).toThrow();
	});
});

describe('PatternFilterEnum', () => {
	it('出力 type と legacy umbrella alias の両方を受け入れる', () => {
		const inputs = [
			// directional output types
			'bull_flag',
			'bear_flag',
			'bull_pennant',
			'bear_pennant',
			'triangle_ascending',
			// umbrella aliases
			'flag',
			'pennant',
			'triangle',
		];
		for (const t of inputs) {
			expect(PatternFilterEnum.parse(t)).toBe(t);
		}
	});

	it('入力フィルタとして DetectPatternsInputSchema.patterns に渡せる', () => {
		const parsed = DetectPatternsInputSchema.parse({ patterns: ['flag', 'pennant', 'triangle'] });
		expect(parsed.patterns).toEqual(['flag', 'pennant', 'triangle']);
	});
});

describe('DetectPatternsInputSchema', () => {
	it('デフォルト値を適用する', () => {
		const result = DetectPatternsInputSchema.parse({});
		expect(result.pair).toBe('btc_jpy');
		expect(result.type).toBe('1day');
		expect(result.limit).toBe(90);
		expect(result.swingDepth).toBe(7);
		expect(result.tolerancePct).toBe(0.04);
		expect(result.view).toBe('detailed');
		expect(result.includeForming).toBe(false);
		expect(result.includeCompleted).toBe(true);
	});

	it('カスタムパターンフィルタを受け入れる', () => {
		const result = DetectPatternsInputSchema.parse({
			patterns: ['double_top', 'double_bottom'],
		});
		expect(result.patterns).toEqual(['double_top', 'double_bottom']);
	});

	it('limit 範囲外を拒否する', () => {
		expect(() => DetectPatternsInputSchema.parse({ limit: 19 })).toThrow();
		expect(() => DetectPatternsInputSchema.parse({ limit: 366 })).toThrow();
	});

	it('tolerancePct 範囲外を拒否する', () => {
		expect(() => DetectPatternsInputSchema.parse({ tolerancePct: 0.2 })).toThrow();
	});
});

describe('DetectedPatternSchema', () => {
	it('基本的なパターンを受け入れる', () => {
		const result = DetectedPatternSchema.parse({
			type: 'double_top',
			confidence: 0.85,
			range: { start: '2024-01-01', end: '2024-01-30' },
		});
		expect(result.type).toBe('double_top');
		expect(result.confidence).toBe(0.85);
	});

	it('全オプショナルフィールドを含むパターン', () => {
		const result = DetectedPatternSchema.parse({
			type: 'bull_pennant',
			confidence: 0.7,
			range: { start: '2024-01-01', end: '2024-01-15' },
			status: 'completed',
			breakoutDirection: 'up',
			poleDirection: 'up',
			isTrendContinuation: true,
			expectedBreakoutDirection: 'up',
			aftermath: {
				breakoutConfirmed: true,
				targetReached: false,
				outcome: '部分成功',
			},
		});
		expect(result.status).toBe('completed');
		expect(result.aftermath?.breakoutConfirmed).toBe(true);
	});

	it('confidence 範囲外を拒否する', () => {
		expect(() =>
			DetectedPatternSchema.parse({
				type: 'double_top',
				confidence: 1.5,
				range: { start: '2024-01-01', end: '2024-01-30' },
			}),
		).toThrow();
	});

	it('structureRange / confirmation(neckline_breakout) / precedingTrend を受け入れる', () => {
		const result = DetectedPatternSchema.parse({
			type: 'double_bottom',
			confidence: 0.8,
			range: { start: '2025-09-01', end: '2025-10-02' },
			structureRange: { start: '2025-09-01', end: '2025-09-26' },
			confirmation: {
				type: 'neckline_breakout',
				date: '2025-10-02',
				idx: 31,
				price: 1234567,
			},
			precedingTrend: {
				start: '2025-08-22',
				end: '2025-09-01',
				direction: 'down',
				returnPct: -7.5,
				lookbackBars: 10,
			},
		});
		expect(result.structureRange?.end).toBe('2025-09-26');
		expect(result.confirmation?.type).toBe('neckline_breakout');
		if (result.confirmation?.type === 'neckline_breakout') {
			expect(result.confirmation.idx).toBe(31);
		}
		expect(result.precedingTrend?.direction).toBe('down');
	});

	it('confirmation=not_confirmed を受け入れる', () => {
		const result = DetectedPatternSchema.parse({
			type: 'head_and_shoulders',
			confidence: 0.7,
			range: { start: '2024-01-01', end: '2024-03-01' },
			confirmation: { type: 'not_confirmed' },
		});
		expect(result.confirmation?.type).toBe('not_confirmed');
	});

	it('precedingTrend.direction=insufficient_data を受け入れる', () => {
		const result = DetectedPatternSchema.parse({
			type: 'double_top',
			confidence: 0.6,
			range: { start: '2024-01-01', end: '2024-01-30' },
			precedingTrend: {
				start: '2024-01-01',
				end: '2024-01-05',
				direction: 'insufficient_data',
				returnPct: 0,
				lookbackBars: 10,
			},
		});
		expect(result.precedingTrend?.direction).toBe('insufficient_data');
	});

	// #189: 宣言が無かったため `parse()` が黙って落としていたフィールド。
	// parity テスト（`tests/detect_patterns_meta_schema_parity.test.ts`）は
	// **ツールを 1 回走らせて出たキー**で見ているので、フィクスチャが relaxed 経路を
	// 踏まなくなると検証ごと消える。スキーマ単体でも生存を固定しておく。
	it('_fallback（relaxed 経路の provenance）を受け入れ、parse 後も残す', () => {
		const result = DetectedPatternSchema.parse({
			type: 'triple_top',
			confidence: 0.76,
			range: { start: '2024-01-01', end: '2024-01-30' },
			_fallback: 'relaxed_triple_x1.25',
		});
		expect(result._fallback).toBe('relaxed_triple_x1.25');
	});

	it('_fallback は省略できる（= strict 経路で拾えた）', () => {
		const result = DetectedPatternSchema.parse({
			type: 'triple_top',
			confidence: 0.8,
			range: { start: '2024-01-01', end: '2024-01-30' },
		});
		expect(result._fallback).toBeUndefined();
	});

	it('_fallback が文字列でない場合は拒否する', () => {
		expect(() =>
			DetectedPatternSchema.parse({
				type: 'triple_top',
				confidence: 0.8,
				range: { start: '2024-01-01', end: '2024-01-30' },
				_fallback: 1.25,
			}),
		).toThrow();
	});

	it('confirmation.type が未知の値は拒否する', () => {
		expect(() =>
			DetectedPatternSchema.parse({
				type: 'double_top',
				confidence: 0.8,
				range: { start: '2024-01-01', end: '2024-01-30' },
				confirmation: { type: 'unknown_type' },
			}),
		).toThrow();
	});
});

describe('CandlePatternTypeEnum', () => {
	it('1本足・2本足・3本足パターンを受け入れる', () => {
		const patterns = [
			'bullish_engulfing',
			'bearish_engulfing',
			'hammer',
			'shooting_star',
			'doji',
			'morning_star',
			'evening_star',
			'three_white_soldiers',
			'three_black_crows',
		];
		for (const p of patterns) {
			expect(CandlePatternTypeEnum.parse(p)).toBe(p);
		}
	});
});

/**
 * ターゲット到達系フィールドの**範囲宣言**（issue #288 Phase 2）。
 *
 * docstring が「常に 1 以上」「0〜TARGET_REACH_MAX_BARS」と言っているのに Zod が任意の整数を
 * 通す状態は、宣言と振る舞いがずれたまま気づけない形なので、境界をここで固定する。
 */
describe('DetectedPatternSchema: ターゲット到達系の範囲（#288 Phase 2）', () => {
	const base = {
		type: 'triangle_ascending' as const,
		confidence: 0.8,
		range: { start: '2024-01-01', end: '2024-01-30' },
	};

	it.each([0, 1, TARGET_REACH_MAX_BARS])('targetFirstReachBars=%i は受け入れる', (bars) => {
		expect(DetectedPatternSchema.parse({ ...base, targetFirstReachBars: bars }).targetFirstReachBars).toBe(bars);
	});

	it.each([-1, TARGET_REACH_MAX_BARS + 1])('targetFirstReachBars=%i は拒否する', (bars) => {
		expect(() => DetectedPatternSchema.parse({ ...base, targetFirstReachBars: bars })).toThrow();
	});

	it.each([0, TARGET_REACH_MAX_BARS])('targetScanBars=%i は受け入れる', (bars) => {
		expect(DetectedPatternSchema.parse({ ...base, targetScanBars: bars }).targetScanBars).toBe(bars);
	});

	it.each([-1, TARGET_REACH_MAX_BARS + 1])('targetScanBars=%i は拒否する', (bars) => {
		expect(() => DetectedPatternSchema.parse({ ...base, targetScanBars: bars })).toThrow();
	});

	const confounder = (over: Record<string, unknown> = {}) => ({
		type: 'rising_wedge',
		direction: 'down',
		barsAfterBreakout: 5,
		...over,
	});

	it('交絡は種別・方向・本数が揃っていれば受け入れる', () => {
		const parsed = DetectedPatternSchema.parse({
			...base,
			targetOtherBreakoutBeforeReach: [confounder()],
			targetOppositeBreakoutInWindow: [confounder({ type: 'triangle_descending', barsAfterBreakout: 1 })],
		});
		expect(parsed.targetOtherBreakoutBeforeReach).toHaveLength(1);
		expect(parsed.targetOppositeBreakoutInWindow?.[0]?.barsAfterBreakout).toBe(1);
	});

	// `toBreakoutRef` が種別を読み取れなかったときの防御分岐。**列挙に混ぜず literal で足してある**
	// ので、「列挙外の種別」と「種別が読めなかった」が区別できる。
	it("種別が読めなかったことの申告 'unknown' は受け入れる", () => {
		const parsed = DetectedPatternSchema.parse({
			...base,
			targetOtherBreakoutBeforeReach: [confounder({ type: 'unknown' })],
		});
		expect(parsed.targetOtherBreakoutBeforeReach?.[0]?.type).toBe('unknown');
	});

	it('列挙にも unknown にも無い種別は拒否する', () => {
		expect(() =>
			DetectedPatternSchema.parse({
				...base,
				targetOtherBreakoutBeforeReach: [confounder({ type: 'cup_and_handle' })],
			}),
		).toThrow();
	});

	// **0 本後は「自分と同じ足」**で、交絡の定義（開区間 / 右端のみ閉じる）では起きない。
	it.each([0, -1])('barsAfterBreakout=%i は拒否する（常に 1 以上）', (bars) => {
		expect(() =>
			DetectedPatternSchema.parse({
				...base,
				targetOtherBreakoutBeforeReach: [confounder({ barsAfterBreakout: bars })],
			}),
		).toThrow();
	});
});

describe('AnalyzeCandlePatternsInputSchema', () => {
	it('デフォルト値を適用する', () => {
		const result = AnalyzeCandlePatternsInputSchema.parse({});
		expect(result.pair).toBe('btc_jpy');
		expect(result.timeframe).toBe('1day');
		expect(result.window_days).toBe(5);
		expect(result.focus_last_n).toBe(5);
		expect(result.history_lookback_days).toBe(180);
	});

	it('as_of を受け入れる', () => {
		const result = AnalyzeCandlePatternsInputSchema.parse({ as_of: '2024-01-15' });
		expect(result.as_of).toBe('2024-01-15');
	});

	it('window_days 範囲外を拒否する', () => {
		expect(() => AnalyzeCandlePatternsInputSchema.parse({ window_days: 2 })).toThrow();
		expect(() => AnalyzeCandlePatternsInputSchema.parse({ window_days: 11 })).toThrow();
	});
});
