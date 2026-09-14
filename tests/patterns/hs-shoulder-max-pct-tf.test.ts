/**
 * issue #244 Phase 2 — H&S / 逆 H&S の**肩の同水準判定**を時間足別にした件の回帰テスト。
 *
 * `HS_SHOULDER_MAX_PCT`（5% 固定）は ATR 換算で `1day` 1.8 ATR に対し **`1hour` 8.8 ATR** で、
 * 短い足では同水準判定が実質機能していなかった（#244 Phase 1 結果 3）。`getHsShoulderMaxPctForTf`
 * が `getSizeThresholdsForTf` と同じ ATR 比テーブルを 1day の 5% に掛けて時間足別の上限を返し、
 * **肩ゲートだけ**がその値を使う。
 *
 * 本テストが固定するのは 4 点:
 *
 * 1. `getHsShoulderMaxPctForTf` の表（時間足ごとの値・`1day` 以上の据え置き・未知の据え置き）と、
 *    ATR 比 × アンカーという導出。**`getSizeThresholdsForTf(tf).depthPct` と数値が一致するのは
 *    偶然**（アンカーが同じ 5%）で、意味が違う 2 つの量なので別関数として持っていること
 * 2. 実データ D（`btc_jpy_1hour_2026_09_05`）の `1hour` で、Phase 1.5 §10 が「呼べない」と判定した
 *    **形 X**（左肩 30 / 頭 49 / 右肩 85 系）が `shoulders_not_near:cap` で落ち、
 *    `details.shoulderMaxPct` が **0.0104** であること
 * 3. **窓生成（`outerShoulderOk`）は 5% のまま**であること——`1hour` で肩差 3% の 5 点が
 *    `view=debug` の候補として**現れて**理由コード付きで落ちる。窓生成まで締めていれば
 *    候補に出ないので、この形で診断性を固定する（#244 決定コメントの宿題 1）
 * 4. `1day` の挙動が 1 つも変わっていないこと（アンカー据え置き）
 *
 * 実データケースが `patterns` で種別を絞るのは、`view=debug` の候補配列が **cap 200 件**で
 * トリムされるため（`neckline-side-hs.test.ts` と同じ理由）。
 */
import { describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import {
	getDefaultToleranceForTf,
	getHsShoulderMaxPctForTf,
	getSizeThresholdsForTf,
	resolveParams,
} from '../../tools/patterns/config.js';
import { detectHeadAndShoulders } from '../../tools/patterns/detect_hs.js';
import { linearRegressionWithR2, near as nearFn, pct as pctFn } from '../../tools/patterns/regression.js';
import { HS_SHOULDER_MAX_PCT } from '../../tools/patterns/structural.js';
import { detectSwingPoints, filterPeaks, filterValleys, type Pivot } from '../../tools/patterns/swing.js';
import type { CandDebugEntry, CandleData, DetectContext } from '../../tools/patterns/types.js';
import { asMockResult, assertOk } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { buildBtcJpy1hour20260905Candles } from '../fixtures/btc_jpy_1hour_2026_09_05.js';

/**
 * 1day を 1.0 とした ATR 比。**`config.ts` の `getSizeThresholdsForTf` の docstring の表と同一。**
 * テスト側に写しを置くのは、**実装の表と導出規則が食い違ったら落とす**ため
 * （実装から import すると同語反復になる）。
 */
const ATR_RATIO: Readonly<Record<string, number>> = {
	'1min': 0.0264,
	'5min': 0.0589,
	'15min': 0.1021,
	'30min': 0.1443,
	'1hour': 0.2073,
	'4hour': 0.4082,
	'8hour': 0.5774,
	// biome-ignore lint/suspicious/noApproximativeNumericConstant: config.ts の docstring の表と同じ 4 桁の値を持つのが本テーブルの要件。Math.SQRT1_2 に置き換えると出典と字面が食い違う
	'12hour': 0.7071,
};

/** 実データケースの時間足。 */
const TF = '1hour';

/** `config.ts` の各表と同じ 4 桁丸め。 */
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

describe('getHsShoulderMaxPctForTf の表（issue #244 Phase 2）', () => {
	it('時間足ごとの値が ATR 比 × アンカー 0.05（4 桁丸め）と一致する', () => {
		const table: ReadonlyArray<readonly [string, number]> = [
			['1min', 0.0013],
			['5min', 0.0029],
			['15min', 0.0051],
			['30min', 0.0072],
			['1hour', 0.0104],
			['4hour', 0.0204],
			['8hour', 0.0289],
			['12hour', 0.0354],
		];
		for (const [tf, expected] of table) {
			expect(getHsShoulderMaxPctForTf(tf), tf).toBe(expected);
			// 導出（ATR 比 × アンカー）と一致すること。表を手で書き換えたら落ちる。
			expect(round4(HS_SHOULDER_MAX_PCT * ATR_RATIO[tf]), tf).toBe(expected);
		}
	});

	it('1day 以上はアンカー（HS_SHOULDER_MAX_PCT = 5%）を据え置く', () => {
		for (const tf of ['1day', '1week', '1month']) {
			expect(getHsShoulderMaxPctForTf(tf), tf).toBe(HS_SHOULDER_MAX_PCT);
		}
		expect(HS_SHOULDER_MAX_PCT).toBe(0.05);
	});

	it('未知の時間足・空文字・非文字列もアンカーへ畳む', () => {
		// エッジケース: 未知値 / 空 / 単一要素でない入力（`String(tf)` で畳まれる経路）。
		for (const tf of ['', '3hour', '2week', 'unknown', '1DAY']) {
			expect(getHsShoulderMaxPctForTf(tf), JSON.stringify(tf)).toBe(HS_SHOULDER_MAX_PCT);
		}
		expect(getHsShoulderMaxPctForTf(undefined as unknown as string)).toBe(HS_SHOULDER_MAX_PCT);
	});

	it('時間足の順に単調非減少（短い足ほど厳しい）', () => {
		const order = ['1min', '5min', '15min', '30min', '1hour', '4hour', '8hour', '12hour', '1day', '1week', '1month'];
		for (let i = 1; i < order.length; i++) {
			expect(getHsShoulderMaxPctForTf(order[i]), `${order[i - 1]} → ${order[i]}`).toBeGreaterThanOrEqual(
				getHsShoulderMaxPctForTf(order[i - 1]),
			);
		}
	});

	it('ATR 換算では全時間足がほぼ同じ本数になる（本変更の狙い）', () => {
		// #152 の実測 1day ATR 2.75%。時間足の ATR = 2.75% × ATR 比。
		const ATR_1DAY = 0.0275;
		for (const [tf, ratio] of Object.entries(ATR_RATIO)) {
			const atrCount = getHsShoulderMaxPctForTf(tf) / (ATR_1DAY * ratio);
			expect(atrCount, tf).toBeGreaterThan(1.7);
			expect(atrCount, tf).toBeLessThan(1.9);
		}
		expect(HS_SHOULDER_MAX_PCT / ATR_1DAY).toBeCloseTo(1.82, 2);
	});

	it('`getSizeThresholdsForTf(tf).depthPct` と数値が一致するが、別の量を測る別関数である', () => {
		// アンカーが `MIN_DEPTH_PCT` と同じ 5% なので**数値は一致する**。これは偶然で、
		// 流用してはいけない（`depthPct` は谷の深さの**下限**、本関数は肩の同水準の**上限**で極性が逆）。
		// 一致が崩れたらどちらかのアンカーが動いたということなので、そのときは両方の docstring を
		// 読み直すこと——このテストは「勝手に片方だけ動かす」を検出するための見張り。
		for (const tf of ['1min', '5min', '15min', '30min', '1hour', '4hour', '8hour', '12hour', '1day', '1week']) {
			expect(getHsShoulderMaxPctForTf(tf), tf).toBe(getSizeThresholdsForTf(tf).depthPct);
		}
	});
});

// ── ヘルパー（合成 5 点） ──

function mkCandle(o: number, h: number, l: number, c: number, i: number): CandleData {
	// `1hour` の等間隔な時刻列。先行トレンド判定・期間表示が時刻を読むので必ず入れる。
	return {
		open: o,
		high: h,
		low: l,
		close: c,
		isoTime: dayjs.utc('2026-01-01T00:00:00Z').add(i, 'hour').toISOString(),
	};
}

/**
 * `H-L-H-L-H`（または `L-H-L-H-L`）の 5 点を持つ合成系列を組む。
 * `enumerateHsWindows` は肩リストと谷リストしか見ないので、間の平坦なバーは形に効かない。
 */
function buildFive(
	kinds: ReadonlyArray<'H' | 'L'>,
	prices: readonly number[],
	tf: string,
): { ctx: DetectContext; debug: DetectContext['debugCandidates'] } {
	const idxs = [0, 10, 20, 30, 40];
	const base = 100;
	const candles: CandleData[] = Array.from({ length: 50 }, (_, i) => mkCandle(base, base + 1, base - 1, base, i));
	idxs.forEach((idx, k) => {
		const p = prices[k];
		candles[idx] = mkCandle(p, p + 0.5, p - 0.5, p, idx);
	});
	const pivots: Pivot[] = idxs.map((idx, k) => ({ idx, price: prices[k], kind: kinds[k], extremePrice: prices[k] }));
	const resolved = resolveParams(tf, {});
	const debug: DetectContext['debugCandidates'] = [];
	const tol = resolved.tolerancePct;
	return {
		debug,
		ctx: {
			candles,
			pivots,
			allPeaks: pivots.filter((p) => p.kind === 'H'),
			allValleys: pivots.filter((p) => p.kind === 'L'),
			tolerancePct: tol,
			headProminencePct: resolved.headProminencePct,
			sizeThresholds: getSizeThresholdsForTf(tf),
			hsShoulderMaxPct: getHsShoulderMaxPctForTf(tf),
			minDist: 2,
			want: new Set(),
			includeForming: false,
			debugCandidates: debug,
			type: tf,
			swingDepth: resolved.swingDepth,
			near: (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * tol,
			pct: (a: number, b: number) => ((b - a) / Math.max(1, a)) * 100,
			lrWithR2: (pts) => linearRegressionWithR2(pts),
		},
	};
}

describe('窓生成（outerShoulderOk）は 5% のまま（#244 決定コメントの宿題 1）', () => {
	// 肩差 3%（左肩 100 / 右肩 103 → relDiff = 3/103 ≈ 2.913%）。
	//
	// - **肩ゲート**（`1hour` = 1.04%）: 超えるので落ちる
	// - **窓生成**（5% 固定）: 通るので候補は生成される
	//
	// 窓生成まで時間足別にしていたら 2.913% > 1.04% で窓自体が作られず、
	// `view=debug` に何も残らない（無音の偽陰性）。**この形で診断性を固定する。**
	const SHOULDER_DIFF_PCT = 3 / 103;

	it('前提: 肩差 3% は 1hour の肩ゲートを超え、窓生成の 5% は超えない', () => {
		expect(SHOULDER_DIFF_PCT).toBeGreaterThan(getHsShoulderMaxPctForTf('1hour'));
		expect(SHOULDER_DIFF_PCT).toBeLessThan(HS_SHOULDER_MAX_PCT);
		// `tolerancePct` 側は通ること（通らないと理由コードが `:both` になり `:cap` を固定できない）。
		expect(SHOULDER_DIFF_PCT).toBeLessThan(getDefaultToleranceForTf('1hour'));
	});

	it('H&S: 1hour で肩差 3% の 5 点は候補として現れ、shoulders_not_near:cap で落ちる', () => {
		const { ctx, debug } = buildFive(['H', 'L', 'H', 'L', 'H'], [100, 80, 130, 80, 103], '1hour');
		const res = detectHeadAndShoulders(ctx);

		// 出力には出ない（肩ゲートで落ちる）。
		expect(res.patterns.filter((p) => p.type === 'head_and_shoulders')).toHaveLength(0);

		// **候補としては現れる**——これが窓生成を据え置いたことの検証。
		const cand = debug.find(
			(d) => d.type === 'head_and_shoulders' && d.accepted === false && d.reason?.startsWith('shoulders_not_near'),
		);
		expect(cand, '窓生成まで締めると候補が 1 件も出ず、無音の偽陰性になる').toBeDefined();
		expect(cand?.reason).toBe('shoulders_not_near:cap');
		expect(cand?.indices).toEqual([0, 10, 20, 30, 40]);
		const details = cand?.details as Record<string, unknown> | undefined;
		expect(details?.shoulderMaxPct).toBe(0.0104);
		expect(details?.shouldersDiffPct).toBeCloseTo(SHOULDER_DIFF_PCT, 6);
	});

	it('逆 H&S: 1hour で肩差 3% の 5 点も同じく候補として現れて落ちる', () => {
		const { ctx, debug } = buildFive(['L', 'H', 'L', 'H', 'L'], [100, 120, 70, 120, 103], '1hour');
		const res = detectHeadAndShoulders(ctx);

		expect(res.patterns.filter((p) => p.type === 'inverse_head_and_shoulders')).toHaveLength(0);
		const cand = debug.find(
			(d) =>
				d.type === 'inverse_head_and_shoulders' && d.accepted === false && d.reason?.startsWith('shoulders_not_near'),
		);
		expect(cand, '窓生成まで締めると候補が 1 件も出ず、無音の偽陰性になる').toBeDefined();
		expect(cand?.reason).toBe('shoulders_not_near:cap');
		const details = cand?.details as Record<string, unknown> | undefined;
		expect(details?.shoulderMaxPct).toBe(0.0104);
	});

	it('1day では同じ 5 点が肩ゲートも通る（アンカー据え置きの確認）', () => {
		// 肩差 2.913% ≤ `1day` の肩ゲート 5%。`tolerancePct`（1day = 4%）も通る。
		// **#244 の前後で 1day の挙動が 1 つも変わっていないこと**を、同じ入力で示す。
		const { ctx, debug } = buildFive(['H', 'L', 'H', 'L', 'H'], [100, 80, 130, 80, 103], '1day');
		detectHeadAndShoulders(ctx);
		const shoulderRejects = debug.filter((d) => d.reason?.startsWith('shoulders_not_near'));
		expect(shoulderRejects).toHaveLength(0);
	});
});

describe('実データ D の 1hour: Phase 1.5 の「形 X」が shoulders_not_near:cap で落ちる', () => {
	/**
	 * Phase 1.5（tjackiet/bitbank-lab-mcp#244 の計測記録 §10）が「呼べない」と判定した**形 X** の
	 * 4 変種（左肩 30 / 42、右肩 85 / 91）と**形 X'**（左肩 25）。実データ D の idx。
	 * 肩 `relDiff` は 2.076〜2.719%。
	 *
	 * 判定理由（§10）: 左右の肩が価格帯として重ならない（右肩の安値が左半分の最高値より 1.53% 高い）／
	 * 頭の突出が非対称／頭からブレイクまでが一本調子で、「右肩」は途中の −1.89% の押しでしかない。
	 * **「逆 H&S」ではなく「頭の後の上昇トレンドの押し目」。**
	 *
	 * **`swingDepth` ごとに現れる変種が違う**（ピボット列が変わるため）。右肩 85 の 2 変種は
	 * `swingDepth=3`（1hour の tf-auto 値）、右肩 91 の 2 変種と形 X' は `swingDepth=2` で出る。
	 */
	const FORM_X_BY_SWING_DEPTH: ReadonlyArray<readonly [number, readonly string[]]> = [
		[3, ['42-45-49-83-85', '30-32-49-83-85']],
		[2, ['42-45-49-83-91', '30-39-49-83-91', '25-39-49-83-91']],
	];

	/**
	 * `detect_patterns.ts` と同じ順序で ctx を組み、H&S 検出器を**直接**呼ぶ。
	 *
	 * `detectPatterns` 経由にしないのは、`view=debug` の候補配列が **cap 200 件**でトリムされ
	 * （`candidatesTrimmed`）、`swingDepth=2` の 1,797 件から目的の窓が押し出されるため。
	 * 本テストが見たいのは棄却理由と実効閾値であって出力の整形ではない。
	 */
	function debugCandidatesFor(swingDepth: number): CandDebugEntry[] {
		const candles = buildBtcJpy1hour20260905Candles() as unknown as CandleData[];
		const resolved = resolveParams(TF, { swingDepth });
		const pivots = detectSwingPoints(candles as never, { swingDepth: resolved.swingDepth, strictPivots: true });
		const debugCandidates: CandDebugEntry[] = [];
		detectHeadAndShoulders({
			candles,
			pivots,
			allPeaks: filterPeaks(pivots),
			allValleys: filterValleys(pivots),
			tolerancePct: resolved.tolerancePct,
			headProminencePct: resolved.headProminencePct,
			sizeThresholds: getSizeThresholdsForTf(TF),
			hsShoulderMaxPct: getHsShoulderMaxPctForTf(TF),
			minDist: resolved.minBarsBetweenSwings,
			want: new Set(),
			includeForming: false,
			debugCandidates,
			type: TF,
			swingDepth: resolved.swingDepth,
			near: (a: number, b: number) => nearFn(a, b, resolved.tolerancePct),
			pct: pctFn,
			lrWithR2: linearRegressionWithR2,
			tz: 'Asia/Tokyo',
		});
		return debugCandidates;
	}

	it.each(
		FORM_X_BY_SWING_DEPTH,
	)('swingDepth=%i: 形 X / X’ が `shoulders_not_near:cap` で落ち、details.shoulderMaxPct が 0.0104', (swingDepth, keys) => {
		const cands = debugCandidatesFor(swingDepth);
		const byIdx = new Map(
			cands
				.filter((c) => c.type === 'inverse_head_and_shoulders')
				.map((c) => [(c.indices ?? []).join('-'), c] as const),
		);
		for (const key of keys) {
			const c = byIdx.get(key);
			expect(c, `${key} が候補に出ていない（窓生成が締まっている可能性）`).toBeDefined();
			expect(c?.accepted, key).toBe(false);
			expect(c?.reason, key).toBe('shoulders_not_near:cap');
			const details = c?.details as Record<string, unknown> | undefined;
			expect(details?.shoulderMaxPct, key).toBe(0.0104);
			// 肩 relDiff は §10 の 2.076〜2.719% の帯に入る（`1hour` の閾値 1.04% の 2 倍以上）。
			expect(details?.shouldersDiffPct as number, key).toBeGreaterThan(0.0207);
			expect(details?.shouldersDiffPct as number, key).toBeLessThan(0.0272);
		}
	});

	it('落ちた理由は `:cap` であって `:tolerance` / `:both` ではない（tolerancePct は通っている）', () => {
		// `1hour` の tf-auto `tolerancePct` は 5% で、肩差 2.5% は通る。**落としているのは本 PR の
		// 時間足別 cap だけ**であることを理由コードの内訳で固定する（#244 以前は 3 変種とも accepted）。
		const tol = getDefaultToleranceForTf(TF);
		expect(tol).toBeGreaterThan(0.0272);
	});

	it('形 X は data.patterns に残らない（公開経路）', async () => {
		const candles = buildBtcJpy1hour20260905Candles();
		vi.mocked(analyzeIndicators).mockResolvedValueOnce(
			asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
		);
		const res = await detectPatterns('btc_jpy', TF, candles.length, {
			view: 'debug',
			patterns: ['inverse_head_and_shoulders'],
			swingDepth: 3,
		});
		assertOk(res);
		const idxsOf = (p: Record<string, unknown>) =>
			((p.pivots as Array<{ idx: number }>) ?? []).map((v) => v.idx).join('-');
		const got = (res.data.patterns as Array<Record<string, unknown>>).map(idxsOf);
		for (const key of FORM_X_BY_SWING_DEPTH.flatMap(([, keys]) => keys)) expect(got, key).not.toContain(key);
	});
});
