// `detectSwingPoints` は窓の両端 `swingDepth` 本をピボットにしないので、狭い窓では端に埋もれていた足が広い窓ではピボットに昇格して頭を奪う（前置きが窓より安くても再現する。issue #154）。

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

/** 末尾 90 本は fixture と完全に同一なので、狭い窓の検出は広い窓にも残らなければならない。 */
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

	it('90 本の窓の横ばい先行 head_and_shoulders を検出しない', async () => {
		expect(hasIssue154Pattern(await detect(buildBtcJpy2026Candles()))).toBe(false);
	});

	// 前置きの水準を変えても結論は同じ。9.5M は窓の頭より安い前置きで、「高い山が入るから頭を奪われる」のではなく、端の足がピボットに昇格するだけで起きることの証拠。
	it.each([
		['前置きが窓の頭より安い（9.5M）', 9_500_000],
		['前置きが窓の頭より高い（11.7M）', 11_700_000],
	])('200 本へ窓を広げても横ばい先行 H&S は戻らない: %s', async (_label, level) => {
		expect(hasIssue154Pattern(await detect(prependBars(110, level)))).toBe(false);
	});

	it('頭が形成区間の極値でない読みは採らない（出力に含まれない対抗ピボットまで見る）', async () => {
		// 落とすべき対抗ピボットは出力に含まれないので、構成点だけを見る検査では足りない。検出と同じ `detectSwingPoints` を呼び直して窓の全ピボットを復元する。
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
				const rivals = sameKind.filter(
					(v) =>
						v.idx > from && v.idx < to && v.idx !== head?.idx && (isTop ? v.price > headPrice : v.price < headPrice),
				);
				expect(rivals).toEqual([]);
			}
		}
	});

	it('頭より深い谷が形成区間の内側にある逆 H&S を採らない（#154 の総当たり化で開いた穴）', async () => {
		// `completed_falling_wedge` fixture（tests/detect_patterns_fixtures.test.ts）の実系列で、区間 [5, 36] の内側に idx 33（終値 100）が居る。`headIsExtremeInSpan` を外すとこのテストが落ちる。
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
