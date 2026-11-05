// `data.patterns`（BTC/JPY 1hour 実データ・既定オプション）を実際の出力のスナップショット（`tests/fixtures/detect_patterns_1hour_data_patterns_baseline.json`）として固定する。ベースラインを更新するときは、理由と差分を PR に書くこと。
// 構造図の `svg` / `artifact.title` は tz 修正で意図的に変わる値なので比較から除き、tz を通さない `artifact.identifier` は完全一致の対象に含める（issue #200）。
import { describe, expect, it, vi } from 'vitest';

vi.mock('../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../tools/analyze_indicators.js';
import detectPatterns from '../tools/detect_patterns.js';
import { asMockResult, assertOk } from './_assertResult.js';
import { buildBtcJpy2026ThroughSep30Candles } from './fixtures/btc_jpy_1day_2026.js';
import { buildBtcJpy1hour202608Candles } from './fixtures/btc_jpy_1hour_2026_08.js';
import baseline from './fixtures/detect_patterns_1hour_data_patterns_baseline.json' with { type: 'json' };
import targetReachPre288 from './fixtures/detect_patterns_1hour_target_reach_pre288.json' with { type: 'json' };

describe('detect_patterns: data.patterns の実データスナップショット（issue #200 起点。#202 / #199 / #208 / #210 / #204 / #199 候補 2 / #218 / #216 / #211 / #244 / #252 / #288 Phase 2 で更新）', () => {
	it('報告例の120日窓では bull flag を維持し、09-01〜09-21 の偽 rising wedge だけを除く', async () => {
		const candles = buildBtcJpy2026ThroughSep30Candles();
		vi.mocked(analyzeIndicators).mockResolvedValueOnce(
			asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
		);

		const res = await detectPatterns('btc_jpy', '1day', candles.length, {});
		assertOk(res);
		const falseWedge = res.data.patterns.find(
			(p) =>
				p.type === 'rising_wedge' &&
				String(p.range?.start).slice(0, 10) === '2026-09-01' &&
				String(p.range?.end).slice(0, 10) === '2026-09-21',
		);
		const reportedFlag = res.data.patterns.find(
			(p) => p.type === 'bull_flag' && String(p.range?.end).slice(0, 10) === '2026-09-22',
		);

		expect(falseWedge).toBeUndefined();
		expect(reportedFlag).toBeDefined();
		expect(reportedFlag?.status).toBe('completed');
		expect(reportedFlag?.outcome).toBe('success');
	});

	it('btc_jpy 1hour（デフォルトオプション）で H&S の方向ゲート以外の data.patterns を維持する', async () => {
		const candles = buildBtcJpy1hour202608Candles();
		vi.mocked(analyzeIndicators).mockResolvedValueOnce(
			asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
		);

		const res = await detectPatterns('btc_jpy', '1hour', 365, {});
		assertOk(res);

		// 件数がずれているなら、deep-equal で「どのフィールドが変わったか」を見るより「何件増減したか」を先に見せたほうが速いので、検出件数を先に固定する。
		const withoutWedges = (patterns: typeof res.data.patterns) => patterns.filter((p) => !p.type.endsWith('_wedge'));
		const actualNonWedges = withoutWedges(res.data.patterns);
		const baselineNonWedges = withoutWedges(baseline as typeof res.data.patterns);
		// 横ばい先行の逆 H&S / triple bottom と窓先頭の履歴不足候補は除外されるので、件数と、除外対象が戻らないことを固定する。
		const pivotSignature = (p: { pivots?: Array<{ idx: number }> }) => (p.pivots ?? []).map((q) => q.idx).join('-');
		expect(actualNonWedges).toHaveLength(baselineNonWedges.length - 2);
		expect(
			actualNonWedges.some(
				(p) => p.type === 'inverse_head_and_shoulders' && pivotSignature(p) === '230-232-249-265-272',
			),
		).toBe(false);
		expect(actualNonWedges.some((p) => p.type === 'triple_bottom')).toBe(false);

		// wedge は意図的に再判定するので、残る候補は出力された構成点だけで上下 2 点ずつ・合計 5 点以上を検算する。
		for (const p of res.data.patterns.filter((q) => q.type.endsWith('_wedge'))) {
			const pivots = p.pivots ?? [];
			expect(pivots.length).toBeGreaterThanOrEqual(5);
			expect(pivots.filter((q) => q.kind === 'H').length).toBeGreaterThanOrEqual(2);
			expect(pivots.filter((q) => q.kind === 'L').length).toBeGreaterThanOrEqual(2);
		}
		for (const p of res.data.patterns.filter((q) => q.type.endsWith('_wedge') && q.outcome === 'failure')) {
			expect(p.breakoutTarget).toBeUndefined();
			expect(p.targetProgressOmittedReason).toBe('breakout_against_expectation');
		}

		// artifact.identifier は tz 修正の対象外（表示ではなく成果物 ID）。個別にも明示して固定する。
		const identifiers = res.data.patterns
			.map(
				(p) =>
					(p as { structureDiagram?: { artifact?: { identifier?: string } } }).structureDiagram?.artifact?.identifier,
			)
			.filter((id): id is string => typeof id === 'string');
		// 履歴ウォームアップ後はこの fixture に構造図付きの反転パターンが残らないが、空集合でも一意性（重複がない）という契約はそのまま成立する。
		expect(new Set(identifiers).size).toBe(identifiers.length);
	});

	// 上のスナップショットはベースライン更新時に「既存キーも一緒に動いた」を見逃すので、target 進捗系の既存キーとブレイク足の 2 キーを #288 Phase 2 着手前の値のまま別 fixture（`detect_patterns_1hour_target_reach_pre288.json`）に切り出して突き合わせる。
	// 意図的に進捗の計算を変える変更は、この fixture を更新する理由を PR に書くこと。
	it('#288 Phase 2: target 進捗系の既存キーが着手前と 1 バイトも変わらない', async () => {
		const candles = buildBtcJpy1hour202608Candles();
		vi.mocked(analyzeIndicators).mockResolvedValueOnce(
			asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
		);

		const res = await detectPatterns('btc_jpy', '1hour', 365, {});
		assertOk(res);

		const PRE_288_KEYS = [
			'type',
			'breakoutBarIndex',
			'breakoutDirection',
			'targetReachedPct',
			'targetReached',
			'targetReachedDate',
			'targetReachedPrice',
			'targetProgressOmittedReason',
		] as const;
		const project = (patterns: ReadonlyArray<Record<string, unknown>>) =>
			patterns.map((p) => {
				const out: Record<string, unknown> = {};
				for (const k of PRE_288_KEYS) if (p[k] !== undefined) out[k] = p[k];
				return out;
			});

		// 射影が空振り（全件 `{type}` だけ）していないことを先に見る。
		expect(targetReachPre288.filter((p) => 'targetReachedPct' in p).length).toBeGreaterThan(0);
		const nonWedge = (p: Record<string, unknown>) => !String(p.type).endsWith('_wedge');
		// 横ばい先行 IHS と窓先頭履歴不足 IHS の除外は、ターゲット計算の additive 性ではなく検出器の候補選別を意図的に変えた差分なので比較から外す。
		const isPr3Reclassification = (p: Record<string, unknown>) =>
			Number(p.breakoutBarIndex) === 280 && String(p.type) === 'inverse_head_and_shoulders';
		const isPr9HistoryExcluded = (p: Record<string, unknown>) =>
			Number(p.breakoutBarIndex) === 118 && String(p.type) === 'inverse_head_and_shoulders';
		expect(
			project(
				res.data.patterns
					.filter(nonWedge)
					.filter((p) => !isPr3Reclassification(p))
					.filter((p) => !isPr9HistoryExcluded(p)),
			),
		).toEqual(
			targetReachPre288
				.filter(nonWedge)
				.filter((p) => !isPr3Reclassification(p))
				.filter((p) => !isPr9HistoryExcluded(p)),
		);
	});
});
