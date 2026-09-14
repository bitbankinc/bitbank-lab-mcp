/**
 * issue #178 項目 4 — double の「同水準」判定に高さ相対の hard gate を足した件の回帰テスト。
 *
 * 元の欠陥は triple（#138 / PR #176）とまったく同じ形で、**同水準を価格水準の % だけで
 * 測っていた**こと（`near` の `tolerancePct` と `isSameLevel` の `DOUBLE_LEVEL_MAX_PCT`。
 * どちらも分母が価格水準で、パターン自身の高さと無関係）。
 *
 * ## double では指標が意味を持つ（H&S との違い）
 *
 * `mainPoints = [山1, 山2]` / `allPoints = [山1, 谷, 山2]` なので **分子の端点が分母の端点**。
 * `spreadRatio` は「2 山の差がパターンの深さの何割か」という自己完結した命題になる。
 * H&S（#178 項目 3）で同じゲートを足さなかったのは、あちらは `heightAbs` が頭と谷で決まり
 * **肩（分子）が分母の端点にならない**ため指標として意味が薄いから。
 *
 * ## 本テストが固定するもの
 *
 * 1. `validateLevelDiff` の閾値・境界・欠損時の挙動（triple の `validateLevelSpread` と同一式）
 * 2. **理由コードの語彙が triple と別**であること（#193 / PR #194 の `▼ reason 横断合計` で
 *    「3 点のばらつき」と「2 点の差」が 1 つの数字に潰れないようにするため）
 * 3. 完成済み 4 経路（strict top / strict bottom / relaxed top / relaxed bottom）で効くこと
 * 4. **呼び出し位置が最後**であること——手前の検査で落ちる候補の `reason` を横取りしない
 * 5. `spreadRatio` の**実効上界が `min(tolerancePct, DOUBLE_LEVEL_MAX_PCT) / depthPct`** で
 *    決まること。分子は終値・分母は高安なので `spreadRatio <= 1` は成り立たず、`1day` でも
 *    0.5 を超えられる（初版は「幾何上界 1.0」「`1day` は到達不能」と書いていた。PR #195 で訂正）
 */
import { describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { getSizeThresholdsForTf } from '../../tools/patterns/config.js';
import {
	DOUBLE_LEVEL_MAX_PCT,
	levelSpreadMetrics,
	MAX_LEVEL_SPREAD_RATIO,
	relDiff,
	validateLevelDiff,
	validateLevelSpread,
	validatePatternSize,
} from '../../tools/patterns/structural.js';
import { asMockResult } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';

type Candidate = { type: string; accepted: boolean; reason?: string; details?: Record<string, number | null> };

/**
 * ヒゲ 0 のローソク（`extremePrice === price`）。
 *
 * **ヒゲを付けると `heightAbs`（高安基準）だけが伸びて `spreadRatio`（分子は終値基準）が
 * 下がる**ので、ゲートを踏ませたい合成データではヒゲ 0 が最も条件が厳しい側になる。
 */
function mkCandle(i: number, close: number) {
	return {
		isoTime: dayjs.utc('2026-01-01T00:00:00Z').add(i, 'hour').toISOString(),
		open: close,
		high: close,
		low: close,
		close,
		volume: 100,
	};
}

async function detectOn(closes: number[], opts: { tf?: string; swingDepth?: number } = {}) {
	const candles = closes.map((c, i) => mkCandle(i, c));
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = (await detectPatterns('btc_jpy', opts.tf ?? '1hour', candles.length, {
		swingDepth: opts.swingDepth ?? 2,
		includeCompleted: true,
		includeForming: false,
		view: 'debug',
	})) as {
		data?: { patterns?: Array<{ type: string }> };
		meta?: { debug?: { candidates?: Candidate[] } };
	};
	return { patterns: res.data?.patterns ?? [], candidates: res.meta?.debug?.candidates ?? [] };
}

/**
 * 完成済み double top が成立する 1時間足の系列。**2 山の差 2.5 がパターン高さ 4 の 62.5%**。
 *
 * 山1 = 100（idx 10）/ 谷 = 96（idx 13）/ 山2 = 97.5（idx 16）/ ネックライン下抜け = 94（idx 19）。
 * 先行安値 88（idx 4）で戻り率 4 / 12 = 0.33（帯 [0.2, 0.9] の中）。
 *
 * **既存のゲートはすべて通る**: `spreadPct` 2.5% ≤ `DOUBLE_LEVEL_MAX_PCT` 3%、
 * `near` は `tolerancePct`（1hour の tf-auto = 5%）で通る、サイズ検査は
 * `heightPct` 4% ≥ 0.62% / 谷の深さ 2.8% ≥ 1.04%。**本ゲートを外すと confidence 0.67 で検出される。**
 *
 * `1hour` である必要がある。`1day` は `MIN_DEPTH_PCT = 5%` と `DOUBLE_LEVEL_MAX_PCT = 3%` の
 * 組み合わせで `spreadRatio > 0.5` が**幾何的に成立しない**（後述の unreachable テスト）。
 */
const HIGH_DIFF_DOUBLE_TOP = [
	95, 93, 91, 89, 88, 90, 92, 94, 96, 98, 100, 99, 97.5, 96, 96.5, 97, 97.5, 96, 95, 94, 93, 92, 91, 90,
];
/** {@link HIGH_DIFF_DOUBLE_TOP} の鏡像（`200 - x`）。谷1 = 100 / 山 = 104 / 谷2 = 102.5。 */
const HIGH_DIFF_DOUBLE_BOTTOM = HIGH_DIFF_DOUBLE_TOP.map((x) => 200 - x);

describe('validateLevelDiff（issue #178 項目 4）', () => {
	const metricsWithRatio = (ratio: number | null) => ({
		spreadAbs: 0,
		spreadPct: 0,
		heightAbs: 1,
		heightPct: 0,
		spreadRatio: ratio,
	});

	it('閾値は triple と同じ MAX_LEVEL_SPREAD_RATIO（0.5）を使い、専用の定数を作らない', () => {
		expect(MAX_LEVEL_SPREAD_RATIO).toBe(0.5);
		expect(validateLevelDiff('top', metricsWithRatio(0.5))).toBeNull();
	});

	it('閾値ちょうどは通し、超えたところで落とす（off-by-one）', () => {
		expect(validateLevelDiff('top', metricsWithRatio(MAX_LEVEL_SPREAD_RATIO))).toBeNull();
		expect(validateLevelDiff('top', metricsWithRatio(MAX_LEVEL_SPREAD_RATIO + 1e-9))).toBe(
			'peaks_diff_vs_height_excess',
		);
		expect(validateLevelDiff('bottom', metricsWithRatio(MAX_LEVEL_SPREAD_RATIO + 1e-9))).toBe(
			'valleys_diff_vs_height_excess',
		);
	});

	it('比を出せない候補は落とさない（判定材料が無いものを弾かない）', () => {
		expect(validateLevelDiff('top', metricsWithRatio(null))).toBeNull();
		expect(validateLevelDiff('bottom', metricsWithRatio(Number.NaN))).toBeNull();
	});

	it('maxRatio は経路ごとに上書きできる', () => {
		expect(validateLevelDiff('top', metricsWithRatio(0.6), 0.7)).toBeNull();
		expect(validateLevelDiff('top', metricsWithRatio(0.6), 0.5)).toBe('peaks_diff_vs_height_excess');
	});

	// #193 / PR #194 の `▼ reason 横断合計` は type を畳んで reason だけで合算するので、
	// triple と語彙を共有すると「3 山のばらつき」と「2 山の差」が 1 行に潰れる。
	it('理由コードの語彙が triple（validateLevelSpread）と重ならない', () => {
		const over = metricsWithRatio(0.9);
		const doubleCodes = [validateLevelDiff('top', over), validateLevelDiff('bottom', over)];
		const tripleCodes = [validateLevelSpread('top', over), validateLevelSpread('bottom', over)];
		expect(doubleCodes).toEqual(['peaks_diff_vs_height_excess', 'valleys_diff_vs_height_excess']);
		expect(new Set([...doubleCodes, ...tripleCodes]).size).toBe(4);
	});

	it('判定式は validateLevelSpread と同一（違うのは語彙だけ）', () => {
		for (const ratio of [0, 0.49999, 0.5, 0.50001, 0.9, null, Number.NaN]) {
			const m = metricsWithRatio(ratio);
			expect(validateLevelDiff('top', m) === null).toBe(validateLevelSpread('top', m) === null);
		}
	});
});

describe('levelSpreadMetrics: double 形状の性質（issue #178 項目 4 の測定根拠）', () => {
	const main = (price: number) => ({ price });
	const all = (extremePrice: number) => ({ extremePrice });

	// double では `mainPoints` が 2 点なので `spreadPct` は `isSameLevel` が見る量そのもの。
	// triple（3 点のばらつき）と違い、**ゲートしている量と診断値が一致する**。
	it('spreadPct は isSameLevel が見る relDiff と一致する', () => {
		const m = levelSpreadMetrics([main(100), main(97.5)], [all(100), all(96), all(97.5)]);
		expect(m.spreadPct).toBeCloseTo(relDiff(100, 97.5), 12);
	});

	// **`spreadRatio <= 1` は成り立たない。** 主構成点は全構成点に含まれるが、分子は
	// `price`（終値）・分母は `extremePrice`（高安）で**読むフィールドが違う**ので、
	// 低いほうの山に上ヒゲが付くと高さを増やさずに終値の差だけが広がる。
	// PR #195 のレビュー指摘。初版はここに「上界 1.0」を書いていたが誤り。
	it('分子は終値・分母は高安なので、ヒゲ次第で 1.0 を超える', () => {
		const flat = levelSpreadMetrics([main(100), main(97)], [all(100), all(96), all(97)]);
		expect(flat.spreadRatio).toBeCloseTo(3 / 4, 12);

		// 山2 に上ヒゲ（高値 100 / 終値 97）。谷の安値 98.96 より終値が下にある。
		const wicked = levelSpreadMetrics([main(100), main(97)], [all(100), all(98.96), all(100)]);
		expect(wicked.spreadRatio as number).toBeGreaterThan(1);
		expect(wicked.spreadRatio).toBeCloseTo(3 / 1.04, 6);
	});
});

describe('完成済み double への配線（strict / relaxed の 4 経路）', () => {
	it('strict double_top を落とし、relaxed fallback も同じゲートで落とす', async () => {
		const { patterns, candidates } = await detectOn(HIGH_DIFF_DOUBLE_TOP);

		const hits = candidates.filter((c) => c.type === 'double_top' && c.reason === 'peaks_diff_vs_height_excess');
		// strict が落とす → relaxed fallback が同じ 3 点を拾い直す → そこでも落ちる。
		// **relaxed に配線しないと `_fallback` 付きで同じパターンが出てしまう**（#176 の triple と同じ構造）。
		expect(hits).toHaveLength(2);
		expect(patterns.filter((p) => p.type === 'double_top')).toHaveLength(0);

		expect(hits[0].details).toMatchObject({
			spreadAbs: 2.5,
			heightAbs: 4,
			spreadRatio: 0.625,
			// 同水準判定の実効値は min(tolerancePct=0.05, DOUBLE_LEVEL_MAX_PCT=0.03)。
			levelTolerancePct: 0.03,
		});
	});

	it('strict double_bottom を落とし、relaxed fallback も同じゲートで落とす（top と対称）', async () => {
		const { patterns, candidates } = await detectOn(HIGH_DIFF_DOUBLE_BOTTOM);

		const hits = candidates.filter((c) => c.type === 'double_bottom' && c.reason === 'valleys_diff_vs_height_excess');
		expect(hits).toHaveLength(2);
		expect(patterns.filter((p) => p.type === 'double_bottom')).toHaveLength(0);
		expect(hits[0].details).toMatchObject({ spreadAbs: 2.5, heightAbs: 4, spreadRatio: 0.625 });
	});

	// 理由コードに `_relaxed` 接尾辞を付けない。detect_doubles の `_relaxed` 接尾辞は
	// **閾値が違う検査**（`peaks_not_equal` は tolerancePct、`_relaxed` は tolerancePct × 1.3）に
	// 付いているもので、本ゲートは strict / relaxed で同じ MAX_LEVEL_SPREAD_RATIO を使う。
	// `reclassified_as_triple_top` / `prior_trend_mismatch:` が既に両経路で無印なのと同じ扱い。
	it('strict と relaxed で同じ理由コードを使う（閾値が同じなので接尾辞で分けない）', async () => {
		const { candidates } = await detectOn(HIGH_DIFF_DOUBLE_TOP);
		expect(candidates.some((c) => c.reason === 'peaks_diff_vs_height_excess_relaxed')).toBe(false);
	});
});

describe('呼び出し位置（既存の棄却検査をすべて通過した後）', () => {
	// 手前で落ちる候補の reason を横取りしないこと。前に置くと `view=debug` の診断が変わる
	// （`validatePatternSize` / `validateLevelSpread` の docstring と同じ理由）。

	it('ネックライン未突破の候補は no_breakout のまま（ブレイク判定より後）', async () => {
		// 末尾を 95 で頭打ちにしてネックライン 96 の 1.5% バッファ（94.56）を割らせない。
		const closes = [...HIGH_DIFF_DOUBLE_TOP.slice(0, 18), 95, 95, 95, 95, 95, 95];
		const { candidates } = await detectOn(closes);
		const dt = candidates.filter((c) => c.type === 'double_top' && c.accepted === false);
		expect(dt.map((c) => c.reason)).toContain('no_breakout');
		expect(dt.map((c) => c.reason)).not.toContain('peaks_diff_vs_height_excess');
	});

	it('構造ゲートで落ちる候補は retracement_out_of_band のまま（構造ゲートより後）', async () => {
		// 先行安値を 88 → 78 に下げて先行値幅 22 にすると戻り率 4/22 = 0.18 < RETRACEMENT_MIN。
		const closes = [
			90, 86, 82, 79, 78, 82, 86, 90, 94, 98, 100, 99, 97.5, 96, 96.5, 97, 97.5, 96, 95, 94, 93, 92, 91, 90,
		];
		const { candidates } = await detectOn(closes);
		const dt = candidates.filter((c) => c.type === 'double_top' && c.accepted === false);
		expect(dt.map((c) => c.reason)).toContain('retracement_out_of_band');
		expect(dt.map((c) => c.reason)).not.toContain('peaks_diff_vs_height_excess');
	});
});

describe('spreadRatio の実効上界（#178 項目 4 の測定 3。PR #195 で訂正）', () => {
	// 上界を決めるのは**サイズ検査の深さ条件**であって `heightPct` の下限ではない。
	// 山 2 つの極値が等しいとき `heightAbs >= depthPct × 価格水準` なので
	//   `spreadRatio <= min(tolerancePct, DOUBLE_LEVEL_MAX_PCT) / depthPct`。
	// 起票時の見立て（`DOUBLE_LEVEL_MAX_PCT / heightPct` = `1hour` で 4.8）も、初版のレビュー前の
	// 記述（幾何上界 1.0）も、どちらも外れている。式は `validatePatternSize` の実装から
	// 機械的に再導出して固定する（定数を書き写すと実装が動いたときに黙って嘘になる）。
	const peakLevel = 100;

	/** サイズ検査を通る範囲で `spreadRatio` を最大化する。**山2 には上ヒゲを許す。** */
	function maxAttainableRatio(tf: string): number {
		const thresholds = getSizeThresholdsForTf(tf);
		// 山 2 つの極値（高値）は等しく置く——分母を最小化する配置。
		const extremes = (valley: number) => [
			{ extremePrice: peakLevel },
			{ extremePrice: valley },
			{ extremePrice: peakLevel },
		];
		let max = 0;
		for (let spread = 0.01; spread <= peakLevel * DOUBLE_LEVEL_MAX_PCT + 1e-9; spread += 0.01) {
			for (let valley = peakLevel - 0.01; valley > 0; valley -= 0.01) {
				const pts = extremes(valley);
				if (validatePatternSize('top', pts, thresholds)) continue;
				// 山1 は高値で引け、山2 は上ヒゲ（高値 = peakLevel、終値 = peakLevel - spread）。
				const m = levelSpreadMetrics([{ price: peakLevel }, { price: peakLevel - spread }], pts);
				if (m.spreadRatio !== null && m.spreadRatio > max) max = m.spreadRatio;
				break; // 谷が浅いほど比が大きいので、最初に通った valley が spread ごとの最大
			}
		}
		return max;
	}

	it('実効上界は DOUBLE_LEVEL_MAX_PCT / depthPct（heightPct 側ではない）', () => {
		for (const tf of ['1hour', '4hour', '8hour', '12hour', '1day']) {
			const { depthPct } = getSizeThresholdsForTf(tf);
			expect(maxAttainableRatio(tf)).toBeCloseTo(DOUBLE_LEVEL_MAX_PCT / depthPct, 1);
		}
	});

	it('1day でも 0.5 を超える（本ゲートは短い足専用の装置ではない）', () => {
		expect(maxAttainableRatio('1day')).toBeGreaterThan(MAX_LEVEL_SPREAD_RATIO);
	});
});

describe('ヒゲのある実形状で発火する（PR #195 レビューの反例を回帰として固定）', () => {
	/**
	 * `1day`。山2 に上ヒゲ（高値 100 / 終値 97.05）、谷に下ヒゲ（終値 95.5 / 安値 94.9）。
	 *
	 * 終値の差 2.95（2.95% ≤ 3%）に対し高安の高さは 5.1 → `spreadRatio` 0.578。
	 * **サイズ検査は高安で測るので通る**（`heightPct` 5.1% / 谷の深さ 5.1%）。
	 * ヒゲ 0 で同じ比を作ることは `1day` ではできない——初版はそれを根拠に
	 * 「`1day` では到達不能」と書いていたが、ヒゲを入れれば届く。
	 */
	const WICKED_1DAY: Array<{ c: number; h?: number; l?: number }> = [
		{ c: 95 },
		{ c: 93 },
		{ c: 91 },
		{ c: 89.5 },
		{ c: 88.5 },
		{ c: 88 },
		{ c: 90 },
		{ c: 92 },
		{ c: 94 },
		{ c: 96 },
		{ c: 97 },
		{ c: 98.5 },
		{ c: 100 },
		{ c: 99 },
		{ c: 98 },
		{ c: 97.5 },
		{ c: 96.5 },
		{ c: 96 },
		{ c: 95.5, l: 94.9 },
		{ c: 96 },
		{ c: 96.5 },
		{ c: 96.8 },
		{ c: 96.9 },
		{ c: 97 },
		{ c: 97.05, h: 100 },
		{ c: 96 },
		{ c: 95 },
		{ c: 94 },
		{ c: 93 },
		{ c: 92 },
	];

	/**
	 * `1hour`。**`spreadRatio` が 1 を超える形**（2.88 = `DOUBLE_LEVEL_MAX_PCT / depthPct` の上界ちょうど）。
	 * 山2 の終値 97 が谷の安値 98.96 **より下**にある。
	 *
	 * **この候補は本ゲートの手前まで `accepted: true` だった**——サイズ検査・同水準 2 段・
	 * ブレイクアウト・先行トレンド・構造ゲートをすべて通過する。
	 */
	const OVER_ONE_1HOUR: Array<{ c: number; h?: number; l?: number }> = [
		{ c: 90 },
		{ c: 91 },
		{ c: 92 },
		{ c: 93 },
		{ c: 94 },
		{ c: 95 },
		{ c: 100 },
		{ c: 99.6 },
		{ c: 99.4 },
		{ c: 99.2, l: 98.96 },
		{ c: 99.4 },
		{ c: 99.5 },
		{ c: 97, h: 100, l: 97 },
		{ c: 99 },
		{ c: 99 },
		{ c: 96 },
		{ c: 95 },
		{ c: 94 },
		{ c: 93 },
		{ c: 92 },
	];

	async function detectOnBars(bars: Array<{ c: number; h?: number; l?: number }>, tf: string) {
		const candles = bars.map((b, i) => ({
			isoTime: dayjs.utc('2026-01-01T00:00:00Z').add(i, 'day').toISOString(),
			open: b.c,
			high: b.h ?? b.c,
			low: b.l ?? b.c,
			close: b.c,
			volume: 100,
		}));
		vi.mocked(analyzeIndicators).mockResolvedValueOnce(
			asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
		);
		const res = (await detectPatterns('btc_jpy', tf, candles.length, {
			swingDepth: 2,
			includeCompleted: true,
			includeForming: false,
			view: 'debug',
		})) as { data?: { patterns?: Array<{ type: string }> }; meta?: { debug?: { candidates?: Candidate[] } } };
		return { patterns: res.data?.patterns ?? [], candidates: res.meta?.debug?.candidates ?? [] };
	}

	it('1day: 上ヒゲで spreadRatio 0.578 になる double_top を落とす', async () => {
		const { patterns, candidates } = await detectOnBars(WICKED_1DAY, '1day');
		const hits = candidates.filter((c) => c.type === 'double_top' && c.reason === 'peaks_diff_vs_height_excess');
		expect(hits).toHaveLength(2); // strict + relaxed fallback
		expect(hits[0].details?.spreadRatio as number).toBeCloseTo(0.578, 3);
		expect(patterns.filter((p) => p.type === 'double_top')).toHaveLength(0);
	});

	it('1hour: spreadRatio が 1 を超える double_top を落とす（他のゲートは全通過する形）', async () => {
		const { patterns, candidates } = await detectOnBars(OVER_ONE_1HOUR, '1hour');
		const hits = candidates.filter((c) => c.type === 'double_top' && c.reason === 'peaks_diff_vs_height_excess');
		expect(hits).toHaveLength(2);
		expect(hits[0].details?.spreadRatio as number).toBeCloseTo(2.885, 3);
		expect(patterns.filter((p) => p.type === 'double_top')).toHaveLength(0);
	});
});
