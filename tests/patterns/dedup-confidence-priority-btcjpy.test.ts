/**
 * issue #142 の回帰テスト — dedup の勝者選択が「広い窓」ではなく **confidence の高い候補**を
 * 残すことを BTC/JPY 日足の**実データ**で固定する。
 *
 * fixture は `tests/fixtures/btc_jpy_1day_2026.ts`（2026-05-29〜08-26 の 90 本）。
 *
 * #142 が報告した三角形の実例（idx 0〜81 / confidence 0.82 / 外れ値除去 18 点が
 * 0.91 と 0.87 を押し出す）は **#141（外れ値除去の上限）で候補そのものが棄却され、消えた**
 * （`outlier-cap-btcjpy.test.ts` が棄却側を固定している）。ただし押し出していた**機構**は
 * `deduplicatePatterns` の優先順に残っており、同じ fixture の別種別で今も観測できる:
 *
 * | 時間足 | 種別 | #142 以前の勝者 | 正しい勝者 |
 * |---|---|---|---|
 * | `1day` | `rising_wedge` | 0.82（06-18→08-20、窓 63 日） | **0.95**（06-23→07-13、窓 20 日） |
 * | `1hour` | `triangle_symmetrical` | 0.86（07-28→08-16） | **0.87**（07-26→08-14） |
 *
 * どちらも `deduplicatePatterns` が statusScore で並んだあと `range.end` の最大値だけに
 * 絞り込むため、**confidence が一度も比較されずに**終端の新しい（＝広い）ほうが勝っていた。
 *
 * `1day` の `rising_wedge` は 2 段目の影響まで含む: 0.82（63 日）は後段 `globalDedup` で
 * `falling_wedge`（07-08→08-17）と重なり率 1.00 で衝突して**丸ごと消えていた**。
 * 0.95（20 日）なら重なり率 0.25 で衝突しないため、2 つの別々の構造として両方残る。
 * これが #142 の言う「飲み込みの連鎖」の実体で、**連鎖の起点は `globalDedup` ではなく
 * 検出器内 dedup の代表選択**だった。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBtcJpy2026Candles } from '../fixtures/btc_jpy_1day_2026.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';

const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);
const candles = buildBtcJpy2026Candles();

function indicatorsOk() {
	return {
		ok: true as const,
		summary: 'ok',
		data: { chart: { candles, meta: { pastBuffer: 0 }, indicators: {} } },
		meta: {},
	};
}

async function run(tf: string) {
	mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
	const res = await detectPatterns('btc_jpy', tf, 90, {
		includeCompleted: true,
		includeForming: false,
		view: 'debug',
	});
	if (!res.ok) throw new Error('detectPatterns failed');
	return res;
}

const day = (iso?: string) => String(iso).slice(0, 10);

describe('issue #142 dedup の勝者選択 — BTC/JPY 日足 実データ回帰', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe('1day の rising_wedge', () => {
		it('confidence 0.95 の狭い窓が残り、0.82 の広い窓は残らない', async () => {
			const res = await run('1day');
			const rising = res.data.patterns.filter((p) => p.type === 'rising_wedge');
			expect(rising).toHaveLength(1);
			expect(rising[0].confidence).toBe(0.95);
			expect(day(rising[0].range.start)).toBe('2026-06-23');
			expect(day(rising[0].range.end)).toBe('2026-07-13');
		});

		it('広い窓に飲まれていた falling_wedge と両立する（globalDedup で衝突しない）', async () => {
			const res = await run('1day');
			const wedges = res.data.patterns
				.filter((p) => p.type.endsWith('_wedge'))
				.map((p) => `${p.type}|${p.confidence}|${day(p.range.start)}|${day(p.range.end)}`)
				.sort();
			expect(wedges).toEqual(['falling_wedge|0.95|2026-07-08|2026-08-17', 'rising_wedge|0.95|2026-06-23|2026-07-13']);
		});
	});

	describe('1hour の triangle_symmetrical', () => {
		it('confidence 0.87 の候補が残り、終端が 2 本新しい 0.86 は残らない', async () => {
			const res = await run('1hour');
			const near = res.data.patterns.filter(
				(p) => p.type === 'triangle_symmetrical' && day(p.range.start) >= '2026-07-20',
			);
			expect(near).toHaveLength(1);
			expect(near[0].confidence).toBe(0.87);
			expect(day(near[0].range.start)).toBe('2026-07-26');
			expect(day(near[0].range.end)).toBe('2026-08-14');
		});
	});

	describe('#133 / PR #135 の不変条件', () => {
		it('confidence を先に見ても形成中が完成済みを押し出さない', async () => {
			mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
			const res = await detectPatterns('btc_jpy', '1day', 90, {
				includeCompleted: true,
				includeForming: true,
				view: 'debug',
			});
			if (!res.ok) throw new Error('detectPatterns failed');
			// #135 が固定した完成済み（構成点 8/3 → 8/10 → 8/14、突破 8/19 = idx 82）。
			// includeForming: true でも形成中に押し出されない。
			const doubleBottoms = res.data.patterns.filter((p) => p.type === 'double_bottom');
			expect(doubleBottoms.some((p) => day(p.range.end) === '2026-08-19')).toBe(true);
		});
	});
});
