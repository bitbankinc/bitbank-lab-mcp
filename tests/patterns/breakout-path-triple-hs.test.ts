/**
 * tests/patterns/breakout-path-triple-hs.test.ts
 *
 * issue #242 — triple / H&S の完成済み 4 経路ずつに、最終構成点確定後の 2 つの検査を
 * 配線した件の回帰テスト。
 *
 * | 検査 | 理由コード | 状況 |
 * |---|---|---|
 * | 最終構成点 → ブレイクの経路（新設） | `peak_after_last_pivot` / `trough_after_last_pivot` | 新規 |
 * | 谷（山）ゾーン再進入（`detectTroughZoneReentry`） | `re_entered_trough_zone` | **double から横展開**（#131 → #138 の構造ゲート横展開で漏れていた） |
 *
 * `detect_triples.ts` / `detect_hs.ts` には **#242 まで再進入チェックそのものが 1 つも無かった**
 * ——最終構成点の後に 4 つ目の山や 2 つ目の右肩を作っても、窓内のどこかでネックラインを割れば
 * `completed` になっていた。double には少なくとも 25% ゾーンの安全弁があったが、こちらは
 * 安全弁がゼロだった。
 *
 * 本テストが固定するのは 4 点:
 *
 * 1. 最終構成点（山3 / 右肩）の後にピボットを 1 つ挟んでから割る形が落ちること（4 種別）
 * 2. **ピボットにならない戻し**（同値の 2 本で strict なピボット判定を外す）はゾーン再進入で
 *    落ちること——2 つの検査が**別々の形**を捕まえていることの検算
 * 3. 中間の山（谷）を取り除いた対照系列は accepted のままであること
 * 4. `view=debug` の候補に理由コードと位置が残ること（既定では `invalid` が消えるため）
 *
 * **形成中経路は触っていない**（ブレイクが無いので「最終構成点 → ブレイク」が定義できない）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult, assertOk } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { makeCandle } from '../fixtures/synthetic_pattern_candles.js';

type Candle = { isoTime: string; open: number; high: number; low: number; close: number; volume: number };
type Candidate = {
	type: string;
	accepted: boolean;
	reason?: string;
	indices?: number[];
	details?: Record<string, unknown>;
};

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * 完成済み `triple_top`（山 120 / 119 / 120、ネックライン 102）に、**山3（idx 23）の後で
 * ネックラインを割る前に 4 つ目の山（idx 27、終値 116）**を挟んだ系列。
 *
 * 終値 116 は 25% ゾーンの下限 117（アンカー = 高安 123、高さ = 123 − 99 = 24）を
 * **1 だけ下回る**ので、既存の `detectTroughZoneReentry` では発火しない
 * ——起票時のライブ実例（ゾーン下限に 0.3% 届かず）と同じ配置。
 */
const TRIPLE_PEAK_BETWEEN = [
	90, 88, 86, 84, 92, 100, 110, 120, 114, 108, 104, 102, 108, 113, 117, 119, 113, 108, 104, 102, 108, 113, 117, 120,
	114, 110, 113, 116, 112, 99, 95, 92, 90, 88,
];

/** 上の系列から中間の山だけを取り除いた対照（山3 から単調に割る）。 */
const TRIPLE_DIRECT_BREAK = [
	90, 88, 86, 84, 92, 100, 110, 120, 114, 108, 104, 102, 108, 113, 117, 119, 113, 108, 104, 102, 108, 113, 117, 120,
	114, 110, 106, 102, 100, 99, 95, 92, 90, 88,
];

/**
 * 同じ `triple_top` に、**ピボットにならない戻し**（idx 26 / 27 が同値 118 なので
 * `strictPivots` の「前後すべてより高い」を満たさない）を挟んだ系列。
 * 終値 118 は 25% ゾーンの下限 117 を上回るので、**再進入チェックだけが発火する**。
 */
const TRIPLE_ZONE_REENTRY = [
	90, 88, 86, 84, 92, 100, 110, 120, 114, 108, 104, 102, 108, 113, 117, 119, 113, 108, 104, 102, 108, 113, 117, 120,
	110, 114, 118, 118, 112, 99, 95, 92, 90, 88,
];

/**
 * 完成済み `head_and_shoulders`（肩 120 / 120、頭 140、ネックライン 100）に、
 * **右肩（idx 23）の後でネックラインを割る前に山（idx 27、終値 114）**を挟んだ系列。
 * 終値 114 は肩ゾーンの下限 116.5（アンカー = 高安 123、高さ = 123 − 97 = 26）より下なので、
 * 再進入チェックでは発火しない。
 */
const HS_PEAK_BETWEEN = [
	90, 88, 86, 84, 92, 100, 110, 120, 112, 105, 101, 100, 108, 120, 132, 140, 130, 115, 105, 100, 106, 113, 118, 120,
	112, 106, 110, 114, 108, 97, 93, 90, 88, 86,
];

/** 上の系列から中間の山だけを取り除いた対照（右肩から単調に割る）。 */
const HS_DIRECT_BREAK = [
	90, 88, 86, 84, 92, 100, 110, 120, 112, 105, 101, 100, 108, 120, 132, 140, 130, 115, 105, 100, 106, 113, 118, 120,
	112, 104, 97, 93, 90, 88, 86, 84,
];

/** 同じ H&S に、ピボットにならない戻し（idx 26 / 27 が同値 118 > 116.5）を挟んだ系列。 */
const HS_ZONE_REENTRY = [
	90, 88, 86, 84, 92, 100, 110, 120, 112, 105, 101, 100, 108, 120, 132, 140, 130, 115, 105, 100, 106, 113, 118, 120,
	110, 114, 118, 118, 110, 97, 93, 90, 88, 86,
];

/** 水準 226 で折り返した鏡像（bottom 側の検証用）。 */
function mirror(closes: number[]): number[] {
	return closes.map((c) => 226 - c);
}

function toCandles(closes: number[]): Candle[] {
	return closes.map((close, i) => makeCandle(i, close));
}

async function detectDebug(
	closes: number[],
	opts: Record<string, unknown> = {},
): Promise<{ patterns: Array<Record<string, unknown>>; candidates: Candidate[] }> {
	const candles = toCandles(closes);
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	// `swingDepth: 3` を明示するのは、1day のオート値 6 ではこの長さで 5 点が立たないため。
	const res = await detectPatterns('btc_jpy', '1day', candles.length, { view: 'debug', swingDepth: 3, ...opts });
	assertOk(res);
	const meta = res.meta as { debug?: { candidates?: Candidate[] } } | undefined;
	return {
		patterns: res.data.patterns as Array<Record<string, unknown>>,
		candidates: meta?.debug?.candidates ?? [],
	};
}

const mainIdxs = (p: Record<string, unknown>) => ((p.pivots as Array<{ idx: number }>) ?? []).map((v) => v.idx);
const find = (ps: Array<Record<string, unknown>>, type: string) => ps.filter((p) => p.type === type);

/** 落ちる側の 4 種別 × 2 検査。`[系列, 種別, 期待する理由コード]` */
const REJECTED_CASES: Array<[string, number[], boolean, string, string]> = [
	['山3 の後に山を挟む', TRIPLE_PEAK_BETWEEN, false, 'triple_top', 'peak_after_last_pivot'],
	['谷3 の後に谷を挟む', TRIPLE_PEAK_BETWEEN, true, 'triple_bottom', 'trough_after_last_pivot'],
	['右肩の後に山を挟む', HS_PEAK_BETWEEN, false, 'head_and_shoulders', 'peak_after_last_pivot'],
	['右肩の後に谷を挟む', HS_PEAK_BETWEEN, true, 'inverse_head_and_shoulders', 'trough_after_last_pivot'],
	['山3 の後にゾーンへ戻る', TRIPLE_ZONE_REENTRY, false, 'triple_top', 're_entered_trough_zone'],
	['谷3 の後にゾーンへ戻る', TRIPLE_ZONE_REENTRY, true, 'triple_bottom', 're_entered_trough_zone'],
	['右肩の後にゾーンへ戻る', HS_ZONE_REENTRY, false, 'head_and_shoulders', 're_entered_trough_zone'],
	['右肩の後にゾーンへ戻る（逆）', HS_ZONE_REENTRY, true, 'inverse_head_and_shoulders', 're_entered_trough_zone'],
];

describe('triple / H&S: 最終構成点の後に形が崩れる（issue #242・合成 fixture）', () => {
	it.each(REJECTED_CASES)('%s → %s が status=invalid（%s）', async (_label, closes, mirrored, type, reason) => {
		const series = mirrored ? mirror(closes) : closes;

		const { patterns } = await detectDebug(series);
		expect(find(patterns, type), '既定では data.patterns に出ない').toHaveLength(0);

		const { patterns: withInvalid } = await detectDebug(series, { includeInvalid: true });
		const hits = find(withInvalid, type);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({ status: 'invalid', invalidReason: reason });
		expect(mainIdxs(hits[0])).toEqual([7, 11, 15, 19, 23]);
	});

	it.each(
		REJECTED_CASES,
	)('%s → view=debug の候補に理由と位置が残る（%s / %s）', async (_l, closes, mirrored, type, reason) => {
		const { candidates } = await detectDebug(mirrored ? mirror(closes) : closes);
		const hit = candidates.find((c) => c.type === type && c.reason === reason);
		expect(hit, JSON.stringify(candidates.map((c) => [c.type, c.reason]))).toBeDefined();
		expect(hit?.details).toMatchObject({ lastPivotIdx: 23, breakoutIdx: 29 });
	});

	/**
	 * 落ちた候補に「成功エントリ」を積まない。**`reason` を持たない `accepted: true`** が
	 * 成功エントリで、`prior_trend_insufficient_data` のような**注記つきの `accepted: true`**
	 * （ゲートより前で積まれる情報行）は対象外。
	 */
	it.each(REJECTED_CASES)('%s → 成功エントリの候補は積まれない（%s / %s）', async (_l, closes, mirrored, type) => {
		const { candidates } = await detectDebug(mirrored ? mirror(closes) : closes);
		expect(candidates.filter((c) => c.type === type && c.accepted && !c.reason)).toHaveLength(0);
	});
});

describe('triple / H&S: 中間のピボットを取り除いた対照は accepted のまま', () => {
	const CONTROL_CASES: Array<[string, number[], boolean, string]> = [
		['triple_top', TRIPLE_DIRECT_BREAK, false, 'triple_top'],
		['triple_bottom', TRIPLE_DIRECT_BREAK, true, 'triple_bottom'],
		['head_and_shoulders', HS_DIRECT_BREAK, false, 'head_and_shoulders'],
		['inverse_head_and_shoulders', HS_DIRECT_BREAK, true, 'inverse_head_and_shoulders'],
	];

	it.each(CONTROL_CASES)('%s は completed で残る', async (_label, closes, mirrored, type) => {
		const { patterns } = await detectDebug(mirrored ? mirror(closes) : closes);
		const hits = find(patterns, type);
		expect(hits).toHaveLength(1);
		expect(hits[0].status === undefined || hits[0].status === 'completed').toBe(true);
		expect(mainIdxs(hits[0])).toEqual([7, 11, 15, 19, 23]);
	});
});

describe('2 つの検査は別々の形を捕まえている（片方では塞げない）', () => {
	it('経路ゲートで落ちる形はゾーン再進入では発火しない', async () => {
		const { candidates } = await detectDebug(TRIPLE_PEAK_BETWEEN);
		expect(candidates.some((c) => c.reason === 'peak_after_last_pivot')).toBe(true);
		expect(candidates.some((c) => c.type === 'triple_top' && c.reason === 're_entered_trough_zone')).toBe(false);
	});

	it('ゾーン再進入で落ちる形は同種ピボットを作っていない（strict なピボット判定を外す同値 2 本）', async () => {
		const { candidates } = await detectDebug(TRIPLE_ZONE_REENTRY);
		expect(candidates.some((c) => c.type === 'triple_top' && c.reason === 're_entered_trough_zone')).toBe(true);
		expect(candidates.some((c) => c.type === 'triple_top' && c.reason === 'peak_after_last_pivot')).toBe(false);
	});
});
