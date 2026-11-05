// 合成側で固定するのは「先行トレンドを伴う形は残り、同じ窓の逆向きの読みが落ちること」という相対関係だけで、閾値そのものは実データ側で固定する（#138 欠陥 2-1）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { asMockResult } from '../_assertResult.js';
import { buildBtcJpy2026Candles } from '../fixtures/btc_jpy_1day_2026.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';

type Candle = { isoTime: string; open: number; high: number; low: number; close: number; volume: number };
type Cand = { type: string; accepted: boolean; reason?: string; indices?: number[]; details?: unknown };
type Pat = {
	type: string;
	status?: string;
	confidence: number;
	structureGate?: Record<string, number>;
	precedingTrend?: { direction: string; returnPct: number; lookbackBars: number };
	pivots?: Array<{ idx: number }>;
};

/** 固定の起点から h 時間後。相対時刻にしないのは実行日でパターンが動かないようにするため。 */
function mkCandle(h: number, close: number): Candle {
	const wick = Math.round(close * 0.0004);
	return {
		isoTime: dayjs.utc('2026-08-24T00:00:00Z').add(h, 'hour').toISOString(),
		open: close,
		high: close + wick,
		low: close - wick,
		close,
		volume: 100,
	};
}

/** `from` → `to` を n 本でコサイン補間する（折り返し 1 本だけが極値になるように端をなだらかにする）。 */
function ease(from: number, to: number, n: number): number[] {
	const out: number[] = [];
	for (let k = 1; k <= n; k++) out.push(Math.round(from + (to - from) * (0.5 - 0.5 * Math.cos((Math.PI * k) / n))));
	return out;
}

/** `side='bottom'` なら先行下落（13.0M → 11.0M）のあと 11.0M を 3 回試して 11.7M を上抜ける。ネックライン（11.7M）は先行下落の起点（13.0M）より下にあるので戻り率は約 0.35 で帯の中。 */
function reversalSeries(side: 'top' | 'bottom'): Candle[] {
	const sign = side === 'bottom' ? 1 : -1;
	const prior = 12_000_000 + sign * 1_000_000; // bottom: 13.0M / top: 11.0M
	const extreme = 12_000_000 - sign * 1_000_000; // bottom: 11.0M / top: 13.0M
	const neck = 12_000_000 - sign * 300_000; // bottom: 11.7M / top: 12.3M
	const closes = [prior - sign * 300_000, ...ease(prior - sign * 300_000, prior, 10), ...ease(prior, extreme, 10)];
	for (let i = 0; i < 3; i++) closes.push(...ease(extreme, neck, 10), ...ease(neck, extreme, 10));
	closes.push(...ease(extreme, neck + sign * 500_000, 12));
	return closes.map((c, i) => mkCandle(i, c));
}

async function detect(candles: Candle[], opts: Record<string, unknown> = {}) {
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = (await detectPatterns('btc_jpy', String(opts.type ?? '1hour'), candles.length, {
		includeCompleted: true,
		includeForming: true,
		view: 'debug',
		...opts,
	})) as unknown as { ok: boolean; data: { patterns: Pat[] }; meta: { debug: { candidates: Cand[] } } };
	expect(res.ok).toBe(true);
	return { patterns: res.data.patterns, candidates: res.meta.debug.candidates };
}

const rejected = (cands: Cand[], type: string, reason: string) =>
	cands.filter((c) => c.type === type && !c.accepted && c.reason === reason);

describe('detect_patterns: triple の構造ゲート（issue #138 欠陥 2-1）', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	for (const side of ['bottom', 'top'] as const) {
		const type = side === 'bottom' ? 'triple_bottom' : 'triple_top';
		const mirror = side === 'bottom' ? 'triple_top' : 'triple_bottom';

		it(`先行トレンドを伴う ${type} は残り、戻り率が structureGate に出る`, async () => {
			const { patterns } = await detect(reversalSeries(side));
			const hit = patterns.find((p) => p.type === type);
			expect(hit).toBeDefined();
			// 先行値幅 2.0M に対して戻りは 0.7M。帯 [0.2, 0.9] の中に収まる。
			expect(hit?.structureGate?.retracementRatio).toBeCloseTo(0.35, 2);
			expect(hit?.structureGate?.priorExtremeIdx).toBe(10);
			expect(hit?.precedingTrend?.direction).toBe(side === 'bottom' ? 'down' : 'up');
			expect(hit?.precedingTrend?.lookbackBars).toBeGreaterThan(0);
			// ネックライン水準を第1構成点より前に終値で抜けたバーがある＝ゲート通過の証拠。
			expect(hit?.structureGate?.necklineCrossIdx).toBeDefined();
		});

		it(`同じ窓の逆向きの読み（${mirror}）は先行トレンド不一致で落ちる`, async () => {
			// 反転の形を作ると、ネックラインが先行値幅の起点と一致する側（戻り率 1.0）が逆向きの読みになる。
			const { patterns, candidates } = await detect(reversalSeries(side));
			expect(patterns.filter((p) => p.type === mirror)).toHaveLength(0);
			const expectedReason = mirror === 'triple_bottom' ? 'prior_trend_mismatch:up' : 'prior_trend_mismatch:down';
			const rej = rejected(candidates, mirror, expectedReason);
			expect(rej.length).toBeGreaterThan(0);
		});
	}
});

describe('detect_patterns: 実データに対する triple / H&S の構造ゲート（issue #138 欠陥 2-1）', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('#139 の形成中H&S候補は、先行上昇が無いため残さない', async () => {
		// 左肩 idx 38 / 頭 53 / 谷 66 / 右肩 73、整合度 0.78（#139 で実在する H&S として記録したもの）。
		const { patterns, candidates } = await detect(buildBtcJpy2026Candles(), { type: '1day' });
		const hs = patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs).toBeUndefined();
		expect(candidates.some((c) => c.reason === 'prior_trend_mismatch:sideways')).toBe(true);
	});

	it('swingDepth=3 の H&S: 縮退した4点も、横ばい先行の5点も確定しない', async () => {
		// 左肩 idx 47 で読んだ 4 点の形は、左肩-頭の間に谷ピボットが無いので頭-戻り-右肩の 3 点に縮退し（戻り率 1.35、ネックライン 10,002,960 は上昇の起点 10,051,036 より下）、落ちたまま。
		// 5 点の読み（左肩 38 / 谷 45 / 頭 53 / 谷 66 / 右肩 73）は、肩 2 つ + その間の最高値を頭に取る窓生成で生成され、構造ゲートを通過して残る（#146）。
		const { patterns, candidates } = await detect(buildBtcJpy2026Candles(), { type: '1day', swingDepth: 3 });

		const hs = patterns.filter((p) => p.type === 'head_and_shoulders');
		expect(hs).toHaveLength(0);
		expect(
			candidates.some((c) => c.reason === 'prior_trend_mismatch:sideways' && c.indices?.join('-') === '38-45-53-66-73'),
		).toBe(true);

		const rej = rejected(candidates, 'head_and_shoulders', 'neckline_below_pre_decline_low');
		expect(rej).toHaveLength(1);
		expect(rej[0].indices).toEqual([47, 53, 66, 73]);
		expect((rej[0].details as { retracementRatio: number }).retracementRatio).toBeCloseTo(1.3507, 3);
	});

	it('swingDepth=2 の triple_top はネックライン交差が無く落ちる', async () => {
		// ネックライン 10,166,847（2 谷の終値平均）は山1 の終値 10,159,661 より上で、山1 より前の 60 本でこの水準を終値で上抜けたバーが無い。山1 の高値 10,290,000 はネックラインを超えるが終値は超えない（ヒゲで立った形）。
		const { patterns, candidates } = await detect(buildBtcJpy2026Candles(), {
			type: '1day',
			swingDepth: 2,
			patterns: ['triple_top'],
		});
		expect(patterns.filter((p) => p.type === 'triple_top')).toHaveLength(0);
		const rej = rejected(candidates, 'triple_top', 'no_neckline_cross_before_peak1');
		expect(rej.length).toBeGreaterThan(0);
		expect(rej[0].indices).toEqual([9, 17, 24]);
		// 戻り率は帯の中（0.75）。落ちたのは交差の不在であって戻り率ではない。
		expect((rej[0].details as { retracementRatio: number }).retracementRatio).toBeCloseTo(0.7468, 3);
	});

	it('double は構造ゲートを通っても先行トレンドを満たさなければ返さない', async () => {
		// 実データの double_bottom（谷 8/3 → 山 8/10 → 谷 8/14、戻り率 0.528）は構造ゲートを通るが、先行下降も要件になる。
		const { patterns } = await detect(buildBtcJpy2026Candles(), { type: '1day', swingDepth: 3 });
		const db = patterns.filter((p) => p.type === 'double_bottom');
		expect(db).toHaveLength(0);
	});
});
