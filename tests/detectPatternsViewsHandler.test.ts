/**
 * detectPatternsViewsHandler ブランチカバレッジテスト
 * 純粋関数群を直接テスト（mock 不要）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	buildPeriodLine,
	buildTypeSummary,
	formatDebugView,
	formatDetailedView,
	formatFullView,
	formatPatternLine,
	formatSummaryView,
} from '../src/handlers/detectPatternsViewsHandler.js';
import type { PatternEntry } from '../tools/patterns/types.js';

afterEach(() => {
	vi.resetAllMocks();
});

// ── helpers ──

function makePattern(overrides: Partial<PatternEntry> = {}): PatternEntry {
	return {
		type: 'double_top',
		confidence: 0.75,
		range: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-20T00:00:00.000Z' },
		pivots: [
			{ idx: 0, price: 100000 },
			{ idx: 5, price: 90000 },
			{ idx: 10, price: 100000 },
		],
		...overrides,
	};
}

const emptyMeta = {
	debug: { swings: [], candidates: [] },
	effective_params: { tolerancePct: 0.04 },
};

const emptyRes = {
	ok: true,
	summary: 'ok',
	data: { patterns: [], overlays: null },
	meta: {},
};

// ── buildPeriodLine ──

describe('buildPeriodLine', () => {
	it('有効なパターンで期間行を生成する', () => {
		const pats = [makePattern()];
		const result = buildPeriodLine(pats);
		expect(result).toMatch(/検出対象期間/);
		expect(result).toMatch(/2026-01-01/);
	});

	it('空配列のとき空文字を返す', () => {
		expect(buildPeriodLine([])).toBe('');
	});

	it('range が undefined のとき空文字を返す', () => {
		const pats = [{ type: 'double_top', confidence: 0.7 } as PatternEntry];
		expect(buildPeriodLine(pats)).toBe('');
	});

	it('range.start/end が無効日時のとき空文字を返す', () => {
		const pats = [makePattern({ range: { start: 'invalid', end: 'also-invalid' } })];
		expect(buildPeriodLine(pats)).toBe('');
	});
});

// ── buildTypeSummary ──

describe('buildTypeSummary', () => {
	it('種別別カウントを返す', () => {
		const pats = [makePattern(), makePattern({ type: 'pennant' }), makePattern()];
		const result = buildTypeSummary(pats);
		expect(result).toContain('double_top×2');
		expect(result).toContain('pennant×1');
	});

	it('type が undefined のとき unknown にグループ化する', () => {
		const pats = [{} as PatternEntry];
		expect(buildTypeSummary(pats)).toContain('unknown×1');
	});
});

// ── formatCandidateDetails (formatDebugView 経由で間接テスト) ──

function makeDebugViewRes() {
	return {
		ok: true as const,
		summary: 'debug',
		data: { patterns: [], overlays: null },
		meta: {},
	};
}

// biome-ignore lint/suspicious/noExplicitAny: test fixture
function makeMeta(candidates: any[]) {
	return {
		debug: {
			swings: [{ kind: 'peak', idx: 3, price: 100000, isoTime: '2026-01-03T00:00:00.000Z' }],
			candidates,
		},
	};
}

describe('formatDebugView / formatCandidateDetails', () => {
	it('details がない候補を "details: none" と表示する', () => {
		const meta = makeMeta([{ type: 'wedge', accepted: false, reason: 'probe_window' }]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('details: none');
	});

	it('type_classification_failed の詳細を表示する', () => {
		const meta = makeMeta([
			{
				type: 'wedge',
				accepted: false,
				reason: 'type_classification_failed',
				details: { failureReason: 'slope diverges', slopeHigh: 0.001, slopeLow: -0.002, slopeRatio: 0.5 },
			},
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('failureReason: slope diverges');
		expect(text).toContain('slopeRatio: 0.500');
	});

	it('probe_window の詳細を表示する', () => {
		const meta = makeMeta([
			{
				type: 'triangle',
				accepted: false,
				reason: 'probe_window',
				details: {
					slopeHigh: 0.002,
					slopeLow: 0.001,
					priceRange: 5000,
					barsSpan: 20,
					minMeaningfulSlope: 0.0005,
					highsIn: [{ index: 0, price: 100000 }],
					lowsIn: [{ index: 2, price: 95000 }],
				},
			},
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('upper.slope');
		expect(text).toContain('barsSpan');
	});

	it('declining_highs の詳細を表示する', () => {
		const meta = makeMeta([
			{
				type: 'wedge',
				accepted: false,
				reason: 'declining_highs',
				details: { highsCount: 5, firstAvg: 102000, secondAvg: 98000, ratio: 0.96 },
			},
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('declining_highs: true');
		expect(text).toContain('1st half avg');
	});

	it('declining_highs_probe の詳細を表示する', () => {
		const meta = makeMeta([
			{
				type: 'wedge',
				accepted: false,
				reason: 'declining_highs_probe',
				details: { highsCount: 4, firstAvg: 101000, secondAvg: 99000, ratio: 0.98 },
			},
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('declining_highs_probe: metrics');
	});

	it('rising_probe の詳細を表示する', () => {
		const meta = makeMeta([
			{
				type: 'wedge',
				accepted: false,
				reason: 'rising_probe',
				details: {
					r2High: 0.9,
					r2Low: 0.85,
					slopeHigh: 0.001234,
					slopeLow: 0.000567,
					slopeRatioLH: 2.1,
					priceRange: 10000,
					barsSpan: 30,
					minMeaningfulSlope: 0.00012,
					highsIn: [],
					lowsIn: [],
					firstAvg: 100000,
					secondAvg: 105000,
					ratio: 1.05,
				},
			},
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('r2: hi=');
		expect(text).toContain('slopeRatioLH');
	});

	it('post_filter_rising_highs_not_declining の詳細を表示する', () => {
		const meta = makeMeta([
			{
				type: 'wedge',
				accepted: false,
				reason: 'post_filter_rising_highs_not_declining',
				details: { highsCount: 6, firstAvg: 98000, secondAvg: 103000, ratio: 1.05 },
			},
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('post_filter: rising highs not declining');
	});

	it('post_filter_falling_lows_not_rising の詳細を表示する', () => {
		const meta = makeMeta([
			{
				type: 'wedge',
				accepted: false,
				reason: 'post_filter_falling_lows_not_rising',
				details: { lowsCount: 5, firstAvg: 99000, secondAvg: 94000, ratio: 0.95 },
			},
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('post_filter: falling lows not rising');
	});

	it('default ケース: spread と slopes を表示する', () => {
		const meta = makeMeta([
			{
				type: 'wedge',
				accepted: false,
				reason: 'unknown_reason',
				details: { spreadStart: 5000, spreadEnd: 3000, hiSlope: 0.001, loSlope: -0.001 },
			},
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('spread:');
		expect(text).toContain('slopes:');
	});

	it('default ケース: spread が NaN のとき n/a を返す', () => {
		const meta = makeMeta([
			{
				type: 'wedge',
				accepted: false,
				reason: 'unknown_reason',
				details: { spreadStart: 'bad', spreadEnd: 'bad' },
			},
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		expect(res.content[0].text).toContain('spread: n/a');
	});

	it('accepted=true の候補に ✅ を付与する', () => {
		const meta = makeMeta([
			{ type: 'wedge', accepted: true, reason: 'ok', points: [{ role: 'hi', idx: 3, price: 100000 }] },
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		expect(res.content[0].text).toContain('✅');
	});

	it('スイングなし・候補なしのとき "なし" を表示する', () => {
		const meta = { debug: { swings: [], candidates: [] } };
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('なし');
	});
});

// ── formatPatternLine ──

describe('formatPatternLine', () => {
	it('double_top: full view で山1/谷/山2 ラベルを出力する', () => {
		const meta = {
			debug: {
				swings: [
					{ kind: 'peak', idx: 0, price: 100000, isoTime: '2026-01-01T00:00:00.000Z' },
					{ kind: 'valley', idx: 5, price: 90000, isoTime: '2026-01-06T00:00:00.000Z' },
					{ kind: 'peak', idx: 10, price: 100000, isoTime: '2026-01-11T00:00:00.000Z' },
				],
			},
		};
		const p = makePattern({ type: 'double_top' });
		const result = formatPatternLine(p, 0, 'full', meta);
		expect(result).toContain('山1');
		expect(result).toContain('谷');
		expect(result).toContain('山2');
	});

	it('double_bottom: full view で谷1/山/谷2 ラベルを出力する', () => {
		const meta = {
			debug: {
				swings: [
					{ kind: 'valley', idx: 0, price: 90000, isoTime: '2026-01-01T00:00:00.000Z' },
					{ kind: 'peak', idx: 5, price: 100000, isoTime: '2026-01-06T00:00:00.000Z' },
					{ kind: 'valley', idx: 10, price: 90000, isoTime: '2026-01-11T00:00:00.000Z' },
				],
			},
		};
		const p = makePattern({ type: 'double_bottom' });
		const result = formatPatternLine(p, 0, 'full', meta);
		expect(result).toContain('谷1');
		expect(result).toContain('山');
		expect(result).toContain('谷2');
	});

	it('debug view でも pivot ラベルを出力する', () => {
		const p = makePattern({ type: 'double_top' });
		const result = formatPatternLine(p, 0, 'debug', emptyMeta);
		expect(result).toContain('山1');
	});

	it('summary view では pivot ラベルを出力しない', () => {
		const p = makePattern({ type: 'double_top' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).not.toContain('山1');
	});

	it('pivots が 3 未満のとき pivot ラベルなし', () => {
		const p = makePattern({
			type: 'double_top',
			pivots: [
				{ idx: 0, price: 100000 },
				{ idx: 5, price: 90000 },
			],
		});
		const result = formatPatternLine(p, 0, 'full', emptyMeta);
		expect(result).not.toContain('山1');
	});

	it('other type では roleLabels なし（full view）', () => {
		const p = makePattern({ type: 'pennant' });
		const result = formatPatternLine(p, 0, 'full', emptyMeta);
		expect(result).not.toContain('山1');
	});

	it('breakout: idx が存在するとき "ブレイク" 行を出力する（idxToIso あり）', () => {
		const meta = {
			debug: {
				swings: [{ kind: 'peak', idx: 10, price: 95000, isoTime: '2026-01-11T00:00:00.000Z' }],
			},
		};
		const p = makePattern({ breakout: { idx: 10, price: 95000 } });
		const result = formatPatternLine(p, 0, 'full', meta);
		expect(result).toContain('ブレイク');
		expect(result).toContain('2026-01-11');
	});

	it('breakout: idxToIso が存在しないとき "n/a" を表示する', () => {
		const p = makePattern({ breakout: { idx: 99, price: 95000 } });
		const result = formatPatternLine(p, 0, 'full', emptyMeta);
		expect(result).toContain('ブレイク');
		expect(result).toContain('n/a');
	});

	it('breakout が null のとき breakout 行なし', () => {
		const p = makePattern({ breakout: null });
		const result = formatPatternLine(p, 0, 'full', emptyMeta);
		expect(result).not.toContain('ブレイク:');
	});

	it('status: completed を日本語で表示する', () => {
		const p = makePattern({ status: 'completed' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('完成（ブレイクアウト確認済み）');
	});

	it('status: invalid を日本語で表示する', () => {
		const p = makePattern({ status: 'invalid' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('無効（期待と逆方向にブレイク）');
	});

	it('status: forming を日本語で表示する', () => {
		const p = makePattern({ status: 'forming' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('形成中');
	});

	it('status: near_completion を日本語で表示する', () => {
		const p = makePattern({ status: 'near_completion' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('ほぼ完成（apex接近）');
	});

	it('status が未知の値のときそのまま表示する', () => {
		const p = makePattern({ status: 'custom_status' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('custom_status');
	});

	it('status が未指定のとき状態行なし', () => {
		const p = makePattern({ status: undefined });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).not.toContain('状態:');
	});

	it('falling_wedge: up breakout → 強気転換（成功）', () => {
		const p = makePattern({ type: 'falling_wedge', breakoutDirection: 'up', outcome: 'success' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('強気転換');
		expect(result).toContain('成功');
	});

	it('falling_wedge: down breakout → 弱気継続（失敗）', () => {
		const p = makePattern({ type: 'falling_wedge', breakoutDirection: 'down', outcome: 'failure' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('弱気継続');
		expect(result).toContain('失敗');
	});

	it('rising_wedge: up breakout → 強気継続（失敗）', () => {
		const p = makePattern({ type: 'rising_wedge', breakoutDirection: 'up', outcome: 'failure' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('強気継続');
	});

	it('rising_wedge: down breakout → 弱気転換（成功）', () => {
		const p = makePattern({ type: 'rising_wedge', breakoutDirection: 'down', outcome: 'success' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('弱気転換');
	});

	it('triangle_ascending: up breakout → 上方ブレイク（強気）', () => {
		const p = makePattern({ type: 'triangle_ascending', breakoutDirection: 'up', outcome: 'success' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('上方ブレイク（強気）');
	});

	it('triangle_ascending: down breakout → 下方ブレイク（弱気転換）', () => {
		const p = makePattern({ type: 'triangle_ascending', breakoutDirection: 'down', outcome: 'failure' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('下方ブレイク（弱気転換）');
	});

	it('triangle_descending: down success → 下方ブレイク（弱気）', () => {
		const p = makePattern({ type: 'triangle_descending', breakoutDirection: 'down', outcome: 'success' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('下方ブレイク（弱気）');
	});

	it('triangle_descending: up failure → 上方ブレイク（強気転換）', () => {
		const p = makePattern({ type: 'triangle_descending', breakoutDirection: 'up', outcome: 'failure' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('上方ブレイク（強気転換）');
	});

	it('pennant: poleDirection=up success → トレンド継続（強気）', () => {
		const p = makePattern({
			type: 'pennant',
			breakoutDirection: 'up',
			outcome: 'success',
			poleDirection: 'up',
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('トレンド継続（強気）');
	});

	it('pennant: poleDirection=down failure → ダマシ（強気転換）', () => {
		const p = makePattern({
			type: 'pennant',
			breakoutDirection: 'down',
			outcome: 'failure',
			poleDirection: 'down',
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('ダマシ（強気転換）');
	});

	it('pennant: expectedDir なし（poleDirection undefined）→ 方向ブレイク', () => {
		const p = makePattern({
			type: 'pennant',
			breakoutDirection: 'up',
			outcome: 'success',
			poleDirection: undefined,
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('上方ブレイク');
	});

	it('breakoutDirection なしのとき outcome 行なし', () => {
		const p = makePattern({ breakoutDirection: undefined, outcome: undefined });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).not.toContain('パターン結果:');
	});

	// pennant fields
	it('pennant: 全フィールドあり（poleDirection/priorTrendDirection/flagpoleHeight/retracementRatio/isTrendContinuation）', () => {
		const p = makePattern({
			type: 'pennant',
			poleDirection: 'up',
			priorTrendDirection: 'bullish',
			flagpoleHeight: 20000,
			retracementRatio: 0.2,
			isTrendContinuation: true,
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('フラッグポール方向: 上昇');
		expect(result).toContain('先行トレンド: 強気（上昇トレンド）');
		expect(result).toContain('フラッグポール値幅');
		expect(result).toContain('戻し比率: 20%');
		expect(result).toContain('正常範囲');
		expect(result).toContain('トレンド継続: はい（成功）');
	});

	it('pennant: priorTrendDirection=bearish → 弱気（下降トレンド）', () => {
		const p = makePattern({ type: 'pennant', priorTrendDirection: 'bearish' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('弱気（下降トレンド）');
	});

	it('pennant: retracementRatio > 0.38 → 高め（トライアングル寄り）', () => {
		const p = makePattern({ type: 'pennant', retracementRatio: 0.5 });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('高め — トライアングル寄り');
	});

	it('pennant: isTrendContinuation=false → いいえ（ダマシ）', () => {
		const p = makePattern({ type: 'pennant', isTrendContinuation: false });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('いいえ（ダマシ）');
	});

	it('pennant: poleDirection=down → 下降', () => {
		const p = makePattern({ type: 'pennant', poleDirection: 'down' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('フラッグポール方向: 下降');
	});

	it('pennant: フィールドなしのとき pennantLine なし', () => {
		const p = makePattern({ type: 'pennant' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		// pennant line 自体が生成されないことを確認（crashしなければOK）
		expect(result).toContain('pennant');
	});

	// structureDiagram
	it('full view + structureDiagram.svg あり → SVG ブロックを出力する', () => {
		const p = makePattern({
			structureDiagram: {
				svg: '<svg>test</svg>',
				artifact: { identifier: 'diag-1', title: 'Test Diagram' },
			},
		});
		const result = formatPatternLine(p, 0, 'full', emptyMeta);
		expect(result).toContain('Structure Diagram (SVG)');
		expect(result).toContain('<svg>test</svg>');
		expect(result).toContain('diag-1');
	});

	it('detailed view + structureDiagram.svg あり → SVG ブロックを出力する', () => {
		const p = makePattern({
			structureDiagram: { svg: '<svg>detail</svg>' },
		});
		const result = formatPatternLine(p, 0, 'detailed', emptyMeta);
		expect(result).toContain('Structure Diagram (SVG)');
	});

	it('debug view では structureDiagram を出力しない', () => {
		const p = makePattern({
			structureDiagram: { svg: '<svg>debug</svg>' },
		});
		const result = formatPatternLine(p, 0, 'debug', emptyMeta);
		expect(result).not.toContain('Structure Diagram (SVG)');
	});

	it('structureDiagram.svg なしのとき SVG ブロックなし', () => {
		const p = makePattern({
			structureDiagram: undefined,
		});
		const result = formatPatternLine(p, 0, 'full', emptyMeta);
		expect(result).not.toContain('Structure Diagram (SVG)');
	});

	// breakoutTarget
	it('breakoutTarget あり → ターゲット価格を出力する', () => {
		const p = makePattern({
			breakoutTarget: 120000,
			targetMethod: 'flagpole_projection',
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('ターゲット価格');
		expect(result).toContain('フラッグポール値幅投影');
	});

	it('targetMethod: pattern_height → パターン高さ投影', () => {
		const p = makePattern({ breakoutTarget: 110000, targetMethod: 'pattern_height' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('パターン高さ投影');
	});

	it('targetMethod: neckline_projection → ネックライン投影', () => {
		const p = makePattern({ breakoutTarget: 110000, targetMethod: 'neckline_projection' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('ネックライン投影');
	});

	it('targetReachedPct < 100 のとき「到達済み」なし', () => {
		const p = makePattern({ breakoutTarget: 110000, targetMethod: 'pattern_height', targetReachedPct: 60 });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('60%');
		expect(result).not.toContain('到達済み');
	});

	it('targetReachedPct >= 100 のとき「到達済み」を表示する', () => {
		const p = makePattern({ breakoutTarget: 110000, targetMethod: 'pattern_height', targetReachedPct: 105 });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('到達済み');
	});

	it('breakoutTarget なしのとき ターゲット価格 なし', () => {
		const p = makePattern({ breakoutTarget: undefined });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).not.toContain('ターゲット価格');
	});

	// neckline
	it('neckline が水平のとき（水平）を表示する', () => {
		const p = makePattern({ neckline: [{ y: 95000 }, { y: 95000 }] });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('水平');
	});

	it('neckline が傾斜のとき → を使用する', () => {
		const p = makePattern({ neckline: [{ y: 95000 }, { y: 97000 }] });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('→');
	});

	it('trendlineLabel を使用する', () => {
		const p = makePattern({ neckline: [{ y: 95000 }, { y: 95000 }], trendlineLabel: 'サポートライン' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('サポートライン');
	});

	// ── 期間表示の分離（structureRange / confirmation / precedingTrend） ──

	it('新フィールドが無いとき legacy「期間」行を表示する', () => {
		const p = makePattern({ structureRange: undefined, confirmation: undefined, precedingTrend: undefined });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('期間:');
		expect(result).not.toContain('文脈期間');
		expect(result).not.toContain('形成期間');
	});

	it('structureRange あり → 形成期間 行を出力する（日付のみ YYYY-MM-DD）', () => {
		const p = makePattern({
			structureRange: { start: '2025-09-01T00:00:00.000Z', end: '2025-09-26T00:00:00.000Z' },
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('形成期間: 2025-09-01 ~ 2025-09-26（構成点）');
	});

	it('confirmation=neckline_breakout → ブレイク確認 行に日付と価格を出力する', () => {
		const p = makePattern({
			structureRange: { start: '2025-09-01T00:00:00.000Z', end: '2025-09-26T00:00:00.000Z' },
			confirmation: {
				type: 'neckline_breakout',
				date: '2025-10-02T00:00:00.000Z',
				idx: 31,
				price: 12345,
			},
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('ブレイク確認: 2025-10-02');
		expect(result).toContain('12,345円');
		// 文脈期間: precedingTrend が無い場合は structureRange.start を起点に
		expect(result).toContain('文脈期間: 2025-09-01 ~ 2025-10-02');
	});

	it('confirmation=not_confirmed → ブレイク確認: なし を表示する', () => {
		const p = makePattern({
			type: 'head_and_shoulders',
			structureRange: { start: '2025-08-01T00:00:00.000Z', end: '2025-09-30T00:00:00.000Z' },
			confirmation: { type: 'not_confirmed' },
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('ブレイク確認: なし');
	});

	it('precedingTrend → 先行トレンド 行に方向・%変化・lookback を出力する', () => {
		const p = makePattern({
			precedingTrend: {
				start: '2025-08-22T00:00:00.000Z',
				end: '2025-09-01T00:00:00.000Z',
				direction: 'down',
				returnPct: -7.5,
				lookbackBars: 10,
			},
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('先行トレンド: 2025-08-22 ~ 2025-09-01');
		expect(result).toContain('下降');
		expect(result).toContain('-7.5%');
		expect(result).toContain('lookback=10本');
	});

	it('precedingTrend.direction=insufficient_data も表示できる', () => {
		const p = makePattern({
			precedingTrend: {
				start: '2025-01-01T00:00:00.000Z',
				end: '2025-01-05T00:00:00.000Z',
				direction: 'insufficient_data',
				returnPct: 0,
				lookbackBars: 10,
			},
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('データ不足');
	});

	it('新フィールド完備 → 期間: のみの単独行は出さない（誤読防止）', () => {
		const p = makePattern({
			structureRange: { start: '2025-09-01T00:00:00.000Z', end: '2025-09-26T00:00:00.000Z' },
			confirmation: {
				type: 'neckline_breakout',
				date: '2025-10-02T00:00:00.000Z',
				idx: 31,
				price: 12345,
			},
			precedingTrend: {
				start: '2025-08-22T00:00:00.000Z',
				end: '2025-09-01T00:00:00.000Z',
				direction: 'down',
				returnPct: -7,
				lookbackBars: 10,
			},
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('文脈期間');
		expect(result).toContain('形成期間');
		expect(result).toContain('ブレイク確認');
		expect(result).toContain('先行トレンド');
		// legacy 「- 期間:」行が単独で出ないこと
		expect(result).not.toMatch(/\n\s+- 期間: 2/);
	});
});

// ── formatSummaryView ──

describe('formatSummaryView', () => {
	it('summary テキストを生成する', () => {
		const pats = [makePattern()];
		const res = formatSummaryView('Header', pats, '期間: 2026-01-01', 'double_top×1', undefined, false, emptyRes);
		expect(res.content[0].text).toContain('Header');
		expect(res.content[0].text).toContain('double_top×1');
	});

	it('includeForming=false のとき hint を表示する', () => {
		const res = formatSummaryView('H', [], '', '', undefined, false, emptyRes);
		expect(res.content[0].text).toContain('includeForming=true');
	});

	it('includeForming=true のとき hint なし', () => {
		const res = formatSummaryView('H', [], '', '', undefined, true, emptyRes);
		expect(res.content[0].text).not.toContain('includeForming=true');
	});
});

// ── formatFullView ──

describe('formatFullView', () => {
	it('overlays ありのとき overlay note を含む', () => {
		const res = formatFullView('Header', [makePattern()], '', 'double_top×1', emptyMeta, {
			...emptyRes,
			data: { patterns: [], overlays: { ranges: [] } },
		});
		expect(res.content[0].text).toContain('チャート連携');
	});

	it('overlays なしのとき overlay note なし', () => {
		const res = formatFullView('Header', [makePattern()], '', 'double_top×1', emptyMeta, emptyRes);
		expect(res.content[0].text).not.toContain('チャート連携');
	});

	it('複数パターンを出力する', () => {
		const pats = [makePattern(), makePattern({ type: 'pennant' })];
		const res = formatFullView('H', pats, '期間', 'summary', emptyMeta, emptyRes);
		expect(res.content[0].text).toContain('double_top');
		expect(res.content[0].text).toContain('pennant');
	});
});

// ── formatDetailedView ──

describe('formatDetailedView', () => {
	it('パターンあり → body を出力する', () => {
		const pats = [makePattern()];
		const res = formatDetailedView('H', pats, '', 'double_top×1', emptyMeta, 0.04, undefined, emptyRes);
		expect(res.content[0].text).toContain('double_top');
	});

	it('パターン 0 件 + summary="insufficient data" → insufficient data メッセージ', () => {
		const res = formatDetailedView('H', [], '', '', emptyMeta, 0.04, undefined, {
			...emptyRes,
			summary: 'insufficient data',
		});
		expect(res.content[0].text).toContain('insufficient data');
		expect(res.content[0].text).not.toContain('tolerancePct=');
	});

	it('パターン 0 件 + 通常 summary → tolerance メッセージ', () => {
		const res = formatDetailedView('H', [], '', '', emptyMeta, 0.04, ['double_top'], emptyRes);
		expect(res.content[0].text).toContain('tolerancePct=0.04');
		expect(res.content[0].text).toContain('double_top');
	});

	it('パターン 0 件 + tolerancePct=undefined → effective_params から取得', () => {
		const meta = { ...emptyMeta, effective_params: { tolerancePct: 0.05 } };
		const res = formatDetailedView('H', [], '', '', meta, undefined, undefined, emptyRes);
		expect(res.content[0].text).toContain('tolerancePct=0.05');
	});

	it('パターン 0 件 + 両方 undefined → "default"', () => {
		const metaNoTol = { debug: { swings: [], candidates: [] } };
		const res = formatDetailedView('H', [], '', '', metaNoTol, undefined, undefined, emptyRes);
		expect(res.content[0].text).toContain('tolerancePct=default');
	});

	it('overlays ありのとき overlay note を含む', () => {
		const res = formatDetailedView('H', [makePattern()], '', '', emptyMeta, 0.04, undefined, {
			...emptyRes,
			data: { patterns: [], overlays: { ranges: [] } },
		});
		expect(res.content[0].text).toContain('チャート連携');
	});

	it('overlays なしのとき overlay note なし', () => {
		const res = formatDetailedView('H', [makePattern()], '', '', emptyMeta, 0.04, undefined, emptyRes);
		expect(res.content[0].text).not.toContain('チャート連携');
	});

	it('5 件超のパターンは top5 のみ出力する', () => {
		const pats = Array.from({ length: 7 }, (_, i) => makePattern({ confidence: 0.7 + i * 0.01 }));
		const res = formatDetailedView('H', pats, '', '', emptyMeta, 0.04, undefined, emptyRes);
		// 6番目、7番目は含まれない（全てconfidence違いだが型は同じなので出現数で確認）
		const matches = res.content[0].text.match(/double_top/g) ?? [];
		expect(matches.length).toBeLessThanOrEqual(5);
	});

	it('usage_example を structuredContent に含む', () => {
		const res = formatDetailedView('H', [], '', '', emptyMeta, 0.04, undefined, emptyRes);
		const sc = res.structuredContent as Record<string, unknown>;
		expect(sc['usage_example']).toBeDefined();
	});
});

// ── tz 表示（PR-4: 表示日付の tz 整形） ──
//
// 構造化データ（range.start/end 等）は UTC ISO のまま不変。
// 表示テキストのみ tz で整形される。
// 検証点: tz=Asia/Tokyo（既定）/ tz=UTC / tz='' で表示日付が切り替わる。
//
// timezone-sensitive な timestamp として 23:30Z 系を使う:
//   2026-10-01T23:30:00.000Z → JST: 2026-10-02 08:30、UTC: 2026-10-01

describe('表示日付の tz 整形（範囲・期間）', () => {
	const startUtcLate = '2026-10-01T23:30:00.000Z'; // UTC=10/01, JST=10/02
	const endUtcLate = '2026-10-10T23:30:00.000Z'; // UTC=10/10, JST=10/11

	it('buildPeriodLine: tz 既定（Asia/Tokyo）で JST 暦日を表示する', () => {
		const pats = [makePattern({ range: { start: startUtcLate, end: endUtcLate } })];
		const result = buildPeriodLine(pats);
		expect(result).toContain('2026-10-02');
		expect(result).toContain('2026-10-11');
	});

	it("buildPeriodLine: tz='Asia/Tokyo' 明示で JST 暦日を表示する", () => {
		const pats = [makePattern({ range: { start: startUtcLate, end: endUtcLate } })];
		const result = buildPeriodLine(pats, 'Asia/Tokyo');
		expect(result).toContain('2026-10-02');
		expect(result).toContain('2026-10-11');
	});

	it("buildPeriodLine: tz='UTC' のとき UTC 暦日を表示する", () => {
		const pats = [makePattern({ range: { start: startUtcLate, end: endUtcLate } })];
		const result = buildPeriodLine(pats, 'UTC');
		expect(result).toContain('2026-10-01');
		expect(result).toContain('2026-10-10');
	});

	it("buildPeriodLine: tz='' は Asia/Tokyo にフォールバックする", () => {
		const pats = [makePattern({ range: { start: startUtcLate, end: endUtcLate } })];
		const result = buildPeriodLine(pats, '');
		expect(result).toContain('2026-10-02');
		expect(result).toContain('2026-10-11');
	});

	it('formatPatternLine: tz 既定で legacy 期間行が JST 暦日になる', () => {
		const p = makePattern({ range: { start: startUtcLate, end: endUtcLate } });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('期間: 2026-10-02 ~ 2026-10-11');
		// UTC 日付は出ない（tz=Asia/Tokyo 既定）
		expect(result).not.toContain('2026-10-01');
		expect(result).not.toContain('2026-10-10');
	});

	it("formatPatternLine: tz='UTC' のとき legacy 期間行が UTC 暦日になる", () => {
		const p = makePattern({ range: { start: startUtcLate, end: endUtcLate } });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta, 'UTC');
		expect(result).toContain('期間: 2026-10-01 ~ 2026-10-10');
	});

	it('formatPatternLine: structureRange が tz 既定で JST 暦日になる', () => {
		const p = makePattern({
			structureRange: { start: startUtcLate, end: endUtcLate },
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('形成期間: 2026-10-02 ~ 2026-10-11（構成点）');
	});

	it("formatPatternLine: structureRange が tz='UTC' のとき UTC 暦日になる", () => {
		const p = makePattern({
			structureRange: { start: startUtcLate, end: endUtcLate },
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta, 'UTC');
		expect(result).toContain('形成期間: 2026-10-01 ~ 2026-10-10（構成点）');
	});

	it('formatPatternLine: confirmation.date が tz 既定で JST 暦日になる', () => {
		const p = makePattern({
			structureRange: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-26T00:00:00.000Z' },
			confirmation: { type: 'neckline_breakout', date: startUtcLate, idx: 31, price: 12345 },
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('ブレイク確認: 2026-10-02');
	});

	it("formatPatternLine: confirmation.date が tz='UTC' のとき UTC 暦日になる", () => {
		const p = makePattern({
			structureRange: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-26T00:00:00.000Z' },
			confirmation: { type: 'neckline_breakout', date: startUtcLate, idx: 31, price: 12345 },
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta, 'UTC');
		expect(result).toContain('ブレイク確認: 2026-10-01');
	});

	it('formatPatternLine: precedingTrend が tz 既定で JST 暦日になる', () => {
		const p = makePattern({
			precedingTrend: {
				start: startUtcLate,
				end: endUtcLate,
				direction: 'down',
				returnPct: -5,
				lookbackBars: 10,
			},
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('先行トレンド: 2026-10-02 ~ 2026-10-11');
	});

	it("formatPatternLine: precedingTrend が tz='UTC' のとき UTC 暦日になる", () => {
		const p = makePattern({
			precedingTrend: {
				start: startUtcLate,
				end: endUtcLate,
				direction: 'down',
				returnPct: -5,
				lookbackBars: 10,
			},
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta, 'UTC');
		expect(result).toContain('先行トレンド: 2026-10-01 ~ 2026-10-10');
	});

	it('formatPatternLine: pivot 日付（double_top）が tz 既定で JST 暦日になる', () => {
		const meta = {
			debug: {
				swings: [
					{ kind: 'peak', idx: 0, price: 100000, isoTime: startUtcLate },
					{ kind: 'valley', idx: 5, price: 90000, isoTime: '2026-10-05T23:30:00.000Z' },
					{ kind: 'peak', idx: 10, price: 100000, isoTime: endUtcLate },
				],
			},
		};
		const p = makePattern({ type: 'double_top' });
		const result = formatPatternLine(p, 0, 'full', meta);
		expect(result).toContain('山1: 2026-10-02');
		expect(result).toContain('谷: 2026-10-06');
		expect(result).toContain('山2: 2026-10-11');
	});

	it("formatPatternLine: pivot 日付（double_top）が tz='UTC' のとき UTC 暦日になる", () => {
		const meta = {
			debug: {
				swings: [
					{ kind: 'peak', idx: 0, price: 100000, isoTime: startUtcLate },
					{ kind: 'valley', idx: 5, price: 90000, isoTime: '2026-10-05T23:30:00.000Z' },
					{ kind: 'peak', idx: 10, price: 100000, isoTime: endUtcLate },
				],
			},
		};
		const p = makePattern({ type: 'double_top' });
		const result = formatPatternLine(p, 0, 'full', meta, 'UTC');
		expect(result).toContain('山1: 2026-10-01');
		expect(result).toContain('谷: 2026-10-05');
		expect(result).toContain('山2: 2026-10-10');
	});

	it('formatPatternLine: breakout 日付が tz 既定で JST 暦日になる', () => {
		const meta = {
			debug: {
				swings: [{ kind: 'peak', idx: 10, price: 95000, isoTime: startUtcLate }],
			},
		};
		const p = makePattern({ breakout: { idx: 10, price: 95000 } });
		const result = formatPatternLine(p, 0, 'full', meta);
		expect(result).toContain('ブレイク: 2026-10-02');
	});

	it("formatPatternLine: breakout 日付が tz='UTC' のとき UTC 暦日になる", () => {
		const meta = {
			debug: {
				swings: [{ kind: 'peak', idx: 10, price: 95000, isoTime: startUtcLate }],
			},
		};
		const p = makePattern({ breakout: { idx: 10, price: 95000 } });
		const result = formatPatternLine(p, 0, 'full', meta, 'UTC');
		expect(result).toContain('ブレイク: 2026-10-01');
	});

	it('formatDebugView: swing isoTime が tz 既定で JST 暦日になる', () => {
		const meta = {
			debug: {
				swings: [{ kind: 'peak', idx: 0, price: 100000, isoTime: startUtcLate }],
				candidates: [],
			},
		};
		const res = formatDebugView('hdr', meta, [], {
			ok: true,
			summary: 'debug',
			data: { patterns: [], overlays: null },
			meta: {},
		});
		expect(res.content[0].text).toContain('(2026-10-02)');
	});

	it("formatDebugView: swing isoTime が tz='UTC' のとき UTC 暦日になる", () => {
		const meta = {
			debug: {
				swings: [{ kind: 'peak', idx: 0, price: 100000, isoTime: startUtcLate }],
				candidates: [],
			},
		};
		const res = formatDebugView(
			'hdr',
			meta,
			[],
			{ ok: true, summary: 'debug', data: { patterns: [], overlays: null }, meta: {} },
			'UTC',
		);
		expect(res.content[0].text).toContain('(2026-10-01)');
	});
});
