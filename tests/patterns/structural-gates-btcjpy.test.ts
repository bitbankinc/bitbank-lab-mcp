/**
 * issue #126 の回帰テスト — BTC/JPY 日足の**実データ**に対する構造ゲートの挙動を固定する。
 *
 * fixture は `tests/fixtures/btc_jpy_1day_2026.ts`（2026-05-29〜08-26 の 90 本）。
 * この区間には偽陽性（7/13→7/21→8/3 が整合度 1.00 で「形成中」と報告される）と
 * 偽陰性（8/3→8/10→8/14 の安値切り上げ型が未検出）が同居している。
 *
 * 合成 fixture では**閾値の妥当性を検証できない**（閾値に合わせて合成できてしまう）ので、
 * 戻り率の帯とネックライン交差の判定はここで実データに対して固定する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBtcJpy2026Candles } from '../fixtures/btc_jpy_1day_2026.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { getDefaultParamsForTf } from '../../tools/patterns/config.js';
import {
	detectTroughZoneReentry,
	findPriorExtreme,
	RETRACEMENT_MAX,
	RETRACEMENT_MIN,
	validateReversalStructure,
} from '../../tools/patterns/structural.js';
import { detectSwingPoints } from '../../tools/patterns/swing.js';

const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);

/** fixture の idx（`detect_patterns` がスキャンする配列の位置と一致する） */
const IDX = {
	priorHigh: 42, // 2026-07-10 — 谷1(45) の直前スイング高値
	falseTrough1: 45, // 2026-07-13
	falseNeckline: 53, // 2026-07-21
	sharedTrough: 66, // 2026-08-03（偽陽性の谷2 / 正しい形の谷1）
	trueNeckline: 73, // 2026-08-10
	trueTrough2: 77, // 2026-08-14
	notAPivot: 79, // 2026-08-16
} as const;

const candles = buildBtcJpy2026Candles();
const pivots = detectSwingPoints(candles, { swingDepth: 3, strictPivots: true });
const pivotAt = (idx: number) => {
	const p = pivots.find((v) => v.idx === idx);
	if (!p) throw new Error(`no pivot at idx=${idx}`);
	return p;
};

function indicatorsOk() {
	return {
		ok: true as const,
		summary: 'ok',
		data: { chart: { candles, meta: { pastBuffer: 0 }, indicators: {} } },
		meta: {},
	};
}

describe('issue #126 構造ゲート — BTC/JPY 日足 実データ回帰', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	// ── 前提: ピボット抽出は変えていない ──
	describe('ピボット抽出（swing.ts は本 PR で触っていない）', () => {
		it('8/3(66) と 8/14(77) は安値ピボットで、8/16(79) はピボットではない', () => {
			const valleys = pivots.filter((p) => p.kind === 'L').map((p) => p.idx);
			expect(valleys).toContain(IDX.sharedTrough);
			expect(valleys).toContain(IDX.trueTrough2);
			expect(valleys).not.toContain(IDX.notAPivot);
		});

		it('8/14 の安値は 8/16 より低い（外部レビューの D3 が誤診である実データ上の根拠）', () => {
			expect(candles[IDX.trueTrough2].low).toBeLessThan(candles[IDX.notAPivot].low);
			expect(candles[IDX.trueTrough2].low).toBe(9_955_830);
			expect(candles[IDX.notAPivot].low).toBe(9_998_855);
		});
	});

	// ── 条件 1 / 2: 偽陽性が棄却され、理由が debug に残る ──
	describe('偽陽性 7/13 → 7/21 → 8/3', () => {
		it('ネックライン(7/21)が先行下落の起点(7/10)より上で、戻り率が 1.0 を超える', () => {
			const first = pivotAt(IDX.falseTrough1);
			const mid = pivotAt(IDX.falseNeckline);
			const prior = findPriorExtreme(pivots, first.idx, 'H');
			expect(prior?.idx).toBe(IDX.priorHigh);
			// 高安基準: 起点 10,467,388 < ネックライン 10,903,000
			expect(prior?.extremePrice).toBeLessThan(mid.extremePrice);

			const gate = validateReversalStructure({
				candles,
				pivots,
				first,
				mid,
				necklinePrice: mid.price,
				side: 'bottom',
			});
			expect(gate.ok).toBe(false);
			expect(gate.reason).toBe('neckline_above_pre_decline_high');
			expect(gate.retracementRatio).toBeGreaterThan(1);
			expect(gate.retracementRatio).toBeCloseTo(2.0463, 3);
		});

		it('谷2(8/3) の後、ネックライン到達前に谷ゾーンへ再進入している（8/16）', () => {
			const reentry = detectTroughZoneReentry({
				candles,
				first: pivotAt(IDX.falseTrough1),
				mid: pivotAt(IDX.falseNeckline),
				second: pivotAt(IDX.sharedTrough),
				untilIdx: candles.length - 1,
				side: 'bottom',
			});
			expect(reentry.reentered).toBe(true);
			expect(reentry.idx).toBe(IDX.notAPivot);
		});

		it('検出結果に含まれず、棄却理由が debug candidates に記録される', async () => {
			mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
			const res = await detectPatterns('btc_jpy', '1day', 90, {
				patterns: ['double_bottom', 'double_top'],
				includeForming: true,
				includeCompleted: true,
				view: 'debug',
				swingDepth: 3,
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;

			// 条件 1: 7/13-7/21-8/3 を構成点に持つパターンが出ない
			const offending = res.data.patterns.filter((p) => {
				const idxs = (p.pivots ?? []).map((v) => v.idx);
				return idxs.includes(IDX.falseTrough1) && idxs.includes(IDX.falseNeckline);
			});
			expect(offending).toHaveLength(0);

			// 条件 2: この形は候補としても組まれない。
			//
			// **#130 以前は `neckline_above_pre_decline_high` の棄却候補として残っていた。**
			// 当時この候補を組んでいたのは形成中パスだけで（7/13 と 8/3 は隣接ピボットではないため
			// 完成済みパスの走査には乗らない）、`tryFormingDoubleBottom` は谷ペアを新しい順に見て
			// **最初に成立したところで return する**。#130 以前は正しい 8/3 → 8/10 → 8/14 が
			// サイズ検査で落ちていたため走査が 7/13 まで遡り、そこで構造ゲートが働いていた。
			// 偽陰性を潰した今は手前で正しい形が成立するので、偽陽性はそもそも検査されない。
			//
			// 構造ゲート自体が今もこの形を弾くことは、上の
			// 「ネックライン(7/21)が先行下落の起点(7/10)より上で、戻り率が 1.0 を超える」が
			// `validateReversalStructure` を直接呼んで固定している。
			const cands =
				(res.meta?.debug as { candidates?: Array<{ accepted?: boolean; reason?: string; indices?: number[] }> })
					?.candidates ?? [];
			const offendingCands = cands.filter(
				(c) => (c.indices ?? []).includes(IDX.falseTrough1) && (c.indices ?? []).includes(IDX.falseNeckline),
			);
			expect(offendingCands).toHaveLength(0);

			// 代わりに、正しい形が accepted の候補として残る
			const accepted = cands.find((c) => c.accepted && (c.indices ?? []).includes(IDX.trueTrough2));
			expect(accepted?.indices).toEqual([IDX.sharedTrough, IDX.trueNeckline, IDX.trueTrough2]);
		});

		// 条件 4
		it('8/26 時点で forming にならない', async () => {
			mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
			const res = await detectPatterns('btc_jpy', '1day', 90, {
				patterns: ['double_bottom'],
				includeForming: true,
				includeCompleted: true,
				includeInvalid: true,
				view: 'debug',
				swingDepth: 3,
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			const forming = res.data.patterns.filter((p) => {
				const idxs = (p.pivots ?? []).map((v) => v.idx);
				return p.status === 'forming' && idxs.includes(IDX.falseNeckline);
			});
			expect(forming).toHaveLength(0);
		});
	});

	// ── include* フラグは独立した包含スイッチ ──
	describe('includeForming / includeCompleted / includeInvalid の独立性', () => {
		/**
		 * 旧実装は「completed バケットに invalid を入れてから `includeInvalid` で引き算する」形で、
		 * `includeCompleted: false` + `includeInvalid: true` が**どちらも返さない**到達不能な
		 * 組み合わせになっていた。`includeInvalid` の説明文は「含める」と読めるので契約違反。
		 *
		 * 本 PR で `expired` を足したことで、この穴は「`includeInvalid: true` にしても
		 * 期限切れが出ない」という形でも現れるようになるため、ここで固定する。
		 */
		it('includeCompleted=false + includeInvalid=true で invalid / expired が返る', async () => {
			mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
			const res = await detectPatterns('btc_jpy', '1day', 90, {
				includeForming: false,
				includeCompleted: false,
				includeInvalid: true,
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			// completed / forming は 1 件も混ざらない
			for (const p of res.data.patterns) {
				expect(['invalid', 'expired']).toContain(p.status);
			}
		});

		it('includeCompleted=true + includeInvalid=false に invalid / expired は混ざらない', async () => {
			mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
			const res = await detectPatterns('btc_jpy', '1day', 90, {
				includeForming: false,
				includeCompleted: true,
				includeInvalid: false,
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			for (const p of res.data.patterns) {
				expect(p.status === 'invalid' || p.status === 'expired').toBe(false);
			}
		});

		it('includeForming=true 単独では終端 status が混ざらない', async () => {
			mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
			const res = await detectPatterns('btc_jpy', '1day', 90, {
				includeForming: true,
				includeCompleted: false,
				includeInvalid: false,
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			for (const p of res.data.patterns) {
				expect(['forming', 'near_completion']).toContain(p.status);
			}
		});
	});

	// ── 正しい形が構造ゲートを通ること ──
	describe('正しい形 8/3 → 8/10 → 8/14（安値切り上げ型）', () => {
		it('構造ゲートを通過し、戻り率が帯の内側に収まる', () => {
			const first = pivotAt(IDX.sharedTrough);
			const mid = pivotAt(IDX.trueNeckline);
			const gate = validateReversalStructure({
				candles,
				pivots,
				first,
				mid,
				necklinePrice: mid.price,
				side: 'bottom',
			});
			expect(gate.ok).toBe(true);
			expect(gate.retracementRatio).toBeCloseTo(0.528, 3);
			expect(gate.retracementRatio).toBeGreaterThan(RETRACEMENT_MIN);
			expect(gate.retracementRatio).toBeLessThan(RETRACEMENT_MAX);
			// 谷1 より前にネックライン水準を終値で下抜けた事象が実在する
			expect(gate.necklineCrossIdx).toBeDefined();
			expect(gate.necklineCrossIdx).toBeLessThan(first.idx);
		});

		it('安値切り上げ型である（谷2 の安値 > 谷1 の安値）', () => {
			expect(pivotAt(IDX.trueTrough2).extremePrice).toBeGreaterThan(pivotAt(IDX.sharedTrough).extremePrice);
		});

		it('谷2 の後、ネックライン到達前に谷ゾーンへ再進入していない', () => {
			const reentry = detectTroughZoneReentry({
				candles,
				first: pivotAt(IDX.sharedTrough),
				mid: pivotAt(IDX.trueNeckline),
				second: pivotAt(IDX.trueTrough2),
				untilIdx: candles.length - 1,
				side: 'bottom',
			});
			expect(reentry.reentered).toBe(false);
		});

		/**
		 * **価格基準の選択根拠を実データで固定する。**
		 *
		 * 同じ構成点でも、戻り率は終値基準 0.222 / 高安基準 0.528 と倍以上動く。
		 * 終値基準では下限 {@link RETRACEMENT_MIN}=0.20 まで 2 ポイントしか余裕が無く、
		 * ノイズで正しいパターンが落ちる。高安基準なら帯の中央付近に収まる。
		 */
		/**
		 * **偽陰性を成立させていた 3 つの前提を、修正後の値として固定する（issue #130）。**
		 *
		 * #131 の時点ではこの `it` は「未検出の原因は構造ゲートではなく〜」という名前で、
		 * 3 つの前提が**未検出を生んでいる**ことを固定していた。#130 でその原因を潰したので、
		 * ここは同じ数値を「なぜその修正が要ったか」の側から固定し直してある。
		 * **数値の期待は 1 つも緩めていない**——不等号の向きも閾値もそのまま。
		 *
		 * 1. **ピボット間隔**: 山 → 谷2 は 4 本。日足の既定 `minBarsBetweenSwings` は 4 なので通る。
		 *    以前は検出器ローカルの `MIN_PIVOT_DISTANCE_BARS = 5` が `ctx.minDist` を上書きしていた。
		 * 2. **サイズ検査の価格基準**: 終値基準では閾値割れ、`extremePrice`（高安）基準なら通る。
		 * 3. **走査ループの端**: 谷2 は窓の最後のピボットなので、`i < pivots.length - 3` では
		 *    完成済みパスの走査に乗らなかった（3 ピボットなら `i + 2 < pivots.length`）。
		 */
		it('3 つの前提（間隔 4 本 / 高安基準 / 最終ピボット）が揃って検出される', () => {
			const [first, mid, second] = [pivotAt(IDX.sharedTrough), pivotAt(IDX.trueNeckline), pivotAt(IDX.trueTrough2)];

			// 1. 山 → 谷2 は 4 本。日足の既定 minBarsBetweenSwings（4）とちょうど同値で、
			//    「5 本」を要求していた検出器ローカル定数を外したことで通るようになった。
			expect(second.idx - mid.idx).toBe(4);
			expect(mid.idx - first.idx).toBe(7);
			expect(getDefaultParamsForTf('1day').minBarsBetweenSwings).toBe(4);

			// 2. サイズ検査（validateTopSize / validateBottomSize）の価格基準。
			//    終値基準だと閾値割れ、高安基準なら通る。
			const heightPctClose = Math.abs(first.price - mid.price) / Math.max(first.price, mid.price);
			const peakHeightPctClose = (mid.price - (first.price + second.price) / 2) / ((first.price + second.price) / 2);
			expect(heightPctClose).toBeLessThan(0.03); // MIN_PATTERN_HEIGHT_PCT
			expect(peakHeightPctClose).toBeLessThan(0.05); // MIN_DEPTH_PCT

			const avgExt = (first.extremePrice + second.extremePrice) / 2;
			const heightPctExt =
				Math.abs(first.extremePrice - mid.extremePrice) / Math.max(first.extremePrice, mid.extremePrice);
			const peakHeightPctExt = (mid.extremePrice - avgExt) / avgExt;
			expect(heightPctExt).toBeGreaterThan(0.03);
			expect(peakHeightPctExt).toBeGreaterThan(0.05);

			// 3. 谷2 は窓の最後のピボット。旧 `i < pivots.length - 3` では走査に乗らない。
			expect(pivots[pivots.length - 1].idx).toBe(IDX.trueTrough2);
		});

		/**
		 * **受け入れ条件そのもの（issue #130）。** 8/3 → 8/10 → 8/14 が完成済みの
		 * `double_bottom` として検出され、ネックライン突破が 8/19（idx 82）で確定する。
		 *
		 * 突破足の終値 10,949,999 はネックライン（8/10 の終値 10,191,324）を 7.4% 上回り、
		 * `BREAKOUT_BUFFER_PCT`（1.5%）を明確に超えている。8/17（10,278,279）と
		 * 8/18（10,330,037）はバッファ込みの閾値 10,344,194 に届かないので、
		 * **突破の初出は 8/19 で一意に決まる**。
		 */
		it('完成済み double_bottom として検出され、ブレイクが 8/19（idx 82）で確定する', async () => {
			mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
			const res = await detectPatterns('btc_jpy', '1day', 90, {
				patterns: ['double_bottom'],
				includeCompleted: true,
				view: 'debug',
				swingDepth: 3,
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;

			const found = res.data.patterns.filter((p) => {
				const idxs = (p.pivots ?? []).map((v) => v.idx);
				return idxs.includes(IDX.sharedTrough) && idxs.includes(IDX.trueTrough2);
			});
			expect(found).toHaveLength(1);
			expect((found[0].pivots ?? []).map((v) => v.idx)).toEqual([IDX.sharedTrough, IDX.trueNeckline, IDX.trueTrough2]);
			expect(found[0].breakoutBarIndex).toBe(82);
			expect(found[0].confirmation).toMatchObject({ type: 'neckline_breakout', idx: 82 });
			expect(candles[82].isoTime.slice(0, 10)).toBe('2026-08-19');
			// 突破の初出が 8/19 で一意であること（8/17 / 8/18 はバッファ込み閾値に届かない）
			const necklineThreshold = pivotAt(IDX.trueNeckline).price * 1.015;
			expect(candles[80].close).toBeLessThan(necklineThreshold);
			expect(candles[81].close).toBeLessThan(necklineThreshold);
			expect(candles[82].close).toBeGreaterThan(necklineThreshold);
		});

		/**
		 * **issue #133 の修正を固定する — `includeForming: true` でも完成済みが返る。**
		 *
		 * かつて dedup は status を見ずに勝者を選んでいた（`globalDedup` は confidence →
		 * `range.end`、`deduplicatePatterns` は `range.end` 最優先）ため、同一構成点で
		 * 完成済み（整合度 0.96・突破確定足 8/19 で終わる）と形成中（同 1.00・最新足まで
		 * 伸びる）の両方が成立すると形成中が完成済みを押し出し、`includeCompleted: true` で
		 * 明示的に完成済みを要求した呼び出し側が `forming` を受け取っていた。
		 * このテストはその不具合を「既知の不整合」として凍結していたもの。
		 *
		 * #133 で dedup の勝者選択を `rankPatterns` と同じ **statusScore 最優先**
		 * （単一ソース: `patterns/ranking.ts` の `statusScore`）に揃えたので、
		 * ここでは**突破確定済みの完成済みが形成中に押し出されないこと**を固定する。
		 *
		 * status の期待値が `'completed'` ではなく **undefined** なのは、完成済み double が
		 * status を付与しない既存契約のため（「status 未設定は完成済み扱い」——
		 * `detect_patterns.ts` の status バケット分け / `ranking.ts` の statusScore=2）。
		 * 完成済みであることは status ではなく突破確定（`breakoutBarIndex` /
		 * `confirmation`）で識別する。forming 候補はこれらを持たない。
		 */
		it('#133 修正済み: includeForming: true でも完成済み（突破 8/19）が形成中に押し出されない', async () => {
			mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
			const res = await detectPatterns('btc_jpy', '1day', 90, {
				patterns: ['double_bottom'],
				includeForming: true,
				includeCompleted: true,
				view: 'debug',
				swingDepth: 3,
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			const found = res.data.patterns.filter((p) => {
				const idxs = (p.pivots ?? []).map((v) => v.idx);
				return idxs.includes(IDX.sharedTrough) && idxs.includes(IDX.trueTrough2);
			});
			expect(found).toHaveLength(1);
			// 完成済み＝ status 未設定（既存契約）。forming（status='forming'）ではないこと。
			expect(found[0].status).toBeUndefined();
			// 完成済みの実体は突破確定で識別する（1 つ上の it と同じ 8/19 = idx 82）
			expect(found[0].breakoutBarIndex).toBe(82);
			expect(found[0].confirmation).toMatchObject({ type: 'neckline_breakout', idx: 82 });
			expect((found[0].pivots ?? []).map((v) => v.idx)).toEqual([IDX.sharedTrough, IDX.trueNeckline, IDX.trueTrough2]);
		});

		it('高安基準は帯の中央付近、終値基準は下限すれすれ（基準選択の根拠）', () => {
			const first = pivotAt(IDX.sharedTrough);
			const mid = pivotAt(IDX.trueNeckline);
			const prior = findPriorExtreme(pivots, first.idx, 'H');
			expect(prior).toBeDefined();
			if (!prior) return;

			const extremeRatio = (mid.extremePrice - first.extremePrice) / (prior.extremePrice - first.extremePrice);
			const closeRatio = (mid.price - first.price) / (prior.price - first.price);

			expect(extremeRatio).toBeCloseTo(0.528, 3);
			expect(closeRatio).toBeCloseTo(0.222, 3);
			// 終値基準の下限までの余裕は 2.2 ポイント / 高安基準は 32.8 ポイント
			expect(closeRatio - RETRACEMENT_MIN).toBeLessThan(0.03);
			expect(extremeRatio - RETRACEMENT_MIN).toBeGreaterThan(0.3);
		});
	});
});
