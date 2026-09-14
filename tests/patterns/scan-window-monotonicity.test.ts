/**
 * tests/patterns/scan-window-monotonicity.test.ts
 *
 * issue #154 の回帰テスト: **スキャン窓を広げると検出が消える**問題。
 *
 * `detect_patterns` はどちらの `limit` でも「直近 limit 本」を見るので、広い窓は狭い窓を
 * 包含する。したがって狭い窓で見つかった形成中 H&S は、広い窓でも同じ日付で見つかるはず。
 *
 * 実際には `tryFormingHS` / `tryFormingInverseHS` が頭を「スキャン窓全体の最高値ピーク /
 * 最安値の谷」1 点に決め打ちし、他の頭候補を試していなかったため、窓を広げて頭が過去側へ
 * 飛ぶと狭い窓のパターンが**列挙されすらしなかった**。
 *
 * **前置きが窓より安くても再現する**のがこの不具合の肝。`detectSwingPoints` は窓の両端
 * `swingDepth` 本をピボットにしないので、狭い窓では端に埋もれていた足が、広い窓では左側の
 * 文脈を得てピボットに昇格する。BTC/JPY fixture の idx 0（2026-05-29, 11,700,698）が
 * まさにそれで、狭い窓の頭（10,849,999）より高いため頭を奪う。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import {
	detectSwingPoints,
	filterPeaks,
	filterValleys,
	type Candle as SwingCandle,
} from '../../tools/patterns/swing.js';
import { asMockResult, assertOk } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { buildBtcJpy2026Candles } from '../fixtures/btc_jpy_1day_2026.js';

type Candle = ReturnType<typeof buildBtcJpy2026Candles>[number];

/**
 * fixture の 90 本の**手前**に `n` 本を継ぎ足して「limit を上げた」状態を作る。
 * 末尾 90 本は fixture と完全に同一なので、狭い窓の検出は広い窓にも残らなければならない。
 */
function prependBars(n: number, level: number): Candle[] {
	const base = buildBtcJpy2026Candles();
	const start = dayjs.utc(base[0].isoTime).subtract(n, 'day');
	const pre: Candle[] = [];
	for (let i = 0; i < n; i++) {
		// 決定論的な緩い上下動（±1%）。乱数を使わないので毎回同じ列になる。
		const close = level + Math.sin(i / 7) * level * 0.01;
		pre.push({
			open: close,
			high: close * 1.004,
			low: close * 0.996,
			close,
			isoTime: start.add(i, 'day').toISOString(),
			volume: 100,
		});
	}
	return [...pre, ...base];
}

const DETECT_OPTS = {
	patterns: ['head_and_shoulders', 'inverse_head_and_shoulders'] as never,
	headProminencePct: 0.01,
	includeForming: true,
	includeCompleted: true,
	includeInvalid: true,
} as const;

/** #154 で報告された、BTC/JPY 日足 90 本で検出される形成中 H&S。 */
const ISSUE_154_PATTERN = {
	type: 'head_and_shoulders',
	status: 'forming',
	start: '2026-07-06T00:00:00.000Z',
	end: '2026-08-10T00:00:00.000Z',
};

describe('スキャン窓の単調性（issue #154）', () => {
	const mocked = vi.mocked(analyzeIndicators);

	afterEach(() => {
		vi.clearAllMocks();
	});

	async function detect(candles: Candle[]) {
		mocked.mockResolvedValue(
			asMockResult({
				ok: true,
				summary: 'ok',
				data: { chart: { candles, meta: { pastBuffer: 0 } } },
			}),
		);
		const res = await detectPatterns('btc_jpy', '1day', candles.length, DETECT_OPTS);
		assertOk(res);
		return res.data.patterns as Array<{
			type: string;
			status?: string;
			range?: { start?: string; end?: string };
		}>;
	}

	const hasIssue154Pattern = (pats: Awaited<ReturnType<typeof detect>>) =>
		pats.some(
			(p) =>
				p.type === ISSUE_154_PATTERN.type &&
				p.status === ISSUE_154_PATTERN.status &&
				p.range?.start === ISSUE_154_PATTERN.start &&
				p.range?.end === ISSUE_154_PATTERN.end,
		);

	it('90 本の窓で形成中 head_and_shoulders を検出する（前提の確認）', async () => {
		expect(hasIssue154Pattern(await detect(buildBtcJpy2026Candles()))).toBe(true);
	});

	// 前置きの水準を変えても結論は同じであることを示す。9.5M は窓の頭より**安い**前置きで、
	// 「高い山が入るから頭を奪われる」のではなく、端の足がピボットに昇格するだけで起きることの証拠。
	it.each([
		['前置きが窓の頭より安い（9.5M）', 9_500_000],
		['前置きが窓の頭より高い（11.7M）', 11_700_000],
	])('200 本へ窓を広げても同じ形成中 H&S が残る: %s', async (_label, level) => {
		expect(hasIssue154Pattern(await detect(prependBars(110, level)))).toBe(true);
	});

	it('頭が形成区間の極値でない読みは採らない（出力に含まれない対抗ピボットまで見る）', async () => {
		// 頭候補を総当たりにすると、頭より極端な同種ピボットが [左肩, 右肩] の内側にあっても
		// 通り得る（`headIsExtremeInSpan` が塞いでいる穴）。
		//
		// **構成点だけを見る検査では足りない。** 落とすべき対抗ピボットは、まさに出力に
		// 含まれないものだからである。ここでは検出に使われたのと同じ `detectSwingPoints` を
		// 呼び直して**窓の全ピボット**を復元し、その中に頭より極端なものが区間内に無いことを見る。
		for (const candles of [buildBtcJpy2026Candles(), prependBars(110, 9_500_000), prependBars(110, 11_700_000)]) {
			const pats = (await detect(candles)) as Array<{
				type: string;
				pivots?: Array<{ idx: number; price: number }>;
			}>;
			// detect() は swingDepth 未指定 = 1day のオート値（6）。検出側と同じ条件で復元する。
			const allPivots = detectSwingPoints(candles as SwingCandle[], { swingDepth: 6, strictPivots: true });
			for (const p of pats) {
				const pivots = p.pivots ?? [];
				if (pivots.length < 3) continue;
				const isTop = p.type === 'head_and_shoulders';
				const sameKind = isTop ? filterPeaks(allPivots) : filterValleys(allPivots);
				const prices = pivots.map((v) => v.price);
				const headPrice = isTop ? Math.max(...prices) : Math.min(...prices);
				const head = pivots.find((v) => v.price === headPrice);
				const from = pivots[0].idx;
				const to = pivots[pivots.length - 1].idx;
				expect(head).toBeDefined();
				// 頭は構成点の内側（両端は肩）にある
				expect(prices.slice(1, -1)).toContain(headPrice);
				// 区間の内側に、頭より極端な同種ピボットが存在しない
				const rivals = sameKind.filter(
					(v) =>
						v.idx > from && v.idx < to && v.idx !== head?.idx && (isTop ? v.price > headPrice : v.price < headPrice),
				);
				expect(rivals).toEqual([]);
			}
		}
	});

	it('頭より深い谷が形成区間の内側にある逆 H&S を採らない（#154 の総当たり化で開いた穴）', async () => {
		// `completed_falling_wedge` fixture（tests/detect_patterns_fixtures.test.ts）の実系列。
		// 頭候補を総当たりにしただけの中間実装では、頭 idx 12（終値 112）で形成中 逆 H&S が
		// 通っていた——区間 [5, 36] の内側に idx 33（終値 100）が居るのに、である。
		// `headIsExtremeInSpan` を外すとこのテストが落ちる。
		const closes = [
			146, 140, 134, 128, 122, 116, 127, 138, 133, 128, 122, 117, 112, 121, 130, 126, 121, 117, 112, 108, 115, 122, 118,
			115, 111, 108, 104, 109, 114, 111, 108, 106, 103, 100, 103, 110, 118,
		];
		const candles = closes.map((close, i) => ({
			open: close,
			high: close + 3,
			low: close - 3,
			close,
			isoTime: dayjs.utc('2026-01-01').add(i, 'day').toISOString(),
			volume: 100,
		}));
		mocked.mockResolvedValue(
			asMockResult({ ok: true, summary: 'ok', data: { chart: { candles, meta: { pastBuffer: 0 } } } }),
		);
		const res = await detectPatterns('btc_jpy', '1day', candles.length, {
			swingDepth: 2,
			includeForming: true,
			includeCompleted: true,
			includeInvalid: true,
		});
		assertOk(res);
		const pats = res.data.patterns as Array<{ type: string; pivots?: Array<{ idx: number }> }>;
		const bogus = pats.filter(
			(p) => p.type === 'inverse_head_and_shoulders' && (p.pivots ?? []).some((v) => v.idx === 12),
		);
		expect(bogus).toEqual([]);
	});
});
