/**
 * issue #138 欠陥 2-1 の回帰テスト — 構造ゲート（`validateReversalStructure`）の
 * triple / H&S への横展開。
 *
 * #131 は構造ゲートを double にだけ配線し、「head_and_shoulders / triple への適用は
 * 本 PR では行っていない——検出件数への影響の確認が別途要るため」と明記して保留した。
 * 本ファイルはその回収ぶんの挙動を固定する。
 *
 * 合成データでは**閾値の妥当性は検証できない**（閾値に合わせて作れてしまう）。合成側で
 * 固定するのは「先行トレンドを伴う形は残り、同じ窓の逆向きの読みが落ちること」という
 * **相対関係**だけで、閾値そのものは実データ（`tests/fixtures/btc_jpy_1day_2026.ts`）側で
 * 固定する。
 */
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

/**
 * 先行トレンド → 三尊ならぬ三点反転 → ネックライン突破、という**反転の形**を作る。
 *
 * `side='bottom'` なら先行下落（13.0M → 11.0M）のあと 11.0M を 3 回試して 11.7M を上抜ける。
 * ネックライン（11.7M）は先行下落の起点（13.0M）より下にあるので戻り率は約 0.35 で帯の中。
 */
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
			// ネックライン水準を第1構成点より前に終値で抜けたバーがある＝ゲート通過の証拠。
			expect(hit?.structureGate?.necklineCrossIdx).toBeDefined();
		});

		it(`同じ窓の逆向きの読み（${mirror}）は retracement_out_of_band で落ちる`, async () => {
			// issue #138 欠陥 2 の「同一の窓で triple_top と triple_bottom が両方検出される」に対応する。
			// 反転の形を作ると、ネックラインが先行値幅の起点と一致する側（戻り率 1.0）が逆向きの読みになる。
			const { patterns, candidates } = await detect(reversalSeries(side));
			expect(patterns.filter((p) => p.type === mirror)).toHaveLength(0);
			const rej = rejected(candidates, mirror, 'retracement_out_of_band');
			expect(rej.length).toBeGreaterThan(0);
			expect((rej[0].details as { retracementRatio: number }).retracementRatio).toBeCloseTo(1, 3);
		});
	}
});

describe('detect_patterns: 実データに対する triple / H&S の構造ゲート（issue #138 欠陥 2-1）', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('#139 が「実在する H&S」として固定した形成中 H&S は既定 swingDepth で残る', async () => {
		// 左肩 idx 38 / 頭 53 / 谷 66 / 右肩 73、整合度 0.78。#139 の CHANGELOG が
		// 「実在する H&S を落としていないことの確認」として記録したもの。
		const { patterns } = await detect(buildBtcJpy2026Candles(), { type: '1day' });
		const hs = patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs).toBeDefined();
		expect(hs?.confidence).toBe(0.78);
		// ゲートは**適用されたうえで通っている**（素通しではない）。
		expect(hs?.structureGate?.retracementRatio).toBeCloseTo(0.7661, 3);
		expect(hs?.structureGate?.priorExtremeIdx).toBe(33);
		expect(hs?.structureGate?.necklineCrossIdx).toBe(9);
	});

	it('swingDepth=3 の H&S: 縮退した 4 点の読みは落ち、#146 以降は 5 点の読みが残る', async () => {
		// **左肩 idx 47 で読んだ 4 点の形は落ちたまま。** 左肩-頭の間に谷ピボットが無いため
		// サイズ検査ともども頭-戻り-右肩の 3 点に縮退し、`first` は頭（idx 53）になる。
		// 頭への上昇 851,964 円に対し谷までの下落が 1,150,754 円（戻り率 1.35）で、
		// ネックライン 10,002,960 は上昇の起点 10,051,036 より**下**にある。
		//
		// **一方 5 点の読み（左肩 38 / 谷 45 / 頭 53 / 谷 66 / 右肩 73）は #146 で残るようになった。**
		// 旧実装の窓生成は「配列上で連続する 5 ピボット」を要求しており、swingDepth=3 の
		// ピボット列は `… H38 H42 L45 H47 H53 L66 H73 …` と交互が崩れているため、この 5 点は
		// **窓として一度も生成されなかった**（候補にすら残らない偽陰性）。肩 2 つ + その間の
		// 最高値を頭に取る窓生成にしたことで生成され、構造ゲートを**通過して**残る。
		// 値動きとしては #139 の CHANGELOG が「実在する H&S」として既定 swingDepth で固定したもの
		// （頭 10,849,999 / 谷 10,002,960 / 右肩 10,191,324）と同じで、swingDepth=3 では
		// 縮退した 4 点ではなく 5 点の構造として読める、という違い。
		const { patterns, candidates } = await detect(buildBtcJpy2026Candles(), { type: '1day', swingDepth: 3 });

		const hs = patterns.filter((p) => p.type === 'head_and_shoulders');
		expect(hs).toHaveLength(1);
		expect(hs[0].pivots?.map((q) => q.idx)).toEqual([38, 45, 53, 66, 73]);
		// ゲートは**適用されたうえで通っている**（素通しではない）。
		expect(hs[0].structureGate?.retracementRatio).toBeCloseTo(0.3923, 3);
		expect(hs[0].structureGate?.priorExtremeIdx).toBe(33);
		expect(hs[0].structureGate?.necklineCrossIdx).toBe(9);

		const rej = rejected(candidates, 'head_and_shoulders', 'neckline_below_pre_decline_low');
		expect(rej).toHaveLength(1);
		expect(rej[0].indices).toEqual([47, 53, 66, 73]);
		expect((rej[0].details as { retracementRatio: number }).retracementRatio).toBeCloseTo(1.3507, 3);
	});

	it('swingDepth=2 の triple_top はネックライン交差が無く落ちる', async () => {
		// ネックライン 10,166,847（2 谷の終値平均）は**山1 の終値 10,159,661 より上**。
		// 山1 より前の 60 本でこの水準を終値で上抜けたバーが無く、下抜けという事象が定義できない。
		// 山1 の高値 10,290,000 はネックラインを超えるが終値は超えない——ヒゲで立った形。
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

	it('double の検出結果は構造ゲートの横展開で変わらない', async () => {
		// #131 で既にゲートを通っている double は本 PR の対象外。実データの double_bottom
		// （谷 8/3 → 山 8/10 → 谷 8/14、戻り率 0.528）が従来どおり返ることを固定する。
		const { patterns } = await detect(buildBtcJpy2026Candles(), { type: '1day', swingDepth: 3 });
		const db = patterns.filter((p) => p.type === 'double_bottom');
		expect(db).toHaveLength(1);
		expect(db[0].confidence).toBe(0.96);
		expect(db[0].structureGate?.retracementRatio).toBeCloseTo(0.528, 3);
	});
});
